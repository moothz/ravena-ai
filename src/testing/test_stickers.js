const assert = require("assert");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs").promises;
const path = require("path");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const { createMessage } = require("./FakeMessage");
const Stickers = require("../functions/Stickers");

async function createTestVideo(
	outputPath,
	width = 320,
	height = 180,
	duration = 2,
	source = "testsrc"
) {
	return new Promise((resolve, reject) => {
		ffmpeg()
			.input(`${source}=duration=${duration}:size=${width}x${height}:rate=15`)
			.inputFormat("lavfi")
			.outputOptions(["-y", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
			.output(outputPath)
			.on("end", resolve)
			.on("error", reject)
			.run();
	});
}

async function createMuxedVideoWithLongerAudio(
	outputPath,
	width = 320,
	height = 180,
	videoDuration = 4,
	audioDuration = 12
) {
	return new Promise((resolve, reject) => {
		ffmpeg()
			.input(`testsrc=duration=${videoDuration}:size=${width}x${height}:rate=15`)
			.inputFormat("lavfi")
			.input(`anullsrc=r=44100:cl=mono`)
			.inputFormat("lavfi")
			.outputOptions([
				"-y",
				"-t",
				String(audioDuration),
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac"
			])
			.output(outputPath)
			.on("end", resolve)
			.on("error", reject)
			.run();
	});
}

async function createNoisyVideo(outputPath, width = 320, height = 180, duration = 60) {
	return new Promise((resolve, reject) => {
		ffmpeg()
			.input(`testsrc=duration=${duration}:size=${width}x${height}:rate=12`)
			.inputFormat("lavfi")
			.videoFilters("noise=alls=100:allf=t+u")
			.outputOptions(["-y", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"])
			.output(outputPath)
			.on("end", resolve)
			.on("error", reject)
			.run();
	});
}

async function runTests() {
	console.log("=== Iniciando testes de padronização de stickers e transparência ===");
	const bot = new FakeBot({ id: "test-bot" });
	const eventHandler = new EventHandler();
	const cmdHandler = eventHandler.commandHandler;
	clearInterval(cmdHandler.decayInterval);
	clearInterval(cmdHandler.cooldownMsgCleanupInterval);
	const resetCase = () => {
		bot.resetCapture();
		cmdHandler.cooldownCache?.clear?.();
	};

	const tempDir = path.join(__dirname, "../../temp", "test-stickers");
	const stickersTempDir = path.join(__dirname, "../../temp", "whatsapp-bot-stickers");
	await fs.mkdir(tempDir, { recursive: true });
	const beforeTempFiles = new Set(await fs.readdir(stickersTempDir).catch(() => []));

	// 1. Teste: Sticker de imagem estática não quadrada com !s / !sticker
	console.log("\n1. Testando sticker de imagem estática com transparência...");
	const testImgPath = path.join(tempDir, "test_landscape.png");
	await sharp({
		create: {
			width: 600,
			height: 300,
			channels: 3,
			background: { r: 0, g: 150, b: 255 }
		}
	})
		.png()
		.toFile(testImgPath);

	const imgBuffer = await fs.readFile(testImgPath);
	const imgMsg = createMessage({
		type: "image",
		caption: "!s",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		content: {
			mimetype: "image/png",
			data: imgBuffer.toString("base64")
		}
	});

	resetCase();
	await cmdHandler.processCommand(bot, imgMsg, "s", [], { name: "Grupo Teste" });

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar exatamente 1 mensagem");
	const sentImgSticker = bot.capturedMessages[0];
	assert.strictEqual(sentImgSticker.options.sendMediaAsSticker, true, "Deve enviar como sticker");
	assert.strictEqual(sentImgSticker.content.mimetype, "image/webp", "Formato deve ser image/webp");

	const imgWebpBuffer = Buffer.from(sentImgSticker.content.data, "base64");
	const imgMeta = await sharp(imgWebpBuffer).metadata();
	assert.strictEqual(imgMeta.width, 512, "Largura deve ser 512");
	assert.strictEqual(imgMeta.height, 512, "Altura deve ser 512");
	assert.strictEqual(imgMeta.hasAlpha, true, "Deve ter canal alpha");

	// Verifica se a borda (topo, 10, 10) é transparente (alpha = 0)
	const imgPixel = await sharp(imgWebpBuffer)
		.extract({ left: 10, top: 10, width: 1, height: 1 })
		.raw()
		.toBuffer();
	assert.strictEqual(imgPixel[3], 0, "Borda de padding deve ser 100% transparente (alpha = 0)");
	console.log("✓ Sticker estático: 512x512, WebP, bordas transparentes (alpha=0)");

	// 2. Teste: Sticker de vídeo não quadrado com !s (deve ter bordas transparentes e não pretas)
	console.log("\n2. Testando sticker de vídeo não quadrado com bordas transparentes...");
	const testVideoPath = path.join(tempDir, "test_video.mp4");
	await createTestVideo(testVideoPath, 320, 180, 2); // 16:9 aspecto

	const videoBuffer = await fs.readFile(testVideoPath);
	const videoMsg = createMessage({
		type: "video",
		caption: "!s",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		content: {
			mimetype: "video/mp4",
			data: videoBuffer.toString("base64")
		}
	});

	resetCase();
	await cmdHandler.processCommand(bot, videoMsg, "s", [], { name: "Grupo Teste" });

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar exatamente 1 mensagem");
	const sentVideoSticker = bot.capturedMessages[0];
	assert.strictEqual(sentVideoSticker.options.sendMediaAsSticker, true, "Deve enviar como sticker");
	assert.strictEqual(
		sentVideoSticker.content.mimetype,
		"image/webp",
		"Formato deve ser image/webp animado"
	);

	const videoWebpBuffer = Buffer.from(sentVideoSticker.content.data, "base64");
	const videoMeta = await sharp(videoWebpBuffer, { animated: true }).metadata();
	assert.strictEqual(videoMeta.width, 512, "Largura do sticker animado deve ser 512");
	assert.strictEqual(videoMeta.pages > 1, true, "Deve conter múltiplos frames (animado)");
	assert.strictEqual(videoMeta.hasAlpha, true, "Deve conter canal alpha");

	// Verifica se a borda de padding do vídeo é transparente (alpha = 0)
	const videoPixel = await sharp(videoWebpBuffer)
		.extract({ left: 10, top: 10, width: 1, height: 1 })
		.raw()
		.toBuffer();
	console.log("Pixel de padding do vídeo (RGBA):", [...videoPixel]);
	assert.strictEqual(
		videoPixel[3],
		0,
		"Borda de vídeo NÃO deve ser preta; deve ser transparente (alpha = 0)"
	);

	// Verifica tamanho do arquivo < 500 KB (padrão WhatsApp)
	const sizeKB = videoWebpBuffer.length / 1024;
	console.log(`Tamanho do sticker animado: ${sizeKB.toFixed(1)} KB`);
	assert.strictEqual(
		videoWebpBuffer.length <= 500 * 1024,
		true,
		"Sticker animado deve ser <= 500 KB"
	);
	console.log(
		"✓ Sticker de vídeo: 512x512, WebP animado, bordas transparentes (alpha=0), tamanho < 500 KB"
	);

	// 3. Teste: Sticker de corte quadrado central (!sq)
	console.log("\n3. Testando sticker com corte central quadrado (!sq)...");
	const sqMsg = createMessage({
		type: "video",
		caption: "!sq",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		content: {
			mimetype: "video/mp4",
			data: videoBuffer.toString("base64")
		}
	});

	resetCase();
	await cmdHandler.processCommand(bot, sqMsg, "sq", [], { name: "Grupo Teste" });

	assert.strictEqual(bot.capturedMessages.length, 1);
	const sqSticker = bot.capturedMessages[0];
	assert.strictEqual(sqSticker.content.mimetype, "image/webp");
	const sqBuffer = Buffer.from(sqSticker.content.data, "base64");
	const sqMeta = await sharp(sqBuffer, { animated: true }).metadata();
	assert.strictEqual(sqMeta.width, 512);
	assert.strictEqual(sqBuffer.length <= 500 * 1024, true);
	console.log("✓ !sq: 512x512, WebP animado, tamanho < 500 KB");

	// 4. Teste: Sticker com esticamento (!sqe)
	console.log("\n4. Testando sticker esticado (!sqe)...");
	const sqeMsg = createMessage({
		type: "video",
		caption: "!sqe",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		content: {
			mimetype: "video/mp4",
			data: videoBuffer.toString("base64")
		}
	});

	resetCase();
	await cmdHandler.processCommand(bot, sqeMsg, "sqe", [], { name: "Grupo Teste" });

	assert.strictEqual(bot.capturedMessages.length, 1);
	const sqeSticker = bot.capturedMessages[0];
	assert.strictEqual(sqeSticker.content.mimetype, "image/webp");
	const sqeBuffer = Buffer.from(sqeSticker.content.data, "base64");
	const sqeMeta = await sharp(sqeBuffer, { animated: true }).metadata();
	assert.strictEqual(sqeMeta.width, 512);
	assert.strictEqual(sqeBuffer.length <= 500 * 1024, true);
	console.log("✓ !sqe: 512x512, WebP animado, tamanho < 500 KB");

	// 5. Teste: processAutoSticker em PV
	console.log("\n5. Testando processAutoSticker (mídia enviada em PV)...");
	const pvMsg = createMessage({
		type: "video",
		group: null, // PV
		author: "5511888888888@s.whatsapp.net",
		content: {
			mimetype: "video/mp4",
			data: videoBuffer.toString("base64")
		}
	});

	bot.capturedMessages = [];
	const autoResult = await Stickers.processAutoSticker(bot, pvMsg, null);
	assert.strictEqual(autoResult, true, "processAutoSticker deve retornar true");
	assert.strictEqual(bot.capturedMessages.length, 1, "Deve capturar o sticker enviado");
	const autoSticker = bot.capturedMessages[0];
	assert.strictEqual(autoSticker.content.mimetype, "image/webp");
	const autoBuffer = Buffer.from(autoSticker.content.data, "base64");
	const autoMeta = await sharp(autoBuffer, { animated: true }).metadata();
	assert.strictEqual(autoMeta.width, 512);
	assert.strictEqual(autoMeta.hasAlpha, true);
	console.log("✓ processAutoSticker: processado e padronizado em 512x512 WebP animado");

	// 6. Teste: Métodos de WhatsAppBotGo
	console.log(
		"\n6. Testando métodos convertToAnimatedWebP e convertToSquareWebPImage em WhatsAppBotGo..."
	);
	const goBot = new WhatsAppBotGo({
		id: "test-go",
		whatsgoApiUrl: "http://localhost:8080",
		whatsgoApiKey: "test-key",
		instanceName: "test-go",
		webhookHost: "localhost"
	});

	const goWebpBase64 = await goBot.convertToAnimatedWebP(videoBuffer.toString("base64"));
	const goWebpBuffer = Buffer.from(goWebpBase64, "base64");
	const goMeta = await sharp(goWebpBuffer, { animated: true }).metadata();
	assert.strictEqual(goMeta.width, 512);
	assert.strictEqual(goMeta.hasAlpha, true);

	const goPixel = await sharp(goWebpBuffer)
		.extract({ left: 10, top: 10, width: 1, height: 1 })
		.raw()
		.toBuffer();
	assert.strictEqual(goPixel[3], 0, "Borda em convertToAnimatedWebP deve ser transparente");
	console.log("✓ WhatsAppBotGo.convertToAnimatedWebP: 512x512, transparente (alpha=0), < 500 KB");

	const goImgWebpBase64 = await goBot.convertToSquareWebPImage(imgBuffer.toString("base64"));
	const goImgWebpBuffer = Buffer.from(goImgWebpBase64, "base64");
	const goImgMeta = await sharp(goImgWebpBuffer).metadata();
	assert.strictEqual(goImgMeta.width, 512);
	assert.strictEqual(goImgMeta.height, 512);
	assert.strictEqual(goImgMeta.hasAlpha, true);
	console.log("✓ WhatsAppBotGo.convertToSquareWebPImage: 512x512, transparente");

	// 7. Teste: Sticker de vídeo com !shq (alta taxa de quadros, 22-25 FPS, proporções preservadas)
	console.log("\n7. Testando sticker HQ de vídeo (!shq)...");
	const shqVideoMsg = createMessage({
		type: "video",
		caption: "!shq",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		content: {
			mimetype: "video/mp4",
			data: videoBuffer.toString("base64")
		}
	});

	resetCase();
	await cmdHandler.processCommand(bot, shqVideoMsg, "shq", [], { name: "Grupo Teste" });

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar exatamente 1 mensagem");
	const sentShqSticker = bot.capturedMessages[0];
	assert.strictEqual(sentShqSticker.options.sendMediaAsSticker, true, "Deve enviar como sticker");
	assert.strictEqual(sentShqSticker.content.mimetype, "image/webp", "Mimetype deve ser image/webp");

	const shqWebpBuffer = Buffer.from(sentShqSticker.content.data, "base64");
	const shqMeta = await sharp(shqWebpBuffer, { animated: true }).metadata();
	assert.strictEqual(shqMeta.pages > 1, true, "Deve ser WebP animado");
	assert.strictEqual(
		shqWebpBuffer.length <= 500 * 1024,
		true,
		"Sticker HQ deve ter tamanho <= 500 KB"
	);

	// Verifica se a maior dimensão é 512 e a proporção foi mantida (320x180 -> 512x288)
	const frameHeight = shqMeta.pageHeight || shqMeta.height;
	assert.strictEqual(Math.max(shqMeta.width, frameHeight), 512, "Maior dimensão deve ser 512");
	assert.strictEqual(shqMeta.width, 512, "Largura deve ser 512");
	assert.strictEqual(frameHeight, 288, "Altura proporcional deve ser 288");

	// Verifica se a taxa de quadros é alta (delay por frame entre ~35ms e ~50ms, ou seja, 20-28 FPS)
	if (shqMeta.delay && shqMeta.delay.length > 0) {
		const frameDelay = shqMeta.delay[0];
		console.log(`Delay do frame HQ: ${frameDelay}ms`);
		assert.strictEqual(frameDelay <= 50, true, "Frame delay deve ser <= 50ms (>= 20 FPS)");
	}
	console.log(
		`✓ !shq vídeo: ${shqMeta.width}x${frameHeight}, ${(shqWebpBuffer.length / 1024).toFixed(1)} KB, alta taxa de quadros (22-25 FPS)`
	);

	// 8. Teste: Sticker de imagem com !stickerhq (preservando dimensões nativas até 512x512)
	console.log("\n8. Testando sticker HQ de imagem estática (!stickerhq)...");
	const shqImgMsg = createMessage({
		type: "image",
		caption: "!stickerhq",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		content: {
			mimetype: "image/png",
			data: imgBuffer.toString("base64")
		}
	});

	resetCase();
	await cmdHandler.processCommand(bot, shqImgMsg, "stickerhq", [], { name: "Grupo Teste" });

	assert.strictEqual(bot.capturedMessages.length, 1);
	const sentShqImg = bot.capturedMessages[0];
	assert.strictEqual(sentShqImg.options.sendMediaAsSticker, true);
	const shqImgWebpBuffer = Buffer.from(sentShqImg.content.data, "base64");
	const shqImgMeta = await sharp(shqImgWebpBuffer).metadata();
	// Imagem original é 600x300 -> redimensionada proporcionalmente para 512x256
	assert.strictEqual(shqImgMeta.width, 512, "Largura deve ser 512");
	assert.strictEqual(shqImgMeta.height, 256, "Altura proporcional deve ser 256");
	console.log(
		`✓ !stickerhq imagem: ${shqImgMeta.width}x${shqImgMeta.height}, proporção preservada sem bordas`
	);

	// 9. Teste: Sticker longo de vídeo com !slongo (25s sem corte de 15s, <= 490 KB, padding transparente)
	console.log("\n9. Testando sticker longo de vídeo (!slongo, 25s)...");
	const longVideoPath = path.join(tempDir, "test_long_25s.mp4");
	await createTestVideo(longVideoPath, 320, 180, 25, "testsrc2");
	const longVideoBuffer = await fs.readFile(longVideoPath);

	const slongoVideoMsg = createMessage({
		type: "video",
		caption: "!slongo",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: {
			mimetype: "video/mp4",
			data: longVideoBuffer.toString("base64")
		}
	});

	resetCase();
	await cmdHandler.processCommand(bot, slongoVideoMsg, "slongo", [], { name: "Grupo Teste" });

	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria capturar exatamente 1 mensagem");
	const sentSlongo = bot.capturedMessages[0];
	assert.strictEqual(sentSlongo.options.sendMediaAsSticker, true);
	assert.strictEqual(sentSlongo.content.mimetype, "image/webp");

	const slongoWebpBuffer = Buffer.from(sentSlongo.content.data, "base64");
	const slongoMeta = await sharp(slongoWebpBuffer, { animated: true }).metadata();
	const slongoTotalMs = (slongoMeta.delay || []).reduce((acc, d) => acc + d, 0);
	assert.strictEqual(slongoMeta.pages > 1, true, "!slongo deve gerar WebP animado");
	assert.strictEqual(
		slongoWebpBuffer.length <= 490 * 1024,
		true,
		`!slongo deve caber no teto seguro de 490 KB (obtido ${(slongoWebpBuffer.length / 1024).toFixed(1)} KB)`
	);
	assert.strictEqual(
		slongoTotalMs >= 20000,
		true,
		`!slongo deve preservar duração longa (>20s, obtido ${(slongoTotalMs / 1000).toFixed(1)}s)`
	);
	assert.strictEqual(
		slongoMeta.width,
		slongoMeta.pageHeight || slongoMeta.height,
		"!slongo mantém formato quadrado com bordas transparentes"
	);
	const slongoPadPixel = await sharp(slongoWebpBuffer)
		.extract({ left: 5, top: 5, width: 1, height: 1 })
		.raw()
		.toBuffer();
	assert.strictEqual(slongoPadPixel[3], 0, "Borda do !slongo deve ser transparente (alpha=0)");
	console.log(
		`✓ !slongo vídeo 25s: ${slongoMeta.width}x${slongoMeta.pageHeight || slongoMeta.height}, ${(slongoTotalMs / 1000).toFixed(1)}s, ${(slongoWebpBuffer.length / 1024).toFixed(1)} KB`
	);

	// 10. Teste: Sticker longo HQ de vídeo com !slongohq (25s, proporção preservada, maior FPS que !slongo)
	console.log("\n10. Testando sticker longo HQ de vídeo (!slongohq, 25s)...");
	const slongoHqVideoMsg = createMessage({
		type: "video",
		caption: "!slongohq",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: {
			mimetype: "video/mp4",
			data: longVideoBuffer.toString("base64")
		}
	});

	resetCase();
	await cmdHandler.processCommand(bot, slongoHqVideoMsg, "slongohq", [], { name: "Grupo Teste" });

	assert.strictEqual(bot.capturedMessages.length, 1);
	const sentSlongoHq = bot.capturedMessages[0];
	assert.strictEqual(sentSlongoHq.options.sendMediaAsSticker, true);
	assert.strictEqual(sentSlongoHq.content.mimetype, "image/webp");

	const slongoHqWebpBuffer = Buffer.from(sentSlongoHq.content.data, "base64");
	const slongoHqMeta = await sharp(slongoHqWebpBuffer, { animated: true }).metadata();
	const slongoHqHeight = slongoHqMeta.pageHeight || slongoHqMeta.height;
	const slongoHqTotalMs = (slongoHqMeta.delay || []).reduce((acc, d) => acc + d, 0);
	assert.strictEqual(slongoHqMeta.pages > 1, true, "!slongohq deve gerar WebP animado");
	assert.strictEqual(
		slongoHqWebpBuffer.length <= 490 * 1024,
		true,
		`!slongohq deve caber em <= 490 KB (obtido ${(slongoHqWebpBuffer.length / 1024).toFixed(1)} KB)`
	);
	assert.strictEqual(
		slongoHqTotalMs >= 20000,
		true,
		`!slongohq deve preservar duração longa (>20s, obtido ${(slongoHqTotalMs / 1000).toFixed(1)}s)`
	);
	assert.strictEqual(
		slongoHqMeta.width > slongoHqHeight,
		true,
		"!slongohq deve preservar proporção 16:9 sem bordas quadradas"
	);
	assert.strictEqual(
		slongoHqMeta.pages >= slongoMeta.pages,
		true,
		`!slongohq (${slongoHqMeta.pages} frames) deve manter FPS/quadros >= !slongo (${slongoMeta.pages} frames)`
	);
	console.log(
		`✓ !slongohq vídeo 25s: ${slongoHqMeta.width}x${slongoHqHeight}, ${(slongoHqTotalMs / 1000).toFixed(1)}s, ${slongoHqMeta.pages} frames, ${(slongoHqWebpBuffer.length / 1024).toFixed(1)} KB`
	);

	// 11. Teste: Respeito ao teto máximo de 60s em vídeo > 60s (!stickerlongohq)
	console.log("\n11. Testando teto de 60s em vídeo de 65s (!stickerlongohq)...");
	const veryLongVideoPath = path.join(tempDir, "test_long_65s.mp4");
	await createTestVideo(veryLongVideoPath, 320, 180, 65, "testsrc2");
	const veryLongVideoBuffer = await fs.readFile(veryLongVideoPath);

	const capVideoMsg = createMessage({
		type: "video",
		caption: "!stickerlongohq",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: {
			mimetype: "video/mp4",
			data: veryLongVideoBuffer.toString("base64")
		}
	});

	resetCase();
	await cmdHandler.processCommand(bot, capVideoMsg, "stickerlongohq", [], {
		name: "Grupo Teste"
	});

	assert.strictEqual(bot.capturedMessages.length, 1);
	const sentCap = bot.capturedMessages[0];
	const capWebpBuffer = Buffer.from(sentCap.content.data, "base64");
	const capMeta = await sharp(capWebpBuffer, { animated: true }).metadata();
	const capTotalMs = (capMeta.delay || []).reduce((acc, d) => acc + d, 0);
	assert.strictEqual(
		capWebpBuffer.length <= 490 * 1024,
		true,
		`!stickerlongohq 65s deve caber em <= 490 KB (obtido ${(capWebpBuffer.length / 1024).toFixed(1)} KB)`
	);
	assert.strictEqual(
		capTotalMs >= 50000 && capTotalMs <= 61500,
		true,
		`Duração deve ficar entre 50s e 60s (obtido ${(capTotalMs / 1000).toFixed(1)}s)`
	);
	console.log(
		`✓ !stickerlongohq vídeo 65s: limitado a ${(capTotalMs / 1000).toFixed(1)}s, ${(capWebpBuffer.length / 1024).toFixed(1)} KB`
	);

	// 12. Teste: Imagens estáticas em !slongo e !slongohq
	console.log("\n12. Testando imagens estáticas em !slongo e !slongohq...");
	const slongoImgMsg = createMessage({
		type: "image",
		caption: "!slongo",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: {
			mimetype: "image/png",
			data: imgBuffer.toString("base64")
		}
	});
	resetCase();
	await cmdHandler.processCommand(bot, slongoImgMsg, "slongo", [], { name: "Grupo Teste" });
	const slongoImgMeta = await sharp(
		Buffer.from(bot.capturedMessages[0].content.data, "base64")
	).metadata();
	assert.strictEqual(slongoImgMeta.width, 512);
	assert.strictEqual(slongoImgMeta.height, 512);

	const slongoHqImgMsg = createMessage({
		type: "image",
		caption: "!slongohq",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: {
			mimetype: "image/png",
			data: imgBuffer.toString("base64")
		}
	});
	resetCase();
	await cmdHandler.processCommand(bot, slongoHqImgMsg, "slongohq", [], { name: "Grupo Teste" });
	const slongoHqImgMeta = await sharp(
		Buffer.from(bot.capturedMessages[0].content.data, "base64")
	).metadata();
	assert.strictEqual(slongoHqImgMeta.width, 512);
	assert.strictEqual(slongoHqImgMeta.height, 256);
	console.log("✓ Imagens estáticas ok em !slongo (512x512) e !slongohq (512x256)");

	// 13. Teste: Vídeo curto muxado com trilha de áudio mais longa (!slongohq prioriza trilha de vídeo)
	console.log("\n13. Testando vídeo 4s muxado com áudio de 12s em !slongohq...");
	const muxedPath = path.join(tempDir, "muxed-short-video-long-audio.mp4");
	await createMuxedVideoWithLongerAudio(muxedPath, 320, 180, 4, 12);
	const muxedBuffer = await fs.readFile(muxedPath);
	const muxedMsg = createMessage({
		type: "video",
		caption: "!slongohq",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: {
			mimetype: "video/mp4",
			data: muxedBuffer.toString("base64")
		}
	});
	resetCase();
	await cmdHandler.processCommand(bot, muxedMsg, "slongohq", [], { name: "Grupo Teste" });
	const muxedWebpBuffer = Buffer.from(bot.capturedMessages[0].content.data, "base64");
	const muxedMeta = await sharp(muxedWebpBuffer, { animated: true }).metadata();
	assert.strictEqual(muxedMeta.width, 512, "Vídeo de 4s deve manter 512px mesmo com áudio de 12s");
	console.log(
		`✓ !slongohq vídeo 4s + áudio 12s: mantido em ${muxedMeta.width}x${muxedMeta.pageHeight || muxedMeta.height}, ${(muxedWebpBuffer.length / 1024).toFixed(1)} KB`
	);

	// 14. Teste: Vídeo 60s de ruído puro em !slongohq deve caber no limite de 490 KB
	console.log("\n14. Testando vídeo 60s de ruído intenso em !slongohq...");
	const noisyPath = path.join(tempDir, "noisy-60s.mp4");
	await createNoisyVideo(noisyPath, 320, 180, 60);
	const noisyBuffer = await fs.readFile(noisyPath);
	const noisyMsg = createMessage({
		type: "video",
		caption: "!slongohq",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: {
			mimetype: "video/mp4",
			data: noisyBuffer.toString("base64")
		}
	});
	resetCase();
	await cmdHandler.processCommand(bot, noisyMsg, "slongohq", [], { name: "Grupo Teste" });
	const noisyWebpBuffer = Buffer.from(bot.capturedMessages[0].content.data, "base64");
	assert.strictEqual(
		noisyWebpBuffer.length <= 490 * 1024,
		true,
		`Ruído 60s deve caber em <= 490 KB (obtido ${(noisyWebpBuffer.length / 1024).toFixed(1)} KB)`
	);
	console.log(
		`✓ !slongohq ruído 60s: comprimido para ${(noisyWebpBuffer.length / 1024).toFixed(1)} KB <= 490 KB`
	);

	// 15. Teste: Combinação de argumentos e transformações (!s hq qc, !s fh, !s fv, !s 90, !s -90)
	console.log("\n15. Testando argumentos combináveis e transformações...");
	const rectImgBuffer = await sharp({
		create: {
			width: 400,
			height: 200,
			channels: 4,
			background: { r: 255, g: 0, b: 0, alpha: 1 }
		}
	})
		.composite([
			{
				input: await sharp({
					create: {
						width: 200,
						height: 200,
						channels: 4,
						background: { r: 0, g: 255, b: 0, alpha: 1 }
					}
				})
					.png()
					.toBuffer(),
				left: 200,
				top: 0
			}
		])
		.png()
		.toBuffer();

	// 15a. !s hq qc em imagem -> 512x512 quadrado
	const hqQcMsg = createMessage({
		type: "image",
		caption: "!s hq qc",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: { mimetype: "image/png", data: rectImgBuffer.toString("base64") }
	});
	resetCase();
	await cmdHandler.processCommand(bot, hqQcMsg, "s", ["hq", "qc"], { name: "Grupo Teste" });
	assert.strictEqual(bot.capturedMessages.length, 1);
	const hqQcMeta = await sharp(
		Buffer.from(bot.capturedMessages[0].content.data, "base64")
	).metadata();
	assert.strictEqual(hqQcMeta.width, 512);
	assert.strictEqual(hqQcMeta.height, 512);
	assert.strictEqual(bot.capturedMessages[0].options.stickerName, "Grupo Teste");

	// 15b. !s fh (inverter horizontal: direita verde passa para a esquerda)
	const fhMsg = createMessage({
		type: "image",
		caption: "!s fh",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: { mimetype: "image/png", data: rectImgBuffer.toString("base64") }
	});
	resetCase();
	await cmdHandler.processCommand(bot, fhMsg, "s", ["fh"], { name: "Grupo Teste" });
	const fhBuf = Buffer.from(bot.capturedMessages[0].content.data, "base64");
	const fhLeftPixel = await sharp(fhBuf)
		.extract({ left: 10, top: 256, width: 1, height: 1 })
		.raw()
		.toBuffer();
	assert.ok(fhLeftPixel[1] > 200 && fhLeftPixel[0] < 50, "Lado esquerdo deve ficar verde após fh");

	// 15c. !s 90 (girar 90° horário: 400x200 vira 200x400, então com hq fica mais alto que largo)
	const rot90Msg = createMessage({
		type: "image",
		caption: "!s hq 90",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: { mimetype: "image/png", data: rectImgBuffer.toString("base64") }
	});
	resetCase();
	await cmdHandler.processCommand(bot, rot90Msg, "s", ["hq", "90"], { name: "Grupo Teste" });
	const rot90Meta = await sharp(
		Buffer.from(bot.capturedMessages[0].content.data, "base64")
	).metadata();
	assert.strictEqual(rot90Meta.width, 256);
	assert.strictEqual(rot90Meta.height, 512);

	// 15d. !s -90 fv em vídeo
	const videoRotMsg = createMessage({
		type: "video",
		caption: "!s -90 fv",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: { mimetype: "video/mp4", data: videoBuffer.toString("base64") }
	});
	resetCase();
	await cmdHandler.processCommand(bot, videoRotMsg, "s", ["-90", "fv"], { name: "Grupo Teste" });
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.strictEqual(bot.capturedMessages[0].options.sendMediaAsSticker, true);
	console.log("✓ Combinação de args (!s hq qc, !s fh, !s hq 90, !s -90 fv) validada");

	// 16. Teste: Anexo document PNG transparente, vídeo e tipo não suportado
	console.log("\n16. Testando !s em anexos document...");
	const docPngMsg = createMessage({
		type: "document",
		caption: "!s",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: {
			mimetype: "application/octet-stream",
			filename: "arte.png",
			data: rectImgBuffer.toString("base64")
		}
	});
	resetCase();
	await cmdHandler.processCommand(bot, docPngMsg, "s", [], { name: "Grupo Teste" });
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.strictEqual(bot.capturedMessages[0].options.sendMediaAsSticker, true);

	const docPdfMsg = createMessage({
		type: "document",
		caption: "!s",
		group: "120363000000000099@g.us",
		author: "5511999990001@s.whatsapp.net",
		content: {
			mimetype: "application/pdf",
			filename: "doc.pdf",
			data: Buffer.from("%PDF-1.4").toString("base64")
		}
	});
	resetCase();
	await cmdHandler.processCommand(bot, docPdfMsg, "s", [], { name: "Grupo Teste" });
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert.ok(
		String(bot.capturedMessages[0].content).includes("Esse tipo de arquivo não vira figurinha")
	);
	console.log("✓ Document PNG gerou sticker e Document PDF foi recusado com aviso");

	// 17. Teste: Verificar que nenhum arquivo temporário ficou para trás em temp/whatsapp-bot-stickers
	const afterTempFiles = await fs.readdir(stickersTempDir).catch(() => []);
	const leftoverFiles = afterTempFiles.filter((file) => !beforeTempFiles.has(file));
	assert.strictEqual(
		leftoverFiles.length,
		0,
		`Nenhum arquivo temporário deveria sobrar em temp/whatsapp-bot-stickers (encontrados: ${leftoverFiles.join(", ")})`
	);
	console.log("✓ Limpeza confirmada: zero arquivos temporários residuais");

	// Limpeza dos arquivos temporários de teste
	await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Erro nos testes:", err);
	process.exit(1);
});
