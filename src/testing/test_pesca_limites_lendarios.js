process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

/**
 * Testes dos limites de itens de pesca (500 slots / 300 iscas com conversão em Runas),
 * do limite de iscas no !pesca-rede e do ritmo mensal dos lendários (redução + boost nos últimos 5 dias).
 *
 * Uso (dentro do container): node src/testing/test_pesca_limites_lendarios.js
 */

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Database = require("../utils/Database");
const FishingGame = require("../functions/FishingGame");
const { createMessage } = require("./FakeMessage");

const TEST_USER = "5511999997777";
const TEST_USER_JID = `${TEST_USER}@s.whatsapp.net`;
const TEST_TARGET = "5511999996666";
const TEST_GROUP = "120363000000000777@g.us";

async function cleanup(database) {
	for (const uid of [TEST_USER, TEST_USER_JID, TEST_TARGET]) {
		await database.dbRun("fishing", "DELETE FROM fishing_inventory WHERE user_id = ?", [uid]);
		await database.dbRun("fishing", "DELETE FROM fishing_users WHERE user_id = ?", [uid]);
		await database.dbRun("fishing", "DELETE FROM fishing_buffs WHERE user_id = ?", [uid]);
		await database.dbRun("fishing", "DELETE FROM fishing_group_stats WHERE user_id = ?", [uid]);
		await database.dbRun("bank", "DELETE FROM bank_transactions WHERE user_id = ?", [uid]);
		await database.dbRun("bank", "DELETE FROM bank_accounts WHERE user_id = ?", [uid]);
	}
}

async function insertUser(database, userId, baits) {
	await database.dbRun(
		"fishing",
		`INSERT OR REPLACE INTO fishing_users
		(user_id, name, baits, last_bait_regen, total_weight, inventory_weight, total_catches, total_baits_used, total_trash_caught, biggest_fish_json)
		VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, NULL)`,
		[userId, "PescadorLimites", baits, Date.now()]
	);
}

async function insertPermanentBuff(database, userId, type, value, name) {
	await database.dbRun(
		"fishing",
		`INSERT INTO fishing_buffs (user_id, effect_type, is_debuff, value, min_value, max_value, remaining_uses, original_name)
		VALUES (?, ?, 0, ?, 0, 0, 999999, ?)`,
		[userId, type, value, name]
	);
}

