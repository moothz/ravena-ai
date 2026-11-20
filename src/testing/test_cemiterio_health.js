// src/testing/test_cemiterio_health.js
// Testa se o endpoint /health retorna o array 'cemiterio' com bots onde banido == true e enabled == false.

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const express = require("express");
const { registerIndexRoutes } = require("../BotAPI/routes/indexRoutes");

async function runTests() {
	console.log("=== Teste do cemiterio no endpoint /health ===");
	const pass = (req, res, next) => next();
	const app = express();
	const api = {
		app,
		bots: [],
		authenticateBasic: pass,
		strictLimiter: pass,
		isAdmin: () => false,
		setAdminSessionCookie: () => {},
		clearAdminSessionCookie: () => {},
		readWebManagementToken: () => null,
		logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
		database: {
			getActiveStatusAnnouncements: async () => []
		},
		serviceProviderService: {}
	};
	registerIndexRoutes(api);

	const server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const baseUrl = `http://127.0.0.1:${server.address().port}`;

	try {
		const res = await fetch(`${baseUrl}/health`);
		assert.strictEqual(res.status, 200, "/health deve responder 200");
		const data = await res.json();

		assert.ok(Array.isArray(data.cemiterio), "data.cemiterio deve ser um array");
		console.log(`✓ cemiterio retornado com ${data.cemiterio.length} instâncias banidas.`);

		if (data.cemiterio.length > 0) {
			const first = data.cemiterio[0];
			assert.ok(first.id, "Bot banido deve ter id");
			assert.ok(first.nomeExibir, "Bot banido deve ter nomeExibir");
			assert.ok("dataNascimento" in first, "Bot banido deve ter campo dataNascimento");
			assert.ok("dataMorte" in first, "Bot banido deve ter campo dataMorte");
			console.log(`✓ Exemplo de bot no cemitério: ${first.id} (${first.nomeExibir})`);
		}

		console.log("✓ Todos os testes do cemitério no /health passaram!");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste do cemiterio:", err);
		process.exit(1);
	});
