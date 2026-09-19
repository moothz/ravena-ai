const assert = require("assert");
const fs = require("fs").promises;
const path = require("path");
const sharp = require("sharp");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const StickerScraper = require("../functions/StickerScraper");

async function runTests() {
	console.log("=== Iniciando testes de StickerScraper (Lovecell) ===");
	const bot = new FakeBot({ id: "test-bot" });
	const eventHandler = new EventHandler();
	const cmdHandler = eventHandler.commandHandler;
	const mockGroup = { id: "123456@g.us", name: "Grupo Teste" };

	// 1. Teste de cropLovecellBanner com imagem estática 512x597
	console.log("\n1. Testando corte de banner em WebP estático 512x597...");
	const staticTallBuf = await sharp({
		create: {
			width: 512,
			height: 597,
			channels: 4,
			background: { r: 255, g: 100, b: 50, alpha: 1 }
		}
	})
		.webp()
		.toBuffer();

	const staticCropped = await StickerScraper.cropLovecellBanner(staticTallBuf);
	const staticCroppedMeta = await sharp(staticCropped).metadata();
	assert.strictEqual(staticCroppedMeta.width, 512, "Largura deve ser 512");
	assert.strictEqual(
		staticCroppedMeta.height,
		512,
		"Altura deve ser 512 (banner de 85px removido)"
	);
	assert.strictEqual(staticCroppedMeta.format, "webp", "Formato deve ser WebP");
	console.log("✓ WebP estático recortado corretamente para 512x512");

	// 2. Teste de cropLovecellBanner com WebP animado
	console.log("\n2. Testando corte de banner em WebP animado (múltiplas páginas)...");
	const animTallBuf = await sharp({
		create: {
			width: 512,
			height: 597 * 2,
			channels: 4,
			background: { r: 50, g: 150, b: 250, alpha: 1 }
		}
	})
		.webp({ animated: true, pageHeight: 597 })
		.toBuffer();

	const animCropped = await StickerScraper.cropLovecellBanner(animTallBuf);
	const animCroppedMeta = await sharp(animCropped, { animated: true }).metadata();
	assert.strictEqual(animCroppedMeta.width, 512, "Largura deve ser 512");
	const pageH = animCroppedMeta.pageHeight || animCroppedMeta.height;
	assert.strictEqual(pageH, 512, "Altura da página/frame deve ser 512");
	console.log("✓ WebP animado recortado preservando frames e 512x512");

	// 3. Teste de cleanTitle
	console.log("\n3. Testando limpeza de títulos (cleanTitle)...");
	assert.strictEqual(
		StickerScraper.cleanTitle('Figurinha "Meme legal" para WhatsApp'),
		"Meme legal"
	);
	assert.strictEqual(StickerScraper.cleanTitle("Figurinha Sem Aspas para WhatsApp"), "Sem Aspas");
	assert.strictEqual(StickerScraper.cleanTitle(""), "Lovecell");
	console.log("✓ cleanTitle limpa títulos corretamente");

	// 4. Teste de execução do comando !figa com ID conhecido (37019)
	console.log("\n4. Testando comando !figa 37019...");
	bot.resetCapture();

	const testCachedFile = path.join(StickerScraper.LOVECELL_DIR, "figs_lovecell_37019.webp");
	try {
		await fs.unlink(testCachedFile);
	} catch {}

	const msgSpecific = createMessage({
		content: "!figa 37019",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		authorName: "Testador"
	});

	await cmdHandler.processCommand(bot, msgSpecific, "figa", ["37019"], mockGroup);
	assert.strictEqual(bot.capturedMessages.length, 1, "Deve enviar exatamente 1 mensagem");
	const sentMsg = bot.capturedMessages[0];
	assert.strictEqual(
		sentMsg.options.sendMediaAsSticker,
		true,
		"Deve enviar com flag sendMediaAsSticker: true"
	);
	assert.strictEqual(sentMsg.content.mimetype, "image/webp", "Mimetype deve ser image/webp");
	assert(
		sentMsg.options.stickerName.includes("MegaMente"),
		"Sticker name deve conter o título limpo"
	);

	const fileExists = await fs
		.stat(testCachedFile)
		.then(() => true)
		.catch(() => false);
	assert.strictEqual(
		fileExists,
		true,
		"Arquivo figs_lovecell_37019.webp deve ter sido salvo no cache"
	);
	console.log("✓ !figa 37019 buscou, recortou, salvou em cache e enviou como sticker");

	// 5. Teste de cache hit: executar novamente !figa 37019 deve ler do cache
	console.log("\n5. Testando cache hit para !figa 37019...");
	bot.resetCapture();
	await cmdHandler.processCommand(bot, msgSpecific, "figa", ["37019"], mockGroup);
	assert.strictEqual(bot.capturedMessages.length, 1, "Deve enviar a figurinha a partir do cache");
	assert.strictEqual(bot.capturedMessages[0].options.sendMediaAsSticker, true);
	console.log("✓ Figurinha retornada do cache com sucesso");

	// 6. Teste de comando aleatório !figa padrão (1 figurinha)
	console.log("\n6. Testando comando !figa (modo aleatório, padrão = 1)...");
	bot.resetCapture();
	const msgRandom = createMessage({
		content: "!figa",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		authorName: "Testador"
	});

	await cmdHandler.processCommand(bot, msgRandom, "figa", [], mockGroup);
	assert.strictEqual(bot.capturedMessages.length, 1, "Deve enviar 1 figurinha aleatória");
	const sentRandom = bot.capturedMessages[0];
	assert.strictEqual(sentRandom.options.sendMediaAsSticker, true, "Deve enviar como sticker");
	assert.strictEqual(sentRandom.content.mimetype, "image/webp", "Mimetype deve ser image/webp");
	console.log("✓ !figa encontrou, recortou e enviou 1 figurinha aleatória");

	// 7. Teste de quantidade múltipla (ex: !figa 2 e limite máximo de 4)
	console.log("\n7. Testando quantidade múltipla (!figa 2)...");
	bot.resetCapture();
	const msgQtd2 = createMessage({
		content: "!figa 2",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		authorName: "Testador"
	});
	await cmdHandler.processCommand(bot, msgQtd2, "figa", ["2"], mockGroup);
	assert.strictEqual(bot.capturedMessages.length, 2, "Deve enviar 2 figurinhas");
	for (const m of bot.capturedMessages) {
		assert.strictEqual(m.options.sendMediaAsSticker, true);
		assert.strictEqual(m.content.mimetype, "image/webp");
	}
	console.log("✓ !figa 2 enviou com sucesso 2 figurinhas de uma vez");

	// 8. Teste de comandos definidos e descrição
	console.log("\n8. Testando nomes dos comandos e descrição exata...");
	const cmdFiga = cmdHandler.fixedCommands.getCommand("figa");
	const cmdFigrandom = cmdHandler.fixedCommands.getCommand("figrandom");

	assert(cmdFiga, "Comando figa deve existir");
	assert(cmdFigrandom, "Comando figrandom deve existir");
	assert.strictEqual(
		cmdFiga.description,
		"Faz scraping da figurinha principal no Lovecell (estático ou animado)"
	);
	assert.strictEqual(
		cmdFigrandom.description,
		"Faz scraping da figurinha principal no Lovecell (estático ou animado)"
	);
	assert.strictEqual(cmdFiga.group, "lovecell");
	assert.strictEqual(cmdFigrandom.group, "lovecell");
	assert.strictEqual(cmdFiga.reply, false, "Comando figa deve ter reply: false");
	assert.strictEqual(cmdFigrandom.reply, false, "Comando figrandom deve ter reply: false");
	assert.strictEqual(
		sentMsg.options.quotedMessageId,
		undefined,
		"Não deve citar a mensagem quando reply: false"
	);
	console.log(
		"✓ Comandos 'figa' e 'figrandom' configurados com reply: false, descrição correta e mesmo group"
	);

	// 9. Teste de rate limit com fallback de cache
	console.log("\n9. Testando resposta a rate limit com fallback do cache local...");
	bot.resetCapture();
	const originalFetch = StickerScraper.fetchLovecellSticker;
	StickerScraper.fetchLovecellSticker = async () => ({ found: false, rateLimit: true });
	try {
		const msgRate = createMessage({
			content: "!figa",
			group: "123456@g.us",
			author: "5511999999999@s.whatsapp.net",
			authorName: "Testador"
		});
		await cmdHandler.processCommand(bot, msgRate, "figa", [], mockGroup);
		assert.strictEqual(bot.capturedMessages.length, 1);
		assert.strictEqual(
			bot.capturedMessages[0].options.sendMediaAsSticker,
			true,
			"Deve enviar figurinha do cache como fallback em rate limit"
		);
		console.log("✓ Rate limit acionou fallback e enviou figurinha já baixada do cache");

		// 10. Teste de rate limit sem nenhuma figurinha em cache
		console.log("\n10. Testando rate limit com cache vazio...");
		bot.resetCapture();
		const originalGetCached = StickerScraper.getRandomCachedStickers;
		StickerScraper.getRandomCachedStickers = async () => [];
		try {
			await cmdHandler.processCommand(bot, msgRate, "figa", [], mockGroup);
			assert.strictEqual(bot.capturedMessages.length, 1);
			assert(
				bot.capturedMessages[0].content.includes("temporariamente indisponível"),
				"Deve avisar que o serviço está temporariamente indisponível caso não haja cache"
			);
			console.log("✓ Rate limit com cache vazio avisou o usuário corretamente");
		} finally {
			StickerScraper.getRandomCachedStickers = originalGetCached;
		}
	} finally {
		StickerScraper.fetchLovecellSticker = originalFetch;
	}

	console.log("\n=== TODOS OS TESTES DE STICKERSCRAPER PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("\n❌ FALHA NOS TESTES:", err);
	process.exit(1);
});
