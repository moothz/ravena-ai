/**
 * Regras puras de seleção dos jogos da semana.
 * @typedef {import("./formatFreeGamesMessage").FreeGame} FreeGame
 * @typedef {(games: FreeGame[]) => FreeGame[]} GameRanking
 */

/**
 * Jogos da lista atual que ainda não foram anunciados.
 * @param {FreeGame[]} currentGames
 * @param {Set<string>} announcedIds
 * @returns {FreeGame[]}
 */
function selectNewGames(currentGames, announcedIds) {
	return currentGames.filter((game) => !announcedIds.has(game.id));
}

/** @type {GameRanking} Mantém a ordem em que a fonte devolveu os jogos. */
function keepSourceOrder(games) {
	return games;
}

/** @type {GameRanking} Maior valor primeiro. */
function byWorthDescending(games) {
	return [...games].sort((first, second) => second.worthUsd - first.worthUsd);
}

/**
 * Jogos novos que serão anunciados: respeita o ranking e o limite da loja.
 * @param {FreeGame[]} newGames
 * @param {{rank: GameRanking, maxGames?: number}} store - sem `maxGames`, anuncia todos
 * @returns {FreeGame[]}
 */
function selectGamesToAnnounce(newGames, store) {
	return store.rank(newGames).slice(0, store.maxGames ?? newGames.length);
}

/**
 * Próximo estado do DB da loja: os ids da lista atual que já estavam
 * registrados ou que acabaram de ser anunciados. Jogo novo que ficou fora do
 * limite não entra, para poder ser anunciado numa semana seguinte.
 * @param {Set<string>} registeredIds
 * @param {FreeGame[]} currentGames
 * @param {FreeGame[]} announcedGames
 * @returns {string[]}
 */
function idsToKeepRegistered(registeredIds, currentGames, announcedGames) {
	const announcedIds = new Set(announcedGames.map((game) => game.id));
	return currentGames
		.filter((game) => registeredIds.has(game.id) || announcedIds.has(game.id))
		.map((game) => game.id);
}

module.exports = {
	selectNewGames,
	selectGamesToAnnounce,
	idsToKeepRegistered,
	keepSourceOrder,
	byWorthDescending
};
