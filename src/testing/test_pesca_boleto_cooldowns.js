process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const bankModule = require("../functions/BankCommands");
const fazendaModule = require("../functions/FazendaCommands");
const zueiraModule = require("../functions/ZueiraCommands");

async function main() {
	console.log("=== 1. Testando Cooldowns (Bank & Fazenda) ===");

	// BankCommands cooldowns
	for (const cmd of bankModule.commands) {
		assert.strictEqual(
			cmd.cooldown,
			3,
			`Comando do banco '${cmd.name}' deveria ter cooldown de 3s (atual: ${cmd.cooldown})`
		);
	}
	console.log("✓ Todos os comandos do Banco possuem cooldown de 3s.");

	// FazendaCommands cooldowns
	for (const cmd of fazendaModule.commands) {
		assert.strictEqual(
			cmd.cooldown,
			3,
			`Comando da fazenda '${cmd.name}' deveria ter cooldown de 3s (atual: ${cmd.cooldown})`
		);
	}
	console.log("✓ Todos os comandos da Fazenda possuem cooldown de 3s.");

	console.log("\n=== 2. Testando Pesca-Info ===");
	const bot = new FakeBot({ id: "test-bot", grupoLogs: "logs@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.loadAllCommands();
	eventHandler.commandHandler.cmdDebounceTime = 0;

	const testGroup = "120363000000000000@g.us";
	const infoMsg = createMessage({
		content: "!pesca-info",
		group: testGroup,
		author: "5511999990001@s.whatsapp.net"
	});

	await eventHandler.commandHandler.processCommand(bot, infoMsg, "pesca-info", [], null);
	assert.ok(
		bot.capturedMessages.length > 0,
		"Deveria capturar mensagem de retorno para !pesca-info"
	);
	const infoContent = bot.capturedMessages[0].content;

	assert.ok(infoContent.includes("Peixes Lendários"), "Deveria listar peixes lendários");
	assert.ok(
		infoContent.includes("disponíveis este mês"),
		"Deveria indicar lendários disponíveis no mês"
	);
	assert.ok(infoContent.includes("disp."), "Deveria indicar status de disponibilidade individual");
	assert.ok(infoContent.includes("Lixos Pescáveis"), "Deveria listar lixos pescáveis");
	assert.ok(infoContent.includes("%"), "Deveria exibir porcentagens de chance");
	assert.ok(infoContent.includes("Buffs"), "Deveria listar buffs com chances");
	assert.ok(infoContent.includes("Debuffs"), "Deveria listar debuffs com chances");
	console.log("✓ !pesca-info exibiu lendários com limite mensal, chances, buffs, debuffs e lixo.");

	console.log("\n=== 3. Testando ZueiraCommands (!boleto e !pagar) ===");
	// Verificar que !pagar existe e está hidden
	const pagarCmd = zueiraModule.commands.find((c) => c.name === "pagar");
	assert.ok(pagarCmd, "Comando !pagar deve existir");
	assert.strictEqual(pagarCmd.hidden, true, "Comando !pagar deve ser oculto (hidden: true)");
	console.log("✓ Comando !pagar está registrado e marcado como hidden: true");

	// Testar chamada do !boleto
	bot.resetCapture();
	const targetAuthor = "5511923456789@s.whatsapp.net";
	const creatorAuthor = "5511977776666@s.whatsapp.net";

	const boletoMsg = createMessage({
		content: `!boleto @5511923456789`,
		group: testGroup,
		author: creatorAuthor,
		authorName: "Alice",
		mentionedIds: [targetAuthor]
	});

	await eventHandler.commandHandler.processCommand(
		bot,
		boletoMsg,
		"boleto",
		["@5511923456789"],
		null
	);
	assert.ok(bot.capturedMessages.length > 0, "Deveria gerar mensagem de boleto");
	const sentBoleto = bot.capturedMessages[0];
	console.log("✓ Boleto gerado com sucesso.");

	// Testar !pagar sem citação
	bot.resetCapture();
	const pagarSemQuote = createMessage({
		content: "!pagar",
		group: testGroup,
		author: targetAuthor
	});
	await eventHandler.commandHandler.processCommand(bot, pagarSemQuote, "pagar", [], null);
	assert.ok(
		bot.capturedMessages[0]?.content?.includes("responder diretamente"),
		"Deveria avisar que precisa citar a mensagem do boleto"
	);
	console.log("✓ !pagar sem quote foi rejeitado adequadamente.");

	// Testar !pagar por usuário NÃO autorizado (terceiro tentando pagar)
	bot.resetCapture();
	const impostorAuthor = "5511911112222@s.whatsapp.net";
	const pagarImpostor = createMessage({
		content: "!pagar",
		group: testGroup,
		author: impostorAuthor,
		hasQuotedMsg: true,
		quotedMsg: {
			id: "fake_boleto_msg_1",
			content: sentBoleto.content,
			mentions: [targetAuthor]
		}
	});
	pagarImpostor.origin.getQuotedMessage = async () => ({
		id: "fake_boleto_msg_1",
		content: sentBoleto.content,
		body: sentBoleto.content,
		mentions: [targetAuthor]
	});

	// Registrar boleto manualmente no FakeBot id se necessário
	zueiraModule.recordBoletoMessage("fake_boleto_msg_1", {
		targetJid: targetAuthor,
		creatorJid: creatorAuthor,
		creatorName: "Alice"
	});

	await eventHandler.commandHandler.processCommand(bot, pagarImpostor, "pagar", [], null);
	assert.ok(
		bot.capturedMessages[0]?.content?.includes("não é seu para pagar"),
		"Impostor não deve conseguir pagar o boleto de outra pessoa"
	);
	console.log("✓ Terceiro foi impedido de pagar o boleto.");

	// Testar !pagar pela pessoa marcada (alvo legítimo)
	bot.resetCapture();
	const pagarLegitimo = createMessage({
		content: "!pagar",
		group: testGroup,
		author: targetAuthor,
		authorName: "Bob",
		hasQuotedMsg: true,
		quotedMsg: {
			id: "fake_boleto_msg_1",
			content: sentBoleto.content,
			mentions: [targetAuthor]
		}
	});
	pagarLegitimo.origin.getQuotedMessage = async () => ({
		id: "fake_boleto_msg_1",
		content: sentBoleto.content,
		body: sentBoleto.content,
		mentions: [targetAuthor]
	});

	await eventHandler.commandHandler.processCommand(bot, pagarLegitimo, "pagar", [], null);
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao pagamento legítimo");
	const respostaPagamento = bot.capturedMessages[0].content;
	assert.ok(
		respostaPagamento.includes("pagamento") || respostaPagamento.includes("quit"),
		"Deveria confirmar pagamento do boleto"
	);
	assert.ok(
		bot.capturedMessages[0].options?.mentions?.includes(targetAuthor),
		"Deveria conter mention da pessoa que pagou"
	);
	console.log(`✓ Pagamento legítimo realizado com sucesso:\n${respostaPagamento}`);

	// Testar pagar novamente (já quitado)
	bot.resetCapture();
	await eventHandler.commandHandler.processCommand(bot, pagarLegitimo, "pagar", [], null);
	assert.ok(
		bot.capturedMessages[0]?.content?.includes("já foi pago"),
		"Boleto já pago não deve permitir pagamento repetido"
	);
	console.log("✓ Boleto já quitado não permitiu segundo pagamento.");

	console.log("\n=== Todos os testes passaram com sucesso! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro no teste:", err);
		process.exit(1);
	});
