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
	 * All active connections run on disk directly for reliability and RAM safety,
	 * except for transient 'cooldowns' database which is kept in memory.
	 * @param {string} name
	 * @returns {import('better-sqlite3').Database}
	 */
	getConnection(name) {
		if (this.connections[name]) return this.connections[name];

		const sqlitesDir = path.join(this.databasePath, "sqlites");
		if (!fs.existsSync(sqlitesDir)) fs.mkdirSync(sqlitesDir, { recursive: true });

		const dbFile = name === "core" ? "core.db" : `${name}.db`;
		const dbPath = path.join(sqlitesDir, dbFile);

		this.logger.info(
			`[DatabaseMappers] Opening better-sqlite3 connection for '${name}' (disk path: ${dbPath})`
		);

		try {
			const conn = name === "cooldowns" ? new BetterSQLite(":memory:") : new BetterSQLite(dbPath);

			conn.pragma("journal_mode = DELETE");
			conn.pragma("synchronous = FULL"); // Use FULL for strong corruption prevention on disk restarts
			conn.pragma("busy_timeout = 5000");

			// Apply the schema first if we have it in parent Database class
			const schema = this.db.schemas[name];
			if (schema) {
				try {
					conn.exec(schema);
				} catch (schemaErr) {
					// If the schema check fails due to corruption, bubble up to the catch block
					if (
						schemaErr &&
						schemaErr.message &&
						(schemaErr.message.includes("SQLITE_CORRUPT") ||
							schemaErr.message.includes("malformed"))
					) {
						throw schemaErr;
					}
					this.logger.error(`[DatabaseMappers] Error applying schema for '${name}':`, schemaErr);
				}
			}

			this.connections[name] = conn;
			return conn;
		} catch (err) {
			const isCorrupt =
				err &&
				err.message &&
				(err.message.includes("SQLITE_CORRUPT") || err.message.includes("malformed"));
			if (isCorrupt) {
				this.logger.error(
					`[DatabaseMappers] SQLITE_CORRUPT detected on startup for '${name}':`,
					err
				);

				// Safely rename the corrupted file to allow fresh initialization and trigger backup restore
				const corruptPath = `${dbPath}.corrupt-${Date.now()}`;
				if (fs.existsSync(dbPath)) {
					try {
						fs.copyFileSync(dbPath, corruptPath);
						fs.unlinkSync(dbPath);
						this.logger.info(
							`[DatabaseMappers] Saved corrupt file to ${corruptPath} and deleted original.`
						);
					} catch (e) {
						this.logger.error(`[DatabaseMappers] Failed to copy/delete corrupt file: ${e.message}`);
					}
				}

				// Delete WAL, SHM, and journal files to ensure a clean restore
				const walPath = `${dbPath}-wal`;
				const shmPath = `${dbPath}-shm`;
				const journalPath = `${dbPath}-journal`;
				if (fs.existsSync(walPath))
					try {
						fs.unlinkSync(walPath);
					} catch (e) {}
				if (fs.existsSync(shmPath))
					try {
						fs.unlinkSync(shmPath);
					} catch (e) {}
				if (fs.existsSync(journalPath))
					try {
						fs.unlinkSync(journalPath);
					} catch (e) {}

				// Trigger background restore
				if (this.db && this.db.backupSystem) {
					setImmediate(() => {
						this.logger.warn(
							`[DatabaseMappers] Triggering corruption restore for '${name}' in background...`
						);
						this.db.backupSystem.handleCorruption(name, err).catch((e) => {
							this.logger.error(`[DatabaseMappers] Failed recovery for '${name}':`, e);
						});
					});
				}

				// Return a fresh database connection so the bot doesn't crash on boot.
				// Once the background restore is complete, reinitConnection will re-open it cleanly with the restored file.
				this.logger.info(
					`[DatabaseMappers] Initializing fresh temporary database for '${name}' during recovery.`
				);
				const freshConn =
					name === "cooldowns" ? new BetterSQLite(":memory:") : new BetterSQLite(dbPath);

				freshConn.pragma("journal_mode = DELETE");
				freshConn.pragma("synchronous = FULL");
				freshConn.pragma("busy_timeout = 5000");

				const schema = this.db.schemas[name];
				if (schema) {
					try {
						freshConn.exec(schema);
					} catch (schemaErr) {
						this.logger.error(
							`[DatabaseMappers] Error applying schema to fresh database for '${name}':`,
							schemaErr
						);
					}
				}

				this.connections[name] = freshConn;
				return freshConn;
			} else {
				throw err;
			}
		}
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

	/**
	 * Flush a single database to its disk file (No-op since we write directly to disk).
	 * @param {string} name
	 */
	async flushToDisk(name) {
		// No-op since we write directly to disk
	}

	/**
	 * Flush all in-memory databases to disk (No-op since we write directly to disk).
	 */
	async flushAllToDisk() {
		// No-op since we write directly to disk
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
		const res = this.run(name, sql, params);
		return {
			lastID: res.lastInsertRowid,
			lastInsertRowid: res.lastInsertRowid,
			changes: res.changes
		};
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
		const isCorrupt =
			err &&
			((err.message &&
				(err.message.includes("SQLITE_CORRUPT") || err.message.includes("malformed"))) ||
				err.code === "SQLITE_CORRUPT");

		if (isCorrupt) {
			this.logger.error(`[DatabaseMappers] SQLITE_CORRUPT/malformed detected in '${name}':`, err);
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
