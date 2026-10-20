const axios = require("axios");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const CurrencyConverter = require("../utils/CurrencyConverter");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const AdminUtils = require("../utils/AdminUtils");
const GroupContextHelper = require("../utils/GroupContextHelper");

const logger = new Logger("GamingFreebies");
const database = Database.getInstance();
const adminUtils = AdminUtils.getInstance();

const DB_NAME = "gaming_freebies";
const GIVEAWAYS_URL = "https://www.gamerpower.com/api/giveaways";
const WORTH_URL = "https://www.gamerpower.com/api/worth";
const REQUEST_TIMEOUT_MS = 10000;

// Inicialização do Banco SQLite para assinaturas e histórico de jogos
database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS free_games_subscriptions (
    group_id TEXT PRIMARY KEY,
    notificar_epic INTEGER DEFAULT 0,
    notificar_steam INTEGER DEFAULT 0,
    frequencia_dias INTEGER DEFAULT 7,
    periodo TEXT DEFAULT 'tarde',
    ultimo_aviso INTEGER DEFAULT 0,
    criado_em INTEGER,
    atualizado_em INTEGER
  );

  CREATE TABLE IF NOT EXISTS free_games_notified (
    group_id TEXT NOT NULL,
    store TEXT NOT NULL,
    game_id TEXT NOT NULL,
    title TEXT,
    notified_at INTEGER,
    PRIMARY KEY (group_id, store, game_id)
  );

  CREATE INDEX IF NOT EXISTS idx_free_games_subs_periodo ON free_games_subscriptions(periodo);
  CREATE INDEX IF NOT EXISTS idx_free_games_notified_group ON free_games_notified(group_id, store, game_id);
