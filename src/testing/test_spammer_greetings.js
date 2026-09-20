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
		eventHandler.isSpammerPrefix("380679523508"),
		true,
		"DDI 380 should be detected"
	);
	assert.strictEqual(
		eventHandler.isSpammerPrefix("+380 67 952 3508"),
		true,
		"DDI 380 with formatting should be detected"
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
	// Test that LIDs NEVER match isSpammerPrefix
	assert.strictEqual(
		eventHandler.isSpammerPrefix("628282381273812@lid"),
		false,
		"LID starting with 62 must NOT be detected as spammer prefix"
	);
	assert.strictEqual(
		eventHandler.isSpammerPrefix("638282381273812@lid"),
		false,
		"LID starting with 63 must NOT be detected as spammer prefix"
	);
	assert.strictEqual(
		eventHandler.isSpammerPrefix("380123456789012@lid"),
		false,
		"LID starting with 380 must NOT be detected as spammer prefix"
	);
	console.log("✓ isSpammerPrefix tests passed (including DDI 380 and LID protection)");

	// 2b. Test isSpammerName
	assert.strictEqual(eventHandler.isSpammerName("MI523508"), true, "MI523508 should match");
	assert.strictEqual(
		eventHandler.isSpammerName("mi523508"),
		true,
		"mi523508 lowercase should match"
	);
	assert.strictEqual(eventHandler.isSpammerName("MI123"), true, "MI123 (3 digits) should match");
	assert.strictEqual(
		eventHandler.isSpammerName("MI12345678"),
		true,
		"MI12345678 (8 digits) should match"
	);
	assert.strictEqual(eventHandler.isSpammerName("MI 523508"), true, "MI with space should match");
	assert.strictEqual(eventHandler.isSpammerName("MI12"), false, "MI12 (2 digits) should NOT match");
	assert.strictEqual(
		eventHandler.isSpammerName("MI123456789"),
		false,
		"MI + 9 digits should NOT match"
	);
	assert.strictEqual(
		eventHandler.isSpammerName("Michael"),
		false,
		"Normal name Michael should NOT match"
	);
	assert.strictEqual(
		eventHandler.isSpammerName("Usuario Normal"),
		false,
		"Normal user should NOT match"
	);
	assert.strictEqual(eventHandler.isSpammerName(""), false, "Empty name should NOT match");
	assert.strictEqual(eventHandler.isSpammerName(null), false, "Null name should NOT match");
	console.log("✓ isSpammerName tests passed");

	// 2c. Test extractPhoneNumber
	assert.strictEqual(
		eventHandler.extractPhoneNumber("628282381273812@lid"),
		null,
		"LID string must return null phone"
	);
	assert.strictEqual(
		eventHandler.extractPhoneNumber({ id: { _serialized: "628282381273812@lid" } }),
		null,
		"LID object without phone must return null"
	);
	assert.strictEqual(
		eventHandler.extractPhoneNumber({
			id: { _serialized: "628282381273812@lid" },
			number: "628282381273812"
		}),
		null,
		"LID object with matching number must return null"
	);
	assert.strictEqual(
		eventHandler.extractPhoneNumber({
			id: { _serialized: "628282381273812@lid" },
			phoneNumber: "380679523508@s.whatsapp.net"
		}),
		"380679523508",
		"LID with real phoneNumber property should extract phone"
	);
	assert.strictEqual(
		eventHandler.extractPhoneNumber("5511999999999@s.whatsapp.net"),
		"5511999999999",
		"Regular phone JID should extract digits"
	);
	assert.strictEqual(
		eventHandler.extractPhoneNumber("+380 67 952 3508"),
		"380679523508",
		"Formatted phone number should extract digits"
	);
	console.log("✓ extractPhoneNumber tests passed");

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

	// 11. Test User with LID starting with 62 (NOT A SPAMMER) joins fixed group
	bot.resetCapture();
	bot.removedParticipants = [];
	const innocentLid = "628282381273812@lid";
	const innocentLidJoin = {
		group: { id: stickerGroupId, name: "Grupo Stickers" },
		user: { id: innocentLid, name: "Inocente da Silva" },
		responsavel: { id: "responsavel@s.whatsapp.net", name: "Admin" },
		origin: {
			getChat: async () => ({
				id: { _serialized: stickerGroupId },
				name: "Grupo Stickers",
				participants: [
					{
						id: { _serialized: innocentLid },
						lid: innocentLid,
						name: "Inocente da Silva"
					}
				]
			})
		}
	};
	await eventHandler.processGroupJoin(bot, innocentLidJoin);
	assert.strictEqual(
		bot.removedParticipants.length,
		0,
		"User with LID starting with 62 must NEVER be removed"
	);
	const innocentWelcome = bot.capturedMessages.filter(
		(m) => m.content && m.content.includes("Bem-vindo")
	);
	assert.strictEqual(
		innocentWelcome.length,
		1,
		"User with LID starting with 62 must receive welcome message"
	);
	console.log("✓ User with LID starting with 62: NOT removed and receives greeting");

	// 12. Test checkAutoBanSpammers with LID starting with 62
	bot.resetCapture();
	bot.removedParticipants = [];
	const chatWithLidUser = {
		id: { _serialized: stickerGroupId },
		Participants: [
			{
				id: { _serialized: innocentLid },
				lid: innocentLid,
				name: "Inocente da Silva"
			},
			{
				id: { _serialized: "5511999999999@s.whatsapp.net" },
				phoneNumber: "5511999999999"
			}
		]
	};
	const bannedLid = await eventHandler.checkAutoBanSpammers(bot, chatWithLidUser);
	assert.strictEqual(
		bannedLid.length,
		0,
		"checkAutoBanSpammers must NOT ban user with LID starting with 62"
	);
	assert.strictEqual(
		bot.removedParticipants.length,
		0,
		"No participant should be removed when user only has LID starting with 62"
	);
	console.log("✓ checkAutoBanSpammers: LID starting with 62 is correctly ignored");

	// 13. Test DDI 380 Spammer joins fixed group and is detected in checkAutoBanSpammers
	bot.resetCapture();
	bot.removedParticipants = [];
	const ukraineSpammerJoin = {
		group: { id: stickerGroupId, name: "Grupo Stickers" },
		user: { id: "380679523508@s.whatsapp.net", name: "Spammer Ucrânia" },
		responsavel: { id: "responsavel@s.whatsapp.net", name: "Admin" },
		origin: {
			getChat: async () => ({
				id: { _serialized: stickerGroupId },
				name: "Grupo Stickers",
				participants: [
					{
						id: { _serialized: "380679523508@s.whatsapp.net" },
						phoneNumber: "380679523508"
					}
				]
			})
		}
	};
	await eventHandler.processGroupJoin(bot, ukraineSpammerJoin);
	assert(bot.removedParticipants.length >= 1, "DDI 380 spammer must be removed");
	console.log("✓ DDI 380 spammer: detected and removed on join");

	// checkAutoBanSpammers with DDI 380
	bot.resetCapture();
	bot.removedParticipants = [];
	const chatWithDdi380 = {
		id: { _serialized: stickerGroupId },
		Participants: [
			{
				id: { _serialized: "380679523508@s.whatsapp.net" },
				phoneNumber: "380679523508"
			}
		]
	};
	const bannedDdi380 = await eventHandler.checkAutoBanSpammers(bot, chatWithDdi380);
	assert.strictEqual(bannedDdi380.length, 1);
	assert.strictEqual(bannedDdi380[0], "380679523508@s.whatsapp.net");
	console.log("✓ checkAutoBanSpammers: DDI 380 detected and removed");

	// 14. Test Spammer with name matching MI### pattern (e.g. MI523508), even with LID
	bot.resetCapture();
	bot.removedParticipants = [];
	const spammerByNameJoin = {
		group: { id: stickerGroupId, name: "Grupo Stickers" },
		user: { id: "629991112223334@lid", name: "MI523508" },
		responsavel: { id: "responsavel@s.whatsapp.net", name: "Admin" },
		origin: {
			getChat: async () => ({
				id: { _serialized: stickerGroupId },
				name: "Grupo Stickers",
				participants: [
					{
						id: { _serialized: "629991112223334@lid" },
						lid: "629991112223334@lid",
						name: "MI523508"
					}
				]
			})
		}
	};
	await eventHandler.processGroupJoin(bot, spammerByNameJoin);
	assert(bot.removedParticipants.length >= 1, "Spammer with name MI523508 must be removed");
	const welcomeSpammerName = bot.capturedMessages.filter(
		(m) => m.content && m.content.includes("Bem-vindo")
	);
	assert.strictEqual(
		welcomeSpammerName.length,
		0,
		"No welcome message should be sent to spammer with name MI###"
	);
	console.log("✓ Spammer with name MI523508: detected by name and removed on join");

	// checkAutoBanSpammers with name MI###
	bot.resetCapture();
	bot.removedParticipants = [];
	const chatWithSpammerName = {
		id: { _serialized: stickerGroupId },
		Participants: [
			{
				id: { _serialized: "629991112223334@lid" },
				name: "MI523508"
			}
		]
	};
	const bannedByName = await eventHandler.checkAutoBanSpammers(bot, chatWithSpammerName);
	assert.strictEqual(bannedByName.length, 1);
	console.log("✓ checkAutoBanSpammers: spammer detected by MI### name pattern");

	// 15. Test checkSpammerMessage with LID vs Spammers during active window
	eventHandler.spammerActiveWindowUntil = Date.now() + 60000; // active window

	// Message from innocent user with LID starting with 62
	const innocentLidMsg = {
		group: stickerGroupId,
		author: "628282381273812@lid",
		authorName: "Inocente",
		key: { id: "msg1" }
	};
	const isMsgDeleted = await eventHandler.checkSpammerMessage(bot, innocentLidMsg);
	assert.strictEqual(
		isMsgDeleted,
		false,
		"Message from user with LID starting with 62 must NOT be deleted"
	);
	console.log("✓ checkSpammerMessage: message from LID starting with 62 NOT deleted");

	// Message from DDI 380 during active window
	const ddi380Msg = {
		group: stickerGroupId,
		author: "380679523508@s.whatsapp.net",
		authorName: "Spammer Ucrânia",
		key: { id: "msg2" }
	};
	const isDdi380Deleted = await eventHandler.checkSpammerMessage(bot, ddi380Msg);
	assert.strictEqual(
		isDdi380Deleted,
		true,
		"Message from DDI 380 during active window must be deleted"
	);
	console.log("✓ checkSpammerMessage: message from DDI 380 deleted during active window");

	// Message from spammer with name MI523508
	const miNameMsg = {
		group: stickerGroupId,
		author: "5511988887777@s.whatsapp.net",
		authorName: "MI523508",
		key: { id: "msg3" }
	};
	const isMiDeleted = await eventHandler.checkSpammerMessage(bot, miNameMsg);
	assert.strictEqual(isMiDeleted, true, "Message from user with name MI523508 must be deleted");
	console.log("✓ checkSpammerMessage: message from author with name MI523508 deleted");

	console.log("--- All spammer greetings suppression tests passed successfully! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed with error:", err);
	process.exit(1);
});
