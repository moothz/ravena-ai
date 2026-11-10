"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const bankService = require("../services/BankService");

async function runTests() {
	console.log("=== Iniciando Testes: RavenaBank Undo & Segunda Chance ===");
	const db = Database.getInstance();
	const testUser = "5511999990001";

	// 1. Limpeza prévia
	await db.dbRun("bank", "DELETE FROM bank_accounts WHERE user_id = ?", [testUser]);
	await db.dbRun("bank", "DELETE FROM bank_transactions WHERE user_id = ?", [testUser]);
	await db.dbRun("bank", "DELETE FROM bank_daily_quotas WHERE user_id = ?", [testUser]);
	console.log("✓ 1. Limpeza prévia concluída.");

	// 2. Inicializar conta com 2000 Runas
	await bankService.adminSetUserRunas(testUser, 2000, "test");
	const accInitial = await bankService.getAccount(testUser);
	assert.strictEqual(accInitial.runas, 2000, "Saldo inicial deve ser 2000 Runas");
	console.log("✓ 2. Conta de teste inicializada com 2000 Runas.");

	// 3. Simula uma transação de VENDA (DEPOSIT) de 10.000 Zinthos por 1000 Runas
	const now = Date.now();
	const resDeposit = await db.dbRun(
		"bank",
		`INSERT INTO bank_transactions 
		(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp, status)
		VALUES (?, 'DEPOSIT', 'waifu', 10000, 1000, 0.03, 30, '{"amount":10000}', ?, 'COMPLETED')`,
		[testUser, now]
	);
	const depositTxId = resDeposit.lastID;
	assert.ok(depositTxId > 0, "Deveria ter gerado ID para transação de venda");
	console.log(`✓ 3. Transação de venda #${depositTxId} criada (10.000 Zinthos -> 1000 Runas).`);

	// 4. Teste de Desfazer Venda pelo Usuário (dentro de 5 min)
	// Taxa de spread = 5% de 1000 = 50 Runas. Total a debitar = 1000 + 50 = 1050 Runas.
	console.log("4. Testando desfazer venda pelo usuário (Segunda Chance)...");
	const undoResult = await bankService.undoTransaction(depositTxId, {
		userId: testUser,
		isAdmin: false
	});

	assert.strictEqual(undoResult.undone, true, "Transação deve estar marcada como undone");
	assert.strictEqual(undoResult.spreadFeeRunas, 50, "Taxa spread deve ser 50 Runas (5%)");
	assert.strictEqual(undoResult.finalRunas, 1050, "Valor final debitado deve ser 1050 Runas");
	assert.strictEqual(
		undoResult.newBalance,
		950,
		"Saldo após estorno de venda deve ser 2000 - 1050 = 950 Runas"
	);

	// Valida persistência no banco
	const txAfterUndo = await db.dbGet("bank", "SELECT * FROM bank_transactions WHERE id = ?", [
		depositTxId
	]);
	assert.strictEqual(txAfterUndo.status, "UNDONE", "Status da transação deve ser UNDONE");
	assert.ok(txAfterUndo.undone_at > 0, "undone_at deve estar preenchido");
	assert.strictEqual(txAfterUndo.undo_fee_runas, 50);
	assert.strictEqual(txAfterUndo.undo_final_runas, 1050);
	console.log("✓ 4. Desfazer venda pelo usuário validado com sucesso (saldo final: 950 ᚱ).");

	// 5. Tentativa de desfazer a mesma transação novamente deve falhar
	console.log("5. Testando prevenção de estorno duplo...");
	await assert.rejects(
		async () => {
			await bankService.undoTransaction(depositTxId, { userId: testUser, isAdmin: false });
		},
		/já foi desfeita/i,
		"Deveria rejeitar estorno de transação já desfeita"
	);
	console.log("✓ 5. Prevenção de estorno duplo validada.");

	// 6. Simula uma transação de COMPRA (WITHDRAW) de 5.000 Zinthos por 500 Runas
	const resWithdraw = await db.dbRun(
		"bank",
		`INSERT INTO bank_transactions 
		(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp, status)
		VALUES (?, 'WITHDRAW', 'waifu', 5000, 500, 0.03, 15, '{"runasAmount":500}', ?, 'COMPLETED')`,
		[testUser, now]
	);
	const withdrawTxId = resWithdraw.lastID;

	// Desfaz a compra: Taxa 5% de 500 = 25 Runas. Reembolso = 500 - 25 = 475 Runas.
	console.log(
		`6. Testando desfazer compra #${withdrawTxId} (500 Runas - 5% = 475 Runas reembolsadas)...`
	);
	const undoWithdrawResult = await bankService.undoTransaction(withdrawTxId, {
		userId: testUser,
		isAdmin: false
	});

	assert.strictEqual(undoWithdrawResult.spreadFeeRunas, 25, "Taxa spread deve ser 25 Runas (5%)");
	assert.strictEqual(undoWithdrawResult.finalRunas, 475, "Valor reembolsado deve ser 475 Runas");
	assert.strictEqual(undoWithdrawResult.newBalance, 1425, "Saldo deve ser 950 + 475 = 1425 Runas");
	console.log("✓ 6. Desfazer compra pelo usuário validado com sucesso (saldo final: 1425 ᚱ).");

	// 7. Teste de Janela de 5 minutos
	console.log("7. Testando limite de tempo de 5 minutos para usuário comum...");
	const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
	const resOld = await db.dbRun(
		"bank",
		`INSERT INTO bank_transactions 
		(user_id, type, game, game_amount, runas_amount, spread_rate, spread_fee_runas, details_json, timestamp, status)
		VALUES (?, 'WITHDRAW', 'waifu', 2000, 200, 0.03, 6, '{}', ?, 'COMPLETED')`,
		[testUser, sixMinutesAgo]
	);
	const oldTxId = resOld.lastID;

	// Usuário comum tenta desfazer -> deve ser rejeitado
	await assert.rejects(
		async () => {
			await bankService.undoTransaction(oldTxId, { userId: testUser, isAdmin: false });
		},
		/prazo.*5 minutos.*expirou/i,
		"Usuário comum não deve conseguir desfazer transação com mais de 5 minutos"
	);
	console.log("✓ 7.1 Rejeição de transação antiga para usuário comum validada.");

	// 8. Administrador desfaz a mesma transação antiga sem limite de tempo e com valor customizado
	console.log("8. Testando estorno administrativo sem limite de tempo e com valor customizado...");
	const adminUndoResult = await bankService.undoTransaction(oldTxId, {
		userId: null,
		isAdmin: true,
		customFinalRunas: 195, // Admin digitou 195 Runas no input
		adminUser: "superadmin"
	});

	assert.strictEqual(adminUndoResult.undone, true);
	assert.strictEqual(
		adminUndoResult.finalRunas,
		195,
		"Deve aplicar exatamente o valor customizado pelo admin"
	);
	assert.strictEqual(adminUndoResult.newBalance, 1620, "Saldo deve ser 1425 + 195 = 1620 Runas");
	console.log("✓ 8. Estorno administrativo sem limite de tempo e com valor customizado validado!");

	// 9. Teste de adminGetTransactions (listagem, paginação e filtros)
	console.log("9. Testando adminGetTransactions...");
	const txList = await bankService.adminGetTransactions({ query: testUser, limit: 10 });
	assert.ok(txList && Array.isArray(txList.transactions), "Deveria retornar lista de transações");
	assert.ok(txList.total >= 3, "Deveria encontrar as transações criadas para o usuário de teste");
	assert.strictEqual(txList.page, 1);

	// Filtro por status
	const undoneOnly = await bankService.adminGetTransactions({
		query: testUser,
		status: "UNDONE",
		limit: 10
	});
	assert.ok(
		undoneOnly.transactions.every((t) => t.status === "UNDONE"),
		"Todas devem ter status UNDONE"
	);
	console.log(
		`✓ 9. adminGetTransactions validado (${txList.total} transações do usuário de teste encontradas).`
	);

	// 10. Limpeza final
	await db.dbRun("bank", "DELETE FROM bank_accounts WHERE user_id = ?", [testUser]);
	await db.dbRun("bank", "DELETE FROM bank_transactions WHERE user_id = ?", [testUser]);
	console.log("✓ 10. Limpeza final concluída.");

	console.log("\n=======================================================");
	console.log("🎉 TODOS OS TESTES PASSARAM COM SUCESSO!");
	console.log("=======================================================");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
