"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
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

// Quem acabou de mandar mensagem no PV sempre pode receber resposta direta, mesmo que o
// registro em pv_users ainda não tenha sido gravado (ou o SQLite esteja indisponível).
const PV_INBOUND_ALLOWANCE_MS = 24 * 60 * 60 * 1000;
const PV_ALLOWANCE_MAX_ENTRIES = 100000;
// Usuário que já está com has_pv=1 não precisa gravar a cada mensagem recebida no PV.
const PV_WRITE_THROTTLE_MS = 60 * 60 * 1000;
const PV_WRITE_THROTTLE_MAX_ENTRIES = 50000;

const PV_COLD_BLOCKED_CODE = "PV_COLD_BLOCKED";
const BACKFILL_MARKER_KEY = "backfill_pv_users_v1";
const BOT_KEY_MIGRATION_MARKER_KEY = "bot_key_phone_v1";

// IDs "soltos" (sem sufixo) vindos de tabelas sem plataforma podem ser IDs de Telegram/Discord.
// Nesses casos só aceitamos o tamanho de um telefone com DDI (12-13) ou de um LID (14-15).
const STRICT_BARE_ID_REGEX = /^\d{12,15}$/;
const LOOSE_BARE_ID_REGEX = /^\d{8,20}$/;

/**
 * Fontes de dados que provam que o usuário já conversou com o bot no privado.
 * - perBot: a linha tem o id do bot (bots.json "nome"); sem id, vale para todos os bots de WhatsApp.
 * - strict: IDs sem sufixo só são aceitos com tamanho de telefone com DDI ou LID.
 * Fontes NÃO usadas (não provam PV): anon_msgs (antes de aa45040 o !anonimo podia ser usado em grupo),
 * bank/fazenda/waifu (comandos executáveis em grupo), msgranking (contagem de grupos).
 */
const BACKFILL_SOURCES = [
	{
		// !lembrete criado no PV: chat_id = JID do PV (message.from)
		name: "lembretes",
		file: "lembretes.db",
		sql: "SELECT chat_id AS user, bot_id AS bot_id, criado_em AS ts FROM lembretes",
		perBot: true
	},
	{
		// Saudação enviada em resposta a uma mensagem recebida no PV (UserGreetingManager)
		name: "greeted_users",
		file: "greeted_users.db",
		sql: "SELECT user_id AS user, bot_id AS bot_id, timestamp AS ts FROM greeted_users",
		perBot: true
	},
	{
		// !correios no PV: chat_id = autor (sem id do bot)
		name: "correios",
		file: "correios.db",
		sql: "SELECT chat_id AS user, last_check AS ts FROM tracks",
		perBot: false,
		strict: true
	},
	{
		// !copa-seguir no PV: chat_id = JID do PV (message.from)
		name: "copa_seguir",
		file: "copa_seguir.db",
		sql: "SELECT chat_id AS user, created_at AS ts FROM copa_seguindo",
		perBot: false,
		strict: true,
		requireSuffix: true
	},
	{
		// !vincular só funciona no PV do WhatsApp desde a criação do comando
		name: "linked_accounts",
		file: "linked_accounts.db",
		sql: "SELECT whatsapp_id AS user, created_at AS ts FROM linked_accounts UNION ALL SELECT whatsapp_id AS user, created_at AS ts FROM link_codes",
		perBot: false,
		strict: true
	},
	{
		// Links de convite só são processados em mensagens recebidas no PV (InviteSystem)
		name: "invite_history",
		file: "core.db",
		sql: "SELECT author_id AS user, timestamp AS ts FROM invite_history",
		perBot: false,
		strict: true
	}
];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pv_users (
    bot_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    user_lid TEXT,
    user_pn TEXT,
    has_pv INTEGER DEFAULT 0,
    first_pv_at INTEGER,
    last_pv_at INTEGER,
    last_vcard_sent_at INTEGER DEFAULT 0,
    updated_at INTEGER,
    PRIMARY KEY (bot_id, user_key)
  );
  CREATE INDEX IF NOT EXISTS idx_pv_users_bot_lid ON pv_users(bot_id, user_lid);
  CREATE TABLE IF NOT EXISTS pv_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  );
