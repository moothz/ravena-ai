process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.WAIFULETES_WEB_URL = "https://waifuletes.moothz.com";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const ReactionsHandler = require("../ReactionsHandler");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");

// Mock rápido do download de imagem para não depender de download de imagem pesada da internet
const originalDownload = WaifuCommands.downloadImageAsBase64;
WaifuCommands.downloadImageAsBase64 = async (url) => {
	if (!url) return null;
	return Buffer.from("fake-image-base64").toString("base64");
};

async function runTests() {
	console.log("=== INICIANDO TESTES DE !mu-char (Busca e Reações) ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	bot.eventHandler = eventHandler;

	const reactionsHandler = new ReactionsHandler();
	await reactionsHandler.loadCommands();

	async function waitForCaptured(targetCount, maxMs = 5000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length >= targetCount) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 50));
		}
		return bot.capturedMessages;
	}

	// [Teste 1] Teste de getSlotNumberFromEmoji (1 a 10)
	console.log("\n[Teste 1] Validando getSlotNumberFromEmoji para 1 a 10...");
	assert.strictEqual(WaifuCommands.getSlotNumberFromEmoji("1️⃣"), 1);
	assert.strictEqual(WaifuCommands.getSlotNumberFromEmoji("5️⃣"), 5);
	assert.strictEqual(WaifuCommands.getSlotNumberFromEmoji("9️⃣"), 9);
	assert.strictEqual(WaifuCommands.getSlotNumberFromEmoji("🔟"), 10);
	assert.strictEqual(WaifuCommands.getSlotNumberFromEmoji("10"), 10);
	assert.strictEqual(WaifuCommands.getSlotNumberFromEmoji("❌"), null);
	console.log("✓ getSlotNumberFromEmoji validado com sucesso.");

	// [Teste 2] Teste de extractCharSearchResultsFromText
	console.log("\n[Teste 2] Validando extração de slots e IDs do texto de busca...");
	const sampleText = `👤 *Beowulf* (SkullGirls)
⭐ Raridade: ⭐ *Lendário*
...
---------
Outros resultados da busca:
1. 🔮 Beowulf - Sexy (beowulf-sexy)
https://waifuletes.moothz.com/character/beowulf-sexy

2. 🔮 Beowulf - 2nd Encore (beowulf-2nd-encore)
https://waifuletes.moothz.com/character/beowulf-2nd-encore

10. ⚪ Amelia Beowulf (amelia-beowulf)
https://waifuletes.moothz.com/character/amelia-beowulf

💡 _Reaja com o número (1 a 10) para ver outro da lista._`;

	const extracted = WaifuCommands.extractCharSearchResultsFromText(sampleText);
	assert.ok(extracted, "Deveria extrair resultados do texto");
	assert.strictEqual(extracted.characters.length, 3);
	assert.strictEqual(extracted.characters[0].slot, 1);
	assert.strictEqual(extracted.characters[0].id, "beowulf-sexy");
	assert.strictEqual(extracted.characters[1].slot, 2);
	assert.strictEqual(extracted.characters[1].id, "beowulf-2nd-encore");
	assert.strictEqual(extracted.characters[2].slot, 10);
	assert.strictEqual(extracted.characters[2].id, "amelia-beowulf");
	console.log("✓ extractCharSearchResultsFromText validado com sucesso.");

	function getCapturedText(msg) {
		if (!msg) return "";
		return (
			msg.options?.caption ||
			msg.caption ||
			(typeof msg.content === "string" ? msg.content : "") ||
			""
		);
	}

	// [Teste 3] Busca de !mu-char beowulf 2nd encore (deve retornar o mítico)
	console.log("\n[Teste 3] Executando !mu-char beowulf 2nd encore...");
	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const msgBeoEncore = createMessage({
		content: "!mu-char beowulf 2nd encore",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net"
	});
	await eventHandler.processMessage(bot, msgBeoEncore);
	await waitForCaptured(1);

	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-char");
	const responseText = getCapturedText(bot.capturedMessages[0]);

	console.log("Resposta obtida (preview):", responseText.slice(0, 150));
	assert.ok(
		responseText.toLowerCase().includes("beowulf - 2nd encore") ||
			responseText.toLowerCase().includes("beowulf"),
		`Deveria encontrar Beowulf - 2nd Encore. Resposta: ${responseText}`
	);
	assert.ok(
		responseText.includes("beowulf-2nd-encore"),
		`Deveria conter ID beowulf-2nd-encore. Resposta: ${responseText}`
	);
	console.log("✓ !mu-char beowulf 2nd encore encontrou o personagem mítico!");

	// [Teste 4] Busca ampla com múltiplos resultados e divisor formatado
	console.log(
		"\n[Teste 4] Executando !mu-char beowulf e verificando divisor e outros resultados..."
	);
	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const msgBeowulf = createMessage({
		content: "!mu-char beowulf",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net"
	});
	await eventHandler.processMessage(bot, msgBeowulf);
	await waitForCaptured(1);

	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-char");
	const captured = bot.capturedMessages[0];
	const msgText = getCapturedText(captured);

	assert.ok(
		msgText.includes("---------\nOutros resultados da busca:"),
		`Deveria conter o cabeçalho divisor. Texto: ${msgText}`
	);
	assert.ok(
		msgText.includes("1. ") && msgText.includes("https://waifuletes.moothz.com/character/"),
		`Deveria conter a lista numerada com links. Texto: ${msgText}`
	);
	assert.ok(
		captured.options?.waifuCharSearch,
		"Deveria anexar waifuCharSearch nas options da mensagem enviada"
	);
	console.log("✓ Divisor e lista de outros resultados formatados perfeitamente!");

	// [Teste 5] Reação numérica (ex: 2️⃣) para navegar para outro personagem da lista
	console.log("\n[Teste 5] Simulando reação 2️⃣ para navegar para o resultado 2...");
	const fakeMsgId = captured.fakeId || "MSG_TEST_CHAR_SEARCH";
	const searchOpts = captured.options.waifuCharSearch;
	assert.ok(searchOpts.characters.length >= 2, "Deveria haver pelo menos 2 outros resultados");
	const expectedTargetId = searchOpts.characters[1].id;
	console.log(`Slot 2 mapeado para ID: ${expectedTargetId}`);

	// Registra no cache de buscas
	WaifuCommands.recordCharSearchMessage(fakeMsgId, searchOpts);

	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const reactMsg = {
		reaction: "2️⃣",
		msgId: fakeMsgId,
		chatId: "123456@g.us",
		senderId: "5511999999999@s.whatsapp.net",
		targetFromMe: true
	};

	const handled = await reactionsHandler.processReaction(bot, reactMsg);
	assert.strictEqual(handled, true, "ReactionsHandler deveria processar a reação");
	assert.ok(bot.capturedMessages.length > 0, "Deveria ter enviado nova mensagem de detalhes");

	const newMsgText = getCapturedText(bot.capturedMessages[0]);
	console.log("Nova mensagem exibida (preview):", newMsgText.slice(0, 150));
	assert.ok(
		newMsgText.includes(expectedTargetId),
		`Nova mensagem deveria exibir o personagem com ID ${expectedTargetId}. Texto: ${newMsgText}`
	);
	console.log("✓ Reação 2️⃣ navegou para o personagem correspondente com sucesso!");

	// [Teste 6] Reação numérica em mensagem reconstruída APENAS do texto (sem cache em memória)
	console.log("\n[Teste 6] Validando reação via fallback puro de texto (sem cache em memória)...");
	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const fallbackReactMsg = {
		reaction: "1️⃣",
		msgId: "MSG_UNKNOWN_CACHE_ID",
		chatId: "123456@g.us",
		senderId: "5511999999999@s.whatsapp.net",
		targetFromMe: true
	};

	// Mock do getMessageById para retornar a mensagem sintética com o texto formatado
	bot.client.getMessageById = async () => ({
		id: { _serialized: "MSG_UNKNOWN_CACHE_ID" },
		caption: sampleText,
		fromMe: true
	});

	const fallbackHandled = await reactionsHandler.processReaction(bot, fallbackReactMsg);
	assert.strictEqual(fallbackHandled, true, "Fallback de texto deveria tratar a reação 1️⃣");
	assert.ok(bot.capturedMessages.length > 0, "Deveria ter enviado detalhes do slot 1");

	const fallbackResultText = getCapturedText(bot.capturedMessages[0]);
	assert.ok(
		fallbackResultText.includes("beowulf-sexy"),
		`Deveria exibir beowulf-sexy via fallback de texto. Texto: ${fallbackResultText}`
	);
	console.log("✓ Fallback puro de texto funcionou perfeitamente!");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => {
		WaifuCommands.downloadImageAsBase64 = originalDownload;
		process.exit(0);
	})
	.catch((err) => {
		WaifuCommands.downloadImageAsBase64 = originalDownload;
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
