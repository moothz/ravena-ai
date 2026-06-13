const path = require("path");
const fs = require("fs").promises;
const os = require("os");
const { exec } = require("child_process");
const sharp = require("sharp");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const imagemagick = require("imagemagick");
const util = require("util");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const CmdUsage = require("../utils/CmdUsage");

const execPromise = util.promisify(exec);
const logger = new Logger("image-commands");
const cmdUsage = CmdUsage.getInstance();

// Encapsule os comandos do imagemagick em promessas
const convertPromise = util.promisify(imagemagick.convert);
const identifyPromise = util.promisify(imagemagick.identify);

// Diretório temporário para processamento
const tempDir = path.join(__dirname, "../../temp", "whatsapp-bot-images");

// Garante que o diretório temporário exista
fs.mkdir(tempDir, { recursive: true })
	.then(() => {
		logger.info(`Diretório temporário criado: ${tempDir}`);
	})
	.catch((error) => {
		logger.error("Erro ao criar diretório temporário:", error);
	});

// Auxiliar para obter mídia da mensagem.
// Retorna { media, hadQuoted, quotedHadMedia } para distinguir erros.
async function getMediaFromMessage(message) {
	// Se a mensagem tem mídia direta
	if (message.type !== "text") {
		// Lazy loading: só usa content direto se já tiver .data (base64)
		if (message.content && message.content.data) {
			return { media: message.content, hadQuoted: false, quotedHadMedia: false };
		}
		if (typeof message.downloadMedia === "function") {
			try {
				const media = await message.downloadMedia();
				return { media, hadQuoted: false, quotedHadMedia: false };
			} catch (e) {
				logger.error("[getMediaFromMessage] Erro ao baixar mídia:", e);
				return { media: null, hadQuoted: false, quotedHadMedia: false };
			}
		}
		return { media: message.content ?? null, hadQuoted: false, quotedHadMedia: false };
	}

	const hadQuoted = !!message.hasQuotedMsg;

	// Tenta obter mídia da mensagem citada
	try {
		const quotedMsg = await message.origin.getQuotedMessage();
		if (quotedMsg && quotedMsg.hasMedia) {
			const media = await quotedMsg.downloadMedia();
			return { media, hadQuoted, quotedHadMedia: true };
		}
		return { media: null, hadQuoted, quotedHadMedia: quotedMsg ? false : null };
	} catch (error) {
		logger.error("Erro ao obter mídia da mensagem citada:", error);
	}
	return { media: null, hadQuoted, quotedHadMedia: null };
}

// Auxiliar para salvar mídia em arquivo temporário
function saveMediaToTemp(media, extension = "png") {
	const filename = `${uuidv4()}.${extension}`;
	const filepath = path.join(tempDir, filename);

	return fs
		.writeFile(filepath, Buffer.from(media.data, "base64"))
		.then(() => filepath)
		.catch((error) => {
			logger.error("Erro ao salvar mídia em arquivo temporário:", error);
			throw error;
		});
}

// Auxiliar para remover fundo usando rembg API (Sidecar)
async function removeBackground(inputPath) {
	const outputPath = inputPath.replace(/\.[^/.]+$/, "") + "_nobg.png";

	// Se a URL do .env não tiver o endpoint, adiciona /api/remove
	let rembgUrl = process.env.REMBG_API_URL || "http://rembg:7000/api/remove";
	if (rembgUrl && !rembgUrl.includes("/api/remove") && !rembgUrl.includes("/remove")) {
		rembgUrl = rembgUrl.replace(/\/$/, "") + "/api/remove";
	}

	try {
		const buffer = await fs.readFile(inputPath);

		// Use built-in FormData (Node 20+)
		const formData = new FormData();
		const blob = new Blob([buffer], { type: "image/png" });
		formData.append("file", blob, "image.png");

		const response = await axios.post(rembgUrl, formData, {
			responseType: "arraybuffer",
			headers: {
				"Content-Type": "multipart/form-data"
			}
		});

		await fs.writeFile(outputPath, response.data);
		return outputPath;
	} catch (error) {
		logger.error("Erro ao remover fundo via rembg API:", error.message);
		// Fallback para log detalhado se disponível
		if (error.response && error.response.data) {
			logger.error("Detalhes do erro API:", error.response.data.toString());
		}
		throw error;
	}
}

