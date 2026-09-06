const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Database = require("../utils/Database");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("--- Iniciando testes de !pesca-abandonar ---");

	const bot = new FakeBot({ id: "teste-bot", grupoLogs: "123@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.loadAllCommands();
	const database = Database.getInstance();
	const testUser = "5511999999999@s.whatsapp.net";
	const testGroup = "120363000000000000@g.us";

	// Desativa debounce durante os testes
	eventHandler.commandHandler.cmdDebounceTime = 0;

	// 1. Usuário sem peixes tenta abandonar
	const msg1 = createMessage({
		content: "!pesca-abandonar",
		group: testGroup,
		author: testUser,
		authorName: "PescadorTeste"
	});
	await eventHandler.commandHandler.processCommand(bot, msg1, "pesca-abandonar", [], null);

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 mensagem");
	assert.ok(
		bot.capturedMessages[0].content.includes("vazio"),
		"Deveria avisar que o inventário está vazio"
	);
	console.log("✓ Teste 1 passou: Inventário vazio tratado corretamente.");
	bot.resetCapture();

	// 2. Adiciona peixes ao inventário do usuário no banco SQLite
	await database.dbRun(
		"fishing",
		`INSERT OR REPLACE INTO fishing_users 
		(user_id, name, baits, last_bait_regen, total_weight, inventory_weight, total_catches, total_baits_used, total_trash_caught, biggest_fish_json)
		VALUES (?, ?, 5, ?, 50.5, 50.5, 2, 2, 0, NULL)`,
		[testUser, "PescadorTeste", Date.now()]
	);

	await database.dbRun(
		"fishing",
		`INSERT INTO fishing_inventory (user_id, name, weight, is_rare, timestamp, emoji, data_json)
		VALUES (?, 'Tilápia', 20.5, 0, ?, '🐟', '{}')`,
		[testUser, Date.now()]
	);
	await database.dbRun(
		"fishing",
		`INSERT INTO fishing_inventory (user_id, name, weight, is_rare, timestamp, emoji, data_json)
		VALUES (?, 'Dourado', 30.0, 1, ?, '✨', '{}')`,
		[testUser, Date.now()]
	);

	const initialFishes = await database.dbAll(
		"fishing",
		"SELECT * FROM fishing_inventory WHERE user_id = ?",
		[testUser]
	);
	assert.strictEqual(initialFishes.length, 2, "Deveriam existir 2 peixes inseridos");

	// 3. Primeira execução de !pesca-abandonar (solicitação de confirmação)
	const msg2 = createMessage({
		content: "!pesca-abandonar",
		group: testGroup,
		author: testUser,
		authorName: "PescadorTeste"
	});
	await eventHandler.commandHandler.processCommand(bot, msg2, "pesca-abandonar", [], null);

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 mensagem de confirmação");
	const confirmText = bot.capturedMessages[0].content;
	assert.ok(confirmText.includes("Tilápia"), "Mensagem deve listar a Tilápia");
	assert.ok(confirmText.includes("Dourado"), "Mensagem deve listar o Dourado");
	assert.ok(confirmText.includes("50.50 kg"), "Mensagem deve mostrar o peso total");
	assert.ok(confirmText.includes("1 minuto"), "Mensagem deve mencionar o tempo de 1 minuto");
	assert.ok(
		confirmText.includes("!pesca-abandonar"),
		"Mensagem deve instruir a enviar !pesca-abandonar"
	);

	// Verifica se os peixes ainda existem no banco antes de confirmar
	const fishesBeforeConfirm = await database.dbAll(
		"fishing",
		"SELECT * FROM fishing_inventory WHERE user_id = ?",
		[testUser]
	);
	assert.strictEqual(
		fishesBeforeConfirm.length,
		2,
		"Peixes NÃO devem ser deletados antes da confirmação"
	);
	console.log("✓ Teste 2 passou: Primeira chamada exibe inventário e pede confirmação.");
	bot.resetCapture();

	// 4. Segunda execução de !pesca-abandonar dentro de 1 minuto (confirmação efetuada)
	const msg3 = createMessage({
		content: "!pesca-abandonar",
		group: testGroup,
		author: testUser,
		authorName: "PescadorTeste"
	});
	await eventHandler.commandHandler.processCommand(bot, msg3, "pesca-abandonar", [], null);

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 mensagem de sucesso");
	const successText = bot.capturedMessages[0].content;
	assert.ok(
		successText.includes("abandonados") || successText.includes("Esvaziado"),
		"Mensagem deve confirmar que os peixes foram abandonados"
	);

	// Verifica se o inventário foi limpo no banco
	const fishesAfterConfirm = await database.dbAll(
		"fishing",
		"SELECT * FROM fishing_inventory WHERE user_id = ?",
		[testUser]
	);
	assert.strictEqual(fishesAfterConfirm.length, 0, "Inventário deve estar vazio após confirmação");

	const userRow = await database.dbGet("fishing", "SELECT * FROM fishing_users WHERE user_id = ?", [
		testUser
	]);
	assert.strictEqual(userRow.inventory_weight, 0, "inventory_weight deve ser 0");
	console.log("✓ Teste 3 passou: Segunda chamada dentro de 1 minuto limpa o inventário.");
	bot.resetCapture();

	// 5. Terceira execução (agora inventário já está vazio)
	const msg4 = createMessage({
		content: "!pesca-abandonar",
		group: testGroup,
		author: testUser,
		authorName: "PescadorTeste"
	});
	await eventHandler.commandHandler.processCommand(bot, msg4, "pesca-abandonar", [], null);

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 mensagem");
	assert.ok(
		bot.capturedMessages[0].content.includes("vazio"),
		"Deveria avisar novamente que o inventário está vazio"
	);
	console.log("✓ Teste 4 passou: Chamada subsequente avisa que está vazio.");
	bot.resetCapture();

	// 6. Teste de expiração: se passar mais de 1 minuto, pede confirmação novamente
	await database.dbRun(
		"fishing",
		`INSERT INTO fishing_inventory (user_id, name, weight, is_rare, timestamp, emoji, data_json)
		VALUES (?, 'Tubarão', 80.0, 1, ?, '🦈', '{}')`,
		[testUser, Date.now()]
	);

	const msg5 = createMessage({
		content: "!pesca-abandonar",
		group: testGroup,
		author: testUser,
		authorName: "PescadorTeste"
	});
	await eventHandler.commandHandler.processCommand(bot, msg5, "pesca-abandonar", [], null);
	assert.ok(bot.capturedMessages[0].content.includes("1 minuto"), "Deve pedir confirmação");
	bot.resetCapture();

	// Avança o Date.now em 65 segundos (simula expiração)
	const realDateNow = Date.now;
	try {
		Date.now = () => realDateNow() + 65 * 1000;
		const msgExpired = createMessage({
			content: "!pesca-abandonar",
			group: testGroup,
			author: testUser,
			authorName: "PescadorTeste"
		});
		await eventHandler.commandHandler.processCommand(bot, msgExpired, "pesca-abandonar", [], null);

		// Como expirou, não deleta e pede confirmação novamente
		assert.ok(
			bot.capturedMessages[0].content.includes("Tubarão"),
			"Tubarão não deve ter sido deletado"
		);
		assert.ok(
			bot.capturedMessages[0].content.includes("1 minuto"),
			"Deve pedir confirmação novamente"
		);

		const fishesCheck = await database.dbAll(
			"fishing",
			"SELECT * FROM fishing_inventory WHERE user_id = ?",
			[testUser]
		);
		assert.strictEqual(fishesCheck.length, 1, "Tubarão ainda deve estar no banco após expirar");
		bot.resetCapture();

		// Agora confirma dentro da nova janela de 1 minuto
		Date.now = () => realDateNow() + 70 * 1000;
		await eventHandler.commandHandler.processCommand(bot, msgExpired, "pesca-abandonar", [], null);
		assert.ok(
			bot.capturedMessages[0].content.includes("abandonados") ||
				bot.capturedMessages[0].content.includes("Esvaziado"),
			"Deve confirmar o abandono"
		);

		const fishesFinal = await database.dbAll(
			"fishing",
			"SELECT * FROM fishing_inventory WHERE user_id = ?",
			[testUser]
		);
		assert.strictEqual(fishesFinal.length, 0, "Inventário deve estar vazio após nova confirmação");
		console.log("✓ Teste 5 passou: Janela de 1 minuto e expiração funcionam perfeitamente.");
	} finally {
		Date.now = realDateNow;
	}

	console.log("--- Todos os testes de !pesca-abandonar passaram com sucesso! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Erro no teste:", err);
	process.exit(1);
});
