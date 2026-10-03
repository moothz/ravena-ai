"use strict";

const assert = require("assert");
const fs = require("fs");

function main() {
	const repository = fs.readFileSync("/app/src/utils/db/repositories/CoreRepository.js", "utf8");
	const eventHandler = fs.readFileSync("/app/src/EventHandler.js", "utf8");
	const management = fs.readFileSync("/app/src/commands/Management.js", "utf8");
	const botApi = fs.existsSync("/app/src/BotAPI/routes/managementRoutes.js")
		? fs.readFileSync("/app/src/BotAPI/routes/managementRoutes.js", "utf8")
		: fs.readFileSync("/app/src/BotAPI.js", "utf8");

	assert.match(repository, /LOWER\(name\) = LOWER\(\?\)/);
	assert.match(repository, /idx_groups_name_nocase/);
	assert.match(repository, /_ensureUniqueGroupNames/);
	assert.match(eventHandler, /gp_estranho_/);
	assert.match(eventHandler, /\.normalize\("NFD"\)/);
	assert.match(eventHandler, /padStart\(3, "0"\)/);
	assert.match(management, /grupoExistente\.id !== group\.id/);
	assert.match(botApi, /getGroupByName\(changes\.name\)/);
	console.log(
		"Nomes de grupos: busca case-insensitive, migração, fallback sequencial e APIs verificados."
	);
	process.exit(0);
}

try {
	main();
} catch (error) {
	console.error(error);
	process.exit(1);
}
