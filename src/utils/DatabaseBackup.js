const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const BetterSQLite = require("better-sqlite3");
const Logger = require("./Logger");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const storageService = require("../services/StorageService");

class DatabaseBackup {
	constructor(databaseInstance) {
		this.db = databaseInstance;
		this.logger = new Logger("database-backup");

		this.databasePath = path.join(__dirname, "../../data");
		this.backupPath = path.join(__dirname, "../../data/backups");

		this.maxBackups = parseInt(process.env.MAX_BACKUPS) || 120;
		this.backupRetentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS) || 30;
		// Compacta os .db de cada backup em .db.gz (a restauracao aceita os dois formatos)
		this.backupGzip = process.env.BACKUP_GZIP === "true";

		// Remote Backup Config
		this.remoteEnabled = process.env.SQLITE_REMOTE_BACKUP === "true";
		this.remoteServers = process.env.SQLITE_REMOTE_SERVERS
			? process.env.SQLITE_REMOTE_SERVERS.split(",")
			: [];

		this.backupIgnoreFiles = ["cache.db"];
		this.backupTargets = [path.join(this.databasePath, "sqlites")];

		this.remoteBackupInterval =
			(parseInt(process.env.REMOTE_BACKUP_INTERVAL_MINUTES) || 30) * 60 * 1000;

