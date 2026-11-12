process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const EventHandler = require("../EventHandler");
const ReactionsHandler = require("../ReactionsHandler");

// PNG 1x1 válido (pixel vermelho) para testes reais com Sharp/Stickers
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function createMockWhatsAppBotGo() {
	const bot = Object.create(WhatsAppBotGo.prototype);
	bot.id = "bot-go-teste";
	bot.phoneNumber = "5511999999999";
	bot.nomeExibir = "RavenaTest";
	bot.viewOnceMediaCache = new Map();
	bot.lidToPnCache = new Map([["999888777", "5511888888888"]]);
	bot.downloadedPayloads = [];
	bot.logger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {}
	};
	bot.loadReport = { trackReceivedMessage: () => {} };
	bot.fetchPushNameFromCache = async () => "Tester";
	bot.getContactDetails = async (id, name) => ({ id: { _serialized: id }, name: name || "Tester" });
	bot.getChatDetails = async (id) => ({ id: { _serialized: id }, isGroup: id.includes("@g.us") });
	bot.sendReaction = async () => {};
	bot._materializeBase64Media = async (base64Str, mimetype = "image/png") => ({
		url: "https://example.local/mock.bin",
		mimetype: String(mimetype).split(";")[0],
		filename: "mock.bin",
		filePath: "/tmp/mock.bin",
		base64: String(base64Str).replace(/^data:.*?;base64,/, ""),
		data: String(base64Str).replace(/^data:.*?;base64,/, "")
	});
	bot.apiClient = {
		post: async (url, body) => {
			bot.downloadedPayloads.push({ url, body });
			return {
				data: {
					base64: `data:image/jpeg;base64,${TINY_PNG_BASE64}`
				}
			};
		}
	};
	const storedCache = new Map();
	bot.cacheManager = {
		putGoMessageInCache: (msg) => {
			storedCache.set(msg.id, msg);
		},
		getGoMessageFromCache: async (id) => storedCache.get(id) || null
	};
	bot._storedCache = storedCache;
	return bot;
}

