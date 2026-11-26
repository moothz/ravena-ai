process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs").promises;
const path = require("path");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const { createMessage } = require("./FakeMessage");

async function createSampleWavBase64(outputPath) {
	await new Promise((resolve, reject) => {
		ffmpeg()
			.input("sine=frequency=440:duration=1")
			.inputFormat("lavfi")
			.outputOptions(["-y", "-ar", "16000", "-ac", "1"])
			.output(outputPath)
			.on("end", resolve)
			.on("error", reject)
			.run();
	});
	const buf = await fs.readFile(outputPath);
	return buf.toString("base64");
}

function resetCase(bot, cmdHandler) {
	bot.resetCapture();
	cmdHandler.cooldownCache?.clear?.();
}

function cleanupCommandHandlerTimers(cmdHandler) {
	if (cmdHandler?.cooldownDecayInterval) {
		clearInterval(cmdHandler.cooldownDecayInterval);
		cmdHandler.cooldownDecayInterval = null;
	}
	if (cmdHandler?.cooldownCleanupInterval) {
		clearInterval(cmdHandler.cooldownCleanupInterval);
		cmdHandler.cooldownCleanupInterval = null;
	}
	if (cmdHandler?.rateLimiter?.cleanupInterval) {
		clearInterval(cmdHandler.rateLimiter.cleanupInterval);
		cmdHandler.rateLimiter.cleanupInterval = null;
	}
}

function buildMockMsg({ type, content, author, group, quotedMessage = null, extra = {} }) {
	const msg = createMessage({
		type,
		content,
		author,
		group,
		hasQuotedMsg: Boolean(quotedMessage),
		quotedMsg: quotedMessage,
		origin: {
			getQuotedMessage: async () => quotedMessage
		},
		...extra
	});
	msg.downloadMedia = async () => content;
	return msg;
}

