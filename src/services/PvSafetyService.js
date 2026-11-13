"use strict";

const crypto = require("crypto");
const Database = require("../utils/Database");
const PhoneUtils = require("../utils/PhoneUtils");
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");

const DB_NAME = "pv_users";
const VCARD_COOLDOWN_DAYS = 45;
const VCARD_COOLDOWN_MS = VCARD_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const PV_REQUIRED_MESSAGE =
	"🫸 Preciso que você me mande este comando no privado pelo menos uma vez para evitar detecção por spam!";
const VCARD_REMINDER_PREFIX =
	"Salve a ravena nos seus contatos! Isso nos ajuda a prevenir os bans 👊";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pv_users (
    bot_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    user_lid TEXT,
    has_pv INTEGER DEFAULT 0,
    first_pv_at INTEGER,
    last_pv_at INTEGER,
    last_vcard_sent_at INTEGER DEFAULT 0,
    updated_at INTEGER,
    PRIMARY KEY (bot_id, user_key)
  );
  CREATE INDEX IF NOT EXISTS idx_pv_users_bot_lid ON pv_users(bot_id, user_lid);
`;

class PvSafetyService {
	static instance = null;

	/**
	 * Retorna a instância singleton do PvSafetyService.
	 * @returns {PvSafetyService}
	 */
	static getInstance() {
		if (!PvSafetyService.instance) {
			PvSafetyService.instance = new PvSafetyService();
		}
		return PvSafetyService.instance;
	}

	constructor() {
		this.logger = new Logger("pv-safety-service");
		this.database = Database.getInstance();
		this.database.getSQLiteDb(DB_NAME, SCHEMA);
		this._testRecords = new Map();
		this._vcardLocks = new Set();

		this.VCARD_COOLDOWN_DAYS = VCARD_COOLDOWN_DAYS;
		this.VCARD_COOLDOWN_MS = VCARD_COOLDOWN_MS;
		this.PV_REQUIRED_MESSAGE = PV_REQUIRED_MESSAGE;
		this.VCARD_REMINDER_PREFIX = VCARD_REMINDER_PREFIX;
	}

	/**
	 * Limpa o estado em memória usado durante testMode.
	 */
	resetTestState() {
		this._testRecords.clear();
		this._vcardLocks.clear();
	}

	/**
	 * Indica se o bot pertence ao WhatsApp.
	 * @param {Object|null} bot
	 * @returns {boolean}
	 */
	isWhatsAppBot(bot) {
		return Boolean(bot && !bot.useTelegram && !bot.useDiscord);
	}

	/**
	 * Indica se o bot deve enviar vCard no PV (apenas WhatsApp não-privado).
	 * @param {Object|null} bot
	 * @returns {boolean}
	 */
	shouldSendVcard(bot) {
		return this.isWhatsAppBot(bot) && !bot.privado;
	}

	/**
	 * Retorna o identificador estável do bot para chaveamento no banco.
	 * @param {Object|null} bot
	 * @returns {string}
	 */
	getBotId(bot) {
		return String(bot?.id || bot?.instanceName || "default").trim();
	}

	/**
	 * Indica se o destino informado representa um chat privado (PV) de usuário no WhatsApp.
	 * @param {string|null|undefined} chatId
	 * @returns {boolean}
	 */
	isPvTarget(chatId) {
		if (!chatId || typeof chatId !== "string") return false;
		const trimmed = chatId.trim();
		if (!trimmed) return false;
		if (
			trimmed.includes("@g.us") ||
			trimmed.includes("broadcast") ||
			trimmed.includes("newsletter")
		) {
			return false;
		}
		const cleanPart = trimmed.split("@")[0].split(":")[0];
		// Grupos legados salvos sem sufixo @g.us (ex.: bots.json)
		if (/^120363\d{10,}$/.test(cleanPart)) {
			return false;
		}
		return true;
	}

	/**
	 * Verifica se o identificador pertence ao próprio número conectado do bot.
	 * @param {Object|null} bot
	 * @param {string|null|undefined} target
	 * @returns {boolean}
	 */
	isOwnBotNumber(bot, target) {
		const botPhone = PhoneUtils.cleanPhone(bot?.phoneNumber);
		if (!botPhone || !target) return false;
		return PhoneUtils.isSamePhone(botPhone, target);
	}

	/**
	 * Extrai todos os candidatos de PN e LID a partir de um objeto message ou string JID.
	 * @param {Object|null} bot
	 * @param {Object|string|null} targetOrMessage
	 * @returns {Promise<{pnKeys: string[], lidKeys: string[], primaryKey: string|null, primaryLid: string|null}>}
	 */
	async resolveIdentity(bot, targetOrMessage) {
		const rawCandidates = this._collectRawCandidates(targetOrMessage);
		const pnKeys = new Set();
		const lidKeys = new Set();
		let preferredPrimaryPn = null;

		for (const raw of rawCandidates) {
			if (!this.isPvTarget(raw)) continue;

			if (raw.includes("@lid")) {
				const cleanLid = this._extractCleanDigits(raw);
				if (!cleanLid) continue;
				const fullLid = `${cleanLid}@lid`;
				lidKeys.add(fullLid);

				const mappedPn = this._lookupCachedPnForLid(bot, raw, cleanLid);
				if (mappedPn) {
					preferredPrimaryPn = preferredPrimaryPn || mappedPn;
					for (const variant of PhoneUtils.getPhoneVariants(mappedPn)) {
						pnKeys.add(variant);
					}
				}
				continue;
			}

			const cleanDigits = this._extractCleanDigits(raw);
			if (!cleanDigits) continue;

			const cachedMapped = this._lookupCachedPnForLid(bot, raw, cleanDigits);
			if (cachedMapped) {
				lidKeys.add(`${cleanDigits}@lid`);
				preferredPrimaryPn = preferredPrimaryPn || cachedMapped;
				for (const variant of PhoneUtils.getPhoneVariants(cachedMapped)) {
					pnKeys.add(variant);
				}
				continue;
			}

			preferredPrimaryPn = preferredPrimaryPn || cleanDigits;
			for (const variant of PhoneUtils.getPhoneVariants(cleanDigits)) {
				pnKeys.add(variant);
			}
		}

		// Se só temos @lid, tenta resolução assíncrona via bot.getPnFromLid se disponível
		if (pnKeys.size === 0 && lidKeys.size > 0 && typeof bot?.getPnFromLid === "function") {
			for (const lid of lidKeys) {
				try {
					const resolvedPn = await bot.getPnFromLid(lid);
					const cleanResolved = PhoneUtils.cleanPhone(resolvedPn);
					if (cleanResolved) {
						preferredPrimaryPn = preferredPrimaryPn || cleanResolved;
						for (const variant of PhoneUtils.getPhoneVariants(cleanResolved)) {
							pnKeys.add(variant);
						}
						break;
					}
				} catch {
					// Fallback silencioso para manter o @lid como chave
				}
			}
		}

		const pnList = Array.from(pnKeys);
		const lidList = Array.from(lidKeys);
		const primaryKey = preferredPrimaryPn || pnList[0] || lidList[0] || null;
		const primaryLid = lidList[0] || null;

		return { pnKeys: pnList, lidKeys: lidList, primaryKey, primaryLid };
	}

	/**
	 * Coleta strings candidatas de JID/telefone a partir de message ou string simples.
	 * @private
	 */
	_collectRawCandidates(targetOrMessage) {
		if (!targetOrMessage) return [];
		if (typeof targetOrMessage === "string") {
			return [targetOrMessage.trim()].filter(Boolean);
		}
		if (typeof targetOrMessage === "object") {
			return [
				targetOrMessage.author,
				targetOrMessage.authorAlt,
				targetOrMessage.goMessageData?.Info?.Sender,
				targetOrMessage.goMessageData?.Info?.SenderAlt,
				targetOrMessage.from
			].filter((v) => typeof v === "string" && v.trim().length > 0);
		}
		return [];
	}

	/**
	 * Extrai apenas dígitos da parte local de um JID ou telefone.
	 * @private
	 */
	_extractCleanDigits(jidOrPhone) {
		const cleaned = PhoneUtils.cleanPhone(jidOrPhone);
		if (cleaned) return cleaned;
		const rawLocal = String(jidOrPhone).split("@")[0].split(":")[0].replace(/\D/g, "");
		return rawLocal || "";
	}

	/**
	 * Busca PN mapeado para um LID no cache do bot.
	 * @private
	 */
	_lookupCachedPnForLid(bot, raw, cleanLid) {
		const cache = bot?.lidToPnCache;
		if (!cache || typeof cache.get !== "function") return null;
		const hit = cache.get(raw) || cache.get(cleanLid) || cache.get(`${cleanLid}@lid`);
		return hit ? PhoneUtils.cleanPhone(hit) : null;
	}

	/**
	 * Busca o registro do usuário para um bot específico considerando variantes PN e LID.
	 * @param {string} botId
	 * @param {{pnKeys: string[], lidKeys: string[]}} identity
	 * @returns {Promise<Object|null>}
	 */
	async _findRecord(botId, identity) {
		const allKeys = Array.from(new Set([...identity.pnKeys, ...identity.lidKeys]));
		if (allKeys.length === 0 && identity.lidKeys.length === 0) {
			return null;
		}

		if (this.database.testMode) {
			const botMap = this._testRecords.get(botId);
			if (!botMap) return null;
			for (const rec of botMap.values()) {
				if (allKeys.includes(rec.user_key)) return rec;
				if (rec.user_lid && identity.lidKeys.includes(rec.user_lid)) return rec;
			}
			return null;
		}

		const clauses = [];
		const params = [botId];

		if (allKeys.length > 0) {
			clauses.push(`user_key IN (${allKeys.map(() => "?").join(", ")})`);
			params.push(...allKeys);
		}
		if (identity.lidKeys.length > 0) {
			clauses.push(`user_lid IN (${identity.lidKeys.map(() => "?").join(", ")})`);
			params.push(...identity.lidKeys);
		}

		const sql = `SELECT * FROM pv_users WHERE bot_id = ? AND (${clauses.join(" OR ")}) LIMIT 1`;
		return await this.database.dbGet(DB_NAME, sql, params);
	}

	/**
	 * Persiste ou atualiza um registro na tabela pv_users (ou em memória no testMode).
	 * @private
	 */
	async _upsertRecord(botId, existing, data) {
		const nextRecord = {
			bot_id: botId,
			user_key: data.user_key,
			user_lid: data.user_lid ?? existing?.user_lid ?? null,
			has_pv: data.has_pv ?? existing?.has_pv ?? 0,
			first_pv_at: data.first_pv_at ?? existing?.first_pv_at ?? null,
			last_pv_at: data.last_pv_at ?? existing?.last_pv_at ?? null,
			last_vcard_sent_at: data.last_vcard_sent_at ?? existing?.last_vcard_sent_at ?? 0,
			updated_at: data.updated_at || Date.now()
		};

		if (this.database.testMode) {
			if (!this._testRecords.has(botId)) {
				this._testRecords.set(botId, new Map());
			}
			const botMap = this._testRecords.get(botId);
			if (existing && existing.user_key !== nextRecord.user_key) {
				botMap.delete(existing.user_key);
			}
			botMap.set(nextRecord.user_key, nextRecord);
			return nextRecord;
		}

		if (existing && existing.user_key !== nextRecord.user_key) {
			await this.database.dbRun(DB_NAME, "DELETE FROM pv_users WHERE bot_id = ? AND user_key = ?", [
				botId,
				existing.user_key
			]);
		}

		await this.database.dbRun(
			DB_NAME,
			`INSERT INTO pv_users (
				bot_id, user_key, user_lid, has_pv, first_pv_at, last_pv_at, last_vcard_sent_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(bot_id, user_key) DO UPDATE SET
				user_lid = COALESCE(excluded.user_lid, pv_users.user_lid),
				has_pv = MAX(pv_users.has_pv, excluded.has_pv),
				first_pv_at = COALESCE(pv_users.first_pv_at, excluded.first_pv_at),
				last_pv_at = MAX(COALESCE(pv_users.last_pv_at, 0), COALESCE(excluded.last_pv_at, 0)),
				last_vcard_sent_at = MAX(COALESCE(pv_users.last_vcard_sent_at, 0), COALESCE(excluded.last_vcard_sent_at, 0)),
				updated_at = excluded.updated_at`,
			[
				nextRecord.bot_id,
				nextRecord.user_key,
				nextRecord.user_lid,
				nextRecord.has_pv,
				nextRecord.first_pv_at,
				nextRecord.last_pv_at,
				nextRecord.last_vcard_sent_at,
				nextRecord.updated_at
			]
		);

		return nextRecord;
	}

	/**
	 * Registra que o usuário já iniciou contato no privado (isGroup === false) com este bot.
	 * @param {Object} bot
	 * @param {Object|string} targetOrMessage
	 * @param {number} [now=Date.now()]
	 * @returns {Promise<boolean>}
	 */
	async recordPvInteraction(bot, targetOrMessage, now = Date.now()) {
		if (!this.isWhatsAppBot(bot)) return false;

		if (targetOrMessage && typeof targetOrMessage === "object") {
			if (targetOrMessage.group || targetOrMessage.isNewsletter || targetOrMessage.fromMe) {
				return false;
			}
		}

		const identity = await this.resolveIdentity(bot, targetOrMessage);
		if (!identity.primaryKey) return false;

		const botId = this.getBotId(bot);
		const existing = await this._findRecord(botId, identity);

		// Se o registro anterior estava salvo só com @lid e agora temos o PN, promovemos a chave para o PN
		const targetKey =
			existing && !existing.user_key.includes("@lid") ? existing.user_key : identity.primaryKey;

		await this._upsertRecord(botId, existing, {
			user_key: targetKey,
			user_lid: identity.primaryLid || existing?.user_lid || null,
			has_pv: 1,
			first_pv_at: existing?.first_pv_at || now,
			last_pv_at: now,
			last_vcard_sent_at: existing?.last_vcard_sent_at || 0,
			updated_at: now
		});

		return true;
	}

	/**
	 * Verifica se o usuário já enviou pelo menos uma mensagem no privado para este bot.
	 * @param {Object} bot
	 * @param {Object|string} targetOrMessage
	 * @returns {Promise<boolean>}
	 */
	async hasPvInteraction(bot, targetOrMessage) {
		if (!this.isWhatsAppBot(bot)) return true;

		const identity = await this.resolveIdentity(bot, targetOrMessage);
		if (!identity.primaryKey) return false;

		if (this.isOwnBotNumber(bot, identity.primaryKey)) {
			return true;
		}

		const botId = this.getBotId(bot);
		const record = await this._findRecord(botId, identity);
		return Boolean(record && Number(record.has_pv) === 1);
	}

	/**
	 * Valida se um comando executado em grupo tem permissão para enviar mensagem no privado do autor.
	 * Caso não tenha, retorna o ReturnMessage padrão instruindo a chamar no privado primeiro.
	 * @param {Object} bot
	 * @param {Object} message
	 * @returns {Promise<{allowed: boolean, returnMessage: ReturnMessage|null}>}
	 */
	async ensureGroupPvAllowed(bot, message) {
		if (!this.isWhatsAppBot(bot)) {
			return { allowed: true, returnMessage: null };
		}

		const isFromPrivate =
			!message?.group ||
			Boolean(message.managementResponseChatId) ||
			Boolean(message.isManagingFromPrivate);

		if (isFromPrivate) {
			return { allowed: true, returnMessage: null };
		}

		const allowed = await this.hasPvInteraction(bot, message);
		if (allowed) {
			return { allowed: true, returnMessage: null };
		}

		const returnMessage = new ReturnMessage({
			chatId: message.group,
			content: PV_REQUIRED_MESSAGE,
			reaction: "🫸",
			options: message.origin?.id?._serialized
				? {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				: undefined
		});

		return { allowed: false, returnMessage };
	}

	/**
	 * Verifica se já se passaram >= 45 dias desde o último vCard enviado para (bot, usuário).
	 * @param {Object} bot
	 * @param {Object|string} targetOrMessage
	 * @param {number} [now=Date.now()]
	 * @returns {Promise<boolean>}
	 */
	async shouldSendVcardNow(bot, targetOrMessage, now = Date.now()) {
		if (!this.shouldSendVcard(bot)) return false;

		const botPhone = PhoneUtils.cleanPhone(bot?.phoneNumber);
		if (!botPhone) return false;

		const targetStr =
			typeof targetOrMessage === "string"
				? targetOrMessage
				: targetOrMessage?.author || targetOrMessage?.authorAlt;
		if (!this.isPvTarget(targetStr) || this.isOwnBotNumber(bot, targetStr)) {
			return false;
		}

		const identity = await this.resolveIdentity(bot, targetOrMessage);
		if (!identity.primaryKey) return false;

		const botId = this.getBotId(bot);
		const record = await this._findRecord(botId, identity);
		const lastSent = Number(record?.last_vcard_sent_at || 0);
		if (!lastSent) return true;

		return now - lastSent >= VCARD_COOLDOWN_MS;
	}

	/**
	 * Atualiza o timestamp do último vCard enviado para (bot, usuário).
	 * @param {Object} bot
	 * @param {Object|string} targetOrMessage
	 * @param {number} [now=Date.now()]
	 * @returns {Promise<void>}
	 */
	async markVcardSent(bot, targetOrMessage, now = Date.now()) {
		if (!this.isWhatsAppBot(bot)) return;

		const identity = await this.resolveIdentity(bot, targetOrMessage);
		if (!identity.primaryKey) return;

		const botId = this.getBotId(bot);
		const existing = await this._findRecord(botId, identity);
		const targetKey =
			existing && !existing.user_key.includes("@lid") ? existing.user_key : identity.primaryKey;

		await this._upsertRecord(botId, existing, {
			user_key: targetKey,
			user_lid: identity.primaryLid || existing?.user_lid || null,
			has_pv: existing?.has_pv ?? 0,
			first_pv_at: existing?.first_pv_at ?? null,
			last_pv_at: existing?.last_pv_at ?? null,
			last_vcard_sent_at: now,
			updated_at: now
		});
	}

	/**
	 * Adquire lock em memória para evitar envio duplicado concorrente de vCard no mesmo chat.
	 * @param {Object} bot
	 * @param {string} chatId
	 * @returns {Promise<string|null>}
	 */
	async acquireVcardLock(bot, chatId) {
		const identity = await this.resolveIdentity(bot, chatId);
		if (!identity.primaryKey) return null;
		const key = `${this.getBotId(bot)}:${identity.primaryKey}`;
		if (this._vcardLocks.has(key)) {
			return null;
		}
		this._vcardLocks.add(key);
		return key;
	}

	/**
	 * Libera lock em memória do envio de vCard.
	 * @param {string|null} lockKey
	 */
	releaseVcardLock(lockKey) {
		if (lockKey) {
			this._vcardLocks.delete(lockKey);
		}
	}

	/**
	 * Gera objeto de conteúdo compatível com WhatsAppBotGo.sendMessage (/send/contact).
	 * @param {Object} bot
	 * @returns {{isContact: boolean, name: string, number: string, organization: string}}
	 */
	buildVcardPayload(bot) {
		const randomTag = crypto.randomBytes(4).toString("hex");
		const displayName = String(bot?.nomeExibir || bot?.id || "Ravena").trim();
		const number = PhoneUtils.cleanPhone(bot?.phoneNumber);
		return {
			isContact: true,
			name: displayName,
			number,
			organization: `Ravena AI [${randomTag}]`
		};
	}

	/**
	 * Gera a mensagem de texto pedindo para salvar o contato, com hash aleatório no final.
	 * @returns {string}
	 */
	buildVcardReminderMessage() {
		const randomString = crypto.randomBytes(5).toString("hex");
		return `${VCARD_REMINDER_PREFIX}\n> ${randomString}`;
	}
}

module.exports = PvSafetyService;
