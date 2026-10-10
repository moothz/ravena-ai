process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.DISABLE_FREE_GAMES_TIMER = "true";

const assert = require("assert");
const axios = require("axios");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const Database = require("../utils/Database");
const {
	commands,
	cleanEpicTitle,
	isGame,
	requiresArpPoints,
	parseWorthUsd,
	formatNotificationMessage,
	gamingFreebiesCommand,
	freeGamesNotificarCommand,
	freeGamesFrequenciaCommand,
	checkAndNotifyFreeGames
} = require("../functions/GamingFreebies");

const database = Database.getInstance({ testMode: true });
const DB_NAME = "gaming_freebies";

async function runTests() {
	console.log("=== INICIANDO TESTES DO MÓDULO GAMING FREEBIES ===");

	// -------------------------------------------------------------
	// 1. Funções puras de formatação e filtros
	// -------------------------------------------------------------
	console.log("\n[1] Testando funções puras de filtros e limpeza...");

	// cleanEpicTitle
	assert.strictEqual(
		cleanEpicTitle("Out of Sight (Epic Games) Giveaway"),
		"Out of Sight",
		"Deve remover (Epic Games) e Giveaway"
	);
	assert.strictEqual(
		cleanEpicTitle("Deus Ex: Mankind Divided (Epic Games Store) Giveaway"),
		"Deus Ex: Mankind Divided",
		"Deve remover (Epic Games Store)"
	);
	assert.strictEqual(cleanEpicTitle("Cyberpunk 2077"), "Cyberpunk 2077");

	// isGame
	assert.strictEqual(isGame({ type: "Game" }), true);
	assert.strictEqual(isGame({ type: "game" }), true);
	assert.strictEqual(isGame({ type: "DLC" }), false);
	assert.strictEqual(isGame({ type: "Early Access" }), false);

	// requiresArpPoints
	assert.strictEqual(
		requiresArpPoints({
			description: "Reach level 5 and spend 50 ARP points to claim",
			instructions: ""
		}),
		true,
		"Deve detectar ARP na descrição"
	);
	assert.strictEqual(
		requiresArpPoints({ description: "Free game on Steam", instructions: "Click install" }),
		false,
		"Jogo normal não requer ARP"
	);

	// parseWorthUsd
	assert.strictEqual(parseWorthUsd("$19.99"), 19.99);
	assert.strictEqual(parseWorthUsd("$1,299.50"), 1299.5);
	assert.strictEqual(parseWorthUsd("N/A"), 0);
	assert.strictEqual(parseWorthUsd(null), 0);

	// formatNotificationMessage
	const epicSec = {
		label: "Epic",
		games: [{ title: "Limbo", url: "https://epicgames.com/limbo" }]
	};
	const steamSec = {
		label: "Steam",
		games: [{ title: "Portal", url: "https://store.steampowered.com/app/400" }]
	};

	const singleMsg = formatNotificationMessage([epicSec]);
	assert.ok(
		singleMsg.includes("Jogos novos liberados na Epic!"),
		"Cabeçalho único deve conter a loja"
	);
	assert.ok(singleMsg.includes("Limbo"));

	const multiMsg = formatNotificationMessage([epicSec, steamSec]);
	assert.ok(multiMsg.includes("Jogos novos liberados!"), "Cabeçalho multi-loja correto");
	assert.ok(multiMsg.includes("*Epic:*"));
	assert.ok(multiMsg.includes("*Steam:*"));
	console.log("✓ Funções puras validadas com sucesso.");

	// -------------------------------------------------------------
	// 2. Registro de Comandos e Permissões
	// -------------------------------------------------------------
	console.log("\n[2] Verificando lista de comandos exportados...");
	const cmd0800 = commands.find((c) => c.name === "0800");
	const cmdJogosFree = commands.find((c) => c.name === "jogos-free");
	const cmdNotificar = commands.find((c) => c.name === "jogos-free-notificar");
	const cmdFrequencia = commands.find((c) => c.name === "jogos-free-frequencia");

	assert.ok(cmd0800, "Comando 0800 deve existir");
	assert.ok(cmdJogosFree, "Comando jogos-free deve existir");
	assert.ok(cmdNotificar, "Comando jogos-free-notificar deve existir");
	assert.ok(cmdFrequencia, "Comando jogos-free-frequencia deve existir");

	assert.strictEqual(cmd0800.adminOnly, false, "0800 não deve ser adminOnly");
	assert.strictEqual(cmdJogosFree.adminOnly, false, "jogos-free não deve ser adminOnly");
	assert.strictEqual(cmdNotificar.adminOnly, true, "jogos-free-notificar deve ser adminOnly");
	assert.strictEqual(cmdFrequencia.adminOnly, true, "jogos-free-frequencia deve ser adminOnly");
	console.log("✓ Comandos e metadados de permissão validados.");

	// -------------------------------------------------------------
	// 3. Mock e Execução de !0800 / !jogos-free
	// -------------------------------------------------------------
	console.log("\n[3] Testando execução do comando !0800...");
	const bot = new FakeBot({ id: "bot-test", isConnected: true });
	const testGroup = {
		id: "120363000000000000@g.us",
		name: "Grupo Gamer Teste",
		admins: ["5511999990000@s.whatsapp.net"],
		botNotInGroup: []
	};
	database.getGroup = async () => testGroup;

	// Salva get original do axios para mock controlado
	const originalGet = axios.get;
	axios.get = async (url) => {
		if (url.includes("giveaways")) {
			return {
				data: [
					{
						id: 101,
						title: "Borderlands 3 (Epic Games) Giveaway",
						type: "Game",
						worth: "$59.99",
						platforms: "PC",
						open_giveaway_url: "https://gamerpower.com/bl3"
					},
					{
						id: 102,
						title: "Alienware Starter Pack",
						type: "Game",
						description: "Requires 100 ARP points",
						worth: "$10.00",
						platforms: "PC",
						open_giveaway_url: "https://gamerpower.com/arp"
					},
					{
						id: 103,
						title: "Cool DLC Pack",
						type: "DLC",
						worth: "$5.00",
						platforms: "PC",
						open_giveaway_url: "https://gamerpower.com/dlc"
					}
				]
			};
		}
		if (url.includes("worth")) {
			return { data: { worth_estimation_usd: "74.99" } };
		}
		return { data: [] };
	};

	try {
		const msg0800 = createMessage({
			content: "!0800",
			group: testGroup.id,
			author: "5511999990000@s.whatsapp.net"
		});

		const res0800 = await gamingFreebiesCommand(bot, msg0800, [], testGroup);
		assert.ok(res0800, "Deve retornar ReturnMessage");
		assert.ok(res0800.content.includes("JOGOS GRÁTIS ATUALMENTE"));
		assert.ok(
			res0800.content.includes("Borderlands 3"),
			"Deve conter o jogo válido e com título limpo"
		);
		assert.ok(
			!res0800.content.includes("Alienware Starter Pack"),
			"Não deve conter giveaway que exige ARP"
		);
		assert.ok(res0800.content.includes("Cool DLC Pack"), "Deve listar DLC na seção correspondente");
		assert.ok(res0800.content.includes("ECONOMIA TOTAL"), "Deve calcular economia");
		console.log("✓ Comando !0800 executado e validado.");

		// -------------------------------------------------------------
		// 4. Testando !jogos-free-notificar (Permissão Admin e Toggle)
		// -------------------------------------------------------------
		console.log("\n[4] Testando comando !jogos-free-notificar...");

		// Limpa qualquer dado residual do grupo de teste
		await database.dbRun(DB_NAME, "DELETE FROM free_games_subscriptions WHERE group_id = ?", [
			testGroup.id
		]);
		await database.dbRun(
			DB_NAME,
			"DELETE FROM free_games_notified WHERE store IN ('epic', 'steam')"
		);

		// Usuário comum (não admin) -> deve ser barrado
		const msgNaoAdmin = createMessage({
			content: "!jogos-free-notificar",
			group: testGroup.id,
			author: "5511888880000@s.whatsapp.net" // não está em testGroup.admins
		});
		const resBarrado = await freeGamesNotificarCommand(bot, msgNaoAdmin, [], testGroup);
		assert.ok(resBarrado.content.includes("Acesso negado"), "Usuário comum deve receber negação");

		// Usuário admin ativando Epic
		const msgAdminEpic = createMessage({
			content: "!jogos-free-notificar epic",
			group: testGroup.id,
			author: "5511999990000@s.whatsapp.net"
		});
		const resAdminEpic = await freeGamesNotificarCommand(bot, msgAdminEpic, ["epic"], testGroup);
		assert.ok(resAdminEpic.content.includes("Epic Games:* Ativado ✅"));
		assert.ok(resAdminEpic.content.includes("Steam:* Desativado ❌"));

		// Toggle sem argumento -> ativa ambas
		const msgAdminTodas = createMessage({
			content: "!jogos-free-notificar",
			group: testGroup.id,
			author: "5511999990000@s.whatsapp.net"
		});
		const resAdminTodas = await freeGamesNotificarCommand(bot, msgAdminTodas, [], testGroup);
		assert.ok(resAdminTodas.content.includes("Epic Games:* Ativado ✅"));
		assert.ok(resAdminTodas.content.includes("Steam:* Ativado ✅"));

		// Toggle sem argumento com ambas ativas -> desativa ambas
		const resAdminDesativa = await freeGamesNotificarCommand(bot, msgAdminTodas, [], testGroup);
		assert.ok(resAdminDesativa.content.includes("Epic Games:* Desativado ❌"));
		assert.ok(resAdminDesativa.content.includes("Steam:* Desativado ❌"));

		// Testando gerenciamento via PV com !g-manage
		bot.eventHandler = {
			commandHandler: {
				privateManagement: {
					"5511999990000@s.whatsapp.net": testGroup.id
				}
			}
		};
		const msgPvAdmin = createMessage({
			content: "!jogos-free-notificar epic",
			group: null, // Chat privado
			author: "5511999990000@s.whatsapp.net"
		});
		const resPvAdmin = await freeGamesNotificarCommand(bot, msgPvAdmin, ["epic"], null);
		assert.ok(
			resPvAdmin.content.includes("Epic Games:* Ativado ✅"),
			"No PV com g-manage deve conseguir alterar a flag"
		);

		// Reativa ambas para testes seguintes
		await freeGamesNotificarCommand(bot, msgAdminTodas, [], testGroup);
		console.log("✓ Comportamento de permissões e toggle do !jogos-free-notificar validado.");

		// -------------------------------------------------------------
		// 5. Testando !jogos-free-frequencia (Leitura, Atualização e Validação)
		// -------------------------------------------------------------
		console.log("\n[5] Testando comando !jogos-free-frequencia...");

		// Consulta sem argumentos
		const msgFreqConsulta = createMessage({
			content: "!jogos-free-frequencia",
			group: testGroup.id,
			author: "5511999990000@s.whatsapp.net"
		});
		const resFreqConsulta = await freeGamesFrequenciaCommand(bot, msgFreqConsulta, [], testGroup);
		assert.ok(resFreqConsulta.content.includes("Configuração de Frequência de Jogos Grátis"));
		assert.ok(resFreqConsulta.content.includes("a cada *7* dia(s)"));

		// Atualização para 3 dias às 20h (noite)
		const msgFreqUpdate = createMessage({
			content: "!jogos-free-frequencia 3 noite",
			group: testGroup.id,
			author: "5511999990000@s.whatsapp.net"
		});
		const resFreqUpdate = await freeGamesFrequenciaCommand(
			bot,
			msgFreqUpdate,
			["3", "noite"],
			testGroup
		);
		assert.ok(resFreqUpdate.content.includes("atualizada com sucesso"));
		assert.ok(resFreqUpdate.content.includes("a cada *3* dia(s)"));
		assert.ok(resFreqUpdate.content.includes("Noite"));
		assert.ok(resFreqUpdate.content.includes("20:00 BRT"));

		// Mudança apenas do turno para 'manha' (deve manter os 3 dias)
		const resFreqTurno = await freeGamesFrequenciaCommand(bot, msgFreqUpdate, ["manha"], testGroup);
		assert.ok(resFreqTurno.content.includes("a cada *3* dia(s)"));
		assert.ok(resFreqTurno.content.includes("Manhã"));
		assert.ok(resFreqTurno.content.includes("09:00 BRT"));

		// Validação de erro: mais de 30 dias
		const resFreqInvalido = await freeGamesFrequenciaCommand(bot, msgFreqUpdate, ["45"], testGroup);
		assert.ok(
			resFreqInvalido.content.includes("no máximo *30 dias*"),
			"Deve rejeitar mais de 30 dias"
		);

		// Validação de erro: menos de 1 dia
		const resFreqZero = await freeGamesFrequenciaCommand(bot, msgFreqUpdate, ["0"], testGroup);
		assert.ok(resFreqZero.content.includes("no mínimo *1 dia*"), "Deve rejeitar menos de 1 dia");
		console.log("✓ Validações do comando !jogos-free-frequencia aprovadas.");

		// -------------------------------------------------------------
		// 6. Testando Ciclo de Envio de Notificações (checkAndNotifyFreeGames)
		// -------------------------------------------------------------
		console.log("\n[6] Testando checkAndNotifyFreeGames com fallback de bot...");

		// Configura o grupo para turno 'manha' com frequência de 1 dia e ultimo_aviso zerado
		await database.dbRun(
			DB_NAME,
			"UPDATE free_games_subscriptions SET notificar_epic = 1, notificar_steam = 1, periodo = 'manha', frequencia_dias = 1, ultimo_aviso = 0 WHERE group_id = ?",
			[testGroup.id]
		);

		// Mock da API para Epic e Steam
		axios.get = async (url, config) => {
			const platform = config?.params?.platform;
			if (platform === "epic-games-store") {
				return {
					data: [
						{
							id: 501,
							title: "The Falconeer (Epic Games) Giveaway",
							type: "Game",
							worth: "$29.99",
							open_giveaway_url: "https://epicgames.com/falconeer"
						}
					]
				};
			}
			if (platform === "steam") {
				return {
					data: [
						{
							id: 601,
							title: "Half-Life 2",
							type: "Game",
							worth: "$9.99",
							open_giveaway_url: "https://store.steampowered.com/hl2"
						}
					]
				};
			}
			return { data: [] };
		};

		// Configura bots na database simulando instâncias
		database.botInstances = [bot];
		bot.resetCapture();

		// Executa o envio para o turno 'manha'
		const summary = await checkAndNotifyFreeGames("manha");
		assert.strictEqual(summary.sent, 1, "Deve enviar com sucesso para o grupo elegível");
		assert.strictEqual(bot.capturedMessages.length, 1, "Bot deve ter capturado a mensagem");

		const sentMsg = bot.capturedMessages[0];
		assert.ok(
			sentMsg.content.includes("Jogos novos liberados!"),
			"Deve conter cabeçalho multi-loja"
		);
		assert.ok(sentMsg.content.includes("The Falconeer"), "Deve conter jogo da Epic");
		assert.ok(sentMsg.content.includes("Half-Life 2"), "Deve conter jogo da Steam");

		// Verifica se o jogo foi registrado em free_games_notified
		const notifiedRows = await database.dbAll(
			DB_NAME,
			"SELECT * FROM free_games_notified WHERE store IN ('epic', 'steam')"
		);
		assert.ok(
			notifiedRows.some((r) => r.game_id === "501" && r.store === "epic"),
			"Epic 501 deve estar em free_games_notified"
		);
		assert.ok(
			notifiedRows.some((r) => r.game_id === "601" && r.store === "steam"),
			"Steam 601 deve estar em free_games_notified"
		);

		// Segunda execução imediata: não deve enviar repetido
		bot.resetCapture();
		const summary2 = await checkAndNotifyFreeGames("manha");
		assert.strictEqual(
			summary2.sent,
			0,
			"Não deve enviar novamente pois não há jogos novos e a frequência ainda não venceu"
		);
		assert.strictEqual(bot.capturedMessages.length, 0);

		console.log("✓ Ciclo de envio e persistência de jogos notificados validado com sucesso.");
	} finally {
		// Restaura o mock do axios
		axios.get = originalGet;
	}

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => {
		process.exit(0);
	})
	.catch((err) => {
		console.error("❌ Falha nos testes de GamingFreebies:", err);
		process.exit(1);
	});
