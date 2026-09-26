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
	const reportedStickerId = 77771;
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
	// Deve enviar 3 mensagens: (1) sticker para logsGroup, (2) texto com !sa-removerFig para logsGroup, (3) confirmação para userGroup
	assert.strictEqual(bot.capturedMessages.length, 3, "Deve enviar 3 mensagens");

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
	assert.ok(logTextMsg.content.includes(`!sa-removerFig ${reportedStickerId}`));
	assert.ok(logTextMsg.content.includes(`figurinhas/${reportedStickerId}`));

	const userFeedbackMsg = bot.capturedMessages[2];
	assert.strictEqual(userFeedbackMsg.chatId, userGroup, "Msg 3 deve ir para o grupo do usuário");
	assert.ok(
		userFeedbackMsg.content.includes("Figurinha reportada ao admin"),
		"Mensagem deve informar que foi reportada ao admin"
	);

	if (fs.existsSync(reportedFilePath)) fs.unlinkSync(reportedFilePath);
	bot.resetCapture();
	console.log("✓ Pipeline do comando figa-denunciar validado com sucesso.");

	// --------------------------------------------------------------------------
	// 4. Teste do Comando sa-removerFig no SuperAdmin (Suporte a múltiplos IDs)
	// --------------------------------------------------------------------------
	console.log("\n4. Testando comando sa-removerFig no SuperAdmin com múltiplos IDs...");
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

	const msgSuperAdmin = createMessage({
		content: `!sa-removerFig ${idA} ${idB} ${idC}`,
		group: logsGroup,
		author: ownerUser
	});

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
	assert.ok(resSuperAdmin.content.includes(`• *#${idA}*`), "Deve listar ID A");
	assert.ok(resSuperAdmin.content.includes(`• *#${idB}*`), "Deve listar ID B");
	assert.ok(resSuperAdmin.content.includes(`• *#${idC}*`), "Deve listar ID C");
	assert.strictEqual(fs.existsSync(pathA), false, "Arquivo A deve ser removido");
	assert.strictEqual(fs.existsSync(pathB), false, "Arquivo B deve ser removido");
	assert.ok(StickerScraper.isBlacklisted(idA), "ID A deve estar na blacklist");
	assert.ok(StickerScraper.isBlacklisted(idB), "ID B deve estar na blacklist");
	assert.ok(StickerScraper.isBlacklisted(idC), "ID C deve estar na blacklist");
	console.log("✓ Comando sa-removerFig com múltiplos argumentos validado com sucesso.");

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

	console.log("\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO!");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes:", err);
		process.exit(1);
	});
