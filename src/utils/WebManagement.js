const Database = require("./Database");
const Logger = require("./Logger");

class WebManagement {
	constructor() {
		this.logger = new Logger("web-management");
		this.database = Database.getInstance();
		this.DB_NAME = "web_management";

		// Initialize Database
		this.database.getSQLiteDb(
			this.DB_NAME,
			`
      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        group_id TEXT,
        json_data TEXT
      );
    `
		);

		// Cleanup expired tokens periodically (every hour)
		this.cleanupInterval = setInterval(() => this.cleanupExpiredTokens(), 60 * 60 * 1000);
		// Initial cleanup after a short delay
		setTimeout(() => this.cleanupExpiredTokens(), 5000);
	}

	async cleanupExpiredTokens() {
		try {
			const now = new Date().toISOString();
			const allTokens = await this.database.dbAll(
				this.DB_NAME,
				"SELECT token, json_data FROM tokens"
			);

			let deletedCount = 0;
			for (const row of allTokens) {
				const data = JSON.parse(row.json_data);
				if (data.expiresAt && data.expiresAt < now) {
					await this.database.dbRun(this.DB_NAME, "DELETE FROM tokens WHERE token = ?", [
						row.token
					]);
					deletedCount++;
				}
			}

			if (deletedCount > 0) {
				this.logger.info(`Cleaned up ${deletedCount} expired tokens.`);
			}
		} catch (error) {
			this.logger.error("Error cleaning up expired tokens:", error);
		}
	}

	static getInstance() {
		if (!WebManagement.instance) {
			WebManagement.instance = new WebManagement();
		}
		return WebManagement.instance;
	}

	async getToken(token) {
		try {
			const row = await this.database.dbGet(
				this.DB_NAME,
				"SELECT json_data FROM tokens WHERE token = ?",
				[token]
			);
			return row ? JSON.parse(row.json_data) : null;
		} catch (error) {
			this.logger.error("Error reading token:", error);
			return null;
		}
	}

	async saveToken(tokenData) {
		try {
			await this.database.dbRun(
				this.DB_NAME,
				"INSERT OR REPLACE INTO tokens (token, group_id, json_data) VALUES (?, ?, ?)",
				[tokenData.token, tokenData.groupId, JSON.stringify(tokenData)]
			);
			return true;
		} catch (error) {
			this.logger.error("Error saving token:", error);
			return false;
		}
	}
}

module.exports = WebManagement;
