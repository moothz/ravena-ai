const path = require("path");
const axios = require("axios");
const fs = require("fs").promises;
const fsSync = require("fs");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const Database = require("../utils/Database");
const { toMp3 } = require("../utils/Conversions");
const crypto = require("crypto");
const yts = require("youtube-search-api");
const { pipeline } = require("stream/promises");

const logger = new Logger("social-media-downloader");
const database = Database.getInstance();

// Inicializa o banco de dados de cache
database.getSQLiteDb(
	"smd_cache",
	`
  CREATE TABLE IF NOT EXISTS smd_cache (
    url TEXT PRIMARY KEY,
    platform TEXT,
    json_data TEXT,
    timestamp INTEGER
  );
`
);

/**
 * Gerenciador de Cache para Downloads
 */
class SMDCacheManager {
	constructor() {
		this.dbName = "smd_cache";
		this.maxAgeDays = 30;
		this.maxSizeGB = 30;
	}

	async getCache(url) {
		const row = await database.dbGet(this.dbName, "SELECT json_data FROM smd_cache WHERE url = ?", [
			url
		]);
		if (row) {
			const data = JSON.parse(row.json_data);
			// Verifica se os arquivos ainda existem
			const allFilesExist = await Promise.all(
				data.files.map(async (f) => {
					try {
						await fs.access(f.path);
						return true;
					} catch {
						return false;
					}
				})
			);

			if (allFilesExist.every((exists) => exists)) {
				return data;
			}
			// Se algum arquivo sumiu, invalida o cache
			await this.deleteCache(url);
		}
		return null;
	}

	async setCache(url, platform, filename, files) {
		const data = { platform, filename, files, timestamp: Date.now() };
		await database.dbRun(
			this.dbName,
			"INSERT OR REPLACE INTO smd_cache (url, platform, json_data, timestamp) VALUES (?, ?, ?, ?)",
			[url, platform, JSON.stringify(data), Date.now()]
		);
		// Limpeza em background (não aguarda)
		this.cleanup().catch((e) => logger.error("Erro no cleanup de cache:", e.message));
	}

	async deleteCache(url) {
		await database.dbRun(this.dbName, "DELETE FROM smd_cache WHERE url = ?", [url]);
	}

	async cleanup() {
		try {
			// 1. Deleta entradas antigas (30 dias)
			const thirtyDaysAgo = Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000;
			const oldEntries = await database.dbAll(
				this.dbName,
				"SELECT url, json_data FROM smd_cache WHERE timestamp < ?",
				[thirtyDaysAgo]
			);

			for (const entry of oldEntries) {
				const data = JSON.parse(entry.json_data);
				for (const file of data.files) {
					await fs.unlink(file.path).catch(() => {});
				}
				await this.deleteCache(entry.url);
			}

			// 2. Limpeza por tamanho (30GB)
			const stats = await this.getFolderStats(process.env.DL_FOLDER || "/app/downloads");
			const maxSizeBytes = this.maxSizeGB * 1024 * 1024 * 1024;

			if (stats.totalSize > maxSizeBytes) {
				const targetSize = maxSizeBytes * 0.8;
				const allEntries = await database.dbAll(
					this.dbName,
					"SELECT url, json_data FROM smd_cache ORDER BY timestamp ASC"
				);

				let currentSize = stats.totalSize;
				for (const entry of allEntries) {
					if (currentSize <= targetSize) break;
					const data = JSON.parse(entry.json_data);
					for (const file of data.files) {
						const fileSize = await this.getFileSize(file.path);
						await fs.unlink(file.path).catch(() => {});
						currentSize -= fileSize;
					}
					await this.deleteCache(entry.url);
				}
			}
		} catch (error) {
			logger.error("Erro durante o cleanup do cache:", error.message);
		}
	}

	async getFolderStats(dirPath) {
		if (!fsSync.existsSync(dirPath)) return { totalSize: 0 };
		const files = await fs.readdir(dirPath);
		let totalSize = 0;
		for (const file of files) {
			try {
				const stats = await fs.stat(path.join(dirPath, file));
				if (stats.isFile()) totalSize += stats.size;
			} catch (e) {}
		}
		return { totalSize };
	}

