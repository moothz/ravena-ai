const assert = require("assert");
const EpicFreeGamesSource = require("../services/epicFreeGames/EpicFreeGamesSource");
const { cleanEpicTitle } = EpicFreeGamesSource;
const {
	formatEpicFreeGamesMessage
} = require("../services/epicFreeGames/formatEpicFreeGamesMessage");
const NotifyEpicFreeGames = require("../services/epicFreeGames/NotifyEpicFreeGames");
const BotGroupNotifier = require("../services/epicFreeGames/BotGroupNotifier");
const Group = require("../models/Group");
const GroupMapper = require("../utils/db/mappers/GroupMapper");

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

const EXPECTED_MESSAGE = [
	"🎮 *Jogos novos liberados na Epic!*",
	"",
	"*Out of Sight*",
	"🔗 https://www.gamerpower.com/open/out-of-sight-epic-games-giveaway",
	"",
	"*TerraScape*",
	"🔗 https://www.gamerpower.com/open/terrascape-epic-games-giveaway"
].join("\n");

const SAMPLE_GAMES = [
	{
		title: "Out of Sight",
		url: "https://www.gamerpower.com/open/out-of-sight-epic-games-giveaway"
	},
	{
		title: "TerraScape",
		url: "https://www.gamerpower.com/open/terrascape-epic-games-giveaway"
	}
];

const test = async (name, fn) => {
	await fn();
	console.log(`✓ ${name}`);
};

function fakeBot({ id, results = [{}], telegram = false, skip = [] }) {
	return {
		id,
		useTelegram: telegram,
		skipGroupInfo: skip,
		sent: [],
		marked: [],
		async sendReturnMessages(msg) {
			this.sent.push(msg);
			return results;
		},
		async markNotInGroup(groupId) {
			this.marked.push(groupId);
		}
	};
}

