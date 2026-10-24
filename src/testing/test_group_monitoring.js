process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const CommandHandler = require("../CommandHandler");
const GroupMonitoringService = require("../services/GroupMonitoringService");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== INICIANDO TESTES DO SISTEMA DE MONITORAMENTO DE GRUPOS ===");

	const database = Database.getInstance({ testMode: false });
	database.testMode = false; // Permite escrita no banco de testes

	const bot = new FakeBot({ id: "bot-test", prefix: "!" });
	const eventHandler = new EventHandler();
	const commandHandler = new CommandHandler();
	bot.eventHandler = eventHandler;
	eventHandler.commandHandler = commandHandler;

	const service = GroupMonitoringService.getInstance({ database });

	const testGroupId = "120363000000000001@g.us";
	const adminAuthor = "5511999990001@s.whatsapp.net";

	const groupObj = {
		id: testGroupId,
		name: "Grupo Teste Monitoramento",
		additionalAdmins: [adminAuthor],
		filters: {}
	};

	// Limpa estado anterior se houver
	await database.dbRun(service.DB_NAME, "DELETE FROM monitoring_rules WHERE group_id = ?", [
		testGroupId
	]);
	await database.dbRun(service.DB_NAME, "DELETE FROM monitoring_occurrences WHERE group_id = ?", [
		testGroupId
	]);
	service.rulesCache.delete(testGroupId);
	service.messageBuffers.delete(testGroupId);
	service.pendingOccurrences = [];

	// ─── 1. Teste: !g-monitorar sem argumentos ────────────────────────────────
	console.log("\n--- Teste 1: !g-monitorar sem argumentos ---");
	{
		bot.resetCapture();
		const msg = createMessage({
			content: "!g-monitorar",
			group: testGroupId,
			author: adminAuthor,
			authorName: "Admin Teste"
		});

		await commandHandler.processCommand(bot, msg, "g-monitorar", [], groupObj);
		assert.strictEqual(bot.capturedMessages.length, 1);
		const reply = bot.capturedMessages[0].content;
		assert(
			reply.includes("ℹ️ *Monitoramento de Palavras e Frases*"),
			"Deve conter cabeçalho explicativo"
		);
		assert(reply.includes("Regras ativas no grupo (0/15)"), "Deve indicar 0 regras ativas");
		console.log("✓ !g-monitorar sem argumentos retornou instruções e lista vazia");
	}

	// ─── 2. Teste: Validação de regras de palavra ─────────────────────────────
	console.log("\n--- Teste 2: Validação de palavras (mínimo 5 caracteres e duplicatas) ---");
	{
		// 2.1 Rejeição de palavra curta (< 5 chars)
		bot.resetCapture();
		const msgShort = createMessage({
			content: "!g-monitorar ola",
			group: testGroupId,
			author: adminAuthor
		});
		await commandHandler.processCommand(bot, msgShort, "g-monitorar", ["ola"], groupObj);
		assert.strictEqual(bot.capturedMessages.length, 1);
		assert(
			bot.capturedMessages[0].content.includes("mínimo 5 caracteres"),
			"Deve rejeitar palavras curtas"
		);

		// 2.2 Sucesso ao adicionar palavra válida
		bot.resetCapture();
		const msgValid = createMessage({
			content: "!g-monitorar golpe do pix",
			group: testGroupId,
			author: adminAuthor
		});
		await commandHandler.processCommand(
			bot,
			msgValid,
			"g-monitorar",
			["golpe", "do", "pix"],
			groupObj
		);
		assert.strictEqual(bot.capturedMessages.length, 1);
		const validReply = bot.capturedMessages[0].content;
		assert(
			validReply.includes("Palavra/frase adicionada ao monitoramento"),
			"Deve confirmar adição"
		);
		assert(validReply.includes('1. [Palavra] "golpe do pix"'), "Deve listar a regra numerada");

		// 2.3 Rejeição de duplicata
		bot.resetCapture();
		await commandHandler.processCommand(
			bot,
			msgValid,
			"g-monitorar",
			["golpe", "do", "pix"],
			groupObj
		);
		assert(
			bot.capturedMessages[0].content.includes("já está sendo monitorada"),
			"Deve acusar duplicata"
		);
		console.log("✓ Validação de palavras (tamanho mínimo e duplicata) passou");
	}

	// ─── 3. Teste: Validação de Regex ─────────────────────────────────────────
	console.log("\n--- Teste 3: Validação de expressões regulares (regex) ---");
	{
		// 3.1 Regex muito aberto (.* ou ^)
		bot.resetCapture();
		const msgBroad = createMessage({
			content: "!g-monitorar-regex .*",
			group: testGroupId,
			author: adminAuthor
		});
		await commandHandler.processCommand(bot, msgBroad, "g-monitorar-regex", [".*"], groupObj);
		assert.strictEqual(bot.capturedMessages.length, 1);
		assert(bot.capturedMessages[0].content.includes("muito abrangente"), "Deve bloquear regex .*");

		// 3.2 Regex válido
		bot.resetCapture();
		const msgRegexValid = createMessage({
			content: "!g-monitorar-regex \\b(cassino|aposta)\\b",
			group: testGroupId,
			author: adminAuthor
		});
		await commandHandler.processCommand(
			bot,
			msgRegexValid,
			"g-monitorar-regex",
			["\\b(cassino|aposta)\\b"],
			groupObj
		);
		assert.strictEqual(bot.capturedMessages.length, 1);
		const regexReply = bot.capturedMessages[0].content;
		assert(regexReply.includes("Expressão regular (regex) adicionada"), "Deve confirmar regex");
		assert(
			regexReply.includes("2. [Regex] `\\b(cassino|aposta)\\b`"),
			"Deve conter regex na posição 2"
		);
		console.log("✓ Validação de regex (bloqueio de abrangente e aceite de válido) passou");
	}

	// ─── 4. Teste: Limite máximo de 15 regras ─────────────────────────────────
	console.log("\n--- Teste 4: Limite máximo de 15 regras ---");
	{
		const currentRules = await service.getRules(testGroupId);
		const needed = 15 - currentRules.length;
		for (let i = 1; i <= needed; i++) {
			await service.addWordRule(testGroupId, `palavra de teste ${i}`, adminAuthor);
		}
		const fullRules = await service.getRules(testGroupId);
		assert.strictEqual(fullRules.length, 15, "Deve possuir exatamente 15 regras");

		// Tenta adicionar a 16ª
		bot.resetCapture();
		const msgExceed = createMessage({
			content: "!g-monitorar palavra excedente",
			group: testGroupId,
			author: adminAuthor
		});
		await commandHandler.processCommand(
			bot,
			msgExceed,
			"g-monitorar",
			["palavra", "excedente"],
			groupObj
		);
		assert(
			bot.capturedMessages[0].content.includes("Limite atingido"),
			"Deve acusar limite de 15 regras"
		);
		console.log("✓ Limite máximo de 15 regras respeitado");
	}

	// ─── 5. Teste: Deleção de regra (!g-monitorar-del) ─────────────────────────
	console.log("\n--- Teste 5: Remoção de regra por ID (!g-monitorar-del) ---");
	{
		bot.resetCapture();
		const msgDel = createMessage({
			content: "!g-monitorar-del 2",
			group: testGroupId,
			author: adminAuthor
		});
		await commandHandler.processCommand(bot, msgDel, "g-monitorar-del", ["2"], groupObj);
		assert.strictEqual(bot.capturedMessages.length, 1);
		const delReply = bot.capturedMessages[0].content;
		assert(delReply.includes("Regra removida com sucesso"), "Deve confirmar remoção");
		assert(delReply.includes("Regras ativas no grupo (14/15)"), "Deve atualizar contador para 14");
		console.log("✓ Deleção de regra numerada funcionou corretamente");
	}

	// ─── 6. Teste: Captura de contexto (+5 e -5 mensagens) ────────────────────
	console.log("\n--- Teste 6: Captura de contexto (5 mensagens antes e 5 depois) ---");
	{
		// Configura regra limpa para este teste
		await database.dbRun(service.DB_NAME, "DELETE FROM monitoring_rules WHERE group_id = ?", [
			testGroupId
		]);
		await database.dbRun(service.DB_NAME, "DELETE FROM monitoring_occurrences WHERE group_id = ?", [
			testGroupId
		]);
		service.rulesCache.delete(testGroupId);
		service.messageBuffers.delete(testGroupId);
		service.pendingOccurrences = [];

		await service.addWordRule(testGroupId, "cartao clonado", adminAuthor);

		// Envia 5 mensagens anteriores
		for (let i = 1; i <= 5; i++) {
			const mBefore = createMessage({
				content: `Mensagem anterior número ${i}`,
				group: testGroupId,
				author: `551199999000${i}@s.whatsapp.net`,
				authorName: `Usuario ${i}`
			});
			await service.processMessage(bot, mBefore, groupObj);
		}

		// Envia mensagem disparadora (match)
		const triggerUser = "555599999999@s.whatsapp.net";
		const triggerMsg = createMessage({
			content: "Vendo cartao clonado com saldo alto",
			group: testGroupId,
			author: triggerUser,
			authorName: "moothz"
		});
		await service.processMessage(bot, triggerMsg, groupObj);

		assert.strictEqual(service.pendingOccurrences.length, 1, "Deve criar 1 ocorrência pendente");
		assert.strictEqual(
			service.pendingOccurrences[0].afterNeeded,
			5,
			"Deve aguardar 5 mensagens posteriores"
		);

		// Envia as 5 mensagens posteriores
		for (let i = 1; i <= 5; i++) {
			const mAfter = createMessage({
				content: `Mensagem posterior número ${i}`,
				group: testGroupId,
				author: `551188888000${i}@s.whatsapp.net`,
				authorName: `Posterior ${i}`
			});
			await service.processMessage(bot, mAfter, groupObj);
		}

		// Ocorrência deve ter sido concluída
		assert.strictEqual(
			service.pendingOccurrences.length,
			0,
			"Ocorrência pendente deve ter sido finalizada"
		);

		// Valida dados gravados no SQLite
		const occurrences = await service.getOccurrences(testGroupId, { unreadOnly: true });
		assert.strictEqual(occurrences.length, 1, "Deve haver 1 ocorrência registrada");
		const occ = occurrences[0];

		assert.strictEqual(occ.pattern, "cartao clonado");
		assert.strictEqual(occ.author_name, "moothz");
		assert.strictEqual(occ.author_number, "555599999999");
		assert(
			occ.trigger_message.includes("Vendo cartao clonado"),
			"Trigger message deve conter o texto"
		);

		// Validação estrita do formato: [DD/MM/YYYY HH:mm] Nome (numero): mensagem
		const formatRegex = /^\[\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\] .+ \(\d+\): .+$/;
		assert(
			formatRegex.test(occ.trigger_message),
			`Formato do trigger deve bater: ${occ.trigger_message}`
		);

		// Checa antes e depois
		assert.strictEqual(occ.before_messages.length, 5, "Deve conter exatamente 5 mensagens antes");
		assert.strictEqual(occ.after_messages.length, 5, "Deve conter exatamente 5 mensagens depois");
		occ.before_messages.forEach((msg, idx) => {
			assert(formatRegex.test(msg), `Mensagem antes #${idx} deve seguir o formato estrito: ${msg}`);
		});
		occ.after_messages.forEach((msg, idx) => {
			assert(
				formatRegex.test(msg),
				`Mensagem depois #${idx} deve seguir o formato estrito: ${msg}`
			);
		});

		console.log(
			"✓ Contexto de 5 mensagens antes e 5 mensagens depois capturado e formatado perfeitamente"
		);
	}

	// ─── 7. Teste: Consulta e Marcação (!g-monitorar-ver) ─────────────────────
	console.log("\n--- Teste 7: Consulta e marcação de ocorrências (!g-monitorar-ver) ---");
	{
		// 7.1 Visualização com header obrigatório
		bot.resetCapture();
		const msgVer = createMessage({
			content: "!g-monitorar-ver",
			group: testGroupId,
			author: adminAuthor
		});
		await commandHandler.processCommand(bot, msgVer, "g-monitorar-ver", [], groupObj);
		assert.strictEqual(bot.capturedMessages.length, 1);
		const verReply = bot.capturedMessages[0].content;

		assert(verReply.includes("📋 *Ocorrências de Monitoramento:*"), "Deve conter o header");
		assert(verReply.includes("!g-monitorar-ver lidos"), "Header deve conter comando para todos");
		assert(verReply.includes("!g-monitorar-ver 3"), "Header deve conter exemplo com número");
		assert(verReply.includes("Ocorrência #1"), "Deve listar a ocorrência #1");
		assert(verReply.includes("cartao clonado"), "Deve exibir o termo disparador");

		// 7.2 Marca ocorrência 1 como lida
		bot.resetCapture();
		const msgMark = createMessage({
			content: "!g-monitorar-ver 1",
			group: testGroupId,
			author: adminAuthor
		});
		await commandHandler.processCommand(bot, msgMark, "g-monitorar-ver", ["1"], groupObj);
		assert.strictEqual(bot.capturedMessages.length, 1);
		assert(
			bot.capturedMessages[0].content.includes("marcada como lida"),
			"Deve confirmar marcação"
		);

		// 7.3 Consulta novamente: não deve mais aparecer como não lida
		bot.resetCapture();
		await commandHandler.processCommand(bot, msgVer, "g-monitorar-ver", [], groupObj);
		assert(
			bot.capturedMessages[0].content.includes("Nenhuma ocorrência não lida"),
			"Não deve listar ocorrências lidas"
		);

		// 7.4 Gera nova ocorrência e testa !g-monitorar-ver lidos
		const newMsg = createMessage({
			content: "Mais um cartao clonado aqui",
			group: testGroupId,
			author: "5511999998888@s.whatsapp.net",
			authorName: "Vendedor"
		});
		await service.processMessage(bot, newMsg, groupObj);

		bot.resetCapture();
		const msgLidos = createMessage({
			content: "!g-monitorar-ver lidos",
			group: testGroupId,
			author: adminAuthor
		});
		await commandHandler.processCommand(bot, msgLidos, "g-monitorar-ver", ["lidos"], groupObj);
		assert(
			bot.capturedMessages[0].content.includes(
				"Todas as ocorrências (1) foram marcadas como lidas"
			),
			"Deve marcar todas"
		);

		console.log("✓ !g-monitorar-ver (header, listagem, marcação individual e em lote) passou 100%");
	}

	// ─── 8. Teste: Cleaner noturno e limite de 250 por grupo ──────────────────
	console.log("\n--- Teste 8: Cleaner noturno e purga de armazenamento ---");
	{
		// Insere 260 ocorrências artificiais no grupo
		for (let i = 1; i <= 260; i++) {
			await database.dbRun(
				service.DB_NAME,
				`INSERT INTO monitoring_occurrences (group_id, rule_type, pattern, trigger_message, is_read)
				 VALUES (?, 'word', 'teste', 'msg', 1)`,
				[testGroupId]
			);
		}

		const preCleanRows = await database.dbAll(
			service.DB_NAME,
			"SELECT COUNT(*) as count FROM monitoring_occurrences WHERE group_id = ?",
			[testGroupId]
		);
		assert(preCleanRows[0].count >= 260, "Deve haver pelo menos 260 ocorrências");

		// Executa cleaner forçando limite 0 bytes para acionar a purga
		const cleanResult = await service.cleanOldOccurrences(0);
		assert(cleanResult.prunedCount > 0, "Deve ter purgado ocorrências");

		const postCleanRows = await database.dbAll(
			service.DB_NAME,
			"SELECT COUNT(*) as count FROM monitoring_occurrences WHERE group_id = ?",
			[testGroupId]
		);
		assert.strictEqual(
			postCleanRows[0].count,
			250,
			"Deve manter no máximo 250 ocorrências por grupo"
		);
		console.log(
			`✓ Cleaner executado com sucesso: ${cleanResult.prunedCount} ocorrências antigas purgadas`
		);
	}

	// ─── 9. Teste: getGroupData para integração com /manage ────────────────────
	console.log("\n--- Teste 9: getGroupData para /manage ---");
	{
		const manageData = await service.getGroupData(testGroupId);
		assert(Array.isArray(manageData.rules), "rules deve ser array");
		assert(Array.isArray(manageData.occurrences), "occurrences deve ser array");
		assert.strictEqual(manageData.rules.length, 1);
		assert(manageData.occurrences.length > 0);
		console.log("✓ getGroupData retornou regras e ocorrências formatadas para o painel web");
	}

	console.log("\n========================================================");
	console.log("✅ TODOS OS TESTES DE MONITORAMENTO PASSARAM COM SUCESSO!");
	console.log("========================================================\n");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("\n❌ ERRO NOS TESTES:", err);
		process.exit(1);
	});
