"use strict";

process.env.NODE_ENV = "test";
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const CustomVariableProcessor = require("../utils/CustomVariableProcessor");
const FakeBot = require("./FakeBot");

async function main() {
	console.log("Iniciando testes de correções de bugs no CustomVariableProcessor...");
	const processor = new CustomVariableProcessor();
	const bot = new FakeBot({ id: "test-bot" });
	bot.phoneNumber = "5511999999999";

	// Teste 1: {somaRandoms}
	console.log("\n[TESTE 1] Testando {somaRandoms}...");
	for (let i = 0; i < 5; i++) {
		const raw = "Números: {rndDadoRange-10-20} {rndDadoRange-10-20} Total: {somaRandoms}";
		const processed = processor.processSystemVariables(raw);
		const match = processed.match(/Números: (\d+) (\d+) Total: (\d+)/);
		assert.ok(match, `Formato esperado não encontrado em: "${processed}"`);
		const n1 = parseInt(match[1], 10);
		const n2 = parseInt(match[2], 10);
		const sum = parseInt(match[3], 10);
		assert.strictEqual(sum, n1 + n2, `Soma incorreta: ${n1} + ${n2} != ${sum}`);
	}
	console.log("✓ {somaRandoms} somou corretamente os números aleatórios anteriores.");

	// Teste 2: Variáveis Estáticas com Arrays (picks independentes)
	console.log("\n[TESTE 2] Testando variáveis estáticas com array...");
	processor.cache.variables = {
		premio: ["Ouro", "Prata", "Bronze", "Diamante", "Rubi"]
	};
	let differentCount = 0;
	for (let i = 0; i < 10; i++) {
		const result = processor.processCustomStaticVariables("1: {premio} | 2: {premio}");
		const parts = result.match(/1: (\w+) \| 2: (\w+)/);
		assert.ok(parts, `Resultado inesperado: ${result}`);
		if (parts[1] !== parts[2]) {
			differentCount++;
		}
	}
	assert.ok(
		differentCount > 0,
		"Variáveis estáticas de array devem sortear itens independentes para cada ocorrência"
	);
	console.log("✓ Variáveis estáticas de array sorteiam itens independentemente.");

	// Teste 3: Exclusão do próprio bot em getRandomGroupMember e isBotSelf
	console.log("\n[TESTE 3] Testando exclusão do próprio bot em sorteio de membros...");
	const mockChat = {
		isGroup: true,
		participants: [
			{ id: { _serialized: "5511999999999@s.whatsapp.net", user: "5511999999999" }, isBot: false },
			{
				id: { _serialized: "5511888888888@s.whatsapp.net", user: "5511888888888" },
				isBot: false,
				pushname: "Humano"
			}
		]
	};
	bot.client = {
		info: { wid: { _serialized: "5511999999999" } },
		getChatById: async () => mockChat,
		getContactById: async (id) => ({
			number: String(id).split("@")[0],
			name: "Humano",
			pushname: "Humano"
		})
	};

	assert.strictEqual(
		processor.isBotSelf(bot, mockChat.participants[0]),
		true,
		"Deveria identificar o próprio bot"
	);
	assert.strictEqual(
		processor.isBotSelf(bot, mockChat.participants[1]),
		false,
		"Não deveria identificar o humano como bot"
	);

	for (let i = 0; i < 5; i++) {
		const member = await processor.getRandomGroupMember(bot, "123@g.us");
		assert.strictEqual(member.number, "5511888888888", "Nunca deve escolher o próprio bot");
	}
	console.log("✓ Bot excluído com sucesso do sorteio de membros.");

	// Teste 4: {tituloGrupo}
	console.log("\n[TESTE 4] Testando {tituloGrupo}...");
	const contextGroup = {
		group: { name: "Amigos da Ravena" },
		message: { author: "5511888888888@s.whatsapp.net" }
	};
	const groupResult = await processor.processContextVariables(
		"Bem-vindo ao {tituloGrupo}!",
		contextGroup
	);
	assert.strictEqual(groupResult, "Bem-vindo ao Amigos da Ravena!");
	console.log("✓ {tituloGrupo} substituído corretamente.");

	// Teste 5: {weather:location} via WeatherMeteo
	console.log("\n[TESTE 5] Testando {weather:location} integrado ao WeatherMeteo...");
	const weatherResult = await processor.getWeather("São Paulo");
	assert.ok(
		!weatherResult.includes("Ensolarado, 25°C"),
		"Não deve retornar o mock estático antigo"
	);
	assert.match(weatherResult, /°C/, "Deve conter temperatura em graus Celsius");
	assert.match(weatherResult, /São Paulo/i, "Deve conter o nome da cidade");
	console.log("✓ Clima retornado pelo WeatherMeteo:", weatherResult);

	console.log("\nTodos os testes de correções de bugs passaram com sucesso!");
	process.exit(0);
}

main().catch((err) => {
	console.error("Falha nos testes:", err);
	process.exit(1);
});
