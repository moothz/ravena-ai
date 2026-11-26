process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Database = require("../utils/Database");
const SummaryCommands = require("../functions/SummaryCommands");

async function main() {
	console.log("=== INICIANDO TESTE DE ÚLTIMAS MENSAGENS NO LEAVE GROUP ===");

	const logsGroupId = "120363000000000099@g.us";
	const testGroupId = "120363000000000088@g.us";
	const bot = new FakeBot({
		id: "rav-teste",
		nomeExibir: "rav-teste",
		phoneNumber: "5511999990001",
		grupoLogs: logsGroupId
	});

	const database = Database.getInstance();
	const mockGroups = new Map();
	mockGroups.set(testGroupId, {
		id: testGroupId,
		name: "grupo-teste-leave",
		prefix: "!"
	});
	database.getGroup = async (id) => mockGroups.get(id) || null;
	database.saveGroup = async (g) => {
		mockGroups.set(g.id, g);
		return true;
	};
	database.getGroupMembershipPeriods = async () => [
		{
			bot_id: "rav-teste",
			join_timestamp: new Date(2026, 10, 22, 10, 54, 53).getTime(),
			leave_timestamp: new Date(2026, 10, 26, 11, 45, 12).getTime(),
			duration: 348619000
		}
	];

	const eventHandler = new EventHandler();
	eventHandler.database = database;
	eventHandler.groups[testGroupId] = mockGroups.get(testGroupId);

	const originalGetRecentMessages = SummaryCommands.getRecentMessages;

	// 1. Exibe até 15 mensagens formatadas e trunca em 100 caracteres
	const longText =
		"Mensagem bem longa para testar o limite de cem caracteres sem disparar o filtro de repeticao do FakeBot neste teste.";
	const expectedTruncated = `${longText.slice(0, 97)}...`;
	const sampleMessages = [];
	for (let i = 1; i <= 18; i++) {
		sampleMessages.push({
			author: i === 18 ? "Anna" : `Pessoa${i}`,
			text: i === 18 ? longText : `Mensagem número ${i}\ncom quebra`,
			timestamp: new Date(2026, 10, 26, 11, i).getTime()
		});
	}

	SummaryCommands.getRecentMessages = async (chatId, limit) => {
		assert.strictEqual(chatId, testGroupId);
		assert.strictEqual(limit, 15);
		return sampleMessages.slice(-limit);
	};

	bot.resetCapture();
	await eventHandler.processGroupLeave(bot, {
		isBotLeaving: true,
		group: { id: testGroupId, name: "grupo-teste-leave" },
		user: { id: "5511999990001@s.whatsapp.net", name: "rav-teste" },
		responsavel: { id: "5511999990002@s.whatsapp.net", name: "Anna" }
	});

	const logMsg = bot.capturedMessages.find((m) => m.chatId === logsGroupId);
	assert.ok(logMsg, "Deve enviar log de saída para grupoLogs");
	assert.ok(
		logMsg.content.includes("💬 *Últimas mensagens antes da remoção:*"),
		"Deve incluir cabeçalho das últimas mensagens"
	);
	assert.ok(
		logMsg.content.includes("🚪 *Histórico de Estadia no Grupo:*"),
		"Deve manter histórico de estadia antes das mensagens"
	);
	const stayIdx = logMsg.content.indexOf("🚪 *Histórico de Estadia no Grupo:*");
	const msgsIdx = logMsg.content.indexOf("💬 *Últimas mensagens antes da remoção:*");
	assert.ok(msgsIdx > stayIdx, "Seção de mensagens deve vir após o histórico de estadia");

	assert.ok(!logMsg.content.includes("Pessoa1:"), "Não deve incluir mensagens além das 15 últimas");
	assert.ok(!logMsg.content.includes("Pessoa3:"), "Não deve incluir a 16ª mensagem mais antiga");
	assert.ok(
		logMsg.content.includes("[26/11/2026 11:04] Pessoa4: Mensagem número 4 com quebra"),
		"Deve formatar data, autor e normalizar quebras de linha"
	);
	assert.ok(
		logMsg.content.includes(`[26/11/2026 11:18] Anna: ${expectedTruncated}`),
		"Deve truncar mensagens com mais de 100 caracteres"
	);
	assert.ok(!logMsg.content.includes(longText), "Não deve incluir o texto completo sem truncar");
	console.log("   ✓ Formatação, limite de 15 mensagens e truncamento validados.");

	// 2. Sem mensagens armazenadas: não exibe a seção
	SummaryCommands.getRecentMessages = async () => [];
	bot.resetCapture();
	await eventHandler.processGroupLeave(bot, {
		isBotLeaving: true,
		group: { id: testGroupId, name: "grupo-teste-leave" },
		user: { id: "5511999990001@s.whatsapp.net", name: "rav-teste" },
		responsavel: { id: "5511999990002@s.whatsapp.net", name: "Anna" }
	});
	const emptyLogMsg = bot.capturedMessages.find((m) => m.chatId === logsGroupId);
	assert.ok(emptyLogMsg, "Deve enviar log mesmo sem mensagens recentes");
	assert.ok(
		!emptyLogMsg.content.includes("Últimas mensagens antes da remoção"),
		"Não deve exibir seção quando não há mensagens"
	);
	console.log("   ✓ Ausência de seção quando histórico vazio validada.");

	// 3. Falha ao consultar mensagens não impede o log de saída
	SummaryCommands.getRecentMessages = async () => {
		throw new Error("falha simulada no sqlite");
	};
	bot.resetCapture();
	await eventHandler.processGroupLeave(bot, {
		isBotLeaving: true,
		group: { id: testGroupId, name: "grupo-teste-leave" },
		user: { id: "5511999990001@s.whatsapp.net", name: "rav-teste" },
		responsavel: { id: "5511999990002@s.whatsapp.net", name: "Anna" }
	});
	const errLogMsg = bot.capturedMessages.find((m) => m.chatId === logsGroupId);
	assert.ok(errLogMsg, "Deve enviar log mesmo se getRecentMessages falhar");
	assert.ok(
		!errLogMsg.content.includes("Últimas mensagens antes da remoção"),
		"Não deve exibir seção em caso de erro"
	);
	console.log("   ✓ Resiliência a erro em getRecentMessages validada.");

	SummaryCommands.getRecentMessages = originalGetRecentMessages;
	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

main().catch((err) => {
	console.error("❌ ERRO NO TESTE:", err);
	process.exit(1);
});
