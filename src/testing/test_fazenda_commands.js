/**
 * test_fazenda_commands.js
 *
 * Teste automatizado de integração dos comandos do Jardim das Sombras (Fazenda).
 * Executado dentro do container Docker via FakeBot e EventHandler.
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
const FazendaCommands = require("../functions/FazendaCommands");

async function runTests() {
	console.log("==================================================================");
	console.log("🌱 TESTE AUTOMATIZADO DOS COMANDOS DA FAZENDA (JARDIM DAS SOMBRAS)");
	console.log("==================================================================\n");

	const bot = new FakeBot({ id: "test-bot", grupoLogs: "logs@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	eventHandler.commandHandler.checkCooldown = async () => ({ inCooldown: false, timeLeft: 0 });

	const testUser = "5511999998888@s.whatsapp.net";
	const testGroup = "120363000000000@g.us";

	async function waitForReply(maxMs = 10000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length > 0) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 100));
		}
		return bot.capturedMessages;
	}

	function prepareStep() {
		bot.resetCapture();
		if (eventHandler.commandHandler?.userDebounceMap) {
			eventHandler.commandHandler.userDebounceMap.clear();
		}
	}

	// 1. Teste do comando !faz-ajuda
	console.log("1. Testando !faz-ajuda...");
	prepareStep();
	const msgAjuda = createMessage({
		content: "!faz-ajuda",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgAjuda);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria enviar resposta de ajuda");
	assert(
		bot.capturedMessages[0].content.toUpperCase().includes("GUIA DO"),
		"Texto de ajuda deveria conter cabeçalho de guia"
	);
	assert(
		Boolean(
			bot.capturedMessages[0].options?.quotedMessageId || bot.capturedMessages[0].options?.goReply
		),
		"Mensagem de resposta deve incluir citação (reply)"
	);
	console.log("✓ !faz-ajuda passou com sucesso!");

	// 2. Teste do comando !faz-loja
	console.log("2. Testando !faz-loja...");
	prepareStep();
	const msgLoja = createMessage({
		content: "!faz-loja",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgLoja);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria exibir o catálogo da loja");
	assert(
		bot.capturedMessages[0].content.toUpperCase().includes("MERCADO DO"),
		"Deveria conter catálogo de sementes e elixires"
	);
	assert(
		Boolean(
			bot.capturedMessages[0].options?.quotedMessageId || bot.capturedMessages[0].options?.goReply
		),
		"Mensagem da loja deve incluir citação (reply)"
	);
	console.log("✓ !faz-loja passou com sucesso!");

	// 3. Teste do comando !faz-inventario
	console.log("3. Testando !faz-inventario...");
	prepareStep();
	const msgInv = createMessage({
		content: "!faz-inventario",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgInv);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria responder com a mochila");
	assert(
		bot.capturedMessages[0].content.toUpperCase().includes("MOCHILA DO"),
		"Deveria conter mochila"
	);
	assert(
		Boolean(
			bot.capturedMessages[0].options?.quotedMessageId || bot.capturedMessages[0].options?.goReply
		),
		"Mensagem do inventário deve incluir citação (reply)"
	);
	console.log("✓ !faz-inventario passou com sucesso!");

	// 4. Teste de compra com !faz-comprar
	console.log("4. Testando !faz-comprar...");
	prepareStep();
	const msgBuy = createMessage({
		content: "!faz-comprar 2 1",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgBuy);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria processar compra ou saldo");
	if (bot.capturedMessages.length > 1) {
		assert.strictEqual(
			bot.capturedMessages[1].options?.sendMediaAsSticker,
			true,
			"Segunda mensagem da compra deve ser o sticker do item comprado"
		);
		const stickerContent = bot.capturedMessages[1].content;
		assert.strictEqual(
			stickerContent.mimetype,
			"image/webp",
			"Sticker deve ter mimetype image/webp"
		);
		assert(stickerContent.data, "Sticker deve ter payload de dados base64");
		const stickerBuf = Buffer.from(stickerContent.data, "base64");
		assert.strictEqual(
			stickerBuf.subarray(0, 4).toString(),
			"RIFF",
			"Sticker deve iniciar com cabeçalho RIFF"
		);
		assert.strictEqual(
			stickerBuf.subarray(8, 12).toString(),
			"WEBP",
			"Sticker deve ser formato WEBP válido"
		);
		console.log("✓ !faz-comprar gerou e incluiu sticker WebP válido da compra!");
	} else {
		console.log("✓ !faz-comprar respondeu adequadamente!");
	}

	// 4.1. Teste de listagem com ID no !faz-inventario
	console.log("4.1. Testando exibição de ID no !faz-inventario...");
	prepareStep();
	const msgInvWithItems = createMessage({
		content: "!faz-inv",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgInvWithItems);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria responder com a mochila");
	assert(
		bot.capturedMessages[0].content.includes("[2]"),
		"Inventário deve exibir o ID do item como [2] na lista"
	);
	console.log("✓ !faz-inv exibiu o ID [2] na lista com sucesso!");

	// 5. Teste de plantio com !faz-plantar
	console.log("5. Testando !faz-plantar...");
	prepareStep();
	const msgPlant = createMessage({
		content: "!faz-plantar 1 1",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgPlant);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria responder ao comando de plantar");
	console.log("✓ !faz-plantar executado!");

	// 6. Teste de !fazenda no Grupo (Verifica se inclui dica de usar !faz-adm no PV)
	console.log("6. Testando !fazenda em Grupo...");
	prepareStep();
	const msgFazendaGrupo = createMessage({
		content: "!fazenda",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgFazendaGrupo);
	await waitForReply();
	assert(bot.capturedMessages.length >= 1, "Deveria enviar pelo menos a imagem da fazenda");
	const firstMsg = bot.capturedMessages[0];
	const captionText =
		firstMsg.options?.caption || (typeof firstMsg.content === "string" ? firstMsg.content : "");
	assert(captionText.toUpperCase().includes("JARDIM"), "Deveria conter cabeçalho do jardim");
	assert(
		captionText.includes("!faz-adm") && captionText.includes("privado"),
		"Deveria conter a dica de ir ao PV para o admin"
	);
	if (firstMsg.content?.data) {
		const buf = Buffer.from(firstMsg.content.data, "base64");
		console.log(`   Tamanho da imagem padrão (!fazenda): ${(buf.length / 1024).toFixed(1)} KB`);
		assert(buf.length < 200 * 1024, "Imagem padrão do !fazenda deve ser otimizada (< 200 KB)");
	}
	console.log("✓ !fazenda em grupo passou com sucesso!");

	// 6.1 Teste de !fazenda hd (Alta Resolução 1024x1024)
	console.log("6.1 Testando !fazenda hd (Alta Resolução 1024x1024)...");
	prepareStep();
	const msgFazendaHd = createMessage({
		content: "!fazenda hd",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgFazendaHd);
	await waitForReply();
	assert(bot.capturedMessages.length >= 1, "Deveria enviar imagem da fazenda em HD");
	const hdMsg = bot.capturedMessages[0];
	const hdCaption =
		hdMsg.options?.caption || (typeof hdMsg.content === "string" ? hdMsg.content : "");
	assert(hdCaption.includes("Alta Resolução"), "Deveria indicar modo Alta Resolução");
	if (hdMsg.content?.data) {
		const hdBuf = Buffer.from(hdMsg.content.data, "base64");
		console.log(`   Tamanho da imagem HD (!fazenda hd): ${(hdBuf.length / 1024).toFixed(1)} KB`);
		assert(
			hdBuf.length > 200 * 1024,
			"Imagem HD do !fazenda deve preservar resolução nativa (> 200 KB)"
		);
	}
	console.log("✓ !fazenda hd testado com sucesso!");

	// 6.2 Teste do helper extractQualityFlag
	console.log("6.2 Testando helper extractQualityFlag...");
	const r1 = FazendaCommands.extractQualityFlag(["hd"]);
	assert.strictEqual(r1.isHighQuality, true);
	assert.deepStrictEqual(r1.remainingArgs, []);

	const r2 = FazendaCommands.extractQualityFlag(["1", "5", "web"]);
	assert.strictEqual(r2.isHighQuality, true);
	assert.deepStrictEqual(r2.remainingArgs, ["1", "5"]);

	const r3 = FazendaCommands.extractQualityFlag(["3", "tudo"]);
	assert.strictEqual(r3.isHighQuality, false);
	assert.deepStrictEqual(r3.remainingArgs, ["3", "tudo"]);
	console.log("✓ extractQualityFlag passou com sucesso!");

	// 7. Teste de !fazenda no Privado (Verifica se envia link de admin)
	console.log("7. Testando !fazenda no Privado...");
	prepareStep();
	const msgFazendaPV = createMessage({
		content: "!fazenda",
		author: testUser,
		group: null
	});
	await eventHandler.processMessage(bot, msgFazendaPV);
	await waitForReply();
	assert(bot.capturedMessages.length >= 1, "Deveria enviar mensagem no PV");
	const pvMsg = bot.capturedMessages[0];
	const pvText = pvMsg.options?.caption || (typeof pvMsg.content === "string" ? pvMsg.content : "");
	assert(
		pvText.includes("Farm Admin"),
		"Deveria incluir acesso ao Farm Admin quando chamado no PV"
	);
	console.log("✓ !fazenda no PV passou com sucesso!");

	// 7.1 Teste de !faz-adm no Grupo (Não deve enviar mensagem no grupo, apenas despachar no PV e reagir)
	console.log("7.1 Testando !faz-adm em Grupo...");
	prepareStep();
	let reactedEmoji = null;
	const msgFazAdmGrupo = createMessage({
		content: "!faz-adm",
		author: testUser,
		group: testGroup
	});
	msgFazAdmGrupo.origin.react = async (emoji) => {
		reactedEmoji = emoji;
	};
	await eventHandler.processMessage(bot, msgFazAdmGrupo);
	await waitForReply();
	assert.strictEqual(reactedEmoji, "📨", "Deveria reagir à mensagem do grupo com 📨");
	assert.strictEqual(
		bot.capturedMessages.length,
		1,
		"Deveria enviar apenas 1 mensagem (despachada no PV)"
	);
	assert.strictEqual(
		bot.capturedMessages[0].chatId,
		testUser,
		"A mensagem enviada deve ser direcionada ao PV do usuário"
	);
	assert(
		bot.capturedMessages[0].content.includes("PAINEL FARM ADMIN"),
		"Conteúdo no PV deve ser o painel do Farm Admin"
	);
	assert(
		!bot.capturedMessages[0].content.includes("[object Object]"),
		"O link não deve conter [object Object]"
	);
	assert(
		bot.capturedMessages[0].content.includes("https://jds.moothz.win/farm?id="),
		"Deve conter link público válido"
	);
	console.log("✓ !faz-adm em grupo reagiu e despachou no PV sem poluir o grupo!");

	// 8. Teste de colheita com !faz-colheita e !faz-colher
	console.log("8. Testando !faz-colheita e !faz-colher (oculto)...");
	prepareStep();
	const msgColheita = createMessage({
		content: "!faz-colheita",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgColheita);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria responder a colheita via !faz-colheita");
	const colheitaContent =
		bot.capturedMessages[0].options?.caption ||
		(typeof bot.capturedMessages[0].content === "string" ? bot.capturedMessages[0].content : "");
	assert(
		!colheitaContent.includes("#undefined"),
		"Mensagem de colheita NUNCA deve conter '#undefined'"
	);
	console.log("✓ !faz-colheita executado sem #undefined!");

	prepareStep();
	const msgColher = createMessage({
		content: "!faz-colher",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgColher);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria responder a colheita via !faz-colher oculto");
	console.log("✓ !faz-colher (comando oculto) executado com sucesso!");

	// 9. Teste de venda com !faz-vender
	console.log("9. Testando !faz-vender...");
	prepareStep();
	const msgVender = createMessage({
		content: "!faz-vender",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgVender);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria responder a venda");
	console.log("✓ !faz-vender executado!");

	// 10. Teste de integração de bônus de Waifus
	console.log("10. Testando bônus de rolls e tickets de Waifus...");
	const initialBonus = await FazendaCommands.getFarmWaifuRollBonus(testUser);
	console.log("   Bonus inicial:", initialBonus);

	// Credita 1 roll e 1 ticket sintético
	await ShadowGardenBonusService.dispatchHarvestDrops(testUser, [
		{ bonusType: "waifu_roll", name: "Coração Púrpuro", count: 1 },
		{ bonusType: "waifu_ticket", name: "Rosa de Sangue", count: 1 }
	]);

	const bonusAfter = await FazendaCommands.getFarmWaifuRollBonus(testUser);
	assert.strictEqual(bonusAfter.hasBonus, true, "Deveria ter bônus ativo");
	assert.strictEqual(bonusAfter.rolls >= 1, true, "Deveria ter pelo menos 1 roll");
	assert.strictEqual(bonusAfter.tickets >= 1, true, "Deveria ter pelo menos 1 ticket");

	// Consome primeiro o ticket
	const consTicket = await FazendaCommands.consumeFarmWaifuRoll(testUser);
	assert.strictEqual(consTicket.consumed, true, "Deveria consumir com sucesso");
	assert.strictEqual(consTicket.type, "ticket", "Deveria consumir o ticket primeiro");

	// Consome o roll em seguida
	const consRoll = await FazendaCommands.consumeFarmWaifuRoll(testUser);
	assert.strictEqual(consRoll.consumed, true, "Deveria consumir o roll");
	assert.strictEqual(consRoll.type, "roll", "Deveria consumir o roll");
	console.log("✓ Bônus cruzado de Waifus testado com sucesso!");

	// 11. Teste de resolução de apelido e fallback de nome para imagem da fazenda
	console.log("11. Testando resolução de apelido do usuário (group.nicks)...");
	const mockGroupWithNick = {
		id: testGroup,
		nicks: [
			{ numero: testUser, apelido: "Lorde Sombrio" },
			{ numero: "551100000000@s.whatsapp.net", apelido: "Outro" }
		]
	};

	const msgComNick = createMessage({
		author: testUser,
		authorName: "NomePush",
		group: testGroup
	});

	const resolvedNick = await FazendaCommands.getUserDisplayName(bot, msgComNick, mockGroupWithNick);
	assert.strictEqual(
		resolvedNick,
		"Lorde Sombrio",
		"Deveria retornar o apelido configurado no grupo"
	);

	const msgSemNick = createMessage({
		author: "5511888887777@s.whatsapp.net",
		authorName: "NomePush",
		group: testGroup
	});
	const resolvedPush = await FazendaCommands.getUserDisplayName(bot, msgSemNick, mockGroupWithNick);
	assert.strictEqual(
		resolvedPush,
		"NomePush",
		"Deveria fazer fallback para authorName quando não tem apelido"
	);

	const msgSemNome = createMessage({
		author: "5511888887777@s.whatsapp.net",
		authorName: "",
		group: testGroup
	});
	const resolvedFallback = await FazendaCommands.getUserDisplayName(
		bot,
		msgSemNome,
		mockGroupWithNick
	);
	assert.strictEqual(
		resolvedFallback,
		"Cultivador",
		"Deveria fazer fallback para 'Cultivador' quando sem nome"
	);
	console.log("✓ Resolução de apelidos e nomes testada com sucesso!");

	// 12. Teste de visibilidade dos comandos (faz-colher hidden, demais visíveis) e ranking de privacidade
	console.log("12. Testando visibilidade dos comandos da fazenda e privacidade do ranking...");

	// Verifica visibilidade dos comandos
	FazendaCommands.commands.forEach((cmd) => {
		if (cmd.name === "faz-colher") {
			assert.strictEqual(cmd.hidden, true, `Comando ${cmd.name} deveria estar hidden`);
		} else {
			assert.strictEqual(!cmd.hidden, true, `Comando ${cmd.name} não deveria estar hidden`);
		}
	});
	console.log("   ✓ Comandos validados: faz-colher está oculto e faz-colheita visível!");

	// Teste do isTestUser
	assert.strictEqual(FazendaCommands.isTestUser("test-inv-user"), true);
	assert.strictEqual(FazendaCommands.isTestUser("test_user_demo"), true);
	assert.strictEqual(FazendaCommands.isTestUser("sim_user_123"), true);
	assert.strictEqual(FazendaCommands.isTestUser("sim_test_new_user"), true);
	assert.strictEqual(FazendaCommands.isTestUser("vip_tester"), true);
	assert.strictEqual(FazendaCommands.isTestUser("5511999998888"), false);
	assert.strictEqual(FazendaCommands.isTestUser("553391214532"), false);
	console.log("   ✓ isTestUser filtrou usuários de teste e simulação corretamente!");

	// Teste do resolvePlayerRankingName
	const nickResolved = await FazendaCommands.resolvePlayerRankingName(
		bot,
		testUser,
		msgComNick,
		mockGroupWithNick
	);
	assert.strictEqual(nickResolved, "Lorde Sombrio", "Deveria resolver o apelido do grupo");

	const maskedResolved = await FazendaCommands.resolvePlayerRankingName(
		bot,
		"5599887766554",
		null,
		null
	);
	assert.strictEqual(
		maskedResolved.includes("6554"),
		true,
		"Fallback deve mascarar preservando privacidade"
	);
	assert.strictEqual(
		maskedResolved.includes("5599887766554"),
		false,
		"Fallback NÃO deve vazar o número completo"
	);
	console.log("   ✓ resolvePlayerRankingName protegeu a privacidade!");

	// Teste do comando !faz-ranking completo
	prepareStep();
	const msgRanking = createMessage({
		content: "!faz-ranking",
		author: testUser,
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgRanking);
	await waitForReply();
	assert(bot.capturedMessages.length > 0, "Deveria enviar resposta de ranking");
	const rankingContent = bot.capturedMessages[0].content;
	assert(rankingContent.toUpperCase().includes("TOP 10"), "Texto de ranking deveria conter TOP 10");
	assert(
		!rankingContent.includes("@test") && !rankingContent.includes("@sim"),
		"Ranking não deve conter usuários de teste (@test/@sim)"
	);
	assert(!rankingContent.includes("@55"), "Ranking não deve expor número com @");
	console.log("   ✓ !faz-ranking executado e validado com sucesso!");

	console.log("\n==================================================================");
	console.log("🎉 TODOS OS TESTES DA FAZENDA PASSARAM COM SUCESSO!");
	console.log("==================================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro nos testes:", err);
		process.exit(1);
	});
