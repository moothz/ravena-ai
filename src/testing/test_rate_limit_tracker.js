/**
 * test_rate_limit_tracker.js
 * Suíte de testes unitários para RateLimitTracker e integração com WhatsgoClient.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.DEBUG_RATE_LIMIT = "true";

const RateLimitTracker = require("../services/RateLimitTracker");
const WhatsgoClient = require("../services/WhatsgoClient");

async function runTests() {
	console.log("--- Iniciando testes do RateLimitTracker ---");

	// 1. Teste de detecção de erros de rate limit
	console.log("1. Testando RateLimitTracker.checkRateLimit...");
	assert.strictEqual(
		RateLimitTracker.checkRateLimit(429, {}).isRateLimit,
		true,
		"Status 429 deve ser identificado como rate limit"
	);
	assert.strictEqual(RateLimitTracker.checkRateLimit(429, {}).type, "HTTP_429");

	assert.strictEqual(
		RateLimitTracker.checkRateLimit(500, {
			error: "failed to get group members: info query returned status 429: rate-overlimit"
		}).isRateLimit,
		true,
		"Mensagem com rate-overlimit deve ser identificada"
	);
	assert.strictEqual(
		RateLimitTracker.checkRateLimit(500, {
			error: "failed to get group members: info query returned status 429: rate-overlimit"
		}).type,
		"RATE_OVERLIMIT"
	);

	assert.strictEqual(
		RateLimitTracker.checkRateLimit(500, { error: "info query timed out" }).isRateLimit,
		true,
		"Mensagem com timeout de query deve ser identificada"
	);
	assert.strictEqual(
		RateLimitTracker.checkRateLimit(500, { error: "info query timed out" }).type,
		"INFO_TIMEOUT"
	);

	assert.strictEqual(
		RateLimitTracker.checkRateLimit(500, { error: "database locked" }).isRateLimit,
		false,
		"Erro comum de banco não deve ser rate limit"
	);
	assert.strictEqual(
		RateLimitTracker.checkRateLimit(404, { message: "not found" }).isRateLimit,
		false,
		"404 não deve ser rate limit"
	);
	console.log("✓ RateLimitTracker.checkRateLimit passou com sucesso");

	// 2. Teste de parsing de stack trace
	console.log("2. Testando RateLimitTracker.parseStack...");
	const fakeStack = `Error
    at WhatsgoClient.post (/app/src/services/WhatsgoClient.js:98:21)
    at WhatsAppBotGo.getChatDetails (/app/src/WhatsAppBotGo.js:3221:38)
    at AdminUtils.isAdmin (/app/src/utils/AdminUtils.js:84:15)
    at EventHandler.processMessage (/app/src/EventHandler.js:210:10)`;

	const parsed = RateLimitTracker.parseStack(fakeStack);
	assert.strictEqual(
		parsed.caller_function,
		"WhatsAppBotGo.getChatDetails",
		"Deve extrair função chamadora correta"
	);
	assert.strictEqual(
		parsed.caller_file,
		"src/WhatsAppBotGo.js:3221:38",
		"Deve extrair arquivo chamador correto"
	);
	assert.ok(
		parsed.call_chain.includes("AdminUtils.js:84:15"),
		"Cadeia de chamada deve conter frame intermediário"
	);
	console.log("✓ RateLimitTracker.parseStack passou com sucesso");

	// 3. Teste de gravação e consulta no SQLite
	console.log("3. Testando gravação e consulta no SQLite...");
	const tracker = RateLimitTracker.getInstance();
	assert.strictEqual(tracker.isEnabled(), true, "Tracker deve estar habilitado");

	// Limpa dados prévios para teste limpo
	tracker.clearData();

	// Inicia requisição e grava sucesso
	const ctxSuccess = tracker.startRequest("testbot", "POST", "/send/text", { text: "ola" });
	assert.ok(ctxSuccess, "Contexto de requisição deve ser gerado");
	tracker.recordSuccess(ctxSuccess);

	// Inicia requisição e grava rate limit
	const ctxFail = tracker.startRequest("testbot", "POST", "/group/info", { groupJid: "123@g.us" });
	const error429 = {
		response: {
			status: 500,
			data: { error: "failed to get group members: info query returned status 429: rate-overlimit" }
		}
	};
	const recordedEvent = tracker.recordRateLimit(ctxFail, error429, { groupJid: "123@g.us" });

	assert.ok(recordedEvent, "Evento de rate limit deve ser gravado e retornado");
	assert.strictEqual(recordedEvent.botName, "testbot");
	assert.strictEqual(recordedEvent.endpoint, "/group/info");
	assert.strictEqual(recordedEvent.errorType, "RATE_OVERLIMIT");

	// Consulta sumário
	const summary = tracker.getSummary({ limit: 5 });
	assert.strictEqual(summary.totalEvents, 1, "Deve contabilizar 1 evento total");
	assert.strictEqual(summary.last1h, 1, "Deve contabilizar 1 evento na última hora");
	assert.strictEqual(summary.byEndpoint.length, 1, "Deve listar 1 endpoint ofensor");
	assert.strictEqual(summary.byEndpoint[0].endpoint, "/group/info");
	assert.strictEqual(summary.byBot[0].bot_name, "testbot");

	// Consulta eventos recentes com filtro
	const filtered = tracker.getRecentEvents(10, { endpoint: "/group/info" });
	assert.strictEqual(filtered.length, 1);
	assert.strictEqual(filtered[0].endpoint, "/group/info");

	console.log("✓ Gravação e consulta no SQLite passaram com sucesso");

	// 4. Teste de integração com WhatsgoClient
	console.log("4. Testando integração com WhatsgoClient...");
	const client = new WhatsgoClient("http://localhost:8080", "fake-api-key", "test-instance");

	let caught = false;
	try {
		client._handleError(
			{
				response: {
					status: 429,
					data: { message: "Too many requests to WhatsApp servers" }
				}
			},
			"POST /message/react",
			{ reaction: "🎲" }
		);
	} catch (e) {
		caught = true;
	}

	assert.strictEqual(caught, true, "_handleError deve lançar o erro original");

	const summaryAfterClient = tracker.getSummary();
	assert.strictEqual(
		summaryAfterClient.totalEvents,
		2,
		"Deve ter 2 eventos após chamada do client"
	);
	console.log("✓ Integração com WhatsgoClient passou com sucesso");

	console.log("\n🎉 Todos os testes de RateLimitTracker passaram com sucesso!");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes:", err);
		process.exit(1);
	});
