/**
 * FazendaCommands.js
 *
 * Módulo de comandos para o minigame "Jardim das Sombras" (Fazenda).
 * Todos os comandos pertencem à categoria 'jogos'.
 */

const sharp = require("sharp");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const Logger = require("../utils/Logger");
const { resolveMentionName } = require("../utils/ProfilePictureHelper");
const ShadowGardenClient = require("../services/ShadowGardenClient");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
const Database = require("../utils/Database");
const GameEventService = require("../services/GameEventService");
const PvSafetyService = require("../services/PvSafetyService");
const {
	editInteractiveMenuMessage,
	formatMenuCommand
} = require("../utils/InteractiveButtonsHelper");

const logger = new Logger("fazenda-commands");
const jardimClient = new ShadowGardenClient();
const database = Database.getInstance();
const DB_FAZENDA = "fazenda";

// Inicializa banco para snapshots semanais e carrinho de compras da fazenda
database.getSQLiteDb(
	DB_FAZENDA,
	`
  CREATE TABLE IF NOT EXISTS fazenda_player_snapshots (
    player_id TEXT NOT NULL,
    total_planted INTEGER NOT NULL DEFAULT 0,
    total_harvested INTEGER NOT NULL DEFAULT 0,
    total_withered INTEGER NOT NULL DEFAULT 0,
    coins INTEGER NOT NULL DEFAULT 0,
    snapshot_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, snapshot_at)
  );
  CREATE INDEX IF NOT EXISTS idx_fazenda_snapshot_time ON fazenda_player_snapshots(snapshot_at);
  CREATE TABLE IF NOT EXISTS fazenda_cart_items (
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_name TEXT,
    item_type TEXT,
    item_index INTEGER,
    quantity INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );
`
);

// Mapeamento amigável de nomes de plantas
const PLANT_NAMES = {
	"01_nightshade": "Erva-Moura",
	"02_tomb_shroom": "Cogumelo Tumular",
	"03_corpse_lily": "Lírio Cadáver",
	"04_black_lotus": "Lótus Negra",
	"05_mist_crawler_v2": "Rastejante de Névoa",
	"06_styx_kelp_v2": "Alga do Estige",
	"07_spectral_gourd_v2": "Cabaça Espectral",
	"08_devouring_root_v2": "Raiz Devoradora",
	"09_obsidian_clover": "Trevo de Obsidiana",
	"10_golden_clover": "Trevo Dourado",
	"11_purple_heart": "Coração Púrpuro",
	"12_blood_rose": "Rosa de Sangue"
};

// Regex para detecção de emojis Unicode
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

/**
 * Normaliza o ID do usuário (apenas dígitos)
 * @param {Object} message
 * @returns {string}
 */
function getUserId(message) {
	const raw = message.author || message.from || "";
	return String(raw).replace(/\D/g, "");
}

/**
 * Normaliza o ID do chat/conversa
 * @param {Object} message
 * @returns {string}
 */
function getChatId(message) {
	return message.group || message.author || message.from;
}

/**
 * Verifica se a mensagem veio de um chat privado (PV)
 * @param {Object} message
 * @returns {boolean}
 */
function isPrivateChat(message) {
	return !message.group;
}

/**
 * Extrai texto dos argumentos da mensagem
 * @param {Object} message
 * @returns {string}
 */
function getArgsText(message) {
	const parts = (message.content || "").trim().split(/\s+/);
	parts.shift(); // Remove o comando
	return parts.join(" ").trim();
}

/**
 * Obtém o nome ou apelido de exibição do usuário (respeitando apelido no grupo se definido)
 * @param {Object} bot
 * @param {Object} message
 * @param {Object} [group]
 * @returns {Promise<string>}
 */
async function getUserDisplayName(bot, message, group) {
	const userJid = message.author || message.from || "";
	const numDigits = userJid.split("@")[0].replace(/\D/g, "");
	let targetGroup = group;
	if (!targetGroup && message.group && bot?.groups) {
		targetGroup = bot.groups[message.group];
	}

	// 1. Apelido configurado no grupo (group.nicks) - imediato em memória
	if (targetGroup?.nicks && Array.isArray(targetGroup.nicks)) {
		const nickData = targetGroup.nicks.find((n) => {
			if (!n?.numero) return false;
			const nStr = String(n.numero);
			const nDigits = nStr.split("@")[0].replace(/\D/g, "");
			return nStr === userJid || (numDigits && nDigits === numDigits);
		});
		if (nickData?.apelido && nickData.apelido.trim()) {
			return nickData.apelido.trim();
		}
	}

	// 2. Nome push que já veio na mensagem do WhatsApp - imediato em memória
	const fallback = message.authorName || message.pushName || message.name;
	if (fallback && typeof fallback === "string" && fallback.trim()) {
		return fallback.trim();
	}

	// 3. Fallback assíncrono caso nenhum dos anteriores exista
	try {
		const name = await resolveMentionName(bot, userJid, targetGroup);
		if (name && typeof name === "string" && name.trim()) {
			return name.trim();
		}
	} catch (err) {
		logger.debug(`[getUserDisplayName] Erro ao resolver nome: ${err.message}`);
	}

	return "Cultivador";
}

let cachedTexts = null;
let lastTextsFetchTime = 0;
const TEXTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

/**
 * Obtém os textos e emoji do jogo configurados, com cache em memória
 * @returns {Promise<{ name: string, emoji: string }>}
 */
async function getGameTexts() {
	const now = Date.now();
	if (cachedTexts && now - lastTextsFetchTime < TEXTS_CACHE_TTL) {
		return cachedTexts;
	}
	try {
		const texts = await jardimClient.getTexts();
		if (texts && texts.gameName) {
			cachedTexts = {
				name: texts.gameName,
				emoji: texts.gameEmoji || "🦇"
			};
			lastTextsFetchTime = now;
			return cachedTexts;
		}
	} catch (err) {
		logger.warn(`[getGameTexts] Falha ao obter textos da API: ${err.message}`);
	}
	return cachedTexts || { name: "Jardim Lutoso", emoji: "🦇" };
}

const farmMessageTracker = new Map();
const FARM_EDIT_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutos

const invMessageTracker = new Map();
const INV_EDIT_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutos

function getFarmTrackerKey(chatId, userId) {
	return `${chatId}:${userId}`;
}

function recordFarmMessage(chatId, userId, messageId) {
	if (!chatId || !userId || !messageId) return;
	farmMessageTracker.set(getFarmTrackerKey(chatId, userId), {
		messageId,
		timestamp: Date.now()
	});
}

function getActiveFarmMessageId(chatId, userId) {
	const key = getFarmTrackerKey(chatId, userId);
	const entry = farmMessageTracker.get(key);
	if (!entry) return null;
	if (Date.now() - entry.timestamp > FARM_EDIT_MAX_AGE_MS) {
		farmMessageTracker.delete(key);
		return null;
	}
	return entry.messageId;
}

function recordInvMessage(chatId, userId, messageId) {
	if (!chatId || !userId || !messageId) return;
	invMessageTracker.set(getFarmTrackerKey(chatId, userId), {
		messageId,
		timestamp: Date.now()
	});
}

function getActiveInvMessageId(chatId, userId) {
	const key = getFarmTrackerKey(chatId, userId);
	const entry = invMessageTracker.get(key);
	if (!entry) return null;
	if (Date.now() - entry.timestamp > INV_EDIT_MAX_AGE_MS) {
		invMessageTracker.delete(key);
		return null;
	}
	return entry.messageId;
}

/**
 * Constrói os botões padrão da visualização da fazenda no Telegram
 * (Colheita condicional se houver canteiros prontos/secos + Loja e Mochila sempre presentes)
 * @param {boolean} canHarvest
 * @param {number} readyCount
 * @returns {Array<Array<Object>>}
 */
function buildFarmViewButtons(canHarvest = false, readyCount = 0) {
	const buttons = [];
	if (canHarvest) {
		buttons.push([
			{
				text: `🌾 Colher Tudo${readyCount > 0 ? ` (${readyCount})` : ""}`,
				action: "/faz-colher"
			}
		]);
	}
	buttons.push([
		{ text: "🔄 Atualizar", action: "/fazenda" },
		{ text: "🛒 Loja", action: "/faz-loja" },
		{ text: "🎒 Mochila", action: "/faz-inv" }
	]);
	return buttons;
}

/**
 * Cria uma instância de ReturnMessage com citação (reply) à mensagem de origem
 * @param {string} chatId
 * @param {string|Object} content
 * @param {Object} message
 * @param {Object} [extraOptions={}]
 * @returns {ReturnMessage}
 */
function replyReturnMessage(chatId, content, message, extraOptions = {}) {
	const options = {
		...(message?.origin?.id?._serialized && { quotedMessageId: message.origin.id._serialized }),
		...(message?.origin && { goReply: message.origin }),
		...extraOptions
	};
	return new ReturnMessage({
		chatId,
		content,
		options,
		telegram: extraOptions.telegram || options.telegram,
		buttons: extraOptions.buttons || options.buttons
	});
}

/**
 * Formata os buffs ativos do jogador em texto legível e sem repetições
 * @param {Object|Array} buffsData
 * @returns {string|null}
 */
function formatActiveBuffs(buffsData) {
	if (!buffsData) return null;

	const parts = [];

	if (buffsData.effectiveCoinMultiplier && buffsData.effectiveCoinMultiplier > 1.0) {
		parts.push(`💰 Petalitas ${buffsData.effectiveCoinMultiplier}x`);
	}
	if (buffsData.effectiveGrowthMultiplier && buffsData.effectiveGrowthMultiplier < 1.0) {
		const pct = Math.round((1.0 - buffsData.effectiveGrowthMultiplier) * 100);
		parts.push(`⚡ Crescimento +${pct}%`);
	}
	if (buffsData.witherFrozen) {
		parts.push(`❄️ Imunidade a Murcha`);
	}
	if (buffsData.dailyLuckMultiplier && buffsData.dailyLuckMultiplier > 1.0) {
		parts.push(`🍀 Sorte da Sacola ${buffsData.dailyLuckMultiplier}x`);
	} else if (buffsData.dailySpecialItemBonus && buffsData.dailySpecialItemBonus > 0) {
		parts.push(`🍀 Sorte da Sacola +${Math.round(buffsData.dailySpecialItemBonus * 100)}%`);
	}

	if (parts.length === 0) {
		const list = Array.isArray(buffsData) ? buffsData : buffsData.activeBuffs || [];

		if (!Array.isArray(list) || list.length === 0) return null;

		const typeLabels = {
			coin_multiplier: "💰 Bônus de Petalitas",
			coin_factor: "💰 Multiplicador de Petalitas",
			growth_speed: "⚡ Velocidade de Crescimento",
			growth_reduction: "⚡ Redução de Tempo",
			growth_factor: "⚡ Aceleração do Vazio",
			growth_halve: "⚡ Crescimento Acelerado (Metade do Tempo)",
			wither_freeze: "❄️ Imunidade a Murcha",
			daily_luck: "🍀 Sorte da Sacola Diária",
			daily_bag_bonus: "🍀 Chance de Itens Especiais",
			daily_bag_luck: "🍀 Sorte Dupla Diária"
		};

		const seen = new Set();
		list.forEach((b) => {
			const type = typeof b === "string" ? b : b.type;
			if (!type || seen.has(type)) return;
			seen.add(type);
			const label = typeLabels[type] || `✨ ${type.replace(/_/g, " ")}`;
			parts.push(label);
		});
	}

	return parts.length > 0 ? parts.join(" | ") : null;
}

/**
 * Formata segundos restantes de forma amigável
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatRemainingTime(totalSeconds) {
	if (!totalSeconds || totalSeconds <= 0) return "pronto para colheita";
	const mins = Math.floor(totalSeconds / 60);
	const secs = totalSeconds % 60;
	if (mins >= 60) {
		const hours = Math.floor(mins / 60);
		const remMins = mins % 60;
		return `${hours}h ${remMins}m`;
	}
	return `${mins}m ${secs}s`;
}

/**
 * Formata duração em segundos de forma compacta (ex: 15m, 1h, 1h30m, 4h)
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatTimeSeconds(totalSeconds) {
	if (!totalSeconds || totalSeconds <= 0) return "";
	const hours = Math.floor(totalSeconds / 3600);
	const mins = Math.floor((totalSeconds % 3600) / 60);
	if (hours > 0 && mins > 0) return `${hours}h${mins}m`;
	if (hours > 0) return `${hours}h`;
	return `${mins}m`;
}

const HQ_FLAGS = new Set(["hd", "hq", "alta", "web", "full", "1024"]);

/**
 * Extrai flags de alta qualidade de uma lista de argumentos
 * @param {string[]} argsArray
 * @returns {{ isHighQuality: boolean, remainingArgs: string[] }}
 */
function extractQualityFlag(argsArray) {
	let isHighQuality = false;
	const remainingArgs = [];
	for (const arg of argsArray) {
		const clean = arg.toLowerCase().trim();
		if (HQ_FLAGS.has(clean)) {
			isHighQuality = true;
		} else {
			remainingArgs.push(arg);
		}
	}
	return { isHighQuality, remainingArgs };
}

/**
 * Otimiza a imagem da fazenda para envio rápido no WhatsApp
 * Reduz de 1024x1024 (~335KB) para 800x800 (~130KB), a menos que solicitada em alta resolução
 * @param {Buffer} imageBuffer - Buffer original da imagem 1024x1024
 * @param {boolean} [isHighQuality=false] - Se true, preserva a resolução nativa 1024x1024
 * @returns {Promise<Buffer>}
 */
async function optimizeFarmImage(imageBuffer, isHighQuality = false) {
	if (!imageBuffer || isHighQuality) {
		return imageBuffer;
	}
	try {
		return await sharp(imageBuffer)
			.resize(800, 800, { fit: "contain" })
			.jpeg({ quality: 75, mozjpeg: true })
			.toBuffer();
	} catch (err) {
		logger.warn(`[optimizeFarmImage] Falha ao otimizar imagem: ${err.message}`);
		return imageBuffer;
	}
}

/**
 * Converte emoji para string única em maiúsculas (ex: "1f332")
 * @param {string} emojiStr
 * @returns {string}
 */
function emojiToCodePoints(emojiStr) {
	return Array.from(emojiStr)
		.map((char) => char.codePointAt(0).toString(16).toLowerCase())
		.join("-");
}

/**
 * Detecta o primeiro emoji em uma imagem via renderização e comparação de pixels com Sharp
 * @param {Buffer} userImageBuffer
 * @returns {Promise<{ x: number, y: number, percentX: number, percentY: number } | null>}
 */
async function detectMarkerCoords(userImageBuffer, baseImageBuffer) {
	try {
		const targetSize = 256;
		const [userRaw, baseRaw] = await Promise.all([
			sharp(userImageBuffer)
				.resize(targetSize, targetSize, { fit: "fill" })
				.removeAlpha()
				.raw()
				.toBuffer(),
			sharp(baseImageBuffer)
				.resize(targetSize, targetSize, { fit: "fill" })
				.removeAlpha()
				.raw()
				.toBuffer()
		]);

		let sumDiff = 0;
		let weightedX = 0;
		let weightedY = 0;
		const threshold = 40; // Sensibilidade de diferença por canal RGB

		for (let y = 0; y < targetSize; y++) {
			for (let x = 0; x < targetSize; x++) {
				const idx = (y * targetSize + x) * 3;
				const dr = Math.abs(userRaw[idx] - baseRaw[idx]);
				const dg = Math.abs(userRaw[idx + 1] - baseRaw[idx + 1]);
				const db = Math.abs(userRaw[idx + 2] - baseRaw[idx + 2]);
				const diff = (dr + dg + db) / 3;

				if (diff > threshold) {
					sumDiff += diff;
					weightedX += x * diff;
					weightedY += y * diff;
				}
			}
		}

		if (sumDiff > 100) {
			const centroidX = weightedX / sumDiff;
			const centroidY = weightedY / sumDiff;
			const finalX = Math.round((centroidX / targetSize) * 1024);
			const finalY = Math.round((centroidY / targetSize) * 1024);
			return {
				x: Math.min(1000, Math.max(24, finalX)),
				y: Math.min(1000, Math.max(24, finalY)),
				percentX: Number((centroidX / targetSize).toFixed(3)),
				percentY: Number((centroidY / targetSize).toFixed(3))
			};
		}
	} catch (err) {
		logger.warn(`[detectMarkerCoords] Falha ao comparar imagens com Sharp: ${err.message}`);
	}
	return null;
}

// ─── HELPERS EXPORTADOS PARA OUTROS MÓDULOS (WAIFUS) ─────────────────────────

/**
 * Retorna se o usuário possui roll ou ticket bônus da fazenda acumulado
 * @param {string} userId
 * @returns {Promise<{ hasBonus: boolean, rolls: number, tickets: number }>}
 */
async function getFarmWaifuRollBonus(userId) {
	const bonus = await ShadowGardenBonusService.getWaifuBonus(userId);
	return {
		hasBonus: (bonus.rolls || 0) > 0 || (bonus.tickets || 0) > 0,
		rolls: bonus.rolls || 0,
		tickets: bonus.tickets || 0
	};
}

/**
 * Consome 1 roll ou ticket bônus da fazenda do usuário
 * @param {string} userId
 * @returns {Promise<{ consumed: boolean, type?: 'ticket' | 'roll', remainingRolls: number, remainingTickets: number }>}
 */
