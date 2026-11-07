"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const bankService = require("../services/BankService");

async function runAdminTests() {
	console.log("=== Iniciando Testes Unitários e de Integração: RavenaBank Admin ===");

	const db = Database.getInstance();
	const testUserId = "9999988887777";
	const testNick = "Lorde dos Testes";

	// 1. Limpeza prévia
	await db.dbRun("bank", "DELETE FROM bank_accounts WHERE user_id = ?", [testUserId]);
	await db.dbRun("bank", "DELETE FROM bank_transactions WHERE user_id = ?", [testUserId]);
	await db.dbRun("bank", "DELETE FROM bank_sessions WHERE user_id = ?", [testUserId]);
	await db.saveGlobalNick(testUserId, null);
	console.log("✓ 1. Limpeza prévia de dados concluída.");

	// 2. Teste de listagem paginada padrão (sem busca)
	console.log("2. Testando adminGetUsers sem query (paginação padrão)...");
	const page1 = await bankService.adminGetUsers({ page: 1, limit: 10 });
	assert.ok(page1 && Array.isArray(page1.users), "Deveria retornar array de usuários");
	assert.ok(page1.total > 0, "Deveria ter total de usuários > 0");
	assert.strictEqual(page1.page, 1, "Página atual deve ser 1");
	assert.strictEqual(page1.limit, 10, "Limite por página deve ser 10");
	assert.ok(page1.totalPages >= 1, "totalPages deve ser >= 1");
	assert.ok(page1.users.length <= 10, "Não deve exceder o limite solicitado");

	// Valida campos do usuário retornado
	const firstUser = page1.users[0];
	assert.ok(firstUser.userId, "Usuário deve conter userId");
	assert.ok(typeof firstUser.name === "string", "Usuário deve conter name (apelido/fallback)");
	assert.ok(typeof firstUser.runas === "number", "Usuário deve conter runas numérico");
	console.log(`✓ 2. Paginação padrão validada com sucesso (${page1.total} usuários no banco).`);

	// 3. Teste de resolução de apelido global
	console.log("3. Testando resolução de apelido global...");
	await db.saveGlobalNick(testUserId, testNick);
	await bankService.adminSetUserRunas(testUserId, 1500, "test_runner");

	const searchByNick = await bankService.adminGetUsers({ query: "Lorde dos Testes", limit: 5 });
	assert.ok(searchByNick.users.length > 0, "Busca por apelido deve encontrar o usuário");
	const foundUser = searchByNick.users.find((u) => u.userId === testUserId);
	assert.ok(foundUser, "Usuário de teste deve constar nos resultados");
	assert.strictEqual(foundUser.name, testNick, "Nome exibido deve ser o apelido global");
	assert.strictEqual(foundUser.runas, 1500, "Saldo de Runas deve ser 1500");
	console.log("✓ 3. Apelido global e busca por apelido testados com sucesso!");

	// 4. Teste de busca por número / dígitos
	console.log("4. Testando busca por número/ID...");
	const searchByPhone = await bankService.adminGetUsers({ query: "999998888", limit: 5 });
	const foundByPhone = searchByPhone.users.find((u) => u.userId === testUserId);
	assert.ok(foundByPhone, "Busca por dígitos deve encontrar o usuário de teste");
	assert.strictEqual(foundByPhone.userId, testUserId);
	console.log("✓ 4. Busca por número/ID testada com sucesso!");

	// 5. Teste de edição direta do saldo de Runas (adminSetUserRunas)
	console.log("5. Testando ajuste administrativo de saldo e registro contábil...");
	const updated = await bankService.adminSetUserRunas(testUserId, 2350.5, "admin_unittest");
	assert.strictEqual(
		updated.runas,
		2350.5,
		"Saldo no bank_accounts deve ser atualizado para 2350.5"
	);

	// Valida registro em bank_transactions
	const txRow = await db.dbGet(
		"bank",
		"SELECT * FROM bank_transactions WHERE user_id = ? AND type = 'ADMIN_ADJUST' ORDER BY timestamp DESC LIMIT 1",
		[testUserId]
	);
	assert.ok(txRow, "Deve haver registro na tabela bank_transactions com type = 'ADMIN_ADJUST'");
	assert.strictEqual(txRow.game, "admin", "Game deve ser 'admin'");
	assert.strictEqual(
		txRow.runas_amount,
		850.5,
		"runas_amount deve ser a diferença (2350.5 - 1500 = 850.5)"
	);

	const txDetails = JSON.parse(txRow.details_json || "{}");
	assert.strictEqual(txDetails.previousRunas, 1500);
	assert.strictEqual(txDetails.newRunas, 2350.5);
	assert.strictEqual(txDetails.adminUser, "admin_unittest");
	console.log("✓ 5. Ajuste de Runas e auditoria contábil validados com sucesso!");

	// 6. Teste de impersonação ([Acessar])
	console.log("6. Testando criação de sessão de impersonação e validação deslizante...");
	const session = await bankService.createSession(testUserId);
	assert.ok(session.token, "Sessão deve gerar token");
	assert.ok(session.expiresAt > Date.now(), "expiresAt deve ser no futuro (3 dias)");

	const verifiedSession = await bankService.verifyAndExtendSession(session.token);
	assert.ok(verifiedSession, "Sessão criada deve ser válida");
	assert.strictEqual(
		verifiedSession.userId,
		testUserId,
		"Sessão deve pertencer ao usuário impersonado"
	);
	console.log("✓ 6. Sessão de impersonação e token gerados e validados com sucesso!");

	// 7. Teste de consulta de configurações e macroeconomia (adminGetConfigAndStats)
	console.log("7. Testando adminGetConfigAndStats...");
	const stats = await bankService.adminGetConfigAndStats();
	assert.ok(stats.rates, "Deve conter rates");
	assert.ok(stats.totalRunas >= 0, "Deve conter totalRunas");
	assert.ok(stats.totalAccounts > 0, "Deve conter totalAccounts");
	assert.ok(stats.totalTransactions >= 0, "Deve conter totalTransactions");
	assert.ok(stats.totalBurnedRunas >= 0, "Deve conter totalBurnedRunas");
	assert.ok(stats.storePrices && stats.storePrices.moeda === 55, "Preço da moeda deve ser 55");
	assert.ok(stats.storePrices && stats.storePrices.isca === 45, "Preço da isca deve ser 45");
	console.log("✓ 7. Estatísticas e configurações macroeconômicas validadas com sucesso!");

	// 8. Limpeza final
	await db.dbRun("bank", "DELETE FROM bank_accounts WHERE user_id = ?", [testUserId]);
	await db.dbRun("bank", "DELETE FROM bank_transactions WHERE user_id = ?", [testUserId]);
	await db.dbRun("bank", "DELETE FROM bank_sessions WHERE user_id = ?", [testUserId]);
	await db.saveGlobalNick(testUserId, null);
	console.log("✓ 8. Limpeza final concluída.");

	console.log("=== TODOS OS TESTES DO RAVENABANK ADMIN PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runAdminTests().catch((err) => {
	console.error("❌ Falha nos testes do RavenaBank Admin:", err);
	process.exit(1);
});
