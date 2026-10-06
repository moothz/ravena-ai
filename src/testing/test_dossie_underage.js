process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const SummaryCommands = require("../functions/SummaryCommands");
const LLMService = require("../services/LLMService");
const llmService = LLMService.getInstance();

async function runTests() {
	console.log("--- Starting Dossie Underage Detection Tests ---");

	const bot = new FakeBot({
		id: "test-bot",
		dossieGroups: "dossie-target@g.us",
		grupoLogs: "logs@g.us"
	});

	const testChatId = "120363000000000001@g.us";

	// Mock do grupo no banco do bot
	await bot.database.saveGroup({
		id: testChatId,
		name: "Turma do 8º Ano A"
	});

	// Salva a função original de getCompletion
	const originalGetCompletion = llmService.getCompletion;

	try {
		// ==========================================
		// Teste 1: Detecção de crianças/adolescentes
		// Com nota retornada menor que 8 (deve ser ajustada para >= 8 e disparar alerta)
		// ==========================================
		console.log("1. Testando análise com grupo de crianças/adolescentes...");

		llmService.getCompletion = async (opts) => {
			// Verifica se o schema inclui is_underage e underage_indicators
			const schemaProps = opts.response_format?.json_schema?.schema?.properties;
			assert.ok(schemaProps?.is_underage, "Schema must include is_underage property");
			assert.ok(
				schemaProps?.underage_indicators,
				"Schema must include underage_indicators property"
			);
			assert.ok(
				opts.response_format?.json_schema?.schema?.required?.includes("is_underage"),
				"is_underage must be required in schema"
			);

			// Retorna resposta simulando IA identificando crianças/adolescentes
			return JSON.stringify({
				type: "escola",
				summary:
					"Grupo de estudantes do ensino fundamental conversando sobre provas escolares e idade.",
				is_underage: true,
				underage_indicators: [
					"Membro informou ter 13 anos",
					"Conversas sobre prova de matemática do 8º ano"
				],
				problematic_score: 5, // Nota retornada baixa de propósito para testar auto-elevação para 8
				classified_items: [
					{
						category: "Crianças/Adolescentes",
						evidence: "Pedrinho: tenho 13 anos e estudo no 8º ano"
					}
				]
			});
		};

		const conversationText =
			"Pedrinho: tenho 13 anos e estudo no 8º ano\nAninha: você já estudou pra prova de matemática amanhã?\nPedrinho: ainda não, preciso fazer a lição de casa";

		await SummaryCommands.runGroupAnalysis(testChatId, conversationText, bot);

		// Verifica se o alerta foi enviado para o dossieGroups
		assert.strictEqual(
			bot.capturedMessages.length,
			1,
			"Deve ter enviado 1 alerta para o grupo de dossiês"
		);
		const alertMsg = bot.capturedMessages[0];
		assert.strictEqual(
			alertMsg.chatId,
			"dossie-target@g.us",
			"Alerta deve ter como destino o dossieGroups"
		);
		assert.ok(
			alertMsg.content.includes("ALERTA DE GRUPO DE CRIANÇAS/ADOLESCENTES"),
			"Alerta deve conter título de crianças/adolescentes"
		);
		assert.ok(
			alertMsg.content.includes("Crianças/Adolescentes:* Detectado ⚠️"),
			"Alerta deve indicar que crianças/adolescentes foram detectados"
		);
		assert.ok(
			alertMsg.content.includes("Nota:* 8/10"),
			"Nota deve ter sido ajustada para pelo menos 8/10"
		);
		assert.ok(
			alertMsg.content.includes("Pedrinho: tenho 13 anos"),
			"Alerta deve conter evidências da conversa"
		);
		console.log("✓ Alerta enviado corretamente com nota ajustada e tags de menores");

		// Verifica no banco de dados SQLite
		const savedDossiers = await bot.database.getLastGroupDossiers(testChatId, 5);
		assert.ok(savedDossiers && savedDossiers.length > 0, "Dossiê deve ter sido salvo no banco");
		const latest = savedDossiers[0];
		assert.strictEqual(latest.problematic_score, 8, "problematic_score no banco deve ser 8");
		assert.strictEqual(latest.is_underage, 1, "is_underage no banco deve ser 1");
		const parsedJson = JSON.parse(latest.dossier_json);
		assert.strictEqual(parsedJson.is_underage, true, "is_underage no JSON deve ser true");
		assert.strictEqual(parsedJson.problematic_score, 8, "problematic_score no JSON deve ser 8");
		console.log("✓ Registro gravado com sucesso no banco de dados com colunas atualizadas");

		// ==========================================
		// Teste 2: Grupo adulto/neutro (is_underage: false, nota baixa)
		// Não deve disparar alerta
		// ==========================================
		console.log("2. Testando grupo comum de adultos (sem alerta)...");
		bot.resetCapture();

		const adultChatId = "120363000000000002@g.us";
		await bot.database.saveGroup({
			id: adultChatId,
			name: "Trabalho Escritório"
		});

		llmService.getCompletion = async () =>
			JSON.stringify({
				type: "trabalho",
				summary: "Discussão corporativa sobre relatórios mensais e metas.",
				is_underage: false,
				underage_indicators: [],
				problematic_score: 0,
				classified_items: []
			});

		await SummaryCommands.runGroupAnalysis(
			adultChatId,
			"Carlos: bom dia a todos, enviando relatório trimestral em anexo.\nMariana: recebido Carlos, obrigada.",
			bot
		);

		assert.strictEqual(bot.capturedMessages.length, 0, "Grupo neutro não deve disparar alerta");

		const adultDossiers = await bot.database.getLastGroupDossiers(adultChatId, 5);
		assert.strictEqual(adultDossiers[0].problematic_score, 0);
		assert.strictEqual(adultDossiers[0].is_underage, 0);
		console.log("✓ Grupo neutro processado sem alertas indevidos");

		console.log("--- ALL TESTS PASSED SUCCESSFULLY! ---");
		process.exit(0);
	} catch (err) {
		console.error("Test failed:", err);
		process.exit(1);
	} finally {
		llmService.getCompletion = originalGetCompletion;
	}
}

runTests().catch((err) => {
	console.error("Erro fatal no teste:", err);
	process.exit(1);
});
