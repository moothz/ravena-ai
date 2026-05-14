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

//logger.info('Módulo YoutubeDownloader carregado');

/**
 * Extracts the first URL found in a provided string.
 *
 * @param {string} text - The string to search for a URL.
 * @returns {string|null} - The first URL found, or null if no URL is present or input is invalid.
 */
function extractURLFromString(text) {
	// Failsafe 1: Input validation
	if (typeof text !== "string" || !text) {
		return null;
	}

	// Regex breakdown:
	// (https?:\/\/[^\s]+) -> Matches http or https followed by non-whitespace characters
	// (www\.[^\s]+)       -> Matches www. followed by non-whitespace characters
	// Flags: 'i' for case-insensitive
	const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/i;

	const match = text.match(urlRegex);

	// Failsafe 2: Check if a match exists
	if (match && match[0]) {
		// Optional: clean trailing punctuation often captured by simple regex (like periods or commas at end of sentence)
		return match[0].replace(/[.,;!?)]+$/, "");
	}

	return null;
}

/**
 * Extrai o ID do vídeo de uma URL do YouTube
 * @param {string} url - URL do YouTube
 * @returns {string|null} - ID do vídeo ou null se não for encontrado
 */
function extractYoutubeVideoId(url) {
	if (!url) return null;

	// Padrões de URL do YouTube
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
 * @param {string} searchTerm - Termo de pesquisa
 * @returns {Promise<string|null>} - ID do vídeo encontrado ou null
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

/**
 * Processa uma reação para download de vídeo/áudio do YouTube
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Mensagem
 * @param {string} emoji - Emoji da reação
 * @returns {Promise<boolean>} - True se a reação foi processada
 */
async function processYoutubeReaction(bot, message, emoji) {
	try {
		if (emoji !== "⏬" || !message.group) return false;

		// Obtém texto da mensagem original
		const messageText = message.type === "text" ? message.content : message.caption;
		if (!messageText) return false;

		// Verifica se tem URL do YouTube
		const videoId = extractYoutubeVideoId(messageText);
		if (!videoId) return false;

		logger.info(`Processando reação para download de vídeo: ${videoId}`);

		// Envia reação de processamento
		try {
			message.origin.react(process.env.LOADING_EMOJI ?? "⌛️");
		} catch (reactError) {
			logger.error("Erro ao reagir à mensagem:", reactError);
		}

		// Envia mensagem de confirmação
		const chatId = message.group ?? message.author;
		const processingMsg = new ReturnMessage({
			chatId,
			content: "Baixando vídeo do YouTube...",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});

		bot.sendReturnMessages(processingMsg);

		// Baixa como vídeo
		baixarVideoYoutube(videoId, message.author, false, async (error, result) => {
			if (error) {
				logger.error("Erro ao baixar vídeo:", error.message);

				const errorMsg = new ReturnMessage({
					chatId,
					content: `Erro ao baixar vídeo: ${error.message}`,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});

				await bot.sendReturnMessages(errorMsg);

				// Reage com emoji de erro
				try {
					await message.origin.react("❌");
				} catch (reactError) {
					logger.error("Erro ao reagir à mensagem:", reactError);
				}
				return;
			}

			try {
				// Cria objeto de mídia
				const media = await bot.createMedia(result.arquivo, "video/mp4");

				// Envia vídeo
				const videoMsg = new ReturnMessage({
					chatId,
					content: media,
					options: {
						caption: result.legenda,
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});

				await bot.sendReturnMessages(videoMsg);

				// Reage com emoji de sucesso
				try {
					await message.origin.react("✅");
				} catch (reactError) {
					logger.error("Erro ao reagir à mensagem:", reactError);
				}
			} catch (sendError) {
				logger.error("Erro ao enviar vídeo:", sendError);

				const errorMsg = new ReturnMessage({
					chatId,
					content: "Erro ao enviar vídeo.",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});

				await bot.sendReturnMessages(errorMsg);

				// Reage com emoji de erro
				try {
					await message.origin.react("❌");
				} catch (reactError) {
					logger.error("Erro ao reagir à mensagem:", reactError);
				}
			}
		});

		return true;
	} catch (error) {
		logger.error("Erro ao processar reação para download de YouTube:", error);
		return false;
	}
}

async function baixarVideoYoutube(idVideo, dadosSolicitante, videoHD = false, callback) {
	try {
		idVideo = idVideo.replace(/[^a-z0-9_-]/gi, "");
		const urlSafe = `https://www.youtube.com/watch?v=${idVideo}`;

		// Baixa video
		const hash = crypto.randomBytes(2).toString("hex");
		const nomeVideoTemp = `ytdlp-${hash}`; // ${dadosSolicitante}
		let destinoVideo = path.join(process.env.DL_FOLDER, `${nomeVideoTemp}_v.mp4`);
		logger.info(`[baixarVideoYoutube][${nomeVideoTemp}] Buscando info do video '${urlSafe}'`);

		// Pega dados primeiro
		videoCacheManager
			.getVideoInfoWithCache(urlSafe, {
				dumpSingleJson: true,
				...(process.env.YT_USE_COOKIES === "true"
					? { cookies: path.join(database.databasePath, "www.youtube.com_cookies.txt") }
					: {}),
				"js-runtimes": "node"
			})
			.then((videoInfo) => {
				const autorVideo = videoInfo.uploader;
				const tituloVideo = videoInfo.title;
				logger.info(
					`[baixarVideoYoutube][${nomeVideoTemp}] Info do video '${videoInfo.id}': ${tituloVideo}, ${autorVideo}, ${videoInfo.duration}s.\nFazendo download para ${destinoVideo}`
				);

				if (videoInfo.duration > 60 * 60) {
					callback(
						new Error(`Atualmente, só consigo baixar vídeos/músicas de até 60 minutos.`),
						null
					);
				} else {
					videoCacheManager
						.downloadVideoWithCache(urlSafe, {
							o: destinoVideo,
							f: "(bv*[vcodec~='^((he|a)vc|h264)'][filesize<60M]+ba) / (bv*+ba/b)",
							remuxVideo: "mp4",
							recodeVideo: "mp4",
							audioFormat: "aac",
							ffmpegLocation: process.env.FFMPEG_PATH,
							...(process.env.YT_USE_COOKIES === "true"
								? { cookies: path.join(database.databasePath, "www.youtube.com_cookies.txt") }
								: {}),
							"js-runtimes": "node"
						})
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
								`[baixarMusicaYoutube][${nomeVideoTemp}] Resultado: ${JSON.stringify(resultado)}`
							);
							callback(null, resultado);
						})
						.catch((error) => {
							callback(error, null);
						});
				}
			})
			.catch((error) => {
				console.log(error);
				callback(error, null);
			});
	} catch (e) {
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

		videoCacheManager
			.getVideoInfoWithCache(urlSafe, {
				dumpSingleJson: true,
				...(process.env.YT_USE_COOKIES === "true"
					? { cookies: path.join(database.databasePath, "www.youtube.com_cookies.txt") }
					: {}),
				"js-runtimes": "node"
			})
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
					"js-runtimes": "node"
				};

				videoCacheManager
					.downloadVideoWithCache(urlSafe, downloadOptions)
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
						console.log(error);
						callback(new Error(`Não consegui baixar este áudio 😭`), null);
					});
			})
			.catch((error) => {
				console.log(error);
				callback(new Error(`Não consegui pegar informações sobre este vídeo 😭`), null);
			});
	} catch (e) {
		callback(e, null);
	}
}

