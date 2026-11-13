/**
 * ScheduledEventService.js
 *
 * Gerencia Eventos Programados com data/hora de início e fim,
 * concessão automática de itens ao iniciar, buffs contínuos nos jogos
 * e aviso automático no WhatsApp (GRUPO_AVISOS e GRUPO_ANUNCIOS).
 */

const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const ReturnMessage = require("../models/ReturnMessage");
const BroadcastHelper = require("../utils/BroadcastHelper");

const logger = new Logger("scheduled-events");

const BRT_OFFSET_SUFFIX = "-03:00";

/**
 * Catálogo completo de bônus programáveis:
 * - startGrants: ganhos instantâneos distribuídos a todos no início do evento
 * - ongoingBuffs: multiplicadores contínuos ativos durante [startTime, endTime)
 */
const START_GRANTS_CATALOG = [
	{
		id: "waifu.zinthos",
		game: "waifu",
		gameLabel: "Waifuletes",
		key: "zinthos",
		label: "Zinthos para todos",
		unit: "Zinthos",
		emoji: "🪙",
		min: 1,
		max: 1000000,
		step: 1,
		defaultValue: 500,
		description: "Credita Zinthos para todos os jogadores de Waifuletes ao iniciar."
	},
	{
		id: "waifu.rolls",
		game: "waifu",
		gameLabel: "Waifuletes",
		key: "rolls",
		label: "Rolls extras para todos",
		unit: "rolls",
		emoji: "🎲",
		min: 1,
		max: 1000,
		step: 1,
		defaultValue: 5,
		description: "Adiciona rolls gratuitos no !mu-roll para todos os jogadores de Waifuletes."
	},
	{
		id: "pesca.iscas",
		game: "pesca",
		gameLabel: "Pesca",
		key: "iscas",
		label: "Iscas para todos",
		unit: "iscas",
		emoji: "🪱",
		min: 1,
		max: 1000,
		step: 1,
		defaultValue: 10,
		description: "Entrega iscas para todos os pescadores cadastrados."
	},
	{
		id: "pesca.buff",
		game: "pesca",
		gameLabel: "Pesca",
		key: "buff",
		label: "Buff aleatório de Pesca",
		unit: "usos",
		emoji: "🪝",
		min: 1,
		max: 100,
		step: 1,
		defaultValue: 3,
		description: "Concede um buff positivo aleatório da Pesca com a quantidade de usos."
	},
	{
		id: "slots.moedas",
		game: "slots",
		gameLabel: "Slots",
		key: "moedas",
		label: "Moedas de Slots para todos",
		unit: "moedas",
		emoji: "🪙",
		min: 1,
		max: 100000,
		step: 1,
		defaultValue: 20,
		description: "Distribui moedas extras para todos os jogadores de Slots."
	},
	{
		id: "fazenda.moedas",
		game: "fazenda",
		gameLabel: "Fazenda",
		key: "moedas",
		label: "Petalitas para todos",
		unit: "Petalitas",
		emoji: "💰",
		min: 1,
		max: 1000000,
		step: 1,
		defaultValue: 500,
		description: "Credita Petalitas para todos os fazendeiros no Jardim das Sombras."
	},
	{
		id: "fazenda.bags",
		game: "fazenda",
		gameLabel: "Fazenda",
		key: "bags",
		label: "Sacolas do Coveiro para todos",
		unit: "sacolas",
		emoji: "🎒",
		min: 1,
		max: 500,
		step: 1,
		defaultValue: 3,
		description: "Abre e entrega Sacolas do Coveiro (sementes) para todos os fazendeiros."
	}
];

