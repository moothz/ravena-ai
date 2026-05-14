const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const axios = require("axios");

// Cria novo logger
const logger = new Logger("psncommand");

const API_BASE_URL = process.env.PSNCOMMAND_API_URL;

/**
 * Consulta as platinas de um usuário da PSN
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function psnPlatinaCommand(bot, message, args, group) {
	const chatId = message.group || message.author;

	// Verifica se foi fornecido o usuário
	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Por favor, forneça um nome de usuário da PSN.\n\n*Exemplo:* !psn-platinas meu_usuario",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	const usuario = args.join(" ");

	try {
		const apiKey = process.env.API_KEY_STEAMCOMMAND;

		if (!apiKey) {
			logger.error("API_KEY_STEAMCOMMAND não configurada");
			return new ReturnMessage({
				chatId,
				content: "❌ Erro: API_KEY_STEAMCOMMAND não configurada!",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		// Primeiro, buscar o usuário
		const searchResponse = await axios.get(
			`${API_BASE_URL}/search/${encodeURIComponent(usuario)}`,
			{
				headers: { "api-key": apiKey }
			}
		);

		const searchData = searchResponse.data;

		// Verificar se há resultados
		if (!searchData.results || searchData.results.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "❌ Nenhum resultado encontrado!",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const socialResults = searchData.results.find((r) => r.domain === "SocialAllAccounts");

		if (!socialResults || !socialResults.results || socialResults.results.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "❌ Usuário não encontrado na PSN!",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		// Pegar o primeiro resultado (mais relevante)
		const userData = socialResults.results[0].socialMetadata;
		const accountId = userData.accountId;

		if (!accountId) {
			return new ReturnMessage({
				chatId,
				content: "❌ Não foi possível obter o ID da conta!",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		// Buscar as platinas
		const platinumsResponse = await axios.get(`${API_BASE_URL}/user/${accountId}/platinums`, {
			headers: { "api-key": apiKey }
		});

		const platinumsData = platinumsResponse.data;

		// Montar a mensagem de resposta
		let resposta = `🏆 *Platinas da PlayStation*\n\n`;
		resposta += `👤 *${userData.onlineId}*\n`;
		resposta += `🌍 País: *${userData.country || "N/A"}*\n`;
		resposta += `💎 Total de Platinas: *${platinumsData.totalPlatinums}*\n`;
		resposta += `⭐ PS Plus: *${userData.isPsPlus ? "Sim" : "Não"}*\n\n`;

		// Adicionar as platinas
		if (platinumsData.platinums && platinumsData.platinums.length > 0) {
			resposta += `🏅 *Jogos Platinados:*\n\n`;

			platinumsData.platinums.forEach((game, index) => {
				const totalTrophies =
					game.earnedTrophies.bronze +
					game.earnedTrophies.silver +
					game.earnedTrophies.gold +
					game.earnedTrophies.platinum;

				const lastUpdated = new Date(game.lastUpdatedDateTime);
				const dateText = lastUpdated.toLocaleDateString("pt-BR");

				resposta += `*${index + 1}. ${game.trophyTitleName}*\n`;
				resposta += `   🥉 ${game.earnedTrophies.bronze} 🥈 ${game.earnedTrophies.silver} 🥇 ${game.earnedTrophies.gold} 💎 ${game.earnedTrophies.platinum}\n`;
				resposta += `   🏅 ${totalTrophies} troféu${totalTrophies > 1 ? "s" : ""} • 📅 ${dateText}\n\n`;
			});
		} else {
			resposta += `😔 _Nenhuma platina encontrada ainda..._\n\n`;
		}

		return new ReturnMessage({
			chatId,
			content: resposta,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro ao buscar platinas da PSN:");

		let errorMessage = "❌ Erro ao buscar informações da PSN.";

		if (error.response) {
			if (error.response.status === 404) {
				errorMessage = "❌ Usuário não encontrado!";
			} else if (error.response.status === 401 || error.response.status === 403) {
				errorMessage = "❌ Erro de autenticação com a API. Verifique a API key.";
			} else {
				errorMessage = `❌ Erro na API: ${error.response.status}`;
			}
		} else if (error.request) {
			errorMessage = "❌ Não foi possível conectar à API. Verifique sua conexão.";
		}

		return new ReturnMessage({
			chatId,
			content: errorMessage,
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
		name: "psn-platinas",
		aliases: ["psn", "playstation"],
		description: "Consulta as platinas de um usuário da PSN",
		usage: "!psn-platinas <usuario>",
		category: "jogos",
		needsArgs: true,
		minArgs: 1,
		reactions: {
			after: "🏆"
		},
		method: psnPlatinaCommand
	})
];

// Exporta os comandos
module.exports = {
	commands
};
