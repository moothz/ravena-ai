const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const waifuModule = require("../functions/WaifuCommands");

async function runTests() {
	console.log("=== Iniciando Testes de WaifuCommands ===");

	// 1. Validar comandos exportados
	console.log(`[Teste 1] Validando exportação de comandos...`);
	assert.ok(Array.isArray(waifuModule.commands), "commands deve ser um array");
	assert.ok(
		waifuModule.commands.length >= 40,
		`Esperado >= 40 comandos/aliases, recebido: ${waifuModule.commands.length}`
	);

	// Verificar se os comandos essenciais estão presentes
	const cmdNames = new Set(waifuModule.commands.map((c) => c.name));
	const requiredCommands = [
		"mu-roll",
		"mu-r",
		"mu-w",
		"mu-rollm",
		"mu-rollf",
		"mu-casar",
		"mu-claim",
		"mu-c",
		"mu-divorciar",
		"mu-div",
		"mu-like",
		"mu-diario",
		"mu-daily",
		"mu-dk",
		"mu-saldo",
		"mu-k",
		"mu-harem",
		"mu-h",
		"mu-perfil",
		"mu-p",
		"mu-wishlist",
		"mu-wl",
		"mu-desejar",
		"mu-wish",
		"mu-removerdesejo",
		"mu-rmwish",
		"mu-favorito",
		"mu-fav",
		"mu-soulmates",
		"mu-sm",
		"mu-ranking",
		"mu-top",
		"mu-topchars",
		"mu-personagens",
		"mu-chars",
		"mu-char",
		"mu-info",
		"mu-cooldowns",
		"mu-cd"
	];

	for (const req of requiredCommands) {
		assert.ok(cmdNames.has(req), `Comando/alias obrigatório ausente: ${req}`);
	}
	console.log(
		`✓ Todos os ${requiredCommands.length} comandos e aliases principais foram encontrados com sucesso.`
	);

	// 2. Setup do bot de teste
	const bot = new FakeBot({ id: "test-waifu-bot", grupoLogs: "120363000000000000@g.us" });
	const eventHandler = new EventHandler();

	// Garantir que os comandos fixos foram carregados
	console.log("Aguardando carregamento de comandos fixos...");
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	console.log(
		`Comandos carregados: ${eventHandler.commandHandler.fixedCommands.getAllCommands().length}`
	);

	const testUser = "5511999990001@s.whatsapp.net";
	const testGroup = "120363999999999999@g.us";

	async function waitForReply(maxMs = 5000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length > 0) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 100));
		}
		return bot.capturedMessages;
	}

	// 3. Testar busca de personagens (!mu-personagens)
	console.log(`[Teste 2] Executando !mu-personagens Frieren...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgBusca = createMessage({
		content: "!mu-personagens Frieren",
		author: testUser,
		authorName: "TestPlayer",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgBusca);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-personagens");
	console.log(
		`✓ Resposta de busca recebida: ${bot.capturedMessages[0]?.content?.substring(0, 50)}...`
	);

	// 4. Testar detalhes de personagem (!mu-char)
	console.log(`[Teste 3] Executando !mu-char 0-08-lord-of-mysteries...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgChar = createMessage({
		content: "!mu-char 0-08-lord-of-mysteries",
		author: testUser,
		authorName: "TestPlayer",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgChar);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-char");
	console.log(`✓ Resposta de char recebida.`);

	// 5. Testar consulta de saldo (!mu-saldo)
	console.log(`[Teste 4] Executando !mu-saldo...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgSaldo = createMessage({
		content: "!mu-saldo",
		author: testUser,
		authorName: "TestPlayer",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgSaldo);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-saldo");
	console.log(`✓ Resposta de saldo: ${bot.capturedMessages[0]?.content}`);

	// 6. Testar harém (!mu-harem)
	console.log(`[Teste 5] Executando !mu-harem...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgHarem = createMessage({
		content: "!mu-harem",
		author: testUser,
		authorName: "TestPlayer",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgHarem);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-harem");
	console.log(`✓ Resposta de harém: ${bot.capturedMessages[0]?.content?.substring(0, 50)}...`);

	// 7. Testar ranking de Zinthos (!mu-ranking)
	console.log(`[Teste 6] Executando !mu-ranking...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgRanking = createMessage({
		content: "!mu-ranking",
		author: testUser,
		authorName: "TestPlayer",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgRanking);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-ranking");
	console.log(`✓ Resposta de ranking recebida.`);

	// 8. Testar ranking de personagens populares (!mu-topchars)
	console.log(`[Teste 7] Executando !mu-topchars...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgTop = createMessage({
		content: "!mu-topchars",
		author: testUser,
		authorName: "TestPlayer",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgTop);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-topchars");
	console.log(`✓ Resposta de top characters recebida.`);

	// 9. Testar cooldowns (!mu-cooldowns)
	console.log(`[Teste 8] Executando !mu-cooldowns...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgCd = createMessage({
		content: "!mu-cooldowns",
		author: testUser,
		authorName: "TestPlayer",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgCd);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-cooldowns");
	console.log(`✓ Resposta de cooldowns: ${bot.capturedMessages[0]?.content?.substring(0, 60)}...`);

	// 10. Testar Wishlist (!mu-wishlist, !mu-desejar, !mu-removerdesejo)
	console.log(`[Teste 9] Executando fluxo de Wishlist...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgAddWish = createMessage({
		content: "!mu-desejar 0-08-lord-of-mysteries",
		author: testUser,
		authorName: "TestPlayer",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgAddWish);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-desejar");

	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgRmWish = createMessage({
		content: "!mu-removerdesejo 0-08-lord-of-mysteries",
		author: testUser,
		authorName: "TestPlayer",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgRmWish);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-removerdesejo");
	console.log(`✓ Fluxo de Wishlist passou.`);

	// 11. Testar Roll de personagem (!mu-roll)
	console.log(`[Teste 10] Executando !mu-roll...`);
	const rollUser = `551177777${Date.now().toString().slice(-4)}@s.whatsapp.net`;
	const rollGroup = `120363${Date.now().toString().slice(-8)}@g.us`;

	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgRoll = createMessage({
		content: "!mu-roll",
		author: rollUser,
		authorName: "RollTester",
		group: rollGroup
	});
	await eventHandler.processMessage(bot, msgRoll);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-roll");
	console.log(`✓ Resposta de roll recebida (com mídia ou texto).`);

	// 12. Testar Casamento com o personagem rolado (!mu-casar)
	console.log(`[Teste 11] Executando !mu-casar pós-roll...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgCasar = createMessage({
		content: "!mu-casar",
		author: rollUser,
		authorName: "RollTester",
		group: rollGroup
	});
	await eventHandler.processMessage(bot, msgCasar);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-casar");
	console.log(`✓ Resposta de casamento: ${bot.capturedMessages[0]?.content?.substring(0, 60)}...`);

	// 13. Testar Diário de Zinthos (!mu-diario)
	console.log(`[Teste 12] Executando !mu-diario...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgDaily = createMessage({
		content: "!mu-diario",
		author: rollUser,
		authorName: "RollTester",
		group: rollGroup
	});
	await eventHandler.processMessage(bot, msgDaily);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-diario");
	console.log(`✓ Resposta de diário: ${bot.capturedMessages[0]?.content?.substring(0, 60)}...`);

	// 14. Testar Saldo de Zinthos (!mu-zinthos)
	console.log(`[Teste 13] Executando !mu-zinthos...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgZinthos = createMessage({
		content: "!mu-zinthos",
		author: rollUser,
		authorName: "RollTester",
		group: rollGroup
	});
	await eventHandler.processMessage(bot, msgZinthos);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-zinthos");
	assert.ok(
		bot.capturedMessages[0]?.content?.includes("Zinthos"),
		"Mensagem de saldo deve conter Zinthos"
	);
	console.log(
		`✓ Resposta de saldo Zinthos: ${bot.capturedMessages[0]?.content?.substring(0, 60)}...`
	);

	// 15. Testar Guia Completo do Jogo (!waifus / !munae)
	console.log(`[Teste 14] Executando !waifus (guia explicativo e lista de comandos)...`);
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgGuia = createMessage({
		content: "!waifus",
		author: testUser,
		authorName: "TestPlayer",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgGuia);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !waifus");
	assert.ok(
		bot.capturedMessages[0]?.content?.includes("Clone Não-Oficial do Mudae"),
		"Mensagem deve conter aviso de clone não-oficial do Mudae"
	);
	assert.ok(
		bot.capturedMessages[0]?.content?.includes("!mu-roll"),
		"Mensagem deve listar os comandos principais"
	);
	console.log(`✓ Resposta do guia !waifus validada com sucesso.`);

	console.log("=== Todos os testes de WaifuCommands foram concluídos com SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes de WaifuCommands:", err);
	process.exit(1);
});
