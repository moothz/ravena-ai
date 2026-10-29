process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const LoadReport = require("../LoadReport");

async function runTests() {
	console.log("--- Starting LoadReport Delay & Calibration tests ---");

	const bot = new FakeBot({ id: "test-bot" });
	const lr = new LoadReport(bot);
	clearInterval(lr.reportInterval);

	// 1. Mensagens com responseTime = 0 devem ser contabilizadas no cálculo da média
	lr.trackReceivedMessage(true, 0, "grupo1@g.us");
	lr.trackReceivedMessage(true, 0, "grupo1@g.us");
	lr.trackReceivedMessage(true, 1, "grupo1@g.us");

	assert.strictEqual(lr.stats.responseTimes.length, 3, "Deve registrar 3 medições de responseTime");
	assert.strictEqual(lr.stats.totalResponseTime, 1, "Soma dos tempos deve ser 1s (0 + 0 + 1)");
	assert.strictEqual(lr.stats.maxResponseTime, 1, "Tempo máximo deve ser 1s");

	const metrics = lr.getLiveMetrics();
	assert.strictEqual(metrics.responseTime.avg, 0.33, "Delay médio deve ser 0.33s (1 / 3)");
	assert.strictEqual(metrics.responseTime.max, 1, "Delay máximo deve ser 1s");
	console.log("✓ Teste 1: Medições de 0s incluídas corretamente na média");

	// 2. getLiveMetrics com todas as medições em 0s NÃO deve cair no fallback
	lr.stats.responseTimes = [0, 0, 0];
	lr.stats.totalResponseTime = 0;
	lr.stats.maxResponseTime = 0;
	lr.lastReport = {
		messages: { messagesPerHour: 50 },
		responseTime: { average: "45.00", max: 3000, count: 10 }
	};

	const zeroMetrics = lr.getLiveMetrics();
	assert.strictEqual(
		zeroMetrics.responseTime.avg,
		0,
		"Delay médio deve ser 0 quando todas as msgs são 0s (não deve cair no fallbackAvg de 45.00s)"
	);
	assert.strictEqual(
		zeroMetrics.responseTime.max,
		0,
		"Delay máximo deve ser 0 quando todas as msgs são 0s"
	);
	console.log("✓ Teste 2: getLiveMetrics não cai em fallback quando delay médio real é 0s");

	// 3. getLiveMetrics SEM medições atuais deve usar fallback do lastReport
	lr.stats.responseTimes = [];
	lr.stats.totalResponseTime = 0;
	lr.stats.maxResponseTime = 0;

	const fallbackMetrics = lr.getLiveMetrics();
	assert.strictEqual(
		fallbackMetrics.responseTime.avg,
		45,
		"Sem medições na janela atual, deve usar fallbackAvg"
	);
	assert.strictEqual(
		fallbackMetrics.responseTime.max,
		3000,
		"Sem medições na janela atual, deve usar fallbackMax"
	);
	console.log("✓ Teste 3: Fallback correto quando não há medições na janela atual");

	console.log("--- All LoadReport delay tests passed! ---");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Test failed:", err);
		process.exit(1);
	});
