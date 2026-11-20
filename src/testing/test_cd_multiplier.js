"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Command = require("../models/Command");
const CommandHandler = require("../CommandHandler");
const FakeBot = require("./FakeBot");

async function runTests() {
	console.log("=== INICIANDO TESTES DE cdMultiplier EM BOTS E COOLDOWNS ===");

	// 1. Validar bots.json: todas as instâncias privadas devem ter extras.cdMultiplier === 0
	console.log(
		"\n[1] Verificando bots.json (todas as ravenas privadas devem ter extras.cdMultiplier: 0)..."
	);
	const botsJsonPath = path.join(__dirname, "../../bots.json");
	if (fs.existsSync(botsJsonPath)) {
		const bots = JSON.parse(fs.readFileSync(botsJsonPath, "utf-8"));
		const privates = bots.filter((b) => b.privado === true);
		assert(privates.length > 0, "Deve haver ao menos um bot privado em bots.json");
		for (const bot of privates) {
			assert(bot.extras, `Bot privado '${bot.nome}' deve possuir objeto extras`);
			assert.strictEqual(
				bot.extras.cdMultiplier,
				0,
				`Bot privado '${bot.nome}' deve ter extras.cdMultiplier === 0 (atual: ${bot.extras.cdMultiplier})`
			);
		}
		console.log(
			`✓ Todos os ${privates.length} bots privados em bots.json têm extras.cdMultiplier: 0`
		);
	} else {
		console.log("⚠ bots.json não encontrado localmente (ignorado)");
	}

	// 2. Testar CommandHandler com cdMultiplier = 0 (cooldown zerado)
	console.log("\n[2] Testando bot com cdMultiplier = 0 (cooldown desativado)...");
	const ch = new CommandHandler();
	clearInterval(ch.decayInterval);
	clearInterval(ch.cooldownMsgCleanupInterval);

	const botZeroCd = new FakeBot({
		id: "bot_cd_zero",
		privado: false,
		extras: { cdMultiplier: 0 }
	});

	const cmd20s = new Command({
		name: "test-cmd-20s",
		cooldown: 20,
		run: async () => {}
	});

	const groupChat = "120363000000000001@g.us";
	const user1 = "5511999990001@s.whatsapp.net";

	let cdCheck = await ch.checkCooldown(cmd20s, groupChat, botZeroCd, user1, false);
	assert.strictEqual(cdCheck.inCooldown, false, "Inicialmente não deve estar em cooldown");

	await ch.updateCooldown(cmd20s, groupChat, botZeroCd, user1, false);

	// Chamada logo após updateCooldown
	cdCheck = await ch.checkCooldown(cmd20s, groupChat, botZeroCd, user1, false);
	assert.strictEqual(
		cdCheck.inCooldown,
		false,
		"cdMultiplier = 0 não deve entrar em cooldown mesmo após update"
	);
	console.log("✓ Bot com cdMultiplier: 0 não entra em cooldown");

	// 3. Testar CommandHandler com cdMultiplier = 0.5 (cooldown pela metade: 20s -> 10s)
	console.log("\n[3] Testando bot com cdMultiplier = 0.5 (cooldown pela metade)...");
	const botHalfCd = new FakeBot({
		id: "bot_cd_half",
		privado: false,
		extras: { cdMultiplier: 0.5 }
	});
	const user2 = "5511999990002@s.whatsapp.net";

	cdCheck = await ch.checkCooldown(cmd20s, groupChat, botHalfCd, user2, false);
	assert.strictEqual(cdCheck.inCooldown, false);

	await ch.updateCooldown(cmd20s, groupChat, botHalfCd, user2, false);

	cdCheck = await ch.checkCooldown(cmd20s, groupChat, botHalfCd, user2, false);
	assert.strictEqual(cdCheck.inCooldown, true, "Deve entrar em cooldown");
	assert(
		cdCheck.timeLeft > 0 && cdCheck.timeLeft <= 10,
		`Tempo restante deve ser <= 10s (obtido: ${cdCheck.timeLeft}s)`
	);
	console.log(`✓ Bot com cdMultiplier: 0.5 aplica cooldown reduzido (${cdCheck.timeLeft}s <= 10s)`);

	// 4. Testar CommandHandler com cdMultiplier = 2.0 (cooldown em dobro: 20s -> 40s)
	console.log("\n[4] Testando bot com cdMultiplier = 2.0 (cooldown em dobro)...");
	const botDoubleCd = new FakeBot({
		id: "bot_cd_double",
		privado: false,
		extras: { cdMultiplier: 2.0 }
	});
	const user3 = "5511999990003@s.whatsapp.net";

	cdCheck = await ch.checkCooldown(cmd20s, groupChat, botDoubleCd, user3, false);
	assert.strictEqual(cdCheck.inCooldown, false);

	await ch.updateCooldown(cmd20s, groupChat, botDoubleCd, user3, false);

	cdCheck = await ch.checkCooldown(cmd20s, groupChat, botDoubleCd, user3, false);
	assert.strictEqual(cdCheck.inCooldown, true, "Deve entrar em cooldown");
	assert(
		cdCheck.timeLeft > 20 && cdCheck.timeLeft <= 40,
		`Tempo restante deve estar entre 21s e 40s (obtido: ${cdCheck.timeLeft}s)`
	);
	console.log(`✓ Bot com cdMultiplier: 2.0 aplica cooldown dobrado (${cdCheck.timeLeft}s > 20s)`);

	// 5. Testar Bot Privado sem extras.cdMultiplier explícito (fallback automático para 0)
	console.log("\n[5] Testando bot privado sem extras.cdMultiplier (fallback para 0)...");
	const botPrivateDefault = new FakeBot({
		id: "bot_priv_default",
		privado: true,
		extras: {}
	});
	const user4 = "5511999990004@s.whatsapp.net";

	await ch.updateCooldown(cmd20s, groupChat, botPrivateDefault, user4, false);
	cdCheck = await ch.checkCooldown(cmd20s, groupChat, botPrivateDefault, user4, false);
	assert.strictEqual(
		cdCheck.inCooldown,
		false,
		"Bot privado por padrão sem extras deve zerar cooldown"
	);
	console.log("✓ Fallback de bot privado zera o cooldown corretamente");

	// 6. Testar Bot Comunitário sem extras.cdMultiplier (padrão 1.0 = 20s)
	console.log("\n[6] Testando bot comunitário sem extras (padrão 1.0x)...");
	const botNormal = new FakeBot({
		id: "bot_normal",
		privado: false,
		extras: {}
	});
	const user5 = "5511999990005@s.whatsapp.net";

	await ch.updateCooldown(cmd20s, groupChat, botNormal, user5, false);
	cdCheck = await ch.checkCooldown(cmd20s, groupChat, botNormal, user5, false);
	assert.strictEqual(cdCheck.inCooldown, true, "Bot normal deve aplicar cooldown de 20s");
	assert(
		cdCheck.timeLeft > 10 && cdCheck.timeLeft <= 20,
		`Tempo restante deve ser <= 20s (obtido: ${cdCheck.timeLeft}s)`
	);
	console.log(`✓ Bot normal mantém cooldown padrão de 20s (${cdCheck.timeLeft}s)`);

	console.log("\n=== TODOS OS TESTES DE cdMultiplier PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NOS TESTES:", err);
		process.exit(1);
	});
