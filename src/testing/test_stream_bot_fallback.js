"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const StreamSystem = require("../StreamSystem");

async function testFindBotsForGroupPrioritizesBotsInGroup() {
	console.log("1. Testando ordenação de candidatos com botsInGroup...");

	const system = Object.create(StreamSystem.prototype);
	system.bots = [
		{ id: "bot-alfa", name: "bot-alfa", isConnected: true, isParticipating: () => true },
		{ id: "bot-beta", name: "bot-beta", isConnected: true, isParticipating: () => true },
		{ id: "bot-gama", name: "bot-gama", isConnected: true, isParticipating: () => true }
	];

	// Caso A: bot-beta está em botsInGroup -> bot-beta deve vir em primeiro
	const groupWithBeta = {
		id: "120363000000000001@g.us",
		botNotInGroup: [],
		botsInGroup: ["bot-beta"]
	};

	const candidatesA = await system.findBotsForGroup(groupWithBeta.id, groupWithBeta);
	assert.strictEqual(candidatesA.length, 3);
	assert.strictEqual(candidatesA[0].id, "bot-beta", "bot-beta deve vir em primeiro");

	// Caso B: sem botsInGroup -> ordem original preservada
	const groupWithout = {
		id: "120363000000000001@g.us",
		botNotInGroup: [],
		botsInGroup: []
	};

	const candidatesB = await system.findBotsForGroup(groupWithout.id, groupWithout);
	assert.strictEqual(candidatesB.length, 3);
	assert.strictEqual(
		candidatesB[0].id,
		"bot-alfa",
		"ordem padrão mantida quando botsInGroup está vazio"
	);
	console.log("✓ Priorização de botsInGroup funcionou perfeitamente!");
}

async function testIsNotInGroupResultDetection() {
	console.log("2. Testando detecção de erros de 'não participa do grupo'...");

	const system = Object.create(StreamSystem.prototype);

	// Casos positivos
	assert.strictEqual(system._isNotInGroupResult({ notInGroup: true }), true);
	assert.strictEqual(system._isNotInGroupResult({ error: { notInGroup: true } }), true);
	assert.strictEqual(
		system._isNotInGroupResult({
			error: new Error("Bot bot1 não participa do grupo 120363000000000001@g.us")
		}),
		true
	);
	assert.strictEqual(
		system._isNotInGroupResult({
			error: { message: "Error: not participating" }
		}),
		true
	);
	assert.strictEqual(
		system._isNotInGroupResult({
			error: { data: { error: "bot is not in group" } }
		}),
		true
	);

	// Casos negativos
	assert.strictEqual(system._isNotInGroupResult(null), false);
	assert.strictEqual(system._isNotInGroupResult({ id: "msg-123" }), false);
	assert.strictEqual(
		system._isNotInGroupResult({ error: new Error("Rate limit exceeded") }),
		false
	);
	console.log("✓ Detecção de erros de participação no grupo validada!");
}

async function testProcessStreamEventFallbackOnNotInGroup() {
	console.log(
		"3. Testando fallback do processStreamEvent quando primeiro bot pula por não estar no grupo..."
	);

	const system = Object.create(StreamSystem.prototype);
	system.logger = {
		warn: () => {},
		debug: () => {},
		info: () => {},
		error: () => {}
	};
	system.substituirEmojis = StreamSystem.prototype.substituirEmojis;
	system._isNotInGroupResult = StreamSystem.prototype._isNotInGroupResult;
	system.getAllMembersMentions = async () => [];
	system.createEventNotification = async () => ({ content: "Live de teste!" });
	system.createAINotification = async () => null;

	let bot1MarkNotInGroupCalled = false;
	let bot2SendCalled = false;

	const bot1 = {
		id: "bot-fora",
		isConnected: true,
		markNotInGroup: async (gid) => {
			bot1MarkNotInGroupCalled = gid;
		},
		sendReturnMessages: async () => [
			{
				error: new Error("Bot bot-fora não participa do grupo 120363000000000099@g.us"),
				notInGroup: true,
				skipped: true
			}
		]
	};

	const bot2 = {
		id: "bot-presente",
		isConnected: true,
		sendReturnMessages: async () => {
			bot2SendCalled = true;
			return [{ id: "msg-sucesso-001" }];
		}
	};

	system.findBotsForGroup = async () => [bot1, bot2];

	const group = {
		id: "120363000000000099@g.us",
		name: "grupo-teste",
		titulo: "Grupo de Teste [🔴 OFF]"
	};

	const channelConfig = {
		channel: "streamer_teste",
		changeTitleOnEvent: false,
		onConfig: {
			media: [{ type: "text", content: "live teste" }]
		}
	};

	const eventData = {
		platform: "tiktok",
		channelName: "streamer_teste"
	};

	await system.processStreamEvent(group, channelConfig, eventData, "online");

	assert.strictEqual(
		bot1MarkNotInGroupCalled,
		"120363000000000099@g.us",
		"bot1 deve ter sido marcado como fora do grupo"
	);
	assert.strictEqual(
		bot2SendCalled,
		true,
		"bot2 deve ter recebido a mensagem e enviado com sucesso"
	);
	console.log("✓ Fallback de bot fora do grupo funcionou perfeitamente!");
}

async function testProcessStreamEventFallbackOnGenericDeliveryFailure() {
	console.log(
		"4. Testando fallback do processStreamEvent quando primeiro bot falha no envio genérico..."
	);

	const system = Object.create(StreamSystem.prototype);
	system.logger = {
		warn: () => {},
		debug: () => {},
		info: () => {},
		error: () => {}
	};
	system.substituirEmojis = StreamSystem.prototype.substituirEmojis;
	system._isNotInGroupResult = StreamSystem.prototype._isNotInGroupResult;
	system.getAllMembersMentions = async () => [];
	system.createEventNotification = async () => ({ content: "Live de teste 2!" });
	system.createAINotification = async () => null;

	let bot2SendCalled = false;

	const bot1 = {
		id: "bot-glitch",
		isConnected: true,
		sendReturnMessages: async () => [
			{
				error: new Error("Network timeout"),
				skipped: false
			}
		]
	};

	const bot2 = {
		id: "bot-reserva",
		isConnected: true,
		sendReturnMessages: async () => {
			bot2SendCalled = true;
			return [{ id: "msg-sucesso-002" }];
		}
	};

	system.findBotsForGroup = async () => [bot1, bot2];

	const group = {
		id: "120363000000000099@g.us",
		name: "grupo-teste",
		titulo: "Grupo de Teste [🔴 OFF]"
	};

	const channelConfig = {
		channel: "streamer_teste",
		changeTitleOnEvent: false,
		onConfig: {
			media: [{ type: "text", content: "live teste" }]
		}
	};

	const eventData = {
		platform: "tiktok",
		channelName: "streamer_teste"
	};

	await system.processStreamEvent(group, channelConfig, eventData, "online");

	assert.strictEqual(
		bot2SendCalled,
		true,
		"bot2 deve ser acionado quando bot1 não entrega mensagens"
	);
	console.log("✓ Fallback de falha genérica de envio funcionou perfeitamente!");
}

async function main() {
	try {
		await testFindBotsForGroupPrioritizesBotsInGroup();
		await testIsNotInGroupResultDetection();
		await testProcessStreamEventFallbackOnNotInGroup();
		await testProcessStreamEventFallbackOnGenericDeliveryFailure();
		console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
		process.exit(0);
	} catch (err) {
		console.error("FALHA NO TESTE:", err);
		process.exit(1);
	}
}

main();