async function testWhatsAppBotGoViewOnce() {
	console.log("[1/4] Testando WhatsAppBotGo unwrapping, cache e unavailable view-once...");
	const bot = createMockWhatsAppBotGo();

	// 1.1 Unwrap viewOnceMessage, viewOnceMessageV2, viewOnceMessageV2Extension, ephemeral -> viewOnceV2
	const wrapped1 = { viewOnceMessage: { message: { imageMessage: { mimetype: "image/jpeg" } } } };
	const res1 = bot._unwrapGoMessageContent(wrapped1);
	assert.strictEqual(res1.isViewOnce, true, "viewOnceMessage deve marcar isViewOnce=true");
	assert.ok(res1.unwrapped.imageMessage, "viewOnceMessage deve expor imageMessage");

	const wrappedNested = {
		ephemeralMessage: {
			message: {
				viewOnceMessageV2: {
					message: {
						videoMessage: { mimetype: "video/mp4", viewOnce: true, caption: "!extractaudio" }
					}
				}
			}
		}
	};
	const resNested = bot._unwrapGoMessageContent(wrappedNested);
	assert.strictEqual(resNested.isViewOnce, true, "ephemeral -> viewOnceV2 deve marcar isViewOnce");
	assert.strictEqual(resNested.unwrapped.videoMessage.caption, "!extractaudio");

	const wrappedExt = {
		viewOnceMessageV2Extension: {
			message: { audioMessage: { mimetype: "audio/ogg; codecs=opus" } }
		}
	};
	const resExt = bot._unwrapGoMessageContent(wrappedExt);
	assert.strictEqual(resExt.isViewOnce, true, "viewOnceMessageV2Extension deve marcar isViewOnce");
	assert.ok(resExt.unwrapped.audioMessage);

	// 1.2 formatQuotedMessageFromContext com wrapper aninhado e messageId no download
	const quotedFormatted = bot.formatQuotedMessageFromContext(
		{
			stanzaID: "VO_QUOTE_1",
			participant: "5511777777777@s.whatsapp.net",
			quotedMessage: {
				ephemeralMessage: {
					message: {
						viewOnceMessageV2: {
							message: { imageMessage: { mimetype: "image/jpeg", viewOnce: true } }
						}
					}
				}
			}
		},
		"120363000111222@g.us"
	);
	assert.strictEqual(quotedFormatted.isViewOnce, true);
	assert.strictEqual(quotedFormatted.type, "image");
	const downloadedQuoted = await quotedFormatted.downloadMedia();
	assert.ok(downloadedQuoted?.data, "quoted view-once deve baixar via messageId");
	assert.strictEqual(
		bot.downloadedPayloads[0]?.body?.messageId,
		"VO_QUOTE_1",
		"POST /message/downloadmedia deve enviar stanzaID como messageId"
	);

	// 1.3 formatMessageFromGo com viewOnceMedia ansioso (sem bater no POST /message/downloadmedia e sem poluir cache persistente)
	const prevCalls = bot.downloadedPayloads.length;
	const voMsg = await bot.formatMessageFromGo({
		Info: {
			ID: "VO_EAGER_1",
			Chat: "120363000111222@g.us",
			Sender: "5511666666666@s.whatsapp.net",
			SenderAlt: "111222333@lid",
			Timestamp: new Date().toISOString(),
			PushName: "Remetente",
			IsGroup: true,
			IsFromMe: false
		},
		IsViewOnce: true,
		viewOnceMedia: {
			base64: TINY_PNG_BASE64,
			mimetype: "image/png",
			filename: "VO_EAGER_1.png"
		},
		Message: {
			imageMessage: {
				mimetype: "image/png",
				caption: "!s",
				viewOnce: true
			}
		}
	});
	assert.strictEqual(voMsg.isViewOnce, true);
	assert.strictEqual(voMsg.origin.isViewOnce, true);
	assert.strictEqual(voMsg.type, "image");
	assert.strictEqual(voMsg.caption, "!s");

	const eagerMedia = await voMsg.downloadMedia();
	assert.strictEqual(eagerMedia.data, TINY_PNG_BASE64);
	assert.strictEqual(
		bot.downloadedPayloads.length,
		prevCalls,
		"viewOnceMedia pré-carregada não deve disparar novo POST"
	);

	const persistedStub = bot._storedCache.get("VO_EAGER_1");
	assert.ok(persistedStub, "Mensagem deve ser gravada no cache");
	assert.strictEqual(
		persistedStub.goMessageData.viewOnceMedia,
		undefined,
		"Cache persistente não deve manter base64 gigante"
	);

	// Recuperação via recoverMsgFromCache deve ainda usar viewOnceMediaCache em RAM
	const recovered = await bot.recoverMsgFromCache("VO_EAGER_1");
	assert.strictEqual(recovered.isViewOnce, true);
	const recoveredMedia = await recovered.downloadMedia();
	assert.strictEqual(recoveredMedia.data, TINY_PNG_BASE64);
	assert.strictEqual(
		bot.downloadedPayloads.length,
		prevCalls,
		"Recuperação deve acertar viewOnceMediaCache em RAM sem bater na API Go"
	);

	// 1.4 UndecryptableMessage view_once stub
	const unavailableStub = await bot.formatMessageFromGo({
		Info: {
			ID: "VO_UNAVAIL_1",
			Chat: "120363000111222@g.us",
			Sender: "5511666666666@s.whatsapp.net",
			Timestamp: new Date().toISOString(),
			PushName: "Remetente",
			IsGroup: true,
			IsFromMe: false
		},
		UnavailableType: "view_once",
		isViewOnce: true,
		isViewOnceUnavailable: true
	});
	assert.strictEqual(unavailableStub.type, "view_once_unavailable");
	assert.strictEqual(unavailableStub.isViewOnce, true);
	assert.strictEqual(unavailableStub.isViewOnceUnavailable, true);
	assert.strictEqual(await unavailableStub.downloadMedia(), null);
	console.log("✓ [1/4] OK");
}

