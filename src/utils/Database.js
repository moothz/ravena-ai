const fs = require("fs");
const path = require("path");
const Logger = require("./Logger");
const sqlite3 = require("sqlite3").verbose();
const DatabaseBackup = require("./DatabaseBackup");

/**
 * Singleton Database class using SQLite backend with JSON storage (Hybrid approach)
 */
class Database {
	constructor(options = {}) {
		this.options = options;
		this.logger = new Logger("database");
		this.databasePath = path.join(__dirname, "../../data");
		this.backupPath = path.join(__dirname, "../../data/backups");

		this.sqlites = {}; // Cache for other sqlite connections (like 'pinto')
		this.noBackupDatabases = new Set(); // Track databases that should not be backed up
		this.schemas = {}; // Store schemas for restoration
		this.coreDb = null; // Main database connection

		this.ensureDirectories();
		this.initCoreDatabase();

		// Bot instances for cleanup on exit
		this.botInstances = [];

		// Backup System Initialization
		this.backupSystem = new DatabaseBackup(this);
		this.scheduledBackupHours = process.env.SCHEDULED_BACKUP_HOURS
			? process.env.SCHEDULED_BACKUP_HOURS.split(",")
					.map((h) => parseInt(h.trim()))
					.filter((h) => !isNaN(h))
			: [0, 6, 12, 18];

		// Shared Blocked Contacts (Global by type)
		this.globalBlockedContacts = {
			wwebjs: new Set(),
			evo: new Set(),
			evogo: new Set()
		};

		// Setup cleanup handlers
		this.setupCleanupHandlers();

		this.backupStarted = false;
		this.lastScheduledBackup = this.getLastScheduledBackupTime();

		// Fallback: Start backup system after 5 minutes if no write occurred
		if (!this.options.disableBackup) {
			setTimeout(
				() => {
					this.triggerBackupStart("timeout");
				},
				5 * 60 * 1000
			);
		}
	}

	/**
	 * Trigger the start of the backup system (Remote and Scheduled)
	 * @param {string} reason - The reason for starting (write or timeout)
	 */
	triggerBackupStart(reason = "write") {
		if (this.options?.disableBackup) return;
		if (this.backupStarted) return;
		this.backupStarted = true;

		this.logger.info(`Starting backup system. Reason: ${reason}`);

		// Start independent remote backup interval
		this.backupSystem.startRemoteBackupInterval();

		// Setup local scheduled backups
		this.setupScheduledBackups();
	}

	/**
	 * Get Singleton Instance
	 * @returns {Database}
	 */
	static getInstance(options = {}) {
		if (!Database.instance) {
			Database.instance = new Database(options);
		}
		return Database.instance;
	}

	registerBotInstance(bot) {
		//this.logger.info(`[registerBotInstance] Registered: ${bot.id}`);
		this.botInstances.push(bot);
	}

	ensureDirectories() {
		try {
			if (!fs.existsSync(this.databasePath)) {
				fs.mkdirSync(this.databasePath, { recursive: true });
			}
			if (!fs.existsSync(this.backupPath)) {
				fs.mkdirSync(this.backupPath, { recursive: true });
			}
			const sqliteDir = path.join(this.databasePath, "sqlites");
			if (!fs.existsSync(sqliteDir)) {
				fs.mkdirSync(sqliteDir, { recursive: true });
			}
		} catch (error) {
			this.logger.error("Error ensuring database directories:", error);
		}
	}

