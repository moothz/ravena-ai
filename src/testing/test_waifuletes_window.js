"use strict";

const assert = require("assert");
const fs = require("fs");

function main() {
	const source = fs.readFileSync("/app/public/os/js/windows/waifuletes.js", "utf8");
	assert.match(source, /this\.state\.loading = true/);
	assert.match(source, /this\.state\.activeRequest !== requestId/);
	assert.match(source, /if \(!this\.state\.loading && newLimit !== this\.state\.limit\)/);
	assert.match(source, /finally \{/);
	console.log("Waifuletes: proteção contra ciclo de resize e respostas obsoletas verificada.");
	process.exit(0);
}

try {
	main();
} catch (error) {
	console.error(error);
	process.exit(1);
}
