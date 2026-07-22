const fs = require("fs");
const path = require("path");
const Logger = require("./Logger");
const sqlite3 = require("sqlite3").verbose();
const DatabaseBackup = require("./DatabaseBackup");
const DatabaseMappers = require("./db/DatabaseMappers");
const CoreRepository = require("./db/repositories/CoreRepository");

/**
 * Mock wrapper that mimics sqlite3 Database API but executes synchronously on Better-SQLite3 connection.
 * It translates callback-based asynchronous methods to synchronous ones, avoiding dual connection locking.
 */
class Sqlite3MockWrapper {
	constructor(name, mappers) {
		this.name = name;
		this.mappers = mappers;
	}

	run(sql, params, cb) {
		if (typeof params === "function") {
			cb = params;
			params = [];
		}
		try {
			const res = this.mappers.run(this.name, sql, params || []);
			if (cb) {
				const ctx = {
					lastID: res.lastInsertRowid,
					changes: res.changes
				};
				cb.call(ctx, null);
			}
		} catch (e) {
			if (cb) cb(e);
		}
	}

	all(sql, params, cb) {
		if (typeof params === "function") {
			cb = params;
			params = [];
		}
		try {
			const rows = this.mappers.all(this.name, sql, params || []);
			if (cb) cb(null, rows);
		} catch (e) {
			if (cb) cb(e);
		}
	}

	get(sql, params, cb) {
		if (typeof params === "function") {
			cb = params;
			params = [];
		}
		try {
			const row = this.mappers.get(this.name, sql, params || []);
			if (cb) cb(null, row);
		} catch (e) {
			if (cb) cb(e);
		}
	}

	exec(sql, cb) {
		try {
			this.mappers.exec(this.name, sql);
			if (cb) cb(null);
		} catch (e) {
			if (cb) cb(e);
		}
	}

	serialize(fn) {
		if (fn) fn();
	}

	close(cb) {
		if (cb) cb(null);
	}
}

/**
 * Singleton Database class using SQLite backend with JSON storage (Hybrid approach)
 */
class Database {
	constructor(options = {}) {
		this.options = options;
		this.testMode = options.testMode ?? false;
		this.logger = new Logger("database");
		this.databasePath = path.join(__dirname, "../../data");
		this.backupPath = path.join(__dirname, "../../data/backups");

		this.sqlites = {}; // Cache for other sqlite connections (like 'pinto')
		this.noBackupDatabases = new Set(); // Track databases that should not be backed up
		this.schemas = {}; // Store schemas for restoration
		this.coreDb = null; // Main database connection

		// Cache for custom variables file
		this.customVariablesCache = null;

		// --- New layer: better-sqlite3 connection manager + repositories ---
		this.mappers = new DatabaseMappers(this);
		this.coreRepo = new CoreRepository(this.mappers);

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
			whatsgo: new Set(),
			whatsgo_go: new Set()
		};

		// Setup cleanup handlers
		this.setupCleanupHandlers();

		// Setup hourly flush to disk
		this.setupHourlyFlush();

		this.backupStarted = false;
		this.lastScheduledBackup = this.getLastScheduledBackupTime();

		// Queue for transactions to prevent concurrent transactions on the same connection
		this.transactionQueues = new Map();

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

