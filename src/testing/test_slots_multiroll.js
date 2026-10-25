process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const Database = require("../utils/Database");
const SlotsGame = require("../functions/SlotsGame");

async function runTests() {
	console.log("=== Iniciando Suíte de Testes: Slots QOL (Multi-Rolls & Formatação) ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	eventHandler.commandHandler.checkCooldown = async () => ({ inCooldown: false, timeLeft: 0 });

	const testUserId = "5511999990001@s.whatsapp.net";
	const testGroupId = "12036302@g.us";
	const db = Database.getInstance();

	async function waitForReply(maxMs = 10000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length > 0) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 100));
		}
		return bot.capturedMessages;
	}

	function prepareStep() {
		bot.resetCapture();
		if (eventHandler.commandHandler?.userDebounceMap) {
			eventHandler.commandHandler.userDebounceMap.clear();
		}
	}

	// Limpa dados prévios do usuário de teste
	await db.dbRun("slots", "DELETE FROM slots_users WHERE user_id = ?", ["5511999990001"]);
	await db.dbRun("slots", "DELETE FROM slots_history WHERE user_id = ?", [testUserId]);
	await db.dbRun("slots", "DELETE FROM slots_group_stats WHERE user_id = ?", [testUserId]);

	// Inicializa usuário com 5 moedas
	await SlotsGame.addCoins("5511999990001", 0);

	// ─── TESTE 1: Rolar 1 vez (Padrão) ──────────────────────────────────────────
	console.log("\n[Teste 1] Testando giro individual (!slots)...");
	prepareStep();
	const msg1 = createMessage({
		content: "!slots",
		group: testGroupId,
		author: testUserId,
		authorName: "Testador"
	});

	await eventHandler.processMessage(bot, msg1);
	await waitForReply();
	const response1 = bot.capturedMessages[0]?.content || "";
	console.log("Resposta do Teste 1:\n", response1);

	assert(response1.includes("🎰 *CAÇA-COISAS* 🎰"), "Deve conter o título do jogo");
	assert(
		response1.includes("| ❌") ||
			response1.includes("| ✅") ||
			response1.includes("| 🟡") ||
			response1.includes("| 💎"),
		"Deve exibir o status ❌, ✅, 🟡 ou 💎 ao lado dos rolos"
	);
	assert(response1.includes("girou e..."), "Em 1 giro deve usar 'girou e...'");
	assert(response1.includes("> 🪙 Moedinhas: 4/5"), "Deve ter consumido 1 moeda (4/5)");
	console.log("✓ Teste 1 passou!");

	// ─── TESTE 2: Rolar múltiplas vezes (!slots 4) ─────────────────────────────
	console.log("\n[Teste 2] Testando giro múltiplo (!slots 4)...");
	prepareStep();
	const msg2 = createMessage({
		content: "!slots 4",
		group: testGroupId,
		author: testUserId,
		authorName: "Testador"
	});

	await eventHandler.processMessage(bot, msg2);
	await waitForReply();
	const response2 = bot.capturedMessages[0]?.content || "";
	console.log("Resposta do Teste 2:\n", response2);

	const reelLines = response2.split("\n").filter((l) => l.startsWith("|  ["));
	assert.strictEqual(reelLines.length, 4, "Deve renderizar exatamente 4 linhas de rolos");
	assert(
		response2.includes("girou, girou, girou  e..."),
		"Em múltiplos giros deve usar 'girou, girou, girou  e...'"
	);
	assert(response2.includes("> 🪙 Moedinhas:"), "Deve exibir saldo de moedinhas");
	console.log("✓ Teste 2 passou!");

	// ─── TESTE 3: Moedas insuficientes (!slots 5 com saldo 0) ──────────────────
	console.log("\n[Teste 3] Testando erro de moedas insuficientes...");
	// Zera moedas
	await db.dbRun("slots", "UPDATE slots_users SET coins = 0 WHERE user_id = ?", ["5511999990001"]);
	prepareStep();
	const msg3 = createMessage({
		content: "!slots 5",
		group: testGroupId,
		author: testUserId,
		authorName: "Testador"
	});

	await eventHandler.processMessage(bot, msg3);
	await waitForReply();
	const response3 = bot.capturedMessages[0]?.content || "";
	console.log("Resposta do Teste 3:\n", response3);
	assert(
		response3.includes("não tem moedinhas suficientes"),
		"Deve avisar sobre moedinhas insuficientes"
	);
	console.log("✓ Teste 3 passou!");

	// ─── TESTE 4: Tentativa com saldo parcial (Tem 2 moedas, pede 5) ───────────
	console.log("\n[Teste 4] Testando pedido de 5 rodadas com apenas 2 moedas...");
	await db.dbRun("slots", "UPDATE slots_users SET coins = 2 WHERE user_id = ?", ["5511999990001"]);
	prepareStep();
	const msg4 = createMessage({
		content: "!slots 5",
		group: testGroupId,
		author: testUserId,
		authorName: "Testador"
	});

	await eventHandler.processMessage(bot, msg4);
	await waitForReply();
	const response4 = bot.capturedMessages[0]?.content || "";
	console.log("Resposta do Teste 4:\n", response4);
	assert(
		response4.includes("não tem moedinhas suficientes para girar *5x*"),
		"Deve avisar que não pode girar 5x com saldo menor"
	);
	assert(response4.includes("Suas moedinhas: *2/5*"), "Deve informar saldo atual");
	console.log("✓ Teste 4 passou!");

	// ─── TESTE 5: Limite máximo de 30 rodadas (!slots 50) ──────────────────────
	console.log("\n[Teste 5] Testando limite máximo de 30 rodadas (!slots 50)...");
	await db.dbRun("slots", "UPDATE slots_users SET coins = 50 WHERE user_id = ?", ["5511999990001"]);
	prepareStep();
	const msg5 = createMessage({
		content: "!slots 50",
		group: testGroupId,
		author: testUserId,
		authorName: "Testador"
	});

	await eventHandler.processMessage(bot, msg5);
	await waitForReply();
	const response5 = bot.capturedMessages[0]?.content || "";
	const reelLines5 = response5.split("\n").filter((l) => l.startsWith("|  ["));
	console.log(`Linhas de rolos geradas no Teste 5: ${reelLines5.length}`);
	assert.strictEqual(reelLines5.length, 30, "Deve limitar a exatamente 30 rolos");
	console.log("✓ Teste 5 passou!");

	// ─── TESTE 6: Argumento 'tudo' / 'max' ──────────────────────────────────────
	console.log("\n[Teste 6] Testando argumento '!slots tudo'...");
	await db.dbRun("slots", "UPDATE slots_users SET coins = 7 WHERE user_id = ?", ["5511999990001"]);
	prepareStep();
	const msg6 = createMessage({
		content: "!slots tudo",
		group: testGroupId,
		author: testUserId,
		authorName: "Testador"
	});

	await eventHandler.processMessage(bot, msg6);
	await waitForReply();
	const response6 = bot.capturedMessages[0]?.content || "";
	const reelLines6 = response6.split("\n").filter((l) => l.startsWith("|  ["));
	console.log(`Linhas de rolos geradas no Teste 6: ${reelLines6.length}`);
	assert.strictEqual(reelLines6.length, 7, "Deve girar todas as 7 moedas disponíveis");
	console.log("✓ Teste 6 passou!");

	// ─── TESTE 7: Quantidade inválida (!slots 0 ou !slots -3) ──────────────────
	console.log("\n[Teste 7] Testando argumento inválido (!slots 0)...");
	prepareStep();
	const msg7 = createMessage({
		content: "!slots 0",
		group: testGroupId,
		author: testUserId,
		authorName: "Testador"
	});

	await eventHandler.processMessage(bot, msg7);
	await waitForReply();
	const response7 = bot.capturedMessages[0]?.content || "";
	console.log("Resposta do Teste 7:\n", response7);
	assert(
		response7.includes("Quantidade inválida de rodadas"),
		"Deve avisar sobre quantidade inválida"
	);
	console.log("✓ Teste 7 passou!");

	// ─── TESTE 8: Validação de histórico e group_stats ─────────────────────────
	console.log("\n[Teste 8] Validando consistência no banco de dados...");
	const histCount = await db.dbGet(
		"slots",
		"SELECT COUNT(*) as c FROM slots_history WHERE user_id = ?",
		[testUserId]
	);
	console.log(`Total de registros no histórico: ${histCount.c}`);
	// 1 (teste 1) + 4 (teste 2) + 30 (teste 5) + 7 (teste 6) = 42
	assert.strictEqual(histCount.c, 42, "Deve ter gravado 1 registro por giro no histórico");

	const groupStats = await db.dbGet(
		"slots",
		"SELECT total_plays, total_wins FROM slots_group_stats WHERE user_id = ? AND group_id = ?",
		[testUserId, testGroupId]
	);
	console.log("Group stats:", groupStats);
	assert.strictEqual(groupStats.total_plays, 42, "Total de jogadas no grupo deve ser 42");
	console.log("✓ Teste 8 passou!");

	// ─── TESTE 9: Vitória individual (Exibe '✅' e prêmio) ─────────────────────
	console.log("\n[Teste 9] Testando vitória com '✅' e mensagem de vitória...");
	await db.dbRun("slots", "UPDATE slots_users SET coins = 5 WHERE user_id = ?", ["5511999990001"]);
	const originalRandom = Math.random;
	try {
		// Mock para forçar vitória (0, 0, 0)
		Math.random = () => 0.05;
		prepareStep();
		const msg9 = createMessage({
			content: "!slots",
			group: testGroupId,
			author: testUserId,
			authorName: "Testador"
		});

		await eventHandler.processMessage(bot, msg9);
		await waitForReply();
		const response9 = bot.capturedMessages[0]?.content || "";
		console.log("Resposta do Teste 9:\n", response9);

		assert(response9.includes("| ✅"), "Linha vencedora deve exibir ✅");
		assert(!response9.includes("| ❌"), "Linha vencedora não deve exibir ❌");
		assert(response9.includes("🎊"), "Deve conter emoji de celebração da vitória");
		assert(response9.includes("🎁"), "Deve exibir o prêmio recebido");
		console.log("✓ Teste 9 passou!");
	} finally {
		Math.random = originalRandom;
	}

	// ─── TESTE 10: Multi-Roll com vitórias parciais ────────────────────────────
	console.log("\n[Teste 10] Testando multi-roll com vitórias parciais (linhas com ✅ e ❌)...");
	await db.dbRun("slots", "UPDATE slots_users SET coins = 5 WHERE user_id = ?", ["5511999990001"]);
	try {
		let callCount = 0;
		Math.random = () => {
			callCount++;
			// Rodada 1: roll1=0, roll2=0, roll3=0 (Win)
			if (callCount <= 3) return 0.05;
			// Rodada 2: roll1=0, roll2=5, roll3=8 (Lose)
			if (callCount === 4) return 0.05;
			if (callCount === 5) return 0.55;
			if (callCount === 6) return 0.85;
			// Vitória/Prêmio
			return 0.1;
		};

		prepareStep();
		const msg10 = createMessage({
			content: "!slots 2",
			group: testGroupId,
			author: testUserId,
			authorName: "Testador"
		});

		await eventHandler.processMessage(bot, msg10);
		await waitForReply();
		const response10 = bot.capturedMessages[0]?.content || "";
		console.log("Resposta do Teste 10:\n", response10);

		assert(response10.includes("| ✅"), "Deve conter linha com ✅");
		assert(response10.includes("| ❌"), "Deve conter linha com ❌");
		assert(response10.includes("🎊"), "Deve comemorar com mensagem de vitória");
		console.log("✓ Teste 10 passou!");
	} finally {
		Math.random = originalRandom;
	}

	// Limpeza do usuário de teste
	await db.dbRun("slots", "DELETE FROM slots_users WHERE user_id = ?", ["5511999990001"]);
	await db.dbRun("slots", "DELETE FROM slots_history WHERE user_id = ?", [testUserId]);
	await db.dbRun("slots", "DELETE FROM slots_group_stats WHERE user_id = ?", [testUserId]);

	console.log("\n=== Todos os 10 testes passaram com sucesso! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
