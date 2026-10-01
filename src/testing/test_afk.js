process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const Database = require("../utils/Database");

async function main() {
	console.log("🚀 Iniciando suíte de testes do módulo AFK...");

	const bot = new FakeBot({ id: "bot-teste" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	const database = Database.getInstance();

	const groupId = "120363000000000000@g.us";
	const afkUserJid = "5511999998888@s.whatsapp.net";
	const afkUserLid = "9876543210@lid";

	// Limpa dados de execuções anteriores do teste
	await database.dbRun("afk", "DELETE FROM afk_sessions WHERE group_id = ?", [groupId]);

	async function waitForReply(maxMs = 5000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length > 0) return;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`Timeout de ${maxMs}ms aguardando resposta`);
	}

	// 1. Teste do comando !afk
	console.log("▶️ Teste 1: Executando comando !afk");
	bot.resetCapture();
	const msgAfk = createMessage({
		author: afkUserJid,
		authorAlt: afkUserLid,
		authorName: "João Silva",
		content: "!afk Estudando para a prova de cálculo",
		group: groupId
	});

	await eventHandler.processMessage(bot, msgAfk);
	await waitForReply();

	assert.strictEqual(
		bot.capturedMessages.length,
		1,
		"Deveria ter capturado 1 mensagem de resposta"
	);
	const respAfk = bot.capturedMessages[0].content;
	console.log("   Resposta !afk:", respAfk);
	assert.match(
		respAfk,
		/João Silva agora está AFK/,
		"Resposta deve indicar que o usuário está AFK"
	);
	assert.match(respAfk, /Estudando para a prova de cálculo/, "Resposta deve conter o motivo");

	bot.resetCapture();

	// 2. Teste do comando !afk-lista
	console.log("▶️ Teste 2: Executando comando !afk-lista");
	const msgLista = createMessage({
		author: "5511911112222@s.whatsapp.net",
		authorName: "Maria",
		content: "!afk-lista",
		group: groupId
	});

	await eventHandler.processMessage(bot, msgLista);
	await waitForReply();
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria ter capturado 1 mensagem de lista");
	const respLista = bot.capturedMessages[0].content;
	console.log("   Resposta !afk-lista:\n", respLista);
	assert.match(respLista, /Membros AFK neste grupo/, "Resposta da lista deve conter cabeçalho");
	assert.match(respLista, /João Silva/, "Resposta da lista deve conter o usuário AFK");

	bot.resetCapture();

	// 3. Teste de menção por LID ao usuário AFK
	console.log("▶️ Teste 3: Outro usuário menciona o usuário AFK por LID");
	const msgMencaoLid = createMessage({
		author: "5511911112222@s.whatsapp.net",
		authorName: "Maria",
		content: "Ei @João Silva vem ver isso!",
		group: groupId
	});
	msgMencaoLid.mentions = [afkUserLid];

	await eventHandler.processMessage(bot, msgMencaoLid);
	await waitForReply();
	assert.strictEqual(bot.capturedMessages.length, 1, "Deveria responder com aviso de AFK");
	const respMencao = bot.capturedMessages[0].content;
	console.log("   Aviso de menção:\n", respMencao);
	assert.match(respMencao, /João Silva está AFK!/, "Aviso deve informar que João está AFK");
	assert.match(respMencao, /Estudando para a prova de cálculo/, "Aviso deve exibir o motivo");

	bot.resetCapture();

	// 3B. Teste de citação/reply à mensagem do usuário AFK
	console.log(
		"▶️ Teste 3B: Outro usuário responde (quote/reply) a uma mensagem de usuária AFK (Ana)"
	);
	const afkUser2Jid = "5511977771111@s.whatsapp.net";
	const afkUser2Lid = "1111222233@lid";

	const msgAfk2 = createMessage({
		author: afkUser2Jid,
		authorAlt: afkUser2Lid,
		authorName: "Ana Souza",
		content: "!afk Reunião",
		group: groupId
	});
	await eventHandler.processMessage(bot, msgAfk2);
	await waitForReply();
	bot.resetCapture();

	const msgQuoteAfk = createMessage({
		author: "5511977776666@s.whatsapp.net",
		authorName: "Carlos",
		content: "Respondendo sua mensagem anterior!",
		group: groupId,
		hasQuotedMsg: true,
		quotedMsg: { author: afkUser2Jid }
	});
	msgQuoteAfk.origin.getQuotedMessage = async () => ({
		author: afkUser2Jid,
		authorAlt: afkUser2Lid
	});

	await eventHandler.processMessage(bot, msgQuoteAfk);
	await waitForReply();
	assert.strictEqual(
		bot.capturedMessages.length,
		1,
		"Deveria responder com aviso de AFK na citação"
	);
	const respQuote = bot.capturedMessages[0].content;
	console.log("   Aviso de citação:\n", respQuote);
	assert.match(
		respQuote,
		/Ana Souza está AFK!/,
		"Aviso deve informar que Ana está AFK via citação"
	);

	bot.resetCapture();

	// 4. Teste de retorno automático do AFK quando o próprio usuário manda mensagem
	console.log("▶️ Teste 4: Usuário AFK envia mensagem (saída de AFK + reação 🏁)");
	let reactionApplied = null;
	const msgRetorno = createMessage({
		author: afkUserJid,
		authorAlt: afkUserLid,
		authorName: "João Silva",
		content: "Voltei pessoal!",
		group: groupId
	});
	msgRetorno.origin.react = async (emoji) => {
		reactionApplied = emoji;
	};

	await eventHandler.processMessage(bot, msgRetorno);
	await new Promise((r) => setTimeout(r, 300));

	const msgRetornoAna = createMessage({
		author: afkUser2Jid,
		authorAlt: afkUser2Lid,
		authorName: "Ana Souza",
		content: "Voltei da reunião!",
		group: groupId
	});
	await eventHandler.processMessage(bot, msgRetornoAna);
	await new Promise((r) => setTimeout(r, 300));

	assert.strictEqual(
		bot.capturedMessages.length,
		0,
		"NENHUMA mensagem de texto deve ser enviada no retorno"
	);
	assert.strictEqual(reactionApplied, "🏁", "Reação deve ser 🏁 na mensagem de retorno");
	console.log("   Reação 🏁 aplicada com sucesso!");

	// Verifica se a sessão no banco foi marcada como inativa (is_active = 0) e tem exited_at
	const sessions = await database.dbAll(
		"afk",
		"SELECT * FROM afk_sessions WHERE group_id = ? AND user_id = ?",
		[groupId, afkUserJid]
	);
	assert.strictEqual(sessions.length, 1, "Deveria ter 1 registro de sessão no histórico");
	assert.strictEqual(sessions[0].is_active, 0, "Sessão deve estar inativa (0)");
	assert.notStrictEqual(
		sessions[0].exited_at,
		null,
		"exited_at deve ter sido preenchido com timestamp"
	);
	console.log("   Sessão registrada no histórico com sucesso!");

	// 5. Teste do comando !afk-lista quando o grupo não possui AFKs
	console.log("▶️ Teste 5: !afk-lista após retorno");
	bot.resetCapture();
	const msgListaVazia = createMessage({
		author: "5511933334444@s.whatsapp.net",
		authorName: "Pedro",
		content: "!afk-lista",
		group: groupId
	});
	await eventHandler.processMessage(bot, msgListaVazia);
	await waitForReply();
	assert.match(
		bot.capturedMessages[0].content,
		/Nenhum membro está AFK/,
		"Deve indicar que não há ninguém AFK"
	);

	console.log("✅ Todos os testes de AFK passaram com sucesso!");
	process.exit(0);
}

main().catch((err) => {
	console.error("❌ Erro no teste de AFK:", err);
	process.exit(1);
});
