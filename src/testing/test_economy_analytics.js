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

const { kindFor, MAPPING, KINDS } = require("../services/EconomyAnalyticsMapping");
const { SCHEMA } = require("../services/EconomyAnalyticsStore");
const R = require("../services/EconomyAnalyticsRunas");
const EconomyAnalyticsService = require("../services/EconomyAnalyticsService");

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
		const isWaifu = req.headers.authorization === "Bearer test-waifu-key";
		const isJardim = req.headers["x-api-key"] === "test-jardim-key";
		const svc = isWaifu ? "waifuletes" : isJardim ? "jardim" : null;
		if (!svc || u.pathname !== "/internal/economy/summary") {
			res.writeHead(401).end("{}");
			return;
		}
		state.calls.push({ svc, from, to, received });
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
		if (state.override[svc]) Object.assign(body, state.override[svc](body));
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
	});
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
function dashboardPanels() {
	const dash = JSON.parse(fs.readFileSync(DASHBOARD, "utf8"));
	return dash.panels.flatMap((p) => (p.panels ? [p, ...p.panels] : [p]));
}

/** Consulta de um painel com a interpolação que o frontend faz ($__from/$__to em ms, ${moeda}). */
function dashboardSql(title, { from, to, moeda = "zinthos" }) {
	const panel = dashboardPanels().find((p) => p.title === title);
	assert.ok(panel, `painel "${title}" não encontrado`);
	return panel.targets[0].queryText
		.replace(/\$__from\b/g, String(from))
		.replace(/\$__to\b/g, String(to))
		.replace(/\$\{moeda:sqlstring\}/g, `'${moeda}'`)
		.replace(/\$\{moeda\}/g, moeda);
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
	await test("quintos com n < 10 saem nulos; percentis, top10Share; total inclui saldo negativo", () => {
		const small = R.balanceStats([0, 0, ...Array.from({ length: 30 }, (_, i) => i + 1)]);
		assert.strictEqual(small.accounts, 32);
		assert.strictEqual(small.holders, 30);
		assert.strictEqual(small.total, 465);
		assert.ok(
			small.quintiles.every((q) => q.n === 6 && q.min === null && q.max === null && q.sum === null)
		);
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
		assert.strictEqual(mixed.quintiles[0].sum, null);
		assert.notStrictEqual(mixed.quintiles[1].sum, null);

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

	await test("receivedByQuintile: nulos em grupo pequeno, mediana inclui quem não recebeu", () => {
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
		assert.ok(few.every((q) => q.receivedSum === null && q.receivedMedian === null));
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
			sources: ["zinthos", "petalitas", "runas"]
		});
	let svc = mkService();

	try {
		await test("primeira carga: from=0 em pedaços, fontes isoladas, retrato só na janela atual, publicação", async () => {
			state.fail.jardim = true;
			const r = await svc.runOnce();
			const hourNow = DAY0 + 5 * H;
			const w = state.calls
				.filter((c) => c.svc === "waifuletes" && !c.received)
				.map((c) => [c.from, c.to]);
			assert.deepStrictEqual(w, [
				[0, BF],
				[BF, BF + 30 * D],
				[BF + 30 * D, BF + 60 * D],
				[BF + 60 * D, hourNow]
			]);
			assert.strictEqual(
				state.calls.filter((c) => c.svc === "jardim").length,
				1,
				"Jardim para no 1º erro"
			);
			assert.strictEqual(r.zinthos.ok, true);
			assert.strictEqual(r.zinthos.chunks, 4);
			assert.strictEqual(r.runas.ok, true);
			assert.strictEqual(r.petalitas.ok, false);
			const pet = readAll(dbPath, "SELECT ok, error FROM load_runs WHERE source='petalitas'");
			assert.deepStrictEqual(
				pet.map((x) => x.ok),
				[0]
			);
			assert.match(pet[0].error, /HTTP 500/);
			assert.strictEqual(readAll(dbPath, "PRAGMA journal_mode")[0].journal_mode, "wal");
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
			// Retrato dos serviços só uma vez (janela que chega à hora atual), no instante da resposta
			assert.deepStrictEqual(
				readAll(dbPath, "SELECT ts FROM balances WHERE currency='zinthos'").map((x) => x.ts),
				[clock]
			);
			// Runas: retrato diário (07:00) + reconstruído exatamente na hora cheia
			assert.deepStrictEqual(
				readAll(dbPath, "SELECT ts FROM balances WHERE currency='runas' ORDER BY ts").map(
					(x) => x.ts
				),
				[DAY0, hourNow]
			);
			// Quem recebe: zinthos (received=1) e runas; petalitas nunca carregou → nada
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
			const recv = state.calls.filter((c) => c.received);
			assert.deepStrictEqual(
				recv.map((c) => [c.svc, c.from, c.to]),
				[["waifuletes", DAY0 - 7 * D, DAY0]]
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

		await test("carga incremental; pedaço que falha não volta ao zero; sem extrato não pede received", async () => {
			state.calls.length = 0;
			state.fail.jardim = (from) => from === BF + 30 * D; // 3º pedaço falha
			clock += H; // 13:05
			const before = readAll(pubFile, "SELECT COUNT(*) n FROM load_runs")[0].n;
			await svc.runOnce();
			assert.ok(
				readAll(pubFile, "SELECT COUNT(*) n FROM load_runs")[0].n > before,
				"Grafana vê a nova rodada"
			);
			const hourNow = DAY0 + 6 * H;
			assert.deepStrictEqual(
				state.calls.filter((c) => c.svc === "waifuletes").map((c) => [c.from, c.to]),
				[[DAY0 + 5 * H, hourNow]]
			);
			assert.deepStrictEqual(
				state.calls.filter((c) => c.svc === "jardim").map((c) => c.from),
				[0, BF, BF + 30 * D]
			);
			assert.ok(
				!state.calls.some((c) => c.received),
				"received uma vez por dia; Jardim sem extrato não é pedido"
			);
			const noLedger = readAll(
				dbPath,
				"SELECT ok, error FROM load_runs WHERE source='petalitas.received'"
			);
			assert.deepStrictEqual(noLedger, [{ ok: 1, error: "sem extrato" }]);
			// Próxima hora: Jardim continua do pedaço que falhou
			state.calls.length = 0;
			state.fail.jardim = false;
			clock += H; // 14:05
			await svc.runOnce();
			assert.deepStrictEqual(
				state.calls.filter((c) => c.svc === "jardim").map((c) => c.from),
				[BF + 30 * D, BF + 60 * D]
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
			const st = readAll(
				dbPath,
				dashboardSql("Moeda sem origem na semana", { from: 0, to: clock })
			);
			assert.strictEqual(st.find((x) => x.moeda === "petalitas").status, "sem extrato");
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

		await test("stop(): aborta HTTP em curso, para entre pedaços e nunca espera mais que o limite", async () => {
			// 1) Chamada lenta é abortada: stop volta rápido e fecha o banco
			clock += H;
			state.delay = 5000;
			const running = svc.runOnce();
			await new Promise((r) => setTimeout(r, 50));
			let t0 = Date.now();
			assert.strictEqual(await svc.stop(), true);
			assert.ok(Date.now() - t0 < 1000, `stop demorou ${Date.now() - t0} ms`);
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
			assert.ok(Date.now() - t0 < 600, `stop demorou ${Date.now() - t0} ms`);
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

		await test("publicação serializada por trava (O_EXCL), trava velha é removida", () => {
			const lock = `${dbPath}.publish.lock`;
			fs.writeFileSync(lock, "999999");
			assert.throws(() => svc.store.publish({ waitMs: 200 }), /trava ocupada/);
			const old = (Date.now() - 10 * 60 * 1000) / 1000;
			fs.utimesSync(lock, old, old);
			svc.store.publish({ waitMs: 200 });
			assert.ok(!fs.existsSync(lock), "trava liberada depois de publicar");
			assert.deepStrictEqual(fs.readdirSync(publishDir), ["analytics.db"]);
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

		await test("moeda sem origem: Δ total − Σ fluxos; non_monetary fora; dia sem retrato não some", () => {
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
			const rows = readAll(
				file,
				dashboardSql("Moeda sem origem por dia", { from: DAY0 - D, to: DAY0 + 6 * D })
			);
			assert.deepStrictEqual(
				rows.map((r) => [r.time, r.zinthos, r.runas, r.petalitas]),
				[
					[DAY0 / 1000, 100, 0, null], // frser lê colunas de tempo em segundos
					[(DAY0 + D) / 1000, -100, null, null],
					[(DAY0 + 2 * D) / 1000, 51, null, null]
				]
			);
			const week = readAll(
				file,
				dashboardSql("Moeda sem origem na semana", { from: 0, to: DAY0 + 6 * D })
			);
			const zw = week.find((x) => x.moeda === "zinthos");
			assert.strictEqual(zw.sem_origem_7d, 51);
			assert.strictEqual(zw.status, "agir"); // 51/2600 = 1,96%
		});

		await test("criado/destruído só com creation/destruction; câmbio e transferência à parte", () => {
			const { file, db } = freshDb("week.db");
			const fl = db.prepare("INSERT INTO flows_hourly VALUES (?, 'zinthos', ?, ?, ?, ?, ?, 1)");
			const h = DAY0 + D;
			fl.run(h, "DAILY_REWARD", "creation", 100, 0, 3);
			fl.run(h, "ADMIN_GRANT", "creation", 20, 5, 2); // ajuste negativo conta como destruído
			fl.run(h, "HOSTING_FEE", "destruction", 0, 30, 1);
			fl.run(h, "MARKET_TRADE", "transfer", 50, 52, 2);
			fl.run(h, "ADMIN_GRANT:bank_withdraw_zinthos", "exchange_in", 70, 0, 1);
			fl.run(h, "ADMIN_GRANT:bank_deposit_runas", "exchange_out", 0, 40, 1);
			fl.run(h, "HOSTING_FEE_WAIFU", "non_monetary", 99999, 0, 4);
			db.prepare("INSERT INTO balances (ts, currency, total) VALUES (?, 'zinthos', 1000)").run(h);
			db.close();
			const to = DAY0 + 3 * D;
			const t = readAll(file, dashboardSql("As 3 moedas na semana", { from: 0, to })).find(
				(x) => x.moeda === "zinthos"
			);
			assert.strictEqual(t.criado_7d, 120);
			assert.strictEqual(t.destruido_7d, 35);
			assert.strictEqual(t.destruido_por_100_criado, 29.2);
			assert.strictEqual(t.maior_fonte, "DAILY_REWARD");
			const c = readAll(
				file,
				dashboardSql("Câmbio e transferências na semana", { from: 0, to })
			).find((x) => x.moeda === "zinthos");
			assert.deepStrictEqual(
				[
					c.cambio_entrou,
					c.cambio_saiu,
					c.cambio_liquido,
					c.transferido,
					c.transferencia_liquida,
					c.linhas_fora_do_dinheiro
				],
				[70, 40, 30, 50, -2, 4]
			);
			const stat = readAll(
				file,
				dashboardSql("Destruído por 100 criado (7 dias) — ${moeda}", { from: 0, to })
			);
			assert.strictEqual(stat[0].destruido_por_100, 29.2);
			const byReason = readAll(
				file,
				dashboardSql("De onde vem e para onde vai (7 dias) — ${moeda}", { from: 0, to })
			);
			const nm = byReason.find((x) => x.motivo === "HOSTING_FEE_WAIFU");
			assert.strictEqual(nm.entradas, null);
			assert.strictEqual(nm.transacoes, 4);
			const daily = readAll(
				file,
				dashboardSql("Criado e destruído por dia — ${moeda}", { from: 0, to })
			);
			assert.deepStrictEqual([daily[0].criado, daily[0].destruido], [120, 35]);
			// Nenhuma consulta do painel soma a linha non_monetary
			for (const p of dashboardPanels()) {
				if (!p.targets) continue;
				const rows = readAll(file, dashboardSql(p.title, { from: 0, to }));
				assert.ok(!JSON.stringify(rows).includes("99999"), `${p.title} somou non_monetary`);
			}
		});

		await test("todas as consultas do painel rodam no retrato publicado", () => {
			let n = 0;
			for (const p of dashboardPanels()) {
				if (!p.targets) continue;
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
