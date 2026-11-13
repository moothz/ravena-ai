process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");
const ListCommands = require("../functions/ListCommands");

async function runTests() {
	console.log("=== Iniciando Suíte de Testes: Multi-Rolls, Grid e Casamento por Reação ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	// ─── TESTE 1: Validação de Tempos de Exclusividade por Raridade ──────────
	console.log("\n[Teste 1] Validando tempos de reserva por raridade...");
	assert.strictEqual(
		WaifuCommands.getExclusiveClaimWindowMs("COMMON"),
		0,
		"Comum deve ter 0s de reserva"
	);
	assert.strictEqual(WaifuCommands.getExclusiveClaimWindowMs("Comum"), 0, "Comum (pt) deve ter 0s");
	assert.strictEqual(
		WaifuCommands.getExclusiveClaimWindowMs("UNCOMMON"),
		30000,
		"Incomum deve ter 30s"
	);
	assert.strictEqual(
		WaifuCommands.getExclusiveClaimWindowMs("Incomum"),
		30000,
		"Incomum (pt) deve ter 30s"
	);
	assert.strictEqual(WaifuCommands.getExclusiveClaimWindowMs("RARE"), 60000, "Raro deve ter 60s");
	assert.strictEqual(
		WaifuCommands.getExclusiveClaimWindowMs("Raro"),
		60000,
		"Raro (pt) deve ter 60s"
	);
	assert.strictEqual(WaifuCommands.getExclusiveClaimWindowMs("EPIC"), 90000, "Épico deve ter 90s");
	assert.strictEqual(
		WaifuCommands.getExclusiveClaimWindowMs("Épico"),
		90000,
		"Épico (pt) deve ter 90s"
	);
	assert.strictEqual(
		WaifuCommands.getExclusiveClaimWindowMs("LEGENDARY"),
		120000,
		"Lendário deve ter 120s"
	);
	assert.strictEqual(
		WaifuCommands.getExclusiveClaimWindowMs("Lendário"),
		120000,
		"Lendário (pt) deve ter 120s"
	);
	console.log("✓ Teste 1 passou: tempos de reserva por raridade corretos (30s, 60s, 90s, 120s).");

	// ─── TESTE 2: Geração de Grid de Imagens com Sharp (2 a 9) ──────────────
	console.log("\n[Teste 2] Validando renderizador de grid via sharp (layouts 2 a 9)...");
	const sharp = require("sharp");

	for (let n = 2; n <= 9; n++) {
		const items = [];
		for (let s = 1; s <= n; s++) {
			items.push({
				slot: s,
				character: {
					name: `Personagem ${s}`,
					series: `Série Anime ${s}`
				},
				imageBuffer: null // Vai testar a geração do placeholder + badge
			});
		}
		const gridBuf = await WaifuCommands.buildRollGridImage(items);
		assert.ok(Buffer.isBuffer(gridBuf), `Grid para ${n} imagens deve retornar Buffer`);
		assert.ok(gridBuf.length > 500, `Buffer da imagem para ${n} deve ser válido`);

		const meta = await sharp(gridBuf).metadata();
		assert.strictEqual(meta.format, "jpeg", `Grid para ${n} deve ser JPEG`);

		if (n === 2) {
			assert.strictEqual(meta.width, 640);
			assert.strictEqual(meta.height, 320);
		} else if (n === 3) {
			assert.strictEqual(meta.width, 960);
			assert.strictEqual(meta.height, 320);
		} else if (n === 4) {
			assert.strictEqual(meta.width, 640);
			assert.strictEqual(meta.height, 640);
		} else if (n === 5 || n === 6) {
			assert.strictEqual(meta.width, 960);
			assert.strictEqual(meta.height, 640);
		} else if (n >= 7) {
			assert.strictEqual(meta.width, 960);
			assert.strictEqual(meta.height, 960);
		}
	}
	console.log("✓ Teste 2 passou: grids de 2 a 9 gerados com sucesso nas dimensões exatas.");

	// ─── TESTE 3: Registro e Recuperação de Multi-Roll em Memória ────────────
	console.log("\n[Teste 3] Validando recordRollMessage e getRollByMessageId com multi-roll...");
	const testMsgId = "MSG_MULTI_ROLL_123";
	const testGroupId = "group_multi@g.us";
	const rollerUser = "5511999990001";
	const testSlots = [
		{
			slot: 1,
			characterId: "char-1-common",
			characterName: "Char 1",
			rarity: "COMMON",
			available: true
		},
		{
			slot: 2,
			characterId: "char-2-rare",
			characterName: "Char 2",
			rarity: "RARE",
			available: true,
			exclusiveUntil: Date.now() + 60000
		},
		{
			slot: 3,
			characterId: "char-3-legendary",
			characterName: "Char 3",
			rarity: "LEGENDARY",
			available: true,
			exclusiveUntil: Date.now() + 120000
		}
	];

	WaifuCommands.recordRollMessage(
		testMsgId,
		testSlots,
		testGroupId,
		Date.now() + 300000,
		rollerUser,
		null,
		"TestRoller"
	);

	const retrieved = WaifuCommands.getRollByMessageId(testMsgId);
	assert.ok(retrieved, "Roll data deve ser recuperado");
	assert.strictEqual(retrieved.isMultiRoll, true, "Deve marcar como isMultiRoll");
	assert.strictEqual(retrieved.slots.length, 3, "Deve conter os 3 slots");
	assert.strictEqual(retrieved.slots[1].characterId, "char-2-rare");
	console.log("✓ Teste 3 passou: slots e metadados de multi-roll registrados com sucesso.");

	// ─── TESTE 4: Casamento por Reação Numérica (2️⃣) e Bloqueio de Exclusividade ─
	console.log("\n[Teste 4] Validando casamento por reação numérica e exclusividade...");
	const otherUser = "5511999990002";

	// 4.1 Outro jogador tenta casar com o Slot 2 (Raro, 60s) reagindo com 2️⃣
	const reactMsgOther = createMessage({
		content: "Mensagem de roll múltiplo",
		group: testGroupId,
		author: "bot@s.whatsapp.net"
	});
	reactMsgOther.id = testMsgId;
	reactMsgOther.originReaction = {
		reaction: "2️⃣",
		senderId: otherUser,
		userName: "OutroJogador",
		msgId: { _serialized: testMsgId }
	};

	const blockedRes = await WaifuCommands.processWaifuReaction(bot, reactMsgOther);
	assert.ok(blockedRes, "Deve retornar ReturnMessage avisando exclusividade");
	assert.ok(
		blockedRes.content.includes("Personagem exclusivo"),
		`Deveria bloquear por exclusividade. Retornou: ${blockedRes.content}`
	);
	assert.ok(
		blockedRes.content.includes("Char 2"),
		`Deveria citar o nome do personagem do Slot 2. Retornou: ${blockedRes.content}`
	);
	console.log("✓ 4.1 Outro jogador foi bloqueado corretamente na reserva de 60s.");

	// 4.2 Autor do roll tenta casar com o Slot 2 reagindo com 2️⃣ (deve passar da validação de exclusividade)
	const reactMsgRoller = createMessage({
		content: "Mensagem de roll múltiplo",
		group: testGroupId,
		author: "bot@s.whatsapp.net"
	});
	reactMsgRoller.id = testMsgId;
	reactMsgRoller.originReaction = {
		reaction: "2️⃣",
		senderId: rollerUser,
		userName: "TestRoller",
		msgId: { _serialized: testMsgId }
	};

	// Mock temporal da API para responder sucesso em /marry
	let marryRequestedChar = null;
	const originalPost = WaifuCommands.api.post;
	WaifuCommands.api.post = async (path, body) => {
		if (path === "/marry") {
			marryRequestedChar = body.characterId;
			return {
				data: {
					success: true,
					data: {
						character: { id: body.characterId, name: "Char 2 Raro", rarity: "RARE" },
						keys: 1,
						isSoulmate: false,
						kakeraBalance: 500
					}
				}
			};
		}
		return originalPost.apply(WaifuCommands.api, [path, body]);
	};

	const successRes = await WaifuCommands.processWaifuReaction(bot, reactMsgRoller);
	assert.ok(successRes, "Deve retornar ReturnMessage de sucesso");
	assert.strictEqual(marryRequestedChar, "char-2-rare", "Deve ter chamado /marry com char-2-rare");
	assert.ok(
		successRes.content.includes("Você se casou com *Char 2 Raro* (Slot 2)"),
		`Deveria anunciar casamento do Slot 2. Conteúdo: ${successRes.content}`
	);
	assert.strictEqual(retrieved.slots[1].claimed, true, "Slot 2 deve ser marcado como claimed");
	console.log("✓ 4.2 Autor do roll casou com sucesso com o Slot 2 via reação 2️⃣.");

	// 4.3 Tentativa de casar com Slot 2 novamente após já ter sido casado
	const reactMsgRepeat = createMessage({
		content: "Mensagem de roll múltiplo",
		group: testGroupId,
		author: "bot@s.whatsapp.net"
	});
	reactMsgRepeat.id = testMsgId;
	reactMsgRepeat.originReaction = {
		reaction: "2️⃣",
		senderId: otherUser,
		userName: "OutroJogador",
		msgId: { _serialized: testMsgId }
	};

	const alreadyClaimedRes = await WaifuCommands.processWaifuReaction(bot, reactMsgRepeat);
	assert.ok(alreadyClaimedRes, "Deve retornar aviso de já casado");
	assert.ok(
		alreadyClaimedRes.content.includes("já foi casado por outro jogador"),
		`Deveria informar que já foi casado. Retornou: ${alreadyClaimedRes.content}`
	);
	console.log("✓ 4.3 Slot já casado rejeitou nova tentativa de casamento.");

	// 4.4 Decisão 2 do usuário: Reação 💍 em mensagem de multi-roll deve ser IGNORADA
	const reactMsgRing = createMessage({
		content: "Mensagem de roll múltiplo",
		group: testGroupId,
		author: "bot@s.whatsapp.net"
	});
	reactMsgRing.id = testMsgId;
	reactMsgRing.originReaction = {
		reaction: "💍",
		senderId: rollerUser,
		userName: "TestRoller",
		msgId: { _serialized: testMsgId }
	};

	const ringRes = await WaifuCommands.casarWaifu(bot, reactMsgRing, []);
	assert.strictEqual(ringRes, false, "Reação 💍 em multi-roll DEVE ser ignorada (retornar false)");
	console.log("✓ 4.4 Reação 💍 em mensagem de multi-roll foi ignorada com sucesso.");

	// ─── TESTE 5: Compatibilidade Estrita entre ReactionsHandler e ListCommands ─
	console.log("\n[Teste 5] Validando compatibilidade estrita com ListCommands.js...");
	const ReactionsHandler = require("../ReactionsHandler");
	const reactionsHandler = new ReactionsHandler();
	await reactionsHandler.loadCommands();

	// Verifica se 1️⃣ e 2️⃣ estão mapeados para múltiplos comandos
	const triggers1 = reactionsHandler.reactionCommands["1️⃣"];
	assert.ok(Array.isArray(triggers1), "reactionCommands['1️⃣'] deve ser um array");
	assert.ok(
		triggers1.includes("reactionListHelper"),
		"Triggers de 1️⃣ deve incluir reactionListHelper"
	);
	assert.ok(
		triggers1.includes("reactionWaifuHelper"),
		"Triggers de 1️⃣ deve incluir reactionWaifuHelper"
	);
	console.log(
		"✓ 5.1 Emoji 1️⃣ mapeado simultaneamente para ListCommands e WaifuCommands:",
		triggers1
	);

	// 5.2 Reação em mensagem que NÃO é lista nem waifu roll deve retornar false
	const dummyReact = {
		reaction: "1️⃣",
		senderId: otherUser,
		msgId: { _serialized: "MSG_QUALQUER_123" }
	};
	const dummyHandled = await reactionsHandler.processReaction(bot, dummyReact);
	assert.strictEqual(dummyHandled, false, "Reação em mensagem comum não deve ser tratada");
	console.log("✓ 5.2 Reação em mensagem comum retornou false sem colidir.");

	// 5.3 Reação numérica em mensagem de mídia onde body é um objeto (ex: imagem com caption)
	bot.client = {
		getMessageById: async () => ({
			id: "MSG_MEDIA_OBJ_1",
			fromMe: true,
			body: { mimetype: "image/jpeg", url: "https://example.com/img.jpg" },
			caption: "🎲 Multi-Roll Waifu",
			type: "image"
		})
	};
	const ListCommands = require("../functions/ListCommands");
	const listCmd = ListCommands.commands.find((c) => c.name === "reactionListHelper");
	const mediaReactionMsg = {
		originReaction: {
			reaction: "4️⃣",
			senderId: otherUser,
			msgId: { _serialized: "MSG_MEDIA_OBJ_1" }
		}
	};
	const listResult = await listCmd.method(bot, mediaReactionMsg, [], null);
	assert.strictEqual(
		listResult,
		false,
		"Deve retornar false graciosamente para mídia que não é lista"
	);
	console.log(
		"✓ 5.3 Reação 4️⃣ em mensagem de mídia com body objeto não lança erro no ListCommands."
	);

	// 5.4 Validação de fuso horário brasileiro em cooldowns (UTC 00:34 -> SP 21:34)
	const utcDate = new Date("2026-10-19T00:34:00.000Z");
	const formattedSP = utcDate.toLocaleTimeString("pt-BR", {
		timeZone: "America/Sao_Paulo",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false
	});
	assert.strictEqual(
		formattedSP,
		"21:34",
		"Horário UTC 00:34 deve ser convertido para 21:34 no fuso de São Paulo"
	);
	console.log("✓ 5.4 Fuso horário America/Sao_Paulo validado com sucesso (21:34).");

	// ─── TESTE 6: Isolamento de isFreeRoll / bônus da fazenda em Multi-Roll ──
	console.log("\n[Teste 6] Validando que isFreeRoll da fazenda não vaza para rolls 2..9...");
	const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
	const DonorBonusService = require("../services/DonorBonusService");
	const GameEventService = require("../services/GameEventService");

	// 6.1 Unitário de buildStepRollBonuses
	const bWithFarm = WaifuCommands.buildStepRollBonuses(null, { rolls: 1, tickets: 0 }, 1.0, 1.0);
	assert.strictEqual(
		bWithFarm.isFreeRoll,
		true,
		"Roll com bônus da fazenda deve marcar isFreeRoll"
	);
	const bWithoutFarm = WaifuCommands.buildStepRollBonuses(null, null, 1.0, 1.0);
	assert.strictEqual(
		bWithoutFarm,
		null,
		"Roll sem doador, sem fazenda e sem evento deve retornar null"
	);
	const bDonorWithoutFarm = WaifuCommands.buildStepRollBonuses(
		{ donorBadge: "VIP", rarityMultipliers: { RARE: 1.2, EPIC: 1.3, LEGENDARY: 1.5 } },
		null,
		1.0,
		1.0
	);
	assert.strictEqual(
		bDonorWithoutFarm.isFreeRoll,
		undefined,
		"Roll de doador sem fazenda não deve ter isFreeRoll"
	);

	// 6.2 Simulação completa !mu-r 9 com 1 roll de fazenda (Coração Púrpuro) e 9/9 rolls normais
	const origGetWaifuBonus = ShadowGardenBonusService.getWaifuBonus;
	const origReserveWaifuBonus = ShadowGardenBonusService.reserveWaifuBonus;
	const origRefundWaifuBonus = ShadowGardenBonusService.refundWaifuBonus;
	const origGetDonorBonuses = DonorBonusService.getWaifuRollBonuses;
	const origGetEventMult = GameEventService.getMultiplier;
	const origBuildGrid = WaifuCommands.buildRollGridImage;

	try {
		let farmRollsLeft = 1;
		let farmTicketsLeft = 0;
		let standardRollsLeft = 9;
		const capturedPayloads = [];

		ShadowGardenBonusService.getWaifuBonus = async () => ({
			rolls: farmRollsLeft,
			tickets: farmTicketsLeft
		});
		const farmRefunds = [];
		// Reserva atômica (ticket primeiro) e devolução, espelhando o ShadowGardenBonusService
		ShadowGardenBonusService.reserveWaifuBonus = async () => {
			if (farmTicketsLeft > 0) {
				farmTicketsLeft--;
				return { reserved: true, type: "ticket" };
			}
			if (farmRollsLeft > 0) {
				farmRollsLeft--;
				return { reserved: true, type: "roll" };
			}
			return { reserved: false };
		};
		ShadowGardenBonusService.refundWaifuBonus = async (uid, type) => {
			farmRefunds.push(type);
			if (type === "ticket") farmTicketsLeft++;
			if (type === "roll") farmRollsLeft++;
			return true;
		};
		DonorBonusService.getWaifuRollBonuses = async () => null;
		GameEventService.getMultiplier = () => 1.0;
		// O handler chama o renderizador via module.exports, então este mock evita rodar o sharp real
		let gridRenderCalls = 0;
		WaifuCommands.buildRollGridImage = async () => {
			gridRenderCalls++;
			return Buffer.from("fake-grid-leak-test");
		};

		// Comportamentos por chamada de /roll (índice 1-based): "mythic", "throw" ou "fail"
		let rollScript = {};
		WaifuCommands.api.post = async (path, body) => {
			if (path === "/kakera/daily" || path === "/user/ensure") {
				return { data: { success: true } };
			}
			if (path === "/roll") {
				capturedPayloads.push(JSON.parse(JSON.stringify(body)));
				const scripted = rollScript[capturedPayloads.length];
				if (scripted === "throw") {
					throw new Error("Waifuletes indisponível (simulado)");
				}
				if (scripted === "fail") {
					return { data: { success: false, error: { code: "INTERNAL_ERROR" } } };
				}
				const isFree = Boolean(body?.bonuses?.isFreeRoll);
				if (!isFree) {
					if (standardRollsLeft <= 0) {
						return { data: { success: false, error: { code: "COOLDOWN_ACTIVE" } } };
					}
					standardRollsLeft--;
				}
				const idx = capturedPayloads.length;
				return {
					data: {
						success: true,
						data: {
							character: {
								id: `char-leak-${idx}`,
								name: `Personagem ${idx}`,
								series: "Série Teste",
								rarity: scripted === "mythic" ? "MYTHIC" : "COMMON",
								imageUrl: null
							},
							available: true,
							isOwner: false,
							rollsRemaining: standardRollsLeft,
							maxRolls: 9
						}
					}
				};
			}
			return originalPost.apply(WaifuCommands.api, [path, body]);
		};

		const multiRollMsg = createMessage({
			content: "!mu-r 9",
			group: testGroupId,
			author: rollerUser
		});
		const leakRes = await WaifuCommands.rollAny(bot, multiRollMsg, ["9"], {
			id: testGroupId,
			filters: { waifuRollMarcar: false }
		});
		assert.ok(leakRes, "Deve retornar resultado do !mu-r 9");
		assert.strictEqual(gridRenderCalls, 1, "O grid deve ser gerado pelo mock (sem sharp real)");
		const leakMain = Array.isArray(leakRes) ? leakRes[0] : leakRes;
		assert.strictEqual(
			leakMain?.content?.data,
			Buffer.from("fake-grid-leak-test").toString("base64"),
			"A mensagem do multi-roll deve usar o grid mockado"
		);
		assert.strictEqual(capturedPayloads.length, 9, "Deve executar os 9 rolls solicitados");
		assert.strictEqual(
			capturedPayloads[0]?.bonuses?.isFreeRoll,
			true,
			"Roll 1 (fazenda) deve enviar isFreeRoll: true"
		);
		for (let idx = 1; idx < capturedPayloads.length; idx++) {
			assert.strictEqual(
				Boolean(capturedPayloads[idx]?.bonuses?.isFreeRoll),
				false,
				`Roll ${idx + 1} NÃO pode vazar isFreeRoll: true após consumo do bônus da fazenda`
			);
		}
		assert.strictEqual(farmRollsLeft, 0, "Deve ter consumido o 1 roll da fazenda");
		assert.strictEqual(
			standardRollsLeft,
			1,
			"Deve ter consumido 8 rolls do cooldown padrão (9 -> 1)"
		);
		console.log(
			"✓ 6.2 !mu-r 9 consumiu 1 roll da fazenda + 8 rolls normais (isFreeRoll não vazou)."
		);

		// 6.3 Ticket da fazenda (Rosa de Sangue) também não pode vazar multiplicadores de raridade para rolls 2..9
		farmRollsLeft = 0;
		farmTicketsLeft = 1;
		standardRollsLeft = 9;
		capturedPayloads.length = 0;

		await WaifuCommands.rollAny(bot, multiRollMsg, ["3"], {
			id: testGroupId,
			filters: { waifuRollMarcar: false }
		});
		assert.strictEqual(capturedPayloads.length, 3, "Deve executar 3 rolls");
		assert.strictEqual(capturedPayloads[0]?.bonuses?.isFreeRoll, true);
		assert.strictEqual(capturedPayloads[0]?.bonuses?.rarityMultipliers?.LEGENDARY, 2.0);
		for (let idx = 1; idx < capturedPayloads.length; idx++) {
			assert.strictEqual(Boolean(capturedPayloads[idx]?.bonuses?.isFreeRoll), false);
			assert.strictEqual(
				capturedPayloads[idx]?.bonuses?.rarityMultipliers,
				undefined,
				`Roll ${idx + 1} não pode herdar rarityMultipliers do ticket da fazenda`
			);
		}
		assert.strictEqual(farmTicketsLeft, 0, "Deve ter consumido 1 ticket da fazenda");
		assert.strictEqual(standardRollsLeft, 7, "Deve ter consumido 2 rolls normais (9 -> 7)");
		console.log("✓ 6.3 Ticket (Rosa de Sangue) não vazou isFreeRoll nem rarityMultipliers.");

		// 6.4 Roll mítico com bônus da fazenda devolve a reserva (míticos não consomem o bônus)
		farmRollsLeft = 1;
		farmTicketsLeft = 0;
		standardRollsLeft = 9;
		capturedPayloads.length = 0;
		farmRefunds.length = 0;
		rollScript = { 1: "mythic" };
		await WaifuCommands.rollAny(bot, multiRollMsg, ["2"], {
			id: testGroupId,
			filters: { waifuRollMarcar: false }
		});
		assert.strictEqual(capturedPayloads.length, 2, "Deve executar 2 rolls");
		assert.strictEqual(capturedPayloads[0]?.bonuses?.isFreeRoll, true, "Roll 1 usa a fazenda");
		assert.deepStrictEqual(farmRefunds, ["roll"], "Roll mítico devolve o bônus reservado");
		assert.strictEqual(
			capturedPayloads[1]?.bonuses?.isFreeRoll,
			true,
			"Bônus devolvido pelo mítico pode ser usado no roll seguinte"
		);
		assert.strictEqual(farmRollsLeft, 0, "Apenas o roll não-mítico consome a fazenda");
		assert.strictEqual(standardRollsLeft, 9, "Nenhum roll normal gasto");
		console.log("✓ 6.4 Roll mítico devolve a reserva da fazenda.");

		// 6.5 Falha no /roll devolve a reserva (sem perder o bônus)
		farmRollsLeft = 1;
		farmTicketsLeft = 0;
		standardRollsLeft = 9;
		capturedPayloads.length = 0;
		farmRefunds.length = 0;
		rollScript = { 1: "throw" };
		await WaifuCommands.rollAny(bot, multiRollMsg, ["1"], {
			id: testGroupId,
			filters: { waifuRollMarcar: false }
		});
		assert.deepStrictEqual(farmRefunds, ["roll"], "Erro no /roll deve devolver a reserva");
		assert.strictEqual(farmRollsLeft, 1, "Bônus da fazenda preservado após erro");

		farmRollsLeft = 2;
		capturedPayloads.length = 0;
		farmRefunds.length = 0;
		rollScript = { 2: "fail" };
		await WaifuCommands.rollAny(bot, multiRollMsg, ["3"], {
			id: testGroupId,
			filters: { waifuRollMarcar: false }
		});
		assert.strictEqual(capturedPayloads.length, 2, "Lote para no roll que falhou");
		assert.deepStrictEqual(farmRefunds, ["roll"], "Roll 2 sem sucesso devolve a reserva");
		assert.strictEqual(farmRollsLeft, 1, "Só o roll 1 consumiu a fazenda");
		rollScript = {};
		console.log("✓ 6.5 Falhas no /roll (exceção e success:false) devolvem a reserva.");
	} finally {
		ShadowGardenBonusService.getWaifuBonus = origGetWaifuBonus;
		ShadowGardenBonusService.reserveWaifuBonus = origReserveWaifuBonus;
		ShadowGardenBonusService.refundWaifuBonus = origRefundWaifuBonus;
		DonorBonusService.getWaifuRollBonuses = origGetDonorBonuses;
		GameEventService.getMultiplier = origGetEventMult;
		WaifuCommands.buildRollGridImage = origBuildGrid;
	}

	// Restaura mock da API
	WaifuCommands.api.post = originalPost;

	console.log("\n=== Todos os testes de Multi-Roll, Grid e Reações passaram com SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes de Multi-Roll:", err);
	process.exit(1);
});
