const DB_NAME = "free_games_notified";

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS notified_free_games (
		store       TEXT NOT NULL,
		game_id     TEXT NOT NULL,
		title       TEXT NOT NULL,
		url         TEXT NOT NULL,
		notified_at INTEGER NOT NULL,
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
			"SELECT game_id FROM notified_free_games WHERE store = ?",
			[storeKey]
		);
		return new Set(rows.map((row) => row.game_id));
	}

	/**
	 * Troca, de uma vez, todos os jogos registrados da loja.
	 * @param {string} storeKey
	 * @param {Array<{id: string, title: string, url: string}>} games
	 */
	async replaceStoreGames(storeKey, games) {
		const notifiedAt = Date.now();
		await this.database.dbTransaction(DB_NAME, async () => {
			await this.database.dbRun(DB_NAME, "DELETE FROM notified_free_games WHERE store = ?", [
				storeKey
			]);
			for (const game of games) {
				await this.database.dbRun(
					DB_NAME,
					`INSERT INTO notified_free_games (store, game_id, title, url, notified_at)
					 VALUES (?, ?, ?, ?, ?)`,
					[storeKey, game.id, game.title, game.url, notifiedAt]
				);
			}
		});
	}
}

module.exports = SqliteWeeklyGamesRepository;
