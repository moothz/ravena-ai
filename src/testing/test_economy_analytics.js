"use strict";

/**
 * Testes da carga do painel da economia (EconomyAnalytics*).
 *
 * Roda sem bot, sem rede externa e sem tocar em data/: o bank.db é sintético, os serviços são um
 * servidor HTTP local de mentira e o analytics.db fica num diretório temporário.
 *   node src/testing/test_economy_analytics.js
 * (TEST_TMPDIR muda o diretório temporário; padrão: o do sistema)
 */

process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const BetterSQLite = require("better-sqlite3");

const {
	kindFor,
	MAPPING,
	KINDS,
	LABELS,
	reasonLabelRows,
	MAPPING_VERSION
} = require("../services/EconomyAnalyticsMapping");
const { SCHEMA } = require("../services/EconomyAnalyticsStore");
const R = require("../services/EconomyAnalyticsRunas");
const EconomyAnalyticsService = require("../services/EconomyAnalyticsService");
const Changes = require("../services/EconomyAnalyticsChanges");

const H = R.HOUR_MS;
const D = R.DAY_MS;
// 2026-11-10 07:00 UTC = início de um dia econômico
const DAY0 = Date.parse("2026-11-10T07:00:00.000Z");

const tmpRoot = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "econ-test-"));

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`✓ ${name}`);
	} catch (err) {
		console.error(`✗ ${name}`);
		throw err;
	}
}

// ---------------------------------------------------------------------------
// bank.db sintético (mesmo schema do BankService)
// ---------------------------------------------------------------------------
function makeBankDb(file) {
	const db = new BetterSQLite(file);
	db.exec(`
		CREATE TABLE bank_accounts (user_id TEXT PRIMARY KEY, runas REAL DEFAULT 0,
			total_deposited_runas REAL DEFAULT 0, total_withdrawn_runas REAL DEFAULT 0, created_at INTEGER, updated_at INTEGER);
		CREATE TABLE bank_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, type TEXT NOT NULL,
			game TEXT NOT NULL, game_amount REAL NOT NULL, runas_amount REAL NOT NULL, spread_rate REAL NOT NULL,
			spread_fee_runas REAL NOT NULL, details_json TEXT, timestamp INTEGER NOT NULL, status TEXT DEFAULT 'COMPLETED',
			undone_at INTEGER DEFAULT NULL, undone_by TEXT DEFAULT NULL, undo_fee_runas REAL DEFAULT NULL, undo_final_runas REAL DEFAULT NULL);
		CREATE TABLE bank_daily_quotas (user_id TEXT NOT NULL, date TEXT NOT NULL, fish_kg_used REAL DEFAULT 0,
			initial_runas REAL DEFAULT NULL, PRIMARY KEY (user_id, date));
	`);
	return db;
}

function tx(db, user, type, game, runas, ts, extra = {}) {
	db.prepare(
		`INSERT INTO bank_transactions (user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp, status)
		 VALUES (?, ?, ?, 0, ?, 0, 0, ?, ?, ?)`
	).run(
		user,
		type,
		game,
		runas,
		JSON.stringify(extra.details || {}),
		ts,
		extra.status || "COMPLETED"
	);
}

// ---------------------------------------------------------------------------
// Serviços de mentira (waifuletes e Jardim)
// ---------------------------------------------------------------------------
function remoteSummary(currency, from, to, opts = {}) {
	const flows = [];
	const h = Math.max(R.hourStart(from), DAY0);
	if (opts.ledger !== false && h < to) {
		const f = (reason, amountIn, amountOut) => ({
			hour: h,
			reason,
			amountIn,
			amountOut,
			count: 1,
			users: 1
		});
		flows.push(f("DAILY_REWARD", 1000, 0), f("HOSTING_FEE", 0, 300), f("NEW_REASON_X", 50, 0));
		flows.push(f("HOSTING_FEE_WAIFU", 7777, 0), f("MARKET_TRADE", 100, 105));
	}
	return {
		currency,
		schemaVersion: 1,
		generatedAt: opts.generatedAt,
		window: { from, to },
		ledger: { available: opts.ledger !== false, flows },
		balances: {
			total: 100000,
			holders: 60,
			accounts: 70,
			p50: 1200,
			p90: 4000,
			top10Share: 0.4,
			quintiles: [1, 2, 3, 4, 5].map((q) => ({ q, n: 12, min: q, max: q * 10, sum: q * 1000 }))
		},
		// waifuletes: receivedByQuintile só com received=1 (opt-in)
		receivedByQuintile:
			opts.received && to - from <= 8 * D
				? [1, 2, 3, 4, 5].map((q) => ({ q, n: 12, receivedSum: q * 100, receivedMedian: q }))
				: []
	};
}

function startMockServer(state) {
	const server = http.createServer(async (req, res) => {
		const u = new URL(req.url, "http://x");
		const from = Number(u.searchParams.get("from"));
		const to = Number(u.searchParams.get("to"));
		const received = u.searchParams.get("received") === "1";
		const withBalances = u.searchParams.get("balances") !== "0";
		const isWaifu = req.headers.authorization === "Bearer test-waifu-key";
		const isJardim = req.headers["x-api-key"] === "test-jardim-key";
		const svc = isWaifu ? "waifuletes" : isJardim ? "jardim" : null;
		if (svc && u.pathname === "/internal/economy/params") {
			const p = state.params && state.params[svc];
			if (!p) res.writeHead(404).end("{}");
			else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(p));
			return;
		}
		if (!svc || u.pathname !== "/internal/economy/summary") {
			res.writeHead(401).end("{}");
			return;
		}
		state.calls.push({ svc, from, to, received, balances: withBalances });
		if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
		const fail = state.fail[svc];
		if (fail === true || (typeof fail === "function" && fail(from, to))) {
			res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
			return;
		}
		const body =
			svc === "waifuletes"
				? remoteSummary("zinthos", from, to, { generatedAt: state.now(), received })
				: remoteSummary("petalitas", from, to, {
						generatedAt: state.now(),
						ledger: false,
						received
					});
		if (!withBalances) body.balances = null; // balances=0: serviço pula saldos e quintos
		if (state.override[svc]) Object.assign(body, state.override[svc](body));
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
	});
	// Testes de SQL entre duas cargas podem passar dos 5 s padrão: o fetch reusaria um socket já fechado (ECONNRESET)
	server.keepAliveTimeout = 120000;
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function readAll(file, sql, params = []) {
	const db = new BetterSQLite(file, { readonly: true });
	try {
		return db.prepare(sql).all(...params);
	} finally {
		db.close();
	}
}

const DASHBOARD = path.join(__dirname, "../../observability/grafana/dashboards/economia.json");
const DASHBOARD_JOGADORES = path.join(
	__dirname,
	"../../observability/grafana/dashboards/jogador.json"
);
const REPO_ROOT = path.join(__dirname, "../..");
// Com as mudanças automáticas (EconomyAnalyticsChanges.js) a ficha ganha a coluna Origem e "confirmar?"
const AUTO_CHANGES = fs.existsSync(path.join(REPO_ROOT, "src/services/EconomyAnalyticsChanges.js"));

/** Painéis do dashboard (formato v2 do Grafana: spec.elements), num formato plano para os testes. */
function dashboardPanels(file = DASHBOARD) {
	const dash = JSON.parse(fs.readFileSync(file, "utf8"));
	return Object.entries(dash.spec.elements).map(([name, el]) => ({
		name,
		id: el.spec.id,
		title: el.spec.title,
		type: el.spec.vizConfig.group,
		description: el.spec.description,
		fieldConfig: el.spec.vizConfig.spec.fieldConfig,
		options: el.spec.vizConfig.spec.options,
		timeFrom: el.spec.data.spec.queryOptions.timeFrom,
		targets: el.spec.data.spec.queries.map((q) => ({ refId: q.spec.refId, ...q.spec.query.spec }))
	}));
}

/** Abas → seções → nomes dos elementos, na ordem do layout. */
function dashboardLayout(file = DASHBOARD) {
	const dash = JSON.parse(fs.readFileSync(file, "utf8"));
	const grid = (l) => l.spec.items.map((i) => i.spec.element.name);
	const sections = (l) =>
		l.kind === "RowsLayout"
			? l.spec.rows.map((r) => ({
					title: r.spec.title,
					collapse: r.spec.collapse,
					conditional: r.spec.conditionalRendering || null,
					elements: grid(r.spec.layout)
				}))
			: [{ title: null, collapse: false, conditional: null, elements: grid(l) }];
	const root = dash.spec.layout;
	const tabs =
		root.kind === "TabsLayout" ? root.spec.tabs : [{ spec: { title: null, layout: root } }];
	return tabs.map((t) => ({ title: t.spec.title, sections: sections(t.spec.layout) }));
}

/** Consulta de um painel com a interpolação que o frontend faz ($__from/$__to em ms, ${moeda}). */
function dashboardSql(
	title,
	{
		from,
		to,
		moeda = "zinthos",
		moedas = ["zinthos", "petalitas", "runas"],
		escala = "indice",
		jogador = "",
		file = DASHBOARD
	}
) {
	const panel = dashboardPanels(file).find((p) => p.title === title);
	assert.ok(panel, `painel "${title}" não encontrado`);
	return panel.targets[0].queryText
		.replace(/\$__from\b/g, String(from))
		.replace(/\$__to\b/g, String(to))
		.replace(/\$\{moeda:sqlstring\}/g, `'${moeda}'`)
		.replace(/\$\{moeda\}/g, moeda)
		.replace(/\$\{moedas:sqlstring\}/g, moedas.map((m) => `'${m}'`).join(","))
		.replace(/\$\{escala\}/g, escala)
		.replace(/\$\{jogador:sqlstring\}/g, `'${jogador.replace(/'/g, "''")}'`)
		.replace(/\$\{jogador\}/g, jogador)
		.replace(/\$\{busca:sqlstring\}/g, `'${jogador.replace(/'/g, "''")}'`);
}

function freshDb(name) {
	const file = path.join(tmpRoot, name);
	const db = new BetterSQLite(file);
	db.exec(SCHEMA);
	return { file, db };
}

