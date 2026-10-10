const assert = require("assert");

const { formatFreeGamesMessage } = require("../services/freeGames/formatFreeGamesMessage");
const GamerPowerFreeGamesSource = require("../services/freeGames/GamerPowerFreeGamesSource");
const { FREE_GAME_STORES } = require("../services/freeGames/freeGameStores");
const NotifyFreeGames = require("../services/freeGames/NotifyFreeGames");
const InMemoryWeeklyGamesRepository = require("../services/freeGames/InMemoryWeeklyGamesRepository");
const SqliteWeeklyGamesRepository = require("../services/freeGames/SqliteWeeklyGamesRepository");
const { toggleFreeGamesFlag } = require("../services/freeGames/toggleFreeGamesFlag");
const BotGroupNotifier = require("../services/freeGames/BotGroupNotifier");
const Group = require("../models/Group");
const GroupMapper = require("../utils/db/mappers/GroupMapper");

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const EPIC_STORE = FREE_GAME_STORES.find((store) => store.key === "epic");
const STEAM_STORE = FREE_GAME_STORES.find((store) => store.key === "steam");

const EPIC_GAMES = [
	{
		title: "Out of Sight",
		url: "https://www.gamerpower.com/open/out-of-sight-epic-games-giveaway"
	},
	{ title: "TerraScape", url: "https://www.gamerpower.com/open/terrascape-epic-games-giveaway" }
];

const STEAM_GAMES = [
	{
		title: "Dwarven Realms (Steam) Key Giveaway",
		url: "https://www.gamerpower.com/open/dwarven-realms-steam-key-giveaway"
	},
	{
		title: "Pony Island (Steam) Giveaway",
		url: "https://www.gamerpower.com/open/pony-island-steam-giveaway"
	},
	{
		title: "Fireside Feelings (Steam) Giveaway",
		url: "https://www.gamerpower.com/open/fireside-feelings-steam-giveaway"
	}
];

const BOTH_STORES_MESSAGE = [
	"🎮 *Jogos novos liberados!*",
	"",
	"*Epic:*",
	"*Out of Sight*",
	"🔗 https://www.gamerpower.com/open/out-of-sight-epic-games-giveaway",
	"",
	"*TerraScape*",
	"🔗 https://www.gamerpower.com/open/terrascape-epic-games-giveaway",
	"",
	"*Steam:*",
	"*Dwarven Realms (Steam) Key Giveaway*",
	"🔗 https://www.gamerpower.com/open/dwarven-realms-steam-key-giveaway",
	"",
	"*Pony Island (Steam) Giveaway*",
	"🔗 https://www.gamerpower.com/open/pony-island-steam-giveaway",
	"",
	"*Fireside Feelings (Steam) Giveaway*",
	"🔗 https://www.gamerpower.com/open/fireside-feelings-steam-giveaway"
].join("\n");

const EPIC_ONLY_MESSAGE = [
	"🎮 *Jogos novos liberados na Epic!*",
	"",
	"*Out of Sight*",
	"🔗 https://www.gamerpower.com/open/out-of-sight-epic-games-giveaway",
	"",
	"*TerraScape*",
	"🔗 https://www.gamerpower.com/open/terrascape-epic-games-giveaway"
].join("\n");

const game = (id, worthUsd = 0) => ({
	id,
	title: `Game ${id}`,
	url: `https://x.test/${id}`,
	worthUsd
});

const listed = (...games) => ({ ok: true, games });
const FAILED = { ok: false };

const entry = (id) => `*Game ${id}*\n🔗 https://x.test/${id}`;

/**
 * Monta o caso de uso com fakes só nas fronteiras (API, DB de grupos, bots).
 * `world.catalog` é mutável para simular a passagem das semanas.
 */
function buildScenario({
	groups,
	catalog = { epic: listed(), steam: listed() },
	failingGroups = []
}) {
	const world = { catalog, groups };
	const sent = [];
	const repository = new InMemoryWeeklyGamesRepository();
	const useCase = new NotifyFreeGames({
		stores: FREE_GAME_STORES,
		source: { fetchCurrentGames: async (store) => world.catalog[store.key] },
		repository,
		groupRepository: { getGroups: async () => world.groups },
		notifier: {
			notify: async (groupId, content) => {
				if (failingGroups.includes(groupId)) throw new Error("envio falhou");
				sent.push({ groupId, content });
				return true;
			}
		},
		logger: silentLogger
	});
	return { world, sent, repository, useCase };
}

const group = (id, flags = {}) => ({ id, paused: false, ...flags });
const contentFor = (sent, groupId) =>
	sent.filter((m) => m.groupId === groupId).map((m) => m.content);

