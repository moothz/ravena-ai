"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const StreamSystem = require("../StreamSystem");

async function testTitleFallbackWhenChatFails() {
	console.log("1. Testando fallback direto quando getChatById falha mas bot tem setGroupName...");

	const system = Object.create(StreamSystem.prototype);
	system.logger = {
		warn: () => {},
		debug: () => {},
		info: () => {},
		error: () => {}
	};
	system.substituirEmojis = StreamSystem.prototype.substituirEmojis;

	let groupNameSet = null;
	const bot = {
		id: "ravena4",
		client: {
			getChatById: async () => null // Simulando falha de rede ou 429 rate limit
		},
		setGroupName: async (groupId, title) => {
			groupNameSet = { groupId, title };
			return true;
		}
	};

	const group = {
		id: "120363313798227771@g.us",
		name: "conexommia",
		titulo: "Conexão Múmia 🥷🏼 [🔴 OFF]"
	};

	const channelConfig = {
		channel: "amumulaxd_",
		changeTitleOnEvent: true,
		onlineTitle: "Conexão Múmia 🥷🏼 [🟢 ON]",
		offlineTitle: "Conexão Múmia 🥷🏼 [🔴 OFF]"
	};

	const eventData = {
		platform: "twitch",
		channelName: "amumulaxd_"
	};

	// Evento Online
	const resOnline = await system.changeGroupTitleForStream(
		bot,
		group,
		channelConfig,
		eventData,
		"online"
	);

	assert.strictEqual(resOnline, true, "deve retornar true mesmo com chat null");
	assert.strictEqual(groupNameSet?.groupId, "120363313798227771@g.us");
	assert.strictEqual(groupNameSet?.title, "Conexão Múmia 🥷🏼 [🟢 ON]");

	// Evento Offline
	const resOffline = await system.changeGroupTitleForStream(
		bot,
		group,
		channelConfig,
		eventData,
		"offline"
	);

	assert.strictEqual(resOffline, true);
	assert.strictEqual(groupNameSet?.title, "Conexão Múmia 🥷🏼 [🔴 OFF]");
	console.log("✓ Fallback de setGroupName funcionou com sucesso!");
}

async function testFindBotsForGroupFilters() {
	console.log(
		"2. Testando findBotsForGroup filtrando botNotInGroup, isConnected e isParticipating..."
	);

	const system = Object.create(StreamSystem.prototype);
	system.bots = [
		{
			id: "ravenavip",
			name: "ravenavip",
			isConnected: true,
			isParticipating: () => true
		},
		{
			id: "ravena2",
			name: "ravena2",
			isConnected: false, // Desconectado
			isParticipating: () => true
		},
		{
			id: "ravena4",
			name: "ravena4",
			isConnected: true,
			isParticipating: () => true
		},
		{
			id: "ravena5",
			name: "ravena5",
			isConnected: true,
			isParticipating: () => false // Não participa do grupo
		}
	];

	const group = {
		id: "120363313798227771@g.us",
		botNotInGroup: ["ravenavip"] // ravenavip marcado como fora do grupo
	};

	const candidates = await system.findBotsForGroup(group.id, group);
	assert.strictEqual(candidates.length, 1, "Apenas ravena4 deve ser candidato válido");
	assert.strictEqual(candidates[0].id, "ravena4");
	console.log("✓ findBotsForGroup filtrou bots corretamente!");
}

async function testProcessStreamEventTitleRetry() {
	console.log(
		"3. Testando garantia de alteração de título mesmo se primeiro bot enviar mensagens..."
	);

	const system = Object.create(StreamSystem.prototype);
	system.logger = {
		warn: () => {},
		debug: () => {},
		info: () => {},
		error: () => {}
	};
	system.substituirEmojis = StreamSystem.prototype.substituirEmojis;
	system.getAllMembersMentions = async () => [];
	system.createEventNotification = async () => ({ content: "Live on!" });
	system.createAINotification = async () => null;

	let ravena4TitleCalled = false;

	const bot1 = {
		id: "ravenavip",
		isConnected: true,
		client: {
			getChatById: async () => ({ isGroup: true, notInGroup: true }) // Não está no grupo, falha no título
		},
		sendReturnMessages: async () => [{ id: "msg1" }] // Mas de alguma forma enviou (ex: relay ou webhook)
	};

	const bot2 = {
		id: "ravena4",
		isConnected: true,
		client: {
			getChatById: async () => ({
				isGroup: true,
				name: "Conexão Múmia 🥷🏼 [🔴 OFF]",
				setSubject: async (title) => {
					ravena4TitleCalled = title;
				}
			})
		},
		sendReturnMessages: async () => [{ id: "msg2" }]
	};

	system.findBotsForGroup = async () => [bot1, bot2];

	const group = {
		id: "120363313798227771@g.us",
		name: "conexommia",
		titulo: "Conexão Múmia 🥷🏼 [🔴 OFF]"
	};

	const channelConfig = {
		channel: "amumulaxd_",
		changeTitleOnEvent: true,
		onlineTitle: "Conexão Múmia 🥷🏼 [🟢 ON]",
		offlineTitle: "Conexão Múmia 🥷🏼 [🔴 OFF]",
		onConfig: {
			media: [{ type: "text", content: "live" }]
		}
	};

	const eventData = {
		platform: "twitch",
		channelName: "amumulaxd_"
	};

	await system.processStreamEvent(group, channelConfig, eventData, "online");

	assert.strictEqual(
		ravena4TitleCalled,
		"Conexão Múmia 🥷🏼 [🟢 ON]",
		"ravena4 deve ter sido chamado para mudar o título"
	);
	console.log("✓ Garantia de retry de título entre bots funcionou perfeitamente!");
}

async function main() {
	try {
		await testTitleFallbackWhenChatFails();
		await testFindBotsForGroupFilters();
		await testProcessStreamEventTitleRetry();
		console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
		process.exit(0);
	} catch (err) {
		console.error("FALHA NO TESTE:", err);
		process.exit(1);
	}
}

main();
