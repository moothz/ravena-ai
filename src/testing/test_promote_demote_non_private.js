"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const AdminUtils = require("../utils/AdminUtils");
const { createMessage } = require("./FakeMessage");

async function main() {
	console.log("Iniciando teste de !g-promover e !g-rebaixar em bot não-privado...");

	// Criando bot NÃO privado
	const bot = new FakeBot({
		id: "bot-publico",
		privado: false,
		phoneNumber: "5511999990000"
	});

	// Stub para AdminUtils.isAdmin retornar true quando o bot é testado
	const adminUtils = AdminUtils.getInstance();
	adminUtils.isAdmin = async () => true;

	const eventHandler = new EventHandler();

	const groupId = "120363000000000000@g.us";
	const userToPromote = "5511988887777@s.whatsapp.net";
	const adminAuthor = "5511977776666@s.whatsapp.net";

	const groupData = await bot.database.getGroup(groupId);

	// 1. Testar !g-promover com bot não privado
	bot.resetCapture();
	const msgPromover = createMessage({
		content: "!g-promover @5511988887777",
		group: groupId,
		author: adminAuthor,
		mentions: [userToPromote]
	});

	await eventHandler.commandHandler.processCommand(
		bot,
		msgPromover,
		"g-promover",
		["@5511988887777"],
		groupData
	);

	console.log("Mensagens capturadas após !g-promover:", bot.capturedMessages);

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 resposta");
	assert.match(
		bot.capturedMessages[0].content,
		/Promovido\(s\) a Administrador/,
		"Deveria ter promovido com sucesso o usuário em bot não-privado"
	);
	assert.strictEqual(
		bot.promotedParticipants.length,
		1,
		"Deveria ter chamado promoteInGroup no bot"
	);
	assert.strictEqual(bot.promotedParticipants[0].participants[0], userToPromote);

	// 2. Testar !g-rebaixar com bot não privado
	bot.resetCapture();
	const msgRebaixar = createMessage({
		content: "!g-rebaixar @5511988887777",
		group: groupId,
		author: adminAuthor,
		mentions: [userToPromote]
	});

	await eventHandler.commandHandler.processCommand(
		bot,
		msgRebaixar,
		"g-rebaixar",
		["@5511988887777"],
		groupData
	);

	console.log("Mensagens capturadas após !g-rebaixar:", bot.capturedMessages);

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar 1 resposta");
	assert.match(
		bot.capturedMessages[0].content,
		/Rebaixado\(s\) de Administrador/,
		"Deveria ter rebaixado com sucesso o usuário em bot não-privado"
	);
	assert.strictEqual(bot.demotedParticipants.length, 1, "Deveria ter chamado demoteInGroup no bot");
	assert.strictEqual(bot.demotedParticipants[0].participants[0], userToPromote);

	console.log("✅ Teste concluído com sucesso!");
	process.exit(0);
}

main().catch((err) => {
	console.error("❌ Erro no teste:", err);
	process.exit(1);
});
