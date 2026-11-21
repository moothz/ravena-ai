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

	// 1. Validar bots.json: nenhum bot deve ter extras.cdMultiplier solto na raiz; quem tem deve usar extras.cmds.cdMultiplier
	console.log("\n[1] Verificando bots.json (padronização de extras.cmds.cdMultiplier)...");
	const botsJsonPath = path.join(__dirname, "../../bots.json");
	if (fs.existsSync(botsJsonPath)) {
		const bots = JSON.parse(fs.readFileSync(botsJsonPath, "utf-8"));
		let configuredCount = 0;
		for (const bot of bots) {
			if (bot.extras) {
				assert.strictEqual(
					bot.extras.cdMultiplier,
					undefined,
					`Bot '${bot.nome}' não deve ter 'extras.cdMultiplier' na raiz de extras. Use 'extras.cmds.cdMultiplier'.`
				);
				if (bot.extras.cmds && bot.extras.cmds.cdMultiplier !== undefined) {
					assert(
						typeof bot.extras.cmds.cdMultiplier === "number",
						`Bot '${bot.nome}' deve ter extras.cmds.cdMultiplier como número`
					);
					configuredCount++;
				}
			}
		}
		console.log(
			`✓ bots.json validado: nenhum bot possui chave legada e ${configuredCount} instâncias usam extras.cmds.cdMultiplier`
		);
	} else {
		console.log("⚠ bots.json não encontrado localmente (ignorado)");
	}

	// 2. Testar CommandHandler com extras.cmds.cdMultiplier = 0 (cooldown zerado)
	console.log("\n[2] Testando bot com extras.cmds.cdMultiplier = 0 (cooldown desativado)...");
	const ch = new CommandHandler();
	clearInterval(ch.decayInterval);
	clearInterval(ch.cooldownMsgCleanupInterval);

	const botZeroCd = new FakeBot({
		id: "bot_cd_zero",
		privado: false,
		extras: { cmds: { cdMultiplier: 0 } }
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
	console.log("✓ Bot com extras.cmds.cdMultiplier: 0 não entra em cooldown");

	// 3. Testar CommandHandler com extras.cmds.cdMultiplier = 0.5 (cooldown pela metade: 20s -> 10s)
	console.log("\n[3] Testando bot com extras.cmds.cdMultiplier = 0.5 (cooldown pela metade)...");
	const botHalfCd = new FakeBot({
		id: "bot_cd_half",
		privado: false,
		extras: { cmds: { cdMultiplier: 0.5 } }
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
	console.log(
		`✓ Bot com extras.cmds.cdMultiplier: 0.5 aplica cooldown reduzido (${cdCheck.timeLeft}s <= 10s)`
	);

	// 4. Testar CommandHandler com extras.cmds.cdMultiplier = 2.0 (cooldown em dobro: 20s -> 40s)
	console.log("\n[4] Testando bot com extras.cmds.cdMultiplier = 2.0 (cooldown em dobro)...");
	const botDoubleCd = new FakeBot({
		id: "bot_cd_double",
		privado: false,
		extras: { cmds: { cdMultiplier: 2.0 } }
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
	console.log(
		`✓ Bot com extras.cmds.cdMultiplier: 2.0 aplica cooldown dobrado (${cdCheck.timeLeft}s > 20s)`
	);

	// 5. Testar Bot Privado sem extras.cmds.cdMultiplier explícito (fallback padrão 1.0x, NÃO zera automaticamente)
	console.log("\n[5] Testando bot privado sem extras.cmds.cdMultiplier (fallback para 1.0x)...");
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
		true,
		"Bot privado sem extras.cmds.cdMultiplier não deve zerar cooldown automaticamente"
	);
	assert(
		cdCheck.timeLeft > 10 && cdCheck.timeLeft <= 20,
		`Tempo restante deve ser de até 20s (obtido: ${cdCheck.timeLeft}s)`
	);
	console.log("✓ Bot privado sem configuração mantém cooldown padrão (fallback 1.0x)");

	// 6. Testar Bot Comunitário sem extras (padrão 1.0x = 20s)
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

	// 7. Testar valores inválidos (string ou número negativo -> fallback 1.0x)
	console.log("\n[7] Testando valores inválidos (fallback seguro para 1.0x)...");
	const botInvalid = new FakeBot({
		id: "bot_invalid",
		privado: false,
		extras: { cmds: { cdMultiplier: "invalido" } }
	});
	const user6 = "5511999990006@s.whatsapp.net";

	await ch.updateCooldown(cmd20s, groupChat, botInvalid, user6, false);
	cdCheck = await ch.checkCooldown(cmd20s, groupChat, botInvalid, user6, false);
	assert.strictEqual(cdCheck.inCooldown, true, "Valor inválido deve fazer fallback para 1.0x");
	console.log("✓ Valor inválido faz fallback seguro para cooldown normal (1.0x)");

	console.log("\n=== TODOS OS TESTES DE cdMultiplier PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NOS TESTES:", err);
		process.exit(1);
	});
