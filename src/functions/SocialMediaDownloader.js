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

// Importa métodos do YoutubeDownloader para roteamento de YouTube
const YoutubeDownloader = require("./YoutubeDownloader");
const { extractYoutubeVideoId, searchYoutubeVideo, extractURLFromString } = YoutubeDownloader;

const logger = new Logger("social-media-downloader");
const database = Database.getInstance();
const storageService = require("../services/StorageService");

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
		this.cleanup().catch((e) => logger.error("Erro no cleanup de cache:", e.message));
	}

	async deleteCache(url) {
		await database.dbRun(this.dbName, "DELETE FROM smd_cache WHERE url = ?", [url]);
	}

	async cleanup() {
		try {
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
 * Wrapper de retry para operações de download
 * Tenta executar a função até maxRetries vezes antes de falhar
 */
async function withRetry(fn, maxRetries = 2, delayMs = 3000) {
	let lastError;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (attempt < maxRetries) {
				logger.warn(
					`[withRetry] Tentativa ${attempt}/${maxRetries} falhou: ${error.message}. Tentando novamente em ${delayMs}ms...`
				);
				await new Promise((r) => setTimeout(r, delayMs));
			}
		}
	}
	throw lastError;
}

/**
 * Detecta a plataforma da URL (incluindo YouTube e SoundCloud)
 */
function detectPlatform(url) {
	if (!url) return "Desconhecido";
	const platforms = {
		"youtube.com": "YouTube",
		"youtu.be": "YouTube",
		"tiktok.com": "TikTok",
		"instagram.com": "Instagram",
		"facebook.com": "Facebook",
		"fb.watch": "Facebook",
		"fb.com": "Facebook",
		"twitter.com": "Twitter",
		"x.com": "Twitter",
		"twitch.tv": "Twitch Clips",
		"clips.twitch.tv": "Twitch Clips",
		"snapchat.com": "Snapchat",
		"reddit.com": "Reddit",
		"vimeo.com": "Vimeo",
		"streamable.com": "Streamable",
		"pinterest.com": "Pinterest",
		"pin.it": "Pinterest",
		"linkedin.com": "LinkedIn",
		"bilibili.com": "Bilibili",
		"bilibili.tv": "Bilibili",
		"b.tv": "Bilibili",
		"soundcloud.com": "SoundCloud",
		"bsky.app": "Bluesky",
		"bsky.social": "Bluesky",
		"dailymotion.com": "Dailymotion",
		"dai.ly": "Dailymotion",
		"loom.com": "Loom",
		"ok.ru": "Ok",
		"newgrounds.com": "Newgrounds",
		"rutube.ru": "Rutube",
		"tumblr.com": "Tumblr",
		"vk.com": "VK",
		"vk.ru": "VK"
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
 * Verifica se a URL é do YouTube
 */
function isYoutubeUrl(url) {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		return hostname.includes("youtube.com") || hostname.includes("youtu.be");
	} catch {
		return false;
	}
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
async function downloadFile(url, filename, authorInfo = null) {
	const dlFolder = process.env.DL_FOLDER || "/app/downloads";
	const dlPath = path.join(dlFolder, filename);

	if (!fsSync.existsSync(dlFolder)) {
		fsSync.mkdirSync(dlFolder, { recursive: true });
	}

	const writer = fsSync.createWriteStream(dlPath);

	try {
		logger.info(`[DOWNLOAD] Tentando URL: ${url}${authorInfo ? ` (Autor: ${authorInfo})` : ""}`);
		const response = await axios({
			url,
			method: "GET",
			responseType: "stream",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
			},
			timeout: 600000
		});

		await pipeline(response.data, writer);
		await new Promise((r) => setTimeout(r, 1000));

		const stats = fsSync.statSync(dlPath);
		logger.info(
			`[DOWNLOAD] Finalizado: ${stats.size} bytes${authorInfo ? ` (Autor: ${authorInfo})` : ""}`
		);

		if (stats.size === 0) throw new Error("Arquivo vazio recebido.");

		return dlPath;
	} catch (error) {
		if (fsSync.existsSync(dlPath)) fsSync.unlinkSync(dlPath);
		logger.error(
			`[DOWNLOAD] Falha: ${error.message}${authorInfo ? ` (Autor: ${authorInfo})` : ""}`
		);
		throw error;
	}
}

/**
 * Faz requisição para a API Cobalt (com suporte a fallback caso o endpoint principal falhe)
 */
async function cobaltRequest(url, options = {}, authorInfo = null) {
	const primaryUrl = process.env.COBALT_API_URL || "http://cobalt:9000";
	const fallbackUrls = ["https://api.cobalt.tools"];
	const endpoints = [primaryUrl, ...fallbackUrls];
	let lastError = null;

	const platform = detectPlatform(url);

	for (const endpoint of endpoints) {
		try {
			logger.info(
				`[Cobalt] Tentando baixar ${platform} do link: ${url} (Autor: ${authorInfo || "Desconhecido"}) usando endpoint: ${endpoint}`
			);
			const response = await axios.post(
				`${endpoint}/`,
				{
					url,
					...options
				},
				{
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json"
					},
					timeout: 120000
				}
			);

			const data = response.data;

			if (data && data.status === "error") {
				if (endpoint !== endpoints[endpoints.length - 1]) {
					logger.warn(
						`[Cobalt] Erro retornado por ${endpoint} (${data.error?.code || data.text || "erro"}) para o link: ${url} (Autor: ${authorInfo || "Desconhecido"}), tentando fallback...`
					);
					lastError = new Error(data.error?.code || data.text || "Erro no serviço de download.");
					continue;
				}
				return data;
			}

			const externalUrl =
				endpoint === primaryUrl ? process.env.COBALT_EXTERNAL_URL || primaryUrl : endpoint;
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
			logger.warn(
				`[Cobalt] Erro de rede/API com ${endpoint} para o link: ${url} (Autor: ${authorInfo || "Desconhecido"}):`,
				errorData || error.message
			);
			lastError = error;
			if (endpoint !== endpoints[endpoints.length - 1]) {
				continue;
			}
		}
	}

	const errorData = lastError?.response?.data;
	logger.error(
		`[Cobalt] Todos os endpoints falharam para o link: ${url} (Autor: ${authorInfo || "Desconhecido"}).`,
		errorData || lastError?.message
	);
	throw new Error(
		errorData?.text || lastError?.message || "O serviço de download não respondeu corretamente."
	);
}