async function main() {
	console.log("=== Testes: painel da economia (EconomyAnalytics) ===");

	// ----------------------------------------------------------------------- mapeamento
	await test("mapeamento reason → kind (conhecido, desconhecido, non_monetary, moeda sem tabela)", () => {
		assert.strictEqual(kindFor("zinthos", "DAILY_REWARD"), "creation");
		assert.strictEqual(kindFor("zinthos", "HOSTING_FEE"), "destruction");
		assert.strictEqual(kindFor("zinthos", "MARKET_TRADE"), "transfer");
		assert.strictEqual(kindFor("zinthos", "HOSTING_FEE_WAIFU"), "non_monetary");
		assert.strictEqual(kindFor("runas", "DEPOSIT:waifu"), "exchange_in");
		assert.strictEqual(kindFor("runas", "WITHDRAW:jardim"), "exchange_out");
		assert.strictEqual(kindFor("runas", "STORE_BUY:slots"), "destruction");
		assert.strictEqual(kindFor("runas", "UNDO_DEPOSIT:pesca"), "destruction");
		assert.strictEqual(kindFor("zinthos", "NEW_REASON_X"), "unknown");
		assert.strictEqual(kindFor("zinthos", "toString"), "unknown"); // não herda do prototype
		assert.strictEqual(kindFor("petalitas", "QUALQUER"), "unknown");
		assert.strictEqual(kindFor("ouro", "DAILY_REWARD"), "unknown");
		for (const r of [
			"DAILY_REWARD",
			"DIVORCE",
			"ROLL_CRYSTAL",
			"ADMIN_GRANT",
			"EVENT_REWARD",
			"WISHLIST_BONUS",
			"SOULMATE_BONUS",
			"MARKET_TRADE",
			"MARKET_BUY",
			"MARKET_REFUND",
			"HOSTING_FEE",
			"HOSTING_FEE_WAIFU"
		]) {
			assert.notStrictEqual(kindFor("zinthos", r), "unknown", r);
		}
		assert.strictEqual(kindFor("zinthos", "ADMIN_GRANT:bank_withdraw_zinthos"), "exchange_in");
		assert.strictEqual(kindFor("zinthos", "ADMIN_GRANT:bank_deposit_runas"), "exchange_out");
		assert.strictEqual(
			kindFor("zinthos", "ADMIN_GRANT:bank_undo_withdraw_zinthos"),
			"exchange_out"
		);
		assert.strictEqual(kindFor("zinthos", "ADMIN_GRANT:donor_bonus"), "creation");
		assert.strictEqual(kindFor("zinthos", "ADMIN_GRANT:admin_panel_edit"), "creation");
		assert.strictEqual(kindFor("zinthos", "ADMIN_GRANT:other"), "creation");
		assert.strictEqual(kindFor("zinthos", "ADMIN_GRANT:evento_natal"), "unknown"); // sufixo novo aparece
		assert.strictEqual(kindFor("zinthos", "DAILY_REWARD:x"), "unknown");
		for (const t of Object.values(MAPPING))
			for (const k of Object.values(t)) assert.ok(KINDS.includes(k));
	});

	await test("sentido de cada type de bank_transactions", () => {
		const c = (type, game, runas_amount, details) =>
			R.classifyRunasTx({
				type,
				game,
				runas_amount,
				details_json: details && JSON.stringify(details)
			});
		assert.deepStrictEqual(c("DEPOSIT", "pesca", 10), {
			reason: "DEPOSIT:pesca",
			amountIn: 10,
			amountOut: 0
		});
		assert.deepStrictEqual(c("WITHDRAW", "waifu", 10), {
			reason: "WITHDRAW:waifu",
			amountIn: 0,
			amountOut: 10
		});
		assert.deepStrictEqual(c("STORE_BUY", "slots", 55), {
			reason: "STORE_BUY:slots",
			amountIn: 0,
			amountOut: 55
		});
		assert.deepStrictEqual(c("ADMIN_ADJUST", "admin", -7), {
			reason: "ADMIN_ADJUST:admin",
			amountIn: 0,
			amountOut: 7
		});
		assert.deepStrictEqual(c("TRANSFER_OUT", "market", 5), {
			reason: "TRANSFER_OUT:market",
			amountIn: 0,
			amountOut: 5
		});
		assert.deepStrictEqual(c("UNDO_TRADE", "pesca", 21, { originalType: "DEPOSIT" }), {
			reason: "UNDO_DEPOSIT:pesca",
			amountIn: 0,
			amountOut: 21
		});
		assert.deepStrictEqual(c("UNDO_TRADE", "slots", 52, { originalType: "STORE_BUY" }), {
			reason: "UNDO_STORE_BUY:slots",
			amountIn: 52,
			amountOut: 0
		});
		assert.strictEqual(c("NOVO_TIPO", "x", 3).amountIn, 3);
	});

	// ----------------------------------------------------------------------- estatística
	await test("quintos sempre preenchidos (faixa pequena inclusive); percentis, top10Share; total inclui saldo negativo", () => {
		const small = R.balanceStats([0, 0, ...Array.from({ length: 30 }, (_, i) => i + 1)]);
		assert.strictEqual(small.accounts, 32);
		assert.strictEqual(small.holders, 30);
		assert.strictEqual(small.total, 465);
		assert.ok(
			small.quintiles.every((q) => q.n === 6 && q.min !== null && q.max !== null && q.sum !== null)
		);
		assert.deepStrictEqual(small.quintiles[0], { q: 1, n: 6, min: 1, max: 6, sum: 21 });
		assert.strictEqual(small.p50, 15);
		assert.strictEqual(small.p90, 27);
		assert.strictEqual(small.top10Share, Number(((28 + 29 + 30) / 465).toFixed(4)));

		const big = R.balanceStats(Array.from({ length: 60 }, (_, i) => i + 1));
		assert.deepStrictEqual(big.quintiles[0], { q: 1, n: 12, min: 1, max: 12, sum: 78 });
		assert.deepStrictEqual(big.quintiles[4], { q: 5, n: 12, min: 49, max: 60, sum: 654 });

		const mixed = R.balanceStats(Array.from({ length: 49 }, (_, i) => i + 1));
		assert.deepStrictEqual(
			mixed.quintiles.map((q) => q.n),
			[9, 10, 10, 10, 10]
		);
		assert.strictEqual(mixed.quintiles[0].sum, 45);
		assert.notStrictEqual(mixed.quintiles[1].sum, null);
		// Quinto vazio (menos de 5 contas com saldo) continua nulo
		assert.strictEqual(R.balanceStats([7]).quintiles[0].sum, null);

		// Saldo negativo entra no total (como nos serviços), não na concentração
		const neg = R.balanceStats([-50, 10, 30]);
		assert.strictEqual(neg.total, -10);
		assert.strictEqual(neg.holders, 2);
		assert.strictEqual(neg.accounts, 3);
		assert.strictEqual(neg.top10Share, 0.75);

		const empty = R.balanceStats([]);
		assert.strictEqual(empty.total, 0);
		assert.strictEqual(empty.top10Share, null);
	});

	await test("receivedByQuintile: preenchido em grupo pequeno, mediana inclui quem não recebeu", () => {
		const bal = new Map(Array.from({ length: 50 }, (_, i) => [`u${i}`, i + 1]));
		bal.set("zero", 0);
		const got = new Map([
			["u0", 100],
			["u1", 50],
			["zero", 999],
			["u49", 7]
		]);
		const out = R.receivedByQuintile(bal, got);
		assert.deepStrictEqual(out[0], { q: 1, n: 10, receivedSum: 150, receivedMedian: 0 });
		assert.deepStrictEqual(out[4], { q: 5, n: 10, receivedSum: 7, receivedMedian: 0 });
		const few = R.receivedByQuintile(
			new Map([
				["a", 1],
				["b", 2]
			]),
			new Map([["a", 5]])
		);
		// 2 contas: quintos 1, 2 e 4 vazios (nulos); os com conta vêm preenchidos
		assert.deepStrictEqual(
			few.map((q) => q.n),
			[0, 0, 1, 0, 1]
		);
		assert.deepStrictEqual(few[2], { q: 3, n: 1, receivedSum: 5, receivedMedian: 5 });
		assert.strictEqual(few[0].receivedSum, null);
	});

	// ----------------------------------------------------------------------- Runas do bank.db
	const bank = makeBankDb(path.join(tmpRoot, "bank.db"));
	// 200 transações antigas para a busca binária por id ter o que pular
	for (let i = 0; i < 200; i++) tx(bank, "old", "DEPOSIT", "pesca", 1, DAY0 - 30 * D + i * H);
	const t1 = DAY0 + 2 * H + 10 * 60 * 1000; // 09:10 UTC
	const t2 = DAY0 + 3 * H + 1; // 10:00 UTC (+1 ms)
	tx(bank, "u1", "DEPOSIT", "pesca", 100.4, t1);
	tx(bank, "u2", "DEPOSIT", "pesca", 50.4, t1 + 1000);
	tx(bank, "u1", "DEPOSIT", "pesca", 10, t1 + 2000, { status: "UNDONE" }); // aconteceu e foi desfeita
	tx(bank, "u1", "UNDO_TRADE", "pesca", 10.5, t2, { details: { originalType: "DEPOSIT" } });
	tx(bank, "u3", "WITHDRAW", "waifu", 200, t2);
	tx(bank, "u3", "ADMIN_ADJUST", "admin", -30, t2);
	tx(bank, "u2", "BONUS", "slots_prize", 40, t2);
	tx(bank, "u2", "TRANSFER_OUT", "market", 5, t2);
	tx(bank, "u1", "TRANSFER_IN", "market", 5, t2);
	tx(bank, "u4", "DEPOSIT", "pesca", 999, t2, { status: "PENDING" }); // status desconhecido: fora
	tx(bank, "u4", "MYSTERY", "x", 3, t2);
	const acc = bank.prepare(
		"INSERT INTO bank_accounts (user_id, runas, created_at) VALUES (?, ?, ?)"
	);
	for (let i = 0; i < 60; i++) acc.run(`h${i}`, i + 1, null); // contas antigas (created_at nulo)
	acc.run("u1", 0.4, DAY0 - D);
	acc.run("neg", -100, DAY0 - D); // saldo negativo
	acc.run("late", 7, DAY0 + H); // criada depois da virada do dia 10
	const q = bank.prepare(
		"INSERT INTO bank_daily_quotas (user_id, date, initial_runas) VALUES (?, ?, ?)"
	);
	// Dia 10: virada gravou initial_runas para as 62 contas que existiam; 'late' tem linha NULL
	for (let i = 0; i < 60; i++) q.run(`h${i}`, "2026-11-10", i + 1);
	q.run("u1", "2026-11-10", 0.4);
	q.run("neg", "2026-11-10", -100);
	q.run("late", "2026-11-10", null);
	// Dia 09: só 3 linhas (antes da virada gravar todo mundo) → cobertura baixa, dia ignorado
	for (const u of ["h0", "h1", "h2"]) q.run(u, "2026-11-09", 1000);
	const bankQuery = (sql, params = []) => bank.prepare(sql).all(...params);

	await test("agregação de Runas por hora e motivo (bank.db sintético)", () => {
		const flows = R.runasFlows(bankQuery, DAY0, DAY0 + D);
		const get = (hour, reason) => flows.find((f) => f.hour === hour && f.reason === reason);
		const h1 = DAY0 + 2 * H;
		const h2 = DAY0 + 3 * H;
		assert.deepStrictEqual(get(h1, "DEPOSIT:pesca"), {
			hour: h1,
			reason: "DEPOSIT:pesca",
			amountIn: 161,
			amountOut: 0,
			count: 3,
			users: 2
		});
		assert.deepStrictEqual(get(h2, "UNDO_DEPOSIT:pesca"), {
			hour: h2,
			reason: "UNDO_DEPOSIT:pesca",
			amountIn: 0,
			amountOut: 11,
			count: 1,
			users: 1
		});
		assert.strictEqual(get(h2, "WITHDRAW:waifu").amountOut, 200);
		assert.strictEqual(get(h2, "ADMIN_ADJUST:admin").amountOut, 30);
		assert.strictEqual(get(h2, "BONUS:slots_prize").amountIn, 40);
		assert.strictEqual(get(h2, "MYSTERY:x").amountIn, 3);
		assert.ok(!flows.some((f) => f.amountIn === 999), "status PENDING não entra");
		assert.strictEqual(R.runasFlows(bankQuery, h1, h2).length, 1); // to exclusivo
		assert.ok(!JSON.stringify(flows).includes("u1"));
		// from=0 pega o histórico inteiro
		assert.strictEqual(
			R.runasFlows(bankQuery, 0, DAY0).reduce((s, f) => s + f.count, 0),
			200
		);
	});

	await test("janela de transações sem varredura: busca binária no id + plano de consulta", () => {
		const firstNew = bank
			.prepare("SELECT MIN(id) id FROM bank_transactions WHERE timestamp >= ?")
			.get(DAY0).id;
		const lo = R.firstIdFrom(bankQuery, DAY0);
		assert.ok(lo <= firstNew, "nunca pula transação da janela");
		assert.ok(lo > 150, `deveria pular o histórico (id ${lo})`);
		const plan = bankQuery(
			`EXPLAIN QUERY PLAN SELECT * FROM bank_transactions WHERE id >= ? AND timestamp >= ? AND timestamp < ?`,
			[lo, DAY0, DAY0 + D]
		)
			.map((r) => r.detail)
			.join(" | ");
		assert.match(plan, /INTEGER PRIMARY KEY|rowid/i, plan);
	});

	await test("busca por id: relógio que voltou para trás cai para leitura desde o id 0", () => {
		const db = makeBankDb(path.join(tmpRoot, "bank-clock.db"));
		for (let i = 0; i < 10; i++) tx(db, "a", "DEPOSIT", "pesca", 1, DAY0 - 10 * D + i * H);
		// relógio adiantado gravou uma linha "no futuro" (id 11), depois voltou: a busca binária passa
		// por cima dela e acharia só o fim da tabela
		tx(db, "a", "DEPOSIT", "pesca", 7, DAY0 + 2 * H);
		for (let i = 0; i < 90; i++) tx(db, "a", "DEPOSIT", "pesca", 1, DAY0 - 5 * D + i * H);
		const qq = (sql, p = []) => db.prepare(sql).all(...p);
		assert.strictEqual(
			R.firstIdFrom(qq, DAY0),
			0,
			"linha fora de ordem abaixo do resultado: lê desde 0"
		);
		const flows = R.runasFlows(qq, DAY0, DAY0 + D);
		assert.strictEqual(
			flows.reduce((s, f) => s + f.amountIn, 0),
			7,
			"a linha fora de ordem não se perde"
		);
		db.close();
	});

	await test("retratos de Runas: total com negativos, reconstrução na hora cheia, dias com cobertura", () => {
		const now = DAY0 + 5 * H + 5 * 60 * 1000;
		const s = R.buildRunasSummary(bankQuery, DAY0, DAY0 + D, now);
		assert.strictEqual(s.currency, "runas");
		assert.strictEqual(s.balances.accounts, 63);
		assert.strictEqual(s.balances.holders, 62); // 60 h + u1 + late
		assert.strictEqual(s.balances.total, Math.round(1830 + 0.4 - 100 + 7));
		assert.strictEqual(s.receivedByQuintile.length, 0, "received só quando pedido");
		// Reconstrução: saldos às 10:00 = atuais − extrato em [10:00, agora)
		const at = R.balancesAt(bankQuery, DAY0 + 3 * H, now);
		assert.strictEqual(Math.round(at.get("u1") * 10) / 10, 0.4 + 10.5 - 5);
		assert.strictEqual(at.get("u3"), 200 + 30);
		const live = R.buildRunasSummary(bankQuery, DAY0, DAY0 + 3 * H, now, {
			balancesAt: DAY0 + 3 * H
		});
		assert.strictEqual(live.generatedAt, DAY0 + 3 * H);
		const rec = R.buildRunasSummary(bankQuery, DAY0, DAY0 + D, now, { received: true });
		assert.strictEqual(rec.receivedByQuintile.length, 5);
		assert.strictEqual(rec.ledger.flows.length, 0);
		// Retratos diários: só o dia 10 (o 09 tem 3/61 contas)
		const snaps = R.dailySnapshots(bankQuery, 0, DAY0 + 2 * D);
		assert.deepStrictEqual(
			snaps.map((x) => x.ts),
			[DAY0]
		);
		assert.strictEqual(snaps[0].balances.total, Math.round(1830 + 0.4 - 100));
		assert.strictEqual(snaps[0].balances.accounts, 62);
		// Sem virada na janela: nem consulta
		let calls = 0;
		R.dailySnapshots((sql, p) => (calls++, bankQuery(sql, p)), DAY0 + H, DAY0 + 2 * H);
		assert.strictEqual(calls, 0);
		assert.deepStrictEqual(R.boundaryDates(DAY0 - 1, DAY0 + D + 1), {
			first: "2026-11-10",
			last: "2026-11-11"
		});
	});

	// ----------------------------------------------------------------------- jogadores
	await test("identidade: LID → telefone, celular BR de 12 dígitos vira 13, Telegram, LID sem telefone", () => {
		const P = require("../services/EconomyAnalyticsPlayers");
		const r = new P.IdentityResolver([
			{
				canonical_user_id: "wa_5511987654321",
				platform: "whatsapp",
				platform_id: "123456789012345@lid",
				id_type: "lid",
				display_name: "Ana"
			},
			{
				canonical_user_id: "wa_5511987654321",
				platform: "whatsapp",
				platform_id: "5511987654321@s.whatsapp.net",
				id_type: "jid",
				display_name: "Ana"
			},
			{
				canonical_user_id: "tg_777",
				platform: "telegram",
				platform_id: "777",
				id_type: "tg_id",
				display_name: "Bia"
			}
		]);
		assert.deepStrictEqual(r.resolve("123456789012345@lid"), {
			person: "5511987654321",
			phone: "5511987654321",
			idKind: "lid",
			name: "Ana"
		});
		assert.deepStrictEqual(r.resolve("551187654321:12@s.whatsapp.net"), {
			person: "5511987654321",
			phone: "5511987654321",
			idKind: "telefone",
			name: "Ana"
		});
		assert.deepStrictEqual(r.resolve("777"), {
			person: "tg:777",
			phone: null,
			idKind: "telegram",
			name: "Bia"
		});
		assert.deepStrictEqual(r.resolve("999999999999999"), {
			person: "lid:999999999999999",
			phone: null,
			idKind: "lid sem telefone",
			name: null
		});
		r.addTelegram(["4242@x"]);
		assert.strictEqual(r.resolve("4242").idKind, "telegram");
		assert.strictEqual(P.canonicalPhone("551155550123"), "5511955550123");
		assert.strictEqual(P.canonicalPhone("12025550123"), "12025550123");
	});

	await test("Runas por jogador e dia: soma bate com os fluxos da moeda e saldo no fim de cada dia", () => {
		const P = require("../services/EconomyAnalyticsPlayers");
		const pb = makeBankDb(path.join(tmpRoot, "bank-players.db"));
		pb.prepare("INSERT INTO bank_accounts (user_id, runas, created_at) VALUES (?, ?, ?)").run(
			"5511987654321",
			500,
			0
		);
		pb.prepare("INSERT INTO bank_accounts (user_id, runas, created_at) VALUES (?, ?, ?)").run(
			"u2",
			0,
			0
		);
		tx(pb, "5511987654321", "DEPOSIT", "pesca", 100, DAY0 + H);
		tx(pb, "5511987654321", "STORE_BUY", "slots", 30, DAY0 + 2 * H);
		tx(pb, "u2", "BONUS", "slots_prize", 40, DAY0 + D + H);
		tx(pb, "u2", "WITHDRAW", "waifu", 40, DAY0 + D + 2 * H);
		tx(pb, "5511987654321", "DEPOSIT", "pesca", 50, DAY0 + 2 * D + H);
		const q = (sql, params = []) => pb.prepare(sql).all(...params);
		const now = DAY0 + 2 * D + 3 * H;
		const wins = P.dayWindows(DAY0, now);
		assert.deepStrictEqual(
			wins.map((w) => [w.from, w.to, w.complete]),
			[
				[DAY0, DAY0 + D, true],
				[DAY0 + D, DAY0 + 2 * D, true],
				[DAY0 + 2 * D, now, false]
			]
		);
		const out = P.runasPlayerDays(q, wins, now);
		for (let i = 0; i < wins.length; i++) {
			const flows = R.runasFlows(q, wins[i].from, wins[i].to);
			const sum = (arr, k) => arr.reduce((a, f) => a + f[k], 0);
			assert.strictEqual(sum(out[i].flows, "amountIn"), sum(flows, "amountIn"));
			assert.strictEqual(sum(out[i].flows, "amountOut"), sum(flows, "amountOut"));
			const at = R.balancesAt(q, wins[i].to, now);
			for (const p of out[i].players)
				assert.strictEqual(p.balanceAtWindowEnd, Math.round(at.get(p.id) || 0));
		}
		const d0 = out[0].players.find((p) => p.id === "5511987654321");
		assert.deepStrictEqual([d0.balance, d0.balanceAtWindowEnd], [500, 450]);
		// u2: saldo 0 hoje, mas teve movimento no dia 1 → aparece no dia 1, não no dia 2
		assert.ok(out[1].players.some((p) => p.id === "u2"));
		assert.ok(!out[2].players.some((p) => p.id === "u2"));
		pb.close();
	});

	await test("carga por jogador: dias, saldo, identidade unida entre moedas, atividade, ciclo da alma gêmea e disponibilidade", async () => {
		let pclock = DAY0 + 2 * D + 3 * H + 5 * 60 * 1000;
		const pcalls = [];
		const LID = "123456789012345";
		const PHONE = "5511987654321";
		const pserver = http.createServer((req, res) => {
			const u = new URL(req.url, "http://x");
			const from = Number(u.searchParams.get("from"));
			const to = Number(u.searchParams.get("to"));
			const isWaifu = req.headers.authorization === "Bearer test-waifu-key";
			const isJardim = req.headers["x-api-key"] === "test-jardim-key";
			const currency = isWaifu ? "zinthos" : isJardim ? "petalitas" : null;
			if (!currency) return res.writeHead(401).end("{}");
			pcalls.push([currency, u.pathname, from, to]);
			let body;
			if (u.pathname === "/internal/economy/summary") {
				body = remoteSummary(currency, from, to, { generatedAt: pclock, ledger: isWaifu });
				if (u.searchParams.get("balances") === "0") body.balances = null;
				if (isWaifu) {
					const h = R.hourStart(Math.max(from, DAY0 + D));
					body.soulmateCycle =
						h < to
							? [
									{
										hour: h,
										divorces: 2,
										paid: 900,
										quotaCost: 1000,
										aboveCost: 1,
										maxReturn: 1.5,
										withoutQuota: 1
									}
								]
							: [];
				}
			} else if (u.pathname === "/internal/economy/players") {
				body = isWaifu
					? {
							currency,
							schemaVersion: 1,
							generatedAt: pclock,
							window: { from, to },
							ledger: { available: true },
							players: [
								{
									id: `${LID}@lid`,
									name: "Ana W",
									platform: "WHATSAPP",
									balance: 900,
									balanceAtWindowEnd: 800 + (from - DAY0) / D,
									lastActiveAt: from
								}
							],
							flows: [
								{ id: `${LID}@lid`, reason: "DAILY_REWARD", amountIn: 100, amountOut: 0, count: 1 },
								{ id: `${LID}:3@lid`, reason: "DAILY_REWARD", amountIn: 5, amountOut: 0, count: 1 }
							]
						}
					: {
							currency,
							schemaVersion: 1,
							generatedAt: pclock,
							window: { from, to },
							ledger: { available: false },
							players: [
								{
									id: PHONE,
									name: "Ana J",
									platform: null,
									balance: 70,
									balanceAtWindowEnd: null,
									lastActiveAt: null
								}
							],
							flows: []
						};
			} else return res.writeHead(404).end("{}");
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
		});
		await new Promise((r) => pserver.listen(0, "127.0.0.1", r));
		const pbase = `http://127.0.0.1:${pserver.address().port}`;
		const pbank = makeBankDb(path.join(tmpRoot, "bank-p2.db"));
		pbank
			.prepare("INSERT INTO bank_accounts (user_id, runas, created_at) VALUES (?, ?, ?)")
			.run("551187654321", 300, 0);
		tx(pbank, "551187654321", "DEPOSIT", "pesca", 100, DAY0 + D + H);
		const cmd = new BetterSQLite(path.join(tmpRoot, "cmd_usage.db"));
		cmd.exec(`CREATE TABLE cmd_usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, type TEXT NOT NULL,
			command TEXT NOT NULL, user TEXT NOT NULL, group_id TEXT, args TEXT, return_data TEXT)`);
		const cmdIns = cmd.prepare(
			"INSERT INTO cmd_usage_log (timestamp, type, command, user, args) VALUES (?, ?, ?, ?, ?)"
		);
		cmdIns.run(DAY0 + D + H, "fixed", "mu", `${LID}@lid`, "");
		cmdIns.run(DAY0 + D + H + 1, "fixed", "mu", `${LID}@lid`, "");
		cmdIns.run(DAY0 + D + H + 2, "fixed", "pescar", "5521911112222", "");
		cmdIns.run(DAY0 + D + H + 3, "auto", "mu", "5521911112222", ""); // automático: fora
		cmdIns.run(DAY0 + D + H + 4, "fixed", "interagir", "5521911112222", "false"); // passivo: fora
		const mem = [
			{
				canonical_user_id: `wa_${PHONE}`,
				platform: "whatsapp",
				platform_id: `${LID}@lid`,
				id_type: "lid",
				display_name: "Ana"
			}
		];
		const pdb = path.join(tmpRoot, "players", "analytics.db");
		const ppub = path.join(tmpRoot, "players-pub");
		const mk = () =>
			new EconomyAnalyticsService({
				dbPath: pdb,
				publishDir: ppub,
				bankQuery: (sql, params = []) => pbank.prepare(sql).all(...params),
				cmdUsageQuery: (sql, params = []) => cmd.prepare(sql).all(...params),
				memoryQuery: () => mem,
				now: () => pclock,
				backfillStart: DAY0 - 10 * D,
				waifuletesUrl: pbase,
				waifuletesKey: "test-waifu-key",
				jardimUrl: pbase,
				jardimKey: "test-jardim-key",
				playerDays: 3
			});
		const ps = mk();
		try {
			const r = await ps.runOnce();
			const hourNow = DAY0 + 2 * D + 3 * H;
			assert.ok(
				r["zinthos.players"].ok &&
					r["runas.players"].ok &&
					r["petalitas.players"].ok &&
					r.atividade.ok
			);
			// 3 dias de retenção: DAY0, DAY0+D e o dia corrente até a hora cheia
			assert.deepStrictEqual(
				pcalls
					.filter((c) => c[0] === "zinthos" && c[1].endsWith("/players"))
					.map((c) => [c[2], c[3]]),
				[
					[DAY0, DAY0 + D],
					[DAY0 + D, DAY0 + 2 * D],
					[DAY0 + 2 * D, hourNow]
				]
			);
			// Jardim sem extrato: só o dia corrente
			assert.deepStrictEqual(
				pcalls
					.filter((c) => c[0] === "petalitas" && c[1].endsWith("/players"))
					.map((c) => [c[2], c[3]]),
				[[DAY0 + 2 * D, hourNow]]
			);
			// LID com e sem dispositivo somam no mesmo ID cru
			assert.deepStrictEqual(
				readAll(
					pdb,
					"SELECT day, player_id, amount_in, tx_count FROM player_daily WHERE currency='zinthos' ORDER BY day"
				).map((x) => [x.day, x.player_id, x.amount_in, x.tx_count]),
				[
					[DAY0, LID, 105, 2],
					[DAY0 + D, LID, 105, 2],
					[DAY0 + 2 * D, LID, 105, 2]
				]
			);
			assert.deepStrictEqual(
				readAll(
					pdb,
					"SELECT day, balance FROM player_balance_daily WHERE currency='zinthos' ORDER BY day"
				).map((x) => [x.day, x.balance]),
				[
					[DAY0, 800],
					[DAY0 + D, 801],
					[DAY0 + 2 * D, 802]
				]
			);
			assert.strictEqual(
				readAll(pdb, "SELECT COUNT(*) n FROM player_balance_daily WHERE currency='petalitas'")[0].n,
				1
			);
			// Runas por jogador: dia DAY0+D
			assert.deepStrictEqual(
				readAll(
					pdb,
					"SELECT day, reason, kind, amount_in FROM player_daily WHERE currency='runas'"
				).map((x) => [x.day, x.reason, x.kind, x.amount_in]),
				[[DAY0 + D, "DEPOSIT:pesca", "creation", 100]]
			);
			// Uma pessoa só: LID do waifuletes, telefone de 13 dígitos no Jardim e de 12 no bank.db
			const ids = readAll(
				pdb,
				"SELECT player_id, person, phone, id_kind, name FROM identities ORDER BY player_id"
			);
			assert.deepStrictEqual(
				ids.filter((x) => x.person === PHONE).map((x) => [x.player_id, x.id_kind]),
				[
					[LID, "lid"],
					["551187654321", "telefone"],
					[PHONE, "telefone"]
				]
			);
			assert.ok(ids.filter((x) => x.person === PHONE).every((x) => x.name === "Ana"));
			// Atividade: sem automáticos nem interação passiva
			assert.deepStrictEqual(
				readAll(pdb, "SELECT hour, uses, users FROM activity_hourly").map((x) => [
					x.hour,
					x.uses,
					x.users
				]),
				[[DAY0 + D + H, 3, 2]]
			);
			assert.deepStrictEqual(
				readAll(pdb, "SELECT player_id, uses FROM player_activity_daily ORDER BY player_id").map(
					(x) => [x.player_id, x.uses]
				),
				[
					[LID, 2],
					["5521911112222", 1]
				]
			);
			// Ciclo da alma gêmea gravado e marcado como disponível
			assert.deepStrictEqual(
				readAll(
					pdb,
					"SELECT SUM(above_cost) a, SUM(without_quota) w FROM soulmate_cycle_hourly"
				)[0],
				{ a: 1, w: 1 }
			);
			const feats = Object.fromEntries(
				readAll(pdb, "SELECT key, available FROM features").map((x) => [x.key, x.available])
			);
			assert.deepStrictEqual(feats, {
				jogadores: 1,
				ciclo_alma_gemea: 1,
				atividade: 1,
				fluxos_petalitas: 0,
				causa_sem_origem: 0,
				mudancas_automaticas: 1 // Runas: economyConstants.js sempre legível // serviços de mentira sem a rota de parâmetros; BankService fora do bot
			});

			// Próxima hora: só o dia corrente é refeito, sem duplicar
			pcalls.length = 0;
			pclock += H;
			cmdIns.run(DAY0 + 2 * D + 3 * H + 10, "fixed", "mu", `${LID}@lid`, "");
			await ps.runOnce();
			assert.deepStrictEqual(
				pcalls
					.filter((c) => c[0] === "zinthos" && c[1].endsWith("/players"))
					.map((c) => [c[2], c[3]]),
				[[DAY0 + 2 * D, hourNow + H]]
			);
			assert.strictEqual(
				readAll(pdb, "SELECT COUNT(*) n FROM player_daily WHERE currency='zinthos'")[0].n,
				3
			);
			assert.deepStrictEqual(
				readAll(
					pdb,
					"SELECT day, uses FROM player_activity_daily WHERE player_id = ? ORDER BY day",
					[LID]
				).map((x) => [x.day, x.uses]),
				[
					[DAY0 + D, 2],
					[DAY0 + 2 * D, 1]
				]
			);

			// Virada de dois dias: retenção de 3 dias apaga o mais antigo
			pclock += 2 * D;
			await ps.runOnce();
			assert.strictEqual(readAll(pdb, "SELECT MIN(day) d FROM player_daily")[0].d, DAY0 + 2 * D);
			assert.strictEqual(
				readAll(pdb, "SELECT MIN(day) d FROM player_activity_daily")[0].d,
				DAY0 + 2 * D
			);

			// Painéis da ficha do jogador rodam no retrato publicado, com e sem jogador escolhido
			const pubP = path.join(ppub, "analytics.db");
			let n = 0;
			for (const p of dashboardPanels(DASHBOARD_JOGADORES)) {
				if (!p.targets.length) continue;
				for (const moeda of ["zinthos", "petalitas", "runas"]) {
					for (const jogador of ["", PHONE, "x'; DROP TABLE players; --"]) {
						readAll(
							pubP,
							dashboardSql(p.title, {
								from: DAY0 - D,
								to: pclock,
								moeda,
								jogador,
								file: DASHBOARD_JOGADORES
							})
						);
					}
				}
				n++;
			}
			assert.ok(n >= 6, `esperava >= 6 painéis na ficha do jogador, achou ${n}`);
			// Painéis da economia continuam rodando com as tabelas novas (ciclo, ficha, atividade, em preparação)
			for (const p of dashboardPanels()) {
				if (!p.targets.length) continue;
				readAll(pubP, dashboardSql(p.title, { from: DAY0 - D, to: pclock, moeda: "zinthos" }));
			}
		} finally {
			await ps.stop();
			pserver.close();
			pbank.close();
			cmd.close();
		}
	});

	// ----------------------------------------------------------------------- carga completa
	let clock = DAY0 + 5 * H + 5 * 60 * 1000; // 12:05 UTC
	const state = { calls: [], fail: {}, override: {}, now: () => clock, delay: 0 };
	const server = await startMockServer(state);
	const base = `http://127.0.0.1:${server.address().port}`;
	const dbPath = path.join(tmpRoot, "carga", "analytics.db");
	const publishDir = path.join(tmpRoot, "publicado"); // não existe ainda
	const pubFile = path.join(publishDir, "analytics.db");
	const BF = DAY0 - 70 * D; // fim do primeiro pedaço
	const mkService = () =>
		new EconomyAnalyticsService({
			dbPath,
			publishDir,
			bankQuery,
			now: () => clock,
			backfillStart: BF,
			waifuletesUrl: base,
			waifuletesKey: "test-waifu-key",
			jardimUrl: base,
			jardimKey: "test-jardim-key",
			sources: ["zinthos", "petalitas", "runas"],
			playerDays: 0 // detalhe por jogador tem testes próprios abaixo
		});
	let svc = mkService();

	try {
		await test("primeira carga: from=0 em pedaços sem saldos (balances=0), Jardim numa chamada só, fontes isoladas", async () => {
			state.fail.jardim = true;
			state.fail.waifuletes = (from, to) => from === BF + 30 * D; // 3º pedaço falha
			const r = await svc.runOnce();
			const hourNow = DAY0 + 5 * H;
			assert.deepStrictEqual(
				state.calls
					.filter((c) => c.svc === "waifuletes" && !c.received)
					.map((c) => [c.from, c.to, c.balances]),
				[
					[0, BF, false],
					[BF, BF + 30 * D, false],
					[BF + 30 * D, BF + 60 * D, false]
				]
			);
			assert.deepStrictEqual(
				state.calls.filter((c) => c.svc === "jardim").map((c) => [c.from, c.to, c.balances]),
				[[0, hourNow, true]],
				"Jardim sem extrato: uma chamada só, para o retrato atual"
			);
			assert.strictEqual(r.zinthos.ok, false);
			assert.strictEqual(r.zinthos.chunks, 3);
			assert.strictEqual(r.runas.ok, true);
			assert.strictEqual(r.petalitas.ok, false);
			assert.match(
				readAll(dbPath, "SELECT error FROM load_runs WHERE source='petalitas'")[0].error,
				/HTTP 500/
			);
			assert.strictEqual(readAll(dbPath, "PRAGMA journal_mode")[0].journal_mode, "wal");
			// Pedaços históricos não gravam retrato
			assert.strictEqual(
				readAll(dbPath, "SELECT COUNT(*) n FROM balances WHERE currency='zinthos'")[0].n,
				0
			);
			// Runas: retrato diário (07:00) + reconstruído exatamente na hora cheia
			assert.deepStrictEqual(
				readAll(dbPath, "SELECT ts FROM balances WHERE currency='runas' ORDER BY ts").map(
					(x) => x.ts
				),
				[DAY0, hourNow]
			);
			// Quem recebe: zinthos (extrato confirmado nos pedaços ok, received=1) e runas
			const rq = readAll(
				dbPath,
				"SELECT currency, COUNT(*) n FROM received_by_quintile GROUP BY currency ORDER BY currency"
			);
			assert.deepStrictEqual(
				rq.map((x) => [x.currency, x.n]),
				[
					["runas", 5],
					["zinthos", 5]
				]
			);
			assert.deepStrictEqual(
				state.calls.filter((c) => c.received).map((c) => [c.svc, c.from, c.to]),
				[["waifuletes", DAY0 - 7 * D, DAY0]]
			);
			// Tabelas de apoio do painel
			assert.ok(readAll(dbPath, "SELECT COUNT(*) n FROM reason_labels")[0].n >= 40);
			assert.deepStrictEqual(
				readAll(dbPath, "SELECT value FROM meta WHERE key='mapping_version'"),
				[{ value: "1" }]
			);
			// Publicado: diretório criado, retrato consistente, sem WAL e sem temporário
			assert.ok(fs.existsSync(pubFile));
			assert.deepStrictEqual(fs.readdirSync(publishDir), ["analytics.db"]);
			assert.strictEqual(readAll(pubFile, "PRAGMA journal_mode")[0].journal_mode, "delete");
			assert.deepStrictEqual(
				readAll(pubFile, "SELECT COUNT(*) n FROM load_runs"),
				readAll(dbPath, "SELECT COUNT(*) n FROM load_runs")
			);
		});

		await test("carga incremental: continua do pedaço que falhou; retrato só na janela atual; sem extrato não pede received", async () => {
			state.calls.length = 0;
			state.fail = {};
			clock += H; // 13:05
			const before = readAll(pubFile, "SELECT COUNT(*) n FROM load_runs")[0].n;
			await svc.runOnce();
			assert.ok(
				readAll(pubFile, "SELECT COUNT(*) n FROM load_runs")[0].n > before,
				"Grafana vê a nova rodada"
			);
			const hourNow = DAY0 + 6 * H;
			assert.deepStrictEqual(
				state.calls.filter((c) => c.svc === "waifuletes").map((c) => [c.from, c.to, c.balances]),
				[
					[BF + 30 * D, BF + 60 * D, false],
					[BF + 60 * D, hourNow, true]
				]
			);
			assert.deepStrictEqual(
				state.calls.filter((c) => c.svc === "jardim").map((c) => [c.from, c.to]),
				[[0, hourNow]]
			);
			const z = readAll(
				dbPath,
				"SELECT reason, kind FROM flows_hourly WHERE currency='zinthos' ORDER BY reason"
			);
			assert.deepStrictEqual(
				z.map((x) => [x.reason, x.kind]),
				[
					["DAILY_REWARD", "creation"],
					["HOSTING_FEE", "destruction"],
					["HOSTING_FEE_WAIFU", "non_monetary"],
					["MARKET_TRADE", "transfer"],
					["NEW_REASON_X", "unknown"]
				]
			);
			// Retrato dos serviços só na janela atual, no instante da resposta (sem totalAtWindowEnd)
			assert.deepStrictEqual(
				readAll(dbPath, "SELECT ts FROM balances WHERE currency='zinthos'").map((x) => x.ts),
				[clock]
			);
			assert.ok(
				!state.calls.some((c) => c.received),
				"received uma vez por dia; Jardim sem extrato não é pedido"
			);
			assert.deepStrictEqual(
				readAll(dbPath, "SELECT ok, error FROM load_runs WHERE source='petalitas.received'"),
				[{ ok: 1, error: "sem extrato" }]
			);
			// Próxima hora: uma chamada por fonte, sem repetir o "sem extrato" do dia
			state.calls.length = 0;
			clock += H; // 14:05
			await svc.runOnce();
			assert.deepStrictEqual(
				state.calls.map((c) => [c.svc, c.from, c.to]),
				[
					["waifuletes", DAY0 + 6 * H, DAY0 + 7 * H],
					["jardim", DAY0 + 6 * H, DAY0 + 7 * H]
				]
			);
			assert.strictEqual(
				readAll(dbPath, "SELECT COUNT(*) n FROM load_runs WHERE source='petalitas.received'")[0].n,
				1
			);
			const ls = readAll(dbPath, "SELECT currency, available FROM ledger_status ORDER BY currency");
			assert.deepStrictEqual(
				ls.map((x) => [x.currency, x.available]),
				[
					["petalitas", 0],
					["runas", 1],
					["zinthos", 1]
				]
			);
			const v = readAll(
				dbPath,
				dashboardSql("Situação por moeda (últimos 7 dias)", { from: 0, to: clock })
			);
			const pet = v.find((x) => x.Moeda === "Petalitas");
			assert.match(pet["Situação"], /sem extrato/);
			assert.strictEqual(pet["Maior fonte"], "sem extrato");
			// Mesma hora de novo: nada a pedir
			state.calls.length = 0;
			clock += 10 * 60 * 1000;
			const r = await svc.runOnce();
			assert.strictEqual(state.calls.length, 0);
			assert.strictEqual(r.zinthos.skipped, true);
		});

		await test("idempotência: regravar a mesma janela substitui sem duplicar", async () => {
			const snapshot = () =>
				readAll(dbPath, "SELECT * FROM flows_hourly ORDER BY hour, currency, reason");
			const before = snapshot();
			const db = new BetterSQLite(dbPath);
			db.prepare("DELETE FROM load_runs WHERE window_to = ?").run(DAY0 + 7 * H);
			db.close();
			await svc.runOnce();
			assert.deepStrictEqual(snapshot(), before);
			const flow = (reason) => ({
				hour: DAY0,
				reason,
				kind: "creation",
				amountIn: 1,
				amountOut: 0,
				count: 1,
				users: 1
			});
			svc.store.writeFlows("zinthos", DAY0, DAY0 + H, [flow("DAILY_REWARD")]);
			svc.store.writeFlows("zinthos", DAY0, DAY0 + H, [flow("DIVORCE")]);
			const rows = readAll(
				dbPath,
				"SELECT reason FROM flows_hourly WHERE currency='zinthos' AND hour=?",
				[DAY0]
			);
			assert.deepStrictEqual(
				rows.map((r) => r.reason),
				["DIVORCE"]
			);
		});

		await test("resposta fora do contrato vira erro em load_runs (e não grava nada)", async () => {
			clock += H;
			state.override.waifuletes = () => ({ schemaVersion: 2 });
			const r = await svc.runOnce();
			assert.strictEqual(r.zinthos.ok, false);
			assert.match(r.zinthos.error, /schemaVersion/);
			assert.strictEqual(r.runas.ok, true);
			state.override.waifuletes = () => ({
				ledger: {
					available: true,
					flows: [{ hour: 0, reason: "DAILY_REWARD", amountIn: 1, amountOut: 0 }]
				}
			});
			clock += H;
			const r2 = await svc.runOnce();
			assert.match(r2.zinthos.error, /fora da janela/);
			state.override.waifuletes = null;
			state.calls.length = 0;
			clock += H;
			await svc.runOnce();
			assert.strictEqual(state.calls.find((c) => c.svc === "waifuletes").from, DAY0 + 7 * H);
		});

		await test("Zinthos com totalAtWindowEnd: retrato alinhado em `to`; sem ele, no instante da resposta", async () => {
			clock += H;
			const to = R.hourStart(clock);
			state.override.waifuletes = (b) => ({ balances: { ...b.balances, totalAtWindowEnd: 98765 } });
			await svc.runOnce();
			state.override.waifuletes = null;
			const row = readAll(
				dbPath,
				"SELECT ts, total, p50 FROM balances WHERE currency='zinthos' ORDER BY ts DESC LIMIT 1"
			)[0];
			assert.deepStrictEqual(row, { ts: to, total: 98765, p50: 1200 }); // faixas/percentis do retrato ao vivo
			const pet = readAll(
				dbPath,
				"SELECT ts FROM balances WHERE currency='petalitas' ORDER BY ts DESC LIMIT 1"
			)[0];
			assert.strictEqual(pet.ts, clock); // Jardim sem totalAtWindowEnd: generatedAt
		});

		await test("Massa histórica de Zinthos: anda para trás pelos fluxos, sem a waifu confiscada, sem sobrescrever retrato real, uma vez só", async () => {
			const wdb = path.join(tmpRoot, "massa", "a.db");
			const s = new EconomyAnalyticsService({
				dbPath: wdb,
				publishDir: path.join(tmpRoot, "massa-pub"),
				sources: []
			});
			const st = s._getStore();
			const fl = st.db.prepare(
				"INSERT INTO flows_hourly VALUES (?, 'zinthos', ?, 'creation', ?, ?, 1, 1)"
			);
			fl.run(DAY0 + 2 * H, "DAILY_REWARD", 100, 0); // dia 0
			fl.run(DAY0 + D + 5 * H, "DAILY_REWARD", 50, 10); // dia 1
			fl.run(DAY0 + D + 6 * H, "HOSTING_FEE_WAIFU", 999, 0); // nunca creditou o saldo: fora
			fl.run(DAY0 + 2 * D + 1 * H, "MARKET_TRADE", 0, 30); // dia 2
			st.db
				.prepare("INSERT INTO flows_hourly VALUES (?, 'runas', 'X', 'creation', 5000, 0, 1, 1)")
				.run(DAY0 + D);
			st.writeBalance("zinthos", DAY0 + D, { total: 1, p50: 7, holders: 5 }); // retrato real: fica
			const anchor = DAY0 + 2 * D + 3 * H;
			const n = s._reconstructMass(st, "zinthos", anchor, 1000);
			const rows = st.db
				.prepare(
					"SELECT ts, total, p50, holders FROM balances WHERE currency='zinthos' ORDER BY ts"
				)
				.all();
			// dia 2: 1000 − (−30) = 1030; dia 1: real; dia 0: 1030 − 40 − 100 = 890
			assert.deepStrictEqual(rows, [
				{ ts: DAY0, total: 890, p50: null, holders: null },
				{ ts: DAY0 + D, total: 1, p50: 7, holders: 5 },
				{ ts: DAY0 + 2 * D, total: 1030, p50: null, holders: null }
			]);
			assert.strictEqual(n, 2);
			assert.strictEqual(s._reconstructMass(st, "zinthos", anchor + D, 5), 0); // só a primeira vez
			assert.strictEqual(JSON.parse(st.getMeta("mass_reconstructed:zinthos")).written, 2);
			assert.strictEqual(st.getMeta("mass_reconstructed_before:zinthos"), String(anchor));
			// Conferência de moeda sem origem: retrato reconstruído fica fora (daria zero por construção);
			// sobra só o intervalo que começa no retrato real do dia 1
			st.writeBalance("zinthos", anchor, { total: 1000, holders: 3 });
			const so = st.db
				.prepare(
					dashboardSql("Conferência: estoque × fluxos — ${moeda} (período selecionado)", {
						from: DAY0 - D,
						to: anchor + D
					})
				)
				.all();
			assert.strictEqual(so.length, 1, JSON.stringify(so));
			// Âncora exatamente na virada: não regrava o próprio dia
			const t = st.reconstructMass("zinthos", DAY0 + 2 * D, 1000);
			assert.strictEqual(t.days, 2);
			st.close();
			s.store = null;
		});

		await test("Carga na subida: roda uma vez depois do atraso, desliga com 0 e stop() cancela", async () => {
			const mk = (opts) =>
				new EconomyAnalyticsService({
					dbPath: path.join(tmpRoot, "subida", "a.db"),
					publishDir: path.join(tmpRoot, "subida-pub"),
					sources: [],
					...opts
				});
			const a = mk({ startDelayMs: 20 });
			let runs = 0;
			a.runOnce = () => (runs++, Promise.resolve({}));
			a.start();
			await new Promise((r) => setTimeout(r, 80));
			assert.strictEqual(runs, 1);
			await a.stop();
			const b = mk({ startDelayMs: 0 });
			b.runOnce = () => (runs++, Promise.resolve({}));
			b.start();
			await new Promise((r) => setTimeout(r, 40));
			assert.strictEqual(runs, 1);
			await b.stop();
			const c = mk({ startDelayMs: 30 });
			c.runOnce = () => (runs++, Promise.resolve({}));
			c.start();
			await c.stop();
			await new Promise((r) => setTimeout(r, 60));
			assert.strictEqual(runs, 1);
			assert.strictEqual(mk({ runOnStart: false }).startDelayMs, 0);
			assert.strictEqual(mk({}).startDelayMs, 60000);
		});

		await test("stop(): aborta HTTP em curso, para entre pedaços e nunca espera mais que o limite", async () => {
			// 1) Chamada lenta é abortada: stop volta rápido e fecha o banco
			clock += H;
			state.delay = 5000;
			const running = svc.runOnce();
			await new Promise((r) => setTimeout(r, 50));
			let t0 = Date.now();
			assert.strictEqual(await svc.stop(), true);
			// O que prova o abort é o resultado (zinthos falhou, sem esperar os 5 s da chamada); o limite de
			// tempo é folgado porque uma parada de E/S da máquina (WSL) já segurou o laço por segundos
			assert.ok(Date.now() - t0 < 8000, `stop demorou ${Date.now() - t0} ms`);
			const res = await running;
			assert.strictEqual(res.zinthos.ok, false);
			assert.strictEqual(res.stopped, true);
			assert.strictEqual(svc.store, null);
			assert.deepStrictEqual(await svc.runOnce(), { stopped: true }); // parado não roda mais
			state.delay = 0;
			// 2) Fonte que ignora o abort: stop desiste depois de stopWaitMs e não fecha o banco sob ela
			const stuck = mkService();
			stuck.stopWaitMs = 200;
			stuck.sources[0].fetch = () => new Promise(() => {});
			stuck.runOnce();
			await new Promise((r) => setTimeout(r, 30));
			t0 = Date.now();
			assert.strictEqual(await stuck.stop(), false);
			assert.ok(Date.now() - t0 >= 150, "stop esperou o limite antes de desistir");
			assert.ok(Date.now() - t0 < 8000, `stop demorou ${Date.now() - t0} ms`);
			assert.ok(stuck.store, "banco continua aberto (o processo vai sair)");
			stuck.store.close();
			// Reabre o mesmo banco: a próxima rodada continua de onde parou
			svc = mkService();
			state.calls.length = 0;
			const r = await svc.runOnce();
			assert.strictEqual(r.zinthos.ok, true);
			assert.strictEqual(
				state.calls.find((c) => c.svc === "waifuletes").from,
				R.hourStart(clock) - H
			);
		});

		await test("publicação: backup assíncrono, trava por PID sem bloquear a thread, temporário órfão some", async () => {
			const lock = `${dbPath}.publish.lock`;
			// Trava de processo vivo (o pai deste processo) e recente: espera e desiste
			fs.writeFileSync(lock, `${process.ppid} outro`);
			let ticks = 0;
			const timer = setInterval(() => ticks++, 20);
			await assert.rejects(svc.store.publish({ waitMs: 300 }), /trava ocupada/);
			clearInterval(timer);
			assert.ok(ticks >= 5, `a espera não pode bloquear o laço de eventos (ticks=${ticks})`);
			assert.strictEqual(
				fs.readFileSync(lock, "utf8"),
				`${process.ppid} outro`,
				"trava alheia intacta"
			);
			// Processo vivo mas trava velha (PID de outro namespace): removida
			const old = (Date.now() - 10 * 60 * 1000) / 1000;
			fs.utimesSync(lock, old, old);
			await svc.store.publish({ waitMs: 200 });
			assert.ok(!fs.existsSync(lock), "trava liberada depois de publicar");
			// Mesmo PID deste processo com outro instante de início (subida anterior no mesmo contêiner):
			// removida na hora, sem esperar envelhecer
			fs.writeFileSync(lock, `${process.pid} 1000 velha`);
			await svc.store.publish({ waitMs: 200 });
			assert.ok(!fs.existsSync(lock), "trava da subida anterior removida");
			// PID morto, trava recente: removida na hora; temporário órfão de publicação interrompida some
			fs.writeFileSync(lock, "999999999 morto");
			fs.writeFileSync(path.join(publishDir, ".analytics.db.tmp-424242"), "lixo");
			await svc.store.publish({ waitMs: 200 });
			assert.deepStrictEqual(fs.readdirSync(publishDir), ["analytics.db"]);
			// Liberar só apaga a própria trava
			const release = await svc.store._acquirePublishLock(200, 120000);
			assert.strictEqual(fs.readFileSync(lock, "utf8").split(" ")[0], String(process.pid));
			fs.writeFileSync(lock, "1 de-outro");
			release();
			assert.ok(fs.existsSync(lock), "trava de outro não é apagada");
			fs.rmSync(lock);
			// stop() no meio da publicação: libera a própria trava (releasePublishLock)
			await svc.store._acquirePublishLock(200, 120000);
			assert.ok(fs.existsSync(lock));
			svc.store.releasePublishLock();
			assert.ok(!fs.existsSync(lock), "trava própria liberada no encerramento");
			svc.store.releasePublishLock(); // sem trava na mão: nada
			// Retrato: marca do painel, sem WAL, permissão conforme o grupo
			const pdb = new BetterSQLite(pubFile, { readonly: true });
			assert.strictEqual(pdb.pragma("journal_mode", { simple: true }), "delete");
			assert.strictEqual(
				pdb.pragma("application_id", { simple: true }),
				require("../services/EconomyAnalyticsStore").APP_ID
			);
			pdb.close();
			const st = fs.statSync(pubFile);
			assert.strictEqual(st.mode & 0o777, st.gid === 0 ? 0o640 : 0o644);
		});

		await test("banco antigo que ganha coluna na subida: start() publica já, mesmo sem rodada", async () => {
			const mdb = path.join(tmpRoot, "migra", "analytics.db");
			const mpub = path.join(tmpRoot, "migra-pub");
			const mk = () =>
				new EconomyAnalyticsService({
					dbPath: mdb,
					publishDir: mpub,
					sources: [],
					runOnStart: false
				});
			// Banco novo: nada a republicar
			const a = mk();
			a.start();
			assert.strictEqual(a._schemaPublish, undefined);
			await a.stop();
			assert.ok(!fs.existsSync(path.join(mpub, "analytics.db")));
			// Simula um banco de versão anterior (sem a coluna) e sobe de novo
			const raw = new BetterSQLite(mdb);
			raw.exec("ALTER TABLE soulmate_cycle_hourly DROP COLUMN without_quota");
			raw.close();
			const b = mk();
			b.start();
			await b._schemaPublish;
			const pdb = new BetterSQLite(path.join(mpub, "analytics.db"), { readonly: true });
			const cols = pdb.prepare("PRAGMA table_info(soulmate_cycle_hourly)").all();
			pdb.close();
			assert.ok(
				cols.some((c) => c.name === "without_quota"),
				"retrato com a coluna nova"
			);
			assert.strictEqual(await b.stop(), true);
		});

		await test("scripts economy-annotate (gravar, exportar, importar) e economy-status", () => {
			const { spawnSync } = require("child_process");
			const env = {
				...process.env,
				ECONOMY_ANALYTICS_DB: dbPath,
				ECONOMY_ANALYTICS_PUBLISH_DIR: publishDir
			};
			const run = (args, input) =>
				spawnSync(
					process.execPath,
					[path.join(__dirname, "../../scripts", ...args.slice(0, 1)), ...args.slice(1)],
					{
						env,
						input,
						encoding: "utf8"
					}
				);
			let r = run(["economy-annotate.js", "Regra nova", "zinthos", "2026-11-09T12:00:00Z"]);
			assert.strictEqual(r.status, 0, r.stderr);
			assert.match(r.stdout, /publicada/);
			const pub = readAll(pubFile, "SELECT ts, currency, label FROM annotations");
			assert.deepStrictEqual(pub, [
				{ ts: Date.parse("2026-11-09T12:00:00Z"), currency: "zinthos", label: "Regra nova" }
			]);
			r = run(["economy-annotate.js", "--export"]);
			const exported = JSON.parse(r.stdout);
			assert.strictEqual(exported.length, 1);
			assert.strictEqual(run(["economy-annotate.js", "x", "ouro"]).status, 1);
			// --listar, --confirmar e --descartar: pelo id do --listar (ou ts + texto, forma antiga)
			r = run(["economy-annotate.js", "--listar"]);
			assert.match(r.stdout, /^\s*\d+\s+\S+\s+manual\s+zinthos\s+Regra nova/m);
			r = run(["economy-annotate.js", "--descartar", "2026-11-09T12:00:00Z", "Regra nova"]);
			assert.strictEqual(r.status, 1, "manual não se descarta");
			assert.match(r.stderr, /manual não se confirma nem descarta/);
			const T = Date.parse("2026-11-08T07:00:00Z");
			svc.store.addAnnotation(T, "zinthos", "motivo novo: X (Zinthos)", "possivel", {
				kind: "new_reason"
			});
			svc.store.addAnnotation(T, "runas", "motivo novo: Y (Runas)", "possivel", {
				kind: "new_reason"
			});
			svc.store.addAnnotation(T + 1, null, "ravena: a 1 → 2", "auto", { changes: [] });
			r = run(["economy-annotate.js", "--listar", "--possiveis"]);
			const lines = r.stdout.trim().split("\n");
			assert.strictEqual(lines.length, 2, r.stdout);
			const idX = lines
				.find((l) => /X \(Zinthos\)/.test(l))
				.trim()
				.split(/\s+/)[0];
			r = run(["economy-annotate.js", "--descartar", idX]);
			assert.strictEqual(r.status, 0, r.stderr);
			r = run(["economy-annotate.js", "--confirmar", idX, "Prêmio X novo no evento"]);
			assert.strictEqual(r.status, 0, r.stderr);
			const x = readAll(pubFile, "SELECT origin, label, detail FROM annotations WHERE ts = ?", [T]);
			assert.deepStrictEqual(x.map((a) => [a.origin, a.label]).sort(), [
				["confirmada", "Prêmio X novo no evento"],
				["possivel", "motivo novo: Y (Runas)"]
			]);
			assert.strictEqual(
				JSON.parse(x.find((a) => a.origin === "confirmada").detail).originalLabel,
				"motivo novo: X (Zinthos)"
			);
			r = run(["economy-annotate.js", "--descartar", String(T), "motivo novo: Y (Runas)"]);
			assert.strictEqual(r.status, 0, r.stderr);
			r = run(["economy-annotate.js", "--descartar", String(T + 1), "ravena: a 1 → 2"]);
			assert.match(r.stderr, /automática não se confirma/);
			assert.strictEqual(run(["economy-annotate.js", "--confirmar", "99999"]).status, 1);
			assert.strictEqual(run(["economy-annotate.js", "--confirmar"]).status, 1);
			svc.store.db.prepare("DELETE FROM annotations WHERE ts IN (?, ?)").run(T, T + 1);
			// Recomeçar do zero e importar de volta
			const env2 = {
				...env,
				ECONOMY_ANALYTICS_DB: path.join(tmpRoot, "zero", "a.db"),
				ECONOMY_ANALYTICS_PUBLISH_DIR: path.join(tmpRoot, "zero-pub")
			};
			r = spawnSync(
				process.execPath,
				[path.join(__dirname, "../../scripts/economy-annotate.js"), "--import"],
				{
					env: env2,
					input: JSON.stringify(exported),
					encoding: "utf8"
				}
			);
			assert.strictEqual(r.status, 0, r.stderr);
			assert.strictEqual(
				readAll(
					path.join(tmpRoot, "zero-pub", "analytics.db"),
					"SELECT COUNT(*) n FROM annotations"
				)[0].n,
				1
			);
			// Importar de novo não sobrescreve origem nem detalhe da que já existe
			r = spawnSync(
				process.execPath,
				[path.join(__dirname, "../../scripts/economy-annotate.js"), "--import"],
				{
					env: env2,
					input: JSON.stringify(exported.map((a) => ({ ...a, origin: "auto", detail: { x: 1 } }))),
					encoding: "utf8"
				}
			);
			assert.strictEqual(r.status, 0, r.stderr);
			assert.match(r.stdout, /0 de 1/);
			assert.deepStrictEqual(
				readAll(
					path.join(tmpRoot, "zero-pub", "analytics.db"),
					"SELECT origin, detail FROM annotations"
				),
				[{ origin: "manual", detail: null }]
			);
			r = run(["economy-status.js"]);
			assert.strictEqual(r.status, 0, r.stderr);
			assert.match(r.stdout, /zinthos\s+\d{4}-/);
			assert.match(r.stdout, /retrato do Grafana: .*atualizado/);
		});

		await test("guarda de caminhos: nunca escreve em data/sqlites, no bank.db ou em SQLite alheio", () => {
			const { EconomyAnalyticsStore } = require("../services/EconomyAnalyticsStore");
			const crypto = require("crypto");
			const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
			const repoSqlites = path.join(__dirname, "../../data/sqlites");
			const inSqlites = path.join(repoSqlites, "economia-guard-test.db");
			assert.throws(
				() => new EconomyAnalyticsStore(inSqlites, path.join(tmpRoot, "g1")),
				/data\/sqlites/
			);
			assert.throws(
				() => new EconomyAnalyticsStore(path.join(tmpRoot, "g2", "a.db"), repoSqlites),
				/data\/sqlites/
			);
			assert.ok(!fs.existsSync(inSqlites), "nada criado em data/sqlites");
			// bank.db de verdade (configurado) e qualquer SQLite com tabelas que não são do painel
			const bankFile = path.join(tmpRoot, "bank.db");
			const before = sha(bankFile);
			const prev = process.env.ECONOMY_ANALYTICS_BANK_DB;
			process.env.ECONOMY_ANALYTICS_BANK_DB = bankFile;
			try {
				assert.throws(
					() => new EconomyAnalyticsStore(bankFile, path.join(tmpRoot, "g3")),
					/bank\.db/
				);
			} finally {
				if (prev === undefined) delete process.env.ECONOMY_ANALYTICS_BANK_DB;
				else process.env.ECONOMY_ANALYTICS_BANK_DB = prev;
			}
			assert.throws(
				() => new EconomyAnalyticsStore(bankFile, path.join(tmpRoot, "g4")),
				/não é do painel/
			);
			// diretório publicado com um analytics.db alheio
			const alien = path.join(tmpRoot, "alien");
			fs.mkdirSync(alien, { recursive: true });
			fs.copyFileSync(bankFile, path.join(alien, "analytics.db"));
			assert.throws(
				() => new EconomyAnalyticsStore(path.join(tmpRoot, "g5", "a.db"), alien),
				/não é do painel/
			);
			assert.strictEqual(sha(bankFile), before, "bank.db intacto");
			assert.strictEqual(sha(path.join(alien, "analytics.db")), before, "arquivo alheio intacto");
			// o script de anotação herda a guarda
			const { spawnSync } = require("child_process");
			const r = spawnSync(
				process.execPath,
				[path.join(__dirname, "../../scripts/economy-annotate.js"), "x"],
				{
					env: { ...process.env, ECONOMY_ANALYTICS_DB: inSqlites },
					encoding: "utf8"
				}
			);
			assert.notStrictEqual(r.status, 0);
			assert.match(r.stderr, /data\/sqlites/);
			assert.ok(!fs.existsSync(inSqlites));
		});

		await test("moeda sem origem por dia (painéis por moeda, em %): non_monetary fora; dia sem retrato não some", () => {
			const { file, db } = freshDb("orphan.db");
			const ins = db.prepare("INSERT INTO balances (ts, currency, total) VALUES (?, ?, ?)");
			const fl = db.prepare("INSERT INTO flows_hourly VALUES (?, ?, ?, ?, ?, ?, 1, 1)");
			// Dia 0: abre 1000, abertura do dia 1 = 1600; fluxos +700 −200 = +500 → 100 sem origem
			ins.run(DAY0 + 5 * 60 * 1000, "zinthos", 1000);
			ins.run(DAY0 + 3 * H, "zinthos", 1200); // retrato no meio do dia: ignorado
			ins.run(DAY0 + D + 5 * 60 * 1000, "zinthos", 1600);
			fl.run(DAY0, "zinthos", "A", "creation", 700, 0);
			fl.run(DAY0 + 23 * H, "zinthos", "B", "destruction", 0, 200);
			fl.run(DAY0 + H, "zinthos", "HOSTING_FEE_WAIFU", "non_monetary", 5000, 0); // fora
			// Dia 1: abre 1600, dia 2 abre 2499, fluxo +999 → −100 (sumiu sem linha no extrato)
			fl.run(DAY0 + D, "zinthos", "A", "creation", 999, 0);
			ins.run(DAY0 + 2 * D + 5 * 60 * 1000, "zinthos", 2499);
			// Dia 3 sem retrato: dia 2 → dia 4 (2600) com +50 de fluxo → 51 no dia 2 (2 dias)
			fl.run(DAY0 + 3 * D + 2 * H, "zinthos", "A", "creation", 50, 0);
			ins.run(DAY0 + 4 * D + 5 * 60 * 1000, "zinthos", 2600);
			// Runas no mesmo período, tudo explicado
			ins.run(DAY0, "runas", 10);
			ins.run(DAY0 + D, "runas", 15);
			fl.run(DAY0 + H, "runas", "X", "exchange_in", 5, 0);
			db.close();
			const range = { from: DAY0 - D, to: DAY0 + 6 * D };
			const z = readAll(
				file,
				dashboardSql("Conferência: estoque × fluxos — ${moeda} (período selecionado)", range)
			);
			assert.deepStrictEqual(
				z.map((r) => [r.time, r["Sem origem"], r["% da massa"], r["Dias no intervalo"]]),
				[
					[DAY0 / 1000, 100, 6.25, 1], // frser lê colunas de tempo em segundos; 100/1600
					[(DAY0 + D) / 1000, -100, -4.002, 1],
					[(DAY0 + 2 * D) / 1000, 51, 1.962, 2]
				]
			);
			const r = readAll(
				file,
				dashboardSql("Conferência: estoque × fluxos — ${moeda} (período selecionado)", {
					...range,
					moeda: "runas"
				})
			);
			assert.deepStrictEqual(
				r.map((x) => x["Sem origem"]),
				[0]
			);
			const p = readAll(
				file,
				dashboardSql("Conferência: estoque × fluxos — ${moeda} (período selecionado)", {
					...range,
					moeda: "petalitas"
				})
			);
			assert.strictEqual(p.length, 0);
			// Gráfico com várias moedas: o filtro Moedas põe e tira séries
			const multi = (moedas) =>
				readAll(
					file,
					dashboardSql("Sem origem por dia, por moeda (período selecionado)", { ...range, moedas })
				);
			assert.deepStrictEqual([...new Set(multi(["zinthos", "runas"]).map((x) => x.Moeda))].sort(), [
				"Runas",
				"Zinthos"
			]);
			assert.deepStrictEqual([...new Set(multi(["runas"]).map((x) => x.Moeda))], ["Runas"]);
		});

		await test("parâmetros: achata, compara, rótulo curto", () => {
			assert.deepStrictEqual(Changes.flattenParams({ a: { B: 1, C: [2, 3] }, d: null, e: "x" }), {
				"a.B": 1,
				"a.C.0": 2,
				"a.C.1": 3,
				d: "none",
				e: "x"
			});
			assert.deepStrictEqual(Changes.diffParams(null, { a: 1 }), []); // primeira leitura só guarda
			const ch = Changes.diffParams({ a: 1, b: 2, gone: 5 }, { a: 1, b: 3, novo: 7 });
			assert.deepStrictEqual(ch, [
				{ key: "b", from: 2, to: 3 },
				{ key: "gone", from: 5, to: null },
				{ key: "novo", from: null, to: 7 }
			]);
			assert.strictEqual(
				Changes.changeLabel("waifuletes", [{ key: "divorce.RATE", from: 0.05, to: 0.08 }]),
				"waifuletes: divorce.RATE 0.05 → 0.08"
			);
			assert.match(
				Changes.changeLabel("jardim", ch),
				/^jardim: 3 parâmetros \(b 2 → 3; gone removido \(era 5\); novo novo \(7\)\)$/
			);
			const many = Array.from({ length: 40 }, (_, i) => ({
				key: `chave.longa.${i}`,
				from: i,
				to: i + 1
			}));
			const lbl = Changes.changeLabel("waifuletes", many);
			assert.ok(lbl.length <= 230 && /; \+\d+\)$/.test(lbl), lbl);
		});

		await test("Runas: parâmetros de economyConstants.js sem carregar o BankService; guarda de constantes", () => {
			const p = Changes.runasParams();
			assert.strictEqual(p.params["cambio.BASE_RUNAS_PER_ZINTHOS"], 1000 / 3500);
			assert.strictEqual(p.params["cotas.DAILY_LIMITS.venda_runas"], 300000);
			assert.strictEqual(p.params["loja.STORE_PRICES.moeda"], 55);
			assert.ok(
				!Object.keys(require.cache).some((k) => k.endsWith(`${path.sep}BankService.js`)),
				"ler os parâmetros não carrega o BankService (abre bank.db e agenda cron)"
			);
			// Guarda: constante de módulo nova no BankService vem de economyConstants.js (vira parâmetro
			// lido pela carga e anotado sozinho) ou entra aqui com o motivo
			const IGNORED = {
				WAIFULETES_URL: "endereço do serviço",
				WAIFULETES_KEY: "segredo de acesso",
				SESSION_TTL_MS: "duração da sessão web do banco; não mexe em moeda"
			};
			const src = fs.readFileSync(path.join(__dirname, "../services/BankService.js"), "utf8");
			assert.match(src, /require\("\.\/economyConstants"\)/);
			const declared = [...src.matchAll(/^const ([A-Z][A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
			for (const name of declared) {
				assert.ok(
					IGNORED[name],
					`BankService.js: constante ${name} fora de economyConstants.js; mova para lá (vira parâmetro em /params) ou ignore aqui com o motivo`
				);
			}
			// Tudo que economyConstants exporta (fora as funções e listas internas) sai nos parâmetros
			const C = require("../services/economyConstants");
			const keys = Object.keys(p.params);
			for (const [name, v] of Object.entries(C)) {
				if (typeof v === "function" || name === "ALL_CURRENCIES_GROUPS") continue;
				assert.ok(
					keys.some((k) => k.split(".").includes(name)),
					`economyConstants.${name} não aparece em economyParams()`
				);
			}
		});

		await test("mudanças automáticas: 1ª leitura guarda, mudança vira anotação na subida do serviço, 404 fica de fora", async () => {
			let pclock = DAY0 + 5 * D + 2 * H;
			const st8 = { calls: [], fail: {}, override: {}, now: () => pclock, delay: 0, params: {} };
			const srv = await startMockServer(st8);
			const url = `http://127.0.0.1:${srv.address().port}`;
			let runas = { params: { "loja.STORE_PRICES.isca": 45 }, startedAt: 1, version: null };
			const s = new EconomyAnalyticsService({
				dbPath: path.join(tmpRoot, "auto", "a.db"),
				publishDir: path.join(tmpRoot, "auto-pub"),
				sources: ["zinthos", "petalitas", "runas"],
				waifuletesUrl: url,
				waifuletesKey: "test-waifu-key",
				jardimUrl: url,
				jardimKey: "test-jardim-key",
				now: () => pclock,
				runasParams: () => runas
			});
			try {
				const st = s._getStore();
				st8.params.waifuletes = {
					currency: "zinthos",
					schemaVersion: 1,
					generatedAt: pclock,
					startedAt: DAY0,
					version: "abc",
					params: { divorce: { DIVORCE_PENALTY_RATE: 0.05 }, daily: { DAILY_KAKERA_AMOUNT: 100 } }
				};
				let r = await s._loadParams(st, pclock);
				assert.deepStrictEqual(r.jardim, { ok: true, available: false }); // sem a rota
				assert.strictEqual(r.waifuletes.changes, 0);
				assert.strictEqual(st.listAnnotations().length, 0);
				// waifuletes subiu de novo com a taxa nova; a anotação vai para a hora da subida
				pclock += 3 * H;
				const up = pclock - 90 * 60 * 1000;
				st8.params.waifuletes = {
					...st8.params.waifuletes,
					startedAt: up,
					params: { divorce: { DIVORCE_PENALTY_RATE: 0.08 }, daily: { DAILY_KAKERA_AMOUNT: 100 } }
				};
				runas = { ...runas, params: { "loja.STORE_PRICES.isca": 50 }, startedAt: 1 };
				r = await s._loadParams(st, pclock);
				const anns = st.listAnnotations();
				assert.deepStrictEqual(
					anns.map((a) => [a.ts, a.currency, a.origin, a.label]),
					[
						[
							R.hourStart(pclock),
							"runas",
							"auto",
							"ravena: loja.STORE_PRICES.isca 45 → 50 (hora aproximada)"
						],
						[up, "zinthos", "auto", "waifuletes: divorce.DIVORCE_PENALTY_RATE 0.05 → 0.08"]
					].sort((a, b) => a[0] - b[0])
				);
				const w = anns.find((a) => a.currency === "zinthos");
				assert.deepStrictEqual(w.detail.changes, [
					{ key: "divorce.DIVORCE_PENALTY_RATE", from: 0.05, to: 0.08 }
				]);
				assert.strictEqual(w.detail.version, "abc");
				// Hora exata (subida do serviço); o intervalo e a subida vão sempre no detalhe
				assert.strictEqual(w.detail.exact, true);
				assert.deepStrictEqual(w.detail.between, [pclock - 3 * H, pclock]);
				assert.strictEqual(w.detail.startedAt, up);
				// Runas: subida antes da leitura anterior → hora cheia, intervalo de 3 h = hora aproximada
				const rn = anns.find((a) => a.currency === "runas");
				assert.strictEqual(rn.detail.exact, false);
				assert.strictEqual(rn.detail.between[1], pclock);
				// Sem mudança: nada novo
				pclock += H;
				await s._loadParams(st, pclock);
				assert.strictEqual(st.listAnnotations().length, 2);
				// Chave só acrescentada num deploy (version nova: constante passou a ser exposta): guardada,
				// sem anotação
				st8.params.waifuletes = {
					...st8.params.waifuletes,
					version: "def",
					params: {
						...st8.params.waifuletes.params,
						roll: { ROLLS_PER_HOUR: 10, CHANCE: 3 }
					}
				};
				pclock += H;
				r = await s._loadParams(st, pclock);
				assert.deepStrictEqual([r.waifuletes.changes, r.waifuletes.added], [0, 2]);
				assert.strictEqual(st.listAnnotations().length, 2);
				assert.strictEqual(st.getParams("waifuletes")["roll.CHANCE"], 3);
				// Chave nova com a mesma version (dado mudou sem deploy de código): vira anotação
				st8.params.waifuletes = {
					...st8.params.waifuletes,
					params: { ...st8.params.waifuletes.params, daily: { DAILY_KAKERA_AMOUNT: 100, BONUS: 5 } }
				};
				pclock += H;
				r = await s._loadParams(st, pclock);
				assert.deepStrictEqual([r.waifuletes.changes, r.waifuletes.added], [1, 1]);
				assert.ok(
					st.listAnnotations().some((a) => a.label === "waifuletes: daily.BONUS novo (5)"),
					JSON.stringify(st.listAnnotations().map((a) => a.label))
				);
				// Item novo de catálogo (catalog.*): anotado mesmo com version nova
				st8.params.waifuletes = {
					...st8.params.waifuletes,
					version: "ghi",
					params: {
						...st8.params.waifuletes.params,
						catalog: { plants: { rosa: { price: 10 } } },
						extra: { K: 1 }
					}
				};
				pclock += H;
				r = await s._loadParams(st, pclock);
				assert.deepStrictEqual([r.waifuletes.changes, r.waifuletes.added], [1, 2]);
				const cat = st.listAnnotations().find((a) => /catalog/.test(a.label));
				assert.strictEqual(cat.label, "waifuletes: catalog.plants.rosa.price novo (10)");
				assert.deepStrictEqual(cat.detail.added, [{ key: "extra.K", from: null, to: 1 }]);
				assert.strictEqual(st.listAnnotations().length, 4);
				// Formato novo (schemaVersion mudou): só regrava a base, sem anotar
				st8.params.waifuletes = {
					...st8.params.waifuletes,
					schemaVersion: 2,
					params: { outro: { FORMATO: 1 } }
				};
				pclock += H;
				r = await s._loadParams(st, pclock);
				assert.strictEqual(r.waifuletes.changes, 0);
				assert.strictEqual(st.listAnnotations().length, 4);
				assert.deepStrictEqual(st.getParams("waifuletes"), { "outro.FORMATO": 1 });
				// Câmbio das Runas mexe em todas as moedas: anotação em "todas", hora menos de 2 h → sem aviso
				runas = { ...runas, params: { ...runas.params, "cambio.BASE_RUNAS_PER_ZINTHOS": 0.3 } };
				pclock += H;
				await s._loadParams(st, pclock); // acrescentada: só guarda
				runas = { ...runas, params: { ...runas.params, "cambio.BASE_RUNAS_PER_ZINTHOS": 0.25 } };
				pclock += H;
				await s._loadParams(st, pclock);
				const cam = st.listAnnotations().find((a) => /cambio/.test(a.label));
				assert.strictEqual(cam.currency, null);
				assert.strictEqual(cam.label, "ravena: cambio.BASE_RUNAS_PER_ZINTHOS 0.3 → 0.25");
				// Falha de um serviço não para os outros
				st8.params.waifuletes = { nope: true };
				r = await s._loadParams(st, pclock);
				assert.strictEqual(r.waifuletes.ok, false);
				assert.strictEqual(r.ravena.ok, true);
			} finally {
				await s.stop();
				srv.close();
			}
		});

		await test("possíveis mudanças: motivo novo, motivo que sumiu e valor por transação; uma vez por dia", () => {
			const D0 = DAY0 + 40 * D;
			const rows = [];
			for (let i = 1; i <= 10; i++) {
				const d = D0 - i * D;
				rows.push({ day: d, reason: "DAILY", n: 30, vol: 30 * (100 + (i % 2)) });
				rows.push({ day: d, reason: "OLD", n: 5, vol: 50 });
				rows.push({ day: d, reason: "ROLL", n: 30, vol: 30 * (i % 2 ? 50 : 150) }); // instável: não conta
			}
			rows.push({ day: D0, reason: "DAILY", n: 40, vol: 40 * 300 });
			rows.push({ day: D0, reason: "ROLL", n: 30, vol: 30 * 400 });
			rows.push({ day: D0, reason: "NEW", n: 2, vol: 999 });
			const found = Changes.detectPossible(rows, D0, (r) => `L_${r}`);
			assert.deepStrictEqual(
				found.map((f) => f.label),
				[
					"valor por transação de L_DAILY: 101 → 300 (+198%)",
					"motivo novo: L_NEW",
					"motivo sumiu: L_OLD"
				]
			);
			// No serviço: só com extrato, só com o dia carregado, uma vez por dia, sem regravar decisão
			const s = new EconomyAnalyticsService({
				dbPath: path.join(tmpRoot, "poss", "a.db"),
				publishDir: path.join(tmpRoot, "poss-pub"),
				sources: ["zinthos", "petalitas", "runas"]
			});
			const st = s._getStore();
			const fl = st.db.prepare("INSERT INTO flows_hourly VALUES (?, ?, ?, 'creation', ?, 0, ?, 1)");
			// O mesmo motivo nas duas moedas, no mesmo dia: as duas anotações entram
			for (const cur of ["zinthos", "runas"]) {
				for (const r of rows) fl.run(r.day + H, cur, r.reason, r.vol, r.n);
				// Histórico de 35 dias: sem ele, "motivo novo" não é dito
				fl.run(D0 - 35 * D + H, cur, "DAILY", 3000, 30);
				st.setLedgerStatus(cur, true, 0);
			}
			st.setLedgerStatus("petalitas", false, 0);
			const runTs = D0 + D + 2 * H;
			assert.deepStrictEqual(s._detectChanges(st, runTs), {}); // dia ainda não carregado
			st.recordRun({ ts: 1, source: "zinthos", ok: true, from: 0, to: D0 + D + H, rows: 1 });
			st.recordRun({ ts: 1, source: "runas", ok: true, from: 0, to: D0 + D + H, rows: 1 });
			assert.deepStrictEqual(s._detectChanges(st, runTs), { zinthos: 3, runas: 3 });
			assert.strictEqual(st.listAnnotations().length, 6);
			assert.ok(st.listAnnotations().every((a) => a.origin === "possivel" && a.ts === D0));
			st.setAnnotationOrigin(D0, "motivo novo: NEW (Zinthos)", "descartada");
			st.db.prepare("DELETE FROM meta WHERE key = 'detect_day:zinthos'").run();
			st.db.prepare("DELETE FROM meta WHERE key = 'detect_day:runas'").run();
			s._detectChanges(st, runTs); // rodar de novo não desfaz o descarte
			assert.strictEqual(
				st.listAnnotations().find((a) => a.label === "motivo novo: NEW (Zinthos)").origin,
				"descartada"
			);
			assert.deepStrictEqual(s._detectChanges(st, runTs + H), {}); // já olhou esse dia
			// Detecção pura: sem 35 dias de histórico não há "motivo novo"
			assert.ok(
				!Changes.detectPossible(rows, D0, (r) => r, Changes.DETECT, { allowNew: false }).some(
					(f) => f.detail.kind === "new_reason"
				)
			);
			// Dia sem dados (serviço fora: total muito abaixo da mediana) não emite nada
			assert.strictEqual(Changes.isLowDataDay(rows, D0 + D), true);
			assert.strictEqual(
				Changes.isLowDataDay([...rows, { day: D0 + D, reason: "DAILY", n: 3, vol: 300 }], D0 + D),
				true
			);
			assert.strictEqual(Changes.isLowDataDay(rows, D0), false);
			// Ravena parada 3 dias: olha cada dia pulado; valor por transação no dia de uma mudança
			// automática da mesma moeda já entra descartado com a referência
			const D3 = D0 + 3 * D;
			for (let i = -10; i <= 3; i++) {
				const d = D0 + i * D;
				fl.run(d + 2 * H, "zinthos", "STEADY", 30 * (i === 3 ? 200 : 100), 30);
				if (i > 0) fl.run(d + H, "zinthos", "DAILY", 30 * 300, 30);
			}
			st.addAnnotation(D3 + 5 * H, "zinthos", "waifuletes: steady.X 100 → 200", "auto", {});
			st.recordRun({ ts: 2, source: "zinthos", ok: true, from: 0, to: D3 + D + H, rows: 1 });
			const before = st.listAnnotations().length;
			s._detectChanges(st, D3 + D + 2 * H);
			assert.strictEqual(Number(st.getMeta("detect_day:zinthos")), D3);
			const shift = st
				.listAnnotations()
				.slice(before)
				.concat(st.listAnnotations())
				.find((a) => a.ts === D3 && a.detail && a.detail.kind === "per_tx_shift");
			assert.ok(shift, "valor por transação no dia da mudança automática");
			assert.strictEqual(shift.origin, "descartada");
			assert.strictEqual(shift.detail.ref.label, "waifuletes: steady.X 100 → 200");
			st.close();
			s.store = null;
		});

		await test("banco antigo: annotations ganha origin e detail sem perder linhas", () => {
			const wdb = path.join(tmpRoot, "antigo", "a.db");
			fs.mkdirSync(path.dirname(wdb), { recursive: true });
			const old = new BetterSQLite(wdb);
			old.exec(
				"CREATE TABLE annotations (ts INTEGER NOT NULL, currency TEXT, label TEXT NOT NULL, PRIMARY KEY (ts, label))"
			);
			old.prepare("INSERT INTO annotations VALUES (1, 'zinthos', 'antiga')").run();
			old.close();
			const s = new EconomyAnalyticsService({
				dbPath: wdb,
				publishDir: path.join(tmpRoot, "antigo-pub"),
				sources: []
			});
			const st = s._getStore();
			st.addAnnotation(2, null, "nova", "auto", { de: 1, para: 2 });
			assert.deepStrictEqual(st.listAnnotations(), [
				{ ts: 1, currency: "zinthos", label: "antiga", origin: null, detail: null },
				{ ts: 2, currency: null, label: "nova", origin: "auto", detail: { de: 1, para: 2 } }
			]);
			st.close();
			s.store = null;
		});

		await test("ficha de mudanças: faixa do normal, situação, motivos que mais mudaram e origem", () => {
			const { file, db } = freshDb("mudancas.db");
			const fl = db.prepare("INSERT INTO flows_hourly VALUES (?, 'zinthos', ?, ?, ?, ?, 1, 1)");
			const T = DAY0 + 70 * D;
			// 9 semanas antes: 700 por semana com ±10% alternado; depois: 3 dias com 300/dia e um motivo novo
			for (let w = 1; w <= 9; w++) {
				fl.run(T - w * 7 * D + H, "DAILY_REWARD", "creation", w % 2 ? 770 : 630, 0);
			}
			for (let d = 0; d < 3; d++) {
				fl.run(T + d * D + H, "DAILY_REWARD", "creation", 300, 0);
				fl.run(T + d * D + 2 * H, "DIVORCE", "creation", 50, 0);
			}
			db.prepare(
				"INSERT INTO reason_labels VALUES ('zinthos', 'DIVORCE', 'Divórcio', 'creation')"
			).run();
			db.prepare(
				"INSERT INTO annotations (ts, currency, label, origin) VALUES (?, 'zinthos', 'DAILY 100 → 300', 'auto')"
			).run(T);
			db.prepare(
				"INSERT INTO annotations (ts, currency, label, origin) VALUES (?, 'zinthos', 'motivo novo', 'possivel')"
			).run(T + 2 * D + 3 * H);
			db.close();
			const ficha = () =>
				readAll(
					file,
					dashboardSql("Ficha de antes e depois (últimas 20)", { from: 0, to: T + 30 * D })
				);
			if (AUTO_CHANGES) {
				// Possível ainda a decidir fica fora da ficha, na tabela própria com o id do --confirmar/--descartar
				assert.deepStrictEqual(
					ficha().map((r) => r["O que mudou"]),
					["DAILY 100 → 300"]
				);
				const [aDecidir] = readAll(
					file,
					dashboardSql("Possíveis mudanças a decidir", { from: 0, to: T + 30 * D })
				);
				assert.strictEqual(aDecidir["O que pode ter mudado"], "motivo novo");
				assert.strictEqual(
					aDecidir["Decidir com economy-annotate.js"],
					`--confirmar ${aDecidir.Id}  ·  --descartar ${aDecidir.Id}`
				);
				const dbc = new BetterSQLite(file);
				dbc
					.prepare("UPDATE annotations SET origin = 'confirmada' WHERE rowid = ?")
					.run(aDecidir.Id);
				dbc.close();
			}
			const rows = ficha();
			assert.strictEqual(rows.length, 2);
			const [poss, auto] = rows;
			if (AUTO_CHANGES) assert.strictEqual(auto.Origem, "automática");
			assert.strictEqual(auto["Situação"], "acompanhando (2 de 7 dias)");
			assert.strictEqual(auto["Criado/dia antes"], 110); // 770 / 7
			// depois: 1050 em 2,04 dias (última hora carregada = T + 2 d + 2 h + 1 h)
			// ficha ainda aberta: Δ parcial, sem ▲▼ nem cor
			assert.match(auto["Criado/dia: Δ"], /^parcial: \+\d+\.\d%$/);
			assert.match(auto["Motivos que mais mudaram"], /Divórcio \+\d+\/dia/);
			assert.ok(auto["Semanas no normal"] >= 7);
			if (AUTO_CHANGES) {
				assert.strictEqual(poss.Origem, "possível, confirmada");
				assert.strictEqual(poss["Situação"], "cedo demais (< 1 dia)");
			} else {
				assert.strictEqual(poss.Origem, undefined);
				assert.strictEqual(poss["Situação"], "cedo demais (< 1 dia)");
			}
			// Ficha fechada: recurso desligado depois da mudança (nenhuma linha de criação) → criado 0, ▼ −100%;
			// normal = média de |Δ%| entre semanas seguidas (770/630 alternados ≈ 20%).
			// Jogadores/dia = média dos distintos de cada dia (2 e 1 → 1,5), não distintos da semana ÷ 7.
			const { file: f4, db: db4 } = freshDb("mudancas-fechada.db");
			const fl4 = db4.prepare("INSERT INTO flows_hourly VALUES (?, 'zinthos', ?, ?, ?, ?, 1, 1)");
			for (let w = 1; w <= 9; w++) {
				fl4.run(T - w * 7 * D + H, "DAILY_REWARD", "creation", w % 2 ? 770 : 630, 0);
			}
			const pd4 = db4.prepare(
				"INSERT INTO player_daily VALUES (?, 'zinthos', ?, 'DAILY_REWARD', 'creation', 1, 0, 1)"
			);
			pd4.run(T - 2 * D, "A");
			pd4.run(T - 2 * D, "B");
			pd4.run(T - D, "A");
			pd4.run(T + D, "A");
			db4.prepare("INSERT INTO ledger_status VALUES ('zinthos', 1, 0)").run();
			db4
				.prepare(
					"INSERT INTO load_runs (ts, source, ok, window_from, window_to, rows) VALUES (1, 'zinthos', 1, 0, ?, 1)"
				)
				.run(T + 10 * D);
			db4
				.prepare(
					"INSERT INTO annotations (ts, currency, label) VALUES (?, 'zinthos', 'desligou o diário')"
				)
				.run(T);
			db4.close();
			const [fech] = readAll(
				f4,
				dashboardSql("Ficha de antes e depois (últimas 20)", { from: 0, to: T + 30 * D })
			);
			assert.strictEqual(fech["Situação"], "fechada");
			assert.strictEqual(fech["Criado/dia depois"], 0);
			assert.strictEqual(fech["Criado/dia: Δ"], "▼ -100.0% (normal ±20%)");
			assert.strictEqual(fech["Jogadores/dia antes"], 1.5);
			assert.strictEqual(fech["Jogadores/dia depois"], 1);
			assert.deepStrictEqual(Object.keys(fech).slice(0, 5), [
				"Quando",
				"O que mudou",
				"Criado/dia: Δ",
				"Situação",
				"Motivos que mais mudaram"
			]);
			// Pouco histórico (3 semanas → 2 comparações): o normal diz com quantas semanas foi medido
			const db5 = new BetterSQLite(f4);
			db5.prepare("DELETE FROM flows_hourly WHERE hour < ?").run(T - 3 * 7 * D);
			db5.close();
			const [curta] = readAll(
				f4,
				dashboardSql("Ficha de antes e depois (últimas 20)", { from: 0, to: T + 30 * D })
			);
			assert.match(curta["Criado/dia: Δ"], /^▼ -100\.0% \(normal ±\d+%, 2 semanas\)$/);
			// Moeda sem extrato (Petalitas): o "depois" avança pela carga registrada, não fica "cedo demais"
			const { file: f3, db: db3 } = freshDb("mudancas-pet.db");
			db3
				.prepare(
					"INSERT INTO annotations (ts, currency, label, origin) VALUES (?, 'petalitas', 'jardim: x 1 → 2', 'auto')"
				)
				.run(T);
			db3
				.prepare(
					"INSERT INTO load_runs (ts, source, ok, window_from, window_to, rows) VALUES (1, 'petalitas', 1, 0, ?, 1)"
				)
				.run(T + 3 * D);
			db3.close();
			const pet = readAll(
				f3,
				dashboardSql("Ficha de antes e depois (últimas 20)", { from: 0, to: T + 30 * D })
			);
			assert.strictEqual(pet[0]["Situação"], "acompanhando (3 de 7 dias)");
			// Sem nenhuma mudança: a consulta volta vazia e o painel mostra o texto de estado vazio
			const { file: f2 } = freshDb("mudancas-vazio.db");
			assert.deepStrictEqual(
				readAll(f2, dashboardSql("Últimas mudanças (3)", { from: 0, to: T })),
				[]
			);
			const resumo = dashboardPanels().find((p) => p.title === "Últimas mudanças (3)");
			assert.match(resumo.fieldConfig.defaults.noValue, /Nenhuma mudança registrada ainda/);
		});

		await test("situação por moeda: pior critério, dobra em N semanas, % do criado, conhecido, atrasado", () => {
			const { file, db } = freshDb("veredito.db");
			const insL = db.prepare(
				"INSERT INTO reason_labels (currency, reason, label, kind) VALUES (?, ?, ?, ?)"
			);
			for (const r of reasonLabelRows()) insL.run(r.currency, r.reason, r.label, r.kind);
			const bal = db.prepare("INSERT INTO balances (ts, currency, total) VALUES (?, ?, ?)");
			const fl = db.prepare("INSERT INTO flows_hourly VALUES (?, ?, ?, ?, ?, ?, 1, 1)");
			const to = DAY0 + 8 * D; // semana = [DAY0 + D, DAY0 + 8D)
			// Zinthos: cresce 2%/semana (atenção), tudo explicado → atenção; dobra em ln2/ln1.02 = 35,0 semanas
			for (let d = 0; d <= 8; d++)
				bal.run(DAY0 + d * D, "zinthos", Math.round(100000 * (1 + (0.02 * d) / 7)));
			for (let d = 0; d < 8; d++) {
				const delta =
					Math.round(100000 * (1 + (0.02 * (d + 1)) / 7)) -
					Math.round(100000 * (1 + (0.02 * d) / 7));
				fl.run(DAY0 + d * D + H, "zinthos", "DAILY_REWARD", "creation", delta, 0);
			}
			fl.run(DAY0 + 2 * D, "zinthos", "HOSTING_FEE_WAIFU", "non_monetary", 999999, 0);
			// Motivo sem mapear (atenção, mesmo nível do crescimento): "Por quê" lista os dois
			fl.run(DAY0 + 4 * D, "zinthos", "NOVO_Z", "unknown", 0, 0); // sem valor: não mexe na moeda sem origem
			// Runas: estável (0%), mas 6 de 100 criados sem origem → agir pelo % do criado
			for (let d = 0; d <= 8; d++) bal.run(DAY0 + d * D, "runas", 50000 + (d >= 5 ? 6 : 0));
			fl.run(DAY0 + 3 * D, "runas", "DEPOSIT:pesca", "creation", 100, 0);
			fl.run(DAY0 + 3 * D + H, "runas", "STORE_BUY:slots", "destruction", 0, 100);
			// Petalitas: sem extrato, massa estável → ok · sem extrato
			db.prepare("INSERT INTO ledger_status VALUES ('petalitas', 0, 0)").run();
			for (let d = 0; d <= 8; d++) bal.run(DAY0 + d * D, "petalitas", 7000);
			// Carga em dia (1 h atrás) nas três fontes
			const lr = db.prepare(
				"INSERT INTO load_runs (ts, source, ok, window_from, window_to, rows) VALUES (1, ?, 1, 0, ?, 1)"
			);
			for (const c of ["zinthos", "petalitas", "runas"]) lr.run(c, Date.now() - 3600000);
			db.close();
			// Variante: Zinthos só com 3 dias de retrato (sem base de 7 a 9 dias) e um motivo sem mapear
			fs.copyFileSync(file, path.join(tmpRoot, "veredito2.db"));
			const db2 = new BetterSQLite(path.join(tmpRoot, "veredito2.db"));
			db2.prepare("DELETE FROM balances WHERE currency = 'zinthos' AND ts < ?").run(DAY0 + 5 * D);
			db2
				.prepare("INSERT INTO flows_hourly VALUES (?, 'zinthos', 'NOVO', 'unknown', 3, 0, 1, 1)")
				.run(DAY0 + 6 * D);
			db2.close();
			const v = readAll(file, dashboardSql("Situação por moeda (últimos 7 dias)", { from: 0, to }));
			const by = Object.fromEntries(v.map((x) => [x.Moeda, x]));
			assert.deepStrictEqual(
				v.map((x) => x.Moeda),
				["Zinthos", "Petalitas", "Runas"]
			);
			assert.strictEqual(by.Zinthos["Situação"], "atenção");
			assert.strictEqual(by.Zinthos["Por quê"], "crescimento + motivo sem mapear");
			assert.strictEqual(by.Zinthos["Crescimento (%)"], 1.99);
			assert.strictEqual(by.Zinthos["Dobra em (semanas)"], 35.1);
			assert.strictEqual(by.Zinthos["Sem origem (% do criado)"], 0);
			assert.strictEqual(by.Zinthos["Sem origem"], "0.00% do criado");
			assert.strictEqual(by.Zinthos["Maior fonte"], "Recompensa diária");
			assert.strictEqual(by.Runas["Situação"], "agir");
			assert.strictEqual(by.Runas["Por quê"], "sem origem"); // crescimento ok não entra
			assert.strictEqual(by.Runas["Sem origem (% do criado)"], 6);
			assert.strictEqual(by.Runas["Sem origem (% da massa)"], 0.012);
			assert.strictEqual(by.Runas["Sem origem"], "6.00% do criado"); // o critério pior (% do criado)
			assert.strictEqual(by.Runas["Dobra em (semanas)"], null); // crescimento < 0,5%/semana: sem "dobra em"
			assert.strictEqual(by.Runas["Maior fonte"], "Venda de peixe");
			assert.strictEqual(by.Petalitas["Situação"], "ok · sem extrato");
			assert.strictEqual(by.Petalitas["Sem origem (% do criado)"], null);
			assert.match(by.Petalitas["Dados até · atraso"], /^\d\d\/\d\d \d\d:\d\d · 1\.0 h$/);
			assert.strictEqual(by.Petalitas["Por quê"], "—");
			// Sem retrato de 7 a 9 dias atrás: crescimento "sem dados", sem "dobra em"; motivo sem mapear → atenção
			const v2 = readAll(
				path.join(tmpRoot, "veredito2.db"),
				dashboardSql("Situação por moeda (últimos 7 dias)", { from: 0, to })
			);
			const z2 = v2.find((x) => x.Moeda === "Zinthos");
			assert.strictEqual(z2["Crescimento (%)"], null);
			assert.strictEqual(z2["Dobra em (semanas)"], null);
			assert.strictEqual(z2["Situação"], "atenção");
			assert.strictEqual(z2["Por quê"], "motivo sem mapear");
			const conf = readAll(
				path.join(tmpRoot, "veredito2.db"),
				dashboardSql("Confiança: de quando são os dados (agora)", { from: 0, to })
			);
			assert.strictEqual(conf.find((x) => x.Fonte === "Zinthos")["Motivos sem mapear (7 dias)"], 2); // NOVO_Z e NOVO
			assert.strictEqual(conf.find((x) => x.Fonte === "Runas")["Motivos sem mapear (7 dias)"], 0);
		});

		await test("situação por moeda: buraco conhecido fica em atenção; acima da própria base, agir; carga velha, atrasado", () => {
			// Runas: 10 semanas de retrato diário; cada dia a massa sobe 11 e o extrato só explica 10 → sem origem = 10% do
			// criado, todo dia (buraco conhecido). Variante: na última semana sobe 12 (20%, acima da própria base).
			const build = (name, ultima) => {
				const { file, db } = freshDb(name);
				const bal = db.prepare("INSERT INTO balances (ts, currency, total) VALUES (?, 'runas', ?)");
				const fl = db.prepare(
					"INSERT INTO flows_hourly VALUES (?, 'runas', 'DEPOSIT:pesca', 'creation', 10, 0, 1, 1)"
				);
				let total = 1000000;
				db.transaction(() => {
					for (let d = 0; d <= 70; d++) {
						bal.run(DAY0 + d * D, total);
						fl.run(DAY0 + d * D + H);
						total += 10 + (d >= 63 ? ultima : 1);
					}
				})();
				db.prepare(
					"INSERT INTO load_runs (ts, source, ok, window_from, window_to, rows) VALUES (1, 'runas', 1, 0, ?, 1)"
				).run(Date.now() - (name.includes("velha") ? 5 : 1) * 3600000);
				db.close();
				const v = readAll(
					file,
					dashboardSql("Situação por moeda (últimos 7 dias)", { from: 0, to: DAY0 + 70 * D })
				);
				return v.find((x) => x.Moeda === "Runas");
			};
			const conhecido = build("conhecido.db", 1);
			assert.strictEqual(conhecido["Sem origem (% do criado)"], 10);
			assert.strictEqual(conhecido["Situação"], "atenção · conhecido");
			assert.strictEqual(conhecido["Por quê"], "sem origem (na faixa das 8 semanas)");
			const acima = build("acima.db", 2);
			assert.strictEqual(acima["Situação"], "agir");
			assert.strictEqual(acima["Por quê"], "sem origem");
			assert.strictEqual(conhecido.Carga, "ativa a cada 1 h");
			const velha = build("velha.db", 1);
			assert.strictEqual(velha["Situação"], "dados atrasados");
			assert.match(velha["Por quê"], /carga atrasada$/);
			// Carga a cada 6 h: 5 h de atraso ainda é normal; pausada: nunca atrasada
			const db6 = new BetterSQLite(path.join(tmpRoot, "velha.db"));
			db6.prepare("INSERT INTO meta VALUES ('schedule.every_hours', '6')").run();
			db6.close();
			const sit = (f) =>
				readAll(
					path.join(tmpRoot, f),
					dashboardSql("Situação por moeda (últimos 7 dias)", { from: 0, to: DAY0 + 70 * D })
				).find((x) => x.Moeda === "Runas");
			assert.strictEqual(sit("velha.db")["Situação"], "atenção · conhecido");
			assert.strictEqual(sit("velha.db").Carga, "ativa a cada 6 h");
			// Intervalo em vigor gravado pela carga (admin > .env > 1) vale sobre a escolha do admin
			const dbe = new BetterSQLite(path.join(tmpRoot, "velha.db"));
			dbe.prepare("INSERT INTO meta VALUES ('schedule.effective_every_hours', '12')").run();
			assert.strictEqual(sit("velha.db").Carga, "ativa a cada 12 h");
			dbe.prepare("DELETE FROM meta WHERE key = 'schedule.effective_every_hours'").run();
			dbe.close();
			const dbp = new BetterSQLite(path.join(tmpRoot, "velha.db"));
			dbp.prepare("UPDATE meta SET value = '1' WHERE key = 'schedule.every_hours'").run();
			dbp.prepare("INSERT INTO meta VALUES ('schedule.paused', '1')").run();
			dbp
				.prepare("INSERT INTO meta VALUES ('schedule.updated_at', ?)")
				.run(String(Date.parse("2026-11-19T15:30:00Z")));
			dbp.close();
			assert.strictEqual(sit("velha.db")["Situação"], "atenção · conhecido");
			assert.strictEqual(sit("velha.db").Carga, "pausada desde 19/11 12:30");
		});

		await test("ciclo da alma gêmea: sem cotas à parte (NULL = desconhecido) e % sobre os com cotas", () => {
			const { file, db } = freshDb("alma.db");
			db.prepare(
				"INSERT INTO features (key, title, available, ts) VALUES ('ciclo_alma_gemea', 'Ciclo', 1, 0)"
			).run();
			db.prepare(
				"INSERT INTO soulmate_cycle_hourly (hour, divorces, paid, quota_cost, above_cost, max_return) VALUES (?, 5, 100, 50, 2, 2)"
			).run(DAY0 + H);
			db.close();
			const range = { from: DAY0 - D, to: DAY0 + D };
			const dia = () =>
				readAll(file, dashboardSql("Ciclo da alma gêmea por dia (período selecionado)", range))[0];
			const semCotas = () =>
				readAll(file, dashboardSql("Divórcios de alma gêmea sem cotas (últimos 7 dias)", range))[0][
					"Sem cotas"
				];
			// without_quota NULL (waifuletes antigo): sem cotas desconhecido, % sobre os 5
			assert.strictEqual(dia()["Sem cotas"], null);
			assert.strictEqual(dia()["% dos com cotas"], 40);
			assert.strictEqual(dia()["Pagou mais que as cotas"], 2);
			assert.strictEqual(semCotas(), "desconhecido");
			// 1 dos 5 sem cotas → 2 de 4
			const db2 = new BetterSQLite(file);
			db2.prepare("UPDATE soulmate_cycle_hourly SET without_quota = 1").run();
			db2.close();
			assert.strictEqual(dia()["Sem cotas"], 1);
			assert.strictEqual(dia()["% dos com cotas"], 50);
			assert.strictEqual(semCotas(), "1");
		});

		await test("alerta de carga atrasada: só fontes das últimas 48 h, intervalo + 2 h, pausada não dispara", () => {
			const rules = JSON.parse(
				fs
					.readFileSync(
						path.join(REPO_ROOT, "observability/grafana/provisioning/alerting/economia.yaml"),
						"utf8"
					)
					.replace(/^#.*$/gm, "")
			).groups[0].rules;
			const r = rules.find((x) => x.uid === "economia-carga-atrasada");
			assert.strictEqual(r.data[2].model.conditions[0].evaluator.params[0], 0);
			const { file, db } = freshDb("alerta-carga.db");
			const lr = db.prepare(
				"INSERT INTO load_runs (ts, source, ok, window_from, window_to, rows) VALUES (1, ?, 1, 0, ?, 1)"
			);
			lr.run("zinthos", Date.now() - 5 * 3600000);
			lr.run("petalitas", Date.now() - 5 * 86400000); // desligada há dias: fora
			lr.run("runas", Date.now() - 3600000);
			db.close();
			const v = () => Object.values(readAll(file, r.data[0].model.queryText)[0])[0];
			assert.ok(Math.abs(v() - 2) < 0.05, `5 h de atraso − 3 h de limite: ${v()}`);
			const db2 = new BetterSQLite(file);
			db2.prepare("INSERT INTO meta VALUES ('schedule.every_hours', '6')").run();
			db2.close();
			assert.ok(v() < 0);
			const db3 = new BetterSQLite(file);
			db3.prepare("INSERT INTO meta VALUES ('schedule.paused', '1')").run();
			db3.close();
			assert.strictEqual(v(), 0);
		});

		await test("de onde vem e para onde vai: top 8 por |líquido| + Outros, sem mapear sempre aparece", () => {
			const { file, db } = freshDb("topn.db");
			const fl = db.prepare("INSERT INTO flows_hourly VALUES (?, 'runas', ?, ?, ?, ?, 1, 1)");
			for (let i = 1; i <= 12; i++) fl.run(DAY0 + i * H, `R${i}`, "creation", i * 100, 0);
			fl.run(DAY0, "MISTERIO", "unknown", 1, 0); // o menor de todos, mas sem mapear
			db.close();
			const rows = readAll(
				file,
				dashboardSql("De onde vem e para onde vai — ${moeda} (últimos 7 dias)", {
					from: 0,
					to: DAY0 + D,
					moeda: "runas"
				})
			);
			assert.deepStrictEqual(
				rows.map((r) => r.Motivo),
				["R12", "R11", "R10", "R9", "R8", "R7", "R6", "R5", "MISTERIO", "Outros (4 motivos)"]
			);
			assert.strictEqual(rows[9]["Líquido"], "+1,000"); // texto neutro com sinal: 100 + 200 + 300 + 400
		});

		await test("totais: criado/destruído só com creation/destruction; câmbio e transferência à parte; nomes legíveis", () => {
			const { file, db } = freshDb("week.db");
			const insL = db.prepare(
				"INSERT INTO reason_labels (currency, reason, label, kind) VALUES (?, ?, ?, ?)"
			);
			for (const r of reasonLabelRows()) insL.run(r.currency, r.reason, r.label, r.kind);
			const fl = db.prepare("INSERT INTO flows_hourly VALUES (?, 'zinthos', ?, ?, ?, ?, ?, 1)");
			const h = DAY0 + D;
			fl.run(h, "DAILY_REWARD", "creation", 100, 0, 3);
			fl.run(h, "ADMIN_GRANT", "creation", 20, 5, 2); // ajuste negativo conta como destruído
			fl.run(h, "HOSTING_FEE", "destruction", 0, 30, 1);
			fl.run(h, "MARKET_TRADE", "transfer", 50, 52, 2);
			fl.run(h, "ADMIN_GRANT:bank_withdraw_zinthos", "exchange_in", 70, 0, 1);
			fl.run(h, "ADMIN_GRANT:bank_deposit_runas", "exchange_out", 0, 40, 1);
			fl.run(h, "HOSTING_FEE_WAIFU", "non_monetary", 99999, 0, 4);
			fl.run(h, "NOVO_MOTIVO", "unknown", 7, 0, 1);
			db.prepare("INSERT INTO balances (ts, currency, total) VALUES (?, 'zinthos', 1000)").run(h);
			db.close();
			const to = DAY0 + 3 * D;
			const c = readAll(
				file,
				dashboardSql("Câmbio e transferências (últimos 7 dias)", { from: 0, to })
			).find((x) => x.Moeda === "Zinthos");
			assert.deepStrictEqual(
				[
					c["Câmbio: entrou"],
					c["Câmbio: saiu"],
					c["Câmbio: líquido"],
					c["Transferido entre jogadores"],
					c["Transferência: líquido (taxa)"],
					c["Linhas fora do dinheiro"]
				],
				[70, 40, 30, 50, -2, 4]
			);
			const byReason = readAll(
				file,
				dashboardSql("De onde vem e para onde vai — ${moeda} (últimos 7 dias)", { from: 0, to })
			);
			const get = (m) => byReason.find((x) => x.Motivo === m);
			assert.deepStrictEqual(Object.keys(byReason[0]), [
				"Motivo",
				"Tipo",
				"Entrou",
				"Saiu",
				"Líquido",
				"Transações"
			]);
			assert.deepStrictEqual(
				[get("Recompensa diária").Tipo, get("Recompensa diária").Entrou],
				["Criação", 100]
			);
			assert.strictEqual(get("Câmbio: compra com Runas").Tipo, "Câmbio (entrada)");
			const nm = get("Taxa de hospedagem: waifu confiscada");
			assert.deepStrictEqual([nm.Tipo, nm.Entrou, nm["Transações"]], ["Fora do dinheiro", null, 4]);
			assert.strictEqual(get("NOVO_MOTIVO").Tipo, "Sem mapeamento"); // sem nome: aparece cru
			const daily = readAll(
				file,
				dashboardSql("Criado, destruído e líquido por dia — ${moeda} (período selecionado)", {
					from: 0,
					to
				})
			);
			// destruído abaixo de zero, líquido em linha
			assert.deepStrictEqual(
				[daily[0]["Criado"], daily[0]["Destruído"], daily[0]["Líquido"]],
				[120, -35, 85]
			);
			const unk = readAll(
				file,
				dashboardSql("Motivos sem mapeamento (últimos 7 dias)", { from: 0, to })
			);
			assert.deepStrictEqual(
				unk.map((x) => x["Motivo (cru)"]),
				["NOVO_MOTIVO"]
			);
			// Nenhuma consulta do painel soma a linha non_monetary
			for (const p of dashboardPanels()) {
				if (!p.targets.length) continue;
				const rows = readAll(file, dashboardSql(p.title, { from: 0, to }));
				assert.ok(!JSON.stringify(rows).includes("99999"), `${p.title} somou non_monetary`);
			}
		});

		await test("dashboards commitados = saída do gerador (observability/grafana/tools/mkdash.py)", () => {
			const { spawnSync } = require("child_process");
			const py = spawnSync("python3", ["--version"]);
			if (py.error || py.status !== 0) {
				console.warn("  (aviso: python3 ausente, comparação com o gerador pulada)");
				return;
			}
			const out = fs.mkdtempSync(path.join(tmpRoot, "mkdash-"));
			const gen = spawnSync(
				"python3",
				["-B", path.join(REPO_ROOT, "observability/grafana/tools/mkdash.py"), REPO_ROOT, out],
				{ encoding: "utf8" }
			);
			assert.strictEqual(gen.status, 0, gen.stderr);
			for (const f of [
				"dashboards/economia.json",
				"dashboards/jogador.json",
				"provisioning/alerting/economia.yaml"
			]) {
				const a = fs.readFileSync(path.join(REPO_ROOT, "observability/grafana", f));
				const b = fs.readFileSync(path.join(out, "observability/grafana", f));
				assert.ok(
					a.equals(b),
					`${f} difere da saída do gerador: rode python3 observability/grafana/tools/mkdash.py .`
				);
			}
		});

		await test("layout: nenhum painel sobrepõe outro, em toda grade dos dois dashboards", () => {
			for (const file of [DASHBOARD, DASHBOARD_JOGADORES]) {
				const grids = [];
				const walk = (l, where) => {
					if (!l || typeof l !== "object") return;
					if (l.kind === "GridLayout") grids.push({ where, items: l.spec.items });
					for (const t of l.spec?.tabs || []) walk(t.spec.layout, `${where} > ${t.spec.title}`);
					for (const r of l.spec?.rows || []) walk(r.spec.layout, `${where} > ${r.spec.title}`);
				};
				walk(JSON.parse(fs.readFileSync(file, "utf8")).spec.layout, path.basename(file));
				assert.ok(grids.length > 0);
				for (const { where, items } of grids) {
					for (let i = 0; i < items.length; i++) {
						const a = items[i].spec;
						assert.ok(
							a.x >= 0 && a.x + a.width <= 24,
							`${where}: ${a.element.name} fora da largura`
						);
						for (let j = i + 1; j < items.length; j++) {
							const b = items[j].spec;
							const cruza =
								a.x < b.x + b.width &&
								b.x < a.x + a.width &&
								a.y < b.y + b.height &&
								b.y < a.y + a.height;
							assert.ok(!cruza, `${where}: ${a.element.name} sobrepõe ${b.element.name}`);
						}
					}
				}
			}
		});

		await test("painel: seis abas, Resumo numa tela, alma gêmea só com Zinthos, colunas legíveis, período no título, padrão 7 dias", () => {
			const dash = JSON.parse(fs.readFileSync(DASHBOARD, "utf8"));
			assert.strictEqual(dash.apiVersion, "dashboard.grafana.app/v2");
			assert.strictEqual(dash.metadata.name, "ravena-economia");
			assert.deepStrictEqual(
				[dash.spec.timeSettings.from, dash.spec.timeSettings.to],
				["now-7d", "now"]
			);
			const layout = dashboardLayout();
			assert.deepStrictEqual(
				layout.map((t) => t.title),
				["Resumo", "Moeda", "Jogadores", "Atividade", "Mudanças", "Diagnóstico"]
			);
			const byName = new Map(dashboardPanels().map((p) => [p.name, p]));
			// Resumo com uma escala (seções da massa só aparecem com a Escala delas)
			const escalaDe = (s) => s.conditional?.spec.items[0].spec.value;
			const resumoCom = (escala) =>
				layout[0].sections.filter((s) => !s.conditional || escalaDe(s) === escala);
			assert.deepStrictEqual(layout[0].sections.filter((s) => s.conditional).map(escalaDe), [
				"indice",
				"valor",
				"separado"
			]);
			for (const escala of ["indice", "valor", "separado"]) {
				const resumo = resumoCom(escala).flatMap((s) => s.elements.map((n) => byName.get(n)));
				assert.deepStrictEqual(
					resumo.filter((p) => p.type !== "text").map((p) => p.type),
					["table", "alertlist", "timeseries", "table"],
					"Resumo: situação por moeda, alertas, massa, mudanças"
				);
			}
			// Resumo cabe em 1920×1080: cada linha da grade ocupa ~38 px reais (30 + espaço), ~22 linhas abaixo do topo
			// (variáveis e abas)
			const rows = dash.spec.layout.spec.tabs[0].spec.layout.spec.rows;
			for (const escala of ["indice", "valor", "separado"]) {
				const resumoH = rows
					.filter(
						(r) =>
							!r.spec.conditionalRendering ||
							r.spec.conditionalRendering.spec.items[0].spec.value === escala
					)
					.reduce(
						(t, r) =>
							t +
							r.spec.layout.spec.items.reduce((m, i) => Math.max(m, i.spec.y + i.spec.height), 0),
						0
					);
				assert.ok(resumoH <= 22, `Resumo (${escala}) com ${resumoH} linhas de grade`);
			}
			// Separado: um gráfico por moeda escolhida
			const sep = rows.find(
				(r) => r.spec.conditionalRendering?.spec.items[0].spec.value === "separado"
			);
			assert.strictEqual(sep.spec.layout.spec.items[0].spec.repeat.value, "moedas");
			const alma = layout[1].sections.find((s) => s.title === "Ciclo da alma gêmea");
			assert.deepStrictEqual(alma.conditional.spec.items[0].spec, {
				variable: "moeda",
				operator: "equals",
				value: "zinthos"
			});
			// Estados vazios por renderização condicional (timeseries não mostra noValue): Petalitas sem fluxos, com aviso
			const cond = (sec) => sec.conditional?.spec.items[0].spec;
			const moedaTab = layout[1].sections;
			assert.deepStrictEqual(cond(moedaTab.find((s) => s.title === "Fluxos — ${moeda}")), {
				variable: "moeda",
				operator: "notEquals",
				value: "petalitas"
			});
			const aviso = moedaTab.find(
				(s) => cond(s)?.value === "petalitas" && cond(s).operator === "equals"
			);
			assert.strictEqual(byName.get(aviso.elements[0]).title, "Petalitas: sem extrato (fase 2)");
			// Ficha do jogador só com jogador escolhido; sem ele, a instrução
			const jogSecs = dashboardLayout(DASHBOARD_JOGADORES)[0].sections;
			assert.deepStrictEqual(
				jogSecs.map((s) => cond(s) && [s.title, cond(s).operator, cond(s).value]).filter(Boolean),
				[
					["", "equals", ""],
					["Jogador escolhido: ${nome} · ${jogador}", "notEquals", ""]
				]
			);
			// Todo elemento do layout existe e todo elemento está no layout (uma vez)
			const used = layout.flatMap((t) => t.sections.flatMap((s) => s.elements));
			assert.deepStrictEqual([...used].sort(), [...byName.keys()].sort());
			// Variáveis: moeda (uma), moedas (várias, todas marcadas) e escala
			const vars = Object.fromEntries(dash.spec.variables.map((v) => [v.spec.name, v.spec]));
			assert.strictEqual(vars.moeda.multi, false);
			assert.strictEqual(vars.moedas.multi, true);
			assert.deepStrictEqual(vars.moedas.current.value, ["zinthos", "petalitas", "runas"]);
			assert.deepStrictEqual(
				vars.escala.options.map((o) => o.value),
				["indice", "valor", "separado"]
			);
			for (const p of dashboardPanels().filter((x) => x.targets.length)) {
				const sql = p.targets[0].queryText;
				for (const m of sql.matchAll(/ AS ([a-z_]+)\b/g)) {
					assert.ok(
						[
							"time",
							"text",
							"tags",
							"massa",
							"massa_antes",
							"ts_dados",
							"criado",
							"so7",
							"maior_fonte",
							"avail",
							"g",
							"so_massa",
							"so_criado",
							"lv_g",
							"lv_sm",
							"lv_sc",
							"lv_u",
							"lv",
							"unk",
							"motivo",
							"ent",
							"sai",
							"liq",
							"tx",
							"pos",
							"grp",
							"lv_so",
							"d",
							"rn",
							"ta",
							"t0",
							"d_next",
							"tb",
							"t1",
							"dias",
							"total_fim",
							"so",
							// ficha de antes e depois (CTE interna; as colunas exibidas têm nome legível)
							"c",
							"cri_a",
							"cri_d",
							"cri_d_tot",
							"des_a",
							"des_d",
							"des_d_tot",
							"jog_a",
							"jog_d",
							"n",
							"massa_na",
							"massa_dep",
							"id",
							"origin",
							"v",
							"ruido",
							"semanas",
							"dcri",
							"situacao",
							"motivos",
							"t0",
							"n",
							// situação por moeda (histórico de 8 semanas, carga)
							...[
								"so_k",
								"cri_k",
								"massa_k",
								"max_sc",
								"max_sm",
								"carga",
								"atraso",
								"conh",
								"late"
							],
							...["lv_so_bruto", "ev", "pz", "desde", "wq", "k", "massa_ant"],
							// ranking da aba Jogadores (CTE internas)
							...[
								"cambio",
								"destruido",
								"liquido",
								"m",
								"mediana",
								"nome",
								"phone",
								"saldo",
								"tipos",
								"transf"
							]
						].includes(m[1]),
						`${p.title}: coluna em snake_case ${m[1]}`
					);
				}
				if (
					!/Últimas mudanças|Confiança|Disponibilidade|Ficha de antes e depois|Possíveis mudanças/.test(
						p.title
					)
				) {
					assert.match(
						p.title,
						/últimos 7 dias|12 semanas|período selecionado|retrato mais recente|últimas 50|agora/,
						p.title
					);
				}
			}
		});

		await test("mapeamento: todo motivo mapeado tem nome; a subida regrava o tipo mesmo sem subir a versão", () => {
			for (const [cur, table] of Object.entries(MAPPING)) {
				for (const reason of Object.keys(table))
					assert.ok(LABELS[cur][reason], `${cur}/${reason} sem nome legível`);
			}
			const wdb = path.join(tmpRoot, "remap", "a.db");
			const pdir = path.join(tmpRoot, "remap-pub");
			const s1 = new EconomyAnalyticsService({ dbPath: wdb, publishDir: pdir, sources: [] });
			const st = s1._getStore();
			const fl = st.db.prepare("INSERT INTO flows_hourly VALUES (?, ?, ?, ?, 1, 0, 1, 1)");
			fl.run(DAY0, "zinthos", "DAILY_REWARD", "unknown"); // gravado por uma versão antiga
			fl.run(DAY0, "zinthos", "MOTIVO_FUTURO", "creation");
			st.db.prepare("UPDATE meta SET value = '0' WHERE key = 'mapping_version'").run();
			const balBefore = st.db.prepare("SELECT COUNT(*) n FROM balances").get().n;
			st.close();
			s1.store = null;
			const s2 = new EconomyAnalyticsService({ dbPath: wdb, publishDir: pdir, sources: [] });
			const kinds = s2
				._getStore()
				.db.prepare("SELECT reason, kind FROM flows_hourly ORDER BY reason")
				.all();
			assert.deepStrictEqual(kinds, [
				{ reason: "DAILY_REWARD", kind: "creation" },
				{ reason: "MOTIVO_FUTURO", kind: "unknown" }
			]);
			assert.strictEqual(
				s2.store.db.prepare("SELECT value FROM meta WHERE key='mapping_version'").get().value,
				String(MAPPING_VERSION)
			);
			assert.strictEqual(s2.store.db.prepare("SELECT COUNT(*) n FROM balances").get().n, balBefore);
			// Mudança no mapeamento SEM subir a versão também vale na próxima subida
			s2.store.close();
			s2.store = null;
			const before = MAPPING.zinthos.DAILY_REWARD;
			MAPPING.zinthos.MOTIVO_FUTURO = "destruction";
			MAPPING.zinthos.DAILY_REWARD = "transfer";
			let s3;
			try {
				s3 = new EconomyAnalyticsService({ dbPath: wdb, publishDir: pdir, sources: [] });
				const k3 = s3
					._getStore()
					.db.prepare("SELECT reason, kind FROM flows_hourly ORDER BY reason")
					.all();
				assert.deepStrictEqual(k3, [
					{ reason: "DAILY_REWARD", kind: "transfer" },
					{ reason: "MOTIVO_FUTURO", kind: "destruction" }
				]);
				assert.strictEqual(
					s3.store.db
						.prepare(
							"SELECT kind FROM reason_labels WHERE currency='zinthos' AND reason='DAILY_REWARD'"
						)
						.get().kind,
					"transfer"
				);
			} finally {
				MAPPING.zinthos.DAILY_REWARD = before;
				delete MAPPING.zinthos.MOTIVO_FUTURO;
			}
			s3.store.close();
		});

		await test("recarga de janela: regrava só fluxos, nunca saldos; janela inválida recusada", async () => {
			const balances = () => readAll(dbPath, "SELECT * FROM balances ORDER BY ts, currency");
			const before = balances();
			const last = svc.store.getLastSuccessfulTo("zinthos");
			// Serviço corrigiu o extrato: o motivo novo agora vem como DIVORCE
			state.override.waifuletes = (b) => ({
				ledger: {
					available: true,
					flows: b.ledger.flows.map((f) =>
						f.reason === "NEW_REASON_X" ? { ...f, reason: "DIVORCE" } : f
					)
				}
			});
			state.calls.length = 0;
			const r = await svc.reloadFlows("zinthos", DAY0, DAY0 + D < last ? DAY0 + D : last);
			state.override.waifuletes = null;
			assert.strictEqual(r.ok, true);
			assert.deepStrictEqual(
				state.calls.map((c) => c.balances),
				[false],
				"recarga pede balances=0"
			);
			const z = readAll(
				dbPath,
				"SELECT reason, kind FROM flows_hourly WHERE currency='zinthos' AND hour=?",
				[DAY0]
			);
			assert.ok(z.some((x) => x.reason === "DIVORCE" && x.kind === "creation"));
			assert.ok(!z.some((x) => x.reason === "NEW_REASON_X"));
			assert.deepStrictEqual(balances(), before, "balances intacto");
			assert.strictEqual(
				readAll(dbPath, "SELECT ok FROM load_runs WHERE source='zinthos.reload'")[0].ok,
				1
			);
			// Janelas inválidas
			await assert.rejects(svc.reloadFlows("zinthos", DAY0 + D, DAY0), /início precisa ser antes/);
			await assert.rejects(svc.reloadFlows("zinthos", DAY0 + 1, DAY0 + H), /hora cheia/);
			await assert.rejects(svc.reloadFlows("zinthos", DAY0 - 100 * D, DAY0), /90 dias/);
			await assert.rejects(svc.reloadFlows("zinthos", DAY0, last + H), /última carga/);
			await assert.rejects(svc.reloadFlows("petalitas", DAY0, DAY0 + H), /não tem extrato/);
			await assert.rejects(
				svc.reloadFlows("zinthos", DAY0, DAY0 + H, { runasBalances: true }),
				/só vale para Runas/
			);
			await assert.rejects(svc.reloadFlows("ouro", DAY0, DAY0 + H), /moeda desconhecida/);
			assert.deepStrictEqual(balances(), before);
			// Runas com --saldos-runas: só preenche retrato diário que falta, não sobrescreve
			const db = new BetterSQLite(dbPath);
			db.prepare("DELETE FROM balances WHERE currency='runas' AND ts = ?").run(DAY0);
			db.prepare("UPDATE balances SET total = 424242 WHERE currency='runas' AND ts = ?").run(
				DAY0 + 5 * H
			);
			db.close();
			const rr = await svc.reloadFlows("runas", DAY0 - H, DAY0 + 6 * H, { runasBalances: true });
			assert.strictEqual(rr.snapshots, 1);
			const rb = readAll(
				dbPath,
				"SELECT ts, total FROM balances WHERE currency='runas' AND ts IN (?, ?) ORDER BY ts",
				[DAY0, DAY0 + 5 * H]
			);
			assert.deepStrictEqual(
				rb.map((x) => x.ts),
				[DAY0, DAY0 + 5 * H]
			);
			assert.strictEqual(rb[1].total, 424242, "retrato existente não é sobrescrito");
			// Pelo script: argumento ruim é recusado com saída 1
			const { spawnSync } = require("child_process");
			const cli = spawnSync(
				process.execPath,
				[
					path.join(__dirname, "../../scripts/economy-reload.js"),
					"--moeda",
					"zinthos",
					"--de",
					"2026-11-12",
					"--ate",
					"2026-11-10"
				],
				{
					env: {
						...process.env,
						ECONOMY_ANALYTICS_DB: dbPath,
						ECONOMY_ANALYTICS_PUBLISH_DIR: publishDir,
						WAIFULETES_API_URL: base,
						WAIFULETES_API_KEY: "test-waifu-key"
					},
					encoding: "utf8"
				}
			);
			assert.strictEqual(cli.status, 1);
			assert.match(cli.stderr, /Recusado: janela inválida/);
		});

		await test("Runas sem saldos nos pedaços históricos (não lê bank_accounts)", () => {
			const seen = [];
			const spy = (sql, params) => (seen.push(sql), bankQuery(sql, params));
			const sNo = R.buildRunasSummary(spy, DAY0, DAY0 + D, DAY0 + D, { noBalances: true });
			assert.strictEqual(sNo.balances, null);
			assert.ok(sNo.ledger.flows.length > 0);
			assert.ok(!seen.some((q) => /bank_accounts/.test(q)));
		});

		await test("marca do painel (application_id): banco antigo é marcado, tabela desconhecida aceita, alheio recusado", () => {
			const St = require("../services/EconomyAnalyticsStore");
			const dir = path.join(tmpRoot, "marca");
			fs.mkdirSync(dir, { recursive: true });
			// Banco de versão anterior à marca: só tabelas do painel, sem application_id
			const legacy = path.join(dir, "antigo.db");
			const l = new BetterSQLite(legacy);
			l.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			l.exec(
				"CREATE TABLE soulmate_cycle_hourly (hour INTEGER PRIMARY KEY, divorces INTEGER NOT NULL, paid INTEGER NOT NULL, quota_cost INTEGER NOT NULL, above_cost INTEGER NOT NULL, max_return REAL)"
			);
			l.prepare("INSERT INTO soulmate_cycle_hourly VALUES (?, 3, 10, 5, 1, 2)").run(DAY0);
			l.close();
			assert.strictEqual(St.foreignReason(legacy), null);
			const st = new St.EconomyAnalyticsStore(legacy, path.join(dir, "pub1"));
			assert.strictEqual(st.db.pragma("application_id", { simple: true }), St.APP_ID);
			// Coluna nova por ADD COLUMN, linha antiga intacta com NULL (waifuletes antigo)
			assert.deepStrictEqual(st.db.prepare("SELECT * FROM soulmate_cycle_hourly").all(), [
				{
					hour: DAY0,
					divorces: 3,
					paid: 10,
					quota_cost: 5,
					above_cost: 1,
					max_return: 2,
					without_quota: null
				}
			]);
			// Versão mais nova criou uma tabela que esta não conhece: aceita (volta de versão sem recusa)
			st.db.exec("CREATE TABLE tabela_do_futuro (x)");
			st.close();
			assert.strictEqual(St.foreignReason(legacy), null);
			new St.EconomyAnalyticsStore(legacy, path.join(dir, "pub1")).close();
			// Sem marca e com tabela alheia, ou com outra marca: recusado
			const alien = path.join(dir, "alheio.db");
			const a = new BetterSQLite(alien);
			a.exec("CREATE TABLE meta (k); CREATE TABLE bank_accounts (x)");
			a.close();
			assert.match(St.foreignReason(alien), /bank_accounts/);
			const other = path.join(dir, "outra-marca.db");
			const o = new BetterSQLite(other);
			o.pragma("application_id = 1234");
			o.exec("CREATE TABLE meta (k)");
			o.close();
			assert.match(St.foreignReason(other), /application_id 1234/);
			assert.throws(
				() => new St.EconomyAnalyticsStore(other, path.join(dir, "pub2")),
				/não é do painel/
			);
		});

		await test("massa histórica desconta os motivos non_monetary do mapeamento; índice players(player_id)", () => {
			const { nonMonetaryReasons } = require("../services/EconomyAnalyticsMapping");
			const nm = Object.entries(MAPPING.zinthos)
				.filter(([, k]) => k === "non_monetary")
				.map(([r]) => r);
			assert.deepStrictEqual(nonMonetaryReasons("zinthos"), nm);
			assert.ok(nm.includes("HOSTING_FEE_WAIFU"));
			const idx = readAll(dbPath, "PRAGMA index_list(players)").map((r) => r.name);
			assert.ok(idx.includes("idx_players_player"), idx.join(","));
		});

		await test("subida regrava o tipo também em player_daily; identities.name cai no nome do serviço", () => {
			const wdb = path.join(tmpRoot, "remap2", "a.db");
			const pdir = path.join(tmpRoot, "remap2-pub");
			const s1 = new EconomyAnalyticsService({
				dbPath: wdb,
				publishDir: pdir,
				sources: [],
				memoryQuery: () => []
			});
			const st = s1._getStore();
			st.db
				.prepare(
					"INSERT INTO player_daily VALUES (?, 'zinthos', '5511900000001', 'DAILY_REWARD', 'unknown', 5, 0, 1)"
				)
				.run(DAY0);
			const pl = st.db.prepare(
				"INSERT INTO players (currency, player_id, name, balance, updated_ts) VALUES (?, ?, ?, 0, 0)"
			);
			pl.run("zinthos", "5511900000001", "Bia");
			pl.run("runas", "551100000001", null); // mesma pessoa (12 dígitos) sem nome
			st.close();
			s1.store = null;
			const s2 = new EconomyAnalyticsService({
				dbPath: wdb,
				publishDir: pdir,
				sources: [],
				memoryQuery: () => []
			});
			const st2 = s2._getStore();
			assert.strictEqual(st2.db.prepare("SELECT kind FROM player_daily").get().kind, "creation");
			s2._refreshIdentities(st2);
			assert.deepStrictEqual(
				st2.db.prepare("SELECT player_id, person, name FROM identities ORDER BY player_id").all(),
				[
					{ player_id: "551100000001", person: "5511900000001", name: "Bia" },
					{ player_id: "5511900000001", person: "5511900000001", name: "Bia" }
				]
			);
			st2.close();
			s2.store = null;
		});

		await test("worker: sobe, roda a rodada da subida com fontes falsas, responde estado e para", async () => {
			const Host = require("../services/EconomyAnalyticsWorkerHost");
			const wpub = path.join(tmpRoot, "worker-pub");
			const host = new Host({
				serviceOpts: {
					dbPath: path.join(tmpRoot, "worker", "analytics.db"),
					publishDir: wpub,
					bankDbPath: path.join(tmpRoot, "bank.db"),
					memoryDbPath: path.join(tmpRoot, "nao-existe.db"),
					cmdUsageDbPath: path.join(tmpRoot, "cmd_usage.db"),
					waifuletesUrl: base,
					waifuletesKey: "test-waifu-key",
					jardimUrl: base,
					jardimKey: "test-jardim-key",
					playerDays: 2,
					backfillStart: R.hourStart(Date.now()) - 2 * D,
					startDelayMs: 10
				}
			});
			host.start();
			assert.strictEqual(await host.ready(), true);
			const pub = path.join(wpub, "analytics.db");
			for (let i = 0; i < 200 && !fs.existsSync(pub); i++) {
				await new Promise((r) => setTimeout(r, 50));
			}
			assert.ok(fs.existsSync(pub), "rodada da subida publicou o retrato");
			const st = await host.status();
			const hourNow = R.hourStart(Date.now());
			for (const src of ["zinthos", "petalitas", "runas"]) {
				const l = st.loads.find((x) => x.source === src);
				assert.ok(l && l.lastOk && l.okTo === hourNow, `${src}: ${JSON.stringify(l)}`);
			}
			assert.strictEqual(st.scheduled, true);
			// Rodar agora: começa sem esperar; outra chamada durante a rodada não duplica
			const a = await host.runNow();
			const b = await host.runNow();
			assert.strictEqual(a.started, true);
			assert.strictEqual(b.started, false);
			const t0 = Date.now();
			assert.strictEqual(await host.stop(), true);
			assert.ok(Date.now() - t0 < 3000, `stop demorou ${Date.now() - t0} ms`);
			assert.strictEqual(host.running, false);
			await assert.rejects(host.status(), /não está rodando/);
		});

		await test("worker que não para a tempo é encerrado em no máximo stopWaitMs", async () => {
			const Host = require("../services/EconomyAnalyticsWorkerHost");
			const host = new Host({
				stopWaitMs: 0,
				serviceOpts: {
					dbPath: path.join(tmpRoot, "worker2", "analytics.db"),
					publishDir: path.join(tmpRoot, "worker2-pub"),
					sources: [],
					runOnStart: false
				}
			});
			host.start();
			await host.ready();
			// Prazo zero: não espera a saída e encerra com terminate()
			const t0 = Date.now();
			assert.strictEqual(await host.stop(), false);
			assert.ok(Date.now() - t0 < 1000, `stop demorou ${Date.now() - t0} ms`);
			assert.strictEqual(host.running, false);
		});

		await test("todas as consultas do painel rodam no retrato publicado", () => {
			let n = 0;
			for (const p of dashboardPanels()) {
				if (!p.targets.length) continue;
				for (const moeda of ["zinthos", "petalitas", "runas"]) {
					readAll(pubFile, dashboardSql(p.title, { from: DAY0 - 90 * D, to: clock, moeda }));
				}
				n++;
			}
			assert.ok(n >= 15, `esperava >= 15 painéis com consulta, achou ${n}`);
		});
	} finally {
		await svc.stop();
		server.close();
		bank.close();
	}

	fs.rmSync(tmpRoot, { recursive: true, force: true });
	console.log(`\n${passed} testes passaram.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
