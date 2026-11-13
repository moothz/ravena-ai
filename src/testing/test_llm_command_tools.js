// src/testing/test_llm_command_tools.js
// Ferramentas do LLMService:
// - get_group_ranking_stats usa o chat da requisição e ignora args.chatId do modelo

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const LLMService = require("../services/LLMService");

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
	console.log("=== Testes das tools do LLMService ===");
	const llm = LLMService.getInstance();

	await testRankingUsesRequestChat(llm);

	console.log("\n=== Todos os testes das tools do LLMService passaram! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes das tools do LLMService:", err);
		process.exit(1);
	});
