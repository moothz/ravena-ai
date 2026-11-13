"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const EventHandler = require("../EventHandler");
const PvSafetyService = require("../services/PvSafetyService");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const WaifuCommands = require("../functions/WaifuCommands");
const ShadowGardenClient = require("../services/ShadowGardenClient");

async function waitUntil(predicate, maxMs = 4000) {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 30));
	}
	return false;
}

async function runTests() {
	console.log("=== INICIANDO TESTES: PV SAFETY, WHITELIST, ANONIMO E VCARD 45 DIAS ===");

	const database = Database.getInstance({ testMode: true });
	database.testMode = true;

	const pvSafety = PvSafetyService.getInstance();
	pvSafety.resetTestState();

	const botA = new FakeBot({
		id: "ravenavip",
		nomeExibir: "ravenavip",
		phoneNumber: "555591535538",
		privado: false,
		ignorePV: true,
		grupoLogs: "120363041254059254@g.us"
	});
	botA.notInWhitelist = () => true;

	const botB = new FakeBot({
		id: "ravena2",
		nomeExibir: "ravena2",
		phoneNumber: "555599990000",
		privado: false,
		ignorePV: false,
		grupoLogs: "120363041254059254@g.us"
	});
	botB.notInWhitelist = () => true;

	const botPriv = new FakeBot({
		id: "rav-lulu",
		nomeExibir: "Lulu",
		phoneNumber: "5511900001111",
		privado: true,
		ignorePV: true,
		grupoLogs: "120363041254059254@g.us"
	});

	const tgBot = {
		id: "ravena-tg",
		useTelegram: true,
		useDiscord: false
	};

	const eventHandler = EventHandler.getInstance();
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	eventHandler.commandHandler.checkCooldown = async () => ({ inCooldown: false, timeLeft: 0 });
	eventHandler.commandHandler.adminUtils.isAdmin = async () => true;

	const groupId = "120363000111222@g.us";
	const mockGroup = {
		id: groupId,
		name: "grupotestepv",
		prefix: "!",
		paused: false,
		additionalAdmins: [],
		mutedCommands: []
	};

	// Prepara mocks em botA e botB para EventHandler/CommandHandler
	for (const b of [botA, botB]) {
		b.getGroup = async () => mockGroup;
		b.isUserAdminInGroup = async () => true;
		b.isAdmin = async () => true;
		b.getContactDetails = async (jid) => ({ name: "Usuário Teste", pushname: "Tester", id: jid });
	}
	database.getGroup = async (id) => (id === groupId ? mockGroup : null);
	database.saveGroup = async () => true;

	// 1. Testes unitários do PvSafetyService
	console.log(
		"\n[1] Validando PvSafetyService (isPvTarget, variantes BR, isolamento por bot, LID)..."
	);
	assert.strictEqual(pvSafety.isPvTarget("5511999999999@s.whatsapp.net"), true);
	assert.strictEqual(pvSafety.isPvTarget("5511999999999@c.us"), true);
	assert.strictEqual(pvSafety.isPvTarget("1234567890@lid"), true);
	assert.strictEqual(pvSafety.isPvTarget("120363041254059254@g.us"), false);
	assert.strictEqual(
		pvSafety.isPvTarget("120363428261925083"),
		false,
		"Grupo legado 120363... não é PV"
	);
	assert.strictEqual(pvSafety.isPvTarget("status@broadcast"), false);
	assert.strictEqual(pvSafety.isPvTarget("12345@newsletter"), false);

	// Não registra mensagem de grupo, newsletter ou fromMe
	assert.strictEqual(
		await pvSafety.recordPvInteraction(
			botA,
			createMessage({ author: "5511912345678@s.whatsapp.net", group: groupId })
		),
		false
	);
	assert.strictEqual(
		await pvSafety.recordPvInteraction(
			botA,
			createMessage({ author: "5511912345678@s.whatsapp.net", group: null, isNewsletter: true })
		),
		false
	);
	assert.strictEqual(
		await pvSafety.recordPvInteraction(
			botA,
			createMessage({ author: "5511912345678@s.whatsapp.net", group: null, fromMe: true })
		),
		false
	);
	assert.strictEqual(await pvSafety.hasPvInteraction(botA, "5511912345678@s.whatsapp.net"), false);

	// Variantes 12/13 dígitos e isolamento (bot, usuario)
	await pvSafety.recordPvInteraction(
		botA,
		createMessage({ author: "554784023920@s.whatsapp.net", group: null })
	);
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botA, "5547984023920@c.us"),
		true,
		"Variante de 13 dígitos deve casar com 12 dígitos no mesmo bot"
	);
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botB, "554784023920@s.whatsapp.net"),
		false,
		"Interação em PV com botA não deve liberar botB"
	);

	// Resolução LID <-> PN
	botA.lidToPnCache = botA.lidToPnCache || new Map();
	botA.lidToPnCache.set("998877665544@lid", "5511988776655@s.whatsapp.net");
	await pvSafety.recordPvInteraction(
		botA,
		createMessage({ author: "998877665544@lid", group: null })
	);
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botA, "5511988776655@s.whatsapp.net"),
		true,
		"PN mapeado pelo lidToPnCache deve herdar liberação registrada via @lid"
	);

	// Grupos antigos sem sufixo no formato <criador>-<timestamp> não são PV
	assert.strictEqual(pvSafety.isPvTarget("5511999999999-1580000000"), false);
	assert.strictEqual(pvSafety.isPvTarget("5511999999999-1580000000@g.us"), false);

	// Formato de produção: message.author chega como dígitos soltos (LID ainda sem mapeamento PN)
	const prodLid = "123450000099999";
	const prodPn = "5521977776666";
	const buildProdPvMessage = (withPn = false) => {
		const msg = createMessage({ author: prodLid, group: null, content: "oi" });
		msg.from = `${prodLid}@lid`;
		msg.authorAlt = withPn ? `${prodPn}@s.whatsapp.net` : undefined;
		msg.goMessageData = {
			Info: {
				Sender: `${prodLid}@lid`,
				SenderAlt: withPn ? `${prodPn}@s.whatsapp.net` : undefined,
				Chat: `${prodLid}@lid`
			}
		};
		return msg;
	};
	await pvSafety.recordPvInteraction(botA, buildProdPvMessage(false));
	pvSafety.clearInboundAllowance(); // força o caminho do "banco" (sem a liberação em memória)
	const botAKey = pvSafety.getBotKey(botA);
	const prodRows = Array.from(pvSafety._testRecords.get(botAKey).values()).filter(
		(r) => r.user_lid === `${prodLid}@lid`
	);
	assert.strictEqual(prodRows.length, 1);
	assert.strictEqual(
		prodRows[0].user_key,
		`${prodLid}@lid`,
		"Dígitos soltos iguais ao Info.Sender @lid devem ser gravados como LID (não como telefone)"
	);
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botA, prodLid),
		true,
		"Resposta para o author (dígitos soltos) deve casar com o registro @lid"
	);
	assert.strictEqual(await pvSafety.hasPvInteraction(botA, `${prodLid}@lid`), true);
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botA, `${prodPn}@s.whatsapp.net`),
		false,
		"Sem mapeamento LID->PN ainda não há como saber que o PN é a mesma pessoa"
	);
	// Mapeamento aprendido depois (ex.: mensagem em grupo com SenderAlt): consulta pelo PN encontra o LID
	botA.lidToPnCache.set(prodLid, prodPn);
	botA.lidToPnCache.set(`${prodLid}@lid`, prodPn);
	botA.getLidFromPn = WhatsAppBotGo.prototype.getLidFromPn;
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botA, `${prodPn}@s.whatsapp.net`),
		true,
		"PN aprendido depois deve achar o registro gravado só com o LID"
	);
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botA, "552177776666"),
		true,
		"Variante de 12 dígitos (dígitos soltos) do PN também deve casar"
	);
	// Nova mensagem no PV já com o PN: promove a chave para o telefone e grava user_pn
	await pvSafety.recordPvInteraction(botA, buildProdPvMessage(true));
	const promoted = Array.from(pvSafety._testRecords.get(botAKey).values()).filter(
		(r) => r.user_lid === `${prodLid}@lid`
	);
	assert.strictEqual(promoted.length, 1, "Promoção LID -> PN não deve duplicar registros");
	assert.strictEqual(promoted[0].user_key, prodPn);
	assert.strictEqual(promoted[0].user_pn, prodPn);
	delete botA.getLidFromPn;

	// Reação: só quem reagiu conta (não o autor da mensagem reagida)
	const reactionMsg = createMessage({
		author: "5531988887777@s.whatsapp.net",
		group: groupId,
		content: "x"
	});
	reactionMsg.goMessageData = { Info: { Sender: "5599911112222@s.whatsapp.net" } };
	reactionMsg.authorAlt = "5531988887777@s.whatsapp.net";
	reactionMsg.originReaction = { senderId: "5531988887777@s.whatsapp.net", reaction: "👍" };
	const reactionIdentity = await pvSafety.resolveIdentity(botA, reactionMsg);
	assert.ok(reactionIdentity.pnKeys.includes("5531988887777"));
	assert.ok(
		!reactionIdentity.pnKeys.includes("5599911112222"),
		"Autor da mensagem reagida não pode entrar na identidade de quem reagiu"
	);

	// Throttle: com has_pv=1 e nada novo, no máximo 1 gravação por hora por usuário
	const originalUpsert = pvSafety._upsertRecord.bind(pvSafety);
	let upsertCalls = 0;
	pvSafety._upsertRecord = async (...args) => {
		upsertCalls++;
		return originalUpsert(...args);
	};
	const throttleMsg = () =>
		createMessage({ author: "5541977771234@s.whatsapp.net", group: null, content: "oi" });
	await pvSafety.recordPvInteraction(botA, throttleMsg());
	await pvSafety.recordPvInteraction(botA, throttleMsg());
	await pvSafety.recordPvInteraction(botA, throttleMsg());
	assert.strictEqual(upsertCalls, 1, "Mensagens repetidas no PV não devem regravar pv_users");
	const throttleWithLid = throttleMsg();
	throttleWithLid.authorAlt = "998800001111@lid";
	await pvSafety.recordPvInteraction(botA, throttleWithLid);
	assert.strictEqual(upsertCalls, 2, "Informação nova (LID) deve ser gravada mesmo dentro de 1h");
	pvSafety._upsertRecord = originalUpsert;

	// Fail-open: erro no SQLite libera o envio (e é logado) em vez de bloquear respostas
	const originalFind = pvSafety._findRecords;
	pvSafety._findRecords = async () => {
		throw new Error("SQLITE_BUSY: database is locked");
	};
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botA, "5561911112222@s.whatsapp.net"),
		true,
		"Erro de consulta em pv_users deve liberar (fail-open)"
	);
	await assert.rejects(
		() =>
			pvSafety.recordPvInteraction(
				botA,
				createMessage({ author: "5561911113333@s.whatsapp.net", group: null })
			),
		/SQLITE_BUSY/
	);
	pvSafety._findRecords = originalFind;
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botA, "5561911113333@s.whatsapp.net"),
		true,
		"Mesmo com falha na gravação, a liberação em memória (24h) cobre a resposta direta"
	);
	pvSafety.clearInboundAllowance();
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botA, "5561911113333@s.whatsapp.net"),
		false,
		"Sem a liberação em memória e sem registro gravado, continua bloqueado"
	);

	// Telegram/Discord nunca bloqueiam e nunca enviam vCard
	assert.strictEqual(pvSafety.isWhatsAppBot(tgBot), false);
	assert.strictEqual(pvSafety.shouldSendVcard(tgBot), false);
	assert.deepStrictEqual(
		await pvSafety.ensureGroupPvAllowed(tgBot, createMessage({ group: groupId, author: "12345" })),
		{ allowed: true, returnMessage: null }
	);

	// Privado vs Público para vCard + cooldown de 45 dias + hash/organização aleatórios
	const pvUser = "5521988887777@s.whatsapp.net";
	const t0 = 1_700_000_000_000;
	assert.strictEqual(await pvSafety.shouldSendVcardNow(botA, pvUser, t0), true);
	assert.strictEqual(
		await pvSafety.shouldSendVcardNow(botPriv, pvUser, t0),
		false,
		"Bot privado não envia vCard"
	);
	await pvSafety.markVcardSent(botA, pvUser, t0);
	assert.strictEqual(
		await pvSafety.shouldSendVcardNow(botA, pvUser, t0 + 44 * 24 * 60 * 60 * 1000),
		false,
		"Não deve reenviar vCard antes de 45 dias"
	);
	assert.strictEqual(
		await pvSafety.shouldSendVcardNow(botA, pvUser, t0 + 45 * 24 * 60 * 60 * 1000),
		true,
		"Deve liberar reenvio após 45 dias"
	);

	const vc1 = pvSafety.buildVcardPayload(botA);
	const vc2 = pvSafety.buildVcardPayload(botA);
	assert.strictEqual(vc1.isContact, true);
	assert.strictEqual(vc1.name, "ravenavip");
	assert.strictEqual(vc1.number, "555591535538");
	assert.match(vc1.organization, /^Ravena AI \[[0-9a-f]{8}\]$/);
	assert.notStrictEqual(vc1.organization, vc2.organization);

	const rem1 = pvSafety.buildVcardReminderMessage();
	const rem2 = pvSafety.buildVcardReminderMessage();
	assert.match(
		rem1,
		/^Salve a ravena nos seus contatos! Isso nos ajuda a prevenir os bans 👊\n> [0-9a-f]{10}$/
	);
	assert.notStrictEqual(rem1, rem2);
	console.log("✓ Testes unitários do PvSafetyService passaram!");

	// 2. Comandos de grupo que enviam PV DEVEM bloquear sem interação prévia no PV
	console.log(
		"\n[2] Testando bloqueio no grupo para comandos de PV (!g-painel, !g-manage, !mu-adm, !waifinder, !faz-adm, !banco-adm)..."
	);
	pvSafety.resetTestState();
	const coldUser = "5531999991111@s.whatsapp.net";

	const originalWaifuPost = WaifuCommands.api.post;
	const originalJardimAdminUrl = ShadowGardenClient.prototype.getAdminUrl;
	const originalJardimStatus = ShadowGardenClient.prototype.getStatus;
	let waifuEnsureCalled = false;
	let jardimUrlCalled = false;
	WaifuCommands.api.post = async (url) => {
		if (url === "/user/ensure") waifuEnsureCalled = true;
		return {
			data: {
				success: true,
				data: {
					publicId: "u-test-1234",
					token: "tok-test-5678",
					url: "https://waifuletes.moothz.com/user/u-test-1234?token=tok-test-5678",
					waifinderUrl: "https://waifuletes.moothz.com/catalogo?token=tok-test-5678",
					expiresIn: 1800
				}
			}
		};
	};
	ShadowGardenClient.prototype.getAdminUrl = async () => {
		jardimUrlCalled = true;
		return { url: "https://jardim.moothz.com/admin" };
	};
	ShadowGardenClient.prototype.getStatus = async () => ({
		success: true,
		coins: 0,
		inventory: []
	});

	const resetHandlerStep = (targetBot = botA) => {
		targetBot.resetCapture();
		eventHandler.commandHandler.userDebounceMap?.clear();
	};

	const blockedCommands = [
		"!g-painel",
		"!g-manage",
		"!mu-adm",
		"!waifinder",
		"!faz-adm",
		"!banco-adm"
	];
	for (const cmd of blockedCommands) {
		resetHandlerStep(botA);
		await eventHandler.processMessage(
			botA,
			createMessage({ content: cmd, group: groupId, author: coldUser })
		);
		const gotReply = await waitUntil(() => botA.capturedMessages.length > 0);
		assert.strictEqual(gotReply, true, `${cmd} deveria responder no grupo quando bloqueado`);
		assert.strictEqual(
			botA.capturedMessages.length,
			1,
			`${cmd} não deveria enviar PV além do aviso no grupo`
		);
		assert.strictEqual(
			botA.capturedMessages[0].chatId,
			groupId,
			`${cmd} bloqueado deve responder no grupo`
		);
		assert.strictEqual(
			botA.capturedMessages[0].content,
			pvSafety.PV_REQUIRED_MESSAGE,
			`${cmd} deve retornar a mensagem padrão de solicitação no PV`
		);
	}
	assert.strictEqual(
		waifuEnsureCalled,
		false,
		"!mu-adm/!waifinder bloqueados não devem chamar ensureUser"
	);
	assert.strictEqual(jardimUrlCalled, false, "!faz-adm bloqueado não deve chamar getAdminUrl");
	console.log("✓ Todos os 6 comandos bloquearam corretamente no grupo antes de enviar PV!");

	// 3. !anonimo e !adminanon no grupo devem instruir a usar no privado (nunca enviar PV)
	console.log("\n[3] Testando !anonimo e !adminanon no grupo...");
	resetHandlerStep(botA);
	await eventHandler.processMessage(
		botA,
		createMessage({ content: "!anonimo grupotestepv ola", group: groupId, author: coldUser })
	);
	assert.strictEqual(await waitUntil(() => botA.capturedMessages.length > 0), true);
	assert.strictEqual(
		botA.capturedMessages[0].chatId,
		groupId,
		"!anonimo no grupo deve responder no grupo"
	);
	assert.ok(
		botA.capturedMessages[0].content.includes("O comando deve ser usado no meu privado!"),
		"!anonimo deve instruir a usar no privado"
	);
	assert.ok(
		botA.capturedMessages[0].content.includes(groupId),
		"!anonimo deve incluir o ID do grupo nas instruções"
	);
	assert.ok(
		botA.capturedMessages[0].content.includes("Exemplo:"),
		"!anonimo deve incluir exemplo de mensagem"
	);

	resetHandlerStep(botA);
	await eventHandler.processMessage(
		botA,
		createMessage({ content: "!adminanon list", group: groupId, author: coldUser })
	);
	assert.strictEqual(await waitUntil(() => botA.capturedMessages.length > 0), true);
	assert.strictEqual(
		botA.capturedMessages[0].chatId,
		groupId,
		"!adminanon no grupo deve responder no grupo"
	);
	assert.strictEqual(botA.capturedMessages[0].content, "O comando deve ser usado no meu privado!");
	console.log("✓ !anonimo e !adminanon bloqueados no grupo com instruções corretas!");

	// 4. ignorePV: true + CMD_WHITELIST: registra interação e executa comando no PV
	console.log(
		"\n[4] Testando ignorePV: true + whitelisted PV commands e liberação subsequente no grupo..."
	);
	const ignorePvCmds = ["!mu-adm", "!faz-adm", "!banco-adm", "!g-painel"];
	for (const cmd of ignorePvCmds) {
		resetHandlerStep(botA);
		await eventHandler.processMessage(
			botA,
			createMessage({ content: cmd, group: null, author: coldUser })
		);
		const replied = await waitUntil(() => botA.capturedMessages.length > 0);
		assert.strictEqual(replied, true, `${cmd} no PV deve responder mesmo com ignorePV=true`);
	}
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botA, coldUser),
		true,
		"Interação em PV com botA (ignorePV: true) deve ficar registrada"
	);
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botB, coldUser),
		false,
		"Interação com botA NÃO deve liberar botB"
	);

	// Mesmo mensagem comum no PV (sem comando whitelisted) deve gravar hasPv
	const casualPvUser = "5531999992222@s.whatsapp.net";
	resetHandlerStep(botA);
	await eventHandler.processMessage(
		botA,
		createMessage({ content: "oi ravena tudo bem?", group: null, author: casualPvUser })
	);
	assert.strictEqual(
		await pvSafety.hasPvInteraction(botA, casualPvUser),
		true,
		"Qualquer mensagem comum no PV deve ser gravada antes do filtro ignorePV"
	);

	// Falha ao gravar em pv_users (SQLite) não pode derrubar o processamento da mensagem no PV
	const originalRecordPv = pvSafety.recordPvInteraction;
	pvSafety.recordPvInteraction = async () => {
		throw new Error("SQLITE_IOERR: disk I/O error");
	};
	resetHandlerStep(botA);
	await eventHandler.processMessage(
		botA,
		createMessage({ content: "!mu-adm", group: null, author: "5531999993333@s.whatsapp.net" })
	);
	assert.strictEqual(
		await waitUntil(() => botA.capturedMessages.length > 0),
		true,
		"Comando no PV deve responder mesmo com falha ao gravar pv_users"
	);
	pvSafety.recordPvInteraction = originalRecordPv;

	// Agora coldUser executa no grupo via botA -> PERMITIDO!
	for (const cmd of ["!g-painel", "!g-manage", "!mu-adm", "!waifinder", "!faz-adm", "!banco-adm"]) {
		resetHandlerStep(botA);
		await eventHandler.processMessage(
			botA,
			createMessage({ content: cmd, group: groupId, author: coldUser })
		);
		const ok = await waitUntil(() => botA.capturedMessages.length > 0);
		assert.strictEqual(ok, true, `${cmd} deveria responder após interação em PV`);
		const hasBlockedMsg = botA.capturedMessages.some(
			(m) => m.content === pvSafety.PV_REQUIRED_MESSAGE
		);
		assert.strictEqual(
			hasBlockedMsg,
			false,
			`${cmd} não deveria mais ser bloqueado após PV com botA`
		);
		const sentToPv = botA.capturedMessages.some((m) => m.chatId === coldUser);
		assert.strictEqual(sentToPv, true, `${cmd} liberado deveria enviar retorno no PV`);
	}

	// Em botB, coldUser continua bloqueado porque nunca chamou botB no PV
	resetHandlerStep(botB);
	await eventHandler.processMessage(
		botB,
		createMessage({ content: "!g-painel", group: groupId, author: coldUser })
	);
	assert.strictEqual(await waitUntil(() => botB.capturedMessages.length > 0), true);
	assert.strictEqual(
		botB.capturedMessages[0].content,
		pvSafety.PV_REQUIRED_MESSAGE,
		"!g-painel no botB deve continuar bloqueado enquanto coldUser não chamar botB no PV"
	);
	console.log("✓ Whitelist no PV, ignorePV e liberação isolada por bot validados!");

	// Restaura mocks dos comandos
	WaifuCommands.api.post = originalWaifuPost;
	ShadowGardenClient.prototype.getAdminUrl = originalJardimAdminUrl;
	ShadowGardenClient.prototype.getStatus = originalJardimStatus;

	// 5. WhatsAppBotGo.sendMessage: defesa em profundidade + envio de vCard a cada 45 dias apenas em não-privado
	console.log(
		"\n[5] Testando WhatsAppBotGo.sendMessage (bloqueio frio em PV + vCard em bot público vs privado)..."
	);
	pvSafety.resetTestState();

	const createSpyBot = (opts) => {
		const calls = [];
		const inst = new WhatsAppBotGo({
			id: opts.id,
			nomeExibir: opts.nomeExibir,
			phoneNumber: opts.phoneNumber,
			privado: opts.privado,
			whatsgoApiUrl: "http://localhost:8080",
			whatsgoApiKey: "test-key",
			instanceName: opts.id,
			webhookHost: "http://localhost:3000"
		});
		inst.isConnected = true;
		inst.isParticipating = () => true;
		inst.pvVcardDebounceMs = 0;
		inst.apiClient = {
			post: async (endpoint, payload) => {
				if (typeof opts.failPost === "function" && opts.failPost(endpoint, payload)) {
					throw new Error(`Falha simulada em ${endpoint}`);
				}
				calls.push({ endpoint, payload });
				return { data: { Info: { ID: `msg-${calls.length}` } } };
			}
		};
		return { inst, calls };
	};
	const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

	const publicGo = createSpyBot({
		id: "ravenavip-go",
		nomeExibir: "Ravena VIP",
		phoneNumber: "555591535538",
		privado: false
	});
	const privGo = createSpyBot({
		id: "rav-lulu-go",
		nomeExibir: "Lulu",
		phoneNumber: "5511900001111",
		privado: true
	});

	const coldTarget = "5561999990000@s.whatsapp.net";
	await assert.rejects(
		() => publicGo.inst.sendMessage(coldTarget, "Mensagem fria não solicitada"),
		(err) => {
			assert.strictEqual(err.code, "PV_COLD_BLOCKED");
			assert.strictEqual(err.blockedByPvSafety, true);
			assert.strictEqual(PvSafetyService.isColdBlockedError(err), true);
			return true;
		},
		"sendMessage deve lançar erro tipado ao bloquear envio frio em PV"
	);
	assert.strictEqual(publicGo.calls.length, 0, "Nenhuma chamada HTTP deve ocorrer no bloqueio");

	// Caminho genérico (sendReturnMessages) não lança: devolve o resultado marcado como bloqueado
	const ReturnMessage = require("../models/ReturnMessage");
	const coldResults = await publicGo.inst.sendReturnMessages(
		new ReturnMessage({ chatId: coldTarget, content: "Aviso automático" })
	);
	assert.strictEqual(coldResults.length, 1);
	assert.strictEqual(coldResults[0].blockedByPvSafety, true);
	assert.strictEqual(coldResults[0].error?.code, "PV_COLD_BLOCKED");
	assert.ok(!coldResults[0].id, "Bloqueio não pode devolver id de mensagem falso");
	assert.strictEqual(publicGo.calls.length, 0);

	// Loop de fallback entre bots (ex.: gamesRoutes.sendGameNotice) deve pular o bot bloqueado
	const { sendGameNotice } = require("../BotAPI/routes/gamesRoutes");
	const fallbackCold = createSpyBot({
		id: "fallback-cold",
		nomeExibir: "Fria",
		phoneNumber: "5511900002222",
		privado: true
	});
	const fallbackWarm = createSpyBot({
		id: "fallback-warm",
		nomeExibir: "Quente",
		phoneNumber: "5511900003333",
		privado: true
	});
	const fallbackTarget = "5561988887777@s.whatsapp.net";
	await pvSafety.recordPvInteraction(fallbackWarm.inst, fallbackTarget);
	const noticeLogs = [];
	const delivered = await sendGameNotice(
		{
			bots: [fallbackCold.inst, fallbackWarm.inst],
			logger: { info: (m) => noticeLogs.push(m), warn: (m) => noticeLogs.push(m) }
		},
		fallbackTarget,
		"Bônus creditado!"
	);
	assert.strictEqual(delivered, true, "Algum bot com PV prévio deve entregar o aviso");
	assert.strictEqual(fallbackCold.calls.length, 0, "Bot sem PV prévio não pode enviar");
	assert.strictEqual(fallbackWarm.calls.length, 1, "Fallback deve seguir para o próximo bot");
	assert.strictEqual(fallbackWarm.calls[0].payload.text, "Bônus creditado!");

	// Grupos (@g.us e legado 120363...) e o próprio número não são bloqueados
	await publicGo.inst.sendMessage("120363041254059254@g.us", "log normal");
	await publicGo.inst.sendMessage("120363428261925083", "log legado");
	await publicGo.inst.sendMessage("555591535538@s.whatsapp.net", "auto-teste");
	assert.strictEqual(publicGo.calls.length, 3, "Grupos e próprio número devem enviar sem vCard");

	// Registra interação PV no publicGo -> envia mensagem principal + vCard + lembrete na 1ª vez
	publicGo.calls.length = 0;
	await pvSafety.recordPvInteraction(publicGo.inst, coldTarget);
	await publicGo.inst.sendMessage(coldTarget, "Sua resposta aqui", {
		vcardDelay: 0,
		vcardReminderDelay: 0
	});
	assert.strictEqual(
		publicGo.calls.length,
		1,
		"sendMessage não deve esperar o vCard (agendado para depois do envio)"
	);
	assert.strictEqual(await waitUntil(() => publicGo.calls.length >= 3), true);
	assert.strictEqual(publicGo.calls.length, 3, "Deveria enviar resposta + vCard + lembrete");
	assert.strictEqual(publicGo.calls[0].endpoint, "/send/text");
	assert.strictEqual(publicGo.calls[0].payload.text, "Sua resposta aqui");
	assert.strictEqual(publicGo.calls[1].endpoint, "/send/contact");
	assert.strictEqual(publicGo.calls[1].payload.vcard.fullName, "Ravena VIP");
	assert.strictEqual(publicGo.calls[1].payload.vcard.phone, "555591535538");
	assert.match(publicGo.calls[1].payload.vcard.organization, /^Ravena AI \[[0-9a-f]{8}\]$/);
	assert.strictEqual(publicGo.calls[2].endpoint, "/send/text");
	assert.match(
		publicGo.calls[2].payload.text,
		/^Salve a ravena nos seus contatos! Isso nos ajuda a prevenir os bans 👊\n> [0-9a-f]{10}$/
	);

	// 2ª mensagem antes de 45 dias NÃO envia vCard novamente
	publicGo.calls.length = 0;
	await publicGo.inst.sendMessage(coldTarget, "Segunda resposta");
	await sleepMs(150);
	assert.strictEqual(publicGo.calls.length, 1, "Dentro dos 45 dias não deve reenviar vCard");

	// Bot privado NUNCA envia vCard mesmo após PV registrado
	await pvSafety.recordPvInteraction(privGo.inst, coldTarget);
	await privGo.inst.sendMessage(coldTarget, "Oi do bot privado");
	await sleepMs(150);
	assert.strictEqual(privGo.calls.length, 1, "Bot privado não deve enviar vCard");
	assert.strictEqual(privGo.calls[0].endpoint, "/send/text");

	// Resposta em várias partes: o vCard vai só depois da última parte (nunca no meio)
	const multiTarget = "5521955554444@s.whatsapp.net";
	await pvSafety.recordPvInteraction(publicGo.inst, multiTarget);
	publicGo.calls.length = 0;
	await publicGo.inst.sendReturnMessages([
		new ReturnMessage({ chatId: multiTarget, content: "Parte 1" }),
		new ReturnMessage({ chatId: multiTarget, content: "Parte 2", delay: 30 }),
		new ReturnMessage({ chatId: multiTarget, content: "Parte 3", delay: 30 })
	]);
	assert.strictEqual(await waitUntil(() => publicGo.calls.length >= 5), true);
	const describeCall = (c) =>
		c.endpoint === "/send/contact"
			? "vcard"
			: String(c.payload.text || "").startsWith("Salve a ravena")
				? "lembrete"
				: c.payload.text;
	assert.deepStrictEqual(
		publicGo.calls.map(describeCall),
		["Parte 1", "Parte 2", "Parte 3", "vcard", "lembrete"],
		"vCard e lembrete devem vir depois de todas as partes"
	);
	// skipVcard explícito na ReturnMessage é respeitado
	const skipTarget = "5521955553333@s.whatsapp.net";
	await pvSafety.recordPvInteraction(publicGo.inst, skipTarget);
	publicGo.calls.length = 0;
	await publicGo.inst.sendReturnMessages(
		new ReturnMessage({ chatId: skipTarget, content: "Sem vCard", options: { skipVcard: true } })
	);
	await sleepMs(150);
	assert.strictEqual(publicGo.calls.length, 1, "skipVcard deve suprimir o vCard");

	// Falha no texto de lembrete: o vCard já foi aceito, então fica marcado (sem reenvio a cada msg)
	const flakyGo = createSpyBot({
		id: "flaky-vcard-go",
		nomeExibir: "Flaky",
		phoneNumber: "5511900004444",
		privado: false,
		failPost: (endpoint, payload) =>
			endpoint === "/send/text" && String(payload.text || "").startsWith("Salve a ravena")
	});
	const flakyTarget = "5521944443333@s.whatsapp.net";
	await pvSafety.recordPvInteraction(flakyGo.inst, flakyTarget);
	await flakyGo.inst.sendMessage(flakyTarget, "Primeira");
	assert.strictEqual(
		await waitUntil(() => flakyGo.calls.some((c) => c.endpoint === "/send/contact")),
		true
	);
	await sleepMs(100);
	assert.strictEqual(
		await pvSafety.shouldSendVcardNow(flakyGo.inst, flakyTarget),
		false,
		"vCard aceito deve ser marcado mesmo se o texto de lembrete falhar"
	);
	flakyGo.calls.length = 0;
	await flakyGo.inst.sendMessage(flakyTarget, "Segunda");
	await sleepMs(150);
	assert.deepStrictEqual(
		flakyGo.calls.map((c) => c.endpoint),
		["/send/text"],
		"Não deve reenviar o vCard na mensagem seguinte"
	);

	// Lock pela identidade canônica: 12 x 13 dígitos do mesmo número disputam o mesmo lock
	const lockGo = createSpyBot({
		id: "lock-vcard-go",
		nomeExibir: "Lock",
		phoneNumber: "5511900005555",
		privado: false
	});
	await Promise.all([
		lockGo.inst._maybeSendPvVcardReminder("5521966665555@s.whatsapp.net", {
			vcardDelay: 0,
			vcardReminderDelay: 0
		}),
		lockGo.inst._maybeSendPvVcardReminder("552166665555", { vcardDelay: 0, vcardReminderDelay: 0 })
	]);
	assert.strictEqual(
		lockGo.calls.filter((c) => c.endpoint === "/send/contact").length,
		1,
		"Variantes do mesmo número não podem gerar dois vCards"
	);
	console.log(
		"✓ WhatsAppBotGo.sendMessage (bloqueio frio, vCard 45 dias e bots privados) validado!"
	);

	// 6. Persistência real em SQLite (pv_users.db), formato de produção (dígitos soltos) e promoção @lid -> PN
	console.log("\n[6] Validando persistência SQLite em pv_users.db...");
	pvSafety.resetTestState();
	// Número fictício exclusivo deste teste: a chave do bot no banco é o número (não o id)
	const sqlBot = new FakeBot({
		id: "__test_sqlite_bot__",
		phoneNumber: "999000111222",
		privado: false
	});
	sqlBot.lidToPnCache = new Map();
	sqlBot.getLidFromPn = WhatsAppBotGo.prototype.getLidFromPn;
	const sqlBotKey = pvSafety.getBotKey(sqlBot);
	assert.strictEqual(
		sqlBotKey,
		"999000111222",
		"Registro de PV deve ser chaveado pelo número do bot"
	);
	const legacyBotId = "__test_sqlite_legacy_bot__";
	const legacyBot = { id: legacyBotId, phoneNumber: "999000111223" };
	const legacyBotKey = pvSafety.getBotKey(legacyBot);
	const cleanupSql = async () => {
		for (const key of [sqlBotKey, legacyBotId, legacyBotKey]) {
			await database.dbRun("pv_users", "DELETE FROM pv_users WHERE bot_id = ?", [key]);
		}
	};
	database.testMode = false;
	try {
		await cleanupSql();
		const sqlLid = "777888999000";
		const sqlPn = "5548999998888";
		const prodSqlMsg = createMessage({ author: sqlLid, group: null });
		prodSqlMsg.from = `${sqlLid}@lid`;
		prodSqlMsg.goMessageData = { Info: { Sender: `${sqlLid}@lid`, Chat: `${sqlLid}@lid` } };
		await pvSafety.recordPvInteraction(sqlBot, prodSqlMsg, t0);
		pvSafety.clearInboundAllowance();
		const lidRows = await database.dbAll("pv_users", "SELECT * FROM pv_users WHERE bot_id = ?", [
			sqlBotKey
		]);
		assert.strictEqual(lidRows.length, 1);
		assert.strictEqual(lidRows[0].user_key, `${sqlLid}@lid`);
		assert.strictEqual(await pvSafety.hasPvInteraction(sqlBot, `${sqlLid}@lid`), true);
		assert.strictEqual(
			await pvSafety.hasPvInteraction(sqlBot, sqlLid),
			true,
			"Consulta por dígitos soltos deve achar o registro @lid no SQLite"
		);

		// Linha antiga (antes da correção) gravada com o LID como se fosse telefone: user_key="<lid>"
		await database.dbRun(
			"pv_users",
			"INSERT INTO pv_users (bot_id, user_key, user_lid, has_pv, first_pv_at, last_pv_at, last_vcard_sent_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, 0, ?)",
			[sqlBotKey, "666555444333", "666555444333@lid", t0, t0, t0]
		);
		assert.strictEqual(
			await pvSafety.hasPvInteraction(sqlBot, "666555444333@lid"),
			true,
			"Linha antiga com user_key = dígitos do LID deve casar com a consulta por @lid"
		);

		await pvSafety.markVcardSent(sqlBot, `${sqlLid}@lid`, t0);
		sqlBot.lidToPnCache.set(sqlLid, sqlPn);
		sqlBot.lidToPnCache.set(`${sqlLid}@lid`, sqlPn);
		assert.strictEqual(
			await pvSafety.hasPvInteraction(sqlBot, `${sqlPn}@s.whatsapp.net`),
			true,
			"Após aprender o PN, consulta pelo telefone deve achar a linha gravada só com LID"
		);

		await pvSafety.recordPvInteraction(
			sqlBot,
			createMessage({
				author: `${sqlPn}@s.whatsapp.net`,
				authorAlt: `${sqlLid}@lid`,
				group: null
			}),
			t0 + 5000
		);
		const promotedRows = await database.dbAll(
			"pv_users",
			"SELECT * FROM pv_users WHERE bot_id = ? AND (user_lid = ? OR user_key = ?)",
			[sqlBotKey, `${sqlLid}@lid`, sqlPn]
		);
		assert.strictEqual(
			promotedRows.length,
			1,
			"Promoção LID->PN não deve duplicar linhas em pv_users"
		);
		assert.strictEqual(promotedRows[0].user_key, sqlPn);
		assert.strictEqual(promotedRows[0].user_pn, sqlPn);
		assert.strictEqual(promotedRows[0].user_lid, `${sqlLid}@lid`);
		assert.strictEqual(promotedRows[0].has_pv, 1);
		assert.strictEqual(promotedRows[0].last_vcard_sent_at, t0);

		// Fail-open: erro real de SQL na consulta libera o envio
		const originalDbAll = database.dbAll;
		database.dbAll = async () => {
			throw new Error("SQLITE_CORRUPT: database disk image is malformed");
		};
		pvSafety.clearInboundAllowance();
		try {
			assert.strictEqual(
				await pvSafety.hasPvInteraction(sqlBot, "5548911110000@s.whatsapp.net"),
				true,
				"Falha do SQLite deve liberar o envio (fail-open)"
			);
		} finally {
			database.dbAll = originalDbAll;
		}

		// Migração de linhas antigas chaveadas pelo id do bot para o número
		await database.dbRun(
			"pv_users",
			"INSERT INTO pv_users (bot_id, user_key, has_pv, first_pv_at, last_pv_at, last_vcard_sent_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)",
			[legacyBotId, "5548933334444", t0, t0, t0, t0]
		);
		const migration = await pvSafety.migrateLegacyBotKeys([legacyBot], {
			force: true,
			writeMarker: false
		});
		assert.strictEqual(migration.migratedRows, 1);
		const legacyLeft = await database.dbAll("pv_users", "SELECT * FROM pv_users WHERE bot_id = ?", [
			legacyBotId
		]);
		assert.strictEqual(legacyLeft.length, 0, "Linhas com o id antigo devem ser migradas");
		assert.strictEqual(
			await pvSafety.hasPvInteraction(legacyBot, "5548933334444@s.whatsapp.net"),
			true,
			"Após migrar, o bot (pelo número) mantém o histórico de PV"
		);
		assert.strictEqual(
			await pvSafety.hasPvInteraction(
				{ id: legacyBotId, phoneNumber: "999000111224" },
				"5548933334444@s.whatsapp.net"
			),
			false,
			"Mesmo id re-pareado com outro número não herda o histórico de PV"
		);
	} finally {
		await cleanupSql();
		database.testMode = true;
	}
	console.log("✓ Persistência SQLite, dígitos soltos, fail-open e chave por número validados!");

	// 7. Backfill de pv_users a partir de dados existentes + lembretes/correios bloqueados no PV
	console.log("\n[7] Validando backfill de pv_users e reenvio de lembretes/correios bloqueados...");
	pvSafety.resetTestState();
	const os = require("os");
	const fs = require("fs");
	const path = require("path");
	const BetterSQLite = require("better-sqlite3");
	const tmpSqlites = fs.mkdtempSync(path.join(os.tmpdir(), "pv-backfill-"));
	const createSourceDb = (file, ddl, rows) => {
		const conn = new BetterSQLite(path.join(tmpSqlites, file));
		conn.exec(ddl);
		for (const [sql, params] of rows) conn.prepare(sql).run(...params);
		conn.close();
	};
	const bfNow = Date.now();
	createSourceDb(
		"lembretes.db",
		"CREATE TABLE lembretes (id TEXT PRIMARY KEY, chat_id TEXT, user_id TEXT, data INTEGER, mensagem TEXT, criado_em INTEGER, ativo INTEGER, bot_id TEXT)",
		[
			[
				"INSERT INTO lembretes VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				["l1", "5511911110001@s.whatsapp.net", "5511911110001", bfNow, "a", bfNow, 0, "bf-bot-a"]
			],
			[
				"INSERT INTO lembretes VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				["l2", "120363000000000001@g.us", "5511911110010", bfNow, "b", bfNow, 1, "bf-bot-a"]
			],
			[
				"INSERT INTO lembretes VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				["l3", "888777666555444@lid", "888777666555444", bfNow, "c", bfNow, 1, null]
			],
			[
				"INSERT INTO lembretes VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				[
					"l4",
					"5511911110009@s.whatsapp.net",
					"5511911110009",
					bfNow,
					"d",
					bfNow,
					1,
					"bot-removido"
				]
			]
		]
	);
	createSourceDb(
		"greeted_users.db",
		"CREATE TABLE greeted_users (user_id TEXT, bot_id TEXT, timestamp INTEGER, PRIMARY KEY (user_id, bot_id))",
		[["INSERT INTO greeted_users VALUES (?, ?, ?)", ["5511911110002", "bf-bot-b", bfNow]]]
	);
	createSourceDb(
		"correios.db",
		"CREATE TABLE tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, chat_id TEXT, code TEXT, description TEXT, last_event_text TEXT, last_event_date TEXT, last_check INTEGER)",
		[
			[
				"INSERT INTO tracks (chat_id, code, last_check) VALUES (?, ?, ?)",
				["5511911110003", "A1", bfNow]
			],
			[
				"INSERT INTO tracks (chat_id, code, last_check) VALUES (?, ?, ?)",
				["120363000000000002@g.us", "A2", bfNow]
			],
			// ID de Telegram (sem plataforma na tabela): não pode virar telefone
			[
				"INSERT INTO tracks (chat_id, code, last_check) VALUES (?, ?, ?)",
				["1198765432", "A3", bfNow]
			]
		]
	);
	createSourceDb(
		"copa_seguir.db",
		"CREATE TABLE copa_seguindo (chat_id TEXT, team_id TEXT, team_name_en TEXT, team_name_pt TEXT, fifa_code TEXT, created_at INTEGER, PRIMARY KEY (chat_id, team_id))",
		[
			[
				"INSERT INTO copa_seguindo VALUES (?, ?, ?, ?, ?, ?)",
				["5511911110004@s.whatsapp.net", "BRA", "Brazil", "Brasil", "BRA", bfNow]
			],
			[
				"INSERT INTO copa_seguindo VALUES (?, ?, ?, ?, ?, ?)",
				["551191111000", "ARG", "Argentina", "Argentina", "ARG", bfNow]
			]
		]
	);
	createSourceDb(
		"linked_accounts.db",
		"CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT, platform_id TEXT, whatsapp_id TEXT, created_at INTEGER, updated_at INTEGER); CREATE TABLE link_codes (code TEXT PRIMARY KEY, whatsapp_id TEXT, created_at INTEGER, expires_at INTEGER)",
		[
			[
				"INSERT INTO linked_accounts (platform, platform_id, whatsapp_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				["telegram", "123", "5511911110005", bfNow, bfNow]
			],
			["INSERT INTO link_codes VALUES (?, ?, ?, ?)", ["CODE1", "5511911110006", bfNow, bfNow]]
		]
	);
	createSourceDb(
		"core.db",
		"CREATE TABLE invite_history (id INTEGER PRIMARY KEY AUTOINCREMENT, invite_code TEXT, group_jid TEXT, author_id TEXT, author_name TEXT, timestamp INTEGER, reason TEXT, json_data TEXT)",
		[
			[
				"INSERT INTO invite_history (invite_code, author_id, timestamp) VALUES (?, ?, ?)",
				["INV1", "5511911110007@c.us", bfNow]
			]
		]
	);

	const bfBotA = { id: "bf-bot-a", phoneNumber: "999000222001" };
	const bfBotB = { id: "bf-bot-b", phoneNumber: "999000222002" };
	const bfBots = [bfBotA, bfBotB, { id: "bf-tg", useTelegram: true }];
	const bfMarker = `test_backfill_marker_${Date.now()}`;
	const bfKeys = [pvSafety.getBotKey(bfBotA), pvSafety.getBotKey(bfBotB)];
	const countBfRows = async () =>
		(
			await database.dbGet(
				"pv_users",
				`SELECT COUNT(*) AS c FROM pv_users WHERE bot_id IN (?, ?)`,
				bfKeys
			)
		).c;
	const cleanupBackfill = async () => {
		for (const key of bfKeys) {
			await database.dbRun("pv_users", "DELETE FROM pv_users WHERE bot_id = ?", [key]);
		}
		await database.dbRun("pv_users", "DELETE FROM pv_meta WHERE key = ?", [bfMarker]);
	};

	database.testMode = false;
	try {
		await cleanupBackfill();
		const bfResult = await pvSafety.backfillFromExistingData(bfBots, {
			sqlitesDir: tmpSqlites,
			markerKey: bfMarker
		});
		assert.strictEqual(bfResult.bots, 2, "Apenas bots de WhatsApp entram no backfill");
		assert.strictEqual(bfResult.sources.lembretes.users, 2);
		assert.strictEqual(bfResult.sources.greeted_users.users, 1);
		assert.strictEqual(bfResult.sources.correios.users, 1, "Grupo e ID de Telegram são ignorados");
		assert.strictEqual(bfResult.sources.copa_seguir.users, 1, "copa_seguir exige JID com sufixo");
		assert.strictEqual(bfResult.sources.linked_accounts.users, 2);
		assert.strictEqual(bfResult.sources.invite_history.users, 1);
		pvSafety.clearInboundAllowance();

		const has = (bot, target) => pvSafety.hasPvInteraction(bot, target);
		// lembrete com bot_id => só aquele bot
		assert.strictEqual(await has(bfBotA, "5511911110001@s.whatsapp.net"), true);
		assert.strictEqual(await has(bfBotB, "5511911110001@s.whatsapp.net"), false);
		assert.strictEqual(await has(bfBotA, "551111110001"), true, "Variante de 12 dígitos casa");
		// lembrete sem bot_id => todos os bots de WhatsApp
		assert.strictEqual(await has(bfBotA, "888777666555444@lid"), true);
		assert.strictEqual(await has(bfBotB, "888777666555444"), true);
		// greeted_users com bot_id
		assert.strictEqual(await has(bfBotB, "5511911110002@s.whatsapp.net"), true);
		assert.strictEqual(await has(bfBotA, "5511911110002@s.whatsapp.net"), false);
		// fontes sem bot_id => todos os bots
		for (const target of [
			"5511911110003@s.whatsapp.net",
			"5511911110004@s.whatsapp.net",
			"5511911110005@s.whatsapp.net",
			"5511911110006@s.whatsapp.net",
			"5511911110007@s.whatsapp.net"
		]) {
			assert.strictEqual(await has(bfBotA, target), true, `${target} deveria ser liberado (A)`);
			assert.strictEqual(await has(bfBotB, target), true, `${target} deveria ser liberado (B)`);
		}
		// Linhas que não provam PV
		assert.strictEqual(await has(bfBotA, "5511911110009@s.whatsapp.net"), false, "Bot removido");
		assert.strictEqual(await has(bfBotA, "551198765432@s.whatsapp.net"), false, "ID de Telegram");
		assert.strictEqual(
			await has(bfBotA, "5511911110010@s.whatsapp.net"),
			false,
			"Lembrete de grupo"
		);

		// Idempotência: rodar de novo não duplica nada
		const rowsAfterFirst = await countBfRows();
		const bfAgain = await pvSafety.backfillFromExistingData(bfBots, {
			sqlitesDir: tmpSqlites,
			markerKey: bfMarker,
			force: true
		});
		assert.strictEqual(bfAgain.inserted, 0, "Segunda execução não insere linhas novas");
		assert.strictEqual(await countBfRows(), rowsAfterFirst);
		// Marcador: sem force, não roda de novo
		const bfSkipped = await pvSafety.backfillFromExistingData(bfBots, {
			sqlitesDir: tmpSqlites,
			markerKey: bfMarker
		});
		assert.strictEqual(bfSkipped.skipped, "done");
		const markerRow = await database.dbGet("pv_users", "SELECT value FROM pv_meta WHERE key = ?", [
			bfMarker
		]);
		assert.ok(JSON.parse(markerRow.value).sources.lembretes, "Marcador guarda as contagens");

		// Backfill não pode rebaixar quem já tem vCard registrado
		await pvSafety.markVcardSent(bfBotA, "5511911110001@s.whatsapp.net", t0);
		await pvSafety.backfillFromExistingData(bfBots, {
			sqlitesDir: tmpSqlites,
			markerKey: bfMarker,
			force: true
		});
		const vcardRow = await database.dbGet(
			"pv_users",
			"SELECT * FROM pv_users WHERE bot_id = ? AND user_key = ?",
			[bfKeys[0], "5511911110001"]
		);
		assert.strictEqual(vcardRow.last_vcard_sent_at, t0);
		assert.strictEqual(vcardRow.has_pv, 1);
	} finally {
		await cleanupBackfill();
		fs.rmSync(tmpSqlites, { recursive: true, force: true });
		database.testMode = true;
	}

	// Lembrete no PV bloqueado: continua ativo (com a mídia) e é reagendado
	const LembretesCommands = require("../functions/LembretesCommands");
	const lembBot = createSpyBot({
		id: "lemb-pv-bot",
		nomeExibir: "Lemb",
		phoneNumber: "999000333001",
		privado: true
	});
	const lembTarget = "5511911119999@s.whatsapp.net";
	const lembId = `test-pv-block-${Date.now()}`;
	const cleanupBotRows = async (bot) =>
		database.dbRun("pv_users", "DELETE FROM pv_users WHERE bot_id = ?", [pvSafety.getBotKey(bot)]);
	pvSafety.resetTestState();
	database.testMode = false;
	try {
		await cleanupBotRows(lembBot.inst);
		await database
			.dbRun("lembretes", "ALTER TABLE lembretes ADD COLUMN pv_block_retries INTEGER DEFAULT 0")
			.catch(() => {});
		await database.dbRun(
			"lembretes",
			"INSERT INTO lembretes (id, chat_id, user_id, data, mensagem, criado_em, ativo, has_media, bot_id) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)",
			[
				lembId,
				lembTarget,
				lembTarget,
				Date.now() - 1000,
				"pagar a conta",
				Date.now(),
				"lemb-pv-bot"
			]
		);
		const beforeFire = Date.now();
		await LembretesCommands.dispararLembrete(lembBot.inst, lembId);
		let lembRow = await database.dbGet("lembretes", "SELECT * FROM lembretes WHERE id = ?", [
			lembId
		]);
		assert.strictEqual(lembBot.calls.length, 0, "Envio frio não pode chegar na API");
		assert.strictEqual(lembRow.ativo, 1, "Lembrete bloqueado no PV deve continuar ativo");
		assert.strictEqual(lembRow.pv_block_retries, 1);
		assert.ok(lembRow.data > beforeFire, "Lembrete bloqueado deve ser reagendado");

		// Usuário fala com o bot no PV: a próxima tentativa entrega e desativa o lembrete
		await pvSafety.recordPvInteraction(lembBot.inst, lembTarget);
		await LembretesCommands.dispararLembrete(lembBot.inst, lembId);
		lembRow = await database.dbGet("lembretes", "SELECT * FROM lembretes WHERE id = ?", [lembId]);
		assert.strictEqual(lembRow.ativo, 0, "Lembrete entregue deve ser desativado");
		assert.strictEqual(lembBot.calls.length, 1);
		assert.ok(lembBot.calls[0].payload.text.includes("pagar a conta"));
	} finally {
		await database.dbRun("lembretes", "DELETE FROM lembretes WHERE id = ?", [lembId]);
		await cleanupBotRows(lembBot.inst);
		database.testMode = true;
	}

	// Correios: last_event_text só avança depois que a notificação foi aceita
	const axios = require("axios");
	const originalAxiosGet = axios.get;
	const originalCorreiosApi = process.env.CORREIOS_API;
	const correiosPath = require.resolve("../functions/CorreiosCommands");
	const cachedCorreios = require.cache[correiosPath];
	delete require.cache[correiosPath];
	process.env.CORREIOS_API = "http://correios.invalid";
	const CorreiosCommands = require("../functions/CorreiosCommands");
	const corBot = createSpyBot({
		id: "correios-pv-bot",
		nomeExibir: "Cor",
		phoneNumber: "999000333002",
		privado: true
	});
	const corTarget = "5511911118888@s.whatsapp.net";
	const corCode = `QA${Date.now()}BR`;
	axios.get = async () => ({
		data: {
			events: [
				{
					descricao: "Objeto entregue ao destinatário",
					dtHrCriado: { date: "2026-11-12 10:00:00" },
					unidade: { tipo: "Agência", endereco: { cidade: "Porto Alegre", uf: "RS" } }
				}
			]
		}
	});
	pvSafety.resetTestState();
	database.testMode = false;
	try {
		await cleanupBotRows(corBot.inst);
		database.getSQLiteDb(
			"correios",
			`CREATE TABLE IF NOT EXISTS tracks (
				id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, chat_id TEXT, code TEXT, description TEXT,
				last_event_text TEXT, last_event_date TEXT, last_check INTEGER, UNIQUE(chat_id, code)
			);`,
			true
		);
		await database.dbRun("correios", "DELETE FROM tracks WHERE code LIKE 'QA%BR'");
		await database.dbRun(
			"correios",
			"INSERT INTO tracks (user_id, chat_id, code, description, last_event_text, last_event_date, last_check) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[corTarget, corTarget, corCode, "Pacote teste", "Objeto postado", "2026-11-10 09:00:00", 0]
		);
		await CorreiosCommands.checkAllPackages(corBot.inst);
		let track = await database.dbGet("correios", "SELECT * FROM tracks WHERE code = ?", [corCode]);
		assert.strictEqual(corBot.calls.length, 0);
		assert.strictEqual(
			track.last_event_text,
			"Objeto postado",
			"Notificação bloqueada no PV não pode avançar o último evento"
		);
		assert.ok(track.last_check > 0, "last_check deve ser atualizado mesmo bloqueado");

		await pvSafety.recordPvInteraction(corBot.inst, corTarget);
		await CorreiosCommands.checkAllPackages(corBot.inst);
		track = await database.dbGet("correios", "SELECT * FROM tracks WHERE code = ?", [corCode]);
		assert.strictEqual(corBot.calls.length, 1, "Com PV prévio a notificação é enviada");
		assert.strictEqual(track.last_event_text, "Objeto entregue ao destinatário");
	} finally {
		await database.dbRun("correios", "DELETE FROM tracks WHERE code = ?", [corCode]);
		await cleanupBotRows(corBot.inst);
		database.testMode = true;
		axios.get = originalAxiosGet;
		if (originalCorreiosApi === undefined) delete process.env.CORREIOS_API;
		else process.env.CORREIOS_API = originalCorreiosApi;
		if (cachedCorreios) require.cache[correiosPath] = cachedCorreios;
	}
	console.log("✓ Backfill idempotente, lembretes e correios bloqueados no PV validados!");

	console.log("\n=== TODOS OS TESTES DE PV SAFETY & VCARD PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
