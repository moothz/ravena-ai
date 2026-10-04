process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");

async function main() {
	console.log("--- Testing Group Join Welcome Messages ---");

	// Test 1: New group join should send botInfoMessage
	{
		const bot = new FakeBot({ id: "ravenavip", phoneNumber: "555591535538" });
		const eventHandler = new EventHandler();

		const newGroupId = `test_new_${Date.now()}@g.us`;
		const eventData = {
			group: { id: newGroupId, name: "Novo Grupo Teste" },
			user: { id: "555591535538@s.whatsapp.net", name: "ravenavip" },
			responsavel: { id: "5511888888888@s.whatsapp.net", name: "Admin" },
			isBotJoining: true,
			origin: {
				getChat: async () => ({
					id: { _serialized: newGroupId },
					name: "Novo Grupo Teste",
					participants: []
				})
			}
		};

		await eventHandler.processGroupJoin(bot, eventData);

		const sentToGroup = bot.capturedMessages.filter((m) => m.chatId === newGroupId);
		assert.ok(
			sentToGroup.length >= 1,
			`Esperava pelo menos 1 mensagem enviada para o novo grupo ${newGroupId}, recebeu ${sentToGroup.length}`
		);

		const welcomeInfo = sentToGroup.find(
			(m) => typeof m.content === "string" && m.content.includes("Olá, grupo!")
		);
		assert.ok(
			welcomeInfo,
			`Esperava mensagem botInfoMessage com links/instruções para novo grupo, recebeu: ${JSON.stringify(sentToGroup)}`
		);
		console.log("✓ Test 1 passed: botInfoMessage sent on new group join");
	}

	// Test 2: Existing group join should send existing group message
	{
		const bot = new FakeBot({ id: "ravenavip", phoneNumber: "555591535538" });
		const eventHandler = new EventHandler();

		const existingGroupId = `test_exist_${Date.now()}@g.us`;
		// Pre-populate group so getOrCreateGroup sets newGroup = false
		await eventHandler.getOrCreateGroup(existingGroupId, "Grupo Existente", "!");

		const eventData = {
			group: { id: existingGroupId, name: "Grupo Existente" },
			user: { id: "555591535538@s.whatsapp.net", name: "ravenavip" },
			responsavel: { id: "5511888888888@s.whatsapp.net", name: "Admin" },
			isBotJoining: true,
			origin: {
				getChat: async () => ({
					id: { _serialized: existingGroupId },
					name: "Grupo Existente",
					participants: []
				})
			}
		};

		await eventHandler.processGroupJoin(bot, eventData);

		const sentToGroup = bot.capturedMessages.filter((m) => m.chatId === existingGroupId);
		assert.ok(
			sentToGroup.length >= 1,
			`Esperava mensagem enviada para grupo existente ${existingGroupId}`
		);

		const welcomeExistente = sentToGroup.find(
			(m) =>
				typeof m.content === "string" &&
				(m.content.includes("Já estive aqui neste grupo antes") ||
					m.content.includes("Olá, grupo!"))
		);
		assert.ok(
			welcomeExistente,
			`Esperava mensagem botInfoMessage para grupo existente, recebeu: ${JSON.stringify(sentToGroup)}`
		);
		console.log("✓ Test 2 passed: botInfoMessage sent on existing group join");
	}

	// Test 3: Silent join should suppress messages
	{
		const bot = new FakeBot({ id: "ravenavip", phoneNumber: "555591535538" });
		bot.joinSilencioso = true;
		const eventHandler = new EventHandler();

		const silentGroupId = `test_silent_${Date.now()}@g.us`;
		const eventData = {
			group: { id: silentGroupId, name: "Grupo Silencioso" },
			user: { id: "555591535538@s.whatsapp.net", name: "ravenavip" },
			responsavel: { id: "5511888888888@s.whatsapp.net", name: "Admin" },
			isBotJoining: true,
			origin: {
				getChat: async () => ({
					id: { _serialized: silentGroupId },
					name: "Grupo Silencioso",
					participants: []
				})
			}
		};

		await eventHandler.processGroupJoin(bot, eventData);

		const sentToGroup = bot.capturedMessages.filter((m) => m.chatId === silentGroupId);
		assert.strictEqual(
			sentToGroup.length,
			0,
			`Nenhuma mensagem deveria ter sido enviada em join silencioso para ${silentGroupId}`
		);
		console.log("✓ Test 3 passed: messages suppressed on silent join");
	}

	console.log("All group join welcome tests passed!");
	process.exit(0);
}

main().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
