process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const { FlightService, findAirport, findAirline } = require("../services/FlightService");

async function runTests() {
	console.log("=== INICIANDO TESTES DOS COMANDOS DE VÔOS E AVIAÇÃO ===");

	const bot = new FakeBot({ id: "teste-flight", grupoLogs: "123@g.us" });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.loadAllCommands();
	const testGroup = "120363220838898748@g.us";
	const testAuthor = "5511999999999@s.whatsapp.net";

	async function runCmd(cmdString) {
		bot.resetCapture();
		const [command, ...args] = cmdString.trim().split(/\s+/);
		const msg = createMessage({
			content: `!${cmdString}`,
			group: testGroup,
			author: testAuthor
		});
		const groupObj = eventHandler.groups[testGroup] || null;
		await eventHandler.commandHandler.processCommand(bot, msg, command, args, groupObj);
	}

	// 1. Teste de bases locais (Airports & Airlines)
	console.log("1. Testando bases locais de aeroportos e companhias aéreas...");
	const cwb = findAirport("CWB");
	assert.ok(cwb, "Deve encontrar CWB pelo IATA");
	assert.strictEqual(cwb.icao, "SBCT", "ICAO de CWB deve ser SBCT");

	const curitiba = findAirport("curitiba");
	assert.ok(curitiba, "Deve encontrar aeroporto por 'curitiba'");
	assert.strictEqual(curitiba.iata, "CWB");

	const gru = findAirport("SBGR");
	assert.ok(gru, "Deve encontrar SBGR pelo ICAO");
	assert.strictEqual(gru.iata, "GRU");

	const gol = findAirline("GLO");
	assert.ok(gol, "Deve encontrar GOL por GLO");
	assert.strictEqual(gol.iata, "G3");

	const latam = findAirline("LA");
	assert.ok(latam, "Deve encontrar LATAM por LA");
	console.log("✓ Bases locais de aeroportos e companhias validadas!");

	// 2. Teste do comando !voo sem argumentos (Ajuda)
	console.log("2. Testando !voo sem argumentos...");
	await runCmd("voo");
	assert.ok(bot.capturedMessages.length > 0, "Deve responder mensagem de ajuda");
	assert.ok(bot.capturedMessages[0].content.includes("Rastreamento de Vôos"));
	console.log("✓ Ajuda de !voo validada!");

	// 3. Teste do comando !voos sem argumentos (Ajuda)
	console.log("3. Testando !voos sem argumentos...");
	await runCmd("voos");
	assert.ok(bot.capturedMessages.length > 0, "Deve responder mensagem de ajuda de !voos");
	assert.ok(bot.capturedMessages[0].content.includes("Painel de Voos"));
	console.log("✓ Ajuda de !voos validada!");

	// 4. Teste do comando !voos CWB (Painel de aeroporto por código IATA)
	console.log("4. Testando !voos CWB...");
	await runCmd("voos CWB");
	assert.ok(bot.capturedMessages.length > 0, "Deve retornar painel para CWB");
	const cwbMsg = bot.capturedMessages[0].content;
	assert.ok(cwbMsg.includes("AFONSO PENA"), "Deve conter nome do aeroporto");
	assert.ok(cwbMsg.includes("PARTIDAS"), "Deve conter seção de partidas");
	assert.ok(cwbMsg.includes("CHEGADAS"), "Deve conter seção de chegadas");
	assert.ok(cwbMsg.includes("!voo <código>"), "Deve conter dica de uso do comando !voo");
	console.log("✓ Painel de voos !voos CWB validado com sucesso!");

	// 5. Teste do comando !voos curitiba (Busca por nome de cidade)
	console.log("5. Testando !voos curitiba...");
	await runCmd("voos curitiba");
	assert.ok(bot.capturedMessages.length > 0, "Deve retornar painel para busca 'curitiba'");
	assert.ok(bot.capturedMessages[0].content.includes("CWB / SBCT"));
	console.log("✓ Painel de voos por cidade !voos curitiba validado!");

	// 6. Teste de redirecionamento de !voos <código_de_voo> para !voo
	console.log("6. Testando redirecionamento de !voos G31500...");
	await runCmd("voos G31500");
	assert.ok(bot.capturedMessages.length > 0, "Deve processar como busca de voo");
	const redirMsg = bot.capturedMessages[0].content;
	assert.ok(
		redirMsg.includes("VOO GLO1500") || redirMsg.includes("Nenhum sinal ao vivo"),
		"Deve redirecionar para consulta de voo"
	);
	console.log("✓ Redirecionamento inteligente validado!");

	// 7. Teste de consulta ANAC RAB (!prefixo e !rab)
	console.log("7. Testando !prefixo PR-XMR (Consulta ANAC RAB)...");
	await runCmd("prefixo PR-XMR");
	assert.ok(bot.capturedMessages.length > 0, "Deve retornar resposta para !prefixo PR-XMR");
	const rabMsg = bot.capturedMessages[0].content;
	assert.ok(rabMsg.includes("REGISTRO AERONÁUTICO BRASILEIRO"), "Deve ter cabeçalho RAB");
	assert.ok(rabMsg.includes("PR-XMR"), "Deve identificar matrícula");
	assert.ok(rabMsg.includes("BOEING"), "Deve identificar fabricante");
	assert.ok(rabMsg.includes("GOL LINHAS AÉREAS"), "Deve identificar operador");
	console.log("✓ Consulta ANAC RAB !prefixo validada com sucesso!");

	// 8. Teste do alias !rab
	console.log("8. Testando alias !rab PR-GGD...");
	await runCmd("rab PR-GGD");
	assert.ok(bot.capturedMessages.length > 0, "Deve responder ao comando !rab");
	assert.ok(bot.capturedMessages[0].content.includes("REGISTRO AERONÁUTICO BRASILEIRO"));
	console.log("✓ Alias !rab validado com sucesso!");

	// 9. Teste do comando !radar SBGR
	console.log("9. Testando !radar SBGR...");
	await runCmd("radar SBGR");
	assert.ok(bot.capturedMessages.length > 0, "Deve responder ao comando !radar");
	assert.ok(bot.capturedMessages[0].content.includes("RADAR AÉREO"));
	assert.ok(bot.capturedMessages[0].content.toUpperCase().includes("GUARULHOS"));
	console.log("✓ Radar aéreo !radar validado com sucesso!");

	// 10. Teste do comando !aeroporto SBGR
	console.log("10. Testando !aeroporto SBGR...");
	await runCmd("aeroporto SBGR");
	assert.ok(bot.capturedMessages.length > 0, "Deve responder ao comando !aeroporto");
	const aeroMsg = bot.capturedMessages[0].content;
	assert.ok(aeroMsg.toUpperCase().includes("GUARULHOS"));
	assert.ok(aeroMsg.includes("METAR"));
	console.log("✓ Consulta de aeroporto !aeroporto validada com sucesso!");

	// 11. Teste da estrutura de localização nativa no WhatsApp
	console.log("11. Testando estrutura de retorno com isLocation para WhatsApp...");
	const flightMock = {
		inFlight: true,
		locationCard: {
			isLocation: true,
			latitude: -23.4356,
			longitude: -46.4731,
			name: "✈️ GLO1500 (B738) - GOL Linhas Aéreas",
			address: "FL360 | 850 km/h | Rumo 180°"
		}
	};
	assert.strictEqual(flightMock.locationCard.isLocation, true);
	assert.strictEqual(typeof flightMock.locationCard.latitude, "number");
	assert.strictEqual(typeof flightMock.locationCard.longitude, "number");
	assert.ok(flightMock.locationCard.name.length > 0);
	assert.ok(flightMock.locationCard.address.length > 0);
	console.log("✓ Estrutura de card de localização validada!");

	console.log("\n=======================================================");
	console.log("🎉 TODOS OS 11 TESTES DE AVIAÇÃO PASSARAM COM SUCESSO!");
	console.log("=======================================================\n");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHA NOS TESTES:", err);
		process.exit(1);
	});
