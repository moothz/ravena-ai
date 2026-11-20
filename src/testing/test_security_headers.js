// src/testing/test_security_headers.js
// Cabeçalhos e checagens de src/BotAPI/middleware/security.js.

const assert = require("assert");
const express = require("express");
const security = require("../BotAPI/middleware/security");

async function withServer(app, fn) {
	const server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	try {
		await fn(`http://127.0.0.1:${server.address().port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

async function testFrameAncestors() {
	const app = express();
	app.use(security.createFrameAncestorsGuard());
	app.get("/x", (req, res) => res.send("ok"));
	await withServer(app, async (base) => {
		const res = await fetch(`${base}/x`);
		assert.strictEqual(res.headers.get("content-security-policy"), "frame-ancestors 'self'");
		assert.strictEqual(res.headers.get("x-frame-options"), "SAMEORIGIN");
	});
	console.log("✓ frame-ancestors 'self' e X-Frame-Options em toda resposta.");
}

async function runTests() {
	console.log("=== Teste dos cabeçalhos de segurança ===");
	await testFrameAncestors();
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste de segurança:", err);
		process.exit(1);
	});
