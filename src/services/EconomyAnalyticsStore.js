/**
 * EconomyAnalyticsStore.js
 *
 * Banco do painel da economia. Dois arquivos:
 *   - de trabalho (ECONOMY_ANALYTICS_DB, padrão data/economia-carga/analytics.db): WAL, escrito só pela
 *     carga. Fica FORA de data/sqlites de propósito: o DatabaseBackup e o !sa-sqlite (SuperAdmin) varrem
 *     data/sqlites inteiro, e este arquivo é derivado (dá para recriar com uma carga do zero).
 *   - publicado (ECONOMY_ANALYTICS_PUBLISH_DIR, padrão data/economia/analytics.db): retrato consistente
 *     gerado ao fim de cada rodada com VACUUM INTO num temporário + rename atômico. O Grafana monta só
 *     esse diretório, só-leitura, e abre com immutable=1 (nunca vê arquivo pela metade nem -wal).
 *
 * Não usa a classe Database (caminho fixo em data/sqlites e backup). Nada aqui é dado por jogador.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BetterSQLite = require("better-sqlite3");

const ROOT = path.join(__dirname, "../..");
const DEFAULT_DB_PATH = "data/economia-carga/analytics.db";
const DEFAULT_PUBLISH_DIR = "data/economia";
const PUBLISHED_NAME = "analytics.db";

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
CREATE INDEX IF NOT EXISTS idx_load_runs_source ON load_runs(source, ok, window_to);
`;

function resolvePath(p, fallback) {
	const v = p || fallback;
	return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

const OUR_TABLES = new Set([
	"flows_hourly",
	"balances",
	"received_by_quintile",
	"load_runs",
	"annotations",
	"ledger_status"
]);

/** Caminho real (resolve links simbólicos do trecho que já existe). */
function realish(p) {
	const abs = path.resolve(p);
	let head = abs;
	const tail = [];
	while (!fs.existsSync(head) && path.dirname(head) !== head) {
		tail.unshift(path.basename(head));
		head = path.dirname(head);
	}
	try {
		return path.join(fs.realpathSync(head), ...tail);
	} catch (_) {
		return abs;
	}
}

