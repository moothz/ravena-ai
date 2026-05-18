const path = require("path");
const Logger = require("../utils/Logger");
const ytSearch = require("youtube-search-api");
const youtubedl = require("youtube-dl-exec");
const VideoCacheManager = require("../utils/VideoCacheManager");
const Database = require("../utils/Database");
const crypto = require("crypto");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const { toMp3 } = require("../utils/Conversions");
const fs = require("fs").promises;

const logger = new Logger("youtube-downloader");
const database = Database.getInstance();
const videoCacheManager = new VideoCacheManager(youtubedl, database.databasePath);

const COMMON_YTDLP_ARGS = {
	"js-runtimes": "node",
	"no-check-certificates": true,
	"no-warnings": true,
	"extractor-args": "youtube:player_client=android_vr,web_safari",
	"add-header": [
		"referer:https://www.google.com/",
		"user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	]
};

/**
 * Executa uma promise com timeout
 */
function withTimeout(promise, ms, errorMessage = "Tempo limite excedido") {
	let timeoutId;
	const timeoutPromise = new Promise((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(errorMessage));
		}, ms);
	});

	return Promise.race([promise, timeoutPromise]).finally(() => {
		clearTimeout(timeoutId);
	});
}

/**
 * Extracts the first URL found in a provided string.
 */
function extractURLFromString(text) {
	if (typeof text !== "string" || !text) {
		return null;
	}
	const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/i;
	const match = text.match(urlRegex);
	if (match && match[0]) {
		return match[0].replace(/[.,;!?)]+$/, "");
	}
	return null;
}

/**
 * Extrai o ID do vídeo de uma URL do YouTube
 */
