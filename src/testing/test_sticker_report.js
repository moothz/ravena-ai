"use strict";

process.env.NODE_ENV = "test";
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const StickerScraper = require("../functions/StickerScraper");
const SuperAdmin = require("../commands/SuperAdmin");
const Database = require("../utils/Database");

const database = Database.getInstance({ testMode: true });

async function runTests() {
	console.log("=== INICIANDO TESTES: DENÚNCIA E REMOÇÃO DE FIGURINHAS ===");

	// --------------------------------------------------------------------------
	// 1. Teste de Rastreamento de Mensagens Enviadas no SQLite
	// --------------------------------------------------------------------------
	console.log("\n1. Testando recordSentStickerMessage e getStickerIdByMessageId...");
	const testMsgId = "3EB0TEST123456789";
	const testStickerId = 88881;
	const testChatId = "120363000000000000@g.us";

	StickerScraper.recordSentStickerMessage(testMsgId, testStickerId, testChatId);

	const recoveredId = StickerScraper.getStickerIdByMessageId(testMsgId);
	assert.strictEqual(
		recoveredId,
		testStickerId,
		"Deve recuperar o ID da figurinha a partir do message ID exato"
	);

	// Teste com ID composto (ex: true_123@g.us_3EB0TEST123456789)
	const compositeId = `true_${testChatId}_${testMsgId}`;
	const recoveredFromComposite = StickerScraper.getStickerIdByMessageId(compositeId);
	assert.strictEqual(
		recoveredFromComposite,
		testStickerId,
		"Deve recuperar o ID da figurinha a partir de ID composto com stanzaID"
	);
	console.log("✓ Rastreamento de mensagens no SQLite funciona perfeitamente.");

	// --------------------------------------------------------------------------
	// 2. Teste de Remoção Única e em Lote (removeFromLovecell & removeMultipleFromLovecell)
	// --------------------------------------------------------------------------
	console.log(
		"\n2. Testando remoção e blacklist (removeFromLovecell & removeMultipleFromLovecell)..."
	);
	const dummyId1 = 99991;
	const dummyId2 = 99992;
	const dummyPath1 = StickerScraper.getStickerFilePath(dummyId1);
	const dummyPath2 = StickerScraper.getStickerFilePath(dummyId2);

	// Cria arquivos temporários de teste
	fs.writeFileSync(dummyPath1, Buffer.alloc(100));
	fs.writeFileSync(dummyPath2, Buffer.alloc(100));
	assert.ok(fs.existsSync(dummyPath1), "Arquivo dummy 1 deve existir");
	assert.ok(fs.existsSync(dummyPath2), "Arquivo dummy 2 deve existir");

	// Registra estatística prévia
	database.mappers.run(
		"lovecell",
		"INSERT OR REPLACE INTO lovecell_stats (id, sent_count, created_at) VALUES (?, 5, ?)",
		[dummyId1, new Date().toISOString()]
	);

	const batchResult = await StickerScraper.removeMultipleFromLovecell(
		[dummyId1, dummyId2],
		"Teste de remoção em lote"
	);

	assert.strictEqual(batchResult.removedCount, 2, "Deve ter processado 2 figurinhas");
	assert.strictEqual(fs.existsSync(dummyPath1), false, "Arquivo dummy 1 deve ter sido deletado");
	assert.strictEqual(fs.existsSync(dummyPath2), false, "Arquivo dummy 2 deve ter sido deletado");
	assert.ok(StickerScraper.isBlacklisted(dummyId1), "ID 1 deve estar na blacklist");
	assert.ok(StickerScraper.isBlacklisted(dummyId2), "ID 2 deve estar na blacklist");

	const statRow = database.mappers.get("lovecell", "SELECT * FROM lovecell_stats WHERE id = ?", [
		dummyId1
	]);
	assert.strictEqual(statRow, undefined, "Registro em lovecell_stats deve ter sido excluído");
	console.log("✓ Remoção em lote e limpeza de arquivos/estatísticas verificadas com sucesso.");

	// --------------------------------------------------------------------------
	// 3. Teste do Comando figa-denunciar
	// --------------------------------------------------------------------------
	console.log("\n3. Testando comando figa-denunciar...");
	const logsGroup = "120363999999999999@g.us";
	const userGroup = "120363111111111111@g.us";
	const testUser = "5511999999999@s.whatsapp.net";

	const bot = new FakeBot({ id: "test-bot", grupoLogs: logsGroup });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	eventHandler.commandHandler.cmdDebounceTime = 0;
	eventHandler.commandHandler.checkCooldown = async () => ({
		inCooldown: false,
		timeLeft: 0,
		formattedTime: ""
	});

	// Validação de visibilidade e documentação no menu
	const figaCmd = StickerScraper.commands.find((c) => c.name === "figa-denunciar");
	assert.ok(figaCmd, "Comando figa-denunciar deve estar registrado");
	assert.strictEqual(figaCmd.hidden, false, "figa-denunciar não deve ser hidden");
	const helperEntry = StickerScraper.helper.cmds.find((c) => c.cmd === "!figa-denunciar");
	assert.ok(helperEntry, "figa-denunciar deve estar documentado em helper.cmds");
	const removerCmd = StickerScraper.commands.find((c) => c.name === "sa-removerFig");
	assert.ok(removerCmd, "Comando sa-removerFig deve estar registrado");
	assert.strictEqual(removerCmd.hidden, true, "sa-removerFig deve ser hidden");

	// Cenário 3.1: Usuário chama !figa-denunciar sem marcar mensagem
	const msgSemQuote = createMessage({
		content: "!figa-denunciar",
		group: userGroup,
		author: testUser
	});
	msgSemQuote.hasQuotedMsg = false;
	msgSemQuote.origin.getQuotedMessage = async () => null;

	const testGroupObj = { id: userGroup, name: "Grupo Teste" };

	await eventHandler.commandHandler.processCommand(
		bot,
		msgSemQuote,
		"figa-denunciar",
		[],
		testGroupObj
	);
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.ok(
		bot.capturedMessages[0].content.includes("responda (reply) diretamente"),
		"Deve instruir o usuário a responder a uma figurinha"
	);
	bot.resetCapture();

	// Cenário 3.2: Usuário responde a uma mensagem de texto (não-figurinha)
	const msgQuoteTexto = createMessage({
		content: "!figa-denunciar",
		group: userGroup,
		author: testUser
	});
	msgQuoteTexto.hasQuotedMsg = true;
	msgQuoteTexto.origin.getQuotedMessage = async () => ({
		id: "text_msg_123",
		type: "text",
		content: "olá"
	});

	await eventHandler.commandHandler.processCommand(
		bot,
		msgQuoteTexto,
		"figa-denunciar",
		[],
		testGroupObj
	);
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.ok(
		bot.capturedMessages[0].content.includes("não é uma figurinha"),
		"Deve avisar que a mensagem marcada não é figurinha"
	);
	bot.resetCapture();

	// Cenário 3.3: Usuário responde a uma figurinha enviada pelo bot (ID rastreado)
	const reportedStickerId = 77771000 + (Date.now() % 1000000);
	const sentStickerMsgId = "3EB0SENTSTICKER123";
	StickerScraper.recordSentStickerMessage(sentStickerMsgId, reportedStickerId, userGroup);

	// Cria sticker temporário no cache para ser encaminhado
	const reportedFilePath = StickerScraper.getStickerFilePath(reportedStickerId);
	fs.writeFileSync(reportedFilePath, Buffer.alloc(4000, 1)); // >= MIN_STICKER_BYTES

	const msgQuoteSticker = createMessage({
		content: "!figa-denunciar",
		group: userGroup,
		author: testUser
	});
	msgQuoteSticker.hasQuotedMsg = true;
	msgQuoteSticker.quotedMessageId = sentStickerMsgId;
	msgQuoteSticker.origin.getQuotedMessage = async () => ({
		id: sentStickerMsgId,
		type: "sticker",
		hasMedia: true,
		downloadMedia: async () => ({
			mimetype: "image/webp",
			data: Buffer.alloc(4000, 1).toString("base64")
		})
	});

	await eventHandler.commandHandler.processCommand(
		bot,
		msgQuoteSticker,
		"figa-denunciar",
		[],
		testGroupObj
	);
	// Deve enviar 4 mensagens: (1) sticker para logsGroup, (2) detalhes para logsGroup, (3) comando !sa-removerFig para logsGroup, (4) confirmação para userGroup
	assert.strictEqual(bot.capturedMessages.length, 4, "Deve enviar 4 mensagens");

	const logStickerMsg = bot.capturedMessages[0];
	assert.strictEqual(logStickerMsg.chatId, logsGroup, "Msg 1 deve ir para grupoLogs");
	assert.strictEqual(
		logStickerMsg.options?.sendMediaAsSticker,
		true,
		"Msg 1 deve ser enviada como sticker"
	);

	const logTextMsg = bot.capturedMessages[1];
	assert.strictEqual(logTextMsg.chatId, logsGroup, "Msg 2 deve ir para grupoLogs");
	assert.ok(logTextMsg.content.includes("Denúncia de Figurinha Recebida"));
	assert.ok(logTextMsg.content.includes(`figurinhas/${reportedStickerId}`));

	const logCmdMsg = bot.capturedMessages[2];
	assert.strictEqual(logCmdMsg.chatId, logsGroup, "Msg 3 deve ir para grupoLogs");
	assert.strictEqual(
		logCmdMsg.content.trim(),
		`!sa-removerFig ${reportedStickerId}`,
		"Msg 3 deve ser exclusivamente o comando para fácil encaminhamento"
	);

	const userFeedbackMsg = bot.capturedMessages[3];
	assert.strictEqual(userFeedbackMsg.chatId, userGroup, "Msg 4 deve ir para o grupo do usuário");
	assert.ok(
		userFeedbackMsg.content.includes("Figurinha reportada ao admin"),
		"Mensagem deve informar que foi reportada ao admin"
	);

	if (fs.existsSync(reportedFilePath)) fs.unlinkSync(reportedFilePath);
	bot.resetCapture();
	console.log(
		"✓ Pipeline do comando figa-denunciar (com 3 msgs no grupo de logs + 1 no PV/grupo) validado com sucesso."
	);

	// --------------------------------------------------------------------------
	// 4. Teste do Comando sa-removerFig no SuperAdmin (Múltiplos IDs e Apagar Mensagens)
	// --------------------------------------------------------------------------
	console.log(
		"\n4. Testando comando sa-removerFig no SuperAdmin com múltiplos IDs e deleção automática..."
	);
	const superAdmin = new SuperAdmin();
	const ownerUser = process.env.SUPER_ADMINS ? process.env.SUPER_ADMINS.split(",")[0] : testUser;
	superAdmin.isSuperAdmin = (author) => author === ownerUser;

	// Testa como usuário comum (sem permissão)
	const msgSemPerm = createMessage({
		content: "!sa-removerFig 12345",
		group: logsGroup,
		author: "5511888888888@s.whatsapp.net"
	});
	const resSemPerm = await superAdmin.removerFig(bot, msgSemPerm, ["12345"], { id: logsGroup });
	assert.ok(
		resSemPerm.content.includes("Apenas super administradores"),
		"Não-superadmin deve ser bloqueado"
	);

	// Testa execução com múltiplos IDs: !sa-removerFig 50001 50002 50003
	const idA = 50001;
	const idB = 50002;
	const idC = 50003;
	const pathA = StickerScraper.getStickerFilePath(idA);
	const pathB = StickerScraper.getStickerFilePath(idB);
	fs.writeFileSync(pathA, Buffer.alloc(100));
	fs.writeFileSync(pathB, Buffer.alloc(100));

	// Registra uma mensagem associada ao idA para testar deleção automática
	const msgIdToDelete = "3EB0DELETE_TEST_123";
	StickerScraper.recordSentStickerMessage(msgIdToDelete, idA, userGroup, bot.id);

	const msgSuperAdmin = createMessage({
		content: `!sa-removerFig ${idA} ${idB} ${idC}`,
		group: logsGroup,
		author: ownerUser
	});

	bot.deletedMessages = [];
	const resSuperAdmin = await superAdmin.removerFig(
		bot,
		msgSuperAdmin,
		[String(idA), String(idB), String(idC)],
		{ id: logsGroup }
	);

	assert.ok(
		resSuperAdmin.content.includes("Total processado: *3* figurinha(s)"),
		"Deve relatar 3 figurinhas processadas"
	);
	assert.ok(
		resSuperAdmin.content.includes("Mensagens apagadas: *1* ocorrência(s)"),
		"Deve relatar a mensagem associada apagada"
	);
	assert.strictEqual(bot.deletedMessages.length, 1, "Deve ter invocado deleteMessageByKey");
	assert.strictEqual(bot.deletedMessages[0].id, msgIdToDelete);
	assert.strictEqual(bot.deletedMessages[0].remoteJid, userGroup);
	assert.strictEqual(bot.deletedMessages[0].fromMe, true);

	assert.ok(resSuperAdmin.content.includes(`• *#${idA}*`), "Deve listar ID A");
	assert.ok(resSuperAdmin.content.includes(`• *#${idB}*`), "Deve listar ID B");
	assert.ok(resSuperAdmin.content.includes(`• *#${idC}*`), "Deve listar ID C");
	assert.strictEqual(fs.existsSync(pathA), false, "Arquivo A deve ser removido");
	assert.strictEqual(fs.existsSync(pathB), false, "Arquivo B deve ser removido");
	assert.ok(StickerScraper.isBlacklisted(idA), "ID A deve estar na blacklist");
	assert.ok(StickerScraper.isBlacklisted(idB), "ID B deve estar na blacklist");
	assert.ok(StickerScraper.isBlacklisted(idC), "ID C deve estar na blacklist");
	console.log(
		"✓ Comando sa-removerFig com múltiplos argumentos e deleção automática validado com sucesso."
	);

	// --------------------------------------------------------------------------
	// 5. Teste de Reconstrução de Quoted Message (Fallback pós-Restart)
	// --------------------------------------------------------------------------
	console.log("\n5. Testando formatQuotedMessageFromContext em WhatsAppBotGo...");
	const WhatsAppBotGo = require("../WhatsAppBotGo");
	const botGo = new WhatsAppBotGo({
		id: "test-go",
		numero: "5511999999999",
		grupoLogs: logsGroup,
		whatsgoApiUrl: "http://localhost:8080",
		whatsgoApiKey: "test-key",
		instanceName: "test-instance",
		webhookHost: "http://localhost:3000"
	});

	const contextInfoStub = {
		stanzaID: "3EB0QUOTEDFALLBACK123",
		participant: "5511977777777@s.whatsapp.net",
		quotedMessage: {
			imageMessage: {
				mimetype: "image/jpeg",
				url: "https://mmg.whatsapp.net/v/t62.7118-24/test.enc",
				caption: "Imagem enviada ontem"
			}
		}
	};

	const reconstructed = botGo.formatQuotedMessageFromContext(
		contextInfoStub,
		"120363000000000000@g.us",
		false
	);

	assert.ok(reconstructed, "Mensagem reconstruída deve existir");
	assert.strictEqual(reconstructed.id, "3EB0QUOTEDFALLBACK123");
	assert.strictEqual(reconstructed.type, "image");
	assert.strictEqual(reconstructed.caption, "Imagem enviada ontem");
	assert.strictEqual(reconstructed.hasMedia, true);
	assert.strictEqual(typeof reconstructed.downloadMedia, "function");
	assert.strictEqual(reconstructed.origin.id.id, "3EB0QUOTEDFALLBACK123");
	console.log(
		"✓ Reconstrução via contextInfo.quotedMessage (fallback de cache) validada com sucesso."
	);

	// --------------------------------------------------------------------------
	// 6. Teste de Gatilhos de Reação (🔞 para figa-denunciar e ‼️ para sa-removerFig)
	// --------------------------------------------------------------------------
	console.log("\n6. Testando gatilhos de reação: 🔞 (figa-denunciar) e ‼️ (sa-removerFig)...");
	const ReactionsHandler = require("../ReactionsHandler");
	const reactionsHandler = new ReactionsHandler();
	await reactionsHandler.loadCommands();

	// Validação de mapeamento de emojis
	assert.strictEqual(
		reactionsHandler.reactionCommands["🔞"],
		"figa-denunciar",
		"Emoji 🔞 deve estar mapeado para 'figa-denunciar'"
	);
	assert.strictEqual(
		reactionsHandler.reactionCommands["‼️"],
		"sa-removerFig",
		"Emoji ‼️ deve estar mapeado para 'sa-removerFig'"
	);
	console.log("✓ Mapeamento de emojis no ReactionsHandler validado.");

	// Cenário 6.1: Reação 🔞 diretamente em um sticker
	const reportedStickerId2 = 77772000 + (Date.now() % 1000000);
	const sentStickerMsgId2 = `3EB0REACTSTICKER_REPORT_${Date.now()}`;
	StickerScraper.recordSentStickerMessage(sentStickerMsgId2, reportedStickerId2, userGroup);

	const stickerPath2 = StickerScraper.getStickerFilePath(reportedStickerId2);
	fs.writeFileSync(stickerPath2, Buffer.alloc(4000, 2));

	bot.resetCapture();
	const msgReactDenuncia = createMessage({
		group: userGroup,
		author: "5511000000000@s.whatsapp.net"
	});
	msgReactDenuncia.id = sentStickerMsgId2;
	msgReactDenuncia.type = "sticker";
	msgReactDenuncia.originReaction = {
		reaction: "🔞",
		senderId: testUser,
		userName: "Denunciante React"
	};
	msgReactDenuncia.origin.id = { _serialized: sentStickerMsgId2, id: sentStickerMsgId2 };
	msgReactDenuncia.origin.downloadMedia = async () => ({
		mimetype: "image/webp",
		data: Buffer.alloc(4000, 2).toString("base64")
	});

	await eventHandler.commandHandler.processCommand(
		bot,
		msgReactDenuncia,
		"figa-denunciar",
		[],
		testGroupObj
	);

	assert.strictEqual(bot.capturedMessages.length, 4, "Deve enviar as 4 mensagens de denúncia");
	assert.strictEqual(bot.capturedMessages[0].chatId, logsGroup);
	assert.ok(bot.capturedMessages[1].content.includes(testUser), "Denunciante deve ser quem reagiu");
	assert.strictEqual(
		bot.capturedMessages[2].content.trim(),
		`!sa-removerFig ${reportedStickerId2}`
	);
	if (fs.existsSync(stickerPath2)) fs.unlinkSync(stickerPath2);
	bot.resetCapture();
	console.log("✓ Reação 🔞 diretamente na figurinha executou a denúncia com sucesso.");

	// Cenário 6.2: Reação ‼️ em sticker por usuário comum (não autorizado)
	const stickerToRemoveId = 88882;
	const stickerMsgToRemoveId = "3EB0REMOVE_STICKER_REACT";
	StickerScraper.recordSentStickerMessage(stickerMsgToRemoveId, stickerToRemoveId, userGroup);

	const removeFilePath = StickerScraper.getStickerFilePath(stickerToRemoveId);
	fs.writeFileSync(removeFilePath, Buffer.alloc(100));

	const msgReactSemPerm = createMessage({
		group: userGroup,
		author: "5511777777777@s.whatsapp.net"
	});
	msgReactSemPerm.id = stickerMsgToRemoveId;
	msgReactSemPerm.type = "sticker";
	msgReactSemPerm.originReaction = {
		reaction: "‼️",
		senderId: "5511777777777@s.whatsapp.net" // Usuário comum
	};

	bot.deletedMessages = [];
	const resReactSemPerm = await StickerScraper.removerFigCommand(
		bot,
		msgReactSemPerm,
		[],
		testGroupObj
	);
	assert.strictEqual(resReactSemPerm, null, "Reação ‼️ de não-superadmin deve ser ignorada");
	assert.strictEqual(bot.deletedMessages.length, 0, "Nenhuma mensagem deve ser apagada");
	assert.strictEqual(fs.existsSync(removeFilePath), true, "Arquivo não deve ser removido");
	console.log("✓ Reação ‼️ de não-superadmin ignorada silenciosamente sem apagar nada.");

	// Cenário 6.3: Reação ‼️ em sticker por SuperAdmin (autorizado)
	const msgReactSuperAdmin = createMessage({
		group: userGroup,
		author: "5511000000000@s.whatsapp.net" // Remetente original da mensagem
	});
	msgReactSuperAdmin.id = stickerMsgToRemoveId;
	msgReactSuperAdmin.type = "sticker";
	msgReactSuperAdmin.originReaction = {
		reaction: "‼️",
		senderId: ownerUser // SuperAdmin reagindo
	};
	msgReactSuperAdmin.origin.id = {
		_serialized: stickerMsgToRemoveId,
		id: stickerMsgToRemoveId,
		remote: userGroup
	};

	// Vincula isSuperAdmin ao ownerUser no superAdmin do commandHandler
	eventHandler.commandHandler.superAdmin.isSuperAdmin = (author) => author === ownerUser;

	const resReactSuperAdmin = await StickerScraper.removerFigCommand(
		bot,
		msgReactSuperAdmin,
		[],
		testGroupObj
	);

	assert.ok(resReactSuperAdmin, "Deve retornar confirmação de remoção");
	assert.ok(
		resReactSuperAdmin.content.includes("Total processado: *1* figurinha(s)"),
		"Deve relatar 1 figurinha processada"
	);
	assert.strictEqual(
		fs.existsSync(removeFilePath),
		false,
		"Arquivo deve ter sido removido do cache"
	);
	assert.ok(StickerScraper.isBlacklisted(stickerToRemoveId), "ID deve estar na blacklist");
	assert.ok(bot.deletedMessages.length >= 1, "Deve ter chamado deleteMessageByKey");
	assert.strictEqual(bot.deletedMessages[0].id, stickerMsgToRemoveId);
	console.log("✓ Reação ‼️ por SuperAdmin removeu a figurinha e apagou mensagem com sucesso.");

	// --------------------------------------------------------------------------
	// 7. Teste de Reações Pós-Restart (Cache Miss -> Fallback Sintético)
	// --------------------------------------------------------------------------
	console.log("\n7. Testando reações pós-restart com ReactionsHandler (cache miss -> fallback)...");
	const postRestartHandler = new ReactionsHandler();
	await postRestartHandler.loadCommands();
	bot.eventHandler = eventHandler;

	// Cenário 7.1: Reação 🔞 pós-restart em sticker enviado pelo bot (targetFromMe = true)
	// getMessageById retorna null (simula pós-restart / cache limpo)
	bot.client.getMessageById = async () => null;

	const postRestartStickerId = 99991;
	const postRestartMsgId = "3EB0POSTRESTART_STICKER1";
	StickerScraper.recordSentStickerMessage(
		postRestartMsgId,
		postRestartStickerId,
		userGroup,
		bot.id
	);

	const postRestartPath = StickerScraper.getStickerFilePath(postRestartStickerId);
	fs.writeFileSync(postRestartPath, Buffer.alloc(4000, 3));

	bot.resetCapture();
	const handledReportReaction = await postRestartHandler.processReaction(bot, {
		reaction: "🔞",
		senderId: testUser,
		userName: "Denunciante Pós-Restart",
		msgId: { _serialized: postRestartMsgId },
		chatId: userGroup,
		targetFromMe: true
	});

	assert.strictEqual(
		handledReportReaction,
		true,
		"ReactionsHandler deve processar reação 🔞 via fallback"
	);
	assert.strictEqual(
		bot.capturedMessages.length,
		1,
		"Deve enviar apenas a confirmação, sem repetir a notificação já enviada aos logs"
	);
	assert.strictEqual(
		bot.capturedMessages[0].chatId,
		userGroup,
		"Confirmação deve ir para o grupo do usuário"
	);
	assert.strictEqual(
		bot.capturedMessages[0].options?.mentions?.includes(testUser),
		true,
		"Confirmação no grupo do usuário deve conter a menção do denunciante"
	);

	if (fs.existsSync(postRestartPath)) fs.unlinkSync(postRestartPath);
	bot.resetCapture();
	console.log("✓ Reação 🔞 pós-restart com mensagem fora do cache validada com sucesso.");

	// Cenário 7.2: Reação ‼️ pós-restart por SuperAdmin (remove e apaga ocorrência)
	const removePostRestartId = 99992;
	const removePostRestartMsgId = "3EB0POSTRESTART_STICKER2";
	StickerScraper.recordSentStickerMessage(
		removePostRestartMsgId,
		removePostRestartId,
		userGroup,
		bot.id
	);

	const removePostRestartPath = StickerScraper.getStickerFilePath(removePostRestartId);
	fs.writeFileSync(removePostRestartPath, Buffer.alloc(100));

	bot.deletedMessages = [];
	bot.resetCapture();

	const handledRemoveReaction = await postRestartHandler.processReaction(bot, {
		reaction: "‼️",
		senderId: ownerUser,
		userName: "SuperAdmin Pós-Restart",
		msgId: { _serialized: removePostRestartMsgId },
		chatId: userGroup,
		targetFromMe: true
	});

	assert.strictEqual(
		handledRemoveReaction,
		true,
		"ReactionsHandler deve processar reação ‼️ via fallback"
	);
	assert.ok(StickerScraper.isBlacklisted(removePostRestartId), "Sticker deve estar na blacklist");
	assert.strictEqual(
		fs.existsSync(removePostRestartPath),
		false,
		"Arquivo deve ter sido excluído do cache"
	);
	assert.ok(bot.deletedMessages.length >= 1, "Mensagem deve ter sido apagada no WhatsApp");
	assert.strictEqual(bot.deletedMessages[0].id, removePostRestartMsgId);
	assert.strictEqual(bot.capturedMessages.length, 1, "Deve enviar confirmação para o chat");
	assert.ok(
		bot.capturedMessages[0].content.includes("Total processado: *1* figurinha(s)"),
		"Confirmação deve indicar 1 figurinha removida"
	);

	bot.resetCapture();
	console.log("✓ Reação ‼️ pós-restart com mensagem fora do cache validada com sucesso.");

	console.log("\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO!");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes:", err);
		process.exit(1);
	});
