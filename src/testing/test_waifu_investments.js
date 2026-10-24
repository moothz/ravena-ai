process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");

async function runTests() {
	console.log("=== Iniciando Teste de Investimentos, Cotação e Mercado de Waifus ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const groupId = "grupoteste@g.us";
	const userId = "5511999999999@s.whatsapp.net";

	// Salva métodos originais da API para restaurar no final
	const originalGet = WaifuCommands.api.get;
	const originalPost = WaifuCommands.api.post;

	try {
		// ─── TESTE 1: !mu-cotacao ────────────────────────────────────────────────
		console.log("\n[TESTE 1] Consulta de cotação (!mu-cotacao)");
		WaifuCommands.api.get = async (url) => {
			if (url.includes("/market/quote/makima")) {
				return {
					data: {
						success: true,
						data: {
							character: {
								id: "makima",
								name: "Makima",
								series: "Chainsaw Man",
								baseRarity: "EPIC",
								imageUrl: "/media/characters/makima.jpg",
								isClaimed: false,
								owner: null
							},
							pricing: {
								days: 100,
								basePrice: 3000000,
								dynamicPrice: 3120000,
								cotaPrice: 780000,
								inflationMultiplier: 1.02,
								inflationPercent: 2.0,
								scarcityMultiplier: 1.02
							},
							rarityStats: {
								total: 10448,
								claimed: 380,
								available: 10068,
								percentageClaimed: 3.64
							},
							investments: []
						}
					}
				};
			}
			throw new Error(`URL não mockada: ${url}`);
		};

		const msgCotacao = createMessage({
			content: "!mu-cotacao makima",
			group: groupId,
			author: userId
		});

		const resCotacao = await WaifuCommands.cotarWaifuCmd(bot, msgCotacao, ["makima"]);
		assert(resCotacao, "Deveria retornar ReturnMessage");
		const contentCotacao = resCotacao.options?.caption || resCotacao.content;
		assert(
			contentCotacao.includes("Makima") && contentCotacao.includes("3.120.000"),
			"Cotação deve conter nome e valor integral dinâmico"
		);
		assert(contentCotacao.includes("780.000"), "Cotação deve conter valor da cota de 25%");
		console.log("✅ [TESTE 1 PASSOU] Cotação formatada com sucesso!");

		// ─── TESTE 2: !mu-mercado e !mu-economia ─────────────────────────────────
		console.log("\n[TESTE 2] Relatório macroeconômico (!mu-mercado)");
		WaifuCommands.api.get = async (url) => {
			if (url === "/market/stats") {
				return {
					data: {
						success: true,
						data: {
							circulatingKakera: 3959990,
							baseMoneySupply: 4000000,
							inflationMultiplier: 1.0,
							inflationPercent: 0.0,
							thirtyDaysStats: {
								tradedWaifus: 18,
								tradedZinthos: 154000,
								acceptedOffersCount: 12
							},
							rarityStats: {
								COMMON: {
									days: 15,
									basePrice: 450000,
									dynamicPrice: 458000,
									cotaPrice: 114500,
									available: 110197,
									percentageClaimed: 1.73
								},
								UNCOMMON: {
									days: 30,
									basePrice: 900000,
									dynamicPrice: 922500,
									cotaPrice: 230625,
									available: 75189,
									percentageClaimed: 2.41
								},
								RARE: {
									days: 60,
									basePrice: 1800000,
									dynamicPrice: 1895400,
									cotaPrice: 473850,
									available: 15066,
									percentageClaimed: 3.44
								},
								EPIC: {
									days: 100,
									basePrice: 3000000,
									dynamicPrice: 3168000,
									cotaPrice: 792000,
									available: 10068,
									percentageClaimed: 3.64
								},
								LEGENDARY: {
									days: 210,
									basePrice: 6300000,
									dynamicPrice: 8404200,
									cotaPrice: 2101050,
									available: 318,
									percentageClaimed: 10.92
								}
							}
						}
					}
				};
			}
			throw new Error(`URL não mockada: ${url}`);
		};

		const msgMercado = createMessage({
			content: "!mu-mercado",
			group: groupId,
			author: userId
		});

		const resMercado = await WaifuCommands.mercadoInfoCmd(bot, msgMercado, []);
		assert(
			resMercado.content.includes("MERCADO & ECONOMIA GLOBAL"),
			"Deve conter título do mercado"
		);
		assert(
			resMercado.content.includes("154.000 Zinthos"),
			"Deve conter Zinthos negociados nos últimos 30 dias"
		);
		assert(
			resMercado.content.includes("18 waifus"),
			"Deve conter waifus negociadas nos últimos 30 dias"
		);
		console.log(
			"✅ [TESTE 2 PASSOU] Relatório do mercado e histórico de 30 dias exibido com sucesso!"
		);

		// ─── TESTE 3: !mu-investir 1 cota (25%) ──────────────────────────────────
		console.log("\n[TESTE 3] Compra de 1 cota de 25% (!mu-investir makima 1)");
		WaifuCommands.api.post = async (url, data) => {
			if (url === "/user/ensure") {
				return { data: { success: true } };
			}
			if (url === "/market/invest") {
				assert.strictEqual(data.characterId, "makima");
				assert.strictEqual(data.shares, 1);
				return {
					data: {
						success: true,
						data: {
							acquired: false,
							character: {
								id: "makima",
								name: "Makima",
								series: "Chainsaw Man",
								baseRarity: "EPIC"
							},
							sharesBought: 1,
							totalShares: 1,
							cost: 780000,
							remainingShares: 3,
							boostPercent: 300,
							newBalance: 1200000
						}
					}
				};
			}
			throw new Error(`URL não mockada: ${url}`);
		};

		const msgInvestir1 = createMessage({
			content: "!mu-investir makima 1",
			group: groupId,
			author: userId
		});

		const resInvestir1 = await WaifuCommands.investirWaifuCmd(bot, msgInvestir1, ["makima", "1"]);
		assert(resInvestir1.content.includes("INVESTIMENTO CONFIRMADO"), "Deve confirmar cota");
		assert(resInvestir1.content.includes("1/4 cotas"), "Deve mostrar 1/4 cotas");
		assert(resInvestir1.content.includes("+300%"), "Deve indicar +300% de drop");
		assert(
			resInvestir1.content.includes("Casamento Instantâneo"),
			"Deve mencionar casamento instantâneo no roll"
		);
		console.log("✅ [TESTE 3 PASSOU] Compra de cota parcial validada!");

		// ─── TESTE 4: !mu-investimentos (listagem) ───────────────────────────────
		console.log("\n[TESTE 4] Listagem de investimentos (!mu-investimentos)");
		WaifuCommands.api.get = async (url, config) => {
			if (url === "/market/investments") {
				assert.strictEqual(config.params.userId, WaifuCommands.normalizeUserId(userId));
				return {
					data: {
						success: true,
						data: [
							{
								id: "inv-1",
								character: {
									id: "makima",
									name: "Makima",
									series: "Chainsaw Man",
									baseRarity: "EPIC"
								},
								shares: 1,
								percent: 25,
								totalZinthosInvested: 780000,
								cotaPriceCurrent: 780000,
								totalPriceCurrent: 3120000,
								boostPercent: 300,
								remainingShares: 3
							}
						]
					}
				};
			}
			throw new Error(`URL não mockada: ${url}`);
		};

		const msgListar = createMessage({
			content: "!mu-investimentos",
			group: groupId,
			author: userId
		});

		const resListar = await WaifuCommands.listarInvestimentosCmd(bot, msgListar);
		assert(resListar.content.includes("SEUS INVESTIMENTOS EM WAIFUS"), "Deve listar título");
		assert(
			resListar.content.includes("Makima") && resListar.content.includes("1/4"),
			"Deve listar Makima 1/4"
		);
		console.log("✅ [TESTE 4 PASSOU] Carteira de investimentos exibida!");

		// ─── TESTE 5: Compra da 4ª Cota (Aquisição / Casamento 100%) ─────────────
		console.log("\n[TESTE 5] Aquisição completa com 4 cotas (Casamento idêntico a !mu-casar)");
		WaifuCommands.api.post = async (url, data) => {
			if (url === "/user/ensure") {
				return { data: { success: true } };
			}
			if (url === "/market/invest") {
				assert.strictEqual(data.shares, 3);
				return {
					data: {
						success: true,
						data: {
							acquired: true,
							character: {
								id: "makima",
								name: "Makima",
								series: "Chainsaw Man",
								baseRarity: "EPIC",
								imageUrls: ["makima.jpg"]
							},
							sharesBought: 3,
							totalShares: 4,
							cost: 2340000,
							remainingShares: 0,
							newBalance: 150000,
							refundedCompetitors: [
								{ userId: "bob@s.whatsapp.net", name: "Bob", refundedZinthos: 780000, shares: 1 }
							]
						}
					}
				};
			}
			throw new Error(`URL não mockada: ${url}`);
		};

		const msgInvestir4 = createMessage({
			content: "!mu-investir makima 3",
			group: groupId,
			author: userId
		});

		const resInvestir4 = await WaifuCommands.investirWaifuCmd(bot, msgInvestir4, ["makima", "3"]);
		const caption4 = resInvestir4.options?.caption || resInvestir4.content;
		assert(caption4.includes("se casou com *Makima*!"), "Deve disparar celebração de casamento");
		assert(caption4.includes("Chaves: *1/10*"), "Deve conter status de chaves");
		assert(caption4.includes("50% de reembolso"), "Deve informar estorno de concorrentes");
		console.log(
			"✅ [TESTE 5 PASSOU] Casamento definitivo por cotas formatado com foto e estorno de concorrentes!"
		);

		// ─── TESTE 6: Casamento Instantâneo no !mu-roll ──────────────────────────
		console.log("\n[TESTE 6] Casamento Instantâneo no !mu-roll quando o jogador tem cota comprada");
		const rollHandler = WaifuCommands.commands.find((c) => c.name === "mu-roll").method;

		WaifuCommands.api.post = async (url) => {
			if (url === "/kakera/daily") {
				return { data: { success: false } };
			}
			if (url === "/roll") {
				return {
					data: {
						success: true,
						data: {
							character: {
								id: "makima",
								name: "Makima",
								series: "Chainsaw Man",
								baseRarity: "EPIC",
								imageUrl: "/media/characters/makima.jpg",
								imageUrls: ["makima.jpg"]
							},
							available: false,
							isOwner: true,
							instantMarriage: true,
							instantMarriageShares: 2,
							refundedCompetitorsCount: 1,
							rollsRemaining: 5,
							maxRolls: 9,
							rollReward: { totalScrap: 120 }
						}
					}
				};
			}
			throw new Error(`URL não mockada: ${url}`);
		};

		const msgRoll = createMessage({
			content: "!mu-roll",
			group: groupId,
			author: userId
		});

		const resRoll = await rollHandler(bot, msgRoll, []);
		const finalRollMsg = Array.isArray(resRoll) ? resRoll[0] : resRoll;
		const rollCaption = finalRollMsg.options?.caption || finalRollMsg.content;
		assert(
			rollCaption.includes("CASAMENTO INSTANTÂNEO POR COTA"),
			"Roll deve conter anúncio de casamento instantâneo por cota"
		);
		assert(
			rollCaption.includes("Você se casou com *Makima*!"),
			"Roll deve casar o usuário na hora"
		);
		assert(
			rollCaption.includes("sem consumir cooldown"),
			"Roll deve salientar que não consumiu cooldown"
		);
		console.log("✅ [TESTE 6 PASSOU] Casamento instantâneo no roll validado com sucesso!");

		console.log("\n========================================================");
		console.log("🎉 TODOS OS 6 TESTES DE INVESTIMENTO E MERCADO PASSARAM! 🎉");
		console.log("========================================================\n");
		process.exit(0);
	} catch (err) {
		console.error("❌ FALHA NOS TESTES:", err);
		process.exit(1);
	} finally {
		WaifuCommands.api.get = originalGet;
		WaifuCommands.api.post = originalPost;
	}
}

runTests();
