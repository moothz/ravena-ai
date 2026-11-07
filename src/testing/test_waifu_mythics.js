/**
 * test_waifu_mythics.js
 * Teste unitário para a integração de Personagens Míticos:
 * - Cálculos e bônus de slots em DonorBonusService
 * - Formatação de mensagem de doação
 * - Exibição no comando !doar-vantagens
 * - Comando informativo !mu-mitico
 * - Mensagens amigáveis de erro (divórcio, wishlist, cobiçar)
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const DonorBonusService = require("../services/DonorBonusService");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");

async function runTests() {
	console.log("=== INICIANDO TESTES DE PERSONAGENS MÍTICOS ===");

	// 1. Cálculos de Slots Míticos em DonorBonusService
	console.log("\n--- 1. Testando cálculos de slots em DonorBonusService ---");
	const b0 = DonorBonusService.calculateBonuses(0);
	assert.strictEqual(b0.mythicSlots, 0, "R$0 deve ter 0 slots");

	const b49 = DonorBonusService.calculateBonuses(49.99);
	assert.strictEqual(b49.mythicSlots, 0, "R$49.99 deve ter 0 slots");

	const b50 = DonorBonusService.calculateBonuses(50);
	assert.strictEqual(b50.mythicSlots, 1, "R$50 deve ter 1 slot mítico");

	const b99 = DonorBonusService.calculateBonuses(99);
	assert.strictEqual(b99.mythicSlots, 1, "R$99 deve ter 1 slot mítico");

	const b100 = DonorBonusService.calculateBonuses(100);
	assert.strictEqual(b100.mythicSlots, 2, "R$100 deve ter 2 slots míticos");

	const b500 = DonorBonusService.calculateBonuses(500);
	assert.strictEqual(b500.mythicSlots, 10, "R$500 deve ter 10 slots míticos");
	console.log("✓ DonorBonusService.calculateBonuses OK");

	// 2. Cálculo incremental (delta)
	console.log("\n--- 2. Testando cálculo incremental de slots ---");
	const inc1 = DonorBonusService.calculateIncrementalBonuses(40, 20);
	assert.strictEqual(inc1.deltaMythicSlots, 0, "De 20 para 40: 0 novos slots");

	const inc2 = DonorBonusService.calculateIncrementalBonuses(50, 40);
	assert.strictEqual(inc2.deltaMythicSlots, 1, "De 40 para 50: 1 novo slot");

	const inc3 = DonorBonusService.calculateIncrementalBonuses(120, 50);
	assert.strictEqual(inc3.deltaMythicSlots, 1, "De 50 para 120: 1 novo slot (120 tem 2, 50 tem 1)");
	console.log("✓ calculateIncrementalBonuses OK");

	// 3. Formatação da mensagem de bônus
	console.log("\n--- 3. Testando formatação de mensagem com slots míticos ---");
	const bonusMsg = DonorBonusService.formatBonusMessage({
		success: true,
		delta: {
			deltaAmount: 50,
			deltaBaits: 100,
			deltaCoins: 150,
			deltaRunas: 2500,
			deltaMythicSlots: 1
		}
	});
	assert.ok(bonusMsg.includes("Personagens Míticos:"), "Deve conter menção a Personagens Míticos");
	assert.ok(bonusMsg.includes("+1 slot liberado"), "Deve indicar +1 slot liberado");
	console.log("✓ formatBonusMessage OK");

	// 4. Testando comando !mu-mitico via FakeBot e EventHandler
	console.log("\n--- 4. Testando comando !mu-mitico ---");
	const bot = new FakeBot({ id: "teste", grupoLogs: null, dossieGroups: null });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	async function waitForReply(maxMs = 3000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length > 0) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 50));
		}
		return bot.capturedMessages;
	}

	bot.resetCapture();
	const msgMitico = createMessage({
		content: "!mu-mitico",
		group: "120363000000000000@g.us",
		author: "5511999999999@s.whatsapp.net"
	});
	await eventHandler.processMessage(bot, msgMitico);
	await waitForReply();
	const capturedMitico = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(capturedMitico, "Deve responder ao comando !mu-mitico");
	const textMitico = capturedMitico.content || capturedMitico.text;
	assert.ok(
		textMitico.includes("forjados exclusivamente pelo painel web"),
		"Deve instruir sobre painel web"
	);
	assert.ok(textMitico.includes("!mu-adm"), "Deve citar o comando !mu-adm");
	console.log("✓ !mu-mitico OK");

	// 5. Testando comando !doar-vantagens com regra de Personagens Míticos
	console.log("\n--- 5. Testando !doar-vantagens com Personagens Míticos ---");
	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap?.clear();
	const msgVantagens = createMessage({
		content: "!doar-vantagens",
		group: "120363000000000000@g.us",
		author: "5511999999999@s.whatsapp.net"
	});
	await eventHandler.processMessage(bot, msgVantagens);
	await waitForReply();
	const capturedVantagens = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(capturedVantagens, "Deve responder ao comando !doar-vantagens");
	const textVantagens = capturedVantagens.content || capturedVantagens.text;
	assert.ok(
		textVantagens.includes("Personagens Míticos"),
		"Deve listar Personagens Míticos nas regras gerais de waifus"
	);
	assert.ok(
		textVantagens.includes("1 slot mítico a cada R$ 50"),
		"Deve citar a regra de 1 slot a cada R$ 50"
	);
	console.log("✓ !doar-vantagens OK");

	// 6. Testando tratamento de erros de restrições em WaifuCommands (handleApiError)
	console.log("\n--- 6. Testando mensagens amigáveis de restrições ---");
	const errDivorce = {
		response: {
			data: {
				error: { code: "CANNOT_DIVORCE_MYTHIC" }
			}
		}
	};
	const retDivorce = WaifuCommands.handleApiError(errDivorce, "123@g.us", "Erro padrão");
	assert.ok(
		retDivorce.content.includes("laço sagrado e eterno"),
		"Deve retornar mensagem afetuosa de impossibilidade de divórcio"
	);

	const errWishlist = {
		response: {
			data: {
				error: { code: "CANNOT_WISHLIST_MYTHIC" }
			}
		}
	};
	const retWishlist = WaifuCommands.handleApiError(errWishlist, "123@g.us", "Erro padrão");
	assert.ok(
		retWishlist.content.includes("pertencem eternamente"),
		"Deve retornar mensagem de impossibilidade de wishlist"
	);

	const errCovet = {
		response: {
			data: {
				error: { code: "CANNOT_COVET_MYTHIC" }
			}
		}
	};
	const retCovet = WaifuCommands.handleApiError(errCovet, "123@g.us", "Erro padrão");
	assert.ok(
		retCovet.content.includes("não podem ser cobiçados"),
		"Deve retornar mensagem de impossibilidade de cobiçar"
	);
	console.log("✓ handleApiError restrições OK");

	console.log("\n=======================================================");
	console.log("🎉 TODOS OS TESTES DE PERSONAGENS MÍTICOS PASSARAM COM SUCESSO!");
	console.log("=======================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro no teste de Personagens Míticos:", err);
		process.exit(1);
	});
