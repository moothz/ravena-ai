process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.WAIFULETES_WEB_URL = "https://waifuletes.moothz.com";
process.env.WAIFULETES_API_KEY = process.env.WAIFULETES_API_KEY || "teste";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");
const Group = require("../models/Group");

const WEB_BASE = "https://waifuletes.moothz.com";

async function runTests() {
	console.log(
		"=== Teste de legenda de roll: link do personagem, raridade por emoji e dica !mu-c ==="
	);

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const groupId = "12036304@g.us";
	const userAdmin = "5511977770003";

	const groupObj = new Group({
		id: groupId,
		name: "Grupo de Teste",
		additionalAdmins: [userAdmin],
		filters: { waifuRollMarcar: true }
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

	// ─── Mock da API Waifuletes ──────────────────────────────────────────────
	const chars = [
		{
			id: "momoka-sagara",
			name: "Momoka Sagara",
			series: "To Heart",
			rarity: "COMMON",
			imageUrl: null
		},
		{
			id: "artoria-pendragon",
			name: "Artoria Pendragon",
			series: "Fate/stay night",
			rarity: "RARE",
			imageUrl: null
		},
		{
			id: "marido-casado",
			name: "Personagem Casado",
			series: "Série Teste",
			rarity: "COMMON",
			imageUrl: null
		}
	];

	let rollCallIndex = 0;
	const originalPost = WaifuCommands.api.post;
	WaifuCommands.api.post = async (url, payload) => {
		if (url === "/roll") {
			const char = chars[rollCallIndex % chars.length];
			rollCallIndex += 1;
			const isFirstFree = rollCallIndex <= 2;
			return {
				data: {
					success: true,
					data: {
						character: char,
						available: isFirstFree,
						isOwner: false,
						isWishlist: rollCallIndex === 2,
						owner: isFirstFree ? null : { id: "outro", name: "Outro Jogador" },
						rollsRemaining: 5,
						maxRolls: 9
					}
				}
			};
		}
		if (url === "/kakera/daily" || url === "/user/ensure") {
			return { data: { success: true } };
		}
		return originalPost(url, payload);
	};

	WaifuCommands.buildRollGridImage = async () => Buffer.from("fake-grid");

	const msgRoll = createMessage({
		content: "!mu-roll",
		author: userAdmin,
		group: groupId
	});

	// ─── 1. Roll único: link da página + rótulo de raridade preservado ───────
	console.log("1. Testando !mu-roll (personagem único)...");
	rollCallIndex = 0;
	const singleRes = await WaifuCommands.rollAny(bot, msgRoll, [], groupObj);
	const singleReturn = Array.isArray(singleRes) ? singleRes[0] : singleRes;
	const singleText = singleReturn.options?.caption || singleReturn.content;

	const expectedSingleUrl = `${WEB_BASE}/character/momoka-sagara`;
	assert.ok(
		singleText.includes(expectedSingleUrl),
		`Roll único deveria conter o link ${expectedSingleUrl}. Texto:\n${singleText}`
	);
	assert.ok(
		singleText.includes("[Comum]"),
		`Roll único deve manter o rótulo de raridade. Texto:\n${singleText}`
	);
	console.log(`✓ 1.1. Roll único mantém [Comum] e contém o link: ${expectedSingleUrl}`);

	assert.strictEqual(
		WaifuCommands.extractCharacterFromRollText(singleText),
		"momoka-sagara",
		"Parser de roll único deve continuar extraindo o ID do personagem"
	);
	console.log("✓ 1.2. extractCharacterFromRollText continua funcionando após o link.");

	// ─── 2. Multi-roll: sem [Raridade], com !mu-casar <id>, link e dica !mu-c ─
	console.log("2. Testando !mu-roll 3 (rolls múltiplos)...");
	rollCallIndex = 0;
	const msgMulti = createMessage({
		content: "!mu-roll 3",
		author: userAdmin,
		group: groupId
	});

	const multiRes = await WaifuCommands.rollAny(bot, msgMulti, ["3"], groupObj);
	const multiReturn = Array.isArray(multiRes) ? multiRes[0] : multiRes;
	const multiText = multiReturn.options?.caption || multiReturn.content;

	["momoka-sagara", "artoria-pendragon"].forEach((id) => {
		assert.ok(
			multiText.includes(`> ${WEB_BASE}/character/${id}`),
			`Multi-roll deveria trazer o link de ${id}. Texto:\n${multiText}`
		);
	});
	console.log("✓ 2.1. Multi-roll traz o link da página de cada personagem livre.");

	["momoka-sagara", "artoria-pendragon"].forEach((id) => {
		assert.ok(
			multiText.includes(`> !mu-casar ${id}`),
			`Multi-roll deve listar "> !mu-casar ${id}" para casar pelo nome. Texto:\n${multiText}`
		);
	});
	console.log('✓ 2.2. Linha "> !mu-casar <id>" presente para cada personagem livre.');

	assert.ok(
		!/\[(Comum|Raro|Incomum|Épico|Lendário)\]/.test(multiText),
		`Multi-roll não deve trazer rótulo de raridade entre colchetes. Texto:\n${multiText}`
	);
	assert.ok(
		multiText.includes("🔵 Artoria Pendragon — Fate/stay night"),
		`Slot deve mostrar apenas o emoji de raridade. Texto:\n${multiText}`
	);
	console.log("✓ 2.3. Raridade exibida apenas pelo emoji (⚪🔵...) sem [Comum]/[Raro].");

	const hint =
		"*Para Casar*: Reagir com o emoji do número, responder a mensagem com !mu-c # (número do personagem) ou usar !mu-casar <nome>";
	assert.ok(
		multiText.includes(hint),
		`Multi-roll deve trazer a dica de casamento. Texto:\n${multiText}`
	);
	const hintPos = multiText.indexOf(hint);
	const lastLinkPos = multiText.lastIndexOf(`> ${WEB_BASE}/character/`);
	const casadosPos = multiText.indexOf("💔 *Casados:*");
	assert.ok(hintPos > lastLinkPos, "A dica *Para Casar* deve vir após a lista de solteiros.");
	assert.ok(
		casadosPos === -1 || hintPos < casadosPos,
		"A dica *Para Casar* deve vir antes da seção de casados."
	);
	console.log('✓ 2.4. Dica "*Para Casar* ..." posicionada no final da lista de solteiros.');

	// ─── 3. Parsers (citação/reactions/denúncia) continuam resolvendo slots ──
	const parsedSlots = WaifuCommands.extractMultiRollSlotsFromText(multiText);
	assert.strictEqual(
		parsedSlots.length,
		3,
		`Deveria extrair 3 slots. Obtido: ${parsedSlots.length}`
	);
	["momoka-sagara", "artoria-pendragon"].forEach((id) => {
		assert.ok(
			parsedSlots.some((s) => s.characterId === id),
			`Slot com ID ${id} deveria ser resolvido pelo link. Slots: ${JSON.stringify(parsedSlots)}`
		);
	});
	const marriedSlot = parsedSlots.find((s) => s.slot === 3);
	assert.strictEqual(
		marriedSlot?.characterName,
		"Personagem Casado",
		`Slot casado deve ser parseado. Slot: ${JSON.stringify(marriedSlot)}`
	);
	assert.strictEqual(
		marriedSlot?.characterId,
		null,
		"Slot casado não possui link/ID (mesmo comportamento anterior)"
	);
	const artoriaSlot = parsedSlots.find((s) => s.characterId === "artoria-pendragon");
	assert.strictEqual(
		artoriaSlot.rarity,
		"RARE",
		`Raridade deve ser detectada pelo emoji. Slot: ${JSON.stringify(artoriaSlot)}`
	);
	const momokaSlot = parsedSlots.find((s) => s.characterId === "momoka-sagara");
	assert.strictEqual(
		momokaSlot.characterName,
		"Momoka Sagara",
		`Nome deve ser extraído sem o rótulo de raridade. Slot: ${JSON.stringify(momokaSlot)}`
	);
	console.log(
		"✓ 3.1. extractMultiRollSlotsFromText resolve IDs pelos links e raridade pelos emojis."
	);

	// ─── 4. Formato antigo (com !mu-casar e rótulo) continua parseável ───────
	const legacyText = [
		"🎲 Waifuletes! *2* rolls:",
		"",
		"1️⃣ ⚪ [Comum] Sakura Shinomura — Anime Teste",
		"> !mu-casar sakura-shinomura",
		"",
		"2️⃣ 🟣 [Épico] Kurt Cobain — Série Teste",
		"> !mu-casar kurt-cobain"
	].join("\n");
	const legacySlots = WaifuCommands.extractMultiRollSlotsFromText(legacyText);
	assert.strictEqual(
		legacySlots.length,
		2,
		"Legenda antiga (com !mu-casar) deve continuar parseável"
	);
	assert.strictEqual(legacySlots[0]?.characterId, "sakura-shinomura");
	assert.strictEqual(legacySlots[1]?.characterId, "kurt-cobain");
	assert.strictEqual(legacySlots[1]?.rarity, "EPIC");
	console.log("✓ 4.1. Legendas antigas (com !mu-casar e [Raridade]) seguem parseáveis.");

	// ─── 5. getCharacterWebUrl / parse fazem encode e decode do slug ─────────
	const customUrl = WaifuCommands.getCharacterWebUrl("waifu especial/2");
	assert.strictEqual(customUrl, `${WEB_BASE}/character/waifu%20especial%2F2`);
	const encodedSlots = WaifuCommands.extractMultiRollSlotsFromText(
		[
			"🎲 Waifuletes! *2* rolls:",
			"1️⃣ ⚪ Nome Um — Serie",
			`> ${WEB_BASE}/character/waifu%20especial%2F2`,
			"2️⃣ ⚪ Nome Dois — Serie",
			`> ${WEB_BASE}/character/segundo-id`
		].join("\n")
	);
	assert.strictEqual(
		encodedSlots[0]?.characterId,
		"waifu especial/2",
		"ID com espaços codificado no link deve ser decodificado"
	);
	console.log("✓ 5.1. getCharacterWebUrl e o parser fazem encode/decode do slug.");

	// ─── 6. Fluxo real sem cache: reação no número e !mu-casar <n> citando ───
	console.log("6. Testando casamento por slot a partir da nova legenda (sem cache)...");
	let marriedCharId = null;
	const originalPostForMarry = WaifuCommands.api.post;
	WaifuCommands.api.post = async (endpoint, data) => {
		if (endpoint === "/marry") {
			marriedCharId = data.characterId;
			return {
				data: {
					success: true,
					data: {
						character: {
							id: data.characterId,
							name:
								data.characterId === "artoria-pendragon" ? "Artoria Pendragon" : "Momoka Sagara",
							imageUrl: null
						},
						keys: 1,
						isSoulmate: false,
						kakeraBalance: 100
					}
				}
			};
		}
		return { data: { success: true } };
	};

	try {
		const otherUser = "5511955554444";
		const msgReact = createMessage({
			content: multiText,
			caption: multiText,
			group: groupId,
			author: otherUser
		});
		msgReact.id = "STZ_NEW_FORMAT_ROLL_1";
		msgReact.originReaction = {
			reaction: "2️⃣",
			msgId: "STZ_NEW_FORMAT_ROLL_1",
			senderId: otherUser
		};

		await WaifuCommands.processWaifuReaction(bot, msgReact);
		assert.strictEqual(
			marriedCharId,
			"artoria-pendragon",
			`Reação 2️⃣ na nova legenda deve casar com artoria-pendragon, casou com: ${marriedCharId}`
		);
		console.log("✓ 6.1. Reação 2️⃣ sem cache casou com o personagem do link do slot 2.");

		marriedCharId = null;
		const msgCasarQuote = createMessage({
			content: "!mu-casar 1",
			group: groupId,
			author: otherUser
		});
		msgCasarQuote.origin.getQuotedMessage = async () => ({
			id: { _serialized: "STZ_NEW_FORMAT_ROLL_1" },
			caption: multiText
		});

		await WaifuCommands.casarWaifu(bot, msgCasarQuote, ["1"]);
		assert.strictEqual(
			marriedCharId,
			"momoka-sagara",
			`!mu-casar 1 citando a nova legenda deve casar com momoka-sagara, casou com: ${marriedCharId}`
		);
		console.log("✓ 6.2. !mu-casar 1 citando a nova legenda casou com o personagem do slot 1.");
	} finally {
		WaifuCommands.api.post = originalPostForMarry;
	}

	console.log("=== Todos os testes de legenda de roll passaram ===");
	WaifuCommands.api.post = originalPost;
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHA NO TESTE:", err);
		process.exit(1);
	});