// ==============================
// Emojis numéricos para reações interativas (1 a 9)
// ==============================
const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
const NUMBER_EMOJIS2 = ["1⃣", "2⃣", "3⃣", "4⃣", "5⃣", "6⃣", "7⃣", "8⃣", "9⃣"];
const NUMBER_EMOJIS3 = ["1️", "2️", "3️", "4️", "5️", "6️", "7️", "8️", "9️"];

// Gerenciador em memória das sessões de busca do YouTube (TTL 10 minutos)
const searchSessions = new Map();
const SEARCH_SESSION_TTL_MS = 10 * 60 * 1000;

function cleanExpiredSearchSessions() {
	const now = Date.now();
	for (const [key, session] of searchSessions.entries()) {
		if (now - session.createdAt > SEARCH_SESSION_TTL_MS) {
			searchSessions.delete(key);
		}
	}
}

function saveSearchSession(botMsgId, chatId, sessionData) {
	cleanExpiredSearchSessions();
	const session = {
		...sessionData,
		botMsgId: botMsgId || sessionData?.botMsgId,
		createdAt: Date.now()
	};
	if (botMsgId) {
		searchSessions.set(`msg:${botMsgId}`, session);
	}
	if (chatId) {
		searchSessions.set(`chat:${chatId}`, session);
	}
	return session;
}

function getSearchSession(msgId, chatId) {
	cleanExpiredSearchSessions();
	if (msgId && searchSessions.has(`msg:${msgId}`)) {
		return searchSessions.get(`msg:${msgId}`);
	}
	if (chatId && searchSessions.has(`chat:${chatId}`)) {
		return searchSessions.get(`chat:${chatId}`);
	}
	return null;
}

/**
 * Converte string de duração ("MM:SS" ou "HH:MM:SS") para segundos inteiros
 */
function parseDurationToSeconds(durationStr) {
	if (!durationStr || typeof durationStr !== "string") return 0;
	const parts = durationStr
		.trim()
		.split(":")
		.map((p) => parseInt(p, 10));
	if (parts.some((p) => isNaN(p))) return 0;

	if (parts.length === 3) {
		return parts[0] * 3600 + parts[1] * 60 + parts[2];
	} else if (parts.length === 2) {
		return parts[0] * 60 + parts[1];
	} else if (parts.length === 1) {
		return parts[0];
	}
	return 0;
}

