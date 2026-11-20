"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const CommandHandler = require("../CommandHandler");
const Group = require("../models/Group");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");

async function main() {
	console.log("=== Iniciando teste de Comandos Embutidos ({cmd-...}) e Limite de Recursão ===");

	const bot = new FakeBot({ id: "test-bot", grupoLogs: "123@g.us" });
	const commandHandler = new CommandHandler();
	const testGroupId = "120363000000000001@g.us";
	const group = new Group({ id: testGroupId, prefix: "!" });

	// Registra um comando fixo simples para teste de comando fixo embutido
	commandHandler.fixedCommands.commands.push(
		new Command({
			name: "teste-ping",
			cooldown: 0,
			method: async () => new ReturnMessage({ chatId: testGroupId, content: "pong-fixo" })
		})
	);

	// Configura comandos personalizados no grupo
	commandHandler.customCommands[testGroupId] = [
		{
			startsWith: "ramon",
			responses: ["Olá, eu sou o Ramon!"],
			cooldown: 0
		},
		{
			startsWith: "vitu-puro",
			responses: ["{cmd-ramon}"],
			cooldown: 0
		},
		{
			startsWith: "vitu-misturado",
			responses: ["u {cmd-ramon}"],
			cooldown: 0
		},
		{
			startsWith: "ramon-recursivo",
			responses: ["Ramon aqui com {cmd-abcd} e mais nada"],
			cooldown: 0
		},
		{
			startsWith: "ramon-recursivo-puro",
			responses: ["{cmd-abcd}"],
			cooldown: 0
		},
		{
			startsWith: "vitu-recursivo-misturado",
			responses: ["Chamando: {cmd-ramon-recursivo}"],
			cooldown: 0
		},
		{
			startsWith: "vitu-recursivo-puro",
			responses: ["{cmd-ramon-recursivo-puro}"],
			cooldown: 0
		},
		{
			startsWith: "vitu-fixo-misturado",
			responses: ["Resultado fixo: {cmd-teste-ping}"],
			cooldown: 0
		}
	];

	// -------------------------------------------------------------
	// TESTE 1: Comando personalizado embutido puro ({cmd-ramon})
	// Deve enviar a resposta do comando ramon
	// -------------------------------------------------------------
	console.log("\n[Teste 1] Comando embutido puro ({cmd-ramon})...");
	const msg1 = createMessage({
		content: "!vitu-puro",
		group: testGroupId,
		author: "5511999990001@s.whatsapp.net"
	});

	bot.resetCapture();
	const res1 = await commandHandler.processCommand(bot, msg1, "vitu-puro", [], group);

	const content1 = Array.isArray(res1) ? res1[0]?.content : res1?.content;
	console.log("Retorno Teste 1:", content1);
	assert.strictEqual(
		content1,
		"Olá, eu sou o Ramon!",
		`Deveria enviar o conteúdo do comando ramon. Recebido: ${content1}`
	);
	console.log("✓ Teste 1 passou: comando personalizado puro embutido executado com sucesso.");

	// -------------------------------------------------------------
	// TESTE 2: Comando personalizado embutido misturado ("u {cmd-ramon}")
	// Deve substituir {cmd-ramon} pelo conteúdo do comando ramon
	// -------------------------------------------------------------
	console.log("\n[Teste 2] Comando embutido misturado ('u {cmd-ramon}')...");
	const msg2 = createMessage({
		content: "!vitu-misturado",
		group: testGroupId,
		author: "5511999990001@s.whatsapp.net"
	});

	bot.resetCapture();
	const res2 = await commandHandler.processCommand(bot, msg2, "vitu-misturado", [], group);

	const content2 = Array.isArray(res2) ? res2[0]?.content : res2?.content;
	console.log("Retorno Teste 2:", content2);
	assert.strictEqual(
		content2,
		"u Olá, eu sou o Ramon!",
		`Deveria conter 'u Olá, eu sou o Ramon!'. Recebido: ${content2}`
	);
	console.log("✓ Teste 2 passou: comando personalizado misturado substituído com sucesso.");

	// -------------------------------------------------------------
	// TESTE 3: Limite de embedding em comando misturado
	// Se 'ramon' tiver um {cmd-abcd}, deve exibir [Limite Comandos embutidos: 'abcd']
	// -------------------------------------------------------------
	console.log("\n[Teste 3] Limite de embedding misturado ('Chamando: {cmd-ramon-recursivo}')...");
	const msg3 = createMessage({
		content: "!vitu-recursivo-misturado",
		group: testGroupId,
		author: "5511999990001@s.whatsapp.net"
	});

	bot.resetCapture();
	const res3 = await commandHandler.processCommand(
		bot,
		msg3,
		"vitu-recursivo-misturado",
		[],
		group
	);

	const content3 = Array.isArray(res3) ? res3[0]?.content : res3?.content;
	console.log("Retorno Teste 3:", content3);
	assert.ok(
		content3.includes("[Limite Comandos embutidos: 'abcd']"),
		`Deveria conter [Limite Comandos embutidos: 'abcd']. Recebido: ${content3}`
	);
	assert.strictEqual(
		content3,
		"Chamando: Ramon aqui com [Limite Comandos embutidos: 'abcd'] e mais nada",
		`Texto final incorreto. Recebido: ${content3}`
	);
	console.log("✓ Teste 3 passou: limite de embedding aplicado no nível 2 misturado.");

	// -------------------------------------------------------------
	// TESTE 4: Limite de embedding em comando puro
	// vitu-recursivo-puro -> ramon-recursivo-puro ({cmd-abcd}) -> [Limite Comandos embutidos: 'abcd']
	// -------------------------------------------------------------
	console.log("\n[Teste 4] Limite de embedding puro ({cmd-ramon-recursivo-puro})...");
	const msg4 = createMessage({
		content: "!vitu-recursivo-puro",
		group: testGroupId,
		author: "5511999990001@s.whatsapp.net"
	});

	bot.resetCapture();
	const res4 = await commandHandler.processCommand(bot, msg4, "vitu-recursivo-puro", [], group);

	const content4 = Array.isArray(res4) ? res4[0]?.content : res4?.content;
	console.log("Retorno Teste 4:", content4);
	assert.strictEqual(
		content4,
		"[Limite Comandos embutidos: 'abcd']",
		`Deveria conter [Limite Comandos embutidos: 'abcd']. Recebido: ${content4}`
	);
	console.log("✓ Teste 4 passou: limite de embedding aplicado no nível 2 puro.");

	// -------------------------------------------------------------
	// TESTE 5: Comando fixo embutido misturado
	// 'Resultado fixo: {cmd-teste-ping}' -> 'Resultado fixo: pong-fixo'
	// -------------------------------------------------------------
	console.log(
		"\n[Teste 5] Comando fixo embutido misturado ('Resultado fixo: {cmd-teste-ping}')..."
	);
	const msg5 = createMessage({
		content: "!vitu-fixo-misturado",
		group: testGroupId,
		author: "5511999990001@s.whatsapp.net"
	});

	bot.resetCapture();
	const res5 = await commandHandler.processCommand(bot, msg5, "vitu-fixo-misturado", [], group);

	const content5 = Array.isArray(res5) ? res5[0]?.content : res5?.content;
	console.log("Retorno Teste 5:", content5);
	assert.strictEqual(
		content5,
		"Resultado fixo: pong-fixo",
		`Deveria conter 'Resultado fixo: pong-fixo'. Recebido: ${content5}`
	);
	console.log("✓ Teste 5 passou: comando fixo embutido misturado executado com sucesso.");

	console.log("\n=== TODOS OS TESTES DE COMANDOS EMBUTIDOS PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

main().catch((err) => {
	console.error("Falha no teste:", err);
	process.exit(1);
});
