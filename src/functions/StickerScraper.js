const path = require("path");
const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const sharp = require("sharp");

const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const Database = require("../utils/Database");

const logger = new Logger("sticker-scraper");
const database = Database.getInstance();

// Diretório para armazenar as figurinhas do Lovecell em cache (não indexado pelo git)
const LOVECELL_DIR = path.join(database.databasePath, "media", "lovecell");

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

const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
 * Caminho do arquivo em cache para um dado ID
 * @param {number|string} stickerId
 * @returns {string}
 */
function getStickerFilePath(stickerId) {
	return path.join(LOVECELL_DIR, `figs_lovecell_${stickerId}.webp`);
}

/**
 * Retorna o caminho do arquivo em cache se já existir
 * @param {number|string} stickerId
 * @returns {string|null}
 */
function getStickerFromCache(stickerId) {
	const filePath = getStickerFilePath(stickerId);
	if (fs.existsSync(filePath)) {
		return filePath;
	}
	return null;
}

/**
 * Salva a figurinha já recortada em disco
 * @param {number|string} stickerId
 * @param {Buffer} buffer
 * @returns {Promise<string|null>}
 */
async function saveStickerToCache(stickerId, buffer) {
	const filePath = getStickerFilePath(stickerId);
	try {
		await fs.promises.writeFile(filePath, buffer);
		logger.info(`Figurinha salva em cache: ${filePath}`);
		return filePath;
	} catch (error) {
		logger.error(`Erro ao salvar figurinha em cache: ${error.message}`);
		return null;
	}
}

/**
 * Busca figurinhas aleatórias já salvas no cache local do Lovecell
 * @param {number} count - Quantidade desejada
 * @param {Set<number|string>} excludeIds - IDs a excluir
 * @returns {Promise<Array<{ id: number|string, buffer: Buffer }>>}
 */
async function getRandomCachedStickers(count = 1, excludeIds = new Set()) {
	try {
		if (!fs.existsSync(LOVECELL_DIR)) return [];
		const files = await fs.promises.readdir(LOVECELL_DIR);
		const stickerFiles = files.filter((f) => f.startsWith("figs_lovecell_") && f.endsWith(".webp"));

		let available = stickerFiles.filter((f) => {
			const match = f.match(/^figs_lovecell_(\d+)\.webp$/);
			if (!match) return false;
			return !excludeIds.has(parseInt(match[1], 10));
		});

		if (available.length === 0 && stickerFiles.length > 0) {
			available = [...stickerFiles];
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
			results.push({ id, buffer });
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

		return {
			found: true,
			buffer: Buffer.from(imgResponse.data),
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
			const cachedPath = getStickerFromCache(specificId);
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

			if (!result.found || !result.buffer) {
				return new ReturnMessage({
					chatId,
					content: `Figurinha #${specificId} não foi encontrada no Lovecell.`
				});
			}

			const croppedBuffer = await module.exports.cropLovecellBanner(result.buffer);
			await saveStickerToCache(specificId, croppedBuffer);

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
		const maxAttempts = 10 * targetQuantity;

		for (
			let attempt = 1;
			attempt <= maxAttempts && returnMessages.length < targetQuantity;
			attempt++
		) {
			const randomId =
				Math.floor(Math.random() * (MAX_STICKER_ID - MIN_STICKER_ID + 1)) + MIN_STICKER_ID;

			if (usedIds.has(randomId)) continue;
			usedIds.add(randomId);

			const cachedPath = getStickerFromCache(randomId);
			if (cachedPath) {
				logger.info(`Tentativa ${attempt}: figurinha #${randomId} encontrada no cache local!`);
				const fileBuf = await fs.promises.readFile(cachedPath);
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
				continue;
			}

			const result = await module.exports.fetchLovecellSticker(randomId);
			if (result.rateLimit) {
				rateLimited = true;
				break;
			}

			if (result.found && result.buffer) {
				logger.info(`Tentativa ${attempt}: figurinha #${randomId} obtida com sucesso do Lovecell!`);
				const croppedBuffer = await module.exports.cropLovecellBanner(result.buffer);
				await saveStickerToCache(randomId, croppedBuffer);

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
				"Não foi possível encontrar uma figurinha válida após 10 tentativas. Por favor, tente novamente."
		});
	} catch (error) {
		logger.error(`Erro ao processar comando sticker-scraper: ${error.message}`, error);
		return new ReturnMessage({
			chatId,
			content: "Ocorreu um erro ao buscar a figurinha. Por favor, tente novamente mais tarde."
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
	})
];

const helper = {
	about: "Busca e envia figurinhas sob demanda do portal Lovecell",
	implementation:
		"Faz scraping da figurinha principal no Lovecell, recorta os 85px de banner inferior e envia no formato 512x512 padrão de stickers (estático ou animado). Suporta envio de até 4 figurinhas por comando.",
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
	getStickerFromCache,
	saveStickerToCache,
	LOVECELL_DIR
};
