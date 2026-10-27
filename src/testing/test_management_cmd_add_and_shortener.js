process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const urlShortenerService = require("../services/UrlShortenerService");
const storageService = require("../services/StorageService");
const Management = require("../commands/Management");
const YoutubeDownloader = require("../functions/YoutubeDownloader");
const Group = require("../models/Group");
const path = require("path");
const fs = require("fs");

async function main() {
	console.log("=== INICIANDO TESTES: CMDADD ALERTAS, SHORTENER E YT HD S3 ===");

	// -------------------------------------------------------------
	// 1. TESTES DO URL SHORTENER SERVICE
	// -------------------------------------------------------------
	console.log("\n1. Testando UrlShortenerService...");
	// 1.1 URL já encurtada
	const alreadyShort = "https://s.moothz.win/xyz123";
	const resAlreadyShort = await urlShortenerService.shorten(alreadyShort);
	assert.strictEqual(resAlreadyShort, alreadyShort, "URL já encurtada não deve ser alterada");

	// 1.2 URL inválida
	assert.strictEqual(await urlShortenerService.shorten(null), null);
	assert.strictEqual(await urlShortenerService.shorten(""), "");

	// 1.3 Teste de mock / chamada do Sink
	const originalGetToken = urlShortenerService.getToken;
	try {
		// Sem token: retorna url original
		urlShortenerService.getToken = () => "";
		const noTokenUrl = "https://example.com/test-long-url";
		assert.strictEqual(
			await urlShortenerService.shorten(noTokenUrl),
			noTokenUrl,
			"Sem token deve retornar original"
		);
	} finally {
		urlShortenerService.getToken = originalGetToken;
	}
	console.log("✓ UrlShortenerService validado com sucesso.");

	// -------------------------------------------------------------
	// 2. TESTES DO STORAGE SERVICE COM ENCURTAMENTO
	// -------------------------------------------------------------
	console.log("\n2. Testando StorageService Presigned URL...");
	const fakePresigned =
		"https://s3-ravena.moothz.win/downloads/yt/sample.mp4?X-Amz-Signature=abc123longsignature";

	// Mock temporário do urlShortenerService.shorten para teste determinístico de integração do StorageService
	const originalShorten = urlShortenerService.shorten.bind(urlShortenerService);
	let shortenCalledWith = null;
	urlShortenerService.shorten = async (url) => {
		shortenCalledWith = url;
		return "https://s.moothz.win/short1";
	};

	try {
		// 2.1 Sem shorten (default false)
		const normalUrl = await storageService.getPresignedUrl("yt/sample.mp4", {
			shorten: false
		});
		assert.ok(
			normalUrl.includes("sample.mp4"),
			"getPresignedUrl sem shorten deve gerar link direto/presigned"
		);

		// 2.2 Com shorten = true
		const shortUrl = await storageService.getPresignedUrl("yt/sample.mp4", {
			shorten: true
		});
		assert.strictEqual(shortUrl, "https://s.moothz.win/short1", "Deve retornar URL encurtada");
		assert.ok(shortenCalledWith, "shorten() deve ter sido invocado");

		// 2.3 getShortPresignedUrl
		shortenCalledWith = null;
		const shortViaHelper = await storageService.getShortPresignedUrl("yt/sample.mp4");
		assert.strictEqual(shortViaHelper, "https://s.moothz.win/short1");
		assert.ok(shortenCalledWith, "getShortPresignedUrl deve invocar encurtador");
	} finally {
		urlShortenerService.shorten = originalShorten;
	}
	console.log("✓ StorageService presigned URL encurtada validada.");

	// -------------------------------------------------------------
	// 3. TESTES DO MANAGEMENT CMDADD (ALERTAS E MUTAR COMANDO FIXO)
	// -------------------------------------------------------------
	console.log("\n3. Testando Management addCustomCommand alertas...");
	const EventHandler = require("../EventHandler");
	const bot = new FakeBot({ id: "test-bot" });
	const eventHandler = new EventHandler();
	bot.eventHandler = eventHandler;
	await bot.eventHandler.commandHandler.fixedCommands.loadCommands();

	const testGroupId = "999888777@g.us";
	const group = new Group({
		id: testGroupId,
		name: "Grupo Teste",
		prefix: "!",
		mutedCommands: []
	});

	const management = new Management();

	// Mock in-memory do repositório de custom commands para teste unitário sem depender de I/O de banco
	const inMemoryCustomCommands = [];
	management.database.saveCustomCommand = async (gid, cmd) => {
		inMemoryCustomCommands.push(cmd);
		return true;
	};
	management.database.getCustomCommands = async (gid) => inMemoryCustomCommands;

	// 3.1 Tentar adicionar comando com mesmo nome de um comando fixo NÃO mutado (ex: 'pesca')
	const msgPesca = createMessage({
		content: "!g-addCmd pesca",
		group: testGroupId,
		author: "5511999999999@s.whatsapp.net"
	});
	msgPesca.origin.getQuotedMessage = async () => ({
		caption: "Resposta da pesca fake",
		hasMedia: false
	});

	const resPescaAlert = await management.addCustomCommand(bot, msgPesca, ["pesca"], group);

	assert.ok(resPescaAlert, "Deve retornar mensagem de resposta");
	assert.ok(
		resPescaAlert.content.includes("Já existe um comando fixo do bot"),
		`Deveria alertar sobre comando fixo existente. Recebido: ${resPescaAlert.content}`
	);
	assert.ok(
		resPescaAlert.content.includes("!g-mute pesca"),
		`Deveria sugerir mutar o comando fixo. Recebido: ${resPescaAlert.content}`
	);
	console.log("✓ Alerta de comando fixo existente verificado com sucesso.");

	// 3.2 Silenciar o comando fixo e tentar adicionar novamente com o mesmo nome
	group.mutedCommands = ["pesca"];
	const resPescaPermitido = await management.addCustomCommand(bot, msgPesca, ["pesca"], group);

	assert.ok(resPescaPermitido, "Deve retornar mensagem de sucesso");
	assert.ok(
		resPescaPermitido.content.includes("adicionado com sucesso"),
		`Deveria ter sido adicionado após mutar. Recebido: ${resPescaPermitido.content}`
	);
	console.log("✓ Adição permitida após mutar comando fixo verificada.");

	// 3.3 Tentar adicionar um comando com o mesmo nome de um comando personalizado já existente
	const resCustomJaExiste = await management.addCustomCommand(bot, msgPesca, ["pesca"], group);

	assert.ok(resCustomJaExiste, "Deve retornar alerta de duplicata");
	assert.ok(
		resCustomJaExiste.content.includes("Já existe um comando personalizado"),
		`Deveria alertar que já existe custom command. Recebido: ${resCustomJaExiste.content}`
	);
	assert.ok(
		resCustomJaExiste.content.includes("!g-addCmdReply pesca"),
		`Deveria sugerir !g-addCmdReply. Recebido: ${resCustomJaExiste.content}`
	);
	console.log("✓ Alerta de comando customizado duplicado verificado.");

	// -------------------------------------------------------------
	// 4. TESTES DO COMMANDHANDLER (EXECUÇÃO DE CUSTOM SUBSTITUINDO FIXO MUTADO)
	// -------------------------------------------------------------
	console.log("\n4. Testando CommandHandler fallback de comando fixo mutado para custom...");
	// Configura os comandos customizados no bot para o grupo de teste
	bot.eventHandler.commandHandler.customCommands[testGroupId] = inMemoryCustomCommands;
	eventHandler.groups[testGroupId] = group;
	eventHandler.database.getGroup = async (id) => (id === testGroupId ? group : null);
	eventHandler.database.getGroups = async () => [group];

	const msgExecPesca = createMessage({
		content: "!pesca",
		group: testGroupId,
		author: "5511999999999@s.whatsapp.net"
	});

	bot.resetCapture();
	await bot.eventHandler.commandHandler.processCommand(bot, msgExecPesca, "pesca", [], group);

	const executedMsg = bot.capturedMessages.find(
		(m) => m.content && m.content.includes("Resposta da pesca fake")
	);
	assert.ok(
		executedMsg,
		"O comando customizado 'pesca' deveria ter sido executado em vez de ignorado/silenciado"
	);
	console.log("✓ Fallback de comando fixo mutado para comando customizado validado.");

	// -------------------------------------------------------------
	// 5. TESTES DO YOUTUBEDOWNLOADER (ALTA QUALIDADE E S3 LINK)
	// -------------------------------------------------------------
	console.log("\n5. Testando YoutubeDownloader HD e envio com link S3...");
	const dlFolder = process.env.DL_FOLDER || "/app/downloads";
	if (!fs.existsSync(dlFolder)) fs.mkdirSync(dlFolder, { recursive: true });
	const fakeYtFile = path.join(dlFolder, "fake_sample_hd.mp4");
	fs.writeFileSync(fakeYtFile, "fake hd video content for test");

	let hdFlagUsed = null;
	YoutubeDownloader.baixarVideoYoutube = (idVideo, dadosSolicitante, videoHD, callback) => {
		hdFlagUsed = videoHD;
		callback(null, {
			legenda: "Video Teste HD",
			arquivo: fakeYtFile
		});
	};

	// Mock do upload e getPresignedUrl para testar o envio no ytCommand
	const origUpload = storageService.upload.bind(storageService);
	const origGetPresigned = storageService.getPresignedUrl.bind(storageService);
	let uploadCalled = false;
	let presignedShortenParam = null;

	storageService.upload = async () => {
		uploadCalled = true;
		return true;
	};
	storageService.getPresignedUrl = async (key, opts) => {
		presignedShortenParam = opts?.shorten;
		return "https://s.moothz.win/ytHdShort";
	};

	try {
		const ytCmd = bot.eventHandler.commandHandler.fixedCommands.getCommand("yt");
		assert.ok(ytCmd, "Comando !yt deve estar carregado");

		const msgYt = createMessage({
			content: "!yt https://youtu.be/dQw4w9WgXcQ",
			group: testGroupId,
			author: "5511999999999@s.whatsapp.net"
		});

		bot.resetCapture();
		await ytCmd.method(bot, msgYt, ["https://youtu.be/dQw4w9WgXcQ"], group);

		assert.strictEqual(hdFlagUsed, true, "baixarVideoYoutube deve ser chamado com videoHD = true");
		assert.strictEqual(uploadCalled, true, "Deve fazer upload do vídeo para o S3");
		assert.strictEqual(
			presignedShortenParam,
			true,
			"Deve solicitar shorten: true ao getPresignedUrl"
		);

		const sentVideo = bot.capturedMessages.find(
			(m) => m.options && m.options.caption && m.options.caption.includes("Vídeo em alta qualidade")
		);
		assert.ok(sentVideo, "Mensagem enviada deve conter legenda com 'Vídeo em alta qualidade'");
		assert.ok(
			sentVideo.options.caption.includes("https://s.moothz.win/ytHdShort"),
			"Legenda deve conter o link encurtado do S3"
		);
		console.log("✓ YoutubeDownloader via SocialMediaDownloader validado.");

		// Também testa o método standalone de YoutubeDownloader.js
		const standaloneYtCmd = YoutubeDownloader.commands.find((c) => c.name === "yt");
		assert.ok(standaloneYtCmd, "YoutubeDownloader standalone deve existir");
		uploadCalled = false;
		presignedShortenParam = null;
		bot.resetCapture();
		await standaloneYtCmd.method(bot, msgYt, ["https://youtu.be/dQw4w9WgXcQ"], group);

		assert.strictEqual(
			uploadCalled,
			true,
			"YoutubeDownloader standalone deve fazer upload para S3"
		);
		assert.strictEqual(
			presignedShortenParam,
			true,
			"YoutubeDownloader standalone deve usar shorten: true"
		);
		const sentStandalone = bot.capturedMessages.find(
			(m) => m.options && m.options.caption && m.options.caption.includes("Vídeo em alta qualidade")
		);
		assert.ok(
			sentStandalone,
			"YoutubeDownloader standalone deve enviar vídeo com legenda de alta qualidade"
		);
		console.log("✓ YoutubeDownloader standalone validado com sucesso.");
	} finally {
		storageService.upload = origUpload;
		storageService.getPresignedUrl = origGetPresigned;
		if (fs.existsSync(fakeYtFile)) fs.unlinkSync(fakeYtFile);
	}

	// -------------------------------------------------------------
	// 5. TESTES DO !sr E !musica (LETRA DA MÚSICA)
	// -------------------------------------------------------------
	console.log("\n5. Testando comportamento de letra em !sr vs !musica...");
	const axios = require("axios");
	const origAxiosGet = axios.get;
	let lyricsSearchedCount = 0;
	axios.get = async (url, config) => {
		if (typeof url === "string" && url.includes("lrclib.net")) {
			lyricsSearchedCount++;
			return {
				data: [
					{
						trackName: "Bohemian Rhapsody",
						artistName: "Queen",
						plainLyrics: "Is this the real life? Is this just fantasy?"
					}
				]
			};
		}
		return origAxiosGet(url, config);
	};

	const fakeAudioFile = path.join(dlFolder, "fake_sample_audio.mp3");
	fs.writeFileSync(fakeAudioFile, "fake mp3 content");

	const origBaixarMusica = YoutubeDownloader.baixarMusicaYoutube;
	YoutubeDownloader.baixarMusicaYoutube = (idVideo, dadosSolicitante, callback) => {
		callback(null, {
			legenda: "Queen - Bohemian Rhapsody",
			arquivo: fakeAudioFile
		});
	};

	try {
		const srCmd = bot.eventHandler.commandHandler.fixedCommands.getCommand("sr");
		assert.ok(srCmd, "Comando !sr deve existir");

		const musicaCmd = bot.eventHandler.commandHandler.fixedCommands.getCommand("musica");
		assert.ok(musicaCmd, "Comando !musica deve existir");

		// 5.1 Teste do !sr: NÃO deve buscar nem enviar letra
		lyricsSearchedCount = 0;
		bot.resetCapture();
		const msgSr = createMessage({
			content: "!sr https://youtu.be/dQw4w9WgXcQ",
			group: testGroupId,
			author: "5511999999999@s.whatsapp.net"
		});

		await srCmd.method(bot, msgSr, ["https://youtu.be/dQw4w9WgXcQ"], group);

		assert.strictEqual(lyricsSearchedCount, 0, "!sr NÃO deve consultar a API de letras");
		const srLyricsMsg = bot.capturedMessages.find(
			(m) =>
				(typeof m.content === "string" && m.content.includes("🎶 *Letra:*")) ||
				(m.options &&
					typeof m.options.caption === "string" &&
					m.options.caption.includes("🎶 *Letra:*"))
		);
		assert.strictEqual(srLyricsMsg, undefined, "!sr NÃO deve enviar letra da música");
		console.log("✓ !sr verificado: áudio enviado sem letra.");

		// 5.2 Teste do !musica: DEVE buscar e enviar letra
		lyricsSearchedCount = 0;
		bot.resetCapture();
		const msgMusica = createMessage({
			content: "!musica https://youtu.be/dQw4w9WgXcQ",
			group: testGroupId,
			author: "5511999999999@s.whatsapp.net"
		});

		await musicaCmd.method(bot, msgMusica, ["https://youtu.be/dQw4w9WgXcQ"], group);

		assert.ok(lyricsSearchedCount > 0, "!musica DEVE consultar a API de letras");
		const musicaLyricsMsg = bot.capturedMessages.find(
			(m) =>
				(typeof m.content === "string" && m.content.includes("🎶 *Letra:*")) ||
				(m.options &&
					typeof m.options.caption === "string" &&
					m.options.caption.includes("🎶 *Letra:*"))
		);
		assert.ok(musicaLyricsMsg, "!musica DEVE conter a letra da música");
		console.log("✓ !musica verificado: letra enviada com sucesso.");

		// 5.3 Teste do YoutubeDownloader standalone srCommand: NÃO deve enviar letra
		const standaloneSrCmd = YoutubeDownloader.commands.find((c) => c.name === "sr");
		assert.ok(standaloneSrCmd, "YoutubeDownloader standalone sr deve existir");
		lyricsSearchedCount = 0;
		bot.resetCapture();
		await standaloneSrCmd.method(bot, msgSr, ["https://youtu.be/dQw4w9WgXcQ"], group);

		assert.strictEqual(
			lyricsSearchedCount,
			0,
			"YoutubeDownloader standalone sr NÃO deve consultar API de letras"
		);
		const standaloneLyricsMsg = bot.capturedMessages.find(
			(m) =>
				(typeof m.content === "string" && m.content.includes("🎶 *Letra:*")) ||
				(m.options &&
					typeof m.options.caption === "string" &&
					m.options.caption.includes("🎶 *Letra:*"))
		);
		assert.strictEqual(
			standaloneLyricsMsg,
			undefined,
			"YoutubeDownloader standalone sr NÃO deve enviar letra"
		);
		console.log("✓ YoutubeDownloader standalone sr verificado: sem letra.");
	} finally {
		axios.get = origAxiosGet;
		YoutubeDownloader.baixarMusicaYoutube = origBaixarMusica;
		if (fs.existsSync(fakeAudioFile)) fs.unlinkSync(fakeAudioFile);
	}

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

main().catch((err) => {
	console.error("ERRO NO TESTE:", err);
	process.exit(1);
});
