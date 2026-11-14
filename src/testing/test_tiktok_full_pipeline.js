/**
 * Teste do pipeline completo do TikTok (StreamMonitor + StreamSystem + Management)
 * Valida:
 * 1. Sanitização de usuário/URL do TikTok
 * 2. Parse do liveRoomUserInfo (status 2 = live, 4 = encerrada)
 * 3. Polling: streamOnline/streamOffline, erro transitório não gera offline falso
 * 4. Polling: newVideo só para vídeo recente (24h) e não repete o mesmo vídeo
 * 5. Busca do vídeo mais novo via yt-dlp (ignora vídeo fixado mais antigo)
 * 6. Comandos do Management (!g-tiktok-canal e toggles) e estrutura de dados
 * 7. Despacho no StreamSystem respeitando videoConfig / onConfig / offConfig / notifyLives
 * 8. (Opcional, rede real) TIKTOK_LIVE_TEST="offline_user,online_user"
 *
 * Roda com o Database em testMode: nenhuma escrita chega aos bancos/arquivos reais.
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");

// Precisa vir antes de qualquer serviço que use o singleton do Database
Database.getInstance({ testMode: true, disableBackup: true });

const StreamMonitor = require("../services/StreamMonitor");
const StreamSystem = require("../StreamSystem");
const FakeBot = require("./FakeBot");
const Group = require("../models/Group");

const RUN_ID = Date.now();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ID sintético de vídeo do TikTok: timestamp de criação nos 32 bits mais altos
function fakeVideoId(dateMs) {
	return ((BigInt(Math.floor(dateMs / 1000)) << 32n) + 12345n).toString();
}

/**
 * Isola o monitor em um único canal de teste: canais TikTok reais carregados do banco
 * não são consultados nem recebem resultados dos stubs.
 */
function isolateChannel(monitor, channel) {
	const previousChannels = monitor.channels;
	monitor.channels = [];
	monitor.subscribe(channel, "tiktok");

	const events = [];
	const handlers = {};
	for (const name of ["streamOnline", "streamOffline", "newVideo"]) {
		handlers[name] = (data) => {
			if (data.platform === "tiktok" && data.channelName === channel) {
				events.push({ name, data });
			}
		};
		monitor.on(name, handlers[name]);
	}

	const restore = () => {
		for (const [name, fn] of Object.entries(handlers)) monitor.off(name, fn);
		monitor.unsubscribe(channel, "tiktok");
		monitor.channels = previousChannels;
	};
	return { events, restore };
}

function count(events, name) {
	return events.filter((e) => e.name === name).length;
}

async function testSanitize(monitor) {
	console.log("Teste 1: Sanitização de usuário do TikTok...");
	const cases = {
		"@JulianaJulianaFF": "julianajulianaff",
		"https://www.tiktok.com/@souajenniofc/live": "souajenniofc",
		"tiktok.com/@user.name_1?lang=pt-BR": "user.name_1",
		"https://m.tiktok.com/@abc/video/7300000000000000000": "abc"
	};
	for (const [input, expected] of Object.entries(cases)) {
		assert.strictEqual(monitor.sanitizePlatformChannelName(input, "tiktok"), expected, input);
	}

	const Management = require("../commands/Management");
	const management = new Management();
	for (const [input, expected] of Object.entries(cases)) {
		assert.strictEqual(management.sanitizeTiktokChannelName(input), expected, input);
	}
	console.log("  ✅ Teste 1 passou!\n");
}

