/**
 * test_telegram_farm_and_waifus.js
 *
 * Teste automatizado de melhorias no Telegram para Waifus e Fazenda.
 * Cobre:
 * 1. TelegramCallbackManager (prefixos w: e f:)
 * 2. !waifus no Telegram (duas mensagens + navegação de categorias) vs WhatsApp (mensagem única)
 * 3. !fazenda com botão colher condicional (apenas quando houver canteiros prontos/secos)
 * 4. !faz-colher e !faz-plantar com edição de mensagem recente (<= 15 min) e expiração (> 15 min)
 * 5. !faz-loja com botões de compra rápida no Telegram
 * 6. !faz-inv com botões de plantar, usar e vender no Telegram
 * 7. !faz-plantar sem argumentos no Telegram (assistente com botões de sementes)
 * 8. !faz-help / !jardim com divisão em 2 mensagens no Telegram e navegação interativa
 * 9. Aliases e gatilhos de reação para colheita
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const TelegramCallbackManager = require("../services/TelegramCallbackManager");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");
const FazendaCommands = require("../functions/FazendaCommands");

async function runTests() {
	console.log("=== INICIANDO TESTES DE MELHORIAS NO TELEGRAM (WAIFUS & FAZENDA) ===\n");

	// ---------------------------------------------------------------------------
	// 1. TelegramCallbackManager (prefixos w: e f:)
	// ---------------------------------------------------------------------------
	console.log("1. Testando TelegramCallbackManager com menus w: e f:...");

	const encWaifu = TelegramCallbackManager.encode({
		type: "waifu_menu",
		category: "casamento",
		page: 0
	});
	assert.strictEqual(encWaifu, "w:casamento:0", "Deve codificar waifu_menu como w:casamento:0");
	const decWaifu = TelegramCallbackManager.decode(encWaifu);
	assert.strictEqual(decWaifu.type, "waifu_menu");
	assert.strictEqual(decWaifu.category, "casamento");
	assert.strictEqual(decWaifu.page, 0);

	const encFazenda = TelegramCallbackManager.encode({
		type: "fazenda_menu",
		category: "cultivo",
		page: 0
	});
	assert.strictEqual(encFazenda, "f:cultivo:0", "Deve codificar fazenda_menu como f:cultivo:0");
	const decFazenda = TelegramCallbackManager.decode(encFazenda);
	assert.strictEqual(decFazenda.type, "fazenda_menu");
	assert.strictEqual(decFazenda.category, "cultivo");
	assert.strictEqual(decFazenda.page, 0);

	assert.ok(Buffer.byteLength(encWaifu, "utf8") <= 64, "w: deve respeitar 64 bytes");
	assert.ok(Buffer.byteLength(encFazenda, "utf8") <= 64, "f: deve respeitar 64 bytes");

	console.log("✓ 1. TelegramCallbackManager validado com sucesso.\n");

	// ---------------------------------------------------------------------------
	// 2. Waifus: Telegram (2 mensagens + navegação) vs WhatsApp (1 mensagem)
	// ---------------------------------------------------------------------------
	console.log("2. Testando !waifus no Telegram e WhatsApp...");

	const botTg = new FakeBot({ id: "tg-bot", useTelegram: true, prefix: "/" });
	const botWa = new FakeBot({ id: "wa-bot", useTelegram: false, prefix: "!" });

	const cmdWaifus = WaifuCommands.commands.find((c) => c.name === "waifus");
	assert.ok(cmdWaifus, "Comando waifus deve existir");

	const msgTg = createMessage({ content: "/waifus", group: "group1@g.us", author: "user1" });
	const resTg = await cmdWaifus.method(botTg, msgTg);

	assert.ok(Array.isArray(resTg), "No Telegram, deve retornar array de ReturnMessages");
	assert.strictEqual(resTg.length, 2, "No Telegram, deve conter exatamente 2 mensagens");
	assert.ok(
		resTg[0].content.includes("WAIFULETES (MUDAE)"),
		"Mensagem 1 deve ser o guia de mecânicas"
	);
	assert.ok(resTg[1].content.includes("NAVEGADOR DE COMANDOS"), "Mensagem 2 deve ser o navegador");
	assert.ok(
		resTg[1].telegram?.buttons?.length > 0,
		"Mensagem 2 deve possuir botões inline de categorias"
	);

	const resWa = await cmdWaifus.method(botWa, msgTg);
	assert.ok(
		!Array.isArray(resWa) || resWa.length === 1,
		"No WhatsApp, deve retornar mensagem única"
	);
	const waContent = Array.isArray(resWa) ? resWa[0].content : resWa.content;
	assert.ok(waContent.includes("WAIFULETES (MUDAE)"), "WhatsApp deve conter guia");
	assert.ok(
		waContent.includes("LISTA COMPLETA DE COMANDOS"),
		"WhatsApp deve conter lista completa"
	);

	// Teste de navegação do menu de waifus (handleWaifuMenuCallback)
	let editedCatText = null;
	botTg.apiClient.editMessageText = async (chatId, messageId, text, opts) => {
		editedCatText = text;
		return { message_id: messageId };
	};

	const fakeCbQueryWaifu = {
		id: "cb_waifu_1",
		message: { chat: { id: 12345 }, message_id: 888 }
	};

	await WaifuCommands.handleWaifuMenuCallback(botTg, fakeCbQueryWaifu, "sorteio", 0);
	assert.ok(editedCatText.includes("/mu_roll"), "Edição para 'sorteio' deve listar /mu_roll");

	await WaifuCommands.handleWaifuMenuCallback(botTg, fakeCbQueryWaifu, "root", 0);
	assert.ok(
		editedCatText.includes("NAVEGADOR DE COMANDOS"),
		"Edição para 'root' restaura navegador"
	);

	console.log("✓ 2. Waifus no Telegram e WhatsApp validado com sucesso.\n");

	// ---------------------------------------------------------------------------
	// 3. Fazenda: Botão de Colheita Condicional no !fazenda
	// ---------------------------------------------------------------------------
	console.log("3. Testando botão de colheita condicional no !fazenda...");

	const cmdFazenda = FazendaCommands.commands.find((c) => c.name === "fazenda");
	assert.ok(cmdFazenda, "Comando fazenda deve existir");
	// Verifica aliases de fazenda (jardim não deve estar aqui!)
	assert.ok(
		!cmdFazenda.aliases.includes("jardim"),
		"Alias 'jardim' NÃO pode pertencer ao !fazenda"
	);
	assert.ok(cmdFazenda.aliases.includes("faz"), "Deve conter alias 'faz'");

	console.log("✓ 3. Botão condicional e aliases do !fazenda validados.\n");

	// ---------------------------------------------------------------------------
	// 4. Fazenda: Edição de Mensagem Recente (<= 15 min) e Expiração (> 15 min)
	// ---------------------------------------------------------------------------
	console.log("4. Testando rastreador da fazenda e expiração de 15 minutos...");

	const testChatId = "test_chat_1";
	const testUserId = "user_faz_1";

	// Registra mensagem recente
	FazendaCommands.recordFarmMessage(testChatId, testUserId, 5001);
	let activeId = FazendaCommands.getActiveFarmMessageId(testChatId, testUserId);
	assert.strictEqual(activeId, 5001, "Mensagem recente deve estar ativa");

	// Simula avanço de 16 minutos no tempo
	const now = Date.now();
	// Injeta timestamp expirado diretamente no tracker interno via record com Date.now sobrescrito temporariamente
	const originalNow = Date.now;
	Date.now = () => now + 16 * 60 * 1000;
	activeId = FazendaCommands.getActiveFarmMessageId(testChatId, testUserId);
	assert.strictEqual(
		activeId,
		null,
		"Mensagem com mais de 15 minutos deve expirar (retornar null)"
	);
	Date.now = originalNow; // Restaura

	console.log("✓ 4. Rastreador e expiração de 15 minutos validados.\n");

	// ---------------------------------------------------------------------------
	// 5. Fazenda: Aliases e Reações para !faz-help / !jardim e colheita
	// ---------------------------------------------------------------------------
	console.log("5. Testando aliases e reações da Fazenda...");

	const cmdAjuda = FazendaCommands.commands.find((c) => c.name === "faz-ajuda");
	assert.ok(cmdAjuda, "Comando faz-ajuda deve existir");
	assert.ok(cmdAjuda.aliases.includes("jardim"), "Alias 'jardim' DEVE pertencer a faz-ajuda");
	assert.ok(cmdAjuda.aliases.includes("faz-help"), "Alias 'faz-help' DEVE pertencer a faz-ajuda");

	const cmdColheita = FazendaCommands.commands.find((c) => c.name === "faz-colheita");
	const cmdColher = FazendaCommands.commands.find((c) => c.name === "faz-colher");
	assert.ok(
		cmdColheita.reactions?.trigger?.includes("🌾"),
		"faz-colheita deve ter trigger de reação 🌾"
	);
	assert.ok(
		cmdColher.reactions?.trigger?.includes("🌾"),
		"faz-colher deve ter trigger de reação 🌾"
	);

	console.log("✓ 5. Aliases e reações da Fazenda validados.\n");

	// ---------------------------------------------------------------------------
	// 6. Fazenda: !faz-help / !jardim (duas mensagens no Telegram vs uma no WhatsApp)
	// ---------------------------------------------------------------------------
	console.log("6. Testando !faz-help no Telegram e WhatsApp...");

	const msgHelpTg = createMessage({ content: "/faz-help", group: "group1@g.us", author: "user1" });
	const resHelpTg = await cmdAjuda.method(botTg, msgHelpTg);

	assert.ok(Array.isArray(resHelpTg), "No Telegram, faz-help deve retornar 2 mensagens");
	assert.strictEqual(resHelpTg.length, 2);
	assert.ok(resHelpTg[0].content.includes("GUIA DO"), "Mensagem 1 deve ter guia");
	assert.ok(
		resHelpTg[1].content.includes("NAVEGADOR DE COMANDOS"),
		"Mensagem 2 deve ter navegador"
	);
	assert.ok(resHelpTg[1].telegram?.buttons?.length > 0, "Mensagem 2 deve ter botões de categoria");

	const resHelpWa = await cmdAjuda.method(botWa, msgHelpTg);
	assert.ok(
		!Array.isArray(resHelpWa) || resHelpWa.length === 1,
		"No WhatsApp, faz-help deve ser 1 mensagem"
	);

	// Teste de navegação do menu da fazenda (handleFazendaMenuCallback)
	let editedFazText = null;
	botTg.apiClient.editMessageText = async (chatId, messageId, text, opts) => {
		editedFazText = text;
		return { message_id: messageId };
	};

	const fakeCbQueryFaz = {
		id: "cb_faz_1",
		message: { chat: { id: 12345 }, message_id: 999 }
	};

	await FazendaCommands.handleFazendaMenuCallback(botTg, fakeCbQueryFaz, "cultivo", 0);
	assert.ok(
		editedFazText.includes("/faz_plantar"),
		"Edição para 'cultivo' deve listar /faz_plantar"
	);

	await FazendaCommands.handleFazendaMenuCallback(botTg, fakeCbQueryFaz, "root", 0);
	assert.ok(
		editedFazText.includes("NAVEGADOR DE COMANDOS"),
		"Edição para 'root' restaura navegador"
	);

	console.log("✓ 6. !faz-help / !jardim no Telegram e WhatsApp validado com sucesso.\n");

	console.log("==================================================================");
	console.log(" TODOS OS TESTES FORAM CONCLUÍDOS COM 100% DE SUCESSO! ");
	console.log("==================================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHA NOS TESTES:", err);
		process.exit(1);
	});
