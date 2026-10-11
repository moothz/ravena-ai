process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const axios = require("axios");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");

// Precisa vir antes dos módulos do bot: ativa testMode no Database (sem escrita real)
new FakeBot({ id: "test-bot" });

const MinecraftServerService = require("../services/MinecraftServerService");
const MinecraftCommands = require("../functions/MinecraftCommands");

const originalGet = axios.get;

const GROUP_ID = "123@g.us";

// Fixture com dados fictícios para testes unitários
const ONLINE_RESPONSE = {
	ip: "192.0.2.1",
	port: 25565,
	motd: { raw: ["Servidor Ravena"], clean: ["Servidor Ravena"] },
	players: {
		online: 3,
		max: 20,
		list: [
			{ name: "Steve", uuid: "00000000-0000-0000-0000-000000000001" },
			{ name: "Alex", uuid: "00000000-0000-0000-0000-000000000002" }
		]
	},
	version: "1.20.4",
	online: true,
	hostname: "mc.exemplo.com",
	software: "Paper",
	info: {
		raw: [".Notch", "Visite nosso discord discord.gg/fake"],
		clean: [".Notch", "Visite nosso discord discord.gg/fake"]
	}
};

const OFFLINE_RESPONSE = { ip: "", port: 25565, online: false, hostname: "offline.exemplo.com" };

function groupMessage(content) {
	return createMessage({ content, group: GROUP_ID, author: "5511999999999@s.whatsapp.net" });
}

function mockApi(response) {
	const calls = [];
	axios.get = async (url, options) => {
		calls.push({ url, options });
		return { data: response };
	};
	return calls;
}

function testParseServerAddress() {
	const { parseServerAddress } = MinecraftServerService;

	assert.deepStrictEqual(parseServerAddress("servidor.com:25300"), {
		host: "servidor.com",
		port: 25300
	});
	assert.deepStrictEqual(parseServerAddress("servidor.com"), { host: "servidor.com", port: 25565 });
	assert.deepStrictEqual(parseServerAddress("  Play.Exemplo.com  "), {
		host: "play.exemplo.com",
		port: 25565
	});
	assert.deepStrictEqual(parseServerAddress("192.0.2.1:25565"), {
		host: "192.0.2.1",
		port: 25565
	});
	assert.deepStrictEqual(parseServerAddress("[2001:db8::1]:19132"), {
		host: "2001:db8::1",
		port: 19132
	});

	for (const invalid of [
		"",
		"servidor.com:",
		"servidor.com:0",
		"servidor.com:70000",
		"servidor.com:abc",
		"http://servidor.com",
		"servidor com",
		"a:b:c"
	]) {
		assert.throws(() => parseServerAddress(invalid), `Deveria rejeitar "${invalid}"`);
	}
	console.log("✓ parseServerAddress");
}

function testStatusMessageAndPlayerExtraction() {
	const server = { host: "mc.exemplo.com", port: 25565 };

	// Verifica que nicks válidos são extraídos e propagandas são filtradas
	const players = MinecraftServerService.extractPlayerNames(ONLINE_RESPONSE);
	assert.deepStrictEqual(players, ["Steve", "Alex", ".Notch"]);

	const text = MinecraftServerService.formatStatusMessage(server, ONLINE_RESPONSE);
	assert.ok(text.includes("🟢"));
	assert.ok(text.includes("mc.exemplo.com:25565"));
	assert.ok(text.includes("3/20"));
	assert.ok(text.includes("Steve, Alex, .Notch"));

	const partial = MinecraftServerService.formatStatusMessage(server, {
		online: true,
		players: { online: 5, max: 20, list: [{ name: "Steve" }] }
	});
	assert.ok(partial.includes("Steve e mais 4"), partial);

	const offline = MinecraftServerService.formatStatusMessage(server, OFFLINE_RESPONSE);
	assert.ok(offline.includes("🔴") && offline.includes("offline"));
	console.log("✓ formatStatusMessage e extractPlayerNames");
}

