process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const InviteSystem = require("../InviteSystem");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("--- Starting DISABLE_INVITE_AUTO_ACCEPT tests ---");

	const bot = new FakeBot({ id: "test-bot", grupoInvites: "admin-invites@g.us" });
	const inviteSystem = new InviteSystem(bot);

	// Mock getInviteInfo
	bot.client.getInviteInfo = async () => ({
		IsCommunity: false,
		ParticipantCount: 15,
		JID: "120363111111@g.us",
		Name: "Grupo Amigos",
		Participants: [{ JID: "5511999990001@s.whatsapp.net" }]
	});

	// Test 1: evaluateAutoAcceptWithLLM when DISABLE_INVITE_AUTO_ACCEPT="true"
	process.env.DISABLE_INVITE_AUTO_ACCEPT = "true";
	const evalResultDisabled = await inviteSystem.evaluateAutoAcceptWithLLM({
		userName: "Usuario",
		authorId: "5511999990001@s.whatsapp.net",
		groupName: "Grupo Amigos",
		participantCount: 15,
		description: "Grupo normal",
		reason: "Gostaria de adicionar o bot para interação e mini jogos com a galera",
		isDonator: true,
		donateValue: 50
	});

	assert.strictEqual(
		evalResultDisabled.shouldAutoAccept,
		false,
		"Should return shouldAutoAccept: false when DISABLE_INVITE_AUTO_ACCEPT is true"
	);
	assert.ok(
		evalResultDisabled.reason.includes("desativado via"),
		`Reason should indicate disabled via env: got '${evalResultDisabled.reason}'`
	);
	console.log("✓ evaluateAutoAcceptWithLLM respects DISABLE_INVITE_AUTO_ACCEPT=true");

	// Test 2: handleInviteRequest skips auto-accept when DISABLE_INVITE_AUTO_ACCEPT="true"
	bot.resetCapture();
	const userJid = "5511999990001@s.whatsapp.net";
	const inviteCode = "TESTINVITE123";
	const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;

	await inviteSystem.handleInviteRequest(
		userJid,
		inviteCode,
		inviteLink,
		"Gostaria de adicionar o bot para jogos e comandos no grupo",
		createMessage({
			content: "Gostaria de adicionar o bot para jogos e comandos no grupo",
			author: userJid,
			group: null
		}),
		null,
		null
	);

	// Verifica se a mensagem de encaminhamento para o grupo de invites foi enviada
	const adminMsg = bot.capturedMessages.find((m) => m.chatId === "admin-invites@g.us");
	assert.ok(adminMsg, "Should forward invite to grupoInvites");
	assert.ok(
		adminMsg.content.includes("Auto-accept desativado"),
		`Admin message should show auto-accept disabled note: got '${adminMsg.content}'`
	);

	// Verifica se gerou o comando manual !sa-joinGrupo
	const joinCommandMsg = bot.capturedMessages.find(
		(m) => m.chatId === "admin-invites@g.us" && m.content.startsWith("!sa-joinGrupo")
	);
	assert.ok(joinCommandMsg, "Should include !sa-joinGrupo for manual admin approval");
	console.log("✓ handleInviteRequest skips auto-accept and sends manual join command to admin");

	// Test 3: fallback DISABLE_AUTO_ACCEPT="true" works when DISABLE_INVITE_AUTO_ACCEPT is not set
	delete process.env.DISABLE_INVITE_AUTO_ACCEPT;
	process.env.DISABLE_AUTO_ACCEPT = "true";

	const evalResultFallback = await inviteSystem.evaluateAutoAcceptWithLLM({
		userName: "Usuario",
		authorId: "5511999990001@s.whatsapp.net",
		groupName: "Grupo Amigos",
		participantCount: 15,
		description: "Grupo normal",
		reason: "Gostaria de adicionar o bot para interação e mini jogos com a galera",
		isDonator: true,
		donateValue: 50
	});

	assert.strictEqual(
		evalResultFallback.shouldAutoAccept,
		false,
		"Should return false with fallback DISABLE_AUTO_ACCEPT=true"
	);
	console.log("✓ fallback DISABLE_AUTO_ACCEPT=true works correctly");

	// Test 4: evaluateAutoAcceptWithLLM works when disabled is "false"
	process.env.DISABLE_INVITE_AUTO_ACCEPT = "false";
	delete process.env.DISABLE_AUTO_ACCEPT;

	const evalResultEnabled = await inviteSystem.evaluateAutoAcceptWithLLM({
		userName: "Usuario",
		authorId: "5511999990001@s.whatsapp.net",
		groupName: "Grupo Amigos",
		participantCount: 15,
		description: "Grupo normal",
		reason: "Gostaria de adicionar o bot para interação e mini jogos com a galera",
		isDonator: true,
		donateValue: 50
	});

	assert.strictEqual(
		evalResultEnabled.shouldAutoAccept,
		true,
		"VIP Donator should be accepted when auto-accept is enabled"
	);
	console.log("✓ evaluateAutoAcceptWithLLM works normally when DISABLE_INVITE_AUTO_ACCEPT=false");

	console.log("--- ALL DISABLE_INVITE_AUTO_ACCEPT TESTS PASSED! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