function testParseRoomInfo(monitor) {
	console.log("Teste 2: Parse do liveRoomUserInfo...");
	const live = monitor._parseTiktokRoomInfo(
		{
			user: { roomId: "999", avatarLarger: "https://avatar" },
			liveRoom: {
				status: 2,
				title: "Live teste",
				coverUrl: "https://cover",
				startTime: 1700000000,
				liveRoomStats: { userCount: 42 }
			}
		},
		"fulano"
	);
	assert.strictEqual(live.isLive, true);
	assert.strictEqual(live.roomId, "999");
	assert.strictEqual(live.title, "Live teste");
	assert.strictEqual(live.thumbnail, "https://cover");
	assert.strictEqual(live.viewerCount, 42);
	assert.strictEqual(live.startedAt, new Date(1700000000 * 1000).toISOString());
	assert.strictEqual(live.url, "https://www.tiktok.com/@fulano/live");

	assert.deepStrictEqual(monitor._parseTiktokRoomInfo({ liveRoom: { status: 4 } }, "fulano"), {
		isLive: false
	});
	assert.strictEqual(monitor._parseTiktokRoomInfo({ user: {} }, "fulano"), null);

	const notFound = new Error("Failed to retrieve live status from all sources.");
	notFound.config = { requestErrs: [new Error("API Error 19881007 (user_not_found)")] };
	assert.strictEqual(monitor._isTiktokUserNotFoundError(notFound), true);
	assert.strictEqual(monitor._isTiktokUserNotFoundError(new Error("timeout")), false);
	console.log("  ✅ Teste 2 passou!\n");
}

async function testLivePolling(monitor) {
	console.log("Teste 3: Polling de lives (online/offline/erro transitório)...");
	const channel = `tt_live_${RUN_ID}`;
	const { events, restore } = isolateChannel(monitor, channel);

	const originalCheck = monitor._checkTiktokLiveStatus;
	const originalVideo = monitor._checkTiktokLatestVideo;
	monitor._checkTiktokLatestVideo = async () => null;

	try {
		monitor._checkTiktokLiveStatus = async () => ({
			isLive: true,
			roomId: `room_${RUN_ID}`,
			title: "Ao vivo agora",
			thumbnail: "https://cover",
			viewerCount: 10,
			startedAt: new Date().toISOString(),
			url: `https://www.tiktok.com/@${channel}/live`
		});
		await monitor._pollTiktokChannels();
		assert.strictEqual(count(events, "streamOnline"), 1, "online 1x");
		assert.strictEqual(events[0].data.roomId, `room_${RUN_ID}`);

		// Segundo poll ainda ao vivo: sem notificação duplicada
		await monitor._pollTiktokChannels();
		assert.strictEqual(count(events, "streamOnline"), 1, "sem duplicar");

		// Erro transitório (bloqueio/captcha): não pode gerar offline falso
		monitor._checkTiktokLiveStatus = async () => {
			throw new Error("Failed to extract the SIGI_STATE HTML tag, you might be blocked by TikTok.");
		};
		await monitor._pollTiktokChannels();
		assert.strictEqual(count(events, "streamOffline"), 0, "sem offline falso");
		assert.strictEqual(monitor.getChannelStatus(channel, "tiktok").isLive, true);

		// Live encerrada
		monitor._checkTiktokLiveStatus = async () => ({ isLive: false });
		await monitor._pollTiktokChannels();
		assert.strictEqual(count(events, "streamOffline"), 1, "offline 1x");
	} finally {
		monitor._checkTiktokLiveStatus = originalCheck;
		monitor._checkTiktokLatestVideo = originalVideo;
		restore();
	}
	console.log("  ✅ Teste 3 passou!\n");
}

