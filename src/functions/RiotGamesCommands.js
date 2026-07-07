const axios = require("axios");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

// Create a new logger
const logger = new Logger("riot-games-commands");

// Riot Games API key from environment variables
const RIOT_API_KEY = process.env.RIOT_GAMES;

// Base URLs for different Riot APIs
const RIOT_BASE_URL = "https://americas.api.riotgames.com/riot";
const LOL_BASE_URL = "https://br1.api.riotgames.com/lol"; // Default to NA region
const VALORANT_BASE_URL = "https://br.api.riotgames.com/val";

// Cache for LoL DDragon version
let cachedVersion = null;
let lastVersionFetchTime = 0;

/**
 * Fetch the latest League of Legends patch version from Riot's DDragon
 * @returns {Promise<string>} - The latest version string (e.g. "16.13.1")
 */
async function getLatestLolVersion() {
	const now = Date.now();
	// Cache version for 24 hours
	if (cachedVersion && now - lastVersionFetchTime < 24 * 60 * 60 * 1000) {
		return cachedVersion;
	}

	try {
		const response = await axios.get("https://ddragon.leagueoflegends.com/api/versions.json", {
			timeout: 5000
		});
		if (Array.isArray(response.data) && response.data.length > 0) {
			cachedVersion = response.data[0];
			lastVersionFetchTime = now;
			logger.info(`LoL Data Dragon version updated to: ${cachedVersion}`);
			return cachedVersion;
		}
	} catch (error) {
		logger.error("Erro ao buscar a versão mais recente do LoL Data Dragon:", error.message);
	}

	return cachedVersion || "16.13.1"; // Default fallback
}

/**
 * Helper to handle Riot API errors and return friendly messages
 * @param {Error} error - Axios error
 * @param {string} gameName - Player game name
 * @param {string} tagLine - Player tag line
 * @returns {string} - Friendly error message
 */
function handleRiotError(error, gameName, tagLine) {
	if (!RIOT_API_KEY) {
		return "A chave de API da Riot Games não está configurada nas variáveis de ambiente (RIOT_GAMES).";
	}
	if (error.response) {
		const status = error.response.status;
		if (status === 401 || status === 403) {
			return "A chave de API da Riot Games (RIOT_GAMES) configurada está inválida ou expirou.";
		}
		if (status === 404) {
			return `Não foi possível encontrar o jogador "${gameName}#${tagLine}". Verifique se o nome e a tag estão corretos.`;
		}
		if (status === 429) {
			return "O limite de requisições da API da Riot Games foi excedido. Tente novamente mais tarde.";
		}
		return `Erro na API da Riot Games (Status: ${status}).`;
	}
	return error.message || "Ocorreu um erro desconhecido ao consultar a API da Riot Games.";
}

// Emoji mapping for ranked tiers
const RANK_EMOJIS = {
	IRON: "🔗",
	BRONZE: "🥉",
	SILVER: "🥈",
	GOLD: "🥇",
	PLATINUM: "💎",
	EMERALD: "💚",
	DIAMOND: "💍",
	MASTER: "🏆",
	GRANDMASTER: "👑",
	CHALLENGER: "⚡"
};

const RANK_EMOJIS_VALORANT = {
	"Iron 1": "🔗",
	"Iron 2": "🔗",
	"Iron 3": "🔗",
	Iron: "🔗",
	"Bronze 1": "🥉",
	"Bronze 2": "🥉",
	"Bronze 3": "🥉",
	Bronze: "🥉",
	"Silver 1": "🥈",
	"Silver 2": "🥈",
	"Silver 3": "🥈",
	Silver: "🥈",
	"Gold 1": "🥇",
	"Gold 2": "🥇",
	"Gold 3": "🥇",
	Gold: "🥇",
	"Platinum 1": "💎",
	"Platinum 2": "💎",
	"Platinum 3": "💎",
	Platinum: "💎",
	"Diamond 1": "💍",
	"Diamond 2": "💍",
	"Diamond 3": "💍",
	Diamond: "💍",
	"Ascendant 1": "😇",
	"Ascendant 2": "😇",
	"Ascendant 3": "😇",
	Ascendant: "😇",
	"Immortal 1": "☠️",
	"Immortal 2": "☠️",
	"Immortal 3": "☠️",
	Immortal: "☠️",
	Radiant: "🌞"
};

