const Database = require("../utils/Database");
const Logger = require("../utils/Logger");
const LLMService = require("./LLMService");
const EmbeddingService = require("./EmbeddingService");
const Status = require("../utils/Status");

const DB_NAME = "memory";

/**
 * Ravena Memory Engine (RME)
 * Gerencia a memória contínua, identidades, dossiês de grupos e dossiês 360 de usuários.
 */
class MemoryService {
	static getInstance() {
		if (!MemoryService.instance) {
			MemoryService.instance = new MemoryService();
		}
		return MemoryService.instance;
	}

	constructor() {
		this.logger = new Logger("memory-service");
		this.database = Database.getInstance();
		this.llmService = LLMService.getInstance();
		this.embeddingService = EmbeddingService.getInstance();
		this.activeAnalyses = new Set();
		this.lastDistillationAttempt = new Map();

		this._initDatabase();
	}

	/**
	 * Inicializa o banco de dados e cria as tabelas necessárias
	 */
	_initDatabase() {
		this.database.getSQLiteDb(
			DB_NAME,
			`
			-- Mapeamento de identidades (JID, LID, Telegram ID -> canonical_user_id)
			CREATE TABLE IF NOT EXISTS memory_identities (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				canonical_user_id TEXT NOT NULL,
				platform TEXT NOT NULL,
				platform_id TEXT NOT NULL,
				id_type TEXT NOT NULL,
				display_name TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(platform, platform_id)
			);
			CREATE INDEX IF NOT EXISTS idx_mem_ident_canonical ON memory_identities(canonical_user_id);
			CREATE INDEX IF NOT EXISTS idx_mem_ident_platform ON memory_identities(platform, platform_id);

			-- Fatos semânticos memorizados sobre pessoas (global)
			CREATE TABLE IF NOT EXISTS memory_user_facts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				canonical_user_id TEXT NOT NULL,
				fact_text TEXT NOT NULL,
				category TEXT DEFAULT 'general',
				confidence REAL DEFAULT 1.0,
				embedding BLOB,
				source_type TEXT NOT NULL,
				source_id TEXT,
				extracted_at INTEGER NOT NULL,
				last_confirmed_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_mem_user_facts_user ON memory_user_facts(canonical_user_id);

			-- Dossiê vivo e cultura de grupos
			CREATE TABLE IF NOT EXISTS memory_group_profiles (
				group_id TEXT PRIMARY KEY,
				platform TEXT NOT NULL,
				title TEXT,
				vibe_summary TEXT,
				frequent_topics TEXT,
				group_rules_culture TEXT,
				bot_personality_hint TEXT,
				latest_summary TEXT,
				last_summarized_at INTEGER DEFAULT 0,
				messages_since_summary INTEGER DEFAULT 0,
				total_messages_analyzed INTEGER DEFAULT 0,
				average_problematic_score REAL DEFAULT 0,
				updated_at INTEGER NOT NULL
			);

			-- Histórico de dossiês de grupos e moderação
			CREATE TABLE IF NOT EXISTS memory_group_dossiers (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL,
				platform TEXT NOT NULL,
				dossier_json TEXT NOT NULL,
				conversation_sample TEXT,
				problematic_score REAL DEFAULT 0,
				is_problematic INTEGER DEFAULT 0,
				is_underage INTEGER DEFAULT 0,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP
			);
			CREATE INDEX IF NOT EXISTS idx_mem_dossier_group ON memory_group_dossiers(group_id, created_at);

			-- Buffer de mensagens recentes para grupos e PV
			CREATE TABLE IF NOT EXISTS memory_message_buffer (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				target_id TEXT NOT NULL,
				is_pv INTEGER DEFAULT 0,
				author_id TEXT NOT NULL,
				canonical_user_id TEXT NOT NULL,
				author_name TEXT,
				text_content TEXT NOT NULL,
				timestamp INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_mem_buff_target ON memory_message_buffer(target_id, timestamp);
			CREATE INDEX IF NOT EXISTS idx_mem_buff_author ON memory_message_buffer(canonical_user_id);
			`,
			false
		);
	}

	/**
	 * Normaliza um número de telefone ou ID
	 * @param {string} rawId
	 * @returns {string}
	 */
	cleanPhone(rawId) {
		if (!rawId) return "";
		return String(rawId).replace(/@.*$/, "").replace(/\D/g, "");
	}

