const Database = require("./Database");
const Logger = require("./Logger");

class SkipGroups {
	constructor() {
		this.logger = new Logger("skip-groups");
		this.database = Database.getInstance();
		this.DB_NAME = "skip_groups";

		// Initialize Database
		this.database.getSQLiteDb(
			this.DB_NAME,
			`
      CREATE TABLE IF NOT EXISTS skipped_groups (
        bot_id TEXT,
        group_id TEXT,
        PRIMARY KEY (bot_id, group_id)
      );
    `
		);
	}

	static getInstance() {
		if (!SkipGroups.instance) {
			SkipGroups.instance = new SkipGroups();
		}
		return SkipGroups.instance;
	}

	async getSkippedGroups(botId) {
		try {
			const rows = await this.database.dbAll(
				this.DB_NAME,
				"SELECT group_id FROM skipped_groups WHERE bot_id = ?",
				[botId]
			);
			return rows.map((r) => r.group_id);
		} catch (error) {
			this.logger.error(`Error getting skipped groups for ${botId}:`, error);
			return [];
		}
	}

	async addSkippedGroup(botId, groupId) {
		try {
			await this.database.dbRun(
				this.DB_NAME,
				"INSERT OR IGNORE INTO skipped_groups (bot_id, group_id) VALUES (?, ?)",
				[botId, groupId]
			);
			return true;
		} catch (error) {
			this.logger.error(`Error adding skipped group ${groupId} for ${botId}:`, error);
			return false;
		}
	}

	async removeSkippedGroup(botId, groupId) {
		try {
			await this.database.dbRun(
				this.DB_NAME,
				"DELETE FROM skipped_groups WHERE bot_id = ? AND group_id = ?",
				[botId, groupId]
			);
			return true;
		} catch (error) {
			this.logger.error(`Error removing skipped group ${groupId} for ${botId}:`, error);
			return false;
		}
	}

	async isGroupSkipped(botId, groupId) {
		try {
			const row = await this.database.dbGet(
				this.DB_NAME,
				"SELECT 1 FROM skipped_groups WHERE bot_id = ? AND group_id = ?",
				[botId, groupId]
			);
			return !!row;
		} catch (error) {
			this.logger.error(`Error checking if group ${groupId} is skipped for ${botId}:`, error);
			return false;
		}
	}
}

module.exports = SkipGroups;
