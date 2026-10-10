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
 * O filtro `type=game` da API já exclui DLC e early access; conferir aqui
 * garante o mesmo resultado se o filtro deixar de ser aplicado.
 * @param {Object} giveaway
 * @returns {boolean}
 */
function isGame(giveaway) {
	return !giveaway.type || String(giveaway.type).toLowerCase() === "game";
}

const ARP_POINTS_PATTERN = /\bARP\b/;

/**
 * Chaves da Alienware Arena custam ARP (pontos da conta deles): não são de graça de verdade.
 * @param {Object} giveaway
 * @returns {boolean}
 */
function requiresArpPoints(giveaway) {
	return ARP_POINTS_PATTERN.test(`${giveaway.description ?? ""} ${giveaway.instructions ?? ""}`);
}

/**
 * @param {Object} giveaway - item cru da API da GamerPower
 * @returns {import("./formatFreeGamesMessage").FreeGame|null}
 */
function toFreeGame(giveaway) {
	if (!giveaway?.id || !giveaway?.title || !giveaway?.open_giveaway_url) return null;
	if (!isGame(giveaway) || requiresArpPoints(giveaway)) return null;
	return {
		id: String(giveaway.id),
		title: giveaway.title,
		url: giveaway.open_giveaway_url,
		worthUsd: parseWorthUsd(giveaway.worth)
	};
}

/**
 * Fonte de jogos grátis por plataforma, via GamerPower.
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
	 * @param {string} platform - filtro `platform` da GamerPower (ex.: "steam")
	 * @returns {Promise<{ok: true, games: Array}|{ok: false}>} `ok: false` quando a requisição falha.
	 *   Os títulos vêm exatamente como a API devolve.
	 */
	async fetchCurrentGames(platform) {
		try {
			const response = await this.httpClient.get(GIVEAWAYS_URL, {
				params: { platform, type: "game", "sort-by": "popularity" },
				timeout: REQUEST_TIMEOUT_MS
			});
			const giveaways = Array.isArray(response.data) ? response.data : [];
			const games = giveaways.map(toFreeGame).filter(Boolean);
			return { ok: true, games };
		} catch (error) {
			this.logger.error(`Erro ao buscar jogos grátis (${platform}):`, error.message);
			return { ok: false };
		}
	}
}

module.exports = GamerPowerFreeGamesSource;