// Auxiliar para recortar imagem usando sharp
function trimImage(inputPath) {
	const outputPath = inputPath.replace(/\.[^/.]+$/, "") + "_trimmed.png";

	return sharp(inputPath)
		.trim()
		.toFile(outputPath)
		.then(() => outputPath)
		.catch((error) => {
			logger.error("Erro ao recortar imagem:", error);
			throw error;
		});
}

// Auxiliar para aplicar distorção usando ImageMagick
function distortImage(inputPath, intensity = 50) {
	// Limita intensidade entre 30 e 70
	intensity = Math.max(30, Math.min(70, intensity));

	const outputPath = inputPath.replace(/\.[^/.]+$/, "") + "_distorted.png";

	// Aplica efeito de redimensionamento líquido
	return convertPromise([
		inputPath,
		"-liquid-rescale",
		`${intensity}x${intensity}%!`,
		"-resize",
		"200%",
		outputPath
	])
		.then(() => outputPath)
		.catch((error) => {
			logger.error("Erro ao distorcer imagem:", error);
			throw error;
		});
}

// Auxiliar para aplicar efeitos artísticos usando ImageMagick
function applyArtistic(inputPath, effect) {
	const outputPath = inputPath.replace(/\.[^/.]+$/, "") + `_${effect}.png`;

	let convertArgs;

	switch (effect) {
		case "sketch":
			convertArgs = [inputPath, "-colorspace", "gray", "-sketch", "0x20+120", outputPath];
			break;

		case "oil":
			convertArgs = [inputPath, "-paint", "6", outputPath];
			break;

		case "neon":
			convertArgs = [
				inputPath,
				"-negate",
				"-edge",
				"2",
				"-negate",
				"-normalize",
				"-channel",
				"RGB",
				"-blur",
				"0x.5",
				"-colorspace",
				"sRGB",
				outputPath
			];
			break;

		case "pixelate":
			convertArgs = [inputPath, "-scale", "10%", "-scale", "1000%", outputPath];
			break;

		default:
			return Promise.reject(new Error(`Efeito desconhecido: ${effect}`));
	}

	return convertPromise(convertArgs)
		.then(() => outputPath)
		.catch((error) => {
			logger.error(`Erro ao aplicar efeito ${effect}:`, error);
			throw error;
		});
}

// Auxiliar para aplicar efeito "needs more jpeg"
function applyJpeg(inputPath) {
	const outputPath = inputPath.replace(/\.[^/.]+$/, "") + "_morejpeg.jpg";

	return sharp(inputPath)
		.resize(100) // Reduz resolução drasticamente
		.toBuffer()
		.then((buffer) =>
			sharp(buffer)
				.resize(1024, null, {
					// Aumenta de volta sem interpolação suave (kernel nearest) para pixelização
					kernel: sharp.kernel.nearest
				})
				.jpeg({ quality: 1 }) // Compressão JPEG extrema
				.toFile(outputPath)
		)
		.then(() => outputPath)
		.catch((error) => {
			logger.error("Erro ao aplicar efeito jpeg:", error);
			throw error;
		});
}

// Limpa arquivos temporários
function cleanupTempFiles(files) {
	return Promise.all(
		files.map((file) =>
			fs.unlink(file).catch((error) => {
				logger.error(`Erro ao excluir arquivo temporário ${file}:`, error);
			})
		)
	);
}

/**
 * Aplica efeito "needs more jpeg"
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessage
 */
