// src/testing/test_status_route.js
// /status e o alias /status.html devem passar pela mesma rota (renovação da sessão de
// admin e Cache-Control: no-cache), em vez de /status.html ser servido pelo express.static.

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const express = require("express");
const { registerIndexRoutes } = require("../BotAPI/routes/indexRoutes");

async function runTests() {
	console.log("=== Teste da rota /status e /status.html ===");
	const pass = (req, res, next) => next();
	const app = express();
	const api = {
		app,
		bots: [],
		authenticateBasic: pass,
		isAdmin: () => true,
		setAdminSessionCookie: (res) => res.setHeader("X-Admin-Session-Renewed", "1"),
		clearAdminSessionCookie: () => {},
		readWebManagementToken: () => null,
		logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
		database: {},
		serviceProviderService: {}
	};
	registerIndexRoutes(api);

	const server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const baseUrl = `http://127.0.0.1:${server.address().port}`;

	try {
		for (const route of ["/status", "/status.html"]) {
			const res = await fetch(`${baseUrl}${route}`);
			const body = await res.text();
			assert.strictEqual(res.status, 200, `${route} deve responder 200`);
			assert.ok(/<html/i.test(body), `${route} deve servir o status.html`);
			assert.strictEqual(
				res.headers.get("x-admin-session-renewed"),
				"1",
				`${route} deve passar pela rota dedicada (sessão de admin renovada)`
			);
			assert.strictEqual(res.headers.get("cache-control"), "no-cache", `${route} sem cache`);
		}
		console.log("✓ /status e /status.html atendidos pela rota dedicada.");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste da rota de status:", err);
		process.exit(1);
	});