		this.recoveringDbs = new Set();
	}

	shouldIgnoreFile(filename) {
		if (this.backupIgnoreFiles.includes(filename)) return true;
		if (filename === "cache.db" || filename.startsWith("cache.db-")) return true;
		if (filename.includes("corrupt") || filename.includes("corrupted")) return true;
		if (filename.endsWith("-wal") || filename.endsWith("-shm")) return true;

		// Ignore databases flagged as noBackup (and their companion files like -wal, -shm)
		if (this.db && this.db.noBackupDatabases) {
			for (const noBackupDb of this.db.noBackupDatabases) {
				const prefix = `${noBackupDb}.db`;
				if (filename === prefix || filename.startsWith(`${prefix}-`)) {
					return true;
				}
			}
		}

		return false;
	}

	async createScheduledBackup() {
		try {
			const now = new Date();
			const timestamp = now.toISOString().replace(/[:.]/g, "-");
			const backupDir = path.join(this.backupPath, timestamp);

			if (!fs.existsSync(backupDir)) {
				fs.mkdirSync(backupDir, { recursive: true });
			}

			const backedUpFiles = new Set();

			// 1. Safe SQLite Backups for active better-sqlite3 connections
			if (this.db.mappers && this.db.mappers.connections) {
				const destSqlitesDir = path.join(backupDir, "sqlites");
				if (!fs.existsSync(destSqlitesDir)) {
					fs.mkdirSync(destSqlitesDir, { recursive: true });
				}

				for (const [name, conn] of Object.entries(this.db.mappers.connections)) {
					if (
						name === "cooldowns" ||
						name === "cache" ||
						name.includes("corrupt") ||
						name.includes("corrupted") ||
						(this.db.noBackupDatabases && this.db.noBackupDatabases.has(name))
					) {
						continue;
					}
					try {
						const dbFile = name === "core" ? "core.db" : `${name}.db`;
						const destPath = path.join(destSqlitesDir, dbFile);

						// Perform a safe SQLite online backup of the live database connection
						await conn.backup(destPath);
						backedUpFiles.add(dbFile);
						this.logger.info(`Safe online backup created for connection '${name}' to ${destPath}`);
					} catch (backupErr) {
						this.logger.error(`Failed to create safe online backup for '${name}':`, backupErr);
					}
				}
			}

			// 2. Fallback: Copy any other database files not currently open
			for (const target of this.backupTargets) {
				if (fs.existsSync(target)) {
					const dest = path.join(backupDir, path.basename(target));
					if (!fs.existsSync(dest)) {
						fs.mkdirSync(dest, { recursive: true });
					}

					const items = fs.readdirSync(target);
					for (const item of items) {
						if (backedUpFiles.has(item)) continue; // Already backed up safely
						// -wal/-shm/-journal de bancos ja copiados via backup online ja estao incluidos nele
						if (backedUpFiles.has(item.replace(/-(wal|shm|journal)$/, ""))) continue;
						this.backupDirectory(path.join(target, item), path.join(dest, item));
					}
				}
			}

			if (this.backupGzip) await this.compressBackupDir(path.join(backupDir, "sqlites"));

			this.logger.info(`File backup created: ${backupDir}`);

			// Sincroniza snapshot com o S3 (bucket backups no HD secundário)
			try {
				const destSqlitesDir = path.join(backupDir, "sqlites");
				if (fs.existsSync(destSqlitesDir)) {
					const filesToUpload = fs.readdirSync(destSqlitesDir);
					for (const file of filesToUpload) {
						const filePath = path.join(destSqlitesDir, file);
						const s3Key = `sqlite/${timestamp}/${file}`;
						await storageService.upload(fs.createReadStream(filePath), s3Key, {
							bucket: storageService.bucketBackups,
							mimetype: file.endsWith(".gz") ? "application/gzip" : "application/x-sqlite3"
						});
					}
					this.logger.info(
						`[S3 Backup] ${filesToUpload.length} bancos de dados sincronizados para s3://${storageService.bucketBackups}/sqlite/${timestamp}/`
					);
				}
			} catch (s3BackupErr) {
				this.logger.warn("[S3 Backup] Falha ao enviar backup ao S3:", s3BackupErr.message);
			}

			this.cleanupOldScheduledBackups();

			// Arquiva relatórios antigos com mais de 30 dias automaticamente
			await this.db.archiveOldLoadReports(30).catch((err) => {
				this.logger.error("Erro ao arquivar relatórios antigos durante backup:", err);
			});

			return true;
		} catch (error) {
			this.logger.error("Error creating scheduled backup:", error);
			return false;
		}
	}

	startRemoteBackupInterval() {
		if (!this.remoteEnabled) return;

		this.logger.info(
			`Starting remote backup interval: every ${this.remoteBackupInterval / 60000} minutes.`
		);

		// Delay the first remote backup by 5 minutes so the bot is fully settled
		// before hitting the remote server. Writes at startup no longer trigger
		// an instant sync.
		const INITIAL_DELAY_MS = 5 * 60 * 1000;
		this.logger.info(`Remote backup first run in ${INITIAL_DELAY_MS / 60000} minutes.`);

		setTimeout(() => {
			this.runRemoteBackup().catch((err) => {
				this.logger.error("Initial remote backup failed:", err);
			});

			setInterval(async () => {
				await this.runRemoteBackup().catch((err) => {
					this.logger.error("Periodic remote backup failed:", err);
				});
			}, this.remoteBackupInterval);
		}, INITIAL_DELAY_MS);
	}

	backupDirectory(source, target) {
		try {
			const baseName = path.basename(source);
			if (this.shouldIgnoreFile(baseName)) return;

			const stats = fs.statSync(source);
			if (stats.isDirectory()) {
				if (!fs.existsSync(target)) {
					fs.mkdirSync(target, { recursive: true });
				}
				const items = fs.readdirSync(source);
				for (const item of items) {
					this.backupDirectory(path.join(source, item), path.join(target, item));
				}
			} else if (stats.isFile()) {
				fs.copyFileSync(source, target);
			}
		} catch (error) {
			this.logger.error(`Error backing up ${source}:`, error);
		}
	}

	/**
	 * Compacta com gzip todos os arquivos .db de um diretório de backup (remove o original).
	 * Se a compactação de um arquivo falhar, o original é mantido.
	 */
	async compressBackupDir(dir) {
		if (!fs.existsSync(dir)) return;
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith(".db")) continue;
			const src = path.join(dir, file);
			const dest = `${src}.gz`;
			try {
				await pipeline(
					fs.createReadStream(src),
					zlib.createGzip({ level: 9 }),
					fs.createWriteStream(dest)
				);
				fs.unlinkSync(src);
			} catch (e) {
				this.logger.error(`Failed to compress backup ${src}:`, e);
				try {
					fs.unlinkSync(dest);
				} catch {}
			}
		}
	}

	cleanupOldScheduledBackups() {
		try {
			const now = Date.now();
			const retentionPeriod = this.backupRetentionDays * 24 * 60 * 60 * 1000;

			const backupDirs = this.getSortedLocalBackups();

			if (backupDirs.length > this.maxBackups) {
				const dirsToDelete = backupDirs.slice(this.maxBackups);
				for (const dir of dirsToDelete) {
					// We still need to check date for retention
					const dirDate = new Date(
						dir.name.replace(/-/g, (m, i) =>
							i === 4 || i === 7 || i === 10 ? m : i === 13 || i === 16 ? ":" : i === 19 ? "." : m
						)
					).getTime();

					if (isNaN(dirDate) || now - dirDate > retentionPeriod) {
						this.deleteDirectory(dir.path);
						this.logger.info(`Old backup removed: ${dir.name}`);
					}
				}
			}
		} catch (error) {
			this.logger.error("Error cleaning up old backups:", error);
		}
	}

	/**
	 * Localiza o arquivo de um banco dentro de um backup (.db.gz ou .db legado) e
	 * devolve um caminho de arquivo SQLite legível (descompacta para um temporário se preciso).
	 * @returns {{ filePath: string, temporary: boolean } | null}
	 */
	async resolveBackupFile(backupPath, dbFile) {
		const raw = path.join(backupPath, "sqlites", dbFile);
		const gz = `${raw}.gz`;
		if (fs.existsSync(gz)) {
			const tmp = path.join(this.backupPath, `.restore-${process.pid}-${dbFile}`);
			try {
				await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(tmp));
				return { filePath: tmp, temporary: true };
			} catch (e) {
				this.logger.warn(`Failed to decompress ${gz}: ${e.message}`);
				try {
					fs.unlinkSync(tmp);
				} catch {}
				return null;
			}
		}
		if (fs.existsSync(raw)) return { filePath: raw, temporary: false };
		return null;
	}

	getSortedLocalBackups() {
		if (!fs.existsSync(this.backupPath)) return [];
		return fs
			.readdirSync(this.backupPath)
			.filter((item) => {
				const fullPath = path.join(this.backupPath, item);
				return (
					fs.statSync(fullPath).isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/.test(item)
				);
			})
			.map((dir) => ({
				name: dir,
				path: path.join(this.backupPath, dir)
			}))
			.sort((a, b) => b.name.localeCompare(a.name));
	}

	deleteDirectory(dirPath) {
		try {
			if (fs.existsSync(dirPath)) {
				const items = fs.readdirSync(dirPath);
				for (const item of items) {
					const itemPath = path.join(dirPath, item);
					if (fs.statSync(itemPath).isDirectory()) {
						this.deleteDirectory(itemPath);
					} else {
						fs.unlinkSync(itemPath);
					}
				}
				fs.rmdirSync(dirPath);
			}
		} catch (error) {
			this.logger.error(`Error deleting directory ${dirPath}:`, error);
		}
	}

	// --- Remote SQL Backup ---

	async runRemoteBackup() {
		this.logger.info(`Starting remote SQL backup to ${this.remoteServers.length} servers...`);
		for (const serverUri of this.remoteServers) {
			try {
				const serverDisplay = serverUri.includes("@")
					? serverUri.split("@")[1]
					: serverUri.split("/")[2];
				this.logger.info(`Connecting to remote server: ${serverDisplay}`);
				const connection = await mysql.createConnection(serverUri);
				this.logger.info("Connection established. Starting sync...");
				await this.syncAllDatabases(connection);
				await connection.end();
				this.logger.info(`Remote backup successful for ${serverDisplay}`);
			} catch (error) {
				this.logger.error(`Failed to backup to ${serverUri}:`, error);
			}
		}
	}

	async syncAllDatabases(remoteConn) {
		// 1. Sync Core DB
		this.logger.info("Syncing Core Database...");
		await this.syncCoreDatabase(remoteConn);

		// 2. Sync other SQLite databases
		const sqlitesDir = path.join(this.databasePath, "sqlites");
		const sqliteFiles = fs
			.readdirSync(sqlitesDir)
			.filter((f) => f.endsWith(".db") && f !== "core.db" && !this.shouldIgnoreFile(f));

		this.logger.info(`Found ${sqliteFiles.length} additional SQLite databases to sync.`);

		for (const file of sqliteFiles) {
			const dbName = file.replace(".db", "");
			if (this.db.noBackupDatabases && this.db.noBackupDatabases.has(dbName)) {
				this.logger.debug(`Skipping ${dbName} (no-backup flag set)`);
				continue;
			}
			this.logger.info(`Syncing database: ${dbName}`);
			await this.syncGenericSQLite(dbName, remoteConn);
		}
	}

	async syncCoreDatabase(remoteConn) {
		const tables = [
			{ name: "groups", pk: ["id"] },
			{ name: "donations", pk: ["name"] },
			{ name: "pending_joins", pk: ["code"] },
			{ name: "soft_blocks", pk: ["number"] }
		];

		for (const table of tables) {
			this.logger.debug(`Core: Syncing table ${table.name}...`);
			await this.syncTable(this.db.coreDb, table.name, table.pk, remoteConn);
		}
	}

	async syncGenericSQLite(dbName, remoteConn) {
		try {
			let db = this.db.sqlites[dbName];

			// If not currently loaded in memory, open it temporarily
			let temporaryDb = null;
			if (!db) {
				const dbPath = path.join(this.databasePath, "sqlites", `${dbName}.db`);
				if (!fs.existsSync(dbPath)) return;
				temporaryDb = new BetterSQLite(dbPath, { readonly: true, timeout: 5000 });
				db = temporaryDb;
			}

			const tables = await this.getTables(db);
			this.logger.debug(`DB '${dbName}': Found ${tables.length} tables.`);

			for (const tableName of tables) {
				if (tableName.startsWith("sqlite_")) continue;
				const pks = await this.getPrimaryKeys(db, tableName);
				this.logger.debug(`DB '${dbName}': Syncing table ${tableName}...`);
				await this.syncTable(db, tableName, pks, remoteConn);
			}

			if (temporaryDb) temporaryDb.close();
		} catch (error) {
			this.logger.error(`Error syncing database ${dbName}:`, error);
		}
	}

	/**
	 * Executa um SELECT em uma conexão better-sqlite3 pura ou no Sqlite3MockWrapper
	 * (que delega para as conexões gerenciadas pelo DatabaseMappers).
	 */
	queryAll(db, sql, params = []) {
		if (db.mappers) return db.mappers.all(db.name, sql, params);
		return db.prepare(sql).all(...params);
	}

	async getTables(db) {
		return this.queryAll(db, "SELECT name FROM sqlite_master WHERE type='table'").map(
			(r) => r.name
		);
	}

	async getPrimaryKeys(db, tableName) {
		const rows = this.queryAll(db, `PRAGMA table_info(${tableName})`);
		const pks = rows
			.filter((r) => r.pk > 0)
			.sort((a, b) => a.pk - b.pk)
			.map((r) => r.name);
		return pks.length > 0 ? pks : ["rowid"];
	}

	async syncTable(sqliteDb, tableName, pks, remoteConn) {
		try {
			const createSql = await this.getRemoteCreateStatement(sqliteDb, tableName, pks);
			await remoteConn.execute(createSql);

			const rows = this.queryAll(sqliteDb, `SELECT * FROM ${tableName}`);

			if (rows.length === 0) {
				this.logger.debug(`Table ${tableName}: No rows to sync.`);
				return;
			}

			this.logger.info(`Table ${tableName}: Syncing ${rows.length} rows...`);

			const chunks = this.chunkArray(rows, 500);
			let processed = 0;
			for (const chunk of chunks) {
				await this.upsertToRemote(remoteConn, tableName, chunk, pks);
				processed += chunk.length;
				if (chunks.length > 1) {
					this.logger.debug(`Table ${tableName}: Processed ${processed}/${rows.length} rows.`);
				}
			}
		} catch (error) {
			this.logger.error(`Error syncing table ${tableName}:`, error);
		}
	}

	async getRemoteCreateStatement(sqliteDb, tableName, pks) {
		const info = this.queryAll(sqliteDb, `PRAGMA table_info(${tableName})`);

		const columns = info.map((col) => {
			let type = "TEXT";
			if (col.type.includes("INT")) type = "BIGINT";
			if (col.type.includes("REAL") || col.type.includes("DOUBLE")) type = "DOUBLE";
			if (col.type.includes("BLOB")) type = "LONGBLOB";

			if (col.name === "json_data" || col.type === "TEXT" || type === "TEXT") {
				if (pks.includes(col.name)) {
					// Single-column PK: VARCHAR(500) → 2000 bytes, well under 3072 limit.
					// Composite PK: VARCHAR(191) per column → 764 bytes each;
					// two columns = 1528 bytes, safely under the 3072-byte InnoDB limit.
					type = pks.length === 1 ? "VARCHAR(500)" : "VARCHAR(191)";
				} else {
					type = "LONGTEXT";
				}
			}

			return `\`${col.name}\` ${type}`;
		});

		return `CREATE TABLE IF NOT EXISTS \`${tableName}\` (${columns.join(", ")}, PRIMARY KEY (${pks.map((pk) => `\`${pk}\``).join(", ")})) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
	}

	async upsertToRemote(remoteConn, tableName, rows, pks) {
		const keys = Object.keys(rows[0]);

		// For composite PKs, truncate TEXT PK values to VARCHAR(191) to prevent
		// "Data too long" errors on edge-case long values (e.g. long command triggers).
		const compositePkCols = pks.length > 1 ? new Set(pks) : new Set();
		const values = rows.map((row) =>
			keys.map((k) => {
				const v = row[k];
				if (compositePkCols.has(k) && typeof v === "string" && v.length > 191) {
					return v.substring(0, 191);
				}
				return v;
			})
		);

		const placeholders = rows.map(() => `(${keys.map(() => "?").join(", ")})`).join(", ");
		const updateClause = keys.map((k) => `\`${k}\` = VALUES(\`${k}\`)`).join(", ");

		const sql = `INSERT INTO \`${tableName}\` (${keys.map((k) => `\`${k}\``).join(", ")}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${updateClause}`;

		await remoteConn.execute(sql, values.flat());
	}

	chunkArray(array, size) {
		const chunks = [];
		for (let i = 0; i < array.length; i += size) {
			chunks.push(array.slice(i, i + size));
		}
		return chunks;
	}

	// --- Corruption Handling & Recovery ---

	/**
	 * Verify if a SQLite backup file is healthy and readable.
	 * @param {string} filePath - Path to the SQLite file
	 * @returns {boolean} - True if healthy
	 */
	isBackupFileHealthy(filePath) {
		let conn;
		try {
			conn = new BetterSQLite(filePath, { readonly: true, timeout: 2000 });
			return conn.pragma("integrity_check", { simple: true }) === "ok";
		} catch (e) {
			this.logger.warn(`Integrity check failed for backup file ${filePath}: ${e.message}`);
			return false;
		} finally {
			if (conn) {
				try {
					conn.close();
				} catch (e) {}
			}
		}
	}

	async handleCorruption(dbName, error) {
		if (this.recoveringDbs.has(dbName)) {
			this.logger.debug(`Recovery already in progress for ${dbName}. Skipping duplicate call.`);
			return;
		}

		this.recoveringDbs.add(dbName);
		this.logger.error(`CORRUPTION DETECTED in database: ${dbName}`, error);

		// 1. Report to Telegram (Verbose)
		await this.reportToTelegram(`🚨 *SQLITE CORRUPT DETECTED!*
