"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const RankingMessages = require("../functions/RankingMessages");

async function runTests() {
	console.log("=== Iniciando testes de !faladores-atividade ===");
	const database = Database.getInstance();
	const testChatId = "test_atividade_grupo@g.us";
	const now = Date.now();

	// 1. Limpa registros anteriores de teste
	await database.dbRun("msgranking", "DELETE FROM ranking WHERE chat_id = ?", [testChatId]);

	// 2. Insere participantes com diferentes janelas de atividade
	const testUsers = [
		{ id: "55110001@s.whatsapp.net", name: "Alice", count: 10, ts: now - 2 * 3600 * 1000 }, // 2h (< 12h)
		{ id: "55110002@s.whatsapp.net", name: "Bob", count: 8, ts: now - 16 * 3600 * 1000 }, // 16h (< 1d)
		{ id: "55110003@s.whatsapp.net", name: "Carlos", count: 15, ts: now - 48 * 3600 * 1000 }, // 2 dias (1-3d)
		{ id: "55110004@s.whatsapp.net", name: "Daniel", count: 6, ts: now - 4 * 24 * 3600 * 1000 }, // 4 dias (3-5d)
		{ id: "55110005@s.whatsapp.net", name: "Eduardo", count: 12, ts: now - 6 * 24 * 3600 * 1000 }, // 6 dias (5-7d)
		{ id: "55110006@s.whatsapp.net", name: "Fabio", count: 4, ts: now - 10 * 24 * 3600 * 1000 }, // 10 dias (7-15d)
		{ id: "55110007@s.whatsapp.net", name: "Gabriel", count: 3, ts: now - 20 * 24 * 3600 * 1000 }, // 20 dias (15-30d)
		{ id: "55110008@s.whatsapp.net", name: "Hugo", count: 2, ts: now - 45 * 24 * 3600 * 1000 }, // 45 dias (> 30d)
		{ id: "55110009@s.whatsapp.net", name: "Igor", count: 5, ts: null } // legado sem timestamp
	];

	for (const u of testUsers) {
		await database.dbRun(
			"msgranking",
			`INSERT INTO ranking (chat_id, user_id, user_name, message_count, reaction_count, last_message_at)
			 VALUES (?, ?, ?, ?, 0, ?)`,
			[testChatId, u.id, u.name, u.count, u.ts]
		);
	}

	// Participantes presentes no grupo (incluindo Julia, que nunca enviou mensagem)
	const participants = [
		...testUsers.map((u) => ({
			JID: u.id,
			PhoneNumber: u.id.split("@")[0],
			DisplayName: u.name
		})),
		{
			JID: "55110010@s.whatsapp.net",
			PhoneNumber: "55110010",
			DisplayName: "Julia"
		}
	];

	const bot = new FakeBot({ id: "teste-bot" });

	function buildTestMsg(content, args = []) {
		return {
			...createMessage({
				content,
				group: testChatId,
				author: "55110001@s.whatsapp.net",
				authorName: "Alice"
			}),
			origin: {
				groupData: {
					Participants: participants
				}
			}
		};
	}

	// 3. Teste da visão geral de !faladores-atividade
	console.log("Testando visão geral do comando !faladores-atividade...");
	const resGeral = await RankingMessages.faladoresAtividadeCommand(
		bot,
		buildTestMsg("!faladores-atividade"),
		[],
		{}
	);
	assert(resGeral, "Deveria retornar ReturnMessage");
	const txtGeral = resGeral.content;
	console.log("\n--- Resposta Geral ---\n" + txtGeral + "\n----------------------\n");

	assert(txtGeral.includes("Rank de Atividade"), "Deve conter título do rank");
	assert(txtGeral.includes("*Total de membros analisados:* 10"), "Deve contar 10 membros");
	assert(txtGeral.includes("Alice"), "Alice deve estar na listagem");
	assert(txtGeral.includes("Bob"), "Bob deve estar na listagem");
	assert(txtGeral.includes("Carlos"), "Carlos deve estar na listagem");
	assert(txtGeral.includes("Daniel"), "Daniel deve estar na listagem");
	assert(txtGeral.includes("Eduardo"), "Eduardo deve estar na listagem");
	assert(txtGeral.includes("Fabio"), "Fabio deve estar na listagem");
	assert(txtGeral.includes("Gabriel"), "Gabriel deve estar na listagem");
	assert(txtGeral.includes("Hugo"), "Hugo deve estar na listagem");
	assert(txtGeral.includes("Igor"), "Igor deve estar na listagem de sem registro recente");
	assert(txtGeral.includes("Julia"), "Julia deve estar na lista de nunca");
	console.log("✓ Visão geral validada com sucesso");

	// 4. Teste do filtro 'nunca'
	console.log("Testando filtro '!faladores-atividade nunca'...");
	const resNunca = await RankingMessages.faladoresAtividadeCommand(
		bot,
		buildTestMsg("!faladores-atividade nunca"),
		["nunca"],
		{}
	);
	const txtNunca = resNunca.content;
	assert(txtNunca.includes("Julia"), "Deve listar Julia em nunca");
	assert(!txtNunca.includes("Alice"), "Não deve listar Alice em nunca");
	assert(!txtNunca.includes("Hugo"), "Não deve listar Hugo em nunca");
	console.log("✓ Filtro 'nunca' validado com sucesso");

	// 5. Teste do filtro 'inativos'
	console.log("Testando filtro '!faladores-atividade inativos'...");
	const resInativos = await RankingMessages.faladoresAtividadeCommand(
		bot,
		buildTestMsg("!faladores-atividade inativos"),
		["inativos"],
		{}
	);
	const txtInativos = resInativos.content;
	assert(txtInativos.includes("Fabio"), "Deve incluir Fabio (10 dias)");
	assert(txtInativos.includes("Gabriel"), "Deve incluir Gabriel (20 dias)");
	assert(txtInativos.includes("Hugo"), "Deve incluir Hugo (45 dias)");
	assert(txtInativos.includes("Julia"), "Deve incluir Julia (nunca)");
	assert(!txtInativos.includes("Alice"), "Não deve incluir Alice (<12h)");
	assert(!txtInativos.includes("Bob"), "Não deve incluir Bob (<1d)");
	console.log("✓ Filtro 'inativos' validado com sucesso");

	// 6. Teste de filtro específico '12h'
	console.log("Testando filtro específico '!faladores-atividade 12h'...");
	const res12h = await RankingMessages.faladoresAtividadeCommand(
		bot,
		buildTestMsg("!faladores-atividade 12h"),
		["12h"],
		{}
	);
	const txt12h = res12h.content;
	assert(txt12h.includes("Alice"), "Deve incluir Alice em 12h");
	assert(!txt12h.includes("Bob"), "Não deve incluir Bob em 12h");
	console.log("✓ Filtro '12h' validado com sucesso");

	// 7. Teste de atualização de timestamp via processMessage e processReaction
	console.log("Testando atualização de timestamp via processMessage e processReaction...");
	const newTime = Date.now() + 1000;
	await RankingMessages.processMessage({
		author: "55110010@s.whatsapp.net",
		group: testChatId,
		name: "Julia",
		timestamp: Math.floor(newTime / 1000)
	});

	const rankingAposMsg = await RankingMessages.getMessageRanking(testChatId);
	const juliaRank = rankingAposMsg.find((r) => r.numero === "55110010@s.whatsapp.net");
	assert(juliaRank, "Julia deve estar no ranking agora");
	assert.strictEqual(juliaRank.qtdMsgs, 1, "Julia deve ter 1 mensagem");
	assert(juliaRank.last_message_at > 0, "last_message_at deve estar gravado");

	await RankingMessages.processReaction({
		senderId: "55110010@s.whatsapp.net",
		chatId: testChatId,
		userName: "Julia",
		timestamp: Math.floor((newTime + 2000) / 1000)
	});

	const rankingAposReaction = await RankingMessages.getMessageRanking(testChatId);
	const juliaRank2 = rankingAposReaction.find((r) => r.numero === "55110010@s.whatsapp.net");
	assert.strictEqual(juliaRank2.qtdMsgs, 2, "Julia deve ter 2 mensagens (1 msg + 1 reacao)");

	// 8. Limpeza do banco de teste
	await database.dbRun("msgranking", "DELETE FROM ranking WHERE chat_id = ?", [testChatId]);
	console.log("✓ Limpeza de banco concluída");

	console.log("=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Falha no teste:", err);
		process.exit(1);
	});
