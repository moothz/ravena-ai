process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const axios = require("axios");
const express = require("express");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");

// Precisa vir antes dos módulos do bot: ativa testMode no Database (sem escrita real)
const bot = new FakeBot({ id: "test-bot" });

const CommandHandler = require("../CommandHandler");
const ReturnMessage = require("../models/ReturnMessage");
const Group = require("../models/Group");
const GroupMapper = require("../utils/db/mappers/GroupMapper");
const { registerManagementRoutes } = require("../BotAPI/routes/managementRoutes");
const {
	validateCommandLimits,
	findCommandLimit,
	evaluateUsage,
	describeCommandLimit
} = require("../utils/CommandLimits");

const GROUP_ID = "123@g.us";
const ALICE = "5511999999999@s.whatsapp.net";
const BOB = "5511888888888@s.whatsapp.net";
const HOUR_MS = 60 * 60 * 1000;

function testValidateCommandLimits() {
	const valid = validateCommandLimits([
		{ command: "!Roleta", maxUses: "10" },
		{ command: "pesca", maxUses: 3, hours: 2, scope: "user" }
	]);
	assert.ok(valid.valid);
	assert.deepStrictEqual(valid.limits, [
		{ command: "roleta", maxUses: 10, hours: 24, scope: "global", ignoreAdmins: false },
		{ command: "pesca", maxUses: 3, hours: 2, scope: "user", ignoreAdmins: false }
	]);
	assert.strictEqual(
		validateCommandLimits([{ command: "roleta", maxUses: 1, ignoreAdmins: true }]).limits[0]
			.ignoreAdmins,
		true
	);

	assert.deepStrictEqual(validateCommandLimits(undefined), { valid: true, limits: [] });
	assert.strictEqual(validateCommandLimits("roleta").valid, false);
	assert.strictEqual(validateCommandLimits([{ command: "", maxUses: 1 }]).valid, false);
	assert.strictEqual(validateCommandLimits([{ command: "dois nomes", maxUses: 1 }]).valid, false);
	assert.strictEqual(validateCommandLimits([{ command: "roleta", maxUses: 0 }]).valid, false);
	assert.strictEqual(validateCommandLimits([{ command: "roleta", maxUses: 1.5 }]).valid, false);
	assert.strictEqual(
		validateCommandLimits([{ command: "roleta", maxUses: 1, hours: 721 }]).valid,
		false
	);
	assert.strictEqual(
		validateCommandLimits([{ command: "roleta", maxUses: 1, scope: "canal" }]).valid,
		false
	);
	assert.strictEqual(
		validateCommandLimits([
			{ command: "roleta", maxUses: 1 },
			{ command: "!ROLETA", maxUses: 2 }
		]).valid,
		false
	);
	console.log("OK: validateCommandLimits normaliza e rejeita entradas inválidas");
}

function testFindAndDescribe() {
	const group = { commandLimits: [{ command: "roleta", maxUses: 10, hours: 24, scope: "user" }] };
	assert.strictEqual(findCommandLimit(group, "ROLETA").maxUses, 10);
	assert.strictEqual(findCommandLimit(group, "pesca"), null);
	assert.strictEqual(findCommandLimit(null, "roleta"), null);
	assert.strictEqual(describeCommandLimit(group.commandLimits[0]), "10 usos a cada 24h por pessoa");
	console.log("OK: findCommandLimit ignora maiúsculas e describeCommandLimit formata a regra");
}

function testEvaluateUsage() {
	const now = 10 * 24 * HOUR_MS;
	const limit = { command: "roleta", maxUses: 2, hours: 24, scope: "global" };

	assert.strictEqual(evaluateUsage([now - HOUR_MS], limit, now).blocked, false);

	const blocked = evaluateUsage([now - HOUR_MS, now - 3 * HOUR_MS], limit, now);
	assert.strictEqual(blocked.blocked, true);
	// O uso mais antigo (3h atrás) libera a vaga em 21h
	assert.strictEqual(blocked.retryInSeconds, 21 * 60 * 60);

	assert.strictEqual(evaluateUsage([now - HOUR_MS, now - 25 * HOUR_MS], limit, now).blocked, false);
	console.log("OK: evaluateUsage aplica janela deslizante e calcula o tempo de espera");
}

function testGroupPersistence() {
	const limits = [{ command: "roleta", maxUses: 10, hours: 24, scope: "global" }];
	const group = new Group({ id: GROUP_ID, commandLimits: limits });
	assert.deepStrictEqual(group.toJSON().commandLimits, limits);

	const row = GroupMapper.toRow(group.toJSON());
	assert.strictEqual(row.command_limits, JSON.stringify(limits));
	assert.deepStrictEqual(GroupMapper.fromRow(row).commandLimits, limits);
	assert.deepStrictEqual(new Group({ id: GROUP_ID }).commandLimits, []);
	console.log("OK: commandLimits persiste no Group e no GroupMapper");
}

