/**
 * Teste do sync remoto (MySQL) com colunas novas no SQLite.
 * Valida que o syncTable adiciona no remoto as colunas que faltam (ex.: groups.tiktok)
 * antes do upsert, em vez de falhar com "Unknown column".
 * Usa SQLite em memória e uma conexão MySQL fake: nada é escrito fora do processo.
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const BetterSQLite = require("better-sqlite3");
const DatabaseBackup = require("../utils/DatabaseBackup");

// Simula uma tabela MySQL já existente: rejeita upsert com coluna desconhecida, como o servidor real
function createFakeRemote(existingColumns) {
	const statements = [];
	const columns = new Set(existingColumns);
	return {
		statements,
		upserted: false,
		async query(sql) {
			statements.push(sql);
			if (sql.startsWith("SHOW COLUMNS")) {
				return [[...columns].map((Field) => ({ Field }))];
			}
			return [[]];
		},
		async execute(sql) {
			statements.push(sql);
			const added = sql.match(/ADD COLUMN `(\w+)`/);
			if (added) columns.add(added[1]);
			if (sql.startsWith("INSERT")) {
				const used = [...sql.matchAll(/`(\w+)`/g)].map((m) => m[1]).slice(1);
				const unknown = used.find((col) => !columns.has(col));
				if (unknown) throw new Error(`Unknown column '${unknown}' in 'field list'`);
				this.upserted = true;
			}
			return [{}];
		}
	};
}

async function runTests() {
	console.log("=== TESTE: SYNC REMOTO COM COLUNAS NOVAS ===\n");

	const sqlite = new BetterSQLite(":memory:");
	sqlite.exec(`
		CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT, paused INTEGER, tiktok TEXT);
		INSERT INTO groups VALUES ('g1@g.us', 'grupo', 0, '[{"channel":"perfil"}]');
	`);

	const backup = new DatabaseBackup({});

	console.log("Teste 1: tabela remota antiga ganha a coluna que falta...");
	const remote = createFakeRemote(["id", "name", "paused"]);
	await backup.syncTable(sqlite, "groups", ["id"], remote);

	const alters = remote.statements.filter((s) => s.startsWith("ALTER TABLE"));
	assert.deepStrictEqual(alters, ["ALTER TABLE `groups` ADD COLUMN `tiktok` LONGTEXT"]);
	const alterIdx = remote.statements.findIndex((s) => s.startsWith("ALTER TABLE"));
	const insertIdx = remote.statements.findIndex((s) => s.startsWith("INSERT"));
	assert(insertIdx > alterIdx, "ALTER precisa vir antes do upsert");
	assert.strictEqual(remote.upserted, true, "upsert aceito após ALTER");
	console.log("  ✅ Teste 1 passou!\n");

	console.log("Teste 2: tabela remota já completa não recebe ALTER...");
	const upToDate = createFakeRemote(["id", "name", "paused", "tiktok"]);
	await backup.syncTable(sqlite, "groups", ["id"], upToDate);
	assert.strictEqual(upToDate.statements.filter((s) => s.startsWith("ALTER")).length, 0);
	assert.strictEqual(upToDate.upserted, true, "upsert aceito");
	console.log("  ✅ Teste 2 passou!\n");

	console.log("Teste 3: CREATE TABLE mantém os tipos mapeados...");
	const create = remote.statements.find((s) => s.startsWith("CREATE TABLE"));
	assert(create.includes("`id` VARCHAR(500)"), create);
	assert(create.includes("`paused` BIGINT"), create);
	assert(create.includes("`tiktok` LONGTEXT"), create);
	assert(create.includes("PRIMARY KEY (`id`)"), create);
	console.log("  ✅ Teste 3 passou!\n");

	sqlite.close();
	console.log("=== TODOS OS TESTES DE SYNC REMOTO PASSARAM ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro nos testes:", err);
		process.exit(1);
	});
