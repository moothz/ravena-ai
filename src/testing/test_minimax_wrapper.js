const assert = require("assert");
const LLMService = require("../services/LLMService");

async function runTests() {
	console.log("=== Testando Wrapper e Extrator MiniMax XML no LLMService ===");
	const llm = LLMService.getInstance();

	// Caso 1: Saída real do MiniMax-M3 relatada pelo usuário (2 web_search invokes)
	const rawMinimax1 = `]<]minimax[>[<tool_call>
]<]minimax[>[<invoke name="web_search">]<]minimax[>[<query>UTIL ônibus Juiz de Fora Galeão horários saída 2025]<]minimax[>[</query>]<]minimax[>[</invoke>
]<]minimax[>[<invoke name="web_search">]<]minimax[>[<query>ônibus Juiz de Fora aeroporto Confiança Nazareno horários]<]minimax[>[</query>]<]minimax[>[</invoke>
]<]minimax[>[</tool_call>`;

	const toolCalls1 = llm._extractXmlToolCalls(rawMinimax1);
	assert(Array.isArray(toolCalls1), "Deve retornar um array de tool_calls");
	assert.strictEqual(toolCalls1.length, 2, "Deve extrair exatamente 2 tool calls");
	assert.strictEqual(toolCalls1[0].function.name, "web_search");
	assert.deepStrictEqual(JSON.parse(toolCalls1[0].function.arguments), {
		query: "UTIL ônibus Juiz de Fora Galeão horários saída 2025"
	});
	assert.strictEqual(toolCalls1[1].function.name, "web_search");
	assert.deepStrictEqual(JSON.parse(toolCalls1[1].function.arguments), {
		query: "ônibus Juiz de Fora aeroporto Confiança Nazareno horários"
	});
	console.log("✅ Caso 1 aprovado: 2 chamadas de web_search extraídas com sucesso!");

	// Caso 2: MiniMax commands_helper
	const rawMinimax2 = `]<]minimax[>[<tool_call>
]<]minimax[>[<invoke name="commands_helper">]<]minimax[>[<query>frase pensamento motivação]<]minimax[>[</query>]<]minimax[>[</invoke>
]<]minimax[>[</tool_call>`;

	const toolCalls2 = llm._extractXmlToolCalls(rawMinimax2);
	assert(toolCalls2 && toolCalls2.length === 1);
	assert.strictEqual(toolCalls2[0].function.name, "commands_helper");
	assert.deepStrictEqual(JSON.parse(toolCalls2[0].function.arguments), {
		query: "frase pensamento motivação"
	});
	console.log("✅ Caso 2 aprovado: commands_helper extraído com sucesso!");

	// Caso 3: MiniMax invoke com alias get / web_fetch
	const rawMinimax3 = `]<]minimax[>[<tool_call>
]<]minimax[>[<invoke name="get">]<]minimax[>[<url>https://moovitapp.com/index/pt-br/linha-138]<]minimax[>[</url>
]<]minimax[>[</tool_call>`;

	const toolCalls3 = llm._extractXmlToolCalls(rawMinimax3);
	assert(toolCalls3 && toolCalls3.length === 1);
	assert.strictEqual(
		toolCalls3[0].function.name,
		"fetch_web_content",
		"Deve normalizar alias 'get' para 'fetch_web_content'"
	);
	assert.deepStrictEqual(JSON.parse(toolCalls3[0].function.arguments), {
		url: "https://moovitapp.com/index/pt-br/linha-138"
	});
	console.log("✅ Caso 3 aprovado: alias 'get' normalizado para 'fetch_web_content'!");

	// Caso 4: XML com <parameter name="...">
	const rawMinimax4 = `<tool_call>
<invoke name="google_search">
<parameter name="query">previsão do tempo rio</parameter>
</invoke>
</tool_call>`;

	const toolCalls4 = llm._extractXmlToolCalls(rawMinimax4);
	assert(toolCalls4 && toolCalls4.length === 1);
	assert.strictEqual(
		toolCalls4[0].function.name,
		"web_search",
		"Deve normalizar alias 'google_search' para 'web_search'"
	);
	assert.deepStrictEqual(JSON.parse(toolCalls4[0].function.arguments), {
		query: "previsão do tempo rio"
	});
	console.log("✅ Caso 4 aprovado: <parameter> e alias 'google_search' normalizado!");

	// Caso 5: Resposta normal sem XML (outros modelos ou MiniMax sem tools)
	const normalText =
		"Olá! Os horários de ônibus de Juiz de Fora para o Galeão são 06:00, 10:00 e 15:30.";
	const toolCalls5 = llm._extractXmlToolCalls(normalText);
	assert.strictEqual(toolCalls5, null, "Não deve extrair tool_calls de texto normal");
	console.log("✅ Caso 5 aprovado: Texto normal 100% preservado (retorna null)!");

	// Caso 6: Testando _cleanResponse
	const dirtyResponse = `]<]minimax[>[<tool_call>
]<]minimax[>[<invoke name="web_search">]<]minimax[>[<query>teste]<]minimax[>[</query>]<]minimax[>[</invoke>
]<]minimax[>[</tool_call>
Aqui está a sua resposta completa e limpa!`;

	const cleaned = llm._cleanResponse(dirtyResponse);
	assert(!cleaned.includes("minimax"), "Não deve conter 'minimax'");
	assert(!cleaned.includes("<tool_call>"), "Não deve conter '<tool_call>'");
	assert.strictEqual(cleaned, "Aqui está a sua resposta completa e limpa!");
	console.log("✅ Caso 6 aprovado: _cleanResponse removeu completamente os artefatos do MiniMax!");

	console.log("\n🎉 Todos os testes unitários do wrapper MiniMax passaram com sucesso!");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
