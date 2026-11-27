/**
 * BichoService.js
 *
 * Gerencia persistência (bicho.db), agendamento do sorteio diário (19:00 BRT),
 * corte de apostas (18:45 BRT), liquidação automática e broadcast em grupos inscritos.
 */
"use strict";

const Database = require("../utils/Database");
const Logger = require("../utils/Logger");
const BankService = require("./BankService");
const telemetry = require("../telemetry");
const { BICHO_MULTIPLIERS, BICHO_LIMITS } = require("./economyConstants");
const { parseBetArgs, generateDrawNumbers, evaluateBet } = require("./bichoRules");

const logger = new Logger("bicho-service");
const dbName = "bicho";

class BichoService {
	constructor() {
		this.database = Database.getInstance();
		this.bankService = BankService;
		this.cronTasks = [];
		this._initDatabase();
		this._setupCron();
	}

	static getInstance() {
		if (!BichoService.instance) {
			BichoService.instance = new BichoService();
		}
		return BichoService.instance;
	}

	_initDatabase() {
		this.database.getSQLiteDb(
			dbName,
			`
			CREATE TABLE IF NOT EXISTS bicho_config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER,
				updated_by TEXT
			);

			CREATE TABLE IF NOT EXISTS bicho_draws (
				draw_date TEXT PRIMARY KEY,
				prizes_json TEXT NOT NULL,
				status TEXT DEFAULT 'COMPLETED',
				total_bets INTEGER DEFAULT 0,
				total_amount REAL DEFAULT 0,
				total_payout REAL DEFAULT 0,
				winners_count INTEGER DEFAULT 0,
				created_at INTEGER NOT NULL,
				executed_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS bicho_bets (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				draw_date TEXT NOT NULL,
				user_id TEXT NOT NULL,
				user_name TEXT,
				group_id TEXT,
				modality TEXT NOT NULL,
				scope TEXT NOT NULL,
				pick TEXT NOT NULL,
				amount REAL NOT NULL,
				potential_payout REAL,
				capped INTEGER DEFAULT 0,
				status TEXT DEFAULT 'OPEN',
				payout REAL DEFAULT 0,
				hits INTEGER DEFAULT 0,
				created_at INTEGER NOT NULL,
				settled_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_bicho_bets_user ON bicho_bets(user_id);
			CREATE INDEX IF NOT EXISTS idx_bicho_bets_date_status ON bicho_bets(draw_date, status);

			CREATE TABLE IF NOT EXISTS bicho_subscriptions (
				group_id TEXT PRIMARY KEY,
				preferred_bot_id TEXT,
				enabled INTEGER DEFAULT 1,
				updated_at INTEGER NOT NULL
			);
			`
		);

		// Inicializa configurações padrão se ainda não existirem
		this._seedDefaultConfig();
	}

	_seedDefaultConfig() {
		const defaults = {
			active: "true",
			min_bet: String(BICHO_LIMITS.minBet),
			max_bet: String(BICHO_LIMITS.maxBet),
			max_payout_multiplier: String(BICHO_LIMITS.maxPayoutMultiplier),
			max_bets_per_draw: String(BICHO_LIMITS.maxBetsPerDraw),
			draw_hour: String(BICHO_LIMITS.drawHour),
			draw_minute: String(BICHO_LIMITS.drawMinute),
			cutoff_hour: String(BICHO_LIMITS.cutoffHour),
			cutoff_minute: String(BICHO_LIMITS.cutoffMinute),
			mult_grupo: String(BICHO_MULTIPLIERS.grupo),
			mult_dezena: String(BICHO_MULTIPLIERS.dezena),
			mult_centena: String(BICHO_MULTIPLIERS.centena),
			mult_milhar: String(BICHO_MULTIPLIERS.milhar),
			mult_cercado_divisor: String(BICHO_MULTIPLIERS.cercadoDivisor)
		};

		const now = Date.now();
		for (const [k, v] of Object.entries(defaults)) {
			this.database
				.getSQLiteDb(dbName)
				.run(
					`INSERT OR IGNORE INTO bicho_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system')`,
					[k, v, now]
				);
		}
	}

