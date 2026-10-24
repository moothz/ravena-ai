const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const { validateRegexFilter, buildRegex } = require("../utils/RegexFilterValidator");

class GroupMonitoringService {
	constructor(options = {}) {
		this.logger = new Logger("group-monitoring");
		this.database = options.database || Database.getInstance();
		this.DB_NAME = "group_monitoring";
		this.MAX_RULES_PER_GROUP = 15;
		this.MIN_PATTERN_LENGTH = 5;
		this.MAX_OCCURRENCES_PER_GROUP = 250;
		this.MAX_STORAGE_BYTES = 2.5 * 1024 * 1024 * 1024; // 2.5 GB

		// In-memory caches
		this.rulesCache = new Map(); // groupId -> Array<Rule>
		this.messageBuffers = new Map(); // groupId -> Array<{ timestamp, line }>
		this.pendingOccurrences = []; // Array<{ id, groupId, afterNeeded, afterMessages }>

		// Cron cleaner
		this.cronExpression = options.cronExpression || "0 4 * * *"; // 04:00 BRT
		this.timeZone = options.timeZone || "America/Sao_Paulo";
		this.cleanerJob = null;

		this.initDatabase();
	}

	static getInstance(options = {}) {
		if (!GroupMonitoringService.instance) {
			GroupMonitoringService.instance = new GroupMonitoringService(options);
		}
		return GroupMonitoringService.instance;
	}

	initDatabase() {
		const schema = `
			CREATE TABLE IF NOT EXISTS monitoring_rules (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL,
				type TEXT NOT NULL,
				pattern TEXT NOT NULL,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				created_by TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_monitoring_rules_group ON monitoring_rules(group_id);

			CREATE TABLE IF NOT EXISTS monitoring_occurrences (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_id TEXT NOT NULL,
				rule_type TEXT NOT NULL,
				pattern TEXT NOT NULL,
				trigger_message TEXT NOT NULL,
				author_name TEXT,
				author_number TEXT,
				before_messages TEXT,
				after_messages TEXT,
				is_read INTEGER DEFAULT 0,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				completed_at DATETIME
			);
			CREATE INDEX IF NOT EXISTS idx_monitoring_occ_group_read ON monitoring_occurrences(group_id, is_read);
			CREATE INDEX IF NOT EXISTS idx_monitoring_occ_created ON monitoring_occurrences(created_at);
		`;

		this.database.getSQLiteDb(this.DB_NAME, schema, true);
	}

	startCleaner() {
		if (process.env.DISABLE_ACTIVITY === "true") {
			this.logger.debug("Cleaner de monitoramento desativado por DISABLE_ACTIVITY.");
			return;
		}

		if (this.cleanerJob) return;

		this.cleanerJob = cron.schedule(
			this.cronExpression,
			async () => {
				this.logger.info("Iniciando rotina noturna de limpeza do banco de monitoramento...");
				try {
					await this.cleanOldOccurrences();
				} catch (err) {
					this.logger.error("Erro na rotina de limpeza de monitoramento:", err);
				}
			},
			{ timezone: this.timeZone }
		);
		this.logger.info(
			`Cleaner de monitoramento agendado para ${this.cronExpression} (${this.timeZone})`
		);
	}

	stop() {
		if (this.cleanerJob) {
			this.cleanerJob.stop();
			this.cleanerJob = null;
			this.logger.info("Cleaner de monitoramento finalizado.");
		}
	}

	// ─── REGRAS DE MONITORAMENTO ──────────────────────────────────────────────────

	async getRules(groupId) {
		if (!groupId) return [];
		if (this.rulesCache.has(groupId)) {
			return this.rulesCache.get(groupId);
		}

		try {
			const rows = await this.database.dbAll(
				this.DB_NAME,
				"SELECT id, group_id, type, pattern, created_at, created_by FROM monitoring_rules WHERE group_id = ? ORDER BY id ASC",
				[groupId]
			);
			const rules = rows || [];
			this.rulesCache.set(groupId, rules);
			return rules;
		} catch (error) {
			this.logger.error(`Erro ao carregar regras do grupo ${groupId}:`, error);
			return [];
		}
	}

