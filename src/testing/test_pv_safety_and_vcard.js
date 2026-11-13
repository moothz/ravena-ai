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
		inst.apiClient = {
			post: async (endpoint, payload) => {
				calls.push({ endpoint, payload });
				return { data: { Info: { ID: `msg-${calls.length}` } } };
			}
		};
		return { inst, calls };
	};

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
	const coldRes = await publicGo.inst.sendMessage(coldTarget, "Mensagem fria não solicitada");
	assert.strictEqual(coldRes.blockedByPvSafety, true, "sendMessage deve bloquear envio frio em PV");
	assert.strictEqual(publicGo.calls.length, 0, "Nenhuma chamada HTTP deve ocorrer no bloqueio");

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
	assert.strictEqual(publicGo.calls.length, 1, "Dentro dos 45 dias não deve reenviar vCard");

	// Bot privado NUNCA envia vCard mesmo após PV registrado
	await pvSafety.recordPvInteraction(privGo.inst, coldTarget);
	await privGo.inst.sendMessage(coldTarget, "Oi do bot privado");
	assert.strictEqual(privGo.calls.length, 1, "Bot privado não deve enviar vCard");
	assert.strictEqual(privGo.calls[0].endpoint, "/send/text");
	console.log(
		"✓ WhatsAppBotGo.sendMessage (bloqueio frio, vCard 45 dias e bots privados) validado!"
	);

	// 6. Persistência real em SQLite (pv_users.db) e promoção @lid -> PN
	console.log("\n[6] Validando persistência SQLite em pv_users.db...");
	const sqlBotId = "__test_sqlite_bot__";
	const sqlBot = new FakeBot({ id: sqlBotId, phoneNumber: "555591535538", privado: false });
	sqlBot.lidToPnCache = new Map();
	database.testMode = false;

	await database.dbRun("pv_users", "DELETE FROM pv_users WHERE bot_id = ?", [sqlBotId]);
	await pvSafety.recordPvInteraction(
		sqlBot,
		createMessage({ author: "777888999000@lid", group: null }),
		t0
	);
	assert.strictEqual(await pvSafety.hasPvInteraction(sqlBot, "777888999000@lid"), true);

	await pvSafety.markVcardSent(sqlBot, "777888999000@lid", t0);
	sqlBot.lidToPnCache.set("777888999000@lid", "5548999998888@s.whatsapp.net");
	await pvSafety.recordPvInteraction(
		sqlBot,
		createMessage({
			author: "5548999998888@s.whatsapp.net",
			authorAlt: "777888999000@lid",
			group: null
		}),
		t0 + 5000
	);
	const promotedRows = await database.dbAll("pv_users", "SELECT * FROM pv_users WHERE bot_id = ?", [
		sqlBotId
	]);
	assert.strictEqual(
		promotedRows.length,
		1,
		"Promoção LID->PN não deve duplicar linhas em pv_users"
	);
	assert.strictEqual(promotedRows[0].user_key, "5548999998888");
	assert.strictEqual(promotedRows[0].user_lid, "777888999000@lid");
	assert.strictEqual(promotedRows[0].has_pv, 1);
	assert.strictEqual(promotedRows[0].last_vcard_sent_at, t0);
	await database.dbRun("pv_users", "DELETE FROM pv_users WHERE bot_id = ?", [sqlBotId]);
	database.testMode = true;
	console.log("✓ Persistência SQLite e promoção LID -> PN em pv_users.db validada!");

	console.log("\n=== TODOS OS TESTES DE PV SAFETY & VCARD PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
