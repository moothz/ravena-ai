const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== Testando Bypass Inicial de NSFW e Purge Pós-Envio para Stickers ===");

	const eventHandler = new EventHandler();
	const bot = new FakeBot({ id: "test-bot" });
	bot.eventHandler = eventHandler;

	// 1. Teste de detecção de comandos de sticker via isStickerMessage
	console.log("\n1. Testando isStickerMessage()...");
	const msgComandoS = createMessage({
		type: "image",
		caption: "!s",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net"
	});
	assert.strictEqual(
		eventHandler.isStickerMessage(msgComandoS, { prefix: "!" }, bot),
		true,
		"Deve identificar !s como comando de sticker"
	);

	const msgComandoSbg = createMessage({
		type: "image",
		caption: "!sbg",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net"
	});
	assert.strictEqual(
		eventHandler.isStickerMessage(msgComandoSbg, { prefix: "!" }, bot),
		true,
		"Deve identificar !sbg como comando de sticker"
	);

	const msgTextoComum = createMessage({
		type: "image",
		caption: "!ping",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net"
	});
	assert.strictEqual(
		eventHandler.isStickerMessage(msgTextoComum, { prefix: "!" }, bot),
		false,
		"Não deve identificar !ping como comando de sticker"
	);
	console.log("✓ isStickerMessage() validado com sucesso");

	// 2. Teste de registro e recuperação de stickers enviados
	console.log("\n2. Testando registerSentSticker() e getSentStickersForMessage()...");
	const testMsgId = "123456@g.us_false_MSG12345";
	eventHandler.registerSentSticker(testMsgId, {
		chatId: "123456@g.us",
		id: "STICKER_SENT_999"
	});

	const recovered = eventHandler.getSentStickersForMessage(testMsgId);
	assert.strictEqual(recovered.length, 1, "Deveria recuperar exatamente 1 sticker registrado");
	assert.strictEqual(recovered[0].id, "STICKER_SENT_999", "ID do sticker deve coincidir");

	// Busca pelo ID puro (sem sufixos/prefixos)
	const recoveredByPureId = eventHandler.getSentStickersForMessage("MSG12345");
	assert.strictEqual(recoveredByPureId.length, 1, "Deve recuperar também pelo ID puro");
	assert.strictEqual(recoveredByPureId[0].id, "STICKER_SENT_999");

	eventHandler.clearSentStickersForMessage(testMsgId);
	assert.strictEqual(
		eventHandler.getSentStickersForMessage(testMsgId).length,
		0,
		"Após limpar, não deve restar stickers"
	);
	console.log("✓ Rastreamento de stickers enviados validado com sucesso");

	// 3. Teste de applyFilters: Não deve bloquear o sticker inicial em grupo com filtro NSFW
	console.log("\n3. Testando applyFilters com bypass inicial para sticker...");
	const groupComFiltro = {
		id: "123456@g.us",
		name: "Grupo com Filtro NSFW",
		prefix: "!",
		filters: {
			nsfw: true
		}
	};

	let checkNSFWCalled = false;
	const originalCheckNSFW = eventHandler.checkNSFW;
	eventHandler.checkNSFW = async () => {
		checkNSFWCalled = true;
		return true; // Simula detecção de NSFW
	};

	let originalMsgDeleted = false;
	const msgSticker = createMessage({
		type: "image",
		caption: "!s",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		content: {
			mimetype: "image/jpeg",
			data: "dummy"
		}
	});
	msgSticker.origin.delete = async () => {
		originalMsgDeleted = true;
		return { success: true };
	};

	// Mock do envio do sticker associado
	const originalMsgId = msgSticker.origin.id._serialized;
	eventHandler.registerSentSticker(originalMsgId, {
		chatId: "123456@g.us",
		id: "STICKER_AUTORIZADO_INICIAL"
	});

	// applyFilters deve retornar FALSE imediatamente para permitir o envio do sticker!
	const filterResult = await eventHandler.applyFilters(bot, msgSticker, groupComFiltro);
	assert.strictEqual(
		filterResult,
		false,
		"applyFilters deve retornar false imediatamente para comandos de sticker"
	);
	console.log("✓ applyFilters não bloqueou o comando de sticker (bypass inicial confirmado)");

	// Aguarda a execução assíncrona pós-envio do schedulePostStickerNSFWCheck
	console.log("\n4. Aguardando purga assíncrona pós-envio de NSFW...");
	await new Promise((resolve) => setTimeout(resolve, 2000));

	assert.strictEqual(originalMsgDeleted, true, "Mensagem original do usuário deve ser deletada");
	assert.strictEqual(
		bot.deletedMessages.some((m) => m.id === "STICKER_AUTORIZADO_INICIAL"),
		true,
		"Sticker enviado pelo bot deve ser deletado após detecção de NSFW"
	);
	console.log("✓ Mensagem original e sticker enviado foram purgados com sucesso!");

	// Restaura método
	eventHandler.checkNSFW = originalCheckNSFW;

	console.log("\n=== TODOS OS TESTES DE PURGE DE STICKER NSFW PASSARAM! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Erro no teste:", err);
	process.exit(1);
});
