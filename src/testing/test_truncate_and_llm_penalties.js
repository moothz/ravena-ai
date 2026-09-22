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

	// 1.3 Suporte ao novo padrão de 15000 caracteres (comandos longos como !news e !waifus)
	const long3850Text = "ABCDEFGHIJ ".repeat(350); // 3850 caracteres
	const notTruncatedDefault = bot.truncateText(long3850Text);
	assert.strictEqual(
		notTruncatedDefault,
		long3850Text,
		"Texto de 3850 caracteres (ex: !news, !waifus) não deve ser truncado com o default de 15000 caracteres"
	);

	// 1.4 Limite explícito de caracteres para LLM (maxChars = 3000)
	const truncatedChars = bot.truncateText(long3850Text, 3000, 200);
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

	// 1.5 Limite do wrapper atingido com texto gigantesco (> 15000 caracteres)
	const huge16kText = "ABCDEFGHIJ ".repeat(1500); // 16500 caracteres
	const truncated15k = bot.truncateText(huge16kText);
	assert(
		truncated15k.length <= 15000,
		`Texto acima de 15000 caracteres deve ser truncado pelo wrapper, obteve ${truncated15k.length}`
	);
	assert(truncated15k.endsWith("\n... [truncado]"));

	// 1.6 Limite de linhas (> 200 linhas)
	const linesArray = [];
	for (let i = 1; i <= 250; i++) {
		linesArray.push(`- São Francisco ${i}`);
	}
	const longLinesText = linesArray.join("\n");
	const truncatedLines = bot.truncateText(longLinesText);
	const lineCount = truncatedLines.split("\n").length;
	assert(lineCount <= 200, `Texto truncado por linhas deve ter <= 200 linhas, obteve ${lineCount}`);
	assert(
		truncatedLines.endsWith("... [truncado]"),
		"Texto truncado por linhas deve conter indicador [truncado]"
	);

	// 1.7 Casos nulos e tipos inválidos
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

	// 2.2 Envio de comando com texto longo variado (3850 chars) não é cortado pelo default (15000 chars)
	postedPayload = null;
	await bot.sendMessage("5511999999999@s.whatsapp.net", long3850Text);
	assert.strictEqual(
		postedPayload.text,
		long3850Text,
		"Comando longo com 3850 caracteres deve ser enviado integralmente com default de 15000 chars"
	);

	// 2.3 Envio com maxChars customizado (ex: LLM com 3000 chars)
	postedPayload = null;
	await bot.sendMessage("5511999999999@s.whatsapp.net", long3850Text, { maxChars: 3000 });
	assert(
		postedPayload.text.length <= 3000,
		`payload.text com maxChars=3000 deve ter <= 3000 caracteres, obteve ${postedPayload.text.length}`
	);
	assert(postedPayload.text.endsWith("... [truncado]"));

	// 2.4 Envio de texto superior a 15000 caracteres deve ser truncado pelo wrapper
	postedPayload = null;
	await bot.sendMessage("5511999999999@s.whatsapp.net", huge16kText);
	assert(
		postedPayload.text.length <= 15000,
		`payload.text deve respeitar limite padrão de 15000 caracteres, obteve ${postedPayload.text.length}`
	);
	assert(postedPayload.text.endsWith("... [truncado]"));

	// 2.5 Envio de mídia com caption longa (LLM maxChars: 3000)
	postedPayload = null;
	await bot.sendMessage(
		"5511999999999@s.whatsapp.net",
		{ isMessageMedia: true, url: "https://example.com/image.jpg", mimetype: "image/jpeg" },
		{ caption: "Legenda: " + long3850Text, maxChars: 3000 }
	);
	assert(
		postedPayload.caption.length <= 3000,
		`payload.caption com maxChars=3000 deve ter <= 3000 caracteres, obteve ${postedPayload.caption.length}`
	);
	assert(postedPayload.caption.endsWith("... [truncado]"));

	console.log("✓ WhatsAppBotGo.sendMessage limitou payload.text e payload.caption corretamente.");

	// ---------------------------------------------------------------------------
	// 3. Testes no FakeBot
	// ---------------------------------------------------------------------------
	console.log("\n[3] Testando FakeBot.sendReturnMessages e FakeBot.sendMessage...");
	const fakeBot = new FakeBot({ id: "fake-test" });

	// 3.1 Mensagem de comando longo (> 3000 caracteres) NÃO deve ser truncada
	const retMsgLong = new ReturnMessage({
		chatId: "123@g.us",
		content: long3850Text
	});
	await fakeBot.sendReturnMessages(retMsgLong);
	assert.strictEqual(fakeBot.capturedMessages.length, 1);
	assert.strictEqual(
		fakeBot.capturedMessages[0].content,
		long3850Text,
		"FakeBot não deve truncar mensagem de 3850 caracteres por padrão"
	);

	// 3.2 Mensagem do LLM com maxChars=3000 DEVE ser truncada
	const retMsgLLM = new ReturnMessage({
		chatId: "123@g.us",
		content: long3850Text,
		options: { maxChars: 3000 }
	});
	await fakeBot.sendReturnMessages(retMsgLLM);
	assert.strictEqual(fakeBot.capturedMessages.length, 2);
	assert(
		fakeBot.capturedMessages[1].content.length <= 3000,
		"FakeBot deve truncar mensagem do LLM com maxChars=3000"
	);
	assert(fakeBot.capturedMessages[1].content.endsWith("... [truncado]"));

	const repMsg = new ReturnMessage({
		chatId: "123@g.us",
		content: "KKKKKKKKKKKKKKKKKKKKKKKK"
	});
	await fakeBot.sendReturnMessages(repMsg);
	assert.strictEqual(
		fakeBot.capturedMessages[2].content,
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

	// Default 15000 não trunca 3850 caracteres
	const tgLong = tgBot.truncateText(long3850Text);
	assert.strictEqual(tgLong, long3850Text, "TelegramBot não deve truncar 3850 chars por padrão");

	// maxChars = 3000 (LLM) trunca
	const tgTruncated = tgBot.truncateText(long3850Text, 3000);
	assert(tgTruncated.length <= 3000);
	assert(tgTruncated.endsWith("... [truncado]"));

	// Acima de 15000 trunca
	const tgHuge = tgBot.truncateText(huge16kText);
	assert(tgHuge.length <= 15000);
	assert(tgHuge.endsWith("... [truncado]"));
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

	// 5.2 Valida truncateText específico do LLMService (mantém limite de 3000 por padrão)
	assert.strictEqual(typeof llmService.truncateText, "function");
	const llmTruncated = llmService.truncateText(long3850Text);
	assert(
		llmTruncated.length <= 3000,
		`LLMService.truncateText deve limitar a 3000 chars por padrão, obteve ${llmTruncated.length}`
	);
	assert(llmTruncated.endsWith("... [truncado]"));
	console.log("✓ LLMService.truncateText limita texto do LLM em 3000 caracteres por padrão.");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