async function testVideoPolling(monitor) {
	console.log("Teste 4: Polling de vídeos novos...");
	const channel = `tt_video_${RUN_ID}`;
	const channelKey = `tiktok:${channel}`;
	const { events, restore } = isolateChannel(monitor, channel);

	const originalCheck = monitor._checkTiktokLiveStatus;
	const originalVideo = monitor._checkTiktokLatestVideo;
	const originalDetails = monitor._fetchTiktokVideoDetails;
	monitor._checkTiktokLiveStatus = async () => ({ isLive: false });
	monitor._fetchTiktokVideoDetails = async (video) => ({
		...video,
		title: "Dancinha nova",
		thumbnail: "https://thumb"
	});

	const oldVideo = {
		id: fakeVideoId(Date.now() - 3 * ONE_DAY_MS),
		url: `https://www.tiktok.com/@${channel}/video/old`,
		publishedAt: new Date(Date.now() - 3 * ONE_DAY_MS).toISOString()
	};
	const newVideo = {
		id: fakeVideoId(Date.now() - 5 * 60 * 1000),
		url: `https://www.tiktok.com/@${channel}/video/new`,
		publishedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
	};

	try {
		// Vídeo antigo (> 24h): só vira baseline, sem notificação
		monitor._checkTiktokLatestVideo = async () => oldVideo;
		await monitor._pollTiktokChannels();
		assert.strictEqual(events.length, 0, "vídeo antigo não notifica");
		assert.strictEqual(monitor.getChannelStatus(channel, "tiktok").lastVideo.id, oldVideo.id);

		// Dentro do intervalo de checagem de vídeos: não consulta de novo
		let called = false;
		monitor._checkTiktokLatestVideo = async () => {
			called = true;
			return newVideo;
		};
		await monitor._pollTiktokChannels();
		assert.strictEqual(called, false, "respeita intervalo de vídeos");

		// Intervalo vencido + vídeo recente: notifica com detalhes
		monitor.tiktokLastVideoCheck[channelKey] = 0;
		await monitor._pollTiktokChannels();
		assert.strictEqual(count(events, "newVideo"), 1, "vídeo novo notifica");
		const videoEvent = events.find((e) => e.name === "newVideo");
		assert.strictEqual(videoEvent.data.videoId, newVideo.id);
		assert.strictEqual(videoEvent.data.title, "Dancinha nova");

		// Mesmo vídeo de novo: não repete
		monitor.tiktokLastVideoCheck[channelKey] = 0;
		await monitor._pollTiktokChannels();
		assert.strictEqual(count(events, "newVideo"), 1, "não repete");
	} finally {
		monitor._checkTiktokLiveStatus = originalCheck;
		monitor._checkTiktokLatestVideo = originalVideo;
		monitor._fetchTiktokVideoDetails = originalDetails;
		restore();
	}
	console.log("  ✅ Teste 4 passou!\n");
}

async function testLatestVideoSelection(monitor) {
	console.log("Teste 5: Seleção do vídeo mais novo via yt-dlp (stub)...");
	const ytdlPath = require.resolve("youtube-dl-exec");
	require(ytdlPath);
	const cachedModule = require.cache[ytdlPath];
	const originalExports = cachedModule.exports;

	const pinnedOld = fakeVideoId(Date.now() - 30 * ONE_DAY_MS);
	const newest = fakeVideoId(Date.now() - 60 * 60 * 1000);
	const middle = fakeVideoId(Date.now() - 2 * ONE_DAY_MS);
	let entries = [{ id: pinnedOld }, { id: middle }, { id: newest }, { id: "not-a-video" }];
	cachedModule.exports = async () => ({ entries });

	try {
		const latest = await monitor._checkTiktokLatestVideo("perfil");
		assert.strictEqual(latest.id, newest, "escolhe o ID mais novo, não o fixado");
		assert.strictEqual(latest.url, `https://www.tiktok.com/@perfil/video/${newest}`);
		const ageMs = Date.now() - new Date(latest.publishedAt).getTime();
		assert(ageMs > 0 && ageMs < 2 * 60 * 60 * 1000, "data derivada do ID");

		entries = [];
		assert.strictEqual(await monitor._checkTiktokLatestVideo("perfil"), null, "perfil sem vídeos");
	} finally {
		cachedModule.exports = originalExports;
	}
	console.log("  ✅ Teste 5 passou!\n");
}

function createManagementFixture(monitor) {
	const fakeBot = new FakeBot({ id: "test-bot" });
	fakeBot.streamMonitor = monitor;
	const Management = require("../commands/Management");
	const management = new Management();
	const group = new Group({
		id: `120363888_${RUN_ID}@g.us`,
		name: `grupo-teste-tiktok-${RUN_ID}`
	});
	const message = {
		group: group.id,
		author: "5511999999999@s.whatsapp.net",
		origin: { getQuotedMessage: async () => null }
	};
	return { fakeBot, management, group, message };
}