	/**
	 * Normaliza o nome do autor removendo fontes estilizadas (Unicode NFKC),
	 * emojis e caracteres decorativos para buscas flexíveis
	 * @param {string} name
	 * @returns {string}
	 */
	normalizeAuthorName(name) {
		if (!name || typeof name !== "string") return "";
		return name
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[\u200B-\u200D\uFEFF]/g, "")
			.replace(/[^\p{L}\p{N}]/gu, "")
			.trim();
	}

	/**
	 * Obtém a lista de números de telefone de Super Admins / Criadores a partir das variáveis de ambiente
	 * @returns {string[]} Lista de números limpos (apenas dígitos)
	 */
	getSuperAdminPhones() {
		const raw = process.env.SUPER_ADMINS || "";
		return raw
			.split(",")
			.map((entry) => this.cleanPhone(entry.trim()))
			.filter((num) => num && num.length >= 8);
	}

	/**
	 * Verifica se um determinado identificador pertence a um Super Admin / Criador
	 * @param {string} rawId
	 * @returns {boolean}
	 */
	isSuperAdmin(rawId) {
		if (!rawId) return false;
		const clean = this.cleanPhone(rawId);
		if (!clean) return false;
		return this.getSuperAdminPhones().includes(clean);
	}

	/**
	 * Resolve ou cria um canonical_user_id para a plataforma e ID informados
	 * @param {string} platform - 'whatsapp' ou 'telegram'
	 * @param {string} platformId - Ex: '5511999999999@s.whatsapp.net', '123456@lid', '987654321'
	 * @param {string} idType - 'jid', 'lid', 'tg_id'
	 * @param {string} [displayName] - Pushname ou apelido
	 * @returns {Promise<string>} canonical_user_id
	 */
	async resolveCanonicalUserId(platform, platformId, idType, displayName = null) {
		if (!platformId) return "user_unknown";

		const cleanId = String(platformId).trim();
		const now = Date.now();

		try {
			const existing = await this.database.dbGet(
				DB_NAME,
				"SELECT canonical_user_id, display_name FROM memory_identities WHERE platform = ? AND platform_id = ?",
				[platform, cleanId]
			);

			if (existing) {
				if (
					displayName &&
					displayName !== existing.display_name &&
					displayName !== "Desconhecido"
				) {
					await this.database.dbRun(
						DB_NAME,
						"UPDATE memory_identities SET display_name = ?, updated_at = ? WHERE platform = ? AND platform_id = ?",
						[displayName, now, platform, cleanId]
					);
				}
				// Se a canonical_user_id existente for user_[0-9]{8,}, normaliza imediatamente
				if (existing.canonical_user_id && existing.canonical_user_id.startsWith("user_")) {
					const num = this.cleanPhone(existing.canonical_user_id);
					if (num && num.length >= 8) {
						const fixedCanonical = `wa_${num}`;
						await this.database.dbRun(
							DB_NAME,
							"UPDATE memory_identities SET canonical_user_id = ?, updated_at = ? WHERE platform = ? AND platform_id = ?",
							[fixedCanonical, now, platform, cleanId]
						);
						return fixedCanonical;
					}
				}
				return existing.canonical_user_id;
			}

			// Se for WhatsApp
			let canonicalId = null;
			if (platform === "whatsapp") {
				if (cleanId.includes("@lid")) {
					const lidNumber = this.cleanPhone(cleanId);
					canonicalId = `wa_lid_${lidNumber || cleanId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
				} else {
					const num = this.cleanPhone(cleanId);
					if (num && num.length >= 8) {
						canonicalId = `wa_${num}`;
					}
				}

				// Se for pushname/texto, verifica se o display_name bate com um doador registrado
				if (!canonicalId && displayName) {
					try {
						const donor = await this.database.dbGet(
							"core",
							"SELECT numero FROM donations WHERE name = ? COLLATE NOCASE AND numero IS NOT NULL LIMIT 1",
							[displayName]
						);
						if (donor && donor.numero) {
							const dNum = this.cleanPhone(donor.numero);
							if (dNum && dNum.length >= 8) {
								canonicalId = `wa_${dNum}`;
							}
						}
					} catch (e) {}
				}

				// Se ainda não achou, tenta achar identidade canônica existente por display_name
				if (!canonicalId && (displayName || cleanId)) {
					try {
						const existingByName = await this.database.dbGet(
							DB_NAME,
							"SELECT canonical_user_id FROM memory_identities WHERE display_name = ? COLLATE NOCASE AND canonical_user_id LIKE 'wa_%' LIMIT 1",
							[displayName || cleanId]
						);
						if (existingByName && existingByName.canonical_user_id) {
							canonicalId = existingByName.canonical_user_id;
						}
					} catch (e) {}
				}

				// Fallback seguro (garante prefixo wa_ e nunca user_<pushname>)
				if (!canonicalId) {
					const num = this.cleanPhone(cleanId);
					if (num && num.length >= 8) {
						canonicalId = `wa_${num}`;
					} else {
						canonicalId = `wa_${cleanId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
					}
				}
			} else if (platform === "telegram") {
				canonicalId = `tg_${cleanId}`;
			} else {
				canonicalId = `${platform}_${cleanId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
			}

			await this.database.dbRun(
				DB_NAME,
				`INSERT INTO memory_identities (canonical_user_id, platform, platform_id, id_type, display_name, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(platform, platform_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
				[canonicalId, platform, cleanId, idType, displayName || cleanId, now, now]
			);

			return canonicalId;
		} catch (error) {
			this.logger.error("Erro ao resolver canonical_user_id:", error);
			const num = this.cleanPhone(cleanId);
			return num && num.length >= 8 ? `wa_${num}` : `wa_${cleanId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
		}
	}

	/**
	 * Vincula explicitamente um par WhatsApp LID <-> JID/Phone
	 * @param {string} lid - Ex: "123456789@lid"
	 * @param {string} jidOrPhone - Ex: "5511999999999@s.whatsapp.net" ou número
	 * @param {string} [displayName]
	 */
	async linkLidToPn(lid, jidOrPhone, displayName = null) {
		if (!lid || !jidOrPhone) return;
		const cleanNum = this.cleanPhone(jidOrPhone);
		if (!cleanNum) return;

		const canonicalId = `wa_${cleanNum}`;
		const now = Date.now();
		const cleanLid = String(lid).includes("@lid") ? String(lid) : `${lid}@lid`;
		const fullJid = cleanNum.includes("@s.whatsapp.net") ? cleanNum : `${cleanNum}@s.whatsapp.net`;

		try {
			await this.database.dbRun(
				DB_NAME,
				`INSERT INTO memory_identities (canonical_user_id, platform, platform_id, id_type, display_name, created_at, updated_at)
				 VALUES (?, 'whatsapp', ?, 'jid', ?, ?, ?)
				 ON CONFLICT(platform, platform_id) DO UPDATE SET canonical_user_id = excluded.canonical_user_id, updated_at = excluded.updated_at`,
				[canonicalId, fullJid, displayName, now, now]
			);

			await this.database.dbRun(
				DB_NAME,
				`INSERT INTO memory_identities (canonical_user_id, platform, platform_id, id_type, display_name, created_at, updated_at)
				 VALUES (?, 'whatsapp', ?, 'lid', ?, ?, ?)
				 ON CONFLICT(platform, platform_id) DO UPDATE SET canonical_user_id = excluded.canonical_user_id, updated_at = excluded.updated_at`,
				[canonicalId, cleanLid, displayName, now, now]
			);
		} catch (err) {
			this.logger.warn(`Erro ao vincular LID ${cleanLid} a PN ${cleanNum}:`, err.message);
		}
	}

	/**
	 * Sincroniza e unifica um doador (novo ou existente) no sistema de memória
	 * @param {string} donorName
	 * @param {string} donorNumber
	 */
	async syncDonor(donorName, donorNumber) {
		if (!donorNumber) return;
		const phone = this.cleanPhone(donorNumber);
		if (!phone || phone.length < 8) return;

		const targetCanonical = `wa_${phone}`;
		const fullJid = `${phone}@s.whatsapp.net`;
		const now = Date.now();
		const name = donorName ? donorName.trim() : "";

		try {
			// 1. Garante que a identidade canônica principal existe
			await this.database.dbRun(
				DB_NAME,
				`INSERT INTO memory_identities (canonical_user_id, platform, platform_id, id_type, display_name, created_at, updated_at)
				 VALUES (?, 'whatsapp', ?, 'jid', ?, ?, ?)
				 ON CONFLICT(platform, platform_id) DO UPDATE SET 
				    canonical_user_id = excluded.canonical_user_id,
				    display_name = COALESCE(NULLIF(excluded.display_name, ''), memory_identities.display_name),
				    updated_at = excluded.updated_at`,
				[targetCanonical, fullJid, name || phone, now, now]
			);

			// 2. Busca e unifica identidades anteriores baseadas no número ou nome
			const sourceCanonicals = new Set([`user_${phone}`]);

			// Busca canonical_ids anteriores no buffer de mensagens desse número
			const bufferCanonicals = await this.database.dbAll(
				DB_NAME,
				"SELECT DISTINCT canonical_user_id FROM memory_message_buffer WHERE author_id LIKE ?",
				[`%${phone}%`]
			);
			for (const b of bufferCanonicals || []) {
				if (b.canonical_user_id && b.canonical_user_id !== targetCanonical) {
					sourceCanonicals.add(b.canonical_user_id);
				}
			}

			if (name && name.length > 2) {
				const rawSlug = `user_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
				const compactSlug = `user_${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
				sourceCanonicals.add(rawSlug);
				sourceCanonicals.add(`${rawSlug}_`);
				sourceCanonicals.add(compactSlug);
			}

			// Busca possíveis pushnames no buffer de mensagens desse número
			const bufferNames = await this.database.dbAll(
				DB_NAME,
				"SELECT DISTINCT author_name FROM memory_message_buffer WHERE author_id LIKE ?",
				[`%${phone}%`]
			);
			for (const b of bufferNames || []) {
				if (b.author_name && b.author_name.length > 2) {
					const bSlug = `user_${b.author_name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
					const bCompact = `user_${b.author_name.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
					sourceCanonicals.add(bSlug);
					sourceCanonicals.add(`${bSlug}_`);
					sourceCanonicals.add(bCompact);
				}
			}

			sourceCanonicals.delete(targetCanonical);

			for (const src of sourceCanonicals) {
				await this.database.dbRun(
					DB_NAME,
					"UPDATE memory_user_facts SET canonical_user_id = ? WHERE canonical_user_id = ?",
					[targetCanonical, src]
				);
				await this.database.dbRun(
					DB_NAME,
					"UPDATE memory_message_buffer SET canonical_user_id = ? WHERE canonical_user_id = ?",
					[targetCanonical, src]
				);
				await this.database.dbRun(
					DB_NAME,
					"UPDATE memory_identities SET canonical_user_id = ? WHERE canonical_user_id = ?",
					[targetCanonical, src]
				);
			}

			// Remove duplicidades
			await this.database.dbRun(
				DB_NAME,
				`DELETE FROM memory_identities WHERE rowid NOT IN (
					SELECT MIN(rowid) FROM memory_identities GROUP BY platform, platform_id
				)`
			);
		} catch (err) {
			this.logger.warn(`Erro ao sincronizar doador ${name} (${phone}) na memória:`, err.message);
		}
	}

	/**
	 * Ingestão de mensagem em tempo real (chamada pelo EventHandler ou SummaryCommands)
	 * @param {Object} bot - Instância do bot
	 * @param {Object} message - Objeto da mensagem padronizado
	 */
	async ingestMessage(bot, message) {
		try {
			if (!message) return;

			// Determina texto da mensagem
			let textContent = message.type === "text" ? message.content : message.caption;
			if (!textContent || typeof textContent !== "string") {
				return;
			}
			textContent = textContent.trim();
			if (textContent.length === 0) return;

			// Ignora comandos administrativos diretos iniciados com '!' no histórico
			if (textContent.startsWith("!")) {
				return;
			}

			const isGroup = Boolean(message.group);
			const targetId = isGroup ? message.group : message.author;
			const isPv = isGroup ? 0 : 1;
			const platform = bot?.useTelegram ? "telegram" : "whatsapp";

			// Identifica autores e nomes
			const fromMe =
				message.goMessageData?.key?.fromMe ??
				message.key?.fromMe ??
				message.fromMe ??
				message.origin?.fromMe ??
				false;

			const authorName = fromMe
				? "Você (bot)"
				: (message.goMessageData?.pushName ??
					message.origin?.pushName ??
					message.name ??
					message.authorName ??
					message.pushname ??
					"Desconhecido");

			const authorId = message.author || targetId;
			const idType = String(authorId).includes("@lid")
				? "lid"
				: String(authorId).includes("@s.whatsapp.net")
					? "jid"
					: platform === "telegram"
						? "tg_id"
						: "other";

			// Vincula LID e JID se disponível no evento
			const senderAlt = message.goMessageData?.senderAlt || message.senderAlt;
			if (senderAlt && authorId) {
				const isAuthorLid = String(authorId).includes("@lid");
				const isAltLid = String(senderAlt).includes("@lid");
				if (isAuthorLid && !isAltLid) {
					await this.linkLidToPn(authorId, senderAlt, authorName);
				} else if (!isAuthorLid && isAltLid) {
					await this.linkLidToPn(senderAlt, authorId, authorName);
				}
			}

			// Resolve canonical_user_id
			const canonicalUserId = await this.resolveCanonicalUserId(
				platform,
				authorId,
				idType,
				authorName
			);

			const timestamp = Date.now();

			// 1. Salva no buffer de mensagens
			await this.database.dbRun(
				DB_NAME,
				`INSERT INTO memory_message_buffer (target_id, is_pv, author_id, canonical_user_id, author_name, text_content, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[targetId, isPv, authorId, canonicalUserId, authorName, textContent, timestamp]
			);

			// 2. Limita o buffer recente a 200 mensagens para o target
			await this.database.dbRun(
				DB_NAME,
				`DELETE FROM memory_message_buffer WHERE rowid IN (
					SELECT rowid FROM memory_message_buffer
					WHERE target_id = ?
					ORDER BY timestamp DESC
					LIMIT -1 OFFSET 200
				)`,
				[targetId]
			);

			// 3. Atualiza contadores do perfil de grupo (se for grupo)
			if (isGroup) {
				const groupTitle = message.groupName || (await bot?.getGroupName?.(targetId)) || targetId;
				await this.database.dbRun(
					DB_NAME,
					`INSERT INTO memory_group_profiles (group_id, platform, title, messages_since_summary, total_messages_analyzed, updated_at)
					 VALUES (?, ?, ?, 1, 0, ?)
					 ON CONFLICT(group_id) DO UPDATE SET 
						messages_since_summary = messages_since_summary + 1,
						title = COALESCE(excluded.title, title),
						updated_at = excluded.updated_at`,
					[targetId, platform, groupTitle, timestamp]
				);

				// Verifica apenas mensagens novas acumuladas desde a última destilação
				const profileRow = await this.database.dbGet(
					DB_NAME,
					"SELECT last_summarized_at, messages_since_summary FROM memory_group_profiles WHERE group_id = ?",
					[targetId]
				);
				const lastSummarizedAt = profileRow?.last_summarized_at || 0;
				const msgsSinceSummary = profileRow?.messages_since_summary || 0;

				const charCountRow = await this.database.dbGet(
					DB_NAME,
					"SELECT SUM(LENGTH(text_content)) as total_chars, COUNT(*) as total_msgs FROM memory_message_buffer WHERE target_id = ? AND timestamp > ?",
					[targetId, lastSummarizedAt]
				);

				const totalChars = charCountRow?.total_chars || 0;
				const isDossierEligible = !bot || (!bot.privado && !bot.vip);
				const lastAttempt = this.lastDistillationAttempt.get(targetId) || 0;
				const cooldownElapsed = timestamp - lastAttempt >= 10 * 60 * 1000;

				if (
					isDossierEligible &&
					totalChars >= 10000 &&
					msgsSinceSummary >= 30 &&
					cooldownElapsed &&
					!this.activeAnalyses.has(targetId)
				) {
					// Dispara destilação em lote sem await
					this.triggerBatchDistillation(targetId, false, bot).catch((err) =>
						this.logger.error(`[${targetId}] Erro no gatilho de destilação:`, err)
					);
				}
			}
		} catch (error) {
			this.logger.error("Erro ao ingerir mensagem no MemoryService:", error);
		}
	}

	/**
	 * Executa a destilação assíncrona com o Gemma 4 12B e vetorização BGE-M3
	 * @param {string} targetId - ID do grupo ou do PV
	 * @param {boolean} isPv - Se é PV ou Grupo
	 * @param {Object} [bot] - Instância do bot para alertas
	 */
	async triggerBatchDistillation(targetId, isPv = false, bot = null) {
		if (this.activeAnalyses.has(targetId)) {
			return;
		}
		this.activeAnalyses.add(targetId);
		this.lastDistillationAttempt.set(targetId, Date.now());

		try {
			this.logger.info(`[${targetId}] Iniciando destilação de memória (Tier 2 Gemma 12B)...`);

			const profileRow = !isPv
				? await this.database.dbGet(
						DB_NAME,
						"SELECT last_summarized_at FROM memory_group_profiles WHERE group_id = ?",
						[targetId]
					)
				: null;
			const lastSummarizedAt = profileRow?.last_summarized_at || 0;

			// Busca mensagens novas acumuladas no buffer desde a última destilação
			let rows = await this.database.dbAll(
				DB_NAME,
				"SELECT author_name, author_id, canonical_user_id, text_content, timestamp FROM memory_message_buffer WHERE target_id = ? AND timestamp > ? ORDER BY timestamp ASC",
				[targetId, lastSummarizedAt]
			);

			if (!rows || rows.length < 5) {
				rows = await this.database.dbAll(
					DB_NAME,
					"SELECT author_name, author_id, canonical_user_id, text_content, timestamp FROM memory_message_buffer WHERE target_id = ? ORDER BY timestamp ASC",
					[targetId]
				);
			}

			if (!rows || rows.length < 5) {
				return;
			}

			const conversationText = rows
				.map((r) => {
					const userTag =
						r.canonical_user_id || (r.author_id ? this.cleanPhone(r.author_id) : "desconhecido");
					return `[ID: ${userTag}] ${r.author_name}: ${r.text_content}`;
				})
				.join("\n");
			const textToAnalyze =
				conversationText.length > 25000 ? conversationText.slice(-25000) : conversationText;

			const prompt = `Analise atentamente a conversa abaixo e extraia inteligência estruturada em formato JSON estrito:
1. 'group_evaluation': (se for grupo de chat)
   - 'type': uma palavra que define o tema (ex: 'jogos', 'politica', 'escola', 'musica', 'zoeira', 'geral').
   - 'summary': resumo conciso em até 200 caracteres dos assuntos principais discutidos.
   - 'vibe': atmosfera observada (ex: 'amigável', 'debochado', 'tenso', 'estudioso').
   - 'suggested_bot_personality': instrução de 1 a 3 frases em pt-BR definindo como o bot Ravena deve se comportar e falar neste grupo específico, incorporando a vibe, gírias e humor observados.
   - 'frequent_topics': lista de até 4 tópicos debatidos (ex: ['Steam', 'Counter-Strike', 'Faculdade']).
   - 'is_underage': marque como true SOMENTE se comprovadamente for grupo de crianças ou adolescentes de ATÉ 16 ANOS. (ATENÇÃO: pessoas de 17 anos ou mais NUNCA são adolescentes/crianças!).
   - 'underage_indicators': lista de evidências de idade até 16 anos se is_underage for true.
   - 'problematic_score': nota de 0 a 10 (0: neutro/jogos/amizade; 2: discussões leves, xingamentos; 4: nsfw, drogas; 6 a 10: crimes, racismo, gore, assédio, pedofilia).
   - 'classified_items': lista de ocorrências graves no formato [{ "category": "...", "evidence": "Autor: fala" }].
2. 'user_facts': extraia apenas fatos e curiosidades duráveis observados sobre as pessoas que falaram (ex: profissão, hobbies, time de futebol, preferências, hábitos, apelidos recebidos). Limite a no máximo 15 participantes relevantes do lote e até 3 fatos concisos por pessoa.
   Formato: array de objetos:
   [
     {
       "user_id": "wa_5511999999999",
       "author_name": "Nome",
       "facts": ["Gosta de pescar", "Trabalha com TI", "Torce pro Palmeiras"],
       "category": "hobby|work|preference|personality"
     }
   ]
   IMPORTANTE: Em 'user_id', use exatamente o ID informado entre colchetes [ID: ...] da mensagem de quem falou.

Conversa:
${textToAnalyze}`;

			const responseFormat = {
				type: "json_schema",
				json_schema: {
					name: "memory_distillation",
					schema: {
						type: "object",
						properties: {
							group_evaluation: {
								type: "object",
								properties: {
									type: { type: "string" },
									summary: { type: "string" },
									vibe: { type: "string" },
									suggested_bot_personality: { type: "string" },
									frequent_topics: { type: "array", items: { type: "string" } },
									is_underage: { type: "boolean" },
									underage_indicators: { type: "array", items: { type: "string" } },
									problematic_score: { type: "number" },
									classified_items: {
										type: "array",
										items: {
											type: "object",
											properties: {
												category: { type: "string" },
												evidence: { type: "string" }
											},
											required: ["category", "evidence"]
										}
									}
								},
								required: ["type", "summary", "problematic_score", "is_underage"]
							},
							user_facts: {
								type: "array",
								items: {
									type: "object",
									properties: {
										user_id: { type: "string" },
										author_name: { type: "string" },
										facts: { type: "array", items: { type: "string" } },
										category: { type: "string" }
									},
									required: ["user_id", "facts"]
								}
							}
						},
						required: ["group_evaluation", "user_facts"]
					}
				}
			};

			const response = await this.llmService.getCompletion({
				prompt,
				response_format: responseFormat,
				priority: 0,
				maxTokens: 4096,
				debugPrompt: false
			});

			if (!response || typeof response !== "string") {
				return;
			}

			let parsed;
			try {
				const clean = response.replace(/```json|```/g, "").trim();
				parsed = JSON.parse(clean);
			} catch (e) {
				this.logger.warn(`[${targetId}] Resposta da IA na destilação não é JSON válido:`, response);
				if (!isPv) {
					await this.database.dbRun(
						DB_NAME,
						"UPDATE memory_group_profiles SET last_summarized_at = ?, messages_since_summary = 0, updated_at = ? WHERE group_id = ?",
						[Date.now(), Date.now(), targetId]
					);
				}
				return;
			}

			const now = Date.now();
			const groupEval = parsed.group_evaluation || {};

			// 1. Processa Dossiê e Moderação do Grupo
			if (!isPv && groupEval.summary && typeof groupEval.problematic_score === "number") {
				// Ajuste de pontuação de proteção a menores
				if (groupEval.is_underage) {
					groupEval.problematic_score = Math.min(10, groupEval.problematic_score + 4);
				}

				const isAlertEligible = groupEval.is_underage
					? groupEval.problematic_score > 4
					: groupEval.problematic_score > 7;

				const isProblematic = isAlertEligible ? 1 : 0;
				const isUnderage = groupEval.is_underage ? 1 : 0;
				const platform = bot?.useTelegram ? "telegram" : "whatsapp";

				// Salva histórico de dossiê
				await this.database.dbRun(
					DB_NAME,
					`INSERT INTO memory_group_dossiers (group_id, platform, dossier_json, conversation_sample, problematic_score, is_problematic, is_underage)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[
						targetId,
						platform,
						JSON.stringify(groupEval),
						isProblematic ? textToAnalyze.slice(-5000) : null,
						groupEval.problematic_score,
						isProblematic,
						isUnderage
					]
				);

				// Mantém os últimos 15 dossiês deste grupo
				await this.database.dbRun(
					DB_NAME,
					`DELETE FROM memory_group_dossiers WHERE id IN (
						SELECT id FROM memory_group_dossiers WHERE group_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 15
					)`,
					[targetId]
				);

				// Atualiza o perfil vivo do grupo
				await this.database.dbRun(
					DB_NAME,
					`UPDATE memory_group_profiles SET 
						vibe_summary = ?,
						frequent_topics = ?,
						latest_summary = ?,
						last_summarized_at = ?,
						messages_since_summary = 0,
						total_messages_analyzed = total_messages_analyzed + ?,
						average_problematic_score = ?,
						updated_at = ?
					 WHERE group_id = ?`,
					[
						groupEval.vibe || "descontraído",
						JSON.stringify(groupEval.frequent_topics || []),
						groupEval.summary,
						now,
						rows.length,
						groupEval.problematic_score,
						now,
						targetId
					]
				);

				// Atualização da Personalidade Dinâmica do Grupo
				try {
					const groupObj = await this.database.getGroup(targetId);
					if (groupObj && groupObj.dinamicPersonality !== false) {
						const dynamicHint = groupEval.suggested_bot_personality;
						if (dynamicHint && typeof dynamicHint === "string" && dynamicHint.trim().length > 10) {
							groupObj.customAIPrompt = dynamicHint.trim().slice(0, 1500);
							await this.database.saveGroup(groupObj);
							this.logger.info(
								`[${targetId}] Personalidade dinâmica adaptada com sucesso: "${groupObj.customAIPrompt}"`
							);
						}
					}
				} catch (dynErr) {
					this.logger.warn(
						`[${targetId}] Falha ao adaptar personalidade dinâmica:`,
						dynErr.message
					);
				}

				// Dispara alerta se elegível
				if (bot && isAlertEligible) {
					this._sendGroupAlert(bot, targetId, groupEval).catch((e) =>
						this.logger.error("Erro ao enviar alerta de grupo:", e)
					);
				}
			}

			// 2. Processa Fatos de Usuários (Global)
			if (Array.isArray(parsed.user_facts) && parsed.user_facts.length > 0) {
				const validCanonicals = new Set(rows.map((r) => r.canonical_user_id).filter(Boolean));

				for (const uFact of parsed.user_facts) {
					if (
						(!uFact.user_id && !uFact.author_name) ||
						!Array.isArray(uFact.facts) ||
						uFact.facts.length === 0
					) {
						continue;
					}

					let canonicalId = null;

					// 1. Prioridade máxima: ID canônico direto informado pela IA (ex: wa_5511..., 5511...)
					if (uFact.user_id && typeof uFact.user_id === "string") {
						const rawUserId = uFact.user_id
							.trim()
							.replace(/^\[(?:ID:\s*)?/i, "")
							.replace(/\]$/, "")
							.trim();

						if (validCanonicals.has(rawUserId)) {
							canonicalId = rawUserId;
						} else {
							// Normaliza telefone se veio apenas os dígitos
							const num = this.cleanPhone(rawUserId);
							if (num && num.length >= 8) {
								if (validCanonicals.has(`wa_${num}`)) {
									canonicalId = `wa_${num}`;
								} else if (validCanonicals.has(`user_${num}`)) {
									canonicalId = `wa_${num}`;
								} else {
									canonicalId = `wa_${num}`;
								}
							} else if (rawUserId.startsWith("wa_") || rawUserId.startsWith("tg_")) {
								canonicalId = rawUserId;
							}
						}
					}

					// 2. Fallback: Se não encontrou por user_id, tenta localizar por author_name
					if (!canonicalId && uFact.author_name) {
						const targetNameNorm = this.normalizeAuthorName(uFact.author_name);

						// 2.1 Busca exata ou por normalização Unicode/símbolos nos participantes do lote
						const matchingRow = rows.find((r) => {
							if (!r.author_name) return false;
							if (r.author_name.toLowerCase() === uFact.author_name.toLowerCase()) return true;
							const rowNameNorm = this.normalizeAuthorName(r.author_name);
							if (rowNameNorm && targetNameNorm) {
								if (rowNameNorm === targetNameNorm) return true;
								if (rowNameNorm.length >= 3 && targetNameNorm.length >= 3) {
									return (
										rowNameNorm.includes(targetNameNorm) || targetNameNorm.includes(rowNameNorm)
									);
								}
							}
							return false;
						});

						canonicalId = matchingRow?.canonical_user_id || null;

						// 2.2 Tenta localizar no banco por display_name
						if (!canonicalId) {
							try {
								const ident = await this.database.dbGet(
									DB_NAME,
									"SELECT canonical_user_id FROM memory_identities WHERE display_name = ? COLLATE NOCASE LIMIT 1",
									[uFact.author_name]
								);
								if (ident) {
									canonicalId = ident.canonical_user_id;
								}
							} catch (e) {}
						}
					}

					// Se encontrou canonicalId e for no formato user_[0-9]{8,}, normaliza para wa_
					if (canonicalId && canonicalId.startsWith("user_")) {
						const num = this.cleanPhone(canonicalId);
						if (num && num.length >= 8) {
							canonicalId = `wa_${num}`;
						}
					}

					if (!canonicalId && uFact.author_name) {
						const num = this.cleanPhone(uFact.author_name);
						if (num && num.length >= 8) {
							canonicalId = `wa_${num}`;
						}
					}

					if (!canonicalId) {
						this.logger.debug(
							`[${targetId}] Fato descartado por não encontrar autor canônico correspondente: ID="${uFact.user_id || ""}", Nome="${uFact.author_name || ""}"`
						);
						continue;
					}

					for (const factText of uFact.facts) {
						if (!factText || typeof factText !== "string" || factText.trim().length < 5) {
							continue;
						}
						await this.addOrUpdateUserFact(
							canonicalId,
							factText.trim(),
							uFact.category || "general",
							isPv ? "pv" : "group",
							targetId
						);
					}
				}
			}

			// 3. Limpa o excesso de mensagens já destiladas do buffer, mantendo apenas as 25 mais recentes para contexto imediato
			await this.database.dbRun(
				DB_NAME,
				`DELETE FROM memory_message_buffer WHERE rowid IN (
					SELECT rowid FROM memory_message_buffer
					WHERE target_id = ?
					ORDER BY timestamp DESC
					LIMIT -1 OFFSET 25
				)`,
				[targetId]
			);

			this.logger.info(
				`[${targetId}] Destilação concluída com sucesso! (${(parsed.user_facts || []).length} perfis enriquecidos)`
			);
		} catch (error) {
			this.logger.error(`[${targetId}] Falha na destilação de memória:`, error);
		} finally {
			this.activeAnalyses.delete(targetId);
		}
	}

	/**
	 * Adiciona ou confirma um fato semântico sobre um usuário, gerando embedding BGE-M3
	 * @param {string} canonicalUserId
	 * @param {string} factText
	 * @param {string} category
	 * @param {string} sourceType
	 * @param {string} sourceId
	 */
	async addOrUpdateUserFact(
		canonicalUserId,
		factText,
		category = "general",
		sourceType = "group",
		sourceId = ""
	) {
		const now = Date.now();
		try {
			// Busca fatos existentes do usuário para verificar duplicidade ou redundância semântica
			const existingFacts = await this.database.dbAll(
				DB_NAME,
				"SELECT id, fact_text, embedding FROM memory_user_facts WHERE canonical_user_id = ?",
				[canonicalUserId]
			);

			// Gera embedding do novo fato
			const newVec = await this.embeddingService.getEmbedding(factText);

			let matchedId = null;
			if (newVec && existingFacts && existingFacts.length > 0) {
				for (const ef of existingFacts) {
					if (ef.fact_text.toLowerCase() === factText.toLowerCase()) {
						matchedId = ef.id;
						break;
					}
					if (ef.embedding) {
						const efVec = this.embeddingService.bufferToVector(ef.embedding);
						if (efVec) {
							const sim = this.embeddingService.cosineSimilarity(newVec, efVec);
							if (sim >= 0.88) {
								matchedId = ef.id;
								break;
							}
						}
					}
				}
			}

			if (matchedId) {
				// Atualiza última confirmação
				await this.database.dbRun(
					DB_NAME,
					"UPDATE memory_user_facts SET last_confirmed_at = ?, confidence = MIN(1.0, confidence + 0.1) WHERE id = ?",
					[now, matchedId]
				);
			} else {
				// Insere novo fato com vetor BLOB
				const blob = newVec ? this.embeddingService.vectorToBuffer(newVec) : null;
				await this.database.dbRun(
					DB_NAME,
					`INSERT INTO memory_user_facts (canonical_user_id, fact_text, category, confidence, embedding, source_type, source_id, extracted_at, last_confirmed_at)
					 VALUES (?, ?, ?, 1.0, ?, ?, ?, ?, ?)`,
					[canonicalUserId, factText, category, blob, sourceType, sourceId, now, now]
				);
			}
		} catch (err) {
			this.logger.error(`Erro ao adicionar fato para ${canonicalUserId}:`, err);
		}
	}

	/**
	 * Recupera o resumo rolling do grupo (instantâneo se recente, on-demand se defasado)
	 * @param {string} groupId
	 * @param {Object} [bot]
	 * @returns {Promise<string>} Resumo formatado
	 */
	async getRollingSummary(groupId, bot = null) {
		const now = Date.now();
		const profile = await this.database.dbGet(
			DB_NAME,
			"SELECT latest_summary, last_summarized_at, messages_since_summary FROM memory_group_profiles WHERE group_id = ?",
			[groupId]
		);

		const isStale =
			!profile ||
			!profile.latest_summary ||
			profile.messages_since_summary >= 20 ||
			now - (profile.last_summarized_at || 0) > 15 * 60 * 1000;

		if (!isStale) {
			return profile.latest_summary;
		}

		// Se estiver defasado, tenta gerar sob demanda
		try {
			await this.triggerBatchDistillation(groupId, false, bot);
			const updated = await this.database.dbGet(
				DB_NAME,
				"SELECT latest_summary FROM memory_group_profiles WHERE group_id = ?",
				[groupId]
			);
			return updated?.latest_summary || profile?.latest_summary || "Conversa recente em andamento.";
		} catch (e) {
			return profile?.latest_summary || "Nenhum resumo disponível no momento.";
		}
	}

	/**
	 * Constrói o contexto para o comando !interagir ou respostas autônomas
	 * @param {string} groupId
	 * @returns {Promise<Object>} { recentMessagesFormatted, groupVibe, speakerFacts }
	 */
	async getInteractionContext(groupId) {
		try {
			// 1. Busca últimas 15 mensagens imediatas
			const recentRows = await this.database.dbAll(
				DB_NAME,
				"SELECT author_name, canonical_user_id, text_content FROM memory_message_buffer WHERE target_id = ? ORDER BY timestamp DESC LIMIT 15",
				[groupId]
			);

			const recentMessages = recentRows.reverse();
			const recentFormatted = recentMessages
				.map((r) => `${r.author_name}: ${r.text_content}`)
				.join("\n");

			// 2. Busca perfil do grupo
			const profile = await this.database.dbGet(
				DB_NAME,
				"SELECT vibe_summary, latest_summary, bot_personality_hint FROM memory_group_profiles WHERE group_id = ?",
				[groupId]
			);

			// 3. Busca fatos dos autores que falaram recentemente
			const authorIds = [...new Set(recentMessages.map((r) => r.canonical_user_id))].filter(
				Boolean
			);
			const speakerFacts = [];

			for (const aId of authorIds.slice(0, 4)) {
				const authorRow = recentMessages.find((r) => r.canonical_user_id === aId);
				const facts = await this.database.dbAll(
					DB_NAME,
					"SELECT fact_text FROM memory_user_facts WHERE canonical_user_id = ? ORDER BY last_confirmed_at DESC LIMIT 3",
					[aId]
				);

				if (facts && facts.length > 0) {
					speakerFacts.push({
						author_name: authorRow?.author_name || "Membro",
						facts: facts.map((f) => f.fact_text)
					});
				}
			}

			return {
				recentFormatted,
				groupVibe: profile?.vibe_summary || "descontraído",
				latestSummary: profile?.latest_summary || "",
				personalityHint: profile?.bot_personality_hint || "",
				speakerFacts
			};
		} catch (error) {
			this.logger.error("Erro ao obter contexto de interação:", error);
			return {
				recentFormatted: "",
				groupVibe: "",
				latestSummary: "",
				personalityHint: "",
				speakerFacts: []
			};
		}
	}

	/**
	 * Compila o Dossiê 360 Completo de uma pessoa buscando estritamente pelo canonical_user_id
	 * @param {string} target - canonical_user_id (ex: 'wa_55...', 'user_...'), platform_id (JID, LID) ou telefone
	 * @returns {Promise<Object|null>} Dossiê 360 estruturado
	 */
	async getUser360(target) {
		if (!target) return null;
		const cleanTarget = String(target).trim();

		try {
			let canonicalId = null;
			let primaryIdentity = null;

			// 1. Prioridade Máxima: Correspondência EXATA por canonical_user_id
			primaryIdentity = await this.database.dbGet(
				DB_NAME,
				"SELECT * FROM memory_identities WHERE canonical_user_id = ? LIMIT 1",
				[cleanTarget]
			);

			if (primaryIdentity) {
				canonicalId = primaryIdentity.canonical_user_id;
			} else {
				// 2. Correspondência EXATA por platform_id (JID ou LID exatos)
				primaryIdentity = await this.database.dbGet(
					DB_NAME,
					"SELECT * FROM memory_identities WHERE platform_id = ? LIMIT 1",
					[cleanTarget]
				);
				if (primaryIdentity) {
					canonicalId = primaryIdentity.canonical_user_id;
				}
			}

			// 3. Telefone numérico limpo (apenas se tiver 8+ dígitos)
			if (!canonicalId) {
				const cleanPhone = this.cleanPhone(cleanTarget);
				if (cleanPhone && cleanPhone.length >= 8) {
					primaryIdentity = await this.database.dbGet(
						DB_NAME,
						"SELECT * FROM memory_identities WHERE canonical_user_id = ? OR platform_id LIKE ? LIMIT 1",
						[`wa_${cleanPhone}`, `%${cleanPhone}%`]
					);
					canonicalId = primaryIdentity ? primaryIdentity.canonical_user_id : `wa_${cleanPhone}`;
				}
			}

			// 4. Verificação direta em fatos semânticos caso a identidade não tenha sido persistida
			if (!canonicalId) {
				const factExists = await this.database.dbGet(
					DB_NAME,
					"SELECT id FROM memory_user_facts WHERE canonical_user_id = ? LIMIT 1",
					[cleanTarget]
				);
				if (factExists) {
					canonicalId = cleanTarget;
				}
			}

			if (!canonicalId) return null;

			// 5. Busca todas as identidades vinculadas
			const allIdentities = await this.database.dbAll(
				DB_NAME,
				"SELECT platform, platform_id, id_type, display_name FROM memory_identities WHERE canonical_user_id = ?",
				[canonicalId]
			);

			// 6. Fatos semânticos memorizados (busca estrita pelo canonicalId)
			const facts = await this.database.dbAll(
				DB_NAME,
				`SELECT fact_text, category, confidence, source_type, last_confirmed_at 
				 FROM memory_user_facts 
				 WHERE canonical_user_id = ? 
				 ORDER BY last_confirmed_at DESC LIMIT 30`,
				[canonicalId]
			);

			// 7. Jogos da Ravena (Pesca, Slots, Roleta, Doações)
			const userPhone =
				this.cleanPhone(canonicalId) ||
				(primaryIdentity ? this.cleanPhone(primaryIdentity.platform_id) : "");
			let fishingData = null;
			let slotsData = null;
			let donationData = null;
			let rankingData = [];
			let afkData = [];
			let relationshipData = [];

			if (userPhone && userPhone.length >= 8) {
				try {
					fishingData = await this.database.dbGet(
						"fishing",
						"SELECT level, total_fishes_caught, rare_fishes_caught, legendary_fishes_caught, equipped_rod, xp FROM fishing_users WHERE user_id = ?",
						[userPhone]
					);
				} catch (e) {}

				try {
					slotsData = await this.database.dbGet(
						"slots",
						"SELECT coins, total_bets, total_wins FROM slots_users WHERE user_id = ?",
						[userPhone]
					);
				} catch (e) {}

				try {
					const donor = await this.database.getDonorByNumber(userPhone);
					if (donor) {
						donationData = {
							name: donor.nome,
							valor: donor.valor,
							timestamp: donor.timestamp
						};
					}
				} catch (e) {}

				try {
					rankingData = await this.database.dbAll(
						"msgranking",
						"SELECT group_id, count FROM ranking WHERE user_id = ? ORDER BY count DESC LIMIT 5",
						[userPhone]
					);
				} catch (e) {}

				try {
					afkData = await this.database.dbAll(
						"afk",
						"SELECT reason, entered_at FROM afk_sessions WHERE user_id = ? ORDER BY entered_at DESC LIMIT 3",
						[userPhone]
					);
				} catch (e) {}

				try {
					relationshipData = await this.database.dbAll(
						"relacionamentos",
						"SELECT user1, user2, tipo, status, coisas_count FROM relacionamentos WHERE (user1 = ? OR user2 = ?) AND status = 'ativo'",
						[userPhone, userPhone]
					);
				} catch (e) {}
			}

			// 8. Grupos onde já interagiu no buffer
			const activeGroups = await this.database.dbAll(
				DB_NAME,
				`SELECT target_id, COUNT(*) as msgs_count 
				 FROM memory_message_buffer 
				 WHERE canonical_user_id = ? AND is_pv = 0
				 GROUP BY target_id ORDER BY msgs_count DESC LIMIT 5`,
				[canonicalId]
			);

			return {
				canonical_user_id: canonicalId,
				display_name:
					primaryIdentity?.display_name ||
					userPhone ||
					canonicalId.replace(/^user_/, "").replace(/_/g, " "),
				identities: allIdentities || [],
				facts: facts || [],
				games: {
					fishing: fishingData || null,
					slots: slotsData || null,
					donation: donationData || null,
					ranking: rankingData || [],
					afk: afkData || [],
					relationships: relationshipData || []
				},
				active_groups: activeGroups || []
			};
		} catch (error) {
			this.logger.error(`Erro ao gerar User360 para ${target}:`, error);
			return null;
		}
	}

	/**
	 * Compila o Dossiê 360 Completo de um grupo (perfil + histórico de dossiês)
	 * @param {string} groupId - JID do grupo (ex: '120363...@g.us')
	 * @returns {Promise<Object|null>} Dossiê 360 do grupo
	 */
	async getGroup360(groupId) {
		if (!groupId) return null;
		const cleanGroupId = String(groupId).trim();

		try {
			// 1. Perfil vivo em memory_group_profiles
			const profile = await this.database.dbGet(
				DB_NAME,
				"SELECT * FROM memory_group_profiles WHERE group_id = ? LIMIT 1",
				[cleanGroupId]
			);

			// 2. Dossiês em memory_group_dossiers
			let dossiers = await this.database.dbAll(
				DB_NAME,
				`SELECT dossier_json, conversation_sample, problematic_score, is_problematic, is_underage, created_at 
				 FROM memory_group_dossiers 
				 WHERE group_id = ? 
				 ORDER BY created_at DESC LIMIT 5`,
				[cleanGroupId]
			);

			// 3. Fallback para summaries.db se não houver em memory.db
			if (!dossiers || dossiers.length === 0) {
				try {
					const oldDossiers = await this.database.getLastGroupDossiers(cleanGroupId, 5);
					if (oldDossiers && oldDossiers.length > 0) {
						dossiers = oldDossiers;
					}
				} catch (e) {}
			}

			if (!profile && (!dossiers || dossiers.length === 0)) {
				return null;
			}

			return {
				group_id: cleanGroupId,
				profile: profile || null,
				dossiers: dossiers || []
			};
		} catch (error) {
			this.logger.error(`Erro ao gerar Group360 para ${groupId}:`, error);
			return null;
		}
	}

	/**
	 * Busca fatos semânticos de um usuário mais relevantes para uma determinada pergunta
	 * @param {string} canonicalUserId
	 * @param {string} queryText
	 * @param {number} [topK=6]
	 * @returns {Promise<Array<Object>>}
	 */
	async searchRelevantUserFacts(canonicalUserId, queryText, topK = 6) {
		try {
			const facts = await this.database.dbAll(
				DB_NAME,
				"SELECT id, fact_text, embedding, category, last_confirmed_at FROM memory_user_facts WHERE canonical_user_id = ?",
				[canonicalUserId]
			);
			if (!facts || facts.length === 0) return [];

			if (!queryText || queryText.trim().length < 4) {
				return facts.sort((a, b) => b.last_confirmed_at - a.last_confirmed_at).slice(0, topK);
			}

			const queryVec = await this.embeddingService.getEmbedding(queryText);
			if (!queryVec) {
				return facts.sort((a, b) => b.last_confirmed_at - a.last_confirmed_at).slice(0, topK);
			}

			const scored = [];
			for (const f of facts) {
				let score = 0;
				if (f.embedding) {
					const fVec = this.embeddingService.bufferToVector(f.embedding);
					if (fVec) {
						score = this.embeddingService.cosineSimilarity(queryVec, fVec);
					}
				}
				scored.push({ ...f, similarity: score });
			}

			scored.sort((a, b) => b.similarity - a.similarity);
			return scored.slice(0, topK);
		} catch (error) {
			this.logger.warn(`Erro ao buscar fatos semânticos para ${canonicalUserId}:`, error.message);
			return [];
		}
	}

	/**
	 * Compila o contexto de memória do usuário pronto para injeção no prompt da IA
	 * @param {string} rawUserId - JID, LID, número ou canonical_user_id
	 * @param {string} [queryText] - Pergunta atual para busca vetorial
	 * @param {string} [headerRole="INTERLOCUTOR"] - Rótulo no prompt (ex: "INTERLOCUTOR", "USUÁRIO MENCIONADO")
	 * @returns {Promise<string>}
	 */
	async getUserContextForPrompt(rawUserId, queryText = "", headerRole = "INTERLOCUTOR") {
		if (!rawUserId) return "";
		try {
			const canonicalId = await this.resolveCanonicalUserId("whatsapp", rawUserId, "jid");
			const identity = await this.database.dbGet(
				DB_NAME,
				"SELECT display_name FROM memory_identities WHERE canonical_user_id = ? LIMIT 1",
				[canonicalId]
			);

			let facts = await this.searchRelevantUserFacts(canonicalId, queryText, 8);
			if (!facts || facts.length === 0) {
				facts = await this.database.dbAll(
					DB_NAME,
					"SELECT fact_text FROM memory_user_facts WHERE canonical_user_id = ? ORDER BY last_confirmed_at DESC LIMIT 8",
					[canonicalId]
				);
			}

			const userPhone = this.cleanPhone(canonicalId) || this.cleanPhone(rawUserId);
			const adminPhones = this.getSuperAdminPhones();
			const isCreator =
				this.isSuperAdmin(userPhone) ||
				this.isSuperAdmin(canonicalId) ||
				this.isSuperAdmin(rawUserId);
			const gameDetails = [];

			if (userPhone && userPhone.length >= 8 && !isCreator) {
				try {
					const fishing = await this.database.dbGet(
						"fishing",
						"SELECT level, legendary_fishes_caught FROM fishing_users WHERE user_id = ?",
						[userPhone]
					);
					if (fishing && fishing.level > 1) {
						gameDetails.push(
							`Pesca: Nível ${fishing.level} (Lendários fisgados: ${fishing.legendary_fishes_caught || 0})`
						);
					}
				} catch (e) {}

				try {
					const donation = await this.database.getDonorByNumber(userPhone);
					if (donation) {
						gameDetails.push("Apoiador/Doador do RavenaBot");
					}
				} catch (e) {}
			}

			if ((!facts || facts.length === 0) && gameDetails.length === 0 && !isCreator) {
				return "";
			}

			let nameStr = identity?.display_name || "Membro";
			if (isCreator) {
				nameStr = "moothz (Criador da Ravena)";
			}

			let ctx = `\n[MEMÓRIA E FATOS SOBRE O ${headerRole} (${nameStr})]:\n`;
			if (facts && facts.length > 0) {
				for (const f of facts) {
					ctx += `• ${f.fact_text}\n`;
				}
			}
			if (gameDetails.length > 0) {
				ctx += `• Dados nos jogos da Ravena: ${gameDetails.join(" | ")}\n`;
			}

			// REGRA CRÍTICA DE PRIVACIDADE: Números de Super Admins / Criador NUNCA devem constar no prompt da IA
			if (isCreator) {
				for (const adminPhone of adminPhones) {
					if (adminPhone && adminPhone.length >= 8) {
						const regex = new RegExp(adminPhone, "g");
						ctx = ctx.replace(regex, "Criador");
						const waRegex = new RegExp(`wa_${adminPhone}`, "g");
						ctx = ctx.replace(waRegex, "Criador");
					}
				}
			}

			return ctx;
		} catch (err) {
			this.logger.warn("Erro ao obter contexto de usuário para prompt:", err.message);
			return "";
		}
	}

	/**
	 * Compila o contexto vivo e cultura do grupo para injeção no prompt da IA
	 * @param {string} groupId
	 * @returns {Promise<string>}
	 */
	async getGroupContextForPrompt(groupId) {
		if (!groupId) return "";
		try {
			const profile = await this.database.dbGet(
				DB_NAME,
				"SELECT vibe_summary, frequent_topics, latest_summary FROM memory_group_profiles WHERE group_id = ?",
				[groupId]
			);
			if (!profile) return "";

			let ctx = "\n[CONTEXTO VIVO DO GRUPO]:\n";
			if (profile.vibe_summary) {
				ctx += `• Vibe do grupo: ${profile.vibe_summary}\n`;
			}
			if (profile.frequent_topics) {
				try {
					const topics = JSON.parse(profile.frequent_topics);
					if (Array.isArray(topics) && topics.length > 0) {
						ctx += `• Assuntos comuns no grupo: ${topics.join(", ")}\n`;
					}
				} catch (e) {}
			}
			if (profile.latest_summary) {
				ctx += `• O que rolou recentemente no grupo: ${profile.latest_summary}\n`;
			}
			return ctx;
		} catch (err) {
			return "";
		}
	}

	/**
	 * Busca de usuários para a API Web
	 * @param {string} query
	 * @param {number} limit
	 * @param {number} offset
	 */
	async searchUsers(query = "", limit = 30, offset = 0) {
		try {
			let sql = `
				SELECT mi.canonical_user_id, mi.display_name, mi.platform_id, mi.platform, mi.id_type,
				       COUNT(DISTINCT muf.id) as facts_count,
				       MAX(muf.last_confirmed_at) as last_seen
				FROM memory_identities mi
				LEFT JOIN memory_user_facts muf ON mi.canonical_user_id = muf.canonical_user_id
			`;
			const params = [];

			if (query && query.trim().length > 0) {
				const clean = query.trim();
				const cleanNum = this.cleanPhone(clean);
				sql += ` WHERE mi.display_name LIKE ? OR mi.platform_id LIKE ? OR mi.canonical_user_id LIKE ?`;
				params.push(`%${clean}%`, `%${cleanNum || clean}%`, `%${clean}%`);
			}

			sql += ` GROUP BY mi.canonical_user_id ORDER BY facts_count DESC, last_seen DESC LIMIT ? OFFSET ?`;
			params.push(limit, offset);

			return await this.database.dbAll(DB_NAME, sql, params);
		} catch (error) {
			this.logger.error("Erro na busca de usuários:", error);
			return [];
		}
	}

	/**
	 * Busca de dossiês de grupos para a API Web
	 * @param {string} query
	 * @param {number} limit
	 * @param {number} offset
	 */
	async searchGroups(query = "", limit = 30, offset = 0) {
		try {
			let sql = `
				SELECT gp.*, 
				       (SELECT COUNT(*) FROM memory_group_dossiers gd WHERE gd.group_id = gp.group_id) as dossiers_count,
				       (SELECT COUNT(*) FROM memory_group_dossiers gd WHERE gd.group_id = gp.group_id AND (gd.is_problematic = 1 OR gd.is_underage = 1)) as problematic_reports_count
				FROM memory_group_profiles gp
			`;
			const params = [];

			if (query && query.trim().length > 0) {
				const clean = query.trim();
				sql += ` WHERE gp.title LIKE ? OR gp.group_id LIKE ? OR gp.vibe_summary LIKE ? OR gp.frequent_topics LIKE ?`;
				params.push(`%${clean}%`, `%${clean}%`, `%${clean}%`, `%${clean}%`);
			}

			sql += ` ORDER BY gp.average_problematic_score DESC, gp.updated_at DESC LIMIT ? OFFSET ?`;
			params.push(limit, offset);

			return await this.database.dbAll(DB_NAME, sql, params);
		} catch (error) {
			this.logger.error("Erro na busca de grupos:", error);
			return [];
		}
	}

	/**
	 * Envia alerta de moderação para o canal de dossiês
	 */
	async _sendGroupAlert(bot, groupId, groupEval) {
		const targetGroup =
			bot.dossieGroups || bot.grupoLogs || process.env.GRUPO_DOSSIES || process.env.GRUPO_LOGS;
		if (!targetGroup) return;

		const groupData = await bot.database?.getGroup?.(groupId);
		const alertTitle = groupEval.is_underage
			? "⚠️ *ALERTA DE GRUPO DE CRIANÇAS/ADOLESCENTES (RME)* ⚠️"
			: "⚠️ *ALERTA DE GRUPO POSSIVELMENTE PROBLEMÁTICO (RME)* ⚠️";

		let evText = "";
		if (Array.isArray(groupEval.classified_items) && groupEval.classified_items.length > 0) {
			evText =
				"\n🚩 *Evidências:* \n" +
				groupEval.classified_items.map((it) => `• *${it.category}:* "${it.evidence}"`).join("\n");
		}

		let underageText = "";
		if (groupEval.is_underage && Array.isArray(groupEval.underage_indicators)) {
			underageText = "\n👶 *Menores Detectados:* " + groupEval.underage_indicators.join(", ");
		}

		const msgAlert = `${alertTitle}

📌 *Grupo:* ${groupData ? groupData.name : "N/A"}
🆔 *ID:* ${groupId}
🤖 *Bot:* ${bot.id}

📊 *Análise da Memória:*
- *Tipo:* ${groupEval.type}
- *Nota de Risco:* ${groupEval.problematic_score}/10
- *Resumo:* ${groupEval.summary}${underageText}${evText}

!sa-leaveGrupo ${groupId}`;

		const targetGroups = Array.isArray(targetGroup)
			? targetGroup
			: String(targetGroup).includes(",")
				? String(targetGroup)
						.split(",")
						.map((g) => g.trim())
				: [targetGroup];

		for (const tg of targetGroups) {
			bot.sendMessage(tg, msgAlert).catch(() => {});
		}
	}

	/**
	 * Executa o Bootstrap Inicial (Fase 1) migrando dados existentes
	 */
	async bootstrapPhase1() {
		this.logger.info("Iniciando Bootstrap Inicial (Fase 1) do MemoryService...");
		const now = Date.now();
		let migratedIdentities = 0;
		let migratedDossiers = 0;

		try {
			// 1. Mapeia pares JID <-> LID de afk_sessions
			try {
				const afkRows = await this.database.dbAll(
					"afk",
					"SELECT DISTINCT user_id, user_lid, user_name FROM afk_sessions WHERE user_id IS NOT NULL AND user_lid IS NOT NULL"
				);
				if (afkRows && afkRows.length > 0) {
					for (const row of afkRows) {
						await this.linkLidToPn(row.user_lid, row.user_id, row.user_name);
						migratedIdentities++;
					}
				}
			} catch (e) {
				this.logger.warn("Pulo no bootstrap de afk_sessions:", e.message);
			}

			// 2. Mapeia doadores de core.db
			try {
				const donors = await this.database.dbAll(
					"core",
					"SELECT name, numero FROM donations WHERE numero IS NOT NULL"
				);
				if (donors && donors.length > 0) {
					for (const d of donors) {
						const num = this.cleanPhone(d.numero);
						if (num) {
							await this.resolveCanonicalUserId("whatsapp", `${num}@s.whatsapp.net`, "jid", d.name);
							migratedIdentities++;
						}
					}
				}
			} catch (e) {
				this.logger.warn("Pulo no bootstrap de doações:", e.message);
			}

			// 3. Migra dossiês históricos de summaries.db
			try {
				const oldDossiers = await this.database.dbAll(
					"summaries",
					"SELECT group_id, dossier_json, conversation_history, problematic_score, is_problematic, is_underage, created_at FROM group_dossiers ORDER BY id ASC LIMIT 5000"
				);
				if (oldDossiers && oldDossiers.length > 0) {
					for (const od of oldDossiers) {
						await this.database.dbRun(
							DB_NAME,
							`INSERT INTO memory_group_dossiers (group_id, platform, dossier_json, conversation_sample, problematic_score, is_problematic, is_underage, created_at)
							 VALUES (?, 'whatsapp', ?, ?, ?, ?, ?, ?)`,
							[
								od.group_id,
								od.dossier_json,
								od.conversation_history,
								od.problematic_score || 0,
								od.is_problematic || 0,
								od.is_underage || 0,
								od.created_at
							]
						);
						migratedDossiers++;

						// Cria/atualiza perfil do grupo com base no último
						try {
							const parsed = JSON.parse(od.dossier_json);
							await this.database.dbRun(
								DB_NAME,
								`INSERT INTO memory_group_profiles (group_id, platform, title, vibe_summary, latest_summary, last_summarized_at, messages_since_summary, total_messages_analyzed, average_problematic_score, updated_at)
								 VALUES (?, 'whatsapp', ?, ?, ?, ?, 0, 1, ?, ?)
								 ON CONFLICT(group_id) DO UPDATE SET 
									latest_summary = excluded.latest_summary,
									average_problematic_score = excluded.average_problematic_score,
									updated_at = excluded.updated_at`,
								[
									od.group_id,
									od.group_id,
									parsed.type || "geral",
									parsed.summary || "",
									now,
									od.problematic_score || 0,
									now
								]
							);
						} catch (jsonErr) {}
					}
				}
			} catch (e) {
				this.logger.warn("Pulo no bootstrap de dossiês:", e.message);
			}

			this.logger.info(
				`Bootstrap Fase 1 finalizado: ${migratedIdentities} identidades e ${migratedDossiers} dossiês importados.`
			);
			return { migratedIdentities, migratedDossiers };
		} catch (error) {
			this.logger.error("Erro fatal no bootstrap da Fase 1:", error);
			return { migratedIdentities, migratedDossiers, error: error.message };
		}
	}
}

module.exports = MemoryService;
