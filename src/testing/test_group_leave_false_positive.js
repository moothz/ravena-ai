process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.DEBUG = "false";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DatabaseMappers = require("../utils/db/DatabaseMappers");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "leave-fp-"));
const openConnection = DatabaseMappers.prototype.getConnection;
DatabaseMappers.prototype.getConnection = function (name) {
	this.databasePath = this.testDataDir ?? dataDir;
	return openConnection.call(this, name);
};

const Database = require("../utils/Database");
Database.getInstance({ disableBackup: true, testMode: false });

const EventHandler = require("../EventHandler");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const FakeBot = require("./FakeBot");
const Group = require("../models/Group");

function makeRes() {
	return {
		status() {
			return this;
		},
		send() {
			return this;
		},
		sendStatus() {
			return this;
		}
	};
}

function makeBot(id, phoneNumber, eventHandler, apiPostImpl) {
	const bot = new WhatsAppBotGo({
		id,
		phoneNumber,
		whatsgoApiUrl: "http://localhost:9999",
		whatsgoApiKey: "test-key",
		instanceName: id,
		webhookHost: "http://localhost:3000",
		grupoLogs: "120363000000000099@g.us",
		comunitario: true,
		eventHandler
	});
	bot.isConnected = true;
	bot.apiClient = {
		post: apiPostImpl,
		get: async () => ({ data: [] })
	};
	bot.sendMessage = async (chatId, content, options = {}) => {
		bot.sentLogMessages = bot.sentLogMessages || [];
		bot.sentLogMessages.push({ chatId, content, options });
		return { id: { _serialized: `msg-${Date.now()}` } };
	};
	bot.getContactDetails = async (jid) => ({
		id: { _serialized: jid },
		name: String(jid).split("@")[0]
	});
	return bot;
}