	initCoreDatabase() {
		const dbPath = path.join(this.databasePath, "sqlites/core.db");
		this.coreDb = new sqlite3.Database(dbPath);

		// Enable WAL mode for better concurrency and to prevent corruption
		this.coreDb.run("PRAGMA journal_mode = WAL");
		this.coreDb.run("PRAGMA synchronous = NORMAL");
		this.coreDb.run("PRAGMA busy_timeout = 5000");

		// Ensure tables exist (redundant if migration ran, but good for safety)
		this.coreDb.serialize(() => {
			const tables = [
				`CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT, json_data TEXT)`,
				`CREATE TABLE IF NOT EXISTS custom_commands (group_id TEXT, trigger TEXT, json_data TEXT, PRIMARY KEY (group_id, trigger))`,
				`CREATE TABLE IF NOT EXISTS donations (name TEXT PRIMARY KEY, json_data TEXT)`,
				`CREATE TABLE IF NOT EXISTS pending_joins (code TEXT PRIMARY KEY, json_data TEXT)`,
				`CREATE TABLE IF NOT EXISTS soft_blocks (number TEXT PRIMARY KEY, json_data TEXT)`,
				`CREATE TABLE IF NOT EXISTS load_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, timestamp_end INTEGER, json_data TEXT)`,
				`CREATE TABLE IF NOT EXISTS blocked_invites (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, jid TEXT, json_data TEXT)`
			];
			this.schemas["core"] = tables.join("; ");
			tables.forEach((sql) => this.coreDb.run(sql));
			this.coreDb.run(
				`CREATE INDEX IF NOT EXISTS idx_blocked_invites_code ON blocked_invites(code)`
			);
			this.coreDb.run(`CREATE INDEX IF NOT EXISTS idx_blocked_invites_jid ON blocked_invites(jid)`);
		});
	}

	setupCleanupHandlers() {
		const cleanup = () => {
			this.logger.info("Closing database connections...");
			if (this.coreDb) this.coreDb.close();
			Object.values(this.sqlites).forEach((db) => db.close());

			this.botInstances.forEach((bot) => {
				try {
					bot.destroy();
				} catch (e) {}
			});
		};

		process.on("SIGINT", () => {
			cleanup();
			process.exit(0);
		});

		process.on("SIGTERM", () => {
			cleanup();
			process.exit(0);
		});
	}

	// --- Backup System ---

	setupScheduledBackups() {
		setInterval(() => {
			const now = new Date();
			const currentHour = now.getHours();

			if (this.scheduledBackupHours.includes(currentHour)) {
				const lastBackupDate = new Date(this.lastScheduledBackup);

				if (
					lastBackupDate.getDate() !== now.getDate() ||
					lastBackupDate.getMonth() !== now.getMonth() ||
					lastBackupDate.getFullYear() !== now.getFullYear() ||
					lastBackupDate.getHours() !== currentHour
				) {
					this.createScheduledBackup();
					this.lastScheduledBackup = now.getTime();
				}
			}
		}, 60000); // Check every minute
	}

	getLastScheduledBackupTime() {
		try {
			const backupInfoPath = path.join(this.backupPath, "backup-info.json");
			if (fs.existsSync(backupInfoPath)) {
				const backupInfo = JSON.parse(fs.readFileSync(backupInfoPath, "utf8"));
				return backupInfo.lastScheduledBackup || 0;
			}
		} catch (error) {
			this.logger.error("Error getting last backup info:", error);
		}
		return 0;
	}

	saveLastScheduledBackupTime(timestamp) {
		try {
			const backupInfoPath = path.join(this.backupPath, "backup-info.json");
			const backupInfo = fs.existsSync(backupInfoPath)
				? JSON.parse(fs.readFileSync(backupInfoPath, "utf8"))
				: {};

			backupInfo.lastScheduledBackup = timestamp;
			fs.writeFileSync(backupInfoPath, JSON.stringify(backupInfo, null, 2), "utf8");
		} catch (error) {
			this.logger.error("Error saving backup info:", error);
		}
	}

	async createScheduledBackup() {
		const success = await this.backupSystem.createScheduledBackup();
		if (success) {
			this.saveLastScheduledBackupTime(Date.now());
		}
	}

	// --- Global Blocked Contacts ---

