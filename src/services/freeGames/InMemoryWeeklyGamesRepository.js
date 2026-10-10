/**
 * Repositório em memória dos jogos da semana já anunciados.
 * Mesma interface do SqliteWeeklyGamesRepository; usado nos testes.
 */
class InMemoryWeeklyGamesRepository {
	constructor() {
		this.gamesByStore = new Map();
	}

	/**
	 * @param {string} storeKey
	 * @returns {Promise<Set<string>>}
	 */
	async getGameIds(storeKey) {
		const games = this.gamesByStore.get(storeKey) ?? [];
		return new Set(games.map((game) => game.id));
	}

	/**
	 * @param {string} storeKey
	 * @param {Array<{id: string}>} games
	 */
	async replaceStoreGames(storeKey, games) {
		this.gamesByStore.set(storeKey, [...games]);
	}
}

module.exports = InMemoryWeeklyGamesRepository;
