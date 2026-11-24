process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");
const express = require("express");
const { createFrameAncestorsGuard } = require("../BotAPI/middleware/security");
const { registerIndexRoutes } = require("../BotAPI/routes/indexRoutes");

const ADMIN_DIR = path.join(__dirname, "../../public/admin");
const ADMIN_HEADERS = { "X-Test-Admin": "1" };

function createApp() {
	const app = express();
	app.use(createFrameAncestorsGuard());
	registerIndexRoutes({
		app,
		bots: [],
		authenticateBasic: (req, res, next) =>
			req.headers["x-test-admin"] === "1" ? next() : res.status(401).json({ status: "error" }),
		isAdmin: (req) => req.headers["x-test-admin"] === "1",
		setAdminSessionCookie: () => {},
		clearAdminSessionCookie: () => {},
		readWebManagementToken: () => null,
		logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
		database: {},
		serviceProviderService: {}
	});
	return app;
}

const parsePolicy = (header) =>
	Object.fromEntries(
		String(header)
			.split(";")
			.map((d) => d.trim().split(/\s+/))
			.map(([name, ...sources]) => [name, sources])
	);

const tagsOf = (html, name) =>
	[...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "g"))].map((m) => m[1]);
const attrOf = (attrs, name) => (attrs.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];

async function testHeaders(base) {
	for (const route of ["/admin", "/admin/", "/admin.html"]) {
		const res = await fetch(`${base}${route}`, { headers: ADMIN_HEADERS });
		assert.deepStrictEqual(
			parsePolicy(res.headers.get("content-security-policy")),
			{
				"default-src": ["'none'"],
				"script-src": ["'self'"],
				"style-src": ["'self'"],
				"img-src": ["'self'", "data:"],
				"font-src": ["'self'"],
				"connect-src": ["'self'"],
				"base-uri": ["'none'"],
				"form-action": ["'none'"],
				"frame-ancestors": ["'self'"]
			},
			`${route}: política do painel`
		);
		assert.strictEqual(res.headers.get("x-frame-options"), "SAMEORIGIN", `${route}: X-Frame`);
	}
	const legacy = [
		"/status",
		"/classic",
		"/admin/core.js",
		"/instances?legado=1",
		"/banco/admin?legado=1",
		"/eventos/admin?legado=1"
	];
	for (const route of legacy) {
		const res = await fetch(`${base}${route}`, { headers: ADMIN_HEADERS });
		assert.strictEqual(res.status, 200, `${route} responde`);
		assert.strictEqual(
			res.headers.get("content-security-policy"),
			"frame-ancestors 'self'",
			`${route}: fora do /admin a política não muda`
		);
	}
	console.log("✓ /admin com a CSP do painel; as outras telas só com frame-ancestors.");
}

async function testHtml(base, html) {
	for (const attrs of tagsOf(html, "script")) {
		assert.ok(attrOf(attrs, "src"), `script inline no HTML do painel: <script${attrs}>`);
	}
	assert.ok(!/<style\b/.test(html), "sem <style> no HTML");
	assert.ok(!/<[^>]+\s(on[a-z]+|style)=/.test(html), "sem handler nem style inline no HTML");

	const urls = [
		...tagsOf(html, "script").map((a) => attrOf(a, "src")),
		...tagsOf(html, "link").map((a) => attrOf(a, "href"))
	];
	for (const url of urls) {
		assert.ok(/^\/(?!\/)/.test(url), `recurso de fora do servidor: ${url}`);
		const res = await fetch(`${base}${url}`);
		assert.strictEqual(res.status, 200, `${url} servido pela Ravena`);
	}

	const styles = fs.readdirSync(ADMIN_DIR, { recursive: true }).filter((f) => f.endsWith(".css"));
	assert.ok(styles.length > 0);
	for (const file of styles) {
		const css = fs.readFileSync(path.join(ADMIN_DIR, file), "utf8");
		assert.ok(!/(https?:)?\/\/[a-z0-9-]+\./i.test(css), `${file} sem recurso externo`);
	}
	console.log("✓ HTML e CSS do painel sem código inline nem recurso de fora.");
}