	/**
	 * Close all database connections to release the event loop.
	 * Use this at the end of test scripts or CLI tools to allow process.exit().
	 */
	closeAll() {
		try {
			if (this.flushInterval) {
				clearInterval(this.flushInterval);
				this.flushInterval = null;
			}
			if (this.coreDb) {
				this.coreDb.close();
				this.coreDb = null;
			}
		} catch (e) {
			this.logger.error("[closeAll] Error closing coreDb:", e);
		}

		try {
			Object.values(this.sqlites).forEach((db) => {
				try {
					db.close();
				} catch (e) {}
			});
			this.sqlites = {};
		} catch (e) {
			this.logger.error("[closeAll] Error closing sqlite dbs:", e);
		}

		try {
			// Close all better-sqlite3 connections in DatabaseMappers
			if (this.mappers && this.mappers.connections) {
				Object.keys(this.mappers.connections).forEach((name) => {
					try {
						this.mappers.closeConnection(name);
					} catch (e) {}
				});
			}
		} catch (e) {
			this.logger.error("[closeAll] Error closing mapper connections:", e);
		}

		this.logger.info("[closeAll] All database connections closed.");
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
		// Real schema maintenance is handled by CoreRepository.js using better-sqlite3.
		this.schemas["core"] = [
			`CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, json_data TEXT)`,
			`CREATE TABLE IF NOT EXISTS donations (name TEXT PRIMARY KEY, json_data TEXT)`,
			`CREATE TABLE IF NOT EXISTS pending_joins (code TEXT PRIMARY KEY, json_data TEXT)`,
			`CREATE TABLE IF NOT EXISTS soft_blocks (number TEXT PRIMARY KEY, json_data TEXT)`,
			`CREATE TABLE IF NOT EXISTS blocked_invites (id INTEGER PRIMARY KEY AUTOINCREMENT, json_data TEXT)`
		].join("; ");

		this.coreDb = new Sqlite3MockWrapper("core", this.mappers);

		// Apply core schemas via mappers
		this.mappers.exec("core", this.schemas["core"]);
	}

