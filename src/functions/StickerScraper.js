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
	);`
);

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

// Limites de download automático: mínimo 1 sticker/min (60s), máximo 15 stickers/min (4s)
const DEFAULT_MIN_INTERVAL_MS = parseInt(process.env.STICKER_SCRAPER_MIN_INTERVAL, 10) || 4 * 1000; // Máx 15 stickers/min
const DEFAULT_MAX_INTERVAL_MS = parseInt(process.env.STICKER_SCRAPER_MAX_INTERVAL, 10) || 60 * 1000; // Mín 1 sticker/min
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
		}
		logger.info(`Figurinha salva em cache: ${filePath}`);
		return filePath;
	} catch (error) {
		logger.error(`Erro ao salvar figurinha em cache: ${error.message}`);
		return null;
	}
}

/**
 * Busca figurinhas aleatórias já salvas no cache local do Lovecell (ignora blacklisted e < 3KB)
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

		// Embaralha aleatoriamente (Fisher-Yates)
		for (let i = available.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[available[i], available[j]] = [available[j], available[i]];
		}

		const selected = available.slice(0, count);
		const results = [];
		for (const filename of selected) {
			const match = filename.match(/^figs_lovecell_(\d+)\.webp$/);
			const id = match ? parseInt(match[1], 10) : filename;
			const fullPath = path.join(LOVECELL_DIR, filename);
			const buffer = await fs.promises.readFile(fullPath);
			if (buffer.length >= MIN_STICKER_BYTES) {
				results.push({ id, buffer });
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

/**
 * Avalia se o buffer de uma figurinha contém conteúdo adulto/NSFW via NSFWPredict.
 * Para figurinhas animadas, extrai múltiplos frames ao longo da animação para garantir
 * que cenas NSFW no meio/fim do sticker sejam detectadas pela LLM.
 *
 * @param {Buffer} buffer - Buffer WebP da figurinha
 * @param {number|string} stickerId - ID para logging e rastreamento
 * @returns {Promise<boolean>} - true se for NSFW, false se seguro
 */
async function checkStickerNSFW(buffer, stickerId) {
	try {
		const frames = await module.exports.extractFramesForAnalysis(buffer, 6);
		const result = await nsfwPredict.detectNSFW(frames, {
			isSticker: true,
			type: "sticker",
			stickerId,
			forceLLM: true,
			skipNudeNet: true
		});

		if (result?.isNSFW) {
			logger.warn(
				`Figurinha #${stickerId} classificada como NSFW: ${result.reason || "conteúdo adulto detectado"}`
			);
			return true;
		}
		return false;
	} catch (error) {
		logger.error(`Erro ao verificar NSFW para figurinha #${stickerId}: ${error.message}`);
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
			stickerName: title || `Lovecell #${stickerId}`
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

		if (arg && /^\d+$/.test(arg)) {
			const parsed = parseInt(arg, 10);
			if (parsed >= MIN_STICKER_ID) {
				// Número alto: ID específico da figurinha
				specificId = parsed;
			} else if (parsed > 0) {
				// Número de 1 a 4: quantidade solicitada
				targetQuantity = Math.min(MAX_QUANTITY, parsed);
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

			// Verificação NSFW para ID específico
			const isNsfw = await module.exports.checkStickerNSFW(croppedBuffer, specificId);
			if (isNsfw) {
				await module.exports.addToBlacklist(specificId);
				return new ReturnMessage({
					chatId,
					content: `⚠️ A figurinha #${specificId} foi bloqueada por conter conteúdo impróprio (NSFW).`
				});
			}

			await module.exports.saveStickerToCache(specificId, croppedBuffer);

			return buildStickerReturnMessage(
				chatId,
				croppedBuffer,
				specificId,
				result.title || `Lovecell #${specificId}`,
				bot,
				message
			);
		}

		// 2. Modo aleatório (busca até targetQuantity figurinhas válidas)
		const returnMessages = [];
		const usedIds = new Set();
		let rateLimited = false;
		const maxAttempts = 15 * targetQuantity;

		for (
			let attempt = 1;
			attempt <= maxAttempts && returnMessages.length < targetQuantity;
			attempt++
		) {
			const randomId =
				Math.floor(Math.random() * (MAX_STICKER_ID - MIN_STICKER_ID + 1)) + MIN_STICKER_ID;

			if (usedIds.has(randomId) || module.exports.isBlacklisted(randomId)) continue;
			usedIds.add(randomId);

			const cachedPath = module.exports.getStickerFromCache(randomId);
			if (cachedPath) {
				logger.info(`Tentativa ${attempt}: figurinha #${randomId} encontrada no cache local!`);
				const fileBuf = await fs.promises.readFile(cachedPath);
				if (fileBuf.length >= MIN_STICKER_BYTES) {
					returnMessages.push(
						buildStickerReturnMessage(
							chatId,
							fileBuf,
							randomId,
							`Lovecell #${randomId}`,
							bot,
							message
						)
					);
				}
				continue;
			}

			const result = await module.exports.fetchLovecellSticker(randomId);
			if (result.rateLimit) {
				rateLimited = true;
				break;
			}

			if (result.found && result.buffer && result.buffer.length >= MIN_STICKER_BYTES) {
				logger.info(`Tentativa ${attempt}: figurinha #${randomId} obtida com sucesso do Lovecell!`);
				const croppedBuffer = await module.exports.cropLovecellBanner(result.buffer);
				if (croppedBuffer.length < MIN_STICKER_BYTES) {
					logger.warn(
						`Tentativa ${attempt}: figurinha #${randomId} ficou com tamanho inferior a 3KB (${croppedBuffer.length} bytes) após corte do banner. Pulando...`
					);
					continue;
				}

				// Verificação NSFW: se for positivo, adiciona à blacklist, descarta e tenta a próxima
				const isNsfw = await module.exports.checkStickerNSFW(croppedBuffer, randomId);
				if (isNsfw) {
					logger.warn(
						`Tentativa ${attempt}: figurinha #${randomId} detectada como NSFW. Adicionando à blacklist e pulando para a próxima...`
					);
					await module.exports.addToBlacklist(randomId);
					continue;
				}

				await module.exports.saveStickerToCache(randomId, croppedBuffer);

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

		// Em caso de rate-limit, preenche as figurinhas restantes com figurinhas já baixadas no cache
		if (rateLimited && returnMessages.length < targetQuantity) {
			const needed = targetQuantity - returnMessages.length;
			logger.warn(
				`Lovecell com rate limit. Buscando ${needed} figurinha(s) do cache local como fallback...`
			);
			const fallbackStickers = await module.exports.getRandomCachedStickers(needed, usedIds);
			for (const fb of fallbackStickers) {
				usedIds.add(fb.id);
				returnMessages.push(
					buildStickerReturnMessage(chatId, fb.buffer, fb.id, `Lovecell #${fb.id}`, bot, message)
				);
			}
		}

		if (returnMessages.length > 0) {
			return returnMessages;
		}

		if (rateLimited) {
			return new ReturnMessage({
				chatId,
				content:
					"⚠️ O serviço do Lovecell está temporariamente indisponível no momento devido a limite de requisições. Tente novamente mais tarde."
			});
		}

		return new ReturnMessage({
			chatId,
			content:
				"Não foi possível encontrar uma figurinha válida após várias tentativas. Por favor, tente novamente."
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
	if (isScrapingInProgress) return;
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
				scheduleNextTick(BACKOFF_RATE_LIMIT_MS);
				return;
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

			// Filtro NSFW
			const isNsfw = await module.exports.checkStickerNSFW(croppedBuffer, candidateId);
			if (isNsfw) {
				logger.warn(
					`Background scraper: figurinha #${candidateId} é NSFW. Adicionando à blacklist e descartando.`
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
 * Agenda a próxima execução do background scraper
 * @param {number|null} delayMs
 */
function scheduleNextTick(delayMs = null) {
	if (!isTimerRunning) return;
	if (scraperTimer) {
		clearTimeout(scraperTimer);
		scraperTimer = null;
	}

	const delay = delayMs !== null ? delayMs : getRandomInterval();
	logger.debug(`Próximo scraping offline agendado em ${Math.round(delay / 1000)}s.`);

	scraperTimer = setTimeout(async () => {
		try {
			await module.exports.runBackgroundScraperTick();
		} catch (err) {
			logger.error(`Erro ao executar tick do background scraper: ${err.message}`);
		} finally {
			if (isTimerRunning) {
				scheduleNextTick();
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
	})
];

const helper = {
	about: "Busca e envia figurinhas sob demanda do portal Lovecell",
	implementation:
		"Faz scraping da figurinha principal no Lovecell, recorta os 85px de banner inferior e envia no formato 512x512 padrão de stickers (estático ou animado). Suporta envio de até 4 figurinhas por comando. Possui filtro NSFW com blacklist persistente e download em segundo plano para estoque offline.",
	tags: "figa,figrandom,lovecell,sticker,figurinha,aleatoria,random",
	cmds: [
		{
			cmd: "!figa",
			desc: "Faz scraping da figurinha principal no Lovecell (estático ou animado)",
			usage: ["!figa", "!figa 4", "!figrandom 2", "!figa 37019"],
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
	MIN_STICKER_BYTES
};