async function consumeFarmWaifuRoll(userId) {
	return await ShadowGardenBonusService.consumeWaifuBonus(userId);
}

// ─── HANDLERS DE COMANDOS DA FAZENDA ─────────────────────────────────────────

/**
 * Tenta coletar o bônus diário da Fazenda (Sacola do Coveiro) para o usuário
 * @param {string} userId
 * @returns {Promise<Object|null>} Resultado se coletado nesta chamada, ou null
 */
async function tryClaimFarmDaily(userId) {
	if (!userId) return null;
	try {
		const claimRes = await jardimClient.claimDaily(userId);
		if (claimRes && claimRes.claimed) {
			return claimRes;
		}
	} catch (claimErr) {
		logger.debug(`[tryClaimFarmDaily] Tentativa de claim daily: ${claimErr.message}`);
	}
	return null;
}

/**
 * Monta a ReturnMessage da recompensa diária coletada (incluindo bônus de evento Fortuna)
 * @param {string} userId
 * @param {string} chatId
 * @param {Object} message
 * @param {Object} dailyClaimResult
 * @returns {Promise<ReturnMessage>}
 */
async function buildDailyRewardReturnMessage(userId, chatId, message, dailyClaimResult) {
	const eventFortuneMult = GameEventService.getMultiplier("fazenda", "fortuna");
	let extraFortuneCoins = 0;
	if (eventFortuneMult > 1.0 && (dailyClaimResult.coinsWon || 0) > 0) {
		extraFortuneCoins = Math.round(dailyClaimResult.coinsWon * (eventFortuneMult - 1));
		if (extraFortuneCoins > 0) {
			try {
				await jardimClient.adminGive(userId, {
					coins: extraFortuneCoins,
					reason: "evento_fortuna"
				});
			} catch (e) {
				logger.warn(
					`[buildDailyRewardReturnMessage] Falha ao creditar bônus fortuna no diário: ${e.message}`
				);
			}
		}
	}

	let dailyText = `🎁 *SACOLA DO COVEIRO RESGATADA!* 🎁\n\n`;
	dailyText += `Você abriu sua sacola diária e encontrou:\n`;
	dailyText += `• *+${(dailyClaimResult.coinsWon || 0).toLocaleString("pt-BR")} Petalitas*`;
	if (extraFortuneCoins > 0) {
		dailyText += ` _(+${extraFortuneCoins} bônus do evento Fortuna! 💰)_\n`;
	} else {
		dailyText += `\n`;
	}
	if (dailyClaimResult.itemsWon?.length > 0) {
		dailyClaimResult.itemsWon.forEach((it) => {
			dailyText += `• *${it.name || it.itemId}* (x${it.count || 1})\n`;
		});
	}
	dailyText += `\nVolte amanhã para resgatar novamente!`;

	return replyReturnMessage(chatId, dailyText, message);
}

/**
 * Envolve qualquer handler da Fazenda para coletar automaticamente o bônus diário antes da execução
 * @param {Function} handler
 * @returns {Function}
 */
function withAutoDailyClaim(handler) {
	return async function wrappedFazendaCommand(bot, message, args, group) {
		const userId = getUserId(message);
		const chatId = getChatId(message);
		const dailyClaimResult = await tryClaimFarmDaily(userId);

		const result = await handler(bot, message, args, group);
		if (!dailyClaimResult) {
			return result;
		}

		const dailyMsg = await buildDailyRewardReturnMessage(userId, chatId, message, dailyClaimResult);
		if (Array.isArray(result)) {
			return [...result, dailyMsg];
		}
		if (result) {
			return [result, dailyMsg];
		}
		return dailyMsg;
	};
}

/**
 * !fazenda: Visualiza a fazenda atual com imagem 1024x1024, resgata diário se disponível
 */
async function handleFazenda(bot, message, _args, group) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const inPrivate = isPrivateChat(message);

	const rawArgs = getArgsText(message).split(/\s+/).filter(Boolean);
	const { isHighQuality } = extractQualityFlag(rawArgs);
	const wantsHq = isHighQuality || rawArgs.some((a) => a.toLowerCase().trim() === "max");

	try {
		// 1. Busca status da fazenda, textos configurados e nome do usuário em paralelo
		const [status, { name: gameName, emoji: gameEmoji }, userName] = await Promise.all([
			jardimClient.getStatus(userId),
			getGameTexts(),
			getUserDisplayName(bot, message, group)
		]);

		// 3. Credita bônus pendentes das colheitas (totais cumulativos reportados pela API
		// do Jardim). Cobre também as colheitas feitas no painel web (!faz-adm), que nunca
		// passam pelo bot, e não depende do estoque — vender antes não come bônus.
		let bonusMsgs = [];
		try {
			bonusMsgs = await ShadowGardenBonusService.reconcileHarvestBonus(userId);
		} catch (syncErr) {
			logger.warn(`[handleFazenda] Falha ao reconciliar bônus de colheita: ${syncErr.message}`);
		}

		// 4. Tenta renderizar imagem (se falhar, envia mensagem de texto sem derrubar o comando)
		let imageBuffer = null;
		try {
			imageBuffer = await jardimClient.getImageBuffer(userId, true, { userName });
		} catch (imgErr) {
			logger.warn(
				`[handleFazenda] Não foi possível renderizar imagem da fazenda: ${imgErr.message}`
			);
		}

		// 4. Monta o texto de status
		const plots = status.slots || [];
		let readyCount = 0;
		let growingCount = 0;
		let dryCount = 0;
		let emptyCount = 0;

		plots.forEach((p) => {
			if (p.stage === "harvestable" || p.stage === "ready") readyCount++;
			else if (p.stage === "growing") growingCount++;
			else if (p.stage === "withered") dryCount++;
			else emptyCount++;
		});

		const farmTitle = status.farmName
			? `${gameEmoji} *${status.farmName.toUpperCase()}* ${gameEmoji}`
			: `${gameEmoji} *${gameName.toUpperCase()}* ${gameEmoji}`;
		let text = `${farmTitle}\n\n`;
		text += `💰 *Petalitas:* ${(status.coins ?? 0).toLocaleString("pt-BR")} Ptl\n`;
		text += `🌾 *Canteiros (9):* ${readyCount} prontos | ${growingCount} crescendo | ${dryCount} secos | ${emptyCount} livres\n`;

		const buffsFormatted = formatActiveBuffs(status.buffs);
		if (buffsFormatted) {
			text += `✨ *Buffs Ativos:* ${buffsFormatted}\n`;
		}

		if (bonusMsgs.length > 0) {
			text += `\n🎁 *BÔNUS DAS SUAS COLHEITAS:*\n${bonusMsgs.join("\n")}\n`;
		}

		text += `\n📖 *Comandos Rápidos:* \`!faz-colheita\`, \`!faz-plantar\`, \`!faz-loja\`, \`!faz-inv\``;

		// Link público da fazenda
		const shareUrl =
			status.shareUrl || (status.uuid ? `https://jds.moothz.com/farm?id=${status.uuid}` : null);
		if (shareUrl) {
			text += `\n\n🌐 *Ver Fazenda Online:* ${shareUrl}`;
		}

		if (wantsHq) {
			text += `\n📸 *Qualidade:* Alta Resolução (1024x1024)`;
		}

		if (inPrivate) {
			try {
				const adminRes = await jardimClient.getAdminUrl(userId);
				const adminUrl = typeof adminRes === "object" ? adminRes.url || adminRes.link : adminRes;
				if (adminUrl) {
					text += `\n\n🔐 *Acesso ao Farm Admin:* ${adminUrl}`;
				}
			} catch (admErr) {
				logger.warn(`[handleFazenda] Falha ao obter admin-url no PV: ${admErr.message}`);
			}
		} else {
			text += `\n\n💡 _Dica: Digite \`!faz-adm\` para receber o link do Farm Admin no seu privado!_`;
		}

		const eventBanner = GameEventService.getEventBanner("fazenda");
		if (eventBanner) {
			text += eventBanner;
		}

		const canHarvest = readyCount > 0 || dryCount > 0;
		const farmButtons = buildFarmViewButtons(canHarvest, readyCount);

		let activeFarmId = null;
		if (bot && bot.useTelegram) {
			activeFarmId = getActiveFarmMessageId(chatId, userId);
		}

		const farmOptions = {
			farmData: { userId },
			telegram: {
				editMessageId: activeFarmId || null,
				buttons: farmButtons
			},
			...(canHarvest ? { reaction: "🌾" } : {})
		};

		const returns = [];

		// Envia a imagem com a legenda principal se tiver, ou apenas texto se falhou a imagem
		if (imageBuffer) {
			const finalBuffer = await optimizeFarmImage(imageBuffer, wantsHq);
			returns.push(
				replyReturnMessage(
					chatId,
					{
						mimetype: "image/jpeg",
						data: finalBuffer.toString("base64"),
						filename: `fazenda-${userId}.jpg`,
						isMessageMedia: true
					},
					message,
					{
						caption: text,
						...farmOptions
					}
				)
			);
		} else {
			returns.push(replyReturnMessage(chatId, text, message, farmOptions));
		}

		return returns;
	} catch (err) {
		logger.error(`[handleFazenda] Erro ao carregar fazenda: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao acessar o Jardim: ${err.message}`, message);
	}
}

/**
 * !faz-adm: Envia link de acesso ao painel Farm Admin
 */
async function handleFazAdm(bot, message) {
	const userId = getUserId(message);
	const inPrivate = isPrivateChat(message);

	if (!inPrivate) {
		const pvCheck = await PvSafetyService.getInstance().ensureGroupPvAllowed(bot, message);
		if (!pvCheck.allowed) {
			return pvCheck.returnMessage;
		}
	}

	try {
		const adminRes = await jardimClient.getAdminUrl(userId);
		const adminUrl = typeof adminRes === "object" ? adminRes.url || adminRes.link : adminRes;
		const content = `🔐 *PAINEL FARM ADMIN* 🔐\n\nAcesse sua fazenda interativa pelo navegador:\n${adminUrl}\n\n⚠️ _Este link é pessoal e temporário. Não compartilhe com terceiros!_`;

		if (inPrivate) {
			return replyReturnMessage(message.author, content, message);
		}

		// Se enviado em grupo, despacha o link no PV e apenas reage à mensagem no grupo
		await bot.sendReturnMessages([
			new ReturnMessage({
				chatId: message.author,
				content
			})
		]);

		try {
			if (message.origin && typeof message.origin.react === "function") {
				await message.origin.react("📨");
			}
		} catch (reactErr) {
			logger.debug(`[handleFazAdm] Não foi possível reagir à mensagem: ${reactErr.message}`);
		}

		return null;
	} catch (err) {
		logger.error(`[handleFazAdm] Erro ao gerar admin url: ${err.message}`);
		return replyReturnMessage(
			getChatId(message),
			`❌ Não foi possível gerar seu link de acesso: ${err.message}`,
			message
		);
	}
}

/**
 * !faz-nome: Define ou exibe o nome personalizado do seu jardim (máx 20 caracteres)
 */
async function handleFazNome(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const rawArgs = getArgsText(message).trim();

	// Sem argumentos: consulta o nome atual
	if (!rawArgs) {
		try {
			const status = await jardimClient.getStatus(userId);
			const currentName = status.farmName;
			if (currentName) {
				return replyReturnMessage(
					chatId,
					`🌱 Seu jardim se chama *${currentName}*.\nPara alterar, use: \`!faz-nome <novo nome>\` (máx 20 caracteres)\nPara restaurar o padrão: \`!faz-nome reset\``,
					message
				);
			} else {
				return replyReturnMessage(
					chatId,
					`🌱 Seu jardim ainda não possui um nome personalizado.\nDefina usando: \`!faz-nome <nome>\` (máx 20 caracteres)`,
					message
				);
			}
		} catch (err) {
			logger.error(`[handleFazNome] Erro ao consultar nome: ${err.message}`);
			return replyReturnMessage(
				chatId,
				`❌ Erro ao consultar nome da fazenda: ${err.message}`,
				message
			);
		}
	}

	const isReset = /^(reset|padrao|padrão|limpar|remover)$/i.test(rawArgs);
	const newName = isReset ? null : rawArgs;

	if (newName && newName.length > 20) {
		return replyReturnMessage(
			chatId,
			`❌ O nome da fazenda deve ter no máximo 20 caracteres! (O seu tem ${newName.length})`,
			message
		);
	}

	try {
		await jardimClient.updateFarmName(userId, newName);
		if (isReset) {
			return replyReturnMessage(
				chatId,
				`🌱 O nome do seu jardim foi restaurado para o padrão (*Jardim das Sombras*)!`,
				message
			);
		} else {
			return replyReturnMessage(
				chatId,
				`🌱 O nome do seu jardim foi definido para *${newName}*!`,
				message
			);
		}
	} catch (err) {
		logger.error(`[handleFazNome] Erro ao atualizar nome: ${err.message}`);
		return replyReturnMessage(
			chatId,
			`❌ Falha ao atualizar nome da fazenda: ${err.message}`,
			message
		);
	}
}

/**
 * !faz-colher: Colhe plantas prontas e limpa canteiros secos
 */
async function handleFazColher(bot, message, _args, group) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const rawArgs = getArgsText(message).split(/\s+/).filter(Boolean);
	const { isHighQuality, remainingArgs } = extractQualityFlag(rawArgs);

	const slotArg = remainingArgs[0];
	const slotNum = slotArg && /^\d+$/.test(slotArg) ? parseInt(slotArg, 10) : null;

	try {
		const [harvestRes, { name: gameName }, userName] = await Promise.all([
			jardimClient.harvest(userId, slotNum, !slotNum),
			getGameTexts(),
			getUserDisplayName(bot, message, group)
		]);

		let text = `🌾 *COLHEITA DO ${gameName.toUpperCase()}* 🌾\n\n`;

		const harvested = harvestRes.harvested || [];
		const withered = harvestRes.clearedWithered || harvestRes.withered || [];

		if (harvested.length === 0 && withered.length === 0) {
			return replyReturnMessage(
				chatId,
				`⏳ Não há plantas prontas para colheita nem canteiros secos no momento.`,
				message
			);
		}

		if (harvested.length > 0) {
			text += `✨ *Itens Colhidos:*\n`;
			harvested.forEach((h) => {
				const qty = h.count || h.quantity || (Array.isArray(h.slots) ? h.slots.length : 1);
				let slotInfo = "";
				if (Array.isArray(h.slots) && h.slots.length > 0) {
					slotInfo = ` (Canteiro${h.slots.length > 1 ? "s" : ""} ${h.slots.map((s) => `#${s}`).join(", ")})`;
				} else if (h.slotIndex || h.slot) {
					slotInfo = ` (Canteiro #${h.slotIndex || h.slot})`;
				} else if (slotNum) {
					slotInfo = ` (Canteiro #${slotNum})`;
				}
				const bonusLabel = ShadowGardenBonusService.formatCropBonusInline(
					h.plantId || h.id || h.name,
					qty
				);
				const bonusSuffix = bonusLabel ? `: *${bonusLabel}*` : "";
				text += `• *${h.name || h.plantName || h.plantId}*: *${qty}x*${slotInfo}${bonusSuffix}\n`;
			});
			text += "\n";
		}

		if (withered.length > 0) {
			text += `🥀 *Canteiros Secos Limpos:* ${withered.length} canteiro(s) liberado(s).\n\n`;
		}

		// Crédita os bônus dos outros jogos (Pesca/Slots/Waifu) pelo caminho único:
		// reconcile por totais cumulativos da API do Jardim. Cobre esta colheita e
		// qualquer colheita antiga não creditada (inclusive as do painel web), sem
		// depender do estoque e sem chance de crédito em dobro.
		const allBonusMsgs = [];
		try {
			const bonusMsgs = await ShadowGardenBonusService.reconcileHarvestBonus(userId);
			if (bonusMsgs.length > 0) {
				allBonusMsgs.push(...bonusMsgs);
			}
		} catch (reconcileErr) {
			logger.warn(`[handleFazColher] Falha ao reconciliar bônus: ${reconcileErr.message}`);
		}

		if (allBonusMsgs.length > 0) {
			text += `🎁 *BÔNUS ESPECIAIS CONCEDIDOS:*\n${allBonusMsgs.join("\n")}\n\n`;
		}

		const eventFortuneMult = GameEventService.getMultiplier("fazenda", "fortuna");
		let fortuneCoins = 0;
		if (eventFortuneMult > 1.0 && (harvestRes.totalCoinsEarned || 0) > 0) {
			fortuneCoins = Math.round(harvestRes.totalCoinsEarned * (eventFortuneMult - 1));
			if (fortuneCoins > 0) {
				try {
					await jardimClient.adminGive(userId, { coins: fortuneCoins, reason: "evento_fortuna" });
					if (harvestRes.coins !== undefined) harvestRes.coins += fortuneCoins;
					else if (harvestRes.currentCoins !== undefined) harvestRes.currentCoins += fortuneCoins;
				} catch (e) {
					logger.warn(`[handleFazColher] Falha ao creditar bônus fortuna: ${e.message}`);
				}
			}
		}

		if (harvestRes.totalCoinsEarned > 0) {
			text += `💰 *Petalitas Ganhas:* +${harvestRes.totalCoinsEarned.toLocaleString("pt-BR")} Ptl`;
			if (fortuneCoins > 0) {
				text += ` _(+${fortuneCoins.toLocaleString("pt-BR")} bônus do evento Fortuna! 💰)_\n`;
			} else {
				text += `\n`;
			}
		}

		text += `💰 *Saldo Atual:* ${(harvestRes.coins ?? harvestRes.currentCoins ?? 0).toLocaleString("pt-BR")} Ptl`;

		const eventBanner = GameEventService.getEventBanner("fazenda");
		if (eventBanner) {
			text += eventBanner;
		}

		// Tenta renderizar imagem atualizada pós-colheita com efeito de fantasma dourado
		let imageBuffer = null;
		try {
			const harvestedSlots =
				harvested.length > 0
					? harvested
							.flatMap((h) => {
								if (Array.isArray(h.slots) && h.slots.length > 0) {
									return h.slots.map((s) => `${s}:${h.plantId}`);
								}
								if (h.slotIndex || h.slot) {
									return [`${h.slotIndex || h.slot}:${h.plantId}`];
								}
								if (slotNum && h.plantId) {
									return [`${slotNum}:${h.plantId}`];
								}
								return [];
							})
							.filter(Boolean)
							.join(",") || undefined
					: undefined;
			imageBuffer = await jardimClient.getImageBuffer(userId, true, {
				userName,
				harvestedSlots
			});
		} catch (imgErr) {
			logger.warn(
				`[handleFazColher] Não foi possível renderizar imagem da fazenda pós-colheita: ${imgErr.message}`
			);
		}

		if (imageBuffer) {
			const finalBuffer = await optimizeFarmImage(imageBuffer, isHighQuality);

			const colherOptions = {
				farmData: { userId }
			};

			if (bot && bot.useTelegram) {
				const activeFarmId = getActiveFarmMessageId(chatId, userId);
				colherOptions.telegram = {
					editMessageId: activeFarmId || null,
					buttons: [
						[{ text: "🌱 Plantar", action: "/faz-plantar" }],
						[
							{ text: "🔄 Atualizar", action: "/fazenda" },
							{ text: "🛒 Loja", action: "/faz-loja" },
							{ text: "🎒 Mochila", action: "/faz-inv" }
						]
					]
				};
			}

			return replyReturnMessage(
				chatId,
				{
					mimetype: "image/jpeg",
					data: finalBuffer.toString("base64"),
					filename: `fazenda-colheita-${userId}.jpg`,
					isMessageMedia: true
				},
				message,
				{
					caption: text,
					...colherOptions
				}
			);
		}

		return replyReturnMessage(chatId, text, message, { farmData: { userId } });
	} catch (err) {
		// Sem plantas prontas no terreno: ainda assim vale reconciliar colheitas antigas
		// não creditadas (ex: colhidas pelo painel web e já vendidas por lá).
		try {
			const syncMsgs = await ShadowGardenBonusService.reconcileHarvestBonus(userId);
			if (syncMsgs.length > 0) {
				return replyReturnMessage(
					chatId,
					`🌾 *SINCRONIZAÇÃO DO JARDIM DAS SOMBRAS* 🌾\n\n` +
						`🎁 *BÔNUS ESPECIAIS RESGATADOS DAS SUAS COLHEITAS:*\n${syncMsgs.join("\n")}\n\n` +
						`💡 _Não havia novas plantas prontas no terreno, mas seus bônus de colheitas anteriores foram computados com sucesso!_`,
					message
				);
			}
		} catch (syncErr) {
			logger.warn(`[handleFazColher] Falha ao reconciliar bônus no fallback: ${syncErr.message}`);
		}

		logger.error(`[handleFazColher] Erro na colheita: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha na colheita: ${err.message}`, message);
	}
}

