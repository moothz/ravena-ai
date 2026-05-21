const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const CustomVariableProcessor = require("../utils/CustomVariableProcessor");

const logger = new Logger("sorteio");
const variableProcessor = new CustomVariableProcessor();

const MAX_SORTEADOS = 20;

/**
 * Sorteia X pessoas usando a mesma logica da variavel {mention}.
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function sorteioCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const quantidade = Number.parseInt(args?.[0], 10);

		if (!Number.isInteger(quantidade) || quantidade < 1) {
			return new ReturnMessage({
				chatId,
				content: "❌ Use assim: !sorteio 3",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		if (quantidade > MAX_SORTEADOS) {
			return new ReturnMessage({
				chatId,
				content: `❌ O maximo permitido e ${MAX_SORTEADOS} sorteados por vez.`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const options = {};
		const mentionsTemplate = Array.from({ length: quantidade }, () => "{mention}").join(", ");
		const sorteados = await variableProcessor.process(mentionsTemplate, {
			message,
			group,
			options,
			bot
		});

		return new ReturnMessage({
			chatId,
			content: `🎲 Os sorteados foram: ${sorteados}`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin,
				...options
			}
		});
	} catch (err) {
		logger.error("Erro ao executar sorteio:", err);
		return new ReturnMessage({
			chatId,
			content: "❌ Algo deu errado ao realizar o sorteio. Tente novamente mais tarde.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}
}

const commands = [
	new Command({
		name: "sorteio",
		description: "Sorteia uma quantidade de pessoas do grupo",
		category: "utilidades",
		reactions: {
			after: "🎲"
		},
		method: sorteioCommand
	})
];

module.exports = {
	commands
};
