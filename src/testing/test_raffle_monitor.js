process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const RaffleMonitor = require("../services/RaffleMonitor");
const Database = require("../utils/Database");
const { commands, buildRaffleMessage } = require("../functions/Raffles");

async function runTests() {
	console.log("=== INICIANDO TESTES DO RAFFLE MONITOR ===");

	const database = Database.getInstance({ testMode: true });
	const bot = new FakeBot({ id: "bot-teste" });
	const raffleMonitor = RaffleMonitor.getInstance();

	await raffleMonitor.init(bot);

	// Limpa dados de teste prévios e timers residuais
	raffleMonitor.stopAll();
	await database.dbRun("raffles", "DELETE FROM raffle_follows");
	await database.dbRun("raffles", "DELETE FROM raffle_notifications");
	await database.dbRun("raffle_cache", "DELETE FROM raffle_cache");

	// 1. Teste do banco de frases e getRandomPhrase
	console.log("\n1. Testando geração de frases aleatórias para metas...");
	const milestones = [10, 15, 25, 50, 75, 90, 99, 100];
	for (const m of milestones) {
		const phrase = raffleMonitor.getRandomPhrase(m);
		assert(phrase && phrase.length > 0, `Frase para meta ${m}% não pode ser vazia`);
		console.log(`   [Meta ${m}%]: "${phrase}"`);
	}
	console.log("✓ Frases aleatórias validadas com sucesso.");

	const testUrl1 = "https://www.narigapremios.com/campanha/teste-rifa-1";
	const testUrl2 = "https://www.narigapremios.com/campanha/teste-rifa-2";
	const group1 = "120363000000000001@g.us";
	const group2 = "120363000000000002@g.us";
	const userAdmin = "5511999990001@s.whatsapp.net";

	// 2. Teste de followRaffle com baseline (evitar spam de notificações antigas)
	console.log("\n2. Testando followRaffle com estabelecimento de baseline...");
	// Rifa já inicia em 42%
	await raffleMonitor.followRaffle(testUrl1, group1, userAdmin, bot.id, 42);

	const isFollowed1 = await raffleMonitor.isFollowed(testUrl1);
	assert.strictEqual(isFollowed1, true, "URL 1 deve estar marcada como seguida");

	// Deve ter preenchido baseline no banco para 10%, 15% e 25% (<= 42%)
	const baselineNotifs = await database.dbAll(
		"raffles",
		"SELECT milestone FROM raffle_notifications WHERE group_id = ? AND url = ?",
		[group1, testUrl1]
	);
	const baselineMilestones = baselineNotifs.map((n) => n.milestone).sort((a, b) => a - b);
	assert.deepStrictEqual(
		baselineMilestones,
		[10, 15, 25],
		"Baseline deve conter apenas as metas já superadas (10, 15, 25)"
	);
	assert.strictEqual(
		raffleMonitor.activeTimers.has(testUrl1),
		true,
		"Timer para URL 1 deve estar ativo"
	);
	console.log("✓ Baseline de metas anteriores registrado sem envio de notificações.");

	// 3. Teste de reaproveitamento de interval por URL
	console.log(
		"\n3. Testando reaproveitamento de intervals (múltiplos grupos seguindo a mesma rifa)..."
	);
	const initialTimersCount = raffleMonitor.activeTimers.size;
	assert.strictEqual(initialTimersCount, 1, "Deve haver exatamente 1 timer ativo");

	// Grupo 2 também segue a mesma URL 1
	await raffleMonitor.followRaffle(testUrl1, group2, userAdmin, bot.id, 42);

	assert.strictEqual(
		raffleMonitor.activeTimers.size,
		1,
		"Após segundo grupo seguir a mesma rifa, activeTimers DEVE continuar com 1 timer (reaproveitamento)"
	);
	console.log("✓ Interval reaproveitado com sucesso: 2 grupos compartilham o mesmo timer.");

	// 4. Teste de detecção de nova meta e salto de porcentagem
	console.log("\n4. Testando salto de vendas (de 42% para 55%)...");
	// Popula raffle_cache simulando que a rifa avançou para 55% vendida
	// Total: 1000, Disponíveis: 450 (Vendidas: 550 = 55%)
	await database.dbRun(
		"raffle_cache",
		`INSERT OR REPLACE INTO raffle_cache (url, title, price, total_nums, available_nums, alert_text, description, image_url, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[testUrl1, "Rifa Fusca 1970", "R$ 0,50", 1000, 450, "", "Descrição de teste", "", Date.now()]
	);

	// Salva grupos no banco para resolução de nome e status
	await database.saveGroup({ id: group1, name: "Grupo Teste 1", paused: false });
	await database.saveGroup({ id: group2, name: "Grupo Teste 2", paused: false });

	bot.resetCapture();
	await raffleMonitor.checkRaffleMilestones(testUrl1);

	// Ambos os grupos devem ter recebido notificação da meta de 50%
	assert.strictEqual(
		bot.capturedMessages.length,
		2,
		"Ambos os grupos devem receber a notificação de 50%"
	);
	assert(bot.capturedMessages[0].content.includes("50%"), "Mensagem deve conter menção a 50%");
	assert(
		bot.capturedMessages[1].content.includes("50%"),
		"Mensagem do grupo 2 deve conter menção a 50%"
	);

	// Verifica se a meta 50% foi registrada no banco para ambos
	const notifsG1 = await database.dbAll(
		"raffles",
		"SELECT milestone FROM raffle_notifications WHERE group_id = ? AND url = ?",
		[group1, testUrl1]
	);
	const milestonesG1 = notifsG1.map((n) => n.milestone).sort((a, b) => a - b);
	assert.deepStrictEqual(milestonesG1, [10, 15, 25, 50], "Metas do grupo 1 devem incluir 50%");

	console.log("✓ Notificação disparada para a meta de 50% com sucesso.");

	// 5. Teste de deduplicação (segunda checagem com os mesmos 55%)
	console.log("\n5. Testando deduplicação de notificações...");
	bot.resetCapture();
	await raffleMonitor.checkRaffleMilestones(testUrl1);
	assert.strictEqual(
		bot.capturedMessages.length,
		0,
		"Nenhuma notificação deve ser enviada se a porcentagem não ultrapassou nova meta"
	);
	console.log("✓ Deduplicação confirmada: 0 notificações duplicadas enviadas.");

	// 6. Teste de otimização de leitura direta do DB no comando !raffle
	console.log("\n6. Testando otimização do comando !raffle quando a rifa é seguida...");
	const raffleCmd = commands.find((c) => c.name === "raffle");
	assert(raffleCmd, "Comando !raffle deve estar registrado");

	bot.resetCapture();
	const msgRaffle = createMessage({
		content: `!raffle ${testUrl1}`,
		author: userAdmin,
		group: group1
	});

	const returnMsg = await raffleCmd.execute(bot, msgRaffle, [testUrl1], {
		id: group1,
		name: "Grupo Teste 1"
	});
	assert(returnMsg, "Deve retornar mensagem com os dados");
	const contentStr =
		typeof returnMsg.content === "string" ? returnMsg.content : returnMsg.options?.caption;
	assert(contentStr.includes("Rifa Fusca 1970"), "Deve exibir o título salvo no banco");
	assert(contentStr.includes("55%"), "Deve exibir a porcentagem calculada (55%)");
	console.log("✓ Retorno do !raffle direto do banco de dados validado.");

	// 7. Teste de listFollowed
	console.log("\n7. Testando listagem de rifas seguidas (!raffle-listar)...");
	const followedList = await raffleMonitor.listFollowed(group1);
	assert.strictEqual(followedList.length, 1, "Grupo 1 deve ter 1 rifa seguida");
	assert.strictEqual(followedList[0].url, testUrl1);
	assert.strictEqual(followedList[0].title, "Rifa Fusca 1970");
	console.log("✓ listFollowed retornou corretamente os dados com join de título.");

	// 8. Teste de cancelamento e encerramento do timer (unfollowRaffle)
	console.log("\n8. Testando encerramento do interval ao deseguir rifa...");
	// Grupo 1 desegue
	const removed1 = await raffleMonitor.unfollowRaffle(testUrl1, group1);
	assert.strictEqual(removed1, true, "Remoção do grupo 1 deve ser true");
	assert.strictEqual(
		raffleMonitor.activeTimers.has(testUrl1),
		true,
		"Timer deve continuar ativo porque Grupo 2 ainda segue a rifa"
	);

	// Grupo 2 desegue
	const removed2 = await raffleMonitor.unfollowRaffle(testUrl1, group2);
	assert.strictEqual(removed2, true, "Remoção do grupo 2 deve ser true");
	assert.strictEqual(
		raffleMonitor.activeTimers.has(testUrl1),
		false,
		"Timer DEVE ser cancelado e removido após o último grupo deixar de seguir"
	);
	console.log("✓ Encerramento de timer e cleanup de intervalos testado com sucesso.");

	// 9. Teste do comando !raffle-seguir via PV com !g-manage
	console.log("\n9. Testando suporte a chat privado com !g-manage...");
	const raffleSeguirCmd = commands.find((c) => c.name === "raffle-seguir");
	assert(raffleSeguirCmd, "Comando !raffle-seguir deve estar registrado");

	// A: Sem g-manage ativo
	bot.eventHandler = {
		commandHandler: {
			privateManagement: {}
		}
	};
	const msgPVSemManage = createMessage({
		content: `!raffle-seguir ${testUrl2}`,
		author: userAdmin,
		group: null // PV
	});
	const resSemManage = await raffleSeguirCmd.execute(bot, msgPVSemManage, [testUrl2], null);
	assert(
		resSemManage.content.includes("!g-manage"),
		"Deve instruir a usar !g-manage quando no PV sem grupo gerenciado"
	);
	console.log("   ✓ PV sem !g-manage barrado e instruído com sucesso.");

	// B: Com g-manage ativo
	bot.eventHandler.commandHandler.privateManagement[userAdmin] = group1;

	// Mock do adminUtils para considerar o usuário admin
	const AdminUtils = require("../utils/AdminUtils");
	const originalIsAdmin = AdminUtils.getInstance().isAdmin;
	AdminUtils.getInstance().isAdmin = async () => true;

	// Salva dados no cache para o URL 2 para não depender de rede
	await database.dbRun(
		"raffle_cache",
		`INSERT OR REPLACE INTO raffle_cache (url, title, price, total_nums, available_nums, alert_text, description, image_url, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[testUrl2, "Rifa Moto Honda", "R$ 1,00", 500, 250, "", "Moto zero km", "", Date.now()]
	);

	const msgPVComManage = createMessage({
		content: `!raffle-seguir ${testUrl2}`,
		author: userAdmin,
		group: null // PV
	});

	const resComManage = await raffleSeguirCmd.execute(bot, msgPVComManage, [testUrl2], null);
	assert(
		resComManage.content.includes("adicionada ao monitoramento"),
		"Deve confirmar que a rifa foi adicionada ao monitoramento"
	);
	assert(
		resComManage.content.includes("Grupo Teste 1"),
		"Deve identificar o grupo gerenciado 'Grupo Teste 1'"
	);

	// Verifica no banco se vinculou ao group1
	const followsG1 = await raffleMonitor.listFollowed(group1);
	assert(
		followsG1.some((f) => f.url === testUrl2),
		"Rifa 2 deve estar associada ao Grupo 1"
	);
	console.log("   ✓ PV com !g-manage vinculou a rifa ao grupo correto.");

	// Restaura isAdmin
	AdminUtils.getInstance().isAdmin = originalIsAdmin;

	// 10. Encerramento limpo de todos os timers
	raffleMonitor.stopAll();
	assert.strictEqual(raffleMonitor.activeTimers.size, 0, "stopAll deve limpar todos os timers");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("ERRO NO TESTE:", err);
	process.exit(1);
});