/**
 * !faz-plantar: Planta sementes em canteiro específico ou em canteiros livres (padrão: 3)
 */
async function handleFazPlantar(bot, message, _args, group) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const rawArgs = getArgsText(message).split(/\s+/).filter(Boolean);
	const { isHighQuality, remainingArgs: args } = extractQualityFlag(rawArgs);

	if (args.length === 0) {
		if (bot && bot.useTelegram) {
			try {
				const inv = await jardimClient.getInventory(userId);
				const items = inv.items || inv.inventory || [];
				const seeds = items.filter(
					(i) => (i.type === "seed" || i.category === "seed") && (Number(i.quantity) || 0) > 0
				);
				if (seeds.length > 0) {
					let seedText =
						`🌱 *ESCOLHA O QUE DESEJA PLANTAR:*\n\n` +
						`Você possui as seguintes sementes na mochila:\n`;
					const buttons = [];
					let currentRow = [];
					for (const s of seeds) {
						const qty = Number(s.quantity) || 0;
						if (qty <= 0) continue;
						const seedId = s.catalogIndex ?? s.index ?? s.id ?? s.itemId;
						seedText += `• *${s.name}*: ${qty}x (ID: #${seedId})\n`;
						currentRow.push({
							text: `🌱 ${s.name} (${qty}x)`,
							action: `/faz-plantar ${seedId}`
						});
						if (currentRow.length === 2) {
							buttons.push(currentRow);
							currentRow = [];
						}
					}
					if (currentRow.length > 0) buttons.push(currentRow);
					buttons.push([{ text: "🛒 Ir para a Loja", action: "/faz-loja" }]);

					return replyReturnMessage(chatId, seedText, message, {
						telegram: { buttons }
					});
				} else {
					return replyReturnMessage(
						chatId,
						`🌱 *Você não possui sementes na mochila!*\nVisite a loja com \`/faz_loja\` para adquirir sementes antes de plantar.`,
						message,
						{
							telegram: {
								buttons: [[{ text: "🛒 Ir para a Loja", action: "/faz-loja" }]]
							}
						}
					);
				}
			} catch (e) {
				logger.warn(`[handleFazPlantar] Erro ao buscar sementes para botões: ${e.message}`);
			}
		}

		return replyReturnMessage(
			chatId,
			`🌱 *Como plantar:*\n• \`!faz-plantar <semente>\` (planta até 3 nos canteiros livres)\n• \`!faz-plantar <semente> <qtd>\` (ex: \`!faz-plantar 3 5\` ou \`!faz-plantar 3 tudo\`)\n\nVeja suas sementes com \`!faz-inv\`.`,
			message
		);
	}

	const itemParam = args[0];
	let slotParam = null;
	let amountParam = 3; // Padrão: 3 sementes (se tiver)

	if (args[1]) {
		const secondArg = args[1].toLowerCase().trim();
		if (["tudo", "all", "max", "todas"].includes(secondArg)) {
			amountParam = 9;
		} else if (/^c\d+$/i.test(secondArg) || /^slot:\d+$/i.test(secondArg)) {
			slotParam = parseInt(secondArg.replace(/\D/g, ""), 10);
			amountParam = 1;
		} else if (/^\d+$/.test(secondArg)) {
			if (args[2] && /^\d+$/.test(args[2])) {
				amountParam = parseInt(secondArg, 10);
				slotParam = parseInt(args[2], 10);
			} else {
				amountParam = parseInt(secondArg, 10);
			}
		}
	}

	try {
		const eventWitherMult = GameEventService.getMultiplier("fazenda", "apodrecer");
		const [plantRes, userName] = await Promise.all([
			jardimClient.plant(userId, itemParam, slotParam, amountParam, eventWitherMult),
			getUserDisplayName(bot, message, group)
		]);

		refreshTelegramInventoryMessage(bot, chatId, userId).catch(() => {});

		const planted = plantRes.planted || (plantRes.slot ? [plantRes] : []);
		const plantedCount =
			plantRes.plantedCount || (plantRes.slots ? plantRes.slots.length : planted.length || 1);
		const plantName = plantRes.plantName || itemParam;
		const slotsList = (plantRes.slots || planted.map((p) => p.slotIndex || p.slot))
			.filter(Boolean)
			.map((s) => `#${s}`)
			.join(", ");

		const plural = plantedCount > 1 ? "sementes" : "semente";
		let text = `🌱 *Plantadas ${plantedCount} ${plural} de ${plantName}!* 🌱\n\n`;
		if (slotsList) {
			text += `🌾 *Canteiros ocupados:* ${slotsList}\n\n`;
		}

		const plantedKey = String(plantRes.plantId || plantRes.id || itemParam);
		const fullKey = plantedKey.startsWith("crop_") ? plantedKey : `crop_${plantedKey}`;
		const bonusInfo =
			ShadowGardenBonusService.PLANT_BONUS_MAP[fullKey] ||
			Object.values(ShadowGardenBonusService.PLANT_BONUS_MAP).find(
				(p) => p.name.toLowerCase() === plantName.toLowerCase()
			);
		if (bonusInfo) {
			text += `🎁 *Bônus Especial:* Os efeitos de *${bonusInfo.name}* serão entregues automaticamente quando você colher a planta pronta (\`!faz-colheita\`)!\n\n`;
		}

		text += `💡 _Você pode usar \`!faz-plantar ${itemParam} <qtd>\` para escolher quantas plantar (padrão: 3)._`;

		if (eventWitherMult > 1.0) {
			text += `\n\n⏳ *Evento Ativo:* Suas plantas demoram +${Math.round((eventWitherMult - 1) * 100)}% de tempo antes de apodrecer!`;
		}

		const eventBanner = GameEventService.getEventBanner("fazenda");
		if (eventBanner) {
			text += eventBanner;
		}

		// Tenta renderizar imagem atualizada pós-plantio destacando os canteiros recém-plantados em verde
		let imageBuffer = null;
		try {
			const plantedSlots = (plantRes.slots || planted.map((p) => p.slotIndex || p.slot))
				.filter(Boolean)
				.join(",");
			imageBuffer = await jardimClient.getImageBuffer(userId, true, {
				userName,
				plantedSlots
			});
		} catch (imgErr) {
			logger.warn(
				`[handleFazPlantar] Não foi possível renderizar imagem da fazenda pós-plantio: ${imgErr.message}`
			);
		}

		if (imageBuffer) {
			const finalBuffer = await optimizeFarmImage(imageBuffer, isHighQuality);

			const plantarOptions = {
				farmData: { userId }
			};

			if (bot && bot.useTelegram) {
				const activeFarmId = getActiveFarmMessageId(chatId, userId);
				let canHarvest = false;
				let readyCount = 0;
				try {
					const status = await jardimClient.getStatus(userId);
					if (status?.slots && Array.isArray(status.slots)) {
						readyCount = status.slots.filter((s) => s.status === "ready" || s.isReady).length;
						const dryCount = status.slots.filter(
							(s) => s.status === "dry" || s.isDry || s.isWithered
						).length;
						canHarvest = readyCount > 0 || dryCount > 0;
					}
				} catch (stErr) {
					logger.debug(`[handleFazPlantar] Erro ao consultar status para botões: ${stErr.message}`);
				}

				plantarOptions.telegram = {
					editMessageId: activeFarmId || null,
					buttons: buildFarmViewButtons(canHarvest, readyCount)
				};
			}

			return replyReturnMessage(
				chatId,
				{
					mimetype: "image/jpeg",
					data: finalBuffer.toString("base64"),
					filename: `fazenda-plantio-${userId}.jpg`,
					isMessageMedia: true
				},
				message,
				{
					caption: text,
					...plantarOptions
				}
			);
		}

		return replyReturnMessage(chatId, text, message, { farmData: { userId } });
	} catch (err) {
		logger.error(`[handleFazPlantar] Erro ao plantar: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao plantar: ${err.message}`, message);
	}
}

/**
 * !faz-loja: Exibe sementes, elixires e decorações disponíveis para compra
 */
async function handleFazLoja(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	try {
		const [{ name: gameName }, shop] = await Promise.all([
			getGameTexts(),
			jardimClient.getShop(userId)
		]);

		let text = `🛒 *MERCADO DO ${gameName.toUpperCase()}* 🛒\n\n`;

		if (shop.seeds?.length > 0) {
			text += `🌱 *SEMENTES:*\n`;
			shop.seeds.forEach((s) => {
				const rem =
					s.remainingToday !== undefined ? ` [${s.remainingToday}/${s.dailyLimit} hoje]` : "";
				const deathSecs = s.witherTimeSeconds || (s.witherMinutes ? s.witherMinutes * 60 : 0);
				const deathStr = deathSecs ? ` | 💀 Morte: ${formatTimeSeconds(deathSecs)}` : "";
				text += `• *#${s.index} ${s.name}* — Compra: 💰 ${s.price} | Venda: 🪙 ${s.sellPrice || 0} (⏱️ ${s.growthMinutes}m${deathStr})${rem}\n  _${s.description || ""}_\n`;
			});
			text += "\n";
		}

		if (shop.consumables?.length > 0) {
			text += `🧪 *ELIXIRES & CONSUMÍVEIS:*\n`;
			shop.consumables.forEach((c) => {
				const rem =
					c.remainingToday !== undefined ? ` [${c.remainingToday}/${c.dailyLimit} hoje]` : "";
				text += `• *#${c.index} ${c.name}* — 💰 ${Number(c.price).toLocaleString("pt-BR")} Ptl${rem}\n  _${c.description || ""}_\n`;
			});
			text += "\n";
		}

		if (shop.decorations?.length > 0) {
			text += `🏺 *DECORAÇÕES:*\n`;
			shop.decorations.forEach((d) => {
				text += `• *#${d.index} ${d.name}* — 💰 ${Number(d.price).toLocaleString("pt-BR")} Ptl [Tier: ${d.tier}]\n`;
			});
			text += "\n";
		}

		text += `🛍️ *Para comprar:* \`!faz-comprar <número ou nome> [quantidade]\`\n`;
		text += `🧺 *Carrinho:* salve suas compras diárias com \`!faz-carrinho add <item> [qtd]\` e compre tudo com \`!faz-comprar carrinho\``;

		const extraOpts = {};
		if (bot && bot.useTelegram) {
			const lojaButtons = [];
			let seedRow = [];
			if (shop.seeds?.length > 0) {
				for (const s of shop.seeds) {
					seedRow.push({
						text: `🌱 #${s.index} ${s.name}`,
						action: `/faz-comprar ${s.index} 1`
					});
					if (seedRow.length === 2) {
						lojaButtons.push(seedRow);
						seedRow = [];
					}
				}
				if (seedRow.length > 0) lojaButtons.push(seedRow);
			}

			let consRow = [];
			if (shop.consumables?.length > 0) {
				for (const c of shop.consumables) {
					consRow.push({
						text: `🧪 #${c.index} ${c.name}`,
						action: `/faz-comprar ${c.index} 1`
					});
					if (consRow.length === 2) {
						lojaButtons.push(consRow);
						consRow = [];
					}
				}
				if (consRow.length > 0) lojaButtons.push(consRow);
			}

			lojaButtons.push([
				{ text: "➕ Adicionar ao Carrinho", action: "/faz-carrinho add" },
				{ text: "🧺 Meu Carrinho", action: "/faz-carrinho" }
			]);

			if (lojaButtons.length > 0) {
				extraOpts.telegram = { buttons: lojaButtons };
			}
		}

		return replyReturnMessage(chatId, text, message, extraOpts);
	} catch (err) {
		logger.error(`[handleFazLoja] Erro ao carregar loja: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao carregar loja: ${err.message}`, message);
	}
}

/**
 * !faz-comprar: Compra sementes, elixires ou decorações da loja
 */
async function handleFazComprar(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const args = getArgsText(message).split(/\s+/).filter(Boolean);

	if (args.length === 0) {
		return replyReturnMessage(
			chatId,
			`🛒 *Como comprar:*\n• \`!faz-comprar <id ou número do item> [quantidade]\`\nExemplo: \`!faz-comprar 1 5\` (compra 5 sementes do item #1)\n• \`!faz-comprar carrinho\` (compra tudo o que estiver disponível no seu carrinho)`,
			message
		);
	}

	// "!faz-comprar carrinho" (sozinho) compra o carrinho salvo. Com mais palavras
	// (ex: "carrinho do coveiro") segue o fluxo normal e compra o item da loja.
	if (args.length === 1 && CART_KEYWORDS.has(args[0].toLowerCase())) {
		return handleCartPurchase(bot, message);
	}

	const itemParam = args[0];
	const quantity = args[1] && /^\d+$/.test(args[1]) ? parseInt(args[1], 10) : 1;

	try {
		const buyRes = await jardimClient.buy(userId, itemParam, quantity);

		const returns = [];

		let text = `🛍️ *COMPRA REALIZADA COM SUCESSO!* 🛍️\n\n`;
		text += `• Item: *${buyRes.itemName || buyRes.item?.name || itemParam}*\n`;
		const totalQtyText =
			buyRes.newInventoryQuantity !== undefined ? ` (Total: ${buyRes.newInventoryQuantity})` : "";
		text += `• Quantidade: *${buyRes.quantityBought || quantity}x*${totalQtyText}\n`;
		text += `• Total Pago: *${Number(buyRes.totalCost || buyRes.totalPrice || buyRes.cost || 0).toLocaleString("pt-BR")} Ptl*\n`;
		text += `• Saldo Restante: *${Number(buyRes.remainingCoins ?? buyRes.coins ?? 0).toLocaleString("pt-BR")} Ptl*`;

		returns.push(replyReturnMessage(chatId, text, message));

		// Se a API retornou o sticker WebP/PNG em Base64, converte para WebP e envia como figurinha
		if (buyRes.stickerBase64) {
			try {
				const cleanBase64 = String(buyRes.stickerBase64).replace(/^data:image\/\w+;base64,/, "");
				const pngBuffer = Buffer.from(cleanBase64, "base64");
				// Converte para WebP 512x512 transparente para sticker do WhatsApp
				const webpBuffer = await sharp(pngBuffer)
					.resize(512, 512, {
						fit: "contain",
						background: { r: 0, g: 0, b: 0, alpha: 0 }
					})
					.webp({ quality: 90, effort: 4 })
					.toBuffer();

				const stickerMedia = {
					mimetype: "image/webp",
					data: webpBuffer.toString("base64"),
					filename: `sticker-${itemParam}.webp`,
					isMessageMedia: true
				};
				returns.push(
					replyReturnMessage(chatId, stickerMedia, message, {
						sendMediaAsSticker: true,
						stickerAuthor: bot?.nomeExibir || "ravena",
						stickerName: `Jardim: ${buyRes.itemName || itemParam}`
					})
				);
			} catch (stickerErr) {
				logger.error(
					`[handleFazComprar] Erro ao converter sticker da compra para WebP: ${stickerErr.message}`
				);
			}
		}

		return returns;
	} catch (err) {
		logger.error(`[handleFazComprar] Erro ao comprar: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha na compra: ${err.message}`, message);
	}
}