	async addWordRule(groupId, word, createdBy = null) {
		if (!groupId) throw new Error("ID do grupo não informado.");
		const pattern = (word || "").trim();

		if (pattern.length < this.MIN_PATTERN_LENGTH) {
			throw new Error(
				`A palavra ou frase deve ter no mínimo ${this.MIN_PATTERN_LENGTH} caracteres.`
			);
		}

		const currentRules = await this.getRules(groupId);
		if (currentRules.length >= this.MAX_RULES_PER_GROUP) {
			throw new Error(
				`Limite atingido: um grupo pode monitorar no máximo ${this.MAX_RULES_PER_GROUP} regras.`
			);
		}

		const alreadyExists = currentRules.some(
			(r) => r.type === "word" && r.pattern.toLowerCase() === pattern.toLowerCase()
		);
		if (alreadyExists) {
			throw new Error(`A palavra ou frase "${pattern}" já está sendo monitorada neste grupo.`);
		}

		await this.database.dbRun(
			this.DB_NAME,
			"INSERT INTO monitoring_rules (group_id, type, pattern, created_by) VALUES (?, 'word', ?, ?)",
			[groupId, pattern, createdBy]
		);

		this.rulesCache.delete(groupId);
		return this.getRules(groupId);
	}

	async addRegexRule(groupId, regexPattern, createdBy = null) {
		if (!groupId) throw new Error("ID do grupo não informado.");
		const pattern = (regexPattern || "").trim();

		if (pattern.length < 2) {
			throw new Error("Expressão regular inválida ou muito curta.");
		}

		const validation = validateRegexFilter(pattern);
		if (!validation.valid) {
			throw new Error(`Regex inseguro ou muito abrangente: ${validation.error}`);
		}

		const currentRules = await this.getRules(groupId);
		if (currentRules.length >= this.MAX_RULES_PER_GROUP) {
			throw new Error(
				`Limite atingido: um grupo pode monitorar no máximo ${this.MAX_RULES_PER_GROUP} regras.`
			);
		}

		const alreadyExists = currentRules.some((r) => r.type === "regex" && r.pattern === pattern);
		if (alreadyExists) {
			throw new Error(`A expressão regular "${pattern}" já está cadastrada para monitoramento.`);
		}

		await this.database.dbRun(
			this.DB_NAME,
			"INSERT INTO monitoring_rules (group_id, type, pattern, created_by) VALUES (?, 'regex', ?, ?)",
			[groupId, pattern, createdBy]
		);

		this.rulesCache.delete(groupId);
		return this.getRules(groupId);
	}

	async deleteRule(groupId, ruleIndexOrId) {
		if (!groupId) throw new Error("ID do grupo não informado.");
		const currentRules = await this.getRules(groupId);
		if (currentRules.length === 0) {
			throw new Error("Não há regras ativas para remover neste grupo.");
		}

		const parsed = parseInt(ruleIndexOrId, 10);
		if (isNaN(parsed) || parsed < 1) {
			throw new Error("Informe um número de regra válido.");
		}

		// Procura primeiro pelo índice 1..N
		let targetRule = null;
		if (parsed >= 1 && parsed <= currentRules.length) {
			targetRule = currentRules[parsed - 1];
		} else {
			// Fallback: busca pelo id real da tabela
			targetRule = currentRules.find((r) => r.id === parsed);
		}

		if (!targetRule) {
			throw new Error(`Regra #${ruleIndexOrId} não encontrada.`);
		}

		await this.database.dbRun(
			this.DB_NAME,
			"DELETE FROM monitoring_rules WHERE id = ? AND group_id = ?",
			[targetRule.id, groupId]
		);

		this.rulesCache.delete(groupId);
		const updatedRules = await this.getRules(groupId);
		return { deletedRule: targetRule, updatedRules };
	}

	formatRuleList(rules) {
		if (!rules || rules.length === 0) {
			return "Nenhuma regra de monitoramento ativa.";
		}

		return rules
			.map((r, index) => {
				const typeLabel = r.type === "regex" ? "Regex" : "Palavra";
				const displayPattern = r.type === "regex" ? `\`${r.pattern}\`` : `"${r.pattern}"`;
				return `${index + 1}. [${typeLabel}] ${displayPattern}`;
			})
			.join("\n");
	}

