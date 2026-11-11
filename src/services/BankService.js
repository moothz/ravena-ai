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

// Constantes econômicas base (1.000 Runas = 800 kg = 3.500 Z = 8.000 Ptl)
const BASE_RUNAS_PER_KG_FISH = 1000 / 800; // 1.25 Runas / kg
const BASE_RUNAS_PER_ZINTHOS = 1000 / 3500; // ~0.2857 Runas / Zinthos
const BASE_RUNAS_PER_JARDIM = 1000 / 8000; // 0.125 Runas / Petalita (Ptl)

// Cotas diárias de economia: venda para ganhar Runas (300k/dia unificado) e caminho inverso para jogos (base 500k Zinthos, 300k Petalitas, 300 moedas, 200 iscas)
const DAILY_LIMITS = {
	venda_runas: 300000, // 300.000 ᚱ/dia (limite unificado para ganhar Runas vendendo peixes, zinthos ou petalitas)
	compra_zinthos: 500000, // Base de 500.000 Zinthos/dia (progressivo diário com inflação, inicia ~600k)
	compra_jardim: 300000, // Base de 300.000 Petalitas/dia (progressivo diário com inflação, inicia ~320k)
	compra_moedas: 300, // 300 moedas/dia no SlotsGame
	compra_iscas: 200, // 200 iscas/dia no FishingGame
	// Legado para compatibilidade:
	pesca: 300000,
	zinthos: 500000,
	jardim: 300000,
	compra: 300000
};

// Configurações da Loja do RavenaBank (compra de consumíveis com Runas)
const STORE_PRICES = {
	moeda: 55, // 55 Runas por moedinha de Slots
	isca: 45 // 45 Runas por isca de Pesca
};

const STORE_LIMITS = {
	dailySlotsCoins: 300, // Limite diário de 300 moedas compradas
	dailyFishingBaits: 200 // Limite diário de 200 iscas compradas
};

// Duração da sessão web (3 dias em milissegundos)
const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function parseBankAmount(input) {
	if (typeof input === "number") return input;
	if (!input) return 0;
	let str = String(input).trim().toLowerCase();
	str = str.replace(/\s+/g, "");
	if (str.includes(",") && str.includes(".")) {
		str = str.replace(/\./g, "").replace(",", ".");
	} else if (str.includes(",")) {
		str = str.replace(",", ".");
	} else if (str.includes(".")) {
		const parts = str.split(".");
		if (parts.length > 1 && parts.slice(1).every((p) => p.length === 3)) {
			str = str.replace(/\./g, "");
		}
	}
	return parseFloat(str);
}

class BankService {
	constructor() {
		this._initialized = false;
		this.STORE_PRICES = STORE_PRICES;
		this.STORE_LIMITS = STORE_LIMITS;
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
					quota_compra_zinthos REAL DEFAULT 500000,
					quota_compra_jardim REAL DEFAULT 300000,
					waifu_inflation_percent REAL DEFAULT 0,
					jardim_inflation_percent REAL DEFAULT 0,
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
					timestamp INTEGER NOT NULL,
					status TEXT DEFAULT 'COMPLETED',
					undone_at INTEGER DEFAULT NULL,
					undone_by TEXT DEFAULT NULL,
					undo_fee_runas REAL DEFAULT NULL,
					undo_final_runas REAL DEFAULT NULL
				);

