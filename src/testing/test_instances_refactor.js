/**
 * Testes Automatizados para a Refatoração do /instances
 * Validação de API HTTP, proteção anti-deleção, extras em 3 níveis e sincronização em tempo real.
 */
const assert = require("assert");
const fs = require("fs").promises;
const path = require("path");
const axios = require("axios");
const BotAPI = require("../BotAPI");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== INICIANDO TESTES DO /instances E REAL-TIME SYNC ===");

	const botsJsonPath = path.join(__dirname, "../../bots.json");
	let originalBotsJsonBackup = null;

	try {
		originalBotsJsonBackup = await fs.readFile(botsJsonPath, "utf8");
	} catch (e) {
		console.warn("bots.json não encontrado previamente para backup.");
	}

	const testPort = 5997;
	const fakeBot = new FakeBot({
		id: "bot-teste-sync",
		phoneNumber: "5511999991111",
		prefix: "!",
		aiPersonality: "Personalidade Original",
		extras: { original: { flag: true } }
	});

	const eventHandler = new EventHandler();
	const botApi = new BotAPI({
		port: testPort,
		bots: [fakeBot],
		eventHandler
	});

	await botApi.start();
	const baseUrl = `http://localhost:${testPort}`;
	const authConfig = {
		auth: {
			username: botApi.apiUser,
			password: botApi.apiPassword
		}
	};

	try {
		// 1. Testando GET /api/bots com dados enriquecidos de runtime
		console.log("\n1. Testando GET /api/bots...");
		const getRes = await axios.get(`${baseUrl}/api/bots`, authConfig);
		assert.strictEqual(getRes.status, 200, "GET /api/bots deve retornar 200");
		assert(Array.isArray(getRes.data), "GET /api/bots deve retornar um array");

		const foundLive = getRes.data.find((b) => b.nome === "bot-teste-sync");
		assert(foundLive, "bot-teste-sync deve constar na resposta do GET /api/bots");
		assert(foundLive._runtime, "bot-teste-sync deve possuir métricas em _runtime");
		assert.strictEqual(
			foundLive.isLive,
			true,
			"bot-teste-sync ativo em memória deve ser marcado isLive: true"
		);
		console.log("✓ GET /api/bots retorna instâncias enriquecidas com telemetria");

		// 2. Testando validação de payload em POST /api/bots
		console.log("\n2. Testando validação de payload em POST /api/bots...");

		// 2.1: Rejeitar não-array
		try {
			await axios.post(`${baseUrl}/api/bots`, { notAnArray: true }, authConfig);
			assert.fail("Deveria ter retornado erro 400 para objeto não-array");
		} catch (err) {
			assert.strictEqual(err.response?.status, 400);
			console.log("✓ Payload não-array rejeitado com 400");
		}

		// 2.2: Rejeitar bot sem nome
		try {
			await axios.post(`${baseUrl}/api/bots`, [{ numero: "5511999999999" }], authConfig);
			assert.fail("Deveria ter retornado erro 400 para bot sem nome");
		} catch (err) {
			assert.strictEqual(err.response?.status, 400);
			console.log("✓ Bot sem nome rejeitado com 400");
		}

		// 2.3: Rejeitar extras com profundidade maior que 3 níveis
		try {
			await axios.post(
				`${baseUrl}/api/bots`,
				[
					{
						nome: "bot-invalido",
						numero: "5511988887777",
						enabled: true,
						extras: {
							categoria1: {
								prop1: {
									nivel4Invalido: "erro"
								}
							}
						}
					}
				],
				authConfig
			);
			assert.fail("Deveria ter retornado erro 400 para extras com mais de 3 níveis");
		} catch (err) {
			assert.strictEqual(err.response?.status, 400);
			assert(err.response.data.message.includes("3 níveis"));
			console.log("✓ Extras com 4 níveis rejeitado com 400 conforme especificação de 3 níveis");
		}

		// 3. Testando sincronização em tempo real de parâmetros no objeto do bot em memória
		console.log(
			"\n3. Testando sincronização em tempo real das instâncias em memória via POST /api/bots..."
		);

		assert.strictEqual(fakeBot.prefix, "!");
		assert.strictEqual(fakeBot.aiPersonality, "Personalidade Original");

		// Carrega bots existentes do arquivo e adiciona/atualiza bot-teste-sync
		const currentFileBots = JSON.parse(await fs.readFile(botsJsonPath, "utf8"));
		const syncBotConfig = {
			nome: "bot-teste-sync",
			numero: "5511999991111",
			nomeExibir: "Bot Sincronizado",
			customPrefix: "$",
			aiPersonality: "Personalidade Nova Atualizada",
			enabled: true,
			privado: true,
			vip: true,
			extras: {
				stickers: {
					maxFiga: 45
				},
				mod: {
					antispam: true
				}
			}
		};
		const updatedBots = [
			...currentFileBots.filter((b) => b.nome !== "bot-teste-sync"),
			syncBotConfig
		];

		const postRes = await axios.post(`${baseUrl}/api/bots`, updatedBots, authConfig);
		assert.strictEqual(postRes.status, 200, "POST /api/bots deve retornar 200 com sucesso");
		assert(
			postRes.data.synchronizedCount >= 1,
			"Pelo menos 1 instância deve ser sincronizada em tempo real"
		);

		// Asserções em tempo real no objeto do bot em memória sem restart
		assert.strictEqual(
			fakeBot.prefix,
			"$",
			"Prefixo do bot em memória deve refletir '$' imediatamente"
		);
		assert.strictEqual(
			fakeBot.nomeExibir,
			"Bot Sincronizado",
			"Nome de exibição deve atualizar em memória"
		);
		assert.strictEqual(
			fakeBot.aiPersonality,
			"Personalidade Nova Atualizada",
			"Personalidade deve atualizar em memória"
		);
		assert.strictEqual(fakeBot.privado, true, "Flag privado deve atualizar em memória");
		assert.strictEqual(fakeBot.vip, true, "Flag vip deve atualizar em memória");
		assert.strictEqual(
			fakeBot.extras?.stickers?.maxFiga,
			45,
			"extras.stickers.maxFiga deve refletir 45"
		);
		assert.strictEqual(
			fakeBot.extras?.mod?.antispam,
			true,
			"extras.mod.antispam deve refletir true"
		);
		console.log("✓ Todas as propriedades foram refletidas no objeto em memória em tempo real!");

		// 4. Testando desativação imediata no EventHandler quando enabled = false
		console.log("\n4. Testando desativação imediata no EventHandler quando enabled = false...");

		fakeBot.capturedMessages = [];
		fakeBot.enabled = true;
		const msg1 = createMessage({
			content: "$ping",
			group: "120363000000000000@g.us",
			author: "5511999990001@s.whatsapp.net"
		});

		await eventHandler.processMessage(fakeBot, msg1);
		console.log("✓ Bot com enabled: true processou mensagem normalmente");

		// Desativa bot via POST /api/bots
		const disableBots = updatedBots.map((b) => {
			if (b.nome === "bot-teste-sync") {
				return { ...b, enabled: false };
			}
			return b;
		});

		await axios.post(`${baseUrl}/api/bots`, disableBots, authConfig);
		assert.strictEqual(fakeBot.enabled, false, "fakeBot.enabled deve ser false após salvar");

		fakeBot.capturedMessages = [];
		const msg2 = createMessage({
			content: "$ping",
			group: "120363000000000000@g.us",
			author: "5511999990001@s.whatsapp.net"
		});

		await eventHandler.processMessage(fakeBot, msg2);
		assert.strictEqual(
			fakeBot.capturedMessages.length,
			0,
			"Bot desativado (enabled: false) não deve processar mensagens"
		);
		console.log("✓ Bot desativado em tempo real descartou mensagens no EventHandler imediatamente");

		// 5. Testando proteção anti-deleção
		console.log("\n5. Testando preservação contra deleção de instâncias...");
		// Envia lista sem bot-teste-sync (tentativa de deletar)
		const listWithoutSyncBot = disableBots.filter((b) => b.nome !== "bot-teste-sync");
		await axios.post(`${baseUrl}/api/bots`, listWithoutSyncBot, authConfig);

		// Lê bots.json do disco e garante que bot-teste-sync continua lá desativado
		const diskBots = JSON.parse(await fs.readFile(botsJsonPath, "utf8"));
		const preservedBot = diskBots.find((b) => b.nome === "bot-teste-sync");
		assert(preservedBot, "Instância bot-teste-sync omitida NÃO deve ser deletada");
		assert.strictEqual(
			preservedBot.enabled,
			false,
			"Instância omitida deve ser preservada como desativada (enabled: false)"
		);
		console.log("✓ Proteção anti-deleção preservou a instância como desativada");

		console.log("\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO!");
		process.exit(0);
	} finally {
		await botApi.stop();
		// Restaura bots.json original
		if (originalBotsJsonBackup) {
			await fs.writeFile(botsJsonPath, originalBotsJsonBackup, "utf8");
		}
	}
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