`,
	true
);

// Migrações retroativas seguras
(async () => {
	try {
		await database.dbRun(
			DB_NAME,
			"ALTER TABLE free_games_subscriptions ADD COLUMN periodo TEXT DEFAULT 'tarde'"
		);
	} catch (e) {
		// Coluna já existe
	}

	try {
		const tableInfo = await database.dbAll(DB_NAME, "PRAGMA table_info(free_games_notified)");
		const hasGroupId = Array.isArray(tableInfo) && tableInfo.some((col) => col.name === "group_id");
		if (tableInfo && tableInfo.length > 0 && !hasGroupId) {
			await database.dbRun(
				DB_NAME,
				`CREATE TABLE IF NOT EXISTS free_games_notified_v2 (
					group_id TEXT NOT NULL,
					store TEXT NOT NULL,
					game_id TEXT NOT NULL,
					title TEXT,
					notified_at INTEGER,
					PRIMARY KEY (group_id, store, game_id)
				)`
			);
			const oldRows = await database.dbAll(DB_NAME, "SELECT * FROM free_games_notified");
			for (const row of oldRows || []) {
				let targetGroups = [];
				if (row.notified_at === 1791682496366) {
					targetGroups = ["120363000000000000@g.us"];
				} else if (row.notified_at === 1791720000005) {
					targetGroups = ["120363252368931506@g.us", "120363431161293361@g.us"];
				} else if (row.notified_at === 1792083600041) {
					targetGroups = ["120363431515863732@g.us"];
				}
				for (const gid of targetGroups) {
					await database.dbRun(
						DB_NAME,
						"INSERT OR IGNORE INTO free_games_notified_v2 (group_id, store, game_id, title, notified_at) VALUES (?, ?, ?, ?, ?)",
						[gid, row.store, row.game_id, row.title, row.notified_at]
					);
				}
			}
			await database.dbRun(DB_NAME, "DROP TABLE free_games_notified");
			await database.dbRun(
				DB_NAME,
				"ALTER TABLE free_games_notified_v2 RENAME TO free_games_notified"
			);
			await database.dbRun(
				DB_NAME,
				"CREATE INDEX IF NOT EXISTS idx_free_games_notified_group ON free_games_notified(group_id, store, game_id)"
			);
		}
	} catch (e) {
		logger.error("Erro na migração de free_games_notified:", e.message);
	}
})();

// Dicionário de descrição dos períodos
const PERIODO_INFO = {
	manha: { nome: "Manhã", horario: "09:00 BRT", horaNum: 9 },
	tarde: { nome: "Tarde", horario: "14:00 BRT", horaNum: 14 },
	noite: { nome: "Noite", horario: "20:00 BRT", horaNum: 20 }
};

/**
 * Converte o valor da API ("$19.99", "$1,299.50", "N/A") em dólares.
 * @param {string} rawWorth
 * @returns {number} 0 quando não há valor
 */
function parseWorthUsd(rawWorth) {
	const amount = parseFloat(String(rawWorth ?? "").replace(/[^0-9.]/g, ""));
	return Number.isFinite(amount) ? amount : 0;
}

/**
 * Garante que apenas jogos sejam considerados
 * @param {Object} giveaway
 * @returns {boolean}
 */
function isGame(giveaway) {
	return !giveaway.type || String(giveaway.type).toLowerCase() === "game";
}

const ARP_POINTS_PATTERN = /\bARP\b/;

/**
 * Chaves da Alienware Arena custam ARP (pontos de conta): não são gratuitas reais.
 * @param {Object} giveaway
 * @returns {boolean}
 */
function requiresArpPoints(giveaway) {
	return ARP_POINTS_PATTERN.test(`${giveaway.description ?? ""} ${giveaway.instructions ?? ""}`);
}

/**
 * Limpa o título do jogo removendo referências à Epic Games e 'Giveaway'
 * @param {string} rawTitle
 * @returns {string}
 */
function cleanEpicTitle(rawTitle) {
	return String(rawTitle ?? "")
		.replace(/\s*\(Epic Games(?: Store)?\)/i, "")
		.replace(/\s+Giveaway\s*$/i, "")
		.trim();
}

/**
 * Mapeia item cru da API GamerPower para objeto padronizado
 * @param {Object} giveaway
 * @returns {Object|null}
 */
function toFreeGame(giveaway) {
	if (!giveaway?.id || !giveaway?.title || !giveaway?.open_giveaway_url) return null;
	if (!isGame(giveaway) || requiresArpPoints(giveaway)) return null;
	return {
		id: String(giveaway.id),
		title: giveaway.title,
		url: giveaway.open_giveaway_url,
		worthUsd: parseWorthUsd(giveaway.worth),
		platforms: giveaway.platforms || "PC"
	};
}

/**
 * Busca jogos de uma plataforma específica na GamerPower
 * @param {string} platform
 * @returns {Promise<{ok: boolean, games: Array}>}
 */
async function fetchPlatformGames(platform) {
	try {
		const response = await axios.get(GIVEAWAYS_URL, {
			params: { platform, type: "game", "sort-by": "popularity" },
			timeout: REQUEST_TIMEOUT_MS
		});
		const giveaways = Array.isArray(response.data) ? response.data : [];
		const games = giveaways.map(toFreeGame).filter(Boolean);
		return { ok: true, games };
	} catch (error) {
		logger.error(`Erro ao buscar jogos grátis (${platform}):`, error.message);
		return { ok: false, games: [] };
	}
}

/**
 * Comando para listar jogos grátis atuais (!0800 / !jogos-free / !giveaways)
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function gamingFreebiesCommand(bot, message, args, group) {
	const chatId = message.group || message.author;
	const platformArg = (args[0] || "").toLowerCase().trim();

	try {
		// URLs da API - Ordenado por popularidade
		let giveawaysUrl = `${GIVEAWAYS_URL}?sort-by=popularity`;
		if (platformArg) {
			giveawaysUrl += `&platform=${encodeURIComponent(platformArg)}`;
		}

		// Faz as requisições em paralelo
		const [giveawaysResponse, worthResponse] = await Promise.all([
			axios.get(giveawaysUrl, { timeout: REQUEST_TIMEOUT_MS }).catch(() => ({ data: [] })),
			axios.get(WORTH_URL, { timeout: REQUEST_TIMEOUT_MS }).catch(() => ({
				data: { worth_estimation_usd: "0" }
			}))
		]);

		const giveaways = Array.isArray(giveawaysResponse.data) ? giveawaysResponse.data : [];
		const worthData = worthResponse.data;

		if (giveaways.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `❌ Nenhum brinde encontrado${platformArg ? ` para a plataforma *${platformArg}*` : ""}.`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		// Filtra itens com ARP e separa jogos de DLCs/Outros
		const validGiveaways = giveaways.filter((item) => !requiresArpPoints(item));
		const games = validGiveaways.filter(isGame);
		const others = validGiveaways.filter((item) => !isGame(item));

		const limit = 50;
		let count = 0;

		let response = `🎮 *JOGOS GRÁTIS ATUALMENTE* 🎮\n`;
		response += `_Lista de jogos e brindes disponíveis para resgate imediato_\n`;
		if (platformArg) response += `📍 Filtro: *${platformArg.toUpperCase()}*\n`;
		response += `\n`;

		// Seção de Jogos
		if (games.length > 0) {
			response += `🕹️ *JOGOS COMPLETOS:* \n\n`;
			games.slice(0, limit).forEach((item) => {
				if (count >= limit) return;
				const displayTitle =
					platformArg === "epic" || platformArg === "epic-games-store"
						? cleanEpicTitle(item.title)
						: item.title;
				response += `*${displayTitle}*\n`;
				response += `👾 💻 ${item.platforms}\n`;
				if (item.worth && item.worth !== "N/A") {
					response += `💰 Valor normal: ${item.worth}\n`;
				}
				response += `🔗 ${item.open_giveaway_url}\n\n`;
				count++;
			});
		}

		// Seção de DLCs/Outros
		if (others.length > 0 && count < limit) {
			response += `━━━━━━━━━━━━━━━\n`;
			response += `🎁 *DLCs, CUPONS E EXTRAS:* \n\n`;
			others.slice(0, limit - count).forEach((item) => {
				if (count >= limit) return;
				response += `*${item.title}*\n`;
				response += `🎁 💻 ${item.platforms}\n`;
				response += `🔗 ${item.open_giveaway_url}\n\n`;
				count++;
			});
		}

		// Adiciona a economia total
		const rawWorth = worthData?.worth_estimation_usd || worthData?.worth || "0";
		const usdWorth = parseFloat(String(rawWorth).replace("$", "").replace(",", "")) || 0;
		if (usdWorth > 0) {
			const brlWorth = CurrencyConverter.convertToBRL(usdWorth);
			const brlFormatted = CurrencyConverter.formatBRL(brlWorth);
			response += `━━━━━━━━━━━━━━━\n\n`;
			response += `💰 *ECONOMIA TOTAL:* \n`;
			response += `Ao todo, você pode economizar aproximadamente *${brlFormatted}* (US$ ${usdWorth.toFixed(2)}) hoje!\n\n`;
		}

		response += `💡 *Dicas:*\n`;
		response += `> Filtrar por loja: \`!jogos-free steam\` ou \`!jogos-free epic\`\n`;
		response += `> Ativar avisos no grupo: \`!jogos-free-notificar\` (Apenas Admins)\n`;

		if (response.length > 40000) {
			response = response.substring(0, 39900) + "... \n\n*Mensagem cortada devido ao tamanho.*";
		}

		return new ReturnMessage({
			chatId,
			content: response,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro ao buscar giveaways:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Erro ao buscar brindes de jogos. Tente novamente mais tarde.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}
}

