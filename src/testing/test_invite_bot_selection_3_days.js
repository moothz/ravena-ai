process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const InviteSystem = require("../InviteSystem");
const Database = require("../utils/Database");

async function runTests() {
	console.log("--- Starting InviteSystem 3-day bot selection tests ---");

	const db = Database.getInstance({ testMode: true });

	// -------------------------------------------------------------
	// 1. Teste de CoreRepository.getBotsMessageTotals
	// -------------------------------------------------------------
	console.log("\n1. Testando CoreRepository.getBotsMessageTotals e cálculo de corte temporal...");

	const coreRepo = db.coreRepo;
	const conn = coreRepo.mappers.getConnection(coreRepo.REPORTS_DB);

	// Limpeza prévia de registros de teste para isolamento
	const testBot1 = "test-bot-3d-alpha";
	const testBot2 = "test-bot-3d-beta";
	conn.prepare("DELETE FROM load_reports WHERE bot_id IN (?, ?)").run(testBot1, testBot2);

	const now = Date.now();
	const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;
	const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
	const fourDaysAgo = now - 4 * 24 * 60 * 60 * 1000;
	const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

	const insertStmt = conn.prepare(`
		INSERT INTO load_reports (
			bot_id, timestamp_start, timestamp_end, duration,
			recv_private, recv_group, sent_private, sent_group, msgs_per_hour,
			resp_avg, resp_max, resp_count, json_data
		) VALUES (
			@bot_id, @timestamp_start, @timestamp_end, 600,
			@recv_private, @recv_group, @sent_private, @sent_group, 10,
			0.5, 1.2, 5, '{}'
		)
	`);

	try {
		// testBot1:
		// 1 dia atrás: 10 pv + 20 gp = 30 msgs
		// 2 dias atrás: 15 pv + 25 gp = 40 msgs
		// 4 dias atrás: 100 pv + 200 gp = 300 msgs (fora da janela de 3 dias, dentro de 7 dias)
		insertStmt.run({
			bot_id: testBot1,
			timestamp_start: oneDayAgo,
			timestamp_end: oneDayAgo + 600000,
			recv_private: 5,
			recv_group: 10,
			sent_private: 5,
			sent_group: 10
		});
		insertStmt.run({
			bot_id: testBot1,
			timestamp_start: twoDaysAgo,
			timestamp_end: twoDaysAgo + 600000,
			recv_private: 10,
			recv_group: 15,
			sent_private: 5,
			sent_group: 10
		});
		insertStmt.run({
			bot_id: testBot1,
			timestamp_start: fourDaysAgo,
			timestamp_end: fourDaysAgo + 600000,
			recv_private: 50,
			recv_group: 100,
			sent_private: 50,
			sent_group: 100
		});

		// testBot2:
		// 1 dia atrás: 100 pv + 100 gp = 200 msgs
		// 8 dias atrás: 500 msgs (fora da janela de 7 dias)
		insertStmt.run({
			bot_id: testBot2,
			timestamp_start: oneDayAgo,
			timestamp_end: oneDayAgo + 600000,
			recv_private: 50,
			recv_group: 50,
			sent_private: 50,
			sent_group: 50
		});
		insertStmt.run({
			bot_id: testBot2,
			timestamp_start: eightDaysAgo,
			timestamp_end: eightDaysAgo + 600000,
			recv_private: 100,
			recv_group: 150,
			sent_private: 100,
			sent_group: 150
		});

		// 1.1 Totais nos últimos 3 dias (padrão)
		const totals3Days = await db.getBotsMessageTotals();
		assert.strictEqual(
			totals3Days.get(testBot1),
			70,
			`testBot1 deveria ter 70 mensagens nos últimos 3 dias (30 + 40), obteve ${totals3Days.get(testBot1)}`
		);
		assert.strictEqual(
			totals3Days.get(testBot2),
			200,
			`testBot2 deveria ter 200 mensagens nos últimos 3 dias, obteve ${totals3Days.get(testBot2)}`
		);

		// 1.2 Totais nos últimos 7 dias (compatibilidade retroativa)
		const totals7Days = await db.getBotsWeeklyMessageTotals();
		assert.strictEqual(
			totals7Days.get(testBot1),
			370,
			`testBot1 deveria ter 370 mensagens em 7 dias (70 + 300), obteve ${totals7Days.get(testBot1)}`
		);
		assert.strictEqual(
			totals7Days.get(testBot2),
			200,
			`testBot2 deveria ter 200 mensagens em 7 dias (relatório de 8 dias ignorado), obteve ${totals7Days.get(testBot2)}`
		);

		// 1.3 Opção onlyGroup nos últimos 3 dias
		const totalsGroupOnly = await db.getBotsMessageTotals(undefined, { onlyGroup: true });
		assert.strictEqual(
			totalsGroupOnly.get(testBot1),
			45,
			`testBot1 deveria ter 45 mensagens de grupo nos últimos 3 dias (20 + 25), obteve ${totalsGroupOnly.get(testBot1)}`
		);
		assert.strictEqual(
			totalsGroupOnly.get(testBot2),
			100,
			`testBot2 deveria ter 100 mensagens de grupo nos últimos 3 dias (50 + 50), obteve ${totalsGroupOnly.get(testBot2)}`
		);

		console.log(
			"✓ CoreRepository.getBotsMessageTotals e getBotsWeeklyMessageTotals validados com sucesso!"
		);
	} finally {
		// Limpeza dos registros de teste
		conn.prepare("DELETE FROM load_reports WHERE bot_id IN (?, ?)").run(testBot1, testBot2);
	}

	// -------------------------------------------------------------
	// 2. Teste de InviteSystem.selectBestBotForAutoJoin
	// -------------------------------------------------------------
	console.log("\n2. Testando InviteSystem.selectBestBotForAutoJoin com janela de 3 dias...");

	// Criamos 3 bots
	const botHeavy = new FakeBot({ id: "bot-heavy", phoneNumber: "5511999990001" });
	const botLight = new FakeBot({ id: "bot-light", phoneNumber: "5511999990002" });
	const botExcluded = new FakeBot({ id: "bot-vip", phoneNumber: "5511999990003", vip: true });

	botHeavy.ignoreInvites = false;
	botLight.ignoreInvites = false;
	botHeavy.client.acceptInvite = async () => ({ accepted: true });
	botLight.client.acceptInvite = async () => ({ accepted: true });
	botExcluded.client.acceptInvite = async () => ({ accepted: true });

	// Limita os botInstances no DB apenas para os nossos bots de teste
	const originalBotInstances = db.botInstances;
	db.botInstances = [botHeavy, botLight, botExcluded];

	const inviteSystem = new InviteSystem(botLight);

	// Mock do getBotsMessageTotals para isolar o comportamento do InviteSystem
	const origGetTotals = db.getBotsMessageTotals;
	let calledSince = null;
	db.getBotsMessageTotals = async (since) => {
		calledSince = since;
		const map = new Map();
		map.set("bot-heavy", 1500); // 1500 mensagens em 3 dias
		map.set("bot-light", 50); // 50 mensagens em 3 dias
		return map;
	};

	try {
		// 2.1 Verifica que o bot selecionado é o botLight (menor carga nos últimos 3 dias)
		const selected = await inviteSystem.selectBestBotForAutoJoin();
		assert.ok(selected, "Deveria retornar um bot elegível");
		assert.strictEqual(
			selected.id,
			"bot-light",
			`Deveria selecionar 'bot-light', mas retornou '${selected.id}'`
		);
		console.log("✓ Bot com menor carga nos últimos 3 dias foi selecionado prioritariamente");

		// 2.2 Teste de Rate Limit (limite de 3 grupos a cada 30 minutos)
		// Registra 3 entradas para bot-light
		InviteSystem.recordBotJoin("bot-light");
		InviteSystem.recordBotJoin("bot-light");
		InviteSystem.recordBotJoin("bot-light");

		assert.strictEqual(
			InviteSystem.canBotJoin("bot-light"),
			false,
			"bot-light deveria ter atingido o rate limit"
		);

		// Agora, selectBestBotForAutoJoin deve contornar bot-light e escolher bot-heavy
		const fallbackSelected = await inviteSystem.selectBestBotForAutoJoin();
		assert.ok(fallbackSelected, "Deveria retornar um fallback disponível");
		assert.strictEqual(
			fallbackSelected.id,
			"bot-heavy",
			`Deveria escolher 'bot-heavy' como fallback, mas retornou '${fallbackSelected.id}'`
		);
		console.log("✓ Fallback de rate limit respeitado quando o bot mais leve atinge 3 grupos/30min");

		// 2.3 Quando todos os bots atingem o rate limit, retorna null
		InviteSystem.recordBotJoin("bot-heavy");
		InviteSystem.recordBotJoin("bot-heavy");
		InviteSystem.recordBotJoin("bot-heavy");

		const noBotSelected = await inviteSystem.selectBestBotForAutoJoin();
		assert.strictEqual(
			noBotSelected,
			null,
			"Deveria retornar null quando todos os bots atingem o rate limit"
		);
		console.log("✓ Retorna null adequadamente quando todos os bots atingem o limite");
	} finally {
		// Restaura estado original
		db.botInstances = originalBotInstances;
		db.getBotsMessageTotals = origGetTotals;
		InviteSystem.recentBotJoins.clear();
		inviteSystem.destroy();
	}

	console.log("\n--- ALL InviteSystem 3-day bot selection tests PASSED! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
