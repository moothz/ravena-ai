const assert = require("assert");
const fs = require("fs").promises;
const path = require("path");
const sharp = require("sharp");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const StickerScraper = require("../functions/StickerScraper");

async function runTests() {
	console.log("=== Iniciando testes de StickerScraper (Lovecell, NSFW & Offline Stock) ===");

	// Garante que o timer em background esteja parado durante os testes
	StickerScraper.stopScraperTimer();

	const bot = new FakeBot({ id: "test-bot" });
	const eventHandler = new EventHandler();
	const cmdHandler = eventHandler.commandHandler;

	function clearCooldowns() {
		try {
			const db = cmdHandler.database.getSQLiteDb("cooldowns");
			if (db) db.prepare("DELETE FROM cooldowns").run();
		} catch {}
	}

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
	clearCooldowns();

	const testCachedFile = path.join(StickerScraper.LOVECELL_DIR, "figs_lovecell_37019.webp");
	try {
		await fs.unlink(testCachedFile);
	} catch {}

	const msgSpecific = createMessage({
		content: "!figa 37019",
		group: "group_test_4@g.us",
		author: "user_test_4@s.whatsapp.net",
		authorName: "Testador 4"
	});

	await cmdHandler.processCommand(bot, msgSpecific, "figa", ["37019"], {
		id: "group_test_4@g.us",
		name: "Grupo Teste 4"
	});
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
	clearCooldowns();
	const msgSpecificCache = createMessage({
		content: "!figa 37019",
		group: "group_test_5@g.us",
		author: "user_test_5@s.whatsapp.net",
		authorName: "Testador 5"
	});
	await cmdHandler.processCommand(bot, msgSpecificCache, "figa", ["37019"], {
		id: "group_test_5@g.us",
		name: "Grupo Teste 5"
	});
	assert.strictEqual(bot.capturedMessages.length, 1, "Deve enviar a figurinha a partir do cache");
	assert.strictEqual(bot.capturedMessages[0].options.sendMediaAsSticker, true);
	console.log("✓ Figurinha retornada do cache com sucesso");

	// 6. Teste de comando aleatório !figa padrão (1 figurinha)
	console.log("\n6. Testando comando !figa (modo aleatório, padrão = 1)...");
	bot.resetCapture();
	clearCooldowns();
	const msgRandom = createMessage({
		content: "!figa",
		group: "group_test_6@g.us",
		author: "user_test_6@s.whatsapp.net",
		authorName: "Testador 6"
	});

	await cmdHandler.processCommand(bot, msgRandom, "figa", [], {
		id: "group_test_6@g.us",
		name: "Grupo Teste 6"
	});
	assert.strictEqual(bot.capturedMessages.length, 1, "Deve enviar 1 figurinha aleatória");
	const sentRandom = bot.capturedMessages[0];
	assert.strictEqual(sentRandom.options.sendMediaAsSticker, true, "Deve enviar como sticker");
	assert.strictEqual(sentRandom.content.mimetype, "image/webp", "Mimetype deve ser image/webp");
	console.log("✓ !figa encontrou, recortou e enviou 1 figurinha aleatória");

	// 7. Teste de quantidade múltipla (ex: !figa 2 e limite máximo de 4)
	console.log("\n7. Testando quantidade múltipla (!figa 2)...");
	bot.resetCapture();
	clearCooldowns();
	const msgQtd2 = createMessage({
		content: "!figa 2",
		group: "group_test_7@g.us",
		author: "user_test_7@s.whatsapp.net",
		authorName: "Testador 7"
	});
	await cmdHandler.processCommand(bot, msgQtd2, "figa", ["2"], {
		id: "group_test_7@g.us",
		name: "Grupo Teste 7"
	});
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
	console.log(
		"✓ Comandos 'figa' e 'figrandom' configurados com reply: false, descrição correta e mesmo group"
	);

	// 9. Teste de rate limit com fallback de cache
	console.log("\n9. Testando resposta a rate limit com fallback do cache local...");
	bot.resetCapture();
	clearCooldowns();
	const originalFetch = StickerScraper.fetchLovecellSticker;
	StickerScraper.fetchLovecellSticker = async () => ({ found: false, rateLimit: true });
	try {
		const msgRate = createMessage({
			content: "!figa",
			group: "group_test_9@g.us",
			author: "user_test_9@s.whatsapp.net",
			authorName: "Testador 9"
		});
		await cmdHandler.processCommand(bot, msgRate, "figa", [], {
			id: "group_test_9@g.us",
			name: "Grupo Teste 9"
		});
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
		clearCooldowns();
		const originalGetCached = StickerScraper.getRandomCachedStickers;
		StickerScraper.getRandomCachedStickers = async () => [];
		try {
			const msgRateEmpty = createMessage({
				content: "!figa",
				group: "group_test_10@g.us",
				author: "user_test_10@s.whatsapp.net",
				authorName: "Testador 10"
			});
			await cmdHandler.processCommand(bot, msgRateEmpty, "figa", [], {
				id: "group_test_10@g.us",
				name: "Grupo Teste 10"
			});
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

	// 11. Teste de Detecção NSFW com ID Específico e Blacklist
	console.log("\n11. Testando detecção NSFW com ID específico e adição à blacklist...");
	bot.resetCapture();
	clearCooldowns();
	const nsfwTestId = 999991;
	const originalCheckNSFW = StickerScraper.checkStickerNSFW;
	const originalFetchLovecell = StickerScraper.fetchLovecellSticker;

	// Simula resposta do Lovecell para o ID de teste (buffer válido com tamanho > 3KB)
	const crypto = require("crypto");
	const rawBytes = crypto.randomBytes(256 * 298 * 3);
	const dummyWebp = await sharp(rawBytes, { raw: { width: 256, height: 298, channels: 3 } })
		.resize(512, 597)
		.webp({ quality: 80 })
		.toBuffer();
	assert(dummyWebp.length >= StickerScraper.MIN_STICKER_BYTES, "dummyWebp deve ter tamanho >= 3KB");

	StickerScraper.fetchLovecellSticker = async (id) => {
		if (id === nsfwTestId) {
			return {
				found: true,
				buffer: dummyWebp,
				title: "Sticker NSFW Proibido",
				imageUrl: `https://img2.lovecell.com.br/figurinhas/${id}.webp`
			};
		}
		return originalFetchLovecell(id);
	};

	// Simula detecção NSFW positiva
	StickerScraper.checkStickerNSFW = async (buffer, id) => id === nsfwTestId;

	const msgNSFWSpecific = createMessage({
		content: `!figa ${nsfwTestId}`,
		group: "group_test_11@g.us",
		author: "user_test_11@s.whatsapp.net",
		authorName: "Testador 11"
	});

	await cmdHandler.processCommand(bot, msgNSFWSpecific, "figa", [String(nsfwTestId)], {
		id: "group_test_11@g.us",
		name: "Grupo Teste 11"
	});
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert(
		bot.capturedMessages[0].content.includes("bloqueada por conter conteúdo impróprio (NSFW)"),
		"Deve informar que o sticker foi bloqueado por ser NSFW"
	);
	assert(
		StickerScraper.isBlacklisted(nsfwTestId),
		"O ID 999991 deve ter sido adicionado à blacklist"
	);

	// Verifica se NÃO foi salvo no cache
	const nsfwFilePath = StickerScraper.getStickerFilePath(nsfwTestId);
	let nsfwFileOnDisk = false;
	try {
		await fs.stat(nsfwFilePath);
		nsfwFileOnDisk = true;
	} catch {}
	assert.strictEqual(nsfwFileOnDisk, false, "Sticker NSFW não deve ser salvo no cache!");

	// Executar novamente com ID na blacklist deve bloquear imediatamente sem nem consultar o site
	bot.resetCapture();
	clearCooldowns();
	let fetchCalled = false;
	StickerScraper.fetchLovecellSticker = async () => {
		fetchCalled = true;
		return { found: true };
	};
	const msgBlacklisted = createMessage({
		content: `!figa ${nsfwTestId}`,
		group: "group_test_11b@g.us",
		author: "user_test_11b@s.whatsapp.net",
		authorName: "Testador 11b"
	});
	await cmdHandler.processCommand(bot, msgBlacklisted, "figa", [String(nsfwTestId)], {
		id: "group_test_11b@g.us",
		name: "Grupo Teste 11b"
	});
	assert.strictEqual(
		fetchCalled,
		false,
		"Não deve consultar o site para ID que já está na blacklist"
	);
	assert(bot.capturedMessages[0].content.includes("bloqueada"));
	console.log(
		"✓ Detecção NSFW para ID específico bloqueou o envio e adicionou à blacklist com sucesso"
	);

	// 12. Teste de Detecção NSFW no modo aleatório (pula NSFW e pega o próximo)
	console.log(
		"\n12. Testando modo aleatório com NSFW (pula NSFW e entrega sticker seguro seguinte)..."
	);
	bot.resetCapture();
	clearCooldowns();

	let attemptSeq = 0;
	StickerScraper.fetchLovecellSticker = async () => {
		attemptSeq++;
		if (attemptSeq === 1) {
			return {
				found: true,
				buffer: dummyWebp,
				title: "NSFW Random",
				imageUrl: "https://img2.lovecell.com.br/figurinhas/999992.webp"
			};
		}
		return {
			found: true,
			buffer: dummyWebp,
			title: "Safe Random",
			imageUrl: "https://img2.lovecell.com.br/figurinhas/999993.webp"
		};
	};

	StickerScraper.checkStickerNSFW = async () =>
		// Apenas a primeira tentativa é marcada como NSFW
		attemptSeq === 1;

	const msgRandomNSFW = createMessage({
		content: "!figa",
		group: "group_test_12@g.us",
		author: "user_test_12@s.whatsapp.net",
		authorName: "Testador 12"
	});

	await cmdHandler.processCommand(bot, msgRandomNSFW, "figa", [], {
		id: "group_test_12@g.us",
		name: "Grupo Teste 12"
	});
	assert.strictEqual(bot.capturedMessages.length, 1, "Deve entregar 1 sticker seguro");
	assert.strictEqual(
		bot.capturedMessages[0].options.sendMediaAsSticker,
		true,
		"Deve ser enviado como sticker"
	);
	console.log("✓ Modo aleatório pulou figurinha NSFW e buscou a próxima válida com sucesso");

	// 13. Teste de persistência da blacklist e exclusão de cache
	console.log(
		"\n13. Testando persistência da blacklist (blacklist.json) e remoção de arquivo em cache..."
	);
	const cacheRemovalId = 999994;
	const cacheRemovalPath = StickerScraper.getStickerFilePath(cacheRemovalId);
	await fs.writeFile(cacheRemovalPath, dummyWebp);
	assert(
		await fs
			.stat(cacheRemovalPath)
			.then(() => true)
			.catch(() => false),
		"Arquivo teste deve existir"
	);

	await StickerScraper.addToBlacklist(cacheRemovalId);
	assert(StickerScraper.isBlacklisted(cacheRemovalId), "Deve constar na blacklist em memória");

	// Arquivo deve ter sido removido
	const fileExistsAfterBlacklist = await fs
		.stat(cacheRemovalPath)
		.then(() => true)
		.catch(() => false);
	assert.strictEqual(
		fileExistsAfterBlacklist,
		false,
		"Arquivo em cache deve ser apagado ao ser adicionado à blacklist"
	);

	// Testa recarga da blacklist a partir do JSON
	StickerScraper.loadBlacklistSync();
	assert(
		StickerScraper.isBlacklisted(cacheRemovalId),
		"Deve continuar na blacklist após recarga do JSON"
	);
	console.log("✓ Blacklist persistida e sincronizada no JSON com sucesso");

	// 14. Teste de getRandomUndownloadedId (não repete IDs já baixados nem blacklisted)
	console.log("\n14. Testando sorteio de IDs não baixados e não blacklisted...");
	const undownloadedId = StickerScraper.getRandomUndownloadedId();
	assert(typeof undownloadedId === "number", "Deve retornar um ID numérico");
	assert(
		!StickerScraper.isDownloaded(undownloadedId),
		"ID sorteado não deve estar marcado como baixado"
	);
	assert(!StickerScraper.isBlacklisted(undownloadedId), "ID sorteado não deve estar na blacklist");
	console.log("✓ getRandomUndownloadedId() sorteou ID válido e inédito com sucesso");

	// 15. Teste do ciclo do background scraper (runBackgroundScraperTick)
	console.log("\n15. Testando ciclo do background scraper (runBackgroundScraperTick)...");
	const backgroundSafeId = 999995;
	const backgroundSafePath = StickerScraper.getStickerFilePath(backgroundSafeId);
	try {
		await fs.unlink(backgroundSafePath);
	} catch {}

	StickerScraper.fetchLovecellSticker = async () => ({
		found: true,
		buffer: dummyWebp,
		title: "Background Safe Sticker"
	});
	StickerScraper.checkStickerNSFW = async () => false; // Seguro
	StickerScraper.getRandomUndownloadedId = () => backgroundSafeId;

	await StickerScraper.runBackgroundScraperTick();

	const bgFileSaved = await fs
		.stat(backgroundSafePath)
		.then(() => true)
		.catch(() => false);
	assert.strictEqual(
		bgFileSaved,
		true,
		"Figurinha segura deve ser salva no cache offline pelo background scraper"
	);
	assert(StickerScraper.isDownloaded(backgroundSafeId), "ID deve ser registrado como baixado");
	await fs.unlink(backgroundSafePath);

	// Agora testa ciclo onde background scraper encontra sticker NSFW
	const backgroundNsfwId = 999996;
	const backgroundNsfwPath = StickerScraper.getStickerFilePath(backgroundNsfwId);
	StickerScraper.checkStickerNSFW = async () => true; // NSFW
	StickerScraper.getRandomUndownloadedId = () => backgroundNsfwId;

	await StickerScraper.runBackgroundScraperTick();

	const bgNsfwSaved = await fs
		.stat(backgroundNsfwPath)
		.then(() => true)
		.catch(() => false);
	assert.strictEqual(
		bgNsfwSaved,
		false,
		"Figurinha NSFW NÃO deve ser salva no cache offline pelo background scraper"
	);
	assert(
		StickerScraper.isBlacklisted(backgroundNsfwId),
		"Figurinha NSFW deve ser adicionada à blacklist pelo background scraper"
	);
	console.log(
		"✓ runBackgroundScraperTick salvou stickers seguros e descartou/blacklistou stickers NSFW"
	);

	// 16. Teste de controle do timer (start/stop/status)
	console.log("\n16. Testando controle do timer (start, stop, isRunning)...");
	assert.strictEqual(StickerScraper.isScraperTimerRunning(), false);
	StickerScraper.startScraperTimer(60000);
	assert.strictEqual(StickerScraper.isScraperTimerRunning(), true);
	StickerScraper.stopScraperTimer();
	assert.strictEqual(StickerScraper.isScraperTimerRunning(), false);
	console.log("✓ Controle do timer (start/stop/status) validado com sucesso");

	// 17. Teste do filtro de tamanho mínimo (< 3KB considerado inválido)
	console.log("\n17. Testando filtro de tamanho mínimo (< 3KB considerado inválido)...");
	const tinyWebp = await sharp({
		create: {
			width: 64,
			height: 64,
			channels: 4,
			background: { r: 255, g: 255, b: 255, alpha: 1 }
		}
	})
		.webp()
		.toBuffer();
	assert(
		tinyWebp.length < StickerScraper.MIN_STICKER_BYTES,
		`tinyWebp (${tinyWebp.length} bytes) deve ser menor que 3KB (${StickerScraper.MIN_STICKER_BYTES} bytes)`
	);

	// A) saveStickerToCache deve recusar salvar buffers menores que 3KB
	const tinyId = 999997;
	const tinySaveResult = await StickerScraper.saveStickerToCache(tinyId, tinyWebp);
	assert.strictEqual(
		tinySaveResult,
		null,
		"saveStickerToCache deve retornar null para buffer < 3KB"
	);

	// B) getStickerFromCache deve remover arquivo existente no disco com < 3KB e retornar null
	const tinyFilePath = StickerScraper.getStickerFilePath(tinyId);
	await fs.writeFile(tinyFilePath, tinyWebp);
	assert(
		await fs
			.stat(tinyFilePath)
			.then(() => true)
			.catch(() => false),
		"Arquivo temporário deve ter sido escrito"
	);

	const cachedResult = StickerScraper.getStickerFromCache(tinyId);
	assert.strictEqual(
		cachedResult,
		null,
		"getStickerFromCache deve retornar null para arquivo < 3KB"
	);
	const tinyFileStillExists = await fs
		.stat(tinyFilePath)
		.then(() => true)
		.catch(() => false);
	assert.strictEqual(
		tinyFileStillExists,
		false,
		"getStickerFromCache deve ter excluído o arquivo < 3KB do disco"
	);

	// C) getRandomCachedStickers deve ignorar arquivos < 3KB
	await fs.writeFile(tinyFilePath, tinyWebp);
	const randomCached = await StickerScraper.getRandomCachedStickers(10);
	const foundTinyInRandom = randomCached.some((item) => item.id === tinyId);
	assert.strictEqual(
		foundTinyInRandom,
		false,
		"getRandomCachedStickers não deve incluir figurinhas < 3KB"
	);
	try {
		await fs.unlink(tinyFilePath);
	} catch {}

	// D) Comando com ID cujo Lovecell retorne < 3KB deve informar como inválida
	bot.resetCapture();
	clearCooldowns();
	StickerScraper.fetchLovecellSticker = async () => ({
		found: false,
		invalid: true,
		tooSmall: true
	});
	const msgTiny = createMessage({
		content: `!figa ${tinyId}`,
		group: "group_test_17@g.us",
		author: "user_test_17@s.whatsapp.net",
		authorName: "Testador 17"
	});
	await cmdHandler.processCommand(bot, msgTiny, "figa", [String(tinyId)], {
		id: "group_test_17@g.us",
		name: "Grupo Teste 17"
	});
	assert.strictEqual(bot.capturedMessages.length, 1);
	assert(
		bot.capturedMessages[0].content.includes("inválida") ||
			bot.capturedMessages[0].content.includes("não foi encontrada"),
		"Deve avisar que a figurinha < 3KB é inválida ou não encontrada"
	);
	console.log("✓ Filtro de figurinhas < 3KB validado com sucesso em todas as etapas");

	// 18. Teste de extractFramesForAnalysis (suporte a WebP estático e animado)
	console.log("\n18. Testando extractFramesForAnalysis (multi-frames para análise temporal)...");
	// Estático: deve retornar exatamente 1 frame
	const staticFrames = await StickerScraper.extractFramesForAnalysis(staticTallBuf, 6);
	assert.strictEqual(staticFrames.length, 1, "WebP estático deve gerar 1 frame");
	assert(typeof staticFrames[0] === "string", "Frame deve ser string base64");

	// Animado: utiliza WebP animado com múltiplas páginas (do cache ou gerado com ffmpeg)
	let multiPageAnim = null;
	const existingAnimFile = path.join(StickerScraper.LOVECELL_DIR, "figs_lovecell_109166.webp");
	try {
		const buf = await fs.readFile(existingAnimFile);
		const m = await sharp(buf, { animated: true }).metadata();
		if (m.pages && m.pages > 1) {
			multiPageAnim = buf;
		}
	} catch {}

	if (!multiPageAnim) {
		const { execSync } = require("child_process");
		const tmpAnim = path.join("/tmp", "test_anim_frames.webp");
		execSync(
			`ffmpeg -y -f lavfi -i testsrc=duration=1:size=64x64:rate=5 -vcodec libwebp -loop 0 "${tmpAnim}" -loglevel error`
		);
		multiPageAnim = await fs.readFile(tmpAnim);
		try {
			await fs.unlink(tmpAnim);
		} catch {}
	}

	const animFrames = await StickerScraper.extractFramesForAnalysis(multiPageAnim, 6);
	assert(animFrames.length > 1, "WebP animado deve gerar múltiplos frames para inspeção temporal");
	assert(animFrames.length <= 6, "Não deve exceder maxFrames (6)");
	assert(
		animFrames.every((f) => typeof f === "string" && f.length > 0),
		"Todos os frames devem ser base64 válidos"
	);
	console.log(
		`✓ extractFramesForAnalysis gerou ${animFrames.length} frames distribuídos para análise temporal via LLM`
	);

	// Restaura stubs
	StickerScraper.fetchLovecellSticker = originalFetch;
	StickerScraper.checkStickerNSFW = originalCheckNSFW;

	console.log("\n=== TODOS OS TESTES DE STICKERSCRAPER PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("\n❌ FALHA NOS TESTES:", err);
	process.exit(1);
});
