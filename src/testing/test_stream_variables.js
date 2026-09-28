"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const StreamSystem = require("../StreamSystem");

async function main() {
	const system = Object.create(StreamSystem.prototype);
	const group = { id: "grupo-teste" };
	const config = {};
	const bot = {};

	for (const platform of ["twitch", "kick", "youtube"]) {
		const result = await system.createEventNotification(
			bot,
			group,
			{ type: "text", content: "Canal: {canal} | Nome: {nomeCanal} | Título: {titulo}" },
			{
				platform,
				channelName: `homurinhos-${platform}`,
				title: "Live de teste"
			},
			config
		);
		assert.strictEqual(
			result.content,
			`Canal: homurinhos-${platform} | Nome: homurinhos-${platform} | Título: Live de teste`
		);
	}

	console.log("Variáveis de stream verificadas para Twitch, Kick e YouTube.");
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
