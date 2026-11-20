"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const CommandHandler = require("../CommandHandler");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

async function main() {
	console.log("=== Iniciando teste do sistema de Cooldown (Usuário vs Grupo) ===");

	const bot = new FakeBot({ id: "test-bot" });
	const commandHandler = new CommandHandler();

	const userA = "5511999990001";
	const userB = "5511999990002";
	const userC = "5511999990003";
	const group1 = "120363000000000001@g.us";
	const group2 = "120363000000000002@g.us";

	// -------------------------------------------------------------
	// TESTE 1: Cooldown padrão (cooldownGrupo: false)
	// Deve bloquear o mesmo usuário em qualquer grupo, mas NÃO outros usuários
	// -------------------------------------------------------------
	console.log("\n[Teste 1] Cooldown por usuário padrão (cooldownGrupo: false)...");
	const cmdUserOnly = new Command({
		name: "test-user-cooldown",
		cooldown: 20,
		cooldownGrupo: false,
		method: async () => new ReturnMessage({ chatId: group1, content: "ok" })
	});

	// Inicialmente nenhum usuário está em cooldown
	let cdInfo = await commandHandler.checkCooldown(cmdUserOnly, group1, bot.id, userA);
	assert.strictEqual(
		cdInfo.inCooldown,
		false,
		"User A não deveria estar em cooldown antes de usar"
	);

	// User A usa o comando no Grupo 1
	await commandHandler.updateCooldown(cmdUserOnly, group1, bot.id, userA);

	// User A deve estar em cooldown no Grupo 1
	cdInfo = await commandHandler.checkCooldown(cmdUserOnly, group1, bot.id, userA);
	assert.strictEqual(cdInfo.inCooldown, true, "User A DEVE estar em cooldown no Grupo 1");
	assert.ok(cdInfo.timeLeft > 0 && cdInfo.timeLeft <= 20, "timeLeft deve estar entre 1 e 20");

	// User A também DEVE estar em cooldown no Grupo 2 (não pode spammar entre grupos)
	cdInfo = await commandHandler.checkCooldown(cmdUserOnly, group2, bot.id, userA);
	assert.strictEqual(
		cdInfo.inCooldown,
		true,
		"User A DEVE estar em cooldown no Grupo 2 (anti-cross-group-spam)"
	);

	// User B no Grupo 1 NÃO deve estar em cooldown (cooldownGrupo: false)
	cdInfo = await commandHandler.checkCooldown(cmdUserOnly, group1, bot.id, userB);
	assert.strictEqual(cdInfo.inCooldown, false, "User B NÃO deve estar em cooldown no Grupo 1");

	// User B no Grupo 2 NÃO deve estar em cooldown
	cdInfo = await commandHandler.checkCooldown(cmdUserOnly, group2, bot.id, userB);
	assert.strictEqual(cdInfo.inCooldown, false, "User B NÃO deve estar em cooldown no Grupo 2");
	console.log("  ✓ Teste 1 passou: Cooldown por usuário funciona e não afeta outros membros");

	// -------------------------------------------------------------
	// TESTE 2: Cooldown de grupo (cooldownGrupo: true)
	// Deve bloquear tanto o usuário executor quanto OUTROS usuários no mesmo grupo
	// -------------------------------------------------------------
	console.log("\n[Teste 2] Cooldown de grupo compartilhado (cooldownGrupo: true)...");
	const cmdGroupShared = new Command({
		name: "test-group-cooldown",
		cooldown: 20,
		cooldownGrupo: true,
		method: async () => new ReturnMessage({ chatId: group1, content: "ok" })
	});

	// User A usa o comando no Grupo 1
	await commandHandler.updateCooldown(cmdGroupShared, group1, bot.id, userA);

	// User A deve estar em cooldown no Grupo 1
	cdInfo = await commandHandler.checkCooldown(cmdGroupShared, group1, bot.id, userA);
	assert.strictEqual(cdInfo.inCooldown, true, "User A DEVE estar em cooldown no Grupo 1");

	// User B no mesmo Grupo 1 DEVE estar em cooldown (bloqueado pelo grupo)
	cdInfo = await commandHandler.checkCooldown(cmdGroupShared, group1, bot.id, userB);
	assert.strictEqual(
		cdInfo.inCooldown,
		true,
		"User B DEVE estar em cooldown no Grupo 1 devido a cooldownGrupo: true"
	);

	// User C no Grupo 2 NÃO deve estar em cooldown (outro grupo, outro usuário)
	cdInfo = await commandHandler.checkCooldown(cmdGroupShared, group2, bot.id, userC);
	assert.strictEqual(cdInfo.inCooldown, false, "User C NÃO deve estar em cooldown no Grupo 2");
	console.log("  ✓ Teste 2 passou: Cooldown de grupo compartilhado funciona conforme esperado");

	// -------------------------------------------------------------
	// TESTE 3: Custom Commands com startsWith e cooldownGrupo
	// -------------------------------------------------------------
	console.log("\n[Teste 3] Custom commands com startsWith...");
	const customCmd = {
		startsWith: "customping",
		cooldown: 20,
		cooldownGrupo: true
	};

	// Registra cooldown do custom command
	await commandHandler.updateCooldown(customCmd, group1, bot.id, userA);

	// Verifica cooldown por usuário
	cdInfo = await commandHandler.checkCooldown(customCmd, group1, bot.id, userA);
	assert.strictEqual(cdInfo.inCooldown, true, "User A DEVE estar em cooldown no custom command");

	// Verifica cooldown por grupo
	cdInfo = await commandHandler.checkCooldown(customCmd, group1, bot.id, userB);
	assert.strictEqual(
		cdInfo.inCooldown,
		true,
		"User B DEVE estar em cooldown no Grupo 1 para custom command com cooldownGrupo"
	);

	// Outro grupo livre
	cdInfo = await commandHandler.checkCooldown(customCmd, group2, bot.id, userC);
	assert.strictEqual(
		cdInfo.inCooldown,
		false,
		"User C NÃO deve estar em cooldown no Grupo 2 para custom command"
	);
	console.log("  ✓ Teste 3 passou: Custom commands funcionam com startsWith e cooldownGrupo");

	// -------------------------------------------------------------
	// TESTE 4: Fallback de chaves indefinidas e cooldown = 0
	// -------------------------------------------------------------
	console.log("\n[Teste 4] Edge cases: fallback de userKey e cooldown zero...");
	const cmdZero = new Command({ name: "zero-cmd", cooldown: 0 });
	cdInfo = await commandHandler.checkCooldown(cmdZero, group1, bot.id, userA);
	assert.strictEqual(
		cdInfo.inCooldown,
		false,
		"Cooldown 0 deve retornar inCooldown: false imediatamente"
	);

	// Chamada sem userKey deve usar fallback (groupId) sem gerar chave 'undefined'
	const cmdFallback = new Command({ name: "fallback-cmd", cooldown: 10 });
	await commandHandler.updateCooldown(cmdFallback, group1, bot.id, undefined);
	const memKeyUndefined = `${bot.id}_undefined|fallback-cmd`;
	assert.strictEqual(
		commandHandler.cooldownCache.has(memKeyUndefined),
		false,
		"NÃO deve criar chave com '_undefined'"
	);
	const memKeyGroupFallback = `${bot.id}_${group1}|fallback-cmd`;
	assert.strictEqual(
		commandHandler.cooldownCache.has(memKeyGroupFallback),
		true,
		"DEVE criar chave com o fallback do groupId"
	);

	// Command.toJSON() inclui cooldownGrupo
	const cmdJson = cmdGroupShared.toJSON();
	assert.strictEqual(cmdJson.cooldownGrupo, true, "toJSON deve conter cooldownGrupo: true");
	assert.strictEqual(
		cmdUserOnly.toJSON().cooldownGrupo,
		false,
		"toJSON deve conter cooldownGrupo: false"
	);
	console.log("  ✓ Teste 4 passou: Edge cases tratados com sucesso");

	// -------------------------------------------------------------
	// TESTE 5: Integração com EventHandler e FakeMessage
	// -------------------------------------------------------------
	console.log("\n[Teste 5] Integração de pipeline EventHandler -> CommandHandler...");
	const EventHandler = require("../EventHandler");
	const eventHandler = new EventHandler();

	let executionCount = 0;
	const liveCommand = new Command({
		name: "test-pipeline-cmd",
		cooldown: 20,
		cooldownGrupo: false,
		method: async () => {
			executionCount++;
			return new ReturnMessage({ chatId: group1, content: "Executado!" });
		}
	});

	// Injeta comando de teste nos fixed commands
	commandHandler.fixedCommands.commands.push(liveCommand);
	eventHandler.commandHandler = commandHandler;

	// User A envia comando
	const msg1 = createMessage({
		content: "!test-pipeline-cmd",
		group: group1,
		author: userA + "@s.whatsapp.net"
	});
	await commandHandler.processCommand(bot, msg1, "test-pipeline-cmd", [], null);
	assert.strictEqual(executionCount, 1, "Comando deveria ter executado 1 vez para User A");

	// User A tenta enviar de novo imediatamente -> deve ser barrado por cooldown
	const msg2 = createMessage({
		content: "!test-pipeline-cmd",
		group: group1,
		author: userA + "@s.whatsapp.net"
	});
	await commandHandler.processCommand(bot, msg2, "test-pipeline-cmd", [], null);
	assert.strictEqual(
		executionCount,
		1,
		"Comando NÃO deveria executar de novo para User A em cooldown"
	);

	// User B envia o mesmo comando no mesmo grupo -> DEVE executar com sucesso (cooldownGrupo: false)
	const msg3 = createMessage({
		content: "!test-pipeline-cmd",
		group: group1,
		author: userB + "@s.whatsapp.net"
	});
	await commandHandler.processCommand(bot, msg3, "test-pipeline-cmd", [], null);
	assert.strictEqual(executionCount, 2, "Comando DEVE executar para User B no mesmo grupo");

	console.log("  ✓ Teste 5 passou: Pipeline completo validado com isolamento por usuário");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro no teste:", err);
		process.exit(1);
	});
