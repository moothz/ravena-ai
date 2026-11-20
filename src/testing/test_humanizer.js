"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const HumanizerHelper = require("../utils/HumanizerHelper");
const LLMService = require("../services/LLMService");

async function main() {
	console.log("=== INICIANDO TESTES DO HUMANIZER ===");

	// 1. Testes Unitários de Sanitização Heurística
	console.log("\n[1] Testando sanitização determinística (HumanizerHelper)...");

	// 1.1 Travessões convertidos para pontuação natural
	const textWithDashes = "O carro é rápido — e muito estável — em estradas sinuosas.";
	const sanitizedDashes = HumanizerHelper.sanitizeHumanizerResidue(textWithDashes);
	assert.ok(!sanitizedDashes.includes("—"), "Não deve conter travessão em-dash");
	assert.strictEqual(
		sanitizedDashes,
		"O carro é rápido, e muito estável, em estradas sinuosas.",
		"Deve converter travessões para vírgula"
	);
	console.log("  ✓ Travessões convertidos corretamente");

	// 1.2 Intervalo numérico com en-dash convertido para hífen padrão
	const textYears = "Período de 2015–2020 foi marcante.";
	const sanitizedYears = HumanizerHelper.sanitizeHumanizerResidue(textYears);
	assert.ok(
		sanitizedYears.includes("2015-2020"),
		"Deve converter en-dash entre números para hífen"
	);
	console.log("  ✓ Intervalo numérico preservado com hífen padrão");

	// 1.3 Aberturas e bajulações de chatbot removidas
	const textGreeting = "Com certeza! A capital da França é Paris.";
	const sanitizedGreeting = HumanizerHelper.sanitizeHumanizerResidue(textGreeting);
	assert.strictEqual(sanitizedGreeting, "A capital da França é Paris.");
	console.log("  ✓ Abertura bajuladora removida");

	const textHereIs = "Aqui está o que você pediu: O arquivo foi gerado.";
	const sanitizedHereIs = HumanizerHelper.sanitizeHumanizerResidue(textHereIs);
	assert.strictEqual(sanitizedHereIs, "O arquivo foi gerado.");
	console.log("  ✓ Preâmbulo 'Aqui está o que você pediu' removido");

	// 1.4 Fechamentos clichês de chatbot removidos
	const textClosing = "Basta reiniciar o modem. Espero ter ajudado!";
	const sanitizedClosing = HumanizerHelper.sanitizeHumanizerResidue(textClosing);
	assert.strictEqual(sanitizedClosing, "Basta reiniciar o modem.");
	console.log("  ✓ Fechamento 'Espero ter ajudado' removido");

	const textHelpClosing = "O comando correto é !ping. Qualquer dúvida, estou à disposição!";
	const sanitizedHelpClosing = HumanizerHelper.sanitizeHumanizerResidue(textHelpClosing);
	assert.strictEqual(sanitizedHelpClosing, "O comando correto é !ping.");
	console.log("  ✓ Fechamento 'Qualquer dúvida, estou à disposição' removido");

	// 1.5 Preservação de blocos de código markdown
	const textCode =
		"Aqui está a função:\n```javascript\nconst a = 1 — 2; // traço no código\n```\nPronto.";
	const sanitizedCode = HumanizerHelper.sanitizeHumanizerResidue(textCode);
	assert.ok(
		sanitizedCode.includes("const a = 1 — 2;"),
		"Código dentro de bloco markdown deve ser preservado"
	);
	console.log("  ✓ Blocos de código markdown preservados");

	// 1.6 Preservação de JSON válido
	const jsonInput = JSON.stringify({ classification: "general", command: "none" });
	const sanitizedJson = HumanizerHelper.sanitizeHumanizerResidue(jsonInput);
	assert.strictEqual(sanitizedJson, jsonInput, "JSON válido não deve ser modificado");
	console.log("  ✓ Estruturas JSON preservadas");

	// 2. Testes de Integração com LLMService
	console.log("\n[2] Testando integração com LLMService...");
	const llmService = LLMService.getInstance();

	let capturedOptions = null;
	const originalGetProviders = llmService.getCompletionFromProviders;
	llmService.getCompletionFromProviders = async (opts) => {
		capturedOptions = opts;
		return "Com certeza! Resposta simulada — com travessão. Espero ter ajudado!";
	};

	try {
		// 2.1 Chamada com humanize: true (padrão)
		capturedOptions = null;
		const resHumanized = await llmService.getCompletion({
			prompt: "Teste padrão",
			bypassQueue: true,
			humanize: true
		});

		assert.ok(capturedOptions, "Deve ter capturado opções");
		assert.ok(
			capturedOptions.systemContext.includes("DIRETRIZES DE ESTILO DE ESCRITA HUMANA"),
			"systemContext deve incluir diretrizes do Humanizer"
		);
		assert.ok(!resHumanized.includes("Com certeza!"), "Saída deve ter removido 'Com certeza!'");
		assert.ok(!resHumanized.includes("—"), "Saída deve ter removido travessão");
		assert.ok(
			!resHumanized.includes("Espero ter ajudado"),
			"Saída deve ter removido fechamento clichê"
		);
		console.log("  ✓ Injeção no systemContext e sanitização na saída validados");

		// 2.2 Chamada com response_format (JSON Schema não deve sofrer injeção de humanizer)
		capturedOptions = null;
		await llmService.getCompletion({
			prompt: "Classifique",
			bypassQueue: true,
			response_format: { type: "json_schema" },
			systemContext: "Contexto técnico"
		});
		assert.ok(
			!capturedOptions.systemContext.includes("DIRETRIZES DE ESTILO DE ESCRITA HUMANA"),
			"Chamadas com response_format NÃO devem receber injeção de estilo de prosa"
		);
		console.log("  ✓ response_format respeitado sem injeção de prosa");

		// 2.3 Chamada explícita com humanize: false
		capturedOptions = null;
		await llmService.getCompletion({
			prompt: "Teste desativado",
			bypassQueue: true,
			humanize: false,
			systemContext: "Contexto cru"
		});
		assert.ok(
			!capturedOptions.systemContext.includes("DIRETRIZES DE ESTILO DE ESCRITA HUMANA"),
			"Quando humanize: false, não deve injetar diretrizes"
		);
		console.log("  ✓ humanize: false desativa injeção corretamente");

		// 2.4 Teste do método humanizeText (Two-Pass)
		let twoPassPromptCaptured = null;
		llmService.getCompletionFromProviders = async (opts) => {
			twoPassPromptCaptured = opts.prompt;
			return "Texto reescrito de forma natural, sem vícios.";
		};

		const reescrita = await llmService.humanizeText("Texto corporativo cheio de buzzwords", {
			bypassQueue: true
		});
		assert.ok(
			twoPassPromptCaptured.includes("Reescreva o texto a seguir"),
			"Deve instruir a reescrita"
		);
		assert.strictEqual(reescrita, "Texto reescrito de forma natural, sem vícios.");
		console.log("  ✓ Método humanizeText (Two-Pass) executado com sucesso");
	} finally {
		llmService.getCompletionFromProviders = originalGetProviders;
	}

	console.log("\n=== TODOS OS TESTES DO HUMANIZER PASSARAM COM SUCESSO! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NOS TESTES:", err);
		process.exit(1);
	});
