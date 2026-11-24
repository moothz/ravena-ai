/**
 * Testes unitários para auto-update de status de banimento (Issue #43)
 * "Quando um bot banido==true receber eventos de mensagem, desmarcar que está banido no bots.json"
 */

const assert = require("assert");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const BotBanManager = require("../utils/BotBanManager");
const Database = require("../utils/Database");
const BotAPI = require("../BotAPI");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const EventHandler = require("../EventHandler");

async function runTests() {
	console.log("=== INICIANDO TESTES: Auto Update Ban Stats ===");

	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ravena-ban-test-"));
	const mockBotsJsonPath = path.join(tempDir, "bots.json");
	process.env.BOTS_JSON_PATH = mockBotsJsonPath;

	const initialBots = [
		{
			nome: "bot-alpha",
			nomeExibir: "Bot Alpha",
			numero: "5511999990001",
			banido: true,
			enabled: true
		},
		{
			nome: "bot-beta",
			nomeExibir: "Bot Beta",
			numero: "5511999990002",
			banido: true,
			enabled: false
		},
		{
			nome: "bot-gamma",
			nomeExibir: "Bot Gamma",
			numero: "5511999990003",
			banido: false,
			enabled: true
		}
	];

	await fs.writeFile(mockBotsJsonPath, JSON.stringify(initialBots, null, 2), "utf8");

	try {
		// 1. Testar unmarkBotBanned diretamente via BotBanManager
		console.log("\n1. Testando desmarcar banido diretamente via BotBanManager...");
		const mockBot = {
			id: "bot-alpha",
			instanceName: "bot-alpha",
			phoneNumber: "5511999990001",
			banido: true
		};

		const unbanned = await BotBanManager.unmarkBotBanned(mockBot);
		assert.strictEqual(unbanned, true, "Deve retornar true ao desmarcar banido");
		assert.strictEqual(mockBot.banido, false, "Propriedade banido no objeto deve ser false");

		// Verificar no arquivo
		const diskData1 = JSON.parse(await fs.readFile(mockBotsJsonPath, "utf8"));
		const botAlphaDisk = diskData1.find((b) => b.nome === "bot-alpha");
		assert.strictEqual(
			botAlphaDisk.banido,
			false,
			"bot-alpha deve estar com banido: false no bots.json"
		);

		// Repetir chamada para bot já desbanido
		const unbannedAgain = await BotBanManager.unmarkBotBanned(mockBot);
		assert.strictEqual(unbannedAgain, false, "Não deve alterar novamente se já está false");
		console.log("✓ BotBanManager atualizou em memória e no bots.json com sucesso!");

		// 2. Testar sincronização com instâncias no Database e BotAPI
		console.log("\n2. Testando sincronização de instâncias ativas do Database e BotAPI...");
		const db = Database.getInstance();
		const registeredBot = {
			id: "bot-beta",
			instanceName: "bot-beta",
			phoneNumber: "5511999990002",
			banido: true
		};
		db.botInstances = [registeredBot];

		let cemiterioInvalidated = false;
		const mockBotApi = {
			bots: [registeredBot],
			invalidateCemiterioCache: () => {
				cemiterioInvalidated = true;
			}
		};
		BotAPI.instance = mockBotApi;

		const unbanBeta = await BotBanManager.unmarkBotBanned("bot-beta");
		assert.strictEqual(unbanBeta, true, "Deve desmarcar bot-beta pelo ID");
		assert.strictEqual(
			registeredBot.banido,
			false,
			"registeredBot no Database/BotAPI deve estar banido: false"
		);
		assert.strictEqual(cemiterioInvalidated, true, "Deve invalidar cache do cemitério no BotAPI");

		const diskData2 = JSON.parse(await fs.readFile(mockBotsJsonPath, "utf8"));
		const botBetaDisk = diskData2.find((b) => b.nome === "bot-beta");
		assert.strictEqual(
			botBetaDisk.banido,
			false,
			"bot-beta deve estar com banido: false no bots.json"
		);
		console.log("✓ Instâncias ativas do Database e BotAPI sincronizadas com sucesso!");

		// 3. Testar recepção de evento de mensagem via WhatsAppBotGo._handleWebhook
		console.log(
			"\n3. Testando detecção no WhatsAppBotGo._handleWebhook ao receber evento 'Message'..."
		);
		// Resetar bot-alpha para banido: true no bots.json para o teste do bot
		diskData2[0].banido = true;
		await fs.writeFile(mockBotsJsonPath, JSON.stringify(diskData2, null, 2), "utf8");

		const botGo = new WhatsAppBotGo({
			id: "bot-alpha",
			goInstanceName: "bot-alpha",
			instanceName: "bot-alpha",
			whatsgoApiUrl: "http://localhost:8080",
			whatsgoApiKey: "test-key",
			webhookHost: "localhost",
			phoneNumber: "5511999990001",
			banido: true
		});
		botGo.isConnected = true;
		botGo._onInstanceConnected = () => {};
		botGo.apiClient = { get: async () => [], post: async () => ({}) };
		assert.strictEqual(botGo.banido, true, "botGo deve iniciar banido: true");

		let statusSent = null;
		const fakeRes = {
			status: () => fakeRes,
			send: () => {},
			sendStatus: (s) => {
				statusSent = s;
			}
		};

		const fakeReq = {
			body: {
				event: "Message",
				instance: "bot-alpha",
				data: {
					Info: {
						ID: "MSG_TEST_001",
						Chat: "120363000000000000@g.us",
						Sender: "5511988887777@s.whatsapp.net"
					},
					Message: {
						conversation: "Olá mundo"
					}
				}
			}
		};

		await botGo._handleWebhook(fakeReq, fakeRes);
		assert.strictEqual(statusSent, 200, "Webhook deve responder 200");
		assert.strictEqual(
			botGo.banido,
			false,
			"botGo.banido deve ser desmarcado imediatamente para false"
		);

		// Aguardar fila de persistência
		await BotBanManager._writeQueue;

		const diskData3 = JSON.parse(await fs.readFile(mockBotsJsonPath, "utf8"));
		const botAlphaDiskAfterWebhook = diskData3.find((b) => b.nome === "bot-alpha");
		assert.strictEqual(
			botAlphaDiskAfterWebhook.banido,
			false,
			"bot-alpha no bots.json deve ser banido: false"
		);
		console.log(
			"✓ WhatsAppBotGo._handleWebhook desmarcou banido com sucesso ao receber evento Message!"
		);

		// 4. Testar recepção via EventHandler.onMessage e onReaction
		console.log("\n4. Testando EventHandler.onMessage e onReaction...");
		// Resetar bot-alpha para banido: true
		diskData3[0].banido = true;
		await fs.writeFile(mockBotsJsonPath, JSON.stringify(diskData3, null, 2), "utf8");

		const eventHandler = new EventHandler({
			database: db
		});

		const testBotOnMessage = {
			id: "bot-alpha",
			instanceName: "bot-alpha",
			phoneNumber: "5511999990001",
			banido: true
		};

		eventHandler.onMessage(testBotOnMessage, {
			id: "msg_ev_1",
			group: "120363000000000000@g.us",
			author: "5511988887777@s.whatsapp.net",
			body: "!ping"
		});

		assert.strictEqual(
			testBotOnMessage.banido,
			false,
			"testBotOnMessage.banido deve ser false imediatamente"
		);
		await BotBanManager._writeQueue;

		const diskData4 = JSON.parse(await fs.readFile(mockBotsJsonPath, "utf8"));
		assert.strictEqual(diskData4[0].banido, false, "bots.json atualizado via onMessage");

		// Teste com onReaction
		diskData4[0].banido = true;
		await fs.writeFile(mockBotsJsonPath, JSON.stringify(diskData4, null, 2), "utf8");
		testBotOnMessage.banido = true;

		eventHandler.onReaction(testBotOnMessage, {
			reaction: "❤️",
			chatId: "120363000000000000@g.us",
			senderId: "5511988887777@s.whatsapp.net"
		});

		assert.strictEqual(
			testBotOnMessage.banido,
			false,
			"testBotOnMessage.banido deve ser false via onReaction"
		);
		await BotBanManager._writeQueue;

		const diskData5 = JSON.parse(await fs.readFile(mockBotsJsonPath, "utf8"));
		assert.strictEqual(diskData5[0].banido, false, "bots.json atualizado via onReaction");
		console.log("✓ EventHandler.onMessage e onReaction desmarcaram banido com sucesso!");

		// 5. Testar concorrência
		console.log("\n5. Testando concorrência de múltiplos bots desmarcando simultaneamente...");
		const freshBots = [
			{ nome: "bot-c1", numero: "5511911110001", banido: true },
			{ nome: "bot-c2", numero: "5511911110002", banido: true },
			{ nome: "bot-c3", numero: "5511911110003", banido: true },
			{ nome: "bot-c4", numero: "5511911110004", banido: true }
		];
		await fs.writeFile(mockBotsJsonPath, JSON.stringify(freshBots, null, 2), "utf8");

		const promises = freshBots.map((b) =>
			BotBanManager.unmarkBotBanned({ id: b.nome, phoneNumber: b.numero, banido: true })
		);
		const results = await Promise.all(promises);

		assert.ok(
			results.every((r) => r === true),
			"Todas as chamadas concorrentes devem retornar true"
		);

		const diskDataConcurrent = JSON.parse(await fs.readFile(mockBotsJsonPath, "utf8"));
		for (const b of diskDataConcurrent) {
			assert.strictEqual(
				b.banido,
				false,
				`Bot ${b.nome} deve ter sido desmarcado como banido: false`
			);
		}
		console.log("✓ Concorrência executada sequencialmente sem perdas ou corrupção!");

		console.log("\n=== TODOS OS TESTES PASSARAM COM 100% DE SUCESSO! ===");
		process.exit(0);
	} finally {
		delete process.env.BOTS_JSON_PATH;
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

runTests().catch((err) => {
	console.error("FALHA NOS TESTES:", err);
	process.exit(1);
});
