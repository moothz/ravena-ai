const assert = require("assert");
const SlotsGame = require("../functions/SlotsGame");
const FishingGame = require("../functions/FishingGame");
const RoletaRussaCommands = require("../functions/RoletaRussaCommands");
const AnagramGame = require("../functions/AnagramGame");
const StopGame = require("../functions/StopGame");
const PintoGame = require("../functions/PintoGame");
const FazendaCommands = require("../functions/FazendaCommands");
const WaifuCommands = require("../functions/WaifuCommands");
const WeeklyGameDigestService = require("../services/WeeklyGameDigestService");
const SuperAdmin = require("../commands/SuperAdmin");

async function runTests() {
	console.log("--- Starting Weekly Game Digest Tests ---");

	// Save original functions to restore later
	const origSlots = SlotsGame.getWeeklySlotsStats;
	const origFishing = FishingGame.getWeeklyFishingStats;
	const origRoleta = RoletaRussaCommands.getWeeklyRoletaStats;
	const origAnagram = AnagramGame.getWeeklyAnagramStats;
	const origStop = StopGame.getWeeklyStopStats;
	const origPinto = PintoGame.getWeeklyPintoStats;
	const origFazenda = FazendaCommands.getWeeklyFazendaStats;
	const origWaifu = WaifuCommands.getWeeklyWaifuStats;

	try {
		// Mock weekly stats in-memory (no database writes or pollution)
		SlotsGame.getWeeklySlotsStats = async () => {
			const res = [
				{
					user_id: "user_slots1",
					user_name: "JogadorSlots1",
					wins: 2,
					plays: 2,
					coins_spent: 10
				}
			];
			res.mostUnlucky = {
				user_name: "AzaradoSlots",
				coins_spent: 80,
				plays: 16
			};
			return res;
		};

		FishingGame.getWeeklyFishingStats = async () => {
			const res = [
				{
					user_id: "user_fish1",
					user_name: "PescadorSenior",
					total_catches: 1,
					total_weight: 10.5,
					score: 15.5
				}
			];
			res.biggestCatch = {
				user_name: "PescadorSenior",
				fish_name: "Tubarão Branco",
				weight: 142.5
			};
			return res;
		};

		RoletaRussaCommands.getWeeklyRoletaStats = async () => {
			const res = [
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
			res.totalDeaths = 15;
			return res;
		};

		AnagramGame.getWeeklyAnagramStats = async () => [
			{ user_id: "user_ana1", user_name: "MestrePalavras", points: 50 }
		];
		StopGame.getWeeklyStopStats = async () => [
			{ user_id: "user_stop1", user_name: "ReiDoStop", points: 100, wins: 1 }
		];
		PintoGame.getWeeklyPintoStats = async () => {
			const res = [{ user_id: "user_pinto1", user_name: "Gigante", erect: 25, score: 250 }];
			res.smallest = {
				user_name: "MicroTest",
				erect: 1.5
			};
			return res;
		};

		FazendaCommands.getWeeklyFazendaStats = async () => ({
			topPlanted: [{ userId: "551111", userName: "PlantadorMaster", deltaPlanted: 120 }],
			topHarvested: [{ userId: "551111", userName: "PlantadorMaster", deltaHarvested: 110 }],
			topWithered: [{ userId: "552222", userName: "DedoPodre", deltaWithered: 25 }],
			richest: { userId: "551111", userName: "PlantadorMaster", coins: 85000 },
			topCrop: { name: "Raiz Devoradora", count: 450 },
			topDecorator: { userId: "553333", userName: "DecoradorTop", count: 8 }
		});

		WaifuCommands.getWeeklyWaifuStats = async () => ({
			rolls: { total_commands: 500, total_rolls: 2500, distinct_rollers: 50 },
			marriagesByRarity: [
				{ rarity: "COMMON", count: 20 },
				{ rarity: "UNCOMMON", count: 10 },
				{ rarity: "RARE", count: 5 },
				{ rarity: "EPIC", count: 2 },
				{ rarity: "LEGENDARY", count: 1 }
			],
			negotiationsCount: 8,
			weeklySoulmatesCount: 2,
			topMarrier: { name: "CasamenteiroReal", count: 7 },
			mostCoveted: { name: "Megumin", series: "Konosuba", count: 12 },
			categoryStats: [
				{ rarity: "COMMON", percentage: 3.5 },
				{ rarity: "UNCOMMON", percentage: 5.2 },
				{ rarity: "RARE", percentage: 9.8 },
				{ rarity: "EPIC", percentage: 14.1 },
				{ rarity: "LEGENDARY", percentage: 22.0 }
			]
		});

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

		// Verify Waifus section
		assert.ok(digestText.includes("WAIFUS & MUDAE"), "Must include WAIFUS section");
		assert.ok(digestText.includes("2.500 giros"), "Must include rolls count");
		assert.ok(digestText.includes("Casamentos na Semana:* 38"), "Must include total marriages");
		assert.ok(digestText.includes("Negociações Realizadas:* 8"), "Must include negotiations");
		assert.ok(digestText.includes("CasamenteiroReal"), "Must include top marrier");
		assert.ok(digestText.includes("*Megumin* (Konosuba)"), "Must include most coveted waifu");
		assert.ok(digestText.includes("Álbum Global"), "Must include category % line");

		// Verify Fazenda section
		assert.ok(digestText.includes("JARDIM LUTOSO (FAZENDA)"), "Must include FAZENDA section");
		assert.ok(digestText.includes("PlantadorMaster"), "Must include top planter");
		assert.ok(digestText.includes("DedoPodre"), "Must include top withered");
		assert.ok(digestText.includes("Raiz Devoradora"), "Must include top crop");
		assert.ok(digestText.includes("DecoradorTop"), "Must include top decorator");

		// Verify minigames highlights
		assert.ok(digestText.includes("Monstro dos Mares"), "Must include biggest catch");
		assert.ok(digestText.includes("AzaradoSlots"), "Must include most unlucky slots");
		assert.ok(digestText.includes("Cemitério da Roleta"), "Must include total deaths");
		assert.ok(digestText.includes("Microscópio da Semana"), "Must include smallest pinto");

		// Verify Roleta status icons
		assert.ok(digestText.includes("🛡️ *ImortalTest*"), "ImortalTest must have 🛡️ icon");
		assert.ok(digestText.includes("💀 *AzaradoTest*"), "AzaradoTest must have 💀 icon");

		console.log("✓ All games and new sections included in weekly digest");

		// Modular test: omit fazenda and waifu and check omission
		FazendaCommands.getWeeklyFazendaStats = async () => null;
		WaifuCommands.getWeeklyWaifuStats = async () => null;
		SlotsGame.getWeeklySlotsStats = async () => [];
		StopGame.getWeeklyStopStats = async () => [];

		const modularDigest = await digestService.generateWeeklyDigest(sinceMs);
		console.log("--- Modular Digest Gerado (Fazenda, Waifus, Slots e Adedonha omitidos) ---");
		console.log(modularDigest);

		assert.ok(!modularDigest.includes("SLOTS"), "Slots section must be omitted when empty");
		assert.ok(!modularDigest.includes("ADEDONHA"), "Adedonha section must be omitted when empty");
		assert.ok(!modularDigest.includes("WAIFUS"), "Waifus section must be omitted when empty");
		assert.ok(!modularDigest.includes("FAZENDA"), "Fazenda section must be omitted when empty");
		assert.ok(modularDigest.includes("PESCARIA"), "Pescaria section must remain");

		console.log("✓ Modular omission test passed");

		// Test SuperAdmin !sa-resumosemanal command
		const superAdmin = new SuperAdmin();
		const previewMsg = await superAdmin.handleResumoSemanal(
			null,
			{ author: "5511999999999@s.whatsapp.net", group: "test_group@g.us" },
			[],
			{}
		);
		assert.ok(previewMsg, "SuperAdmin command should return a message");
		assert.ok(previewMsg.content.includes("PESCARIA"), "Preview must contain digest content");
		console.log("✓ SuperAdmin command !sa-resumosemanal preview passed");

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
		FazendaCommands.getWeeklyFazendaStats = origFazenda;
		WaifuCommands.getWeeklyWaifuStats = origWaifu;
	}
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
