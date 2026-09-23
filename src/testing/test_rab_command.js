process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");

async function main() {
	console.log("=== INICIANDO TESTE DO COMANDO !RAB ===");

	const bot = new FakeBot({ id: "test-rab", grupoLogs: "123@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	async function waitForReply(maxMs = 15000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length > 0) return;
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`Timeout de ${maxMs}ms aguardando resposta`);
	}

	// 1. Teste !rab sem argumentos
	console.log("\n1. Testando !rab sem argumentos...");
	bot.resetCapture();
	const msgSemArgs = createMessage({
		content: "!rab",
		group: "normalgroup@g.us",
		author: "5511999990001@s.whatsapp.net"
	});
	await eventHandler.processMessage(bot, msgSemArgs);
	await waitForReply();
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria ter enviado 1 mensagem");
	assert.ok(
		bot.capturedMessages[0].content.includes("forneça a matrícula"),
		"Deveria pedir para fornecer matrícula"
	);
	console.log("✓ !rab sem argumentos respondeu corretamente:", bot.capturedMessages[0].content);

	// 2. Teste !rab PSTLA
	console.log("\n2. Testando !rab PSTLA...");
	bot.resetCapture();
	const msgPstla = createMessage({
		content: "!rab PSTLA",
		group: "normalgroup@g.us",
		author: "5511999990002@s.whatsapp.net"
	});
	await eventHandler.processMessage(bot, msgPstla);
	await waitForReply();
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria ter enviado 1 mensagem");
	const contentPstla = bot.capturedMessages[0].content;
	console.log("Resposta para PSTLA:\n", contentPstla);
	assert.ok(contentPstla.includes("Consulta RAB - Matrícula PSTLA"), "Header com PSTLA");
	assert.ok(
		contentPstla.includes("TOTAL LINHAS AEREAS"),
		"Deve conter operador TOTAL LINHAS AEREAS"
	);
	assert.ok(contentPstla.includes("BOEING COMPANY"), "Deve conter BOEING COMPANY");
	assert.ok(contentPstla.includes("737-45D"), "Deve conter modelo 737-45D");
	assert.ok(contentPstla.includes("SITUAÇÃO NORMAL"), "Deve conter situação de aeronavegabilidade");
	console.log("✓ !rab PSTLA retornou todos os dados com sucesso!");

	// 3. Teste !rab PS-TLA (com hífen)
	console.log("\n3. Testando !rab PS-TLA...");
	bot.resetCapture();
	const msgPsTla = createMessage({
		content: "!rab PS-TLA",
		group: "normalgroup@g.us",
		author: "5511999990003@s.whatsapp.net"
	});
	await eventHandler.processMessage(bot, msgPsTla);
	await waitForReply();
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria ter enviado 1 mensagem");
	const contentPsTla = bot.capturedMessages[0].content;
	assert.ok(contentPsTla.includes("TOTAL LINHAS AEREAS"), "Deve conter operador");
	console.log("✓ !rab PS-TLA funcionou perfeitamente!");

	// 4. Teste !rab PT-MUA (Boeing 777 LATAM)
	console.log("\n4. Testando !rab PT-MUA...");
	bot.resetCapture();
	const msgPtMua = createMessage({
		content: "!rab PT-MUA",
		group: "normalgroup@g.us",
		author: "5511999990005@s.whatsapp.net"
	});
	await eventHandler.processMessage(bot, msgPtMua);
	await waitForReply();
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria ter enviado 1 mensagem");
	const contentPtMua = bot.capturedMessages[0].content;
	console.log("Resposta para PT-MUA:\n", contentPtMua);
	assert.ok(contentPtMua.includes("Consulta RAB - Matrícula PT-MUA"), "Header com PT-MUA");
	assert.ok(contentPtMua.includes("TAM LINHAS AÉREAS"), "Deve conter TAM LINHAS AÉREAS");
	assert.ok(contentPtMua.includes("777-32WER"), "Deve conter modelo 777-32WER");
	assert.ok(contentPtMua.includes("SITUAÇÃO NORMAL"), "Deve conter situação de aeronavegabilidade");
	console.log("✓ !rab PT-MUA retornou todos os dados com sucesso!");

	// 5. Teste !rab ZZZZZ (matrícula inexistente)
	console.log("\n5. Testando matrícula inexistente ZZZZZ...");
	bot.resetCapture();
	const msgZzzzz = createMessage({
		content: "!rab ZZZZZ",
		group: "normalgroup@g.us",
		author: "5511999990004@s.whatsapp.net"
	});
	await eventHandler.processMessage(bot, msgZzzzz);
	await waitForReply();
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria ter enviado 1 mensagem");
	const contentZzzzz = bot.capturedMessages[0].content;
	console.log("Resposta para ZZZZZ:", contentZzzzz);
	assert.ok(contentZzzzz.includes("não encontrada"), "Deveria informar que não foi encontrada");
	console.log("✓ Matrícula inexistente tratada corretamente!");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro no teste:", err);
		process.exit(1);
	});
