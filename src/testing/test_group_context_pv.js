process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const Database = require("../utils/Database");
const AdminUtils = require("../utils/AdminUtils");
const GroupContextHelper = require("../utils/GroupContextHelper");

const MinecraftCommands = require("../functions/MinecraftCommands");
const CanaisCommands = require("../functions/CanaisCommands");
const Raffles = require("../functions/Raffles");
const GamingFreebies = require("../functions/GamingFreebies");
const StreamCommands = require("../functions/StreamCommands");
const RoletaRussaCommands = require("../functions/RoletaRussaCommands");
const RankingMessages = require("../functions/RankingMessages");
const PintoGame = require("../functions/PintoGame");
const ListCommands = require("../functions/ListCommands");

async function runTests() {
	console.log("=== INICIANDO TESTES DO GROUP CONTEXT HELPER EM PV (!g-manage) ===");

	const bot = new FakeBot({ id: "test-bot" });
	const database = Database.getInstance();

	const targetGroupId = "120363111222333444@g.us";
	const targetGroup = {
		id: targetGroupId,
		name: "Grupo Piloto",
		admins: ["5511999990001@s.whatsapp.net"],
		minecraftServer: { host: "mc.teste.com", port: 25565 }
	};

	// Mock Database.getGroup
	const origGetGroup = database.getGroup;
	database.getGroup = async (gid) => (gid === targetGroupId ? targetGroup : null);

	// Setup fake eventHandler / commandHandler
	bot.eventHandler = {
		commandHandler: {
			privateManagement: {}
		}
	};

	const userAdmin = "5511999990001@s.whatsapp.net";
	const userNonAdmin = "5511999990002@s.whatsapp.net";

	// Mock AdminUtils.isAdmin
	const origIsAdmin = AdminUtils.getInstance().isAdmin;
	AdminUtils.getInstance().isAdmin = async (userId, group) => {
		if (group?.id === targetGroupId) {
			return group.admins.includes(userId);
		}
		return false;
	};

	try {
		// -------------------------------------------------------------
		// 1. Teste direto de GroupContextHelper
		// -------------------------------------------------------------
		console.log("\n[1] Testando GroupContextHelper diretamente...");

		// 1.1 PV sem !g-manage
		const msgPvSemManage = createMessage({
			content: "!comando",
			group: null,
			author: userAdmin
		});
		const res1 = await GroupContextHelper.resolveGroup(bot, msgPvSemManage, null, {
			featureName: "testes"
		});
		assert.strictEqual(res1.targetGroup, null);
		assert.ok(res1.errorResponse.content.includes("!g-manage [nomeDoGrupo]"));
		assert.strictEqual(res1.errorResponse.chatId, userAdmin);

		// 1.2 PV com !g-manage para userAdmin
		bot.eventHandler.commandHandler.privateManagement[userAdmin] = targetGroupId;
		const res2 = await GroupContextHelper.resolveGroupAndAdmin(bot, msgPvSemManage, null, {
			featureName: "testes"
		});
		assert.strictEqual(res2.errorResponse, null);
		assert.strictEqual(res2.targetGroup.id, targetGroupId);
		assert.strictEqual(res2.responseChatId, userAdmin);

		// 1.3 PV com !g-manage para userNonAdmin
		bot.eventHandler.commandHandler.privateManagement[userNonAdmin] = targetGroupId;
		const msgPvNonAdmin = createMessage({
			content: "!comando",
			group: null,
			author: userNonAdmin
		});
		const res3 = await GroupContextHelper.resolveGroupAndAdmin(bot, msgPvNonAdmin, null, {
			featureName: "testes"
		});
		assert.strictEqual(res3.targetGroup, null);
		assert.ok(res3.errorResponse.content.includes("Acesso negado"));

		console.log("✓ GroupContextHelper direto validado com sucesso.");

		// -------------------------------------------------------------
		// 2. Testando MinecraftCommands em PV
		// -------------------------------------------------------------
		console.log("\n[2] Testando MinecraftCommands em PV...");
		const msgMineStatus = createMessage({
			content: "!mine-status",
			group: null,
			author: userAdmin
		});
		const resMineStatus = await MinecraftCommands.serverStatusCommand(bot, msgMineStatus, [], null);
		assert.ok(resMineStatus, "Deve retornar ReturnMessage");
		assert.strictEqual(resMineStatus.chatId, userAdmin);

		// -------------------------------------------------------------
		// 3. Testando ListCommands em PV
		// -------------------------------------------------------------
		console.log("\n[3] Testando ListCommands em PV (!lc, !listas, !ld)...");
		const msgListas = createMessage({
			content: "!listas",
			group: null,
			author: userAdmin
		});
		const resListas = await ListCommands.commands
			.find((c) => c.name === "listas")
			.execute(bot, msgListas, [], null);
		assert.ok(resListas, "Deve listar listas do grupo gerenciado no PV");
		assert.strictEqual(resListas.chatId, userAdmin);

		const msgLc = createMessage({
			content: "!lc Churrasco",
			group: null,
			author: userAdmin
		});
		const resLc = await ListCommands.commands
			.find((c) => c.name === "lc")
			.execute(bot, msgLc, ["Churrasco"], null);
		const lcArr = Array.isArray(resLc) ? resLc : [resLc];
		assert.ok(lcArr.some((m) => m.content.includes("Churrasco")));
		assert.strictEqual(lcArr[0].chatId, userAdmin);

		// -------------------------------------------------------------
		// 4. Testando StreamCommands em PV (!streams)
		// -------------------------------------------------------------
		console.log("\n[4] Testando StreamCommands em PV (!streams)...");
		targetGroup.twitch = [{ channel: "streamer_teste" }];
		const msgStreams = createMessage({
			content: "!streams",
			group: null,
			author: userAdmin
		});
		const resStreams = await StreamCommands.commands
			.find((c) => c.name === "streams")
			.execute(bot, msgStreams, [], null);
		assert.ok(resStreams.content.includes("streamer_teste"));
		assert.strictEqual(resStreams.chatId, userAdmin);

		// -------------------------------------------------------------
		// 5. Testando RoletaRussaCommands em PV (!roleta-tempo)
		// -------------------------------------------------------------
		console.log("\n[5] Testando RoletaRussaCommands em PV (!roleta-tempo)...");
		const msgRoletaTempo = createMessage({
			content: "!roleta-tempo 120",
			group: null,
			author: userAdmin
		});
		const resRoletaTempo = await RoletaRussaCommands.commands
			.find((c) => c.name === "roleta-tempo")
			.execute(bot, msgRoletaTempo, ["120"], null);
		assert.ok(resRoletaTempo.content.includes("2 minuto(s)"));
		assert.strictEqual(resRoletaTempo.chatId, userAdmin);

		// Tentativa por usuário não-admin no PV
		const msgRoletaTempoNonAdmin = createMessage({
			content: "!roleta-tempo 120",
			group: null,
			author: userNonAdmin
		});
		const resRoletaNonAdmin = await RoletaRussaCommands.commands
			.find((c) => c.name === "roleta-tempo")
			.execute(bot, msgRoletaTempoNonAdmin, ["120"], null);
		assert.ok(resRoletaNonAdmin.content.includes("Acesso negado"));
		assert.strictEqual(resRoletaNonAdmin.chatId, userNonAdmin);

		// -------------------------------------------------------------
		// 6. Testando PintoGame em PV (!pinto-ranking, !pinto-reset)
		// -------------------------------------------------------------
		console.log("\n[6] Testando PintoGame em PV (!pinto-ranking)...");
		const msgPintoRanking = createMessage({
			content: "!pinto-ranking",
			group: null,
			author: userAdmin
		});
		const resPintoRanking = await PintoGame.commands
			.find((c) => c.name === "pinto-ranking")
			.execute(bot, msgPintoRanking, [], null);
		assert.ok(resPintoRanking, "Deve retornar mensagem de ranking");
		assert.strictEqual(resPintoRanking.chatId, userAdmin);

		// -------------------------------------------------------------
		// 7. Testando RankingMessages em PV (!faladores)
		// -------------------------------------------------------------
		console.log("\n[7] Testando RankingMessages em PV (!faladores)...");
		const msgFaladores = createMessage({
			content: "!faladores",
			group: null,
			author: userAdmin
		});
		const resFaladores = await RankingMessages.commands
			.find((c) => c.name === "faladores")
			.execute(bot, msgFaladores, [], null);
		assert.ok(resFaladores, "Deve retornar mensagem de faladores");
		assert.strictEqual(resFaladores.chatId, userAdmin);

		console.log("\n==========================================");
		console.log("🎉 TODOS OS TESTES DE PV PASSARAM COM SUCESSO!");
		console.log("==========================================");
	} finally {
		database.getGroup = origGetGroup;
		AdminUtils.getInstance().isAdmin = origIsAdmin;
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ FALHA NO TESTE:", err);
		process.exit(1);
	});