/**
 * Obtém ou inicializa a assinatura de um grupo no banco
 * @param {string} groupId
 * @returns {Promise<Object>}
 */
async function getOrCreateSubscription(groupId) {
	let row = await database.dbGet(
		DB_NAME,
		"SELECT * FROM free_games_subscriptions WHERE group_id = ?",
		[groupId]
	);
	if (!row) {
		const now = Date.now();
		await database.dbRun(
			DB_NAME,
			`INSERT INTO free_games_subscriptions 
       (group_id, notificar_epic, notificar_steam, frequencia_dias, periodo, ultimo_aviso, criado_em, atualizado_em) 
       VALUES (?, 0, 0, 7, 'tarde', 0, ?, ?)`,
			[groupId, now, now]
		);
		row = {
			group_id: groupId,
			notificar_epic: 0,
			notificar_steam: 0,
			frequencia_dias: 7,
			periodo: "tarde",
			ultimo_aviso: 0,
			criado_em: now,
			atualizado_em: now
		};
	}
	return row;
}

/**
 * Identifica o grupo alvo e valida permissão de administrador
 * @param {Object} bot
 * @param {Object} message
 * @param {Object} group
 * @returns {Promise<{targetGroup: Object|null, errorResponse: ReturnMessage|null}>}
 */
async function resolveTargetGroupAndAdmin(bot, message, group) {
	return GroupContextHelper.resolveGroupAndAdmin(bot, message, group, {
		featureName: "as configurações de notificações"
	});
}