function extractYoutubeVideoId(url) {
	if (!url) return null;
	const patterns = [
		/(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([^&]+)/i,
		/(?:https?:\/\/)?(?:www\.)?youtu\.be\/([^?]+)/i,
		/(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([^?]+)/i,
		/(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([^?]+)/i,
		/(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([^?]+)/i
	];
	for (const pattern of patterns) {
		const match = url.match(pattern);
		if (match && match[1]) {
			return match[1];
		}
	}
	return null;
}

/**
 * Busca um vídeo no YouTube por termo de pesquisa
 */
async function searchYoutubeVideo(searchTerm) {
	try {
		logger.info(`Buscando vídeo no YouTube: "${searchTerm}"`);
		const searchResults = await ytSearch.GetListByKeyword(searchTerm, false, 1);
		if (searchResults && searchResults.items && searchResults.items.length > 0) {
			const videoId = searchResults.items[0].id;
			logger.info(`Vídeo encontrado: ${videoId}`);
			return videoId;
		}
		logger.warn("Nenhum vídeo encontrado para a pesquisa");
		return null;
	} catch (error) {
		logger.error("Erro ao buscar vídeo no YouTube:", error);
		return null;
	}
}

async function baixarVideoYoutube(idVideo, dadosSolicitante, videoHD = false, callback) {
	const hash = crypto.randomBytes(2).toString("hex");
	const nomeVideoTemp = `ytdlp-${hash}`;
	let destinoVideo = path.join(process.env.DL_FOLDER, `${nomeVideoTemp}_v.mp4`);

	try {
		idVideo = idVideo.replace(/[^a-z0-9_-]/gi, "");
		const urlSafe = `https://www.youtube.com/watch?v=${idVideo}`;

		logger.info(`[baixarVideoYoutube][${nomeVideoTemp}] Buscando info do video '${urlSafe}'`);

		const infoOptions = {
			dumpSingleJson: true,
			...(process.env.YT_USE_COOKIES === "true"
				? { cookies: path.join(database.databasePath, "www.youtube.com_cookies.txt") }
				: {}),
			...COMMON_YTDLP_ARGS
		};

		withTimeout(
			videoCacheManager.getVideoInfoWithCache(urlSafe, infoOptions),
			30000,
			"Tempo esgotado ao buscar informações do vídeo. 😭"
		)
			.then((videoInfo) => {
				const autorVideo = videoInfo.uploader;
				const tituloVideo = videoInfo.title;
				logger.info(
					`[baixarVideoYoutube][${nomeVideoTemp}] Info do video '${videoInfo.id}': ${tituloVideo}, ${autorVideo}, ${videoInfo.duration}s.\nFazendo download para ${destinoVideo}`
				);

				if (videoInfo.duration > 60 * 60) {
					return callback(
						new Error(`Atualmente, só consigo baixar vídeos de até 60 minutos.`),
						null
					);
				}

				const downloadOptions = {
					o: destinoVideo,
					f: "(bv*[vcodec~='^((he|a)vc|h264)'][filesize<60M]+ba) / (bv*+ba/b)",
					remuxVideo: "mp4",
					recodeVideo: "mp4",
					audioFormat: "aac",
					ffmpegLocation: process.env.FFMPEG_PATH,
					...(process.env.YT_USE_COOKIES === "true"
						? { cookies: path.join(database.databasePath, "www.youtube.com_cookies.txt") }
						: {}),
					...COMMON_YTDLP_ARGS
				};

				withTimeout(
					videoCacheManager.downloadVideoWithCache(urlSafe, downloadOptions),
					180000,
					"Tempo esgotado ao baixar o vídeo. 😭"
				)
					.then((output) => {
						if (output.fromCache) {
							logger.info(`[baixarVideoYoutube][${nomeVideoTemp}] Estava em cache!`);
							destinoVideo = output.lastDownloadLocation;
						} else {
							logger.info(`[baixarVideoYoutube][${nomeVideoTemp}] Não tinha cache, setando...`);
							videoCacheManager.setLastDownloadLocation(urlSafe, destinoVideo, "video");
						}
						const resultado = {
							legenda: `[${autorVideo}] ${tituloVideo}`,
							arquivo: destinoVideo
						};
						logger.info(
							`[baixarVideoYoutube][${nomeVideoTemp}] Resultado: ${JSON.stringify(resultado)}`
						);
						callback(null, resultado);
					})
					.catch((error) => {
						logger.error(`[baixarVideoYoutube][${nomeVideoTemp}] Erro no download:`, error);
						callback(
							new Error(`Não consegui baixar este vídeo. Detalhes: ${error.message} 😭`),
							null
						);
					});
			})
			.catch((error) => {
				logger.error(`[baixarVideoYoutube][${nomeVideoTemp}] Erro ao buscar info:`, error);
				callback(
					new Error(
						`Não consegui pegar informações sobre este vídeo. Detalhes: ${error.message} 😭`
					),
					null
				);
			});
	} catch (e) {
		logger.error(`[baixarVideoYoutube][${nomeVideoTemp}] Erro inesperado:`, e);
		callback(e, null);
	}
}

async function baixarMusicaYoutube(idVideo, dadosSolicitante, callback) {
	const hash = crypto.randomBytes(2).toString("hex");
	const nomeVideoTemp = `ytdlp-${hash}`;
	const tempVideoPath = path.join(process.env.DL_FOLDER, `${nomeVideoTemp}_v.mp4`);

	try {
		idVideo = idVideo.replace(/[^a-z0-9_-]/gi, "");
		const urlSafe = `https://www.youtube.com/watch?v=${idVideo}`;

		logger.info(`[baixarMusicaYoutube][${nomeVideoTemp}] Buscando info do video '${urlSafe}'`);

		const infoOptions = {
			dumpSingleJson: true,
			...(process.env.YT_USE_COOKIES === "true"
				? { cookies: path.join(database.databasePath, "www.youtube.com_cookies.txt") }
				: {}),
			...COMMON_YTDLP_ARGS
		};

		withTimeout(
			videoCacheManager.getVideoInfoWithCache(urlSafe, infoOptions),
			30000,
			"Tempo esgotado ao buscar informações do vídeo. 😭"
		)
			.then((videoInfo) => {
				const autorVideo = videoInfo.uploader;
				const tituloVideo = videoInfo.title;
				logger.info(
					`[baixarMusicaYoutube][${nomeVideoTemp}] Info do video '${videoInfo.id}': ${tituloVideo}, ${autorVideo}, ${videoInfo.duration}s.`
				);

				if (videoInfo.duration > 60 * 60) {
					return callback(
						new Error(`Atualmente, só consigo baixar músicas de até 60 minutos.`),
						null
					);
				}

				logger.info(
					`[baixarMusicaYoutube][${nomeVideoTemp}] Fazendo download do vídeo para conversão...`
				);
				const downloadOptions = {
					o: tempVideoPath,
					f: "(bv*[vcodec~='^((he|a)vc|h264)'][filesize<60M]+ba) / (bv*+ba/b)",
					remuxVideo: "mp4",
					recodeVideo: "mp4",
					audioFormat: "aac",
					ffmpegLocation: process.env.FFMPEG_PATH,
					...(process.env.YT_USE_COOKIES === "true"
						? { cookies: path.join(database.databasePath, "www.youtube.com_cookies.txt") }
						: {}),
					...COMMON_YTDLP_ARGS
				};

				return withTimeout(
					videoCacheManager.downloadVideoWithCache(urlSafe, downloadOptions),
					180000,
					"Tempo esgotado ao baixar o vídeo. 😭"
				)
					.then((output) => {
						let videoToConvertPath;
						let shouldCleanup = false;

						if (output.fromCache) {
							logger.info(
								`[baixarMusicaYoutube][${nomeVideoTemp}] Vídeo estava em cache: ${output.lastDownloadLocation}`
							);
							videoToConvertPath = output.lastDownloadLocation;
						} else {
							logger.info(
								`[baixarMusicaYoutube][${nomeVideoTemp}] Vídeo baixado para: ${tempVideoPath}`
							);
							videoToConvertPath = tempVideoPath;
							shouldCleanup = true;
							videoCacheManager.setLastDownloadLocation(urlSafe, videoToConvertPath, "video");
						}

						logger.info(
							`[baixarMusicaYoutube][${nomeVideoTemp}] Convertendo '${videoToConvertPath}' para MP3...`
						);
						return toMp3(videoToConvertPath).then((audioFilePath) => ({
							audioFilePath,
							shouldCleanup,
							videoToConvertPath
						}));
					})
					.then(({ audioFilePath, shouldCleanup, videoToConvertPath }) => {
						logger.info(
							`[baixarMusicaYoutube][${nomeVideoTemp}] Conversão para MP3 concluída: ${audioFilePath}`
						);

						if (shouldCleanup) {
							fs.unlink(videoToConvertPath)
								.then(() =>
									logger.info(
										`[baixarMusicaYoutube][${nomeVideoTemp}] Arquivo de vídeo temporário removido: ${videoToConvertPath}`
									)
								)
								.catch((err) =>
									logger.warn(
										`[baixarMusicaYoutube][${nomeVideoTemp}] Falha ao remover arquivo de vídeo temporário: ${err}`
									)
								);
						}

						const resultado = { legenda: `[${autorVideo}] ${tituloVideo}`, arquivo: audioFilePath };
						logger.info(
							`[baixarMusicaYoutube][${nomeVideoTemp}] Resultado: ${JSON.stringify(resultado)}`
						);
						callback(null, resultado);
					})
					.catch((error) => {
						logger.error(
							`[baixarMusicaYoutube][${nomeVideoTemp}] Erro no download/conversão:`,
							error
						);
						callback(
							new Error(`Não consegui baixar este áudio. Detalhes: ${error.message} 😭`),
							null
						);
					});
			})
			.catch((error) => {
				logger.error(`[baixarMusicaYoutube][${nomeVideoTemp}] Erro ao buscar info:`, error);
				callback(
					new Error(
						`Não consegui pegar informações sobre este vídeo. Detalhes: ${error.message} 😭`
					),
					null
				);
			});
	} catch (e) {
		logger.error(`[baixarMusicaYoutube][${nomeVideoTemp}] Erro inesperado:`, e);
		callback(e, null);
	}
}

async function ytCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	let input = undefined;
	if (args.length === 0) {
		const quotedMsg = await message.origin.getQuotedMessage();
		if (quotedMsg) {
			input = quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body ?? undefined;
		}
	} else {
		input = args.join(" ");
	}

	if (!input) {
		return new ReturnMessage({
			chatId,
			content: "Por favor, forneça um link do YouTube ou termo de busca.",
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}

	let videoId = extractYoutubeVideoId(extractURLFromString(input));
	if (!videoId && extractURLFromString(input)) {
		return new ReturnMessage({
			chatId,
			content: "Ops! 😅 Só é possível baixar vídeos do YouTube com este comando.",
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}

	if (!videoId) {
		bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: `🔍 Buscando: "${input}" no YouTube...`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			}),
			group
		);
		videoId = await searchYoutubeVideo(input);
		if (!videoId) {
			return new ReturnMessage({
				chatId,
				content: `❌ Nenhum vídeo encontrado para: "${input}"`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}
	}

	try {
		const result = await new Promise((resolve, reject) => {
			baixarVideoYoutube(videoId, message.author, false, (error, result) => {
				if (error) reject(error);
				else resolve(result);
			});
		});

		const media = await bot.createMedia(result.arquivo, "video/mp4");
		const dicaAudio = `\n\n> *Dica:* Se vocẽ quiser apenas o áudio deste vídeo, responda esta mensagem com \`${bot.prefix}extractaudio\` (MP3)`;

		await bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: media,
				options: {
					caption: result.legenda + dicaAudio,
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			}),
			group
		);
		return true;
	} catch (error) {
		logger.error("Erro ao baixar vídeo:", error.message);
		try {
			await message.origin.react("❌");
		} catch (e) {}
		await bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: `Não foi possível baixar o vídeo. Detalhes: ${error.message}`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			}),
			group
		);
		return false;
	}
}

async function srCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	let input = undefined;
	if (args.length === 0) {
		const quotedMsg = await message.origin.getQuotedMessage();
		if (quotedMsg) {
			input = quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body ?? undefined;
		}
	} else {
		input = args.join(" ");
	}

	if (!input) {
		return new ReturnMessage({
			chatId,
			content: "Por favor, forneça um link do YouTube ou termo de busca.",
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}

	let videoId = extractYoutubeVideoId(extractURLFromString(input));
	if (!videoId && extractURLFromString(input)) {
		return new ReturnMessage({
			chatId,
			content: "Ops! 😅 Só é possível baixar músicas do YouTube com este comando.",
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}

	if (!videoId) {
		bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: `🔍 Buscando: "${input}" no YouTube...`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			}),
			group
		);
		videoId = await searchYoutubeVideo(input);
		if (!videoId) {
			return new ReturnMessage({
				chatId,
				content: `❌ Nenhum vídeo encontrado para: "${input}"`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}
	}

	try {
		const result = await new Promise((resolve, reject) => {
			baixarMusicaYoutube(videoId, message.author, (error, result) => {
				if (error) reject(error);
				else resolve(result);
			});
		});

		const media = await bot.createMedia(result.arquivo, "audio/mp3");
		await bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: media,
				options: {
					caption: result.legenda,
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			}),
			group
		);
		return true;
	} catch (error) {
		logger.error("Erro ao baixar áudio:", error.message);
		try {
			await message.origin.react("❌");
		} catch (e) {}
		await bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: `Não foi possível baixar o áudio. Detalhes: ${error.message}`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			}),
			group
		);
		return false;
	}
}

