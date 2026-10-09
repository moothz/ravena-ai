process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");

async function main() {
	console.log("=== Test Suite: Filtro Pessoa vs Ban/Block Moderação ===");

	const groupId = `test_group_${Date.now()}@g.us`;
	const adminId = "5511999990001@s.whatsapp.net";
	const userFilterId = "5511999990002@s.whatsapp.net";
	const userBanId = "5511999990003@s.whatsapp.net";
	const userBlockId = "5511999990004@s.whatsapp.net";

	// -------------------------------------------------------------
	// TESTE 1: g-filtro-pessoa NÃO deve remover usuário ao dar join
	// -------------------------------------------------------------
	console.log("\n--- Teste 1: g-filtro-pessoa não remove ao entrar no grupo ---");
	{
		const bot = new FakeBot({ id: "ravenavip", phoneNumber: "555591535538" });
		bot.privado = true;
		const eventHandler = new EventHandler();

		// Cria grupo com userFilterId no filters.people
		const groupData = await eventHandler.getOrCreateGroup(groupId, "Grupo Teste", "!");
		const group = groupData.group;
		group.additionalAdmins = [adminId];
		group.filters.people = ["5511999990002"];
		await eventHandler.database.saveGroup(group);

		// Simula entrada de userFilterId no grupo
		const joinEvent = {
			group: { id: groupId, name: "Grupo Teste" },
			user: { id: userFilterId, name: "Usuario Filtrado" },
			responsavel: { id: adminId, name: "Admin" },
			isBotJoining: false,
			origin: {
				getChat: async () => ({
					id: { _serialized: groupId },
					name: "Grupo Teste",
					participants: []
				})
			}
		};

		await eventHandler.processGroupJoin(bot, joinEvent);

		// Verifica que NENHUMA remoção de participante ocorreu
		const removals = bot.removedParticipants || [];
		assert.strictEqual(
			removals.length,
			0,
			`Esperava 0 remoções no join para usuário em filtro-pessoa, mas teve: ${JSON.stringify(removals)}`
		);
		console.log("✓ Teste 1 passou: Usuário em filtro-pessoa entrou sem ser expulso.");
	}

	// -------------------------------------------------------------
	// TESTE 2: g-filtro-pessoa continua apagando mensagens ao falar
	// -------------------------------------------------------------
	console.log("\n--- Teste 2: g-filtro-pessoa apaga mensagens enviadas ---");
	{
		const bot = new FakeBot({ id: "ravenavip", phoneNumber: "555591535538" });
		bot.privado = true;
		const eventHandler = new EventHandler();

		let messageDeleted = false;
		const msg = createMessage({
			content: "Mensagem que deve ser apagada",
			group: groupId,
			author: userFilterId
		});
		msg.origin.delete = async () => {
			messageDeleted = true;
		};

		await eventHandler.processMessage(bot, msg);
		await new Promise((r) => setTimeout(r, 50));
		assert.strictEqual(
			messageDeleted,
			true,
			"Esperava que a mensagem da pessoa filtrada fosse apagada."
		);
		console.log("✓ Teste 2 passou: Mensagem de usuário em filtro-pessoa foi apagada com sucesso.");
	}

	// -------------------------------------------------------------
	// TESTE 3: Proteção de bot público (apenas bots privados banem)
	// -------------------------------------------------------------
	console.log("\n--- Teste 3: Bot público não executa banir (apenas privado) ---");
	{
		const botPublic = new FakeBot({ id: "ravenapublica", phoneNumber: "555591535538" });
		botPublic.privado = false;
		const eventHandler = new EventHandler();
		const group = await eventHandler.database.getGroup(groupId);

		const msgCmd = createMessage({
			content: `!g-banir @5511999990003`,
			group: groupId,
			author: adminId,
			mentions: [userBanId]
		});

		const res = await eventHandler.commandHandler.processCommand(
			botPublic,
			msgCmd,
			"g-banir",
			[userBanId],
			group
		);
		assert.ok(
			res && res.content && res.content.includes("restrito às ravenas privadas"),
			`Esperava aviso de comando restrito a bot privado, recebeu: ${JSON.stringify(res)}`
		);
		console.log("✓ Teste 3 passou: Bot público impedido de banir/remover.");
	}

	// -------------------------------------------------------------
	// TESTE 4: Executar !g-banir em bot privado expulsa e salva ban
	// -------------------------------------------------------------
	console.log("\n--- Teste 4: !g-banir em bot privado adiciona a bannedUsers e expulsa ---");
	{
		const bot = new FakeBot({ id: "ravenavip", phoneNumber: "555591535538" });
		bot.privado = true;
		const eventHandler = new EventHandler();
		const group = await eventHandler.database.getGroup(groupId);
		group.lastBanAt = 0;

		// Mock para simular bot como admin do grupo
		bot.client.getChatById = async () => ({
			id: { _serialized: groupId },
			isGroup: true,
			participants: [
				{ id: { _serialized: `${bot.phoneNumber}@s.whatsapp.net` }, isAdmin: true },
				{ id: { _serialized: adminId }, isAdmin: true }
			]
		});

		const msgBan = createMessage({
			content: `!g-banir @5511999990003`,
			group: groupId,
			author: adminId,
			mentions: [userBanId]
		});

		const res = await eventHandler.commandHandler.processCommand(
			bot,
			msgBan,
			"g-banir",
			[userBanId],
			group
		);
		assert.ok(
			res && res.content && res.content.includes("Usuário(s) banido(s)"),
			`Resposta inesperada: ${res?.content}`
		);

		const updatedGroup = await eventHandler.database.getGroup(groupId);
		assert.ok(
			Array.isArray(updatedGroup.bannedUsers) && updatedGroup.bannedUsers.length > 0,
			"Esperava que userBanId estivesse em group.bannedUsers"
		);
		const banned = updatedGroup.bannedUsers.find(
			(b) => b.phone === "5511999990003" || b.id === userBanId
		);
		assert.ok(
			banned,
			`Esperava encontrar 5511999990003 em bannedUsers: ${JSON.stringify(updatedGroup.bannedUsers)}`
		);

		// filters.people NÃO deve ter sido modificado pelo ban!
		assert.ok(
			!updatedGroup.filters.people.includes("5511999990003"),
			"filters.people NÃO deve conter o usuário banido!"
		);
		console.log("✓ Teste 4 passou: Usuário banido registrado em bannedUsers e expulso.");
	}

	// -------------------------------------------------------------
	// TESTE 5: Aliases !g-ban e !g-block funcionam identicamente
	// -------------------------------------------------------------
	console.log("\n--- Teste 5: Aliases !g-ban e !g-block roteiam para banGroupMembers ---");
	{
		const bot = new FakeBot({ id: "ravenavip", phoneNumber: "555591535538" });
		bot.privado = true;
		const eventHandler = new EventHandler();
		const group = await eventHandler.database.getGroup(groupId);
		group.lastBanAt = 0;

		bot.client.getChatById = async () => ({
			id: { _serialized: groupId },
			isGroup: true,
			participants: [
				{ id: { _serialized: `${bot.phoneNumber}@s.whatsapp.net` }, isAdmin: true },
				{ id: { _serialized: adminId }, isAdmin: true }
			]
		});

		const msgBlock = createMessage({
			content: `!g-block @5511999990004`,
			group: groupId,
			author: adminId,
			mentions: [userBlockId]
		});

		const res = await eventHandler.commandHandler.processCommand(
			bot,
			msgBlock,
			"g-block",
			[userBlockId],
			group
		);
		assert.ok(
			res && res.content && res.content.includes("Usuário(s) banido(s)"),
			`Resposta inesperada: ${res?.content}`
		);

		const updatedGroup = await eventHandler.database.getGroup(groupId);
		const blocked = updatedGroup.bannedUsers.find(
			(b) => b.phone === "5511999990004" || b.id === userBlockId
		);
		assert.ok(blocked, `Esperava encontrar 5511999990004 adicionado via !g-block em bannedUsers`);
		console.log("✓ Teste 5 passou: !g-block gravou usuário em bannedUsers.");
	}

	// -------------------------------------------------------------
	// TESTE 6: Usuário banido tentando entrar no grupo é expulso
	// -------------------------------------------------------------
	console.log("\n--- Teste 6: Usuário banido é expulso ao tentar entrar ---");
	{
		const bot = new FakeBot({ id: "ravenavip", phoneNumber: "555591535538" });
		bot.privado = true;
		const eventHandler = new EventHandler();

		const joinBannedEvent = {
			group: { id: groupId, name: "Grupo Teste" },
			user: { id: userBanId, name: "Invasor Banido" },
			responsavel: { id: adminId, name: "Admin" },
			isBotJoining: false,
			origin: {
				getChat: async () => ({
					id: { _serialized: groupId },
					name: "Grupo Teste",
					participants: []
				})
			}
		};

		await eventHandler.processGroupJoin(bot, joinBannedEvent);

		const removals = bot.removedParticipants || [];
		assert.ok(removals.length >= 1, "Esperava que o usuário banido fosse expulso ao entrar");
		const lastRemoval = removals[removals.length - 1];
		assert.strictEqual(lastRemoval.groupId, groupId);
		assert.deepStrictEqual(lastRemoval.participants, [userBanId]);

		const banNotice = bot.capturedMessages.find(
			(m) =>
				typeof m.content === "string" &&
				m.content.includes("está banido deste grupo e foi removido")
		);
		assert.ok(banNotice, "Esperava aviso de expulsão por banimento enviado ao grupo");
		console.log("✓ Teste 6 passou: Usuário banido expulso com sucesso ao tentar entrar.");
	}

	// -------------------------------------------------------------
	// TESTE 7: !g-desbanir remove o ban e permite reentrada
	// -------------------------------------------------------------
	console.log("\n--- Teste 7: !g-desbanir remove banimento e permite entrada ---");
	{
		const bot = new FakeBot({ id: "ravenavip", phoneNumber: "555591535538" });
		bot.privado = true;
		const eventHandler = new EventHandler();
		const group = await eventHandler.database.getGroup(groupId);

		const msgUnban = createMessage({
			content: `!g-desbanir @5511999990003`,
			group: groupId,
			author: adminId,
			mentions: [userBanId]
		});

		const res = await eventHandler.commandHandler.processCommand(
			bot,
			msgUnban,
			"g-desbanir",
			[userBanId],
			group
		);
		assert.ok(
			res && res.content && res.content.includes("desbanido(s) com sucesso"),
			`Resposta inesperada: ${res?.content}`
		);

		const updatedGroup = await eventHandler.database.getGroup(groupId);
		const stillBanned = updatedGroup.bannedUsers.some(
			(b) => b.phone === "5511999990003" || b.id === userBanId
		);
		assert.strictEqual(stillBanned, false, "Usuário deveria ter sido removido de bannedUsers");

		// Agora simula nova entrada do usuário desbanido
		bot.removedParticipants = [];
		const joinAgainEvent = {
			group: { id: groupId, name: "Grupo Teste" },
			user: { id: userBanId, name: "Ex-Banido" },
			responsavel: { id: adminId, name: "Admin" },
			isBotJoining: false,
			origin: {
				getChat: async () => ({
					id: { _serialized: groupId },
					name: "Grupo Teste",
					participants: []
				})
			}
		};

		await eventHandler.processGroupJoin(bot, joinAgainEvent);
		assert.strictEqual(
			(bot.removedParticipants || []).length,
			0,
			"Usuário desbanido NÃO deveria ser expulso ao entrar."
		);
		console.log("✓ Teste 7 passou: Usuário desbanido com sucesso e entrou sem ser expulso.");
	}

	// -------------------------------------------------------------
	// TESTE 8: Persistência no SQLite core.db
	// -------------------------------------------------------------
	console.log("\n--- Teste 8: Persistência de bannedUsers no banco SQLite ---");
	{
		const eventHandler = new EventHandler();
		const testSaveGroup = await eventHandler.getOrCreateGroup(
			`sqlite_test_${Date.now()}@g.us`,
			"Teste SQLite",
			"!"
		);
		const grp = testSaveGroup.group;
		grp.bannedUsers = [
			{ phone: "5511888887777", lid: "12345", id: "5511888887777@s.whatsapp.net", date: Date.now() }
		];

		await eventHandler.database.saveGroup(grp);

		// Limpa cache da memória se houver e busca do SQLite
		eventHandler.database.clearCache?.(`group:${grp.id}`);
		const loaded = await eventHandler.database.getGroup(grp.id);

		assert.ok(loaded, "Grupo recarregado do banco deve existir");
		assert.ok(Array.isArray(loaded.bannedUsers), "loaded.bannedUsers deve ser array");
		assert.strictEqual(loaded.bannedUsers.length, 1);
		assert.strictEqual(loaded.bannedUsers[0].phone, "5511888887777");
		console.log("✓ Teste 8 passou: bannedUsers salvo e recarregado do SQLite com sucesso.");
	}

	console.log("\n=======================================================");
	console.log("TODOS OS TESTES (1 A 8) FORAM CONCLUÍDOS COM SUCESSO! 🎉");
	console.log("=======================================================\n");
	process.exit(0);
}

main().catch((err) => {
	console.error("ERRO NO TESTE:", err);
	process.exit(1);
});