// ─── CARRINHO DE COMPRAS ─────────────────────────────────────────────────────
//
// Lista persistente (por usuário) de itens da loja + quantidades, no estilo do
// carrinho do Farm Admin web. O carrinho nunca se esgota: comprar não o esvazia,
// ele só "salva" o padrão de compras diárias. Na compra, leva-se o máximo
// disponível de cada linha (limite diário restante e saldo), na ordem do carrinho.

const CART_KEYWORDS = new Set(["carrinho", "cart"]);
const CART_MAX_QUANTITY = 999;
const CART_QTY_MAX_WORDS = new Set(["max", "tudo", "all", "todas", "todos"]);
const CART_SUBCOMMANDS = {
	ver: ["ver", "listar", "lista", "mostrar", "show", "list"],
	add: ["add", "adicionar", "adiciona", "colocar", "coloca", "por", "salvar", "+"],
	rem: ["rem", "remover", "remove", "tirar", "tira", "rm", "del", "deletar", "excluir", "-"],
	limpar: ["limpar", "limpa", "esvaziar", "zerar", "clear"],
	comprar: ["comprar", "compra", "buy", "finalizar", "pagar"],
	ajuda: ["ajuda", "help", "?"]
};
const CART_ALLOWED_TYPES = new Set(["seed", "consumable"]);
const CART_TYPE_EMOJI = { seed: "🌱", consumable: "🧪", decoration: "🏺" };

// Evita duas compras de carrinho simultâneas do mesmo usuário (ex: clique duplo no botão)
const cartPurchasesInFlight = new Set();

/**
 * Normaliza texto para comparação de nomes/IDs de itens (sem acentos, _ e - viram espaço)
 * @param {string} str
 * @returns {string}
 */
