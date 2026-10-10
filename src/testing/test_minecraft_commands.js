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

// Resposta real da api.mcsrvstat.us (icon/debug reduzidos)
const ONLINE_RESPONSE = {
	ip: "186.212.11.212",
	port: 25565,
	motd: { raw: ["Allons-y"], clean: ["Allons-y"], html: ["Allons-y"] },
	players: {
		online: 3,
		max: 30,
		list: [
			{ name: "bpz3r4", uuid: "0c757b36-1522-3a29-ab66-1e2e1cdf01ea" },
			{ name: "__Dian__", uuid: "5d7e17b1-347d-3918-856b-784b57dba3ba" }
		]
	},
	version: "26.3",
	online: true,
	protocol: { version: 777, name: "26.3" },
	hostname: "biaginimatt.ddns.net",
	software: "Paper",
	info: { raw: [".folkita8929"], clean: [".folkita8929"], html: [".folkita8929"] },
	eula_blocked: false
};

const OFFLINE_RESPONSE = { ip: "", port: 25565, online: false, hostname: "offline.com" };

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
	assert.deepStrictEqual(parseServerAddress("186.212.11.212:25565"), {
		host: "186.212.11.212",
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

function testStatusMessageWithRealApiResponse() {
	const server = { host: "biaginimatt.ddns.net", port: 25565 };
	assert.deepStrictEqual(MinecraftServerService.extractPlayerNames(ONLINE_RESPONSE), [
		"bpz3r4",
		"__Dian__",
		".folkita8929"
	]);

	const text = MinecraftServerService.formatStatusMessage(server, ONLINE_RESPONSE);
	assert.ok(text.includes("🟢"));
	assert.ok(text.includes("biaginimatt.ddns.net:25565"));
	assert.ok(text.includes("3/30"));
	assert.ok(text.includes("bpz3r4, __Dian__, .folkita8929"));

	const partial = MinecraftServerService.formatStatusMessage(server, {
		online: true,
		players: { online: 5, max: 20, list: [{ name: "steve" }] }
	});
	assert.ok(partial.includes("steve e mais 4"), partial);

	const offline = MinecraftServerService.formatStatusMessage(server, OFFLINE_RESPONSE);
	assert.ok(offline.includes("🔴") && offline.includes("offline"));
	console.log("✓ formatStatusMessage");
}

async function testConfigureServer() {
	const group = { id: GROUP_ID, name: "teste" };

	await MinecraftCommands.configureServerCommand(
		null,
		groupMessage("!configurar-servidor servidor.com:25300"),
		["servidor.com:25300"],
		group
	);
	assert.deepStrictEqual(group.minecraftServer, { host: "servidor.com", port: 25300 });

	const invalid = await MinecraftCommands.configureServerCommand(
		null,
		groupMessage("!configurar-servidor servidor.com:abc"),
		["servidor.com:abc"],
		group
	);
	assert.ok(invalid.content.includes("❌"));
	assert.deepStrictEqual(group.minecraftServer, { host: "servidor.com", port: 25300 });

	await MinecraftCommands.configureServerCommand(
		null,
		groupMessage("!configurar-servidor remover"),
		["remover"],
		group
	);
	assert.strictEqual(group.minecraftServer, null);
	console.log("✓ !configurar-servidor");
}

async function testServerStatus() {
	const notConfigured = await MinecraftCommands.serverStatusCommand(
		null,
		groupMessage("!servidor"),
		[],
		{ id: GROUP_ID, minecraftServer: null }
	);
	assert.ok(notConfigured.content.includes("!configurar-servidor"));

	const group = { id: GROUP_ID, minecraftServer: { host: "biaginimatt.ddns.net", port: 25565 } };
	const calls = mockApi(ONLINE_RESPONSE);
	const online = await MinecraftCommands.serverStatusCommand(
		null,
		groupMessage("!servidor"),
		[],
		group
	);
	assert.strictEqual(calls[0].url, "https://api.mcsrvstat.us/3/biaginimatt.ddns.net:25565");
	assert.ok(calls[0].options.headers["User-Agent"], "API exige User-Agent");
	assert.ok(online.content.includes("bpz3r4, __Dian__, .folkita8929"));

	mockApi(OFFLINE_RESPONSE);
	const offline = await MinecraftCommands.serverStatusCommand(
		null,
		groupMessage("!servidor"),
		[],
		group
	);
	assert.ok(offline.content.includes("offline"));

	axios.get = async () => {
		throw new Error("timeout");
	};
	const failure = await MinecraftCommands.serverStatusCommand(
		null,
		groupMessage("!servidor"),
		[],
		group
	);
	assert.ok(failure.content.includes("⚠️"));
	console.log("✓ !servidor");
}

async function runTests() {
	console.log("=== Testes do servidor Minecraft ===");
	testParseServerAddress();
	testStatusMessageWithRealApiResponse();
	await testConfigureServer();
	await testServerStatus();
	console.log("\n✅ Todos os testes passaram");
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
