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
	headerCommand,
	MAX_CANAIS_POR_GRUPO,
	HEADER_COOLDOWN_MS,
	lastChannelForwardActivity,
	resetForwardActivity
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

	// -------------------------------------------------------------
	// 8. Testes de encaminhamento de áudio/sticker e cadência de header (15 minutos)
	// -------------------------------------------------------------
	console.log("\n[8] Testando encaminhamento de mídias sem legenda e regra de 15 minutos...");

	// Re-ativa o canal para testGroup1 com encaminhamento ligado
	await database.dbRun(
		DB_NAME,
		"INSERT INTO canais (jid, invite, link, nome_oficial, descricao, criado_em) VALUES (?, ?, ?, ?, ?, ?)",
		[
			testCanalJid,
			"inv123",
			"https://whatsapp.com/channel/inv123",
			"Canal de Áudios e Figurinhas",
			"Desc",
			Date.now()
		]
	);
	await database.dbRun(
		DB_NAME,
		"INSERT INTO canal_grupos (group_id, canal_jid, apelido, apelido_normalizado, tipos_midia, encaminhar, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		[
			testGroup1,
			testCanalJid,
			"AudiosZap",
			"audioszap",
			null,
			1,
			"admin@s.whatsapp.net",
			Date.now()
		]
	);
	await refreshTrackedChannelsCache();
	resetForwardActivity();

	const fakeAudioBase64 = Buffer.from("fake-ogg-audio-content").toString("base64");
	const fakeStickerBase64 = Buffer.from("fake-webp-sticker-content").toString("base64");

	// Post 1: Áudio em t = 0 min -> deve enviar [header, áudio]
	fakeBot.resetCapture();
	const postAudio1 = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_AUDIO_1",
		timestamp: Math.floor(Date.now() / 1000),
		type: "audio",
		// Simula objeto como gerado pelo WhatsAppBotGo
		body: { mimetype: "audio/ogg; codecs=opus", url: "https://...", seconds: 7 },
		content: { mimetype: "audio/ogg; codecs=opus", url: "https://...", seconds: 7 },
		hasMedia: true,
		downloadMedia: async () => ({ data: fakeAudioBase64, mimetype: "audio/ogg" })
	};
	const detected1 = await detectPost(fakeBot, postAudio1);
	assert.strictEqual(detected1, true, "detectPost deve detectar e processar áudio com sucesso");
	assert.strictEqual(
		fakeBot.capturedMessages.length,
		2,
		"Post 1 (áudio inicial) deve disparar 2 mensagens: header + áudio"
	);
	assert.ok(
		fakeBot.capturedMessages[0].content.includes("AudiosZap"),
		"Mensagem 1 deve ser o header com o nome do canal"
	);
	assert.ok(
		fakeBot.capturedMessages[0].content.includes("🕒"),
		"Mensagem 1 deve conter o emoji de relógio"
	);
	assert.strictEqual(
		fakeBot.capturedMessages[1].options?.sendAudioAsVoice,
		true,
		"Mensagem 2 deve ser o áudio como voz"
	);

	// Post 2: Áudio após 10 minutos (<= 15 min) -> deve enviar apenas [áudio]
	fakeBot.resetCapture();
	lastChannelForwardActivity.set(`${testGroup1}:${testCanalJid}`, Date.now() - 10 * 60 * 1000);
	const postAudio2 = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_AUDIO_2",
		timestamp: Math.floor(Date.now() / 1000),
		type: "audio",
		body: { mimetype: "audio/ogg; codecs=opus", url: "https://...", seconds: 5 },
		content: { mimetype: "audio/ogg; codecs=opus", url: "https://...", seconds: 5 },
		hasMedia: true,
		downloadMedia: async () => ({ data: fakeAudioBase64, mimetype: "audio/ogg" })
	};
	await detectPost(fakeBot, postAudio2);
	assert.strictEqual(
		fakeBot.capturedMessages.length,
		1,
		"Post 2 (áudio após 10m) deve enviar APENAS 1 mensagem (áudio sem header)"
	);
	assert.strictEqual(
		fakeBot.capturedMessages[0].options?.sendAudioAsVoice,
		true,
		"Mensagem deve ser áudio direto"
	);

	// Post 3: Sticker após 12 minutos do Post 2 (<= 15 min) -> deve enviar apenas [sticker]
	fakeBot.resetCapture();
	lastChannelForwardActivity.set(`${testGroup1}:${testCanalJid}`, Date.now() - 12 * 60 * 1000);
	const postSticker3 = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_STICKER_3",
		timestamp: Math.floor(Date.now() / 1000),
		type: "sticker",
		body: { mimetype: "image/webp", url: "https://..." },
		content: { mimetype: "image/webp", url: "https://..." },
		hasMedia: true,
		downloadMedia: async () => ({ data: fakeStickerBase64, mimetype: "image/webp" })
	};
	await detectPost(fakeBot, postSticker3);
	assert.strictEqual(
		fakeBot.capturedMessages.length,
		1,
		"Post 3 (sticker após 12m) deve enviar APENAS 1 mensagem (figurinha sem header)"
	);
	assert.strictEqual(
		fakeBot.capturedMessages[0].options?.sendMediaAsSticker,
		true,
		"Mensagem deve ser sticker"
	);

	// Post 4: Áudio após 20 minutos do Post 3 (> 15 min) -> deve enviar [header, áudio]
	fakeBot.resetCapture();
	lastChannelForwardActivity.set(`${testGroup1}:${testCanalJid}`, Date.now() - 20 * 60 * 1000);
	const postAudio4 = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_AUDIO_4",
		timestamp: Math.floor(Date.now() / 1000),
		type: "audio",
		body: { mimetype: "audio/ogg; codecs=opus", url: "https://...", seconds: 9 },
		content: { mimetype: "audio/ogg; codecs=opus", url: "https://...", seconds: 9 },
		hasMedia: true,
		downloadMedia: async () => ({ data: fakeAudioBase64, mimetype: "audio/ogg" })
	};
	await detectPost(fakeBot, postAudio4);
	assert.strictEqual(
		fakeBot.capturedMessages.length,
		2,
		"Post 4 (áudio após 20m) deve disparar 2 mensagens: header + áudio"
	);
	assert.ok(
		fakeBot.capturedMessages[0].content.includes("AudiosZap"),
		"Mensagem 1 deve ser o header"
	);
	assert.strictEqual(
		fakeBot.capturedMessages[1].options?.sendAudioAsVoice,
		true,
		"Mensagem 2 deve ser o áudio"
	);

	// Limpa dados de teste
	await database.dbRun(DB_NAME, "DELETE FROM canal_grupos WHERE canal_jid = ?", [testCanalJid]);
	await database.dbRun(DB_NAME, "DELETE FROM canais WHERE jid = ?", [testCanalJid]);
	await database.dbRun(DB_NAME, "DELETE FROM canal_posts WHERE canal_jid = ?", [testCanalJid]);
	await refreshTrackedChannelsCache();
	resetForwardActivity();

	console.log(
		"✓ Encaminhamento de áudios/stickers e cadência de 15 minutos validados com sucesso!"
	);

	// -------------------------------------------------------------
	// 9. Testes de canais-header (toggle on/off e envio sem header)
	// -------------------------------------------------------------
	console.log("\n[9] Testando canais-header...");

	const cmdHeader = commands.find((c) => c.name === "canais-header");
	assert.ok(cmdHeader, "Comando canais-header deve existir");
	assert.strictEqual(cmdHeader.adminOnly, true, "canais-header deve ser adminOnly");
	assert.ok(cmdHeader.aliases.includes("canal-header"), "Deve ter alias canal-header");

	// Prepara canal no banco para testGroup1
	await database.dbRun(
		DB_NAME,
		"INSERT INTO canais (jid, invite, link, nome_oficial, descricao, criado_em) VALUES (?, ?, ?, ?, ?, ?)",
		[
			testCanalJid,
			"invHeader",
			"https://whatsapp.com/channel/invHeader",
			"Canal Header Test",
			"Desc Header",
			Date.now()
		]
	);
	await database.dbRun(
		DB_NAME,
		"INSERT INTO canal_grupos (group_id, canal_jid, apelido, apelido_normalizado, tipos_midia, encaminhar, header, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)",
		[
			testGroup1,
			testCanalJid,
			"CanalHeader",
			"canalheader",
			null,
			"admin@s.whatsapp.net",
			Date.now()
		]
	);
	await refreshTrackedChannelsCache();
	resetForwardActivity();

	// Teste 9a: Erro se usado fora de grupo
	const msgPv = createMessage({
		content: "!canais-header CanalHeader",
		author: "admin@s.whatsapp.net"
	});
	const resPv = await cmdHeader.execute(fakeBot, msgPv, ["CanalHeader"], null);
	assert.ok(
		resPv.content.includes("apenas dentro de grupos") || resPv.content.includes("dentro de grupos")
	);

	// Teste 9b: Erro se nome ausente
	const msgSemNome = createMessage({
		content: "!canais-header",
		group: testGroup1,
		author: "admin@s.whatsapp.net"
	});
	const resSemNome = await cmdHeader.execute(fakeBot, msgSemNome, [], { id: testGroup1 });
	assert.ok(resSemNome.content.includes("Como usar"));

	// Teste 9c: Erro se canal não encontrado
	const msgInexistente = createMessage({
		content: "!canais-header Inexistente",
		group: testGroup1,
		author: "admin@s.whatsapp.net"
	});
	const resInexistente = await cmdHeader.execute(fakeBot, msgInexistente, ["Inexistente"], {
		id: testGroup1
	});
	assert.ok(resInexistente.content.includes("não encontrado"));

	// Teste 9d: Desativar header (header: 1 -> 0)
	const msgToggleOff = createMessage({
		content: "!canais-header CanalHeader",
		group: testGroup1,
		author: "admin@s.whatsapp.net"
	});
	const resToggleOff = await cmdHeader.execute(fakeBot, msgToggleOff, ["CanalHeader"], {
		id: testGroup1
	});
	assert.ok(
		resToggleOff.content.includes("Cabeçalho desativado"),
		"Deve confirmar que cabeçalho foi desativado"
	);

	const checkHeaderOff = await database.dbGet(
		DB_NAME,
		"SELECT header FROM canal_grupos WHERE group_id = ? AND canal_jid = ?",
		[testGroup1, testCanalJid]
	);
	assert.strictEqual(checkHeaderOff.header, 0, "header deve ser 0 após desativar");

	// Teste 9e: Verificar se listaCommand mostra "Cabeçalho desativado"
	const cmdListaRef = commands.find((c) => c.name === "canal-lista");
	const resListaHeaderOff = await cmdListaRef.execute(fakeBot, msgToggleOff, [], {
		id: testGroup1
	});
	assert.ok(
		resListaHeaderOff.content.includes("Cabeçalho desativado"),
		"canal-lista deve indicar cabeçalho desativado"
	);

	// Teste 9f: Encaminhamento em tempo real com header DESATIVADO (texto)
	fakeBot.resetCapture();
	const postTextoHeaderOff = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_TXT_NO_HEADER",
		timestamp: Math.floor(Date.now() / 1000),
		type: "texto",
		body: "Texto original exatamente na íntegra sem prefixo nem hora!",
		content: "Texto original exatamente na íntegra sem prefixo nem hora!",
		hasMedia: false
	};
	await detectPost(fakeBot, postTextoHeaderOff);
	assert.strictEqual(fakeBot.capturedMessages.length, 1, "Deve enviar 1 mensagem de texto");
	assert.strictEqual(
		fakeBot.capturedMessages[0].content,
		"Texto original exatamente na íntegra sem prefixo nem hora!",
		"O texto deve ser enviado na íntegra sem canal ou hora"
	);
	assert.ok(
		!fakeBot.capturedMessages[0].content.includes("📢"),
		"Não deve conter prefixo do canal"
	);
	assert.ok(!fakeBot.capturedMessages[0].content.includes("🕒"), "Não deve conter horário");

	// Teste 9g: Encaminhamento em tempo real com header DESATIVADO (áudio - sem mensagem de header)
	fakeBot.resetCapture();
	resetForwardActivity();
	const postAudioHeaderOff = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_AUDIO_NO_HEADER",
		timestamp: Math.floor(Date.now() / 1000),
		type: "audio",
		body: { mimetype: "audio/ogg", url: "https://..." },
		content: { mimetype: "audio/ogg", url: "https://..." },
		hasMedia: true,
		downloadMedia: async () => ({ data: fakeAudioBase64, mimetype: "audio/ogg" })
	};
	await detectPost(fakeBot, postAudioHeaderOff);
	assert.strictEqual(
		fakeBot.capturedMessages.length,
		1,
		"Com header desativado, áudio deve gerar apenas 1 mensagem (sem header separado)"
	);
	assert.strictEqual(
		fakeBot.capturedMessages[0].options?.sendAudioAsVoice,
		true,
		"A mensagem enviada deve ser o áudio diretamente"
	);

	// Teste 9h: Encaminhamento em tempo real com header DESATIVADO (sticker - sem mensagem de header)
	fakeBot.resetCapture();
	resetForwardActivity();
	const postStickerHeaderOff = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_STICKER_NO_HEADER",
		timestamp: Math.floor(Date.now() / 1000),
		type: "sticker",
		body: { mimetype: "image/webp", url: "https://..." },
		content: { mimetype: "image/webp", url: "https://..." },
		hasMedia: true,
		downloadMedia: async () => ({ data: fakeStickerBase64, mimetype: "image/webp" })
	};
	await detectPost(fakeBot, postStickerHeaderOff);
	assert.strictEqual(
		fakeBot.capturedMessages.length,
		1,
		"Com header desativado, figurinha deve gerar apenas 1 mensagem (sem header separado)"
	);
	assert.strictEqual(
		fakeBot.capturedMessages[0].options?.sendMediaAsSticker,
		true,
		"A mensagem enviada deve ser a figurinha diretamente"
	);

	// Teste 9h2: Encaminhamento em tempo real com header DESATIVADO (imagem com legenda)
	fakeBot.resetCapture();
	const fakeImageBase64 = Buffer.from("fake-jpeg-image-content").toString("base64");
	const postImageHeaderOff = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_IMG_NO_HEADER",
		timestamp: Math.floor(Date.now() / 1000),
		type: "image",
		body: { caption: "Legenda da imagem na íntegra sem hora nem canal" },
		content: { caption: "Legenda da imagem na íntegra sem hora nem canal" },
		caption: "Legenda da imagem na íntegra sem hora nem canal",
		hasMedia: true,
		downloadMedia: async () => ({ data: fakeImageBase64, mimetype: "image/jpeg" })
	};
	await detectPost(fakeBot, postImageHeaderOff);
	assert.strictEqual(fakeBot.capturedMessages.length, 1);
	assert.strictEqual(
		fakeBot.capturedMessages[0].options?.caption,
		"Legenda da imagem na íntegra sem hora nem canal",
		"Legenda da imagem deve ser mantida na íntegra sem header/canal"
	);

	// Teste 9h3: Encaminhamento em tempo real com header DESATIVADO (imagem sem legenda)
	fakeBot.resetCapture();
	const postImageNoCaptionHeaderOff = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_IMG_NO_CAPTION",
		timestamp: Math.floor(Date.now() / 1000),
		type: "image",
		body: {},
		content: {},
		caption: "",
		hasMedia: true,
		downloadMedia: async () => ({ data: fakeImageBase64, mimetype: "image/jpeg" })
	};
	await detectPost(fakeBot, postImageNoCaptionHeaderOff);
	assert.strictEqual(fakeBot.capturedMessages.length, 1);
	assert.strictEqual(
		fakeBot.capturedMessages[0].options?.caption,
		"",
		"Imagem sem legenda não deve receber header/canal de fallback"
	);

	// Teste 9i: Teste de canal-rnd com header DESATIVADO
	const cmdRnd = commands.find((c) => c.name === "canal-rnd");
	const resRnd = await cmdRnd.execute(fakeBot, msgToggleOff, ["CanalHeader"], { id: testGroup1 });
	assert.ok(resRnd, "canal-rnd deve retornar mensagem");
	if (typeof resRnd.content === "string") {
		assert.ok(
			!resRnd.content.includes("🕒"),
			"canal-rnd com header desativado não deve conter horário"
		);
	}

	// Teste 9j: Reativar header (header: 0 -> 1)
	const resToggleOn = await cmdHeader.execute(fakeBot, msgToggleOff, ["CanalHeader"], {
		id: testGroup1
	});
	assert.ok(
		resToggleOn.content.includes("Cabeçalho ativado"),
		"Deve confirmar que cabeçalho foi ativado"
	);

	const checkHeaderOn = await database.dbGet(
		DB_NAME,
		"SELECT header FROM canal_grupos WHERE group_id = ? AND canal_jid = ?",
		[testGroup1, testCanalJid]
	);
	assert.strictEqual(checkHeaderOn.header, 1, "header deve ser 1 após reativar");

	// Teste 9k: Encaminhamento após reativar -> volta comportamento atual com canal e hora
	fakeBot.resetCapture();
	const postTextoHeaderOn = {
		isNewsletter: true,
		from: testCanalJid,
		id: "POST_TXT_WITH_HEADER",
		timestamp: Math.floor(Date.now() / 1000),
		type: "texto",
		body: "Texto com cabeçalho ativado!",
		content: "Texto com cabeçalho ativado!",
		hasMedia: false
	};
	await detectPost(fakeBot, postTextoHeaderOn);
	assert.strictEqual(fakeBot.capturedMessages.length, 1);
	assert.ok(
		fakeBot.capturedMessages[0].content.includes("📢 *CanalHeader*"),
		"Deve incluir nome do canal"
	);
	assert.ok(fakeBot.capturedMessages[0].content.includes("🕒"), "Deve incluir horário");

	// Limpa dados de teste
	await database.dbRun(DB_NAME, "DELETE FROM canal_grupos WHERE canal_jid = ?", [testCanalJid]);
	await database.dbRun(DB_NAME, "DELETE FROM canais WHERE jid = ?", [testCanalJid]);
	await database.dbRun(DB_NAME, "DELETE FROM canal_posts WHERE canal_jid = ?", [testCanalJid]);
	await refreshTrackedChannelsCache();
	resetForwardActivity();

	console.log("✓ canais-header validado com sucesso!");

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
