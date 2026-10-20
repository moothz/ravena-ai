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
const jardimClient = new ShadowGardenClient();

const database = Database.getInstance();
const logger = new Logger("waifu-commands");

// ─── Configurações da API ───────────────────────────────────────────────────
const WAIFULETES_URL = process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030";
const WAIFULETES_KEY = process.env.WAIFULETES_API_KEY;
const WAIFULETES_WEB_URL = process.env.WAIFULETES_WEB_URL || "https://waifuletes.moothz.win";

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

// Emojis numéricos para reações e identificadores visuais (1 a 9)
const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
const NUMBER_EMOJIS2 = ["1⃣", "2⃣", "3⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
const NUMBER_EMOJIS3 = ["1️", "2️", "3️", "4️", "5️", "6️", "7️", "8️", "9️"];

/**
 * Converte emoji numérico (1️⃣ a 9️⃣) no índice de slot correspondente (1 a 9)
 * @param {string} emoji
 * @returns {number|null}
 */
function getSlotNumberFromEmoji(emoji) {
	if (!emoji || typeof emoji !== "string") return null;
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

// Cache em memória de mensagens de roll ativas (por ID de mensagem enviado)
// Map<messageId, { characterId: string, groupId: string, rollerUserId?: string, rollerUserName?: string, exclusiveUntil?: number, expiresAt: number }>
const rollClaimsByMsgId = new Map();
// Histórico para moderação/denúncias (mantém últimos 1000 IDs mesmo após expirar claim)
const rollHistoryByMsgId = new Map();
const MAX_ROLL_HISTORY = 1000;
// Histórico de mensagens de rolls múltiplos para moderação/denúncias
const multiRollHistoryByMsgId = new Map();

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
	gridBase64 = null
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
				claimed: Boolean(item.claimed)
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
	LEGENDARY: "⭐"
};

const RARITY_LABEL = {
	COMMON: "Comum",
	UNCOMMON: "Incomum",
	RARE: "Raro",
	EPIC: "Épico",
	LEGENDARY: "Lendário"
};

// Limite máximo de itens na Wishlist
const WISHLIST_MAX_ITEMS = 1000;

// Pesos base de cada raridade no sorteio (RollService)
const RARITY_WEIGHTS = {
	COMMON: 100,
	UNCOMMON: 60,
	RARE: 30,
	EPIC: 15,
	LEGENDARY: 5
};

// Cache de estatísticas e probabilidades de drop
let cachedDropStats = null;
let cachedDropStatsAt = 0;
const DROP_STATS_CACHE_TTL = 15 * 60 * 1000; // 15 minutos

async function getUserWishlistStats(userId, totalWeight) {
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
		for (const item of wishlist) {
			const char = item.character;
			const r = char?.baseRarity || char?.rarity || "COMMON";
			const baseW = RARITY_WEIGHTS[r] || 100;
			const multiplier = item.isStarWish ? 2.0 : 1.5;
			totalWishWeight += Math.max(1, Math.round(baseW * multiplier));
		}

		const anyWishChance = totalWeight > 0 ? (totalWishWeight / totalWeight) * 100 : 0;
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

function getUserId(message) {
	const rawId = message?.originReaction?.senderId || message?.author;
	return normalizeUserId(rawId);
}

function getGroupId(message) {
	return message.group ?? message.author;
}

function getUserName(message) {
	if (message?.originReaction?.userName) {
		return message.originReaction.userName;
	}
	if (message?.originReaction?.senderId) {
		return message.originReaction.senderId.split("@")[0];
	}
	return message.authorName || (message.author ? message.author.split("@")[0] : "Jogador");
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
 * Baixa o buffer binário da imagem do personagem
 * @param {string} imageUrl
 * @returns {Promise<Buffer|null>}
 */
async function downloadImageBuffer(imageUrl) {
	if (!imageUrl) return null;
	try {
		let resolvedUrl = imageUrl;
		// Se a URL apontar para localhost ou vier relativa, substitui para a base configurada
		if (resolvedUrl.startsWith("/") || resolvedUrl.includes("localhost:")) {
			const pathPart = resolvedUrl.replace(/^https?:\/\/[^/]+/, "");
			resolvedUrl = `${WAIFULETES_URL}${pathPart.startsWith("/") ? "" : "/"}${pathPart}`;
		}

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

			let rarityKey = "COMMON";
			if (rawRarity.includes("LEGEND") || rawRarity.includes("LEND")) {
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
			const badgeW = isRollerWishlist ? Math.max(style.badgeW + 60, 116) : style.badgeW;
			const badgeH = style.badgeH;
			const fontSize = isRollerWishlist
				? Math.max(22, Math.round(style.fontSize * 0.76))
				: style.fontSize;
			const badgeTop = cellH - badgeH - 12;
			const badgeLeft = Math.floor((cellW - badgeW) / 2);
			const badgeText = isRollerWishlist ? `⭐ ${slot} ⭐` : `${slot}`;

			const badgeSvg = Buffer.from(`
				<svg width="${badgeW}" height="${badgeH}" xmlns="http://www.w3.org/2000/svg">
					<rect width="${badgeW}" height="${badgeH}" rx="${style.rx}" fill="${style.bg}" stroke="${style.stroke}" stroke-width="${style.strokeWidth}"/>
					<text x="${badgeW / 2}" y="${badgeH / 2}" font-size="${fontSize}" font-weight="bold" text-anchor="middle" dominant-baseline="central" fill="${style.textColor}" font-family="DejaVu Sans, Arial, sans-serif">${badgeText}</text>
				</svg>
			`);

			let baseImageBuffer = item.imageBuffer;
			if (!baseImageBuffer) {
				const charName = String(
					item.character?.characterName || item.character?.name || "Personagem"
				).substring(0, 20);
				const charSeries = String(item.character?.series || "").substring(0, 22);
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
			msg = `💍 *Cooldown de Casamento ativo!*\n• Você precisa aguardar *${waitTime}* para realizar outro casamento${timeStr}.`;
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
		LOCK_EXPIRED: "⌛ A janela de 300 segundos para casar expirou!",
		CHARACTER_ALREADY_CLAIMED: "🚫 Este personagem já foi reivindicado por outro jogador!",
		CHARACTER_NOT_IN_HAREM: "❓ Este personagem não faz parte do seu harém.",
		NOT_IN_HAREM: "❓ Este personagem não faz parte do seu harém.",
		WISHLIST_LIMIT_REACHED: `⚠️ Sua wishlist está cheia (máximo de ${WISHLIST_MAX_ITEMS}). Remova um item antes com \`!mu-removerdesejo <id>\`.`,
		ENTRY_NOT_FOUND: "🔍 Este personagem não está na sua Wishlist.",
		CHARACTER_NOT_FOUND: "🔍 Personagem não encontrado. Verifique o ID informado.",
		USER_NOT_FOUND: "👤 Usuário não cadastrado ainda. Use *!mu-roll* para começar!"
	};

	const message =
		(apiErr?.code && customMsgs[apiErr.code]) ||
		apiErr?.message ||
		resData?.message ||
		(typeof resData?.error === "string" ? resData.error : null) ||
		defaultMsg;

	logger.error("Erro na chamada Waifuletes:", apiErr || resData?.message || err.message);
	return new ReturnMessage({ chatId, content: `❌ ${message}`, options });
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
 * Cria função de roll com ou sem filtro de gênero
 * @param {"MALE" | "FEMALE" | undefined} genderFilter
 */
function makeRollHandler(genderFilter) {
	return async function rollWaifu(bot, message, args) {
		const chatId = message.group ?? message.author;
		const userId = getUserId(message);
		const groupId = getGroupId(message);
		const name = getUserName(message);

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

			const payload = {
				userId,
				groupId,
				name,
				platform: "WHATSAPP",
				...(genderFilter && { gender: genderFilter }),
				...(rollBonuses ? { bonuses: rollBonuses } : {})
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

				const rarity = character.rarity || character.baseRarity || "COMMON";
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
					const keys = keyProgress?.currentKeys ?? 1;
					text += `✨ *Você rolou seu próprio personagem!*\n🔑 Chaves acumuladas: *${keys}/10*`;
					if (keyProgress?.becameSoulmateNow) {
						text += `\n\n💖 *PARABÉNS! ${character.name} agora é oficialmente sua SOULMATE permanente!*`;
					}
				} else {
					text += `🔒 Já pertence a: *${owner?.name || "Outro jogador"}*`;
					if (kakeraValue) {
						text += `\n💜 Valor em cristal: *${kakeraValue} Zinthos*`;
					}
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

				if (Array.isArray(firstRollData.wishlistUsers) && firstRollData.wishlistUsers.length > 0) {
					const listMentions = firstRollData.wishlistUsers
						.map((u) => `@${normalizeUserId(u.userId)}`)
						.join(", ");
					text += `\n\n- Usuários que tem personagem na wishlist: ${listMentions}`;
					firstRollData.wishlistUsers.forEach((u) => {
						mentions.push(toJid(u.userId));
					});
				}

				const uniqueMentions = [...new Set(mentions)];

				const imageBase64 = await downloadImageAsBase64(character.imageUrl);
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
								waifuGroupId: groupId,
								waifuRollerUserId: userId,
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
							waifuGroupId: groupId,
							waifuRollerUserId: userId,
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

					const stepPayload = {
						...payload,
						...(Object.keys(stepBonuses).length > 0 ? { bonuses: stepBonuses } : {})
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

			const now = Date.now();
			const multiRollSlots = allRollResults.map((r, idx) => {
				const slot = idx + 1;
				const char = r.character;
				const rarity = char.rarity || char.baseRarity || "COMMON";
				const exclMs = r.available ? getExclusiveClaimWindowMs(rarity) : 0;
				const exclusiveUntil = exclMs > 0 ? now + exclMs : null;

				return {
					slot,
					characterId: char.id,
					characterName: char.name,
					series: char.series,
					rarity,
					available: Boolean(r.available),
					isOwner: Boolean(r.isOwner),
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

			pendingClaims.set(groupId, {
				isMultiRoll: true,
				groupId,
				characters: multiRollSlots,
				slots: multiRollSlots,
				rollerUserId: userId,
				rollerUserName: name,
				expiresAt: now + CLAIM_WINDOW_MS
			});

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

			// Categorias na ordem solicitada:
			// 1. Personagens que a pessoa que usou o mu-roll já tem alguma chave pelo menos (isOwner)
			// 2. Personagens da wishlist de alguém do grupo (solteiros)
			// 3. Solteiros
			// 4. Casados
			const rollerKeysSlots = multiRollSlots.filter((s) => s.isOwner);
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

			if (rollerKeysSlots.length > 0) {
				text += `🔑 *Com chaves:*\n`;
				rollerKeysSlots.forEach((s) => {
					const emojiNum = NUMBER_EMOJIS[s.slot - 1] || `${s.slot}️⃣`;
					const normRarity = String(s.rarity).toUpperCase();
					const emojiRarity = RARITY_EMOJI[normRarity] || "⚪";
					const labelRarity = RARITY_LABEL[normRarity] || s.rarity;
					const keysCount = s.keyProgress?.currentKeys || 1;
					text += `${emojiNum} ${emojiRarity} [${labelRarity}] ${s.characterName} — ${s.series || ""} (🔑 Chaves: ${keysCount}/10)\n`;
				});
				text += "\n";
			}

			const hasFreeSlots = groupWishlistFreeSlots.length > 0 || solteirosSlots.length > 0;
			if (hasFreeSlots) {
				text += `_Reaja com o emoji do número para casar!_\n\n`;
			}

			if (groupWishlistFreeSlots.length > 0) {
				text += `⭐ *Wishlist do grupo:*\n`;
				groupWishlistFreeSlots.forEach((s) => {
					const emojiNum = NUMBER_EMOJIS[s.slot - 1] || `${s.slot}️⃣`;
					const normRarity = String(s.rarity).toUpperCase();
					const emojiRarity = RARITY_EMOJI[normRarity] || "⚪";
					const labelRarity = RARITY_LABEL[normRarity] || s.rarity;
					text += `${emojiNum} ${emojiRarity} [${labelRarity}] ${s.characterName} — ${s.series || ""}\n`;
					text += `> !mu-casar ${s.characterId}\n\n`;
				});
			}

			if (solteirosSlots.length > 0) {
				text += `💍 *Solteiros:*\n`;
				solteirosSlots.forEach((s) => {
					const emojiNum = NUMBER_EMOJIS[s.slot - 1] || `${s.slot}️⃣`;
					const normRarity = String(s.rarity).toUpperCase();
					const emojiRarity = RARITY_EMOJI[normRarity] || "⚪";
					const labelRarity = RARITY_LABEL[normRarity] || s.rarity;
					text += `${emojiNum} ${emojiRarity} [${labelRarity}] ${s.characterName} — ${s.series || ""}\n`;
					text += `> !mu-casar ${s.characterId}\n\n`;
				});
			}

			if (casadosSlots.length > 0) {
				text += `💔 *Casados:*\n`;
				casadosSlots.forEach((s) => {
					const emojiNum = NUMBER_EMOJIS[s.slot - 1] || `${s.slot}️⃣`;
					const normRarity = String(s.rarity).toUpperCase();
					const emojiRarity = RARITY_EMOJI[normRarity] || "⚪";
					const labelRarity = RARITY_LABEL[normRarity] || s.rarity;
					const ownerInfo = s.owner?.name ? ` (${s.owner.name})` : "";
					text += `${emojiNum} ${emojiRarity} [${labelRarity}] ${s.characterName} — ${s.series || ""}${ownerInfo}\n`;
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
			allRollResults.forEach((r) => {
				if (Array.isArray(r.wishlistUsers)) {
					r.wishlistUsers.forEach((u) => {
						const cleanId = normalizeUserId(u.userId);
						if (cleanId) {
							wishlistUsersMap.set(cleanId, u);
						}
					});
				}
			});

			const multiMentions = [];
			if (wishlistUsersMap.size > 0) {
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
	const name = getUserName(message);

	let characterId = null;
	let matchedRoll = null;

	// 1. Se informou um ID/slug de personagem ou número de slot diretamente como argumento
	if (args && args[0]) {
		const argVal = args[0].trim();
		if (/^[1-9]$/.test(argVal)) {
			const slotNum = parseInt(argVal, 10);
			let targetSlots = null;
			let quotedMsg = null;
			if (typeof message.origin?.getQuotedMessage === "function") {
				quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
			}
			if (quotedMsg) {
				const qId = quotedMsg.id?._serialized || quotedMsg.id?.id || quotedMsg.id;
				const rollData = getRollByMessageId(qId);
				if (rollData?.slots || rollData?.characters) {
					targetSlots = rollData.slots || rollData.characters;
				}
			}
			if (!targetSlots) {
				const pending = pendingClaims.get(groupId);
				if (pending?.slots || pending?.characters) {
					targetSlots = pending.slots || pending.characters;
				}
			}
			if (targetSlots) {
				const foundSlot = targetSlots.find((s) => s.slot === slotNum);
				if (foundSlot) {
					characterId = foundSlot.characterId;
					matchedRoll = foundSlot;
				}
			}
		} else if (/^[a-zA-Z0-9_-]+$/.test(argVal)) {
			characterId = argVal;
			matchedRoll =
				activeClaimsByCharGroup.get(`${groupId}:${characterId}`) ||
				(pendingClaims.get(groupId)?.characterId === characterId
					? pendingClaims.get(groupId)
					: null);
		}
	}

	// 2. Se a chamada foi disparada por uma reação (originReaction na mensagem de roll)
	if (!characterId && message.originReaction) {
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
			const match = text.match(/!mu-casar\s+([a-zA-Z0-9_-]+)/);
			if (match) {
				characterId = match[1];
				matchedRoll =
					activeClaimsByCharGroup.get(`${groupId}:${characterId}`) ||
					(pendingClaims.get(groupId)?.characterId === characterId
						? pendingClaims.get(groupId)
						: null);
			}
		}
	}

	// 3. Se a chamada citou uma mensagem (quotedMessage)
	if (!characterId) {
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
						matchedRoll = free[0];
					} else if (free.length > 1) {
						return new ReturnMessage({
							chatId,
							content:
								"⚠️ Há múltiplos personagens livres nesta rolagem citada! Reaja com o número do personagem (ex: 1️⃣, 2️⃣) ou use `!mu-casar <id>` ou `!mu-casar <número>`.",
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
				const match = text.match(/!mu-casar\s+([a-zA-Z0-9_-]+)/);
				if (match) {
					characterId = match[1];
					matchedRoll =
						activeClaimsByCharGroup.get(`${groupId}:${characterId}`) ||
						(pendingClaims.get(groupId)?.characterId === characterId
							? pendingClaims.get(groupId)
							: null);
				}
			}
		}
	}

	// 4. Fallback: busca na janela de claim mais recente do grupo
	if (!characterId) {
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
				matchedRoll = free[0];
			} else if (free.length > 1) {
				return new ReturnMessage({
					chatId,
					content:
						"⚠️ Há múltiplos personagens livres nesta rolagem! Reaja com o número do personagem (ex: 1️⃣, 2️⃣) ou use `!mu-casar <id>` ou `!mu-casar <número>`.",
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

	try {
		const { data } = await api.post("/marry", {
			userId,
			groupId,
			characterId,
			name,
			platform: "WHATSAPP"
		});

		pendingClaims.delete(groupId);
		activeClaimsByCharGroup.delete(`${groupId}:${characterId}`);
		const { character, keys, isSoulmate, kakeraBalance } = data.data;

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
	const rollData = getRollByMessageId(targetMsgId);
	if (!rollData) return false;

	const chatId = message.group ?? message.author;
	const groupId = getGroupId(message);
	const userId = getUserId(message);
	const name = getUserName(message);

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
		const { character, refundedKakera, keysLost, newKakeraBalance } = data.data;

		await removeMarriagePhoto(character.id || characterId).catch(() => {});

		let text = `💔 *Divórcio concluído!*\nVocê se separou de *${character.name}*.\n`;
		text += `💜 Reembolso: *+${refundedKakera} Zinthos* (perdidas ${keysLost} chaves)\n`;
		text += `💰 Novo saldo: *${newKakeraBalance} Zinthos*`;

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
	const name = getUserName(message);

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
	const name = getUserName(message);

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
 * Lista o harém do usuário de forma paginada
 */
async function verHarem(bot, message, args) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);

	const page =
		parseInt(
			args.find((a) => /^\d+$/.test(a)),
			10
		) || 1;
	const limit = 15;

	try {
		const { data } = await api.get(`/harem/${userId}`, {
			params: { page, limit, sort: "keys" }
		});

		const haremData = data.data;
		const entries = haremData.data || [];
		const total = haremData.total || 0;
		const totalPages = haremData.totalPages || 1;

		if (entries.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"👰 *Seu Harém está vazio!* Use *!mu-roll* para encontrar e casar com waifus e husbandos."
			});
		}

		let text = `👰 *Seu Harém* (Total: ${total} | Pág ${page}/${totalPages}):\n\n`;

		entries.forEach((item, index) => {
			const char = item.character;
			const pos = (page - 1) * limit + index + 1;
			const fav = item.isFavorite ? "⭐ " : "";
			const sm = item.keys >= 10 ? " 💖" : "";
			const emojiRarity = RARITY_EMOJI[char.baseRarity || char.rarity] || "⚪";

			text += `${pos}. ${fav}${emojiRarity} *${char.name}*${sm} — _${char.series}_\n`;
			text += `   ↳ ID: \`${char.id}\` | 🔑 *${item.keys}/10*\n`;
		});

		if (page < totalPages) {
			text += `\n_Digite \`!mu-harem ${page + 1}\` para a próxima página._`;
		}

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar harém.");
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

		const haremCount = user._count?.harem ?? 0;
		const soulmateCount = user._count?.soulmates ?? 0;
		const wishlistCount = user._count?.wishlist ?? 0;
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
				text += `  ${idx + 1}. *${f.name}* (${f.series || "Sem série"})\n`;
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
	const name = getUserName(message);

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
	const name = getUserName(message);

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
			text += `${idx + 1}. 💖 *${char.name}* — _${char.series}_\n`;
			if (sm.alias) text += `   ↳ Apelido: "${sm.alias}"\n`;
			if (sm.note) text += `   ↳ Nota: _${sm.note}_\n`;
		});

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao consultar soulmates.");
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
			const topHarem = data.data?.topHarem || [];

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
			const topRich = data.data?.topRich || [];

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

		const topRich = usersRes?.data?.data?.topRich || [];
		const topHarem = haremRes?.data?.data?.topHarem || [];

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
			params: { search, limit: 10 }
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
			const emojiRarity = RARITY_EMOJI[c.baseRarity || c.rarity] || "⚪";
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
 */
async function detalhesPersonagem(bot, message, args) {
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
	let otherResults = [];

	// 1. Se o termo não contiver espaços, tenta buscar direto por ID/slug exato
	if (!/\s/.test(query)) {
		try {
			const { data } = await api.get(`/characters/${encodeURIComponent(query)}`);
			if (data?.data) {
				char = data.data;
			}
		} catch (idErr) {
			// Se 404, não é erro crítico: prossegue normalmente para a busca ampla
			if (idErr.response?.status !== 404) {
				logger.debug(`[detalhesPersonagem] Falha na consulta por ID: ${idErr.message}`);
			}
		}
	}

	// 2. Se não encontrou por ID exato, executa busca ampla no catálogo
	if (!char) {
		try {
			const { data } = await api.get("/characters", {
				params: { search: query, limit: 6 }
			});
			const results = data.data?.data || [];
			if (results.length > 0) {
				const normQ = query.toLowerCase();
				// Prioridade inteligente:
				// 1) ID exato (case-insensitive)
				// 2) Nome exato (case-insensitive)
				// 3) Nome começando com a busca
				// 4) Primeiro resultado mais popular (ordenado por claimCount / likeCount desc na API)
				const exactId = results.find((c) => c.id?.toLowerCase() === normQ);
				const exactName = results.find((c) => c.name?.toLowerCase() === normQ);
				const startsName = results.find((c) => c.name?.toLowerCase().startsWith(normQ));
				char = exactId || exactName || startsName || results[0];
				otherResults = results.filter((c) => c.id !== char.id);
			}
		} catch (searchErr) {
			logger.error(`[detalhesPersonagem] Erro na busca ampla: ${searchErr.message}`);
		}
	}

	if (!char) {
		return new ReturnMessage({
			chatId,
			content: `🔍 Nenhum personagem encontrado para "${query}".\n\n💡 _Dica: Tente pesquisar por parte do nome, anime/série ou palavras da descrição com \`!mu-char <busca>\`._`
		});
	}

	try {
		const rarity = char.baseRarity || char.rarity || "COMMON";
		const emojiRarity = RARITY_EMOJI[rarity] || "⚪";
		const labelRarity = RARITY_LABEL[rarity] || rarity;

		let text = `👤 *${char.name}* (${char.series})\n`;
		text += `⭐ Raridade: ${emojiRarity} *${labelRarity}*\n`;
		text += `⚧ Gênero: *${char.gender === "FEMALE" ? "Feminino" : char.gender === "MALE" ? "Masculino" : "Outro"}*\n`;

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

		text += `💍 Total de casamentos: *${char.claimCount}*\n`;
		text += `❤️ Curtidas: *${char.likeCount}*\n`;

		if (char.description) {
			text += `\n📝 _${char.description}_\n`;
		}

		if (char.tags && char.tags.length > 0) {
			text += `🏷️ Tags: _${char.tags.join(", ")}_\n`;
		}

		text += `\n🆔 ID: \`${char.id}\``;

		// Se houver mais resultados correspondentes na busca ampla, lista como sugestão
		if (otherResults.length > 0) {
			const topOthers = otherResults.slice(0, 4);
			text += `\n\n🔍 *Outros resultados para "${query}":*\n`;
			topOthers.forEach((o) => {
				const oEmoji = RARITY_EMOJI[o.baseRarity || o.rarity] || "⚪";
				text += `• ${oEmoji} *${o.name}* (${o.series}) ➔ \`!mu-char ${o.id}\`\n`;
			});
			if (otherResults.length > 4) {
				text += `_... e mais ${otherResults.length - 4} encontrado(s). Use \`!mu-chars ${query}\` para ver todos._\n`;
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
				options: {
					caption: text
				}
			});
		}

		return new ReturnMessage({ chatId, content: text });
	} catch (err) {
		return handleApiError(err, chatId, "Erro ao formatar detalhes do personagem.");
	}
}

/**
 * Extrai o ID ou nome do personagem a partir do texto/legenda de uma mensagem de roll
 * @param {string} text
 * @returns {string|null}
 */
function extractCharacterFromRollText(text) {
	if (!text || typeof text !== "string") return null;

	// 1. Procura pelo comando de casamento na legenda: !mu-casar <slug>
	const matchCasar = text.match(/!mu-casar\s+([a-zA-Z0-9_-]+)/i);
	if (matchCasar && matchCasar[1]) {
		return matchCasar[1].trim();
	}

	// 2. Procura pelo cabeçalho: 🎲 *Nome* — _Serie_ ou 🎲 Nome — Serie
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
		(text.match(/[1-9](?:️⃣|\uFE0F?\u20E3)/g) || []).length > 1;

	if (!isMulti) return [];

	const lines = text.split("\n");
	const slots = [];
	let currentSlot = null;

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i].trim();
		if (!rawLine) continue;

		// Verifica se a linha indica um slot numerado: ex: 1️⃣ ⚪ [Comum] Nome — Serie
		const slotMatch = rawLine.match(
			/^([1-9])(?:️⃣|\uFE0F?\u20E3)\s*(?:[^\s[*]*\s*)?(?:\[([^\]]+)\]\s*)?\*?([^*\n—–-]+?)\*?\s*(?:[—–-]\s*([^\n(]+))?(?:\s*\((.*)\))?$/
		);

		if (slotMatch) {
			const slotNum = parseInt(slotMatch[1], 10);
			const labelRarity = slotMatch[2]?.trim() || "COMMON";
			const name = slotMatch[3]?.trim();
			let series = slotMatch[4]?.trim() || "";
			// Limpa markdown formatting
			series = series.replace(/^[*_~`]+|[*_~`]+$/g, "").trim();

			currentSlot = {
				slot: slotNum,
				characterName: name,
				series,
				rarity: labelRarity,
				characterId: null
			};
			slots.push(currentSlot);
			continue;
		}

		// Se for comando de casar: > !mu-casar <id>
		const casarMatch = rawLine.match(/^>?\s*!mu-casar\s+([a-zA-Z0-9_-]+)/i);
		if (casarMatch && currentSlot) {
			currentSlot.characterId = casarMatch[1].trim();
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
		const { roll, claim, daily } = data.data;

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

		text += claim.active
			? `💍 Casamento (Claim): ❌ Aguarde *${formatRemainingSeconds(claim.remainingSeconds)}*\n`
			: `💍 Casamento (Claim): ✅ *Disponível agora!*\n`;

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
		donorHeader += `> • 🔵 *Raro:* +${Math.round(donorTotal * 2.0)}% | 🟣 *Épico:* +${Math.round(donorTotal * 3.5)}% | ⭐ *Lendário:* +${Math.round(donorTotal * 4.5)}%\n`;
		if (donorBonuses.extraMaxRolls > 0) {
			donorHeader += `> • 🎟️ *Rolls Máximos:* ${9 + donorBonuses.extraMaxRolls} rolls (9 base + ${donorBonuses.extraMaxRolls} extras por doação)\n`;
		}
		if (donorBonuses.wishlistMultiplier) {
			const wishBonusPct = Math.round((donorBonuses.wishlistMultiplier - 1) * 100);
			donorHeader += `> • 🌟 *Wishlist:* +${wishBonusPct}% de peso em desejos!\n`;
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
			const singleWishChance =
				donorTotalWeight > 0 ? (Math.round(b.donorWeight * wishMult) / donorTotalWeight) * 100 : 0;
			const oneInX = catChance > 0 ? Math.round(100 / catChance) : null;
			const singleBaseOneInX = singleBaseChance > 0 ? Math.round(100 / singleBaseChance) : null;
			const singleWishOneInX = singleWishChance > 0 ? Math.round(100 / singleWishChance) : null;

			return {
				...b,
				baseWeight: b.donorWeight,
				categoryChance: catChance,
				singleBaseChance,
				singleWishChance,
				oneInX,
				singleBaseOneInX,
				singleWishOneInX
			};
		});
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

			text += `${emoji} *${label}* (${b.count.toLocaleString("pt-BR")} no banco | Peso ${b.baseWeight})\n`;
			text += `   ↳ Drop da categoria: *${catChanceStr}%* ${b.oneInX ? `(~1 a cada ${b.oneInX.toLocaleString("pt-BR")} rolls)` : ""}\n`;
			text += `   ↳ 1 específico (base): *${singleBaseStr}%* (1 em ${b.singleBaseOneInX?.toLocaleString("pt-BR") || "?"})\n`;
			const wishBonusLabel = donorBonuses?.wishlistMultiplier
				? `*+${Math.round((donorBonuses.wishlistMultiplier - 1) * 100)}%*`
				: `*+50%*`;
			text += `   ↳ Com Wishlist: *${singleWishStr}%* (${wishBonusLabel} | 1 em ${b.singleWishOneInX?.toLocaleString("pt-BR") || "?"})\n\n`;
		}
	} else {
		text += `⚪ *Comum:* ~93,30% (peso 100 | 1 específico: 0,0039%)\n`;
		text += `🟢 *Incomum:* ~5,59% (peso 60 | 1 específico: 0,0023%)\n`;
		text += `🔵 *Raro:* ~0,98% (peso 30 | 1 específico: 0,0012%)\n`;
		text += `🟣 *Épico:* ~0,13% (peso 15 | 1 específico: 0,0006%)\n`;
		text += `⭐ *Lendário:* ~0,011% (peso 5 | 1 específico: 0,0002%)\n\n`;
	}

	if (donorBonuses?.wishlistMultiplier) {
		const wishMultVal = donorBonuses.wishlistMultiplier.toFixed(1);
		const wishBonusPct = Math.round((donorBonuses.wishlistMultiplier - 1) * 100);
		text += `🌟 *Efeito da Wishlist (Até ${maxWl} Desejos) [BÔNUS VIP ATIVO]:*\n`;
		text += `• Cada personagem desejado tem o peso multiplicado por *${wishMultVal}x (+${wishBonusPct}%)*!\n`;
	} else {
		text += `🌟 *Efeito da Wishlist (Até ${maxWl} Desejos):*\n`;
		text += `• Cada personagem desejado tem o peso multiplicado por *1.5x (+50%)*.\n`;
		text += `• Se for marcado como Star Wish, o multiplicador é de *2.0x (+100%)*.\n`;
	}

	if (stats?.userWishlistStats && stats.userWishlistStats.count > 0) {
		let anyWishChance = stats.userWishlistStats.anyWishChance;
		if (donorBonuses?.wishlistMultiplier) {
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

	text += `💍 *2. Casamento (Claim)*\n`;
	text += `• Quando um personagem *livre* é rolado no grupo, abre-se uma janela de *300 segundos (5 minutos)*.\n`;
	text += `• O primeiro jogador a enviar \`!mu-casar\` (ou \`!mu-c\`) se casa com a waifu/husbando!\n`;
	text += `• O personagem passa a pertencer ao seu Harém global (em todos os grupos do bot).\n`;
	text += `• *Cooldown de casamento:* 2 horas.\n\n`;

	text += `🔑 *3. Chaves (Keys) & Soulmates*\n`;
	text += `• Se você rolar um personagem que *já pertence a você*, você ganha *+1 Chave (Key)*!\n`;
	text += `• Ao acumular *10 Chaves*, esse personagem é promovido a *💖 Soulmate definitivo*!\n`;
	text += `• Soulmates são seus parceiros eternos e podem receber apelidos e notas.\n\n`;

	text += `💜 *4. Economia Zinthos*\n`;
	text += `• *Zinthos (💜)* é a moeda oficial do jogo.\n`;
	text += `• Resgate sua recompensa diária (reseta todos os dias às 04:00) usando \`!mu-diario\`.\n`;
	text += `• Quando alguém rola um personagem que já é seu, um cristal de Zinthos é gerado com base no valor da sua waifu.\n`;
	text += `• Você também pode divorciar personagens com \`!mu-divorciar <id>\` para resgatar Zinthos proporcional à raridade e chaves.\n\n`;

	text += `🌟 *5. Lista de Desejos (Wishlist)*\n`;
	text += `• Adicione até *${WISHLIST_MAX_ITEMS}* personagens à sua wishlist com \`!mu-desejar <id>\`.\n`;
	text += `• *Bônus no Roll:* Cada personagem na sua lista ganha *+50% de peso* (multiplicador 1.5x) nos seus sorteios! (Star Wish ganha +100% / 2.0x).\n`;
	text += `• *Bônus de Zinthos Proporcional:* Cada waifu na Wishlist adiciona *+0,1% de Zinthos* em rolls e diários (+1/1000 por item), dobrando o valor adquirido (2.0x) ao atingir 1000 desejos!\n\n`;
	text += `❤️ *6. Curtidas (Likes)*\n`;
	text += `• Dê like nos seus personagens favoritos com \`!mu-like <id>\` para aumentar a popularidade global deles.\n\n`;

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
	text += `• \`!mu-divorciar <id>\` (aliases: \`!mu-div\`, \`!mu-d\`) — Divorcia um personagem e resgata Zinthos.\n`;
	text += `• \`!mu-harem [página]\` (aliases: \`!mu-h\`, \`!mu-colecao\`) — Lista todas as waifus/husbandos que você possui.\n`;
	text += `• \`!mu-favorito <id>\` (aliases: \`!mu-fav\`) — Alterna personagens favoritos em destaque (até 5 favoritas).\n`;
	text += `• \`!mu-soulmates\` (aliases: \`!mu-sm\`, \`!mu-almas\`) — Lista seus parceiros com 10+ chaves.\n\n`;

	text += `💰 *Economia & Perfil:*\n`;
	text += `• \`!mu-diario\` (aliases: \`!mu-daily\`, \`!mu-dz\`, \`!mu-dk\`) — Coleta sua recompensa diária de Zinthos.\n`;
	text += `• \`!mu-saldo\` (aliases: \`!mu-zinthos\`, \`!mu-z\`, \`!mu-k\`) — Consulta seu saldo atual de Zinthos.\n`;
	text += `• \`!mu-perfil\` (aliases: \`!mu-p\`, \`!mu-eu\`) — Exibe seu perfil de jogador, estatísticas e favorita.\n`;
	text += `• \`!mu-ranking [top]\` (aliases: \`!mu-top\`, \`!mu-rank\`) — Ranking dos jogadores mais ricos em Zinthos.\n`;
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
	text += `• \`!mu-share\` (alias: \`!mu-compartilhar\`) — Exibe o link público do seu harém para compartilhar com amigos.\n\n`;

	text += `🏷️ *Classificados & Mercado:*\n`;
	text += `• \`!mu-vender <id> <o que procura>\` (alias: \`!mu-anunciar\`) — Anuncia uma waifu do seu harém nos classificados globais.\n`;
	text += `• \`!mu-classificados\` — Lista as waifus disponíveis nos classificados globais.\n`;
	text += `• \`!mu-ofertas\` — Lista ofertas pendentes enviadas por outros jogadores para suas waifus.\n`;
	text += `• \`!mu-of-aceitar <id>\` — Aceita uma proposta de troca (transfere waifus, itens ou zinthos).\n`;
	text += `• \`!mu-of-negar <id>\` — Nega uma proposta de troca recebida.\n\n`;

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
				const base = new URL(WAIFULETES_WEB_URL);
				u.protocol = base.protocol;
				u.host = base.host;
				return u.toString();
			}
			return rawUrl;
		} catch {
			// Fallback para montagem direta
		}
	}
	const cleanPath = path ? (path.startsWith("/") ? path : `/${path}`) : "";
	return `${WAIFULETES_WEB_URL}${cleanPath}`;
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
	const userName = getUserName(message);

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
				await message.origin.react("🔗").catch(() => {});
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
 * Exibe o link público do harém do usuário para que ele compartilhe com amigos
 * @param {object} bot
 * @param {object} message
 * @returns {Promise<ReturnMessage>}
 */
async function compartilharHarem(bot, message) {
	const chatId = message.group ?? message.author;
	const userId = getUserId(message);
	const groupId = getGroupId(message);
	const userName = getUserName(message);

	try {
		await ensureUser(userId, groupId, userName);
		const { data } = await api.get(`/user/${userId}`);
		const user = data?.data || {};

		const publicId = user.publicId;
		const publicUrl = formatWebUrl(user.publicUrl, publicId ? `/user/${publicId}` : "");

		const haremCount = user.haremCount ?? user._count?.harem ?? 0;
		const soulmateCount = user.soulmateCount ?? user._count?.soulmates ?? 0;
		const wishlistCount = user.wishlistCount ?? user._count?.wishlist ?? 0;
		const favoriteChar = user.favoriteCharacter || user.harem?.[0]?.character;

		const favoriteChars =
			user.favoriteCharacters ||
			(user.harem
				? user.harem.filter((h) => h.isFavorite).map((h) => h.character)
				: favoriteChar
					? [favoriteChar]
					: []);

		let text = `✨ *Harém de ${user.name || userName} — Waifuletes* ✨\n\n`;
		text += `Acesse a vitrine pública de personagens no catálogo web:\n`;
		text += `🔗 ${publicUrl}\n\n`;
		text += `👰 *Colecionados:* ${haremCount} waifus/husbandos\n`;
		text += `💖 *Soulmates:* ${soulmateCount}\n`;
		text += `🌟 *Wishlist:* ${wishlistCount}/${WISHLIST_MAX_ITEMS}\n`;
		if (favoriteChars.length > 0) {
			text += `💖 *Favoritas em Destaque (${favoriteChars.length}/5):*\n`;
			favoriteChars.forEach((f, idx) => {
				text += `  ${idx + 1}. *${f.name}* (${f.series || "Sem série"})\n`;
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
	const userName = getUserName(message);

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
				if (Array.isArray(offered.farmItems) && offered.farmItems.length > 0)
					parts.push(`${offered.farmItems.length} item(ns) de fazenda`);
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

// ─── Registro dos Comandos e Aliases (Padrão Stickers.js) ───────────────────

const commands = [
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
		name: "mu-colecao",
		description: "Alias de !mu-harem",
		category: "mudae",
		group: "muwaifu-harem",
		reactions: { before: "👰", after: "✅", error: "❌" },
		reply: true,
		method: verHarem
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
		aliases: ["muclassificados", "mu-mercado", "mumercado"],
		reactions: { before: "🛍️", after: "✅", error: "❌" },
		reply: true,
		method: listarClassificadosCmd
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
			desc: "Lista os personagens que você possui em seu harém",
			usage: ["!mu-harem", "!mu-h 2"],
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
			if (bot.grupoAvisos) targetChats.push(bot.grupoAvisos);
			if (targetChats.length === 0 && bot.grupoLogs) {
				targetChats.push(bot.grupoLogs);
			}
			if (targetChats.length === 0) {
				if (process.env.GRUPO_ANUNCIOS && process.env.GRUPO_ANUNCIOS.trim()) {
					targetChats.push(process.env.GRUPO_ANUNCIOS.trim());
				}
				if (process.env.GRUPO_AVISOS && process.env.GRUPO_AVISOS.trim()) {
					targetChats.push(process.env.GRUPO_AVISOS.trim());
				}
			}
		} else {
			if (process.env.GRUPO_ANUNCIOS && process.env.GRUPO_ANUNCIOS.trim()) {
				targetChats.push(process.env.GRUPO_ANUNCIOS.trim());
			}
			if (process.env.GRUPO_AVISOS && process.env.GRUPO_AVISOS.trim()) {
				targetChats.push(process.env.GRUPO_AVISOS.trim());
			}
		}

		if (targetChats.length === 0) {
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

		for (const targetChat of targetChats) {
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

		return sentAny;
	} catch (err) {
		logger.error("Erro ao notificar casamento especial:", err);
		return false;
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
	consultarOuGerarFotoCasamento,
	divorciarWaifu,
	likeWaifu,
	diariosKakera,
	saldoKakera,
	verHarem,
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
	activeClaimsByCharGroup,
	EXCLUSIVE_CLAIM_WINDOW_MS,
	EXCLUSIVE_CLAIM_WINDOWS,
	getExclusiveClaimWindowMs,
	NUMBER_EMOJIS,
	buildRollGridImage,
	downloadImageBuffer,
	processWaifuReaction,
	recordRollMessage,
	getRollByMessageId,
	getMultiRollByMessageId,
	getCharacterIdFromMessageId,
	extractCharacterFromRollText,
	extractMultiRollSlotsFromText,
	processMultiRollReport,
	multiRollHistoryByMsgId,
	notifySpecialMarriage,
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
	negarOfertaCmd
};
