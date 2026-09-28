"use strict";

process.env.NODE_ENV = "test";
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const EventHandler = require("../EventHandler");

async function main() {
	const handler = new EventHandler();
	let savedGroup = null;
	handler.database = {
		saveGroup: async (g) => {
			savedGroup = g;
		},
		getGroup: async () => savedGroup
	};
	handler.variableProcessor = { process: async (text) => text };

	const group = {
		id: "group-test@g.us",
		name: "grupo",
		greetings: { text: "Entraram: {pessoa}|{pessoaEnter}|{pessoasVirgula}" },
		greetingAccumulation: { enabled: true, intervalMinutes: 30 }
	};
	savedGroup = group;

	const capturedMessages = [];
	const fakeBot = {
		id: "fake-bot",
		isConnected: true,
		sendMessage: async (chatId, text, options) => {
			capturedMessages.push({ chatId, text, options });
		}
	};

	const firstUser = { id: "5511111111111@s.whatsapp.net" };
	const secondUser = { id: "5522222222222@s.whatsapp.net" };

	// 1. Quando acúmulo está ativo, o primeiro usuário NÃO deve disparar envio imediato (retorna null)
	const firstResult = await handler.getAccumulatedGreetingUsers(
		fakeBot,
		group,
		"welcome",
		firstUser
	);
	assert.strictEqual(firstResult, null, "Primeiro usuário deve ser acumulado e retornar null");
	assert.strictEqual(group.greetingAccumulationState.welcome.length, 1);

	// 2. Segundo usuário também é acumulado
	const secondResult = await handler.getAccumulatedGreetingUsers(
		fakeBot,
		group,
		"welcome",
		secondUser
	);
	assert.strictEqual(secondResult, null, "Segundo usuário deve ser acumulado e retornar null");
	assert.strictEqual(group.greetingAccumulationState.welcome.length, 2);

	// 3. Ao disparar o flush, as mensagens agregadas são enviadas
	await handler.flushAccumulatedGreetings(fakeBot, group.id, "welcome", { name: "Grupo" });
	assert.strictEqual(capturedMessages.length, 1, "Deve enviar exatamente uma mensagem agregada");
	assert.match(capturedMessages[0].text, /@5511111111111 @5522222222222/);
	assert.match(capturedMessages[0].text, /- @5511111111111\n- @5522222222222/);
	assert.match(capturedMessages[0].text, /@5511111111111, @5522222222222/);
	assert.strictEqual(
		group.greetingAccumulationState.welcome.length,
		0,
		"Fila deve ser limpa após flush"
	);
	assert.ok(
		group.greetingAccumulationState.welcomeLastSentAt > 0,
		"LastSentAt deve ser atualizado"
	);

	// 4. Quando acúmulo está desativado, retorna imediatamente
	const disabledGroup = {
		id: "group-disabled@g.us",
		name: "grupo2",
		greetingAccumulation: { enabled: false }
	};
	const immediateResult = await handler.getAccumulatedGreetingUsers(
		fakeBot,
		disabledGroup,
		"welcome",
		firstUser
	);
	assert.deepStrictEqual(
		immediateResult,
		[firstUser],
		"Com acúmulo desligado, deve retornar usuário imediatamente"
	);

	// Limpa quaisquer timers pendentes
	if (handler.greetingTimers) {
		for (const timer of handler.greetingTimers.values()) {
			clearTimeout(timer);
		}
		handler.greetingTimers.clear();
	}

	console.log(
		"EventHandler: acúmulo com timer, agrupamento e variáveis de lista passaram com sucesso!"
	);
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
