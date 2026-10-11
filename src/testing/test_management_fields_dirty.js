"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function main() {
	console.log("=== Iniciando teste de detecção de alterações do /manage ===");

	const managementJsPath = path.join(__dirname, "../../public/management.js");
	const managementRoutesPath = path.join(__dirname, "../BotAPI/routes/managementRoutes.js");

	const managementJs = fs.readFileSync(managementJsPath, "utf8");
	const managementRoutes = fs.readFileSync(managementRoutesPath, "utf8");

	// 1. Validar que managementRoutes usa 'roleta' e NÃO 'roleta_russa'
	console.log("1. Verificando persistência de banco de dados em managementRoutes.js...");
	assert.doesNotMatch(
		managementRoutes,
		/["']roleta_russa["']/,
		"managementRoutes.js não deve fazer chamadas ao banco inexistente 'roleta_russa'"
	);
	assert.match(
		managementRoutes,
		/dbGet\(\s*["']roleta["'],\s*["']SELECT timeout_time, silenciar FROM roleta_groups/,
		"managementRoutes.js deve buscar configurações de roleta no banco 'roleta'"
	);
	assert.match(
		managementRoutes,
		/dbRun\(\s*["']roleta["'],\s*`INSERT INTO roleta_groups/,
		"managementRoutes.js deve salvar configurações de roleta no banco 'roleta'"
	);
	console.log("✓ managementRoutes.js corrigido e validado com o banco 'roleta'.");

	// 2. Extrair e testar formatMinecraftServer e parseMinecraftServerInput
	console.log("2. Testando formatMinecraftServer e parseMinecraftServerInput...");
	// Extrair formatMinecraftServer do management.js
	const formatMatch = managementJs.match(
		/function formatMinecraftServer\(server\) \{([\s\S]*?)\n {4}\}/
	);
	assert.ok(formatMatch, "Função formatMinecraftServer deve existir em management.js");
	const formatMinecraftServer = new Function("server", formatMatch[1]);

	// Extrair parseMinecraftServerInput do management.js
	const parseMatch = managementJs.match(
		/function parseMinecraftServerInput\(rawValue\) \{([\s\S]*?)\n {4}\}/
	);
	assert.ok(parseMatch, "Função parseMinecraftServerInput deve existir em management.js");
	const parseMinecraftServerInput = new Function("rawValue", parseMatch[1]);

	// Formatação omitindo 25565
	assert.strictEqual(
		formatMinecraftServer({ host: "play.exemplo.com", port: 25565 }),
		"play.exemplo.com",
		"Porta padrão 25565 deve ser omitida na formatação de exibição"
	);
	assert.strictEqual(
		formatMinecraftServer({ host: "play.exemplo.com", port: 25300 }),
		"play.exemplo.com:25300",
		"Porta não-padrão deve ser preservada na formatação"
	);
	assert.strictEqual(formatMinecraftServer(null), "");

	// Parsing
	assert.deepStrictEqual(parseMinecraftServerInput("play.exemplo.com"), {
		host: "play.exemplo.com",
		port: 25565
	});
	assert.deepStrictEqual(parseMinecraftServerInput("play.exemplo.com:25300"), {
		host: "play.exemplo.com",
		port: 25300
	});
	assert.strictEqual(parseMinecraftServerInput(""), null);
	console.log("✓ formatMinecraftServer e parseMinecraftServerInput validados.");

	// 3. Extrair e testar calculateChanges
	console.log("3. Testando calculateChanges para detecção de alterações...");
	const calcMatch = managementJs.match(
		/function calculateChanges\(original, current\) \{([\s\S]*?)\n {4}\}/
	);
	assert.ok(calcMatch, "Função calculateChanges deve existir em management.js");
	const calculateChanges = new Function("original", "current", calcMatch[1]);

	// Caso A: Minecraft adicionado
	const origA = {
		name: "grupo",
		minecraftServer: null,
		roleta: { timeoutTime: 300, silenciar: false }
	};
	const currA = { ...origA, minecraftServer: { host: "play.exemplo.com", port: 25565 } };
	const changesA = calculateChanges(origA, currA);
	assert.deepStrictEqual(changesA, { minecraftServer: { host: "play.exemplo.com", port: 25565 } });

	// Caso B: Minecraft alterado (porta ou host)
	const origB = { name: "grupo", minecraftServer: { host: "play.exemplo.com", port: 25565 } };
	const currB = { name: "grupo", minecraftServer: { host: "novo.exemplo.com", port: 25565 } };
	const changesB = calculateChanges(origB, currB);
	assert.deepStrictEqual(changesB, { minecraftServer: { host: "novo.exemplo.com", port: 25565 } });

	// Caso C: Minecraft removido (null)
	const origC = { name: "grupo", minecraftServer: { host: "play.exemplo.com", port: 25565 } };
	const currC = { name: "grupo", minecraftServer: null };
	const changesC = calculateChanges(origC, currC);
	assert.deepStrictEqual(changesC, { minecraftServer: null });

	// Caso D: Roleta silenciar alterado
	const origD = { name: "grupo", roleta: { timeoutTime: 300, silenciar: false } };
	const currD = { name: "grupo", roleta: { timeoutTime: 300, silenciar: true } };
	const changesD = calculateChanges(origD, currD);
	assert.deepStrictEqual(changesD, { roleta: { timeoutTime: 300, silenciar: true } });

	// Caso E: Roleta timeoutTime alterado
	const origE = { name: "grupo", roleta: { timeoutTime: 300, silenciar: false } };
	const currE = { name: "grupo", roleta: { timeoutTime: 60, silenciar: false } };
	const changesE = calculateChanges(origE, currE);
	assert.deepStrictEqual(changesE, { roleta: { timeoutTime: 60, silenciar: false } });

	// Caso F: Nenhuma alteração real
	const origF = {
		name: "grupo",
		minecraftServer: { host: "play.exemplo.com", port: 25565 },
		roleta: { timeoutTime: 300, silenciar: false }
	};
	const currF = JSON.parse(JSON.stringify(origF));
	const changesF = calculateChanges(origF, currF);
	assert.deepStrictEqual(
		changesF,
		{},
		"Sem alterações reais calculateChanges deve retornar objeto vazio"
	);

	console.log("✓ calculateChanges detecta alterações com precisão e sem falsos negativos.");

	// 4. Validar escuta de dirty tracking em management.js
	console.log("4. Validando listeners de dirty tracking em management.js...");
	assert.match(
		managementJs,
		/input\.type === ['"]range['"]/,
		"setupDirtyTracking deve escutar evento 'input' em inputs do tipo range"
	);
	assert.match(
		managementJs,
		/document\.getElementById\(['"]minecraft-server['"]\)/,
		"setupEventListeners deve ter listener para minecraft-server"
	);
	assert.match(
		managementJs,
		/document\.getElementById\(['"]roleta-tempo['"]\)/,
		"setupEventListeners deve ter listener para roleta-tempo"
	);
	assert.match(
		managementJs,
		/document\.getElementById\(['"]roleta-silenciar['"]\)/,
		"setupEventListeners deve ter listener para roleta-silenciar"
	);
	console.log("✓ Dirty tracking devidamente configurado para todos os campos.");

	console.log("=== Todos os testes de gerenciamento passaram com sucesso! ===");
	process.exit(0);
}

main().catch((err) => {
	console.error("Falha no teste:", err);
	process.exit(1);
});
