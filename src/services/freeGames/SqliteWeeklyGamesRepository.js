const DB_NAME = "free_games_notified";

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS weekly_free_games (
		store   TEXT NOT NULL,
		game_id TEXT NOT NULL,
		PRIMARY KEY (store, game_id)
	);
`;

/**
 * DB global (não por grupo) dos jogos da semana já anunciados, separados por loja.
 */
class SqliteWeeklyGamesRepository {
	/**
	 * @param {Object} deps
	 * @param {Object} deps.database - Database do projeto (getSQLiteDb, dbRun, dbAll, dbTransaction)
	 */
	constructor({ database }) {
		this.database = database;
		this.database.getSQLiteDb(DB_NAME, SCHEMA);
	}

	/**
	 * @param {string} storeKey
	 * @returns {Promise<Set<string>>}
	 */
	async getGameIds(storeKey) {
		const rows = await this.database.dbAll(
			DB_NAME,
			"SELECT game_id FROM weekly_free_games WHERE store = ?",
			[storeKey]
		);
		return new Set(rows.map((row) => row.game_id));
	}

	/**
	 * Troca, de uma vez, todos os jogos registrados da loja.
	 * @param {string} storeKey
	 * @param {string[]} gameIds
	 */
	async replaceStoreGameIds(storeKey, gameIds) {
		await this.database.dbTransaction(DB_NAME, async () => {
			await this.database.dbRun(DB_NAME, "DELETE FROM weekly_free_games WHERE store = ?", [
				storeKey
			]);
			for (const gameId of gameIds) {
				await this.database.dbRun(
					DB_NAME,
					"INSERT INTO weekly_free_games (store, game_id) VALUES (?, ?)",
					[storeKey, gameId]
				);
			}
		});
	}
}

module.exports = SqliteWeeklyGamesRepository;
