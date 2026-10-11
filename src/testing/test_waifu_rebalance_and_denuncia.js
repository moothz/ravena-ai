const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");
const SuperAdmin = require("../commands/SuperAdmin");

async function runTests() {
	console.log("=== Iniciando Testes: Rebalanceamento Waifuletes, Rankings e Denúncias ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "logs123@g.us" });
	const superAdmin = new SuperAdmin();

	// ── 1. Verificação do registro de comandos de denúncia ──
	console.log("\n1. Verificando comandos mu-denunciar e mu-report...");
	const cmdDenunciar = WaifuCommands.commands.find((c) => c.name === "mu-denunciar");
	assert.ok(cmdDenunciar, "Comando mu-denunciar deve estar registrado");
	assert.strictEqual(typeof cmdDenunciar.method, "function");
	assert.ok(
		cmdDenunciar.reactions &&
			(cmdDenunciar.reactions.trigger === "⛔" ||
				(Array.isArray(cmdDenunciar.reactions.trigger) &&
					cmdDenunciar.reactions.trigger.includes("⛔"))),
		"Reação ⛔ deve ser gatilho de mu-denunciar"
	);

	const cmdReport = WaifuCommands.commands.find((c) => c.name === "mu-report");
	assert.ok(cmdReport, "Alias mu-report deve estar registrado");

	const helperDenunciar = WaifuCommands.helper.cmds.find((c) => c.cmd === "!mu-denunciar");
	assert.ok(helperDenunciar, "!mu-denunciar deve estar documentado no helper.cmds");

	const helperRanking = WaifuCommands.helper.cmds.find((c) => c.cmd === "!mu-ranking");
	assert.ok(helperRanking, "!mu-ranking deve estar documentado");
	assert.ok(
		helperRanking.usage.some((u) => u.includes("all")),
		"helper de ranking deve incluir exemplos de 'all'"
	);
	console.log("✓ Comandos e documentação registrados corretamente.");

	// ── 2. Teste de rastreamento de IDs para moderação ──
	console.log("\n2. Testando histórico de IDs de roll...");
	const msgId = "TEST_STANZA_456";
	const charId = "test-waifu-id";
	WaifuCommands.recordRollMessage(msgId, charId, "group1@g.us");

	const resolvedId = WaifuCommands.getCharacterIdFromMessageId("456");
	assert.strictEqual(resolvedId, charId, "Deve resolver ID do personagem pelo stanzaId");
	console.log("✓ Rastreamento de histórico de roll funcionando.");

	// ── 3. Teste do Ranking Consolidado e 'all' ──
	console.log("\n3. Testando visualização de Rankings (Consolidado e Detalhado)...");
	// Mock da API Axios
	const origGet = WaifuCommands.api.get;
	const origPost = WaifuCommands.api.post;

	WaifuCommands.api.get = async (url, config) => {
		if (url.includes("/leaderboard/users")) {
			return {
				data: {
					success: true,
					data: {
						topRich: [
							{
								id: "5511999990001",
								name: "Player One",
								kakera: 5000,
								_count: { harem: 15, soulmates: 2 }
							},
							{
								id: "5511999990002",
								name: "Player Two",
								kakera: 3200,
								_count: { harem: 8, soulmates: 0 }
							}
						]
					}
				}
			};
		}
		if (url.includes("/leaderboard/harem")) {
			return {
				data: {
					success: true,
					data: {
						topHarem: [
							{
								id: "5511999990003",
								name: "Harem Master",
								collectionPoints: 420,
								totalMarriages: 10,
								totalKeys: 25,
								commonCount: 2,
								uncommonCount: 3,
								rareCount: 3,
								epicCount: 1,
								legendaryCount: 1
							}
						]
					}
				}
			};
		}
		if (
			url.startsWith("/characters/test-waifu-id") ||
			url.startsWith("/characters/frieren") ||
			url.startsWith("/characters/common-ringtail-possum")
		) {
			const isPossum = url.includes("possum");
			return {
				data: {
					success: true,
					data: {
						id: isPossum ? "common-ringtail-possum" : "frieren-sousou-no-frieren",
						name: isPossum ? "Common Ringtail Possum" : "Frieren",
						series: isPossum ? "Kemono Friends" : "Sousou no Frieren",
						baseRarity: isPossum ? "COMMON" : "EPIC",
						claimCount: 4,
						likeCount: 12,
						imageUrl: "http://example.com/char.jpg"
					}
				}
			};
		}
		return origGet(url, config);
	};

	const rankMsg = createMessage({
		content: "!mu-ranking",
		group: "group1@g.us",
		author: "5511999990001@s.whatsapp.net"
	});

	// 3.1 Ranking padrão (Duplo)
	const dualRes = await WaifuCommands.verRanking(bot, rankMsg, [], null);
	assert.ok(
		dualRes.content.includes("PAINEL DE LIDERANÇA WAIFULETES"),
		"Deve conter título do painel"
	);
	assert.ok(
		dualRes.content.includes("Top 10 — Mais Ricos (Zinthos)"),
		"Deve conter ranking de zinthos"
	);
	assert.ok(
		dualRes.content.includes("Top 10 — Maiores Colecionadores"),
		"Deve conter ranking de casamentos"
	);
	assert.ok(dualRes.content.includes("Player One"), "Deve listar Player One");
	assert.ok(dualRes.content.includes("Harem Master"), "Deve listar Harem Master");
	console.log("✓ Ranking consolidado (duplo) validado.");

	// 3.2 Ranking Casamentos All
	const haremAllRes = await WaifuCommands.verRanking(bot, rankMsg, ["casamentos", "all"], null);
	assert.ok(
		haremAllRes.content.includes("Ranking de Colecionadores de Waifus"),
		"Deve conter cabeçalho de colecionadores"
	);
	assert.ok(haremAllRes.content.includes("Harem Master"), "Deve listar jogador");
	assert.ok(haremAllRes.content.includes("420 pts"), "Deve exibir pontuação de raridade");
	console.log("✓ Ranking 'casamentos all' validado.");

	// 3.3 Ranking Zinthos All
	const zinthosAllRes = await WaifuCommands.verRanking(bot, rankMsg, ["zinthos", "all"], null);
	assert.ok(
		zinthosAllRes.content.includes("Ranking de Jogadores Mais Ricos"),
		"Deve conter cabeçalho de Zinthos"
	);
	assert.ok(zinthosAllRes.content.includes("5000"), "Deve exibir saldo de Zinthos");
	console.log("✓ Ranking 'zinthos all' validado.");

	// ── 4. Teste de Denúncia (!mu-denunciar) ──
	console.log("\n4. Testando fluxo de denúncia (mu-denunciar)...");

	// 4.1 Denúncia por argumento direto
	const denMsgArgs = createMessage({
		content: "!mu-denunciar frieren",
		group: "group1@g.us",
		author: "5511999990001@s.whatsapp.net"
	});
	const denResults = await WaifuCommands.denunciarWaifu(bot, denMsgArgs, ["frieren"], {
		name: "Anime Group"
	});
	assert.ok(Array.isArray(denResults), "Deve retornar array de ReturnMessages");
	// Verifica se enviou mensagem para grupoLogs e confirmação para o grupo
	const logMsg = denResults.find(
		(m) => m.chatId === "logs123@g.us" && typeof m.content === "string"
	);
	assert.ok(logMsg, "Deve enviar mensagem com comando para o grupo de logs");
	assert.ok(logMsg.content.includes("!sa-remudae frieren-sousou-no-frieren"));

	const userReply = denResults.find((m) => m.chatId === "group1@g.us");
	assert.ok(userReply, "Deve enviar confirmação para o grupo de origem");
	assert.ok(userReply.content.includes("Denúncia Registrada"));
	console.log("✓ Denúncia por argumento direto validada com sucesso.");

	// 4.2 Denúncia por citação (quoted message com ID registrado)
	const denMsgQuote = createMessage({
		content: "!mu-denunciar",
		group: "group1@g.us",
		author: "5511999990001@s.whatsapp.net"
	});
	denMsgQuote.origin.getQuotedMessage = async () => ({
		id: { _serialized: "TEST_STANZA_456" },
		caption: "🎲 *Frieren* — _Sousou no Frieren_"
	});
	const quoteResults = await WaifuCommands.denunciarWaifu(bot, denMsgQuote, [], {
		name: "Anime Group"
	});
	assert.ok(Array.isArray(quoteResults));
	assert.ok(quoteResults.some((m) => m.content?.includes("Denúncia Registrada")));
	console.log("✓ Denúncia por citação validada com sucesso.");

	// 4.3 Denúncia por reação ⛔
	const denMsgReact = createMessage({
		content: "🎲 *Frieren* — _Sousou no Frieren_",
		group: "group1@g.us",
		author: "5511999990001@s.whatsapp.net"
	});
	denMsgReact.originReaction = {
		reaction: "⛔",
		msgId: { _serialized: "TEST_STANZA_456" },
		senderId: "5511999990001@s.whatsapp.net"
	};
	denMsgReact.id = "TEST_STANZA_456";

	const reactResults = await WaifuCommands.denunciarWaifu(bot, denMsgReact, [], {
		name: "Anime Group"
	});
	assert.ok(Array.isArray(reactResults));
	assert.ok(reactResults.some((m) => m.content?.includes("Denúncia Registrada")));
	console.log("✓ Denúncia por reação ⛔ validada com sucesso.");

	// 4.4 Denúncia por reação ⛔ com texto completo de roll repassado nos args pelo ReactionsHandler
	const fullRollCaption =
		"🎲 Common Ringtail Possum — Kemono Friends ⚪ [Comum] Common Ringtail Possum é uma personagem de Kemono Friends. 💍 LIVRE! Reaja com 💍 ou use !mu-casar (ou !mu-casar common-ringtail-possum) em até 300s para casar! ✨ Fragmentos colhidos: +39 Zinthos (+16 por 8 rolls restantes) 🎟️ Rolls restantes: 8/10";
	const denMsgFullReact = createMessage({
		content: fullRollCaption,
		caption: fullRollCaption,
		group: "group1@g.us",
		author: "5511999990001@s.whatsapp.net"
	});
	denMsgFullReact.originReaction = {
		reaction: "⛔",
		msgId: { _serialized: "MSG_POSSUM_999" },
		senderId: "5511999990001@s.whatsapp.net"
	};
	denMsgFullReact.id = "MSG_POSSUM_999";
	// Simula exatamente o comportamento do ReactionsHandler, que divide o texto da mensagem em args
	const simulatedArgs = fullRollCaption.split(/\s+/);

	const fullReactResults = await WaifuCommands.denunciarWaifu(bot, denMsgFullReact, simulatedArgs, {
		name: "Anime Group"
	});
	assert.ok(Array.isArray(fullReactResults), "Deve retornar array de ReturnMessages");
	const possumLogMsg = fullReactResults.find(
		(m) => m.chatId === "logs123@g.us" && typeof m.content === "string"
	);
	assert.ok(possumLogMsg, "Deve enviar mensagem com comando para o grupo de logs");
	assert.ok(
		possumLogMsg.content.includes("!sa-remudae common-ringtail-possum"),
		"Deve extrair o slug common-ringtail-possum mesmo com todos os args passados pelo ReactionsHandler"
	);
	console.log(
		"✓ Denúncia por reação ⛔ com texto completo e args do ReactionsHandler validada com sucesso!"
	);

	// ── 5. Teste do SuperAdmin !sa-remudae ──
	console.log("\n5. Testando comando SuperAdmin !sa-remudae...");

	WaifuCommands.api.post = async (url, data) => {
		if (url === "/admin/characters/purge-character") {
			return {
				data: {
					success: true,
					data: {
						character: {
							id: data.characterId,
							name: "Personagem Removido",
							series: "Serie Problemática",
							rarity: "RARE"
						},
						marriagesUndone: 3,
						totalKakeraRefunded: 996,
						message: "Personagem removido com sucesso."
					}
				}
			};
		}
		return origPost(url, data);
	};

	// 5.1 Permissão negada para usuário comum
	const commonMsg = createMessage({
		content: "!sa-remudae persona-bad",
		author: "5511999999999@s.whatsapp.net"
	});
	const deniedRes = await superAdmin.removerMudaePersonagem(bot, commonMsg, ["persona-bad"], null);
	assert.ok(deniedRes.content.includes("exclusivo para SuperAdministradores"));
	console.log("✓ Permissão de SuperAdmin validada (acesso negado para não-admin).");

	// 5.2 Execução com sucesso por SuperAdmin
	superAdmin.isSuperAdmin = (id) => String(id).includes("5511888888888");

	// Registra mensagem de confirmação de denúncia para persona-bad para testar edição automática
	const waifuMsgIdToEdit = "3EB0WAIFU_REPORT_CONFIRM_123";
	const waifuChatId = "120363111111111111@g.us";
	WaifuCommands.recordWaifuReportConfirmation(
		waifuMsgIdToEdit,
		"persona-bad",
		waifuChatId,
		bot.id,
		"⛔ *Denúncia Registrada!*\n\nO personagem *Personagem Ruim* foi encaminhado para a equipe de moderação. Obrigado por ajudar a manter o catálogo seguro!"
	);

	bot.editedMessages = [];
	const adminMsg = createMessage({
		content: "!sa-remudae persona-bad Conteúdo impróprio",
		author: "5511888888888@s.whatsapp.net"
	});
	const purgeRes = await superAdmin.removerMudaePersonagem(
		bot,
		adminMsg,
		["persona-bad", "Conteúdo", "impróprio"],
		null
	);
	assert.ok(purgeRes.content.includes("Personagem Removido do Waifuletes com Sucesso!"));
	assert.ok(purgeRes.content.includes("Casamentos desfeitos"));
	assert.ok(purgeRes.content.includes("996 Zinthos"));
	assert.ok(purgeRes.content.includes("Conteúdo impróprio"));

	assert.strictEqual(
		bot.editedMessages.length,
		1,
		"Deve ter invocado editMessage para a confirmação de denúncia do waifu"
	);
	assert.strictEqual(bot.editedMessages[0].messageId, waifuMsgIdToEdit);
	assert.strictEqual(bot.editedMessages[0].chat, waifuChatId);
	assert.ok(
		bot.editedMessages[0].text.endsWith("Conteúdo removido com sucesso! ✅"),
		"Mensagem editada deve terminar com 'Conteúdo removido com sucesso! ✅'"
	);
	console.log(
		"✓ Execução de !sa-remudae com sucesso, estorno e edição de mensagem de denúncia validada."
	);

	// Restaura mocks
	WaifuCommands.api.get = origGet;
	WaifuCommands.api.post = origPost;

	console.log("\n=======================================================");
	console.log("TODOS OS TESTES DE REBALANCEAMENTO E MODERAÇÃO PASSARAM!");
	console.log("=======================================================\n");

	process.exit(0);
}

runTests().catch((err) => {
	console.error("Erro no teste:", err);
	process.exit(1);
});