/**
 * Comando para seguir/deseguir notificações de jogos grátis (!jogos-free-notificar)
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function freeGamesNotificarCommand(bot, message, args, group) {
	const responseChatId = message.group ?? message.author;
	const { targetGroup, errorResponse } = await resolveTargetGroupAndAdmin(bot, message, group);
	if (errorResponse) return errorResponse;

	const targetArg = (args[0] || "").toLowerCase().trim();
	const sub = await getOrCreateSubscription(targetGroup.id);
	const now = Date.now();

	let novoEpic = sub.notificar_epic;
	let novoSteam = sub.notificar_steam;

	if (targetArg === "epic" || targetArg === "epicgames") {
		novoEpic = novoEpic ? 0 : 1;
	} else if (targetArg === "steam") {
		novoSteam = novoSteam ? 0 : 1;
	} else if (!targetArg || targetArg === "todas" || targetArg === "all") {
		// Se ambas estiverem ativas, desativa ambas. Caso contrário, ativa ambas.
		if (novoEpic && novoSteam) {
			novoEpic = 0;
			novoSteam = 0;
		} else {
			novoEpic = 1;
			novoSteam = 1;
		}
	} else {
		return new ReturnMessage({
			chatId: responseChatId,
			content:
				"⚠️ Opção inválida. Use `!jogos-free-notificar epic`, `!jogos-free-notificar steam` ou apenas `!jogos-free-notificar` para alternar ambas.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	await database.dbRun(
		DB_NAME,
		"UPDATE free_games_subscriptions SET notificar_epic = ?, notificar_steam = ?, atualizado_em = ? WHERE group_id = ?",
		[novoEpic, novoSteam, now, targetGroup.id]
	);

	const infoPeriodo = PERIODO_INFO[sub.periodo] || PERIODO_INFO.tarde;
	const grupoNome = targetGroup.name || targetGroup.id;

	let texto = `🎮 *Notificações de Jogos Grátis*\n`;
	texto += `👥 *Grupo:* ${grupoNome}\n\n`;
	texto += `• *Epic Games:* ${novoEpic ? "Ativado ✅" : "Desativado ❌"}\n`;
	texto += `• *Steam:* ${novoSteam ? "Ativado ✅" : "Desativado ❌"}\n`;
	texto += `• *Frequência atual:* a cada ${sub.frequencia_dias} dia(s)\n`;
	texto += `• *Horário de envio:* ${infoPeriodo.nome} (${infoPeriodo.horario})\n\n`;

	if (novoEpic || novoSteam) {
		texto += `🔔 *Avisos ativos!* O bot avisará novos jogos conforme a periodicidade configurada.\n`;
	} else {
		texto += `🔕 *Avisos desativados* para este grupo.\n`;
	}

	texto += `\n💡 *Dica:* Altere o intervalo e o turno de envio com:\n`;
	texto += `> \`!jogos-free-frequencia [dias] [manha|tarde|noite]\``;

	return new ReturnMessage({
		chatId: responseChatId,
		content: texto,
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		}
	});
}

/**
 * Comando para definir a frequência e horário das notificações (!jogos-free-frequencia)
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function freeGamesFrequenciaCommand(bot, message, args, group) {
	const responseChatId = message.group ?? message.author;
	const { targetGroup, errorResponse } = await resolveTargetGroupAndAdmin(bot, message, group);
	if (errorResponse) return errorResponse;

	const sub = await getOrCreateSubscription(targetGroup.id);
	const grupoNome = targetGroup.name || targetGroup.id;

	// Sem argumentos: exibe configuração atual
	if (args.length === 0) {
		const infoPeriodo = PERIODO_INFO[sub.periodo] || PERIODO_INFO.tarde;
		let texto = `📅 *Configuração de Frequência de Jogos Grátis*\n`;
		texto += `👥 *Grupo:* ${grupoNome}\n\n`;
		texto += `• *Intervalo:* a cada *${sub.frequencia_dias}* dia(s)\n`;
		texto += `• *Período de envio:* *${infoPeriodo.nome}* (${infoPeriodo.horario})\n`;
		texto += `• *Notificações:* Epic: ${sub.notificar_epic ? "✅" : "❌"} | Steam: ${sub.notificar_steam ? "✅" : "❌"}\n\n`;
		texto += `💡 *Como alterar:*\n`;
		texto += `Informe os dias (1 a 30) e/ou o período (\`manha\`, \`tarde\`, \`noite\`):\n`;
		texto += `> \`!jogos-free-frequencia 7 tarde\` (a cada 7 dias às 14h)\n`;
		texto += `> \`!jogos-free-frequencia diario noite\` (diário às 20h)\n`;
		texto += `> \`!jogos-free-frequencia manha\` (mantém dias, muda para 09h)\n`;
		texto += `> \`!jogos-free-frequencia 3\` (muda para 3 dias)\n`;

		return new ReturnMessage({
			chatId: responseChatId,
			content: texto,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	let novosDias = null;
	let novoPeriodo = null;

	for (const argRaw of args) {
		const arg = argRaw.toLowerCase().trim();

		// Período
		if (arg === "manha" || arg === "manhã" || arg === "morn" || arg === "morning") {
			novoPeriodo = "manha";
		} else if (arg === "tarde" || arg === "afternoon") {
			novoPeriodo = "tarde";
		} else if (arg === "noite" || arg === "night") {
			novoPeriodo = "noite";
		}
		// Palavras-chave de dias
		else if (arg === "diario" || arg === "diário" || arg === "dia" || arg === "daily") {
			novosDias = 1;
		} else if (arg === "semanal" || arg === "semana" || arg === "weekly") {
			novosDias = 7;
		} else if (arg === "quinzenal" || arg === "quinzena") {
			novosDias = 15;
		} else if (arg === "mensal" || arg === "mes" || arg === "mês" || arg === "monthly") {
			novosDias = 30;
		}
		// Números
		else {
			const numMatch = arg.match(/^(\d+)d?$/);
			if (numMatch) {
				const num = parseInt(numMatch[1], 10);
				if (!isNaN(num)) {
					novosDias = num;
				}
			}
		}
	}

	// Validação de dias se informado
	if (novosDias !== null && (novosDias < 1 || novosDias > 30)) {
		return new ReturnMessage({
			chatId: responseChatId,
			content:
				"⚠️ *Intervalo inválido!* O intervalo entre notificações deve ser de no mínimo *1 dia* e no máximo *30 dias*.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	if (novosDias === null && novoPeriodo === null) {
		return new ReturnMessage({
			chatId: responseChatId,
			content:
				"⚠️ Não entendi os parâmetros. Informe o número de dias (1 a 30) e/ou o período (`manha`, `tarde`, `noite`).\nExemplo: `!jogos-free-frequencia 7 tarde`",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	const finalDias = novosDias !== null ? novosDias : sub.frequencia_dias;
	const finalPeriodo = novoPeriodo !== null ? novoPeriodo : sub.periodo;
	const now = Date.now();

	await database.dbRun(
		DB_NAME,
		"UPDATE free_games_subscriptions SET frequencia_dias = ?, periodo = ?, atualizado_em = ? WHERE group_id = ?",
		[finalDias, finalPeriodo, now, targetGroup.id]
	);

	const infoPeriodo = PERIODO_INFO[finalPeriodo] || PERIODO_INFO.tarde;

	let texto = `✅ *Frequência de notificações atualizada com sucesso!*\n\n`;
	texto += `👥 *Grupo:* ${grupoNome}\n`;
	texto += `• *Novo intervalo:* a cada *${finalDias}* dia(s)\n`;
	texto += `• *Período de envio:* *${infoPeriodo.nome}* (${infoPeriodo.horario})\n`;

	return new ReturnMessage({
		chatId: responseChatId,
		content: texto,
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		}
	});
}

/**
 * Formata lista de jogos para mensagem de notificação
 * @param {Array<{label: string, games: Array}>} sections
 * @returns {string|null}
 */
