const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const axios = require("axios");

// Cria novo logger
const logger = new Logger("steamcommand");

const API_BASE_URL = process.env.STEAMCOMMAND_API_URL;

/**
 * Consulta as platinas de um usuário da Steam
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function platinaCommand(bot, message, args, group) {
	const chatId = message.group || message.author;

	// Verifica se foi fornecido o usuário/steamid
	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Por favor, forneça um nome de usuário ou SteamID.\n\n*Exemplo:* !platina meu_usuario",
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

		// Primeiro, obter o SteamID
		const getUserResponse = await axios.get(
			`${API_BASE_URL}/get_id/${encodeURIComponent(usuario)}`,
			{
				headers: { "api-key": apiKey }
			}
		);

		const userData = getUserResponse.data;
		const steamid = userData.steamid;

		if (!steamid) {
			return new ReturnMessage({
				chatId,
				content: "❌ Usuário não encontrado na Steam!",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		// Depois, buscar as platinas
		const platinumsResponse = await axios.get(`${API_BASE_URL}/platinums/${steamid}/`, {
			headers: { "api-key": apiKey }
		});

		const platinumsData = platinumsResponse.data;

		// Montar a mensagem de resposta
		let resposta = `🏆 *Platinas da Steam*\n\n`;
		resposta += `👤 *${userData.name}*\n`;
		resposta += `🔗 ${userData.profile_url}\n\n`;
		resposta += `📊 *Estatísticas:*\n`;
		resposta += `🎮 Total de Jogos: *${platinumsData.total_games}*\n`;
		resposta += `🕹️ Jogos Jogados: *${platinumsData.played_games}*\n`;
		resposta += `💎 Platinas: *${platinumsData.platinums_count}*\n\n`;

		// Adicionar as platinas
		if (platinumsData.platinums && platinumsData.platinums.length > 0) {
			resposta += `🏅 *Jogos Platinados:*\n\n`;

			platinumsData.platinums.forEach((game, index) => {
				const hours = Math.floor(game.playtime_forever / 60);
				const minutes = game.playtime_forever % 60;
				const timeText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

				resposta += `*${index + 1}. ${game.game_name}*\n`;
				resposta += `   🏅 ${game.total_achievements} conquista${game.total_achievements > 1 ? "s" : ""} • ⏱️ ${timeText}\n\n`;
			});
		} else {
			resposta += `😔 _Nenhuma platina encontrada ainda..._\n\n`;
		}

		resposta += `\n_${platinumsData.from_cache ? "📦 Dados em cache" : "✨ Dados atualizados"}_`;

		return new ReturnMessage({
			chatId,
			content: resposta,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro ao buscar platinas:");

		let errorMessage = "❌ Erro ao buscar informações da Steam.";

		if (error.response) {
			if (error.response.status === 404) {
				errorMessage = "❌ Usuário não encontrado! Tente usar seu Steam ID";
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
		name: "steam-platinas",
		description: "Consulta as platinas de um usuário da Steam",
		usage: "!platina <usuario/steamid>",
		category: "jogos",
		needsArgs: true,
		minArgs: 1,
		reactions: {
			after: "🏆"
		},
		method: platinaCommand
	})
];

// Exporta os comandos
module.exports = {
	commands
};
