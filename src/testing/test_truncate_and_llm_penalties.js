process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const FakeBot = require("./FakeBot");
const TelegramBot = require("../TelegramBot");
const ReturnMessage = require("../models/ReturnMessage");
const LLMService = require("../services/LLMService");

async function main() {
	console.log("=== INICIANDO TESTES DE TRUNCAMENTO E PARÂMETROS LLM ===");

	// ---------------------------------------------------------------------------
	// 1. Testes de truncateText no WhatsAppBotGo
	// ---------------------------------------------------------------------------
	console.log("\n[1] Testando truncateText no WhatsAppBotGo...");
	const bot = new WhatsAppBotGo({
		id: "teste-bot",
		whatsgoApiUrl: "http://localhost:3000",
		whatsgoApiKey: "test-key",
		instanceName: "test-inst",
		webhookHost: "http://localhost:3000"
	});

	// 1.1 Texto curto (não deve ser modificado)
	const shortText = "Mensagem normal e curta dentro dos limites.";
	assert.strictEqual(
		bot.truncateText(shortText, 3000, 200),
		shortText,
		"Texto curto não deveria ser modificado"
	);

	// 1.2 Limite de repetições consecutivas do mesmo caractere (máx 15)
	const repeat24 = "KKKKKKKKKKKKKKKKKKKKKKKK"; // 24 K's
	const expected15 = "KKKKKKKKKKKKKKK"; // 15 K's
	assert.strictEqual(
		bot.truncateText(repeat24),
		expected15,
		"24 'K's seguidos deve ser reduzido para exatamente 15 'K's"
	);
	assert.strictEqual(
		bot.truncateText("K".repeat(15)),
		"K".repeat(15),
		"15 'K's seguidos deve ser mantido intacto"
	);
	assert.strictEqual(
		bot.truncateText("K".repeat(14)),
		"K".repeat(14),
		"14 'K's seguidos deve ser mantido intacto"
	);
	assert.strictEqual(
		bot.truncateText("K".repeat(3000)),
		"K".repeat(15),
		"3000 'K's seguidos deve ser reduzido para 15 'K's"
	);
	assert.strictEqual(
		bot.truncateText("olá " + "-".repeat(40) + " teste"),
		"olá " + "-".repeat(15) + " teste",
		"Traços repetidos devem ser limitados a 15"
	);

	// 1.3 Limite de caracteres (> 3000 caracteres sem repetições simples)
	const longCharsText = "ABCDEFGHIJ ".repeat(350);
	const truncatedChars = bot.truncateText(longCharsText, 3000, 200);
	assert(
		truncatedChars.length <= 3000,
		`Texto truncado por caracteres deve ter <= 3000 chars, obteve ${truncatedChars.length}`
	);
	assert(
		truncatedChars.endsWith("\n... [truncado]"),
		"Texto truncado deve terminar com o indicador [truncado]"
	);
	assert(
		truncatedChars.startsWith("ABCDEFGHIJ"),
		"Texto truncado deve começar com o conteúdo original"
	);

	// 1.3 Limite de linhas (> 200 linhas)
	const linesArray = [];
	for (let i = 1; i <= 250; i++) {
		linesArray.push(`- São Francisco ${i}`);
	}
	const longLinesText = linesArray.join("\n");
	const truncatedLines = bot.truncateText(longLinesText, 3000, 200);
	const lineCount = truncatedLines.split("\n").length;
	assert(lineCount <= 200, `Texto truncado por linhas deve ter <= 200 linhas, obteve ${lineCount}`);
	assert(
		truncatedLines.length <= 3000,
		`Texto truncado também deve respeitar 3000 caracteres, obteve ${truncatedLines.length}`
	);
	assert(
		truncatedLines.endsWith("... [truncado]"),
		"Texto truncado por linhas deve conter indicador [truncado]"
	);

	// 1.4 Limite combinado (> 200 linhas E > 3000 caracteres)
	const hugeArray = [];
	for (let i = 1; i <= 300; i++) {
		hugeArray.push(`Linha longa com bastante texto repetitivo número ${i} de 300`);
	}
	const hugeText = hugeArray.join("\n");
	const truncatedHuge = bot.truncateText(hugeText, 3000, 200);
	assert(
		truncatedHuge.length <= 3000,
		`Texto combinado deve ter <= 3000 chars, obteve ${truncatedHuge.length}`
	);
	assert(
		truncatedHuge.split("\n").length <= 200,
		`Texto combinado deve ter <= 200 linhas, obteve ${truncatedHuge.split("\n").length}`
	);
	assert(truncatedHuge.endsWith("... [truncado]"));

	// 1.5 Casos nulos e tipos inválidos
	assert.strictEqual(bot.truncateText(null), null);
	assert.strictEqual(bot.truncateText(undefined), undefined);
	assert.strictEqual(bot.truncateText(""), "");
	assert.strictEqual(bot.truncateText(123), 123);

	console.log("✓ WhatsAppBotGo.truncateText passou em todas as asserções.");

	// ---------------------------------------------------------------------------
	// 2. Testes de sendMessage no WhatsAppBotGo (garantia antes do post)
	// ---------------------------------------------------------------------------
	console.log("\n[2] Testando sendMessage intercepting payload.text e caption...");
	let postedPayload = null;
	bot.isConnected = true;
	bot.apiClient = {
		post: async (endpoint, payload) => {
			postedPayload = payload;
			return { data: { Info: { ID: "test-id" } } };
		}
	};
	bot.loadReport = { trackSentMessage: () => {} };

	// 2.1 Envio de repetição excessiva de caracteres via sendMessage
	await bot.sendMessage("5511999999999@s.whatsapp.net", "K".repeat(4000));
	assert(postedPayload !== null, "apiClient.post deve ter sido chamado");
	assert.strictEqual(
		postedPayload.text,
		"K".repeat(15),
		"Repetição de 4000 'K's deve virar 15 'K's"
	);

	// 2.2 Envio de texto longo variado (> 3000 caracteres)
	postedPayload = null;
	await bot.sendMessage("5511999999999@s.whatsapp.net", "ABCDEFGHIJ ".repeat(350));
	assert(
		postedPayload.text.length <= 3000,
		`payload.text deve ter <= 3000 caracteres, obteve ${postedPayload.text.length}`
	);
	assert(postedPayload.text.endsWith("... [truncado]"));

	// 2.3 Envio de mídia com caption longa
	postedPayload = null;
	await bot.sendMessage(
		"5511999999999@s.whatsapp.net",
		{ isMessageMedia: true, url: "https://example.com/image.jpg", mimetype: "image/jpeg" },
		{ caption: "Legenda: " + "ABCDEFGHIJ ".repeat(350) }
	);
	assert(
		postedPayload.caption.length <= 3000,
		`payload.caption deve ter <= 3000 caracteres, obteve ${postedPayload.caption.length}`
	);
	assert(postedPayload.caption.endsWith("... [truncado]"));

	console.log("✓ WhatsAppBotGo.sendMessage limitou payload.text e payload.caption corretamente.");

	// ---------------------------------------------------------------------------
	// 3. Testes no FakeBot
	// ---------------------------------------------------------------------------
	console.log("\n[3] Testando FakeBot.sendReturnMessages e FakeBot.sendMessage...");
	const fakeBot = new FakeBot({ id: "fake-test" });

	const retMsg = new ReturnMessage({
		chatId: "123@g.us",
		content: "ABCDEFGHIJ ".repeat(350)
	});
	await fakeBot.sendReturnMessages(retMsg);
	assert.strictEqual(fakeBot.capturedMessages.length, 1);
	assert(
		fakeBot.capturedMessages[0].content.length <= 3000,
		"FakeBot deve truncar content para <= 3000 caracteres"
	);
	assert(fakeBot.capturedMessages[0].content.endsWith("... [truncado]"));

	const repMsg = new ReturnMessage({
		chatId: "123@g.us",
		content: "KKKKKKKKKKKKKKKKKKKKKKKK"
	});
	await fakeBot.sendReturnMessages(repMsg);
	assert.strictEqual(
		fakeBot.capturedMessages[1].content,
		"KKKKKKKKKKKKKKK",
		"FakeBot deve limitar repetições para 15"
	);

	console.log("✓ FakeBot truncou mensagens capturadas com sucesso.");

	// ---------------------------------------------------------------------------
	// 4. Testes no TelegramBot
	// ---------------------------------------------------------------------------
	console.log("\n[4] Testando TelegramBot.truncateText...");
	const tgBot = new TelegramBot({ id: "tg-test", telegramBotToken: "123:dummy" });
	const tgRep = tgBot.truncateText("KKKKKKKKKKKKKKKKKKKKKKKK");
	assert.strictEqual(tgRep, "KKKKKKKKKKKKKKK", "TelegramBot deve limitar repetições para 15");
	const tgTruncated = tgBot.truncateText("ABCDEFGHIJ ".repeat(350));
	assert(tgTruncated.length <= 3000);
	assert(tgTruncated.endsWith("... [truncado]"));
	console.log("✓ TelegramBot.truncateText passou com sucesso.");

	// ---------------------------------------------------------------------------
	// 5. Testes no LLMService (parâmetros anti-loop carregados do config)
	// ---------------------------------------------------------------------------
	console.log("\n[5] Testando LLMService carregando parâmetros de anti-loop...");
	const llmService = LLMService.getInstance();
	llmService.buildProviders();

	// Procura o provider hyperion-vllm-gemma12
	const vllmProvider = llmService.providerDefinitions.find(
		(p) => p.name === "hyperion-vllm-gemma12"
	);
	assert(vllmProvider, "Provedor hyperion-vllm-gemma12 deve estar configurado");

	// Testa se options repassa os parâmetros para a chamada
	let capturedPayload = null;
	const originalOpenaiCompletion = llmService.openaiCompletion;
	llmService.openaiCompletion = async (opts) => {
		capturedPayload = opts;
		return { choices: [{ message: { content: "OK" } }] };
	};

	try {
		await vllmProvider.method({ prompt: "teste" });
		assert(capturedPayload !== null, "openaiCompletion deve ter sido chamado");
		assert.strictEqual(
			capturedPayload.repetition_penalty,
			1.15,
			"repetition_penalty deve ser 1.15"
		);
		assert.strictEqual(capturedPayload.frequency_penalty, 0.2, "frequency_penalty deve ser 0.2");
		assert.strictEqual(capturedPayload.presence_penalty, 0.2, "presence_penalty deve ser 0.2");
		assert.strictEqual(capturedPayload.maxTokens, 2000, "maxTokens deve ser 2000");
		console.log(
			"✓ LLMService repassou repetition_penalty, frequency_penalty, presence_penalty e maxTokens!"
		);
	} finally {
		llmService.openaiCompletion = originalOpenaiCompletion;
	}

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
