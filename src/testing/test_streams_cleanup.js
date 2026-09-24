process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const SuperAdmin = require("../commands/SuperAdmin");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("--- Iniciando testes de streams-cleanup ---");

	const superAdmin = new SuperAdmin();

	// 1. Testa mapeamento do comando
	console.log("1. Testando registro do comando em commandMap...");
	assert.strictEqual(
		superAdmin.getCommandMethod("streams-cleanup"),
		"streamsCleanup",
		"O comando streams-cleanup deve mapear para streamsCleanup"
	);
	assert.strictEqual(
		superAdmin.getCommandMethod("streamsCleanup"),
		"streamsCleanup",
		"O comando streamsCleanup deve mapear para streamsCleanup"
	);
	console.log("✓ Mapeamento de comando validado com sucesso.");

	// 2. Mock de bot e permissão de superadmin
	const superAdminNumber = "5511999999999@s.whatsapp.net";
	superAdmin.isSuperAdmin = () => true;

	const fakeBot = new FakeBot({ id: "test-bot" });

	// Mock do StreamMonitor no bot
	const unsubscribed = [];
	fakeBot.streamMonitor = {
		sanitizePlatformChannelName(name, platform) {
			if (!name || typeof name !== "string") return "";
			return name.toLowerCase().replace(/[^a-z0-9_]/g, "");
		},
		async twitchChannelExists(name) {
			return name === "validotwitch";
		},
		async kickChannelExists(name) {
			return name === "validokick";
		},
		unsubscribe(name, platform) {
			unsubscribed.push({ name, platform });
		}
	};

	// Mock do banco de dados em memória para os testes
	const mockGroups = [
		{
			id: "120363001@g.us",
			name: "Grupo Ativo Válido",
			twitch: [{ channel: "validotwitch" }],
			kick: [{ channel: "validokick" }]
		},
		{
			id: "120363002@g.us",
			name: "Grupo Ativo com Canais Inexistentes",
			twitch: [{ channel: "inexistentetwitch" }],
			kick: [{ channel: "inexistentekick" }]
		},
		{
			id: "120363003@g.us",
			name: "Grupo Órfão Sem Bot",
			twitch: [{ channel: "canalorfaotwitch" }],
			kick: [{ channel: "canalorfaokick" }]
		}
	];

	superAdmin.database.getGroups = async () => mockGroups;
	superAdmin.database.saveGroup = async (g) => {
		const idx = mockGroups.findIndex((item) => item.id === g.id);
		if (idx !== -1) mockGroups[idx] = g;
	};

	// Mock do método getAllActiveBotGroupIds para simular que apenas o grupo 1 e 2 possuem bots
	superAdmin.getAllActiveBotGroupIds = async () => ({
		activeGroupIds: new Set(["120363001@g.us", "120363002@g.us"]),
		botSummary: ["FakeBot:test-bot (2 grupos)"]
	});

	// 3. Execução do comando streamsCleanup
	console.log("2. Executando streamsCleanup com cenários simulados...");
	const msg = createMessage({
		author: superAdminNumber,
		group: "120363001@g.us",
		content: "!sa-streams-cleanup"
	});

	const returnMessages = await superAdmin.streamsCleanup(fakeBot, msg, []);

	assert(Array.isArray(returnMessages), "Deve retornar um array de ReturnMessage");
	assert(returnMessages.length > 0, "Deve conter pelo menos o resumo no retorno");

	const fullReport = returnMessages.map((m) => m.content).join("\n");
	console.log("\n--- Relatório retornado:\n" + fullReport + "\n---------------------\n");

	// 4. Asserções nos grupos
	console.log("3. Verificando resultados aplicados aos grupos...");

	// Grupo 1: mantido intacto (bot presente e canais válidos)
	assert.strictEqual(mockGroups[0].twitch.length, 1, "Grupo 1 deve manter canal twitch");
	assert.strictEqual(mockGroups[0].twitch[0].channel, "validotwitch");
	assert.strictEqual(mockGroups[0].kick.length, 1, "Grupo 1 deve manter canal kick");
	assert.strictEqual(mockGroups[0].kick[0].channel, "validokick");

	// Grupo 2: canais inexistentes removidos (bot presente mas canais não existem)
	assert.strictEqual(
		mockGroups[1].twitch.length,
		0,
		"Grupo 2 deve ter canal twitch inexistente removido"
	);
	assert.strictEqual(
		mockGroups[1].kick.length,
		0,
		"Grupo 2 deve ter canal kick inexistente removido"
	);

	// Grupo 3: órfão, todos os canais removidos
	assert.strictEqual(mockGroups[2].twitch.length, 0, "Grupo 3 órfão deve ter twitch removido");
	assert.strictEqual(mockGroups[2].kick.length, 0, "Grupo 3 órfão deve ter kick removido");

	// 5. Asserções na desinscrição do StreamMonitor
	console.log("4. Verificando desinscrições no StreamMonitor...");
	assert(
		unsubscribed.some((u) => u.name === "inexistentetwitch" && u.platform === "twitch"),
		"Canal inexistente twitch deve ser desinscrito"
	);
	assert(
		unsubscribed.some((u) => u.name === "inexistentekick" && u.platform === "kick"),
		"Canal inexistente kick deve ser desinscrito"
	);
	assert(
		unsubscribed.some((u) => u.name === "canalorfaotwitch" && u.platform === "twitch"),
		"Canal órfão twitch deve ser desinscrito"
	);
	assert(
		unsubscribed.some((u) => u.name === "canalorfaokick" && u.platform === "kick"),
		"Canal órfão kick deve ser desinscrito"
	);

	console.log("✓ Todas as asserções passaram com perfeição!");
}

runTests()
	.then(() => {
		console.log("=== TESTES CONCLUÍDOS COM SUCESSO ===");
		process.exit(0);
	})
	.catch((err) => {
		console.error("FALHA NOS TESTES:", err);
		process.exit(1);
	});
