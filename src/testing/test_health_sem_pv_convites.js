// src/testing/test_health_sem_pv_convites.js
// Testa se o endpoint /health expõe semPV / ignorePV e semConvites / ignoreInvites corretamente.

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const express = require("express");
const { registerIndexRoutes } = require("../BotAPI/routes/indexRoutes");

async function runTests() {
	console.log("=== Teste de semPV e semConvites no endpoint /health ===");
	const pass = (req, res, next) => next();
	const app = express();

	const mockBots = [
		{
			id: "ravena-sem-pv",
			nomeExibir: "Ravena Sem PV",
			phoneNumber: "5511999990001",
			isConnected: true,
			ignorePV: true,
			ignoreInvites: false,
			privado: false
		},
		{
			id: "ravena-sem-convites",
			nomeExibir: "Ravena Sem Convites",
			phoneNumber: "5511999990002",
			isConnected: true,
			ignorePV: false,
			ignoreInvites: true,
			privado: false
		},
		{
			id: "ravena-ambos",
			nomeExibir: "Ravena Ambos",
			phoneNumber: "5511999990003",
			isConnected: true,
			ignorePV: true,
			ignoreInvites: true,
			privado: false
		}
	];

	const api = {
		app,
		bots: mockBots,
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

		assert.ok(Array.isArray(data.bots), "data.bots deve ser um array");

		const botSemPv = data.bots.find((b) => b.id === "ravena-sem-pv");
		assert.ok(botSemPv, "Bot ravena-sem-pv deve estar presente");
		assert.strictEqual(botSemPv.semPV, true, "ravena-sem-pv deve ter semPV: true");
		assert.strictEqual(botSemPv.ignorePV, true, "ravena-sem-pv deve ter ignorePV: true");
		assert.strictEqual(botSemPv.semConvites, false, "ravena-sem-pv deve ter semConvites: false");
		assert.strictEqual(
			botSemPv.ignoreInvites,
			false,
			"ravena-sem-pv deve ter ignoreInvites: false"
		);

		const botSemConvites = data.bots.find((b) => b.id === "ravena-sem-convites");
		assert.ok(botSemConvites, "Bot ravena-sem-convites deve estar presente");
		assert.strictEqual(botSemConvites.semPV, false, "ravena-sem-convites deve ter semPV: false");
		assert.strictEqual(
			botSemConvites.ignorePV,
			false,
			"ravena-sem-convites deve ter ignorePV: false"
		);
		assert.strictEqual(
			botSemConvites.semConvites,
			true,
			"ravena-sem-convites deve ter semConvites: true"
		);
		assert.strictEqual(
			botSemConvites.ignoreInvites,
			true,
			"ravena-sem-convites deve ter ignoreInvites: true"
		);

		const botAmbos = data.bots.find((b) => b.id === "ravena-ambos");
		assert.ok(botAmbos, "Bot ravena-ambos deve estar presente");
		assert.strictEqual(botAmbos.semPV, true, "ravena-ambos deve ter semPV: true");
		assert.strictEqual(botAmbos.ignorePV, true, "ravena-ambos deve ter ignorePV: true");
		assert.strictEqual(botAmbos.semConvites, true, "ravena-ambos deve ter semConvites: true");
		assert.strictEqual(botAmbos.ignoreInvites, true, "ravena-ambos deve ter ignoreInvites: true");

		console.log("✓ Todos os testes de semPV e semConvites no /health passaram!");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
