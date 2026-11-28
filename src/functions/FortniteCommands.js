const axios = require("axios");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const telemetry = require("../telemetry");

const logger = new Logger("fortnite-commands");

const API_BASE = "https://prod.api-fortnite.com/api";
const STATS_TTL_MS = 5 * 60 * 1000;
const SEASON_TTL_MS = 6 * 60 * 60 * 1000;
const SHOP_FALLBACK_TTL_MS = 60 * 60 * 1000;
const SHOP_LIST_LIMIT = 40;
const SHOP_SEARCH_LIMIT = 5;
const CACHE_MAX_ENTRIES = 500;
const MODES = [
	{ key: "solo", label: "👤 Solo" },
	{ key: "duo", label: "👥 Dupla" },
	{ key: "trio", label: "👨‍👩‍👦 Trio" },
	{ key: "squad", label: "🪖 Esquadrão" }
];
const STAT_FIELDS = {
	placetop1: "wins",
	kills: "kills",
	matchesplayed: "matches",
	minutesplayed: "minutes"
};
const STAT_KEY = /^br_([a-z0-9]+)_[a-z0-9]+_m0_playlist_(.+)$/;

const ERROR_REPLIES = {
	not_configured: "❌ Os comandos de Fortnite precisam ser configurados pelo administrador do bot.",
	auth: "❌ A chave da API do Fortnite precisa ser verificada pelo administrador do bot.",
	not_found:
		"❌ Jogador não encontrado. Use o nome Epic exato, com maiúsculas e minúsculas.\n*Exemplo:* !fortnite NomeEpic",
	private_stats:
		"🔒 As estatísticas desse jogador estão privadas. No Fortnite, ative *Mostrar estatísticas de jogo publicamente* nas configurações de conta e privacidade.",
	rate_limited: "⏳ Muitas consultas de Fortnite hoje. Tenta de novo mais tarde.",
	unavailable: "❌ Não consegui falar com a API do Fortnite agora. Tenta de novo daqui a pouco."
};

const cache = new Map();

