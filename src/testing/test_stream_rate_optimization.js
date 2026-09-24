const assert = require("assert");
const StreamMonitor = require("../services/StreamMonitor");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Database = require("../utils/Database");

async function main() {
	console.log("--- Iniciando testes de otimização de velocidade e rate limit de streams ---");

	Database.getInstance({ testMode: true });
	const monitor = StreamMonitor.getInstance();

	// 1. Testar cálculo matemático para a Twitch
	console.log("\n1. Testando calculateOptimalTwitchInterval...");

	// Cenário 0 canais
	const tw0 = monitor.calculateOptimalTwitchInterval(0);
	assert.strictEqual(tw0.intervalMs, 60000);
	assert.strictEqual(tw0.batches, 0);
	console.log("✓ Twitch (0 canais):", tw0.reason);

	// Cenário 50 canais (1 lote de 80)
	const tw50 = monitor.calculateOptimalTwitchInterval(50);
	assert.strictEqual(tw50.batchSize, 80);
	assert.strictEqual(tw50.batches, 1);
	assert.strictEqual(tw50.intervalMs, 30000, "Deve aplicar piso de 30s");
	assert.ok(tw50.reqsPerMinute <= 480, "Não pode exceder cota alvo de 480 req/min");
	console.log("✓ Twitch (50 canais):", tw50.reason);

	// Cenário 250 canais (~atual no bot, 4 lotes de 80)
	const tw250 = monitor.calculateOptimalTwitchInterval(250);
	assert.strictEqual(tw250.batches, 4);
	assert.strictEqual(tw250.intervalMs, 30000, "Deve manter 30s de intervalo para 250 canais");
	assert.strictEqual(tw250.reqsPerMinute, 8, "2 ciclos * 4 lotes = 8 req/min");
	assert.strictEqual(tw250.utilizationPct, 1, "Apenas 1% da cota de 800 req/min");
	console.log("✓ Twitch (250 canais):", tw250.reason);

	// Cenário 2.000 canais (25 lotes de 80)
	const tw2000 = monitor.calculateOptimalTwitchInterval(2000);
	assert.strictEqual(tw2000.batches, 25);
	assert.strictEqual(tw2000.intervalMs, 30000, "Ainda seguro a 30s (50 req/min de 800)");
	assert.ok(tw2000.reqsPerMinute <= 480);
	console.log("✓ Twitch (2000 canais):", tw2000.reason);

	// Cenário extremo: 10.000 canais (125 lotes de 80)
	const tw10k = monitor.calculateOptimalTwitchInterval(10000);
	assert.strictEqual(tw10k.batches, 125);
	assert.ok(tw10k.intervalMs > 30000, "Deve aumentar dinamicamente para respeitar o limite");
	assert.ok(
		tw10k.reqsPerMinute <= 480,
		"Requisições por minuto devem ficar dentro da meta de 60% (480)"
	);
	console.log("✓ Twitch (10.000 canais):", tw10k.reason);

	// 2. Testar cálculo matemático para a Kick
	console.log("\n2. Testando calculateOptimalKickInterval...");

	// Cenário 0 canais
	const k0 = monitor.calculateOptimalKickInterval(0);
	assert.strictEqual(k0.intervalMs, 60000);
	assert.strictEqual(k0.batches, 0);
	console.log("✓ Kick (0 canais):", k0.reason);

	// Cenário 45 canais (~atual no bot, 2 lotes de 25)
	const k45 = monitor.calculateOptimalKickInterval(45);
	assert.strictEqual(k45.batchSize, 25);
	assert.strictEqual(k45.batches, 2);
	assert.strictEqual(k45.intervalMs, 45000, "Deve aplicar piso de segurança de 45s");
	assert.ok(k45.reqsPerMinute <= 30, "Não pode exceder cota segura de 30 req/min");
	console.log("✓ Kick (45 canais):", k45.reason);

	// Cenário 300 canais (12 lotes de 25)
	const k300 = monitor.calculateOptimalKickInterval(300);
	assert.strictEqual(k300.batches, 12);
	assert.ok(k300.reqsPerMinute <= 30, "Deve manter req/min <= 30");
	console.log("✓ Kick (300 canais):", k300.reason);

	// 3. Testar getPollingMetrics()
	console.log("\n3. Testando getPollingMetrics...");
	const metrics = monitor.getPollingMetrics();
	assert.ok(metrics.twitch, "Métricas devem conter twitch");
	assert.ok(metrics.kick, "Métricas devem conter kick");
	assert.ok(metrics.youtube, "Métricas devem conter youtube");
	assert.ok(typeof metrics.twitch.intervalSec === "number");
	assert.ok(typeof metrics.kick.intervalSec === "number");
	console.log("✓ Métricas extraídas com sucesso:", JSON.stringify(metrics, null, 2));

	// 4. Testar comando SuperAdmin !sa-streams-rate
	console.log("\n4. Testando comando SuperAdmin streamsRate...");
	const SuperAdmin = require("../commands/SuperAdmin");
	const sa = new SuperAdmin();
	const fakeBot = new FakeBot({ id: "rav-test", streamMonitor: monitor });

	const rateResult = await sa.streamsRate(fakeBot, { author: "admin@s.whatsapp.net" }, []);
	assert.ok(rateResult, "Deve retornar ReturnMessage");
	assert.ok(rateResult.content.includes("MÉTRICAS DE POLLING & RATE LIMIT"), "Deve conter título");
	assert.ok(rateResult.content.includes("Twitch (Helix API):"), "Deve conter bloco Twitch");
	assert.ok(rateResult.content.includes("Kick API:"), "Deve conter bloco Kick");
	assert.ok(rateResult.content.includes("mais rápido!"), "Deve conter comparativo de velocidade");
	console.log(
		"✓ Retorno do comando !sa-streams-rate formatado com sucesso:\n" + rateResult.content
	);

	// 5. Testar agendamento e cancelamento limpo
	console.log("\n5. Testando início e parada limpa do monitoramento...");
	await monitor.startMonitoring();
	assert.strictEqual(monitor.isMonitoring, true, "isMonitoring deve ser true após start");
	assert.ok(monitor.pollingTimers.twitch, "Timer Twitch deve estar ativo");
	assert.ok(monitor.pollingTimers.kick, "Timer Kick deve estar ativo");
	assert.ok(monitor.pollingTimers.youtube, "Timer YouTube deve estar ativo");

	monitor.stopMonitoring();
	assert.strictEqual(monitor.isMonitoring, false, "isMonitoring deve ser false após stop");
	assert.strictEqual(monitor.pollingTimers.twitch, null, "Timer Twitch deve ter sido limpo");
	assert.strictEqual(monitor.pollingTimers.kick, null, "Timer Kick deve ter sido limpo");
	assert.strictEqual(monitor.pollingTimers.youtube, null, "Timer YouTube deve ter sido limpo");
	console.log("✓ Monitoramento iniciado e parado com limpeza completa dos timers.");

	console.log("\n=== TODOS OS TESTES DE RATE LIMIT E VELOCIDADE PASSARAM COM SUCESSO! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro no teste:", err);
		process.exit(1);
	});
