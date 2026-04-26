/**
 * DatabaseMappers.js
 *
 * Synchronous better-sqlite3 connection manager.
 * Replaces the async sqlite3 driver internally while keeping Database.js's
 * public API completely unchanged for all callers.
 *
 * Responsibilities:
 *  - Open and cache better-sqlite3 connections per database name
 *  - Enforce WAL mode + PRAGMA settings on every connection
 *  - Track noBackup databases and schemas (for DatabaseBackup compatibility)
 *  - Detect SQLITE_CORRUPT errors and forward to DatabaseBackup.handleCorruption
 *  - Provide synchronous run / get / all helpers
 */

const fs = require("fs");
const path = require("path");
const BetterSQLite = require("better-sqlite3");
const Logger = require("../Logger");

class DatabaseMappers {
	constructor(databaseInstance) {
		/** @type {import('../Database')} Reference to parent Database singleton */
		this.db = databaseInstance;
		this.logger = new Logger("db-mappers");

		this.databasePath = path.join(__dirname, "../../../data");
		this.connections = {}; // name → better-sqlite3 Database instance
	}

	// ---------------------------------------------------------------------------
	// Connection Management
	// ---------------------------------------------------------------------------

	/**
	 * Get (or open) a better-sqlite3 connection by name.
	 * 'core' resolves to core.db; everything else to <name>.db in sqlites/.
	 * @param {string} name
	 * @returns {import('better-sqlite3').Database}
	 */
	getConnection(name) {
		if (this.connections[name]) return this.connections[name];

		const sqlitesDir = path.join(this.databasePath, "sqlites");
		if (!fs.existsSync(sqlitesDir)) fs.mkdirSync(sqlitesDir, { recursive: true });

		const dbFile = name === "core" ? "core.db" : `${name}.db`;
		const dbPath = path.join(sqlitesDir, dbFile);

		this.logger.info(`[DatabaseMappers] Opening '${name}' → ${dbPath}`);

		const conn = new BetterSQLite(dbPath);
		conn.pragma("journal_mode = WAL");
		conn.pragma("synchronous = NORMAL");
		conn.pragma("busy_timeout = 5000");

		this.connections[name] = conn;
		return conn;
	}

	/**
	 * Close and remove a connection (used during corruption recovery).
	 * @param {string} name
	 */
	closeConnection(name) {
		if (this.connections[name]) {
			try {
				this.connections[name].close();
			} catch (e) {
				this.logger.error(`[DatabaseMappers] Error closing '${name}':`, e);
			}
			delete this.connections[name];
		}
	}

	/**
	 * Re-open a connection after recovery (called by DatabaseBackup.reinitConnection).
	 * @param {string} name
	 */
	reopenConnection(name) {
		this.closeConnection(name);
		return this.getConnection(name);
	}

	// ---------------------------------------------------------------------------
	// Core Query Helpers (synchronous)
	// ---------------------------------------------------------------------------

	/**
	 * Execute a write statement (INSERT / UPDATE / DELETE / CREATE …).
	 * @param {string} name - Database name
	 * @param {string} sql
	 * @param {Array|Object} [params=[]]
	 * @returns {{ lastInsertRowid: number, changes: number }}
	 */
	run(name, sql, params = []) {
		try {
			const conn = this.getConnection(name);
			const stmt = conn.prepare(sql);
			return Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
		} catch (err) {
			this._handleError(name, err);
			throw err;
		}
	}

	/**
	 * Fetch a single row.
	 * @param {string} name
	 * @param {string} sql
	 * @param {Array|Object} [params=[]]
	 * @returns {Object|undefined}
	 */
	get(name, sql, params = []) {
		try {
			const conn = this.getConnection(name);
			const stmt = conn.prepare(sql);
			return Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
		} catch (err) {
			this._handleError(name, err);
			throw err;
		}
	}

	/**
	 * Fetch all matching rows.
	 * @param {string} name
	 * @param {string} sql
	 * @param {Array|Object} [params=[]]
	 * @returns {Object[]}
	 */
	all(name, sql, params = []) {
		try {
			const conn = this.getConnection(name);
			const stmt = conn.prepare(sql);
			return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
		} catch (err) {
			this._handleError(name, err);
			throw err;
		}
	}

	/**
	 * Execute multiple statements wrapped in a transaction.
	 * @param {string} name
	 * @param {Function} callback - receives no arguments; use closures for data
	 * @returns {*} Return value of callback
	 */
	transaction(name, callback) {
		try {
			const conn = this.getConnection(name);
			return conn.transaction(callback)();
		} catch (err) {
			this._handleError(name, err);
			throw err;
		}
	}

	/**
	 * Execute a raw SQL string (for schema init / multi-statement exec).
	 * @param {string} name
	 * @param {string} sql
	 */
	exec(name, sql) {
		try {
			const conn = this.getConnection(name);
			conn.exec(sql);
		} catch (err) {
			this._handleError(name, err);
			throw err;
		}
	}

	// ---------------------------------------------------------------------------
	// Async wrappers — keeps Database.js's existing async API compatible
	// ---------------------------------------------------------------------------

	/**
	 * Async-wrapped run (for Database.js compatibility).
	 */
	async asyncRun(name, sql, params = []) {
		return this.run(name, sql, params);
	}

	/**
	 * Async-wrapped get.
	 */
	async asyncGet(name, sql, params = []) {
		return this.get(name, sql, params);
	}

	/**
	 * Async-wrapped all.
	 */
	async asyncAll(name, sql, params = []) {
		return this.all(name, sql, params);
	}

	// ---------------------------------------------------------------------------
	// Error Handling
	// ---------------------------------------------------------------------------

	/**
	 * Detect SQLITE_CORRUPT and forward to the backup system.
	 * @param {string} name
	 * @param {Error} err
	 */
	_handleError(name, err) {
		if (err && err.message && err.message.includes("SQLITE_CORRUPT")) {
			this.logger.error(`[DatabaseMappers] SQLITE_CORRUPT in '${name}':`, err);
			// Forward asynchronously so we don't block the sync call stack
			if (this.db && this.db.backupSystem) {
				setImmediate(() => {
					this.db.backupSystem.handleCorruption(name, err).catch((e) => {
						this.logger.error(`[DatabaseMappers] Failed to handle corruption for '${name}':`, e);
					});
				});
			}
		}
	}
}

module.exports = DatabaseMappers;
