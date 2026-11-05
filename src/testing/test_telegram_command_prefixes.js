process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== INICIANDO TESTES DE PREFIXOS NO TELEGRAM (/ E !) ===\n");

	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	// ---------------------------------------------------------------------------
	// 1. Testes de getCommandPrefixes
	// ---------------------------------------------------------------------------
	console.log("1. Testando getCommandPrefixes...");

	const botTg = new FakeBot({ id: "tg-bot", useTelegram: true, prefix: "/" });
	const botWa = new FakeBot({ id: "wa-bot", useTelegram: false, prefix: "!" });

	// 1.1 Telegram em PV (sem grupo)
	const prefixesTgPv = eventHandler.getCommandPrefixes(botTg, null);
	assert.deepStrictEqual(prefixesTgPv, ["/", "!"], "Telegram em PV deve aceitar '/' e '!'");

	// 1.2 Telegram em grupo com prefixo padrão "/"
	const prefixesTgGroupSlash = eventHandler.getCommandPrefixes(botTg, { prefix: "/" });
	assert.deepStrictEqual(
		prefixesTgGroupSlash,
		["/", "!"],
		"Telegram em grupo com '/' deve aceitar '/' e '!'"
	);

	// 1.3 Telegram em grupo com prefixo "!"
	const prefixesTgGroupExcl = eventHandler.getCommandPrefixes(botTg, { prefix: "!" });
	assert.deepStrictEqual(
		prefixesTgGroupExcl,
		["!", "/"],
		"Telegram em grupo com '!' deve aceitar '!' e '/'"
	);

	// 1.4 Telegram em grupo com prefixo customizado "."
	const prefixesTgGroupDot = eventHandler.getCommandPrefixes(botTg, { prefix: "." });
	assert.ok(
		prefixesTgGroupDot.includes(".") &&
			prefixesTgGroupDot.includes("/") &&
			prefixesTgGroupDot.includes("!"),
		"Telegram em grupo com '.' deve aceitar '.', '/' e '!'"
	);

	// 1.5 Telegram em grupo com prefixo vazio (qualquer mensagem é comando)
	const prefixesTgEmpty = eventHandler.getCommandPrefixes(botTg, { prefix: "" });
	assert.deepStrictEqual(
		prefixesTgEmpty,
		[""],
		"Telegram em grupo com prefixo vazio deve retornar apenas ['']"
	);

	// 1.6 WhatsApp em PV
	const prefixesWaPv = eventHandler.getCommandPrefixes(botWa, null);
	assert.deepStrictEqual(prefixesWaPv, ["!"], "WhatsApp em PV deve aceitar apenas '!'");

	// 1.7 WhatsApp em grupo com prefixo "."
	const prefixesWaDot = eventHandler.getCommandPrefixes(botWa, { prefix: "." });
	assert.deepStrictEqual(prefixesWaDot, ["."], "WhatsApp em grupo com '.' deve aceitar apenas '.'");

	console.log("✓ 1. getCommandPrefixes validado com sucesso.\n");

	// ---------------------------------------------------------------------------
	// 2. Testes de Execução de Comandos com FakeBot no Telegram
	// ---------------------------------------------------------------------------
	console.log("2. Testando execução de comandos no Telegram via EventHandler...");

	// 2.1 Comando com '/' no Telegram (PV)
	botTg.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const msgSlash = createMessage({
		content: "/ping",
		author: "123456789",
		group: null
	});

	await eventHandler.processMessage(botTg, msgSlash);
	// Aguarda processamento assíncrono
	await new Promise((r) => setTimeout(r, 200));

	assert.ok(botTg.capturedMessages.length > 0, "Comando /ping deve ser executado no Telegram");
	const resSlash = botTg.capturedMessages[0];
	const textSlash =
		typeof resSlash.content === "string" ? resSlash.content : resSlash.options?.caption || "";
	assert.ok(
		textSlash.toLowerCase().includes("pong") || textSlash.includes("🏓"),
		"Resposta do /ping deve conter pong"
	);
	console.log("✓ 2.1 /ping executado com sucesso no Telegram.");

	// 2.2 Comando com '!' no Telegram (PV) - o bug reportado!
	botTg.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const msgExcl = createMessage({
		content: "!ping",
		author: "123456789",
		group: null
	});

	await eventHandler.processMessage(botTg, msgExcl);
	await new Promise((r) => setTimeout(r, 200));

	assert.ok(
		botTg.capturedMessages.length > 0,
		"Comando !ping DEVE ser executado no Telegram (não pode ser ignorado ou enviado pro LLM)"
	);
	const resExcl = botTg.capturedMessages[0];
	const textExcl =
		typeof resExcl.content === "string" ? resExcl.content : resExcl.options?.caption || "";
	assert.ok(
		textExcl.toLowerCase().includes("pong") || textExcl.includes("🏓"),
		"Resposta do !ping deve conter pong"
	);
	console.log("✓ 2.2 !ping executado com sucesso no Telegram (resolvendo o bug!).");

	// 2.3 Comando com '!' no Telegram (em grupo)
	botTg.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const msgGroupExcl = createMessage({
		content: "!ping",
		author: "123456789",
		group: "-100123456789"
	});

	await eventHandler.processMessage(botTg, msgGroupExcl);
	await new Promise((r) => setTimeout(r, 200));

	assert.ok(
		botTg.capturedMessages.length > 0,
		"Comando !ping deve ser executado em grupo do Telegram"
	);
	console.log("✓ 2.3 !ping executado com sucesso em grupo do Telegram.");

	// 2.4 Comando com '/' no Telegram (em grupo)
	botTg.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const msgGroupSlash = createMessage({
		content: "/ping",
		author: "123456789",
		group: "-100123456789"
	});

	await eventHandler.processMessage(botTg, msgGroupSlash);
	await new Promise((r) => setTimeout(r, 200));

	assert.ok(
		botTg.capturedMessages.length > 0,
		"Comando /ping deve ser executado em grupo do Telegram"
	);
	console.log("✓ 2.4 /ping executado com sucesso em grupo do Telegram.");

	// 2.5 Mensagem conversacional normal não deve ser tratada como comando
	botTg.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const msgChat = createMessage({
		content: "Olá Ravena, tudo bem com você?",
		author: "123456789",
		group: null
	});

	// Não deve gerar capturedMessages diretamente do fixedCommands
	await eventHandler.processMessage(botTg, msgChat);
	await new Promise((r) => setTimeout(r, 200));

	assert.strictEqual(
		botTg.capturedMessages.length,
		0,
		"Mensagem conversacional comum não deve executar comandos fixos"
	);
	console.log("✓ 2.5 Mensagem conversacional normal preservada.");

	// ---------------------------------------------------------------------------
	// 3. Testes de Regressão no WhatsApp
	// ---------------------------------------------------------------------------
	console.log("\n3. Testando compatibilidade e isolamento no WhatsApp...");

	// 3.1 !ping no WhatsApp deve funcionar normalmente
	botWa.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const msgWaExcl = createMessage({
		content: "!ping",
		author: "5511999990001@s.whatsapp.net",
		group: null
	});

	await eventHandler.processMessage(botWa, msgWaExcl);
	await new Promise((r) => setTimeout(r, 200));

	assert.ok(botWa.capturedMessages.length > 0, "!ping deve funcionar no WhatsApp");
	console.log("✓ 3.1 !ping no WhatsApp funcionando normalmente.");

	// 3.2 /ping no WhatsApp NÃO deve ser comando se prefix for '!'
	botWa.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const msgWaSlash = createMessage({
		content: "/ping",
		author: "5511999990001@s.whatsapp.net",
		group: null
	});

	await eventHandler.processMessage(botWa, msgWaSlash);
	await new Promise((r) => setTimeout(r, 200));

	assert.strictEqual(
		botWa.capturedMessages.length,
		0,
		"/ping no WhatsApp não deve ser comando quando o prefixo for '!'"
	);
	console.log("✓ 3.2 /ping no WhatsApp não aciona comando indevidamente.");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
