// src/testing/test_auth_admin_bot_routes.js
// Rotas com :botId (reiniciar, sair da sessão, QR) aceitam o admin geral (cookie da sessão do
// painel ou usuário da API) e continuam aceitando a credencial própria da instância.

const assert = require("assert");
const express = require("express");
const { createAuthenticateBasic, createAdminSessionToken } = require("../BotAPI/middleware/auth");

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

async function runTests() {
	console.log("=== Autenticação nas rotas de instância ===");
	const api = {
		apiUser: "admin",
		apiPassword: "senha-admin",
		bots: [{ id: "bot-com-gestor", managementUser: "gestor", managementPW: "senha-gestor" }],
		logger: { debug() {}, error() {} }
	};
	const auth = createAuthenticateBasic(api);
	const app = express();
	app.get("/restart/:botId", auth, (req, res) => res.json({ ok: true }));
	app.get("/geral", auth, (req, res) => res.json({ ok: true }));

	const server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const base = `http://127.0.0.1:${server.address().port}`;
	const get = (path, headers = {}) => fetch(base + path, { headers });
	const cookie = `ravena_admin_session=${encodeURIComponent(createAdminSessionToken(api))}`;

	try {
		assert.strictEqual((await get("/restart/bot-com-gestor", { Cookie: cookie })).status, 200);
		console.log("✓ sessão do painel reinicia instância que tem gestor próprio");

		assert.strictEqual(
			(await get("/restart/bot-com-gestor", { Authorization: basic("admin", "senha-admin") }))
				.status,
			200
		);
		console.log("✓ usuário da API também");

		assert.strictEqual(
			(await get("/restart/bot-com-gestor", { Authorization: basic("gestor", "senha-gestor") }))
				.status,
			200
		);
		console.log("✓ a credencial da própria instância continua valendo");

		const outro = await get("/restart/bot-com-gestor", {
			Authorization: basic("gestor", "errada")
		});
		assert.strictEqual(outro.status, 401);
		assert.ok(outro.headers.get("www-authenticate"));
		console.log("✓ credencial errada continua recusada");

		assert.strictEqual((await get("/restart/bot-com-gestor")).status, 401);
		assert.strictEqual(
			(await get("/restart/bot-com-gestor", { Cookie: "ravena_admin_session=1.abc" })).status,
			401
		);
		console.log("✓ sem credencial ou com cookie forjado: 401");

		assert.strictEqual((await get("/geral", { Cookie: cookie })).status, 200);
		console.log("✓ rotas sem :botId seguem iguais");
		console.log("\nTodos os testes passaram.");
	} finally {
		server.close();
	}
}

runTests().catch((err) => {
	console.error(err);
	process.exit(1);
});
