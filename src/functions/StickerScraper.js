const path = require("path");
const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const sharp = require("sharp");

const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const Database = require("../utils/Database");
const NSFWPredict = require("../utils/NSFWPredict");
const AdminUtils = require("../utils/AdminUtils");

const logger = new Logger("sticker-scraper");
const database = Database.getInstance();
const nsfwPredict = NSFWPredict.getInstance();

// Inicializa banco de dados SQLite para o Lovecell
database.getSQLiteDb(
	"lovecell",
	`CREATE TABLE IF NOT EXISTS lovecell_blacklist (
		id INTEGER PRIMARY KEY,
		reason TEXT,
		created_at TEXT
	);
	CREATE TABLE IF NOT EXISTS lovecell_stats (
		id INTEGER PRIMARY KEY,
		sent_count INTEGER DEFAULT 0,
		last_sent_at TEXT,
		created_at TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_lovecell_stats_sent ON lovecell_stats(sent_count);
	CREATE TABLE IF NOT EXISTS lovecell_sent_stickers (
		message_id TEXT PRIMARY KEY,
		sticker_id INTEGER NOT NULL,
		chat_id TEXT,
		bot_id TEXT,
		created_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_lovecell_sent_stickers_id ON lovecell_sent_stickers(sticker_id);
	CREATE INDEX IF NOT EXISTS idx_lovecell_sent_created ON lovecell_sent_stickers(created_at);`
);

// Garante migração de coluna bot_id em bases existentes
try {
	const tableInfo = database.mappers.all("lovecell", "PRAGMA table_info(lovecell_sent_stickers)");
	const hasBotId = Array.isArray(tableInfo) && tableInfo.some((col) => col.name === "bot_id");
	if (!hasBotId) {
		database.mappers.run("lovecell", "ALTER TABLE lovecell_sent_stickers ADD COLUMN bot_id TEXT");
	}
} catch {}

// Diretório para armazenar as figurinhas do Lovecell em cache (não indexado pelo git)
const LOVECELL_DIR = path.join(database.databasePath, "media", "lovecell");
const BLACKLIST_FILE = path.join(LOVECELL_DIR, "blacklist.json");

// Garante que o diretório de cache existe
try {
	if (!fs.existsSync(LOVECELL_DIR)) {
		fs.mkdirSync(LOVECELL_DIR, { recursive: true });
		logger.info(`Diretório de cache do Lovecell criado: ${LOVECELL_DIR}`);
	}
} catch (error) {
	logger.error(`Erro ao criar diretório de cache do Lovecell: ${error.message}`);
}

const MIN_STICKER_ID = 18144;
const MAX_STICKER_ID = 549200;
const MAX_QUANTITY = 4;
const BANNER_HEIGHT = 85;
const TARGET_SIZE = 512;
const MAX_STICKER_BYTES = 490 * 1024; // Limite de segurança (< 500 KB) do WhatsApp
const MIN_STICKER_BYTES = 3 * 1024; // Tamanho mínimo de 3 KB para considerar o sticker válido

// Limites de download automático: mínimo 10 stickers/min (6s), máximo 150 stickers/min (400ms)
const DEFAULT_MIN_INTERVAL_MS = parseInt(process.env.STICKER_SCRAPER_MIN_INTERVAL, 10) || 400; // Máx 150 stickers/min (400ms)
const DEFAULT_MAX_INTERVAL_MS = parseInt(process.env.STICKER_SCRAPER_MAX_INTERVAL, 10) || 6 * 1000; // Mín 10 stickers/min (6s)
const BACKOFF_RATE_LIMIT_MS =
	parseInt(process.env.STICKER_SCRAPER_BACKOFF_INTERVAL, 10) || 15 * 60 * 1000; // 15 min

const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const blacklistedIds = new Set();
const downloadedIds = new Set();

let scraperTimer = null;
let isTimerRunning = false;
let isScrapingInProgress = false;

/**
 * Carrega a blacklist persistente de figurinhas NSFW do SQLite
 */
function loadBlacklistSync() {
	blacklistedIds.clear();
	try {
		// Migração legada: se ainda existir blacklist.json residual, importa para SQLite e apaga
		if (fs.existsSync(BLACKLIST_FILE)) {
			try {
				const content = fs.readFileSync(BLACKLIST_FILE, "utf-8");
				const data = JSON.parse(content);
				if (Array.isArray(data)) {
					for (const id of data) {
						const num = parseInt(id, 10);
						if (!isNaN(num)) {
							database.mappers.run(
								"lovecell",
								"INSERT OR IGNORE INTO lovecell_blacklist (id, reason, created_at) VALUES (?, ?, ?)",
								[num, "Importado de blacklist.json", new Date().toISOString()]
							);
						}
					}
				}
				fs.unlinkSync(BLACKLIST_FILE);
				logger.info(
					"Blacklist legada (blacklist.json) migrada para o SQLite e removida com sucesso."
				);
			} catch (mErr) {
				logger.warn(`Erro na migração de blacklist.json: ${mErr.message}`);
			}
		}

		const rows = database.mappers.all("lovecell", "SELECT id FROM lovecell_blacklist");
		if (Array.isArray(rows)) {
			for (const row of rows) {
				blacklistedIds.add(row.id);
			}
		}
		logger.info(
			`Blacklist do Lovecell carregada com ${blacklistedIds.size} figurinha(s) do SQLite.`
		);
	} catch (error) {
		logger.error(`Erro ao carregar blacklist do Lovecell do SQLite: ${error.message}`);
	}
}

/**
 * Salva a blacklist persistente de figurinhas no SQLite (mantido para compatibilidade)
 */
async function saveBlacklist() {
	// A persistência é atômica via SQLite (lovecell_blacklist) em addToBlacklist()
}

/**
 * Caminho do arquivo em cache para um dado ID
 * @param {number|string} stickerId
 * @returns {string}
 */
function getStickerFilePath(stickerId) {
	return path.join(LOVECELL_DIR, `figs_lovecell_${stickerId}.webp`);
}

/**
 * Verifica se uma figurinha está na blacklist NSFW
 * @param {number|string} stickerId
 * @returns {boolean}
 */
function isBlacklisted(stickerId) {
	const id = parseInt(stickerId, 10);
	return !isNaN(id) && blacklistedIds.has(id);
}

/**
 * Adiciona um ID à blacklist NSFW, remove do cache local caso já exista e persiste no SQLite
 * @param {number|string} stickerId
 * @param {string} [reason="NSFW detectado"]
 */
async function addToBlacklist(stickerId, reason = "NSFW detectado") {
	const id = parseInt(stickerId, 10);
	if (isNaN(id)) return;

	let changed = false;
	if (!blacklistedIds.has(id)) {
		blacklistedIds.add(id);
		changed = true;
	}

	downloadedIds.delete(id);

	if (changed) {
		try {
			database.mappers.run(
				"lovecell",
				"INSERT OR REPLACE INTO lovecell_blacklist (id, reason, created_at) VALUES (?, ?, ?)",
				[id, reason, new Date().toISOString()]
			);
			logger.warn(`Figurinha #${id} adicionada à blacklist NSFW do Lovecell.`);
		} catch (dbErr) {
			logger.error(
				`Erro ao persistir figurinha #${id} no SQLite lovecell_blacklist: ${dbErr.message}`
			);
		}
	}

	// Se o arquivo existir no cache, apaga do disco imediatamente
	const cachedPath = getStickerFilePath(id);
	try {
		if (fs.existsSync(cachedPath)) {
			await fs.promises.unlink(cachedPath);
			logger.info(`Arquivo da figurinha #${id} apagado do cache local por ser NSFW.`);
		}
	} catch (err) {
		logger.error(`Erro ao apagar arquivo da figurinha #${id} do cache: ${err.message}`);
	}
}

/**
 * Indexa em memória todas as figurinhas que já foram baixadas no cache local
 */
function loadDownloadedIdsSync() {
	downloadedIds.clear();
	try {
		if (!fs.existsSync(LOVECELL_DIR)) return;
		const files = fs.readdirSync(LOVECELL_DIR);
		for (const file of files) {
			const match = file.match(/^figs_lovecell_(\d+)\.webp$/);
			if (match) {
				const id = parseInt(match[1], 10);
				if (blacklistedIds.has(id)) {
					// Se o arquivo já está na blacklist, remove do disco
					const filePath = path.join(LOVECELL_DIR, file);
					try {
						fs.unlinkSync(filePath);
						logger.info(`Arquivo #${id} removido do cache por estar na blacklist.`);
					} catch {}
				} else {
					const filePath = path.join(LOVECELL_DIR, file);
					try {
						const stat = fs.statSync(filePath);
						if (stat.size < MIN_STICKER_BYTES) {
							fs.unlinkSync(filePath);
							logger.info(
								`Arquivo #${id} removido do cache por ter tamanho inferior a 3KB (${stat.size} bytes).`
							);
						} else {
							downloadedIds.add(id);
						}
					} catch {
						downloadedIds.add(id);
					}
				}
			}
		}
		logger.info(`Estoque offline do Lovecell indexado com ${downloadedIds.size} figurinha(s).`);
	} catch (err) {
		logger.error(`Erro ao indexar figurinhas baixadas do Lovecell: ${err.message}`);
	}
}