/**
 * Comando para baixar vídeo do YouTube
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessages
 */
async function ytCommand(bot, message, args, group) {
	// if (!message.group  && !bot.useTelegram) {
	//   try {
	//     await message.origin.react('🤷‍♂️');
	//   } catch (reactError) {
	//     logger.error('Erro ao reagir à mensagem:', reactError);
	//   }
	//   return false;
	// }

	const chatId = message.group ?? message.author;
	const returnMessages = [];

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
		logger.debug("Comando yt chamado sem argumentos e sem quotedMsg");
		return new ReturnMessage({
			chatId,
			content:
				"Por favor, forneça um link do YouTube ou termo de busca. Exemplo: !yt https://youtu.be/dQw4w9WgXcQ ou !yt despacito",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	let videoId = null;
	const url = extractURLFromString(input);

	if (url) {
		videoId = extractYoutubeVideoId(url);
		if (!videoId) {
			return new ReturnMessage({
				chatId,
				content: "Ops! 😅 Só é possível baixar vídeos do YouTube com este comando. 🎥",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}
	}

	// Se não for um link (videoId ainda é null), busca pelo termo
	if (!videoId) {
		logger.debug(`Buscando vídeo no YouTube: "${input}"`);

		bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: `🔍 Buscando: "${input}" no YouTube...`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			}),
			group
		);

		videoId = await searchYoutubeVideo(input);

		if (!videoId) {
			return new ReturnMessage({
				chatId,
				content: `❌ Nenhum vídeo encontrado para: "${input}"`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}
	}

	logger.debug(`Baixando vídeo: ${videoId}`);

	// Retorna as mensagens de processamento e deixa que o callback do baixarVideoYoutube
	// se encarregue de enviar o vídeo final ao usuário
	return new Promise((resolve) => {
		baixarVideoYoutube(videoId, message.author, false, async (error, result) => {
			if (error) {
				logger.error("Erro ao baixar vídeo:", error.message);

				const errorMsg = new ReturnMessage({
					chatId,
					content: `Erro ao baixar vídeo: ${error.message}`,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});

				await bot.sendReturnMessages(errorMsg, group);
				resolve(returnMessages);
				return;
			}

			try {
				// Cria objeto de mídia
				const media = await bot.createMedia(result.arquivo, "video/mp4");

				// Envia vídeo
				const dicaAudio = `\n\n> *Dica:* Se vocẽ quiser apenas o áudio deste vídeo, responda esta mensagem com \`${bot.prefix}extractaudio\` (MP3) ou \`${bot.prefix}extractvoice\``;
				const videoMsg = new ReturnMessage({
					chatId,
					content: media,
					options: {
						caption: result.legenda + dicaAudio,
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});

				await bot.sendReturnMessages(videoMsg, group);
				resolve(returnMessages);
			} catch (sendError) {
				logger.error("Erro ao enviar vídeo:", sendError);

				const errorMsg = new ReturnMessage({
					chatId,
					content: "Erro ao enviar vídeo.",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});

				await bot.sendReturnMessages(errorMsg, group);
				resolve(returnMessages);
			}
		});
	});
}

/**
 * Comando para baixar música do YouTube
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessages
 */
async function srCommand(bot, message, args, group) {
	// if (!message.group && !bot.useTelegram) {
	//   try {
	//     await message.origin.react('🤷‍♂️');
	//   } catch (reactError) {
	//     logger.error('Erro ao reagir à mensagem:', reactError);
	//   }
	//   return false;
	// }

	const chatId = message.group ?? message.author;
	const returnMessages = [];

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
		logger.debug("Comando sr chamado sem argumentos e sem quotedMsg");
		return new ReturnMessage({
			chatId,
			content:
				"Por favor, forneça um link do YouTube ou termo de busca. Exemplo: !sr https://youtu.be/dQw4w9WgXcQ ou !sr despacito",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	let videoId = null;
	const url = extractURLFromString(input);

	if (url) {
		videoId = extractYoutubeVideoId(url);
		if (!videoId) {
			return new ReturnMessage({
				chatId,
				content: "Ops! 😅 Só é possível baixar músicas do YouTube com este comando. 🎵",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}
	}

	// Se não for um link (videoId ainda é null), busca pelo termo
	if (!videoId) {
		logger.debug(`Buscando vídeo no YouTube: "${input}"`);

		bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: `🔍 Buscando: "${input}" no YouTube...`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			}),
			group
		);

		videoId = await searchYoutubeVideo(input);

		if (!videoId) {
			return new ReturnMessage({
				chatId,
				content: `❌ Nenhum vídeo encontrado para: "${input}"`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}
	}

	logger.debug(`Baixando áudio: ${videoId}`);

	// Retorna as mensagens de processamento e deixa que o callback do baixarMusicaYoutube
	// se encarregue de enviar o áudio final ao usuário
	return new Promise((resolve) => {
		baixarMusicaYoutube(videoId, message.author, async (error, result) => {
			if (error) {
				logger.error("Erro ao baixar áudio:", error.message);

				const errorMsg = new ReturnMessage({
					chatId,
					content: `Erro ao baixar áudio: ${error.message}`,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});

				await bot.sendReturnMessages(errorMsg, group);
				resolve(returnMessages);
				return;
			}

			try {
				// Cria objeto de mídia
				const media = await bot.createMedia(result.arquivo, "audio/mp3");

				// Envia áudio
				const audioMsg = new ReturnMessage({
					chatId,
					content: media,
					options: {
						caption: result.legenda,
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});

				await bot.sendReturnMessages(audioMsg, group);
				resolve(returnMessages);
			} catch (sendError) {
				logger.error("Erro ao enviar áudio:", sendError);

				const errorMsg = new ReturnMessage({
					chatId,
					content: "Erro ao enviar áudio."
				});

				await bot.sendReturnMessages(errorMsg, group);
				resolve(returnMessages);
			}
		});
	});
}

// Comandos utilizando a classe Command
const commands = [
	new Command({
		name: "yt",
		caseSensitive: false,
		description: "Baixa um vídeo do YouTube",
		category: "downloaders",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "✅",
			error: "❌"
		},
		method: ytCommand
	}),

	new Command({
		name: "sr",
		caseSensitive: false,
		description: "Baixa uma música do YouTube (áudio do vídeo)",
		category: "downloaders",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "✅",
			error: "❌"
		},
		method: srCommand
	})
];

// Registra os comandos sendo exportados
//logger.debug(`Exportando ${commands.length} comandos:`, { commands });

module.exports = { commands, processYoutubeReaction };