function normalizeItemText(str) {
	return String(str ?? "")
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[-_]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Achata o catálogo retornado por getShop numa lista única com o tipo de cada item
 * @param {Object} shop
 * @returns {Array<Object>}
 */
function flattenShopCatalog(shop) {
	const items = [];
	const pushAll = (list, itemType) => {
		if (!Array.isArray(list)) return;
		for (const it of list) {
			if (it && it.id) items.push({ ...it, itemType });
		}
	};
	pushAll(shop?.seeds, "seed");
	pushAll(shop?.consumables, "consumable");
	pushAll(shop?.decorations, "decoration");
	return items;
}

/**
 * Resolve um item da loja por número (#index), ID ou nome (exato, depois parcial),
 * na mesma ordem de prioridade da API (sementes → consumíveis → decorações)
 * @param {Object} shop
 * @param {string|number} query
 * @returns {Object|null}
 */
function findShopCatalogItem(shop, query) {
	const raw = String(query ?? "")
		.trim()
		.replace(/^#/, "");
	if (!raw) return null;
	const items = flattenShopCatalog(shop);

	if (/^\d+$/.test(raw)) {
		const idx = parseInt(raw, 10);
		return items.find((it) => Number(it.index) === idx) || null;
	}

	const q = normalizeItemText(raw);
	return (
		items.find((it) => normalizeItemText(it.id) === q || normalizeItemText(it.name) === q) ||
		items.find(
			(it) => normalizeItemText(it.name).includes(q) || normalizeItemText(it.id).includes(q)
		) ||
		null
	);
}

/**
 * Separa "<item...> [qtd]" — a quantidade é o último token se for número, "5x", "x5" ou "max"/"tudo"
 * @param {string[]} tokens
 * @returns {{ itemQuery: string, qtyToken: string|null }}
 */
function splitItemAndQuantity(tokens) {
	if (tokens.length >= 2) {
		const last = tokens[tokens.length - 1].toLowerCase();
		if (/^x?\d+x?$/.test(last) || CART_QTY_MAX_WORDS.has(last)) {
			return { itemQuery: tokens.slice(0, -1).join(" "), qtyToken: last };
		}
	}
	return { itemQuery: tokens.join(" "), qtyToken: null };
}

/**
 * Converte o token de quantidade em número ("max"/"tudo" → maxWordValue)
 * @param {string|null} qtyToken
 * @param {number|null} maxWordValue
 * @returns {number|null} null se ausente; NaN se inválido
 */
function parseCartQuantity(qtyToken, maxWordValue = null) {
	if (!qtyToken) return null;
	if (CART_QTY_MAX_WORDS.has(qtyToken)) return maxWordValue;
	const n = parseInt(qtyToken.replace(/x/g, ""), 10);
	return Number.isFinite(n) && n > 0 ? n : NaN;
}

/**
 * Retorna o nome de exibição de um item com seu número da loja
 * @param {{ index?: number|null, name?: string, itemId?: string }} item
 * @returns {string}
 */
function formatCartItemLabel(item) {
	const idx = item.index !== undefined && item.index !== null ? `#${item.index} ` : "";
	return `${idx}${item.name || item.itemId}`;
}

function formatPtl(value) {
	return `${Number(value || 0).toLocaleString("pt-BR")} Ptl`;
}

/**
 * Lê as linhas do carrinho do usuário (ordem de inserção)
 * @param {string} userId
 * @returns {Promise<Array<{ itemId: string, name: string, itemType: string, index: number|null, quantity: number }>>}
 */
async function getCartItems(userId) {
	const rows = await database.dbAll(
		DB_FAZENDA,
		`SELECT item_id, item_name, item_type, item_index, quantity
		 FROM fazenda_cart_items
		 WHERE user_id = ?
		 ORDER BY created_at ASC, rowid ASC`,
		[userId]
	);
	return (rows || [])
		.map((r) => ({
			itemId: r.item_id,
			name: r.item_name || r.item_id,
			itemType: r.item_type,
			index: r.item_index ?? null,
			quantity: Number(r.quantity) || 0
		}))
		.filter((l) => l.quantity > 0);
}

/**
 * Soma quantidade a uma linha do carrinho (cria se não existir), limitada a maxQuantity
 * @returns {Promise<number>} quantidade final da linha
 */
async function addCartItem(userId, meta, quantity, maxQuantity) {
	const now = Date.now();
	const capped = Math.min(quantity, maxQuantity);
	await database.dbRun(
		DB_FAZENDA,
		`INSERT INTO fazenda_cart_items (user_id, item_id, item_name, item_type, item_index, quantity, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, item_id) DO UPDATE SET
		   quantity = MIN(fazenda_cart_items.quantity + excluded.quantity, ?),
		   item_name = excluded.item_name,
		   item_type = excluded.item_type,
		   item_index = excluded.item_index,
		   updated_at = excluded.updated_at`,
		[userId, meta.id, meta.name, meta.itemType, meta.index ?? null, capped, now, now, maxQuantity]
	);
	const row = await database.dbGet(
		DB_FAZENDA,
		"SELECT quantity FROM fazenda_cart_items WHERE user_id = ? AND item_id = ?",
		[userId, meta.id]
	);
	return Number(row?.quantity) || capped;
}

/**
 * Remove quantidade de uma linha (ou a linha inteira se quantity for null / >= atual)
 * @returns {Promise<{ previous: number, remaining: number }|null>} null se não estava no carrinho
 */
async function removeCartItem(userId, itemId, quantity = null) {
	const row = await database.dbGet(
		DB_FAZENDA,
		"SELECT quantity FROM fazenda_cart_items WHERE user_id = ? AND item_id = ?",
		[userId, itemId]
	);
	if (!row) return null;
	const previous = Number(row.quantity) || 0;

	if (!quantity || quantity >= previous) {
		await database.dbRun(
			DB_FAZENDA,
			"DELETE FROM fazenda_cart_items WHERE user_id = ? AND item_id = ?",
			[userId, itemId]
		);
		return { previous, remaining: 0 };
	}

	await database.dbRun(
		DB_FAZENDA,
		"UPDATE fazenda_cart_items SET quantity = quantity - ?, updated_at = ? WHERE user_id = ? AND item_id = ?",
		[quantity, Date.now(), userId, itemId]
	);
	return { previous, remaining: previous - quantity };
}

/**
 * Esvazia o carrinho do usuário
 * @returns {Promise<number>} quantidade de linhas removidas
 */
async function clearCart(userId) {
	const lines = await getCartItems(userId);
	if (lines.length > 0) {
		await database.dbRun(DB_FAZENDA, "DELETE FROM fazenda_cart_items WHERE user_id = ?", [userId]);
	}
	return lines.length;
}

/**
 * Calcula quanto dá para comprar de uma linha do carrinho agora (função pura).
 * Respeita o limite diário restante (remainingToday; ausente = ilimitado) e o saldo.
 * @param {{ itemId: string, name?: string, index?: number|null, quantity: number }} line
 * @param {Object|null} meta - Item correspondente no catálogo da loja (null = fora da loja)
 * @param {number} coinsAvailable - Saldo disponível (Infinity se desconhecido)
 * @returns {{ itemId: string, name: string, index: number|null, requested: number, quantity: number,
 *   unitPrice: number, subtotal: number, remainingToday: number|null,
 *   status: "full"|"partial"|"sold_out"|"no_coins"|"unavailable", limitedBy: "stock"|"coins"|null }}
 */
function resolveCartLinePurchase(line, meta, coinsAvailable) {
	const requested = Math.max(0, Math.floor(Number(line.quantity) || 0));
	const result = {
		itemId: line.itemId,
		name: meta?.name || line.name || line.itemId,
		index: meta?.index ?? line.index ?? null,
		requested,
		quantity: 0,
		unitPrice: 0,
		subtotal: 0,
		remainingToday: null,
		status: "unavailable",
		limitedBy: null
	};
	if (!meta || requested <= 0) return result;

	result.unitPrice = Math.max(0, Number(meta.price) || 0);
	const hasDailyLimit = meta.remainingToday !== undefined && meta.remainingToday !== null;
	const remainingToday = hasDailyLimit ? Math.max(0, Number(meta.remainingToday) || 0) : Infinity;
	result.remainingToday = hasDailyLimit ? remainingToday : null;

	if (remainingToday <= 0) {
		result.status = "sold_out";
		return result;
	}

	const wanted = Math.min(requested, remainingToday);
	const coins = Number.isFinite(coinsAvailable) ? Math.max(0, coinsAvailable) : Infinity;
	const affordable = result.unitPrice > 0 ? Math.floor(coins / result.unitPrice) : wanted;
	const quantity = Math.min(wanted, affordable);

	if (quantity <= 0) {
		result.status = "no_coins";
		result.limitedBy = "coins";
		return result;
	}

	result.quantity = quantity;
	result.subtotal = quantity * result.unitPrice;
	result.status = quantity < requested ? "partial" : "full";
	result.limitedBy = quantity < wanted ? "coins" : wanted < requested ? "stock" : null;
	return result;
}

/**
 * Busca no catálogo o item de uma linha do carrinho (decorações não entram no carrinho)
 * @param {Array<Object>} catalog - Saída de flattenShopCatalog
 * @param {{ itemId: string }} line
 * @returns {Object|null}
 */
function findCartLineMeta(catalog, line) {
	return catalog.find((it) => it.id === line.itemId && CART_ALLOWED_TYPES.has(it.itemType)) || null;
}

/**
 * Simula a compra do carrinho inteiro na ordem salva, descontando o saldo a cada linha (função pura)
 * @param {Array<Object>} cartLines
 * @param {Object} shop - Catálogo de getShop (com remainingToday do usuário)
 * @param {number|null} coins - Saldo atual (null = desconhecido, não limita)
 * @returns {{ lines: Array<Object>, totalCost: number, totalQuantity: number, coinsLeft: number }}
 */
function planCartPurchase(cartLines, shop, coins) {
	const catalog = flattenShopCatalog(shop);
	let coinsLeft =
		coins === null || coins === undefined ? Infinity : Math.max(0, Number(coins) || 0);
	let totalCost = 0;
	let totalQuantity = 0;
	const lines = cartLines.map((line) => {
		const res = resolveCartLinePurchase(line, findCartLineMeta(catalog, line), coinsLeft);
		if (res.quantity > 0) {
			coinsLeft -= res.subtotal;
			totalCost += res.subtotal;
			totalQuantity += res.quantity;
		}
		return res;
	});
	return { lines, totalCost, totalQuantity, coinsLeft };
}

/**
 * Executa a compra do carrinho: para cada linha, compra o máximo possível via API,
 * atualizando o saldo pela resposta real de cada compra. Falhas não interrompem as demais.
 * @param {string} userId
 * @param {Array<Object>} cartLines
 * @param {Object} shop
 * @param {number|null} coins
 * @returns {Promise<{ bought: Array<Object>, skipped: Array<Object>, failed: Array<Object>, totalSpent: number, balance: number|null }>}
 */
async function executeCartPurchase(userId, cartLines, shop, coins) {
	const catalog = flattenShopCatalog(shop);
	let coinsLeft =
		coins === null || coins === undefined ? Infinity : Math.max(0, Number(coins) || 0);
	const bought = [];
	const skipped = [];
	const failed = [];
	let totalSpent = 0;

	for (const line of cartLines) {
		const res = resolveCartLinePurchase(line, findCartLineMeta(catalog, line), coinsLeft);
		if (res.quantity <= 0) {
			skipped.push(res);
			continue;
		}

		try {
			const buyRes = await jardimClient.buy(userId, res.itemId, res.quantity);
			const qty = Number(buyRes?.quantityBought) || res.quantity;
			const cost = Number(buyRes?.totalCost ?? res.subtotal) || 0;
			totalSpent += cost;
			if (buyRes?.remainingCoins !== undefined && buyRes?.remainingCoins !== null) {
				coinsLeft = Number(buyRes.remainingCoins);
			} else if (Number.isFinite(coinsLeft)) {
				coinsLeft = Math.max(0, coinsLeft - cost);
			}
			bought.push({
				...res,
				name: buyRes?.itemName || res.name,
				quantity: qty,
				subtotal: cost,
				inventoryTotal: buyRes?.newInventoryQuantity
			});
		} catch (err) {
			logger.warn(
				`[executeCartPurchase] Falha ao comprar ${res.itemId} x${res.quantity} para ${userId}: ${err.message}`
			);
			failed.push({ ...res, error: err.message });
		}
	}

	return {
		bought,
		skipped,
		failed,
		totalSpent,
		balance: Number.isFinite(coinsLeft) ? coinsLeft : null
	};
}

/**
 * Descreve em texto curto o motivo de uma linha não ter sido comprada (ou só em parte)
 * @param {Object} res - Resultado de resolveCartLinePurchase
 * @param {boolean} [afterPurchase=false] - Texto para o resumo pós-compra (em vez da prévia)
 * @returns {string}
 */
function describeCartLineIssue(res, afterPurchase = false) {
	switch (res.status) {
		case "sold_out":
			return "esgotado hoje";
		case "no_coins":
			return `saldo insuficiente (${formatPtl(res.unitPrice)}/un)`;
		case "unavailable":
			return "não está mais à venda na loja";
		case "partial":
			if (res.limitedBy === "stock") {
				return afterPurchase ? "limite diário atingido" : "limite diário de hoje";
			}
			if (res.limitedBy === "coins") {
				return afterPurchase ? "saldo insuficiente para o resto" : "saldo não cobre tudo";
			}
			return "";
		default:
			return "";
	}
}

/**
 * Resolve o subcomando do !faz-carrinho a partir do primeiro argumento
 * @param {string} token
 * @returns {string|null}
 */
function resolveCartSubcommand(token) {
	if (!token) return "ver";
	const t = token.toLowerCase();
	for (const [sub, words] of Object.entries(CART_SUBCOMMANDS)) {
		if (words.includes(t)) return sub;
	}
	return null;
}

function buildCartUsageText() {
	return (
		`🧺 *CARRINHO DE COMPRAS DO JARDIM* 🧺\n\n` +
		`Salve sua lista de compras diárias e compre tudo com um comando só!\n\n` +
		`• \`!faz-carrinho\` — Ver o carrinho, disponibilidade e total estimado\n` +
		`• \`!faz-carrinho add <item> [qtd]\` — Adicionar (ex: \`!faz-carrinho add 1 10\`, \`!faz-carrinho add rosa max\`)\n` +
		`• \`!faz-carrinho rem <item> [qtd]\` — Remover (sem qtd, tira o item inteiro)\n` +
		`• \`!faz-carrinho limpar\` — Esvaziar o carrinho\n` +
		`• \`!faz-comprar carrinho\` — Comprar tudo o que estiver disponível\n\n` +
		`_💡 O carrinho nunca se esgota: ele só guarda sua lista. A cada compra, levamos o máximo disponível de cada item (limite diário e saldo), na ordem do carrinho. Apenas sementes e elixires podem ir pro carrinho._`
	);
}

/**
 * Botões padrão de atalho do carrinho no Telegram
 * @param {boolean} withBuy
 * @returns {Array<Array<Object>>}
 */
function buildCartShortcutButtons(withBuy = true) {
	const row = [{ text: "🧺 Ver Carrinho", action: "/faz-carrinho" }];
	if (withBuy) row.push({ text: "🛍️ Comprar Carrinho", action: "/faz-comprar carrinho" });
	return [row];
}

/**
 * Monta a visualização do carrinho (texto + botões Telegram)
 * @param {string} userId
 * @param {boolean} useTelegram
 * @returns {Promise<{ text: string, buttons: Array<Array<Object>>|null }>}
 */
async function buildCartView(userId, useTelegram = false) {
	const cartLines = await getCartItems(userId);

	if (cartLines.length === 0) {
		const text =
			`🧺 *SEU CARRINHO ESTÁ VAZIO* 🧺\n\n` +
			`Adicione os itens que você compra todo dia e depois compre tudo de uma vez:\n` +
			`• \`!faz-carrinho add <item> [qtd]\` (ex: \`!faz-carrinho add 1 10\`)\n` +
			`• \`!faz-comprar carrinho\`\n\n` +
			`Veja os itens e números em \`!faz-loja\`.`;
		const buttons = useTelegram
			? [
					[
						{ text: "➕ Adicionar Itens", action: "/faz-carrinho add" },
						{ text: "🛒 Loja", action: "/faz-loja" }
					]
				]
			: null;
		return { text, buttons };
	}

	const [shopRes, statusRes] = await Promise.allSettled([
		jardimClient.getShop(userId),
		jardimClient.getStatus(userId)
	]);
	const shop = shopRes.status === "fulfilled" ? shopRes.value : null;
	const coins =
		statusRes.status === "fulfilled" && statusRes.value?.coins !== undefined
			? Number(statusRes.value.coins)
			: null;

	let text = `🧺 *SEU CARRINHO DE COMPRAS* 🧺\n\n`;
	let plan = null;

	if (!shop) {
		logger.warn(`[buildCartView] Falha ao carregar loja: ${shopRes.reason?.message}`);
		cartLines.forEach((l) => {
			text += `• *${formatCartItemLabel(l)}* — x${l.quantity}\n`;
		});
		text += `\n⚠️ _Não foi possível consultar a loja agora para checar estoque e preços._\n`;
	} else {
		plan = planCartPurchase(cartLines, shop, coins);
		const catalog = flattenShopCatalog(shop);
		plan.lines.forEach((res) => {
			const meta = catalog.find((it) => it.id === res.itemId);
			const emoji = CART_TYPE_EMOJI[meta?.itemType] || "•";
			const label = formatCartItemLabel(res);
			if (res.quantity <= 0) {
				text += `${emoji} ~${label}~ — x${res.requested} ❌ _${describeCartLineIssue(res)}_\n`;
				return;
			}
			text += `${emoji} *${label}* — x${res.requested} · ${formatPtl(res.unitPrice)}/un → *${formatPtl(res.subtotal)}*`;
			if (res.status === "partial") {
				text += ` _(só ${res.quantity}x — ${describeCartLineIssue(res)})_`;
			}
			text += `\n`;
		});

		text += `\n🧾 *Total estimado agora:* ${formatPtl(plan.totalCost)} (${plan.totalQuantity} ${plan.totalQuantity === 1 ? "item" : "itens"})\n`;
		if (coins !== null) {
			text += `💰 *Seu saldo:* ${formatPtl(coins)}\n`;
		}
		if (plan.totalQuantity === 0) {
			text += `\n✅ _Nada para comprar agora: tudo esgotado hoje ou fora do seu saldo._\n`;
		}
	}

	text += `\n🛍️ *Comprar tudo:* \`!faz-comprar carrinho\`\n`;
	text += `➕ \`!faz-carrinho add <item> [qtd]\` | ➖ \`!faz-carrinho rem <item> [qtd]\` | 🗑️ \`!faz-carrinho limpar\`\n\n`;
	text += `_💡 O carrinho nunca se esgota: ele só guarda sua lista de compras diárias._`;

	let buttons = null;
	if (useTelegram) {
		buttons = [];
		if (!plan || plan.totalQuantity > 0) {
			const buyLabel = plan
				? `🛍️ Comprar Carrinho (${formatPtl(plan.totalCost)})`
				: "🛍️ Comprar Carrinho";
			buttons.push([{ text: buyLabel, action: "/faz-comprar carrinho" }]);
		}
		let row = [];
		for (const l of cartLines) {
			// Usa o ID estável do item (o número da loja é só cache de exibição)
			row.push({ text: `➖ ${l.name}`, action: `/faz-carrinho rem ${l.itemId} 1` });
			if (row.length === 2) {
				buttons.push(row);
				row = [];
			}
		}
		if (row.length > 0) buttons.push(row);
		buttons.push([
			{ text: "➕ Adicionar", action: "/faz-carrinho add" },
			{ text: "🔄 Atualizar", action: "/faz-carrinho" },
			{ text: "🛒 Loja", action: "/faz-loja" }
		]);
	}

	return { text, buttons };
}

/**
 * Encontra a linha do carrinho referida pelo usuário (número da loja, ID ou nome).
 * Tenta resolver pela loja primeiro; se não bater com o carrinho, procura direto nas linhas salvas.
 * @param {Array<Object>} cartLines
 * @param {Object|null} shop
 * @param {string} query
 * @returns {Object|null}
 */
function findCartLineByQuery(cartLines, shop, query) {
	if (shop) {
		const meta = findShopCatalogItem(shop, query);
		const line = meta && cartLines.find((l) => l.itemId === meta.id);
		if (line) return line;
	}

	const raw = String(query ?? "")
		.trim()
		.replace(/^#/, "");
	if (!raw) return null;
	if (/^\d+$/.test(raw)) {
		const idx = parseInt(raw, 10);
		return cartLines.find((l) => Number(l.index) === idx) || null;
	}
	const q = normalizeItemText(raw);
	return (
		cartLines.find((l) => normalizeItemText(l.itemId) === q || normalizeItemText(l.name) === q) ||
		cartLines.find(
			(l) => normalizeItemText(l.name).includes(q) || normalizeItemText(l.itemId).includes(q)
		) ||
		null
	);
}

/**
 * Subcomando "add": adiciona item ao carrinho (ou lista opções no Telegram se sem item)
 */
async function handleCartAdd(bot, message, tokens) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const useTelegram = Boolean(bot && bot.useTelegram);
	const { itemQuery, qtyToken } = splitItemAndQuantity(tokens);

	if (!itemQuery) {
		if (useTelegram) {
			try {
				const shop = await jardimClient.getShop(userId);
				const options = flattenShopCatalog(shop).filter((it) =>
					CART_ALLOWED_TYPES.has(it.itemType)
				);
				if (options.length > 0) {
					const buttons = [];
					let row = [];
					for (const it of options) {
						row.push({
							text: `${CART_TYPE_EMOJI[it.itemType]} #${it.index} ${it.name}`,
							action: `/faz-carrinho add ${it.index} 1`
						});
						if (row.length === 2) {
							buttons.push(row);
							row = [];
						}
					}
					if (row.length > 0) buttons.push(row);
					buttons.push(...buildCartShortcutButtons(true));
					return replyReturnMessage(
						chatId,
						`➕ *ADICIONAR AO CARRINHO*\n\nToque em um item para adicionar *1x* ao seu carrinho.\nPara várias unidades: \`!faz-carrinho add <item> <qtd>\` (ou \`max\`).`,
						message,
						{ telegram: { buttons } }
					);
				}
			} catch (e) {
				logger.warn(`[handleCartAdd] Erro ao buscar loja para botões: ${e.message}`);
			}
		}
		return replyReturnMessage(
			chatId,
			`➕ *Como adicionar ao carrinho:*\n• \`!faz-carrinho add <número ou nome> [qtd]\`\nExemplos: \`!faz-carrinho add 1 10\`, \`!faz-carrinho add rosa max\`\n\nVeja os itens em \`!faz-loja\`.`,
			message
		);
	}

	let shop;
	try {
		shop = await jardimClient.getShop(userId);
	} catch (err) {
		logger.error(`[handleCartAdd] Erro ao carregar loja: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao consultar a loja: ${err.message}`, message);
	}

	const meta = findShopCatalogItem(shop, itemQuery);
	if (!meta) {
		return replyReturnMessage(
			chatId,
			`❌ Item *${itemQuery}* não encontrado na loja. Confira os números e nomes em \`!faz-loja\`.`,
			message
		);
	}

	if (!CART_ALLOWED_TYPES.has(meta.itemType)) {
		return replyReturnMessage(
			chatId,
			`🏺 *${meta.name}* é uma decoração e não entra no carrinho (o carrinho é para compras diárias de sementes e elixires).\nCompre direto com \`!faz-comprar ${meta.index}\`.`,
			message
		);
	}

	const dailyLimit = Number(meta.dailyLimit) > 0 ? Number(meta.dailyLimit) : null;
	const maxQuantity = dailyLimit ?? CART_MAX_QUANTITY;
	const quantity = parseCartQuantity(qtyToken, maxQuantity) ?? 1;
	if (!Number.isFinite(quantity) || quantity <= 0) {
		return replyReturnMessage(
			chatId,
			`❌ Quantidade inválida: *${qtyToken}*. Use um número (ex: \`5\`) ou \`max\`.`,
			message
		);
	}

	try {
		const before = (await getCartItems(userId)).find((l) => l.itemId === meta.id)?.quantity || 0;
		const finalQty = await addCartItem(userId, meta, quantity, maxQuantity);
		const added = Math.max(0, finalQty - before);

		let text = `🧺 *CARRINHO ATUALIZADO!*\n\n`;
		if (added > 0) {
			text += `${CART_TYPE_EMOJI[meta.itemType]} *${formatCartItemLabel(meta)}*: +${added} → agora *${finalQty}x* no carrinho\n`;
		} else {
			text += `${CART_TYPE_EMOJI[meta.itemType]} *${formatCartItemLabel(meta)}* já está no máximo: *${finalQty}x* no carrinho\n`;
		}
		if (dailyLimit && !CART_QTY_MAX_WORDS.has(qtyToken) && before + quantity > finalQty) {
			text += `_⚠️ Ajustado ao limite diário do item (${dailyLimit}/dia)._\n`;
		}
		text += `\n🛍️ Compre tudo com \`!faz-comprar carrinho\` ou veja o carrinho com \`!faz-carrinho\`.`;

		return replyReturnMessage(chatId, text, message, {
			...(useTelegram && { telegram: { buttons: buildCartShortcutButtons(true) } })
		});
	} catch (err) {
		logger.error(`[handleCartAdd] Erro ao salvar carrinho: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao salvar o carrinho: ${err.message}`, message);
	}
}

/**
 * Subcomando "rem": remove quantidade (ou o item inteiro) do carrinho
 */
async function handleCartRemove(bot, message, tokens) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const useTelegram = Boolean(bot && bot.useTelegram);
	const { itemQuery, qtyToken } = splitItemAndQuantity(tokens);

	if (!itemQuery) {
		return replyReturnMessage(
			chatId,
			`➖ *Como remover do carrinho:*\n• \`!faz-carrinho rem <número ou nome> [qtd]\`\nSem quantidade, o item sai inteiro do carrinho.`,
			message
		);
	}

	const quantity = parseCartQuantity(qtyToken, null);
	if (Number.isNaN(quantity)) {
		return replyReturnMessage(
			chatId,
			`❌ Quantidade inválida: *${qtyToken}*. Use um número (ex: \`2\`) ou \`tudo\`.`,
			message
		);
	}

	try {
		const cartLines = await getCartItems(userId);
		if (cartLines.length === 0) {
			return replyReturnMessage(chatId, `🧺 Seu carrinho já está vazio!`, message);
		}

		let shop = null;
		try {
			shop = await jardimClient.getShop(userId);
		} catch (shopErr) {
			logger.debug(`[handleCartRemove] Loja indisponível, usando dados salvos: ${shopErr.message}`);
		}

		const line = findCartLineByQuery(cartLines, shop, itemQuery);
		if (!line) {
			return replyReturnMessage(
				chatId,
				`❌ *${itemQuery}* não está no seu carrinho. Veja o que tem nele com \`!faz-carrinho\`.`,
				message
			);
		}

		const result = await removeCartItem(userId, line.itemId, quantity);
		if (!result) {
			return replyReturnMessage(chatId, `❌ *${itemQuery}* não está no seu carrinho.`, message);
		}

		let text = `🧺 *CARRINHO ATUALIZADO!*\n\n`;
		if (result.remaining > 0) {
			text += `➖ *${formatCartItemLabel(line)}*: -${result.previous - result.remaining} → restam *${result.remaining}x* no carrinho`;
		} else {
			text += `🗑️ *${formatCartItemLabel(line)}* saiu do carrinho.`;
		}

		return replyReturnMessage(chatId, text, message, {
			...(useTelegram && { telegram: { buttons: buildCartShortcutButtons(true) } })
		});
	} catch (err) {
		logger.error(`[handleCartRemove] Erro ao remover do carrinho: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao atualizar o carrinho: ${err.message}`, message);
	}
}

/**
 * Compra tudo o que estiver disponível no carrinho (!faz-comprar carrinho / !faz-carrinho comprar).
 * Responde só com texto (sem figurinha).
 */
async function handleCartPurchase(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const useTelegram = Boolean(bot && bot.useTelegram);

	if (cartPurchasesInFlight.has(userId)) {
		return replyReturnMessage(
			chatId,
			`⏳ Já estou processando a compra do seu carrinho, aguarde um instante!`,
			message
		);
	}
	cartPurchasesInFlight.add(userId);

	try {
		const cartLines = await getCartItems(userId);
		if (cartLines.length === 0) {
			return replyReturnMessage(
				chatId,
				`🧺 *Seu carrinho está vazio!*\nAdicione itens com \`!faz-carrinho add <item> [qtd]\` e depois use \`!faz-comprar carrinho\`.\n\n_(Procurando o enfeite *Carrinho do Coveiro*? Use \`!faz-comprar coveiro\`.)_`,
				message,
				{
					...(useTelegram && {
						telegram: {
							buttons: [
								[
									{ text: "➕ Adicionar Itens", action: "/faz-carrinho add" },
									{ text: "🛒 Loja", action: "/faz-loja" }
								]
							]
						}
					})
				}
			);
		}

		const [shop, status] = await Promise.all([
			jardimClient.getShop(userId),
			jardimClient.getStatus(userId).catch((statusErr) => {
				logger.warn(`[handleCartPurchase] Falha ao obter saldo: ${statusErr.message}`);
				return null;
			})
		]);
		const coins =
			status?.coins !== undefined && status?.coins !== null ? Number(status.coins) : null;

		const { bought, skipped, failed, totalSpent, balance } = await executeCartPurchase(
			userId,
			cartLines,
			shop,
			coins
		);

		let text;
		if (bought.length > 0) {
			text = `🛍️ *CARRINHO COMPRADO!* 🛍️\n\n✅ *Itens comprados:*\n`;
			bought.forEach((b) => {
				const ofRequested = b.quantity < b.requested ? ` de ${b.requested}` : "";
				const reason = b.quantity < b.requested ? ` _(${describeCartLineIssue(b, true)})_` : "";
				const invTotal =
					b.inventoryTotal !== undefined && b.inventoryTotal !== null
						? ` (Mochila: ${b.inventoryTotal})`
						: "";
				text += `• *${b.name}*: ${b.quantity}x${ofRequested} — ${formatPtl(b.subtotal)}${invTotal}${reason}\n`;
			});
		} else if (failed.length > 0) {
			text = `❌ *NÃO FOI POSSÍVEL COMPRAR O CARRINHO*\n`;
		} else {
			text = `🧺 *NADA PARA COMPRAR AGORA*\n\nTodos os itens do seu carrinho estão esgotados hoje ou fora do seu saldo.\n`;
		}

		if (skipped.length > 0) {
			text += `\n⏭️ *Pulados:*\n`;
			skipped.forEach((s) => {
				text += `• *${s.name}* — ${describeCartLineIssue(s)}\n`;
			});
		}

		if (failed.length > 0) {
			text += `\n❌ *Falharam:*\n`;
			failed.forEach((f) => {
				text += `• *${f.name}* (${f.quantity}x) — ${f.error}\n`;
			});
		}

		if (bought.length > 0) {
			text += `\n💸 *Total gasto:* ${formatPtl(totalSpent)}\n`;
		}
		if (balance !== null) {
			text += `💰 *Saldo restante:* ${formatPtl(balance)}\n`;
		}
		text += `\n_🧺 Seu carrinho continua salvo para as próximas compras (\`!faz-carrinho\`)._`;

		if (bought.length > 0) {
			refreshTelegramInventoryMessage(bot, chatId, userId).catch(() => {});
		}

		return replyReturnMessage(chatId, text, message, {
			...(useTelegram && {
				telegram: {
					buttons: [
						[
							{ text: "🌱 Plantar", action: "/faz-plantar" },
							{ text: "🎒 Mochila", action: "/faz-inv" }
						],
						[{ text: "🧺 Ver Carrinho", action: "/faz-carrinho" }]
					]
				}
			})
		});
	} catch (err) {
		logger.error(`[handleCartPurchase] Erro ao comprar carrinho: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao comprar o carrinho: ${err.message}`, message);
	} finally {
		cartPurchasesInFlight.delete(userId);
	}
}

/**
 * !faz-carrinho: Ver, adicionar, remover, limpar e comprar o carrinho de compras diárias
 */
async function handleFazCarrinho(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const useTelegram = Boolean(bot && bot.useTelegram);
	const tokens = getArgsText(message).split(/\s+/).filter(Boolean);
	const sub = resolveCartSubcommand(tokens[0]);
	const rest = tokens.slice(1);

	switch (sub) {
		case "add":
			return handleCartAdd(bot, message, rest);
		case "rem":
			return handleCartRemove(bot, message, rest);
		case "comprar":
			return handleCartPurchase(bot, message);
		case "ajuda":
			return replyReturnMessage(chatId, buildCartUsageText(), message);
		case "limpar":
			try {
				const removed = await clearCart(userId);
				const text =
					removed > 0
						? `🗑️ *Carrinho esvaziado!* (${removed} ${removed === 1 ? "item removido" : "itens removidos"})`
						: `🧺 Seu carrinho já está vazio!`;
				return replyReturnMessage(chatId, text, message);
			} catch (err) {
				logger.error(`[handleFazCarrinho] Erro ao limpar carrinho: ${err.message}`);
				return replyReturnMessage(chatId, `❌ Falha ao limpar o carrinho: ${err.message}`, message);
			}
		case "ver":
			try {
				const { text, buttons } = await buildCartView(userId, useTelegram);
				return replyReturnMessage(chatId, text, message, {
					...(useTelegram && buttons && { telegram: { buttons } })
				});
			} catch (err) {
				logger.error(`[handleFazCarrinho] Erro ao montar carrinho: ${err.message}`);
				return replyReturnMessage(
					chatId,
					`❌ Falha ao carregar o carrinho: ${err.message}`,
					message
				);
			}
		default:
			return replyReturnMessage(
				chatId,
				`❓ Opção *${tokens[0]}* desconhecida.\n\n${buildCartUsageText()}`,
				message
			);
	}
}

/**
 * Constrói o texto e botões (se Telegram) do inventário
 * @param {string} userId
 * @param {boolean} useTelegram
 * @returns {Promise<{ text: string, buttons: Array<Array<Object>>|null, isEmpty: boolean }>}
 */
async function buildInventoryContentAndButtons(userId, useTelegram = false) {
	const [{ name: gameName }, inv] = await Promise.all([
		getGameTexts(),
		jardimClient.getInventory(userId)
	]);

	let bonusMsgs = [];
	try {
		bonusMsgs = await ShadowGardenBonusService.reconcileHarvestBonus(userId);
	} catch (syncErr) {
		logger.warn(`[buildInventoryContentAndButtons] Falha ao reconciliar bônus: ${syncErr.message}`);
	}
	const bonusBlock =
		bonusMsgs.length > 0 ? `\n🎁 *BÔNUS DAS SUAS COLHEITAS:*\n${bonusMsgs.join("\n")}\n` : "";

	let text = `🎒 *MOCHILA DO ${gameName.toUpperCase()}* 🎒\n\n`;

	const items = inv.items || inv.inventory || [];
	if (items.length === 0) {
		text += `Sua mochila está completamente vazia no momento.\nVisite a loja com \`!faz-loja\` para adquirir sementes!`;
		const buttons = useTelegram ? [[{ text: "🛒 Ir para a Loja", action: "/faz-loja" }]] : null;
		return { text: `${text}${bonusBlock}`, buttons, isEmpty: true };
	}

	const seeds = items.filter(
		(i) => (i.type === "seed" || i.category === "seed") && (Number(i.quantity) || 0) > 0
	);
	const crops = items.filter(
		(i) => (i.type === "crop" || i.category === "crop") && (Number(i.quantity) || 0) > 0
	);
	const consumables = items.filter(
		(i) => (i.type === "consumable" || i.category === "consumable") && (Number(i.quantity) || 0) > 0
	);
	const decors = items.filter(
		(i) => (i.type === "decoration" || i.category === "decoration") && (Number(i.quantity) || 0) > 0
	);

	const getItemPrefix = (item) => {
		const id = item.catalogIndex ?? item.index ?? item.id ?? item.itemId;
		return id !== undefined && id !== null && id !== "" ? `[${id}] ` : "";
	};

	if (seeds.length > 0) {
		text += `🌱 *Sementes:*\n`;
		seeds.forEach((s) => {
			const qty = Number(s.quantity) || 0;
			if (qty > 0) {
				text += `• ${getItemPrefix(s)}${s.name}: *${qty}x*\n`;
			}
		});
		text += "\n";
	}

	if (crops.length > 0) {
		text += `🌾 *Colheitas Prontas (Venda com !faz-vender):*\n`;
		crops.forEach((c) => {
			const qty = Number(c.quantity) || 0;
			if (qty > 0) {
				text += `• ${getItemPrefix(c)}${c.name}: *${qty}x* (💰 ${c.sellPrice || 0} cada)\n`;
			}
		});
		text += "\n";
	}

	if (consumables.length > 0) {
		text += `🧪 *Elixires & Poções:*\n`;
		consumables.forEach((c) => {
			const qty = Number(c.quantity) || 0;
			if (qty > 0) {
				text += `• ${getItemPrefix(c)}${c.name}: *${qty}x*\n`;
			}
		});
		text += "\n";
	}

	if (decors.length > 0) {
		text += `🏺 *Decorações:*\n`;
		decors.forEach((d) => {
			const qty = Number(d.quantity) || 0;
			if (qty > 0) {
				text += `• ${getItemPrefix(d)}${d.name}: *${qty}x*\n`;
			}
		});
		text += "\n";
	}

	const waifuBonus = await ShadowGardenBonusService.getWaifuBonus(userId);
	if (waifuBonus.rolls > 0 || waifuBonus.tickets > 0) {
		text += `💖 *Bônus Especiais para Waifus:*\n`;
		if (waifuBonus.rolls > 0) text += `• Rolls Gratuitos da Fazenda: *${waifuBonus.rolls}*\n`;
		if (waifuBonus.tickets > 0) text += `• Tickets Raros de Waifus: *${waifuBonus.tickets}*\n`;
		text += "\n";
	}

	text += `💡 *Ações:* \`!faz-plantar\`, \`!faz-usar\`, \`!faz-vender\`, \`!faz-decorar\``;

	let invButtons = null;
	if (useTelegram) {
		invButtons = [];

		// Botões para plantar sementes disponíveis
		if (seeds.length > 0) {
			let seedRow = [];
			for (const s of seeds) {
				const qty = Number(s.quantity) || 0;
				if (qty <= 0) continue;
				const seedId = s.catalogIndex ?? s.index ?? s.id ?? s.itemId;
				seedRow.push({
					text: `🌱 Plantar ${s.name} (${qty}x)`,
					action: `/faz-plantar ${seedId}`
				});
				if (seedRow.length === 2) {
					invButtons.push(seedRow);
					seedRow = [];
				}
			}
			if (seedRow.length > 0) invButtons.push(seedRow);
		}

		// Botões para usar elixires disponíveis
		if (consumables.length > 0) {
			let consRow = [];
			for (const c of consumables) {
				const qty = Number(c.quantity) || 0;
				if (qty <= 0) continue;
				const consId = c.catalogIndex ?? c.index ?? c.id ?? c.itemId;
				consRow.push({
					text: `🧪 Usar ${c.name} (${qty}x)`,
					action: `/faz-usar ${consId}`
				});
				if (consRow.length === 2) {
					invButtons.push(consRow);
					consRow = [];
				}
			}
			if (consRow.length > 0) invButtons.push(consRow);
		}

		// Botão para vender tudo se tiver colheitas
		if (crops.length > 0) {
			invButtons.push([
				{
					text: `💰 Vender Todas as Colheitas`,
					action: `/faz-vender tudo`
				}
			]);
		}

		// Navegação rápida (sem 'Ver Fazenda' a pedido do usuário)
		invButtons.push([{ text: "🛒 Loja", action: "/faz-loja" }]);
	}

	return { text: `${text}${bonusBlock}`, buttons: invButtons, isEmpty: false };
}

/**
 * Atualiza in-place a mensagem de inventário no Telegram se houver uma ativa para o usuário
 * @param {Object} bot
 * @param {string} chatId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function refreshTelegramInventoryMessage(bot, chatId, userId) {
	if (!bot || !bot.useTelegram) return false;
	const invMsgId = getActiveInvMessageId(chatId, userId);
	if (!invMsgId) return false;

	try {
		const { text, buttons } = await buildInventoryContentAndButtons(userId, true);
		const tgOptions = {};
		if (buttons && Array.isArray(buttons) && typeof bot._buildInlineKeyboard === "function") {
			tgOptions.reply_markup = {
				inline_keyboard: bot._buildInlineKeyboard(buttons)
			};
		}
		if (typeof bot.editMessageText === "function") {
			await bot.editMessageText(chatId, invMsgId, text, tgOptions);
			return true;
		} else if (bot.apiClient && typeof bot.apiClient.editMessageText === "function") {
			const formattedText =
				typeof bot._formatMessage === "function" ? bot._formatMessage(text) : text;
			tgOptions.parse_mode = "HTML";
			await bot.apiClient.editMessageText(chatId, invMsgId, formattedText, tgOptions);
			return true;
		}
	} catch (err) {
		logger.debug(
			`[refreshTelegramInventoryMessage] Falha ao atualizar mensagem do inventário: ${err.message}`
		);
		if (
			err.message &&
			(err.message.includes("message to edit not found") ||
				err.message.includes("message is not modified"))
		) {
			if (err.message.includes("message to edit not found")) {
				invMessageTracker.delete(getFarmTrackerKey(chatId, userId));
			}
		}
	}
	return false;
}

/**
 * !faz-inventario: Exibe o inventário do jogador (sementes, consumíveis, colheitas e decorações)
 */
async function handleFazInventario(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);

	try {
		const { text, buttons } = await buildInventoryContentAndButtons(
			userId,
			Boolean(bot && bot.useTelegram)
		);
		const extraOpts = {
			invData: { userId }
		};
		if (bot && bot.useTelegram && buttons) {
			extraOpts.telegram = { buttons };
		}

		return replyReturnMessage(chatId, text, message, extraOpts);
	} catch (err) {
		logger.error(`[handleFazInventario] Erro ao carregar inventário: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao buscar inventário: ${err.message}`, message);
	}
}

