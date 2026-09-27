const assert = require("assert");
const FakeBot = require("./FakeBot");
const InviteSystem = require("../InviteSystem");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("--- Starting InviteSystem bot in group and minMembros tests ---");

	// -------------------------------------------------------------
	// 1. processMessage: Bot já existe no grupo
	// -------------------------------------------------------------
	console.log("\n1. Testando detecção de bot no grupo via processMessage...");
	const bot1 = new FakeBot({ id: "bot-1", phoneNumber: "5511999990001" });
	const inviteSystem1 = new InviteSystem(bot1);

	const userJid1 = "5511988880001@s.whatsapp.net";
	const groupCode1 = "EXISTINGBOT123";
	let reactedEmoji1 = null;

	const msg1 = createMessage({
		content: `https://chat.whatsapp.com/${groupCode1}`,
		author: userJid1,
		group: null,
		type: "text"
	});
	msg1.origin.react = async (emoji) => {
		reactedEmoji1 = emoji;
	};

	bot1.client.getInviteInfo = async (code) => {
		if (code === groupCode1) {
			return {
				IsCommunity: false,
				ParticipantCount: 10,
				JID: "1203630000001@g.us",
				Name: "Grupo com Bot Presente",
				Participants: [
					{ JID: "5511988880001@s.whatsapp.net" },
					{ PhoneNumber: "5511999990001@s.whatsapp.net" }
				]
			};
		}
		return null;
	};

	bot1.resetCapture();
	const handled1 = await inviteSystem1.processMessage(msg1);

	assert.strictEqual(handled1, true, "processMessage deve retornar true");
	assert.strictEqual(reactedEmoji1, "🤖", "Deve reagir com emoji 🤖");
	assert.strictEqual(
		bot1.capturedMessages.length,
		1,
		"Deve enviar exatamente 1 mensagem ao usuário"
	);

	const response1 = bot1.capturedMessages[0].content;
	assert.ok(
		response1.includes("Já tem um bot no grupo!"),
		`Deve avisar que já tem bot no grupo: '${response1}'`
	);
	assert.ok(
		response1.includes("mesmo código") && response1.includes("mesmo servidor"),
		`Deve explicar que rodam mesmo código e servidor: '${response1}'`
	);
	assert.ok(
		response1.includes("Remover o bot do grupo pode ocasionar o bloqueio"),
		`Deve alertar sobre risco de bloqueio ao remover: '${response1}'`
	);
	assert.ok(
		response1.includes("não terá prioridade para voltar"),
		`Deve alertar sobre perda de prioridade: '${response1}'`
	);
	assert.ok(
		response1.includes("!grupao / comunidade da ravena"),
		`Deve sugerir !grupao / comunidade da ravena: '${response1}'`
	);

	assert.strictEqual(
		inviteSystem1.userCooldowns.has(userJid1),
		false,
		"Usuário NÃO deve ser colocado em cooldown"
	);
	assert.strictEqual(
		inviteSystem1.groupInviteCooldowns.has(groupCode1),
		false,
		"Grupo NÃO deve ser colocado em cooldown"
	);
	assert.strictEqual(
		inviteSystem1.pendingRequests.has(userJid1),
		false,
		"Nenhuma requisição pendente deve ser criada"
	);
	console.log("✓ Bot já no grupo encerra ciclo sem cooldown e avisa usuário adequadamente");

	// -------------------------------------------------------------
	// 2. handleInviteRequest (fallback): Bot já no grupo
	// -------------------------------------------------------------
	console.log("\n2. Testando fallback de bot no grupo via handleInviteRequest...");
	const bot2 = new FakeBot({ id: "bot-2", phoneNumber: "5511999990002" });
	bot2.grupoInvites = "admin-invites@g.us";
	const inviteSystem2 = new InviteSystem(bot2);

	const userJid2 = "5511988880002@s.whatsapp.net";
	const groupCode2 = "EXISTINGBOTFALLBACK";

	// Simula cooldowns pré-existentes
	inviteSystem2.userCooldowns.set(userJid2, Date.now());
	inviteSystem2.groupInviteCooldowns.set(groupCode2, Date.now());

	bot2.client.getInviteInfo = async () => ({
		IsCommunity: false,
		ParticipantCount: 8,
		JID: "1203630000002@g.us",
		Name: "Grupo Fallback Bot",
		Participants: [{ JID: "5511999990002@s.whatsapp.net" }]
	});

	bot2.resetCapture();
	await inviteSystem2.handleInviteRequest(
		userJid2,
		groupCode2,
		`https://chat.whatsapp.com/${groupCode2}`,
		"Motivo qualquer",
		createMessage({ content: "Motivo qualquer", author: userJid2, group: null }),
		null,
		null
	);

	assert.strictEqual(
		inviteSystem2.userCooldowns.has(userJid2),
		false,
		"Cooldown do usuário deve ser limpo"
	);
	assert.strictEqual(
		inviteSystem2.groupInviteCooldowns.has(groupCode2),
		false,
		"Cooldown do grupo deve ser limpo"
	);
	assert.strictEqual(
		bot2.capturedMessages.some((m) => m.chatId === "admin-invites@g.us"),
		false,
		"Não deve enviar para grupoInvites"
	);
	const response2 = bot2.capturedMessages.find((m) => m.chatId === userJid2)?.content;
	assert.ok(
		response2 && response2.includes("Já tem um bot no grupo!"),
		"Deve enviar mensagem explicativa ao usuário"
	);
	console.log("✓ Fallback de bot no grupo limpa cooldowns e não repassa para grupoInvites");

	// -------------------------------------------------------------
	// 3. processMessage: extras.invites.minMembros com numeroResponsavel
	// -------------------------------------------------------------
	console.log("\n3. Testando extras.invites.minMembros com numeroResponsavel...");
	const bot3 = new FakeBot({
		id: "bot-comunitario-1",
		numeroResponsavel: "5547999153417",
		extras: {
			invites: {
				minMembros: 20
			}
		}
	});
	const inviteSystem3 = new InviteSystem(bot3);

	const userJid3 = "5511988880003@s.whatsapp.net";
	const groupCode3 = "FEWMEMBERS1";
	let reactedEmoji3 = null;

	const msg3 = createMessage({
		content: `https://chat.whatsapp.com/${groupCode3}`,
		author: userJid3,
		group: null,
		type: "text"
	});
	msg3.origin.react = async (emoji) => {
		reactedEmoji3 = emoji;
	};

	bot3.client.getInviteInfo = async () => ({
		IsCommunity: false,
		ParticipantCount: 8,
		JID: "1203630000003@g.us",
		Name: "Grupo com 8 Membros",
		Participants: []
	});

	bot3.resetCapture();
	const handled3 = await inviteSystem3.processMessage(msg3);

	assert.strictEqual(handled3, true, "processMessage deve retornar true");
	assert.strictEqual(reactedEmoji3, "👥", "Deve reagir com emoji 👥");
	assert.strictEqual(bot3.capturedMessages.length, 1, "Deve enviar exatamente 1 mensagem");

	const response3 = bot3.capturedMessages[0].content;
	assert.strictEqual(
		response3,
		"Esta ravena não aceita convites de grupos com menos de 20 membros. Se tiver dúvidas, chame administrador desta ravena comunitária em +5547999153417",
		`Mensagem com responsável incorreta: '${response3}'`
	);
	assert.strictEqual(
		inviteSystem3.userCooldowns.has(userJid3),
		false,
		"Usuário NÃO deve ser colocado em cooldown"
	);
	assert.strictEqual(
		inviteSystem3.pendingRequests.has(userJid3),
		false,
		"Nenhuma requisição pendente deve ser criada"
	);
	console.log(
		"✓ extras.invites.minMembros com numeroResponsavel rejeita e formata contato perfeitamente"
	);

	// -------------------------------------------------------------
	// 4. processMessage: extras.invites.minMembros sem numeroResponsavel
	// -------------------------------------------------------------
	console.log("\n4. Testando extras.invites.minMembros sem numeroResponsavel...");
	const bot4 = new FakeBot({
		id: "bot-comunitario-2",
		numeroResponsavel: null,
		extras: {
			invites: {
				minMembros: 15
			}
		}
	});
	const inviteSystem4 = new InviteSystem(bot4);

	const userJid4 = "5511988880004@s.whatsapp.net";
	const groupCode4 = "FEWMEMBERS2";
	let reactedEmoji4 = null;

	const msg4 = createMessage({
		content: `https://chat.whatsapp.com/${groupCode4}`,
		author: userJid4,
		group: null,
		type: "text"
	});
	msg4.origin.react = async (emoji) => {
		reactedEmoji4 = emoji;
	};

	bot4.client.getInviteInfo = async () => ({
		IsCommunity: false,
		ParticipantCount: 14,
		JID: "1203630000004@g.us",
		Name: "Grupo com 14 Membros",
		Participants: []
	});

	bot4.resetCapture();
	const handled4 = await inviteSystem4.processMessage(msg4);

	assert.strictEqual(handled4, true, "processMessage deve retornar true");
	assert.strictEqual(reactedEmoji4, "👥", "Deve reagir com emoji 👥");
	assert.strictEqual(bot4.capturedMessages.length, 1, "Deve enviar exatamente 1 mensagem");

	const response4 = bot4.capturedMessages[0].content;
	assert.strictEqual(
		response4,
		"Esta ravena não aceita convites de grupos com menos de 15 membros. Se tiver dúvidas, chame no !grupao / comunidade da ravena",
		`Mensagem sem responsável incorreta: '${response4}'`
	);
	assert.strictEqual(
		inviteSystem4.userCooldowns.has(userJid4),
		false,
		"Usuário NÃO deve ser colocado em cooldown"
	);
	console.log(
		"✓ extras.invites.minMembros sem numeroResponsavel formata !grupao / comunidade perfeitamente"
	);

	// -------------------------------------------------------------
	// 5. processMessage: Grupo que atinge ou supera minMembros
	// -------------------------------------------------------------
	console.log("\n5. Testando grupo que atinge a quantidade de minMembros...");
	const bot5 = new FakeBot({
		id: "bot-comunitario-3",
		extras: {
			invites: {
				minMembros: 10
			}
		}
	});
	const inviteSystem5 = new InviteSystem(bot5);

	const userJid5 = "5511988880005@s.whatsapp.net";
	const groupCode5 = "ENOUGHMEMBERS";

	const msg5 = createMessage({
		content: `https://chat.whatsapp.com/${groupCode5}`,
		author: userJid5,
		group: null,
		type: "text"
	});

	bot5.client.getInviteInfo = async () => ({
		IsCommunity: false,
		ParticipantCount: 10,
		JID: "1203630000005@g.us",
		Name: "Grupo com 10 Membros (Atende mínimo)",
		Participants: []
	});

	bot5.resetCapture();
	const handled5 = await inviteSystem5.processMessage(msg5);

	assert.strictEqual(handled5, true, "processMessage deve retornar true");
	assert.ok(
		inviteSystem5.pendingRequests.has(userJid5),
		"Grupo com membros suficientes deve prosseguir para pedido de motivo"
	);
	assert.ok(
		inviteSystem5.userCooldowns.has(userJid5),
		"Grupo com membros suficientes deve ativar cooldown normal de convite"
	);
	console.log("✓ Grupo com membros suficientes prossegue normalmente no fluxo de convite");

	// -------------------------------------------------------------
	// 6. handleInviteRequest (fallback): minMembros
	// -------------------------------------------------------------
	console.log("\n6. Testando fallback de minMembros via handleInviteRequest...");
	const bot6 = new FakeBot({
		id: "bot-comunitario-4",
		numeroResponsavel: "+5511914334233",
		extras: {
			invites: {
				minMembros: 25
			}
		}
	});
	bot6.grupoInvites = "admin-invites@g.us";
	const inviteSystem6 = new InviteSystem(bot6);

	const userJid6 = "5511988880006@s.whatsapp.net";
	const groupCode6 = "FEWMEMBERSFALLBACK";

	inviteSystem6.userCooldowns.set(userJid6, Date.now());
	inviteSystem6.groupInviteCooldowns.set(groupCode6, Date.now());

	bot6.client.getInviteInfo = async () => ({
		IsCommunity: false,
		ParticipantCount: 12,
		JID: "1203630000006@g.us",
		Name: "Grupo Fallback Poucos Membros",
		Participants: []
	});

	bot6.resetCapture();
	await inviteSystem6.handleInviteRequest(
		userJid6,
		groupCode6,
		`https://chat.whatsapp.com/${groupCode6}`,
		"Motivo qualquer",
		createMessage({ content: "Motivo qualquer", author: userJid6, group: null }),
		null,
		null
	);

	assert.strictEqual(
		inviteSystem6.userCooldowns.has(userJid6),
		false,
		"Cooldown do usuário deve ser limpo"
	);
	assert.strictEqual(
		inviteSystem6.groupInviteCooldowns.has(groupCode6),
		false,
		"Cooldown do grupo deve ser limpo"
	);
	assert.strictEqual(
		bot6.capturedMessages.some((m) => m.chatId === "admin-invites@g.us"),
		false,
		"Não deve enviar para grupoInvites"
	);
	const response6 = bot6.capturedMessages.find((m) => m.chatId === userJid6)?.content;
	assert.strictEqual(
		response6,
		"Esta ravena não aceita convites de grupos com menos de 25 membros. Se tiver dúvidas, chame administrador desta ravena comunitária em +5511914334233"
	);
	console.log("✓ Fallback de minMembros limpa cooldowns e avisa usuário corretamente");

	// Limpa timeouts pendentes
	inviteSystem1.destroy();
	inviteSystem2.destroy();
	inviteSystem3.destroy();
	inviteSystem4.destroy();
	inviteSystem5.destroy();
	inviteSystem6.destroy();

	console.log("\n--- ALL InviteSystem bot in group and minMembros TESTS PASSED! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