// Inicializa blacklist e estoque local baixado
loadBlacklistSync();
loadDownloadedIdsSync();

/**
 * Inicializa e sincroniza estatísticas de figurinhas no SQLite.
 * Considera todas as figurinhas atuais no disco como sent_count = 1 se ainda não tiverem registro.
 */
function initStickerStatsSync() {
	try {
		database.mappers.exec(
			"lovecell",
			`CREATE TABLE IF NOT EXISTS lovecell_stats (
				id INTEGER PRIMARY KEY,
				sent_count INTEGER DEFAULT 0,
				last_sent_at TEXT,
				created_at TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_lovecell_stats_sent ON lovecell_stats(sent_count);`
		);

		if (fs.existsSync(LOVECELL_DIR)) {
			const files = fs.readdirSync(LOVECELL_DIR);
			const rows = database.mappers.all("lovecell", "SELECT id FROM lovecell_stats");
			const recordedIds = new Set(Array.isArray(rows) ? rows.map((r) => r.id) : []);
			const now = new Date().toISOString();

			for (const file of files) {
				const match = file.match(/^figs_lovecell_(\d+)\.webp$/);
				if (match) {
					const id = parseInt(match[1], 10);
					if (!isNaN(id) && !recordedIds.has(id)) {
						database.mappers.run(
							"lovecell",
							"INSERT OR IGNORE INTO lovecell_stats (id, sent_count, last_sent_at, created_at) VALUES (?, 1, ?, ?)",
							[id, now, now]
						);
						recordedIds.add(id);
					}
				}
			}
		}
		logger.info("Estatísticas de envio de figurinhas do Lovecell sincronizadas no SQLite.");
	} catch (error) {
		logger.error(`Erro ao inicializar lovecell_stats no SQLite: ${error.message}`);
	}
}

initStickerStatsSync();

/**
 * Registra o envio de uma figurinha, incrementando seu contador em SQLite
 * @param {number|string} stickerId
 */
function recordStickerSent(stickerId) {
	const id = parseInt(stickerId, 10);
	if (isNaN(id)) return;
	try {
		const now = new Date().toISOString();
		database.mappers.run(
			"lovecell",
			`INSERT INTO lovecell_stats (id, sent_count, last_sent_at, created_at)
			 VALUES (?, 1, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET sent_count = sent_count + 1, last_sent_at = excluded.last_sent_at`,
			[id, now, now]
		);
	} catch (err) {
		logger.error(`Erro ao registrar envio da figurinha #${id} no SQLite: ${err.message}`);
	}
}

/**
 * Retorna as estatísticas de envio de uma figurinha
 * @param {number|string} stickerId
 * @returns {{ id: number, sentCount: number, lastSentAt: string|null, createdAt: string|null }|null}
 */
