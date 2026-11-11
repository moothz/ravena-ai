const axios = require("axios");
const fs = require("fs").promises;
const sharp = require("sharp");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const Database = require("../utils/Database");
const DonorBonusService = require("../services/DonorBonusService");
const GameEventService = require("../services/GameEventService");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
const FishingGame = require("./FishingGame");
const ShadowGardenClient = require("../services/ShadowGardenClient");
const {
	generateAndSaveMarriageImage,
	getMarriagePhoto,
	removeMarriagePhoto
} = require("../utils/WaifuMarriagePhotoHelper");
const AdminUtils = require("../utils/AdminUtils");
const PhoneUtils = require("../utils/PhoneUtils");
const { broadcastToWhatsAppNoticeChannels } = require("../utils/BroadcastHelper");
const {
	editInteractiveMenuMessage,
	formatMenuCommand
} = require("../utils/InteractiveButtonsHelper");
const jardimClient = new ShadowGardenClient();

const database = Database.getInstance();
const adminUtils = AdminUtils.getInstance();
const logger = new Logger("waifu-commands");

// ─── Configurações da API ───────────────────────────────────────────────────
const WAIFULETES_URL = (
	process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030"
).replace(/\/+$/, "");
const WAIFULETES_KEY = process.env.WAIFULETES_API_KEY;
const WAIFULETES_WEB_URL = (process.env.WAIFULETES_WEB_URL || "").replace(/\/+$/, "");

if (!WAIFULETES_KEY) {
	logger.error(
		"WAIFULETES_API_KEY não configurada no .env! Comandos de Waifuletes falharão na autenticação."
	);
}

const api = axios.create({
	baseURL: WAIFULETES_URL,
	headers: {
		Authorization: `Bearer ${WAIFULETES_KEY || ""}`,
		"Content-Type": "application/json"
	},
	timeout: 15000
});

// Janela de claim total: 300 segundos (5 minutos)
const CLAIM_WINDOW_MS = 300 * 1000;

// Novos tempos de reserva por raridade:
// Incomum: 30s | Raro: 60s | Épico: 90s | Lendário: 120s | Comum: 0s
const EXCLUSIVE_CLAIM_WINDOWS = {
	COMMON: 0,
	COMUM: 0,
	UNCOMMON: 30 * 1000,
	INCOMUM: 30 * 1000,
	RARE: 60 * 1000,
	RARO: 60 * 1000,
	EPIC: 90 * 1000,
	EPICO: 90 * 1000,
	ÉPICO: 90 * 1000,
	LEGENDARY: 120 * 1000,
	LENDARIO: 120 * 1000,
	LENDÁRIO: 120 * 1000
};

// Mantido para compatibilidade retroativa de testes
const EXCLUSIVE_CLAIM_WINDOW_MS = 60 * 1000;

/**
 * Retorna o tempo de reserva exclusiva em milissegundos para uma raridade
 * @param {string} rarity
 * @returns {number}
 */
function getExclusiveClaimWindowMs(rarity) {
	if (!rarity) return 0;
	const norm = String(rarity).toUpperCase().trim();
	return EXCLUSIVE_CLAIM_WINDOWS[norm] || 0;
}

// Emojis numéricos para reações e identificadores visuais (1 a 10)
const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const NUMBER_EMOJIS2 = ["1⃣", "2⃣", "3⃣", "4⃣", "5⃣", "6⃣", "7⃣", "8⃣", "9⃣", "🔟"];
const NUMBER_EMOJIS3 = ["1️", "2️", "3️", "4️", "5️", "6️", "7️", "8️", "9️", "10"];

/**
 * Converte emoji numérico (1️⃣ a 🔟) no índice de slot correspondente (1 a 10)
 * @param {string} emoji
 * @returns {number|null}
 */
function getSlotNumberFromEmoji(emoji) {
	if (!emoji || typeof emoji !== "string") return null;
	const clean = emoji.replace(/[\uFE0F\u200D]/g, "");
	if (clean === "🔟" || clean === "10" || clean === "10\u20E3") return 10;
	const match = clean.match(/^([1-9]|10)\u20E3?$/);
	if (match) return parseInt(match[1], 10);
	let idx = NUMBER_EMOJIS.indexOf(emoji);
	if (idx === -1) idx = NUMBER_EMOJIS2.indexOf(emoji);
	if (idx === -1) idx = NUMBER_EMOJIS3.indexOf(emoji);
	return idx !== -1 ? idx + 1 : null;
}

// Cache em memória da janela de claim (300s / 5 min) por grupo
// Map<groupId, { characterId: string, characterName: string, rollerUserId?: string, rollerUserName?: string, exclusiveUntil?: number, expiresAt: number }>
const pendingClaims = new Map();

// Cache em memória de claims ativos por chave `${groupId}:${characterId}`
// Map<string, { characterId: string, groupId: string, rollerUserId?: string, rollerUserName?: string, exclusiveUntil?: number, expiresAt: number }>
const activeClaimsByCharGroup = new Map();

// Histórico dos multi-rolls ainda dentro da janela de claim, por grupo (mais recente no fim).
// Permite casar por número (!mu-c N) com slots de rolagens anteriores, e não só a última.
// Map<groupId, Array<{ isMultiRoll: true, slots: Array<object>, rollerUserId, rollerUserName, expiresAt }>>
const recentMultiRollsByGroup = new Map();
const MAX_RECENT_MULTI_ROLLS = 10;

/**
 * Registra um multi-roll no histórico recente do grupo
 */
function addRecentMultiRoll(groupId, rollData) {
	if (!groupId || !rollData) return;
	const now = Date.now();
	const list = (recentMultiRollsByGroup.get(groupId) || []).filter((r) => r.expiresAt > now);
	list.push(rollData);
	while (list.length > MAX_RECENT_MULTI_ROLLS) list.shift();
	recentMultiRollsByGroup.set(groupId, list);
}

/**
 * Retorna os multi-rolls ainda ativos do grupo, do mais recente para o mais antigo
 */
function getActiveMultiRolls(groupId) {
	const now = Date.now();
	const list = (recentMultiRollsByGroup.get(groupId) || []).filter((r) => r.expiresAt > now);
	if (list.length > 0) {
		recentMultiRollsByGroup.set(groupId, list);
	} else {
		recentMultiRollsByGroup.delete(groupId);
	}
	return [...list].reverse();
}

/**
 * Marca um personagem como casado em todos os multi-rolls ativos do grupo (histórico e mensagens)
 */
function markMultiRollCharacterClaimed(groupId, characterId) {
	if (!groupId || !characterId) return;
	const mark = (slots) => {
		(slots || []).forEach((s) => {
			if (s.characterId === characterId) s.claimed = true;
		});
	};
	(recentMultiRollsByGroup.get(groupId) || []).forEach((r) => mark(r.slots));
	for (const claim of rollClaimsByMsgId.values()) {
		if (claim?.isMultiRoll && claim.groupId === groupId) mark(claim.slots);
	}
}

// Cache em memória de mensagens de roll ativas (por ID de mensagem enviado)
// Map<messageId, { characterId: string, groupId: string, rollerUserId?: string, rollerUserName?: string, exclusiveUntil?: number, expiresAt: number }>
const rollClaimsByMsgId = new Map();
// Histórico para moderação/denúncias (mantém últimos 1000 IDs mesmo após expirar claim)
const rollHistoryByMsgId = new Map();
const MAX_ROLL_HISTORY = 1000;
// Histórico de mensagens de rolls múltiplos para moderação/denúncias
const multiRollHistoryByMsgId = new Map();

// Cache em memória de buscas de personagens por mensagem enviada (para navegação via reações)
// Map<messageId, { characters: Array<{ slot: number, id: string, name: string }>, allResults?: Array<object>, expiresAt: number }>
const charSearchByMsgId = new Map();

/**
 * Registra o mapeamento de resultados de uma busca por ID de mensagem
 * @param {string} messageId
 * @param {object} searchData
 */
function recordCharSearchMessage(messageId, searchData) {
	if (!messageId || !searchData) return;
	const strId = String(messageId);
	const stanzaId = strId.includes("_") ? strId.split("_").pop() : strId;
	const data = {
		...searchData,
		expiresAt: Date.now() + 60 * 60 * 1000 // 1 hora de TTL
	};
	charSearchByMsgId.set(strId, data);
	charSearchByMsgId.set(stanzaId, data);
	if (charSearchByMsgId.size > 1000) {
		const firstKey = charSearchByMsgId.keys().next().value;
		charSearchByMsgId.delete(firstKey);
	}
}

/**
 * Recupera os dados da busca por ID de mensagem
 * @param {string} messageId
 * @returns {object|null}
 */
function getCharSearchByMessageId(messageId) {
	if (!messageId) return null;
	const strId = String(messageId);
	const stanzaId = strId.includes("_") ? strId.split("_").pop() : strId;
	const data = charSearchByMsgId.get(strId) || charSearchByMsgId.get(stanzaId);
	if (!data) return null;
	if (data.expiresAt && Date.now() > data.expiresAt) {
		charSearchByMsgId.delete(strId);
		charSearchByMsgId.delete(stanzaId);
		return null;
	}
	return data;
}

/**
 * Extrai os slots e IDs de personagens de um texto contendo a seção "Outros resultados da busca"
 * @param {string} text
 * @returns {{ characters: Array<{ slot: number, id: string }> } | null}
 */
function extractCharSearchResultsFromText(text) {
	if (!text || typeof text !== "string") return null;
	const dividerIdx = text.indexOf("Outros resultados da busca:");
	if (dividerIdx === -1) return null;
	const searchSection = text.slice(dividerIdx);
	const regex = /(?:^|\n)(\d+)\.\s+.*?\(([^()\s]+)\)/g;
	const characters = [];
	let m;
	while ((m = regex.exec(searchSection)) !== null) {
		characters.push({
			slot: parseInt(m[1], 10),
			id: m[2]
		});
	}
	if (characters.length === 0) return null;
	return { characters };
}

// Inicializa banco de relatórios para mensagens de denúncia
try {
	database.getSQLiteDb(
		"reports",
		`CREATE TABLE IF NOT EXISTS waifu_report_messages (
			message_id TEXT NOT NULL,
			character_id TEXT NOT NULL,
			chat_id TEXT NOT NULL,
			bot_id TEXT,
			text TEXT,
			created_at TEXT NOT NULL,
			PRIMARY KEY (message_id, character_id)
		);
		CREATE INDEX IF NOT EXISTS idx_waifu_report_msgs_char ON waifu_report_messages(character_id);`
	);

	// Migração para tabelas criadas previamente com PRIMARY KEY apenas em message_id
	const tableInfo = database.mappers.get(
		"reports",
		"SELECT sql FROM sqlite_master WHERE type='table' AND name='waifu_report_messages'"
	);
	if (tableInfo?.sql && tableInfo.sql.includes("message_id TEXT PRIMARY KEY")) {
		database.mappers.exec(
			"reports",
			`CREATE TABLE waifu_report_messages_new (
				message_id TEXT NOT NULL,
				character_id TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				bot_id TEXT,
				text TEXT,
				created_at TEXT NOT NULL,
				PRIMARY KEY (message_id, character_id)
			);
			INSERT OR IGNORE INTO waifu_report_messages_new SELECT * FROM waifu_report_messages;
			DROP TABLE waifu_report_messages;
			ALTER TABLE waifu_report_messages_new RENAME TO waifu_report_messages;
			CREATE INDEX IF NOT EXISTS idx_waifu_report_msgs_char ON waifu_report_messages(character_id);`
		);
	}
} catch (e) {
	logger.warn(`Erro ao inicializar/migrar tabela waifu_report_messages: ${e.message}`);
}

/**
 * Extrai o stanzaId limpo de um identificador serializado do WhatsApp
 * @param {string} msgId
 * @returns {string}
 */
function extractStanzaId(msgId) {
	if (!msgId || typeof msgId !== "string") return msgId;
	if (msgId.startsWith("true_") || msgId.startsWith("false_")) {
		const parts = msgId.split("_");
		if (parts.length >= 3) {
			return parts.slice(2).join("_");
		}
	}
	if (msgId.includes("_true_")) {
		return msgId.split("_true_")[1];
	}
	if (msgId.includes("_false_")) {
		return msgId.split("_false_")[1];
	}
	return msgId;
}

/**
 * Registra confirmação de mensagem de denúncia de Waifu enviada ao usuário/grupo
 * @param {string} messageId
 * @param {string} characterId
 * @param {string} chatId
 * @param {string|null} botId
 * @param {string} text
 */
function recordWaifuReportConfirmation(messageId, characterId, chatId, botId = null, text = "") {
	if (!messageId || !characterId) return;
	const stanzaId = extractStanzaId(String(messageId));

	try {
		database.mappers.run(
			"reports",
			`INSERT OR REPLACE INTO waifu_report_messages (message_id, character_id, chat_id, bot_id, text, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				stanzaId,
				String(characterId).toLowerCase().trim(),
				String(chatId),
				botId ? String(botId) : null,
				String(text || ""),
				new Date().toISOString()
			]
		);
	} catch (err) {
		logger.error(
			`Erro ao registrar waifu report confirmation message (${characterId}, ${messageId}): ${err.message}`
		);
	}
}

/**
 * Busca mensagens de denúncia registradas para um personagem
 * @param {string} characterId
 * @returns {Array<{ messageId: string, chatId: string, botId: string|null, text: string }>}
 */
function getWaifuReportConfirmations(characterId) {
	if (!characterId) return [];
	const id = String(characterId).toLowerCase().trim();

	try {
		const rows = database.mappers.all(
			"reports",
			"SELECT message_id, chat_id, bot_id, text FROM waifu_report_messages WHERE LOWER(character_id) = ?",
			[id]
		);
		if (!Array.isArray(rows)) return [];
		return rows.map((r) => ({
			messageId: extractStanzaId(String(r.message_id)),
			chatId: r.chat_id,
			botId: r.bot_id || null,
			text: r.text || ""
		}));
	} catch (err) {
		logger.error(`Erro ao buscar waifu report confirmations (${characterId}): ${err.message}`);
		return [];
	}
}

/**
 * Remove mensagens de denúncia registradas para um personagem após edição
 * @param {string} characterId
 */
function deleteWaifuReportConfirmations(characterId) {
	if (!characterId) return;
	const id = String(characterId).toLowerCase().trim();

	try {
		database.mappers.run(
			"reports",
			"DELETE FROM waifu_report_messages WHERE LOWER(character_id) = ?",
			[id]
		);
	} catch (err) {
		logger.warn(`Erro ao deletar waifu report confirmations (${characterId}): ${err.message}`);
	}
}

/**
 * Registra o ID de uma mensagem enviada de roll associando-o ao personagem (ou personagens) sorteado(s)
 * @param {string} messageId
 * @param {string|Array<object|string>} characterIdOrRolls
 * @param {string} groupId
 * @param {number} [expiresAt]
 * @param {string} [rollerUserId]
 * @param {number} [exclusiveUntil]
 * @param {string} [rollerUserName]
 * @param {Array<object>} [extraRollsData]
 * @param {string} [gridBase64]
 */
function recordRollMessage(
	messageId,
	characterIdOrRolls,
	groupId,
	expiresAt,
	rollerUserId = null,
	exclusiveUntil = null,
	rollerUserName = null,
	extraRollsData = null,
	gridBase64 = null,
	isAvailable = true,
	ownerName = null
) {
	if (!messageId || !characterIdOrRolls) return;
	const strId = String(messageId);
	const stanzaId = strId.includes("_") ? strId.split("_").pop() : strId;

	const isArray = Array.isArray(characterIdOrRolls) || Array.isArray(extraRollsData);
	const rollsList = Array.isArray(characterIdOrRolls)
		? characterIdOrRolls
		: Array.isArray(extraRollsData)
			? extraRollsData
			: null;

	const rawRoller = rollerUserId || null;
	const finalRollerUserId = rawRoller ? normalizeUserId(rawRoller) : null;
	const finalExpiresAt = expiresAt || Date.now() + CLAIM_WINDOW_MS;

	if (isArray && rollsList) {
		const slots = rollsList.map((item, idx) => {
			if (typeof item === "string") {
				return {
					slot: idx + 1,
					characterId: item,
					characterName: item,
					series: "",
					imageUrl: null,
					available: true,
					exclusiveUntil: exclusiveUntil || null,
					claimed: false
				};
			}
			return {
				slot: item.slot || idx + 1,
				characterId: item.characterId || item.id,
				characterName: item.characterName || item.name || item.id,
				series: item.series || "",
				imageUrl: item.imageUrl || null,
				rarity: item.rarity || item.baseRarity || "COMMON",
				available: item.available !== false,
				exclusiveUntil: item.exclusiveUntil || null,
				claimed: Boolean(item.claimed),
				rollerUserId: finalRollerUserId,
				rollerUserName
			};
		});

		const primaryCharId = slots[0]?.characterId || "multi";

		const claimData = {
			isMultiRoll: true,
			characterId: primaryCharId,
			characters: slots,
			slots,
			groupId,
			rollerUserId: finalRollerUserId,
			rollerUserName,
			exclusiveUntil,
			expiresAt: finalExpiresAt,
			gridBase64: gridBase64 || null
		};

		rollClaimsByMsgId.set(strId, claimData);
		rollClaimsByMsgId.set(stanzaId, claimData);

		multiRollHistoryByMsgId.set(strId, claimData);
		multiRollHistoryByMsgId.set(stanzaId, claimData);
		if (multiRollHistoryByMsgId.size > 800) {
			const firstKey = multiRollHistoryByMsgId.keys().next().value;
			multiRollHistoryByMsgId.delete(firstKey);
		}

		rollHistoryByMsgId.set(strId, primaryCharId);
		rollHistoryByMsgId.set(stanzaId, primaryCharId);

		// Registra também cada personagem nos claims ativos do grupo
		slots.forEach((s) => {
			if (s.characterId) {
				const charClaim = {
					isMultiRoll: true,
					characterId: s.characterId,
					characterName: s.characterName,
					groupId,
					rollerUserId: finalRollerUserId,
					rollerUserName,
					exclusiveUntil: s.exclusiveUntil,
					expiresAt: finalExpiresAt
				};
				activeClaimsByCharGroup.set(`${groupId}:${s.characterId}`, charClaim);
			}
		});

		if (rollHistoryByMsgId.size > MAX_ROLL_HISTORY * 2) {
			const firstKey = rollHistoryByMsgId.keys().next().value;
			rollHistoryByMsgId.delete(firstKey);
		}
		return;
	}

	// Single roll
	const characterId =
		typeof characterIdOrRolls === "string"
			? characterIdOrRolls
			: characterIdOrRolls?.characterId || characterIdOrRolls?.id;
	const existing = activeClaimsByCharGroup.get(`${groupId}:${characterId}`);
	const finalExclusiveUntil = exclusiveUntil ?? existing?.exclusiveUntil ?? null;
	const finalRollerName = rollerUserName || existing?.rollerUserName || null;

	const claimData = {
		isMultiRoll: false,
		characterId,
		groupId,
		available: isAvailable !== false,
		owner: ownerName || null,
		rollerUserId:
			finalRollerUserId || (existing?.rollerUserId ? normalizeUserId(existing.rollerUserId) : null),
		rollerUserName: finalRollerName,
		exclusiveUntil: finalExclusiveUntil,
		expiresAt: expiresAt || existing?.expiresAt || Date.now() + CLAIM_WINDOW_MS
	};
	rollClaimsByMsgId.set(strId, claimData);
	rollClaimsByMsgId.set(stanzaId, claimData);

	rollHistoryByMsgId.set(strId, characterId);
	rollHistoryByMsgId.set(stanzaId, characterId);
	if (rollHistoryByMsgId.size > MAX_ROLL_HISTORY * 2) {
		const firstKey = rollHistoryByMsgId.keys().next().value;
		rollHistoryByMsgId.delete(firstKey);
	}
}

/**
 * Busca dados do roll por ID da mensagem (se não estiver expirado)
 * @param {string} messageId
 * @returns {{ characterId: string, groupId: string, rollerUserId?: string, rollerUserName?: string, exclusiveUntil?: number, expiresAt: number } | null}
 */
function getRollByMessageId(messageId) {
	if (!messageId) return null;
	const strId = String(messageId);
	const stanzaId = strId.includes("_") ? strId.split("_").pop() : strId;

	const claimData = rollClaimsByMsgId.get(strId) || rollClaimsByMsgId.get(stanzaId);
	if (claimData) {
		if (Date.now() > claimData.expiresAt) {
			rollClaimsByMsgId.delete(strId);
			rollClaimsByMsgId.delete(stanzaId);
			return null;
		}
		return claimData;
	}
	return null;
}

/**
 * Busca dados de roll múltiplo por ID da mensagem (em cache ativo ou histórico de moderação)
 * @param {string} messageId
 * @returns {object|null}
 */
function getMultiRollByMessageId(messageId) {
	if (!messageId) return null;
	const strId = String(messageId);
	const stanzaId = strId.includes("_") ? strId.split("_").pop() : strId;

	const claim = rollClaimsByMsgId.get(strId) || rollClaimsByMsgId.get(stanzaId);
	if (claim?.isMultiRoll || (claim?.slots && claim.slots.length > 1)) {
		return claim;
	}

	const hist = multiRollHistoryByMsgId.get(strId) || multiRollHistoryByMsgId.get(stanzaId);
	if (hist?.isMultiRoll || (hist?.slots && hist.slots.length > 1)) {
		return hist;
	}

	return null;
}

/**
 * Busca ID do personagem associado a uma mensagem de roll (para moderação e denúncias)
 * @param {string} messageId
 * @returns {string|null}
 */
function getCharacterIdFromMessageId(messageId) {
	if (!messageId) return null;
	const strId = String(messageId);
	const stanzaId = strId.includes("_") ? strId.split("_").pop() : strId;

	const claimData = rollClaimsByMsgId.get(strId) || rollClaimsByMsgId.get(stanzaId);
	if (claimData?.characterId) return claimData.characterId;

	return rollHistoryByMsgId.get(strId) || rollHistoryByMsgId.get(stanzaId) || null;
}

// Mapeamentos visuais de Raridade
const RARITY_EMOJI = {
	COMMON: "⚪",
	UNCOMMON: "🟢",
	RARE: "🔵",
	EPIC: "🟣",
	LEGENDARY: "⭐",
	MYTHIC: "🔮"
};

const RARITY_LABEL = {
	COMMON: "Comum",
	UNCOMMON: "Incomum",
	RARE: "Raro",
	EPIC: "Épico",
	LEGENDARY: "Lendário",
	MYTHIC: "Mítico"
};

const RARITY_LABEL_PLURAL = {
	COMMON: "Comuns",
	UNCOMMON: "Incomuns",
	RARE: "Raros",
	EPIC: "Épicos",
	LEGENDARY: "Lendários",
	MYTHIC: "Míticos"
};

// Limite máximo de itens na Wishlist
const WISHLIST_MAX_ITEMS = 1000;

// Pesos base de cada raridade no sorteio (RollService)
const RARITY_WEIGHTS = {
	COMMON: 100,
	UNCOMMON: 60,
	RARE: 25,
	EPIC: 8,
	LEGENDARY: 2.5
};

// Cache de estatísticas e probabilidades de drop
let cachedDropStats = null;
let cachedDropStatsAt = 0;
const DROP_STATS_CACHE_TTL = 15 * 60 * 1000; // 15 minutos

async function getUserWishlistStats(userId, totalWeight, donorBonuses = null) {
	try {
		const { data } = await api.get(`/wishlist/${userId}`);
		const wishlist = data?.data || [];
		if (wishlist.length === 0) {
			return {
				count: 0,
				maxItems: WISHLIST_MAX_ITEMS,
				totalWishWeight: 0,
				anyWishChance: 0,
				oneInX: null
			};
		}

		let totalWishWeight = 0;
		let legWishWeight = 0;
		const defaultWishMult = donorBonuses?.wishlistMultiplier || 1.5;
		const defaultStarMult = donorBonuses?.wishlistMultiplier
			? donorBonuses.wishlistMultiplier * (2.0 / 1.5)
			: 2.0;

		for (const item of wishlist) {
			const char = item.character;
			const r = char?.baseRarity || char?.rarity || "COMMON";
			const baseW = RARITY_WEIGHTS[r] || 100;

			let itemWeight;
			if (donorBonuses) {
				const rMult = donorBonuses.rarityMultipliers?.[r] || 1.0;
				const wMult = item.isStarWish ? defaultStarMult : defaultWishMult;
				if (r === "LEGENDARY") {
					// Desacoplamento para Lendários conforme Waifuletes
					const combinedMult = Math.max(1.0, rMult + Math.max(0, wMult - 1.0));
					itemWeight = Math.max(1, Math.round(baseW * combinedMult));
					legWishWeight += itemWeight;
				} else {
					itemWeight = Math.max(1, Math.round(baseW * rMult * wMult));
				}
			} else {
				const multiplier = item.isStarWish ? 2.0 : 1.5;
				itemWeight = Math.max(1, Math.round(baseW * multiplier));
				if (r === "LEGENDARY") {
					legWishWeight += itemWeight;
				}
			}
			totalWishWeight += itemWeight;
		}

		// Cap de 0.80% para Lendários no roll caso o peso de Lendários na Wishlist supere o teto
		if (totalWeight > 0 && legWishWeight > 0) {
			const maxLegAllowed = totalWeight * 0.008; // 0.80% cap
			if (legWishWeight > maxLegAllowed) {
				totalWishWeight -= legWishWeight - maxLegAllowed;
			}
		}

		const anyWishChance =
			totalWeight > 0 ? Math.min(100, (totalWishWeight / totalWeight) * 100) : 0;
		return {
			count: wishlist.length,
			maxItems: WISHLIST_MAX_ITEMS,
			totalWishWeight,
			anyWishChance,
			oneInX: totalWishWeight > 0 ? Math.round(totalWeight / totalWishWeight) : null
		};
	} catch (_) {
		return null;
	}
}

async function getDropRateStats(userId = null, forceRefresh = false) {
	const now = Date.now();
	if (!forceRefresh && cachedDropStats && now - cachedDropStatsAt < DROP_STATS_CACHE_TTL) {
		if (userId) {
			const userWishlistStats = await getUserWishlistStats(userId, cachedDropStats.totalWeight);
			return { ...cachedDropStats, userWishlistStats };
		}
		return cachedDropStats;
	}

	try {
		// 1. Tenta endpoint direto /characters/stats
		const params = userId ? { userId } : {};
		const { data } = await api.get("/characters/stats", { params, timeout: 5000 });
		if (data?.success && data?.data) {
			cachedDropStats = data.data;
			cachedDropStatsAt = now;
			return data.data;
		}
	} catch (_) {
		// Fallback para cálculo dinâmico
	}

	// 2. Fallback dinâmico: busca contagens por raridade
	try {
		const rarities = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"];
		const counts = {};
		await Promise.all(
			rarities.map(async (r) => {
				try {
					const res = await api.get(`/characters?rarity=${r}&limit=1`, { timeout: 4000 });
					counts[r] = res.data?.data?.total ?? 0;
				} catch (_) {
					counts[r] = { COMMON: 23974, UNCOMMON: 2393, RARE: 837, EPIC: 220, LEGENDARY: 56 }[r];
				}
			})
		);

		const totalCharacters = Object.values(counts).reduce((a, b) => a + b, 0);
		let totalWeight = 0;
		for (const r of rarities) {
			totalWeight += counts[r] * (RARITY_WEIGHTS[r] || 100);
		}

		const breakdown = rarities.map((r) => {
			const count = counts[r];
			const baseWeight = RARITY_WEIGHTS[r] || 100;
			const categoryWeight = count * baseWeight;
			const categoryChance = totalWeight > 0 ? (categoryWeight / totalWeight) * 100 : 0;
			const singleBaseChance = totalWeight > 0 ? (baseWeight / totalWeight) * 100 : 0;
			const singleWishChance =
				totalWeight > 0 ? (Math.round(baseWeight * 1.5) / totalWeight) * 100 : 0;
			const singleStarWishChance =
				totalWeight > 0 ? (Math.round(baseWeight * 2.0) / totalWeight) * 100 : 0;

			return {
				rarity: r,
				count,
				percentOfTotal: totalCharacters > 0 ? (count / totalCharacters) * 100 : 0,
				baseWeight,
				categoryWeight,
				categoryChance,
				oneInX: categoryWeight > 0 ? Math.round(totalWeight / categoryWeight) : null,
				singleBaseChance,
				singleBaseOneInX: baseWeight > 0 ? Math.round(totalWeight / baseWeight) : null,
				singleWishChance,
				singleWishOneInX:
					baseWeight > 0 ? Math.round(totalWeight / Math.round(baseWeight * 1.5)) : null,
				singleStarWishChance,
				singleStarWishOneInX:
					baseWeight > 0 ? Math.round(totalWeight / Math.round(baseWeight * 2.0)) : null
			};
		});

		let userWishlistStats = null;
		if (userId) {
			userWishlistStats = await getUserWishlistStats(userId, totalWeight);
		}

		const result = {
			totalCharacters,
			totalWeight,
			wishlistMaxItems: WISHLIST_MAX_ITEMS,
			breakdown,
			userWishlistStats
		};

		cachedDropStats = result;
		cachedDropStatsAt = now;
		return result;
	} catch (e) {
		logger.error("Erro ao calcular drop stats:", e);
		return null;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeUserId(id) {
	if (!id || typeof id !== "string") return "";
	return id.split("@")[0].split(":")[0];
}

function toJid(id) {
	if (!id || typeof id !== "string") return "";
	return id.includes("@") ? id : `${id}@s.whatsapp.net`;
}

/**
 * Obtém a lista de participantes de um grupo usando múltiplos fallbacks
 * @param {Object} bot
 * @param {Object} message
 * @param {string} groupId
 * @returns {Promise<Array|null>}
 */
async function getGroupParticipants(bot, message, groupId) {
	if (!groupId) return null;

	if (Array.isArray(message?.groupParticipants) && message.groupParticipants.length > 0) {
		return message.groupParticipants;
	}
	if (Array.isArray(message?.chat?.participants) && message.chat.participants.length > 0) {
		return message.chat.participants;
	}

	let chat = null;
	if (message?.origin && typeof message.origin.getChat === "function") {
		try {
			chat = await message.origin.getChat();
		} catch (e) {
			logger.debug(`[getGroupParticipants] Erro em message.origin.getChat: ${e.message}`);
		}
	}
	if (!chat && bot?.client && typeof bot.client.getChatById === "function") {
		try {
			chat = await bot.client.getChatById(groupId);
		} catch (e) {
			logger.debug(`[getGroupParticipants] Erro em bot.client.getChatById: ${e.message}`);
		}
	}
	if (!chat && bot && typeof bot.getChatDetails === "function") {
		try {
			chat = await bot.getChatDetails(groupId);
		} catch (e) {
			logger.debug(`[getGroupParticipants] Erro em bot.getChatDetails: ${e.message}`);
		}
	}
	if (!chat && bot?.client && typeof bot.client.getChatDetails === "function") {
		try {
			chat = await bot.client.getChatDetails(groupId);
		} catch (e) {
			logger.debug(`[getGroupParticipants] Erro em bot.client.getChatDetails: ${e.message}`);
		}
	}

	const participants =
		chat?.participants ||
		chat?.Participants ||
		chat?._rawGroup?.participants ||
		chat?._rawGroup?.Participants;

	if (Array.isArray(participants) && participants.length > 0) {
		return participants;
	}
	return null;
}

/**
 * Verifica se um usuário está presente na lista de participantes ativos do grupo
 * @param {string} targetUserId
 * @param {Array|null} participants
 * @returns {boolean}
 */
function isUserActiveInGroup(targetUserId, participants) {
	if (!participants || !Array.isArray(participants) || participants.length === 0) {
		// Se não foi possível obter os participantes atuais, não filtra por padrão
		return true;
	}
	const normTarget = normalizeUserId(targetUserId);
	const cleanTarget = PhoneUtils.cleanPhone(targetUserId);
	if (!normTarget && !cleanTarget) return false;

	return participants.some((p) => {
		if (typeof p === "string") {
			const pNorm = normalizeUserId(p);
			if (normTarget && pNorm === normTarget) return true;
			if (cleanTarget && PhoneUtils.isSamePhone(p, cleanTarget)) return true;
			return false;
		}
		if (p && typeof p === "object") {
			const candidateFields = [
				p.PhoneNumber,
				p.phoneNumber,
				p.JID,
				p.jid,
				p.id?._serialized,
				p.id,
				p.lid,
				p.LID
			];
			if (normTarget) {
				for (const field of candidateFields) {
					if (field && normalizeUserId(field) === normTarget) return true;
				}
			}
			if (cleanTarget && PhoneUtils.matchesParticipant(p, cleanTarget)) {
				return true;
			}
		}
		return false;
	});
}

function getUserId(message) {
	const rawId = message?.originReaction?.senderId || message?.author;
	return normalizeUserId(rawId);
}

/**
 * Extrai o 1º mention do comando (via message.mentions, args ou quoted)
 * @param {Object} message - Objeto da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {string} [botWid] - Wid do bot para ignorar citação do próprio bot
 * @returns {string|null} ID normalizado do usuário alvo ou null
 */
function extractFirstMention(message, args, botWid = null) {
	let targetJid = null;

	const rawMentions =
		Array.isArray(message.mentions) && message.mentions.length > 0
			? message.mentions
			: Array.isArray(message.origin?.mentionedIds) && message.origin.mentionedIds.length > 0
				? message.origin.mentionedIds
				: [];

	if (rawMentions.length > 0) {
		targetJid = rawMentions[0];
	}

	const mentionArg = Array.isArray(args)
		? args.find((a) => typeof a === "string" && a.startsWith("@"))
		: null;

	if (mentionArg) {
		const cleanDigits = mentionArg.replace(/^@/, "").replace(/\D/g, "");
		if (!targetJid && cleanDigits.length >= 7) {
			targetJid = `${cleanDigits}@s.whatsapp.net`;
		}
	}

	if (!targetJid) {
		const quotedParticipant =
			message.quotedMsg?.author ||
			message.quotedMsg?.participant ||
			message.origin?.quotedMsg?.author ||
			message.origin?.quotedMsg?.participant ||
			message.origin?._data?.quotedParticipant;
		if (quotedParticipant) {
			const botJid = botWid || message.originBotWid;
			if (!botJid || normalizeUserId(quotedParticipant) !== normalizeUserId(botJid)) {
				targetJid = quotedParticipant;
			}
		}
	}

	return targetJid ? normalizeUserId(targetJid) : null;
}

/**
 * Resolve um personagem por ID exato, slug ou busca por nome no catálogo
 * @param {string} query - Termo de busca ou ID
 * @returns {Promise<Object|null>} Personagem encontrado ou null
 */
async function resolveCharacter(query) {
	if (!query || typeof query !== "string") return null;
	const trimmed = query.trim();
	if (!trimmed) return null;

	// 1. Busca direta por ID/slug exato se não contiver espaços
	if (!/\s/.test(trimmed)) {
		try {
			const { data } = await api.get(`/characters/${encodeURIComponent(trimmed)}`);
			if (data?.data) return data.data;
		} catch (_) {}
	}

	// 2. Busca ampla no catálogo
	try {
		const { data } = await api.get("/characters", {
			params: { search: trimmed, limit: 6 }
		});
		const results = data.data?.data || [];
		if (results.length > 0) {
			const normQ = trimmed.toLowerCase();
			const exactId = results.find((c) => c.id?.toLowerCase() === normQ);
			const exactName = results.find((c) => c.name?.toLowerCase() === normQ);
			const startsName = results.find((c) => c.name?.toLowerCase().startsWith(normQ));
			return exactId || exactName || startsName || results[0];
		}
	} catch (_) {}

	return null;
}

function getGroupId(message) {
	return message.group ?? message.author;
}

async function getUserName(message, group = null) {
	const rawFallback =
		message?.originReaction?.userName ||
		message.authorName ||
		(message?.originReaction?.senderId ? message.originReaction.senderId.split("@")[0] : null) ||
		(message.author ? message.author.split("@")[0] : "Jogador");
	const userId = getUserId(message);
	let targetGroup = group;
	if (!targetGroup && message.group) {
		try {
			const Database = require("../utils/Database");
			targetGroup = await Database.getInstance().getGroup(message.group);
		} catch (_) {}
	}
	try {
		const { resolveUserNickname } = require("./GeneralCommands");
		return await resolveUserNickname(targetGroup, userId, rawFallback);
	} catch (_) {
		return rawFallback;
	}
}

async function ensureUser(userId, groupId, name) {
	try {
		await api.post("/user/ensure", {
			userId,
			groupId,
			name,
			platform: "WHATSAPP"
		});
	} catch (e) {
		logger.debug("Tentativa de auto-cadastro ensureUser:", e.message);
	}
}

function formatRemainingSeconds(seconds) {
	if (!seconds || seconds <= 0) return "0s";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}h ${m}min`;
	if (m > 0) return `${m}min ${s}s`;
	return `${s}s`;
}

function formatTimeBR(date, options = {}) {
	if (!date || isNaN(new Date(date).getTime())) return "";
	return new Date(date).toLocaleTimeString("pt-BR", {
		timeZone: "America/Sao_Paulo",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		...options
	});
}

function formatDateTimeBR(date, options = {}) {
	if (!date || isNaN(new Date(date).getTime())) return "";
	return new Date(date).toLocaleString("pt-BR", {
		timeZone: "America/Sao_Paulo",
		hour12: false,
		...options
	});
}

/**
 * Monta o link público da página do personagem no portal web do Waifuletes
 * @param {string} characterId
 * @returns {string|null} URL completa ou null se WAIFULETES_WEB_URL não estiver configurada
 */
function getCharacterWebUrl(characterId) {
	if (!WAIFULETES_WEB_URL || !characterId) return null;
	return `${WAIFULETES_WEB_URL}/character/${encodeURIComponent(String(characterId).trim())}`;
}

/**
 * Escapa caracteres especiais para inserção segura em XML / SVG
 * @param {string} str
 * @returns {string}
 */
function escapeXml(str) {
	if (!str) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Resolve e normaliza a URL da imagem de waifu para acessar diretamente a API interna
 * @param {string} imageUrl
 * @returns {string|null} URL resolvida ou null se for imagem inválida/placeholder inexistente
 */
function resolveWaifuImageUrl(imageUrl) {
	if (!imageUrl || typeof imageUrl !== "string") return null;
	const trimmed = imageUrl.trim();
	if (!trimmed || trimmed.toLowerCase().includes("none.png")) {
		return null;
	}

	try {
		// Se for caminho relativo (ex: /media/characters/... ou media/characters/...)
		if (trimmed.startsWith("/")) {
			const cleanPath = trimmed.replace(/^\/+/, "");
			return `${WAIFULETES_URL}/${cleanPath}`;
		}

		const parsed = new URL(trimmed);
		let webHost = null;
		if (WAIFULETES_WEB_URL) {
			try {
				webHost = new URL(WAIFULETES_WEB_URL).host;
			} catch {
				// ignore
			}
		}

		// Se a URL apontar para o domínio web configurado, localhost, 127.0.0.1 ou host.docker.internal
		if (
			parsed.hostname === "localhost" ||
			parsed.hostname === "127.0.0.1" ||
			parsed.hostname === "host.docker.internal" ||
			(webHost && parsed.host === webHost)
		) {
			const cleanPath = parsed.pathname.replace(/^\/+/, "");
			return `${WAIFULETES_URL}/${cleanPath}${parsed.search}`;
		}

		return trimmed;
	} catch {
		// Se falhar o parse da URL, tenta normalizar como caminho relativo
		const cleanPath = trimmed.replace(/^https?:\/\/[^/]+\/?/, "").replace(/^\/+/, "");
		return `${WAIFULETES_URL}/${cleanPath}`;
	}
}

/**
 * Baixa o buffer binário da imagem do personagem
 * @param {string} imageUrl
 * @returns {Promise<Buffer|null>}
 */
async function downloadImageBuffer(imageUrl) {
	const resolvedUrl = resolveWaifuImageUrl(imageUrl);
	if (!resolvedUrl) return null;
	try {
		const response = await axios.get(resolvedUrl, {
			responseType: "arraybuffer",
			timeout: 10000
		});
		return Buffer.from(response.data);
	} catch (err) {
		logger.warn(`Falha ao baixar imagem de waifu (${imageUrl}):`, err.message);
		return null;
	}
}

/**
 * Baixa a imagem do personagem pela porta exposta da API e retorna em Base64
 * @param {string} imageUrl
 * @returns {Promise<string|null>}
 */
async function downloadImageAsBase64(imageUrl) {
	const buf = await downloadImageBuffer(imageUrl);
	return buf ? buf.toString("base64") : null;
}

/**
 * Gera um cartão visual (Buffer JPEG) para personagem quando não há imagem cadastrada
 * @param {object} character
 * @returns {Promise<Buffer>}
 */
async function generateSingleRollPlaceholderBuffer(character) {
	if (!character) return null;
	const cardW = 500;
	const cardH = 700;

	const rawRarity = String(character.rarity || character.baseRarity || "COMMON")
		.toUpperCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");

	let rarityKey = "COMMON";
	let rarityLabel = "COMUM";
	if (rawRarity.includes("LEGEND") || rawRarity.includes("LEND")) {
		rarityKey = "LEGENDARY";
		rarityLabel = "LENDÁRIO";
	} else if (rawRarity.includes("EPIC")) {
		rarityKey = "EPIC";
		rarityLabel = "ÉPICO";
	} else if (rawRarity.includes("RAR")) {
		rarityKey = "RARE";
		rarityLabel = "RARO";
	} else if (rawRarity.includes("INCOM") || rawRarity.includes("UNCOM")) {
		rarityKey = "UNCOMMON";
		rarityLabel = "INCOMUM";
	}

	const style = GRID_RARITY_STYLES[rarityKey] || GRID_RARITY_STYLES.COMMON;
	const charName = escapeXml(
		String(character.characterName || character.name || "Personagem").substring(0, 26)
	);
	const charSeries = escapeXml(String(character.series || "Sem Série").substring(0, 30));
	const genderEmoji = character.gender === "FEMALE" ? "♀" : character.gender === "MALE" ? "♂" : "⚧";

	const cardSvg = Buffer.from(`
		<svg width="${cardW}" height="${cardH}" xmlns="http://www.w3.org/2000/svg">
			<defs>
				<linearGradient id="bgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
					<stop offset="0%" stop-color="#1e212b"/>
					<stop offset="100%" stop-color="#0f1117"/>
				</linearGradient>
			</defs>
			<rect width="${cardW}" height="${cardH}" rx="16" fill="url(#bgGrad)" stroke="${style.stroke}" stroke-width="4"/>
			
			<circle cx="${cardW / 2}" cy="250" r="105" fill="#282b36" stroke="${style.stroke}" stroke-width="2"/>
			<text x="${cardW / 2}" y="270" font-size="80" text-anchor="middle" dominant-baseline="central" fill="${style.stroke}">👤</text>
			
			<rect x="${(cardW - 200) / 2}" y="36" width="200" height="42" rx="10" fill="${style.bg}" stroke="${style.stroke}" stroke-width="2"/>
			<text x="${cardW / 2}" y="58" font-size="20" font-weight="bold" text-anchor="middle" dominant-baseline="central" fill="${style.textColor}" font-family="DejaVu Sans, Arial, sans-serif">★ ${rarityLabel} ★</text>

			<text x="${cardW / 2}" y="435" font-size="28" font-weight="bold" text-anchor="middle" fill="#FFFFFF" font-family="DejaVu Sans, Arial, sans-serif">${charName}</text>
			<text x="${cardW / 2}" y="480" font-size="20" text-anchor="middle" fill="#9CA3AF" font-family="DejaVu Sans, Arial, sans-serif">${charSeries}</text>
			<text x="${cardW / 2}" y="520" font-size="18" text-anchor="middle" fill="${style.stroke}" font-family="DejaVu Sans, Arial, sans-serif">Gênero: ${genderEmoji}</text>

			<rect x="50" y="605" width="${cardW - 100}" height="42" rx="8" fill="#181a21" stroke="#374151" stroke-width="1"/>
			<text x="${cardW / 2}" y="626" font-size="15" text-anchor="middle" dominant-baseline="central" fill="#9CA3AF" font-family="DejaVu Sans, Arial, sans-serif">Foto indisponível no catálogo</text>
		</svg>
	`);

	return await sharp(cardSvg).jpeg({ quality: 85 }).toBuffer();
}

// Estilos visuais de badges numéricos no grid por Raridade
const GRID_RARITY_STYLES = {
	COMMON: {
		bg: "rgba(35, 39, 47, 0.92)",
		stroke: "#9CA3AF",
		strokeWidth: 2,
		textColor: "#FFFFFF",
		badgeW: 56,
		badgeH: 42,
		fontSize: 28,
		rx: 9
	},
	UNCOMMON: {
		bg: "rgba(16, 120, 60, 0.94)",
		stroke: "#6EE7B7",
		strokeWidth: 2.5,
		textColor: "#FFFFFF",
		badgeW: 66,
		badgeH: 48,
		fontSize: 34,
		rx: 11
	},
	RARE: {
		bg: "rgba(29, 78, 216, 0.95)",
		stroke: "#93C5FD",
		strokeWidth: 3,
		textColor: "#FFFFFF",
		badgeW: 76,
		badgeH: 54,
		fontSize: 40,
		rx: 13
	},
	EPIC: {
		bg: "rgba(126, 34, 206, 0.95)",
		stroke: "#E9D5FF",
		strokeWidth: 3.5,
		textColor: "#FFFFFF",
		badgeW: 86,
		badgeH: 62,
		fontSize: 46,
		rx: 15
	},
	LEGENDARY: {
		bg: "rgba(217, 119, 6, 0.96)",
		stroke: "#FEF08A",
		strokeWidth: 4,
		textColor: "#FFFFFF",
		badgeW: 98,
		badgeH: 70,
		fontSize: 52,
		rx: 18
	},
	MYTHIC: {
		bg: "rgba(147, 51, 234, 0.96)", // Púrpura Mágico / Violeta Fluorescente (#9333ea)
		stroke: "#c084fc", // Púrpura Fluorescente (#a855f7 / #c084fc)
		strokeWidth: 4,
		textColor: "#FFFFFF",
		badgeW: 104,
		badgeH: 72,
		fontSize: 52,
		rx: 18
	}
};

/**
 * Constrói o grid de imagens unindo as fotos dos personagens com seu badge numérico
 * Layouts (Linhas x Colunas):
 * - 2: 1x2
 * - 3: 1x3
 * - 4: 2x2
 * - 5: 2x3 (quadrado central deslocado para o meio, face 5 de um dado de 6 lados)
 * - 6: 2x3
 * - 7: 3x3 (quadrado central deslocado para o meio como o 5)
 * - 8: 3x3 (quadrado central sem nada)
 * - 9: 3x3
 * @param {Array<{ slot: number, character: object, imageBuffer: Buffer|null }>} items
 * @returns {Promise<Buffer>}
 */
async function buildRollGridImage(items) {
	const count = items.length;
	const cellW = 320;
	const cellH = 320;

	const preparedCells = await Promise.all(
		items.map(async (item, idx) => {
			const slot = item.slot || idx + 1;

			const rawRarity = String(
				item.character?.rarity || item.character?.baseRarity || item.rarity || "COMMON"
			)
				.toUpperCase()
				.normalize("NFD")
				.replace(/[\u0300-\u036f]/g, "");

			const isMythic = Boolean(
				item.character?.isMythic ||
				item.isMythic ||
				rawRarity.includes("MYTH") ||
				rawRarity.includes("MITIC")
			);

			let rarityKey = "COMMON";
			if (isMythic) {
				rarityKey = "MYTHIC";
			} else if (rawRarity.includes("LEGEND") || rawRarity.includes("LEND")) {
				rarityKey = "LEGENDARY";
			} else if (rawRarity.includes("EPIC")) {
				rarityKey = "EPIC";
			} else if (rawRarity.includes("RAR")) {
				rarityKey = "RARE";
			} else if (rawRarity.includes("INCOM") || rawRarity.includes("UNCOM")) {
				rarityKey = "UNCOMMON";
			}

			const style = GRID_RARITY_STYLES[rarityKey] || GRID_RARITY_STYLES.COMMON;
			const isRollerWishlist = Boolean(item.character?.isWishlist || item.isWishlist);
			const badgeW = isMythic
				? Math.max(style.badgeW + 40, 110)
				: isRollerWishlist
					? Math.max(style.badgeW + 60, 116)
					: style.badgeW;
			const badgeH = style.badgeH;
			const fontSize =
				isMythic || isRollerWishlist
					? Math.max(22, Math.round(style.fontSize * 0.76))
					: style.fontSize;
			const badgeTop = cellH - badgeH - 12;
			const badgeLeft = Math.floor((cellW - badgeW) / 2);
			const badgeText = isMythic ? `🔮 ${slot} 🔮` : isRollerWishlist ? `⭐ ${slot} ⭐` : `${slot}`;

			const badgeSvg = Buffer.from(`
				<svg width="${badgeW}" height="${badgeH}" xmlns="http://www.w3.org/2000/svg">
					<rect width="${badgeW}" height="${badgeH}" rx="${style.rx}" fill="${style.bg}" stroke="${style.stroke}" stroke-width="${style.strokeWidth}"/>
					<text x="${badgeW / 2}" y="${badgeH / 2}" font-size="${fontSize}" font-weight="bold" text-anchor="middle" dominant-baseline="central" fill="${style.textColor}" font-family="DejaVu Sans, Arial, sans-serif">${badgeText}</text>
				</svg>
			`);

			let baseImageBuffer = item.imageBuffer;
			if (!baseImageBuffer) {
				const charName = escapeXml(
					String(item.character?.characterName || item.character?.name || "Personagem").substring(
						0,
						20
					)
				);
				const charSeries = escapeXml(String(item.character?.series || "").substring(0, 22));
				const placeholderSvg = Buffer.from(`
					<svg width="${cellW}" height="${cellH}" xmlns="http://www.w3.org/2000/svg">
						<rect width="${cellW}" height="${cellH}" fill="#1e212b"/>
						<text x="${cellW / 2}" y="${cellH / 2 - 15}" font-size="20" font-weight="bold" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${charName}</text>
						<text x="${cellW / 2}" y="${cellH / 2 + 15}" font-size="14" text-anchor="middle" fill="#aaaaaa" font-family="sans-serif">${charSeries}</text>
					</svg>
				`);
				baseImageBuffer = await sharp(placeholderSvg).png().toBuffer();
			}

			return await sharp(baseImageBuffer)
				.resize(cellW, cellH, { fit: "cover", position: "top" })
				.composite([{ input: badgeSvg, top: badgeTop, left: badgeLeft }])
				.png()
				.toBuffer();
		})
	);

	let canvasW = cellW;
	let canvasH = cellH;
	const overlays = [];

	if (count === 2) {
		canvasW = 2 * cellW;
		canvasH = cellH;
		overlays.push({ input: preparedCells[0], left: 0, top: 0 });
		overlays.push({ input: preparedCells[1], left: cellW, top: 0 });
	} else if (count === 3) {
		canvasW = 3 * cellW;
		canvasH = cellH;
		overlays.push({ input: preparedCells[0], left: 0, top: 0 });
		overlays.push({ input: preparedCells[1], left: cellW, top: 0 });
		overlays.push({ input: preparedCells[2], left: 2 * cellW, top: 0 });
	} else if (count === 4) {
		canvasW = 2 * cellW;
		canvasH = 2 * cellH;
		overlays.push({ input: preparedCells[0], left: 0, top: 0 });
		overlays.push({ input: preparedCells[1], left: cellW, top: 0 });
		overlays.push({ input: preparedCells[2], left: 0, top: cellH });
		overlays.push({ input: preparedCells[3], left: cellW, top: cellH });
	} else if (count === 5) {
		canvasW = 3 * cellW;
		canvasH = 2 * cellH;
		overlays.push({ input: preparedCells[0], left: 0, top: 0 }); // Top-Left
		overlays.push({ input: preparedCells[1], left: 2 * cellW, top: 0 }); // Top-Right
		overlays.push({ input: preparedCells[2], left: cellW, top: Math.floor(0.5 * cellH) }); // Center
		overlays.push({ input: preparedCells[3], left: 0, top: cellH }); // Bottom-Left
		overlays.push({ input: preparedCells[4], left: 2 * cellW, top: cellH }); // Bottom-Right
	} else if (count === 6) {
		canvasW = 3 * cellW;
		canvasH = 2 * cellH;
		overlays.push({ input: preparedCells[0], left: 0, top: 0 });
		overlays.push({ input: preparedCells[1], left: cellW, top: 0 });
		overlays.push({ input: preparedCells[2], left: 2 * cellW, top: 0 });
		overlays.push({ input: preparedCells[3], left: 0, top: cellH });
		overlays.push({ input: preparedCells[4], left: cellW, top: cellH });
		overlays.push({ input: preparedCells[5], left: 2 * cellW, top: cellH });
	} else if (count === 7) {
		canvasW = 3 * cellW;
		canvasH = 3 * cellH;
		overlays.push({ input: preparedCells[0], left: 0, top: 0 });
		overlays.push({ input: preparedCells[1], left: cellW, top: 0 });
		overlays.push({ input: preparedCells[2], left: 2 * cellW, top: 0 });
		overlays.push({ input: preparedCells[3], left: cellW, top: cellH }); // Centro
		overlays.push({ input: preparedCells[4], left: 0, top: 2 * cellH });
		overlays.push({ input: preparedCells[5], left: cellW, top: 2 * cellH });
		overlays.push({ input: preparedCells[6], left: 2 * cellW, top: 2 * cellH });
	} else if (count === 8) {
		canvasW = 3 * cellW;
		canvasH = 3 * cellH;
		overlays.push({ input: preparedCells[0], left: 0, top: 0 });
		overlays.push({ input: preparedCells[1], left: cellW, top: 0 });
		overlays.push({ input: preparedCells[2], left: 2 * cellW, top: 0 });
		overlays.push({ input: preparedCells[3], left: 0, top: cellH });
		overlays.push({ input: preparedCells[4], left: 2 * cellW, top: cellH });
		overlays.push({ input: preparedCells[5], left: 0, top: 2 * cellH });
		overlays.push({ input: preparedCells[6], left: cellW, top: 2 * cellH });
		overlays.push({ input: preparedCells[7], left: 2 * cellW, top: 2 * cellH });
	} else if (count >= 9) {
		canvasW = 3 * cellW;
		canvasH = 3 * cellH;
		overlays.push({ input: preparedCells[0], left: 0, top: 0 });
		overlays.push({ input: preparedCells[1], left: cellW, top: 0 });
		overlays.push({ input: preparedCells[2], left: 2 * cellW, top: 0 });
		overlays.push({ input: preparedCells[3], left: 0, top: cellH });
		overlays.push({ input: preparedCells[4], left: cellW, top: cellH });
		overlays.push({ input: preparedCells[5], left: 2 * cellW, top: cellH });
		overlays.push({ input: preparedCells[6], left: 0, top: 2 * cellH });
		overlays.push({ input: preparedCells[7], left: cellW, top: 2 * cellH });
		overlays.push({ input: preparedCells[8], left: 2 * cellW, top: 2 * cellH });
	}

	return await sharp({
		create: {
			width: canvasW,
			height: canvasH,
			channels: 4,
			background: { r: 24, g: 26, b: 32, alpha: 1 }
		}
	})
		.composite(overlays)
		.jpeg({ quality: 85 })
		.toBuffer();
}

/**
 * Tratamento padronizado de erros retornados pela API Waifuletes
 * @param {Error} err
 * @param {string} chatId
 * @param {string} defaultMsg
 * @param {object} [options]
 * @returns {ReturnMessage}
 */
function handleApiError(err, chatId, defaultMsg, options = {}) {
	const resData = err.response?.data;
	const apiErr =
		typeof resData?.error === "object" && resData?.error !== null ? resData.error : null;

	if (
		apiErr?.code === "COOLDOWN_ACTIVE" ||
		apiErr?.code === "CLAIM_COOLDOWN_ACTIVE" ||
		apiErr?.code === "DAILY_COOLDOWN_ACTIVE"
	) {
		// Cooldown de Rolls: identificado quando possui currentRolls numérico
		if (typeof apiErr.currentRolls === "number") {
			const currentRolls = apiErr.currentRolls;
			const maxRolls = apiErr.maxRolls ?? 10;
			const nextSecs = apiErr.remainingSeconds ?? 0;
			const fullSecs = apiErr.fullRechargeSeconds ?? 0;
			const fullAt = apiErr.fullRechargeAt ? new Date(apiErr.fullRechargeAt) : null;

			let msg = `⏳ *Sem rolls disponíveis!* (*${currentRolls}/${maxRolls}*)\n`;
			msg += `• Próximo roll em: *${formatRemainingSeconds(nextSecs)}*\n`;

			if (fullAt && !isNaN(fullAt.getTime())) {
				const timeStr = formatTimeBR(fullAt);
				msg += `• *${maxRolls}/${maxRolls}* rolls em: *${formatRemainingSeconds(fullSecs)}* (às ${timeStr})`;
			} else if (fullSecs > 0) {
				msg += `• *${maxRolls}/${maxRolls}* rolls em: *${formatRemainingSeconds(fullSecs)}*`;
			}

			return new ReturnMessage({
				chatId,
				content: msg,
				options
			});
		}

		if (apiErr.code === "DAILY_MARRY_LIMIT_REACHED") {
			const normRarity = apiErr.rarity ? String(apiErr.rarity).toUpperCase() : "";
			const label = RARITY_LABEL_PLURAL[normRarity] || RARITY_LABEL[normRarity] || "esta categoria";
			const emoji = RARITY_EMOJI[normRarity] || "💍";
			return new ReturnMessage({
				chatId,
				content: `⚠️ *Limite diário de casamentos atingido [${emoji} ${label}]!*\n• Você já atingiu seu limite diário de casamentos para esta raridade hoje.\n💡 O limite diário reseta às 04:00 BRT. Personagens de outras categorias ainda podem estar disponíveis para casamento!`,
				options
			});
		}

		// Cooldown de Casamento (Claim) ou Diário (Daily)
		const retryAt = apiErr.retryAfter ? new Date(apiErr.retryAfter) : null;
		const timeStr = retryAt && !isNaN(retryAt.getTime()) ? ` (às ${formatTimeBR(retryAt)})` : "";

		const remaining = apiErr.remainingSeconds
			? formatRemainingSeconds(apiErr.remainingSeconds)
			: null;

		let msg;
		if (
			apiErr.code === "CLAIM_COOLDOWN_ACTIVE" ||
			(typeof apiErr.message === "string" && apiErr.message.includes("casamento"))
		) {
			const waitTime = remaining || "um momento";
			if (apiErr.rarity) {
				const normRarity = String(apiErr.rarity).toUpperCase();
				const emoji = RARITY_EMOJI[normRarity] || "⚪";
				const label = RARITY_LABEL[normRarity] || apiErr.rarity;
				msg = `💍 *Cooldown de Casamento ativo [${emoji} ${label}]!*\n• Você precisa aguardar *${waitTime}* para realizar outro casamento com personagens *${label}*${timeStr}.\n💡 Personagens de outras raridades ainda podem estar disponíveis para casamento!`;
			} else {
				msg = `💍 *Cooldown de Casamento ativo!*\n• Você precisa aguardar *${waitTime}* para realizar outro casamento${timeStr}.`;
			}
		} else if (
			apiErr.code === "DAILY_COOLDOWN_ACTIVE" ||
			(typeof apiErr.message === "string" && apiErr.message.includes("diária"))
		) {
			const waitTime = remaining || "um momento";
			msg = `💜 *Cooldown Diário ativo!*\n• Você já resgatou sua recompensa diária! Volte em *${waitTime}*${timeStr}.`;
		} else if (apiErr.message) {
			msg = `⏳ ${apiErr.message}${timeStr}`;
		} else if (remaining) {
			msg = `⏳ Cooldown ativo! Aguarde *${remaining}*${timeStr}.`;
		} else {
			msg = `⏳ Cooldown ativo. Aguarde antes de tentar novamente.`;
		}

		return new ReturnMessage({
			chatId,
			content: msg,
			options
		});
	}

	const customMsgs = {
		LOCK_EXPIRED:
			"⌛ A janela de 300 segundos para casar expirou ou o personagem não foi rolado neste grupo!",
		CHARACTER_ALREADY_CLAIMED: apiErr?.owner?.name
			? `🚫 Este personagem já pertence a *${apiErr.owner.name}*!`
			: apiErr?.message || "🚫 Este personagem já foi reivindicado por outro jogador!",
		CHARACTER_NOT_IN_HAREM: "❓ Este personagem não faz parte do seu harém.",
		NOT_IN_HAREM: "❓ Este personagem não faz parte do seu harém.",
		WISHLIST_LIMIT_REACHED: `⚠️ Sua wishlist está cheia (máximo de ${WISHLIST_MAX_ITEMS}). Remova um item antes com \`!mu-removerdesejo <id>\`.`,
		ENTRY_NOT_FOUND: "🔍 Este personagem não está na sua Wishlist.",
		CHARACTER_NOT_FOUND: "🔍 Personagem não encontrado. Verifique o ID informado.",
		USER_NOT_FOUND: "👤 Usuário não cadastrado ainda. Use *!mu-roll* para começar!",
		CANNOT_DIVORCE_MYTHIC:
			"🔮 Personagens Míticos possuem laço sagrado e eterno com seu criador e não podem ser divorciados!",
		CANNOT_WISHLIST_MYTHIC:
			"🔮 Personagens Míticos já pertencem eternamente ao seu criador e não podem ser adicionados à Wishlist!",
		CANNOT_COVET_MYTHIC:
			"🔮 Personagens Míticos pertencem eternamente ao seu criador e não podem ser cobiçados!"
	};

	const message =
		(apiErr?.code && customMsgs[apiErr.code]) ||
		apiErr?.message ||
		resData?.message ||
		(typeof resData?.error === "string" ? resData.error : null) ||
		defaultMsg;

	logger.error("Erro na chamada Waifuletes:", apiErr || resData?.message || err.message);
	const prefix = /^(?:⌛|🚫|❓|⚠️|🔍|👤|❌)/u.test(message) ? "" : "❌ ";
	return new ReturnMessage({ chatId, content: `${prefix}${message}`, options });
}

// ─── Handlers de Comandos ───────────────────────────────────────────────────

/**
 * Formata o retorno da recompensa diária de Zinthos
 * @param {string} chatId
 * @param {Object} dailyData
 * @returns {ReturnMessage}
 */
function formatDailyRewardMessage(chatId, dailyData) {
	const { amount, currencyEmoji, newBalance, nextDailyAt, streak } = dailyData;

	let formattedDate = "";
	if (nextDailyAt) {
		const nextDate = new Date(nextDailyAt);
		formattedDate = formatDateTimeBR(nextDate, {
			hour: "2-digit",
			minute: "2-digit",
			day: "2-digit",
			month: "2-digit"
		});
	}

	let text = `${currencyEmoji || "💜"} *Recompensa Diária Coletada!*\n\n`;
	text += `🎁 Você recebeu: *+${amount} Zinthos*\n`;
	if (streak && streak.current > 1) {
		text += `🔥 Sequência Diária: *Dia ${streak.current}/7* (+${streak.bonusPercent}% de bônus!)\n`;
	} else {
		text += `🌱 Sequência Diária: *Dia 1/7* (Resgate amanhã para +10% de bônus!)\n`;
	}
	if (dailyData?.wishlist?.bonusAmount > 0) {
		text += `🌟 Bônus de Wishlist: *+${dailyData.wishlist.bonusAmount} Zinthos* (${dailyData.wishlist.count}/1000 desejos)\n`;
	}
	text += `💰 Saldo total: *${newBalance} Zinthos*\n`;
	if (formattedDate) {
		text += `⏰ Próximo resgate: *${formattedDate}*`;
	}

	return new ReturnMessage({ chatId, content: text });
}

/**
 * Sanitiza e aplica tetos estritos aos bônus de roll para respeitar o schema da API do Mudae
 * @param {Object} bonuses
 * @returns {Object}
 */
function sanitizeRollBonuses(bonuses) {
	if (!bonuses || typeof bonuses !== "object") return bonuses;
	const sanitized = { ...bonuses };

	if (sanitized.rarityMultipliers && typeof sanitized.rarityMultipliers === "object") {
		const mults = { ...sanitized.rarityMultipliers };
		for (const key of Object.keys(mults)) {
			const val = Number(mults[key]);
			if (!isNaN(val)) {
				// API schema: minimum 0.1, maximum 10
				mults[key] = Math.min(10.0, Math.max(0.1, Number(val.toFixed(3))));
			}
		}
		sanitized.rarityMultipliers = mults;
	}

	if (sanitized.wishlistMultiplier !== undefined && sanitized.wishlistMultiplier !== null) {
		const val = Number(sanitized.wishlistMultiplier);
		if (!isNaN(val)) {
			// API schema: minimum 0.1, maximum 100
			sanitized.wishlistMultiplier = Math.min(100.0, Math.max(0.1, Number(val.toFixed(3))));
		}
	}

	if (sanitized.starWishMultiplier !== undefined && sanitized.starWishMultiplier !== null) {
		const val = Number(sanitized.starWishMultiplier);
		if (!isNaN(val)) {
			// API schema: minimum 0.1, maximum 10
			sanitized.starWishMultiplier = Math.min(10.0, Math.max(0.1, Number(val.toFixed(3))));
		}
	}

	if (sanitized.extraMaxRolls !== undefined && sanitized.extraMaxRolls !== null) {
		const val = Number(sanitized.extraMaxRolls);
		if (!isNaN(val)) {
			// API schema: minimum 0, maximum 500
			sanitized.extraMaxRolls = Math.min(500, Math.max(0, Math.round(val)));
		}
	}

	return sanitized;
}

/**
 * Cria função de roll com ou sem filtro de gênero
 * @param {"MALE" | "FEMALE" | undefined} genderFilter
 */
function makeRollHandler(genderFilter) {
	return async function rollWaifu(bot, message, args, group) {
		const chatId = message.group ?? message.author;
		const userId = getUserId(message);
		const groupId = getGroupId(message);
		const name = await getUserName(message, group);

		const isGroup = Boolean(message.group);
		let groupObj = group;
		if (isGroup && (!groupObj || !groupObj.filters)) {
			try {
				groupObj = await (bot?.database || database)?.getGroup?.(message.group);
			} catch (_) {}
		}
		const shouldMentionWishlist = isGroup ? groupObj?.filters?.waifuRollMarcar !== false : true;
		const currentParticipants = isGroup
			? await getGroupParticipants(bot, message, message.group)
			: null;

		// Extrai quantidade solicitada (1 a 9)
		let requestedRolls = 1;
		if (args && args[0]) {
			const parsed = parseInt(args[0], 10);
			if (!isNaN(parsed) && parsed > 0) {
				requestedRolls = Math.min(parsed, 9);
			}
		}

		try {
			// Tenta resgatar automaticamente a recompensa diária em paralelo com a busca de bônus
			const claimDailyPromise = (async () => {
				try {
					const { data: dailyData } = await api.post("/kakera/daily", { userId, groupId, name });
					if (dailyData?.success && dailyData?.data) {
						return dailyData.data;
					}
				} catch (dailyErr) {
					logger.debug(
						`[rollWaifu] Tentativa de claim diário: ${dailyErr?.response?.data?.error?.code || dailyErr.message}`
					);
				}
				return null;
			})();

			const [rollBonusesRaw, farmBonus, dailyClaimResult] = await Promise.all([
				DonorBonusService.getWaifuRollBonuses(userId),
				ShadowGardenBonusService.getWaifuBonus(userId),
				claimDailyPromise
			]);

			let rollBonuses = rollBonusesRaw;
			const hasFarmBonus = (farmBonus.rolls || 0) > 0 || (farmBonus.tickets || 0) > 0;
			let consumedFarmBonus = null;

			const wrapReturn = (mainReturn) => {
				if (dailyClaimResult) {
					return [mainReturn, formatDailyRewardMessage(chatId, dailyClaimResult)];
				}
				return mainReturn;
			};

			if (hasFarmBonus) {
				rollBonuses = rollBonuses ? { ...rollBonuses } : {};
				// Concede roll gratuito da fazenda sem consumir o saldo de cooldown
				rollBonuses.isFreeRoll = true;

				// Se tiver ticket (Rosa de Sangue), concede bônus de raridade equivalente a doador alto
				if (farmBonus.tickets > 0) {
					const curMults = rollBonuses.rarityMultipliers
						? { ...rollBonuses.rarityMultipliers }
						: { RARE: 1.0, EPIC: 1.0, LEGENDARY: 1.0 };
					curMults.RARE = Math.max(curMults.RARE || 1.0, 1.4);
					curMults.EPIC = Math.max(curMults.EPIC || 1.0, 1.7);
					curMults.LEGENDARY = Math.max(curMults.LEGENDARY || 1.0, 2.0);
					rollBonuses.rarityMultipliers = curMults;
				}
			}

			const eventRarosMult = GameEventService.getMultiplier("waifu", "raros");
			const eventWishMult = GameEventService.getMultiplier("waifu", "wish");

			if (eventRarosMult !== 1.0 || eventWishMult !== 1.0) {
				rollBonuses = rollBonuses ? { ...rollBonuses } : {};
				const baseRarities = rollBonuses.rarityMultipliers
					? { ...rollBonuses.rarityMultipliers }
					: { RARE: 1.0, EPIC: 1.0, LEGENDARY: 1.0 };

				if (eventRarosMult !== 1.0) {
					baseRarities.RARE = Number((baseRarities.RARE * eventRarosMult).toFixed(3));
					baseRarities.EPIC = Number((baseRarities.EPIC * eventRarosMult).toFixed(3));
					baseRarities.LEGENDARY = Number((baseRarities.LEGENDARY * eventRarosMult).toFixed(3));
				}
				rollBonuses.rarityMultipliers = baseRarities;

				if (eventWishMult !== 1.0) {
					const baseWish = rollBonuses.wishlistMultiplier || 1.0;
					rollBonuses.wishlistMultiplier = Math.min(
						20.0,
						Number((baseWish * eventWishMult).toFixed(3))
					);
				}
			}

			const finalBonuses = sanitizeRollBonuses(rollBonuses);
			const payload = {
				userId,
				groupId,
				name,
				platform: "WHATSAPP",
				...(genderFilter && { gender: genderFilter }),
				...(finalBonuses ? { bonuses: finalBonuses } : {})
			};

			const { data } = await api.post("/roll", payload);

			if (hasFarmBonus) {
				consumedFarmBonus = await ShadowGardenBonusService.consumeWaifuBonus(userId);
			}

			const firstRollData = data.data;
			const initialRollsRemaining = firstRollData.rollsRemaining;
			const initialMaxRolls = firstRollData.maxRolls ?? 9;

			// Define a quantidade real de rolls a executar: 1 (já executado) + rolls normais restantes + bônus da fazenda restantes
			const farmBonusRemainingAfterFirst = await ShadowGardenBonusService.getWaifuBonus(userId);
			const farmRemainingCount =
				(farmBonusRemainingAfterFirst.rolls || 0) + (farmBonusRemainingAfterFirst.tickets || 0);
			const standardRollsRemaining =
				typeof initialRollsRemaining === "number" ? initialRollsRemaining : 0;
			const maxPossibleRolls = 1 + farmRemainingCount + standardRollsRemaining;
			const rollsToExecute = Math.min(requestedRolls, maxPossibleRolls);

			// Se for apenas 1 roll (ou se o usuário só tinha 1 roll disponível)
			if (rollsToExecute <= 1) {
				const {
					character,
					available,
					isOwner,
					owner,
					keyProgress,
					kakeraValue,
					rollReward,
					rollsRemaining,
					maxRolls
				} = firstRollData;

				const isMythic = Boolean(
					character.isMythic ||
					firstRollData?.isMythic ||
					String(character.rarity || "").toUpperCase() === "MYTHIC"
				);
				const rarity = isMythic ? "MYTHIC" : character.rarity || character.baseRarity || "COMMON";
				const normalizedRarity = String(rarity).toUpperCase();
				const emojiRarity = RARITY_EMOJI[normalizedRarity] || RARITY_EMOJI[rarity] || "⚪";
				const labelRarity = RARITY_LABEL[normalizedRarity] || RARITY_LABEL[rarity] || rarity;
				const exclusiveMs = available ? getExclusiveClaimWindowMs(rarity) : 0;
				const isSpecialRarity = exclusiveMs > 0;

				let text = `🎲 *${character.name}* — _${character.series}_\n`;
				if (firstRollData?.marketNotification) {
					text += `${firstRollData.marketNotification}\n`;
				}
				text += `${emojiRarity} *[${labelRarity}]*`;
				if (firstRollData?.isWishlist) {
					text += ` 🌟 *[SEU DESEJO!]*`;
				}
				if (firstRollData?.appliedBonuses?.donorBadge || rollBonuses?.donorBadge) {
					text += ` 💎 *[VIP]*`;
				}
				text += "\n";

				if (firstRollData?.dailyMarryLimit?.limitReached) {
					const pluralLabel =
						RARITY_LABEL_PLURAL[normalizedRarity] ||
						RARITY_LABEL_PLURAL[character.baseRarity] ||
						labelRarity;
					text += `⚠️ Limite diário de casamentos atingido para ${pluralLabel}!\n`;
				}

				if (firstRollData?.isWishlist) {
					text += `✨ *DESEJO REALIZADO!* Este personagem estava na sua Wishlist (+50% de bônus no sorteio)!\n`;
				}

				if (character.description) {
					const desc =
						character.description.length > 180
							? `${character.description.substring(0, 180)}...`
							: character.description;
					text += `\n_${desc}_\n`;
				}
				text += "\n";

				if (firstRollData?.instantMarriage) {
					const shares = firstRollData.instantMarriageShares || 1;
					const userMention = userId.includes("@") ? `@${userId.split("@")[0]}` : `@${userId}`;
					let marryText = `💍 *Parabéns, ${userMention}!* Você se casou com *${character.name}*! 🎉\n`;
					marryText += `⚡ *CASAMENTO INSTANTÂNEO POR COTA!* Você possuía *${shares}/4 cotas* (${shares * 25}%) e o casamento ocorreu imediatamente sem consumir cooldown!\n`;
					marryText += `🔑 Chaves: *1/10*\n`;
					if (firstRollData.refundedCompetitorsCount > 0) {
						marryText += `⚠️ *${firstRollData.refundedCompetitorsCount} competidor(es)* que investiram nesta waifu receberam 50% de reembolso em Zinthos.\n`;
					}
					if (rollReward) {
						marryText += `\n✨ *Fragmentos colhidos:* +${rollReward.totalScrap} Zinthos`;
					}
					if (typeof rollsRemaining === "number" && typeof maxRolls === "number") {
						marryText += `\n🎟️ Rolls restantes: *${rollsRemaining}/${maxRolls}*`;
					}

					return wrapReturn(
						await buildMarriageReturnMessage(bot, message, character, userId, name, marryText, {
							quotedMessageId: message.origin?.id?._serialized,
							goReply: message.origin,
							mentions: [toJid(userId)]
						})
					);
				}

				let exclusiveUntil = null;
				if (available) {
					const now = Date.now();
					exclusiveUntil = isSpecialRarity ? now + exclusiveMs : null;
					const claimData = {
						characterId: character.id,
						characterName: character.name,
						rollerUserId: userId,
						rollerUserName: name,
						exclusiveUntil,
						expiresAt: now + CLAIM_WINDOW_MS
					};

					pendingClaims.set(groupId, claimData);
					activeClaimsByCharGroup.set(`${groupId}:${character.id}`, claimData);

					setTimeout(() => {
						const cur = pendingClaims.get(groupId);
						if (cur && cur.characterId === character.id) {
							pendingClaims.delete(groupId);
						}
						const curChar = activeClaimsByCharGroup.get(`${groupId}:${character.id}`);
						if (curChar && curChar.expiresAt <= Date.now()) {
							activeClaimsByCharGroup.delete(`${groupId}:${character.id}`);
						}
					}, CLAIM_WINDOW_MS);

					const rollerMention = userId.includes("@") ? `@${userId.split("@")[0]}` : `@${userId}`;

					if (isSpecialRarity) {
						const exclSecs = Math.round(exclusiveMs / 1000);
						text += `🔒 *EXCLUSIVO!* ${rollerMention} tem ${exclSecs}s de exclusividade para casar! Reaja com 💍 ou use \`!mu-casar\` (ou \`!mu-casar ${character.id}\`).\n⏳ Após ${exclSecs}s, ficará livre para qualquer jogador casar (janela total de 300s).`;
					} else {
						text += `💍 *LIVRE!* Reaja com 💍 ou use \`!mu-casar\` (ou \`!mu-casar ${character.id}\`) em até 300s para casar!`;
					}
				} else if (isOwner) {
					if (isMythic) {
						text += `✨ *Você rolou sua própria criação mítica!*\n🔮 *Vínculo Sagrado e Eterno!* _(Personagens míticos não acumulam chaves nem viram soulmate, pois já possuem devoção plena ao criador!)_`;
					} else {
						const keys = keyProgress?.currentKeys ?? 1;
						text += `✨ *Você rolou seu próprio personagem!*\n🔑 Chaves acumuladas: *${keys}/10*`;
						if (keyProgress?.becameSoulmateNow) {
							text += `\n\n💖 *PARABÉNS! ${character.name} agora é oficialmente sua SOULMATE permanente!*`;
							notifySoulmateAchievement(bot, character, name).catch((eNotif) => {
								logger.error("Erro ao notificar conquista de Soulmate:", eNotif);
							});
						}
					}
				} else if (isMythic) {
					const creatorName = owner?.name || "Outro jogador";
					const creatorMention =
						owner?.id && owner.id.includes("@") ? `@${owner.id.split("@")[0]}` : creatorName;
					text += `🔮 *CRIAÇÃO MÍTICA!* Forjada por ${creatorMention}\n🔒 Casamento eterno com seu criador.`;
					if (kakeraValue) {
						text += `\n💜 Valor em cristal: *${kakeraValue} Zinthos*`;
					}
				} else {
					text += `🔒 Já pertence a: *${owner?.name || "Outro jogador"}*`;
					if (kakeraValue) {
						text += `\n💜 Valor em cristal: *${kakeraValue} Zinthos*`;
					}
				}

				const singleRollWebUrl = getCharacterWebUrl(character.id);
				if (singleRollWebUrl) {
					text += `\n🔗 ${singleRollWebUrl}`;
				}

				if (rollReward) {
					text += `\n✨ *Fragmentos colhidos:* +${rollReward.totalScrap} Zinthos`;
					if (rollReward.rarityBonus > 0) {
						text += `\n🌟 *BÔNUS DE RARIDADE:* +${rollReward.rarityBonus} Zinthos!`;
					}
					if (rollReward.wishlistBonus > 0) {
						const wishMultPct = Math.round((rollReward.wishlistMultiplier - 1) * 100);
						text += `\n🌟 *BÔNUS DE WISHLIST:* +${rollReward.wishlistBonus} Zinthos (${rollReward.wishlistCount}/1000 desejos | +${wishMultPct}%)!`;
					}
				}

				if (typeof rollsRemaining === "number" && typeof maxRolls === "number") {
					text += `\n\n🎟️ Rolls restantes: *${rollsRemaining}/${maxRolls}*`;
				}

				if (consumedFarmBonus?.consumed) {
					const bType =
						consumedFarmBonus.type === "ticket"
							? "Ticket de Waifu (Rosa de Sangue)"
							: "Roll Bônus (Coração Púrpuro)";
					text += `\n🌱 *Bônus da Fazenda Usado:* ${bType} (Restantes: ${consumedFarmBonus.remainingRolls} rolls, ${consumedFarmBonus.remainingTickets} tickets)`;
				}

				const eventBanner = GameEventService.getEventBanner("waifu");
				if (eventBanner) {
					text += eventBanner;
				}

				const mentions = isSpecialRarity && available && userId ? [toJid(userId)] : [];
				if (isMythic && !isOwner && owner?.id) {
					mentions.push(toJid(owner.id));
				}

				if (Array.isArray(firstRollData.wishlistUsers) && firstRollData.wishlistUsers.length > 0) {
					firstRollData.wishlistUsers = firstRollData.wishlistUsers.filter((u) =>
						isUserActiveInGroup(u.userId, currentParticipants)
					);
				}

				if (
					shouldMentionWishlist &&
					Array.isArray(firstRollData.wishlistUsers) &&
					firstRollData.wishlistUsers.length > 0
				) {
					const listMentions = firstRollData.wishlistUsers
						.map((u) => `@${normalizeUserId(u.userId)}`)
						.join(", ");
					text += `\n\n- Usuários que tem personagem na wishlist: ${listMentions}`;
					firstRollData.wishlistUsers.forEach((u) => {
						mentions.push(toJid(u.userId));
					});
				}

				const uniqueMentions = [...new Set(mentions)];

				let imageBase64 = await downloadImageAsBase64(character.imageUrl);
				if (!imageBase64) {
					try {
						const placeholderBuf = await generateSingleRollPlaceholderBuffer(character);
						if (placeholderBuf) {
							imageBase64 = placeholderBuf.toString("base64");
						}
					} catch (placeholderErr) {
						logger.debug("Falha ao gerar placeholder para single roll:", placeholderErr.message);
					}
				}

				if (imageBase64) {
					return wrapReturn(
						new ReturnMessage({
							chatId,
							content: {
								mimetype: "image/jpeg",
								data: imageBase64,
								filename: "waifu.jpg",
								isMessageMedia: true
							},
							options: {
								caption: text,
								waifuCharacterId: character.id,
								waifuAvailable: Boolean(
									available && !owner && !isOwner && !firstRollData?.instantMarriage
								),
								waifuIsMarried: Boolean(
									owner || isOwner || firstRollData?.isMarried || character?.isMarried
								),
								waifuOwner: owner?.name || (isOwner ? name : null),
								waifuIsOwner: Boolean(isOwner),
								waifuInstantMarriage: Boolean(firstRollData?.instantMarriage),
								waifuGroupId: groupId,
								waifuRollerUserId: userId,
								waifuRollerUserName: name,
								waifuExclusiveUntil: exclusiveUntil,
								waifuExpiresAt: Date.now() + CLAIM_WINDOW_MS,
								mentions: uniqueMentions
							}
						})
					);
				}

				return wrapReturn(
					new ReturnMessage({
						chatId,
						content: text,
						options: {
							waifuCharacterId: character.id,
							waifuAvailable: Boolean(
								available && !owner && !isOwner && !firstRollData?.instantMarriage
							),
							waifuIsMarried: Boolean(
								owner || isOwner || firstRollData?.isMarried || character?.isMarried
							),
							waifuOwner: owner?.name || (isOwner ? name : null),
							waifuIsOwner: Boolean(isOwner),
							waifuInstantMarriage: Boolean(firstRollData?.instantMarriage),
							waifuGroupId: groupId,
							waifuRollerUserId: userId,
							waifuRollerUserName: name,
							waifuExclusiveUntil: exclusiveUntil,
							waifuExpiresAt: Date.now() + CLAIM_WINDOW_MS,
							mentions: uniqueMentions
						}
					})
				);
			}

			// ─── ROLLS MÚLTIPLOS (2 a 9) ──────────────────────────────────────────
			const allRollResults = [firstRollData];
			let totalFarmConsumedInBatch = consumedFarmBonus?.consumed ? 1 : 0;

			for (let i = 2; i <= rollsToExecute; i++) {
				try {
					const curFarm = await ShadowGardenBonusService.getWaifuBonus(userId);
					const stillHasFarm = (curFarm.rolls || 0) > 0 || (curFarm.tickets || 0) > 0;
					const stepBonuses = rollBonuses ? { ...rollBonuses } : {};

					if (stillHasFarm) {
						stepBonuses.isFreeRoll = true;
						if (curFarm.tickets > 0) {
							const curMults = stepBonuses.rarityMultipliers
								? { ...stepBonuses.rarityMultipliers }
								: { RARE: 1.0, EPIC: 1.0, LEGENDARY: 1.0 };
							curMults.RARE = Math.max(curMults.RARE || 1.0, 1.4);
							curMults.EPIC = Math.max(curMults.EPIC || 1.0, 1.7);
							curMults.LEGENDARY = Math.max(curMults.LEGENDARY || 1.0, 2.0);
							stepBonuses.rarityMultipliers = curMults;
						}
					} else {
						delete stepBonuses.isFreeRoll;
					}

					const finalStepBonuses = sanitizeRollBonuses(stepBonuses);
					const stepPayload = {
						...payload,
						...(finalStepBonuses && Object.keys(finalStepBonuses).length > 0
							? { bonuses: finalStepBonuses }
							: {})
					};

					const nextRes = await api.post("/roll", stepPayload);
					if (nextRes.data?.success && nextRes.data?.data) {
						allRollResults.push(nextRes.data.data);
						if (stillHasFarm) {
							const cRes = await ShadowGardenBonusService.consumeWaifuBonus(userId);
							if (cRes?.consumed) totalFarmConsumedInBatch++;
						}
					} else {
						break;
					}
				} catch (subErr) {
					logger.warn(`Erro no roll múltiplo #${i}: ${subErr.message}`);
					break;
				}
			}

			allRollResults.forEach((r) => {
				if (Array.isArray(r.wishlistUsers) && r.wishlistUsers.length > 0) {
					r.wishlistUsers = r.wishlistUsers.filter((u) =>
						isUserActiveInGroup(u.userId, currentParticipants)
					);
				}
			});

			const now = Date.now();
			const multiRollSlots = allRollResults.map((r, idx) => {
				const slot = idx + 1;
				const char = r.character;
				const isMythic = Boolean(
					char.isMythic || r.isMythic || String(char.rarity || "").toUpperCase() === "MYTHIC"
				);
				const rarity = isMythic ? "MYTHIC" : char.rarity || char.baseRarity || "COMMON";
				const hasOwner = Boolean(
					r.owner && (typeof r.owner === "string" || r.owner.name || r.owner.id)
				);
				const isMarried = Boolean(r.isMarried || char?.isMarried || hasOwner);
				const isAvailable = Boolean(r.available) && !isMarried && !r.instantMarriage;
				const exclMs = isAvailable ? getExclusiveClaimWindowMs(rarity) : 0;
				const exclusiveUntil = exclMs > 0 ? now + exclMs : null;

				return {
					slot,
					characterId: char.id,
					characterName: char.name,
					series: char.series,
					rarity,
					isMythic,
					available: isAvailable,
					isMarried,
					isOwner: Boolean(r.isOwner),
					instantMarriage: Boolean(r.instantMarriage),
					instantMarriageShares: r.instantMarriageShares,
					isWishlist: Boolean(r.isWishlist),
					isStarWish: Boolean(r.isStarWish),
					wishlistUsers: r.wishlistUsers || [],
					owner: r.owner,
					keyProgress: r.keyProgress,
					exclusiveUntil,
					claimed: false,
					imageUrl: char.imageUrl,
					rollReward: r.rollReward
				};
			});

			// Registra no activeClaimsByCharGroup e pendingClaims
			multiRollSlots.forEach((s) => {
				if (s.available) {
					const claimData = {
						isMultiRoll: true,
						characterId: s.characterId,
						characterName: s.characterName,
						groupId,
						rollerUserId: userId,
						rollerUserName: name,
						exclusiveUntil: s.exclusiveUntil,
						expiresAt: now + CLAIM_WINDOW_MS
					};
					activeClaimsByCharGroup.set(`${groupId}:${s.characterId}`, claimData);

					setTimeout(() => {
						const curChar = activeClaimsByCharGroup.get(`${groupId}:${s.characterId}`);
						if (curChar && curChar.expiresAt <= Date.now()) {
							activeClaimsByCharGroup.delete(`${groupId}:${s.characterId}`);
						}
					}, CLAIM_WINDOW_MS);
				}
			});

			const multiRollClaim = {
				isMultiRoll: true,
				groupId,
				characters: multiRollSlots,
				slots: multiRollSlots,
				rollerUserId: userId,
				rollerUserName: name,
				expiresAt: now + CLAIM_WINDOW_MS
			};
			pendingClaims.set(groupId, multiRollClaim);
			addRecentMultiRoll(groupId, multiRollClaim);

			setTimeout(() => {
				const cur = pendingClaims.get(groupId);
				if (cur && cur.isMultiRoll && cur.expiresAt <= Date.now()) {
					pendingClaims.delete(groupId);
				}
			}, CLAIM_WINDOW_MS);

			// Montagem da Legenda
			let text = `🎲 Waifuletes! *${allRollResults.length}* rolls:\n\n`;
			if (firstRollData?.marketNotification) {
				text = `🎲 Waifuletes! *${allRollResults.length}* rolls:\n${firstRollData.marketNotification}\n\n`;
			}

			const limitReachedRarities = [];
			for (const r of allRollResults) {
				if (r?.dailyMarryLimit?.limitReached && r?.character?.baseRarity) {
					const norm = String(r.character.baseRarity).toUpperCase();
					const plural = RARITY_LABEL_PLURAL[norm] || norm;
					if (!limitReachedRarities.includes(plural)) {
						limitReachedRarities.push(plural);
					}
				}
			}
			if (limitReachedRarities.length > 0) {
				text += `⚠️ Limite diário de casamentos atingido para ${limitReachedRarities.join(", ")}!\n\n`;
			}

			// Categorias na ordem:
			// 1. Casamentos Instantâneos (via cota comprada)
			// 2. Personagens que a pessoa que usou o mu-roll já tem alguma chave (isOwner)
			// 3. Personagens da wishlist de alguém do grupo (solteiros)
			// 4. Solteiros
			// 5. Casados
			const instantMarriageSlots = multiRollSlots.filter((s) => s.instantMarriage);
			const rollerKeysSlots = multiRollSlots.filter((s) => s.isOwner && !s.instantMarriage);
			const groupWishlistFreeSlots = multiRollSlots.filter(
				(s) =>
					!s.isOwner &&
					s.available &&
					((s.wishlistUsers && s.wishlistUsers.length > 0) || s.isWishlist)
			);
			const solteirosSlots = multiRollSlots.filter(
				(s) =>
					!s.isOwner &&
					s.available &&
					(!s.wishlistUsers || s.wishlistUsers.length === 0) &&
					!s.isWishlist
			);
			const casadosSlots = multiRollSlots.filter((s) => !s.available && !s.isOwner);

			if (instantMarriageSlots.length > 0) {
				text += `💍 *Casamentos Instantâneos (via Cota):*\n`;
				instantMarriageSlots.forEach((s) => {
					const emojiNum = NUMBER_EMOJIS[s.slot - 1] || `${s.slot}️⃣`;
					const normRarity = String(s.rarity).toUpperCase();
					const emojiRarity = RARITY_EMOJI[normRarity] || "⚪";
					text += `${emojiNum} ${emojiRarity} ${s.characterName} — ${s.series || ""} (🎉 Casado com você sem cooldown!)\n`;
				});
				text += "\n";
			}

			if (rollerKeysSlots.length > 0) {
				text += `🔑 *Com chaves / Vínculo:*\n`;
				rollerKeysSlots.forEach((s) => {
					const emojiNum = NUMBER_EMOJIS[s.slot - 1] || `${s.slot}️⃣`;
					const normRarity = String(s.rarity).toUpperCase();
					const emojiRarity = RARITY_EMOJI[normRarity] || "⚪";
					if (s.isMythic) {
						text += `${emojiNum} ${emojiRarity} ${s.characterName} — ${s.series || ""} (🔮 Criação Mítica — Vínculo Sagrado)\n`;
					} else {
						const keysCount = s.keyProgress?.currentKeys || 1;
						const isSoulmateNow = s.keyProgress?.becameSoulmateNow;
						const soulmateTag = isSoulmateNow
							? " (💖 SOULMATE ALCANÇADO! 10/10)"
							: ` (🔑 Chaves: ${keysCount}/10)`;
						text += `${emojiNum} ${emojiRarity} ${s.characterName} — ${s.series || ""}${soulmateTag}\n`;
						if (isSoulmateNow) {
							notifySoulmateAchievement(
								bot,
								{
									id: s.characterId,
									name: s.characterName,
									series: s.series,
									rarity: s.rarity,
									imageUrl: s.imageUrl
								},
								name
							).catch((eNotif) => {
								logger.error("Erro ao notificar conquista de Soulmate em multiroll:", eNotif);
							});
						}
					}
				});
				text += "\n";
			}

			const hasFreeSlots = groupWishlistFreeSlots.length > 0 || solteirosSlots.length > 0;

			if (groupWishlistFreeSlots.length > 0) {
				text += `⭐ *Wishlist do grupo:*\n`;
				groupWishlistFreeSlots.forEach((s) => {
					const emojiNum = NUMBER_EMOJIS[s.slot - 1] || `${s.slot}️⃣`;
					const normRarity = String(s.rarity).toUpperCase();
					const emojiRarity = RARITY_EMOJI[normRarity] || "⚪";
					const exclSecs =
						s.exclusiveUntil && s.exclusiveUntil > now
							? Math.ceil((s.exclusiveUntil - now) / 1000)
							: 0;
					const exclTag = exclSecs > 0 ? ` (🔒 ${exclSecs}s exclusivo)` : "";
					text += `${emojiNum} ${emojiRarity} ${s.characterName} — ${s.series || ""}${exclTag}\n`;
					text += `> !mu-casar ${s.characterId}\n`;
					const wishSlotWebUrl = getCharacterWebUrl(s.characterId);
					if (wishSlotWebUrl) {
						text += `> ${wishSlotWebUrl}\n`;
					}
					text += "\n";
				});
			}

			if (solteirosSlots.length > 0) {
				text += `💍 *Solteiros:*\n`;
				solteirosSlots.forEach((s) => {
					const emojiNum = NUMBER_EMOJIS[s.slot - 1] || `${s.slot}️⃣`;
					const normRarity = String(s.rarity).toUpperCase();
					const emojiRarity = RARITY_EMOJI[normRarity] || "⚪";
					const exclSecs =
						s.exclusiveUntil && s.exclusiveUntil > now
							? Math.ceil((s.exclusiveUntil - now) / 1000)
							: 0;
					const exclTag = exclSecs > 0 ? ` (🔒 ${exclSecs}s exclusivo)` : "";
					text += `${emojiNum} ${emojiRarity} ${s.characterName} — ${s.series || ""}${exclTag}\n`;
					text += `> !mu-casar ${s.characterId}\n`;
					const singleSlotWebUrl = getCharacterWebUrl(s.characterId);
					if (singleSlotWebUrl) {
						text += `> ${singleSlotWebUrl}\n`;
					}
					text += "\n";
				});
			}

			if (hasFreeSlots) {
				text += `*Para Casar*: Reagir com o emoji do número, responder a mensagem com !mu-c # (número do personagem) ou usar !mu-casar <nome>\n\n`;
			}

			if (casadosSlots.length > 0) {
				text += `💔 *Casados:*\n`;
				casadosSlots.forEach((s) => {
					const emojiNum = NUMBER_EMOJIS[s.slot - 1] || `${s.slot}️⃣`;
					const normRarity = String(s.rarity).toUpperCase();
					const emojiRarity = RARITY_EMOJI[normRarity] || "⚪";
					const ownerInfo = s.owner?.name ? ` (${s.owner.name})` : "";
					const mythicTag = s.isMythic ? " 🔮 [Mítico]" : "";
					text += `${emojiNum} ${emojiRarity} ${s.characterName} — ${s.series || ""}${ownerInfo}${mythicTag}\n`;
				});
				text += "\n";
			}

			// Fragmentos acumulados
			let totalScrap = 0;
			allRollResults.forEach((r) => {
				if (r.rollReward) {
					totalScrap += Number(r.rollReward.totalScrap) || 0;
				}
			});

			const lastRes = allRollResults[allRollResults.length - 1];
			const lastRemaining = lastRes.rollsRemaining ?? 0;
			const lastMax = lastRes.maxRolls ?? initialMaxRolls;

			text += `✨ *Fragmentos colhidos:* +${totalScrap} Zinthos\n\n`;
			text += `🎟️ Rolls restantes: ${lastRemaining}/${lastMax}`;
			if (totalFarmConsumedInBatch > 0) {
				const finalFarm = await ShadowGardenBonusService.getWaifuBonus(userId);
				text += `\n🌱 *Bônus da Fazenda Usado:* ${totalFarmConsumedInBatch} roll(s) gratuitos (Restantes: ${finalFarm.rolls} rolls, ${finalFarm.tickets} tickets)`;
			}

			const eventBanner = GameEventService.getEventBanner("waifu");
			if (eventBanner) {
				text += eventBanner;
			}

			// Coleta todos os usuários do grupo que têm algum dos personagens na wishlist
			const wishlistUsersMap = new Map();
			if (shouldMentionWishlist) {
				allRollResults.forEach((r) => {
					if (Array.isArray(r.wishlistUsers)) {
						r.wishlistUsers.forEach((u) => {
							if (isUserActiveInGroup(u.userId, currentParticipants)) {
								const cleanId = normalizeUserId(u.userId);
								if (cleanId) {
									wishlistUsersMap.set(cleanId, u);
								}
							}
						});
					}
				});
			}

			const multiMentions = [];
			if (shouldMentionWishlist && wishlistUsersMap.size > 0) {
				const listMentions = Array.from(wishlistUsersMap.values())
					.map((u) => `@${normalizeUserId(u.userId)}`)
					.join(", ");
				text += `\n\n- Usuários que tem personagem na wishlist: ${listMentions}`;
				wishlistUsersMap.forEach((u) => {
					multiMentions.push(toJid(u.userId));
				});
			}

			const uniqueMultiMentions = [...new Set(multiMentions)];

			// Download paralelo das imagens e geração do Grid
			const downloadedBuffers = await Promise.all(
				multiRollSlots.map(async (s) => {
					const buf = await downloadImageBuffer(s.imageUrl);
					return { slot: s.slot, character: s, imageBuffer: buf };
				})
			);

			let gridBase64 = null;
			try {
				const gridBuf = await buildRollGridImage(downloadedBuffers);
				gridBase64 = gridBuf ? gridBuf.toString("base64") : null;
			} catch (gridErr) {
				logger.error(
					`Erro ao construir grid de imagens para ${allRollResults.length} rolls:`,
					gridErr.message
				);
			}

			if (gridBase64) {
				const curPending = pendingClaims.get(groupId);
				if (curPending && curPending.isMultiRoll) {
					curPending.gridBase64 = gridBase64;
				}
				return wrapReturn(
					new ReturnMessage({
						chatId,
						content: {
							mimetype: "image/jpeg",
							data: gridBase64,
							filename: "waifus.jpg",
							isMessageMedia: true
						},
						options: {
							caption: text,
							waifuRolls: multiRollSlots,
							waifuGroupId: groupId,
							waifuRollerUserId: userId,
							waifuRollerUserName: name,
							waifuExpiresAt: now + CLAIM_WINDOW_MS,
							waifuGridBase64: gridBase64,
							mentions: uniqueMultiMentions
						}
					})
				);
			}

			return wrapReturn(
				new ReturnMessage({
					chatId,
					content: text,
					options: {
						waifuRolls: multiRollSlots,
						waifuGroupId: groupId,
						waifuRollerUserId: userId,
						waifuRollerUserName: name,
						waifuExpiresAt: now + CLAIM_WINDOW_MS,
						mentions: uniqueMultiMentions
					}
				})
			);
		} catch (err) {
			return handleApiError(
				err,
				chatId,
				"Erro ao realizar sorteio de personagem. Tente novamente."
			);
		}
	};
}

const rollAny = makeRollHandler(undefined);
const rollMale = makeRollHandler("MALE");
const rollFemale = makeRollHandler("FEMALE");

/**
 * Constrói o ReturnMessage do casamento, incluindo a foto gerada ou fallback de imagem original/texto
 */
async function buildMarriageReturnMessage(
	bot,
	message,
	character,
	userId,
	name,
	text,
	replyOptions
) {
	const chatId = message.group ?? message.author;
	let photoResult = null;
	try {
		photoResult = await generateAndSaveMarriageImage(bot, message, character, userId, name);
	} catch (e) {
		logger.warn("Erro ao gerar/anexar foto de casamento:", e.message || e);
	}

	// Notifica canal de avisos em caso de personagem Lendário usando a foto gerada (ou fallback)
	if (character && (character.rarity === "LEGENDARY" || character.baseRarity === "LEGENDARY")) {
		const notifMedia =
			photoResult?.success && photoResult?.media
				? photoResult.media
				: photoResult?.fallback === "original_image" && photoResult?.originalBase64
					? {
							data: photoResult.originalBase64,
							mimetype: "image/jpeg",
							filename: `${character.id || "waifu"}.jpg`,
							isMessageMedia: true
						}
					: null;

		notifySpecialMarriage(bot, character, name, null, null, notifMedia).catch((eNotif) => {
			logger.error("Erro ao notificar casamento especial de waifu:", eNotif);
		});
	}

	if (photoResult && photoResult.success && photoResult.media) {
		return new ReturnMessage({
			chatId,
			content: photoResult.media,
			options: {
				...replyOptions,
				caption: text
			}
		});
	}

	if (photoResult && photoResult.fallback === "original_image" && photoResult.originalBase64) {
		return new ReturnMessage({
			chatId,
			content: {
				data: photoResult.originalBase64,
				mimetype: "image/jpeg",
				isMessageMedia: true
			},
			options: {
				...replyOptions,
				caption: text
			}
		});
	}

	return new ReturnMessage({
		chatId,
		content: text,
		options: replyOptions
	});
}

/**
 * Reivindica casamento com personagem sorteado
 */
async function casarWaifu(bot, message, args) {
	const chatId = message.group ?? message.author;
	const groupId = getGroupId(message);
	const userId = getUserId(message);
	const name = await getUserName(message);

	let characterId = null;
	let matchedRoll = null;

	const isReactionCall = Boolean(
		message.originReaction || (args && args.length === 1 && args[0] === "💍")
	);

	// 1. Se a chamada foi disparada por uma reação (💍) ou originReaction na mensagem de roll
	if (isReactionCall) {
		const targetMsgId =
			message.id || message.originReaction?.msgId?._serialized || message.originReaction?.msgId;
		const rollData = getRollByMessageId(targetMsgId);
		if (rollData) {
			// Se for multi-roll e a reação for 💍, ignorar conforme solicitado pelo usuário
			if (rollData.isMultiRoll) {
				return false;
			}
			characterId = rollData.characterId;
			matchedRoll = rollData;
		} else {
			const text =
				message.caption ||
				(typeof message.content === "string" ? message.content : "") ||
				message.body ||
				"";
			// Se o texto indicar multi-roll e a reação for 💍, ignorar!
			const textSlots = extractMultiRollSlotsFromText(text);
			if (
				textSlots.length > 1 ||
				/🎲\s*Waifuletes!\s*\*?\d+\*?\s*rolls:/i.test(text) ||
				(text.match(/!mu-casar\s+([a-zA-Z0-9_-]+)/gi) || []).length > 1
			) {
				return false;
			}
			const extractedChar = extractCharacterFromRollText(text);
			if (extractedChar) {
				characterId = extractedChar;
				matchedRoll =
					activeClaimsByCharGroup.get(`${groupId}:${characterId}`) ||
					(pendingClaims.get(groupId)?.characterId === characterId
						? pendingClaims.get(groupId)
						: null);
			}
		}
	}

	// 2. Se informou um ID/slug de personagem ou número de slot diretamente como argumento
	if (!characterId && !isReactionCall && args && args.length > 0 && args[0]) {
		const fullInput = args
			.join(" ")
			.trim()
			.replace(/^["']|["']$/g, "");
		const firstArg = args[0].trim();
		if (/^\d+$/.test(firstArg) && args.length === 1) {
			const slotNum = parseInt(firstArg, 10);
			let targetSlots = null;
			let quotedMsg = null;
			let parentRoll = null;
			if (typeof message.origin?.getQuotedMessage === "function") {
				quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
			}
			if (quotedMsg) {
				const qId = quotedMsg.id?._serialized || quotedMsg.id?.id || quotedMsg.id;
				const rollData = getRollByMessageId(qId);
				if (rollData?.slots || rollData?.characters) {
					targetSlots = rollData.slots || rollData.characters;
					parentRoll = rollData;
				}
				if (!targetSlots) {
					const quotedText =
						quotedMsg.caption ||
						(typeof quotedMsg.content === "string" ? quotedMsg.content : "") ||
						quotedMsg.body ||
						"";
					const extracted = extractMultiRollSlotsFromText(quotedText);
					if (extracted && extracted.length > 0) {
						targetSlots = extracted;
					}
				}
			}
			if (!targetSlots) {
				// Sem citação: considera todos os multi-rolls ainda ativos no grupo, não só o último.
				const activeRolls = getActiveMultiRolls(groupId);
				const isClaimableBy = (roll, s) =>
					s.available !== false &&
					!s.claimed &&
					!(
						s.exclusiveUntil &&
						Date.now() < s.exclusiveUntil &&
						roll.rollerUserId &&
						normalizeUserId(roll.rollerUserId) !== userId
					);
				const candidates = [];
				activeRolls.forEach((roll) => {
					const s = (roll.slots || roll.characters || []).find((x) => x.slot === slotNum);
					if (s && isClaimableBy(roll, s)) candidates.push({ roll, slot: s });
				});

				if (candidates.length === 1) {
					targetSlots = candidates[0].roll.slots || candidates[0].roll.characters;
					parentRoll = candidates[0].roll;
				} else if (candidates.length > 1) {
					let text = `⚠️ Há *${candidates.length}* rolagens ativas com o slot ${slotNum} livre! Responda a mensagem da rolagem com \`!mu-c ${slotNum}\` ou case pelo nome:\n\n`;
					candidates.forEach(({ roll, slot: s }) => {
						const by = roll.rollerUserName ? ` _(rolado por ${roll.rollerUserName})_` : "";
						text += `• *${s.characterName}* — ${s.series || ""}${by}\n> !mu-casar ${s.characterId}\n`;
					});
					return new ReturnMessage({
						chatId,
						content: text.trim(),
						options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
					});
				} else {
					// Nenhum candidato livre: usa a rolagem mais recente que tenha o slot para dar o erro adequado
					const withSlot = activeRolls.find((r) =>
						(r.slots || r.characters || []).some((x) => x.slot === slotNum)
					);
					const fallback = withSlot || activeRolls[0] || pendingClaims.get(groupId);
					if (fallback?.slots || fallback?.characters) {
						targetSlots = fallback.slots || fallback.characters;
						parentRoll = fallback;
					}
				}
			}
			if (targetSlots) {
				const foundSlot = targetSlots.find((s) => s.slot === slotNum);
				if (foundSlot) {
					if (foundSlot.available === false) {
						return new ReturnMessage({
							chatId,
							content: `❌ O personagem do slot ${slotNum} (*${foundSlot.characterName}*) já possui um dono!`,
							options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
						});
					}
					if (foundSlot.claimed) {
						return new ReturnMessage({
							chatId,
							content: `❌ O personagem do slot ${slotNum} (*${foundSlot.characterName}*) já foi casado por outro jogador!`,
							options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
						});
					}
					characterId = foundSlot.characterId || foundSlot.characterName;
					matchedRoll = {
						...foundSlot,
						isMultiRoll: true,
						rollerUserId: parentRoll?.rollerUserId || foundSlot.rollerUserId,
						rollerUserName: parentRoll?.rollerUserName || foundSlot.rollerUserName
					};
				} else {
					return new ReturnMessage({
						chatId,
						content: `❌ Slot ${slotNum} não encontrado nesta rolagem!`,
						options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
					});
				}
			} else {
				return new ReturnMessage({
					chatId,
					content: `❌ Nenhuma rolagem com múltiplos personagens encontrada para o slot ${slotNum}!`,
					options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
				});
			}
		} else {
			// Busca por ID ou Nome em activeClaimsByCharGroup do grupo
			let matchedActive =
				activeClaimsByCharGroup.get(`${groupId}:${fullInput}`) ||
				activeClaimsByCharGroup.get(`${groupId}:${firstArg}`);

			if (!matchedActive) {
				const lowerFull = fullInput.toLowerCase();
				const lowerFirst = firstArg.toLowerCase();
				for (const [key, claim] of activeClaimsByCharGroup.entries()) {
					if (key.startsWith(`${groupId}:`)) {
						if (
							claim.characterId?.toLowerCase() === lowerFull ||
							claim.characterName?.toLowerCase() === lowerFull ||
							claim.characterId?.toLowerCase() === lowerFirst ||
							claim.characterName?.toLowerCase() === lowerFirst
						) {
							matchedActive = claim;
							break;
						}
					}
				}
			}

			if (matchedActive) {
				characterId = matchedActive.characterId;
				matchedRoll = matchedActive;
			} else {
				characterId = /^[a-zA-Z0-9_-]+$/.test(firstArg) && args.length === 1 ? firstArg : fullInput;
			}

			if (!matchedRoll) {
				let quotedMsg = null;
				if (typeof message.origin?.getQuotedMessage === "function") {
					quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
				}
				if (quotedMsg) {
					const quotedText =
						quotedMsg.caption ||
						(typeof quotedMsg.content === "string" ? quotedMsg.content : "") ||
						quotedMsg.body ||
						"";
					const extracted = extractMultiRollSlotsFromText(quotedText);
					if (extracted && extracted.length > 0) {
						const found = extracted.find(
							(s) =>
								s.characterId?.toLowerCase() === characterId.toLowerCase() ||
								s.characterName?.toLowerCase() === characterId.toLowerCase() ||
								s.characterName?.toLowerCase() === fullInput.toLowerCase()
						);
						if (found) {
							matchedRoll = found;
							if (found.characterId) characterId = found.characterId;
						}
					}
				}
			}
		}
	}

	// 3. Se a chamada citou uma mensagem (quotedMessage) SEM argumentos
	if (!characterId && (!args || !args[0])) {
		let quotedMsg = null;
		if (typeof message.origin?.getQuotedMessage === "function") {
			quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		}
		if (quotedMsg) {
			const quotedId = quotedMsg.id?._serialized || quotedMsg.id?.id || quotedMsg.id;
			const rollData = getRollByMessageId(quotedId);
			if (rollData) {
				if (rollData.isMultiRoll) {
					const free = (rollData.slots || rollData.characters || []).filter(
						(s) => s.available && !s.claimed
					);
					if (free.length === 1) {
						characterId = free[0].characterId;
						matchedRoll = {
							...free[0],
							isMultiRoll: true,
							rollerUserId: rollData.rollerUserId || free[0].rollerUserId,
							rollerUserName: rollData.rollerUserName || free[0].rollerUserName
						};
					} else if (free.length > 1) {
						return new ReturnMessage({
							chatId,
							content:
								"⚠️ Há múltiplos personagens livres nesta rolagem citada! Reaja com o número do personagem (ex: 1️⃣, 2️⃣) ou responda a mensagem com !mu-c # (número do personagem).",
							options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
						});
					} else {
						return new ReturnMessage({
							chatId,
							content: "❌ Todos os personagens desta rolagem já foram casados!",
							options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
						});
					}
				} else {
					characterId = rollData.characterId;
					matchedRoll = rollData;
				}
			} else {
				const text =
					quotedMsg.caption ||
					(typeof quotedMsg.content === "string" ? quotedMsg.content : "") ||
					quotedMsg.body ||
					"";
				const textSlots = extractMultiRollSlotsFromText(text);
				if (
					textSlots.length > 1 ||
					/🎲\s*Waifuletes!\s*\*?\d+\*?\s*rolls:/i.test(text) ||
					(text.match(/!mu-casar\s+([a-zA-Z0-9_-]+)/gi) || []).length > 1
				) {
					return new ReturnMessage({
						chatId,
						content:
							"⚠️ Há múltiplos personagens livres nesta rolagem citada! Reaja com o número do personagem (ex: 1️⃣, 2️⃣) ou responda a mensagem com !mu-c # (número do personagem).",
						options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
					});
				} else {
					const extractedChar = extractCharacterFromRollText(text);
					if (extractedChar) {
						characterId = extractedChar;
						matchedRoll =
							activeClaimsByCharGroup.get(`${groupId}:${characterId}`) ||
							(pendingClaims.get(groupId)?.characterId === characterId
								? pendingClaims.get(groupId)
								: null);
					}
				}
			}
		}
	}

	// 4. Fallback: busca na janela de claim mais recente do grupo SEM argumentos
	if (!characterId && (!args || !args[0])) {
		const pending = pendingClaims.get(groupId);
		if (!pending || Date.now() > pending.expiresAt) {
			return new ReturnMessage({
				chatId,
				content:
					"❌ Nenhum personagem livre disponível para casamento agora. Use *!mu-roll* primeiro!",
				options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
			});
		}
		if (pending.isMultiRoll) {
			const free = (pending.slots || pending.characters || []).filter(
				(s) => s.available && !s.claimed
			);
			if (free.length === 1) {
				characterId = free[0].characterId;
				matchedRoll = {
					...free[0],
					isMultiRoll: true,
					rollerUserId: pending.rollerUserId || free[0].rollerUserId,
					rollerUserName: pending.rollerUserName || free[0].rollerUserName
				};
			} else if (free.length > 1) {
				return new ReturnMessage({
					chatId,
					content:
						"⚠️ Há múltiplos personagens livres nesta rolagem! Reaja com o número do personagem (ex: 1️⃣, 2️⃣) ou responda a mensagem com !mu-c # (número do personagem).",
					options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
				});
			} else {
				return new ReturnMessage({
					chatId,
					content: "❌ Todos os personagens desta rolagem já foram casados!",
					options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
				});
			}
		} else {
			characterId = pending.characterId;
			matchedRoll = pending;
		}
	}

	if (!matchedRoll) {
		matchedRoll =
			activeClaimsByCharGroup.get(`${groupId}:${characterId}`) ||
			(pendingClaims.get(groupId)?.characterId === characterId ? pendingClaims.get(groupId) : null);
	}

	// Validação de Exclusividade (Incomum, Raro, Épico, Lendário):
	if (
		matchedRoll &&
		matchedRoll.exclusiveUntil &&
		Date.now() < matchedRoll.exclusiveUntil &&
		matchedRoll.rollerUserId &&
		normalizeUserId(matchedRoll.rollerUserId) !== userId
	) {
		const remainingSecs = Math.max(1, Math.ceil((matchedRoll.exclusiveUntil - Date.now()) / 1000));
		const rollerMention = matchedRoll.rollerUserId.includes("@")
			? `@${matchedRoll.rollerUserId.split("@")[0]}`
			: `@${matchedRoll.rollerUserId}`;

		return new ReturnMessage({
			chatId,
			content: `⏳ *Personagem exclusivo!* Este personagem é exclusivo de ${rollerMention} por mais *${remainingSecs}s*!\nAguarde a exclusividade expirar para poder casar.`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin,
				mentions: [toJid(matchedRoll.rollerUserId)]
			}
		});
	}

	// Validação de Disponibilidade: se já rolou como casado/pertencente a outro jogador
	if (matchedRoll && matchedRoll.available === false) {
		const ownerText = matchedRoll.owner ? `*${matchedRoll.owner}*` : "outro jogador";
		return new ReturnMessage({
			chatId,
			content: `🚫 Este personagem já pertence a ${ownerText}! Use *!mu-roll* para encontrar personagens livres.`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	try {
		const { data } = await api.post("/marry", {
			userId,
			groupId,
			characterId,
			name,
			platform: "WHATSAPP"
		});

		if (matchedRoll?.isMultiRoll || pendingClaims.get(groupId)?.isMultiRoll) {
			const pending = pendingClaims.get(groupId);
			if (pending?.slots) {
				const s = pending.slots.find((x) => x.characterId === characterId);
				if (s) s.claimed = true;
				const allFreeClaimed = pending.slots.filter((x) => x.available).every((x) => x.claimed);
				if (allFreeClaimed) {
					pendingClaims.delete(groupId);
				}
			}
		} else {
			const pending = pendingClaims.get(groupId);
			if (pending && (!pending.characterId || pending.characterId === characterId)) {
				pendingClaims.delete(groupId);
			}
		}
		activeClaimsByCharGroup.delete(`${groupId}:${characterId}`);
		const { character, keys, isSoulmate, kakeraBalance } = data.data;
		markMultiRollCharacterClaimed(groupId, characterId);
		if (character?.id && character.id !== characterId) {
			markMultiRollCharacterClaimed(groupId, character.id);
			activeClaimsByCharGroup.delete(`${groupId}:${character.id}`);
		}

		const userMention = userId.includes("@") ? `@${userId.split("@")[0]}` : `@${userId}`;
		let text = `💍 *Parabéns, ${userMention}!* Você se casou com *${character.name}*! 🎉\n`;
		text += `🔑 Chaves: *${keys}/10*\n`;
		text += `💜 Saldo atual: *${kakeraBalance} Zinthos*`;
		if (isSoulmate) {
			text += `\n💖 *${character.name} é sua Soulmate definitiva!*`;
		}

		return await buildMarriageReturnMessage(bot, message, character, userId, name, text, {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin,
			mentions: [toJid(userId)]
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao realizar casamento.", {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		});
	}
}

/**
 * Trata reações numéricas (1️⃣ a 9️⃣) em mensagens de roll para casar com o personagem do respectivo slot
 */
async function processWaifuReaction(bot, message, args, group) {
	if (!message.originReaction) return false;

	const reaction = message.originReaction;
	const slot = getSlotNumberFromEmoji(reaction.reaction);
	if (!slot) return false;

	const targetMsgId = message.id || reaction.msgId?._serialized || reaction.msgId;
	let rollData = getRollByMessageId(targetMsgId);

	// Se não encontrou no cache de mensagem, tenta reconstruir a partir do texto
	if (!rollData) {
		const text =
			message.caption ||
			(typeof message.content === "string" ? message.content : "") ||
			message.body ||
			"";
		const textSlots = extractMultiRollSlotsFromText(text);
		if (textSlots.length > 0) {
			rollData = {
				isMultiRoll: true,
				groupId: getGroupId(message),
				slots: textSlots.map((s) => {
					const exclMs = getExclusiveClaimWindowMs(s.rarity);
					return {
						slot: s.slot,
						characterId: s.characterId,
						characterName: s.characterName,
						series: s.series,
						rarity: s.rarity,
						available: true,
						claimed: false,
						exclusiveUntil: exclMs > 0 ? Date.now() + exclMs : null
					};
				})
			};
		} else if (slot === 1) {
			const isCharSearch =
				getCharSearchByMessageId(targetMsgId) ||
				text.includes("Outros resultados da busca:") ||
				text.includes("👤");
			if (!isCharSearch) {
				const singleCharId = extractCharacterFromRollText(text);
				if (singleCharId) {
					rollData = {
						isMultiRoll: false,
						characterId: singleCharId,
						groupId: getGroupId(message)
					};
				}
			}
		}
	}

	if (!rollData) {
		const text =
			message.caption ||
			(typeof message.content === "string" ? message.content : "") ||
			message.body ||
			"";

		const searchData =
			getCharSearchByMessageId(targetMsgId) || extractCharSearchResultsFromText(text);
		if (searchData && searchData.characters && searchData.characters.length > 0) {
			const targetItem =
				searchData.characters.find((c) => c.slot === slot) || searchData.characters[slot - 1];
			if (targetItem && targetItem.id) {
				return await detalhesPersonagem(bot, message, [targetItem.id], group, {
					quotedMessageId: targetMsgId,
					allResults: searchData.allResults || null
				});
			}
			return false;
		}

		return false;
	}

	const chatId = message.group ?? message.author;
	const groupId = getGroupId(message);
	const userId = getUserId(message);
	const name = await getUserName(message);

	// Se for roll individual (1 roll) e reagiu com 1️⃣
	if (!rollData.isMultiRoll) {
		if (slot === 1) {
			return await casarWaifu(bot, message, [rollData.characterId]);
		}
		return false;
	}

	// Se for roll múltiplo
	const slots = rollData.slots || rollData.characters || [];
	const slotData = slots.find((s) => s.slot === slot);
	if (!slotData) return false;

	if (!slotData.available) {
		return new ReturnMessage({
			chatId,
			content: `❌ O personagem do slot ${slot} (*${slotData.characterName}*) já possui um dono!`,
			options: { quotedMessageId: targetMsgId, goReply: message.origin }
		});
	}

	if (slotData.claimed) {
		return new ReturnMessage({
			chatId,
			content: `❌ O personagem do slot ${slot} (*${slotData.characterName}*) já foi casado por outro jogador!`,
			options: { quotedMessageId: targetMsgId, goReply: message.origin }
		});
	}

	// Validação de exclusividade/reserva
	if (
		slotData.exclusiveUntil &&
		Date.now() < slotData.exclusiveUntil &&
		rollData.rollerUserId &&
		normalizeUserId(rollData.rollerUserId) !== userId
	) {
		const remainingSecs = Math.max(1, Math.ceil((slotData.exclusiveUntil - Date.now()) / 1000));
		const rollerMention = rollData.rollerUserId.includes("@")
			? `@${rollData.rollerUserId.split("@")[0]}`
			: `@${rollData.rollerUserId}`;

		return new ReturnMessage({
			chatId,
			content: `⏳ *Personagem exclusivo!* O personagem do slot ${slot} (*${slotData.characterName}*) é exclusivo de ${rollerMention} por mais *${remainingSecs}s*!\nAguarde a exclusividade expirar para poder casar.`,
			options: {
				quotedMessageId: targetMsgId,
				goReply: message.origin,
				mentions: [toJid(rollData.rollerUserId)]
			}
		});
	}

	try {
		const { data } = await api.post("/marry", {
			userId,
			groupId,
			characterId: slotData.characterId,
			name,
			platform: "WHATSAPP"
		});

		slotData.claimed = true;
		activeClaimsByCharGroup.delete(`${groupId}:${slotData.characterId}`);
		markMultiRollCharacterClaimed(groupId, slotData.characterId);

		const allFreeClaimed = slots.filter((s) => s.available).every((s) => s.claimed);
		if (allFreeClaimed) {
			pendingClaims.delete(groupId);
		}

		const { character, keys, isSoulmate, kakeraBalance } = data.data;

		const userMention = userId.includes("@") ? `@${userId.split("@")[0]}` : `@${userId}`;
		let text = `💍 *Parabéns, ${userMention}!* Você se casou com *${character.name}* (Slot ${slot})! 🎉\n`;
		text += `🔑 Chaves: *${keys}/10*\n`;
		text += `💜 Saldo atual: *${kakeraBalance} Zinthos*`;
		if (isSoulmate) {
			text += `\n💖 *${character.name} é sua Soulmate definitiva!*`;
		}

		return await buildMarriageReturnMessage(bot, message, character, userId, name, text, {
			quotedMessageId: targetMsgId,
			goReply: message.origin,
			mentions: [toJid(userId)]
		});
	} catch (err) {
		return handleApiError(
			err,
			chatId,
			"Erro ao realizar casamento de personagem. Tente novamente."
		);
	}
}

/**
 * Divorcia personagem e resgata Zinthos
 */
async function divorciarWaifu(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content: "❌ Informe o ID do personagem para divórcio.\nExemplo: `!mu-divorciar rem-re-zero`"
		});
	}

	const characterId = args.join(" ").trim();

	try {
		const { data } = await api.post("/divorce", { userId, characterId });
		const {
			character,
			refundedKakera,
			keysLost,
			newKakeraBalance,
			isSoulmate,
			dailyDivorceCount,
			refundRate,
			refundRatePercent,
			nextTierRefundRate
		} = data.data;

		await removeMarriagePhoto(character.id || characterId).catch(() => {});

		const normRarity = String(character.rarity || character.baseRarity || "").toUpperCase();
		const rarityLabel = RARITY_LABEL[normRarity] || normRarity;

		let text = isSoulmate
			? `💖 *Divórcio Dourado (Soulmate)!*\nVocê se separou de *${character.name}*.\n\n`
			: `💔 *Divórcio concluído!*\nVocê se separou de *${character.name}*.\n\n`;

		text += `💰 *Rendimento do Divórcio:* *+${Number(refundedKakera).toLocaleString("pt-BR")} Zinthos*`;
		if (typeof refundRate === "number" && refundRate < 1) {
			text += ` _(${refundRatePercent || `${Math.round(refundRate * 100)}%`} de reembolso — ${dailyDivorceCount}º divórcio ${rarityLabel} hoje)_\n`;
		} else if (dailyDivorceCount === 1) {
			text += ` _(100% integral — 1º divórcio ${rarityLabel} hoje)_\n`;
		} else {
			text += `\n`;
		}

		text += `🔑 Chaves perdidas: ${keysLost}\n`;
		text += `💜 Novo saldo: *${Number(newKakeraBalance).toLocaleString("pt-BR")} Zinthos*`;

		if (typeof nextTierRefundRate === "number") {
			text += `\n\n⚠️ *Aviso de Soft Limite:* O próximo divórcio de raridade *${rarityLabel}* hoje renderá *${Math.round(nextTierRefundRate * 100)}%* do reembolso. O limite reseta às 04:00 BRT.`;
		}

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao processar divórcio.");
	}
}

/**
 * Consulta ou gera a foto oficial de casamento do casal (!mu-foto [nova] <nome>)
 */
async function consultarOuGerarFotoCasamento(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const name = await getUserName(message);

	const rawArgs = [...(args || [])];
	let forceNew = false;
	if (rawArgs.length > 0 && /^(nova|novo)$/i.test(rawArgs[0])) {
		forceNew = true;
		rawArgs.shift();
	}

	if (rawArgs.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"🔍 Informe o nome ou ID do personagem para consultar a foto de casamento.\nExemplo: `!mu-foto Frieren` ou `!mu-foto nova Frieren`"
		});
	}

	const query = rawArgs.join(" ").trim();
	let char = null;

	// 1. Tenta buscar direto por ID/slug exato se não contiver espaços
	if (!/\s/.test(query)) {
		try {
			const { data } = await api.get(`/characters/${encodeURIComponent(query)}`);
			if (data?.data) {
				char = data.data;
			}
		} catch (idErr) {
			if (idErr.response?.status !== 404) {
				logger.debug(`[consultarOuGerarFotoCasamento] Falha na consulta por ID: ${idErr.message}`);
			}
		}
	}

	// 2. Se não encontrou por ID exato, busca ampla no catálogo
	if (!char) {
		try {
			const { data } = await api.get("/characters", {
				params: { search: query, limit: 6 }
			});
			const results = data.data?.data || [];
			if (results.length > 0) {
				const normQ = query.toLowerCase();
				const exactId = results.find((c) => c.id?.toLowerCase() === normQ);
				const exactName = results.find((c) => c.name?.toLowerCase() === normQ);
				const startsName = results.find((c) => c.name?.toLowerCase().startsWith(normQ));
				char = exactId || exactName || startsName || results[0];
			}
		} catch (searchErr) {
			logger.error(`[consultarOuGerarFotoCasamento] Erro na busca ampla: ${searchErr.message}`);
		}
	}

	if (!char) {
		return new ReturnMessage({
			chatId,
			content: `🔍 Nenhum personagem encontrado para "${query}".`
		});
	}

	// 3. Validação de Casamento
	if (!char.isClaimed || !char.owner) {
		return new ReturnMessage({
			chatId,
			content: `❌ *${char.name}* ainda não é casado(a) com ninguém! Use *!mu-roll* para encontrar e casar com waifus.`
		});
	}

	const ownerId = char.owner.id || "";
	const isOwner = normalizeUserId(ownerId) === normalizeUserId(userId);
	const spouseMention = ownerId.includes("@") ? `@${ownerId.split("@")[0]}` : `@${ownerId}`;
	const userMention = userId.includes("@") ? `@${userId.split("@")[0]}` : `@${userId}`;

	// 4. Se solicitou explicitamente nova foto com 'nova'
	if (forceNew) {
		if (!isOwner) {
			return new ReturnMessage({
				chatId,
				content: `❌ Apenas o cônjuge (${spouseMention}) pode gerar uma nova foto de casamento com *${char.name}*!`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin,
					mentions: [toJid(ownerId)]
				}
			});
		}

		message.origin?.react?.(process.env.LOADING_EMOJI ?? "⌛️").catch(() => {});
		const photoResult = await generateAndSaveMarriageImage(bot, message, char, userId, name);

		if (photoResult && photoResult.success && photoResult.media) {
			let caption = `💍 *Nova Foto de Casamento!* 📸\n`;
			caption += `👰 Casal: ${userMention} & *${char.name}*${char.series ? ` (${char.series})` : ""}\n`;
			caption += `✨ A nova foto oficial foi gerada e atualizada no álbum!`;

			return new ReturnMessage({
				chatId,
				content: photoResult.media,
				options: {
					caption,
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin,
					mentions: [toJid(userId)]
				}
			});
		}

		return new ReturnMessage({
			chatId,
			content:
				"❌ Não foi possível gerar a nova foto de casamento no momento. Tente novamente mais tarde.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	// 5. Consulta normal (!mu-foto <personagem>)
	const existingPhoto = await getMarriagePhoto(char.id);

	if (existingPhoto.exists) {
		let media = null;
		if (bot && typeof bot.createMedia === "function") {
			media = await bot.createMedia(existingPhoto.photoPath, "image/jpeg").catch(() => null);
		}

		if (!media) {
			try {
				const buf = await fs.readFile(existingPhoto.photoPath);
				media = {
					data: buf.toString("base64"),
					mimetype: "image/jpeg",
					isMessageMedia: true
				};
			} catch (_) {}
		}

		if (media) {
			let caption = `💍 *Álbum de Casamento* 📸\n`;
			caption += `👰 Casal: ${spouseMention} & *${char.name}*${char.series ? ` (${char.series})` : ""}\n`;
			if (isOwner) {
				caption += `💡 _Envie \`!mu-foto nova ${char.id}\` para gerar uma nova foto e substituir a atual._`;
			}

			return new ReturnMessage({
				chatId,
				content: media,
				options: {
					caption,
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin,
					mentions: [toJid(ownerId)]
				}
			});
		}
	}

	// Se não existe foto salva ainda (casamentos passados):
	if (!isOwner) {
		return new ReturnMessage({
			chatId,
			content: `📷 Este casamento ainda não possui uma foto oficial registrada no álbum, e apenas o cônjuge (${spouseMention}) pode tirar a primeira foto!`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin,
				mentions: [toJid(ownerId)]
			}
		});
	}

	// O cônjuge chamou !mu-foto e o casamento não tinha foto salva: gera na hora!
	message.origin?.react?.(process.env.LOADING_EMOJI ?? "⌛️").catch(() => {});
	const photoResult = await generateAndSaveMarriageImage(bot, message, char, userId, name);

	if (photoResult && photoResult.success && photoResult.media) {
		let caption = `💍 *Foto de Casamento Registrada!* 📸\n`;
		caption += `👰 Casal: ${userMention} & *${char.name}*${char.series ? ` (${char.series})` : ""}\n`;
		caption += `✨ A foto de casamento foi gerada com sucesso e arquivada no álbum!`;

		return new ReturnMessage({
			chatId,
			content: photoResult.media,
			options: {
				caption,
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin,
				mentions: [toJid(userId)]
			}
		});
	}

	return new ReturnMessage({
		chatId,
		content:
			"❌ Não foi possível gerar a foto do casamento no momento. Tente novamente mais tarde.",
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		}
	});
}

/**
 * Dá like em um personagem
 */
async function likeWaifu(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content: "❌ Informe o ID do personagem para curtir.\nExemplo: `!mu-like rem-re-zero`"
		});
	}

	const characterId = args.join(" ").trim();

	try {
		const { data } = await api.post("/like", { userId, characterId });
		const { name, likeCount } = data.data;

		return new ReturnMessage({
			chatId,
			content: `❤️ Você curtiu *${name}*! Total de curtidas: *${likeCount}*`
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao curtir personagem.");
	}
}

/**
 * Resgata recompensa diária de Zinthos
 */
async function diariosKakera(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const groupId = getGroupId(message);
	const name = await getUserName(message);

	try {
		const { data } = await api.post("/kakera/daily", { userId, groupId, name });
		return formatDailyRewardMessage(chatId, data.data);
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao resgatar recompensa diária.");
	}
}

/**
 * Consulta saldo de Zinthos
 */
async function saldoKakera(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const { data } = await api.get(`/kakera/${userId}`);
		const balance = data.data.balance ?? 0;

		return new ReturnMessage({
			chatId,
			content: `💜 *Seu Saldo:* *${balance} Zinthos*`
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar saldo.");
	}
}

/**
 * Concede Zinthos (Kakera) para um usuário via API administrativa do Waifuletes
 * @param {string} userId - ID ou número do usuário (WhatsApp)
 * @param {number} amount - Quantidade de Zinthos a conceder
 * @param {Object} [metadata={}] - Metadados adicionais (ex: donorName, totalAmount)
 * @returns {Promise<Object>}
 */
async function grantZinthos(userId, amount, metadata = {}) {
	try {
		const cleanId = normalizeUserId(String(userId));
		if (!cleanId || !amount || amount <= 0) {
			return { success: false, reason: "Parâmetros inválidos para concessão de Zinthos" };
		}
		const response = await api.post("/admin/kakera/give", {
			userId: cleanId,
			amount: Math.round(amount),
			reason: "ADMIN_GRANT",
			metadata: {
				source: "DONOR_BONUS",
				...metadata
			}
		});
		return response.data;
	} catch (err) {
		logger.error(
			`[grantZinthos] Erro ao creditar ${amount} Zinthos para ${userId}:`,
			err?.response?.data || err.message
		);
		throw err;
	}
}

/**
 * Concede Zinthos para toda a comunidade de jogadores de Waifus
 * @param {number} amount
 * @param {Object} [metadata={}]
 * @returns {Promise<{ success: boolean, count: number }>}
 */
async function grantZinthosAll(amount, metadata = {}) {
	const cleanAmount = Math.max(0, Math.round(Number(amount) || 0));
	if (cleanAmount <= 0) {
		return { success: false, count: 0, reason: "Quantidade inválida" };
	}

	try {
		const response = await api.post("/admin/kakera/give-all", {
			amount: cleanAmount,
			reason: "EVENT_REWARD",
			metadata: { source: "INSTANT_EVENT", ...metadata }
		});
		if (response.data?.success) {
			return { success: true, count: response.data.count ?? response.data.data?.count ?? 0 };
		}
	} catch (_) {}

	// Fallback caso /admin/kakera/give-all não esteja implementada ou ativa na imagem:
	try {
		const { data: usersData } = await api.get("/leaderboard/users", { params: { limit: 1000 } });
		const users = Array.isArray(usersData) ? usersData : usersData?.data || [];
		let count = 0;
		for (const u of users) {
			const uId = u.id || u.userId;
			if (!uId) continue;
			try {
				await api.post("/admin/kakera/give", {
					userId: String(uId),
					amount: cleanAmount,
					reason: "EVENT_REWARD",
					metadata: { source: "INSTANT_EVENT", ...metadata }
				});
				count++;
			} catch (_) {}
		}
		return { success: true, count };
	} catch (err) {
		logger.error(`[grantZinthosAll] Erro ao creditar Zinthos em massa: ${err.message}`);
		return { success: false, count: 0, error: err.message };
	}
}

/**
 * Retorna todos os IDs de usuários cadastrados no Waifuletes
 * @returns {Promise<string[]>}
 */
async function getAllWaifuUserIds() {
	try {
		const res = await api.get("/admin/users/ids");
		if (res.data?.success && Array.isArray(res.data.userIds)) {
			return res.data.userIds.map((id) => normalizeUserId(String(id))).filter(Boolean);
		}
	} catch (_) {}

	// Fallback via leaderboard de usuários
	try {
		const { data: usersData } = await api.get("/leaderboard/users", { params: { limit: 500 } });
		const users = Array.isArray(usersData)
			? usersData
			: usersData?.data?.topRich || usersData?.data || [];
		const ids = new Set();
		for (const u of users) {
			const uId = normalizeUserId(String(u.id || u.userId || ""));
			if (uId) ids.add(uId);
		}
		return Array.from(ids);
	} catch (err) {
		logger.error(`[getAllWaifuUserIds] Erro ao buscar lista de usuários: ${err.message}`);
		return [];
	}
}

/**
 * Lista o harém do usuário de forma paginada (próprio ou de outro usuário com @)
 */
async function verHarem(bot, message, args) {
	const chatId = message.group ?? message.author;
	const senderId = getUserId(message);
	const targetUserId = extractFirstMention(message, args, bot?.wid) || senderId;
	const isSelf = normalizeUserId(targetUserId) === normalizeUserId(senderId);

	const page =
		parseInt(
			(args || []).find((a) => /^\d+$/.test(a)),
			10
		) || 1;
	const limit = 15;

	try {
		const [haremRes, colsRes] = await Promise.all([
			api.get(`/harem/${targetUserId}`, {
				params: { page, limit, sort: "keys", withoutCollection: true }
			}),
			api.get(`/user/${targetUserId}/collections`).catch(() => ({ data: { data: [] } }))
		]);

		const haremData = haremRes.data?.data || {};
		const entries = haremData.data || [];
		const totalGeneral = haremData.total || 0;
		const totalPages = haremData.totalPages || 1;
		const collections = colsRes.data?.data || [];

		// Se o usuário alvo privou seu harém e o solicitante não for o próprio dono
		if (!isSelf && haremData.haremPrivate) {
			const targetName = haremData.userName || "O usuário";
			return new ReturnMessage({
				chatId,
				content: `🔒 *Harém Privado!*\n\n${targetName} optou por privar seu harém e seus personagens não estão visíveis.`
			});
		}

		// Filtra coleções e waifus privadas se for outro usuário visualizando
		const visibleCollections = isSelf ? collections : collections.filter((col) => !col.isPrivate);

		// Filtra waifus de coleções privadas se for outro usuário visualizando
		const visibleEntries = isSelf ? entries : entries.filter((item) => !item.collection?.isPrivate);

		// Soma total do harém (geral + coleções visíveis)
		const totalInCols = visibleCollections.reduce((acc, col) => acc + (col.characterCount || 0), 0);
		const total = totalGeneral + totalInCols;

		let haremTitle;
		if (isSelf) {
			haremTitle = haremData.haremName ? `*${haremData.haremName}*` : "*Seu Harém*";
		} else {
			const targetName = haremData.userName || "Jogador";
			haremTitle = haremData.haremName ? `*${haremData.haremName}*` : `*Harém de ${targetName}*`;
		}

		if (visibleEntries.length === 0 && totalInCols === 0) {
			return new ReturnMessage({
				chatId,
				content: isSelf
					? `👰 ${haremTitle} está vazio! Use *!mu-roll* para encontrar e casar com waifus e husbandos.`
					: `👰 ${haremTitle} está vazio!`
			});
		}

		let text = `👰 ${haremTitle} (Total: ${total} | Pág ${page}/${totalPages}):\n`;
		if (isSelf && haremData.haremPrivate) {
			text += `🔒 _(Seu harém está privado para outros jogadores)_\n`;
		}
		text += `\n`;

		// Se for a primeira página, agrupa míticos, favoritas e lista coleções completas com árvore
		if (page === 1) {
			const mythics = visibleEntries.filter(
				(item) =>
					item.character?.isMythic ||
					String(item.character?.rarity || "").toUpperCase() === "MYTHIC"
			);
			const favorites = visibleEntries.filter(
				(item) =>
					item.isFavorite &&
					!item.character?.isMythic &&
					String(item.character?.rarity || "").toUpperCase() !== "MYTHIC"
			);
			// As que estão em alguma pasta ou são míticas NÃO aparecem em demais personagens
			const rest = visibleEntries.filter(
				(item) =>
					!item.isFavorite &&
					!item.collectionId &&
					!item.character?.isMythic &&
					String(item.character?.rarity || "").toUpperCase() !== "MYTHIC"
			);

			if (favorites.length > 0) {
				text += `⭐ *Favoritas em Destaque:*\n`;
				favorites.forEach((item, index) => {
					const char = item.character;
					const sm = item.keys >= 10 ? " 💖" : "";
					const emojiRarity = RARITY_EMOJI[char.baseRarity || char.rarity] || "⚪";

					const numStr = String(index + 1).padStart(2, "0");
					text += `${numStr}. ⭐ ${emojiRarity} *${char.name}*${sm} — _${char.series}_\n`;
					text += `   ↳ ID: \`${char.id}\` | 🔑 *${item.keys}/10*\n`;
				});
				text += `\n`;
			}

			// Coleções com árvore de personagens (estilo FileManager / ListCommands)
			const hasMythics = mythics.length > 0;
			const totalColecoesCount = visibleCollections.length + (hasMythics ? 1 : 0);

			if (totalColecoesCount > 0) {
				text += `📁 *Coleções (${totalColecoesCount}/15):*\n`;

				// Se o usuário tiver míticos, a primeira coleção da lista deve ser "Míticos"
				if (hasMythics) {
					text += `📂 *Míticos* (${mythics.length} waifu${mythics.length !== 1 ? "s" : ""}):\n`;
					mythics.forEach((item, j) => {
						const char = item.character;
						const isLast = j === mythics.length - 1;
						const connector = isLast ? "└─" : "├─";
						const charLink =
							getCharacterWebUrl(char.id) ||
							`https://waifuletes.moothz.com/character/${encodeURIComponent(char.id)}`;
						text += `   ${connector} 🔮 *${char.name}* — _${char.series || "Sem Série"}_ (${charLink})\n`;
					});
				}

				visibleCollections.forEach((col) => {
					const chars = col.characters || [];
					const lock = isSelf && col.isPrivate ? " 🔒" : "";
					text += `📂 *${col.name}*${lock} (${chars.length} waifu${chars.length !== 1 ? "s" : ""}):\n`;
					if (chars.length === 0) {
						text += `   └─ _(pasta vazia)_\n`;
					} else {
						const maxVisible = 15;
						const visibleChars = chars.slice(0, maxVisible);
						const remaining = chars.length - maxVisible;

						visibleChars.forEach((char, j) => {
							const isLast = j === visibleChars.length - 1 && remaining <= 0;
							const connector = isLast ? "└─" : "├─";
							const isCharMythic = Boolean(
								char.isMythic || String(char.rarity || "").toUpperCase() === "MYTHIC"
							);
							const emojiRarity = isCharMythic
								? "🔮"
								: RARITY_EMOJI[char.baseRarity || char.rarity] || "⚪";
							const fav = char.isFavorite ? "⭐ " : "";
							const charLink =
								getCharacterWebUrl(char.id) ||
								`https://waifuletes.moothz.com/character/${encodeURIComponent(char.id)}`;

							const keys = Number(char.keys ?? 0);
							let tagInfo = charLink;
							if (keys >= 10) {
								tagInfo = `${charLink} | 💞`;
							} else if (keys >= 2) {
								tagInfo = `${charLink} | 🔑 *${keys}/10*`;
							}

							text += `   ${connector} ${fav}${emojiRarity} *${char.name}* — _${char.series}_ (${tagInfo})\n`;
						});

						if (remaining > 0) {
							text += `   └─ _... e mais ${remaining} waifus (digite \`!mu-colecoes ${col.name}\` para ver todas)_\n`;
						}
					}
				});
				text += `\n`;
			}

			if (rest.length > 0) {
				text += `👰 *Demais Personagens (Harém Geral):*\n`;
				rest.forEach((item, index) => {
					const char = item.character;
					const pos = favorites.length + index + 1;
					const sm = item.keys >= 10 ? " 💖" : "";
					const emojiRarity = RARITY_EMOJI[char.baseRarity || char.rarity] || "⚪";

					const numStr = String(pos).padStart(2, "0");
					text += `${numStr}. ${emojiRarity} *${char.name}*${sm} — _${char.series}_\n`;
					text += `   ↳ ID: \`${char.id}\` | 🔑 *${item.keys}/10*\n`;
				});
			}
		} else {
			// Páginas seguintes (page > 1): omite as que estão em coleção
			const pageEntries = visibleEntries.filter((item) => !item.collectionId);
			pageEntries.forEach((item, index) => {
				const char = item.character;
				const pos = (page - 1) * limit + index + 1;
				const fav = item.isFavorite ? "⭐ " : "";
				const sm = item.keys >= 10 ? " 💖" : "";
				const emojiRarity = RARITY_EMOJI[char.baseRarity || char.rarity] || "⚪";
				const numStr = String(pos).padStart(2, "0");

				text += `${numStr}. ${fav}${emojiRarity} *${char.name}*${sm} — _${char.series}_\n`;
				text += `   ↳ ID: \`${char.id}\` | 🔑 *${item.keys}/10*\n`;
			});
		}

		if (page < totalPages) {
			if (isSelf) {
				text += `\n_Digite \`!mu-harem ${page + 1}\` para a próxima página._`;
			} else {
				const targetPhone = targetUserId.split("@")[0];
				text += `\n_Digite \`!mu-harem @${targetPhone} ${page + 1}\` para a próxima página._`;
			}
		}

		const returnOpts = !isSelf ? { mentions: [toJid(targetUserId)] } : {};
		return new ReturnMessage({ chatId, content: text, options: returnOpts });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar harém.");
	}
}

/**
 * Define ou altera o nome personalizado do harém (máx 20 caracteres)
 * !mu-harem-nome [novo nome | reset]
 */
async function definirNomeHarem(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	// Se não passou argumentos, busca o nome atual
	if (!args || args.length === 0) {
		try {
			const { data } = await api.get(`/user/${userId}`);
			const currentName = data?.data?.haremName;
			if (currentName) {
				return new ReturnMessage({
					chatId,
					content: `👑 Seu harém se chama *${currentName}*.\nPara alterar, use: \`!mu-harem-nome <novo nome>\` (máx 20 caracteres)\nPara restaurar o padrão: \`!mu-harem-nome reset\``
				});
			} else {
				return new ReturnMessage({
					chatId,
					content: `👑 Seu harém ainda não possui um nome personalizado.\nDefina usando: \`!mu-harem-nome <nome>\` (máx 20 caracteres)`
				});
			}
		} catch (err) {
			return handleApiError(err, chatId, "Erro ao consultar nome do harém.");
		}
	}

	const rawInput = args.join(" ").trim();
	const isReset = /^(reset|padrao|padrão|limpar|remover)$/i.test(rawInput);
	const newName = isReset ? null : rawInput;

	if (newName && newName.length > 20) {
		return new ReturnMessage({
			chatId,
			content: `❌ O nome do harém deve ter no máximo 20 caracteres! (O seu tem ${newName.length})`
		});
	}

	try {
		await api.patch(`/user/${userId}/harem-name`, { haremName: newName });
		if (isReset) {
			return new ReturnMessage({
				chatId,
				content: `👑 O nome do seu harém foi restaurado para o padrão (*Seu Harém*)!`
			});
		} else {
			return new ReturnMessage({
				chatId,
				content: `👑 O nome do seu harém foi definido para *${newName}*!`
			});
		}
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao atualizar nome do harém.");
	}
}

/**
 * Alterna ou define a privacidade do harém (!mu-harem-privado [on|off])
 */
async function alternarPrivacidadeHarem(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		// 1. Busca dados atuais do harém para saber o estado atual
		const { data } = await api.get(`/harem/${userId}`, {
			params: { page: 1, limit: 1 }
		});
		const currentPrivate = Boolean(data?.data?.haremPrivate);

		let targetState;
		const arg = (args?.[0] || "").toLowerCase();
		if (["on", "privado", "sim", "true", "1", "ativar"].includes(arg)) {
			targetState = true;
		} else if (
			["off", "publico", "público", "nao", "não", "false", "0", "desativar"].includes(arg)
		) {
			targetState = false;
		} else {
			targetState = !currentPrivate;
		}

		await api.patch(`/harem/${userId}/privacy`, { isPrivate: targetState });

		if (targetState) {
			return new ReturnMessage({
				chatId,
				content:
					"🔒 *Seu harém agora é PRIVADO!*\n\nOutros usuários não poderão ver seus personagens através de `!mu-harem @você` nem na versão web pública."
			});
		} else {
			return new ReturnMessage({
				chatId,
				content:
					"🔓 *Seu harém agora é PÚBLICO!*\n\nOutros usuários podem visualizar seus personagens e coleções públicas através de `!mu-harem @você`."
			});
		}
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao alterar privacidade do harém.");
	}
}

/**
 * Consulta fotos disponíveis ou fixa uma foto no card do harém
 * !mu-harem-foto <personagem> [índice | casamento | reset]
 */
async function gerenciarFotoHarem(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	const rawStr = (args || []).join(" ").trim();
	if (!rawStr) {
		return new ReturnMessage({
			chatId,
			content:
				"📸 *Gerenciamento de Foto no Card do Harém*\n\n" +
				"• Consultar fotos: `!mu-harem-foto <personagem>`\n" +
				"• Fixar foto do catálogo: `!mu-harem-foto <personagem> <número>`\n" +
				"• Fixar foto de casamento: `!mu-harem-foto <personagem> casamento`\n" +
				"• Voltar para fotos aleatórias: `!mu-harem-foto <personagem> reset`"
		});
	}

	let charQuery = "";
	let actionArg = null;

	if (rawStr.includes("|")) {
		const parts = rawStr.split("|");
		charQuery = parts[0].trim();
		actionArg = parts.slice(1).join("|").trim();
	} else if (args && args.length >= 2) {
		const last = args[args.length - 1];
		if (
			/^\d+$/.test(last) ||
			/^(casamento|marriage|reset|random|aleatoria|aleatória|padrao|padrão|none|remover)$/i.test(
				last
			)
		) {
			actionArg = last;
			charQuery = args.slice(0, -1).join(" ").trim();
		} else {
			charQuery = rawStr;
		}
	} else {
		charQuery = rawStr;
	}

	if (!charQuery) {
		return new ReturnMessage({
			chatId,
			content: "❌ Informe o nome ou ID do personagem do seu harém."
		});
	}

	try {
		const char = await resolveCharacter(charQuery);
		if (!char) {
			return new ReturnMessage({
				chatId,
				content: `❌ Personagem "${charQuery}" não encontrado.`
			});
		}

		// Se nenhuma ação informada, consulta fotos disponíveis (GET /harem/:userId/:charId/photos)
		if (!actionArg) {
			const { data: res } = await api.get(
				`/harem/${encodeURIComponent(userId)}/${encodeURIComponent(char.id)}/photos`
			);
			const photoData = res.data;

			let text = `📸 *Opções de Foto para ${photoData.characterName} no seu Harém:*\n\n`;

			if (photoData.pinnedPhoto) {
				const pinType = photoData.marriage?.isPinned
					? "💒 Foto de Casamento"
					: "🖼️ Foto Fixa do Catálogo";
				text += `📌 *Status atual:* ${pinType} fixada.\n\n`;
			} else {
				text += `🎲 *Status atual:* Exibindo fotos aleatórias a cada consulta.\n\n`;
			}

			text += `🖼️ *Fotos do Catálogo (${photoData.photos.length}):*\n`;
			photoData.photos.forEach((p) => {
				const pin = p.isPinned ? " 📌 (FIXADA)" : "";
				text += `  • Foto *${p.index}*${pin}\n`;
			});

			text += `\n💒 *Foto de Casamento:*\n`;
			if (photoData.marriage?.exists) {
				const pin = photoData.marriage.isPinned ? " 📌 (FIXADA)" : "";
				text += `  • Disponível${pin}\n`;
			} else {
				text += `  • _Ainda não gerada (use \`!mu-foto ${char.name}\` para pedir)_\n`;
			}

			text += `\n💡 *Para alterar a foto exibida:*\n`;
			text += `• Fixar foto do catálogo: \`!mu-harem-foto ${char.name} <1-${photoData.photos.length}>\`\n`;
			if (photoData.marriage?.exists) {
				text += `• Fixar foto de casamento: \`!mu-harem-foto ${char.name} casamento\`\n`;
			}
			text += `• Restaurar fotos aleatórias: \`!mu-harem-foto ${char.name} reset\``;

			return new ReturnMessage({ chatId, content: text });
		}

		// Se ação informada, fixa ou remove foto (PUT /harem/:userId/:charId/photo)
		let photoPayload;
		if (/^(reset|random|aleatoria|aleatória|padrao|padrão|none|remover)$/i.test(actionArg)) {
			photoPayload = null;
		} else if (/^(casamento|marriage)$/i.test(actionArg)) {
			photoPayload = "marriage";
		} else if (/^\d+$/.test(actionArg)) {
			photoPayload = parseInt(actionArg, 10);
		} else {
			photoPayload = actionArg;
		}

		const { data: putRes } = await api.put(
			`/harem/${encodeURIComponent(userId)}/${encodeURIComponent(char.id)}/photo`,
			{ photo: photoPayload }
		);

		const resultMessage = putRes.message || putRes.data?.message;
		let replyMsg = "";
		if (photoPayload === null) {
			replyMsg = `🎲 *${char.name}* voltou a exibir fotos aleatórias no seu card do harém!`;
		} else if (photoPayload === "marriage") {
			replyMsg = `💒 A foto oficial de casamento de *${char.name}* foi fixada no card do harém!`;
		} else {
			replyMsg =
				resultMessage || `📌 Foto fixa definida com sucesso para *${char.name}* no seu harém!`;
		}

		return new ReturnMessage({ chatId, content: replyMsg });
	} catch (err) {
		if (err.response?.data?.error?.code === "NO_MARRIAGE_PHOTO") {
			return new ReturnMessage({
				chatId,
				content: `❌ Este casal ainda não possui foto de casamento salva! Use \`!mu-foto ${charQuery}\` para gerar uma primeiro.`
			});
		}
		if (err.response?.data?.error?.code === "NOT_IN_HAREM") {
			return new ReturnMessage({
				chatId,
				content: `❌ *${charQuery}* não faz parte do seu harém!`
			});
		}
		return handleApiError(err, chatId, "Erro ao gerenciar foto do harém.");
	}
}

/**
 * Consulta perfil do usuário
 */
async function verPerfil(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const { data } = await api.get(`/user/${userId}`);
		const user = data.data;

		const haremCount = user.haremCount ?? user._count?.harem ?? 0;
		const soulmateCount = user.soulmateCount ?? user._count?.soulmates ?? 0;
		const wishlistCount = user.wishlistCount ?? user._count?.wishlist ?? 0;
		const favoriteChars =
			user.favoriteCharacters ||
			(user.harem
				? user.harem.filter((h) => h.isFavorite).map((h) => h.character)
				: user.harem?.[0]?.character
					? [user.harem[0].character]
					: []);

		let text = `🎮 *Perfil de ${user.name}*\n\n`;
		text += `💜 Zinthos: *${user.kakera}*\n`;
		text += `👰 Harém: *${haremCount} personagens*\n`;
		text += `💖 Soulmates: *${soulmateCount}*\n`;
		text += `🌟 Wishlist: *${wishlistCount}/${WISHLIST_MAX_ITEMS}*\n`;

		if (favoriteChars.length > 0) {
			text += `💖 *Favoritas em Destaque (${favoriteChars.length}/5):*\n`;
			favoriteChars.forEach((f, idx) => {
				const numStr = String(idx + 1).padStart(2, "0");
				text += `  ${numStr}. *${f.name}* (${f.series || "Sem série"})\n`;
			});
		}

		text += `📅 No jogo desde: *${new Date(user.createdAt).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}*`;

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao buscar perfil.");
	}
}

/**
 * Consulta lista de desejos (Wishlist)
 */
async function verWishlist(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const { data } = await api.get(`/wishlist/${userId}`);
		const wishlist = data.data || [];

		if (wishlist.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `🌟 *Sua Wishlist está vazia!*\nAdicione personagens com \`!mu-desejar <id>\` (até ${WISHLIST_MAX_ITEMS}) para aumentar suas chances de roll!\nUse \`!mu-chances\` para ver a tabela completa de probabilidades.`
			});
		}

		const casadas = wishlist.filter((item) => item.isMarried || item.character?.isMarried);
		let avisoCasadas = "";
		if (casadas.length > 0) {
			avisoCasadas = `⚠️ *Aviso:* ${casadas.length} personagem(ns) da sua Wishlist já estão casadas! Elas continuam na lista mas não podem ser reivindicadas normalmente.\n💡 Use \`!mu-wishlist-limpar\` para removê-las e liberar espaço!\n\n`;
		}

		const stats = await getDropRateStats(userId);
		let text = `${avisoCasadas}🌟 *Sua Lista de Desejos* (${wishlist.length}/${WISHLIST_MAX_ITEMS}):\n\n`;
		wishlist.forEach((item, idx) => {
			const char = item.character;
			const emojiRarity = RARITY_EMOJI[char.baseRarity || char.rarity] || "⚪";
			const star = item.isStarWish ? "⭐ " : "";
			const isMarried = Boolean(item.isMarried || char.isMarried);
			const marriedIcon = isMarried ? " 💍" : "";
			text += `${idx + 1}. ${emojiRarity} *${char.name}*${marriedIcon} — _${char.series}_\n   ↳ ID: \`${char.id}\`${star ? " *(Star Wish)*" : ""}\n`;
		});

		text += `\n💡 *Bônus de Drop:* Cada item na sua lista tem o peso aumentado em *+50%* (+100% se Star Wish).\n`;
		if (stats?.userWishlistStats?.anyWishChance) {
			const wishChanceStr =
				stats.userWishlistStats.anyWishChance < 0.01
					? stats.userWishlistStats.anyWishChance.toFixed(3)
					: stats.userWishlistStats.anyWishChance.toFixed(2);
			text += `🎯 Chance total de rolar um desejo seu no próximo roll: *${wishChanceStr}%*`;
			if (stats.userWishlistStats.oneInX) {
				text += ` (~1 em cada *${stats.userWishlistStats.oneInX.toLocaleString("pt-BR")}* rolls)`;
			}
			text += `\n`;
		}
		text += `📊 Para ver todas as probabilidades do catálogo, envie \`!mu-chances\`.\n`;
		text += `_Para remover: \`!mu-removerdesejo <id>\` ou \`!mu-wishlist-limpar\`_`;
		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar wishlist.");
	}
}

/**
 * Adiciona personagem à wishlist
 */
async function adicionarDesejo(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const groupId = getGroupId(message);
	const name = await getUserName(message);

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Informe o ID do personagem para adicionar à Wishlist.\nExemplo: `!mu-desejar rem-re-zero`\nUse `!mu-personagens <nome>` para buscar o ID."
		});
	}

	const characterId = args.join(" ").trim();

	try {
		await ensureUser(userId, groupId, name);
		const { data } = await api.post("/wishlist", { userId, characterId });
		const msgText = data.data?.message || "Personagem adicionado à Wishlist com sucesso!";
		const responseText = `🌟 ${msgText}\n↳ *Bônus ativado:* +50% de peso no sorteio para este personagem!\n💡 Sua Wishlist comporta até *${WISHLIST_MAX_ITEMS}* personagens. Digite \`!mu-wishlist\` para ver sua lista ou \`!mu-chances\` para ver suas probabilidades.`;

		return new ReturnMessage({
			chatId,
			content: responseText
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao adicionar à wishlist.");
	}
}

/**
 * Remove personagem da wishlist
 */
async function removerDesejo(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Informe o ID do personagem para remover da Wishlist.\nExemplo: `!mu-removerdesejo rem-re-zero`"
		});
	}

	const characterId = args.join(" ").trim();

	try {
		await api.delete(`/wishlist/${encodeURIComponent(userId)}/${encodeURIComponent(characterId)}`);
		return new ReturnMessage({
			chatId,
			content: `🗑️ Personagem \`${characterId}\` removido da sua Wishlist (limite de até ${WISHLIST_MAX_ITEMS}).`
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao remover da wishlist.");
	}
}

/**
 * Remove todas as waifus casadas da wishlist do usuário
 */
async function limparWishlistCasadas(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const groupId = getGroupId(message);
	const name = await getUserName(message);

	try {
		await ensureUser(userId, groupId, name);
		const { data } = await api.delete(`/wishlist/${encodeURIComponent(userId)}/married`);
		const removed = data.data?.removed || [];

		if (removed.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"🧹 *Nenhuma waifu casada encontrada na sua Wishlist!*\nTodas as waifus da sua lista ainda estão livres para claim."
			});
		}

		let text = `🧹 *Wishlist Limpa com Sucesso!*\nForam removidas *${removed.length}* waifu(s) que já estavam casadas:\n\n`;
		removed.forEach((char, idx) => {
			const emojiRarity = RARITY_EMOJI[char.baseRarity || char.rarity] || "⚪";
			text += `${idx + 1}. ${emojiRarity} *${char.name}* 💍 — _${char.series}_\n`;
		});
		text += `\n✨ Espaço liberado! Use \`!mu-desejar <id>\` para adicionar novas waifus à sua lista.`;

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao limpar casadas da wishlist.");
	}
}

/**
 * Define personagem favorito em destaque
 */
async function definirFavorita(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Informe o ID do personagem do seu harém para definir como favorito.\nExemplo: `!mu-favorito rem-re-zero`"
		});
	}

	const rawInput = args.join(" ").trim();
	let targetId = rawInput;

	try {
		// Tenta resolver o personagem por slug ou nome para obter o ID exato
		try {
			const { data: charData } = await api.get(`/characters/${encodeURIComponent(rawInput)}`, {
				timeout: 4000
			});
			if (charData?.data?.id) {
				targetId = charData.data.id;
			}
		} catch (_) {
			try {
				const { data: searchData } = await api.get("/characters", {
					params: { search: rawInput, limit: 1 },
					timeout: 4000
				});
				if (searchData?.data?.data?.[0]?.id) {
					targetId = searchData.data.data[0].id;
				}
			} catch (__) {
				// Mantém targetId original
			}
		}

		const { data } = await api.patch(
			`/harem/${encodeURIComponent(userId)}/${encodeURIComponent(targetId)}/favorite`,
			{}
		);
		const msgText =
			data.data?.message || `⭐ *${targetId}* foi definida como sua waifu favorita em destaque!`;
		return new ReturnMessage({
			chatId,
			content: msgText
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao definir favorito.");
	}
}

/**
 * Lista todos os Soulmates (10+ chaves) do jogador
 */
async function verSoulmates(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const { data } = await api.get(`/soulmates/${userId}`);
		const soulmates = data.data || [];

		if (soulmates.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"💖 *Você ainda não possui Soulmates!*\nRolar seus próprios personagens repetidos acumula chaves. Ao atingir 10 chaves, ela se torna sua Soulmate permanente."
			});
		}

		let text = `💖 *Seus Soulmates* (${soulmates.length}):\n\n`;
		soulmates.forEach((sm, idx) => {
			const char = sm.character;
			const numStr = String(idx + 1).padStart(2, "0");
			text += `${numStr}. 💖 *${char.name}* — _${char.series}_\n`;
			if (sm.alias) text += `   ↳ Apelido: "${sm.alias}"\n`;
			if (sm.note) text += `   ↳ Nota: _${sm.note}_\n`;
		});

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar soulmates.");
	}
}

/**
 * Lista as coleções (pastas) de waifus do usuário ou os personagens de uma pasta específica
 */
async function listarColecoes(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const query = (args || []).join(" ").trim();

	try {
		const [colsRes, haremRes, userRes] = await Promise.all([
			api.get(`/user/${userId}/collections`).catch(() => ({ data: { data: [] } })),
			api
				.get(`/harem/${userId}`, {
					params: { page: 1, limit: 100, sort: "keys" }
				})
				.catch(() => ({ data: { data: { data: [] } } })),
			api.get(`/user/${userId}`).catch(() => null)
		]);
		const collections = colsRes.data?.data || [];
		const haremEntries = haremRes.data?.data?.data || [];
		const userMythics = userRes?.data?.data?.mythicCharacters || [];

		// Combina os míticos retornados pelo perfil do usuário e pelo harém
		const mythicMap = new Map();
		userMythics.forEach((m) => {
			mythicMap.set(m.id, { ...m, keys: 0, isMythic: true });
		});
		haremEntries
			.filter(
				(e) => e.character?.isMythic || String(e.character?.rarity || "").toUpperCase() === "MYTHIC"
			)
			.forEach((e) => {
				if (!mythicMap.has(e.character.id)) {
					mythicMap.set(e.character.id, { ...e.character, keys: 0, isMythic: true });
				}
			});
		const mythicChars = Array.from(mythicMap.values());

		if (!query) {
			const hasMythics = mythicChars.length > 0;
			const totalCols = collections.length + (hasMythics ? 1 : 0);

			if (totalCols === 0) {
				return new ReturnMessage({
					chatId,
					content:
						"📁 *Você ainda não possui nenhuma coleção de waifus!* (0/15)\n\nCrie uma pasta com: `!mu-col-nova <nome>`\nExemplo: `!mu-col-nova Isekai`"
				});
			}

			let text = `📁 *Suas Coleções de Waifus (${totalCols}/15):*\n\n`;
			let listIdx = 1;
			if (hasMythics) {
				const numStr = String(listIdx++).padStart(2, "0");
				text += `${numStr}. 📂 🔮 *Míticos* — ${mythicChars.length} personagem(ns)\n`;
				text += `   📝 _Personagens lendários forjados por você_\n`;
			}
			collections.forEach((col) => {
				const lock = col.isPrivate ? " 🔒" : "";
				const numStr = String(listIdx++).padStart(2, "0");
				text += `${numStr}. 📂 *${col.name}*${lock} — ${col.characterCount} personagem(ns)\n`;
				if (col.description) {
					text += `   📝 _${col.description}_\n`;
				}
			});
			text += `\n💡 _Dicas:_\n`;
			text += `• Ver personagens da pasta: \`!mu-colecoes <nome ou número>\`\n`;
			text += `• Criar pasta: \`!mu-col-nova <nome>\`\n`;
			text += `• Adicionar waifu: \`!mu-col-add <pasta> | <personagem>\`\n`;
			text += `• Remover waifu: \`!mu-col-rem <personagem>\`\n`;
			text += `• Reordenar pastas: \`!mu-col-ordem <pasta1> | <pasta2>\`\n`;
			text += `• Alternar privacidade: \`!mu-col-privada <pasta>\`\n`;
			text += `• Apagar pasta: \`!mu-col-del <nome ou número>\``;

			return new ReturnMessage({ chatId, content: text });
		}

		// Se forneceu argumento, busca a coleção por índice ou nome
		const hasMythics = mythicChars.length > 0;
		const idx = parseInt(query, 10);
		let selected = null;
		const qLower = query.toLowerCase();

		if (
			hasMythics &&
			(idx === 1 ||
				qLower === "miticos" ||
				qLower === "míticos" ||
				qLower === "mitico" ||
				qLower === "mítico")
		) {
			selected = {
				name: "Míticos",
				characterCount: mythicChars.length,
				description: "Personagens lendários forjados por você",
				characters: mythicChars,
				isMythicCol: true
			};
		} else {
			const colOffset = hasMythics ? 1 : 0;
			const colIdx = idx - colOffset;
			if (!isNaN(colIdx) && colIdx >= 1 && colIdx <= collections.length) {
				selected = collections[colIdx - 1];
			} else {
				selected =
					collections.find((c) => c.id === query || c.name.toLowerCase() === qLower) ||
					collections.find((c) => c.name.toLowerCase().includes(qLower));
			}
		}

		if (!selected) {
			return new ReturnMessage({
				chatId,
				content: `❌ Coleção "${query}" não encontrada.\nUse \`!mu-colecoes\` para listar suas pastas cadastradas.`
			});
		}

		const lock = selected.isPrivate ? " 🔒" : "";
		let text = `📂 *Coleção: ${selected.name}*${lock} (${selected.characterCount} personagem(ns)):\n`;
		if (selected.description) {
			text += `📝 _${selected.description}_\n\n`;
		} else {
			text += `\n`;
		}

		if (!selected.characters || selected.characters.length === 0) {
			text += `_Esta pasta ainda está vazia!_\n\n💡 Para adicionar uma waifu do seu harém, use:\n\`!mu-col-add ${selected.name} | <personagem>\``;
		} else {
			selected.characters.forEach((char, i) => {
				const isCharMythic = Boolean(
					selected.isMythicCol ||
					char.isMythic ||
					String(char.rarity || "").toUpperCase() === "MYTHIC"
				);
				const emojiRarity = isCharMythic
					? "🔮"
					: RARITY_EMOJI[char.baseRarity || char.rarity] || "⚪";
				const fav = char.isFavorite ? "⭐ " : "";
				const charLink =
					getCharacterWebUrl(char.id) ||
					`https://waifuletes.moothz.com/character/${encodeURIComponent(char.id)}`;
				const keys = Number(char.keys ?? 0);
				let keyText = "";
				if (!isCharMythic) {
					if (keys >= 10) {
						keyText = " | 💞";
					} else if (keys >= 2) {
						keyText = ` | 🔑 *${keys}/10*`;
					}
				}
				const numStr = String(i + 1).padStart(2, "0");
				text += `${numStr}. ${fav}${emojiRarity} *${char.name}* — _${char.series || "Sem Série"}_\n`;
				text += `   ↳ ${charLink}${keyText}\n`;
			});

			if (!selected.isMythicCol) {
				text += `\n💡 _Dicas:_\n`;
				text += `• Adicionar waifu: \`!mu-col-add ${selected.name} | <personagem>\`\n`;
				text += `• Remover da pasta: \`!mu-col-rem <personagem>\`\n`;
				text += `• Apagar pasta: \`!mu-col-del ${selected.name}\``;
			}
		}

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar coleções.");
	}
}

/**
 * Cria uma nova coleção de waifus para o jogador (limite de 15)
 */
async function criarColecao(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const rawInput = (args || []).join(" ").trim();

	if (!rawInput) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Informe o nome da coleção a ser criada.\nExemplo: `!mu-col-nova Favoritas de Ação`\nOpcional com descrição: `!mu-col-nova Isekai | Waifus de outro mundo`"
		});
	}

	let name = rawInput;
	let description;
	if (rawInput.includes("|")) {
		const parts = rawInput.split("|");
		name = parts[0].trim();
		description = parts.slice(1).join("|").trim();
	}

	try {
		const { data } = await api.post(`/user/${userId}/collections`, {
			name,
			description
		});
		const col = data.data;

		let msg = `📂 *Coleção "${col.name}" criada com sucesso!*\n`;
		if (col.description) msg += `📝 _${col.description}_\n`;
		msg += `\n💡 Para adicionar personagens à pasta, use:\n\`!mu-col-add ${col.name} | <personagem>\``;

		return new ReturnMessage({ chatId, content: msg });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao criar coleção.");
	}
}

/**
 * Apaga uma coleção (os personagens permanecem no harém geral)
 */
async function apagarColecao(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const query = (args || []).join(" ").trim();

	if (!query) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Informe o nome ou número da coleção que deseja apagar.\nExemplo: `!mu-col-del 1` ou `!mu-col-del Isekai`"
		});
	}

	try {
		const { data } = await api.get(`/user/${userId}/collections`);
		const collections = data.data || [];

		const idx = parseInt(query, 10);
		let target = null;
		if (!isNaN(idx) && idx >= 1 && idx <= collections.length) {
			target = collections[idx - 1];
		} else {
			const qLower = query.toLowerCase();
			target =
				collections.find((c) => c.id === query || c.name.toLowerCase() === qLower) ||
				collections.find((c) => c.name.toLowerCase().includes(qLower));
		}

		if (!target) {
			return new ReturnMessage({
				chatId,
				content: `❌ Coleção "${query}" não encontrada.\nUse \`!mu-colecoes\` para listar suas pastas.`
			});
		}

		await api.delete(`/user/${userId}/collections/${target.id}`);

		return new ReturnMessage({
			chatId,
			content: `🗑️ *Coleção "${target.name}" apagada com sucesso!*\nOs personagens permanecem intactos no seu harém geral.`
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao apagar coleção.");
	}
}

/**
 * Adiciona um personagem do harém a uma coleção
 */
async function adicionarPersonagemColecao(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const rawInput = (args || []).join(" ").trim();

	let colInput = "";
	let charInput = "";

	if (rawInput.includes("|")) {
		const parts = rawInput.split("|");
		colInput = parts[0].trim();
		charInput = parts.slice(1).join("|").trim();
	} else if (args && args.length >= 2) {
		colInput = args[0].trim();
		charInput = args.slice(1).join(" ").trim();
	}

	if (!colInput || !charInput) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Formato inválido.\nUse: `!mu-col-add <pasta> | <personagem>`\nExemplo: `!mu-col-add Isekai | Rem`"
		});
	}

	try {
		const { data: colData } = await api.get(`/user/${userId}/collections`);
		const collections = colData.data || [];

		const idx = parseInt(colInput, 10);
		let targetCol = null;
		if (!isNaN(idx) && idx >= 1 && idx <= collections.length) {
			targetCol = collections[idx - 1];
		} else {
			const qLower = colInput.toLowerCase();
			targetCol =
				collections.find((c) => c.id === colInput || c.name.toLowerCase() === qLower) ||
				collections.find((c) => c.name.toLowerCase().includes(qLower));
		}

		if (!targetCol) {
			return new ReturnMessage({
				chatId,
				content: `❌ Coleção "${colInput}" não encontrada.\nUse \`!mu-colecoes\` para ver suas pastas cadastradas.`
			});
		}

		// Resolve personagem por slug/ID ou busca
		let character = null;
		try {
			const { data: charData } = await api.get(`/characters/${encodeURIComponent(charInput)}`, {
				timeout: 4000
			});
			if (charData?.data?.id) character = charData.data;
		} catch (_) {
			try {
				const { data: searchData } = await api.get("/characters", {
					params: { search: charInput, limit: 1 },
					timeout: 4000
				});
				if (searchData?.data?.data?.[0]?.id) character = searchData.data.data[0];
			} catch (__) {}
		}

		const targetCharId = character?.id || charInput;
		const targetCharName = character?.name || targetCharId;

		if (character?.isMythic || String(character?.rarity || "").toUpperCase() === "MYTHIC") {
			return new ReturnMessage({
				chatId,
				content: "❌ *Personagens míticos não podem ser colocados em coleções ou pastas.*"
			});
		}

		await api.post(`/user/${userId}/collections/${targetCol.id}/characters`, {
			characterId: targetCharId
		});

		return new ReturnMessage({
			chatId,
			content: `✅ *${targetCharName}* foi adicionada à coleção 📂 *${targetCol.name}*!\n\n💡 _Dica: cada waifu pode estar em apenas uma pasta por vez._`
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao adicionar personagem à coleção.");
	}
}

/**
 * Remove um personagem de sua coleção atual, retornando-o ao harém geral
 */
async function removerPersonagemColecao(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const rawChar = (args || []).join(" ").trim();

	if (!rawChar) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Informe o personagem que deseja remover de sua coleção.\nExemplo: `!mu-col-rem Rem` ou `!mu-col-rem rem-re-zero`"
		});
	}

	try {
		let character = null;
		try {
			const { data: charData } = await api.get(`/characters/${encodeURIComponent(rawChar)}`, {
				timeout: 4000
			});
			if (charData?.data?.id) character = charData.data;
		} catch (_) {
			try {
				const { data: searchData } = await api.get("/characters", {
					params: { search: rawChar, limit: 1 },
					timeout: 4000
				});
				if (searchData?.data?.data?.[0]?.id) character = searchData.data.data[0];
			} catch (__) {}
		}

		const targetCharId = character?.id || rawChar;
		const targetCharName = character?.name || targetCharId;

		const { data } = await api.delete(
			`/user/${userId}/collections/characters/${encodeURIComponent(targetCharId)}`
		);

		const msgText =
			data.data?.message || `*${targetCharName}* foi removida da coleção e voltou ao harém geral!`;

		return new ReturnMessage({
			chatId,
			content: `📤 ${msgText}`
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao remover personagem da coleção.");
	}
}

/**
 * Alterna a privacidade de uma coleção de waifus (!mu-col-privada <pasta>)
 */
async function alternarPrivacidadeColecao(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const query = (args || []).join(" ").trim();

	if (!query) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Informe o nome ou número da coleção para alterar a privacidade.\nExemplo: `!mu-col-privada Isekai` ou `!mu-col-privada 1`"
		});
	}

	try {
		const { data } = await api.get(`/user/${userId}/collections`);
		const collections = data.data || [];

		const idx = parseInt(query, 10);
		let target = null;
		if (!isNaN(idx) && idx >= 1 && idx <= collections.length) {
			target = collections[idx - 1];
		} else {
			const qLower = query.toLowerCase();
			target =
				collections.find((c) => c.id === query || c.name.toLowerCase() === qLower) ||
				collections.find((c) => c.name.toLowerCase().includes(qLower));
		}

		if (!target) {
			return new ReturnMessage({
				chatId,
				content: `❌ Coleção "${query}" não encontrada.\nUse \`!mu-colecoes\` para listar suas pastas.`
			});
		}

		const res = await api.patch(
			`/user/${userId}/collections/${encodeURIComponent(target.id)}/privacy`,
			{}
		);
		const isNowPrivate = res.data?.data?.isPrivate;

		if (isNowPrivate) {
			return new ReturnMessage({
				chatId,
				content: `🔒 *Coleção "${target.name}" agora é PRIVADA!*\n\nEsta pasta e suas waifus não serão exibidas quando outros jogadores visualizarem o seu harém.`
			});
		} else {
			return new ReturnMessage({
				chatId,
				content: `🔓 *Coleção "${target.name}" agora é PÚBLICA!*\n\nEsta pasta voltará a ser visível para outros jogadores.`
			});
		}
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao alterar privacidade da coleção.");
	}
}

/**
 * Reordena as coleções de waifus do jogador (!mu-col-ordem <pasta1> | <pasta2> | ...)
 */
async function reordenarColecoes(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const rawInput = (args || []).join(" ").trim();

	if (!rawInput) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Informe a nova ordem das coleções separadas por barra vertical (`|`).\nExemplo: `!mu-col-ordem Isekai | Shonen | Waifus`\nOu por número: `!mu-col-ordem 3 | 1 | 2`"
		});
	}

	try {
		const { data } = await api.get(`/user/${userId}/collections`);
		const collections = data.data || [];

		if (collections.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "📁 Você ainda não possui nenhuma coleção criada para reordenar."
			});
		}

		let parts = [];
		if (rawInput.includes("|")) {
			parts = rawInput
				.split("|")
				.map((p) => p.trim())
				.filter(Boolean);
		} else if (args.length > 1) {
			parts = args.map((a) => a.trim()).filter(Boolean);
		} else {
			parts = [rawInput];
		}

		if (parts.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "❌ Nenhuma pasta válida informada na ordem."
			});
		}

		const resolvedIds = [];
		const usedIds = new Set();

		for (const part of parts) {
			const idx = parseInt(part, 10);
			let target = null;
			if (!isNaN(idx) && idx >= 1 && idx <= collections.length) {
				target = collections[idx - 1];
			} else {
				const pLower = part.toLowerCase();
				target =
					collections.find((c) => c.id === part || c.name.toLowerCase() === pLower) ||
					collections.find((c) => c.name.toLowerCase().includes(pLower));
			}

			if (!target) {
				return new ReturnMessage({
					chatId,
					content: `❌ Coleção "${part}" não encontrada.\nUse \`!mu-colecoes\` para ver suas pastas cadastradas.`
				});
			}

			if (!usedIds.has(target.id)) {
				usedIds.add(target.id);
				resolvedIds.push(target.id);
			}
		}

		// Adiciona as coleções não mencionadas ao final, mantendo sua ordem original
		for (const col of collections) {
			if (!usedIds.has(col.id)) {
				usedIds.add(col.id);
				resolvedIds.push(col.id);
			}
		}

		const putRes = await api.put(`/user/${userId}/collections/order`, {
			order: resolvedIds
		});
		const updatedCols = putRes.data?.data?.collections || putRes.data?.data || [];

		let msg = `📋 *Ordem das coleções atualizada com sucesso!*\n\n`;
		const listToDisplay =
			Array.isArray(updatedCols) && updatedCols.length > 0
				? updatedCols
				: resolvedIds.map((id) => collections.find((c) => c.id === id));
		listToDisplay.forEach((col, idx) => {
			if (!col) return;
			const lock = col.isPrivate ? " 🔒" : "";
			msg += `${idx + 1}. 📂 *${col.name}* (${col.characterCount || 0} waifus)${lock}\n`;
		});

		return new ReturnMessage({ chatId, content: msg });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao reordenar coleções.");
	}
}

function matchUserNumber(nickNumero, targetUserId) {
	if (!nickNumero || !targetUserId) return false;
	const cleanNick = String(nickNumero).replace(/\D/g, "");
	const cleanTarget = String(targetUserId).replace(/\D/g, "");
	if (cleanNick && cleanTarget && cleanNick === cleanTarget) return true;
	return String(nickNumero).toLowerCase() === String(targetUserId).toLowerCase();
}

function findNickInGroup(groupObj, targetUserId) {
	if (!groupObj || !Array.isArray(groupObj.nicks)) return null;
	const item = groupObj.nicks.find((n) => matchUserNumber(n.numero, targetUserId));
	return item?.apelido?.trim() || null;
}

/**
 * Resolve o nome de exibição de um jogador para o ranking, dando preferência
 * ao apelido configurado no grupo em que ele usa comandos (ou no grupo atual).
 * @param {Object} user - Objeto de usuário retornado da API
 * @param {Object} [currentGroup] - Objeto do grupo atual onde o comando foi chamado
 * @returns {Promise<string>}
 */
async function resolveUserDisplayName(user, currentGroup) {
	const rawUserId = user.id;
	const cleanUserId = String(rawUserId || "").replace(/\D/g, "");

	// 1. Apelido no grupo atual onde o comando foi executado
	const currentNick = findNickInGroup(currentGroup, rawUserId);
	if (currentNick) {
		return currentNick;
	}

	// 2. Apelido no grupo em que o usuário mais usa comandos de waifu (mu-%)
	try {
		const muGroupRow = await database.dbGet(
			"cmd_usage",
			`SELECT group_id, count(*) as cnt 
			 FROM cmd_usage_log 
			 WHERE (user = ? OR user LIKE ? OR user = ?) 
			   AND group_id IS NOT NULL 
			   AND command LIKE ? 
			 GROUP BY group_id 
			 ORDER BY cnt DESC 
			 LIMIT 1`,
			[cleanUserId, `${cleanUserId}@%`, rawUserId, "mu-%"]
		);

		if (muGroupRow?.group_id) {
			const muGroup = await database.getGroup(muGroupRow.group_id);
			const muNick = findNickInGroup(muGroup, rawUserId);
			if (muNick) return muNick;
		}

		// 3. Apelido no grupo mais ativo do usuário no geral
		const generalGroupRow = await database.dbGet(
			"cmd_usage",
			`SELECT group_id, count(*) as cnt 
			 FROM cmd_usage_log 
			 WHERE (user = ? OR user LIKE ? OR user = ?) 
			   AND group_id IS NOT NULL 
			 GROUP BY group_id 
			 ORDER BY cnt DESC 
			 LIMIT 1`,
			[cleanUserId, `${cleanUserId}@%`, rawUserId]
		);

		if (generalGroupRow?.group_id && generalGroupRow.group_id !== muGroupRow?.group_id) {
			const generalGroup = await database.getGroup(generalGroupRow.group_id);
			const genNick = findNickInGroup(generalGroup, rawUserId);
			if (genNick) return genNick;
		}

		// 4. Fallback: busca em qualquer grupo no core.db que tenha apelido para este número
		if (cleanUserId) {
			const coreRow = await database.dbGet(
				"core",
				"SELECT nicks FROM groups WHERE nicks LIKE ? LIMIT 1",
				[`%${cleanUserId}%`]
			);
			if (coreRow?.nicks) {
				try {
					const parsedNicks = JSON.parse(coreRow.nicks);
					const fallbackItem = parsedNicks.find((n) => matchUserNumber(n.numero, cleanUserId));
					if (fallbackItem?.apelido?.trim()) return fallbackItem.apelido.trim();
				} catch {
					// Ignora erro de JSON parse
				}
			}
		}
	} catch (err) {
		logger.debug(`Erro ao resolver apelido para usuário ${rawUserId}:`, err.message);
	}

	// 5. Fallback para o nome cadastrado na API
	return user.name || "Jogador";
}

/**
 * Determina se um usuário retornado da API é uma conta de teste que não deve figurar em rankings
 */
function isTestRankingUser(u) {
	if (!u) return false;
	const name = String(u.name || "").toLowerCase();
	const id = String(u.id || "").toLowerCase();
	return id === "test_web_user_1" || name.includes("jogador web teste");
}

/**
 * Exibe ranking global consolidado (Zinthos e Casamentos) ou detalhado com 'all'
 */
async function verRanking(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const currentGroup = group || (message.group ? await database.getGroup(message.group) : null);
	const medals = ["🥇", "🥈", "🥉"];

	const subcmd = (args[0] || "").toLowerCase();
	const arg1 = (args[1] || "").toLowerCase();

	const isAll = subcmd === "all" || arg1 === "all";
	const limit = isAll ? 500 : Math.min(parseInt(args[1] || args[0], 10) || 10, 50);

	// Cenário A: Ranking detalhado de Casamentos / Harém
	if (
		["casamentos", "casamento", "c", "harem", "harém", "h", "colecao", "coleção"].includes(subcmd)
	) {
		try {
			const { data } = await api.get("/leaderboard/harem", { params: { limit } });
			const rawTopHarem = data.data?.topHarem || [];
			const topHarem = rawTopHarem.filter((u) => !isTestRankingUser(u));

			if (topHarem.length === 0) {
				return new ReturnMessage({
					chatId,
					content: "👑 Nenhum jogador com personagens no harém registrado ainda."
				});
			}

			const lines = await Promise.all(
				topHarem.map(async (u, idx) => {
					const pos = medals[idx] || `${idx + 1}.`;
					const displayName = await resolveUserDisplayName(u, currentGroup);
					let line = `${pos} *${displayName}* — *${u.collectionPoints} pts* (${u.totalMarriages} waifus | ${u.totalKeys} 🔑)\n`;
					line += `   └ ⚪${u.commonCount}  🟢${u.uncommonCount}  🔵${u.rareCount}  🟣${u.epicCount}  ⭐${u.legendaryCount}\n`;
					return line;
				})
			);

			let text = `👑 *Ranking de Colecionadores de Waifus (Harém & Raridade)* [${topHarem.length} jogadores]:\n\n`;
			text += lines.join("");
			if (!isAll) {
				text += `\n💡 Para ver todos os jogadores: \`!mu-rank casamentos all\``;
			}

			return new ReturnMessage({ chatId, content: text });
		} catch (err) {
			return handleApiError(err, chatId, "Erro ao consultar ranking de casamentos.");
		}
	}

	// Cenário B: Ranking detalhado de Zinthos
	if (["zinthos", "z", "moeda", "saldo"].includes(subcmd)) {
		try {
			const { data } = await api.get("/leaderboard/users", { params: { limit } });
			const rawTopRich = data.data?.topRich || [];
			const topRich = rawTopRich.filter((u) => !isTestRankingUser(u));

			if (topRich.length === 0) {
				return new ReturnMessage({
					chatId,
					content: "🏆 Nenhum jogador registrado no ranking de Zinthos ainda."
				});
			}

			const lines = await Promise.all(
				topRich.map(async (u, idx) => {
					const pos = medals[idx] || `${idx + 1}.`;
					const displayName = await resolveUserDisplayName(u, currentGroup);
					return `${pos} *${displayName}* — 💜 *${u.kakera}* Zinthos (Harém: ${u._count?.harem ?? 0})\n`;
				})
			);

			let text = `💜 *Ranking de Jogadores Mais Ricos em Zinthos* [${topRich.length} jogadores]:\n\n`;
			text += lines.join("");
			if (!isAll) {
				text += `\n💡 Para ver todos os jogadores: \`!mu-rank zinthos all\``;
			}

			return new ReturnMessage({ chatId, content: text });
		} catch (err) {
			return handleApiError(err, chatId, "Erro ao consultar ranking de Zinthos.");
		}
	}

	// Cenário C: Visão Dupla Consolidada (Top 10 Zinthos + Top 10 Casamentos)
	try {
		const [usersRes, haremRes] = await Promise.all([
			api.get("/leaderboard/users", { params: { limit: 10 } }).catch(() => null),
			api.get("/leaderboard/harem", { params: { limit: 10 } }).catch(() => null)
		]);

		const rawTopRich = usersRes?.data?.data?.topRich || [];
		const rawTopHarem = haremRes?.data?.data?.topHarem || [];
		const topRich = rawTopRich.filter((u) => !isTestRankingUser(u));
		const topHarem = rawTopHarem.filter((u) => !isTestRankingUser(u));

		let text = `🏆 *PAINEL DE LIDERANÇA WAIFULETES* 🏆\n\n`;

		text += `💜 *Top 10 — Mais Ricos (Zinthos):*\n`;
		if (topRich.length === 0) {
			text += `Nenhum jogador registrado ainda.\n`;
		} else {
			const richLines = await Promise.all(
				topRich.slice(0, 10).map(async (u, idx) => {
					const pos = medals[idx] || `${idx + 1}.`;
					const displayName = await resolveUserDisplayName(u, currentGroup);
					return `${pos} *${displayName}* — *${u.kakera}* Zinthos\n`;
				})
			);
			text += richLines.join("");
		}

		text += `\n👑 *Top 10 — Maiores Colecionadores (Casamentos & Raridade):*\n`;
		if (topHarem.length === 0) {
			text += `Nenhum jogador registrado ainda.\n`;
		} else {
			const haremLines = await Promise.all(
				topHarem.slice(0, 10).map(async (u, idx) => {
					const pos = medals[idx] || `${idx + 1}.`;
					const displayName = await resolveUserDisplayName(u, currentGroup);
					let line = `${pos} *${displayName}* — *${u.collectionPoints} pts* (${u.totalMarriages} waifus)\n`;
					line += `   └ ⚪${u.commonCount}  🟢${u.uncommonCount}  🔵${u.rareCount}  🟣${u.epicCount}  ⭐${u.legendaryCount}\n`;
					return line;
				})
			);
			text += haremLines.join("");
		}

		text += `\n────────────────────────\n`;
		text += `💡 *Rankings completos:*\n`;
		text += `• \`!mu-rank zinthos all\` — Lista todos os jogadores de Zinthos\n`;
		text += `• \`!mu-rank casamentos all\` — Lista todos os colecionadores\n`;

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar ranking.");
	}
}

/**
 * Exibe personagens mais populares e casados
 */
async function verTopCharacters(bot, message) {
	const chatId = message.group ?? message.author;

	try {
		const { data } = await api.get("/leaderboard/characters", { params: { limit: 5 } });
		const topClaimed = data.data?.topClaimed || [];
		const topLiked = data.data?.topLiked || [];

		let text = `🌟 *Personagens Mais Populares:*\n\n`;
		text += `💍 *Mais Casados:*\n`;
		topClaimed.forEach((c, i) => {
			text += `${i + 1}. *${c.name}* (${c.series}) — 💍 ${c.claimCount} casamentos\n`;
		});

		text += `\n❤️ *Mais Curtidos:*\n`;
		topLiked.forEach((c, i) => {
			text += `${i + 1}. *${c.name}* (${c.series}) — ❤️ ${c.likeCount} likes\n`;
		});

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar personagens populares.");
	}
}

/**
 * Consulta o ranking exclusivo do grupo (jogadores e waifus locais)
 */
async function verRankingGrupo(bot, message) {
	const chatId = message.group ?? message.author;
	const groupId = getGroupId(message);

	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só pode ser utilizado dentro de um grupo do WhatsApp!"
		});
	}

	try {
		const { data } = await api.get(`/groups/${encodeURIComponent(groupId)}/leaderboard`, {
			params: { limit: 10 }
		});
		const {
			totalMembers,
			totalClaimsInGroup,
			topKakera: rawTopKakera,
			topHarem: rawTopHarem,
			topCharacters: rawTopCharacters
		} = data.data || {};

		const topKakera = (rawTopKakera || []).filter((u) => !isTestRankingUser(u));
		const topHarem = (rawTopHarem || []).filter((u) => !isTestRankingUser(u));
		const topCharacters = (rawTopCharacters || []).filter(
			(entry) => !isTestRankingUser(entry.owner) && !isTestRankingUser(entry.user)
		);

		if (!topKakera || topKakera.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `👥 *Ranking do Grupo*\n\nAinda não há membros com atividade registrada neste grupo!`
			});
		}

		const medals = ["🥇", "🥈", "🥉"];

		let text = `🏆 *Ranking do Grupo:*\n`;
		text += `👥 Membros ativos: *${totalMembers}* | 💍 Casamentos no grupo: *${totalClaimsInGroup}*\n\n`;

		text += `💰 *Mais Ricos (Zinthos):*\n`;
		topKakera.slice(0, 5).forEach((u, i) => {
			const medal = medals[i] || `${i + 1}º`;
			text += `${medal} *${u.name}* — ${u.kakera.toLocaleString("pt-BR")} 💎\n`;
		});

		text += `\n🏰 *Maiores Haréns:*\n`;
		topHarem.slice(0, 5).forEach((u, i) => {
			const medal = medals[i] || `${i + 1}º`;
			text += `${medal} *${u.name}* — ${u.haremCount} waifus\n`;
		});

		if (topCharacters && topCharacters.length > 0) {
			text += `\n🌟 *Waifus Conquistadas no Grupo:*\n`;
			topCharacters.slice(0, 5).forEach((entry, i) => {
				const medal = medals[i] || `${i + 1}º`;
				text += `${medal} *${entry.character.name}* (🔑 ${entry.keys}) — Dono: ${entry.owner?.name || "Alguém"}\n`;
			});
		}

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar ranking do grupo.");
	}
}

/**
 * Busca personagens no catálogo por nome ou série
 */
async function buscarPersonagens(bot, message, args) {
	const chatId = message.group ?? message.author;

	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content: "🔍 Informe o nome ou série para pesquisar.\nExemplo: `!mu-personagens Frieren`"
		});
	}

	const search = args.join(" ");

	try {
		const { data } = await api.get("/characters", {
			params: { search, sort: "popularity", limit: 10 }
		});

		const resultData = data.data;
		const chars = resultData.data || [];
		const total = resultData.total || 0;

		if (chars.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `🔍 Nenhum personagem encontrado para "${search}".`
			});
		}

		let text = `🔍 *Resultados para "${search}"* (Total: ${total}):\n\n`;
		chars.forEach((c, idx) => {
			const isMythic = Boolean(c.isMythic || String(c.rarity || "").toUpperCase() === "MYTHIC");
			const rarity = isMythic ? "MYTHIC" : c.baseRarity || c.rarity || "COMMON";
			const emojiRarity = RARITY_EMOJI[rarity] || "⚪";
			text += `${idx + 1}. ${emojiRarity} *${c.name}* — _${c.series}_\n`;
			text += `   ↳ ID: \`${c.id}\` | 💍 ${c.claimCount} | ❤️ ${c.likeCount}\n`;
		});

		text += `\n_Use \`!mu-char <id>\` para ver imagem e detalhes completos._`;
		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao buscar personagens.");
	}
}

/**
 * Exibe detalhes e imagem de um personagem com suporte a busca ampla (ID, nome, série, descrição)
 * e paginação interativa via reações numéricas (1 a 10).
 */
async function detalhesPersonagem(bot, message, args, group = null, navContext = null) {
	const chatId = message.group ?? message.author;

	if (!args[0]) {
		return new ReturnMessage({
			chatId,
			content:
				"🔍 Informe o nome, série, descrição ou ID do personagem para buscar.\nExemplo: `!mu-char Frieren` ou `!mu-char audrey`"
		});
	}

	const query = args.join(" ").trim();
	let char = null;
	let allResults = [];
	let otherResults = [];

	if (
		navContext?.allResults &&
		Array.isArray(navContext.allResults) &&
		navContext.allResults.length > 0
	) {
		allResults = navContext.allResults;
		const found = allResults.find((c) => c.id === query);
		if (found) {
			char = found;
		}
	}

	// 1. Tenta buscar direto por ID/slug exato (mesmo com espaços, a API normaliza com slugify)
	if (!char) {
		try {
			const { data } = await api.get(`/characters/${encodeURIComponent(query)}`);
			if (data?.data) {
				char = data.data;
			}
		} catch (idErr) {
			if (idErr.response?.status !== 404) {
				logger.debug(`[detalhesPersonagem] Falha na consulta por ID: ${idErr.message}`);
			}
		}
	}

	// 2. Executa busca ampla no catálogo se não temos resultados de contexto
	let searchResults = [];
	if (allResults.length === 0) {
		try {
			const { data } = await api.get("/characters", {
				params: { search: query, sort: "popularity", limit: 15 }
			});
			searchResults = data.data?.data || [];
		} catch (searchErr) {
			logger.error(`[detalhesPersonagem] Erro na busca ampla: ${searchErr.message}`);
		}
	}

	// 3. Se não encontrou por ID exato, seleciona o melhor match da busca
	if (!char && searchResults.length > 0) {
		const normQ = query.toLowerCase();
		const clean = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
		const cleanQ = clean(query);

		const exactId = searchResults.find((c) => clean(c.id) === cleanQ);
		const exactName = searchResults.find((c) => clean(c.name) === cleanQ);
		const startsName = searchResults.find(
			(c) => clean(c.name).startsWith(cleanQ) || clean(c.id).startsWith(cleanQ)
		);
		const includesName = searchResults.find((c) => c.name?.toLowerCase().includes(normQ));
		char = exactId || exactName || startsName || includesName || searchResults[0];
	}

	// Se char foi encontrado por ID mas ainda precisamos de detalhes completos via /characters/:id
	if (char && (!char.gender || !char.baseRarity) && char.id) {
		try {
			const { data } = await api.get(`/characters/${encodeURIComponent(char.id)}`);
			if (data?.data) {
				char = data.data;
			}
		} catch (_) {}
	}

	if (!char) {
		return new ReturnMessage({
			chatId,
			content: `🔍 Nenhum personagem encontrado para "${query}".\n\n💡 _Dica: Tente pesquisar por parte do nome, anime/série ou palavras da descrição com \`!mu-char <busca>\`._`
		});
	}

	// Monta lista allResults consolidada
	if (allResults.length === 0) {
		const baseList = searchResults.length > 0 ? searchResults : [char];
		if (!baseList.some((c) => c.id === char.id)) {
			allResults = [char, ...baseList];
		} else {
			allResults = baseList;
		}
	}

	otherResults = allResults.filter((c) => c.id !== char.id);

	// Se não achou outros resultados e o personagem tem série, busca mais da mesma série
	if (otherResults.length === 0 && char.series) {
		try {
			const { data: relData } = await api.get("/characters", {
				params: { search: char.series, sort: "popularity", limit: 11 }
			});
			const seriesResults = relData.data?.data || [];
			otherResults = seriesResults.filter((c) => c.id !== char.id);
			if (otherResults.length > 0) {
				allResults = [char, ...otherResults];
			}
		} catch (_) {}
	}

	try {
		const isMythic = Boolean(char.isMythic || String(char.rarity || "").toUpperCase() === "MYTHIC");
		const rarity = isMythic ? "MYTHIC" : char.baseRarity || char.rarity || "COMMON";
		const emojiRarity = RARITY_EMOJI[rarity] || "⚪";
		const labelRarity = RARITY_LABEL[rarity] || rarity;

		let text = `👤 *${char.name}* (${char.series})\n`;
		text += `⭐ Raridade: ${emojiRarity} *${labelRarity}*\n`;
		text += `⚧ Gênero: *${char.gender === "FEMALE" ? "Feminino" : char.gender === "MALE" ? "Masculino" : "Outro"}*\n`;

		if (isMythic) {
			const creator = char.owner?.name || char.creatorUserId || "Apoiador Ravena";
			text += `👑 Criador Original: *${creator}*\n`;
			text += `💍 Vínculo: *Casamento Sagrado e Eterno com o criador*\n`;
		} else {
			const stats = await getDropRateStats();
			const rarityStat = stats?.breakdown?.find((b) => b.rarity === rarity);
			if (rarityStat) {
				const singleBaseStr =
					rarityStat.singleBaseChance < 0.001
						? rarityStat.singleBaseChance.toFixed(4)
						: rarityStat.singleBaseChance.toFixed(3);
				const singleWishStr =
					rarityStat.singleWishChance < 0.001
						? rarityStat.singleWishChance.toFixed(4)
						: rarityStat.singleWishChance.toFixed(3);
				text += `🎯 Chance no roll: *${singleBaseStr}%* (1 em ${rarityStat.singleBaseOneInX?.toLocaleString("pt-BR") || "?"})\n`;
				text += `🌟 Com Wishlist: *${singleWishStr}%* (*+50%* | 1 em ${rarityStat.singleWishOneInX?.toLocaleString("pt-BR") || "?"})\n`;
			}

			text += `💍 Total de casamentos: *${char.claimCount ?? 0}*\n`;
		}

		text += `❤️ Curtidas: *${char.likeCount ?? 0}*\n`;

		if (char.description) {
			text += `\n📝 _${char.description}_\n`;
		}

		if (char.tags && char.tags.length > 0) {
			text += `🏷️ Tags: _${char.tags.join(", ")}_\n`;
		}

		text += `\n🆔 ID: \`${char.id}\``;
		const mainPageUrl =
			getCharacterWebUrl(char.id) ||
			(WAIFULETES_WEB_URL
				? `${WAIFULETES_WEB_URL}/character/${encodeURIComponent(char.id)}`
				: null);
		if (mainPageUrl) {
			text += `\n🌐 Página: ${mainPageUrl}`;
		}

		// Se houver mais resultados correspondentes na busca ampla, lista até 10 resultados no novo formato
		const topOthers = otherResults.slice(0, 10);
		if (topOthers.length > 0) {
			text += `\n\n---------\nOutros resultados da busca:\n`;
			topOthers.forEach((o, idx) => {
				const oIsMythic = Boolean(o.isMythic || String(o.rarity || "").toUpperCase() === "MYTHIC");
				const oRarity = oIsMythic ? "MYTHIC" : o.baseRarity || o.rarity || "COMMON";
				const oEmoji = RARITY_EMOJI[oRarity] || "⚪";
				const link =
					getCharacterWebUrl(o.id) ||
					`https://waifuletes.moothz.com/character/${encodeURIComponent(o.id)}`;
				text += `${idx + 1}. ${oEmoji} ${o.name} (${o.id})\n${link}\n\n`;
			});
			text += `💡 _Reaja com o número (1 a ${topOthers.length}) para ver outro da lista._\n`;
		}

		const options = {
			caption: text,
			waifuCharSearch: {
				characters: topOthers.map((o, idx) => ({
					slot: idx + 1,
					id: o.id,
					name: o.name
				})),
				allResults
			}
		};

		if (navContext?.quotedMessageId) {
			options.quotedMessageId = navContext.quotedMessageId;
			if (message.origin) {
				options.goReply = message.origin;
			}
		}

		const imageBase64 = await downloadImageAsBase64(char.imageUrl);
		if (imageBase64) {
			return new ReturnMessage({
				chatId,
				content: {
					mimetype: "image/jpeg",
					data: imageBase64,
					filename: `${char.id}.jpg`,
					isMessageMedia: true
				},
				options
			});
		}

		return new ReturnMessage({ chatId, content: text, options });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao formatar detalhes do personagem.");
	}
}

// Aliases de rótulos de raridade (PT/EN, com ou sem acento) para a chave interna
const RARITY_KEY_ALIASES = (() => {
	const map = {};
	const plain = (v) =>
		String(v)
			.toUpperCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.trim();
	for (const [rarity, label] of Object.entries(RARITY_LABEL)) {
		map[plain(rarity)] = rarity;
		map[plain(label)] = rarity;
	}
	return map;
})();

/**
 * Normaliza um rótulo de raridade ("Raro", "ÉPICO", "LEGENDARY"...) para a chave interna
 * @param {string} value
 * @returns {string|null}
 */
function normalizeRarityKey(value) {
	if (!value) return null;
	return (
		RARITY_KEY_ALIASES[
			String(value)
				.normalize("NFD")
				.replace(/[\u0300-\u036f]/g, "")
				.trim()
				.toUpperCase()
		] || null
	);
}

/**
 * Detecta a raridade de uma linha de slot: aceita o rótulo antigo "[Raro]" e o emoji atual (⚪🟢🔵🟣⭐)
 * @param {string} rawLine
 * @returns {string|null}
 */
function detectRarityFromRollLine(rawLine) {
	if (!rawLine) return null;

	const fromLabel = normalizeRarityKey(rawLine.match(/\[([^\]]+)\]/)?.[1]);
	if (fromLabel) return fromLabel;

	const slotPrefixEmoji = rawLine.match(/^[1-9](?:️⃣|\uFE0F?\u20E3)\s*(\S+)/)?.[1];
	if (slotPrefixEmoji) {
		for (const [rarity, emoji] of Object.entries(RARITY_EMOJI)) {
			if (slotPrefixEmoji.includes(emoji)) return rarity;
		}
	}

	for (const [rarity, emoji] of Object.entries(RARITY_EMOJI)) {
		if (rawLine.includes(emoji)) return rarity;
	}
	return null;
}

/**
 * Extrai o ID/slug do personagem a partir da linha com o link da página web
 * @param {string} rawLine
 * @returns {string|null}
 */
function extractCharacterIdFromWebLink(rawLine) {
	if (!rawLine) return null;
	const match = rawLine.match(/\/character\/([^/\s"'<>|]+)/i);
	if (!match || !match[1]) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}

/**
 * Extrai o ID ou nome do personagem a partir do texto/legenda de uma mensagem de roll
 * @param {string} text
 * @returns {string|null}
 */
function extractCharacterFromRollText(text) {
	if (!text || typeof text !== "string") return null;
	if (text.includes("Outros resultados da busca:")) return null;

	// 1. Procura pelo comando de casamento na legenda: !mu-casar <slug>
	const matchCasar = text.match(/!mu-casar\s+([a-zA-Z0-9_-]+)/i);
	if (matchCasar && matchCasar[1]) {
		return matchCasar[1].trim();
	}

	// 2. Procura pelo link da página do personagem no portal web
	const linkId = extractCharacterIdFromWebLink(text);
	if (linkId) {
		return linkId;
	}

	// 3. Procura pelo cabeçalho: 🎲 *Nome* — _Serie_ ou 🎲 Nome — Serie
	const matchHeader = text.match(/🎲\s*\*?([^*\n—–-]+?)\*?\s*[—–-]/);
	if (matchHeader && matchHeader[1]) {
		const name = matchHeader[1].trim();
		if (name.length > 1 && !name.startsWith("!mu-")) {
			return name;
		}
	}

	return null;
}

/**
 * Extrai slots de um post de multi-roll a partir do texto/legenda
 * @param {string} text
 * @returns {Array<{ slot: number, characterId?: string, characterName: string, series?: string, rarity?: string }>}
 */
function extractMultiRollSlotsFromText(text) {
	if (!text || typeof text !== "string") return [];

	const isMulti =
		/🎲\s*Waifuletes!\s*\*?\d+\*?\s*rolls:/i.test(text) ||
		(text.match(/!mu-casar\s+([a-zA-Z0-9_-]+)/gi) || []).length > 1 ||
		(text.match(/[1-9](?:️⃣|\uFE0F?\u20E3)/g) || []).length > 1 ||
		(text.match(/\/character\//gi) || []).length > 1;

	if (!isMulti) return [];

	const lines = text.split("\n");
	const slots = [];
	let currentSlot = null;

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i].trim();
		if (!rawLine) continue;

		// Verifica se a linha indica um slot numerado: ex: 1️⃣ ⚪ Nome — Serie
		const slotMatch = rawLine.match(
			/^([1-9])(?:️⃣|\uFE0F?\u20E3)\s*(?:[^\s[*]*\s*)?(?:\[([^\]]+)\]\s*)?\*?([^*\n—–-]+?)\*?\s*(?:[—–-]\s*([^\n(]+))?(?:\s*\((.*)\))?$/
		);

		if (slotMatch) {
			const slotNum = parseInt(slotMatch[1], 10);
			const name = slotMatch[3]?.trim();
			let series = slotMatch[4]?.trim() || "";
			// Limpa markdown formatting
			series = series.replace(/^[*_~`]+|[*_~`]+$/g, "").trim();

			currentSlot = {
				slot: slotNum,
				characterName: name,
				series,
				rarity:
					detectRarityFromRollLine(rawLine) || normalizeRarityKey(slotMatch[2]?.trim()) || "COMMON",
				characterId: null
			};
			slots.push(currentSlot);
			continue;
		}

		// Se for comando de casar (formato antigo): > !mu-casar <id>
		const casarMatch = rawLine.match(/^>?\s*!mu-casar\s+([a-zA-Z0-9_-]+)/i);
		if (casarMatch && currentSlot) {
			currentSlot.characterId = casarMatch[1].trim();
			continue;
		}

		// Se for o link da página do personagem: > https://.../character/<id>
		const linkedId = extractCharacterIdFromWebLink(rawLine);
		if (linkedId && currentSlot && !currentSlot.characterId) {
			currentSlot.characterId = linkedId;
		}
	}

	return slots;
}

/**
 * Processa a denúncia de um sorteio com múltiplos rolls (multi-roll)
 * Envia imagem do grid e lista de comandos !sa-remudae na mesma mensagem para o grupo de logs
 */
async function processMultiRollReport({
	bot,
	chatId,
	groupId,
	denunciante,
	denuncianteId,
	grupoOrigem,
	targetMsgId,
	targetMediaSource,
	multiRollData
}) {
	const rawSlots = multiRollData.slots || [];
	if (!rawSlots || rawSlots.length === 0) return null;

	// 1. Resolve os dados de cada slot (garante id, nome, serie, raridade e imageUrl)
	const resolvedSlots = await Promise.all(
		rawSlots.map(async (slotItem, idx) => {
			const s = { ...slotItem };
			s.slot = s.slot || idx + 1;

			// Se não tiver ID mas tiver nome, pesquisa na API
			if (!s.characterId && s.characterName) {
				try {
					const searchRes = await api
						.get("/characters", { params: { search: s.characterName, limit: 1 } })
						.catch(() => null);
					const list = searchRes?.data?.data?.data || [];
					if (list.length > 0) {
						s.characterId = list[0].id;
						if (!s.series) s.series = list[0].series;
						if (!s.imageUrl) s.imageUrl = list[0].imageUrl;
						if (!s.rarity) s.rarity = list[0].baseRarity || list[0].rarity;
					}
				} catch (err) {
					logger.warn(`Erro ao buscar personagem por nome no multi-roll: ${err.message}`);
				}
			}

			// Se tiver ID mas faltar detalhes (ex: imageUrl ou série), busca na API
			if (s.characterId && (!s.characterName || !s.imageUrl || !s.series)) {
				try {
					const charRes = await api
						.get(`/characters/${encodeURIComponent(s.characterId)}`)
						.catch(() => null);
					if (charRes?.data?.success && charRes?.data?.data) {
						const c = charRes.data.data;
						s.characterName = s.characterName || c.name;
						s.series = s.series || c.series;
						s.rarity = s.rarity || c.baseRarity || c.rarity;
						s.imageUrl = s.imageUrl || c.imageUrl;
					}
				} catch (err) {
					logger.warn(`Erro ao buscar detalhes de ${s.characterId}: ${err.message}`);
				}
			}

			return s;
		})
	);

	// 2. Obtenção da imagem do Grid com todas as waifus
	let gridBase64 = multiRollData.gridBase64 || null;

	// 2.1 Se não tiver no cache, tenta baixar a mídia da própria mensagem
	if (!gridBase64 && targetMediaSource) {
		const downloadFn =
			typeof targetMediaSource.downloadMedia === "function"
				? targetMediaSource.downloadMedia.bind(targetMediaSource)
				: typeof targetMediaSource.origin?.downloadMedia === "function"
					? targetMediaSource.origin.downloadMedia.bind(targetMediaSource.origin)
					: null;

		if (downloadFn) {
			try {
				const media = await downloadFn();
				if (media?.data) {
					gridBase64 = media.data;
				}
			} catch (dlErr) {
				logger.warn(`Erro ao baixar imagem da mensagem no multi-roll report: ${dlErr.message}`);
			}
		}
	}

	// 2.2 Se ainda não tiver o grid, reconstrói usando buildRollGridImage a partir das URLs individuais
	if (!gridBase64) {
		try {
			const downloadedBuffers = await Promise.all(
				resolvedSlots.map(async (s) => {
					const buf = s.imageUrl ? await downloadImageBuffer(s.imageUrl) : null;
					return { slot: s.slot, character: s, imageBuffer: buf };
				})
			);
			const validBuffers = downloadedBuffers.filter((b) => Boolean(b.imageBuffer));
			if (validBuffers.length > 0) {
				const gridBuf = await buildRollGridImage(downloadedBuffers);
				if (gridBuf) {
					gridBase64 = gridBuf.toString("base64");
				}
			}
		} catch (rebuildErr) {
			logger.error(`Erro ao reconstruir grid para denúncia de multi-roll: ${rebuildErr.message}`);
		}
	}

	// 3. Despacha denúncia de múltiplos rolls diretamente para a API oficial do Waifuletes (Telegram moderação)
	try {
		await api.post("/characters/multi-report", {
			slots: resolvedSlots.map((s) => ({
				slot: s.slot,
				characterId: s.characterId || null,
				characterName: s.characterName || null,
				series: s.series || null,
				rarity: s.rarity || "COMMON",
				imageUrl: s.imageUrl || null
			})),
			gridImageBase64: gridBase64 || null,
			reason: `Denúncia de rolls múltiplos via WhatsApp por ${denunciante} (${denuncianteId}) no grupo ${grupoOrigem}`,
			userId: denuncianteId,
			userName: `${denunciante} (${denuncianteId})`,
			source: grupoOrigem
		});
	} catch (apiErr) {
		logger.error(`Erro ao enviar denúncia de multi-roll para a API Waifuletes: ${apiErr.message}`);
	}

	// 4. Registra confirmação de denúncia no SQLite para cada personagem
	if (targetMsgId) {
		resolvedSlots.forEach((s) => {
			if (s.characterId) {
				recordWaifuReportConfirmation(
					targetMsgId,
					s.characterId,
					chatId,
					bot?.id,
					`Denúncia de rolls múltiplos: ${s.characterName || s.characterId}`
				);
			}
		});
	}

	// 5. Resposta amigável para o chat de origem
	return [
		new ReturnMessage({
			chatId,
			content: `⛔ *Denúncia Registrada!*\n\nOs *${resolvedSlots.length}* personagens deste sorteio foram encaminhados para a equipe de moderação. Obrigado por ajudar a manter o catálogo seguro!`,
			options: {
				waifuReportCharacterId: resolvedSlots[0]?.characterId || "multi",
				waifuReportCharacterIds: resolvedSlots.map((s) => s.characterId).filter(Boolean)
			}
		})
	];
}

/**
 * Denuncia um personagem problemático do Waifuletes para moderação
 * Envia imagem + detalhes + comando !sa-remudae para o grupo de logs
 *
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array<string>} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>}
 */
async function denunciarWaifu(bot, message, args, group) {
	const chatId =
		message.group ?? (message.originReaction ? message.originReaction.senderId : message.author);
	const groupId = getGroupId(message);
	const denuncianteId = message.originReaction ? message.originReaction.senderId : message.author;
	const denunciante =
		(message.originReaction
			? message.originReaction.userName || message.originReaction.pushName
			: null) ||
		message.authorName ||
		message.name ||
		denuncianteId;
	const grupoOrigem = group?.name || group?.subject || (message.group ? message.group : "Privado");

	let targetMsgId = null;
	let targetText = "";
	let targetMediaSource = null;
	let candidateIdOrQuery = null;

	if (message.originReaction) {
		targetMsgId =
			message.id || message.originReaction?.msgId?._serialized || message.originReaction?.msgId;
		targetText =
			message.caption ||
			(typeof message.content === "string" ? message.content : "") ||
			message.body ||
			"";
		targetMediaSource = message;
	} else {
		// 2. Chamada via comando normal (!mu-denunciar)
		// 2.1 Se informou argumentos explicitamente (!mu-denunciar <id-ou-nome>)
		if (args && args.length > 0) {
			candidateIdOrQuery = args.join(" ").trim();
		}

		// 2.2 Se respondeu/citou uma mensagem de roll
		let quotedMsg = null;
		if (typeof message.origin?.getQuotedMessage === "function") {
			quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		}
		if (quotedMsg) {
			targetMsgId =
				quotedMsg.id?._serialized || quotedMsg.id?.id || quotedMsg.id || message.quotedMessageId;
			targetText =
				quotedMsg.caption ||
				(typeof quotedMsg.content === "string" ? quotedMsg.content : "") ||
				quotedMsg.body ||
				"";
			targetMediaSource = quotedMsg;
		}
	}

	// ─── VERIFICAÇÃO DE MULTI-ROLL ─────────────────────────────────────────
	let multiRollData = null;

	// 1. Tenta identificar se o targetMsgId é um roll múltiplo (cache ou histórico)
	if (targetMsgId) {
		multiRollData = getMultiRollByMessageId(targetMsgId);
	}

	// 2. Se não achou por ID e não foi passado argumento específico de ID/nome,
	// inspeciona o texto da mensagem reagida/citada
	if (!multiRollData && (!candidateIdOrQuery || message.originReaction)) {
		const parsedSlots = extractMultiRollSlotsFromText(targetText);
		if (parsedSlots.length > 1) {
			multiRollData = {
				isMultiRoll: true,
				slots: parsedSlots
			};
		}
	}

	// 3. Fallback: se não tiver mensagem citada nem args, verifica o roll pendente no grupo
	if (!multiRollData && !candidateIdOrQuery && !targetMsgId) {
		const pending = pendingClaims.get(groupId);
		if (pending?.isMultiRoll && pending?.slots?.length > 1 && Date.now() <= pending.expiresAt) {
			multiRollData = pending;
		}
	}

	// Se for identificado como post de múltiplos rolls, processa pelo fluxo de multi-roll
	if (multiRollData && Array.isArray(multiRollData.slots) && multiRollData.slots.length > 1) {
		return await processMultiRollReport({
			bot,
			chatId,
			groupId,
			denunciante,
			denuncianteId,
			grupoOrigem,
			targetMsgId,
			targetMediaSource,
			multiRollData
		});
	}

	// ─── FLUXO DE ROLL ÚNICO (EXISTENTE) ──────────────────────────────────
	// 1. Se disparado por reação (⛔) na mensagem de roll único
	if (message.originReaction && !candidateIdOrQuery) {
		if (targetMsgId) {
			candidateIdOrQuery = getCharacterIdFromMessageId(targetMsgId);
		}
		if (!candidateIdOrQuery && targetText) {
			candidateIdOrQuery = extractCharacterFromRollText(targetText);
		}
		if (!candidateIdOrQuery) {
			const pending = pendingClaims.get(groupId);
			if (pending && Date.now() <= pending.expiresAt) {
				candidateIdOrQuery = pending.characterId;
			}
		}
		if (!candidateIdOrQuery) {
			return null;
		}
	} else if (!candidateIdOrQuery) {
		// 2. Chamada via comando normal sem args informados
		if (targetMsgId) {
			candidateIdOrQuery = getCharacterIdFromMessageId(targetMsgId);
		}
		if (!candidateIdOrQuery && targetText) {
			candidateIdOrQuery = extractCharacterFromRollText(targetText);
		}
		if (!candidateIdOrQuery) {
			const pending = pendingClaims.get(groupId);
			if (pending && Date.now() <= pending.expiresAt) {
				candidateIdOrQuery = pending.characterId;
			}
		}
	}

	if (!candidateIdOrQuery) {
		return new ReturnMessage({
			chatId,
			content:
				"⚠️ Para denunciar um personagem, responda (reply) ao roll dele com *!mu-denunciar*, reaja ao roll com ⛔, ou informe o ID/nome (ex: `!mu-denunciar <id>`)."
		});
	}

	// 5. Busca detalhes do personagem na API Waifuletes
	let character = null;
	try {
		// Tenta buscar por ID direto
		const res = await api
			.get(`/characters/${encodeURIComponent(candidateIdOrQuery)}`)
			.catch(() => null);
		if (res?.data?.success && res?.data?.data) {
			character = res.data.data;
		} else {
			// Tenta buscar por nome / busca textual
			const searchRes = await api
				.get("/characters", { params: { search: candidateIdOrQuery, limit: 1 } })
				.catch(() => null);
			const list = searchRes?.data?.data?.data || [];
			if (list.length > 0) {
				character = list[0];
			}
		}
	} catch (err) {
		logger.error(`Erro ao consultar personagem para denúncia: ${err.message}`);
	}

	if (!character) {
		return new ReturnMessage({
			chatId,
			content: `❌ Não foi possível encontrar o personagem "${candidateIdOrQuery}" no catálogo Waifuletes.`
		});
	}

	// 6. Despacha denúncia diretamente para a API oficial do Waifuletes (Telegram moderação)
	try {
		await api.post(`/characters/${encodeURIComponent(character.id)}/report`, {
			characterId: character.id,
			reason: `Denúncia via WhatsApp por ${denunciante} (${denuncianteId}) no grupo ${grupoOrigem}`,
			userId: denuncianteId,
			userName: `${denunciante} (${denuncianteId})`
		});
	} catch (apiErr) {
		logger.error(`Erro ao enviar denúncia para a API Waifuletes: ${apiErr.message}`);
	}

	// 7. Registra confirmação de denúncia no SQLite
	if (targetMsgId) {
		recordWaifuReportConfirmation(
			targetMsgId,
			character.id,
			chatId,
			bot?.id,
			`Denúncia encaminhada para moderação: ${character.name} (${character.id})`
		);
	}

	// 8. Resposta amigável para quem denunciou / grupo
	return [
		new ReturnMessage({
			chatId,
			content: `⛔ *Denúncia Registrada!*\n\nO personagem *${character.name}* foi encaminhado para a equipe de moderação. Obrigado por ajudar a manter o catálogo seguro!`,
			options: {
				waifuReportCharacterId: character.id
			}
		})
	];
}

/**
 * Consulta cooldowns ativos do usuário
 */
async function verCooldowns(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const donorBonuses = await DonorBonusService.getWaifuRollBonuses(userId);
		const extraMaxRolls = donorBonuses?.extraMaxRolls || 0;
		const { data } = await api.get(`/user/${userId}/cooldowns?extraMaxRolls=${extraMaxRolls}`);
		const { roll, claim, daily, dailyMarry } = data.data;

		let text = `⏳ *Seus Cooldowns Atuais:*\n\n`;

		if (roll) {
			const rollsAvail = roll.availableRolls ?? (roll.active ? 0 : 10);
			const maxR = roll.maxRolls ?? 10;
			if (rollsAvail >= maxR) {
				text += `🎲 Sorteio (Roll): ✅ *${rollsAvail}/${maxR} rolls disponíveis!*\n`;
			} else if (rollsAvail > 0) {
				text += `🎲 Sorteio (Roll): ⚠️ *${rollsAvail}/${maxR} rolls* (Próximo em *${formatRemainingSeconds(roll.remainingSeconds)}* | Cheio em *${formatRemainingSeconds(roll.fullRechargeSeconds)}*)\n`;
			} else {
				const fullAt = roll.fullRechargeAt ? new Date(roll.fullRechargeAt) : null;
				const timeStr = fullAt && !isNaN(fullAt.getTime()) ? ` às ${formatTimeBR(fullAt)}` : "";
				text += `🎲 Sorteio (Roll): ❌ *0/${maxR} rolls* (Próximo em *${formatRemainingSeconds(roll.remainingSeconds)}* | ${maxR}/${maxR} em *${formatRemainingSeconds(roll.fullRechargeSeconds)}*${timeStr})\n`;
			}
		}

		const farmBonus = await ShadowGardenBonusService.getWaifuBonus(userId);
		if ((farmBonus.rolls || 0) > 0 || (farmBonus.tickets || 0) > 0) {
			const parts = [];
			if (farmBonus.rolls > 0) parts.push(`*+${farmBonus.rolls} rolls* (Coração Púrpuro)`);
			if (farmBonus.tickets > 0)
				parts.push(`*+${farmBonus.tickets} tickets raros* (Rosa de Sangue)`);
			text += `🌱 Bônus da Fazenda: 🎁 ${parts.join(" | ")} acumulados e prontos para uso!\n`;
		}

		if (claim?.byRarity) {
			text += `💍 *Casamentos por Raridade:*\n`;
			const rarities = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"];
			for (const r of rarities) {
				const info = claim.byRarity[r];
				const label = RARITY_LABEL[r] || r;
				const emoji = RARITY_EMOJI[r] || "⚪";
				const dm = dailyMarry?.byRarity?.[r];

				if (r === "LEGENDARY") {
					const tradeInfo =
						typeof dm?.tradeUsed === "number"
							? ` — Diário: Sem limite (trocas: ${dm.tradeUsed}/10)`
							: ` — Diário: Sem limite`;
					if (info?.active) {
						const retryAt = info.retryAfter ? new Date(info.retryAfter) : null;
						const timeStr =
							retryAt && !isNaN(retryAt.getTime()) ? ` (às ${formatTimeBR(retryAt)})` : "";
						text += `• ${emoji} *${label}:* ❌ Aguarde *${formatRemainingSeconds(info.remainingSeconds)}*${timeStr}${tradeInfo}\n`;
					} else {
						const defaultMinutes = info?.cooldownSeconds
							? Math.floor(info.cooldownSeconds / 60)
							: null;
						let durStr = "";
						if (defaultMinutes) {
							if (defaultMinutes >= 60) {
								const h = Math.floor(defaultMinutes / 60);
								const m = defaultMinutes % 60;
								durStr = m > 0 ? ` (${h}h ${m}m)` : ` (${h}h)`;
							} else {
								durStr = ` (${defaultMinutes}m)`;
							}
						}
						text += `• ${emoji} *${label}:* ✅ *Disponível agora!*${durStr}${tradeInfo}\n`;
					}
				} else if (dm && dm.canMarry === false) {
					text += `• ${emoji} *${label}:* ❌ *Limite diário atingido!* (${dm.limit}/${dm.limit} casados hoje | reseta às 04:00)\n`;
				} else {
					const dailyInfo = dm
						? ` — Diário: ${dm.effectiveUsed}/${dm.limit} casados (${dm.remaining} restantes)`
						: "";
					if (info?.active) {
						const retryAt = info.retryAfter ? new Date(info.retryAfter) : null;
						const timeStr =
							retryAt && !isNaN(retryAt.getTime()) ? ` (às ${formatTimeBR(retryAt)})` : "";
						text += `• ${emoji} *${label}:* ❌ Aguarde *${formatRemainingSeconds(info.remainingSeconds)}*${timeStr}${dailyInfo}\n`;
					} else {
						const defaultMinutes = info?.cooldownSeconds
							? Math.floor(info.cooldownSeconds / 60)
							: null;
						let durStr = "";
						if (defaultMinutes) {
							if (defaultMinutes >= 60) {
								const h = Math.floor(defaultMinutes / 60);
								const m = defaultMinutes % 60;
								durStr = m > 0 ? ` (${h}h ${m}m)` : ` (${h}h)`;
							} else {
								durStr = ` (${defaultMinutes}m)`;
							}
						}
						text += `• ${emoji} *${label}:* ✅ *Disponível agora!*${durStr}${dailyInfo}\n`;
					}
				}
			}
			text += "\n";
		} else if (claim) {
			text += claim.active
				? `💍 Casamento (Claim): ❌ Aguarde *${formatRemainingSeconds(claim.remainingSeconds)}*\n`
				: `💍 Casamento (Claim): ✅ *Disponível agora!*\n`;
		}

		text += daily.active
			? `💜 Recompensa Diária (Zinthos): ❌ Aguarde *${formatRemainingSeconds(daily.remainingSeconds)}*\n`
			: `💜 Recompensa Diária (Zinthos): ✅ *Disponível agora!*\n`;

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar cooldowns.");
	}
}

/**
 * Consulta a tabela completa de probabilidades de drop e bônus da wishlist
 */
async function verChances(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	const donor = await DonorBonusService.getDonorByUserId(userId);
	const donorTotal = donor ? Number(donor.valor) || 0 : 0;
	let donorHeader = "";
	let donorBonuses = null;
	if (donorTotal > 0) {
		donorBonuses = DonorBonusService.calculateBonuses(donorTotal).waifu;
		donorHeader = `💎 *Doador, obrigado!* 💎\n`;
		donorHeader += `> _Seus benefícios de apoiador (R$ ${donorTotal.toFixed(2)}) estão ativos:_\n`;
		const legMult = donorBonuses.rarityMultipliers.LEGENDARY;
		const legPct = Math.round((legMult - 1) * 100);
		const rareMult = donorBonuses.rarityMultipliers.RARE;
		const rarePct = Math.round((rareMult - 1) * 100);
		const epicMult = donorBonuses.rarityMultipliers.EPIC;
		const epicPct = Math.round((epicMult - 1) * 100);
		const legCapTag = donorTotal >= 450 ? " _(Cap 10x)_" : " _(Cap 10x em R$ 450)_";

		donorHeader += `> • 🔵 *Raro:* +${rarePct}% | 🟣 *Épico:* +${epicPct}% | ⭐ *Lendário:* +${legPct}% (${legMult.toFixed(1)}x)${legCapTag}\n`;
		if (donorBonuses.extraMaxRolls > 0) {
			donorHeader += `> • 🎟️ *Rolls Máximos:* ${9 + donorBonuses.extraMaxRolls} rolls (9 base + ${donorBonuses.extraMaxRolls} extras por doação)\n`;
		}
		if (donorBonuses.wishlistMultiplier) {
			const wishBonusPct = Math.round((donorBonuses.wishlistMultiplier - 1) * 100);
			const wishCapTag = donorTotal >= 250 ? " _(Cap 20x)_" : " _(Cap 20x em R$ 250)_";
			donorHeader += `> • 🌟 *Wishlist:* +${wishBonusPct}% (${donorBonuses.wishlistMultiplier.toFixed(1)}x) de peso em desejos!${wishCapTag}\n`;
		}
		donorHeader += `\n`;
	}

	const stats = await getDropRateStats(userId);
	const totalChars = (stats?.totalCharacters || 27480).toLocaleString("pt-BR");
	const maxWl = stats?.wishlistMaxItems || WISHLIST_MAX_ITEMS;

	let text = donorHeader;

	const farmBonus = await ShadowGardenBonusService.getWaifuBonus(userId);
	if ((farmBonus.rolls || 0) > 0 || (farmBonus.tickets || 0) > 0) {
		text += `🌱 *Colheita do Jardim das Sombras:* 🌱\n`;
		if (farmBonus.rolls > 0) {
			text += `> • 🎲 *Rolls Extras:* +${farmBonus.rolls} rolls gratuitos (Coração Púrpuro)\n`;
		}
		if (farmBonus.tickets > 0) {
			text += `> • 🌹 *Tickets Raros:* +${farmBonus.tickets} tickets com bônus de raridade (Rosa de Sangue)\n`;
		}
		text += `\n`;
	}

	text += `🎯 *PROBABILIDADES E CHANCES DE DROP*\n`;
	text += `_Base de dados atualizada: *${totalChars}* personagens cadastrados_\n\n`;

	let breakdown = stats?.breakdown;
	if (breakdown && donorBonuses) {
		const wishMult = donorBonuses.wishlistMultiplier || 1.5;
		let donorTotalWeight = 0;
		const adjustedList = breakdown.map((b) => {
			const mult = donorBonuses.rarityMultipliers[b.rarity] || 1.0;
			const weight = Math.round(b.baseWeight * mult);
			const categoryWeight = b.count * weight;
			donorTotalWeight += categoryWeight;
			return {
				...b,
				donorWeight: weight,
				donorCatWeight: categoryWeight
			};
		});

		breakdown = adjustedList.map((b) => {
			const catChance = donorTotalWeight > 0 ? (b.donorCatWeight / donorTotalWeight) * 100 : 0;
			const singleBaseChance = donorTotalWeight > 0 ? (b.donorWeight / donorTotalWeight) * 100 : 0;

			let singleWishWeight;
			let singleWishLabel = null;
			if (b.rarity === "LEGENDARY") {
				// Desacoplamento para Lendários conforme regra do Waifuletes
				const rMult = donorBonuses.rarityMultipliers?.LEGENDARY || 1.0;
				const combinedMult = Math.max(1.0, rMult + Math.max(0, wishMult - 1.0));
				singleWishWeight = Math.round(b.baseWeight * combinedMult);
				singleWishLabel = `*+${Math.round((combinedMult - 1) * 100)}% (desacoplado)*`;
			} else {
				singleWishWeight = Math.round(b.donorWeight * wishMult);
				singleWishLabel = `*+${Math.round((wishMult - 1) * 100)}%*`;
			}

			const singleWishChance =
				donorTotalWeight > 0 ? (singleWishWeight / donorTotalWeight) * 100 : 0;
			const oneInX = catChance > 0 ? Math.round(100 / catChance) : null;
			const singleBaseOneInX = singleBaseChance > 0 ? Math.round(100 / singleBaseChance) : null;
			const singleWishOneInX = singleWishChance > 0 ? Math.round(100 / singleWishChance) : null;

			return {
				...b,
				baseWeight: b.donorWeight,
				categoryChance: catChance,
				singleBaseChance,
				singleWishChance,
				singleWishLabel,
				oneInX,
				singleBaseOneInX,
				singleWishOneInX
			};
		});

		if (userId) {
			const recalculatedWishlist = await getUserWishlistStats(
				userId,
				donorTotalWeight,
				donorBonuses
			);
			if (recalculatedWishlist) {
				stats.userWishlistStats = recalculatedWishlist;
			}
		}
	}

	text += `📊 *Chances por Categoria de Personagem:*\n`;
	if (breakdown) {
		for (const b of breakdown) {
			const emoji = RARITY_EMOJI[b.rarity] || "⚪";
			const label = RARITY_LABEL[b.rarity] || b.rarity;
			const catChanceStr =
				b.categoryChance < 0.01 ? b.categoryChance.toFixed(3) : b.categoryChance.toFixed(2);
			const singleBaseStr =
				b.singleBaseChance < 0.001 ? b.singleBaseChance.toFixed(4) : b.singleBaseChance.toFixed(3);
			const singleWishStr =
				b.singleWishChance < 0.001 ? b.singleWishChance.toFixed(4) : b.singleWishChance.toFixed(3);

			const isLeg = b.rarity === "LEGENDARY";
			const legRollCapNote = isLeg ? " _(Cap no roll: 0,80%)_" : "";

			text += `${emoji} *${label}* (${b.count.toLocaleString("pt-BR")} no banco | Peso ${b.baseWeight})\n`;
			text += `   ↳ Drop da categoria: *${catChanceStr}%* ${b.oneInX ? `(~1 a cada ${b.oneInX.toLocaleString("pt-BR")} rolls)` : ""}${legRollCapNote}\n`;
			text += `   ↳ 1 específico (base): *${singleBaseStr}%* (1 em ${b.singleBaseOneInX?.toLocaleString("pt-BR") || "?"})\n`;
			const wishBonusLabel =
				b.singleWishLabel ||
				(donorBonuses?.wishlistMultiplier
					? `*+${Math.round((donorBonuses.wishlistMultiplier - 1) * 100)}%*`
					: `*+50%*`);
			text += `   ↳ Com Wishlist: *${singleWishStr}%* (${wishBonusLabel} | 1 em ${b.singleWishOneInX?.toLocaleString("pt-BR") || "?"})\n\n`;
		}
	} else {
		text += `⚪ *Comum:* ~93,30% (peso 100 | 1 específico: 0,0039%)\n`;
		text += `🟢 *Incomum:* ~5,59% (peso 60 | 1 específico: 0,0023%)\n`;
		text += `🔵 *Raro:* ~0,98% (peso 25 | 1 específico: 0,0010%)\n`;
		text += `🟣 *Épico:* ~0,07% (peso 8 | 1 específico: 0,0003%)\n`;
		text += `⭐ *Lendário:* ~0,005% (peso 2.5 | 1 específico: 0,0001% | Cap no roll: 0,80%)\n\n`;
	}

	if (donorBonuses?.wishlistMultiplier) {
		const wishMultVal = donorBonuses.wishlistMultiplier.toFixed(1);
		const wishBonusPct = Math.round((donorBonuses.wishlistMultiplier - 1) * 100);
		const wishCapTag = donorTotal >= 250 ? " _(Cap 20x atingido!)_" : " _(Cap 20x em R$ 250)_";
		text += `🌟 *Efeito da Wishlist (Até ${maxWl} Desejos) [BÔNUS VIP ATIVO]:*\n`;
		text += `• Cada personagem desejado tem o peso multiplicado por *${wishMultVal}x (+${wishBonusPct}%)*${wishCapTag}!\n`;
		text += `• _Regra de Lendários:_ Bônus de wishlist desacoplado (soma ao bônus de raridade sem cascata) e sujeito ao teto máximo de 0,80% por roll.\n`;
	} else {
		text += `🌟 *Efeito da Wishlist (Até ${maxWl} Desejos):*\n`;
		text += `• Cada personagem desejado tem o peso multiplicado por *1.5x (+50%)*.\n`;
		text += `• Se for marcado como Star Wish, o multiplicador é de *2.0x (+100%)*.\n`;
		text += `• _Caps do Waifuletes:_ Lendários possuem cap em R$ 450 (10x), Wishlist cap em R$ 250 (20x) e teto de drop de Lendários em 0,80% no roll.\n`;
	}

	if (stats?.userWishlistStats && stats.userWishlistStats.count > 0) {
		let anyWishChance = stats.userWishlistStats.anyWishChance;
		if (donorBonuses?.wishlistMultiplier && !donorTotal) {
			anyWishChance = Math.min(100, anyWishChance * (donorBonuses.wishlistMultiplier / 1.5));
		}
		const wishChanceStr =
			anyWishChance < 0.01 ? anyWishChance.toFixed(3) : anyWishChance.toFixed(2);
		text += `\n✨ *Sua Wishlist Pessoal (${stats.userWishlistStats.count}/${maxWl} itens):*\n`;
		text += `• Chance de tirar QUALQUER desejo seu no próximo roll: *${wishChanceStr}%*\n`;
		const oneInX = anyWishChance > 0 ? Math.round(100 / anyWishChance) : null;
		if (oneInX) {
			text += `• Média estimada: *1 a cada ~${oneInX.toLocaleString("pt-BR")} rolls*!\n`;
		}
	} else {
		text += `\n💡 *Dica:* Você ainda não tem itens na Wishlist. Use \`!mu-desejar <id>\` (até ${maxWl}) para aumentar a chance de tirar seus personagens favoritos!\n`;
	}

	text += `\n⚡ *Filtros de Gênero:* Rolar com \`!mu-rollf\` (apenas waifus) ou \`!mu-rollm\` (apenas husbandos) reduz o total de candidatos pela metade/terço, quase *triplicando* a chance individual de cada personagem!`;

	return new ReturnMessage({
		chatId,
		content: text,
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		}
	});
}

/**
 * Alterna a menção/marcação de membros da wishlist durante rolls no grupo
 * @param {Object} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 */
async function toggleRollMarcar(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só pode ser usado em grupos.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	let groupObj = group;
	if (!groupObj || !groupObj.filters) {
		try {
			groupObj = await (bot?.database || database)?.getGroup?.(message.group);
		} catch (err) {
			logger.error(`[toggleRollMarcar] Erro ao carregar grupo ${message.group}:`, err);
		}
	}

	if (!groupObj) {
		return new ReturnMessage({
			chatId,
			content: "❌ Não foi possível carregar as configurações deste grupo.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	let chat = null;
	if (message?.origin && typeof message.origin.getChat === "function") {
		try {
			chat = await message.origin.getChat();
		} catch (_) {}
	}

	const senderId = message.author || getUserId(message);
	const isAdmin = await adminUtils.isAdmin(senderId, groupObj, chat, bot);
	if (!isAdmin) {
		return new ReturnMessage({
			chatId,
			content: "❌ Apenas administradores do grupo podem alterar essa configuração.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	if (!groupObj.filters) {
		groupObj.filters = {};
	}

	const currentStatus = groupObj.filters.waifuRollMarcar !== false;
	let newStatus;

	if (args && args.length > 0) {
		const arg = String(args[0]).toLowerCase().trim();
		if (["on", "ligar", "ativar", "sim", "1", "true"].includes(arg)) {
			newStatus = true;
		} else if (["off", "desligar", "desativar", "nao", "não", "0", "false"].includes(arg)) {
			newStatus = false;
		} else {
			newStatus = !currentStatus;
		}
	} else {
		newStatus = !currentStatus;
	}

	groupObj.filters.waifuRollMarcar = newStatus;

	try {
		await (bot?.database || database).saveGroup(groupObj);
	} catch (err) {
		logger.error(`[toggleRollMarcar] Erro ao salvar grupo ${message.group}:`, err);
		return new ReturnMessage({
			chatId,
			content: "❌ Erro ao salvar configuração do grupo no banco de dados.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	const statusText = newStatus
		? "✅ *Menções de Wishlist no Roll ATIVADAS neste grupo!*\n\nQuando um personagem da wishlist de algum membro for sorteado, ele será mencionado com @."
		: "❌ *Menções de Wishlist no Roll DESATIVADAS neste grupo!*\n\nPersonagens da wishlist continuarão sendo sorteados e bonificados normalmente, mas nenhum membro será marcado com @.";

	return new ReturnMessage({
		chatId,
		content: statusText,
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		}
	});
}

const WAIFU_CATEGORY_BUTTONS = [
	[
		{ text: "🎲 Sorteio & Taxas", action: { type: "waifu_menu", category: "sorteio", page: 0 } },
		{ text: "💍 Casamento & Harém", action: { type: "waifu_menu", category: "casamento", page: 0 } }
	],
	[
		{ text: "📁 Coleções / Pastas", action: { type: "waifu_menu", category: "colecoes", page: 0 } },
		{ text: "💰 Economia & Perfil", action: { type: "waifu_menu", category: "economia", page: 0 } }
	],
	[
		{
			text: "🌟 Wishlist & Catálogo",
			action: { type: "waifu_menu", category: "wishlist", page: 0 }
		},
		{ text: "📈 Mercado & Investir", action: { type: "waifu_menu", category: "mercado", page: 0 } }
	],
	[
		{
			text: "🏷️ Classificados & Trocas",
			action: { type: "waifu_menu", category: "trocas", page: 0 }
		},
		{ text: "⚙️ Configurações", action: { type: "waifu_menu", category: "configs", page: 0 } }
	]
];

const WAIFU_CATEGORY_DETAILS = {
	sorteio: {
		title: "🎲 Sorteio (Rolls) & Taxas",
		description:
			"Comandos para invocar novas waifus e husbandos ou consultar suas chances de drop:",
		commands: [
			{
				cmd: "/mu_roll",
				aliases: ["/mu_r", "/mu_w", "/mu_waifu"],
				desc: "Sorteia waifus e husbandos misturados."
			},
			{
				cmd: "/mu_rollm",
				aliases: ["/mu_rm", "/mu_husbando"],
				desc: "Sorteia apenas personagens masculinos."
			},
			{ cmd: "/mu_rollf", aliases: ["/mu_rf"], desc: "Sorteia apenas personagens femininos." },
			{
				cmd: "/mu_chances",
				aliases: ["/mu_taxas", "/mu_prob"],
				desc: "Consulta as taxas de drop e probabilidade da sua wishlist."
			}
		]
	},
	casamento: {
		title: "💍 Casamento & Harém",
		description: "Comandos para casar, gerenciar seu harém e celebrar sua união:",
		commands: [
			{
				cmd: "/mu_casar",
				aliases: ["/mu_c", "/mu_claim"],
				desc: "Casa com o personagem rolado nos últimos 300s."
			},
			{
				cmd: "/mu_foto [nova] <nome>",
				aliases: ["/mu_photo", "/mu_fotocasal"],
				desc: "Gera a foto oficial de casamento do casal."
			},
			{
				cmd: "/mu_divorciar <id>",
				aliases: ["/mu_div", "/mu_d"],
				desc: "Divorcia um personagem e resgata Zinthos."
			},
			{
				cmd: "/mu_harem [@user | pág]",
				aliases: ["/mu_h"],
				desc: "Lista todas as waifus/husbandos do seu harém."
			},
			{
				cmd: "/mu_harem_nome <nome>",
				aliases: ["/mu_hnome"],
				desc: "Define um nome personalizado para o harém."
			},
			{
				cmd: "/mu_harem_privado",
				aliases: ["/mu_hprivado"],
				desc: "Alterna visibilidade do harém (público/privado)."
			},
			{
				cmd: "/mu_harem_foto <char> [idx]",
				aliases: ["/mu_hfoto"],
				desc: "Fixa uma foto de destaque no card do harém."
			},
			{
				cmd: "/mu_favorito <id>",
				aliases: ["/mu_fav"],
				desc: "Alterna waifus favoritas em destaque (até 5)."
			},
			{
				cmd: "/mu_soulmates",
				aliases: ["/mu_sm", "/mu_almas"],
				desc: "Lista seus parceiros com 10+ chaves."
			}
		]
	},
	colecoes: {
		title: "📁 Coleções (Pastas)",
		description: "Comandos para organizar suas waifus em pastas temáticas personalizadas:",
		commands: [
			{
				cmd: "/mu_colecoes [nome/nº]",
				aliases: ["/mu_cols"],
				desc: "Lista suas pastas ou exibe waifus de uma coleção."
			},
			{
				cmd: "/mu_col_nova <nome>",
				aliases: ["/mu_col_criar"],
				desc: "Cria uma nova coleção para organizar o harém."
			},
			{
				cmd: "/mu_col_del <nome/nº>",
				aliases: ["/mu_col_rm"],
				desc: "Apaga uma pasta (personagens voltam ao harém)."
			},
			{ cmd: "/mu_col_add <pasta> | <char>", desc: "Move uma waifu do harém para a pasta." },
			{ cmd: "/mu_col_rem <char>", desc: "Remove a waifu de sua pasta atual." },
			{
				cmd: "/mu_col_privada <pasta>",
				aliases: ["/mu_col_priv"],
				desc: "Alterna visibilidade privada de uma coleção."
			},
			{
				cmd: "/mu_col_ordem <p1> | <p2>",
				aliases: ["/mu_col_ordenar"],
				desc: "Define a ordem de exibição das coleções."
			}
		]
	},
	economia: {
		title: "💰 Economia & Perfil",
		description: "Comandos de moedas Zinthos, diário, estatísticas e rankings:",
		commands: [
			{
				cmd: "/mu_diario",
				aliases: ["/mu_daily", "/mu_dz"],
				desc: "Coleta sua recompensa diária de Zinthos."
			},
			{
				cmd: "/mu_saldo",
				aliases: ["/mu_zinthos", "/mu_z"],
				desc: "Consulta seu saldo atual de Zinthos."
			},
			{
				cmd: "/mu_perfil",
				aliases: ["/mu_p", "/mu_eu"],
				desc: "Exibe seu perfil de jogador, stats e favorita."
			},
			{
				cmd: "/mu_ranking [top]",
				aliases: ["/mu_top", "/mu_rank"],
				desc: "Ranking dos jogadores mais ricos em Zinthos."
			},
			{
				cmd: "/mu_topgrupo",
				aliases: ["/mu_rankgrupo"],
				desc: "Ranking exclusivo do grupo atual."
			},
			{
				cmd: "/mu_cooldowns",
				aliases: ["/mu_cd", "/mu_tempo"],
				desc: "Consulta o tempo restante dos cooldowns."
			}
		]
	},
	wishlist: {
		title: "🌟 Wishlist & Catálogo",
		description: "Comandos para desejar personagens (+50% no drop), buscar e explorar o catálogo:",
		commands: [
			{
				cmd: "/mu_wishlist",
				aliases: ["/mu_wl", "/mu_desejos"],
				desc: "Lista seus personagens desejados."
			},
			{
				cmd: "/mu_desejar <id>",
				aliases: ["/mu_wish", "/mu_add"],
				desc: "Adiciona waifu à sua wishlist (+50% no drop)."
			},
			{
				cmd: "/mu_cobiçar <id>",
				aliases: ["/mu_cobicar"],
				desc: "Cobiça waifu casada de outro jogador."
			},
			{
				cmd: "/mu_removerdesejo <id>",
				aliases: ["/mu_rmwish"],
				desc: "Remove um personagem da wishlist."
			},
			{
				cmd: "/mu_wishlist_limpar",
				aliases: ["/mu_wllimpar"],
				desc: "Remove waifus já casadas da sua wishlist."
			},
			{
				cmd: "/mu_like <id>",
				aliases: ["/mu_l"],
				desc: "Dá like em um personagem para subir no ranking."
			},
			{
				cmd: "/mu_personagens <busca>",
				aliases: ["/mu_chars"],
				desc: "Pesquisa personagens no catálogo por nome/série."
			},
			{
				cmd: "/mu_char <busca>",
				aliases: ["/mu_info"],
				desc: "Exibe foto e detalhes de um personagem."
			},
			{
				cmd: "/mu_topchars",
				aliases: ["/mu_topwaifus"],
				desc: "Mostra os personagens mais populares do jogo."
			},
			{
				cmd: "/mu_adm",
				aliases: ["/mu_admin"],
				desc: "Envia link privado do Painel Web (30 min)."
			},
			{
				cmd: "/waifinder",
				aliases: ["/mu_tinder"],
				desc: "Envia link de acesso ao Waifinder estilo Tinder."
			},
			{
				cmd: "/mu_share",
				aliases: ["/mu_compartilhar"],
				desc: "Exibe o link público do seu harém."
			}
		]
	},
	mercado: {
		title: "📈 Mercado & Investimentos",
		description:
			"Comandos para adquirir cotas de 25% de waifus e acompanhar a cotação macroeconômica:",
		commands: [
			{
				cmd: "/mu_investir <id> [cotas]",
				aliases: ["/mu_cota"],
				desc: "Adquire cotas de 25% (super bônus de drop + claim)."
			},
			{
				cmd: "/mu_investimentos",
				aliases: ["/mu_cotas"],
				desc: "Lista suas waifus investidas e bônus ativos."
			},
			{
				cmd: "/mu_cotacao <id>",
				aliases: ["/mu_preco"],
				desc: "Consulta cotação integral e por cota de 25%."
			},
			{
				cmd: "/mu_mercado",
				aliases: ["/mu_economia"],
				desc: "Panorama macroeconômico e tabela por raridade."
			}
		]
	},
	trocas: {
		title: "🏷️ Classificados & Trocas",
		description: "Comandos para anunciar waifus e negociar trocas P2P:",
		commands: [
			{
				cmd: "/mu_vender <id> <procura>",
				aliases: ["/mu_anunciar"],
				desc: "Anuncia uma waifu nos classificados globais."
			},
			{ cmd: "/mu_classificados", desc: "Lista as waifus disponíveis nos classificados." },
			{ cmd: "/mu_ofertas", desc: "Lista ofertas de troca recebidas para suas waifus." },
			{ cmd: "/mu_of_aceitar <id>", desc: "Aceita uma proposta de troca recebida." },
			{ cmd: "/mu_of_negar <id>", desc: "Nega uma proposta de troca recebida." }
		]
	},
	configs: {
		title: "⚙️ Configurações do Grupo",
		description: "Comandos de gestão do jogo no grupo (Apenas Admins):",
		commands: [
			{
				cmd: "/mu_roll_marcar",
				aliases: ["/mu_rollmarcar"],
				desc: "Alterna menção (@) quando waifu da wishlist for rolada."
			}
		]
	}
};

/**
 * Trata callbacks de navegação interativa no menu de Waifus (TelegramBot e DiscordBot)
 * @param {Object} bot - Instância do bot Telegram ou Discord
 * @param {Object} callbackQuery - callback_query do Telegram (ou adaptador equivalente do Discord)
 * @param {string} category - Categoria solicitada ou 'root'
 * @param {number} [page=0] - Página atual
 */
async function handleWaifuMenuCallback(bot, callbackQuery, category, page = 0) {
	try {
		const message = callbackQuery.message;
		if (!message || !message.chat) return;

		if (category === "root") {
			const text =
				`📋 *NAVEGADOR DE COMANDOS DO WAIFULETES*\n\n` +
				`Toque em uma categoria abaixo para ver a explicação e lista detalhada de comandos:`;
			await editInteractiveMenuMessage(bot, callbackQuery, text, WAIFU_CATEGORY_BUTTONS);
			return;
		}

		const catInfo = WAIFU_CATEGORY_DETAILS[category];
		if (!catInfo) return;

		// Comandos são escritos no estilo Telegram (/mu_roll); no Discord exibe com o prefixo do grupo (!mu-roll)
		const fmtCmd = (cmd) => formatMenuCommand(bot, cmd, callbackQuery);
		let catText = `*${catInfo.title}*\n\n${catInfo.description}\n\n`;
		for (const c of catInfo.commands) {
			const aliasStr = c.aliases?.length
				? ` (aliases: \`${c.aliases.map(fmtCmd).join("`, `")}\`)`
				: "";
			catText += `• \`${fmtCmd(c.cmd)}\`${aliasStr} — ${c.desc}\n`;
		}

		const navButtons = [
			[
				{
					text: "⬅️ Voltar ao Navegador de Comandos",
					action: { type: "waifu_menu", category: "root", page: 0 }
				}
			]
		];

		await editInteractiveMenuMessage(bot, callbackQuery, catText, navButtons);
	} catch (err) {
		if (bot?.logger?.error) {
			bot.logger.error(`[handleWaifuMenuCallback] Erro: ${err.message}`, err);
		}
	}
}

/**
 * Explica o jogo (clone não-oficial de Mudae), suas mecânicas e lista todos os comandos
 */
async function ajudaWaifus(bot, message) {
	const chatId = message.group ?? message.author;
	const stats = await getDropRateStats();
	const totalChars = (stats?.totalCharacters || 27480).toLocaleString("pt-BR");

	let text = `🎲 *WAIFULETES (MUDAE)* — _Clone Não-Oficial do Mudae no WhatsApp_\n\n`;
	text += `O *Waifuletes* é um jogo de roleta de personagens de animes, mangás e games inspirado no clássico bot Mudae do Discord, totalmente adaptado para o WhatsApp através da API REST do Waifuletes.\n\n`;

	text += `━━━━━━━━━━━━━━━━━━━━━\n`;
	text += `📖 *MECÂNICAS DO JOGO*\n`;
	text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

	text += `🎲 *1. Sorteio (Roll)*\n`;
	text += `• Ao rolar com \`!mu-roll\`, você sorteia um personagem aleatório dentre os *${totalChars}* cadastrados no banco de dados.\n`;
	text += `• A chance de drop de cada categoria (calculada com base no peso e total na base atual) é:\n`;
	if (stats?.breakdown) {
		for (const b of stats.breakdown) {
			const emoji = RARITY_EMOJI[b.rarity] || "⚪";
			const label = RARITY_LABEL[b.rarity] || b.rarity;
			const catChanceStr =
				b.categoryChance < 0.01 ? b.categoryChance.toFixed(3) : b.categoryChance.toFixed(2);
			const oneInStr = b.oneInX ? ` (~1 a cada ${b.oneInX.toLocaleString("pt-BR")} rolls)` : "";
			text += `  ${emoji} *${label}:* ${catChanceStr}% (${b.count.toLocaleString("pt-BR")} chars | peso ${b.baseWeight})${oneInStr}\n`;
		}
	} else {
		text += `  ⚪ *Comum:* ~68,74% (112.144 chars | peso 100)\n`;
		text += `  🟢 *Incomum:* ~28,35% (77.095 chars | peso 60 | 1 em 4 rolls)\n`;
		text += `  🔵 *Raro:* ~2,39% (15.576 chars | peso 25 | 1 em 42 rolls)\n`;
		text += `  🟣 *Épico:* ~0,51% (10.384 chars | peso 8 | 1 em 196 rolls)\n`;
		text += `  ⭐ *Lendário:* ~0,012% (379 chars | peso 5 | 1 em 8.600 rolls)\n`;
	}
	text += `• Digite \`!mu-chances\` para abrir o painel completo de probabilidades e simulação!\n`;
	text += `• Você pode filtrar apenas homens com \`!mu-rollm\` ou apenas mulheres com \`!mu-rollf\` (quase triplica a chance individual ao reduzir o pool de personagens).\n`;
	text += `• *Sistema de Rolls:* Cada jogador possui até 9 rolls no banco (recarrega 1 roll a cada 5 minutos até o limite — doadores ganham +1 roll máximo a cada R$ 10 doados!).\n\n`;

	text += `💍 *2. Casamento (Claim) & Limites Diários*\n`;
	text += `• Quando um personagem *livre* é rolado no grupo, abre-se uma janela de *300 segundos (5 minutos)*.\n`;
	text += `• O primeiro jogador a enviar \`!mu-casar\` (ou \`!mu-c\`) se casa com a waifu/husbando!\n`;
	text += `• O personagem passa a pertencer ao seu Harém global (em todos os grupos do bot).\n`;
	text += `• *Cooldown de casamento:* Individual por raridade (Comum: 30m, Incomum: 45m, Raro: 1h, Épico: 1h30m, Lendário: 2h). Casar com uma waifu não bloqueia as demais raridades!\n`;
	text += `• *Limites Diários de Casamento:* Por raridade (reseta todo dia às 04:00 BRT):\n`;
	text += `  ⚪ *Comum:* 25/dia | 🟢 *Incomum:* 20/dia | 🔵 *Raro:* 15/dia | 🟣 *Épico:* 10/dia\n`;
	text += `  ⭐ *Lendário:* Sem limite no roll (máximo 10 recebidas por dia em trocas dos classificados)\n`;
	text += `• *Classificados & Trocas:* Receber um personagem em troca consome 50% da cota da raridade (2 trocas = 1 casamento). Arredonda para cima (0.5 conta como 1, mas se você tiver 0.5 consumido o \`!mu-casar\` é permitido).\n\n`;

	text += `🔑 *3. Chaves (Keys) & Soulmates*\n`;
	text += `• Se você rolar um personagem que *já pertence a você*, você ganha *+1 Chave (Key)*!\n`;
	text += `• Ao acumular *10 Chaves*, esse personagem é promovido a *💖 Soulmate definitivo*!\n`;
	text += `• *Vantagens exclusivas de Soulmate:*\n`;
	text += `  🏆 *Bônus no Rank:* Adiciona +25 pontos extras de valor da coleção no ranking geral!\n`;
	text += `  📝 *Personalização Total:* Permite definir apelido afetuoso e nota carinhosa no painel web!\n`;
	text += `  ✨ *Cristais Raros Turbinados:* Bônus massivo em Zinthos ao ser rolado por outros jogadores!\n`;
	text += `  💰 *Divórcio Dourado:* Em caso de divórcio, devolve o valor integral de 4 cotas dinâmicas (450k a 6,3M Zinthos + inflação) + 30k por chave!\n\n`;

	text += `💜 *4. Economia Zinthos*\n`;
	text += `• *Zinthos (💜)* é a moeda oficial do jogo.\n`;
	text += `• Resgate sua recompensa diária (reseta todos os dias às 04:00) usando \`!mu-diario\`.\n`;
	text += `• Quando alguém rola um personagem que já é seu, um cristal de Zinthos é gerado com base no valor da sua waifu.\n`;
	text += `• Você também pode divorciar personagens com \`!mu-divorciar <id>\` para resgatar Zinthos: o valor considera a raridade base, bônus por chave escalonado (500 a 75k) e a inflação atual de mercado. Se for Soulmate, concede o Divórcio Dourado (4 cotas)! (Possui soft limite diário por raridade: 1º 100%, 2º 80%, 3º 50%, 4º 20%, 5º+ 5%; reseta às 04:00 BRT).\n\n`;

	text += `🏠 *5. Sistema de Hospedagem & Inatividade*\n`;
	text += `• Manter seu harém exige recursos! Todo dia às 04:00 BRT é cobrada uma taxa de hospedagem:\n`;
	text += `  • *Jogadores Ativos:* ⚪ 1z | 🟢 3z | 🔵 8z | 🟣 15z | ⭐ 40z por waifu/dia.\n`;
	text += `  • *Inativos (>72h sem jogar):* ⚪ 10z | 🟢 60z | 🔵 200z | 🟣 350z | ⭐ 1.000z por waifu/dia.\n`;
	text += `• *Sem saldo suficiente?* Waifus são confiscadas automaticamente da menor para a maior raridade para quitar a dívida (abatendo 30% do valor de divórcio da waifu). A sobra permanece com você!\n\n`;

	text += `🌟 *6. Lista de Desejos (Wishlist)*\n`;
	text += `• Adicione até *${WISHLIST_MAX_ITEMS}* personagens à sua wishlist com \`!mu-desejar <id>\`.\n`;
	text += `• *Bônus no Roll:* Cada personagem na sua lista ganha *+50% de peso* (multiplicador 1.5x) nos seus sorteios! (Star Wish ganha +100% / 2.0x).\n`;
	text += `• *Bônus de Zinthos Proporcional:* Cada waifu na Wishlist adiciona *+0,1% de Zinthos* em rolls e diários (+1/1000 por item), dobrando o valor adquirido (2.0x) ao atingir 1000 desejos!\n\n`;
	text += `❤️ *7. Curtidas (Likes)*\n`;
	text += `• Dê like nos seus personagens favoritos com \`!mu-like <id>\` para aumentar a popularidade global deles.\n\n`;

	// Se for no Telegram, divide em 2 mensagens: 1 com introdução/mecânicas e outra com o menu interativo de comandos
	if (bot && bot.useTelegram) {
		const navigatorText =
			`📋 *NAVEGADOR DE COMANDOS DO WAIFULETES*\n\n` +
			`Toque em uma categoria abaixo para ver a explicação e lista detalhada de comandos:`;

		const msg1 = new ReturnMessage({
			chatId,
			content: text,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});

		const msg2 = new ReturnMessage({
			chatId,
			content: navigatorText,
			telegram: {
				buttons: WAIFU_CATEGORY_BUTTONS
			}
		});

		return [msg1, msg2];
	}

	text += `━━━━━━━━━━━━━━━━━━━━━\n`;
	text += `📋 *LISTA COMPLETA DE COMANDOS*\n`;
	text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

	text += `🎲 *Sorteio (Rolls) & Taxas:*\n`;
	text += `• \`!mu-roll\` (aliases: \`!mu-r\`, \`!mu-w\`, \`!mu-waifu\`) — Sorteia waifus e husbandos misturados.\n`;
	text += `• \`!mu-rollm\` (aliases: \`!mu-rm\`, \`!mu-husbando\`) — Sorteia apenas personagens masculinos.\n`;
	text += `• \`!mu-rollf\` (aliases: \`!mu-rf\`) — Sorteia apenas personagens femininos.\n`;
	text += `• \`!mu-chances\` (aliases: \`!mu-taxas\`, \`!mu-prob\`) — Consulta as taxas de drop e probabilidade da sua wishlist.\n\n`;

	text += `💍 *Casamento e Harém:*\n`;
	text += `• \`!mu-casar\` (aliases: \`!mu-c\`, \`!mu-claim\`, \`!mu-marry\`) — Casa com o personagem rolado nos últimos 300s.\n`;
	text += `• \`!mu-foto [nova] <nome>\` (aliases: \`!mu-photo\`, \`!mu-fotocasal\`) — Consulta ou gera a foto oficial de casamento do casal.\n`;
	text += `• \`!mu-divorciar <id>\` (aliases: \`!mu-div\`, \`!mu-d\`) — Divorcia um personagem e resgata Zinthos (com soft limite diário por raridade; 4 cotas para Soulmates).\n`;
	text += `• \`!mu-harem [@usuário | página]\` (alias: \`!mu-h\`) — Lista todas as waifus/husbandos que você ou outro usuário possui.\n`;
	text += `• \`!mu-harem-nome <nome>\` (aliases: \`!mu-hnome\`, \`!mu-nomeharem\`) — Define um nome personalizado para o seu harém (até 20 caracteres).\n`;
	text += `• \`!mu-harem-privado\` (alias: \`!mu-hprivado\`) — Alterna a privacidade do seu harém entre público e privado.\n`;
	text += `• \`!mu-harem-foto <personagem> [índice | casamento | reset]\` (alias: \`!mu-hfoto\`) — Consulta fotos ou fixa uma foto no card do harém.\n`;
	text += `• \`!mu-favorito <id>\` (aliases: \`!mu-fav\`) — Alterna personagens favoritos em destaque (até 5 favoritas).\n`;
	text += `• \`!mu-soulmates\` (aliases: \`!mu-sm\`, \`!mu-almas\`) — Lista seus parceiros com 10+ chaves.\n\n`;

	text += `📁 *Coleções (Pastas):*\n`;
	text += `• \`!mu-colecoes [nome/nº]\` (aliases: \`!mu-colecao\`, \`!mu-cols\`) — Lista suas pastas ou exibe os personagens de uma coleção.\n`;
	text += `• \`!mu-col-nova <nome>\` (aliases: \`!mu-col-criar\`, \`!mu-col-new\`) — Cria uma nova coleção para organizar o harém (até 15).\n`;
	text += `• \`!mu-col-del <nome/nº>\` (aliases: \`!mu-col-rm\`) — Apaga uma pasta (personagens voltam ao harém geral).\n`;
	text += `• \`!mu-col-add <pasta> | <personagem>\` — Move uma waifu do harém para a pasta.\n`;
	text += `• \`!mu-col-rem <personagem>\` — Remove a waifu de sua pasta atual.\n`;
	text += `• \`!mu-col-privada <pasta>\` (alias: \`!mu-col-priv\`) — Alterna a visibilidade privada de uma coleção.\n`;
	text += `• \`!mu-col-ordem <pasta1> | <pasta2> | ...\` (alias: \`!mu-col-ordenar\`) — Define a ordem de exibição das coleções.\n\n`;

	text += `💰 *Economia & Perfil:*\n`;
	text += `• \`!mu-diario\` (aliases: \`!mu-daily\`, \`!mu-dz\`, \`!mu-dk\`) — Coleta sua recompensa diária de Zinthos.\n`;
	text += `• \`!mu-saldo\` (aliases: \`!mu-zinthos\`, \`!mu-z\`, \`!mu-k\`) — Consulta seu saldo atual de Zinthos.\n`;
	text += `• \`!mu-perfil\` (aliases: \`!mu-p\`, \`!mu-eu\`) — Exibe seu perfil de jogador, estatísticas e favorita.\n`;
	text += `• \`!mu-ranking [top]\` (aliases: \`!mu-top\`, \`!mu-rank\`) — Ranking dos jogadores mais ricos em Zinthos.\n`;
	text += `• \`!mu-topgrupo\` (aliases: \`!mu-rankgrupo\`, \`!mu-topg\`) — Ranking de jogadores e waifus exclusivo do grupo atual.\n`;
	text += `• \`!mu-cooldowns\` (aliases: \`!mu-cd\`, \`!mu-tempo\`) — Consulta o tempo restante dos seus cooldowns.\n\n`;

	text += `🌟 *Wishlist e Catálogo:*\n`;
	text += `• \`!mu-wishlist\` (aliases: \`!mu-wl\`, \`!mu-desejos\`) — Lista seus personagens desejados (até ${WISHLIST_MAX_ITEMS}).\n`;
	text += `• \`!mu-desejar <id>\` (aliases: \`!mu-wish\`, \`!mu-add\`) — Adiciona um personagem à sua wishlist (+50% no drop).\n`;
	text += `• \`!mu-cobiçar <id>\` (aliases: \`!mu-cobicar\`, \`!mucobicar\`) — Cobiça uma waifu já casada de outro jogador (adiciona à wishlist e avisa o dono no roll).\n`;
	text += `• \`!mu-removerdesejo <id>\` (aliases: \`!mu-rmwish\`) — Remove um personagem da wishlist.\n`;
	text += `• \`!mu-wishlist-limpar\` (aliases: \`!mu-wllimpar\`, \`!mu-limparwishlist\`) — Remove todas as waifus já casadas da sua wishlist.\n`;
	text += `• \`!mu-like <id>\` (aliases: \`!mu-l\`, \`!mu-coracao\`) — Dá like em um personagem.\n`;
	text += `• \`!mu-personagens <busca>\` (aliases: \`!mu-chars\`, \`!mu-buscar\`) — Pesquisa personagens no catálogo por nome/série.\n`;
	text += `• \`!mu-char <busca>\` (aliases: \`!mu-info\`, \`!mu-winfo\`) — Exibe foto, raridade e detalhes de um personagem (busca ampla por nome, série, descrição ou ID).\n`;
	text += `• \`!mu-topchars\` (aliases: \`!mu-topwaifus\`, \`!mu-populares\`) — Mostra os personagens mais casados e curtidos no jogo.\n`;
	text += `• \`!mu-adm\` (alias: \`!mu-admin\`) — Envia no privado seu link para o painel web (divórcios, wishlist, classificados e fotos).\n`;
	text += `• \`!waifinder\` (aliases: \`!mu-waifinder\`, \`!mu-tinder\`) — Envia no privado seu link de acesso ao Waifinder estilo "Tinder" (cards, swipes, likes e wishlist).\n`;
	text += `• \`!mu-share\` (alias: \`!mu-compartilhar\`) — Exibe o link público do seu harém para compartilhar com amigos.\n\n`;

	text += `📈 *Investimentos & Mercado de Waifus:*\n`;
	text += `• \`!mu-investir <id/nome> [cotas]\` (aliases: \`!mu-lance\`, \`!mu-cota\`) — Adquire cotas de 25% de uma waifu livre. Cada cota dá super bônus no roll (+300%, 10x, 25x) e *casamento instantâneo sem cooldown*! Com 4 cotas (100%), adquire a waifu na hora!\n`;
	text += `• \`!mu-investimentos\` (aliases: \`!mu-cotas\`, \`!mu-meus-investimentos\`) — Lista suas waifus investidas, porcentagem acumulada e bônus ativos.\n`;
	text += `• \`!mu-cotacao <id/nome>\` (aliases: \`!mu-preco\`, \`!mu-valor\`) — Consulta o valor de compra integral e da cota de 25%, detalhando inflação e escassez.\n`;
	text += `• \`!mu-mercado\` (alias: \`!mu-economia\`) — Panorama macroeconômico do servidor, tabela de preços por raridade e negociações dos últimos 30 dias.\n\n`;

	text += `🏷️ *Classificados & Trocas P2P:*\n`;
	text += `• \`!mu-vender <id> <o que procura>\` (alias: \`!mu-anunciar\`) — Anuncia uma waifu do seu harém nos classificados globais.\n`;
	text += `• \`!mu-classificados\` — Lista as waifus disponíveis nos classificados globais.\n`;
	text += `• \`!mu-ofertas\` — Lista ofertas pendentes enviadas por outros jogadores para suas waifus.\n`;
	text += `• \`!mu-of-aceitar <id>\` — Aceita uma proposta de troca (transfere waifus, itens ou zinthos).\n`;
	text += `• \`!mu-of-negar <id>\` — Nega uma proposta de troca recebida.\n\n`;

	text += `⚙️ *Configurações do Grupo:*\n`;
	text += `• \`!mu-roll-marcar\` (alias: \`!mu-rollmarcar\`) — Alterna a marcação (@) de membros do grupo quando um personagem da wishlist for rolado (Apenas Admins).\n\n`;

	text += `ℹ️ *Ajuda do Jogo:*\n`;
	text += `• \`!waifus\` ou \`!mudae\` — Abre este menu explicativo com regras e comandos.`;

	return new ReturnMessage({
		chatId,
		content: text,
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		}
	});
}

/**
 * Garante que a URL gerada utilize o domínio web público configurado
 * @param {string} rawUrl
 * @param {string} path
 * @returns {string}
 */
function formatWebUrl(rawUrl, path) {
	if (rawUrl) {
		try {
			const u = new URL(rawUrl);
			if (
				u.hostname === "localhost" ||
				u.hostname === "127.0.0.1" ||
				u.hostname === "host.docker.internal"
			) {
				if (WAIFULETES_WEB_URL) {
					const base = new URL(WAIFULETES_WEB_URL);
					u.protocol = base.protocol;
					u.host = base.host;
					return u.toString();
				}
			}
			return rawUrl;
		} catch {
			// Fallback para montagem direta
		}
	}
	const cleanPath = path ? (path.startsWith("/") ? path : `/${path}`) : "";
	return WAIFULETES_WEB_URL ? `${WAIFULETES_WEB_URL}${cleanPath}` : cleanPath;
}

/**
 * Gera um link temporário (30 minutos) e envia no PV do usuário para gerenciar seu harém/wishlist na web
 * @param {object} bot
 * @param {object} message
 * @returns {Promise<ReturnMessage>}
 */
async function painelWebAdmin(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const groupId = getGroupId(message);
	const userName = await getUserName(message);

	try {
		await ensureUser(userId, groupId, userName);

		// Captura snapshot de inventário (pesca e fazenda) para o painel web
		const inventorySnapshot = { fishes: [], buffs: [], farmItems: [] };
		try {
			const cleanUser = normalizeUserId(userId);
			const pscData = await FishingGame.getUserData(cleanUser);
			if (pscData) {
				inventorySnapshot.fishes = (pscData.fishes || []).map((f) => ({
					id: f.dbId ?? f.id,
					name: f.name,
					weight: f.weight,
					isRare: Boolean(f.is_rare || f.isRare)
				}));
				inventorySnapshot.buffs = (pscData.buffs || []).map((b) => {
					const bType = b.type || b.effect_type;
					const buffMap = {
						bait_on_trash: "Evita perder a isca ao pescar lixo",
						rare_chance_boost: "Aumenta chance de peixe raro",
						double_catch: "Pesca 2 peixes em 1 tentativa",
						cooldown_reduction: "Reduz o tempo de espera",
						guaranteed_weight: "Garante peso extra aos peixes",
						inventory_slot: "Aumenta capacidade do inventário",
						next_fish_bonus: "Bônus de peso no próximo peixe",
						longer_cooldown: "Aumenta o tempo de espera",
						remove_baits: "Perde iscas"
					};
					const bDesc = buffMap[bType] || "Buff permanente de pesca";
					const uses = b.remainingUses ?? b.remaining_uses;
					const descWithUses = uses ? `${bDesc} (${uses} uso${uses === 1 ? "" : "s"})` : bDesc;
					return {
						id: b.dbId ?? b.id,
						originalName: b.originalName || b.original_name || bType || "Buff",
						type: bType,
						description: descWithUses,
						remainingUses: uses,
						value: b.value
					};
				});
			}

			const gardenInv = await jardimClient.getInventory(cleanUser).catch(() => null);
			if (gardenInv && Array.isArray(gardenInv.items)) {
				inventorySnapshot.farmItems = gardenInv.items.map((it) => ({
					itemId: it.itemId,
					name: it.name,
					quantity: it.quantity,
					type: it.type
				}));
			}
		} catch (invErr) {
			logger.warn("Falha ao capturar inventário para o painel web:", invErr.message);
		}

		const { data } = await api.post("/user/session", {
			userId,
			inventory: inventorySnapshot
		});
		const session = data?.data || {};

		const publicId = session.publicId;
		const token = session.token;
		const sessionUrl = formatWebUrl(
			session.url,
			publicId && token ? `/user/${publicId}?token=${token}` : ""
		);

		let pvText = `✨ *Painel Pessoal — Waifuletes* ✨\n\n`;
		pvText += `Olá, *${userName}*! Aqui está o seu link de acesso temporário:\n`;
		pvText += `🔗 ${sessionUrl}\n\n`;
		pvText += `⏳ *Duração:* Este link expira em *30 minutos*.\n`;
		pvText += `🔒 *Acesso Privado:* Não repasse este link para ninguém! Através dele você pode:\n`;
		pvText += `• Visualizar e divorciar personagens do seu harém\n`;
		pvText += `• Gerenciar sua Wishlist\n`;
		pvText += `• Pesquisar personagens no catálogo\n`;
		pvText += `• Acessar os Classificados Globais para negociar waifus, fazer ofertas e vender\n`;
		pvText += `• Sugerir novas fotos (com recorte interativo) e novas raridades\n`;

		// Se a mensagem veio de um grupo, envia no privado e apenas reage com emoji no grupo
		if (message.group && message.group !== message.author) {
			const pvMsg = new ReturnMessage({
				chatId: message.author,
				content: pvText
			});

			if (bot && typeof bot.sendReturnMessages === "function") {
				await bot.sendReturnMessages(pvMsg);
			} else if (bot && typeof bot.sendMessage === "function") {
				await bot.sendMessage(message.author, pvText);
			}

			if (message.origin && typeof message.origin.react === "function") {
				try {
					await Promise.resolve(message.origin.react("🔗")).catch(() => {});
				} catch (_) {}
			}

			return null;
		}

		// Se já foi executado no privado, responde diretamente no PV
		return new ReturnMessage({
			chatId: message.author,
			content: pvText
		});
	} catch (err) {
		return handleApiError(
			err,
			chatId,
			"❌ Não foi possível gerar o link do painel pessoal no momento. Tente novamente mais tarde."
		);
	}
}

/**
 * Gera e envia no PV do usuário o link de acesso ao Waifinder (modo catálogo estilo Tinder)
 * @param {object} bot
 * @param {object} message
 * @returns {Promise<ReturnMessage>}
 */
async function waifinderWeb(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const groupId = getGroupId(message);
	const userName = await getUserName(message);

	try {
		await ensureUser(userId, groupId, userName);

		const { data } = await api.post("/user/session", {
			userId
		});
		const session = data?.data || {};
		const token = session.token;
		const waifinderUrl = formatWebUrl(
			session.waifinderUrl,
			token ? `/catalogo?token=${token}` : "/catalogo"
		);

		let pvText = `✨ *Waifinder — Descoberta de Waifus* ✨\n\n`;
		pvText += `Olá, *${userName}*! Aqui está o seu link de acesso:\n`;
		pvText += `🔗 ${waifinderUrl}\n\n`;
		pvText += `🔥 *Como navegar no Waifinder:*\n`;
		pvText += `• *Arrastar p/ Direita* (ou tecla *D* / *→*): Curtir ❤️\n`;
		pvText += `• *Arrastar p/ Esquerda* (ou tecla *A* / *←*): Passar ✖\n`;
		pvText += `• *Botão + Wishlist* (ou tecla *W*): Salva na Wishlist ⭐\n`;
		pvText += `• *Botão Gênero* (ou tecla *G* / *S*): Alterna Waifus ♀ / Husbandos ♂ / Todos ⚧\n`;

		// Se a mensagem veio de um grupo, envia no privado e apenas reage com emoji no grupo
		if (message.group && message.group !== message.author) {
			const pvMsg = new ReturnMessage({
				chatId: message.author,
				content: pvText
			});

			if (bot && typeof bot.sendReturnMessages === "function") {
				await bot.sendReturnMessages(pvMsg);
			} else if (bot && typeof bot.sendMessage === "function") {
				await bot.sendMessage(message.author, pvText);
			}

			if (message.origin && typeof message.origin.react === "function") {
				try {
					await Promise.resolve(message.origin.react("🔥")).catch(() => {});
				} catch (_) {}
			}

			return null;
		}

		// Se já foi executado no privado, responde diretamente no PV
		return new ReturnMessage({
			chatId: message.author,
			content: pvText
		});
	} catch (err) {
		return handleApiError(
			err,
			chatId,
			"❌ Não foi possível gerar o link do Waifinder no momento. Tente novamente mais tarde."
		);
	}
}

/**
 * Exibe o link público do harém do usuário para que ele compartilhe com amigos
 * @param {object} bot
 * @param {object} message
 * @returns {Promise<ReturnMessage>}
 */
async function compartilharHarem(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const groupId = getGroupId(message);
	const userName = await getUserName(message);

	try {
		await ensureUser(userId, groupId, userName);
		const { data } = await api.get(`/user/${userId}`);
		const user = data?.data || {};

		const publicId = user.publicId;
		const publicUrl = formatWebUrl(user.publicUrl, publicId ? `/user/${publicId}` : "");

		const haremCount = user.haremCount ?? user._count?.harem ?? 0;
		let soulmateCount = user.soulmateCount ?? user._count?.soulmates ?? 0;
		const wishlistCount = user.wishlistCount ?? user._count?.wishlist ?? 0;

		let mythicChars = Array.isArray(user.mythicCharacters) ? user.mythicCharacters : [];
		let mythicCount = user.mythicCount ?? mythicChars.length;

		// Fallback resiliente: se a API ainda não retornar míticos ou soulmateCount for 0,
		// busca no harém e soulmates para garantir integridade imediata
		if (mythicChars.length === 0 || soulmateCount === 0) {
			try {
				const [haremRes, smRes] = await Promise.all([
					api
						.get(`/harem/${userId}`, {
							params: { page: 1, limit: 100, sort: "keys" }
						})
						.catch(() => null),
					soulmateCount === 0
						? api.get(`/soulmates/${userId}`).catch(() => null)
						: Promise.resolve(null)
				]);

				const entries = haremRes?.data?.data?.data || [];
				if (mythicChars.length === 0 && entries.length > 0) {
					const foundMythics = entries
						.filter(
							(e) =>
								e.character?.isMythic ||
								String(e.character?.rarity || "").toUpperCase() === "MYTHIC"
						)
						.map((e) => e.character);
					if (foundMythics.length > 0) {
						mythicChars = foundMythics;
						mythicCount = mythicChars.length;
					}
				}

				if (soulmateCount === 0) {
					const highKeyCount = entries.filter(
						(e) => (e.keys >= 10 || e.isSoulmate) && !e.character?.isMythic
					).length;
					const smApiCount = smRes?.data?.data?.length || 0;
					soulmateCount = Math.max(highKeyCount, smApiCount);
				}
			} catch (_) {
				// Mantém os valores já obtidos de user
			}
		}

		// Favoritas (excluindo míticos da lista de favoritas para não duplicar exibição)
		const rawFavoriteChars =
			user.favoriteCharacters ||
			(user.harem
				? user.harem.filter((h) => h.isFavorite).map((h) => h.character)
				: user.favoriteCharacter
					? [user.favoriteCharacter]
					: []);

		const mythicIds = new Set(mythicChars.map((m) => m.id));
		const favoriteChars = rawFavoriteChars.filter((f) => !mythicIds.has(f.id));

		let text = `✨ *Harém de ${user.name || userName} — Waifuletes* ✨\n\n`;
		text += `Acesse a vitrine pública de personagens no catálogo web:\n`;
		text += `🔗 ${publicUrl}\n\n`;
		text += `👰 *Colecionados:* ${haremCount} waifus/husbandos\n`;
		text += `🔮 *Míticos:* ${mythicCount}\n`;
		text += `💖 *Soulmates:* ${soulmateCount}\n`;
		text += `🌟 *Wishlist:* ${wishlistCount}/${WISHLIST_MAX_ITEMS}\n`;

		if (mythicChars.length > 0) {
			text += `\n🔮 *Personagens Míticos (${mythicChars.length}):*\n`;
			mythicChars.forEach((m, idx) => {
				const numStr = String(idx + 1).padStart(2, "0");
				text += `  ${numStr}. 🔮 *${m.name}* (${m.series || "Sem série"})\n`;
			});
		}

		if (favoriteChars.length > 0) {
			text += `\n💖 *Favoritas em Destaque (${favoriteChars.length}/5):*\n`;
			favoriteChars.forEach((f, idx) => {
				const numStr = String(idx + 1).padStart(2, "0");
				text += `  ${numStr}. *${f.name}* (${f.series || "Sem série"})\n`;
			});
		}

		text += `\n💡 _Compartilhe este link com amigos para exibir sua coleção!_`;

		return new ReturnMessage({
			chatId,
			content: text
		});
	} catch (err) {
		return handleApiError(
			err,
			chatId,
			"❌ Não foi possível obter o link do seu harém público no momento."
		);
	}
}

/**
 * Anuncia uma waifu nos classificados globais via comando WhatsApp
 * !mu-vender <id-personagem> <mensagem do interesse da troca>
 */
async function venderWaifuCmd(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const groupId = getGroupId(message);
	const userName = await getUserName(message);

	if (!args || args.length < 2) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Uso: `!mu-vender <id-personagem> <o que você busca em troca>`\nExemplo: `!mu-vender makima Aceito waifus de Chainsaw Man, peixes raros ou itens de fazenda`\nAlias: `!mu-anunciar`"
		});
	}

	const characterId = args[0].toLowerCase();
	const interest = args.slice(1).join(" ");

	try {
		await ensureUser(userId, groupId, userName);
		const { data } = await api.post("/market/listing", {
			userId,
			characterId,
			interest
		});

		const char = data.data?.character;
		const charName = char?.name || characterId;
		return new ReturnMessage({
			chatId,
			content:
				`📢 *Personagem Anunciado nos Classificados!* ✨\n\n` +
				`👤 *Personagem:* ${charName}\n` +
				`💬 *Interesse de troca:* _${interest}_\n\n` +
				`Outros jogadores agora podem enviar propostas para você. Acompanhe pelo painel no \`!mu-adm\` ou use \`!mu-ofertas\`!`
		});
	} catch (err) {
		const msg =
			err?.response?.data?.error?.message ||
			err?.response?.data?.message ||
			err?.message ||
			"Erro ao anunciar personagem.";
		return new ReturnMessage({ chatId, content: `❌ ${msg}` });
	}
}

/**
 * Lista as waifus nos classificados globais por ordem de raridade/wishlist/popularidade
 * !mu-classificados
 */
async function listarClassificadosCmd(bot, message, args) {
	const chatId = message.group ?? message.author;

	try {
		const { data } = await api.get("/market/listings?sortBy=rarity&limit=10");
		const listings = data?.data?.listings || [];

		if (listings.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"🛒 *Classificados de Waifus & Husbandos*\n\nNenhum personagem anunciado no momento. Seja o primeiro usando `!mu-vender <id> <interesse>`!"
			});
		}

		let text = "🛒 *Classificados Globais de Waifus & Husbandos*\n\n";
		listings.forEach((l, idx) => {
			const char = l.character;
			const normRarity = String(char.baseRarity || "COMMON").toUpperCase();
			const emojiRarity = RARITY_EMOJI[normRarity] || "⚪";
			const seller = l.user?.name || "Vendedor";

			text += `*#${idx + 1}* ${emojiRarity} *${char.name}* — _${char.series || "Sem série"}_\n`;
			text += `👤 *Vendedor:* ${seller}\n`;
			text += `🔍 *Busca:* _${l.interest}_\n`;
			text += `🆔 ID do Anúncio: \`${l.id}\`\n\n`;
		});

		text += `_Se tiver interesse em alguma, visite a aba "Classificados" no !mu-adm_`;

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		const msg =
			err?.response?.data?.error?.message ||
			err?.response?.data?.message ||
			err?.message ||
			"Erro ao consultar classificados.";
		return new ReturnMessage({ chatId, content: `❌ ${msg}` });
	}
}

/**
 * Lista as ofertas pendentes recebidas pelo vendedor
 * !mu-ofertas
 */
async function listarOfertasRecebidasCmd(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const { data } = await api.get(`/market/offers?userId=${encodeURIComponent(userId)}`);
		const offers = data?.data || [];

		if (offers.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"📬 *Ofertas Recebidas*\n\nVocê não possui nenhuma oferta pendente nos seus classificados no momento."
			});
		}

		let text = `📬 *Ofertas Pendentes nos seus Classificados (${offers.length}):*\n\n`;
		offers.forEach((o, idx) => {
			const char = o.listing?.character?.name || "Personagem";
			const buyer = o.buyer?.name || "Jogador";
			const offered = o.offeredItems || {};

			let itemsDesc = "";
			if (offered.isFree) {
				itemsDesc = "🎁 Pediu de graça (Doação)";
			} else {
				const parts = [];
				if (Array.isArray(offered.waifuIds) && offered.waifuIds.length > 0)
					parts.push(`${offered.waifuIds.length} waifu(s)`);
				if (Array.isArray(offered.fishes) && offered.fishes.length > 0)
					parts.push(`${offered.fishes.length} peixe(s)`);
				if (Array.isArray(offered.fishingBuffs) && offered.fishingBuffs.length > 0)
					parts.push(`${offered.fishingBuffs.length} buff(s)`);
				if (Array.isArray(offered.farmItems) && offered.farmItems.length > 0) {
					const totalFarmQty = offered.farmItems.reduce(
						(acc, it) => acc + (Number(it.amount) || 1),
						0
					);
					parts.push(`${totalFarmQty} item(ns) de fazenda`);
				}
				if (offered.zinthos && Number(offered.zinthos) > 0)
					parts.push(`🪙 ${Number(offered.zinthos).toLocaleString("pt-BR")} Zinthos`);
				itemsDesc = parts.join(", ") || "Nenhum item";
			}

			text += `*#${idx + 1}* [ID: \`${o.id}\`]\n`;
			text += `🎯 *Para sua:* ${char}\n`;
			text += `👤 *De:* ${buyer}\n`;
			text += `📦 *Oferece:* ${itemsDesc}\n`;
			if (o.message) text += `💬 *Msg:* _"${o.message}"_\n`;
			text += `\n`;
		});

		text += `Para aceitar: \`!mu-of-aceitar <ID>\`\n`;
		text += `Para negar: \`!mu-of-negar <ID>\``;

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		const msg =
			err?.response?.data?.error?.message ||
			err?.response?.data?.message ||
			err?.message ||
			"Erro ao buscar ofertas.";
		return new ReturnMessage({ chatId, content: `❌ ${msg}` });
	}
}

/**
 * Aceita uma oferta via comando bot
 * !mu-of-aceitar <id>
 */
async function aceitarOfertaCmd(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args || !args[0]) {
		return new ReturnMessage({
			chatId,
			content: "❌ Uso: `!mu-of-aceitar <ID-da-oferta>`\nConsulte os IDs com `!mu-ofertas`."
		});
	}

	const offerId = args[0].trim();

	try {
		const { data } = await api.post(`/market/offers/${encodeURIComponent(offerId)}/accept`, {
			userId
		});
		if (data.success) {
			return new ReturnMessage({
				chatId,
				content: `🎉 *Oferta Aceita com Sucesso!*\n\n${data.message || "Os personagens e itens foram trocados e transferidos."}`
			});
		} else {
			return new ReturnMessage({
				chatId,
				content: `⚠️ ${data.reason || "Não foi possível aceitar a oferta."}`
			});
		}
	} catch (err) {
		const msg =
			err?.response?.data?.reason ||
			err?.response?.data?.error?.message ||
			err?.message ||
			"Erro ao aceitar oferta.";
		return new ReturnMessage({ chatId, content: `❌ ${msg}` });
	}
}

/**
 * Nega uma oferta via comando bot
 * !mu-of-negar <id>
 */
async function negarOfertaCmd(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args || !args[0]) {
		return new ReturnMessage({
			chatId,
			content: "❌ Uso: `!mu-of-negar <ID-da-oferta>`\nConsulte os IDs com `!mu-ofertas`."
		});
	}

	const offerId = args[0].trim();

	try {
		await api.post(`/market/offers/${encodeURIComponent(offerId)}/reject`, { userId });
		return new ReturnMessage({
			chatId,
			content: "👎 *Oferta Negada com Sucesso.*\nO proponente foi notificado."
		});
	} catch (err) {
		const msg =
			err?.response?.data?.error?.message ||
			err?.response?.data?.message ||
			err?.message ||
			"Erro ao negar oferta.";
		return new ReturnMessage({ chatId, content: `❌ ${msg}` });
	}
}

/**
 * Cobiça um personagem já casado de outro jogador
 * !mu-cobiçar <id-personagem ou busca>
 * Aliases: !mu-cobicar, !mucobicar, !mucobiçar
 */
async function cobicarWaifuCmd(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args || args.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Uso: `!mu-cobiçar <id ou nome do personagem>`\nExemplo: `!mu-cobiçar makima`\n\n_Cobiçar adiciona o personagem à sua Wishlist e notifica o dono na próxima rolagem dele!_"
		});
	}

	const search = args.join(" ").trim();

	try {
		const { data } = await api.post("/covet", {
			userId,
			characterId: search
		});

		if (data?.success) {
			const char = data.data.character;
			const owner = data.data.owner;
			const ownerName = owner?.name ? ` de *${owner.name}*` : "";
			return new ReturnMessage({
				chatId,
				content: `👀 Você agora está cobiçando *${char.name}* (${char.series || "Sem série"})${ownerName}!\n\n🌟 O personagem foi adicionado à sua Wishlist e o dono será avisado na próxima rolagem.`
			});
		}

		return new ReturnMessage({
			chatId,
			content: "❌ Não foi possível registrar seu interesse."
		});
	} catch (err) {
		const errData = err?.response?.data?.error;
		const code = errData?.code;
		const msg = errData?.message || err?.message || "Erro ao cobiçar personagem.";

		if (code === "CANNOT_COVET_MYTHIC") {
			return new ReturnMessage({
				chatId,
				content:
					"🔮 Personagens Míticos pertencem eternamente ao seu criador e não podem ser cobiçados!"
			});
		}

		if (code === "NOT_MARRIED") {
			return new ReturnMessage({
				chatId,
				content: `ℹ️ ${msg}`
			});
		}

		if (code === "OWN_CHARACTER") {
			return new ReturnMessage({
				chatId,
				content: "❌ Você já é casado(a) com este personagem!"
			});
		}

		if (code === "WISHLIST_LIMIT_REACHED") {
			return new ReturnMessage({
				chatId,
				content: `❌ Sua Wishlist atingiu o limite máximo de ${WISHLIST_MAX_ITEMS} personagens! Remova algum antes de cobiçar novos.`
			});
		}

		return new ReturnMessage({
			chatId,
			content: `❌ ${msg}`
		});
	}
}

/**
 * Investe em cotas de 25% de uma waifu livre ou adquire definitivamente com 4 cotas
 * !mu-investir <personagem> [quantidade_cotas (1 a 4, padrão 1)]
 */
async function investirWaifuCmd(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const groupId = getGroupId(message);
	const name = await getUserName(message);

	if (!args || args.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Uso: `!mu-investir <nome/id da waifu> [quantidade de cotas (1 a 4)]`\nExemplos:\n• `!mu-investir makima` (compra 1 cota de 25%)\n• `!mu-investir makima 2` (compra 2 cotas)\n• `!mu-investir makima 4` (compra 100% à vista)\nAliases: `!mu-lance`, `!mu-cota`",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	let shares = 1;
	let charQuery = args.join(" ").trim();
	const lastArg = args.length > 1 ? args[args.length - 1].trim() : null;
	if (lastArg && /^[1-4]$/.test(lastArg)) {
		shares = parseInt(lastArg, 10);
		charQuery = args
			.slice(0, args.length - 1)
			.join(" ")
			.trim();
	}

	try {
		await ensureUser(userId, groupId, name);

		const { data } = await api.post("/market/invest", {
			userId,
			characterId: charQuery,
			shares,
			groupId
		});

		const res = data.data;
		const character = res.character;

		if (res.acquired) {
			// Casamento concluído com 4 cotas (100%) em waifu livre!
			const userMention = userId.includes("@") ? `@${userId.split("@")[0]}` : `@${userId}`;
			let text = `💍 *Parabéns, ${userMention}!* Você adquiriu as 4 cotas (100%) e se casou com *${character.name}*! 🎉\n`;
			text += `💎 Investimento total: *${res.cost.toLocaleString("pt-BR")} Zinthos*\n`;
			text += `🔑 Chaves: *1/10*\n`;
			text += `💜 Saldo atual: *${res.newBalance.toLocaleString("pt-BR")} Zinthos*`;
			if (res.refundedCompetitors && res.refundedCompetitors.length > 0) {
				text += `\n⚠️ *${res.refundedCompetitors.length} competidor(es)* que investiram nesta waifu receberam 50% de reembolso em Zinthos.`;
			}

			return await buildMarriageReturnMessage(bot, message, character, userId, name, text, {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin,
				mentions: [toJid(userId)]
			});
		}

		if (res.isMarried) {
			const userMention = userId.includes("@") ? `@${userId.split("@")[0]}` : `@${userId}`;
			if (res.keyEarned) {
				let text = `🔑 *CHAVE ADQUIRIDA COM COTAS!* 🔑\n\n`;
				text += `💍 Parabéns, ${userMention}! Você completou as 4 cotas da sua esposa *${character.name}* com 80% de desconto!\n`;
				text += `🔑 Total de Chaves: *${res.currentKeys}/10*\n`;
				text += `💰 Valor pago: *${res.cost.toLocaleString("pt-BR")} Zinthos*\n`;
				text += `💜 Saldo restante: *${res.newBalance.toLocaleString("pt-BR")} Zinthos*\n`;
				if (res.becameSoulmate) {
					text += `\n💖✨ *ALMA GÊMEA (SOULMATE) ALCANÇADA!* ✨💖\nSeu laço com *${character.name}* atingiu o ápice! Ela agora é um Soulmate e vale *3.000 pontos* no Ranking de Colecionadores! 👑`;
				} else {
					text += `\n💡 Faltam *${10 - res.currentKeys} chave(s)* para ela se tornar sua *💖 Soulmate*!`;
				}

				return new ReturnMessage({
					chatId,
					content: text,
					options: {
						quotedMessageId: message.origin?.id?._serialized,
						goReply: message.origin,
						mentions: [toJid(userId)]
					}
				});
			}

			// Cotas parciais em waifu já casada (1 a 3 cotas)
			const filledBlocks = "█".repeat(res.totalShares);
			const emptyBlocks = "░".repeat(res.remainingShares);
			const progressBar = `[${filledBlocks}${emptyBlocks}]`;

			let text = `📈 *INVESTIMENTO EM ESPOSA CONFIRMADO!* 📈\n\n`;
			text += `👤 *${character.name}* — _${character.series}_\n`;
			text += `💍 *Desconto de Casamento:* 80% OFF\n`;
			text += `🎫 Cotas adquiridas: *+${res.sharesBought} cota(s)*\n`;
			text += `📊 Progresso para a Chave ${res.currentKeys + 1}/10: ${progressBar} *${res.totalShares}/4 cotas*\n`;
			text += `💰 Valor pago: *${res.cost.toLocaleString("pt-BR")} Zinthos*\n`;
			text += `💜 Saldo restante: *${res.newBalance.toLocaleString("pt-BR")} Zinthos*\n\n`;
			text += `💡 Faltam *${res.remainingShares} cota(s)* para desbloquear a chave *${res.currentKeys + 1}/10*!`;

			return new ReturnMessage({
				chatId,
				content: text,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin,
					mentions: [toJid(userId)]
				}
			});
		}

		// Cotas parciais adquiridas em waifu livre (1 a 3 cotas)
		const userMention = userId.includes("@") ? `@${userId.split("@")[0]}` : `@${userId}`;
		const emoji = RARITY_EMOJI[character.baseRarity] || "⚪";
		const label = RARITY_LABEL[character.baseRarity] || character.baseRarity;
		const filledBlocks = "█".repeat(res.totalShares);
		const emptyBlocks = "░".repeat(res.remainingShares);
		const progressBar = `[${filledBlocks}${emptyBlocks}]`;

		let text = `📈 *INVESTIMENTO CONFIRMADO!* 📈\n\n`;
		text += `👤 *${character.name}* — _${character.series}_\n`;
		text += `${emoji} Raridade: *${label}*\n`;
		text += `🎫 Cotas adquiridas: *+${res.sharesBought} cota(s)*\n`;
		text += `📊 Progresso: ${progressBar} *${res.totalShares}/4 cotas* (*${res.totalShares * 25}%*)\n`;
		text += `💰 Valor pago: *${res.cost.toLocaleString("pt-BR")} Zinthos*\n`;
		text += `💜 Saldo restante: *${res.newBalance.toLocaleString("pt-BR")} Zinthos*\n\n`;
		text += `🎯 *Super Bônus Ativo:*\n`;
		text += `• Drop pessoal no \`!mu-roll\`: *+${res.boostPercent}%* de chance!\n`;
		text += `• ⚡ *Casamento Instantâneo:* Se ela sair no seu \`!mu-roll\`, o casamento ocorre na hora, *sem consumir cooldown*!\n\n`;
		text += `💡 Faltam *${res.remainingShares} cota(s)* para a aquisição definitiva automática!`;

		return new ReturnMessage({
			chatId,
			content: text,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin,
				mentions: [toJid(userId)]
			}
		});
	} catch (err) {
		if (err.response?.data?.error?.code === "ALREADY_SOULMATE") {
			return new ReturnMessage({
				chatId,
				content: `💖 *${charQuery}* já é sua Alma Gêmea (Soulmate)! O vínculo está no nível máximo e não é possível adquirir mais cotas.`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}
		return handleApiError(err, chatId, "Erro ao investir no personagem.", {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		});
	}
}

/**
 * Lista todos os investimentos ativos do usuário
 * !mu-investimentos (aliases: !mu-cotas, !mu-meus-investimentos)
 */
async function listarInvestimentosCmd(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	try {
		const { data } = await api.get("/market/investments", { params: { userId } });
		const investments = data?.data || [];

		if (investments.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"💼 Você ainda não possui nenhum investimento ativo em waifus.\n\n💡 Use `!mu-cotacao <personagem>` para consultar o preço de mercado e `!mu-investir <personagem>` para adquirir cotas de 25%!",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		let text = `💼 *SEUS INVESTIMENTOS EM WAIFUS* (${investments.length}) 💼\n\n`;
		let totalZinthosInvestedAll = 0;

		investments.forEach((inv, index) => {
			totalZinthosInvestedAll += inv.totalZinthosInvested;
			const emoji = RARITY_EMOJI[inv.character.baseRarity] || "⚪";
			const label = RARITY_LABEL[inv.character.baseRarity] || inv.character.baseRarity;
			const filledBlocks = "█".repeat(inv.shares);
			const emptyBlocks = "░".repeat(inv.remainingShares);
			const progressBar = `[${filledBlocks}${emptyBlocks}]`;

			text += `${index + 1}️⃣ ${emoji} *${inv.character.name}* — _${inv.character.series}_\n`;
			text += `   📊 Cotas: ${progressBar} *${inv.shares}/4* (${inv.percent}%)\n`;
			text += `   💎 Zinthos investidos: *${inv.totalZinthosInvested.toLocaleString("pt-BR")} Z*\n`;
			if (inv.isMarried) {
				text += `   💍 *Casada (80% OFF)* • Chaves: ${inv.currentKeys}/10\n`;
				text += `   💰 Próxima cota (+25% chave): *${inv.cotaPriceCurrent.toLocaleString("pt-BR")} Z*\n\n`;
			} else {
				text += `   🎯 Bônus de Drop: *+${inv.boostPercent}%* (⚡ Casa instantâneo no roll!)\n`;
				text += `   💰 Próxima cota: *${inv.cotaPriceCurrent.toLocaleString("pt-BR")} Z*\n\n`;
			}
		});

		text += `💰 *Total investido em carteira:* ${totalZinthosInvestedAll.toLocaleString("pt-BR")} Zinthos\n`;
		text += `💡 _Use \`!mu-investir <nome>\` para adquirir a próxima cota de qualquer uma delas!_`;

		return new ReturnMessage({
			chatId,
			content: text,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao listar investimentos.", {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		});
	}
}

/**
 * Consulta a cotação dinâmica de compra e cotas de um personagem
 * !mu-cotacao <personagem> (aliases: !mu-preco, !mu-valor)
 */
async function cotarWaifuCmd(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	if (!args || args.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Uso: `!mu-cotacao <nome ou id do personagem>`\nExemplo: `!mu-cotacao makima`\nAliases: `!mu-preco`, `!mu-valor`",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	const charQuery = args.join(" ").trim();

	try {
		const { data } = await api.get(`/market/quote/${encodeURIComponent(charQuery)}`, {
			params: { userId }
		});
		const quote = data?.data;
		if (!quote) throw new Error("Cotação não disponível");

		const char = quote.character;
		const pricing = quote.pricing;
		const emoji = RARITY_EMOJI[char.baseRarity] || "⚪";
		const label = RARITY_LABEL[char.baseRarity] || char.baseRarity;

		let text = `📊 *COTAÇÃO DE MERCADO* — Waifuletes\n\n`;
		text += `👤 *${char.name}* — _${char.series}_\n`;
		text += `${emoji} Raridade: *${label}*\n`;
		if (char.isSoulmate) {
			text += `💖 *Status:* Sua Alma Gêmea (Soulmate)! (Vínculo Máximo - Cotas Encerradas)\n\n`;
		} else if (char.isOwner) {
			text += `💍 *Status:* Casada com você! (Chaves: ${char.currentKeys}/10)\n`;
			text += `🎁 *Desconto de Cônjuge:* 80% OFF ativo nas cotas!\n\n`;
		} else if (char.isClaimed) {
			text += `🔒 *Status:* Já casada com *${char.owner?.name || "Outro jogador"}*\n\n`;
		} else {
			text += `💍 *Status:* LIVRE para compra e investimento!\n\n`;
		}

		text += `💰 *Preço Integral (100%):* ${pricing.dynamicPrice.toLocaleString("pt-BR")} Zinthos\n`;
		if (pricing.discountPercent) {
			text += `🎫 *Valor por Cota (25%):* ${pricing.cotaPrice.toLocaleString("pt-BR")} Zinthos *(80% OFF!)*\n\n`;
		} else {
			text += `🎫 *Valor por Cota (25%):* ${pricing.cotaPrice.toLocaleString("pt-BR")} Zinthos\n\n`;
		}

		text += `📈 *Indicadores Econômicos:*\n`;
		text += `• Base da Raridade: *${pricing.basePrice.toLocaleString("pt-BR")} Z* (${pricing.days} dias de Zinthos)\n`;
		text += `• Inflação Monetária (M2): *+${pricing.inflationPercent}%*\n`;
		const scarcityPct = Number(((pricing.scarcityMultiplier - 1) * 100).toFixed(1));
		text += `• Escassez da Categoria: *+${scarcityPct}%* (${quote.rarityStats.claimed.toLocaleString("pt-BR")}/${quote.rarityStats.total.toLocaleString("pt-BR")} casados)\n\n`;

		if (quote.investments && quote.investments.length > 0) {
			text += `⚖️ *Disputa em Aberto:*\n`;
			quote.investments.forEach((inv) => {
				text += `• *${inv.userName}:* ${inv.shares}/4 cotas (${inv.percent}%)\n`;
			});
			text += `\n`;
		}

		if (char.isSoulmate) {
			text += `👑 _Vínculo Soulmate atingido (3.000 pts no Ranking). Não são necessárias novas cotas._`;
		} else if (char.isOwner) {
			text += `💡 _Use \`!mu-investir ${char.id}\` para comprar 1 cota (+25% chave) com 80% OFF_\n`;
			text += `💡 _Use \`!mu-investir ${char.id} 4\` para comprar 4 cotas e liberar +1 Chave!_`;
		} else if (!char.isClaimed) {
			text += `💡 _Use \`!mu-investir ${char.id}\` para comprar 1 cota de 25%_\n`;
			text += `💡 _Use \`!mu-investir ${char.id} 4\` para comprar 100% à vista_`;
		}

		const imageBase64 = await downloadImageAsBase64(char.imageUrl);
		if (imageBase64) {
			return new ReturnMessage({
				chatId,
				content: {
					mimetype: "image/jpeg",
					data: imageBase64,
					filename: "quote.jpg",
					isMessageMedia: true
				},
				options: {
					caption: text,
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		return new ReturnMessage({
			chatId,
			content: text,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao obter cotação do personagem.", {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		});
	}
}

/**
 * Panorama macroeconômico global e estatísticas dos últimos 30 dias de anúncios
 * !mu-mercado (alias: !mu-economia)
 */
async function mercadoInfoCmd(bot, message) {
	const chatId = message.group ?? message.author;

	try {
		const { data } = await api.get("/market/stats");
		const stats = data?.data;
		if (!stats) throw new Error("Estatísticas não disponíveis");

		let text = `🏛️ *MERCADO & ECONOMIA GLOBAL* — Waifuletes\n\n`;
		text += `💰 *Massa Monetária em Circulação (M2):* ${stats.circulatingKakera.toLocaleString("pt-BR")} Zinthos\n`;
		text += `📈 *Taxa de Inflação Atual:* +${stats.inflationPercent}% (Base: ${stats.baseMoneySupply.toLocaleString("pt-BR")} Z)\n\n`;

		text += `🏷️ *Negociações nos Últimos 30 Dias (Anúncios):*\n`;
		text += `• Waifus transferidas: *${stats.thirtyDaysStats.tradedWaifus} waifus*\n`;
		text += `• Volume transacionado: *${stats.thirtyDaysStats.tradedZinthos.toLocaleString("pt-BR")} Zinthos*\n`;
		text += `• Propostas aceitas: *${stats.thirtyDaysStats.acceptedOffersCount} negociações*\n\n`;

		text += `📊 *Tabela de Cotação por Raridade:*\n`;
		const rList = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"];
		rList.forEach((r) => {
			const info = stats.rarityStats[r];
			const emoji = RARITY_EMOJI[r] || "⚪";
			const label = RARITY_LABEL[r] || r;
			text += `${emoji} *${label} (${info.days}d):*\n`;
			text += `   • 100%: *${info.dynamicPrice.toLocaleString("pt-BR")} Z* | Cota (25%): *${info.cotaPrice.toLocaleString("pt-BR")} Z*\n`;
			text += `   • Estoque: ${info.available.toLocaleString("pt-BR")} livres (${info.percentageClaimed}% casados)\n`;
		});

		text += `\n💡 _Use \`!mu-cotacao <personagem>\` para ver a cotação de qualquer waifu._\n`;
		text += `💡 _Use \`!mu-investir <personagem>\` para investir em cotas de 25%._`;

		return new ReturnMessage({
			chatId,
			content: text,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao carregar dados do mercado.", {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		});
	}
}

/**
 * Instrução sobre criação e forja de Personagens Míticos
 */
async function infoCriacaoMitico(bot, message) {
	const chatId = message.group ?? message.author;
	return new ReturnMessage({
		chatId,
		content:
			"🔮 *Personagens Míticos são forjados exclusivamente pelo painel web! Acesse seu link via !mu-adm*",
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		}
	});
}

// ─── Registro dos Comandos e Aliases (Padrão Stickers.js) ───────────────────

const commands = [
	// ── MÍTICOS ─────────────────────────────────────────────────────────────
	new Command({
		name: "mu-mitico",
		aliases: ["mu-miticos", "mu-criar-mitico", "mu-forjar", "mu-forjarmitico", "mu-mythic"],
		description: "Instruções sobre como forjar personagens míticos exclusivos",
		category: "mudae",
		group: "muwaifu-mitico",
		reactions: { before: "🔮", after: "✅", error: "❌" },
		reply: true,
		method: infoCriacaoMitico
	}),
	// ── ROLL (Geral) ────────────────────────────────────────────────────────
	new Command({
		name: "mu-roll",
		description: "Sorteia um personagem aleatório (waifus e husbandos)",
		category: "mudae",
		group: "muwaifu-roll",
		cooldown: 1,
		reactions: { before: "🎲", after: "✅", error: "❌" },
		reply: true,
		method: rollAny
	}),
	new Command({
		name: "mu-r",
		description: "Alias curto para !mu-roll",
		category: "mudae",
		group: "muwaifu-roll",
		cooldown: 1,
		reactions: { before: "🎲", after: "✅", error: "❌" },
		reply: true,
		method: rollAny
	}),
	new Command({
		name: "mu-waifu",
		description: "Alias para !mu-roll",
		category: "mudae",
		group: "muwaifu-roll",
		cooldown: 1,
		reactions: { before: "🎲", after: "✅", error: "❌" },
		reply: true,
		method: rollAny
	}),
	new Command({
		name: "mu-w",
		description: "Alias curto para !mu-roll",
		category: "mudae",
		group: "muwaifu-roll",
		cooldown: 1,
		reactions: { before: "🎲", after: "✅", error: "❌" },
		reply: true,
		method: rollAny
	}),

	// ── ROLL MALE ───────────────────────────────────────────────────────────
	new Command({
		name: "mu-rollm",
		description: "Sorteia apenas personagens masculinos (husbandos)",
		category: "mudae",
		group: "muwaifu-rollm",
		cooldown: 1,
		reactions: { before: "🎲", after: "✅", error: "❌" },
		reply: true,
		method: rollMale
	}),
	new Command({
		name: "mu-rm",
		description: "Alias de !mu-rollm",
		category: "mudae",
		group: "muwaifu-rollm",
		cooldown: 1,
		reactions: { before: "🎲", after: "✅", error: "❌" },
		reply: true,
		method: rollMale
	}),
	new Command({
		name: "mu-husbando",
		description: "Alias de !mu-rollm",
		category: "mudae",
		group: "muwaifu-rollm",
		cooldown: 1,
		reactions: { before: "🎲", after: "✅", error: "❌" },
		reply: true,
		method: rollMale
	}),

	// ── ROLL FEMALE ─────────────────────────────────────────────────────────
	new Command({
		name: "mu-rollf",
		description: "Sorteia apenas personagens femininos (waifus)",
		category: "mudae",
		group: "muwaifu-rollf",
		cooldown: 1,
		reactions: { before: "🎲", after: "✅", error: "❌" },
		reply: true,
		method: rollFemale
	}),
	new Command({
		name: "mu-rf",
		description: "Alias de !mu-rollf",
		category: "mudae",
		group: "muwaifu-rollf",
		cooldown: 1,
		reactions: { before: "🎲", after: "✅", error: "❌" },
		reply: true,
		method: rollFemale
	}),

	// ── CASAR ───────────────────────────────────────────────────────────────
	new Command({
		name: "mu-casar",
		description: "Casa com o personagem sorteado recentemente (janela 300s)",
		category: "mudae",
		group: "muwaifu-casar",
		reactions: { trigger: "💍", before: "💍", after: "💍", error: "❌" },
		reply: true,
		method: casarWaifu
	}),
	new Command({
		name: "mu-claim",
		description: "Alias de !mu-casar",
		category: "mudae",
		group: "muwaifu-casar",
		reactions: { trigger: "💍", before: "💍", after: "💍", error: "❌" },
		reply: true,
		method: casarWaifu
	}),
	new Command({
		name: "mu-c",
		description: "Alias curto de !mu-casar",
		category: "mudae",
		group: "muwaifu-casar",
		reactions: { trigger: "💍", before: "💍", after: "💍", error: "❌" },
		reply: true,
		method: casarWaifu
	}),
	new Command({
		name: "mu-marry",
		description: "Alias em inglês de !mu-casar",
		category: "mudae",
		group: "muwaifu-casar",
		reactions: { trigger: "💍", before: "💍", after: "💍", error: "❌" },
		reply: true,
		method: casarWaifu
	}),
	new Command({
		name: "reactionWaifuHelper",
		description: "Invocado apenas pelo ReactionsHandler para casamentos por reação numérica",
		category: "mudae",
		reactions: {
			trigger: NUMBER_EMOJIS.concat(NUMBER_EMOJIS2, NUMBER_EMOJIS3)
		},
		usage: "",
		hidden: true,
		method: processWaifuReaction
	}),

	// ── FOTO DE CASAMENTO ────────────────────────────────────────────────────
	new Command({
		name: "mu-foto",
		description: "Exibe ou gera a foto oficial de casamento do casal",
		category: "mudae",
		group: "muwaifu-foto",
		needsArgs: true,
		reactions: { before: "📸", after: "💍", error: "❌" },
		reply: true,
		method: consultarOuGerarFotoCasamento
	}),
	new Command({
		name: "mu-photo",
		description: "Alias em inglês de !mu-foto",
		category: "mudae",
		group: "muwaifu-foto",
		needsArgs: true,
		reactions: { before: "📸", after: "💍", error: "❌" },
		reply: true,
		method: consultarOuGerarFotoCasamento
	}),
	new Command({
		name: "mu-fotocasal",
		description: "Alias de !mu-foto",
		category: "mudae",
		group: "muwaifu-foto",
		needsArgs: true,
		reactions: { before: "📸", after: "💍", error: "❌" },
		reply: true,
		method: consultarOuGerarFotoCasamento
	}),

	// ── DIVORCIAR ───────────────────────────────────────────────────────────
	new Command({
		name: "mu-divorciar",
		description: "Divorcia um personagem do harém e resgata Zinthos (💜)",
		category: "mudae",
		group: "muwaifu-div",
		needsArgs: true,
		reactions: { before: "💔", after: "💔", error: "❌" },
		reply: true,
		method: divorciarWaifu
	}),
	new Command({
		name: "mu-divorce",
		description: "Alias de !mu-divorciar",
		category: "mudae",
		group: "muwaifu-div",
		needsArgs: true,
		reactions: { before: "💔", after: "💔", error: "❌" },
		reply: true,
		method: divorciarWaifu
	}),
	new Command({
		name: "mu-div",
		description: "Alias curto de !mu-divorciar",
		category: "mudae",
		group: "muwaifu-div",
		needsArgs: true,
		reactions: { before: "💔", after: "💔", error: "❌" },
		reply: true,
		method: divorciarWaifu
	}),
	new Command({
		name: "mu-d",
		description: "Alias ultra-curto de !mu-divorciar",
		category: "mudae",
		group: "muwaifu-div",
		needsArgs: true,
		reactions: { before: "💔", after: "💔", error: "❌" },
		reply: true,
		method: divorciarWaifu
	}),

	// ── LIKE ────────────────────────────────────────────────────────────────
	new Command({
		name: "mu-like",
		description: "Dá like/coração em um personagem para aumentar sua popularidade",
		category: "mudae",
		group: "muwaifu-like",
		needsArgs: true,
		reactions: { before: "❤️", after: "❤️", error: "❌" },
		reply: true,
		method: likeWaifu
	}),
	new Command({
		name: "mu-l",
		description: "Alias curto de !mu-like",
		category: "mudae",
		group: "muwaifu-like",
		needsArgs: true,
		reactions: { before: "❤️", after: "❤️", error: "❌" },
		reply: true,
		method: likeWaifu
	}),
	new Command({
		name: "mu-coracao",
		description: "Alias de !mu-like",
		category: "mudae",
		group: "muwaifu-like",
		needsArgs: true,
		reactions: { before: "❤️", after: "❤️", error: "❌" },
		reply: true,
		method: likeWaifu
	}),

	// ── DIÁRIO ──────────────────────────────────────────────────────────────
	new Command({
		name: "mu-diario",
		description: "Coleta sua recompensa diária de Zinthos (💜)",
		category: "mudae",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		reply: true,
		method: diariosKakera
	}),
	new Command({
		name: "mu-daily",
		description: "Alias em inglês de !mu-diario",
		category: "mudae",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		reply: true,
		method: diariosKakera
	}),
	new Command({
		name: "mu-dz",
		description: "Alias curto de !mu-diario (Daily Zinthos)",
		category: "mudae",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		reply: true,
		method: diariosKakera
	}),
	new Command({
		name: "mu-dk",
		description: "Alias de compatibilidade de !mu-diario (Daily Kakera)",
		category: "mudae",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		reply: true,
		method: diariosKakera
	}),
	new Command({
		name: "mu-zinthos-diario",
		description: "Alias descritivo de !mu-diario",
		category: "mudae",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		reply: true,
		method: diariosKakera
	}),
	new Command({
		name: "mu-kakera-diario",
		description: "Alias de compatibilidade de !mu-diario",
		category: "mudae",
		group: "muwaifu-daily",
		reactions: { before: "💜", after: "💜", error: "❌" },
		reply: true,
		method: diariosKakera
	}),

	// ── SALDO ───────────────────────────────────────────────────────────────
	new Command({
		name: "mu-saldo",
		description: "Consulta seu saldo atual de Zinthos (💜)",
		category: "mudae",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		reply: true,
		method: saldoKakera
	}),
	new Command({
		name: "mu-zinthos",
		description: "Alias de !mu-saldo",
		category: "mudae",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		reply: true,
		method: saldoKakera
	}),
	new Command({
		name: "mu-z",
		description: "Alias curto de !mu-saldo",
		category: "mudae",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		reply: true,
		method: saldoKakera
	}),
	new Command({
		name: "mu-kakera",
		description: "Alias de compatibilidade de !mu-saldo",
		category: "mudae",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		reply: true,
		method: saldoKakera
	}),
	new Command({
		name: "mu-k",
		description: "Alias curto de compatibilidade de !mu-saldo",
		category: "mudae",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		reply: true,
		method: saldoKakera
	}),
	new Command({
		name: "mu-bal",
		description: "Alias em inglês de !mu-saldo",
		category: "mudae",
		group: "muwaifu-saldo",
		reactions: { before: "💜", after: "✅", error: "❌" },
		reply: true,
		method: saldoKakera
	}),

	// ── HARÉM ───────────────────────────────────────────────────────────────
	new Command({
		name: "mu-harem",
		description: "Lista todos os personagens pertencentes ao seu harém",
		category: "mudae",
		group: "muwaifu-harem",
		reactions: { before: "👰", after: "✅", error: "❌" },
		reply: true,
		method: verHarem
	}),
	new Command({
		name: "mu-h",
		description: "Alias curto de !mu-harem",
		category: "mudae",
		group: "muwaifu-harem",
		reactions: { before: "👰", after: "✅", error: "❌" },
		reply: true,
		method: verHarem
	}),
	new Command({
		name: "mu-harem-nome",
		description: "Define ou altera o nome personalizado do seu harém (máx 20 caracteres)",
		category: "mudae",
		group: "muwaifu-harem",
		reactions: { before: "👑", after: "✅", error: "❌" },
		reply: true,
		method: definirNomeHarem
	}),
	new Command({
		name: "mu-hnome",
		description: "Alias curto para !mu-harem-nome",
		category: "mudae",
		group: "muwaifu-harem",
		reactions: { before: "👑", after: "✅", error: "❌" },
		reply: true,
		method: definirNomeHarem
	}),
	new Command({
		name: "mu-harem-privado",
		description: "Alterna a privacidade do seu harém entre público e privado",
		category: "mudae",
		group: "muwaifu-harem",
		reactions: { before: "🔒", after: "✅", error: "❌" },
		reply: true,
		method: alternarPrivacidadeHarem
	}),
	new Command({
		name: "mu-hprivado",
		description: "Alias curto para !mu-harem-privado",
		category: "mudae",
		group: "muwaifu-harem",
		reactions: { before: "🔒", after: "✅", error: "❌" },
		reply: true,
		method: alternarPrivacidadeHarem
	}),
	new Command({
		name: "mu-harem-foto",
		description:
			"Consulta fotos ou fixa uma foto no card do harém (!mu-harem-foto <personagem> [índice | casamento | reset])",
		category: "mudae",
		group: "muwaifu-harem",
		needsArgs: true,
		reactions: { before: "📸", after: "✅", error: "❌" },
		reply: true,
		method: gerenciarFotoHarem
	}),
	new Command({
		name: "mu-hfoto",
		description: "Alias curto para !mu-harem-foto",
		category: "mudae",
		group: "muwaifu-harem",
		needsArgs: true,
		reactions: { before: "📸", after: "✅", error: "❌" },
		reply: true,
		method: gerenciarFotoHarem
	}),
	// ── COLEÇÕES (PASTAS) ───────────────────────────────────────────────────
	new Command({
		name: "mu-colecoes",
		description: "Lista suas pastas de waifus ou os personagens de uma coleção",
		category: "mudae",
		group: "muwaifu-colecoes",
		reactions: { before: "📁", after: "📂", error: "❌" },
		reply: true,
		method: listarColecoes
	}),
	new Command({
		name: "mu-colecao",
		description: "Alias de !mu-colecoes",
		category: "mudae",
		group: "muwaifu-colecoes",
		reactions: { before: "📁", after: "📂", error: "❌" },
		reply: true,
		method: listarColecoes
	}),
	new Command({
		name: "mu-cols",
		description: "Alias curto de !mu-colecoes",
		category: "mudae",
		group: "muwaifu-colecoes",
		reactions: { before: "📁", after: "📂", error: "❌" },
		reply: true,
		method: listarColecoes
	}),
	new Command({
		name: "mu-col-nova",
		description: "Cria uma nova coleção para organizar suas waifus (máx 15)",
		category: "mudae",
		group: "muwaifu-colecoes",
		needsArgs: true,
		reactions: { before: "📁", after: "✅", error: "❌" },
		reply: true,
		method: criarColecao
	}),
	new Command({
		name: "mu-col-del",
		description: "Apaga uma coleção mantendo os personagens no harém geral",
		category: "mudae",
		group: "muwaifu-colecoes",
		needsArgs: true,
		reactions: { before: "🗑️", after: "✅", error: "❌" },
		reply: true,
		method: apagarColecao
	}),
	new Command({
		name: "mu-col-add",
		description: "Adiciona uma waifu à pasta especificada (!mu-col-add <pasta> | <personagem>)",
		category: "mudae",
		group: "muwaifu-colecoes",
		needsArgs: true,
		reactions: { before: "📥", after: "✅", error: "❌" },
		reply: true,
		method: adicionarPersonagemColecao
	}),
	new Command({
		name: "mu-col-rem",
		description: "Remove uma waifu de sua pasta atual e retorna ao harém geral",
		category: "mudae",
		group: "muwaifu-colecoes",
		needsArgs: true,
		reactions: { before: "📤", after: "✅", error: "❌" },
		reply: true,
		method: removerPersonagemColecao
	}),
	new Command({
		name: "mu-col-privada",
		description: "Alterna a privacidade de uma coleção de waifus (!mu-col-privada <pasta>)",
		category: "mudae",
		group: "muwaifu-colecoes",
		needsArgs: true,
		reactions: { before: "🔒", after: "✅", error: "❌" },
		reply: true,
		method: alternarPrivacidadeColecao
	}),
	new Command({
		name: "mu-col-priv",
		description: "Alias curto para !mu-col-privada",
		category: "mudae",
		group: "muwaifu-colecoes",
		needsArgs: true,
		reactions: { before: "🔒", after: "✅", error: "❌" },
		reply: true,
		method: alternarPrivacidadeColecao
	}),
	new Command({
		name: "mu-col-ordem",
		description:
			"Define a ordem de exibição das coleções (!mu-col-ordem <pasta1> | <pasta2> | ...)",
		category: "mudae",
		group: "muwaifu-colecoes",
		needsArgs: true,
		reactions: { before: "📋", after: "✅", error: "❌" },
		reply: true,
		method: reordenarColecoes
	}),
	new Command({
		name: "mu-col-ordenar",
		description: "Alias de !mu-col-ordem",
		category: "mudae",
		group: "muwaifu-colecoes",
		needsArgs: true,
		reactions: { before: "📋", after: "✅", error: "❌" },
		reply: true,
		method: reordenarColecoes
	}),

	// ── PERFIL ──────────────────────────────────────────────────────────────
	new Command({
		name: "mu-perfil",
		description: "Exibe seu perfil completo no jogo, harém e waifu favorita",
		category: "mudae",
		group: "muwaifu-perfil",
		reactions: { before: "🎮", after: "✅", error: "❌" },
		reply: true,
		method: verPerfil
	}),
	new Command({
		name: "mu-p",
		description: "Alias curto de !mu-perfil",
		category: "mudae",
		group: "muwaifu-perfil",
		reactions: { before: "🎮", after: "✅", error: "❌" },
		reply: true,
		method: verPerfil
	}),
	new Command({
		name: "mu-profile",
		description: "Alias em inglês de !mu-perfil",
		category: "mudae",
		group: "muwaifu-perfil",
		reactions: { before: "🎮", after: "✅", error: "❌" },
		reply: true,
		method: verPerfil
	}),
	new Command({
		name: "mu-eu",
		description: "Alias rápido de !mu-perfil",
		category: "mudae",
		group: "muwaifu-perfil",
		reactions: { before: "🎮", after: "✅", error: "❌" },
		reply: true,
		method: verPerfil
	}),

	// ── WISHLIST ────────────────────────────────────────────────────────────
	new Command({
		name: "mu-wishlist",
		description: "Lista seus personagens desejados cadastrados",
		category: "mudae",
		group: "muwaifu-wl",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		reply: true,
		method: verWishlist
	}),
	new Command({
		name: "mu-wl",
		description: "Alias curto de !mu-wishlist",
		category: "mudae",
		group: "muwaifu-wl",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		reply: true,
		method: verWishlist
	}),
	new Command({
		name: "mu-desejos",
		description: "Alias em português de !mu-wishlist",
		category: "mudae",
		group: "muwaifu-wl",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		reply: true,
		method: verWishlist
	}),

	// ── DESEJAR ─────────────────────────────────────────────────────────────
	new Command({
		name: "mu-desejar",
		description: "Adiciona um personagem à sua Wishlist (aumenta chance no roll)",
		category: "mudae",
		group: "muwaifu-wish",
		needsArgs: true,
		reactions: { before: "🌟", after: "⭐", error: "❌" },
		reply: true,
		method: adicionarDesejo
	}),
	new Command({
		name: "mu-wish",
		description: "Alias em inglês de !mu-desejar",
		category: "mudae",
		group: "muwaifu-wish",
		needsArgs: true,
		reactions: { before: "🌟", after: "⭐", error: "❌" },
		reply: true,
		method: adicionarDesejo
	}),
	new Command({
		name: "mu-add",
		description: "Alias de !mu-desejar",
		category: "mudae",
		group: "muwaifu-wish",
		needsArgs: true,
		reactions: { before: "🌟", after: "⭐", error: "❌" },
		reply: true,
		method: adicionarDesejo
	}),

	// ── COBIÇAR WAIFU CASADA ────────────────────────────────────────────────
	new Command({
		name: "mu-cobiçar",
		description: "Cobiça uma waifu já casada de outro jogador, adicionando-a à sua Wishlist",
		category: "mudae",
		group: "muwaifu-covet",
		needsArgs: true,
		aliases: ["mu-cobicar", "mucobicar", "mucobiçar"],
		reactions: { before: "👀", after: "✨", error: "❌" },
		reply: true,
		method: cobicarWaifuCmd
	}),
	new Command({
		name: "mu-cobicar",
		description: "Alias de !mu-cobiçar",
		category: "mudae",
		group: "muwaifu-covet",
		needsArgs: true,
		aliases: ["mucobicar", "mucobiçar"],
		reactions: { before: "👀", after: "✨", error: "❌" },
		reply: true,
		method: cobicarWaifuCmd
	}),

	// ── REMOVER DESEJO ──────────────────────────────────────────────────────
	new Command({
		name: "mu-removerdesejo",
		description: "Remove um personagem da sua Wishlist",
		category: "mudae",
		group: "muwaifu-rmwish",
		needsArgs: true,
		reactions: { before: "🗑️", after: "✅", error: "❌" },
		reply: true,
		method: removerDesejo
	}),
	new Command({
		name: "mu-rmwish",
		description: "Alias curto de !mu-removerdesejo",
		category: "mudae",
		group: "muwaifu-rmwish",
		needsArgs: true,
		reactions: { before: "🗑️", after: "✅", error: "❌" },
		reply: true,
		method: removerDesejo
	}),
	new Command({
		name: "mu-rmdesejo",
		description: "Alias de !mu-removerdesejo",
		category: "mudae",
		group: "muwaifu-rmwish",
		needsArgs: true,
		reactions: { before: "🗑️", after: "✅", error: "❌" },
		reply: true,
		method: removerDesejo
	}),
	new Command({
		name: "mu-unwish",
		description: "Alias em inglês de !mu-removerdesejo",
		category: "mudae",
		group: "muwaifu-rmwish",
		needsArgs: true,
		reactions: { before: "🗑️", after: "✅", error: "❌" },
		reply: true,
		method: removerDesejo
	}),

	// ── LIMPAR WISHLIST (REMOVER CASADAS) ────────────────────────────────────
	new Command({
		name: "mu-wishlist-limpar",
		description: "Remove todas as waifus casadas da sua Wishlist",
		category: "mudae",
		group: "muwaifu-wllimpar",
		reactions: { before: "🧹", after: "✨", error: "❌" },
		reply: true,
		method: limparWishlistCasadas
	}),
	new Command({
		name: "mu-wllimpar",
		description: "Alias de !mu-wishlist-limpar",
		category: "mudae",
		group: "muwaifu-wllimpar",
		reactions: { before: "🧹", after: "✨", error: "❌" },
		reply: true,
		method: limparWishlistCasadas
	}),
	new Command({
		name: "mu-limparwishlist",
		description: "Alias em português de !mu-wishlist-limpar",
		category: "mudae",
		group: "muwaifu-wllimpar",
		reactions: { before: "🧹", after: "✨", error: "❌" },
		reply: true,
		method: limparWishlistCasadas
	}),

	// ── FAVORITO ────────────────────────────────────────────────────────────
	new Command({
		name: "mu-favorito",
		description: "Define um personagem do harém como o favorito principal em destaque",
		category: "mudae",
		group: "muwaifu-fav",
		needsArgs: true,
		reactions: { before: "⭐", after: "⭐", error: "❌" },
		reply: true,
		method: definirFavorita
	}),
	new Command({
		name: "mu-fav",
		description: "Alias curto de !mu-favorito",
		category: "mudae",
		group: "muwaifu-fav",
		needsArgs: true,
		reactions: { before: "⭐", after: "⭐", error: "❌" },
		reply: true,
		method: definirFavorita
	}),
	new Command({
		name: "mu-fave",
		description: "Alias de !mu-favorito",
		category: "mudae",
		group: "muwaifu-fav",
		needsArgs: true,
		reactions: { before: "⭐", after: "⭐", error: "❌" },
		reply: true,
		method: definirFavorita
	}),

	// ── SOULMATES ───────────────────────────────────────────────────────────
	new Command({
		name: "mu-soulmates",
		description: "Lista seus personagens que atingiram status de Soulmate (10+ chaves)",
		category: "mudae",
		group: "muwaifu-sm",
		reactions: { before: "💖", after: "✅", error: "❌" },
		reply: true,
		method: verSoulmates
	}),
	new Command({
		name: "mu-sm",
		description: "Alias curto de !mu-soulmates",
		category: "mudae",
		group: "muwaifu-sm",
		reactions: { before: "💖", after: "✅", error: "❌" },
		reply: true,
		method: verSoulmates
	}),
	new Command({
		name: "mu-almas",
		description: "Alias em português de !mu-soulmates",
		category: "mudae",
		group: "muwaifu-sm",
		reactions: { before: "💖", after: "✅", error: "❌" },
		reply: true,
		method: verSoulmates
	}),

	// ── RANKING ─────────────────────────────────────────────────────────────
	new Command({
		name: "mu-ranking",
		description: "Ranking global de jogadores mais ricos em Zinthos (💜)",
		category: "mudae",
		group: "muwaifu-rank",
		reactions: { before: "🏆", after: "✅", error: "❌" },
		reply: true,
		method: verRanking
	}),
	new Command({
		name: "mu-top",
		description: "Alias de !mu-ranking",
		category: "mudae",
		group: "muwaifu-rank",
		reactions: { before: "🏆", after: "✅", error: "❌" },
		reply: true,
		method: verRanking
	}),
	new Command({
		name: "mu-rank",
		description: "Alias curto de !mu-ranking",
		category: "mudae",
		group: "muwaifu-rank",
		reactions: { before: "🏆", after: "✅", error: "❌" },
		reply: true,
		method: verRanking
	}),
	new Command({
		name: "mu-lb",
		description: "Alias Leaderboard de !mu-ranking",
		category: "mudae",
		group: "muwaifu-rank",
		reactions: { before: "🏆", after: "✅", error: "❌" },
		reply: true,
		method: verRanking
	}),
	new Command({
		name: "mu-topgrupo",
		description: "Ranking de jogadores e waifus exclusivo do grupo",
		category: "mudae",
		group: "muwaifu-rank",
		reactions: { before: "🏆", after: "✅", error: "❌" },
		reply: true,
		method: verRankingGrupo
	}),
	new Command({
		name: "mu-rankgrupo",
		description: "Alias de !mu-topgrupo",
		category: "mudae",
		group: "muwaifu-rank",
		reactions: { before: "🏆", after: "✅", error: "❌" },
		reply: true,
		method: verRankingGrupo
	}),
	new Command({
		name: "mu-topg",
		description: "Alias de !mu-topgrupo",
		category: "mudae",
		group: "muwaifu-rank",
		reactions: { before: "🏆", after: "✅", error: "❌" },
		reply: true,
		method: verRankingGrupo
	}),

	// ── TOP PERSONAGENS ─────────────────────────────────────────────────────
	new Command({
		name: "mu-topchars",
		description: "Ranking dos personagens mais casados e mais curtidos",
		category: "mudae",
		group: "muwaifu-topchars",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		reply: true,
		method: verTopCharacters
	}),
	new Command({
		name: "mu-topwaifus",
		description: "Alias de !mu-topchars",
		category: "mudae",
		group: "muwaifu-topchars",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		reply: true,
		method: verTopCharacters
	}),
	new Command({
		name: "mu-populares",
		description: "Alias de !mu-topchars",
		category: "mudae",
		group: "muwaifu-topchars",
		reactions: { before: "🌟", after: "✅", error: "❌" },
		reply: true,
		method: verTopCharacters
	}),

	// ── BUSCAR PERSONAGENS ──────────────────────────────────────────────────
	new Command({
		name: "mu-personagens",
		description: "Busca personagens no catálogo por nome ou série",
		category: "mudae",
		group: "muwaifu-chars",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		reply: true,
		method: buscarPersonagens
	}),
	new Command({
		name: "mu-chars",
		description: "Alias curto de !mu-personagens",
		category: "mudae",
		group: "muwaifu-chars",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		reply: true,
		method: buscarPersonagens
	}),
	new Command({
		name: "mu-buscar",
		description: "Alias de !mu-personagens",
		category: "mudae",
		group: "muwaifu-chars",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		reply: true,
		method: buscarPersonagens
	}),
	new Command({
		name: "mu-find",
		description: "Alias em inglês de !mu-personagens",
		category: "mudae",
		group: "muwaifu-chars",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		reply: true,
		method: buscarPersonagens
	}),

	// ── DETALHES PERSONAGEM ─────────────────────────────────────────────────
	new Command({
		name: "mu-char",
		description:
			"Consulta detalhes e foto de um personagem por busca ampla (nome, ID, série, descrição)",
		category: "mudae",
		group: "muwaifu-char",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		reply: true,
		method: detalhesPersonagem
	}),
	new Command({
		name: "mu-info",
		description: "Alias de !mu-char (busca ampla por nome, ID, série ou descrição)",
		category: "mudae",
		group: "muwaifu-char",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		reply: true,
		method: detalhesPersonagem
	}),
	new Command({
		name: "mu-winfo",
		description: "Alias Waifu-Info de !mu-char (busca ampla por nome, ID, série ou descrição)",
		category: "mudae",
		group: "muwaifu-char",
		needsArgs: true,
		reactions: { before: "🔍", after: "✅", error: "❌" },
		reply: true,
		method: detalhesPersonagem
	}),

	// ── COOLDOWNS ───────────────────────────────────────────────────────────
	new Command({
		name: "mu-cooldowns",
		description: "Consulta todos os seus tempos de espera ativos (roll, claim, daily)",
		category: "mudae",
		group: "muwaifu-cd",
		reactions: { before: "⏳", after: "✅", error: "❌" },
		reply: true,
		method: verCooldowns
	}),
	new Command({
		name: "mu-cd",
		description: "Alias curto de !mu-cooldowns",
		category: "mudae",
		group: "muwaifu-cd",
		reactions: { before: "⏳", after: "✅", error: "❌" },
		reply: true,
		method: verCooldowns
	}),
	new Command({
		name: "mu-tempo",
		description: "Alias em português de !mu-cooldowns",
		category: "mudae",
		group: "muwaifu-cd",
		reactions: { before: "⏳", after: "✅", error: "❌" },
		reply: true,
		method: verCooldowns
	}),

	// ── CONFIGURAÇÕES DO GRUPO (TOGGLE MARCAR WISHLIST NO ROLL) ───────────────
	new Command({
		name: "mu-roll-marcar",
		aliases: ["mu-rollmarcar", "roll-marcar", "rollmarcar"],
		description:
			"Ativa ou desativa a menção de membros quando um personagem da sua wishlist for sorteado no grupo (Apenas Admins)",
		category: "mudae",
		group: "muwaifu-rollmarcar",
		reactions: { before: "⚙️", after: "✅", error: "❌" },
		reply: true,
		method: toggleRollMarcar
	}),
	new Command({
		name: "mu-rollmarcar",
		description: "Alias de !mu-roll-marcar",
		category: "mudae",
		group: "muwaifu-rollmarcar",
		reactions: { before: "⚙️", after: "✅", error: "❌" },
		reply: true,
		method: toggleRollMarcar
	}),

	// ── AJUDA / GUIA DO JOGO (WAIFUS / MUNAE) ───────────────────────────────
	new Command({
		name: "waifus",
		description: "Explica as mecânicas do jogo Waifuletes/Munae e lista todos os comandos",
		category: "mudae",
		group: "muwaifu-help",
		reactions: { before: "🎲", after: "📖", error: "❌" },
		reply: true,
		method: ajudaWaifus
	}),
	new Command({
		name: "munae",
		description: "Alias para o guia completo do jogo Waifuletes/Mudae",
		category: "mudae",
		group: "muwaifu-help",
		reactions: { before: "🎲", after: "📖", error: "❌" },
		reply: true,
		method: ajudaWaifus
	}),
	new Command({
		name: "mudae",
		description: "Alias para o guia completo do jogo Waifuletes",
		category: "mudae",
		group: "muwaifu-help",
		reactions: { before: "🎲", after: "📖", error: "❌" },
		reply: true,
		method: ajudaWaifus
	}),
	new Command({
		name: "mu-ajuda",
		description: "Alias de ajuda do jogo Waifuletes",
		category: "mudae",
		group: "muwaifu-help",
		reactions: { before: "🎲", after: "📖", error: "❌" },
		reply: true,
		method: ajudaWaifus
	}),
	new Command({
		name: "mu-help",
		description: "Alias em inglês de ajuda do jogo Waifuletes",
		category: "mudae",
		group: "muwaifu-help",
		reactions: { before: "🎲", after: "📖", error: "❌" },
		reply: true,
		method: ajudaWaifus
	}),

	// ── PROBABILIDADES / TAXAS ───────────────────────────────────────────────
	new Command({
		name: "mu-chances",
		description: "Mostra as probabilidades de drop por raridade e o bônus da Wishlist",
		category: "mudae",
		group: "muwaifu-chances",
		reactions: { before: "🎲", after: "📊", error: "❌" },
		reply: true,
		method: verChances
	}),
	new Command({
		name: "mu-taxas",
		description: "Alias em português de !mu-chances",
		category: "mudae",
		group: "muwaifu-chances",
		reactions: { before: "🎲", after: "📊", error: "❌" },
		reply: true,
		method: verChances
	}),
	new Command({
		name: "mu-prob",
		description: "Alias curto de !mu-chances",
		category: "mudae",
		group: "muwaifu-chances",
		reactions: { before: "🎲", after: "📊", error: "❌" },
		reply: true,
		method: verChances
	}),
	new Command({
		name: "mu-probabilidades",
		description: "Alias longo de !mu-chances",
		category: "mudae",
		group: "muwaifu-chances",
		reactions: { before: "🎲", after: "📊", error: "❌" },
		reply: true,
		method: verChances
	}),

	// ── DENÚNCIA / MODERAÇÃO DE PERSONAGENS ──────────────────────────────────
	new Command({
		name: "mu-denunciar",
		description: "Denuncia um personagem problemático para a moderação e remoção",
		category: "mudae",
		group: "muwaifu-report",
		reply: false,
		aliases: ["mu-report", "denunciar-waifu", "denunciar-mudae", "mudenunciar", "mureport"],
		reactions: {
			trigger: ["⛔", "\u{26D4}"],
			before: "⏳",
			after: "⛔",
			error: "❌"
		},
		method: denunciarWaifu
	}),
	new Command({
		name: "mu-report",
		description: "Alias em inglês de !mu-denunciar",
		category: "mudae",
		group: "muwaifu-report",
		reply: false,
		reactions: {
			trigger: ["⛔", "\u{26D4}"],
			before: "⏳",
			after: "⛔",
			error: "❌"
		},
		method: denunciarWaifu
	}),

	// ── PAINEL WEB PESSOAL (ADMIN / GESTÃO PRIVADA) ─────────────────────────
	new Command({
		name: "mu-adm",
		description:
			"Gera e envia no seu privado o link de acesso ao seu painel web pessoal do Waifuletes (30 min)",
		category: "mudae",
		group: "muwaifu-web",
		aliases: ["mu-admin", "muadm", "muadmin"],
		reactions: { before: "⏳", after: "🔗", error: "❌" },
		reply: true,
		method: painelWebAdmin
	}),
	new Command({
		name: "mu-admin",
		description: "Alias de !mu-adm",
		category: "mudae",
		group: "muwaifu-web",
		reactions: { before: "⏳", after: "🔗", error: "❌" },
		reply: true,
		method: painelWebAdmin
	}),

	// ── WAIFINDER (MODO CATÁLOGO TINDER) ────────────────────────────────────
	new Command({
		name: "waifinder",
		description: "Envia no seu privado o link de acesso ao Waifinder (modo catálogo estilo Tinder)",
		category: "mudae",
		group: "muwaifu-web",
		aliases: ["mu-waifinder", "mu-tinder"],
		reactions: { before: "⏳", after: "🔥", error: "❌" },
		reply: true,
		method: waifinderWeb
	}),
	new Command({
		name: "mu-waifinder",
		description: "Alias de !waifinder",
		category: "mudae",
		group: "muwaifu-web",
		reactions: { before: "⏳", after: "🔥", error: "❌" },
		reply: true,
		method: waifinderWeb
	}),
	new Command({
		name: "mu-tinder",
		description: "Alias de !waifinder",
		category: "mudae",
		group: "muwaifu-web",
		reactions: { before: "⏳", after: "🔥", error: "❌" },
		reply: true,
		method: waifinderWeb
	}),

	// ── COMPARTILHAR HARÉM (VITRINE PÚBLICA) ────────────────────────────────
	new Command({
		name: "mu-share",
		description: "Compartilha o link público do seu harém no Waifuletes",
		category: "mudae",
		group: "muwaifu-web",
		aliases: ["mu-compartilhar", "mu-link", "mushare", "mucompartilhar"],
		reactions: { before: "⏳", after: "✨", error: "❌" },
		reply: true,
		method: compartilharHarem
	}),
	new Command({
		name: "mu-compartilhar",
		description: "Alias de !mu-share",
		category: "mudae",
		group: "muwaifu-web",
		reactions: { before: "⏳", after: "✨", error: "❌" },
		reply: true,
		method: compartilharHarem
	}),

	// ── CLASSIFICADOS E MERCADO ─────────────────────────────────────────────
	new Command({
		name: "mu-vender",
		description: "Anuncia uma waifu/hushando nos classificados globais com interesse de troca",
		category: "mudae",
		group: "muwaifu-market",
		needsArgs: true,
		aliases: ["mu-anunciar", "muvender", "muanunciar"],
		reactions: { before: "🏷️", after: "✅", error: "❌" },
		reply: true,
		method: venderWaifuCmd
	}),
	new Command({
		name: "mu-anunciar",
		description: "Alias de !mu-vender",
		category: "mudae",
		group: "muwaifu-market",
		needsArgs: true,
		reactions: { before: "🏷️", after: "✅", error: "❌" },
		reply: true,
		method: venderWaifuCmd
	}),
	new Command({
		name: "mu-classificados",
		description: "Lista personagens disponíveis nos classificados globais",
		category: "mudae",
		group: "muwaifu-market",
		aliases: ["muclassificados", "mu-anuncios"],
		reactions: { before: "🛍️", after: "✅", error: "❌" },
		reply: true,
		method: listarClassificadosCmd
	}),
	new Command({
		name: "mu-mercado",
		description: "Panorama macroeconômico, inflação, preços e negociações dos últimos 30 dias",
		category: "mudae",
		group: "muwaifu-market",
		aliases: ["mu-economia", "mumercado", "mueconomia"],
		reactions: { before: "🏛️", after: "📊", error: "❌" },
		reply: true,
		method: mercadoInfoCmd
	}),
	new Command({
		name: "mu-economia",
		description: "Alias de !mu-mercado",
		category: "mudae",
		group: "muwaifu-market",
		reactions: { before: "🏛️", after: "📊", error: "❌" },
		reply: true,
		method: mercadoInfoCmd
	}),
	new Command({
		name: "mu-investir",
		description: "Adquire cotas de 25% de uma waifu livre ou adquire 100% com 4 cotas",
		category: "mudae",
		group: "muwaifu-investment",
		needsArgs: true,
		aliases: ["mu-lance", "mu-cota", "muinvestir", "mulance", "mucota"],
		reactions: { before: "📈", after: "✅", error: "❌" },
		reply: true,
		method: investirWaifuCmd
	}),
	new Command({
		name: "mu-investimentos",
		description: "Lista todas as waifus em que você possui investimento ativo em cotas",
		category: "mudae",
		group: "muwaifu-investment",
		aliases: ["mu-cotas", "mu-meus-investimentos", "muinvestimentos", "mucotas"],
		reactions: { before: "💼", after: "✅", error: "❌" },
		reply: true,
		method: listarInvestimentosCmd
	}),
	new Command({
		name: "mu-cotacao",
		description: "Consulta cotação dinâmica de compra e cotas (25%) de um personagem",
		category: "mudae",
		group: "muwaifu-investment",
		needsArgs: true,
		aliases: ["mu-preco", "mu-valor", "mucotacao", "mupreco", "muvalor"],
		reactions: { before: "📊", after: "✅", error: "❌" },
		reply: true,
		method: cotarWaifuCmd
	}),
	new Command({
		name: "mu-ofertas",
		description: "Lista ofertas recebidas nos seus anúncios de classificados",
		category: "mudae",
		group: "muwaifu-market",
		aliases: ["muofertas", "mu-propostas"],
		reactions: { before: "📜", after: "✅", error: "❌" },
		reply: true,
		method: listarOfertasRecebidasCmd
	}),
	new Command({
		name: "mu-of-aceitar",
		description: "Aceita uma oferta recebida nos classificados pelo ID",
		category: "mudae",
		group: "muwaifu-market",
		needsArgs: true,
		aliases: ["muofaceitar", "mu-aceitar"],
		reactions: { before: "🤝", after: "🎉", error: "❌" },
		reply: true,
		method: aceitarOfertaCmd
	}),
	new Command({
		name: "mu-of-negar",
		description: "Nega ou recusa uma oferta recebida nos classificados pelo ID",
		category: "mudae",
		group: "muwaifu-market",
		needsArgs: true,
		aliases: ["muofnegar", "mu-negar", "mu-recusar"],
		reactions: { before: "⏳", after: "🚫", error: "❌" },
		reply: true,
		method: negarOfertaCmd
	})
];

const helper = {
	about: "Jogo de sorteio de waifus/husbandos (estilo Mudae) integrado com a API Waifuletes",
	implementation:
		"Consome a API REST local do Waifuletes para sorteio ponderado, casamentos em janela de 300s, harém global, chaves, soulmates e economia de Zinthos (💜).",
	tags: "waifu,mudae,munae,jogo,anime,harem,zinthos,kakera,roleta,casamento",
	cmds: [
		{
			cmd: "!mu-mitico",
			desc: "Instruções sobre a forja de personagens míticos lendários exclusivos",
			usage: ["!mu-mitico", "!mu-forjar"],
			category: "mudae"
		},
		{
			cmd: "!waifus / !munae",
			desc: "Explica as mecânicas do jogo e lista todos os comandos e filtros disponíveis",
			usage: ["!waifus", "!munae", "!mu-ajuda"],
			category: "mudae"
		},
		{
			cmd: "!mu-roll",
			desc: "Sorteia um personagem aleatório para o grupo (waifus e husbandos)",
			usage: ["!mu-roll", "!mu-r", "!mu-rollm (só homens)", "!mu-rollf (só mulheres)"],
			category: "mudae"
		},
		{
			cmd: "!mu-roll-marcar",
			desc: "Alterna se o bot deve marcar (@) membros que têm o personagem sorteado na wishlist (Apenas Admins)",
			usage: ["!mu-roll-marcar", "!mu-rollmarcar", "!mu-roll-marcar on/off"],
			category: "mudae"
		},
		{
			cmd: "!mu-casar",
			desc: "Casa com o personagem recém-sorteado dentro da janela de 300 segundos",
			usage: ["!mu-casar", "!mu-c", "!mu-casar rem-re-zero"],
			category: "mudae"
		},
		{
			cmd: "!mu-foto",
			desc: "Exibe a foto oficial de casamento do casal ou gera uma nova com 'nova'",
			usage: ["!mu-foto Rem", "!mu-foto nova Rem", "!mu-foto rem-re-zero"],
			category: "mudae"
		},
		{
			cmd: "!mu-diario",
			desc: "Resgata a recompensa diária de Zinthos (💜)",
			usage: ["!mu-diario", "!mu-dz", "!mu-dk"],
			category: "mudae"
		},
		{
			cmd: "!mu-harem",
			desc: "Lista os personagens que você ou outro usuário possui em seu harém",
			usage: ["!mu-harem", "!mu-h 2", "!mu-harem @usuario"],
			category: "mudae"
		},
		{
			cmd: "!mu-harem-privado",
			desc: "Alterna a privacidade do seu harém entre público e privado",
			usage: ["!mu-harem-privado", "!mu-hprivado", "!mu-harem-privado on/off"],
			category: "mudae"
		},
		{
			cmd: "!mu-harem-foto",
			desc: "Consulta fotos disponíveis ou fixa uma foto específica (catálogo/casamento) no card do harém",
			usage: [
				"!mu-harem-foto Rem",
				"!mu-harem-foto Rem 2",
				"!mu-harem-foto Rem casamento",
				"!mu-harem-foto Rem reset"
			],
			category: "mudae"
		},
		{
			cmd: "!mu-col-privada",
			desc: "Alterna a visibilidade privada de uma coleção (pasta) do seu harém",
			usage: ["!mu-col-privada Isekai", "!mu-col-priv 1"],
			category: "mudae"
		},
		{
			cmd: "!mu-col-ordem",
			desc: "Define a ordem de exibição das suas coleções (pastas)",
			usage: ["!mu-col-ordem Isekai | Shonen | Waifus", "!mu-col-ordem 3 | 1 | 2"],
			category: "mudae"
		},
		{
			cmd: "!mu-saldo",
			desc: "Consulta seu saldo atual de Zinthos (💜)",
			usage: ["!mu-saldo", "!mu-zinthos", "!mu-z", "!mu-k"],
			category: "mudae"
		},
		{
			cmd: "!mu-wishlist",
			desc: "Lista seus personagens desejados (até 1000) e calcula a chance de drop no roll",
			usage: ["!mu-wishlist", "!mu-desejar <id>", "!mu-removerdesejo <id>"],
			category: "mudae"
		},
		{
			cmd: "!mu-chances",
			desc: "Mostra as probabilidades de drop por categoria de personagem e o bônus da Wishlist",
			usage: ["!mu-chances", "!mu-taxas", "!mu-prob"],
			category: "mudae"
		},
		{
			cmd: "!mu-personagens",
			desc: "Busca personagens cadastrados no catálogo por nome ou série",
			usage: ["!mu-personagens Frieren", "!mu-chars Naruto"],
			category: "mudae"
		},
		{
			cmd: "!mu-ranking",
			desc: "Painel de líderes consolidado (Zinthos e Casamentos por raridade). Use 'all' para ver todos.",
			usage: ["!mu-ranking", "!mu-rank zinthos all", "!mu-rank casamentos all"],
			category: "mudae"
		},
		{
			cmd: "!mu-denunciar",
			desc: "Denuncia um personagem problemático para a equipe de moderação e remoção",
			usage: ["!mu-denunciar (em resposta ao roll)", "Reação: ⛔", "!mu-denunciar <id ou nome>"],
			category: "mudae"
		},
		{
			cmd: "!mu-cooldowns",
			desc: "Verifica os tempos restantes para poder rolar, casar ou resgatar o diário",
			usage: ["!mu-cooldowns", "!mu-cd"],
			category: "mudae"
		},
		{
			cmd: "!mu-adm / !mu-admin",
			desc: "Gera e envia no privado o link temporário (30 min) para gerenciar harém, wishlist e sugerir fotos/raridades",
			usage: ["!mu-adm", "!mu-admin"],
			category: "mudae"
		},
		{
			cmd: "!mu-share / !mu-compartilhar",
			desc: "Exibe o link público da sua coleção/harém para compartilhar com amigos",
			usage: ["!mu-share", "!mu-compartilhar"],
			category: "mudae"
		},
		{
			cmd: "!mu-vender / !mu-anunciar",
			desc: "Anuncia uma waifu/hushando nos classificados globais definindo o que busca em troca",
			usage: [
				"!mu-vender <id-waifu> <mensagem de interesse>",
				"!mu-anunciar rem-re-zero Troco por Emília ou 50x Tilápia"
			],
			category: "mudae"
		},
		{
			cmd: "!mu-classificados",
			desc: "Lista as waifus disponíveis nos classificados globais ordenadas por raridade",
			usage: ["!mu-classificados", "!mu-classificados 2"],
			category: "mudae"
		},
		{
			cmd: "!mu-ofertas",
			desc: "Lista todas as ofertas pendentes que outros jogadores fizeram nos seus anúncios",
			usage: ["!mu-ofertas"],
			category: "mudae"
		},
		{
			cmd: "!mu-of-aceitar / !mu-of-negar",
			desc: "Aceita ou recusa uma proposta de troca nos seus classificados",
			usage: ["!mu-of-aceitar <id-da-oferta>", "!mu-of-negar <id-da-oferta>"],
			category: "mudae"
		},
		{
			cmd: "!mu-cobiçar / !mu-cobicar",
			desc: "Cobiça uma waifu já casada de outro jogador. Adiciona à sua Wishlist e notifica o dono no próximo roll",
			usage: ["!mu-cobiçar <id-waifu>", "!mu-cobicar makima"],
			category: "mudae"
		}
	]
};

/**
 * Envia notificação festiva de casamento para personagens lendários no canal de avisos
 * @param {Object} bot
 * @param {Object} character
 * @param {string} userName
 * @param {string} [customDateStr]
 * @param {string} [customChatId]
 * @param {Object} [customMedia] - Foto gerada do casamento (se disponível)
 * @returns {Promise<boolean>}
 */
async function notifySpecialMarriage(
	bot,
	character,
	userName,
	customDateStr = null,
	customChatId = null,
	customMedia = null
) {
	try {
		if (!character) return false;
		const rarity = character.rarity || character.baseRarity || "COMMON";
		if (rarity !== "LEGENDARY") return false;

		const targetChats = [];
		if (customChatId) {
			targetChats.push(customChatId);
		} else if (bot) {
			if (bot.grupoAnuncios) targetChats.push(bot.grupoAnuncios);
			if (bot.grupoAvisos && !String(bot.grupoAvisos).includes("newsletter")) {
				targetChats.push(bot.grupoAvisos);
			}
			if (targetChats.length === 0 && bot.grupoLogs) {
				targetChats.push(bot.grupoLogs);
			}
			if (targetChats.length === 0) {
				if (process.env.GRUPO_ANUNCIOS && process.env.GRUPO_ANUNCIOS.trim()) {
					targetChats.push(process.env.GRUPO_ANUNCIOS.trim());
				}
				if (
					process.env.GRUPO_AVISOS &&
					process.env.GRUPO_AVISOS.trim() &&
					!process.env.GRUPO_AVISOS.includes("newsletter")
				) {
					targetChats.push(process.env.GRUPO_AVISOS.trim());
				}
			}
		} else {
			if (process.env.GRUPO_ANUNCIOS && process.env.GRUPO_ANUNCIOS.trim()) {
				targetChats.push(process.env.GRUPO_ANUNCIOS.trim());
			}
			if (
				process.env.GRUPO_AVISOS &&
				process.env.GRUPO_AVISOS.trim() &&
				!process.env.GRUPO_AVISOS.includes("newsletter")
			) {
				targetChats.push(process.env.GRUPO_AVISOS.trim());
			}
		}

		// Filtra canais do tipo newsletter (exclusivos para resumos semanais e doações)
		const validTargetChats = [...new Set(targetChats.filter(Boolean))].filter(
			(chatId) => !String(chatId).endsWith("@newsletter") && !String(chatId).includes("newsletter")
		);

		if (validTargetChats.length === 0) {
			logger.warn(
				"[notifySpecialMarriage] Nenhum canal/grupo configurado (GRUPO_ANUNCIOS / GRUPO_AVISOS). Envio ignorado."
			);
			return false;
		}

		const dateStr =
			customDateStr ||
			new Date().toLocaleDateString("pt-BR", {
				timeZone: "America/Sao_Paulo"
			});

		let caption = "";
		caption += `👑 ✨ 👑 *CASAMENTO LENDÁRIO EXTRAORDINÁRIO!* 👑 ✨ 👑\n\n`;
		caption += `💍 ══════════════════════════ 💍\n`;
		caption += `   💖 *UNIDOS PELO DESTINO PARA SEMPRE!* 💖\n`;
		caption += `💍 ══════════════════════════ 💍\n\n`;
		caption += `🌌 O jogador *${userName}* alcançou o ápice do amor e selou seu matrimônio sagrado com a suprema lenda:\n\n`;
		caption += `⭐ 🌟 *${character.name}* 🌟 ⭐\n`;
		caption += `👑 *Raridade:* LENDÁRIO ✨\n`;
		if (character.series) {
			caption += `📺 *Universo:* ${character.series}\n`;
		}
		caption += `📅 *Data da Cerimônia:* ${dateStr}\n\n`;
		caption += `✨ ══════════════════════════ ✨\n`;
		caption += `🎉 *Que este casal lendário reine supremo com felicidades infinitas, companheirismo inabalável e vitórias épicas por toda a eternidade!* 🥂🍾✨`;

		// 1. Prioridade: foto gerada do casamento (passada diretamente ou buscada no disco/SQLite)
		let imageBase64 = null;
		if (customMedia && typeof customMedia === "object") {
			if (customMedia.data && typeof customMedia.data === "string") {
				imageBase64 = customMedia.data;
			} else if (customMedia.photoPath) {
				try {
					const buf = await fs.readFile(customMedia.photoPath);
					imageBase64 = buf.toString("base64");
				} catch (eRead) {
					logger.debug(`[notifySpecialMarriage] Erro ao ler photoPath: ${eRead.message}`);
				}
			}
		}

		if (!imageBase64 && character.id) {
			try {
				const savedPhoto = await getMarriagePhoto(character.id);
				if (savedPhoto && savedPhoto.exists && savedPhoto.photoPath) {
					const buf = await fs.readFile(savedPhoto.photoPath);
					imageBase64 = buf.toString("base64");
				}
			} catch (errSaved) {
				logger.debug(
					`[notifySpecialMarriage] Foto de casamento salva não encontrada para ${character.id}: ${errSaved.message}`
				);
			}
		}

		// 2. Fallback: usar a foto original do personagem
		if (!imageBase64 && character.imageUrl) {
			imageBase64 = await module.exports.downloadImageAsBase64(character.imageUrl);
		}

		let sentAny = false;

		for (const targetChat of validTargetChats) {
			try {
				let retMsg;
				if (imageBase64) {
					retMsg = new ReturnMessage({
						chatId: targetChat,
						content: {
							mimetype: "image/jpeg",
							data: imageBase64,
							filename: `marriage_${character.id || "waifu"}.jpg`,
							isMessageMedia: true
						},
						options: {
							caption
						}
					});
				} else {
					retMsg = new ReturnMessage({
						chatId: targetChat,
						content: caption
					});
				}

				if (bot && typeof bot.sendReturnMessages === "function") {
					await bot.sendReturnMessages(retMsg);
					sentAny = true;
				} else if (bot && typeof bot.sendMessage === "function") {
					if (imageBase64) {
						const media = await bot.createMedia(
							Buffer.from(imageBase64, "base64"),
							"image/jpeg",
							`marriage_${character.id || "waifu"}.jpg`
						);
						await bot.sendMessage(targetChat, media, { caption });
					} else {
						await bot.sendMessage(targetChat, caption);
					}
					sentAny = true;
				}
			} catch (errSend) {
				logger.error(
					`[notifySpecialMarriage] Erro ao enviar notificação para ${targetChat}:`,
					errSend
				);
			}
		}

		// Se o casamento lendário ocorreu no Telegram ou Discord, envia também para os canais de avisos do WhatsApp
		if (bot && (bot.useTelegram || bot.useDiscord)) {
			try {
				const waContent = imageBase64
					? {
							mimetype: "image/jpeg",
							data: imageBase64,
							filename: `marriage_${character.id || "waifu"}.jpg`,
							isMessageMedia: true
						}
					: caption;

				await broadcastToWhatsAppNoticeChannels({
					content: waContent,
					options: imageBase64 ? { caption } : {},
					pinDuration: 260000
				});
			} catch (eWa) {
				logger.error(
					`[notifySpecialMarriage] Erro ao sincronizar casamento lendário para WhatsApp: ${eWa.message || eWa}`
				);
			}
		}

		return sentAny;
	} catch (err) {
		logger.error("Erro ao notificar casamento especial:", err);
		return false;
	}
}

/**
 * Notifica canal/grupo de avisos quando um jogador atinge 10 chaves (Soulmate) com seu personagem.
 * Notificação ricamente decorada com todos os tipos de corações.
 *
 * @param {Object} bot
 * @param {Object} character
 * @param {string} userName
 * @param {string} [customDateStr]
 * @param {string} [customChatId]
 * @param {Object} [customMedia]
 * @returns {Promise<boolean>}
 */
async function notifySoulmateAchievement(
	bot,
	character,
	userName,
	customDateStr = null,
	customChatId = null,
	customMedia = null
) {
	try {
		if (!character) return false;

		const targetChats = [];
		if (customChatId) {
			targetChats.push(customChatId);
		} else if (bot) {
			if (bot.grupoAnuncios) targetChats.push(bot.grupoAnuncios);
			if (bot.grupoAvisos && !String(bot.grupoAvisos).includes("newsletter")) {
				targetChats.push(bot.grupoAvisos);
			}
			if (targetChats.length === 0 && bot.grupoLogs) {
				targetChats.push(bot.grupoLogs);
			}
			if (targetChats.length === 0) {
				if (process.env.GRUPO_ANUNCIOS && process.env.GRUPO_ANUNCIOS.trim()) {
					targetChats.push(process.env.GRUPO_ANUNCIOS.trim());
				}
				if (
					process.env.GRUPO_AVISOS &&
					process.env.GRUPO_AVISOS.trim() &&
					!process.env.GRUPO_AVISOS.includes("newsletter")
				) {
					targetChats.push(process.env.GRUPO_AVISOS.trim());
				}
			}
		} else {
			if (process.env.GRUPO_ANUNCIOS && process.env.GRUPO_ANUNCIOS.trim()) {
				targetChats.push(process.env.GRUPO_ANUNCIOS.trim());
			}
			if (
				process.env.GRUPO_AVISOS &&
				process.env.GRUPO_AVISOS.trim() &&
				!process.env.GRUPO_AVISOS.includes("newsletter")
			) {
				targetChats.push(process.env.GRUPO_AVISOS.trim());
			}
		}

		// Filtra canais do tipo newsletter (exclusivos para resumos semanais e doações)
		const validTargetChats = [...new Set(targetChats.filter(Boolean))].filter(
			(chatId) => !String(chatId).endsWith("@newsletter") && !String(chatId).includes("newsletter")
		);

		if (validTargetChats.length === 0) {
			logger.warn(
				"[notifySoulmateAchievement] Nenhum canal/grupo configurado (GRUPO_ANUNCIOS / GRUPO_AVISOS). Envio ignorado."
			);
			return false;
		}

		const dateStr =
			customDateStr ||
			new Date().toLocaleDateString("pt-BR", {
				timeZone: "America/Sao_Paulo"
			});

		const rawRarity = String(character.rarity || character.baseRarity || "COMMON").toUpperCase();
		const emojiRarity = RARITY_EMOJI[rawRarity] || "⚪";
		const labelRarity = RARITY_LABEL[rawRarity] || rawRarity;

		let caption = "";
		caption += `💖 💕 💓 💗 💞 💘 💝 💟 💌 🫀 ❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 🩵 🩶 🩷\n`;
		caption += `✨ 🌟 💖 *NOVO LAÇO SUPREMO: SOULMATE ATINGIDO!* 💖 🌟 ✨\n`;
		caption += `💖 💕 💓 💗 💞 💘 💝 💟 💌 🫀 ❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 🩵 🩶 🩷\n\n`;
		caption += `🌹 ══════════════════════════════ 🌹\n`;
		caption += `   💞 *DUAS ALMAS ENTRELAÇADAS PELA ETERNIDADE!* 💞\n`;
		caption += `🌹 ══════════════════════════════ 🌹\n\n`;
		caption += `✨ Com devoção e lealdade inabaláveis ao longo de incontáveis jornadas, acumulando todas as *10 Chaves do Destino (🔑 10/10)*, o jogador:\n\n`;
		caption += `👑 ➔ *${userName}*\n\n`;
		caption += `Despertou a sintonia cósmica absoluta e consagrou-se oficialmente como *ALMA GÊMEA (SOULMATE)* de:\n\n`;
		caption += `💖 🌸 *${character.name}* 🌸 💖\n`;
		caption += `⭐ *Raridade:* ${emojiRarity} ${labelRarity}\n`;
		if (character.series) {
			caption += `📺 *Universo:* ${character.series}\n`;
		}
		caption += `📅 *Data da Consagração:* ${dateStr}\n\n`;
		caption += `💎 *Privilégios Celestiais Desbloqueados:*\n`;
		caption += `  🏆 *Bônus no Ranking:* +25 pontos de valor da coleção no ranking geral!\n`;
		caption += `  📝 *Personalização Exclusiva:* Apelido carinhoso e nota especial configuráveis no painel web!\n`;
		caption += `  ✨ *Cristais Turbinados:* Bônus multiplicador massivo de cristais Zinthos ao ser rolado por outros jogadores!\n`;
		caption += `  💰 *Divórcio Dourado:* Em caso de divórcio, devolve o valor integral de 4 cotas completas (450k a 6.3M) mais 30k por chave!\n\n`;
		caption += `💌 ══════════════════════════════ 💌\n`;
		caption += `💖 *Que este amor lendário resplandeça por todas as eras com bênçãos infinitas, fidelidade inquebrantável e vitórias épicas!* 🥂🍾💐✨\n`;
		caption += `💖 💕 💓 💗 💞 💘 💝 💟 💌 🫀 ❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 🩵 🩶 🩷`;

		// 1. Prioridade: foto gerada do casamento (se disponível)
		let imageBase64 = null;
		if (customMedia && typeof customMedia === "object") {
			if (customMedia.data && typeof customMedia.data === "string") {
				imageBase64 = customMedia.data;
			} else if (customMedia.photoPath) {
				try {
					const buf = await fs.readFile(customMedia.photoPath);
					imageBase64 = buf.toString("base64");
				} catch (eRead) {
					logger.debug(`[notifySoulmateAchievement] Erro ao ler photoPath: ${eRead.message}`);
				}
			}
		}

		if (!imageBase64 && character.id) {
			try {
				const savedPhoto = await getMarriagePhoto(character.id);
				if (savedPhoto && savedPhoto.exists && savedPhoto.photoPath) {
					const buf = await fs.readFile(savedPhoto.photoPath);
					imageBase64 = buf.toString("base64");
				}
			} catch (errSaved) {
				logger.debug(
					`[notifySoulmateAchievement] Foto de casamento salva não encontrada para ${character.id}: ${errSaved.message}`
				);
			}
		}

		// 2. Fallback: usar a foto original do personagem
		if (!imageBase64 && character.imageUrl) {
			imageBase64 = await module.exports.downloadImageAsBase64(character.imageUrl);
		}

		let sentAny = false;

		for (const targetChat of validTargetChats) {
			try {
				let retMsg;
				if (imageBase64) {
					retMsg = new ReturnMessage({
						chatId: targetChat,
						content: {
							mimetype: "image/jpeg",
							data: imageBase64,
							filename: `soulmate_${character.id || "waifu"}.jpg`,
							isMessageMedia: true
						},
						options: {
							caption
						}
					});
				} else {
					retMsg = new ReturnMessage({
						chatId: targetChat,
						content: caption
					});
				}

				if (bot && typeof bot.sendReturnMessages === "function") {
					await bot.sendReturnMessages(retMsg);
					sentAny = true;
				} else if (bot && typeof bot.sendMessage === "function") {
					if (imageBase64) {
						const media = await bot.createMedia(
							Buffer.from(imageBase64, "base64"),
							"image/jpeg",
							`soulmate_${character.id || "waifu"}.jpg`
						);
						await bot.sendMessage(targetChat, media, { caption });
					} else {
						await bot.sendMessage(targetChat, caption);
					}
					sentAny = true;
				}
			} catch (errSend) {
				logger.error(
					`[notifySoulmateAchievement] Erro ao enviar notificação para ${targetChat}:`,
					errSend
				);
			}
		}

		// Se a consagração de Soulmate ocorreu no Telegram ou Discord, envia também para os canais de avisos do WhatsApp
		if (bot && (bot.useTelegram || bot.useDiscord)) {
			try {
				const waContent = imageBase64
					? {
							mimetype: "image/jpeg",
							data: imageBase64,
							filename: `soulmate_${character.id || "waifu"}.jpg`,
							isMessageMedia: true
						}
					: caption;

				await broadcastToWhatsAppNoticeChannels({
					content: waContent,
					options: imageBase64 ? { caption } : {},
					pinDuration: 260000
				});
			} catch (eWa) {
				logger.error(
					`[notifySoulmateAchievement] Erro ao sincronizar soulmate para WhatsApp: ${eWa.message || eWa}`
				);
			}
		}

		return sentAny;
	} catch (err) {
		logger.error("Erro ao notificar conquista de Soulmate:", err);
		return false;
	}
}

/**
 * Obtém estatísticas semanais de Waifus (Waifuletes)
 * @param {number} [sinceMs]
 * @param {Object} [bot=null]
 * @returns {Promise<Object|null>}
 */
async function getWeeklyWaifuStats(sinceMs = null, bot = null) {
	try {
		const since = sinceMs || Date.now() - 7 * 24 * 3600 * 1000;

		// 1. Rolls calculados no cmd_usage_log
		let rollsData = { total_commands: 0, total_rolls: 0, distinct_rollers: 0 };
		try {
			const rollRow = await database.dbGet(
				"cmd_usage",
				`SELECT 
					COUNT(*) as total_commands,
					SUM(
						CASE 
							WHEN args GLOB '[1-9]' THEN CAST(args AS INTEGER)
							WHEN args GLOB '[1-9][0-9]' THEN CAST(args AS INTEGER)
							ELSE 1 
						END
					) as total_rolls,
					COUNT(DISTINCT user) as distinct_rollers
				 FROM cmd_usage_log
				 WHERE command IN ('mu-roll', 'mu-r', 'mu-w', 'mu-waifu', 'mu-rollm', 'mu-rm', 'mu-rollf', 'mu-rf')
				   AND timestamp >= ?`,
				[since]
			);
			if (rollRow) {
				rollsData = {
					total_commands: Number(rollRow.total_commands) || 0,
					total_rolls: Number(rollRow.total_rolls) || 0,
					distinct_rollers: Number(rollRow.distinct_rollers) || 0
				};
			}
		} catch (dbErr) {
			logger.warn("[getWeeklyWaifuStats] Erro ao consultar rolls no cmd_usage:", dbErr.message);
		}

		// 2. Consulta API do Waifuletes
		let apiData = null;
		try {
			const { data: apiRes } = await api.get("/admin/stats/weekly");
			if (apiRes?.success && apiRes?.data) {
				apiData = apiRes.data;
			}
		} catch (apiErr) {
			logger.warn(
				"[getWeeklyWaifuStats] Rota /admin/stats/weekly não disponível, usando fallback:",
				apiErr.message
			);
		}

		// Fallback caso a rota /admin/stats/weekly ainda não esteja no ar no container
		if (!apiData) {
			try {
				const [haremRes] = await Promise.all([
					api.get("/leaderboard/harem?limit=1").catch(() => ({ data: {} }))
				]);
				const topHaremUser = haremRes?.data?.data?.topHarem?.[0] || null;
				apiData = {
					weeklyMarriagesByRarity: [],
					weeklyNegotiationsCount: 0,
					weeklySoulmatesCount: 0,
					topMarrier: topHaremUser
						? { name: topHaremUser.name, count: topHaremUser.totalMarriages }
						: null,
					mostCoveted: null,
					categoryStats: []
				};
			} catch (_) {}
		}

		return {
			rolls: rollsData,
			marriagesByRarity: apiData?.weeklyMarriagesByRarity || [],
			negotiationsCount: apiData?.weeklyNegotiationsCount || 0,
			weeklySoulmatesCount: apiData?.weeklySoulmatesCount || 0,
			topMarrier: apiData?.topMarrier || null,
			mostCoveted: apiData?.mostCoveted || null,
			categoryStats: apiData?.categoryStats || []
		};
	} catch (err) {
		logger.error("[getWeeklyWaifuStats] Erro geral ao obter estatísticas de waifus:", err);
		return null;
	}
}

module.exports = {
	helper,
	commands,
	ajudaWaifus,
	verChances,
	rollAny,
	rollMale,
	rollFemale,
	casarWaifu,
	getWeeklyWaifuStats,
	consultarOuGerarFotoCasamento,
	divorciarWaifu,
	likeWaifu,
	diariosKakera,
	saldoKakera,
	grantZinthos,
	grantZinthosAll,
	getAllWaifuUserIds,
	verHarem,
	definirNomeHarem,
	alternarPrivacidadeHarem,
	gerenciarFotoHarem,
	listarColecoes,
	criarColecao,
	apagarColecao,
	adicionarPersonagemColecao,
	removerPersonagemColecao,
	alternarPrivacidadeColecao,
	reordenarColecoes,
	extractFirstMention,
	resolveCharacter,
	verPerfil,
	painelWebAdmin,
	compartilharHarem,
	verWishlist,
	limparWishlistCasadas,
	adicionarDesejo,
	removerDesejo,
	definirFavorita,
	verSoulmates,
	verRanking,
	verTopCharacters,
	buscarPersonagens,
	detalhesPersonagem,
	denunciarWaifu,
	verCooldowns,
	pendingClaims,
	recentMultiRollsByGroup,
	activeClaimsByCharGroup,
	EXCLUSIVE_CLAIM_WINDOW_MS,
	EXCLUSIVE_CLAIM_WINDOWS,
	getExclusiveClaimWindowMs,
	NUMBER_EMOJIS,
	NUMBER_EMOJIS2,
	NUMBER_EMOJIS3,
	getSlotNumberFromEmoji,
	buildRollGridImage,
	downloadImageBuffer,
	processWaifuReaction,
	recordRollMessage,
	recordCharSearchMessage,
	getCharSearchByMessageId,
	extractCharSearchResultsFromText,
	getRollByMessageId,
	getMultiRollByMessageId,
	getCharacterIdFromMessageId,
	extractCharacterFromRollText,
	extractMultiRollSlotsFromText,
	processMultiRollReport,
	multiRollHistoryByMsgId,
	notifySpecialMarriage,
	notifySoulmateAchievement,
	downloadImageAsBase64,
	handleApiError,
	api,
	normalizeUserId,
	getUserId,
	recordWaifuReportConfirmation,
	getWaifuReportConfirmations,
	deleteWaifuReportConfirmations,
	venderWaifuCmd,
	listarClassificadosCmd,
	listarOfertasRecebidasCmd,
	aceitarOfertaCmd,
	negarOfertaCmd,
	investirWaifuCmd,
	listarInvestimentosCmd,
	cotarWaifuCmd,
	mercadoInfoCmd,
	toggleRollMarcar,
	getGroupParticipants,
	isUserActiveInGroup,
	escapeXml,
	getCharacterWebUrl,
	resolveWaifuImageUrl,
	generateSingleRollPlaceholderBuffer,
	infoCriacaoMitico,
	handleWaifuMenuCallback
};
