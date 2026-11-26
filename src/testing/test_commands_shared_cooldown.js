"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const CommandHandler = require("../CommandHandler");
const Command = require("../models/Command");
const { createMessage } = require("./FakeMessage");

async function main() {
	console.log("=== Iniciando teste de cooldown compartilhado entre aliases ===");

	const bot = new FakeBot({ id: "test-bot" });
	const commandHandler = new CommandHandler();

	// Aguarda carregamento de comandos
	await commandHandler.fixedCommands.loadCommands();
	commandHandler.buildCooldownCanonicalMap();

	const user1 = "5511999990001";
	const user2 = "5511999990002";
	const groupId = "120363000000000001@g.us";

	// -------------------------------------------------------------
	// TESTE 1: Mapeamento canônico de comandos fixos conhecidos
	// -------------------------------------------------------------
	console.log("\n[Teste 1] Validando getCooldownCommandName para aliases conhecidos...");

	const cmdRollF = commandHandler.fixedCommands.getCommand("mu-rollf");
	const cmdRf = commandHandler.fixedCommands.getCommand("mu-rf");
	assert.ok(cmdRollF, "mu-rollf deve existir");
	assert.ok(cmdRf, "mu-rf deve existir");

	const canonRollF = commandHandler.getCooldownCommandName(cmdRollF);
	const canonRf = commandHandler.getCooldownCommandName(cmdRf);
	const canonRfStr = commandHandler.getCooldownCommandName("mu-rf");
	const canonRollFStr = commandHandler.getCooldownCommandName("mu-rollf");

	console.log(`mu-rollf canon: ${canonRollF}, mu-rf canon: ${canonRf}`);
	assert.strictEqual(canonRollF, "mu-rollf", "Canônico de mu-rollf deve ser mu-rollf");
	assert.strictEqual(canonRf, "mu-rollf", "Canônico de mu-rf deve ser mu-rollf");
	assert.strictEqual(canonRfStr, "mu-rollf", "Canônico da string 'mu-rf' deve ser mu-rollf");
	assert.strictEqual(canonRollFStr, "mu-rollf", "Canônico da string 'mu-rollf' deve ser mu-rollf");

	// Teste com mu-roll e mu-r
	const canonRoll = commandHandler.getCooldownCommandName("mu-roll");
	const canonR = commandHandler.getCooldownCommandName("mu-r");
	const canonWaifu = commandHandler.getCooldownCommandName("mu-waifu");
	assert.strictEqual(canonRoll, "mu-roll", "Canônico de mu-roll deve ser mu-roll");
	assert.strictEqual(canonR, "mu-roll", "Canônico de mu-r deve ser mu-roll");
	assert.strictEqual(canonWaifu, "mu-roll", "Canônico de mu-waifu deve ser mu-roll");

	// Teste com pescar e pesca
	const canonPescar = commandHandler.getCooldownCommandName("pescar");
	const canonPesca = commandHandler.getCooldownCommandName("pesca");
	assert.strictEqual(canonPescar, "pescar", "Canônico de pescar deve ser pescar");
	assert.strictEqual(canonPesca, "pescar", "Canônico de pesca deve ser pescar");

	console.log("✓ Teste 1 passou: todos os aliases mapeiam para o mesmo nome canônico.");

	// -------------------------------------------------------------
	// TESTE 2: Executar mu-rollf e verificar que mu-rf entra em cooldown
	// -------------------------------------------------------------
	console.log("\n[Teste 2] Usar mu-rollf e verificar cooldown em mu-rf...");

	// Antes do uso, nenhum dos dois deve estar em cooldown
	let cdCheckRf = await commandHandler.checkCooldown(cmdRf, groupId, bot.id, user1, false);
	assert.strictEqual(cdCheckRf.inCooldown, false, "mu-rf não deve estar em cooldown inicialmente");

	// User1 usa mu-rollf
	await commandHandler.updateCooldown(cmdRollF, groupId, bot.id, user1, false);

	// Agora mu-rf DEVE estar em cooldown para user1
	cdCheckRf = await commandHandler.checkCooldown(cmdRf, groupId, bot.id, user1, false);
	assert.strictEqual(
		cdCheckRf.inCooldown,
		true,
		"mu-rf DEVE estar em cooldown após uso de mu-rollf"
	);
	assert.ok(
		cdCheckRf.timeLeft > 0 && cdCheckRf.timeLeft <= 20,
		"Tempo restante deve ser entre 1 e 20s"
	);

	// mu-rollf também deve estar em cooldown
	const cdCheckRollF = await commandHandler.checkCooldown(cmdRollF, groupId, bot.id, user1, false);
	assert.strictEqual(cdCheckRollF.inCooldown, true, "mu-rollf também DEVE estar em cooldown");

	// User2 NÃO deve ser afetado (cooldown por usuário)
	const cdCheckUser2 = await commandHandler.checkCooldown(cmdRf, groupId, bot.id, user2, false);
	assert.strictEqual(
		cdCheckUser2.inCooldown,
		false,
		"User2 não deve ser afetado pelo cooldown de User1"
	);

	// mu-rollm (comando masculino com método diferente) NÃO deve estar em cooldown
	const cmdRollM = commandHandler.fixedCommands.getCommand("mu-rollm");
	const cdCheckRollM = await commandHandler.checkCooldown(cmdRollM, groupId, bot.id, user1, false);
	assert.strictEqual(
		cdCheckRollM.inCooldown,
		false,
		"mu-rollm não deve estar em cooldown quando mu-rollf foi usado"
	);

	console.log("✓ Teste 2 passou: mu-rollf colocou mu-rf em cooldown com sucesso.");

	// -------------------------------------------------------------
	// TESTE 3: Usar mu-rf e verificar que mu-rollf entra em cooldown
	// -------------------------------------------------------------
	console.log("\n[Teste 3] Usar mu-rf e verificar cooldown em mu-rollf (sentido inverso)...");

	// User2 usa mu-rf
	await commandHandler.updateCooldown(cmdRf, groupId, bot.id, user2, false);

	// Agora mu-rollf DEVE estar em cooldown para user2
	const cdCheckRollFUser2 = await commandHandler.checkCooldown(
		cmdRollF,
		groupId,
		bot.id,
		user2,
		false
	);
	assert.strictEqual(
		cdCheckRollFUser2.inCooldown,
		true,
		"mu-rollf DEVE estar em cooldown após uso de mu-rf"
	);
	assert.ok(cdCheckRollFUser2.timeLeft > 0, "Tempo restante deve ser maior que zero");

	console.log("✓ Teste 3 passou: mu-rf colocou mu-rollf em cooldown no sentido inverso.");

	// -------------------------------------------------------------
	// TESTE 4: Comando com cooldownKey explícito
	// -------------------------------------------------------------
	console.log("\n[Teste 4] Comandos com cooldownKey explícito...");

	const dummyFn1 = async () => {};
	const dummyFn2 = async () => {};

	const cmdExp1 = new Command({
		name: "cmd-custom-alpha",
		cooldown: 15,
		cooldownKey: "shared-custom-key",
		method: dummyFn1
	});
	const cmdExp2 = new Command({
		name: "cmd-custom-beta",
		cooldown: 15,
		cooldownKey: "shared-custom-key",
		method: dummyFn2
	});

	assert.strictEqual(
		commandHandler.getCooldownCommandName(cmdExp1),
		"shared-custom-key",
		"Deve usar cooldownKey explícito"
	);
	assert.strictEqual(
		commandHandler.getCooldownCommandName(cmdExp2),
		"shared-custom-key",
		"Deve usar cooldownKey explícito"
	);

	await commandHandler.updateCooldown(cmdExp1, groupId, bot.id, "user-custom", false);
	const checkExp2 = await commandHandler.checkCooldown(
		cmdExp2,
		groupId,
		bot.id,
		"user-custom",
		false
	);
	assert.strictEqual(
		checkExp2.inCooldown,
		true,
		"cmd-custom-beta deve estar em cooldown pelo cooldownKey compartilhado"
	);

	console.log("✓ Teste 4 passou: cooldownKey explícito funciona perfeitamente.");

	console.log("\n[Teste 5] Categorias do menu não dividem cooldown...");
	const cmdIa = commandHandler.fixedCommands.getCommand("cmd-ia");
	const cmdJogos = commandHandler.fixedCommands.getCommand("cmd-jogos");
	assert.ok(cmdIa && cmdJogos, "cmd-ia e cmd-jogos devem existir");
	await commandHandler.updateCooldown(cmdIa, groupId, bot.id, "5511999990005", false);
	assert.strictEqual(
		(await commandHandler.checkCooldown(cmdIa, groupId, bot.id, "5511999990005", false)).inCooldown,
		true,
		"cmd-ia deve entrar em cooldown"
	);
	assert.strictEqual(
		(await commandHandler.checkCooldown(cmdJogos, groupId, bot.id, "5511999990005", false))
			.inCooldown,
		false,
		"cmd-jogos não deve entrar em cooldown após cmd-ia"
	);
	console.log("✓ Teste 5 passou.");

	console.log("\n[Teste 6] Perfil do Wild Rift não divide cooldown com wr-build...");
	const cmdWrBuild = commandHandler.fixedCommands.getCommand("wr-build");
	const profileCommands = commandHandler.fixedCommands
		.getAllCommands()
		.filter((c) => ["wr", "wildrift"].includes(c.name) && c.method !== cmdWrBuild.method);
	const cmdWrProfile = profileCommands.find((c) => c.name === "wr");
	const cmdWildriftProfile = profileCommands.find((c) => c.name === "wildrift");
	assert.ok(
		cmdWrBuild && cmdWrProfile && cmdWildriftProfile,
		"wr, wildrift e wr-build devem existir"
	);
	const userWr = "5511999990006";
	await commandHandler.updateCooldown(cmdWrProfile, groupId, bot.id, userWr, false);
	assert.strictEqual(
		(await commandHandler.checkCooldown(cmdWildriftProfile, groupId, bot.id, userWr, false))
			.inCooldown,
		true,
		"wildrift (perfil) deve dividir cooldown com wr (perfil)"
	);
	assert.strictEqual(
		(await commandHandler.checkCooldown(cmdWrBuild, groupId, bot.id, userWr, false)).inCooldown,
		false,
		"wr-build não deve entrar em cooldown após wr (perfil)"
	);
	const userBuild = "5511999990007";
	await commandHandler.updateCooldown(cmdWrBuild, groupId, bot.id, userBuild, false);
	assert.strictEqual(
		(await commandHandler.checkCooldown(cmdWrProfile, groupId, bot.id, userBuild, false))
			.inCooldown,
		false,
		"wr (perfil) não deve entrar em cooldown após wr-build"
	);
	console.log("✓ Teste 6 passou.");

	console.log("\n[Teste 7] Comando personalizado com nome de alias fixo tem cooldown próprio...");
	const customPesca = { name: "pesca", startsWith: "pesca", cooldown: 20, cooldownGrupo: false };
	const cmdPescar = commandHandler.fixedCommands.getCommand("pescar");
	assert.strictEqual(commandHandler.getCooldownCommandName(customPesca), "pesca");
	const userCustom = "5511999990008";
	await commandHandler.updateCooldown(cmdPescar, groupId, bot.id, userCustom, false);
	assert.strictEqual(
		(await commandHandler.checkCooldown(customPesca, groupId, bot.id, userCustom, false))
			.inCooldown,
		false,
		"Comando personalizado 'pesca' não deve herdar o cooldown do fixo 'pescar'"
	);
	console.log("✓ Teste 7 passou.");

	console.log("\n[Teste 8] Cooldown persistido pelo alias usa o nome canônico...");
	const userSqlite = "5511999990009";
	const persisted = new Map();
	const { dbRun, dbGet } = commandHandler.database;
	commandHandler.database.dbRun = async (dbName, sql, params) => {
		if (dbName === "cooldowns") persisted.set(`${params[0]}|${params[1]}`, params[2]);
		return { lastID: 0, changes: 1 };
	};
	commandHandler.database.dbGet = async (dbName, sql, params) => {
		const timestamp = persisted.get(`${params[0]}|${params[1]}`);
		return timestamp === undefined ? undefined : { timestamp };
	};
	try {
		await commandHandler.updateCooldown(cmdRf, groupId, bot.id, userSqlite, false);
		commandHandler.cooldownCache.clear();
		assert.strictEqual(
			(await commandHandler.checkCooldown(cmdRollF, groupId, bot.id, userSqlite, false)).inCooldown,
			true,
			"mu-rollf deve achar no banco o cooldown gravado por mu-rf"
		);
	} finally {
		commandHandler.database.dbRun = dbRun;
		commandHandler.database.dbGet = dbGet;
	}
	console.log("✓ Teste 8 passou.");

	console.log("\n[Teste 9] Aviso de cooldown é um só para os aliases...");
	bot.resetCapture();
	const noticeGroup = "120363000000000002@g.us";
	const noticeMsg = () =>
		createMessage({
			content: "!mu-rf",
			group: noticeGroup,
			author: "5511999990010@s.whatsapp.net"
		});
	await commandHandler.handleCooldownMessage(bot, noticeMsg(), cmdRollF, noticeGroup, {
		formattedTime: "10s"
	});
	await commandHandler.handleCooldownMessage(bot, noticeMsg(), cmdRf, noticeGroup, {
		formattedTime: "9s"
	});
	assert.strictEqual(bot.capturedMessages.length, 1, "Só um aviso para mu-rollf e mu-rf");
	console.log("✓ Teste 9 passou.");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

main().catch((err) => {
	console.error("Erro durante os testes:", err);
	process.exit(1);
});
