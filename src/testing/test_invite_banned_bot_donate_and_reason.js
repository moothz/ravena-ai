process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const InviteSystem = require("../InviteSystem");

async function runTests() {
	console.log("=== TESTES DE VALIDAÇÃO DE MOTIVO E RAVENA BANIDA (AUTO-ACCEPT) ===\n");

	// 1. Testes de InviteSystem.isWeakOrGenericReason
	console.log("[1] Testando InviteSystem.isWeakOrGenericReason...");

	// 1.1 Casos de frases fracas / declarações de cargo / permissão (DEVEM SER REJEITADAS)
	const weakCases = [
		"sou adm pode entrar",
		"sou adm pode entra",
		"sou admin pode entrar",
		"sou o dono pode entrar",
		"sou dona pode entrar",
		"sou adm pode colocar",
		"sou adm",
		"sou admin",
		"sou o adm",
		"sou dono",
		"sou o dono",
		"sou dona",
		"sou administrador",
		"sou mod",
		"sou moderador",
		"pode entrar sou adm",
		"sou adm entra ai",
		"adm deixou",
		"o adm deixou",
		"tenho permissão",
		"tenho permissao",
		"entra aí",
		"entra ai",
		"entra por favor",
		"entra pfv",
		"coloca aí",
		"pode entrar",
		"pode colocar",
		"mandaram colocar",
		"falaram pra colocar",
		"quero testar",
		"para testar",
		"pra testar",
		"so teste",
		"sim",
		"legal",
		"quero figurinhas", // Curto / menos de 4 palavras
		"oi bot entra",
		"sou adm do grupo pode entrar"
	];

	for (const phrase of weakCases) {
		const check = InviteSystem.isWeakOrGenericReason(phrase);
		assert.strictEqual(
			check.isWeak,
			true,
			`A frase "${phrase}" deveria ser considerada fraca/inválida, mas retornou isWeak=${check.isWeak}`
		);
	}
	console.log(
		`✅ Todas as ${weakCases.length} frases fracas/genéricas foram corretamente rejeitadas!`
	);

	// 1.2 Casos de frases concisas e completas (DEVEM SER ACEITAS PARA AVALIAÇÃO)
	const goodCases = [
		"Gostaria de adicionar a ravena para os membros usarem figurinhas e jogarem minigames.",
		"Quero colocar o bot no grupo de amigos para interagir com comandos diários e música.",
		"Grupo da faculdade para compartilharmos lembretes e utilitários que a ravena oferece.",
		"Nosso grupo de anime quer interagir com as funções da waifu e comandos da ravena.",
		"Queremos entretenimento para a comunidade com os jogos, roleta e figurinhas da ravenabot."
	];

	for (const phrase of goodCases) {
		const check = InviteSystem.isWeakOrGenericReason(phrase);
		assert.strictEqual(
			check.isWeak,
			false,
			`A frase "${phrase}" deveria ser aceita como concisa e completa, mas foi rejeitada com: ${check.reason}`
		);
	}
	console.log(
		`✅ Todas as ${goodCases.length} frases concisas e completas foram aceitas para avaliação!`
	);

	// 2. Testes de Ravena Banida no Auto-Accept (evaluateAutoAcceptRecentlyBanned)
	console.log("\n[2] Testando evaluateAutoAcceptRecentlyBanned com Ravena Banida...");
	const bot = new FakeBot({ id: "teste-bot" });
	const inviteSystem = new InviteSystem(bot);

	process.env.DISABLE_INVITE_AUTO_ACCEPT = "false";
	process.env.DISABLE_AUTO_ACCEPT = "false";

	// 2.1 Ravena banida presente no grupo e NÃO doador: DEVE REJEITAR (apenas donate aceita)
	const resRecentlyBannedSemDonate = await inviteSystem.evaluateAutoAcceptRecentlyBanned({
		hasBannedBotInGroup: true,
		isDonator: false,
		participantCount: 25
	});
	assert.strictEqual(
		resRecentlyBannedSemDonate.shouldAutoAccept,
		false,
		"Ravena banida sem donate deve ser rejeitada no modo recently banned"
	);
	assert.strictEqual(resRecentlyBannedSemDonate.bannedModeReject, "banned_bot_requires_donation");
	assert.ok(
		resRecentlyBannedSemDonate.reason.includes("Ravena no grupo está banida"),
		`Motivo deve indicar que a ravena no grupo está banida: ${resRecentlyBannedSemDonate.reason}`
	);
	console.log(
		"✅ Ravena banida sem donate foi rejeitada corretamente no evaluateAutoAcceptRecentlyBanned!"
	);

	// 2.2 Ravena banida presente no grupo e COM doador: DEVE ACEITAR
	const resRecentlyBannedComDonate = await inviteSystem.evaluateAutoAcceptRecentlyBanned({
		hasBannedBotInGroup: true,
		isDonator: true,
		donateValue: 50,
		participantCount: 25
	});
	assert.strictEqual(
		resRecentlyBannedComDonate.shouldAutoAccept,
		true,
		"Ravena banida com donate deve ser aceita no modo recently banned"
	);
	console.log(
		"✅ Ravena banida com donate foi aceita corretamente no evaluateAutoAcceptRecentlyBanned!"
	);

	// 3. Testes de Ravena Banida no evaluateAutoAcceptWithLLM
	console.log("\n[3] Testando evaluateAutoAcceptWithLLM com Ravena Banida...");

	// 3.1 Ravena banida presente no grupo e NÃO doador: DEVE REJEITAR no pré-filtro
	const resLLMSemDonate = await inviteSystem.evaluateAutoAcceptWithLLM({
		userName: "Solicitante Teste",
		authorId: "5511999990001@s.whatsapp.net",
		groupName: "Grupo com Ravena Banida",
		participantCount: 20,
		description: "Grupo normal de bate papo",
		reason: "Gostaria da ravena para os membros brincarem com as figurinhas e jogos.",
		isDonator: false,
		hasBannedBotInGroup: true
	});
	assert.strictEqual(
		resLLMSemDonate.shouldAutoAccept,
		false,
		"evaluateAutoAcceptWithLLM deve rejeitar se a ravena no grupo estiver banida e solicitante não for doador"
	);
	assert.ok(
		resLLMSemDonate.reason.includes("Ravena presente no grupo está banida"),
		`Motivo deve indicar que a ravena presente no grupo está banida: ${resLLMSemDonate.reason}`
	);
	console.log(
		"✅ Ravena banida sem donate foi rejeitada no pré-filtro do evaluateAutoAcceptWithLLM!"
	);

	// 4. Testes de validação de motivo no pré-filtro do evaluateAutoAcceptWithLLM
	console.log("\n[4] Testando rejeição de 'sou adm pode entrar' no evaluateAutoAcceptWithLLM...");
	const resMotivoFraco = await inviteSystem.evaluateAutoAcceptWithLLM({
		userName: "Admin Teste",
		authorId: "5511999990002@s.whatsapp.net",
		groupName: "Grupo dos Amigos",
		participantCount: 20,
		description: "Grupo de amigos da faculdade",
		reason: "sou adm pode entrar",
		isDonator: false,
		hasBannedBotInGroup: false
	});
	assert.strictEqual(
		resMotivoFraco.shouldAutoAccept,
		false,
		"Motivo 'sou adm pode entrar' deve ser rejeitado no auto-accept"
	);
	assert.ok(
		resMotivoFraco.reason.includes("Motivo genérico/fraco") ||
			resMotivoFraco.reason.includes("cargo/permissão"),
		`Motivo retornado deve explicar a fraqueza da frase: ${resMotivoFraco.reason}`
	);
	console.log(`✅ Motivo 'sou adm pode entrar' rejeitado com razão: "${resMotivoFraco.reason}"`);

	// 4.2 Teste com doador VIP aceitando mesmo com motivo simples
	console.log("\n[4.2] Testando doador VIP com motivo simples...");
	const resDoadorVIP = await inviteSystem.evaluateAutoAcceptWithLLM({
		userName: "Doador VIP",
		authorId: "5511999990003@s.whatsapp.net",
		groupName: "Grupo dos Amigos VIP",
		participantCount: 20,
		description: "Grupo de amigos",
		reason: "sou adm pode entrar",
		isDonator: true,
		donateValue: 50,
		hasBannedBotInGroup: false
	});
	assert.strictEqual(
		resDoadorVIP.shouldAutoAccept,
		true,
		"Doador VIP (R$50+) deve ser aceito automaticamente garantido"
	);
	console.log("✅ Doador VIP com motivo simples foi aprovado conforme regras de doador!");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! 🎉 ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
