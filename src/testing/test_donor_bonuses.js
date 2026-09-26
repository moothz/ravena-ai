process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const DonorBonusService = require("../services/DonorBonusService");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== INICIANDO TESTES DO SISTEMA DE BÔNUS DE DOADORES ===");

	// 1. Testes de cálculo de bônus por valor
	console.log("\n--- 1. Testando cálculos de bônus (DonorBonusService.calculateBonuses) ---");

	// R$ 10
	const b10 = DonorBonusService.calculateBonuses(10);
	assert.strictEqual(b10.pesca.baits, 20, "R$10 deve conceder 20 iscas");
	assert.strictEqual(b10.slots.coins, 30, "R$10 deve conceder 30 moedas");
	assert.strictEqual(b10.pesca.simpleItemsCount, 2, "R$10 deve conceder 2 itens simples");
	assert.strictEqual(b10.pesca.mediumItemsCount, 0, "R$10 não atinge faixa média");
	assert.strictEqual(b10.pesca.totalHighItems, 0, "R$10 não atinge faixa alta");
	assert.strictEqual(b10.waifu.rarityMultipliers.RARE, 1.2, "R$10: RARE 1.20x");
	assert.strictEqual(b10.waifu.rarityMultipliers.EPIC, 1.35, "R$10: EPIC 1.35x");
	assert.strictEqual(b10.waifu.rarityMultipliers.LEGENDARY, 1.45, "R$10: LEGENDARY 1.45x");
	assert.strictEqual(b10.waifu.wishlistMultiplier, null, "R$10: wishlist não ativada");
	assert.strictEqual(b10.pinto.bonusPercent, 10, "R$10: pinto +10%");
	console.log("✓ R$ 10 cálculos OK");

	// R$ 20
	const b20 = DonorBonusService.calculateBonuses(20);
	assert.strictEqual(b20.pesca.baits, 40, "R$20 deve conceder 40 iscas");
	assert.strictEqual(b20.slots.coins, 60, "R$20 deve conceder 60 moedas");
	assert.strictEqual(b20.pesca.simpleItemsCount, 4, "R$20 deve conceder 4 itens simples");
	assert.strictEqual(b20.pesca.mediumItemsCount, 1, "R$20 deve conceder 1 item médio");
	assert.strictEqual(b20.pesca.totalHighItems, 0, "R$20 não atinge faixa alta");
	console.log("✓ R$ 20 cálculos OK");

	// R$ 35
	const b35 = DonorBonusService.calculateBonuses(35);
	assert.strictEqual(b35.pesca.baits, 70, "R$35 deve conceder 70 iscas");
	assert.strictEqual(b35.slots.coins, 105, "R$35 deve conceder 105 moedas");
	assert.strictEqual(b35.pesca.simpleItemsCount, 7, "R$35 deve conceder 7 itens simples");
	assert.strictEqual(b35.pesca.mediumItemsCount, 1, "R$35 deve conceder 1 item médio");
	assert.strictEqual(
		b35.pesca.highItems30to50Count,
		1,
		"R$35 deve conceder 1 item alto da faixa 30-50"
	);
	assert.strictEqual(b35.pesca.totalHighItems, 1, "R$35 total itens altos = 1");
	console.log("✓ R$ 35 cálculos OK");

	// R$ 50
	const b50 = DonorBonusService.calculateBonuses(50);
	assert.strictEqual(b50.pesca.baits, 100, "R$50 deve conceder 100 iscas");
	assert.strictEqual(b50.slots.coins, 150, "R$50 deve conceder 150 moedas");
	assert.strictEqual(b50.pesca.simpleItemsCount, 10, "R$50 deve conceder 10 itens simples");
	assert.strictEqual(b50.pesca.mediumItemsCount, 1, "R$50 deve conceder 1 item médio");
	assert.strictEqual(
		b50.pesca.highItems30to50Count,
		1,
		"R$50 deve conceder 1 item alto faixa 30-50"
	);
	assert.strictEqual(b50.pesca.highItemsAbove50Count, 1, "R$50 base acima de 50 = 1 item alto");
	assert.strictEqual(b50.pesca.totalHighItems, 2, "R$50 total itens altos = 2");
	assert.strictEqual(b50.waifu.wishlistMultiplier, 4.0, "R$50 wishlist base = 4.0x (+300%)");
	console.log("✓ R$ 50 cálculos OK");

	// R$ 80
	const b80 = DonorBonusService.calculateBonuses(80);
	assert.strictEqual(b80.pesca.baits, 160, "R$80 deve conceder 160 iscas");
	assert.strictEqual(b80.slots.coins, 240, "R$80 deve conceder 240 moedas");
	assert.strictEqual(b80.pesca.simpleItemsCount, 16, "R$80 deve conceder 16 itens simples");
	assert.strictEqual(b80.pesca.mediumItemsCount, 1, "R$80 deve conceder 1 item médio");
	assert.strictEqual(
		b80.pesca.highItems30to50Count,
		1,
		"R$80 deve conceder 1 item alto faixa 30-50"
	);
	assert.strictEqual(
		b80.pesca.highItemsAbove50Count,
		4,
		"R$80 deve conceder 4 itens altos (1 + 3)"
	);
	assert.strictEqual(b80.pesca.totalHighItems, 5, "R$80 total itens altos = 5");
	assert.strictEqual(b80.waifu.wishlistMultiplier, 6.4, "R$80 wishlist = 6.4x (4.0 + 30*0.08)");
	console.log("✓ R$ 80 cálculos OK");

	// R$ 100 e validação da taxa de lendário ~8%
	const b100 = DonorBonusService.calculateBonuses(100);
	assert.strictEqual(b100.pesca.baits, 200, "R$100 deve conceder 200 iscas");
	assert.strictEqual(b100.slots.coins, 300, "R$100 deve conceder 300 moedas");
	assert.strictEqual(b100.waifu.rarityMultipliers.RARE, 3.0, "R$100: RARE 3.0x");
	assert.strictEqual(b100.waifu.rarityMultipliers.EPIC, 4.5, "R$100: EPIC 4.5x");
	assert.strictEqual(b100.waifu.rarityMultipliers.LEGENDARY, 5.5, "R$100: LEGENDARY 5.5x");
	assert.strictEqual(b100.waifu.wishlistMultiplier, 8.0, "R$100: Wishlist 8.0x (+700%)");

	// Cálculo da probabilidade ponderada de lendário
	const legWeight = 5 * b100.waifu.rarityMultipliers.LEGENDARY; // 27.5
	const epicWeight = 15 * b100.waifu.rarityMultipliers.EPIC; // 67.5
	const rareWeight = 30 * b100.waifu.rarityMultipliers.RARE; // 90
	const uncomWeight = 60;
	const comWeight = 100;
	const totalWeight = legWeight + epicWeight + rareWeight + uncomWeight + comWeight;
	const legChance = (legWeight / totalWeight) * 100;
	console.log(`Chance calculada de Lendário aos R$100: ${legChance.toFixed(2)}% (esperado ~8.0%)`);
	assert.ok(legChance >= 7.8 && legChance <= 8.2, "Chance de lendário deve estar em torno de 8%");
	console.log("✓ R$ 100 e calibração de Waifus OK");

	// 2. Testes de cálculo incremental (delta)
	console.log("\n--- 2. Testando cálculo incremental (calculateIncrementalBonuses) ---");
	const inc = DonorBonusService.calculateIncrementalBonuses(80, 50);
	assert.strictEqual(inc.deltaAmount, 30, "Delta amount deve ser 30");
	assert.strictEqual(inc.deltaBaits, 60, "Delta baits deve ser 60 (160 - 100)");
	assert.strictEqual(inc.deltaCoins, 90, "Delta coins deve ser 90 (240 - 150)");
	assert.strictEqual(inc.deltaSimpleItems, 6, "Delta simple items deve ser 6 (16 - 10)");
	assert.strictEqual(inc.deltaMediumItems, 0, "Delta medium items deve ser 0 (já recebeu)");
	assert.strictEqual(inc.deltaHighItems, 3, "Delta high items deve ser 3 (5 - 2)");
	console.log("✓ Cálculo incremental OK");

	// 3. Teste do comando !doar-vantagens via EventHandler e FakeBot
	console.log("\n--- 3. Testando comando !doar-vantagens ---");
	const bot = new FakeBot({ id: "teste", grupoLogs: null, dossieGroups: null });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	async function waitForReply(maxMs = 5000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length > 0) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 100));
		}
		return bot.capturedMessages;
	}

	// Teste com não-doador
	eventHandler.commandHandler.userDebounceMap?.clear();
	bot.resetCapture();
	const msgNaoDoador = createMessage({
		content: "!doar-vantagens",
		group: "120363000000000000@g.us",
		author: "5599999999999@s.whatsapp.net"
	});
	await eventHandler.processMessage(bot, msgNaoDoador);
	await waitForReply();
	const capturedNaoDoador = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(capturedNaoDoador, "Deve capturar mensagem de resposta");
	const contentNaoDoador = capturedNaoDoador.content || capturedNaoDoador.text;
	assert.ok(
		contentNaoDoador.includes("Você ainda não é um apoiador"),
		"Deve exibir mensagem amigável para não-doador"
	);
	assert.ok(contentNaoDoador.includes("Pescaria:"), "Deve listar regras de Pescaria");
	assert.ok(contentNaoDoador.includes("Caça-Níqueis (Slots):"), "Deve listar regras de Slots");
	assert.ok(contentNaoDoador.includes("Waifus (Mudae):"), "Deve listar regras de Waifus");
	console.log("✓ !doar-vantagens para não-doador OK");

	// Teste com doador conhecido (Agrius / 5511981010487)
	eventHandler.commandHandler.userDebounceMap?.clear();
	bot.resetCapture();
	const msgDoador = createMessage({
		content: "!doar-vantagens",
		group: "120363000000000000@g.us",
		author: "5511981010487@s.whatsapp.net"
	});
	await eventHandler.processMessage(bot, msgDoador);
	await waitForReply();
	const capturedDoador = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(capturedDoador, "Deve capturar mensagem para doador");
	const contentDoador = capturedDoador.content || capturedDoador.text;
	assert.ok(contentDoador.includes("Você é um apoiador!"), "Deve agradecer ao doador");
	assert.ok(
		contentDoador.includes("160") && contentDoador.includes("iscas"),
		"Deve listar 160 iscas acumuladas"
	);
	assert.ok(
		contentDoador.includes("240") && contentDoador.includes("moedas"),
		"Deve listar 240 moedas acumuladas"
	);
	console.log("✓ !doar-vantagens para apoiador OK");

	// 4. Teste de concessão simulada (dry-run)
	console.log("\n--- 4. Testando concessão simulada (awardDonorBonuses dryRun) ---");
	const resDry = await DonorBonusService.awardDonorBonuses("Agrius Metamorphosis", 80, 0, {
		dryRun: true
	});
	assert.strictEqual(resDry.success, true, "Concessão simulada deve ter sucesso");
	assert.strictEqual(resDry.dryRun, true, "Deve confirmar dry-run");
	assert.strictEqual(resDry.delta.deltaBaits, 160, "Deve calcular 160 iscas");
	assert.strictEqual(resDry.delta.deltaCoins, 240, "Deve calcular 240 moedas");
	assert.strictEqual(
		resDry.chosenItems.length,
		22,
		"Total de itens sorteados deve ser 16 + 1 + 1 + 4 = 22"
	);
	console.log("✓ awardDonorBonuses com dryRun OK");

	// 5. Teste da mensagem de notificação de donate em grupos logs/avisos
	console.log("\n--- 5. Testando notifyGroupsAboutDonation com e sem número vinculado ---");
	const dummyBot = {
		grupoLogs: "logs@g.us",
		grupoAvisos: "avisos@g.us",
		notificarDonate: true,
		sent: [],
		async sendMessage(target, msg) {
			this.sent.push({ target, msg });
			return { pin: async () => {} };
		}
	};
	const BotAPI = require("../BotAPI");
	const dummyApi = {
		database: {
			getDonorByName: async (name) => {
				if (name === "DoadorComNumero") return { nome: "DoadorComNumero", numero: "5511999999999" };
				return { nome: "DoadorSemNumero", numero: null };
			}
		},
		bots: [dummyBot],
		logger: { error: () => {}, info: () => {} },
		notifyGroupsAboutDonation: BotAPI.prototype.notifyGroupsAboutDonation
	};

	// Doador sem número
	dummyBot.sent = [];
	await dummyApi.notifyGroupsAboutDonation("DoadorSemNumero", 20, "Parabens pelo bot!", 20);
	assert.ok(dummyBot.sent.length >= 2, "Deve enviar para grupoLogs e grupoAvisos");
	assert.ok(
		dummyBot.sent[0].msg.includes("❗️ Ainda não tenho seu número salvo, me chama no grupão!"),
		"Deve incluir aviso de número pendente para doador sem número"
	);
	assert.ok(
		dummyBot.sent[1].msg.includes("❗️ Ainda não tenho seu número salvo, me chama no grupão!"),
		"Deve incluir aviso no grupo de avisos também"
	);

	// Doador com número
	dummyBot.sent = [];
	await dummyApi.notifyGroupsAboutDonation("DoadorComNumero", 50, "Top!", 50);
	assert.ok(dummyBot.sent.length >= 2, "Deve enviar para grupoLogs e grupoAvisos");
	assert.ok(
		!dummyBot.sent[0].msg.includes("❗️ Ainda não tenho seu número salvo, me chama no grupão!"),
		"Não deve incluir aviso de número para doador com número salvo"
	);
	assert.ok(
		!dummyBot.sent[1].msg.includes("❗️ Ainda não tenho seu número salvo, me chama no grupão!"),
		"Não deve incluir aviso no grupo de avisos para doador com número salvo"
	);
	console.log("✓ notifyGroupsAboutDonation com e sem número OK");

	console.log("\n==========================================================");
	console.log("🎉 TODOS OS TESTES DE BÔNUS DE DOADORES PASSARAM COM SUCESSO!");
	console.log("==========================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes:", err);
		process.exit(1);
	});
