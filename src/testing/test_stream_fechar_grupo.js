process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const Management = require("../commands/Management");
const StreamSystem = require("../StreamSystem");
const { createMessage } = require("./FakeMessage");

async function main() {
	console.log("=== INICIANDO TESTES: Fechar Grupo em Lives (StreamSystem & Management) ===");

	const testGroupId = "120363000000000099@g.us";
	const bot = new FakeBot({
		id: "bot-stream-test",
		phoneNumber: "5511999990099",
		grupoLogs: "120363000000000002@g.us"
	});
	bot.isParticipating = () => true;

	const management = new Management();
	const streamSystem = StreamSystem.getInstance();
	streamSystem.registerBot(bot);

	const groupsMap = {};
	streamSystem.database.getGroup = async (id) => groupsMap[id] || null;
	streamSystem.database.saveGroup = async (g) => {
		groupsMap[g.id] = g;
		return g;
	};
	management.database.getGroup = async (id) => groupsMap[id] || null;
	management.database.saveGroup = async (g) => {
		groupsMap[g.id] = g;
		return g;
	};

	const groupData = {
		id: testGroupId,
		name: "Grupo Teste Fechar Live",
		titulo: "Grupo Teste Fechar Live",
		prefix: "!",
		twitch: [
			{
				channel: "streamer_twitch",
				closeGroupOnLive: false,
				closeGroupDuration: null,
				onConfig: { media: [] },
				offConfig: { media: [] }
			}
		],
		kick: [
			{
				channel: "streamer_kick",
				closeGroupOnLive: false,
				closeGroupDuration: null,
				onConfig: { media: [] },
				offConfig: { media: [] }
			}
		],
		youtube: [
			{
				channel: "canal_yt",
				notifyLives: true,
				closeGroupOnLive: false,
				closeGroupDuration: null,
				onConfig: { media: [] },
				offConfig: { media: [] }
			}
		],
		tiktok: [
			{
				channel: "perfil_tiktok",
				notifyLives: true,
				closeGroupOnLive: false,
				closeGroupDuration: null,
				onConfig: { media: [] },
				offConfig: { media: [] }
			}
		]
	};

	groupsMap[testGroupId] = groupData;
	await bot.database.saveGroup(groupData);

	// -------------------------------------------------------------
	// Teste 1: Comandos de fecharGrupo no Management.js
	// -------------------------------------------------------------
	console.log("\n1. Testando comandos !g-xxxx-fecharGrupo no Management.js...");

	const fakeAuthor = "5511999991111@s.whatsapp.net";

	// 1.1 Twitch: toggle simples (liga)
	let msg = createMessage({
		content: "!g-twitch-fecharGrupo streamer_twitch",
		group: testGroupId,
		author: fakeAuthor
	});
	let res = await management.toggleTwitchCloseGroup(bot, msg, ["streamer_twitch"], groupData);
	assert.ok(res && res.content.includes("ativado"), "Deveria ativar fecharGrupo na Twitch");
	assert.strictEqual(groupData.twitch[0].closeGroupOnLive, true);
	assert.strictEqual(groupData.twitch[0].closeGroupDuration, null);

	// 1.2 Twitch: toggle simples (desliga)
	res = await management.toggleTwitchCloseGroup(bot, msg, ["streamer_twitch"], groupData);
	assert.ok(res && res.content.includes("desativado"), "Deveria desativar fecharGrupo na Twitch");
	assert.strictEqual(groupData.twitch[0].closeGroupOnLive, false);

	// 1.3 Twitch: ativa com tempo (30 minutos)
	msg = createMessage({
		content: "!g-twitch-fecharGrupo 30 streamer_twitch",
		group: testGroupId,
		author: fakeAuthor
	});
	res = await management.toggleTwitchCloseGroup(bot, msg, ["30", "streamer_twitch"], groupData);
	assert.ok(
		res && res.content.includes("ativado") && res.content.includes("30 minutos"),
		"Deveria ativar com 30m"
	);
	assert.strictEqual(groupData.twitch[0].closeGroupOnLive, true);
	assert.strictEqual(groupData.twitch[0].closeGroupDuration, 30);

	// 1.4 Twitch: desativa com "off" ou "0"
	msg = createMessage({
		content: "!g-twitch-fecharGrupo off streamer_twitch",
		group: testGroupId,
		author: fakeAuthor
	});
	res = await management.toggleTwitchCloseGroup(bot, msg, ["off", "streamer_twitch"], groupData);
	assert.ok(res && res.content.includes("desativado"), "Deveria desativar com 'off'");
	assert.strictEqual(groupData.twitch[0].closeGroupOnLive, false);
	assert.strictEqual(groupData.twitch[0].closeGroupDuration, null);

	// 1.5 Kick: ativa com tempo invertido [canal] [tempo]
	msg = createMessage({
		content: "!g-kick-fecharGrupo streamer_kick 45",
		group: testGroupId,
		author: fakeAuthor
	});
	res = await management.toggleKickCloseGroup(bot, msg, ["streamer_kick", "45"], groupData);
	assert.ok(
		res && res.content.includes("ativado") && res.content.includes("45 minutos"),
		"Deveria ativar Kick com 45m"
	);
	assert.strictEqual(groupData.kick[0].closeGroupOnLive, true);
	assert.strictEqual(groupData.kick[0].closeGroupDuration, 45);

	// 1.6 YouTube: ativa apenas com tempo (seleciona único canal existente)
	msg = createMessage({
		content: "!g-youtube-fecharGrupo 60",
		group: testGroupId,
		author: fakeAuthor
	});
	res = await management.toggleYoutubeCloseGroup(bot, msg, ["60"], groupData);
	assert.ok(
		res && res.content.includes("ativado") && res.content.includes("60 minutos"),
		"Deveria ativar YouTube com 60m"
	);
	assert.strictEqual(groupData.youtube[0].closeGroupOnLive, true);
	assert.strictEqual(groupData.youtube[0].closeGroupDuration, 60);

	// 1.7 TikTok: toggle simples
	msg = createMessage({
		content: "!g-tiktok-fecharGrupo perfil_tiktok",
		group: testGroupId,
		author: fakeAuthor
	});
	res = await management.toggleTiktokCloseGroup(bot, msg, ["perfil_tiktok"], groupData);
	assert.ok(res && res.content.includes("ativado"), "Deveria ativar TikTok");
	assert.strictEqual(groupData.tiktok[0].closeGroupOnLive, true);

	console.log("✓ Todos os comandos de fecharGrupo no Management funcionaram com sucesso.");

	// -------------------------------------------------------------
	// Teste 2: Eventos de Live Online e Offline no StreamSystem
	// -------------------------------------------------------------
	console.log("\n2. Testando eventos de Live Online e Offline no StreamSystem...");

	bot.resetCapture();
	groupData.twitch[0].closeGroupOnLive = true;
	groupData.twitch[0].closeGroupDuration = null;
	await bot.database.saveGroup(groupData);

	// 2.1 Live Online -> Fecha o grupo (setMessagesAdminsOnly(true))
	await streamSystem.processStreamEvent(
		groupData,
		groupData.twitch[0],
		{ platform: "twitch", channelName: "streamer_twitch", title: "Live Teste" },
		"online"
	);

	assert.strictEqual(
		bot.capturedMessagesAdminsOnly.length,
		1,
		"Deveria ter chamado setMessagesAdminsOnly uma vez"
	);
	assert.strictEqual(bot.capturedMessagesAdminsOnly[0].chatId, testGroupId);
	assert.strictEqual(
		bot.capturedMessagesAdminsOnly[0].adminOnly,
		true,
		"Grupo deve ser fechado (adminOnly: true)"
	);
	console.log("✓ Live Online fechou o grupo com sucesso.");

	// 2.2 Live Offline -> Abre o grupo (setMessagesAdminsOnly(false))
	bot.resetCapture();
	await streamSystem.processStreamEvent(
		groupData,
		groupData.twitch[0],
		{ platform: "twitch", channelName: "streamer_twitch" },
		"offline"
	);

	assert.strictEqual(
		bot.capturedMessagesAdminsOnly.length,
		1,
		"Deveria ter chamado setMessagesAdminsOnly no offline"
	);
	assert.strictEqual(
		bot.capturedMessagesAdminsOnly[0].adminOnly,
		false,
		"Grupo deve ser reaberto (adminOnly: false)"
	);
	console.log("✓ Live Offline reabriu o grupo com sucesso.");

	// -------------------------------------------------------------
	// Teste 3: Live com tempo configurado (reabertura programada)
	// -------------------------------------------------------------
	console.log("\n3. Testando fechamento com tempo configurado...");

	bot.resetCapture();
	// Testamos closeGroupForStream diretamente para verificar o setTimeout
	// Sobrescrevemos temporariamente o setTimeout ou testamos com duração
	const origSetTimeout = global.setTimeout;
	let timerCallback = null;
	global.setTimeout = (cb, ms) => {
		timerCallback = cb;
		return { unref: () => {} };
	};

	try {
		await streamSystem.closeGroupForStream(testGroupId, "twitch", "streamer_twitch", 15);
		assert.strictEqual(bot.capturedMessagesAdminsOnly.length, 1);
		assert.strictEqual(bot.capturedMessagesAdminsOnly[0].adminOnly, true);
		assert.ok(timerCallback, "Callback do timer deveria ter sido registrado");

		bot.resetCapture();
		// Dispara o callback do timer simulando o fim do tempo
		await timerCallback();
		assert.strictEqual(bot.capturedMessagesAdminsOnly.length, 1);
		assert.strictEqual(
			bot.capturedMessagesAdminsOnly[0].adminOnly,
			false,
			"Timer deve reabrir o grupo"
		);
		console.log("✓ Timer de fechamento temporário reabriu o grupo corretamente.");
	} finally {
		global.setTimeout = origSetTimeout;
	}

	// -------------------------------------------------------------
	// Teste 4: Concorrência de múltiplas streams no mesmo grupo
	// -------------------------------------------------------------
	console.log("\n4. Testando concorrência de múltiplas streams com fecharGrupo...");

	// Adicionamos segundo canal Twitch no grupo
	groupData.twitch.push({
		channel: "segundo_streamer",
		closeGroupOnLive: true,
		closeGroupDuration: null,
		onConfig: { media: [] },
		offConfig: { media: [] }
	});
	await bot.database.saveGroup(groupData);

	// Mock do StreamMonitor no streamSystem
	streamSystem.streamMonitor = {
		getStreamStatus: () => ({
			"twitch:streamer_twitch": { isLive: false },
			"twitch:segundo_streamer": { isLive: true } // Segundo streamer continua ao vivo!
		})
	};

	bot.resetCapture();
	// Primeiro streamer fica offline
	await streamSystem.openGroupForStream(testGroupId, "twitch", "streamer_twitch");

	// Como "segundo_streamer" continua ao vivo com closeGroupOnLive, o grupo NÃO pode ser reaberto!
	assert.strictEqual(
		bot.capturedMessagesAdminsOnly.length,
		0,
		"Grupo NÃO deve reabrir enquanto o segundo streamer estiver ao vivo"
	);
	console.log("✓ Grupo permaneceu fechado pois outro streamer ainda está ao vivo.");

	// Agora o segundo streamer também encerra a live
	streamSystem.streamMonitor.getStreamStatus = () => ({
		"twitch:streamer_twitch": { isLive: false },
		"twitch:segundo_streamer": { isLive: false }
	});

	await streamSystem.openGroupForStream(testGroupId, "twitch", "segundo_streamer");
	assert.strictEqual(bot.capturedMessagesAdminsOnly.length, 1);
	assert.strictEqual(
		bot.capturedMessagesAdminsOnly[0].adminOnly,
		false,
		"Grupo agora deve reabrir"
	);
	console.log("✓ Grupo reaberto com sucesso após o encerramento do último streamer ao vivo.");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
