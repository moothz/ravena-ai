const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const NSFWPredict = require("../utils/NSFWPredict");
const SummaryCommands = require("../functions/SummaryCommands");
const LLMService = require("../services/LLMService");
const Status = require("../utils/Status");

async function runTests() {
	console.log("=== Testando Integração SummaryCommands com NSFWPredict ===");

	const nsfwPredict = NSFWPredict.getInstance();
	const eventHandler = new EventHandler();
	const bot = new FakeBot({ id: "bot-test", dossieGroups: "dossie@g.us" });
	bot.eventHandler = eventHandler;

	// Mock do status para LLM estar online
	const originalGetServicesStatus = Status.getServicesStatus;
	Status.getServicesStatus = async () => ({ llm: "up", nudenet: "up" });

	try {
		// -----------------------------------------------------------------------
		// 1. handleExternalDetection: Grupo COM filtro NSFW ativo -> deve deletar
		// -----------------------------------------------------------------------
		console.log("\n1. Testando handleExternalDetection com grupo que filtra NSFW...");
		let msgDeleted = false;
		const msgGroupNsfw = createMessage({
			type: "image",
			group: "grupo-com-filtro@g.us",
			author: "5511999990001@s.whatsapp.net",
			name: "Usuario1"
		});
		msgGroupNsfw.origin.delete = async (forEveryone) => {
			if (forEveryone) msgDeleted = true;
		};

		const groupComFiltro = {
			id: "grupo-com-filtro@g.us",
			name: "Grupo Seguro",
			filters: { nsfw: true }
		};

		const result1 = await nsfwPredict.handleExternalDetection(bot, msgGroupNsfw, {
			isNSFW: true,
			type: "anime",
			description: "Ilustração explícita",
			source: "SummaryCommands:VisionAI:Image",
			group: groupComFiltro
		});

		assert.strictEqual(result1.handled, true, "Deveria ser tratado");
		assert.strictEqual(result1.deleted, true, "Deveria marcar como deletado");
		assert.strictEqual(msgDeleted, true, "Deveria ter chamado message.origin.delete(true)");
		console.log("✓ Mensagem NSFW deletada com sucesso em grupo com filtro ativo");

		// -----------------------------------------------------------------------
		// 2. handleExternalDetection: Mídia SFW -> não deve deletar
		// -----------------------------------------------------------------------
		console.log("\n2. Testando handleExternalDetection com mídia SFW...");
		let sfwMsgDeleted = false;
		const msgGroupSfw = createMessage({
			type: "image",
			group: "grupo-com-filtro@g.us",
			author: "5511999990001@s.whatsapp.net"
		});
		msgGroupSfw.origin.delete = async () => {
			sfwMsgDeleted = true;
		};

		const result2 = await nsfwPredict.handleExternalDetection(bot, msgGroupSfw, {
			isNSFW: false,
			type: "vida-real",
			description: "Foto de paisagem natural",
			group: groupComFiltro
		});

		assert.strictEqual(result2.handled, false, "Não deveria tratar mídia SFW");
		assert.strictEqual(result2.deleted, false, "Não deveria deletar mídia SFW");
		assert.strictEqual(sfwMsgDeleted, false, "origin.delete não deve ser chamado para SFW");
		console.log("✓ Mídia SFW ignorada corretamente sem deleção");

		// -----------------------------------------------------------------------
		// 3. handleExternalDetection: Grupo SEM filtro NSFW -> não deve deletar
		// -----------------------------------------------------------------------
		console.log("\n3. Testando handleExternalDetection com grupo SEM filtro NSFW...");
		let noFilterMsgDeleted = false;
		const msgGroupSemFiltro = createMessage({
			type: "image",
			group: "grupo-livre@g.us",
			author: "5511999990002@s.whatsapp.net"
		});
		msgGroupSemFiltro.origin.delete = async () => {
			noFilterMsgDeleted = true;
		};

		const groupSemFiltro = {
			id: "grupo-livre@g.us",
			name: "Grupo Livre",
			filters: { nsfw: false }
		};

		const result3 = await nsfwPredict.handleExternalDetection(bot, msgGroupSemFiltro, {
			isNSFW: true,
			type: "anime",
			description: "Conteúdo adulto em grupo livre",
			group: groupSemFiltro
		});

		assert.strictEqual(result3.deleted, false, "Não deve deletar em grupo sem filtro");
		assert.strictEqual(noFilterMsgDeleted, false, "origin.delete não deve ser chamado");
		console.log("✓ Grupo sem filtro respeitado (mensagem mantida)");

		// -----------------------------------------------------------------------
		// 4. handleExternalDetection: Mensagem em PV -> não deve moderar
		// -----------------------------------------------------------------------
		console.log("\n4. Testando handleExternalDetection em mensagem privada (PV)...");
		let pvMsgDeleted = false;
		const msgPv = createMessage({
			type: "image",
			group: null,
			author: "5511999990003@s.whatsapp.net"
		});
		msgPv.origin.delete = async () => {
			pvMsgDeleted = true;
		};

		const result4 = await nsfwPredict.handleExternalDetection(bot, msgPv, {
			isNSFW: true,
			type: "vida-real",
			description: "Foto privada"
		});

		assert.strictEqual(result4.handled, false, "Não deve tratar mensagem de PV");
		assert.strictEqual(result4.reason, "private_chat", "Motivo deve ser private_chat");
		assert.strictEqual(pvMsgDeleted, false, "Não deve deletar mensagem no PV");
		console.log("✓ Conversa privada (PV) não moderada");

		// -----------------------------------------------------------------------
		// 5. handleExternalDetection: Grupo de Dossiês -> não deve moderar
		// -----------------------------------------------------------------------
		console.log("\n5. Testando handleExternalDetection em grupo de dossiês...");
		let dossieMsgDeleted = false;
		const msgDossie = createMessage({
			type: "image",
			group: "dossie@g.us",
			author: "5511999990004@s.whatsapp.net"
		});
		msgDossie.origin.delete = async () => {
			dossieMsgDeleted = true;
		};

		const result5 = await nsfwPredict.handleExternalDetection(bot, msgDossie, {
			isNSFW: true,
			type: "desenho",
			description: "Evidência em grupo de dossiê"
		});

		assert.strictEqual(result5.handled, false, "Não deve tratar grupo de dossiê");
		assert.strictEqual(result5.reason, "dossie_group", "Motivo deve ser dossie_group");
		assert.strictEqual(dossieMsgDeleted, false, "Não deve deletar no canal de dossiê");
		console.log("✓ Grupo de dossiê protegido");

		// -----------------------------------------------------------------------
		// 6. handleExternalDetection: Purgar stickers associados
		// -----------------------------------------------------------------------
		console.log("\n6. Testando purga de stickers residuais associados à mensagem...");
		const msgOrigId = "123456@g.us_false_ORIGINAL123";
		const msgComSticker = createMessage({
			type: "image",
			group: "grupo-com-filtro@g.us",
			author: "5511999990005@s.whatsapp.net"
		});
		msgComSticker.origin.id = { id: msgOrigId, _serialized: msgOrigId };
		msgComSticker.origin.delete = async () => {};

		// Registra sticker enviado associado ao ID
		eventHandler.registerSentSticker(msgOrigId, {
			chatId: "grupo-com-filtro@g.us",
			id: "SENT_STICKER_777"
		});

		let stickerDeletedId = null;
		bot.deleteMessageByKey = async (key) => {
			stickerDeletedId = key.id;
			return { success: true };
		};

		await nsfwPredict.handleExternalDetection(bot, msgComSticker, {
			isNSFW: true,
			type: "anime",
			description: "Sticker gerado com conteúdo adulto",
			group: groupComFiltro
		});

		assert.strictEqual(
			stickerDeletedId,
			"SENT_STICKER_777",
			"Sticker associado deveria ter sido purgado"
		);
		console.log("✓ Purga de sticker residual executada com sucesso");

		// -----------------------------------------------------------------------
		// 7. Integração completa via SummaryCommands.storeMessage (Imagem)
		// -----------------------------------------------------------------------
		console.log("\n7. Testando integração completa SummaryCommands.storeMessage com imagem...");
		const llmService = LLMService.getInstance();
		const originalGetCompletion = llmService.getCompletion;

		// Mock da resposta do LLM Vision AI
		llmService.getCompletion = async () =>
			JSON.stringify({
				type: "anime",
				nsfw: true,
				description: "Personagem feminino sem roupas"
			});

		let integrationMsgDeleted = false;
		const msgParaSummary = createMessage({
			type: "image",
			content: { data: "base64_dummy_image_data" },
			group: "grupo-com-filtro@g.us",
			author: "5511999990006@s.whatsapp.net",
			name: "UsuarioIntegracao"
		});
		msgParaSummary.origin.delete = async (forEveryone) => {
			if (forEveryone) integrationMsgDeleted = true;
		};

		// Injeta o grupo no cache do eventHandler para busca direta
		eventHandler.groups["grupo-com-filtro@g.us"] = groupComFiltro;

		await SummaryCommands.storeMessage(msgParaSummary, "grupo-com-filtro@g.us", bot);

		// Aguarda microtasks de promises
		await new Promise((resolve) => setTimeout(resolve, 100));

		assert.strictEqual(
			integrationMsgDeleted,
			true,
			"SummaryCommands.storeMessage deveria ter disparado o trigger e deletado a mensagem"
		);
		console.log("✓ Integração completa de storeMessage com trigger NSFW validada com sucesso!");

		// -----------------------------------------------------------------------
		// 8. Trigger NSFW via detecção de vídeo (Video AI)
		// -----------------------------------------------------------------------
		console.log("\n8. Testando trigger em vídeo NSFW via handleExternalDetection...");
		let videoMsgDeleted = false;
		const msgVideo = createMessage({
			type: "video",
			group: "grupo-com-filtro@g.us",
			author: "5511999990007@s.whatsapp.net",
			name: "UsuarioVideo"
		});
		msgVideo.origin.delete = async (forEveryone) => {
			if (forEveryone) videoMsgDeleted = true;
		};

		const resultVideo = await nsfwPredict.handleExternalDetection(bot, msgVideo, {
			isNSFW: true,
			type: "vida-real",
			description: "Vídeo explícito detectado",
			source: "SummaryCommands:VisionAI:Video",
			group: groupComFiltro
		});

		assert.strictEqual(resultVideo.handled, true, "Trigger de vídeo deveria ser tratado");
		assert.strictEqual(resultVideo.deleted, true, "Vídeo deveria ser marcado como deletado");
		assert.strictEqual(videoMsgDeleted, true, "Mensagem de vídeo deveria ter sido deletada");
		console.log("✓ Trigger NSFW para vídeo validado com sucesso!");

		// Restaura stubs
		llmService.getCompletion = originalGetCompletion;
	} finally {
		Status.getServicesStatus = originalGetServicesStatus;
	}

	console.log(
		"\n🎉 Todos os testes de integração do SummaryCommands + NSFWPredict passaram com sucesso!"
	);
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
