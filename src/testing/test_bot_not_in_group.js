const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const ReturnMessage = require("../models/ReturnMessage");
const WhatsAppBotGo = require("../WhatsAppBotGo");

async function runTests() {
	console.log("--- Starting bot_not_in_group tests ---");

	const groupId = "558191735552-1607290088@g.us";
	const bot = new FakeBot({
		id: "rav-enculinha",
		grupoLogs: "logs@g.us"
	});
	const eventHandler = new EventHandler();
	bot.eventHandler = eventHandler;

	// 1. Initial state: bot should be participating
	assert.strictEqual(bot.isParticipating(groupId), true, "Bot should participate initially");
	assert.strictEqual(bot.isInGroup(groupId), true, "isInGroup should match isParticipating");

	// 2. Mark bot not in group
	await bot.markNotInGroup(groupId);
	assert.strictEqual(
		bot.isParticipating(groupId),
		false,
		"Bot should NOT participate after markNotInGroup"
	);
	assert.strictEqual(bot.isInGroup(groupId), false, "isInGroup should be false");
	assert.strictEqual(
		bot.skipGroupInfo.includes(groupId),
		true,
		"groupId should be in skipGroupInfo"
	);

	// 3. getChatDetails should return notInGroup: true, isParticipating: false
	const chatDetails = await bot.getChatDetails(groupId);
	assert.strictEqual(chatDetails.notInGroup, true, "getChatDetails should report notInGroup: true");
	assert.strictEqual(
		chatDetails.isParticipating,
		false,
		"getChatDetails should report isParticipating: false"
	);

	// 4. sendReturnMessages should skip and return notInGroup: true
	bot.resetCapture();
	const returnMsg = new ReturnMessage({ chatId: groupId, content: "Mensagem de teste" });
	const sendResults = await bot.sendReturnMessages(returnMsg);
	assert.strictEqual(sendResults.length, 1, "Should have 1 result");
	assert.strictEqual(sendResults[0].notInGroup, true, "Result should have notInGroup: true");
	assert.strictEqual(sendResults[0].skipped, true, "Result should have skipped: true");
	assert.strictEqual(
		bot.capturedMessages.length,
		0,
		"No message should have been captured (sending skipped)"
	);

	// 5. sendMessage should throw with notInGroup: true
	let threw = false;
	try {
		await bot.sendMessage(groupId, "Mensagem direta");
	} catch (err) {
		threw = true;
		assert.strictEqual(err.notInGroup, true, "Thrown error should have notInGroup: true");
	}
	assert.strictEqual(threw, true, "sendMessage should throw when bot is not participating");

	// 6. Bot receives a message from the group -> should automatically re-enable participation
	const incomingMsg = createMessage({
		content: "Olá bot!",
		group: groupId,
		author: "558199999999@s.whatsapp.net"
	});

	await eventHandler.processMessage(bot, incomingMsg);

	assert.strictEqual(
		bot.isParticipating(groupId),
		true,
		"Bot should participate again after receiving message"
	);
	assert.strictEqual(
		bot.skipGroupInfo.includes(groupId),
		false,
		"groupId should be removed from skipGroupInfo"
	);

	// 7. After unflagging, sendReturnMessages and sendMessage should succeed
	bot.resetCapture();
	const newSendResults = await bot.sendReturnMessages(returnMsg);
	assert.strictEqual(newSendResults.length, 1);
	assert.strictEqual(newSendResults[0].notInGroup, undefined, "Result should not have notInGroup");
	assert.strictEqual(
		bot.capturedMessages.length,
		1,
		"Message should have been captured successfully"
	);

	// 8. Test WhatsAppBotGo error matching logic
	const sample500Error = {
		status: 500,
		message: "Request failed with status code 500",
		data: {
			error: "failed to get group members: you're not participating in that group"
		}
	};

	const goBot = new WhatsAppBotGo({
		id: "rav-enculinha",
		whatsgoApiUrl: "http://localhost:8080",
		whatsgoApiKey: "test-key",
		instanceName: "rav-enculinha",
		webhookHost: "localhost",
		grupoLogs: "logs@g.us"
	});

	// Check goBot methods exist
	assert.strictEqual(typeof goBot.isParticipating, "function");
	assert.strictEqual(typeof goBot.isInGroup, "function");
	assert.strictEqual(typeof goBot.markNotInGroup, "function");
	assert.strictEqual(typeof goBot.markInGroup, "function");

	console.log("✓ All bot_not_in_group tests passed successfully!");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
