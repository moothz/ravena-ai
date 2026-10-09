/**
 * Testes para o comando !g-regras, modelo Group, persistência e integração com !g-advertir
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Group = require("../models/Group");
const GroupMapper = require("../utils/db/mappers/GroupMapper");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Management = require("../commands/Management");
const { createMessage } = require("./FakeMessage");

async function main() {
	console.log("=== Iniciando testes de Regras do Grupo ===");

	// ---------------------------------------------------------------------------
	// 1. Modelo Group
	// ---------------------------------------------------------------------------
	console.log("1. Testando modelo Group...");
	const g1 = new Group({ id: "123@g.us" });
	assert.strictEqual(g1.regras, null, "Default de regras deve ser null");
	assert.strictEqual(g1.toJSON().regras, null, "toJSON deve conter regras: null");

	const g2 = new Group({ id: "123@g.us", regras: "Regra 1\nRegra 2" });
	assert.strictEqual(g2.regras, "Regra 1\nRegra 2", "Deve inicializar regras");
	assert.strictEqual(g2.toJSON().regras, "Regra 1\nRegra 2", "toJSON deve conter regras");

	g1.update({ regras: "Nova regra" });
	assert.strictEqual(g1.regras, "Nova regra", "update deve atualizar regras");
	console.log("✓ Modelo Group validado com sucesso");

	// ---------------------------------------------------------------------------
	// 2. GroupMapper (fromRow / toRow)
	// ---------------------------------------------------------------------------
	console.log("2. Testando GroupMapper...");
	const row = { id: "123@g.us", name: "teste", regras: "Regras do BD" };
	const mappedObj = GroupMapper.fromRow(row);
	assert.strictEqual(mappedObj.regras, "Regras do BD", "fromRow deve mapear regras");

	const toRowObj = GroupMapper.toRow(mappedObj);
	assert.strictEqual(toRowObj.regras, "Regras do BD", "toRow deve mapear regras");

	const toRowNull = GroupMapper.toRow({ id: "123@g.us", regras: null });
	assert.strictEqual(toRowNull.regras, null, "toRow deve tratar null");
	console.log("✓ GroupMapper validado com sucesso");

	// ---------------------------------------------------------------------------
	// 3. Management.handleGroupRules
	// ---------------------------------------------------------------------------
	console.log("3. Testando Management.handleGroupRules...");
	const fakeBot = new FakeBot({ id: "bot-test", prefix: "!" });
	const management = new Management();
	const group = new Group({
		id: "grupo1@g.us",
		name: "Grupo Teste",
		prefix: "!",
		additionalAdmins: ["5511999990001@s.whatsapp.net"]
	});

	// Mock database.saveGroup
	management.database = {
		saveGroup: async (g) => true
	};

	// 3.1. Sem regras e sem argumentos
	const msgSemArgsSemRegras = createMessage({
		author: "5511999990001@s.whatsapp.net",
		group: group.id,
		content: "!g-regras"
	});
	const ret1 = await management.handleGroupRules(fakeBot, msgSemArgsSemRegras, [], group);
	assert.ok(
		ret1.content.includes("Este grupo não possui regras cadastradas"),
		"Deve avisar que grupo não possui regras"
	);

	// 3.2. Definindo regras com quebra de linha e espaços
	const textoRegras = "1. Proibido spam\n2. Respeitar membros\n3. Sem links externos";
	const msgComRegras = createMessage({
		author: "5511999990001@s.whatsapp.net",
		group: group.id,
		content: `!g-regras ${textoRegras}`
	});
	const ret2 = await management.handleGroupRules(
		fakeBot,
		msgComRegras,
		textoRegras.split(/\s+/),
		group
	);
	assert.ok(
		ret2.content.includes("Regras do grupo atualizadas com sucesso"),
		"Deve confirmar atualização de regras"
	);
	assert.strictEqual(group.regras, textoRegras, "Regras devem preservar quebras de linha");

	// 3.3. Texto excedendo 5000 caracteres
	const textoLongo = "A".repeat(5050);
	const msgLongo = createMessage({
		author: "5511999990001@s.whatsapp.net",
		group: group.id,
		content: `!g-regras ${textoLongo}`
	});
	const ret3 = await management.handleGroupRules(fakeBot, msgLongo, [textoLongo], group);
	assert.strictEqual(group.regras.length, 5000, "Deve cortar exatamente em 5000 caracteres");
	assert.ok(
		ret3.content.includes("ultrapassou o limite máximo de 5000 caracteres e foi cortado"),
		"Deve avisar sobre o corte de caracteres"
	);

	// 3.4. Definindo regras em resposta a mensagem citada
	const quotedTexto = "Regras da mensagem citada:\n- Foco no tema";
	const msgComQuote = createMessage({
		author: "5511999990001@s.whatsapp.net",
		group: group.id,
		content: "!g-regras"
	});
	// Mock getQuotedMessage
	msgComQuote.origin.getQuotedMessage = async () => ({
		body: quotedTexto
	});

	const ret4 = await management.handleGroupRules(fakeBot, msgComQuote, [], group);
	assert.strictEqual(group.regras, quotedTexto, "Deve definir regras a partir da mensagem citada");
	assert.ok(
		ret4.content.includes("Regras do grupo atualizadas com sucesso"),
		"Deve confirmar sucesso ao citar mensagem"
	);

	// 3.5. Citando mensagem sem texto (ex: foto sem legenda)
	const msgQuoteSemTexto = createMessage({
		author: "5511999990001@s.whatsapp.net",
		group: group.id,
		content: "!g-regras"
	});
	msgQuoteSemTexto.origin.getQuotedMessage = async () => ({
		body: null,
		caption: null
	});
	const ret5 = await management.handleGroupRules(fakeBot, msgQuoteSemTexto, [], group);
	assert.ok(
		ret5.content.includes("precisa conter texto"),
		"Deve avisar que mensagem citada precisa conter texto"
	);

	// 3.6. Sem argumento quando regras estão definidas: exibe e remove regras
	group.regras = "Regras ativas antes de remover";
	const msgRemove = createMessage({
		author: "5511999990001@s.whatsapp.net",
		group: group.id,
		content: "!g-regras"
	});
	const ret6 = await management.handleGroupRules(fakeBot, msgRemove, [], group);
	assert.strictEqual(group.regras, null, "Deve zerar group.regras");
	assert.ok(
		ret6.content.includes("Regras anteriores do grupo:"),
		"Deve exibir as regras anteriores"
	);
	assert.ok(
		ret6.content.includes("Regras ativas antes de remover"),
		"Deve conter o texto das regras anteriores"
	);
	assert.ok(
		ret6.content.includes("As regras foram removidas do grupo"),
		"Deve informar que as regras foram removidas"
	);
	console.log("✓ Management.handleGroupRules validado com sucesso");

	// ---------------------------------------------------------------------------
	// 4. Integração com advertirUser (!g-advertir)
	// ---------------------------------------------------------------------------
	console.log("4. Testando g-advertir...");

	// 4.1. Sem regras definidas
	group.regras = null;
	const msgAdv1 = createMessage({
		author: "5511999990001@s.whatsapp.net",
		group: group.id,
		content: "!g-advertir @5511999990002"
	});
	msgAdv1.mentions = ["5511999990002@s.whatsapp.net"];

	const retAdv1 = await management.advertirUser(fakeBot, msgAdv1, ["@5511999990002"], group);
	assert.ok(
		retAdv1.content.includes("Respeitem as regras do grupo!"),
		"Deve manter mensagem padrão"
	);
	assert.ok(
		retAdv1.content.includes("> Os administradores podem cadastrar as regras usando !g-regras"),
		"Deve incluir dica com > para admins cadastrarem regras"
	);

	// 4.2. Com regras definidas
	group.regras = "1. Sem ofensas\n2. Sem spam";
	const msgAdv2 = createMessage({
		author: "5511999990001@s.whatsapp.net",
		group: group.id,
		content: "!g-advertir @5511999990002"
	});
	msgAdv2.mentions = ["5511999990002@s.whatsapp.net"];

	const retAdv2 = await management.advertirUser(fakeBot, msgAdv2, ["@5511999990002"], group);
	assert.ok(
		retAdv2.content.includes("📜 *Regras do Grupo:*\n1. Sem ofensas\n2. Sem spam"),
		"Deve exibir as regras do grupo"
	);
	assert.ok(
		!retAdv2.content.includes("Respeitem as regras do grupo!"),
		"NÃO deve exibir a mensagem genérica quando há regras definidas"
	);
	assert.ok(
		!retAdv2.content.includes("Os administradores podem cadastrar as regras"),
		"NÃO deve exibir a dica para cadastrar regras quando já estão definidas"
	);
	console.log("✓ g-advertir validado com sucesso");

	// ---------------------------------------------------------------------------
	// 5. Pipeline completo via EventHandler
	// ---------------------------------------------------------------------------
	console.log("5. Testando pipeline completo via EventHandler...");
	const eventHandler = new EventHandler();
	const bot = new FakeBot({ id: "bot-pipeline", prefix: "!" });

	const groupId = "grupo-pipeline@g.us";
	const adminId = "5511999990001@s.whatsapp.net";
	const groupData = await eventHandler.getOrCreateGroup(groupId, "Grupo Pipeline", "!");
	const groupDb = groupData.group;
	groupDb.additionalAdmins = [adminId];
	await eventHandler.database.saveGroup(groupDb);

	const msgPipeline = createMessage({
		author: adminId,
		group: groupId,
		content: "!g-regras Regra 1: Teste de Pipeline"
	});

	await eventHandler.processMessage(bot, msgPipeline);
	await new Promise((resolve) => setTimeout(resolve, 300));

	assert.ok(bot.capturedMessages.length > 0, "Deve capturar mensagem de resposta");
	assert.ok(
		bot.capturedMessages[0].content.includes("Regras do grupo atualizadas com sucesso"),
		"Deve confirmar atualização via EventHandler"
	);
	assert.strictEqual(
		groupDb.regras,
		"Regra 1: Teste de Pipeline",
		"groupDb.regras deve ter sido atualizado"
	);
	console.log("✓ Pipeline EventHandler validado com sucesso");

	console.log("=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
