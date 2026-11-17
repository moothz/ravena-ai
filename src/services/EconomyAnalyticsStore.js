/**
 * EconomyAnalyticsStore.js
 *
 * Arquivo SQLite do painel da economia (`analytics.db`). Escrito só pela carga
 * (EconomyAnalyticsService) e lido pelo Grafana (frser-sqlite-datasource, só leitura).
 *
 * Não usa a classe Database: o caminho é configurável (ECONOMY_ANALYTICS_DB), o arquivo não entra no
 * backup (é derivado, dá para recriar com uma carga do zero) e nada aqui é dado por jogador.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BetterSQLite = require("better-sqlite3");

const DEFAULT_DB_PATH = path.join(__dirname, "../../data/sqlites/analytics.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flows_hourly (
  hour INTEGER NOT NULL, currency TEXT NOT NULL, reason TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_in INTEGER NOT NULL, amount_out INTEGER NOT NULL, tx_count INTEGER NOT NULL, users INTEGER NOT NULL,
  PRIMARY KEY (hour, currency, reason)
);
CREATE TABLE IF NOT EXISTS balances (
  ts INTEGER NOT NULL, currency TEXT NOT NULL, total INTEGER NOT NULL, holders INTEGER, accounts INTEGER,
  p50 INTEGER, p90 INTEGER, top10_share REAL,
  q1_sum INTEGER, q2_sum INTEGER, q3_sum INTEGER, q4_sum INTEGER, q5_sum INTEGER,
  PRIMARY KEY (ts, currency)
);
CREATE TABLE IF NOT EXISTS received_by_quintile (
  day INTEGER NOT NULL, currency TEXT NOT NULL, q INTEGER NOT NULL, n INTEGER,
  received_sum INTEGER, received_median INTEGER,
  PRIMARY KEY (day, currency, q)
);
CREATE TABLE IF NOT EXISTS load_runs (
  ts INTEGER NOT NULL, source TEXT NOT NULL, ok INTEGER NOT NULL, window_from INTEGER, window_to INTEGER,
  rows INTEGER, error TEXT, PRIMARY KEY (ts, source)
);
CREATE TABLE IF NOT EXISTS annotations (
  ts INTEGER NOT NULL, currency TEXT, label TEXT NOT NULL, PRIMARY KEY (ts, label)
);
-- Fora do contrato (aditiva): se a moeda tem extrato. Sem extrato o painel mostra "sem extrato" em vez
-- de calcular moeda sem origem (seria o Δ total inteiro).
CREATE TABLE IF NOT EXISTS ledger_status (
  currency TEXT PRIMARY KEY, available INTEGER NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flows_currency_hour ON flows_hourly(currency, hour);
CREATE INDEX IF NOT EXISTS idx_balances_currency_ts ON balances(currency, ts);
`;

function toIntOrNull(v) {
	if (v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) ? Math.round(n) : null;
}

class EconomyAnalyticsStore {
	/**
	 * @param {string} [dbPath] caminho do analytics.db
	 */
	constructor(dbPath = process.env.ECONOMY_ANALYTICS_DB || DEFAULT_DB_PATH) {
		this.dbPath = path.resolve(dbPath);
		fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
		this.db = new BetterSQLite(this.dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = NORMAL");
		this.db.pragma("busy_timeout = 5000");
		this.db.exec(SCHEMA);

		this._upsertFlow = this.db.prepare(
			`INSERT OR REPLACE INTO flows_hourly (hour, currency, reason, kind, amount_in, amount_out, tx_count, users)
			 VALUES (@hour, @currency, @reason, @kind, @amount_in, @amount_out, @tx_count, @users)`
		);
		this._deleteFlows = this.db.prepare(
			"DELETE FROM flows_hourly WHERE currency = ? AND hour >= ? AND hour < ?"
		);
		this._upsertBalance = this.db.prepare(
			`INSERT OR REPLACE INTO balances (ts, currency, total, holders, accounts, p50, p90, top10_share,
			   q1_sum, q2_sum, q3_sum, q4_sum, q5_sum)
			 VALUES (@ts, @currency, @total, @holders, @accounts, @p50, @p90, @top10_share,
			   @q1_sum, @q2_sum, @q3_sum, @q4_sum, @q5_sum)`
		);
		this._upsertReceived = this.db.prepare(
			`INSERT OR REPLACE INTO received_by_quintile (day, currency, q, n, received_sum, received_median)
			 VALUES (?, ?, ?, ?, ?, ?)`
		);
		this._insertRun = this.db.prepare(
			`INSERT OR REPLACE INTO load_runs (ts, source, ok, window_from, window_to, rows, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		);
	}

	/** `to` da última carga bem-sucedida da fonte, ou null se nunca houve. */
	getLastSuccessfulTo(source) {
		const row = this.db
			.prepare("SELECT MAX(window_to) AS t FROM load_runs WHERE source = ? AND ok = 1")
			.get(source);
		return row && row.t !== null ? row.t : null;
	}

	hasReceivedForDay(currency, day) {
		return !!this.db
			.prepare("SELECT 1 FROM received_by_quintile WHERE currency = ? AND day = ? LIMIT 1")
			.get(currency, day);
	}

	/**
	 * Grava os fluxos de uma janela numa transação. Apaga antes o que houver na janela para a moeda,
	 * assim regravar a mesma janela não deixa motivo "fantasma".
	 * @returns {number} linhas gravadas
	 */
	writeFlows(currency, from, to, flows) {
		const tx = this.db.transaction(() => {
			this._deleteFlows.run(currency, from, to);
			for (const f of flows) {
				this._upsertFlow.run({
					hour: f.hour,
					currency,
					reason: String(f.reason),
					kind: f.kind,
					amount_in: Math.max(0, toIntOrNull(f.amountIn) || 0),
					amount_out: Math.max(0, toIntOrNull(f.amountOut) || 0),
					tx_count: toIntOrNull(f.count) || 0,
					users: toIntOrNull(f.users) || 0
				});
			}
		});
		tx();
		return flows.length;
	}

	/** Grava um retrato de saldos (formato `balances` do contrato). */
	writeBalance(currency, ts, b) {
		const q = new Map((b.quintiles || []).map((x) => [Number(x.q), x]));
		const qs = (i) => (q.has(i) ? toIntOrNull(q.get(i).sum) : null);
		this._upsertBalance.run({
			ts,
			currency,
			total: toIntOrNull(b.total) || 0,
			holders: toIntOrNull(b.holders),
			accounts: toIntOrNull(b.accounts),
			p50: toIntOrNull(b.p50),
			p90: toIntOrNull(b.p90),
			top10_share:
				b.top10Share === null || b.top10Share === undefined ? null : Number(b.top10Share),
			q1_sum: qs(1),
			q2_sum: qs(2),
			q3_sum: qs(3),
			q4_sum: qs(4),
			q5_sum: qs(5)
		});
		return 1;
	}

	writeReceived(currency, day, rows) {
		const tx = this.db.transaction(() => {
			for (const r of rows) {
				this._upsertReceived.run(
					day,
					currency,
					toIntOrNull(r.q),
					toIntOrNull(r.n),
					toIntOrNull(r.receivedSum),
					toIntOrNull(r.receivedMedian)
				);
			}
		});
		tx();
		return rows.length;
	}

	recordRun({ ts, source, ok, from = null, to = null, rows = null, error = null }) {
		this._insertRun.run(
			ts,
			source,
			ok ? 1 : 0,
			from,
			to,
			rows,
			error ? String(error).slice(0, 500) : null
		);
	}

	setLedgerStatus(currency, available, ts) {
		this.db
			.prepare("INSERT OR REPLACE INTO ledger_status (currency, available, ts) VALUES (?, ?, ?)")
			.run(currency, available ? 1 : 0, ts);
	}

	addAnnotation(ts, currency, label) {
		this.db
			.prepare("INSERT OR REPLACE INTO annotations (ts, currency, label) VALUES (?, ?, ?)")
			.run(ts, currency || null, label);
	}

	/**
	 * Junta o WAL ao arquivo principal. O Grafana abre o arquivo montado só-leitura e não enxerga o
	 * -wal, então cada carga termina com o arquivo principal completo.
	 */
	checkpoint() {
		this.db.pragma("wal_checkpoint(TRUNCATE)");
	}

	close() {
		try {
			this.db.close();
		} catch (_) {}
	}
}

module.exports = { EconomyAnalyticsStore, DEFAULT_DB_PATH, SCHEMA };