async function createTestPipeline() {
	const groupId = "120363000999888@g.us";
	const adminPn = "5511777777777";
	const userPn = "5511888888888";

	const bot = new FakeBot({
		id: "teste-vo",
		phoneNumber: "5511999999999",
		grupoLogs: null,
		grupoAvisos: null
	});
	bot.lidToPnCache = new Map([["999888777", userPn]]);
	bot.client = {
		_cachedMessages: new Map(),
		getMessageById: async (id) => bot.client._cachedMessages.get(id) || null,
		getChatById: async (id) => ({
			id: { _serialized: id },
			isGroup: true,
			participants: [
				{ id: { _serialized: `${adminPn}@s.whatsapp.net` }, isAdmin: true, isSuperAdmin: false },
				{ id: { _serialized: `${userPn}@s.whatsapp.net` }, isAdmin: false, isSuperAdmin: false }
			]
		})
	};

	const eventHandler = new EventHandler();
	const reactionHandler = new ReactionsHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	await reactionHandler.loadCommands();
	const groupObj = {
		id: groupId,
		name: "Grupo Teste VO",
		paused: false,
		filters: {},
		mutedCategories: [],
		mutedCommands: [],
		additionalAdmins: []
	};
	eventHandler.getOrCreateGroup = async () => ({ group: groupObj });

	bot.eventHandler = eventHandler;
	return {
		bot,
		eventHandler,
		commandHandler: eventHandler.commandHandler,
		reactionHandler,
		groupObj,
		groupId,
		adminPn,
		userPn
	};
}

async function testCaptionMediaCommands() {
	console.log("[2/4] Testando comandos na legenda de view-once (!s, !volume, !extractaudio)...");
	const { bot, commandHandler, groupObj, groupId, userPn } = await createTestPipeline();

	// 2.1 !s na legenda de view-once imagem
	const reactionsCalled = [];
	const stickerVoMsg = createMessage({
		type: "image",
		caption: "!s",
		hasMedia: true,
		isViewOnce: true,
		group: groupId,
		author: `${userPn}@s.whatsapp.net`,
		content: {
			mimetype: "image/png",
			data: TINY_PNG_BASE64,
			isMessageMedia: true
		},
		id: "MSG_VO_STICKER_1"
	});
	stickerVoMsg.origin.isViewOnce = true;
	stickerVoMsg.origin.react = async (emoji) => {
		reactionsCalled.push(emoji);
	};

	const sCmd = commandHandler.fixedCommands.getCommand("s");
	bot.resetCapture();
	await commandHandler.executeFixedCommand(bot, stickerVoMsg, sCmd, [], groupObj);
	assert.strictEqual(
		bot.capturedMessages.length,
		1,
		"!s na legenda de view-once deve responder com sticker"
	);
	assert.strictEqual(bot.capturedMessages[0].chatId, groupId);
	assert.ok(
		bot.capturedMessages[0].options?.sendMediaAsSticker,
		"Resposta deve ser enviada como sticker"
	);

	// 2.2 !s citando view-once cuja mídia retorna null (não deve lançar TypeError)
	const brokenQuoteMsg = createMessage({
		type: "text",
		content: "!s",
		group: groupId,
		author: `${userPn}@s.whatsapp.net`,
		hasQuotedMsg: true
	});
	brokenQuoteMsg.origin.react = async (emoji) => reactionsCalled.push(emoji);
	brokenQuoteMsg.origin.getQuotedMessage = async () => ({
		type: "image",
		hasMedia: true,
		isViewOnce: true,
		downloadMedia: async () => null
	});

	bot.resetCapture();
	await commandHandler.executeFixedCommand(bot, brokenQuoteMsg, sCmd, [], groupObj);
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.ok(
		String(bot.capturedMessages[0].content).includes("Não foi possível baixar"),
		"Cotação indisponível deve retornar aviso amigável sem TypeError"
	);

	// 2.3 !extractaudio / !volume em legenda (needsMedia: true no lugar de needsQuotedMsg: true)
	const extractCmd = commandHandler.fixedCommands.getCommand("extractaudio");
	assert.strictEqual(
		extractCmd.needsQuotedMsg,
		false,
		"extractaudio não deve bloquear legenda com needsQuotedMsg"
	);
	assert.strictEqual(extractCmd.needsMedia, true, "extractaudio deve usar needsMedia");

	const audioCaptionMsg = createMessage({
		type: "video",
		caption: "!extractaudio",
		hasMedia: true,
		isViewOnce: true,
		group: groupId,
		author: `${userPn}@s.whatsapp.net`
	});
	audioCaptionMsg.downloadMedia = async () => ({
		mimetype: "image/png", // tipo não-áudio de propósito para validar passagem pelo CommandHandler e helper getMediaFromMessageOrQuote
		data: TINY_PNG_BASE64,
		isMessageMedia: true
	});
	bot.resetCapture();
	await commandHandler.executeFixedCommand(bot, audioCaptionMsg, extractCmd, [], groupObj);
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.ok(
		String(bot.capturedMessages[0].content).includes("Tipo de mídia não suportado: image"),
		"!extractaudio na legenda deve ler a mídia direta em vez de exigir quote"
	);

	console.log("✓ [2/4] OK");
}

