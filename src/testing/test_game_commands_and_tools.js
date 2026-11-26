process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.TWITCH_CLIENT_ID = "fake-client-id";
process.env.TWITCH_CLIENT_SECRET = "fake-client-secret";
process.env.TZ = "America/Sao_Paulo";
delete process.env.DEEPL_API_KEY;

const assert = require("assert");
const axios = require("axios");
const Queue = require("../services/Queue");
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

	await testRealSearch(bot, groupId, user);
	await testToolDoesNotBlockLlmQueue();

	console.log("\n=== Todos os testes de GameCommands e Tools passaram com sucesso! ===");
}

const http = { twitch: [], igdb: [] };

function httpError(status) {
	const err = new Error(`Request failed with status code ${status}`);
	err.response = { status };
	return err;
}

function stubHttp({ twitch, igdb }) {
	http.twitch = [];
	http.igdb = [];
	axios.get = async () => {
		throw new Error("rede desligada no teste");
	};
	axios.post = async (url, body, config) => {
		if (url.includes("id.twitch.tv")) {
			http.twitch.push(config?.params);
			return twitch(http.twitch.length);
		}
		if (url.includes("api.igdb.com")) {
			http.igdb.push({ body, auth: config?.headers?.Authorization });
			return igdb(http.igdb.length, body);
		}
		throw new Error(`URL inesperada no teste: ${url}`);
	};
}

const tokenOk = (n) => ({ data: { access_token: `fake-token-${n}`, expires_in: 3600 } });
const syntheticGame = (n) => ({
	name: `Synthetic Quest ${n}`,
	first_release_date: 946684800,
	summary: "A synthetic hero walks through a synthetic world."
});

async function testRealSearch(bot, groupId, user) {
	const originalPost = axios.post;
	const originalGet = axios.get;
	try {
		console.log("\n[6] Token recusado pela Twitch vira erro, não 'não encontrei'...");
		stubHttp({
			twitch: () => {
				throw httpError(403);
			},
			igdb: () => ({ data: [syntheticGame(1)] })
		});
		await assert.rejects(GameCommands.searchIgdbGames("Synthetic Quest", 2), (err) => {
			assert.strictEqual(err.code, GameCommands.IGDB_AUTH_ERROR);
			return true;
		});
		const cmdRes = await GameCommands.buscarJogos(
			bot,
			createMessage({ content: "!jogos Synthetic Quest", group: groupId, author: user }),
			["Synthetic", "Quest"]
		);
		assert.ok(!cmdRes.content.includes("Não encontrei"), `Comando: ${cmdRes.content}`);
		const toolRes = await GameCommands.fetchGameInfo("Synthetic Quest");
		assert.ok(!toolRes.includes("Não encontrei"), `Tool: ${toolRes}`);
		assert.strictEqual(http.igdb.length, 0, "Sem token não consulta o IGDB");
		console.log("✓ 403 no token: erro de autenticação no comando e na tool.");

		console.log("\n[7] 401 do IGDB invalida o token e tenta de novo uma vez...");
		stubHttp({
			twitch: tokenOk,
			igdb: (n) => {
				if (n === 1) throw httpError(401);
				return { data: [syntheticGame(1)] };
			}
		});
		const renewed = await GameCommands.searchIgdbGames("Synthetic Quest", 2);
		assert.strictEqual(renewed.length, 1);
		assert.strictEqual(http.twitch.length, 2, "Token renovado após o 401");
		assert.deepStrictEqual(
			http.igdb.map((c) => c.auth),
			["Bearer fake-token-1", "Bearer fake-token-2"]
		);
		console.log("✓ 401: token renovado e consulta repetida com o novo token.");

		console.log("\n[8] 401 persistente: uma única nova tentativa e erro de autenticação...");
		stubHttp({
			twitch: tokenOk,
			igdb: () => {
				throw httpError(401);
			}
		});
		await assert.rejects(GameCommands.searchIgdbGames("Synthetic Quest", 2), (err) => {
			assert.strictEqual(err.code, GameCommands.IGDB_AUTH_ERROR);
			return true;
		});
		assert.strictEqual(http.igdb.length, 2, "Só uma nova tentativa");
		stubHttp({ twitch: tokenOk, igdb: () => ({ data: [] }) });
		await GameCommands.searchIgdbGames("Synthetic Quest", 2);
		assert.strictEqual(http.twitch.length, 1, "Token recusado não fica em cache");
		console.log("✓ 401 persistente: 2 consultas, erro de autenticação e cache limpo.");

		console.log("\n[9] Nome do usuário não injeta comandos na consulta e limit é respeitado...");
		stubHttp({
			twitch: tokenOk,
			igdb: () => ({ data: Array.from({ length: 40 }, (_, i) => syntheticGame(i)) })
		});
		const injected = await GameCommands.searchIgdbGames(
			'x\\"; limit 500; where id > 0; search \\"y',
			2
		);
		assert.strictEqual(injected.length, 2, "Resultado cortado por limit");
		await GameCommands.searchIgdbGames("Synthetic Quest\\", 2);
		await GameCommands.searchIgdbGames(`linha1\nlinha2 ${"a".repeat(300)}`, 2);
		for (const { body } of http.igdb) {
			const match = body.match(/^search "([^"]*)"; fields [^";\\\n]+; limit 2;$/);
			assert.ok(match, `Consulta malformada: ${body}`);
			assert.ok(match[1].length <= 80, `Nome sem limite de tamanho: ${match[1].length}`);
		}
		const toolText = await GameCommands.fetchGameInfo("Synthetic Quest");
		assert.strictEqual(toolText.split("---").length, 2, "Tool com no máximo 2 jogos");
		console.log("✓ Barra invertida, aspas, ; e quebras removidas; nome e lista limitados.");

		console.log("\n[10] Ano em UTC e sinopse limitada no texto da tool...");
		stubHttp({
			twitch: tokenOk,
			igdb: () => ({ data: [{ ...syntheticGame(1), summary: "b".repeat(5000) }] })
		});
		const yearText = await GameCommands.fetchGameInfo("Synthetic Quest");
		assert.ok(yearText.includes("Synthetic Quest 1** (2000)"), yearText.slice(0, 80));
		assert.ok(yearText.length < 1500, `Sinopse sem limite: ${yearText.length}`);
		console.log("✓ 01/01/2000 UTC sai como 2000 e a sinopse vem cortada.");
	} finally {
		axios.post = originalPost;
		axios.get = originalGet;
	}
}

