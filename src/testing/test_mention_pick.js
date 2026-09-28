"use strict";

process.env.NODE_ENV = "test";
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const CustomVariableProcessor = require("../utils/CustomVariableProcessor");

async function main() {
	const processor = new CustomVariableProcessor();
	const bot = {
		client: {
			getContactById: async (id) => ({
				number: String(id).split("@")[0]
			})
		}
	};

	const mentionedContext = {
		bot,
		message: {
			author: "99999999999@s.whatsapp.net",
			origin: {
				mentionedIds: [
					"5511111111111@s.whatsapp.net",
					"5522222222222@s.whatsapp.net",
					"5533333333333@s.whatsapp.net"
				]
			}
		},
		options: {}
	};
	const mentionedResult = await processor.processContextVariables(
		"Escolhi {mentionPick}",
		mentionedContext
	);
	assert.match(mentionedResult, /@5511111111111|@5522222222222|@5533333333333/);
	assert.equal(mentionedContext.options.mentions.length, 1);

	const fallbackContext = {
		bot,
		message: {
			author: "5599999999999@s.whatsapp.net",
			origin: { mentionedIds: [] }
		},
		options: {}
	};
	const fallbackResult = await processor.processContextVariables(
		"Escolhi {mentionPick}",
		fallbackContext
	);
	assert.equal(fallbackResult, "Escolhi @5599999999999");
	assert.deepEqual(fallbackContext.options.mentions, ["5599999999999@s.whatsapp.net"]);

	console.log("CustomVariableProcessor: mentionPick com seleção e fallback passou.");
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
