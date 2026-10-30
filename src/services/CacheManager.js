const Redis = require("ioredis");
const cron = require("node-cron");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const MemoryCache = require("../utils/MemoryCache");
const { safeJsonParse } = require("../utils/JsonUtils");

const CACHE_CONFIG = {
	pushName: { ttl: 30 * 24 * 60 * 60, table: "pushnames" }, // 30 days
	chat: { ttl: 4 * 60 * 60, table: "chats" }, // 4 hours
	message: { ttl: 1 * 60 * 60, table: "messages" }, // 1 hour
	contact: { ttl: 7 * 24 * 60 * 60, table: "contacts" }, // 7 days
	tg_name: { ttl: 30 * 24 * 60 * 60, table: "tg_names" }, // 30 days
	app_cooldowns_data_v1: { ttl: 24 * 60 * 60, table: "cooldowns" } // 24 hours
};

class CacheManager {
	constructor(redisURL, redisDB, redisTTL, maxCacheSize) {
		if (CacheManager.instance) {
			return CacheManager.instance;
		}

		this.useRedis = process.env.USE_REDIS === "true";
		this.logger = new Logger(`cache-manager`);
		this.redisURL = redisURL;
		this.redisDB = (redisDB ?? 0) % 15;
		this.redisTTL = parseInt(redisTTL, 10) || 3600;
		this.maxCacheSize = parseInt(maxCacheSize, 10) || 10000;

		// in-memory main cache / fallback com LRU O(1) e capacidade elevada
		this.messageCache = new MemoryCache(2 * 60 * 60 * 1000, Math.min(this.maxCacheSize, 5000));
		this.contactCache = new MemoryCache(24 * 60 * 60 * 1000, Math.min(this.maxCacheSize, 5000));
		this.chatCache = new MemoryCache(4 * 60 * 60 * 1000, Math.min(this.maxCacheSize, 2000));
		this.pushnameCache = new MemoryCache(24 * 60 * 60 * 1000, this.maxCacheSize);
		this.telegramNameCache = new MemoryCache(
			24 * 60 * 60 * 1000,
			Math.min(this.maxCacheSize, 2000)
		);

		// Pending writes for SQLite batching
		// Map<table_name, Map<key, { value, expiresAt, ...extraFields }>>
		this.pendingWrites = new Map();

		this.unsavedChangesCount = 0;
		this.FLUSH_THRESHOLD = 2000; // Agrupa mais gravações para reduzir I/O de disco
		this.FLUSH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes flush interval

		// Database setup
		this.database = Database.getInstance();
		this.DB_NAME = "cache";
		// Promise-based mutex: if a flush is in progress, _flushingPromise is set.
		// New callers chain onto it instead of starting a second transaction.
		this._flushingPromise = null;

		// Initialize Tables
		this.database.getSQLiteDb(
			this.DB_NAME,
			`
      PRAGMA auto_vacuum = INCREMENTAL;
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_expires ON kv_store(expires_at);

      CREATE TABLE IF NOT EXISTS pushnames (
        id TEXT PRIMARY KEY,
        pushname TEXT,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pushnames_expires ON pushnames(expires_at);

      CREATE TABLE IF NOT EXISTS chats (
        key TEXT PRIMARY KEY,
        json_data TEXT,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_chats_expires ON chats(expires_at);

      CREATE TABLE IF NOT EXISTS messages (
        key TEXT PRIMARY KEY,
        json_data TEXT,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);

      CREATE TABLE IF NOT EXISTS contacts (
        key TEXT PRIMARY KEY,
        json_data TEXT,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_expires ON contacts(expires_at);

      CREATE TABLE IF NOT EXISTS tg_names (
        key TEXT PRIMARY KEY,
        json_data TEXT,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tgnames_expires ON tg_names(expires_at);

      CREATE TABLE IF NOT EXISTS cooldowns (
        key TEXT PRIMARY KEY,
        json_data TEXT,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_cooldowns_expires ON cooldowns(expires_at);
    `,
			true
		);

		// Redis setup (optional)
		this.redisClient = null;
		if (this.redisURL && this.useRedis) {
			try {
				this.redisClient = new Redis(`${this.redisURL}/${this.redisDB}`, {
					/* ... options ... */
				});
				this.redisClient.on("connect", () =>
					this.logger.info(`CacheManager: Connected to Redis db ${this.redisDB}.`)
				);
				this.redisClient.on("error", (err) =>
					this.logger.error("CacheManager: Redis client error:", err.message)
				);
				this.redisClient
					.ping()
					.catch((err) =>
						this.logger.warn(`CacheManager: Initial Redis ping failed: ${err.message}.`)
					);
			} catch (error) {
				this.logger.error("CacheManager: Failed to initialize Redis client:", error.message);
				this.redisClient = null;
			}
		}

		// Start flush timer
		this.flushTimer = setInterval(() => this.flushPendingWrites(), this.FLUSH_INTERVAL_MS);

		// Start cleanup timer (every hour)
		this.cleanupTimer = setInterval(() => this.cleanExpired(), 60 * 60 * 1000);

		// Start vacuum timer (every 6 hours)
		this.vacuumTimer = setInterval(() => this.runVacuum(), 6 * 60 * 60 * 1000);

		// Scheduled weekly full VACUUM on Tuesdays at 04:15 BRT
		this.weeklyVacuumJob = cron.schedule(
			"15 4 * * 2",
			async () => {
				await this.runFullVacuum();
			},
			{
				scheduled: true,
				timezone: "America/Sao_Paulo"
			}
		);

		// Scheduled daily maintenance at 05:15 BRT (limpeza de expirados e truncamento de WAL)
		this.dailyMaintenanceJob = cron.schedule(
			"15 5 * * *",
			async () => {
				try {
					this.logger.info("CacheManager: Running daily maintenance (05:15 BRT)...");
					await this.cleanExpired();
					await this.runFullVacuum();
				} catch (err) {
					this.logger.error("CacheManager: Error during daily maintenance:", err);
				}
			},
			{
				scheduled: true,
				timezone: "America/Sao_Paulo"
			}
		);

		// Setup shutdown hook
		this.setupShutdown();

		CacheManager.instance = this;
	}

