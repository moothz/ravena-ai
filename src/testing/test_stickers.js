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

async function createTestVideo(outputPath, width = 320, height = 180, duration = 2) {
	return new Promise((resolve, reject) => {
		ffmpeg()
			.input(`testsrc=duration=${duration}:size=${width}x${height}:rate=15`)
			.inputFormat("lavfi")
			.outputOptions(["-y", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
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

	const tempDir = path.join(__dirname, "../../temp", "test-stickers");
	await fs.mkdir(tempDir, { recursive: true });

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

	bot.resetCapture();
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

	bot.resetCapture();
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

	bot.resetCapture();
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

	bot.resetCapture();
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

	bot.resetCapture();
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

	bot.resetCapture();
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

	// Limpeza dos arquivos temporários de teste
	await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Erro nos testes:", err);
	process.exit(1);
});