	async getFileSize(filePath) {
		try {
			const stats = await fs.stat(filePath);
			return stats.size;
		} catch {
			return 0;
		}
	}
}

const cacheManager = new SMDCacheManager();

/**
 * Detecta a plataforma da URL
 */
function detectPlatform(url) {
	if (!url) return "Desconhecido";
	const platforms = {
		"tiktok.com": "TikTok",
		"instagram.com": "Instagram",
		"facebook.com": "Facebook",
		"fb.watch": "Facebook",
		"twitter.com": "Twitter",
		"x.com": "Twitter",
		"twitch.tv": "Twitch",
		"snapchat.com": "Snapchat",
		"reddit.com": "Reddit",
		"vimeo.com": "Vimeo",
		"streamable.com": "Streamable",
		"pinterest.com": "Pinterest",
		"linkedin.com": "LinkedIn",
		"bilibili.com": "BiliBili",
		"soundcloud.com": "SoundCloud"
	};

	try {
		const hostname = new URL(url).hostname.toLowerCase();
		for (const [domain, platform] of Object.entries(platforms)) {
			if (hostname.includes(domain)) return platform;
		}
	} catch (e) {}
	return "Social Media";
}

/**
 * Busca letras de música
 */
async function searchLyrics(query) {
	try {
		logger.info(`Buscando letra para: ${query}`);
		const response = await axios.get(`https://lrclib.net/api/search`, {
			params: { q: query },
			timeout: 10000
		});
		if (response.data && response.data.length > 0) {
			const bestMatch = response.data[0];
			return {
				title: bestMatch.trackName,
				artist: bestMatch.artistName,
				lyrics: bestMatch.plainLyrics || bestMatch.syncedLyrics
			};
		}
	} catch (error) {
		logger.error("Erro ao buscar letra:", error.message);
	}
	return null;
}

/**
 * Faz o download de um arquivo de uma URL
 */
async function downloadFile(url, filename) {
	const dlFolder = process.env.DL_FOLDER || "/app/downloads";
	const dlPath = path.join(dlFolder, filename);

	if (!fsSync.existsSync(dlFolder)) {
		fsSync.mkdirSync(dlFolder, { recursive: true });
	}

	const writer = fsSync.createWriteStream(dlPath);

	try {
		logger.info(`[DOWNLOAD] Tentando URL: ${url}`);
		const response = await axios({
			url,
			method: "GET",
			responseType: "stream",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
			},
			timeout: 300000
		});

		await pipeline(response.data, writer);
		await new Promise((r) => setTimeout(r, 1000)); // Sync disk

		const stats = fsSync.statSync(dlPath);
		logger.info(`[DOWNLOAD] Finalizado: ${stats.size} bytes`);

		if (stats.size === 0) throw new Error("Arquivo vazio recebido.");

		return dlPath;
	} catch (error) {
		if (fsSync.existsSync(dlPath)) fsSync.unlinkSync(dlPath);
		logger.error(`[DOWNLOAD] Falha: ${error.message}`);
		throw error;
	}
}

/**
 * Faz requisição para a API Cobalt
 */
async function cobaltRequest(url, options = {}) {
	const cobaltUrl = process.env.COBALT_API_URL || "http://cobalt:9000";
	try {
		const response = await axios.post(
			`${cobaltUrl}/`,
			{
				url,
				...options
			},
			{
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json"
				},
				timeout: 60000
			}
		);

		const data = response.data;
		const externalUrl = process.env.COBALT_EXTERNAL_URL || cobaltUrl;
		const fixUrl = (u) =>
			u && u.includes("://cobalt:9000") ? u.replace("http://cobalt:9000", externalUrl) : u;

		if (data.url) data.url = fixUrl(data.url);
		if (data.tunnel) {
			if (Array.isArray(data.tunnel)) data.tunnel = data.tunnel.map(fixUrl);
			else data.tunnel = fixUrl(data.tunnel);
		}
		if (data.picker) {
			data.picker = data.picker.map((p) => ({ ...p, url: fixUrl(p.url) }));
		}

		return data;
	} catch (error) {
		const errorData = error.response?.data;
		logger.error("Erro na API Cobalt:", errorData || error.message);
		throw new Error(errorData?.text || "O serviço de download não respondeu corretamente.");
	}
}

