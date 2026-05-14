const axios = require("axios");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const CurrencyConverter = require("../utils/CurrencyConverter");
const Logger = require("../utils/Logger");

const logger = new Logger("GamingFreebies");

/**
 * Busca brindes e jogos grátis na GamerPower
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function gamingFreebiesCommand(bot, message, args, group) {
	const chatId = message.group || message.author;
	const platformArg = args[0]?.toLowerCase();

	try {
		// URLs da API - Ordenado por popularidade
		let giveawaysUrl = "https://www.gamerpower.com/api/giveaways?sort-by=popularity";
		if (platformArg) {
			giveawaysUrl += `&platform=${encodeURIComponent(platformArg)}`;
		}

		const worthUrl = "https://www.gamerpower.com/api/worth";

		// Faz as requisições em paralelo
		const [giveawaysResponse, worthResponse] = await Promise.all([
			axios.get(giveawaysUrl).catch(() => ({ data: [] })),
			axios.get(worthUrl).catch(() => ({ data: { worth_estimation_usd: "0" } }))
		]);

		const giveaways = Array.isArray(giveawaysResponse.data) ? giveawaysResponse.data : [];
		const worthData = worthResponse.data;

		if (giveaways.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `❌ Nenhum brinde encontrado${platformArg ? ` para a plataforma *${platformArg}*` : ""}.`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		// Separa jogos de DLCs/Outros
		const games = giveaways.filter((item) => item.type.toLowerCase() === "game");
		const others = giveaways.filter((item) => item.type.toLowerCase() !== "game");

		// Limita o total de itens para não estourar limite do WhatsApp
		const limit = 100;
		let count = 0;

		let response = `🎮 *JOGOS GRÁTIS ATUALMENTE* 🎮\n`;
		response += `_Lista de jogos e no final lista de DLCs/cupons/gifts de jogos_\n`;
		if (platformArg) response += `📍 Filtro: *${platformArg.toUpperCase()}*\n`;
		response += `\n`;

		// Seção de Jogos
		if (games.length > 0) {
			response += `🕹️ *JOGOS:* \n\n`;
			games.slice(0, limit).forEach((item) => {
				if (count >= limit) return;
				response += `*${item.title}*\n`;
				response += `👾 💻 ${item.platforms}\n`;
				response += `🔗 ${item.open_giveaway_url}\n\n`;
				count++;
			});
		}

		// Seção de DLCs/Outros
		if (others.length > 0 && count < limit) {
			response += `━━━━━━━━━━━━━━━\n`;
			response += `🎁 *DLCs, CUPONS E GIFTS:* \n\n`;
			others.slice(0, limit - count).forEach((item) => {
				if (count >= limit) return;
				response += `*${item.title}*\n`;
				response += `🎁 💻 ${item.platforms}\n`;
				response += `🔗 ${item.open_giveaway_url}\n\n`;
				count++;
			});
		}

		// Adiciona o worth
		const rawWorth = worthData?.worth_estimation_usd || worthData?.worth || "0";
		const usdWorth = parseFloat(rawWorth.replace("$", "").replace(",", "")) || 0;
		const brlWorth = CurrencyConverter.convertToBRL(usdWorth);
		const brlFormatted = CurrencyConverter.formatBRL(brlWorth);

		response += `━━━━━━━━━━━━━━━\n\n`;
		response += `💰 *ECONOMIA TOTAL:* \n`;
		response += `Ao todo, você pode economizar aproximadamente *${brlFormatted}* hoje!\n\n`;

		response += `💡 *Dica:* Você pode filtrar por plataforma.\n`;
		response += `> Exemplo: !0800 pc ou !freebies steam\n\n`;
		response += `*Sugestões de filtro:* \n`;
		response += `_pc, steam, epic-games-store, gog, itch.io, ps4, ps5, xbox-one, switch, android, ios_`;

		// Se a mensagem for muito longa, WhatsApp pode cortar ou dar erro.
		// Vamos verificar se ultrapassa um limite seguro (ex: 40k chars)
		if (response.length > 40000) {
			response = response.substring(0, 39900) + "... \n\n*Mensagem cortada devido ao tamanho.*";
		}

		return new ReturnMessage({
			chatId,
			content: response,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro ao buscar giveaways:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Erro ao buscar brindes de jogos. Tente novamente mais tarde.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}
}

// Configuração do comando
const commands = [
	new Command({
		name: "0800",
		description: "Mostra jogos grátis e brindes atuais",
		usage: "!0800 [plataforma]",
		category: "jogos",
		reactions: {
			after: "🎮"
		},
		method: gamingFreebiesCommand
	}),
	new Command({
		name: "giveaways",
		description: "Mostra jogos grátis e brindes atuais",
		usage: "!giveaways [plataforma]",
		category: "jogos",
		reactions: {
			after: "🎮"
		},
		method: gamingFreebiesCommand
	})
];

module.exports = {
	commands
};
