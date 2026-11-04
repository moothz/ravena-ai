/**
 * BankService.js
 *
 * Núcleo do sistema de economia e câmbio "RavenaBank".
 * Gerencia a moeda global Runas, cotações diárias, spread dinâmico progressivo,
 * cotas diárias de câmbio, venda aproximada de peixes (knapsack) e sessões web deslizantes.
 */

const crypto = require("crypto");
const axios = require("axios");
const cron = require("node-cron");
const Database = require("../utils/Database");
const Logger = require("../utils/Logger");
const ShadowGardenClient = require("./ShadowGardenClient");

const logger = new Logger("bank-service");
const database = Database.getInstance();
const dbName = "bank";
const jardimClient = new ShadowGardenClient();

// Configurações da API do Waifuletes
const WAIFULETES_URL = (
	process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030"
).replace(/\/+$/, "");
const WAIFULETES_KEY = process.env.WAIFULETES_API_KEY;

const waifuApi = axios.create({
	baseURL: WAIFULETES_URL,
	headers: {
		Authorization: `Bearer ${WAIFULETES_KEY || ""}`,
		"Content-Type": "application/json"
	},
	timeout: 8000
});

// Constantes econômicas base (1.000 Runas = 800 kg = 3.500 Z = 8.000 MJ)
const BASE_RUNAS_PER_KG_FISH = 1000 / 800; // 1.25 Runas / kg
const BASE_RUNAS_PER_ZINTHOS = 1000 / 3500; // ~0.2857 Runas / Zinthos
const BASE_RUNAS_PER_JARDIM = 1000 / 8000; // 0.125 Runas / Moeda Jardim

// Cotas diárias ampliadas (3x) e limite de compra em Runas
const DAILY_LIMITS = {
	pesca: 1500, // 1.500 kg/dia (venda de peixes)
	zinthos: 9000, // 9.000 Zinthos/dia (venda de Zinthos)
	jardim: 30000, // 30.000 Petalitas/dia (venda de Petalitas)
	compra: 3000 // 3.000 ᚱ/dia (limite diário de compra de outras moedas com Runas)
};

// Duração da sessão web (3 dias em milissegundos)
const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;

class BankService {
	constructor() {
		this._initialized = false;
		this._initDatabase();
		this._setupCron();
	}

