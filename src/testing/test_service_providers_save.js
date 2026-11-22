// src/testing/test_service_providers_save.js
// ServiceProviderService.saveConfig: com service-providers.json ilegível a gravação é recusada
// (409) e o arquivo fica intacto; corpo que não é objeto é recusado (400); a gravação usa
// arquivo temporário + rename. Tudo num diretório temporário (o serviço lê do cwd).

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

async function runTests() {
	console.log("=== Teste da gravação do service-providers.json ===");
	const cwd = process.cwd();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "svc-providers-"));
	const file = path.join(tmp, "service-providers.json");
	const ServiceProviderService = require("../services/ServiceProviderService");
	let svc;
	try {
		process.chdir(tmp);
		const broken = '{ "llm": [ { "name": "principal", "apiKey": "chave-que-nao-pode-sumir" ';
		fs.writeFileSync(file, broken);
		svc = new ServiceProviderService();
		assert.ok(svc.loadError, "erro de sintaxe fica marcado");
		await assert.rejects(svc.saveConfig({ llm: [] }), (err) => {
			assert.strictEqual(err.statusCode, 409);
			assert.match(err.message, /está com erro/);
			return true;
		});
		assert.strictEqual(fs.readFileSync(file, "utf8"), broken, "arquivo com erro fica intacto");
		console.log("✓ Arquivo ilegível: o save é recusado (409) e nada é sobrescrito.");

		fs.writeFileSync(file, JSON.stringify({ llm: [{ name: "principal", apiKey: "k" }] }));
		svc.loadConfig();
		assert.strictEqual(svc.loadError, null, "arquivo corrigido limpa o erro");
		for (const bad of [null, [], "texto", 3]) {
			await assert.rejects(svc.saveConfig(bad), (err) => err.statusCode === 400);
		}
		const next = { llm: [{ name: "principal", apiKey: "k", enabled: false }], laya: [] };
		assert.strictEqual(await svc.saveConfig(next), true);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), next, "gravado");
		assert.deepStrictEqual(svc.getConfig(), next);
		assert.deepStrictEqual(
			fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp")),
			[],
			"sem temporário sobrando"
		);
		console.log("✓ Corpo inválido 400; gravação boa por temporário + rename.");

		// Simula bind mount de arquivo único no Docker: rename falha com EBUSY e cai para gravação direta.
		const origRename = fs.promises.rename;
		fs.promises.rename = async () => {
			const err = new Error("EBUSY: resource busy or locked");
			err.code = "EBUSY";
			throw err;
		};
		try {
			const fallbackCfg = { llm: [{ name: "principal", apiKey: "k", enabled: true }], laya: [] };
			assert.strictEqual(await svc.saveConfig(fallbackCfg), true);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), fallbackCfg);
			assert.deepStrictEqual(
				fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp")),
				[],
				"sem temporário sobrando após fallback EBUSY"
			);
			console.log("✓ Fallback de gravação direta quando rename retorna EBUSY (Docker bind mount).");
		} finally {
			fs.promises.rename = origRename;
		}
	} finally {
		if (svc && svc.watcher) svc.watcher.close();
		process.chdir(cwd);
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste do service-providers.json:", err);
		process.exit(1);
	});
