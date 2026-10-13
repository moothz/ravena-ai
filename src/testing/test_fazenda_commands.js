/**
 * test_fazenda_commands.js
 *
 * Teste automatizado de integração dos comandos do Jardim das Sombras (Fazenda).
 * Executado dentro do container Docker via FakeBot e EventHandler.
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
const FazendaCommands = require("../functions/FazendaCommands");

async function runTests() {
	console.log("==================================================================");
	console.log("🌱 TESTE AUTOMATIZADO DOS COMANDOS DA FAZENDA (JARDIM DAS SOMBRAS)");
	console.log("==================================================================\n");

	const bot = new FakeBot({ id: "test-bot", grupoLogs: "logs@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	const testUser = "5511999998888@s.whatsapp.net";
	const testGroup = "120363000000000@g.us";

	async function waitForReply(maxMs = 10000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length > 0) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 100));
		}
		return bot.capturedMessages;
	}

	function prepareStep() {
		bot.resetCapture();
		if (eventHandler.commandHandler?.userDebounceMap) {
			eventHandler.commandHandler.userDebounceMap.clear();
		}
	}

	// 1. Teste do comando !faz-ajuda
	console.log("1. Testando !faz-ajuda...");
	prepareStep();
	const msgAjuda = createMessage({
		content: "!faz-ajuda",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgAjuda);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria enviar resposta de ajuda");
	assert(
		bot.capturedMessages[0].content.includes("GUIA DO JARDIM DAS SOMBRAS"),
		"Texto de ajuda deveria conter cabeçalho"
	);
	console.log("✓ !faz-ajuda passou com sucesso!");

	// 2. Teste do comando !faz-loja
	console.log("2. Testando !faz-loja...");
	prepareStep();
	const msgLoja = createMessage({
		content: "!faz-loja",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgLoja);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria exibir o catálogo da loja");
	assert(
		bot.capturedMessages[0].content.includes("MERCADO DO JARDIM DAS SOMBRAS"),
		"Deveria conter catálogo de sementes e elixires"
	);
	console.log("✓ !faz-loja passou com sucesso!");

	// 3. Teste do comando !faz-inventario
	console.log("3. Testando !faz-inventario...");
	prepareStep();
	const msgInv = createMessage({
		content: "!faz-inventario",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgInv);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria responder com a mochila");
	assert(
		bot.capturedMessages[0].content.includes("MOCHILA DO JARDIM DAS SOMBRAS"),
		"Deveria conter mochila"
	);
	console.log("✓ !faz-inventario passou com sucesso!");

	// 4. Teste de compra com !faz-comprar
	console.log("4. Testando !faz-comprar...");
	prepareStep();
	const msgBuy = createMessage({
		content: "!faz-comprar 1 1",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgBuy);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria processar compra ou saldo");
	if (bot.capturedMessages.length > 1) {
		assert(
			bot.capturedMessages[1].options?.sendMediaAsSticker === true,
			"Segunda mensagem da compra deve ser o sticker do item comprado"
		);
		console.log("✓ !faz-comprar incluiu sticker da compra!");
	} else {
		console.log("✓ !faz-comprar respondeu adequadamente!");
	}

	// 5. Teste de plantio com !faz-plantar
	console.log("5. Testando !faz-plantar...");
	prepareStep();
	const msgPlant = createMessage({
		content: "!faz-plantar 1 1",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgPlant);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria responder ao comando de plantar");
	console.log("✓ !faz-plantar executado!");

	// 6. Teste de !fazenda no Grupo (Verifica se inclui dica de usar !faz-adm no PV)
	console.log("6. Testando !fazenda em Grupo...");
	prepareStep();
	const msgFazendaGrupo = createMessage({
		content: "!fazenda",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgFazendaGrupo);
	await waitForReply();
	assert(bot.capturedMessages.length >= 1, "Deveria enviar pelo menos a imagem da fazenda");
	const firstMsg = bot.capturedMessages[0];
	assert(firstMsg.content.includes("JARDIM DAS SOMBRAS"), "Deveria conter cabeçalho do jardim");
	assert(
		firstMsg.content.includes("!faz-adm") && firstMsg.content.includes("privado"),
		"Deveria conter a dica de ir ao PV para o admin"
	);
	assert(!firstMsg.content.includes("token="), "NÃO deve vazar token/link de admin no grupo!");
	console.log("✓ !fazenda em grupo passou com sucesso!");

	// 7. Teste de !fazenda no Privado (Verifica se envia link de admin)
	console.log("7. Testando !fazenda no Privado...");
	prepareStep();
	const msgFazendaPV = createMessage({
		content: "!fazenda",
		author: testUser,
		group: null
	});
	await eventHandler.processMessage(bot, msgFazendaPV);
	await waitForReply();
	assert(bot.capturedMessages.length >= 1, "Deveria enviar mensagem no PV");
	const pvMsg = bot.capturedMessages[0];
	assert(
		pvMsg.content.includes("Farm Admin"),
		"Deveria incluir acesso ao Farm Admin quando chamado no PV"
	);
	console.log("✓ !fazenda no PV passou com sucesso!");

	// 8. Teste de colheita com !faz-colher
	console.log("8. Testando !faz-colher...");
	prepareStep();
	const msgColher = createMessage({
		content: "!faz-colher",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgColher);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria responder a colheita");
	console.log("✓ !faz-colher executado!");

	// 9. Teste de venda com !faz-vender
	console.log("9. Testando !faz-vender...");
	prepareStep();
	const msgVender = createMessage({
		content: "!faz-vender",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgVender);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria responder a venda");
	console.log("✓ !faz-vender executado!");

	// 10. Teste de integração de bônus de Waifus
	console.log("10. Testando bônus de rolls e tickets de Waifus...");
	const initialBonus = await FazendaCommands.getFarmWaifuRollBonus(testUser);
	console.log("   Bonus inicial:", initialBonus);

	// Credita 1 roll e 1 ticket sintético
	await ShadowGardenBonusService.dispatchHarvestDrops(testUser, [
		{ bonusType: "waifu_roll", name: "Coração Púrpuro", count: 1 },
		{ bonusType: "waifu_ticket", name: "Rosa de Sangue", count: 1 }
	]);

	const bonusAfter = await FazendaCommands.getFarmWaifuRollBonus(testUser);
	assert.strictEqual(bonusAfter.hasBonus, true, "Deveria ter bônus ativo");
	assert.strictEqual(bonusAfter.rolls >= 1, true, "Deveria ter pelo menos 1 roll");
	assert.strictEqual(bonusAfter.tickets >= 1, true, "Deveria ter pelo menos 1 ticket");

	// Consome primeiro o ticket
	const consTicket = await FazendaCommands.consumeFarmWaifuRoll(testUser);
	assert.strictEqual(consTicket.consumed, true, "Deveria consumir com sucesso");
	assert.strictEqual(consTicket.type, "ticket", "Deveria consumir o ticket primeiro");

	// Consome o roll em seguida
	const consRoll = await FazendaCommands.consumeFarmWaifuRoll(testUser);
	assert.strictEqual(consRoll.consumed, true, "Deveria consumir o roll");
	assert.strictEqual(consRoll.type, "roll", "Deveria consumir o roll");
	console.log("✓ Bônus cruzado de Waifus testado com sucesso!");

	console.log("\n==================================================================");
	console.log("🎉 TODOS OS TESTES DA FAZENDA PASSARAM COM SUCESSO!");
	console.log("==================================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro nos testes:", err);
		process.exit(1);
	});
