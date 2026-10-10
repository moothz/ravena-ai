const GENERIC_HEADER = "🎮 *Jogos novos liberados!*";

/**
 * @typedef {Object} FreeGame
 * @property {string} id
 * @property {string} title
 * @property {string} url
 * @property {number} worthUsd
 */

/**
 * @typedef {Object} StoreSection
 * @property {string} label
 * @property {FreeGame[]} games
 */

/**
 * @param {FreeGame} game
 * @returns {string}
 */
function formatGameEntry(game) {
	return `*${game.title}*\n🔗 ${game.url}`;
}

/**
 * @param {StoreSection} section
 * @returns {string}
 */
function formatGameList(section) {
	return section.games.map(formatGameEntry).join("\n\n");
}

/**
 * @param {StoreSection} section
 * @returns {string}
 */
function formatLabeledSection(section) {
	return `*${section.label}:*\n${formatGameList(section)}`;
}

/**
 * Monta a mensagem de jogos novos. Com uma única loja, o nome dela vai no
 * cabeçalho; com várias, cada loja ganha uma seção rotulada.
 * @param {StoreSection[]} sections
 * @returns {string|null} null quando não há nada para anunciar
 */
function formatFreeGamesMessage(sections) {
	if (sections.length === 0) return null;

	if (sections.length === 1) {
		const [section] = sections;
		return `🎮 *Jogos novos liberados na ${section.label}!*\n\n${formatGameList(section)}`;
	}

	return `${GENERIC_HEADER}\n\n${sections.map(formatLabeledSection).join("\n\n")}`;
}

module.exports = { formatFreeGamesMessage };