/**
 * Seleciona o índice do vídeo padrão:
 * - O mais longo da lista com duração <= 5 minutos (300 segundos)
 * - Se não houver nenhum <= 5 min, pega o menor da lista
 */
function selectDefaultVideoIndex(items) {
	if (!items || items.length === 0) return 0;

	const withDuration = items.map((item, index) => ({
		index,
		seconds: parseDurationToSeconds(item.duration)
	}));

	const underFiveMins = withDuration.filter((it) => it.seconds > 0 && it.seconds <= 300);
	if (underFiveMins.length > 0) {
		underFiveMins.sort((a, b) => b.seconds - a.seconds);
		return underFiveMins[0].index;
	}

	const withValid = withDuration.filter((it) => it.seconds > 0);
	if (withValid.length > 0) {
		withValid.sort((a, b) => a.seconds - b.seconds);
		return withValid[0].index;
	}

	return 0;
}

/**
 * Monta o texto da lista de busca com formatação de status (⏳ em andamento, ✅ concluído)
 */
function buildSearchListText(session) {
	const {
		query,
		commandName,
		prefix,
		items = [],
		inProgressIndex,
		completedIndices = []
	} = session;
	let listText = `⏬ *rav-downloader* Buscando por _"${query}"_ no *YouTube* 🔍\n\nEncontrados:\n`;

	items.forEach((v, idx) => {
		const num = idx + 1;
		const channel = v.channelTitle || "Canal";
		const duration = v.duration ? ` (${v.duration})` : "";
		const title = v.title || "Sem título";
		const lineContent = `${num}. [${channel}] ${title}${duration}`;

		if (idx === inProgressIndex) {
			listText += `⏳ *${lineContent}*\n`;
		} else if (completedIndices.includes(idx)) {
			listText += `✅ *${lineContent}*\n`;
		} else {
			listText += `${lineContent}\n`;
		}
	});

	const activeNum =
		inProgressIndex !== null && inProgressIndex !== undefined ? inProgressIndex + 1 : 1;
	const suggestedNum = activeNum === 1 ? 2 : 1;
	const cmdPrefix = prefix || "!";
	const cmd = commandName || "yt";

	if (inProgressIndex !== null && inProgressIndex !== undefined) {
		listText += `\nBaixando opção ${activeNum}! Para outra opção, reaja à esta mensagem com os emojis de numeros ou com *${cmdPrefix}${cmd} ${suggestedNum}*`;
	} else {
		listText += `\nPara baixar outra opção, reaja à esta mensagem com os emojis de numeros ou com *${cmdPrefix}${cmd} ${suggestedNum}*`;
	}

	return listText;
}

/**
 * Atualiza via edição a mensagem da lista no WhatsApp
 */
async function updateSearchListMessage(bot, chatId, session) {
	if (!bot || !chatId || !session?.botMsgId) return;
	try {
		const newText = buildSearchListText(session);
		if (typeof bot.editMessage === "function") {
			await bot.editMessage(chatId, session.botMsgId, newText);
		}
	} catch (err) {
		logger.debug(
			`[updateSearchListMessage] Falha ao editar mensagem ${session.botMsgId}: ${err.message}`
		);
	}
}

/**
 * Executa o download de um vídeo ou áudio do YouTube e entrega formatado com links S3
 */
