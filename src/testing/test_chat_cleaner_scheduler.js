process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ChatCleanerScheduler = require("../services/ChatCleanerScheduler");

async function runTests() {
	console.log("=== INICIANDO TESTES DO CHAT CLEANER SCHEDULER ===");

	const testStatePath = path.resolve(__dirname, "../../temp/test-chat-cleaner-state.json");
	if (fs.existsSync(testStatePath)) {
		fs.unlinkSync(testStatePath);
	}

	const clearedChats = [];
	const fakeBotNormal = {
		id: "bot-normal",
		deleteMessagesInterval: 3,
		useTelegram: false,
		useDiscord: false,
		listGroups: async () => [
			{ JID: "1203630001@g.us", Name: "Grupo 1" },
			{ JID: "1203630002@g.us", Name: "Grupo 2" }
		],
		clearChat: async (jid, deleteMedia) => {
			clearedChats.push({ bot: "bot-normal", jid, deleteMedia });
			return { message: "success" };
		}
	};

	const fakeBotDisabled = {
		id: "bot-disabled",
		deleteMessagesInterval: false,
		useTelegram: false,
		useDiscord: false,
		listGroups: async () => [{ JID: "1203630003@g.us", Name: "Grupo 3" }],
		clearChat: async (jid, deleteMedia) => {
			clearedChats.push({ bot: "bot-disabled", jid, deleteMedia });
		}
	};

	const scheduler = new ChatCleanerScheduler({
		bots: [fakeBotNormal, fakeBotDisabled],
		delayBetweenGroupsMs: 10,
		stateFilePath: testStatePath
	});

	// Teste 1: Primeira execução limpa o bot normal (dias decorridos >= 3 porque lastExecution é 0) e ignora o bot desativado
	console.log("Teste 1: Executando runCheck() inicial...");
	await scheduler.runCheck();

	assert.strictEqual(
		clearedChats.length,
		2,
		`Deveria ter limpado 2 grupos do bot normal, mas limpou ${clearedChats.length}`
	);
	assert.strictEqual(clearedChats[0].jid, "1203630001@g.us");
	assert.strictEqual(clearedChats[1].jid, "1203630002@g.us");
	assert.ok(
		scheduler.state.lastExecution["bot-normal"] > 0,
		"Deveria ter registrado timestamp de execução"
	);
	assert.strictEqual(
		scheduler.state.lastExecution["bot-disabled"],
		undefined,
		"Bot desativado não deve ter execução registrada"
	);
	console.log("✓ Teste 1 passou: Bot normal limpo e bot desativado ignorado!");

	// Teste 2: Execução logo em seguida não deve limpar novamente porque não se passaram 3 dias
	console.log("Teste 2: Executando runCheck() imediatamente após...");
	clearedChats.length = 0;
	await scheduler.runCheck();

	assert.strictEqual(
		clearedChats.length,
		0,
		"Não deveria limpar nada pois o intervalo ainda não venceu"
	);
	console.log("✓ Teste 2 passou: Intervalo respeitado, nenhuma limpeza prematura!");

	// Teste 3: Simula que passaram 4 dias para o bot normal
	console.log("Teste 3: Simulando 4 dias decorridos...");
	const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
	scheduler.state.lastExecution["bot-normal"] = fourDaysAgo;

	clearedChats.length = 0;
	await scheduler.runCheck();

	assert.strictEqual(
		clearedChats.length,
		2,
		"Deveria ter limpado os 2 grupos após 4 dias decorridos"
	);
	console.log("✓ Teste 3 passou: Limpeza acionada corretamente após vencimento do intervalo!");

	// Teste 4: Limpeza pontual de um grupo específico (cleanBotGroups com targetGroup)
	console.log("Teste 4: Testando limpeza pontual de targetGroup...");
	clearedChats.length = 0;
	const singleResult = await scheduler.cleanBotGroups(fakeBotNormal, {
		targetGroup: "120363220838898748@g.us"
	});

	assert.strictEqual(singleResult.success, true);
	assert.strictEqual(clearedChats.length, 1);
	assert.strictEqual(clearedChats[0].jid, "120363220838898748@g.us");
	console.log("✓ Teste 4 passou: Limpeza direcionada de targetGroup funcionou perfeitamente!");

	// Limpeza do arquivo de teste
	if (fs.existsSync(testStatePath)) {
		fs.unlinkSync(testStatePath);
	}

	console.log("=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