/**
 * Handler principal de downloads
 */
async function downloadHandler(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const body = message.origin?.body || "";
	const commandName = body.split(" ")[0].substring(bot.prefix.length).toLowerCase();

	// Verifica se há URL
	let url = args.find((arg) => arg && typeof arg === "string" && arg.startsWith("http"));
	if (!url && message.origin?.quotedMsg) {
		const quotedText =
			message.origin.quotedMsg.body ||
			message.origin.quotedMsg.caption ||
			message.origin.quotedMsg.content;
		if (quotedText) {
			const match = quotedText.match(/https?:\/\/[^\s]+/);
			if (match) url = match[0];
		}
	}

	if (!url) {
		return new ReturnMessage({
			chatId,
			content: `❌ Por favor, forneça uma URL válida.\nExemplo: \`${bot.prefix}${commandName} https://...\``
		});
	}

	const platform = detectPlatform(url);
	const isAudioOnly =
		commandName.includes("audio") ||
		commandName.includes("musica") ||
		args.includes("-audio") ||
		args.includes("-musica");
	const wantLyrics = commandName.includes("musica") || args.includes("-musica");

	// Verifica Cache
	const cacheKey = `${url}_${isAudioOnly ? "audio" : "video"}`;
	const cachedData = await cacheManager.getCache(cacheKey);

	if (cachedData) {
		logger.info(`Cache encontrado para: ${url}`);
		return await sendProcessedMedia(
			bot,
			chatId,
			group,
			cachedData.platform,
			cachedData.filename,
			cachedData.files,
			isAudioOnly,
			wantLyrics,
			bot.prefix
		);
	}

	// Mensagem inicial
	bot.sendReturnMessages(
		new ReturnMessage({
			chatId,
			content: `⏳ Processando download para *${platform}*...`
		}),
		group
	);

	try {
		// Solicitação ao Cobalt
		const cobaltOptions = {
			videoQuality: "720",
			filenameStyle: "pretty"
		};

		if (isAudioOnly) {
			cobaltOptions.downloadMode = "audio";
			cobaltOptions.audioFormat = "mp3";
		}

		const result = await cobaltRequest(url, cobaltOptions);

		if (result.status === "error") {
			throw new Error(result.text || "Erro desconhecido no serviço de download.");
		}

		// Lista de itens para baixar
		const items = [];
		const dlUrl = result.url || (Array.isArray(result.tunnel) ? result.tunnel[0] : result.tunnel);

		if (dlUrl) {
			items.push({
				url: dlUrl,
				filename: result.filename || `download_${crypto.randomBytes(4).toString("hex")}`
			});
		} else if (result.picker) {
			result.picker.forEach((p, index) => {
				items.push({
					url: p.url,
					filename: p.filename || `download_${index}_${crypto.randomBytes(4).toString("hex")}`,
					type: p.type
				});
			});
		}

		if (items.length === 0) {
			throw new Error("Não foi possível obter os links das mídias.");
		}

		const displayFilename = result.filename || items[0].filename;
		logger.info(`Iniciando transferência de ${items.length} item(ns) para ${displayFilename}`);

		const processedFiles = [];
		for (const item of items) {
			// Download local
			const tempFilename = `${crypto.randomBytes(4).toString("hex")}_${item.filename}`;
			const filePath = await downloadFile(item.url, tempFilename);

			// Preparação da mídia
			let finalFilePath = filePath;
			let finalMime = isAudioOnly ? "audio/mpeg" : "video/mp4";

			// Detecção de tipo (Imagem vs Vídeo)
			const ext = path.extname(item.filename).toLowerCase();
			if (
				item.type === "photo" ||
				item.type === "image" ||
				[".jpg", ".jpeg", ".png", ".webp"].includes(ext)
			) {
				finalMime = "image/jpeg";
			}

			// Se pediu áudio mas veio vídeo
			if (
				isAudioOnly &&
				!filePath.endsWith(".mp3") &&
				!filePath.endsWith(".ogg") &&
				!filePath.endsWith(".m4a")
			) {
				const mp3Path = await toMp3(filePath);
				finalFilePath = mp3Path;
				finalMime = "audio/mpeg";
				fs.unlink(filePath).catch(() => {});
			}

			processedFiles.push({ path: finalFilePath, mimetype: finalMime });
		}

		// Salva no Cache
		await cacheManager.setCache(cacheKey, platform, displayFilename, processedFiles);

		// Envia Mídia
		await sendProcessedMedia(
			bot,
			chatId,
			group,
			platform,
			displayFilename,
			processedFiles,
			isAudioOnly,
			wantLyrics,
			bot.prefix
		);
	} catch (error) {
		logger.error(`Erro no download: ${error.message}`);
		await bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: `❌ *Erro ao processar download:*\n${error.message}`
			}),
			group
		);
	}
}