async function handleJpeg(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const { media, hadQuoted, quotedHadMedia } = await getMediaFromMessage(message);
		if (!media) {
			try {
				await message.origin.react("❌");
			} catch (reactError) {
				logger.error("Erro ao aplicar reação de erro:", reactError);
			}

			if (hadQuoted && quotedHadMedia !== false) {
				return new ReturnMessage({
					chatId,
					content:
						"⚠️ Não foi possível recuperar a mídia da mensagem marcada. Ela pode ter saído do cache ou o download falhou."
				});
			}
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça uma imagem ou responda a uma imagem com este comando."
			});
		}

		const inputPath = await saveMediaToTemp(media);
		logger.debug(`Imagem de entrada salva em ${inputPath}`);

		const filePaths = [inputPath];

		const jpegPath = await applyJpeg(inputPath);
		logger.debug(`Efeito jpeg aplicado, salvo em ${jpegPath}`);
		filePaths.push(jpegPath);

		const resultMedia = await bot.createMedia(jpegPath);

		cleanupTempFiles(filePaths).catch((error) => {
			logger.error("Erro ao limpar arquivos temporários:", error);
		});

		// Log detailed usage
		cmdUsage.logFixedCommandUsage({
			timestamp: Date.now(),
			command: "morejpeg",
			user: message.author,
			groupId: chatId,
			args: args.join(" "),
			info: {
				effect: "jpeg"
			}
		});

		return new ReturnMessage({
			chatId,
			content: resultMedia,
			options: {
				caption: "Needs more JPEG!",
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro no comando morejpeg:", error);

		try {
			await message.origin.react("❌");
		} catch (reactError) {
			logger.error("Erro ao aplicar reação de erro:", reactError);
		}

		return new ReturnMessage({
			chatId,
			content: "Erro ao processar imagem. Certifique-se de que a imagem é válida e tente novamente."
		});
	}
}

/**
 * Remove o fundo de uma imagem
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessage
 */
async function handleRemoveBg(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const returnMessages = [];

	// Cadeia de promessas sem bloqueio
	try {
		const { media, hadQuoted, quotedHadMedia } = await getMediaFromMessage(message);
		if (!media) {
			// Aplica reação de erro
			try {
				await message.origin.react("❌");
			} catch (reactError) {
				logger.error("Erro ao aplicar reação de erro:", reactError);
			}

			if (hadQuoted && quotedHadMedia !== false) {
				return new ReturnMessage({
					chatId,
					content:
						"⚠️ Não foi possível recuperar a mídia da mensagem marcada. Ela pode ter saído do cache ou o download falhou."
				});
			}
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça uma imagem ou responda a uma imagem com este comando."
			});
		}

		const inputPath = await saveMediaToTemp(media);
		logger.debug(`Imagem de entrada salva em ${inputPath}`);

		// Armazena caminhos para limpeza
		const filePaths = [inputPath];

		// Processa imagem com cadeia de promessas
		const noBgPath = await removeBackground(inputPath);
		logger.debug(`Fundo removido, salvo em ${noBgPath}`);
		filePaths.push(noBgPath);

		const trimmedPath = await trimImage(noBgPath);
		logger.debug(`Imagem recortada, salva em ${trimmedPath}`);
		filePaths.push(trimmedPath);

		const resultMedia = await bot.createMedia(trimmedPath);

		cleanupTempFiles(filePaths).catch((error) => {
			logger.error("Erro ao limpar arquivos temporários:", error);
		});

		// Log detailed usage
		cmdUsage.logFixedCommandUsage({
			timestamp: Date.now(),
			command: "removebg",
			user: message.author,
			groupId: chatId,
			args: args.join(" "),
			info: {
				output: "document"
			}
		});

		return new ReturnMessage({
			chatId,
			content: resultMedia,
			options: {
				caption: "Fundo removido e salvo como arquivo",
				sendMediaAsDocument: true, // Envia como arquivo em vez de imagem
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro no comando removebg:", error);

		// Aplica reação de erro
		try {
			await message.origin.react("❌");
		} catch (reactError) {
			logger.error("Erro ao aplicar reação de erro:", reactError);
		}

		return new ReturnMessage({
			chatId,
			content: "Erro ao processar imagem. Certifique-se de que a imagem é válida e tente novamente."
		});
	}
}

/**
 * Aplica efeito de distorção a uma imagem
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessage
 */
async function handleDistort(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	// Obtém intensidade dos args se fornecida
	let intensity = 50; // Padrão
	if (args.length > 0 && !isNaN(args[0])) {
		intensity = Math.max(1, Math.min(100, parseInt(args[0])));
	}

	try {
		const { media, hadQuoted, quotedHadMedia } = await getMediaFromMessage(message);
		if (!media) {
			// Aplica reação de erro
			try {
				await message.origin.react("❌");
			} catch (reactError) {
				logger.error("Erro ao aplicar reação de erro:", reactError);
			}

			if (hadQuoted && quotedHadMedia !== false) {
				return new ReturnMessage({
					chatId,
					content:
						"⚠️ Não foi possível recuperar a mídia da mensagem marcada. Ela pode ter saído do cache ou o download falhou."
				});
			}
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça uma imagem ou responda a uma imagem com este comando."
			});
		}

		const inputPath = await saveMediaToTemp(media);
		logger.debug(`Imagem de entrada salva em ${inputPath}`);

		// Armazena caminhos para limpeza
		const filePaths = [inputPath];

		// Processa imagem com distorção
		const distortedPath = await distortImage(inputPath, intensity);
		logger.debug(`Distorção aplicada, salva em ${distortedPath}`);
		filePaths.push(distortedPath);

		const resultMedia = await bot.createMedia(distortedPath);

		// Limpa arquivos após obter a mídia processada
		cleanupTempFiles(filePaths).catch((error) => {
			logger.error("Erro ao limpar arquivos temporários:", error);
		});

		// Log detailed usage
		cmdUsage.logFixedCommandUsage({
			timestamp: Date.now(),
			command: "distort",
			user: message.author,
			groupId: chatId,
			args: args.join(" "),
			info: {
				intensity
			}
		});

		return new ReturnMessage({
			chatId,
			content: resultMedia,
			options: {
				caption: `Distorção aplicada (intensidade: ${intensity}%)`,
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro no comando distort:", error);

		// Aplica reação de erro
		try {
			await message.origin.react("❌");
		} catch (reactError) {
			logger.error("Erro ao aplicar reação de erro:", reactError);
		}

		return new ReturnMessage({
			chatId,
			content: "Erro ao processar imagem. Certifique-se de que a imagem é válida e tente novamente."
		});
	}
}

/**
 * Cria um sticker após remover o fundo
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessage
 */
async function handleStickerBg(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const { media, hadQuoted, quotedHadMedia } = await getMediaFromMessage(message);
		if (!media) {
			// Aplica reação de erro
			try {
				await message.origin.react("❌");
			} catch (reactError) {
				logger.error("Erro ao aplicar reação de erro:", reactError);
			}

			if (hadQuoted && quotedHadMedia !== false) {
				return new ReturnMessage({
					chatId,
					content:
						"⚠️ Não foi possível recuperar a mídia da mensagem marcada. Ela pode ter saído do cache ou o download falhou."
				});
			}
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça uma imagem ou responda a uma imagem com este comando."
			});
		}

		const inputPath = await saveMediaToTemp(media);
		logger.debug(`Imagem de entrada salva em ${inputPath}`);

		// Armazena caminhos para limpeza
		const filePaths = [inputPath];

		// Processa imagem com remoção de fundo e recorte
		const noBgPath = await removeBackground(inputPath);
		logger.debug(`Fundo removido, salvo em ${noBgPath}`);
		filePaths.push(noBgPath);

		const trimmedPath = await trimImage(noBgPath);
		logger.debug(`Imagem recortada, salva em ${trimmedPath}`);
		filePaths.push(trimmedPath);

		const resultMedia = await bot.createMedia(trimmedPath);

		// Limpa arquivos temporários
		cleanupTempFiles(filePaths).catch((error) => {
			logger.error("Erro ao limpar arquivos temporários:", error);
		});

		// Log detailed usage to 'sticker' registry
		cmdUsage.logFixedCommandUsage({
			timestamp: Date.now(),
			command: "sticker",
			user: message.author,
			groupId: chatId,
			args: args.join(" "),
			info: {
				cropType: "nobg",
				mimeType: "image/png"
			}
		});

		return new ReturnMessage({
			chatId,
			content: resultMedia,
			options: {
				sendMediaAsSticker: true,
				stickerAuthor: "ravena",
				stickerName: args.join(" ") || "ravena sticker",
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro no comando stickerbg:", error);

		// Aplica reação de erro
		try {
			await message.origin.react("❌");
		} catch (reactError) {
			logger.error("Erro ao aplicar reação de erro:", reactError);
		}

		return new ReturnMessage({
			chatId,
			content: "Erro ao processar imagem. Certifique-se de que a imagem é válida e tente novamente."
		});
	}
}

/**
 * Aplica um efeito artístico a uma imagem
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @param {string} effect - Nome do efeito a ser aplicado
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessage
 */
async function handleArtisticEffect(bot, message, args, group, effect) {
	const chatId = message.group ?? message.author;

	try {
		const { media, hadQuoted, quotedHadMedia } = await getMediaFromMessage(message);
		if (!media) {
			// Aplica reação de erro
			try {
				await message.origin.react("❌");
			} catch (reactError) {
				logger.error("Erro ao aplicar reação de erro:", reactError);
			}

			if (hadQuoted && quotedHadMedia !== false) {
				return new ReturnMessage({
					chatId,
					content:
						"⚠️ Não foi possível recuperar a mídia da mensagem marcada. Ela pode ter saído do cache ou o download falhou."
				});
			}
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça uma imagem ou responda a uma imagem com este comando."
			});
		}

		const inputPath = await saveMediaToTemp(media);
		logger.debug(`Imagem de entrada salva em ${inputPath}`);

		// Armazena caminhos para limpeza
		const filePaths = [inputPath];

		// Aplica efeito artístico
		const effectPath = await applyArtistic(inputPath, effect);
		logger.debug(`Efeito ${effect} aplicado, salvo em ${effectPath}`);
		filePaths.push(effectPath);

		const resultMedia = await bot.createMedia(effectPath);

		// Limpa arquivos temporários
		cleanupTempFiles(filePaths).catch((error) => {
			logger.error("Erro ao limpar arquivos temporários:", error);
		});

		// Log detailed usage
		cmdUsage.logFixedCommandUsage({
			timestamp: Date.now(),
			command: effect,
			user: message.author,
			groupId: chatId,
			args: args.join(" "),
			info: {
				effect
			}
		});

		return new ReturnMessage({
			chatId,
			content: resultMedia,
			options: {
				caption: `Efeito ${effect} aplicado`,
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error(`Erro no comando ${effect}:`, error);

		// Aplica reação de erro
		try {
			await message.origin.react("❌");
		} catch (reactError) {
			logger.error("Erro ao aplicar reação de erro:", reactError);
		}

		return new ReturnMessage({
			chatId,
			content: "Erro ao processar imagem. Certifique-se de que a imagem é válida e tente novamente."
		});
	}
}

// Comandos usando a classe Command
const commands = [
	new Command({
		name: "removebg",
		description: "Remove o fundo de uma imagem",
		category: "midia",
		group: "rremovebg",
		needsMedia: true,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔪",
			error: "❌"
		},
		method: handleRemoveBg
	}),

	new Command({
		name: "distort",
		description: "Aplica efeito de distorção a uma imagem",
		category: "midia",
		needsMedia: true,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "⌛️",
			error: "❌"
		},
		method: handleDistort
	}),

	new Command({
		name: "stickerbg",
		description: "Cria um sticker após remover o fundo",
		category: "midia",
		group: "stickerbg",
		aliases: ["sbg"],
		needsMedia: true,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔪",
			error: "❌"
		},
		method: handleStickerBg
	}),
	new Command({
		name: "sbg",
		description: "Envia sticker sem fundo",
		category: "midia",
		group: "stickerbg",
		needsMedia: true,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔪",
			error: "❌"
		},
		method: handleStickerBg
	}),
	new Command({
		name: "rbg",
		description: "Remove fundo de imagem e envia o PNG",
		category: "midia",
		group: "rremovebg",
		needsMedia: true,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔪",
			error: "❌"
		},
		method: handleRemoveBg
	}),
	new Command({
		name: "morejpeg",
		description: "Aplica compressão JPEG extrema",
		category: "midia",
		needsMedia: true,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "💩",
			error: "❌"
		},
		method: handleJpeg
	})
];

// Adiciona comandos para efeitos artísticos
["sketch", "oil", "neon", "pixelate"].forEach((effect) => {
	commands.push(
		new Command({
			name: effect,
			description: `Aplica efeito ${effect} a uma imagem`,
			category: "midia",
			group: "imageEffect",
			needsMedia: true,
			reactions: {
				before: process.env.LOADING_EMOJI ?? "⌛️",
				after: "🎨",
				error: "❌"
			},
			method: async (bot, message, args, group) =>
				await handleArtisticEffect(bot, message, args, group, effect)
		})
	);
});

// Adiciona alias para stickerbg -> sbg

// Registra os comandos sendo exportados
logger.info(`Módulo ImageManipulation carregado. Exportados ${commands.length} comandos.`);

module.exports = { commands };
