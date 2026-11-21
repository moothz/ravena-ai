// src/testing/test_daily_checkin_unified.js
// Check-in diário dos minigames (Zinthos e Sacola do Coveiro): o cache local por jogador evita
// repetir o claim a cada comando do jogo, e o resgate automático entra na primeira linha da
// resposta do comando em vez de virar uma segunda mensagem.

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");
const FazendaCommands = require("../functions/FazendaCommands");
const ShadowGardenClient = require("../services/ShadowGardenClient");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
const DonorBonusService = require("../services/DonorBonusService");
const GameEventService = require("../services/GameEventService");

const GROUP = "120363000000000099@g.us";
const LOGS_GROUP = "120363000000000098@g.us";
const CLAIMER_USER = "5511900088001";
const COOLDOWN_ONLY_USER = "5511900088002";
const FARM_USER = "5511900088003";

const SUMMARY_WAIFU = "💜 Recompensa diária estava disponível e foi coletada! (+721 Zinthos)";
const SUMMARY_FARM = "🎁 SACOLA DO COVEIRO RESGATADA! 🎁 (+183 Petalitas, 3x Lírio Cadáver)";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function buildDailyPayload() {
	return {
		amount: 721,
		currency: "Zinthos",
		currencyEmoji: "💜",
		newBalance: 12345,
		nextDailyAt: new Date(Date.now() + SIX_HOURS_MS).toISOString(),
		streak: { current: 3, bonusPercent: 20, bonusAmount: 121, maxStreak: 7 },
		wishlist: { count: 450, bonusAmount: 130, multiplier: 1.45 }
	};
}

function textOf(returnMessage) {
	if (!returnMessage) return "";
	const caption = returnMessage.options?.caption;
	if (typeof caption === "string" && caption.trim() !== "") return caption;
	return typeof returnMessage.content === "string" ? returnMessage.content : "";
}

function asList(result) {
	if (Array.isArray(result)) return result;
	return result ? [result] : [];
}

