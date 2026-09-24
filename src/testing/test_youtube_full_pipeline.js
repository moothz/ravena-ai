/**
 * Teste do pipeline completo do YouTube (StreamMonitor + StreamSystem + Management)
 * Valida:
 * 1. Resolução e extração de Channel ID (UC...)
 * 2. Detecção de livestream (streamOnline e streamOffline)
 * 3. Detecção de novos vídeos gravados (newVideo)
 * 4. Configuração de mídias independentes (videoConfig vs onConfig vs offConfig)
 * 5. Despacho no StreamSystem respeitando videoConfig e onConfig
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const StreamMonitor = require("../services/StreamMonitor");
const StreamSystem = require("../StreamSystem");
const FakeBot = require("./FakeBot");
const Group = require("../models/Group");

async function runTests() {
	console.log("=== INICIANDO TESTE DO PIPELINE COMPLETO DO YOUTUBE ===\n");

	const streamMonitor = StreamMonitor.getInstance();
	if (!streamMonitor.isReady && streamMonitor.initPromise) {
		await streamMonitor.initPromise;
	}

	// -------------------------------------------------------------
	// TESTE 1: Extração e Sanitização de Channel ID
	// -------------------------------------------------------------
	console.log("Teste 1: Sanitização e extração de Channel ID...");
	const sampleHtml = `
		<html>
			<head>
				<link rel="canonical" href="https://www.youtube.com/channel/UCWFgKDVQuRpPC_B7AeZveig">
				<meta itemprop="channelId" content="UCWFgKDVQuRpPC_B7AeZveig">
			</head>
		</html>
	`;
	const extractedId = streamMonitor.extractChannelID(sampleHtml);
	assert.strictEqual(
		extractedId,
		"UCWFgKDVQuRpPC_B7AeZveig",
		"Deve extrair o Channel ID UCWFgKDVQuRpPC_B7AeZveig com sucesso"
	);

	// Teste de canal já com formato UC
	const cleanDirect = streamMonitor.sanitizePlatformChannelName(
		"UCWFgKDVQuRpPC_B7AeZveig",
		"youtube"
	);
	assert.strictEqual(cleanDirect, "UCWFgKDVQuRpPC_B7AeZveig");
	console.log("  ✅ Teste 1 passou!\n");

	// -------------------------------------------------------------
	// TESTE 2: Cache de Channel ID no SQLite
	// -------------------------------------------------------------
	console.log("Teste 2: Cache SQLite de Channel IDs...");
	const testHandle = `test_yt_${Date.now()}`;
	const testId = "UC1234567890123456789012";

	await streamMonitor.database.dbRun(
		streamMonitor.dbNameYt,
		"INSERT OR REPLACE INTO channel_cache (channel_handle, channel_id) VALUES (?, ?)",
		[testHandle.toLowerCase(), testId]
	);

	const resolvedFromCache = await streamMonitor.getYtChannelID(`@${testHandle}`);
	assert.strictEqual(
		resolvedFromCache,
		testId,
		"Deve resolver o ID diretamente do cache SQLite sem requisição de rede"
	);
	console.log("  ✅ Teste 2 passou!\n");

	// -------------------------------------------------------------
	// TESTE 3: Configuração de Mídia no Management (video, on, off)
	// -------------------------------------------------------------
	console.log("Teste 3: Comandos de mídia e estrutura de dados de YouTube...");
	const fakeBot = new FakeBot({ id: "test-bot" });
	const Management = require("../commands/Management");
	const management = new Management();

	const groupTest = new Group({
		id: `120363999_${Date.now()}@g.us`,
		name: "Grupo Teste YouTube",
		youtube: []
	});
	await fakeBot.database.saveGroup(groupTest);

	// Adiciona canal
	const addMsg = {
		group: groupTest.id,
		author: "5511999999999@s.whatsapp.net",
		content: "!g-youtube-canal canal_teste",
		origin: {
			getQuotedMessage: async () => null
		}
	};
	await management.toggleYoutubeChannel(fakeBot, addMsg, ["canal_teste"], groupTest);

	const updatedGroup = await fakeBot.database.getGroup(groupTest.id);
	assert(updatedGroup.youtube.length === 1, "Canal deve ser adicionado em group.youtube");
	const chConfig = updatedGroup.youtube[0];
	assert(chConfig.videoConfig, "Deve possuir videoConfig inicializado");
	assert(chConfig.onConfig, "Deve possuir onConfig inicializado");
	assert(chConfig.offConfig, "Deve possuir offConfig inicializado");
	assert.strictEqual(chConfig.notifyVideos, true, "notifyVideos deve ser true por padrão");
	assert.strictEqual(chConfig.notifyLives, true, "notifyLives deve ser true por padrão");
	console.log("  ✅ Teste 3 passou!\n");

	// -------------------------------------------------------------
	// TESTE 4: Despacho no StreamSystem (newVideo vs streamOnline vs streamOffline)
	// -------------------------------------------------------------
	console.log("Teste 4: Despacho de eventos no StreamSystem...");
	const streamSystem = StreamSystem.getInstance();
	streamSystem.bots = [fakeBot];

	// Customiza mensagens para verificar distinção de mídias
	chConfig.videoConfig = {
		media: [{ type: "text", content: "MENSAGEM_DE_VIDEO: {title} - {link}" }]
	};
	chConfig.onConfig = {
		media: [{ type: "text", content: "MENSAGEM_DE_LIVE_ON: {canal} - {link}" }]
	};
	chConfig.offConfig = {
		media: [{ type: "text", content: "MENSAGEM_DE_LIVE_OFF: {canal}" }]
	};
	await fakeBot.database.saveGroup(updatedGroup);

	// Simula evento newVideo
	fakeBot.resetCapture();
	await streamSystem.handleNewVideo({
		platform: "youtube",
		channelName: "canal_teste",
		title: "Vídeo Incrível",
		url: "https://youtube.com/watch?v=111",
		videoId: "111"
	});
	assert(fakeBot.capturedMessages.length > 0, "Deve enviar mensagem para newVideo");
	assert(
		fakeBot.capturedMessages[0].content.includes("MENSAGEM_DE_VIDEO"),
		"Deve usar videoConfig para evento de novo vídeo gravado"
	);

	// Simula evento streamOnline
	fakeBot.resetCapture();
	await streamSystem.handleStreamOnline({
		platform: "youtube",
		channelName: "canal_teste",
		title: "Transmissão Ao Vivo",
		url: "https://youtube.com/watch?v=live222",
		videoId: "live222"
	});
	assert(fakeBot.capturedMessages.length > 0, "Deve enviar mensagem para streamOnline");
	assert(
		fakeBot.capturedMessages[0].content.includes("MENSAGEM_DE_LIVE_ON"),
		"Deve usar onConfig para live iniciada"
	);

	// Simula evento streamOffline
	fakeBot.resetCapture();
	await streamSystem.handleStreamOffline({
		platform: "youtube",
		channelName: "canal_teste"
	});
	assert(fakeBot.capturedMessages.length > 0, "Deve enviar mensagem para streamOffline");
	assert(
		fakeBot.capturedMessages[0].content.includes("MENSAGEM_DE_LIVE_OFF"),
		"Deve usar offConfig para live encerrada"
	);

	console.log("  ✅ Teste 4 passou!\n");

	// -------------------------------------------------------------
	// TESTE 5: Métricas do YouTube no getPollingMetrics
	// -------------------------------------------------------------
	console.log("Teste 5: getPollingMetrics no StreamMonitor...");
	const metrics = streamMonitor.getPollingMetrics();
	assert(metrics.youtube, "Deve conter seção youtube");
	assert(
		metrics.youtube.mode === "autonomous" || metrics.youtube.mode === "official_api",
		"Modo deve ser autonomous ou official_api"
	);
	console.log(
		`  Métricas YouTube: Canais=${metrics.youtube.channelCount}, Intervalo=${metrics.youtube.intervalSec}s, Modo=${metrics.youtube.mode}`
	);
	console.log("  ✅ Teste 5 passou!\n");

	console.log("=== TODOS OS 5 TESTES DO PIPELINE YOUTUBE PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro nos testes:", err);
		process.exit(1);
	});