/** Tracker em memória: o Database em testMode bloqueia escritas */
function createMemoryTracker() {
	const usages = [];
	return {
		usages,
		async check(limit, groupId, userId) {
			const timestamps = usages
				.filter(
					(u) =>
						u.groupId === groupId &&
						u.command === limit.command &&
						(limit.scope !== "user" || u.userId === userId)
				)
				.map((u) => u.timestamp);
			return evaluateUsage(timestamps, limit, Date.now());
		},
		async record(limit, groupId, userId) {
			usages.push({ groupId, command: limit.command, userId, timestamp: Date.now() });
		}
	};
}

async function testCommandHandlerEnforcement() {
	const handler = new CommandHandler();
	handler.commandLimitTracker = createMemoryTracker();

	let executions = 0;
	const command = {
		name: "roleta",
		method: async (_bot, message) => {
			executions++;
			return new ReturnMessage({ chatId: message.group, content: "bang" });
		}
	};
	const run = (author, group) =>
		handler.executeFixedCommand(
			bot,
			createMessage({ content: "!roleta", group: GROUP_ID, author }),
			command,
			[],
			group
		);

	// Global: 2 usos no grupo todo
	const globalGroup = {
		id: GROUP_ID,
		commandLimits: [{ command: "roleta", maxUses: 2, hours: 24, scope: "global" }]
	};
	bot.resetCapture();
	await run(ALICE, globalGroup);
	await run(BOB, globalGroup);
	const blocked = await run(ALICE, globalGroup);
	assert.strictEqual(blocked, null);
	assert.strictEqual(executions, 2);
	const limitMsg = bot.capturedMessages.find((m) => String(m.content).includes("limite do grupo"));
	assert.ok(limitMsg, "deveria avisar que o limite do grupo foi atingido");
	console.log("OK: limite global bloqueia o 3º uso no grupo");

	// Por pessoa: cada membro tem seus 2 usos
	handler.commandLimitTracker = createMemoryTracker();
	executions = 0;
	const perUserGroup = {
		id: GROUP_ID,
		commandLimits: [{ command: "roleta", maxUses: 2, hours: 24, scope: "user" }]
	};
	await run(ALICE, perUserGroup);
	await run(ALICE, perUserGroup);
	await run(ALICE, perUserGroup);
	await run(BOB, perUserGroup);
	assert.strictEqual(executions, 3);
	console.log("OK: limite por pessoa bloqueia só quem passou do limite");

	// Sem limite configurado não registra nada
	handler.commandLimitTracker = createMemoryTracker();
	await run(ALICE, { id: GROUP_ID, commandLimits: [] });
	assert.strictEqual(handler.commandLimitTracker.usages.length, 0);
	console.log("OK: comandos sem limite não são registrados");

	// Admins: limitados por padrão, fora do limite com ignoreAdmins
	const originalIsAdmin = handler.adminUtils.isAdmin;
	handler.adminUtils.isAdmin = async (userId) => userId === ALICE;
	try {
		const limitedAdmins = {
			id: GROUP_ID,
			commandLimits: [{ command: "roleta", maxUses: 1, hours: 24, scope: "global" }]
		};
		handler.commandLimitTracker = createMemoryTracker();
		executions = 0;
		await run(ALICE, limitedAdmins);
		await run(ALICE, limitedAdmins);
		assert.strictEqual(executions, 1);
		console.log("OK: sem ignoreAdmins o admin respeita o limite");

		const adminsFree = {
			id: GROUP_ID,
			commandLimits: [
				{ command: "roleta", maxUses: 1, hours: 24, scope: "global", ignoreAdmins: true }
			]
		};
		handler.commandLimitTracker = createMemoryTracker();
		executions = 0;
		await run(ALICE, adminsFree);
		await run(ALICE, adminsFree);
		await run(BOB, adminsFree);
		await run(BOB, adminsFree);
		assert.strictEqual(executions, 3);
		assert.strictEqual(handler.commandLimitTracker.usages.length, 1);
		console.log("OK: com ignoreAdmins o admin não é bloqueado nem conta no limite");
	} finally {
		handler.adminUtils.isAdmin = originalIsAdmin;
	}
}

function limitedGroup(scope, maxUses = 1) {
	return { id: GROUP_ID, commandLimits: [{ command: "roleta", maxUses, hours: 24, scope }] };
}

/** Mensagem de grupo que registra as reações feitas pelo bot */
function trackedMessage(author, reactions) {
	const message = createMessage({ content: "!roleta", group: GROUP_ID, author });
	message.origin.react = async (emoji) => reactions.push(emoji);
	return message;
}

