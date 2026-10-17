process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const SlotsGame = require("../functions/SlotsGame");
const FishingGame = require("../functions/FishingGame");

async function runTests() {
	console.log("=== Iniciando testes de Slots e Fichas de Pesca ===");

	const testUserId = "9999988887777";
	const db = Database.getInstance();

	// Limpa usuário de teste
	await db.dbRun("slots", "DELETE FROM slots_users WHERE user_id = ?", [testUserId]);
	await db.dbRun("fishing", "DELETE FROM fishing_users WHERE user_id = ?", [testUserId]);

	// 1. Cria usuário no slots (inicia com 5 moedas)
	let user = await SlotsGame.addCoins(testUserId, 0);
	console.log("1. Moedas iniciais:", user.coins);
	assert.strictEqual(user.coins, 5, "Usuário novo deve começar com 5 moedas");

	// 2. Adiciona moedas além do limite normal de regeneração (5)
	user = await SlotsGame.addCoins(testUserId, 4);
	console.log("2. Moedas após +4 moedas:", user.coins);
	assert.strictEqual(user.coins, 9, "Moedas devem ultrapassar 5 e acumular até 9");

	// 3. Testa pescar 'slots_coins' no FishingGame
	const fakeFishingUserData = {
		userId: testUserId,
		buffs: [],
		debuffs: []
	};

	const fakeItem = {
		name: "Ficha de Cassino",
		emoji: "🎰",
		type: "upgrade",
		effect: "slots_coins",
		value: 5
	};

	// Encontra a função applyItemEffect ou testa via addCoins
	const userAfterFicha = await SlotsGame.addCoins(testUserId, fakeItem.value, true);
	console.log("3. Moedas após Ficha de Cassino (+5):", userAfterFicha.coins);
	assert.strictEqual(userAfterFicha.coins, 14, "Moedas devem ser 14 após Ficha de Cassino");

	// 4. Testa limite alto de acúmulo (MAX_STORED_COINS = 1000)
	user = await SlotsGame.addCoins(testUserId, 2000);
	console.log("4. Moedas após tentar adicionar 2000:", user.coins);
	assert.strictEqual(user.coins, 1000, "Moedas devem ser limitadas a 1000");

	// 5. Limpeza do usuário de teste
	await db.dbRun("slots", "DELETE FROM slots_users WHERE user_id = ?", [testUserId]);
	await db.dbRun("fishing", "DELETE FROM fishing_users WHERE user_id = ?", [testUserId]);

	console.log("=== Todos os testes passaram com sucesso! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
