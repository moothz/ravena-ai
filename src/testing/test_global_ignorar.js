const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const GroupCommands = require("../functions/GroupCommands");

async function runTests() {
	console.log("=== Iniciando testes de !ignorar Global e Filtragem de Menções ===");

	const bot = new FakeBot({ id: "test-bot" });
	const eventHandler = new EventHandler();
	const cmdHandler = eventHandler.commandHandler;
	await cmdHandler.fixedCommands.loadCommands();
	const db = bot.database;

	// Limpa dados de teste anteriores
	await db.removeGlobalIgnored(["5511999991111", "123456789012345"], "5511999991111");
	await db.removeGlobalIgnored(["5511988887777", "987654321098765"], "5511988887777");
	await db.removeGlobalIgnored(["5511966665555"], "5511966665555");

	// 1. Testes de unidade em CoreRepository / Database
	console.log(
		"\n1. Testando métodos addGlobalIgnored, isGlobalIgnored e removeGlobalIgnored no Database..."
	);
	const testPn = "5511999991111";
	const testLid = "123456789012345";

	assert.strictEqual(db.isGlobalIgnored(testPn), false, "PN não deve estar ignorado inicialmente");
	assert.strictEqual(
		db.isGlobalIgnored(testLid),
		false,
		"LID não deve estar ignorado inicialmente"
	);

	await db.addGlobalIgnored([testPn, testLid], { userId: testPn, groupJid: "grupo1@g.us" });

	assert.strictEqual(
		db.isGlobalIgnored(testPn),
		true,
		"PN limpo deve ser reconhecido como ignorado"
	);
	assert.strictEqual(
		db.isGlobalIgnored(`${testPn}@s.whatsapp.net`),
		true,
		"PN com sufixo @s.whatsapp.net deve ser reconhecido como ignorado"
	);
	assert.strictEqual(
		db.isGlobalIgnored(testLid),
		true,
		"LID limpo deve ser reconhecido como ignorado"
	);
	assert.strictEqual(
		db.isGlobalIgnored(`${testLid}@lid`),
		true,
		"LID com sufixo @lid deve ser reconhecido como ignorado"
	);

	await db.removeGlobalIgnored([testPn], testPn);
	assert.strictEqual(
		db.isGlobalIgnored(testPn),
		false,
		"PN não deve mais estar ignorado após remoção"
	);
	assert.strictEqual(
		db.isGlobalIgnored(testLid),
		false,
		"LID vinculado pelo userId deve ser removido"
	);
	console.log("✓ Métodos do Database para usuários ignorados globais validados com sucesso!");

	// 2. Testando comando !ignorar em grupo (com captura de LID)
	console.log("\n2. Testando execução do comando !ignorar em grupo...");
	bot.resetCapture();

	const userAlicePn = "5511988887777";
	const userAliceLid = "987654321098765";
	const testGroupJid = "120363000000000@g.us";

	const groupObj = {
		id: testGroupJid,
		name: "Grupo Teste Ignorar",
		ignoredUsers: []
	};

	// Mock de chat com participante contendo PN e LID
	const mockChat = {
		id: { _serialized: testGroupJid },
		isGroup: true,
		participants: [
			{
				id: { _serialized: `${userAlicePn}@s.whatsapp.net` },
				phoneNumber: userAlicePn,
				lid: `${userAliceLid}@lid`
			},
			{
				id: { _serialized: "5511977776666@s.whatsapp.net" },
				phoneNumber: "5511977776666",
				lid: "112233445566778@lid",
				isAdmin: true
			}
		]
	};

	const msgAlice = createMessage({
		content: "!ignorar",
		group: testGroupJid,
		author: `${userAlicePn}@s.whatsapp.net`,
		authorAlt: `${userAliceLid}@lid`,
		authorName: "Alice",
		origin: {
			key: {
				participant: `${userAlicePn}@s.whatsapp.net`,
				participantAlt: `${userAliceLid}@lid`
			},
			getChat: async () => mockChat
		}
	});

	// Ativa ignore
	await cmdHandler.processCommand(bot, msgAlice, "ignorar", [], groupObj);
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert(
		bot.capturedMessages[0].content.includes("agora será *ignorado*"),
		"Resposta deve confirmar que usuário foi ignorado"
	);
	assert(
		bot.capturedMessages[0].content.includes("Global"),
		"Resposta deve indicar que o ignorar é Global"
	);

	// Verifica se foi adicionado globalmente (tanto PN quanto LID)
	assert.strictEqual(db.isGlobalIgnored(userAlicePn), true, "Alice PN deve estar no ignore global");
	assert.strictEqual(
		db.isGlobalIgnored(userAliceLid),
		true,
		"Alice LID deve estar no ignore global"
	);
	assert(
		groupObj.ignoredUsers.includes(userAlicePn),
		"group.ignoredUsers deve conter Alice para retrocompatibilidade"
	);
	console.log("✓ Alice ativou !ignorar com captura de PN e LID com sucesso!");

	// 3. Testando desativação do !ignorar
	console.log("\n3. Testando desativação do !ignorar...");
	bot.resetCapture();
	await cmdHandler.processCommand(bot, msgAlice, "ignorar", [], groupObj);
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert(
		bot.capturedMessages[0].content.includes("agora será *incluído*"),
		"Resposta deve confirmar que usuário foi reincluído"
	);
	assert.strictEqual(db.isGlobalIgnored(userAlicePn), false, "Alice PN deve ter sido desmarcado");
	assert.strictEqual(db.isGlobalIgnored(userAliceLid), false, "Alice LID deve ter sido desmarcado");
	assert.strictEqual(
		groupObj.ignoredUsers.includes(userAlicePn),
		false,
		"Alice deve ser removida de group.ignoredUsers"
	);
	console.log("✓ Alice desativou !ignorar com sucesso!");

	// 4. Testando !ignorar em mensagem privada (DM)
	console.log("\n4. Testando !ignorar em chat privado (DM)...");
	bot.resetCapture();
	const userBobPn = "5511966665555";
	const msgBobDm = createMessage({
		content: "!ignorar",
		group: null,
		author: `${userBobPn}@s.whatsapp.net`,
		authorName: "Bob"
	});

	await cmdHandler.processCommand(bot, msgBobDm, "ignorar", [], null);
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert(
		bot.capturedMessages[0].content.includes("agora será *ignorado*"),
		"Bob deve conseguir ignorar em DM"
	);
	assert.strictEqual(db.isGlobalIgnored(userBobPn), true, "Bob deve estar no ignore global");
	console.log("✓ !ignorar em DM funcionou perfeitamente!");

	// 5. Testando filtragem de menções no wrapper WhatsAppBotGo
	console.log("\n5. Testando filtragem de menções no wrapper WhatsAppBotGo...");
	const realBot = new WhatsAppBotGo({
		id: "test-go-bot",
		phoneNumber: "5511900000000",
		whatsgoApiUrl: "http://localhost:8080",
		whatsgoApiKey: "test-key",
		instanceName: "test-instance",
		webhookHost: "http://localhost:5001"
	});
	// Mock apiClient e database
	realBot.database = db;
	realBot.isConnected = true;
	realBot.isParticipating = () => true;
	realBot.loadReport = { trackSentMessage: () => {} };

	let capturedPayload = null;
	realBot.apiClient = {
		post: async (endpoint, payload) => {
			capturedPayload = payload;
			return { data: { id: "test_msg_id" } };
		}
	};

	// Alice está incluída, Bob está ignorado. Ignoramos Alice novamente para o teste:
	await db.addGlobalIgnored([userAlicePn, userAliceLid], { userId: userAlicePn });
	const userCharliePn = "5511955554444"; // Não ignorado

	// Envio com opções de menções manuais
	await realBot.sendMessage(testGroupJid, "Chamando galera", {
		mentions: [
			`${userAlicePn}@s.whatsapp.net`,
			`${userBobPn}@s.whatsapp.net`,
			`${userCharliePn}@s.whatsapp.net`
		]
	});

	assert(capturedPayload, "Payload deve ter sido enviado ao apiClient");
	const mentionedArray = (capturedPayload.mentionedJid || "").split(",").filter(Boolean);
	assert.strictEqual(
		mentionedArray.includes(`${userAlicePn}@s.whatsapp.net`),
		false,
		"Alice (ignorada) JAMAIS deve estar em mentionedJid"
	);
	assert.strictEqual(
		mentionedArray.includes(`${userBobPn}@s.whatsapp.net`),
		false,
		"Bob (ignorado) JAMAIS deve estar em mentionedJid"
	);
	assert.strictEqual(
		mentionedArray.includes(`${userCharliePn}@s.whatsapp.net`),
		true,
		"Charlie (não ignorado) DEVE estar em mentionedJid"
	);
	assert.strictEqual(mentionedArray.length, 1, "Apenas Charlie deve ser mencionado");
	console.log("✓ Wrapper filtrou com sucesso Alice e Bob de mentionedJid!");

	// 6. Testando resolução de LID no wrapper
	console.log("\n6. Testando resolução de LID em mentionedJid...");
	// Configura cache LID -> PN no bot
	realBot.lidToPnCache.set(userAliceLid, userAlicePn);
	realBot.lidToPnCache.set(`${userAliceLid}@lid`, userAlicePn);

	capturedPayload = null;
	await realBot.sendMessage(testGroupJid, "Chamando por LID", {
		mentions: [`${userAliceLid}@lid`, `${userCharliePn}@s.whatsapp.net`]
	});

	const mentionedArrayLid = (capturedPayload.mentionedJid || "").split(",").filter(Boolean);
	assert.strictEqual(
		mentionedArrayLid.includes(`${userAliceLid}@lid`),
		false,
		"LID resolvido para Alice ignorada JAMAIS deve estar em mentionedJid"
	);
	assert.strictEqual(
		mentionedArrayLid.includes(`${userCharliePn}@s.whatsapp.net`),
		true,
		"Charlie não ignorado deve ser mantido"
	);
	console.log("✓ Wrapper resolveu LID para PN e filtrou Alice ignorada com sucesso!");

	// 7. Testando mentionAll no wrapper (não deve marcar ignorados)
	console.log("\n7. Testando mentionAll no wrapper...");
	realBot.getChatDetails = async () => mockChat;

	capturedPayload = null;
	await realBot.sendMessage(testGroupJid, "Aviso geral mentionAll", {
		mentionAll: true
	});

	assert.strictEqual(
		capturedPayload.mentionAll,
		undefined,
		"mentionAll não deve ser enviado true para o whatsgoapi"
	);
	const mentionAllArray = (capturedPayload.mentionedJid || "").split(",").filter(Boolean);
	assert.strictEqual(
		mentionAllArray.some((m) => m.includes(userAlicePn) || m.includes(userAliceLid)),
		false,
		"Alice jamais deve ser marcada em mentionAll"
	);
	assert.strictEqual(
		mentionAllArray.some((m) => m.includes("5511977776666")),
		true,
		"Outros membros devem ser marcados em mentionAll"
	);
	console.log("✓ mentionAll no wrapper filtrou participantes ignorados com sucesso!");

	// 8. Testando mentionAllMembers (comando !galera / !todos)
	console.log("\n8. Testando comando !galera com usuário ignorado global...");
	bot.resetCapture();
	const msgGalera = createMessage({
		content: "!galera Atenção",
		group: testGroupJid,
		author: "5511977776666@s.whatsapp.net",
		authorName: "Outro Membro",
		groupChat: mockChat,
		origin: {
			getChat: async () => mockChat,
			getQuotedMessage: async () => null
		}
	});

	await cmdHandler.processCommand(bot, msgGalera, "galera", ["Atenção"], groupObj);
	assert.strictEqual(bot.capturedMessages.length, 1);
	const mentionsInReturn = bot.capturedMessages[0].options?.mentions || [];
	assert.strictEqual(
		mentionsInReturn.includes(`${userAlicePn}@s.whatsapp.net`),
		false,
		"!galera não deve incluir Alice ignorada em mentions"
	);
	console.log("✓ !galera filtrou usuários ignorados globais corretamente!");

	console.log("\n=== TODOS OS TESTES DE !IGNORAR GLOBAL PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Erro nos testes:", err);
	process.exit(1);
});