function isInside(child, parent) {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Tabelas de um SQLite existente que não são do painel (lido só-leitura). */
function foreignTables(file) {
	if (!fs.existsSync(file)) return [];
	if (!fs.statSync(file).isFile()) return ["(não é arquivo)"];
	let db;
	try {
		db = new BetterSQLite(file, { readonly: true, fileMustExist: true });
		return db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.all()
			.map((r) => r.name)
			.filter((n) => !OUR_TABLES.has(n));
	} catch (_) {
		return ["(não é SQLite)"];
	} finally {
		if (db) db.close();
	}
}

/**
 * Garante que a carga nunca escreve fora dos próprios arquivos: recusa banco de trabalho ou diretório
 * publicado dentro de data/sqlites (bancos do bot, inclusive o bank.db), apontando para o bank.db, ou
 * por cima de um SQLite que tenha qualquer tabela que não seja do painel.
 */
function assertSafePaths(dbPath, publishDir) {
	const sqlites = realish(path.join(ROOT, "data/sqlites"));
	const bank = realish(resolvePath(process.env.ECONOMY_ANALYTICS_BANK_DB, "data/sqlites/bank.db"));
	const work = realish(dbPath);
	const pubDir = realish(publishDir);
	const pubFile = path.join(pubDir, PUBLISHED_NAME);
	for (const [name, p] of [
		["ECONOMY_ANALYTICS_DB", work],
		["ECONOMY_ANALYTICS_PUBLISH_DIR", pubDir]
	]) {
		if (isInside(p, sqlites)) throw new Error(`${name} não pode ficar em data/sqlites (${p})`);
	}
	if (work === bank || pubFile === bank) throw new Error("a carga não pode escrever no bank.db");
	if (path.dirname(work) === pubDir) {
		throw new Error("ECONOMY_ANALYTICS_DB não pode ficar no diretório publicado");
	}
	for (const f of [work, pubFile]) {
		const foreign = foreignTables(f);
		if (foreign.length) {
			throw new Error(
				`recusado: ${f} já existe e não é do painel (tabelas: ${foreign.join(", ")})`
			);
		}
	}
}

function toIntOrNull(v) {
	if (v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) ? Math.round(n) : null;
}

class EconomyAnalyticsStore {
	/**
	 * @param {string} [dbPath] banco de trabalho
	 * @param {string} [publishDir] diretório do retrato publicado (montado no Grafana)
	 */
	constructor(dbPath, publishDir) {
		this.dbPath = resolvePath(dbPath || process.env.ECONOMY_ANALYTICS_DB, DEFAULT_DB_PATH);
		this.publishDir = resolvePath(
			publishDir || process.env.ECONOMY_ANALYTICS_PUBLISH_DIR,
			DEFAULT_PUBLISH_DIR
		);
		assertSafePaths(this.dbPath, this.publishDir);
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
		const balanceCols = `(ts, currency, total, holders, accounts, p50, p90, top10_share,
			   q1_sum, q2_sum, q3_sum, q4_sum, q5_sum)
			 VALUES (@ts, @currency, @total, @holders, @accounts, @p50, @p90, @top10_share,
			   @q1_sum, @q2_sum, @q3_sum, @q4_sum, @q5_sum)`;
		this._upsertBalance = this.db.prepare(`INSERT OR REPLACE INTO balances ${balanceCols}`);
		this._insertBalanceIfMissing = this.db.prepare(`INSERT OR IGNORE INTO balances ${balanceCols}`);
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

	/** Já existe uma rodada ok da fonte que terminou exatamente em `to`? (controle diário) */
	hasSuccessfulRunTo(source, to) {
		return !!this.db
			.prepare("SELECT 1 FROM load_runs WHERE source = ? AND ok = 1 AND window_to = ? LIMIT 1")
			.get(source, to);
	}

	getLedgerAvailable(currency) {
		const row = this.db
			.prepare("SELECT available FROM ledger_status WHERE currency = ?")
			.get(currency);
		return row ? row.available === 1 : null;
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

	/**
	 * Grava um retrato de saldos (formato `balances` do contrato).
	 * @param {boolean} [onlyIfMissing] não sobrescreve retrato já gravado no mesmo instante
	 */
	writeBalance(currency, ts, b, onlyIfMissing = false) {
		const q = new Map((b.quintiles || []).map((x) => [Number(x.q), x]));
		const qs = (i) => (q.has(i) ? toIntOrNull(q.get(i).sum) : null);
		const stmt = onlyIfMissing ? this._insertBalanceIfMissing : this._upsertBalance;
		return stmt.run({
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
		}).changes;
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

	setLedgerStatus(currency, available, ts) {
		this.db
			.prepare("INSERT OR REPLACE INTO ledger_status (currency, available, ts) VALUES (?, ?, ?)")
			.run(currency, available ? 1 : 0, ts);
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

	addAnnotation(ts, currency, label) {
		this.db
			.prepare("INSERT OR REPLACE INTO annotations (ts, currency, label) VALUES (?, ?, ?)")
			.run(ts, currency || null, label);
	}

	/** Caminho do retrato publicado (o que o Grafana lê). */
	get publishedPath() {
		return path.join(this.publishDir, PUBLISHED_NAME);
	}

	/**
	 * Trava de publicação entre processos (a carga no bot e o scripts/economy-annotate.js): arquivo
	 * criado com O_EXCL ao lado do banco de trabalho. Trava com mais de staleMs é de processo morto e
	 * é removida. Espera no máximo waitMs (síncrono; a publicação inteira já é síncrona).
	 */
	_acquirePublishLock(waitMs, staleMs) {
		const lock = `${this.dbPath}.publish.lock`;
		const start = Date.now();
		const sleeper = new Int32Array(new SharedArrayBuffer(4));
		for (;;) {
			try {
				const fd = fs.openSync(lock, "wx");
				fs.writeSync(fd, String(process.pid));
				fs.closeSync(fd);
				return () => fs.rmSync(lock, { force: true });
			} catch (err) {
				if (err.code !== "EEXIST") throw err;
			}
			let age = 0;
			try {
				age = Date.now() - fs.statSync(lock).mtimeMs;
			} catch (_) {
				continue; // sumiu entre o open e o stat
			}
			if (age > staleMs) {
				fs.rmSync(lock, { force: true });
				continue;
			}
			if (Date.now() - start >= waitMs) {
				throw new Error("outra publicação em andamento (trava ocupada)");
			}
			Atomics.wait(sleeper, 0, 0, 100);
		}
	}

	/**
	 * Publica um retrato consistente: VACUUM INTO num temporário no mesmo diretório (mesmo sistema de
	 * arquivos) e rename atômico por cima do anterior. Quem já está lendo continua no arquivo antigo.
	 * Serializado entre processos pela trava acima.
	 */
	publish({ waitMs = 5000, staleMs = 120000 } = {}) {
		fs.mkdirSync(this.publishDir, { recursive: true });
		const release = this._acquirePublishLock(waitMs, staleMs);
		const tmp = path.join(this.publishDir, `.${PUBLISHED_NAME}.tmp-${process.pid}`);
		try {
			fs.rmSync(tmp, { force: true });
			this.db.prepare("VACUUM INTO ?").run(tmp);
			const snap = new BetterSQLite(tmp);
			try {
				snap.pragma("journal_mode = DELETE");
			} finally {
				snap.close();
			}
			fs.chmodSync(tmp, 0o644); // o Grafana roda como outro usuário (uid 472)
			// nunca sobrescreve um arquivo que não seja um retrato do painel
			const foreign = foreignTables(this.publishedPath);
			if (foreign.length) throw new Error(`recusado: ${this.publishedPath} não é do painel`);
			fs.renameSync(tmp, this.publishedPath);
		} catch (err) {
			fs.rmSync(tmp, { force: true });
			throw err;
		} finally {
			release();
		}
		return this.publishedPath;
	}

	listAnnotations() {
		return this.db.prepare("SELECT ts, currency, label FROM annotations ORDER BY ts").all();
	}

	close() {
		try {
			this.db.close();
		} catch (_) {}
	}
}

module.exports = {
	EconomyAnalyticsStore,
	DEFAULT_DB_PATH,
	DEFAULT_PUBLISH_DIR,
	SCHEMA,
	resolvePath,
	assertSafePaths
};