	/**
	 * Get Singleton Instance
	 */
	static getInstance(redisURL, redisDB, redisTTL, maxCacheSize) {
		if (!CacheManager.instance) {
			CacheManager.instance = new CacheManager(redisURL, redisDB, redisTTL, maxCacheSize);
		}
		return CacheManager.instance;
	}

	setupShutdown() {
		const exitHandler = async () => {
			this.logger.info("CacheManager: Saving cache to disk before exit...");
			await this.flushPendingWrites();
		};
	}

	// --- Helper to get Config ---

	getCacheConfig(key) {
		if (CACHE_CONFIG[key]) return CACHE_CONFIG[key];
		const prefix = key.split(":")[0];
		if (CACHE_CONFIG[prefix]) return CACHE_CONFIG[prefix];
		return null;
	}

	// --- Persistence Helpers ---

	async _dbGet(key, tableOverride = null) {
		const config = this.getCacheConfig(key);
		let table = tableOverride || (config ? config.table : "kv_store");

		// Fallback to kv_store if config not found (though existing code skips writes if no config)
		if (!config && !tableOverride) table = "kv_store";

		// Handle special case for pushnames (different column names)
		const isPushname = table === "pushnames";
		const keyCol = isPushname ? "id" : "key";
		const valCol = isPushname ? "pushname" : table === "kv_store" ? "value" : "json_data";

		try {
			const row = await this.database.dbGet(
				this.DB_NAME,
				`SELECT ${valCol}, expires_at FROM ${table} WHERE ${keyCol} = ?`,
				[key]
			);
			if (row) {
				if (row.expires_at && row.expires_at < Date.now()) {
					this.database
						.dbRun(this.DB_NAME, `DELETE FROM ${table} WHERE ${keyCol} = ?`, [key])
						.catch(() => {});
					return null;
				}

				if (isPushname) {
					return { id: key, pushName: row[valCol] };
				}

				return safeJsonParse(row[valCol]);
			}
			return null;
		} catch (e) {
			this.logger.error(`Error reading from DB (${table}) for ${key}:`, e);
			return null;
		}
	}

	_scheduleWrite(key, value, explicitTable = null) {
		if (process.env.DISABLE_ACTIVITY === "true") return;
		const config = this.getCacheConfig(key);
		const table = explicitTable || (config ? config.table : null);

		// If no config/table found, do NOT persist to SQLite (as per previous instructions)
		if (!table) return;

		const ttlSeconds = config ? config.ttl : this.redisTTL;
		const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;

		if (!this.pendingWrites.has(table)) {
			this.pendingWrites.set(table, new Map());
		}

		// Special handling for pushnames structure
		if (table === "pushnames") {
			const nameStr = value && value.pushName ? value.pushName : "";
			this.pendingWrites.get(table).set(key, { value: nameStr, expiresAt });
		} else {
			// Generic JSON storage
			this.pendingWrites.get(table).set(key, { value: JSON.stringify(value), expiresAt });
		}

		this.unsavedChangesCount++;

		if (this.unsavedChangesCount >= this.FLUSH_THRESHOLD) {
			// Fire-and-forget, but serialized through the mutex inside flushPendingWrites
			this.flushPendingWrites().catch(() => {});
		}
	}