function formatNotificationMessage(sections) {
	if (!sections || sections.length === 0) return null;

	const formatGameList = (games) => games.map((g) => `*${g.title}*\n🔗 ${g.url}`).join("\n\n");

	if (sections.length === 1) {
		const [sec] = sections;
		return `🎮 *Jogos novos liberados na ${sec.label}!* \n\n${formatGameList(sec.games)}`;
	}

	const sectionsText = sections
		.map((sec) => `*${sec.label}:*\n${formatGameList(sec.games)}`)
		.join("\n\n");
	return `🎮 *Jogos novos liberados!*\n\n${sectionsText}`;
}

/**
 * Encontra bots candidatos aptos a enviar mensagem no grupo (reutiliza padrão do RaffleMonitor)
 * @param {string} groupId
 * @param {Object} dbInstance
 * @param {string} [preferredBotId=null]
 * @param {Object} [groupObj=null]
 * @returns {Array<Object>}
 */
function findBotsForGroup(groupId, dbInstance, preferredBotId = null, groupObj = null) {
	const allBots = dbInstance?.botInstances || [];
	if (allBots.length === 0) {
		return [];
	}

	const isWhatsApp = groupId.includes("@g.us") || groupId.includes("@s.whatsapp.net");
	const isTelegram = groupId.startsWith("-");
	const isDiscord = !isWhatsApp && !isTelegram && groupId.length >= 17;

	const excludedBotNames = new Set(
		Array.isArray(groupObj?.botNotInGroup) ? groupObj.botNotInGroup : []
	);

	const candidates = [];

	for (const bot of allBots) {
		if (bot.useTelegram) {
			if (isWhatsApp || isDiscord) continue;
		} else if (bot.useDiscord) {
			if (isWhatsApp || isTelegram) continue;
		} else {
			if (!isWhatsApp) continue;
		}

		if (bot.isConnected === false) continue;
		if (excludedBotNames.has(bot.id) || excludedBotNames.has(bot.name)) continue;
		if (typeof bot.isParticipating === "function" && !bot.isParticipating(groupId)) {
			continue;
		}
		if (Array.isArray(bot.skipGroupInfo) && bot.skipGroupInfo.includes(groupId)) {
			continue;
		}

		candidates.push(bot);
	}

	if (preferredBotId) {
		candidates.sort((a, b) => {
			const aPref = a.id === preferredBotId || a.name === preferredBotId;
			const bPref = b.id === preferredBotId || b.name === preferredBotId;
			if (aPref && !bPref) return -1;
			if (!aPref && bPref) return 1;
			return 0;
		});
	}

	return candidates;
}

/**
 * Executa a rotina de verificação e envio de notificações para os grupos cadastrados
 * @param {string} [periodoAlvo] - 'manha', 'tarde' ou 'noite' (se omitido, processa todos os elegíveis)
 * @returns {Promise<{sent: number, failed: number}>}
 */