async function testWaifuDailyCacheAndUnification() {
	console.log("\n[1] !mu-r: check-in unificado na resposta e cache do ciclo...");

	const bot = new FakeBot({ id: "teste-diario-waifu", grupoLogs: LOGS_GROUP });
	const originals = {
		post: WaifuCommands.api.post,
		getWaifuBonus: ShadowGardenBonusService.getWaifuBonus,
		reserveWaifuBonus: ShadowGardenBonusService.reserveWaifuBonus,
		getWaifuRollBonuses: DonorBonusService.getWaifuRollBonuses,
		getMultiplier: GameEventService.getMultiplier
	};

	// Resgate do ciclo por usuário: o cooldown da API chega como rejeição do axios (HTTP 400)
	const dailyCallsByUser = {};
	WaifuCommands.api.post = async (path, body) => {
		if (path === "/kakera/daily") {
			dailyCallsByUser[body?.userId] = (dailyCallsByUser[body?.userId] || 0) + 1;
			if (body?.userId === COOLDOWN_ONLY_USER) {
				const cooldownErr = new Error("Você já resgatou sua recompensa diária hoje!");
				cooldownErr.response = {
					status: 400,
					data: {
						success: false,
						error: {
							code: "DAILY_COOLDOWN_ACTIVE",
							message: "Você já resgatou sua recompensa diária hoje!",
							remainingSeconds: SIX_HOURS_MS / 1000,
							retryAfter: new Date(Date.now() + SIX_HOURS_MS).toISOString()
						}
					}
				};
				throw cooldownErr;
			}
			return { data: { success: true, data: buildDailyPayload() } };
		}

		if (path === "/roll") {
			return {
				data: {
					success: true,
					data: {
						character: {
							id: "char-diario-1",
							name: "Waifu Teste",
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

	ShadowGardenBonusService.getWaifuBonus = async () => ({ rolls: 0, tickets: 0 });
	ShadowGardenBonusService.reserveWaifuBonus = async () => ({ reserved: false });
	DonorBonusService.getWaifuRollBonuses = async () => null;
	GameEventService.getMultiplier = () => 1.0;

	const callsFor = (userId) => dailyCallsByUser[userId] || 0;
	const groupObj = { id: GROUP, filters: { waifuRollMarcar: false } };
	const rollMsg = (userId) =>
		createMessage({ content: "!mu-r", group: GROUP, author: `${userId}@s.whatsapp.net` });
	const diarioMsg = (userId) =>
		createMessage({ content: "!mu-diario", group: GROUP, author: `${userId}@s.whatsapp.net` });

	try {
		const firstRoll = asList(await WaifuCommands.rollAny(bot, rollMsg(CLAIMER_USER), [], groupObj));
		assert.strictEqual(callsFor(CLAIMER_USER), 1, "O primeiro roll deve tentar o resgate diário");
		assert.strictEqual(
			firstRoll.length,
			1,
			"Roll + check-in devem sair numa única mensagem, não em duas"
		);
		const firstText = textOf(firstRoll[0]);
		assert.ok(
			firstText.startsWith(SUMMARY_WAIFU),
			`Primeira linha deveria ser "${SUMMARY_WAIFU}". Texto:\n${firstText}`
		);

		const secondRoll = asList(
			await WaifuCommands.rollAny(bot, rollMsg(CLAIMER_USER), [], groupObj)
		);
		assert.strictEqual(
			callsFor(CLAIMER_USER),
			1,
			"Cache local deve evitar nova chamada em /kakera/daily"
		);
		const secondText = textOf(secondRoll[0]);
		assert.ok(
			!secondText.includes("Recompensa diária estava disponível"),
			"O resumo do check-in não pode repetir num comando do mesmo ciclo"
		);

		const diario = await WaifuCommands.diariosKakera(bot, diarioMsg(CLAIMER_USER));
		assert.strictEqual(
			callsFor(CLAIMER_USER),
			1,
			"!mu-diario com o ciclo já resolvido não deve chamar a API de novo"
		);
		const diarioText = textOf(diario);
		assert.ok(
			diarioText.includes("Você já resgatou sua recompensa diária!"),
			`Deveria avisar o cooldown. Texto:\n${diarioText}`
		);
		assert.ok(
			diarioText.includes("O que você já ganhou hoje:"),
			`Deveria mostrar o resgate do dia. Texto:\n${diarioText}`
		);
		assert.ok(diarioText.includes("+721 Zinthos"), "Deveria trazer o valor resgatado no dia");
		assert.ok(
			diarioText.includes("Sequência Diária: *Dia 3/7* (+20% de bônus!)"),
			"Deveria trazer a sequência do resgate"
		);
		assert.ok(
			diarioText.includes("Bônus de Wishlist: *+130 Zinthos* (450/1000 desejos)"),
			"Deveria trazer o bônus de wishlist do resgate"
		);

		// Ciclo resolvido em outro processo (cache frio): só o cooldown, sem bloco de detalhes
		const diarioFrio = await WaifuCommands.diariosKakera(bot, diarioMsg(COOLDOWN_ONLY_USER));
		assert.strictEqual(callsFor(COOLDOWN_ONLY_USER), 1, "Cache frio deve consultar a API uma vez");
		const diarioFrioText = textOf(diarioFrio);
		assert.ok(
			diarioFrioText.includes("Você já resgatou sua recompensa diária!"),
			`Deveria avisar o cooldown. Texto:\n${diarioFrioText}`
		);
		assert.ok(
			!diarioFrioText.includes("O que você já ganhou hoje:"),
			"Sem o resgate no cache local não há detalhes a reexibir"
		);

		await WaifuCommands.rollAny(bot, rollMsg(COOLDOWN_ONLY_USER), [], groupObj);
		assert.strictEqual(
			callsFor(COOLDOWN_ONLY_USER),
			1,
			"Cooldown conhecido na API também deve ser aproveitado pelo cache local"
		);
		console.log("✓ Check-in do roll unificado, cache sem request repetido e !mu-diario detalhado.");
	} finally {
		WaifuCommands.api.post = originals.post;
		ShadowGardenBonusService.getWaifuBonus = originals.getWaifuBonus;
		ShadowGardenBonusService.reserveWaifuBonus = originals.reserveWaifuBonus;
		DonorBonusService.getWaifuRollBonuses = originals.getWaifuRollBonuses;
		GameEventService.getMultiplier = originals.getMultiplier;
	}
}

async function testFarmDailyCacheAndUnification() {
	console.log("\n[2] Comando da Fazenda: resumo na primeira linha e cache do ciclo...");

	const bot = new FakeBot({ id: "teste-diario-fazenda", grupoLogs: LOGS_GROUP });
	const originals = {
		claimDaily: ShadowGardenClient.prototype.claimDaily,
		adminGive: ShadowGardenClient.prototype.adminGive,
		getMultiplier: GameEventService.getMultiplier
	};

	let claimCalls = 0;
	let adminGiveCalls = 0;
	ShadowGardenClient.prototype.claimDaily = async () => {
		claimCalls += 1;
		if (claimCalls === 1) {
			return {
				claimed: true,
				alreadyClaimed: false,
				coinsWon: 183,
				itemsWon: [{ itemId: "03_corpse_lily", name: "Lírio Cadáver", count: 3 }]
			};
		}
		return { claimed: false, alreadyClaimed: true, remainingHours: 9 };
	};
	ShadowGardenClient.prototype.adminGive = async () => {
		adminGiveCalls += 1;
		return { success: true };
	};
	GameEventService.getMultiplier = () => 1.0;

	const ajuda = FazendaCommands.commands.find((cmd) => cmd.name === "faz-ajuda");
	assert.ok(ajuda, "Comando !faz-ajuda deve existir");
	const ajudaMsg = () =>
		createMessage({ content: "!faz-ajuda", group: GROUP, author: `${FARM_USER}@s.whatsapp.net` });

	try {
		const first = asList(await ajuda.method(bot, ajudaMsg(), [], { id: GROUP }));
		assert.strictEqual(claimCalls, 1, "O primeiro comando da Fazenda deve tentar o resgate diário");
		assert.strictEqual(adminGiveCalls, 0, "Sem evento Fortuna, nada extra deve ser creditado");
		assert.strictEqual(
			first.length,
			1,
			"Comando + resgate devem sair numa única mensagem, não em duas"
		);
		const firstText = textOf(first[0]);
		assert.ok(
			firstText.startsWith(SUMMARY_FARM),
			`Primeira linha deveria ser "${SUMMARY_FARM}". Texto:\n${firstText}`
		);
		assert.ok(
			firstText.toUpperCase().includes("GUIA DO"),
			"O conteúdo do comando não pode ser perdido pela unificação"
		);

		const second = asList(await ajuda.method(bot, ajudaMsg(), [], { id: GROUP }));
		assert.strictEqual(claimCalls, 1, "Cache local deve evitar novo claim na API do Jardim");
		const secondText = textOf(second[0]);
		assert.ok(
			!secondText.includes("SACOLA DO COVEIRO"),
			"O resumo do resgate não pode repetir num comando do mesmo ciclo"
		);
		console.log("✓ Resgate da sacola unificado e sem request repetido no ciclo.");
	} finally {
		ShadowGardenClient.prototype.claimDaily = originals.claimDaily;
		ShadowGardenClient.prototype.adminGive = originals.adminGive;
		GameEventService.getMultiplier = originals.getMultiplier;
	}
}

async function runTests() {
	console.log("=== Testes do check-in diário unificado (cache local) ===");
	await testWaifuDailyCacheAndUnification();
	await testFarmDailyCacheAndUnification();
	console.log("\n=== Testes do check-in diário unificado passaram! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes do check-in diário unificado:", err);
		process.exit(1);
	});