	addBlockedContacts(type, contacts) {
		if (!this.globalBlockedContacts[type]) {
			this.logger.warn(`Unknown bot type for blocked contacts: ${type}`);
			return;
		}
		if (!Array.isArray(contacts)) return;

		contacts.forEach((contact) => {
			if (typeof contact === "string") {
				this.globalBlockedContacts[type].add(contact);
			}
		});
		// this.logger.info(`[Database] Updated ${type} blocked contacts. Total: ${this.globalBlockedContacts[type].size}`);
	}

	isBlocked(type, contactId) {
		if (!this.globalBlockedContacts[type]) return false;
		return this.globalBlockedContacts[type].has(contactId);
	}

	// --- Core SQLite Helpers ---

	/**
	 * Run a SQL query on the core database
	 */
	run(sql, params = []) {
		this.triggerBackupStart();
		if (!this.coreDb) {
			return Promise.reject(new Error("Core Database not initialized or currently restoring."));
		}
		return new Promise((resolve, reject) => {
			const self = this;
			this.coreDb.run(sql, params, function (err) {
				if (err) {
					if (err.message && err.message.includes("SQLITE_CORRUPT")) {
						// Async handle corruption
						self.backupSystem.handleCorruption("core", err).catch((e) => {
							self.logger.error("Failed to handle corruption:", e);
						});
					}
					reject(err);
				} else {
					resolve({ lastID: this.lastID, changes: this.changes });
				}
			});
		});
	}

	/**
	 * Get all rows from the core database
	 */
	all(sql, params = []) {
		if (!this.coreDb) {
			return Promise.reject(new Error("Core Database not initialized or currently restoring."));
		}
		return new Promise((resolve, reject) => {
			const self = this;
			this.coreDb.all(sql, params, function (err, rows) {
				if (err) {
					if (err.message && err.message.includes("SQLITE_CORRUPT")) {
						self.backupSystem.handleCorruption("core", err).catch((e) => {
							self.logger.error("Failed to handle corruption:", e);
						});
					}
					reject(err);
				} else resolve(rows);
			});
		});
	}

	/**
	 * Get a single row from the core database
	 */
	get(sql, params = []) {
		if (!this.coreDb) {
			return Promise.reject(new Error("Core Database not initialized or currently restoring."));
		}
		return new Promise((resolve, reject) => {
			const self = this;
			this.coreDb.get(sql, params, function (err, row) {
				if (err) {
					if (err.message && err.message.includes("SQLITE_CORRUPT")) {
						self.backupSystem.handleCorruption("core", err).catch((e) => {
							self.logger.error("Failed to handle corruption:", e);
						});
					}
					reject(err);
				} else resolve(row);
			});
		});
	}

	// --- Groups ---

	async getGroups() {
		try {
			const rows = await this.all("SELECT json_data FROM groups");
			return rows.map((row) => JSON.parse(row.json_data));
		} catch (error) {
			this.logger.error("Error in getGroups:", error);
			return [];
		}
	}

	async getGroup(groupId) {
		try {
			const row = await this.get("SELECT json_data FROM groups WHERE id = ?", [groupId]);
			return row ? JSON.parse(row.json_data) : null;
		} catch (error) {
			this.logger.error("Error in getGroup:", error);
			return null;
		}
	}

	async getGroupByName(groupName) {
		try {
			// Note: This matches exact name. SQLite LIKE could be used for case-insensitive if needed.
			const row = await this.get("SELECT json_data FROM groups WHERE name = ?", [groupName]);
			return row ? JSON.parse(row.json_data) : null;
		} catch (error) {
			this.logger.error("Error in getGroupByName:", error);
			return null;
		}
	}

	async saveGroup(group) {
		this.triggerBackupStart();
		try {
			await this.run(
				`INSERT INTO groups (id, name, json_data) VALUES (?, ?, ?) 
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, json_data=excluded.json_data`,
				[group.id, group.name, JSON.stringify(group)]
			);
			return true;
		} catch (error) {
			this.logger.error("Error saving group:", error);
			return false;
		}
	}

	// --- Custom Commands ---