async function checkAndNotifyFreeGames(periodoAlvo = null) {
	const summary = { sent: 0, failed: 0 };

	try {
		let query =
			"SELECT * FROM free_games_subscriptions WHERE (notificar_epic = 1 OR notificar_steam = 1)";
		const params = [];
		if (periodoAlvo) {
			query += " AND periodo = ?";
			params.push(periodoAlvo);
		}

		const subs = await database.dbAll(DB_NAME, query, params);
		if (!subs || subs.length === 0) {
			return summary;
		}

		const now = Date.now();
		const MS_POR_DIA = 24 * 60 * 60 * 1000;
		const TOLERANCIA_MS = 60 * 60 * 1000; // 1 hora de tolerância

		// Filtra grupos que atingiram a periodicidade
		const gruposElegiveis = subs.filter((sub) => {
			const frequenciaMs = (sub.frequencia_dias || 7) * MS_POR_DIA;
			const tempoPassado = now - (sub.ultimo_aviso || 0);
			return tempoPassado >= frequenciaMs - TOLERANCIA_MS;
		});

		if (gruposElegiveis.length === 0) {
			return summary;
		}

		// Identifica quais lojas precisamos consultar
		const precisaEpic = gruposElegiveis.some((g) => g.notificar_epic === 1);
		const precisaSteam = gruposElegiveis.some((g) => g.notificar_steam === 1);

		let currentEpicGames = [];
		let currentSteamGames = [];

		if (precisaEpic) {
			const epicRes = await fetchPlatformGames("epic-games-store");
			if (epicRes.ok) {
				currentEpicGames = epicRes.games.map((g) => ({
					...g,
					title: cleanEpicTitle(g.title)
				}));
			}
		}

		if (precisaSteam) {
			const steamRes = await fetchPlatformGames("steam");
			if (steamRes.ok) {
				// Steam: ordena por maior valor USD, pega no máximo 3 jogos novos
				currentSteamGames = [...steamRes.games].sort((a, b) => b.worthUsd - a.worthUsd);
			}
		}

		if (currentEpicGames.length === 0 && currentSteamGames.length === 0) {
			logger.debug("[GamingFreebies] Nenhum jogo disponível na Epic ou Steam no momento.");
			return summary;
		}

		// Consulta histórico de notificações dos grupos elegíveis
		const groupIds = gruposElegiveis.map((g) => g.group_id);
		const placeholders = groupIds.map(() => "?").join(",");
		const notifiedRows = await database.dbAll(
			DB_NAME,
			`SELECT group_id, store, game_id FROM free_games_notified WHERE group_id IN (${placeholders})`,
			groupIds
		);

		const notifiedByGroup = new Map();
		for (const gid of groupIds) {
			notifiedByGroup.set(gid, new Set());
		}
		for (const r of notifiedRows || []) {
			const set = notifiedByGroup.get(r.group_id);
			if (set) {
				set.add(`${r.store}:${r.game_id}`);
			}
		}

		for (const sub of gruposElegiveis) {
			const groupObj = await database.getGroup(sub.group_id);
			if (groupObj && groupObj.paused) {
				continue;
			}

			const groupNotified = notifiedByGroup.get(sub.group_id) || new Set();

			const newEpicGames = sub.notificar_epic
				? currentEpicGames.filter((g) => !groupNotified.has(`epic:${g.id}`))
				: [];
			const newSteamGames = sub.notificar_steam
				? currentSteamGames.filter((g) => !groupNotified.has(`steam:${g.id}`)).slice(0, 3)
				: [];

			const sections = [];
			if (newEpicGames.length > 0) {
				sections.push({ label: "Epic", games: newEpicGames });
			}
			if (newSteamGames.length > 0) {
				sections.push({ label: "Steam", games: newSteamGames });
			}

			if (sections.length === 0) continue;

			const messageContent = formatNotificationMessage(sections);
			if (!messageContent) continue;

			const candidateBots = findBotsForGroup(sub.group_id, database, null, groupObj);
			if (candidateBots.length === 0) {
				logger.warn(`[GamingFreebies] Nenhum bot disponível para notificar grupo ${sub.group_id}.`);
				summary.failed++;
				continue;
			}

			let delivered = false;
			for (const bot of candidateBots) {
				try {
					const returnMsg = new ReturnMessage({
						chatId: sub.group_id,
						content: messageContent
					});
					const results = await bot.sendReturnMessages(returnMsg, groupObj);

					const wasSkippedOrErrored =
						Array.isArray(results) &&
						results.length > 0 &&
						results.every((r) => r && (r.skipped || r.error || r.notInGroup));

					if (wasSkippedOrErrored) {
						if (typeof bot.markNotInGroup === "function") {
							await bot.markNotInGroup(sub.group_id);
						}
						continue;
					}

					delivered = true;
					break;
				} catch (botErr) {
					logger.warn(
						`[GamingFreebies] Falha ao enviar via bot ${bot.id} para ${sub.group_id}:`,
						botErr.message
					);
				}
			}

			if (delivered) {
				summary.sent++;
				await database.dbRun(
					DB_NAME,
					"UPDATE free_games_subscriptions SET ultimo_aviso = ?, atualizado_em = ? WHERE group_id = ?",
					[now, now, sub.group_id]
				);

				for (const g of newEpicGames) {
					await database.dbRun(
						DB_NAME,
						"INSERT OR IGNORE INTO free_games_notified (group_id, store, game_id, title, notified_at) VALUES (?, ?, ?, ?, ?)",
						[sub.group_id, "epic", g.id, g.title, now]
					);
				}
				for (const g of newSteamGames) {
					await database.dbRun(
						DB_NAME,
						"INSERT OR IGNORE INTO free_games_notified (group_id, store, game_id, title, notified_at) VALUES (?, ?, ?, ?, ?)",
						[sub.group_id, "steam", g.id, g.title, now]
					);
				}
			} else {
				summary.failed++;
			}
		}

		if (summary.failed > 0 && summary.sent === 0) {
			logger.warn("[GamingFreebies] Falha no envio para todos os grupos elegíveis nesta rodada.");
		}

		logger.info(
			`[GamingFreebies] Ciclo de notificações (${periodoAlvo || "geral"}): ${summary.sent} enviados, ${summary.failed} falhas.`
		);
		return summary;
	} catch (error) {
		logger.error("[GamingFreebies] Erro durante o ciclo de notificações:", error);
		return summary;
	}
}

