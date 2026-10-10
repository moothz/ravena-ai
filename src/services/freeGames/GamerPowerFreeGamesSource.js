const axios = require("axios");

const GIVEAWAYS_URL = "https://www.gamerpower.com/api/giveaways";
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Converte o valor da API ("$19.99", "$1,299.50", "N/A") em dólares.
 * @param {string} rawWorth
 * @returns {number} 0 quando não há valor
 */
function parseWorthUsd(rawWorth) {
	const amount = parseFloat(String(rawWorth ?? "").replace(/[^0-9.]/g, ""));
	return Number.isFinite(amount) ? amount : 0;
}

/**
 * @param {Object} giveaway - item cru da API da GamerPower
 * @param {import("./freeGameStores").FreeGameStore} store
 * @returns {import("./formatFreeGamesMessage").FreeGame|null}
 */
function toFreeGame(giveaway, store) {
	if (!giveaway?.id || !giveaway?.title || !giveaway?.open_giveaway_url) return null;
	return {
		id: String(giveaway.id),
		title: store.formatTitle(giveaway.title),
		url: giveaway.open_giveaway_url,
		worthUsd: parseWorthUsd(giveaway.worth)
	};
}

/**
 * Fonte de jogos grátis de uma loja, via GamerPower.
 */
class GamerPowerFreeGamesSource {
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
	 * @param {import("./freeGameStores").FreeGameStore} store
	 * @returns {Promise<{ok: true, games: Array}|{ok: false}>} `ok: false` quando a requisição falha
	 */
	async fetchCurrentGames(store) {
		try {
			const response = await this.httpClient.get(GIVEAWAYS_URL, {
				params: { platform: store.platform, type: "game", "sort-by": "popularity" },
				timeout: REQUEST_TIMEOUT_MS
			});
			const giveaways = Array.isArray(response.data) ? response.data : [];
			const games = giveaways.map((giveaway) => toFreeGame(giveaway, store)).filter(Boolean);
			return { ok: true, games };
		} catch (error) {
			this.logger.error(`Erro ao buscar jogos grátis (${store.key}):`, error.message);
			return { ok: false };
		}
	}
}

module.exports = GamerPowerFreeGamesSource;
