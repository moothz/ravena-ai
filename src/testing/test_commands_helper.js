// src/testing/test_commands_helper.js
// Catálogo dinâmico de comandos da IA de ajuda (CommandsHelper):
// - get_command_info / commands_helper não podem devolver o comando errado por casamento de tags
// - comandos restritos (!sa-, !admin-, hidden) nunca entram no catálogo

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const CommandsHelper = require("../utils/CommandsHelper");

const DETAILS_HEADER = "🤖 **Comando:**";

/**
 * Executa a tool get_command_info pelo dispatcher real do LLMService
 * @param {string} command
 * @returns {Promise<string>}
 */
async function runGetCommandInfo(command) {
	const LLMService = require("../services/LLMService");
	return LLMService.getInstance().executeToolCall("get_command_info", { command });
}

async function testTagQueriesDoNotReturnWrongCommand(helper) {
	console.log("\n[1] Termos que só batem em tags não podem virar o 1º comando do módulo...");
	// Antes: pesca/waifu -> !banco, fazenda -> !doar, figurinha -> !emojikitchen, download -> !pastas
	const cases = {
		pesca: { forbidden: "!banco", expectedModule: "FishingGame.js" },
		waifu: { forbidden: "!banco", expectedModule: "WaifuCommands.js" },
		fazenda: { forbidden: "!doar" },
		figurinha: { forbidden: "!emojikitchen", expectedModule: "Stickers.js" },
		download: { forbidden: "!pastas", expectedModule: "SocialMediaDownloader.js" }
	};

	for (const [query, { forbidden, expectedModule }] of Object.entries(cases)) {
		assert.strictEqual(
			helper.findCommandMeta(query, { exactOnly: true }),
			null,
			`"${query}" não é nome de comando: lookup exato deve retornar null`
		);

		const outputs = {
			getCommandDetails: helper.getCommandDetails(query),
			listCommandsQuery: helper.listCommands({ query }),
			listCommandsString: helper.listCommands(query),
			listCommandsCommand: helper.listCommands({ command: query }),
			toolGetCommandInfo: await runGetCommandInfo(query)
		};

		for (const [via, out] of Object.entries(outputs)) {
			assert.ok(
				!out.startsWith(DETAILS_HEADER),
				`${via}("${query}") não pode afirmar um comando específico. Saída: ${out.slice(0, 160)}`
			);
			assert.ok(
				!out.includes(`${DETAILS_HEADER} \`${forbidden}\``),
				`${via}("${query}") não pode devolver ${forbidden}`
			);
			assert.ok(
				out.includes("Resultados de Comandos e Ajuda") || out.includes("Nenhum comando"),
				`${via}("${query}") deve cair no search(). Saída: ${out.slice(0, 160)}`
			);
			if (expectedModule) {
				assert.ok(
					out.includes(`\`${expectedModule}\``),
					`${via}("${query}") deve listar ${expectedModule}. Saída: ${out.slice(0, 300)}`
				);
			}
		}
	}
	console.log("✓ pesca, waifu, fazenda, figurinha e download retornam busca, não comando errado.");
}

async function testExactLookupsStillWork(helper) {
	console.log("\n[2] Nomes e aliases exatos continuam retornando o comando certo...");
	const exact = {
		pescar: "!pescar",
		"!pescar": "!pescar",
		clima: "!clima",
		"g-addCmd": "!g-addCmd",
		addCmd: "!g-addCmd",
		s: "!sticker",
		"mu-roll": "!mu-roll",
		banco: "!banco"
	};
	for (const [query, expectedCmd] of Object.entries(exact)) {
		const meta = helper.findCommandMeta(query, { exactOnly: true });
		assert.ok(meta, `"${query}" deve ser encontrado exatamente`);
		assert.strictEqual(meta.cmd, expectedCmd, `"${query}" deve apontar para ${expectedCmd}`);

		const info = await runGetCommandInfo(query);
		assert.ok(
			info.startsWith(`${DETAILS_HEADER} \`${expectedCmd}\``),
			`get_command_info("${query}") deve detalhar ${expectedCmd}. Saída: ${info.slice(0, 120)}`
		);
	}
	console.log("✓ Lookups exatos (nome, alias de usage e prefixo g-) preservados.");

	// Compatibilidade: sem exactOnly o fallback por tag ainda existe para chamadores antigos
	assert.ok(helper.findCommandMeta("pesca"), "Fallback por tag continua disponível sem exactOnly");
}

