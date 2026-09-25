process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const ReturnMessage = require("../models/ReturnMessage");
const Database = require("../utils/Database");
const {
	parseNameAndLink,
	parseMediaTypes,
	parseDateInput,
	buildGroupedReturnMessages,
	classifyMessageType,
	detectPost,
	refreshTrackedChannelsCache,
	simplifyChannelName,
	matchCanalInGroup,
	MAX_CANAIS_POR_GRUPO
} = require("../functions/CanaisCommands");

const database = Database.getInstance();
const DB_NAME = "canais";

async function runTests() {
	console.log("=== INICIANDO TESTES DO MÓDULO CANAIS ===");

	// -------------------------------------------------------------
	// 1. Testes de parseNameAndLink
	// -------------------------------------------------------------
	console.log("\n[1] Testando parseNameAndLink...");

	// Nome com espaços antes do link
	const res1 = parseNameAndLink(
		"Carros Antigos e Raros https://whatsapp.com/channel/0029Vb8Rr0Y8F2pML8MYtP0O"
	);
	assert.strictEqual(res1.rawName, "Carros Antigos e Raros");
	assert.strictEqual(res1.link, "https://whatsapp.com/channel/0029Vb8Rr0Y8F2pML8MYtP0O");

	// Link sem https://
	const res2 = parseNameAndLink("Mundo Animal whatsapp.com/channel/0029Va9mGR23LdQTuNiZGA1O");
	assert.strictEqual(res2.rawName, "Mundo Animal");
	assert.strictEqual(res2.link, "https://whatsapp.com/channel/0029Va9mGR23LdQTuNiZGA1O");

	// Apenas o link (sem nome)
	const res3 = parseNameAndLink("https://whatsapp.com/channel/0029Vb6VQbnDZ4LYg5ZY913N");
	assert.strictEqual(res3.rawName, null);
	assert.strictEqual(res3.link, "https://whatsapp.com/channel/0029Vb6VQbnDZ4LYg5ZY913N");

	// Rejeição de link de grupo
	const resGroup = parseNameAndLink("Grupo Qualquer https://chat.whatsapp.com/ABC123XYZ");
	assert.ok(resGroup.error, "Deve retornar erro para link chat.whatsapp.com");
	assert.ok(resGroup.error.includes("chat.whatsapp.com"));

	// Link ausente
	const resMissing = parseNameAndLink("Apenas um texto qualquer");
	assert.ok(resMissing.error, "Deve retornar erro quando não há link");
	console.log("✓ parseNameAndLink validado com sucesso!");

	// -------------------------------------------------------------
	// 1b. Testes de simplifyChannelName
	// -------------------------------------------------------------
	console.log("\n[1b] Testando simplifyChannelName...");
	assert.strictEqual(simplifyChannelName("Áudios WhatsApp - Oficial"), "Audios_WhatsApp_Oficial");
	assert.strictEqual(
		simplifyChannelName("Canal de Notícias do Brasil e Mundo"),
		"Canal_de_Noticias"
	);
	assert.strictEqual(simplifyChannelName("Carros & Motos"), "Carros_Motos");
	assert.strictEqual(simplifyChannelName("Só 1palavra"), "So_1palavra");
	assert.strictEqual(simplifyChannelName("   "), "canal");
	assert.strictEqual(simplifyChannelName("!@#$%", "fallback_canal"), "fallback_canal");
	console.log("✓ simplifyChannelName validado com sucesso!");

	// -------------------------------------------------------------
	// 1c. Testes de matchCanalInGroup
	// -------------------------------------------------------------
	console.log("\n[1c] Testando matchCanalInGroup...");
	const canaisExemplo = [
		{ apelido: "Audios_WhatsApp", apelido_normalizado: "audios_whatsapp" },
		{ apelido: "Carros", apelido_normalizado: "carros" },
		{ apelido: "Carros_Antigos", apelido_normalizado: "carros_antigos" }
	];

	// Casamento com espaço em apelido com underscore
	const match1 = matchCanalInGroup(canaisExemplo, "audios whatsapp");
	assert.strictEqual(match1.matchedCanal?.apelido, "Audios_WhatsApp");
	assert.strictEqual(match1.remainder, null);

	// Casamento com underscore
	const match2 = matchCanalInGroup(canaisExemplo, "audios_whatsapp");
	assert.strictEqual(match2.matchedCanal?.apelido, "Audios_WhatsApp");

	// Casamento com argumento restante (data)
	const match3 = matchCanalInGroup(canaisExemplo, "audios whatsapp 25/09/2026");
	assert.strictEqual(match3.matchedCanal?.apelido, "Audios_WhatsApp");
	assert.strictEqual(match3.remainder, "25/09/2026");

	// Prioridade do nome mais longo (Carros_Antigos vs Carros)
	const match4 = matchCanalInGroup(canaisExemplo, "carros antigos hoje");
	assert.strictEqual(match4.matchedCanal?.apelido, "Carros_Antigos");
	assert.strictEqual(match4.remainder, "hoje");

	// Casamento quando nome é digitado simples
	const match5 = matchCanalInGroup(canaisExemplo, "carros hoje");
	assert.strictEqual(match5.matchedCanal?.apelido, "Carros");
	assert.strictEqual(match5.remainder, "hoje");

	console.log("✓ matchCanalInGroup validado com sucesso!");

	// -------------------------------------------------------------
	// 2. Testes de parseMediaTypes
	// -------------------------------------------------------------
	console.log("\n[2] Testando parseMediaTypes...");

	// Lista padrão separada por vírgula
	const m1 = parseMediaTypes("texto, imagem, audio");
	assert.strictEqual(m1.valid, true);
	assert.deepStrictEqual(m1.types.sort(), ["audio", "imagem", "texto"]);

	// Espaços variáveis e aliases
	const m2 = parseMediaTypes("chat ,  foto ,  áudio , fig , vídeo , doc");
	assert.strictEqual(m2.valid, true);
	assert.deepStrictEqual(
		m2.types.sort(),
		["audio", "documento", "imagem", "sticker", "texto", "video"].sort()
	);

	// 'todas' retorna null (captura completa)
	const m3 = parseMediaTypes("todas");
	assert.strictEqual(m3, null);

	const m3b = parseMediaTypes("all");
	assert.strictEqual(m3b, null);

	// Tipo inválido
	const m4 = parseMediaTypes("texto, holograma, audio");
	assert.strictEqual(m4.valid, false);
	assert.ok(m4.error.includes("holograma"));
	console.log("✓ parseMediaTypes validado com sucesso!");

	// -------------------------------------------------------------
	// 3. Testes de parseDateInput
	// -------------------------------------------------------------
	console.log("\n[3] Testando parseDateInput...");

	const hoje = parseDateInput("hoje");
	assert.match(hoje, /^\d{4}-\d{2}-\d{2}$/);

	const ontem = parseDateInput("ontem");
	assert.match(ontem, /^\d{4}-\d{2}-\d{2}$/);
	assert.notStrictEqual(hoje, ontem);

	const dataFixa = parseDateInput("2026-05-15");
	assert.strictEqual(dataFixa, "2026-05-15");

	const dataBr = parseDateInput("19/04/2025");
	assert.strictEqual(dataBr, "2025-04-19");

	const dataTexto = parseDateInput("12 de outubro de 2026");
	assert.strictEqual(dataTexto, "2026-10-12");
	console.log("✓ parseDateInput validado com sucesso!");

	// -------------------------------------------------------------
	// 4. Testes de classifyMessageType
	// -------------------------------------------------------------
	console.log("\n[4] Testando classifyMessageType...");
	assert.strictEqual(classifyMessageType("image"), "imagem");
	assert.strictEqual(classifyMessageType("ptt"), "audio");
	assert.strictEqual(classifyMessageType("video"), "video");
	assert.strictEqual(classifyMessageType("sticker"), "sticker");
	assert.strictEqual(classifyMessageType("document"), "documento");
	assert.strictEqual(classifyMessageType("chat"), "texto");
	console.log("✓ classifyMessageType validado com sucesso!");

	// -------------------------------------------------------------
	// 5. Testes da regra de agrupamento em buildGroupedReturnMessages
	// -------------------------------------------------------------
	console.log("\n[5] Testando buildGroupedReturnMessages...");
	const fakeBot = new FakeBot();

	// Caso A: 0 postagens
	const msgs0 = await buildGroupedReturnMessages(
		fakeBot,
		"grp@g.us",
		[],
		"CanalTeste",
		"25/09/2026"
	);
	assert.strictEqual(msgs0.length, 1);
	assert.ok(msgs0[0].content.includes("Nenhuma postagem encontrada"));

	// Caso B: 2 postagens (< 4) -> mensagens separadas (blockSize = 1)
	const posts2 = [
		{ msg_id: "m1", tipo: "texto", texto: "Post 1", ts: 1700000000000 },
		{ msg_id: "m2", tipo: "texto", texto: "Post 2", ts: 1700001000000 }
	];
	const msgs2 = await buildGroupedReturnMessages(
		fakeBot,
		"grp@g.us",
		posts2,
		"CanalTeste",
		"25/09/2026"
	);
	assert.strictEqual(
		msgs2.length,
		2,
		"Para < 4 posts, devem ser enviadas mensagens separadas (2 msgs)"
	);
	assert.ok(msgs2[0].content.includes("Post 1"));
	assert.ok(msgs2[1].content.includes("Post 2"));

	// Caso C: 5 postagens -> 5 mensagens individuais (sem agrupamento)
	const posts5 = [
		{ msg_id: "p1", tipo: "texto", texto: "Msg 1", ts: 1700000000000 },
		{ msg_id: "p2", tipo: "texto", texto: "Msg 2", ts: 1700001000000 },
		{ msg_id: "p3", tipo: "texto", texto: "Msg 3", ts: 1700002000000 },
		{ msg_id: "p4", tipo: "texto", texto: "Msg 4", ts: 1700003000000 },
		{ msg_id: "p5", tipo: "texto", texto: "Msg 5", ts: 1700004000000 }
	];
	const msgs5 = await buildGroupedReturnMessages(
		fakeBot,
		"grp@g.us",
		posts5,
		"CanalTeste",
		"25/09/2026"
	);
	assert.strictEqual(
		msgs5.length,
		5,
		"Sem agrupamento, 5 posts devem gerar exatamente 5 mensagens individuais"
	);
	assert.ok(msgs5[0].content.includes("Msg 1"));
	assert.strictEqual(msgs5[0].options?.linkPreview, true);
	assert.ok(msgs5[4].content.includes("Msg 5"));
	assert.strictEqual(msgs5[4].options?.linkPreview, true);

	// Caso D: 10 postagens -> 10 mensagens individuais
	const posts10 = Array.from({ length: 10 }, (_, i) => ({
		msg_id: `id_${i + 1}`,
		tipo: "texto",
		texto: `Notícia ${i + 1}`,
		ts: 1700000000000 + i * 100000
	}));
	const msgs10 = await buildGroupedReturnMessages(
		fakeBot,
		"grp@g.us",
		posts10,
		"CanalTeste",
		"25/09/2026"
	);
	assert.strictEqual(msgs10.length, 10, "10 posts devem gerar 10 mensagens individuais");
	assert.ok(msgs10[0].content.includes("Notícia 1"));
	assert.ok(msgs10[9].content.includes("Notícia 10"));
	assert.strictEqual(msgs10[0].options?.linkPreview, true);
	console.log("✓ Envio individual (sem agrupamento) validado com sucesso!");

	// -------------------------------------------------------------
	// 6. Teste de banco de dados e isolamento multi-grupo
	// -------------------------------------------------------------
	console.log("\n[6] Testando persistência e isolamento multi-grupo...");

	const testCanalJid = "120363999999999999@newsletter";
	const testGroup1 = "120363000000000001@g.us";
	const testGroup2 = "120363000000000002@g.us";

	// Limpa dados de teste anteriores se houver
	await database.dbRun(DB_NAME, "DELETE FROM canal_grupos WHERE canal_jid = ?", [testCanalJid]);
	await database.dbRun(DB_NAME, "DELETE FROM canais WHERE jid = ?", [testCanalJid]);
	await database.dbRun(DB_NAME, "DELETE FROM canal_posts WHERE canal_jid = ?", [testCanalJid]);

	// Insere canal
	await database.dbRun(
		DB_NAME,
		"INSERT INTO canais (jid, invite, link, nome_oficial, descricao, criado_em) VALUES (?, ?, ?, ?, ?, ?)",
		[
			testCanalJid,
			"inv123",
			"https://whatsapp.com/channel/inv123",
			"Canal de Teste MultiGrupo",
			"Desc",
			Date.now()
		]
	);

	// Grupo 1 segue com apelido 'carros'
	await database.dbRun(
		DB_NAME,
		"INSERT INTO canal_grupos (group_id, canal_jid, apelido, apelido_normalizado, tipos_midia, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[
			testGroup1,
			testCanalJid,
			"Carros",
			"carros",
			JSON.stringify(["texto", "imagem"]),
			"5511999@s.whatsapp.net",
			Date.now()
		]
	);

	// Grupo 2 segue o MESMO canal com apelido 'veiculos' e filtro diferente
	await database.dbRun(
		DB_NAME,
		"INSERT INTO canal_grupos (group_id, canal_jid, apelido, apelido_normalizado, tipos_midia, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[
			testGroup2,
			testCanalJid,
			"Veículos",
			"veiculos",
			JSON.stringify(["audio", "sticker"]),
			"5521999@s.whatsapp.net",
			Date.now()
		]
	);

	// Atualiza cache
	await refreshTrackedChannelsCache();

	// Simula detecção de post pelo EventHandler
	const fakeNewsletterMsg = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_TEST_999",
		timestamp: Math.floor(Date.now() / 1000),
		type: "chat",
		content: "Post de teste capturado em tempo real!",
		hasMedia: false
	};

	const detected = await detectPost(fakeBot, fakeNewsletterMsg);
	assert.strictEqual(detected, true, "detectPost deve detectar canal que está sendo seguido");

	// Deduplicação: detectPost novamente com mesmo ID
	const deduplicated = await detectPost(fakeBot, fakeNewsletterMsg);
	assert.strictEqual(deduplicated, true, "detectPost deve ignorar post duplicado sem erro");

	// Confere no banco: deve haver apenas 1 post salvo
	const postInDb = await database.dbGet(
		DB_NAME,
		"SELECT * FROM canal_posts WHERE canal_jid = ? AND msg_id = ?",
		[testCanalJid, "POST_TEST_999"]
	);
	assert.ok(postInDb, "Post deve estar gravado no canal_posts");
	assert.strictEqual(postInDb.texto, "Post de teste capturado em tempo real!");

	// Mensagem de canal NÃO seguido deve ser ignorada
	const ignoredMsg = {
		isNewsletter: true,
		from: "120363000000000999@newsletter",
		id: "POST_IGNORED_1",
		type: "chat",
		content: "Não deve gravar"
	};
	const wasDetected = await detectPost(fakeBot, ignoredMsg);
	assert.strictEqual(
		wasDetected,
		false,
		"detectPost deve retornar false para canais não monitorados"
	);

	// Testa verCommand com limite de 10 posts mais recentes
	const { commands } = require("../functions/CanaisCommands");
	const cmdVer = commands.find((c) => c.name === "canal-ver");
	assert.ok(cmdVer, "Comando canal-ver deve existir");

	await database.dbRun(DB_NAME, "DELETE FROM canal_posts WHERE canal_jid = ?", [testCanalJid]);

	const hojeStr = parseDateInput("hoje");
	for (let i = 1; i <= 15; i++) {
		await database.dbRun(
			DB_NAME,
			"INSERT INTO canal_posts (canal_jid, msg_id, ts, dia, tipo, texto) VALUES (?, ?, ?, ?, ?, ?)",
			[
				testCanalJid,
				`LIMIT_TEST_${i}`,
				1700000000000 + i * 1000,
				hojeStr,
				"texto",
				`Post de teste ${i}`
			]
		);
	}

	const msgVer = createMessage({
		content: "!canal-ver Carros",
		group: testGroup1,
		author: "5511999@s.whatsapp.net"
	});
	const resVer = await cmdVer.execute(fakeBot, msgVer, ["Carros"], { id: testGroup1 });
	assert.strictEqual(
		resVer.length,
		10,
		"canal-ver deve retornar no máximo 10 mensagens individuais para o dia"
	);
	assert.ok(resVer[0].content.includes("Post de teste 6"));
	assert.ok(resVer[9].content.includes("Post de teste 15"));
	assert.strictEqual(resVer[0].options?.linkPreview, true);

	// Limpeza dos dados de teste
	await database.dbRun(DB_NAME, "DELETE FROM canal_grupos WHERE canal_jid = ?", [testCanalJid]);
	await database.dbRun(DB_NAME, "DELETE FROM canais WHERE jid = ?", [testCanalJid]);
	await database.dbRun(DB_NAME, "DELETE FROM canal_posts WHERE canal_jid = ?", [testCanalJid]);
	await refreshTrackedChannelsCache();

	console.log("✓ Isolamento e persistência no SQLite validados com sucesso!");

	// -------------------------------------------------------------
	// 7. Teste de canal-encaminhar e encaminhamento em tempo real
	// -------------------------------------------------------------
	console.log("\n[7] Testando canal-encaminhar e encaminhamento em tempo real...");

	const cmdEncaminhar = commands.find((c) => c.name === "canal-encaminhar");
	const cmdLista = commands.find((c) => c.name === "canal-lista");
	assert.ok(cmdEncaminhar, "Comando canal-encaminhar deve existir");
	assert.strictEqual(cmdEncaminhar.adminOnly, true, "canal-encaminhar deve ser apenas para admin");

	// Recria canal e grupo de teste
	await database.dbRun(
		DB_NAME,
		"INSERT INTO canais (jid, invite, link, nome_oficial, descricao, criado_em) VALUES (?, ?, ?, ?, ?, ?)",
		[
			testCanalJid,
			"inv123",
			"https://whatsapp.com/channel/inv123",
			"Canal de Teste MultiGrupo",
			"Desc",
			Date.now()
		]
	);
	await database.dbRun(
		DB_NAME,
		"INSERT INTO canal_grupos (group_id, canal_jid, apelido, apelido_normalizado, tipos_midia, encaminhar, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
		[testGroup1, testCanalJid, "Carros", "carros", null, "5511999@s.whatsapp.net", Date.now()]
	);
	await refreshTrackedChannelsCache();

	// Executa comando canal-encaminhar para ATIVAR
	const msgAdmin = createMessage({
		content: "!canal-encaminhar Carros",
		group: testGroup1,
		author: "5511999@s.whatsapp.net"
	});
	const resAtivar = await cmdEncaminhar.execute(fakeBot, msgAdmin, ["Carros"], { id: testGroup1 });
	assert.ok(resAtivar.content.includes("Encaminhamento ativado"), "Deve confirmar ativação");

	// Confere no banco: encaminhar deve ser 1
	const checkAtivado = await database.dbGet(
		DB_NAME,
		"SELECT encaminhar FROM canal_grupos WHERE group_id = ? AND canal_jid = ?",
		[testGroup1, testCanalJid]
	);
	assert.strictEqual(checkAtivado.encaminhar, 1, "Coluna encaminhar deve ser 1 após ativar");

	// Confere na lista se o emoji ⏩ aparece
	const msgLista = createMessage({
		content: "!canal-lista",
		group: testGroup1,
		author: "5511999@s.whatsapp.net"
	});
	const resLista = await cmdLista.execute(fakeBot, msgLista, [], { id: testGroup1 });
	assert.ok(
		resLista.content.includes("⏩ *Encaminhando mensagens*"),
		"canal-lista deve exibir ⏩ Encaminhando mensagens"
	);

	// Testa encaminhamento no detectPost
	fakeBot.resetCapture();
	const postParaEncaminhar = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_FWD_1",
		timestamp: Math.floor(Date.now() / 1000),
		type: "chat",
		content: "Notícia urgente do canal!",
		hasMedia: false
	};
	await detectPost(fakeBot, postParaEncaminhar);

	// fakeBot deve ter capturado a mensagem enviada para testGroup1
	assert.ok(fakeBot.capturedMessages.length > 0, "Deve ter disparado mensagem para o grupo");
	const fwdMsg = fakeBot.capturedMessages.find((m) => m.chatId === testGroup1);
	assert.ok(fwdMsg, "Mensagem deve ter sido enviada para testGroup1");
	assert.ok(
		fwdMsg.content.includes("Notícia urgente do canal!"),
		"Mensagem deve conter o texto do post"
	);
	assert.ok(fwdMsg.content.includes("Carros"), "Mensagem encaminhada deve conter o nome do canal");
	assert.strictEqual(
		fwdMsg.options?.linkPreview,
		true,
		"Mensagem encaminhada deve ter linkPreview: true"
	);

	// Executa comando canal-encaminhar para DESATIVAR
	const resDesativar = await cmdEncaminhar.execute(fakeBot, msgAdmin, ["Carros"], {
		id: testGroup1
	});
	assert.ok(
		resDesativar.content.includes("Encaminhamento desativado"),
		"Deve confirmar desativação"
	);

	const checkDesativado = await database.dbGet(
		DB_NAME,
		"SELECT encaminhar FROM canal_grupos WHERE group_id = ? AND canal_jid = ?",
		[testGroup1, testCanalJid]
	);
	assert.strictEqual(checkDesativado.encaminhar, 0, "Coluna encaminhar deve ser 0 após desativar");

	// Limpa dados de teste
	await database.dbRun(DB_NAME, "DELETE FROM canal_grupos WHERE canal_jid = ?", [testCanalJid]);
	await database.dbRun(DB_NAME, "DELETE FROM canais WHERE jid = ?", [testCanalJid]);
	await database.dbRun(DB_NAME, "DELETE FROM canal_posts WHERE canal_jid = ?", [testCanalJid]);
	await refreshTrackedChannelsCache();

	console.log("✓ canal-encaminhar e fluxo em tempo real validados com sucesso!");

	console.log("\n==========================================");
	console.log("🎉 TODOS OS TESTES PASSARAM COM SUCESSO!");
	console.log("==========================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ FALHA NOS TESTES:", err);
		process.exit(1);
	});