async function executeYoutubeDownload(
	bot,
	chatId,
	group,
	message,
	item,
	isAudioOnly,
	wantLyrics,
	session = null,
	itemIndex = null,
	videoHD = true
) {
	const author = message.author || "Desconhecido";
	const videoId = item.id;

	if (isAudioOnly && typeof YoutubeDownloader.baixarMusicaYoutube === "function") {
		return new Promise((resolve) => {
			YoutubeDownloader.baixarMusicaYoutube(videoId, author, async (error, result) => {
				if (error) {
					if (session && itemIndex !== null && itemIndex !== undefined) {
						if (session.inProgressIndex === itemIndex) {
							session.inProgressIndex = null;
						}
						await updateSearchListMessage(bot, chatId, session);
					}
					await bot.sendReturnMessages(
						new ReturnMessage({
							chatId,
							content: `❌ Erro ao baixar áudio do YouTube: ${error.message}`
						}),
						group
					);
					resolve([]);
					return;
				}

				try {
					let s3Url = null;
					if (result?.arquivo && fsSync.existsSync(result.arquivo)) {
						try {
							const cleanFileName = path.basename(result.arquivo);
							const s3Key = `yt/${cleanFileName}`;
							await storageService.upload(fsSync.createReadStream(result.arquivo), s3Key, {
								bucket: storageService.bucketDownloads,
								mimetype: "audio/mpeg"
							});
							s3Url = await storageService.getPresignedUrl(s3Key, {
								bucket: storageService.bucketDownloads,
								shorten: true
							});
						} catch (s3Err) {
							logger.warn("Falha ao subir áudio para S3:", s3Err.message);
						}
					}

					// 1. Envia áudio
					const media = await bot.createMedia(result.arquivo, "audio/mp3");
					await bot.sendReturnMessages(
						new ReturnMessage({
							chatId,
							content: media
						}),
						group
					);

					// 2. Envia segunda mensagem formatada como a legenda do vídeo com link S3
					let msg2Text = `✅ *Download Concluído!*\n\n🌐 *Fonte:* YouTube\n📝 *Título:* ${result.legenda || item.title || videoId}`;
					if (s3Url) {
						msg2Text += `\n📥 *Link direto (válido por 6h):* ${s3Url}`;
					}

					// 2.1 Se comando foi !musica, busca letra
					if (wantLyrics) {
						const rawTitle = result.legenda || item.title || "";
						const cleanQuery = rawTitle.replace(/^\[.*?\]\s*/, "");
						const lyricsData = (await searchLyrics(cleanQuery)) || (await searchLyrics(rawTitle));
						if (lyricsData && lyricsData.lyrics) {
							msg2Text += `\n\n🎶 *Letra:* ${lyricsData.title} - ${lyricsData.artist}\n\n${lyricsData.lyrics}`;
						}
					}

					await bot.sendReturnMessages(
						new ReturnMessage({
							chatId,
							content: msg2Text
						}),
						group
					);

					if (session && itemIndex !== null && itemIndex !== undefined) {
						if (!session.completedIndices) session.completedIndices = [];
						if (!session.completedIndices.includes(itemIndex)) {
							session.completedIndices.push(itemIndex);
						}
						if (session.inProgressIndex === itemIndex) {
							session.inProgressIndex = null;
						}
						await updateSearchListMessage(bot, chatId, session);
					}
				} catch (sendError) {
					logger.error("Erro ao enviar áudio do YouTube:", sendError);
					await bot.sendReturnMessages(
						new ReturnMessage({ chatId, content: "Erro ao enviar áudio." }),
						group
					);
				}
				resolve([]);
			});
		});
	} else if (typeof YoutubeDownloader.baixarVideoYoutube === "function") {
		return new Promise((resolve) => {
			YoutubeDownloader.baixarVideoYoutube(videoId, author, videoHD, async (error, result) => {
				if (error) {
					if (session && itemIndex !== null && itemIndex !== undefined) {
						if (session.inProgressIndex === itemIndex) {
							session.inProgressIndex = null;
						}
						await updateSearchListMessage(bot, chatId, session);
					}
					await bot.sendReturnMessages(
						new ReturnMessage({
							chatId,
							content: `❌ Erro ao baixar vídeo do YouTube: ${error.message}`
						}),
						group
					);
					resolve([]);
					return;
				}

				try {
					let isTooLargeForWaVideo = false;
					if (result?.arquivo && fsSync.existsSync(result.arquivo)) {
						try {
							const stats = fsSync.statSync(result.arquivo);
							isTooLargeForWaVideo = stats.size > 60 * 1024 * 1024;
						} catch {}
					}

					let s3Url = null;
					if (result?.arquivo && fsSync.existsSync(result.arquivo)) {
						try {
							const cleanFileName = path.basename(result.arquivo);
							const s3Key = `yt/${cleanFileName}`;
							await storageService.upload(fsSync.createReadStream(result.arquivo), s3Key, {
								bucket: storageService.bucketDownloads,
								mimetype: "video/mp4"
							});
							s3Url = await storageService.getPresignedUrl(s3Key, {
								bucket: storageService.bucketDownloads,
								shorten: true
							});
						} catch (s3Err) {
							logger.warn("Falha ao subir vídeo para S3:", s3Err.message);
						}
					}

					let caption = `✅ *Download Concluído!*\n\n🌐 *Fonte:* YouTube\n📝 *Título:* ${result.legenda || item.title || videoId}`;
					if (s3Url) {
						caption += `\n📥 *Vídeo em alta qualidade:* ${s3Url}`;
					}
					if (isTooLargeForWaVideo) {
						caption += `\n\n📂 Enviado como arquivo devido ao limite de tamanho para vídeos no WhatsApp`;
					}
					caption += `\n\n> *Dica:* Se quiser apenas o áudio, responda este vídeo com \`${bot.prefix}extractaudio\``;

					const media = await bot.createMedia(result.arquivo, "video/mp4");
					await bot.sendReturnMessages(
						new ReturnMessage({
							chatId,
							content: media,
							options: {
								caption,
								sendMediaAsDocument: isTooLargeForWaVideo
							}
						}),
						group
					);

					if (session && itemIndex !== null && itemIndex !== undefined) {
						if (!session.completedIndices) session.completedIndices = [];
						if (!session.completedIndices.includes(itemIndex)) {
							session.completedIndices.push(itemIndex);
						}
						if (session.inProgressIndex === itemIndex) {
							session.inProgressIndex = null;
						}
						await updateSearchListMessage(bot, chatId, session);
					}
				} catch (sendError) {
					logger.error("Erro ao enviar vídeo do YouTube:", sendError);
					let linkFallback = null;
					if (result?.arquivo && fsSync.existsSync(result.arquivo)) {
						try {
							const cleanFileName = path.basename(result.arquivo);
							const s3Key = `yt/${cleanFileName}`;
							linkFallback = await storageService.getPresignedUrl(s3Key, {
								bucket: storageService.bucketDownloads,
								shorten: true
							});
						} catch {}
					}

					const errorMsg = linkFallback
						? `⚠️ O vídeo excedeu o limite do WhatsApp!\n\n> 📥 *Baixe diretamente aqui (válido por 6h):*\n${linkFallback}`
						: "Erro ao enviar vídeo.";

					await bot.sendReturnMessages(new ReturnMessage({ chatId, content: errorMsg }), group);
				}
				resolve([]);
			});
		});
	} else {
		logger.warn("Métodos do YoutubeDownloader indisponíveis");
	}
}