function testRestrictedCommandsAreFiltered() {
	console.log("\n[3] Comandos !sa-/!admin-/hidden nunca entram no catálogo...");
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmdhelper-"));
	try {
		fs.writeFileSync(
			path.join(tmpDir, "FakeModule.js"),
			`const helper = {
	about: "Módulo falso para teste",
	implementation: "teste",
	tags: "teste,falso",
	cmds: [
		{ cmd: "!sa-joinGrupo", desc: "Entra em grupo (dono)", usage: ["!sa-joinGrupo link"], category: "geral" },
		{ cmd: "!admin-roubar", desc: "Admin interno", usage: ["!admin-roubar"], category: "geral" },
		{ cmd: "!segredo", desc: "Oculto por flag", usage: ["!segredo"], category: "geral", hidden: true },
		{ cmd: "!dono", desc: "Só superadmin", usage: ["!dono"], category: "geral", superAdminOnly: true },
		{ cmd: "!publico / !sa-publico", desc: "Alias restrito", usage: ["!publico"], category: "geral" },
		{ cmd: "!visivel", desc: "Comando comum", usage: ["!visivel"], category: "geral" }
	]
};
module.exports = { helper };
`
		);

		const isolated = new CommandsHelper();
		isolated.functionsPath = tmpDir;
		isolated.managementPath = path.join(tmpDir, "nao-existe.js");
		isolated.loadHelpers();

		const cmds = isolated.helpers.flatMap((h) => h.cmds.map((c) => c.cmd));
		assert.deepStrictEqual(cmds, ["!visivel"], `Somente !visivel deve sobrar. Obtido: ${cmds}`);

		const ctx = isolated.getBaseHelpContext();
		assert.ok(!/!sa-|admin-roubar|!segredo|!dono/i.test(ctx), "Contexto base sem restritos");
		assert.ok(ctx.includes("!visivel"), "Contexto base deve listar comandos comuns");

		for (const name of ["sa-joinGrupo", "!sa-joinGrupo", "admin-roubar", "segredo"]) {
			const details = isolated.getCommandDetails(name);
			assert.ok(
				!details.includes(DETAILS_HEADER) && !/!sa-|!admin-/i.test(details),
				`getCommandDetails(${name}) não pode expor restrito: ${details}`
			);
			assert.strictEqual(isolated.findCommandMeta(name), null, `${name} não pode ser indexado`);
		}
		assert.ok(!/!sa-/i.test(isolated.search("sa-joinGrupo")), "search não pode expor !sa-");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}

	// Catálogo real
	const real = CommandsHelper.getInstance();
	const realCtx = real.getBaseHelpContext();
	assert.ok(!/!sa-/i.test(realCtx), "Contexto base real NUNCA pode conter !sa-");
	const realCmds = real.helpers.flatMap((h) => h.cmds.map((c) => c.cmd));
	assert.ok(
		!realCmds.some((c) => /(^|\/)\s*!?(sa-|admin-)/i.test(c)),
		"Catálogo real sem !sa-/!admin-"
	);
	console.log("✓ Restritos filtrados no loadHelpers, no contexto base e no get_command_info.");
}

async function runTests() {
	console.log("=== Testes do CommandsHelper (catálogo da IA de ajuda) ===");
	const helper = CommandsHelper.getInstance();
	helper.loadHelpers();

	await testTagQueriesDoNotReturnWrongCommand(helper);
	await testExactLookupsStillWork(helper);
	testRestrictedCommandsAreFiltered();

	console.log("\n=== Todos os testes do CommandsHelper passaram! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes do CommandsHelper:", err);
		process.exit(1);
	});