function cached(key, ttlMs, load) {
	const hit = cache.get(key);
	if (hit && hit.expiresAt > Date.now()) {
		telemetry.setAttrs({ "ravena.fortnite.cache_hit": true });
		return Promise.resolve(hit.value);
	}
	telemetry.setAttrs({ "ravena.fortnite.cache_hit": false });
	return load().then(({ value, expiresAt }) => {
		if (cache.size >= CACHE_MAX_ENTRIES) {
			for (const [k, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(k);
		}
		cache.set(key, { value, expiresAt: expiresAt ?? Date.now() + ttlMs });
		return value;
	});
}

function apiKey() {
	const key = process.env.FORTNITE_API_KEY?.trim();
	if (!key) throw Object.assign(new Error("FORTNITE_NOT_CONFIGURED"), { reason: "not_configured" });
	return key;
}

function reasonFromStatus(status) {
	if (status === 401) return "auth";
	if (status === 403) return "private_stats";
	if (status === 404) return "not_found";
	if (status === 429) return "rate_limited";
	return "unavailable";
}

function fortniteGet(endpoint, path, params) {
	const key = apiKey();
	return telemetry.withSpan(
		"fortnite api.request",
		{ attributes: { "ravena.fortnite.endpoint": endpoint } },
		async (span) => {
			try {
				const response = await axios.get(`${API_BASE}${path}`, {
					params,
					headers: { "x-api-key": key },
					timeout: 15000
				});
				telemetry.setAttrs({ "ravena.fortnite.status": response.status }, span);
				return response.data;
			} catch (error) {
				const status = error.response?.status;
				telemetry.setAttrs({ "ravena.fortnite.status": status }, span);
				error.reason = reasonFromStatus(status);
				throw error;
			}
		}
	);
}

function emptyLine() {
	return { wins: 0, kills: 0, matches: 0, minutes: 0 };
}

function summarizeStats(stats) {
	const totals = { geral: emptyLine() };
	for (const mode of MODES) totals[mode.key] = emptyLine();
	for (const [key, value] of Object.entries(stats || {})) {
		const match = STAT_KEY.exec(key);
		const field = match && STAT_FIELDS[match[1]];
		if (!field || !Number.isFinite(value)) continue;
		totals.geral[field] += value;
		const mode = MODES.find((m) => match[2].includes(m.key));
		if (mode) totals[mode.key][field] += value;
	}
	return totals;
}

async function getPlayer(displayName) {
	return cached(`player:${displayName.toLowerCase()}`, STATS_TTL_MS, async () => {
		const account = await fortniteGet(
			"account",
			`/v1/account/displayName/${encodeURIComponent(displayName)}`
		);
		if (!account?.id) throw Object.assign(new Error("FORTNITE_NOT_FOUND"), { reason: "not_found" });
		const data = await fortniteGet("stats", `/v2/stats/${encodeURIComponent(account.id)}`);
		return {
			value: {
				displayName: account.displayName || displayName,
				totals: summarizeStats(data?.stats)
			}
		};
	});
}

async function getShop() {
	return cached("shop", SHOP_FALLBACK_TTL_MS, async () => {
		const data = await fortniteGet("shop", "/v1/shop", { lang: "pt-BR" });
		const expiration = Date.parse(data?.expiration);
		return {
			value: (data?.storefronts || []).flatMap((s) => s.catalogEntries || []).map(toOffer),
			expiresAt: Number.isFinite(expiration) && expiration > Date.now() ? expiration : undefined
		};
	});
}

async function getSeason() {
	return cached("season", SEASON_TTL_MS, async () => ({
		value: await fortniteGet("season", "/v1/season")
	}));
}

function toOffer(entry) {
	const cosmetic = entry.itemGrants?.find((g) => g.cosmetic)?.cosmetic;
	const price = entry.prices?.[0];
	return {
		name:
			entry.bundle?.name || entry.title || cosmetic?.displayName || cosmetic?.name || entry.devName,
		section: entry.sectionDisplayName || "Outros",
		sectionPriority: entry.sectionPriority ?? 0,
		rarity: cosmetic?.rarity,
		type: cosmetic?.type,
		finalPrice: price?.finalPrice ?? entry.bundle?.finalPrice,
		regularPrice: price?.regularPrice ?? entry.bundle?.regularPrice,
		image: cosmetic?.images?.largeIcon || cosmetic?.images?.icon || entry.offerVisual,
		searchText: normalize(
			[entry.bundle?.name, entry.title, cosmetic?.displayName, cosmetic?.name]
				.filter(Boolean)
				.join(" ")
		)
	};
}

function normalize(text) {
	return String(text || "")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase();
}

function safeText(value) {
	return String(value || "")
		.replace(/[\r\n*_`~]/g, " ")
		.slice(0, 80)
		.trim();
}

function num(value) {
	return Math.round(value).toLocaleString("pt-BR");
}

function ratio(value) {
	return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function kd(line) {
	const deaths = line.matches - line.wins;
	return ratio(deaths > 0 ? line.kills / deaths : line.kills);
}

function winRate(line) {
	return line.matches > 0 ? `${ratio((line.wins / line.matches) * 100)}%` : "0%";
}

function formatPlayer(player) {
	const g = player.totals.geral;
	let text = `🎯 *Fortnite - ${safeText(player.displayName)}*\n\n`;
	if (!g.matches) return `${text}😶 Nenhuma partida de Battle Royale registrada.`;
	text += `🏆 Vitórias: *${num(g.wins)}* (${winRate(g)})\n`;
	text += `🎮 Partidas: *${num(g.matches)}*\n`;
	text += `💀 Abates: *${num(g.kills)}* | K/D: *${kd(g)}*\n`;
	if (g.minutes) text += `⏱️ Tempo jogado: *${num(g.minutes / 60)} h*\n`;
	const modes = MODES.filter((m) => player.totals[m.key].matches > 0);
	if (modes.length) {
		text += "\n*Por modo*\n";
		for (const mode of modes) {
			const line = player.totals[mode.key];
			text += `${mode.label}: ${num(line.wins)} vitórias em ${num(line.matches)} partidas, ${num(line.kills)} abates (K/D ${kd(line)})\n`;
		}
	}
	return text.trim();
}

function formatPrice(offer) {
	if (!Number.isFinite(offer.finalPrice)) return "";
	const discount =
		Number.isFinite(offer.regularPrice) && offer.regularPrice > offer.finalPrice
			? ` ~${num(offer.regularPrice)}~`
			: "";
	return ` - ${num(offer.finalPrice)} V-Bucks${discount}`;
}

function formatShop(offers) {
	const bySection = new Map();
	for (const offer of [...offers].sort((a, b) => b.sectionPriority - a.sectionPriority)) {
		if (!bySection.has(offer.section)) bySection.set(offer.section, []);
		bySection.get(offer.section).push(offer);
	}
	let text = `🛒 *Loja do Fortnite de hoje* (${offers.length} ofertas)\n`;
	let shown = 0;
	for (const [section, items] of bySection) {
		if (shown >= SHOP_LIST_LIMIT) break;
		text += `\n*${safeText(section)}*\n`;
		for (const offer of items.slice(0, SHOP_LIST_LIMIT - shown)) {
			text += `• ${safeText(offer.name)}${formatPrice(offer)}\n`;
			shown++;
		}
	}
	if (offers.length > shown) text += `\n📋 E mais ${offers.length - shown} ofertas.`;
	text += "\n🔎 Procure um item: !fortnite-loja <nome>";
	return text.trim();
}

function formatSearch(term, found) {
	let text = `🔎 *Loja do Fortnite: ${safeText(term)}*\n\n`;
	for (const offer of found.slice(0, SHOP_SEARCH_LIMIT)) {
		const details = [offer.type, offer.rarity].filter(Boolean).map(safeText).join(", ");
		text += `• *${safeText(offer.name)}*${formatPrice(offer)}${details ? `\n   ${details}` : ""}\n`;
	}
	if (found.length > SHOP_SEARCH_LIMIT)
		text += `\n📋 E mais ${found.length - SHOP_SEARCH_LIMIT} ofertas.`;
	return text.trim();
}

function formatDate(value) {
	const date = new Date(value);
	return Number.isFinite(date.getTime())
		? date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })
		: null;
}

function formatSeason(season) {
	let text = `📅 *Temporada atual do Fortnite*\n\n🔢 Temporada: *${season.seasonNumber}*\n`;
	const begin = formatDate(season.seasonDateBegin);
	const end = formatDate(season.seasonDateEnd);
	if (begin) text += `▶️ Início: ${begin}\n`;
	if (end) {
		const days = Math.ceil((new Date(season.seasonDateEnd).getTime() - Date.now()) / 86400000);
		text += `⏹️ Fim: ${end}${days > 0 ? ` (faltam ${days} dias)` : ""}\n`;
	}
	return text.trim();
}

function reply(message, content, options = {}) {
	return new ReturnMessage({
		chatId: message.group || message.author,
		content,
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin,
			...options
		}
	});
}

function reject(message, reason) {
	telemetry.setAttrs({ "app.outcome": "rejected", "app.reject.reason": reason });
	return reply(message, ERROR_REPLIES[reason]);
}

function failure(message, error, label) {
	const reason = error.reason || "unavailable";
	if (reason === "unavailable" || reason === "auth") {
		logger.error(`Erro na consulta ${label} do Fortnite`, {
			status: error.response?.status,
			message: error.message
		});
		telemetry.recordError(telemetry.activeSpan(), error);
		return reply(message, ERROR_REPLIES[reason]);
	}
	return reject(message, reason);
}

async function fortnitePlayerCommand(bot, message, args) {
	const displayName = args.join(" ").trim();
	if (!displayName) {
		telemetry.setAttrs({ "app.outcome": "rejected", "app.reject.reason": "missing_nick" });
		return reply(message, "❌ Informe o nome Epic do jogador.\n*Exemplo:* !fortnite NomeEpic");
	}
	try {
		const player = await getPlayer(displayName);
		telemetry.setAttrs({
			"ravena.fortnite.matches": player.totals.geral.matches,
			"ravena.fortnite.modes": MODES.filter((m) => player.totals[m.key].matches > 0).length
		});
		return reply(message, formatPlayer(player));
	} catch (error) {
		return failure(message, error, "de jogador");
	}
}

async function fortniteShopCommand(bot, message, args) {
	const term = args.join(" ").trim();
	try {
		const offers = await getShop();
		telemetry.setAttrs({
			"ravena.fortnite.shop.entries": offers.length,
			"ravena.fortnite.shop.search": Boolean(term)
		});
		if (!term) return reply(message, formatShop(offers));
		const needle = normalize(term);
		const found = offers.filter((o) => o.searchText.includes(needle));
		telemetry.setAttrs({ "ravena.fortnite.shop.matches": found.length });
		if (!found.length) {
			telemetry.setAttrs({ "app.outcome": "rejected", "app.reject.reason": "no_results" });
			return reply(
				message,
				`😔 Nada com "${safeText(term)}" na loja de hoje.\nVeja a loja inteira com !fortnite-loja`
			);
		}
		const caption = formatSearch(term, found);
		const image = found.find((o) => o.image)?.image;
		if (image && typeof bot?.createMediaFromURL === "function") {
			try {
				const media = await bot.createMediaFromURL(image);
				return reply(message, media, { caption });
			} catch (imageError) {
				logger.warn(`Erro ao preparar imagem da loja do Fortnite: ${imageError.message}`);
			}
		}
		return reply(message, caption);
	} catch (error) {
		return failure(message, error, "da loja");
	}
}

async function fortniteSeasonCommand(bot, message) {
	try {
		const season = await getSeason();
		telemetry.setAttrs({ "ravena.fortnite.season": season?.seasonNumber });
		return reply(message, formatSeason(season));
	} catch (error) {
		return failure(message, error, "da temporada");
	}
}

const reactions = {
	before: process.env.LOADING_EMOJI ?? "⌛️",
	after: "🎯",
	error: "❌"
};

const commands = [
	new Command({
		name: "fortnite",
		aliases: ["fn"],
		cooldown: 20,
		description: "Estatísticas de Battle Royale de um jogador do Fortnite",
		usage: "!fortnite <nome-epic>",
		category: "jogos",
		group: "fortnite",
		reactions,
		method: fortnitePlayerCommand
	}),
	new Command({
		name: "fortnite-loja",
		aliases: ["fn-loja"],
		cooldown: 20,
		description: "Loja de itens do Fortnite de hoje, ou procura um item nela",
		usage: "!fortnite-loja [nome do item]",
		category: "jogos",
		group: "fortnite",
		reactions: { ...reactions, after: "🛒" },
		method: fortniteShopCommand
	}),
	new Command({
		name: "fortnite-temporada",
		aliases: ["fn-temporada"],
		cooldown: 20,
		description: "Número e datas da temporada atual do Fortnite",
		usage: "!fortnite-temporada",
		category: "jogos",
		group: "fortnite",
		reactions: { ...reactions, after: "📅" },
		method: fortniteSeasonCommand
	})
];

const helper = {
	about: "Consulta de jogadores, loja de itens e temporada do Fortnite",
	implementation:
		"Consome a API api-fortnite.com (chave em FORTNITE_API_KEY): conta Epic pelo nome, estatísticas de Battle Royale, loja do dia e temporada atual, com cache em memória",
	tags: "fortnite,epic,battle royale,loja,vbucks,skins,estatisticas,games,jogos",
	cmds: [
		{
			cmd: "!fortnite",
			desc: "Vitórias, partidas, abates e K/D de um jogador do Fortnite, no geral e por modo",
			usage: ["!fortnite NomeEpic", "!fn NomeEpic"],
			category: "jogos"
		},
		{
			cmd: "!fortnite-loja",
			desc: "Lista a loja de itens do dia ou procura um item nela, com a imagem",
			usage: ["!fortnite-loja", "!fortnite-loja Peely"],
			category: "jogos"
		},
		{
			cmd: "!fortnite-temporada",
			desc: "Mostra a temporada atual do Fortnite e quantos dias faltam para acabar",
			usage: ["!fortnite-temporada"],
			category: "jogos"
		}
	]
};

module.exports = {
	helper,
	commands,
	summarizeStats,
	fortnitePlayerCommand,
	fortniteShopCommand,
	fortniteSeasonCommand,
	clearCache: () => cache.clear()
};