	async getCustomCommands(groupId) {
		try {
			const rows = await this.all("SELECT json_data FROM custom_commands WHERE group_id = ?", [
				groupId
			]);
			return rows.map((row) => JSON.parse(row.json_data));
		} catch (error) {
			this.logger.error("Error in getCustomCommands:", error);
			return [];
		}
	}

	async saveCustomCommand(groupId, command) {
		this.triggerBackupStart();
		try {
			await this.run(
				`INSERT INTO custom_commands (group_id, trigger, json_data) VALUES (?, ?, ?)
         ON CONFLICT(group_id, trigger) DO UPDATE SET json_data=excluded.json_data`,
				[groupId, command.startsWith, JSON.stringify(command)]
			);
			return true;
		} catch (error) {
			this.logger.error("Error saving custom command:", error);
			return false;
		}
	}

	async updateCustomCommand(groupId, command) {
		// Alias for saveCustomCommand since we use ON CONFLICT UPDATE
		return this.saveCustomCommand(groupId, command);
	}

	async deleteCustomCommand(groupId, commandStart) {
		try {
			// We implement soft delete as per previous logic
			const row = await this.get(
				"SELECT json_data FROM custom_commands WHERE group_id = ? AND trigger = ?",
				[groupId, commandStart]
			);
			if (row) {
				const command = JSON.parse(row.json_data);
				command.deleted = true;
				command.active = false;
				await this.saveCustomCommand(groupId, command);
				return true;
			}
			return false;
		} catch (error) {
			this.logger.error("Error deleting custom command:", error);
			return false;
		}
	}

	async getCustomVariables() {
		try {
			const filePath = path.join(this.databasePath, "custom-variables.json");
			if (fs.existsSync(filePath)) {
				return JSON.parse(fs.readFileSync(filePath, "utf8"));
			}
			return {};
		} catch (error) {
			this.logger.error("Error getting custom variables:", error);
			return {};
		}
	}

	async saveCustomVariables(variables) {
		this.triggerBackupStart();
		try {
			const filePath = path.join(this.databasePath, "custom-variables.json");
			fs.writeFileSync(filePath, JSON.stringify(variables, null, 2));
			return true;
		} catch (error) {
			this.logger.error("Error saving custom variables:", error);
			return false;
		}
	}

	// --- Load Reports ---

	async getLoadReports(since = 0) {
		try {
			const rows = await this.all("SELECT json_data FROM load_reports WHERE timestamp_end > ?", [
				since
			]);
			return rows.map((row) => JSON.parse(row.json_data));
		} catch (error) {
			this.logger.error("Error getting load reports:", error);
			return [];
		}
	}

	async saveLoadReports(reports) {
		this.triggerBackupStart();
		try {
			// Start transaction
			await this.run("BEGIN TRANSACTION");
			await this.run("DELETE FROM load_reports");

			const stmt = this.coreDb.prepare(
				"INSERT INTO load_reports (bot_id, timestamp_end, json_data) VALUES (?, ?, ?)"
			);
			reports.forEach((report) => {
				stmt.run(report.botId, report.period?.end || 0, JSON.stringify(report));
			});
			stmt.finalize();

			await this.run("COMMIT");
			return true;
		} catch (error) {
			this.logger.error("Error saving load reports:", error);
			try {
				await this.run("ROLLBACK");
			} catch (e) {}
			return false;
		}
	}

	async addLoadReport(report) {
		this.triggerBackupStart();
		try {
			await this.run(
				"INSERT INTO load_reports (bot_id, timestamp_end, json_data) VALUES (?, ?, ?)",
				[report.botId, report.period?.end || 0, JSON.stringify(report)]
			);

			return true;
		} catch (error) {
			this.logger.error("Error adding load report:", error);
			return false;
		}
	}

	// --- Donations ---

	async getDonations() {
		try {
			const rows = await this.all("SELECT json_data FROM donations");
			return rows.map((row) => JSON.parse(row.json_data));
		} catch (error) {
			this.logger.error("Error getting donations:", error);
			return [];
		}
	}

