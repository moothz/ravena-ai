process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");

async function runTests() {
	console.log("=== Iniciando Teste de Casamento por Slot (!mu-casar <n>) e Reações ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const groupId = "gruporapescas@g.us";
	const userId = "556281501453@s.whatsapp.net";

	const multiRollText = `💍 Solteiros:
1️⃣ ⚪ [Comum] Rikuo Himura — Gohou Drug
> !mu-casar rikuo-himura

2️⃣ 🟢 [Incomum] Eulerex — How NOT to Summon a Demon Lord
> !mu-casar eulerex

3️⃣ ⚪ [Comum] Aidan Unicorn — Might & Magic: Clash of Heroes
> !mu-casar aidan-unicorn

4️⃣ 🟢 [Incomum] Bruford — JoJo's Bizarre Adventure: Phantom Blood
> !mu-casar bruford

5️⃣ 🟣 [Épico] Kurt Cobain — Nirvana
> !mu-casar kurt-cobain

6️⃣ 🟢 [Incomum] King Jam — SAND LAND
> !mu-casar king-jam

7️⃣ ⚪ [Comum] Mumuu — Cerberus
> !mu-casar mumuu

8️⃣ 🟢 [Incomum] Atuuda — D.Gray-man
> !mu-casar atuuda

9️⃣ ⚪ [Comum] Igknight Squire — Yu-Gi-Oh! Trading Card Game
> !mu-casar igknight-squire

✨ Fragmentos colhidos: +391 Zinthos

🎟️ Rolls restantes: 0/9`;

	// Mock do endpoint /marry para capturar o characterId enviado
	let capturedMarryCharId = null;
	const originalPost = WaifuCommands.api.post;
	WaifuCommands.api.post = async (endpoint, data) => {
		if (endpoint === "/marry") {
			capturedMarryCharId = data.characterId;
			return {
				data: {
					success: true,
					data: {
						character: {
							id: data.characterId,
							name: data.characterId === "kurt-cobain" ? "Kurt Cobain" : "Rikuo Himura",
							imageUrl: null
						},
						keys: 1,
						isSoulmate: false,
						kakeraBalance: 42404
					}
				}
			};
		}
		return originalPost.call(WaifuCommands.api, endpoint, data);
	};

	try {
		// ─── TESTE 1: Unicode e Variantes de Emojis Numéricos ────────────────
		console.log("\n[Teste 1] Validando getSlotNumberFromEmoji com todas as variantes de 1 a 9...");
		const standard = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
		const withoutFe0f = ["1⃣", "2⃣", "3⃣", "4⃣", "5⃣", "6⃣", "7⃣", "8⃣", "9⃣"];
		for (let i = 1; i <= 9; i++) {
			assert.strictEqual(
				WaifuCommands.getSlotNumberFromEmoji(standard[i - 1]),
				i,
				`Emoji padrão ${standard[i - 1]} deve mapear para slot ${i}`
			);
			assert.strictEqual(
				WaifuCommands.getSlotNumberFromEmoji(withoutFe0f[i - 1]),
				i,
				`Emoji sem FE0F ${withoutFe0f[i - 1]} deve mapear para slot ${i}`
			);
		}
		console.log("✓ Teste 1 passou: Todas as variantes de emojis numéricos 1-9 identificadas.");

		// ─── TESTE 2: !mu-casar 5 citando mensagem SEM cache em memória ───────
		console.log("\n[Teste 2] Validando !mu-casar 5 citando multi-roll sem cache (pós-restart)...");
		capturedMarryCharId = null;
		WaifuCommands.pendingClaims.delete(groupId);

		const msgCasar5 = createMessage({
			content: "!mu-casar 5",
			group: groupId,
			author: userId
		});
		msgCasar5.origin.getQuotedMessage = async () => ({
			id: "STZ_ROLL_MULTI_1",
			caption: multiRollText,
			content: multiRollText
		});

		const res5 = await WaifuCommands.casarWaifu(bot, msgCasar5, ["5"]);
		assert.strictEqual(
			capturedMarryCharId,
			"kurt-cobain",
			`Deve casar com kurt-cobain (slot 5), mas casou com: ${capturedMarryCharId}`
		);
		console.log("✓ Teste 2 passou: !mu-casar 5 casou com Kurt Cobain e NUNCA com Rikuo Himura!");

		// ─── TESTE 3: !mu-casar 99 (slot inexistente) ─────────────────────────
		console.log("\n[Teste 3] Validando !mu-casar 99 em rolagem de 9 slots...");
		capturedMarryCharId = null;
		const msgCasar99 = createMessage({
			content: "!mu-casar 99",
			group: groupId,
			author: userId
		});
		msgCasar99.origin.getQuotedMessage = async () => ({
			id: "STZ_ROLL_MULTI_1",
			caption: multiRollText
		});

		const res99 = await WaifuCommands.casarWaifu(bot, msgCasar99, ["99"]);
		assert.strictEqual(capturedMarryCharId, null, "Não deve chamar /marry para slot inexistente");
		assert.ok(
			res99 && res99.content && res99.content.includes("não encontrado"),
			"Deve retornar mensagem de erro avisando que o slot não foi encontrado"
		);
		console.log("✓ Teste 3 passou: Slot inexistente retorna erro e não casa com slot 1.");

		// ─── TESTE 4: Reação 💍 em mensagem de multi-roll sem cache ───────────
		console.log("\n[Teste 4] Validando reação 💍 em multi-roll sem cache...");
		capturedMarryCharId = null;
		const msgReactRing = createMessage({
			content: multiRollText,
			caption: multiRollText,
			group: groupId,
			author: userId
		});
		msgReactRing.originReaction = {
			reaction: "💍",
			msgId: "STZ_ROLL_MULTI_1",
			senderId: userId
		};
		msgReactRing.id = "STZ_ROLL_MULTI_1";

		const resRing = await WaifuCommands.casarWaifu(bot, msgReactRing, ["💍"]);
		assert.strictEqual(
			resRing,
			false,
			"Reação 💍 em multi-roll DEVE ser ignorada (retornar false)"
		);
		assert.strictEqual(capturedMarryCharId, null, "Reação 💍 NÃO deve casar em multi-roll!");
		console.log("✓ Teste 4 passou: Reação 💍 em multi-roll é ignorada com sucesso.");

		// ─── TESTE 5: Reação 5️⃣ / 5⃣ em multi-roll sem cache ──────────────────
		console.log("\n[Teste 5] Validando reação 5️⃣ e 5⃣ em multi-roll sem cache...");
		capturedMarryCharId = null;
		const msgReact5 = createMessage({
			content: multiRollText,
			caption: multiRollText,
			group: groupId,
			author: userId
		});
		msgReact5.originReaction = {
			reaction: "5⃣", // Variante sem FE0F
			msgId: "STZ_ROLL_MULTI_1",
			senderId: userId
		};
		msgReact5.id = "STZ_ROLL_MULTI_1";

		await WaifuCommands.processWaifuReaction(bot, msgReact5);
		assert.strictEqual(
			capturedMarryCharId,
			"kurt-cobain",
			`Reação numérico do slot 5 deve casar com kurt-cobain, mas casou com: ${capturedMarryCharId}`
		);
		console.log(
			"✓ Teste 5 passou: Reação numérica casou com Kurt Cobain mesmo sem cache em memória."
		);

		// ─── TESTE 6: !mu-casar (sem args) citando multi-roll sem cache ───────
		console.log("\n[Teste 6] Validando !mu-casar sem args citando multi-roll sem cache...");
		capturedMarryCharId = null;
		const msgCasarNoArgs = createMessage({
			content: "!mu-casar",
			group: groupId,
			author: userId
		});
		msgCasarNoArgs.origin.getQuotedMessage = async () => ({
			id: "STZ_ROLL_MULTI_1",
			caption: multiRollText
		});

		const resNoArgs = await WaifuCommands.casarWaifu(bot, msgCasarNoArgs, []);
		assert.strictEqual(capturedMarryCharId, null, "Não deve casar sem especificar o slot!");
		assert.ok(
			resNoArgs && resNoArgs.content && resNoArgs.content.includes("múltiplos personagens livres"),
			"Deve avisar que há múltiplos personagens livres e orientar a reagir ou usar o número"
		);
		console.log(
			"✓ Teste 6 passou: !mu-casar sem args avisa sobre múltiplos personagens e não casa com slot 1."
		);

		console.log("\n=======================================================");
		console.log("🎉 TODOS OS TESTES PASSARAM COM SUCESSO! 🎉");
		console.log("=======================================================\n");
	} finally {
		WaifuCommands.api.post = originalPost;
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
