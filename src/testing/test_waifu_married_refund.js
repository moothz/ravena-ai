process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.WAIFULETES_WEB_URL = "https://waifuletes.moothz.com";
process.env.WAIFULETES_API_KEY = process.env.WAIFULETES_API_KEY || "teste";

const assert = require("assert");
const Database = require("../utils/Database");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
const Group = require("../models/Group");

const TEST_USER = "5511977770099";
const TEST_GROUP = "120363000000000099@g.us";

function resetFarmBonus({ rolls = 0, tickets = 0 } = {}) {
	const mappers = Database.getInstance().mappers;
	mappers.run("core", "DELETE FROM farm_bonus_inventory WHERE user_id = ?", [TEST_USER]);
	mappers.run(
		"core",
		"INSERT INTO farm_bonus_inventory (user_id, rolls, tickets, updated_at) VALUES (?, ?, ?, ?)",
		[TEST_USER, rolls, tickets, Date.now()]
	);
}

function readFarmBonus() {
	return Database.getInstance().mappers.get(
		"core",
		"SELECT rolls, tickets FROM farm_bonus_inventory WHERE user_id = ?",
		[TEST_USER]
	);
}

async function runTests() {
	console.log("=== Teste de refund de casados e +5 rolls soulmate na ravena-ai ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "logs@g.us" });
	const groupObj = new Group({
		id: TEST_GROUP,
		name: "Grupo Teste",
		additionalAdmins: [TEST_USER],
		filters: { waifuRollMarcar: true }
	});

	bot.database = {
		groups: new Map([[TEST_GROUP, groupObj]]),
		async getGroup(id) {
			return this.groups.get(id);
		},
		async saveGroup(group) {
			this.groups.set(group.id, group);
			return true;
		}
	};

	const originalPost = WaifuCommands.api.post;
	const originalBuildGrid = WaifuCommands.buildRollGridImage;
	WaifuCommands.buildRollGridImage = async () => Buffer.from("fake-grid");

	try {
		// 1. Roll único com marriedRollRefunded=true usando bônus da fazenda (não deve gastar o bônus)
		resetFarmBonus({ rolls: 1, tickets: 0 });
		WaifuCommands.api.post = async (url) => {
			if (url === "/kakera/daily" || url === "/user/ensure") {
				return { data: { success: false } };
			}
			if (url === "/roll") {
				return {
					data: {
						success: true,
						data: {
							character: {
								id: "char-casado-outro",
								name: "Waifu Casada",
								series: "Série A",
								rarity: "RARE",
								baseRarity: "RARE",
								imageUrl: null
							},
							available: false,
							isOwner: false,
							owner: { id: "outro-1", name: "Outro Jogador" },
							kakeraValue: 65,
							marriedRollRefunded: true,
							soulmateBonusRolls: 0,
							rollReward: { totalScrap: 20, rarityBonus: 0, wishlistBonus: 0 },
							rollsRemaining: 8,
							maxRolls: 9
						}
					}
				};
			}
			return { data: { success: true } };
		};

		const msgSingleRefund = createMessage({
			content: "!mu-roll",
			author: TEST_USER,
			group: TEST_GROUP
		});
		const singleRefundRes = await WaifuCommands.rollAny(bot, msgSingleRefund, [], groupObj);
		const singleRefundReturn = Array.isArray(singleRefundRes)
			? singleRefundRes[0]
			: singleRefundRes;
		const singleRefundText = singleRefundReturn.options?.caption || singleRefundReturn.content;

		assert.ok(
			singleRefundText.includes("Roll de Casado devolvido!"),
			`Roll único deveria informar devolução do roll de casado. Texto:\n${singleRefundText}`
		);
		assert.ok(
			!singleRefundText.includes("Bônus da Fazenda Usado:"),
			`Quando devolvido, não deveria marcar bônus da fazenda como usado. Texto:\n${singleRefundText}`
		);
		assert.strictEqual(
			readFarmBonus().rolls,
			1,
			"Reserva de bônus da fazenda deve ser devolvida quando marriedRollRefunded=true"
		);
		console.log("✓ 1. Roll único com marriedRollRefunded devolve fazenda e exibe aviso.");

		// 2. Roll único com soulmateBonusRolls=5 (já soulmate)
		resetFarmBonus({ rolls: 0, tickets: 0 });
		WaifuCommands.api.post = async (url) => {
			if (url === "/kakera/daily" || url === "/user/ensure") {
				return { data: { success: false } };
			}
			if (url === "/roll") {
				return {
					data: {
						success: true,
						data: {
							character: {
								id: "char-soulmate",
								name: "Minha Soulmate",
								series: "Série B",
								rarity: "EPIC",
								baseRarity: "EPIC",
								imageUrl: null
							},
							available: false,
							isOwner: true,
							owner: { id: TEST_USER, name: "Jogador" },
							keyProgress: {
								currentKeys: 10,
								requiredForSoulmate: 10,
								isSoulmate: true,
								becameSoulmateNow: false
							},
							marriedRollRefunded: false,
							soulmateBonusRolls: 5,
							rollReward: { totalScrap: 30, rarityBonus: 0, wishlistBonus: 0 },
							rollsRemaining: 13,
							maxRolls: 9
						}
					}
				};
			}
			return { data: { success: true } };
		};

		const singleSoulRes = await WaifuCommands.rollAny(bot, msgSingleRefund, [], groupObj);
		const singleSoulReturn = Array.isArray(singleSoulRes) ? singleSoulRes[0] : singleSoulRes;
		const singleSoulText = singleSoulReturn.options?.caption || singleSoulReturn.content;

		assert.ok(
			singleSoulText.includes("+*5 rolls grátis*") || singleSoulText.includes("+5 rolls"),
			`Roll único soulmate deveria informar +5 rolls grátis. Texto:\n${singleSoulText}`
		);
		assert.ok(
			singleSoulText.includes("*13/9*"),
			`Roll único soulmate deveria mostrar rolls restantes 13/9. Texto:\n${singleSoulText}`
		);
		console.log("✓ 2. Roll único soulmate exibe +5 rolls grátis e saldo 13/9.");

		// 3. Multi-roll com 1 refund de casado (que devolve fazenda no passo 2) e 1 soulmate (+5 rolls)
		resetFarmBonus({ rolls: 2, tickets: 0 });
		let callIdx = 0;
		WaifuCommands.api.post = async (url) => {
			if (url === "/kakera/daily" || url === "/user/ensure") {
				return { data: { success: false } };
			}
			if (url === "/roll") {
				callIdx += 1;
				if (callIdx === 1) {
					return {
						data: {
							success: true,
							data: {
								character: {
									id: "char-free-1",
									name: "Solteira Um",
									series: "Série 1",
									rarity: "COMMON",
									baseRarity: "COMMON",
									imageUrl: null
								},
								available: true,
								isOwner: false,
								owner: null,
								marriedRollRefunded: false,
								soulmateBonusRolls: 0,
								rollReward: { totalScrap: 15 },
								rollsRemaining: 0,
								maxRolls: 9
							}
						}
					};
				}
				if (callIdx === 2) {
					return {
						data: {
							success: true,
							data: {
								character: {
									id: "char-casado-2",
									name: "Casada Dois",
									series: "Série 2",
									rarity: "RARE",
									baseRarity: "RARE",
									imageUrl: null
								},
								available: false,
								isOwner: false,
								owner: { id: "outro-2", name: "Fulano" },
								marriedRollRefunded: true,
								soulmateBonusRolls: 0,
								rollReward: { totalScrap: 20 },
								rollsRemaining: 1,
								maxRolls: 9
							}
						}
					};
				}
				return {
					data: {
						success: true,
						data: {
							character: {
								id: "char-soulmate-3",
								name: "Soulmate Tres",
								series: "Série 3",
								rarity: "LEGENDARY",
								baseRarity: "LEGENDARY",
								imageUrl: null
							},
							available: false,
							isOwner: true,
							owner: { id: TEST_USER, name: "Jogador" },
							keyProgress: {
								currentKeys: 10,
								requiredForSoulmate: 10,
								isSoulmate: true,
								becameSoulmateNow: false
							},
							marriedRollRefunded: false,
							soulmateBonusRolls: 5,
							rollReward: { totalScrap: 50 },
							rollsRemaining: 5,
							maxRolls: 9
						}
					}
				};
			}
			return { data: { success: true } };
		};

		const msgMulti = createMessage({
			content: "!mu-roll 3",
			author: TEST_USER,
			group: TEST_GROUP
		});
		const multiRes = await WaifuCommands.rollAny(bot, msgMulti, ["3"], groupObj);
		const multiReturn = Array.isArray(multiRes) ? multiRes[0] : multiRes;
		const multiText = multiReturn.options?.caption || multiReturn.content;

		assert.strictEqual(callIdx, 3, "Deveria executar os 3 rolls após refund no passo 2");
		assert.ok(
			multiText.includes("🎟️ [Refund]"),
			`Multi-roll deveria marcar slot casado com [Refund]. Texto:\n${multiText}`
		);
		assert.ok(
			multiText.includes("Soulmate • +5 rolls"),
			`Multi-roll deveria marcar slot soulmate com +5 rolls. Texto:\n${multiText}`
		);
		assert.ok(
			multiText.includes("1 Roll(s) de Casado(s) devolvido(s)!"),
			`Multi-roll deveria resumir devolução de casado. Texto:\n${multiText}`
		);
		assert.ok(
			multiText.includes("+5 Roll(s) Bônus de Soulmate!"),
			`Multi-roll deveria resumir +5 rolls de soulmate. Texto:\n${multiText}`
		);
		console.log("✓ 3. Multi-roll estende lote no refund, marca slots e exibe resumo.");
	} finally {
		resetFarmBonus({ rolls: 0, tickets: 0 });
		WaifuCommands.api.post = originalPost;
		WaifuCommands.buildRollGridImage = originalBuildGrid;
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHA NO TESTE:", err);
		process.exit(1);
	});
