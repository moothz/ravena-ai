const fs = require("fs");
const path = require("path");
const Logger = require("./Logger");
const sqlite3 = require("sqlite3").verbose();
const DatabaseBackup = require("./DatabaseBackup");
const DatabaseMappers = require("./db/DatabaseMappers");
const CoreRepository = require("./db/repositories/CoreRepository");

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

		// --- New layer: better-sqlite3 connection manager + repositories ---
		this.mappers = new DatabaseMappers(this);
		this.coreRepo = new CoreRepository(this.mappers);

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
			whatsgo: new Set(),
			whatsgo_go: new Set()
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

		// Minimal schema for restoring backups if core.db is missing.
		// Real schema maintenance is handled by CoreRepository.js using better-sqlite3.
		this.coreDb.serialize(() => {
			const tables = [
				`CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, json_data TEXT)`,
				`CREATE TABLE IF NOT EXISTS donations (name TEXT PRIMARY KEY, json_data TEXT)`,
				`CREATE TABLE IF NOT EXISTS pending_joins (code TEXT PRIMARY KEY, json_data TEXT)`,
				`CREATE TABLE IF NOT EXISTS soft_blocks (number TEXT PRIMARY KEY, json_data TEXT)`,
				`CREATE TABLE IF NOT EXISTS blocked_invites (id INTEGER PRIMARY KEY AUTOINCREMENT, json_data TEXT)`
			];
			this.schemas["core"] = tables.join("; ");
			tables.forEach((sql) => this.coreDb.run(sql));
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
		return this.coreRepo.getGroups();
	}
	async getGroup(groupId) {
		return this.coreRepo.getGroup(groupId);
	}
	async getGroupByName(groupName) {
		return this.coreRepo.getGroupByName(groupName);
	}
	async saveGroup(group) {
		this.triggerBackupStart();
		return this.coreRepo.saveGroup(group);
	}

	// --- Custom Commands ---

	async getCustomCommands(groupId) {
		return this.coreRepo.getCustomCommands(groupId);
	}
	async saveCustomCommand(groupId, command) {
		this.triggerBackupStart();
		return this.coreRepo.saveCustomCommand(groupId, command);
	}
	async updateCustomCommand(groupId, command) {
		return this.coreRepo.updateCustomCommand(groupId, command);
	}
	async deleteCustomCommand(groupId, commandStart) {
		return this.coreRepo.deleteCustomCommand(groupId, commandStart);
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
		return this.coreRepo.getLoadReports(since);
	}
	async saveLoadReports(reports) {
		this.triggerBackupStart();
		return this.coreRepo.saveLoadReports(reports);
	}
	async addLoadReport(report) {
		this.triggerBackupStart();
		return this.coreRepo.addLoadReport(report);
	}

	// --- Donations ---

	async getDonations() {
		return this.coreRepo.getDonations();
	}
	async saveDonations(donations) {
		this.triggerBackupStart();
		return this.coreRepo.saveDonations(donations);
	}
	async addDonation(name, amount, numero = undefined) {
		this.triggerBackupStart();
		return this.coreRepo.addDonation(name, amount, numero);
	}
	async updateDonorNumber(name, numero) {
		this.triggerBackupStart();
		return this.coreRepo.updateDonorNumber(name, numero);
	}
	async updateDonationAmount(name, amount) {
		this.triggerBackupStart();
		return this.coreRepo.updateDonationAmount(name, amount);
	}
	async mergeDonors(targetName, sourceName) {
		this.triggerBackupStart();
		return this.coreRepo.mergeDonors(targetName, sourceName);
	}

	// --- Pending Joins ---

	async getPendingJoins() {
		return this.coreRepo.getPendingJoins();
	}
	async savePendingJoins(joins) {
		this.triggerBackupStart();
		return this.coreRepo.savePendingJoins(joins);
	}
	async savePendingJoin(inviteCode, data) {
		this.triggerBackupStart();
		return this.coreRepo.savePendingJoin(inviteCode, data);
	}
	async removePendingJoin(inviteCode) {
		this.triggerBackupStart();
		return this.coreRepo.removePendingJoin(inviteCode);
	}

	// --- Soft Blocks ---

	async getSoftblocks() {
		return this.coreRepo.getSoftblocks();
	}
	async toggleUserInvites(phoneNumber, block) {
		this.triggerBackupStart();
		return this.coreRepo.toggleUserInvites(phoneNumber, block);
	}
	async isUserInviteBlocked(phoneNumber) {
		return this.coreRepo.isUserInviteBlocked(phoneNumber);
	}

	// --- Local Blocks ---

	async addLocalBlock(phoneNumber) {
		this.triggerBackupStart();
		return this.coreRepo.addLocalBlock(phoneNumber);
	}
	async removeLocalBlock(phoneNumber) {
		this.triggerBackupStart();
		return this.coreRepo.removeLocalBlock(phoneNumber);
	}
	async isLocalBlocked(phoneNumber) {
		return this.coreRepo.isLocalBlocked(phoneNumber);
	}
	async getLocalBlocks() {
		return this.coreRepo.getLocalBlocks();
	}

	// --- Blocked Invites ---

	async saveBlockedInvite(code, jid) {
		this.triggerBackupStart();
		return this.coreRepo.saveBlockedInvite(code, jid);
	}
	async isInviteBlocked(code, jid) {
		return this.coreRepo.isInviteBlocked(code, jid);
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
