// src/testing/test_list_commands_v2.js

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const ListCommands = require("../functions/ListCommands");
const Database = require("../utils/Database");

async function runTests() {
	console.log("=== INICIANDO SUÍTE DE TESTES: ListCommands v2 ===");

	const groupId = "120363000000000000@g.us";
	const userAdmin = "5511999999999@s.whatsapp.net";
	const userCommon = "5511888888888@s.whatsapp.net";

	const bot = new FakeBot({
		id: "ravena-test",
		grupoLogs: "logs@g.us",
		dossieGroups: "dossie@g.us"
	});

	// Mock participants for admin check
	const mockGroup = {
		id: groupId,
		name: "Grupo de Testes Ravena",
		Participants: [
			{ id: userAdmin, isAdmin: true, isSuperAdmin: false },
			{ id: userCommon, isAdmin: false, isSuperAdmin: false }
		],
		participants: [
			{ id: { _serialized: userAdmin }, isAdmin: true },
			{ id: { _serialized: userCommon }, isAdmin: false }
		]
	};

	bot.client = {
		...bot.client,
		getContactById: async (id) => ({
			id,
			name: id.includes("9999") ? "Admin Teste" : "Membro Comum",
			pushname: id.includes("9999") ? "Admin Teste" : "Membro Comum"
		}),
		getMessageById: async (msgId) => ({
			id: msgId,
			fromMe: true,
			body: "Listas disponíveis (Grupo de Testes Ravena)",
			getChat: async () => ({ isGroup: true, id: { _serialized: groupId } })
		})
	};

	const db = Database.getInstance();
	db.testMode = false;

	// ─── TESTE 1: Migração de Dados Legados ─────────────────────────────────
	console.log("\n[Teste 1] Validando migração de dados legados do lists.db...");
	const legacyJson = JSON.stringify([
		{
			name: "pelada_legada",
			title: "Pelada dos Amigos Legada",
			createdAt: Date.now() - 100000,
			createdBy: userAdmin,
			members: [
				{ id: userAdmin, name: "Admin Teste", joinedAt: Date.now() - 50000 },
				{ id: userCommon, name: "Membro Comum", joinedAt: Date.now() - 20000 }
			]
		}
	]);

	await db.dbRun("lists", "INSERT OR REPLACE INTO lists (group_id, json_data) VALUES (?, ?)", [
		groupId,
		legacyJson
	]);

	// Chama listas para disparar ensureMigrated()
	const msgListas = createMessage({
		content: "!listas",
		group: groupId,
		author: userAdmin
	});

	const cmdListas = ListCommands.commands.find((c) => c.name === "listas");
	await cmdListas.execute(bot, msgListas, [], mockGroup);

	// Verifica se foi migrado para lists_v2
	const migratedList = await db.dbGet(
		"lists_v2",
		"SELECT * FROM lists WHERE group_id = ? AND name = ?",
		[groupId, "pelada_legada"]
	);
	assert.ok(migratedList, "A lista legada deve ter sido migrada para lists_v2");
	assert.strictEqual(migratedList.type, "members");

	const migratedMembers = await db.dbAll(
		"lists_v2",
		"SELECT * FROM list_members WHERE list_id = ?",
		[migratedList.id]
	);
	assert.strictEqual(migratedMembers.length, 2, "Os 2 membros legados devem ter sido migrados");
	console.log("✓ Migração de dados legados concluída com sucesso.");

	// ─── TESTE 2: Comandos Clássicos de Lista de Pessoas (!lc, !le, !ls) ───
	console.log("\n[Teste 2] Validando comandos clássicos de pessoas (!lc, !le, !ls, !lt)...");
	const cmdLc = ListCommands.commands.find((c) => c.name === "lc");
	const msgLc = createMessage({
		content: "!lc fut_novo",
		group: groupId,
		author: userAdmin
	});
	await cmdLc.execute(bot, msgLc, ["fut_novo"], mockGroup);

	const listFut = await db.dbGet(
		"lists_v2",
		"SELECT * FROM lists WHERE group_id = ? AND name = ?",
		[groupId, "fut_novo"]
	);
	assert.ok(listFut, "Lista fut_novo deve existir em lists_v2");
	assert.strictEqual(listFut.type, "members");

	// Usuário comum entra na lista (!le fut_novo)
	const cmdLe = ListCommands.commands.find((c) => c.name === "le");
	const msgLe = createMessage({
		content: "!le fut_novo",
		group: groupId,
		author: userCommon,
		name: "Membro Comum"
	});
	await cmdLe.execute(bot, msgLe, ["fut_novo"], mockGroup);

	let membersFut = await db.dbAll("lists_v2", "SELECT * FROM list_members WHERE list_id = ?", [
		listFut.id
	]);
	assert.strictEqual(membersFut.length, 1, "fut_novo deve ter 1 membro");
	assert.strictEqual(membersFut[0].user_id, userCommon);

	// Usuário comum sai da lista (!ls fut_novo)
	const cmdLs = ListCommands.commands.find((c) => c.name === "ls");
	const msgLs = createMessage({
		content: "!ls fut_novo",
		group: groupId,
		author: userCommon
	});
	await cmdLs.execute(bot, msgLs, ["fut_novo"], mockGroup);

	membersFut = await db.dbAll("lists_v2", "SELECT * FROM list_members WHERE list_id = ?", [
		listFut.id
	]);
	assert.strictEqual(membersFut.length, 0, "fut_novo deve ter 0 membros após !ls");
	console.log("✓ Comandos clássicos de lista de pessoas validados com sucesso.");

	// ─── TESTE 3: Criação de Lista de Itens (!lci) ─────────────────────────
	console.log("\n[Teste 3] Validando criação de lista de itens (!lci)...");
	bot.resetCapture();
	const cmdLci = ListCommands.commands.find((c) => c.name === "lci");
	const msgLci = createMessage({
		content: "!lci compras Mercado da Semana",
		group: groupId,
		author: userAdmin
	});
	await cmdLci.execute(bot, msgLci, ["compras", "Mercado", "da", "Semana"], mockGroup);

	const listCompras = await db.dbGet(
		"lists_v2",
		"SELECT * FROM lists WHERE group_id = ? AND name = ?",
		[groupId, "compras"]
	);
	assert.ok(listCompras, "Lista 'compras' deve existir no banco lists_v2");
	assert.strictEqual(listCompras.type, "items");
	assert.strictEqual(listCompras.title, "Mercado da Semana");
	assert.strictEqual(listCompras.admin_only, 0, "Deve nascer com admin_only = 0 (aberta)");
	assert.ok(bot.capturedMessages.length > 0, "Deve ter enviado mensagem de criação");
	console.log("✓ Criação de lista de itens (!lci) validada com sucesso.");

	// ─── TESTE 4: Adição de Itens (!add) com Delimitadores Mistos ──────────
	console.log("\n[Teste 4] Validando adição de itens com vírgula, ponto e vírgula e Enter...");
	const cmdAdd = ListCommands.commands.find((c) => c.name === "add");
	const rawItemsText =
		"Arroz 5kg, Feijão carioca; Macarrão espaguete\n2x Azeite de oliva; Batata doce";

	const msgAdd = createMessage({
		content: `!add compras ${rawItemsText}`,
		group: groupId,
		author: userCommon,
		name: "Membro Comum"
	});

	await cmdAdd.execute(bot, msgAdd, ["compras", ...rawItemsText.split(" ")], mockGroup);

	const items = await db.dbAll(
		"lists_v2",
		"SELECT * FROM list_items WHERE list_id = ? ORDER BY id ASC",
		[listCompras.id]
	);
	assert.strictEqual(items.length, 5, "Devem ter sido cadastrados 5 itens distintos");
	assert.strictEqual(items[0].item_text, "Arroz 5kg");
	assert.strictEqual(items[1].item_text, "Feijão carioca");
	assert.strictEqual(items[2].item_text, "Macarrão espaguete");
	assert.strictEqual(items[3].item_text, "2x Azeite de oliva");
	assert.strictEqual(items[4].item_text, "Batata doce");
	assert.strictEqual(items[0].checked, 0);
	console.log("✓ Adição de itens com delimitadores variados validada com sucesso.");

	// ─── TESTE 5: Adição de Itens via Citação de Mensagem Externa ─────────
	console.log("\n[Teste 5] Validando adição via citação de mensagem externa...");
	const quotedExternalMsg = {
		id: "MSG_EXTERNA_123",
		body: "Lista da festa:\n- Cerveja gelada\n- Carvão vegetal\n- Picanha",
		author: userCommon
	};

	const msgAddQuoted = createMessage({
		content: "!add compras",
		group: groupId,
		author: userCommon
	});
	msgAddQuoted.origin.getQuotedMessage = async () => quotedExternalMsg;

	await cmdAdd.execute(bot, msgAddQuoted, ["compras"], mockGroup);

	const itemsAfterQuote = await db.dbAll(
		"lists_v2",
		"SELECT * FROM list_items WHERE list_id = ? ORDER BY id ASC",
		[listCompras.id]
	);
	assert.strictEqual(
		itemsAfterQuote.length,
		8,
		"Deve ter 8 itens (5 anteriores + 3 do quote sanitizados)"
	);
	assert.ok(itemsAfterQuote.some((it) => it.item_text === "Cerveja gelada"));
	assert.ok(itemsAfterQuote.some((it) => it.item_text === "Carvão vegetal"));
	assert.ok(itemsAfterQuote.some((it) => it.item_text === "Picanha"));
	console.log("✓ Adição de itens citando mensagem externa validada com sucesso.");

	// ─── TESTE 6: Marcação de Item Concluído (!check) e Movimentação ───────
	console.log("\n[Teste 6] Validando !check e deslocamento para o fim da lista...");
	const cmdCheck = ListCommands.commands.find((c) => c.name === "check");
	const msgCheck = createMessage({
		content: "!check compras 1",
		group: groupId,
		author: userCommon,
		name: "Membro Comum"
	});

	// Marca item 1 (Arroz 5kg)
	await cmdCheck.execute(bot, msgCheck, ["compras", "1"], mockGroup);

	const itemArroz = await db.dbGet(
		"lists_v2",
		"SELECT * FROM list_items WHERE list_id = ? AND item_text = ?",
		[listCompras.id, "Arroz 5kg"]
	);
	assert.strictEqual(itemArroz.checked, 1, "Arroz 5kg deve estar marcado como checked = 1");
	assert.strictEqual(itemArroz.checked_by, userCommon);

	// O próximo item pendente (Feijão carioca) deve agora ser o primeiro pendente!
	const pendingAfterCheck = await db.dbAll(
		"lists_v2",
		"SELECT * FROM list_items WHERE list_id = ? AND checked = 0 ORDER BY id ASC",
		[listCompras.id]
	);
	assert.strictEqual(
		pendingAfterCheck[0].item_text,
		"Feijão carioca",
		"Feijão carioca deve ser o novo item pendente #1"
	);
	console.log("✓ Item marcado como concluído e próximo item assumiu o slot 1 com sucesso.");

	// ─── TESTE 7: Desmarcar Item Concluído (!uncheck) ──────────────────────
	console.log("\n[Teste 7] Validando !uncheck...");
	const cmdUncheck = ListCommands.commands.find((c) => c.name === "uncheck");
	const msgUncheck = createMessage({
		content: "!uncheck compras Arroz",
		group: groupId,
		author: userCommon
	});

	await cmdUncheck.execute(bot, msgUncheck, ["compras", "Arroz"], mockGroup);
	const itemArrozUnchecked = await db.dbGet("lists_v2", "SELECT * FROM list_items WHERE id = ?", [
		itemArroz.id
	]);
	assert.strictEqual(itemArrozUnchecked.checked, 0, "Arroz deve voltar a checked = 0");
	console.log("✓ !uncheck validado com sucesso.");

	// ─── TESTE 8: Remoção de Item (!rem) ──────────────────────────────────
	console.log("\n[Teste 8] Validando !rem...");
	const cmdRem = ListCommands.commands.find((c) => c.name === "rem");
	const msgRem = createMessage({
		content: "!rem compras 1",
		group: groupId,
		author: userCommon
	});

	const pendingBeforeRem = await db.dbAll(
		"lists_v2",
		"SELECT * FROM list_items WHERE list_id = ? AND checked = 0 ORDER BY id ASC",
		[listCompras.id]
	);
	const targetToRemove = pendingBeforeRem[0];

	await cmdRem.execute(bot, msgRem, ["compras", "1"], mockGroup);

	const itemDeleted = await db.dbGet("lists_v2", "SELECT * FROM list_items WHERE id = ?", [
		targetToRemove.id
	]);
	assert.strictEqual(itemDeleted, undefined, "Item deve ter sido deletado");
	console.log("✓ !rem validado com sucesso.");

	// ─── TESTE 9: Limpeza de Lista (!limpar) e Reação 🗑️ ───────────────────
	console.log("\n[Teste 9] Validando !limpar em lista aberta...");
	const cmdLimpar = ListCommands.commands.find((c) => c.name === "limpar");
	const msgLimpar = createMessage({
		content: "!limpar compras",
		group: groupId,
		author: userCommon
	});

	await cmdLimpar.execute(bot, msgLimpar, ["compras"], mockGroup);

	const itemsAfterClear = await db.dbAll("lists_v2", "SELECT * FROM list_items WHERE list_id = ?", [
		listCompras.id
	]);
	assert.strictEqual(itemsAfterClear.length, 0, "A lista de itens deve estar vazia após !limpar");
	console.log("✓ !limpar executado por usuário comum em lista aberta validado com sucesso.");

	// ─── TESTE 10: Permissões (!lp compras admin) ──────────────────────────
	console.log("\n[Teste 10] Validando trava de permissão administrativa (!lp)...");
	const cmdLp = ListCommands.commands.find((c) => c.name === "lp");

	// Membro comum tenta alterar permissão -> negado
	const msgLpComum = createMessage({
		content: "!lp compras admin",
		group: groupId,
		author: userCommon
	});
	const resLpComum = await cmdLp.execute(bot, msgLpComum, ["compras", "admin"], mockGroup);
	assert.ok(
		resLpComum.content.includes("Apenas administradores"),
		"Membro comum não pode mudar permissão"
	);

	// Admin altera para admin
	const msgLpAdmin = createMessage({
		content: "!lp compras admin",
		group: groupId,
		author: userAdmin
	});
	await cmdLp.execute(bot, msgLpAdmin, ["compras", "admin"], mockGroup);

	const listLocked = await db.dbGet("lists_v2", "SELECT admin_only FROM lists WHERE id = ?", [
		listCompras.id
	]);
	assert.strictEqual(listLocked.admin_only, 1, "admin_only deve ser 1");

	// Membro comum tenta adicionar item -> negado
	const msgAddBlocked = createMessage({
		content: "!add compras Pão",
		group: groupId,
		author: userCommon
	});
	const resAddBlocked = await cmdAdd.execute(bot, msgAddBlocked, ["compras", "Pão"], mockGroup);
	assert.ok(
		resAddBlocked.content.includes("restrita a administradores"),
		"Adição por comum deve ser bloqueada"
	);

	// Admin adiciona item -> permitido
	const msgAddAdmin = createMessage({
		content: "!add compras Pão Francês",
		group: groupId,
		author: userAdmin
	});
	await cmdAdd.execute(bot, msgAddAdmin, ["compras", "Pão", "Francês"], mockGroup);

	const itemsAfterAdminAdd = await db.dbAll(
		"lists_v2",
		"SELECT * FROM list_items WHERE list_id = ?",
		[listCompras.id]
	);
	assert.strictEqual(
		itemsAfterAdminAdd.length,
		1,
		"Admin deve conseguir adicionar item na lista restrita"
	);
	console.log("✓ Trava de permissão administrativa (!lp) validada com sucesso.");

	// ─── TESTE 11: Interação In-Place por Reações (ReactionsHandler) ────────
	console.log("\n[Teste 11] Validando reações com edição in-place (bot.editMessage)...");
	bot.editedMessages = [];

	// Registra mensagem fictícia como mensagem de lista single
	const fakeListMsgId = "MSG_WHATSAPP_LIST_456";
	await db.dbRun(
		"lists_v2",
		`INSERT OR REPLACE INTO list_messages (message_id, group_id, type, list_id, created_at, updated_at)
		 VALUES (?, ?, 'single', ?, ?, ?)`,
		[fakeListMsgId, groupId, listCompras.id, Date.now(), Date.now()]
	);

	const cmdReact = ListCommands.commands.find((c) => c.name === "reactionListHelper");

	// 11.1 Reação numérica 1️⃣ na lista compras para marcar Pão Francês como concluído
	const reactMsg1 = {
		originReaction: {
			reaction: "1️⃣",
			senderId: userAdmin,
			userName: "Admin Teste",
			msgId: { _serialized: fakeListMsgId }
		}
	};

	const handled1 = await cmdReact.method(bot, reactMsg1, [], mockGroup);
	assert.strictEqual(handled1, true, "Reação 1️⃣ deve ser tratada");
	assert.ok(bot.editedMessages.length > 0, "Deve ter chamado bot.editMessage in-place!");
	const lastEdit = bot.editedMessages[bot.editedMessages.length - 1];
	assert.strictEqual(lastEdit.messageId, fakeListMsgId);
	assert.ok(
		lastEdit.text.includes("~Pão Francês~"),
		"Texto editado deve conter Pão Francês tachado"
	);
	console.log("✓ Reação 1️⃣ editou a mensagem in-place sem enviar spam de texto!");

	// 11.2 Reação de limpeza 🗑️
	const reactMsgTrash = {
		originReaction: {
			reaction: "🗑️",
			senderId: userAdmin,
			userName: "Admin Teste",
			msgId: { _serialized: fakeListMsgId }
		}
	};
	const handledTrash = await cmdReact.method(bot, reactMsgTrash, [], mockGroup);
	assert.strictEqual(handledTrash, true, "Reação 🗑️ deve ser tratada");
	const itemsFinal = await db.dbAll("lists_v2", "SELECT * FROM list_items WHERE list_id = ?", [
		listCompras.id
	]);
	assert.strictEqual(itemsFinal.length, 0, "A lista deve estar vazia após reação 🗑️");
	console.log("✓ Reação 🗑️ esvaziou a lista in-place com sucesso!");

	// ─── TESTE 12: Exclusão de Lista (!ld) ──────────────────────────────────
	console.log("\n[Teste 12] Validando exclusão definitiva de lista (!ld)...");
	const cmdLd = ListCommands.commands.find((c) => c.name === "ld");
	const msgLd = createMessage({
		content: "!ld compras",
		group: groupId,
		author: userAdmin
	});

	await cmdLd.execute(bot, msgLd, ["compras"], mockGroup);
	const listDeleted = await db.dbGet("lists_v2", "SELECT * FROM lists WHERE id = ?", [
		listCompras.id
	]);
	assert.strictEqual(listDeleted, undefined, "Lista 'compras' deve ter sido excluída");
	console.log("✓ Exclusão de lista (!ld) validada com sucesso.");

	// ─── TESTE 13: Lista com Espaços no Nome e Adição Multilinhas (!add) ────
	console.log(
		"\n[Teste 13] Validando criação com espaços e !add multilinhas respondendo com nova mensagem..."
	);
	bot.resetCapture();
	const msgCreateEspaco = createMessage({
		content: '!lci "compras do mes" Compras do Mês da Casa',
		group: groupId,
		author: userAdmin
	});
	await cmdLci.execute(
		bot,
		msgCreateEspaco,
		['"compras', "do", 'mes"', "Compras", "do", "Mês", "da", "Casa"],
		mockGroup
	);

	const listComprasMes = await db.dbGet(
		"lists_v2",
		"SELECT * FROM lists WHERE group_id = ? AND name = ?",
		[groupId, "compras do mes"]
	);
	assert.ok(listComprasMes, "Lista 'compras do mes' deve existir");

	bot.resetCapture();
	const msgAddMultilinha = createMessage({
		content: "!add compras do mes arroz 5kg\nfeijão carioca\nmacarrão espaguete",
		group: groupId,
		author: userCommon
	});
	await cmdAdd.execute(bot, msgAddMultilinha, ["compras", "do", "mes", "arroz", "5kg"], mockGroup);

	// Deve ter respondido com nova mensagem
	assert.ok(bot.capturedMessages.length > 0, "Deve responder com nova mensagem");
	const lastSentMsg = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(
		lastSentMsg.content.includes("arroz 5kg") &&
			lastSentMsg.content.includes("feijão carioca") &&
			lastSentMsg.content.includes("macarrão espaguete"),
		"Nova mensagem deve conter os 3 itens atualizados"
	);

	const itemsMes = await db.dbAll(
		"lists_v2",
		"SELECT * FROM list_items WHERE list_id = ? ORDER BY id ASC",
		[listComprasMes.id]
	);
	assert.strictEqual(itemsMes.length, 3, "Devem haver 3 itens cadastrados");
	console.log("✓ Lista com espaços e multilinhas no !add validada com sucesso.");

	// ─── TESTE 14: !add com Quote na Lista (Edição) e !lista (Nova Mensagem) ──
	console.log(
		"\n[Teste 14] Validando !add em quote (edição in-place) e !lista (sempre nova mensagem)..."
	);
	bot.resetCapture();
	bot.editedMessages = [];

	const updatedListRow = await db.dbGet("lists_v2", "SELECT * FROM lists WHERE id = ?", [
		listComprasMes.id
	]);
	const listMsgId = updatedListRow.last_message_id;

	let reactedEmoji = null;
	const msgAddQuote = createMessage({
		content: "!add azeite\nsal",
		group: groupId,
		author: userCommon
	});
	msgAddQuote.origin.getQuotedMessage = async () => ({
		id: listMsgId,
		body: "🛒 *Lista de Compras/Itens — Compras do Mês da Casa*",
		author: bot.phoneNumber
	});
	msgAddQuote.origin.react = async (emoji) => {
		reactedEmoji = emoji;
	};

	await cmdAdd.execute(bot, msgAddQuote, ["azeite"], mockGroup);

	assert.strictEqual(
		bot.capturedMessages.length,
		0,
		"Não deve enviar mensagem nova ao responder em quote"
	);
	assert.strictEqual(bot.editedMessages.length, 1, "Deve editar in-place a mensagem citada");
	assert.strictEqual(reactedEmoji, "✅", "Deve reagir com ✅");

	// Testando !lista
	bot.resetCapture();
	bot.editedMessages = [];
	const cmdLista = ListCommands.commands.find((c) => c.name === "lista");
	const msgLista = createMessage({
		content: "!lista compras do mes",
		group: groupId,
		author: userCommon
	});
	await cmdLista.execute(bot, msgLista, ["compras", "do", "mes"], mockGroup);

	assert.strictEqual(bot.editedMessages.length, 0, "!lista nunca deve editar");
	assert.strictEqual(bot.capturedMessages.length, 1, "!lista deve sempre enviar nova mensagem");
	assert.ok(
		bot.capturedMessages[0].content.includes("Compras do Mês da Casa"),
		"!lista deve conter os dados atualizados da lista"
	);
	console.log("✓ !add em quote editou in-place e !lista enviou mensagem nova com sucesso.");

	// Limpeza da lista de teste
	await cmdLd.execute(bot, msgLd, ["compras do mes"], mockGroup);

	console.log("\n=======================================================");
	console.log("✓ TODOS OS 14 TESTES DO ListCommands v2 PASSARAM COM SUCESSO!");
	console.log("=======================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("\n❌ ERRO NA SUÍTE DE TESTES:", err);
		process.exit(1);
	});