async function runTests() {
	console.log("--- Starting notificar-epic tests ---");

	await test("cleanEpicTitle removes store name and Giveaway suffix", () => {
		assert.strictEqual(cleanEpicTitle("Out of Sight (Epic Games) Giveaway"), "Out of Sight");
		assert.strictEqual(cleanEpicTitle("TerraScape (Epic Games) Giveaway"), "TerraScape");
		assert.strictEqual(cleanEpicTitle("Plain Title"), "Plain Title");
	});

	await test("formatEpicFreeGamesMessage matches the clean layout exactly", () => {
		assert.strictEqual(formatEpicFreeGamesMessage(SAMPLE_GAMES), EXPECTED_MESSAGE);
	});

	await test("formatEpicFreeGamesMessage returns null for empty list and has no spam", () => {
		assert.strictEqual(formatEpicFreeGamesMessage([]), null);
		const text = formatEpicFreeGamesMessage(SAMPLE_GAMES);
		["Epic Games Store", "💻", "DLC", "ECONOMIA"].forEach((spam) =>
			assert.ok(!text.includes(spam), `must not contain ${spam}`)
		);
	});

	await test("EpicFreeGamesSource maps giveaways and filters epic games only", async () => {
		let captured;
		const httpClient = {
			get: async (url, config) => {
				captured = config.params;
				return {
					data: [
						{
							title: "Out of Sight (Epic Games) Giveaway",
							open_giveaway_url: SAMPLE_GAMES[0].url
						},
						{ title: "Sem link" }
					]
				};
			}
		};
		const source = new EpicFreeGamesSource({ httpClient, logger: silentLogger });
		const games = await source.fetchCurrentGames();
		assert.strictEqual(captured.platform, "epic-games-store");
		assert.strictEqual(captured.type, "game");
		assert.deepStrictEqual(games, [SAMPLE_GAMES[0]]);
	});

	await test("EpicFreeGamesSource returns empty list on request error", async () => {
		const httpClient = {
			get: async () => {
				throw new Error("boom");
			}
		};
		const source = new EpicFreeGamesSource({ httpClient, logger: silentLogger });
		assert.deepStrictEqual(await source.fetchCurrentGames(), []);
	});

	await test("NotifyEpicFreeGames notifies only enabled, non-paused groups with a single fetch", async () => {
		let fetchCount = 0;
		const notified = [];
		const useCase = new NotifyEpicFreeGames({
			source: {
				fetchCurrentGames: async () => {
					fetchCount++;
					return SAMPLE_GAMES;
				}
			},
			groupRepository: {
				getGroups: async () => [
					{ id: "a@g.us", notificarEpic: true, paused: false },
					{ id: "b@g.us", notificarEpic: false, paused: false },
					{ id: "c@g.us", notificarEpic: true, paused: true },
					{ id: "d@g.us", notificarEpic: true, paused: false }
				]
			},
			notifier: {
				notify: async (groupId, content) => {
					notified.push({ groupId, content });
					return true;
				}
			},
			logger: silentLogger
		});
		const summary = await useCase.execute();
		assert.deepStrictEqual(
			notified.map((n) => n.groupId),
			["a@g.us", "d@g.us"]
		);
		assert.strictEqual(notified[0].content, EXPECTED_MESSAGE);
		assert.strictEqual(fetchCount, 1);
		assert.deepStrictEqual(summary, { sent: 2, failed: 0 });
	});

	await test("NotifyEpicFreeGames sends nothing when there are no games", async () => {
		let notifyCalls = 0;
		const useCase = new NotifyEpicFreeGames({
			source: { fetchCurrentGames: async () => [] },
			groupRepository: { getGroups: async () => [{ id: "a@g.us", notificarEpic: true }] },
			notifier: {
				notify: async () => {
					notifyCalls++;
					return true;
				}
			},
			logger: silentLogger
		});
		await useCase.execute();
		assert.strictEqual(notifyCalls, 0);
	});

	await test("NotifyEpicFreeGames keeps going when one group fails", async () => {
		const useCase = new NotifyEpicFreeGames({
			source: { fetchCurrentGames: async () => SAMPLE_GAMES },
			groupRepository: {
				getGroups: async () => [
					{ id: "a@g.us", notificarEpic: true },
					{ id: "b@g.us", notificarEpic: true }
				]
			},
			notifier: {
				notify: async (groupId) => {
					if (groupId === "a@g.us") throw new Error("falhou");
					return true;
				}
			},
			logger: silentLogger
		});
		assert.deepStrictEqual(await useCase.execute(), { sent: 1, failed: 1 });
	});

	await test("BotGroupNotifier skips incompatible and skipped bots", async () => {
		const telegramBot = fakeBot({ id: "tg", telegram: true });
		const skippedBot = fakeBot({ id: "skipped", skip: ["a@g.us"] });
		const goodBot = fakeBot({ id: "good" });
		const notifier = new BotGroupNotifier({ getBots: () => [telegramBot, skippedBot, goodBot] });
		assert.strictEqual(await notifier.notify("a@g.us", "oi"), true);
		assert.strictEqual(telegramBot.sent.length, 0);
		assert.strictEqual(skippedBot.sent.length, 0);
		assert.strictEqual(goodBot.sent.length, 1);
	});

	await test("BotGroupNotifier falls back to next bot when first is not in group", async () => {
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

	await test("BotGroupNotifier returns false when no bot can deliver", async () => {
		const notifier = new BotGroupNotifier({ getBots: () => [] });
		assert.strictEqual(await notifier.notify("a@g.us", "oi"), false);
	});

	await test("Group defaults notificarEpic to false and round-trips through mapper", () => {
		const group = new Group({ id: "a@g.us" });
		assert.strictEqual(group.notificarEpic, false);
		group.update({ notificarEpic: true });
		assert.strictEqual(group.notificarEpic, true);
		assert.strictEqual(group.toJSON().notificarEpic, true);
		const row = GroupMapper.toRow(group.toJSON());
		assert.strictEqual(row.notificar_epic, 1);
		assert.strictEqual(GroupMapper.fromRow(row).notificarEpic, true);
	});

	console.log("--- ALL notificar-epic TESTS PASSED ---");
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
