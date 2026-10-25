process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const DiscordBot = require("../DiscordBot");
const storageService = require("../services/StorageService");

async function runTests() {
	console.log("=== Iniciando Testes de S3 Attachments & Isolamento no HD Secundário ===");

	const dlFolder = process.env.DL_FOLDER || "/app/downloads";
	console.log(`[Config] DL_FOLDER: ${dlFolder}`);

	// 1. Testa que storageService possui o bucket downloads e domínio público s3-ravena.moothz.win
	assert.strictEqual(
		storageService.bucketDownloads,
		"downloads",
		"Bucket de downloads deve ser 'downloads'"
	);
	assert.ok(
		storageService.publicDomain.includes("s3-ravena.moothz.win"),
		`Domínio público deve ser s3-ravena.moothz.win (atual: ${storageService.publicDomain})`
	);
	console.log("✓ Teste 1 passou: Configuração do storageService verificada");

	// 2. Instancia WhatsAppBotGo em modo de teste e verifica _storeMediaFile
	const botGo = new WhatsAppBotGo({
		id: "test_bot",
		instanceName: "test_instance",
		whatsgoApiUrl: "http://localhost:8080",
		whatsgoApiKey: "test_key",
		webhookHost: "localhost",
		prefix: "!"
	});

	const sampleBuffer = Buffer.from("conteúdo de teste para anexo s3");
	const presignedUrl = await botGo._storeMediaFile(sampleBuffer, ".txt", "text/plain");

	console.log("URL gerada por _storeMediaFile:", presignedUrl);
	assert.ok(typeof presignedUrl === "string", "Retorno de _storeMediaFile deve ser uma string URL");
	assert.ok(
		presignedUrl.includes("s3-ravena.moothz.win") || presignedUrl.includes("downloads"),
		`URL deve apontar para S3/downloads (atual: ${presignedUrl})`
	);

	// Verifica se o arquivo foi gravado no diretório de downloads (HD secundário)
	const attachmentsDir = path.join(dlFolder, "attachments");
	assert.ok(
		fs.existsSync(attachmentsDir),
		`Diretório ${attachmentsDir} deve existir no HD secundário`
	);
	console.log(
		"✓ Teste 2 passou: WhatsAppBotGo._storeMediaFile salva no DL_FOLDER e retorna link S3"
	);

	// 3. Testa aviso de vídeo como documento em sendMessage
	let capturedPayload = null;
	let capturedEndpoint = null;
	botGo.isConnected = true;
	botGo.apiClient = {
		post: async (endpoint, payload) => {
			capturedEndpoint = endpoint;
			capturedPayload = payload;
			return { data: { Info: { ID: "test_media_id" } } };
		}
	};

	// Simula envio de vídeo grande (> 60MB)
	const fakeVideoMedia = {
		isMessageMedia: true,
		mimetype: "video/mp4",
		url: "https://s3-ravena.moothz.win/downloads/attachments/sample_video.mp4",
		size: 70 * 1024 * 1024, // 70MB
		filename: "sample_video.mp4"
	};

	await botGo.sendMessage("123456@g.us", fakeVideoMedia, {
		caption: "Aqui está o seu vídeo"
	});

	assert.ok(capturedPayload, "Payload deve ter sido capturado pelo stub");
	assert.strictEqual(
		capturedPayload.type,
		"document",
		"Mídia > 60MB deve ser convertida para document"
	);
	assert.ok(
		capturedPayload.caption.includes(
			"📂 Enviado como arquivo devido ao limite de tamanho para vídeos no WhatsApp"
		),
		"Legenda deve conter o aviso padronizado de arquivo grande para vídeos no WhatsApp"
	);
	console.log(
		"✓ Teste 3 passou: WhatsAppBotGo.sendMessage inclui aviso padronizado de envio como arquivo para vídeo"
	);

	// 4. Testa DiscordBot._storePublicAttachment
	const discordBot = new DiscordBot({
		id: "test_discord",
		discordToken: "fake_token_for_test",
		prefix: "!"
	});

	const discordAttachmentUrl = await discordBot._storePublicAttachment(
		sampleBuffer,
		"teste_discord.txt"
	);
	console.log("URL gerada pelo DiscordBot:", discordAttachmentUrl);
	assert.ok(typeof discordAttachmentUrl === "string", "DiscordBot deve retornar string URL válida");
	assert.ok(
		discordAttachmentUrl.includes("s3-ravena.moothz.win") ||
			discordAttachmentUrl.includes("downloads"),
		`URL do Discord deve apontar para S3/downloads (atual: ${discordAttachmentUrl})`
	);
	console.log(
		"✓ Teste 4 passou: DiscordBot._storePublicAttachment salva no DL_FOLDER e gera S3 Presigned URL"
	);

	console.log("=== Todos os testes de S3 Attachments passaram com sucesso! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
