const { keepSourceOrder, byWorthDescending } = require("./weeklyGamesSelection");

/**
 * Lojas monitoradas pelo aviso semanal de jogos grátis.
 * A ordem do array define a ordem das seções na mensagem.
 */

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
 * @typedef {Object} FreeGameStore
 * @property {string} key - identificador da loja no DB de jogos notificados
 * @property {string} label - nome exibido na mensagem
 * @property {string} platform - valor do filtro `platform` da GamerPower
 * @property {string} groupFlag - campo do grupo que liga o aviso desta loja
 * @property {(title: string) => string} formatTitle
 * @property {import("./weeklyGamesSelection").GameRanking} rank - ordem dos jogos novos antes do limite
 * @property {number} [maxGames] - máximo de jogos anunciados por execução (sem valor: todos)
 */

/** @type {FreeGameStore[]} */
const FREE_GAME_STORES = [
	{
		key: "epic",
		label: "Epic",
		platform: "epic-games-store",
		groupFlag: "notificarEpic",
		formatTitle: cleanEpicTitle,
		rank: keepSourceOrder
	},
	{
		key: "steam",
		label: "Steam",
		platform: "steam",
		groupFlag: "notificarSteam",
		formatTitle: (title) => title,
		rank: byWorthDescending,
		maxGames: 3
	}
];

/**
 * @param {string} storeKey
 * @returns {FreeGameStore}
 */
function getStoreByKey(storeKey) {
	const store = FREE_GAME_STORES.find((candidate) => candidate.key === storeKey);
	if (!store) throw new Error(`Loja de jogos grátis desconhecida: ${storeKey}`);
	return store;
}

module.exports = { FREE_GAME_STORES, getStoreByKey, cleanEpicTitle };