/**
 * !faz-usar: Consome um elixir ou poção do inventário
 */
async function handleFazUsar(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const args = getArgsText(message).split(/\s+/).filter(Boolean);

	if (args.length === 0) {
		return replyReturnMessage(
			chatId,
			`🧪 *Como usar um elixir:*\n• \`!faz-usar <id ou nome do elixir> [canteiro]\`\nExemplo: \`!faz-usar blood_ruby 1\``,
			message
		);
	}

	const itemParam = args[0];
	const slotParam = args[1] && /^\d+$/.test(args[1]) ? parseInt(args[1], 10) : null;

	try {
		const useRes = await jardimClient.useConsumable(userId, itemParam, slotParam);
		refreshTelegramInventoryMessage(bot, chatId, userId).catch(() => {});

		let text = `🧪 *ELIXIR UTILIZADO!* 🧪\n\n`;
		text += `• Efeito: *${useRes.message || useRes.effect || "Elixir ativado com sucesso!"}*\n`;
		if (useRes.remainingQuantity !== undefined) {
			text += `• Quantidade Restante: *${useRes.remainingQuantity}x*`;
		}

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazUsar] Erro ao usar elixir: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao usar item: ${err.message}`, message);
	}
}

/**
 * !faz-vender: Vende colheitas do inventário por Petalitas
 */
async function handleFazVender(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const args = getArgsText(message).split(/\s+/).filter(Boolean);

	const sellAll = args.length === 0 || args[0].toLowerCase() === "tudo";
	const itemParam = !sellAll ? args[0] : null;
	const quantity = args[1] && /^\d+$/.test(args[1]) ? parseInt(args[1], 10) : null;

	try {
		// Reconcilia ANTES de vender: o bônus da colheita é devido independentemente da
		// venda, e depois dela o estoque zera (o saldo deixaria de ser evidência útil).
		let bonusMsgs = [];
		try {
			bonusMsgs = await ShadowGardenBonusService.reconcileHarvestBonus(userId);
		} catch (reconcileErr) {
			logger.warn(
				`[handleFazVender] Falha ao reconciliar bônus antes da venda: ${reconcileErr.message}`
			);
		}

		const sellRes = await jardimClient.sell(userId, {
			all: sellAll,
			...(itemParam && { itemId: itemParam }),
			...(quantity && { quantity })
		});

		refreshTelegramInventoryMessage(bot, chatId, userId).catch(() => {});

		const earned = sellRes.totalCoinsEarned ?? sellRes.earnedCoins ?? sellRes.totalGained ?? 0;
		const balance = sellRes.newCoinsBalance ?? sellRes.currentCoins ?? sellRes.coins ?? 0;

		const eventFortuneMult = GameEventService.getMultiplier("fazenda", "fortuna");
		let fortuneCoins = 0;
		if (eventFortuneMult > 1.0 && earned > 0) {
			fortuneCoins = Math.round(earned * (eventFortuneMult - 1));
			if (fortuneCoins > 0) {
				try {
					await jardimClient.adminGive(userId, { coins: fortuneCoins, reason: "evento_fortuna" });
				} catch (e) {
					logger.warn(`[handleFazVender] Falha ao creditar bônus fortuna: ${e.message}`);
				}
			}
		}

		let text = `💰 *VENDA REALIZADA COM SUCESSO!* 💰\n\n`;
		text += `• Petalitas Ganhas: *+${Number(earned + fortuneCoins).toLocaleString("pt-BR")} Ptl*`;
		if (fortuneCoins > 0) {
			text += ` _(+${Number(fortuneCoins).toLocaleString("pt-BR")} bônus do evento Fortuna! 💰)_\n`;
		} else {
			text += `\n`;
		}
		text += `• Saldo Atual: *${Number(balance + fortuneCoins).toLocaleString("pt-BR")} Ptl*\n`;

		if (sellRes.soldItems?.length > 0) {
			text += `\nItens vendidos:\n`;
			sellRes.soldItems.forEach((it) => {
				text += `• ${it.name || it.itemId}: ${it.quantity}x\n`;
			});
		}

		if (bonusMsgs.length > 0) {
			text += `\n🎁 *BÔNUS DAS COLHEITAS VENDIDAS:*\n${bonusMsgs.join("\n")}\n`;
		}

		const eventBanner = GameEventService.getEventBanner("fazenda");
		if (eventBanner) {
			text += eventBanner;
		}

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazVender] Erro ao vender colheitas: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha na venda: ${err.message}`, message);
	}
}

/**
 * !faz-decorar: Posiciona enfeite via slot ou comparação de imagem citada com Sharp
 */