const ONGOING_BUFFS_CATALOG = [
	{
		id: "pesca.peso",
		game: "pesca",
		gameLabel: "Pesca",
		key: "peso",
		label: "Peso dos Peixes",
		unit: "%",
		emoji: "⚖️",
		min: 1,
		max: 1000,
		step: 1,
		defaultValue: 25,
		description: "Aumenta o peso dos peixes pescados em +X%."
	},
	{
		id: "pesca.lendario",
		game: "pesca",
		gameLabel: "Pesca",
		key: "lendario",
		label: "Chance de Peixe Lendário",
		unit: "%",
		emoji: "🐉",
		min: 1,
		max: 1000,
		step: 1,
		defaultValue: 50,
		description: "Aumenta a chance de encontrar peixes lendários em +X%."
	},
	{
		id: "waifu.raros",
		game: "waifu",
		gameLabel: "Waifuletes",
		key: "raros",
		label: "Chance de Waifus Raras",
		unit: "%",
		emoji: "💎",
		min: 1,
		max: 1000,
		step: 1,
		defaultValue: 50,
		description: "Aumenta a chance de roletar personagens raros/épicos/lendários em +X%."
	},
	{
		id: "waifu.wish",
		game: "waifu",
		gameLabel: "Waifuletes",
		key: "wish",
		label: "Chance de Wishlist",
		unit: "%",
		emoji: "🌟",
		min: 1,
		max: 1000,
		step: 1,
		defaultValue: 50,
		description: "Aumenta a chance de aparecerem waifus da sua wishlist em +X%."
	},
	{
		id: "slots.vitoria",
		game: "slots",
		gameLabel: "Slots",
		key: "vitoria",
		label: "Chance de Vitória nos Slots",
		unit: "%",
		emoji: "🍀",
		min: 1,
		max: 1000,
		step: 1,
		defaultValue: 25,
		description: "Aumenta a chance de vitória no caça-níquel em +X%."
	},
	{
		id: "slots.moedas",
		game: "slots",
		gameLabel: "Slots",
		key: "moedas",
		label: "Multiplicador de Moedas",
		unit: "%",
		emoji: "💵",
		min: 1,
		max: 1000,
		step: 1,
		defaultValue: 50,
		description: "Aumenta as moedas ganhas nos prêmios de Slots em +X%."
	},
	{
		id: "slots.iscas",
		game: "slots",
		gameLabel: "Slots",
		key: "iscas",
		label: "Multiplicador de Iscas",
		unit: "%",
		emoji: "🪱",
		min: 1,
		max: 1000,
		step: 1,
		defaultValue: 50,
		description: "Aumenta as iscas ganhas nos prêmios de Slots em +X%."
	},
	{
		id: "fazenda.apodrecer",
		game: "fazenda",
		gameLabel: "Fazenda",
		key: "apodrecer",
		label: "Proteção Contra Apodrecimento",
		unit: "%",
		emoji: "🛡️",
		min: 1,
		max: 100,
		step: 1,
		defaultValue: 50,
		description: "Aumenta o tempo/proteção antes das plantas apodrecerem em +X%."
	},
	{
		id: "fazenda.fortuna",
		game: "fazenda",
		gameLabel: "Fazenda",
		key: "fortuna",
		label: "Fortuna do Jardim",
		unit: "%",
		emoji: "🌻",
		min: 1,
		max: 1000,
		step: 1,
		defaultValue: 50,
		description: "Aumenta os ganhos de Petalitas em vendas e bônus diário em +X%."
	}
];

const START_GRANTS_BY_ID = Object.fromEntries(START_GRANTS_CATALOG.map((item) => [item.id, item]));
const ONGOING_BUFFS_BY_ID = Object.fromEntries(
	ONGOING_BUFFS_CATALOG.map((item) => [item.id, item])
);

function createValidationError(message) {
	const err = new Error(message);
	err.statusCode = 400;
	return err;
}

function getCatalog() {
	return {
		startGrants: START_GRANTS_CATALOG,
		ongoingBuffs: ONGOING_BUFFS_CATALOG
	};
}

/**
 * Converte timestamp numérico ou string ISO/datetime-local para epoch ms.
 * Strings sem timezone (ex: "2026-11-20T18:00") são interpretadas no fuso BRT (-03:00).
 */
function parseDateTimeInput(raw) {
	if (typeof raw === "number") {
		return Number.isFinite(raw) ? Math.trunc(raw) : NaN;
	}
	if (typeof raw !== "string") return NaN;

	const trimmed = raw.trim();
	if (!trimmed) return NaN;

	if (/^\d{10,13}$/.test(trimmed)) {
		const num = Number(trimmed);
		return trimmed.length === 10 ? num * 1000 : num;
	}

	let isoCandidate = trimmed.replace(" ", "T");
	// datetime-local sem segundos -> acrescenta :00
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(isoCandidate)) {
		isoCandidate += ":00";
	}
	// Se não possuir Z nem offset explícito (+HH:MM / -HH:MM), assume BRT (-03:00)
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(isoCandidate)) {
		isoCandidate += BRT_OFFSET_SUFFIX;
	}

	const parsed = Date.parse(isoCandidate);
	return Number.isFinite(parsed) ? parsed : NaN;
}

