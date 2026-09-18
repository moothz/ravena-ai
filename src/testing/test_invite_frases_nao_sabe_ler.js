const assert = require("assert");
const FakeBot = require("./FakeBot");
const InviteSystem = require("../InviteSystem");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("--- Starting InviteSystem frasesNaoSabeLer tests ---");

	// 1. Verify frasesNaoSabeLer definition
	assert.ok(Array.isArray(InviteSystem.frasesNaoSabeLer), "frasesNaoSabeLer should be an array");
	assert.ok(
		InviteSystem.frasesNaoSabeLer.includes("tenho permissão"),
		"frasesNaoSabeLer must include 'tenho permissão'"
	);
	assert.ok(
		InviteSystem.frasesNaoSabeLer.includes("tenho permissao"),
		"frasesNaoSabeLer must include 'tenho permissao'"
	);
	console.log("✓ frasesNaoSabeLer static property is defined correctly");

	const bot = new FakeBot({ id: "test-bot" });
	const inviteSystem = new InviteSystem(bot);
	assert.ok(
		Array.isArray(inviteSystem.frasesNaoSabeLer),
		"instance frasesNaoSabeLer should be an array"
	);

	const userJid = "5511999991234@s.whatsapp.net";
	const inviteCode = "ABCDefgh123456";
	const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;

	// 2. Test handleInviteRequest with "tenho permissão"
	bot.resetCapture();
	await inviteSystem.handleInviteRequest(
		userJid,
		inviteCode,
		inviteLink,
		"tenho permissão",
		createMessage({ content: "tenho permissão", author: userJid, group: null }),
		"verify123",
		"preConviteContent"
	);

	assert.strictEqual(bot.capturedMessages.length, 1, "Should send 1 message");
	const response1 = bot.capturedMessages[0].content.toLowerCase();
	assert.ok(
		response1.includes("leitura não é o seu forte") ||
			response1.includes("ler e escrever não é seu forte"),
		`Response should mention leitura: got '${response1}'`
	);
	assert.ok(inviteSystem.userCooldowns.has(userJid), "User should be on cooldown");
	console.log("✓ handleInviteRequest correctly rejects 'tenho permissão'");

	// 3. Test handleInviteRequest with "tenho permissao" (sem acento)
	const userJid2 = "5511999995678@s.whatsapp.net";
	bot.resetCapture();
	await inviteSystem.handleInviteRequest(
		userJid2,
		inviteCode,
		inviteLink,
		"Sim, eu tenho permissao dos admins",
		createMessage({ content: "Sim, eu tenho permissao dos admins", author: userJid2, group: null }),
		"verify123",
		"preConviteContent"
	);

	assert.strictEqual(bot.capturedMessages.length, 1, "Should send 1 message");
	const response2 = bot.capturedMessages[0].content.toLowerCase();
	assert.ok(
		response2.includes("leitura não é o seu forte") ||
			response2.includes("ler e escrever não é seu forte"),
		`Response should mention leitura: got '${response2}'`
	);
	assert.ok(inviteSystem.userCooldowns.has(userJid2), "User should be on cooldown");
	console.log("✓ handleInviteRequest correctly rejects phrase containing 'tenho permissao'");

	// 4. Test follow-up message flow with "tenho permissão"
	const userJid3 = "5511999999999@s.whatsapp.net";
	inviteSystem.pendingRequests.set(userJid3, {
		inviteCode,
		inviteLink,
		timeout: setTimeout(() => {}, 100000),
		verificationCode: "xyz789",
		preConviteContent: "pre convite texto"
	});

	bot.resetCapture();
	const followUpMsg = createMessage({
		content: "Tenho permissão",
		author: userJid3,
		group: null,
		type: "text"
	});

	const handled = await inviteSystem.processFollowUpMessage(followUpMsg);
	assert.strictEqual(handled, true, "Follow-up message should be handled");
	assert.strictEqual(
		inviteSystem.pendingRequests.has(userJid3),
		false,
		"Pending request should be deleted"
	);
	assert.strictEqual(bot.capturedMessages.length, 1, "Should send 1 message");
	const response3 = bot.capturedMessages[0].content.toLowerCase();
	assert.ok(
		response3.includes("leitura não é o seu forte") ||
			response3.includes("ler e escrever não é seu forte"),
		`Response should mention leitura: got '${response3}'`
	);
	console.log("✓ processFollowUpMessage handles 'Tenho permissão' immediately without waiting");

	// 5. Test legitimate reason is NOT rejected by frasesNaoSabeLer
	const userJid4 = "5511999990001@s.whatsapp.net";
	inviteSystem.pendingRequests.set(userJid4, {
		inviteCode,
		inviteLink,
		timeout: setTimeout(() => {}, 100000),
		verificationCode: "xyz789",
		preConviteContent: "pre convite texto"
	});

	bot.resetCapture();
	const legitMsg = createMessage({
		content: "Gostaria de usar o bot no meu grupo de estudos para organizar lembretes e tarefas.",
		author: userJid4,
		group: null,
		type: "text"
	});

	const legitHandled = await inviteSystem.processFollowUpMessage(legitMsg);
	assert.strictEqual(legitHandled, true, "Legitimate follow-up message should be handled");
	// Since it's legitimate, it starts accumulation and does NOT immediately send "leitura não é seu forte"
	assert.strictEqual(
		bot.capturedMessages.length,
		0,
		"Legitimate message should not trigger immediate rejection"
	);
	// Clean up pending timer
	const pending = inviteSystem.pendingRequests.get(userJid4);
	if (pending?.accumulationTimeout) clearTimeout(pending.accumulationTimeout);
	if (pending?.timeout) clearTimeout(pending.timeout);
	inviteSystem.pendingRequests.delete(userJid4);
	console.log("✓ Legitimate reason is not flagged as frasesNaoSabeLer");

	// 6. Test Community hard filter (does not forward invite)
	const userJid5 = "5511999990002@s.whatsapp.net";
	const communityCode = "COMMUNITY123";
	const communityMsg = createMessage({
		content: `https://chat.whatsapp.com/${communityCode}`,
		author: userJid5,
		group: null,
		type: "text"
	});

	bot.resetCapture();
	bot.client.getInviteInfo = async (code) => {
		if (code === communityCode) {
			return { IsCommunity: true, JID: "12345-community@g.us", Name: "Comunidade Teste" };
		}
		return null;
	};

	const communityHandled = await inviteSystem.processMessage(communityMsg);
	assert.strictEqual(communityHandled, true, "Community message should be handled");
	assert.strictEqual(bot.capturedMessages.length, 1, "Should send 1 message to user");
	assert.ok(
		bot.capturedMessages[0].content.includes("comunidade"),
		"Message should explain that it is a community"
	);
	assert.strictEqual(
		inviteSystem.pendingRequests.has(userJid5),
		false,
		"Community should not create pending request"
	);
	console.log("✓ Community hard filter does not forward invite and notifies user");

	// 7. Test 1-member group hard filter in processMessage
	const userJid6 = "5511999990003@s.whatsapp.net";
	const soloGroupCode = "SOLOGROUP123";
	let reactedEmoji = null;
	const soloMsg = createMessage({
		content: `https://chat.whatsapp.com/${soloGroupCode}`,
		author: userJid6,
		group: null,
		type: "text"
	});
	soloMsg.origin.react = async (emoji) => {
		reactedEmoji = emoji;
	};

	bot.resetCapture();
	bot.client.getInviteInfo = async (code) => {
		if (code === soloGroupCode) {
			return {
				IsCommunity: false,
				ParticipantCount: 1,
				JID: "99999-solo@g.us",
				Name: "Grupo Sozinho"
			};
		}
		return null;
	};

	const soloHandled = await inviteSystem.processMessage(soloMsg);
	assert.strictEqual(soloHandled, true, "Solo group message should be handled");
	assert.strictEqual(reactedEmoji, "👤", "Should react with 👤 emoji");
	assert.strictEqual(bot.capturedMessages.length, 1, "Should send 1 message to user");
	const soloResponse = bot.capturedMessages[0].content;
	assert.ok(
		soloResponse.includes("1 membro") &&
			soloResponse.includes("PV") &&
			(soloResponse.includes("comunidade") || soloResponse.includes("chat.whatsapp.com")),
		`Solo group message should mention 1 membro, PV and community link: got '${soloResponse}'`
	);
	assert.strictEqual(
		inviteSystem.pendingRequests.has(userJid6),
		false,
		"Solo group should not create pending request"
	);
	console.log(
		"✓ 1-member group hard filter in processMessage does not forward invite and sends community link"
	);

	// 8. Test 1-member group hard filter in handleInviteRequest
	const userJid7 = "5511999990004@s.whatsapp.net";
	bot.resetCapture();
	bot.grupoInvites = "admin-invites@g.us";
	await inviteSystem.handleInviteRequest(
		userJid7,
		soloGroupCode,
		`https://chat.whatsapp.com/${soloGroupCode}`,
		"Meu motivo para adicionar o bot",
		createMessage({ content: "Meu motivo para adicionar o bot", author: userJid7, group: null }),
		null,
		null
	);

	assert.strictEqual(bot.capturedMessages.length, 1, "Should send 1 message to user only");
	assert.strictEqual(
		bot.capturedMessages[0].chatId,
		userJid7,
		"Message should only be sent to author, NOT forwarded to grupoInvites"
	);
	console.log(
		"✓ 1-member group hard filter in handleInviteRequest does not forward to grupoInvites"
	);

	// 9. Test evaluateAutoAcceptWithLLM: donator with strange characters is not rejected by pre-filter
	const strangeName = "𝓡𝓪𝓿𝓮𝓷𝓪 𝓕𝓪𝓷";
	const nonDonatorEval = await inviteSystem.evaluateAutoAcceptWithLLM({
		userName: strangeName,
		authorId: "5511999990005@s.whatsapp.net",
		groupName: "Grupo Legal",
		participantCount: 10,
		description: "Grupo normal",
		reason: "Quero usar os comandos de jogos com a galera",
		isDonator: false,
		donateValue: 0
	});
	assert.strictEqual(nonDonatorEval.shouldAutoAccept, false);
	assert.ok(
		nonDonatorEval.reason.includes("Caracteres estranhos"),
		`Non donator should be rejected for strange characters: got '${nonDonatorEval.reason}'`
	);

	// For donator (e.g. R$50 VIP), should bypass strange characters and auto-accept
	const donatorEval = await inviteSystem.evaluateAutoAcceptWithLLM({
		userName: strangeName,
		authorId: "5511999990005@s.whatsapp.net",
		groupName: "Grupo Legal",
		participantCount: 10,
		description: "Grupo normal",
		reason: "Quero usar os comandos de jogos com a galera",
		isDonator: true,
		donateValue: 50
	});
	assert.strictEqual(
		donatorEval.shouldAutoAccept,
		true,
		"VIP Donator with strange characters should be auto-accepted"
	);
	console.log("✓ evaluateAutoAcceptWithLLM allows strange characters for donators");

	// 10. Test extraText warnings for current ravena and previous ravena
	// Case A: Bot currently in group (should have 🚨 warning, should NOT duplicate with ⚠️ previous warning)
	const userJid8 = "5511999990006@s.whatsapp.net";
	const groupWithBotCode = "GROUPWITHBOT123";
	bot.resetCapture();
	bot.phoneNumber = "5511999990000";
	bot.client.getInviteInfo = async () => ({
		IsCommunity: false,
		ParticipantCount: 5,
		JID: "120363999999-botgroup@g.us",
		Name: "Grupo Com Bot",
		Participants: [{ JID: "5511999990000@s.whatsapp.net" }]
	});

	await inviteSystem.handleInviteRequest(
		userJid8,
		groupWithBotCode,
		`https://chat.whatsapp.com/${groupWithBotCode}`,
		"Quero outro bot para ajudar no grupo",
		createMessage({
			content: "Quero outro bot para ajudar no grupo",
			author: userJid8,
			group: null
		}),
		null,
		null
	);

	const userMsgA = bot.capturedMessages.find((m) => m.chatId === userJid8);
	assert.ok(userMsgA, "Should send confirmation message to user");
	const msgA = userMsgA.content;
	assert.ok(
		msgA.includes("🚨 Já tem uma ravena no seu grupo!"),
		`Message should contain siren warning: got '${msgA}'`
	);
	assert.ok(
		!msgA.includes("Alguma ravena já esteve no seu grupo e foi removida"),
		"Message should NOT contain previous ravena warning when bot is currently in group"
	);

	// Case B: Bot was in group before, but NOT currently in group
	const userJid9 = "5511999990007@s.whatsapp.net";
	const groupWasBeforeCode = "GROUPWASBEFORE123";
	bot.resetCapture();
	bot.client.getInviteInfo = async () => ({
		IsCommunity: false,
		ParticipantCount: 5,
		JID: "120363888888-wasbefore@g.us",
		Name: "Grupo Sem Bot Agora",
		Participants: [{ JID: "5511888888888@s.whatsapp.net" }]
	});
	// Mock getManualGroupLeave to return record indicating bot was in group before
	inviteSystem.database.getManualGroupLeave = async (jid) => {
		if (jid === "120363888888-wasbefore@g.us") {
			return { group_name: "Grupo Sem Bot Agora" };
		}
		return null;
	};

	await inviteSystem.handleInviteRequest(
		userJid9,
		groupWasBeforeCode,
		`https://chat.whatsapp.com/${groupWasBeforeCode}`,
		"Gostaria do bot de volta no grupo para ajudar com os jogos",
		createMessage({
			content: "Gostaria do bot de volta no grupo para ajudar com os jogos",
			author: userJid9,
			group: null
		}),
		null,
		null
	);

	const userMsgB = bot.capturedMessages.find((m) => m.chatId === userJid9);
	assert.ok(userMsgB, "Should send confirmation message to user");
	const msgB = userMsgB.content;
	assert.ok(
		msgB.includes(
			"⚠️ Alguma ravena já esteve no seu grupo e foi removida. É provável que seu convite não seja aceito"
		),
		`Message should contain previous ravena alert warning: got '${msgB}'`
	);
	assert.ok(
		!msgB.includes("🚨 Já tem uma ravena no seu grupo!"),
		"Message should NOT contain current ravena warning when bot is not in group"
	);

	console.log(
		"✓ extraText warnings for current and previous ravena work correctly without duplication"
	);

	console.log("--- ALL InviteSystem hard filter and extraText TESTS PASSED! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