async function runTests() {
	console.log("--- Iniciando testes de limites de pesca e ritmo dos lendários ---");

	const bot = new FakeBot({ id: "teste-bot", grupoLogs: "123@g.us", testMode: true });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.loadAllCommands();
	eventHandler.commandHandler.cmdDebounceTime = 0;
	const database = Database.getInstance();
	database.testMode = false;
	const BankService = require("../services/BankService");

	const originalChances = FishingGame.RARE_FISH.map((f) => f.chance);
	await cleanup(database);

	try {
		// -------------------------------------------------------------
		// 1. Valores de conversão em Runas (calibrados pela Carteira Furada)
		// -------------------------------------------------------------
		const runasTable = FishingGame.CAP_OVERFLOW_RUNAS;
		assert.strictEqual(runasTable["Bolso de Pesca"], 450);
		assert.strictEqual(runasTable["Calça de Pesca"], 900);
		assert.strictEqual(runasTable["Mochilão"], 36650);
		assert.strictEqual(runasTable["Pochete de Iscas"], 650);
		assert.strictEqual(runasTable["Caixa de Iscas"], 1300);
		assert.strictEqual(runasTable["Viveiro Portátil"], 7350);
		assert.strictEqual(runasTable["Pacote de Iscas"], 100);
		console.log("✓ Teste 1 passou: tabela de conversão em Runas calculada.");

		// -------------------------------------------------------------
		// 2. getMaxInventory / getMaxBaits respeitam os tetos
		// -------------------------------------------------------------
		const fakeUser = {
			buffs: [
				{ type: "inventory_slot", value: 9000, remainingUses: 999999 },
				{ type: "max_baits", value: 9000, remainingUses: 999999 }
			]
		};
		assert.strictEqual(FishingGame.getMaxInventory(fakeUser), FishingGame.INVENTORY_HARD_CAP);
		assert.strictEqual(FishingGame.getMaxBaits(fakeUser), FishingGame.BAITS_HARD_CAP);
		console.log("✓ Teste 2 passou: capacidades limitadas a 500 slots e 300 iscas.");

		// -------------------------------------------------------------
		// 3. addBuff de slot no teto vira Runas (valor conservador para fontes externas)
		// -------------------------------------------------------------
		await insertUser(database, TEST_USER, 10);
		await insertPermanentBuff(database, TEST_USER, "inventory_slot", 489, "Bolso de Pesca");
		const bankBefore = (await BankService.getAccount(TEST_USER))?.runas || 0;
		const grant = await FishingGame.addBuff(
			TEST_USER,
			{ type: "inventory_slot", value: 4, remainingUses: 999999, originalName: "Mochilão" },
			false
		);
		assert.strictEqual(grant.applied, 1, "Só 1 slot cabia antes do teto");
		assert.strictEqual(grant.overflow, 3);
		assert.strictEqual(grant.runas, 3 * 450, "Fonte externa converte pelo valor por slot do Bolso");
		const bankAfter = (await BankService.getAccount(TEST_USER))?.runas || 0;
		assert.strictEqual(bankAfter - bankBefore, 1350, "Runas creditadas no RavenaBank");
		const userAfter = await FishingGame.getUserData(TEST_USER);
		assert.strictEqual(FishingGame.getMaxInventory(userAfter), 500);
		console.log("✓ Teste 3 passou: excedente de slots convertido em Runas.");

		// -------------------------------------------------------------
		// 4. Item pescado no teto usa o valor do próprio item
		// -------------------------------------------------------------
		const mochilaoItem = {
			...FishingGame.UPGRADES.find((u) => u.name === "Mochilão"),
			type: "upgrade"
		};
		const fx = await FishingGame.applyItemEffect(userAfter, mochilaoItem);
		assert.strictEqual(mochilaoItem.convertedRunas, 36650);
		assert.ok(fx.effectMessage.includes("36.650"), fx.effectMessage);
		console.log("✓ Teste 4 passou: Mochilão pescado no teto vira 36.650 ᚱ.");

		// -------------------------------------------------------------
		// 5. Iscas: teto de 300 com conversão do excedente
		// -------------------------------------------------------------
		await insertUser(database, TEST_USER, 298);
		const baitRes = await FishingGame.addBaits(TEST_USER, 10);
		assert.strictEqual(baitRes.added, 2);
		assert.strictEqual(baitRes.overflow, 8);
		assert.strictEqual(baitRes.runas, 8 * 50);
		assert.strictEqual(baitRes.userData.baits, 300);

		const pacote = { ...FishingGame.UPGRADES.find((u) => u.name === "Pacote de Iscas") };
		pacote.type = "upgrade";
		pacote.value = 3;
		const fullUser = await FishingGame.getUserData(TEST_USER);
		const pacoteFx = await FishingGame.applyItemEffect(fullUser, pacote);
		assert.strictEqual(pacoteFx.userData.baits, 300);
		assert.strictEqual(pacote.convertedRunas, 150);
		console.log("✓ Teste 5 passou: iscas acima de 300 convertidas em Runas.");

		// -------------------------------------------------------------
		// 6. Compra de iscas no RavenaBank respeita o teto
		// -------------------------------------------------------------
		await assert.rejects(() => BankService.buyFishingBaits(TEST_USER, 5), /Limite de iscas/);
		console.log("✓ Teste 6 passou: RavenaBank não vende iscas acima do teto.");

		// -------------------------------------------------------------
		// 7. Mercado: transferência bloqueada se o destinatário não tem espaço
		// -------------------------------------------------------------
		await insertUser(database, TEST_TARGET, 5);
		await insertPermanentBuff(database, TEST_TARGET, "max_baits", 294, "Pochete de Iscas");
		await insertPermanentBuff(database, TEST_USER, "max_baits", 2, "Caixa de Iscas");
		const offered = await database.dbGet(
			"fishing",
			"SELECT id FROM fishing_buffs WHERE user_id = ? AND effect_type = 'max_baits'",
			[TEST_USER]
		);
		const capCheck = await FishingGame.checkBuffTransferCapacity(TEST_TARGET, [offered.id]);
		assert.strictEqual(capCheck.ok, false);
		const transferRes = await FishingGame.transferBuff(TEST_USER, TEST_TARGET, offered.id);
		assert.strictEqual(transferRes.success, false);
		const stillMine = await database.dbGet(
			"fishing",
			"SELECT user_id FROM fishing_buffs WHERE id = ?",
			[offered.id]
		);
		assert.strictEqual(stillMine.user_id, TEST_USER);
		console.log("✓ Teste 7 passou: mercado não transfere item para quem está no teto.");

		// -------------------------------------------------------------
		// 8. !pesca-rede limita iscas ao tamanho do inventário e mostra a dica na 2ª linha
		// -------------------------------------------------------------
		FishingGame.RARE_FISH.forEach((f) => {
			f.chance = 0;
		});
		await database.dbRun("fishing", "DELETE FROM fishing_buffs WHERE user_id = ?", [TEST_USER]);
		await insertUser(database, TEST_USER_JID, 50);
		FishingGame.fishingCooldowns[TEST_USER_JID] = 0;
		bot.resetCapture();
		await eventHandler.commandHandler.processCommand(
			bot,
			createMessage({
				content: "!pesca-rede",
				group: TEST_GROUP,
				author: TEST_USER_JID,
				authorName: "PescadorLimites"
			}),
			"pesca-rede",
			[],
			null
		);
		const netMsg = bot.capturedMessages
			.map((m) => (typeof m.content === "string" ? m.content : ""))
			.find((c) => c.includes("iscas"));
		assert.ok(netMsg, "Mensagem da rede capturada");
		const lines = netMsg.split("\n");
		assert.strictEqual(
			lines[1],
			"> Você pode usar !pesca-rede 100 para especificar quantas iscas usar",
			"Dica na segunda linha"
		);
		assert.ok(/\b10 iscas\b/.test(lines[0]), `Usou só 10 iscas (inventário base): ${lines[0]}`);
		const netUser = await FishingGame.getUserData(TEST_USER_JID);
		// (iscas restantes podem variar por debuffs aleatórios como Tartaruga Gulosa; o gasto da rede é fixo)
		assert.strictEqual(netUser.totalBaitsUsed, 10, "A rede gastou só 10 iscas");
		console.log("✓ Teste 8 passou: rede limitada ao inventário e dica exibida.");

		// -------------------------------------------------------------
		// 9. Ritmo dos lendários: redução até a reta final e chance original nos últimos 5 dias
		// -------------------------------------------------------------
		FishingGame.RARE_FISH.forEach((f, idx) => {
			f.chance = originalChances[idx];
		});
		const reduced = FishingGame.getLegendaryChanceFactor(new Date(2026, 10, 25, 23, 59));
		const boosted = FishingGame.getLegendaryChanceFactor(new Date(2026, 10, 26, 0, 0));
		assert.ok(Math.abs(reduced - 1.65 * 0.3) < 1e-9, `Fator reduzido: ${reduced}`);
		assert.ok(Math.abs(boosted - 1.65) < 1e-9, `Fator original no boost: ${boosted}`);
		assert.strictEqual(FishingGame.getLegendaryBoostStart(new Date(2026, 1, 10)).getDate(), 24);
		assert.strictEqual(FishingGame.getLegendaryBoostStart(new Date(2026, 11, 3)).getDate(), 27);
		console.log("✓ Teste 9 passou: fator dos lendários e janela de boost corretos.");

		// -------------------------------------------------------------
		// 10. !pesca-lendas mostra disponibilidade do mês como o !pesca-info
		// -------------------------------------------------------------
		await database.dbRun(
			"fishing",
			`INSERT INTO fishing_legendary_history (fish_name, weight, user_id, user_name, group_id, group_name, timestamp, image_name, year)
			VALUES ('Kraken', 1000, ?, 'PescadorLimites', ?, 'Grupo Teste', ?, NULL, ?)`,
			[TEST_USER, TEST_GROUP, Date.now(), new Date().getFullYear()]
		);
		const lendasCmd = FishingGame.commands.find((c) => c.name === "pesca-lendas");
		const lendasRes = await lendasCmd.method(
			bot,
			createMessage({ content: "!pesca-lendas", group: TEST_GROUP, author: TEST_USER_JID }),
			[String(new Date().getFullYear())],
			null
		);
		const lendasText = (Array.isArray(lendasRes) ? lendasRes : [lendasRes])
			.map((m) => m.content)
			.join("\n");
		assert.ok(/disponíveis este mês/.test(lendasText), "Cabeçalho com disponibilidade");
		assert.ok(/Kraken\*: `[^`]+` \| 🔴 \*Esgotado\*/.test(lendasText), "Kraken esgotado no mês");
		assert.ok(/disp\.`/.test(lendasText), "Outros lendários disponíveis");
		console.log("✓ Teste 10 passou: !pesca-lendas exibe disponibilidade mensal.");

		console.log("--- Todos os testes de limites de pesca e lendários passaram! ---");
	} finally {
		FishingGame.RARE_FISH.forEach((f, idx) => {
			f.chance = originalChances[idx];
		});
		await database.dbRun(
			"fishing",
			"DELETE FROM fishing_legendary_history WHERE user_id = ? AND user_name = 'PescadorLimites'",
			[TEST_USER]
		);
		await cleanup(database);
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes:", err);
		process.exit(1);
	});