async function testRoubarCommandAndEyeReaction() {
	console.log("[3/4] Testando !roubar e reação 👀...");
	const { bot, commandHandler, reactionHandler, groupObj, groupId, userPn } =
		await createTestPipeline();

	// Verifica documentação no LLM-HELPER.md (apenas !roubar, nunca !admin-roubar)
	const llmHelper = fs.readFileSync(path.join(__dirname, "../../docs/LLM-HELPER.md"), "utf8");
	assert.ok(llmHelper.includes("!roubar"), "docs/LLM-HELPER.md deve documentar !roubar");
	assert.ok(
		!llmHelper.includes("admin-roubar"),
		"docs/LLM-HELPER.md NUNCA deve expor !admin-roubar"
	);

	// 3.1 Reação 👀 em mensagem NORMAL (não view-once) deve ignorar 100% em silêncio
	const normalReactions = [];
	const normalMsg = createMessage({
		id: "MSG_NORMAL_1",
		type: "image",
		hasMedia: true,
		isViewOnce: false,
		group: groupId,
		author: "5511555555555@s.whatsapp.net",
		content: { mimetype: "image/png", data: TINY_PNG_BASE64, isMessageMedia: true }
	});
	normalMsg.origin.react = async (emoji) => normalReactions.push(emoji);
	bot.client._cachedMessages.set("MSG_NORMAL_1", normalMsg);

	bot.resetCapture();
	const handledNormal = await reactionHandler.processReaction(bot, {
		reaction: "👀",
		senderId: `${userPn}@s.whatsapp.net`,
		userName: "Curioso",
		msgId: { _serialized: "MSG_NORMAL_1" },
		chatId: groupId
	});
	assert.strictEqual(handledNormal, false, "👀 em mensagem normal deve retornar false");
	assert.strictEqual(
		bot.capturedMessages.length,
		0,
		"👀 em mensagem normal não deve enviar mensagens"
	);
	assert.strictEqual(normalReactions.length, 0, "👀 em mensagem normal não deve reagir");

	// 3.2 Reação 👀 em mídia VIEW-ONCE (com LID mapeado para PN) deve enviar no PV do solicitante
	const voReactions = [];
	const voMsg = createMessage({
		id: "MSG_VO_EYE_1",
		type: "image",
		hasMedia: true,
		isViewOnce: true,
		group: groupId,
		author: "5511444444444@s.whatsapp.net",
		authorName: "AutorVO",
		caption: "segredo",
		content: { mimetype: "image/png", data: TINY_PNG_BASE64, isMessageMedia: true }
	});
	voMsg.origin.isViewOnce = true;
	voMsg.origin.react = async (emoji) => voReactions.push(emoji);
	bot.client._cachedMessages.set("MSG_VO_EYE_1", voMsg);

	bot.resetCapture();
	const handledVO = await reactionHandler.processReaction(bot, {
		reaction: "👀",
		senderId: "999888777@lid",
		userName: "Ladrao",
		msgId: { _serialized: "MSG_VO_EYE_1" },
		chatId: groupId
	});
	assert.strictEqual(handledVO, true, "👀 em view-once deve ser tratado");
	assert.strictEqual(bot.capturedMessages.length, 1, "Deve enviar mídia no PV");
	assert.strictEqual(
		bot.capturedMessages[0].chatId,
		`${userPn}@s.whatsapp.net`,
		"Deve enviar no PV resolvido via LID->PN do usuário que reagiu, nunca no grupo"
	);
	assert.strictEqual(bot.capturedMessages[0].content.data, TINY_PNG_BASE64);
	assert.ok(voReactions.includes("✅"), "Deve reagir ✅ na view-once");

	// 3.3 Comando texto !roubar citando view-once áudio PTT
	const audioReactions = [];
	const quoteCmdMsg = createMessage({
		id: "CMD_ROUBAR_AUDIO",
		type: "text",
		content: "!roubar",
		group: groupId,
		author: userPn
	});
	quoteCmdMsg.origin.react = async (emoji) => audioReactions.push(emoji);
	quoteCmdMsg.origin.getQuotedMessage = async () => ({
		type: "audio",
		hasMedia: true,
		isViewOnce: true,
		authorName: "VozSecreta",
		goMessageData: { Message: { audioMessage: { ptt: true } } },
		downloadMedia: async () => ({
			mimetype: "audio/ogg; codecs=opus",
			data: "T2dnUw==",
			filename: "voice.ogg",
			isMessageMedia: true
		})
	});

	const roubarCmd = commandHandler.fixedCommands.getCommand("roubar");
	bot.resetCapture();
	await commandHandler.executeFixedCommand(bot, quoteCmdMsg, roubarCmd, [], groupObj);
	assert.strictEqual(bot.capturedMessages.length, 2, "Áudio VO deve enviar legenda + áudio no PV");
	assert.strictEqual(bot.capturedMessages[0].chatId, `${userPn}@s.whatsapp.net`);
	assert.strictEqual(bot.capturedMessages[1].chatId, `${userPn}@s.whatsapp.net`);
	assert.strictEqual(bot.capturedMessages[1].options.sendAudioAsVoice, true);

	console.log("✓ [3/4] OK");
}