async function handleFazDecorar(bot, message) {
	const userId = getUserId(message);
	const chatId = getChatId(message);
	const args = getArgsText(message).split(/\s+/).filter(Boolean);

	// Checa se o usuário enviou uma imagem citada ou mídia
	const quoted = message.origin?.getQuotedMessage ? await message.origin.getQuotedMessage() : null;
	const userMedia = message.media || quoted?.media || null;

	if (args.length === 0) {
		return replyReturnMessage(
			chatId,
			`🏺 *Como posicionar enfeites:*\n• Por slot: \`!faz-decorar <enfeite> <slot de 1 a 4>\`\n• Por coordenadas: \`!faz-decorar <enfeite> <slot> <x> <y>\`\n• Por imagem: Marque um emoji sobre o terreno na foto da sua fazenda e envie respondendo: \`!faz-decorar <enfeite>\``,
			message
		);
	}

	const decorParam = args[0];
	const slotIndex = args[1] && /^\d+$/.test(args[1]) ? parseInt(args[1], 10) : 1;
	let x = args[2] && /^\d+$/.test(args[2]) ? parseInt(args[2], 10) : undefined;
	let y = args[3] && /^\d+$/.test(args[3]) ? parseInt(args[3], 10) : undefined;

	// Se houver mídia (imagem modificada com emoji/marcação), processa centroid diff com Sharp
	if (userMedia && Buffer.isBuffer(userMedia)) {
		try {
			const baseImage = await jardimClient.getImageBuffer(userId, false);
			const detected = await detectMarkerCoords(userMedia, baseImage);
			if (detected) {
				x = detected.x;
				y = detected.y;
				logger.info(`[handleFazDecorar] Emoji/marcador detectado via Sharp em x=${x}, y=${y}`);
			}
		} catch (detectErr) {
			logger.warn(
				`[handleFazDecorar] Detecção de emoji falhou, usando slot padrão: ${detectErr.message}`
			);
		}
	}

	try {
		const payload = {
			decorId: decorParam,
			slotIndex,
			...(x !== undefined && { x }),
			...(y !== undefined && { y })
		};

		const decorRes = await jardimClient.decorate(userId, payload);

		let text = `🏺 *ENFEITE POSICIONADO COM SUCESSO!* 🏺\n\n`;
		text += `• Enfeite: *${decorRes.name || decorRes.decorId || decorParam}*\n`;
		text += `• Slot Decorativo: *#${decorRes.slotIndex || slotIndex}*\n`;
		if (decorRes.x !== undefined && decorRes.y !== undefined) {
			text += `• Posição: *(${decorRes.x}, ${decorRes.y})*\n`;
		}
		text += `\nVeja o novo visual com \`!fazenda\`!`;

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazDecorar] Erro ao posicionar enfeite: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao posicionar enfeite: ${err.message}`, message);
	}
}

/**
 * Verifica se um identificador de usuário pertence a testes ou simulações
 * @param {string} userId
 * @returns {boolean}
 */
function isTestUser(userId) {
	if (!userId) return true;
	const s = String(userId).trim().toLowerCase();
	return (
		s.startsWith("test") ||
		s.startsWith("sim") ||
		s.includes("test") ||
		s.includes("sim") ||
		s.includes("cultivador") ||
		s === "calibrate" ||
		s === "1"
	);
}

/**
 * Verifica se o usuário é superadmin ou conta de teste/dono (ex: moothz)
 * @param {string} userIdOrName
 * @returns {boolean}
 */
function isSuperAdminUser(userIdOrName) {
	if (!userIdOrName) return false;
	const s = String(userIdOrName).trim().toLowerCase();
	if (s.includes("moothz") || s === "382359487") return true;
	const digits = s.split("@")[0].replace(/\D/g, "");
	const superAdmins = (process.env.SUPER_ADMINS || "")
		.split(",")
		.map((a) => a.split("@")[0].replace(/\D/g, ""))
		.filter(Boolean);
	if (digits && superAdmins.includes(digits)) return true;
	return false;
}

/**
 * Resolve o apelido ou nome amigável do usuário preservando a privacidade
 * @param {WhatsAppBot} bot
 * @param {string} userId
 * @param {Object} [message]
 * @param {Object} [group]
 * @returns {Promise<string>}
 */
async function resolvePlayerRankingName(bot, userId, message, group) {
	if (!userId) return "Cultivador";

	const strId = String(userId).trim();
	const numDigits = strId.split("@")[0].replace(/\D/g, "");

	// Se for o próprio autor da mensagem atual
	const authorJid = message?.author || message?.from || "";
	const authorDigits = authorJid.split("@")[0].replace(/\D/g, "");
	const isAuthor = strId === authorJid || (numDigits && authorDigits === numDigits);

	let targetGroup = group;
	if (!targetGroup && message?.group && bot?.groups) {
		targetGroup = bot.groups[message.group];
	}

	// 1. Apelido configurado no grupo atual (group.nicks)
	if (targetGroup?.nicks && Array.isArray(targetGroup.nicks)) {
		const nickData = targetGroup.nicks.find((n) => {
			if (!n?.numero) return false;
			const nStr = String(n.numero);
			const nDigits = nStr.split("@")[0].replace(/\D/g, "");
			return nStr === strId || (numDigits && nDigits === numDigits);
		});
		if (nickData?.apelido && nickData.apelido.trim()) {
			return nickData.apelido.trim();
		}
	}

	// 2. Se for o autor da mensagem, aproveitar pushName/authorName da mensagem
	if (isAuthor) {
		const fallback = message?.authorName || message?.pushName || message?.name;
		if (fallback && typeof fallback === "string" && fallback.trim()) {
			const clean = fallback.trim();
			if (
				clean !== strId &&
				clean.replace(/\D/g, "") !== numDigits &&
				clean !== "." &&
				clean !== "..."
			) {
				return clean;
			}
		}
	}

	// 3. Apelido em outros grupos onde o bot participa
	if (bot?.groups && typeof bot.groups === "object") {
		for (const gId of Object.keys(bot.groups)) {
			const otherGroup = bot.groups[gId];
			if (otherGroup?.nicks && Array.isArray(otherGroup.nicks)) {
				const nickData = otherGroup.nicks.find((n) => {
					if (!n?.numero) return false;
					const nStr = String(n.numero);
					const nDigits = nStr.split("@")[0].replace(/\D/g, "");
					return nStr === strId || (numDigits && nDigits === numDigits);
				});
				if (nickData?.apelido && nickData.apelido.trim()) {
					return nickData.apelido.trim();
				}
			}
		}
	}

	// 4. Fallback através do resolveMentionName
	const jid = strId.includes("@")
		? strId
		: numDigits.length >= 10
			? `${numDigits}@s.whatsapp.net`
			: strId;

	try {
		const name = await resolveMentionName(bot, jid, targetGroup);
		if (name && typeof name === "string" && name.trim()) {
			const clean = name.trim();
			const cleanDigits = clean.replace(/\D/g, "");
			if (clean !== strId && cleanDigits !== numDigits && clean !== "." && clean !== "...") {
				return clean;
			}
		}
	} catch (err) {
		logger.debug(`[resolvePlayerRankingName] Erro em resolveMentionName: ${err.message}`);
	}

	// 5. Consulta cache pushname do bot
	try {
		if (typeof bot?.fetchPushNameFromCache === "function") {
			const cacheObj = await bot.fetchPushNameFromCache(jid);
			const pName = cacheObj?.pushName ?? cacheObj?.pushname ?? cacheObj;
			if (pName && typeof pName === "string" && pName.trim()) {
				const clean = pName.trim();
				const cleanDigits = clean.replace(/\D/g, "");
				if (clean !== strId && cleanDigits !== numDigits && clean !== "." && clean !== "...") {
					return clean;
				}
			}
		}
	} catch (err) {
		logger.debug(`[resolvePlayerRankingName] Erro em fetchPushNameFromCache: ${err.message}`);
	}

	// 6. Consulta no SQLite (cache.db e msgranking.db)
	try {
		const Database = require("../utils/Database");
		const db = Database.getInstance();

		// msgranking.db tem o nome registrado em mensagens
		const msgRow = await db.dbGet(
			"msgranking",
			"SELECT user_name FROM ranking WHERE user_id LIKE ? AND user_name IS NOT NULL AND user_name != '' LIMIT 1;",
			[`%${numDigits || strId}%`]
		);
		if (msgRow?.user_name && typeof msgRow.user_name === "string" && msgRow.user_name.trim()) {
			const clean = msgRow.user_name.trim();
			const cleanDigits = clean.replace(/\D/g, "");
			if (clean !== strId && cleanDigits !== numDigits && clean !== "." && clean !== "...") {
				return clean;
			}
		}

		// cache.db pushnames
		const pushRow = await db.dbGet(
			"cache",
			"SELECT pushname FROM pushnames WHERE id = ? OR id = ? OR id LIKE ? LIMIT 1;",
			[jid, strId, `%${numDigits || strId}%`]
		);
		if (pushRow?.pushname && typeof pushRow.pushname === "string" && pushRow.pushname.trim()) {
			const clean = pushRow.pushname.trim();
			const cleanDigits = clean.replace(/\D/g, "");
			if (clean !== strId && cleanDigits !== numDigits && clean !== "." && clean !== "...") {
				return clean;
			}
		}

		// cache.db tg_names (Telegram)
		const tgRow = await db.dbGet("cache", "SELECT json_data FROM tg_names WHERE key = ? LIMIT 1;", [
			`tg_name:${strId}`
		]);
		if (tgRow?.json_data) {
			try {
				const parsed = JSON.parse(tgRow.json_data);
				if (parsed && typeof parsed === "string" && parsed.trim()) {
					return parsed.trim();
				}
			} catch (_) {}
		}
	} catch (err) {
		logger.debug(`[resolvePlayerRankingName] Erro na consulta SQLite: ${err.message}`);
	}

	// 7. Fallback seguro que NUNCA expõe o número completo
	if (numDigits.length >= 4) {
		return `Cultivador (...${numDigits.slice(-4)})`;
	}
	return "Cultivador";
}

/**
 * !faz-ranking: Exibe rankings de riqueza e de colheitas
 */
async function handleFazRanking(bot, message, args = [], group = null) {
	const chatId = getChatId(message);
	const argsText = getArgsText(message).toLowerCase();

	const isFarmers = argsText.includes("colheita") || argsText.includes("farmer");

	let targetGroup = group;
	if (!targetGroup && message?.group && bot?.groups) {
		targetGroup = bot.groups[message.group];
	}

	try {
		let text = "";
		if (isFarmers) {
			const farmers = await jardimClient.getFarmersRanking(25);
			text += `🏆 *TOP 10 MESTRES DA COLHEITA* 🏆\n\n`;
			const rawList = farmers.ranking || farmers || [];
			const list = rawList.filter((f) => !isTestUser(f.userId || f.playerId));
			const topList = list.slice(0, 10);
			const resolvedNames = await Promise.all(
				topList.map((f) =>
					resolvePlayerRankingName(bot, f.userId || f.playerId, message, targetGroup)
				)
			);
			topList.forEach((f, idx) => {
				const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `${idx + 1}º.`;
				const name = resolvedNames[idx];
				text += `${medal} *${name}* — *${f.harvestCount || f.totalHarvested || 0} colheitas*\n`;
			});
			text += `\n_Para ver o ranking de Petalitas, digite \`!faz-ranking riqueza\`_`;
		} else {
			const wealth = await jardimClient.getWealthRanking(25);
			text += `🏆 *TOP 10 FAZENDEIROS MAIS RICOS* 🏆\n\n`;
			const rawList = wealth.ranking || wealth || [];
			const list = rawList.filter((w) => !isTestUser(w.userId || w.playerId));
			const topList = list.slice(0, 10);
			const resolvedNames = await Promise.all(
				topList.map((w) =>
					resolvePlayerRankingName(bot, w.userId || w.playerId, message, targetGroup)
				)
			);
			topList.forEach((w, idx) => {
				const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `${idx + 1}º.`;
				const name = resolvedNames[idx];
				text += `${medal} *${name}* — 💰 *${Number(w.coins || 0).toLocaleString("pt-BR")} Ptl*\n`;
			});
			text += `\n_Para ver o ranking de colheitas, digite \`!faz-ranking colheitas\`_`;
		}

		return replyReturnMessage(chatId, text, message);
	} catch (err) {
		logger.error(`[handleFazRanking] Erro ao buscar rankings: ${err.message}`);
		return replyReturnMessage(chatId, `❌ Falha ao carregar ranking: ${err.message}`, message);
	}
}

const FAZENDA_CATEGORY_BUTTONS = [
	[
		{
			text: "🌱 Cultivo & Canteiros",
			action: { type: "fazenda_menu", category: "cultivo", page: 0 }
		},
		{ text: "🛒 Loja & Economia", action: { type: "fazenda_menu", category: "mercado", page: 0 } }
	],
	[
		{
			text: "🏺 Terreno & Decorações",
			action: { type: "fazenda_menu", category: "terreno", page: 0 }
		},
		{ text: "🏆 Rankings & Gestão", action: { type: "fazenda_menu", category: "gestao", page: 0 } }
	],
	[{ text: "📋 Todos os Comandos", action: { type: "fazenda_menu", category: "todos", page: 0 } }]
];

const FAZENDA_CATEGORY_DETAILS = {
	cultivo: {
		title: "🌱 Cultivo & Canteiros",
		description: "Comandos para plantar, regar, cuidar e colher suas plantas mágicas:",
		commands: [
			{
				cmd: "/fazenda [hd]",
				aliases: ["/faz", "/farm"],
				desc: "Visualiza sua fazenda (9 canteiros) e coleta o diário."
			},
			{
				cmd: "/faz_colheita [canteiro]",
				aliases: ["/faz_colher"],
				desc: "Colhe plantas maduras e limpa canteiros secos."
			},
			{
				cmd: "/faz_plantar <semente> [qtd]",
				desc: "Planta sementes nos canteiros livres ou específico."
			}
		]
	},
	mercado: {
		title: "🛒 Loja & Economia",
		description: "Comandos de Petalitas, catálogo de sementes, compras e venda de colheitas:",
		commands: [
			{
				cmd: "/faz_loja",
				aliases: ["/faz_shop"],
				desc: "Catálogo de sementes, elixires e decorações."
			},
			{
				cmd: "/faz_comprar <item> [qtd]",
				aliases: ["/faz_buy"],
				desc: "Compra itens da loja com suas Petalitas."
			},
			{
				cmd: "/faz_carrinho [add|rem|limpar] [item] [qtd]",
				aliases: ["/faz_cart"],
				desc: "Salva sua lista de compras diárias (sementes e elixires)."
			},
			{
				cmd: "/faz_comprar carrinho",
				aliases: ["/faz_carrinho comprar"],
				desc: "Compra tudo o que estiver disponível no carrinho (limite diário e saldo)."
			},
			{
				cmd: "/faz_inv",
				aliases: ["/faz_inventario"],
				desc: "Exibe sua mochila com sementes e bônus."
			},
			{
				cmd: "/faz_usar <elixir> [slot]",
				aliases: ["/faz_use"],
				desc: "Consome elixires (aceleração, proteção contra secar)."
			},
			{
				cmd: "/faz_vender [item ou tudo]",
				aliases: ["/faz_vendertudo"],
				desc: "Vende suas colheitas por Petalitas."
			}
		]
	},
	terreno: {
		title: "🏺 Terreno & Decorações",
		description: "Comandos para personalizar o visual e nome do seu Jardim:",
		commands: [
			{
				cmd: "/faz_decorar <enfeite> [slot]",
				aliases: ["/faz_enfeitar"],
				desc: "Posiciona ou move decorações no terreno."
			},
			{
				cmd: "/faz_nome <nome>",
				aliases: ["/faz_fnome"],
				desc: "Define um nome personalizado para o seu jardim (máx 20 chars)."
			}
		]
	},
	gestao: {
		title: "🏆 Rankings & Gestão",
		description: "Comandos de líderes do jogo e acesso administrativo web:",
		commands: [
			{
				cmd: "/faz_ranking [riqueza|colheitas]",
				aliases: ["/faz_rank"],
				desc: "Exibe os melhores fazendeiros do servidor."
			},
			{
				cmd: "/faz_adm",
				aliases: ["/faz_admin"],
				desc: "Gera link de acesso seguro ao Farm Admin web no privado."
			}
		]
	},
	todos: {
		title: "📋 Todos os Comandos",
		description: "Lista rápida de todos os comandos do Jardim das Sombras:",
		commands: [
			{ cmd: "/fazenda", desc: "Ver fazenda e diário" },
			{ cmd: "/faz_colheita", desc: "Colher plantas e limpar secos" },
			{ cmd: "/faz_plantar <semente>", desc: "Semear nos canteiros" },
			{ cmd: "/faz_loja", desc: "Ver loja de sementes e poções" },
			{ cmd: "/faz_comprar <item>", desc: "Comprar na loja" },
			{ cmd: "/faz_carrinho", desc: "Ver e editar o carrinho de compras" },
			{ cmd: "/faz_comprar carrinho", desc: "Comprar tudo do carrinho" },
			{ cmd: "/faz_inv", desc: "Ver mochila de itens" },
			{ cmd: "/faz_usar <elixir>", desc: "Usar poções mágicas" },
			{ cmd: "/faz_vender [tudo]", desc: "Vender colheitas por Petalitas" },
			{ cmd: "/faz_decorar <item>", desc: "Decorar terreno" },
			{ cmd: "/faz_ranking", desc: "Ver ranking de fazendeiros" },
			{ cmd: "/faz_nome <nome>", desc: "Alterar nome do jardim" },
			{ cmd: "/faz_adm", desc: "Painel Farm Admin no privado" },
			{ cmd: "/faz_help", desc: "Guia completo e mecânicas" }
		]
	}
};

/**
 * Trata callbacks de navegação interativa no menu da Fazenda (TelegramBot e DiscordBot)
 * @param {Object} bot - Instância do bot Telegram ou Discord
 * @param {Object} callbackQuery - callback_query do Telegram (ou adaptador equivalente do Discord)
 * @param {string} category - Categoria solicitada ou 'root'
 * @param {number} [page=0] - Página atual
 */
async function handleFazendaMenuCallback(bot, callbackQuery, category, page = 0) {
	try {
		const message = callbackQuery.message;
		if (!message || !message.chat) return;

		if (category === "root") {
			const text =
				`📋 *NAVEGADOR DE COMANDOS DO JARDIM DAS SOMBRAS*\n\n` +
				`Toque em uma categoria abaixo para ver os comandos e explicações detalhadas:`;
			await editInteractiveMenuMessage(bot, callbackQuery, text, FAZENDA_CATEGORY_BUTTONS);
			return;
		}

		const catInfo = FAZENDA_CATEGORY_DETAILS[category];
		if (!catInfo) return;

		// Comandos são escritos no estilo Telegram (/faz_loja); no Discord exibe com o prefixo do grupo (!faz-loja)
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
					action: { type: "fazenda_menu", category: "root", page: 0 }
				}
			]
		];

		await editInteractiveMenuMessage(bot, callbackQuery, catText, navButtons);
	} catch (err) {
		if (bot?.logger?.error) {
			bot.logger.error(`[handleFazendaMenuCallback] Erro: ${err.message}`, err);
		}
	}
}

/**
 * !faz-ajuda: Guia geral dos comandos da Fazenda
 */