async function testFonts(base, html) {
	const sheets = tagsOf(html, "link").filter((a) => attrOf(a, "rel") === "stylesheet");
	const faces = [];
	for (const attrs of sheets) {
		const href = attrOf(attrs, "href");
		if (!href.startsWith("/")) continue;
		const css = await (await fetch(`${base}${href}`)).text();
		for (const [, body] of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
			const [min, max = min] = body
				.match(/font-weight:\s*([\d ]+);/)[1]
				.split(" ")
				.map(Number);
			faces.push({
				family: body.match(/font-family:\s*"([^"]+)"/)[1],
				min,
				max,
				url: body.match(/url\("([^"]+)"\)/)[1]
			});
		}
	}
	const expected = { Figtree: [400, 500, 600], "IBM Plex Mono": [400, 500] };
	for (const [family, weights] of Object.entries(expected)) {
		for (const weight of weights) {
			assert.ok(
				faces.some((f) => f.family === family && f.min <= weight && weight <= f.max),
				`${family} ${weight} sem fonte local`
			);
		}
	}
	for (const { url } of faces) {
		const res = await fetch(new URL(url, base));
		assert.strictEqual(res.status, 200, `${url} servido pela Ravena`);
		assert.strictEqual(res.headers.get("content-type"), "font/woff2", `${url}: tipo`);
		const data = Buffer.from(await res.arrayBuffer());
		assert.strictEqual(data.toString("latin1", 0, 4), "wOF2", `${url}: assinatura woff2`);
		assert.strictEqual(data.readUInt32BE(8), data.length, `${url}: arquivo inteiro`);
	}
	console.log("✓ Figtree e IBM Plex Mono servidas pela Ravena, nos pesos que o painel usa.");
}

async function testTheme(base, html) {
	let code = "";
	for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
		if (attrOf(m[1], "type") === "module") continue;
		const src = attrOf(m[1], "src");
		code += src ? await (await fetch(`${base}${src}`)).text() : m[2];
	}
	const themeOf = (search, saved) => {
		const dataset = {};
		const localStorage = {
			getItem: (key) => {
				if (saved instanceof Error) throw saved;
				return key === "ravena-admin-theme" ? saved : null;
			}
		};
		vm.runInNewContext(code, {
			URLSearchParams,
			location: { search },
			localStorage,
			document: { documentElement: { dataset } }
		});
		return dataset.theme;
	};
	assert.strictEqual(themeOf("", "dark"), "dark", "tema salvo");
	assert.strictEqual(themeOf("?theme=light", "dark"), "light", "?theme= vence o salvo");
	assert.strictEqual(themeOf("?theme=xyz", "light"), "light", "?theme= inválido é ignorado");
	assert.strictEqual(themeOf("", "xyz"), undefined, "tema salvo inválido é ignorado");
	assert.strictEqual(themeOf("", null), undefined, "sem escolha, segue o sistema");
	assert.strictEqual(themeOf("", new Error("bloqueado")), undefined, "sem localStorage");
	console.log("✓ Tema aplicado antes da tela, sem script inline.");
}

async function testKitStyle() {
	global.Node = class {};
	global.document = {
		createElement: () => ({
			style: {},
			attrs: {},
			setAttribute(k, v) {
				this.attrs[k] = v;
			}
		}),
		addEventListener: () => {}
	};
	const { h } = await import(pathToFileURL(path.join(ADMIN_DIR, "core.js")).href);
	const el = h("i", { class: "barra", style: "width:25%" });
	assert.strictEqual(el.style.cssText, "width:25%", "h() aplica o estilo");
	assert.deepStrictEqual(el.attrs, { class: "barra" }, "atributo style é barrado pela CSP");
	console.log("✓ h() aplica style sem o atributo que a CSP barra.");
}

async function runTests() {
	console.log("=== Teste da CSP do /admin ===");
	const server = await new Promise((resolve) => {
		const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
	});
	const base = `http://127.0.0.1:${server.address().port}`;
	const html = await (await fetch(`${base}/admin`, { headers: ADMIN_HEADERS })).text();
	let failures = 0;
	for (const test of [testHeaders, testHtml, testFonts, testTheme, testKitStyle]) {
		try {
			await test(base, html);
		} catch (err) {
			failures++;
			console.error(`❌ ${test.name}:`, err.message);
		}
	}
	assert.strictEqual(failures, 0, `${failures} teste(s) da CSP falharam`);
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste da CSP do /admin:", err.message);
		process.exit(1);
	});
