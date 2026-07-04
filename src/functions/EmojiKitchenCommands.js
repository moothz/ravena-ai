const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("../utils/Database");
const database = Database.getInstance();

const logger = new Logger("emoji-kitchen-commands");

// Diretório para armazenar os emojis em cache
const EMOJI_CACHE_DIR = path.join(database.databasePath, "media", "emojikitchen");

// Certifica-se de que o diretório de cache existe
try {
	if (!fs.existsSync(EMOJI_CACHE_DIR)) {
		fs.mkdirSync(EMOJI_CACHE_DIR, { recursive: true });
		logger.info(`Diretório de cache criado: ${EMOJI_CACHE_DIR}`);
	}
} catch (error) {
	logger.error(`Erro ao criar diretório de cache: ${error.message}`);
}

/**
 * Gera um hash único para uma combinação de emojis
 * @param {string} emoji1 - Primeiro emoji
 * @param {string} emoji2 - Segundo emoji
 * @returns {string} - Hash da combinação
 */
function generateEmojiHash(emoji1, emoji2) {
	// Ordenar os emojis para que a combinação seja consistente independente da ordem
	const emojis = [emoji1, emoji2].sort().join("_");
	return crypto.createHash("md5").update(emojis).digest("hex");
}

/**
 * Verifica se a combinação de emojis já existe em cache
 * @param {string} emoji1 - Primeiro emoji
 * @param {string} emoji2 - Segundo emoji
 * @returns {string|null} - Caminho para o arquivo em cache ou null se não existir
 */
function getEmojiFromCache(emoji1, emoji2) {
	const hash = generateEmojiHash(emoji1, emoji2);
	const filePath = path.join(EMOJI_CACHE_DIR, `${hash}.png`);

	if (fs.existsSync(filePath)) {
		logger.debug(`Emoji em cache encontrado: ${filePath}`);
		return filePath;
	}

	logger.debug(`Emoji não encontrado em cache: ${emoji1} + ${emoji2}`);
	return null;
}

/**
 * Salva a imagem da combinação de emojis em cache
 * @param {string} emoji1 - Primeiro emoji
 * @param {string} emoji2 - Segundo emoji
 * @param {Buffer} imageBuffer - Buffer da imagem
 * @returns {string} - Caminho para o arquivo salvo
 */
function saveEmojiToCache(emoji1, emoji2, imageBuffer) {
	const hash = generateEmojiHash(emoji1, emoji2);
	const filePath = path.join(EMOJI_CACHE_DIR, `${hash}.png`);

	try {
		fs.writeFileSync(filePath, imageBuffer);
		logger.info(`Emoji salvo em cache: ${filePath}`);
		return filePath;
	} catch (error) {
		logger.error(`Erro ao salvar emoji em cache: ${error.message}`);
		return null;
	}
}

/**
 * Extrai os primeiros dois emojis de um texto
 * @param {string} text - Texto contendo emojis
 * @returns {Array<string>} - Array com os dois primeiros emojis ou null se não encontrados
 */
function extractFirstTwoEmojis(text) {
	try {
		// Expressão regular para encontrar emojis
		// Esta regex é simplificada e pode não capturar todos os tipos de emoji
		const emojiRegex =
			/[\p{Emoji}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Emoji_Modifier_Base}|\p{Emoji_Component}]/gu;

		// Encontra todas as ocorrências de emoji no texto
		const matches = text.match(emojiRegex);

		if (!matches || matches.length < 2) {
			return null;
		}

		// Retorna os dois primeiros emojis
		return [matches[0], matches[1]];
	} catch (error) {
		logger.error("Erro ao extrair emojis:", error);
		return null;
	}
}

/**
 * Gera um sticker combinando dois emojis usando Emoji Kitchen
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com o sticker
 */