// Emoji mapping for positions/roles
const POSITION_EMOJIS = {
	TOP: "🛡️",
	JUNGLE: "🌳",
	MIDDLE: "🧙‍♂️",
	BOTTOM: "🏹",
	SUPPORT: "💉"
};

/**
 * Get rank emoji for a tier
 * @param {string} tier - Rank tier (e.g., GOLD, PLATINUM)
 * @returns {string} - Corresponding emoji
 */
function getRankEmoji(tier) {
	return RANK_EMOJIS[tier] || "❓";
}

/**
 * Format number with commas for thousands
 * @param {number} num - Number to format
 * @returns {string} - Formatted number
 */
function formatNumber(num) {
	return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Get League of Legends summoner data
 * @param {string} gameName - Summoner name to look up
 * @param {string} tagLine - Summoner tagLine to look up
 * @returns {Promise<Object>} - Formatted summoner data
 */
async function getLolSummonerData(gameName, tagLine) {
	if (!RIOT_API_KEY) {
		throw new Error(
			"A chave de API da Riot Games não está configurada nas variáveis de ambiente (RIOT_GAMES)."
		);
	}

	try {
		// Fetch account by gameName/tagLine
		const accountResponse = await axios.get(
			`${RIOT_BASE_URL}/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName.trim())}/${encodeURIComponent(tagLine.trim())}`,
			{ headers: { "X-Riot-Token": RIOT_API_KEY } }
		);
		/*
    {
      "puuid": "JJyNY...",
      "gameName": "Nome",
      "tagLine": "TAG"
    }
    */
		const account = accountResponse.data;

		const summonerRequest = await axios.get(
			`${LOL_BASE_URL}/summoner/v4/summoners/by-puuid/${account.puuid}`,
			{ headers: { "X-Riot-Token": RIOT_API_KEY } }
		);
		const summoner = summonerRequest.data;

		// Fetch ranked data
		logger.debug(`Buscando dados ranqueados para PUUID: ${summoner.puuid}`);
		const rankedResponse = await axios.get(
			`${LOL_BASE_URL}/league/v4/entries/by-puuid/${summoner.puuid}`,
			{ headers: { "X-Riot-Token": RIOT_API_KEY } }
		);

		// Fetch mastery data (top 5 champions)
		logger.debug(`Buscando maestria para PUUID: ${summoner.puuid}`);
		const masteryResponse = await axios.get(
			`${LOL_BASE_URL}/champion-mastery/v4/champion-masteries/by-puuid/${summoner.puuid}/top?count=5`,
			{ headers: { "X-Riot-Token": RIOT_API_KEY } }
		);

		// Get champion data to map champion IDs to names dynamically based on latest version
		const version = await getLatestLolVersion();
		logger.debug(`Buscando dados dos campeões na versão ${version}`);
		const championsUrl = `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`;
		const championResponse = await axios.get(championsUrl);

		const championData = championResponse.data.data;
		const championIdToName = {};

		// Map champion IDs to names
		for (const champKey in championData) {
			const champion = championData[champKey];
			championIdToName[champion.key] = champion.name;
		}

		// Process ranked data
		const soloQueue =
			(rankedResponse.data || []).find((queue) => queue.queueType === "RANKED_SOLO_5x5") || {};
		const flexQueue =
			(rankedResponse.data || []).find((queue) => queue.queueType === "RANKED_FLEX_SR") || {};

		// Process mastery data
		const masteryData = (masteryResponse.data || []).map((mastery) => ({
			championName: championIdToName[mastery.championId] || `Champion #${mastery.championId}`,
			championLevel: mastery.championLevel,
			championPoints: mastery.championPoints
		}));

		return {
			name: `${gameName}#${tagLine}`,
			level: summoner.summonerLevel,
			profileIconId: summoner.profileIconId,
			soloQueue: {
				tier: soloQueue.tier || "UNRANKED",
				rank: soloQueue.rank || "",
				leaguePoints: soloQueue.leaguePoints || 0,
				wins: soloQueue.wins || 0,
				losses: soloQueue.losses || 0
			},
			flexQueue: {
				tier: flexQueue.tier || "UNRANKED",
				rank: flexQueue.rank || "",
				leaguePoints: flexQueue.leaguePoints || 0,
				wins: flexQueue.wins || 0,
				losses: flexQueue.losses || 0
			},
			mastery: masteryData
		};
	} catch (error) {
		logger.error(`Error fetching LoL data for ${gameName}#${tagLine}:`, error.message);
		const friendlyError = handleRiotError(error, gameName, tagLine);
		throw new Error(friendlyError);
	}
}

/**
 * Format LoL summoner data into a message
 * @param {Object} data - Summoner data
 * @returns {string} - Formatted message
 */
function formatLolMessage(data) {
	// Calculate win rates
	const soloWinRate =
		data.soloQueue.wins + data.soloQueue.losses > 0
			? Math.round((data.soloQueue.wins / (data.soloQueue.wins + data.soloQueue.losses)) * 100)
			: 0;

	const flexWinRate =
		data.flexQueue.wins + data.flexQueue.losses > 0
			? Math.round((data.flexQueue.wins / (data.flexQueue.wins + data.flexQueue.losses)) * 100)
			: 0;

	let message = `🎮 *League of Legends - ${data.name}*\n`;
	message += `📊 Nível: ${data.level}\n\n`;

	// Solo/Duo queue
	message += `*💪 Ranqueada Solo/Duo:*\n`;
	if (data.soloQueue.tier === "UNRANKED") {
		message += `Sem classificação\n`;
	} else {
		message += `${getRankEmoji(data.soloQueue.tier)} ${data.soloQueue.tier} ${data.soloQueue.rank} (${data.soloQueue.leaguePoints} LP)\n`;
		message += `🏅 ${data.soloQueue.wins}V ${data.soloQueue.losses}D (${soloWinRate}% de vitórias)\n`;
	}

	// Flex queue
	message += `\n*👥 Ranqueada Flex:*\n`;
	if (data.flexQueue.tier === "UNRANKED") {
		message += `Sem classificação\n`;
	} else {
		message += `${getRankEmoji(data.flexQueue.tier)} ${data.flexQueue.tier} ${data.flexQueue.rank} (${data.flexQueue.leaguePoints} LP)\n`;
		message += `🏅 ${data.flexQueue.wins}V ${data.flexQueue.losses}D (${flexWinRate}% de vitórias)\n`;
	}

	// Champion mastery
	message += `\n*🏆 Principais Campeões:*\n`;
	for (let i = 0; i < data.mastery.length; i++) {
		const champ = data.mastery[i];
		message += `${i + 1}. ${champ.championName} (Nível ${champ.championLevel}, ${formatNumber(champ.championPoints)} pts)\n`;
	}

	return message;
}

/**
 * Get Valorant player data
 * @param {string} gameName - Game name to look up
 * @param {string} tagLine - Tag line (e.g., "NA1")
 * @returns {Promise<Object>} - Formatted player data
 */
async function getValorantPlayerData(gameName, tagLine) {
	try {
		// Fetch account by gameName/tagLine
		const accountResponse = await axios.get(
			`${RIOT_BASE_URL}/account/v1/accounts/by-riot-id/${gameName}/${tagLine}`,
			{ headers: { "X-Riot-Token": RIOT_API_KEY } }
		);

		const account = accountResponse.data;
		const puuid = account.puuid;
		console.log(account);

		// Get player ranked data
		console.log(`${VALORANT_BASE_URL}/content/v1/contents`);
		const rankedResponse = await axios.get(`${VALORANT_BASE_URL}/content/v1/contents`, {
			headers: { "X-Riot-Token": RIOT_API_KEY }
		});
		console.log("rankedResponse", rankedResponse.data);

		// Get match history
		console.log(`${VALORANT_BASE_URL}/match/v1/matchlists/by-puuid/${puuid}`);
		const matchlistResponse = await axios.get(
			`${VALORANT_BASE_URL}/match/v1/matchlists/by-puuid/${puuid}`,
			{ headers: { "X-Riot-Token": RIOT_API_KEY } }
		);
		console.log("matchlistResponse", matchlistResponse.data);

		// Get MMR/ranked data
		console.log(`${VALORANT_BASE_URL}/ranked/v1/leaderboards/by-puuid/${puuid}`);
		const mmrResponse = await axios.get(
			`${VALORANT_BASE_URL}/ranked/v1/leaderboards/by-puuid/${puuid}`,
			{ headers: { "X-Riot-Token": RIOT_API_KEY } }
		);
		console.log("mmrResponse", mmrResponse.data);

		// Process the data from the API responses
		// Note: The actual structure will depend on the API responses
		const rankedData = mmrResponse.data;
		const matchlistData = matchlistResponse.data;

		// Process agent data from match history
		const agentStats = processAgentStats(matchlistData);

		return {
			name: gameName,
			tagLine,
			puuid,
			ranked: rankedData,
			agents: agentStats
		};
	} catch (error) {
		logger.error(`Error fetching Valorant data for ${gameName}#${tagLine}:`, error.message);
		throw new Error(
			`Não foi possível encontrar o jogador de Valorant "${gameName}#${tagLine}" ou ocorreu um erro durante a busca.`
		);
	}
}

// Helper function to process agent stats from match history
function processAgentStats(matchlistData) {
	// This would process the match history to extract agent performance
	// Implementation depends on the actual structure of the API response
	const agentStats = [];

	// Example processing (adjust based on actual API response)
	if (matchlistData && matchlistData.matches) {
		const agentMap = new Map();

		matchlistData.matches.forEach((match) => {
			const agent = match.agentUsed;
			if (!agentMap.has(agent)) {
				agentMap.set(agent, {
					name: agent,
					matches: 0,
					wins: 0,
					kills: 0,
					deaths: 0,
					assists: 0
				});
			}

			const stats = agentMap.get(agent);
			stats.matches++;
			if (match.won) stats.wins++;
			stats.kills += match.kills || 0;
			stats.deaths += match.deaths || 0;
			stats.assists += match.assists || 0;
		});

		// Convert map to array and calculate derived stats
		for (const [_, stats] of agentMap) {
			const winRate = Math.round((stats.wins / stats.matches) * 100);
			const kda =
				stats.deaths > 0
					? ((stats.kills + stats.assists) / stats.deaths).toFixed(2)
					: (stats.kills + stats.assists).toFixed(2);

			agentStats.push({
				name: stats.name,
				matches: stats.matches,
				winRate,
				kda
			});
		}

		// Sort by matches played
		agentStats.sort((a, b) => b.matches - a.matches);
	}

	return agentStats.slice(0, 5); // Return top 5 agents
}

/**
 * Format Valorant player data into a message
 * @param {Object} data - Player data
 * @returns {string} - Formatted message
 */
function formatValorantMessage(data) {
	// Calculate win rate
	const winRate = Math.round((data.ranked.wins / (data.ranked.wins + data.ranked.losses)) * 100);

	let message = `🔫 *Valorant - ${data.name}#${data.tagLine}*\n\n`;

	// Ranked info
	message += `*🏆 Rank Competitivo:*\n`;
	const rankStr =
		data.ranked.tier === "RADIANT" ? "RADIANT" : `${data.ranked.tier} ${data.ranked.rank}`;
	message += `${getRankEmoji(data.ranked.tier)} ${rankStr} (${data.ranked.rr} RR)\n`;
	message += `🏅 ${data.ranked.wins}V ${data.ranked.losses}D (${winRate}% de vitórias)\n`;

	// Top agents
	message += `\n*👤 Principais Agentes:*\n`;
	for (let i = 0; i < data.agents.length; i++) {
		const agent = data.agents[i];
		message += `${i + 1}. ${agent.name} - ${agent.matches} partidas, ${agent.winRate}% VIT, ${agent.kda} KDA\n`;
	}

	return message;
}

/**
 * Parse a Riot ID from input
 * @param {Array} args - Command arguments
 * @returns {Object} - Parsed game name and tag line
 */
function parseRiotId(args) {
	const input = args.join(" ");

	if (input.includes("#")) {
		const [namePart, tagPart] = input.split("#");

		let tagLine = null;
		let server = null;

		if (tagPart.includes("-")) {
			[tagLine, server] = tagPart.split("-");
		} else {
			tagLine = tagPart;
		}

		return {
			gameName: namePart.trim(),
			tagLine: tagLine?.trim() || null,
			server: server?.trim().toUpperCase() || null
		};
	}

	// Fallback for no hashtag
	if (args.length >= 2) {
		const lastArg = args.pop();
		return {
			gameName: args.join(" ").trim(),
			tagLine: lastArg.trim(),
			server: null
		};
	}

	return {
		gameName: input.trim(),
		tagLine: null,
		server: null
	};
}

/**
 * Handles the LoL command
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage or array of ReturnMessages
 */
async function handleLolCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const returnMessages = [];

	try {
		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça um nome de invocador. Exemplo: !lol Faker#ABC"
			});
		}

		const summonerName = args.join(" ");

		if (!summonerName.includes("#")) {
			return new ReturnMessage({
				chatId,
				content: `❌ Informe o nome do invocador seguido da tag, exemplo: !lol Faker#ABC`
			});
		}

		// Send a waiting message
		returnMessages.push(
			new ReturnMessage({
				chatId,
				content: `🔍 Buscando invocador: ${summonerName}...`
			})
		);

		// Get summoner data
		const [gameName, tagLine] = summonerName.split("#");
		const summonerData = await getLolSummonerData(gameName, tagLine);

		// Format message
		const formattedMessage = formatLolMessage(summonerData);

		// Send response
		return new ReturnMessage({
			chatId,
			content: formattedMessage
		});
	} catch (error) {
		logger.error("Erro ao executar comando lol:");
		return new ReturnMessage({
			chatId,
			content: `Erro: ${error.message || "Ocorreu um erro ao buscar o invocador."}`
		});
	}
}

