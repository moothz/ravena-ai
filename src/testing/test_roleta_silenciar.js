"use strict";

const assert = require("assert");
const fs = require("fs");

function main() {
	const roleta = fs.readFileSync("/app/src/functions/RoletaRussaCommands.js", "utf8");
	const eventHandler = fs.readFileSync("/app/src/EventHandler.js", "utf8");
	assert.match(roleta, /silenciar INTEGER DEFAULT 0/);
	assert.match(roleta, /async function isUserSilenced/);
	assert.match(roleta, /name: "roleta-silenciar"/);
	assert.match(roleta, /management\?\.isBotAdmin/);
	assert.match(eventHandler, /RoletaRussaCommands\.isUserSilenced/);
	assert.match(eventHandler, /Mensagem de jogador morto na roleta removida/);
	console.log("Roleta: toggle persistente, aviso de admin e remoção condicional verificados.");
	process.exit(0);
}

try {
	main();
} catch (error) {
	console.error(error);
	process.exit(1);
}