	setupCleanupHandlers() {
		// Signal listeners removed to prevent duplicate racing handlers.
		// Main cleanup is now driven sequentially by index.js on shutdown.
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
	/**
	 * Run a SQL query on the core database
	 */
	async run(sql, params = []) {
		if (this.testMode) {
			this.logger.debug("[TestMode] run() bloqueado");
			return { lastID: 0, changes: 0 };
		}
		this.triggerBackupStart();
		return this.mappers.asyncRun("core", sql, params);
	}

	/**
	 * Get all rows from the core database
	 */
	async all(sql, params = []) {
		return this.mappers.asyncAll("core", sql, params);
	}

	/**
	 * Get a single row from the core database
	 */
	async get(sql, params = []) {
		return this.mappers.asyncGet("core", sql, params);
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
		if (this.testMode) {
			this.logger.debug("[TestMode] saveGroup() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.saveGroup(group);
	}

	/**
	 * Lightweight update: persists only the `interact` field of a group.
	 * Synchronous under the hood (better-sqlite3).
	 */
	updateGroupInteract(groupId, interact) {
		if (this.testMode) return true;
		return this.coreRepo.updateGroupInteract(groupId, interact);
	}

	// --- Custom Commands ---

	async getCustomCommands(groupId) {
		return this.coreRepo.getCustomCommands(groupId);
	}
	async saveCustomCommand(groupId, command) {
		if (this.testMode) {
			this.logger.debug("[TestMode] saveCustomCommand() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.saveCustomCommand(groupId, command);
	}
	async updateCustomCommand(groupId, command) {
		if (this.testMode) {
			this.logger.debug("[TestMode] updateCustomCommand() bloqueado");
			return true;
		}
		return this.coreRepo.updateCustomCommand(groupId, command);
	}
	async deleteCustomCommand(groupId, commandStart) {
		if (this.testMode) {
			this.logger.debug("[TestMode] deleteCustomCommand() bloqueado");
			return true;
		}
		return this.coreRepo.deleteCustomCommand(groupId, commandStart);
	}

	async getCustomVariables() {
		if (this.customVariablesCache) {
			return this.customVariablesCache;
		}
		try {
			const filePath = path.join(this.databasePath, "custom-variables.json");
			if (fs.existsSync(filePath)) {
				this.customVariablesCache = JSON.parse(fs.readFileSync(filePath, "utf8"));
				return this.customVariablesCache;
			}
			this.customVariablesCache = {};
			return this.customVariablesCache;
		} catch (error) {
			this.logger.error("Error getting custom variables:", error);
			return {};
		}
	}

	async saveCustomVariables(variables) {
		this.customVariablesCache = variables;
		if (this.testMode) {
			this.logger.debug("[TestMode] saveCustomVariables() bloqueado");
			return true;
		}
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

	async getAggregatedLoadReports(since = 0) {
		return this.coreRepo.getAggregatedLoadReports(since);
	}

	async saveLoadReports(reports) {
		if (this.testMode) {
			this.logger.debug("[TestMode] saveLoadReports() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.saveLoadReports(reports);
	}

	async addLoadReport(report) {
		if (this.testMode) {
			this.logger.debug("[TestMode] addLoadReport() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.addLoadReport(report);
	}

	// --- Donations ---

	async getDonations() {
		return this.coreRepo.getDonations();
	}
	async saveDonations(donations) {
		if (this.testMode) {
			this.logger.debug("[TestMode] saveDonations() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.saveDonations(donations);
	}
	async addDonation(name, amount, numero = undefined) {
		if (this.testMode) {
			this.logger.debug("[TestMode] addDonation() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.addDonation(name, amount, numero);
	}
	async updateDonorNumber(name, numero) {
		if (this.testMode) {
			this.logger.debug("[TestMode] updateDonorNumber() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.updateDonorNumber(name, numero);
	}
	async updateDonationAmount(name, amount) {
		if (this.testMode) {
			this.logger.debug("[TestMode] updateDonationAmount() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.updateDonationAmount(name, amount);
	}
	async mergeDonors(targetName, sourceName) {
		if (this.testMode) {
			this.logger.debug("[TestMode] mergeDonors() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.mergeDonors(targetName, sourceName);
	}

	// --- Pending Joins ---

	async getPendingJoins() {
		return this.coreRepo.getPendingJoins();
	}
	async savePendingJoins(joins) {
		if (this.testMode) {
			this.logger.debug("[TestMode] savePendingJoins() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.savePendingJoins(joins);
	}
	async savePendingJoin(inviteCode, data) {
		if (this.testMode) {
			this.logger.debug("[TestMode] savePendingJoin() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.savePendingJoin(inviteCode, data);
	}
	async removePendingJoin(inviteCode) {
		if (this.testMode) {
			this.logger.debug("[TestMode] removePendingJoin() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.removePendingJoin(inviteCode);
	}

	// --- Soft Blocks ---

	async getSoftblocks() {
		return this.coreRepo.getSoftblocks();
	}
	async toggleUserInvites(phoneNumber, block) {
		if (this.testMode) {
			this.logger.debug("[TestMode] toggleUserInvites() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.toggleUserInvites(phoneNumber, block);
	}
	async isUserInviteBlocked(phoneNumber) {
		return this.coreRepo.isUserInviteBlocked(phoneNumber);
	}

	// --- Local Blocks ---

	async addLocalBlock(phoneNumber) {
		if (this.testMode) {
			this.logger.debug("[TestMode] addLocalBlock() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.addLocalBlock(phoneNumber);
	}
	async removeLocalBlock(phoneNumber) {
		if (this.testMode) {
			this.logger.debug("[TestMode] removeLocalBlock() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.removeLocalBlock(phoneNumber);
	}
	async isLocalBlocked(phoneNumber) {
		return this.coreRepo.isLocalBlocked(phoneNumber);
	}
	async getLocalBlocks() {
		return this.coreRepo.getLocalBlocks();
	}

	// --- Invite History ---

	async addInviteHistory(invite) {
		if (this.testMode) {
			this.logger.debug("[TestMode] addInviteHistory() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.addInviteHistory(invite);
	}

	async getInviteHistoryByAuthor(authorId) {
		return this.coreRepo.getInviteHistoryByAuthor(authorId);
	}

	async getInviteHistoryByGroup(groupJid, inviteCode) {
		return this.coreRepo.getInviteHistoryByGroup(groupJid, inviteCode);
	}

	async saveInviteHistories(invites) {
		if (this.testMode) {
			this.logger.debug("[TestMode] saveInviteHistories() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.saveInviteHistories(invites);
	}

	// --- Group Membership Periods ---

	async recordGroupJoin(groupJid, groupName, timestamp, responsible) {
		if (this.testMode) {
			this.logger.debug("[TestMode] recordGroupJoin() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.recordGroupJoin(groupJid, groupName, timestamp, responsible);
	}

	async recordGroupLeave(groupJid, timestamp, responsible) {
		if (this.testMode) {
			this.logger.debug("[TestMode] recordGroupLeave() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.recordGroupLeave(groupJid, timestamp, responsible);
	}

	async getGroupMembershipPeriods(groupJid) {
		return this.coreRepo.getGroupMembershipPeriods(groupJid);
	}

	async saveGroupMembershipPeriods(periods) {
		if (this.testMode) {
			this.logger.debug("[TestMode] saveGroupMembershipPeriods() bloqueado");
			return true;
		}
		this.triggerBackupStart();
		return this.coreRepo.saveGroupMembershipPeriods(periods);
	}

	// --- Blocked Invites ---

	async saveBlockedInvite(code, jid) {
		if (this.testMode) {
			this.logger.debug("[TestMode] saveBlockedInvite() bloqueado");
			return true;
		}
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
		if (this.testMode) {
			this.logger.debug("[TestMode] saveJSONToFile() bloqueado:", filePath);
			return true;
		}
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

			// Initialize database schema in memory via mappers
			this.mappers.exec(name, schema);

			// Return mock wrapper for compatibility
			this.sqlites[name] = new Sqlite3MockWrapper(name, this.mappers);
		}

		return this.sqlites[name];
	}

	async dbRun(dbName, sql, params = []) {
		if (this.testMode) {
			this.logger.debug("[TestMode] dbRun() bloqueado:", dbName);
			return { lastID: 0, changes: 0 };
		}
		this.triggerBackupStart();
		return this.mappers.asyncRun(dbName, sql, params);
	}

	async dbAll(dbName, sql, params = []) {
		return this.mappers.asyncAll(dbName, sql, params);
	}

	async dbGet(dbName, sql, params = []) {
		return this.mappers.asyncGet(dbName, sql, params);
	}

	/**
	 * Run operations inside a transaction on a specific database
	 * @param {string} dbName Database name
	 * @param {Function} callback Async function containing database operations
	 */
	async dbTransaction(dbName, callback) {
		// Initialize queue for this database if it doesn't exist
		if (!this.transactionQueues.has(dbName)) {
			this.transactionQueues.set(dbName, Promise.resolve());
		}

		// Get the current head of the queue
		const currentQueue = this.transactionQueues.get(dbName);

		// Create the next task in the queue
		const nextTask = (async () => {
			// Wait for the previous task to complete
			await currentQueue;

			let transactionStarted = false;
			try {
				await this.dbRun(dbName, "BEGIN TRANSACTION");
				transactionStarted = true;

				const result = await callback();

				await this.dbRun(dbName, "COMMIT");
				transactionStarted = false;
				return result;
			} catch (error) {
				if (transactionStarted) {
					try {
						await this.dbRun(dbName, "ROLLBACK");
					} catch (rollbackError) {
						// Only log if it's not the "no transaction is active" error which is expected if BEGIN failed
						if (
							!rollbackError.message ||
							!rollbackError.message.includes("no transaction is active")
						) {
							this.logger.error(`Failed to rollback ${dbName}:`, rollbackError);
						}
					}
				}
				throw error;
			}
		})();

		// Update the queue head (and catch errors so the queue doesn't stay blocked)
		this.transactionQueues.set(
			dbName,
			nextTask.catch(() => {})
		);

		return nextTask;
	}

	setupHourlyFlush() {
		this.flushInterval = setInterval(
			async () => {
				try {
					await this.flushAllToDisk();
				} catch (error) {
					this.logger.error("Error in hourly flush:", error);
				}
			},
			60 * 60 * 1000
		); // 1 hour
	}

	async flushAllToDisk() {
		this.logger.info("Flushing all in-memory databases to disk...");
		if (this.mappers) {
			await this.mappers.flushAllToDisk();
		}
		this.logger.info("Flush completed.");
	}
}

Database.Sqlite3MockWrapper = Sqlite3MockWrapper;

module.exports = Database;