async function runTests() {
	console.log("=== Teste de regressão: falso positivo de saída de grupo no EventHandler ===");

	const eventHandler = new EventHandler();
	const pendingOps = [];
	const origOnJoin = eventHandler.onGroupJoin.bind(eventHandler);
	const origOnLeave = eventHandler.onGroupLeave.bind(eventHandler);
	eventHandler.onGroupJoin = (bot, data) => {
		const p = eventHandler.processGroupJoin(bot, data);
		pendingOps.push(p);
		return p;
	};
	eventHandler.onGroupLeave = (bot, data) => {
		const p = eventHandler.processGroupLeave(bot, data);
		pendingOps.push(p);
		return p;
	};
	assert.ok(origOnJoin && origOnLeave);

	let blockCalls = 0;
	eventHandler.commandHandler.superAdmin.blockList = async () => {
		blockCalls++;
		return { content: "blocked" };
	};
	eventHandler.commandHandler.superAdmin.blockInvites = async () => {
		blockCalls++;
		return { content: "blocked" };
	};

	const leaveRecords = [];
	const origRecordLeave = eventHandler.database.recordGroupLeave.bind(eventHandler.database);
	eventHandler.database.recordGroupLeave = async (...args) => {
		leaveRecords.push(args);
		return origRecordLeave(...args);
	};

	const flushOps = async () => {
		while (pendingOps.length > 0) {
			const batch = pendingOps.splice(0);
			await Promise.all(batch);
		}
	};

	// -------------------------------------------------------------------------
	// Caso 1: Reprodução fiel do bug (JoinedGroup + /group/info 500 + Leave de outro @lid)
	// -------------------------------------------------------------------------
	console.log(
		"[1] JoinedGroup com skipGroupInfo prévio + /group/info 500 + Leave de outro @lid..."
	);
	const group1 = "120363000000099001@g.us";
	const bot1Phone = "5511999990001";
	const bot1Lid = "111111111111111@lid";
	const oldBotPhone = "5511999990002";
	const oldBotLid = "222222222222222@lid";
	const adminPhone = "5511999990003@s.whatsapp.net";

	let groupInfoCalls = 0;
	const bot1 = makeBot("rav-teste-1", bot1Phone, eventHandler, async (url) => {
		if (url === "/group/info") {
			groupInfoCalls++;
			const err = new Error("Request failed with status code 500");
			err.status = 500;
			err.data = { error: "you're not participating in that group" };
			throw err;
		}
		return { data: {} };
	});

	await eventHandler.database.saveGroup(
		new Group({
			id: group1,
			name: "Grupo Repro",
			sendJoinInfo: false
		})
	);
	await bot1.markNotInGroup(group1);
	assert.strictEqual(bot1.isParticipating(group1), false, "Pré-condição: grupo na skip list");

	await bot1._handleWebhook(
		{
			body: {
				event: "JoinedGroup",
				data: {
					Reason: "invite",
					JID: group1,
					OwnerJID: "999999999999999@lid",
					OwnerPN: adminPhone,
					Name: "Grupo Repro Ao Vivo",
					IsParent: false,
					IsAnnounce: false,
					Participants: [
						{
							JID: bot1Lid,
							LID: bot1Lid,
							PhoneNumber: `${bot1Phone}@s.whatsapp.net`,
							IsAdmin: false
						},
						{
							JID: oldBotLid,
							LID: oldBotLid,
							PhoneNumber: `${oldBotPhone}@s.whatsapp.net`,
							IsAdmin: false
						}
					]
				}
			}
		},
		makeRes()
	);
	await flushOps();

	assert.strictEqual(
		bot1.isParticipating(group1),
		true,
		"Após JoinedGroup, o grupo NÃO pode voltar para skipGroupInfo"
	);

	// Mesmo se por qualquer motivo o grupo ainda estivesse na skip list quando outro membro sai,
	// a remoção de outro @lid NÃO pode ser classificada como saída do bot.
	await bot1.markNotInGroup(group1);
	bot1.sentLogMessages = [];
	leaveRecords.length = 0;
	blockCalls = 0;

	// Agora o servidor já responde /group/info normalmente com o bot dentro
	bot1.apiClient.post = async (url) => {
		if (url === "/group/info") {
			return {
				data: {
					JID: group1,
					Name: "Grupo Repro Ao Vivo",
					IsParent: false,
					IsAnnounce: false,
					Participants: [
						{
							JID: bot1Lid,
							LID: bot1Lid,
							PhoneNumber: `${bot1Phone}@s.whatsapp.net`,
							IsAdmin: false
						}
					]
				}
			};
		}
		return { data: {} };
	};

	await bot1._handleWebhook(
		{
			body: {
				event: "GroupInfo",
				data: {
					JID: group1,
					SenderPN: adminPhone,
					Leave: [oldBotLid]
				}
			}
		},
		makeRes()
	);
	await flushOps();

	assert.strictEqual(
		leaveRecords.length,
		0,
		"Saída de outro @lid não pode gravar recordGroupLeave"
	);
	assert.strictEqual(blockCalls, 0, "Saída de outro @lid não pode acionar bloqueios");
	assert.strictEqual(
		(bot1.sentLogMessages || []).filter((m) => m.content.includes("saiu do grupo")).length,
		0,
		"Saída de outro @lid não pode enviar log de saída do bot"
	);
	assert.strictEqual(
		bot1.isParticipating(group1),
		true,
		"Bot continua participando do grupo após saída de outro @lid"
	);

	// -------------------------------------------------------------------------
	// Caso 2: Guardas diretos em EventHandler.processGroupLeave
	// -------------------------------------------------------------------------
	console.log("[2] Guardas diretos de identidade em EventHandler.processGroupLeave...");
	const fakeBot = new FakeBot({
		id: "rav-fake-leave",
		phoneNumber: "5511999990010",
		grupoLogs: "120363000000000099@g.us",
		comunitario: true
	});
	fakeBot.myLid = "555555555555555@lid";
	fakeBot.getPnFromLid = (lid) => {
		if (lid === "666666666666666@lid") return "5511999990099@s.whatsapp.net";
		return null;
	};

	// 2a: notInGroup vindo apenas de skip list + outro LID
	fakeBot.resetCapture();
	leaveRecords.length = 0;
	fakeBot.getChatDetails = async (id) => ({
		id: { _serialized: id },
		notInGroup: true,
		fromSkipList: true,
		participants: []
	});
	await eventHandler.processGroupLeave(fakeBot, {
		group: {
			id: "120363000000099002@g.us",
			name: "Grupo Skip",
			notInGroup: true,
			fromSkipList: true
		},
		user: { id: "777777777777777@lid", name: "OutroSemMap" },
		responsavel: { id: adminPhone, name: "Admin" }
	});
	assert.strictEqual(
		leaveRecords.length,
		0,
		"2a: notInGroup de skipList não pode marcar saída do bot"
	);

	// 2b: chatInfo.notInGroup = true (sem fromSkipList), mas bot.myLid é conhecido e difere de data.user.id
	fakeBot.getChatDetails = async (id) => ({
		id: { _serialized: id },
		notInGroup: true,
		participants: []
	});
	await eventHandler.processGroupLeave(fakeBot, {
		group: { id: "120363000000099003@g.us", name: "Grupo Live" },
		user: { id: "666666666666666@lid", name: "OutroComMap" },
		responsavel: { id: adminPhone, name: "Admin" }
	});
	assert.strictEqual(
		leaveRecords.length,
		0,
		"2b: LID diferente de myLid / PN resolvido diferente não pode marcar saída do bot"
	);

	// 2c: data.user.id é PN diferente do bot
	await eventHandler.processGroupLeave(fakeBot, {
		group: { id: "120363000000099004@g.us", name: "Grupo PN", notInGroup: true },
		user: { id: "5511999990088@s.whatsapp.net", name: "OutroPN" },
		responsavel: { id: adminPhone, name: "Admin" }
	});
	assert.strictEqual(
		leaveRecords.length,
		0,
		"2c: PN diferente do bot não pode marcar saída do bot"
	);

	// -------------------------------------------------------------------------
	// Caso 3: Saída legítima do próprio bot continua funcionando (com e sem myLid)
	// -------------------------------------------------------------------------
	console.log("[3] Saída legítima do próprio bot (com myLid e cold-start sem myLid)...");
	const group2 = "120363000000099005@g.us";
	const bot2 = makeBot("rav-teste-2", "5511999990020", eventHandler, async (url) => {
		if (url === "/group/info") {
			const err = new Error("Request failed with status code 500");
			err.status = 500;
			err.data = { error: "you're not participating in that group" };
			throw err;
		}
		return { data: {} };
	});
	bot2.myLid = "888888888888888@lid";
	await eventHandler.database.saveGroup(new Group({ id: group2, name: "Grupo Saiu 1" }));
	leaveRecords.length = 0;

	await bot2._handleWebhook(
		{
			body: {
				event: "GroupInfo",
				data: { JID: group2, SenderPN: adminPhone, Leave: ["888888888888888@lid"] }
			}
		},
		makeRes()
	);
	await flushOps();

	assert.strictEqual(
		leaveRecords.length,
		1,
		"Saída legítima com myLid deve gravar recordGroupLeave"
	);
	assert.strictEqual(bot2.isParticipating(group2), false, "Bot deve ser marcado fora do grupo");
	assert.strictEqual(
		(bot2.sentLogMessages || []).filter((m) => m.content.includes("saiu do grupo")).length,
		1,
		"Deve enviar notificação de saída no grupoLogs"
	);

	// Cold-start sem myLid e sem cache de LID->PN
	const group3 = "120363000000099006@g.us";
	const bot3 = makeBot("rav-teste-3", "5511999990030", eventHandler, async (url) => {
		if (url === "/group/info") {
			const err = new Error("Request failed with status code 500");
			err.status = 500;
			err.data = { error: "you're not participating in that group" };
			throw err;
		}
		return { data: {} };
	});
	await eventHandler.database.saveGroup(new Group({ id: group3, name: "Grupo Saiu 2" }));
	leaveRecords.length = 0;

	await bot3._handleWebhook(
		{
			body: {
				event: "GroupInfo",
				data: { JID: group3, SenderPN: adminPhone, Leave: ["999888777666555@lid"] }
			}
		},
		makeRes()
	);
	await flushOps();

	assert.strictEqual(
		leaveRecords.length,
		1,
		"Saída legítima sem myLid (cold-start) deve gravar recordGroupLeave"
	);
	assert.strictEqual(
		bot3.isParticipating(group3),
		false,
		"Bot sem myLid deve ser marcado fora do grupo"
	);

	console.log("[4] Skip list + /group/info em timeout + bot sem myLid + saída de outro @lid...");
	const group4 = "120363000000099007@g.us";
	const bot4 = makeBot("rav-teste-4", "5511999990040", eventHandler, async (url) => {
		if (url === "/group/info") {
			const err = new Error("timeout of 10000ms exceeded");
			err.code = "ECONNABORTED";
			throw err;
		}
		return { data: {} };
	});
	await eventHandler.database.saveGroup(new Group({ id: group4, name: "Grupo Timeout" }));
	await bot4.markNotInGroup(group4);
	assert.strictEqual(bot4.myLid ?? null, null, "Pré-condição: bot sem myLid");
	assert.ok(
		String(bot4.getPnFromLid("444444444444444@lid") ?? "@lid").includes("@lid"),
		"Pré-condição: sem mapa lid->pn"
	);

	const skipDetails = await bot4.getChatDetails(group4);
	assert.strictEqual(skipDetails.notInGroup, true);
	assert.strictEqual(
		skipDetails.fromSkipList,
		true,
		"getChatDetails de grupo na skip list deve marcar fromSkipList"
	);
	const transientDetails = await bot4.getChatDetails(group4, { bypassSkipList: true });
	assert.strictEqual(transientDetails.notInGroup, true);
	assert.strictEqual(
		transientDetails.fromSkipList,
		true,
		"Falha transitória sem cache deve marcar notInGroup como vindo da skip list"
	);

	leaveRecords.length = 0;
	blockCalls = 0;
	bot4.sentLogMessages = [];
	await bot4._handleWebhook(
		{
			body: {
				event: "GroupInfo",
				data: { JID: group4, SenderPN: adminPhone, Leave: ["444444444444444@lid"] }
			}
		},
		makeRes()
	);
	await flushOps();
	await new Promise((resolve) => setTimeout(resolve, 200));
	await flushOps();

	assert.strictEqual(
		leaveRecords.length,
		0,
		"Timeout no /group/info com grupo na skip list não pode gravar recordGroupLeave"
	);
	assert.strictEqual(blockCalls, 0, "Timeout no /group/info não pode acionar bloqueios");
	assert.strictEqual(
		(bot4.sentLogMessages || []).filter((m) => m.content.includes("saiu do grupo")).length,
		0,
		"Timeout no /group/info não pode enviar log de saída do bot"
	);

	console.log("=== TODOS OS TESTES PASSARAM! ===");
	fs.rmSync(dataDir, { recursive: true, force: true });
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Falha no teste:", err);
	try {
		fs.rmSync(dataDir, { recursive: true, force: true });
	} catch (_) {
		// ignore
	}
	process.exit(1);
});