async function testNoticesAndIdentity() {
	const handler = new CommandHandler();
	const command = {
		name: "roleta",
		method: async (_bot, message) => new ReturnMessage({ chatId: message.group, content: "bang" })
	};
	const limitNotices = () =>
		bot.capturedMessages.filter((m) => String(m.content).includes("limite do comando")).length;
	const reactions = [];
	const run = (message, group) => handler.executeFixedCommand(bot, message, command, [], group);

	// Aviso limitado a um a cada 30s; a reação 🚫 acontece sempre
	handler.commandLimitTracker = createMemoryTracker();
	bot.resetCapture();
	const group = limitedGroup("user");
	await run(trackedMessage(ALICE, reactions), group);
	await run(trackedMessage(ALICE, reactions), group);
	await run(trackedMessage(ALICE, reactions), group);
	assert.strictEqual(limitNotices(), 1);
	assert.strictEqual(reactions.filter((emoji) => emoji === "🚫").length, 2);
	console.log("OK: aviso de limite não se repete dentro de 30s");

	// Comando via reação: não reage nem avisa na mensagem de outra pessoa
	bot.resetCapture();
	reactions.length = 0;
	const reactionMessage = trackedMessage(ALICE, reactions);
	reactionMessage.originReaction = { senderId: ALICE, reaction: "🎲" };
	handler.cooldownMessages = {};
	assert.strictEqual(await run(reactionMessage, group), null);
	assert.strictEqual(reactions.length, 0);
	assert.strictEqual(limitNotices(), 0);
	console.log("OK: limite atingido via reação fica em silêncio");

	// LID e PN da mesma pessoa contam no mesmo limite
	const LID = "123456789012345@lid";
	bot.lidToPnMap = new Map([[LID, "5511999999999"]]);
	try {
		handler.commandLimitTracker = createMemoryTracker();
		await run(trackedMessage(ALICE, reactions), group);
		assert.strictEqual(await run(trackedMessage(LID, reactions), group), null);
		assert.deepStrictEqual(
			handler.commandLimitTracker.usages.map((usage) => usage.userId),
			["5511999999999"]
		);
		console.log("OK: LID resolvido para PN conta no mesmo limite por pessoa");
	} finally {
		delete bot.lidToPnMap;
	}
}

async function testCustomCommandLimit() {
	const handler = new CommandHandler();
	handler.commandLimitTracker = createMemoryTracker();
	const group = { ...limitedGroup("global"), prefix: "!", name: "teste" };
	const customCommand = { startsWith: "roleta", responses: ["bang"], active: true };
	const run = () =>
		handler.executeCustomCommand(
			bot,
			createMessage({ content: "!roleta", group: GROUP_ID, author: ALICE }),
			customCommand,
			[],
			group
		);

	bot.resetCapture();
	await run();
	assert.strictEqual(await run(), null);
	assert.strictEqual(handler.commandLimitTracker.usages.length, 1);
	assert.ok(bot.capturedMessages.some((m) => String(m.content).includes("limite do grupo")));
	console.log("OK: comando personalizado respeita o limite");
}

async function testUpdateGroupRoute() {
	const saved = [];
	const app = express();
	app.use(express.json());
	registerManagementRoutes({
		app,
		bots: [],
		authenticateBasic: (req, res, next) => next(),
		strictLimiter: (req, res, next) => next(),
		generalLimiter: (req, res, next) => next(),
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
		database: {
			getGroup: async (id) => ({ id }),
			saveGroup: async (group) => saved.push(group)
		},
		readWebManagementToken: async () => ({
			groupId: GROUP_ID,
			expiresAt: new Date(Date.now() + HOUR_MS).toISOString()
		})
	});
	const server = app.listen(0);
	const url = `http://127.0.0.1:${server.address().port}/api/update-group`;
	const post = (commandLimits) =>
		axios.post(
			url,
			{ token: "t", groupId: GROUP_ID, changes: { commandLimits } },
			{ validateStatus: () => true }
		);

	try {
		const ok = await post([
			{ command: "!Roleta", maxUses: "10", scope: "user", ignoreAdmins: true }
		]);
		assert.strictEqual(ok.status, 200);
		assert.deepStrictEqual(saved[0].commandLimits, [
			{ command: "roleta", maxUses: 10, hours: 24, scope: "user", ignoreAdmins: true }
		]);

		const invalid = await post([{ command: "roleta", maxUses: 0 }]);
		assert.strictEqual(invalid.status, 400);
		assert.match(invalid.data.message, /entre 1 e 1000/);
		assert.strictEqual(saved.length, 1);
		console.log("OK: /api/update-group normaliza e rejeita limites inválidos");
	} finally {
		server.close();
	}
}

async function main() {
	testValidateCommandLimits();
	testFindAndDescribe();
	testEvaluateUsage();
	testGroupPersistence();
	await testCommandHandlerEnforcement();
	await testNoticesAndIdentity();
	await testCustomCommandLimit();
	await testUpdateGroupRoute();
	console.log("\nTodos os testes de limite de frequência passaram.");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