	flushPendingWrites() {
		// If a flush is already running, chain onto it so we never start
		// a second BEGIN TRANSACTION while the first is still open.
		if (this._flushingPromise) {
			this._flushingPromise = this._flushingPromise.then(() => this._doFlush());
		} else {
			this._flushingPromise = this._doFlush();
		}
		// Always clear the reference once the entire chain settles
		this._flushingPromise = this._flushingPromise.finally(() => {
			this._flushingPromise = null;
		});
		return this._flushingPromise;
	}

	async _doFlush() {
		if (this.pendingWrites.size === 0) return;

		this.logger.debug(`Flushing cache items to disk...`);

		// Snapshot the pending writes so new items can accumulate during the flush
		const writesToProcess = new Map(this.pendingWrites);
		this.pendingWrites.clear();
		this.unsavedChangesCount = 0;

		try {
			await this.database.dbTransaction(this.DB_NAME, async () => {
				for (const [table, items] of writesToProcess) {
					const isPushname = table === "pushnames";
					const keyCol = isPushname ? "id" : "key";
					const valCol = isPushname ? "pushname" : table === "kv_store" ? "value" : "json_data";

					for (const [key, data] of items) {
						await this.database.dbRun(
							this.DB_NAME,
							`INSERT OR REPLACE INTO ${table} (${keyCol}, ${valCol}, expires_at) VALUES (?, ?, ?)`,
							[key, data.value, data.expiresAt]
						);
					}
				}
			});
		} catch (e) {
			this.logger.error("Error flushing cache to disk:", e);
		}
	}

	async cleanExpired() {
		try {
			const now = Date.now();
			const tables = [
				"kv_store",
				"pushnames",
				"chats",
				"messages",
				"contacts",
				"tg_names",
				"cooldowns"
			];

			for (const table of tables) {
				await this.database.dbRun(this.DB_NAME, `DELETE FROM ${table} WHERE expires_at < ?`, [now]);
			}
		} catch (e) {
			this.logger.error("Error cleaning expired cache:", e);
		}
	}

	/**
	 * Run periodic incremental vacuum every 6 hours to reclaim disk space
	 */
	async runVacuum() {
		try {
			this.logger.info("CacheManager: Running scheduled vacuum (incremental)...");
			await this.database.dbRun(this.DB_NAME, "PRAGMA incremental_vacuum");
		} catch (e) {
			this.logger.error("CacheManager: Error during scheduled vacuum:", e);
		}
	}

	/**
	 * Run weekly full vacuum and truncate WAL
	 */
	async runFullVacuum() {
		try {
			this.logger.info("CacheManager: Running weekly full VACUUM and WAL truncate...");
			await this.database.dbRun(this.DB_NAME, "VACUUM");
			await this.database.dbRun(this.DB_NAME, "PRAGMA wal_checkpoint(TRUNCATE)");
			this.logger.info("CacheManager: Weekly full VACUUM completed successfully.");
		} catch (e) {
			this.logger.error("CacheManager: Error during full VACUUM:", e);
		}
	}

	// --- Cache Methods ---

