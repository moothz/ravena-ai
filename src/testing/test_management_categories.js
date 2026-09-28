"use strict";

const assert = require("assert");
const fs = require("fs");

function main() {
	const source = fs.readFileSync("/app/public/management.js", "utf8");
	const expectedCategories = [
		"geral", "grupo", "stickers", "ia", "interacao", "midia", "voz",
		"utilidades", "downloaders", "jogos", "streams", "zoeira", "mudae",
		"busca", "cultura", "audio", "listas", "arquivos", "canais", "outros"
	];

	expectedCategories.forEach((category) => {
		assert.match(source, new RegExp(`"${category}"`), `Categoria ausente: ${category}`);
	});
	["saude", "tts", "general", "diversao", "info", "imagens", "áudio"].forEach((category) => {
		assert.doesNotMatch(source, new RegExp(`"${category}"`), `Categoria obsoleta: ${category}`);
	});
	console.log("Categorias do /manage alinhadas ao MenuOrder.");
	process.exit(0);
}

try {
	main();
} catch (error) {
	console.error(error);
	process.exit(1);
}
