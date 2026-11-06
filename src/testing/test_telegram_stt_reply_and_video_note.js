/**
 * Testes: reply (quote) no Telegram + transcrição de "video note" (vídeo redondo).
 *
 * Cobre:
 *  1. Resolução do ID de reply a partir de quotedMessageId / goReply / quotedMsgId
 *  2. Envio real (stub do TelegramClient) com reply_to_message_id + fallback sem reply
 *  3. Múltiplos pedaços de uma mensagem longa: apenas o primeiro responde
 *  4. formatMessageFromTelegram: video_note vira tipo transcrevível + hasQuotedMsg
 *  5. Auto-STT: video note é transcrito; vídeo comum é ignorado
 */
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TelegramBot = require("../TelegramBot");
const EventHandler = require("../EventHandler");
const SpeechCommands = require("../functions/SpeechCommands");
const ReturnMessage = require("../models/ReturnMessage");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");

function buildTelegramBot() {
	const bot = new TelegramBot({
		id: "tg-test",
		telegramBotToken: "123456:TEST_TOKEN-ABC",
		eventHandler: null,
		webhookHost: null
	});

	bot.isConnected = true;

	const sent = [];
	sent.__failCount = 0;
	bot.apiClient = {
		sendMessage: async (chatId, text, opts) => {
			sent.push({ kind: "text", chatId, text, opts });
			return { chat: { id: chatId }, from: { id: 1 }, message_id: 999 };
		},
		sendAudio: async (chatId, buf, opts) => {
			sent.push({ kind: "audio", chatId, opts });
			return { chat: { id: chatId }, from: { id: 1 }, message_id: 998 };
		},
		getChat: async () => null,
		getChatAdministrators: async () => [],
		downloadFile: async () => Buffer.from("fake").toString("base64")
	};

	return { bot, sent };
}

async function testReplyResolution() {
	console.log("1. Resolução do ID de reply no Telegram...");
	const { bot, sent } = buildTelegramBot();

	await bot.sendMessage("-1001234567890", "transcrição qualquer", {
		quotedMessageId: "-1001234567890_555111_42",
		goReply: { id: { _serialized: "-1001234567890_555111_42" }, key: { id: "42" } }
	});
	assert.strictEqual(
		sent[0].opts.reply_to_message_id,
		42,
		"quotedMessageId deve virar reply_to_message_id"
	);
	assert.strictEqual(sent[0].opts.allow_sending_without_reply, true);

	await bot.sendMessage("-1001234567890", "apenas goReply", {
		goReply: { id: { _serialized: "-100999_777_1001" } }
	});
	assert.strictEqual(sent[1].opts.reply_to_message_id, 1001, "goReply deve ser usado como reply");

	await bot.sendMessage("-1001234567890", "id puro", { quotedMsgId: "4242" });
	assert.strictEqual(sent[2].opts.reply_to_message_id, 4242);

	await bot.sendMessage("-1001234567890", "sem reply", {});
	assert.strictEqual(
		sent[3].opts.reply_to_message_id,
		undefined,
		"sem referência não deve responder"
	);

	console.log("✓ 1. Reply resolvido corretamente para todas as variações de ID.\n");
}

async function testReplyFallback() {
	console.log("2. Fallback quando a mensagem respondida não existe...");
	const { bot, sent } = buildTelegramBot();
	sent.__failCount = 0;
	bot.apiClient.sendMessage = async (chatId, text, opts) => {
		sent.push({ kind: "text", chatId, text, opts });
		sent.__failCount++;
		if (opts.reply_to_message_id) {
			throw new Error("Bad Request: reply message not found");
		}
		return { chat: { id: chatId }, from: { id: 1 }, message_id: 777 };
	};

	const result = await bot.sendMessage("-100123", "resposta", {
		quotedMessageId: "-100123_555_42"
	});

	assert.strictEqual(sent.__failCount, 2, "deve tentar com reply e depois sem reply");
	assert.ok(sent[0].opts.reply_to_message_id, "1ª tentativa com reply");
	assert.strictEqual(sent[1].opts.reply_to_message_id, undefined, "2ª tentativa sem reply");
	assert.strictEqual(result.messageId, 777, "mensagem enviada no fallback");

	console.log("✓ 2. Fallback sem reply aplicado quando o alvo não existe.\n");
}

async function testSplitChunksSingleReply() {
	console.log("3. Mensagem dividida em pedaços responde apenas a primeira vez...");
	const { bot, sent } = buildTelegramBot();

	const longText = `${"palavra ".repeat(600)}FIM`;
	await bot.sendReturnMessages(
		new ReturnMessage({
			chatId: "-100123",
			content: longText,
			options: {
				quotedMessageId: "-100123_555_42",
				goReply: { id: { _serialized: "-100123_555_42" } }
			}
		})
	);

	assert.ok(sent.length > 1, "mensagem longa deve ser dividida");
	const withReply = sent.filter((s) => s.opts.reply_to_message_id);
	assert.strictEqual(withReply.length, 1, "somente o primeiro pedaço responde");

	console.log(`✓ 3. ${sent.length} pedaços enviados, apenas 1 com reply.\n`);
}

