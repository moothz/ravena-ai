// src/testing/test_admin_route.js
// /admin (painel unificado, experimental): exige admin, renova a sessão, não é servido
// pelo express.static (nem como /admin/ nem como /admin.html) e troca o ?v= dos assets.
// Também: módulos ES do painel (MIME e cache), GET /api/admin/links (com e sem .env) e o
// redirecionamento das telas antigas (LEGACY_ADMIN_REDIRECTS, ?legado=1, ?auth=).

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const express = require("express");
const { registerIndexRoutes, LEGACY_ADMIN_REDIRECTS } = require("../BotAPI/routes/indexRoutes");
const { registerAdminRoutes, buildAdminLinks } = require("../BotAPI/routes/adminRoutes");

const LINK_ENV = [
	"ADMIN_GRAFANA_URL",
	"WAIFULETES_ADMIN_URL",
	"WAIFULETES_WEB_URL",
	"JARDIM_SUPERADMIN_URL"
];

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
	registerAdminRoutes(api);

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
			assert.ok(!/app\.js\?v=1"/.test(body), `${route} deve versionar o app.js pelo mtime`);
			assert.ok(
				/<script type="module" src="\/admin\/app\.js\?v=/.test(body),
				`${route} carrega o app.js como módulo ES`
			);
			assert.ok(!/maximum-scale/.test(body), `${route} não trava o zoom do celular`);
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

		// Módulos ES: MIME de JavaScript (senão o navegador recusa o import) e revalidação
		// sempre (são importados sem ?v=, então não podem ficar 1 dia no cache).
		for (const mod of [
			"/admin/app.js",
			"/admin/core.js",
			"/admin/lib.js",
			"/admin/areas/geral.js"
		]) {
			const res = await fetch(`${baseUrl}${mod}`);
			assert.strictEqual(res.status, 200, `${mod} servido`);
			assert.ok(
				/^(text|application)\/javascript/.test(res.headers.get("content-type") || ""),
				`${mod} com MIME de JavaScript (veio ${res.headers.get("content-type")})`
			);
			assert.strictEqual(res.headers.get("cache-control"), "no-cache", `${mod} revalida sempre`);
		}
		const versioned = await fetch(`${baseUrl}/admin/app.js?v=abc`);
		assert.strictEqual(
			versioned.headers.get("cache-control"),
			"no-cache",
			"módulo do admin revalida mesmo com ?v="
		);
		const other = await fetch(`${baseUrl}/banco.js?v=abc`);
		assert.ok(
			/max-age=604800/.test(other.headers.get("cache-control") || ""),
			"assets de fora do admin mantêm o cache de 7 dias com ?v="
		);
		console.log("✓ Módulos do /admin com MIME de JavaScript e sem cache longo.");

		// GET /api/admin/links: exige admin; lê do .env a cada pedido
		const saved = Object.fromEntries(LINK_ENV.map((k) => [k, process.env[k]]));
		try {
			const anonLinks = await fetch(`${baseUrl}/api/admin/links`);
			assert.strictEqual(anonLinks.status, 401, "/api/admin/links sem credenciais → 401");

			for (const k of LINK_ENV) delete process.env[k];
			let res = await fetch(`${baseUrl}/api/admin/links`, { headers: { "X-Test-Admin": "1" } });
			assert.strictEqual(res.status, 200);
			let d = await res.json();
			assert.strictEqual(d.grafana.base, null, "sem ADMIN_GRAFANA_URL, base null");
			assert.strictEqual(d.grafana.missing, "ADMIN_GRAFANA_URL");
			assert.strictEqual(d.grafana.dashboards.economia.url, null);
			assert.ok(
				d.panels.every((p) => p.url === null && p.missing),
				"sem .env, todos os painéis desabilitados com a variável que falta"
			);
			assert.deepStrictEqual(
				d.panels.map((p) => p.id),
				["economia", "red", "llm", "waifuletes", "jardim"]
			);

			process.env.ADMIN_GRAFANA_URL = "https://grafana.exemplo/";
			process.env.WAIFULETES_WEB_URL = "https://waifu.exemplo";
			process.env.JARDIM_SUPERADMIN_URL = "https://jardim.exemplo/super-admin";
			res = await fetch(`${baseUrl}/api/admin/links`, { headers: { "X-Test-Admin": "1" } });
			d = await res.json();
			assert.strictEqual(d.grafana.base, "https://grafana.exemplo", "barra final removida");
			assert.strictEqual(
				d.grafana.dashboards.economia.url,
				"https://grafana.exemplo/d/ravena-economia"
			);
			assert.strictEqual(
				d.grafana.dashboards.jogador.url,
				"https://grafana.exemplo/d/ravena-jogador"
			);
			assert.strictEqual(d.grafana.dashboards.red.url, "https://grafana.exemplo/d/ravena-red");
			assert.strictEqual(d.grafana.dashboards.llm.url, "https://grafana.exemplo/d/ravena-llm");
			const byId = Object.fromEntries(d.panels.map((p) => [p.id, p]));
			assert.strictEqual(
				byId.waifuletes.url,
				"https://waifu.exemplo/admin",
				"padrão: WEB_URL + /admin"
			);
			assert.strictEqual(byId.jardim.url, "https://jardim.exemplo/super-admin");
			assert.ok(d.panels.every((p) => p.missing === null));

			process.env.WAIFULETES_ADMIN_URL = "https://waifu.exemplo/painel";
			assert.strictEqual(
				buildAdminLinks(process.env).panels.find((p) => p.id === "waifuletes").url,
				"https://waifu.exemplo/painel",
				"WAIFULETES_ADMIN_URL vence o padrão"
			);
			const bad = buildAdminLinks({
				ADMIN_GRAFANA_URL: "javascript:alert(1)",
				JARDIM_SUPERADMIN_URL: "https://u:senha@jardim.exemplo"
			});
			assert.strictEqual(bad.grafana.base, null, "só http(s)");
			assert.strictEqual(
				bad.panels.find((p) => p.id === "jardim").url,
				null,
				"endereço com credencial embutida é recusado"
			);
		} finally {
			for (const k of LINK_ENV) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
		}
		console.log("✓ /api/admin/links: autenticação, sem .env (desabilitado) e com .env.");

		// Redirecionamento das telas antigas: todas as áreas já são nativas no /admin
		assert.deepStrictEqual(LEGACY_ADMIN_REDIRECTS, {
			"/instances": "instancias",
			"/banco/admin": "banco",
			"/eventos/admin": "eventos",
			"/service-providers": "provedores",
			"/dossies": "pessoas",
			"/groups-dossier": "pessoas/grupos"
		});
		try {
			const cases = [
				["/groups-dossier", "/admin#/pessoas/grupos"],
				["/groups-dossier.html", "/admin#/pessoas/grupos"],
				["/groups-dossier/", "/admin#/pessoas/grupos"],
				["/banco/admin", "/admin#/banco"],
				["/ravenabank/admin", "/admin#/banco"],
				["/banco-admin.html", "/admin#/banco"],
				["/instances", "/admin#/instancias"],
				["/instances.html?x=1", "/admin#/instancias"],
				["/banco/admin?auth=YWRtaW46c2VuaGE%3D", "/admin?auth=YWRtaW46c2VuaGE%3D#/banco"],
				["/eventos/admin", "/admin#/eventos"],
				["/events/admin", "/admin#/eventos"],
				["/service-providers", "/admin#/provedores"],
				["/dossies", "/admin#/pessoas"],
				["/dossie", "/admin#/pessoas"]
			];
			for (const [from, to] of cases) {
				const res = await fetch(`${baseUrl}${from}`, { redirect: "manual" });
				assert.strictEqual(res.status, 302, `${from} → 302`);
				assert.strictEqual(res.headers.get("location"), to, `${from} → ${to}`);
			}
			for (const escape of [
				"/groups-dossier?legado=1",
				"/banco/admin?legado=1&auth=x",
				"/instances?embed=1"
			]) {
				const res = await fetch(`${baseUrl}${escape}`, {
					redirect: "manual",
					headers: { "X-Test-Admin": "1" }
				});
				assert.strictEqual(res.status, 200, `${escape} continua servindo a tela antiga`);
			}
			const post = await fetch(`${baseUrl}/instances`, { method: "POST", redirect: "manual" });
			assert.notStrictEqual(post.status, 302, "só GET/HEAD são redirecionados");
			const untouched = await fetch(`${baseUrl}/classic`, { redirect: "manual" });
			assert.notStrictEqual(untouched.status, 302, "telas fora do mapa não mudam");
		} finally {
			/* o mapa é o de produção: nada a desfazer */
		}
		console.log("✓ Telas antigas do mapa vão para /admin#/<área> (com ?auth=); ?legado=1 mantém.");

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
