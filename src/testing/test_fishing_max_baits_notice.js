"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const FishingGame = require("../functions/FishingGame");
const Database = require("../utils/Database");

async function cleanup(database, uids) {
	for (const uid of uids) {
		await database.dbRun("fishing", "DELETE FROM fishing_inventory WHERE user_id = ?", [uid]);
		await database.dbRun("fishing", "DELETE FROM fishing_users WHERE user_id = ?", [uid]);
		await database.dbRun("fishing", "DELETE FROM fishing_buffs WHERE user_id = ?", [uid]);
		await database.dbRun("fishing", "DELETE FROM fishing_group_stats WHERE user_id = ?", [uid]);
	}
}

async function insertPermanentBuff(database, userId, type, value, name) {
	await database.dbRun(
		"fishing",
		`INSERT INTO fishing_buffs (user_id, effect_type, is_debuff, value, min_value, max_value, remaining_uses, original_name)
		VALUES (?, ?, 0, ?, 0, 0, 999999, ?)`,
		[userId, type, value, name]
	);
}

async function main() {
	console.log("=== Iniciando teste de aviso de limite de iscas máximas em meus-pescados ===");

	const bot = new FakeBot({ id: "test-bot", testMode: false });
	const database = Database.getInstance();
	database.testMode = false;

	const userNormal = "5511999991111";
	const userMaxBaits = "5511999992222";
	const groupId = "120363000000000001@g.us";

	await cleanup(database, [userNormal, userMaxBaits]);

	const meusPescadosCmd = FishingGame.commands.find((c) => c.name === "meus-pescados");
	assert.ok(meusPescadosCmd, "Comando !meus-pescados deve estar registrado");

	// -------------------------------------------------------------
	// TESTE 1: Jogador com limite de iscas normal (abaixo do teto 300)
	// -------------------------------------------------------------
	console.log("\n[Teste 1] Jogador com capacidade de iscas normal...");

	await FishingGame.saveUserData({
		userId: userNormal,
		name: "PescadorNormal",
		baits: 5,
		lastBaitRegen: Date.now(),
		fishes: [],
		buffs: []
	});

	const msgNormal = createMessage({
		author: userNormal,
		group: groupId,
		content: "!meus-pescados"
	});

	const resNormal = await meusPescadosCmd.method(bot, msgNormal, [], { id: groupId });
	assert.ok(resNormal, "Deve retornar mensagem");
	console.log("Trecho normal:", resNormal.content.split("\n")[2]);

	assert.ok(resNormal.content.includes("🐛 *Iscas:* 5/5"), "Deve exibir iscas normais 5/5");
	assert.strictEqual(
		resNormal.content.includes("(iscas máximas no limite!)"),
		false,
		"Não deve exibir o aviso de limite quando maxBaits < 300"
	);
	console.log("✓ Teste 1 passou: sem aviso de limite para jogadores normais.");

	// -------------------------------------------------------------
	// TESTE 2: Jogador que atingiu o teto de 300 iscas
	// -------------------------------------------------------------
	console.log("\n[Teste 2] Jogador com capacidade de iscas no limite máximo (300)...");

	await FishingGame.saveUserData({
		userId: userMaxBaits,
		name: "PescadorMax",
		baits: 12,
		lastBaitRegen: Date.now(),
		fishes: [],
		buffs: []
	});
	await insertPermanentBuff(database, userMaxBaits, "max_baits", 350, "Caixa de Iscas Extrema");

	const userAfter = await FishingGame.getUserData(userMaxBaits);
	const calculatedMax = FishingGame.getMaxBaits(userAfter);
	assert.strictEqual(calculatedMax, 300, "Capacidade calculada deve ser exatamente 300");

	const msgMax = createMessage({
		author: userMaxBaits,
		group: groupId,
		content: "!meus-pescados"
	});

	const resMax = await meusPescadosCmd.method(bot, msgMax, [], { id: groupId });
	assert.ok(resMax, "Deve retornar mensagem");
	console.log("Trecho no limite:", resMax.content.split("\n")[2]);

	assert.ok(
		resMax.content.includes("🐛 *Iscas:* 12/300 (iscas máximas no limite!)"),
		"Deve exibir '🐛 *Iscas:* 12/300 (iscas máximas no limite!)'"
	);
	console.log("✓ Teste 2 passou: aviso de limite exibido corretamente ao lado das iscas.");

	await cleanup(database, [userNormal, userMaxBaits]);

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

main().catch((err) => {
	console.error("Erro durante o teste:", err);
	process.exit(1);
});