function flattenBuffSelection(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {};
	}
	const out = {};
	for (const [k, v] of Object.entries(raw)) {
		if (v && typeof v === "object" && !Array.isArray(v) && !k.includes(".")) {
			for (const [subKey, subVal] of Object.entries(v)) {
				out[`${k}.${subKey}`] = subVal;
			}
		} else {
			out[k] = v;
		}
	}
	return out;
}

function validateSelectionMap(rawInput, catalogById, sectionTitle) {
	const flattened = flattenBuffSelection(rawInput);
	const result = {};

	for (const [id, rawVal] of Object.entries(flattened)) {
		if (rawVal === null || rawVal === undefined || rawVal === false || rawVal === "") {
			continue;
		}
		const spec = catalogById[id];
		if (!spec) {
			throw createValidationError(`Buff desconhecido em ${sectionTitle}: "${id}".`);
		}

		const strVal = String(rawVal).trim();
		if (!/^-?\d+$/.test(strVal)) {
			throw createValidationError(
				`Valor inválido para "${spec.label}" (${spec.gameLabel}): informe um número inteiro entre ${spec.min} e ${spec.max}.`
			);
		}

		const numVal = parseInt(strVal, 10);
		if (!Number.isSafeInteger(numVal) || numVal < spec.min || numVal > spec.max) {
			throw createValidationError(
				`Valor fora do limite para "${spec.label}" (${spec.gameLabel}): deve estar entre ${spec.min} e ${spec.max} (${spec.unit}).`
			);
		}

		result[id] = numVal;
	}

	return result;
}

function formatDurationPtBr(durationMs) {
	const totalMinutes = Math.max(1, Math.round(durationMs / 60000));
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;

	const parts = [];
	if (days > 0) {
		parts.push(`${days} ${days === 1 ? "dia" : "dias"}`);
	}
	if (hours > 0) {
		parts.push(`${hours} ${hours === 1 ? "hora" : "horas"}`);
	}
	if (parts.length === 0 || (days === 0 && minutes > 0)) {
		parts.push(`${minutes} ${minutes === 1 ? "minuto" : "minutos"}`);
	} else if (days > 0 && hours === 0 && minutes > 0) {
		parts.push(`${minutes} ${minutes === 1 ? "minuto" : "minutos"}`);
	}

	if (parts.length === 1) return parts[0];
	if (parts.length === 2) return `${parts[0]} e ${parts[1]}`;
	return `${parts[0]}, ${parts[1]} e ${parts[2]}`;
}

function formatDateTimeBRT(tsMs) {
	if (!Number.isFinite(tsMs)) return "-";
	const d = new Date(tsMs);
	const datePart = new Intl.DateTimeFormat("pt-BR", {
		timeZone: "America/Sao_Paulo",
		day: "2-digit",
		month: "2-digit",
		year: "numeric"
	}).format(d);
	const timePart = new Intl.DateTimeFormat("pt-BR", {
		timeZone: "America/Sao_Paulo",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false
	}).format(d);
	return `${datePart} às ${timePart} (BRT)`;
}

function describeBuffSelection(startGrants = {}, ongoingBuffs = {}) {
	const grantsList = [];
	for (const item of START_GRANTS_CATALOG) {
		const val = startGrants[item.id];
		if (val && Number(val) > 0) {
			grantsList.push({
				...item,
				value: Number(val),
				displayText: `${item.emoji} ${item.label} (${item.gameLabel}): +${Number(val).toLocaleString("pt-BR")} ${item.unit}`
			});
		}
	}

	const buffsList = [];
	for (const item of ONGOING_BUFFS_CATALOG) {
		const val = ongoingBuffs[item.id];
		if (val && Number(val) > 0) {
			buffsList.push({
				...item,
				value: Number(val),
				displayText: `${item.emoji} ${item.label} (${item.gameLabel}): +${Number(val).toLocaleString("pt-BR")}%`
			});
		}
	}

	return { grantsList, buffsList };
}

/**
 * Gera a mensagem formatada para WhatsApp com base nos dados do evento.
 */
