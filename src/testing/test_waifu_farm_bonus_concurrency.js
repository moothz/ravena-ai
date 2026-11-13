// src/testing/test_waifu_farm_bonus_concurrency.js
// Bônus da fazenda (Coração Púrpuro / Rosa de Sangue) não pode ser usado duas vezes por
// !mu-r concorrentes do mesmo usuário: a reserva é um UPDATE condicional antes do /roll.

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
const DonorBonusService = require("../services/DonorBonusService");
const GameEventService = require("../services/GameEventService");

const TEST_USER = "5511900077001";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readInventory() {
	return Database.getInstance().mappers.get(
		"core",
		"SELECT rolls, tickets FROM farm_bonus_inventory WHERE user_id = ?",
		[TEST_USER]
	);
}

function resetInventory({ rolls = 0, tickets = 0 } = {}) {
	const mappers = Database.getInstance().mappers;
	mappers.run("core", "DELETE FROM farm_bonus_inventory WHERE user_id = ?", [TEST_USER]);
	mappers.run(
		"core",
		"INSERT INTO farm_bonus_inventory (user_id, rolls, tickets, updated_at) VALUES (?, ?, ?, ?)",
		[TEST_USER, rolls, tickets, Date.now()]
	);
}

async function testServiceLevel() {
	console.log("\n[1] reserveWaifuBonus é atômico e nunca deixa saldo negativo...");
	resetInventory({ rolls: 1, tickets: 2 });
	const results = await Promise.all(
		Array.from({ length: 6 }, () => ShadowGardenBonusService.reserveWaifuBonus(TEST_USER))
	);
	const reserved = results.filter((r) => r.reserved);
	assert.strictEqual(reserved.length, 3, "Exatamente 3 reservas (2 tickets + 1 roll)");
	assert.deepStrictEqual(
		reserved.map((r) => r.type),
		["ticket", "ticket", "roll"],
		"Tickets são reservados antes dos rolls"
	);
	assert.deepStrictEqual(readInventory(), { rolls: 0, tickets: 0 }, "Saldo zerado, não negativo");

	assert.strictEqual(await ShadowGardenBonusService.refundWaifuBonus(TEST_USER, "ticket"), true);
	assert.deepStrictEqual(readInventory(), { rolls: 0, tickets: 1 }, "Devolução repõe o ticket");

	// consumeWaifuBonus legado também não fica negativo
	resetInventory({ rolls: 0, tickets: 0 });
	const consumed = await ShadowGardenBonusService.consumeWaifuBonus(TEST_USER);
	assert.strictEqual(consumed.consumed, false);
	assert.deepStrictEqual(readInventory(), { rolls: 0, tickets: 0 });
	console.log("✓ Reservas concorrentes respeitam o saldo e devolução funciona.");
}

async function testConcurrentRolls() {
	console.log("\n[2] Dois !mu-r simultâneos (chats diferentes) com 1 roll da fazenda...");
	resetInventory({ rolls: 1, tickets: 0 });

	const freeRollPayloads = [];
	const allPayloads = [];
	WaifuCommands.api.post = async (path, body) => {
		if (path === "/kakera/daily" || path === "/user/ensure") {
			return { data: { success: false } };
		}
		if (path === "/roll") {
			allPayloads.push(body);
			if (body?.bonuses?.isFreeRoll) freeRollPayloads.push(body);
			// Latência da API: na versão antiga ambos liam o saldo antes de qualquer consumo
			await sleep(40);
			const idx = allPayloads.length;
			return {
				data: {
					success: true,
					data: {
						character: {
							id: `char-conc-${idx}`,
							name: `Personagem ${idx}`,
							series: "Série Teste",
							rarity: "COMMON",
							imageUrl: null
						},
						available: false,
						isOwner: false,
						rollsRemaining: 5,
						maxRolls: 9
					}
				}
			};
		}
		return { data: { success: true } };
	};

	const bot = new FakeBot({ id: "teste-concorrencia", grupoLogs: "123@g.us" });
	const groups = ["120363000077001@g.us", "120363000077002@g.us"];
	await Promise.all(
		groups.map((groupId) =>
			WaifuCommands.rollAny(
				bot,
				createMessage({ content: "!mu-r", group: groupId, author: `${TEST_USER}@s.whatsapp.net` }),
				[],
				{ id: groupId, filters: { waifuRollMarcar: false } }
			)
		)
	);

	assert.strictEqual(allPayloads.length, 2, "Os dois rolls devem ser executados");
	assert.strictEqual(
		freeRollPayloads.length,
		1,
		"Só UM dos rolls simultâneos pode usar o roll grátis da fazenda"
	);
	assert.deepStrictEqual(readInventory(), { rolls: 0, tickets: 0 }, "Saldo final 0 (sem negativo)");
	console.log("✓ Apenas um roll concorrente usou o bônus da fazenda.");
}

async function runTests() {
	console.log("=== Testes de concorrência do bônus da fazenda no !mu-r ===");

	const originals = {
		getWaifuBonus: ShadowGardenBonusService.getWaifuBonus,
		getWaifuRollBonuses: DonorBonusService.getWaifuRollBonuses,
		getMultiplier: GameEventService.getMultiplier,
		post: WaifuCommands.api.post
	};
	// Sem sincronização com a API do Jardim durante o teste
	ShadowGardenBonusService.getWaifuBonus = (userId) => originals.getWaifuBonus(userId, false);
	DonorBonusService.getWaifuRollBonuses = async () => null;
	GameEventService.getMultiplier = () => 1.0;

	try {
		await testServiceLevel();
		await testConcurrentRolls();
	} finally {
		ShadowGardenBonusService.getWaifuBonus = originals.getWaifuBonus;
		DonorBonusService.getWaifuRollBonuses = originals.getWaifuRollBonuses;
		GameEventService.getMultiplier = originals.getMultiplier;
		WaifuCommands.api.post = originals.post;
		Database.getInstance().mappers.run(
			"core",
			"DELETE FROM farm_bonus_inventory WHERE user_id = ?",
			[TEST_USER]
		);
	}

	console.log("\n=== Testes de concorrência do bônus da fazenda passaram! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes de concorrência do bônus da fazenda:", err);
		process.exit(1);
	});
