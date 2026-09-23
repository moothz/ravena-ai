process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Database = require("../utils/Database");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log(
		"--- Iniciando testes de !relacionamento, !separar (por número/id/telefone) e !celibar ---"
	);

	const bot = new FakeBot({ id: "teste-bot", grupoLogs: "123@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.loadAllCommands();
	const database = Database.getInstance();

	const testGroup = "120363888888888888@g.us";
	const userAJid = "5511999990001@s.whatsapp.net";
	const userBJid = "5511999990002@s.whatsapp.net";
	const userCJid = "5511999990003@s.whatsapp.net";
	const userA = "5511999990001";
	const userB = "5511999990002";
	const userC = "5511999990003";

	// Limpar dados anteriores do grupo de teste
	await database.dbRun("relacionamentos", "DELETE FROM relacionamentos WHERE group_id = ?", [
		testGroup
	]);

	// Desativa debounce durante os testes
	eventHandler.commandHandler.cmdDebounceTime = 0;

	// 1. Usuário sem relacionamentos tenta celibar
	console.log("Teste 1: Usuário sem relacionamentos tenta !celibar...");
	const msgCelibarVazio = createMessage({
		content: "!celibar",
		group: testGroup,
		author: userAJid,
		authorName: "UsuarioA"
	});
	await eventHandler.commandHandler.processCommand(bot, msgCelibarVazio, "celibar", [], null);

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 resposta");
	assert.ok(
		bot.capturedMessages[0].content.includes("involuntário"),
		"Deveria avisar que celibato já era involuntário"
	);
	console.log("✓ Teste 1 passou.");
	bot.resetCapture();

	// 2. Criar 2 relacionamentos ativos para UserA: um com UserB (namoro) e um com UserC (casamento)
	console.log("Teste 2: Inserir relacionamentos e testar !relacionamento e !relacionamentos...");
	const now = Date.now();
	await database.dbRun(
		"relacionamentos",
		`INSERT INTO relacionamentos (group_id, user1, user2, user1_jid, user2_jid, tipo, status, criado_em, coisas_count, traicoes_count)
		 VALUES (?, ?, ?, ?, ?, 'namoro', 'ativo', ?, 3, 0)`,
		[testGroup, userA, userB, userAJid, userBJid, now - 100000]
	);
	await database.dbRun(
		"relacionamentos",
		`INSERT INTO relacionamentos (group_id, user1, user2, user1_jid, user2_jid, tipo, status, criado_em, coisas_count, traicoes_count)
		 VALUES (?, ?, ?, ?, ?, 'casamento', 'ativo', ?, 10, 1)`,
		[testGroup, userA, userC, userAJid, userCJid, now]
	);

	// Testar !relacionamento
	const msgRel = createMessage({
		content: "!relacionamento",
		group: testGroup,
		author: userAJid,
		authorName: "UsuarioA"
	});
	await eventHandler.commandHandler.processCommand(bot, msgRel, "relacionamento", [], null);

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 resposta");
	const relContent = bot.capturedMessages[0].content;
	assert.ok(
		relContent.includes("Relacionamentos Ativos (2):"),
		"Deveria listar 2 relacionamentos ativos"
	);
	assert.ok(relContent.includes("1."), "Deveria conter número 1.");
	assert.ok(relContent.includes("2."), "Deveria conter número 2.");
	assert.ok(relContent.includes(userB), "Deveria exibir número de UserB");
	assert.ok(relContent.includes(userC), "Deveria exibir número de UserC");
	assert.ok(relContent.includes("!separar 1"), "Deveria instruir uso de !separar 1");
	assert.ok(relContent.includes("!separar 2"), "Deveria instruir uso de !separar 2");
	assert.ok(relContent.includes("!celibar"), "Deveria mencionar !celibar");
	console.log("✓ Teste 2a passou: !relacionamento lista e numera os relacionamentos corretamente.");
	bot.resetCapture();

	// Testar !relacionamentos (grupo)
	const msgRels = createMessage({
		content: "!relacionamentos",
		group: testGroup,
		author: userAJid,
		authorName: "UsuarioA"
	});
	await eventHandler.commandHandler.processCommand(bot, msgRels, "relacionamentos", [], null);
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 resposta");
	const relsContent = bot.capturedMessages[0].content;
	assert.ok(relsContent.includes(userB), "Deveria exibir número de telefone no resumo do grupo");
	console.log("✓ Teste 2b passou: !relacionamentos exibe os relacionamentos do grupo.");
	bot.resetCapture();

	// 3. Usuário com 2 relacionamentos roda !separar sem argumentos
	console.log("Teste 3: !separar sem argumentos quando há múltiplos relacionamentos...");
	const msgSepararSemArgs = createMessage({
		content: "!separar",
		group: testGroup,
		author: userAJid,
		authorName: "UsuarioA"
	});
	await eventHandler.commandHandler.processCommand(bot, msgSepararSemArgs, "separar", [], null);
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 resposta");
	assert.ok(
		bot.capturedMessages[0].content.includes("possui 2 relacionamentos"),
		"Deveria avisar que possui 2 relacionamentos e pedir para especificar"
	);
	assert.ok(bot.capturedMessages[0].content.includes("!separar 1"));
	console.log("✓ Teste 3 passou.");
	bot.resetCapture();

	// 4. Usuário separa usando o número "1" da lista
	console.log("Teste 4: !separar 1 usando índice da lista...");
	const msgSeparar1 = createMessage({
		content: "!separar 1",
		group: testGroup,
		author: userAJid,
		authorName: "UsuarioA"
	});
	await eventHandler.commandHandler.processCommand(bot, msgSeparar1, "separar", ["1"], null);
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 resposta");
	assert.ok(
		bot.capturedMessages[0].content.includes("FIM DE RELACIONAMENTO"),
		"Deveria confirmar o fim de relacionamento"
	);
	console.log("✓ Teste 4 passou.");
	bot.resetCapture();

	// Verificar no banco que restou apenas 1 relacionamento ativo
	const activeAfter1 = await database.dbAll(
		"relacionamentos",
		"SELECT * FROM relacionamentos WHERE group_id = ? AND (user1 = ? OR user2 = ?) AND status = 'ativo'",
		[testGroup, userA, userA]
	);
	assert.strictEqual(activeAfter1.length, 1, "Deve restar exatamente 1 relacionamento ativo");

	// 5. Usuário com apenas 1 relacionamento ativo roda !separar sem argumentos
	console.log("Teste 5: !separar sem argumentos quando há apenas 1 relacionamento ativo...");
	const msgSepararUnico = createMessage({
		content: "!separar",
		group: testGroup,
		author: userAJid,
		authorName: "UsuarioA"
	});
	await eventHandler.commandHandler.processCommand(bot, msgSepararUnico, "separar", [], null);
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 resposta");
	assert.ok(
		bot.capturedMessages[0].content.includes("FIM DE RELACIONAMENTO"),
		"Deveria separar automaticamente do único relacionamento ativo"
	);
	console.log("✓ Teste 5 passou.");
	bot.resetCapture();

	const activeAfter2 = await database.dbAll(
		"relacionamentos",
		"SELECT * FROM relacionamentos WHERE group_id = ? AND (user1 = ? OR user2 = ?) AND status = 'ativo'",
		[testGroup, userA, userA]
	);
	assert.strictEqual(activeAfter2.length, 0, "Não deve restar nenhum relacionamento ativo");

	// 6. Testar separação por número de telefone (pessoa saiu do grupo)
	console.log("Teste 6: !separar por número de telefone direto sem menção...");
	await database.dbRun(
		"relacionamentos",
		`INSERT INTO relacionamentos (group_id, user1, user2, user1_jid, user2_jid, tipo, status, criado_em)
		 VALUES (?, ?, ?, ?, ?, 'namoro', 'ativo', ?)`,
		[testGroup, userA, userB, userAJid, userBJid, Date.now()]
	);

	const msgSepararTel = createMessage({
		content: `!separar ${userB}`,
		group: testGroup,
		author: userAJid,
		authorName: "UsuarioA"
	});
	await eventHandler.commandHandler.processCommand(bot, msgSepararTel, "separar", [userB], null);
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 resposta");
	assert.ok(
		bot.capturedMessages[0].content.includes("FIM DE RELACIONAMENTO"),
		"Deveria separar usando número de telefone"
	);
	console.log("✓ Teste 6 passou.");
	bot.resetCapture();

	// 7. Testar !celibar acabando com múltiplos relacionamentos
	console.log("Teste 7: !celibar com múltiplos relacionamentos ativos...");
	await database.dbRun(
		"relacionamentos",
		`INSERT INTO relacionamentos (group_id, user1, user2, user1_jid, user2_jid, tipo, status, criado_em)
		 VALUES (?, ?, ?, ?, ?, 'namoro', 'ativo', ?)`,
		[testGroup, userA, userB, userAJid, userBJid, Date.now()]
	);
	await database.dbRun(
		"relacionamentos",
		`INSERT INTO relacionamentos (group_id, user1, user2, user1_jid, user2_jid, tipo, status, criado_em)
		 VALUES (?, ?, ?, ?, ?, 'casamento', 'ativo', ?)`,
		[testGroup, userA, userC, userAJid, userCJid, Date.now()]
	);

	const msgCelibar = createMessage({
		content: "!celibar",
		group: testGroup,
		author: userAJid,
		authorName: "UsuarioA"
	});
	await eventHandler.commandHandler.processCommand(bot, msgCelibar, "celibar", [], null);
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 resposta");
	const celibarResp = bot.capturedMessages[0].content;
	assert.ok(
		celibarResp.includes("aderiu ao celibato e abandonou"),
		"Resposta do celibar deve conter frase engraçada solicitada"
	);
	assert.ok(celibarResp.includes(userB), "Deve mencionar UserB");
	assert.ok(celibarResp.includes(userC), "Deve mencionar UserC");

	const activeAfterCelibar = await database.dbAll(
		"relacionamentos",
		"SELECT * FROM relacionamentos WHERE group_id = ? AND (user1 = ? OR user2 = ?) AND status = 'ativo'",
		[testGroup, userA, userA]
	);
	assert.strictEqual(
		activeAfterCelibar.length,
		0,
		"Todos os relacionamentos devem ter sido encerrados"
	);
	console.log("✓ Teste 7 passou.");
	bot.resetCapture();

	// Limpeza final do grupo de teste
	await database.dbRun("relacionamentos", "DELETE FROM relacionamentos WHERE group_id = ?", [
		testGroup
	]);
	console.log("--- TODOS OS TESTES PASSARAM COM SUCESSO! ---");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro no teste:", err);
		process.exit(1);
	});
