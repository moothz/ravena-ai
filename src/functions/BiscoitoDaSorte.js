const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const Database = require("../utils/Database");
const CustomVariableProcessor = require("../utils/CustomVariableProcessor");

// Cria novo logger
const logger = new Logger("biscoito-sorte");

const database = Database.getInstance();
const variableProcessor = new CustomVariableProcessor();

/**
 * Retorna uma frase aleatória da variável "biscoito-frases"
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function biscoitoCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const customVariables = await database.getCustomVariables();
		const frases = customVariables["biscoito-frases"];

		if (!frases || frases.length === 0) {
			logger.warn("Nenhuma frase encontrada em 'biscoito-frases'");
			return new ReturnMessage({
				chatId,
				content: "❌ Nenhuma frase de biscoito da sorte disponível no momento.",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const fraseIndex = Math.floor(Math.random() * frases.length);
		const options = {};
		const fraseFinal = await variableProcessor.process(frases[fraseIndex], {
			message,
			group,
			options,
			bot
		});

		return new ReturnMessage({
			chatId,
			content: `🥠 ${fraseFinal}`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin,
				...options
			}
		});
	} catch (err) {
		logger.error("Erro ao gerar frase do biscoito:", err);
		return new ReturnMessage({
			chatId,
			content: "❌ Algo deu errado ao abrir o biscoito da sorte. Tente novamente mais tarde.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}
}

// Comandos registrados com nomes alternativos
const commands = [
	new Command({
		name: "biscoito",
		description: "Abre um biscoito da sorte",
		category: "zoeira",
		reactions: {
			after: "🥠"
		},
		method: biscoitoCommand
	}),
	new Command({
		name: "biscoito-da-sorte",
		hidden: true,
		category: "zoeira",
		reactions: {
			after: "🥠"
		},
		method: biscoitoCommand
	}),
	new Command({
		name: "biscoito-sorte",
		hidden: true,
		category: "zoeira",
		reactions: {
			after: "🥠"
		},
		method: biscoitoCommand
	})
];

// Exporta os comandos
module.exports = {
	commands
};
