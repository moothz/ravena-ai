process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const GameEventService = require("../services/GameEventService");
const Database = require("../utils/Database");
const AdminUtils = require("../utils/AdminUtils");

async function runTests() {
	console.log("=== Iniciando Testes do Sistema de Eventos Temporários ===");

	const database = Database.getInstance({ testMode: true });

	// 1. Teste de Normalização de Nomes e Tipos
	console.log("\n1. Testando normalização de jogos e tipos...");
	assert.strictEqual(GameEventService.normalizeGame("pesca"), "pesca");
	assert.strictEqual(GameEventService.normalizeGame("FISHING"), "pesca");
	assert.strictEqual(GameEventService.normalizeGame("waifu"), "waifu");
	assert.strictEqual(GameEventService.normalizeGame("waifus"), "waifu");
	assert.strictEqual(GameEventService.normalizeGame("mudae"), "waifu");
	assert.strictEqual(GameEventService.normalizeGame("slots"), "slots");
	assert.strictEqual(GameEventService.normalizeGame("slot"), "slots");
	assert.strictEqual(GameEventService.normalizeGame("invalido"), null);

	assert.strictEqual(GameEventService.normalizeType("pesca", "peso"), "peso");
	assert.strictEqual(GameEventService.normalizeType("pesca", "lendario"), "lendario");
	assert.strictEqual(GameEventService.normalizeType("pesca", "lendarios"), "lendario");
	assert.strictEqual(GameEventService.normalizeType("waifu", "raros"), "raros");
	assert.strictEqual(GameEventService.normalizeType("waifu", "wish"), "wish");
	assert.strictEqual(GameEventService.normalizeType("waifu", "wishlist"), "wish");
	assert.strictEqual(GameEventService.normalizeType("slots", "vitoria"), "vitoria");
	assert.strictEqual(GameEventService.normalizeType("slots", "moedas"), "moedas");
	assert.strictEqual(GameEventService.normalizeType("slots", "iscas"), "iscas");
	console.log("✓ Normalização funcionando perfeitamente.");

	// 2. Teste do GameEventService (setEvent, getMultiplier, getEventBanner, removeEvent)
	console.log("\n2. Testando criação e leitura de eventos no GameEventService...");
	// Limpar eventos prévios
	await GameEventService.removeEvent("pesca", "peso");
	await GameEventService.removeEvent("pesca", "lendario");
	await GameEventService.removeEvent("waifu", "raros");
	await GameEventService.removeEvent("slots", "vitoria");

	// Criar evento de pesca: +25% peso por 5 horas
	const resPesca = await GameEventService.setEvent("pesca", "peso", 25, 5, "5511999999999");
	assert.strictEqual(resPesca.success, true);
	assert.strictEqual(GameEventService.getMultiplier("pesca", "peso"), 1.25);

	// Criar evento de waifu: +50% raros por 10 horas
	const resWaifu = await GameEventService.setEvent("waifu", "raros", 50, 10, "5511999999999");
	assert.strictEqual(resWaifu.success, true);
	assert.strictEqual(GameEventService.getMultiplier("waifu", "raros"), 1.5);

	// Criar evento de slots: +10% vitoria por 2 horas
	const resSlots = await GameEventService.setEvent("slots", "vitoria", 10, 2, "5511999999999");
	assert.strictEqual(resSlots.success, true);
	assert.strictEqual(GameEventService.getMultiplier("slots", "vitoria"), 1.1);

	// Multiplicador padrão para evento inexistente deve ser 1.0
	assert.strictEqual(GameEventService.getMultiplier("pesca", "lendario"), 1.0);
	assert.strictEqual(GameEventService.getMultiplier("waifu", "wish"), 1.0);

	// Testar geração do banner
	const bannerPesca = GameEventService.getEventBanner("pesca");
	assert.ok(
		bannerPesca.includes("+25% peso nos peixes"),
		"Banner de pesca deve conter a descrição do evento"
	);
	assert.ok(bannerPesca.includes("restantes"), "Banner de pesca deve conter o tempo restante");

	const bannerWaifu = GameEventService.getEventBanner("waifu");
	assert.ok(bannerWaifu.includes("+50% personagens raros"), "Banner de waifu deve conter raros");

	const bannerSlots = GameEventService.getEventBanner("slots");
	assert.ok(
		bannerSlots.includes("+10% chance de vitória no caça-coisas"),
		"Banner de slots deve conter vitória"
	);
	console.log("✓ GameEventService e banners funcionando perfeitamente.");

	// 3. Teste dos Comandos via CommandHandler e FakeBot
	console.log("\n3. Testando execução dos comandos via CommandHandler...");
	const ownerNumber = "551188888888";
	const ownerJid = `${ownerNumber}@s.whatsapp.net`;

	const adminUtils = AdminUtils.getInstance();
	if (!adminUtils.superAdmins.includes(ownerNumber)) {
		adminUtils.superAdmins.push(ownerNumber);
	}

	const bot = new FakeBot({
		id: "test-bot",
		owner: ownerJid,
		grupoLogs: "123456@g.us",
		dossieGroups: "dossie@g.us",
		testMode: true
	});
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	if (eventHandler.commandHandler?.superAdmin) {
		if (!eventHandler.commandHandler.superAdmin.superAdmins.includes(ownerNumber)) {
			eventHandler.commandHandler.superAdmin.superAdmins.push(ownerNumber);
		}
	}

	const testGroupId = "999888@g.us";

	// 3.1 SuperAdmin: !sa-evento pesca lendario 100 24
	bot.resetCapture();
	const msgSetEvento = createMessage({
		content: "!sa-evento pesca lendario 100 24",
		author: ownerJid,
		group: testGroupId
	});
	await eventHandler.commandHandler.handleCommand(
		bot,
		msgSetEvento,
		"sa-evento pesca lendario 100 24",
		null
	);
	assert.ok(bot.capturedMessages.length > 0, "Deve responder ao comando !sa-evento");
	const respSet = bot.capturedMessages[0].content;
	assert.ok(respSet.includes("Evento ativado com sucesso"), "Mensagem deve confirmar ativação");
	assert.ok(respSet.includes("+100%"), "Mensagem deve conter +100%");
	assert.strictEqual(GameEventService.getMultiplier("pesca", "lendario"), 2.0);
	console.log("✓ !sa-evento executado com sucesso.");

	// 3.2 SuperAdmin: !sa-eventos
	bot.resetCapture();
	const msgListEventos = createMessage({
		content: "!sa-eventos",
		author: ownerJid,
		group: testGroupId
	});
	await eventHandler.commandHandler.handleCommand(bot, msgListEventos, "sa-eventos", null);
	assert.ok(bot.capturedMessages.length > 0, "Deve responder ao comando !sa-eventos");
	const respList = bot.capturedMessages[0].content;
	assert.ok(respList.includes("EVENTOS TEMPORÁRIOS ATIVOS"), "Deve listar cabeçalho de eventos");
	assert.ok(respList.toLowerCase().includes("pesca"), "Deve listar pesca");
	assert.ok(respList.toLowerCase().includes("waifu"), "Deve listar waifu");
	assert.ok(respList.toLowerCase().includes("slots"), "Deve listar slots");
	console.log("✓ !sa-eventos executado com sucesso.");

	// 3.3 Comando Público: !eventos (qualquer usuário)
	bot.resetCapture();
	const regularUserJid = "551177777777@s.whatsapp.net";
	const msgPublicEventos = createMessage({
		content: "!eventos",
		author: regularUserJid,
		group: testGroupId
	});
	await eventHandler.commandHandler.processCommand(bot, msgPublicEventos, "eventos", [], null);
	assert.ok(bot.capturedMessages.length > 0, "Deve responder ao comando !eventos");
	const respPublic = bot.capturedMessages[0].content;
	assert.ok(
		respPublic.includes("EVENTOS ESPECIAIS ATIVOS NA RAVENA"),
		"Deve conter cabeçalho público"
	);
	assert.ok(respPublic.includes("+25%"), "Deve listar evento de peso na pesca");
	assert.ok(respPublic.includes("peso"), "Deve mencionar peso");
	assert.ok(respPublic.includes("+100%"), "Deve listar evento de lendário na pesca");
	assert.ok(respPublic.includes("lendários"), "Deve mencionar lendários");
	assert.ok(respPublic.includes("+50%"), "Deve listar evento de raros em waifu");
	assert.ok(respPublic.includes("raros"), "Deve mencionar raros");
	console.log("✓ !eventos público executado com sucesso.");

	// 3.4 SuperAdmin: remoção via !sa-evento com valor 0
	bot.resetCapture();
	const msgRemoveEvento = createMessage({
		content: "!sa-evento pesca lendario 0",
		author: ownerJid,
		group: testGroupId
	});
	await eventHandler.commandHandler.handleCommand(
		bot,
		msgRemoveEvento,
		"sa-evento pesca lendario 0",
		null
	);
	assert.ok(bot.capturedMessages.length > 0);
	assert.ok(
		bot.capturedMessages[0].content.includes("encerrado"),
		"Deve confirmar encerramento do evento"
	);
	assert.strictEqual(GameEventService.getMultiplier("pesca", "lendario"), 1.0);
	console.log("✓ Remoção de evento com valor 0 executada com sucesso.");

	// 4. Teste de banner nos jogos (Slots)
	console.log("\n4. Testando banner em tempo real nos jogos (Slots)...");
	await GameEventService.setEvent("slots", "vitoria", 30, 4, "5511999999999");
	bot.resetCapture();
	const msgSlots = createMessage({
		content: "!slots",
		author: "551166666666@s.whatsapp.net",
		group: testGroupId
	});
	await eventHandler.commandHandler.processCommand(bot, msgSlots, "slots", [], null);
	assert.ok(bot.capturedMessages.length > 0, "Deve responder ao comando !slots");
	const slotsResp = bot.capturedMessages[0].content;
	assert.ok(slotsResp.includes("CAÇA-COISAS"), "Deve conter mensagem do slots");
	assert.ok(
		slotsResp.includes("Evento ativo! +30% chance de vitória no caça-coisas"),
		"Deve incluir banner do evento ativo"
	);
	console.log("✓ Banner no !slots funcionando com sucesso.");

	// Limpeza dos eventos de teste
	await GameEventService.removeEvent("pesca", "peso");
	await GameEventService.removeEvent("waifu", "raros");
	await GameEventService.removeEvent("slots", "vitoria");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
