"use strict";

const crypto = require("crypto");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");

class AccountLinkService {
	constructor(options = {}) {
		this.logger = new Logger("account-link-service");
		this.database = options.database || Database.getInstance();
		this.DB_NAME = "linked_accounts";
		this.CODE_TTL_MS = 15 * 60 * 1000; // 15 minutos

		// In-memory bi-directional maps para resolução instantânea O(1)
		this.platformToWa = new Map(); // "${platform}:${platformId}" -> whatsappId
		this.waToPlatform = new Map(); // "${platform}:${whatsappId}" -> platformId
		this.initialized = false;

		this.initDatabase();
	}

	static getInstance(options = {}) {
		if (!AccountLinkService.instance) {
			AccountLinkService.instance = new AccountLinkService(options);
		}
		return AccountLinkService.instance;
	}

	initDatabase() {
		const schema = `
			CREATE TABLE IF NOT EXISTS linked_accounts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				platform TEXT NOT NULL,
				platform_id TEXT NOT NULL,
				whatsapp_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(platform, platform_id)
			);
			CREATE INDEX IF NOT EXISTS idx_linked_wa ON linked_accounts(whatsapp_id);
			CREATE INDEX IF NOT EXISTS idx_linked_platform ON linked_accounts(platform, platform_id);

			CREATE TABLE IF NOT EXISTS link_codes (
				code TEXT PRIMARY KEY,
				whatsapp_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_link_codes_wa ON link_codes(whatsapp_id);
		`;

		try {
			this.database.getSQLiteDb(this.DB_NAME, schema);
			this.loadCache().catch((err) => {
				this.logger.error("Erro ao carregar cache de contas vinculadas:", err);
			});
		} catch (error) {
			this.logger.error("Erro ao inicializar banco de contas vinculadas:", error);
		}
	}

	async loadCache() {
		try {
			const rows = await this.database.dbAll(
				this.DB_NAME,
				"SELECT platform, platform_id, whatsapp_id FROM linked_accounts"
			);

			this.platformToWa.clear();
			this.waToPlatform.clear();

			if (Array.isArray(rows)) {
				for (const row of rows) {
					const platform = String(row.platform).toLowerCase().trim();
					const platformId = String(row.platform_id).trim();
					const waId = String(row.whatsapp_id).replace(/\D/g, "");

					if (platform && platformId && waId) {
						this.platformToWa.set(`${platform}:${platformId}`, waId);
						this.waToPlatform.set(`${platform}:${waId}`, platformId);
					}
				}
			}

			this.initialized = true;
			this.logger.info(`Cache carregado com ${this.platformToWa.size} contas vinculadas.`);
		} catch (error) {
			this.logger.error("Erro ao carregar contas vinculadas do SQLite:", error);
		}
	}

	/**
	 * Obtém o WhatsApp ID associado a uma conta de Telegram ou Discord
	 * @param {string} platform - "telegram" | "discord"
	 * @param {string} platformId - ID da plataforma
	 * @returns {string|null}
	 */
	getLinkedWhatsApp(platform, platformId) {
		if (!platform || !platformId) return null;
		const cleanPlatform = String(platform).toLowerCase().trim();
		const cleanId = String(platformId).split("@")[0].trim();
		return this.platformToWa.get(`${cleanPlatform}:${cleanId}`) || null;
	}

	/**
	 * Obtém o ID da plataforma associado a um número de WhatsApp
	 * @param {string} platform - "telegram" | "discord"
	 * @param {string} whatsappId - Número do WhatsApp
	 * @returns {string|null}
	 */
	getLinkedPlatformUser(platform, whatsappId) {
		if (!platform || !whatsappId) return null;
		const cleanPlatform = String(platform).toLowerCase().trim();
		const cleanWaId = String(whatsappId).replace(/\D/g, "");
		return this.waToPlatform.get(`${cleanPlatform}:${cleanWaId}`) || null;
	}

	/**
	 * Retorna todas as contas vinculadas a um WhatsApp
	 * @param {string} whatsappId
	 * @returns {Object} { telegram: string|null, discord: string|null }
	 */
	getAllLinksForWhatsApp(whatsappId) {
		const cleanWaId = String(whatsappId).replace(/\D/g, "");
		return {
			telegram: this.getLinkedPlatformUser("telegram", cleanWaId),
			discord: this.getLinkedPlatformUser("discord", cleanWaId)
		};
	}

	/**
	 * Gera um código temporário para vinculação a partir do WhatsApp
	 * @param {string} whatsappId
	 * @returns {Promise<string>}
	 */
	async createLinkCode(whatsappId) {
		const cleanWaId = String(whatsappId).replace(/\D/g, "");
		if (!cleanWaId) {
			throw new Error("WhatsApp ID inválido para geração de código");
		}

		// Remove códigos antigos expirados ou do mesmo usuário
		const now = Date.now();
		await this.database.dbRun(
			this.DB_NAME,
			"DELETE FROM link_codes WHERE whatsapp_id = ? OR expires_at < ?",
			[cleanWaId, now]
		);

		// Gera código alfanumérico amigável de 10 caracteres (ex: 5 bytes hex)
		const code = crypto.randomBytes(5).toString("hex").toLowerCase();
		const expiresAt = now + this.CODE_TTL_MS;

		await this.database.dbRun(
			this.DB_NAME,
			"INSERT INTO link_codes (code, whatsapp_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
			[code, cleanWaId, now, expiresAt]
		);

		return code;
	}