async function handleFazAjuda(bot, message) {
	const chatId = getChatId(message);
	const { name: gameName, emoji: gameEmoji } = await getGameTexts();

	let mechanicsText = `${gameEmoji} *GUIA DO ${gameName.toUpperCase()}* ${gameEmoji}\n\n`;
	mechanicsText += `O *${gameName}* é um jogo de fazenda e cultivo integrado à Ravena, onde você planta sementes raras, colhe frutos mágicos e desbloqueia bônus para outros jogos do bot (Waifus, Pesca e Slots)!\n\n`;

	mechanicsText += `━━━━━━━━━━━━━━━━━━━━━\n`;
	mechanicsText += `📖 *MECÂNICAS DO JOGO*\n`;
	mechanicsText += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

	mechanicsText += `🌾 *1. Canteiros & Cultivo*\n`;
	mechanicsText += `• Você possui *9 canteiros mágicos* para cultivar plantas simultaneamente.\n`;
	mechanicsText += `• Use \`!faz-plantar <semente>\` para plantar sementes nos canteiros livres.\n`;
	mechanicsText += `• Cada planta possui um tempo próprio de crescimento (de minutos a horas).\n\n`;

	mechanicsText += `🧺 *2. Colheita & Apodrecimento*\n`;
	mechanicsText += `• Plantas maduras devem ser colhidas com \`!faz-colheita\` (ou \`!faz-colher\`).\n`;
	mechanicsText += `• ⚠️ *Atenção:* Se demorar muito para colher, as plantas secam! O comando de colheita também limpa canteiros secos para liberar espaço.\n\n`;

	mechanicsText += `🎁 *3. Bônus Cross-Game Integrados*\n`;
	mechanicsText += `• Colher plantas especiais concede bônus reais em outros jogos:\n`;
	mechanicsText += `  💖 *Waifuletes:* Rolls gratuitos e tickets raros para sorteios!\n`;
	mechanicsText += `  🎣 *Pesca:* Iscas especiais e bônus de captura!\n`;
	mechanicsText += `  🎰 *Slots:* Fichas extras da sorte!\n\n`;

	mechanicsText += `💰 *4. Economia & Loja*\n`;
	mechanicsText += `• Resgate suas Petalitas diárias com a sacola do coveiro usando \`!fazenda\`.\n`;
	mechanicsText += `• Compre sementes, elixires e decorações com \`!faz-loja\` e \`!faz-comprar\`.\n`;
	mechanicsText += `• Monte um *carrinho* com suas compras diárias (\`!faz-carrinho add <item> [qtd]\`) e compre tudo de uma vez com \`!faz-comprar carrinho\` — ele nunca se esgota, só guarda sua lista!\n`;
	mechanicsText += `• Veja sua mochila com \`!faz-inv\` e venda suas colheitas por Petalitas com \`!faz-vender\`.\n\n`;

	mechanicsText += `🧪 *5. Elixires Mágicos*\n`;
	mechanicsText += `• Consuma elixires do inventário com \`!faz-usar <elixir>\` para acelerar o crescimento ou proteger contra o secamento.`;

	if (bot && (bot.useTelegram || bot.useDiscord)) {
		const navigatorText =
			`📋 *NAVEGADOR DE COMANDOS DO JARDIM DAS SOMBRAS*\n\n` +
			`Toque em uma categoria abaixo para ver os comandos e explicações detalhadas:`;

		const msg1 = replyReturnMessage(chatId, mechanicsText, message);
		const msg2 = new ReturnMessage({
			chatId,
			content: navigatorText,
			telegram: {
				buttons: FAZENDA_CATEGORY_BUTTONS
			}
		});

		return [msg1, msg2];
	}

	let commandsText = `\n\n━━━━━━━━━━━━━━━━━━━━━\n`;
	commandsText += `📋 *LISTA DE COMANDOS*\n`;
	commandsText += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
	commandsText += `• \`!fazenda [hd]\` — Ver a sua fazenda (adicione \`hd\` para resolução máxima) e resgatar diário\n`;
	commandsText += `• \`!faz-adm\` — Obter link do painel web Farm Admin no privado\n`;
	commandsText += `• \`!faz-colheita [canteiro] [hd]\` — Colher plantas maduras e limpar canteiros secos\n`;
	commandsText += `• \`!faz-plantar <semente> [canteiro] [hd]\` — Semear nos canteiros livres ou específico\n`;
	commandsText += `• \`!faz-loja\` — Ver catálogo de sementes, elixires e decorações\n`;
	commandsText += `• \`!faz-comprar <item> [qtd]\` — Comprar itens na loja\n`;
	commandsText += `• \`!faz-carrinho [add|rem|limpar] [item] [qtd]\` — Ver e editar seu carrinho de compras diárias\n`;
	commandsText += `• \`!faz-comprar carrinho\` — Comprar tudo o que estiver disponível no carrinho\n`;
	commandsText += `• \`!faz-inventario\` — Ver seus itens, sementes e bônus acumulados\n`;
	commandsText += `• \`!faz-usar <elixir> [canteiro]\` — Ativar poções mágicas\n`;
	commandsText += `• \`!faz-vender [item ou tudo]\` — Vender suas colheitas por Petalitas\n`;
	commandsText += `• \`!faz-decorar <enfeite> [slot]\` — Posicionar itens decorativos\n`;
	commandsText += `• \`!faz-ranking\` — Ver o ranking dos melhores fazendeiros\n`;
	commandsText += `• \`!faz-ajuda\` — Exibir este menu de ajuda`;

	const fullText = mechanicsText + commandsText;
	return replyReturnMessage(chatId, fullText, message);
}

// ─── DEFINIÇÃO DOS COMANDOS EXPORTADOS ──────────────────────────────────────

const commands = [
	new Command({
		name: "fazenda",
		aliases: ["faz", "farm"],
		description: "Visualiza a fazenda atual no Jardim das Sombras e coleta o diário",
		usage: "!fazenda [hd]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazenda
	}),
	new Command({
		name: "faz-adm",
		aliases: ["faz-admin"],
		description: "Gera o link de autenticação seguro para o painel Farm Admin",
		usage: "!faz-adm",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazAdm
	}),
	new Command({
		name: "faz-colheita",
		aliases: ["faz-colheitatudo"],
		description: "Colhe plantas maduras e limpa canteiros secos",
		usage: "!faz-colheita [número do canteiro] [hd]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		reactions: { trigger: ["🌾", "🧺"], before: "⏳", after: "🌾", error: "❌" },
		method: handleFazColher
	}),
	new Command({
		name: "faz-colher",
		aliases: ["faz-colhertudo"],
		description: "Colhe plantas maduras e limpa canteiros secos",
		usage: "!faz-colher [número do canteiro] [hd]",
		category: "jogos",
		reply: true,
		hidden: true,
		cooldown: 3,
		reactions: { trigger: ["🌾", "🧺"], before: "⏳", after: "🌾", error: "❌" },
		method: handleFazColher
	}),
	new Command({
		name: "faz-plantar",
		aliases: ["faz-plantartudo"],
		description: "Planta sementes em canteiro específico ou em todos os canteiros livres",
		usage: "!faz-plantar <semente> [canteiro ou qtd] [hd]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazPlantar
	}),
	new Command({
		name: "faz-loja",
		aliases: ["faz-shop"],
		description: "Visualiza catálogo de sementes, elixires e decorações",
		usage: "!faz-loja",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazLoja
	}),
	new Command({
		name: "faz-comprar",
		aliases: ["faz-buy"],
		description: "Compra sementes, elixires ou decorações da loja (ou o carrinho inteiro)",
		usage: "!faz-comprar <item> [quantidade] | !faz-comprar carrinho",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazComprar
	}),
	new Command({
		name: "faz-carrinho",
		aliases: ["faz-cart"],
		description:
			"Carrinho de compras diárias da loja: salve itens e compre tudo com !faz-comprar carrinho",
		usage: "!faz-carrinho [add|rem|limpar|comprar] [item] [qtd]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazCarrinho
	}),
	new Command({
		name: "faz-inventario",
		aliases: ["faz-inv"],
		description: "Exibe a mochila de itens, sementes e bônus acumulados",
		usage: "!faz-inventario",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazInventario
	}),
	new Command({
		name: "faz-usar",
		aliases: ["faz-use"],
		description: "Utiliza um elixir ou consumível do inventário",
		usage: "!faz-usar <elixir> [canteiro]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazUsar
	}),
	new Command({
		name: "faz-vender",
		aliases: ["faz-vendertudo"],
		description: "Vende colheitas do inventário por Petalitas",
		usage: "!faz-vender [item ou tudo]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazVender
	}),
	new Command({
		name: "faz-decorar",
		aliases: ["faz-enfeitar"],
		description: "Posiciona ou reposiciona itens decorativos no terreno da fazenda",
		usage: "!faz-decorar <enfeite> [slot ou com imagem marcada]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazDecorar
	}),
	new Command({
		name: "faz-ranking",
		aliases: ["faz-rank"],
		description: "Exibe os rankings de riqueza ou mestres da colheita",
		usage: "!faz-ranking [riqueza|colheitas]",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazRanking
	}),
	new Command({
		name: "faz-nome",
		aliases: ["faz-fnome"],
		description: "Define ou altera o nome personalizado do seu jardim (máx 20 caracteres)",
		usage: "!faz-nome <nome>",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazNome
	}),
	new Command({
		name: "faz-ajuda",
		aliases: ["faz-help", "jardim", "fazhelp", "fazajuda"],
		description: "Exibe guia de comandos e mecânicas do Jardim das Sombras",
		usage: "!faz-ajuda",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazAjuda
	}),
	new Command({
		name: "faz-help",
		aliases: ["jardim-ajuda"],
		description: "Guia completo de comandos e mecânicas do Jardim das Sombras",
		usage: "!faz-help",
		category: "jogos",
		reply: true,
		cooldown: 3,
		method: handleFazAjuda
	})
];

// Garante que qualquer comando do módulo Fazenda colete o bônus diário automaticamente
for (const cmd of commands) {
	if (typeof cmd.method === "function") {
		cmd.method = withAutoDailyClaim(cmd.method);
	}
}

/**
 * Obtém estatísticas e deltas semanais da Fazenda (Jardim das Sombras)
 * @param {number} [sinceMs]
 * @param {boolean} [saveSnapshot=false]
 * @param {Object} [bot=null]
 * @returns {Promise<Object|null>}
 */
async function getWeeklyFazendaStats(sinceMs = null, saveSnapshot = false, bot = null) {
	try {
		const digest = await jardimClient.getDigestStats();
		if (!digest || !Array.isArray(digest.players) || digest.players.length === 0) {
			return null;
		}

		const threshold = sinceMs || Date.now() - 7 * 24 * 3600 * 1000;

		// Busca o snapshot mais recente anterior ou igual ao início da semana
		const prevSnapshots = await database.dbAll(
			DB_FAZENDA,
			`SELECT s1.player_id, s1.total_planted, s1.total_harvested, s1.total_withered, s1.coins
			 FROM fazenda_player_snapshots s1
			 INNER JOIN (
				SELECT player_id, MAX(snapshot_at) as max_snap
				FROM fazenda_player_snapshots
				WHERE snapshot_at <= ?
				GROUP BY player_id
			 ) s2 ON s1.player_id = s2.player_id AND s1.snapshot_at = s2.max_snap`,
			[threshold]
		);

		const countRow = await database.dbGet(
			DB_FAZENDA,
			"SELECT COUNT(*) as c FROM fazenda_player_snapshots"
		);
		const isFirstRun = (countRow?.c || 0) === 0;

		const snapMap = new Map();
		if (Array.isArray(prevSnapshots)) {
			for (const s of prevSnapshots) {
				snapMap.set(String(s.player_id), s);
			}
		}

		// Calcula os deltas de cada jogador
		const validPlayers = [];
		for (const p of digest.players) {
			if (isTestUser(p.id) || isSuperAdminUser(p.id)) continue;

			const resolvedName = await resolvePlayerRankingName(bot, p.id, null, null);
			const cleanNameLower = (resolvedName || "").trim().toLowerCase();
			if (
				isTestUser(resolvedName) ||
				isSuperAdminUser(resolvedName) ||
				cleanNameLower.startsWith("cultivador") ||
				cleanNameLower === "cultivador"
			) {
				continue;
			}

			const prev = snapMap.get(String(p.id));
			const deltaPlanted = prev
				? Math.max(0, (p.totalPlanted || 0) - prev.total_planted)
				: p.totalPlanted || 0;
			const deltaHarvested = prev
				? Math.max(0, (p.totalHarvested || 0) - prev.total_harvested)
				: p.totalHarvested || 0;
			const deltaWithered = prev
				? Math.max(0, (p.totalWithered || 0) - prev.total_withered)
				: p.totalWithered || 0;

			validPlayers.push({
				userId: String(p.id),
				userName: resolvedName,
				coins: p.coins || 0,
				totalPlanted: p.totalPlanted || 0,
				totalHarvested: p.totalHarvested || 0,
				totalWithered: p.totalWithered || 0,
				deltaPlanted,
				deltaHarvested,
				deltaWithered
			});
		}

		// Top 3 de cada categoria
		const topPlanted = [...validPlayers]
			.filter((p) => p.deltaPlanted > 0)
			.sort((a, b) => b.deltaPlanted - a.deltaPlanted)
			.slice(0, 3);

		const topHarvested = [...validPlayers]
			.filter((p) => p.deltaHarvested > 0)
			.sort((a, b) => b.deltaHarvested - a.deltaHarvested)
			.slice(0, 3);

		const topWithered = [...validPlayers]
			.filter((p) => p.deltaWithered > 0)
			.sort((a, b) => b.deltaWithered - a.deltaWithered)
			.slice(0, 3);

		// Jogador mais rico (ignora contas de teste, cultivador e superadmin)
		let richest = null;
		if (digest.richest && digest.richest.id) {
			const rId = String(digest.richest.id);
			const rName = await resolvePlayerRankingName(bot, digest.richest.id, null, null);
			const rNameLower = (rName || "").trim().toLowerCase();
			if (
				!isTestUser(rId) &&
				!isSuperAdminUser(rId) &&
				!isTestUser(rName) &&
				!isSuperAdminUser(rName) &&
				!rNameLower.startsWith("cultivador")
			) {
				richest = {
					userId: rId,
					userName: rName,
					coins: digest.richest.coins || 0
				};
			}
		}
		if (!richest && validPlayers.length > 0) {
			const topMoney = [...validPlayers].sort((a, b) => b.coins - a.coins)[0];
			if (topMoney) richest = topMoney;
		}

		// Planta mais colhida
		let topCrop = null;
		if (digest.topCrop && digest.topCrop.itemId) {
			const rawId = digest.topCrop.itemId.replace(/^crop_/, "");
			const plantName = PLANT_NAMES[rawId] || rawId.replace(/_/g, " ");
			topCrop = {
				name: plantName,
				count: digest.topCrop.count || 0
			};
		}

		// Jogador com mais decorações equipadas (ignora contas de teste, cultivador e superadmin/moothz)
		let topDecorator = null;
		const candidateDecorators =
			Array.isArray(digest.topDecorators) && digest.topDecorators.length > 0
				? digest.topDecorators
				: digest.topDecorator && digest.topDecorator.playerId
					? [digest.topDecorator]
					: [];

		for (const dec of candidateDecorators) {
			if (!dec || !dec.playerId) continue;
			const pId = String(dec.playerId);
			if (isTestUser(pId) || isSuperAdminUser(pId)) continue;
			const pName = await resolvePlayerRankingName(bot, pId, null, null);
			const pNameLower = (pName || "").trim().toLowerCase();
			if (isTestUser(pName) || isSuperAdminUser(pName) || pNameLower.startsWith("cultivador")) {
				continue;
			}
			topDecorator = {
				userId: pId,
				userName: pName,
				count: dec.count || 0
			};
			break;
		}

		// Salva snapshot caso solicitado (ex: no envio oficial de domingo)
		if (saveSnapshot) {
			const now = Date.now();
			for (const p of digest.players) {
				await database
					.dbRun(
						DB_FAZENDA,
						`INSERT OR REPLACE INTO fazenda_player_snapshots (player_id, total_planted, total_harvested, total_withered, coins, snapshot_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
						[
							String(p.id),
							p.totalPlanted || 0,
							p.totalHarvested || 0,
							p.totalWithered || 0,
							p.coins || 0,
							now
						]
					)
					.catch(() => {});
			}
			// Limpa snapshots com mais de 60 dias
			await database
				.dbRun(DB_FAZENDA, "DELETE FROM fazenda_player_snapshots WHERE snapshot_at < ?", [
					now - 60 * 24 * 3600 * 1000
				])
				.catch(() => {});
		}

		return {
			topPlanted,
			topHarvested,
			topWithered,
			richest,
			topCrop,
			topDecorator,
			isFirstRun
		};
	} catch (err) {
		logger.warn("Erro ao obter estatísticas semanais da fazenda:", err.message);
		return null;
	}
}

module.exports = {
	commands,
	handleFazNome,
	getWeeklyFazendaStats,
	getFarmWaifuRollBonus,
	consumeFarmWaifuRoll,
	getUserDisplayName,
	resolvePlayerRankingName,
	isTestUser,
	isSuperAdminUser,
	optimizeFarmImage,
	extractQualityFlag,
	recordFarmMessage,
	getActiveFarmMessageId,
	recordInvMessage,
	getActiveInvMessageId,
	refreshTelegramInventoryMessage,
	buildInventoryContentAndButtons,
	buildFarmViewButtons,
	handleFazendaMenuCallback,
	// Carrinho de compras (helpers puros exportados para testes)
	findShopCatalogItem,
	splitItemAndQuantity,
	resolveCartLinePurchase,
	planCartPurchase
};
