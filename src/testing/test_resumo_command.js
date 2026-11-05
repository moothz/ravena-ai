/**
 * Testes Unitários e de Integração do comando !resumo
 * Valida a entrega da visão geral seguida dos tópicos detalhados
 */
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const MemoryService = require("../services/MemoryService");
const SummaryCommands = require("../functions/SummaryCommands");
const LLMService = require("../services/LLMService");

async function runTests() {
	console.log("==========================================================");
	console.log("📋 INICIANDO TESTES DO COMANDO !RESUMO");
	console.log("==========================================================\n");

	const memoryService = MemoryService.getInstance();
	const llmService = LLMService.getInstance();
	const testGroupId = "120363888888888@g.us";
	const bot = new FakeBot({ id: "test-bot" });
	const summarizeCmd = SummaryCommands.commands.find((c) => c.name === "resumo");

	assert(summarizeCmd, "Comando !resumo deve estar registrado em SummaryCommands");

	// 1. Teste de Formatação de Resumo + Tópicos (formatFullSummary)
	console.log("1. Testando formatFullSummary...");
	const baseSummary =
		"Discussão técnica sobre manutenção e modificação de carros, especificamente sobre substituição de parafusos e uso de espaçadores.";
	const sampleTopics = [
		{ topic: "Espaçadores", details: "pessoa tal recomenda o espaçador certo" },
		{ topic: "Parafuso", details: "Sugestão de lojas xxxx e yyyy para comprar" },
		{ topic: "Confusão", details: "pessoas não acham o parafuso correto" }
	];

	// Caso A: Sem tópicos (legado) -> Deve retornar apenas a frase
	const legacyFormatted = memoryService.formatFullSummary(baseSummary, null);
	assert.strictEqual(
		legacyFormatted,
		baseSummary,
		"Sem tópicos deve retornar apenas o resumo base"
	);

	// Caso B: Com array de objetos
	const fullFormatted = memoryService.formatFullSummary(baseSummary, sampleTopics);
	assert.ok(fullFormatted.includes(baseSummary), "Deve conter o resumo geral");
	assert.ok(
		fullFormatted.includes("- Espaçadores: pessoa tal recomenda o espaçador certo"),
		"Deve conter tópico Espaçadores"
	);
	assert.ok(
		fullFormatted.includes("- Parafuso: Sugestão de lojas xxxx e yyyy para comprar"),
		"Deve conter tópico Parafuso"
	);
	assert.ok(
		fullFormatted.includes("- Confusão: pessoas não acham o parafuso correto"),
		"Deve conter tópico Confusão"
	);

	// Caso C: Com string JSON
	const jsonFormatted = memoryService.formatFullSummary(baseSummary, JSON.stringify(sampleTopics));
	assert.strictEqual(
		jsonFormatted,
		fullFormatted,
		"JSON string deve produzir mesmo resultado que array"
	);
	console.log("✓ formatFullSummary validado com sucesso!");

	// 2. Teste de Rolling Summary quente com tópicos
	console.log("\n2. Testando getRollingSummary com topic_breakdown no banco...");
	const prevTestMode = memoryService.database.testMode;
	memoryService.database.testMode = false;
	try {
		await memoryService.database.dbRun(
			"memory",
			`INSERT OR REPLACE INTO memory_group_profiles 
			 (group_id, platform, title, vibe_summary, latest_summary, topic_breakdown, last_summarized_at, messages_since_summary, total_messages_analyzed, average_problematic_score, updated_at)
			 VALUES (?, 'whatsapp', 'Grupo dos Carros', 'técnico', ?, ?, ?, 1, 10, 0, ?)`,
			[testGroupId, baseSummary, JSON.stringify(sampleTopics), Date.now(), Date.now()]
		);
	} finally {
		memoryService.database.testMode = prevTestMode;
	}

	const rollingSummary = await memoryService.getRollingSummary(testGroupId, bot);
	assert.ok(rollingSummary.includes(baseSummary), "Rolling summary deve conter a frase geral");
	assert.ok(rollingSummary.includes("- Espaçadores:"), "Rolling summary deve listar os tópicos");
	console.log("✓ getRollingSummary entregou resumo com visão geral e tópicos!");

	// 3. Teste de Execução do Comando summarizeConversation via FakeBot
	console.log("\n3. Testando summarizeConversation com cache quente...");
	const fakeMsg = createMessage({
		content: "!resumo",
		group: testGroupId,
		author: "5511999990001@s.whatsapp.net"
	});

	const returnMsg = await summarizeCmd.method(bot, fakeMsg, [], { id: testGroupId });
	assert.ok(returnMsg, "Deve retornar ReturnMessage");
	assert.strictEqual(returnMsg.chatId, testGroupId, "Deve responder no grupo");
	assert.ok(
		returnMsg.content.includes("📋 *Resumo da conversa:*"),
		"Deve conter o cabeçalho padrão"
	);
	assert.ok(returnMsg.content.includes(baseSummary), "Deve conter a visão geral");
	assert.ok(
		returnMsg.content.includes("- Espaçadores: pessoa tal recomenda o espaçador certo"),
		"Deve conter bullet do tópico 1"
	);
	assert.ok(
		returnMsg.content.includes("- Parafuso: Sugestão de lojas xxxx e yyyy para comprar"),
		"Deve conter bullet do tópico 2"
	);
	assert.ok(
		returnMsg.content.includes("- Confusão: pessoas não acham o parafuso correto"),
		"Deve conter bullet do tópico 3"
	);
	console.log("✓ summarizeConversation entregou resumo quente formatado perfeitamente!");

	// 4. Teste de Execução sob Demanda (Simulação de LLM com tópicos)
	console.log("\n4. Testando summarizeConversation sob demanda via LLM...");
	const freshGroupId = "120363777777777@g.us";
	memoryService.database.testMode = false;
	try {
		// Salva mensagens recentes em chat_conversations
		await SummaryCommands.storeMessage(
			createMessage({
				content: "Alguém sabe onde comprar parafuso M8?",
				group: freshGroupId,
				authorName: "Carlos"
			}),
			freshGroupId,
			bot
		);
		await SummaryCommands.storeMessage(
			createMessage({
				content: "Recomendo a Loja X ou Loja Y",
				group: freshGroupId,
				authorName: "Beto"
			}),
			freshGroupId,
			bot
		);
		await SummaryCommands.storeMessage(
			createMessage({
				content: "Eu coloquei espaçador de 15mm e ficou ótimo",
				group: freshGroupId,
				authorName: "Lucas"
			}),
			freshGroupId,
			bot
		);

		// Mock do getCompletion para validar o parser e o fluxo do prompt
		const originalGetCompletion = llmService.getCompletion.bind(llmService);
		llmService.getCompletion = async (options) => {
			assert.ok(
				options.prompt.includes("Uma frase inicial concisa resumindo o panorama geral"),
				"Prompt deve instruir formato novo"
			);
			assert.ok(
				options.prompt.includes("Liste todos os temas específicos discutidos em tópicos"),
				"Prompt deve pedir tópicos"
			);
			return `Discussão técnica sobre manutenção e modificação de carros, especificamente sobre substituição de parafusos e uso de espaçadores.

- Espaçadores: Lucas colocou espaçador de 15mm com sucesso
- Parafuso: Beto recomendou Loja X e Loja Y para compra de parafusos M8`;
		};

		try {
			const freshMsg = createMessage({
				content: "!resumo",
				group: freshGroupId,
				author: "5511999990001@s.whatsapp.net"
			});

			const onDemandReturn = await summarizeCmd.method(bot, freshMsg, [], { id: freshGroupId });
			assert.ok(onDemandReturn.content.includes("📋 *Resumo da conversa:*"), "Deve ter cabeçalho");
			assert.ok(
				onDemandReturn.content.includes("Discussão técnica sobre manutenção"),
				"Deve ter visão geral"
			);
			assert.ok(
				onDemandReturn.content.includes("- Espaçadores:"),
				"Deve ter bullet de espaçadores"
			);
			assert.ok(onDemandReturn.content.includes("- Parafuso:"), "Deve ter bullet de parafusos");
			console.log(
				"✓ summarizeConversation sob demanda funcionou e formatou a resposta corretamente!"
			);
		} finally {
			llmService.getCompletion = originalGetCompletion;
		}
	} finally {
		memoryService.database.testMode = prevTestMode;
	}

	console.log("\n==========================================================");
	console.log("🎉 TODOS OS TESTES DO COMANDO !RESUMO PASSARAM!");
	console.log("==========================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro nos testes de !resumo:", err);
		process.exit(1);
	});