	async putPushnameInCache(data) {
		if (!data || typeof data.id === "undefined") return;
		const userId = String(data.id);
		const redisKey = `pushName:${userId}`; // Keep redis key format for consistency
		const tableKey = userId; // Use ID as key for specific table
		const config = CACHE_CONFIG["pushName"];
		const ttl = config ? config.ttl : this.redisTTL;

		// Redis
		if (this.redisClient) {
			try {
				await this.redisClient.set(redisKey, JSON.stringify(data), "EX", ttl);
				return;
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		// Memory
		this.pushnameCache.set(userId, data);

		// SQLite Persistence
		this._scheduleWrite(tableKey, data, "pushnames");
	}

	async getPushnameFromCache(id) {
		if (!id) return null;
		const strId = String(id);
		const redisKey = `pushName:${strId}`;
		const tableKey = strId;

		// Redis
		if (this.redisClient) {
			try {
				const cached = await this.redisClient.get(redisKey);
				if (cached) return safeJsonParse(cached);
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		// Memory
		const memItem = this.pushnameCache.get(strId);
		if (memItem) return memItem;

		// SQLite
		const dbItem = await this._dbGet(tableKey, "pushnames");
		if (dbItem) {
			// Promote to memory
			this.pushnameCache.set(strId, dbItem);
			return dbItem;
		}
		return null;
	}

	async putChatInCache(data) {
		if (!data || !data.id) return;
		const chatId = String(typeof data.id === "object" ? data.id._serialized : data.id);
		if (!chatId) return;
		const redisKey = `chat:${chatId}`;
		const tableKey = redisKey; // 'chat:ID'
		const config = CACHE_CONFIG["chat"];
		const ttl = config ? config.ttl : this.redisTTL;

		if (this.redisClient) {
			try {
				await this.redisClient.set(redisKey, JSON.stringify(data), "EX", ttl);
				return;
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		this.chatCache.set(chatId, data);

		this._scheduleWrite(tableKey, data, "chats");
	}

	async getChatFromCache(id) {
		if (!id) return null;
		const strId = String(id);
		const redisKey = `chat:${strId}`;
		const tableKey = redisKey;

		if (this.redisClient) {
			try {
				const cached = await this.redisClient.get(redisKey);
				if (cached) return safeJsonParse(cached);
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		const memItem = this.chatCache.get(strId);
		if (memItem) return memItem;

		const dbItem = await this._dbGet(tableKey, "chats");
		if (dbItem) {
			this.chatCache.set(strId, dbItem);
			return dbItem;
		}
		return null;
	}

	async putMessageInCache(data) {
		if (!data) return;
		const messageId = String(data.key?.id || data.id || "");
		if (!messageId) return;
		const redisKey = `message:${messageId}`;
		const tableKey = redisKey;
		const config = CACHE_CONFIG["message"];
		const ttl = config ? config.ttl : this.redisTTL;

		if (this.redisClient) {
			try {
				await this.redisClient.set(redisKey, JSON.stringify(data), "EX", ttl);
				return;
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		this.messageCache.set(messageId, data);

		this._scheduleWrite(tableKey, data, "messages");
	}

	async putSentMessageInCache(key) {
		if (!key || !key.id) return;
		const messageId = String(key.id);
		const redisKey = `message:${messageId}`;
		const tableKey = redisKey;
		const config = CACHE_CONFIG["message"];
		const ttl = config ? config.ttl : this.redisTTL;

		if (this.redisClient) {
			try {
				await this.redisClient.set(redisKey, JSON.stringify(key), "EX", ttl);
				return;
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		this.messageCache.set(messageId, key);

		this._scheduleWrite(tableKey, key, "messages");
	}

	async getMessageFromCache(id) {
		if (!id) return null;
		const strId = String(id);
		const redisKey = `message:${strId}`;
		const tableKey = redisKey;

		if (this.redisClient) {
			try {
				const cached = await this.redisClient.get(redisKey);
				if (cached) return safeJsonParse(cached);
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		const memItem = this.messageCache.get(strId);
		if (memItem) return memItem;

		const dbItem = await this._dbGet(tableKey, "messages");
		if (dbItem) {
			this.messageCache.set(strId, dbItem);
			return dbItem;
		}
		return null;
	}

	// V3 Methods
	async putGoMessageInCache(data) {
		if (!data || !data.id) return;
		const messageId = String(data.id);
		const redisKey = `message:${messageId}`;
		const tableKey = redisKey;
		const config = CACHE_CONFIG["message"];
		const ttl = config ? config.ttl : this.redisTTL;

		if (this.redisClient) {
			try {
				await this.redisClient.set(redisKey, JSON.stringify(data), "EX", ttl);
				return;
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		this.messageCache.set(messageId, data);

		this._scheduleWrite(tableKey, data, "messages");
	}

	async putGoSentMessageInCache(message) {
		if (!message || !message.id) return;
		const messageId = String(typeof message.id === "object" ? message.id._serialized : message.id);
		if (!messageId) return;
		const redisKey = `message:${messageId}`;
		const tableKey = redisKey;
		const config = CACHE_CONFIG["message"];
		const ttl = config ? config.ttl : this.redisTTL;

		if (this.redisClient) {
			try {
				await this.redisClient.set(redisKey, JSON.stringify(message), "EX", ttl);
				return;
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		this.messageCache.set(messageId, message);

		this._scheduleWrite(tableKey, message, "messages");
	}

	async getGoMessageFromCache(id) {
		if (!id) return null;
		const strId = String(id);
		const redisKey = `message:${strId}`;
		const tableKey = redisKey;

		if (this.redisClient) {
			try {
				const cached = await this.redisClient.get(redisKey);
				if (cached) return safeJsonParse(cached);
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		const memItem = this.messageCache.get(strId);
		if (memItem) return memItem;

		const dbItem = await this._dbGet(tableKey, "messages");
		if (dbItem) {
			this.messageCache.set(strId, dbItem);
			return dbItem;
		}
		return null;
	}

	async putContactInCache(data) {
		if (!data || typeof data.number === "undefined") return;
		const contactNumber = String(data.number);
		const redisKey = `contact:${contactNumber}`;
		const tableKey = redisKey;
		const config = CACHE_CONFIG["contact"];
		const ttl = config ? config.ttl : this.redisTTL;

		if (this.redisClient) {
			try {
				await this.redisClient.set(redisKey, JSON.stringify(data), "EX", ttl);
				return;
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		this.contactCache.set(contactNumber, data);

		this._scheduleWrite(tableKey, data, "contacts");
	}

	async getContactFromCache(id) {
		if (!id) return null;
		const strId = String(id);
		const redisKey = `contact:${strId}`;
		const tableKey = redisKey;

		if (this.redisClient) {
			try {
				const cached = await this.redisClient.get(redisKey);
				if (cached) return safeJsonParse(cached);
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		const memItem = this.contactCache.get(strId);
		if (memItem) return memItem;

		const dbItem = await this._dbGet(tableKey, "contacts");
		if (dbItem) {
			this.contactCache.set(strId, dbItem);
			return dbItem;
		}
		return null;
	}

	async putTelegramNameInCache(userId, name) {
		if (!userId || !name) return;
		const strId = String(userId);
		const redisKey = `tg_name:${strId}`;
		const tableKey = redisKey;
		const config = CACHE_CONFIG["tg_name"];
		const ttl = config ? config.ttl : 86400; // 24h default fallback

		if (this.redisClient) {
			try {
				await this.redisClient.set(redisKey, name, "EX", ttl);
				return;
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		this.telegramNameCache.set(strId, name, ttl * 1000);

		// Store as JSON string in value/json_data to be consistent
		this._scheduleWrite(tableKey, name, "tg_names");
	}

	async getTelegramNameFromCache(userId) {
		if (!userId) return null;
		const strId = String(userId);
		const redisKey = `tg_name:${strId}`;
		const tableKey = redisKey;

		if (this.redisClient) {
			try {
				const cachedName = await this.redisClient.get(redisKey);
				if (cachedName) return cachedName;
			} catch (err) {
				this.logger.debug("Redis operation error:", err.message);
			}
		}

		const memName = this.telegramNameCache.get(strId);
		if (memName) return memName;

		const dbName = await this._dbGet(tableKey, "tg_names");
		if (dbName) {
			this.telegramNameCache.set(strId, dbName);
			return dbName;
		}
		return null;
	}

	async getCooldowns() {
		const redisKey = "app_cooldowns_data_v1";
		const tableKey = redisKey;

		if (this.redisClient) {
			try {
				const cachedData = await this.redisClient.get(redisKey);
				if (cachedData) return safeJsonParse(cachedData, {});
			} catch (err) {
				this.logger.error(`Error retrieving cooldowns from Redis: ${err.message}`);
			}
		}

		const dbData = await this._dbGet(tableKey, "cooldowns");
		return dbData || {};
	}

	async saveCooldowns(cooldownsData) {
		if (typeof cooldownsData !== "object" || cooldownsData === null) return;
		const redisKey = "app_cooldowns_data_v1";
		const tableKey = redisKey;
		// config handled in _scheduleWrite

		if (this.redisClient) {
			try {
				await this.redisClient.set(redisKey, JSON.stringify(cooldownsData));
			} catch (err) {
				this.logger.error(`Error saving cooldowns to Redis: ${err.message}`);
			}
		}

		this._scheduleWrite(tableKey, cooldownsData, "cooldowns");
	}

	async disconnectRedis() {
		// Flush before disconnect
		await this.flushPendingWrites();

		if (
			this.redisClient &&
			(this.redisClient.status === "ready" ||
				this.redisClient.status === "connecting" ||
				this.redisClient.status === "reconnecting")
		) {
			try {
				await this.redisClient.quit();
				this.logger.info("CacheManager: Redis client disconnected gracefully.");
			} catch (err) {
				this.logger.error("CacheManager: Error disconnecting Redis client:", err.message);
			} finally {
				this.redisClient = null;
			}
		}
	}
}

module.exports = CacheManager;
