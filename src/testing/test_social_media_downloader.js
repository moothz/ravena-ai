const assert = require("assert");
const fs = require("fs");
const path = require("path");
const FakeBot = require("./FakeBot");
const ReturnMessage = require("../models/ReturnMessage");
const SocialMediaDownloader = require("../functions/SocialMediaDownloader");

const { SMDCacheManager, sendProcessedMedia } = SocialMediaDownloader;

async function runTests() {
	console.log("=== Iniciando Testes do SocialMediaDownloader e SMDCacheManager ===");

	const tempDir = path.join(__dirname, "../../temp/test_smd");
	if (!fs.existsSync(tempDir)) {
		fs.mkdirSync(tempDir, { recursive: true });
	}

	const testFilePath = path.join(tempDir, "test_video.mp4");
	fs.writeFileSync(testFilePath, "dummy video content for testing");

	const oldFilePath = path.join(tempDir, "old_video.mp4");
	fs.writeFileSync(oldFilePath, "old video content for testing");

	try {
		// [Teste 1] SMDCacheManager - Armazenamento e Recuperação de Cache
		console.log("[Teste 1] Testando setCache e getCache no SMDCacheManager...");
		const cacheManager = new SMDCacheManager();

		const testUrl = "https://instagram.com/reel/test12345";
		const files = [
			{
				path: testFilePath,
				mimetype: "video/mp4",
				s3Url: "https://s3-ravena.moothz.win/downloads/social/test_video.mp4"
			}
		];

		await cacheManager.setCache(testUrl, "Instagram", "test_video.mp4", files);

		const cached = await cacheManager.getCache(testUrl);
		assert.ok(cached, "Cache deveria ter sido recuperado com sucesso");
		assert.strictEqual(cached.platform, "Instagram");
		assert.strictEqual(cached.files.length, 1);
		assert.strictEqual(cached.files[0].path, testFilePath);
		console.log("✓ Teste 1 passou: setCache e getCache funcionando corretamente");

		// [Teste 2] SMDCacheManager - Grace Period de 2h no cleanup
		console.log("[Teste 2] Testando proteção do grace period no cleanup...");
		// Mesmo rodando cleanup explicitamente, o arquivo recente NÃO deve ser apagado
		await cacheManager.cleanup();
		assert.ok(fs.existsSync(testFilePath), "Arquivo recente NÃO deve ser apagado pelo cleanup");

		const cachedAfterCleanup = await cacheManager.getCache(testUrl);
		assert.ok(cachedAfterCleanup, "Entrada recente deve permanecer no cache");
		console.log("✓ Teste 2 passou: Arquivos recentes mantidos no cache");

		// [Teste 3] SMDCacheManager - Expiração de arquivos antigos (> 7 dias)
		console.log("[Teste 3] Testando expiração de entradas antigas...");
		const Database = require("../utils/Database");
		const db = Database.getInstance();
		const oldUrl = "https://instagram.com/reel/old99999";
		const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
		const oldData = {
			platform: "Instagram",
			filename: "old_video.mp4",
			files: [{ path: oldFilePath, mimetype: "video/mp4" }],
			timestamp: eightDaysAgo
		};

		await db.dbRun(
			cacheManager.dbName,
			"INSERT OR REPLACE INTO smd_cache (url, platform, json_data, timestamp) VALUES (?, ?, ?, ?)",
			[oldUrl, "Instagram", JSON.stringify(oldData), eightDaysAgo]
		);

		await cacheManager.cleanup();

		const cachedOld = await cacheManager.getCache(oldUrl);
		assert.strictEqual(cachedOld, null, "Entrada com mais de 7 dias deve ter sido removida");
		assert.strictEqual(
			fs.existsSync(oldFilePath),
			false,
			"Arquivo antigo no disco deve ter sido apagado"
		);
		console.log("✓ Teste 3 passou: Entradas antigas limpas com sucesso");

		// [Teste 4] sendProcessedMedia - Formatação de Legenda com Link S3
		console.log("[Teste 4] Testando envio de mídia com link S3 na legenda...");
		const bot = new FakeBot({ id: "test_bot" });
		const chatId = "120363000000000000@g.us";
		const processedFiles = [
			{
				path: testFilePath,
				mimetype: "video/mp4",
				s3Url: "https://s.moothz.win/insta123"
			}
		];

		await sendProcessedMedia(
			bot,
			chatId,
			null,
			"Instagram",
			"meu_video.mp4",
			processedFiles,
			false,
			false,
			"!"
		);

		assert.strictEqual(bot.capturedMessages.length, 1, "Deveria ter enviado 1 mensagem");
		const sentCaption = bot.capturedMessages[0].options?.caption || "";
		assert.ok(sentCaption.includes("Instagram"), "Legenda deve conter a fonte");
		assert.ok(
			sentCaption.includes("https://s.moothz.win/insta123"),
			`Legenda deve conter o link S3 direto. Atual: ${sentCaption}`
		);
		console.log("✓ Teste 4 passou: Legenda com link S3 validada com sucesso");

		// [Teste 5] sendProcessedMedia - Fallback para S3 quando envio direto falhar
		console.log("[Teste 5] Testando fallback para link S3 quando envio direto falha...");
		bot.resetCapture();
		// Simula erro de envio direto (ex: vídeo grande demais para WhatsApp)
		bot.sendReturnMessages = async (msgs) => {
			throw new Error("Video size exceeds WhatsApp limit (60MB)");
		};

		let fallbackSent = false;
		// Substitui para capturar a mensagem de fallback
		const originalSend = FakeBot.prototype.sendReturnMessages;
		bot.sendReturnMessages = async function (msg) {
			if (
				msg &&
				msg.content &&
				typeof msg.content === "string" &&
				msg.content.includes("excedeu o limite")
			) {
				fallbackSent = true;
				return [msg];
			}
			throw new Error("Video size exceeds WhatsApp limit (60MB)");
		};

		await sendProcessedMedia(
			bot,
			chatId,
			null,
			"Instagram",
			"video_pesado.mp4",
			processedFiles,
			false,
			false,
			"!"
		);

		assert.ok(fallbackSent, "Deveria ter enviado mensagem de fallback com link S3");
		console.log("✓ Teste 5 passou: Fallback para link direto S3 executado com sucesso");

		console.log("\n=== Todos os testes do SocialMediaDownloader passaram com sucesso! ===");
	} finally {
		if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
		if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
		if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