async function processYoutubeReaction(bot, message, emoji) {
	try {
		if (emoji !== "⏬" || !message.group) return false;
		const messageText = message.type === "text" ? message.content : message.caption;
		if (!messageText) return false;
		const videoId = extractYoutubeVideoId(messageText);
		if (!videoId) return false;

		logger.info(`Processando reação para download de vídeo: ${videoId}`);
		try {
			message.origin.react(process.env.LOADING_EMOJI ?? "⌛️");
		} catch (e) {}

		const chatId = message.group ?? message.author;
		bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: "Baixando vídeo do YouTube...",
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			})
		);

		baixarVideoYoutube(videoId, message.author, false, async (error, result) => {
			if (error) {
				try {
					await message.origin.react("❌");
				} catch (e) {}
				return bot.sendReturnMessages(
					new ReturnMessage({
						chatId,
						content: `Erro ao baixar vídeo: ${error.message}`
					})
				);
			}
			try {
				const media = await bot.createMedia(result.arquivo, "video/mp4");
				await bot.sendReturnMessages(
					new ReturnMessage({
						chatId,
						content: media,
						options: { caption: result.legenda }
					})
				);
				try {
					await message.origin.react("✅");
				} catch (e) {}
			} catch (e) {
				try {
					await message.origin.react("❌");
				} catch (e) {}
			}
		});
		return true;
	} catch (error) {
		return false;
	}
}

const commands = [
	new Command({
		name: "yt",
		caseSensitive: false,
		description: "Baixa um vídeo do YouTube",
		category: "downloaders",
		reactions: { before: process.env.LOADING_EMOJI ?? "⌛️", after: "✅", error: "❌" },
		method: ytCommand
	}),
	new Command({
		name: "sr",
		caseSensitive: false,
		description: "Baixa uma música do YouTube (áudio do vídeo)",
		category: "downloaders",
		reactions: { before: process.env.LOADING_EMOJI ?? "⌛️", after: "✅", error: "❌" },
		method: srCommand
	})
];

module.exports = { commands, processYoutubeReaction };
