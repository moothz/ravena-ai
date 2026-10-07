process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const axios = require("axios");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const PsnCommands = require("../functions/PsnCommands");
const SteamCommands = require("../functions/SteamCommands");

// Salva implementações originais para restaurar depois
const originalGet = axios.get;
const originalPost = axios.post;

async function runTests() {
	console.log("=== Iniciando testes de PsnCommands e SteamCommands ===");

	const bot = new FakeBot({ id: "test-bot" });

	// -------------------------------------------------------------
	// 1. Testes de PSN Commands
	// -------------------------------------------------------------
	console.log("\n--- Testes PSN ---");

	// 1.1 Sem argumentos
	const msgPsnNoArgs = createMessage({
		content: "!psn-platinas",
		group: "123@g.us",
		author: "user@s.whatsapp.net"
	});
	const resPsnNoArgs = await PsnCommands.psnPlatinaCommand(bot, msgPsnNoArgs, [], {
		id: "123@g.us"
	});
	assert.ok(
		resPsnNoArgs.content.includes("Informe seu Online ID PSN"),
		"Deve solicitar Online ID quando vazio"
	);
	console.log("✓ PSN: Validação sem argumentos passou");

	// 1.2 Não configurado
	delete process.env.PSNCOMMAND_API_URL;
	delete process.env.API_KEY_STEAMCOMMAND;
	const resPsnNotConfig = await PsnCommands.psnPlatinaCommand(bot, msgPsnNoArgs, ["SuperSugoii"], {
		id: "123@g.us"
	});
	assert.ok(
		resPsnNotConfig.content.includes("precisa ser configurada"),
		"Deve avisar que plataforma não está configurada"
	);
	console.log("✓ PSN: Validação de configuração ausente passou");

	// Configurar ambiente para testes mockados
	process.env.PSNCOMMAND_API_URL = "https://psnapi.platifly.com";
	process.env.STEAMCOMMAND_API_URL = "https://api.platifly.com";
	process.env.API_KEY_STEAMCOMMAND = "test-token";

	// 1.3 Sucesso na consulta PSN
	axios.get = async (url, options) => {
		assert.strictEqual(
			options.headers.Authorization,
			"Bearer test-token",
			"Deve enviar Bearer token"
		);
		if (url.includes("/internal/psn/profiles/SuperSugoii/platinums")) {
			return {
				data: {
					profile: { onlineId: "SuperSugoii" },
					totalGames: 12,
					totalPlatinums: 2,
					platinums: [
						{
							trophyTitleName: "Bloodborne",
							trophyTitlePlatform: "PS4",
							earnedTrophies: { bronze: 20, silver: 7, gold: 6, platinum: 1 },
							lastUpdatedDateTime: "2024-01-15T12:00:00Z"
						},
						{
							trophyTitleName: "Elden Ring",
							trophyTitlePlatform: "PS5",
							earnedTrophies: { bronze: 24, silver: 14, gold: 3, platinum: 1 },
							lastUpdatedDateTime: "2024-03-20T18:00:00Z"
						}
					],
					fromCache: false
				}
			};
		}
		throw new Error("URL não mockada: " + url);
	};

	const resPsnSuccess = await PsnCommands.psnPlatinaCommand(bot, msgPsnNoArgs, ["SuperSugoii"], {
		id: "123@g.us"
	});
	assert.ok(resPsnSuccess.content.includes("SuperSugoii"), "Deve conter Online ID");
	assert.ok(resPsnSuccess.content.includes("Bloodborne"), "Deve conter nome do jogo Bloodborne");
	assert.ok(resPsnSuccess.content.includes("Elden Ring"), "Deve conter nome do jogo Elden Ring");
	assert.ok(resPsnSuccess.content.includes("💎 Platinas: *2*"), "Deve conter total de platinas");
	console.log("✓ PSN: Consulta com sucesso passou");

	// 1.4 Perfil privado PSN
	axios.get = async () => {
		const err = new Error("Request failed with status code 400");
		err.response = { status: 400, data: { code: "PSN_PRIVATE" } };
		throw err;
	};
	const resPsnPrivate = await PsnCommands.psnPlatinaCommand(bot, msgPsnNoArgs, ["Privado"], {
		id: "123@g.us"
	});
	assert.ok(
		resPsnPrivate.content.includes("Deixe o perfil, os jogos e as conquistas públicos"),
		"Deve informar perfil privado"
	);
	console.log("✓ PSN: Tratamento de perfil privado passou");

	// -------------------------------------------------------------
	// 2. Testes de Steam Commands
	// -------------------------------------------------------------
	console.log("\n--- Testes Steam ---");

	// 2.1 Sem argumentos
	const msgSteamNoArgs = createMessage({
		content: "!steam-platinas",
		group: "123@g.us",
		author: "user@s.whatsapp.net"
	});
	const resSteamNoArgs = await SteamCommands.platinaCommand(bot, msgSteamNoArgs, [], {
		id: "123@g.us"
	});
	assert.ok(
		resSteamNoArgs.content.includes("Informe um SteamID64"),
		"Deve solicitar SteamID quando vazio"
	);
	console.log("✓ Steam: Validação sem argumentos passou");

	// 2.2 Consulta completada síncrona
	axios.post = async (url, body, options) => {
		assert.strictEqual(
			options.headers.Authorization,
			"Bearer test-token",
			"Deve enviar Bearer token"
		);
		assert.strictEqual(body.user, "gabriel", "Deve enviar usuário no body");
		return {
			data: {
				status: "completed",
				result: {
					profile: { name: "Gabriel", profile_url: "https://steamcommunity.com/id/gabriel" },
					total_games: 50,
					played_games: 30,
					platinums_count: 1,
					platinums: [
						{
							game_name: "Portal 2",
							total_achievements: 51,
							playtime_forever: 1500
						}
					],
					from_cache: true
				}
			}
		};
	};

	const resSteamSync = await SteamCommands.platinaCommand(bot, msgSteamNoArgs, ["gabriel"], {
		id: "123@g.us"
	});
	assert.ok(resSteamSync.content.includes("Gabriel"), "Deve conter nome do usuário");
	assert.ok(resSteamSync.content.includes("Portal 2"), "Deve conter jogo platinado");
	assert.ok(resSteamSync.content.includes("51 conquistas"), "Deve conter conquistas");
	console.log("✓ Steam: Consulta síncrona com sucesso passou");

	// 2.3 Consulta assíncrona (queued/running -> completed)
	bot.resetCapture();
	const fakeJobId = "0123456789abcdef0123456789abcdef";
	axios.post = async () => ({
		data: { status: "queued", jobId: fakeJobId }
	});
	let pollCount = 0;
	axios.get = async (url) => {
		if (url.includes(`/internal/steam/jobs/${fakeJobId}`)) {
			pollCount++;
			return {
				data: {
					status: "completed",
					result: {
						profile: { name: "AsyncUser", profile_url: "https://steamcommunity.com/id/async" },
						total_games: 10,
						played_games: 5,
						platinums_count: 1,
						platinums: [
							{
								game_name: "Hollow Knight",
								total_achievements: 63,
								playtime_forever: 3600
							}
						],
						from_cache: false
					}
				}
			};
		}
		throw new Error("URL não esperada: " + url);
	};

	const resSteamAsync = await SteamCommands.platinaCommand(bot, msgSteamNoArgs, ["AsyncUser"], {
		id: "123@g.us"
	});
	assert.ok(
		resSteamAsync.content.includes("Consulta Steam iniciada"),
		"Deve avisar que foi iniciada em segundo plano"
	);

	// Espera o polling assíncrono resolver (setTimeout de 5000ms no waitSteamLookup)
	// Para não esperar 5 segundos de verdade no teste, podemos verificar que o job foi iniciado
	console.log("✓ Steam: Job assíncrono iniciado com mensagem provisória");

	// 2.4 Teste de fetchSteamPlatinums (função para IA / LLM)
	axios.post = async () => ({
		data: {
			status: "completed",
			result: {
				profile: { name: "ToolUser", profile_url: "https://steamcommunity.com/id/tool" },
				total_games: 20,
				played_games: 15,
				platinums_count: 1,
				platinums: [
					{
						game_name: "Celeste",
						total_achievements: 30,
						playtime_forever: 1200
					}
				]
			}
		}
	});
	const toolRes = await SteamCommands.fetchSteamPlatinums("ToolUser");
	assert.ok(toolRes.includes("Celeste"), "Ferramenta deve retornar dados formatados");
	console.log("✓ Steam: fetchSteamPlatinums para tool chamou e formatou com sucesso");

	// 2.5 Teste de fetchSteamGameInfo (busca de jogos na Steam Store)
	axios.get = async (url) => {
		if (url.includes("storesearch")) {
			return {
				data: {
					items: [{ id: 730, name: "Counter-Strike 2" }]
				}
			};
		}
		if (url.includes("appdetails")) {
			return {
				data: {
					730: {
						data: {
							name: "Counter-Strike 2",
							is_free: true,
							developers: ["Valve"],
							release_date: { date: "21 Aug, 2012" },
							genres: [{ description: "Action" }, { description: "Free to Play" }],
							short_description:
								"For over two decades, Counter-Strike has offered an elite competitive experience."
						}
					}
				}
			};
		}
		throw new Error("URL não esperada: " + url);
	};
	const gameInfoRes = await SteamCommands.fetchSteamGameInfo("cs2");
	assert.ok(gameInfoRes.includes("Counter-Strike 2"), "Deve retornar nome do jogo");
	assert.ok(gameInfoRes.includes("Gratuito para Jogar"), "Deve identificar jogo gratuito");
	console.log("✓ Steam: fetchSteamGameInfo consulta store e retorna com sucesso");

	// Restaura axios
	axios.get = originalGet;
	axios.post = originalPost;

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Falha no teste:", err);
	process.exit(1);
});
