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
	await testSameOrigin();
}

async function testSameOrigin() {
	const app = express();
	app.use(security.createSameOriginGuard({ hasCredentials: (req) => !!req.headers.cookie }));
	app.post("/escrever", (req, res) => res.json({ ok: true }));
	app.get("/restart/:botId", (req, res) => res.json({ ok: true }));
	app.get("/ler", (req, res) => res.json({ ok: true }));

	await withServer(app, async (base) => {
		const host = new URL(base).host;
		const cookie = { Cookie: "ravena_admin_session=x" };
		const cases = [
			// [descrição, método, caminho, cabeçalhos, status esperado]
			[
				"POST sem cookie de outro site (webhook/API pública)",
				"POST",
				"/escrever",
				{ Origin: "https://evil.example" },
				200
			],
			["POST com cookie da mesma origem", "POST", "/escrever", { ...cookie, Origin: base }, 200],
			[
				"POST com cookie e Sec-Fetch-Site same-origin",
				"POST",
				"/escrever",
				{ ...cookie, "Sec-Fetch-Site": "same-origin" },
				200
			],
			["POST com cookie sem Origin (curl/servidor)", "POST", "/escrever", cookie, 200],
			[
				"POST com cookie vindo de outro site",
				"POST",
				"/escrever",
				{ ...cookie, Origin: "https://evil.example" },
				403
			],
			[
				"POST com cookie e Sec-Fetch-Site cross-site",
				"POST",
				"/escrever",
				{ ...cookie, "Sec-Fetch-Site": "cross-site" },
				403
			],
			[
				"GET /restart da mesma origem (tela /instances)",
				"GET",
				"/restart/bot1",
				{ ...cookie, "Sec-Fetch-Site": "same-origin" },
				200
			],
			[
				"GET /restart digitado na barra de endereço",
				"GET",
				"/restart/bot1",
				{ ...cookie, "Sec-Fetch-Site": "none" },
				200
			],
			[
				"GET /restart puxado por outro site",
				"GET",
				"/restart/bot1",
				{ ...cookie, "Sec-Fetch-Site": "cross-site" },
				403
			],
			[
				"GET de leitura vindo de outro site",
				"GET",
				"/ler",
				{ ...cookie, "Sec-Fetch-Site": "cross-site" },
				200
			]
		];
		for (const [desc, method, path, headers, expected] of cases) {
			const res = await fetch(`${base}${path}`, { method, headers: { Host: host, ...headers } });
			assert.strictEqual(res.status, expected, `${desc}: esperado ${expected}, veio ${res.status}`);
		}
	});
	console.log("✓ Escritas com credencial vindas de outro site são recusadas; o resto passa.");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste de segurança:", err);
		process.exit(1);
	});