async function testFormatVideoNote() {
	console.log("4. Leitura do 'video note' (vídeo redondo) do Telegram...");
	const { bot } = buildTelegramBot();

	const tgMessage = {
		message_id: 55,
		date: Math.floor(Date.now() / 1000),
		chat: { id: -1001234567890, type: "supergroup", title: "Grupo Teste" },
		from: { id: 555111, first_name: "Testador" },
		video_note: {
			file_id: "ABC123",
			file_size: 12345,
			duration: 7,
			length: 240
		},
		reply_to_message: {
			message_id: 42,
			chat: { id: -1001234567890, type: "supergroup" },
			from: { id: 555111, first_name: "Outro" },
			text: "mensagem anterior"
		}
	};

	const formatted = await bot.formatMessageFromTelegram(tgMessage);
	assert.ok(formatted, "video_note não pode mais ser descartado");
	assert.strictEqual(formatted.type, "video_note");
	assert.strictEqual(formatted.hasMedia, true);
	assert.strictEqual(formatted.content.mimetype, "video/mp4");
	assert.strictEqual(formatted.hasQuotedMsg, true, "reply_to_message deve marcar hasQuotedMsg");
	assert.strictEqual(formatted.quotedMsgId, "-1001234567890_555111_42");

	const media = await formatted.downloadMedia();
	assert.ok(media && media.data, "downloadMedia deve retornar a mídia");
	assert.strictEqual(media.mimetype, "video/mp4");

	assert.strictEqual(
		SpeechCommands.isVoiceLikeType(formatted.type),
		true,
		"video_note deve ser tratado como mensagem de voz"
	);
	assert.strictEqual(SpeechCommands.isVoiceLikeType("video"), false, "vídeo comum fica de fora");
	assert.strictEqual(
		SpeechCommands.isTranscribableMedia({ mimetype: "video/mp4" }, "video_note"),
		true,
		"video note deve ser transcrevível"
	);
	assert.strictEqual(
		SpeechCommands.isTranscribableMedia({ mimetype: "video/mp4" }, "video"),
		false,
		"vídeo comum não é transcrito automaticamente"
	);
	assert.strictEqual(
		SpeechCommands.isTranscribableMedia({ mimetype: "audio/ogg; codecs=opus" }, "ptt"),
		true,
		"áudio do WhatsApp continua transcrevível"
	);
	assert.strictEqual(SpeechCommands.getExtensionForMimetype("video/mp4"), "mp4");
	assert.strictEqual(SpeechCommands.getExtensionForMimetype("audio/ogg; codecs=opus"), "ogg");

	console.log("✓ 4. video_note formatado e classificado corretamente.\n");
}

async function testAutoSttVideoNote() {
	console.log("5. Auto-STT de video note (Whisper real) e ignorar vídeo comum...");

	const samplePath = process.env.STT_TEST_SAMPLE || null;
	const bot = new FakeBot({ id: "tg-fake", useTelegram: true });
	const group = { id: "-100123", autoStt: true, name: "Grupo Teste", prefix: "/" };

	// Vídeo comum: nunca deve ir para o Whisper
	const videoContent = {
		mimetype: "video/mp4",
		data: Buffer.from("video").toString("base64"),
		isMessageMedia: true
	};
	const msgVideo = createMessage({
		type: "video",
		group: "-100123",
		author: "555111",
		content: videoContent,
		downloadMedia: async () => videoContent
	});
	const videoResult = await SpeechCommands.processAutoSTT(bot, msgVideo, group, {
		returnResult: true
	});
	assert.strictEqual(videoResult, false, "vídeo comum não deve ser transcrito automaticamente");
	console.log("   - vídeo comum ignorado ✔");

	if (!samplePath || !fs.existsSync(samplePath)) {
		console.log("   - amostra de mídia ausente (STT_TEST_SAMPLE), pulando transcrição real.\n");
		return;
	}

	const data = fs.readFileSync(samplePath).toString("base64");
	const noteContent = { mimetype: "video/mp4", data, isMessageMedia: true };
	const msgNote = createMessage({
		type: "video_note",
		group: "-100123",
		author: "555111",
		content: noteContent,
		downloadMedia: async () => noteContent
	});

	const noteResult = await SpeechCommands.processAutoSTT(bot, msgNote, group, {
		returnResult: true
	});
	assert.strictEqual(typeof noteResult, "string", "auto-STT deve retornar a transcrição");
	assert.ok(noteResult.length > 0, "transcrição não vazia");

	bot.resetCapture();
	await SpeechCommands.processAutoSTT(bot, msgNote, group);
	const captured = bot.capturedMessages[0];
	assert.ok(captured, "transcrição enviada ao chat");
	assert.ok(
		captured.options?.quotedMessageId || captured.options?.goReply,
		"transcrição deve referenciar a mensagem original (reply)"
	);
	console.log(
		`✓ 5. Video note transcrito: "${noteResult.slice(0, 60)}..." + reply referenciado.\n`
	);
}

