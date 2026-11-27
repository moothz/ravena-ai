/**
 * test_bicho_game.js
 *
 * Teste completo de integração do Jogo do Bicho:
 * - Inicialização e schema de bicho.db
 * - Configuração dinâmica e atualização via updateConfig
 * - Colocação de aposta com débito em Runas (CAS)
 * - Verificação de recusa por saldo insuficiente ou limites
 * - Execução de sorteio com liquidação de apostas e crédito de prêmios
 * - Comandos !bicho via FakeBot e FakeMessage
 */
"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.DISABLE_BICHO_TIMER = "true";
process.env.NODE_ENV = "test";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const Database = require("../utils/Database");
const BankService = require("../services/BankService");
const BichoService = require("../services/BichoService");

async function main() {
	console.log("Iniciando test_bicho_game.js...");

	const database = Database.getInstance();
	const bankService = BankService;
	const bichoService = BichoService.getInstance();

	const testUser = "5511999990001";
	const testGroup = "120363000000000099@g.us";

	// 1. Configura conta com saldo inicial de 50.000 ᚱ
	await database.dbRun(
		"bank",
		"INSERT INTO bank_accounts (user_id, runas, total_deposited_runas, total_withdrawn_runas, created_at, updated_at) VALUES (?, 50000, 50000, 0, ?, ?) ON CONFLICT(user_id) DO UPDATE SET runas = 50000",
		[testUser, Date.now(), Date.now()]
	);

	const initialAccount = await bankService.getAccount(testUser);
	assert.strictEqual(initialAccount.runas, 50000, "Saldo inicial deve ser 50.000 ᚱ");

	// 2. Teste de getConfig e updateConfig
	const config = await bichoService.getConfig();
	assert.strictEqual(config.minBet, 1000);
	assert.strictEqual(config.maxBet, 500000);
	assert.strictEqual(config.multipliers.grupo, 18);

	await bichoService.updateConfig({ minBet: 2000 }, "test-admin");
	const updatedConfig = await bichoService.getConfig();
	assert.strictEqual(updatedConfig.minBet, 2000, "minBet deve ter sido atualizado para 2000");

	// Restaura minBet para 1000
	await bichoService.updateConfig({ minBet: 1000 }, "test-admin");

	// 3. Teste de aposta rejeitada por saldo insuficiente
	const poorUser = "5511999990002";
	const rejRes = await bichoService.placeBet({
		userId: poorUser,
		userName: "SemGrana",
		groupId: testGroup,
		rawArgs: ["jacare", "5000"]
	});
	assert.strictEqual(rejRes.success, false, "Deve recusar aposta de quem não tem saldo");
	assert.match(rejRes.error, /Saldo insuficiente/i);

	// 4. Teste de aposta com sucesso
	const betRes = await bichoService.placeBet({
		userId: testUser,
		userName: "Apostador1",
		groupId: testGroup,
		rawArgs: ["jacare", "5000", "cercado"]
	});
	assert.strictEqual(betRes.success, true, "Aposta válida deve ser aceita");
	assert.strictEqual(betRes.modality, "grupo");
	assert.strictEqual(betRes.pick, "15"); // Jacaré = Grupo 15
	assert.strictEqual(betRes.amount, 5000);
	assert.strictEqual(betRes.scope, "cercado");

	// Verifica se debitou 5.000 ᚱ da conta
	const afterBetAccount = await bankService.getAccount(testUser);
	assert.strictEqual(afterBetAccount.runas, 45000, "Saldo após aposta deve ser 45.000 ᚱ");

	// 5. Teste de sorteio e liquidação
	const drawDate = betRes.drawDate;
	const drawResult = await bichoService.runDraw(drawDate);
	assert.ok(drawResult.drawDate === drawDate);
	assert.strictEqual(drawResult.prizes.length, 5);

	// Verifica se a aposta no banco foi liquidada
	const userBets = await bichoService.getUserBets(testUser);
	assert.ok(userBets.length >= 1);
	const targetBet = userBets.find((b) => b.id === betRes.betId);
	assert.ok(
		["WON", "LOST"].includes(targetBet.status),
		"Aposta deve estar finalizada como WON ou LOST"
	);

	// 6. Teste de comandos via FakeBot e CommandHandler
	const bot = new FakeBot({ id: "teste", grupoLogs: "logs@g.us", dossieGroups: "dossie@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.loadAllCommands();
	database.testMode = false;
	eventHandler.commandHandler.cmdDebounceTime = 0;
	eventHandler.commandHandler.checkCooldown = async () => ({ inCooldown: false, timeLeft: 0 });

	// 6.1 !bicho tabela
	const msgTabela = createMessage({
		content: "!bicho tabela",
		group: testGroup,
		author: `${testUser}@s.whatsapp.net`,
		authorName: "Apostador1"
	});
	await eventHandler.commandHandler.processCommand(bot, msgTabela, "bicho", ["tabela"], null);
	const tabelaReplies = bot.capturedMessages;
	assert.ok(tabelaReplies.length > 0, "Deve responder ao comando !bicho tabela");
	assert.match(tabelaReplies[0].content, /TABELA OFICIAL/i);
	assert.match(tabelaReplies[0].content, /Jacaré/i);
	bot.resetCapture();

	// 6.2 !bicho resultado
	const msgResultado = createMessage({
		content: "!bicho resultado",
		group: testGroup,
		author: `${testUser}@s.whatsapp.net`,
		authorName: "Apostador1"
	});
	await eventHandler.commandHandler.processCommand(bot, msgResultado, "bicho", ["resultado"], null);
	const resReplies = bot.capturedMessages;
	assert.ok(resReplies.length > 0, "Deve responder ao comando !bicho resultado");
	assert.match(resReplies[0].content, /RESULTADO DO JOGO DO BICHO/i);
	bot.resetCapture();

	// 6.3 !bicho apostas
	const msgApostas = createMessage({
		content: "!bicho apostas",
		group: testGroup,
		author: `${testUser}@s.whatsapp.net`,
		authorName: "Apostador1"
	});
	await eventHandler.commandHandler.processCommand(bot, msgApostas, "bicho", ["apostas"], null);
	const apostasReplies = bot.capturedMessages;
	assert.ok(apostasReplies.length > 0, "Deve responder ao comando !bicho apostas");
	assert.match(apostasReplies[0].content, /SUAS ÚLTIMAS APOSTAS/i);
	bot.resetCapture();

	console.log("Todos os testes de test_bicho_game.js passaram com sucesso!");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Falha em test_bicho_game.js:", err);
		process.exit(1);
	});
