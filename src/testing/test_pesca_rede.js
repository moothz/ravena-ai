process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Database = require("../utils/Database");
const FishingGame = require("../functions/FishingGame");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("--- Iniciando testes de !pesca-rede ---");

	const bot = new FakeBot({ id: "teste-bot", grupoLogs: "123@g.us", testMode: true });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.loadAllCommands();
	const database = Database.getInstance();
	database.testMode = false;
	const testUser = "5511999998888@s.whatsapp.net";
	const testGroup = "120363000000000000@g.us";

	eventHandler.commandHandler.cmdDebounceTime = 0;
	const resetCooldown = () => {
		if (FishingGame.fishingCooldowns) FishingGame.fishingCooldowns[testUser] = 0;
	};

	// Limpeza inicial
	await database.dbRun("fishing", "DELETE FROM fishing_inventory WHERE user_id = ?", [testUser]);
	await database.dbRun("fishing", "DELETE FROM fishing_users WHERE user_id = ?", [testUser]);
	await database.dbRun("fishing", "DELETE FROM fishing_buffs WHERE user_id = ?", [testUser]);
	if (database.coreRepo?.mappers) {
		database.coreRepo.mappers.run("core", "DELETE FROM donations WHERE numero LIKE '%999998888%'");
	}

	const originalChances = FishingGame.RARE_FISH.map((f) => f.chance);

	try {
		FishingGame.RARE_FISH.forEach((f) => {
			f.chance = 0;
		});

		// -------------------------------------------------------------
		// Teste 1: Usuário sem iscas tenta pescar com rede
		// -------------------------------------------------------------
		await database.dbRun(
			"fishing",
			`INSERT OR REPLACE INTO fishing_users 
			(user_id, name, baits, last_bait_regen, total_weight, inventory_weight, total_catches, total_baits_used, total_trash_caught, biggest_fish_json)
			VALUES (?, ?, 0, ?, 0, 0, 0, 0, 0, NULL)`,
			[testUser, "PescadorRede", Date.now()]
		);

		let reactedWithBait = false;
		const msgSemIscas = createMessage({
			content: "!pesca-rede",
			group: testGroup,
			author: testUser,
			authorName: "PescadorRede"
		});
		msgSemIscas.origin.react = (emoji) => {
			if (emoji === "🍥") reactedWithBait = true;
		};

		await eventHandler.commandHandler.processCommand(bot, msgSemIscas, "pesca-rede", [], null);
		assert.strictEqual(
			bot.capturedMessages.length,
			0,
			"Não deve enviar mensagem de texto se sem iscas"
		);
		assert.ok(reactedWithBait, "Deve reagir com 🍥 quando sem iscas");
		console.log("✓ Teste 1 passou: Jogador sem iscas tratado com reação 🍥.");
		bot.resetCapture();

		// -------------------------------------------------------------
		// Teste 2: Eficiência Base < 8 iscas (50%)
		// -------------------------------------------------------------
		resetCooldown();
		await database.dbRun(
			"fishing",
			"UPDATE fishing_users SET baits = 5, last_bait_regen = ? WHERE user_id = ?",
			[Date.now(), testUser]
		);

		const msg5Iscas = createMessage({
			content: "!pesca-rede",
			group: testGroup,
			author: testUser,
			authorName: "PescadorRede"
		});

		await eventHandler.commandHandler.processCommand(bot, msg5Iscas, "pesca-rede", [], null);
		assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 mensagem de retorno");
		const resposta2 = bot.capturedMessages[0].content;
		assert.ok(resposta2.includes("5 iscas"), "Deve mencionar 5 iscas gastas");
		assert.ok(
			!resposta2.includes("Eficiência da rede"),
			"Não deve conter linha de eficiência da rede"
		);
		assert.ok(resposta2.includes("criaturas"), "Deve usar termo criaturas");
		assert.ok(
			resposta2.includes("Criaturas Capturadas") ||
				resposta2.includes("Lixos Recolhidos") ||
				resposta2.includes("Itens & Buffs"),
			"Deve conter lista de pescados"
		);

		const userApos5 = await database.dbGet(
			"fishing",
			"SELECT * FROM fishing_users WHERE user_id = ?",
			[testUser]
		);
		assert.strictEqual(userApos5.total_baits_used, 5, "Total de iscas usadas deve ser 5");
		console.log(
			"✓ Teste 2 passou: Eficiência base de 50% para menos de 8 iscas executada com sucesso sem linha de eficiência."
		);
		bot.resetCapture();

		// -------------------------------------------------------------
		// Teste 3: Eficiência Base >= 8 iscas (75%) com argumento
		// -------------------------------------------------------------
		resetCooldown();
		await database.dbRun(
			"fishing",
			"UPDATE fishing_users SET baits = 20, last_bait_regen = ? WHERE user_id = ?",
			[Date.now(), testUser]
		);

		const msg10Iscas = createMessage({
			content: "!pesca-rede 10",
			group: testGroup,
			author: testUser,
			authorName: "PescadorRede"
		});

		await eventHandler.commandHandler.processCommand(bot, msg10Iscas, "pesca-rede", ["10"], null);
		assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 mensagem");
		const resposta3 = bot.capturedMessages[0].content;
		assert.ok(resposta3.includes("10 iscas"), "Deve mencionar 10 iscas");
		assert.ok(
			!resposta3.includes("Eficiência da rede"),
			"Não deve conter linha de eficiência da rede"
		);

		const userApos10 = await database.dbGet(
			"fishing",
			"SELECT * FROM fishing_users WHERE user_id = ?",
			[testUser]
		);
		assert.strictEqual(
			userApos10.total_baits_used,
			15,
			"Total de iscas usadas deve ser 15 (5 anteriores + 10 agora)"
		);
		console.log("✓ Teste 3 passou: Eficiência base de 75% para >= 8 iscas respeitada.");
		bot.resetCapture();

		// -------------------------------------------------------------
		// Teste 4: Bônus de Doador (> R$ 20: R$ 26 -> 2%)
		// -------------------------------------------------------------
		resetCooldown();
		await database.dbRun(
			"fishing",
			"UPDATE fishing_users SET baits = 10, last_bait_regen = ? WHERE user_id = ?",
			[Date.now(), testUser]
		);
		// Registra doação de R$ 26 para o número do usuário
		await database.addDonation("DoadorTeste", 26, testUser, "Apoio");

		const msgDonate = createMessage({
			content: "!pesca-rede 10",
			group: testGroup,
			author: testUser,
			authorName: "PescadorRede"
		});

		await eventHandler.commandHandler.processCommand(bot, msgDonate, "pesca-rede", ["10"], null);
		assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 mensagem");
		const resposta4 = bot.capturedMessages[0].content;
		assert.ok(
			!resposta4.includes("Eficiência da rede"),
			"Não deve conter linha de eficiência da rede"
		);
		console.log("✓ Teste 4 passou: Bônus de doador processado sem linha de eficiência.");
		bot.resetCapture();

		// -------------------------------------------------------------
		// Teste 5: Item "Rede de Pesca" (+25% de eficiência e consumo)
		// -------------------------------------------------------------
		resetCooldown();
		await database.dbRun("fishing", "DELETE FROM fishing_buffs WHERE user_id = ?", [testUser]);
		await database.dbRun(
			"fishing",
			"UPDATE fishing_users SET baits = 10, last_bait_regen = ? WHERE user_id = ?",
			[Date.now(), testUser]
		);
		// Adiciona buff de Rede de Pesca com 2 usos
		await database.dbRun(
			"fishing",
			`INSERT INTO fishing_buffs (user_id, effect_type, is_debuff, value, min_value, max_value, remaining_uses, original_name)
			VALUES (?, 'fishing_net', 0, 0.25, 25, 25, 2, 'Rede de Pesca')`,
			[testUser]
		);

		const msgItem = createMessage({
			content: "!pesca-rede 8",
			group: testGroup,
			author: testUser,
			authorName: "PescadorRede"
		});

		await eventHandler.commandHandler.processCommand(bot, msgItem, "pesca-rede", ["8"], null);
		assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 mensagem");
		const resposta5 = bot.capturedMessages[0].content;
		assert.ok(
			!resposta5.includes("Eficiência da rede"),
			"Não deve conter linha de eficiência da rede"
		);

		const buffRow = await database.dbGet(
			"fishing",
			"SELECT * FROM fishing_buffs WHERE user_id = ? AND effect_type = 'fishing_net'",
			[testUser]
		);
		assert.strictEqual(
			buffRow.remaining_uses,
			1,
			"Deveria restar 1 uso da Rede de Pesca (era 2, consumiu 1)"
		);
		console.log(
			"✓ Teste 5 passou: Item 'Rede de Pesca' consumido adequadamente sem linha de eficiência."
		);
		bot.resetCapture();

		// -------------------------------------------------------------
		// Teste 6: Limite máximo (Cap) de 150% de Eficiência
		// -------------------------------------------------------------
		resetCooldown();
		if (database.coreRepo?.mappers) {
			database.coreRepo.mappers.run(
				"core",
				"DELETE FROM donations WHERE numero LIKE '%999998888%'"
			);
		}
		await database.addDonation("DoadorMega", 1000, testUser, "Super Apoio");
		await database.dbRun(
			"fishing",
			"UPDATE fishing_users SET baits = 10, last_bait_regen = ? WHERE user_id = ?",
			[Date.now(), testUser]
		);

		const msgCap = createMessage({
			content: "!pesca-rede 10",
			group: testGroup,
			author: testUser,
			authorName: "PescadorRede"
		});

		await eventHandler.commandHandler.processCommand(bot, msgCap, "pesca-rede", ["10"], null);
		assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 mensagem");
		const resposta6 = bot.capturedMessages[0].content;
		assert.ok(
			!resposta6.includes("Eficiência da rede"),
			"Não deve conter linha de eficiência da rede"
		);
		console.log("✓ Teste 6 passou: Cap de eficiência em 150% respeitado.");
		bot.resetCapture();

		// -------------------------------------------------------------
		// Teste 7: Descarte de Peixes quando inventário está cheio
		// -------------------------------------------------------------
		resetCooldown();
		// Limpa inventário e buffs para testar com limite base de 10
		await database.dbRun("fishing", "DELETE FROM fishing_inventory WHERE user_id = ?", [testUser]);
		await database.dbRun("fishing", "DELETE FROM fishing_buffs WHERE user_id = ?", [testUser]);
		for (let i = 0; i < 30; i++) {
			await database.dbRun(
				"fishing",
				`INSERT INTO fishing_inventory (user_id, name, weight, is_rare, timestamp, emoji, data_json)
				VALUES (?, 'PeixeAntigo', ?, 0, ?, '🐟', '{}')`,
				[testUser, 10 + i, Date.now() - 10000]
			);
		}
		await database.dbRun(
			"fishing",
			"UPDATE fishing_users SET baits = 10, last_bait_regen = ? WHERE user_id = ?",
			[Date.now(), testUser]
		);

		const msgCheio = createMessage({
			content: "!pesca-rede 10",
			group: testGroup,
			author: testUser,
			authorName: "PescadorRede"
		});

		await eventHandler.commandHandler.processCommand(bot, msgCheio, "pesca-rede", ["10"], null);
		assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 mensagem");
		const resposta7 = bot.capturedMessages[0].content;
		assert.ok(
			resposta7.includes("Criaturas Descartadas (inventário cheio)"),
			"Deveria exibir seção de criaturas descartadas quando o inventário atinge o limite"
		);

		const fishesFinal = await database.dbAll(
			"fishing",
			"SELECT * FROM fishing_inventory WHERE user_id = ?",
			[testUser]
		);
		const userDataFinal = await FishingGame.getUserData(testUser);
		const expectedLimit = FishingGame.getMaxInventory(userDataFinal);
		assert.strictEqual(
			fishesFinal.length,
			expectedLimit,
			`Inventário final deve respeitar o limite máximo (${expectedLimit})`
		);
		console.log(
			"✓ Teste 7 passou: Descarte de criaturas excedentes e aviso formatado com sucesso."
		);
		bot.resetCapture();

		// -------------------------------------------------------------
		// Teste 8: Interrupção por peixe lendário
		// -------------------------------------------------------------
		resetCooldown();
		await database.dbRun("fishing", "DELETE FROM fishing_legendary_history WHERE user_id = ?", [
			testUser
		]);
		await database.dbRun(
			"fishing",
			"UPDATE fishing_users SET baits = 10, last_bait_regen = ? WHERE user_id = ?",
			[Date.now(), testUser]
		);

		const originalMonthlyLimit = FishingGame.RARE_FISH[0].monthlyLimit;
		try {
			FishingGame.RARE_FISH[0].chance = 1.0;
			FishingGame.RARE_FISH[0].monthlyLimit = 999;

			const msgLendario = createMessage({
				content: "!pesca-rede 5",
				group: testGroup,
				author: testUser,
				authorName: "PescadorRede"
			});

			await eventHandler.commandHandler.processCommand(bot, msgLendario, "pesca-rede", ["5"], null);
			const msgGrupo = bot.capturedMessages.find((m) => m.chatId === testGroup);
			assert.ok(msgGrupo, "Deveria enviar mensagem de retorno para o grupo");
			const respLendario = msgGrupo.options?.caption || msgGrupo.caption || msgGrupo.content || "";
			assert.ok(
				respLendario.includes("INCRÍVEL") ||
					respLendario.includes("LENDÁRIO") ||
					respLendario.includes("raríssimo"),
				"Deve retornar a mensagem de peixe lendário"
			);
			console.log(
				"✓ Teste 8 passou: Captura de lendário interrompeu a rede e enviou exclusivamente o lendário."
			);
			bot.resetCapture();
		} finally {
			FishingGame.RARE_FISH[0].monthlyLimit = originalMonthlyLimit;
		}

		// -------------------------------------------------------------
		// Teste 9: Mostrar buff ou debuff aplicado em cada peixe da lista
		// -------------------------------------------------------------
		resetCooldown();
		await database.dbRun("fishing", "DELETE FROM fishing_inventory WHERE user_id = ?", [testUser]);
		await database.dbRun("fishing", "DELETE FROM fishing_buffs WHERE user_id = ?", [testUser]);
		await database.dbRun(
			"fishing",
			"UPDATE fishing_users SET baits = 10, last_bait_regen = ? WHERE user_id = ?",
			[Date.now(), testUser]
		);
		// Adiciona buff do Minhocão e debuff da Vela Acesa
		await database.dbRun(
			"fishing",
			`INSERT INTO fishing_buffs (user_id, effect_type, is_debuff, value, min_value, max_value, remaining_uses, original_name)
			VALUES (?, 'next_fish_bonus', 0, 20, 20, 20, 5, 'Minhocão')`,
			[testUser]
		);
		await database.dbRun(
			"fishing",
			`INSERT INTO fishing_buffs (user_id, effect_type, is_debuff, value, min_value, max_value, remaining_uses, original_name)
			VALUES (?, 'weight_loss', 1, -0.4, 0, 0, 5, 'Vela Acesa do 𝒸𝒶𝓅𝒾𝓇𝑜𝓉𝑜')`,
			[testUser]
		);

		const msgComBuffs = createMessage({
			content: "!pesca-rede 4",
			group: testGroup,
			author: testUser,
			authorName: "PescadorRede"
		});

		await eventHandler.commandHandler.processCommand(bot, msgComBuffs, "pesca-rede", ["4"], null);
		assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 mensagem");
		const resposta9 = bot.capturedMessages[0].content;
		assert.ok(
			resposta9.includes("Minhocão") || resposta9.includes("Vela Acesa do 𝒸𝒶𝓅𝒾𝓇𝑜𝓉𝑜"),
			"A resposta deve indicar os nomes dos buffs/debuffs aplicados nas criaturas"
		);
		console.log(
			"✓ Teste 9 passou: Modificadores (buffs/debuffs) exibidos com sucesso ao lado das criaturas."
		);
		bot.resetCapture();
	} finally {
		FishingGame.RARE_FISH.forEach((f, idx) => {
			f.chance = originalChances[idx];
		});

		// Limpeza final
		await database.dbRun("fishing", "DELETE FROM fishing_inventory WHERE user_id = ?", [testUser]);
		await database.dbRun("fishing", "DELETE FROM fishing_users WHERE user_id = ?", [testUser]);
		await database.dbRun("fishing", "DELETE FROM fishing_buffs WHERE user_id = ?", [testUser]);
		if (database.coreRepo?.mappers) {
			database.coreRepo.mappers.run(
				"core",
				"DELETE FROM donations WHERE numero LIKE '%999998888%'"
			);
		}
	}

	console.log("--- Todos os testes de !pesca-rede passaram com sucesso! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Erro no teste:", err);
	process.exit(1);
});
