const Logger = require("../utils/Logger");
const LLMService = require("../services/LLMService");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const path = require("path");
const fs = require("fs").promises;
const Database = require("../utils/Database");

const logger = new Logger("ocr-commands");
const llmService = LLMService.getInstance();
const database = Database.getInstance();

/**
 * Extracts text from an image using LLM Vision
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage>} - Result message
 */
async function ocrCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		// 1. Get Media (direct or quoted)
		const media = await getMediaFromMessage(message);

		if (!media || !media.mimetype.includes("image")) {
			return new ReturnMessage({
				chatId,
				content:
					"❌ Por favor, envie uma imagem com o comando ou responda a uma imagem usando !ocr.",
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		// 2. Prepare specialized OCR prompt
		const question =
			"Extraia TODO o texto presente nesta imagem. Retorne apenas o texto extraído, preservando a quebra de linhas, sem qualquer comentário, explicação ou introdução adicional.";

		// 3. Get context for images if available
		const ctxPath = path.join(database.databasePath, "textos", "llm_context_images.txt");
		let systemContext =
			"Você é um assistente especializado em OCR (Extração de Texto). Sua única tarefa é ler e transcrever o texto da imagem fornecida com precisão total.";

		try {
			const baseCtx = await fs.readFile(ctxPath, "utf8");
			if (baseCtx) systemContext = baseCtx + "\n\n" + systemContext;
		} catch (e) {
			// Ignore if context file doesn't exist
		}

		// 4. Call LLM Service
		const completionOptions = {
			prompt: question,
			image: media.data,
			systemContext,
			priority: 5
		};

		logger.info(`[ocrCommand] Requesting OCR analysis for ${chatId}`);
		const response = await llmService.getCompletion(completionOptions);

		if (!response || response.trim().length === 0) {
			return new ReturnMessage({
				chatId,
				content: "⚠️ Não consegui extrair nenhum texto desta imagem.",
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		return new ReturnMessage({
			chatId,
			content: `📝 *Texto Extraído:*\n\n${response.trim()}`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("[ocrCommand] Error in OCR processing:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Ocorreu um erro ao processar o OCR. Tente novamente mais tarde.",
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

/**
 * Helper to get media from message or quoted message
 */
async function getMediaFromMessage(message) {
	// If message has media directly
	if (message.hasMedia || (message.type !== "text" && message.content && message.content.data)) {
		return message.content;
	}

	// Try to get from quoted message
	try {
		const quotedMsg = await message.origin.getQuotedMessage();
		if (quotedMsg && quotedMsg.hasMedia) {
			return await quotedMsg.downloadMedia();
		}
	} catch (error) {
		logger.error("Error getting quoted media:", error);
	}
	return null;
}

const commands = [
	new Command({
		name: "ocr",
		description: "Extrai texto de uma imagem usando IA",
		category: "utilidades",
		reactions: {
			trigger: "🔍",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📝"
		},
		cooldown: 20,
		method: ocrCommand
	})
];

module.exports = { commands };
