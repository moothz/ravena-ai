"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const { getRankingDisplayName } = require("../functions/RankingMessages");

function main() {
	const counts = new Map([["hu", 2]]);
	assert.strictEqual(
		getRankingDisplayName({ nome: "Hu", numero: "553171835588@s.whatsapp.net" }, counts),
		"Hu (553171835588)"
	);
	assert.strictEqual(
		getRankingDisplayName({ nome: "Maria", numero: "5511999999999@s.whatsapp.net" }, counts),
		"Maria"
	);
	console.log("Ranking: nomes iguais são desambiguados por identificador sem fundir usuários.");
	process.exit(0);
}

try {
	main();
} catch (error) {
	console.error(error);
	process.exit(1);
}
