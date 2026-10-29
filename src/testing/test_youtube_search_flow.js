process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const YoutubeDownloader = require("../functions/YoutubeDownloader");
const SocialMediaDownloader = require("../functions/SocialMediaDownloader");
const {
	downloadHandler,
	saveSearchSession,
	getSearchSession,
	processYoutubeSearchReaction,
	searchSessions,
	parseDurationToSeconds,
	selectDefaultVideoIndex,
	buildSearchListText
} = SocialMediaDownloader;

async function runTests() {
	console.log("=== Iniciando Testes de Busca Interativa do YouTube e Entrega de Mídias ===");

	const bot = new FakeBot({ id: "teste", prefix: "!" });

	// Prepara arquivo simulado de download
	const dlFolder = process.env.DL_FOLDER || "/app/downloads";
	if (!fs.existsSync(dlFolder)) fs.mkdirSync(dlFolder, { recursive: true });
	const fakeMediaFile = path.join(dlFolder, "fake_sample_yt.mp4");
	fs.writeFileSync(fakeMediaFile, "fake video content for testing");

	// Stub dos métodos de download para teste rápido e determinístico
	let baixarVideoChamadoCom = null;
	let baixarMusicaChamadoCom = null;

	YoutubeDownloader.baixarVideoYoutube = (idVideo, dadosSolicitante, videoHD, callback) => {
		baixarVideoChamadoCom = { idVideo, dadosSolicitante, videoHD };
		callback(null, {
			legenda: `[Canal Teste] Titulo Video ${idVideo}`,
			arquivo: fakeMediaFile
		});
	};

	YoutubeDownloader.baixarMusicaYoutube = (idVideo, dadosSolicitante, callback) => {
		baixarMusicaChamadoCom = { idVideo, dadosSolicitante };
		callback(null, {
			legenda: `[Canal Teste] In The End - Linkin Park`,
			arquivo: fakeMediaFile
		});
	};

	// 0. Testes unitários de duração e seleção padrão de vídeo (sempre opção 1)
	console.log("[Teste 0] Duração e seleção padrão de vídeo...");
	assert.strictEqual(parseDurationToSeconds("3:38"), 218);
	assert.strictEqual(parseDurationToSeconds("1:05:10"), 3910);
	assert.strictEqual(parseDurationToSeconds("45"), 45);

	const itemsWithUnder5 = [
		{ duration: "2:00" },
		{ duration: "4:50" },
		{ duration: "1:30" },
		{ duration: "8:00" }
	];
	assert.strictEqual(
		selectDefaultVideoIndex(itemsWithUnder5),
		0,
		"Deve sempre selecionar o primeiro vídeo da lista (opção 1, índice 0)"
	);

	const itemsAllOver5 = [{ duration: "12:00" }, { duration: "6:15" }, { duration: "18:30" }];
	assert.strictEqual(
		selectDefaultVideoIndex(itemsAllOver5),
		0,
		"Deve sempre selecionar o primeiro vídeo da lista (opção 1, índice 0)"
	);
	console.log("✓ Teste 0 passou: parseDurationToSeconds e selectDefaultVideoIndex validados");

	// 1. Testa que a busca por keywords (!yt pudim) envia 1 única mensagem consolidada com seleção inteligente
	console.log("[Teste 1] Busca por palavra-chave (!yt pudim)...");
	const msgYt = createMessage({
		content: "!yt pudim",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		origin: {
			body: "!yt pudim",
			getQuotedMessage: async () => null,
			react: async () => {}
		}
	});

	bot.resetCapture();
	bot.editedMessages = [];
	await downloadHandler(bot, msgYt, ["pudim"], null);

	const captured = bot.capturedMessages;
	console.log(`Mensagens capturadas para !yt pudim: ${captured.length}`);
	assert.ok(
		captured.length >= 2,
		"Deve ter capturado a mensagem consolidada + a entrega da opção selecionada"
	);

	const searchMsg = captured[0];
	assert.ok(
		searchMsg.content.includes('⏬ *rav-downloader* Buscando por _"pudim"_ no *YouTube* 🔍'),
		"Cabeçalho da mensagem consolidada deve corresponder ao padrão especificado"
	);
	assert.ok(searchMsg.content.includes("Encontrados:"), "Deve conter a seção 'Encontrados:'");
	assert.ok(
		searchMsg.content.includes("⏳ *1."),
		"Opção 1 deve ser selecionada inicialmente com ⏳ e em negrito"
	);
	assert.ok(
		searchMsg.content.includes("Baixando opção 1!"),
		"Rodapé deve instruir download da opção 1"
	);
	assert.ok(searchMsg.content.includes("*!yt 2*"), "Rodapé deve sugerir *!yt 2*");
	assert.ok(baixarVideoChamadoCom, "Opção selecionada deve ter sido baixada automaticamente");
	assert.ok(
		bot.editedMessages.length >= 1,
		"Mensagem da lista deve ter sido editada após conclusão do download"
	);
	const lastEditMsg = bot.editedMessages[bot.editedMessages.length - 1];
	assert.ok(
		lastEditMsg.text.includes("✅ *1."),
		"Mensagem editada deve conter ✅ e negrito na opção 1 concluída"
	);
	console.log(
		"✓ Teste 1 passou: Busca consolidada sempre na opção 1 por padrão, com ⏳ inicial e edição com ✅ após download"
	);

	// 2. Testa sugestão dinâmica de comando para !musica
	console.log("[Teste 2] Sugestão dinâmica de comando (!musica pudim)...");
	const msgMusica = createMessage({
		content: "!musica pudim",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		origin: {
			body: "!musica pudim",
			getQuotedMessage: async () => null,
			react: async () => {}
		}
	});

	bot.resetCapture();
	await downloadHandler(bot, msgMusica, ["pudim"], null);

	const searchMsgMusica = bot.capturedMessages[0];
	assert.ok(
		searchMsgMusica.content.includes("*!musica 2*"),
		`Rodapé para comando !musica deve sugerir *!musica 2*, recebido: ${searchMsgMusica.content}`
	);
	assert.ok(baixarMusicaChamadoCom, "Comando !musica deve baixar como áudio");
	console.log("✓ Teste 2 passou: Sugestão dinâmica correta para !musica 2 e acionamento de áudio");

	// 3. Testa que para áudio são enviadas 2 mensagens (áudio + segunda mensagem com link e letra)
	console.log("[Teste 3] Entrega de áudio com segunda mensagem formatada contendo link S3...");
	// Para !musica pudim no teste anterior:
	// capturedMessages[0] = lista de busca
	// capturedMessages[1] = mídia de áudio
	// capturedMessages[2] = segunda mensagem formatada com link e letra
	const capturedMusica = bot.capturedMessages;
	assert.ok(
		capturedMusica.length >= 3,
		"Para áudio deve enviar lista + áudio + mensagem formatada"
	);
	const msg2Formatted = capturedMusica[2];
	assert.ok(
		msg2Formatted.content.includes("✅ *Download Concluído!*"),
		"Segunda mensagem deve conter cabeçalho de conclusão"
	);
	assert.ok(
		msg2Formatted.content.includes("moothz.win") || msg2Formatted.content.includes("Link direto"),
		"Segunda mensagem deve conter link do S3"
	);
	console.log(
		"✓ Teste 3 passou: Áudio entrega áudio + segunda mensagem com link e suporte a letra"
	);

	// 4. Testa seleção de opção via comando numérico (!yt 2)
	console.log("[Teste 4] Troca de opção via comando numérico (!yt 2)...");
	const fakeSessionId = "fake_msg_session_1";
	const fakeItems = [
		{
			id: "id1",
			title: "Pudim 1",
			channelTitle: "Canal 1",
			duration: "3:00",
			url: "https://youtu.be/id1"
		},
		{
			id: "id2",
			title: "Pudim 2",
			channelTitle: "Canal 2",
			duration: "4:00",
			url: "https://youtu.be/id2"
		}
	];
	saveSearchSession(fakeSessionId, "123456@g.us", {
		query: "pudim",
		commandName: "yt",
		isAudioOnly: false,
		wantLyrics: false,
		author: "5511999999999@s.whatsapp.net",
		chatId: "123456@g.us",
		botMsgId: fakeSessionId,
		items: fakeItems
	});

	let reactedEmoji = null;
	const msgOptionCmd = createMessage({
		content: "!yt 2",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		origin: {
			body: "!yt 2",
			getQuotedMessage: async () => ({ id: fakeSessionId }),
			react: async (e) => {
				reactedEmoji = e;
			}
		}
	});

	bot.resetCapture();
	bot.editedMessages = [];
	baixarVideoChamadoCom = null;
	await downloadHandler(bot, msgOptionCmd, ["2"], null);
	assert.ok(baixarVideoChamadoCom, "Deve disparar download para opção 2");
	assert.strictEqual(baixarVideoChamadoCom.idVideo, "id2", "ID baixado deve ser 'id2'");
	assert.ok(
		bot.editedMessages.some((m) => m.text.includes("✅ *2.")),
		"Deve editar mensagem com ✅ *2. ao concluir download via comando"
	);
	console.log("✓ Teste 4 passou: Seleção de opção via !yt 2 processada e editada para item 'id2'");

	// 5. Testa seleção via reação numérica (2️⃣)
	console.log("[Teste 5] Troca de opção via reação numérica (2️⃣)...");
	let reactionHandledAck = null;
	const reactionMessage = {
		originReaction: {
			reaction: "2️⃣",
			msgId: fakeSessionId
		},
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		origin: {
			react: async (e) => {
				reactionHandledAck = e;
			}
		}
	};

	bot.resetCapture();
	bot.editedMessages = [];
	baixarVideoChamadoCom = null;
	const reactionResult = await processYoutubeSearchReaction(bot, reactionMessage, [], null);
	assert.strictEqual(reactionResult, true, "Reação 2️⃣ deve ser reconhecida e tratada");
	const expectedEmoji = process.env.LOADING_EMOJI ?? "⌛️";
	assert.strictEqual(
		reactionHandledAck,
		expectedEmoji,
		`Reação deve ser respondida com ${expectedEmoji}`
	);
	assert.ok(baixarVideoChamadoCom, "Reação deve disparar download do vídeo");
	assert.strictEqual(baixarVideoChamadoCom.idVideo, "id2", "ID baixado pela reação deve ser 'id2'");
	assert.ok(
		bot.editedMessages.some((m) => m.text.includes("⏳ *2.")),
		"Deve editar mensagem com ⏳ *2. ao iniciar reação"
	);
	assert.ok(
		bot.editedMessages.some((m) => m.text.includes("✅ *2.")),
		"Deve editar mensagem com ✅ *2. ao concluir download da reação"
	);
	console.log(
		"✓ Teste 5 passou: Reação 2️⃣ tratada com sucesso, confirmada com ⌛️ e editada com ⏳ e ✅"
	);

	// 6. Testa flag -hd e formato mínimo 720p
	console.log("[Teste 6] Flag -hd...");
	const msgHd = createMessage({
		content: "!yt 2 -hd",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		origin: {
			body: "!yt 2 -hd",
			getQuotedMessage: async () => ({ id: fakeSessionId }),
			react: async () => {}
		}
	});
	baixarVideoChamadoCom = null;
	await downloadHandler(bot, msgHd, ["2", "-hd"], null);
	assert.ok(baixarVideoChamadoCom, "Deve disparar download");
	assert.strictEqual(
		baixarVideoChamadoCom.videoHD,
		true,
		"videoHD deve ser true quando -hd especificado"
	);
	console.log("✓ Teste 6 passou: Opção -hd repassada com sucesso para o downloader");

	// 7. Testa seleção da opção 10 via comando numérico (!yt 10) e lista de até 10 itens
	console.log("[Teste 7] Troca de opção via comando numérico (!yt 10) com lista de 10 itens...");
	const fakeSessionId10 = "fake_msg_session_10";
	const fakeItems10 = Array.from({ length: 10 }, (_, i) => ({
		id: `id${i + 1}`,
		title: `Video ${i + 1}`,
		channelTitle: `Canal ${i + 1}`,
		duration: `${i + 1}:00`,
		url: `https://youtu.be/id${i + 1}`
	}));

	saveSearchSession(fakeSessionId10, "123456@g.us", {
		query: "musica teste",
		commandName: "yt",
		isAudioOnly: false,
		wantLyrics: false,
		author: "5511999999999@s.whatsapp.net",
		chatId: "123456@g.us",
		botMsgId: fakeSessionId10,
		items: fakeItems10
	});

	const msgOption10 = createMessage({
		content: "!yt 10",
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		origin: {
			body: "!yt 10",
			getQuotedMessage: async () => ({ id: fakeSessionId10 }),
			react: async () => {}
		}
	});

	bot.resetCapture();
	bot.editedMessages = [];
	baixarVideoChamadoCom = null;
	await downloadHandler(bot, msgOption10, ["10"], null);
	assert.ok(baixarVideoChamadoCom, "Deve disparar download para opção 10");
	assert.strictEqual(baixarVideoChamadoCom.idVideo, "id10", "ID baixado deve ser 'id10'");
	assert.ok(
		bot.editedMessages.some((m) => m.text.includes("✅ *10.")),
		"Deve editar mensagem com ✅ *10. ao concluir download via !yt 10"
	);
	console.log(
		"✓ Teste 7 passou: Seleção de opção via !yt 10 processada e editada para item 'id10'"
	);

	// 8. Testa seleção da opção 10 via reação numérica com emoji 🔟
	console.log("[Teste 8] Troca de opção via reação com emoji 🔟...");
	let reaction10HandledAck = null;
	const reaction10Message = {
		originReaction: {
			reaction: "🔟",
			msgId: fakeSessionId10
		},
		group: "123456@g.us",
		author: "5511999999999@s.whatsapp.net",
		origin: {
			react: async (e) => {
				reaction10HandledAck = e;
			}
		}
	};

	bot.resetCapture();
	bot.editedMessages = [];
	baixarVideoChamadoCom = null;
	const reaction10Result = await processYoutubeSearchReaction(bot, reaction10Message, [], null);
	assert.strictEqual(reaction10Result, true, "Reação 🔟 deve ser reconhecida e tratada");
	assert.strictEqual(
		reaction10HandledAck,
		expectedEmoji,
		`Reação 🔟 deve ser respondida com ${expectedEmoji}`
	);
	assert.ok(baixarVideoChamadoCom, "Reação 🔟 deve disparar download do vídeo");
	assert.strictEqual(
		baixarVideoChamadoCom.idVideo,
		"id10",
		"ID baixado pela reação 🔟 deve ser 'id10'"
	);
	assert.ok(
		bot.editedMessages.some((m) => m.text.includes("⏳ *10.")),
		"Deve editar mensagem com ⏳ *10. ao iniciar reação 🔟"
	);
	assert.ok(
		bot.editedMessages.some((m) => m.text.includes("✅ *10.")),
		"Deve editar mensagem com ✅ *10. ao concluir download da reação 🔟"
	);
	console.log(
		"✓ Teste 8 passou: Reação 🔟 tratada com sucesso, confirmada com ⌛️ e editada com ⏳ e ✅ para o item 10"
	);

	// Limpeza do arquivo simulado
	if (fs.existsSync(fakeMediaFile)) fs.unlinkSync(fakeMediaFile);

	console.log("=== Todos os testes do fluxo do YouTube passaram com sucesso! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
