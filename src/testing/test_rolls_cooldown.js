const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const axios = require("axios");

const WAIFULETES_URL = process.env.WAIFULETES_API_URL || "http://waifuletes-api:3030";
const WAIFULETES_KEY = process.env.WAIFULETES_API_KEY || "waifuletes_secret_token_123456";

async function runRollTests() {
	console.log("=== Testando Novo Sistema de Cooldown e Saldo de Rolls (10 base / 5min) ===");

	const testUser = "5511888887777@s.whatsapp.net";
	const testGroup = "120363777777777777@g.us";
	const logGroup = "120363000000000000@g.us";

	// Resetar cooldowns do usuário de teste na API
	try {
		const res = await axios.post(
			`${WAIFULETES_URL}/admin/cooldown/reset`,
			{ userId: testUser, type: "roll" },
			{ headers: { Authorization: `Bearer ${WAIFULETES_KEY}` } }
		);
		console.log("✓ Reset de cooldowns do usuário de teste realizado com sucesso.");
	} catch (e) {
		console.warn("⚠️ Falha ao resetar cooldowns do usuário de teste:", e.message);
	}

	const bot = new FakeBot({ id: "test-roll-bot", grupoLogs: logGroup });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	async function waitForReply(maxMs = 20000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length > 0) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 100));
		}
		return bot.capturedMessages;
	}

	// 1. Executar rolls respeitando o cooldown de 5s entre comandos
	console.log("[Teste Roll 1] Executando 10 rolls sequenciais...");
	let currentRollCount = 0;
	let attempts = 0;

	while (currentRollCount < 10 && attempts < 25) {
		attempts++;
		eventHandler.commandHandler.userDebounceMap.clear();
		bot.resetCapture();

		const msg = createMessage({
			content: "!mu-roll",
			author: testUser,
			authorName: "RollTester",
			group: testGroup
		});

		await eventHandler.processMessage(bot, msg);
		await waitForReply();
		if (bot.capturedMessages.length === 0) continue;

		const captured = bot.capturedMessages[0];
		const replyText = typeof captured.content === "string" ? captured.content : (captured.options?.caption || "");

		if (replyText.includes("Rolls restantes")) {
			currentRollCount++;
			const expectedRemaining = 10 - currentRollCount;
			assert.ok(
				replyText.includes(`${expectedRemaining}/10`),
				`Roll ${currentRollCount} deve mostrar ${expectedRemaining}/10 (recebido: ${replyText})`
			);
			console.log(`✓ Roll ${currentRollCount}/10 executado com sucesso: ${expectedRemaining}/10 restantes.`);
			// Aguarda 5.2s para passar o cooldown de anti-spam
			await new Promise((r) => setTimeout(r, 5200));
		} else if (replyText.includes("cooldown por mais")) {
			await new Promise((r) => setTimeout(r, 3000));
		} else if (replyText.includes("Sem rolls disponíveis")) {
			break;
		}
	}

	assert.strictEqual(currentRollCount, 10, "Devem ser executados exatamente 10 rolls com sucesso");

	// 2. Executar o 11º roll (deve dar Sem rolls disponíveis - 0/10)
	console.log("[Teste Roll 2] Executando 11º roll (esperando bloqueio 0/10)...");
	await new Promise((r) => setTimeout(r, 5200));
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();

	const msgBlock = createMessage({
		content: "!mu-roll",
		author: testUser,
		authorName: "RollTester",
		group: testGroup
	});

	await eventHandler.processMessage(bot, msgBlock);
	await waitForReply();
	assert.strictEqual(bot.capturedMessages.length, 1, "Roll bloqueado deve gerar 1 mensagem");
	const capturedBlock = bot.capturedMessages[0];
	const blockText = typeof capturedBlock.content === "string" ? capturedBlock.content : (capturedBlock.options?.caption || "");

	assert.ok(blockText.includes("Sem rolls disponíveis"), "Deve conter 'Sem rolls disponíveis!'");
	assert.ok(blockText.includes("Próximo roll em"), "Deve informar tempo até o próximo roll");
	assert.ok(blockText.includes("10/10"), "Deve informar recarga dos 10/10 rolls");
	console.log(`✓ 11º Roll bloqueado corretamente:\n${blockText}`);

	// 3. Consultar !mu-cooldowns com 0 rolls
	console.log("[Teste Roll 3] Consultando !mu-cooldowns...");
	eventHandler.commandHandler.userDebounceMap.clear();
	bot.resetCapture();

	const msgCd = createMessage({
		content: "!mu-cooldowns",
		author: testUser,
		authorName: "RollTester",
		group: testGroup
	});

	await eventHandler.processMessage(bot, msgCd);
	await waitForReply();
	assert.strictEqual(bot.capturedMessages.length, 1, "!mu-cooldowns deve gerar 1 mensagem");
	const capturedCd = bot.capturedMessages[0];
	const cdText = typeof capturedCd.content === "string" ? capturedCd.content : (capturedCd.options?.caption || "");

	assert.ok(cdText.includes("0/10 rolls"), "!mu-cooldowns deve mostrar 0/10 rolls");
	console.log(`✓ !mu-cooldowns validado:\n${cdText}`);

	console.log("=== TODOS OS TESTES DE ROLLS PASSARAM COM SUCESSO! ===");
}

runRollTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes de rolls:", err);
		process.exit(1);
	});
