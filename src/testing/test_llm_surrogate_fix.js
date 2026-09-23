const assert = require("assert");
const LLMService = require("../services/LLMService");

async function main() {
	console.log("=== Testando resiliência de LLMService contra surrogates isolados ===");
	const llm = LLMService.getInstance();

	// 1. Testa _sanitizeUtf8 diretamente
	console.log("\n[1] Testando _sanitizeUtf8...");
	const badString = "Texto com quebra \uD83C no meio e emoji válido 🍻 fim \uDFFF!";
	const cleaned = llm._sanitizeUtf8(badString);
	assert.strictEqual(cleaned.isWellFormed(), true, "Texto resultante deve ser well-formed");
	assert(cleaned.includes("🍻"), "Emoji válido deve ser preservado");
	assert.strictEqual(
		cleaned.includes("Texto com quebra  no meio"),
		true,
		"Surrogate isolado deve ter sido removido"
	);
	console.log("✓ _sanitizeUtf8 removeu surrogates isolados mantendo emojis válidos!");

	// 2. Testa _sanitizeUtf8 com objetos aninhados e arrays
	console.log("\n[2] Testando _sanitizeUtf8 recursivo...");
	const complexInput = {
		prompt: "Olá \uD83C",
		nested: [{ text: "Mundo \uD83D\uDCA8 e erro \uD800" }]
	};
	const sanitizedComplex = llm._sanitizeUtf8(complexInput);
	assert.strictEqual(sanitizedComplex.prompt.isWellFormed(), true);
	assert.strictEqual(sanitizedComplex.nested[0].text.isWellFormed(), true);
	assert(sanitizedComplex.nested[0].text.includes("💨"), "Emoji válido preservado");
	console.log("✓ _sanitizeUtf8 recursivo sanitizou objetos e arrays aninhados!");

	// 3. Testa truncateText
	console.log("\n[3] Testando truncateText não quebrando emojis em surrogates...");
	// 🍻 = \uD83C\uDF7B (índice 0 e 1)
	const emojiText = "A".repeat(199) + "🍻" + "B".repeat(50);
	const truncated = llm.truncateText(emojiText, 200, 100);
	assert.strictEqual(truncated.isWellFormed(), true, "Texto truncado deve ser well-formed");
	console.log("✓ truncateText manteve texto well-formed!");

	// 4. Teste de chamada real de getCompletion com prompt contendo surrogate isolado
	console.log("\n[4] Testando chamada real getCompletion com prompt contendo surrogate...");
	const promptComErro = "Responda apenas 'OK': frase com surrogate isolado \uD83C no final";
	const res = await llm.getCompletion({
		prompt: promptComErro,
		priority: 5,
		maxTokens: 50
	});
	console.log("Resposta recebida com sucesso:", res);
	assert(typeof res === "string" && res.length > 0, "Deve retornar resposta válida sem 400");
	console.log("✓ getCompletion executado com sucesso e sem erro 400!");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

main().catch((err) => {
	console.error("Falha no teste:", err);
	process.exit(1);
});
