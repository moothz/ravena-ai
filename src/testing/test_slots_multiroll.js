process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const Database = require("../utils/Database");
const SlotsGame = require("../functions/SlotsGame");
const GameEventService = require("../services/GameEventService");

// Em testMode as escritas passam pelo Database.dbRun(), que é bloqueado de propósito.
// Por isso o seed usa Database.mappers.run() (as leituras continuam liberadas) e as
// asserções ficam na resposta do comando, não no que o comando tentou gravar no banco.
function seedUser(db, userId, coins) {
	db.mappers.run(
		"slots",
		`INSERT OR REPLACE INTO slots_users (user_id, user_name, total_plays, total_wins, coins, last_coin_regen)
         VALUES (?, ?, 0, 0, ?, ?)`,
		[userId, "Testador", coins, Date.now()]
	);
}

function cleanUser(db, userId, groupId) {
	db.mappers.run("slots", "DELETE FROM slots_users WHERE user_id = ?", [userId]);
	db.mappers.run("slots", "DELETE FROM slots_history WHERE user_id = ?", [userId]);
	db.mappers.run("slots", "DELETE FROM slots_prizes WHERE user_id = ?", [userId]);
	db.mappers.run("slots", "DELETE FROM slots_group_stats WHERE user_id = ?", [userId]);
	db.mappers.run("slots", "DELETE FROM slots_group_stats WHERE group_id = ?", [groupId]);
}

function reelLines(content) {
	return content.split("\n").filter((line) => line.startsWith("|  ["));
}

function reelMarks(content) {
	return reelLines(content).map((line) => line.split("|").pop().trim());
}

