process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const express = require("express");
const BetterSQLite = require("better-sqlite3");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-tx-filter-"));
const dbs = new Map();
const open = (name) => {
	if (!dbs.has(name)) dbs.set(name, new BetterSQLite(path.join(tmpDir, `${name}.db`)));
	return dbs.get(name);
};
const fakeDatabase = {
	getSQLiteDb(name, schema) {
		const db = open(name);
		if (schema) db.exec(schema);
		return db;
	},
	async dbRun(name, sql, params = []) {
		const r = open(name)
			.prepare(sql)
			.run(...params);
		return { lastID: Number(r.lastInsertRowid), changes: r.changes };
	},
	async dbGet(name, sql, params = []) {
		return open(name)
			.prepare(sql)
			.get(...params);
	},
	async dbAll(name, sql, params = []) {
		return open(name)
			.prepare(sql)
			.all(...params);
	},
	async getGlobalNick() {
		return null;
	},
	async getActiveScheduledEvents() {
		return [];
	},
	async getActiveGameEvents() {
		return [];
	}
};
require.cache[require.resolve("../utils/Database")] = {
	id: require.resolve("../utils/Database"),
	filename: require.resolve("../utils/Database"),
	loaded: true,
	exports: { getInstance: () => fakeDatabase }
};

const bankService = require("../services/BankService");
const { registerGamesRoutes } = require("../BotAPI/routes/gamesRoutes");

const SRC = path.join(__dirname, "..");
const PUBLIC = path.join(__dirname, "../../public");
const USER = "5511999990001";

const NO_GAME = null;
const DEFAULT_CREDIT_SOURCE = "bonus";
const OVERFLOW_BUFF_TYPES = ["inventory_slot", "max_baits"];
const GAME_BY_STORED_VALUE = {
	pesca: "pesca",
	fishing: "pesca",
	fishing_cap_baits: "pesca",
	fishing_cap_baits_fazenda: "pesca",
	fishing_cap_extra_baits: "pesca",
	fishing_cap_inventory_slot: "pesca",
	fishing_cap_max_baits: "pesca",
	waifu: "waifu",
	jardim: "jardim",
	slots: "slots",
	slots_prize: "slots",
	admin: NO_GAME,
	bonus: NO_GAME,
	donor_bonus: NO_GAME,
	market: NO_GAME
};

function callsTo(code, fn) {
	const out = [];
	for (const m of code.matchAll(new RegExp(`\\b${fn}\\(`, "g"))) {
		let depth = 0;
		let i = m.index + m[0].length - 1;
		do {
			if (code[i] === "(") depth++;
			if (code[i] === ")") depth--;
			i++;
		} while (depth > 0 && i < code.length);
		out.push(code.slice(m.index, i));
	}
	return out;
}

