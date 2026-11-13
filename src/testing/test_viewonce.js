process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const { EventEmitter } = require("events");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const EventHandler = require("../EventHandler");
const ReactionsHandler = require("../ReactionsHandler");

// PNG 1x1 válido (pixel vermelho) para testes reais com Sharp/Stickers
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function createMockWhatsAppBotGo({ viewOnceCaptureEnabled = true } = {}) {
	const bot = Object.create(WhatsAppBotGo.prototype);
	bot.id = "bot-go-teste";
	bot.phoneNumber = "5511999999999";
	bot.nomeExibir = "RavenaTest";
	bot.viewOnceMediaCache = new Map();
	bot.viewOnceCaptureEnabled = viewOnceCaptureEnabled;
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
	console.log(
		"[1/4] Testando WhatsAppBotGo unwrapping, cache e unavailable view-once (VIEW_ONCE_CAPTURE_ENABLED=true)..."
	);
	const bot = createMockWhatsAppBotGo({ viewOnceCaptureEnabled: true });

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

function buildGoMessage({
	id,
	chat = "120363000111222@g.us",
	sender,
	senderAlt,
	message,
	isGroup = true,
	extra = {}
}) {
	return {
		Info: {
			ID: id,
			Chat: chat,
			Sender: sender,
			SenderAlt: senderAlt,
			Timestamp: new Date().toISOString(),
			PushName: "Pessoa",
			IsGroup: isGroup,
			IsFromMe: false
		},
		Message: message,
		...extra
	};
}

async function testViewOnceCaptureDisabled() {
	console.log("[1b] Testando view-once com captura desligada (padrão)...");
	const prevEnv = process.env.VIEW_ONCE_CAPTURE_ENABLED;
	delete process.env.VIEW_ONCE_CAPTURE_ENABLED;
	const realBot = new WhatsAppBotGo({
		id: "vo-flag-default",
		phoneNumber: "5511999990000",
		whatsgoApiUrl: "http://localhost:8080",
		whatsgoApiKey: "test-key",
		instanceName: "vo-flag-default",
		webhookHost: "http://localhost:3000"
	});
	assert.strictEqual(
		realBot.viewOnceCaptureEnabled,
		false,
		"Captura deve vir desligada por padrão"
	);
	if (prevEnv !== undefined) process.env.VIEW_ONCE_CAPTURE_ENABLED = prevEnv;

	const bot = createMockWhatsAppBotGo({ viewOnceCaptureEnabled: false });
	const authorA = "5511777770001@s.whatsapp.net";
	const userB = "5511777770002@s.whatsapp.net";

	// 1. viewOnceMedia vindo do whatsgo não é guardada (nem no cache, nem no objeto)
	const voGo = buildGoMessage({
		id: "VO_OFF_1",
		sender: authorA,
		message: { imageMessage: { mimetype: "image/png", caption: "!s", viewOnce: true } },
		extra: {
			IsViewOnce: true,
			viewOnceMedia: { base64: TINY_PNG_BASE64, mimetype: "image/png" }
		}
	});
	const voMsg = await bot.formatMessageFromGo(voGo);
	assert.strictEqual(voMsg.isViewOnce, true);
	assert.strictEqual(bot.viewOnceMediaCache.size, 0, "Sem captura não há cache em RAM");
	assert.strictEqual(voMsg.goMessageData.viewOnceMedia, undefined, "base64 não fica na mensagem");
	assert.strictEqual(bot._cacheViewOnceMedia("X", { base64: TINY_PNG_BASE64 }), false);

	// 2. O próprio autor (!s na legenda) ainda consegue baixar, sem pedir a cópia por messageId
	bot.downloadedPayloads.length = 0;
	const ownMedia = await voMsg.downloadMedia();
	assert.ok(ownMedia?.data, "Autor pedindo a própria mídia deve conseguir baixar");
	assert.strictEqual(bot.downloadedPayloads.length, 1);
	assert.strictEqual(
		bot.downloadedPayloads[0].body.messageId,
		undefined,
		"Sem captura não pede ao whatsgo a cópia guardada por messageId"
	);

	// 3. Outra pessoa citando a view-once (ex.: !s, !getaudio, !lembrete): recusado
	const quoteContext = {
		stanzaID: "VO_OFF_1",
		participant: authorA,
		quotedMessage: {
			viewOnceMessageV2: {
				message: { imageMessage: { mimetype: "image/png", viewOnce: true } }
			}
		}
	};
	const quotingByB = await bot.formatMessageFromGo(
		buildGoMessage({
			id: "CMD_B_1",
			sender: userB,
			message: { extendedTextMessage: { text: "!s", contextInfo: quoteContext } }
		}),
		true
	);
	bot.downloadedPayloads.length = 0;
	const quotedForB = await quotingByB.origin.getQuotedMessage();
	assert.strictEqual(quotedForB.isViewOnce, true);
	assert.strictEqual(
		await quotedForB.downloadMedia(),
		null,
		"Terceiro citando view-once não pode baixar a mídia"
	);
	assert.strictEqual(bot.downloadedPayloads.length, 0, "Nem chega a chamar o whatsgo");

	// Mesmo fluxo, mas quem cita é o autor: permitido (via contextInfo e via cache)
	const quotingByA = await bot.formatMessageFromGo(
		buildGoMessage({
			id: "CMD_A_1",
			sender: "111222333444@lid",
			senderAlt: authorA,
			message: { extendedTextMessage: { text: "!s", contextInfo: quoteContext } }
		}),
		true
	);
	const quotedForA = await quotingByA.origin.getQuotedMessage();
	assert.ok((await quotedForA.downloadMedia())?.data, "Autor citando a própria view-once baixa");

	// 4. Reação de terceiro na view-once (mensagem recuperada do cache): recusado
	const recovered = await bot.recoverMsgFromCache("VO_OFF_1");
	recovered.originReaction = { senderId: userB, reaction: "👀" };
	assert.strictEqual(await recovered.downloadMedia(), null, "Reação de terceiro não baixa");
	recovered.originReaction = { senderId: authorA, reaction: "👀" };
	assert.ok((await recovered.downloadMedia())?.data, "Reação do próprio autor baixa");

	// 5. Mídia comum (não view-once) citada por terceiros continua funcionando
	const normalQuote = await bot.formatMessageFromGo(
		buildGoMessage({
			id: "CMD_B_2",
			sender: userB,
			message: {
				extendedTextMessage: {
					text: "!s",
					contextInfo: {
						stanzaID: "IMG_NORMAL_1",
						participant: authorA,
						quotedMessage: { imageMessage: { mimetype: "image/png" } }
					}
				}
			}
		}),
		true
	);
	const normalQuoted = await normalQuote.origin.getQuotedMessage();
	assert.ok((await normalQuoted.downloadMedia())?.data, "Mídia normal citada deve baixar");

	// 6. Auto-STT de grupo ignora áudio de visualização única
	const SpeechCommands = require("../functions/SpeechCommands");
	let sttDownloaded = false;
	const sttResult = await SpeechCommands.processAutoSTT(
		{ id: "stt-bot", ignorePV: false },
		{
			type: "voice",
			isViewOnce: true,
			group: "120363000111222@g.us",
			author: authorA,
			origin: { isViewOnce: true, react: async () => {} },
			downloadMedia: async () => {
				sttDownloaded = true;
				return null;
			}
		},
		{ id: "120363000111222@g.us", autoStt: true }
	);
	assert.strictEqual(sttResult, false, "Auto-STT não deve processar view-once");
	assert.strictEqual(sttDownloaded, false, "Auto-STT nem baixa a mídia view-once");
	console.log("✓ [1b] OK");
}

async function testViewOnceCacheBounds() {
	console.log("[1c] Testando limites de bytes/TTL do cache de view-once...");
	const bot = createMockWhatsAppBotGo({ viewOnceCaptureEnabled: true });
	const payload = (bytes) => ({
		base64: Buffer.alloc(bytes, 1).toString("base64"),
		mimetype: "image/png"
	});
	bot.viewOnceCacheMaxBytes = 2500;
	bot.viewOnceCacheMaxItemBytes = 2000;
	bot.viewOnceCacheTtlMs = 60 * 1000;

	assert.strictEqual(bot._cacheViewOnceMedia("A", payload(1000)), true);
	assert.strictEqual(bot._cacheViewOnceMedia("B", payload(1000)), true);
	assert.strictEqual(bot._cacheViewOnceMedia("C", payload(1000)), true);
	const totalBytes = Array.from(bot.viewOnceMediaCache.values()).reduce((a, e) => a + e.bytes, 0);
	assert.ok(totalBytes <= 2500, `Total em RAM (${totalBytes}) deve respeitar o limite de bytes`);
	assert.strictEqual(bot.viewOnceMediaCache.has("A"), false, "Mais antigo é removido primeiro");
	assert.ok(bot.viewOnceMediaCache.has("B") && bot.viewOnceMediaCache.has("C"));

	assert.strictEqual(
		bot._cacheViewOnceMedia("GRANDE", payload(2001)),
		false,
		"Item acima do limite individual não entra no cache"
	);
	assert.strictEqual(bot.viewOnceMediaCache.has("GRANDE"), false);

	// TTL: item expirado não é usado e sai do cache
	bot.viewOnceMediaCache.get("B").ts = Date.now() - 2 * 60 * 1000;
	assert.strictEqual(bot._getCachedViewOnceMedia("B"), null);
	assert.strictEqual(bot.viewOnceMediaCache.has("B"), false);
	assert.ok(bot._getCachedViewOnceMedia("C"), "Item dentro do TTL continua disponível");

	// Limite por quantidade continua valendo
	bot.viewOnceCacheMaxBytes = 50 * 1024 * 1024;
	bot.viewOnceCacheMaxEntries = 3;
	for (const id of ["D", "E", "F", "G"]) bot._cacheViewOnceMedia(id, payload(10));
	assert.ok(bot.viewOnceMediaCache.size <= 3);
	console.log("✓ [1c] OK");
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

async function testDisabledCommandsAndRegistrations() {
	console.log("[3/4] Testando desativação dos comandos !roubar / !admin-roubar e reações...");
	const { bot, commandHandler, reactionHandler, groupId, adminPn, userPn } =
		await createTestPipeline();

	// Comandos desativados não devem estar registrados nem expostos no helper/LLM-HELPER
	assert.strictEqual(
		commandHandler.fixedCommands.getCommand("roubar"),
		null,
		"Comando !roubar deve estar desativado"
	);
	assert.strictEqual(
		commandHandler.fixedCommands.getCommand("admin-roubar"),
		null,
		"Comando !admin-roubar deve estar desativado"
	);

	const CommandsHelper = require("../utils/CommandsHelper");
	const commandsHelper = CommandsHelper.getInstance();
	commandsHelper.loadHelpers();
	assert.strictEqual(
		commandsHelper.findCommandMeta("roubar"),
		null,
		"CommandsHelper não deve indexar !roubar enquanto desativado"
	);

	// O contexto que a IA de ajuda recebe hoje vem do catálogo dinâmico (não mais do LLM-HELPER.md)
	const aiBaseContext = commandsHelper.getBaseHelpContext();
	assert.ok(
		!aiBaseContext.includes("!roubar"),
		"Contexto base da IA não deve documentar !roubar desativado"
	);
	assert.ok(
		!aiBaseContext.includes("admin-roubar"),
		"Contexto base da IA NUNCA deve expor !admin-roubar"
	);
	assert.ok(!/!sa-/i.test(aiBaseContext), "Contexto base da IA NUNCA deve expor comandos !sa-");
	for (const restricted of ["admin-roubar", "sa-joinGrupo", "!sa-addDonate"]) {
		const details = commandsHelper.getCommandDetails(restricted);
		assert.ok(
			!details.includes("🤖 **Comando:**") && !/!sa-|!admin-/i.test(details),
			`get_command_info não pode documentar comando restrito (${restricted}): ${details}`
		);
	}

	const voReactions = [];
	const voMsg = createMessage({
		id: "MSG_VO_DISABLED_1",
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
	bot.client._cachedMessages.set("MSG_VO_DISABLED_1", voMsg);

	// Reação 👀 não deve acionar nada enquanto desativado
	bot.resetCapture();
	const eyeHandled = await reactionHandler.processReaction(bot, {
		reaction: "👀",
		senderId: `${userPn}@s.whatsapp.net`,
		userName: "Curioso",
		msgId: { _serialized: "MSG_VO_DISABLED_1" },
		chatId: groupId
	});
	assert.strictEqual(eyeHandled, false, "Reação 👀 deve retornar false quando desativada");
	assert.strictEqual(bot.capturedMessages.length, 0);
	assert.strictEqual(voReactions.length, 0);

	// Reação 👽 não deve acionar nada enquanto desativado
	bot.resetCapture();
	const alienHandled = await reactionHandler.processReaction(bot, {
		reaction: "👽",
		senderId: `${adminPn}@s.whatsapp.net`,
		userName: "Admin",
		msgId: { _serialized: "MSG_VO_DISABLED_1" },
		chatId: groupId
	});
	assert.strictEqual(alienHandled, false, "Reação 👽 deve retornar false quando desativada");
	assert.strictEqual(bot.capturedMessages.length, 0);
	assert.strictEqual(voReactions.length, 0);

	console.log("✓ [3/4] OK");
}

async function testPreservedViewOnceMethods() {
	console.log("[4/4] Testando métodos preservados de ViewOnceCommands para uso futuro...");
	const ViewOnceCommands = require("../functions/ViewOnceCommands");
	const { bot, groupObj, groupId, adminPn, userPn } = await createTestPipeline();

	assert.strictEqual(typeof ViewOnceCommands.handleRoubarCommand, "function");
	assert.strictEqual(typeof ViewOnceCommands.handleAdminRoubarCommand, "function");
	assert.strictEqual(typeof ViewOnceCommands.forwardViewOnceToPv, "function");

	// Se reativado, encaminhar no PV exige interação prévia no privado (PvSafety)
	const PvSafetyService = require("../services/PvSafetyService");
	const pvSafety = PvSafetyService.getInstance();
	pvSafety.resetTestState();
	const coldQuote = {
		type: "image",
		hasMedia: true,
		isViewOnce: true,
		content: { mimetype: "image/png", data: TINY_PNG_BASE64, isMessageMedia: true }
	};
	const coldCmd = createMessage({
		id: "CMD_ROUBAR_COLD",
		type: "text",
		content: "!roubar",
		group: groupId,
		author: `${userPn}@s.whatsapp.net`
	});
	coldCmd.origin.getQuotedMessage = async () => coldQuote;
	const coldRet = await ViewOnceCommands.handleRoubarCommand(bot, coldCmd, [], groupObj);
	assert.strictEqual(coldRet.chatId, groupId, "Sem PV prévio responde no grupo");
	assert.strictEqual(coldRet.content, pvSafety.PV_REQUIRED_MESSAGE);
	const coldAdminCmd = createMessage({
		id: "CMD_ADMIN_ROUBAR_COLD",
		type: "text",
		content: "!admin-roubar",
		group: groupId,
		author: `${adminPn}@s.whatsapp.net`
	});
	coldAdminCmd.origin.getQuotedMessage = async () => coldQuote;
	assert.strictEqual(
		await ViewOnceCommands.handleAdminRoubarCommand(bot, coldAdminCmd, [], groupObj),
		false,
		"Modo silencioso de admin sem PV prévio apenas ignora"
	);
	await pvSafety.recordPvInteraction(bot, `${userPn}@s.whatsapp.net`);
	await pvSafety.recordPvInteraction(bot, `${adminPn}@s.whatsapp.net`);

	// handleRoubarCommand via quote
	const reactions = [];
	const quotedVoAudio = {
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
	};
	const quoteCmdMsg = createMessage({
		id: "CMD_ROUBAR_PRESERVED",
		type: "text",
		content: "!roubar",
		group: groupId,
		author: userPn
	});
	quoteCmdMsg.origin.react = async (emoji) => reactions.push(emoji);
	quoteCmdMsg.origin.getQuotedMessage = async () => quotedVoAudio;

	const roubarRet = await ViewOnceCommands.handleRoubarCommand(bot, quoteCmdMsg, [], groupObj);
	assert.ok(
		Array.isArray(roubarRet) && roubarRet.length === 2,
		"Áudio VO deve retornar legenda + áudio"
	);
	assert.strictEqual(roubarRet[0].chatId, `${userPn}@s.whatsapp.net`);
	assert.strictEqual(roubarRet[1].chatId, `${userPn}@s.whatsapp.net`);
	assert.strictEqual(roubarRet[1].options.sendAudioAsVoice, true);
	assert.ok(reactions.includes("✅"));

	// handleAdminRoubarCommand: ignora não-admin e encaminha em silêncio para admin
	const adminReactions = [];
	const voImage = createMessage({
		id: "MSG_VO_PRESERVED_IMG",
		type: "image",
		hasMedia: true,
		isViewOnce: true,
		group: groupId,
		author: "5511333333333@s.whatsapp.net",
		authorName: "Suspeito",
		caption: "top secret",
		content: { mimetype: "image/png", data: TINY_PNG_BASE64, isMessageMedia: true }
	});
	voImage.origin.isViewOnce = true;
	voImage.origin.react = async (emoji) => adminReactions.push(emoji);

	const nonAdminQuotedMsg = createMessage({
		id: "CMD_ADMIN_PRESERVED_FAIL",
		type: "text",
		content: "!admin-roubar",
		group: groupId,
		author: `${userPn}@s.whatsapp.net`
	});
	nonAdminQuotedMsg.origin.getQuotedMessage = async () => voImage;
	const nonAdminRet = await ViewOnceCommands.handleAdminRoubarCommand(
		bot,
		nonAdminQuotedMsg,
		[],
		groupObj
	);
	assert.strictEqual(nonAdminRet, false, "Não-admin deve retornar false silenciosamente");

	const adminQuotedMsg = createMessage({
		id: "CMD_ADMIN_PRESERVED_OK",
		type: "text",
		content: "!admin-roubar",
		group: groupId,
		author: `${adminPn}@s.whatsapp.net`
	});
	adminQuotedMsg.origin.getQuotedMessage = async () => voImage;
	const adminRet = await ViewOnceCommands.handleAdminRoubarCommand(
		bot,
		adminQuotedMsg,
		[],
		groupObj
	);
	assert.ok(adminRet, "Admin deve receber ReturnMessage no PV");
	assert.strictEqual(adminRet.chatId, `${adminPn}@s.whatsapp.net`);
	assert.strictEqual(adminRet.content.data, TINY_PNG_BASE64);
	assert.strictEqual(adminReactions.length, 0, "Admin silencioso não deve reagir no grupo");

	console.log("✓ [4/4] OK");
}

async function main() {
	await testWhatsAppBotGoViewOnce();
	await testViewOnceCaptureDisabled();
	await testViewOnceCacheBounds();
	await testCaptionMediaCommands();
	await testDisabledCommandsAndRegistrations();
	await testPreservedViewOnceMethods();
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
