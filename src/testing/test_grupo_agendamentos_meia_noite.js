const assert = require("assert");
const GrupoAgendamentos = require("../commands/modules/GrupoAgendamentos");
const Database = require("../utils/Database");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== Iniciando testes de agendamento à meia-noite (00:00 a 00:59) ===");

	// ---------------------------------------------------------------------------
	// 1. Validação de getNowBrasilia e formatação de horas
	// ---------------------------------------------------------------------------
	console.log("\n[1] Testando getNowBrasilia e fuso de Brasília...");

	// Simula meia-noite em Brasília: 2026-09-20 03:00:00 UTC = 2026-09-20 00:00:00 GMT-3 (Domingo)
	const date0000 = new Date("2026-09-20T03:00:00.000Z");
	const dtf0000 = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Sao_Paulo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		weekday: "short"
	});
	const parts0000 = Object.fromEntries(
		dtf0000.formatToParts(date0000).map((p) => [p.type, p.value])
	);
	assert.strictEqual(parts0000.hour, "00", "00:00 em Brasília deve ser '00' e não '24'");
	assert.strictEqual(parts0000.minute, "00");
	assert.strictEqual(parts0000.weekday, "Sun");

	// Simula 00:07 em Brasília: 2026-09-20 03:07:00 UTC
	const date0007 = new Date("2026-09-20T03:07:00.000Z");
	const parts0007 = Object.fromEntries(
		dtf0000.formatToParts(date0007).map((p) => [p.type, p.value])
	);
	assert.strictEqual(parts0007.hour, "00", "00:07 em Brasília deve ser '00' e não '24'");
	assert.strictEqual(parts0007.minute, "07");

	// Simula 23:59 em Brasília: 2026-09-20 02:59:00 UTC (Sábado 23:59)
	const date2359 = new Date("2026-09-20T02:59:00.000Z");
	const parts2359 = Object.fromEntries(
		dtf0000.formatToParts(date2359).map((p) => [p.type, p.value])
	);
	assert.strictEqual(parts2359.hour, "23");
	assert.strictEqual(parts2359.minute, "59");
	assert.strictEqual(parts2359.weekday, "Sat");

	// Verifica getNowBrasilia() atual
	const spAtual = GrupoAgendamentos.getNowBrasilia();
	assert.ok(!isNaN(spAtual.hour), "Hora atual não pode ser NaN");
	assert.ok(spAtual.hour >= 0 && spAtual.hour <= 23, "Hora atual deve estar entre 0 e 23");
	assert.ok(spAtual.diaSemana >= 0 && spAtual.diaSemana <= 6, "diaSemana deve estar entre 0 e 6");
	assert.ok(!isNaN(spAtual.dateInTz.getTime()), "dateInTz deve ser uma data válida");
	console.log("✓ getNowBrasilia retorna horas válidas (00-23) e datas válidas");

	// ---------------------------------------------------------------------------
	// 2. Validação de dia da semana independente do UTC do Docker
	// ---------------------------------------------------------------------------
	console.log("\n[2] Testando cálculo do dia da semana (getDiaSemanaBrasilia)...");
	// 2026-09-19 22:00:00 em Brasília = 2026-09-20 01:00:00 UTC
	// No Docker UTC seria Domingo (0), mas em Brasília ainda é Sábado (6)
	const sabado22h = new Date("2026-09-20T01:00:00.000Z");
	assert.strictEqual(
		GrupoAgendamentos.getDiaSemanaBrasilia(sabado22h),
		6,
		"Às 22:00 de sábado em Brasília, o dia da semana deve ser 6 (Sábado) e não 0"
	);

	// Domingo 00:05 em Brasília = 2026-09-20 03:05:00 UTC
	const domingo00h05 = new Date("2026-09-20T03:05:00.000Z");
	assert.strictEqual(
		GrupoAgendamentos.getDiaSemanaBrasilia(domingo00h05),
		0,
		"Às 00:05 de domingo em Brasília, o dia da semana deve ser 0 (Domingo)"
	);
	console.log("✓ getDiaSemanaBrasilia calcula corretamente o dia da semana no fuso de Brasília");

	// ---------------------------------------------------------------------------
	// 3. Validação de calcularTimestampUnico para 00:00 e 00:07
	// ---------------------------------------------------------------------------
	console.log("\n[3] Testando calcularTimestampUnico para 00:00 e 00:07...");

	// Agendando 00:00
	const calc00 = GrupoAgendamentos.calcularTimestampUnico(0, 0);
	assert.ok(!isNaN(calc00.timestamp), "Timestamp de 00:00 não pode ser NaN");
	assert.ok(!isNaN(calc00.diffMs), "diffMs de 00:00 não pode ser NaN");
	assert.ok(calc00.diffMs > 0, "diffMs de 00:00 no futuro deve ser positivo");
	assert.ok(!isNaN(calc00.diaSemanaCalculado), "diaSemanaCalculado não pode ser NaN");

	// Agendando 00:07
	const calc07 = GrupoAgendamentos.calcularTimestampUnico(0, 7);
	assert.ok(!isNaN(calc07.timestamp), "Timestamp de 00:07 não pode ser NaN");
	assert.ok(!isNaN(calc07.diffMs), "diffMs de 00:07 não pode ser NaN");
	assert.ok(calc07.diffMs > 0, "diffMs de 00:07 no futuro deve ser positivo");

	// Agendando 23:59
	const calc2359 = GrupoAgendamentos.calcularTimestampUnico(23, 59);
	assert.ok(!isNaN(calc2359.timestamp), "Timestamp de 23:59 não pode ser NaN");
	assert.ok(!isNaN(calc2359.diffMs), "diffMs de 23:59 não pode ser NaN");

	// Formatação de tempo restante
	const tempoStr00 = GrupoAgendamentos.formatarTempoRestante(calc00.diffMs);
	assert.ok(
		!tempoStr00.includes("NaN"),
		`formatarTempoRestante não deve conter NaN: ${tempoStr00}`
	);
	console.log(`✓ calcularTimestampUnico calculou 00:00 (${tempoStr00}) sem NaN`);

	// ---------------------------------------------------------------------------
	// 4. Teste de correspondência na query de agendamentos semanais
	// ---------------------------------------------------------------------------
	console.log("\n[4] Testando persistência e busca SQL de agendamentos semanais à meia-noite...");
	const db = Database.getInstance({ testMode: true });
	const dbName = "grupo_agendamentos";
	const testGroupId = "120363999999999999@g.us";

	// Insere agendamento semanal para hora = 0, minuto = 7, dia_semana = 0
	await db.dbRun(
		dbName,
		`INSERT OR REPLACE INTO grupo_agendamentos (
			id, group_id, bot_id, tipo, hora, minuto, dia_semana, timestamp_unico, frase, ativo, criado_em
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
		["TEST_0007", testGroupId, "fake-bot", "fechar", 0, 7, 0, null, null, Date.now()]
	);

	// Simula a consulta que verificarAgendamentosSemanais realiza
	// Com o fix, currentHour é 0 (e não 24)
	const currentHourFixed = 0;
	const currentMinFixed = 7;
	const currentDayFixed = 0;

	const rows = await db.dbAll(
		dbName,
		`SELECT * FROM grupo_agendamentos 
		 WHERE ativo = 1 
		   AND dia_semana = ? 
		   AND hora = ? 
		   AND minuto = ?`,
		[currentDayFixed, currentHourFixed, currentMinFixed]
	);

	assert.ok(
		rows && rows.length > 0,
		"Query SQL de checagem semanal DEVE encontrar o agendamento de 00:07"
	);
	assert.strictEqual(rows[0].id, "TEST_0007");
	assert.strictEqual(rows[0].hora, 0);
	assert.strictEqual(rows[0].minuto, 7);

	// Limpa registro de teste
	await db.dbRun(dbName, `DELETE FROM grupo_agendamentos WHERE id = ? AND group_id = ?`, [
		"TEST_0007",
		testGroupId
	]);
	console.log("✓ Agendamento semanal às 00:07 encontrado com sucesso na query SQL");

	// ---------------------------------------------------------------------------
	// 5. Fluxo de comandos de gerenciamento via FakeBot e EventHandler
	// ---------------------------------------------------------------------------
	console.log("\n[5] Testando comandos !g-fechar 00:00 e !g-fechar 00:07 via pipeline...");
	const bot = new FakeBot({ id: "teste-bot" });
	const eventHandler = new EventHandler();
	const adminAuthor = "5511999999999@s.whatsapp.net";

	// Registra grupo de teste no eventHandler
	eventHandler.groups[testGroupId] = {
		id: testGroupId,
		name: "Grupo Teste",
		prefix: "!"
	};

	// Desativa debounce para os testes
	eventHandler.commandHandler.cmdDebounceTime = 0;

	// Stub de permissão de admin
	eventHandler.commandHandler.adminUtils.isAdmin = async () => true;
	eventHandler.commandHandler.management.adminUtils.isAdmin = async () => true;
	eventHandler.commandHandler.management.isBotAdmin = async () => true;

	// Helper para esperar processamento assíncrono do CommandHandler
	const waitTicks = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

	// Testa !g-fechar 00:00
	bot.resetCapture?.() || (bot.capturedMessages = []);
	const msgFechar00 = createMessage({
		content: "!g-fechar 00:00",
		group: testGroupId,
		author: adminAuthor
	});
	await eventHandler.processMessage(bot, msgFechar00);
	await waitTicks(150);

	const reply00 = bot.capturedMessages.find((m) => m.chatId === testGroupId);
	if (!reply00) {
		console.error("DEBUG capturedMessages:", bot.capturedMessages);
	}
	assert.ok(reply00, "Bot deve responder ao comando !g-fechar 00:00");
	assert.ok(
		!reply00.content.includes("NaN"),
		`Resposta de 00:00 não pode conter NaN: ${reply00.content}`
	);
	assert.ok(
		reply00.content.includes("00:00"),
		`Resposta deve confirmar agendamento para 00:00: ${reply00.content}`
	);
	console.log("✓ !g-fechar 00:00 executado com sucesso:", reply00.content.split("\n")[0]);

	// Testa !g-fechar 00:07
	bot.capturedMessages = [];
	const msgFechar07 = createMessage({
		content: "!g-fechar 00:07",
		group: testGroupId,
		author: adminAuthor
	});
	await eventHandler.processMessage(bot, msgFechar07);
	await waitTicks(150);

	const reply07 = bot.capturedMessages.find((m) => m.chatId === testGroupId);
	assert.ok(reply07, "Bot deve responder ao comando !g-fechar 00:07");
	assert.ok(
		!reply07.content.includes("NaN"),
		`Resposta de 00:07 não pode conter NaN: ${reply07.content}`
	);
	assert.ok(
		reply07.content.includes("00:07"),
		`Resposta deve confirmar agendamento para 00:07: ${reply07.content}`
	);
	console.log("✓ !g-fechar 00:07 executado com sucesso:", reply07.content.split("\n")[0]);

	// Testa !g-fechar-lista
	bot.capturedMessages = [];
	const msgLista = createMessage({
		content: "!g-fechar-lista",
		group: testGroupId,
		author: adminAuthor
	});
	await eventHandler.processMessage(bot, msgLista);
	await waitTicks(150);

	const replyLista = bot.capturedMessages.find((m) => m.chatId === testGroupId);
	assert.ok(replyLista, "Bot deve responder ao comando !g-fechar-lista");
	assert.ok(replyLista.content.includes("00:00"), "Lista deve conter 00:00");
	assert.ok(replyLista.content.includes("00:07"), "Lista deve conter 00:07");
	assert.ok(!replyLista.content.includes("NaN"), "Lista não pode conter NaN");
	console.log("✓ !g-fechar-lista lista os agendamentos corretamente");

	// Limpa agendamentos criados pelo teste
	await db.dbRun(dbName, `DELETE FROM grupo_agendamentos WHERE group_id = ?`, [testGroupId]);

	console.log("\n=== Todos os testes de agendamento à meia-noite passaram com sucesso! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
