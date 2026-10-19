const assert = require("assert");
const FakeBot = require("./FakeBot");
const WaifuCommands = require("../functions/WaifuCommands");
const { notifySpecialMarriage } = WaifuCommands;

async function runTests() {
	console.log("--- Starting Waifu Legendary Marriage Notification Tests ---");

	const bot = new FakeBot({
		id: "test-waifu-bot",
		grupoAvisos: "avisos@g.us",
		grupoLogs: "logs@g.us"
	});

	const dummyGeneratedBase64 = Buffer.from("DUMMY_GENERATED_MARRIAGE_PHOTO").toString("base64");
	const dummyCharacterBase64 = Buffer.from("DUMMY_ORIGINAL_CHARACTER_IMAGE").toString("base64");

	const legendaryChar = {
		id: "katsuki-bakugou",
		name: "Katsuki Bakugou",
		series: "Boku no Hero Academia",
		rarity: "LEGENDARY",
		imageUrl: "http://localhost:3030/images/bakugou.jpg"
	};

	// 1. Notificação de casamento Lendário usando a foto gerada (customMedia)
	const customMedia = {
		data: dummyGeneratedBase64,
		mimetype: "image/jpeg",
		filename: "marriage_katsuki-bakugou.jpg",
		isMessageMedia: true
	};

	const resWithPhoto = await notifySpecialMarriage(
		bot,
		legendaryChar,
		"ivri matte",
		"17/09/2026",
		null,
		customMedia
	);
	assert.ok(resWithPhoto, "notifySpecialMarriage para LENDÁRIO com foto gerada deve ter sucesso");
	assert.ok(bot.capturedMessages.length > 0, "Bot deve capturar mensagem de aviso");

	const legMsg = bot.capturedMessages[0];
	assert.strictEqual(legMsg.chatId, "avisos@g.us", "Mensagem deve ser enviada para grupoAvisos");
	assert.strictEqual(
		legMsg.content.data,
		dummyGeneratedBase64,
		"Deve usar os dados da foto gerada de casamento"
	);
	assert.strictEqual(
		legMsg.content.filename,
		"marriage_katsuki-bakugou.jpg",
		"Filename deve ser da foto de casamento"
	);

	const legCaption = legMsg.options?.caption || "";
	assert.ok(legCaption.includes("Katsuki Bakugou"), "Legenda deve incluir nome da personagem");
	assert.ok(legCaption.includes("ivri matte"), "Legenda deve incluir nome do jogador");
	assert.ok(legCaption.includes("LENDÁRIO"), "Legenda deve incluir raridade LENDÁRIO");
	console.log("✓ 1. Notificação com foto gerada de casamento passou com sucesso");

	// 2. Fallback: Casamento Lendário sem foto gerada -> deve usar a foto do personagem
	bot.resetCapture();
	const origDownload = WaifuCommands.downloadImageAsBase64;
	WaifuCommands.downloadImageAsBase64 = async () => dummyCharacterBase64;

	const resFallbackImage = await notifySpecialMarriage(
		bot,
		legendaryChar,
		"ivri matte",
		"17/09/2026",
		null,
		null // Sem foto gerada
	);
	assert.ok(
		resFallbackImage,
		"notifySpecialMarriage para LENDÁRIO sem foto gerada deve usar fallback da foto do personagem"
	);
	assert.ok(bot.capturedMessages.length > 0, "Bot deve capturar mensagem de aviso");

	const fallbackMsg = bot.capturedMessages[0];
	assert.strictEqual(
		fallbackMsg.content.data,
		dummyCharacterBase64,
		"Deve usar a imagem original do personagem como fallback"
	);
	console.log("✓ 2. Fallback para foto do personagem passou com sucesso");

	// 3. Fallback: Casamento Lendário sem foto gerada e sem foto do personagem -> texto puro
	bot.resetCapture();
	WaifuCommands.downloadImageAsBase64 = async () => null;
	const legendaryCharSemFoto = {
		id: "sem-foto-char",
		name: "Lenda Sem Foto",
		series: "Anime Raro",
		rarity: "LEGENDARY",
		imageUrl: null
	};

	const resFallbackText = await notifySpecialMarriage(
		bot,
		legendaryCharSemFoto,
		"ivri matte",
		"17/09/2026",
		null,
		null
	);
	assert.ok(
		resFallbackText,
		"notifySpecialMarriage para LENDÁRIO sem nenhuma foto deve enviar texto puro"
	);
	const textOnlyMsg = bot.capturedMessages[0];
	assert.strictEqual(
		typeof textOnlyMsg.content,
		"string",
		"Mensagem deve ser de texto puro quando não há foto"
	);
	assert.ok(textOnlyMsg.content.includes("Lenda Sem Foto"), "Texto puro deve conter o personagem");
	console.log("✓ 3. Fallback para texto puro passou com sucesso");

	// 4. Raridades não-lendárias (EPIC, COMMON) devem ser ignoradas
	bot.resetCapture();
	const epicChar = {
		id: "tsunade-senju",
		name: "Tsunade Senju",
		series: "Naruto",
		rarity: "EPIC"
	};
	const resEpic = await notifySpecialMarriage(bot, epicChar, "William~~");
	assert.strictEqual(resEpic, false, "EPIC não deve enviar notificação para canal de avisos");
	assert.strictEqual(bot.capturedMessages.length, 0, "Nenhuma mensagem deve ser enviada para EPIC");

	const commonChar = {
		id: "common-guy",
		name: "Common Guy",
		series: "Background",
		rarity: "COMMON"
	};
	const resCommon = await notifySpecialMarriage(bot, commonChar, "Player1");
	assert.strictEqual(resCommon, false, "COMMON não deve enviar notificação para canal de avisos");
	assert.strictEqual(
		bot.capturedMessages.length,
		0,
		"Nenhuma mensagem deve ser enviada para COMMON"
	);
	console.log("✓ 4. Ignorar raridades não-lendárias (EPIC, COMMON) passou com sucesso");

	// Restaura mock
	WaifuCommands.downloadImageAsBase64 = origDownload;

	console.log("--- ALL TESTS PASSED SUCCESSFULLY! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
