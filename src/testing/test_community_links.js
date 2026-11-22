// src/testing/test_community_links.js
// Testa o helper getCommunityLinks, o endpoint /health e os redirecionamentos da BotAPI

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const express = require("express");
const { getCommunityLinks } = require("../utils/communityLinks");
const { registerIndexRoutes } = require("../BotAPI/routes/indexRoutes");

async function main() {
	console.log("=== Iniciando Testes de Links de Comunidade e Redirecionamentos ===");

	// 1. Testa a integridade do getCommunityLinks()
	console.log("\n[1] Testando getCommunityLinks()...");
	const links = getCommunityLinks();
	const requiredKeys = [
		"community",
		"grupao",
		"channel",
		"telegramBot",
		"telegramCommunity",
		"discordBot",
		"discordCommunity",
		"creator",
		"github",
		"donation"
	];

	for (const key of requiredKeys) {
		assert.ok(links[key], `A chave '${key}' deve estar presente e não vazia.`);
		assert.strictEqual(typeof links[key], "string", `A chave '${key}' deve ser uma string.`);
		assert.ok(
			links[key].startsWith("http"),
			`A chave '${key}' deve ser uma URL válida iniciando com http(s).`
		);
	}
	console.log("✓ getCommunityLinks() retornou todas as 10 chaves com URLs válidas.");

	// 2. Testa override por variável de ambiente
	console.log("\n[2] Testando overrides via .env...");
	const originalCommunity = process.env.LINK_COMUNIDADE;
	process.env.LINK_COMUNIDADE = "https://chat.whatsapp.com/TESTE123OVERRIDE";
	const overridden = getCommunityLinks();
	assert.strictEqual(overridden.community, "https://chat.whatsapp.com/TESTE123OVERRIDE");
	process.env.LINK_COMUNIDADE = originalCommunity;
	console.log("✓ Override de variável de ambiente funciona corretamente.");

	// 3. Testa rotas na BotAPI
	console.log("\n[3] Testando rotas na BotAPI...");
	const app = express();
	app.use(express.json());

	const api = {
		app,
		bots: [],
		authenticateBasic: (req, res, next) => next(),
		strictLimiter: (req, res, next) => next(),
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
		// Teste /health
		const healthRes = await fetch(`${baseUrl}/health`);
		assert.strictEqual(healthRes.status, 200);
		const healthJson = await healthRes.json();
		assert.ok(healthJson.communityLinks, "O endpoint /health deve conter communityLinks.");
		assert.strictEqual(
			healthJson.communityLinks.community,
			links.community,
			"O link de comunidade no /health deve coincidir com getCommunityLinks."
		);
		console.log("✓ /health expõe communityLinks com sucesso.");

		// Teste /api/community-links
		const apiLinksRes = await fetch(`${baseUrl}/api/community-links`);
		assert.strictEqual(apiLinksRes.status, 200);
		const apiLinksJson = await apiLinksRes.json();
		assert.deepStrictEqual(
			apiLinksJson,
			links,
			"/api/community-links deve coincidir com getCommunityLinks."
		);
		console.log("✓ /api/community-links responde 200 com JSON idêntico a getCommunityLinks.");

		// Teste redirecionamentos (fetch com redirect: 'manual')
		const routesToTest = [
			{ path: "/comunidade", expected: links.community },
			{ path: "/community", expected: links.community },
			{ path: "/grupao", expected: links.grupao },
			{ path: "/canal", expected: links.channel },
			{ path: "/discord", expected: links.discordBot },
			{ path: "/discord-server", expected: links.discordCommunity },
			{ path: "/telegram", expected: links.telegramBot },
			{ path: "/telegram-grupo", expected: links.telegramCommunity },
			{ path: "/criador", expected: links.creator },
			{ path: "/github", expected: links.github },
			{ path: "/doar", expected: links.donation }
		];

		for (const route of routesToTest) {
			const res = await fetch(`${baseUrl}${route.path}`, { redirect: "manual" });
			assert.strictEqual(
				res.status,
				302,
				`A rota '${route.path}' deve responder com redirect 302 (recebido: ${res.status}).`
			);
			const location = res.headers.get("location");
			assert.strictEqual(
				location,
				route.expected,
				`A rota '${route.path}' deve redirecionar para '${route.expected}' (recebido: '${location}').`
			);
		}
		console.log(
			"✓ Todas as 11 rotas de redirecionamento funcionam perfeitamente (HTTP 302 -> URL correta)."
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}

	console.log("\n=== Todos os Testes de Links de Comunidade Passaram com Sucesso! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Falha nos testes:", err);
		process.exit(1);
	});
