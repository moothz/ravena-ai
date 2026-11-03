process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const bankService = require("../services/BankService");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== Iniciando Testes Unitários e de Integração do RavenaBank ===");

	const testUserId = "9999911112222";
	const testGroupId = "120363000999999@g.us";
	const db = Database.getInstance();

	// 1. Limpeza de dados do usuário de teste
	await db.dbRun("bank", "DELETE FROM bank_accounts WHERE user_id = ?", [testUserId]);
	await db.dbRun("bank", "DELETE FROM bank_transactions WHERE user_id = ?", [testUserId]);
	await db.dbRun("bank", "DELETE FROM bank_daily_quotas WHERE user_id = ?", [testUserId]);
	await db.dbRun("bank", "DELETE FROM bank_sessions WHERE user_id = ?", [testUserId]);
	await db.dbRun("fishing", "DELETE FROM fishing_inventory WHERE user_id = ?", [testUserId]);
	await db.dbRun("fishing", "DELETE FROM fishing_users WHERE user_id = ?", [testUserId]);

	console.log("✓ Limpeza de ambiente de teste concluída.");

	// 2. Teste de Cotações Diárias
	const rates = await bankService.getRates();
	console.log("2. Cotações obtidas:", rates);
	assert.ok(rates.runasPerKgFish > 0, "runasPerKgFish deve ser positivo");
	assert.ok(rates.runasPerZinthos > 0, "runasPerZinthos deve ser positivo");
	assert.ok(rates.runasPerJardimCoin > 0, "runasPerJardimCoin deve ser positivo");
	console.log("✓ Cotações diárias calculadas e persistidas com sucesso.");

	// 3. Teste do Spread Dinâmico Progressivo (3% a 10%)
	const spreadInitial = bankService.calculateSpread(0, 50, 1500);
	const spreadMid = bankService.calculateSpread(750, 0, 1500);
	const spreadMax = bankService.calculateSpread(1400, 100, 1500);

	console.log("3. Spreads calculados:", { spreadInitial, spreadMid, spreadMax });
	assert.strictEqual(spreadInitial, 0.0304, "Spread inicial deve ser próximo de 3%");
	assert.ok(spreadMid > 0.05 && spreadMid < 0.06, "Spread médio deve estar em torno de 5.5%");
	assert.strictEqual(spreadMax, 0.1, "Spread máximo no teto deve ser exatamente 10%");
	console.log("✓ Curva de spread progressivo validada entre 3% e 10%.");

	// 4. Teste de Venda de Peixes com Knapsack e Blindagem de Lendários
	// Cria peixes para o usuário: 3 comuns e 1 lendário
	await db.dbRun(
		"fishing",
		`INSERT INTO fishing_inventory (user_id, name, weight, is_rare, timestamp, emoji) VALUES 
		(?, 'Tilápia', 50.0, 0, ?, '🐟'),
		(?, 'Robalo', 70.0, 0, ?, '🐠'),
		(?, 'Tubarão Pequeno', 120.0, 0, ?, '🦈'),
		(?, 'Cthulhu Lendário', 26665.0, 1, ?, '🐙')`,
		[testUserId, Date.now(), testUserId, Date.now(), testUserId, Date.now(), testUserId, Date.now()]
	);

	await db.dbRun(
		"fishing",
		"INSERT INTO fishing_users (user_id, name, inventory_weight) VALUES (?, 'Pescador Teste', 26905.0)",
		[testUserId]
	);

	// Venda solicitando 150 kg:
	// O algoritmo deve selecionar peixes cuja soma seja <= 150 kg (Robalo 70kg + Tilápia 50kg = 120kg OU Tubarão 120kg)
	const depositRes = await bankService.depositFish(testUserId, "150");
	console.log("4. Resultado da venda de peixes:", depositRes);

	assert.ok(depositRes.soldKg <= 150, "Peso vendido deve ser menor ou igual à meta solicitada");
	assert.ok(depositRes.netRunas > 0, "Runas creditadas devem ser positivas");
	assert.strictEqual(
		depositRes.newBalance,
		depositRes.netRunas,
		"Saldo da conta deve refletir Runas creditadas"
	);

	// Verifica que o peixe lendário continua intocado no inventário
	const remainingLegendary = await db.dbGet(
		"fishing",
		"SELECT * FROM fishing_inventory WHERE user_id = ? AND is_rare = 1",
		[testUserId]
	);
	assert.ok(remainingLegendary, "Peixe lendário NUNCA deve ser vendido!");
	assert.strictEqual(remainingLegendary.name, "Cthulhu Lendário");
	console.log("✓ Blindagem de peixes lendários e algoritmo Knapsack validados!");

	// 5. Teste de Bloqueio de Saque de Peixes (Mão Única)
	assert.throws(
		() => {
			bankService.withdrawFish();
		},
		/Não é permitido converter Runas para peixes/i,
		"Saque de peixe deve lançar erro expressamente proibido"
	);
	console.log("✓ Regra de mão única para peixes validada.");

	// 6. Teste de Sessão Deslizante (3 dias)
	const session = await bankService.createSession(testUserId);
	console.log("6. Sessão criada:", session);
	assert.ok(session.token && session.token.length >= 32, "Token seguro deve ser gerado");

	const extended = await bankService.verifyAndExtendSession(session.token);
	assert.ok(extended, "Sessão deve ser válida");
	assert.strictEqual(extended.userId, testUserId, "UserId da sessão deve corresponder");
	assert.ok(extended.expiresAt > Date.now(), "Data de expiração deve ser no futuro");

	// Teste de Logout
	const destroyed = await bankService.destroySession(session.token);
	assert.strictEqual(destroyed, true, "Sessão deve ser destruída no logout");
	const afterLogout = await bankService.verifyAndExtendSession(session.token);
	assert.strictEqual(afterLogout, null, "Sessão destruída não deve mais autenticar");
	console.log("✓ Sessão deslizante e logout validados com sucesso.");

	// 7. Teste de Comandos via FakeBot e EventHandler
	console.log("7. Testando comandos do bot (!banco, !economia, !banco-adm, !banco-extrato)...");
	const bot = new FakeBot({ id: "teste", grupoLogs: "logs@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.loadAllCommands();
	eventHandler.commandHandler.checkCooldown = async () => ({ inCooldown: false, timeLeft: 0 });

	async function waitForReply(maxMs = 5000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length > 0) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 50));
		}
		return bot.capturedMessages;
	}

	function prepareStep() {
		bot.resetCapture();
		if (eventHandler.commandHandler?.userDebounceMap) {
			eventHandler.commandHandler.userDebounceMap.clear();
		}
	}

	// Teste !banco
	prepareStep();
	const msgBanco = createMessage({
		content: "!banco",
		group: testGroupId,
		author: testUserId,
		authorName: "Pescador Teste"
	});
	await eventHandler.processMessage(bot, msgBanco);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "!banco deve responder");
	assert.ok(
		bot.capturedMessages[0].content.includes("RAVENABANK") ||
			bot.capturedMessages[0].content.includes("Saldo de Runas"),
		"!banco deve exibir saldo de Runas"
	);
	console.log("✓ Comando !banco respondeu com saldo e patrimônio.");

	// Teste !economia
	prepareStep();
	const msgEconomia = createMessage({
		content: "!economia",
		group: testGroupId,
		author: testUserId
	});
	await eventHandler.processMessage(bot, msgEconomia);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "!economia deve responder");
	assert.ok(
		bot.capturedMessages[0].content.includes("COTAÇÃO OFICIAL DAS RUNAS") ||
			bot.capturedMessages[0].content.includes("PANORAMA ECONÔMICO"),
		"!economia deve exibir cotações oficiais e transparência"
	);
	console.log("✓ Comando !economia respondeu com transparência macroeconômica.");

	// Teste !banco-adm em grupo (deve enviar no PV)
	prepareStep();
	const msgAdm = createMessage({
		content: "!banco-adm",
		group: testGroupId,
		author: testUserId
	});
	await eventHandler.processMessage(bot, msgAdm);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "!banco-adm deve enviar resposta");
	const admMsg = bot.capturedMessages.find((m) => m.chatId === testUserId);
	assert.ok(admMsg, "!banco-adm deve enviar link no PV do usuário");
	assert.ok(
		admMsg.content.includes("/ravenabank?token="),
		"Link gerado deve conter token para /ravenabank"
	);
	console.log("✓ Comando !banco-adm enviou link seguro com token no privado.");

	// Teste !banco-extrato
	prepareStep();
	const msgExtrato = createMessage({
		content: "!banco-extrato",
		group: testGroupId,
		author: testUserId
	});
	await eventHandler.processMessage(bot, msgExtrato);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "!banco-extrato deve responder");
	assert.ok(
		bot.capturedMessages[0].content.includes("EXTRATO RECENTE"),
		"!banco-extrato deve exibir as transações"
	);
	console.log("✓ Comando !banco-extrato respondeu com histórico de transações.");

	// 8. Limpeza final
	await db.dbRun("bank", "DELETE FROM bank_accounts WHERE user_id = ?", [testUserId]);
	await db.dbRun("bank", "DELETE FROM bank_transactions WHERE user_id = ?", [testUserId]);
	await db.dbRun("bank", "DELETE FROM bank_daily_quotas WHERE user_id = ?", [testUserId]);
	await db.dbRun("fishing", "DELETE FROM fishing_inventory WHERE user_id = ?", [testUserId]);
	await db.dbRun("fishing", "DELETE FROM fishing_users WHERE user_id = ?", [testUserId]);

	console.log("=== TODOS OS TESTES DO RAVENABANK FORAM CONCLUÍDOS COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes do RavenaBank:", err);
	process.exit(1);
});
