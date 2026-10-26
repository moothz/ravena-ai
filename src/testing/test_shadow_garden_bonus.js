const assert = require("assert");
const FakeBot = require("./FakeBot");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
const FishingGame = require("../functions/FishingGame");
const Database = require("../utils/Database");

async function runBonusTests() {
	console.log("=== INICIANDO TESTES DO SHADOW GARDEN BONUS SERVICE ===");
	const testBot = new FakeBot({ id: "test-bonus-bot" });
	const db = Database.getInstance();

	const testUser = "5511888889999@s.whatsapp.net";
	const cleanId = "5511888889999";

	// Limpa dados de teste
	try {
		db.mappers.run("core", "DELETE FROM farm_bonus_inventory WHERE user_id = ?", [cleanId]);
		db.mappers.run("core", "DELETE FROM farm_credited_crops WHERE user_id = ?", [cleanId]);
	} catch (e) {}

	// 1. Teste de resolução e despacho de bônus por plantId sem prefixo e sem bonusType explícito
	console.log("1. Testando colheita com plantId sem prefixo e sem bonusType...");
	const uData = await FishingGame.getUserData(cleanId);
	if (!uData) {
		await FishingGame.saveUserData({
			userId: cleanId,
			name: "Testador",
			baits: 5,
			lastBaitRegen: Date.now()
		});
	}
	const initialBaits = (await FishingGame.getUserData(cleanId))?.baits || 0;

	const msgs1 = await ShadowGardenBonusService.dispatchHarvestDrops(cleanId, [
		{
			plantId: "08_devouring_root_v2", // Sem crop_ e sem bonusType
			name: "Raiz Devoradora",
			count: 2
		}
	]);

	assert.strictEqual(msgs1.length, 1, "Deveria despachar 1 mensagem de bônus");
	assert.strictEqual(msgs1[0].includes("+10 iscas vivas"), true, "Deveria conceder 10 iscas (2x5)");

	const afterBaits = (await FishingGame.getUserData(cleanId))?.baits || 0;
	assert.strictEqual(afterBaits - initialBaits, 10, "Deveria ter adicionado exatamente 10 iscas");
	console.log("   ✓ Raiz Devoradora (plantId sem crop_) despachou 10 iscas com sucesso!");

	// 2. Teste de resolução de bônus com nome sufixado por '(Colhida)'
	console.log("2. Testando resolução por nome com sufixo (Colhida)...");
	const msgs2 = await ShadowGardenBonusService.dispatchHarvestDrops(cleanId, [
		{
			name: "Coração Púrpuro (Colhida)",
			count: 3
		}
	]);

	assert.strictEqual(msgs2.length, 1, "Deveria despachar 1 mensagem");
	assert.strictEqual(msgs2[0].includes("+6 rolls"), true, "Deveria conceder 6 rolls");

	const waifuBonus = await ShadowGardenBonusService.getWaifuBonus(cleanId, false);
	assert.strictEqual(
		waifuBonus.rolls >= 6,
		true,
		"Deveria ter acumulado pelo menos 6 rolls no inventário"
	);
	console.log("   ✓ Coração Púrpuro (Colhida) despachou 6 rolls com sucesso!");

	// 3. Teste de resolução numérica (ID da planta puro)
	console.log("3. Testando resolução por ID numérico (plantId: 8 e 11)...");
	const msgs3 = await ShadowGardenBonusService.dispatchHarvestDrops(cleanId, [
		{ plantId: 8, count: 1 },
		{ plantId: "11", count: 1 }
	]);
	assert.strictEqual(msgs3.length, 2, "Deveria despachar 2 mensagens para IDs numéricos 8 e 11");
	console.log("   ✓ IDs numéricos 8 e 11 mapeados com sucesso!");

	// 4. Teste de consumo de bônus de Waifus (Ticket vs Roll)
	console.log("4. Testando prioridade de consumo (Ticket primeiro)...");
	await ShadowGardenBonusService.addWaifuBonus(cleanId, { tickets: 1 });
	const bonusBeforeConsume = await ShadowGardenBonusService.getWaifuBonus(cleanId, false);
	assert.strictEqual(bonusBeforeConsume.tickets >= 1, true);

	const consumedTicket = await ShadowGardenBonusService.consumeWaifuBonus(cleanId);
	assert.strictEqual(consumedTicket.consumed, true);
	assert.strictEqual(consumedTicket.type, "ticket", "Deveria consumir o ticket antes dos rolls");

	const consumedRoll = await ShadowGardenBonusService.consumeWaifuBonus(cleanId);
	assert.strictEqual(consumedRoll.consumed, true);
	assert.strictEqual(consumedRoll.type, "roll", "Deveria consumir roll após esgotar tickets");
	console.log("   ✓ Prioridade de consumo testada com sucesso!");

	// 5. Teste de despacho de bônus de Cassino / Slots (Trevo de Obsidiana e Trevo Dourado)
	console.log("5. Testando despacho de bônus de Slots (Clover 9 e 10)...");
	const slotsDb = Database.getInstance();
	try {
		slotsDb.mappers.run("slots", "DELETE FROM slots_users WHERE user_id = ?", [cleanId]);
	} catch (e) {}

	const msgsSlots = await ShadowGardenBonusService.dispatchHarvestDrops(cleanId, [
		{ plantId: "crop_09_obsidian_clover", count: 2 },
		{ plantId: "crop_10_golden_clover", count: 1 }
	]);
	assert.strictEqual(msgsSlots.length, 2, "Deveria despachar 2 mensagens para bônus de slots");
	assert.strictEqual(
		msgsSlots[0].includes("+10 moedinhas"),
		true,
		"Deveria conceder 10 moedas de slots (2x5)"
	);
	assert.strictEqual(
		msgsSlots[1].includes("+25 moedas de ouro"),
		true,
		"Deveria conceder 25 moedas de ouro (1x25)"
	);

	const slotsUser = slotsDb.mappers.get(
		"slots",
		"SELECT coins FROM slots_users WHERE user_id = ?",
		[cleanId]
	);
	assert.strictEqual(
		slotsUser !== null && slotsUser.coins >= 35,
		true,
		"Deveria ter acumulado pelo menos 35 moedas no slots"
	);
	console.log("   ✓ Bônus de Slots creditado com sucesso sem erro de dependência circular!");

	console.log("\n==================================================================");
	console.log("🎉 TODOS OS TESTES ESPECÍFICOS DE BÔNUS PASSARAM COM SUCESSO!");
	console.log("==================================================================");
}

runBonusTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro nos testes de bônus:", err);
		process.exit(1);
	});