async function testToolDoesNotBlockLlmQueue() {
	console.log("\n[11] search_game em 2 perguntas simultâneas não trava a fila do LLM...");
	const llm = LLMService.getInstance();
	const saved = {
		queue: llm.queue,
		providerDefinitions: llm.providerDefinitions,
		providerQueue: llm.providerQueue,
		track: llm._trackUsage
	};
	const originalPost = axios.post;
	const originalGet = axios.get;
	let translations = 0;
	stubHttp({ twitch: tokenOk, igdb: () => ({ data: [syntheticGame(1), syntheticGame(2)] }) });
	const httpPost = axios.post;
	axios.post = async (url, payload, config) => {
		if (url.includes("id.twitch.tv") || url.includes("api.igdb.com")) {
			return httpPost(url, payload, config);
		}
		await new Promise((r) => setTimeout(r, 100));
		const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
		const hasToolResult = (payload.messages || []).some((m) => m.role === "tool");
		let message;
		if (hasToolResult) {
			message = { role: "assistant", content: "RESPOSTA FINAL" };
		} else if (hasTools) {
			const call = {
				id: "call_1",
				type: "function",
				function: { name: "search_game", arguments: '{"name":"Synthetic Quest"}' }
			};
			message = { role: "assistant", content: "", tool_calls: [call] };
		} else {
			translations++;
			message = { role: "assistant", content: "Sinopse traduzida." };
		}
		return { data: { choices: [{ message }] } };
	};
	llm._trackUsage = async () => {};
	llm.queue = new Queue({ concurrency: 2, taskTimeout: 3000 });
	llm.providerDefinitions = [
		{
			name: "mock",
			toolCalling: true,
			method: async (o) => {
				const r = await llm.openaiCompletion({ ...o, apiKey: "dummy" });
				return r?.choices?.[0]?.message?.content;
			}
		}
	];
	llm.providerQueue = [...llm.providerDefinitions];
	try {
		const results = await Promise.all(
			[0, 1].map((i) =>
				llm.getCompletion({ prompt: `pergunta ${i}`, toolCalling: true, priority: 1 })
			)
		);
		assert.deepStrictEqual(results, ["RESPOSTA FINAL", "RESPOSTA FINAL"]);
		assert.strictEqual(translations, 0, "A tool não pede tradução ao LLM");
		console.log("✓ As 2 perguntas responderam com o texto do modelo.");
	} finally {
		axios.post = originalPost;
		axios.get = originalGet;
		Object.assign(llm, {
			queue: saved.queue,
			providerDefinitions: saved.providerDefinitions,
			providerQueue: saved.providerQueue,
			_trackUsage: saved.track
		});
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHA NO TESTE:", err);
		process.exit(1);
	});
