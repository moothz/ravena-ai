// src/testing/test_bank_undo_atomic.js
// BankService.undoTransaction com pedidos simultâneos: só um desfaz (trava atômica no UPDATE),
// e uma reversão que falha solta a trava. Roda num SQLite temporário: o Database do bot é
// trocado por um falso antes de carregar o BankService, então nenhum banco de data/ é aberto.

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const BetterSQLite = require("better-sqlite3");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-undo-atomic-"));
const dbs = new Map();
const open = (name) => {
	if (!dbs.has(name)) dbs.set(name, new BetterSQLite(path.join(tmpDir, `${name}.db`)));
	return dbs.get(name);
};
// Cada chamada cede a vez (como o Database real, assíncrono): pedidos simultâneos se intercalam.
const tick = () => new Promise((r) => setImmediate(r));
const fakeDatabase = {
	getSQLiteDb(name, schema) {
		const db = open(name);
		if (schema) db.exec(schema);
		return db;
	},
	async dbRun(name, sql, params = []) {
		await tick();
		const r = open(name)
			.prepare(sql)
			.run(...params);
		return { lastID: Number(r.lastInsertRowid), changes: r.changes };
	},
	async dbGet(name, sql, params = []) {
		await tick();
		return open(name)
			.prepare(sql)
			.get(...params);
	},
	async dbAll(name, sql, params = []) {
		await tick();
		return open(name)
			.prepare(sql)
			.all(...params);
	}
};
require.cache[require.resolve("../utils/Database")] = {
	id: require.resolve("../utils/Database"),
	filename: require.resolve("../utils/Database"),
	loaded: true,
	exports: { getInstance: () => fakeDatabase }
};

const bankService = require("../services/BankService");

async function insertSale(user, kg, runas) {
	const r = await fakeDatabase.dbRun(
		"bank",
		`INSERT INTO bank_transactions
		(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp, status)
		VALUES (?, 'DEPOSIT', 'pesca', ?, ?, 0.03, 0, '{}', ?, 'COMPLETED')`,
		[user, kg, runas, Date.now()]
	);
	return r.lastID;
}

async function runTests() {
	console.log("=== Teste do desfazer atômico do RavenaBank (SQLite temporário) ===");
	const user = "5511900000077";
	await bankService.adminSetUserRunas(user, 1000, "test");
	open("fishing").exec(
		"CREATE TABLE fishing_users (user_id TEXT PRIMARY KEY, inventory_weight REAL DEFAULT 0)"
	);
	open("fishing").prepare("INSERT INTO fishing_users VALUES (?, 0)").run(user);

	// Venda de 10 kg por 100 Runas; dois admins desfazem ao mesmo tempo com valor final 100.
	const txId = await insertSale(user, 10, 100);
	const results = await Promise.allSettled([
		bankService.undoTransaction(txId, { isAdmin: true, customFinalRunas: 100 }),
		bankService.undoTransaction(txId, { isAdmin: true, customFinalRunas: 100 })
	]);
	const ok = results.filter((r) => r.status === "fulfilled");
	const fail = results.filter((r) => r.status === "rejected");
	assert.strictEqual(ok.length, 1, "só um dos pedidos simultâneos desfaz");
	assert.strictEqual(fail.length, 1);
	assert.match(fail[0].reason.message, /já foi desfeita/);
	const acc = await bankService.getAccount(user);
	assert.strictEqual(acc.runas, 900, "Runas debitadas uma vez só (1000 − 100)");
	const kg = open("fishing")
		.prepare("SELECT inventory_weight AS w FROM fishing_users WHERE user_id = ?")
		.get(user).w;
	assert.strictEqual(kg, 10, "peixes devolvidos uma vez só");
	const undos = open("bank")
		.prepare("SELECT COUNT(*) AS n FROM bank_transactions WHERE type = 'UNDO_TRADE'")
		.get().n;
	assert.strictEqual(undos, 1, "um registro de estorno");
	console.log("✓ Dois desfazer simultâneos: um passa, o outro para antes de reverter.");

	// Reversão que falha (tabela da pesca some) solta a trava: a transação continua desfazível.
	const tx2 = await insertSale(user, 5, 50);
	open("fishing").exec("DROP TABLE fishing_users");
	await assert.rejects(
		bankService.undoTransaction(tx2, { isAdmin: true, customFinalRunas: 50 }),
		/no such table/
	);
	const row = open("bank").prepare("SELECT * FROM bank_transactions WHERE id = ?").get(tx2);
	assert.strictEqual(row.status, "COMPLETED", "falha na reversão devolve o status");
	assert.strictEqual(row.undone_at, null);
	assert.strictEqual((await bankService.getAccount(user)).runas, 900, "saldo intacto");
	open("fishing").exec(
		"CREATE TABLE fishing_users (user_id TEXT PRIMARY KEY, inventory_weight REAL DEFAULT 0)"
	);
	const again = await bankService.undoTransaction(tx2, { isAdmin: true, customFinalRunas: 50 });
	assert.strictEqual(again.undone, true, "dá para tentar de novo depois da falha");
	assert.strictEqual((await bankService.getAccount(user)).runas, 850);
	console.log("✓ Reversão que falha solta a trava e o desfazer pode ser repetido.");
}

runTests()
	.then(() => {
		for (const db of dbs.values()) db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
		process.exit(0);
	})
	.catch((err) => {
		console.error("❌ Falha no teste do desfazer atômico:", err);
		process.exit(1);
	});
