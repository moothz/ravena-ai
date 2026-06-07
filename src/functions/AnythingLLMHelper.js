const axios = require("axios");
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");

const logger = new Logger("anythingllm-helper");

/**
 * Ask a question to AnythingLLM
 * @param {string} question - The question to ask
 * @param {string} sessionId - Optional session ID for context maintenance
 * @returns {Promise<string>} - The answer from AnythingLLM
 */
async function askAnythingLLM(question, sessionId = null) {
	const host = process.env.ANYTHINGLLM_HOST;
	const apiKey = process.env.ANYTHINGLLM_API_KEY;
	const workspace = process.env.ANYTHINGLLM_WORKSPACE || "ravena";

	if (!host || !apiKey) {
		throw new Error("Configuração do AnythingLLM incompleta (host ou API key ausente).");
	}

	try {
		logger.debug(
			`[AnythingLLM] Sending question to workspace ${workspace} (Session: ${sessionId}): ${question}`
		);

		const payload = {
			message: question,
			mode: "chat"
		};

		if (sessionId) {
			payload.sessionId = sessionId;
		}

		const response = await axios.post(`${host}/api/v1/workspace/${workspace}/chat`, payload, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json"
			},
			timeout: 30000
		});

		let answer =
			response.data.textResponse ||
			response.data.text ||
			"Desculpe, não consegui obter uma resposta.";

		// Remover tags <think>...</think> (DeepSeek reasoning)
		// Regex case-insensitive e mais robusta (trata tags não fechadas)
		const thinkRegex = /<think>[\s\S]*?(?:<\/think>|$)/gi;
		if (thinkRegex.test(answer)) {
			answer = answer.replace(thinkRegex, "").trim();
		}

		return answer;
	} catch (error) {
		logger.error("Erro ao consultar AnythingLLM:", error.message);

		if (error.code === "ECONNREFUSED") {
			throw new Error("Não foi possível conectar ao servidor AnythingLLM (Conexão Recusada).");
		} else if (error.response?.status === 401 || error.response?.status === 403) {
			throw new Error("Erro de autenticação com a API do AnythingLLM.");
		} else if (error.response?.status === 404) {
			throw new Error(`Workspace '${workspace}' não encontrado no AnythingLLM.`);
		}
		throw error;
	}
}

/**
 * Handle AnythingLLM chat command
 * @param {Object} bot - Bot instance
 * @param {Object} message - Message object
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage>} - Return message
 */
async function handleAjuda(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const question = args.length > 0 ? args.join(" ") : (message.caption ?? message.content);

	if (!question || question.trim().length < 2) {
		return new ReturnMessage({
			chatId,
			content: "O que você quer saber? Exemplo: !ajuda como adicionar comandos",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	try {
		const answer = await askAnythingLLM(question, chatId);

		return new ReturnMessage({
			chatId,
			content: `🤖 *Ajuda (AnythingLLM)*\n\n${answer}`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		return new ReturnMessage({
			chatId,
			content: `❌ ${error.message}`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
}

// Define the command only if the required environment variables are set
const commands = [];

if (process.env.ANYTHINGLLM_API_KEY && process.env.ANYTHINGLLM_HOST) {
	commands.push(
		new Command({
			name: "ajuda",
			description: "Consulta a base de conhecimento no AnythingLLM",
			category: "geral",
			usage: "!ajuda [sua pergunta]",
			reactions: {
				before: process.env.LOADING_EMOJI ?? "⌛️",
				after: "🤖",
				error: "❌"
			},
			method: handleAjuda
		})
	);
}

module.exports = { commands, handleAjuda, askAnythingLLM };