function generateWhatsAppMessage({
	name,
	startTime,
	endTime,
	startGrants = {},
	ongoingBuffs = {}
}) {
	const cleanName = String(name || "Evento Especial").trim() || "Evento Especial";
	const durationMs = Math.max(60000, Number(endTime || 0) - Number(startTime || 0));
	const durationText = formatDurationPtBr(durationMs);
	const endText = formatDateTimeBRT(Number(endTime));
	const { grantsList, buffsList } = describeBuffSelection(startGrants, ongoingBuffs);

	const lines = [
		"🎉✨ *EVENTO PROGRAMADO INICIADO!* ✨🎉",
		"",
		`🏷️ *Evento:* ${cleanName}`,
		`⏳ *Duração:* ${durationText}`,
		`📅 *Término:* ${endText}`
	];

	if (grantsList.length > 0) {
		lines.push("", "🎁 *Bônus ao Iniciar (para todos):*");
		for (const g of grantsList) {
			lines.push(
				`• ${g.emoji} *${g.label} (${g.gameLabel}):* +${g.value.toLocaleString("pt-BR")} ${g.unit}`
			);
		}
	}

	if (buffsList.length > 0) {
		lines.push("", "⚡ *Buffs Durante o Evento:*");
		for (const b of buffsList) {
			lines.push(`• ${b.emoji} *${b.label} (${b.gameLabel}):* +${b.value}%`);
		}
	}

	if (grantsList.length === 0 && buffsList.length === 0) {
		lines.push("", "✨ _Evento especial da comunidade ativo no período indicado._");
	}

	lines.push("", "_Aproveite! Digite `!eventos` no grupo para conferir os buffs ativos._");
	return lines.join("\n");
}

function validateEventPayload(payload = {}, { requireTimes = true } = {}) {
	const name = String(payload.name || "").trim();
	if (!name) {
		throw createValidationError("O nome do evento é obrigatório.");
	}
	if (name.length > 120) {
		throw createValidationError("O nome do evento deve ter no máximo 120 caracteres.");
	}

	const startTime = parseDateTimeInput(payload.startTime);
	const endTime = parseDateTimeInput(payload.endTime);

	if (requireTimes) {
		if (!Number.isFinite(startTime) || startTime <= 0) {
			throw createValidationError("Data e hora inicial inválidas.");
		}
		if (!Number.isFinite(endTime) || endTime <= 0) {
			throw createValidationError("Data e hora final inválidas.");
		}
		if (endTime <= startTime) {
			throw createValidationError("A data/hora final deve ser posterior à data/hora inicial.");
		}
	}

	const startGrants = validateSelectionMap(
		payload.startGrants,
		START_GRANTS_BY_ID,
		"Ganho ao Iniciar"
	);
	const ongoingBuffs = validateSelectionMap(
		payload.ongoingBuffs,
		ONGOING_BUFFS_BY_ID,
		"Buffs Durante o Evento"
	);

	let message = typeof payload.message === "string" ? payload.message.trim() : "";
	if (!message && Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime) {
		message = generateWhatsAppMessage({ name, startTime, endTime, startGrants, ongoingBuffs });
	}

	return {
		name,
		startTime,
		endTime,
		startGrants,
		ongoingBuffs,
		message
	};
}

/**
 * Classifica uma lista cronológica de eventos em:
 * - "ativo"   (verde): startTime <= now < endTime
 * - "passado" (cinza): endTime <= now
 * - "proximo" (amarelo): próximo(s) evento(s) futuro(s) com menor startTime > now
 * - "normal"  (padrão): demais eventos futuros
 */
function classifyEvents(events, now = Date.now()) {
	const sorted = [...(events || [])].sort((a, b) => a.startTime - b.startTime || a.id - b.id);
	const futureStarts = sorted.filter((e) => e.startTime > now).map((e) => e.startTime);
	const nextStartTime = futureStarts.length > 0 ? Math.min(...futureStarts) : null;

	const STATUS_LABELS = {
		ativo: "Ativo Agora",
		proximo: "Próximo",
		passado: "Encerrado",
		normal: "Programado"
	};

	return sorted.map((ev) => {
		let status = "normal";
		if (ev.endTime <= now) {
			status = "passado";
		} else if (ev.startTime <= now && ev.endTime > now) {
			status = "ativo";
		} else if (nextStartTime !== null && ev.startTime === nextStartTime) {
			status = "proximo";
		}

		const { grantsList, buffsList } = describeBuffSelection(ev.startGrants, ev.ongoingBuffs);

		return {
			...ev,
			status,
			statusLabel: STATUS_LABELS[status],
			durationLabel: formatDurationPtBr(Math.max(60000, ev.endTime - ev.startTime)),
			startFormatted: formatDateTimeBRT(ev.startTime),
			endFormatted: formatDateTimeBRT(ev.endTime),
			grantsList,
			buffsList
		};
	});
}

