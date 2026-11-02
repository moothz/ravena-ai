process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const TelegramCallbackManager = require("../services/TelegramCallbackManager");
const WhatsAppBotTelegram = require("../TelegramBot");
const ReturnMessage = require("../models/ReturnMessage");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const Menu = require("../functions/Menu");

async function runTests() {
	console.log("=== INICIANDO TESTES DE MELHORIAS NO TELEGRAMBOT ===");

	// ---------------------------------------------------------------------------
	// 1. Testes do TelegramCallbackManager
	// ---------------------------------------------------------------------------
	console.log(
		"\n1. Testando TelegramCallbackManager (codificação, decodificação e limite 64 bytes)..."
	);

	// 1.1 Comando direto string
	const encCmd1 = TelegramCallbackManager.encode("/mu-casar 1");
	assert.strictEqual(encCmd1, "c:/mu-casar 1", "Comando direto deve ter prefixo c:");
	const decCmd1 = TelegramCallbackManager.decode(encCmd1);
	assert.strictEqual(decCmd1.type, "command");
	assert.strictEqual(decCmd1.value, "/mu-casar 1");

	// 1.2 Objeto de menu
	const encMenu = TelegramCallbackManager.encode({ type: "menu", category: "ia", page: 0 });
	assert.strictEqual(encMenu, "m:ia:0");
	const decMenu = TelegramCallbackManager.decode(encMenu);
	assert.strictEqual(decMenu.type, "menu");
	assert.strictEqual(decMenu.category, "ia");
	assert.strictEqual(decMenu.page, 0);

	// 1.3 Payload longo (> 64 bytes) que deve ir para cache sob id curto
	const longAction = {
		type: "complex",
		title:
			"Uma ação muito longa que ultrapassa confortavelmente o limite de 64 bytes exigido pela API do Telegram para callback_data",
		data: { a: 1, b: 2, c: [1, 2, 3] }
	};
	const encLong = TelegramCallbackManager.encode(longAction);
	assert.ok(encLong.startsWith("r:"), "Payload longo deve usar prefixo r:");
	assert.ok(
		Buffer.byteLength(encLong, "utf8") <= 64,
		"Callback_data gerado não pode exceder 64 bytes"
	);
	const decLong = TelegramCallbackManager.decode(encLong);
	assert.deepStrictEqual(decLong, longAction, "Payload longo recuperado deve ser idêntico");

	console.log("✓ 1. TelegramCallbackManager validado com sucesso.");

	// ---------------------------------------------------------------------------
	// 2. Testes de Conversão Inbound (TelegramBot.normalizeInboundCommand)
	// ---------------------------------------------------------------------------
	console.log("\n2. Testando normalização inbound (underscore -> hífen no comando)...");

	// Criamos uma instância mínima para testar os métodos utilitários
	const tgBot = Object.create(WhatsAppBotTelegram.prototype);

	// 2.1 Comando com underscore simples
	assert.strictEqual(
		tgBot.normalizeInboundCommand("/mu_casar 123"),
		"/mu-casar 123",
		"Deve converter /mu_casar para /mu-casar mantendo o argumento"
	);

	// 2.2 Comando composto com múltiplos underscores
	assert.strictEqual(
		tgBot.normalizeInboundCommand("/mu_roll_marcar on"),
		"/mu-roll-marcar on",
		"Deve converter múltiplos underscores no comando"
	);

	// 2.3 Comando de gerência e prefixo !
	assert.strictEqual(
		tgBot.normalizeInboundCommand("!g_addcmd teste"),
		"!g-addcmd teste",
		"Deve converter comandos com prefixo !"
	);

	// 2.4 Argumentos com underscore não devem ser modificados
	assert.strictEqual(
		tgBot.normalizeInboundCommand("/mu_casar waifu_com_underscore"),
		"/mu-casar waifu_com_underscore",
		"Argumentos após o primeiro espaço devem preservar underscores"
	);

	// 2.5 Mensagem normal sem prefixo
	assert.strictEqual(
		tgBot.normalizeInboundCommand("Texto normal sem comando_aqui"),
		"Texto normal sem comando_aqui",
		"Texto sem prefixo não deve ser alterado"
	);

	console.log("✓ 2. Conversão Inbound validada com sucesso.");

	// ---------------------------------------------------------------------------
	// 3. Testes de Conversão Outbound (TelegramBot._formatMessage)
	// ---------------------------------------------------------------------------
	console.log("\n3. Testando conversão outbound (hífen -> underscore para links clicáveis)...");

	// 3.1 Conversão de comandos com hífen
	const formatted1 = tgBot._formatMessage("Use !mu-casar ou /mu-casar para casar.");
	assert.ok(
		formatted1.includes("/mu_casar"),
		"Deve converter !mu-casar e /mu-casar para /mu_casar"
	);
	assert.ok(!formatted1.includes("!mu-casar"), "Não deve restar !mu-casar na mensagem de saída");

	// 3.2 Conversão de comandos em negrito
	const formattedBold = tgBot._formatMessage("Envie *!mu-roll* agora!");
	assert.ok(
		formattedBold.includes("<b>/mu_roll</b>"),
		"Deve formatar negrito e converter comando para /mu_roll"
	);

	// 3.3 Comandos simples iniciados por !
	const formattedCmd = tgBot._formatMessage("Consulte o menu com !cmd ou !ping.");
	assert.ok(formattedCmd.includes("/cmd"), "Deve converter !cmd para /cmd");
	assert.ok(formattedCmd.includes("/ping"), "Deve converter !ping para /ping");

	// 3.4 URLs NÃO devem ter hífens ou slashes convertidos
	const urlText = "Veja o código em https://github.com/my-test-repo/some-path-here e use !cmd.";
	const formattedUrl = tgBot._formatMessage(urlText);
	assert.ok(
		formattedUrl.includes("https://github.com/my-test-repo/some-path-here"),
		"URLs não podem ser alteradas"
	);
	assert.ok(formattedUrl.includes("/cmd"), "O comando fora da URL deve ser convertido");

	console.log("✓ 3. Conversão Outbound validada com sucesso.");

	// ---------------------------------------------------------------------------
	// 4. Testes de Geração de Botões e Inline Keyboard
	// ---------------------------------------------------------------------------
	console.log("\n4. Testando geração automática de botões e _buildInlineKeyboard...");

	// 4.1 Botão automático para single roll
	const singleRollButtons = tgBot._generateAutomaticButtons({
		waifuCharacterId: 42,
		waifuAvailable: true
	});
	assert.ok(Array.isArray(singleRollButtons), "Deve retornar array de botões");
	assert.strictEqual(singleRollButtons[0][0].text, "💍 Casar");
	assert.strictEqual(singleRollButtons[0][0].action.value, "/mu-casar 42");

	// 4.2 Botões automáticos para multi roll
	const multiRollButtons = tgBot._generateAutomaticButtons({
		waifuRolls: [
			{ slot: 1, characterId: 101, available: true, isOwner: false },
			{ slot: 2, characterId: 102, available: false, isOwner: false }, // casado, não gera
			{ slot: 3, characterId: 103, available: true, isOwner: false },
			{ slot: 4, characterId: 104, available: true, isOwner: true } // próprio, não gera
		]
	});
	assert.ok(Array.isArray(multiRollButtons), "Deve gerar botões para multi roll");
	// Apenas slots 1 e 3 disponíveis
	assert.strictEqual(multiRollButtons[0].length, 2);
	assert.strictEqual(multiRollButtons[0][0].text, "💍 1");
	assert.strictEqual(multiRollButtons[0][1].text, "💍 3");

	// 4.3 Construção de inline_keyboard para Telegram API
	const inlineMarkup = tgBot._buildInlineKeyboard([
		[
			{ text: "💍 1", action: "/mu-casar 101" },
			{ text: "Link", url: "https://ravena.moothz.com" }
		]
	]);
	assert.strictEqual(inlineMarkup.length, 1);
	assert.strictEqual(inlineMarkup[0][0].text, "💍 1");
	assert.strictEqual(inlineMarkup[0][0].callback_data, "c:/mu-casar 101");
	assert.strictEqual(inlineMarkup[0][1].text, "Link");
	assert.strictEqual(inlineMarkup[0][1].url, "https://ravena.moothz.com");

	console.log("✓ 4. Geração de botões e markup validada com sucesso.");

	// ---------------------------------------------------------------------------
	// 5. Testes do Modelo ReturnMessage
	// ---------------------------------------------------------------------------
	console.log("\n5. Testando novas propriedades telegram e buttons no ReturnMessage...");

	const retMsg = new ReturnMessage({
		chatId: "12345",
		content: "Olá",
		telegram: {
			buttons: [[{ text: "Botão", action: "cmd" }]],
			editMessageId: 999
		}
	});

	assert.ok(retMsg.telegram !== null, "Deve ter propriedade telegram");
	assert.strictEqual(retMsg.telegram.editMessageId, 999);
	assert.ok(retMsg.buttons !== null, "Atalho buttons deve ser preenchido");

	const json = retMsg.toJSON();
	assert.ok(json.telegram, "toJSON deve conter telegram");
	assert.ok(json.buttons, "toJSON deve conter buttons");

	console.log("✓ 5. ReturnMessage validado com sucesso.");

	// ---------------------------------------------------------------------------
	// 6. Testes do Menu Interativo no Telegram (!cmd / /cmd)
	// ---------------------------------------------------------------------------
	console.log("\n6. Testando menu interativo no Telegram (!cmd)...");

	const fakeBotTelegram = new FakeBot({ id: "tg-bot", useTelegram: true, prefix: "/" });
	const fakeBotWhatsApp = new FakeBot({ id: "wa-bot", useTelegram: false, prefix: "!" });

	const mockEventHandler = {
		commandHandler: {
			fixedCommands: {
				getAllCommands: () => [
					{ name: "imagine", category: "ia", description: "Gera imagens com IA" },
					{ name: "ping", category: "geral", description: "Verifica status" }
				]
			},
			management: {
				getManagementCommands: () => ({
					link: { description: "Link do grupo" }
				})
			}
		}
	};

	fakeBotTelegram.eventHandler = mockEventHandler;
	fakeBotWhatsApp.eventHandler = mockEventHandler;

	const testMsg = createMessage({
		content: "/cmd",
		group: "123456",
		author: "user1"
	});

	// Para Telegram: deve gerar ReturnMessage com telegram.buttons (categorias)
	const cmdHandlerTelegram = Menu.commands.find((c) => c.name === "cmd");
	assert.ok(cmdHandlerTelegram, "Comando cmd deve estar registrado");

	const tgMenuResult = await cmdHandlerTelegram.method(fakeBotTelegram, testMsg, [], {
		id: "123456",
		name: "Grupo Teste"
	});

	assert.ok(tgMenuResult, "Deve retornar ReturnMessage");
	assert.ok(
		tgMenuResult.telegram?.buttons?.length > 0,
		"Menu no Telegram deve retornar botões de categoria"
	);
	assert.ok(
		tgMenuResult.content.includes("Navegação Interativa"),
		"Menu no Telegram deve exibir dica de navegação interativa"
	);

	// Para WhatsApp: deve retornar menu clássico sem botões
	const waMenuResult = await cmdHandlerTelegram.method(fakeBotWhatsApp, testMsg, [], {
		id: "123456",
		name: "Grupo Teste"
	});
	assert.ok(!waMenuResult.telegram, "Menu no WhatsApp não deve conter botões do Telegram");

	// Testando handleMenuCallback
	let editedChatId = null;
	let editedMessageId = null;
	let editedText = null;
	let editedMarkup = null;

	fakeBotTelegram.apiClient = {
		editMessageText: async (chatId, messageId, text, opts) => {
			editedChatId = chatId;
			editedMessageId = messageId;
			editedText = text;
			editedMarkup = opts.reply_markup;
			return true;
		}
	};
	fakeBotTelegram._formatMessage = tgBot._formatMessage;
	fakeBotTelegram._buildInlineKeyboard = tgBot._buildInlineKeyboard;

	const fakeCallbackQuery = {
		id: "cb_query_1",
		message: {
			chat: { id: 987654 },
			message_id: 321
		}
	};

	// 6.1 Navegação para categoria 'ia'
	await Menu.handleMenuCallback(fakeBotTelegram, fakeCallbackQuery, "ia", 0);
	assert.strictEqual(editedChatId, 987654);
	assert.strictEqual(editedMessageId, 321);
	assert.ok(editedText.includes("imagine"), "Texto editado deve conter comando imagine");
	assert.ok(editedMarkup.inline_keyboard[0][0].text.includes("Voltar"), "Deve conter botão Voltar");

	// 6.2 Navegação de volta para 'root'
	await Menu.handleMenuCallback(fakeBotTelegram, fakeCallbackQuery, "root", 0);
	assert.ok(
		editedText.includes("Navegação Interativa"),
		"Menu root editado deve restaurar texto principal"
	);
	assert.ok(
		editedMarkup.inline_keyboard.length > 2,
		"Menu root editado deve restaurar grade de categorias"
	);

	console.log("✓ 6. Menu interativo no Telegram validado com sucesso.");

	// ---------------------------------------------------------------------------
	// 7. Testes de fallback assíncrono para reactions (message.origin.react(...).catch())
	// ---------------------------------------------------------------------------
	console.log(
		"\n7. Testando fallback assíncrono de reactions no TelegramBot (evita erro .catch is not a function)..."
	);

	const dummyTelegramBot = new WhatsAppBotTelegram({
		telegramBotToken: "123456:dummy_test_token",
		id: "test-tg-bot"
	});
	dummyTelegramBot.botInfo = { id: 999999, username: "test_tg_bot" };

	const rawTgMsg = {
		message_id: 999,
		date: Math.floor(Date.now() / 1000),
		chat: { id: 12345, type: "supergroup", title: "Grupo Teste" },
		from: { id: 54321, first_name: "Usuario", username: "usuario" },
		text: "/imagine batata frita"
	};

	const formattedTgMsg = await dummyTelegramBot.formatMessageFromTelegram(rawTgMsg);

	assert.ok(typeof formattedTgMsg.react === "function", "formattedTgMsg.react deve ser função");
	assert.ok(
		typeof formattedTgMsg.origin.react === "function",
		"formattedTgMsg.origin.react deve ser função"
	);

	// Valida que .catch() funciona normalmente (Promise válida retornada)
	let reactCatchCalled = false;
	const p1 = formattedTgMsg.origin.react("⌛️").catch(() => {
		reactCatchCalled = true;
	});
	assert.ok(p1 && typeof p1.then === "function", "origin.react deve retornar uma Promise");
	const res1 = await p1;
	assert.strictEqual(res1, true, "origin.react deve resolver para true");
	assert.strictEqual(reactCatchCalled, false, "Catch não deve ser chamado em sucesso");

	// Valida no nível da raiz da mensagem também
	const p2 = formattedTgMsg.react("⌛️").catch(() => {});
	assert.ok(p2 && typeof p2.then === "function", "msg.react deve retornar uma Promise");
	const res2 = await p2;
	assert.strictEqual(res2, true, "msg.react deve resolver para true");

	// Valida método bot.react(...)
	assert.ok(typeof dummyTelegramBot.react === "function", "bot.react deve ser função");
	const p3 = dummyTelegramBot.react(rawTgMsg, "🔗").catch(() => {});
	assert.ok(p3 && typeof p3.then === "function", "bot.react deve retornar uma Promise");
	const res3 = await p3;
	assert.strictEqual(res3, true, "bot.react deve resolver para true");

	// Simula a chamada exata do /mu-adm (linha 6058 do WaifuCommands)
	let muAdmReactionSucceeded = false;
	try {
		await formattedTgMsg.origin.react("🔗").catch(() => {});
		muAdmReactionSucceeded = true;
	} catch (e) {
		muAdmReactionSucceeded = false;
	}
	assert.strictEqual(
		muAdmReactionSucceeded,
		true,
		"A reação do /mu-adm não pode disparar erro no Telegram"
	);

	console.log("✓ 7. Fallback assíncrono de reactions no Telegram validado com sucesso.");

	console.log("\n=======================================================");
	console.log(" TODOS OS TESTES FORAM CONCLUÍDOS COM SUCESSO (100%)! ");
	console.log("=======================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHA NOS TESTES:", err);
		process.exit(1);
	});