function testCommandDefinitions() {
	const { commands } = MinecraftCommands;
	const cfgCmd = commands.find((c) => c.name === "minecraft-servidor");
	const aliasCmd = commands.find((c) => c.name === "mine-servidor");
	const statusCmd = commands.find((c) => c.name === "minecraft");

	assert.ok(cfgCmd, "Comando !minecraft-servidor deve existir");
	assert.strictEqual(cfgCmd.group, "minecraft-servidor");
	assert.strictEqual(cfgCmd.adminOnly, true);

	assert.ok(aliasCmd, "Comando !mine-servidor deve existir");
	assert.strictEqual(aliasCmd.group, "minecraft-servidor");
	assert.strictEqual(aliasCmd.adminOnly, true);
	assert.ok(aliasCmd.aliases.includes("mine-server"), "mine-servidor deve ter alias mine-server");

	assert.ok(statusCmd, "Comando !minecraft deve existir");
	assert.strictEqual(statusCmd.aliases.length, 0, "!minecraft não deve ter aliases");

	console.log("✓ testCommandDefinitions");
}

async function testConfigureServer() {
	const bot = new FakeBot({ id: "test-bot" });
	const group = { id: GROUP_ID, name: "teste" };

	// Mock isAdmin para considerar o autor admin neste teste
	const AdminUtils = require("../utils/AdminUtils");
	const originalIsAdmin = AdminUtils.getInstance().isAdmin;
	AdminUtils.getInstance().isAdmin = async () => true;

	try {
		await MinecraftCommands.configureServerCommand(
			bot,
			groupMessage("!minecraft-servidor play.exemplo.com:25300"),
			["play.exemplo.com:25300"],
			group
		);
		assert.deepStrictEqual(group.minecraftServer, { host: "play.exemplo.com", port: 25300 });

		const invalid = await MinecraftCommands.configureServerCommand(
			bot,
			groupMessage("!minecraft-servidor play.exemplo.com:abc"),
			["play.exemplo.com:abc"],
			group
		);
		assert.ok(invalid.content.includes("❌"));
		assert.deepStrictEqual(group.minecraftServer, { host: "play.exemplo.com", port: 25300 });

		await MinecraftCommands.configureServerCommand(
			bot,
			groupMessage("!minecraft-servidor remover"),
			["remover"],
			group
		);
		assert.strictEqual(group.minecraftServer, null);
		console.log("✓ !minecraft-servidor e remoção");
	} finally {
		AdminUtils.getInstance().isAdmin = originalIsAdmin;
	}
}

async function testServerStatus() {
	const notConfigured = await MinecraftCommands.serverStatusCommand(
		null,
		groupMessage("!minecraft"),
		[],
		{ id: GROUP_ID, minecraftServer: null }
	);
	assert.ok(notConfigured.content.includes("!minecraft-servidor"));

	const group = { id: GROUP_ID, minecraftServer: { host: "mc.exemplo.com", port: 25565 } };

	// Testa fallback de API simulado
	const calls = mockApi(ONLINE_RESPONSE);
	const online = await MinecraftCommands.serverStatusCommand(
		null,
		groupMessage("!minecraft"),
		[],
		group
	);
	assert.strictEqual(calls[0].url, "https://api.mcsrvstat.us/3/mc.exemplo.com:25565");
	assert.ok(online.content.includes("Steve, Alex, .Notch"));

	mockApi(OFFLINE_RESPONSE);
	const offline = await MinecraftCommands.serverStatusCommand(
		null,
		groupMessage("!minecraft"),
		[],
		group
	);
	assert.ok(offline.content.includes("offline"));

	axios.get = async () => {
		throw new Error("timeout");
	};
	const failure = await MinecraftCommands.serverStatusCommand(
		null,
		groupMessage("!minecraft"),
		[],
		group
	);
	assert.ok(failure.content.includes("⚠️"));
	console.log("✓ !minecraft status e fallbacks");
}

async function runTests() {
	console.log("=== Testes do servidor Minecraft (Adaptado) ===");
	testParseServerAddress();
	testStatusMessageAndPlayerExtraction();
	testCommandDefinitions();
	await testConfigureServer();
	await testServerStatus();
	console.log("\n✅ Todos os testes passaram!");
}

runTests()
	.then(() => {
		axios.get = originalGet;
		process.exit(0);
	})
	.catch((err) => {
		axios.get = originalGet;
		console.error("❌ Falha:", err);
		process.exit(1);
	});
