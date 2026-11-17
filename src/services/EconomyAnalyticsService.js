/**
 * EconomyAnalyticsService.js
 *
 * Carga horária do painel da economia (Grafana) para o `analytics.db`.
 * Ver OBSERVABILITY.md ("Painel da economia").
 *
 * Fontes (uma por moeda):
 *   - zinthos:   GET {WAIFULETES_API_URL}/internal/economy/summary   (Authorization: Bearer WAIFULETES_API_KEY)
 *   - petalitas: GET {JARDIM_API_URL}/internal/economy/summary       (x-api-key: JARDIM_API_KEY)
 *   - runas:     bank.db local, aberto só-leitura
 *
 * Toda hora no minuto 5 (só com ECONOMY_ANALYTICS_ENABLED=true): para cada fonte pede
 * [to da última carga ok, início da hora atual) — a primeira carga pede from=0 — e grava fluxos por hora
 * e motivo, um retrato de saldos e o resultado em load_runs. Falha de uma fonte não para as outras.
 * Uma vez por dia econômico (04:00 BRT) grava também quem recebe (últimos 7 dias, por quinto).
 */
"use strict";

const path = require("path");
const cron = require("node-cron");
const BetterSQLite = require("better-sqlite3");
const Logger = require("../utils/Logger");
const telemetry = require("../telemetry");
const { EconomyAnalyticsStore } = require("./EconomyAnalyticsStore");
const { kindFor, MAPPING_VERSION } = require("./EconomyAnalyticsMapping");
const {
	HOUR_MS,
	DAY_MS,
	economicDayStart,
	hourStart,
	buildRunasSummary,
	dailySnapshots
} = require("./EconomyAnalyticsRunas");

const logger = new Logger("economy-analytics");
const ROOT = path.join(__dirname, "../..");
const SCHEMA_VERSION = 1;
const RECEIVED_WINDOW_MS = 7 * DAY_MS;

