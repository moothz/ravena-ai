// src/testing/test_llm_command_tools.js
// Ferramentas de comandos expostas ao LLM e laço de tool calling:
// - getTools() anuncia só get_command_info + uma ferramenta de busca (aliases seguem no dispatcher)
// - o último turno permitido é chamado sem tools, garantindo resposta em texto
// - get_group_ranking_stats usa o chat da requisição e ignora args.chatId do modelo

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const axios = require("axios");
const LLMService = require("../services/LLMService");

const FINAL_TEXT = "Resposta final em texto";

function testToolList(llm) {
	console.log("\n[1] getTools() sem ferramentas de comandos sobrepostas...");
	const names = llm.getTools().map((t) => t.function?.name);
	assert.ok(names.includes("get_command_info"), "get_command_info deve ser anunciada");
	assert.ok(names.includes("commands_helper"), "commands_helper (busca) deve ser anunciada");
	for (const legacy of ["list_commands", "search_commands"]) {
		assert.ok(!names.includes(legacy), `${legacy} não deve mais ser anunciada`);
	}
	const commandTools = names.filter((n) => /command/.test(n) && n !== "execute_bot_command");
	assert.deepStrictEqual(
		commandTools.sort(),
		["commands_helper", "get_command_info"],
		"Apenas 2 ferramentas de consulta de comandos"
	);
	assert.ok(names.includes("execute_bot_command"), "Demais tools (ex: !ai) continuam presentes");
	assert.ok(names.includes("web_search"), "web_search continua presente");
	assert.strictEqual(new Set(names).size, names.length, "Sem tools duplicadas");
	console.log(`✓ ${names.length} tools, sem list_commands/search_commands.`);
}

async function testLegacyAliases(llm) {
	console.log("\n[2] Aliases legados continuam funcionando no dispatcher...");
	for (const alias of ["list_commands", "search_commands", "commands_helper"]) {
		const out = await llm.executeToolCall(alias, { command: "pescar" });
		assert.ok(out.includes("!pescar"), `${alias} deve responder (saída: ${out.slice(0, 80)})`);
	}
	const byQuery = await llm.executeToolCall("commands_helper", { query: "pesca" });
	assert.ok(byQuery.includes("FishingGame.js"), "Busca por palavra-chave via commands_helper");
	console.log("✓ list_commands, search_commands e commands_helper atendidos.");
}

/**
 * Simula um modelo que sempre pede outra ferramenta enquanto `tools` for enviado
 * @param {"openai"|"ollama"} format
 * @param {Array<Object>} payloads - Coletor dos payloads enviados
 */
function mockAlwaysToolCalling(format, payloads) {
	let n = 0;
	return async (url, payload) => {
		payloads.push(JSON.parse(JSON.stringify(payload)));
		n++;
		const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
		const toolCall = {
			id: `call_${n}`,
			type: "function",
			function: { name: "get_current_time", arguments: format === "ollama" ? {} : "{}" }
		};
		const message = hasTools
			? { role: "assistant", content: "", tool_calls: [toolCall] }
			: { role: "assistant", content: FINAL_TEXT };
		return format === "ollama" ? { data: { message } } : { data: { choices: [{ message }] } };
	};
}

async function testFinalTurnWithoutTools(llm) {
	console.log("\n[3] Último turno de tool calling vai sem tools (resposta em texto garantida)...");
	const originalPost = axios.post;
	const originalTrack = llm._trackUsage;
	llm._trackUsage = async () => {};

	const runners = {
		openai: () =>
			llm.openaiCompletion({ prompt: "que horas são?", apiKey: "dummy", toolCalling: true }),
		openrouter: () =>
			llm.openrouterCompletion({ prompt: "que horas são?", apiKey: "dummy", toolCalling: true }),
		ollama: () => llm.ollamaCompletion({ prompt: "que horas são?", toolCalling: true })
	};

	try {
		for (const [provider, run] of Object.entries(runners)) {
			const payloads = [];
			axios.post = mockAlwaysToolCalling(provider === "ollama" ? "ollama" : "openai", payloads);
			const data = await run();

			// 1 chamada inicial + 4 turnos de tools
			assert.strictEqual(payloads.length, 5, `${provider}: 5 chamadas esperadas`);
			for (let i = 0; i < 4; i++) {
				assert.ok(
					Array.isArray(payloads[i].tools) && payloads[i].tools.length > 0,
					`${provider}: chamada ${i + 1} deve enviar tools`
				);
			}
			assert.strictEqual(
				payloads[4].tools,
				undefined,
				`${provider}: a chamada final não pode enviar tools`
			);
			const finalContent =
				provider === "ollama" ? data?.message?.content : data?.choices?.[0]?.message?.content;
			assert.strictEqual(finalContent, FINAL_TEXT, `${provider}: resposta final deve ser texto`);
			console.log(`✓ ${provider}: tools nos turnos 1-4 e chamada final sem tools.`);
		}

		// Tools customizadas (options.tools) também são omitidas no turno final
		const payloads = [];
		axios.post = mockAlwaysToolCalling("openai", payloads);
		const customTools = [llm.getTools().find((t) => t.function.name === "get_current_time")];
		await llm.openaiCompletion({
			prompt: "hora?",
			apiKey: "dummy",
			toolCalling: true,
			tools: customTools
		});
		assert.deepStrictEqual(
			payloads[1].tools.map((t) => t.function.name),
			["get_current_time"],
			"Turnos intermediários respeitam options.tools"
		);
		assert.strictEqual(payloads[4].tools, undefined, "Turno final sem options.tools");
		console.log("✓ options.tools respeitado nos turnos intermediários e omitido no final.");
	} finally {
		axios.post = originalPost;
		llm._trackUsage = originalTrack;
	}
}

async function testRankingUsesRequestChat(llm) {
	console.log("\n[4] get_group_ranking_stats ignora args.chatId do modelo...");
	const calls = [];
	llm.getGroupRankingStats = async (chatId) => {
		calls.push(chatId);
		return "ranking";
	};
	try {
		await llm.executeToolCall(
			"get_group_ranking_stats",
			{ chatId: "120363000000000001@g.us" },
			{ chatId: "120363000000000002@g.us" }
		);
		await llm.executeToolCall(
			"get_group_ranking_stats",
			{ chatId: "120363000000000001@g.us" },
			{ group: { id: "120363000000000003@g.us" } }
		);
		await llm.executeToolCall("get_group_ranking_stats", { chatId: "120363000000000001@g.us" }, {});
	} finally {
		delete llm.getGroupRankingStats;
	}
	assert.deepStrictEqual(
		calls,
		["120363000000000002@g.us", "120363000000000003@g.us", undefined],
		"O chat consultado deve vir apenas das opções da requisição"
	);
	console.log("✓ Ranking sempre do chat da requisição (args.chatId ignorado).");
}

async function runTests() {
	console.log("=== Testes das tools de comandos e do laço de tool calling do LLMService ===");
	const llm = LLMService.getInstance();

	testToolList(llm);
	await testLegacyAliases(llm);
	await testFinalTurnWithoutTools(llm);
	await testRankingUsesRequestChat(llm);

	console.log("\n=== Todos os testes das tools do LLMService passaram! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes das tools do LLMService:", err);
		process.exit(1);
	});