async function runTests() {
	console.log("=== Iniciando Suíte de Testes: Slots QOL (Multi-Rolls & Formatação) ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	eventHandler.commandHandler.checkCooldown = async () => ({ inCooldown: false, timeLeft: 0 });

	// Sem isso um evento global ativo mudaria as chances do caça-coisas e consumiria
	// chamadas extras de Math.random, quebrando os mocks determinísticos abaixo.
	GameEventService.getMultiplier = () => 1.0;
	GameEventService.getEventBanner = () => "";

	const testUserId = "5511999990001@s.whatsapp.net";
	const testUserIdDigits = "5511999990001";
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

	function send(content) {
		return createMessage({
			content,
			group: testGroupId,
			author: testUserId,
			authorName: "Testador"
		});
	}

	cleanUser(db, testUserIdDigits, testGroupId);

	// Ciclo de 3 valores sempre diferentes: três chamadas consecutivas rendem sempre
	// três símbolos distintos, ou seja, todas as rodadas viram derrota.
	const lossCycle = [0.05, 0.15, 0.25];
	const originalRandom = Math.random;

	// ─── TESTE 1: Rolar 1 vez (Padrão) ──────────────────────────────────────────
	console.log("\n[Teste 1] Testando giro individual (!slots)...");
	seedUser(db, testUserIdDigits, 5);
	prepareStep();
	await eventHandler.processMessage(bot, send("!slots"));
	await waitForReply();
	const response1 = bot.capturedMessages[0]?.content || "";
	console.log("Resposta do Teste 1:\n", response1);

	assert(response1.includes("🎰 *CAÇA-COISAS* 🎰"), "Deve conter o título do jogo");
	assert(
		["❌", "✅", "🟡", "💎"].some((mark) => response1.includes(`| ${mark}`)),
		"Deve exibir o status ❌, ✅, 🟡 ou 💎 ao lado dos rolos"
	);
	assert(response1.includes("girou e..."), "Em 1 giro deve usar 'girou e...'");
	assert.strictEqual(reelLines(response1).length, 1, "Deve exibir exatamente 1 linha de rolo");
	console.log("✓ Teste 1 passou!");

	// ─── TESTE 2: Rolar múltiplas vezes (!slots 4) ─────────────────────────────
	console.log("\n[Teste 2] Testando giro múltiplo (!slots 4)...");
	seedUser(db, testUserIdDigits, 5);
	prepareStep();
	await eventHandler.processMessage(bot, send("!slots 4"));
	await waitForReply();
	const response2 = bot.capturedMessages[0]?.content || "";
	console.log("Resposta do Teste 2:\n", response2);

	assert.strictEqual(
		reelLines(response2).length,
		4,
		"Deve renderizar exatamente 4 linhas de rolos (cabem na exibição)"
	);
	assert(!response2.includes("E mais"), "Com poucos giros não deve resumir as linhas");
	assert(
		response2.includes("girou, girou, girou  e..."),
		"Em múltiplos giros deve usar 'girou, girou, girou  e...'"
	);
	assert(response2.includes("> 🪙 Moedinhas:"), "Deve exibir saldo de moedinhas");
	console.log("✓ Teste 2 passou!");

	// ─── TESTE 3: Sem moedas (saldo zerado) ────────────────────────────────────
	console.log("\n[Teste 3] Testando erro de moedas insuficientes...");
	seedUser(db, testUserIdDigits, 0);
	prepareStep();
	await eventHandler.processMessage(bot, send("!slots 5"));
	await waitForReply();
	const response3 = bot.capturedMessages[0]?.content || "";
	console.log("Resposta do Teste 3:\n", response3);
	assert(
		response3.includes("não tem moedinhas suficientes"),
		"Deve avisar sobre moedinhas insuficientes"
	);
	assert(response3.includes("Próxima moedinha em"), "Deve informar quando volta a ter moedinha");
	console.log("✓ Teste 3 passou!");

	// ─── TESTE 4: Tentativa com saldo parcial (Tem 2 moedas, pede 5) ───────────
	console.log("\n[Teste 4] Testando pedido de 5 rodadas com apenas 2 moedas...");
	seedUser(db, testUserIdDigits, 2);
	prepareStep();
	await eventHandler.processMessage(bot, send("!slots 5"));
	await waitForReply();
	const response4 = bot.capturedMessages[0]?.content || "";
	console.log("Resposta do Teste 4:\n", response4);
	assert(
		response4.includes("não tem moedinhas suficientes para girar *5x*"),
		"Deve avisar que não pode girar 5x com saldo menor"
	);
	assert(response4.includes("Suas moedinhas: *2/5*"), "Deve informar saldo atual");
	console.log("✓ Teste 4 passou!");

	// ─── TESTE 5: Limite de 500 rodadas por comando (!slots 600) ───────────────
	console.log("\n[Teste 5] Testando limite de 500 rodadas por comando (!slots 600)...");
	seedUser(db, testUserIdDigits, 600);
	prepareStep();
	let lossCounter = 0;
	try {
		Math.random = () => lossCycle[lossCounter++ % lossCycle.length];

		await eventHandler.processMessage(bot, send("!slots 600"));
		await waitForReply(30000);
		const response5 = bot.capturedMessages[0]?.content || "";
		console.log(`Primeiras linhas do Teste 5:\n${response5.split("\n").slice(0, 5).join("\n")}`);

		assert.strictEqual(
			SlotsGame.MAX_ROLLS_PER_COMMAND,
			500,
			"O limite por comando deve ser 500 giros"
		);
		assert(
			response5.includes("girou, girou, girou"),
			"Deve processar os giros em vez de recusar por quantidade"
		);
		assert.strictEqual(
			reelLines(response5).length,
			1,
			"Com todos os giros perdidos exibe apenas 1 linha de derrota"
		);
		assert(
			response5.includes("|  ❌ E mais 499... ❌  |"),
			"Deve resumir os 499 giros ocultos em 'E mais 499...'"
		);
		assert(
			response5.includes("> 🪙 Moedinhas: 100"),
			"Deve consumir 500 moedinhas (600 - 500), provando que girou 500 vezes"
		);
	} finally {
		Math.random = originalRandom;
	}
	console.log("✓ Teste 5 passou!");

	// ─── TESTE 6: Argumento 'tudo' / 'max' ──────────────────────────────────────
	console.log("\n[Teste 6] Testando argumento '!slots tudo'...");
	seedUser(db, testUserIdDigits, 7);
	prepareStep();
	let allLossCounter = 0;
	try {
		Math.random = () => lossCycle[allLossCounter++ % lossCycle.length];

		await eventHandler.processMessage(bot, send("!slots tudo"));
		await waitForReply(30000);
		const response6 = bot.capturedMessages[0]?.content || "";
		console.log(`Primeiras linhas do Teste 6:\n${response6.split("\n").slice(0, 4).join("\n")}`);

		assert(
			response6.includes("|  ❌ E mais 6... ❌  |"),
			"Deve girar as 7 moedas disponíveis e resumir as outras 6 derrotas"
		);
		assert(
			response6.includes("> 🪙 Moedinhas: 0"),
			"Deve consumir as 7 moedinhas do '!slots tudo'"
		);
	} finally {
		Math.random = originalRandom;
	}
	console.log("✓ Teste 6 passou!");

	// ─── TESTE 7: Quantidade inválida (!slots 0) ───────────────────────────────
	console.log("\n[Teste 7] Testando argumento inválido (!slots 0)...");
	seedUser(db, testUserIdDigits, 5);
	prepareStep();
	await eventHandler.processMessage(bot, send("!slots 0"));
	await waitForReply();
	const response7 = bot.capturedMessages[0]?.content || "";
	console.log("Resposta do Teste 7:\n", response7);
	assert(response7.includes("Quantidade inválida!"), "Deve avisar sobre quantidade inválida");
	assert(response7.includes("1 a 500"), "Deve citar o novo limite de 500 giros");
	console.log("✓ Teste 7 passou!");

	// ─── TESTE 8: Prêmios repetidos agrupados no resumo ────────────────────────
	console.log("\n[Teste 8] Testando agrupamento de prêmios repetidos no resumo...");
	seedUser(db, testUserIdDigits, 5);
	prepareStep();
	try {
		// 0.05 trava os três rolos em maçã (vitória) e cai sempre na faixa de lixo,
		// sorteando sempre o mesmo item: o resumo precisa agrupar pela contagem.
		Math.random = () => 0.05;

		await eventHandler.processMessage(bot, send("!slots 5"));
		await waitForReply(30000);
		const response8 = bot.capturedMessages[0]?.content || "";
		console.log("Resposta do Teste 8:\n", response8);

		assert.deepStrictEqual(
			reelMarks(response8),
			["✅", "✅", "✅", "✅", "✅"],
			"Deve exibir as 5 rodadas vencedoras"
		);
		assert(!response8.includes("| ❌"), "Sem derrotas não deve aparecer linha de derrota");
		assert(
			response8.includes("5x Meia furada"),
			"Deve agrupar os 5 itens de lixo repetidos em uma linha só com a contagem"
		);
	} finally {
		Math.random = originalRandom;
	}
	console.log("✓ Teste 8 passou!");

	// ─── TESTE 9: Vitória individual (Exibe '✅' e prêmio) ─────────────────────
	console.log("\n[Teste 9] Testando vitória com '✅' e mensagem de vitória...");
	seedUser(db, testUserIdDigits, 5);
	prepareStep();
	try {
		// Mock para forçar vitória (0, 0, 0)
		Math.random = () => 0.05;

		await eventHandler.processMessage(bot, send("!slots"));
		await waitForReply();
		const response9 = bot.capturedMessages[0]?.content || "";
		console.log("Resposta do Teste 9:\n", response9);

		assert(response9.includes("| ✅"), "Linha vencedora deve exibir ✅");
		assert(!response9.includes("| ❌"), "Não deve haver linha de derrota em um único giro");
		assert(response9.includes("🎊"), "Deve conter emoji de celebração da vitória");
		assert(response9.includes("🎁"), "Deve exibir o prêmio recebido");
	} finally {
		Math.random = originalRandom;
	}
	console.log("✓ Teste 9 passou!");

	// ─── TESTE 10: Ordem e truncamento do bloco de rolos (função de exibição) ───
	console.log("\n[Teste 10] Testando ordem 💎 > ✅ > 🟡 > ❌ e a linha 'E mais N...'...");
	const diamond = {
		emoji1: "💎",
		emoji2: "💎",
		emoji3: "💎",
		isWin: true,
		isPartial: false,
		isDiamond: true
	};
	const jackpot = {
		emoji1: "🍇",
		emoji2: "🍇",
		emoji3: "🍇",
		isWin: true,
		isPartial: false,
		isDiamond: false
	};
	const partial = {
		emoji1: "🍎",
		emoji2: "🥭",
		emoji3: "🍎",
		isWin: false,
		isPartial: true,
		isDiamond: false
	};
	const loss = {
		emoji1: "🍉",
		emoji2: "🍓",
		emoji3: "🍑",
		isWin: false,
		isPartial: false,
		isDiamond: false
	};

	const manyRolls = [
		diamond,
		jackpot,
		partial,
		partial,
		partial,
		...Array.from({ length: 7 }, () => loss)
	];
	const block = SlotsGame.buildRollsBlock(manyRolls);
	console.log("Bloco gerado no Teste 10:\n", block);

	assert(block.includes("🎰 *CAÇA-COISAS* 🎰"), "O bloco deve começar com o título do jogo");
	assert.deepStrictEqual(
		reelMarks(block),
		["💎", "✅", "🟡", "🟡", "🟡", "❌"],
		"Deve ordenar jackpot de diamantes, jackpot, parciais e por fim uma derrota"
	);
	assert(block.includes("|  ❌ E mais 6... ❌  |"), "Deve resumir as 6 derrotas restantes");

	const onlyLossesBlock = SlotsGame.buildRollsBlock(Array.from({ length: 6 }, () => loss));
	assert.deepStrictEqual(
		reelMarks(onlyLossesBlock),
		["❌"],
		"Deve manter ao menos uma derrota visível"
	);
	assert(onlyLossesBlock.includes("|  ❌ E mais 5... ❌  |"), "Deve resumir as outras 5 derrotas");

	const fewRollsBlock = SlotsGame.buildRollsBlock([jackpot, loss, loss]);
	assert.deepStrictEqual(
		reelMarks(fewRollsBlock),
		["✅", "❌", "❌"],
		"Com poucos giros deve mostrar todas as linhas, ainda assim ordenadas"
	);
	assert(!fewRollsBlock.includes("E mais"), "Com poucos giros não deve resumir nada");

	// Testando unificação de parciais a partir de 4 (🟡 x N)
	console.log("\n[Teste 10.1] Testando unificação de 4 parciais (🟡 x 4)...");
	const fourPartialsRolls = [
		diamond,
		jackpot,
		partial,
		partial,
		partial,
		partial,
		...Array.from({ length: 7 }, () => loss)
	];
	const fourPartialsBlock = SlotsGame.buildRollsBlock(fourPartialsRolls);
	console.log("Bloco gerado com 4 parciais:\n", fourPartialsBlock);
	assert.deepStrictEqual(
		reelMarks(fourPartialsBlock),
		["💎", "✅", "🟡 x 4", "❌"],
		"A partir de 4 parciais deve unificar em uma linha '🟡 x 4'"
	);
	assert(
		fourPartialsBlock.includes("|  ❌ E mais 6... ❌  |"),
		"Deve resumir as 6 derrotas restantes"
	);

	console.log("\n[Teste 10.2] Testando unificação de 15 parciais (🟡 x 15)...");
	const mangoPartial = {
		emoji1: "🥭",
		emoji2: "🍍",
		emoji3: "🥭",
		isWin: false,
		isPartial: true,
		isDiamond: false
	};
	const fifteenPartials = Array.from({ length: 15 }, () => mangoPartial);
	const fifteenBlock = SlotsGame.buildRollsBlock([
		...fifteenPartials,
		...Array.from({ length: 5 }, () => loss)
	]);
	console.log("Bloco gerado com 15 parciais:\n", fifteenBlock);
	assert.deepStrictEqual(
		reelMarks(fifteenBlock),
		["🟡 x 15", "❌"],
		"15 parciais devem unificar em uma única linha '🟡 x 15'"
	);
	assert(
		fifteenBlock.includes("|  [ 🥭 ] [ 🍍 ] [ 🥭 ]  | 🟡 x 15"),
		"Linha unificada deve conter a estrutura exata '|  [ 🥭 ] [ 🍍 ] [ 🥭 ]  | 🟡 x 15'"
	);
	assert(fifteenBlock.includes("|  ❌ E mais 4... ❌  |"), "Deve resumir as outras 4 derrotas");
	console.log("✓ Teste 10 passou!");

	cleanUser(db, testUserIdDigits, testGroupId);

	console.log("\n=== Todos os 10 testes passaram com sucesso! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