	// ─── FORMATAÇÃO E BUFFER DE MENSAGENS ─────────────────────────────────────────

	formatDateTime(timestamp = Date.now()) {
		const d = new Date(timestamp);
		return d
			.toLocaleString("pt-BR", {
				timeZone: "America/Sao_Paulo",
				day: "2-digit",
				month: "2-digit",
				year: "numeric",
				hour: "2-digit",
				minute: "2-digit"
			})
			.replace(",", "");
	}

	formatMessageLine(message) {
		const ts = message.timestamp
			? Number(message.timestamp) * (message.timestamp < 1e11 ? 1000 : 1)
			: Date.now();
		const dateStr = this.formatDateTime(ts);
		const rawNumber = (message.author || message.authorNumber || message.from || "")
			.split("@")[0]
			.replace(/\D/g, "");
		const number = rawNumber || "000000";
		const name =
			message.name ||
			message.authorName ||
			message.pushname ||
			message.notifyName ||
			(rawNumber ? `+${rawNumber}` : "Desconhecido");

		let text = "";
		const isText = message.type === "text" || !message.type;
		if (isText) {
			text = (message.content || "").trim();
		} else {
			const caption = (message.caption || "").trim();
			text = caption ? `<midia> ${caption}` : "<midia>";
		}

		return `[${dateStr}] ${name} (${number}): ${text}`;
	}

	getMessageBuffer(groupId) {
		if (!this.messageBuffers.has(groupId)) {
			this.messageBuffers.set(groupId, []);
		}
		return this.messageBuffers.get(groupId);
	}

	// ─── PROCESSAMENTO DE MENSAGENS E DISPARO DE OCORRÊNCIAS ──────────────────────

	async processMessage(bot, message, group) {
		const groupId = message.group || group?.id;
		if (!groupId) return;

		const formattedLine = this.formatMessageLine(message);
		const rawText =
			(message.type === "text" || !message.type ? message.content : message.caption) || "";

		// 1. Alimenta ocorrências pendentes aguardando as próximas 5 mensagens
		if (this.pendingOccurrences.length > 0) {
			const groupPendings = this.pendingOccurrences.filter((p) => p.groupId === groupId);
			for (const p of groupPendings) {
				p.afterMessages.push(formattedLine);
				p.afterNeeded--;

				try {
					await this.database.dbRun(
						this.DB_NAME,
						"UPDATE monitoring_occurrences SET after_messages = ? WHERE id = ?",
						[JSON.stringify(p.afterMessages), p.id]
					);

					if (p.afterNeeded <= 0) {
						await this.database.dbRun(
							this.DB_NAME,
							"UPDATE monitoring_occurrences SET completed_at = CURRENT_TIMESTAMP WHERE id = ?",
							[p.id]
						);
						const index = this.pendingOccurrences.indexOf(p);
						if (index !== -1) {
							this.pendingOccurrences.splice(index, 1);
						}
					}
				} catch (err) {
					this.logger.error(`Erro ao atualizar after_messages da ocorrência #${p.id}:`, err);
				}
			}
		}

		// 2. Não dispara ocorrências em comandos de configuração do monitoramento
		const isMonitoringCommand = rawText.trim().startsWith("!g-monitorar");

		// 3. Avalia regras se houver texto
		if (!isMonitoringCommand && rawText.trim().length > 0) {
			const rules = await this.getRules(groupId);
			if (rules.length > 0) {
				const lowerText = rawText.toLowerCase();

				for (const rule of rules) {
					let matched = false;

					if (rule.type === "word") {
						matched = lowerText.includes(rule.pattern.toLowerCase());
					} else if (rule.type === "regex") {
						try {
							const re = buildRegex(rule.pattern);
							if (re && re.test(rawText)) {
								matched = true;
							}
						} catch (reErr) {
							this.logger.error(`Erro ao testar regex de monitoramento "${rule.pattern}":`, reErr);
						}
					}

					if (matched) {
						await this.triggerOccurrence(groupId, rule, message, formattedLine);
						break; // Uma ocorrência por mensagem disparadora
					}
				}
			}
		}

		// 4. Salva no buffer deslizante em memória (últimas 20)
		const buffer = this.getMessageBuffer(groupId);
		buffer.push({ timestamp: Date.now(), line: formattedLine });
		if (buffer.length > 20) {
			buffer.shift();
		}
	}