function writtenByCode() {
	const pairs = new Map();
	const add = (type, game) => pairs.set(`${type}:${game}`, { type, game });
	const files = fs
		.readdirSync(SRC, { recursive: true })
		.filter((f) => f.endsWith(".js") && !f.startsWith("testing"));
	for (const file of files) {
		const code = fs.readFileSync(path.join(SRC, file), "utf8");
		for (const m of code.matchAll(
			/INSERT INTO bank_transactions[^`]*?VALUES \(\?, '([A-Z_]+)', '(\w+)'/g
		))
			add(m[1], m[2]);
		for (const call of callsTo(code, "creditRunas")) {
			if (!call.includes("recordTransaction: true")) continue;
			for (const m of call.matchAll(/source: "(\w+)"/g)) add("BONUS", m[1]);
		}
		for (const call of [...callsTo(code, "addBaits"), ...callsTo(code, "addBuff")])
			for (const m of call.matchAll(/source: "(\w+)"/g)) add("BONUS", m[1]);
		for (const call of callsTo(code, "creditOverflowRunas")) {
			for (const m of call.matchAll(/"(fishing_cap_\w+)"/g)) add("BONUS", m[1]);
			if (call.includes("`fishing_cap_${buff.type}`"))
				for (const t of OVERFLOW_BUFF_TYPES) add("BONUS", `fishing_cap_${t}`);
		}
	}
	add("BONUS", DEFAULT_CREDIT_SOURCE);
	for (const { type, game } of [...pairs.values()])
		if (["DEPOSIT", "WITHDRAW", "STORE_BUY"].includes(type)) add("UNDO_TRADE", game);
	return [...pairs.values()];
}

function legacyOptions() {
	const html = fs.readFileSync(path.join(PUBLIC, "banco-admin.html"), "utf8");
	const select = /<select id="tx-filter-game"[\s\S]*?<\/select>/.exec(html)[0];
	return [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

async function runTests() {
	console.log("=== Filtro de jogo das transações do RavenaBank ===");
	const written = writtenByCode();
	const games = [...new Set(written.map((w) => w.game))].sort();
	console.log(`Valores de game gravados pelo código: ${games.join(", ")}`);
	assert.deepStrictEqual(
		games,
		Object.keys(GAME_BY_STORED_VALUE).sort(),
		"valor gravado sem jogo definido"
	);

	const now = Date.now();
	for (const { type, game } of written) {
		if (type === "BONUS") {
			await bankService.creditRunas(USER, 10, { recordTransaction: true, source: game });
		} else {
			open("bank")
				.prepare(
					`INSERT INTO bank_transactions
					(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp)
					VALUES (?, ?, ?, 1, 10, 0, 0, '{}', ?)`
				)
				.run(USER, type, game, now);
		}
	}

	const app = express();
	const pass = (req, res, next) => next();
	registerGamesRoutes({
		app,
		bots: [],
		generalLimiter: pass,
		strictLimiter: pass,
		authenticateBasic: pass,
		logger: { info() {}, warn() {}, debug() {}, error: console.error }
	});
	const server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const base = `http://127.0.0.1:${server.address().port}/api/games/bank/admin/transactions`;
	const fetchTx = async (query) => {
		const res = await fetch(`${base}?${query}`);
		const body = await res.json();
		assert.strictEqual(res.status, 200, JSON.stringify(body));
		assert.strictEqual(body.data.total, body.data.transactions.length, "total bate com as linhas");
		return body.data.transactions;
	};
	const pairsOf = (rows) => rows.map((r) => `${r.type}:${r.game}`).sort();

	const lib = await import(pathToFileURL(path.join(PUBLIC, "admin/areas/banco/lib.js")).href);
	const screens = {
		"/admin": {
			options: lib.TX_GAMES.map((o) => o.value),
			query: (jogo) => lib.txQuery(new URLSearchParams({ jogo }), 100)
		},
		"banco-admin antigo": {
			options: legacyOptions(),
			query: (game) =>
				new URLSearchParams({ page: 1, limit: 100, q: "", type: "ALL", game, status: "ALL" })
		}
	};

	const failures = [];
	for (const [screen, { options, query }] of Object.entries(screens)) {
		const reached = new Set();
		for (const option of options.filter((o) => o !== "ALL")) {
			const got = pairsOf(await fetchTx(query(option)));
			const want = pairsOf(written.filter((w) => GAME_BY_STORED_VALUE[w.game] === option));
			got.forEach((p) => reached.add(p));
			const missing = want.filter((p) => !got.includes(p));
			const extra = got.filter((p) => !want.includes(p));
			const ok = !missing.length && !extra.length;
			console.log(`${ok ? "✓" : "✗"} ${screen}, opção ${option}: ${got.length}/${want.length}`);
			if (missing.length) failures.push(`${screen}, ${option}: faltam ${missing.join(", ")}`);
			if (extra.length) failures.push(`${screen}, ${option}: sobram ${extra.join(", ")}`);
		}
		const lost = written.filter(
			(w) => GAME_BY_STORED_VALUE[w.game] !== NO_GAME && !reached.has(`${w.type}:${w.game}`)
		);
		if (lost.length)
			failures.push(
				`${screen}: nenhuma opção alcança ${[...new Set(lost.map((w) => w.game))].join(", ")}`
			);
	}

	const expectPairs = async (label, query, want) => {
		const got = pairsOf(await fetchTx(new URLSearchParams({ limit: 100, ...query })));
		if (JSON.stringify(got) !== JSON.stringify(want))
			failures.push(`${label}: esperado [${want}], veio [${got}]`);
	};
	await expectPairs("iscas compradas", { game: "pesca", type: "STORE_BUY" }, ["STORE_BUY:fishing"]);
	await expectPairs("prêmio de slots", { game: "slots", type: "BONUS" }, ["BONUS:slots_prize"]);
	await expectPairs("outro jogador", { game: "slots", q: "5511999990002" }, []);
	await expectPairs("desfeitas", { game: "pesca", status: "UNDONE" }, []);
	await expectPairs("valor exato fora das opções", { game: "slots_prize" }, ["BONUS:slots_prize"]);
	await expectPairs("curinga do usuário não vale", { game: "fish*" }, []);

	server.close();
	assert.ok(!failures.length, `\n- ${failures.join("\n- ")}`);
	console.log("✓ Todas as opções trazem todas as transações do jogo que anunciam.");
}

runTests()
	.finally(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err.message || err);
		process.exit(1);
	});
