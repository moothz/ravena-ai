process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.S3_ENABLED = "false";

const FakeBot = require("./FakeBot");
const CommandHandler = require("../CommandHandler");
const AdminUtils = require("../utils/AdminUtils");
const storageService = require("../services/StorageService");
const { createMessage } = require("./FakeMessage");
const assert = require("assert");
const fs = require("fs");
const sharp = require("sharp");

async function main() {
	console.log("=== TESTE: COMANDOS PERSONALIZADOS COM STICKER + ÁUDIO ===");

	const testGroupId = "120363999999999998@g.us";
	// Escrita de DB é realmente necessária aqui (testMode bloqueia saveCustomCommand)
	// e os dados ficam em tmpfs do container isolado (nunca em produção).
	const bot = new FakeBot({ id: "teste-bot", testMode: false });
	const handler = new CommandHandler();
	bot.eventHandler = { commandHandler: handler };

	// Mantém arquivos locais de mídia em tmpfs (não toca em data/media do repositório)
	const testMediaDir = "/tmp/sticker-audio-test-media";
	storageService.localMediaDir = testMediaDir;

	// Garante permissão de admin para os testes
	AdminUtils.getInstance().isAdmin = async () => true;

	const group = {
		id: testGroupId,
		prefix: "!",
		name: "Grupo Teste Sticker Audio"
	};

	// 1. Sticker com áudio embutido citado no comando !g-addCmd
	console.log("1. Criando comando personalizado com sticker + áudio embutido...");
	const stickerAudioB64 = Buffer.from("fake-ogg-audio-data").toString("base64");
	const webpB64 = (
		await sharp({
			create: {
				width: 64,
				height: 64,
				channels: 4,
				background: { r: 200, g: 40, b: 80, alpha: 1 }
			}
		})
			.webp({ lossless: false })
			.toBuffer()
	).toString("base64");

	const quotedStickerMsg = {
		hasMedia: true,
		type: "sticker",
		caption: "Meu sticker com som",
		content: {
			audioMessage: {
				mimetype: "audio/ogg; codecs=opus",
				directPath: "/fake/sticker-audio"
			}
		},
		downloadMedia: async () => ({
			mimetype: "image/webp",
			data: webpB64
		}),
		downloadStickerAudio: async () => ({
			mimetype: "audio/ogg; codecs=opus",
			data: stickerAudioB64,
			filename: "sticker-audio.ogg",
			isMessageMedia: true
		}),
		_data: { body: "" }
	};

	const addCmdMsg = createMessage({
		content: "!g-addCmd meu-sticker-som",
		group: testGroupId,
		author: "5511999999999@s.whatsapp.net",
		authorName: "Admin Teste"
	});
	addCmdMsg.origin.getQuotedMessage = async () => quotedStickerMsg;
	addCmdMsg.origin.getChat = async () => ({ isGroup: true });

	const addCmdResult = await handler.processManagementCommand(
		bot,
		addCmdMsg,
		"g-addCmd",
		["meu-sticker-som"],
		group
	);

	console.log("Resultado do addCmd:", addCmdResult?.content);
	assert.ok(
		addCmdResult && addCmdResult.content.includes("adicionado"),
		"Comando meu-sticker-som deveria ter sido adicionado com sucesso"
	);

	// 2. Verifica se o comando foi salvo com a resposta no formato {stickeraudio-sticker:audio}
	console.log("2. Verificando formato da resposta salva...");
	const customCommands = await handler.database.getCustomCommands(testGroupId);
	const createdCmd = customCommands.find((c) => c.startsWith === "meu-sticker-som");
	assert.ok(createdCmd, "O comando criado deve estar presente no banco");
	console.log("Resposta salva no banco:", createdCmd.responses[0]);
	assert.ok(
		createdCmd.responses[0].startsWith("{stickeraudio-"),
		"O banco deve manter o formato {stickeraudio-sticker:audio}"
	);

	// 3. Executa o comando e verifica a ReturnMessage
	console.log("3. Executando comando com sticker + áudio...");
	const execCmdMsg = createMessage({
		content: "!meu-sticker-som",
		group: testGroupId,
		author: "5511999999999@s.whatsapp.net",
		authorName: "Membro Teste"
	});

	const returnMsg = await handler.processCustomCommandResponse(
		bot,
		execCmdMsg,
		createdCmd.responses[0],
		createdCmd,
		group,
		[]
	);

	assert.ok(returnMsg, "Deveria ter retornado uma ReturnMessage");
	assert.ok(
		returnMsg.content && typeof returnMsg.content === "object",
		"O retorno deve conter objeto de mídia"
	);
	assert.ok(returnMsg.content.isMessageMedia, "Deve ser MessageMedia");
	assert.strictEqual(returnMsg.options.sendMediaAsSticker, true, "Deve ser um sticker");
	assert.ok(returnMsg.options.stickerAudio, "stickerAudio deve estar preenchido");
	assert.strictEqual(returnMsg.options.stickerAudio.mimetype, "audio/ogg; codecs=opus");
	assert.strictEqual(
		Buffer.from(returnMsg.options.stickerAudio.data, "base64").toString("utf8"),
		"fake-ogg-audio-data",
		"StickerAudio deve conter o áudio original"
	);
	console.log("✓ Sticker com áudio retornado corretamente com áudio embutido");

	// 4. Limpeza (banco em tmpfs; arquivos de mídia em /tmp do container)
	console.log("4. Limpando objeto de teste...");
	await handler.database.deleteCustomCommand(testGroupId, "meu-sticker-som");
	try {
		fs.rmSync(testMediaDir, { recursive: true, force: true });
	} catch {}

	console.log("=== TESTE DE COMANDO PERSONALIZADO COM STICKER + ÁUDIO PASSOU! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
