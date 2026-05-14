const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

// Cria novo logger
const logger = new Logger("lol-build");

/**
 * Retorna o link para a build de um campeão do League of Legends
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function lolBuildCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		// Verifica se o usuário passou o nome do campeão
		if (!args || args.length === 0) {
			logger.info("Nenhum campeão informado");
			return new ReturnMessage({
				chatId,
				content: "❌ Por favor, informe o nome do campeão.\n\n*Exemplo:* !lol-build aatrox",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		// Normaliza o nome do campeão (lowercase e remove espaços extras)
		const campeao = args.join("-").toLowerCase().trim();

		if (!campeao) {
			logger.warn("Nome do campeão inválido");
			return new ReturnMessage({
				chatId,
				content: "❌ Nome do campeão inválido.",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		// Gera o link para a build
		const link = `https://op.gg/lol/champions/${campeao}/build`;

		logger.info(`Build gerada para o campeão: ${campeao}`);

		return new ReturnMessage({
			chatId,
			content: `🎮 *Build do League of Legends*\n\n*Campeão:* ${campeao.charAt(0).toUpperCase() + campeao.slice(1)}\n*Link:* ${link}`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (err) {
		logger.error("Erro ao gerar build do LoL:", err);
		return new ReturnMessage({
			chatId,
			content: "❌ Algo deu errado ao buscar a build. Tente novamente mais tarde.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}
}

// Comandos registrados
const commands = [
	new Command({
		name: "lol-build",
		description: "Retorna o link da build de um campeão do League of Legends",
		category: "jogos",
		reactions: {
			after: "🎮"
		},
		method: lolBuildCommand
	})
];

// Exporta os comandos
module.exports = {
	commands
};