	/**
	 * Retorna a configuração consolidada como objeto tipado
	 */
	async getConfig() {
		const rows = await this.database.dbAll(dbName, "SELECT key, value FROM bicho_config");
		const map = {};
		for (const r of rows) {
			map[r.key] = r.value;
		}

		return {
			active: map.active !== "false",
			minBet: Number(map.min_bet) || BICHO_LIMITS.minBet,
			maxBet: Number(map.max_bet) || BICHO_LIMITS.maxBet,
			maxPayoutMultiplier: Number(map.max_payout_multiplier) || BICHO_LIMITS.maxPayoutMultiplier,
			maxBetsPerDraw: Number(map.max_bets_per_draw) || BICHO_LIMITS.maxBetsPerDraw,
			drawHour: Number(map.draw_hour) ?? BICHO_LIMITS.drawHour,
			drawMinute: Number(map.draw_minute) ?? BICHO_LIMITS.drawMinute,
			cutoffHour: Number(map.cutoff_hour) ?? BICHO_LIMITS.cutoffHour,
			cutoffMinute: Number(map.cutoff_minute) ?? BICHO_LIMITS.cutoffMinute,
			multipliers: {
				grupo: Number(map.mult_grupo) || BICHO_MULTIPLIERS.grupo,
				dezena: Number(map.mult_dezena) || BICHO_MULTIPLIERS.dezena,
				centena: Number(map.mult_centena) || BICHO_MULTIPLIERS.centena,
				milhar: Number(map.mult_milhar) || BICHO_MULTIPLIERS.milhar,
				cercadoDivisor: Number(map.mult_cercado_divisor) || BICHO_MULTIPLIERS.cercadoDivisor
			}
		};
	}