	async saveDonations(donations) {
		this.triggerBackupStart();
		try {
			await this.run("BEGIN TRANSACTION");
			await this.run("DELETE FROM donations");
			const stmt = this.coreDb.prepare("INSERT INTO donations (name, json_data) VALUES (?, ?)");
			donations.forEach((d) => {
				stmt.run(d.nome, JSON.stringify(d));
			});
			stmt.finalize();
			await this.run("COMMIT");
			return true;
		} catch (error) {
			this.logger.error("Error saving donations:", error);
			try {
				await this.run("ROLLBACK");
			} catch (e) {}
			return false;
		}
	}

	async addDonation(name, amount, numero = undefined) {
		this.triggerBackupStart();
		try {
			const row = await this.get(
				"SELECT name, json_data FROM donations WHERE name = ? COLLATE NOCASE",
				[name]
			);

			let donor;
			const now = Date.now();
			const historyEntry = { ts: now, valor: amount };
			let donationTotal;

			if (row) {
				donor = JSON.parse(row.json_data);
				donor.valor += amount;
				donor.timestamp = now;
				if (!donor.historico) donor.historico = [];
				donor.historico.push(historyEntry);
				if (numero) donor.numero = numero;
				donationTotal = donor.valor;
			} else {
				donor = {
					nome: name,
					valor: amount,
					numero,
					timestamp: now,
					historico: [historyEntry]
				};
				donationTotal = amount;
			}

			// Save back
			await this.run("INSERT OR REPLACE INTO donations (name, json_data) VALUES (?, ?)", [
				donor.nome,
				JSON.stringify(donor)
			]);

			return donationTotal === 0 ? true : donationTotal;
		} catch (error) {
			this.logger.error("Error adding donation:", error);
			return false;
		}
	}

	async updateDonorNumber(name, numero) {
		this.triggerBackupStart();
		try {
			const row = await this.get("SELECT json_data FROM donations WHERE name = ? COLLATE NOCASE", [
				name
			]);
			if (!row) {
				this.logger.warn(`Donor "${name}" not found`);
				return false;
			}

			const donor = JSON.parse(row.json_data);
			donor.numero = numero;

			await this.run("INSERT OR REPLACE INTO donations (name, json_data) VALUES (?, ?)", [
				donor.nome,
				JSON.stringify(donor)
			]);
			return true;
		} catch (error) {
			this.logger.error("Error updating donor number:", error);
			return false;
		}
	}

	async updateDonationAmount(name, amount) {
		this.triggerBackupStart();
		try {
			const row = await this.get("SELECT json_data FROM donations WHERE name = ? COLLATE NOCASE", [
				name
			]);
			let donor;
			const now = Date.now();
			const historyEntry = { ts: now, valor: amount };

			if (!row) {
				if (amount > 0) {
					donor = {
						nome: name,
						valor: amount,
						timestamp: now,
						historico: [historyEntry]
					};
				} else {
					return false;
				}
			} else {
				donor = JSON.parse(row.json_data);
				donor.valor += amount;
				donor.timestamp = now;
				if (!donor.historico) donor.historico = [];
				donor.historico.push(historyEntry);
			}

			if (donor.valor <= 0) {
				await this.run("DELETE FROM donations WHERE name = ?", [donor.nome]);
				this.logger.warn(`Donor "${name}" removed.`);
			} else {
				await this.run("INSERT OR REPLACE INTO donations (name, json_data) VALUES (?, ?)", [
					donor.nome,
					JSON.stringify(donor)
				]);
			}

			return true;
		} catch (error) {
			this.logger.error("Error updating donation amount:", error);
			return false;
		}
	}

