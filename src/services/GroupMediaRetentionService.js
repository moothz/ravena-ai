const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const cron = require("node-cron");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const storageService = require("./StorageService");

/**
 * Adapter fallback utilizando sqlite3 CLI diretamente
 * Garante que scripts e testes no host funcionem mesmo sem compilar addons nativos
 */
class SqliteCliFallback {
	constructor(dataDir) {
		this.dataDir = dataDir || path.resolve(__dirname, "../../data/sqlites");
	}

	_getDbPath(name) {
		return path.join(this.dataDir, `${name}.db`);
	}

	all(name, sql, params = []) {
		const dbPath = this._getDbPath(name);
		let finalSql = sql;
		if (params && params.length > 0) {
			let idx = 0;
			finalSql = sql.replace(/\?/g, () => {
				const val = params[idx++];
				if (val === null || val === undefined) return "NULL";
				if (typeof val === "number") return val;
				return `'${String(val).replace(/'/g, "''")}'`;
			});
		}
		try {
			const res = execFileSync("sqlite3", ["-json", dbPath, finalSql], {
				encoding: "utf8",
				maxBuffer: 50 * 1024 * 1024
			});
			if (!res || !res.trim()) return [];
			return JSON.parse(res);
		} catch {
			return [];
		}
	}

	get(name, sql, params = []) {
		const rows = this.all(name, sql, params);
		return rows.length > 0 ? rows[0] : null;
	}

	run(name, sql, params = []) {
		const dbPath = this._getDbPath(name);
		let finalSql = sql;
		if (params && params.length > 0) {
			let idx = 0;
			finalSql = sql.replace(/\?/g, () => {
				const val = params[idx++];
				if (val === null || val === undefined) return "NULL";
				if (typeof val === "number") return val;
				return `'${String(val).replace(/'/g, "''")}'`;
			});
		}
		try {
			execFileSync("sqlite3", [dbPath, finalSql], { encoding: "utf8" });
			return { changes: 1 };
		} catch (err) {
			return { changes: 0, error: err.message };
		}
	}
}

/**
 * Regex para detectar tokens de mídia em respostas de comandos customizados
 * Exemplos: {video-xyz.mp4}, {image-123.png}, {audio-abc.mp3}, {sticker-01.webp}, {media-xyz.jpg}
 * ou qualquer {arquivo.extensao_de_midia}
 */
const MEDIA_TOKEN_REGEX = /\{[^}]+\.(png|jpg|jpeg|gif|webp|mp4|m4v|mov|mp3|ogg|opus|wav)\}/i;
const MEDIA_PREFIX_REGEX = /\{(video|image|audio|sticker|media)-[^}]+\}/i;

class GroupMediaRetentionService {
	constructor(options = {}) {
		this.logger = new Logger("group-media-retention");
		this.bots = options.bots || [];
		this._database = options.database || null;
		this._storageService = options.storageService || null;

		this.enabled = (process.env.ORPHAN_MEDIA_CLEANUP_ENABLED ?? "true") === "true";
		this.dryRun = (process.env.ORPHAN_MEDIA_CLEANUP_DRY_RUN ?? "false") === "true";
		this.retentionDays = parseInt(process.env.ORPHAN_MEDIA_RETENTION_DAYS, 10) || 30;
		this.cronExpression = process.env.ORPHAN_MEDIA_CLEANUP_CRON || "0 4 * * 0"; // Domingo 04:00 BRT
		this.timeZone = options.timeZone || "America/Sao_Paulo";

		this.stateFilePath =
			options.stateFilePath ||
			path.resolve(__dirname, "..", "..", "data", "orphan-media-cleaner-state.json");

		this.state = this._loadState();
		this.cronJob = null;
		this.isCleaning = false;
	}

	get database() {
		if (!this._database) {
			try {
				this._database = Database.getInstance();
			} catch (err) {
				this.logger.warn("better-sqlite3 não disponível diretamente, usando SqliteCliFallback.");
				this._database = {
					coreRepo: {
						mappers: new SqliteCliFallback()
					}
				};
			}
		}
		return this._database;
	}

	get storageService() {
		if (!this._storageService) {
			this._storageService = storageService;
		}
		return this._storageService;
	}

	static getInstance(options = {}) {
		if (!GroupMediaRetentionService.instance) {
			GroupMediaRetentionService.instance = new GroupMediaRetentionService(options);
		} else if (options.bots && options.bots.length > 0) {
			GroupMediaRetentionService.instance.bots = options.bots;
		}
		return GroupMediaRetentionService.instance;
	}