/**
 * Get Valorant player rank from third-party APIs
 * @param {string} gameName - Riot ID name
 * @param {string} tagLine - Riot ID tag
 * @param {string|null} server - Optional server region
 * @returns {Promise<string>} - Formatted message
 */
async function getValorantRank(gameName, tagLine, server) {
	// Try vaccie.pythonanywhere.com first if server is provided
	if (server) {
		try {
			logger.debug(`Buscando Valorant rank no Vaccie API para ${gameName}#${tagLine} (${server})`);
			const response = await axios.get(
				`https://vaccie.pythonanywhere.com/mmr/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}/${encodeURIComponent(server.toLowerCase())}`,
				{ timeout: 6000 }
			);
			if (response.data && !response.data.includes("Errore")) {
				const rank = response.data.split(",")[0];
				const emojiRank = RANK_EMOJIS_VALORANT[rank] ?? "🏆";
				return `🔫 *Valorant - ${gameName}#${tagLine} @ ${server.toUpperCase()}*\n\n${emojiRank} ${response.data}`;
			}
		} catch (e) {
			logger.warn(`Vaccie API falhou para ${gameName}#${tagLine}: ${e.message}`);
		}
	}

	// Fallback or if no server was specified: Rengar API (region-independent)
	try {
		logger.debug(`Buscando Valorant rank no Rengar API para ${gameName}#${tagLine}`);
		const response = await axios.get(
			`https://www.reng.ar/api/rank/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
			{ timeout: 8000 }
		);
		const text = response.data;
		if (text && text.includes(" is ")) {
			const rankInfo = text.split(" is ")[1];
			let emojiRank = "🏆";
			// Match rank name to find emoji
			for (const key of Object.keys(RANK_EMOJIS_VALORANT)) {
				if (rankInfo.toLowerCase().includes(key.toLowerCase())) {
					emojiRank = RANK_EMOJIS_VALORANT[key];
					break;
				}
			}
			return `🔫 *Valorant - ${gameName}#${tagLine}*\n\n${emojiRank} ${rankInfo}`;
		}
		return `🔫 *Valorant - ${gameName}#${tagLine}*\n\n🏆 ${text}`;
	} catch (e) {
		logger.error(`Rengar API falhou para ${gameName}#${tagLine}:`, e.message);
		throw new Error("Não foi possível obter os dados do jogador de Valorant nas APIs disponíveis.");
	}
}