async function testAdminRoubarCommandAndAlienReaction() {
	console.log("[4/4] Testando !admin-roubar oculto e reação 👽 silenciosa...");
	const { bot, commandHandler, reactionHandler, groupObj, groupId, adminPn, userPn } =
		await createTestPipeline();

	const adminCmd = commandHandler.fixedCommands.getCommand("admin-roubar");
	assert.ok(adminCmd, "Comando !admin-roubar deve estar registrado");
	assert.strictEqual(adminCmd.hidden, true, "!admin-roubar deve ter hidden: true");
	assert.strictEqual(adminCmd.reply, false, "!admin-roubar deve ter reply: false");

	const alienReactions = [];
	const voAdminMsg = createMessage({
		id: "MSG_VO_ALIEN_1",
		type: "image",
		hasMedia: true,
		isViewOnce: true,
		group: groupId,
		author: "5511333333333@s.whatsapp.net",
		authorName: "Suspeito",
		caption: "top secret",
		content: { mimetype: "image/png", data: TINY_PNG_BASE64, isMessageMedia: true }
	});
	voAdminMsg.origin.isViewOnce = true;
	voAdminMsg.origin.react = async (emoji) => alienReactions.push(emoji);
	bot.client._cachedMessages.set("MSG_VO_ALIEN_1", voAdminMsg);

	// 4.1 Não-admin reage 👽 -> ZERO resposta, ZERO PV, ZERO reação
	bot.resetCapture();
	const nonAdminHandled = await reactionHandler.processReaction(bot, {
		reaction: "👽",
		senderId: `${userPn}@s.whatsapp.net`,
		userName: "Comum",
		msgId: { _serialized: "MSG_VO_ALIEN_1" },
		chatId: groupId
	});
	assert.strictEqual(nonAdminHandled, false, "Não-admin reagindo 👽 deve retornar false");
	assert.strictEqual(bot.capturedMessages.length, 0, "Não-admin não deve receber nada");
	assert.strictEqual(alienReactions.length, 0, "Não-admin não deve gerar reação no grupo");

	// 4.2 Admin reage 👽 -> envia SOMENTE no PV do admin, ZERO reação/mensagem no grupo
	bot.resetCapture();
	const adminHandled = await reactionHandler.processReaction(bot, {
		reaction: "👽",
		senderId: `${adminPn}@s.whatsapp.net`,
		userName: "Admin",
		msgId: { _serialized: "MSG_VO_ALIEN_1" },
		chatId: groupId
	});
	assert.strictEqual(adminHandled, true, "Admin reagindo 👽 em VO deve retornar true");
	assert.strictEqual(bot.capturedMessages.length, 1, "Deve enviar exatamente 1 mensagem no PV");
	assert.strictEqual(bot.capturedMessages[0].chatId, `${adminPn}@s.whatsapp.net`);
	assert.strictEqual(bot.capturedMessages[0].content.data, TINY_PNG_BASE64);
	assert.strictEqual(
		alienReactions.length,
		0,
		"!admin-roubar NUNCA deve reagir na mensagem do grupo"
	);
	assert.ok(
		!bot.capturedMessages[0].options?.quotedMessageId,
		"Não deve ter quotedMessageId ao encaminhar silenciosamente para PV"
	);

	// 4.3 Não-admin digita !admin-roubar citando VO -> ZERO resposta, ZERO reação
	const nonAdminTextReactions = [];
	const nonAdminTextCmd = createMessage({
		id: "CMD_ADMIN_ROUBAR_FAIL",
		type: "text",
		content: "!admin-roubar",
		group: groupId,
		author: `${userPn}@s.whatsapp.net`
	});
	nonAdminTextCmd.origin.react = async (emoji) => nonAdminTextReactions.push(emoji);
	nonAdminTextCmd.origin.getQuotedMessage = async () => voAdminMsg;

	bot.resetCapture();
	await commandHandler.executeFixedCommand(bot, nonAdminTextCmd, adminCmd, [], groupObj);
	assert.strictEqual(bot.capturedMessages.length, 0);
	assert.strictEqual(nonAdminTextReactions.length, 0);

	console.log("✓ [4/5] OK");
}

