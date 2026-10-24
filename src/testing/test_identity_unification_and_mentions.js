process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const MemoryService = require("../services/MemoryService");
const ProfilePictureHelper = require("../utils/ProfilePictureHelper");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== INICIANDO TESTES DE UNIFICAÇÃO DE IDENTIDADES E MENÇÕES ===");
	const memoryService = MemoryService.getInstance();

	// Teste 1: Pedro Carboni consolidado em 1 único card 360
	console.log("\n[TESTE 1] Verificando Pedro Carboni no searchUsers e getUser360...");
	const pedroSearch = await memoryService.searchUsers("Pedro Carboni");
	assert.strictEqual(
		pedroSearch.length,
		1,
		`Esperado exatamente 1 resultado para Pedro Carboni, obtido ${pedroSearch.length}`
	);
	assert.strictEqual(
		pedroSearch[0].canonical_user_id,
		"wa_5516997574909",
		`ID canônico esperado wa_5516997574909, obtido ${pedroSearch[0].canonical_user_id}`
	);
	assert.ok(
		pedroSearch[0].facts_count >= 5,
		`Esperado ao menos 5 fatos para Pedro Carboni, obtido ${pedroSearch[0].facts_count}`
	);

	const pedro360 = await memoryService.getUser360("wa_5516997574909");
	assert.ok(pedro360, "getUser360(wa_5516997574909) não deve ser nulo");
	assert.strictEqual(pedro360.display_name, "Pedro Carboni");
	console.log("✓ Teste 1 passou: Pedro Carboni unificado com sucesso!");

	// Teste 2: moothz e privacidade estrita dos Super Admins
	console.log("\n[TESTE 2] Verificando contas do Criador (SUPER_ADMINS) e regra de privacidade...");
	const adminPhones = memoryService.getSuperAdminPhones();
	assert.ok(
		adminPhones.length > 0,
		"Deve haver ao menos um Super Admin configurado em SUPER_ADMINS"
	);

	for (const phone of adminPhones) {
		const dossie = await memoryService.getUser360(`wa_${phone}`);
		if (dossie && dossie.facts && dossie.facts.length > 0) {
			const hasCreatorFact = dossie.facts.some((f) =>
				f.fact_text.includes("criador e desenvolvedor")
			);
			assert.ok(hasCreatorFact, `Conta wa_${phone} deve conter fato de criador`);
		}

		// Teste de privacidade: O número privado NUNCA pode vazar no texto gerado para prompt
		const ctx = await memoryService.getUserContextForPrompt(`${phone}@s.whatsapp.net`);
		assert.ok(
			!ctx.includes(phone),
			`VIOLAÇÃO DE PRIVACIDADE: O número privado ${phone} vazou no prompt!\nConteúdo:\n${ctx}`
		);
		assert.ok(
			ctx.includes("Criador da Ravena"),
			"O prompt do criador deve identificá-lo como Criador da Ravena"
		);
	}
	console.log("✓ Teste 2 passou: Contas do criador validadas e números privados 100% protegidos!");

	// Teste 3: Menções no comando !ia e extração de fatos
	console.log("\n[TESTE 3] Verificando injeção de contexto de menções para IA...");
	const fakeMsg = createMessage({
		content: "!ia o que você acha do @5516997574909?",
		author: "5511999999999@s.whatsapp.net",
		group: "120363000000000000@g.us",
		origin: {
			mentionedIds: ["5516997574909@s.whatsapp.net"]
		}
	});

	const mentions = ProfilePictureHelper.extractMentions(fakeMsg, []);
	assert.strictEqual(mentions.length, 1, "Deve extrair 1 menção");
	assert.strictEqual(mentions[0], "5516997574909@s.whatsapp.net");

	const mentionedCtx = await memoryService.getUserContextForPrompt(
		mentions[0],
		"o que você acha",
		"USUÁRIO MENCIONADO"
	);
	assert.ok(
		mentionedCtx.includes("[MEMÓRIA E FATOS SOBRE O USUÁRIO MENCIONADO (Pedro Carboni)]"),
		`Contexto da menção deve ter o cabeçalho de usuário mencionado. Obtido:\n${mentionedCtx}`
	);
	assert.ok(
		mentionedCtx.includes("•"),
		"Contexto da menção deve conter tópicos com fatos reais do usuário"
	);
	console.log("✓ Teste 3 passou: Injeção de contexto de menções validada!");

	// Teste 4: Prevenção de novas identidades fragmentadas com slug de pushname
	console.log("\n[TESTE 4] Prevenção de IDs canônicos 'user_<pushname>'...");
	const idJid = await memoryService.resolveCanonicalUserId(
		"whatsapp",
		"5511977778888@s.whatsapp.net",
		"jid",
		"NomeQualquer"
	);
	assert.strictEqual(idJid, "wa_5511977778888", `Esperado wa_5511977778888, obtido ${idJid}`);

	const idLid = await memoryService.resolveCanonicalUserId(
		"whatsapp",
		"999888777@lid",
		"lid",
		"NomeLid"
	);
	assert.strictEqual(idLid, "wa_lid_999888777", `Esperado wa_lid_999888777, obtido ${idLid}`);
	assert.ok(!idLid.startsWith("user_"), "ID canônico nunca mais deve começar com user_");
	console.log("✓ Teste 4 passou: Prevenção de novos IDs fragmentados confirmada!");

	console.log("\n=======================================================");
	console.log("TODOS OS TESTES FORAM EXECUTADOS E PASSARAM COM SUCESSO!");
	console.log("=======================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("\n❌ FALHA NO TESTE:", err);
		process.exit(1);
	});