function getStickerStats(stickerId) {
	const id = parseInt(stickerId, 10);
	if (isNaN(id)) return null;
	try {
		const row = database.mappers.get(
			"lovecell",
			"SELECT id, sent_count, last_sent_at, created_at FROM lovecell_stats WHERE id = ?",
			[id]
		);
		if (row) {
			return {
				id: row.id,
				sentCount: typeof row.sent_count === "number" ? row.sent_count : 0,
				lastSentAt: row.last_sent_at || null,
				createdAt: row.created_at || null
			};
		}
		return null;
	} catch {
		return null;
	}
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
 * Registra o ID da mensagem enviada associada ao ID da figurinha do Lovecell
 * @param {string} messageId - ID retornado no envio da mensagem
 * @param {number|string} stickerId - ID da figurinha no Lovecell
 * @param {string|null} [chatId=null] - Chat onde foi enviada
 * @param {string|null} [botId=null] - ID da instância do bot que enviou/recebeu a figurinha
 */
function recordSentStickerMessage(messageId, stickerId, chatId = null, botId = null) {
	if (!messageId || !stickerId) return;
	const id = parseInt(stickerId, 10);
	if (isNaN(id)) return;

	const strId = String(messageId);
	const stanzaId = extractStanzaId(strId);

	try {
		const now = new Date().toISOString();
		database.mappers.run(
			"lovecell",
			`INSERT OR REPLACE INTO lovecell_sent_stickers (message_id, sticker_id, chat_id, bot_id, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
			[stanzaId, id, chatId ? String(chatId) : null, botId ? String(botId) : null, now]
		);
		if (strId !== stanzaId) {
			database.mappers.run(
				"lovecell",
				`INSERT OR REPLACE INTO lovecell_sent_stickers (message_id, sticker_id, chat_id, bot_id, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[strId, id, chatId ? String(chatId) : null, botId ? String(botId) : null, now]
			);
		}
	} catch (err) {
		logger.error(`Erro ao registrar sent sticker message #${id} (${messageId}): ${err.message}`);
	}
}

/**
 * Recupera todas as mensagens enviadas/reportadas vinculadas a uma figurinha no SQLite
 * @param {number|string} stickerId
 * @returns {Array<{ messageId: string, chatId: string, botId: string|null }>}
 */
function getMessagesForSticker(stickerId) {
	if (!stickerId) return [];
	const id = parseInt(stickerId, 10);
	if (isNaN(id)) return [];

	try {
		const rows = database.mappers.all(
			"lovecell",
			"SELECT message_id, chat_id, bot_id FROM lovecell_sent_stickers WHERE sticker_id = ?",
			[id]
		);
		if (!Array.isArray(rows)) return [];

		// Deduplica por chat_id e stanzaId
		const uniqueMessages = [];
		const seen = new Set();
		for (const r of rows) {
			const stanzaId = extractStanzaId(String(r.message_id));
			const key = `${r.chat_id}_${stanzaId}`;
			if (!seen.has(key)) {
				seen.add(key);
				uniqueMessages.push({
					messageId: stanzaId,
					chatId: r.chat_id,
					botId: r.bot_id || null
				});
			}
		}
		return uniqueMessages;
	} catch (err) {
		logger.error(`Erro ao obter mensagens da figurinha #${id}: ${err.message}`);
		return [];
	}
}

/**
 * Busca o ID da figurinha correspondente ao ID da mensagem
 * @param {string} messageId
 * @returns {number|null}
 */
function getStickerIdByMessageId(messageId) {
	if (!messageId) return null;
	const strId = String(messageId);
	const stanzaId = extractStanzaId(strId);

	try {
		const row =
			database.mappers.get(
				"lovecell",
				"SELECT sticker_id FROM lovecell_sent_stickers WHERE message_id = ?",
				[stanzaId]
			) ||
			database.mappers.get(
				"lovecell",
				"SELECT sticker_id FROM lovecell_sent_stickers WHERE message_id = ?",
				[strId]
			);
		return row ? row.sticker_id : null;
	} catch {
		return null;
	}
}

/**
 * Tenta extrair o ID da figurinha do Lovecell a partir da mensagem citada
 * @param {Object} quotedMsg - Objeto da mensagem citada
 * @param {string|null} [directQuotedId=null] - ID direto da mensagem citada (stanzaID)
 * @returns {Promise<number|null>}
 */
async function getStickerIdFromMessage(quotedMsg, directQuotedId = null) {
	// 1. Tenta por directQuotedId
	if (directQuotedId) {
		const id = getStickerIdByMessageId(directQuotedId);
		if (id) return id;
	}

	// 2. Tenta por quotedMsg.id
	if (quotedMsg?.id) {
		const id = getStickerIdByMessageId(quotedMsg.id);
		if (id) return id;
	}

	// 3. Tenta por quotedMsg.origin.id._serialized
	if (quotedMsg?.origin?.id?._serialized) {
		const id = getStickerIdByMessageId(quotedMsg.origin.id._serialized);
		if (id) return id;
	}

	// 4. Tenta por nome do arquivo em content ou caption (se ainda estiver em cache)
	const filename = quotedMsg?.content?.filename || quotedMsg?.filename;
	if (typeof filename === "string") {
		const match = filename.match(/figs_lovecell_(\d+)\.webp/i);
		if (match) {
			const id = parseInt(match[1], 10);
			if (!isNaN(id)) return id;
		}
	}

	// 5. Tenta por texto/caption se tiver "Lovecell #12345"
	const captionOrBody = quotedMsg?.caption || quotedMsg?.body || quotedMsg?.content;
	if (typeof captionOrBody === "string") {
		const match = captionOrBody.match(/lovecell(?:\.com\.br\/figurinhas\/|[\s#]+)(\d+)/i);
		if (match) {
			const id = parseInt(match[1], 10);
			if (!isNaN(id)) return id;
		}
	}

	return null;
}

/**
 * Remove uma figurinha do Lovecell: adiciona à blacklist, remove do cache local,
 * limpa estatísticas e limpa registros de envio
 * @param {number|string} stickerId
 * @param {string} [reason="Removido manualmente"]
 * @returns {Promise<{ success: boolean, deletedFile: boolean, id: number }>}
 */
async function removeFromLovecell(stickerId, reason = "Removido manualmente") {
	const id = parseInt(stickerId, 10);
	if (isNaN(id) || id < 1) {
		return { success: false, deletedFile: false, id, associatedMessages: [] };
	}

	// Obtém mensagens associadas antes de limpar registros do SQLite
	const associatedMessages = getMessagesForSticker(id);

	const cachedPath = getStickerFilePath(id);
	let deletedFile = false;
	try {
		if (fs.existsSync(cachedPath)) {
			await fs.promises.unlink(cachedPath);
			deletedFile = true;
		}
	} catch (e) {
		logger.error(`Erro ao remover arquivo da figurinha #${id} do cache: ${e.message}`);
	}

	// Adiciona à blacklist (também remove de downloadedIds e atualiza SQLite)
	await addToBlacklist(id, reason);

	// Remove das estatísticas
	try {
		database.mappers.run("lovecell", "DELETE FROM lovecell_stats WHERE id = ?", [id]);
	} catch (err) {
		logger.warn(`Erro ao deletar stats da figurinha #${id}: ${err.message}`);
	}

	// Remove do rastreamento de enviadas
	try {
		database.mappers.run("lovecell", "DELETE FROM lovecell_sent_stickers WHERE sticker_id = ?", [
			id
		]);
	} catch (err) {
		logger.warn(`Erro ao deletar sent_stickers da figurinha #${id}: ${err.message}`);
	}

	return { success: true, deletedFile, id, associatedMessages };
}

/**
 * Remove múltiplas figurinhas do Lovecell em lote
 * @param {Array<number|string>} stickerIds
 * @param {string} [reason="Removido manualmente"]
 * @returns {Promise<{ removedCount: number, results: Array<{ id: number, success: boolean, deletedFile: boolean }> }>}
 */
async function removeMultipleFromLovecell(stickerIds, reason = "Removido manualmente") {
	if (!Array.isArray(stickerIds)) return { removedCount: 0, results: [] };
	const uniqueIds = Array.from(
		new Set(stickerIds.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id) && id > 0))
	);

	const results = [];
	for (const id of uniqueIds) {
		const res = await removeFromLovecell(id, reason);
		results.push(res);
	}

	const removedCount = results.filter((r) => r.success).length;
	return { removedCount, results };
}

/**
 * Verifica se a figurinha já foi baixada no cache local
 * @param {number|string} stickerId
 * @returns {boolean}
 */
function isDownloaded(stickerId) {
	const id = parseInt(stickerId, 10);
	if (isNaN(id) || module.exports.isBlacklisted(id)) return false;
	return downloadedIds.has(id) || fs.existsSync(getStickerFilePath(id));
}

/**
 * Limpa o título extraído da página para exibição como nome da figurinha
 * @param {string} rawTitle - Título original extraído da tag og:title ou <title>
 * @returns {string} - Título formatado
 */
function cleanTitle(rawTitle) {
	if (!rawTitle || typeof rawTitle !== "string") return "Lovecell";
	let title = rawTitle.trim();
	title = title.replace(/^Figurinha\s*/i, "");
	title = title.replace(/\s*para WhatsApp$/i, "");
	title = title.replace(/^["'“”«»]+|["'“”«»]+$/g, "").trim();
	if (!title || title.toLowerCase() === "lovecell") {
		return "Lovecell";
	}
	return title.substring(0, 64);
}

/**
 * Recorta os últimos 85 pixels inferiores (banner promocional do Lovecell)
 * e garante que o sticker resultante tenha exatamente 512x512 pixels.
 * Suporta WebP estático e animado.
 *
 * @param {Buffer} webpBuffer - Buffer do WebP original
 * @returns {Promise<Buffer>} - Buffer do WebP recortado (512x512)
 */
async function cropLovecellBanner(webpBuffer) {
	const isAnim = await (async () => {
		try {
			const check = sharp(webpBuffer, { animated: true });
			const m = await check.metadata();
			return Boolean(m.pages && m.pages > 1);
		} catch {
			return false;
		}
	})();

	const meta = await sharp(webpBuffer, { animated: isAnim }).metadata();
	const pageHeight = meta.pageHeight || meta.height;
	const width = meta.width;

	let cropHeight = pageHeight;
	if (pageHeight > BANNER_HEIGHT) {
		cropHeight = pageHeight - BANNER_HEIGHT;
	}

	const extractWidth = Math.min(width, TARGET_SIZE);
	const extractHeight = Math.min(cropHeight, TARGET_SIZE);

	let pipeline = sharp(webpBuffer, { animated: isAnim }).extract({
		left: 0,
		top: 0,
		width: extractWidth,
		height: extractHeight
	});

	if (extractWidth !== TARGET_SIZE || extractHeight !== TARGET_SIZE) {
		pipeline = pipeline.resize(TARGET_SIZE, TARGET_SIZE, {
			fit: "contain",
			background: { r: 0, g: 0, b: 0, alpha: 0 }
		});
	}

	let croppedBuffer = await pipeline
		.webp({
			quality: isAnim ? 60 : 80,
			effort: isAnim ? 4 : 6
		})
		.toBuffer();

	// Limite de segurança de tamanho para stickers animados no WhatsApp
	if (isAnim && croppedBuffer.length > MAX_STICKER_BYTES) {
		for (const q of [45, 30, 20]) {
			const reencoded = await sharp(croppedBuffer, { animated: true })
				.webp({ quality: q, effort: 4 })
				.toBuffer();
			if (reencoded.length <= MAX_STICKER_BYTES || q === 20) {
				croppedBuffer = reencoded;
				break;
			}
		}
	}

	return croppedBuffer;
}

/**
 * Retorna o caminho do arquivo em cache se já existir, tiver tamanho válido e não estiver na blacklist
 * @param {number|string} stickerId
 * @returns {string|null}
 */
function getStickerFromCache(stickerId) {
	const id = parseInt(stickerId, 10);
	if (!isNaN(id) && module.exports.isBlacklisted(id)) {
		return null;
	}
	const filePath = getStickerFilePath(stickerId);
	try {
		if (fs.existsSync(filePath)) {
			const stat = fs.statSync(filePath);
			if (stat.size < MIN_STICKER_BYTES) {
				logger.warn(
					`Figurinha #${id} no cache tem tamanho inferior a 3KB (${stat.size} bytes). Removendo do cache.`
				);
				try {
					fs.unlinkSync(filePath);
				} catch {}
				if (!isNaN(id)) {
					downloadedIds.delete(id);
				}
				return null;
			}
			return filePath;
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Salva a figurinha já recortada em disco caso seja válida (>= 3KB e não blacklisted)
 * @param {number|string} stickerId
 * @param {Buffer} buffer
 * @returns {Promise<string|null>}
 */
async function saveStickerToCache(stickerId, buffer) {
	const id = parseInt(stickerId, 10);
	if (!isNaN(id) && module.exports.isBlacklisted(id)) {
		logger.warn(`Tentativa de salvar figurinha #${id} que está na blacklist abortada.`);
		return null;
	}

	if (!buffer || buffer.length < MIN_STICKER_BYTES) {
		logger.warn(
			`Tentativa de salvar figurinha #${stickerId} inválida com tamanho inferior a 3KB (${buffer?.length || 0} bytes) abortada.`
		);
		return null;
	}

	const filePath = getStickerFilePath(stickerId);
	try {
		await fs.promises.writeFile(filePath, buffer);
		if (!isNaN(id)) {
			downloadedIds.add(id);
			try {
				const now = new Date().toISOString();
				database.mappers.run(
					"lovecell",
					"INSERT OR IGNORE INTO lovecell_stats (id, sent_count, last_sent_at, created_at) VALUES (?, 0, NULL, ?)",
					[id, now]
				);
			} catch {}
		}
		logger.info(`Figurinha salva em cache: ${filePath}`);
		return filePath;
	} catch (error) {
		logger.error(`Erro ao salvar figurinha em cache: ${error.message}`);
		return null;
	}
}

/**
 * Busca figurinhas aleatórias já salvas no cache local do Lovecell (ignora blacklisted e < 3KB).
 * Prioriza figurinhas nunca enviadas (sent_count = 0) ou pouco enviadas (sent_count menor)
 * para evitar repetição excessiva para os usuários.
 *
 * @param {number} count - Quantidade desejada
 * @param {Set<number|string>} excludeIds - IDs a excluir
 * @returns {Promise<Array<{ id: number|string, buffer: Buffer }>>}
 */
async function getRandomCachedStickers(count = 1, excludeIds = new Set()) {
	try {
		if (!fs.existsSync(LOVECELL_DIR)) return [];
		const files = await fs.promises.readdir(LOVECELL_DIR);
		const stickerFiles = files.filter((f) => f.startsWith("figs_lovecell_") && f.endsWith(".webp"));

		const filterValidFile = (f, checkExclude = true) => {
			const match = f.match(/^figs_lovecell_(\d+)\.webp$/);
			if (!match) return false;
			const id = parseInt(match[1], 10);
			if (checkExclude && excludeIds.has(id)) return false;
			if (module.exports.isBlacklisted(id)) return false;
			try {
				const fullPath = path.join(LOVECELL_DIR, f);
				const stat = fs.statSync(fullPath);
				if (stat.size < MIN_STICKER_BYTES) {
					try {
						fs.unlinkSync(fullPath);
					} catch {}
					downloadedIds.delete(id);
					return false;
				}
				return true;
			} catch {
				return false;
			}
		};

		let available = stickerFiles.filter((f) => filterValidFile(f, true));

		if (available.length === 0 && stickerFiles.length > 0) {
			available = stickerFiles.filter((f) => filterValidFile(f, false));
		}

		if (available.length === 0) return [];

		// Carrega estatísticas de envio do SQLite para priorizar figurinhas nunca ou pouco enviadas
		const statsMap = new Map();
		try {
			const rows = database.mappers.all(
				"lovecell",
				"SELECT id, sent_count, last_sent_at FROM lovecell_stats"
			);
			if (Array.isArray(rows)) {
				for (const row of rows) {
					statsMap.set(row.id, {
						sentCount: typeof row.sent_count === "number" ? row.sent_count : 0,
						lastSentAt: row.last_sent_at || null
					});
				}
			}
		} catch (dbErr) {
			logger.warn(`Não foi possível ler lovecell_stats no SQLite: ${dbErr.message}`);
		}

		// Mapeia os candidatos válidos com seus contadores de envio
		const candidates = available.map((filename) => {
			const match = filename.match(/^figs_lovecell_(\d+)\.webp$/);
			const id = match ? parseInt(match[1], 10) : filename;
			const stats = statsMap.get(id);
			// Se o arquivo existe no disco mas ainda não está registrado, considera como 1
			const sentCount = stats ? stats.sentCount : 1;
			const lastSentAt = stats?.lastSentAt || null;
			return { filename, id, sentCount, lastSentAt };
		});

		// Agrupa candidatos por faixa de envio (sentCount: 0, 1, 2, ...)
		const groupsByCount = new Map();
		for (const cand of candidates) {
			if (!groupsByCount.has(cand.sentCount)) {
				groupsByCount.set(cand.sentCount, []);
			}
			groupsByCount.get(cand.sentCount).push(cand);
		}

		// Ordena os níveis de prioridade do menor para o maior (0 = nunca enviadas, depois 1, 2, etc.)
		const sortedLevels = Array.from(groupsByCount.keys()).sort((a, b) => a - b);

		const selectedCandidates = [];
		for (const level of sortedLevels) {
			if (selectedCandidates.length >= count) break;

			const tierItems = groupsByCount.get(level);

			// Embaralha aleatoriamente (Fisher-Yates) os itens dentro do mesmo nível para variar a ordem
			for (let i = tierItems.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[tierItems[i], tierItems[j]] = [tierItems[j], tierItems[i]];
			}

			const needed = count - selectedCandidates.length;
			selectedCandidates.push(...tierItems.slice(0, needed));
		}

		const results = [];
		for (const item of selectedCandidates) {
			const fullPath = path.join(LOVECELL_DIR, item.filename);
			const buffer = await fs.promises.readFile(fullPath);
			if (buffer.length >= MIN_STICKER_BYTES) {
				results.push({ id: item.id, buffer });
			}
		}
		return results;
	} catch (err) {
		logger.error(`Erro ao obter figurinhas aleatórias do cache: ${err.message}`);
		return [];
	}
}

/**
 * Realiza scraping sob demanda de um ID específico no Lovecell
 * @param {number|string} stickerId
 * @returns {Promise<{ found: boolean, rateLimit?: boolean, buffer?: Buffer, title?: string, imageUrl?: string, error?: string }>}
 */
async function fetchLovecellSticker(stickerId) {
	const url = `https://lovecell.com.br/figurinhas/${stickerId}`;

	try {
		const response = await axios.get(url, {
			headers: {
				"User-Agent": BROWSER_UA,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8"
			},
			timeout: 10000,
			validateStatus: (status) => status < 500
		});

		if (response.status === 429) {
			logger.warn(`Lovecell HTTP 429 (Rate Limit) no ID ${stickerId}`);
			return { found: false, rateLimit: true };
		}

		if (response.status === 403) {
			logger.warn(`Lovecell HTTP 403 (Bloqueio/WAF) no ID ${stickerId}`);
			return { found: false, rateLimit: true };
		}

		if (response.status !== 200) {
			return { found: false };
		}

		const $ = cheerio.load(response.data);
		const imageUrl = $('meta[property="og:image"]').attr("content");

		if (!imageUrl || !imageUrl.includes("img2.lovecell.com.br")) {
			return { found: false };
		}

		const rawTitle = $('meta[property="og:title"]').attr("content") || $("title").text().trim();
		const title = cleanTitle(rawTitle);

		// Download do buffer da imagem webp
		const imgResponse = await axios.get(imageUrl, {
			responseType: "arraybuffer",
			headers: {
				"User-Agent": BROWSER_UA,
				Accept: "image/webp,image/*,*/*;q=0.8"
			},
			timeout: 10000,
			validateStatus: (status) => status === 200
		});

		const buffer = Buffer.from(imgResponse.data);
		if (buffer.length < MIN_STICKER_BYTES) {
			logger.warn(
				`Figurinha #${stickerId} obtida com tamanho inferior a 3KB (${buffer.length} bytes). Considerando inválida.`
			);
			return {
				found: false,
				invalid: true,
				tooSmall: true
			};
		}

		return {
			found: true,
			buffer,
			title,
			imageUrl
		};
	} catch (error) {
		if (error.response?.status === 429 || error.response?.status === 403) {
			return { found: false, rateLimit: true };
		}
		logger.warn(`Erro ao consultar figurinha ${stickerId}: ${error.message}`);
		return { found: false, error: error.message };
	}
}

/**
 * Extrai frames de um WebP animado para análise temporal completa pela LLM.
 * Se o WebP for estático, retorna apenas o frame único em base64.
 * @param {Buffer} buffer - Buffer WebP
 * @param {number} maxFrames - Quantidade máxima de frames a extrair (padrão: 6)
 * @returns {Promise<string[]>} - Array de strings base64 dos frames
 */
async function extractFramesForAnalysis(buffer, maxFrames = 6) {
	try {
		const meta = await sharp(buffer, { animated: true }).metadata();
		const totalPages = meta.pages || 1;

		if (totalPages <= 1) {
			return [buffer.toString("base64")];
		}

		// Distribui a extração de forma uniforme pela duração da animação
		const step = Math.max(1, Math.floor(totalPages / maxFrames));
		const indices = [];
		for (let i = 0; i < totalPages; i += step) {
			indices.push(i);
			if (indices.length >= maxFrames) break;
		}

		// Garante que o último frame esteja incluído na amostragem se houver espaço
		if (!indices.includes(totalPages - 1) && indices.length < maxFrames) {
			indices.push(totalPages - 1);
		}

		const framesBase64 = await Promise.all(
			indices.map(async (pageIdx) => {
				const frameBuf = await sharp(buffer, { page: pageIdx }).jpeg({ quality: 80 }).toBuffer();
				return frameBuf.toString("base64");
			})
		);

		logger.debug(
			`Extraídos ${framesBase64.length} frames de WebP animado (${totalPages} páginas) para análise NSFW.`
		);
		return framesBase64;
	} catch (error) {
		logger.warn(
			`Falha ao extrair múltiplos frames do WebP (${error.message}); analisando frame padrão.`
		);
		return [buffer.toString("base64")];
	}
}

// Padrões de texto estritamente proibidos em títulos ou metadados de figurinhas
const FORBIDDEN_TITLE_PATTERNS = [
	/\bhora\s+d[oe]\s+abuso\b/i,
	/\babuso\s+sexual\b/i,
	/\b(estupro|estuprar|estuprador)\b/i,
	/\bpedofilia|pedofilo|pedófilo\b/i,
	/\b(nazis(mo|ta)?|hitler|swastika|su[aá]stica|sol\s+negro|sonnenrad)\b/i,
	/\b(white\s+power|ku\s+klux\s+klan|aryan\s+brotherhood)\b/i,
	/\b(decapita[cç][aã]o|mutila[cç][aã]o|esquarteja(do|r))\b/i
];

/**
 * Verifica se um texto/título contém termos proibidos (abuso, estupro, nazismo, etc.)
 * @param {string} text
 * @returns {boolean}
 */
function isForbiddenText(text) {
	if (!text || typeof text !== "string") return false;
	return FORBIDDEN_TITLE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Avalia se o buffer de uma figurinha contém conteúdo adulto ou impróprio via NSFWPredict com moderação estrita.
 * Verifica pornografia/NSFW, apologia ao nazismo, fotos de crianças reais, referências a estupro/abuso
 * (ex: "hora do abuso") e violência extrema/gore.
 *
 * @param {Buffer} buffer - Buffer WebP da figurinha
 * @param {number|string} stickerId - ID para logging e rastreamento
 * @param {Object|string} [extraContext] - Contexto opcional contendo título/metadados
 * @returns {Promise<boolean>} - true se for impróprio/NSFW, false se seguro
 */
async function checkStickerNSFW(buffer, stickerId, extraContext = {}) {
	try {
		const title = typeof extraContext === "string" ? extraContext : extraContext?.title || "";

		// 1. Verificação rápida local: se o título contiver termos proibidos conhecidos (ex: "hora do abuso", "nazismo", etc.)
		if (title && isForbiddenText(title)) {
			logger.warn(
				`Figurinha #${stickerId} bloqueada imediatamente por título proibido: "${title}"`
			);
			return true;
		}

		// 2. Análise profunda multimodal via LLM com regras estritas de moderação
		const frames = await module.exports.extractFramesForAnalysis(buffer, 6);
		const result = await nsfwPredict.detectNSFW(frames, {
			isSticker: true,
			type: "sticker",
			stickerId,
			title,
			forceLLM: true,
			skipNudeNet: true,
			strictModeration: true
		});

		if (result?.isNSFW) {
			logger.warn(
				`Figurinha #${stickerId} bloqueada pelo filtro de moderação (${result.category || "impróprio"}): ${result.reason || "conteúdo impróprio detectado"}`
			);
			return true;
		}
		return false;
	} catch (error) {
		logger.error(`Erro ao verificar moderação para figurinha #${stickerId}: ${error.message}`);
		return false;
	}
}

/**
 * Sorteia um ID de figurinha dentro da faixa do Lovecell que ainda não tenha sido baixado e não esteja na blacklist
 * @param {number} maxAttempts
 * @returns {number|null}
 */
function getRandomUndownloadedId(maxAttempts = 1000) {
	for (let i = 0; i < maxAttempts; i++) {
		const id = Math.floor(Math.random() * (MAX_STICKER_ID - MIN_STICKER_ID + 1)) + MIN_STICKER_ID;
		if (
			!downloadedIds.has(id) &&
			!module.exports.isBlacklisted(id) &&
			!fs.existsSync(getStickerFilePath(id))
		) {
			return id;
		}
	}
	return null;
}

/**
 * Cria um objeto ReturnMessage para uma figurinha
 * @param {string} chatId
 * @param {Buffer} buffer
 * @param {number|string} stickerId
 * @param {string} title
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @returns {ReturnMessage}
 */
function buildStickerReturnMessage(chatId, buffer, stickerId, title, bot, message) {
	const media = {
		mimetype: "image/webp",
		data: buffer.toString("base64"),
		filename: `figs_lovecell_${stickerId}.webp`,
		isMessageMedia: true
	};

	return new ReturnMessage({
		chatId,
		content: media,
		options: {
			sendMediaAsSticker: true,
			stickerAuthor: bot?.nomeExibir || "ravena",
			stickerName: title || `Lovecell #${stickerId}`,
			lovecellStickerId: stickerId
		}
	});
}

/**
 * Executa o comando de envio de figurinha do Lovecell (busca e envia figurinha aleatória ou por ID)
 * Aceita parâmetro opcional de quantidade (1 a 4) ou ID específico.
 *
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array<string>} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>}
 */
async function stickerScraperCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const arg = args[0]?.trim();
		let targetQuantity = 1;
		let specificId = null;

		const configuredMax = parseInt(bot?.extras?.stickers?.maxFiga, 10);
		const maxQuantity = !isNaN(configuredMax) && configuredMax > 0 ? configuredMax : MAX_QUANTITY;

		if (arg && /^\d+$/.test(arg)) {
			const parsed = parseInt(arg, 10);
			if (parsed >= MIN_STICKER_ID) {
				// Número alto: ID específico da figurinha
				specificId = parsed;
			} else if (parsed > 0) {
				// Quantidade solicitada (limitada pelo maxQuantity do bot ou padrão MAX_QUANTITY)
				targetQuantity = Math.min(maxQuantity, parsed);
			}
		}

		// 1. Caso tenha sido especificado um ID numérico da figurinha
		if (specificId) {
			if (module.exports.isBlacklisted(specificId)) {
				return new ReturnMessage({
					chatId,
					content: `⚠️ A figurinha #${specificId} foi bloqueada por conter conteúdo impróprio (NSFW).`
				});
			}

			const cachedPath = module.exports.getStickerFromCache(specificId);
			if (cachedPath) {
				logger.info(`Usando figurinha em cache para ID ${specificId}`);
				const fileBuf = await fs.promises.readFile(cachedPath);
				module.exports.recordStickerSent(specificId);
				return buildStickerReturnMessage(
					chatId,
					fileBuf,
					specificId,
					`Lovecell #${specificId}`,
					bot,
					message
				);
			}

			const result = await module.exports.fetchLovecellSticker(specificId);
			if (result.rateLimit) {
				// Em caso de rate-limit, busca uma figurinha aleatória já baixada no cache
				const fallback = await module.exports.getRandomCachedStickers(1);
				if (fallback.length > 0) {
					logger.info(
						`Rate limit atingido para ID ${specificId}. Usando figurinha #${fallback[0].id} do cache local como fallback.`
					);
					module.exports.recordStickerSent(fallback[0].id);
					return buildStickerReturnMessage(
						chatId,
						fallback[0].buffer,
						fallback[0].id,
						`Lovecell #${fallback[0].id}`,
						bot,
						message
					);
				}

				return new ReturnMessage({
					chatId,
					content:
						"⚠️ O serviço do Lovecell está temporariamente indisponível no momento devido a limite de requisições. Tente novamente mais tarde."
				});
			}

			if (!result.found || !result.buffer || result.buffer.length < MIN_STICKER_BYTES) {
				return new ReturnMessage({
					chatId,
					content: `Figurinha #${specificId} não foi encontrada ou é inválida no Lovecell.`
				});
			}

			const croppedBuffer = await module.exports.cropLovecellBanner(result.buffer);
			if (croppedBuffer.length < MIN_STICKER_BYTES) {
				logger.warn(
					`Figurinha #${specificId} ficou com tamanho inferior a 3KB (${croppedBuffer.length} bytes) após corte do banner. Descartando.`
				);
				return new ReturnMessage({
					chatId,
					content: `Figurinha #${specificId} é inválida.`
				});
			}

			// Verificação NSFW e moderação estrita para ID específico
			const isNsfw = await module.exports.checkStickerNSFW(croppedBuffer, specificId, {
				title: result.title
			});
			if (isNsfw) {
				await module.exports.addToBlacklist(specificId);
				return new ReturnMessage({
					chatId,
					content: `⚠️ A figurinha #${specificId} foi bloqueada por conter conteúdo impróprio (NSFW, apologia a ódio/abuso ou violação de diretrizes).`
				});
			}

			await module.exports.saveStickerToCache(specificId, croppedBuffer);
			module.exports.recordStickerSent(specificId);

			return buildStickerReturnMessage(
				chatId,
				croppedBuffer,
				specificId,
				result.title || `Lovecell #${specificId}`,
				bot,
				message
			);
		}

		// 2. Modo aleatório (seleciona figurinhas já baixadas diretamente da pasta local / cache)
		// Otimização: entrega imediata sem necessidade de download ou análise NSFW em tempo de requisição
		const returnMessages = [];
		const usedIds = new Set();

		const cachedStickers = await module.exports.getRandomCachedStickers(targetQuantity, usedIds);
		for (const item of cachedStickers) {
			usedIds.add(item.id);
			module.exports.recordStickerSent(item.id);
			returnMessages.push(
				buildStickerReturnMessage(
					chatId,
					item.buffer,
					item.id,
					`Lovecell #${item.id}`,
					bot,
					message
				)
			);
		}

		// Fallback: se o estoque local estiver vazio ou insuficiente (ex: instalação nova), busca online
		if (returnMessages.length < targetQuantity) {
			let rateLimited = false;
			const needed = targetQuantity - returnMessages.length;
			const maxAttempts = 15 * needed;

			for (
				let attempt = 1;
				attempt <= maxAttempts && returnMessages.length < targetQuantity;
				attempt++
			) {
				const randomId =
					Math.floor(Math.random() * (MAX_STICKER_ID - MIN_STICKER_ID + 1)) + MIN_STICKER_ID;

				if (usedIds.has(randomId) || module.exports.isBlacklisted(randomId)) continue;
				usedIds.add(randomId);

				const result = await module.exports.fetchLovecellSticker(randomId);
				if (result.rateLimit) {
					rateLimited = true;
					break;
				}

				if (result.found && result.buffer && result.buffer.length >= MIN_STICKER_BYTES) {
					const croppedBuffer = await module.exports.cropLovecellBanner(result.buffer);
					if (croppedBuffer.length < MIN_STICKER_BYTES) continue;

					// Verificação NSFW e moderação estrita
					const isNsfw = await module.exports.checkStickerNSFW(croppedBuffer, randomId, {
						title: result.title
					});
					if (isNsfw) {
						await module.exports.addToBlacklist(randomId);
						continue;
					}

					await module.exports.saveStickerToCache(randomId, croppedBuffer);
					module.exports.recordStickerSent(randomId);

					returnMessages.push(
						buildStickerReturnMessage(
							chatId,
							croppedBuffer,
							randomId,
							result.title || `Lovecell #${randomId}`,
							bot,
							message
						)
					);
				}
			}

			if (returnMessages.length === 0 && rateLimited) {
				return new ReturnMessage({
					chatId,
					content:
						"⚠️ O serviço do Lovecell está temporariamente indisponível no momento devido a limite de requisições. Tente novamente mais tarde."
				});
			}
		}

		if (returnMessages.length > 0) {
			return returnMessages;
		}

		return new ReturnMessage({
			chatId,
			content:
				"Não foi possível encontrar figurinhas disponíveis no momento. Por favor, tente novamente em instantes."
		});
	} catch (error) {
		logger.error(`Erro ao processar comando sticker-scraper: ${error.message}`, error);
		return new ReturnMessage({
			chatId,
			content: "Ocorreu um erro ao buscar a figurinha. Por favor, tente novamente mais tarde."
		});
	}
}

/**
 * Retorna intervalo aleatório em milissegundos
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function getRandomInterval(min = DEFAULT_MIN_INTERVAL_MS, max = DEFAULT_MAX_INTERVAL_MS) {
	const lower = Math.min(min, max);
	const upper = Math.max(min, max);
	return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

/**
 * Executa um ciclo do background scraper:
 * Sorteia um número que ainda não foi baixado, faz o download do Lovecell,
 * recorta o banner inferior (85px), passa pelo filtro NSFW (descartando e blacklisting se positivo)
 * e salva no estoque offline.
 */
async function runBackgroundScraperTick() {
	if (isScrapingInProgress) {
		logger.debug(
			"Ciclo do background scraper ignorado: download/processamento anterior ainda em andamento."
		);
		return;
	}
	isScrapingInProgress = true;

	try {
		const maxAttemptsPerTick = 5;
		for (let attempt = 1; attempt <= maxAttemptsPerTick; attempt++) {
			const candidateId = module.exports.getRandomUndownloadedId();
			if (!candidateId) {
				logger.debug("Nenhum ID elegível não baixado disponível para o background scraper.");
				break;
			}

			const result = await module.exports.fetchLovecellSticker(candidateId);
			if (result.rateLimit) {
				logger.warn(
					`Lovecell rate limit (429/403) no background scraper ao consultar ID ${candidateId}. Pausando timer por 15 minutos...`
				);
				return BACKOFF_RATE_LIMIT_MS;
			}

			if (!result.found || !result.buffer || result.buffer.length < MIN_STICKER_BYTES) {
				logger.debug(
					`Background scraper: figurinha #${candidateId} não encontrada ou inválida (< 3KB) (${attempt}/${maxAttemptsPerTick}).`
				);
				continue;
			}

			// Recorta o banner promocional inferior (85px)
			const croppedBuffer = await module.exports.cropLovecellBanner(result.buffer);
			if (croppedBuffer.length < MIN_STICKER_BYTES) {
				logger.debug(
					`Background scraper: figurinha #${candidateId} inválida (< 3KB após recorte) (${attempt}/${maxAttemptsPerTick}).`
				);
				continue;
			}

			// Filtro NSFW e moderação estrita
			const isNsfw = await module.exports.checkStickerNSFW(croppedBuffer, candidateId, {
				title: result.title
			});
			if (isNsfw) {
				logger.warn(
					`Background scraper: figurinha #${candidateId} é imprópria/NSFW. Adicionando à blacklist e descartando.`
				);
				await module.exports.addToBlacklist(candidateId);
				continue; // Não salva no estoque offline e continua o ciclo
			}

			// Salva no estoque offline
			await module.exports.saveStickerToCache(candidateId, croppedBuffer);
			logger.info(
				`Background scraper: figurinha #${candidateId} ("${result.title || "Lovecell"}") salva no estoque offline com sucesso.`
			);
			break; // Sucesso ao baixar uma figurinha neste ciclo
		}
	} catch (error) {
		logger.error(`Erro durante ciclo do background scraper: ${error.message}`, error);
	} finally {
		isScrapingInProgress = false;
	}
}

/**
 * Agenda a próxima execução do background scraper.
 * O intervalo de delay só começa a contar após o término completo do download e processamento do ciclo anterior.
 * @param {number|null} delayMs
 */
function scheduleNextTick(delayMs = null) {
	if (!isTimerRunning) return;
	if (scraperTimer) {
		clearTimeout(scraperTimer);
		scraperTimer = null;
	}

	const delay = delayMs !== null ? delayMs : getRandomInterval();
	const formattedDelay = delay < 1000 ? `${delay}ms` : `${(delay / 1000).toFixed(1)}s`;
	logger.debug(`Próximo scraping offline agendado em ${formattedDelay}.`);

	scraperTimer = setTimeout(async () => {
		let nextDelay = null;
		try {
			nextDelay = await module.exports.runBackgroundScraperTick();
		} catch (err) {
			logger.error(`Erro ao executar tick do background scraper: ${err.message}`);
		} finally {
			// Garante que o próximo tick só é agendado após o término completo do ciclo/download anterior
			if (isTimerRunning) {
				scheduleNextTick(typeof nextDelay === "number" ? nextDelay : null);
			}
		}
	}, delay);

	if (scraperTimer && scraperTimer.unref) {
		scraperTimer.unref();
	}
}

/**
 * Inicia o timer do background scraper
 * @param {number|null} initialDelayMs
 */
function startScraperTimer(initialDelayMs = null) {
	if (isTimerRunning) return;
	isTimerRunning = true;
	logger.info("Timer de scraping em background do Lovecell iniciado.");
	scheduleNextTick(initialDelayMs);
}

/**
 * Para o timer do background scraper
 */
function stopScraperTimer() {
	isTimerRunning = false;
	if (scraperTimer) {
		clearTimeout(scraperTimer);
		scraperTimer = null;
	}
	logger.info("Timer de scraping em background do Lovecell pausado.");
}

/**
 * Indica se o timer do background scraper está em execução
 * @returns {boolean}
 */
function isScraperTimerRunning() {
	return isTimerRunning;
}

// Inicialização automática do timer caso não esteja em testes ou desativado
const shouldAutoStartTimer =
	process.env.NODE_ENV !== "test" &&
	process.env.DISABLE_STICKER_SCRAPER_TIMER !== "true" &&
	process.env.DISABLE_ACTIVITY !== "true";

if (shouldAutoStartTimer) {
	const initialDelay = Math.floor(Math.random() * 30000) + 15000;
	startScraperTimer(initialDelay);
}

/**
 * Comando para usuários denunciarem uma figurinha do Lovecell para moderação
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array<string>} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>}
 */
async function figaDenunciarCommand(bot, message, args, group) {
	const chatId =
		message.group ?? (message.originReaction ? message.originReaction.senderId : message.author);

	try {
		let targetMsg = null;
		let directQuotedId = null;

		if (message.originReaction) {
			const isSelfSticker =
				message.type === "sticker" ||
				message.origin?.type === "sticker" ||
				Boolean(message.content?.mimetype?.includes("webp")) ||
				Boolean(message.origin?.content?.mimetype?.includes("webp"));

			if (isSelfSticker) {
				targetMsg = message;
				directQuotedId =
					message.id ||
					message.origin?.id?._serialized_v3 ||
					message.origin?.id?.id ||
					message.origin?.id?._serialized ||
					message.quotedMessageId;
			} else {
				const quotedMsg = await message.origin?.getQuotedMessage?.().catch(() => null);
				if (
					quotedMsg &&
					(quotedMsg.type === "sticker" ||
						quotedMsg.origin?.type === "sticker" ||
						Boolean(quotedMsg.content?.mimetype?.includes("webp")))
				) {
					targetMsg = quotedMsg;
					directQuotedId =
						message.quotedMessageId || message.origin?.quotedMessageId || quotedMsg.id;
				}
			}

			if (!targetMsg) {
				return null;
			}
		} else {
			const quotedMsg = await message.origin?.getQuotedMessage?.().catch(() => null);
			if (!quotedMsg && !message.hasQuotedMsg) {
				return new ReturnMessage({
					chatId,
					content:
						"⚠️ Para denunciar uma figurinha, responda (reply) diretamente a ela com *!figa-denunciar*."
				});
			}

			if (quotedMsg && quotedMsg.type !== "sticker") {
				return new ReturnMessage({
					chatId,
					content: "⚠️ A mensagem respondida não é uma figurinha."
				});
			}

			targetMsg = quotedMsg;
			directQuotedId = message.quotedMessageId || message.origin?.quotedMessageId || quotedMsg?.id;
		}

		let grupoLogs = bot?.grupoLogs || process.env.GRUPO_LOGS;
		if (grupoLogs && !grupoLogs.includes("@") && /^\d+$/.test(grupoLogs)) {
			grupoLogs = `${grupoLogs}@g.us`;
		}
		if (grupoLogs && !grupoLogs.endsWith("@g.us") && process.env.GRUPO_LOGS) {
			grupoLogs = process.env.GRUPO_LOGS;
		}

		if (!grupoLogs) {
			return new ReturnMessage({
				chatId,
				content: "⚠️ O grupo de logs para moderação não está configurado neste bot."
			});
		}

		const stickerId = await getStickerIdFromMessage(targetMsg, directQuotedId);

		// Vincula a mensagem reportada e a instância do bot ao sticker_id para remoção posterior
		const targetMsgId = directQuotedId || targetMsg?.id || targetMsg?.origin?.id?._serialized_v3;
		if (stickerId && targetMsgId) {
			recordSentStickerMessage(targetMsgId, stickerId, message.group || chatId, bot?.id || null);
		}

		// Obter buffer da figurinha
		let stickerBuffer = null;
		if (stickerId) {
			const cachedPath = getStickerFilePath(stickerId);
			if (fs.existsSync(cachedPath)) {
				stickerBuffer = await fs.promises.readFile(cachedPath);
			}
		}

		if (!stickerBuffer && (targetMsg?.downloadMedia || targetMsg?.origin?.downloadMedia)) {
			const downloadFn = targetMsg?.downloadMedia
				? targetMsg.downloadMedia.bind(targetMsg)
				: targetMsg.origin.downloadMedia.bind(targetMsg.origin);
			const downloaded = await downloadFn().catch(() => null);
			if (downloaded?.data) {
				stickerBuffer = Buffer.from(downloaded.data, "base64");
			}
		}

		const returnMessages = [];
		const denuncianteId = message.originReaction ? message.originReaction.senderId : message.author;
		const denunciante =
			(message.originReaction
				? message.originReaction.userName || message.originReaction.pushName
				: null) ||
			message.authorName ||
			message.name ||
			denuncianteId;
		const grupoOrigem =
			group?.name || group?.subject || (message.group ? message.group : "Privado");

		// 1. Mensagem para o grupo de logs: a própria figurinha denunciada
		if (stickerBuffer && stickerBuffer.length >= MIN_STICKER_BYTES) {
			returnMessages.push(
				new ReturnMessage({
					chatId: grupoLogs,
					content: {
						mimetype: "image/webp",
						data: stickerBuffer.toString("base64"),
						filename: stickerId ? `figs_lovecell_${stickerId}.webp` : "denuncia.webp",
						isMessageMedia: true
					},
					options: {
						sendMediaAsSticker: true,
						stickerAuthor: "Denúncia",
						stickerName: stickerId ? `Lovecell #${stickerId}` : "Denúncia"
					}
				})
			);
		}

		// 2. Mensagem para o grupo de logs: detalhes + link
		let logText = "";
		if (stickerId) {
			logText =
				`🚨 *Denúncia de Figurinha Recebida*\n\n` +
				`👤 *Denunciante:* ${denunciante} (${denuncianteId})\n` +
				`👥 *Origem:* ${grupoOrigem}\n` +
				`🆔 *ID Lovecell:* ${stickerId}\n` +
				`🔗 *Link:* https://lovecell.com.br/figurinhas/${stickerId}`;
		} else {
			logText =
				`🚨 *Denúncia de Figurinha Recebida*\n\n` +
				`👤 *Denunciante:* ${denunciante} (${denuncianteId})\n` +
				`👥 *Origem:* ${grupoOrigem}\n` +
				`⚠️ *Aviso:* Não foi possível identificar o ID numérico desta figurinha no Lovecell (pode ter sido enviada por outro usuário ou antes do rastreamento ativo).`;
		}

		returnMessages.push(
			new ReturnMessage({
				chatId: grupoLogs,
				content: logText
			})
		);

		// 3. Mensagem para o grupo de logs: comando isolado para fácil encaminhamento direto ao bot
		if (stickerId) {
			returnMessages.push(
				new ReturnMessage({
					chatId: grupoLogs,
					content: `!sa-removerFig ${stickerId}`
				})
			);
		}

		// 4. Mensagem para o usuário que denunciou: confirmação educada
		returnMessages.push(
			new ReturnMessage({
				chatId,
				content: "✅ Figurinha reportada ao admin com sucesso. Obrigado pela colaboração!"
			})
		);

		return returnMessages;
	} catch (error) {
		logger.error(`Erro ao processar comando figa-denunciar: ${error.message}`, error);
		return new ReturnMessage({
			chatId,
			content: "Ocorreu um erro ao registrar a denúncia. Por favor, tente novamente mais tarde."
		});
	}
}

/**
 * Remove figurinha(s) do Lovecell do cache, adiciona à blacklist, limpa estatísticas
 * e apaga ocorrências no WhatsApp. Suporta chamada por texto (!sa-removerFig) ou reação (‼️).
 *
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array<string>} [args=[]]
 * @param {Object} [group=null]
 * @param {Object} [superAdminContext=null]
 * @returns {Promise<ReturnMessage|null>}
 */
async function removerFigCommand(bot, message, args = [], group = null, superAdminContext = null) {
	const authorId = message.originReaction ? message.originReaction.senderId : message.author;
	const chatId =
		message.group ?? (message.originReaction ? message.originReaction.senderId : message.author);

	try {
		// 1. Verificação de permissões de SuperAdmin / ComuAdmin
		let isAuthorized = false;
		if (superAdminContext && typeof superAdminContext.isSuperAdmin === "function") {
			isAuthorized =
				superAdminContext.isSuperAdmin(authorId) ||
				(superAdminContext.adminUtils &&
					typeof superAdminContext.adminUtils.isComuAdmin === "function" &&
					superAdminContext.adminUtils.isComuAdmin(authorId, bot));
		}
		if (!isAuthorized && bot?.eventHandler?.commandHandler?.superAdmin) {
			const sa = bot.eventHandler.commandHandler.superAdmin;
			if (typeof sa.isSuperAdmin === "function" && sa.isSuperAdmin(authorId)) {
				isAuthorized = true;
			}
		}
		if (!isAuthorized && bot?.superAdmin && typeof bot.superAdmin.isSuperAdmin === "function") {
			if (bot.superAdmin.isSuperAdmin(authorId)) isAuthorized = true;
		}
		if (!isAuthorized) {
			const adminUtilsInstance = AdminUtils.getInstance();
			if (
				adminUtilsInstance.isSuperAdmin(authorId) ||
				adminUtilsInstance.isComuAdmin(authorId, bot)
			) {
				isAuthorized = true;
			}
		}

		if (!isAuthorized) {
			if (message.originReaction) {
				return null;
			}
			return new ReturnMessage({
				chatId,
				content: "⛔ Apenas super administradores podem usar este comando."
			});
		}

		const rawIds = [];

		// 2. Extrai IDs dos argumentos (aceita múltiplos separados por espaço ou vírgula)
		if (args && args.length > 0) {
			for (const arg of args) {
				const parts = String(arg).split(/[,;\s]+/);
				for (const p of parts) {
					const cleaned = p.trim().replace(/^#/, "");
					if (/^\d+$/.test(cleaned)) {
						const num = parseInt(cleaned, 10);
						if (num > 0) rawIds.push(num);
					}
				}
			}
		}

		// 3. Se nenhum ID veio nos argumentos, tenta extrair da mensagem atual (se for reação) ou da citada
		if (rawIds.length === 0) {
			if (message.originReaction) {
				const isSelfSticker =
					message.type === "sticker" ||
					message.origin?.type === "sticker" ||
					Boolean(message.content?.mimetype?.includes("webp")) ||
					Boolean(message.origin?.content?.mimetype?.includes("webp"));

				if (isSelfSticker) {
					const directId =
						message.id ||
						message.origin?.id?._serialized_v3 ||
						message.origin?.id?.id ||
						message.origin?.id?._serialized ||
						message.quotedMessageId;
					const foundId = await getStickerIdFromMessage(message, directId);
					if (foundId) rawIds.push(foundId);
				}

				const msgText = message.body || message.content || message.caption || "";
				if (typeof msgText === "string") {
					const matches = msgText.matchAll(
						/lovecell(?:\.com\.br\/figurinhas\/|[\s#]+)(\d+)|!sa-removerFig\s+(\d+)/gi
					);
					for (const m of matches) {
						const foundId = parseInt(m[1] || m[2], 10);
						if (!isNaN(foundId) && foundId > 0) rawIds.push(foundId);
					}
				}
			}

			// Verifica mensagem citada (seja em comando por texto ou se reagiu em um reply)
			const quotedMsg = await message.origin?.getQuotedMessage?.().catch(() => null);
			if (quotedMsg) {
				const quotedText = quotedMsg.body || quotedMsg.content || quotedMsg.caption || "";
				if (typeof quotedText === "string") {
					const matches = quotedText.matchAll(
						/lovecell(?:\.com\.br\/figurinhas\/|[\s#]+)(\d+)|!sa-removerFig\s+(\d+)/gi
					);
					for (const m of matches) {
						const foundId = parseInt(m[1] || m[2], 10);
						if (!isNaN(foundId) && foundId > 0) rawIds.push(foundId);
					}
				}

				if (
					rawIds.length === 0 &&
					(quotedMsg.type === "sticker" ||
						quotedMsg.origin?.type === "sticker" ||
						Boolean(quotedMsg.content?.mimetype?.includes("webp")))
				) {
					const directQuotedId =
						message.quotedMessageId || message.origin?.quotedMessageId || quotedMsg.id;
					const foundId = await getStickerIdFromMessage(quotedMsg, directQuotedId);
					if (foundId) rawIds.push(foundId);
				}
			}
		}

		const uniqueIds = Array.from(new Set(rawIds));

		if (uniqueIds.length === 0) {
			if (message.originReaction) {
				return null;
			}
			return new ReturnMessage({
				chatId,
				content:
					"⚠️ Informe ao menos um ID numérico de figurinha ou responda a uma figurinha/denúncia.\n" +
					"*Exemplo:* `!sa-removerFig 12345` ou `!sa-removerFig 12345 67890 112233`"
			});
		}

		const removalResult = await removeMultipleFromLovecell(
			uniqueIds,
			`Removido via sa-removerFig por ${authorId}`
		);

		// 4. Apaga ocorrências no WhatsApp nos chats onde a figurinha foi enviada ou denunciada
		let totalDeletedMsgs = 0;
		const allBots = Database.getInstance().botInstances || bot?.database?.botInstances || [];

		for (const res of removalResult.results) {
			if (Array.isArray(res.associatedMessages) && res.associatedMessages.length > 0) {
				for (const msg of res.associatedMessages) {
					if (!msg.chatId || !msg.messageId) continue;

					let targetBot = bot;
					if (msg.botId) {
						const foundBot = allBots.find(
							(b) =>
								b &&
								(b.id === msg.botId || b.instanceName === msg.botId || b.nomeExibir === msg.botId)
						);
						if (foundBot) {
							targetBot = foundBot;
						} else if (bot.otherBots && Array.isArray(bot.otherBots)) {
							const foundInOther = bot.otherBots.find(
								(b) => b && (b.id === msg.botId || b.instanceName === msg.botId)
							);
							if (foundInOther) targetBot = foundInOther;
						}
					}

					if (targetBot && typeof targetBot.deleteMessageByKey === "function") {
						try {
							const actualId =
								typeof targetBot.getActualMsgId === "function"
									? targetBot.getActualMsgId(msg.messageId)
									: msg.messageId;
							await targetBot.deleteMessageByKey({
								remoteJid: msg.chatId,
								id: actualId,
								fromMe: true
							});
							totalDeletedMsgs++;
						} catch (delError) {
							logger.debug(
								`[sa-removerFig] Erro ignorado ao tentar apagar mensagem ${msg.messageId} em ${msg.chatId}: ${delError.message}`
							);
						}
					}
				}
			}
		}

		// 5. Se foi reação direta em um sticker ou quote de um sticker no chat atual
		if (message.originReaction) {
			const isSelfSticker =
				message.type === "sticker" ||
				message.origin?.type === "sticker" ||
				Boolean(message.content?.mimetype?.includes("webp")) ||
				Boolean(message.origin?.content?.mimetype?.includes("webp"));

			if (isSelfSticker) {
				const msgStanzaId =
					message.id ||
					message.origin?.id?._serialized_v3 ||
					message.origin?.id?.id ||
					message.origin?.id?._serialized;
				const targetChat =
					message.group ||
					message.chatId ||
					(message.origin?.id?.remote ? message.origin.id.remote : chatId);

				if (msgStanzaId && typeof bot.deleteMessageByKey === "function") {
					try {
						const actualId =
							typeof bot.getActualMsgId === "function"
								? bot.getActualMsgId(msgStanzaId)
								: msgStanzaId;
						await bot.deleteMessageByKey({
							remoteJid: targetChat,
							id: actualId,
							fromMe: message.fromMe !== false
						});
						totalDeletedMsgs++;
					} catch (delError) {
						logger.debug(
							`[sa-removerFig] Erro ignorado ao tentar apagar sticker via reação: ${delError.message}`
						);
					}
				}
			}
		}

		const quotedMsg = await message.origin?.getQuotedMessage?.().catch(() => null);
		const directQuotedId = message.quotedMessageId || message.origin?.quotedMessageId;
		if (
			quotedMsg &&
			(quotedMsg.type === "sticker" || quotedMsg.origin?.type === "sticker") &&
			(message.group || message.chatId || chatId)
		) {
			const quotedStanzaId = directQuotedId || quotedMsg.id;
			if (quotedStanzaId && typeof bot.deleteMessageByKey === "function") {
				try {
					const actualId =
						typeof bot.getActualMsgId === "function"
							? bot.getActualMsgId(quotedStanzaId)
							: quotedStanzaId;
					await bot.deleteMessageByKey({
						remoteJid: message.group || message.chatId || chatId,
						id: actualId,
						fromMe: true
					});
					totalDeletedMsgs++;
				} catch (delError) {
					logger.debug(
						`[sa-removerFig] Erro ignorado ao tentar apagar sticker citado: ${delError.message}`
					);
				}
			}
		}

		let responseText = `✅ *Processamento de Remoção Concluído*\n`;
		responseText += `• Total processado: *${removalResult.removedCount}* figurinha(s)\n`;
		if (totalDeletedMsgs > 0) {
			responseText += `• Mensagens apagadas: *${totalDeletedMsgs}* ocorrência(s)\n`;
		}
		responseText += `\n`;

		for (const res of removalResult.results) {
			const cacheStatus = res.deletedFile ? "Cache local apagado" : "Não estava em cache";
			responseText += `• *#${res.id}*: Blacklist NSFW ativada | ${cacheStatus}\n  🔗 https://lovecell.com.br/figurinhas/${res.id}\n`;
		}

		return new ReturnMessage({
			chatId,
			content: responseText.trim()
		});
	} catch (error) {
		logger.error(`Erro ao executar sa-removerFig: ${error.message}`, error);
		return new ReturnMessage({
			chatId,
			content: `❌ Ocorreu um erro ao remover a(s) figurinha(s): ${error.message}`
		});
	}
}

const commands = [
	new Command({
		name: "figa",
		description: "Faz scraping da figurinha principal no Lovecell (estático ou animado)",
		category: "stickers",
		group: "lovecell",
		reply: false,
		aliases: ["figrandom"],
		caseSensitive: false,
		cooldown: 30,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: stickerScraperCommand
	}),

	new Command({
		name: "figrandom",
		description: "Faz scraping da figurinha principal no Lovecell (estático ou animado)",
		category: "stickers",
		group: "lovecell",
		reply: false,
		caseSensitive: false,
		cooldown: 30,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: stickerScraperCommand
	}),

	new Command({
		name: "figa-denunciar",
		description: "Denuncia uma figurinha para o administrador",
		category: "stickers",
		group: "lovecell",
		reply: true,
		aliases: ["denunciar-figa", "denunciarfiga", "figdenunciar"],
		hidden: false,
		caseSensitive: false,
		cooldown: 5,
		reactions: {
			trigger: ["🔞", "\u{1F51E}"],
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🚨",
			error: "❌"
		},
		method: figaDenunciarCommand
	}),

	new Command({
		name: "sa-removerFig",
		description:
			"Remove figurinha do Lovecell, adiciona à blacklist e apaga ocorrências (apenas SuperAdmin)",
		category: "stickers",
		group: "lovecell",
		reply: false,
		aliases: ["removerFig", "remover-fig", "figa-remover", "figaremover", "delfig"],
		hidden: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			trigger: ["‼️", "\u203C"],
			before: false,
			after: false,
			error: "❌"
		},
		method: removerFigCommand
	})
];

const helper = {
	about: "Busca e envia figurinhas sob demanda do portal Lovecell",
	implementation:
		"Faz scraping da figurinha principal no Lovecell, recorta os 85px de banner inferior e envia no formato 512x512 padrão de stickers (estático ou animado). Suporta envio de até 4 figurinhas por comando (configurável por bot via extras.stickers.maxFiga). Possui filtro NSFW com blacklist persistente e download em segundo plano para estoque offline.",
	tags: "figa,figrandom,lovecell,sticker,figurinha,aleatoria,random,denunciar",
	cmds: [
		{
			cmd: "!figa",
			desc: "Faz scraping da figurinha principal no Lovecell (estático ou animado)",
			usage: ["!figa", "!figa 4", "!figrandom 2", "!figa 37019"],
			category: "stickers"
		},
		{
			cmd: "!figa-denunciar",
			desc: "Denuncia uma figurinha para o administrador (ou reaja com 🔞)",
			usage: ["!figa-denunciar (em resposta a uma figurinha)", "Reação: 🔞"],
			category: "stickers"
		}
	]
};

module.exports = {
	helper,
	commands,
	cropLovecellBanner,
	fetchLovecellSticker,
	getRandomCachedStickers,
	cleanTitle,
	getStickerFilePath,
	getStickerFromCache,
	saveStickerToCache,
	LOVECELL_DIR,
	BLACKLIST_FILE,
	blacklistedIds,
	downloadedIds,
	loadBlacklistSync,
	saveBlacklist,
	isBlacklisted,
	addToBlacklist,
	loadDownloadedIdsSync,
	isDownloaded,
	getRandomUndownloadedId,
	extractFramesForAnalysis,
	checkStickerNSFW,
	runBackgroundScraperTick,
	startScraperTimer,
	stopScraperTimer,
	isScraperTimerRunning,
	getRandomInterval,
	MAX_QUANTITY,
	MIN_STICKER_BYTES,
	DEFAULT_MIN_INTERVAL_MS,
	DEFAULT_MAX_INTERVAL_MS,
	isScrapingInProgress: () => isScrapingInProgress,
	recordStickerSent,
	getStickerStats,
	initStickerStatsSync,
	stickerScraperCommand,
	isForbiddenText,
	FORBIDDEN_TITLE_PATTERNS,
	recordSentStickerMessage,
	getStickerIdByMessageId,
	getStickerIdFromMessage,
	getMessagesForSticker,
	removeFromLovecell,
	removeMultipleFromLovecell,
	figaDenunciarCommand,
	removerFigCommand
};
