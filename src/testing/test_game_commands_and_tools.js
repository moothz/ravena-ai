process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const GameCommands = require("../functions/GameCommands");
const ImdbCommands = require("../functions/ImdbCommands");
const AnimeCommands = require("../functions/AnimeCommands");
const LLMService = require("../services/LLMService");

async function runTests() {
	console.log("=== Teste de GameCommands (!jogos / IGDB) e Tool do LLMService ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const groupId = "12036304@g.us";
	const user = "5511999990001";

	// ─── 1. Formatação de card e busca de jogos ──────────────────────────────
	console.log("\n[1] Testando formatGameCard com dados sintéticos...");
	const fakeGame = {
		id: 1234,
		name: "Chrono Trigger Remaster",
		first_release_date: 794966400, // 1995
		platforms: [
			{ id: 1, name: "Super Nintendo" },
			{ id: 2, name: "PlayStation" }
		],
		genres: [
			{ id: 1, name: "Role-playing (RPG)" },
			{ id: 2, name: "Adventure" }
		],
		involved_companies: [
			{ company: { name: "Square" }, developer: true },
			{ company: { name: "Nintendo" }, developer: false }
		],
		total_rating: 95.8,
		total_rating_count: 1200,
		summary: "A young hero travels through time to save the world from an ancient evil.",
		url: "https://www.igdb.com/games/chrono-trigger",
		cover: {
			image_id: "co123",
			url: "//images.igdb.com/igdb/image/upload/t_thumb/co123.jpg"
		}
	};

	const formatted = await GameCommands.formatGameCard(fakeGame);
	assert.ok(
		formatted.texto.includes("*Chrono Trigger Remaster* (1995)"),
		"Deve incluir título e ano"
	);
	assert.ok(formatted.texto.includes("Super Nintendo, PlayStation"), "Deve listar plataformas");
	assert.ok(formatted.texto.includes("Role-playing (RPG), Adventure"), "Deve listar gêneros");
	assert.ok(formatted.texto.includes("Square"), "Deve listar desenvolvedora");
	assert.ok(formatted.texto.includes("96/100"), "Deve arredondar e exibir nota");
	assert.ok(formatted.coverUrl.includes("t_cover_big/co123.jpg"), "Deve gerar URL grande de capa");
	console.log("✓ formatGameCard formatou dados do jogo com sucesso.");

	// ─── 2. Comando !jogos (buscarJogos) ────────────────────────────────────
	console.log("\n[2] Testando comando !jogos...");

	// 2.1 Sem argumentos: pede nome do jogo
	const msgVazia = createMessage({ content: "!jogos", group: groupId, author: user });
	const resVazia = await GameCommands.buscarJogos(bot, msgVazia, []);
	assert.ok(resVazia.content.includes("Me passa o nome de um jogo"), "Deve pedir nome");
	console.log("✓ !jogos sem argumentos pede o nome do jogo.");

	// 2.2 Mock de busca com resultado
	const originalSearch = GameCommands.searchIgdbGames;
	GameCommands.searchIgdbGames = async (query) => {
		if (query === "inexistente") return [];
		return [fakeGame];
	};

	try {
		// Jogo não encontrado
		const msgInexistente = createMessage({
			content: "!jogos inexistente",
			group: groupId,
			author: user
		});
		const resInexistente = await GameCommands.buscarJogos(bot, msgInexistente, ["inexistente"]);
		assert.ok(
			resInexistente.content.includes("Não encontrei nenhum jogo"),
			"Deve avisar que não achou"
		);
		console.log("✓ Jogo inexistente retorna mensagem amigável.");

		// Jogo encontrado
		const msgBusca = createMessage({
			content: "!jogos chrono",
			group: groupId,
			author: user
		});
		const resBusca = await GameCommands.buscarJogos(bot, msgBusca, ["chrono"]);
		const textoEnviado = resBusca.options?.caption || resBusca.content;
		assert.ok(
			textoEnviado.includes("Chrono Trigger Remaster"),
			`Deveria conter título no retorno: ${textoEnviado}`
		);
		console.log("✓ !jogos chrono retornou o card do jogo.");
	} finally {
		GameCommands.searchIgdbGames = originalSearch;
	}

	// ─── 3. fetchGameInfo para integração com tools ─────────────────────────
	console.log("\n[3] Testando fetchGameInfo...");
	GameCommands.searchIgdbGames = async () => [fakeGame];
	try {
		const infoText = await GameCommands.fetchGameInfo("Chrono Trigger");
		assert.ok(
			infoText.includes("Chrono Trigger Remaster") && infoText.includes("1995"),
			"fetchGameInfo retorna título e ano"
		);
		assert.ok(infoText.includes("Super Nintendo"), "fetchGameInfo inclui plataformas");
		assert.ok(infoText.includes("Avaliação IGDB: 96/100"), "fetchGameInfo inclui nota");
		console.log("✓ fetchGameInfo retornou dados estruturados para LLM/tools.");
	} finally {
		GameCommands.searchIgdbGames = originalSearch;
	}

	// ─── 4. Integração de tool no LLMService ────────────────────────────────
	console.log("\n[4] Testando tool search_game no LLMService...");
	const llm = new LLMService();
	const tools = llm.getTools();
	const gameTool = tools.find((t) => t.function?.name === "search_game");
	assert.ok(gameTool, "search_game deve estar presente em getTools()");
	assert.ok(
		gameTool.function?.parameters?.required?.includes("name"),
		"Parâmetro 'name' obrigatório"
	);

	// Execução via dispatcher executeToolCall
	GameCommands.searchIgdbGames = async () => [fakeGame];
	try {
		const toolRes1 = await llm.executeToolCall("search_game", { name: "Chrono Trigger" });
		assert.ok(
			toolRes1.includes("Chrono Trigger Remaster"),
			"executeToolCall(search_game) retornou o jogo"
		);

		const toolResAlias = await llm.executeToolCall("search_igdb", { query: "Chrono Trigger" });
		assert.ok(
			toolResAlias.includes("Chrono Trigger Remaster"),
			"executeToolCall(search_igdb) funciona via alias"
		);
		console.log("✓ search_game e search_igdb executados pelo LLMService.");
	} finally {
		GameCommands.searchIgdbGames = originalSearch;
	}

	// ─── 5. Verificação rápida de ImdbCommands e AnimeCommands ───────────────
	console.log("\n[5] Verificando exportações de ImdbCommands e AnimeCommands...");
	assert.strictEqual(typeof ImdbCommands.fetchImdbInfo, "function");
	assert.strictEqual(typeof AnimeCommands.fetchAnimeInfo, "function");
	const imdbTool = tools.find((t) => t.function?.name === "search_imdb");
	const animeTool = tools.find((t) => t.function?.name === "search_anime");
	assert.ok(imdbTool, "search_imdb presente em getTools()");
	assert.ok(animeTool, "search_anime presente em getTools()");
	console.log("✓ ImdbCommands e AnimeCommands possuem tools integradas.");

	console.log("\n=== Todos os testes de GameCommands e Tools passaram com sucesso! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHA NO TESTE:", err);
		process.exit(1);
	});