	_initDatabase() {
		try {
			database.getSQLiteDb(
				dbName,
				`
				CREATE TABLE IF NOT EXISTS bank_accounts (
					user_id TEXT PRIMARY KEY,
					runas REAL DEFAULT 0,
					total_deposited_runas REAL DEFAULT 0,
					total_withdrawn_runas REAL DEFAULT 0,
					created_at INTEGER,
					updated_at INTEGER
				);

				CREATE TABLE IF NOT EXISTS bank_daily_rates (
					date TEXT PRIMARY KEY,
					runas_per_kg_fish REAL NOT NULL,
					runas_per_zinthos REAL NOT NULL,
					runas_per_jardim_coin REAL NOT NULL,
					fish_multiplier REAL DEFAULT 1.0,
					waifu_multiplier REAL DEFAULT 1.0,
					jardim_multiplier REAL DEFAULT 1.0,
					updated_at INTEGER
				);

				CREATE TABLE IF NOT EXISTS bank_sessions (
					token TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					last_accessed_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_bank_sessions_user ON bank_sessions(user_id);
				CREATE INDEX IF NOT EXISTS idx_bank_sessions_exp ON bank_sessions(expires_at);

				CREATE TABLE IF NOT EXISTS bank_transactions (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					user_id TEXT NOT NULL,
					type TEXT NOT NULL,
					game TEXT NOT NULL,
					game_amount REAL NOT NULL,
					runas_amount REAL NOT NULL,
					spread_rate REAL NOT NULL,
					spread_fee_runas REAL NOT NULL,
					details_json TEXT,
					timestamp INTEGER NOT NULL
				);

				CREATE TABLE IF NOT EXISTS bank_daily_quotas (
					user_id TEXT NOT NULL,
					date TEXT NOT NULL,
					fish_kg_used REAL DEFAULT 0,
					zinthos_used REAL DEFAULT 0,
					jardim_coins_used REAL DEFAULT 0,
					runas_compra_used REAL DEFAULT 0,
					PRIMARY KEY (user_id, date)
				);
				`
			);
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_daily_quotas ADD COLUMN runas_compra_used REAL DEFAULT 0;");
			} catch (_) {}
			this._initialized = true;
			logger.info("Banco bank.db inicializado com sucesso.");
		} catch (err) {
			logger.error(`Erro ao inicializar tabelas do RavenaBank: ${err.message}`);
		}
	}

	_setupCron() {
		// Rotação diária de cotações às 04:00 AM (Horário de Brasília)
		cron.schedule("0 4 * * *", async () => {
			logger.info(
				"[RavenaBank] Executando rotação diária de cotações e renovação de cotas (04:00 AM)..."
			);
			try {
				await this.calculateDailyRates(true);
				logger.info(
					"[RavenaBank] Cotações rotacionadas e novas cotas diárias liberadas com sucesso."
				);
			} catch (err) {
				logger.error(`[RavenaBank] Falha na rotação diária de cotações: ${err.message}`);
			}
		});

		// Limpeza horária de sessões expiradas
		cron.schedule("0 * * * *", async () => {
			try {
				const now = Date.now();
				await database.dbRun(dbName, "DELETE FROM bank_sessions WHERE expires_at < ?", [now]);
			} catch (err) {
				logger.debug(`[RavenaBank] Erro na limpeza de sessões: ${err.message}`);
			}
		});
	}

	getTodayDateString(date = new Date()) {
		// O ciclo bancário vira diariamente às 04:00 AM (Horário de Brasília, UTC-3).
		// Entre 00:00 e 03:59:59 BRT, pertence ao ciclo diário iniciado no dia anterior às 04:00.
		// UTC-3 menos 4 horas = UTC-7.
		const bankingTime = new Date(date.getTime() - 7 * 3600 * 1000);
		return bankingTime.toISOString().split("T")[0];
	}

	/**
	 * Obtém a cotação oficial do dia (recalcula e persiste se ainda não existir)
	 */
	async getRates(forceRefresh = false) {
		const today = this.getTodayDateString();
		if (!forceRefresh) {
			const existing = await database.dbGet(
				dbName,
				"SELECT * FROM bank_daily_rates WHERE date = ?",
				[today]
			);
			if (existing) {
				return {
					date: existing.date,
					runasPerKgFish: existing.runas_per_kg_fish,
					runasPerZinthos: existing.runas_per_zinthos,
					runasPerJardimCoin: existing.runas_per_jardim_coin,
					fishMultiplier: existing.fish_multiplier,
					waifuMultiplier: existing.waifu_multiplier,
					jardimMultiplier: existing.jardim_multiplier,
					updatedAt: existing.updated_at
				};
			}
		}

		return await this.calculateDailyRates(forceRefresh);
	}

	/**
	 * Calcula e persiste as cotações dinâmicas para o dia de hoje
	 */
	async calculateDailyRates(force = false) {
		const today = this.getTodayDateString();

		// Cotação do dia anterior para aplicação de circuit breaker (+-10%)
		const prev = await database.dbGet(
			dbName,
			"SELECT * FROM bank_daily_rates ORDER BY date DESC LIMIT 1"
		);

		let waifuMult = 1.0;
		let fishMult = 1.0;
		let jardimMult = 1.0;

		// 1. Fator Waifus via inflação IM
		try {
			const { data } = await waifuApi.get("/market/stats");
			const inflationMult = data?.data?.inflationMultiplier || 1.0;
			// Se há mais inflação de Zinthos, Zinthos compra menos Runas
			waifuMult = Number((1.0 / Math.max(1.0, inflationMult)).toFixed(4));
		} catch (err) {
			logger.warn(`[BankService] Falha ao consultar /market/stats do Waifuletes: ${err.message}`);
			waifuMult = prev ? prev.waifu_multiplier : 1.0;
		}

		// 2. Fator Pesca via volume recente em fishing_users
		try {
			const row = await database.dbGet(
				"fishing",
				"SELECT SUM(weight) as totalFishWeight FROM fishing_inventory WHERE is_rare = 0 OR is_rare IS NULL"
			);
			const totalCommonWeight = row?.totalFishWeight || 5148753;
			// Normalização sutil baseada na variação de peso comum circulante
			const baselineWeight = 5148753;
			const ratio = totalCommonWeight / baselineWeight;
			fishMult = Number(Math.pow(1.0 / Math.max(0.5, ratio), 0.2).toFixed(4));
		} catch (err) {
			logger.warn(`[BankService] Falha ao estimar pressão de pesca: ${err.message}`);
			fishMult = prev ? prev.fish_multiplier : 1.0;
		}

		// 3. Fator Jardim via snapshots da fazenda
		try {
			const snapRow = await database.dbGet(
				"fazenda",
				"SELECT SUM(coins) as totalCoins FROM fazenda_player_snapshots WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM fazenda_player_snapshots)"
			);
			const totalJardimCoins = snapRow?.totalCoins || 17938824;
			const baselineCoins = 17938824;
			const ratio = totalJardimCoins / baselineCoins;
			jardimMult = Number(Math.pow(1.0 / Math.max(0.5, ratio), 0.2).toFixed(4));
		} catch (err) {
			logger.warn(`[BankService] Falha ao estimar pressão da fazenda: ${err.message}`);
			jardimMult = prev ? prev.jardim_multiplier : 1.0;
		}

		// Trava de segurança (Circuit breaker: máximo +-10% por rotação diária)
		const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
		if (prev) {
			waifuMult = clamp(waifuMult, prev.waifu_multiplier * 0.9, prev.waifu_multiplier * 1.1);
			fishMult = clamp(fishMult, prev.fish_multiplier * 0.9, prev.fish_multiplier * 1.1);
			jardimMult = clamp(jardimMult, prev.jardim_multiplier * 0.9, prev.jardim_multiplier * 1.1);
		}

		const runasPerKgFish = Number((BASE_RUNAS_PER_KG_FISH * fishMult).toFixed(4));
		const runasPerZinthos = Number((BASE_RUNAS_PER_ZINTHOS * waifuMult).toFixed(4));
		const runasPerJardimCoin = Number((BASE_RUNAS_PER_JARDIM * jardimMult).toFixed(4));
		const now = Date.now();

		await database.dbRun(
			dbName,
			`INSERT OR REPLACE INTO bank_daily_rates 
			(date, runas_per_kg_fish, runas_per_zinthos, runas_per_jardim_coin, fish_multiplier, waifu_multiplier, jardim_multiplier, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				today,
				runasPerKgFish,
				runasPerZinthos,
				runasPerJardimCoin,
				fishMult,
				waifuMult,
				jardimMult,
				now
			]
		);

		logger.info(
			`[RavenaBank] Cotações atualizadas para ${today}: 1kg=${runasPerKgFish}R, 1Z=${runasPerZinthos}R, 1MJ=${runasPerJardimCoin}R`
		);

		return {
			date: today,
			runasPerKgFish,
			runasPerZinthos,
			runasPerJardimCoin,
			fishMultiplier: fishMult,
			waifuMultiplier: waifuMult,
			jardimMultiplier: jardimMult,
			updatedAt: now
		};
	}

	/**
	 * Obtém ou inicializa a conta bancária do usuário
	 */
	async getAccount(userId) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		let row = await database.dbGet(
			dbName,
			"SELECT * FROM bank_accounts WHERE user_id = ? OR user_id = ?",
			[userId, cleanUser]
		);

		if (!row) {
			const now = Date.now();
			await database.dbRun(
				dbName,
				`INSERT INTO bank_accounts (user_id, runas, total_deposited_runas, total_withdrawn_runas, created_at, updated_at)
				VALUES (?, 0, 0, 0, ?, ?)`,
				[cleanUser, now, now]
			);
			row = {
				user_id: cleanUser,
				runas: 0,
				total_deposited_runas: 0,
				total_withdrawn_runas: 0,
				created_at: now,
				updated_at: now
			};
		}

		return row;
	}

	/**
	 * Credita Runas diretamente na conta bancária de um usuário (bônus de doação, prêmios de slots, etc.)
	 * @param {string} userId
	 * @param {number} amount
	 * @param {Object} options
	 * @returns {Promise<Object>} Conta atualizada
	 */
	async creditRunas(userId, amount, options = {}) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		amount = Math.max(0, Number(amount) || 0);
		if (amount <= 0) return await this.getAccount(cleanUser);

		const now = Date.now();
		await database.dbRun(
			dbName,
			`INSERT INTO bank_accounts (user_id, runas, total_deposited_runas, total_withdrawn_runas, created_at, updated_at)
			VALUES (?, ?, ?, 0, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET 
				runas = runas + excluded.runas,
				total_deposited_runas = total_deposited_runas + excluded.runas,
				updated_at = excluded.updated_at`,
			[cleanUser, amount, amount, now, now]
		);

		if (options.recordTransaction) {
			await database.dbRun(
				dbName,
				`INSERT INTO bank_transactions (user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp)
				VALUES (?, 'BONUS', ?, ?, ?, 0, 0, ?, ?)`,
				[
					cleanUser,
					options.source || "bonus",
					0,
					amount,
					JSON.stringify(options.details || {}),
					now
				]
			);
		}

		return await this.getAccount(cleanUser);
	}

	/**
	 * Consulta as cotas diárias de câmbio usadas e restantes
	 */
	async getDailyQuota(userId) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const today = this.getTodayDateString();

		const row = await database.dbGet(
			dbName,
			"SELECT * FROM bank_daily_quotas WHERE (user_id = ? OR user_id = ?) AND date = ?",
			[userId, cleanUser, today]
		);

		const fishUsed = Number(row?.fish_kg_used || 0);
		const zinthosUsed = Number(row?.zinthos_used || 0);
		const jardimUsed = Number(row?.jardim_coins_used || 0);
		const compraUsed = Number(row?.runas_compra_used || 0);

		return {
			date: today,
			limits: DAILY_LIMITS,
			used: {
				pesca: fishUsed,
				zinthos: zinthosUsed,
				jardim: jardimUsed,
				compra: compraUsed
			},
			remaining: {
				pesca: Math.max(0, DAILY_LIMITS.pesca - fishUsed),
				zinthos: Math.max(0, DAILY_LIMITS.zinthos - zinthosUsed),
				jardim: Math.max(0, DAILY_LIMITS.jardim - jardimUsed),
				compra: Math.max(0, DAILY_LIMITS.compra - compraUsed)
			}
		};
	}

	/**
	 * Calcula o spread dinâmico progressivo (3% a 10%) baseado na proporção de uso da cota diária
	 * Formula: Spread = 0.03 + 0.07 * (usadoHoje / cotaDiaria)^1.5
	 */
	calculateSpread(currentUsed, additionalAmount, dailyLimit) {
		const totalAfter = currentUsed + additionalAmount;
		const ratio = Math.min(1.0, Math.max(0, totalAfter / dailyLimit));
		const spread = 0.03 + 0.07 * Math.pow(ratio, 1.5);
		return Number(Math.min(0.1, Math.max(0.03, spread)).toFixed(4));
	}

	/**
	 * Cria ou renova sessão web para !banco-adm com validade deslizante de 3 dias
	 */
	async createSession(userId) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const token = crypto.randomBytes(24).toString("hex");
		const now = Date.now();
		const expiresAt = now + SESSION_TTL_MS;

		await database.dbRun(
			dbName,
			`INSERT INTO bank_sessions (token, user_id, created_at, last_accessed_at, expires_at)
			VALUES (?, ?, ?, ?, ?)`,
			[token, cleanUser, now, now, expiresAt]
		);

		return { token, expiresAt };
	}

	/**
	 * Valida e renova (sliding session) a sessão por mais 3 dias a partir deste acesso
	 */
	async verifyAndExtendSession(token) {
		if (!token || typeof token !== "string") return null;

		const now = Date.now();
		const session = await database.dbGet(
			dbName,
			"SELECT * FROM bank_sessions WHERE token = ? AND expires_at > ?",
			[token, now]
		);

		if (!session) return null;

		// Renova validade por mais 3 dias (sliding window)
		const newExpiresAt = now + SESSION_TTL_MS;
		await database.dbRun(
			dbName,
			"UPDATE bank_sessions SET last_accessed_at = ?, expires_at = ? WHERE token = ?",
			[now, newExpiresAt, token]
		);

		return {
			userId: session.user_id,
			expiresAt: newExpiresAt
		};
	}

	/**
	 * Encerra (logout) uma sessão web
	 */
	async destroySession(token) {
		if (!token) return false;
		const res = await database.dbRun(dbName, "DELETE FROM bank_sessions WHERE token = ?", [token]);
		return (res?.changes || 0) > 0;
	}

	/**
	 * Venda de peixes com algoritmo knapsack arredondando para baixo
	 * Apenas peixes comuns (is_rare = 0) são considerados. Peixes lendários NUNCA são vendidos.
	 */
	async depositFish(userId, targetKgInput) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const quota = await this.getDailyQuota(cleanUser);

		// 1. Busca peixes comuns do usuário
		const allFishes = await database.dbAll(
			"fishing",
			"SELECT id, name, weight, is_rare, emoji FROM fishing_inventory WHERE (user_id = ? OR user_id = ?) AND (is_rare = 0 OR is_rare IS NULL) ORDER BY weight DESC",
			[userId, cleanUser]
		);

		if (!allFishes || allFishes.length === 0) {
			throw new Error("Você não possui peixes comuns no inventário para vender.");
		}

		const isAll =
			typeof targetKgInput === "string" && /^(tudo|all|max)$/i.test(targetKgInput.trim());
		const requestedTarget = isAll ? Infinity : parseFloat(targetKgInput);

		if (!isAll && (isNaN(requestedTarget) || requestedTarget <= 0)) {
			throw new Error("Informe uma quantidade válida de kg para vender (ex: 300 ou 'tudo').");
		}

		// Checa teto de cota diária
		const maxAllowedByQuota = quota.remaining.pesca;
		if (maxAllowedByQuota <= 0) {
			throw new Error(
				`Você já atingiu sua cota diária de venda de peixes (${DAILY_LIMITS.pesca} kg/dia). Volte amanhã às 04:00 AM!`
			);
		}

		const effectiveTarget = Math.min(requestedTarget, maxAllowedByQuota);

		// 2. Algoritmo Knapsack Guloso (arredondando para baixo sem estourar o limite)
		const selectedFish = [];
		let accumulatedWeight = 0;

		if (isAll) {
			for (const f of allFishes) {
				if (accumulatedWeight + f.weight <= maxAllowedByQuota) {
					selectedFish.push(f);
					accumulatedWeight += f.weight;
				}
			}
		} else {
			for (const f of allFishes) {
				if (accumulatedWeight + f.weight <= effectiveTarget) {
					selectedFish.push(f);
					accumulatedWeight += f.weight;
				}
			}
		}

		if (selectedFish.length === 0 || accumulatedWeight <= 0) {
			const lightestFish = allFishes[allFishes.length - 1];
			throw new Error(
				`Nenhum peixe pôde ser vendido dentro da meta solicitada. Seu peixe comum mais leve pesa ${lightestFish.weight.toFixed(2)} kg.`
			);
		}

		accumulatedWeight = Number(accumulatedWeight.toFixed(2));

		// 3. Cálculo de spread e Runas
		const spreadRate = this.calculateSpread(
			quota.used.pesca,
			accumulatedWeight,
			DAILY_LIMITS.pesca
		);
		const rates = await this.getRates();
		const rawRunas = accumulatedWeight * rates.runasPerKgFish;
		const spreadFeeRunas = Number((rawRunas * spreadRate).toFixed(2));
		const netRunas = Number((rawRunas - spreadFeeRunas).toFixed(2));

		// 4. Remoção atômica dos peixes do inventário e decremento do peso
		const fishIds = selectedFish.map((f) => f.id);
		const placeholders = fishIds.map(() => "?").join(",");

		await database.dbRun(
			"fishing",
			`DELETE FROM fishing_inventory WHERE id IN (${placeholders})`,
			fishIds
		);

		await database.dbRun(
			"fishing",
			"UPDATE fishing_users SET inventory_weight = MAX(0, inventory_weight - ?) WHERE user_id = ? OR user_id = ?",
			[accumulatedWeight, userId, cleanUser]
		);

		// 5. Crédito na conta bancária
		const now = Date.now();
		await database.dbRun(
			dbName,
			`INSERT INTO bank_accounts (user_id, runas, total_deposited_runas, total_withdrawn_runas, created_at, updated_at)
			VALUES (?, ?, ?, 0, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET 
				runas = runas + excluded.runas,
				total_deposited_runas = total_deposited_runas + excluded.runas,
				updated_at = excluded.updated_at`,
			[cleanUser, netRunas, netRunas, now, now]
		);

		// 6. Atualização de cota diária
		const today = this.getTodayDateString();
		await database.dbRun(
			dbName,
			`INSERT INTO bank_daily_quotas (user_id, date, fish_kg_used, zinthos_used, jardim_coins_used)
			VALUES (?, ?, ?, 0, 0)
			ON CONFLICT(user_id, date) DO UPDATE SET 
				fish_kg_used = fish_kg_used + excluded.fish_kg_used`,
			[cleanUser, today, accumulatedWeight]
		);

		// 7. Registro de transação
		await database.dbRun(
			dbName,
			`INSERT INTO bank_transactions 
			(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp)
			VALUES (?, 'DEPOSIT', 'pesca', ?, ?, ?, ?, ?, ?)`,
			[
				cleanUser,
				accumulatedWeight,
				netRunas,
				spreadRate,
				spreadFeeRunas,
				JSON.stringify({
					fishCount: selectedFish.length,
					requestedKg: isAll ? "tudo" : requestedTarget,
					effectiveKg: accumulatedWeight,
					sampleFishes: selectedFish.slice(0, 3).map((f) => `${f.name} (${f.weight.toFixed(1)}kg)`)
				}),
				now
			]
		);

		const updatedAccount = await this.getAccount(cleanUser);

		return {
			game: "pesca",
			requestedKg: isAll ? "tudo" : requestedTarget,
			soldKg: accumulatedWeight,
			fishCount: selectedFish.length,
			selectedFish,
			spreadRate,
			spreadFeeRunas,
			netRunas,
			newBalance: updatedAccount.runas,
			quotaRemaining: Math.max(0, maxAllowedByQuota - accumulatedWeight)
		};
	}

	/**
	 * Depósito de Zinthos -> Converte para Runas
	 */
	async depositZinthos(userId, amountInput) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const amount = parseInt(amountInput, 10);
		if (isNaN(amount) || amount <= 0) {
			throw new Error("Informe uma quantidade válida e positiva de Zinthos.");
		}

		const quota = await this.getDailyQuota(cleanUser);
		if (amount > quota.remaining.zinthos) {
			throw new Error(
				`Essa quantidade excede sua cota diária de Zinthos restante (${quota.remaining.zinthos.toLocaleString("pt-BR")} Z). Limite diário: ${DAILY_LIMITS.zinthos.toLocaleString("pt-BR")} Z.`
			);
		}

		// 1. Debita Zinthos via Waifuletes API
		try {
			await waifuApi.post("/admin/kakera/take", {
				userId: cleanUser,
				amount,
				metadata: { reason: "bank_deposit_runas" }
			});
		} catch (err) {
			const errMsg = err.response?.data?.message || err.message;
			throw new Error(`Falha ao debitar Zinthos no Waifuletes: ${errMsg}`);
		}

		// 2. Calcula Runas com spread dinâmico
		const spreadRate = this.calculateSpread(quota.used.zinthos, amount, DAILY_LIMITS.zinthos);
		const rates = await this.getRates();
		const rawRunas = amount * rates.runasPerZinthos;
		const spreadFeeRunas = Number((rawRunas * spreadRate).toFixed(2));
		const netRunas = Number((rawRunas - spreadFeeRunas).toFixed(2));
		const now = Date.now();

		// 3. Credita Runas
		await database.dbRun(
			dbName,
			`INSERT INTO bank_accounts (user_id, runas, total_deposited_runas, total_withdrawn_runas, created_at, updated_at)
			VALUES (?, ?, ?, 0, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET 
				runas = runas + excluded.runas,
				total_deposited_runas = total_deposited_runas + excluded.runas,
				updated_at = excluded.updated_at`,
			[cleanUser, netRunas, netRunas, now, now]
		);

		// 4. Atualiza cota e registra transação
		const today = this.getTodayDateString();
		await database.dbRun(
			dbName,
			`INSERT INTO bank_daily_quotas (user_id, date, fish_kg_used, zinthos_used, jardim_coins_used)
			VALUES (?, ?, 0, ?, 0)
			ON CONFLICT(user_id, date) DO UPDATE SET 
				zinthos_used = zinthos_used + excluded.zinthos_used`,
			[cleanUser, today, amount]
		);

		await database.dbRun(
			dbName,
			`INSERT INTO bank_transactions 
			(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp)
			VALUES (?, 'DEPOSIT', 'waifu', ?, ?, ?, ?, ?, ?)`,
			[cleanUser, amount, netRunas, spreadRate, spreadFeeRunas, JSON.stringify({ amount }), now]
		);

		const updatedAccount = await this.getAccount(cleanUser);
		return {
			game: "waifu",
			amountDeposited: amount,
			spreadRate,
			spreadFeeRunas,
			netRunas,
			newBalance: updatedAccount.runas,
			quotaRemaining: Math.max(0, quota.remaining.zinthos - amount)
		};
	}

	/**
	 * Depósito de Moedas do Jardim -> Converte para Runas
	 */
	async depositJardim(userId, amountInput) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const amount = parseInt(amountInput, 10);
		if (isNaN(amount) || amount <= 0) {
			throw new Error("Informe uma quantidade válida e positiva de Moedas do Jardim.");
		}

		const quota = await this.getDailyQuota(cleanUser);
		if (amount > quota.remaining.jardim) {
			throw new Error(
				`Essa quantidade excede sua cota diária do Jardim restante (${quota.remaining.jardim.toLocaleString("pt-BR")} moedas). Limite diário: ${DAILY_LIMITS.jardim.toLocaleString("pt-BR")}.`
			);
		}

		// 1. Verifica saldo e debita no Jardim das Sombras
		try {
			const status = await jardimClient.getStatus(cleanUser);
			if ((status?.coins || 0) < amount) {
				throw new Error(
					`Você possui apenas ${(status?.coins || 0).toLocaleString("pt-BR")} moedas no Jardim das Sombras.`
				);
			}

			await jardimClient.adminGive(cleanUser, {
				coins: -amount,
				reason: "bank_deposit_runas"
			});
		} catch (err) {
			throw new Error(`Falha ao debitar moedas no Jardim: ${err.message}`);
		}

		// 2. Calcula Runas com spread dinâmico
		const spreadRate = this.calculateSpread(quota.used.jardim, amount, DAILY_LIMITS.jardim);
		const rates = await this.getRates();
		const rawRunas = amount * rates.runasPerJardimCoin;
		const spreadFeeRunas = Number((rawRunas * spreadRate).toFixed(2));
		const netRunas = Number((rawRunas - spreadFeeRunas).toFixed(2));
		const now = Date.now();

		// 3. Credita Runas
		await database.dbRun(
			dbName,
			`INSERT INTO bank_accounts (user_id, runas, total_deposited_runas, total_withdrawn_runas, created_at, updated_at)
			VALUES (?, ?, ?, 0, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET 
				runas = runas + excluded.runas,
				total_deposited_runas = total_deposited_runas + excluded.runas,
				updated_at = excluded.updated_at`,
			[cleanUser, netRunas, netRunas, now, now]
		);

		// 4. Atualiza cota e transação
		const today = this.getTodayDateString();
		await database.dbRun(
			dbName,
			`INSERT INTO bank_daily_quotas (user_id, date, fish_kg_used, zinthos_used, jardim_coins_used)
			VALUES (?, ?, 0, 0, ?)
			ON CONFLICT(user_id, date) DO UPDATE SET 
				jardim_coins_used = jardim_coins_used + excluded.jardim_coins_used`,
			[cleanUser, today, amount]
		);

		await database.dbRun(
			dbName,
			`INSERT INTO bank_transactions 
			(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp)
			VALUES (?, 'DEPOSIT', 'jardim', ?, ?, ?, ?, ?, ?)`,
			[cleanUser, amount, netRunas, spreadRate, spreadFeeRunas, JSON.stringify({ amount }), now]
		);

		const updatedAccount = await this.getAccount(cleanUser);
		return {
			game: "jardim",
			amountDeposited: amount,
			spreadRate,
			spreadFeeRunas,
			netRunas,
			newBalance: updatedAccount.runas,
			quotaRemaining: Math.max(0, quota.remaining.jardim - amount)
		};
	}

	/**
	 * Compra de Zinthos -> Converte Runas em Zinthos
	 */
	async withdrawZinthos(userId, runasInput) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const runasAmount = parseFloat(runasInput);
		if (isNaN(runasAmount) || runasAmount <= 0) {
			throw new Error("Informe uma quantidade válida de Runas para comprar Zinthos.");
		}

		const account = await this.getAccount(cleanUser);
		if (account.runas < runasAmount) {
			throw new Error(
				`Saldo insuficiente de Runas! Você possui ${account.runas.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ᚱ.`
			);
		}

		const quota = await this.getDailyQuota(cleanUser);
		if (runasAmount > quota.remaining.compra) {
			throw new Error(
				`Essa operação excede sua cota diária de compra de outras moedas (${quota.remaining.compra.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ᚱ restantes hoje de ${DAILY_LIMITS.compra.toLocaleString("pt-BR")} ᚱ).`
			);
		}

		const rates = await this.getRates();
		const spreadRate = this.calculateSpread(quota.used.compra, runasAmount, DAILY_LIMITS.compra);
		const rawZinthos = runasAmount / rates.runasPerZinthos;
		const netZinthos = Math.floor(rawZinthos * (1 - spreadRate));
		const spreadFeeRunas = Number((runasAmount * spreadRate).toFixed(2));
		const now = Date.now();

		// 1. Concede Zinthos via Waifuletes API
		try {
			await waifuApi.post("/admin/kakera/give", {
				userId: cleanUser,
				amount: netZinthos,
				reason: "ADMIN_GRANT",
				metadata: { reason: "bank_withdraw_zinthos" }
			});
		} catch (err) {
			throw new Error(`Falha ao creditar Zinthos no Waifuletes: ${err.message}`);
		}

		// 2. Debita Runas da conta
		await database.dbRun(
			dbName,
			`UPDATE bank_accounts SET 
				runas = runas - ?, 
				total_withdrawn_runas = total_withdrawn_runas + ?, 
				updated_at = ? 
			WHERE user_id = ?`,
			[runasAmount, runasAmount, now, cleanUser]
		);

		// 3. Atualiza cota e transação
		const today = this.getTodayDateString();
		await database.dbRun(
			dbName,
			`INSERT INTO bank_daily_quotas (user_id, date, fish_kg_used, zinthos_used, jardim_coins_used, runas_compra_used)
			VALUES (?, ?, 0, 0, 0, ?)
			ON CONFLICT(user_id, date) DO UPDATE SET 
				runas_compra_used = runas_compra_used + excluded.runas_compra_used`,
			[cleanUser, today, runasAmount]
		);

		await database.dbRun(
			dbName,
			`INSERT INTO bank_transactions 
			(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp)
			VALUES (?, 'WITHDRAW', 'waifu', ?, ?, ?, ?, ?, ?)`,
			[
				cleanUser,
				netZinthos,
				runasAmount,
				spreadRate,
				spreadFeeRunas,
				JSON.stringify({ runasAmount, netZinthos }),
				now
			]
		);

		const updatedAccount = await this.getAccount(cleanUser);
		return {
			game: "waifu",
			runasSpent: runasAmount,
			netZinthos,
			spreadRate,
			spreadFeeRunas,
			newBalance: updatedAccount.runas,
			quotaRemaining: Math.max(0, quota.remaining.compra - runasAmount)
		};
	}

	/**
	 * Compra de Petalitas -> Converte Runas em Petalitas
	 */
	async withdrawJardim(userId, runasInput) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const runasAmount = parseFloat(runasInput);
		if (isNaN(runasAmount) || runasAmount <= 0) {
			throw new Error("Informe uma quantidade válida de Runas para comprar Petalitas.");
		}

		const account = await this.getAccount(cleanUser);
		if (account.runas < runasAmount) {
			throw new Error(
				`Saldo insuficiente de Runas! Você possui ${account.runas.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ᚱ.`
			);
		}

		const quota = await this.getDailyQuota(cleanUser);
		if (runasAmount > quota.remaining.compra) {
			throw new Error(
				`Essa operação excede sua cota diária de compra de outras moedas (${quota.remaining.compra.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ᚱ restantes hoje de ${DAILY_LIMITS.compra.toLocaleString("pt-BR")} ᚱ).`
			);
		}

		const rates = await this.getRates();
		const spreadRate = this.calculateSpread(quota.used.compra, runasAmount, DAILY_LIMITS.compra);
		const rawCoins = runasAmount / rates.runasPerJardimCoin;
		const netCoins = Math.floor(rawCoins * (1 - spreadRate));
		const spreadFeeRunas = Number((runasAmount * spreadRate).toFixed(2));
		const now = Date.now();

		// 1. Concede Petalitas no Jardim das Sombras
		try {
			await jardimClient.adminGive(cleanUser, {
				coins: netCoins,
				reason: "bank_withdraw_jardim"
			});
		} catch (err) {
			throw new Error(`Falha ao creditar Petalitas no Jardim: ${err.message}`);
		}

		// 2. Debita Runas da conta
		await database.dbRun(
			dbName,
			`UPDATE bank_accounts SET 
				runas = runas - ?, 
				total_withdrawn_runas = total_withdrawn_runas + ?, 
				updated_at = ? 
			WHERE user_id = ?`,
			[runasAmount, runasAmount, now, cleanUser]
		);

		// 3. Atualiza cota e transação
		const today = this.getTodayDateString();
		await database.dbRun(
			dbName,
			`INSERT INTO bank_daily_quotas (user_id, date, fish_kg_used, zinthos_used, jardim_coins_used, runas_compra_used)
			VALUES (?, ?, 0, 0, 0, ?)
			ON CONFLICT(user_id, date) DO UPDATE SET 
				runas_compra_used = runas_compra_used + excluded.runas_compra_used`,
			[cleanUser, today, runasAmount]
		);

		await database.dbRun(
			dbName,
			`INSERT INTO bank_transactions 
			(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp)
			VALUES (?, 'WITHDRAW', 'jardim', ?, ?, ?, ?, ?, ?)`,
			[
				cleanUser,
				netCoins,
				runasAmount,
				spreadRate,
				spreadFeeRunas,
				JSON.stringify({ runasAmount, netCoins }),
				now
			]
		);

		const updatedAccount = await this.getAccount(cleanUser);
		return {
			game: "jardim",
			runasSpent: runasAmount,
			netCoins,
			spreadRate,
			spreadFeeRunas,
			newBalance: updatedAccount.runas,
			quotaRemaining: Math.max(0, quota.remaining.compra - runasAmount)
		};
	}

	/**
	 * Bloqueio de saque de peixe (Regra de Negócio: Mão única)
	 */
	withdrawFish() {
		throw new Error(
			"Não é permitido converter Runas para peixes. Peixes só podem ser vendidos para o banco."
		);
	}

	/**
	 * Extrato consolidado de transações do usuário
	 */
	async getTransactions(userId, limit = 10) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		return await database.dbAll(
			dbName,
			"SELECT * FROM bank_transactions WHERE user_id = ? OR user_id = ? ORDER BY timestamp DESC LIMIT ?",
			[userId, cleanUser, limit]
		);
	}

	/**
	 * Panorama macroeconômico e estatísticas globais para a tela pública
	 */
	async getMacroEconomics() {
		const rates = await this.getRates();

		// Total de Runas em circulação
		const runasRow = await database.dbGet(
			dbName,
			"SELECT SUM(runas) as totalRunas, COUNT(*) as totalAccounts FROM bank_accounts"
		);
		const totalRunas = runasRow?.totalRunas || 0;
		const totalAccounts = runasRow?.totalAccounts || 0;

		// Total de peixe comum e contagem
		let totalFishWeight = 5148753;
		let totalFishCount = 67797;
		try {
			const fishRow = await database.dbGet(
				"fishing",
				"SELECT COUNT(*) as count, SUM(weight) as weight FROM fishing_inventory WHERE is_rare = 0 OR is_rare IS NULL"
			);
			if (fishRow) {
				totalFishWeight = fishRow.weight || totalFishWeight;
				totalFishCount = fishRow.count || totalFishCount;
			}
		} catch (e) {}

		// Massa de Zinthos e inflação do Waifuletes
		let circulatingZinthos = 4820000;
		let inflationPercent = 9.35;
		try {
			const { data } = await waifuApi.get("/market/stats");
			if (data?.data) {
				circulatingZinthos = data.data.circulatingKakera || circulatingZinthos;
				inflationPercent = data.data.inflationPercent || inflationPercent;
			}
		} catch (e) {}

		// Moedas do Jardim
		let totalJardimCoins = 17938824;
		try {
			const snapRow = await database.dbGet(
				"fazenda",
				"SELECT SUM(coins) as totalCoins FROM fazenda_player_snapshots WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM fazenda_player_snapshots)"
			);
			if (snapRow?.totalCoins) {
				totalJardimCoins = snapRow.totalCoins;
			}
		} catch (e) {}

		return {
			rates,
			totalRunas,
			totalAccounts,
			fish: {
				totalWeight: totalFishWeight,
				totalCount: totalFishCount,
				isOneWay: true
			},
			waifu: {
				circulatingZinthos,
				inflationPercent
			},
			jardim: {
				totalCoins: totalJardimCoins
			},
			rules: {
				dailyLimits: DAILY_LIMITS,
				spreadRange: "3% a 10% (progressivo por cota diária)",
				rotationTime: "04:00 AM (Horário de Brasília)",
				circuitBreaker: "+-10% max variação diária",
				legendaryFishBlocked: true
			}
		};
	}

	/**
	 * Libera/reseta as cotas diárias de todos os usuários para uma data (ou hoje)
	 */
	async resetQuotasForDate(dateStr) {
		const targetDate = dateStr || this.getTodayDateString();
		const res = await database.dbRun(dbName, "DELETE FROM bank_daily_quotas WHERE date = ?", [
			targetDate
		]);
		logger.info(
			`[RavenaBank] Cotas diárias liberadas para a data ${targetDate}. Registros resetados: ${res?.changes || 0}`
		);
		return res?.changes || 0;
	}
}

module.exports = new BankService();
