const axios = require("axios");

const GIVEAWAYS_URL = "https://www.gamerpower.com/api/giveaways";
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Remove do título o nome da loja e o sufixo "Giveaway" que a GamerPower adiciona.
 * Ex.: "Out of Sight (Epic Games) Giveaway" -> "Out of Sight"
 * @param {string} rawTitle
 * @returns {string}
 */
function cleanEpicTitle(rawTitle) {
	return String(rawTitle)
		.replace(/\s*\(Epic Games(?: Store)?\)/i, "")
		.replace(/\s+Giveaway\s*$/i, "")
		.trim();
}

/**
 * @param {Object} giveaway - item cru da API da GamerPower
 * @returns {{title: string, url: string}|null}
 */
function toFreeGame(giveaway) {
	if (!giveaway?.title || !giveaway?.open_giveaway_url) return null;
	return { title: cleanEpicTitle(giveaway.title), url: giveaway.open_giveaway_url };
}

/**
 * Fonte de jogos grátis da Epic Games Store via GamerPower.
 */
class EpicFreeGamesSource {
	/**
	 * @param {Object} deps
	 * @param {{get: Function}} [deps.httpClient]
	 * @param {Object} deps.logger
	 */
	constructor({ httpClient = axios, logger }) {
		this.httpClient = httpClient;
		this.logger = logger;
	}

	/**
	 * @returns {Promise<Array<{title: string, url: string}>>} lista vazia em caso de erro
	 */
	async fetchCurrentGames() {
		try {
			const response = await this.httpClient.get(GIVEAWAYS_URL, {
				params: { platform: "epic-games-store", type: "game", "sort-by": "popularity" },
				timeout: REQUEST_TIMEOUT_MS
			});
			const giveaways = Array.isArray(response.data) ? response.data : [];
			return giveaways.map(toFreeGame).filter(Boolean);
		} catch (error) {
			this.logger.error("Erro ao buscar jogos grátis da Epic:", error.message);
			return [];
		}
	}
}

module.exports = EpicFreeGamesSource;
module.exports.cleanEpicTitle = cleanEpicTitle;