class ScheduledEventService {
	constructor() {
		this.database = Database.getInstance();
		this.bots = new Set();
		this.activeCache = [];
		this.initialized = false;
		this.pollTimer = null;
		this.isTickRunning = false;
	}

	static getInstance() {
		if (!ScheduledEventService.instance) {
			ScheduledEventService.instance = new ScheduledEventService();
		}
		return ScheduledEventService.instance;
	}

	registerBot(bot) {
		if (bot) {
			this.bots.add(bot);
		}
	}

	async init() {
		await this.refreshActiveCache();
		this.initialized = true;
	}

	async refreshActiveCache(now = Date.now()) {
		try {
			this.activeCache = await this.database.getActiveScheduledEvents(now);
		} catch (err) {
			logger.error(`[refreshActiveCache] Erro ao atualizar cache: ${err.message}`);
		}
		return this.activeCache;
	}

	getActiveScheduledEventsSnapshot(now = Date.now()) {
		this.activeCache = (this.activeCache || []).filter((ev) => ev.endTime > now);
		return this.activeCache.filter((ev) => ev.startTime <= now && ev.endTime > now);
	}

	getActiveOngoingBuffs(game, type, now = Date.now()) {
		const buffId = `${game}.${type}`;
		const active = this.getActiveScheduledEventsSnapshot(now);
		let totalValue = 0;
		let minStartTime = null;
		let maxEndTime = 0;
		const eventNames = [];

		for (const ev of active) {
			const val = Number(ev.ongoingBuffs?.[buffId] || 0);
			if (val > 0) {
				totalValue += val;
				eventNames.push(ev.name);
				if (minStartTime === null || ev.startTime < minStartTime) {
					minStartTime = ev.startTime;
				}
				if (ev.endTime > maxEndTime) {
					maxEndTime = ev.endTime;
				}
			}
		}

		if (totalValue <= 0) return null;
		return {
			game,
			type,
			value: totalValue,
			startTime: minStartTime || now,
			endTime: maxEndTime,
			eventNames
		};
	}

	async listEvents({ year = null } = {}, now = Date.now()) {
		const rows = await this.database.getScheduledEvents({ year });
		return classifyEvents(rows, now);
	}

	async getEventById(id) {
		const ev = await this.database.getScheduledEventById(id);
		if (!ev) return null;
		return classifyEvents([ev])[0];
	}

	async createEvent(payload) {
		const validated = validateEventPayload(payload, { requireTimes: true });
		const created = await this.database.createScheduledEvent(validated);
		await this.refreshActiveCache();

		const now = Date.now();
		if (created && created.startTime <= now && created.endTime > now) {
			// Dispara ativação inicial (itens + anúncio) em segundo plano para não bloquear a API HTTP
			setImmediate(() => {
				this.processPendingStarts().catch((e) =>
					logger.error(`[createEvent] Falha ao iniciar evento ativo imediato: ${e.message}`)
				);
			});
		}

		return this.getEventById(created.id);
	}

	async updateEvent(id, payload) {
		const existing = await this.database.getScheduledEventById(id);
		if (!existing) {
			const err = new Error("Evento não encontrado.");
			err.statusCode = 404;
			throw err;
		}

		const validated = validateEventPayload(payload, { requireTimes: true });
		const now = Date.now();
		const resetStartedAt =
			Boolean(existing.startedAt) &&
			validated.startTime > now &&
			validated.startTime !== existing.startTime;

		const updated = await this.database.updateScheduledEvent(id, validated, { resetStartedAt });
		await this.refreshActiveCache();

		if (updated && !updated.startedAt && updated.startTime <= now && updated.endTime > now) {
			setImmediate(() => {
				this.processPendingStarts().catch((e) =>
					logger.error(`[updateEvent] Falha ao ativar evento editado: ${e.message}`)
				);
			});
		}

		return this.getEventById(id);
	}

	async deleteEvent(id) {
		const deleted = await this.database.deleteScheduledEvent(id);
		await this.refreshActiveCache();
		return deleted;
	}

