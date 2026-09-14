const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Group = require("../models/Group");

async function runTests() {
	console.log("--- Starting spammer greetings suppression tests ---");

	process.env.GRUPO_INTERACAO = "120363023705826791@g.us";
	process.env.GRUPO_PESCA = "120363419710757620@g.us";
	process.env.GRUPO_DOWNLOADS = "120363403509525636@g.us";
	process.env.GRUPO_STICKERS = "120363411693189058@g.us";

	const eventHandler = new EventHandler();
	await eventHandler.loadGroups();

	const bot = new FakeBot({ id: "teste", grupoLogs: "logs@g.us" });

	// 1. Test getFixedSpamGroups and isFixedSpamGroup
	const fixedGroups = eventHandler.getFixedSpamGroups();
	assert(
		fixedGroups.includes("120363411693189058@g.us"),
		"GRUPO_STICKERS must be in fixedSpamGroups"
	);
	assert(
		fixedGroups.includes("120363023705826791@g.us"),
		"GRUPO_INTERACAO must be in fixedSpamGroups"
	);
	assert(fixedGroups.includes("120363419710757620@g.us"), "GRUPO_PESCA must be in fixedSpamGroups");
	assert(
		fixedGroups.includes("120363403509525636@g.us"),
		"GRUPO_DOWNLOADS must be in fixedSpamGroups"
	);
	assert.strictEqual(eventHandler.isFixedSpamGroup("120363411693189058@g.us"), true);
	assert.strictEqual(eventHandler.isFixedSpamGroup("outro_grupo@g.us"), false);
	console.log("✓ getFixedSpamGroups and isFixedSpamGroup tests passed");

	// 2. Test isSpammerPrefix
	assert.strictEqual(
		eventHandler.isSpammerPrefix("62812345678"),
		true,
		"DDI 62 should be detected"
	);
	assert.strictEqual(
		eventHandler.isSpammerPrefix("63912345678"),
		true,
		"DDI 63 should be detected"
	);
	assert.strictEqual(
		eventHandler.isSpammerPrefix("+62 812-345-678"),
		true,
		"DDI 62 with symbols should be detected"
	);
	assert.strictEqual(
		eventHandler.isSpammerPrefix("5511999999999"),
		false,
		"DDI 55 should not be detected"
	);
	assert.strictEqual(
		eventHandler.isSpammerPrefix("15551234567"),
		false,
		"DDI 1 should not be detected"
	);
	console.log("✓ isSpammerPrefix tests passed");

	// 3. Configure test group with greetings and farewells
	const stickerGroupId = "120363411693189058@g.us";
	const testGroup = new Group({
		id: stickerGroupId,
		name: "Grupo Stickers",
		prefix: "!",
		greetings: {
			text: "Bem-vindo {pessoa} ao grupo de stickers!"
		},
		farewells: {
			text: "Adeus {pessoa}!"
		}
	});

	eventHandler.groups[stickerGroupId] = testGroup;

	const origGetOrCreateGroup = eventHandler.getOrCreateGroup.bind(eventHandler);
	eventHandler.getOrCreateGroup = async (groupId, ...args) => {
		if (groupId === stickerGroupId) {
			return { group: testGroup, newGroup: false };
		}
		return origGetOrCreateGroup(groupId, ...args);
	};

	const origGetGroup = eventHandler.database.getGroup.bind(eventHandler.database);
	eventHandler.database.getGroup = async (groupId) => {
		if (groupId === stickerGroupId) return testGroup;
		return origGetGroup(groupId);
	};

	// 4. Test Spammer (DDI 62) joins fixed group
	bot.resetCapture();
	bot.removedParticipants = [];

	const spammerJoinData = {
		group: { id: stickerGroupId, name: "Grupo Stickers" },
		user: { id: "6281234567890@s.whatsapp.net", name: "Spammer 62" },
		responsavel: { id: "responsavel@s.whatsapp.net", name: "Admin" },
		origin: {
			getChat: async () => ({
				id: { _serialized: stickerGroupId },
				name: "Grupo Stickers",
				participants: [
					{
						id: { _serialized: "6281234567890@s.whatsapp.net" },
						phoneNumber: "6281234567890"
					}
				]
			})
		}
	};

	await eventHandler.processGroupJoin(bot, spammerJoinData);

	// Spammer should be removed
	assert(bot.removedParticipants.length >= 1, "Spammer must be removed from group");
	assert(
		bot.removedParticipants.some((r) =>
			Array.isArray(r.participants)
				? r.participants.includes("6281234567890@s.whatsapp.net")
				: r.participants === "6281234567890@s.whatsapp.net"
		),
		"Removed participants must contain spammer JID"
	);

	// Greetings MUST NOT be sent
	const welcomeMsgs = bot.capturedMessages.filter(
		(m) => m.content && m.content.includes("Bem-vindo")
	);
	assert.strictEqual(welcomeMsgs.length, 0, "No welcome message should be sent to spammer");
	console.log("✓ Spammer join: removed and welcome message suppressed");

	// 5. Test Spammer leave event (after being removed)
	bot.resetCapture();
	const spammerLeaveData = {
		group: { id: stickerGroupId, name: "Grupo Stickers" },
		user: { id: "6281234567890@s.whatsapp.net", name: "Spammer 62" },
		responsavel: { id: bot.id, name: bot.id }
	};

	await eventHandler.processGroupLeave(bot, spammerLeaveData);

	// Standard farewells MUST NOT be sent
	const farewellMsgs = bot.capturedMessages.filter((m) => m.content && m.content.includes("Adeus"));
	assert.strictEqual(
		farewellMsgs.length,
		0,
		"Standard farewell message should not be sent to spammer"
	);

	// Customized spammer leave notice MUST be sent
	const spammerNotices = bot.capturedMessages.filter(
		(m) => m.content && m.content.includes("🚫 Spammer @6281234567890 detectado removido do grupo")
	);
	assert.strictEqual(
		spammerNotices.length,
		1,
		"Customized spammer leave notice should be sent to group"
	);
	assert(
		spammerNotices[0].content.includes("!g-permitirSpammer 6281234567890"),
		"Notice should instruct how to whitelist with !g-permitirSpammer"
	);
	console.log("✓ Spammer leave: standard farewell suppressed and custom notice sent");

	// 5b. Test deduplication within 30s
	bot.resetCapture();
	await eventHandler.processGroupLeave(bot, spammerLeaveData);
	assert.strictEqual(
		bot.capturedMessages.length,
		0,
		"Duplicate spammer notice should be suppressed within 30s"
	);
	console.log("✓ Spammer leave: duplicate notice within 30s suppressed");

	// 6. Test Normal User joins the fixed group
	bot.resetCapture();
	bot.removedParticipants = [];

	const normalUserJoinData = {
		group: { id: stickerGroupId, name: "Grupo Stickers" },
		user: { id: "5511999999999@s.whatsapp.net", name: "Usuario Normal" },
		responsavel: { id: "responsavel@s.whatsapp.net", name: "Admin" },
		origin: {
			getChat: async () => ({
				id: { _serialized: stickerGroupId },
				name: "Grupo Stickers",
				participants: [
					{
						id: { _serialized: "5511999999999@s.whatsapp.net" },
						phoneNumber: "5511999999999"
					}
				]
			})
		}
	};

	await eventHandler.processGroupJoin(bot, normalUserJoinData);

	// Normal user should NOT be removed
	assert.strictEqual(bot.removedParticipants.length, 0, "Normal user should not be removed");

	// Greetings MUST be sent for normal user
	const normalWelcomeMsgs = bot.capturedMessages.filter(
		(m) => m.content && m.content.includes("Bem-vindo")
	);
	assert.strictEqual(normalWelcomeMsgs.length, 1, "Welcome message should be sent to normal user");
	console.log("✓ Normal user join: welcome message sent correctly");

	// 7. Test Normal User leave event
	bot.resetCapture();
	const normalUserLeaveData = {
		group: { id: stickerGroupId, name: "Grupo Stickers" },
		user: { id: "5511999999999@s.whatsapp.net", name: "Usuario Normal" },
		responsavel: { id: "responsavel@s.whatsapp.net", name: "Admin" }
	};

	await eventHandler.processGroupLeave(bot, normalUserLeaveData);

	// Farewells MUST be sent for normal user
	const normalFarewellMsgs = bot.capturedMessages.filter(
		(m) => m.content && m.content.includes("Adeus")
	);
	assert.strictEqual(
		normalFarewellMsgs.length,
		1,
		"Farewell message should be sent to normal user"
	);
	console.log("✓ Normal user leave: farewell message sent correctly");

	// 8. Test Spammer detected during checkAutoBanSpammers
	bot.resetCapture();
	bot.removedParticipants = [];

	const chatWithSpammer = {
		id: { _serialized: stickerGroupId },
		Participants: [
			{
				id: { _serialized: "6289999999999@s.whatsapp.net" },
				phoneNumber: "6289999999999"
			},
			{
				id: { _serialized: "5511888888888@s.whatsapp.net" },
				phoneNumber: "5511888888888"
			}
		]
	};

	const banned = await eventHandler.checkAutoBanSpammers(bot, chatWithSpammer);
	assert.strictEqual(banned.length, 1);
	assert.strictEqual(banned[0], "6289999999999@s.whatsapp.net");
	assert(eventHandler.activeSpammers.has("6289999999999@s.whatsapp.net"));
	console.log("✓ checkAutoBanSpammers: detected, removed, and registered in activeSpammers");

	// 9. Test toggleBanirSpammers management command
	const customGroupId = "120363999999999999@g.us";
	const customGroup = new Group({
		id: customGroupId,
		name: "Grupo Normal",
		prefix: "!",
		banirSpammers: false,
		greetings: { text: "Olá {pessoa}!" }
	});
	eventHandler.groups[customGroupId] = customGroup;

	assert.strictEqual(
		eventHandler.isSpamMonitoredGroup(customGroupId, customGroup),
		false,
		"Custom group should not be monitored initially"
	);

	const management = eventHandler.commandHandler.management;
	const toggleRes1 = await management.toggleBanirSpammers(
		bot,
		{ author: "admin@s.whatsapp.net" },
		[],
		customGroup
	);
	assert.strictEqual(
		customGroup.banirSpammers,
		true,
		"Group banirSpammers should be true after toggle"
	);
	assert(toggleRes1.content.includes("ativado"), "Response should indicate activated");
	assert.strictEqual(
		eventHandler.isSpamMonitoredGroup(customGroupId, customGroup),
		true,
		"Custom group should now be monitored"
	);

	// Spammer joining custom monitored group should be kicked
	bot.resetCapture();
	bot.removedParticipants = [];
	const customSpammerJoin = {
		group: { id: customGroupId, name: "Grupo Normal" },
		user: { id: "6287777777777@s.whatsapp.net", name: "Spammer 62 Custom" },
		responsavel: { id: "responsavel@s.whatsapp.net", name: "Admin" },
		origin: {
			getChat: async () => ({
				id: { _serialized: customGroupId },
				name: "Grupo Normal",
				participants: [
					{ id: { _serialized: "6287777777777@s.whatsapp.net" }, phoneNumber: "6287777777777" }
				]
			})
		}
	};
	await eventHandler.processGroupJoin(bot, customSpammerJoin);
	assert(
		bot.removedParticipants.length >= 1,
		"Spammer must be removed from custom monitored group"
	);
	console.log("✓ toggleBanirSpammers: activates monitoring and bans spammers");

	// 10. Test togglePermitirSpammer management command
	const whitelistSpammer = "6287777777777";
	const allowRes1 = await management.togglePermitirSpammer(
		bot,
		{ author: "admin@s.whatsapp.net" },
		[whitelistSpammer],
		customGroup
	);
	assert(customGroup.spammerWhitelist.includes(whitelistSpammer), "Spammer must be in whitelist");
	assert(allowRes1.content.includes("adicionado"), "Response should confirm addition to whitelist");
	assert.strictEqual(
		eventHandler.isSpammerWhitelisted(
			customGroup,
			"6287777777777@s.whatsapp.net",
			whitelistSpammer
		),
		true,
		"isSpammerWhitelisted should return true"
	);

	// Spammer should NOT be kicked now because they are whitelisted
	bot.resetCapture();
	bot.removedParticipants = [];
	await eventHandler.processGroupJoin(bot, customSpammerJoin);
	assert.strictEqual(bot.removedParticipants.length, 0, "Whitelisted spammer must not be removed");
	const welcomeAllowed = bot.capturedMessages.filter((m) => m.content && m.content.includes("Olá"));
	assert.strictEqual(welcomeAllowed.length, 1, "Whitelisted user receives greeting");
	console.log("✓ togglePermitirSpammer: adds to whitelist and allows joining with greeting");

	// Remove from whitelist
	const allowRes2 = await management.togglePermitirSpammer(
		bot,
		{ author: "admin@s.whatsapp.net" },
		[whitelistSpammer],
		customGroup
	);
	assert(
		!customGroup.spammerWhitelist.includes(whitelistSpammer),
		"Spammer must be removed from whitelist"
	);
	assert(allowRes2.content.includes("removido"), "Response should confirm removal from whitelist");
	console.log("✓ togglePermitirSpammer: toggles off and removes from whitelist");

	console.log("--- All spammer greetings suppression tests passed successfully! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed with error:", err);
	process.exit(1);
});
