const axios = require("axios");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

// Cria novo logger
const logger = new Logger("metar");

/**
 * Busca o METAR de um aeroporto
 * @param {string} icao - Código ICAO do aeroporto
 * @returns {Promise<string>} - Texto do METAR
 */
async function buscarMetar(icao) {
	const query = encodeURIComponent(icao);
	const url = `https://aviationweather.gov/api/data/metar/?ids=${query}&format=raw`;

	try {
		const { data } = await axios.get(url, { responseType: "text" });
		return data.trim();
	} catch (err) {
		logger.error("Erro ao buscar METAR:", err);
		return null;
	}
}

/**
 * Comando para buscar e retornar o METAR de um aeroporto
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function metarCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		if (!args.length) {
			return new ReturnMessage({
				chatId,
				content: "🛄 Informe o código ICAO do aeroporto. Exemplo: !metar SBGR",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const icao = args[0].toUpperCase();
		const metar = await buscarMetar(icao);

		if (!metar || metar.toLowerCase().includes("no data found")) {
			return new ReturnMessage({
				chatId,
				content: `❌ Não foi possível encontrar o METAR para "${icao}".`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		return new ReturnMessage({
			chatId,
			content: `🌤️ METAR para *${icao}*:\n\`\`\`\n${metar}\n\`\`\``,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro ao executar comando metar:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Ocorreu um erro ao buscar o METAR. Por favor, tente novamente mais tarde."
		});
	}
}

// Criação do comando
const commands = [
	new Command({
		name: "metar",
		description: "Busca o METAR de um aeroporto (ex: !metar SBPA)",
		usage: "!metar <código_icao>",
		category: "busca",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🌤️",
			error: "❌"
		},
		method: metarCommand
	})
];

module.exports = {
	commands,
	buscarMetar
};
