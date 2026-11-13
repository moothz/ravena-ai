// src/testing/test_status_link.js
// !status deve trazer o link completo (com https://) da página de status, para que
// Discord e Telegram também o transformem em link clicável.

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const axios = require("axios");
const GeneralCommands = require("../functions/GeneralCommands");
const { createMessage } = require("./FakeMessage");

async function runStatus() {
	const statusCmd = GeneralCommands.commands.find((c) => c.name === "status");
	assert.ok(statusCmd, "Comando !status deve existir");
	const msg = createMessage({ content: "!status", group: "120363000000777@g.us" });
	const res = await statusCmd.method(null, msg, [], null);
	return String(res?.content || "");
}

async function runTests() {
	console.log("=== Teste do link de status no !status ===");
	const originalGet = axios.get;
	const originalDomain = process.env.BOT_DOMAIN;
	axios.get = async () => ({ data: { bots: [] } });

	try {
		delete process.env.BOT_DOMAIN;
		let content = await runStatus();
		assert.ok(
			content.includes("> https://ravena.moothz.com/status\n"),
			`Sem BOT_DOMAIN deve usar https://ravena.moothz.com/status. Conteúdo: ${content.slice(0, 120)}`
		);
		assert.ok(!/(^|\s)ravena\.moothz\.com\/status/.test(content), "Sem link sem protocolo");

		process.env.BOT_DOMAIN = "https://exemplo.dev/rv/";
		content = await runStatus();
		assert.ok(
			content.includes("> https://exemplo.dev/rv/status\n"),
			`Deve respeitar BOT_DOMAIN (sem barra dupla). Conteúdo: ${content.slice(0, 120)}`
		);
		console.log("✓ Link de status com https:// e respeitando BOT_DOMAIN.");
	} finally {
		axios.get = originalGet;
		if (originalDomain === undefined) delete process.env.BOT_DOMAIN;
		else process.env.BOT_DOMAIN = originalDomain;
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste do link de status:", err);
		process.exit(1);
	});