	start() {
		if (!this.enabled) {
			this.logger.info(
				"GroupMediaRetentionService desativado via ORPHAN_MEDIA_CLEANUP_ENABLED=false"
			);
			return;
		}

		if (this.cronJob) {
			this.logger.warn("GroupMediaRetentionService já está em execução.");
			return;
		}

		this.logger.info(
			`GroupMediaRetentionService agendado (${this.cronExpression}, ${this.timeZone}) - Carência: ${this.retentionDays} dias. DryRun: ${this.dryRun}`
		);

		this.cronJob = cron.schedule(
			this.cronExpression,
			async () => {
				this.logger.info("Executando ciclo agendado de limpeza de mídias de grupos órfãos...");
				try {
					await this.runCleanupCycle();
				} catch (err) {
					this.logger.error("Erro no ciclo agendado de retenção de mídias:", err);
				}
			},
			{
				scheduled: true,
				timezone: this.timeZone
			}
		);
	}

	stop() {
		if (this.cronJob) {
			this.cronJob.stop();
			this.cronJob = null;
			this.logger.info("GroupMediaRetentionService parado.");
		}
	}

	_loadState() {
		try {
			if (fs.existsSync(this.stateFilePath)) {
				const content = fs.readFileSync(this.stateFilePath, "utf8");
				const parsed = JSON.parse(content);
				if (parsed && typeof parsed.orphans === "object") {
					return parsed;
				}
			}
		} catch (error) {
			this.logger.warn(
				"Falha ao ler orphan-media-cleaner-state.json, inicializando novo estado:",
				error.message
			);
		}
		return { lastRunAt: 0, orphans: {} };
	}