async function waitFor(predicate, timeoutMs = 90000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

function looksLikeTranscription(content) {
	if (typeof content !== "string" || content.trim().length < 5) return false;
	const text = content.toLowerCase();
	return !["erro", "não foi possível", "por favor", "⚠️"].some((p) => text.startsWith(p));
}

async function testSttCommandOnVideoNote() {
	console.log("6. Comando /stt (legenda e reply) sobre video note via EventHandler...");

	const samplePath = process.env.STT_TEST_SAMPLE || null;
	if (!samplePath || !fs.existsSync(samplePath)) {
		console.log("   - amostra de mídia ausente (STT_TEST_SAMPLE), pulando.\n");
		return;
	}

	const data = fs.readFileSync(samplePath).toString("base64");

	const { bot: tgBot } = buildTelegramBot();
	tgBot.apiClient.downloadFile = async () => data;

	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	const baseUpdate = () => ({
		date: Math.floor(Date.now() / 1000),
		chat: { id: -100123, type: "supergroup", title: "Grupo Teste" },
		from: { id: 555111, first_name: "Testador" }
	});

	// 6.1 /stt como legenda do próprio video note
	const captionTgMsg = {
		...baseUpdate(),
		message_id: 60,
		caption: "/stt",
		video_note: { file_id: "NOTE1", file_size: data.length, duration: 5 }
	};
	const captionMsg = await tgBot.formatMessageFromTelegram(captionTgMsg);
	assert.strictEqual(captionMsg.type, "video_note");

	const fake1 = new FakeBot({ id: "tg-fake-cmd1", useTelegram: true, prefix: "/" });
	eventHandler.commandHandler.userDebounceMap.clear();
	await eventHandler.processMessage(fake1, captionMsg);
	const ok1 = await waitFor(() =>
		fake1.capturedMessages.some((m) => looksLikeTranscription(m.content))
	);
	assert.ok(ok1, "/stt na legenda do video note deve transcrever");
	const cmdRes1 = fake1.capturedMessages.find((m) => looksLikeTranscription(m.content));
	assert.ok(cmdRes1.options?.quotedMessageId, "resposta do /stt deve citar a mensagem original");
	console.log(`   - /stt na legenda: "${String(cmdRes1.content).slice(0, 50)}..." ✔`);

	// 6.2 /stt em uma mensagem de texto respondendo ao video note
	const replyTgMsg = {
		...baseUpdate(),
		message_id: 61,
		text: "/stt",
		reply_to_message: {
			...baseUpdate(),
			message_id: 55,
			video_note: { file_id: "NOTE2", file_size: data.length, duration: 5 }
		}
	};
	const replyMsg = await tgBot.formatMessageFromTelegram(replyTgMsg);
	assert.strictEqual(replyMsg.type, "text");
	assert.strictEqual(replyMsg.hasQuotedMsg, true);

	const fake2 = new FakeBot({ id: "tg-fake-cmd2", useTelegram: true, prefix: "/" });
	eventHandler.commandHandler.userDebounceMap.clear();
	await eventHandler.processMessage(fake2, replyMsg);
	const ok2 = await waitFor(() =>
		fake2.capturedMessages.some((m) => looksLikeTranscription(m.content))
	);
	assert.ok(ok2, "/stt respondendo ao video note deve transcrever a mídia citada");
	console.log("   - /stt respondendo ao video note: transcrição obtida ✔");

	console.log("✓ 6. Comando /stt funcionando para video notes (legenda e reply).\n");
}

async function testAudioRegression() {
	console.log("7. Regressão: áudio comum continua sendo transcrito...");

	const samplePath = process.env.STT_TEST_SAMPLE_AUDIO || null;
	if (!samplePath || !fs.existsSync(samplePath)) {
		console.log("   - amostra de áudio ausente (STT_TEST_SAMPLE_AUDIO), pulando.\n");
		return;
	}

	const data = fs.readFileSync(samplePath).toString("base64");
	const audioContent = { mimetype: "audio/mpeg", data, isMessageMedia: true };
	const bot = new FakeBot({ id: "tg-fake-audio", useTelegram: true });
	const group = { id: "-100123", autoStt: true, name: "Grupo Teste", prefix: "/" };

	const msgAudio = createMessage({
		type: "audio",
		group: "-100123",
		author: "555111",
		content: audioContent,
		downloadMedia: async () => audioContent
	});

	const result = await SpeechCommands.processAutoSTT(bot, msgAudio, group, { returnResult: true });
	assert.strictEqual(typeof result, "string", "áudio comum deve continuar sendo transcrito");
	assert.ok(result.length > 0, "transcrição do áudio não vazia");
	console.log(`✓ 7. Áudio comum transcrito: "${result.slice(0, 50)}..."\n`);
}

async function main() {
	console.log("=== TESTES: TELEGRAM STT (reply + video note) ===\n");
	await testReplyResolution();
	await testReplyFallback();
	await testSplitChunksSingleReply();
	await testFormatVideoNote();
	await testAutoSttVideoNote();
	await testSttCommandOnVideoNote();
	await testAudioRegression();
	console.log("=== TODOS OS TESTES PASSARAM ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