	async mergeDonors(targetName, sourceName) {
		this.triggerBackupStart();
		try {
			const targetRow = await this.get(
				"SELECT json_data FROM donations WHERE name = ? COLLATE NOCASE",
				[targetName]
			);
			const sourceRow = await this.get(
				"SELECT json_data FROM donations WHERE name = ? COLLATE NOCASE",
				[sourceName]
			);

			if (!targetRow || !sourceRow) return false;

			const targetDonor = JSON.parse(targetRow.json_data);
			const sourceDonor = JSON.parse(sourceRow.json_data);

			targetDonor.valor += sourceDonor.valor;
			const sourceHistory = sourceDonor.historico || [];
			const targetHistory = targetDonor.historico || [];
			targetDonor.historico = [...targetHistory, ...sourceHistory].sort((a, b) => a.ts - b.ts);

			if (!targetDonor.numero && sourceDonor.numero) {
				targetDonor.numero = sourceDonor.numero;
			}

			if (targetDonor.historico.length > 0) {
				targetDonor.timestamp = targetDonor.historico[targetDonor.historico.length - 1].ts;
			} else if (
				sourceDonor.timestamp &&
				(!targetDonor.timestamp || sourceDonor.timestamp > targetDonor.timestamp)
			) {
				targetDonor.timestamp = sourceDonor.timestamp;
			}

			await this.run("BEGIN TRANSACTION");
			await this.run("DELETE FROM donations WHERE name = ?", [sourceDonor.nome]);
			await this.run("INSERT OR REPLACE INTO donations (name, json_data) VALUES (?, ?)", [
				targetDonor.nome,
				JSON.stringify(targetDonor)
			]);
			await this.run("COMMIT");

			return true;
		} catch (error) {
			this.logger.error("Error merging donors:", error);
			try {
				await this.run("ROLLBACK");
			} catch (e) {}
			return false;
		}
	}

	// --- Pending Joins ---

	async getPendingJoins() {
		try {
			const rows = await this.all("SELECT json_data FROM pending_joins");
			return rows.map((row) => JSON.parse(row.json_data));
		} catch (error) {
			this.logger.error("Error getting pending joins:", error);
			return [];
		}
	}

	async savePendingJoins(joins) {
		this.triggerBackupStart();
		try {
			await this.run("BEGIN TRANSACTION");
			await this.run("DELETE FROM pending_joins");
			const stmt = this.coreDb.prepare("INSERT INTO pending_joins (code, json_data) VALUES (?, ?)");
			joins.forEach((j) => {
				stmt.run(j.code, JSON.stringify(j));
			});
			stmt.finalize();
			await this.run("COMMIT");
			return true;
		} catch (error) {
			this.logger.error("Error saving pending joins:", error);
			try {
				await this.run("ROLLBACK");
			} catch (e) {}
			return false;
		}
	}

	async savePendingJoin(inviteCode, data) {
		this.triggerBackupStart();
		try {
			// Upsert
			const joinData = {
				code: inviteCode,
				authorId: data.authorId,
				authorName: data.authorName,
				timestamp: Date.now()
			};

			await this.run("INSERT OR REPLACE INTO pending_joins (code, json_data) VALUES (?, ?)", [
				inviteCode,
				JSON.stringify(joinData)
			]);
			return true;
		} catch (error) {
			this.logger.error("Error saving pending join:", error);
			return false;
		}
	}

	async removePendingJoin(inviteCode) {
		this.triggerBackupStart();
		try {
			await this.run("DELETE FROM pending_joins WHERE code = ?", [inviteCode]);
			return true;
		} catch (error) {
			this.logger.error("Error removing pending join:", error);
			return false;
		}
	}

	// --- Soft Blocks ---

	async getSoftblocks() {
		try {
			const rows = await this.all("SELECT json_data FROM soft_blocks");
			return rows.map((row) => JSON.parse(row.json_data));
		} catch (error) {
			this.logger.error("Error getting softblocks:", error);
			return [];
		}
	}