	_saveState() {
		try {
			const dir = path.dirname(this.stateFilePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), "utf8");
		} catch (error) {
			this.logger.error("Falha ao salvar orphan-media-cleaner-state.json:", error);
		}
	}

	/**
	 * Coleta todos os Group JIDs atualmente participados por QUALQUER bot WhatsApp
	 * @returns {Promise<Set<string>>}
	 */
	async getActiveWhatsAppGroups() {
		const activeJids = new Set();
		const waBots = this.bots.filter(
			(b) => !b.useTelegram && !b.useDiscord && typeof b.listGroups === "function"
		);

		for (const bot of waBots) {
			try {
				const res = await bot.listGroups();
				const groupsList = Array.isArray(res) ? res : res?.data || [];
				for (const g of groupsList) {
					const jid = g.JID || g.jid || g.id?._serialized || g.id;
					if (jid && typeof jid === "string" && jid.includes("@g.us")) {
						activeJids.add(jid);
					}
				}
			} catch (err) {
				this.logger.warn(
					`Erro ao listar grupos do bot ${bot.id || bot.instanceName}:`,
					err.message || err
				);
			}
		}

		return activeJids;
	}

	/**
	 * Verifica se uma resposta ou texto contém tokens de mídia
	 * @param {string|Array} responses
	 * @returns {boolean}
	 */
	hasMediaResponse(responses) {
		if (!responses) return false;
		const raw = typeof responses === "string" ? responses : JSON.stringify(responses);
		return MEDIA_TOKEN_REGEX.test(raw) || MEDIA_PREFIX_REGEX.test(raw);
	}

	/**
	 * Executa ciclo completo de limpeza de mídias de grupos inativos
	 * @param {object} [options]
	 * @param {boolean} [options.dryRun] - Força dryRun nesta execução
	 * @param {number} [options.retentionDays] - Sobrescreve dias de carência
	 * @returns {Promise<object>} Resumo da execução
	 */
	async runCleanupCycle(options = {}) {
		if (this.isCleaning) {
			this.logger.warn("Ciclo de limpeza já está em andamento. Ignorando solicitação concorrente.");
			return { status: "already_running" };
		}

		this.isCleaning = true;
		const isDryRun = options.dryRun !== undefined ? options.dryRun : this.dryRun;
		const retentionDays =
			options.retentionDays !== undefined ? options.retentionDays : this.retentionDays;
		const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
		const now = Date.now();

		this.logger.info(
			`Iniciando ciclo de retenção de mídias. DryRun: ${isDryRun}, Carência: ${retentionDays} dias.`
		);

		const summary = {
			startedAt: new Date(now).toISOString(),
			dryRun: isDryRun,
			retentionDays,
			totalActiveGroups: 0,
			orphanGroupsFound: 0,
			eligibleForCleanup: 0,
			cleanedGroups: [],
			totalMediaCommandsDeleted: 0,
			totalS3ObjectsDeleted: 0,
			errors: []
		};

		try {
			// 1. Obter grupos ativos atualmente em todos os bots
			const activeJids = await this.getActiveWhatsAppGroups();
			summary.totalActiveGroups = activeJids.size;
			this.logger.info(`Total de grupos ativos nos bots WhatsApp: ${activeJids.size}`);

			// 2. Coletar grupos candidatos que possuem comandos ou configs de mídia
			const candidateGroupIds = await this._getCandidateGroupIds();
			this.logger.info(
				`Total de grupos candidatos encontrados nos bancos: ${candidateGroupIds.size}`
			);

			// 3. Processar cada grupo candidato
			for (const groupId of candidateGroupIds) {
				// Se o grupo está ativo em qualquer bot, limpa da lista de órfãos
				if (activeJids.has(groupId)) {
					if (this.state.orphans[groupId]) {
						delete this.state.orphans[groupId];
					}
					continue;
				}

				summary.orphanGroupsFound++;

				// Determinar há quanto tempo o grupo está abandonado
				const orphanSince = await this._getOrphanSince(groupId, now);
				const elapsedMs = now - orphanSince;
				const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));

				if (elapsedMs < retentionMs) {
					this.logger.debug(
						`[Grupo ${groupId}] Órfão há ${elapsedDays} dias (carência de ${retentionDays} dias ainda não atingida).`
					);
					continue;
				}

				summary.eligibleForCleanup++;
				this.logger.info(
					`[Grupo ${groupId}] Elegível para limpeza de mídia (abandonado há ${elapsedDays} dias). Executando...`
				);

				try {
					const cleanResult = await this.cleanGroupMedia(groupId, isDryRun);
					summary.totalMediaCommandsDeleted += cleanResult.mediaCommandsDeleted;
					summary.totalS3ObjectsDeleted += cleanResult.s3Deleted;
					summary.cleanedGroups.push({
						groupId,
						elapsedDays,
						...cleanResult
					});

					if (!isDryRun) {
						if (!this.state.orphans[groupId]) {
							this.state.orphans[groupId] = { firstSeenOrphanAt: orphanSince };
						}
						this.state.orphans[groupId].cleanedAt = now;
					}
				} catch (cleanErr) {
					this.logger.error(`Erro ao limpar mídias do grupo ${groupId}:`, cleanErr);
					summary.errors.push({ groupId, error: cleanErr.message || String(cleanErr) });
				}
			}

			if (!isDryRun) {
				this.state.lastRunAt = now;
				this._saveState();
			}

			this.logger.info(
				`Ciclo de retenção concluído. Elegíveis: ${summary.eligibleForCleanup}, Comandos removidos: ${summary.totalMediaCommandsDeleted}, Objetos S3: ${summary.totalS3ObjectsDeleted}`
			);
		} finally {
			this.isCleaning = false;
		}

		return summary;
	}

	/**
	 * Determina timestamp desde quando o grupo está abandonado
	 * @private
	 */
	async _getOrphanSince(groupId, now) {
		// 1. Consulta histórico de membership periods no core.db se disponível
		try {
			if (this.database?.coreRepo?.mappers) {
				const row = this.database.coreRepo.mappers.get(
					"core",
					"SELECT max(leave_timestamp) as last_leave, max(join_timestamp) as last_join FROM group_membership_periods WHERE group_jid = ?",
					[groupId]
				);

				if (row && row.last_leave) {
					let leaveMs = Number(row.last_leave);
					// Se gravado em segundos unix (10 dígitos), converte para ms
					if (leaveMs < 10000000000) {
						leaveMs *= 1000;
					}
					return leaveMs;
				}
			}
		} catch (err) {
			this.logger.debug(`Erro consultando group_membership_periods para ${groupId}:`, err.message);
		}

		// 2. Consulta estado persistido local
		if (this.state.orphans[groupId] && this.state.orphans[groupId].firstSeenOrphanAt) {
			return this.state.orphans[groupId].firstSeenOrphanAt;
		}

		// 3. Primeira detecção: registra no estado
		this.state.orphans[groupId] = {
			firstSeenOrphanAt: now,
			firstSeenDate: new Date(now).toISOString()
		};
		return now;
	}

	/**
	 * Coleta IDs de grupos que possuem comandos customizados ou configurações em groups
	 * @private
	 */
	async _getCandidateGroupIds() {
		const candidateIds = new Set();

		// A. custom_commands.db
		try {
			if (this.database?.coreRepo?.mappers) {
				const rows = this.database.coreRepo.mappers.all(
					"custom_commands",
					"SELECT DISTINCT group_id FROM custom_commands WHERE group_id LIKE '%@g.us'"
				);
				for (const r of rows) {
					if (r.group_id) candidateIds.add(r.group_id);
				}
			}
		} catch (err) {
			this.logger.warn("Erro buscando grupos em custom_commands:", err.message);
		}

		// B. core.db groups table
		try {
			if (this.database?.coreRepo?.mappers) {
				const rows = this.database.coreRepo.mappers.all(
					"core",
					"SELECT id FROM groups WHERE id LIKE '%@g.us'"
				);
				for (const r of rows) {
					if (r.id) candidateIds.add(r.id);
				}
			}
		} catch (err) {
			this.logger.warn("Erro buscando grupos em core.db:", err.message);
		}

		return candidateIds;
	}

	/**
	 * Limpa estritamente mídias de um grupo específico (mantendo dados textuais)
	 * @param {string} groupId
	 * @param {boolean} [dryRun=false]
	 * @returns {Promise<{s3Deleted: number, mediaCommandsDeleted: number, groupConfigsCleaned: boolean}>}
	 */
	async cleanGroupMedia(groupId, dryRun = false) {
		let s3Deleted = 0;
		let mediaCommandsDeleted = 0;
		let groupConfigsCleaned = false;

		// 1. Remover mídias do S3 (zap-media)
		if (!dryRun) {
			try {
				s3Deleted = await this.storageService.deleteGroup(groupId, "zap-media");
			} catch (err) {
				this.logger.warn(`[S3] Falha ao deletar prefixo ${groupId}/:`, err.message || err);
			}
		} else {
			this.logger.info(`[DryRun] Deletaria todos os objetos S3 do prefixo zap-media/${groupId}/`);
		}

		// 2. Limpar Comandos Customizados com Mídia em custom_commands.db
		try {
			if (this.database?.coreRepo?.mappers) {
				const commands = this.database.coreRepo.mappers.all(
					"custom_commands",
					"SELECT trigger, responses FROM custom_commands WHERE group_id = ?",
					[groupId]
				);

				for (const cmd of commands) {
					if (this.hasMediaResponse(cmd.responses)) {
						mediaCommandsDeleted++;
						if (!dryRun) {
							this.database.coreRepo.mappers.run(
								"custom_commands",
								"DELETE FROM custom_commands WHERE group_id = ? AND trigger = ?",
								[groupId, cmd.trigger]
							);
							this.logger.debug(
								`[CustomCommand] Comando com mídia removido: ${cmd.trigger} no grupo ${groupId}`
							);
						} else {
							this.logger.info(
								`[DryRun] Removeria comando com mídia '${cmd.trigger}' no grupo ${groupId}`
							);
						}
					}
				}
			}
		} catch (err) {
			this.logger.error(`Erro ao limpar comandos de mídia do grupo ${groupId}:`, err);
		}

		// 3. Limpar anexos de mídia em greetings, farewells e livestream (core.db groups)
		try {
			if (this.database?.coreRepo?.mappers) {
				const row = this.database.coreRepo.mappers.get(
					"core",
					"SELECT id, greetings, farewells, twitch, kick FROM groups WHERE id = ?",
					[groupId]
				);

				if (row) {
					let modified = false;

					// Greetings
					const greetings = this._safeParse(row.greetings);
					if (greetings && typeof greetings === "object") {
						for (const mediaKey of ["image", "video", "audio", "sticker"]) {
							if (greetings[mediaKey]) {
								delete greetings[mediaKey];
								modified = true;
							}
						}
					}

					// Farewells
					const farewells = this._safeParse(row.farewells);
					if (farewells && typeof farewells === "object") {
						for (const mediaKey of ["image", "video", "audio", "sticker"]) {
							if (farewells[mediaKey]) {
								delete farewells[mediaKey];
								modified = true;
							}
						}
					}

					// Twitch channels
					const twitch = this._safeParse(row.twitch);
					if (Array.isArray(twitch)) {
						for (const ch of twitch) {
							if (ch.mediaConfig) {
								delete ch.mediaConfig;
								modified = true;
							}
						}
					}

					// Kick channels
					const kick = this._safeParse(row.kick);
					if (Array.isArray(kick)) {
						for (const ch of kick) {
							if (ch.mediaConfig) {
								delete ch.mediaConfig;
								modified = true;
							}
						}
					}

					if (modified) {
						groupConfigsCleaned = true;
						if (!dryRun) {
							this.database.coreRepo.mappers.run(
								"core",
								"UPDATE groups SET greetings = ?, farewells = ?, twitch = ?, kick = ? WHERE id = ?",
								[
									JSON.stringify(greetings || {}),
									JSON.stringify(farewells || {}),
									JSON.stringify(twitch || []),
									JSON.stringify(kick || []),
									groupId
								]
							);
							this.logger.debug(
								`[Groups] Configurações de mídia limpas no grupo ${groupId} (textos preservados)`
							);
						} else {
							this.logger.info(
								`[DryRun] Limparia anexos de mídia das mensagens de boas-vindas/despedida do grupo ${groupId}`
							);
						}
					}
				}
			}
		} catch (err) {
			this.logger.error(`Erro ao limpar mídias de grupo em core.db para ${groupId}:`, err);
		}

		return {
			s3Deleted,
			mediaCommandsDeleted,
			groupConfigsCleaned
		};
	}

	_safeParse(val) {
		if (!val || typeof val !== "string") return val;
		try {
			return JSON.parse(val);
		} catch {
			return null;
		}
	}
}

module.exports = GroupMediaRetentionService;
