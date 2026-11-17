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
	if (opts.ledger !== false) {
		const h = Math.max(R.hourStart(from), DAY0);
		if (h < to) {
			flows.push({
				hour: h,
				reason: "DAILY_REWARD",
				amountIn: 1000,
				amountOut: 0,
				count: 10,
				users: 8
			});
			flows.push({
				hour: h,
				reason: "HOSTING_FEE",
				amountIn: 0,
				amountOut: 300,
				count: 3,
				users: 3
			});
			flows.push({
				hour: h,
				reason: "NEW_REASON_X",
				amountIn: 50,
				amountOut: 0,
				count: 1,
				users: 1
			});
		}
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
		receivedByQuintile:
			to - from <= 8 * D
				? [1, 2, 3, 4, 5].map((q) => ({ q, n: 12, receivedSum: q * 100, receivedMedian: q }))
				: []
	};
}

function startMockServer(state) {
	const server = http.createServer((req, res) => {
		const u = new URL(req.url, "http://x");
		const from = Number(u.searchParams.get("from"));
		const to = Number(u.searchParams.get("to"));
		const isWaifu = req.headers.authorization === "Bearer test-waifu-key";
		const isJardim = req.headers["x-api-key"] === "test-jardim-key";
		const svc = isWaifu ? "waifuletes" : isJardim ? "jardim" : null;
		if (!svc || u.pathname !== "/internal/economy/summary") {
			res.writeHead(401).end("{}");
			return;
		}
		state.calls.push({ svc, from, to });
		if (state.fail[svc]) {
			res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
			return;
		}
		const body =
			svc === "waifuletes"
				? remoteSummary("zinthos", from, to, { generatedAt: state.now() })
				: remoteSummary("petalitas", from, to, { generatedAt: state.now(), ledger: false });
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

/** Lê a consulta de um painel do dashboard provisionado e troca as macros/variáveis do Grafana. */
function dashboardSql(title, { from, to, moeda = "zinthos" }) {
	const dash = JSON.parse(
		fs.readFileSync(
			path.join(__dirname, "../../observability/grafana/dashboards/economia.json"),
			"utf8"
		)
	);
	const panels = dash.panels.flatMap((p) => (p.panels ? [p, ...p.panels] : [p]));
	const panel = panels.find((p) => p.title === title);
	assert.ok(panel, `painel "${title}" não encontrado`);
	return (
		panel.targets[0].queryText
			// O frser recebe a consulta já interpolada pelo frontend ($__from/$__to em ms)
			.replace(/\$__from\b/g, String(from))
			.replace(/\$__to\b/g, String(to))
			.replace(/\$\{moeda:sqlstring\}/g, `'${moeda}'`)
			.replace(/\$\{moeda\}/g, moeda)
	);
}

async function main() {
	console.log("=== Testes: painel da economia (EconomyAnalytics) ===");

	// ----------------------------------------------------------------------- mapeamento
	await test("mapeamento reason → kind (conhecido, desconhecido, moeda sem tabela)", () => {
		assert.strictEqual(kindFor("zinthos", "DAILY_REWARD"), "creation");
		assert.strictEqual(kindFor("zinthos", "HOSTING_FEE"), "destruction");
		assert.strictEqual(kindFor("zinthos", "MARKET_TRADE"), "transfer");
		assert.strictEqual(kindFor("runas", "DEPOSIT:waifu"), "exchange_in");
		assert.strictEqual(kindFor("runas", "WITHDRAW:jardim"), "exchange_out");
		assert.strictEqual(kindFor("runas", "STORE_BUY:slots"), "destruction");
		assert.strictEqual(kindFor("runas", "UNDO_DEPOSIT:pesca"), "destruction");
		assert.strictEqual(kindFor("zinthos", "NEW_REASON_X"), "unknown");
		assert.strictEqual(kindFor("zinthos", "toString"), "unknown"); // não herda do prototype
		assert.strictEqual(kindFor("petalitas", "QUALQUER"), "unknown");
		assert.strictEqual(kindFor("ouro", "DAILY_REWARD"), "unknown");
		// Todos os motivos do enum KakeraReason estão mapeados
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
			"HOSTING_FEE"
		]) {
			assert.notStrictEqual(kindFor("zinthos", r), "unknown", r);
		}
		assert.strictEqual(kindFor("zinthos", "HOSTING_FEE_WAIFU"), "unknown"); // de propósito
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
		for (const t of Object.values(MAPPING)) {
			for (const k of Object.values(t)) assert.ok(KINDS.includes(k));
		}
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
	await test("quintos com n < 10 saem nulos; percentis e top10Share", () => {
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

		// 49 holders → quintos de 9 e 10: só os de 10 aparecem
		const mixed = R.balanceStats(Array.from({ length: 49 }, (_, i) => i + 1));
		assert.deepStrictEqual(
			mixed.quintiles.map((q) => q.n),
			[9, 10, 10, 10, 10]
		);
		assert.strictEqual(mixed.quintiles[0].sum, null);
		assert.notStrictEqual(mixed.quintiles[1].sum, null);

		const empty = R.balanceStats([]);
		assert.strictEqual(empty.total, 0);
		assert.strictEqual(empty.top10Share, null);
	});

	await test("receivedByQuintile: nulos em grupo pequeno, mediana inclui quem não recebeu", () => {
		const bal = new Map(Array.from({ length: 50 }, (_, i) => [`u${i}`, i + 1]));
		bal.set("zero", 0); // sem saldo: fora dos quintos
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
	const bankFile = path.join(tmpRoot, "bank.db");
	const bank = makeBankDb(bankFile);
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
	for (let i = 0; i < 60; i++) {
		bank.prepare("INSERT INTO bank_accounts (user_id, runas) VALUES (?, ?)").run(`h${i}`, i + 1);
	}
	bank.prepare("INSERT INTO bank_accounts (user_id, runas) VALUES ('u1', 0.4)").run();
	// Retratos diários (virada 04:00 BRT): dia 10 completo; NULL = conta criada no meio do dia
	bank
		.prepare(
			"INSERT INTO bank_daily_quotas (user_id, date, initial_runas) VALUES ('a', '2026-11-10', 1000.4), ('b', '2026-11-10', 500), ('c', '2026-11-10', NULL)"
		)
		.run();
	// Dia 09 só tem linhas NULL (antes da virada gravar initial_runas): ignorado
	bank
		.prepare(
			"INSERT INTO bank_daily_quotas (user_id, date, initial_runas) VALUES ('a', '2026-11-09', NULL)"
		)
		.run();
	const bankQuery = (sql, params = []) => bank.prepare(sql).all(...params);

	await test("agregação de Runas por hora e motivo (bank.db sintético)", () => {
		const flows = R.runasFlows(bankQuery, 0, DAY0 + D);
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
		// janela [from, to): to exclusivo
		assert.strictEqual(R.runasFlows(bankQuery, h1, h2).length, 1);
		// nenhum ID de usuário no resultado
		assert.ok(!JSON.stringify(flows).includes("u1"));
	});

	await test("resumo de Runas no formato do contrato + retratos diários", () => {
		const s = R.buildRunasSummary(bankQuery, DAY0, DAY0 + D, DAY0 + D + 5);
		assert.strictEqual(s.currency, "runas");
		assert.strictEqual(s.balances.holders, 61);
		assert.strictEqual(s.balances.accounts, 61);
		assert.strictEqual(s.balances.total, Math.round(1830 + 0.4));
		assert.strictEqual(s.receivedByQuintile.length, 5);
		// creation na janela: DEPOSIT:pesca (u1 110.4, u2 50.4) e BONUS:slots_prize (u2 40); u2 não tem
		// saldo (fora dos quintos), u1 tem 0.4 → quinto 1
		assert.strictEqual(s.receivedByQuintile[0].receivedSum, 110);
		assert.strictEqual(R.buildRunasSummary(bankQuery, 0, DAY0 + D).receivedByQuintile.length, 0);
		const snaps = R.dailySnapshots(bankQuery, 0, DAY0 + 2 * D);
		assert.strictEqual(snaps.length, 1);
		assert.strictEqual(snaps[0].ts, DAY0);
		assert.strictEqual(snaps[0].balances.total, 1500);
		assert.strictEqual(snaps[0].balances.accounts, 3);
		assert.strictEqual(snaps[0].balances.holders, 2);
	});

	// ----------------------------------------------------------------------- carga completa
	let clock = DAY0 + 5 * H + 5 * 60 * 1000; // 12:05 UTC
	const state = { calls: [], fail: {}, override: {}, now: () => clock };
	const server = await startMockServer(state);
	const base = `http://127.0.0.1:${server.address().port}`;
	const dbPath = path.join(tmpRoot, "analytics.db");
	const svc = new EconomyAnalyticsService({
		dbPath,
		bankQuery,
		now: () => clock,
		waifuletesUrl: base,
		waifuletesKey: "test-waifu-key",
		jardimUrl: base,
		jardimKey: "test-jardim-key",
		sources: ["zinthos", "petalitas", "runas"]
	});

	try {
		await test("primeira carga: from=0 até o início da hora, WAL, fontes isoladas", async () => {
			state.fail.jardim = true;
			const r = await svc.runOnce();
			const hourNow = DAY0 + 5 * H;
			assert.deepStrictEqual(
				state.calls.filter((c) => c.to === hourNow).map((c) => [c.svc, c.from]),
				[
					["waifuletes", 0],
					["jardim", 0]
				]
			);
			assert.strictEqual(r.zinthos.ok, true);
			assert.strictEqual(r.runas.ok, true);
			assert.strictEqual(r.petalitas.ok, false);
			const runs = readAll(
				dbPath,
				"SELECT source, ok, window_from, window_to, error FROM load_runs ORDER BY source"
			);
			const pet = runs.find((x) => x.source === "petalitas");
			assert.strictEqual(pet.ok, 0);
			assert.match(pet.error, /HTTP 500/);
			assert.strictEqual(runs.find((x) => x.source === "zinthos").window_to, hourNow);
			assert.strictEqual(readAll(dbPath, "PRAGMA journal_mode")[0].journal_mode, "wal");
			// Fluxos de Runas e Zinthos gravados com kind
			const z = readAll(
				dbPath,
				"SELECT reason, kind, amount_in, amount_out FROM flows_hourly WHERE currency='zinthos' ORDER BY reason"
			);
			assert.deepStrictEqual(
				z.map((x) => [x.reason, x.kind]),
				[
					["DAILY_REWARD", "creation"],
					["HOSTING_FEE", "destruction"],
					["NEW_REASON_X", "unknown"]
				]
			);
			const rr = readAll(
				dbPath,
				"SELECT reason, kind FROM flows_hourly WHERE currency='runas' AND reason='MYSTERY:x'"
			);
			assert.strictEqual(rr[0].kind, "unknown");
			// Retrato diário do bank_daily_quotas + retrato da carga
			const rb = readAll(
				dbPath,
				"SELECT ts, total FROM balances WHERE currency='runas' ORDER BY ts"
			);
			assert.deepStrictEqual(
				rb.map((x) => x.ts),
				[DAY0, clock]
			);
			// receivedByQuintile do dia: zinthos e runas sim, petalitas falhou
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
			const recvCall = state.calls.find((c) => c.svc === "waifuletes" && c.to === DAY0);
			assert.ok(
				recvCall && recvCall.from === DAY0 - 7 * D,
				"pede os últimos 7 dias até o início do dia"
			);
		});

		await test("carga incremental: a próxima hora pede [último to, hora atual); falha refaz do zero", async () => {
			state.calls.length = 0;
			state.fail.jardim = false;
			clock += H; // 13:05
			await svc.runOnce();
			const hourNow = DAY0 + 6 * H;
			const main = state.calls.filter((c) => c.to === hourNow);
			assert.deepStrictEqual(
				main.map((c) => [c.svc, c.from]),
				[
					["waifuletes", DAY0 + 5 * H],
					["jardim", 0]
				]
			);
			// receivedByQuintile só uma vez por dia: zinthos não pede de novo, petalitas pede
			const recv = state.calls.filter((c) => c.to === DAY0);
			assert.deepStrictEqual(
				recv.map((c) => c.svc),
				["jardim"]
			);
			const ok = readAll(
				dbPath,
				"SELECT source, window_from, window_to FROM load_runs WHERE ok=1 AND window_to=? ORDER BY source",
				[hourNow]
			);
			assert.deepStrictEqual(
				ok.map((x) => x.source),
				["petalitas", "runas", "zinthos"]
			);
			assert.strictEqual(ok.find((x) => x.source === "runas").window_from, DAY0 + 5 * H);
			// Jardim sem extrato: ledger_status marca, painel mostra "sem extrato"
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
			// Esquece as cargas da última hora e roda de novo a mesma janela
			const db = new BetterSQLite(dbPath);
			db.prepare("DELETE FROM load_runs WHERE window_to = ?").run(DAY0 + 6 * H);
			db.close();
			await svc.runOnce();
			assert.deepStrictEqual(snapshot(), before);
			// writeFlows apaga motivo que sumiu da janela
			svc.store.writeFlows("zinthos", DAY0, DAY0 + H, [
				{
					hour: DAY0,
					reason: "DAILY_REWARD",
					kind: "creation",
					amountIn: 1,
					amountOut: 0,
					count: 1,
					users: 1
				}
			]);
			svc.store.writeFlows("zinthos", DAY0, DAY0 + H, [
				{
					hour: DAY0,
					reason: "DIVORCE",
					kind: "creation",
					amountIn: 2,
					amountOut: 0,
					count: 1,
					users: 1
				}
			]);
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
			clock += H; // 14:15
			state.override.waifuletes = () => ({ schemaVersion: 2 });
			const r = await svc.runOnce();
			assert.strictEqual(r.zinthos.ok, false);
			assert.match(r.zinthos.error, /schemaVersion/);
			assert.strictEqual(r.runas.ok, true);
			state.override.waifuletes = (b) => ({
				ledger: {
					available: true,
					flows: [{ hour: 0, reason: "DAILY_REWARD", amountIn: 1, amountOut: 0 }]
				}
			});
			clock += H;
			const r2 = await svc.runOnce();
			assert.match(r2.zinthos.error, /fora da janela/);
			state.override.waifuletes = null;
			// a próxima carga boa cobre o buraco inteiro
			state.calls.length = 0;
			clock += H;
			await svc.runOnce();
			assert.strictEqual(state.calls[0].from, DAY0 + 6 * H);
		});

		await test("moeda sem origem (consulta do painel) = Δ total − Σ(entradas − saídas)", () => {
			const db = new BetterSQLite(path.join(tmpRoot, "orphan.db"));
			db.exec(require("../services/EconomyAnalyticsStore").SCHEMA);
			const ins = db.prepare("INSERT INTO balances (ts, currency, total) VALUES (?, ?, ?)");
			const fl = db.prepare("INSERT INTO flows_hourly VALUES (?, ?, ?, 'creation', ?, ?, 1, 1)");
			// Dia 0: abre 1000, fecha (abertura do dia 1) 1600; fluxos +700 −200 = +500 → 100 sem origem
			ins.run(DAY0 + 5 * 60 * 1000, "zinthos", 1000);
			ins.run(DAY0 + 3 * H, "zinthos", 1200); // retrato no meio do dia: ignorado
			ins.run(DAY0 + D + 5 * 60 * 1000, "zinthos", 1600);
			fl.run(DAY0, "zinthos", "A", 700, 0);
			fl.run(DAY0 + 23 * H, "zinthos", "B", 0, 200);
			fl.run(DAY0 + D, "zinthos", "A", 999, 0); // dia seguinte: fora
			// Dia 1: abre 1600, dia 2 abre 2499, fluxo +999 → −100 (sumiu sem linha no extrato)
			ins.run(DAY0 + 2 * D + 5 * 60 * 1000, "zinthos", 1500 + 999);
			// Runas no mesmo período, tudo explicado
			ins.run(DAY0, "runas", 10);
			ins.run(DAY0 + D, "runas", 15);
			fl.run(DAY0 + H, "runas", "X", 5, 0);
			db.close();
			const sql = dashboardSql("Moeda sem origem por dia", { from: DAY0 - D, to: DAY0 + 3 * D });
			const rows = readAll(path.join(tmpRoot, "orphan.db"), sql);
			assert.strictEqual(rows.length, 2);
			assert.strictEqual(rows[0].time, DAY0 / 1000); // frser lê colunas de tempo em segundos
			assert.strictEqual(rows[0].zinthos, 100);
			assert.strictEqual(rows[0].runas, 0);
			assert.strictEqual(rows[0].petalitas, null);
			assert.strictEqual(rows[1].time, (DAY0 + D) / 1000);
			assert.strictEqual(rows[1].zinthos, -100);
		});

		await test("todas as consultas do painel rodam no analytics.db da carga", () => {
			const dash = JSON.parse(
				fs.readFileSync(
					path.join(__dirname, "../../observability/grafana/dashboards/economia.json"),
					"utf8"
				)
			);
			const panels = dash.panels.flatMap((p) => (p.panels ? [p, ...p.panels] : [p]));
			let n = 0;
			for (const p of panels) {
				if (!p.targets) continue;
				const sql = dashboardSql(p.title, { from: DAY0 - 90 * D, to: clock });
				readAll(dbPath, sql);
				n++;
			}
			assert.ok(n >= 10, `esperava >= 10 painéis com consulta, achou ${n}`);
		});
	} finally {
		svc.stop();
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