`;

// Mescla preservando sempre a informação "mais forte" (has_pv=1, vCard mais recente etc.)
const UPSERT_MERGE_SQL = `
	ON CONFLICT(bot_id, user_key) DO UPDATE SET
		user_lid = COALESCE(excluded.user_lid, pv_users.user_lid),
		user_pn = COALESCE(excluded.user_pn, pv_users.user_pn),
		has_pv = MAX(COALESCE(pv_users.has_pv, 0), COALESCE(excluded.has_pv, 0)),
		first_pv_at = MIN(
			COALESCE(pv_users.first_pv_at, excluded.first_pv_at),
			COALESCE(excluded.first_pv_at, pv_users.first_pv_at)
		),
		last_pv_at = MAX(COALESCE(pv_users.last_pv_at, 0), COALESCE(excluded.last_pv_at, 0)),
		last_vcard_sent_at = MAX(COALESCE(pv_users.last_vcard_sent_at, 0), COALESCE(excluded.last_vcard_sent_at, 0)),
		updated_at = MAX(COALESCE(pv_users.updated_at, 0), COALESCE(excluded.updated_at, 0))`;

const INSERT_COLUMNS =
	"bot_id, user_key, user_lid, user_pn, has_pv, first_pv_at, last_pv_at, last_vcard_sent_at, updated_at";

/**
 * Erro lançado por sendMessage quando o envio no PV é bloqueado por falta de interação prévia.
 * Permite que loops de fallback tentem o próximo bot e que chamadores tratem o bloqueio.
 */
class PvColdBlockedError extends Error {
	constructor(chatId, botId) {
		super(
			`Envio frio bloqueado em PV para ${chatId} (bot ${botId}): sem interação prévia no privado.`
		);
		this.name = "PvColdBlockedError";
		this.code = PV_COLD_BLOCKED_CODE;
		this.blockedByPvSafety = true;
		this.chatId = chatId;
		this.botId = botId;
	}
}

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

	/**
	 * Indica se o erro é um bloqueio de envio frio no PV.
	 * @param {*} err
	 * @returns {boolean}
	 */
	static isColdBlockedError(err) {
		return Boolean(err && (err.code === PV_COLD_BLOCKED_CODE || err.blockedByPvSafety === true));
	}

	constructor() {
		this.logger = new Logger("pv-safety-service");
		this.database = Database.getInstance();
		this.database.getSQLiteDb(DB_NAME, SCHEMA);
		this._ensureSchemaColumns();
		this._testRecords = new Map();
		this._testMeta = new Map();
		this._vcardLocks = new Set();
		this._pvAllowance = new Map();
		this._recentWrites = new Map();

		this.VCARD_COOLDOWN_DAYS = VCARD_COOLDOWN_DAYS;
		this.VCARD_COOLDOWN_MS = VCARD_COOLDOWN_MS;
		this.PV_REQUIRED_MESSAGE = PV_REQUIRED_MESSAGE;
		this.VCARD_REMINDER_PREFIX = VCARD_REMINDER_PREFIX;
		this.PV_INBOUND_ALLOWANCE_MS = PV_INBOUND_ALLOWANCE_MS;
		this.PV_WRITE_THROTTLE_MS = PV_WRITE_THROTTLE_MS;
		this.PV_COLD_BLOCKED_CODE = PV_COLD_BLOCKED_CODE;
		this.BACKFILL_MARKER_KEY = BACKFILL_MARKER_KEY;
	}

	/**
	 * Migração de colunas para bancos criados antes de user_pn existir.
	 * Usa a conexão direta (mappers) para não ser bloqueada pelo testMode do Database.
	 * @private
	 */
	_ensureSchemaColumns() {
		const mappers = this.database?.mappers;
		if (!mappers) return;
		try {
			const columns = mappers.all(DB_NAME, "PRAGMA table_info(pv_users)").map((c) => c.name);
			if (!columns.includes("user_pn")) {
				mappers.exec(DB_NAME, "ALTER TABLE pv_users ADD COLUMN user_pn TEXT");
				this.logger.info("[PV-SAFETY] Coluna user_pn adicionada em pv_users.");
			}
			mappers.exec(
				DB_NAME,
				"CREATE INDEX IF NOT EXISTS idx_pv_users_bot_pn ON pv_users(bot_id, user_pn)"
			);
		} catch (err) {
			this.logger.warn(`[PV-SAFETY] Falha ao migrar colunas de pv_users: ${err?.message || err}`);
		}
	}

	/**
	 * Limpa o estado em memória (registros de testMode, locks, liberações temporárias e throttle).
	 */
	resetTestState() {
		this._testRecords.clear();
		this._testMeta.clear();
		this._vcardLocks.clear();
		this._pvAllowance.clear();
		this._recentWrites.clear();
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
	 * Forma canônica de um telefone (independente de 12/13 dígitos no Brasil).
	 * Escolhe a variante mais longa (ex.: com o 9 adicional) para ficar estável entre formatos.
	 * @param {string|number} phone
	 * @returns {string}
	 */
	canonicalPhone(phone) {
		const clean = PhoneUtils.cleanPhone(phone);
		if (!clean) return "";
		const variants = PhoneUtils.getPhoneVariants(clean);
		if (!variants.length) return clean;
		return [...variants].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
	}

	/**
	 * Chave do bot no banco: número de telefone conectado (canônico) com fallback para o id.
	 * Chavear pelo número evita que um id reaproveitado com outro chip herde o histórico de PV.
	 * @param {Object|null} bot
	 * @returns {string}
	 */
	getBotKey(bot) {
		const phone = this.canonicalPhone(bot?.phoneNumber);
		if (phone) return phone;
		return String(bot?.id || bot?.instanceName || "default").trim();
	}

	/**
	 * Alias mantido por compatibilidade: agora retorna a chave baseada no número do bot.
	 * @param {Object|null} bot
	 * @returns {string}
	 */
	getBotId(bot) {
		return this.getBotKey(bot);
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
		// Grupos antigos no formato <criador>-<timestamp> (ex.: 5511999999999-1580000000)
		if (/^\d+-\d+$/.test(cleanPart)) {
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
	 * Cria o erro tipado de bloqueio de envio frio no PV.
	 * @param {string} chatId
	 * @param {Object} bot
	 * @returns {PvColdBlockedError}
	 */
	createColdBlockedError(chatId, bot) {
		return new PvColdBlockedError(chatId, bot?.id || this.getBotKey(bot));
	}

	// ---------------------------------------------------------------------------
	// Resolução de identidade (PN x LID)
	// ---------------------------------------------------------------------------

	/**
	 * Extrai todos os candidatos de PN e LID a partir de um objeto message ou string JID.
	 *
	 * Em produção message.author chega como dígitos "soltos" (sem sufixo) e pode ser tanto
	 * telefone quanto LID. Por isso:
	 * - candidatos com sufixo (@lid / @s.whatsapp.net) são classificados primeiro;
	 * - dígitos soltos iguais a um LID conhecido (ou mapeados no lidToPnCache) são tratados como LID;
	 * - dígitos soltos ambíguos são consultados tanto como telefone quanto como `${digits}@lid`.
	 *
	 * @param {Object|null} bot
	 * @param {Object|string|null} targetOrMessage
	 * @returns {Promise<Object>} identidade com pnKeys, lidKeys, allKeys, primaryKey, primaryPn, primaryLid...
	 */
	async resolveIdentity(bot, targetOrMessage) {
		const base = this._resolveIdentitySync(bot, targetOrMessage);
		await this._enrichIdentity(bot, base);
		return this._finalizeIdentity(base);
	}

	/**
	 * Completa a identidade usando os resolvedores do bot (PN <-> LID).
	 * bot.getPnFromLid devolve o próprio LID quando não sabe; bot.getLidFromPn devolve o PN.
	 * @private
	 */
	async _enrichIdentity(bot, base) {
		if (
			base.pnDigits.length === 0 &&
			base.lidDigits.length > 0 &&
			typeof bot?.getPnFromLid === "function"
		) {
			for (const lid of base.lidDigits) {
				try {
					const resolved = await bot.getPnFromLid(`${lid}@lid`);
					const pn = this._acceptResolvedPn(resolved, lid);
					if (pn) {
						base.pnDigits.push(pn);
						break;
					}
				} catch {
					// Fallback silencioso para manter o @lid como chave
				}
			}
		}

		// Só temos PN (ou dígitos ambíguos): tenta achar o LID (linhas gravadas quando o PN
		// ainda não era conhecido)
		const pnCandidates = [...base.pnDigits, ...base.ambiguousDigits];
		if (
			base.lidDigits.length === 0 &&
			pnCandidates.length > 0 &&
			typeof bot?.getLidFromPn === "function"
		) {
			for (const pn of pnCandidates) {
				try {
					const resolved = await bot.getLidFromPn(pn);
					const lid = this._acceptResolvedLid(resolved, pn);
					if (lid) {
						base.lidDigits.push(lid);
						// Dígitos ambíguos com LID associado são, na verdade, um telefone
						const ambiguousIndex = base.ambiguousDigits.indexOf(pn);
						if (ambiguousIndex !== -1) {
							base.ambiguousDigits.splice(ambiguousIndex, 1);
							if (!base.pnDigits.includes(pn)) base.pnDigits.push(pn);
						}
						break;
					}
				} catch {
					// Sem LID conhecido
				}
			}
		}
		return base;
	}

	/**
	 * Parte síncrona da resolução (sem bot.getPnFromLid).
	 * @private
	 */
	_resolveIdentitySync(bot, targetOrMessage) {
		const raws = this._collectRawCandidates(targetOrMessage).filter((r) => this.isPvTarget(r));
		const pnDigits = [];
		const lidDigits = [];
		const bareDigits = [];
		const pushUnique = (arr, value) => {
			if (value && !arr.includes(value)) arr.push(value);
		};

		for (const raw of raws) {
			const digits = this._extractCleanDigits(raw);
			if (!digits) continue;
			const kind = this._classifyRaw(raw);
			if (kind === "lid") pushUnique(lidDigits, digits);
			else if (kind === "pn") pushUnique(pnDigits, digits);
			else pushUnique(bareDigits, digits);
		}

		// Telefone "com sufixo" que na verdade é um LID conhecido (ex.: `${lid}@s.whatsapp.net`)
		for (let i = pnDigits.length - 1; i >= 0; i--) {
			const digits = pnDigits[i];
			if (lidDigits.includes(digits) || this._lookupCachedPnForLid(bot, digits)) {
				pnDigits.splice(i, 1);
				pushUnique(lidDigits, digits);
			}
		}

		const ambiguousDigits = [];
		for (const digits of bareDigits) {
			if (lidDigits.includes(digits)) continue;
			if (pnDigits.some((pn) => PhoneUtils.isSamePhone(pn, digits))) continue;
			if (this._lookupCachedPnForLid(bot, digits)) {
				pushUnique(lidDigits, digits);
				continue;
			}
			pushUnique(ambiguousDigits, digits);
		}

		for (const lid of lidDigits) {
			const mapped = this._lookupCachedPnForLid(bot, lid);
			if (mapped && !pnDigits.some((pn) => PhoneUtils.isSamePhone(pn, mapped))) {
				pnDigits.push(mapped);
			}
		}

		return { pnDigits, lidDigits, ambiguousDigits };
	}

	/**
	 * Monta as chaves de consulta e as chaves primárias a partir da classificação.
	 * @private
	 */
	_finalizeIdentity({ pnDigits, lidDigits, ambiguousDigits }) {
		const pnKeys = new Set();
		for (const digits of [...pnDigits, ...ambiguousDigits]) {
			for (const variant of PhoneUtils.getPhoneVariants(digits)) {
				pnKeys.add(variant);
			}
		}
		const lidLikeDigits = [...lidDigits, ...ambiguousDigits];
		const lidKeys = new Set(lidLikeDigits.map((d) => `${d}@lid`));

		const primaryPn = pnDigits.length ? this.canonicalPhone(pnDigits[0]) : null;
		const primaryLid = lidDigits.length ? `${lidDigits[0]}@lid` : null;
		const ambiguous = ambiguousDigits[0] || null;
		const primaryKey = primaryPn || primaryLid || ambiguous || null;

		// allKeys inclui os dígitos "soltos" do LID para casar com linhas antigas gravadas como user_key="777"
		const allKeys = Array.from(new Set([...pnKeys, ...lidKeys, ...lidLikeDigits]));

		return {
			pnKeys: Array.from(pnKeys),
			lidKeys: Array.from(lidKeys),
			allKeys,
			pnDigits: [...pnDigits],
			lidDigits: [...lidDigits],
			ambiguousDigits: [...ambiguousDigits],
			primaryPn,
			primaryLid,
			ambiguous,
			primaryKey
		};
	}

	/**
	 * Coleta strings candidatas de JID/telefone a partir de message ou string simples.
	 * Candidatos com sufixo vêm antes do author "solto". Em reações, usa apenas quem reagiu.
	 * @private
	 */
	_collectRawCandidates(targetOrMessage) {
		if (!targetOrMessage) return [];
		if (typeof targetOrMessage === "string") {
			return [targetOrMessage.trim()].filter(Boolean);
		}
		if (typeof targetOrMessage !== "object") return [];

		const isValid = (v) => typeof v === "string" && v.trim().length > 0;
		const reaction = targetOrMessage.originReaction;
		if (reaction && typeof reaction === "object") {
			// A mensagem sintética da reação mistura o autor da mensagem reagida (goMessageData/from)
			// com quem reagiu: só quem reagiu interessa aqui.
			return [reaction.senderIdAlt, reaction.senderId].filter(isValid).map((v) => v.trim());
		}

		return [
			targetOrMessage.goMessageData?.Info?.SenderAlt,
			targetOrMessage.goMessageData?.Info?.Sender,
			targetOrMessage.authorAlt,
			targetOrMessage.author,
			targetOrMessage.from
		]
			.filter(isValid)
			.map((v) => v.trim());
	}

	/**
	 * Classifica um candidato em "lid", "pn" (com sufixo de telefone) ou "bare" (só dígitos).
	 * @private
	 */
	_classifyRaw(raw) {
		const lower = String(raw).toLowerCase();
		if (lower.includes("@lid")) return "lid";
		if (lower.includes("@s.whatsapp.net") || lower.includes("@c.us")) return "pn";
		return "bare";
	}

	/**
	 * Extrai apenas dígitos da parte local de um JID ou telefone.
	 * @private
	 */
	_extractCleanDigits(jidOrPhone) {
		return PhoneUtils.cleanPhone(jidOrPhone) || "";
	}

	/**
	 * Aceita o PN resolvido apenas se for de fato um telefone diferente do próprio LID.
	 * @private
	 */
	_acceptResolvedPn(resolved, lidDigits) {
		if (!resolved) return null;
		const str = String(resolved);
		if (str.includes("@lid")) return null;
		const clean = PhoneUtils.cleanPhone(str);
		if (!clean || clean === lidDigits) return null;
		return clean;
	}

	/**
	 * Aceita o LID resolvido apenas se for diferente do próprio telefone.
	 * @private
	 */
	_acceptResolvedLid(resolved, pnDigits) {
		if (!resolved) return null;
		const clean = PhoneUtils.cleanPhone(resolved);
		if (!clean || PhoneUtils.isSamePhone(clean, pnDigits)) return null;
		return clean;
	}

	/**
	 * Busca PN mapeado para um LID no cache do bot.
	 * @private
	 */
	_lookupCachedPnForLid(bot, lidDigits) {
		const cache = bot?.lidToPnCache;
		if (!cache || typeof cache.get !== "function" || !lidDigits) return null;
		const hit = cache.get(lidDigits) || cache.get(`${lidDigits}@lid`);
		return this._acceptResolvedPn(hit, lidDigits);
	}

	/**
	 * Telefone conhecido de uma linha (coluna user_pn ou chave antiga que não é LID).
	 * @private
	 */
	_rowPn(row, identity) {
		if (!row) return null;
		if (row.user_pn) return row.user_pn;
		const key = String(row.user_key || "");
		if (!key || key.includes("@lid")) return null;
		const rowLidDigits = row.user_lid ? PhoneUtils.cleanPhone(row.user_lid) : "";
		if (key === rowLidDigits) return null;
		if (identity?.lidDigits?.includes(key) || identity?.ambiguousDigits?.includes(key)) return null;
		return key;
	}

	// ---------------------------------------------------------------------------
	// Persistência
	// ---------------------------------------------------------------------------

	/**
	 * Indica se uma linha casa com a identidade (user_key, user_lid ou user_pn).
	 * @private
	 */
	_recordMatches(rec, identity) {
		if (!rec) return false;
		if (identity.allKeys.includes(rec.user_key)) return true;
		if (rec.user_lid && identity.lidKeys.includes(rec.user_lid)) return true;
		if (rec.user_pn && identity.pnKeys.includes(rec.user_pn)) return true;
		return false;
	}

	/**
	 * Busca todas as linhas do usuário para um bot considerando variantes PN e LID.
	 * @param {string} botKey
	 * @param {Object} identity
	 * @returns {Promise<Object[]>}
	 */
	async _findRecords(botKey, identity) {
		if (!identity || identity.allKeys.length === 0) return [];

		if (this.database.testMode) {
			const botMap = this._testRecords.get(botKey);
			if (!botMap) return [];
			return Array.from(botMap.values()).filter((rec) => this._recordMatches(rec, identity));
		}

		const placeholders = (arr) => arr.map(() => "?").join(", ");
		const clauses = [`user_key IN (${placeholders(identity.allKeys)})`];
		const params = [botKey, ...identity.allKeys];
		if (identity.lidKeys.length > 0) {
			clauses.push(`user_lid IN (${placeholders(identity.lidKeys)})`);
			params.push(...identity.lidKeys);
		}
		if (identity.pnKeys.length > 0) {
			clauses.push(`user_pn IN (${placeholders(identity.pnKeys)})`);
			params.push(...identity.pnKeys);
		}

		const sql = `SELECT * FROM pv_users WHERE bot_id = ? AND (${clauses.join(" OR ")})`;
		return (await this.database.dbAll(DB_NAME, sql, params)) || [];
	}

	/**
	 * Busca as linhas do usuário com a identidade síncrona e, só se não achar nada, completa a
	 * identidade com os resolvedores do bot (getLidFromPn percorre o cache inteiro: é caro).
	 * @private
	 */
	async _lookupRecords(bot, botKey, base) {
		let identity = this._finalizeIdentity(base);
		if (!identity.primaryKey) return { identity, rows: [] };
		let rows = await this._findRecords(botKey, identity);
		const canEnrich =
			(base.pnDigits.length === 0 && base.lidDigits.length > 0) ||
			(base.lidDigits.length === 0 && base.pnDigits.length + base.ambiguousDigits.length > 0);
		if (rows.length === 0 && canEnrich) {
			const before = identity.allKeys.length;
			await this._enrichIdentity(bot, base);
			identity = this._finalizeIdentity(base);
			if (identity.allKeys.length !== before) {
				rows = await this._findRecords(botKey, identity);
			}
		}
		return { identity, rows };
	}

	/**
	 * Compatibilidade: retorna uma visão mesclada das linhas do usuário (ou null).
	 * @param {string} botKey
	 * @param {Object} identity
	 * @returns {Promise<Object|null>}
	 */
	async _findRecord(botKey, identity) {
		return this._mergeRows(await this._findRecords(botKey, identity), identity);
	}

	/**
	 * Mescla várias linhas da mesma pessoa (ex.: linha só com LID + linha só com PN).
	 * @private
	 */
	_mergeRows(rows, identity = null) {
		if (!rows || rows.length === 0) return null;
		const maxOf = (field) => Math.max(0, ...rows.map((r) => Number(r[field] || 0)));
		const firstPvValues = rows.map((r) => Number(r.first_pv_at || 0)).filter((v) => v > 0);
		const lidRow = rows.find((r) => r.user_lid) || rows.find((r) => r.user_key?.includes("@lid"));
		let pn = null;
		for (const row of rows) {
			pn = this._rowPn(row, identity);
			if (pn) break;
		}
		return {
			user_key: rows[0].user_key,
			user_lid: lidRow?.user_lid || (lidRow?.user_key?.includes("@lid") ? lidRow.user_key : null),
			pn,
			has_pv: maxOf("has_pv") >= 1 ? 1 : 0,
			first_pv_at: firstPvValues.length ? Math.min(...firstPvValues) : null,
			last_pv_at: maxOf("last_pv_at") || null,
			last_vcard_sent_at: maxOf("last_vcard_sent_at"),
			updated_at: maxOf("updated_at") || null
		};
	}

	/**
	 * Escolhe a chave canônica: telefone conhecido > LID > dígitos ambíguos.
	 * @private
	 */
	_chooseUserKey(identity, rows) {
		if (identity.primaryPn) return identity.primaryPn;
		for (const row of rows) {
			const pn = this._rowPn(row, identity);
			if (pn) return this.canonicalPhone(pn) || pn;
		}
		if (identity.primaryLid) return identity.primaryLid;
		const lidRow = rows.find((r) => String(r.user_key || "").includes("@lid"));
		if (lidRow) return lidRow.user_key;
		if (identity.ambiguous) return identity.ambiguous;
		return rows[0]?.user_key || identity.primaryKey;
	}

	/**
	 * Persiste a linha mesclada e remove as linhas duplicadas da mesma pessoa.
	 * @private
	 */
	async _upsertRecord(botKey, existingRows, data) {
		const nextRecord = {
			bot_id: botKey,
			user_key: data.user_key,
			user_lid: data.user_lid ?? null,
			user_pn: data.user_pn ?? null,
			has_pv: data.has_pv ?? 0,
			first_pv_at: data.first_pv_at ?? null,
			last_pv_at: data.last_pv_at ?? null,
			last_vcard_sent_at: data.last_vcard_sent_at ?? 0,
			updated_at: data.updated_at || Date.now()
		};
		const staleKeys = (existingRows || [])
			.map((r) => r.user_key)
			.filter((key) => key && key !== nextRecord.user_key);

		if (this.database.testMode) {
			if (!this._testRecords.has(botKey)) {
				this._testRecords.set(botKey, new Map());
			}
			const botMap = this._testRecords.get(botKey);
			const current = botMap.get(nextRecord.user_key);
			if (current) {
				nextRecord.user_lid = nextRecord.user_lid ?? current.user_lid ?? null;
				nextRecord.user_pn = nextRecord.user_pn ?? current.user_pn ?? null;
				nextRecord.has_pv = Math.max(Number(current.has_pv || 0), Number(nextRecord.has_pv || 0));
				nextRecord.last_vcard_sent_at = Math.max(
					Number(current.last_vcard_sent_at || 0),
					Number(nextRecord.last_vcard_sent_at || 0)
				);
				nextRecord.last_pv_at =
					Math.max(Number(current.last_pv_at || 0), Number(nextRecord.last_pv_at || 0)) || null;
				const firsts = [current.first_pv_at, nextRecord.first_pv_at].filter((v) => Number(v) > 0);
				nextRecord.first_pv_at = firsts.length ? Math.min(...firsts) : null;
			}
			for (const key of staleKeys) botMap.delete(key);
			botMap.set(nextRecord.user_key, nextRecord);
			return nextRecord;
		}

		await this.database.dbRun(
			DB_NAME,
			`INSERT INTO pv_users (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ${UPSERT_MERGE_SQL}`,
			[
				nextRecord.bot_id,
				nextRecord.user_key,
				nextRecord.user_lid,
				nextRecord.user_pn,
				nextRecord.has_pv,
				nextRecord.first_pv_at,
				nextRecord.last_pv_at,
				nextRecord.last_vcard_sent_at,
				nextRecord.updated_at
			]
		);

		// Remove duplicatas só depois de gravar a linha mesclada (falha aqui não perde informação)
		for (const key of staleKeys) {
			await this.database.dbRun(DB_NAME, "DELETE FROM pv_users WHERE bot_id = ? AND user_key = ?", [
				botKey,
				key
			]);
		}

		return nextRecord;
	}

	// ---------------------------------------------------------------------------
	// Liberação temporária em memória (respostas diretas nunca são bloqueadas)
	// ---------------------------------------------------------------------------

	/**
	 * Registra em memória (TTL de 24h) que o chat acabou de nos mandar mensagem no PV.
	 * Síncrono de propósito: precisa valer antes de qualquer await/gravação no SQLite.
	 * @param {Object} bot
	 * @param {Object|string} targetOrMessage
	 * @param {number} [now=Date.now()]
	 * @returns {boolean}
	 */
	notePvInbound(bot, targetOrMessage, now = Date.now()) {
		try {
			if (!this.isWhatsAppBot(bot) || !targetOrMessage) return false;
			if (typeof targetOrMessage === "object") {
				if (targetOrMessage.group || targetOrMessage.isNewsletter || targetOrMessage.fromMe) {
					return false;
				}
			}

			const base = this._resolveIdentitySync(bot, targetOrMessage);
			const digitsSet = new Set();
			for (const digits of [...base.pnDigits, ...base.ambiguousDigits]) {
				for (const variant of PhoneUtils.getPhoneVariants(digits)) digitsSet.add(variant);
			}
			for (const digits of base.lidDigits) digitsSet.add(digits);

			const chatJid =
				typeof targetOrMessage === "object" ? targetOrMessage.goMessageData?.Info?.Chat : null;
			if (typeof chatJid === "string" && this.isPvTarget(chatJid)) {
				const chatDigits = this._extractCleanDigits(chatJid);
				if (chatDigits) digitsSet.add(chatDigits);
			}
			if (digitsSet.size === 0) return false;

			const botKey = this.getBotKey(bot);
			const expiresAt = now + PV_INBOUND_ALLOWANCE_MS;
			for (const digits of digitsSet) {
				this._pvAllowance.set(`${botKey}|${digits}`, expiresAt);
			}
			this._pruneAllowance(now);
			return true;
		} catch (err) {
			this.logger.warn(
				`[PV-SAFETY] Falha ao registrar liberação temporária: ${err?.message || err}`
			);
			return false;
		}
	}

	/**
	 * Remove as liberações temporárias em memória (útil em testes e diagnósticos).
	 */
	clearInboundAllowance() {
		this._pvAllowance.clear();
		this._recentWrites.clear();
	}

	/**
	 * @private
	 */
	_hasAllowance(botKey, identity, now = Date.now()) {
		const candidates = new Set([
			...identity.pnKeys,
			...identity.lidDigits,
			...identity.ambiguousDigits
		]);
		for (const digits of candidates) {
			const key = `${botKey}|${digits}`;
			const expiresAt = this._pvAllowance.get(key);
			if (!expiresAt) continue;
			if (expiresAt > now) return true;
			this._pvAllowance.delete(key);
		}
		return false;
	}

	/**
	 * @private
	 */
	_pruneAllowance(now = Date.now()) {
		if (this._pvAllowance.size <= PV_ALLOWANCE_MAX_ENTRIES) return;
		for (const [key, expiresAt] of this._pvAllowance) {
			if (expiresAt <= now) this._pvAllowance.delete(key);
		}
		const target = Math.floor(PV_ALLOWANCE_MAX_ENTRIES * 0.9);
		for (const key of this._pvAllowance.keys()) {
			if (this._pvAllowance.size <= target) break;
			this._pvAllowance.delete(key);
		}
	}

	// ---------------------------------------------------------------------------
	// API pública
	// ---------------------------------------------------------------------------

	/**
	 * Registra que o usuário já iniciou contato no privado (isGroup === false) com este bot.
	 * Escritas são limitadas a 1x/hora por usuário quando nada novo (PN/LID) foi descoberto.
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

		// Liberação imediata em memória (antes de qualquer await)
		this.notePvInbound(bot, targetOrMessage);

		const base = this._resolveIdentitySync(bot, targetOrMessage);
		const quickIdentity = this._finalizeIdentity(base);
		if (!quickIdentity.primaryKey) return false;

		// Throttle antes de qualquer I/O: nada novo (mesmo PN/LID) em menos de 1h => não grava de novo
		const botKey = this.getBotKey(bot);
		const signature = `${quickIdentity.primaryPn || ""}|${quickIdentity.primaryLid || ""}|${quickIdentity.ambiguous || ""}`;
		const throttleKey = `${botKey}|${signature}`;
		const clock = Date.now();
		const lastWrite = this._recentWrites.get(throttleKey);
		if (lastWrite && clock - lastWrite < PV_WRITE_THROTTLE_MS) {
			return true;
		}

		const { identity, rows } = await this._lookupRecords(bot, botKey, base);
		const merged = this._mergeRows(rows, identity);

		await this._upsertRecord(botKey, rows, {
			user_key: this._chooseUserKey(identity, rows),
			user_lid: identity.primaryLid || merged?.user_lid || null,
			user_pn: identity.primaryPn || (merged?.pn ? this.canonicalPhone(merged.pn) : null),
			has_pv: 1,
			first_pv_at: merged?.first_pv_at ? Math.min(merged.first_pv_at, now) : now,
			last_pv_at: Math.max(now, Number(merged?.last_pv_at || 0)),
			last_vcard_sent_at: merged?.last_vcard_sent_at || 0,
			updated_at: now
		});

		this._recentWrites.set(throttleKey, clock);
		if (this._recentWrites.size > PV_WRITE_THROTTLE_MAX_ENTRIES) {
			const oldestKey = this._recentWrites.keys().next().value;
			this._recentWrites.delete(oldestKey);
		}
		return true;
	}

	/**
	 * Verifica se o usuário já enviou pelo menos uma mensagem no privado para este bot.
	 * Erros de consulta (SQLite) liberam o envio (fail-open) e são registrados em log.
	 * @param {Object} bot
	 * @param {Object|string} targetOrMessage
	 * @returns {Promise<boolean>}
	 */
	async hasPvInteraction(bot, targetOrMessage) {
		if (!this.isWhatsAppBot(bot)) return true;

		try {
			const base = this._resolveIdentitySync(bot, targetOrMessage);
			const quickIdentity = this._finalizeIdentity(base);
			if (!quickIdentity.primaryKey) return false;

			if (
				this.isOwnBotNumber(bot, quickIdentity.primaryKey) ||
				(quickIdentity.primaryPn && this.isOwnBotNumber(bot, quickIdentity.primaryPn))
			) {
				return true;
			}

			// Caminho rápido: respostas a quem acabou de falar no PV não precisam de I/O
			const botKey = this.getBotKey(bot);
			if (this._hasAllowance(botKey, quickIdentity)) return true;

			const { identity, rows } = await this._lookupRecords(bot, botKey, base);
			if (rows.some((row) => Number(row.has_pv) === 1)) return true;
			return this._hasAllowance(botKey, identity);
		} catch (err) {
			this.logger.warn(
				`[PV-SAFETY] Falha ao consultar interação em PV (liberando envio): ${err?.message || err}`
			);
			return true;
		}
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

		const base = this._resolveIdentitySync(bot, targetOrMessage);
		const quickIdentity = this._finalizeIdentity(base);
		if (!quickIdentity.primaryKey) return false;
		if (this.isOwnBotNumber(bot, quickIdentity.primaryPn || quickIdentity.primaryKey)) return false;

		const { rows } = await this._lookupRecords(bot, this.getBotKey(bot), base);
		const lastSent = Math.max(0, ...rows.map((r) => Number(r.last_vcard_sent_at || 0)));
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

		const base = this._resolveIdentitySync(bot, targetOrMessage);
		if (!this._finalizeIdentity(base).primaryKey) return;

		const botKey = this.getBotKey(bot);
		const { identity, rows } = await this._lookupRecords(bot, botKey, base);
		const merged = this._mergeRows(rows, identity);

		await this._upsertRecord(botKey, rows, {
			user_key: this._chooseUserKey(identity, rows),
			user_lid: identity.primaryLid || merged?.user_lid || null,
			user_pn: identity.primaryPn || (merged?.pn ? this.canonicalPhone(merged.pn) : null),
			has_pv: merged?.has_pv ?? 0,
			first_pv_at: merged?.first_pv_at ?? null,
			last_pv_at: merged?.last_pv_at ?? null,
			last_vcard_sent_at: now,
			updated_at: now
		});
	}

	/**
	 * Adquire lock em memória para evitar envio duplicado concorrente de vCard no mesmo chat.
	 * O lock cobre todas as formas canônicas da pessoa (telefone canônico e LID), então
	 * chamadas por "5511..." x "55119..." x "123@lid" disputam o mesmo lock.
	 * @param {Object} bot
	 * @param {string} chatId
	 * @returns {Promise<string[]|null>}
	 */
	async acquireVcardLock(bot, chatId) {
		const identity = this._finalizeIdentity(this._resolveIdentitySync(bot, chatId));
		if (!identity.primaryKey) return null;
		const botKey = this.getBotKey(bot);
		const forms = new Set();
		for (const digits of identity.pnDigits) forms.add(this.canonicalPhone(digits));
		for (const digits of identity.lidDigits) forms.add(`${digits}@lid`);
		for (const digits of identity.ambiguousDigits) {
			forms.add(this.canonicalPhone(digits));
			forms.add(`${digits}@lid`);
		}
		const keys = Array.from(forms)
			.filter(Boolean)
			.map((form) => `${botKey}:${form}`);
		if (keys.length === 0 || keys.some((key) => this._vcardLocks.has(key))) {
			return null;
		}
		for (const key of keys) this._vcardLocks.add(key);
		return keys;
	}

	/**
	 * Libera lock em memória do envio de vCard.
	 * @param {string|string[]|null} lockKey
	 */
	releaseVcardLock(lockKey) {
		if (!lockKey) return;
		const keys = Array.isArray(lockKey) ? lockKey : [lockKey];
		for (const key of keys) this._vcardLocks.delete(key);
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

	// ---------------------------------------------------------------------------
	// Manutenção de inicialização (migração de chave do bot + backfill)
	// ---------------------------------------------------------------------------

	/**
	 * @private
	 */
	async _getMeta(key) {
		if (this.database.testMode) return this._testMeta.get(key) ?? null;
		const row = await this.database.dbGet(DB_NAME, "SELECT value FROM pv_meta WHERE key = ?", [
			key
		]);
		return row?.value ?? null;
	}

	/**
	 * @private
	 */
	async _setMeta(key, value) {
		if (this.database.testMode) {
			this._testMeta.set(key, value);
			return;
		}
		await this.database.dbRun(
			DB_NAME,
			"INSERT OR REPLACE INTO pv_meta (key, value, updated_at) VALUES (?, ?, ?)",
			[key, value, Date.now()]
		);
	}

	/**
	 * Normaliza a lista de bots (instâncias ou entradas do bots.json) mantendo só WhatsApp.
	 * @private
	 */
	_normalizeBotList(bots) {
		const seen = new Set();
		const list = [];
		for (const bot of bots || []) {
			if (!bot || bot.useTelegram || bot.useDiscord) continue;
			const id = String(bot.id ?? bot.nome ?? "").trim();
			const phoneNumber = bot.phoneNumber ?? bot.numero ?? null;
			if (!id && !phoneNumber) continue;
			const normalized = { id, phoneNumber };
			const key = `${id}|${this.getBotKey(normalized)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			list.push(normalized);
		}
		return list;
	}

	/**
	 * Executa a migração de chave (id -> número) e o backfill inicial de pv_users.
	 * Ambos são idempotentes e rodam uma única vez (marcadores em pv_meta).
	 * @param {Array<Object>} bots - Instâncias de bot ou entradas do bots.json ({nome, numero})
	 * @param {Object} [options]
	 * @returns {Promise<{migration: Object, backfill: Object}>}
	 */
	async runStartupMaintenance(bots, options = {}) {
		const waBots = this._normalizeBotList(bots);
		let migration = { skipped: "error" };
		let backfill = { skipped: "error" };
		try {
			migration = await this.migrateLegacyBotKeys(waBots, options);
		} catch (err) {
			this.logger.error("[PV-SAFETY] Falha na migração de chaves de bot em pv_users:", err);
		}
		try {
			backfill = await this.backfillFromExistingData(waBots, options);
		} catch (err) {
			this.logger.error("[PV-SAFETY] Falha no backfill de pv_users:", err);
		}
		return { migration, backfill };
	}

	/**
	 * Move linhas antigas gravadas com bot_id = id do bot para a chave baseada no número.
	 * Trade-off: se o id já tiver sido re-pareado com outro chip antes desta migração, as
	 * linhas (no máximo ~1 dia de dados desde o deploy do bloqueio) seguem para o número atual.
	 * @param {Array<Object>} bots
	 * @param {Object} [options]
	 * @returns {Promise<Object>}
	 */
	async migrateLegacyBotKeys(bots, options = {}) {
		if (this.database.testMode) return { skipped: "testMode" };
		const markerKey = options.migrationMarkerKey || BOT_KEY_MIGRATION_MARKER_KEY;
		if (!options.force && (await this._getMeta(markerKey))) {
			return { skipped: "done" };
		}

		const mappers = this.database.mappers;
		let migratedRows = 0;
		for (const bot of this._normalizeBotList(bots)) {
			const legacyId = bot.id;
			const botKey = this.getBotKey(bot);
			if (!legacyId || legacyId === botKey) continue;
			migratedRows += mappers.transaction(DB_NAME, () => {
				mappers.run(
					DB_NAME,
					`INSERT INTO pv_users (${INSERT_COLUMNS})
						SELECT ?, user_key, user_lid, user_pn, has_pv, first_pv_at, last_pv_at, last_vcard_sent_at, updated_at
						FROM pv_users WHERE bot_id = ? ${UPSERT_MERGE_SQL}`,
					[botKey, legacyId]
				);
				return mappers.run(DB_NAME, "DELETE FROM pv_users WHERE bot_id = ?", [legacyId]).changes;
			});
		}

		if (options.writeMarker !== false) {
			await this._setMeta(markerKey, JSON.stringify({ at: Date.now(), migratedRows }));
		}
		this.logger.info(
			`[PV-SAFETY] Migração de chave de bot (id -> número) concluída: ${migratedRows} linha(s).`
		);
		return { migratedRows };
	}

	/**
	 * Lê linhas de um SQLite de outra feature sem criar o arquivo caso ele não exista.
	 * @private
	 */
	_readSourceRows(sqlitesDir, file, sql) {
		const filePath = path.join(sqlitesDir, file);
		if (!fs.existsSync(filePath)) return null;
		const BetterSQLite = require("better-sqlite3");
		let conn = null;
		try {
			conn = new BetterSQLite(filePath, { fileMustExist: true });
			conn.pragma("busy_timeout = 5000");
			return conn.prepare(sql).all();
		} finally {
			try {
				conn?.close();
			} catch {
				// ignora
			}
		}
	}

	/**
	 * Converte um ID de usuário vindo de outra tabela em uma linha de pv_users.
	 * @private
	 */
	_backfillUserRecord(raw, { strict = false, requireSuffix = false } = {}) {
		if (raw === null || raw === undefined) return null;
		const str = String(raw).trim();
		if (!str || !this.isPvTarget(str)) return null;
		const digits = this._extractCleanDigits(str);
		if (!digits) return null;

		const kind = this._classifyRaw(str);
		if (kind === "lid") {
			return { user_key: `${digits}@lid`, user_lid: `${digits}@lid`, user_pn: null };
		}
		if (kind === "pn") {
			if (!LOOSE_BARE_ID_REGEX.test(digits)) return null;
			const canonical = this.canonicalPhone(digits);
			return { user_key: canonical, user_lid: null, user_pn: canonical };
		}
		if (requireSuffix) return null;
		if (str.includes("@")) return null;
		if (!(strict ? STRICT_BARE_ID_REGEX : LOOSE_BARE_ID_REGEX).test(digits)) return null;
		// Dígitos soltos: podem ser telefone ou LID; ficam como chave ambígua (a consulta cobre os dois)
		return { user_key: digits, user_lid: null, user_pn: null };
	}

	/**
	 * Backfill idempotente de pv_users a partir de dados que provam conversa prévia no PV.
	 * Sem id do bot na fonte, a liberação vale para todos os bots de WhatsApp configurados
	 * (trade-off aceito: a pessoa já usou a Ravena no privado, só não sabemos com qual número).
	 * @param {Array<Object>} bots - bots de WhatsApp ({id, phoneNumber})
	 * @param {Object} [options]
	 * @param {string} [options.sqlitesDir] - diretório dos .db (padrão: data/sqlites)
	 * @param {boolean} [options.force] - ignora o marcador de execução
	 * @param {string} [options.markerKey]
	 * @param {boolean} [options.writeMarker=true]
	 * @returns {Promise<Object>} contagens por fonte
	 */
	async backfillFromExistingData(bots, options = {}) {
		if (this.database.testMode) return { skipped: "testMode" };
		const markerKey = options.markerKey || BACKFILL_MARKER_KEY;
		if (!options.force && (await this._getMeta(markerKey))) {
			return { skipped: "done" };
		}

		const waBots = this._normalizeBotList(bots);
		const allBotKeys = Array.from(new Set(waBots.map((b) => this.getBotKey(b))));
		if (allBotKeys.length === 0) {
			this.logger.warn("[PV-SAFETY] Backfill de pv_users ignorado: nenhum bot de WhatsApp.");
			return { skipped: "no-bots" };
		}
		const idToKey = new Map(waBots.filter((b) => b.id).map((b) => [b.id, this.getBotKey(b)]));
		const ownNumbers = waBots.map((b) => b.phoneNumber).filter(Boolean);
		const sqlitesDir = options.sqlitesDir || path.join(this.database.databasePath, "sqlites");
		const sources = options.sources || BACKFILL_SOURCES;

		const now = Date.now();
		const entries = new Map(); // `${botKey}|${user_key}` -> registro
		const counts = {};

		for (const source of sources) {
			const stats = { rows: 0, users: 0 };
			counts[source.name] = stats;
			let rows;
			try {
				rows = this._readSourceRows(sqlitesDir, source.file, source.sql);
			} catch (err) {
				stats.error = err?.message || String(err);
				this.logger.warn(`[PV-SAFETY] Backfill: falha lendo ${source.name}: ${stats.error}`);
				continue;
			}
			if (rows === null) {
				stats.missing = true;
				continue;
			}
			stats.rows = rows.length;
			const sourceUsers = new Set();

			for (const row of rows) {
				let botKeys = allBotKeys;
				let strict = Boolean(source.strict);
				if (source.perBot) {
					const rowBotId = String(row.bot_id ?? "").trim();
					if (rowBotId) {
						// Linha de um bot que não existe mais (ou não é de WhatsApp): ignora
						if (!idToKey.has(rowBotId)) continue;
						botKeys = [idToKey.get(rowBotId)];
					} else {
						strict = true;
					}
				}

				const record = this._backfillUserRecord(row.user, {
					strict,
					requireSuffix: Boolean(source.requireSuffix)
				});
				if (!record) continue;
				if (ownNumbers.some((phone) => PhoneUtils.isSamePhone(phone, record.user_key))) continue;

				const tsRaw = Number(row.ts || 0);
				// Alguns timestamps são em segundos
				const ts = tsRaw > 0 ? (tsRaw < 1e12 ? tsRaw * 1000 : tsRaw) : now;
				sourceUsers.add(record.user_key);

				for (const botKey of botKeys) {
					const entryKey = `${botKey}|${record.user_key}`;
					const current = entries.get(entryKey);
					if (current) {
						current.first_pv_at = Math.min(current.first_pv_at, ts);
						current.last_pv_at = Math.max(current.last_pv_at, ts);
						continue;
					}
					entries.set(entryKey, {
						bot_id: botKey,
						...record,
						first_pv_at: ts,
						last_pv_at: ts
					});
				}
			}
			stats.users = sourceUsers.size;
		}

		const mappers = this.database.mappers;
		const upsertSql = `INSERT INTO pv_users (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?) ${UPSERT_MERGE_SQL}`;
		let inserted = 0;
		let updated = 0;
		const records = Array.from(entries.values());
		const batchSize = 2000;
		for (let i = 0; i < records.length; i += batchSize) {
			const batch = records.slice(i, i + batchSize);
			mappers.transaction(DB_NAME, () => {
				for (const rec of batch) {
					const existed = mappers.get(
						DB_NAME,
						"SELECT has_pv FROM pv_users WHERE bot_id = ? AND user_key = ?",
						[rec.bot_id, rec.user_key]
					);
					mappers.run(DB_NAME, upsertSql, [
						rec.bot_id,
						rec.user_key,
						rec.user_lid,
						rec.user_pn,
						rec.first_pv_at,
						rec.last_pv_at,
						now
					]);
					if (existed) updated++;
					else inserted++;
				}
			});
		}

		const summary = {
			at: now,
			bots: allBotKeys.length,
			inserted,
			updated,
			sources: counts
		};
		if (options.writeMarker !== false) {
			await this._setMeta(markerKey, JSON.stringify(summary));
		}

		const perSource = Object.entries(counts)
			.map(([name, s]) =>
				s.missing
					? `${name}=sem arquivo`
					: s.error
						? `${name}=erro`
						: `${name}=${s.users} usuário(s)/${s.rows} linha(s)`
			)
			.join(", ");
		this.logger.info(
			`[PV-SAFETY] Backfill de pv_users concluído para ${allBotKeys.length} bot(s): ${inserted} nova(s), ${updated} já existente(s). Fontes: ${perSource}`
		);
		return summary;
	}
}

module.exports = PvSafetyService;
module.exports.PvColdBlockedError = PvColdBlockedError;
module.exports.PV_COLD_BLOCKED_CODE = PV_COLD_BLOCKED_CODE;