/**
 * Fake do Database do projeto sobre um SQLite real em memória (mesma interface
 * usada pelo repositório: getSQLiteDb, dbRun, dbAll, dbTransaction).
 */
function createSqliteDatabaseFake() {
	const BetterSqlite3 = require("better-sqlite3");
	const connections = new Map();
	const connectionOf = (dbName) => connections.get(dbName);
	return {
		getSQLiteDb(dbName, schema) {
			if (!connections.has(dbName)) connections.set(dbName, new BetterSqlite3(":memory:"));
			connectionOf(dbName).exec(schema);
		},
		async dbRun(dbName, sql, params = []) {
			return connectionOf(dbName)
				.prepare(sql)
				.run(...params);
		},
		async dbAll(dbName, sql, params = []) {
			return connectionOf(dbName)
				.prepare(sql)
				.all(...params);
		},
		async dbTransaction(dbName, callback) {
			await this.dbRun(dbName, "BEGIN TRANSACTION");
			try {
				const result = await callback();
				await this.dbRun(dbName, "COMMIT");
				return result;
			} catch (error) {
				await this.dbRun(dbName, "ROLLBACK");
				throw error;
			}
		}
	};
}

function fakeBot({ id, results = [{}], telegram = false, skip = [] }) {
	return {
		id,
		useTelegram: telegram,
		skipGroupInfo: skip,
		sent: [],
		marked: [],
		async sendReturnMessages(message) {
			this.sent.push(message);
			return results;
		},
		async markNotInGroup(groupId) {
			this.marked.push(groupId);
		}
	};
}

const test = async (name, fn) => {
	await fn();
	console.log(`✓ ${name}`);
};