/**
 * Handles the Valorant command
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage or array of ReturnMessages
 */
async function handleValorantCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça um Riot ID com tagline (ex: !valorant NomeJogador#ABC ou !valorant NomeJogador#ABC-BR)"
			});
		}

		// Parse the Riot ID
		const { gameName, tagLine, server } = parseRiotId(args);

		if (!tagLine) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça um Riot ID completo com tagline (ex: NomeJogador#ABC)"
			});
		}

		const formattedMessage = await getValorantRank(gameName, tagLine, server);

		// Send response
		return new ReturnMessage({
			chatId,
			content: formattedMessage
		});
	} catch (error) {
		logger.error("Erro ao executar comando valorant:", error);
		return new ReturnMessage({
			chatId,
			content: `Erro: ${error.message || "Ocorreu um erro ao buscar o jogador."}`
		});
	}
}

/**
 * Handles the Wild Rift command
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage
 */
async function handleWildRiftCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	return new ReturnMessage({
		chatId,
		content:
			"📱 *Wild Rift (Riot Games)*\n\n❌ Infelizmente, a Riot Games **não disponibiliza uma API pública** para o Wild Rift que permita consultar dados de perfil, histórico ou elo dos jogadores.\n\nCaso a Riot lance a API no futuro, adicionarei a busca aqui! Se você conhece alguma, me chama no !grupao 😉"
	});
}

// Define commands using Command class
const commands = [
	new Command({
		name: "lol",
		description: "Busca perfil de jogador de League of Legends",
		category: "jogos",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🎮",
			error: "❌"
		},
		method: handleLolCommand
	}),

	new Command({
		name: "valorant",
		description: "Busca perfil de jogador de Valorant",
		category: "jogos",
		group: "valorant",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔫",
			error: "❌"
		},
		method: handleValorantCommand
	}),

	new Command({
		name: "valo",
		description: "Busca perfil de jogador de Valorant",
		category: "jogos",
		group: "valorant",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔫",
			error: "❌"
		},
		method: handleValorantCommand
	}),

	new Command({
		name: "wildrift",
		description: "Busca perfil de jogador de Wild Rift",
		category: "jogos",
		group: "wildrift",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📱",
			error: "❌"
		},
		method: handleWildRiftCommand
	}),

	new Command({
		name: "wr",
		description: "Busca perfil de jogador de Wild Rift",
		category: "jogos",
		group: "wildrift",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📱",
			error: "❌"
		},
		method: handleWildRiftCommand
	})
];

module.exports = { commands };
