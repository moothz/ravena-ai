/**
 * Testes Automatizados para as rotas /qrcode/:botId, /reconnect/:botId e /recreate/:botId
 */
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const axios = require("axios");
const BotAPI = require("../BotAPI");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");

async function main() {
	console.log("=== INICIANDO TESTES DO /qrcode E AÇÕES DE CONEXÃO ===");

	const testPort = 5996;
	const fakeBotConnected = new FakeBot({
		id: "bot-conectado",
		phoneNumber: "5511999991111",
		prefix: "!"
	});
	fakeBotConnected.isConnected = true;

	const fakeBotDisconnected = new FakeBot({
		id: "bot-desconectado",
		phoneNumber: "5511999992222",
		prefix: "!"
	});
	fakeBotDisconnected.isConnected = false;

	const eventHandler = new EventHandler();
	const botApi = new BotAPI({
		port: testPort,
		bots: [fakeBotConnected, fakeBotDisconnected],
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
		// 1. Testando GET /reconnect/:botId
		console.log("\n1. Testando GET /reconnect/:botId...");
		const reconnectRes = await axios.get(`${baseUrl}/reconnect/bot-conectado`, authConfig);
		assert.strictEqual(reconnectRes.status, 200, "GET /reconnect deve retornar 200");
		assert.strictEqual(reconnectRes.data.status, "ok", "Resposta deve ter status ok");
		console.log("✓ GET /reconnect/:botId executou com sucesso");

		// 2. Testando GET /recreate/:botId
		console.log("\n2. Testando GET /recreate/:botId...");
		const recreateRes = await axios.get(`${baseUrl}/recreate/bot-conectado`, authConfig);
		assert.strictEqual(recreateRes.status, 200, "GET /recreate deve retornar 200");
		assert.strictEqual(recreateRes.data.status, "ok", "Resposta deve ter status ok");
		console.log("✓ GET /recreate/:botId executou com sucesso");

		// 3. Testando GET /qrcode/:botId para BOT CONECTADO
		console.log("\n3. Testando HTML do /qrcode/:botId quando CONECTADO...");
		const qrConnectedRes = await axios.get(`${baseUrl}/qrcode/bot-conectado`, authConfig);
		assert.strictEqual(qrConnectedRes.status, 200);
		const htmlConn = qrConnectedRes.data;

		// Deve conter botão de refresh na direita superior com emoji 🔄
		assert(htmlConn.includes("btn-refresh"), "HTML deve conter .btn-refresh");
		assert(htmlConn.includes("🔄"), "HTML deve conter emoji 🔄 de refresh");

		// Deve conter descrição sobre Tentar Reconectar
		assert(
			htmlConn.includes("Tentar Reconectar:"),
			"HTML deve conter título da descrição de Tentar Reconectar"
		);
		assert(
			htmlConn.includes(
				"Tente isto antes de recriar, principalmente quando o bot ficar muitas horas offline."
			),
			"HTML deve conter o texto descritivo solicitado"
		);

		// Deve conter botões Desconectar, Tentar Reconectar, Recriar
		assert(htmlConn.includes("Desconectar"), "HTML deve conter botão Desconectar");
		assert(htmlConn.includes("Tentar Reconectar"), "HTML deve conter botão Tentar Reconectar");
		assert(htmlConn.includes("Recriar"), "HTML deve conter botão Recriar");

		// NÃO deve conter QR Code ou Código de Pareamento quando conectado
		assert(
			!htmlConn.includes('id="connect-area"'),
			"HTML NÃO deve exibir connect-area quando conectado"
		);
		assert(
			!htmlConn.includes("Aguardando QR Code..."),
			"HTML NÃO deve exibir 'Aguardando QR Code...' quando conectado"
		);
		console.log(
			"✓ /qrcode quando CONECTADO exibe apenas botões e descrição, ocultando QR code e pairing code"
		);

		// 4. Testando GET /qrcode/:botId para BOT DESCONECTADO
		console.log("\n4. Testando HTML do /qrcode/:botId quando DESCONECTADO...");
		const qrDisconnRes = await axios.get(`${baseUrl}/qrcode/bot-desconectado`, authConfig);
		assert.strictEqual(qrDisconnRes.status, 200);
		const htmlDisconn = qrDisconnRes.data;

		// Deve conter botão refresh 🔄
		assert(htmlDisconn.includes("btn-refresh"), "HTML deve conter .btn-refresh");
		assert(htmlDisconn.includes("🔄"), "HTML deve conter emoji 🔄");

		// Deve conter connect-area, QR Code e pairing code
		assert(
			htmlDisconn.includes('id="connect-area"'),
			"HTML DEVE exibir connect-area quando desconectado"
		);
		assert(htmlDisconn.includes("QR Code"), "HTML DEVE conter seção QR Code");
		assert(
			htmlDisconn.includes("Código de Pareamento"),
			"HTML DEVE conter seção Código de Pareamento"
		);

		// Deve conter botões Tentar Reconectar, Recriar, Desconectar
		assert(htmlDisconn.includes("Tentar Reconectar"), "HTML deve conter botão Tentar Reconectar");
		assert(htmlDisconn.includes("Recriar"), "HTML deve conter botão Recriar");
		assert(htmlDisconn.includes("Desconectar"), "HTML deve conter botão Desconectar");

		// Deve conter descrição
		assert(
			htmlDisconn.includes(
				"Tente isto antes de recriar, principalmente quando o bot ficar muitas horas offline."
			),
			"HTML deve conter a descrição mesmo quando desconectado"
		);
		console.log("✓ /qrcode quando DESCONECTADO exibe connect-area, QR code, botões e descrição");

		console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
		if (botApi.server) {
			await new Promise((resolve) => botApi.server.close(resolve));
		}
		process.exit(0);
	} catch (err) {
		console.error("Erro durante os testes:", err);
		if (botApi.server) {
			try {
				botApi.server.close();
			} catch (_) {}
		}
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
