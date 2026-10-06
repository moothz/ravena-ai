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
		// Teste 1: Grupo de crianças/adolescentes comum (peso base 4, sem agravantes)
		// NÃO deve enviar alerta para o grupo de dossiês (nota 4 <= 7)
		// ==========================================
		console.log("1. Testando análise com grupo comum de adolescentes (peso base 4, sem alerta)...");

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

			// Retorna resposta simulando IA identificando crianças/adolescentes neutros
			return JSON.stringify({
				type: "escola",
				summary:
					"Grupo de estudantes do ensino fundamental conversando sobre provas escolares e idade.",
				is_underage: true,
				underage_indicators: [
					"Membro informou ter 13 anos",
					"Conversas sobre prova de matemática do 8º ano"
				],
				problematic_score: 2, // Se vier menor que 4, o código deve garantir peso base 4
				classified_items: [
					{
						category: "Crianças/Adolescentes (até 16 anos)",
						evidence: "Pedrinho: tenho 13 anos e estudo no 8º ano"
					}
				]
			});
		};

		const conversationText =
			"Pedrinho: tenho 13 anos e estudo no 8º ano\nAninha: você já estudou pra prova de matemática amanhã?\nPedrinho: ainda não, preciso fazer a lição de casa";

		await SummaryCommands.runGroupAnalysis(testChatId, conversationText, bot);

		// Como é grupo adolescente comum (nota 4 <= 7), NÃO deve enviar alerta
		assert.strictEqual(
			bot.capturedMessages.length,
			0,
			"Grupo adolescente comum (nota 4) NÃO deve enviar alerta para o grupo de dossiês"
		);

		// Verifica no banco de dados SQLite
		const savedDossiers = await bot.database.getLastGroupDossiers(testChatId, 5);
		assert.ok(savedDossiers && savedDossiers.length > 0, "Dossiê deve ter sido salvo no banco");
		const latest = savedDossiers[0];
		assert.strictEqual(
			latest.problematic_score,
			4,
			"problematic_score no banco deve ter peso base 4"
		);
		assert.strictEqual(latest.is_underage, 1, "is_underage no banco deve ser 1");
		assert.strictEqual(latest.is_problematic, 0, "is_problematic deve ser 0 pois nota é 4 <= 7");
		const parsedJson = JSON.parse(latest.dossier_json);
		assert.strictEqual(parsedJson.is_underage, true, "is_underage no JSON deve ser true");
		assert.strictEqual(parsedJson.problematic_score, 4, "problematic_score no JSON deve ser 4");
		console.log("✓ Grupo adolescente comum registrado com peso base 4 e sem alerta indevido");

		// ==========================================
		// Teste 2: Grupo de adolescentes com agravantes graves (base 4 + outros pontos > 7)
		// DEVE enviar alerta para o grupo de dossiês
		// ==========================================
		console.log("2. Testando grupo de adolescentes com agravantes graves (deve enviar alerta)...");
		bot.resetCapture();

		const riskyChatId = "120363000000000010@g.us";
		await bot.database.saveGroup({
			id: riskyChatId,
			name: "Adolescentes e Confissões"
		});

		llmService.getCompletion = async () =>
			JSON.stringify({
				type: "nudes",
				summary: "Adolescentes trocando fotos íntimas e pedindo conteúdos inadequados.",
				is_underage: true,
				underage_indicators: ["Membro declarou ter 14 anos"],
				problematic_score: 8, // Base 4 + 4 de conteúdo sexual/nudes = 8 (> 7)
				classified_items: [
					{
						category: "Crianças/Adolescentes (até 16 anos)",
						evidence: "Lucas: tenho 14 anos"
					},
					{
						category: "Pornografia / Nudes",
						evidence: "Lucas: manda foto sem roupa no pv"
					}
				]
			});

		await SummaryCommands.runGroupAnalysis(
			riskyChatId,
			"Lucas: tenho 14 anos\nLucas: manda foto sem roupa no pv",
			bot
		);

		assert.strictEqual(
			bot.capturedMessages.length,
			1,
			"Grupo adolescente com nota 8 DEVE enviar alerta para o grupo de dossiês"
		);
		const alertMsg = bot.capturedMessages[0];
		assert.strictEqual(alertMsg.chatId, "dossie-target@g.us");
		assert.ok(alertMsg.content.includes("ALERTA DE GRUPO DE CRIANÇAS/ADOLESCENTES"));
		assert.ok(alertMsg.content.includes("Crianças/Adolescentes:* Detectado ⚠️"));
		assert.ok(alertMsg.content.includes("Nota:* 8/10"));

		const riskyDossiers = await bot.database.getLastGroupDossiers(riskyChatId, 5);
		assert.strictEqual(riskyDossiers[0].problematic_score, 8);
		assert.strictEqual(riskyDossiers[0].is_underage, 1);
		assert.strictEqual(riskyDossiers[0].is_problematic, 1);
		console.log("✓ Grupo adolescente com agravantes disparou alerta corretamente");

		// ==========================================
		// Teste 3: Grupo adulto/neutro (is_underage: false, nota baixa)
		// Não deve disparar alerta
		// ==========================================
		console.log("3. Testando grupo comum de adultos (sem alerta)...");
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

		// ==========================================
		// Teste 4: Pessoas adultas declarando idade (23 e 24 anos)
		// Simula alucinação da IA marcando Crianças/Adolescentes para 23/24 anos
		// O filtro deve interceptar, descartar a evidência e anular o is_underage
		// ==========================================
		console.log(
			"4. Testando grupo de adultos declarando idades 23 e 24 anos (não deve ser underage)..."
		);
		bot.resetCapture();

		const adultAgeChatId = "120363000000000003@g.us";
		await bot.database.saveGroup({
			id: adultAgeChatId,
			name: "Amigos da Faculdade"
		});

		llmService.getCompletion = async () =>
			JSON.stringify({
				type: "geral",
				summary: "Membros se apresentando e falando suas idades.",
				is_underage: true, // Alucinação da IA
				underage_indicators: ["Membros falaram a idade: 23 e 24 anos"],
				problematic_score: 4,
				classified_items: [
					{
						category: "Crianças/Adolescentes",
						evidence: "Rafaela Freire: Idade: 23 anos; Frann: Idade: 24"
					}
				]
			});

		await SummaryCommands.runGroupAnalysis(
			adultAgeChatId,
			"Rafaela Freire: Idade: 23 anos; Frann: Idade: 24",
			bot
		);

		assert.strictEqual(
			bot.capturedMessages.length,
			0,
			"Grupo de adultos (23 e 24 anos) JAMAIS deve disparar alerta de crianças/adolescentes"
		);

		const adultAgeDossiers = await bot.database.getLastGroupDossiers(adultAgeChatId, 5);
		assert.strictEqual(
			adultAgeDossiers[0].is_underage,
			0,
			"is_underage no banco deve ser 0 para adultos de 23 e 24 anos"
		);
		const adultAgeParsed = JSON.parse(adultAgeDossiers[0].dossier_json);
		assert.strictEqual(adultAgeParsed.is_underage, false);
		assert.strictEqual(adultAgeParsed.problematic_score, 0);
		assert.strictEqual(adultAgeParsed.classified_items.length, 0);
		console.log("✓ Falso positivo de 23/24 anos filtrado com sucesso sem disparar alerta");

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
