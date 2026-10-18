process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");

async function runTests() {
	console.log("=== Iniciando Testes: Denúncias em Multi-Roll Waifuletes ===");

	const bot = new FakeBot({
		id: "bot_test",
		grupoLogs: "logs123@g.us"
	});

	// Mock das chamadas de API
	const origGet = WaifuCommands.api.get;
	const origPost = WaifuCommands.api.post;

	const mockDatabase = {
		"rem-re-zero": {
			id: "rem-re-zero",
			name: "Rem",
			series: "Re:Zero",
			rarity: "COMMON",
			baseRarity: "COMMON",
			imageUrl: "http://example.com/rem.jpg"
		},
		"emilia-re-zero": {
			id: "emilia-re-zero",
			name: "Emilia",
			series: "Re:Zero",
			rarity: "EPIC",
			baseRarity: "EPIC",
			imageUrl: "http://example.com/emilia.jpg"
		},
		"ram-re-zero": {
			id: "ram-re-zero",
			name: "Ram",
			series: "Re:Zero",
			rarity: "RARE",
			baseRarity: "RARE",
			imageUrl: "http://example.com/ram.jpg"
		}
	};

	WaifuCommands.api.get = async (url, config) => {
		if (url.startsWith("/characters/")) {
			const id = decodeURIComponent(url.replace("/characters/", ""));
			if (mockDatabase[id]) {
				return { data: { success: true, data: mockDatabase[id] } };
			}
			return { data: { success: false, message: "Not found" } };
		}
		if (url === "/characters") {
			const q = config?.params?.search?.toLowerCase();
			const found = Object.values(mockDatabase).filter(
				(c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
			);
			return { data: { success: true, data: { data: found } } };
		}
		return { data: { success: false } };
	};

	// ─── TESTE 1: Parser de slots de texto (extractMultiRollSlotsFromText) ───
	console.log("\n1. Testando extractMultiRollSlotsFromText...");
	const sampleRollText = `🎲 Waifuletes! *3* rolls:

💍 *Personagens livres:*
_Reaja com o emoji do número para casar!_

1️⃣ ⚪ [Comum] Rem — Re:Zero
> !mu-casar rem-re-zero

2️⃣ 🟣 [Épico] Emilia — Re:Zero
> !mu-casar emilia-re-zero

💔 *Personagens casados:*
3️⃣ 🟢 [Raro] Ram — Re:Zero (Moothz)

✨ *Fragmentos colhidos:* +15 Zinthos

🎟️ Rolls restantes: 5/9`;

	const parsedSlots = WaifuCommands.extractMultiRollSlotsFromText(sampleRollText);
	assert.strictEqual(parsedSlots.length, 3, "Deve extrair 3 slots do texto");
	assert.strictEqual(parsedSlots[0].slot, 1);
	assert.strictEqual(parsedSlots[0].characterName, "Rem");
	assert.strictEqual(parsedSlots[0].characterId, "rem-re-zero");
	assert.strictEqual(parsedSlots[1].slot, 2);
	assert.strictEqual(parsedSlots[1].characterName, "Emilia");
	assert.strictEqual(parsedSlots[1].characterId, "emilia-re-zero");
	assert.strictEqual(parsedSlots[2].slot, 3);
	assert.strictEqual(parsedSlots[2].characterName, "Ram");
	assert.strictEqual(
		parsedSlots[2].characterId,
		null,
		"Slot casado sem comando casar tem characterId null inicialmente"
	);
	console.log("✓ extractMultiRollSlotsFromText validado com sucesso!");

	// ─── TESTE 2: Denúncia via citação (!mu-denunciar citando multi-roll com grid em cache) ───
	console.log("\n2. Testando !mu-denunciar citando mensagem de multi-roll em cache...");
	const multiMsgId = "3EB0_MULTI_TEST_001";
	const fakeGridBase64 = Buffer.from("fake-grid-image-data").toString("base64");
	const multiSlots = [
		{
			slot: 1,
			characterId: "rem-re-zero",
			characterName: "Rem",
			series: "Re:Zero",
			rarity: "COMMON",
			imageUrl: "http://example.com/rem.jpg"
		},
		{
			slot: 2,
			characterId: "emilia-re-zero",
			characterName: "Emilia",
			series: "Re:Zero",
			rarity: "EPIC",
			imageUrl: "http://example.com/emilia.jpg"
		},
		{
			slot: 3,
			characterId: "ram-re-zero",
			characterName: "Ram",
			series: "Re:Zero",
			rarity: "RARE",
			imageUrl: "http://example.com/ram.jpg"
		}
	];

	WaifuCommands.recordRollMessage(
		multiMsgId,
		multiSlots,
		"group1@g.us",
		Date.now() + 300000,
		"5511999990001@s.whatsapp.net",
		null,
		"Usuario1",
		null,
		fakeGridBase64
	);

	const replyMsg = createMessage({
		content: "!mu-denunciar",
		group: "group1@g.us",
		author: "5511888880002@s.whatsapp.net",
		authorName: "Denunciante1"
	});
	replyMsg.quotedMessageId = multiMsgId;
	replyMsg.origin.getQuotedMessage = async () => ({
		id: { _serialized: multiMsgId, id: multiMsgId },
		caption: sampleRollText,
		downloadMedia: async () => ({
			mimetype: "image/jpeg",
			data: fakeGridBase64,
			isMessageMedia: true
		})
	});

	const apiPostCalls = [];
	WaifuCommands.api.post = async (url, data, config) => {
		apiPostCalls.push({ url, data, config });
		return { data: { success: true, data: { report: { id: "rep_test_123" } } } };
	};

	const reportResults = await WaifuCommands.denunciarWaifu(bot, replyMsg, [], {
		name: "Grupo Anime"
	});
	assert.ok(Array.isArray(reportResults), "Deve retornar array de ReturnMessages");

	// NÃO deve enviar mensagem para o grupo de logs
	const logMsg = reportResults.find((m) => m.chatId === "logs123@g.us");
	assert.strictEqual(logMsg, undefined, "NÃO deve enviar mensagem para o grupoLogs");
	assert.strictEqual(
		reportResults.filter((m) => m.chatId === "logs123@g.us").length,
		0,
		"Nenhuma mensagem deve ser enviada para grupoLogs"
	);

	// Verifica chamada na API oficial do Waifuletes
	const postCall = apiPostCalls.find((c) => c.url === "/characters/multi-report");
	assert.ok(postCall, "Deve despachar a denúncia para /characters/multi-report");
	assert.strictEqual(postCall.data.slots.length, 3, "Deve enviar os 3 slots");
	assert.strictEqual(
		postCall.data.gridImageBase64,
		fakeGridBase64,
		"Deve conter a imagem em base64 do grid"
	);
	assert.strictEqual(postCall.data.slots[0].characterId, "rem-re-zero");
	assert.strictEqual(postCall.data.slots[1].characterId, "emilia-re-zero");
	assert.strictEqual(postCall.data.slots[2].characterId, "ram-re-zero");

	// Verifica resposta de confirmação no grupo
	const groupConfirmMsg = reportResults.find((m) => m.chatId === "group1@g.us");
	assert.ok(groupConfirmMsg, "Deve enviar confirmação para o chat de origem");
	assert.ok(groupConfirmMsg.content.includes("Denúncia Registrada"), "Texto de confirmação");
	assert.ok(groupConfirmMsg.content.includes("3"), "Indica que 3 personagens foram denunciados");
	console.log(
		"✓ !mu-denunciar citando mensagem de multi-roll chamando endpoint oficial validado com sucesso!"
	);

	// ─── TESTE 3: Denúncia via Reação ⛔ em post de multi-roll ───
	console.log("\n3. Testando denúncia via reação ⛔ em mensagem de multi-roll...");
	apiPostCalls.length = 0;
	const reactMsg = createMessage({
		content: sampleRollText,
		caption: sampleRollText,
		group: "group1@g.us",
		author: "5511999990001@s.whatsapp.net"
	});
	reactMsg.id = multiMsgId;
	reactMsg.originReaction = {
		reaction: "⛔",
		msgId: { _serialized: multiMsgId },
		senderId: "5511777770003@s.whatsapp.net",
		userName: "Reator1"
	};

	const reactResults = await WaifuCommands.denunciarWaifu(bot, reactMsg, [], {
		name: "Grupo Anime"
	});
	assert.ok(Array.isArray(reactResults), "Deve retornar array de ReturnMessages");

	const reactLogMsg = reactResults.find((m) => m.chatId === "logs123@g.us");
	assert.strictEqual(reactLogMsg, undefined, "Não deve enviar para grupoLogs na reação");
	const reactPostCall = apiPostCalls.find((c) => c.url === "/characters/multi-report");
	assert.ok(reactPostCall, "Reação deve despachar para /characters/multi-report");
	assert.strictEqual(reactPostCall.data.slots.length, 3);
	console.log("✓ Denúncia via reação ⛔ em multi-roll validada com sucesso!");

	// ─── TESTE 4: Denúncia pós-restart (cache miss com resolução via texto e download) ───
	console.log(
		"\n4. Testando denúncia de multi-roll pós-restart (cache miss, resolução de IDs e download)..."
	);
	// Limpa caches em memória
	WaifuCommands.multiRollHistoryByMsgId.clear();
	WaifuCommands.pendingClaims.clear();
	apiPostCalls.length = 0;

	const postRestartMsgId = "3EB0_POST_RESTART_999";
	const postRestartReply = createMessage({
		content: "!mu-denunciar",
		group: "group2@g.us",
		author: "5511666660004@s.whatsapp.net",
		authorName: "UserPosRestart"
	});
	postRestartReply.quotedMessageId = postRestartMsgId;
	postRestartReply.origin.getQuotedMessage = async () => ({
		id: { _serialized: postRestartMsgId, id: postRestartMsgId },
		caption: sampleRollText,
		downloadMedia: async () => ({
			mimetype: "image/jpeg",
			data: fakeGridBase64,
			isMessageMedia: true
		})
	});

	const postRestartResults = await WaifuCommands.denunciarWaifu(bot, postRestartReply, [], {
		name: "Grupo B"
	});
	assert.ok(Array.isArray(postRestartResults));
	assert.strictEqual(
		postRestartResults.filter((m) => m.chatId === "logs123@g.us").length,
		0,
		"Não deve enviar para grupoLogs no fallback"
	);
	const restartPostCall = apiPostCalls.find((c) => c.url === "/characters/multi-report");
	assert.ok(restartPostCall, "Deve chamar /characters/multi-report no fallback");
	assert.ok(
		restartPostCall.data.slots.some((s) => s.characterId === "ram-re-zero"),
		"Deve ter resolvido o ID de Ram através de busca por nome"
	);
	assert.ok(restartPostCall.data.slots.some((s) => s.characterId === "rem-re-zero"));
	assert.ok(restartPostCall.data.slots.some((s) => s.characterId === "emilia-re-zero"));
	console.log("✓ Denúncia pós-restart com resolução automática de IDs validada com sucesso!");

	// ─── TESTE 5: Registro no banco SQLite de confirmações ───
	console.log("\n5. Testando registro de confirmações para os personagens no SQLite...");
	const confirmsRem = WaifuCommands.getWaifuReportConfirmations("rem-re-zero");
	assert.ok(confirmsRem.length > 0, "Deve haver confirmação registrada para rem-re-zero");
	const confirmsEmilia = WaifuCommands.getWaifuReportConfirmations("emilia-re-zero");
	assert.ok(confirmsEmilia.length > 0, "Deve haver confirmação registrada para emilia-re-zero");
	const confirmsRam = WaifuCommands.getWaifuReportConfirmations("ram-re-zero");
	assert.ok(confirmsRam.length > 0, "Deve haver confirmação registrada para ram-re-zero");
	console.log("✓ Registros de confirmação no SQLite validados com sucesso!");

	// Restaura mocks
	WaifuCommands.api.get = origGet;
	WaifuCommands.api.post = origPost;

	console.log("\n=======================================================");
	console.log("TODOS OS TESTES DE DENÚNCIA MULTI-ROLL PASSARAM COM SUCESSO!");
	console.log("=======================================================\n");

	process.exit(0);
}

runTests().catch((err) => {
	console.error("Erro no teste de multi-roll denúncia:", err);
	process.exit(1);
});
