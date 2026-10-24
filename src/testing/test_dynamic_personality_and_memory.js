const assert = require("assert");
const Group = require("../models/Group");
const GroupMapper = require("../utils/db/mappers/GroupMapper");
const Database = require("../utils/Database");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const Management = require("../commands/Management");
const MemoryService = require("../services/MemoryService");

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

async function runTests() {
	console.log("==========================================================");
	console.log("🧪 INICIANDO TESTES: PERSONALIDADE DINÂMICA & MEMÓRIA !IA");
	console.log("==========================================================");

	const database = Database.getInstance({ testMode: true });
	const bot = new FakeBot({ id: "test-bot" });
	const management = new Management();
	const memoryService = MemoryService.getInstance();

	// -------------------------------------------------------------------
	// 1. Testes do Modelo Group e GroupMapper
	// -------------------------------------------------------------------
	console.log("\n1. Testando Group Model e GroupMapper...");
	const defaultGroup = new Group({ id: "12345@g.us", name: "teste" });
	assert.strictEqual(
		defaultGroup.dinamicPersonality,
		true,
		"dinamicPersonality deve ser true por padrão"
	);

	const row = GroupMapper.toRow(defaultGroup);
	assert.strictEqual(
		row.dinamic_personality,
		1,
		"dinamic_personality deve ser 1 no mapeamento para banco"
	);

	const mappedBack = GroupMapper.fromRow({
		...row,
		json_data: JSON.stringify(defaultGroup)
	});
	assert.strictEqual(
		mappedBack.dinamicPersonality,
		true,
		"fromRow deve restaurar dinamicPersonality como true"
	);

	defaultGroup.update({ dinamicPersonality: false });
	assert.strictEqual(
		defaultGroup.dinamicPersonality,
		false,
		"update deve atualizar dinamicPersonality para false"
	);
	console.log("✓ Group Model e GroupMapper validados com sucesso!");

	// -------------------------------------------------------------------
	// 2. Testes de Comandos de Gerenciamento (!g-personalidadeDinamica e !g-setPersonalidade)
	// -------------------------------------------------------------------
	console.log("\n2. Testando comandos de gerenciamento de personalidade...");
	const testGroup = new Group({
		id: "testgroup-dynamic@g.us",
		name: "Grupo Dinamico Teste",
		dinamicPersonality: true,
		customAIPrompt: "Personalidade inicial gerada"
	});
	await database.saveGroup(testGroup);

	// Toggle: de true para false
	const msgToggle1 = createMessage({
		content: "!g-personalidadeDinamica",
		group: testGroup.id,
		author: "5511999990001@s.whatsapp.net"
	});
	const respToggle1 = await management.togglePersonalidadeDinamica(bot, msgToggle1, [], testGroup);
	assert(respToggle1.content.includes("DESATIVADA"), "Deve desativar quando era true");
	assert.strictEqual(testGroup.dinamicPersonality, false);

	// Toggle: de false para true
	const respToggle2 = await management.togglePersonalidadeDinamica(bot, msgToggle1, [], testGroup);
	assert(respToggle2.content.includes("ATIVADA"), "Deve ativar quando era false");
	assert.strictEqual(testGroup.dinamicPersonality, true);

	// Edição manual de personalidade deve forçar dinamicPersonality = false
	const msgManual = createMessage({
		content: "!g-setPersonalidade Você é um pirata engraçado",
		group: testGroup.id,
		author: "5511999990001@s.whatsapp.net"
	});
	const respManual = await management.setPersonalidadeIA(
		bot,
		msgManual,
		["Você", "é", "um", "pirata", "engraçado"],
		testGroup
	);
	assert(respManual.content.includes("pirata engraçado"));
	assert.strictEqual(
		testGroup.dinamicPersonality,
		false,
		"Edição manual deve desativar a personalidade dinâmica"
	);
	assert(respManual.content.includes("Personalidade dinâmica desativada"));
	console.log("✓ Comandos de gerenciamento e desativação automática validados com sucesso!");

	// -------------------------------------------------------------------
	// 3. Testes de Recuperação Estrita por canonical_user_id no getUser360
	// -------------------------------------------------------------------
	console.log("\n3. Testando getUser360 com busca estrita por canonical_user_id...");
	const testCanonicalId = "user_teste_estrito_123";
	await memoryService.database.dbRun(
		"memory",
		`INSERT OR REPLACE INTO memory_identities (canonical_user_id, platform, platform_id, id_type, display_name, created_at, updated_at)
		 VALUES (?, 'whatsapp', ?, 'pushname', 'Testador Estrito', ?, ?)`,
		[testCanonicalId, testCanonicalId, Date.now(), Date.now()]
	);

	await memoryService.addOrUpdateUserFact(
		testCanonicalId,
		"Testador oficial do sistema de inteligência",
		"general",
		"group",
		testGroup.id
	);

	const d360 = await memoryService.getUser360(testCanonicalId);
	assert(d360, "Deve retornar o dossiê 360 do usuário");
	assert.strictEqual(d360.canonical_user_id, testCanonicalId);
	assert.strictEqual(d360.display_name, "Testador Estrito");
	assert(
		d360.facts.some((f) => f.fact_text.includes("Testador oficial")),
		"Fato deve estar presente no dossiê"
	);
	console.log("✓ getUser360 determinístico por canonical_user_id validado!");

	// -------------------------------------------------------------------
	// 4. Testes de Contexto para Prompt (!ia e PV)
	// -------------------------------------------------------------------
	console.log("\n4. Testando getUserContextForPrompt e getGroupContextForPrompt...");
	const userPromptCtx = await memoryService.getUserContextForPrompt(
		testCanonicalId,
		"o que você sabe sobre mim?"
	);
	assert(userPromptCtx.includes("MEMÓRIA E FATOS SOBRE O INTERLOCUTOR"));
	assert(userPromptCtx.includes("Testador oficial"));

	// Contexto do grupo
	await memoryService.database.dbRun(
		"memory",
		`INSERT OR REPLACE INTO memory_group_profiles 
		 (group_id, platform, title, vibe_summary, frequent_topics, latest_summary, updated_at)
		 VALUES (?, 'whatsapp', 'Grupo Teste', 'Zoeiro e focado em games', '["Games", "CS"]', 'Membros jogando', ?)`,
		[testGroup.id, Date.now()]
	);

	const groupPromptCtx = await memoryService.getGroupContextForPrompt(testGroup.id);
	assert(groupPromptCtx.includes("CONTEXTO VIVO DO GRUPO"));
	assert(groupPromptCtx.includes("Zoeiro e focado em games"));
	assert(groupPromptCtx.includes("Games, CS"));
	console.log("✓ Injeção de contexto de usuário e grupo validada com sucesso!");

	console.log("\n==========================================================");
	console.log("🎉 TODOS OS TESTES PASSARAM COM SUCESSO!");
	console.log("==========================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ FALHA NO TESTE:", err);
		process.exit(1);
	});