/**
 * Função auxiliar para enviar a mídia processada
 */
async function sendProcessedMedia(
	bot,
	chatId,
	group,
	platform,
	filename,
	files,
	isAudioOnly,
	wantLyrics,
	prefix
) {
	const returnMessages = [];
	for (const file of files) {
		const media = await bot.createMedia(file.path, file.mimetype);
		returnMessages.push(media);
	}

	const caption = `✅ *Download Concluído!*${
		files.length > 1 ? ` (${files.length} itens)` : ""
	}\n\n🌐 *Fonte:* ${platform}\n📝 *Título:* ${filename}${
		!isAudioOnly &&
		returnMessages[0] &&
		returnMessages[0].mimetype &&
		!returnMessages[0].mimetype.startsWith("image")
			? `\n\n> *Dica:* Responda este vídeo com \`${prefix}extractaudio\` para obter apenas o áudio.`
			: ""
	}`;

	if (isAudioOnly) {
		await bot.sendReturnMessages(new ReturnMessage({ chatId, content: caption }), group);
		for (const media of returnMessages) {
			await bot.sendReturnMessages(new ReturnMessage({ chatId, content: media }), group);
		}
	} else {
		for (let i = 0; i < returnMessages.length; i++) {
			await bot.sendReturnMessages(
				new ReturnMessage({
					chatId,
					content: returnMessages[i],
					options: i === 0 ? { caption } : {}
				}),
				group
			);
		}
	}

	if (wantLyrics) {
		const lyricsData = await searchLyrics(filename.split(".")[0]);
		if (lyricsData) {
			await bot.sendReturnMessages(
				new ReturnMessage({
					chatId,
					content: `🎶 *Letra:* ${lyricsData.title} - ${lyricsData.artist}\n\n${lyricsData.lyrics}`
				}),
				group
			);
		}
	}
}

// Configuração dos comandos
const commands = [
	new Command({
		name: "download",
		caseSensitive: false,
		description: "Baixa mídia de algum site",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "ig",
		caseSensitive: false,
		description: "Baixa mídia do Instagram",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "instagram",
		caseSensitive: false,
		description: "Baixa mídia do Instagram",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "insta",
		caseSensitive: false,
		description: "Baixa mídia do Instagram",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "tw",
		caseSensitive: false,
		description: "Baixa mídia do Twitter/X",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "twitter",
		caseSensitive: false,
		description: "Baixa mídia do Twitter/X",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "x",
		caseSensitive: false,
		description: "Baixa mídia do Twitter/X",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "tk",
		caseSensitive: false,
		description: "Baixa mídia do TikTok",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "tiktok",
		caseSensitive: false,
		description: "Baixa mídia do TikTok",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "fb",
		caseSensitive: false,
		description: "Baixa mídia do Facebook",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "facebook",
		caseSensitive: false,
		description: "Baixa mídia do Facebook",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "pin",
		caseSensitive: false,
		description: "Baixa mídia do Pinterest",
		category: "utilidades",
		method: downloadHandler
	}),
	new Command({
		name: "pinterest",
		caseSensitive: false,
		description: "Baixa mídia do Pinterest",
		category: "utilidades",
		method: downloadHandler
	})
];

module.exports = { commands };
