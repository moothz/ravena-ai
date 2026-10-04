process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");

async function main() {
	console.log("--- Testing null chat handling in processGroupJoin & checkAutoBanSpammers ---");
	const bot = new FakeBot({ id: "teste", grupoLogs: "logs@g.us" });
	const eventHandler = new EventHandler();

	// Test 1: checkAutoBanSpammers with null chat
	const res1 = await eventHandler.checkAutoBanSpammers(bot, null);
	assert.deepStrictEqual(res1, [], "checkAutoBanSpammers(bot, null) should return []");

	// Test 2: checkAutoBanSpammers with chat having no id
	const res2 = await eventHandler.checkAutoBanSpammers(bot, {});
	assert.deepStrictEqual(res2, [], "checkAutoBanSpammers(bot, {}) should return []");

	// Test 3: processGroupJoin with data.origin.getChat returning null
	const eventData = {
		group: { id: "123456789@g.us", name: "Test Group" },
		user: { id: "5511999999999@s.whatsapp.net", name: "Test User" },
		responsavel: { id: "5511888888888@s.whatsapp.net", name: "Admin User" },
		origin: {
			getChat: async () => null
		}
	};

	await eventHandler.processGroupJoin(bot, eventData);
	console.log("✓ processGroupJoin completed cleanly with null chat");

	console.log("All null-chat tests passed!");
	process.exit(0);
}

main().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
