const assert = require("assert");
const SlotsGame = require("../functions/SlotsGame");
const FishingGame = require("../functions/FishingGame");
const RoletaRussaCommands = require("../functions/RoletaRussaCommands");
const AnagramGame = require("../functions/AnagramGame");
const StopGame = require("../functions/StopGame");
const PintoGame = require("../functions/PintoGame");
const WeeklyGameDigestService = require("../services/WeeklyGameDigestService");

async function runTests() {
	console.log("--- Starting Weekly Game Digest Tests ---");

	// Save original functions to restore later
	const origSlots = SlotsGame.getWeeklySlotsStats;
	const origFishing = FishingGame.getWeeklyFishingStats;
	const origRoleta = RoletaRussaCommands.getWeeklyRoletaStats;
	const origAnagram = AnagramGame.getWeeklyAnagramStats;
	const origStop = StopGame.getWeeklyStopStats;
	const origPinto = PintoGame.getWeeklyPintoStats;

	try {
		// Mock weekly stats in-memory (no database writes or pollution)
		SlotsGame.getWeeklySlotsStats = async () => [
			{
				user_id: "user_slots1",
				user_name: "JogadorSlots1",
				wins: 2,
				plays: 2,
				coins_spent: 10
			}
		];
		FishingGame.getWeeklyFishingStats = async () => [
			{
				user_id: "user_fish1",
				user_name: "PescadorSenior",
				total_catches: 1,
				total_weight: 10.5,
				score: 15.5
			}
		];
		RoletaRussaCommands.getWeeklyRoletaStats = async () => [
			{
				user_id: "user_roleta_alive",
				user_name: "ImortalTest",
				survivals: 201,
				deaths: 0,
				isAlive: true
			},
			{
				user_id: "user_roleta_dead",
				user_name: "AzaradoTest",
				survivals: 151,
				deaths: 1,
				isAlive: false
			}
		];
		AnagramGame.getWeeklyAnagramStats = async () => [
			{ user_id: "user_ana1", user_name: "MestrePalavras", points: 50 }
		];
		StopGame.getWeeklyStopStats = async () => [
			{ user_id: "user_stop1", user_name: "ReiDoStop", points: 100, wins: 1 }
		];
		PintoGame.getWeeklyPintoStats = async () => [
			{ user_id: "user_pinto1", user_name: "Gigante", erect: 25, score: 250 }
		];

		const digestService = WeeklyGameDigestService.getInstance();
		const sinceMs = Date.now() - 7 * 24 * 3600 * 1000;
		const digestText = await digestService.generateWeeklyDigest(sinceMs);

		console.log("--- Digest Gerado ---");
		console.log(digestText);

		assert.ok(digestText, "Digest text must not be null");
		assert.ok(!digestText.includes("Período"), "Must not include Período line");
		assert.ok(digestText.includes("SLOTS"), "Must include SLOTS section");
		assert.ok(digestText.includes("PESCARIA"), "Must include PESCARIA section");
		assert.ok(digestText.includes("ROLETA RUSSA"), "Must include ROLETA RUSSA section");
		assert.ok(digestText.includes("ANAGRAMA"), "Must include ANAGRAMA section");
		assert.ok(digestText.includes("ADEDONHA"), "Must include ADEDONHA section");
		assert.ok(digestText.includes("PINTO GAME"), "Must include PINTO GAME section");

		// Verify Roleta status icons
		assert.ok(digestText.includes("🛡️ *ImortalTest*"), "ImortalTest must have 🛡️ icon");
		assert.ok(digestText.includes("💀 *AzaradoTest*"), "AzaradoTest must have 💀 icon");

		console.log("✓ All 6 games included in weekly digest");

		// Modular test: omit slots and stop history and check omission
		SlotsGame.getWeeklySlotsStats = async () => [];
		StopGame.getWeeklyStopStats = async () => [];

		const modularDigest = await digestService.generateWeeklyDigest(sinceMs);
		console.log("--- Modular Digest Gerado (Slots e Adedonha removidos) ---");
		console.log(modularDigest);

		assert.ok(!modularDigest.includes("SLOTS"), "Slots section must be omitted when empty");
		assert.ok(!modularDigest.includes("ADEDONHA"), "Adedonha section must be omitted when empty");
		assert.ok(modularDigest.includes("PESCARIA"), "Pescaria section must remain");

		console.log("✓ Modular omission test passed");

		// 3. Test sendDigest bot selection and target restrictions
		const FakeBot = require("./FakeBot");
		const telegramBot = new FakeBot({ id: "ravena-telegram", grupoLogs: "telegram_logs" });
		telegramBot.useTelegram = true;
		const discordBot = new FakeBot({ id: "ravena-discord", grupoLogs: "discord_logs" });
		discordBot.useDiscord = true;
		const yukiBot = new FakeBot({ id: "yuki", grupoLogs: "yuki_logs@g.us" });
		yukiBot.notificarDonate = false;
		const ravenaVipBot = new FakeBot({
			id: "ravenavip",
			grupoAnuncios: "target_anuncios@g.us",
			grupoAvisos: "target_avisos@g.us"
		});
		ravenaVipBot.notificarDonate = true;

		digestService.registeredBots.clear();
		digestService.registerBot(telegramBot);
		digestService.registerBot(discordBot);
		digestService.registerBot(yukiBot);
		digestService.registerBot(ravenaVipBot);

		const sendRes = await digestService.sendDigest();
		assert.ok(sendRes, "sendDigest should return true");
		assert.strictEqual(
			telegramBot.capturedMessages.length,
			0,
			"Telegram bot must receive 0 messages"
		);
		assert.strictEqual(
			discordBot.capturedMessages.length,
			0,
			"Discord bot must receive 0 messages"
		);
		assert.strictEqual(yukiBot.capturedMessages.length, 0, "Yuki bot must receive 0 messages");
		assert.strictEqual(
			ravenaVipBot.capturedMessages.length,
			2,
			"ravenavip must send exactly 2 messages (anuncios and avisos)"
		);

		const sentChats = ravenaVipBot.capturedMessages.map((m) => m.chatId);
		assert.ok(
			sentChats.includes("target_anuncios@g.us") ||
				(process.env.GRUPO_ANUNCIOS && sentChats.includes(process.env.GRUPO_ANUNCIOS.trim())),
			"Must send to anuncios"
		);
		assert.ok(
			sentChats.includes("target_avisos@g.us") ||
				(process.env.GRUPO_AVISOS && sentChats.includes(process.env.GRUPO_AVISOS.trim())),
			"Must send to avisos"
		);
		assert.ok(!sentChats.includes("yuki_logs@g.us"), "Must never send to yuki_logs");

		console.log("✓ Bot selection and target isolation test passed");
		console.log("--- ALL TESTS PASSED SUCCESSFULLY! ---");
		process.exit(0);
	} finally {
		// Restore original functions
		SlotsGame.getWeeklySlotsStats = origSlots;
		FishingGame.getWeeklyFishingStats = origFishing;
		RoletaRussaCommands.getWeeklyRoletaStats = origRoleta;
		AnagramGame.getWeeklyAnagramStats = origAnagram;
		StopGame.getWeeklyStopStats = origStop;
		PintoGame.getWeeklyPintoStats = origPinto;
	}
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
