"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Command = require("../models/Command");
const CommandHandler = require("../CommandHandler");
const Stickers = require("../functions/Stickers");
const ImageManipulation = require("../functions/ImageManipulation");
const WhatsAppBotGo = require("../WhatsAppBotGo");

async function runTests() {
	console.log("=== INICIANDO TESTES DE COOLDOWN PV E ESPAÇAMENTO DE STICKERS ===");

	// 1. Teste de modelo Command com cooldownPV
	console.log("\n[1] Testando instanciação de Command com cooldownPV...");
	const cmdSticker = new Command({
		name: "test-sticker",
		cooldown: 5,
		cooldownPV: 0,
		run: async () => {}
	});
	assert.strictEqual(cmdSticker.cooldown, 5, "cooldown normal deve ser 5");
	assert.strictEqual(cmdSticker.cooldownPV, 0, "cooldownPV deve ser 0");

	const cmdNormal = new Command({
		name: "test-normal",
		cooldown: 20,
		run: async () => {}
	});
	assert.strictEqual(cmdNormal.cooldown, 20, "cooldown normal deve ser 20");
	assert.strictEqual(
		cmdNormal.cooldownPV,
		undefined,
		"cooldownPV deve ser undefined quando não informado"
	);
	console.log("✓ Modelo Command instanciado corretamente com cooldownPV");

	// 2. Teste de Comandos Reais de Stickers e ImageManipulation
	console.log("\n[2] Verificando comandos exportados de Stickers e ImageManipulation...");
	const stickerCommands = Stickers.commands || [];
	assert(stickerCommands.length > 0, "Deve haver comandos em Stickers.js");
	const testStickerNames = ["sticker", "s", "fig", "sqi", "shq"];
	for (const name of testStickerNames) {
		const found = stickerCommands.find((c) => c.name === name);
		assert(found, `Comando '${name}' deve existir em Stickers.js`);
		assert.strictEqual(found.cooldown, 5, `Comando '${name}' deve ter cooldown: 5`);
		assert.strictEqual(found.cooldownPV, 0, `Comando '${name}' deve ter cooldownPV: 0`);
	}

	const imgCommands = ImageManipulation.commands || [];
	const testImgNames = ["stickerbg", "sbg"];
	for (const name of testImgNames) {
		const found = imgCommands.find((c) => c.name === name);
		assert(found, `Comando '${name}' deve existir em ImageManipulation.js`);
		assert.strictEqual(found.cooldown, 5, `Comando '${name}' deve ter cooldown: 5`);
		assert.strictEqual(found.cooldownPV, 0, `Comando '${name}' deve ter cooldownPV: 0`);
	}
	console.log("✓ Comandos de figurinha possuem cooldown: 5 e cooldownPV: 0");

	// 3. Teste de Fila e Espaçamento de Stickers no PV (_enqueuePvStickerSpacing)
	console.log("\n[3] Testando _enqueuePvStickerSpacing em WhatsAppBotGo...");
	const fakeLogger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {}
	};
	const botInstance = Object.create(WhatsAppBotGo.prototype);
	botInstance.id = "test-bot";
	botInstance.logger = fakeLogger;
	botInstance._pvStickerQueues = new Map();
	botInstance._pvLastStickerSent = new Map();

	const targetChat = "5511999990004@s.whatsapp.net";
	const executionTimes = [];

	// Dispara 2 chamadas concorrentes para o mesmo chat PV
	const promise1 = botInstance._enqueuePvStickerSpacing(targetChat, async () => {
		executionTimes.push({ id: 1, time: Date.now() });
		return "ok1";
	});

	const promise2 = botInstance._enqueuePvStickerSpacing(targetChat, async () => {
		executionTimes.push({ id: 2, time: Date.now() });
		return "ok2";
	});

	const [res1, res2] = await Promise.all([promise1, promise2]);
	assert.strictEqual(res1, "ok1");
	assert.strictEqual(res2, "ok2");
	assert.strictEqual(executionTimes.length, 2);

	const deltaMs = executionTimes[1].time - executionTimes[0].time;
	console.log(`Delta entre envios de stickers concorrentes no PV: ${deltaMs}ms`);
	// Como o delay aleatório é entre 2000ms e 3000ms, deltaMs deve estar dentro de uma faixa com tolerância de clock
	assert(
		deltaMs >= 1950 && deltaMs <= 3300,
		`Intervalo entre stickers deve estar entre 2s e 3s (obtido: ${deltaMs}ms)`
	);
	console.log("✓ Fila de espaçamento aleatório (2s a 3s) validada com sucesso");

	// 4. Teste de resiliência: erro na chamada anterior não quebra a fila
	console.log("\n[4] Testando resiliência da fila com erro...");
	const promiseError = botInstance._enqueuePvStickerSpacing(targetChat, async () => {
		throw new Error("Falha intencional de rede");
	});
	const errorAssertion = assert.rejects(promiseError, /Falha intencional de rede/);
	const promiseAfterError = botInstance._enqueuePvStickerSpacing(
		targetChat,
		async () => "recuperado"
	);

	await errorAssertion;
	const resAfter = await promiseAfterError;
	assert.strictEqual(resAfter, "recuperado", "Fila deve continuar executando mesmo após erro");
	console.log("✓ Fila de stickers recupera normalmente após falhas");

	// 5. Teste de CommandHandler: cooldownPV: 0 no PV vs Grupo
	console.log("\n[5] Testando lógica de cooldown do CommandHandler...");
	const ch = new CommandHandler();
	clearInterval(ch.decayInterval);
	clearInterval(ch.cooldownMsgCleanupInterval);

	const botId = "bot_synth_01";
	const userPvKey = "5511999990001@s.whatsapp.net";
	const groupChatId = "120363000000000099@g.us";

	// Chamada consecutiva no PV com cooldownPV: 0
	let cdCheck = await ch.checkCooldown(cmdSticker, userPvKey, botId, userPvKey, true);
	assert.strictEqual(cdCheck.inCooldown, false, "Não deve estar em cooldown no PV");
	await ch.updateCooldown(cmdSticker, userPvKey, botId, userPvKey, true);

	// Imediatamente tenta de novo no PV
	cdCheck = await ch.checkCooldown(cmdSticker, userPvKey, botId, userPvKey, true);
	assert.strictEqual(cdCheck.inCooldown, false, "Mesmo após update, cooldownPV: 0 não bloqueia");

	// Agora executa no GRUPO (isPrivate = false) -> deve aplicar cooldown normal de 5s
	const userGroupKey = "5511999990002@s.whatsapp.net";
	cdCheck = await ch.checkCooldown(cmdSticker, groupChatId, botId, userGroupKey, false);
	assert.strictEqual(cdCheck.inCooldown, false, "Primeira execução no grupo não deve ter cooldown");
	await ch.updateCooldown(cmdSticker, groupChatId, botId, userGroupKey, false);

	// Imediatamente tenta de novo no GRUPO
	cdCheck = await ch.checkCooldown(cmdSticker, groupChatId, botId, userGroupKey, false);
	assert.strictEqual(cdCheck.inCooldown, true, "Segunda execução no grupo DEVE estar em cooldown");
	assert(cdCheck.timeLeft > 0 && cdCheck.timeLeft <= 5, "Tempo restante deve ser <= 5s");
	console.log("✓ CommandHandler respeita cooldownPV: 0 no PV e aplica cooldown normal no grupo");

	// 6. Teste de Fallback no PV para comandos sem cooldownPV
	console.log("\n[6] Testando fallback no PV para comando sem cooldownPV...");
	const userPvKey2 = "5511999990003@s.whatsapp.net";
	cdCheck = await ch.checkCooldown(cmdNormal, userPvKey2, botId, userPvKey2, true);
	assert.strictEqual(cdCheck.inCooldown, false, "Primeira execução do comando normal livre");
	await ch.updateCooldown(cmdNormal, userPvKey2, botId, userPvKey2, true);

	// Imediatamente tenta de novo no PV
	cdCheck = await ch.checkCooldown(cmdNormal, userPvKey2, botId, userPvKey2, true);
	assert.strictEqual(
		cdCheck.inCooldown,
		true,
		"Comando sem cooldownPV DEVE aplicar fallback (20s) no PV"
	);
	assert(cdCheck.timeLeft > 0 && cdCheck.timeLeft <= 20, "Tempo restante deve ser <= 20s");
	console.log("✓ Fallback de cooldown normal no PV funcionando perfeitamente");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NOS TESTES:", err);
		process.exit(1);
	});
