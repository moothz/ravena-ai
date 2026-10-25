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
	searchSessions
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

	// 1. Testa que a busca por keywords (!yt pudim) envia 1 única mensagem consolidada
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
	await downloadHandler(bot, msgYt, ["pudim"], null);

	const captured = bot.capturedMessages;
	console.log(`Mensagens capturadas para !yt pudim: ${captured.length}`);
	assert.ok(
		captured.length >= 2,
		"Deve ter capturado a mensagem consolidada + a entrega da opção 1"
	);

	const searchMsg = captured[0];
	assert.ok(
		searchMsg.content.includes('⏬ *rav-downloader* Buscando por _"pudim"_ no *YouTube* 🔍'),
		"Cabeçalho da mensagem consolidada deve corresponder ao padrão especificado"
	);
	assert.ok(searchMsg.content.includes("Encontrados:"), "Deve conter a seção 'Encontrados:'");
	assert.ok(
		searchMsg.content.includes("1. ["),
		"Deve listar os itens no formato '1. [Canal] Título'"
	);
	assert.ok(
		searchMsg.content.includes(
			"Baixando opção 1! Para outra opção, reaja à esta mensagem com os emojis de numeros ou com *!yt 2*"
		),
		"Rodapé deve instruir download da opção 1 e sugerir *!yt 2*"
	);
	assert.ok(baixarVideoChamadoCom, "Opção 1 deve ter sido baixada automaticamente");
	console.log(
		"✓ Teste 1 passou: Busca consolidada em mensagem única com 9 itens e download automático da opção 1"
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
		msg2Formatted.content.includes("s3-ravena.moothz.win"),
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
	baixarVideoChamadoCom = null;
	await downloadHandler(bot, msgOptionCmd, ["2"], null);
	assert.ok(baixarVideoChamadoCom, "Deve disparar download para opção 2");
	assert.strictEqual(baixarVideoChamadoCom.idVideo, "id2", "ID baixado deve ser 'id2'");
	console.log("✓ Teste 4 passou: Seleção de opção via !yt 2 processada para item 'id2'");

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
	console.log("✓ Teste 5 passou: Reação 2️⃣ tratada com sucesso e confirmada com ⌛️");

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
