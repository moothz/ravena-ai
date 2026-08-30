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
const helper = {
	about: "Consulta de perfis, jogos e conquistas platinadas na Steam",
	implementation:
		"Consulta a API pública da Steam e serviços de conquistas para calcular jogos com 100% de progresso",
	tags: "steam,platinas,conquistas,jogos,pc,games,perfil",
	cmds: [
		{
			cmd: "!steam-platinas",
			desc: "Exibe a quantidade e lista de platinas (100% conquistas) de um jogador na Steam",
			usage: ["!steam-platinas VanityURLOuSteamID"],
			category: "jogos"
		}
	]
};

/**
 * Consulta informações e preços de um jogo na Steam Store
 * @param {string} query - Nome do jogo
 * @returns {Promise<string>}
 */
async function fetchSteamGameInfo(query) {
	if (!query || typeof query !== "string" || query.trim().length === 0) {
		return "Por favor, informe o nome do jogo para pesquisar na Steam.";
	}

	const termo = query.trim();

	try {
		// 1. Busca jogo na Steam Store API (Store Search)
		const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(termo)}&l=brazilian&cc=BR`;
		const searchRes = await axios.get(searchUrl, { timeout: 10000 });
		const items = searchRes.data?.items;

		if (!items || items.length === 0) {
			return `Não foi possível encontrar o jogo "${termo}" na Steam.`;
		}

		const bestItem = items[0];
		const appId = bestItem.id;

		// 2. Detalhes completos do App
		const detailUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=br&l=brazilian`;
		const detailRes = await axios.get(detailUrl, { timeout: 10000 });
		const appData = detailRes.data?.[appId]?.data;

		if (!appData) {
			return `🎮 **${bestItem.name}**\n🔗 Link: https://store.steampowered.com/app/${appId}/`;
		}

		let resultado = `🎮 **${appData.name}** (AppID: ${appId})\n`;
		if (appData.is_free) {
			resultado += `💰 Preço: **Gratuito para Jogar (Free to Play)**\n`;
		} else if (appData.price_overview) {
			const po = appData.price_overview;
			if (po.discount_percent > 0) {
				resultado += `💰 Preço: **${po.final_formatted}** (🔥 -${po.discount_percent}% OFF | De ${po.initial_formatted})\n`;
			} else {
				resultado += `💰 Preço: **${po.final_formatted}**\n`;
			}
		} else {
			resultado += `💰 Preço: Não disponível / Grátis\n`;
		}

		if (appData.developers && appData.developers.length > 0) {
			resultado += `🏢 Desenvolvedor: ${appData.developers.join(", ")}\n`;
		}
		if (appData.release_date?.date) {
			resultado += `📅 Lançamento: ${appData.release_date.date}\n`;
		}
		if (appData.genres && appData.genres.length > 0) {
			resultado += `🏷️ Gêneros: ${appData.genres.map((g) => g.description).join(", ")}\n`;
		}
		if (appData.short_description) {
			resultado += `\n📝 Descrição: ${appData.short_description.trim()}\n`;
		}
		resultado += `\n🔗 Loja Steam: https://store.steampowered.com/app/${appId}/`;

		return resultado.trim();
	} catch (err) {
		logger.error(`Erro ao consultar jogo na Steam para ${query}:`, err.message);
		return `Erro ao consultar a Steam para "${query}": ${err.message}`;
	}
}

/**
 * Consulta platinas/conquistas de um usuário da Steam (apenas texto)
 * @param {string} user - Nome de usuário ou SteamID
 * @returns {Promise<string>}
 */
async function fetchSteamPlatinums(user) {
	if (!user || typeof user !== "string" || user.trim().length === 0) {
		return "Por favor, informe o nome de usuário ou SteamID na Steam.";
	}

	const usuario = user.trim();
	const apiKey = process.env.API_KEY_STEAMCOMMAND;

	if (!apiKey || !API_BASE_URL) {
		return "API de platinas da Steam não configurada no servidor.";
	}

	try {
		const getUserResponse = await axios.get(
			`${API_BASE_URL}/get_id/${encodeURIComponent(usuario)}`,
			{
				headers: { "api-key": apiKey },
				timeout: 10000
			}
		);

		const userData = getUserResponse.data;
		const steamid = userData.steamid;

		if (!steamid) {
			return `Usuário "${usuario}" não encontrado na Steam.`;
		}

		const platinumsResponse = await axios.get(`${API_BASE_URL}/platinums/${steamid}/`, {
			headers: { "api-key": apiKey },
			timeout: 10000
		});

		const platinumsData = platinumsResponse.data;

		let resposta = `🏆 **Platinas da Steam - ${userData.name}**\n`;
		resposta += `🎮 Total de Jogos: ${platinumsData.total_games} | Jogados: ${platinumsData.played_games}\n`;
		resposta += `💎 Platinas (100% conquistas): **${platinumsData.platinums_count}**\n\n`;

		if (platinumsData.platinums && platinumsData.platinums.length > 0) {
			resposta += `🏅 **Jogos Platinados:**\n`;
			platinumsData.platinums.slice(0, 10).forEach((game, index) => {
				const hours = Math.floor(game.playtime_forever / 60);
				const minutes = game.playtime_forever % 60;
				const timeText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
				resposta += `  ${index + 1}. **${game.game_name}** (${game.total_achievements} conquistas • ⏱️ ${timeText})\n`;
			});
		} else {
			resposta += `Nenhuma platina registrada até o momento.\n`;
		}

		return resposta.trim();
	} catch (err) {
		logger.error(`Erro ao buscar platinas para ${user}:`, err.message);
		return `Erro ao consultar perfil da Steam: ${err.message}`;
	}
}

module.exports = {
	helper,
	commands,
	platinaCommand,
	fetchSteamGameInfo,
	fetchSteamPlatinums
};