async function emojiKitchenCommand(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;

		// Extrai emojis dos argumentos
		let emojis;

		// Caso 1: Se houver argumentos, extrair emojis deles
		if (args.length > 0) {
			emojis = extractFirstTwoEmojis(args.join(" "));
		}

		// Caso 2: Se não houver emojis nos argumentos, usar o conteúdo da mensagem
		if (!emojis && message.content && typeof message.content === "string") {
			emojis = extractFirstTwoEmojis(message.content);
		}

		// Caso 3: Se ainda não tiver emojis, verificar mensagem citada
		if (!emojis && message.origin) {
			try {
				const quotedMsg = await message.origin.getQuotedMessage();
				const quotedText = quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body;
				if (quotedMsg && quotedText) {
					emojis = extractFirstTwoEmojis(quotedText);
				}
			} catch (error) {
				logger.error("Erro ao processar mensagem citada:", error);
			}
		}

		// Se ainda não encontramos emojis, retorna mensagem de erro
		if (!emojis) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça dois emojis para criar um sticker combinado. Exemplo: !emojik 🥹 😗"
			});
		}

		logger.debug(`Processando Emoji Kitchen para: ${emojis[0]} + ${emojis[1]}`);

		// Verificar se os emojis já estão em cache
		const cachedFilePath = getEmojiFromCache(emojis[0], emojis[1]);

		if (cachedFilePath) {
			logger.info(`Usando emoji em cache: ${emojis[0]} + ${emojis[1]}`);

			try {
				// Criar MessageMedia a partir do arquivo em cache
				const media = (() => {
					const buf = require("fs").readFileSync(cachedFilePath);
					return {
						mimetype: require("mime-types").lookup(cachedFilePath) || "application/octet-stream",
						data: buf.toString("base64"),
						filename: require("path").basename(cachedFilePath),
						isMessageMedia: true
					};
				})();

				// Retorna como sticker
				return new ReturnMessage({
					chatId,
					content: media,
					options: {
						sendMediaAsSticker: true,
						stickerAuthor: bot.nomeExibir || "ravena",
						stickerName: `Emojik: ${emojis[0]}+${emojis[1]}`,
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			} catch (error) {
				logger.error(`Erro ao criar MessageMedia do arquivo em cache: ${error.message}`);
				// Continua para baixar da API em caso de erro
			}
		}

		// Construir URL para o Emoji Kitchen
		const emoji1 = encodeURIComponent(emojis[0]);
		const emoji2 = encodeURIComponent(emojis[1]);
		const imageUrl = `https://emojik.vercel.app/s/${emoji1}_${emoji2}?size=512`;

		// Baixar imagem
		try {
			// Baixar a imagem usando axios para obter o buffer
			const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
			const imageBuffer = Buffer.from(response.data);

			// Salvar a imagem em cache
			saveEmojiToCache(emojis[0], emojis[1], imageBuffer);

			// Criar MessageMedia a partir do buffer
			const media = {
				mimetype: "image/png",
				data: imageBuffer.toString("base64"),
				isMessageMedia: true
			};

			// Retorna como sticker
			return new ReturnMessage({
				chatId,
				content: media,
				options: {
					sendMediaAsSticker: true,
					stickerAuthor: bot.nomeExibir || "ravena",
					stickerName: `Emojik: ${emojis[0]}+${emojis[1]}`,
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		} catch (error) {
			logger.error(`Erro ao baixar imagem do Emoji Kitchen: ${error.message}`);

			return new ReturnMessage({
				chatId,
				content: `Não foi possível criar o sticker para ${emojis[0]}+${emojis[1]}. Esta combinação pode não estar disponível.`
			});
		}
	} catch (error) {
		logger.error("Erro ao processar comando emojiKitchen:", error);

		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Ocorreu um erro ao processar o comando. Por favor, tente novamente."
		});
	}
}

// Lista de comandos usando a classe Command
const commands = [
	new Command({
		name: "emojik",
		description: "Cria um sticker combinando dois emojis",
		category: "midia",
		group: "emojik",
		caseSensitive: false,
		cooldown: 5, // 5 segundos entre usos
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🧪",
			error: "❌"
		},
		method: emojiKitchenCommand
	}),

	new Command({
		name: "memoji",
		description: "Alias para o comando emojik",
		category: "midia",
		group: "emojik",
		caseSensitive: false,
		cooldown: 5,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🧪",
			error: "❌"
		},
		method: emojiKitchenCommand
	})
];

module.exports = { commands };
