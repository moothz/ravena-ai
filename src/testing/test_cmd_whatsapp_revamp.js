/**
 * Suíte de Testes: Revamp do comando !cmd no WhatsApp
 * Valida menu interativo, seções de destaque e 'Conheça também',
 * headers de categorias, replies com editMessage in-place e reações por emoji.
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const Menu = require("../functions/Menu");
const {
	CATEGORY_EMOJIS,
	CATEGORY_DESCRIPTIONS,
	MENU_INITIAL_COMMANDS,
	MENU_EXCLUDE_FROM_GETTOKNOW
} = require("../functions/MenuOrder");

async function runTests() {
	console.log("=== INICIANDO TESTES DO REVAMP DO !CMD (WHATSAPP) ===");

	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	const bot = new FakeBot({
		id: "ravena-teste",
		phoneNumber: "5511999990000",
		nomeExibir: "RavenaTestBot",
		prefix: "!"
	});
	bot.eventHandler = eventHandler;
	const groupId = "120363040000000000@g.us";
	const userAdmin = "5511988887777@s.whatsapp.net";

	const mockGroup = {
		id: groupId,
		name: "Grupo de Teste",
		prefix: "!",
		mutedCategories: [],
		mutedCommands: []
	};

	// ─── TESTE 1: Menu Inicial (!cmd) ─────────────────────────────
	console.log("\n[Teste 1] Validando envio inicial do !cmd no WhatsApp...");
	const cmdMenu = Menu.commands.find((c) => c.name === "cmd");
	assert.ok(cmdMenu, "Comando !cmd deve estar registrado");

	const msgCmd = createMessage({
		content: "!cmd",
		group: groupId,
		author: userAdmin,
		authorName: "Tester"
	});

	const menuResult = await cmdMenu.method(bot, msgCmd, [], mockGroup);
	assert.ok(menuResult, "Deve retornar ReturnMessage");
	assert.strictEqual(menuResult.options.isMenuMessage, true, "Deve ter flag isMenuMessage = true");
	assert.strictEqual(menuResult.options.maxChars, 0, "maxChars deve ser 0 para evitar truncamento");

	const menuText = menuResult.content;
	console.log(`Tamanho do menu gerado: ${menuText.length} caracteres.`);

	// 1.1 Header
	assert.ok(
		menuText.includes("🤖 *Comandos RavenaTestBot*"),
		"Deve conter título com botDisplayName"
	);
	assert.ok(menuText.includes("Grupo de Teste"), "Deve conter nome do grupo no header");

	// 1.2 Destaques
	assert.ok(menuText.includes("📌 *Comandos em Destaque:*"), "Deve conter seção de Destaques");
	for (const cmdName of MENU_INITIAL_COMMANDS) {
		assert.ok(
			menuText.includes(`!${cmdName}`) || menuText.includes(`!g-${cmdName}`),
			`Destaques devem conter !${cmdName}`
		);
	}
	console.log("✓ Seção de destaques (MENU_INITIAL_COMMANDS) validada.");

	// 1.3 Conheça também
	assert.ok(menuText.includes("✨ *Conheça também:*"), "Deve conter seção 'Conheça também'");
	for (const exc of MENU_EXCLUDE_FROM_GETTOKNOW) {
		assert.ok(
			!menuText.includes(`• *!${exc}*:`),
			`Comando excluído '${exc}' não pode aparecer em 'Conheça também'`
		);
	}
	console.log("✓ Seção 'Conheça também' e filtros de exclusão validados.");

	// 1.4 Frase de instrução
	assert.ok(
		menuText.includes("> Reagir à esta mensagem com o emoji da categoria pra listar os comandos"),
		"Deve conter frase de instrução de reação"
	);

	// 1.5 Primeira categoria é Geral
	assert.ok(
		menuText.includes("📃 *Geral* - Comandos básicos e utilitários gerais do bot"),
		"Primeira categoria deve ser Geral com sua descrição"
	);
	assert.ok(
		menuText.includes("!cmd-geral para ver todos"),
		"Deve conter linha !cmd-geral para ver todos"
	);

	// 1.6 Categoria de Gerenciamento
	assert.ok(menuText.includes("⚙️ *Gerenciamento*"), "Deve conter categoria de Gerenciamento");
	assert.ok(menuText.includes("!cmd-g para ver todos"), "Deve conter linha !cmd-g para ver todos");
	console.log("✓ Estrutura de categorias (Geral, Gerenciamento e headers) validada com sucesso.");

	// ─── TESTE 2: Simulação de Envio e Registro do Menu ───────────
	console.log("\n[Teste 2] Simulando envio pelo bot e registro da mensagem do menu...");
	bot.resetCapture();
	const sentMessages = await bot.sendReturnMessages(menuResult, mockGroup);
	assert.strictEqual(sentMessages.length, 1, "Deve enviar exatamente 1 mensagem");
	const menuSentMsgId = sentMessages[0].id._serialized;
	assert.ok(menuSentMsgId, "Mensagem enviada deve ter ID gerado");

	const isTracked = await Menu.isMenuMessage(null, menuSentMsgId);
	assert.strictEqual(
		isTracked,
		true,
		"Mensagem de menu enviada deve ser registrada como menuMessage"
	);
	console.log(`✓ Mensagem de menu ${menuSentMsgId} rastreada com sucesso.`);

	// ─── TESTE 3: Comando Solto (!cmd-jogos e !cmd jogos) ─────────
	console.log("\n[Teste 3] Validando comando !cmd-jogos e !cmd jogos enviados soltos...");
	const cmdJogos = Menu.commands.find((c) => c.name === "cmd-jogos");
	assert.ok(cmdJogos, "cmd-jogos deve estar registrado");

	const msgSolta = createMessage({
		content: "!cmd-jogos",
		group: groupId,
		author: userAdmin,
		authorName: "Tester"
	});

	const resultSolto = await cmdJogos.method(bot, msgSolta, [], mockGroup);
	assert.ok(resultSolto, "Deve retornar ReturnMessage");
	assert.ok(
		resultSolto.content.includes("🎮 *Comandos na categoria 'Jogos'*"),
		"Deve conter título da categoria Jogos com emoji"
	);
	assert.ok(
		resultSolto.content.includes(`> _${CATEGORY_DESCRIPTIONS.jogos}_`),
		"Deve conter breve descrição da categoria no cabeçalho"
	);
	assert.ok(
		resultSolto.content.includes("!pescar") || resultSolto.content.includes("!roleta"),
		"Deve listar comandos da categoria"
	);

	// Testando alias com espaço: !cmd jogos
	const msgAlias = createMessage({
		content: "!cmd jogos",
		group: groupId,
		author: userAdmin,
		authorName: "Tester"
	});
	const resultAlias = await cmdMenu.method(bot, msgAlias, ["jogos"], mockGroup);
	assert.ok(resultAlias, "Deve retornar ReturnMessage");
	assert.ok(
		resultAlias.content.includes("🎮 *Comandos na categoria 'Jogos'*"),
		"Alias '!cmd jogos' deve retornar a lista de comandos da categoria Jogos"
	);
	console.log("✓ Comandos soltos e alias com espaço validados com sucesso.");

	// ─── TESTE 4: Reply ao !cmd com Edição In-Place ───────────────
	console.log("\n[Teste 4] Validando reply com !cmd-jogos ao menu !cmd (Edição In-Place)...");
	bot.editedMessages = [];

	const msgReplyJogos = createMessage({
		content: "!cmd-jogos",
		group: groupId,
		author: userAdmin,
		authorName: "Tester",
		quotedMessageId: menuSentMsgId
	});
	msgReplyJogos.origin.getQuotedMessage = async () => ({
		id: menuSentMsgId,
		body: menuText,
		fromMe: true
	});

	const resultReply = await cmdJogos.method(bot, msgReplyJogos, [], mockGroup);
	assert.strictEqual(
		resultReply,
		null,
		"Reply ao menu deve editar in-place e retornar null (sem spam de nova msg)"
	);
	assert.strictEqual(
		bot.editedMessages.length,
		1,
		"Deve ter executado bot.editMessage exatamente 1 vez"
	);

	const lastEdit = bot.editedMessages[0];
	assert.strictEqual(lastEdit.messageId, menuSentMsgId, "ID editado deve ser o do menu original");
	assert.ok(
		lastEdit.text.includes("🎮 *Jogos:*"),
		"Topo editado deve conter a categoria Jogos selecionada"
	);
	assert.ok(
		lastEdit.text.includes(`> _${CATEGORY_DESCRIPTIONS.jogos}_`),
		"Topo editado deve exibir a descrição de Jogos"
	);
	assert.ok(
		lastEdit.text.includes("📃 *Geral*"),
		"Lista inferior deve conter 📃 Geral para retorno rápido"
	);
	console.log("✓ Reply ao !cmd editou a mensagem original in-place com sucesso!");

	// ─── TESTE 5: Reply ao !cmd com Alias '!cmd geral' ────────────
	console.log("\n[Teste 5] Validando reply ao !cmd com '!cmd geral' para voltar ao Geral...");
	bot.editedMessages = [];

	const msgReplyGeral = createMessage({
		content: "!cmd geral",
		group: groupId,
		author: userAdmin,
		authorName: "Tester",
		quotedMessageId: menuSentMsgId
	});
	msgReplyGeral.origin.getQuotedMessage = async () => ({
		id: menuSentMsgId,
		body: lastEdit.text,
		fromMe: true
	});

	const resultGeral = await cmdMenu.method(bot, msgReplyGeral, ["geral"], mockGroup);
	assert.strictEqual(resultGeral, null, "Deve editar in-place e retornar null");
	assert.strictEqual(bot.editedMessages.length, 1, "Deve executar bot.editMessage");
	assert.ok(
		bot.editedMessages[0].text.includes("📃 *Geral:*"),
		"Topo deve voltar a exibir os comandos gerais completos"
	);
	console.log("✓ Retorno para Geral via reply validado com sucesso.");

	// ─── TESTE 6: Reply ao !cmd com !cmd puro (Reset ao início) ───
	console.log(
		"\n[Teste 6] Validando reply ao !cmd com '!cmd' puro (restaura destaques iniciais)..."
	);
	bot.editedMessages = [];

	const msgReplyReset = createMessage({
		content: "!cmd",
		group: groupId,
		author: userAdmin,
		authorName: "Tester",
		quotedMessageId: menuSentMsgId
	});
	msgReplyReset.origin.getQuotedMessage = async () => ({
		id: menuSentMsgId,
		body: bot.editedMessages[0]?.text || menuText,
		fromMe: true
	});

	const resultReset = await cmdMenu.method(bot, msgReplyReset, [], mockGroup);
	assert.strictEqual(resultReset, null, "Deve editar in-place e retornar null");
	assert.strictEqual(bot.editedMessages.length, 1, "Deve executar bot.editMessage");
	assert.ok(
		bot.editedMessages[0].text.includes("📌 *Comandos em Destaque:*"),
		"Topo deve restaurar os Destaques iniciais"
	);
	assert.ok(
		bot.editedMessages[0].text.includes("✨ *Conheça também:*"),
		"Topo deve restaurar o 'Conheça também'"
	);
	console.log("✓ Reset ao menu inicial com destaques validado com sucesso.");

	// ─── TESTE 7: Fallback de Erro na Edição ───────────────────────
	console.log(
		"\n[Teste 7] Validando fallback em caso de erro na edição (bot.editMessage rejeita)..."
	);
	const originalEdit = bot.editMessage;
	bot.editMessage = async () => {
		throw new Error("WhatsApp API error: Message is too old to be edited");
	};

	const msgFallback = createMessage({
		content: "!cmd-ia",
		group: groupId,
		author: userAdmin,
		authorName: "Tester",
		quotedMessageId: menuSentMsgId
	});
	msgFallback.origin.getQuotedMessage = async () => ({
		id: menuSentMsgId,
		body: menuText,
		fromMe: true
	});

	const cmdIa = Menu.commands.find((c) => c.name === "cmd-ia");
	const fallbackResult = await cmdIa.method(bot, msgFallback, [], mockGroup);

	assert.ok(
		fallbackResult,
		"Em caso de falha de edição, deve fazer fallback e retornar ReturnMessage"
	);
	assert.ok(
		fallbackResult.content.includes("🤖 *Comandos na categoria 'IA'*"),
		"Mensagem solta de fallback deve conter categoria IA"
	);
	bot.editMessage = originalEdit;
	console.log("✓ Fallback gracioso para envio 'solto' validado com sucesso.");

	// ─── TESTE 8: Navegação por Reação (reactionMenuHelper) ───────
	console.log("\n[Teste 8] Validando navegação interativa por reações de emoji...");
	const cmdReaction = Menu.commands.find((c) => c.name === "reactionMenuHelper");
	assert.ok(cmdReaction, "reactionMenuHelper deve estar registrado");
	assert.ok(cmdReaction.reactions?.trigger?.includes("🎮"), "Reações devem escutar 🎮");
	assert.ok(cmdReaction.reactions?.trigger?.includes("📃"), "Reações devem escutar 📃");
	assert.ok(cmdReaction.reactions?.trigger?.includes("⚙️"), "Reações devem escutar ⚙️");

	bot.editedMessages = [];

	// 8.1 Reação 🎮 no menu !cmd
	const msgReactJogos = {
		id: menuSentMsgId,
		group: groupId,
		originReaction: {
			reaction: "🎮",
			senderId: userAdmin,
			userName: "Tester",
			chatId: groupId,
			msgId: { _serialized: menuSentMsgId }
		}
	};
	const handledReact = await cmdReaction.method(bot, msgReactJogos, [], mockGroup);
	assert.strictEqual(handledReact, true, "Reação 🎮 no menu deve ser tratada");
	assert.strictEqual(bot.editedMessages.length, 1, "Deve ter invocado bot.editMessage");
	assert.ok(
		bot.editedMessages[0].text.includes("🎮 *Jogos:*"),
		"Mensagem editada por reação deve conter Jogos no topo"
	);
	console.log("✓ Reação 🎮 editou a mensagem in-place!");

	// 8.2 Reação ⚙️ no menu !cmd
	bot.editedMessages = [];
	const msgReactMgmt = {
		id: menuSentMsgId,
		group: groupId,
		originReaction: {
			reaction: "⚙️",
			senderId: userAdmin,
			userName: "Tester",
			chatId: groupId,
			msgId: { _serialized: menuSentMsgId }
		}
	};
	const handledMgmt = await cmdReaction.method(bot, msgReactMgmt, [], mockGroup);
	assert.strictEqual(handledMgmt, true, "Reação ⚙️ no menu deve ser tratada");
	assert.ok(
		bot.editedMessages[0].text.includes("⚙️ *Gerenciamento:*"),
		"Mensagem editada por reação ⚙️ deve conter Gerenciamento no topo"
	);
	console.log("✓ Reação ⚙️ exibiu os comandos de gerenciamento in-place!");

	// 8.3 Reação em mensagem que NÃO é do menu
	bot.editedMessages = [];
	const msgReactOutra = {
		id: "MENSAGEM_ALEATORIA_123",
		originReaction: {
			reaction: "🎮",
			senderId: userAdmin,
			userName: "Tester",
			msgId: { _serialized: "MENSAGEM_ALEATORIA_123" }
		}
	};
	const handledOutra = await cmdReaction.method(bot, msgReactOutra, [], mockGroup);
	assert.strictEqual(handledOutra, false, "Reação em mensagem comum deve retornar false");
	assert.strictEqual(bot.editedMessages.length, 0, "Não deve editar mensagem que não é do menu");
	console.log("✓ Reação em mensagem não-menu ignorada com sucesso.");

	// ─── TESTE 9: Categoria RavenaBank no Menu ───────────────────
	console.log("\n[Teste 9] Validando categoria RavenaBank no menu e navegação...");
	assert.ok(
		menuText.includes("🏦 *RavenaBank*"),
		"Menu inicial deve listar a categoria 🏦 RavenaBank"
	);
	assert.ok(
		menuText.includes("!cmd-ravenabank para ver todos"),
		"Menu inicial deve conter instrução !cmd-ravenabank"
	);

	// 9.1 !cmd-ravenabank solto
	const cmdRavenaBank = Menu.commands.find((c) => c.name === "cmd-ravenabank");
	assert.ok(cmdRavenaBank, "cmd-ravenabank deve estar registrado");
	const msgBankSolto = createMessage({
		content: "!cmd-ravenabank",
		group: groupId,
		author: userAdmin,
		authorName: "Tester"
	});
	const resBankSolto = await cmdRavenaBank.method(bot, msgBankSolto, [], mockGroup);
	assert.ok(resBankSolto, "Deve retornar ReturnMessage");
	assert.ok(
		resBankSolto.content.includes("🏦 *Comandos na categoria 'RavenaBank'*"),
		"Deve exibir título da categoria RavenaBank"
	);
	assert.ok(resBankSolto.content.includes("!banco"), "Deve listar comando !banco");
	assert.ok(resBankSolto.content.includes("!economia"), "Deve listar comando !economia");
	assert.ok(resBankSolto.content.includes("!banco-vender"), "Deve listar comando !banco-vender");

	// 9.2 !cmd banco (alias)
	const msgCmdBanco = createMessage({
		content: "!cmd banco",
		group: groupId,
		author: userAdmin,
		authorName: "Tester"
	});
	const resCmdBanco = await cmdMenu.method(bot, msgCmdBanco, ["banco"], mockGroup);
	assert.ok(resCmdBanco, "Deve retornar ReturnMessage para alias !cmd banco");
	assert.ok(
		resCmdBanco.content.includes("🏦 *Comandos na categoria 'RavenaBank'*"),
		"Alias !cmd banco deve exibir comandos da categoria RavenaBank"
	);

	// 9.3 Reação 🏦 no menu !cmd
	bot.editedMessages = [];
	const msgReactBank = {
		id: menuSentMsgId,
		group: groupId,
		originReaction: {
			reaction: "🏦",
			senderId: userAdmin,
			userName: "Tester",
			chatId: groupId,
			msgId: { _serialized: menuSentMsgId }
		}
	};
	const handledBank = await cmdReaction.method(bot, msgReactBank, [], mockGroup);
	assert.strictEqual(handledBank, true, "Reação 🏦 no menu deve ser tratada");
	assert.ok(
		bot.editedMessages[0].text.includes("🏦 *RavenaBank:*"),
		"Mensagem editada por reação 🏦 deve conter RavenaBank no topo"
	);
	assert.ok(
		bot.editedMessages[0].text.includes("!banco"),
		"Mensagem editada deve listar os comandos do RavenaBank"
	);

	// 9.4 Reação 🏛️ alternativa no menu !cmd
	bot.editedMessages = [];
	const msgReactBankAlt = {
		id: menuSentMsgId,
		group: groupId,
		originReaction: {
			reaction: "🏛️",
			senderId: userAdmin,
			userName: "Tester",
			chatId: groupId,
			msgId: { _serialized: menuSentMsgId }
		}
	};
	const handledBankAlt = await cmdReaction.method(bot, msgReactBankAlt, [], mockGroup);
	assert.strictEqual(handledBankAlt, true, "Reação 🏛️ no menu deve ser tratada");
	assert.ok(
		bot.editedMessages[0].text.includes("🏦 *RavenaBank:*"),
		"Mensagem editada por reação 🏛️ deve conter RavenaBank no topo"
	);
	console.log("✓ Categoria RavenaBank e navegação por comando/reação validadas com sucesso!");

	console.log("\n=======================================================");
	console.log("TODOS OS 9 TESTES DO REVAMP DO !CMD PASSARAM COM SUCESSO!");
	console.log("=======================================================\n");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Falha nos testes:", err);
		process.exit(1);
	});
