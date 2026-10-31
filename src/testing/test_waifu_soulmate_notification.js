const assert = require("assert");
const FakeBot = require("./FakeBot");
const WaifuCommands = require("../functions/WaifuCommands");
const { notifySoulmateAchievement } = WaifuCommands;

async function runTests() {
	console.log("--- Starting Waifu Soulmate Notification Tests ---");

	const bot = new FakeBot({
		id: "test-waifu-bot",
		grupoAvisos: "avisos@g.us",
		grupoLogs: "logs@g.us"
	});

	const dummyGeneratedBase64 = Buffer.from("DUMMY_SOULMATE_PHOTO").toString("base64");

	const soulmateChar = {
		id: "salome-hyakumantenbara",
		name: "Hyakumantenbara Salome",
		series: "Nijisanji",
		rarity: "EPIC",
		imageUrl: "http://localhost:3030/images/salome.jpg"
	};

	const customMedia = {
		data: dummyGeneratedBase64,
		mimetype: "image/jpeg",
		filename: "soulmate_salome.jpg",
		isMessageMedia: true
	};

	// 1. Notificação de Soulmate com mídia customizada
	const res = await notifySoulmateAchievement(
		bot,
		soulmateChar,
		"Psy",
		"31/10/2026",
		null,
		customMedia
	);

	assert.ok(res, "notifySoulmateAchievement deve retornar true");
	assert.ok(bot.capturedMessages.length > 0, "Bot deve capturar mensagem enviada");

	const msg = bot.capturedMessages[0];
	assert.strictEqual(msg.chatId, "avisos@g.us", "Deve ser enviada para grupoAvisos");
	assert.strictEqual(msg.content.data, dummyGeneratedBase64, "Deve conter imagem em base64");

	const caption = msg.options?.caption || "";
	assert.ok(caption.includes("Hyakumantenbara Salome"), "Deve conter o nome do personagem");
	assert.ok(caption.includes("Psy"), "Deve conter o nome do jogador");
	assert.ok(caption.includes("SOULMATE"), "Deve conter o texto SOULMATE");
	assert.ok(caption.includes("10 Chaves do Destino"), "Deve mencionar as 10 chaves");
	assert.ok(caption.includes("Bônus no Ranking"), "Deve listar bônus no ranking");
	assert.ok(caption.includes("4 cotas"), "Deve mencionar valor de 4 cotas no divórcio");
	assert.ok(caption.includes("💖"), "Deve conter corações");
	assert.ok(caption.includes("💕"), "Deve conter corações");
	assert.ok(caption.includes("❤️"), "Deve conter corações");

	console.log("✓ 1. Notificação de Soulmate enviada e validada com sucesso!");

	console.log("--- All Waifu Soulmate Tests Passed! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