				CREATE TABLE IF NOT EXISTS bank_daily_quotas (
					user_id TEXT NOT NULL,
					date TEXT NOT NULL,
					fish_kg_used REAL DEFAULT 0,
					zinthos_used REAL DEFAULT 0,
					jardim_coins_used REAL DEFAULT 0,
					runas_compra_used REAL DEFAULT 0,
					runas_venda_used REAL DEFAULT 0,
					zinthos_compra_used REAL DEFAULT 0,
					jardim_compra_used REAL DEFAULT 0,
					moedas_compra_used INTEGER DEFAULT 0,
					iscas_compra_used INTEGER DEFAULT 0,
					initial_runas REAL DEFAULT NULL,
					PRIMARY KEY (user_id, date)
				);
				`
			);
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_daily_quotas ADD COLUMN runas_compra_used REAL DEFAULT 0;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_daily_quotas ADD COLUMN runas_venda_used REAL DEFAULT 0;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_daily_quotas ADD COLUMN zinthos_compra_used REAL DEFAULT 0;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_daily_quotas ADD COLUMN jardim_compra_used REAL DEFAULT 0;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_daily_quotas ADD COLUMN moedas_compra_used INTEGER DEFAULT 0;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_daily_quotas ADD COLUMN iscas_compra_used INTEGER DEFAULT 0;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_daily_quotas ADD COLUMN initial_runas REAL DEFAULT NULL;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec(
						"ALTER TABLE bank_daily_rates ADD COLUMN quota_compra_zinthos REAL DEFAULT 500000;"
					);
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_daily_rates ADD COLUMN quota_compra_jardim REAL DEFAULT 300000;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_daily_rates ADD COLUMN waifu_inflation_percent REAL DEFAULT 0;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_daily_rates ADD COLUMN jardim_inflation_percent REAL DEFAULT 0;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_transactions ADD COLUMN status TEXT DEFAULT 'COMPLETED';");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_transactions ADD COLUMN undone_at INTEGER DEFAULT NULL;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_transactions ADD COLUMN undone_by TEXT DEFAULT NULL;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_transactions ADD COLUMN undo_fee_runas REAL DEFAULT NULL;");
			} catch (_) {}
			try {
				database
					.getSQLiteDb(dbName)
					.exec("ALTER TABLE bank_transactions ADD COLUMN undo_final_runas REAL DEFAULT NULL;");
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
				const newDate = this.getTodayDateString();
				await database.dbRun(
					dbName,
					`INSERT INTO bank_daily_quotas (user_id, date, initial_runas)
					SELECT user_id, ?, runas FROM bank_accounts
					ON CONFLICT(user_id, date) DO UPDATE SET initial_runas = excluded.initial_runas`,
					[newDate]
				);
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

	getLastResetTimestamp(date = new Date()) {
		const todayDateStr = this.getTodayDateString(date);
		return Date.parse(`${todayDateStr}T07:00:00.000Z`);
	}

	/**
	 * Retorna o saldo anterior (no reset das 04:00 AM) e o saldo atual do usuário
	 */
	async getDailyBalanceSnapshot(userId) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const account = await this.getAccount(cleanUser);
		const currentRunas = Number(account?.runas || 0);
		const today = this.getTodayDateString();
		const resetTs = this.getLastResetTimestamp();

		const quotaRow = await database.dbGet(
			dbName,
			"SELECT initial_runas FROM bank_daily_quotas WHERE (user_id = ? OR user_id = ?) AND date = ?",
			[userId, cleanUser, today]
		);

		if (quotaRow && quotaRow.initial_runas !== null && quotaRow.initial_runas !== undefined) {
			return {
				previousRunas: Number(quotaRow.initial_runas),
				currentRunas,
				resetDate: today,
				resetTimestamp: resetTs
			};
		}

		// Se ainda não temos initial_runas gravado para hoje, calculamos retroativamente a partir das transações pós-reset:
		const txs = await database.dbAll(
			dbName,
			"SELECT type, runas_amount FROM bank_transactions WHERE (user_id = ? OR user_id = ?) AND timestamp >= ?",
			[userId, cleanUser, resetTs]
		);

		let calculatedInitial = currentRunas;
		for (const t of txs || []) {
			const amt = Number(t.runas_amount || 0);
			if (t.type === "DEPOSIT" || t.type === "BONUS") {
				calculatedInitial -= amt;
			} else if (t.type === "WITHDRAW") {
				calculatedInitial += amt;
			}
		}
		calculatedInitial = Math.max(0, calculatedInitial);

		// Grava/atualiza em bank_daily_quotas
		await database.dbRun(
			dbName,
			`INSERT INTO bank_daily_quotas (user_id, date, initial_runas)
			VALUES (?, ?, ?)
			ON CONFLICT(user_id, date) DO UPDATE SET 
				initial_runas = COALESCE(bank_daily_quotas.initial_runas, excluded.initial_runas)`,
			[cleanUser, today, calculatedInitial]
		);

		return {
			previousRunas: calculatedInitial,
			currentRunas,
			resetDate: today,
			resetTimestamp: resetTs
		};
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
				let quotaZ = Number(existing.quota_compra_zinthos || 0);
				let quotaJ = Number(existing.quota_compra_jardim || 0);
				const waifuInf = Number(existing.waifu_inflation_percent || 0);
				let jardimInf = Number(existing.jardim_inflation_percent || 0);

				// Se o registro existente for anterior à nova progressão de cotas, atualiza para o novo patamar
				if (quotaZ < 500000 || quotaJ < 300000) {
					quotaZ = 600000;
					quotaJ = 320000;
					jardimInf = 6.42;
					try {
						await database.dbRun(
							dbName,
							"UPDATE bank_daily_rates SET quota_compra_zinthos = ?, quota_compra_jardim = ?, jardim_inflation_percent = ? WHERE date = ?",
							[quotaZ, quotaJ, jardimInf, today]
						);
					} catch (_) {}
				}

				return {
					date: existing.date,
					runasPerKgFish: existing.runas_per_kg_fish,
					runasPerZinthos: existing.runas_per_zinthos,
					runasPerJardimCoin: existing.runas_per_jardim_coin,
					fishMultiplier: existing.fish_multiplier,
					waifuMultiplier: existing.waifu_multiplier,
					jardimMultiplier: existing.jardim_multiplier,
					quotaCompraZinthos: quotaZ,
					quotaCompraJardim: quotaJ,
					waifuInflationPercent: waifuInf,
					jardimInflationPercent: jardimInf,
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

		// Cotação do dia anterior para aplicação de circuit breaker (+-10%) e progressão de cotas
		const prev = await database.dbGet(
			dbName,
			"SELECT * FROM bank_daily_rates ORDER BY date DESC LIMIT 1"
		);

		let waifuMult = 1.0;
		let fishMult = 1.0;
		let jardimMult = 1.0;
		let waifuInflationPercent = 0;
		let rawInflationMult = 1.0;

		// 1. Fator Waifus via inflação IM
		try {
			const { data } = await waifuApi.get("/market/stats");
			rawInflationMult = data?.data?.inflationMultiplier || 1.0;
			waifuInflationPercent = Number(
				(data?.data?.inflationPercent ?? (rawInflationMult - 1) * 100).toFixed(2)
			);
			// Se há mais inflação de Zinthos, Zinthos compra menos Runas
			waifuMult = Number((1.0 / Math.max(1.0, rawInflationMult)).toFixed(4));
		} catch (err) {
			logger.warn(`[BankService] Falha ao consultar /market/stats do Waifuletes: ${err.message}`);
			waifuMult = prev ? prev.waifu_multiplier : 1.0;
			waifuInflationPercent =
				prev && prev.waifu_inflation_percent ? Number(prev.waifu_inflation_percent) : 0;
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
		let totalJardimCoins = 17938824;
		let jardimInflationPercent = 0;
		try {
			const snapRow = await database.dbGet(
				"fazenda",
				"SELECT SUM(coins) as totalCoins FROM fazenda_player_snapshots WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM fazenda_player_snapshots)"
			);
			totalJardimCoins = snapRow?.totalCoins || 17938824;
			const baselineCoins = 17938824;
			const ratio = totalJardimCoins / baselineCoins;
			jardimMult = Number(Math.pow(1.0 / Math.max(0.5, ratio), 0.2).toFixed(4));
			jardimInflationPercent = Number(Math.max(0, (ratio - 1) * 100).toFixed(2));
		} catch (err) {
			logger.warn(`[BankService] Falha ao estimar pressão da fazenda: ${err.message}`);
			jardimMult = prev ? prev.jardim_multiplier : 1.0;
			jardimInflationPercent =
				prev && prev.jardim_inflation_percent ? Number(prev.jardim_inflation_percent) : 0;
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

		// 4. Cotas Dinâmicas de Compra (Zinthos e Petalitas) com progressão diária gradual
		const BASE_QUOTA_ZINTHOS = 500000;
		const BASE_QUOTA_JARDIM = 300000;

		const targetQuotaZinthos = Math.round(BASE_QUOTA_ZINTHOS * (1 + waifuInflationPercent / 100));
		const targetQuotaJardim = Math.round(BASE_QUOTA_JARDIM * (1 + jardimInflationPercent / 100));

		const prevQuotaZinthos = prev?.quota_compra_zinthos ? Number(prev.quota_compra_zinthos) : 0;
		const prevQuotaJardim = prev?.quota_compra_jardim ? Number(prev.quota_compra_jardim) : 0;

		let quotaCompraZinthos;
		if (prevQuotaZinthos < BASE_QUOTA_ZINTHOS) {
			// Ponto de partida inicial: ~600k conforme solicitado
			quotaCompraZinthos = 600000;
		} else {
			// Progressão diária suave (+1% ao dia sobre a cota anterior, caminhando até o target)
			const step = Math.max(5000, Math.round(prevQuotaZinthos * 0.01));
			const maxAllowed = Math.max(targetQuotaZinthos, 600000);
			quotaCompraZinthos = Math.min(maxAllowed, prevQuotaZinthos + step);
			quotaCompraZinthos = Math.round(quotaCompraZinthos / 500) * 500;
		}

		let quotaCompraJardim;
		if (prevQuotaJardim < BASE_QUOTA_JARDIM) {
			// Ponto de partida inicial: 300k base + inflação atual (~6.42%) -> ~320k
			quotaCompraJardim = 320000;
		} else {
			// Progressão diária suave (+0.5% ao dia sobre a cota anterior)
			const step = Math.max(1500, Math.round(prevQuotaJardim * 0.005));
			const maxAllowed = Math.max(targetQuotaJardim, 320000);
			quotaCompraJardim = Math.min(maxAllowed, prevQuotaJardim + step);
			quotaCompraJardim = Math.round(quotaCompraJardim / 500) * 500;
		}

		const now = Date.now();

		await database.dbRun(
			dbName,
			`INSERT OR REPLACE INTO bank_daily_rates 
			(date, runas_per_kg_fish, runas_per_zinthos, runas_per_jardim_coin, fish_multiplier, waifu_multiplier, jardim_multiplier, quota_compra_zinthos, quota_compra_jardim, waifu_inflation_percent, jardim_inflation_percent, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				today,
				runasPerKgFish,
				runasPerZinthos,
				runasPerJardimCoin,
				fishMult,
				waifuMult,
				jardimMult,
				quotaCompraZinthos,
				quotaCompraJardim,
				waifuInflationPercent,
				jardimInflationPercent,
				now
			]
		);

		logger.info(
			`[RavenaBank] Cotações atualizadas para ${today}: 1kg=${runasPerKgFish}R, 1Z=${runasPerZinthos}R, 1MJ=${runasPerJardimCoin}R | Cotas: Zinthos=${quotaCompraZinthos}Z (Inf: +${waifuInflationPercent}%), Jardim=${quotaCompraJardim}Ptl (Inf: +${jardimInflationPercent}%)`
		);

		return {
			date: today,
			runasPerKgFish,
			runasPerZinthos,
			runasPerJardimCoin,
			fishMultiplier: fishMult,
			waifuMultiplier: waifuMult,
			jardimMultiplier: jardimMult,
			quotaCompraZinthos,
			quotaCompraJardim,
			waifuInflationPercent,
			jardimInflationPercent,
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
		const runasVendaUsed = Number(row?.runas_venda_used || 0);
		const zinthosCompraUsed = Number(row?.zinthos_compra_used || 0);
		const jardimCompraUsed = Number(row?.jardim_compra_used || 0);
		const moedasCompraUsed = Number(row?.moedas_compra_used || 0);
		const iscasCompraUsed = Number(row?.iscas_compra_used || 0);

		const rates = await this.getRates();
		const limits = {
			...DAILY_LIMITS,
			compra_zinthos: rates.quotaCompraZinthos || DAILY_LIMITS.compra_zinthos,
			compra_jardim: rates.quotaCompraJardim || DAILY_LIMITS.compra_jardim,
			zinthos: rates.quotaCompraZinthos || DAILY_LIMITS.compra_zinthos,
			jardim: rates.quotaCompraJardim || DAILY_LIMITS.compra_jardim
		};

		return {
			date: today,
			limits,
			used: {
				venda_runas: runasVendaUsed,
				compra_zinthos: zinthosCompraUsed,
				compra_jardim: jardimCompraUsed,
				compra_moedas: moedasCompraUsed,
				compra_iscas: iscasCompraUsed,
				pesca: fishUsed,
				zinthos: zinthosUsed,
				jardim: jardimUsed,
				compra: compraUsed
			},
			remaining: {
				venda_runas: Math.max(0, limits.venda_runas - runasVendaUsed),
				compra_zinthos: Math.max(0, limits.compra_zinthos - zinthosCompraUsed),
				compra_jardim: Math.max(0, limits.compra_jardim - jardimCompraUsed),
				compra_moedas: Math.max(0, limits.compra_moedas - moedasCompraUsed),
				compra_iscas: Math.max(0, limits.compra_iscas - iscasCompraUsed),
				venda: Math.max(0, limits.venda_runas - runasVendaUsed),
				compra: Math.max(0, limits.venda_runas - runasVendaUsed),
				pesca: Math.max(0, limits.venda_runas - runasVendaUsed),
				zinthos: Math.max(0, limits.compra_zinthos - zinthosCompraUsed),
				jardim: Math.max(0, limits.compra_jardim - jardimCompraUsed)
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

		// Checa teto de cota diária de venda (300.000 Runas)
		const quotaRemainingRunas = quota.remaining.venda_runas;
		if (quotaRemainingRunas <= 0) {
			throw new Error(
				`Você já atingiu sua cota diária de venda (${DAILY_LIMITS.venda_runas.toLocaleString("pt-BR")} ᚱ/dia). Volte amanhã às 04:00 AM!`
			);
		}

		const rates = await this.getRates();
		const maxAllowedByQuota = quotaRemainingRunas / rates.runasPerKgFish;
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
		const rawRunas = accumulatedWeight * rates.runasPerKgFish;
		const spreadRate = this.calculateSpread(
			quota.used.venda_runas,
			rawRunas,
			DAILY_LIMITS.venda_runas
		);
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
			`INSERT INTO bank_daily_quotas (user_id, date, fish_kg_used, zinthos_used, jardim_coins_used, runas_compra_used, runas_venda_used, zinthos_compra_used, jardim_compra_used)
			VALUES (?, ?, ?, 0, 0, 0, ?, 0, 0)
			ON CONFLICT(user_id, date) DO UPDATE SET 
				fish_kg_used = fish_kg_used + excluded.fish_kg_used,
				runas_venda_used = runas_venda_used + excluded.runas_venda_used`,
			[cleanUser, today, accumulatedWeight, netRunas]
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
			quotaRemaining: Math.max(0, quotaRemainingRunas - netRunas)
		};
	}

	/**
	 * Depósito de Zinthos -> Converte para Runas
	 */
	async depositZinthos(userId, amountInput) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const quota = await this.getDailyQuota(cleanUser);

		const quotaRemainingRunas = quota.remaining.venda_runas;
		if (quotaRemainingRunas <= 0) {
			throw new Error(
				`Sua cota diária de venda (${DAILY_LIMITS.venda_runas.toLocaleString("pt-BR")} ᚱ/dia) já foi esgotada hoje. Volte amanhã às 04:00 AM!`
			);
		}

		const rates = await this.getRates();
		const maxZinthosAllowed = Math.floor(quotaRemainingRunas / rates.runasPerZinthos);

		let amount;
		const isAll = String(amountInput).trim().toLowerCase() === "tudo";
		if (isAll) {
			let userBalance = 0;
			try {
				const { data } = await waifuApi.get(`/kakera/${cleanUser}`);
				userBalance = data?.data?.balance ?? data?.data?.kakera ?? 0;
			} catch (_) {}
			amount = Math.min(userBalance, maxZinthosAllowed);
			if (amount <= 0) {
				if (userBalance <= 0) {
					throw new Error("Você não possui Zinthos para vender.");
				}
				throw new Error(
					`Sua cota diária de venda (${DAILY_LIMITS.venda_runas.toLocaleString("pt-BR")} ᚱ/dia) já foi esgotada hoje.`
				);
			}
		} else {
			amount = Math.floor(parseBankAmount(amountInput));
			if (isNaN(amount) || amount <= 0) {
				throw new Error("Informe uma quantidade válida e positiva de Zinthos.");
			}
			if (amount > maxZinthosAllowed) {
				throw new Error(
					`Essa quantidade excede sua cota diária de venda restante (restam ${quotaRemainingRunas.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ᚱ de ${DAILY_LIMITS.venda_runas.toLocaleString("pt-BR")} ᚱ hoje, equivalente a no máximo ${maxZinthosAllowed.toLocaleString("pt-BR")} Z).`
				);
			}
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

		try {
			// 2. Calcula Runas com spread dinâmico
			const rawRunas = amount * rates.runasPerZinthos;
			const spreadRate = this.calculateSpread(
				quota.used.venda_runas,
				rawRunas,
				DAILY_LIMITS.venda_runas
			);
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
				`INSERT INTO bank_daily_quotas (user_id, date, fish_kg_used, zinthos_used, jardim_coins_used, runas_compra_used, runas_venda_used, zinthos_compra_used, jardim_compra_used)
				VALUES (?, ?, 0, ?, 0, 0, ?, 0, 0)
				ON CONFLICT(user_id, date) DO UPDATE SET 
					zinthos_used = zinthos_used + excluded.zinthos_used,
					runas_venda_used = runas_venda_used + excluded.runas_venda_used`,
				[cleanUser, today, amount, netRunas]
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
				quotaRemaining: Math.max(0, quotaRemainingRunas - netRunas)
			};
		} catch (err) {
			try {
				await waifuApi.post("/admin/kakera/give", {
					userId: cleanUser,
					amount,
					reason: "ADMIN_GRANT",
					metadata: { reason: "bank_deposit_rollback_error" }
				});
				logger.warn(
					`[RavenaBank] Rollback de depósito de Zinthos executado para ${cleanUser} (${amount} Z reembolsados devido a falha: ${err.message})`
				);
			} catch (rollbackErr) {
				logger.error(
					`[RavenaBank] FALHA CRÍTICA no rollback de Zinthos para ${cleanUser} (${amount} Z): ${rollbackErr.message}`
				);
			}
			throw err;
		}
	}

	/**
	 * Depósito de Petalitas -> Converte para Runas
	 */
	async depositJardim(userId, amountInput) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const quota = await this.getDailyQuota(cleanUser);

		const quotaRemainingRunas = quota.remaining.venda_runas;
		if (quotaRemainingRunas <= 0) {
			throw new Error(
				`Sua cota diária de venda (${DAILY_LIMITS.venda_runas.toLocaleString("pt-BR")} ᚱ/dia) já foi esgotada hoje. Volte amanhã às 04:00 AM!`
			);
		}

		const rates = await this.getRates();
		const maxJardimAllowed = Math.floor(quotaRemainingRunas / rates.runasPerJardimCoin);

		let amount;
		const isAll = String(amountInput).trim().toLowerCase() === "tudo";
		if (isAll) {
			let gardenCoins = 0;
			try {
				const status = await jardimClient.getStatus(cleanUser);
				gardenCoins = status?.coins || 0;
			} catch (_) {}
			amount = Math.min(gardenCoins, maxJardimAllowed);
			if (amount <= 0) {
				if (gardenCoins <= 0) {
					throw new Error("Você não possui Petalitas para vender.");
				}
				throw new Error(
					`Sua cota diária de venda (${DAILY_LIMITS.venda_runas.toLocaleString("pt-BR")} ᚱ/dia) já foi esgotada hoje.`
				);
			}
		} else {
			amount = Math.floor(parseBankAmount(amountInput));
			if (isNaN(amount) || amount <= 0) {
				throw new Error("Informe uma quantidade válida e positiva de Petalitas.");
			}
			if (amount > maxJardimAllowed) {
				throw new Error(
					`Essa quantidade excede sua cota diária de venda restante (restam ${quotaRemainingRunas.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ᚱ de ${DAILY_LIMITS.venda_runas.toLocaleString("pt-BR")} ᚱ hoje, equivalente a no máximo ${maxJardimAllowed.toLocaleString("pt-BR")} Ptl).`
				);
			}
		}

		// 1. Verifica saldo e debita no Jardim das Sombras
		try {
			const status = await jardimClient.getStatus(cleanUser);
			if ((status?.coins || 0) < amount) {
				throw new Error(
					`Você possui apenas ${(status?.coins || 0).toLocaleString("pt-BR")} Petalitas na Fazenda.`
				);
			}

			await jardimClient.adminGive(cleanUser, {
				coins: -amount,
				reason: "bank_deposit_runas"
			});
		} catch (err) {
			throw new Error(`Falha ao debitar Petalitas no Jardim: ${err.message}`);
		}

		try {
			// 2. Calcula Runas com spread dinâmico
			const rawRunas = amount * rates.runasPerJardimCoin;
			const spreadRate = this.calculateSpread(
				quota.used.venda_runas,
				rawRunas,
				DAILY_LIMITS.venda_runas
			);
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
				`INSERT INTO bank_daily_quotas (user_id, date, fish_kg_used, zinthos_used, jardim_coins_used, runas_compra_used, runas_venda_used, zinthos_compra_used, jardim_compra_used)
				VALUES (?, ?, 0, 0, ?, 0, ?, 0, 0)
				ON CONFLICT(user_id, date) DO UPDATE SET 
					jardim_coins_used = jardim_coins_used + excluded.jardim_coins_used,
					runas_venda_used = runas_venda_used + excluded.runas_venda_used`,
				[cleanUser, today, amount, netRunas]
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
				quotaRemaining: Math.max(0, quotaRemainingRunas - netRunas)
			};
		} catch (err) {
			try {
				await jardimClient.adminGive(cleanUser, {
					coins: amount,
					reason: "bank_deposit_rollback_error"
				});
				logger.warn(
					`[RavenaBank] Rollback de depósito de Petalitas executado para ${cleanUser} (${amount} Ptl reembolsadas devido a falha: ${err.message})`
				);
			} catch (rollbackErr) {
				logger.error(
					`[RavenaBank] FALHA CRÍTICA no rollback de Petalitas para ${cleanUser} (${amount} Ptl): ${rollbackErr.message}`
				);
			}
			throw err;
		}
	}

	/**
	 * Compra de Zinthos -> Converte Runas em Zinthos
	 */
	async withdrawZinthos(userId, runasInput) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const account = await this.getAccount(cleanUser);
		const quota = await this.getDailyQuota(cleanUser);
		const limitZinthos = quota.limits.compra_zinthos;

		const quotaRemainingZinthos = quota.remaining.compra_zinthos;
		if (quotaRemainingZinthos <= 0) {
			throw new Error(
				`Sua cota diária de compra de Zinthos (${limitZinthos.toLocaleString("pt-BR")} Z/dia) já foi esgotada hoje. Volte amanhã às 04:00 AM!`
			);
		}

		const rates = await this.getRates();
		let runasAmount;
		const isAll = String(runasInput).trim().toLowerCase() === "tudo";
		if (isAll) {
			if (account.runas <= 0) {
				throw new Error("Você não possui Runas suficientes para realizar compras.");
			}
			const maxRawZinthos = quotaRemainingZinthos / 0.97;
			const maxRunasForQuota = maxRawZinthos * rates.runasPerZinthos;
			runasAmount = Number(Math.min(account.runas, maxRunasForQuota).toFixed(2));
			if (runasAmount <= 0) {
				throw new Error("Sua cota diária de compra de Zinthos já foi esgotada hoje.");
			}
		} else {
			runasAmount = Number(parseBankAmount(runasInput).toFixed(2));
			if (isNaN(runasAmount) || runasAmount <= 0) {
				throw new Error("Informe uma quantidade válida de Runas para comprar Zinthos.");
			}
			if (account.runas < runasAmount) {
				throw new Error(
					`Saldo insuficiente de Runas! Você possui ${account.runas.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ᚱ.`
				);
			}
		}

		const rawZinthos = runasAmount / rates.runasPerZinthos;
		const spreadRate = this.calculateSpread(quota.used.compra_zinthos, rawZinthos, limitZinthos);
		let netZinthos = Math.floor(rawZinthos * (1 - spreadRate));
		const spreadFeeRunas = Number((runasAmount * spreadRate).toFixed(2));

		if (netZinthos > quotaRemainingZinthos) {
			if (isAll) {
				netZinthos = quotaRemainingZinthos;
			} else {
				throw new Error(
					`Essa operação excede sua cota diária de Zinthos (${quotaRemainingZinthos.toLocaleString("pt-BR")} Z restantes hoje de ${limitZinthos.toLocaleString("pt-BR")} Z).`
				);
			}
		}

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
			`INSERT INTO bank_daily_quotas (user_id, date, fish_kg_used, zinthos_used, jardim_coins_used, runas_compra_used, runas_venda_used, zinthos_compra_used, jardim_compra_used)
			VALUES (?, ?, 0, 0, 0, ?, 0, ?, 0)
			ON CONFLICT(user_id, date) DO UPDATE SET 
				runas_compra_used = runas_compra_used + excluded.runas_compra_used,
				zinthos_compra_used = zinthos_compra_used + excluded.zinthos_compra_used`,
			[cleanUser, today, runasAmount, netZinthos]
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
			quotaRemaining: Math.max(0, quotaRemainingZinthos - netZinthos)
		};
	}

	/**
	 * Compra de Petalitas -> Converte Runas em Petalitas
	 */
	async withdrawJardim(userId, runasInput) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const account = await this.getAccount(cleanUser);
		const quota = await this.getDailyQuota(cleanUser);
		const limitJardim = quota.limits.compra_jardim;

		const quotaRemainingJardim = quota.remaining.compra_jardim;
		if (quotaRemainingJardim <= 0) {
			throw new Error(
				`Sua cota diária de compra de Petalitas (${limitJardim.toLocaleString("pt-BR")} Ptl/dia) já foi esgotada hoje. Volte amanhã às 04:00 AM!`
			);
		}

		const rates = await this.getRates();
		let runasAmount;
		const isAll = String(runasInput).trim().toLowerCase() === "tudo";
		if (isAll) {
			if (account.runas <= 0) {
				throw new Error("Você não possui Runas suficientes para realizar compras.");
			}
			const maxRawCoins = quotaRemainingJardim / 0.97;
			const maxRunasForQuota = maxRawCoins * rates.runasPerJardimCoin;
			runasAmount = Number(Math.min(account.runas, maxRunasForQuota).toFixed(2));
			if (runasAmount <= 0) {
				throw new Error("Sua cota diária de compra de Petalitas já foi esgotada hoje.");
			}
		} else {
			runasAmount = Number(parseBankAmount(runasInput).toFixed(2));
			if (isNaN(runasAmount) || runasAmount <= 0) {
				throw new Error("Informe uma quantidade válida de Runas para comprar Petalitas.");
			}
			if (account.runas < runasAmount) {
				throw new Error(
					`Saldo insuficiente de Runas! Você possui ${account.runas.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ᚱ.`
				);
			}
		}

		const rawCoins = runasAmount / rates.runasPerJardimCoin;
		const spreadRate = this.calculateSpread(quota.used.compra_jardim, rawCoins, limitJardim);
		let netCoins = Math.floor(rawCoins * (1 - spreadRate));
		const spreadFeeRunas = Number((runasAmount * spreadRate).toFixed(2));

		if (netCoins > quotaRemainingJardim) {
			if (isAll) {
				netCoins = quotaRemainingJardim;
			} else {
				throw new Error(
					`Essa operação excede sua cota diária de Petalitas (${quotaRemainingJardim.toLocaleString("pt-BR")} Ptl restantes hoje de ${limitJardim.toLocaleString("pt-BR")} Ptl).`
				);
			}
		}

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
			`INSERT INTO bank_daily_quotas (user_id, date, fish_kg_used, zinthos_used, jardim_coins_used, runas_compra_used, runas_venda_used, zinthos_compra_used, jardim_compra_used)
			VALUES (?, ?, 0, 0, 0, ?, 0, 0, ?)
			ON CONFLICT(user_id, date) DO UPDATE SET 
				runas_compra_used = runas_compra_used + excluded.runas_compra_used,
				jardim_compra_used = jardim_compra_used + excluded.jardim_compra_used`,
			[cleanUser, today, runasAmount, netCoins]
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
			quotaRemaining: Math.max(0, quotaRemainingJardim - netCoins)
		};
	}

	/**
	 * Bloqueio de saque de peixe (Regra de Negócio: Mão única)
	 */
	withdrawFish() {
		throw new Error(
			"Não é permitido comprar peixes com Runas. Peixes só podem ser vendidos para o banco."
		);
	}

	/**
	 * Compra moedinhas para o Caça-coisas (SlotsGame) usando Runas do RavenaBank.
	 * Regra: 55 Runas por moeda.
	 * Limite: máx 300 moedas compradas por dia.
	 * @param {string} userId
	 * @param {number|string} countInput
	 * @returns {Promise<Object>}
	 */
	async buySlotsCoins(userId, countInput) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const count = parseInt(countInput, 10);
		if (isNaN(count) || count <= 0) {
			throw new Error(
				"Quantidade inválida de moedinhas para compra. Informe um número inteiro positivo."
			);
		}

		const quota = await this.getDailyQuota(cleanUser);
		const remainingQuota = quota.remaining.compra_moedas;

		if (count > remainingQuota) {
			throw new Error(
				`Limite diário de compra atingido! Você já comprou ${quota.used.compra_moedas} moedas hoje de um limite de ${DAILY_LIMITS.compra_moedas} moedas/dia. ` +
					(remainingQuota > 0
						? `Você pode comprar no máximo mais ${remainingQuota} moedinha(s) hoje.`
						: "Você já atingiu sua cota diária de compra de moedinhas.")
			);
		}

		const totalCost = count * STORE_PRICES.moeda;
		const account = await this.getAccount(cleanUser);

		if (account.runas < totalCost) {
			throw new Error(
				`Saldo insuficiente de Runas! Você precisa de ${totalCost.toLocaleString("pt-BR")} ᚱ para comprar ${count} moedinha(s), mas possui apenas ${account.runas.toLocaleString("pt-BR")} ᚱ.`
			);
		}

		const now = Date.now();
		const today = this.getTodayDateString();

		// 1. Debita Runas da conta
		await database.dbRun(
			dbName,
			`UPDATE bank_accounts SET 
				runas = runas - ?, 
				total_withdrawn_runas = total_withdrawn_runas + ?, 
				updated_at = ? 
			WHERE user_id = ?`,
			[totalCost, totalCost, now, cleanUser]
		);

		// 2. Atualiza cota diária
		await database.dbRun(
			dbName,
			`INSERT INTO bank_daily_quotas (user_id, date, moedas_compra_used)
			VALUES (?, ?, ?)
			ON CONFLICT(user_id, date) DO UPDATE SET 
				moedas_compra_used = moedas_compra_used + excluded.moedas_compra_used`,
			[cleanUser, today, count]
		);

		// 3. Registra transação
		await database.dbRun(
			dbName,
			`INSERT INTO bank_transactions 
			(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp)
			VALUES (?, 'STORE_BUY', 'slots', ?, ?, 0, 0, ?, ?)`,
			[
				cleanUser,
				count,
				totalCost,
				JSON.stringify({ item: "moedas", count, costPerUnit: STORE_PRICES.moeda, totalCost }),
				now
			]
		);

		// 4. Credita moedas no SlotsGame
		const SlotsGame = require("../functions/SlotsGame");
		await SlotsGame.addCoins(cleanUser, count, true);
		const newCoins = await SlotsGame.getUserCoins(cleanUser);
		const updatedAccount = await this.getAccount(cleanUser);

		return {
			item: "moedas",
			count,
			costRunas: totalCost,
			currentCoins: newCoins,
			dailyLimit: DAILY_LIMITS.compra_moedas,
			remainingDaily: Math.max(0, remainingQuota - count),
			newBalance: updatedAccount.runas
		};
	}

	/**
	 * Compra iscas para o Jogo de Pesca usando Runas do RavenaBank.
	 * Regra: 45 Runas por isca.
	 * Limite: máx 200 iscas compradas por dia.
	 * @param {string} userId
	 * @param {number|string} countInput
	 * @returns {Promise<Object>}
	 */
	async buyFishingBaits(userId, countInput) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const count = parseInt(countInput, 10);
		if (isNaN(count) || count <= 0) {
			throw new Error(
				"Quantidade inválida de iscas para compra. Informe um número inteiro positivo."
			);
		}

		const quota = await this.getDailyQuota(cleanUser);
		const remainingQuota = quota.remaining.compra_iscas;

		if (count > remainingQuota) {
			throw new Error(
				`Limite diário de compra atingido! Você já comprou ${quota.used.compra_iscas} iscas hoje de um limite de ${DAILY_LIMITS.compra_iscas} iscas/dia. ` +
					(remainingQuota > 0
						? `Você pode comprar no máximo mais ${remainingQuota} isca(s) hoje.`
						: "Você já atingiu sua cota diária de compra de iscas.")
			);
		}

		const totalCost = count * STORE_PRICES.isca;
		const account = await this.getAccount(cleanUser);

		if (account.runas < totalCost) {
			throw new Error(
				`Saldo insuficiente de Runas! Você precisa de ${totalCost.toLocaleString("pt-BR")} ᚱ para comprar ${count} isca(s), mas possui apenas ${account.runas.toLocaleString("pt-BR")} ᚱ.`
			);
		}

		const now = Date.now();
		const today = this.getTodayDateString();

		// 1. Debita Runas da conta
		await database.dbRun(
			dbName,
			`UPDATE bank_accounts SET 
				runas = runas - ?, 
				total_withdrawn_runas = total_withdrawn_runas + ?, 
				updated_at = ? 
			WHERE user_id = ?`,
			[totalCost, totalCost, now, cleanUser]
		);

		// 2. Atualiza cota diária
		await database.dbRun(
			dbName,
			`INSERT INTO bank_daily_quotas (user_id, date, iscas_compra_used)
			VALUES (?, ?, ?)
			ON CONFLICT(user_id, date) DO UPDATE SET 
				iscas_compra_used = iscas_compra_used + excluded.iscas_compra_used`,
			[cleanUser, today, count]
		);

		// 3. Registra transação
		await database.dbRun(
			dbName,
			`INSERT INTO bank_transactions 
			(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp)
			VALUES (?, 'STORE_BUY', 'fishing', ?, ?, 0, 0, ?, ?)`,
			[
				cleanUser,
				count,
				totalCost,
				JSON.stringify({ item: "iscas", count, costPerUnit: STORE_PRICES.isca, totalCost }),
				now
			]
		);

		// 4. Credita iscas no FishingGame
		const FishingGame = require("../functions/FishingGame");
		await FishingGame.addBaits(cleanUser, count);
		const updatedBaitInfo = await FishingGame.getUserBaitsInfo(cleanUser);
		const updatedAccount = await this.getAccount(cleanUser);

		return {
			item: "iscas",
			count,
			costRunas: totalCost,
			currentBaits: updatedBaitInfo.baits,
			dailyLimit: DAILY_LIMITS.compra_iscas,
			remainingDaily: Math.max(0, remainingQuota - count),
			newBalance: updatedAccount.runas
		};
	}

	/**
	 * Retorna o catálogo da Loja do RavenaBank com preços, limites e status do usuário
	 * @param {string} userId
	 * @returns {Promise<Object>}
	 */
	async getStoreCatalog(userId) {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const SlotsGame = require("../functions/SlotsGame");
		const FishingGame = require("../functions/FishingGame");

		const [account, quota, slotsCoins, baitInfo] = await Promise.all([
			this.getAccount(cleanUser),
			this.getDailyQuota(cleanUser),
			SlotsGame.getUserCoins(cleanUser),
			FishingGame.getUserBaitsInfo(cleanUser)
		]);

		return {
			userRunas: account.runas,
			items: [
				{
					id: "moedas",
					name: "Moedinhas (Slots)",
					emoji: "🎰",
					priceRunas: STORE_PRICES.moeda,
					current: slotsCoins,
					dailyLimit: DAILY_LIMITS.compra_moedas,
					dailyUsed: quota.used.compra_moedas,
					maxCanBuy: quota.remaining.compra_moedas,
					description: "Fichas para rodar no !slots (Caça-coisas)"
				},
				{
					id: "iscas",
					name: "Iscas (Pesca)",
					emoji: "🐛",
					priceRunas: STORE_PRICES.isca,
					current: baitInfo.baits,
					dailyLimit: DAILY_LIMITS.compra_iscas,
					dailyUsed: quota.used.compra_iscas,
					maxCanBuy: quota.remaining.compra_iscas,
					description: "Iscas para pescar peixes e itens no !pescar"
				}
			]
		};
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
				inflationPercent: rates.waifuInflationPercent || inflationPercent
			},
			jardim: {
				totalCoins: totalJardimCoins,
				inflationPercent: rates.jardimInflationPercent || 0
			},
			rules: {
				dailyLimits: {
					...DAILY_LIMITS,
					compra_zinthos: rates.quotaCompraZinthos || DAILY_LIMITS.compra_zinthos,
					compra_jardim: rates.quotaCompraJardim || DAILY_LIMITS.compra_jardim
				},
				spreadRange: "3% a 10% (progressivo por cota diária)",
				rotationTime: "04:00 AM (Horário de Brasília)",
				circuitBreaker: "+-10% max variação diária de cotações",
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

	/**
	 * Mapeia apelidos dos usuários priorizando estritamente:
	 * 1. Apelido global (core.db -> global_nicks)
	 * 2. Primeiro apelido de grupo encontrado (core.db -> groups.nicks)
	 * 3. Fallback: pushName da memória/ranking ou número puro
	 *
	 * @param {Array<string>} [userIds] - Lista opcional de user_ids para resolução com fallback
	 * @returns {Promise<Map<string, string>>} Mapa de rawUserId -> nickname
	 */
	async getUserNicknamesMap(userIds = null) {
		const nickMap = new Map();

		try {
			// 1. Carrega apelidos globais
			const globalNicks = await database.getAllGlobalNicks();
			if (globalNicks && typeof globalNicks === "object") {
				for (const [uid, nick] of Object.entries(globalNicks)) {
					if (nick && String(nick).trim()) {
						const clean = String(uid).replace(/\D/g, "") || String(uid);
						nickMap.set(clean, String(nick).trim());
					}
				}
			}

			// 2. Carrega apelidos de grupos (apenas para quem ainda não tem apelido global definido)
			const groupRows = await database.dbAll(
				"core",
				"SELECT nicks FROM groups WHERE nicks IS NOT NULL AND nicks != '[]' AND nicks != ''"
			);

			for (const row of groupRows || []) {
				try {
					const arr = typeof row.nicks === "string" ? JSON.parse(row.nicks) : row.nicks;
					if (Array.isArray(arr)) {
						for (const n of arr) {
							if (n && n.numero && n.apelido && String(n.apelido).trim()) {
								const clean = String(n.numero).replace(/\D/g, "") || String(n.numero);
								if (clean && !nickMap.has(clean)) {
									nickMap.set(clean, String(n.apelido).trim());
								}
							}
						}
					}
				} catch (_) {}
			}

			// 3. Se userIds foi especificado, para os que ainda não têm apelido, busca fallback de pushName
			if (Array.isArray(userIds) && userIds.length > 0) {
				const missingUsers = userIds.filter((uid) => {
					const clean = String(uid).replace(/\D/g, "") || String(uid);
					return !nickMap.has(clean);
				});

				if (missingUsers.length > 0) {
					for (const uid of missingUsers) {
						const clean = String(uid).replace(/\D/g, "") || String(uid);
						try {
							const memRow = await database.dbGet(
								"memory",
								"SELECT display_name FROM memory_identities WHERE platform_id LIKE ? OR canonical_user_id = ? LIMIT 1",
								[`${clean}%`, `wa_${clean}`]
							);
							if (memRow?.display_name && String(memRow.display_name).trim()) {
								nickMap.set(clean, String(memRow.display_name).trim());
								continue;
							}
							const rankRow = await database.dbGet(
								"msgranking",
								"SELECT user_name FROM ranking WHERE user_id = ? LIMIT 1",
								[clean]
							);
							if (rankRow?.user_name && String(rankRow.user_name).trim()) {
								nickMap.set(clean, String(rankRow.user_name).trim());
							}
						} catch (_) {}
					}
				}
			}
		} catch (err) {
			logger.error(`[getUserNicknamesMap] Erro ao mapear apelidos: ${err.message}`);
		}

		return nickMap;
	}

	/**
	 * Listagem paginada e busca de usuários para o painel administrativo do RavenaBank.
	 * O nome exibido é estritamente o apelido do usuário (global ou 1º de grupo, com fallback de pushName).
	 */
	async adminGetUsers({ query = "", page = 1, limit = 20, sort = "runas_desc" } = {}) {
		const safePage = Math.max(1, parseInt(page, 10) || 1);
		const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
		const offset = (safePage - 1) * safeLimit;
		const cleanQ = String(query || "")
			.trim()
			.toLowerCase();

		// Mapeador de apelidos
		const nicknamesMap = await this.getUserNicknamesMap();

		let accounts = [];
		let total = 0;

		if (!cleanQ) {
			// Sem busca: paginação padrão por saldo de Runas decrescente
			const countRow = await database.dbGet(dbName, "SELECT COUNT(*) as total FROM bank_accounts");
			total = countRow?.total || 0;

			let orderSql = "runas DESC";
			if (sort === "runas_asc") orderSql = "runas ASC";
			else if (sort === "id_asc") orderSql = "user_id ASC";
			else if (sort === "updated_desc") orderSql = "updated_at DESC";

			accounts = await database.dbAll(
				dbName,
				`SELECT user_id, runas, total_deposited_runas, total_withdrawn_runas, updated_at
				 FROM bank_accounts
				 ORDER BY ${orderSql}
				 LIMIT ? OFFSET ?`,
				[safeLimit, offset]
			);
		} else {
			// Com busca: verifica se busca por número ou por apelido
			const cleanDigits = cleanQ.replace(/\D/g, "");

			// Identifica IDs cujos apelidos casam com a busca
			const matchingUserIdsFromNicknames = new Set();
			for (const [uid, nick] of nicknamesMap.entries()) {
				if (nick.toLowerCase().includes(cleanQ)) {
					matchingUserIdsFromNicknames.add(uid);
				}
			}

			// Busca também em pushNames da memória para ampliar cobertura
			try {
				const memMatches = await database.dbAll(
					"memory",
					"SELECT platform_id, display_name FROM memory_identities WHERE display_name LIKE ? GROUP BY platform_id LIMIT 50",
					[`%${cleanQ}%`]
				);
				for (const m of memMatches || []) {
					const clean = String(m.platform_id).replace(/\D/g, "");
					if (clean) matchingUserIdsFromNicknames.add(clean);
				}
			} catch (_) {}

			// Constrói lista de IDs candidatos
			const candidateIds = Array.from(matchingUserIdsFromNicknames);

			const whereClauses = [];
			const params = [];

			if (cleanDigits.length >= 2) {
				whereClauses.push("user_id LIKE ?");
				params.push(`%${cleanDigits}%`);
			}

			if (candidateIds.length > 0) {
				// Chunk para não estourar placeholders
				const placeholders = candidateIds.map(() => "?").join(",");
				whereClauses.push(`user_id IN (${placeholders})`);
				params.push(...candidateIds);
			}

			if (whereClauses.length === 0) {
				whereClauses.push("user_id LIKE ?");
				params.push(`%${cleanQ}%`);
			}

			const whereSql = whereClauses.join(" OR ");

			const countRow = await database.dbGet(
				dbName,
				`SELECT COUNT(*) as total FROM bank_accounts WHERE ${whereSql}`,
				params
			);
			total = countRow?.total || 0;

			accounts = await database.dbAll(
				dbName,
				`SELECT user_id, runas, total_deposited_runas, total_withdrawn_runas, updated_at
				 FROM bank_accounts
				 WHERE ${whereSql}
				 ORDER BY runas DESC
				 LIMIT ? OFFSET ?`,
				[...params, safeLimit, offset]
			);

			// Se a busca por apelido encontrou usuários que AINDA NÃO têm conta bancária aberta, inclui-os na lista com 0 Runas
			if (accounts.length < safeLimit && candidateIds.length > 0) {
				const existingAccountIds = new Set(accounts.map((a) => a.user_id));
				const missingCandidateIds = candidateIds.filter((cid) => !existingAccountIds.has(cid));

				for (const cid of missingCandidateIds) {
					if (accounts.length >= safeLimit) break;
					accounts.push({
						user_id: cid,
						runas: 0,
						total_deposited_runas: 0,
						total_withdrawn_runas: 0,
						updated_at: null
					});
					total++;
				}
			}
		}

		// Resolve os apelidos para a lista atual
		const currentIds = accounts.map((a) => a.user_id);
		const fullNickMap = await this.getUserNicknamesMap(currentIds);

		const formattedUsers = accounts.map((acc) => {
			const clean = String(acc.user_id).replace(/\D/g, "") || String(acc.user_id);
			const nick = fullNickMap.get(clean) || fullNickMap.get(acc.user_id) || "Sem apelido";

			return {
				userId: acc.user_id,
				name: nick,
				runas: Number(acc.runas || 0),
				totalDeposited: Number(acc.total_deposited_runas || 0),
				totalWithdrawn: Number(acc.total_withdrawn_runas || 0),
				updatedAt: acc.updated_at
			};
		});

		return {
			users: formattedUsers,
			total,
			page: safePage,
			limit: safeLimit,
			totalPages: Math.ceil(total / safeLimit) || 1
		};
	}

	/**
	 * Ajusta administrativamente o saldo de Runas de um usuário e registra transação de auditoria contábil.
	 * @param {string} userId
	 * @param {number|string} newAmount
	 * @param {string} [adminUser]
	 * @returns {Promise<Object>}
	 */
	async adminSetUserRunas(userId, newAmount, adminUser = "admin") {
		const cleanUser = String(userId).replace(/\D/g, "") || String(userId);
		const parsedRunas = parseFloat(newAmount);
		if (isNaN(parsedRunas) || parsedRunas < 0) {
			throw new Error("Saldo de Runas inválido. Deve ser um número maior ou igual a zero.");
		}

		const targetRunas = Math.round(parsedRunas * 100) / 100;
		const account = await this.getAccount(cleanUser);
		const previousRunas = Number(account?.runas || 0);
		const diff = Math.round((targetRunas - previousRunas) * 100) / 100;
		const now = Date.now();

		await database.dbRun(
			dbName,
			`INSERT INTO bank_accounts (user_id, runas, total_deposited_runas, total_withdrawn_runas, created_at, updated_at)
			 VALUES (?, ?, 0, 0, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET 
				runas = excluded.runas,
				updated_at = excluded.updated_at`,
			[cleanUser, targetRunas, now, now]
		);

		await database.dbRun(
			dbName,
			`INSERT INTO bank_transactions 
			(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp)
			VALUES (?, 'ADMIN_ADJUST', 'admin', 0, ?, 0, 0, ?, ?)`,
			[
				cleanUser,
				diff,
				JSON.stringify({
					previousRunas,
					newRunas: targetRunas,
					difference: diff,
					adminUser
				}),
				now
			]
		);

		logger.info(
			`[RavenaBank Admin] Saldo de Runas do usuário ${cleanUser} alterado por ${adminUser}: ${previousRunas} -> ${targetRunas} (dif: ${diff})`
		);

		return await this.getAccount(cleanUser);
	}

	/**
	 * Retorna as configurações econômicas consolidadas e métricas de auditoria para o painel de admin.
	 */
	async adminGetConfigAndStats() {
		const macro = await this.getMacroEconomics();

		// Estatísticas de transações e taxas destruídas
		const txStats = await database.dbGet(
			dbName,
			"SELECT COUNT(*) as totalTransactions, SUM(spread_fee_runas) as totalBurnedRunas FROM bank_transactions"
		);

		const totalTransactions = Number(txStats?.totalTransactions || 0);
		const totalBurnedRunas = Number(txStats?.totalBurnedRunas || 0);

		// Contagem de contas
		const countRow = await database.dbGet(
			dbName,
			"SELECT COUNT(*) as totalAccounts, SUM(runas) as totalRunas FROM bank_accounts"
		);

		return {
			...macro,
			totalTransactions,
			totalBurnedRunas,
			totalAccounts: Number(countRow?.totalAccounts || 0),
			totalRunas: Number(countRow?.totalRunas || 0),
			storePrices: this.STORE_PRICES,
			storeLimits: this.STORE_LIMITS
		};
	}

	/**
	 * Desfaz uma transação financeira de compra ou venda (Segunda Chance ou Ação Administrativa).
	 * Regra de Spread: 5% de taxa cobrada/retida sobre o valor da transação.
	 * Regra de Tempo: 5 minutos para usuários comuns; sem limite de tempo para administradores.
	 *
	 * @param {number|string} transactionId
	 * @param {Object} [options]
	 * @param {string} [options.userId] - Usuário solicitante (se chamado por usuário)
	 * @param {boolean} [options.isAdmin=false] - Se true, ignora janela de 5 min e autoriza customFinalRunas
	 * @param {number} [options.customFinalRunas] - Valor final em Runas digitado pelo admin
	 * @param {string} [options.adminUser="admin"] - Identificador do admin
	 */
	async undoTransaction(transactionId, options = {}) {
		const {
			userId = null,
			isAdmin = false,
			customFinalRunas = undefined,
			adminUser = "admin"
		} = options;

		const txId = parseInt(transactionId, 10);
		if (isNaN(txId) || txId <= 0) {
			throw new Error("ID de transação inválido.");
		}

		const tx = await database.dbGet(dbName, "SELECT * FROM bank_transactions WHERE id = ?", [txId]);

		if (!tx) {
			throw new Error(`Transação #${txId} não encontrada.`);
		}

		const cleanUser = String(tx.user_id).replace(/\D/g, "") || String(tx.user_id);
		if (!isAdmin && userId) {
			const cleanReqUser = String(userId).replace(/\D/g, "") || String(userId);
			if (cleanUser !== cleanReqUser) {
				throw new Error("Você não possui permissão para desfazer esta transação.");
			}
		}

		if (tx.status === "UNDONE") {
			throw new Error(`A transação #${txId} já foi desfeita anteriormente.`);
		}

		// Se for usuário comum, valida tolerância de 5 minutos
		if (!isAdmin) {
			const ageMs = Date.now() - Number(tx.timestamp);
			const FIVE_MINUTES_MS = 5 * 60 * 1000;
			if (ageMs > FIVE_MINUTES_MS) {
				throw new Error("O prazo de 5 minutos para desfazer esta transação expirou.");
			}
		}

		const reversibleTypes = ["DEPOSIT", "WITHDRAW", "STORE_BUY"];
		if (!reversibleTypes.includes(tx.type)) {
			throw new Error(`Transações do tipo '${tx.type}' não podem ser desfeitas.`);
		}

		// Cálculo da taxa de spread de 5%
		const SPREAD_FEE_RATE = 0.05;
		const spreadFeeRunas = Number((Number(tx.runas_amount) * SPREAD_FEE_RATE).toFixed(2));

		let finalRunas;
		if (
			isAdmin &&
			customFinalRunas !== undefined &&
			customFinalRunas !== null &&
			!isNaN(Number(customFinalRunas))
		) {
			finalRunas = Number(Math.max(0, Number(customFinalRunas)).toFixed(2));
		} else {
			if (tx.type === "DEPOSIT") {
				// Venda original: usuário recebeu tx.runas_amount.
				// Para desfazer, devolve as Runas recebidas + paga 5% de taxa spread.
				finalRunas = Number((Number(tx.runas_amount) + spreadFeeRunas).toFixed(2));
			} else {
				// Compra original: usuário gastou tx.runas_amount.
				// Para desfazer, recebe as Runas de volta com retenção de 5% de spread.
				finalRunas = Number(Math.max(0, Number(tx.runas_amount) - spreadFeeRunas).toFixed(2));
			}
		}

		const account = await this.getAccount(cleanUser);

		// Se for débito de Runas (Venda original sendo revertida), valida saldo em conta
		if (tx.type === "DEPOSIT") {
			if (account.runas < finalRunas) {
				throw new Error(
					`Saldo insuficiente de Runas para desfazer esta transação. Você precisa de ${finalRunas.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} ᚱ, mas possui apenas ${account.runas.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} ᚱ.`
				);
			}
		}

		const now = Date.now();
		const g = String(tx.game).toLowerCase().trim();

		// 1. Reversão dos ativos nos respectivos jogos
		if (g === "waifu" || g === "zinthos" || g === "waifus") {
			const amount = Math.floor(tx.game_amount);
			if (tx.type === "DEPOSIT") {
				// Devolve Zinthos ao usuário
				try {
					await waifuApi.post("/admin/kakera/give", {
						userId: cleanUser,
						amount,
						reason: "ADMIN_GRANT",
						metadata: { reason: "bank_undo_deposit_zinthos", txId }
					});
				} catch (err) {
					throw new Error(`Falha ao devolver Zinthos no Waifuletes: ${err.message}`);
				}
			} else if (tx.type === "WITHDRAW") {
				// Retira Zinthos comprados
				let curZ = 0;
				try {
					const { data } = await waifuApi.get(`/kakera/${cleanUser}`);
					curZ = data?.data?.balance ?? data?.data?.kakera ?? 0;
				} catch (_) {}
				if (curZ < amount) {
					throw new Error(
						`Saldo insuficiente de Zinthos no Waifuletes para devolução. O usuário possui ${curZ.toLocaleString("pt-BR")} Z, mas a compra foi de ${amount.toLocaleString("pt-BR")} Z.`
					);
				}
				try {
					await waifuApi.post("/admin/kakera/take", {
						userId: cleanUser,
						amount,
						metadata: { reason: "bank_undo_withdraw_zinthos", txId }
					});
				} catch (err) {
					throw new Error(`Falha ao retirar Zinthos no Waifuletes: ${err.message}`);
				}
			}
		} else if (g === "jardim" || g === "fazenda" || g === "petalita" || g === "petalitas") {
			const amount = Math.floor(tx.game_amount);
			if (tx.type === "DEPOSIT") {
				// Devolve Petalitas
				try {
					await jardimClient.adminGive(cleanUser, {
						coins: amount,
						reason: "bank_undo_deposit_jardim"
					});
				} catch (err) {
					throw new Error(`Falha ao devolver Petalitas no Jardim: ${err.message}`);
				}
			} else if (tx.type === "WITHDRAW") {
				// Retira Petalitas compradas
				let curCoins = 0;
				try {
					const status = await jardimClient.getStatus(cleanUser);
					curCoins = status?.coins || 0;
				} catch (_) {}
				if (curCoins < amount) {
					throw new Error(
						`Saldo insuficiente de Petalitas na Fazenda para devolução. O usuário possui ${curCoins.toLocaleString("pt-BR")} Ptl, mas a compra foi de ${amount.toLocaleString("pt-BR")} Ptl.`
					);
				}
				try {
					await jardimClient.adminGive(cleanUser, {
						coins: -amount,
						reason: "bank_undo_withdraw_jardim"
					});
				} catch (err) {
					throw new Error(`Falha ao retirar Petalitas no Jardim: ${err.message}`);
				}
			}
		} else if (g === "slots" || g === "moedas" || g === "moeda") {
			const count = Math.floor(tx.game_amount);
			const SlotsGame = require("../functions/SlotsGame");
			const curCoins = await SlotsGame.getUserCoins(cleanUser);
			if (curCoins < count) {
				throw new Error(
					`Saldo insuficiente de moedas nos Slots para devolução. O usuário possui ${curCoins} moedas, mas a compra foi de ${count} moedas.`
				);
			}
			await SlotsGame.addCoins(cleanUser, -count, true);
		} else if (g === "fishing" || g === "iscas" || g === "isca") {
			const count = Math.floor(tx.game_amount);
			const FishingGame = require("../functions/FishingGame");
			const baitInfo = await FishingGame.getUserBaitsInfo(cleanUser);
			if (baitInfo.baits < count) {
				throw new Error(
					`Saldo insuficiente de iscas de pesca para devolução. O usuário possui ${baitInfo.baits} iscas, mas a compra foi de ${count} iscas.`
				);
			}
			await FishingGame.addBaits(cleanUser, -count);
		} else if (g === "pesca" || g === "peixe" || g === "peixes") {
			// Venda de peixes -> devolve peso ao inventário
			await database.dbRun(
				"fishing",
				"UPDATE fishing_users SET inventory_weight = inventory_weight + ? WHERE user_id = ? OR user_id = ?",
				[tx.game_amount, cleanUser, cleanUser]
			);
		}

		// 2. Ajuste de Runas na conta do RavenaBank
		if (tx.type === "DEPOSIT") {
			// Debita Runas da conta
			await database.dbRun(
				dbName,
				`UPDATE bank_accounts SET 
					runas = runas - ?, 
					total_deposited_runas = MAX(0, total_deposited_runas - ?), 
					updated_at = ? 
				WHERE user_id = ?`,
				[finalRunas, tx.runas_amount, now, cleanUser]
			);
		} else {
			// Credita Runas de volta
			await database.dbRun(
				dbName,
				`UPDATE bank_accounts SET 
					runas = runas + ?, 
					total_withdrawn_runas = MAX(0, total_withdrawn_runas - ?), 
					updated_at = ? 
				WHERE user_id = ?`,
				[finalRunas, tx.runas_amount, now, cleanUser]
			);
		}

		// 3. Estorno de cota diária se a transação ocorreu hoje
		const txDateStr = new Date(tx.timestamp).toLocaleDateString("pt-BR", {
			timeZone: "America/Sao_Paulo"
		});
		const todayStr = new Date().toLocaleDateString("pt-BR", {
			timeZone: "America/Sao_Paulo"
		});

		if (txDateStr === todayStr) {
			const todayDb = this.getTodayDateString();
			if (tx.type === "DEPOSIT") {
				if (g === "waifu" || g === "zinthos" || g === "waifus") {
					await database.dbRun(
						dbName,
						`UPDATE bank_daily_quotas SET 
							runas_venda_used = MAX(0, runas_venda_used - ?),
							zinthos_used = MAX(0, zinthos_used - ?)
						WHERE user_id = ? AND date = ?`,
						[tx.runas_amount, tx.game_amount, cleanUser, todayDb]
					);
				} else if (g === "jardim" || g === "fazenda" || g === "petalita" || g === "petalitas") {
					await database.dbRun(
						dbName,
						`UPDATE bank_daily_quotas SET 
							runas_venda_used = MAX(0, runas_venda_used - ?),
							jardim_coins_used = MAX(0, jardim_coins_used - ?)
						WHERE user_id = ? AND date = ?`,
						[tx.runas_amount, tx.game_amount, cleanUser, todayDb]
					);
				} else if (g === "pesca" || g === "peixe" || g === "peixes") {
					await database.dbRun(
						dbName,
						`UPDATE bank_daily_quotas SET 
							runas_venda_used = MAX(0, runas_venda_used - ?),
							fish_kg_used = MAX(0, fish_kg_used - ?)
						WHERE user_id = ? AND date = ?`,
						[tx.runas_amount, tx.game_amount, cleanUser, todayDb]
					);
				}
			} else if (tx.type === "WITHDRAW") {
				if (g === "waifu" || g === "zinthos" || g === "waifus") {
					await database.dbRun(
						dbName,
						`UPDATE bank_daily_quotas SET 
							runas_compra_used = MAX(0, runas_compra_used - ?),
							zinthos_compra_used = MAX(0, zinthos_compra_used - ?)
						WHERE user_id = ? AND date = ?`,
						[tx.runas_amount, tx.game_amount, cleanUser, todayDb]
					);
				} else if (g === "jardim" || g === "fazenda" || g === "petalita" || g === "petalitas") {
					await database.dbRun(
						dbName,
						`UPDATE bank_daily_quotas SET 
							runas_compra_used = MAX(0, runas_compra_used - ?),
							jardim_compra_used = MAX(0, jardim_compra_used - ?)
						WHERE user_id = ? AND date = ?`,
						[tx.runas_amount, tx.game_amount, cleanUser, todayDb]
					);
				}
			} else if (tx.type === "STORE_BUY") {
				if (g === "slots" || g === "moedas" || g === "moeda") {
					await database.dbRun(
						dbName,
						`UPDATE bank_daily_quotas SET moedas_compra_used = MAX(0, moedas_compra_used - ?) WHERE user_id = ? AND date = ?`,
						[tx.game_amount, cleanUser, todayDb]
					);
				} else if (g === "fishing" || g === "iscas" || g === "isca") {
					await database.dbRun(
						dbName,
						`UPDATE bank_daily_quotas SET iscas_compra_used = MAX(0, iscas_compra_used - ?) WHERE user_id = ? AND date = ?`,
						[tx.game_amount, cleanUser, todayDb]
					);
				}
			}
		}

		// 4. Marca a transação original como desfeita
		const undoneBy = isAdmin ? `admin:${adminUser}` : `user:${cleanUser}`;
		await database.dbRun(
			dbName,
			`UPDATE bank_transactions SET 
				status = 'UNDONE', 
				undone_at = ?, 
				undone_by = ?, 
				undo_fee_runas = ?, 
				undo_final_runas = ? 
			WHERE id = ?`,
			[now, undoneBy, spreadFeeRunas, finalRunas, txId]
		);

		// 5. Registra transação de auditoria
		await database.dbRun(
			dbName,
			`INSERT INTO bank_transactions 
			(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp, status)
			VALUES (?, 'UNDO_TRADE', ?, ?, ?, ?, ?, ?, ?, 'COMPLETED')`,
			[
				cleanUser,
				tx.game,
				tx.game_amount,
				finalRunas,
				SPREAD_FEE_RATE,
				spreadFeeRunas,
				JSON.stringify({
					originalTxId: tx.id,
					originalType: tx.type,
					undoneBy,
					spreadFeeRunas,
					finalRunas,
					timestamp: now
				}),
				now
			]
		);

		logger.info(
			`[RavenaBank] Transação #${txId} (${tx.type} ${tx.game}) desfeita com sucesso por ${undoneBy}. Final Runas: ${finalRunas} (spread fee: ${spreadFeeRunas})`
		);

		const updatedAccount = await this.getAccount(cleanUser);
		return {
			transactionId: txId,
			undone: true,
			undoneBy,
			originalType: tx.type,
			game: tx.game,
			gameAmount: tx.game_amount,
			spreadFeeRunas,
			finalRunas,
			newBalance: updatedAccount.runas
		};
	}

	/**
	 * Transfere Runas entre usuários diretamente (ex: negociações no mercado)
	 * @param {string} fromUserId
	 * @param {string} toUserId
	 * @param {number} amount
	 * @param {string} reason
	 */
	async transferRunas(fromUserId, toUserId, amount, reason = "MARKET_TRANSFER") {
		const runas = Number(amount);
		if (isNaN(runas) || runas <= 0) {
			throw new Error("A quantidade de Runas para transferência deve ser maior que zero.");
		}

		const cleanFrom = String(fromUserId).replace(/\D/g, "") || String(fromUserId);
		const cleanTo = String(toUserId).replace(/\D/g, "") || String(toUserId);

		if (cleanFrom === cleanTo) {
			throw new Error("Não é possível transferir Runas para si mesmo.");
		}

		const fromAccount = await this.getAccount(cleanFrom);
		if (!fromAccount || fromAccount.runas < runas) {
			throw new Error(
				`Saldo insuficiente de Runas. Você possui ${(fromAccount?.runas || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} ᚱ, mas tentou transferir ${runas.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} ᚱ.`
			);
		}

		// Garante que o destinatário tem conta
		await this.getAccount(cleanTo);

		const now = Date.now();

		// Debita com CAS (Compare-And-Swap garantindo runas >= ?)
		const debitRes = await database.dbRun(
			dbName,
			`UPDATE bank_accounts SET 
				runas = runas - ?, 
				total_withdrawn_runas = total_withdrawn_runas + ?, 
				updated_at = ? 
			WHERE (user_id = ? OR user_id = ?) AND runas >= ?`,
			[runas, runas, now, fromUserId, cleanFrom, runas]
		);

		if (!debitRes || debitRes.changes === 0) {
			throw new Error(
				"Falha de concorrência ou saldo insuficiente de Runas no momento da transferência."
			);
		}

		// Credita na conta do destinatário
		await database.dbRun(
			dbName,
			`UPDATE bank_accounts SET 
				runas = runas + ?, 
				total_deposited_runas = total_deposited_runas + ?, 
				updated_at = ? 
			WHERE user_id = ? OR user_id = ?`,
			[runas, runas, now, toUserId, cleanTo]
		);

		// Registra transação de débito e crédito
		try {
			await database.dbRun(
				dbName,
				`INSERT INTO bank_transactions 
				(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp, status)
				VALUES (?, 'TRANSFER_OUT', 'market', ?, ?, 1.0, 0, ?, ?, 'COMPLETED')`,
				[cleanFrom, runas, runas, JSON.stringify({ to: cleanTo, reason }), now]
			);

			await database.dbRun(
				dbName,
				`INSERT INTO bank_transactions 
				(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp, status)
				VALUES (?, 'TRANSFER_IN', 'market', ?, ?, 1.0, 0, ?, ?, 'COMPLETED')`,
				[cleanTo, runas, runas, JSON.stringify({ from: cleanFrom, reason }), now]
			);
		} catch (auditErr) {
			logger.warn(
				`Erro ao registrar log de transação de transferência de Runas: ${auditErr.message}`
			);
		}

		const updatedFrom = await this.getAccount(cleanFrom);
		const updatedTo = await this.getAccount(cleanTo);

		return {
			success: true,
			transferred: runas,
			fromNewBalance: updatedFrom.runas,
			toNewBalance: updatedTo.runas
		};
	}

	/**
	 * Listagem paginada e busca de transações para o painel administrativo do RavenaBank.
	 */
	async adminGetTransactions({
		page = 1,
		limit = 20,
		query = "",
		type = "",
		game = "",
		status = ""
	} = {}) {
		const pageNum = Math.max(1, parseInt(page, 10) || 1);
		const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
		const offset = (pageNum - 1) * limitNum;

		const whereClauses = [];
		const params = [];

		if (query && String(query).trim()) {
			const clean = String(query).trim().replace(/\D/g, "");
			if (clean) {
				whereClauses.push("(user_id LIKE ? OR user_id LIKE ?)");
				params.push(`%${clean}%`, `%${String(query).trim()}%`);
			} else {
				whereClauses.push("user_id LIKE ?");
				params.push(`%${String(query).trim()}%`);
			}
		}

		if (type && String(type).trim() && type !== "ALL") {
			whereClauses.push("type = ?");
			params.push(String(type).trim().toUpperCase());
		}

		if (game && String(game).trim() && game !== "ALL") {
			whereClauses.push("game = ?");
			params.push(String(game).trim().toLowerCase());
		}

		if (status && String(status).trim() && status !== "ALL") {
			if (status.toUpperCase() === "UNDONE") {
				whereClauses.push("status = 'UNDONE'");
			} else if (status.toUpperCase() === "COMPLETED") {
				whereClauses.push("(status IS NULL OR status = 'COMPLETED')");
			}
		}

		const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

		const countRow = await database.dbGet(
			dbName,
			`SELECT COUNT(*) as total FROM bank_transactions ${whereSql}`,
			params
		);
		const total = Number(countRow?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limitNum));

		const rows = await database.dbAll(
			dbName,
			`SELECT * FROM bank_transactions ${whereSql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
			[...params, limitNum, offset]
		);

		// Resolve apelidos globais dos usuários
		const uniqueUserIds = [...new Set((rows || []).map((r) => r.user_id))];
		const nicksMap = {};
		for (const u of uniqueUserIds) {
			try {
				const nick = await database.getGlobalNick(u);
				if (nick) nicksMap[u] = nick;
			} catch (_) {}
		}

		const transactions = (rows || []).map((r) => ({
			...r,
			userName: nicksMap[r.user_id] || null
		}));

		return {
			transactions,
			total,
			page: pageNum,
			limit: limitNum,
			totalPages
		};
	}
}

module.exports = new BankService();
