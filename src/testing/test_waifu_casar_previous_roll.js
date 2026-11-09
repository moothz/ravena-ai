process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");

/**
 * Garante que, após rolar duas vezes seguidas (ex: !mu-rf 9 duas vezes),
 * ainda é possível casar com personagens da rolagem anterior:
 *  - !mu-c N sem citar, quando só a rolagem anterior tem o slot N livre
 *  - !mu-c N sem citar, com o slot livre nas duas rolagens → pede desambiguação
 *  - !mu-c N citando a rolagem anterior
 *  - !mu-casar <slug> de um personagem da rolagem anterior
 */
async function runTests() {
	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const groupId = "grupo-prev-roll@g.us";
	const userId = "5511999999999";
	const now = Date.now();

	const married = [];
	const originalPost = WaifuCommands.api.post;
	WaifuCommands.api.post = async (endpoint, data) => {
		if (endpoint === "/marry") {
			married.push(data.characterId);
			return {
				data: {
					success: true,
					data: {
						character: { id: data.characterId, name: data.characterId },
						keys: 1,
						isSoulmate: false,
						kakeraBalance: 0
					}
				}
			};
		}
		return originalPost(endpoint, data);
	};

	const makeRoll = (prefix, overrides = {}) => {
		const slots = [1, 2, 3].map((slot) => ({
			slot,
			characterId: `${prefix}-${slot}`,
			characterName: `${prefix} ${slot}`,
			series: "Serie",
			available: true,
			claimed: false,
			exclusiveUntil: null,
			...(overrides[slot] || {})
		}));
		return {
			isMultiRoll: true,
			groupId,
			slots,
			characters: slots,
			rollerUserId: userId,
			rollerUserName: "Tester",
			expiresAt: now + 300000
		};
	};

	const register = (msgId, roll) => {
		WaifuCommands.recordRollMessage(
			msgId,
			roll.slots,
			groupId,
			roll.expiresAt,
			roll.rollerUserId,
			null,
			roll.rollerUserName
		);
		roll.slots.forEach((s) => {
			if (s.available) {
				WaifuCommands.activeClaimsByCharGroup.set(`${groupId}:${s.characterId}`, {
					isMultiRoll: true,
					characterId: s.characterId,
					characterName: s.characterName,
					groupId,
					expiresAt: roll.expiresAt
				});
			}
		});
		const list = WaifuCommands.recentMultiRollsByGroup.get(groupId) || [];
		list.push(roll);
		WaifuCommands.recentMultiRollsByGroup.set(groupId, list);
		WaifuCommands.pendingClaims.set(groupId, roll);
	};

	// Rolagem A (antiga) e B (nova). Na B, o slot 2 já tem dono.
	const rollA = makeRoll("anterior");
	const rollB = makeRoll("nova", { 2: { available: false } });
	register("MSG_ROLL_A", rollA);
	register("MSG_ROLL_B", rollB);

	const send = async (content, quotedId = null) => {
		const msg = createMessage({ content, group: groupId, author: `${userId}@s.whatsapp.net` });
		if (quotedId) {
			msg.origin.getQuotedMessage = async () => ({ id: quotedId, caption: "" });
		}
		const res = await WaifuCommands.casarWaifu(bot, msg, content.split(" ").slice(1));
		const ret = Array.isArray(res) ? res[0] : res;
		return String(ret?.options?.caption || ret?.content || "");
	};

	// 1. Slot 2 só está livre na rolagem anterior → casa com ela sem precisar citar
	await send("!mu-c 2");
	assert.strictEqual(
		married.at(-1),
		"anterior-2",
		"!mu-c 2 deveria casar com o slot 2 da rolagem anterior"
	);
	console.log("✓ 1. !mu-c 2 sem citar casou com a rolagem anterior (slot livre só nela).");

	// 2. Slot 1 livre nas duas rolagens → pede desambiguação, não casa
	const countBefore = married.length;
	const ambig = await send("!mu-c 1");
	assert.strictEqual(married.length, countBefore, "Não deveria casar quando o slot é ambíguo");
	assert.ok(ambig.includes("!mu-casar anterior-1") && ambig.includes("!mu-casar nova-1"), ambig);
	console.log("✓ 2. !mu-c 1 ambíguo lista as opções com !mu-casar <nome>.");

	// 3. Citando a rolagem anterior → casa com o slot dela
	await send("!mu-c 3", "MSG_ROLL_A");
	assert.strictEqual(
		married.at(-1),
		"anterior-3",
		"!mu-c 3 citando A deveria casar com anterior-3"
	);
	console.log("✓ 3. !mu-c 3 citando a rolagem anterior casou corretamente.");

	// 4. Agora o slot 3 de A está casado → !mu-c 3 sem citar vai para a nova rolagem
	await send("!mu-c 3");
	assert.strictEqual(
		married.at(-1),
		"nova-3",
		"Com anterior-3 casado, !mu-c 3 deveria ir para nova-3"
	);
	console.log("✓ 4. Slot já casado na rolagem anterior não volta a ser oferecido.");

	// 5. Casar pelo nome (slug) de um personagem da rolagem anterior
	await send("!mu-casar anterior-1");
	assert.strictEqual(married.at(-1), "anterior-1", "!mu-casar <slug> deveria casar com anterior-1");
	console.log("✓ 5. !mu-casar <slug> casou com personagem da rolagem anterior.");

	// 6. Com anterior-1 casado, slot 1 deixa de ser ambíguo
	await send("!mu-c 1");
	assert.strictEqual(married.at(-1), "nova-1", "!mu-c 1 deveria casar com nova-1");
	console.log("✓ 6. Após casar anterior-1, !mu-c 1 vai direto para a nova rolagem.");

	WaifuCommands.api.post = originalPost;
	console.log("\nTodos os testes de casamento em rolagens anteriores passaram!");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
