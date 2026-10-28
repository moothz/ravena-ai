const fs = require("fs");
const path = require("path");
const os = require("os");
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
		this.backupToFs = process.env.BACKUP_TO_FS === "true"; // false por padrão: zero arquivos mantidos em disco
		this.backupToS3 = (process.env.BACKUP_TO_S3 ?? "true") === "true"; // true por padrão: backups no S3
		this.backupPath =
			process.env.PRIMARY_BACKUP_PATH ||
			process.env.BACKUP_PATH ||
			(fs.existsSync("/app/downloads/backups/sqlite")
				? "/app/downloads/backups/sqlite"
				: path.join(__dirname, "../../data/backups"));

		this.maxBackups = parseInt(process.env.MAX_BACKUPS) || 120;
		this.backupRetentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS) || 30;
		// Compacta os .db de cada backup em .db.gz (a restauracao aceita os dois formatos)
		this.backupGzip = process.env.BACKUP_GZIP !== "false"; // true por padrão

		// Remote Backup Config
		this.remoteEnabled = process.env.SQLITE_REMOTE_BACKUP === "true";
		this.remoteServers = process.env.SQLITE_REMOTE_SERVERS
			? process.env.SQLITE_REMOTE_SERVERS.split(",")
			: [];

		this.backupIgnoreFiles = [
			"cache.db",
			"rate_limits.db",
			"video_cache.db",
			"smd_cache.db",
			"translation-cache.db",
			"raffle_cache.db"
		];
		this.backupTargets = [path.join(this.databasePath, "sqlites")];

		this.remoteBackupInterval =
			(parseInt(process.env.REMOTE_BACKUP_INTERVAL_MINUTES) || 30) * 60 * 1000;

		this.recoveringDbs = new Set();
	}

	shouldIgnoreFile(filename) {
		if (!filename || filename.startsWith(".")) return true;
		if (this.backupIgnoreFiles.includes(filename)) return true;
		if (
			filename.startsWith("cache.db-") ||
			filename.startsWith("rate_limits.db-") ||
			filename.startsWith("video_cache.db-") ||
			filename.startsWith("smd_cache.db-")
		) {
			return true;
		}
		if (filename.includes("corrupt") || filename.includes("corrupted")) return true;
		if (filename.endsWith("-wal") || filename.endsWith("-shm")) return true;
		if (filename.includes(".bak") || filename.includes("_backup_") || filename.endsWith(".tmp")) {
			return true;
		}

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
			// Diretório temporário efêmero de trabalho (no /tmp, não polui nem desgasta os SSDs de dados)
			const tmpWorkDir = path.join(os.tmpdir(), `ravena-bkp-${timestamp}`);
			fs.mkdirSync(tmpWorkDir, { recursive: true });

			const backedUpFiles = new Set();
			const destSqlitesDir = path.join(tmpWorkDir, "sqlites");
			fs.mkdirSync(destSqlitesDir, { recursive: true });

			// 1. Safe SQLite Backups for active better-sqlite3 connections
			if (this.db.mappers && this.db.mappers.connections) {
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
						this.logger.info(`Safe online backup created for connection '${name}'`);
					} catch (backupErr) {
						this.logger.error(`Failed to create safe online backup for '${name}':`, backupErr);
					}
				}
			}

			// 2. Fallback: Copy any other database files not currently open
			for (const target of this.backupTargets) {
				if (fs.existsSync(target)) {
					const items = fs.readdirSync(target);
					for (const item of items) {
						if (this.shouldIgnoreFile(item)) continue;
						if (backedUpFiles.has(item)) continue; // Already backed up safely
						if (backedUpFiles.has(item.replace(/-(wal|shm|journal)$/, ""))) continue;
						this.backupDirectory(path.join(target, item), path.join(destSqlitesDir, item));
					}
				}
			}

			if (this.backupGzip) await this.compressBackupDir(destSqlitesDir);

			// Metadados do backup
			const backupFiles = fs.readdirSync(destSqlitesDir);
			const backupInfo = {
				timestamp,
				createdAt: now.toISOString(),
				fileCount: backupFiles.length,
				files: backupFiles
			};
			const infoPath = path.join(tmpWorkDir, "backup-info.json");
			fs.writeFileSync(infoPath, JSON.stringify(backupInfo, null, 2), "utf8");

			// 3. Upload para o S3 (bucket 'backups') se habilitado
			if (this.backupToS3 && storageService.enabled) {
				await this.uploadBackupToS3(tmpWorkDir, timestamp);
				await this.cleanupOldS3Backups(this.backupRetentionDays);
			}

			// 4. Se backup no sistema de arquivos estiver ativado (BACKUP_TO_FS=true)
			if (this.backupToFs) {
				const finalBackupDir = path.join(this.backupPath, timestamp);
				fs.mkdirSync(finalBackupDir, { recursive: true });
				const finalSqlitesDir = path.join(finalBackupDir, "sqlites");
				fs.mkdirSync(finalSqlitesDir, { recursive: true });

				for (const f of backupFiles) {
					fs.copyFileSync(path.join(destSqlitesDir, f), path.join(finalSqlitesDir, f));
				}
				fs.copyFileSync(infoPath, path.join(finalBackupDir, "backup-info.json"));
				this.logger.info(`File backup preserved on disk: ${finalBackupDir}`);

				// Cópia secundária se SECONDARY_BACKUP_PATH estiver configurado e diferente do destino principal
				if (
					process.env.SECONDARY_BACKUP_PATH &&
					process.env.SECONDARY_BACKUP_PATH !== this.backupPath
				) {
					try {
						const secSnapshotDir = path.join(process.env.SECONDARY_BACKUP_PATH, timestamp);
						fs.mkdirSync(secSnapshotDir, { recursive: true });
						for (const f of backupFiles) {
							fs.copyFileSync(path.join(destSqlitesDir, f), path.join(secSnapshotDir, f));
						}
						this.cleanupSecondaryBackups(process.env.SECONDARY_BACKUP_PATH, 30);
					} catch (secErr) {
						this.logger.warn(
							"[Secondary Backup] Falha ao copiar para destino secundário:",
							secErr.message
						);
					}
				}

				this.cleanupOldScheduledBackups();
			}

			// 5. Limpeza do diretório temporário no /tmp (zero lixo em disco)
			this.deleteDirectory(tmpWorkDir);

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
					zlib.createGzip({ level: 1 }),
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

	cleanupSecondaryBackups(baseDir, retentionDays = 30) {
		try {
			if (!fs.existsSync(baseDir)) return;
			const now = Date.now();
			const retentionPeriod = retentionDays * 24 * 60 * 60 * 1000;
			const items = fs.readdirSync(baseDir);

			for (const item of items) {
				const fullPath = path.join(baseDir, item);
				if (!fs.statSync(fullPath).isDirectory()) continue;
				if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/.test(item)) continue;

				const dirDate = new Date(
					item.replace(/-/g, (m, i) =>
						i === 4 || i === 7 || i === 10 ? m : i === 13 || i === 16 ? ":" : i === 19 ? "." : m
					)
				).getTime();

				if (isNaN(dirDate) || now - dirDate > retentionPeriod) {
					this.deleteDirectory(fullPath);
					this.logger.info(`[Secondary Backup] Old backup removed: ${item}`);
				}
			}
		} catch (error) {
			this.logger.error("Error cleaning up secondary backups:", error);
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

			// 6. Fallback to S3 Backups
			if (!restored && this.backupToS3 && storageService.enabled) {
				restored = await this.restoreFromS3(dbName);
				if (restored) backupUsed = "S3 Object Storage";
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

	/**
	 * Faz upload dos arquivos de backup (.db.gz, json) para o bucket S3 de backups
	 */
	async uploadBackupToS3(tmpWorkDir, timestamp) {
		try {
			const destSqlitesDir = path.join(tmpWorkDir, "sqlites");
			const files = fs.readdirSync(destSqlitesDir);
			const targetBucket = storageService.bucketBackups;

			this.logger.info(
				`[S3 Backup] Iniciando upload de ${files.length} bancos para s3://${targetBucket}/sqlite/${timestamp}/...`
			);

			for (const file of files) {
				const fullPath = path.join(destSqlitesDir, file);
				const s3Key = `sqlite/${timestamp}/${file}`;
				const fileStream = fs.createReadStream(fullPath);
				await storageService.upload(fileStream, s3Key, {
					bucket: targetBucket,
					mimetype: file.endsWith(".gz") ? "application/gzip" : "application/x-sqlite3"
				});
			}

			// Envia backup-info.json
			const infoPath = path.join(tmpWorkDir, "backup-info.json");
			if (fs.existsSync(infoPath)) {
				const infoStream = fs.createReadStream(infoPath);
				await storageService.upload(infoStream, `sqlite/${timestamp}/backup-info.json`, {
					bucket: targetBucket,
					mimetype: "application/json"
				});
			}

			this.logger.info(
				`[S3 Backup] Backup '${timestamp}' enviado com sucesso para o bucket '${targetBucket}'.`
			);
			return true;
		} catch (err) {
			this.logger.error("[S3 Backup] Falha no upload para o S3:", err);
			return false;
		}
	}

	/**
	 * Remove snapshots antigos do S3 excedendo a política de retenção
	 */
	async cleanupOldS3Backups(retentionDays = this.backupRetentionDays) {
		try {
			if (!storageService.enabled) return 0;
			const targetBucket = storageService.bucketBackups;
			const objects = await storageService.listObjects("sqlite/", targetBucket);
			if (objects.length === 0) return 0;

			const now = Date.now();
			const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
			const snapshots = new Map(); // timestamp -> Array of keys

			for (const obj of objects) {
				const parts = obj.key.split("/");
				if (parts.length >= 3) {
					const ts = parts[1];
					if (!snapshots.has(ts)) snapshots.set(ts, []);
					snapshots.get(ts).push(obj.key);
				}
			}

			const keysToDelete = [];
			let deletedSnapshots = 0;

			for (const [ts, keys] of snapshots.entries()) {
				const isoTs = ts.replace(/-/g, (m, i) =>
					i === 4 || i === 7 || i === 10 ? m : i === 13 || i === 16 ? ":" : i === 19 ? "." : m
				);
				const tsDate = new Date(isoTs).getTime();
				if (!isNaN(tsDate) && now - tsDate > retentionMs) {
					keysToDelete.push(...keys);
					deletedSnapshots++;
					this.logger.info(`[S3 Backup] Snapshot antigo expirado para remoção: ${ts}`);
				}
			}

			if (keysToDelete.length > 0) {
				await storageService.deleteObjects(keysToDelete, targetBucket);
				this.logger.info(
					`[S3 Backup] Retenção concluída: ${deletedSnapshots} snapshots (${keysToDelete.length} objetos) removidos de '${targetBucket}'.`
				);
			}

			return deletedSnapshots;
		} catch (err) {
			this.logger.error("[S3 Backup] Erro na limpeza de backups antigos no S3:", err);
			return 0;
		}
	}

	/**
	 * Restaura um banco SQLite diretamente a partir do snapshot mais recente no S3
	 * @param {string} dbName - Nome do banco (ex: "core", "waifus")
	 * @returns {Promise<boolean>}
	 */
	async restoreFromS3(dbName) {
		try {
			if (!storageService.enabled) return false;
			const targetBucket = storageService.bucketBackups;
			const dbFile = dbName === "core" ? "core.db" : `${dbName}.db`;
			const gzFile = `${dbFile}.gz`;

			this.logger.info(`[restoreFromS3] Buscando snapshots no S3 para restaurar '${dbFile}'...`);
			const objects = await storageService.listObjects("sqlite/", targetBucket);
			if (objects.length === 0) {
				this.logger.warn(`[restoreFromS3] Nenhum backup encontrado no bucket '${targetBucket}'.`);
				return false;
			}

			// Agrupa snapshots disponíveis ordenados do mais recente para o mais antigo
			const snapshotTimestamps = [
				...new Set(
					objects
						.map((o) => o.key.split("/")[1])
						.filter((ts) => ts && /^\d{4}-\d{2}-\d{2}T/.test(ts))
				)
			].sort((a, b) => b.localeCompare(a));

			const targetDbPath = path.join(this.databasePath, "sqlites", dbFile);

			for (const ts of snapshotTimestamps) {
				const candidateGzKey = `sqlite/${ts}/${gzFile}`;
				const candidateRawKey = `sqlite/${ts}/${dbFile}`;

				let s3Key = null;
				let isGz = false;

				if (objects.some((o) => o.key === candidateGzKey)) {
					s3Key = candidateGzKey;
					isGz = true;
				} else if (objects.some((o) => o.key === candidateRawKey)) {
					s3Key = candidateRawKey;
					isGz = false;
				}

				if (!s3Key) continue;

				this.logger.info(`[restoreFromS3] Baixando ${s3Key} do bucket '${targetBucket}'...`);
				try {
					const s3Obj = await storageService.get(s3Key, { bucket: targetBucket });
					if (!s3Obj || !s3Obj.buffer) continue;

					let dbBuffer = s3Obj.buffer;
					if (isGz) {
						dbBuffer = zlib.gunzipSync(dbBuffer);
					}

					const tmpCheckPath = path.join(os.tmpdir(), `.restore-s3-${process.pid}-${dbFile}`);
					fs.writeFileSync(tmpCheckPath, dbBuffer);

					if (this.isBackupFileHealthy(tmpCheckPath)) {
						fs.mkdirSync(path.dirname(targetDbPath), { recursive: true });
						fs.copyFileSync(tmpCheckPath, targetDbPath);
						for (const suffix of ["", "-wal", "-shm"]) {
							fs.rmSync(tmpCheckPath + suffix, { force: true });
						}
						this.logger.info(
							`[restoreFromS3] Banco '${dbName}' restaurado com sucesso a partir de snapshot S3: ${ts}`
						);
						return true;
					} else {
						this.logger.warn(
							`[restoreFromS3] Snapshot S3 corrompido: ${s3Key}. Tentando anterior...`
						);
						for (const suffix of ["", "-wal", "-shm"]) {
							fs.rmSync(tmpCheckPath + suffix, { force: true });
						}
					}
				} catch (downloadErr) {
					this.logger.error(`[restoreFromS3] Erro ao processar ${s3Key}:`, downloadErr.message);
				}
			}

			return false;
		} catch (err) {
			this.logger.error(`[restoreFromS3] Falha geral ao tentar restaurar '${dbName}' do S3:`, err);
			return false;
		}
	}
}

module.exports = DatabaseBackup;
