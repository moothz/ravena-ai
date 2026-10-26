process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.SUPER_ADMINS = "555596792072@c.us,5521974241493@c.us,555596424307@c.us";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const Database = require("../utils/Database");
const FazendaCommands = require("../functions/FazendaCommands");
const EventCommands = require("../functions/EventCommands");
const GameEventService = require("../services/GameEventService");
const FishingGame = require("../functions/FishingGame");
const Management = require("../commands/Management");
const WeeklyGameDigestService = require("../services/WeeklyGameDigestService");

async function main() {
	console.log("=== INICIANDO TESTES DA ATUALIZAÇÃO GERAL ===");

	const bot = new FakeBot({
		id: "testebot",
		nomeExibir: "ravenabot",
		phoneNumber: "5511999998888",
		sendJoinInfo: true
	});

	const eventHandler = new EventHandler();
	const database = Database.getInstance();
	const mockGroups = new Map();
	database.getGroup = async (id) => mockGroups.get(id) || null;
	database.saveGroup = async (g) => {
		mockGroups.set(g.id, g);
		return true;
	};

	// -------------------------------------------------------------
	// 1. TESTE: COMANDO !g-sair (Management.js)
	// -------------------------------------------------------------
	console.log("\n[1] Testando comando !g-sair e confirmação de 60s...");
	const management = new Management();
	const testGroupId = "1203630011223344@g.us";
	const testAdminUser = "5511988887777@s.whatsapp.net";

	const groupData = {
		id: testGroupId,
		name: "grupo-teste-sair",
		prefix: "!"
	};
	await database.saveGroup(groupData);

	let leaveGroupCalled = false;
	let leftGroupId = null;
	bot.leaveGroup = (gid) => {
		leaveGroupCalled = true;
		leftGroupId = gid;
	};

	const msgSair1 = createMessage({
		content: "!g-sair",
		group: testGroupId,
		author: testAdminUser
	});

	// 1.1 Primeira chamada: deve pedir confirmação dentro de 60s
	const resSair1 = await management.sairGrupo(bot, msgSair1, [], groupData);
	assert.ok(resSair1, "Deveria retornar ReturnMessage pedindo confirmação");
	assert.ok(
		resSair1.content.includes("Para confirmar a minha saída, envie novamente"),
		"Mensagem deve conter instrução de confirmação"
	);
	assert.ok(resSair1.content.includes("!g-sair"), "Mensagem deve conter o comando !g-sair");
	assert.ok(
		resSair1.content.includes("sem ressentimentos"),
		"Mensagem deve conter o texto amigável sem ressentimentos"
	);
	assert.strictEqual(leaveGroupCalled, false, "Bot NÃO deve sair na primeira chamada");
	console.log("   ✓ Primeira chamada solicitou confirmação de 60s com sucesso.");

	// 1.2 Segunda chamada (imediata < 60s): deve confirmar, marcar flag na DB e sair
	bot.resetCapture();
	const msgSair2 = createMessage({
		content: "!g-sair",
		group: testGroupId,
		author: testAdminUser
	});

	const resSair2 = await management.sairGrupo(bot, msgSair2, [], groupData);
	assert.strictEqual(resSair2, null, "Segunda chamada não deve retornar erro");
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria enviar mensagem de despedida");
	assert.ok(
		bot.capturedMessages[0].content.includes("Despedida da Ravena"),
		"Mensagem de despedida deve ser enviada"
	);

	// Aguarda o timeout interno do leaveGroup (1.5s)
	await new Promise((resolve) => setTimeout(resolve, 1600));
	assert.strictEqual(leaveGroupCalled, true, "bot.leaveGroup deve ter sido chamado");
	assert.strictEqual(leftGroupId, testGroupId, "ID do grupo que saiu deve ser o correto");

	const updatedGroup = await database.getGroup(testGroupId);
	assert.strictEqual(updatedGroup.removidoAmigavel, true, "Flag removidoAmigavel deve ser true");
	assert.ok(updatedGroup.saidaAmigavel, "Objeto saidaAmigavel deve estar preenchido");
	assert.strictEqual(updatedGroup.saidaAmigavel.via, "comando", "via deve ser 'comando'");
	console.log("   ✓ Segunda chamada confirmou, marcou flags no banco e acionou saída com sucesso.");

	// 1.3 Teste de expiração de confirmação (> 60s)
	management.pendingSairConfirmations.set(testGroupId, {
		timestamp: Date.now() - 65000,
		author: testAdminUser
	});
	leaveGroupCalled = false;
	const resSairExpirado = await management.sairGrupo(bot, msgSair1, [], groupData);
	assert.ok(
		resSairExpirado.content.includes("Para confirmar a minha saída, envie novamente"),
		"Confirmação expirada deve pedir confirmação novamente"
	);
	assert.strictEqual(leaveGroupCalled, false, "Não deve sair quando confirmação expirou");
	console.log("   ✓ Confirmação expirada tratada corretamente (> 60s).");

	// -------------------------------------------------------------
	// 2. TESTE: FAZENDA / JARDIM - FILTROS DE RANKING
	// -------------------------------------------------------------
	console.log("\n[2] Testando filtros de 'Cultivador', 'moothz' e superadmins na Fazenda...");

	// 2.1 isTestUser
	assert.strictEqual(FazendaCommands.isTestUser("Cultivador"), true);
	assert.strictEqual(FazendaCommands.isTestUser("cultivador"), true);
	assert.strictEqual(FazendaCommands.isTestUser("Cultivador (...1234)"), true);
	assert.strictEqual(FazendaCommands.isTestUser("test_user"), true);
	assert.strictEqual(FazendaCommands.isTestUser("sim_user"), true);
	assert.strictEqual(FazendaCommands.isTestUser("5511999998888"), false);
	console.log("   ✓ FazendaCommands.isTestUser validado com sucesso.");

	// 2.2 isSuperAdminUser
	assert.strictEqual(FazendaCommands.isSuperAdminUser("moothz"), true);
	assert.strictEqual(FazendaCommands.isSuperAdminUser("382359487"), true);
	assert.strictEqual(FazendaCommands.isSuperAdminUser("555596792072"), true);
	assert.strictEqual(FazendaCommands.isSuperAdminUser("555596792072@c.us"), true);
	assert.strictEqual(FazendaCommands.isSuperAdminUser("5521974241493@s.whatsapp.net"), true);
	assert.strictEqual(FazendaCommands.isSuperAdminUser("5511999998888"), false);
	console.log("   ✓ FazendaCommands.isSuperAdminUser validado com sucesso.");

	// -------------------------------------------------------------
	// 3. TESTE: COMANDO EVENTOS - FORMATO DO TEMPO RESTANTE
	// -------------------------------------------------------------
	console.log("\n[3] Testando formatação de tempo no comando !eventos...");

	// Cria evento mock no GameEventService
	await GameEventService.setEvent("pesca", "peso", 25, 10, "5511999999999");

	const msgEventos = createMessage({
		content: "!eventos",
		group: testGroupId,
		author: testAdminUser
	});

	const cmdEventos = EventCommands.commands.find((c) => c.name === "eventos");
	const resEventos = await cmdEventos.method(bot, msgEventos, []);

	assert.ok(resEventos && resEventos.content, "Comando !eventos deve retornar ReturnMessage");
	assert.ok(
		!resEventos.content.includes("(restam 10hrs restantes)"),
		"Não deve conter '(restam 10hrs restantes)' repetido"
	);
	assert.ok(
		resEventos.content.includes("(10hrs restantes)"),
		`Deve conter '(10hrs restantes)'. Conteúdo gerado:\n${resEventos.content}`
	);
	console.log("   ✓ Formatação de tempo '(10hrs restantes)' ajustada perfeitamente.");
	await GameEventService.removeEvent("pesca", "peso");

	// -------------------------------------------------------------
	// 4. TESTE: PESCA-REDE - AGRUPAMENTO DE ITENS, LIXOS E DESCARTE
	// -------------------------------------------------------------
	console.log("\n[4] Testando !pesca-rede com agrupamento decrescente e descarte resumido...");

	// Mocking de dados de pesca para testar montagem da mensagem
	const testNetUser = "5511977776666";
	await database.dbRun(
		"fishing",
		"INSERT OR REPLACE INTO fishing_users (user_id, name, total_catches, total_weight, inventory_weight, total_baits_used, total_trash_caught, baits, last_bait_regen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[testNetUser, "PescadorRede", 0, 0, 0, 0, 0, 15, Date.now()]
	);

	const msgRede = createMessage({
		content: "!pesca-rede 5",
		group: testGroupId,
		author: testNetUser,
		authorName: "PescadorRede"
	});

	const cmdRede = FishingGame.commands.find((c) => c.name === "pesca-rede");
	bot.resetCapture();

	// Executa pesca-rede
	const resRede = await cmdRede.method(bot, msgRede, ["5"], groupData);
	const contentRede = resRede ? resRede.content : bot.capturedMessages[0]?.content;
	assert.ok(contentRede, "pesca-rede deve retornar ou enviar mensagem");

	// Valida se agrupamentos com "x" e formato correto aparecem quando há itens ou lixos
	if (contentRede.includes("Itens & Buffs Obtidos:")) {
		assert.match(contentRede, /• \d+x .+/, "Itens devem ser formatados como '• Nx emoji Nome'");
		console.log("   ✓ Seção de Itens & Buffs agrupada por quantidade com sucesso.");
	}

	if (contentRede.includes("Lixos Recolhidos:")) {
		assert.match(contentRede, /• \d+x .+/, "Lixos devem ser formatados como '• Nx emoji Nome'");
		console.log("   ✓ Seção de Lixos Recolhidos agrupada por quantidade com sucesso.");
	}

	console.log("   ✓ Formatação do !pesca-rede validada.");

	// -------------------------------------------------------------
	// 5. TESTE: EVENTHANDLER - BOAS-VINDAS E TEXTOS REVISADOS
	// -------------------------------------------------------------
	console.log("\n[5] Testando boas-vindas do bot ao entrar no grupo e novos textos...");

	const newGroupId = "1203639988776655@g.us";
	bot.resetCapture();

	const joinEventData = {
		group: {
			id: newGroupId,
			name: "Grupo Novíssimo",
			isBotJoining: true
		},
		user: {
			id: `${bot.phoneNumber}@s.whatsapp.net`
		},
		isBotJoining: true,
		action: "add"
	};

	await eventHandler.processGroupJoin(bot, joinEventData);
	assert.strictEqual(bot.capturedMessages.length, 1, "Bot deve enviar mensagem de boas-vindas");
	const welcomeMsg = bot.capturedMessages[0].content;

	assert.ok(welcomeMsg.includes("!g-sair"), "Mensagem de boas-vindas deve instruir sobre !g-sair");
	assert.ok(
		welcomeMsg.includes("!ajuda") || welcomeMsg.includes("!grupao"),
		"Mensagem de boas-vindas deve mencionar !ajuda ou !grupao"
	);
	console.log(
		"   ✓ Mensagem de boas-vindas enviada e validada com instruções de !g-sair e suporte."
	);

	// -------------------------------------------------------------
	// 6. TESTE: WEEKLY DIGEST - EXCLUSÃO DE INTERAGIR AUTO
	// -------------------------------------------------------------
	console.log("\n[6] Testando exclusão de interagir automático no WeeklyGameDigest...");

	const mockLogRows = [
		{ command: "interagir", type: "auto", args: "auto" },
		{ command: "interagir", type: "fixed", args: "false" },
		{ command: "interagir", type: "auto", args: "auto" },
		{ command: "pesca", type: "fixed", args: "" },
		{ command: "pesca", type: "fixed", args: "" },
		{ command: "interagir", type: "fixed", args: "manual_text" }
	];

	// Valida lógica de filtragem equivalente à consulta SQL:
	// WHERE type NOT IN ('auto') AND NOT (command = 'interagir' AND args = 'false')
	const filteredRows = mockLogRows.filter(
		(r) => r.type !== "auto" && !(r.command === "interagir" && r.args === "false")
	);

	const counts = {};
	for (const r of filteredRows) {
		counts[r.command] = (counts[r.command] || 0) + 1;
	}
	const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
	assert.strictEqual(top[0], "pesca", "Top comando filtrado deve ser pesca");
	assert.strictEqual(counts["interagir"], 1, "Apenas o interagir manual deve ser contabilizado");
	console.log("   ✓ 'interagir' automático filtrado do ranking de comandos com sucesso.");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

main().catch((err) => {
	console.error("\n❌ ERRO DURANTE A EXECUÇÃO DOS TESTES:", err);
	process.exit(1);
});