	/**
	 * Atualiza configurações a partir do /admin
	 */
	async updateConfig(patch = {}, updatedBy = "admin") {
		const current = await this.getConfig();
		const next = { ...current, ...patch };

		// Validações
		if (next.minBet <= 0 || next.maxBet < next.minBet) {
			throw new Error("A aposta mínima deve ser positiva e menor ou igual à aposta máxima.");
		}
		if (next.drawHour < 0 || next.drawHour > 23 || next.drawMinute < 0 || next.drawMinute > 59) {
			throw new Error("Horário do sorteio inválido.");
		}
		if (
			next.cutoffHour < 0 ||
			next.cutoffHour > 23 ||
			next.cutoffMinute < 0 ||
			next.cutoffMinute > 59
		) {
			throw new Error("Horário de corte das apostas inválido.");
		}

		const entries = [
			["active", String(next.active !== false)],
			["min_bet", String(next.minBet)],
			["max_bet", String(next.maxBet)],
			["max_payout_multiplier", String(next.maxPayoutMultiplier)],
			["max_bets_per_draw", String(next.maxBetsPerDraw)],
			["draw_hour", String(next.drawHour)],
			["draw_minute", String(next.drawMinute)],
			["cutoff_hour", String(next.cutoffHour)],
			["cutoff_minute", String(next.cutoffMinute)],
			["mult_grupo", String(next.multipliers?.grupo || current.multipliers.grupo)],
			["mult_dezena", String(next.multipliers?.dezena || current.multipliers.dezena)],
			["mult_centena", String(next.multipliers?.centena || current.multipliers.centena)],
			["mult_milhar", String(next.multipliers?.milhar || current.multipliers.milhar)],
			[
				"mult_cercado_divisor",
				String(next.multipliers?.cercadoDivisor || current.multipliers.cercadoDivisor)
			]
		];

		const now = Date.now();
		for (const [k, v] of entries) {
			await this.database.dbRun(
				dbName,
				`INSERT INTO bicho_config (key, value, updated_at, updated_by)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
				[k, v, now, updatedBy]
			);
		}

		// Reconfigura o cron se o horário do sorteio mudou
		this._setupCron();

		return await this.getConfig();
	}

	/**
	 * Retorna a data (YYYY-MM-DD) do fuso de Brasília para um Date
	 */
	getBrtDateParts(date = new Date()) {
		const formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: "America/Sao_Paulo",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false
		});

		const parts = formatter.formatToParts(date);
		const get = (type) => parts.find((p) => p.type === type)?.value;
		const y = get("year");
		const m = get("month");
		const d = get("day");
		const hour = Number(get("hour"));
		const minute = Number(get("minute"));

		return {
			dateStr: `${y}-${m}-${d}`,
			hour,
			minute
		};
	}

	/**
	 * Calcula para qual extração (draw_date) a aposta atual deve ser direcionada
	 * Se já passou do horário de corte de hoje, vai para o dia seguinte
	 */
	calculateTargetDrawDate(config, now = new Date()) {
		const { dateStr, hour, minute } = this.getBrtDateParts(now);
		const currentMinutes = hour * 60 + minute;
		const cutoffMinutes = config.cutoffHour * 60 + config.cutoffMinute;

		if (currentMinutes < cutoffMinutes) {
			return { drawDate: dateStr, isToday: true };
		}

		// Amanhã em BRT
		const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
		const tomorrowParts = this.getBrtDateParts(tomorrow);
		return { drawDate: tomorrowParts.dateStr, isToday: false };
	}

	/**
	 * Registra uma nova aposta do usuário
	 */
	async placeBet({ userId, userName, groupId, rawArgs }) {
		return await telemetry.withSpan(
			"bicho bet.place",
			{
				"ravena.user.id": telemetry.userIdAttr(userId),
				"ravena.chat.id": telemetry.chatIdAttr(groupId)
			},
			async (span) => {
				const config = await this.getConfig();

				if (!config.active) {
					telemetry.setAttrs({ "app.outcome": "rejected", "app.reject.reason": "bicho_disabled" });
					return {
						success: false,
						error: "O Jogo do Bicho está temporariamente desativado pela moderação."
					};
				}

				const parsed = parseBetArgs(rawArgs);
				if (parsed.error) {
					telemetry.setAttrs({ "app.outcome": "rejected", "app.reject.reason": "invalid_args" });
					return { success: false, error: parsed.error };
				}

				const { modality, pick, amount, scope } = parsed;

				if (amount < config.minBet) {
					telemetry.setAttrs({ "app.outcome": "rejected", "app.reject.reason": "bet_below_min" });
					return {
						success: false,
						error: `A aposta mínima é de ${config.minBet.toLocaleString("pt-BR")} ᚱ. Você apostou ${amount.toLocaleString("pt-BR")} ᚱ.`
					};
				}

				if (amount > config.maxBet) {
					telemetry.setAttrs({ "app.outcome": "rejected", "app.reject.reason": "bet_above_max" });
					return {
						success: false,
						error: `A aposta máxima permitida por bilhete é de ${config.maxBet.toLocaleString("pt-BR")} ᚱ.`
					};
				}

				const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
				const { drawDate, isToday } = this.calculateTargetDrawDate(config);

				// Verifica limite de apostas por usuário nesta extração
				const userBetsCountRow = await this.database.dbGet(
					dbName,
					"SELECT COUNT(*) as count FROM bicho_bets WHERE user_id = ? AND draw_date = ?",
					[cleanUser, drawDate]
				);
				const userBetsCount = userBetsCountRow?.count || 0;
				if (userBetsCount >= config.maxBetsPerDraw) {
					telemetry.setAttrs({
						"app.outcome": "rejected",
						"app.reject.reason": "max_bets_exceeded"
					});
					return {
						success: false,
						error: `Você já atingiu o limite de ${config.maxBetsPerDraw} apostas para a extração de ${drawDate}.`
					};
				}

				// Calcula teto e prêmio potencial máximo
				const maxPayout = config.maxBet * config.maxPayoutMultiplier;
				const mult = config.multipliers[modality] || 0;
				const unitMultiplier =
					scope === "cercado" ? mult / config.multipliers.cercadoDivisor : mult;
				const potentialRaw = amount * unitMultiplier * (scope === "cercado" ? 5 : 1);
				const capped = potentialRaw > maxPayout;
				const potentialPayout = capped ? maxPayout : Math.round(potentialRaw);

				// Debita as Runas atomicamente via CAS
				try {
					await this.bankService.debitRunas(cleanUser, amount, {
						type: "BICHO_BET",
						source: "bicho",
						details: { modality, pick, scope, drawDate, amount }
					});
				} catch (err) {
					telemetry.setAttrs({
						"app.outcome": "rejected",
						"app.reject.reason": "insufficient_balance"
					});
					return { success: false, error: err.message };
				}

				// Grava a aposta no banco
				const now = Date.now();
				let betId = null;
				try {
					const insertRes = await this.database.dbRun(
						dbName,
						`INSERT INTO bicho_bets (draw_date, user_id, user_name, group_id, modality, scope, pick, amount, potential_payout, capped, status, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
						[
							drawDate,
							cleanUser,
							userName || "Apostador",
							groupId || "",
							modality,
							scope,
							pick,
							amount,
							potentialPayout,
							capped ? 1 : 0,
							now
						]
					);
					betId = insertRes?.lastID;
				} catch (dbErr) {
					// Estorno de segurança se a inserção falhar
					logger.error("Erro ao inserir aposta no bicho.db, estornando:", dbErr);
					await this.bankService.creditRunas(cleanUser, amount, {
						recordTransaction: true,
						source: "bicho_refund",
						details: { reason: "db_insert_error", error: dbErr.message }
					});
					telemetry.recordError(span, dbErr);
					return {
						success: false,
						error: "Ocorreu um erro interno ao registrar sua aposta. O valor foi estornado."
					};
				}

				telemetry.setAttrs({
					"ravena.bicho.bet_id": betId,
					"ravena.bicho.modality": modality,
					"ravena.bicho.scope": scope,
					"ravena.bicho.amount": amount,
					"ravena.bicho.draw_date": drawDate
				});

				return {
					success: true,
					betId,
					drawDate,
					isToday,
					modality,
					scope,
					pick,
					amount,
					potentialPayout,
					capped,
					cutoffHour: config.cutoffHour,
					cutoffMinute: config.cutoffMinute
				};
			}
		);
	}

	/**
	 * Executa a extração (sorteio) para uma determinada data.
	 * Idempotente: se a data já foi sorteada, retorna o sorteio existente.
	 */
	async runDraw(targetDateStr = null) {
		return await telemetry.withSpan("bicho draw.run", {}, async (span) => {
			const config = await this.getConfig();
			const now = new Date();
			const dateStr = targetDateStr || this.getBrtDateParts(now).dateStr;

			// Verifica se já existe sorteio para a data
			const existing = await this.database.dbGet(
				dbName,
				"SELECT * FROM bicho_draws WHERE draw_date = ?",
				[dateStr]
			);
			if (existing) {
				return {
					alreadyRun: true,
					drawDate: existing.draw_date,
					prizes: JSON.parse(existing.prizes_json),
					totalBets: existing.total_bets,
					totalAmount: existing.total_amount,
					totalPayout: existing.total_payout,
					winnersCount: existing.winners_count
				};
			}

			// Gera os 5 prêmios oficiais
			const prizes = generateDrawNumbers();
			const maxPayout = config.maxBet * config.maxPayoutMultiplier;

			// Busca todas as apostas abertas daquela data
			const bets = await this.database.dbAll(
				dbName,
				"SELECT * FROM bicho_bets WHERE draw_date = ? AND status = 'OPEN'",
				[dateStr]
			);

			const totalBets = bets.length;
			let totalAmount = 0;
			let totalPayout = 0;
			let winnersCount = 0;
			const settledAt = Date.now();

			for (const b of bets) {
				totalAmount += b.amount;
				const evalResult = evaluateBet(
					{
						modality: b.modality,
						pick: b.pick,
						amount: b.amount,
						scope: b.scope
					},
					prizes,
					{ multipliers: config.multipliers, maxPayout }
				);

				const payout = evalResult.won ? evalResult.payout : 0;
				const hits = evalResult.hits || 0;
				const status = evalResult.won ? "WON" : "LOST";

				if (evalResult.won) {
					winnersCount++;
					totalPayout += payout;

					// Credita prêmio na conta bancária do ganhador
					try {
						await this.bankService.creditRunas(b.user_id, payout, {
							recordTransaction: true,
							source: "bicho_prize",
							details: {
								betId: b.id,
								drawDate: dateStr,
								modality: b.modality,
								scope: b.scope,
								pick: b.pick,
								hits,
								payout
							}
						});
					} catch (creditErr) {
						logger.error(`Erro ao creditar prêmio do bicho para ${b.user_id}:`, creditErr);
					}
				}

				// Atualiza aposta no banco
				await this.database.dbRun(
					dbName,
					`UPDATE bicho_bets SET status = ?, payout = ?, hits = ?, settled_at = ? WHERE id = ?`,
					[status, payout, hits, settledAt, b.id]
				);
			}

			// Registra o sorteio consolidado
			await this.database.dbRun(
				dbName,
				`INSERT INTO bicho_draws (draw_date, prizes_json, status, total_bets, total_amount, total_payout, winners_count, created_at, executed_at)
				 VALUES (?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?)`,
				[
					dateStr,
					JSON.stringify(prizes),
					totalBets,
					totalAmount,
					totalPayout,
					winnersCount,
					settledAt,
					settledAt
				]
			);

			logger.info(
				`[BichoService] Extração ${dateStr} finalizada: ${totalBets} apostas, ${totalAmount} ᚱ apostados, ${winnersCount} ganhadores, ${totalPayout} ᚱ pagos.`
			);

			telemetry.setAttrs({
				"ravena.bicho.draw_date": dateStr,
				"ravena.bicho.total_bets": totalBets,
				"ravena.bicho.total_amount": totalAmount,
				"ravena.bicho.total_payout": totalPayout,
				"ravena.bicho.winners_count": winnersCount
			});

			const drawResult = {
				alreadyRun: false,
				drawDate: dateStr,
				prizes,
				totalBets,
				totalAmount,
				totalPayout,
				winnersCount
			};

			// Broadcast do resultado para grupos inscritos
			this.broadcastDrawResult(drawResult).catch((err) => {
				logger.error("[BichoService] Erro ao enviar avisos de resultado:", err);
			});

			return drawResult;
		});
	}

	/**
	 * Envia resultado da extração apenas para grupos inscritos (nunca PV)
	 */
	async broadcastDrawResult(drawResult) {
		return await telemetry.withSpan("bicho draw.broadcast", {}, async () => {
			const subs = await this.database.dbAll(
				dbName,
				"SELECT group_id, preferred_bot_id FROM bicho_subscriptions WHERE enabled = 1"
			);
			if (!subs || subs.length === 0) return { sent: 0 };

			const allBots = this.database.botInstances || [];
			if (allBots.length === 0) return { sent: 0 };

			const text = this.formatDrawResultText(drawResult);
			let sent = 0;

			for (const sub of subs) {
				const groupId = sub.group_id;
				// Padrão de segurança: nunca enviar no privado
				if (!groupId.includes("@g.us") && !groupId.startsWith("-") && groupId.length < 17) {
					continue;
				}

				const isWhatsApp = groupId.includes("@g.us");
				const isTelegram = groupId.startsWith("-");
				const isDiscord = !isWhatsApp && !isTelegram;

				const candidate = allBots.find((b) => {
					if (b.isConnected === false) return false;
					if (b.useTelegram && !isTelegram) return false;
					if (b.useDiscord && !isDiscord) return false;
					if (!b.useTelegram && !b.useDiscord && !isWhatsApp) return false;
					if (typeof b.isParticipating === "function" && !b.isParticipating(groupId)) return false;
					return true;
				});

				if (candidate && typeof candidate.sendMessage === "function") {
					try {
						await candidate.sendMessage(groupId, text);
						sent++;
					} catch (sendErr) {
						logger.warn(`[BichoService] Falha ao enviar para ${groupId}:`, sendErr.message);
					}
				}
			}

			return { sent };
		});
	}

	/**
	 * Formata o texto oficial do resultado do sorteio
	 */
	formatDrawResultText(drawResult) {
		const { drawDate, prizes, totalBets, totalPayout, winnersCount } = drawResult;
		let msg = `🎲 *RESULTADO DO JOGO DO BICHO* 🎲\n`;
		msg += `📅 Extração: *${drawDate}*\n\n`;

		for (const p of prizes) {
			const pos = p.prize === 1 ? "1º (Cabeça)" : `${p.prize}º Prêmio`;
			msg += `*${pos}:* ${p.number} — Gr. ${String(p.group).padStart(2, "0")} ${p.animalEmoji} *${p.animalName}*\n`;
		}

		msg += `\n📊 *Resumo da Rodada:*\n`;
		msg += `• Bilhetes jogados: ${totalBets}\n`;
		msg += `• Ganhadores: ${winnersCount}\n`;
		msg += `• Total pago: ${totalPayout.toLocaleString("pt-BR")} ᚱ\n`;
		msg += `\nPara apostar na próxima extração: \`!bicho <palpite> <valor>\``;

		return msg;
	}

	/**
	 * Retorna o último sorteio executado
	 */
	async getLastDraw() {
		const row = await this.database.dbGet(
			dbName,
			"SELECT * FROM bicho_draws ORDER BY executed_at DESC LIMIT 1"
		);
		if (!row) return null;
		return {
			...row,
			drawDate: row.draw_date,
			totalBets: row.total_bets,
			totalAmount: row.total_amount,
			totalPayout: row.total_payout,
			winnersCount: row.winners_count,
			prizes: JSON.parse(row.prizes_json)
		};
	}

	/**
	 * Retorna as apostas do usuário (abertas e histórico recente)
	 */
	async getUserBets(userId, limit = 10) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		return await this.database.dbAll(
			dbName,
			"SELECT * FROM bicho_bets WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
			[cleanUser, limit]
		);
	}

	/**
	 * Ativa/desativa notificações de sorteio para o grupo
	 */
	async setGroupSubscription(groupId, enabled, preferredBotId = null) {
		const now = Date.now();
		await this.database.dbRun(
			dbName,
			`INSERT INTO bicho_subscriptions (group_id, preferred_bot_id, enabled, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(group_id) DO UPDATE SET enabled = excluded.enabled, preferred_bot_id = excluded.preferred_bot_id, updated_at = excluded.updated_at`,
			[groupId, preferredBotId, enabled ? 1 : 0, now]
		);
		return { groupId, enabled: Boolean(enabled) };
	}

	/**
	 * Configura o cron de extração diária
	 */
	async _setupCron() {
		// Encerra tarefas anteriores
		for (const t of this.cronTasks) {
			if (t && typeof t.stop === "function") {
				t.stop();
			}
		}
		this.cronTasks = [];

		if (
			process.env.NODE_ENV === "test" ||
			process.env.DISABLE_ACTIVITY === "true" ||
			process.env.DISABLE_BICHO_TIMER === "true"
		) {
			return;
		}

		try {
			const cron = require("node-cron");
			const config = await this.getConfig();
			const tz = "America/Sao_Paulo";
			// Agendamento diário: minute hour * * *
			const cronExpr = `${config.drawMinute} ${config.drawHour} * * *`;

			const task = cron.schedule(
				cronExpr,
				async () => {
					try {
						logger.info("[BichoService] Disparando extração diária agendada...");
						await this.runDraw();
					} catch (err) {
						logger.error("[BichoService] Erro na execução da extração agendada:", err);
					}
				},
				{ timezone: tz }
			);

			this.cronTasks.push(task);
			logger.info(`[BichoService] Agendador de sorteio ativo: ${cronExpr} (${tz}).`);
		} catch (err) {
			logger.error("[BichoService] Erro ao agendar cron do bicho:", err);
		}
	}
}

module.exports = BichoService;