	/**
	 * Valida o código e vincula a conta da plataforma ao WhatsApp
	 * @param {string} code
	 * @param {string} platform - "telegram" | "discord"
	 * @param {string} platformId
	 * @returns {Promise<{ success: boolean, whatsappId?: string, error?: string }>}
	 */
	async linkAccount(code, platform, platformId) {
		if (!code || !platform || !platformId) {
			return { success: false, error: "missing_parameters" };
		}

		const cleanCode = String(code).trim().toLowerCase();
		const cleanPlatform = String(platform).toLowerCase().trim();
		const cleanPlatformId = String(platformId).split("@")[0].trim();

		const row = await this.database.dbGet(
			this.DB_NAME,
			"SELECT code, whatsapp_id, expires_at FROM link_codes WHERE code = ?",
			[cleanCode]
		);

		if (!row) {
			return { success: false, error: "invalid_code" };
		}

		const now = Date.now();
		if (Number(row.expires_at) < now) {
			await this.database.dbRun(this.DB_NAME, "DELETE FROM link_codes WHERE code = ?", [cleanCode]);
			return { success: false, error: "expired_code" };
		}

		const whatsappId = String(row.whatsapp_id).replace(/\D/g, "");

		// Remove vínculo anterior se esta conta da plataforma já estava vinculada a outro whatsapp
		const previousWa = this.platformToWa.get(`${cleanPlatform}:${cleanPlatformId}`);
		if (previousWa) {
			this.waToPlatform.delete(`${cleanPlatform}:${previousWa}`);
		}

		// Se o mesmo WhatsApp já tinha outro ID dessa plataforma vinculado, remove também
		const previousPlatformId = this.waToPlatform.get(`${cleanPlatform}:${whatsappId}`);
		if (previousPlatformId) {
			this.platformToWa.delete(`${cleanPlatform}:${previousPlatformId}`);
		}

		// Insere ou atualiza vínculo
		await this.database.dbRun(
			this.DB_NAME,
			`INSERT INTO linked_accounts (platform, platform_id, whatsapp_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(platform, platform_id) DO UPDATE SET
			 whatsapp_id = excluded.whatsapp_id,
			 updated_at = excluded.updated_at`,
			[cleanPlatform, cleanPlatformId, whatsappId, now, now]
		);

		// Atualiza cache em memória
		this.platformToWa.set(`${cleanPlatform}:${cleanPlatformId}`, whatsappId);
		this.waToPlatform.set(`${cleanPlatform}:${whatsappId}`, cleanPlatformId);

		// Remove o código consumido (uso único)
		await this.database.dbRun(this.DB_NAME, "DELETE FROM link_codes WHERE code = ?", [cleanCode]);

		this.logger.info(
			`Conta vinculada com sucesso: [${cleanPlatform}] ${cleanPlatformId} <-> [whatsapp] ${whatsappId}`
		);

		return {
			success: true,
			whatsappId,
			platform: cleanPlatform,
			platformId: cleanPlatformId
		};
	}

	/**
	 * Desvincula uma conta de plataforma específica
	 * @param {string} platform
	 * @param {string} platformId
	 * @returns {Promise<boolean>}
	 */
	async unlink(platform, platformId) {
		const cleanPlatform = String(platform).toLowerCase().trim();
		const cleanPlatformId = String(platformId).split("@")[0].trim();

		const waId = this.platformToWa.get(`${cleanPlatform}:${cleanPlatformId}`);
		if (waId) {
			this.waToPlatform.delete(`${cleanPlatform}:${waId}`);
		}
		this.platformToWa.delete(`${cleanPlatform}:${cleanPlatformId}`);

		await this.database.dbRun(
			this.DB_NAME,
			"DELETE FROM linked_accounts WHERE platform = ? AND platform_id = ?",
			[cleanPlatform, cleanPlatformId]
		);

		return true;
	}

	/**
	 * Desvincula todas as contas ou uma plataforma específica de um WhatsApp
	 * @param {string} whatsappId
	 * @param {string} [platform]
	 * @returns {Promise<boolean>}
	 */
	async unlinkWhatsApp(whatsappId, platform = null) {
		const cleanWaId = String(whatsappId).replace(/\D/g, "");

		if (platform) {
			const cleanPlatform = String(platform).toLowerCase().trim();
			const platformId = this.waToPlatform.get(`${cleanPlatform}:${cleanWaId}`);
			if (platformId) {
				this.platformToWa.delete(`${cleanPlatform}:${platformId}`);
			}
			this.waToPlatform.delete(`${cleanPlatform}:${cleanWaId}`);

			await this.database.dbRun(
				this.DB_NAME,
				"DELETE FROM linked_accounts WHERE platform = ? AND whatsapp_id = ?",
				[cleanPlatform, cleanWaId]
			);
		} else {
			const tgId = this.waToPlatform.get(`telegram:${cleanWaId}`);
			if (tgId) this.platformToWa.delete(`telegram:${tgId}`);

			const dcId = this.waToPlatform.get(`discord:${cleanWaId}`);
			if (dcId) this.platformToWa.delete(`discord:${dcId}`);

			this.waToPlatform.delete(`telegram:${cleanWaId}`);
			this.waToPlatform.delete(`discord:${cleanWaId}`);

			await this.database.dbRun(this.DB_NAME, "DELETE FROM linked_accounts WHERE whatsapp_id = ?", [
				cleanWaId
			]);
		}

		return true;
	}
}

module.exports = AccountLinkService;