	async toggleUserInvites(phoneNumber, block) {
		this.triggerBackupStart();
		try {
			const row = await this.get("SELECT json_data FROM soft_blocks WHERE number = ?", [
				phoneNumber
			]);
			let user = row ? JSON.parse(row.json_data) : null;

			if (block) {
				if (!user) {
					user = { numero: phoneNumber, invites: true };
				} else {
					user.invites = true;
				}
				await this.run("INSERT OR REPLACE INTO soft_blocks (number, json_data) VALUES (?, ?)", [
					phoneNumber,
					JSON.stringify(user)
				]);
			} else {
				if (user) {
					await this.run("DELETE FROM soft_blocks WHERE number = ?", [phoneNumber]);
				}
			}
			return true;
		} catch (error) {
			this.logger.error("Error toggling user invites:", error);
			return false;
		}
	}

	async isUserInviteBlocked(phoneNumber) {
		try {
			const row = await this.get("SELECT json_data FROM soft_blocks WHERE number = ?", [
				phoneNumber
			]);
			return row ? JSON.parse(row.json_data).invites : false;
		} catch (error) {
			this.logger.error("Error checking user invite block:", error);
			return false;
		}
	}

	// --- Blocked Invites (By Code or JID) ---

	async saveBlockedInvite(code, jid) {
		this.triggerBackupStart();
		try {
			// Check if already exists to avoid duplication
			const existing = await this.get(
				"SELECT id FROM blocked_invites WHERE (code = ? AND code IS NOT NULL) OR (jid = ? AND jid IS NOT NULL)",
				[code, jid]
			);

			if (existing) {
				await this.run(
					"UPDATE blocked_invites SET code = COALESCE(?, code), jid = COALESCE(?, jid) WHERE id = ?",
					[code, jid, existing.id]
				);
			} else {
				await this.run("INSERT INTO blocked_invites (code, jid, json_data) VALUES (?, ?, ?)", [
					code,
					jid,
					JSON.stringify({ timestamp: Date.now() })
				]);
			}
			return true;
		} catch (error) {
			this.logger.error("Error saving blocked invite:", error);
			return false;
		}
	}

	async isInviteBlocked(code, jid) {
		try {
			if (code) {
				const row = await this.get("SELECT 1 FROM blocked_invites WHERE code = ?", [code]);
				if (row) return true;
			}
			if (jid) {
				const row = await this.get("SELECT 1 FROM blocked_invites WHERE jid = ?", [jid]);
				if (row) return true;
			}
			return false;
		} catch (error) {
			this.logger.error("Error checking if invite is blocked:", error);
			return false;
		}
	}

	// --- File System Helpers (Legacy/Compatibility) ---

	loadJSON(filePath, debug = true) {
		try {
			if (!fs.existsSync(filePath)) {
				if (debug) this.logger.debug(`File does not exist: ${filePath}`);
				return null;
			}
			const data = fs.readFileSync(filePath, "utf8");
			if (!data || data.trim() === "") return null;
			return JSON.parse(data);
		} catch (error) {
			if (debug) this.logger.error(`Error loading JSON from ${filePath}:`, error);
			return null;
		}
	}