/**
 * Handler de reação para seleção numérica das buscas do YouTube
 */
async function processYoutubeSearchReaction(bot, message, args, group) {
	if (!message.originReaction) return false;
	const reaction = message.originReaction;
	let emojiIndex = NUMBER_EMOJIS.indexOf(reaction.reaction);
	if (emojiIndex === -1) emojiIndex = NUMBER_EMOJIS2.indexOf(reaction.reaction);
	if (emojiIndex === -1) emojiIndex = NUMBER_EMOJIS3.indexOf(reaction.reaction);
	if (emojiIndex === -1) return false;

	const targetMsgId = reaction.msgId?._serialized || reaction.msgId?.id || reaction.msgId;
	const chatId = message.group ?? message.author;
	const session = getSearchSession(targetMsgId, chatId);
	if (!session) return false;

	const item = session.items[emojiIndex];
	if (!item) return false;

	try {
		if (typeof message.origin?.react === "function") {
			await message.origin.react(process.env.LOADING_EMOJI ?? "⌛️");
		} else if (typeof bot.react === "function") {
			await bot.react(reaction.msgId, process.env.LOADING_EMOJI ?? "⌛️");
		}
	} catch {}

	// Marca o item como em andamento e atualiza a mensagem da lista
	session.inProgressIndex = emojiIndex;
	await updateSearchListMessage(bot, session.chatId, session);

	await executeYoutubeDownload(
		bot,
		session.chatId,
		group,
		message,
		item,
		session.isAudioOnly,
		session.wantLyrics,
		session,
		emojiIndex,
		session.videoHD || false
	);
	return true;
}

/**
 * Handler principal de downloads via Cobalt (para redes sociais, SoundCloud, etc.)
 * YouTube é roteado para os métodos do YoutubeDownloader.
 */
