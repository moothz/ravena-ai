/**
 * Repositório em memória dos jogos da semana já anunciados.
 * Mesma interface do SqliteWeeklyGamesRepository; usado nos testes.
 */
class InMemoryWeeklyGamesRepository {
	constructor() {
		this.gameIdsByStore = new Map();
	}

	/**
	 * @param {string} storeKey
	 * @returns {Promise<Set<string>>}
	 */
	async getGameIds(storeKey) {
		return new Set(this.gameIdsByStore.get(storeKey) ?? []);
	}

	/**
	 * @param {string} storeKey
	 * @param {string[]} gameIds
	 */
	async replaceStoreGameIds(storeKey, gameIds) {
		this.gameIdsByStore.set(storeKey, [...gameIds]);
	}
}

module.exports = InMemoryWeeklyGamesRepository;