async function testManagementCommands(monitor) {
	console.log("Teste 6: Comandos do Management...");
	const { fakeBot, management, group, message } = createManagementFixture(monitor);
	const channel = `tt_cmd_${RUN_ID}`;

	const originalExists = monitor.tiktokChannelExists;
	monitor.tiktokChannelExists = async (name) => name !== "perfil_inexistente";

	try {
		const notFound = await management.toggleTiktokChannel(
			fakeBot,
			message,
			["perfil_inexistente"],
			group
		);
		assert(notFound.content.includes("não existe"), "rejeita perfil inexistente");
		assert.strictEqual(group.tiktok.length, 0);

		await management.toggleTiktokChannel(
			fakeBot,
			message,
			[`https://www.tiktok.com/@${channel}/live`],
			group
		);
		assert.strictEqual(group.tiktok.length, 1, "perfil adicionado em group.tiktok");
		const chConfig = group.tiktok[0];
		assert.strictEqual(chConfig.channel, channel);
		assert.strictEqual(chConfig.notifyVideos, true);
		assert.strictEqual(chConfig.notifyLives, true);
		assert(chConfig.videoConfig?.media?.[0]?.content.includes("TikTok"), "videoConfig padrão");
		assert(chConfig.onConfig?.media?.[0]?.content.includes("TikTok"), "onConfig padrão");
		assert(
			monitor.getSubscribedChannels().some((c) => c.name === channel && c.source === "tiktok"),
			"inscrito no StreamMonitor"
		);

		await management.toggleTiktokAI(fakeBot, message, [], group);
		assert.strictEqual(chConfig.useAI, true, "!g-tiktok-usarIA");
		await management.toggleTiktokThumbnail(fakeBot, message, [], group);
		assert.strictEqual(chConfig.useThumbnail, false, "!g-tiktok-usarThumbnail");

		for (const method of ["toggleYoutubeAI", "toggleYoutubeTitleChange"]) {
			assert.strictEqual(typeof management[method], "function", method);
		}
		for (const [cmd, entry] of Object.entries(management.commandMap)) {
			if (cmd.startsWith("tiktok-")) {
				assert.strictEqual(typeof management[entry.method], "function", `${cmd} sem método`);
			}
		}

		// Segundo !g-tiktok-canal com o mesmo perfil remove
		await management.toggleTiktokChannel(fakeBot, message, [channel], group);
		assert.strictEqual(group.tiktok.length, 0, "perfil removido");
		assert(
			!monitor.getSubscribedChannels().some((c) => c.name === channel && c.source === "tiktok"),
			"desinscrito do StreamMonitor"
		);
	} finally {
		monitor.tiktokChannelExists = originalExists;
		monitor.unsubscribe(channel, "tiktok");
	}
	console.log("  ✅ Teste 6 passou!\n");
}

