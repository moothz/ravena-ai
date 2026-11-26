process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

process.env.SUPER_ADMINS = "5511999990002";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("../utils/Database");
const MemoryService = require("../services/MemoryService");
const ProfilePictureHelper = require("../utils/ProfilePictureHelper");
const { createMessage } = require("./FakeMessage");

const PESSOA = "5511999990001";
const CRIADOR = "5511999990002";

async function semearFato(db, canonicalId, texto) {
	const agora = Date.now();
	await db.dbRun(
		"memory",
		`INSERT INTO memory_user_facts (canonical_user_id, fact_text, category, confidence, source_type, extracted_at, last_confirmed_at)
		 VALUES (?, ?, 'general', 1.0, 'group', ?, ?)`,
		[canonicalId, texto, agora, agora]
	);
	await db.dbRun(
		"memory",
		"UPDATE memory_identities SET facts_count = facts_count + 1, last_fact_at = ? WHERE canonical_user_id = ?",
		[agora, canonicalId]
	);
}

async function semear(db, memoryService) {
	for (let i = 0; i < 2; i++) {
		await memoryService.resolveCanonicalUserId(
			"whatsapp",
			`${PESSOA}@s.whatsapp.net`,
			"jid",
			"Pessoa Ficticia"
		);
	}
	for (let i = 1; i <= 5; i++) {
		await semearFato(db, `wa_${PESSOA}`, `Gosta do assunto fictício ${i}`);
	}
	await memoryService.resolveCanonicalUserId(
		"whatsapp",
		`${CRIADOR}@s.whatsapp.net`,
		"jid",
		"Criador Ficticio"
	);
	await semearFato(
		db,
		`wa_${CRIADOR}`,
		`É o criador e desenvolvedor da Ravena, contato ${CRIADOR}`
	);
}

async function runTests() {
	console.log("=== INICIANDO TESTES DE UNIFICAÇÃO DE IDENTIDADES E MENÇÕES ===");
	const db = Database.getInstance({ testMode: false, disableBackup: true });
	db.databasePath = fs.mkdtempSync(path.join(os.tmpdir(), "ravena-identidade-"));
	db.backupPath = path.join(db.databasePath, "backups");
	db.mappers.databasePath = db.databasePath;
	db.ensureDirectories();
	process.on("exit", () => fs.rmSync(db.databasePath, { recursive: true, force: true }));
	const memoryService = MemoryService.getInstance();
	await semear(db, memoryService);

	// Teste 1: Pessoa Ficticia consolidado em 1 único card 360
	console.log("\n[TESTE 1] Verificando Pessoa Ficticia no searchUsers e getUser360...");
	const pessoaSearch = await memoryService.searchUsers("Pessoa Ficticia");
	assert.strictEqual(
		pessoaSearch.length,
		1,
		`Esperado exatamente 1 resultado para Pessoa Ficticia, obtido ${pessoaSearch.length}`
	);
	assert.strictEqual(
		pessoaSearch[0].canonical_user_id,
		"wa_5511999990001",
		`ID canônico esperado wa_5511999990001, obtido ${pessoaSearch[0].canonical_user_id}`
	);
	assert.ok(
		pessoaSearch[0].facts_count >= 5,
		`Esperado ao menos 5 fatos para Pessoa Ficticia, obtido ${pessoaSearch[0].facts_count}`
	);

	const pessoa360 = await memoryService.getUser360("wa_5511999990001");
	assert.ok(pessoa360, "getUser360(wa_5511999990001) não deve ser nulo");
	assert.strictEqual(pessoa360.display_name, "Pessoa Ficticia");
	const porNome = await memoryService.resolveCanonicalUserId(
		"whatsapp",
		"pessoaficticia",
		"other",
		"Pessoa Ficticia"
	);
	assert.strictEqual(porNome, `wa_${PESSOA}`, "Pushname repetido não pode criar outra identidade");
	console.log("✓ Teste 1 passou: Pessoa Ficticia unificado com sucesso!");

	// Teste 2: moothz e privacidade estrita dos Super Admins
	console.log("\n[TESTE 2] Verificando contas do Criador (SUPER_ADMINS) e regra de privacidade...");
	const adminPhones = memoryService.getSuperAdminPhones();
	assert.ok(
		adminPhones.length > 0,
		"Deve haver ao menos um Super Admin configurado em SUPER_ADMINS"
	);

	for (const phone of adminPhones) {
		const dossie = await memoryService.getUser360(`wa_${phone}`);
		assert.ok(dossie?.facts?.length > 0, `Conta wa_${phone} deve ter fatos no dossiê`);
		const hasCreatorFact = dossie.facts.some((f) =>
			f.fact_text.includes("criador e desenvolvedor")
		);
		assert.ok(hasCreatorFact, `Conta wa_${phone} deve conter fato de criador`);

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
		content: "!ia o que você acha do @5511999990001?",
		author: "5511999999999@s.whatsapp.net",
		group: "120363000000000000@g.us",
		origin: {
			mentionedIds: ["5511999990001@s.whatsapp.net"]
		}
	});

	const mentions = ProfilePictureHelper.extractMentions(fakeMsg, []);
	assert.strictEqual(mentions.length, 1, "Deve extrair 1 menção");
	assert.strictEqual(mentions[0], "5511999990001@s.whatsapp.net");

	const mentionedCtx = await memoryService.getUserContextForPrompt(
		mentions[0],
		"o que você acha",
		"USUÁRIO MENCIONADO"
	);
	assert.ok(
		mentionedCtx.includes("[MEMÓRIA E FATOS SOBRE O USUÁRIO MENCIONADO (Pessoa Ficticia)]"),
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
		"5511999990003@s.whatsapp.net",
		"jid",
		"NomeQualquer"
	);
	assert.strictEqual(idJid, "wa_5511999990003", `Esperado wa_5511999990003, obtido ${idJid}`);

	const idLid = await memoryService.resolveCanonicalUserId(
		"whatsapp",
		"120363000000099@lid",
		"lid",
		"NomeLid"
	);
	assert.strictEqual(
		idLid,
		"wa_lid_120363000000099",
		`Esperado wa_lid_120363000000099, obtido ${idLid}`
	);
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
