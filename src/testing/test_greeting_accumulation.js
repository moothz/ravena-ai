"use strict";

process.env.NODE_ENV = "test";
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const EventHandler = require("../EventHandler");

async function main() {
	const handler = new EventHandler();
	handler.database = { saveGroup: async () => {} };
	handler.variableProcessor = { process: async (text) => text };
	const group = {
		id: "group-test@g.us",
		name: "grupo",
		greetings: { text: "Entraram: {pessoa}|{pessoaEnter}|{pessoasVirgula}" },
		greetingAccumulation: { enabled: true, intervalMinutes: 30 }
	};
	const firstUser = { id: "5511111111111@s.whatsapp.net" };
	const secondUser = { id: "5522222222222@s.whatsapp.net" };

	const firstQueue = await handler.getAccumulatedGreetingUsers(group, "welcome", firstUser);
	assert.equal(firstQueue.length, 1);
	const blocked = await handler.getAccumulatedGreetingUsers(group, "welcome", secondUser);
	assert.equal(blocked, null);
	group.greetingAccumulationState.welcomeLastSentAt = Date.now() - 31 * 60 * 1000;
	const released = await handler.getAccumulatedGreetingUsers(group, "welcome", secondUser);
	assert.equal(released.length, 1);

	const messages = await handler.generateGreetingMessage(
		{},
		{ ...group, greetingAccumulation: { enabled: false } },
		[firstUser, secondUser],
		{ name: "Grupo" }
	);
	assert.match(messages[0].message, /@5511111111111 @5522222222222/);
	assert.match(messages[0].message, /- @5511111111111\n- @5522222222222/);
	assert.match(messages[0].message, /@5511111111111, @5522222222222/);

	console.log("EventHandler: acúmulo persistente e variáveis de listas passaram.");
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