async function testStreamSystemDispatch(monitor) {
	console.log("Teste 7: Despacho no StreamSystem...");
	const { fakeBot, group } = createManagementFixture(monitor);
	const channel = `tt_dispatch_${RUN_ID}`;
	group.tiktok = [
		{
			channel,
			notifyVideos: true,
			notifyLives: true,
			changeTitleOnEvent: false,
			useAI: false,
			useThumbnail: false,
			mentionAllMembers: false,
			videoConfig: { media: [{ type: "text", content: "TT_VIDEO: {title} {link}" }] },
			onConfig: { media: [{ type: "text", content: "TT_ON: {canal} {link}" }] },
			offConfig: { media: [{ type: "text", content: "TT_OFF: {canal}" }] }
		}
	];

	const streamSystem = StreamSystem.getInstance();
	const previousBots = streamSystem.bots;
	const originalGetGroups = streamSystem.database.getGroups;
	streamSystem.bots = [fakeBot];
	streamSystem.database.getGroups = async () => [group];

	try {
		fakeBot.resetCapture();
		await streamSystem.handleNewVideo({
			platform: "tiktok",
			channelName: channel,
			title: "Vídeo",
			url: `https://www.tiktok.com/@${channel}/video/1`,
			videoId: "1"
		});
		assert(fakeBot.capturedMessages[0]?.content.includes("TT_VIDEO"), "usa videoConfig");

		fakeBot.resetCapture();
		await streamSystem.handleStreamOnline({
			platform: "tiktok",
			channelName: channel,
			title: "Live",
			url: `https://www.tiktok.com/@${channel}/live`
		});
		assert(fakeBot.capturedMessages[0]?.content.includes("TT_ON"), "usa onConfig");
		assert(fakeBot.capturedMessages[0].content.includes("/live"), "link da live");

		fakeBot.resetCapture();
		await streamSystem.handleStreamOffline({ platform: "tiktok", channelName: channel });
		assert(fakeBot.capturedMessages[0]?.content.includes("TT_OFF"), "usa offConfig");

		group.tiktok[0].notifyLives = false;
		fakeBot.resetCapture();
		await streamSystem.handleStreamOnline({ platform: "tiktok", channelName: channel });
		assert.strictEqual(fakeBot.capturedMessages.length, 0, "notifyLives=false silencia lives");

		group.tiktok[0].notifyVideos = false;
		fakeBot.resetCapture();
		await streamSystem.handleNewVideo({ platform: "tiktok", channelName: channel, videoId: "2" });
		assert.strictEqual(fakeBot.capturedMessages.length, 0, "notifyVideos=false silencia vídeos");
	} finally {
		streamSystem.bots = previousBots;
		streamSystem.database.getGroups = originalGetGroups;
	}
	console.log("  ✅ Teste 7 passou!\n");
}

async function testRealNetwork(monitor) {
	const spec = process.env.TIKTOK_LIVE_TEST;
	if (!spec) {
		console.log("Teste 8: pulado (defina TIKTOK_LIVE_TEST=offline_user,online_user)\n");
		return;
	}
	const [offlineUser, onlineUser] = spec.split(",").map((u) => u.trim());
	console.log(`Teste 8: Rede real (offline=${offlineUser}, online=${onlineUser})...`);

	if (offlineUser) {
		const off = await monitor._checkTiktokLiveStatus(offlineUser);
		console.log(`  ${offlineUser}:`, JSON.stringify(off));
		assert.strictEqual(off.isLive, false, `${offlineUser} deveria estar offline`);
	}
	if (onlineUser) {
		const on = await monitor._checkTiktokLiveStatus(onlineUser);
		console.log(`  ${onlineUser}:`, JSON.stringify(on));
		assert.strictEqual(on.isLive, true, `${onlineUser} deveria estar ao vivo`);
		assert(on.roomId, "live real deve trazer roomId");
	}
	for (const user of [offlineUser, onlineUser].filter(Boolean)) {
		assert.strictEqual(await monitor.tiktokChannelExists(user), true, `${user} deve existir`);
		// yt-dlp depende de mudanças do TikTok: falha aqui é aviso, não quebra o teste
		try {
			const video = await monitor._checkTiktokLatestVideo(user);
			console.log(`  ${user} vídeo mais recente:`, JSON.stringify(video));
		} catch (error) {
			console.log(
				`  ⚠️ ${user} busca de vídeos via yt-dlp falhou: ${error.message.split("\n")[0]}`
			);
		}
	}
	console.log("  ✅ Teste 8 passou!\n");
}

async function runTests() {
	console.log("=== INICIANDO TESTE DO PIPELINE COMPLETO DO TIKTOK ===\n");

	const monitor = StreamMonitor.getInstance();
	if (!monitor.isReady && monitor.initPromise) {
		await monitor.initPromise;
	}

	await testSanitize(monitor);
	testParseRoomInfo(monitor);
	await testLivePolling(monitor);
	await testVideoPolling(monitor);
	await testLatestVideoSelection(monitor);
	await testManagementCommands(monitor);
	await testStreamSystemDispatch(monitor);
	await testRealNetwork(monitor);

	console.log("=== TODOS OS TESTES DO PIPELINE TIKTOK PASSARAM ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro nos testes:", err);
		process.exit(1);
	});
