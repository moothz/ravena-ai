process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const FakeBot = require("./FakeBot");
const CommandHandler = require("../CommandHandler");
const AdminUtils = require("../utils/AdminUtils");
const storageService = require("../services/StorageService");
const { createMessage } = require("./FakeMessage");
const assert = require("assert");

async function main() {
	console.log("=== TESTE DE INTEGRAÇÃO: COMANDOS CUSTOMIZADOS COM S3 STORAGE ===");

	const testGroupId = "120363999999999999@g.us";
	const bot = new FakeBot({ id: "teste-bot", grupoLogs: "123@g.us" });
	const handler = new CommandHandler();
	bot.eventHandler = { commandHandler: handler };

	// Garante permissão de admin para os testes
	AdminUtils.getInstance().isAdmin = async () => true;

	const group = {
		id: testGroupId,
		prefix: "!",
		name: "Grupo Teste S3"
	};

	// 1. Mensagem simulando resposta com imagem citada
	const fakeImageBase64 = Buffer.from("imagem_de_teste_png_simulada").toString("base64");
	const quotedMediaMsg = {
		hasMedia: true,
		type: "image",
		caption: "Legenda da mídia customizada",
		downloadMedia: async () => ({
			mimetype: "image/png",
			data: fakeImageBase64
		}),
		_data: { body: "" }
	};

	const addCmdMsg = createMessage({
		content: "!g-addCmd testezaps3",
		group: testGroupId,
		author: "5511999999999@s.whatsapp.net",
		authorName: "Admin Teste"
	});
	addCmdMsg.origin.getQuotedMessage = async () => quotedMediaMsg;
	addCmdMsg.origin.getChat = async () => ({ isGroup: true });

	console.log("1. Executando processManagementCommand para 'g-addCmd'...");
	const addCmdResult = await handler.processManagementCommand(
		bot,
		addCmdMsg,
		"g-addCmd",
		["testezaps3"],
		group
	);

	console.log("Resultado do addCmd:", addCmdResult?.content);
	assert.ok(
		addCmdResult && addCmdResult.content.includes("adicionado"),
		"Comando testezaps3 deveria ter sido adicionado com sucesso"
	);

	// 2. Verifica se a mídia foi gravada no S3 sob {groupId}/custom-commands/
	console.log("2. Verificando persistência no S3...");
	const groupUsage = await storageService.getGroupUsage(testGroupId);
	console.log(
		`✓ Uso do S3 para grupo ${testGroupId}: ${groupUsage.count} arquivo(s), ${groupUsage.bytes} bytes`
	);
	assert.ok(
		groupUsage.count >= 1,
		"A mídia do comando deve estar salva no S3 sob a pasta do grupo"
	);

	// 3. Executa o comando via processCustomCommandResponse
	console.log("3. Testando execução e recuperação do comando customizado...");
	// Obtém o comando criado no banco
	const customCommands = await handler.database.getCustomCommands(testGroupId);
	const createdCmd = customCommands.find((c) => c.startsWith === "testezaps3");
	assert.ok(createdCmd, "O comando criado deve estar presente no banco");

	console.log("Resposta armazenada no banco:", createdCmd.responses[0]);
	assert.ok(
		createdCmd.responses[0].startsWith("{image-"),
		"O banco SQLite deve manter o formato compatível {image-fileName}"
	);

	const execCmdMsg = createMessage({
		content: "!testezaps3",
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
	assert.strictEqual(returnMsg.content.isMessageMedia, true, "Deve ser MessageMedia");
	console.log("✓ Mídia recuperada do S3 e encapsulada com sucesso!");

	// 4. Limpeza no banco e no S3
	console.log("4. Limpando objetos de teste no S3 e banco...");
	await storageService.deleteGroup(testGroupId);
	const usageAfterClean = await storageService.getGroupUsage(testGroupId);
	assert.strictEqual(usageAfterClean.count, 0, "Objetos de teste devem ser limpos do S3");

	console.log("=== TESTE DE INTEGRAÇÃO PASSOU COM SUCESSO! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE DE INTEGRAÇÃO:", err);
		process.exit(1);
	});