async function runTests() {
	console.log("--- Starting jogos grátis tests ---");

	// S1. formatFreeGamesMessage
	await test("format: two stores produce the labeled sections message", () => {
		const message = formatFreeGamesMessage([
			{ label: "Epic", games: EPIC_GAMES },
			{ label: "Steam", games: STEAM_GAMES }
		]);
		assert.strictEqual(message, BOTH_STORES_MESSAGE);
	});

	await test("format: only Epic puts the store in the header, without section label", () => {
		assert.strictEqual(
			formatFreeGamesMessage([{ label: "Epic", games: EPIC_GAMES }]),
			EPIC_ONLY_MESSAGE
		);
	});

	await test("format: only Steam puts the store in the header, with raw bold title", () => {
		const message = formatFreeGamesMessage([{ label: "Steam", games: [STEAM_GAMES[1]] }]);
		assert.strictEqual(
			message,
			[
				"🎮 *Jogos novos liberados na Steam!*",
				"",
				"*Pony Island (Steam) Giveaway*",
				"🔗 https://www.gamerpower.com/open/pony-island-steam-giveaway"
			].join("\n")
		);
	});

	await test("format: no sections returns null", () => {
		assert.strictEqual(formatFreeGamesMessage([]), null);
	});

	// S2. GamerPowerFreeGamesSource
	const sourceWith = (httpClient) =>
		new GamerPowerFreeGamesSource({ httpClient, logger: silentLogger });

	await test("source: requests the platform of each store, games only", async () => {
		const requested = [];
		const httpClient = {
			get: async (url, config) => {
				requested.push(config.params);
				return { data: [] };
			}
		};
		await sourceWith(httpClient).fetchCurrentGames(STEAM_STORE);
		await sourceWith(httpClient).fetchCurrentGames(EPIC_STORE);
		assert.strictEqual(requested[0].platform, "steam");
		assert.strictEqual(requested[0].type, "game");
		assert.strictEqual(requested[1].platform, "epic-games-store");
		assert.strictEqual(requested[1].type, "game");
	});

	await test("source: Epic titles are cleaned and Steam titles stay raw", async () => {
		const httpClient = {
			get: async (url, config) => ({
				data:
					config.params.platform === "steam"
						? [
								{
									id: 2,
									title: "Pony Island (Steam) Giveaway",
									open_giveaway_url: "u2",
									worth: "$4.99"
								}
							]
						: [
								{
									id: 1,
									title: "Out of Sight (Epic Games) Giveaway",
									open_giveaway_url: "u1",
									worth: "N/A"
								}
							]
			})
		};
		const epic = await sourceWith(httpClient).fetchCurrentGames(EPIC_STORE);
		const steam = await sourceWith(httpClient).fetchCurrentGames(STEAM_STORE);
		assert.strictEqual(epic.games[0].title, "Out of Sight");
		assert.strictEqual(steam.games[0].title, "Pony Island (Steam) Giveaway");
	});

	await test("source: maps id, url and worth in USD (N/A becomes 0)", async () => {
		const httpClient = {
			get: async () => ({
				data: [
					{ id: 10, title: "A", open_giveaway_url: "ua", worth: "$19.99" },
					{ id: 11, title: "B", open_giveaway_url: "ub", worth: "N/A" },
					{ id: 12, title: "C", open_giveaway_url: "uc", worth: "$1,299.50" },
					{ id: 13, title: "Sem link" }
				]
			})
		};
		const result = await sourceWith(httpClient).fetchCurrentGames(STEAM_STORE);
		assert.deepStrictEqual(result, {
			ok: true,
			games: [
				{ id: "10", title: "A", url: "ua", worthUsd: 19.99 },
				{ id: "11", title: "B", url: "ub", worthUsd: 0 },
				{ id: "12", title: "C", url: "uc", worthUsd: 1299.5 }
			]
		});
	});

	await test("source: request failure is { ok: false }, different from an empty list", async () => {
		const failing = { get: async () => Promise.reject(new Error("boom")) };
		const empty = { get: async () => ({ data: [] }) };
		assert.deepStrictEqual(await sourceWith(failing).fetchCurrentGames(STEAM_STORE), { ok: false });
		assert.deepStrictEqual(await sourceWith(empty).fetchCurrentGames(STEAM_STORE), {
			ok: true,
			games: []
		});
	});

	// S3. NotifyFreeGames
	await test("use case: group with both stores gets one message with both sections", async () => {
		const { sent, useCase } = buildScenario({
			groups: [group("a@g.us", { notificarEpic: true, notificarSteam: true })],
			catalog: { epic: listed(game("e1")), steam: listed(game("s1", 9)) }
		});
		await useCase.execute();
		assert.deepStrictEqual(contentFor(sent, "a@g.us"), [
			`🎮 *Jogos novos liberados!*\n\n*Epic:*\n${entry("e1")}\n\n*Steam:*\n${entry("s1")}`
		]);
	});

	await test("use case: each group only receives the stores it enabled", async () => {
		const { sent, useCase } = buildScenario({
			groups: [
				group("epic@g.us", { notificarEpic: true }),
				group("steam@g.us", { notificarSteam: true })
			],
			catalog: { epic: listed(game("e1")), steam: listed(game("s1")) }
		});
		await useCase.execute();
		assert.deepStrictEqual(contentFor(sent, "epic@g.us"), [
			`🎮 *Jogos novos liberados na Epic!*\n\n${entry("e1")}`
		]);
		assert.deepStrictEqual(contentFor(sent, "steam@g.us"), [
			`🎮 *Jogos novos liberados na Steam!*\n\n${entry("s1")}`
		]);
	});

	await test("use case: groups with notifications off or paused receive nothing", async () => {
		const { sent, useCase } = buildScenario({
			groups: [group("off@g.us"), group("paused@g.us", { notificarEpic: true, paused: true })],
			catalog: { epic: listed(game("e1")), steam: listed(game("s1")) }
		});
		await useCase.execute();
		assert.deepStrictEqual(sent, []);
	});

	await test("use case: Steam announces only the 3 most valuable new games, highest first", async () => {
		const { sent, useCase } = buildScenario({
			groups: [group("a@g.us", { notificarSteam: true })],
			catalog: {
				epic: listed(),
				steam: listed(game("s1", 5), game("s2", 50), game("s3", 0), game("s4", 20), game("s5", 10))
			}
		});
		await useCase.execute();
		assert.deepStrictEqual(contentFor(sent, "a@g.us"), [
			`🎮 *Jogos novos liberados na Steam!*\n\n${entry("s2")}\n\n${entry("s4")}\n\n${entry("s5")}`
		]);
	});

	await test("use case: Steam games left out of the top 3 are announced in a later week", async () => {
		const { world, sent, useCase } = buildScenario({
			groups: [group("a@g.us", { notificarSteam: true })],
			catalog: {
				epic: listed(),
				steam: listed(game("s1", 5), game("s2", 50), game("s3", 0), game("s4", 20), game("s5", 10))
			}
		});
		await useCase.execute();
		await useCase.execute();
		assert.deepStrictEqual(contentFor(sent, "a@g.us").slice(1), [
			`🎮 *Jogos novos liberados na Steam!*\n\n${entry("s1")}\n\n${entry("s3")}`
		]);
		assert.ok(world.catalog.steam.ok);
	});

	await test("use case: same list twice notifies only once", async () => {
		const { sent, useCase } = buildScenario({
			groups: [group("a@g.us", { notificarEpic: true })],
			catalog: { epic: listed(game("e1"), game("e2")), steam: listed() }
		});
		await useCase.execute();
		await useCase.execute();
		assert.strictEqual(sent.length, 1);
	});

	await test("use case: new week announces only the new game and keeps the repeated one in the DB", async () => {
		const { world, sent, repository, useCase } = buildScenario({
			groups: [group("a@g.us", { notificarEpic: true })],
			catalog: { epic: listed(game("e1"), game("e2")), steam: listed() }
		});
		await useCase.execute();
		world.catalog.epic = listed(game("e2"), game("e3"));
		await useCase.execute();
		assert.deepStrictEqual(
			contentFor(sent, "a@g.us")[1],
			`🎮 *Jogos novos liberados na Epic!*\n\n${entry("e3")}`
		);
		assert.deepStrictEqual([...(await repository.getGameIds("epic"))].sort(), ["e2", "e3"]);
	});

	await test("use case: a game that lasts two weeks is not renotified and leaves the DB when it ends", async () => {
		const { world, sent, repository, useCase } = buildScenario({
			groups: [group("a@g.us", { notificarSteam: true })],
			catalog: { epic: listed(), steam: listed(game("s1", 5)) }
		});
		await useCase.execute();
		await useCase.execute();
		assert.strictEqual(sent.length, 1);
		assert.deepStrictEqual([...(await repository.getGameIds("steam"))], ["s1"]);
		world.catalog.steam = listed();
		await useCase.execute();
		assert.deepStrictEqual([...(await repository.getGameIds("steam"))], []);
	});

	await test("use case: failed Steam API keeps the Steam DB intact and still notifies Epic", async () => {
		const { world, sent, repository, useCase } = buildScenario({
			groups: [group("a@g.us", { notificarEpic: true, notificarSteam: true })],
			catalog: { epic: listed(game("e1")), steam: listed(game("s1", 5)) }
		});
		await useCase.execute();
		world.catalog = { epic: listed(game("e1"), game("e2")), steam: FAILED };
		await useCase.execute();
		assert.deepStrictEqual(
			contentFor(sent, "a@g.us")[1],
			`🎮 *Jogos novos liberados na Epic!*\n\n${entry("e2")}`
		);
		assert.deepStrictEqual([...(await repository.getGameIds("steam"))], ["s1"]);
		world.catalog = {
			epic: listed(game("e1"), game("e2")),
			steam: listed(game("s1", 5), game("s2", 1))
		};
		await useCase.execute();
		assert.deepStrictEqual(
			contentFor(sent, "a@g.us")[2],
			`🎮 *Jogos novos liberados na Steam!*\n\n${entry("s2")}`
		);
	});

	await test("use case: group with both stores gets the Epic-only message when Steam has nothing new", async () => {
		const { world, sent, useCase } = buildScenario({
			groups: [group("a@g.us", { notificarEpic: true, notificarSteam: true })],
			catalog: { epic: listed(game("e1")), steam: listed(game("s1")) }
		});
		await useCase.execute();
		world.catalog = { epic: listed(game("e1"), game("e2")), steam: listed(game("s1")) };
		await useCase.execute();
		assert.deepStrictEqual(
			contentFor(sent, "a@g.us")[1],
			`🎮 *Jogos novos liberados na Epic!*\n\n${entry("e2")}`
		);
	});

	await test("use case: a send failure in one group does not stop the others nor the DB update", async () => {
		const { sent, repository, useCase } = buildScenario({
			groups: [
				group("broken@g.us", { notificarEpic: true }),
				group("ok@g.us", { notificarEpic: true })
			],
			catalog: { epic: listed(game("e1")), steam: listed() },
			failingGroups: ["broken@g.us"]
		});
		const summary = await useCase.execute();
		assert.deepStrictEqual(
			sent.map((m) => m.groupId),
			["ok@g.us"]
		);
		assert.deepStrictEqual(summary, { sent: 1, failed: 1 });
		assert.deepStrictEqual([...(await repository.getGameIds("epic"))], ["e1"]);
	});

	await test("use case: games are recorded even when no group has the store enabled", async () => {
		const { repository, useCase } = buildScenario({
			groups: [group("a@g.us")],
			catalog: { epic: listed(game("e1")), steam: listed(game("s1")) }
		});
		await useCase.execute();
		assert.deepStrictEqual([...(await repository.getGameIds("steam"))], ["s1"]);
	});

	// S4. Contrato do repositório de jogos da semana (em memória e SQLite)
	const repositories = {
		"in-memory": () => new InMemoryWeeklyGamesRepository(),
		sqlite: () => new SqliteWeeklyGamesRepository({ database: createSqliteDatabaseFake() })
	};

	for (const [kind, createRepository] of Object.entries(repositories)) {
		await test(`repository (${kind}): starts empty and returns the ids that were saved`, async () => {
			const repository = createRepository();
			assert.deepStrictEqual([...(await repository.getGameIds("steam"))], []);
			await repository.replaceStoreGames("steam", [game("a"), game("b")]);
			assert.deepStrictEqual([...(await repository.getGameIds("steam"))].sort(), ["a", "b"]);
		});

		await test(`repository (${kind}): replacing a store drops old games and keeps other stores`, async () => {
			const repository = createRepository();
			await repository.replaceStoreGames("epic", [game("e1")]);
			await repository.replaceStoreGames("steam", [game("a"), game("b")]);
			await repository.replaceStoreGames("steam", [game("b"), game("c")]);
			assert.deepStrictEqual([...(await repository.getGameIds("steam"))].sort(), ["b", "c"]);
			assert.deepStrictEqual([...(await repository.getGameIds("epic"))], ["e1"]);
		});

		await test(`repository (${kind}): replacing with an empty list clears the store`, async () => {
			const repository = createRepository();
			await repository.replaceStoreGames("steam", [game("a")]);
			await repository.replaceStoreGames("steam", []);
			assert.deepStrictEqual([...(await repository.getGameIds("steam"))], []);
		});
	}

	// S5. Config por grupo
	await test("toggle: flips the store flag, saves the group and tells the new state", async () => {
		const savedGroups = [];
		const steamGroup = { id: "a@g.us", notificarSteam: false };
		const saveGroup = async (saved) => savedGroups.push({ ...saved });

		const enabledText = await toggleFreeGamesFlag({
			group: steamGroup,
			store: STEAM_STORE,
			saveGroup
		});
		assert.strictEqual(steamGroup.notificarSteam, true);
		assert.ok(enabledText.includes("*jogos grátis da Steam*") && enabledText.includes("*ativado*"));

		const disabledText = await toggleFreeGamesFlag({
			group: steamGroup,
			store: STEAM_STORE,
			saveGroup
		});
		assert.strictEqual(steamGroup.notificarSteam, false);
		assert.ok(disabledText.includes("*desativado*"));
		assert.strictEqual(savedGroups.length, 2);
	});

	await test("group: notificarSteam defaults to false, updates and survives the mapper round-trip", () => {
		const newGroup = new Group({ id: "a@g.us" });
		assert.strictEqual(newGroup.notificarSteam, false);
		newGroup.update({ notificarSteam: true });
		assert.strictEqual(newGroup.toJSON().notificarSteam, true);
		const row = GroupMapper.toRow(newGroup.toJSON());
		assert.strictEqual(row.notificar_steam, 1);
		assert.strictEqual(GroupMapper.fromRow(row).notificarSteam, true);
	});

	// Entrega pelos bots (herdado do aviso da Epic)
	await test("notifier: skips incompatible and skipped bots", async () => {
		const telegramBot = fakeBot({ id: "tg", telegram: true });
		const skippedBot = fakeBot({ id: "skipped", skip: ["a@g.us"] });
		const goodBot = fakeBot({ id: "good" });
		const notifier = new BotGroupNotifier({ getBots: () => [telegramBot, skippedBot, goodBot] });
		assert.strictEqual(await notifier.notify("a@g.us", "oi"), true);
		assert.strictEqual(telegramBot.sent.length, 0);
		assert.strictEqual(skippedBot.sent.length, 0);
		assert.strictEqual(goodBot.sent.length, 1);
	});

	await test("notifier: falls back to the next bot when the first is not in the group", async () => {
		const notInGroup = fakeBot({
			id: "first",
			results: [{ error: { message: "not participating in group" } }]
		});
		const second = fakeBot({ id: "second" });
		const notifier = new BotGroupNotifier({ getBots: () => [notInGroup, second] });
		assert.strictEqual(await notifier.notify("a@g.us", "oi"), true);
		assert.deepStrictEqual(notInGroup.marked, ["a@g.us"]);
		assert.strictEqual(second.sent.length, 1);
	});

	await test("notifier: returns false when no bot can deliver", async () => {
		const notifier = new BotGroupNotifier({ getBots: () => [] });
		assert.strictEqual(await notifier.notify("a@g.us", "oi"), false);
	});

	console.log("--- ALL jogos grátis TESTS PASSED ---");
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