Database: \`${dbName}.db\`
Error: \`${error.message}\``);

		let backupUsed = "none";
		try {
			// 2. CLOSE current connection FIRST and AWAIT it
			if (dbName === "core") {
				if (this.db.coreDb) {
					const core = this.db.coreDb;
					this.db.coreDb = null; // Prevent use while closing
					await new Promise((resolve) => {
						core.close((err) => resolve());
					});
				}
			} else if (this.db.sqlites[dbName]) {
				const db = this.db.sqlites[dbName];
				delete this.db.sqlites[dbName]; // Prevent use while closing
				await new Promise((resolve) => {
					db.close((err) => resolve());
				});
			}

			// Ensure underlying better-sqlite3 connection is closed in DatabaseMappers
			if (this.db.mappers) {
				this.db.mappers.closeConnection(dbName);
			}

			const dbFile = dbName === "core" ? "core.db" : `${dbName}.db`;
			const dbPath = path.join(this.databasePath, "sqlites", dbFile);
			const corruptPath = `${dbPath}.corrupt-${Date.now()}`;

			// 3. Backup and delete the corrupt file
			if (fs.existsSync(dbPath)) {
				try {
					fs.copyFileSync(dbPath, corruptPath);
					this.logger.info(`Corrupt database saved to: ${corruptPath}`);
					fs.unlinkSync(dbPath); // Delete it so we don't open the corrupt file if restore fails
				} catch (e) {
					this.logger.error(`Failed to copy/delete corrupt DB: ${e.message}`);
				}
			}

			// Delete WAL and SHM files to ensure a clean restore
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

			// 4. Attempt Restore from Cloud
			let restored = false;
			if (this.remoteEnabled && this.remoteServers.length > 0) {
				restored = await this.restoreFromCloud(dbName);
				if (restored) backupUsed = "cloud";
			}

			// 5. Fallback to Local Backups (Search from newest to oldest)
			if (!restored) {
				const localBackups = this.getSortedLocalBackups();
				for (const backup of localBackups) {
					const resolved = await this.resolveBackupFile(backup.path, dbFile);
					if (!resolved) continue;
					try {
						if (this.isBackupFileHealthy(resolved.filePath)) {
							fs.copyFileSync(resolved.filePath, dbPath);
							restored = true;
							backupUsed = `file from ${backup.name}`;
						} else {
							this.logger.warn(`Skipping corrupt local backup: ${backup.name}`);
						}
					} catch (e) {
						this.logger.error(`Failed to restore from local backup ${backup.name}: ${e.message}`);
					} finally {
						if (resolved.temporary) {
							// abrir o temporario (WAL) para o integrity_check cria -wal/-shm ao lado
							for (const suffix of ["", "-wal", "-shm"]) {
								fs.rmSync(resolved.filePath + suffix, { force: true });
							}
						}
					}
					if (restored) break;
				}
			}

			if (restored) {
				await this.reportToTelegram(`✅ *Backup Restored*
Source: \`${backupUsed}\``);

				// 6. Re-init connection
				await this.reinitConnection(dbName);

				await this.reportToTelegram(`🔄 *System Recovered*
File restored and data re-read into memory.`);
			} else {
				await this.reportToTelegram(`❌ *RESTORE FAILED*
No valid backup found (cloud or local). A fresh empty database will be initialized.`);

				// Re-init connection. Since the corrupt file was deleted, this will create a fresh one.
				await this.reinitConnection(dbName);
			}
		} catch (err) {
			this.logger.error("Error during corruption recovery:", err);
			await this.reportToTelegram(`❌ *CRITICAL RECOVERY ERROR*
${err.message}`);
			// Fallback re-init
			try {
				await this.reinitConnection(dbName);
			} catch (e) {
				this.logger.error(`Fallback re-init de '${dbName}' falhou apos erro de restauracao:`, e);
			}
		} finally {
			this.recoveringDbs.delete(dbName);
		}
	}

	async reportToTelegram(message) {
		for (const bot of this.db.botInstances) {
			try {
				if (bot.notificarDonate) {
					await bot.sendMessage(bot.grupoLogs || process.env.GRUPO_LOGS, message);
				}
			} catch (e) {
				this.logger.error("Failed to send report:", e);
			}
		}
	}

	async restoreFromCloud(dbName) {
		this.logger.info(`Attempting cloud restoration for ${dbName}...`);
		const schema = this.db.schemas[dbName];
		if (!schema) {
			this.logger.warn(`No schema found for ${dbName}, cloud restore might fail schema creation.`);
		}

		for (const serverUri of this.remoteServers) {
			let connection;
			let newDb;
			try {
				connection = await mysql.createConnection(serverUri);
				const remoteTables = await this.getRemoteTables(connection);

				const dbFile = dbName === "core" ? "core.db" : `${dbName}.db`;
				const dbPath = path.join(this.databasePath, "sqlites", dbFile);

				// Create a new empty SQLite to populate
				if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
				newDb = new BetterSQLite(dbPath);

				// 1. Initialize schema
				if (schema) {
					newDb.exec(schema);
				}

				// 2. Identify tables relevant to this DB
				const localTables = await this.getTables(newDb);
				this.logger.info(`DB '${dbName}': Tables to restore: ${localTables.join(", ")}`);

				for (const table of localTables) {
					if (remoteTables.includes(table)) {
						this.logger.info(`Restoring table '${table}' from cloud...`);

						// Use streaming or chunking to avoid OOM
						const [rowCountResult] = await connection.execute(
							`SELECT COUNT(*) as c FROM \`${table}\``
						);
						const totalRows = rowCountResult[0].c;

						if (totalRows === 0) {
							this.logger.debug(`Table '${table}' is empty on cloud.`);
							continue;
						}

						const chunkSize = 5000;
						for (let offset = 0; offset < totalRows; offset += chunkSize) {
							const [rows] = await connection.execute(
								`SELECT * FROM \`${table}\` LIMIT ${chunkSize} OFFSET ${offset}`
							);
							if (rows.length > 0) {
								await this.populateSQLiteTable(newDb, table, rows);
								this.logger.debug(
									`Restored ${offset + rows.length}/${totalRows} rows to table '${table}'.`
								);
							}
						}
					}
				}

				newDb.close();
				await connection.end();
				this.logger.info(`Cloud restoration successful for ${dbName} from ${serverUri}`);
				return true;
			} catch (e) {
				this.logger.error(`Cloud restore failed from ${serverUri}:`, e);
				if (newDb && newDb.open) {
					try {
						newDb.close();
					} catch (err) {}
				}
				if (connection) {
					try {
						await connection.end();
					} catch (err) {}
				}
			}
		}
		return false;
	}

	async getRemoteTables(conn) {
		const [rows] = await conn.execute("SHOW TABLES");
		return rows.map((r) => Object.values(r)[0]);
	}

	async populateSQLiteTable(sqliteDb, tableName, rows) {
		if (!rows || rows.length === 0) return;
		const keys = Object.keys(rows[0]);
		const columns = keys.map((k) => `\`${k}\``).join(", ");
		const placeholders = keys.map(() => "?").join(", ");

		const sql = `INSERT INTO \`${tableName}\` (${columns}) VALUES (${placeholders})`;

		const stmt = sqliteDb.prepare(sql);
		// better-sqlite3 só aceita number/string/bigint/Buffer/null; mysql2 pode retornar Date/boolean
		const toSqliteValue = (v) => {
			if (v instanceof Date) return v.getTime();
			if (typeof v === "boolean") return v ? 1 : 0;
			if (v === undefined) return null;
			return v;
		};
		const insertAll = sqliteDb.transaction((batch) => {
			for (const row of batch) {
				stmt.run(keys.map((k) => toSqliteValue(row[k])));
			}
		});
		insertAll(rows);
	}

	async reinitConnection(dbName) {
		// Close the mock wrapper if it exists (no-op but good practice)
		if (dbName === "core") {
			if (this.db.coreDb) {
				try {
					this.db.coreDb.close();
				} catch (e) {}
			}
		} else {
			if (this.db.sqlites[dbName]) {
				try {
					this.db.sqlites[dbName].close();
				} catch (e) {}
			}
		}

		// Reopen the in-memory connection in mappers, which automatically loads the restored file from disk
		if (this.db.mappers) {
			this.db.mappers.reopenConnection(dbName);
		}

		// Recreate the mock wrappers using the Database class's attached Sqlite3MockWrapper definition
		const Sqlite3MockWrapper = this.db.constructor.Sqlite3MockWrapper;
		if (dbName === "core") {
			this.db.coreDb = new Sqlite3MockWrapper("core", this.db.mappers);
		} else {
			this.db.sqlites[dbName] = new Sqlite3MockWrapper(dbName, this.db.mappers);
		}

		this.logger.info(`Reinitialized connection for ${dbName}`);
	}
}

module.exports = DatabaseBackup;