	saveJSONToFile(filePath, data) {
		this.triggerBackupStart();
		try {
			const dir = path.dirname(filePath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

			const tempFilePath = `${filePath}.tmp`;
			fs.writeFileSync(tempFilePath, JSON.stringify(data, null, 2), "utf8");
			fs.renameSync(tempFilePath, filePath);
			return true;
		} catch (error) {
			this.logger.error(`Error saving JSON to ${filePath}:`, error);
			return false;
		}
	}

	// --- Compatibility / Legacy Methods ---

	clearCache(key) {
		// No-op as cache is removed
	}

	async forcePersist() {
		// No-op as we write directly
		return true;
	}

	// --- Other SQLite Databases (Legacy/Specific) ---

	getSQLiteDb(name, schema, noBackup = false) {
		if (this.backupSystem && this.backupSystem.recoveringDbs.has(name)) {
			this.logger.warn(`Database '${name}' is currently being restored. Waiting...`);
			// We could return a Proxy or wait, but simpler for now is to allow it to fail
			// or we could throw an error that the caller handles.
			// Actually, if we return null, most callers will fail.
			// Let's return the connection anyway if it exists, otherwise throw.
			if (this.sqlites[name]) return this.sqlites[name];
			throw new Error(`Database '${name}' is currently under restoration.`);
		}

		if (noBackup) {
			this.noBackupDatabases.add(name);
		}

		this.schemas[name] = schema;

		if (!this.sqlites[name]) {
			this.logger.info(
				`[database][getSQLiteDb] Loading SQLite DB '${name}' (Backup: ${!noBackup})`
			);

			const databasesFolder = path.join(this.databasePath, "sqlites");
			if (!fs.existsSync(databasesFolder)) {
				fs.mkdirSync(databasesFolder, { recursive: true });
			}

			const dbPath = path.join(databasesFolder, `${name}.db`);
			this.sqlites[name] = new sqlite3.Database(dbPath);

			// Enable WAL mode for better concurrency and to prevent corruption
			this.sqlites[name].run("PRAGMA journal_mode = WAL");
			this.sqlites[name].run("PRAGMA synchronous = NORMAL");
			this.sqlites[name].run("PRAGMA busy_timeout = 5000");

			// Initialize database structure
			this.sqlites[name].serialize(() => {
				this.sqlites[name].exec(schema, (err) => {
					if (err) {
						this.logger.error(`Error initializing base ${name}:`, { schema, err });
					}
				});
			});
		}

		return this.sqlites[name];
	}

	dbRun(dbName, sql, params = []) {
		this.triggerBackupStart();
		const db = this.sqlites[dbName];
		if (!db) {
			return Promise.reject(
				new Error(`Database '${dbName}' not initialized or currently restoring.`)
			);
		}
		return new Promise((resolve, reject) => {
			const self = this;
			db.run(sql, params, function (err) {
				if (err) {
					if (err.message && err.message.includes("SQLITE_CORRUPT")) {
						// Async handle corruption
						self.backupSystem.handleCorruption(dbName, err).catch((e) => {
							self.logger.error(`Failed to handle corruption for ${dbName}:`, e);
						});
					}
					reject(err);
				} else {
					resolve({ lastID: this.lastID, changes: this.changes });
				}
			});
		});
	}

	dbAll(dbName, sql, params = []) {
		const db = this.sqlites[dbName];
		if (!db) {
			return Promise.reject(
				new Error(`Database '${dbName}' not initialized or currently restoring.`)
			);
		}
		return new Promise((resolve, reject) => {
			const self = this;
			db.all(sql, params, function (err, rows) {
				if (err) {
					if (err.message && err.message.includes("SQLITE_CORRUPT")) {
						self.backupSystem.handleCorruption(dbName, err).catch((e) => {
							self.logger.error(`Failed to handle corruption for ${dbName}:`, e);
						});
					}
					reject(err);
				} else resolve(rows);
			});
		});
	}

	dbGet(dbName, sql, params = []) {
		const db = this.sqlites[dbName];
		if (!db) {
			return Promise.reject(
				new Error(`Database '${dbName}' not initialized or currently restoring.`)
			);
		}
		return new Promise((resolve, reject) => {
			const self = this;
			db.get(sql, params, function (err, row) {
				if (err) {
					if (err.message && err.message.includes("SQLITE_CORRUPT")) {
						self.backupSystem.handleCorruption(dbName, err).catch((e) => {
							self.logger.error(`Failed to handle corruption for ${dbName}:`, e);
						});
					}
					reject(err);
				} else resolve(row);
			});
		});
	}

	/**
	 * Run operations inside a transaction on a specific database
	 * @param {string} dbName Database name
	 * @param {Function} callback Async function containing database operations
	 */
	async dbTransaction(dbName, callback) {
		try {
			await this.dbRun(dbName, "BEGIN TRANSACTION");
			const result = await callback();
			await this.dbRun(dbName, "COMMIT");
			return result;
		} catch (error) {
			try {
				await this.dbRun(dbName, "ROLLBACK");
			} catch (rollbackError) {
				this.logger.error(`Failed to rollback ${dbName}:`, rollbackError);
			}
			throw error;
		}
	}
}

module.exports = Database;