	async triggerOccurrence(groupId, rule, message, formattedLine) {
		try {
			const buffer = this.getMessageBuffer(groupId);
			// 5 mensagens anteriores do buffer
			const beforeMessages = buffer.slice(-5).map((b) => b.line);

			const rawNumber = (message.author || message.authorNumber || message.from || "")
				.split("@")[0]
				.replace(/\D/g, "");
			const number = rawNumber || "000000";
			const name =
				message.name ||
				message.authorName ||
				message.pushname ||
				message.notifyName ||
				(rawNumber ? `+${rawNumber}` : "Desconhecido");

			const result = await this.database.dbRun(
				this.DB_NAME,
				`INSERT INTO monitoring_occurrences (
					group_id, rule_type, pattern, trigger_message,
					author_name, author_number, before_messages, after_messages, is_read
				) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 0)`,
				[
					groupId,
					rule.type,
					rule.pattern,
					formattedLine,
					name,
					number,
					JSON.stringify(beforeMessages)
				]
			);

			const occId = result?.lastID || Date.now();

			this.pendingOccurrences.push({
				id: occId,
				groupId,
				afterNeeded: 5,
				afterMessages: []
			});

			this.logger.info(
				`[Monitoramento][${groupId}] Ocorrência detectada (#${occId}): [${rule.type}] "${rule.pattern}" por ${name} (${number})`
			);
		} catch (error) {
			this.logger.error(`Erro ao disparar ocorrência no grupo ${groupId}:`, error);
		}
	}

	// ─── CONSULTA E MARCAÇÃO DE OCORRÊNCIAS ────────────────────────────────────────

	async getOccurrences(groupId, options = {}) {
		if (!groupId) return [];
		const unreadOnly = options.unreadOnly !== undefined ? Boolean(options.unreadOnly) : true;
		const limit = parseInt(options.limit, 10) || 50;

		const whereSql = unreadOnly ? "WHERE group_id = ? AND is_read = 0" : "WHERE group_id = ?";

		try {
			const rows = await this.database.dbAll(
				this.DB_NAME,
				`SELECT id, group_id, rule_type, pattern, trigger_message,
				        author_name, author_number, before_messages, after_messages,
				        is_read, created_at, completed_at
				 FROM monitoring_occurrences
				 ${whereSql}
				 ORDER BY id ASC
				 LIMIT ?`,
				[groupId, limit]
			);

			return (rows || []).map((row) => ({
				...row,
				before_messages: this.safeParseJson(row.before_messages, []),
				after_messages: this.safeParseJson(row.after_messages, [])
			}));
		} catch (error) {
			this.logger.error(`Erro ao buscar ocorrências do grupo ${groupId}:`, error);
			return [];
		}
	}

	async markAsRead(groupId, occurrenceIndexOrId) {
		if (!groupId) throw new Error("ID do grupo não informado.");
		const unread = await this.getOccurrences(groupId, { unreadOnly: true, limit: 250 });
		if (unread.length === 0) {
			throw new Error("Não há ocorrências não lidas para marcar.");
		}

		const parsed = parseInt(occurrenceIndexOrId, 10);
		if (isNaN(parsed) || parsed < 1) {
			throw new Error("Informe um número de ocorrência válido.");
		}

		let target = null;
		if (parsed >= 1 && parsed <= unread.length) {
			target = unread[parsed - 1];
		} else {
			target = unread.find((o) => o.id === parsed);
		}

		if (!target) {
			throw new Error(`Ocorrência #${occurrenceIndexOrId} não encontrada ou já marcada como lida.`);
		}

		await this.database.dbRun(
			this.DB_NAME,
			"UPDATE monitoring_occurrences SET is_read = 1 WHERE id = ? AND group_id = ?",
			[target.id, groupId]
		);

		return target;
	}

