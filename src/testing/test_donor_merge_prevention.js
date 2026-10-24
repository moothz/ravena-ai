process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const MemoryService = require("../services/MemoryService");

async function main() {
	console.log("=== Iniciando Testes de Prevenção e Merge Automático de Novos Doadores ===");

	const db = Database.getInstance();
	const memoryService = MemoryService.getInstance();

	const testPhone = "5511999998877";
	const testCanonical = `wa_${testPhone}`;
	const testDonorName = "Novo Doador VIP";
	const testSlug = "user_novodoadorvip";

	// 1. Simula que antes de doar, o usuário mandou mensagens e teve fatos salvos sob um slug de pushname
	console.log("\n1. Simulando fatos gerados antes da doação...");
	await db.dbRun(
		"memory",
		`INSERT INTO memory_user_facts (canonical_user_id, fact_text, category, confidence, source_type, extracted_at, last_confirmed_at)
		 VALUES (?, 'Gosta de jogar xadrez e programar em Go', 'hobby', 1.0, 'group', ?, ?)`,
		[testSlug, Date.now(), Date.now()]
	);

	await db.dbRun(
		"memory",
		`INSERT INTO memory_message_buffer (target_id, is_pv, author_id, canonical_user_id, author_name, text_content, timestamp)
		 VALUES ('120363@g.us', 0, ?, ?, ?, 'Olá, sou programador Go!', ?)`,
		[testPhone, testSlug, testDonorName, Date.now()]
	);

	// 2. Testa resolveCanonicalUserId com número de WhatsApp puro (sem @s.whatsapp.net)
	console.log("\n2. Testando resolveCanonicalUserId com número puro...");
	const resolvedFromPhone = await memoryService.resolveCanonicalUserId(
		"whatsapp",
		testPhone,
		"other",
		testDonorName
	);
	assert.strictEqual(
		resolvedFromPhone,
		testCanonical,
		`resolveCanonicalUserId com número puro deve retornar '${testCanonical}', mas retornou '${resolvedFromPhone}'`
	);
	console.log(
		`✓ resolveCanonicalUserId retornou corretamente '${resolvedFromPhone}' para número puro!`
	);

	// 3. Testa syncDonor diretamente (simulando nova doação sendo adicionada)
	console.log("\n3. Testando syncDonor para novo doador...");
	await memoryService.syncDonor(testDonorName, testPhone);

	// Verifica se os fatos foram migrados para testCanonical
	const facts = await db.dbAll(
		"memory",
		"SELECT fact_text FROM memory_user_facts WHERE canonical_user_id = ?",
		[testCanonical]
	);
	assert.ok(
		facts && facts.length > 0,
		"Fatos anteriores devem ter sido migrados para wa_<telefone>"
	);
	assert.ok(
		facts[0].fact_text.includes("xadrez"),
		"O fato de xadrez deve estar no novo canonical_user_id"
	);
	console.log(`✓ Fatos migrados com sucesso para '${testCanonical}':`, facts[0].fact_text);

	// 4. Testa getUser360 para o novo doador
	console.log("\n4. Testando getUser360 pós-doação...");
	const user360 = await memoryService.getUser360(testPhone);
	assert.ok(user360, "getUser360 deve encontrar o usuário");
	assert.strictEqual(user360.canonical_user_id, testCanonical);
	assert.ok(user360.facts.length > 0, "Dossiê 360 deve conter os fatos migrados");
	console.log("✓ getUser360 retornou Dossiê 360 consolidado com sucesso!");

	// 5. Limpeza dos dados de teste
	console.log("\n5. Limpando dados do teste...");
	await db.dbRun(
		"memory",
		"DELETE FROM memory_user_facts WHERE canonical_user_id = ? OR canonical_user_id = ?",
		[testCanonical, testSlug]
	);
	await db.dbRun("memory", "DELETE FROM memory_message_buffer WHERE author_id = ?", [testPhone]);
	await db.dbRun(
		"memory",
		"DELETE FROM memory_identities WHERE canonical_user_id = ? OR canonical_user_id = ?",
		[testCanonical, testSlug]
	);

	console.log("\n=== Todos os testes de prevenção passaram com 100% de sucesso! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO nos testes de prevenção:", err);
		process.exit(1);
	});
