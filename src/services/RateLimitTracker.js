/**
 * RateLimitTracker.js
 *
 * Serviço de rastreamento e diagnóstico de erros 429 (Too Many Requests),
 * rate-overlimit e timeouts causados por throttling do WhatsApp/Meta.
 *
 * Ativado quando process.env.DEBUG_RATE_LIMIT === "true".
 * Armazena eventos e métricas de volume em SQLite (data/sqlites/rate_limits.db).
 */

const path = require("path");
const fs = require("fs");
const BetterSQLite = require("better-sqlite3");
const Logger = require("../utils/Logger");

// Garante carregamento do .env se ainda não estiver no process.env
if (process.env.DEBUG_RATE_LIMIT === undefined) {
	try {
		require("dotenv").config({ path: path.join(__dirname, "../../.env") });
	} catch (e) {
		// ignora se .env não existir
	}
}

class RateLimitTracker {
	constructor() {
		this.logger = new Logger("rate-limit-tracker");
		this.enabled = process.env.DEBUG_RATE_LIMIT === "true";
		this.db = null;
		this.dbPath = path.join(__dirname, "../../data/sqlites/rate_limits.db");

		if (this.enabled) {
			this._initDb();
		}
	}

	static getInstance() {
		if (!RateLimitTracker.instance) {
			RateLimitTracker.instance = new RateLimitTracker();
		}
		return RateLimitTracker.instance;
	}