async function testRoubarCategoryAndMute() {
	console.log(
		"\n--- [5/5] Testando categoria grupo e !g-mute / !g-muteCategoria para !roubar e 👀 ---"
	);
	const { bot, commandHandler, reactionHandler, groupObj, groupId, adminPn, userPn } =
		await createTestPipeline();

	// Em produção (WhatsAppBotGo), ReactionsHandler fica em bot.reactionHandler
	bot.reactionHandler = reactionHandler;
	if (!bot.eventHandler) {
		bot.eventHandler = { commandHandler };
	}
	commandHandler.customCommands[groupObj.id] = [];
	if (commandHandler.management?.database) {
		commandHandler.management.database.saveGroup = async () => true;
	}

	// 5.1 Verificar categoria "grupo" no !roubar e !admin-roubar
	const roubarCmd = commandHandler.fixedCommands.getCommand("roubar");
	const adminRoubarCmd = commandHandler.fixedCommands.getCommand("admin-roubar");
	assert.ok(roubarCmd, "Comando roubar deve estar registrado");
	assert.strictEqual(roubarCmd.category, "grupo", "!roubar deve estar na categoria 'grupo'");
	assert.strictEqual(
		adminRoubarCmd.category,
		"grupo",
		"!admin-roubar deve estar na categoria 'grupo'"
	);
	assert.strictEqual(adminRoubarCmd.hidden, true, "!admin-roubar deve permanecer oculto");

	const voMsgId = `vo-mute-target-${Date.now()}`;
	const voTargetMsg = createMessage({
		type: "image",
		group: groupId,
		author: adminPn,
		isViewOnce: true,
		content: {
			mimetype: "image/jpeg",
			data: TINY_PNG_BASE64,
			filename: "vo-mute.jpg"
		},
		origin: {
			id: { id: voMsgId, _serialized: voMsgId },
			type: "image",
			isViewOnce: true,
			downloadMedia: async () => ({
				mimetype: "image/jpeg",
				data: TINY_PNG_BASE64,
				filename: "vo-mute.jpg"
			})
		}
	});
	bot.recoverMsgFromCache = async () => voTargetMsg;
	bot.client.getMessageById = async () => voTargetMsg;

	const adminCmdMsg = createMessage({
		content: "!g-mute roubar",
		group: groupId,
		author: adminPn,
		authorName: "Admin"
	});

	// 5.2 !g-mute roubar bloqueia texto !roubar e reação 👀
	const muteRes = await commandHandler.management.muteCommand(
		bot,
		adminCmdMsg,
		["roubar"],
		groupObj
	);
	assert.ok(
		muteRes.content.includes("silenciado") && muteRes.content.includes("roubar"),
		`Deve confirmar mute do roubar. Recebido: ${muteRes.content}`
	);
	assert.ok(!muteRes.content.includes("admin-roubar"), "Mutar roubar não deve expor admin-roubar");
	assert.ok(groupObj.mutedCommands.includes("roubar"), "group.mutedCommands deve conter roubar");

	const textReactions = [];
	const textRoubarMsg = createMessage({
		content: "!roubar",
		group: groupId,
		author: userPn,
		authorName: "Membro",
		hasQuotedMsg: true,
		origin: {
			react: async (emoji) => {
				textReactions.push(emoji);
			},
			getQuotedMessage: async () => voTargetMsg.origin
		}
	});

	bot.resetCapture();
	await commandHandler.processCommand(bot, textRoubarMsg, "roubar", [], groupObj);
	assert.strictEqual(bot.capturedMessages.length, 0, "!roubar mutado não deve enviar PV");
	assert.ok(textReactions.includes("⛔️"), "!roubar mutado por texto deve reagir ⛔️");

	bot.resetCapture();
	const eyeReactionPayload = {
		reaction: "👀",
		senderId: userPn,
		userName: "Membro",
		msgId: { _serialized: voMsgId },
		chatId: groupId,
		targetFromMe: false
	};
	const handledMutedEye = await reactionHandler.processReaction(bot, eyeReactionPayload);
	assert.strictEqual(handledMutedEye, false, "Reação 👀 deve ser ignorada com roubar mutado");
	assert.strictEqual(bot.capturedMessages.length, 0, "Reação 👀 mutada não deve enviar PV");

	// 5.3 !g-mute 👀 desmuta usando o próprio emoji e permite 👀 novamente
	const unmuteByEmojiRes = await commandHandler.management.muteCommand(
		bot,
		adminCmdMsg,
		["👀"],
		groupObj
	);
	assert.ok(
		unmuteByEmojiRes.content.includes("reativado"),
		`!g-mute 👀 deve reativar roubar. Recebido: ${unmuteByEmojiRes.content}`
	);
	assert.ok(!groupObj.mutedCommands.includes("roubar"), "roubar deve sair de mutedCommands");

	bot.resetCapture();
	const handledUnmutedEye = await reactionHandler.processReaction(bot, eyeReactionPayload);
	assert.strictEqual(handledUnmutedEye, true, "Reação 👀 deve voltar a funcionar após unmute");
	assert.strictEqual(bot.capturedMessages.length, 1, "Deve enviar mídia no PV após unmute");
	assert.strictEqual(
		bot.capturedMessages[0].chatId,
		`${userPn.split("@")[0]}@s.whatsapp.net`,
		"Envio deve ir para PV do membro"
	);

	// 5.4 !g-mute 👀 muta novamente via emoji
	const remuteByEmojiRes = await commandHandler.management.muteCommand(
		bot,
		adminCmdMsg,
		["👀"],
		groupObj
	);
	assert.ok(
		remuteByEmojiRes.content.includes("silenciado") && groupObj.mutedCommands.includes("roubar"),
		"!g-mute 👀 deve silenciar roubar novamente"
	);
	bot.resetCapture();
	const handledRemutedEye = await reactionHandler.processReaction(bot, eyeReactionPayload);
	assert.strictEqual(handledRemutedEye, false, "Reação 👀 mutada via emoji deve ser bloqueada");
	assert.strictEqual(bot.capturedMessages.length, 0);

	// 5.5 !g-muteCategoria grupo bloqueia !roubar (texto) e reação 👀
	groupObj.mutedCommands = [];
	const muteCatRes = await commandHandler.management.toggleMuteCategory(
		bot,
		adminCmdMsg,
		["grupo"],
		groupObj
	);
	assert.ok(
		muteCatRes.content.includes("silenciada") && groupObj.mutedCategories.includes("grupo"),
		"Categoria grupo deve ser silenciada via !g-muteCategoria grupo"
	);

	bot.resetCapture();
	await commandHandler.processCommand(bot, textRoubarMsg, "roubar", [], groupObj);
	assert.strictEqual(
		bot.capturedMessages.length,
		0,
		"!roubar não deve executar com categoria grupo mutada"
	);

	bot.resetCapture();
	const handledCatMutedEye = await reactionHandler.processReaction(bot, eyeReactionPayload);
	assert.strictEqual(
		handledCatMutedEye,
		false,
		"Reação 👀 deve ser ignorada quando categoria grupo está mutada"
	);
	assert.strictEqual(
		bot.capturedMessages.length,
		0,
		"Reação 👀 com categoria grupo mutada não deve enviar PV"
	);

	// Reativa categoria grupo e confirma que 👀 funciona de novo
	await commandHandler.management.toggleMuteCategory(bot, adminCmdMsg, ["grupo"], groupObj);
	assert.ok(!groupObj.mutedCategories.includes("grupo"));
	bot.resetCapture();
	const handledCatUnmutedEye = await reactionHandler.processReaction(bot, eyeReactionPayload);
	assert.strictEqual(handledCatUnmutedEye, true, "Reação 👀 deve voltar após reativar categoria");
	assert.strictEqual(bot.capturedMessages.length, 1);

	console.log("✓ [5/5] OK");
}

async function main() {
	await testWhatsAppBotGoViewOnce();
	await testCaptionMediaCommands();
	await testRoubarCommandAndEyeReaction();
	await testAdminRoubarCommandAndAlienReaction();
	await testRoubarCategoryAndMute();
	console.log("\n✅ Todos os testes de view-once passaram!");
}

main()
	.then(() => {
		process.exit(0);
	})
	.catch((err) => {
		console.error("❌ Falha nos testes:", err);
		process.exit(1);
	});
