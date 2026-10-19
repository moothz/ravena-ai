process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const AdminUtils = require("../utils/AdminUtils");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const CommandHandler = require("../CommandHandler");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== INICIANDO TESTES: DOADOR PV, WHITELIST, CROSS-BOT E G-PAINEL ===");

	const database = Database.getInstance();
	database.testMode = true;

	// Configurar stubs/mocks no banco
	const dummyDonors = [
		{ nome: "Pedro", valor: 50, numero: "554784023920" }, // 12 dígitos (sem 9)
		{ nome: "Rosy", valor: 100, numero: "5513991946210" } // 13 dígitos (com 9)
	];

	database.coreRepo.getDonorByNumberSync = (numero) => {
		const PhoneUtils = require("../utils/PhoneUtils");
		const clean = PhoneUtils.cleanPhone(numero);
		for (const d of dummyDonors) {
			const donorClean = PhoneUtils.cleanPhone(d.numero);
			if (PhoneUtils.isSamePhone(donorClean, clean) || donorClean === clean) {
				return d;
			}
		}
		return null;
	};

	// 1. TESTE: WhatsAppBotGo.notInWhitelist
	console.log("\n--- Teste 1: WhatsAppBotGo.notInWhitelist ---");
	{
		const botGo = new WhatsAppBotGo({
			id: "ravenavip",
			name: "Ravena VIP",
			whatsgoApiUrl: "http://localhost:8080",
			whatsgoApiKey: "test-key",
			instanceName: "ravenavip",
			webhookHost: "http://localhost:3000",
			whitelist: ["554784023920"] // cadastrado sem o 9
		});
		botGo.database = database;

		// Checa com 12 dígitos
		assert.strictEqual(
			botGo.notInWhitelist("554784023920@s.whatsapp.net"),
			false,
			"Deveria estar na whitelist (12 dígitos exatos)"
		);

		// Checa com 13 dígitos (com o nono dígito adicionado pelo WhatsApp)
		assert.strictEqual(
			botGo.notInWhitelist("5547984023920@s.whatsapp.net"),
			false,
			"Deveria estar na whitelist (13 dígitos variante do 12)"
		);

		// Checa doador que só está no banco (Rosy, 5513991946210) mas não estava na whitelist inicial
		assert.strictEqual(
			botGo.notInWhitelist("5513991946210@s.whatsapp.net"),
			false,
			"Deveria estar na whitelist via fallback dinâmico do banco (13 dígitos)"
		);

		// Checa variante sem 9 da Rosy (551391946210)
		assert.strictEqual(
			botGo.notInWhitelist("551391946210@s.whatsapp.net"),
			false,
			"Deveria estar na whitelist via fallback do banco (12 dígitos)"
		);

		// Checa com LID mapeado no cache
		botGo.lidToPnCache.set("123456789012345", "554784023920");
		assert.strictEqual(
			botGo.notInWhitelist("123456789012345@lid"),
			false,
			"Deveria resolver LID para número doador e aceitar na whitelist"
		);

		// Usuário aleatório não deve estar na whitelist
		assert.strictEqual(
			botGo.notInWhitelist("5511999998888@s.whatsapp.net"),
			true,
			"Não-doador deve retornar notInWhitelist = true"
		);
		console.log("✓ WhatsAppBotGo.notInWhitelist passou em todos os cenários!");
	}

	// 2. TESTE: AdminUtils - PhoneUtils 12 vs 13 dígitos e Cross-Bot
	console.log("\n--- Teste 2: AdminUtils (Variantes e Cross-Bot) ---");
	{
		const adminUtils = AdminUtils.getInstance();

		// Cenário A: group.addedBy com 12 dígitos vs usuário com 13 dígitos
		const groupA = {
			id: "12345-67890@g.us",
			name: "Grupo Teste A",
			addedBy: "554784023920"
		};
		const isOwner13 = adminUtils.isGroupOwner("5547984023920", groupA);
		assert.strictEqual(
			isOwner13,
			true,
			"isGroupOwner deve reconhecer equivalência 12 vs 13 dígitos"
		);

		// Cenário B: additionalAdmins com 13 dígitos vs usuário com 12 dígitos
		const groupB = {
			id: "12345-67891@g.us",
			name: "Grupo Teste B",
			additionalAdmins: ["5513991946210"]
		};
		const isAdminB = await adminUtils.isAdmin("551391946210", groupB, null);
		assert.strictEqual(
			isAdminB,
			true,
			"isAdmin deve reconhecer additionalAdmins com equivalência 12 vs 13"
		);

		// Cenário C: Cross-Bot
		// Bot 1 (ravenavip) não está no grupo (chatInstance retorna null ou notInGroup)
		const bot1 = new FakeBot({ id: "ravenavip", name: "Ravena VIP" });
		bot1.client.getChatById = async () => null;

		// Bot 2 (ravena1) está no grupo e o usuário é admin
		const bot2 = new FakeBot({ id: "ravena1", name: "Ravena 1" });
		bot2.isParticipating = (groupId) => groupId === "grupo-cross@g.us";
		bot2.client.getChatById = async (groupId) => {
			if (groupId === "grupo-cross@g.us") {
				return {
					id: "grupo-cross@g.us",
					isGroup: true,
					participants: [
						{ id: "554784023920@s.whatsapp.net", isAdmin: true },
						{ id: "5511000000000@s.whatsapp.net", isAdmin: false }
					]
				};
			}
			return null;
		};

		database.botInstances = [bot1, bot2];
		database.getActiveBotIdForGroup = async (groupId) => {
			if (groupId === "grupo-cross@g.us") return "ravena1";
			return null;
		};

		const groupCross = {
			id: "grupo-cross@g.us",
			name: "Grupo Cross Bot"
		};

		// Usuário com 13 dígitos consulta através do bot1 (ravenavip)
		const isCrossAdmin = await adminUtils.isAdmin("5547984023920@s.whatsapp.net", groupCross, bot1);
		assert.strictEqual(
			isCrossAdmin,
			true,
			"Bot 1 deve validar admin via Bot 2 (Cross-Bot) com equivalência 12 vs 13"
		);

		console.log("✓ AdminUtils (Variantes e Cross-Bot) passou em todos os cenários!");
	}

	// 3. TESTE: CommandHandler - !g-manage no PV com nome composto
	console.log("\n--- Teste 3: CommandHandler (!g-manage com nome com espaços no PV) ---");
	{
		const bot = new FakeBot({ id: "ravenavip", name: "Ravena VIP" });
		const eventHandler = new EventHandler();
		const commandHandler = new CommandHandler();

		// Mock de grupos no banco
		const groupObj = {
			id: "grupo-composto@g.us",
			name: "Família & Amigos 2026",
			addedBy: "554784023920"
		};
		database.getGroup = async (id) => (id === "grupo-composto@g.us" ? groupObj : null);
		database.getGroups = async () => [groupObj];
		database.getAllGroups = async () => [groupObj];

		// Mensagem no PV para gerenciar grupo com nome composto
		const msg = createMessage({
			content: "!g-manage Família & Amigos 2026",
			group: null, // PV
			author: "5547984023920@s.whatsapp.net"
		});

		bot.resetCapture();
		await commandHandler.processCommand(
			bot,
			msg,
			"g-manage",
			["Família", "&", "Amigos", "2026"],
			null
		);

		const reply = bot.capturedMessages[0]?.content || "";
		assert.ok(
			reply.includes("gerenciando o grupo") && reply.includes("Família & Amigos 2026"),
			`Deveria ter iniciado gerenciamento do grupo com espaços. Resposta: ${reply}`
		);

		// Verifica que a chave foi salva de forma normalizada
		const PhoneUtils = require("../utils/PhoneUtils");
		const cleanUser = PhoneUtils.cleanPhone("5547984023920");
		assert.strictEqual(
			commandHandler.privateManagement[cleanUser],
			"grupo-composto@g.us",
			"Chave do privateManagement deve ser gravada com cleanPhone"
		);

		console.log("✓ !g-manage com nome composto no PV funcionou com sucesso!");
	}

	// 4. TESTE: Management - !g-painel no grupo e no PV
	console.log("\n--- Teste 4: !g-painel no grupo e no PV ---");
	{
		const bot = new FakeBot({ id: "ravenavip", name: "Ravena VIP" });
		const commandHandler = new CommandHandler();

		const painelGroup = {
			id: "grupo-painel@g.us",
			name: "Grupo Painel Teste",
			addedBy: "554784023920"
		};

		database.getGroup = async (id) => (id === painelGroup.id ? painelGroup : null);
		database.getGroups = async () => [painelGroup];
		database.getAllGroups = async () => [painelGroup];

		// 4A: No grupo -> deve enviar confirmação no grupo E link no PV
		const msgGroup = createMessage({
			content: "!g-painel",
			group: "grupo-painel@g.us",
			author: "5547984023920@s.whatsapp.net"
		});

		bot.resetCapture();
		await commandHandler.processCommand(bot, msgGroup, "g-painel", [], painelGroup);

		// Deve conter mensagem para o grupo avisando que foi enviado no privado
		const groupReplies = bot.capturedMessages.filter((m) => m.chatId === "grupo-painel@g.us");
		const pvReplies = bot.capturedMessages.filter(
			(m) => m.chatId === "5547984023920@s.whatsapp.net"
		);

		assert.ok(
			groupReplies.some((m) => m.content.includes("enviado no seu chat privado")),
			"Deve enviar confirmação amigável no grupo"
		);
		assert.ok(
			pvReplies.some((m) => m.content.includes("Link para gerenciamento do grupo")),
			"Deve enviar o link do painel no PV do admin"
		);

		// 4B: No PV sem argumentos -> auto-seleciona se tiver 1 grupo administrado
		const msgPV = createMessage({
			content: "!g-painel",
			group: null,
			author: "5547984023920@s.whatsapp.net"
		});

		bot.resetCapture();
		await commandHandler.processCommand(bot, msgPV, "g-painel", [], null);

		const pvAutoReply = bot.capturedMessages.find((m) =>
			m.content.includes("Link para gerenciamento do grupo")
		);
		assert.ok(
			pvAutoReply,
			"No PV sem args com 1 único grupo administrado, deve auto-selecionar e gerar o painel"
		);

		console.log("✓ !g-painel no grupo e no PV passou em todos os testes!");
	}

	console.log("\n========================================================");
	console.log(" TODOS OS TESTES PASSARAM COM SUCESSO!");
	console.log("========================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Falha no teste:", err);
		process.exit(1);
	});