	/**
	 * Inicializa o banco SQLite e tabelas necessárias
	 */
	_initDb() {
		try {
			const dir = path.dirname(this.dbPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			this.db = new BetterSQLite(this.dbPath);
			this.db.pragma("journal_mode = WAL");
			this.db.pragma("synchronous = NORMAL");
			this.db.pragma("busy_timeout = 5000");

			this.db.exec(`
				CREATE TABLE IF NOT EXISTS rate_limit_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					timestamp TEXT NOT NULL,
					timestamp_ms INTEGER NOT NULL,
					bot_name TEXT NOT NULL,
					method TEXT NOT NULL,
					endpoint TEXT NOT NULL,
					status_code INTEGER,
					error_type TEXT NOT NULL,
					error_message TEXT,
					request_data TEXT,
					caller_function TEXT,
					caller_file TEXT,
					call_chain TEXT,
					full_stack TEXT,
					duration_ms INTEGER
				);

				CREATE INDEX IF NOT EXISTS idx_rle_time ON rate_limit_events(timestamp_ms);
				CREATE INDEX IF NOT EXISTS idx_rle_endpoint ON rate_limit_events(endpoint);
				CREATE INDEX IF NOT EXISTS idx_rle_bot ON rate_limit_events(bot_name);
				CREATE INDEX IF NOT EXISTS idx_rle_caller ON rate_limit_events(caller_file);

				CREATE TABLE IF NOT EXISTS request_metrics (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					minute_bucket TEXT NOT NULL,
					bot_name TEXT NOT NULL,
					method TEXT NOT NULL,
					endpoint TEXT NOT NULL,
					total_requests INTEGER DEFAULT 1,
					rate_limit_hits INTEGER DEFAULT 0,
					UNIQUE(minute_bucket, bot_name, method, endpoint)
				);

				CREATE INDEX IF NOT EXISTS idx_rm_bucket ON request_metrics(minute_bucket);
			`);

			// Limpeza automática de dados antigos (> 14 dias) na inicialização
			this.cleanupOldData(14);
		} catch (err) {
			this.logger.error("Erro ao inicializar banco de rate limits:", err);
			this.db = null;
		}
	}

	/**
	 * Verifica se o tracking está ativo
	 */
	isEnabled() {
		return this.enabled && this.db !== null;
	}

	/**
	 * Inicia o contexto de uma requisição para mensurar tempo e capturar stack trace
	 * @param {string} botName
	 * @param {string} method
	 * @param {string} endpoint
	 * @param {object} reqData
	 * @returns {object|null}
	 */
	startRequest(botName, method, endpoint, reqData = {}) {
		if (!this.isEnabled()) return null;

		return {
			botName: botName || "unknown",
			method: method || "GET",
			endpoint: endpoint || "/",
			reqData,
			startTime: Date.now(),
			rawStack: new Error().stack
		};
	}

	/**
	 * Registra o sucesso de uma requisição para contabilidade de volume
	 * @param {object} context
	 */
	recordSuccess(context) {
		if (!this.isEnabled() || !context) return;

		try {
			const minuteBucket = new Date().toISOString().substring(0, 16);
			const stmt = this.db.prepare(`
				INSERT INTO request_metrics (minute_bucket, bot_name, method, endpoint, total_requests, rate_limit_hits)
				VALUES (?, ?, ?, ?, 1, 0)
				ON CONFLICT(minute_bucket, bot_name, method, endpoint) DO UPDATE SET
					total_requests = total_requests + 1
			`);
			stmt.run(minuteBucket, context.botName, context.method, context.endpoint);
		} catch (err) {
			this.logger.error("Erro ao registrar métrica de sucesso:", err);
		}
	}

	/**
	 * Avalia se o erro retornado é categorizado como rate-limit
	 * @param {number} status
	 * @param {object|string} data
	 * @returns {{ isRateLimit: boolean, type: string|null }}
	 */
	static checkRateLimit(status, data) {
		if (status === 429) {
			return { isRateLimit: true, type: "HTTP_429" };
		}

		const dataStr = typeof data === "object" ? JSON.stringify(data) : String(data || "");
		const lower = dataStr.toLowerCase();

		if (lower.includes("rate-overlimit") || lower.includes("rate_overlimit")) {
			return { isRateLimit: true, type: "RATE_OVERLIMIT" };
		}
		if (lower.includes("status 429") || lower.includes("code 429") || lower.includes("error 429")) {
			return { isRateLimit: true, type: "HTTP_429" };
		}
		if (
			lower.includes("rate limit") ||
			lower.includes("rate-limit") ||
			lower.includes("ratelimit")
		) {
			return { isRateLimit: true, type: "RATE_LIMIT" };
		}
		if (lower.includes("info query timed out") || lower.includes("query timed out")) {
			return { isRateLimit: true, type: "INFO_TIMEOUT" };
		}

		return { isRateLimit: false, type: null };
	}

	/**
	 * Extrai informações limpas do stack trace da chamada
	 * @param {string} rawStack
	 * @returns {{ caller_function: string, caller_file: string, call_chain: string, full_stack: string }}
	 */
	static parseStack(rawStack) {
		if (!rawStack) {
			return {
				caller_function: "unknown",
				caller_file: "unknown",
				call_chain: "unknown",
				full_stack: ""
			};
		}

		const lines = rawStack
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.startsWith("at "));
		const appFrames = [];

		for (const line of lines) {
			if (
				line.includes("WhatsgoClient.js") ||
				line.includes("RateLimitTracker.js") ||
				line.includes("node_modules/axios") ||
				line.includes("node:internal") ||
				line.includes("(internal/")
			) {
				continue;
			}
			appFrames.push(line);
		}

		if (appFrames.length === 0) {
			return {
				caller_function: "unknown",
				caller_file: "unknown",
				call_chain: "unknown",
				full_stack: rawStack
			};
		}

		const topFrame = appFrames[0];
		let funcName = "anonymous";
		let filePath = "";

		const matchWithFunc = topFrame.match(/^at\s+([^\s]+)\s+\((.+)\)$/);
		const matchWithoutFunc = topFrame.match(/^at\s+(.+)$/);

		if (matchWithFunc) {
			funcName = matchWithFunc[1];
			filePath = matchWithFunc[2];
		} else if (matchWithoutFunc) {
			filePath = matchWithoutFunc[1];
		}

		const cleanFilePath = filePath.replace(/^.*\/ravena-ai\//, "").replace(/^\/app\//, "");

		const callChain = appFrames
			.slice(0, 3)
			.map((frame) => {
				const m = frame.match(/^at\s+([^\s]+)\s+\((.+)\)$/);
				if (m) {
					const shortFile = m[2].replace(/^.*\/ravena-ai\//, "").replace(/^\/app\//, "");
					return `${shortFile} (${m[1]})`;
				}
				return frame
					.replace(/^at\s+/, "")
					.replace(/^.*\/ravena-ai\//, "")
					.replace(/^\/app\//, "");
			})
			.join(" ➔ ");

		return {
			caller_function: funcName,
			caller_file: cleanFilePath,
			call_chain: callChain,
			full_stack: appFrames.join("\n")
		};
	}

	/**
	 * Registra um evento de Rate Limit se detectado
	 * @param {object} context
	 * @param {object} error
	 * @param {object} reqData
	 * @returns {object|null} Retorna o evento gravado ou null
	 */
	recordRateLimit(context, error, reqData = {}) {
		if (!this.isEnabled()) return null;

		const status = error.response?.status || error.status;
		const data = error.response?.data || error.data;
		const check = RateLimitTracker.checkRateLimit(status, data);

		if (!check.isRateLimit) return null;

		const now = new Date();
		const timestampIso = now.toISOString();
		const timestampMs = now.getTime();
		const durationMs = context?.startTime ? timestampMs - context.startTime : 0;
		const botName = context?.botName || "unknown";
		const method = context?.method || "UNKNOWN";
		const endpoint = context?.endpoint || "/";
		const effectiveReqData = context?.reqData || reqData;

		const rawStack = context?.rawStack || new Error().stack;
		const parsedStack = RateLimitTracker.parseStack(rawStack);

		const errorMessage =
			(typeof data === "object" ? data?.error || data?.message : data) ||
			error.message ||
			"Rate limit detectado";

		let reqDataJson = "";
		try {
			reqDataJson = JSON.stringify(effectiveReqData);
		} catch (e) {
			reqDataJson = String(effectiveReqData);
		}

		try {
			const insertStmt = this.db.prepare(`
				INSERT INTO rate_limit_events (
					timestamp, timestamp_ms, bot_name, method, endpoint, status_code,
					error_type, error_message, request_data, caller_function,
					caller_file, call_chain, full_stack, duration_ms
				) VALUES (
					?, ?, ?, ?, ?, ?,
					?, ?, ?, ?,
					?, ?, ?, ?
				)
			`);

			const info = insertStmt.run(
				timestampIso,
				timestampMs,
				botName,
				method,
				endpoint,
				status || null,
				check.type,
				errorMessage,
				reqDataJson,
				parsedStack.caller_function,
				parsedStack.caller_file,
				parsedStack.call_chain,
				parsedStack.full_stack,
				durationMs
			);

			// Atualiza request_metrics com hit
			const minuteBucket = timestampIso.substring(0, 16);
			const metricsStmt = this.db.prepare(`
				INSERT INTO request_metrics (minute_bucket, bot_name, method, endpoint, total_requests, rate_limit_hits)
				VALUES (?, ?, ?, ?, 1, 1)
				ON CONFLICT(minute_bucket, bot_name, method, endpoint) DO UPDATE SET
					total_requests = total_requests + 1,
					rate_limit_hits = rate_limit_hits + 1
			`);
			metricsStmt.run(minuteBucket, botName, method, endpoint);

			const event = {
				id: info.lastInsertRowid,
				timestamp: timestampIso,
				botName,
				method,
				endpoint,
				statusCode: status,
				errorType: check.type,
				errorMessage,
				callerFile: parsedStack.caller_file,
				callerFunction: parsedStack.caller_function,
				callChain: parsedStack.call_chain
			};

			this.logger.warn(
				`[RATE-LIMIT-HIT] [${check.type}] ${botName} ${method} ${endpoint} (status ${status}) | Chamador: ${parsedStack.caller_file} (${parsedStack.caller_function})`
			);

			return event;
		} catch (err) {
			this.logger.error("Erro ao gravar rate limit no banco:", err);
			return null;
		}
	}

	/**
	 * Obtém sumário consolidado de métricas e erros 429
	 * @param {object} [options]
	 * @returns {object}
	 */
	getSummary(options = {}) {
		if (!this.db) {
			this._initDb();
		}
		if (!this.db) {
			return { error: "Banco de dados indisponível." };
		}

		const now = Date.now();
		const oneHourAgo = now - 3600 * 1000;
		const oneDayAgo = now - 24 * 3600 * 1000;
		const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;

		const totalEvents = this.db
			.prepare("SELECT COUNT(*) AS count FROM rate_limit_events")
			.get().count;

		const last1h = this.db
			.prepare("SELECT COUNT(*) AS count FROM rate_limit_events WHERE timestamp_ms >= ?")
			.get(oneHourAgo).count;

		const last24h = this.db
			.prepare("SELECT COUNT(*) AS count FROM rate_limit_events WHERE timestamp_ms >= ?")
			.get(oneDayAgo).count;

		const last7d = this.db
			.prepare("SELECT COUNT(*) AS count FROM rate_limit_events WHERE timestamp_ms >= ?")
			.get(sevenDaysAgo).count;

		// Top Endpoints com taxa de falha
		const byEndpoint = this.db
			.prepare(
				`
				SELECT 
					rle.method,
					rle.endpoint,
					COUNT(rle.id) AS hits,
					COALESCE(SUM(rm.total_requests), COUNT(rle.id)) AS total_requests
				FROM rate_limit_events rle
				LEFT JOIN request_metrics rm ON rm.endpoint = rle.endpoint AND rm.method = rle.method
				GROUP BY rle.method, rle.endpoint
				ORDER BY hits DESC
				LIMIT 10
			`
			)
			.all();

		// Top Callers (arquivos e funções do código)
		const byCaller = this.db
			.prepare(
				`
				SELECT 
					caller_file,
					caller_function,
					call_chain,
					COUNT(*) AS hits
				FROM rate_limit_events
				GROUP BY caller_file, caller_function
				ORDER BY hits DESC
				LIMIT 10
			`
			)
			.all();

		// Distribuição por Bot
		const byBot = this.db
			.prepare(
				`
				SELECT 
					bot_name,
					COUNT(*) AS hits
				FROM rate_limit_events
				GROUP BY bot_name
				ORDER BY hits DESC
			`
			)
			.all();

		// Tipos de Erro
		const byErrorType = this.db
			.prepare(
				`
				SELECT 
					error_type,
					COUNT(*) AS hits
				FROM rate_limit_events
				GROUP BY error_type
				ORDER BY hits DESC
			`
			)
			.all();

		const limit = options.limit || 10;
		const recentEvents = this.db
			.prepare(
				`
				SELECT * FROM rate_limit_events
				ORDER BY id DESC
				LIMIT ?
			`
			)
			.all(limit);

		const oneHourBucket = new Date(oneHourAgo).toISOString().substring(0, 16);
		const trafficLast1h = this.db
			.prepare(
				`
				SELECT 
					method,
					endpoint,
					SUM(total_requests) AS total_requests,
					SUM(rate_limit_hits) AS rate_limit_hits
				FROM request_metrics
				WHERE minute_bucket >= ?
				GROUP BY method, endpoint
				ORDER BY total_requests DESC
				LIMIT 15
			`
			)
			.all(oneHourBucket);

		return {
			totalEvents,
			last1h,
			last24h,
			last7d,
			byEndpoint,
			byCaller,
			byBot,
			byErrorType,
			trafficLast1h,
			recentEvents
		};
	}

	/**
	 * Obtém eventos detalhados com filtros
	 * @param {number} limit
	 * @param {object} filters
	 * @returns {Array}
	 */
	getRecentEvents(limit = 20, filters = {}) {
		if (!this.db) this._initDb();
		if (!this.db) return [];

		let query = "SELECT * FROM rate_limit_events WHERE 1=1";
		const params = [];

		if (filters.endpoint) {
			query += " AND endpoint LIKE ?";
			params.push(`%${filters.endpoint}%`);
		}
		if (filters.bot) {
			query += " AND bot_name = ?";
			params.push(filters.bot);
		}
		if (filters.caller) {
			query += " AND (caller_file LIKE ? OR caller_function LIKE ?)";
			params.push(`%${filters.caller}%`, `%${filters.caller}%`);
		}

		query += " ORDER BY id DESC LIMIT ?";
		params.push(limit);

		return this.db.prepare(query).all(...params);
	}

	/**
	 * Limpa dados do histórico
	 */
	clearData() {
		if (!this.db) this._initDb();
		if (!this.db) return false;

		this.db.exec(`
			DELETE FROM rate_limit_events;
			DELETE FROM request_metrics;
			VACUUM;
		`);
		return true;
	}

	/**
	 * Remove dados anteriores a N dias
	 * @param {number} days
	 */
	cleanupOldData(days = 14) {
		if (!this.db) return;
		try {
			const thresholdMs = Date.now() - days * 24 * 3600 * 1000;
			const thresholdBucket = new Date(thresholdMs).toISOString().substring(0, 16);

			this.db.prepare("DELETE FROM rate_limit_events WHERE timestamp_ms < ?").run(thresholdMs);
			this.db.prepare("DELETE FROM request_metrics WHERE minute_bucket < ?").run(thresholdBucket);
		} catch (err) {
			this.logger.error("Erro na limpeza de histórico antigo:", err);
		}
	}
}

module.exports = RateLimitTracker;
