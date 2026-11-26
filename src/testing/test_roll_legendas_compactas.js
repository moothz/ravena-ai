process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.WAIFULETES_WEB_URL = "https://waifuletes.moothz.com";
process.env.WAIFULETES_API_KEY = process.env.WAIFULETES_API_KEY || "teste";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");
const Group = require("../models/Group");

async function runTests() {
	console.log("=== Teste de legendas compactas do mu-roll (Issue #71) ===");

	// ─── 1. Teste unitário de truncateRollText ───────────────────────────────
	console.log("1. Validando truncateRollText...");
	assert.strictEqual(
		WaifuCommands.truncateRollText("NomeMuitoLongoComMaisDeVinteCaracteres", 20),
		"NomeMuitoLongoComMa…",
		"Deve truncar para 20 caracteres com reticências"
	);
	assert.strictEqual(
		WaifuCommands.truncateRollText("Nome Curto", 20),
		"Nome Curto",
		"Deve manter inalterado se <= 20 caracteres"
	);
	assert.strictEqual(
		WaifuCommands.truncateRollText("ExatamenteVinteChars", 20),
		"ExatamenteVinteChars",
		"Deve manter exatamente 20 caracteres"
	);
	assert.strictEqual(WaifuCommands.truncateRollText("", 20), "");
	assert.strictEqual(WaifuCommands.truncateRollText(null, 20), "");
	assert.strictEqual(WaifuCommands.truncateRollText(undefined, 20), "");
	console.log("✓ 1. truncateRollText funciona corretamente.");

	// ─── Setup de Bot e Mocks ────────────────────────────────────────────────
	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const groupId = "12036304@g.us";
	const userAdmin = "5511977770003";

	const groupObj = new Group({
		id: groupId,
		name: "Grupo de Teste",
		additionalAdmins: [userAdmin],
		filters: { waifuRollMarcar: false }
	});

	bot.database = {
		groups: new Map([[groupId, groupObj]]),
		async getGroup(id) {
			return this.groups.get(id);
		},
		async saveGroup(group) {
			this.groups.set(group.id, group);
			return true;
		}
	};

	const longNameChar = {
		id: "super-long-character-name",
		name: "Super Long Character Name In Full",
		series: "Extremely Long Light Novel Anime Series Title",
		rarity: "RARE",
		imageUrl: null
	};

	const commonChar = {
		id: "short-char",
		name: "Shorty",
		series: "Short Series",
		rarity: "COMMON",
		imageUrl: null
	};

	const slotUm = {
		id: "slot-um",
		numericId: 411111,
		name: "Personagem Um",
		series: "Serie Um",
		rarity: "COMMON",
		imageUrl: null
	};
	const slotDois = {
		id: "slot-dois",
		numericId: 412222,
		name: "Personagem Dois",
		series: "Fate (stay night Heavens Feel)",
		rarity: "COMMON",
		imageUrl: null
	};
	const numericChar = {
		id: "personagem-numerico",
		numericId: 412345,
		name: "Personagem Numerico",
		series: "Serie Numerica",
		rarity: "RARE",
		imageUrl: null
	};

	let rollMode = "single_exclusive";
	let parenRollIndex = 0;
	const marryCalls = [];
	const originalPost = WaifuCommands.api.post;
	WaifuCommands.api.post = async (url, payload) => {
		if (url === "/marry") {
			marryCalls.push(payload);
			return {
				data: {
					data: {
						character: { id: payload.characterId, name: "Casado", rarity: "COMMON" },
						keys: 1,
						isSoulmate: false,
						kakeraBalance: 50
					}
				}
			};
		}
		if (url === "/roll") {
			if (rollMode === "multi_paren" || rollMode === "single_numeric") {
				const character =
					rollMode === "single_numeric" ? numericChar : [slotUm, slotDois][parenRollIndex++ % 2];
				return {
					data: {
						success: true,
						data: {
							character,
							available: true,
							isOwner: false,
							isWishlist: false,
							owner: null,
							rollsRemaining: 2,
							maxRolls: 10
						}
					}
				};
			}
			if (rollMode === "single_exclusive") {
				return {
					data: {
						success: true,
						data: {
							character: longNameChar,
							available: true,
							isOwner: false,
							isWishlist: false,
							owner: null,
							rollsRemaining: 4,
							maxRolls: 10
						}
					}
				};
			}
			if (rollMode === "single_free") {
				return {
					data: {
						success: true,
						data: {
							character: commonChar,
							available: true,
							isOwner: false,
							isWishlist: false,
							owner: null,
							rollsRemaining: 3,
							maxRolls: 10
						}
					}
				};
			}
			if (rollMode === "multi") {
				return {
					data: {
						success: true,
						data: {
							character: longNameChar,
							available: true,
							isOwner: false,
							isWishlist: false,
							owner: null,
							rollsRemaining: 2,
							maxRolls: 10
						}
					}
				};
			}
		}
		if (url === "/kakera/daily" || url === "/user/ensure") {
			return { data: { success: true } };
		}
		return originalPost(url, payload);
	};

	WaifuCommands.buildRollGridImage = async () => Buffer.from("fake-grid");

	// ─── 2. Roll único com raridade exclusiva (Raro/60s) ────────────────────
	console.log("2. Validando roll único exclusivo...");
	rollMode = "single_exclusive";
	const msgSingle = createMessage({
		content: "!mu-roll",
		author: userAdmin,
		group: groupId
	});

	const singleRes = await WaifuCommands.rollAny(bot, msgSingle, [], groupObj);
	const singleRet = Array.isArray(singleRes) ? singleRes[0] : singleRes;
	const singleText = singleRet.options?.caption || singleRet.content;

	// Nome truncado para max 20
	assert.ok(
		singleText.includes("*Super Long Characte…*"),
		`Nome deve estar truncado em 20 chars. Texto:\n${singleText}`
	);
	assert.ok(
		!singleText.includes("Super Long Character Name In Full"),
		"Não deve conter o nome longo completo"
	);

	// Série truncada para max 20
	assert.ok(
		singleText.includes("_Extremely Long Ligh…_"),
		`Série deve estar truncada em 20 chars. Texto:\n${singleText}`
	);
	assert.ok(
		!singleText.includes("Extremely Long Light Novel Anime Series Title"),
		"Não deve conter o título longo completo da série"
	);

	// Não exibir instrução !mu-casar <id/nome>
	assert.ok(!singleText.includes(`!mu-casar ${longNameChar.id}`), "Não deve exibir !mu-casar <id>");
	assert.ok(
		!singleText.includes(`!mu-casar ${longNameChar.name}`),
		"Não deve exibir !mu-casar <nome>"
	);

	// Compactar exclusivo para (60s 🔐)
	assert.ok(
		singleText.includes("(60s 🔐)"),
		`Exclusividade deve ser compactada para (60s 🔐). Texto:\n${singleText}`
	);
	assert.ok(
		!singleText.includes("tem 60s de exclusividade para casar!"),
		"Não deve conter texto verboso de exclusividade"
	);
	console.log("✓ 2. Roll único exclusivo formatado corretamente com truncamento e (60s 🔐).");

	// ─── 3. Roll único comum/livre ───────────────────────────────────────────
	console.log("3. Validando roll único comum/livre...");
	rollMode = "single_free";
	const singleFreeRes = await WaifuCommands.rollAny(bot, msgSingle, [], groupObj);
	const singleFreeRet = Array.isArray(singleFreeRes) ? singleFreeRes[0] : singleFreeRes;
	const singleFreeText = singleFreeRet.options?.caption || singleFreeRet.content;

	assert.ok(
		singleFreeText.includes("Shorty"),
		`Nome curto deve ser mantido. Texto:\n${singleFreeText}`
	);
	assert.ok(
		!singleFreeText.includes(`!mu-casar ${commonChar.id}`),
		"Não deve conter !mu-casar <id> na mensagem livre"
	);
	assert.ok(
		singleFreeText.includes("Reaja com 💍 ou use `!mu-casar` em até 300s para casar!"),
		`Texto livre deve instruir uso de !mu-casar genérico. Texto:\n${singleFreeText}`
	);
	console.log("✓ 3. Roll único livre limpo de comandos com ID.");

	// ─── 4. Multi-roll: slots compactados ───────────────────────────────────
	console.log("4. Validando multi-roll...");
	rollMode = "multi";
	const msgMulti = createMessage({
		content: "!mu-roll 2",
		author: userAdmin,
		group: groupId
	});

	const multiRes = await WaifuCommands.rollAny(bot, msgMulti, ["2"], groupObj);
	const multiRet = Array.isArray(multiRes) ? multiRes[0] : multiRes;
	const multiText = multiRet.options?.caption || multiRet.content;

	// Slots truncados
	assert.ok(
		multiText.includes("Super Long Characte… — Extremely Long Ligh…"),
		`Slot deve exibir nome e série truncados a 20 chars. Texto:\n${multiText}`
	);

	// Não conter > !mu-casar <id>
	assert.ok(
		!multiText.includes("> !mu-casar"),
		`Multi-roll não deve conter '> !mu-casar <id>'. Texto:\n${multiText}`
	);

	// Exclusividade compactada
	assert.ok(
		multiText.includes("(60s 🔐)"),
		`Multi-roll deve conter tag compacta (60s 🔐). Texto:\n${multiText}`
	);
	assert.ok(!multiText.includes("exclusivo)"), "Multi-roll não deve conter palavra 'exclusivo)'");

	// Dica para casar sem 'ou usar !mu-casar <nome>'
	assert.ok(
		!multiText.includes("ou usar !mu-casar <nome>"),
		`Dica não deve sugerir !mu-casar <nome>. Texto:\n${multiText}`
	);
	assert.ok(
		multiText.includes(
			"*Para Casar*: Reagir com o emoji do número ou responder com !mu-c # (número do personagem)"
		),
		`Dica compacta esperada. Texto:\n${multiText}`
	);
	console.log("✓ 4. Multi-roll possui formato compacto conforme especificação.");

	// ─── 5. Parser de slots a partir do texto compacto ───────────────────────
	console.log("5. Validando parseamento de slots no formato compacto...");
	const parsedSlots = WaifuCommands.extractMultiRollSlotsFromText(multiText);
	assert.strictEqual(parsedSlots.length, 2, "Deve extrair 2 slots");
	assert.strictEqual(
		parsedSlots[0].characterId,
		longNameChar.id,
		"Deve extrair o ID a partir do link web /c/"
	);
	assert.strictEqual(
		parsedSlots[0].characterName,
		"Super Long Characte…",
		"Deve extrair o nome truncado do slot"
	);
	console.log("✓ 5. Parser de multi-roll extraiu os slots com sucesso.");

	console.log("6. Validando corte por grafema e sem espaço antes das reticências...");
	const emojiCut = WaifuCommands.truncateRollText("Abcdefghijklmnopqr🎮 Game", 20);
	assert.strictEqual(emojiCut, "Abcdefghijklmnopqr🎮…");
	assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emojiCut), "Não deve partir emoji");
	assert.strictEqual(
		WaifuCommands.truncateRollText("Amelie Josefine Pi da Silva", 20),
		"Amelie Josefine Pi…"
	);
	console.log("✓ 6. Corte preserva emoji e não deixa espaço antes do fechamento do negrito.");

	console.log("7. Validando série com parêntese cortado no multi-roll...");
	rollMode = "multi_paren";
	parenRollIndex = 0;
	const parenRes = await WaifuCommands.rollAny(bot, msgMulti, ["2"], groupObj);
	const parenRet = Array.isArray(parenRes) ? parenRes[0] : parenRes;
	const parenText = parenRet.options?.caption || parenRet.content;
	assert.ok(
		parenText.includes("Fate (stay night He…"),
		`Série cortada esperada. Texto:\n${parenText}`
	);
	const parenSlots = WaifuCommands.extractMultiRollSlotsFromText(parenText);
	assert.deepStrictEqual(
		parenSlots.map((s) => [s.slot, s.characterId]),
		[
			[1, "411111"],
			[2, "412222"]
		],
		`Cada slot deve manter o próprio link. Texto:\n${parenText}`
	);
	const brokenSlots = WaifuCommands.extractMultiRollSlotsFromText(
		[
			"🎲 Waifuletes! *2* rolls:",
			"1️⃣ 💖 Personagem Um — Serie Um (🔑 Chaves: 1/10)",
			"2️⃣ ⚪ ***",
			"> https://waifuletes.moothz.com/c/412222"
		].join("\n")
	);
	assert.strictEqual(
		brokenSlots[0].characterId,
		null,
		"Link de slot ilegível não passa ao anterior"
	);
	marryCalls.length = 0;
	const replySlot = createMessage({ content: "!mu-c 2", author: userAdmin, group: groupId });
	replySlot.origin.getQuotedMessage = async () => ({
		id: { _serialized: "rolagem-fora-do-cache-1" },
		caption: parenText
	});
	await WaifuCommands.casarWaifu(bot, replySlot, ["2"]);
	assert.deepStrictEqual(
		marryCalls.map((c) => c.characterId),
		["412222"],
		"!mu-c 2 deve casar o personagem do slot 2"
	);
	console.log("✓ 7. Slot com série cortada é lido e casa o personagem certo.");

	console.log("8. Validando casamento pelo nome exibido...");
	for (const typed of ["Super Long Characte…", "super long characte"]) {
		rollMode = "single_exclusive";
		await WaifuCommands.rollAny(bot, msgSingle, [], groupObj);
		marryCalls.length = 0;
		const byName = createMessage({
			content: `!mu-casar ${typed}`,
			author: userAdmin,
			group: groupId
		});
		await WaifuCommands.casarWaifu(bot, byName, typed.split(" "));
		assert.deepStrictEqual(
			marryCalls.map((c) => c.characterId),
			[longNameChar.id],
			`"${typed}" deve casar ${longNameChar.id}`
		);
	}
	console.log("✓ 8. Nome truncado da legenda resolve para o id do personagem.");

	console.log("9. Validando link numérico contra a reserva exclusiva...");
	rollMode = "single_numeric";
	const numericRes = await WaifuCommands.rollAny(bot, msgSingle, [], groupObj);
	const numericRet = Array.isArray(numericRes) ? numericRes[0] : numericRes;
	const numericText = numericRet.options?.caption || numericRet.content;
	assert.ok(numericText.includes("/c/412345"), `Link numérico esperado. Texto:\n${numericText}`);
	marryCalls.length = 0;
	const otherQuote = createMessage({
		content: "!mu-casar",
		author: "5511999990002",
		group: groupId
	});
	otherQuote.origin.getQuotedMessage = async () => ({
		id: { _serialized: "rolagem-fora-do-cache-2" },
		caption: numericText
	});
	const otherRes = await WaifuCommands.casarWaifu(bot, otherQuote, []);
	const otherContent = (Array.isArray(otherRes) ? otherRes[0] : otherRes)?.content || "";
	assert.strictEqual(marryCalls.length, 0, "Não deve chamar /marry durante a exclusividade");
	assert.ok(
		/exclusiv/i.test(otherContent),
		`Deve avisar a exclusividade. Resposta: ${otherContent}`
	);
	console.log("✓ 9. Link com numericId encontra a reserva e respeita a exclusividade.");

	WaifuCommands.api.post = originalPost;
	console.log("=== Todos os testes de legendas compactas passaram! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHA NO TESTE:", err);
		process.exit(1);
	});
