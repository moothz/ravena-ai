// src/testing/test_strict_limiter_admin.js
// O strictLimiter (10 req/min por IP) não deve contar requisições de admin autenticado,
// mas continua valendo para os demais.

const assert = require("assert");
const express = require("express");
const { createRateLimiters } = require("../BotAPI/middleware/rateLimiters");

async function runTests() {
	console.log("=== Teste do strictLimiter com admin ===");
	const { strictLimiter } = createRateLimiters({
		isAdmin: (req) => req.headers["x-test-admin"] === "1"
	});
	const app = express();
	app.get("/pesada", strictLimiter, (req, res) => res.json({ ok: true }));

	const server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const url = `http://127.0.0.1:${server.address().port}/pesada`;

	try {
		for (let i = 0; i < 15; i++) {
			const res = await fetch(url, { headers: { "X-Test-Admin": "1" } });
			assert.strictEqual(res.status, 200, `admin, requisição ${i + 1} deve passar`);
		}
		console.log("✓ 15 requisições de admin seguidas passam.");

		const statuses = [];
		for (let i = 0; i < 11; i++) {
			statuses.push((await fetch(url)).status);
		}
		assert.deepStrictEqual(statuses.slice(0, 10), Array(10).fill(200), "as 10 primeiras passam");
		assert.strictEqual(statuses[10], 429, "a 11ª requisição anônima é limitada");
		console.log("✓ Sem admin, o limite de 10/min continua valendo.");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste do strictLimiter:", err);
		process.exit(1);
	});
