const assert = require("assert");
const FakeBot = require("./FakeBot");
const { notifySpecialMarriage } = require("../functions/WaifuCommands");

async function runTests() {
	console.log("--- Starting Waifu Special Marriage Notification Tests ---");

	const bot = new FakeBot({
		id: "test-waifu-bot",
		grupoAvisos: "avisos@g.us",
		grupoLogs: "logs@g.us"
	});

	// 1. Test EPIC character notification
	const epicChar = {
		id: "tsunade-senju",
		name: "Tsunade Senju",
		series: "Naruto",
		rarity: "EPIC",
		imageUrl: "http://localhost:3030/images/tsunade.jpg"
	};

	const resEpic = await notifySpecialMarriage(bot, epicChar, "William~~", "19/09/2026");
	assert.ok(resEpic, "notifySpecialMarriage for EPIC should return true or succeed");
	assert.ok(bot.capturedMessages.length > 0, "Bot should capture marriage notification message");

	const epicMsg = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.strictEqual(epicMsg.chatId, "avisos@g.us", "Message should be sent to grupoAvisos");

	const captionText = epicMsg.options?.caption || epicMsg.content;
	assert.ok(captionText.includes("Tsunade Senju"), "Caption must include character name");
	assert.ok(captionText.includes("William~~"), "Caption must include player name");
	assert.ok(captionText.includes("19/09/2026"), "Caption must include date");
	assert.ok(captionText.includes("ÉPICO"), "Caption must include rarity label");

	console.log("✓ EPIC marriage notification test passed");

	// 2. Test LEGENDARY character notification
	bot.resetCapture();
	const legendaryChar = {
		id: "katsuki-bakugou",
		name: "Katsuki Bakugou",
		series: "Boku no Hero Academia",
		rarity: "LEGENDARY"
	};

	const resLeg = await notifySpecialMarriage(bot, legendaryChar, "ivri matte", "17/09/2026");
	assert.ok(resLeg, "notifySpecialMarriage for LEGENDARY should succeed");
	assert.ok(bot.capturedMessages.length > 0, "Bot should capture message");

	const legMsg = bot.capturedMessages[0];
	const legCaption = legMsg.options?.caption || legMsg.content;
	assert.ok(legCaption.includes("Katsuki Bakugou"), "Must include character name");
	assert.ok(legCaption.includes("ivri matte"), "Must include player name");
	assert.ok(legCaption.includes("LENDÁRIO"), "Must include LENDÁRIO rarity");

	console.log("✓ LEGENDARY marriage notification test passed");

	// 3. Test COMMON character (should be ignored)
	bot.resetCapture();
	const commonChar = {
		id: "common-guy",
		name: "Common Guy",
		series: "Background Series",
		rarity: "COMMON"
	};

	const resCommon = await notifySpecialMarriage(bot, commonChar, "Player1");
	assert.strictEqual(resCommon, false, "COMMON rarity should be ignored");
	assert.strictEqual(bot.capturedMessages.length, 0, "No message should be sent for COMMON rarity");

	console.log("✓ COMMON rarity ignore test passed");
	console.log("--- ALL TESTS PASSED SUCCESSFULLY! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
