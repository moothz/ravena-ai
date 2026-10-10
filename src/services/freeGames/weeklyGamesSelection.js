/**
 * Regras puras de seleção dos jogos da semana.
 * @typedef {import("./formatFreeGamesMessage").FreeGame} FreeGame
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

/**
 * @param {FreeGame[]} games
 * @param {"api"|"worth"} ranking
 * @returns {FreeGame[]}
 */
function rankGames(games, ranking) {
	if (ranking !== "worth") return games;
	return [...games].sort((first, second) => second.worthUsd - first.worthUsd);
}

/**
 * Jogos novos que serão anunciados: respeita o ranking e o limite da loja.
 * @param {FreeGame[]} newGames
 * @param {{ranking: "api"|"worth", maxGames: number}} store
 * @returns {FreeGame[]}
 */
function selectGamesToAnnounce(newGames, store) {
	return rankGames(newGames, store.ranking).slice(0, store.maxGames);
}

/**
 * Próximo estado do DB da loja: os jogos da lista atual que já estavam
 * registrados ou que acabaram de ser anunciados. Jogo novo que ficou fora do
 * limite não entra, para poder ser anunciado numa semana seguinte.
 * @param {Set<string>} registeredIds
 * @param {FreeGame[]} currentGames
 * @param {FreeGame[]} announcedGames
 * @returns {FreeGame[]}
 */
function nextWeeklyGames(registeredIds, currentGames, announcedGames) {
	const announcedIds = new Set(announcedGames.map((game) => game.id));
	return currentGames.filter((game) => registeredIds.has(game.id) || announcedIds.has(game.id));
}

module.exports = { selectNewGames, selectGamesToAnnounce, nextWeeklyGames };
