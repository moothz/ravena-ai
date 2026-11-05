process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.SUPER_ADMINS = "555596792072@c.us";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const Database = require("../utils/Database");
const Management = require("../commands/Management");
const GroupMapper = require("../utils/db/mappers/GroupMapper");

async function main() {
	console.log("=== INICIANDO TESTE DE NOTIFICAÇÃO E PERSISTÊNCIA DO !g-sair ===");

	const logsGroupId = "120363404892583431@g.us";
	const bot = new FakeBot({
		id: "ravena5",
		nomeExibir: "ravena5",
		phoneNumber: "555591537296",
		grupoLogs: logsGroupId
	});

	const database = Database.getInstance();
	const mockGroups = new Map();
	database.getGroup = async (id) => mockGroups.get(id) || null;
	database.saveGroup = async (g) => {
		mockGroups.set(g.id, g);
		return true;
	};

	const management = new Management();
	const testGroupId = "120363279129302075@g.us";
	const testUser = "5511991522589@s.whatsapp.net";

	const groupData = {
		id: testGroupId,
		name: "busologiageral10",
		titulo: "🚌BUSOLOGIA GERAL 1.0🇧🇷",
		prefix: "!"
	};
	await database.saveGroup(groupData);

	// 1. Primeira invocação de !g-sair pede confirmação
	const msg1 = createMessage({
		content: "!g-sair",
		group: testGroupId,
		author: testUser
	});

	const res1 = await management.sairGrupo(bot, msg1, [], groupData);
	assert.ok(res1 && res1.content.includes("!g-sair"), "Deve pedir confirmação em 60s");
	assert.strictEqual(bot.capturedMessages.length, 0, "Ainda não deve disparar mensagens");
	console.log("   ✓ Primeira solicitação guardou pendência e solicitou confirmação.");

	// 2. Segunda invocação (confirmação imediata)
	const msg2 = createMessage({
		content: "!g-sair",
		group: testGroupId,
		author: testUser
	});

	let leaveCalled = false;
	bot.leaveGroup = async () => {
		leaveCalled = true;
	};

	const res2 = await management.sairGrupo(bot, msg2, [], groupData);
	assert.strictEqual(res2, null, "Não deve retornar erro na confirmação");

	// Deve ter enviado mensagem de despedida para o grupo e mensagem informativa para o grupoLogs
	assert.strictEqual(
		bot.capturedMessages.length,
		2,
		"Deve enviar despedida no grupo e notificação em grupoLogs"
	);

	const despedidaMsg = bot.capturedMessages.find((m) => m.chatId === testGroupId);
	assert.ok(
		despedidaMsg && despedidaMsg.content.includes("Despedida da Ravena"),
		"Mensagem de despedida no grupo"
	);

	const logMsg = bot.capturedMessages.find((m) => m.chatId === logsGroupId);
	assert.ok(logMsg, "Mensagem deve ter sido enviada para o grupoLogs");
	console.log("   ✓ Mensagem enviada para grupoLogs:\n" + logMsg.content);
	assert.ok(logMsg.content.includes("5511991522589"), "Deve conter o número do usuário");
	assert.ok(logMsg.content.includes("120363279129302075@g.us"), "Deve conter o ID do grupo");
	assert.ok(logMsg.content.includes("busologiageral10"), "Deve conter o nome do grupo");
	assert.ok(logMsg.content.includes("🕊️"), "Deve conter o emoji de pomba");
	assert.ok(logMsg.content.includes("saída amigável"), "Deve indicar saída amigável");

	// 3. Teste do GroupMapper para garantir que removidoAmigavel e saidaAmigavel são preservados
	const dbRow = {
		id: testGroupId,
		name: "busologiageral10",
		json_data: JSON.stringify({
			removidoAmigavel: true,
			saidaAmigavel: {
				timestamp: Date.now(),
				author: testUser,
				via: "comando"
			}
		})
	};
	const mapped = GroupMapper.fromRow(dbRow);
	assert.strictEqual(mapped.removidoAmigavel, true, "GroupMapper deve preservar removidoAmigavel");
	assert.ok(
		mapped.saidaAmigavel && mapped.saidaAmigavel.via === "comando",
		"GroupMapper deve preservar saidaAmigavel"
	);
	console.log("   ✓ GroupMapper preserva removidoAmigavel e saidaAmigavel com sucesso.");

	// 4. Teste de log no EventHandler.processGroupLeave com flag de saída amigável
	const eventHandler = new EventHandler();
	eventHandler.database = database;
	eventHandler.groups[testGroupId] = mapped;

	bot.resetCapture();
	await eventHandler.processGroupLeave(bot, {
		isBotLeaving: true,
		group: { id: testGroupId, name: "busologiageral10" },
		user: { id: "555591537296@s.whatsapp.net", name: "rav5" },
		responsavel: { id: "555591537296@s.whatsapp.net", name: "rav5" }
	});

	const leaveLogMsg = bot.capturedMessages.find((m) => m.chatId === logsGroupId);
	assert.ok(leaveLogMsg, "Deve registrar a saída no grupoLogs");
	console.log("   ✓ Mensagem de saída no grupoLogs:\n" + leaveLogMsg.content);
	assert.ok(
		leaveLogMsg.content.includes("🕊️ *Tipo:* Saída amigável"),
		"Deve identificar Saída amigável no log"
	);
	assert.ok(
		leaveLogMsg.content.includes("5511991522589"),
		"Deve identificar o autor da solicitação"
	);

	// 5. Teste de entrada no grupo limpa a flag removidoAmigavel
	await eventHandler.processGroupJoin(bot, {
		isBotJoining: true,
		group: { id: testGroupId, name: "busologiageral10" },
		user: { id: "555591537296@s.whatsapp.net", name: "rav5" },
		responsavel: { id: "5511991522589@s.whatsapp.net", name: "Admin" }
	});
	const updatedAfterJoin = await database.getGroup(testGroupId);
	assert.strictEqual(
		updatedAfterJoin.removidoAmigavel,
		false,
		"Ao reentrar, removidoAmigavel deve ser resetado"
	);
	assert.strictEqual(
		updatedAfterJoin.saidaAmigavel,
		undefined,
		"Ao reentrar, saidaAmigavel deve ser deletado"
	);
	console.log("   ✓ Ao reentrar no grupo, flags de saída amigável são limpas com sucesso.");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

main().catch((err) => {
	console.error("❌ ERRO NO TESTE:", err);
	process.exit(1);
});
