"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Database = require("../utils/Database");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const GeneralCommands = require("../functions/GeneralCommands");

async function runTests() {
	console.log("=== Iniciando testes de apelidos globais (SQLite) ===");

	const database = Database.getInstance({ testMode: false, disableBackup: true });

	const testUser = "5511999998888";
	const testUserJid = `${testUser}@s.whatsapp.net`;
	const testNick = "Mestre Supremo";

	// ---------------------------------------------------------
	// 1. Teste CRUD básico no Database / CoreRepository
	// ---------------------------------------------------------
	console.log("1. Testando CRUD de apelido global no Database...");
	// Limpeza prévia
	await database.saveGlobalNick(testUser, null);
	let current = await database.getGlobalNick(testUser);
	assert.strictEqual(current, null, "Deveria estar nulo após remoção");

	// Inserção
	const saved = await database.saveGlobalNick(testUser, testNick);
	assert.strictEqual(saved, true, "saveGlobalNick deveria retornar true");

	// Busca por número puro
	current = await database.getGlobalNick(testUser);
	assert.strictEqual(current, testNick, "Deveria retornar o apelido pelo número puro");

	// Busca por JID completo (@s.whatsapp.net)
	const currentByJid = await database.getGlobalNick(testUserJid);
	assert.strictEqual(
		currentByJid,
		testNick,
		"Deveria resolver o apelido mesmo consultando com JID completo"
	);

	// Listagem geral
	const all = await database.getAllGlobalNicks();
	assert.ok(typeof all === "object", "getAllGlobalNicks deve retornar um objeto");
	assert.strictEqual(all[testUser], testNick, "getAllGlobalNicks deve conter o usuário de teste");

	console.log("✓ CRUD no SQLite testado com sucesso!");

	// ---------------------------------------------------------
	// 2. Teste da hierarquia de apelidos (resolveUserNickname)
	// ---------------------------------------------------------
	console.log("2. Testando hierarquia de resolução de apelido...");

	const groupWithNick = {
		id: "grupo1@g.us",
		name: "Grupo 1",
		nicks: [{ numero: testUser, apelido: "Nick Local do Grupo" }]
	};

	const groupWithoutNick = {
		id: "grupo2@g.us",
		name: "Grupo 2",
		nicks: []
	};

	// 2.1: Grupo com nick local tem prioridade 1 (prevalece sobre o global)
	const resolvedPriority1 = await GeneralCommands.resolveUserNickname(
		groupWithNick,
		testUser,
		"NomePush"
	);
	assert.strictEqual(
		resolvedPriority1,
		"Nick Local do Grupo",
		"Apelido local do grupo deve ter precedência sobre global"
	);

	// 2.2: Grupo sem nick local deve herdar o nick global (Prioridade 2)
	const resolvedPriority2 = await GeneralCommands.resolveUserNickname(
		groupWithoutNick,
		testUser,
		"NomePush"
	);
	assert.strictEqual(
		resolvedPriority2,
		testNick,
		"Grupo sem nick local deve herdar o apelido global"
	);

	// 2.3: Usuário sem nick local e sem nick global deve herdar último grupo ou pushName
	const anotherUser = "5511777776666";
	await database.saveGlobalNick(anotherUser, null);
	const resolvedFallback = await GeneralCommands.resolveUserNickname(
		groupWithoutNick,
		anotherUser,
		"JogadorPush"
	);
	assert.strictEqual(
		resolvedFallback,
		"JogadorPush",
		"Sem apelido deve fazer fallback para fallbackName"
	);

	console.log("✓ Hierarquia de resolução testada com sucesso!");

	// ---------------------------------------------------------
	// 3. Teste do comando !apelido no PV
	// ---------------------------------------------------------
	console.log("3. Testando comandos de PV via EventHandler/FakeBot...");

	const bot = new FakeBot({ id: "bot-pv-test", testMode: false });
	database.testMode = false;
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	async function waitForCaptured(targetCount, maxMs = 5000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length >= targetCount) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 50));
		}
		return bot.capturedMessages;
	}

	// 3.1: Definir apelido no PV
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgSetPv = createMessage({
		author: testUser,
		authorName: "UsuarioPv",
		content: "!apelido Rei dos Magos",
		group: null
	});
	await eventHandler.processMessage(bot, msgSetPv);
	await waitForCaptured(1);

	const replySet = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(replySet, "Deveria ter recebido resposta do comando");
	assert.ok(
		replySet.content.includes("Apelido global definido: *Rei dos Magos*"),
		`Resposta esperada não encontrada: ${replySet.content}`
	);

	// Valida persistência no banco
	const nickInDb = await database.getGlobalNick(testUser);
	assert.strictEqual(nickInDb, "Rei dos Magos", "Apelido no SQLite deve ser 'Rei dos Magos'");

	// 3.2: Consultar apelido no PV
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgGetPv = createMessage({
		author: testUser,
		authorName: "UsuarioPv",
		content: "!apelido",
		group: null
	});
	await eventHandler.processMessage(bot, msgGetPv);
	await waitForCaptured(1);

	const replyGet = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(
		replyGet.content.includes("Seu apelido global atual é: *Rei dos Magos*"),
		`Consulta deve exibir o apelido global atual: ${replyGet?.content}`
	);

	// 3.3: Remover apelido no PV
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();
	const msgRemovePv = createMessage({
		author: testUser,
		authorName: "UsuarioPv",
		content: "!apelido remover",
		group: null
	});
	await eventHandler.processMessage(bot, msgRemovePv);
	await waitForCaptured(1);

	const replyRemove = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(
		replyRemove.content.includes("Apelido global removido com sucesso"),
		`Deveria confirmar remoção: ${replyRemove?.content}`
	);

	const nickAfterRemove = await database.getGlobalNick(testUser);
	assert.strictEqual(nickAfterRemove, null, "Deveria ser nulo após remoção via comando");

	console.log("✓ Comandos no PV testados com sucesso!");

	// ---------------------------------------------------------
	// 4. Teste de migração do arquivo legado global-nicks.json
	// ---------------------------------------------------------
	console.log("4. Testando auto-migração do arquivo legacy global-nicks.json...");
	const legacyPath = path.join(__dirname, "../../data/global-nicks.json");
	const legacyUser = "554298756604";
	const legacyNick = "cronos";

	// Cria arquivo temporário se não existir
	fs.writeFileSync(legacyPath, JSON.stringify({ [legacyUser]: legacyNick }, null, 2), "utf8");
	assert.ok(fs.existsSync(legacyPath), "Arquivo legado deve existir para o teste");

	// Aciona migração
	database.coreRepo._migrateLegacyGlobalNicks();

	// Verifica se foi removido
	assert.strictEqual(
		fs.existsSync(legacyPath),
		false,
		"Arquivo legado global-nicks.json deve ter sido excluído após migração"
	);

	// Verifica se os dados foram inseridos no SQLite
	const migratedNick = await database.getGlobalNick(legacyUser);
	assert.strictEqual(
		migratedNick,
		legacyNick,
		"Apelido 'cronos' deve ter sido migrado com sucesso para o SQLite"
	);

	console.log("✓ Auto-migração testada com sucesso!");

	// Limpeza do usuário de teste
	await database.saveGlobalNick(testUser, null);
	console.log("=== Todos os testes passaram com sucesso! ===");
}

runTests()
	.then(() => {
		process.exit(0);
	})
	.catch((err) => {
		console.error("Erro na execução dos testes:", err);
		process.exit(1);
	});
