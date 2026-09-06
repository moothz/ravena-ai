const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("--- Starting dossieGroups tests ---");

	// 1. Test FakeBot dossieGroups fallback & isDossieGroup
	const botWithFallback = new FakeBot({ grupoLogs: "123456@g.us" });
	assert.strictEqual(botWithFallback.dossieGroups, "123456@g.us", "Fallback to grupoLogs should work");
	assert.strictEqual(botWithFallback.isDossieGroup("123456@g.us"), true, "Should match exact JID");
	assert.strictEqual(botWithFallback.isDossieGroup("123456"), true, "Should match without @g.us");
	assert.strictEqual(botWithFallback.isDossieGroup("999999@g.us"), false, "Should not match different group");

	const botWithCustomDossie = new FakeBot({
		grupoLogs: "123456@g.us",
		dossieGroups: "789012@g.us"
	});
	assert.strictEqual(botWithCustomDossie.dossieGroups, "789012@g.us", "Explicit dossieGroups should take precedence");
	assert.strictEqual(botWithCustomDossie.isDossieGroup("789012@g.us"), true);
	assert.strictEqual(botWithCustomDossie.isDossieGroup("123456@g.us"), false);

	// Test array of dossieGroups
	const botWithArray = new FakeBot({
		dossieGroups: ["111111@g.us", "222222@g.us"]
	});
	assert.strictEqual(botWithArray.isDossieGroup("111111@g.us"), true);
	assert.strictEqual(botWithArray.isDossieGroup("222222"), true);
	assert.strictEqual(botWithArray.isDossieGroup("333333@g.us"), false);
	console.log("✓ FakeBot and isDossieGroup logic passed");

	// 2. Test WhatsAppBotGo class
	const WhatsAppBotGo = require("../WhatsAppBotGo");
	const goBot = new WhatsAppBotGo({
		id: "test-go",
		whatsgoApiUrl: "http://localhost:8080",
		whatsgoApiKey: "test-key",
		instanceName: "test-go",
		webhookHost: "localhost",
		grupoLogs: "120363404892583431@g.us",
		dossieGroups: "120363999999999999@g.us"
	});
	assert.strictEqual(goBot.dossieGroups, "120363999999999999@g.us");
	assert.strictEqual(goBot.isDossieGroup("120363999999999999@g.us"), true);
	assert.strictEqual(goBot.isDossieGroup("120363999999999999"), true);
	assert.strictEqual(goBot.isDossieGroup("120363404892583431@g.us"), false);

	const goBotFallback = new WhatsAppBotGo({
		id: "test-go-fallback",
		whatsgoApiUrl: "http://localhost:8080",
		whatsgoApiKey: "test-key",
		instanceName: "test-go-fallback",
		webhookHost: "localhost",
		grupoLogs: "120363404892583431@g.us"
	});
	assert.strictEqual(goBotFallback.dossieGroups, "120363404892583431@g.us");
	assert.strictEqual(goBotFallback.isDossieGroup("120363404892583431@g.us"), true);
	console.log("✓ WhatsAppBotGo dossieGroups and fallback passed");

	// 3. Test TelegramBot class
	const TelegramBot = require("../TelegramBot");
	const tgBot = new TelegramBot({
		id: "test-tg",
		telegramBotToken: "test-token",
		grupoLogs: "-1001234567890",
		dossieGroups: "-1009876543210"
	});
	assert.strictEqual(tgBot.isDossieGroup("-1009876543210"), true);
	assert.strictEqual(tgBot.isDossieGroup("-1001234567890"), false);
	console.log("✓ TelegramBot dossieGroups passed");

	// 4. Test DiscordBot class
	const DiscordBot = require("../DiscordBot");
	const dcBot = new DiscordBot({
		id: "test-dc",
		discordToken: "test-token",
		grupoLogs: "108495949432664064",
		dossieGroups: "208495949432664064"
	});
	assert.strictEqual(dcBot.isDossieGroup("208495949432664064"), true);
	assert.strictEqual(dcBot.isDossieGroup("108495949432664064"), false);
	console.log("✓ DiscordBot dossieGroups passed");

	// 5. Test EventHandler ignoring commands in dossieGroups
	const eventHandler = new EventHandler();
	assert.strictEqual(eventHandler.isDossieGroup(botWithCustomDossie, "789012@g.us"), true);
	assert.strictEqual(eventHandler.isDossieGroup(botWithCustomDossie, "123456@g.us"), false);

	// Test message execution in dossieGroups vs regular group
	let commandExecuted = false;
	botWithCustomDossie.sendReturnMessages = async () => {
		commandExecuted = true;
	};

	// Message in dossie group with !ping
	const msgInDossieGroup = createMessage({
		content: "!ping",
		group: "789012@g.us",
		author: "5511999999999@s.whatsapp.net"
	});

	await eventHandler.processMessage(botWithCustomDossie, msgInDossieGroup);
	assert.strictEqual(commandExecuted, false, "Commands in dossieGroups must be ignored!");

	// Test handleCommand directly
	const cmdHandlerResult = await eventHandler.commandHandler.handleCommand(
		botWithCustomDossie,
		msgInDossieGroup,
		"ping",
		null
	);
	assert.strictEqual(cmdHandlerResult, null, "handleCommand must return null for dossieGroups");

	console.log("✓ EventHandler and CommandHandler command ignore in dossieGroups passed");
	console.log("--- ALL TESTS PASSED! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