// Agendador de tarefas em background via node-cron
let cronTasks = [];

function startFreeGamesScheduler() {
	if (
		process.env.NODE_ENV === "test" ||
		process.env.DISABLE_FREE_GAMES_TIMER === "true" ||
		process.env.DISABLE_ACTIVITY === "true"
	) {
		return;
	}

	try {
		const cron = require("node-cron");
		const tz = "America/Sao_Paulo";

		// 09:00 BRT -> Manhã
		const tManha = cron.schedule("0 9 * * *", () => checkAndNotifyFreeGames("manha"), {
			timezone: tz
		});
		// 14:00 BRT -> Tarde
		const tTarde = cron.schedule("0 14 * * *", () => checkAndNotifyFreeGames("tarde"), {
			timezone: tz
		});
		// 20:00 BRT -> Noite
		const tNoite = cron.schedule("0 20 * * *", () => checkAndNotifyFreeGames("noite"), {
			timezone: tz
		});

		cronTasks = [tManha, tTarde, tNoite];
		logger.info(
			"[GamingFreebies] Agendador de notificações de jogos grátis iniciado (09:00, 14:00 e 20:00 BRT)."
		);
	} catch (err) {
		logger.error("[GamingFreebies] Erro ao iniciar agendador:", err.message);
	}
}

function stopFreeGamesScheduler() {
	for (const t of cronTasks) {
		if (t && typeof t.stop === "function") {
			t.stop();
		}
	}
	cronTasks = [];
}

// Inicializa o agendador automaticamente se não estiver em ambiente de teste ou com timer desativado
startFreeGamesScheduler();

// Configuração dos comandos exportados
const commands = [
	new Command({
		name: "0800",
		aliases: ["jogos-free", "giveaways"],
		description: "Mostra jogos grátis e brindes atuais",
		usage: "!0800 [plataforma] ou !jogos-free [plataforma]",
		category: "jogos",
		reactions: {
			after: "🎮"
		},
		method: gamingFreebiesCommand
	}),
	new Command({
		name: "jogos-free",
		aliases: ["0800", "giveaways"],
		description: "Mostra jogos grátis e brindes atuais",
		usage: "!jogos-free [plataforma]",
		category: "jogos",
		reactions: {
			after: "🎮"
		},
		method: gamingFreebiesCommand
	}),
	new Command({
		name: "giveaways",
		description: "Mostra jogos grátis e brindes atuais",
		usage: "!giveaways [plataforma]",
		category: "jogos",
		reactions: {
			after: "🎮"
		},
		method: gamingFreebiesCommand
	}),
	new Command({
		name: "jogos-free-notificar",
		aliases: ["0800-notificar"],
		description: "Ativa ou desativa notificações automáticas de jogos grátis (Steam e Epic Games)",
		usage: "!jogos-free-notificar [steam|epic|todas]",
		category: "jogos",
		adminOnly: true,
		reactions: {
			after: "🔔"
		},
		method: freeGamesNotificarCommand
	}),
	new Command({
		name: "jogos-free-frequencia",
		aliases: ["0800-frequencia"],
		description: "Configura o intervalo e horário das notificações de jogos grátis do grupo",
		usage: "!jogos-free-frequencia [dias] [manha|tarde|noite]",
		category: "jogos",
		adminOnly: true,
		reactions: {
			after: "📅"
		},
		method: freeGamesFrequenciaCommand
	})
];

