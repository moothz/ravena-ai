/**
 * Testes Automatizados do Ravena Memory Engine (RME)
 * Executado dentro do container Docker ravena-ai
 */
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const EmbeddingService = require("../services/EmbeddingService");
const MemoryService = require("../services/MemoryService");

async function runTests() {
	console.log("==========================================================");
	console.log("🧠 INICIANDO TESTES DO RAVENA MEMORY ENGINE (RME)");
	console.log("==========================================================\n");

	const embeddingService = EmbeddingService.getInstance();
	const memoryService = MemoryService.getInstance();
	const bot = new FakeBot({ id: "test-bot", dossieGroups: "dossie@g.us" });

	// 1. Testes do EmbeddingService
	console.log("1. Testando EmbeddingService e vetores...");
	const testVecA = new Float32Array([1.0, 0.0, 0.5]);
	const testVecB = new Float32Array([1.0, 0.0, 0.5]);
	const testVecC = new Float32Array([0.0, 1.0, 0.0]);

	const simIdentity = embeddingService.cosineSimilarity(testVecA, testVecB);
	assert.ok(Math.abs(simIdentity - 1.0) < 0.001, "Similaridade de vetores idênticos deve ser 1.0");

	const simOrthogonal = embeddingService.cosineSimilarity(testVecA, testVecC);
	assert.strictEqual(simOrthogonal, 0, "Similaridade de vetores ortogonais deve ser 0.0");

	const buffer = embeddingService.vectorToBuffer(testVecA);
	assert.ok(Buffer.isBuffer(buffer), "vectorToBuffer deve retornar Buffer");
	assert.strictEqual(buffer.length, 3 * 4, "Buffer deve ter 12 bytes para 3 floats");

	const reconstructed = embeddingService.bufferToVector(buffer);
	assert.strictEqual(reconstructed.length, 3, "bufferToVector deve reconstruir array de 3 floats");
	assert.strictEqual(reconstructed[0], 1.0, "Primeiro float deve ser 1.0");
	assert.strictEqual(reconstructed[2], 0.5, "Terceiro float deve ser 0.5");
	console.log("✓ EmbeddingService math e conversões de buffer OK!");

	// 2. Testes de Resolução de Identidades (LID <-> JID)
	console.log("\n2. Testando resolução de identidades...");
	const jid = "5511999990001@s.whatsapp.net";
	const lid = "120363000000001@lid";

	const canonJid = await memoryService.resolveCanonicalUserId(
		"whatsapp",
		jid,
		"jid",
		"Marcos Teste"
	);
	assert.strictEqual(canonJid, "wa_5511999990001", "Canonical ID do JID deve ser wa_5511999990001");

	// Vincula LID ao mesmo JID
	await memoryService.linkLidToPn(lid, jid, "Marcos Teste");

	const canonLid = await memoryService.resolveCanonicalUserId("whatsapp", lid, "lid");
	assert.strictEqual(
		canonLid,
		"wa_5511999990001",
		"LID vinculado deve resolver para o mesmo canonical ID wa_5511999990001"
	);
	console.log("✓ Resolução de identidades e vinculação LID <-> JID OK!");

	// 3. Teste de Ingestão de Mensagens (Grupo e PV)
	console.log("\n3. Testando ingestão de mensagens...");
	const testGroupId = "120363999999999@g.us";

	const msgGroup = createMessage({
		group: testGroupId,
		author: jid,
		authorName: "Marcos Teste",
		content: "Estou jogando Counter-Strike hoje a noite!",
		type: "text"
	});

	await memoryService.ingestMessage(bot, msgGroup);

	// Verifica se a mensagem entrou no buffer
	const bufferRows = await memoryService.database.dbAll(
		"memory",
		"SELECT * FROM memory_message_buffer WHERE target_id = ?",
		[testGroupId]
	);
	assert.ok(bufferRows && bufferRows.length > 0, "Mensagem de grupo deve estar no buffer");
	assert.strictEqual(bufferRows[0].canonical_user_id, "wa_5511999990001");
	assert.strictEqual(bufferRows[0].author_name, "Marcos Teste");
	assert.strictEqual(bufferRows[0].is_pv, 0, "is_pv deve ser 0 para grupo");

	// Ingestão no PV
	const msgPv = createMessage({
		group: null,
		author: jid,
		authorName: "Marcos Teste",
		content: "No privado eu gosto de conversar sobre pescaria.",
		type: "text"
	});

	await memoryService.ingestMessage(bot, msgPv);

	const bufferPvRows = await memoryService.database.dbAll(
		"memory",
		"SELECT * FROM memory_message_buffer WHERE target_id = ? AND is_pv = 1",
		[jid]
	);
	assert.ok(
		bufferPvRows && bufferPvRows.length > 0,
		"Mensagem de PV deve estar no buffer com is_pv = 1"
	);
	console.log("✓ Ingestão no buffer de Grupo e PV OK!");

	// 4. Teste de Fatos Semânticos e Memória Global
	console.log("\n4. Testando persistência de fatos semânticos e User 360...");
	await memoryService.addOrUpdateUserFact(
		"wa_5511999990001",
		"Trabalha consertando computadores e joga CS",
		"work",
		"group",
		testGroupId
	);

	await memoryService.addOrUpdateUserFact(
		"wa_5511999990001",
		"Torce pro Palmeiras e odeia que zoem derrotas",
		"hobby",
		"pv",
		jid
	);

	const user360 = await memoryService.getUser360("wa_5511999990001");
	assert.ok(user360, "getUser360 deve retornar objeto");
	assert.strictEqual(user360.canonical_user_id, "wa_5511999990001");
	assert.ok(user360.facts.length >= 2, "Usuário deve ter pelo menos 2 fatos memorizados");
	assert.ok(
		user360.facts.some((f) => f.fact_text.includes("Palmeiras")),
		"Fato do PV deve estar presente no perfil global"
	);
	assert.ok(
		user360.facts.some((f) => f.fact_text.includes("computadores")),
		"Fato do grupo deve estar presente"
	);
	console.log("✓ Fatos semânticos globais e User 360 consolidados com sucesso!");

	// 5. Teste do Rolling Summary e Contexto de Interação
	console.log("\n5. Testando Rolling Summary e Contexto de Interação...");
	// Insere um perfil de grupo com resumo prévio
	await memoryService.database.dbRun(
		"memory",
		`INSERT OR REPLACE INTO memory_group_profiles 
		 (group_id, platform, title, vibe_summary, latest_summary, last_summarized_at, messages_since_summary, total_messages_analyzed, average_problematic_score, updated_at)
		 VALUES (?, 'whatsapp', 'Grupo dos Amigos', 'descontraído e brincalhão', 'Resumo prévio das conversas sobre tecnologia.', ?, 2, 1, 0, ?)`,
		[testGroupId, Date.now(), Date.now()]
	);

	const hotSummary = await memoryService.getRollingSummary(testGroupId, bot);
	assert.strictEqual(
		hotSummary,
		"Resumo prévio das conversas sobre tecnologia.",
		"Rolling summary recente deve entregar cache quente instantâneo"
	);

	const interactionContext = await memoryService.getInteractionContext(testGroupId);
	assert.ok(
		interactionContext.recentFormatted.includes("Counter-Strike"),
		"Contexto deve conter mensagem recente"
	);
	assert.strictEqual(
		interactionContext.groupVibe,
		"descontraído e brincalhão",
		"Contexto deve conter vibe do grupo"
	);
	assert.ok(
		interactionContext.speakerFacts.length > 0,
		"Contexto deve conter fatos dos participantes que falaram"
	);
	console.log("✓ Rolling Summary quente e Contexto de Interação validados com sucesso!");

	console.log("\n==========================================================");
	console.log("🎉 TODOS OS TESTES DO RAVENA MEMORY ENGINE PASSARAM!");
	console.log("==========================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro nos testes do RME:", err);
		process.exit(1);
	});
