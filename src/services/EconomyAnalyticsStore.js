/**
 * EconomyAnalyticsStore.js
 *
 * Banco do painel da economia. Dois arquivos:
 *   - de trabalho (ECONOMY_ANALYTICS_DB, padrão data/economia-carga/analytics.db): WAL, escrito só pela
 *     carga. Fica FORA de data/sqlites de propósito: o DatabaseBackup e o !sa-sqlite (SuperAdmin) varrem
 *     data/sqlites inteiro, e este arquivo é derivado (dá para recriar com uma carga do zero).
 *   - publicado (ECONOMY_ANALYTICS_PUBLISH_DIR, padrão data/economia/analytics.db): retrato consistente
 *     gerado ao fim de cada rodada com a API de backup do SQLite (db.backup, assíncrona) num temporário
 *     + rename atômico. O Grafana monta só esse diretório, só-leitura, e abre com immutable=1 (nunca vê
 *     arquivo pela metade nem -wal).
 *
 * Os dois arquivos levam a marca PRAGMA application_id = APP_ID: é ela que diz que um SQLite existente é
 * do painel (a guarda aceita tabelas que esta versão não conhece, de uma versão mais nova). Banco sem a
 * marca só é aceito se todas as tabelas forem do painel (criado por versão anterior à marca); aí é marcado.
 *
 * Não usa a classe Database (caminho fixo em data/sqlites e backup). Guarda também o detalhe por
 * jogador (página Jogadores): saldo, fluxo por motivo e comandos por dia, com nome e telefone, por
 * ECONOMY_ANALYTICS_PLAYER_DAYS dias (padrão 90). Decisão de produto: moeda de jogo, sem valor
 * financeiro; o Grafana só é acessado por túnel ou com senha.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BetterSQLite = require("better-sqlite3");
const { DAY_MS, economicDayStart } = require("./EconomyAnalyticsRunas");

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
-- Versão do mapeamento motivo → tipo com que flows_hourly.kind foi gravado
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Nome legível e tipo de cada motivo mapeado (EconomyAnalyticsMapping.LABELS), regravada na subida
CREATE TABLE IF NOT EXISTS reason_labels (
  currency TEXT NOT NULL, reason TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY (currency, reason)
);
-- Ciclo cotas → alma gêmea → divórcio (waifuletes: soulmateCycle do resumo), por hora. above_cost: só
-- divórcios com quota_cost > 0 e pago > custo; without_quota: divórcios sem cotas (NULL = waifuletes
-- anterior ao campo, que não manda; coluna criada por ADD COLUMN em _migrate nos bancos antigos)
CREATE TABLE IF NOT EXISTS soulmate_cycle_hourly (
  hour INTEGER PRIMARY KEY, divorces INTEGER NOT NULL, paid INTEGER NOT NULL, quota_cost INTEGER NOT NULL,
  above_cost INTEGER NOT NULL, max_return REAL, without_quota INTEGER
);
-- Atividade (cmd_usage.db): comandos e pessoas distintas por hora; por dia e comando
CREATE TABLE IF NOT EXISTS activity_hourly (
  hour INTEGER PRIMARY KEY, uses INTEGER NOT NULL, users INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_daily_command (
  day INTEGER NOT NULL, command TEXT NOT NULL, uses INTEGER NOT NULL, users INTEGER NOT NULL,
  PRIMARY KEY (day, command)
);
-- Por jogador (ID cru de cada fonte; identities une as fontes numa pessoa)
CREATE TABLE IF NOT EXISTS players (
  currency TEXT NOT NULL, player_id TEXT NOT NULL, name TEXT, platform TEXT,
  balance INTEGER, last_active INTEGER, updated_ts INTEGER NOT NULL,
  PRIMARY KEY (currency, player_id)
);
CREATE TABLE IF NOT EXISTS player_daily (
  day INTEGER NOT NULL, currency TEXT NOT NULL, player_id TEXT NOT NULL, reason TEXT NOT NULL,
  kind TEXT NOT NULL, amount_in INTEGER NOT NULL, amount_out INTEGER NOT NULL, tx_count INTEGER NOT NULL,
  PRIMARY KEY (day, currency, player_id, reason)
);
CREATE TABLE IF NOT EXISTS player_balance_daily (
  day INTEGER NOT NULL, currency TEXT NOT NULL, player_id TEXT NOT NULL, balance INTEGER NOT NULL,
  PRIMARY KEY (day, currency, player_id)
);
CREATE TABLE IF NOT EXISTS player_activity_daily (
  day INTEGER NOT NULL, player_id TEXT NOT NULL, uses INTEGER NOT NULL,
  PRIMARY KEY (day, player_id)
);
-- ID cru → pessoa (telefone com 13 dígitos, tg:<id> ou lid:<id>), regravada a cada rodada
CREATE TABLE IF NOT EXISTS identities (
  player_id TEXT PRIMARY KEY, person TEXT NOT NULL, phone TEXT, id_kind TEXT NOT NULL, name TEXT
);
-- Painéis que dependem de dado que pode não existir ainda (selo "Indisponível" no painel)
CREATE TABLE IF NOT EXISTS features (
  key TEXT PRIMARY KEY, title TEXT NOT NULL, available INTEGER NOT NULL, depends_on TEXT, detail TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_daily_cur_day ON player_daily(currency, day);
CREATE INDEX IF NOT EXISTS idx_player_daily_player ON player_daily(player_id, day);
CREATE INDEX IF NOT EXISTS idx_identities_person ON identities(person);
CREATE INDEX IF NOT EXISTS idx_flows_currency_hour ON flows_hourly(currency, hour);
CREATE INDEX IF NOT EXISTS idx_balances_currency_ts ON balances(currency, ts);
CREATE INDEX IF NOT EXISTS idx_load_runs_source ON load_runs(source, ok, window_to);
CREATE INDEX IF NOT EXISTS idx_players_player ON players(player_id);
`;

/** Marca do painel no cabeçalho do SQLite (PRAGMA application_id): "ECON". */
const APP_ID = 0x45434f4e;

