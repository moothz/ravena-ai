// src/testing/test_admin_route.js
// /admin (painel unificado, experimental): exige admin, renova a sessão, não é servido
// pelo express.static (nem como /admin/ nem como /admin.html) e troca o ?v= dos assets.

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const express = require("express");
const { registerIndexRoutes } = require("../BotAPI/routes/indexRoutes");

async function runTests() {
	console.log("=== Teste da rota /admin ===");
	const app = express();
	// Autenticação de mentira: só passa com o cabeçalho X-Test-Admin.
	const authenticateBasic = (req, res, next) => {
		if (req.headers["x-test-admin"] === "1") return next();
		return res.status(401).json({ status: "error", message: "Autenticação requerida" });
	};
	const api = {
		app,
		bots: [],
		authenticateBasic,
		isAdmin: (req) => req.headers["x-test-admin"] === "1",
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
		for (const route of ["/admin", "/admin/", "/admin.html"]) {
			const anon = await fetch(`${baseUrl}${route}`, { redirect: "manual" });
			assert.strictEqual(anon.status, 401, `${route} sem credenciais deve responder 401`);

			const res = await fetch(`${baseUrl}${route}`, { headers: { "X-Test-Admin": "1" } });
			const body = await res.text();
			assert.strictEqual(res.status, 200, `${route} deve responder 200`);
			assert.ok(/<title>Ravena Admin<\/title>/.test(body), `${route} deve servir o admin.html`);
			assert.strictEqual(
				res.headers.get("x-admin-session-renewed"),
				"1",
				`${route} renova a sessão`
			);
			assert.strictEqual(res.headers.get("cache-control"), "no-cache", `${route} sem cache`);
			assert.ok(!/admin\.js\?v=1"/.test(body), `${route} deve versionar o admin.js pelo mtime`);
		}
		console.log("✓ /admin, /admin/ e /admin.html exigem admin e passam pela rota dedicada.");

		// Caminhos codificados ou com barra dupla não podem entregar o HTML do painel sem login
		for (const sneaky of [
			"/%61dmin.html",
			"/admin%2ehtml",
			"//admin.html",
			"/%61dmin/",
			"/ADMIN.html"
		]) {
			const res = await fetch(`${baseUrl}${sneaky}`, { redirect: "manual" });
			const body = await res.text();
			assert.ok(
				!/<title>Ravena Admin<\/title>/.test(body),
				`${sneaky} sem credenciais não pode servir o painel (status ${res.status})`
			);
		}
		console.log("✓ Caminhos codificados não expõem o HTML do painel.");

		const css = await fetch(`${baseUrl}/admin/tokens.css`);
		assert.strictEqual(css.status, 200, "os assets do painel continuam estáticos");
		console.log("✓ Assets em /admin/*.css servidos pelo express.static.");

		for (const legacy of ["/classic", "/status"]) {
			const res = await fetch(`${baseUrl}${legacy}`);
			assert.strictEqual(res.status, 200, `${legacy} continua no ar`);
		}
		console.log("✓ Telas antigas continuam respondendo.");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste da rota /admin:", err);
		process.exit(1);
	});