	async executeStartGrants(event) {
		const grants = event?.startGrants || {};
		const entries = Object.entries(grants).filter(([, amount]) => Number(amount) > 0);
		if (entries.length === 0) return [];

		const results = [];
		for (const [grantId, rawAmount] of entries) {
			const amount = Number(rawAmount);
			try {
				if (grantId === "slots.moedas") {
					await this.database.dbRun("slots", "UPDATE slots_users SET coins = MAX(0, coins + ?)", [
						amount
					]);
					results.push({ grantId, ok: true, amount });
				} else if (grantId === "fazenda.moedas") {
					const ShadowGardenClient = require("./ShadowGardenClient");
					const jardimClient = new ShadowGardenClient();
					await jardimClient.adminGiveAll({
						coins: amount,
						reason: "evento_programado_inicio"
					});
					results.push({ grantId, ok: true, amount });
				} else if (grantId === "fazenda.bags") {
					const { openSacolasDoCoveiro } = require("../functions/SlotsGame");
					const ShadowGardenClient = require("./ShadowGardenClient");
					const jardimClient = new ShadowGardenClient();
					const openedSeeds = openSacolasDoCoveiro(amount);
					const items = Object.entries(openedSeeds).map(([itemId, data]) => ({
						itemId,
						amount: data.count
					}));
					await jardimClient.adminGiveAll({
						items,
						reason: "evento_programado_bags"
					});
					results.push({ grantId, ok: true, amount });
				} else if (grantId === "waifu.zinthos") {
					const WaifuCommands = require("../functions/WaifuCommands");
					await WaifuCommands.grantZinthosAll(amount, { source: "SCHEDULED_EVENT" });
					results.push({ grantId, ok: true, amount });
				} else if (grantId === "waifu.rolls") {
					const WaifuCommands = require("../functions/WaifuCommands");
					const userIds = await WaifuCommands.getAllWaifuUserIds();
					const now = Date.now();
					await this.database.dbRun(
						"core",
						"UPDATE farm_bonus_inventory SET rolls = COALESCE(rolls, 0) + ?, updated_at = ?",
						[amount, now]
					);
					if (Array.isArray(userIds) && userIds.length > 0) {
						for (const uId of userIds) {
							await this.database.dbRun(
								"core",
								`INSERT INTO farm_bonus_inventory (user_id, rolls, tickets, updated_at)
								 VALUES (?, ?, 0, ?)
								 ON CONFLICT(user_id) DO UPDATE SET rolls = COALESCE(rolls, 0) + excluded.rolls, updated_at = excluded.updated_at`,
								[uId, amount, now]
							);
						}
					}
					results.push({ grantId, ok: true, amount });
				} else if (grantId === "pesca.iscas") {
					await this.database.dbRun(
						"fishing",
						"UPDATE fishing_users SET baits = MAX(0, baits + ?), last_bait_regen = ?",
						[amount, Date.now()]
					);
					results.push({ grantId, ok: true, amount });
				} else if (grantId === "pesca.buff") {
					const FishingGame = require("../functions/FishingGame");
					const validUpgrades = FishingGame.UPGRADES.filter(
						(u) => u.effect !== "slots_coins" && u.effect !== "extra_baits"
					);
					const chosen = validUpgrades[Math.floor(Math.random() * validUpgrades.length)];
					await this.database.dbRun(
						"fishing",
						`INSERT INTO fishing_buffs (user_id, effect_type, is_debuff, value, min_value, max_value, remaining_uses, original_name)
						 SELECT user_id, ?, 0, ?, ?, ?, ?, ? FROM fishing_users`,
						[
							chosen.effect,
							chosen.value ?? 0,
							chosen.minValue ?? 0,
							chosen.maxValue ?? 0,
							amount,
							chosen.name
						]
					);
					results.push({ grantId, ok: true, amount, buffName: chosen.name });
				}
			} catch (err) {
				logger.error(
					`[executeStartGrants] Erro ao aplicar grant ${grantId} (+${amount}) do evento #${event.id}: ${err.message}`
				);
				results.push({ grantId, ok: false, error: err.message });
			}
		}

		return results;
	}

	_resolveBroadcastBot(botOverride = null) {
		if (botOverride) return botOverride;
		const pool = [...Array.from(this.bots), ...(this.database.botInstances || [])].filter(Boolean);
		const selected = BroadcastHelper.getWhatsAppBroadcastBot(pool);
		if (selected) return selected;
		return pool.find((b) => !b.useTelegram && typeof b.sendReturnMessages === "function") || null;
	}