async function downloadHandler(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const body = message.origin?.body || "";
	const commandName = body.split(" ")[0].substring(bot.prefix.length).toLowerCase();

	const authorName =
		message.name ?? message.pushName ?? message.pushname ?? message.authorName ?? "Desconhecido";
	const authorNumber = message.author ?? "Desconhecido";
	const authorInfo = `${authorName} (${authorNumber})`;

	// --- Extrai input: args ou quotedMsg ---
	let input = undefined;
	if (args.length === 0) {
		// Verifica a quotedMsg (como ytCommand / srCommand fazem)
		const quotedMsg = await message.origin.getQuotedMessage();
		if (quotedMsg) {
			input = quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body ?? undefined;
		}
	} else {
		input = args.join(" ");
	}

	// Tenta extrair uma URL do input
	let url = null;
	if (input) {
		url = extractURLFromString(input);
	}

	// Se não tinha URL no input, tenta também pela quotedMsg original do message.origin (fallback)
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

	// --- Modos de áudio e letra ---
	const isAudioOnly =
		commandName.includes("audio") ||
		commandName.includes("musica") ||
		commandName === "sr" ||
		commandName.includes("sc") ||
		args.includes("-audio") ||
		args.includes("-musica");
	const wantLyrics =
		commandName.includes("musica") ||
		args.includes("-musica") ||
		// Se for SoundCloud e for audio, também busca letra
		(commandName.includes("sc") && isAudioOnly);
	const isHD = args.includes("-hd") || args.includes("hd") || commandName.includes("hd");

	// Se o comando for apenas um número de 1 a 9, verifica se é seleção de opção de busca
	const isNumericChoice =
		/^[1-9]$/.test(args[0]) &&
		(args.length === 1 || (args.length === 2 && (args[1] === "-hd" || args[1] === "hd")));

	if (isNumericChoice) {
		let quotedId = null;
		if (typeof message.origin?.getQuotedMessage === "function") {
			try {
				const qm = await message.origin.getQuotedMessage();
				quotedId = qm?.id?._serialized || qm?.id?.id || qm?.id;
			} catch {}
		}
		const session = getSearchSession(quotedId, chatId);
		if (session) {
			const idx = parseInt(args[0], 10) - 1;
			const item = session.items[idx];
			if (item) {
				try {
					if (typeof message.origin?.react === "function") {
						await message.origin.react(process.env.LOADING_EMOJI ?? "⌛️");
					}
				} catch {}
				session.inProgressIndex = idx;
				await updateSearchListMessage(bot, chatId, session);

				await executeYoutubeDownload(
					bot,
					chatId,
					group,
					message,
					item,
					session.isAudioOnly,
					session.wantLyrics,
					session,
					idx,
					session.videoHD !== undefined ? session.videoHD : true
				);
				return [];
			}
		}
	}

	// ==============================
	// ROTEAMENTO: YouTube → YoutubeDownloader
	// ==============================
	if (url && isYoutubeUrl(url)) {
		const videoId = extractYoutubeVideoId(url);
		if (videoId) {
			logger.info(
				`Roteando YouTube para YoutubeDownloader: ${videoId} (audio=${isAudioOnly}) (Autor: ${authorInfo})`
			);

			await executeYoutubeDownload(
				bot,
				chatId,
				group,
				message,
				{ id: videoId, title: "Vídeo do YouTube" },
				isAudioOnly,
				wantLyrics,
				null,
				null,
				true
			);
			return [];
		}
	}

	// ==============================
	// Se não tem URL, busca interativa no YouTube (1 mensagem com lista de até 9)
	// ==============================
	if (!url) {
		const rawQuery = input ? input.trim() : "";
		const query = rawQuery.replace(/\b-?hd\b/gi, "").trim();
		if (query && query.length > 0) {
			try {
				const searchResults = await yts.GetListByKeyword(query, false, 15);
				const rawVideos = (searchResults?.items || []).filter((item) => item.type === "video");
				const videos = rawVideos.slice(0, 9);

				if (videos.length === 0) {
					return new ReturnMessage({
						chatId,
						content: `❌ Nenhum vídeo encontrado para "_${query}_" no YouTube.`
					});
				}

				const sessionItems = [];
				videos.forEach((v) => {
					const channel = v.channelTitle || v.shortBylineText?.runs?.[0]?.text || "Canal";
					const title = v.title || "Sem título";
					sessionItems.push({
						id: v.id,
						title,
						channelTitle: channel,
						duration: v.length?.simpleText || "",
						url: `https://www.youtube.com/watch?v=${v.id}`
					});
				});

				const invokedCmd = commandName || "yt";
				const chosenIdx = selectDefaultVideoIndex(sessionItems);

				const sessionData = {
					query,
					commandName: invokedCmd,
					prefix: bot.prefix || "!",
					isAudioOnly,
					wantLyrics,
					videoHD: true,
					author: message.author,
					chatId,
					items: sessionItems,
					inProgressIndex: chosenIdx,
					completedIndices: []
				};

				const listText = buildSearchListText(sessionData);

				const sentMsgs = await bot.sendReturnMessages(
					new ReturnMessage({
						chatId,
						content: listText
					}),
					group
				);

				const sentMsgId =
					sentMsgs?.[0]?.id?._serialized || sentMsgs?.[0]?.id?.id || sentMsgs?.[0]?.id;

				sessionData.botMsgId = sentMsgId;
				saveSearchSession(sentMsgId, chatId, sessionData);

				// Dispara imediatamente o download da opção selecionada
				const selectedItem = sessionItems[chosenIdx];
				await executeYoutubeDownload(
					bot,
					chatId,
					group,
					message,
					selectedItem,
					isAudioOnly,
					wantLyrics,
					sessionData,
					chosenIdx,
					isHD
				);
				return [];
			} catch (searchError) {
				logger.error(`Erro na busca do YouTube: ${searchError.message}`);
				return new ReturnMessage({
					chatId,
					content: `❌ Erro ao buscar por "_${query}_" no YouTube: ${searchError.message}`
				});
			}
		}
	}

	// Se ainda não tem URL, erro
	if (!url) {
		return new ReturnMessage({
			chatId,
			content: `❌ Por favor, forneça uma URL válida ou um termo de busca.\nExemplo: \`${bot.prefix}${commandName} https://...\` ou \`${bot.prefix}${commandName} nome da música\``
		});
	}

	// ==============================
	// Cobalt: processa URLs não-YouTube
	// ==============================
	const platform = detectPlatform(url);

	// Verifica Cache
	const cacheKey = `${url}_${isAudioOnly ? "audio" : "video"}`;
	const cachedData = await cacheManager.getCache(cacheKey);

	if (cachedData) {
		logger.info(`Cache encontrado para: ${url} (Autor: ${authorInfo})`);
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
		// Executa todo o fluxo de download com até 3 tentativas (1 original + 2 retries)
		await withRetry(
			async () => {
				const cobaltOptions = {
					videoQuality: "720",
					filenameStyle: "pretty"
				};

				if (isAudioOnly) {
					cobaltOptions.downloadMode = "audio";
					cobaltOptions.audioFormat = "mp3";
				}

				const result = await cobaltRequest(url, cobaltOptions, authorInfo);

				if (result.status === "error") {
					throw new Error(result.text || "Erro desconhecido no serviço de download.");
				}

				const items = [];
				const dlUrl =
					result.url || (Array.isArray(result.tunnel) ? result.tunnel[0] : result.tunnel);

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
				logger.info(
					`Iniciando transferência de ${items.length} item(ns) para ${displayFilename} (Autor: ${authorInfo})`
				);

				const processedFiles = [];
				for (const item of items) {
					const tempFilename = `${crypto.randomBytes(4).toString("hex")}_${item.filename}`;
					const filePath = await downloadFile(item.url, tempFilename, authorInfo);

					let finalFilePath = filePath;
					let finalMime = isAudioOnly ? "audio/mpeg" : "video/mp4";

					const ext = path.extname(item.filename).toLowerCase();
					if (
						item.type === "photo" ||
						item.type === "image" ||
						[".jpg", ".jpeg", ".png", ".webp"].includes(ext)
					) {
						finalMime = "image/jpeg";
					}

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

				await cacheManager.setCache(cacheKey, platform, displayFilename, processedFiles);

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
			},
			3,
			5000
		); // 3 tentativas no total (1 original + 2 retries), 5s de intervalo
	} catch (error) {
		logger.error(
			`Erro no download após retries para o link: ${url} (Autor: ${authorInfo}): ${error.message}`
		);
		await bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: `❌ *Erro ao processar download após várias tentativas:*\n${error.message}`
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

// ==============================
// Configuração dos comandos
// ==============================
const downloadCommands = [
	"download",
	"download-audio",
	"download-musica",
	"baixar",
	"baixar-audio",
	"baixar-musica",
	"musica",
	"yt",
	"yt-audio",
	"yt-musica",
	"sr",
	"x",
	"twitter",
	"tiktok",
	"tk",
	"tiktok-audio",
	"insta",
	"instagram",
	"insta-audio",
	"fb",
	"facebook",
	"pin",
	"pinterest",
	// SoundCloud
	"sc",
	"sc-audio",
	"sc-musica",
	"soundcloud",
	"soundcloud-audio",
	"soundcloud-musica",
	// Novas plataformas Cobalt suportadas
	"bilibili",
	"bilibili-audio",
	"bluesky",
	"bluesky-audio",
	"dailymotion",
	"dailymotion-audio",
	"loom",
	"ok",
	"newgrounds",
	"reddit",
	"reddit-audio",
	"rutube",
	"rutube-audio",
	"snapchat",
	"snapchat-audio",
	"streamable",
	"tumblr",
	"tumblr-audio",
	"twitch",
	"twitch-audio",
	"vimeo",
	"vimeo-audio",
	"vk",
	"vk-audio"
];

async function downloadsDisabledCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	return new ReturnMessage({
		chatId,
		content:
			"⚠️ *Downloads temporariamente desabilitados!* ⚠️\n\nEsta funcionalidade está em manutenção e voltará em breve. Agradecemos a compreensão! ✨"
	});
}

const disableDownloads = process.env.DISABLE_DOWNLOADS && process.env.DISABLE_DOWNLOADS !== "false";

const commands = downloadCommands.map(
	(name) =>
		new Command({
			name,
			caseSensitive: false,
			description: `Baixa conteúdo de mídias sociais${
				name.includes("audio") || name.includes("musica") || name === "sr" ? " (apenas áudio)" : ""
			}`,
			category: "downloaders",
			reactions: disableDownloads
				? {
						before: null,
						after: "⚠️",
						error: "❌"
					}
				: {
						before: process.env.LOADING_EMOJI ?? "⌛️",
						after: "✅",
						error: "❌"
					},
			method: disableDownloads ? downloadsDisabledCommand : downloadHandler
		})
);

commands[0].reactions.trigger = "⬇️";
commands[1].reactions.trigger = "⏬";

commands.push(
	new Command({
		name: "reactionYoutubeSearchHelper",
		description: "Invocado apenas pelo ReactionsHandler para selecionar vídeos da busca do YouTube",
		reactions: {
			trigger: NUMBER_EMOJIS.concat(NUMBER_EMOJIS2, NUMBER_EMOJIS3)
		},
		usage: "",
		hidden: true,
		method: processYoutubeSearchReaction
	})
);

// Expõe as funções de extração de URL e detecção de YouTube para outros módulos
const helper = {
	about: "Download unificado de vídeos, fotos e áudios de mais de 30 plataformas de redes sociais",
	implementation:
		"Utiliza Cobalt API, youtube-dl-exec e instâncias de proxy com cache inteligente em SQLite para entregar mídias em alta qualidade",
	tags: "download,baixar,video,audio,instagram,tiktok,youtube,twitter,x,reddit,soundcloud,facebook",
	cmds: [
		{
			cmd: "!baixar",
			desc: "Baixa vídeos, áudios ou fotos de links do YouTube, Instagram, TikTok, Twitter/X, Reddit, etc.",
			usage: [
				"!baixar https://vm.tiktok.com/...",
				"!baixar https://instagram.com/reel/...",
				"!baixar https://youtu.be/..."
			],
			category: "downloaders"
		},
		{
			cmd: "!ig",
			desc: "Atalho para baixar publicações, reels e stories do Instagram",
			usage: ["!ig https://instagram.com/p/..."],
			category: "downloaders"
		},
		{
			cmd: "!tt",
			desc: "Atalho para baixar vídeos do TikTok",
			usage: ["!tt https://tiktok.com/@user/video/..."],
			category: "downloaders"
		},
		{
			cmd: "!tw",
			desc: "Atalho para baixar vídeos e mídias do Twitter / X",
			usage: ["!tw https://x.com/user/status/..."],
			category: "downloaders"
		}
	]
};

module.exports = {
	helper,
	commands,
	downloadHandler,
	detectPlatform,
	extractURLFromString,
	isYoutubeUrl,
	extractYoutubeVideoId,
	searchSessions,
	saveSearchSession,
	getSearchSession,
	executeYoutubeDownload,
	processYoutubeSearchReaction,
	parseDurationToSeconds,
	selectDefaultVideoIndex,
	buildSearchListText,
	updateSearchListMessage
};
