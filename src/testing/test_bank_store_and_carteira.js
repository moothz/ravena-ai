process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const bankService = require("../services/BankService");
const FishingGame = require("../functions/FishingGame");
const SlotsGame = require("../functions/SlotsGame");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");

async function main() {
	console.log("=== Iniciando Testes da Loja RavenaBank e Carteira Furada ===");

	const testUserId = "9999988887777";
	const testGroupId = "120363000999999@g.us";
	const db = Database.getInstance();
	db.testMode = false;

	// Limpeza inicial
	await db.dbRun("bank", "DELETE FROM bank_accounts WHERE user_id = ?", [testUserId]);
	await db.dbRun("bank", "DELETE FROM bank_transactions WHERE user_id = ?", [testUserId]);
	await db.dbRun("bank", "DELETE FROM bank_daily_quotas WHERE user_id = ?", [testUserId]);
	await db.dbRun("slots", "DELETE FROM slots_users WHERE user_id = ?", [testUserId]);
	await db.dbRun("fishing", "DELETE FROM fishing_users WHERE user_id = ?", [testUserId]);
	await db.dbRun("fishing", "DELETE FROM fishing_buffs WHERE user_id = ?", [testUserId]);

	console.log("✓ Limpeza de ambiente de teste concluída.");

	// 1. Teste do item Carteira Furada em FishingGame
	console.log("\n--- Teste 1: Configuração e Efeito da Carteira Furada ---");
	const carteiraUpgrade = FishingGame.UPGRADES.find((u) => u.name === "Carteira Furada");
	assert.ok(carteiraUpgrade, "Carteira Furada deve existir em FishingGame.UPGRADES");
	assert.strictEqual(carteiraUpgrade.chance, 0.04, "Chance deve ser exatamente 0.04 (4%)");
	assert.strictEqual(carteiraUpgrade.effect, "bank_runas", "Efeito deve ser bank_runas");
	assert.strictEqual(carteiraUpgrade.minValue, 50, "minValue deve ser 50");
	assert.strictEqual(carteiraUpgrade.maxValue, 500, "maxValue deve ser 500");
	console.log("✓ Configuração de UPGRADES da Carteira Furada validada.");

	// Testa a aplicação do efeito da Carteira Furada
	const mockItem = {
		type: "upgrade",
		effect: "bank_runas",
		value: 275,
		name: "Carteira Furada",
		emoji: "👛"
	};
	const fakeUserData = { userId: testUserId, buffs: [], debuffs: [] };
	await FishingGame.applyItemEffect(fakeUserData, mockItem);

	const bankAccount = await bankService.getAccount(testUserId);
	assert.strictEqual(
		bankAccount.runas,
		275,
		"Saldo da conta deve ter sido creditado com 275 Runas"
	);
	console.log("✓ Crédito de Runas da Carteira Furada verificado:", bankAccount.runas, "ᚱ");

	// 2. Teste da Loja: Compra de Moedinhas do Slots
	console.log("\n--- Teste 2: Loja - Compra de Moedinhas do Slots (55 ᚱ cada, máx 300/dia) ---");
	// Adiciona saldo para testes
	await bankService.creditRunas(testUserId, 50000);

	// Inicializa usuário no slots com 5 moedas
	await SlotsGame.addCoins(testUserId, 0);
	const initialCoins = await SlotsGame.getUserCoins(testUserId);
	console.log("Moedas iniciais:", initialCoins);

	// Compra 10 moedas (custo: 550 ᚱ)
	const buyCoinsRes = await bankService.buySlotsCoins(testUserId, 10);
	assert.strictEqual(buyCoinsRes.count, 10);
	assert.strictEqual(buyCoinsRes.costRunas, 550);
	assert.strictEqual(buyCoinsRes.currentCoins, initialCoins + 10);
	console.log(
		`✓ Compra de 10 moedas concluída com sucesso. Novo saldo: ${buyCoinsRes.currentCoins}`
	);

	// Tenta comprar mais 295 moedas (10 + 295 = 305 > 300/dia -> deve bloquear)
	let blockedCoins = false;
	try {
		await bankService.buySlotsCoins(testUserId, 295);
	} catch (err) {
		blockedCoins = true;
		console.log("✓ Bloqueio esperado por limite diário de 300 moedas capturado:", err.message);
	}
	assert.ok(blockedCoins, "Tentativa de compra que ultrapassa 300 moedas/dia DEVE ser bloqueada!");

	// Compra até o limite diário de 300 moedas (já comprou 10, faltam 290)
	const fillRes = await bankService.buySlotsCoins(testUserId, 290);
	assert.strictEqual(fillRes.count, 290);
	assert.strictEqual(fillRes.costRunas, 290 * 55);
	console.log("✓ Limite diário de 300 moedas atingido com sucesso.");

	// Agora no limite diário de 300, qualquer tentativa de compra de 1 moeda deve falhar
	let blockedAt300 = false;
	try {
		await bankService.buySlotsCoins(testUserId, 1);
	} catch (err) {
		blockedAt300 = true;
		console.log("✓ Bloqueio com cota diária de moedas esgotada capturado:", err.message);
	}
	assert.ok(blockedAt300, "Tentativa de compra quando cota diária esgotou DEVE ser bloqueada!");

	// 3. Teste da Loja: Compra de Iscas de Pesca
	console.log("\n--- Teste 3: Loja - Compra de Iscas (45 ᚱ cada, máx 200/dia) ---");
	// Inicializa usuário na pesca com 2 iscas (capacidade padrão: 5 iscas)
	await db.dbRun(
		"fishing",
		"INSERT INTO fishing_users (user_id, name, baits, last_bait_regen) VALUES (?, 'Pescador Teste', 2, ?)",
		[testUserId, Date.now()]
	);

	const baitInfo = await FishingGame.getUserBaitsInfo(testUserId);
	assert.strictEqual(baitInfo.baits, 2);

	// Tenta comprar 205 iscas (ultrapassa cota diária de 200) -> DEVE bloquear
	let blockedBaits = false;
	try {
		await bankService.buyFishingBaits(testUserId, 205);
	} catch (err) {
		blockedBaits = true;
		console.log("✓ Bloqueio esperado por limite diário de 200 iscas capturado:", err.message);
	}
	assert.ok(blockedBaits, "Tentativa de compra que ultrapassa 200 iscas/dia DEVE ser bloqueada!");

	// Compra 10 iscas (custo: 10 * 45 = 450 ᚱ)
	const buyBaitsRes = await bankService.buyFishingBaits(testUserId, 10);
	assert.strictEqual(buyBaitsRes.count, 10);
	assert.strictEqual(buyBaitsRes.costRunas, 450);
	assert.strictEqual(buyBaitsRes.currentBaits, 12);
	console.log("✓ Compra de 10 iscas concluída. Saldo resultante:", buyBaitsRes.currentBaits);

	// Compra as 190 iscas restantes para atingir o teto diário de 200
	const fillBaitsRes = await bankService.buyFishingBaits(testUserId, 190);
	assert.strictEqual(fillBaitsRes.count, 190);
	assert.strictEqual(fillBaitsRes.costRunas, 190 * 45);
	console.log("✓ Limite diário de 200 iscas atingido com sucesso.");

	// Agora com 200 iscas compradas hoje, compra de 1 isca deve falhar
	let blockedAt200 = false;
	try {
		await bankService.buyFishingBaits(testUserId, 1);
	} catch (err) {
		blockedAt200 = true;
		console.log("✓ Bloqueio com cota diária de iscas esgotada capturado:", err.message);
	}
	assert.ok(
		blockedAt200,
		"Tentativa de compra com cota diária de iscas esgotada DEVE ser bloqueada!"
	);

	// 4. Teste de Saldo Insuficiente
	console.log("\n--- Teste 4: Saldo Insuficiente de Runas ---");
	const poorUserId = "9999900001111";
	await db.dbRun("bank", "DELETE FROM bank_accounts WHERE user_id = ?", [poorUserId]);
	await bankService.getAccount(poorUserId); // Cria com 0 Runas

	let poorCoinBlocked = false;
	try {
		await bankService.buySlotsCoins(poorUserId, 1);
	} catch (err) {
		poorCoinBlocked = true;
		assert.ok(/saldo insuficiente/i.test(err.message));
	}
	assert.ok(
		poorCoinBlocked,
		"Tentativa de compra de moeda sem Runas deve falhar por saldo insuficiente"
	);

	let poorBaitBlocked = false;
	try {
		await bankService.buyFishingBaits(poorUserId, 1);
	} catch (err) {
		poorBaitBlocked = true;
		assert.ok(/saldo insuficiente/i.test(err.message));
	}
	assert.ok(
		poorBaitBlocked,
		"Tentativa de compra de isca sem Runas deve falhar por saldo insuficiente"
	);
	console.log("✓ Validações de saldo insuficiente de Runas aprovadas.");

	// 5. Teste do Catálogo da Loja
	console.log("\n--- Teste 5: Catálogo da Loja ---");
	const catalog = await bankService.getStoreCatalog(testUserId);
	assert.ok(catalog.userRunas > 0, "Saldo do usuário no catálogo deve ser positivo");
	assert.strictEqual(catalog.items.length, 2, "Catálogo deve conter 2 itens (moedas e iscas)");
	assert.strictEqual(catalog.items[0].priceRunas, 55);
	assert.strictEqual(catalog.items[1].priceRunas, 45);
	console.log(
		"✓ Catálogo da loja obtido com sucesso:",
		catalog.items.map((i) => `${i.name}: ${i.priceRunas}ᚱ`)
	);

	// 6. Teste dos Comandos de Chat via processCommand
	console.log("\n--- Teste 6: Comandos de Chat (!banco-loja e !banco-comprar) ---");
	const testChatGroup = "120363222333444@g.us";
	const bot = new FakeBot({ id: "teste", grupoLogs: "logs@g.us", dossieGroups: "dossie@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.loadAllCommands();
	eventHandler.commandHandler.cmdDebounceTime = 0;
	eventHandler.commandHandler.checkCooldown = async () => ({ inCooldown: false, timeLeft: 0 });
	db.testMode = false;

	// Comando !banco-loja
	bot.resetCapture();
	eventHandler.commandHandler.cooldownCache.clear();
	const msgLoja = createMessage({
		author: testUserId,
		group: testChatGroup,
		content: "!banco-loja"
	});
	const resLoja = await eventHandler.commandHandler.processCommand(
		bot,
		msgLoja,
		"banco-loja",
		[],
		null
	);
	assert.ok(bot.capturedMessages.length > 0, "Deve retornar mensagem para !banco-loja");
	assert.ok(
		/LOJA RAVENABANK/i.test(bot.capturedMessages[0].content),
		"Deve conter cabeçalho da loja"
	);
	console.log("✓ Comando !banco-loja validado com sucesso.");

	// Usuário de teste para comando com saldo suficiente
	const cmdUserId = "9999933334444";
	await db.dbRun("bank", "DELETE FROM bank_accounts WHERE user_id = ?", [cmdUserId]);
	await db.dbRun("slots", "DELETE FROM slots_users WHERE user_id = ?", [cmdUserId]);
	await db.dbRun("fishing", "DELETE FROM fishing_users WHERE user_id = ?", [cmdUserId]);
	await bankService.creditRunas(cmdUserId, 10000);
	// Zera moedas e iscas para teste limpo
	await db.dbRun("slots", "INSERT INTO slots_users (user_id, coins) VALUES (?, 5)", [cmdUserId]);
	await db.dbRun("fishing", "INSERT INTO fishing_users (user_id, baits) VALUES (?, 3)", [
		cmdUserId
	]);

	// Comando !banco-comprar moeda 2
	bot.resetCapture();
	eventHandler.commandHandler.cooldownCache.clear();
	db.testMode = false;
	const msgBuyCoin = createMessage({
		author: cmdUserId,
		group: testChatGroup,
		content: "!banco-comprar moeda 2"
	});
	await eventHandler.commandHandler.processCommand(
		bot,
		msgBuyCoin,
		"banco-comprar",
		["moeda", "2"],
		null
	);
	assert.ok(bot.capturedMessages.length > 0, "Deve retornar mensagem para compra de moedas");
	assert.ok(/COMPRA DE MOEDINHAS CONCLUÍDA/i.test(bot.capturedMessages[0].content));
	console.log("✓ Comando !banco-comprar moeda 2 validado com sucesso.");

	// Comando !banco-comprar isca 2
	bot.resetCapture();
	eventHandler.commandHandler.cooldownCache.clear();
	db.testMode = false;
	const msgBuyBait = createMessage({
		author: cmdUserId,
		group: testChatGroup,
		content: "!banco-comprar isca 2"
	});
	await eventHandler.commandHandler.processCommand(
		bot,
		msgBuyBait,
		"banco-comprar",
		["isca", "2"],
		null
	);
	assert.ok(bot.capturedMessages.length > 0, "Deve retornar mensagem para compra de iscas");
	assert.ok(/COMPRA DE ISCAS CONCLUÍDA/i.test(bot.capturedMessages[0].content));
	console.log("✓ Comando !banco-comprar isca 2 validado com sucesso.");

	// Limpeza final dos usuários de teste
	await db.dbRun("bank", "DELETE FROM bank_accounts WHERE user_id IN (?, ?, ?)", [
		testUserId,
		poorUserId,
		cmdUserId
	]);
	await db.dbRun("bank", "DELETE FROM bank_transactions WHERE user_id IN (?, ?, ?)", [
		testUserId,
		poorUserId,
		cmdUserId
	]);
	await db.dbRun("slots", "DELETE FROM slots_users WHERE user_id IN (?, ?, ?)", [
		testUserId,
		poorUserId,
		cmdUserId
	]);
	await db.dbRun("fishing", "DELETE FROM fishing_users WHERE user_id IN (?, ?, ?)", [
		testUserId,
		poorUserId,
		cmdUserId
	]);
	await db.dbRun("fishing", "DELETE FROM fishing_buffs WHERE user_id IN (?, ?, ?)", [
		testUserId,
		poorUserId,
		cmdUserId
	]);

	console.log("\n========================================================");
	console.log("🎉 TODOS OS TESTES DA LOJA E CARTEIRA FURADA PASSARAM COM SUCESSO!");
	console.log("========================================================");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro nos testes:", err);
		process.exit(1);
	});