	_resolveAnnouncementTargets(bot) {
		const rawTargets = [
			process.env.GRUPO_ANUNCIOS || bot?.grupoAnuncios,
			process.env.GRUPO_AVISOS || bot?.grupoAvisos
		]
			.map((t) => (typeof t === "string" ? t.trim() : ""))
			.filter(Boolean);
		return Array.from(new Set(rawTargets));
	}

	async announceEventStart(event, botOverride = null) {
		const targetBot = this._resolveBroadcastBot(botOverride);
		if (!targetBot) {
			logger.warn(
				`[announceEventStart] Nenhum bot WhatsApp conectado encontrado para anunciar o evento "${event.name}".`
			);
			return [];
		}

		const targets = this._resolveAnnouncementTargets(targetBot);
		if (targets.length === 0) {
			logger.warn(
				`[announceEventStart] GRUPO_AVISOS / GRUPO_ANUNCIOS não configurados; anúncio ignorado para "${event.name}".`
			);
			return [];
		}

		const content =
			(event.message && event.message.trim()) ||
			generateWhatsAppMessage({
				name: event.name,
				startTime: event.startTime,
				endTime: event.endTime,
				startGrants: event.startGrants,
				ongoingBuffs: event.ongoingBuffs
			});

		const deliveries = [];
		for (const chatId of targets) {
			try {
				if (typeof targetBot.sendReturnMessages === "function") {
					await targetBot.sendReturnMessages([new ReturnMessage({ chatId, content })]);
				} else if (typeof targetBot.sendMessage === "function") {
					await targetBot.sendMessage(chatId, content);
				} else {
					throw new Error("Bot não possui sendReturnMessages ou sendMessage");
				}
				deliveries.push({ chatId, ok: true });
				logger.info(`[announceEventStart] Aviso de evento "${event.name}" enviado para ${chatId}.`);
			} catch (err) {
				logger.error(
					`[announceEventStart] Falha ao enviar aviso do evento "${event.name}" para ${chatId}: ${err.message}`
				);
				deliveries.push({ chatId, ok: false, error: err.message });
			}
		}

		return deliveries;
	}

	async processPendingStarts(now = Date.now(), { botOverride = null } = {}) {
		if (this.isTickRunning) return [];
		this.isTickRunning = true;
		const activated = [];

		try {
			await this.refreshActiveCache(now);
			const pending = await this.database.getPendingStartScheduledEvents(now);

			for (const ev of pending) {
				const claimed = await this.database.claimScheduledEventStart(ev.id, now);
				if (!claimed) continue;

				logger.info(`[processPendingStarts] Iniciando evento programado #${ev.id}: "${ev.name}"`);
				const grantsResult = await this.executeStartGrants(ev);
				const deliveries = await this.announceEventStart(ev, botOverride);
				activated.push({ event: ev, grantsResult, deliveries });
			}

			await this.refreshActiveCache(now);
		} catch (err) {
			logger.error(`[processPendingStarts] Erro ao processar eventos programados: ${err.message}`);
		} finally {
			this.isTickRunning = false;
		}

		return activated;
	}

	start(intervalMs = 30000) {
		this.stop();
		this.init()
			.then(() => this.processPendingStarts())
			.catch((err) => logger.error(`[start] Erro inicial do scheduler de eventos: ${err.message}`));

		this.pollTimer = setInterval(() => {
			this.processPendingStarts().catch((err) =>
				logger.error(`[poll] Erro no tick de eventos programados: ${err.message}`)
			);
		}, intervalMs);
		if (typeof this.pollTimer.unref === "function") {
			this.pollTimer.unref();
		}
		logger.info(`[ScheduledEventService] Scheduler iniciado (intervalo ${intervalMs / 1000}s).`);
	}

	stop() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}
}

module.exports = ScheduledEventService;
module.exports.START_GRANTS_CATALOG = START_GRANTS_CATALOG;
module.exports.ONGOING_BUFFS_CATALOG = ONGOING_BUFFS_CATALOG;
module.exports.getCatalog = getCatalog;
module.exports.parseDateTimeInput = parseDateTimeInput;
module.exports.validateEventPayload = validateEventPayload;
module.exports.formatDurationPtBr = formatDurationPtBr;
module.exports.formatDateTimeBRT = formatDateTimeBRT;
module.exports.generateWhatsAppMessage = generateWhatsAppMessage;
module.exports.classifyEvents = classifyEvents;