function resolvePath(p, fallback) {
	const v = p || fallback;
	return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

/** GET da rota de resumo de um serviço. Erros não carregam corpo de resposta (evita vazar dados). */
async function fetchSummary(baseUrl, headers, from, to, timeoutMs) {
	const url = `${String(baseUrl).replace(/\/+$/, "")}/internal/economy/summary?from=${from}&to=${to}`;
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) {
		const err = new Error(`HTTP ${res.status} em /internal/economy/summary`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

/** Confere a resposta contra o contrato antes de gravar qualquer coisa. */
function validateSummary(s, currency, from, to) {
	if (!s || typeof s !== "object") throw new Error("resposta vazia");
	if (s.currency !== currency) throw new Error(`moeda inesperada: ${s.currency}`);
	if (s.schemaVersion !== SCHEMA_VERSION) {
		throw new Error(`schemaVersion ${s.schemaVersion} não suportada (esperada ${SCHEMA_VERSION})`);
	}
	if (!Number.isFinite(Number(s.generatedAt))) throw new Error("generatedAt ausente");
	if (!s.balances || !Number.isFinite(Number(s.balances.total)))
		throw new Error("balances ausente");
	const flows =
		s.ledger && s.ledger.available && Array.isArray(s.ledger.flows) ? s.ledger.flows : [];
	for (const f of flows) {
		const h = Number(f.hour);
		if (!Number.isFinite(h) || h % HOUR_MS !== 0 || h < hourStart(from) || h >= to) {
			throw new Error(`fluxo com hora fora da janela: ${f.hour}`);
		}
		if (!f.reason) throw new Error("fluxo sem reason");
		if (Number(f.amountIn) < 0 || Number(f.amountOut) < 0)
			throw new Error("valor negativo no fluxo");
	}
	return flows;
}

class EconomyAnalyticsService {
	/**
	 * @param {object} [opts] (testes injetam tudo aqui)
	 * @param {string} [opts.dbPath] analytics.db
	 * @param {string} [opts.bankDbPath] bank.db (só leitura)
	 * @param {Function} [opts.bankQuery] (sql, params) => rows; substitui a abertura do bank.db
	 * @param {Function} [opts.now] relógio (epoch ms)
	 * @param {string[]} [opts.sources] subconjunto de zinthos, petalitas, runas
	 */
	constructor(opts = {}) {
		const env = process.env;
		this.now = opts.now || (() => Date.now());
		this.dbPath = resolvePath(opts.dbPath || env.ECONOMY_ANALYTICS_DB, "data/sqlites/analytics.db");
		this.bankDbPath = resolvePath(
			opts.bankDbPath || env.ECONOMY_ANALYTICS_BANK_DB,
			"data/sqlites/bank.db"
		);
		this.bankQuery = opts.bankQuery || null;
		this.timeoutMs = Number(opts.timeoutMs || env.ECONOMY_ANALYTICS_TIMEOUT_MS) || 60000;
		this.waifuletes = {
			url: opts.waifuletesUrl || env.WAIFULETES_API_URL || "http://host.docker.internal:3030",
			key: opts.waifuletesKey ?? env.WAIFULETES_API_KEY ?? ""
		};
		this.jardim = {
			url: opts.jardimUrl || env.JARDIM_API_URL || "http://host.docker.internal:3040",
			key: opts.jardimKey ?? env.JARDIM_API_KEY ?? ""
		};
		const enabledSources = (
			opts.sources ||
			env.ECONOMY_ANALYTICS_SOURCES ||
			"zinthos,petalitas,runas"
		)
			.toString()
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		this.sources = this._buildSources().filter((s) => enabledSources.includes(s.name));
		this.store = null;
		this.task = null;
		this._running = null;
	}

	static getInstance() {
		if (!EconomyAnalyticsService.instance) {
			EconomyAnalyticsService.instance = new EconomyAnalyticsService();
		}
		return EconomyAnalyticsService.instance;
	}

	static isEnabled() {
		return process.env.ECONOMY_ANALYTICS_ENABLED === "true";
	}

	_buildSources() {
		return [
			{
				name: "zinthos",
				currency: "zinthos",
				fetch: (from, to) =>
					fetchSummary(
						this.waifuletes.url,
						{ Authorization: `Bearer ${this.waifuletes.key}` },
						from,
						to,
						this.timeoutMs
					)
			},
			{
				name: "petalitas",
				currency: "petalitas",
				fetch: (from, to) =>
					fetchSummary(this.jardim.url, { "x-api-key": this.jardim.key }, from, to, this.timeoutMs)
			},
			{
				name: "runas",
				currency: "runas",
				local: true,
				fetch: async (from, to) => this._withBank((q) => buildRunasSummary(q, from, to, this.now()))
			}
		];
	}

	/** Executa fn com uma função de leitura do bank.db aberto só-leitura (fechado ao final). */
	_withBank(fn) {
		if (this.bankQuery) return fn(this.bankQuery);
		const db = new BetterSQLite(this.bankDbPath, { readonly: true, fileMustExist: true });
		try {
			db.pragma("busy_timeout = 5000");
			return fn((sql, params = []) => db.prepare(sql).all(...params));
		} finally {
			db.close();
		}
	}

	_getStore() {
		if (!this.store) this.store = new EconomyAnalyticsStore(this.dbPath);
		return this.store;
	}

	start() {
		if (this.task) return;
		// Minuto 5: dá tempo das transações da hora anterior assentarem nos serviços
		this.task = cron.schedule("5 * * * *", () => {
			this.runOnce().catch((err) => logger.error(`[economy] Falha na carga: ${err.message}`));
		});
		logger.info(
			`[economy] Carga horária do painel ligada (fontes: ${this.sources.map((s) => s.name).join(", ")}; mapeamento v${MAPPING_VERSION}).`
		);
	}

	stop() {
		if (this.task) {
			this.task.stop();
			this.task = null;
		}
		if (this.store) {
			this.store.close();
			this.store = null;
		}
	}

	/** Uma carga completa (todas as fontes). Chamadas concorrentes esperam a que está rodando. */
	runOnce() {
		if (this._running) return this._running;
		this._running = telemetry
			.withSpan("economy.analytics.run", { root: true }, () => this._run())
			.finally(() => {
				this._running = null;
			});
		return this._running;
	}

	async _run() {
		const store = this._getStore();
		const results = {};
		for (const source of this.sources) {
			results[source.name] = await this._loadSource(store, source);
		}
		for (const source of this.sources) {
			results[`${source.name}.received`] = await this._loadReceived(store, source);
		}
		try {
			store.checkpoint();
		} catch (err) {
			logger.warn(`[economy] Checkpoint do WAL falhou: ${err.message}`);
		}
		return results;
	}

	async _loadSource(store, source) {
		const runTs = this.now();
		const to = hourStart(runTs);
		const last = store.getLastSuccessfulTo(source.name);
		const from = last === null ? 0 : last;
		if (from >= to) return { ok: true, skipped: true, from, to };

		return telemetry.withSpan(
			"economy.analytics.load",
			{
				attributes: {
					"economy.source": source.name,
					"economy.window.from": from,
					"economy.window.to": to
				}
			},
			async (span) => {
				try {
					const summary = await source.fetch(from, to);
					const flows = validateSummary(summary, source.currency, from, to).map((f) => ({
						...f,
						hour: Number(f.hour),
						kind: kindFor(source.currency, String(f.reason))
					}));
					store.setLedgerStatus(
						source.currency,
						!!(summary.ledger && summary.ledger.available),
						runTs
					);
					let rows = store.writeFlows(source.currency, from, to, flows);
					rows += store.writeBalance(
						source.currency,
						Number(summary.generatedAt),
						summary.balances
					);
					if (source.local) {
						// Runas: histórico diário de saldos (virada das 04:00 BRT) dentro da janela
						const snaps = this._withBank((q) => dailySnapshots(q, from, to));
						for (const s of snaps) rows += store.writeBalance(source.currency, s.ts, s.balances);
					}
					const unknown = flows.filter((f) => f.kind === "unknown").length;
					store.recordRun({ ts: runTs, source: source.name, ok: true, from, to, rows });
					telemetry.setAttrs({ "economy.rows": rows, "economy.unknown_reasons": unknown }, span);
					logger.info(
						`[economy] ${source.name}: ${rows} linhas [${new Date(from).toISOString()}, ${new Date(to).toISOString()})${unknown ? `, ${unknown} com motivo sem mapeamento` : ""}.`
					);
					return { ok: true, from, to, rows };
				} catch (err) {
					telemetry.recordError(span, err);
					store.recordRun({
						ts: runTs,
						source: source.name,
						ok: false,
						from,
						to,
						rows: 0,
						error: err.message
					});
					logger.warn(`[economy] ${source.name}: carga falhou (${err.message}).`);
					return { ok: false, from, to, error: err.message };
				}
			}
		);
	}

	/** Uma vez por dia econômico: entradas de criação dos últimos 7 dias por quinto de saldo atual. */
	async _loadReceived(store, source) {
		const runTs = this.now();
		const day = economicDayStart(runTs);
		if (store.hasReceivedForDay(source.currency, day)) return { ok: true, skipped: true };
		const name = `${source.name}.received`;
		const from = day - RECEIVED_WINDOW_MS;
		try {
			const summary = await source.fetch(from, day);
			validateSummary(summary, source.currency, from, day);
			const rows = Array.isArray(summary.receivedByQuintile) ? summary.receivedByQuintile : [];
			const n = rows.length ? store.writeReceived(source.currency, day, rows) : 0;
			store.recordRun({ ts: runTs, source: name, ok: true, from, to: day, rows: n });
			return { ok: true, rows: n };
		} catch (err) {
			store.recordRun({
				ts: runTs,
				source: name,
				ok: false,
				from,
				to: day,
				rows: 0,
				error: err.message
			});
			logger.warn(`[economy] ${name}: carga falhou (${err.message}).`);
			return { ok: false, error: err.message };
		}
	}
}

module.exports = EconomyAnalyticsService;
module.exports.fetchSummary = fetchSummary;
module.exports.validateSummary = validateSummary;
