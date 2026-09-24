const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Database = require("../utils/Database");
const Group = require("../models/Group");

async function main() {
	console.log("--- Iniciando testes de remoção de streams ao sair do grupo ---");

	const db = Database.getInstance({ testMode: true });
	const eventHandler = new EventHandler();
	const bot = new FakeBot({
		id: "rav-test",
		phoneNumber: "5511999990000",
		grupoLogs: "logs@g.us"
	});

	// Mock do StreamMonitor no bot
	const unsubscribedList = [];
	bot.streamMonitor = {
		unsubscribe: (channel, platform) => {
			unsubscribedList.push({ channel, platform });
			return true;
		}
	};

	const testGroupId = `120363999_${Date.now()}_1@g.us`;
	const otherGroupId = `120363999_${Date.now()}_2@g.us`;

	// 1. Criar grupo teste com streams configuradas
	const groupTest = new Group({
		id: testGroupId,
		name: "Grupo com Streams",
		twitch: [
			{ channel: "exclusivo_twitch", customMessage: null },
			{ channel: "compartilhado_twitch", customMessage: null }
		],
		kick: [{ channel: "exclusivo_kick", customMessage: null }],
		youtube: [{ channel: "exclusivo_yt", customMessage: null }]
	});
	await db.saveGroup(groupTest);

	// 2. Criar outro grupo que também monitora 'compartilhado_twitch'
	const groupOther = new Group({
		id: otherGroupId,
		name: "Outro Grupo Ativo",
		twitch: [{ channel: "compartilhado_twitch", customMessage: null }],
		kick: [],
		youtube: []
	});
	await db.saveGroup(groupOther);

	console.log("1. Grupos de teste criados no banco.");

	// 3. Simular saída de um usuário comum (NÃO deve limpar streams)
	console.log("2. Testando saída de usuário normal...");
	const normalUserLeaveData = {
		group: { id: testGroupId, name: "Grupo com Streams" },
		user: { id: "5511888888888@s.whatsapp.net", name: "User Comum" },
		responsavel: { id: "5511777777777@s.whatsapp.net", name: "Admin" }
	};
	await eventHandler.processGroupLeave(bot, normalUserLeaveData);

	const groupAfterNormalLeave = await db.getGroup(testGroupId);
	assert.strictEqual(
		groupAfterNormalLeave.twitch.length,
		2,
		"Streams da Twitch não deveriam ser alteradas com saída de usuário comum"
	);
	assert.strictEqual(
		groupAfterNormalLeave.kick.length,
		1,
		"Streams da Kick não deveriam ser alteradas com saída de usuário comum"
	);
	assert.strictEqual(
		groupAfterNormalLeave.youtube.length,
		1,
		"Streams do YouTube não deveriam ser alteradas com saída de usuário comum"
	);
	assert.strictEqual(unsubscribedList.length, 0, "Nenhuma desinscrição deveria ter ocorrido");
	console.log("✓ Saída de usuário comum não afetou as streams.");

	// 4. Simular saída do BOT
	console.log("3. Testando saída do BOT do grupo...");
	bot.resetCapture();
	const botLeaveData = {
		group: { id: testGroupId, name: "Grupo com Streams", notInGroup: true },
		user: { id: "5511999990000@s.whatsapp.net", name: "Ravena Test" },
		responsavel: { id: "5511777777777@s.whatsapp.net", name: "Admin Que Removeu" }
	};
	await eventHandler.processGroupLeave(bot, botLeaveData);

	// 5. Verificar que streams foram zeradas no banco
	const groupAfterBotLeave = await db.getGroup(testGroupId);
	assert.deepStrictEqual(
		groupAfterBotLeave.twitch,
		[],
		"group.twitch deve ser vazio após o bot sair"
	);
	assert.deepStrictEqual(groupAfterBotLeave.kick, [], "group.kick deve ser vazio após o bot sair");
	assert.deepStrictEqual(
		groupAfterBotLeave.youtube,
		[],
		"group.youtube deve ser vazio após o bot sair"
	);
	console.log("✓ group.twitch, group.kick e group.youtube foram limpos no banco.");

	// 6. Verificar desinscrições no StreamMonitor
	console.log("4. Verificando desinscrições no StreamMonitor...", unsubscribedList);
	// 'exclusivo_twitch', 'exclusivo_kick' e 'exclusivo_yt' devem ser desinscritos
	const unsubTwitch = unsubscribedList.filter((u) => u.platform === "twitch");
	const unsubKick = unsubscribedList.filter((u) => u.platform === "kick");
	const unsubYoutube = unsubscribedList.filter((u) => u.platform === "youtube");

	assert.strictEqual(
		unsubTwitch.some((u) => u.channel === "exclusivo_twitch"),
		true,
		"'exclusivo_twitch' deve ser desinscrito"
	);
	assert.strictEqual(
		unsubTwitch.some((u) => u.channel === "compartilhado_twitch"),
		false,
		"'compartilhado_twitch' NÃO deve ser desinscrito pois ainda está no outro grupo"
	);
	assert.strictEqual(
		unsubKick.some((u) => u.channel === "exclusivo_kick"),
		true,
		"'exclusivo_kick' deve ser desinscrito"
	);
	assert.strictEqual(
		unsubYoutube.some((u) => u.channel === "exclusivo_yt"),
		true,
		"'exclusivo_yt' deve ser desinscrito"
	);
	console.log(
		"✓ Apenas canais exclusivos foram desinscritos; canais compartilhados foram preservados."
	);

	// 7. Verificar mensagem enviada para grupoLogs
	console.log("5. Verificando log enviado para grupoLogs...");
	const logMsg = bot.capturedMessages.find((m) => m.chatId === "logs@g.us");
	assert.ok(logMsg, "Mensagem de log de saída deve ter sido enviada");
	assert.ok(
		logMsg.content.includes("Streams Removidas (4)"),
		"Mensagem de log deve conter informação de streams removidas"
	);
	console.log("✓ Mensagem de log para grupoLogs contém o resumo de streams removidas.");

	console.log("=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro no teste:", err);
		process.exit(1);
	});
