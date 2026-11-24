process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.DEBUG = "false";
process.env.BOTS_JSON = "[]";
delete process.env.BOTAPI_USER;
delete process.env.BOTAPI_PASSWORD;

const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const axios = require("axios");
const BetterSQLite = require("better-sqlite3");
const { ChannelType, Status } = require("discord.js");
const { context, trace } = require("@opentelemetry/api");
const { AsyncLocalStorageContextManager } = require("@opentelemetry/context-async-hooks");
const {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} = require("@opentelemetry/sdk-trace-base");

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const spanExporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
	new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] })
);

const DatabaseMappers = require("../utils/db/DatabaseMappers");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-in-group-"));
const openConnection = DatabaseMappers.prototype.getConnection;
DatabaseMappers.prototype.getConnection = function (name) {
	this.databasePath = this.testDataDir ?? dataDir;
	return openConnection.call(this, name);
};

const BOTS_JSON_PATH = path.join(__dirname, "../../bots.json");
const readFile = fs.promises.readFile;
fs.promises.readFile = async (file, ...args) => {
	if (path.resolve(String(file)) === BOTS_JSON_PATH) {
		throw Object.assign(new Error("bots.json ausente no teste"), { code: "ENOENT" });
	}
	return readFile(file, ...args);
};

const Database = require("../utils/Database");
const database = Database.getInstance({ disableBackup: true, testMode: false });
const CoreRepository = require("../utils/db/repositories/CoreRepository");
const Group = require("../models/Group");
const EventHandler = require("../EventHandler");
const BotAPI = require("../BotAPI");
const TelegramBot = require("../TelegramBot");
const DiscordBot = require("../DiscordBot");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");

const eventHandler = new EventHandler();
const bots = [];
let baseUrl;
let sequence = 0;

const newGroupId = () => `1203630000000${String(++sequence).padStart(5, "0")}@g.us`;

function newBot(id, options = {}) {
	const bot = new FakeBot({ id, testMode: false, phoneNumber: `551199999${1000 + sequence++}` });
	Object.assign(bot, { isConnected: true, eventHandler }, options);
	bots.push(bot);
	return bot;
}

async function savedGroup(id = newGroupId(), data = {}) {
	await database.saveGroup(
		new Group({ id, name: `grupo${++sequence}`, interact: { enabled: false }, ...data })
	);
	return id;
}

const talk = (bot, group) =>
	eventHandler.processMessage(bot, createMessage({ content: "bom dia", group }));

const join = (bot, group, data = {}) =>
	eventHandler.processGroupJoin(bot, {
		group: { id: group, name: `Grupo ${group.slice(-9, -5)}` },
		user: { id: `${bot.phoneNumber}@s.whatsapp.net`, name: bot.id },
		responsavel: { id: "5511999990009@s.whatsapp.net", name: "Admin" },
		origin: { getChat: async () => ({ name: "Grupo", participants: [] }) },
		isBotJoining: true,
		...data
	});

const leave = (bot, group, data = {}) =>
	eventHandler.processGroupLeave(bot, {
		group: { id: group, name: "Grupo" },
		user: { id: `${bot.phoneNumber}@s.whatsapp.net`, name: bot.id },
		responsavel: { id: "5511999990009@s.whatsapp.net", name: "Admin" },
		...data
	});

async function api(route) {
	const { data } = await axios.get(`${baseUrl}${route}`, {
		auth: { username: "admin", password: "senha12345" }
	});
	return data;
}

async function dossier(groupId) {
	await database.dbRun(
		"summaries",
		"INSERT OR REPLACE INTO group_dossier_status (group_id, total_length_recorded, pending_text) VALUES (?, 10, '')",
		[groupId]
	);
	await database.dbRun(
		"summaries",
		"INSERT INTO group_dossiers (group_id, dossier_json, created_at) VALUES (?, ?, ?)",
		[groupId, JSON.stringify({ type: "amigos", summary: "ok", problematic_score: 1 }), Date.now()]
	);
	return (await api("/api/groups-dossier")).find((g) => g.id === groupId);
}

const botsInGroup = async (groupId) => (await dossier(groupId)).bots_in_group;

