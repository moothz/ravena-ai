process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const LLMDailyReportService = require("../services/LLMDailyReportService");

async function runTests() {
	console.log("--- Starting LLMDailyReportService tests ---");

	// 1. Instanciação e Singleton
	const reportService = new LLMDailyReportService({
		telegramToken: "fake-token",
		telegramChatId: "fake-chat-id",
		targetHour: 22,
		targetMinute: 0
	});
	assert.ok(reportService, "LLMDailyReportService deve ser instanciado");
	assert.strictEqual(reportService.targetHour, 22, "targetHour deve ser 22");
	assert.strictEqual(reportService.targetMinute, 0, "targetMinute deve ser 0");

	// 2. formatNumber
	assert.strictEqual(reportService.formatNumber(1500000), "1.5M");
	assert.strictEqual(reportService.formatNumber(25000), "25.0k");
	assert.strictEqual(reportService.formatNumber(850), "850");
	assert.strictEqual(reportService.formatNumber(0), "0");
	console.log("✓ formatNumber passou");

	// 3. buildReportMessage com dados sintéticos
	const mockData = {
		stats: {
			total_requests: 100,
			total_failures: 5,
			total_input_tokens: 150000,
			total_output_tokens: 50000,
			by_type: {
				text: { requests: 80, failures: 3 },
				image: { requests: 15, failures: 2 }
			},
			by_provider: {
				"gemini-2.5-flash": { requests: 80, failures: 3 },
				"dall-e-3": { requests: 15, failures: 2 }
			}
		},
		queueStatus: {
			"gemini-2.5-flash": { pending: 2, processing: 1, fulfilled: 77, failed: 3 }
		},
		summary: {
			totalRequests: 100,
			successfulRequests: 95,
			totalFailures: 5,
			failureRate: "5.00",
			totalInputTokens: 150000,
			totalOutputTokens: 50000,
			queuePending: 2,
			queueProcessing: 1,
			queueFulfilled: 77,
			queueFailed: 3
		}
	};

	const message = reportService.buildReportMessage(mockData);
	assert.ok(message.includes("Relatório Diário de IA"), "Deve conter título padrão");
	assert.ok(message.includes("100"), "Deve conter total de 100 requisições");
	assert.ok(message.includes("95"), "Deve conter 95 atendidas");
	assert.ok(message.includes("5.00%"), "Deve conter 5.00% de taxa de falha");
	assert.ok(message.includes("150.0k"), "Deve conter tokens de entrada formatados");
	assert.ok(message.includes("50.0k"), "Deve conter tokens de saída formatados");
	assert.ok(message.includes("gemini-2.5-flash"), "Deve conter provedor");
	assert.ok(message.includes("Status Atual da Fila"), "Deve conter status da fila");
	console.log("✓ buildReportMessage com dados sintéticos passou");

	// 4. buildReportMessage com customTitle
	const customTitleMsg = reportService.buildReportMessage(mockData, "<b>Título Customizado</b>");
	assert.ok(
		customTitleMsg.includes("Título Customizado"),
		"Deve usar customTitle quando informado"
	);
	console.log("✓ customTitle passou");

	// 5. Teste de checkSchedule e deduplicação
	let sendCalled = 0;
	reportService.sendReportNow = async () => {
		sendCalled++;
		return { success: true };
	};

	// Simula hora alvo
	reportService.targetHour = 10;
	reportService.targetMinute = 30;

	// Mock de DateTimeFormat para simular exatamente 10:30 na primeira checagem
	const originalDateTimeFormat = Intl.DateTimeFormat;
	try {
		const simulatedTime = "10:30";
		let simulatedDate = "27/09/2026";

		global.Intl.DateTimeFormat = function (locale, options) {
			return {
				format: () => {
					if (options && options.hour !== undefined) {
						return simulatedTime;
					}
					return simulatedDate;
				}
			};
		};

		// 1ª checagem às 10:30: deve disparar
		reportService.checkSchedule();
		assert.strictEqual(sendCalled, 1, "Deve disparar relatório na primeira checagem às 10:30");

		// 2ª checagem no mesmo dia e minuto: não deve disparar novamente (deduplicação)
		reportService.checkSchedule();
		assert.strictEqual(sendCalled, 1, "Não deve disparar repetidamente no mesmo dia");

		// Simula novo dia: deve poder disparar de novo
		simulatedDate = "28/09/2026";
		reportService.checkSchedule();
		assert.strictEqual(sendCalled, 2, "Deve disparar no dia seguinte");
	} finally {
		global.Intl.DateTimeFormat = originalDateTimeFormat;
	}
	console.log("✓ checkSchedule e deduplicação passaram");

	// 6. Teste de collectReportData real
	const realData = await reportService.collectReportData();
	assert.ok(realData, "collectReportData deve retornar um objeto");
	assert.ok(realData.summary, "summary deve existir no retorno");
	assert.strictEqual(typeof realData.summary.totalRequests, "number");
	console.log("✓ collectReportData real passou");

	console.log("--- All LLMDailyReportService tests passed successfully! ---");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Test failed:", err);
		process.exit(1);
	});