	async markAllAsRead(groupId) {
		if (!groupId) throw new Error("ID do grupo não informado.");
		const result = await this.database.dbRun(
			this.DB_NAME,
			"UPDATE monitoring_occurrences SET is_read = 1 WHERE group_id = ? AND is_read = 0",
			[groupId]
		);
		return result?.changes || 0;
	}

	safeParseJson(str, fallback) {
		if (!str) return fallback;
		try {
			return JSON.parse(str);
		} catch {
			return fallback;
		}
	}

	// ─── INTEGRAÇÃO COM /MANAGE E PAINEL WEB ───────────────────────────────────────

	async getGroupData(groupId) {
		const rules = await this.getRules(groupId);
		const occurrences = await this.getOccurrences(groupId, { unreadOnly: false, limit: 100 });
		return { rules, occurrences };
	}

	// ─── ROTINA DE LIMPEZA (CLEANER NOTURNO) ───────────────────────────────────────

	getDatabaseFileSize() {
		try {
			const sqlitesDir = path.join(this.database.databasePath, "sqlites");
			const candidateNames = [`${this.DB_NAME}.db`, `${this.DB_NAME}.sqlite`];
			let total = 0;
			for (const base of candidateNames) {
				const dbPath = path.join(sqlitesDir, base);
				const walPath = `${dbPath}-wal`;
				if (fs.existsSync(dbPath)) {
					total += fs.statSync(dbPath).size;
				}
				if (fs.existsSync(walPath)) {
					total += fs.statSync(walPath).size;
				}
			}
			return total;
		} catch {
			return 0;
		}
	}

	async cleanOldOccurrences(maxStorageBytes = this.MAX_STORAGE_BYTES) {
		const currentSize = this.getDatabaseFileSize();
		this.logger.info(
			`[Cleaner] Avaliando tamanho do banco ${this.DB_NAME}: ${(currentSize / 1024 / 1024).toFixed(2)} MB (Limite: ${(maxStorageBytes / 1024 / 1024).toFixed(2)} MB)`
		);

		let prunedCount = 0;

		// Sempre garante que nenhum grupo ultrapassa MAX_OCCURRENCES_PER_GROUP (250) quando no limite de armazenamento
		if (currentSize >= maxStorageBytes) {
			this.logger.warn(
				`Banco ${this.DB_NAME} excedeu o limite de armazenamento. Purgando ocorrências antigas...`
			);

			// Busca contagem de ocorrências por grupo
			const groupCounts = await this.database.dbAll(
				this.DB_NAME,
				"SELECT group_id, COUNT(*) as total FROM monitoring_occurrences GROUP BY group_id"
			);

			for (const row of groupCounts || []) {
				if (row.total > this.MAX_OCCURRENCES_PER_GROUP) {
					const excess = row.total - this.MAX_OCCURRENCES_PER_GROUP;
					const delResult = await this.database.dbRun(
						this.DB_NAME,
						`DELETE FROM monitoring_occurrences 
						 WHERE id IN (
							SELECT id FROM monitoring_occurrences 
							WHERE group_id = ? 
							ORDER BY id ASC 
							LIMIT ?
						 )`,
						[row.group_id, excess]
					);
					prunedCount += delResult?.changes || excess;
				}
			}

			// Checkpoint do WAL e VACUUM para recuperar espaço no disco
			try {
				await this.database.dbRun(this.DB_NAME, "PRAGMA wal_checkpoint(TRUNCATE)");
				await this.database.dbRun(this.DB_NAME, "VACUUM");
				this.logger.info(
					`[Cleaner] VACUUM executado. Novo tamanho: ${(this.getDatabaseFileSize() / 1024 / 1024).toFixed(2)} MB`
				);
			} catch (vacuumErr) {
				this.logger.warn("[Cleaner] Não foi possível executar VACUUM:", vacuumErr.message);
			}
		}

		return { prunedCount, finalSize: this.getDatabaseFileSize() };
	}
}

module.exports = GroupMonitoringService;
