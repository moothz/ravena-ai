const HEADER = "🎮 *Jogos novos liberados na Epic!*";

/**
 * @typedef {Object} FreeGame
 * @property {string} title
 * @property {string} url
 */

/**
 * @param {FreeGame} game
 * @returns {string}
 */
function formatGameEntry(game) {
	return `*${game.title}*\n🔗 ${game.url}`;
}

/**
 * Monta a mensagem semanal de jogos grátis da Epic.
 * @param {FreeGame[]} games
 * @returns {string|null} null quando não há jogos para anunciar
 */
function formatEpicFreeGamesMessage(games) {
	if (!games || games.length === 0) return null;
	return [HEADER, ...games.map(formatGameEntry)].join("\n\n");
}

module.exports = { formatEpicFreeGamesMessage };
