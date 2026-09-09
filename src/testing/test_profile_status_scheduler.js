const assert = require("assert");
const ProfileStatusScheduler = require("../services/ProfileStatusScheduler");
const FakeBot = require("./FakeBot");
const LoadReport = require("../LoadReport");

async function runTests() {
	console.log("--- Starting ProfileStatusScheduler tests ---");

	// 1. Instanciação e Singleton
	const scheduler = new ProfileStatusScheduler({ intervalMs: 1000 });
	assert.ok(scheduler, "ProfileStatusScheduler deve ser instanciado");
	assert.strictEqual(scheduler.intervalMs, 1000, "Deve aceitar intervalMs customizado");

	// 2. Filtro de bots elegíveis (getEligibleBots)
	const botWhatsAppNormal = new FakeBot({ id: "bot-zap-1", updateStatus: true });
	const botWhatsAppDisabled = new FakeBot({ id: "bot-zap-2", updateStatus: false });
	const botTelegram = new FakeBot({ id: "bot-tg-1", updateStatus: true });
	botTelegram.useTelegram = true;
	const botDiscord = new FakeBot({ id: "bot-dc-1", updateStatus: true });
	botDiscord.useDiscord = true;

	scheduler.registerBot(botWhatsAppNormal);
	scheduler.registerBot(botWhatsAppDisabled);
	scheduler.registerBot(botTelegram);
	scheduler.registerBot(botDiscord);

	const eligible = scheduler.getEligibleBots();
	const eligibleIds = eligible.map((b) => b.id);
	assert.ok(
		eligibleIds.includes("bot-zap-1"),
		"WhatsApp bot com updateStatus=true deve ser elegível"
	);
	assert.ok(
		eligibleIds.includes("bot-dc-1"),
		"Discord bot com updateStatus=true deve ser elegível"
	);
	assert.strictEqual(
		eligibleIds.includes("bot-zap-2"),
		false,
		"Bot com updateStatus=false NÃO deve ser elegível"
	);
	assert.strictEqual(
		eligibleIds.includes("bot-tg-1"),
		false,
		"Bot Telegram NÃO deve ser elegível para profile status"
	);
	console.log("✓ Filtro de elegibilidade de bots passou");

	// 3. Formatação da mensagem de status
	const statusMsg1 = scheduler.formatStatus(botWhatsAppNormal);
	assert.ok(statusMsg1.includes("Envie !cmd"), "Deve conter 'Envie !cmd' quando ignorePV=false");
	assert.ok(statusMsg1.includes("https://ravena.moothz.win"), "Deve conter o link ravena");

	botWhatsAppNormal.ignorePV = true;
	const statusMsg2 = scheduler.formatStatus(botWhatsAppNormal);
	assert.ok(
		statusMsg2.includes("PV desabilitado"),
		"Deve conter 'PV desabilitado' quando ignorePV=true"
	);
	console.log("✓ Formatação de status passou");

	// 4. Teste de escalonamento (stagger / round-robin)
	const testScheduler = new ProfileStatusScheduler({ intervalMs: 100 });
	const botA = new FakeBot({ id: "bot-A", updateStatus: true, isConnected: true });
	const botB = new FakeBot({ id: "bot-B", updateStatus: true, isConnected: true });
	const botC = new FakeBot({ id: "bot-C", updateStatus: true, isConnected: true });

	testScheduler.registerBot(botA);
	testScheduler.registerBot(botB);
	testScheduler.registerBot(botC);

	// Tick 1 -> deve atualizar botA
	const res1 = await testScheduler.tick();
	assert.strictEqual(res1, true, "Tick 1 deve atualizar um bot");
	assert.strictEqual(botA.updatedStatuses.length, 1, "Bot A deve ter sido atualizado no tick 1");
	assert.strictEqual(
		botB.updatedStatuses.length,
		0,
		"Bot B não deve ter sido atualizado no tick 1"
	);
	assert.strictEqual(
		botC.updatedStatuses.length,
		0,
		"Bot C não deve ter sido atualizado no tick 1"
	);

	// Tick 2 -> deve atualizar botB
	const res2 = await testScheduler.tick();
	assert.strictEqual(res2, true, "Tick 2 deve atualizar um bot");
	assert.strictEqual(botA.updatedStatuses.length, 1, "Bot A mantém 1 atualização");
	assert.strictEqual(botB.updatedStatuses.length, 1, "Bot B deve ter sido atualizado no tick 2");
	assert.strictEqual(
		botC.updatedStatuses.length,
		0,
		"Bot C não deve ter sido atualizado no tick 2"
	);

	// Tick 3 -> deve atualizar botC
	const res3 = await testScheduler.tick();
	assert.strictEqual(res3, true, "Tick 3 deve atualizar um bot");
	assert.strictEqual(botA.updatedStatuses.length, 1, "Bot A mantém 1 atualização");
	assert.strictEqual(botB.updatedStatuses.length, 1, "Bot B mantém 1 atualização");
	assert.strictEqual(botC.updatedStatuses.length, 1, "Bot C deve ter sido atualizado no tick 3");

	// Tick 4 -> wrap-around volta para botA
	const res4 = await testScheduler.tick();
	assert.strictEqual(res4, true, "Tick 4 deve atualizar um bot");
	assert.strictEqual(
		botA.updatedStatuses.length,
		2,
		"Bot A deve ter sido atualizado novamente no tick 4"
	);
	assert.strictEqual(botB.updatedStatuses.length, 1, "Bot B mantém 1 atualização");
	assert.strictEqual(botC.updatedStatuses.length, 1, "Bot C mantém 1 atualização");
	console.log("✓ Ciclo de escalonamento round-robin passou");

	// 5. Tratamento de bot desconectado (pula desconectado sem travar ou duplicar)
	const testSchedulerOffline = new ProfileStatusScheduler({ intervalMs: 100 });
	const botX = new FakeBot({ id: "bot-X", updateStatus: true, isConnected: true });
	const botY = new FakeBot({ id: "bot-Y", updateStatus: true, isConnected: false }); // offline
	const botZ = new FakeBot({ id: "bot-Z", updateStatus: true, isConnected: true });

	testSchedulerOffline.registerBot(botX);
	testSchedulerOffline.registerBot(botY);
	testSchedulerOffline.registerBot(botZ);

	// Tick 1 -> Bot X
	await testSchedulerOffline.tick();
	assert.strictEqual(botX.updatedStatuses.length, 1, "Bot X atualizado no tick 1");
	assert.strictEqual(botY.updatedStatuses.length, 0, "Bot Y offline não deve atualizar");
	assert.strictEqual(botZ.updatedStatuses.length, 0, "Bot Z não deve atualizar no tick 1");

	// Tick 2 -> Bot Y está offline, então deve pular para Bot Z
	await testSchedulerOffline.tick();
	assert.strictEqual(botX.updatedStatuses.length, 1, "Bot X mantém 1");
	assert.strictEqual(botY.updatedStatuses.length, 0, "Bot Y permaneceu sem atualização");
	assert.strictEqual(botZ.updatedStatuses.length, 1, "Bot Z deve ser atualizado pulando Bot Y");

	// Tick 3 -> Volta para Bot X
	await testSchedulerOffline.tick();
	assert.strictEqual(botX.updatedStatuses.length, 2, "Bot X atualizado novamente no tick 3");
	console.log("✓ Tratamento de bot desconectado/offline passou");

	// 6. Teste de start e stop
	testScheduler.start();
	assert.strictEqual(testScheduler.isRunning, true, "isRunning deve ser true após start()");
	assert.ok(testScheduler.timer, "Timer deve estar ativo");
	testScheduler.stop();
	assert.strictEqual(testScheduler.isRunning, false, "isRunning deve ser false após stop()");
	assert.strictEqual(testScheduler.timer, null, "Timer deve ser limpo");
	console.log("✓ Start e Stop do scheduler passaram");

	// 7. Teste de que LoadReport generateReport() não chama mais setStatus diretamente
	const botLoadReport = new FakeBot({ id: "bot-lr", updateStatus: true, isConnected: true });
	const lr = new LoadReport(botLoadReport);
	// Limpa o intervalo do LoadReport para não ficar pendente
	lr.destroy();

	await lr.generateReport();
	assert.strictEqual(
		botLoadReport.updatedStatuses.length,
		0,
		"generateReport() NÃO deve mais chamar setStatus simultaneamente"
	);

	// Chamada explícita de updateStatus() manual ainda funciona
	await lr.updateStatus();
	assert.strictEqual(
		botLoadReport.updatedStatuses.length,
		1,
		"Chamada manual de lr.updateStatus() deve funcionar"
	);
	console.log("✓ Desacoplamento do LoadReport.generateReport() passou");

	console.log("--- ALL PROFILE STATUS SCHEDULER TESTS PASSED! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