function resolvePath(p, fallback) {
	const v = p || fallback;
	return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

/**
 * Tabelas criadas por versões anteriores à marca (APP_ID). Só servem para reconhecer e marcar um banco
 * antigo; com a marca, tabela desconhecida (de versão mais nova) é aceita. Não precisa crescer.
 */
const LEGACY_TABLES = new Set([
	"flows_hourly",
	"balances",
	"received_by_quintile",
	"load_runs",
	"annotations",
	"ledger_status",
	"meta",
	"reason_labels",
	"soulmate_cycle_hourly",
	"activity_hourly",
	"activity_daily_command",
	"players",
	"player_daily",
	"player_balance_daily",
	"player_activity_daily",
	"identities",
	"features",
	"params_current"
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

/**
 * De quem é um SQLite existente (lido só-leitura): null = do painel (ou não existe); senão o motivo da
 * recusa. Do painel = tem a marca APP_ID, ou não tem marca nenhuma e só tabelas de LEGACY_TABLES (banco
 * criado antes da marca; vazio também). Qualquer outra marca ou tabela alheia sem a marca = recusado.
 */
function foreignReason(file) {
	if (!fs.existsSync(file)) return null;
	if (!fs.statSync(file).isFile()) return "não é arquivo";
	let db;
	try {
		db = new BetterSQLite(file, { readonly: true, fileMustExist: true });
		const appId = db.pragma("application_id", { simple: true });
		if (appId === APP_ID) return null;
		if (appId !== 0) return `application_id ${appId}`;
		const alien = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.all()
			.map((r) => r.name)
			.filter((n) => !LEGACY_TABLES.has(n));
		return alien.length ? `tabelas: ${alien.join(", ")}` : null;
	} catch (_) {
		return "não é SQLite";
	} finally {
		if (db) db.close();
	}
}

/**
 * Garante que a carga nunca escreve fora dos próprios arquivos: recusa banco de trabalho ou diretório
 * publicado dentro de data/sqlites (bancos do bot, inclusive o bank.db), apontando para o bank.db, ou
 * por cima de um SQLite que não seja do painel (ver foreignReason).
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
		const foreign = foreignReason(f);
		if (foreign) throw new Error(`recusado: ${f} já existe e não é do painel (${foreign})`);
	}
}

const TMP_PREFIX = `.${PUBLISHED_NAME}.tmp-`;

/** O processo com esse PID existe? (EPERM = existe, de outro usuário) */
function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}

/**
 * Remove a trava de publicação se ela for de processo morto (PID gravado não existe) ou tiver mais de
 * staleMs (PID de outro namespace, arquivo sem PID). Confere o inode antes de apagar para não remover
 * uma trava nova criada entre a leitura e a remoção. @returns {boolean} removeu (ou já tinha sumido)
 */
function removeStaleLock(lock, staleMs) {
	let st;
	let content;
	try {
		st = fs.statSync(lock);
		content = fs.readFileSync(lock, "utf8");
	} catch (_) {
		return true; // sumiu entre o open e a leitura
	}
	const pid = Number(String(content).split(" ")[0]);
	const dead = content && Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
	if (!dead && Date.now() - st.mtimeMs <= staleMs) return false;
	try {
		if (fs.statSync(lock).ino === st.ino) fs.rmSync(lock, { force: true });
	} catch (_) {}
	return true;
}

/**
 * Permissão do retrato publicado. O Grafana (imagem oficial) roda como uid 472 e grupo 0 (root): se o
 * arquivo saiu com grupo 0 (a ravena roda como root no contêiner), 0640 basta; senão (ravena fora do
 * Docker, como usuário comum) precisa de 0644 para o Grafana ler.
 */
function publishedMode(file) {
	return fs.statSync(file).gid === 0 ? 0o640 : 0o644;
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
		this._migrate();
		// Marca o banco como do painel (novo ou criado antes da marca; a guarda acima já conferiu)
		if (this.db.pragma("application_id", { simple: true }) !== APP_ID) {
			this.db.pragma(`application_id = ${APP_ID}`);
		}

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

	/** Colunas novas em bancos criados por versões anteriores (só ADD COLUMN; nada é apagado). */
	_migrate() {
		const cols = (t) =>
			new Set(
				this.db
					.prepare(`PRAGMA table_info(${t})`)
					.all()
					.map((c) => c.name)
			);
		if (!cols("soulmate_cycle_hourly").has("without_quota")) {
			this.db.exec("ALTER TABLE soulmate_cycle_hourly ADD COLUMN without_quota INTEGER");
		}
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

	/**
	 * Por fonte de load_runs: `to` da última carga ok, a última tentativa (instante, ok, erro).
	 * @returns {{source:string, okTo:number|null, lastTs:number, lastOk:boolean, lastError:string|null}[]}
	 */
	loadStatus() {
		return this.db
			.prepare(
				`SELECT s.source,
				   (SELECT MAX(window_to) FROM load_runs o WHERE o.source = s.source AND o.ok = 1) AS okTo,
				   l.ts AS lastTs, l.ok AS lastOk, l.error AS lastError
				 FROM (SELECT source, MAX(ts) AS ts FROM load_runs GROUP BY source) s
				 JOIN load_runs l ON l.source = s.source AND l.ts = s.ts
				 ORDER BY s.source`
			)
			.all()
			.map((r) => ({ ...r, lastOk: r.lastOk === 1 }));
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

	/**
	 * Alinha o banco ao mapeamento atual, a cada subida: regrava reason_labels e o kind de toda linha de
	 * flows_hourly e de player_daily cujo tipo difere do mapeamento atual (só este banco; nenhum dado de jogo). Não depende
	 * de alguém subir MAPPING_VERSION: qualquer mudança no mapeamento é aplicada ao histórico inteiro.
	 * meta.mapping_version fica só como registro.
	 * @returns {{remapped:number, previous:string|null}}
	 */
	syncMapping(version, kindFor, labelRows) {
		let remapped = 0;
		let previous = null;
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM reason_labels").run();
			const ins = this.db.prepare(
				"INSERT INTO reason_labels (currency, reason, label, kind) VALUES (?, ?, ?, ?)"
			);
			for (const r of labelRows) ins.run(r.currency, r.reason, r.label, r.kind);
			const row = this.db.prepare("SELECT value FROM meta WHERE key = 'mapping_version'").get();
			previous = row ? row.value : null;
			// Mesma regra nos fluxos por hora e no detalhe por jogador (mesma transação)
			for (const table of ["flows_hourly", "player_daily"]) {
				const upd = this.db.prepare(
					`UPDATE ${table} SET kind = ? WHERE currency = ? AND reason = ? AND kind <> ?`
				);
				for (const { currency, reason } of this.db
					.prepare(`SELECT DISTINCT currency, reason FROM ${table}`)
					.all()) {
					const k = kindFor(currency, reason);
					remapped += upd.run(k, currency, reason, k).changes;
				}
			}
			this.db
				.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('mapping_version', ?)")
				.run(String(version));
		});
		tx();
		return { remapped, previous };
	}

	/** Ciclo da alma gêmea: regrava as horas da janela. */
	writeSoulmate(from, to, rows) {
		const tx = this.db.transaction(() => {
			this.db
				.prepare("DELETE FROM soulmate_cycle_hourly WHERE hour >= ? AND hour < ?")
				.run(from, to);
			const ins = this.db.prepare(
				`INSERT OR REPLACE INTO soulmate_cycle_hourly
				   (hour, divorces, paid, quota_cost, above_cost, max_return, without_quota)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			);
			for (const r of rows) {
				ins.run(
					Number(r.hour),
					toIntOrNull(r.divorces) || 0,
					toIntOrNull(r.paid) || 0,
					toIntOrNull(r.quotaCost) || 0,
					toIntOrNull(r.aboveCost) || 0,
					r.maxReturn === null || r.maxReturn === undefined ? null : Number(r.maxReturn),
					// waifuletes antigo não manda: NULL (desconhecido), não 0
					toIntOrNull(r.withoutQuota)
				);
			}
		});
		tx();
		return rows.length;
	}

	/**
	 * Atividade de [from, to): regrava horas da janela e os dias inteiros que ela toca (from é sempre
	 * início de dia econômico na carga).
	 * @param {Function} idOf ID cru do usuário (rawId)
	 */
	writeActivity(from, to, { hourly, byCommand, byUser }, idOf) {
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM activity_hourly WHERE hour >= ? AND hour < ?").run(from, to);
			this.db
				.prepare("DELETE FROM activity_daily_command WHERE day >= ? AND day < ?")
				.run(from, to);
			this.db.prepare("DELETE FROM player_activity_daily WHERE day >= ? AND day < ?").run(from, to);
			const h = this.db.prepare(
				"INSERT OR REPLACE INTO activity_hourly (hour, uses, users) VALUES (?, ?, ?)"
			);
			for (const r of hourly) h.run(Number(r.hour), Number(r.uses), Number(r.users));
			const c = this.db.prepare(
				"INSERT OR REPLACE INTO activity_daily_command (day, command, uses, users) VALUES (?, ?, ?, ?)"
			);
			for (const r of byCommand)
				c.run(Number(r.day), String(r.command), Number(r.uses), Number(r.users));
			const u = this.db.prepare(
				`INSERT INTO player_activity_daily (day, player_id, uses) VALUES (?, ?, ?)
				 ON CONFLICT(day, player_id) DO UPDATE SET uses = uses + excluded.uses`
			);
			for (const r of byUser) {
				const id = idOf(r.user);
				if (id) u.run(Number(r.day), id, Number(r.uses));
			}
		});
		tx();
		return hourly.length + byCommand.length + byUser.length;
	}

	/**
	 * Um dia de uma moeda por jogador (resposta de /internal/economy/players): regrava fluxos e saldo do
	 * dia; com `live`, atualiza também o saldo atual em players.
	 * @param {Function} kindFor (currency, reason) => kind
	 * @param {Function} idOf ID cru (rawId)
	 */
	writePlayerDay(currency, day, payload, { live, kindFor, idOf, ts }) {
		const flows = Array.isArray(payload.flows) ? payload.flows : [];
		const players = Array.isArray(payload.players) ? payload.players : [];
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM player_daily WHERE currency = ? AND day = ?").run(currency, day);
			const ins = this.db.prepare(
				`INSERT INTO player_daily (day, currency, player_id, reason, kind, amount_in, amount_out, tx_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(day, currency, player_id, reason) DO UPDATE SET
				   amount_in = amount_in + excluded.amount_in, amount_out = amount_out + excluded.amount_out,
				   tx_count = tx_count + excluded.tx_count`
			);
			for (const f of flows) {
				const id = idOf(f.id);
				if (!id) continue;
				ins.run(
					day,
					currency,
					id,
					String(f.reason),
					kindFor(currency, String(f.reason)),
					Math.max(0, toIntOrNull(f.amountIn) || 0),
					Math.max(0, toIntOrNull(f.amountOut) || 0),
					toIntOrNull(f.count) || 0
				);
			}
			const bal = this.db.prepare(
				`INSERT INTO player_balance_daily (day, currency, player_id, balance) VALUES (?, ?, ?, ?)
				 ON CONFLICT(day, currency, player_id) DO UPDATE SET balance = balance + excluded.balance`
			);
			const hasEnd = players.some(
				(p) => p.balanceAtWindowEnd !== null && p.balanceAtWindowEnd !== undefined
			);
			if (hasEnd || live) {
				this.db
					.prepare("DELETE FROM player_balance_daily WHERE currency = ? AND day = ?")
					.run(currency, day);
				for (const p of players) {
					const id = idOf(p.id);
					const v = hasEnd ? p.balanceAtWindowEnd : p.balance;
					if (id && v !== null && v !== undefined) bal.run(day, currency, id, toIntOrNull(v) || 0);
				}
			}
			if (live) {
				this.db.prepare("DELETE FROM players WHERE currency = ?").run(currency);
				const up = this.db.prepare(
					`INSERT INTO players (currency, player_id, name, platform, balance, last_active, updated_ts)
					 VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(currency, player_id) DO UPDATE SET balance = balance + excluded.balance,
					   name = COALESCE(players.name, excluded.name), platform = COALESCE(players.platform, excluded.platform),
					   last_active = MAX(COALESCE(players.last_active, 0), COALESCE(excluded.last_active, 0))`
				);
				for (const p of players) {
					const id = idOf(p.id);
					if (!id) continue;
					up.run(
						currency,
						id,
						p.name ? String(p.name).slice(0, 120) : null,
						p.platform ? String(p.platform) : null,
						toIntOrNull(p.balance) || 0,
						toIntOrNull(p.lastActiveAt),
						ts
					);
				}
			}
		});
		tx();
		return flows.length + players.length;
	}

	/** Todos os IDs crus por jogador vistos (para regravar identities). */
	listPlayerIds() {
		return this.db
			.prepare(
				`SELECT player_id FROM players UNION SELECT player_id FROM player_daily
				 UNION SELECT player_id FROM player_activity_daily`
			)
			.all()
			.map((r) => r.player_id);
	}

	/** Nome mandado pelos serviços por ID cru (o maior entre as moedas). */
	playerNames() {
		return new Map(
			this.db
				.prepare(
					"SELECT player_id, MAX(name) AS name FROM players WHERE name IS NOT NULL GROUP BY player_id"
				)
				.all()
				.map((r) => [r.player_id, r.name])
		);
	}

	/** IDs que um serviço marcou como Telegram. */
	listTelegramIds() {
		return this.db
			.prepare("SELECT player_id FROM players WHERE upper(platform) = 'TELEGRAM'")
			.all()
			.map((r) => r.player_id);
	}

	/** Regrava identities inteira. rows: {playerId, person, phone, idKind, name} */
	writeIdentities(rows) {
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM identities").run();
			const ins = this.db.prepare(
				"INSERT OR REPLACE INTO identities (player_id, person, phone, id_kind, name) VALUES (?, ?, ?, ?, ?)"
			);
			for (const r of rows) ins.run(r.playerId, r.person, r.phone, r.idKind, r.name);
		});
		tx();
		return rows.length;
	}

	/** Apaga o detalhe por jogador e a atividade com dia anterior a `minDay`. */
	pruneBefore(minDay) {
		let n = 0;
		for (const [table, col] of [
			["player_daily", "day"],
			["player_balance_daily", "day"],
			["player_activity_daily", "day"],
			["activity_daily_command", "day"],
			["activity_hourly", "hour"]
		]) {
			n += this.db.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(minDay).changes;
		}
		return n;
	}

	/** Regrava a tabela de disponibilidade dos painéis. rows: {key, title, available, dependsOn, detail} */
	writeFeatures(rows, ts) {
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM features").run();
			const ins = this.db.prepare(
				"INSERT INTO features (key, title, available, depends_on, detail, ts) VALUES (?, ?, ?, ?, ?, ?)"
			);
			for (const r of rows)
				ins.run(r.key, r.title, r.available ? 1 : 0, r.dependsOn || null, r.detail || null, ts);
		});
		tx();
	}

	/**
	 * Massa total por virada de dia econômico antes de `anchorTs`: anchorTotal − Σ(entra − sai) dos fluxos
	 * com hora em [dia, anchorTs), sem os motivos de `excludeReasons`. Grava só onde não há retrato
	 * (INSERT OR IGNORE). Ver EconomyAnalyticsService._reconstructMass.
	 * @returns {{written:number, days:number, from:number|null}}
	 */
	reconstructMass(currency, anchorTs, anchorTotal, excludeReasons = []) {
		const ph = excludeReasons.map(() => "?").join(", ");
		const net = this.db
			.prepare(
				`SELECT hour, SUM(amount_in - amount_out) AS net FROM flows_hourly
				 WHERE currency = ? AND hour < ?${ph ? ` AND reason NOT IN (${ph})` : ""}
				 GROUP BY hour ORDER BY hour DESC`
			)
			.all(currency, anchorTs, ...excludeReasons);
		if (!net.length) return { written: 0, days: 0, from: null };
		const first = economicDayStart(Number(net[net.length - 1].hour));
		let day = economicDayStart(anchorTs);
		if (day === anchorTs) day -= DAY_MS; // o retrato da âncora já existe
		let total = Number(anchorTotal);
		let i = 0;
		let written = 0;
		let days = 0;
		const tx = this.db.transaction(() => {
			for (; day >= first; day -= DAY_MS) {
				while (i < net.length && Number(net[i].hour) >= day) {
					total -= Number(net[i].net) || 0;
					i++;
				}
				days++;
				written += this.writeBalance(currency, day, { total }, true);
			}
		});
		tx();
		return { written, days, from: first };
	}

	getMeta(key) {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
		return row ? row.value : null;
	}

	setMeta(key, value) {
		this.db
			.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
			.run(key, String(value));
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
	 * Trava de publicação entre processos (a carga, no worker do bot, e os scripts): arquivo criado com
	 * O_EXCL ao lado do banco de trabalho, com "<pid> <aleatório>". A trava é de processo morto (removida)
	 * se o PID gravado não existe mais (process.kill(pid, 0)) ou se tem mais de staleMs. Espera sem
	 * bloquear a thread (tentativas a cada 100 ms) no máximo waitMs. Devolve a função que libera, que só
	 * apaga a trava se ela ainda for a própria.
	 */
	async _acquirePublishLock(waitMs, staleMs) {
		const lock = `${this.dbPath}.publish.lock`;
		const token = `${process.pid} ${Math.random().toString(36).slice(2)}`;
		const start = Date.now();
		for (;;) {
			try {
				const fd = fs.openSync(lock, "wx");
				try {
					fs.writeSync(fd, token);
				} finally {
					fs.closeSync(fd);
				}
				return () => {
					try {
						if (fs.readFileSync(lock, "utf8") === token) fs.rmSync(lock, { force: true });
					} catch (_) {}
				};
			} catch (err) {
				if (err.code !== "EEXIST") throw err;
			}
			if (removeStaleLock(lock, staleMs)) continue;
			if (Date.now() - start >= waitMs) {
				throw new Error("outra publicação em andamento (trava ocupada)");
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	/**
	 * Publica um retrato consistente: cópia pela API de backup do SQLite (assíncrona, em passos) num
	 * temporário no mesmo diretório (mesmo sistema de arquivos), journal_mode=DELETE no temporário e
	 * rename atômico por cima do anterior. Quem já está lendo continua no arquivo antigo. Serializado
	 * entre processos pela trava acima; com ela na mão, temporário que sobrou de publicação interrompida
	 * é apagado.
	 */
	async publish({ waitMs = 5000, staleMs = 120000 } = {}) {
		fs.mkdirSync(this.publishDir, { recursive: true });
		const release = await this._acquirePublishLock(waitMs, staleMs);
		const tmp = path.join(this.publishDir, `${TMP_PREFIX}${process.pid}`);
		try {
			for (const f of fs.readdirSync(this.publishDir)) {
				if (f.startsWith(TMP_PREFIX)) fs.rmSync(path.join(this.publishDir, f), { force: true });
			}
			await this.db.backup(tmp);
			const snap = new BetterSQLite(tmp);
			try {
				snap.pragma("journal_mode = DELETE");
			} finally {
				snap.close();
			}
			fs.chmodSync(tmp, publishedMode(tmp));
			// nunca sobrescreve um arquivo que não seja um retrato do painel
			const foreign = foreignReason(this.publishedPath);
			if (foreign) throw new Error(`recusado: ${this.publishedPath} não é do painel (${foreign})`);
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
	APP_ID,
	resolvePath,
	assertSafePaths,
	foreignReason
};