async function groupsCount(botName) {
	return (await api("/api/bots")).find((b) => b.nome === botName).groupsCount;
}

const LEGACY_GROUPS =
	"CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT, bot_not_in_group TEXT, json_data TEXT)";

function openRepository(dir) {
	const mappers = new DatabaseMappers({ schemas: {} });
	mappers.testDataDir = dir;
	return new CoreRepository(mappers);
}

function rawCore(dir) {
	fs.mkdirSync(path.join(dir, "sqlites"), { recursive: true });
	return new BetterSQLite(path.join(dir, "sqlites", "core.db"));
}

async function discordGateway(id) {
	const speaker = newBot(id, { useDiscord: true });
	const joins = [];
	const leaves = [];
	const discord = new DiscordBot({
		id,
		discordToken: "ficticio",
		eventHandler: {
			onGroupJoin: (bot, data) => joins.push(data),
			onGroupLeave: (bot, data) => leaves.push(eventHandler.processGroupLeave(speaker, data))
		}
	});
	discord.apiClient.connect = async () => {};
	await discord.initialize();

	const { discordClient: client } = discord;
	client.user = { id: "700000000000000001", username: "ravena" };
	client.ws.status = Status.Ready;
	client.ws._ws = new EventEmitter();
	client.ws.shards.set(0, {
		status: Status.Ready,
		send: () => {
			throw new Error("sem rede no teste");
		}
	});
	client.ws.attachEvents();

	const dispatch = async (t, d) => {
		client.ws._ws.emit("dispatch", { data: { t, d }, shardId: 0 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		await Promise.all(leaves.splice(0));
	};
	return { client, dispatch, joins, speaker };
}

const guildPacket = (id, channels, threads = []) => ({
	id,
	name: `Servidor ${id}`,
	owner_id: "700000000000000009",
	channels: channels.map((channel) => ({
		id: channel,
		type: ChannelType.GuildText,
		name: "geral"
	})),
	threads: threads.map((thread) => ({
		id: thread,
		type: ChannelType.PublicThread,
		parent_id: channels[0],
		name: "topico"
	}))
});

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("banco existente ganha a coluna uma vez e mantém os grupos", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-legado-"));
	const legacy = rawCore(dir);
	legacy.exec(LEGACY_GROUPS);
	legacy.prepare("INSERT INTO groups (id, name) VALUES ('antigo@g.us', 'grupo antigo')").run();
	legacy.close();

	openRepository(dir);
	const [group] = await openRepository(dir).getGroups();
	assert.strictEqual(group.name, "grupo antigo");
	assert.deepStrictEqual(group.botsInGroup, []);
});

test("banco novo nasce com a coluna vazia", async () => {
	const repository = openRepository(fs.mkdtempSync(path.join(os.tmpdir(), "bots-novo-")));
	await repository.saveGroup(new Group({ id: "novo@g.us", name: "grupo novo" }));
	const [group] = await repository.getGroups();
	assert.deepStrictEqual(group.botsInGroup, []);
});

test("código antigo grava o grupo sem apagar a lista", async () => {
	const groupId = await savedGroup();
	await talk(newBot("bot-versao"), groupId);

	const oldVersion = rawCore(dataDir);
	oldVersion
		.prepare(
			`INSERT INTO groups (id, name, prefix) VALUES (?, 'versaoantiga', '.')
			 ON CONFLICT(id) DO UPDATE SET name = excluded.name, prefix = excluded.prefix`
		)
		.run(groupId);
	oldVersion.close();

	assert.deepStrictEqual(await botsInGroup(groupId), ["bot-versao"]);
});

test("grupo sem registro continua com '-' no dossiê", async () => {
	const group = await dossier(await savedGroup());
	assert.strictEqual(group.bot_id, "-");
	assert.deepStrictEqual(group.bots_in_group, []);
});

test("grupo do cache, de antes da coluna, se preenche na mensagem", async () => {
	const groupId = await savedGroup();
	assert.ok(eventHandler.groups[groupId] instanceof Group);
	await talk(newBot("bot-cache"), groupId);
	const group = await dossier(groupId);
	assert.strictEqual(group.bot_id, "bot-cache");
	assert.deepStrictEqual(group.bots_in_group, ["bot-cache"]);
});

test("grupo novo se preenche na primeira mensagem e na entrada do bot", async () => {
	const byMessage = newGroupId();
	await talk(newBot("bot-msg"), byMessage);
	assert.deepStrictEqual(await botsInGroup(byMessage), ["bot-msg"]);

	const byJoin = newGroupId();
	await join(newBot("bot-join"), byJoin);
	assert.deepStrictEqual(await botsInGroup(byJoin), ["bot-join"]);
});

test("dois bots ao mesmo tempo ficam os dois", async () => {
	const groupId = await savedGroup();
	const a = newBot("bot-a");
	const b = newBot("bot-b");
	await Promise.all([talk(a, groupId), talk(b, groupId), talk(a, groupId), talk(b, groupId)]);
	const group = await dossier(groupId);
	assert.deepStrictEqual([...group.bots_in_group].sort(), ["bot-a", "bot-b"]);
	assert.deepStrictEqual(group.bot_id.split(", ").sort(), ["bot-a", "bot-b"]);
});

test("gravar uma cópia velha do grupo não tira bot da lista", async () => {
	const groupId = await savedGroup();
	const staleCached = eventHandler.groups[groupId];
	const staleRow = (await database.getGroups()).find((g) => g.id === groupId);
	await talk(newBot("bot-velho"), groupId);

	await database.saveGroup(staleRow);
	assert.deepStrictEqual(await botsInGroup(groupId), ["bot-velho"]);
	await database.saveGroup(staleCached);
	assert.deepStrictEqual(await botsInGroup(groupId), ["bot-velho"]);
});

test("mensagem só grava o grupo quando a lista muda", async () => {
	const groupId = await savedGroup();
	const bot = newBot("bot-repetido");
	const core = rawCore(dataDir);
	core.exec(`CREATE TABLE group_writes (id TEXT);
		CREATE TRIGGER count_group_writes AFTER UPDATE ON groups
		BEGIN INSERT INTO group_writes VALUES (new.id); END`);
	const writes = () =>
		core.prepare("SELECT COUNT(*) AS n FROM group_writes WHERE id = ?").get(groupId).n;
	try {
		await talk(bot, groupId);
		const afterFirst = writes();
		assert.strictEqual(afterFirst, 1, "a primeira mensagem grava a lista");
		for (let i = 0; i < 20; i++) await talk(bot, groupId);
		assert.strictEqual(writes(), afterFirst, "as outras não gravam");
		await talk(newBot("bot-segundo"), groupId);
		assert.strictEqual(writes(), afterFirst + 1, "bot novo grava de novo");
	} finally {
		core.exec("DROP TRIGGER count_group_writes; DROP TABLE group_writes");
		core.close();
	}
});

test("saída do bot o tira da lista, sem grupo de logs e só ele", async () => {
	const groupId = await savedGroup();
	const gone = newBot("bot-expulso");
	const stays = newBot("bot-fica");
	await talk(gone, groupId);
	await talk(stays, groupId);

	await leave(stays, groupId, { user: { id: "5511888880001@s.whatsapp.net", name: "Membro" } });
	assert.deepStrictEqual(await botsInGroup(groupId), ["bot-expulso", "bot-fica"]);

	await leave(gone, groupId);
	assert.deepStrictEqual(await botsInGroup(groupId), ["bot-fica"]);
	await leave(gone, groupId);
	assert.deepStrictEqual(await botsInGroup(groupId), ["bot-fica"]);

	await join(gone, groupId);
	assert.deepStrictEqual([...(await botsInGroup(groupId))].sort(), ["bot-expulso", "bot-fica"]);
});

test("saída do bot de grupo de sistema também o tira da lista", async () => {
	const groupId = await savedGroup();
	const bot = newBot("bot-logs", { grupoLogs: groupId });
	await talk(bot, groupId);
	await leave(bot, groupId, { group: { id: groupId, name: "Logs", notInGroup: true } });
	assert.deepStrictEqual(await botsInGroup(groupId), []);
});

test("bot desconectado, sem processo ou sem listGroups mostra os últimos grupos conhecidos", async () => {
	const groups = [await savedGroup(), await savedGroup(), await savedGroup()];
	const live = newBot("bot-vivo", { listGroups: async () => new Array(7).fill({}) });
	const down = newBot("bot-desconectado", { listGroups: async () => new Array(7).fill({}) });
	const silent = newBot("bot-sem-resposta", { listGroups: async () => undefined });
	const failing = newBot("bot-com-erro", { listGroups: () => Promise.reject(new Error("503")) });
	const telegram = newBot("bot-telegram", { useTelegram: true });
	const discord = newBot("bot-discord", { useDiscord: true });
	const banned = newBot("bot-banido");
	for (const groupId of groups) {
		for (const bot of [live, down, silent, failing, telegram, discord, banned]) {
			await talk(bot, groupId);
		}
	}
	down.isConnected = false;
	bots.splice(bots.indexOf(banned), 1);
	process.env.BOTS_JSON = JSON.stringify([
		{ nome: "bot-banido", numero: "5511999990077", enabled: false, banido: true },
		{ nome: "bot-nunca-visto", numero: "5511999990078", enabled: false }
	]);

	assert.strictEqual(await groupsCount("bot-vivo"), 7, "com listGroups vale a resposta ao vivo");
	assert.strictEqual(await groupsCount("bot-desconectado"), 3);
	assert.strictEqual(await groupsCount("bot-sem-resposta"), 3);
	assert.strictEqual(await groupsCount("bot-com-erro"), 3);
	assert.strictEqual(await groupsCount("bot-telegram"), 3);
	assert.strictEqual(await groupsCount("bot-discord"), 3);
	assert.strictEqual(await groupsCount("bot-banido"), 3, "fora de api.bots");
	assert.strictEqual(await groupsCount("bot-nunca-visto"), 0);
	assert.ok((await botsInGroup(groups[0])).includes("bot-desconectado"));
	assert.ok((await botsInGroup(groups[0])).includes("bot-banido"));
});

test("Telegram: expulsão avisada por my_chat_member tira o bot da lista", async () => {
	const groupId = await savedGroup("-100999000001");
	const telegram = new TelegramBot({
		id: "bot-tg",
		telegramBotToken: "123456789:TOKEN-FICTICIO-PARA-TESTE",
		telegramBotId: "900000001",
		eventHandler
	});
	const memberUpdate = (status) =>
		telegram._processUpdate({
			my_chat_member: {
				chat: { id: -100999000001, title: "Grupo", type: "supergroup" },
				new_chat_member: { status, user: { id: 900000001 } }
			}
		});
	telegram.botInfo = { id: 900000001 };

	for (const status of ["left", "kicked"]) {
		await talk(newBot("bot-tg", { useTelegram: true }), groupId);
		await memberUpdate("administrator");
		assert.deepStrictEqual(await botsInGroup(groupId), ["bot-tg"]);
		await memberUpdate(status);
		assert.deepStrictEqual(await botsInGroup(groupId), [], status);
	}
});

test("entrada de outro membro não registra o bot, a do próprio bot registra", async () => {
	const groupId = await savedGroup();
	const bot = newBot("bot-entrada");
	await join(bot, groupId, {
		user: { id: "5511888880002@s.whatsapp.net", name: "Membro" },
		isBotJoining: false
	});
	assert.deepStrictEqual(await botsInGroup(groupId), []);
	await join(bot, groupId);
	assert.deepStrictEqual(await botsInGroup(groupId), ["bot-entrada"]);
});

test("Discord: sair do servidor tira só os canais e tópicos dele", async () => {
	const left = "800000000000000001";
	const stays = "800000000000000002";
	const outage = "800000000000000003";
	const channels = {
		leftChannel: await savedGroup("900000000000000001"),
		leftThread: await savedGroup("900000000000000002"),
		staysChannel: await savedGroup("900000000000000003"),
		staysArchivedThread: await savedGroup("900000000000000004"),
		outageChannel: await savedGroup("900000000000000005")
	};
	const { client, dispatch, speaker } = await discordGateway("bot-dc");
	client.guilds._add({ id: outage, unavailable: true, shardId: 0 });
	await dispatch("GUILD_CREATE", guildPacket(left, [channels.leftChannel], [channels.leftThread]));
	await dispatch("GUILD_CREATE", guildPacket(stays, [channels.staysChannel]));
	for (const channel of Object.values(channels)) await talk(speaker, channel);
	await talk(newBot("bot-zap"), channels.leftChannel);

	await dispatch("GUILD_DELETE", { id: left });

	assert.deepStrictEqual(await botsInGroup(channels.leftChannel), ["bot-zap"]);
	assert.deepStrictEqual(await botsInGroup(channels.leftThread), []);
	assert.deepStrictEqual(await botsInGroup(channels.staysChannel), ["bot-dc"]);
	assert.deepStrictEqual(await botsInGroup(channels.staysArchivedThread), ["bot-dc"]);
	assert.deepStrictEqual(await botsInGroup(channels.outageChannel), ["bot-dc"]);
});

test("Discord: servidor em queda não é saída e a saída depois da volta vale", async () => {
	const guild = "800000000000000004";
	const channel = await savedGroup("900000000000000006");
	const { dispatch, speaker } = await discordGateway("bot-dc-queda");
	await dispatch("GUILD_CREATE", guildPacket(guild, [channel]));
	await talk(speaker, channel);

	await dispatch("GUILD_DELETE", { id: guild, unavailable: true });
	assert.deepStrictEqual(await botsInGroup(channel), ["bot-dc-queda"]);

	await dispatch("GUILD_CREATE", guildPacket(guild, [channel]));
	assert.deepStrictEqual(await botsInGroup(channel), ["bot-dc-queda"]);
	await dispatch("GUILD_DELETE", { id: guild });
	assert.deepStrictEqual(await botsInGroup(channel), []);
});

test("Discord: sem saber os canais do servidor, a saída não tira nenhum", async () => {
	const guild = "800000000000000005";
	const channel = await savedGroup("900000000000000007");
	const { client, dispatch, speaker } = await discordGateway("bot-dc-indisponivel");
	client.guilds._add({ id: guild, unavailable: true, shardId: 0 });
	await talk(speaker, channel);

	await dispatch("GUILD_DELETE", { id: guild });
	assert.deepStrictEqual(await botsInGroup(channel), ["bot-dc-indisponivel"]);
});

test("Discord: o servidor não conta além dos canais", async () => {
	const channel = await savedGroup("900000000000000008");
	const { dispatch, joins, speaker } = await discordGateway("bot-dc-conta");
	await dispatch("GUILD_CREATE", guildPacket("800000000000000006", [channel]));
	assert.strictEqual(joins.length, 1);
	await eventHandler.processGroupJoin(speaker, joins[0]);
	await talk(speaker, channel);
	assert.strictEqual(await groupsCount("bot-dc-conta"), 1);
});

test("conteúdo inválido na coluna vira lista vazia, sem acusar banco corrompido, e se conserta", async () => {
	const reported = [];
	const { handleCorruption } = database.backupSystem;
	database.backupSystem.handleCorruption = async (name, error) => reported.push(error.message);
	const core = rawCore(dataDir);
	const bot = newBot("bot-invalido");
	const invalid = [
		"bot-a,bot-b",
		"",
		"[",
		'["bot-a"',
		"['bot-a']",
		"[".repeat(3000),
		"null",
		"5",
		'"bot-invalido"',
		'{"a":"bot-invalido"}',
		Buffer.from("bot-a"),
		Buffer.from([0xff, 0x00, 0x7f])
	];
	try {
		for (const [index, value] of invalid.entries()) {
			const label = `valor ${String(value).slice(0, 20)}`;
			const groupId = await savedGroup();
			core.prepare("UPDATE groups SET bots_in_group = ? WHERE id = ?").run(value, groupId);

			const group = await dossier(groupId);
			assert.deepStrictEqual(group.bots_in_group, [], label);
			assert.strictEqual(group.bot_id, "-", label);
			assert.strictEqual(await groupsCount("bot-invalido"), index, label);
			await leave(bot, groupId);
			assert.deepStrictEqual(await botsInGroup(groupId), [], label);

			await talk(bot, groupId);
			assert.deepStrictEqual(await botsInGroup(groupId), ["bot-invalido"], label);
			assert.strictEqual(await groupsCount("bot-invalido"), index + 1, label);
		}
		assert.deepStrictEqual(reported, []);
	} finally {
		core.exec("UPDATE groups SET bots_in_group = NULL WHERE bots_in_group NOT LIKE '[\"%\"]'");
		core.close();
		database.backupSystem.handleCorruption = handleCorruption;
	}
});

test("erro do banco na lista não para a mensagem, o painel nem o dossiê", async () => {
	const groupId = await savedGroup();
	const bot = newBot("bot-erro");
	const core = rawCore(dataDir);
	core.exec("ALTER TABLE groups RENAME COLUMN bots_in_group TO bots_in_group_fora");
	try {
		await eventHandler.processMessage(bot, createMessage({ content: "!ping", group: groupId }));
		for (let i = 0; i < 100 && bot.capturedMessages.length === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(bot.capturedMessages.length > 0, "o comando responde");
		assert.strictEqual(await groupsCount("bot-erro"), 0);
		assert.deepStrictEqual(await botsInGroup(groupId), []);
	} finally {
		core.exec("ALTER TABLE groups RENAME COLUMN bots_in_group_fora TO bots_in_group");
		core.close();
	}
	await talk(bot, groupId);
	assert.strictEqual(await groupsCount("bot-erro"), 1);
});

test("telemetria: um span por mudança da lista e nenhum sem mudança", async () => {
	const groupId = await savedGroup();
	const bot = newBot("bot-span");
	spanExporter.reset();
	await talk(bot, groupId);
	await talk(bot, groupId);
	await leave(bot, groupId);
	await leave(bot, groupId);
	const spans = spanExporter
		.getFinishedSpans()
		.filter((span) => span.name === "group bots_in_group.update");
	assert.deepStrictEqual(
		spans.map((span) => [
			span.attributes["ravena.bot.id"],
			span.attributes["ravena.group.bot_present"]
		]),
		[
			["bot-span", true],
			["bot-span", false]
		]
	);
});

test("banco travado por outro processo segura uma mensagem, não todas", async () => {
	const groups = [];
	for (let i = 0; i < 5; i++) groups.push(await savedGroup());
	const bot = newBot("bot-travado");
	const gone = newBot("bot-travado-sai");
	await talk(gone, groups[0]);
	const now = Date.now;
	const main = database.mappers.getConnection("core");
	main.pragma("busy_timeout = 800");
	const other = rawCore(dataDir);
	other.exec("BEGIN IMMEDIATE");
	try {
		const start = performance.now();
		for (const groupId of groups) await talk(bot, groupId);
		const elapsed = Math.round(performance.now() - start);
		assert.ok(elapsed >= 800, `a primeira espera a trava (${elapsed} ms)`);
		assert.ok(elapsed < 2000, `as outras não esperam de novo (${elapsed} ms)`);
		other.exec("COMMIT");

		await leave(gone, groups[0]);
		assert.deepStrictEqual(await botsInGroup(groups[0]), [], "a saída não espera a pausa");
		Date.now = () => now() + 10 * 60 * 1000;
		for (const groupId of groups) await talk(bot, groupId);
		assert.strictEqual(await groupsCount("bot-travado"), groups.length);
	} finally {
		Date.now = now;
		if (other.inTransaction) other.exec("ROLLBACK");
		other.close();
		main.pragma("busy_timeout = 5000");
	}
});

async function main() {
	const botApi = new BotAPI({ bots, eventHandler });
	const server = http.createServer(botApi.app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;

	let failures = 0;
	for (const { name, fn } of cases) {
		try {
			await fn();
			console.log(`[OK] ${name}`);
		} catch (error) {
			failures++;
			console.error(`[FALHOU] ${name}\n  ${String(error.message).split("\n").join("\n  ")}`);
		}
	}
	console.log(`${cases.length - failures}/${cases.length} casos passaram`);
	return failures;
}

main()
	.then((failures) => process.exit(failures ? 1 : 0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
