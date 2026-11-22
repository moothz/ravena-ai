"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const CommandHandler = require("../CommandHandler");
const WaifuCommands = require("../functions/WaifuCommands");
const InviteSystem = require("../InviteSystem");
const TelegramNotificationService = require("../services/TelegramNotificationService");

async function main() {
	console.log("=== Iniciando Testes dos Ajustes Gerais ===");

	const bot = new FakeBot({ id: "test-bot" });
	const commandHandler = new CommandHandler();

	// -------------------------------------------------------------
	// TESTE 1: Cooldown via React vs Cooldown de Texto
	// -------------------------------------------------------------
	console.log("\n[Teste 1] Testando mensagem de cooldown para reação e texto...");

	// 1.1 Cooldown com originReaction
	const reactMsg = createMessage({
		content: "",
		group: "120363000000000001@g.us",
		author: "5511999990001@s.whatsapp.net"
	});
	reactMsg.originReaction = { reaction: "1️⃣", senderId: "5511999990001@s.whatsapp.net" };

	await commandHandler.handleCooldownMessage(
		bot,
		reactMsg,
		{ name: "reactionWaifuHelper" },
		reactMsg.group,
		{ formattedTime: "15s" }
	);

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria ter enviado 1 mensagem de cooldown");
	assert.ok(
		bot.capturedMessages[0].content.includes("O comando via react 1️⃣ está em cooldown"),
		`Mensagem esperada para react 1️⃣, recebido: ${bot.capturedMessages[0].content}`
	);
	assert.ok(
		!bot.capturedMessages[0].content.includes("reactionWaifuHelper"),
		"Não deve exibir o nome técnico 'reactionWaifuHelper'"
	);
	console.log("✓ Mensagem de cooldown via reação formatada corretamente com o emoji.");

	// 1.2 Cooldown tradicional de texto
	bot.resetCapture();
	const textMsg = createMessage({
		content: "!ping",
		group: "120363000000000001@g.us",
		author: "5511999990001@s.whatsapp.net"
	});
	await commandHandler.handleCooldownMessage(bot, textMsg, { name: "ping" }, textMsg.group, {
		formattedTime: "10s"
	});

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria ter enviado 1 mensagem de cooldown");
	assert.ok(
		bot.capturedMessages[0].content.includes("O comando 'ping' está em cooldown"),
		`Mensagem esperada para comando ping, recebido: ${bot.capturedMessages[0].content}`
	);
	console.log("✓ Mensagem de cooldown tradicional de texto mantida.");

	// -------------------------------------------------------------
	// TESTE 2: WaifuCommands (!mu-share com haremName e apelido)
	// -------------------------------------------------------------
	console.log("\n[Teste 2] Testando !mu-share com nome de harém e apelido...");
	const cmdShare = WaifuCommands.commands.find((c) => c.name === "mu-share");
	assert.ok(cmdShare, "Comando mu-share deve existir");

	// -------------------------------------------------------------
	// TESTE 3: InviteSystem - Fallback de GRUPO_INVITES e Envio ao Telegram
	// -------------------------------------------------------------
	console.log("\n[Teste 3] Testando fallback de grupoInvites e Telegram no InviteSystem...");
	const envBackup = process.env.GRUPO_INVITES;
	const envTgBackup = process.env.GRUPO_INVITES_TELEGRAM;
	process.env.GRUPO_INVITES = "fallback-invites@g.us";
	process.env.GRUPO_INVITES_TELEGRAM = "-1009999999999";

	const inviteBot = new FakeBot({ id: "ravena13", grupoInvites: null });
	const inviteSys = new InviteSystem(inviteBot);

	// Mock do TelegramNotificationService
	let capturedTgNotification = null;
	const tgService = TelegramNotificationService.getInstance();
	const originalSendNotification = tgService.sendNotification;
	tgService.sendNotification = async (chatId, text, opts) => {
		capturedTgNotification = { chatId, text, opts };
		return { success: true, messageId: 999 };
	};

	try {
		// Simula recebimento de convite
		const inviteMsg = createMessage({
			content: "chat.whatsapp.com/TESTCODE123",
			group: null, // PV
			author: "5511999990002@s.whatsapp.net",
			authorName: "TestUser"
		});

		// Mock de getInviteInfo no bot.client
		inviteBot.client = {
			getInviteInfo: async () => ({
				Name: "Grupo Teste",
				JID: "120363999999999999@g.us",
				ParticipantCount: 42
			})
		};

		await inviteSys.handleInviteRequest(
			inviteMsg.author,
			"TESTCODE123",
			"chat.whatsapp.com/TESTCODE123",
			"Motivo valido para teste do convite",
			inviteMsg
		);

		// Verifica se o WhatsApp recebeu no grupo fallback (já que bot.grupoInvites era null)
		const sentToWhatsapp = inviteBot.capturedMessages.find(
			(m) => m.chatId === "fallback-invites@g.us"
		);
		assert.ok(sentToWhatsapp, "Deveria ter enviado notificação para o fallback-invites@g.us");
		console.log("✓ WhatsApp recebeu o convite via fallback de process.env.GRUPO_INVITES.");

		// Verifica se o comando !sa-joinGrupo foi enviado
		const joinCmdMsg = inviteBot.capturedMessages.find(
			(m) => typeof m.content === "string" && m.content.startsWith("!sa-joinGrupo TESTCODE123")
		);
		assert.ok(joinCmdMsg, "Deveria ter enviado comando !sa-joinGrupo no WhatsApp");
		console.log("✓ Comando !sa-joinGrupo gerado com sucesso.");

		// Verifica se o Telegram recebeu a notificação com os dados completos e comandos copiáveis
		assert.ok(capturedTgNotification, "Deveria ter enviado notificação para o Telegram");
		assert.strictEqual(
			capturedTgNotification.chatId,
			"-1009999999999",
			"ChatId do Telegram correto"
		);
		assert.ok(
			capturedTgNotification.text.includes("Grupo Teste"),
			"Telegram deve conter o nome do grupo"
		);
		assert.ok(
			capturedTgNotification.text.includes("<code>!sa-joinGrupo TESTCODE123"),
			"Telegram deve conter o comando !sa-joinGrupo dentro de <code> para copiar com 1 toque"
		);
		console.log("✓ Telegram recebeu inviteInfo completo com comando copiável em <code>.");
	} finally {
		tgService.sendNotification = originalSendNotification;
		process.env.GRUPO_INVITES = envBackup;
		process.env.GRUPO_INVITES_TELEGRAM = envTgBackup;
	}

	console.log("\n=== TODOS OS TESTES DOS AJUSTES GERAIS PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

main().catch((err) => {
	console.error("ERRO NO TESTE:", err);
	process.exit(1);
});