const helper = {
	about:
		"Consulta e notificações automáticas de jogos grátis disponíveis em plataformas como Steam e Epic Games",
	implementation:
		"Integração com feeds e API GamerPower com curadoria de ofertas, filtros de ARP e envio agendado por grupo",
	tags: "jogos,games,gratis,freebies,epic games,steam,notificacoes,0800",
	cmds: [
		{
			cmd: "!0800",
			desc: "Exibe a lista de jogos gratuitos disponíveis no momento para resgate",
			usage: ["!0800", "!jogos-free", "!jogos-free steam", "!jogos-free epic"],
			category: "jogos"
		},
		{
			cmd: "!jogos-free-notificar",
			desc: "Ativa ou desativa avisos automáticos de jogos grátis no grupo (Steam, Epic ou ambas)",
			usage: ["!jogos-free-notificar", "!jogos-free-notificar epic", "!jogos-free-notificar steam"],
			category: "jogos"
		},
		{
			cmd: "!jogos-free-frequencia",
			desc: "Define a frequência em dias e o turno de envio dos avisos de jogos grátis",
			usage: [
				"!jogos-free-frequencia",
				"!jogos-free-frequencia 7 tarde",
				"!jogos-free-frequencia diario noite",
				"!jogos-free-frequencia manha"
			],
			category: "jogos"
		}
	]
};

/**
 * Consulta jogos grátis e brindes disponíveis atualmente (apenas texto puro, mantido para compatibilidade com LLM)
 * @param {string} [platform] - Plataforma opcional (ex: 'pc', 'steam', 'epic-games-store')
 * @returns {Promise<string>}
 */
async function fetchFreebiesSummary(platform = "") {
	try {
		const platformArg = (platform || "").trim().toLowerCase();
		let giveawaysUrl = `${GIVEAWAYS_URL}?sort-by=popularity`;
		if (platformArg && platformArg !== "all" && platformArg !== "todos") {
			giveawaysUrl += `&platform=${encodeURIComponent(platformArg)}`;
		}

		const [giveawaysResponse, worthResponse] = await Promise.all([
			axios.get(giveawaysUrl, { timeout: REQUEST_TIMEOUT_MS }).catch(() => ({ data: [] })),
			axios.get(WORTH_URL, { timeout: REQUEST_TIMEOUT_MS }).catch(() => ({
				data: { worth_estimation_usd: "0" }
			}))
		]);

		const giveaways = Array.isArray(giveawaysResponse.data) ? giveawaysResponse.data : [];
		const worthData = worthResponse.data;

		if (giveaways.length === 0) {
			return `Nenhum jogo gratuito ou brinde encontrado${platformArg ? ` para a plataforma "${platformArg}"` : ""} no momento.`;
		}

		const validGiveaways = giveaways.filter((item) => !requiresArpPoints(item));
		const games = validGiveaways.filter(isGame);
		const others = validGiveaways.filter((item) => !isGame(item));

		let resultado = `🎮 **Jogos e Brindes Gratuitos Atualmente:**\n\n`;
		if (platformArg && platformArg !== "all") {
			resultado += `📍 Filtro de Plataforma: ${platformArg.toUpperCase()}\n\n`;
		}

		if (games.length > 0) {
			resultado += `🕹️ **Jogos Completos Gratuitos (${games.length}):**\n`;
			for (const g of games.slice(0, 10)) {
				const displayTitle =
					platformArg === "epic" || platformArg === "epic-games-store"
						? cleanEpicTitle(g.title)
						: g.title;
				resultado += `  - **${displayTitle}** (${g.platforms || "PC"})\n`;
				if (g.worth && g.worth !== "N/A") resultado += `    💰 Valor normal: ${g.worth}\n`;
				if (g.open_giveaway_url) resultado += `    🔗 Resgatar: ${g.open_giveaway_url}\n`;
			}
			resultado += `\n`;
		}

		if (others.length > 0) {
			resultado += `🎁 **DLCs, Pacotes e Cupons (${others.length}):**\n`;
			for (const o of others.slice(0, 5)) {
				resultado += `  - **${o.title}** (${o.platforms || "Vários"})\n`;
				if (o.open_giveaway_url) resultado += `    🔗 Resgatar: ${o.open_giveaway_url}\n`;
			}
			resultado += `\n`;
		}

		const rawWorth = worthData?.worth_estimation_usd || worthData?.worth || "0";
		const usdWorth = parseFloat(String(rawWorth).replace("$", "").replace(",", "")) || 0;
		if (usdWorth > 0) {
			const brlWorth = CurrencyConverter.convertToBRL(usdWorth);
			resultado += `💵 **Economia Total Estimada:** ${CurrencyConverter.formatBRL(brlWorth)} (US$ ${usdWorth.toFixed(2)})`;
		}

		return resultado.trim();
	} catch (err) {
		logger.error("Erro ao buscar freebies:", err.message);
		return `Erro ao consultar jogos grátis: ${err.message}`;
	}
}

module.exports = {
	helper,
	commands,
	gamingFreebiesCommand,
	freeGamesNotificarCommand,
	freeGamesFrequenciaCommand,
	fetchFreebiesSummary,
	fetchPlatformGames,
	cleanEpicTitle,
	isGame,
	requiresArpPoints,
	parseWorthUsd,
	formatNotificationMessage,
	findBotsForGroup,
	checkAndNotifyFreeGames,
	startFreeGamesScheduler,
	stopFreeGamesScheduler
};