async function runTests() {
	console.log("=== Iniciando testes de stickers com som ===");
	const bot = new FakeBot({ id: "test-bot" });
	const eventHandler = new EventHandler();
	const cmdHandler = eventHandler.commandHandler;

	const tempDir = path.join(__dirname, "../../temp", "test-sticker-sound");
	await fs.mkdir(tempDir, { recursive: true });

	try {
		const stickerPngBuffer = await sharp({
			create: {
				width: 512,
				height: 512,
				channels: 4,
				background: { r: 220, g: 40, b: 80, alpha: 0 }
			}
		})
			.composite([
				{
					input: await sharp({
						create: {
							width: 256,
							height: 256,
							channels: 4,
							background: { r: 30, g: 144, b: 255, alpha: 1 }
						}
					})
						.png()
						.toBuffer(),
					left: 128,
					top: 128
				}
			])
			.png()
			.toBuffer();

		const audioB64 = await createSampleWavBase64(path.join(tempDir, "tone.wav"));

		// 1. Fluxo [figurinha] -> [audio] -> !s
		console.log("\n1. Testando [figurinha] -> [audio] -> !s (fusao de sticker + audio)...");
		const quotedStickerMsg = buildMockMsg({
			type: "sticker",
			author: "5511999990001@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: {
				mimetype: "image/png",
				data: stickerPngBuffer.toString("base64")
			}
		});

		const quotedAudioMsg = buildMockMsg({
			type: "audio",
			author: "5511999990002@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: {
				mimetype: "audio/wav",
				data: audioB64
			},
			quotedMessage: quotedStickerMsg
		});

		const cmdMsg = buildMockMsg({
			type: "text",
			content: "!s",
			author: "5511999990003@s.whatsapp.net",
			group: "120363000000000099@g.us",
			quotedMessage: quotedAudioMsg
		});

		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, cmdMsg, "s", ["SomTeste"], { name: "Grupo Teste" });

		assert.strictEqual(bot.capturedMessages.length, 1, "Deve enviar 1 sticker com som");
		const fused = bot.capturedMessages[0];
		assert.strictEqual(fused.options.sendMediaAsSticker, true);
		assert.strictEqual(fused.options.stickerName, "SomTeste");
		assert.strictEqual(fused.content.mimetype, "image/webp");
		assert.ok(fused.options.stickerAudio, "options.stickerAudio deve estar preenchido");
		assert.strictEqual(fused.options.stickerAudio.mimetype, "audio/ogg; codecs=opus");
		assert.strictEqual(
			Buffer.from(fused.options.stickerAudio.data, "base64").slice(0, 4).toString("utf8"),
			"OggS",
			"Audio deve ser convertido para OGG Opus"
		);

		const fusedWebp = Buffer.from(fused.content.data, "base64");
		const fusedMeta = await sharp(fusedWebp).metadata();
		assert.strictEqual(fusedMeta.format, "webp");
		assert.strictEqual(fusedMeta.width, 512);
		assert.strictEqual(fusedMeta.height, 512);
		console.log("✓ [figurinha] -> [audio] -> !s gerou sticker WebP + audio embutido");

		// 2. Fluxo negativo: [texto] -> [audio] -> !s deve orientar o usuario
		console.log("\n2. Testando rejeicao quando o audio nao cita uma figurinha...");
		const quotedTextMsg = buildMockMsg({
			type: "text",
			content: "oi",
			author: "5511999990001@s.whatsapp.net",
			group: "120363000000000099@g.us"
		});
		const audioQuotingText = buildMockMsg({
			type: "audio",
			author: "5511999990002@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: { mimetype: "audio/wav", data: audioB64 },
			quotedMessage: quotedTextMsg
		});
		const badCmdMsg = buildMockMsg({
			type: "text",
			content: "!s",
			author: "5511999990003@s.whatsapp.net",
			group: "120363000000000099@g.us",
			quotedMessage: audioQuotingText
		});

		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, badCmdMsg, "s", [], { name: "Grupo Teste" });

		assert.strictEqual(bot.capturedMessages.length, 1);
		assert.ok(
			String(bot.capturedMessages[0].content).includes("responda a uma figurinha com um áudio"),
			"Deve orientar o fluxo [figurinha] -> [audio] -> !s"
		);
		console.log("✓ Audio sem figurinha citada retorna orientacao correta");

		// 3. Fluxo reverso: !s em um sticker de audio envia Imagem/Video + Audio
		console.log("\n3. Testando !s em um sticker com som (retorna imagem + audio)...");
		const staticTransparentWebp = await sharp(stickerPngBuffer)
			.webp({ lossless: false })
			.toBuffer();
		const soundStickerMsg = buildMockMsg({
			type: "sticker",
			author: "5511999990001@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: {
				mimetype: "image/webp",
				data: staticTransparentWebp.toString("base64"),
				audioMessage: {
					mimetype: "audio/ogg; codecs=opus",
					directPath: "/v/t62.7117-24/fake"
				}
			}
		});
		soundStickerMsg.downloadStickerAudio = async () => ({
			mimetype: "audio/ogg; codecs=opus",
			data: audioB64,
			filename: "sticker-audio.ogg",
			isMessageMedia: true
		});

		const extractCmdMsg = buildMockMsg({
			type: "text",
			content: "!s",
			author: "5511999990003@s.whatsapp.net",
			group: "120363000000000099@g.us",
			quotedMessage: soundStickerMsg
		});

		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, extractCmdMsg, "s", [], { name: "Grupo Teste" });

		assert.strictEqual(
			bot.capturedMessages.length,
			2,
			"Deve enviar exatamente 2 mensagens: visual (PNG) + audio"
		);
		assert.strictEqual(bot.capturedMessages[0].content.mimetype, "image/png");
		assert.ok(
			!bot.capturedMessages[0].options.sendMediaAsDocument,
			"Foto deve ser enviada como imagem, não como documento"
		);
		assert.strictEqual(bot.capturedMessages[1].content.mimetype, "audio/ogg; codecs=opus");
		assert.strictEqual(bot.capturedMessages[1].options.sendMediaAsSticker, false);
		assert.strictEqual(bot.capturedMessages[1].content.data, audioB64);
		console.log("✓ !s em sticker estático com som enviou a foto + audio separado (PNG + audio)");

		// 3b. Sticker estático opaco (sem alpha) com som -> foto PNG + audio separado
		console.log("\n3b. Testando !s em sticker estático opaco com som...");
		const opaqueStaticWebp = await sharp({
			create: {
				width: 64,
				height: 64,
				channels: 3,
				background: { r: 200, g: 40, b: 40 }
			}
		})
			.webp({ lossless: false })
			.toBuffer();
		const opaqueSoundStickerMsg = buildMockMsg({
			type: "sticker",
			author: "5511999990001@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: {
				mimetype: "image/webp",
				data: opaqueStaticWebp.toString("base64"),
				audioMessage: {
					mimetype: "audio/ogg; codecs=opus",
					directPath: "/v/t62.7117-24/opaque"
				}
			}
		});
		opaqueSoundStickerMsg.downloadStickerAudio = async () => ({
			mimetype: "audio/ogg; codecs=opus",
			data: audioB64,
			filename: "opaque-sticker-audio.ogg",
			isMessageMedia: true
		});
		const opaqueExtractCmdMsg = buildMockMsg({
			type: "text",
			content: "!s",
			author: "5511999990003@s.whatsapp.net",
			group: "120363000000000099@g.us",
			quotedMessage: opaqueSoundStickerMsg
		});
		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, opaqueExtractCmdMsg, "s", [], {
			name: "Grupo Teste"
		});
		assert.strictEqual(bot.capturedMessages.length, 2, "Deve enviar foto + audio");
		assert.strictEqual(bot.capturedMessages[0].content.mimetype, "image/png");
		assert.ok(!bot.capturedMessages[0].options.sendMediaAsDocument);
		assert.strictEqual(bot.capturedMessages[1].content.mimetype, "audio/ogg; codecs=opus");
		console.log("✓ !s em sticker estático opaco com som enviou foto + audio separado");

		// 3c. Sticker citado que tem quoted de audio -> retorna visual + audio citado
		console.log("\n3c. Testando !s em sticker que tem quoted de audio...");
		const encryptedCdnUrl = "https://mmg.whatsapp.net/v/t62.7117-24/00000000_0_0_n.enc?ccb=11-4";
		const buildStickerQuotingContext = (quotedContext) => {
			const sticker = buildMockMsg({
				type: "sticker",
				author: "5511999990001@s.whatsapp.net",
				group: "120363000000000099@g.us",
				content: {
					mimetype: "image/webp",
					data: staticTransparentWebp.toString("base64")
				}
			});
			sticker.origin.getQuotedMessage = async () => quotedContext;
			return buildMockMsg({
				type: "text",
				content: "!s",
				author: "5511999990003@s.whatsapp.net",
				group: "120363000000000099@g.us",
				quotedMessage: sticker
			});
		};
		const buildQuotedContext = ({ type, mimetype, data, extra = {} }) => {
			const quoted = buildMockMsg({
				type,
				author: "5511999990002@s.whatsapp.net",
				group: "120363000000000099@g.us",
				content: { mimetype, url: encryptedCdnUrl },
				extra
			});
			quoted.downloadCalls = 0;
			quoted.downloadMedia = async () => {
				quoted.downloadCalls++;
				return { mimetype, data, filename: "quoted-media" };
			};
			return quoted;
		};
		const quotedAudioFromSticker = buildQuotedContext({
			type: "ptt",
			mimetype: "audio/ogg; codecs=opus",
			data: audioB64
		});

		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(
			bot,
			buildStickerQuotingContext(quotedAudioFromSticker),
			"s",
			[],
			{
				name: "Grupo Teste"
			}
		);

		assert.strictEqual(
			bot.capturedMessages.length,
			2,
			"Deve enviar foto + audio citado no contexto"
		);
		assert.strictEqual(bot.capturedMessages[0].content.mimetype, "image/png");
		assert.strictEqual(bot.capturedMessages[1].content.mimetype, "audio/ogg; codecs=opus");
		assert.strictEqual(bot.capturedMessages[1].content.data, audioB64);
		assert.notStrictEqual(bot.capturedMessages[1].content.url, encryptedCdnUrl);
		assert.strictEqual(quotedAudioFromSticker.downloadCalls, 1, "Deve baixar o audio citado");
		console.log("✓ !s em sticker com quoted de audio baixou e enviou visual + audio citado");

		const nonAudioContexts = [
			{
				label: "imagem",
				quoted: buildQuotedContext({
					type: "image",
					mimetype: "image/jpeg",
					data: staticTransparentWebp.toString("base64")
				})
			},
			{
				label: "documento PDF",
				quoted: buildQuotedContext({
					type: "document",
					mimetype: "application/pdf",
					data: Buffer.from("%PDF-1.4 sintetico").toString("base64")
				})
			},
			{
				label: "audio de visualizacao unica",
				quoted: buildQuotedContext({
					type: "audio",
					mimetype: "audio/ogg; codecs=opus",
					data: audioB64,
					extra: { isViewOnce: true }
				})
			},
			{
				label: "audio de visualizacao unica (origin)",
				quoted: buildQuotedContext({
					type: "ptt",
					mimetype: "audio/ogg; codecs=opus",
					data: audioB64,
					extra: { origin: { isViewOnce: true } }
				})
			}
		];
		for (const { label, quoted } of nonAudioContexts) {
			console.log(`\n3c. Testando !s em sticker respondendo a ${label}...`);
			resetCase(bot, cmdHandler);
			await cmdHandler.processCommand(bot, buildStickerQuotingContext(quoted), "s", [], {
				name: "Grupo Teste"
			});
			assert.strictEqual(
				bot.capturedMessages.length,
				1,
				`Sticker respondendo a ${label} deve enviar só o visual`
			);
			assert.strictEqual(bot.capturedMessages[0].content.mimetype, "image/png");
			console.log(`✓ !s em sticker respondendo a ${label} enviou só o visual`);
		}

		// 4. Fluxo reverso em sticker animado com som: envia MP4 + audio
		console.log("\n4. Testando !s em sticker animado com som (retorna MP4 + audio)...");
		const animInputPath = path.join(tempDir, "anim_src.mp4");
		await new Promise((resolve, reject) => {
			ffmpeg()
				.input("testsrc=duration=1.5:size=160x160:rate=10")
				.inputFormat("lavfi")
				.outputOptions(["-y", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
				.output(animInputPath)
				.on("end", resolve)
				.on("error", reject)
				.run();
		});
		const animWebpPath = path.join(tempDir, "anim_sticker.webp");
		await new Promise((resolve, reject) => {
			ffmpeg(animInputPath)
				.outputOptions(["-y", "-vcodec", "libwebp", "-lossless", "0", "-loop", "0", "-an"])
				.toFormat("webp")
				.save(animWebpPath)
				.on("end", resolve)
				.on("error", reject)
				.run();
		});
		const animWebpBuf = await fs.readFile(animWebpPath);

		const animSoundStickerMsg = buildMockMsg({
			type: "sticker",
			author: "5511999990001@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: {
				mimetype: "image/webp",
				data: animWebpBuf.toString("base64"),
				audioMessage: {
					mimetype: "audio/ogg; codecs=opus",
					directPath: "/v/t62.7117-24/fake-anim"
				}
			}
		});
		animSoundStickerMsg.downloadStickerAudio = async () => ({
			mimetype: "audio/ogg; codecs=opus",
			data: audioB64,
			filename: "anim-sticker-audio.ogg",
			isMessageMedia: true
		});

		const extractAnimCmdMsg = buildMockMsg({
			type: "text",
			content: "!s",
			author: "5511999990003@s.whatsapp.net",
			group: "120363000000000099@g.us",
			quotedMessage: animSoundStickerMsg
		});

		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, extractAnimCmdMsg, "s", [], { name: "Grupo Teste" });

		assert.strictEqual(bot.capturedMessages.length, 2, "Deve enviar MP4 + audio");
		assert.strictEqual(bot.capturedMessages[0].content.mimetype, "video/mp4");
		// O MP4 deve ter o som embutido (áudio também continua separado)
		const mergedMp4Path = path.join(tempDir, "merged_anim.mp4");
		await fs.writeFile(mergedMp4Path, Buffer.from(bot.capturedMessages[0].content.data, "base64"));
		const mergedMeta = await new Promise((resolve, reject) =>
			ffmpeg.ffprobe(mergedMp4Path, (err, m) => (err ? reject(err) : resolve(m)))
		);
		const mergedStreams = Array.isArray(mergedMeta?.streams) ? mergedMeta.streams : [];
		const hasVideo = mergedStreams.some((st) => st.codec_type === "video");
		const hasAudio = mergedStreams.some((st) => st.codec_type === "audio");
		assert.ok(hasVideo, "MP4 com som deve ter faixa de vídeo");
		assert.ok(hasAudio, "MP4 com som deve ter faixa de áudio embutida");
		assert.strictEqual(bot.capturedMessages[1].content.mimetype, "audio/ogg; codecs=opus");
		console.log("✓ !s em sticker animado com som enviou MP4 com som + audio separado");

		// 5. WhatsAppBotGo: unwrap audioStickerMessage, downloadStickerAudio e POST /send/sticker/audio
		console.log(
			"\n5. Testando WhatsAppBotGo (_unwrapGoMessageContent, formatMessageFromGo e sendMessage)..."
		);
		const goBot = new WhatsAppBotGo({
			id: "test-go",
			whatsgoApiUrl: "http://localhost:8080",
			whatsgoApiKey: "test-key",
			instanceName: "test-go",
			webhookHost: "localhost"
		});
		goBot.isConnected = true;
		goBot.isParticipating = () => true;

		const postedCalls = [];
		let uploadSeq = 0;
		goBot.createMediaFromBase64 = async (b64, mimeType, filename) => {
			uploadSeq++;
			return { url: `http://mock-storage/${uploadSeq}/${filename}`, filename, mimetype: mimeType };
		};
		goBot.apiClient = {
			post: async (endpoint, payload) => {
				postedCalls.push({ endpoint, payload });
				if (endpoint === "/message/downloadmedia") {
					return { data: { base64: audioB64 } };
				}
				return { data: { data: { Info: { ID: "MOCKMSG1" } } } };
			}
		};

		const goRawWebhook = {
			Info: {
				ID: "AUDIOSTICKER1",
				Chat: "120363000000000099@g.us",
				Sender: "5511999990001@s.whatsapp.net",
				IsFromMe: false,
				IsGroup: true,
				Timestamp: new Date().toISOString(),
				PushName: "Usuario Teste"
			},
			Message: {
				audioStickerMessage: {
					message: {
						stickerMessage: {
							mimetype: "image/webp",
							url: "https://example.com/sticker.webp",
							Audio: {
								AudioMessage: {
									mimetype: "audio/ogg; codecs=opus",
									directPath: "/v/t62.7117-24/mock",
									seconds: 2
								}
							},
							contextInfo: {
								stanzaID: "QUOTEDSTICKER0",
								quotedMessage: {
									stickerMessage: {
										mimetype: "image/webp",
										Audio: {
											AudioMessage: {
												directPath: "/v/t62.7117-24/nested"
											}
										}
									}
								}
							}
						}
					}
				}
			}
		};

		const formattedGo = await goBot.formatMessageFromGo(goRawWebhook, true);
		assert.strictEqual(formattedGo.type, "sticker");
		assert.ok(formattedGo.content.audioMessage, "Deve ler stickerMessage.Audio.AudioMessage");

		const downloadedSticker = await formattedGo.downloadMedia();
		assert.ok(downloadedSticker && downloadedSticker.data === audioB64);
		assert.strictEqual(postedCalls[0].endpoint, "/message/downloadmedia");
		assert.strictEqual(
			postedCalls[0].payload.message.stickerMessage.Audio,
			undefined,
			"Nao deve enviar stickerMessage.Audio (oneof Go) no /message/downloadmedia"
		);
		assert.strictEqual(
			postedCalls[0].payload.message.stickerMessage.contextInfo,
			undefined,
			"Nao deve enviar contextInfo no /message/downloadmedia"
		);

		const downloadedAudio = await formattedGo.downloadStickerAudio();
		assert.ok(downloadedAudio && downloadedAudio.data === audioB64);
		assert.strictEqual(postedCalls[1].endpoint, "/message/downloadmedia");
		assert.ok(postedCalls[1].payload.message.audioMessage, "Deve baixar audioMessage embutido");

		// Quoted sticker com Audio.AudioMessage e trava de view-once em downloadStickerAudio
		const quotedAudioSticker = goBot.formatQuotedMessageFromContext(
			{
				stanzaID: "VOSTICKER1",
				participant: "5511999990001@s.whatsapp.net",
				quotedMessage: {
					viewOnceMessage: {
						message: goRawWebhook.Message
					}
				}
			},
			"120363000000000099@g.us"
		);
		assert.ok(
			quotedAudioSticker.content.audioMessage,
			"Quoted sticker deve ler Audio.AudioMessage"
		);
		const callsBeforeVo = postedCalls.length;
		const blockedVoAudio = await quotedAudioSticker.downloadStickerAudio({
			requesterIds: ["5511999999999@s.whatsapp.net"]
		});
		assert.strictEqual(blockedVoAudio, null, "Terceiro nao pode baixar audio de view-once");
		assert.strictEqual(postedCalls.length, callsBeforeVo);

		await goBot.sendMessage("120363000000000099@g.us", fused.content, fused.options);
		const sendCall = postedCalls.find((c) => c.endpoint === "/send/sticker/audio");
		assert.ok(
			sendCall,
			"Deve enviar para /send/sticker/audio quando options.stickerAudio estiver presente"
		);
		assert.ok(sendCall.payload.sticker.includes("mock-storage"), "Deve enviar URL do sticker WebP");
		assert.ok(sendCall.payload.audio.includes("mock-storage"), "Deve enviar URL do audio");
		console.log(
			"✓ WhatsAppBotGo leu Audio.AudioMessage, sanitizou /message/downloadmedia e enviou via /send/sticker/audio"
		);

		// 6. !sa / !saudio em video com audio (legenda e resposta)
		console.log("\n6. Testando !sa em video com audio (na legenda e em resposta)...");
		const videoWithAudioPath = path.join(tempDir, "video_with_audio.mp4");
		await new Promise((resolve, reject) => {
			ffmpeg()
				.input("testsrc=duration=1.5:size=160x160:rate=10")
				.inputFormat("lavfi")
				.input("sine=frequency=440:duration=1.5")
				.inputFormat("lavfi")
				.outputOptions(["-y", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
				.output(videoWithAudioPath)
				.on("end", resolve)
				.on("error", reject)
				.run();
		});
		const videoWithAudioB64 = (await fs.readFile(videoWithAudioPath)).toString("base64");

		const videoCaptionMsg = buildMockMsg({
			type: "video",
			author: "5511999990003@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: {
				mimetype: "video/mp4",
				data: videoWithAudioB64
			},
			extra: { caption: "!sa MeuVideo" }
		});
		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, videoCaptionMsg, "sa", ["MeuVideo"], {
			name: "Grupo Teste"
		});
		assert.strictEqual(bot.capturedMessages.length, 1);
		assert.strictEqual(bot.capturedMessages[0].options.sendMediaAsSticker, true);
		assert.strictEqual(bot.capturedMessages[0].options.stickerName, "MeuVideo");
		assert.ok(bot.capturedMessages[0].options.stickerAudio?.data, "Deve extrair audio do video");
		assert.strictEqual(bot.capturedMessages[0].content.mimetype, "image/webp");

		const replyVideoCmdMsg = buildMockMsg({
			type: "text",
			content: "!saudio",
			author: "5511999990003@s.whatsapp.net",
			group: "120363000000000099@g.us",
			quotedMessage: videoCaptionMsg
		});
		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, replyVideoCmdMsg, "saudio", [], {
			name: "Grupo Teste"
		});
		assert.strictEqual(bot.capturedMessages.length, 1);
		assert.strictEqual(bot.capturedMessages[0].options.sendMediaAsSticker, true);
		assert.ok(bot.capturedMessages[0].options.stickerAudio?.data);
		console.log("✓ !sa na legenda e !saudio em resposta ao video criaram figurinha com som");

		// 7. !sa em video sem audio
		console.log("\n7. Testando !sa em video sem faixa de audio...");
		const videoSilentMsg = buildMockMsg({
			type: "video",
			author: "5511999990003@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: {
				mimetype: "video/mp4",
				data: (await fs.readFile(animInputPath)).toString("base64")
			}
		});
		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, videoSilentMsg, "sa", [], { name: "Grupo Teste" });
		assert.strictEqual(bot.capturedMessages.length, 1);
		assert.ok(String(bot.capturedMessages[0].content).includes("não tem faixa de áudio"));
		console.log("✓ !sa rejeitou video sem audio com orientacao");

		// 8. Audio > 4 min deve ser recusado antes de enviar
		console.log("\n8. Testando recusa de audio > 4 minutos...");
		const longAudioMsg = buildMockMsg({
			type: "audio",
			author: "5511999990002@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: { mimetype: "audio/ogg", data: audioB64, seconds: 300 },
			quotedMessage: quotedStickerMsg
		});
		const longAudioCmdMsg = buildMockMsg({
			type: "text",
			content: "!s",
			author: "5511999990003@s.whatsapp.net",
			group: "120363000000000099@g.us",
			quotedMessage: longAudioMsg
		});
		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, longAudioCmdMsg, "s", [], { name: "Grupo Teste" });
		assert.strictEqual(bot.capturedMessages.length, 1);
		assert.ok(String(bot.capturedMessages[0].content).includes("muito longo"));
		console.log("✓ Audio acima de 4 min recusado com aviso");

		// 9. Regressao: !s em audio que cita imagem continua criando sticker da imagem
		console.log("\n9. Testando !s em audio que responde a imagem (sem regressao)...");
		const quotedImgMsg = buildMockMsg({
			type: "image",
			author: "5511999990001@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: { mimetype: "image/png", data: stickerPngBuffer.toString("base64") }
		});
		const audioQuotingImg = buildMockMsg({
			type: "audio",
			author: "5511999990002@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: { mimetype: "audio/wav", data: audioB64 },
			quotedMessage: quotedImgMsg
		});
		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, audioQuotingImg, "s", [], { name: "Grupo Teste" });
		assert.strictEqual(bot.capturedMessages.length, 1);
		assert.strictEqual(bot.capturedMessages[0].options?.sendMediaAsSticker, true);
		console.log("✓ Audio que cita imagem manteve criacao de sticker da imagem");

		// 10. Sticker Lottie (.was) nao retorna arquivo cru
		console.log("\n10. Testando recusa limpa de sticker Lottie (application/was)...");
		const lottieMsg = buildMockMsg({
			type: "sticker",
			author: "5511999990001@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: { mimetype: "application/was", data: Buffer.from("lottie").toString("base64") }
		});
		const lottieCmdMsg = buildMockMsg({
			type: "text",
			content: "!s",
			author: "5511999990003@s.whatsapp.net",
			group: "120363000000000099@g.us",
			quotedMessage: lottieMsg
		});
		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, lottieCmdMsg, "s", [], { name: "Grupo Teste" });
		assert.strictEqual(bot.capturedMessages.length, 1);
		assert.ok(String(bot.capturedMessages[0].content).includes("Lottie"));
		console.log("✓ Sticker Lottie recusado com mensagem clara");

		// 11. Documento de audio respondendo sticker com !s na legenda
		console.log("\n11. Testando [figurinha] -> [document audio com !s na legenda]...");
		const docAudioCaptionMsg = buildMockMsg({
			type: "document",
			author: "5511999990002@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: {
				mimetype: "audio/wav",
				filename: "efeito.wav",
				data: audioB64
			},
			extra: { caption: "!s" },
			quotedMessage: quotedStickerMsg
		});
		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, docAudioCaptionMsg, "s", [], { name: "Grupo Teste" });
		assert.strictEqual(bot.capturedMessages.length, 1);
		assert.strictEqual(bot.capturedMessages[0].options.sendMediaAsSticker, true);
		assert.strictEqual(
			bot.capturedMessages[0].options.stickerAudio?.mimetype,
			"audio/ogg; codecs=opus"
		);
		console.log("✓ Document de áudio com !s na legenda respondendo sticker funcionou");

		// 12. Audio corrompido deve retornar mensagem detalhada e amigável sem caminhos de arquivo
		console.log("\n12. Testando erro amigável para áudio corrompido...");
		const brokenAudioMsg = buildMockMsg({
			type: "audio",
			author: "5511999990002@s.whatsapp.net",
			group: "120363000000000099@g.us",
			content: {
				mimetype: "audio/mp4",
				filename: "quebrado.m4a",
				data: Buffer.from("not-a-valid-audio-file").toString("base64")
			},
			quotedMessage: quotedStickerMsg
		});
		const brokenCmdMsg = buildMockMsg({
			type: "text",
			content: "!s",
			author: "5511999990003@s.whatsapp.net",
			group: "120363000000000099@g.us",
			quotedMessage: brokenAudioMsg
		});
		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, brokenCmdMsg, "s", [], { name: "Grupo Teste" });
		assert.strictEqual(bot.capturedMessages.length, 1);
		const brokenReply = String(bot.capturedMessages[0].content);
		assert.ok(brokenReply.includes("❌"), "Deve informar erro ao usuário");
		assert.ok(
			!brokenReply.includes("/app/") && !brokenReply.includes("temp-"),
			"Não deve expor caminhos de arquivo"
		);
		console.log("✓ Erro amigável retornado sem expor caminhos internos:", brokenReply);

		// 13. !sa hq longo q em vídeo com áudio
		console.log("\n13. Testando !sa hq longo q (args combináveis)...");
		resetCase(bot, cmdHandler);
		await cmdHandler.processCommand(bot, videoCaptionMsg, "sa", ["hq", "longo", "q"], {
			name: "Grupo Teste"
		});
		assert.strictEqual(bot.capturedMessages.length, 1);
		const comboSticker = bot.capturedMessages[0];
		assert.strictEqual(comboSticker.options.sendMediaAsSticker, true);
		assert.ok(comboSticker.options.stickerAudio?.data);
		const comboMeta = await sharp(Buffer.from(comboSticker.content.data, "base64"), {
			animated: true
		}).metadata();
		assert.strictEqual(comboMeta.width, 512);
		assert.strictEqual(comboMeta.pageHeight || comboMeta.height, 512);
		console.log("✓ !sa hq longo q gerou sticker quadrado 512x512 com áudio");

		console.log("\n=== TODOS OS TESTES DE STICKER COM SOM PASSARAM! ===");
	} finally {
		cleanupCommandHandlerTimers(cmdHandler);
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Erro nos testes:", err);
	process.exit(1);
});
