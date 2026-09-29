"use strict";

/**
 * Teste do bug de 29/09/2026 (17:42): TypeError "Cannot read properties of
 * undefined (reading 'replace')" em changeGroupTitleForStream, quando o
 * `chat.name` chega indefinido (bot com chat não hidratado no cache).
 * O erro abortava changeGroupTitleForStream e, com ele, a notificação do evento.
 *
 * Rodar: docker exec ravena-ai node src/testing/test_stream_title_fallback.js
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const StreamSystem = require("../StreamSystem");

function buildSystem(warnings) {
	const system = Object.create(StreamSystem.prototype);
	system.logger = {
		warn: (msg) => warnings.push(msg),
		debug: () => {},
		info: () => {},
		error: () => {}
	};
	return system;
}

function buildBot(chat) {
	return {
		id: "bot-teste",
		client: {
			getChatById: async () => chat
		}
	};
}

async function main() {
	const warnings = [];
	const system = buildSystem(warnings);
	const group = { id: "5512974036846-1594417283@g.us", name: "Sofadobalonesbr" };
	const channelConfig = { changeTitleOnEvent: true };
	const eventData = { platform: "twitch", channelName: "balonesbr" };

	// 1. chat.name indefinido, mas group.titulo disponível: deve usar o fallback do banco
	let setSubjectCalls = [];
	let chat = {
		isGroup: true,
		name: undefined,
		setSubject: async (title) => {
			setSubjectCalls.push(title);
		}
	};

	let result = await system.changeGroupTitleForStream(
		buildBot(chat),
		{ ...group, titulo: "Sofá do baLonesBR - LIVE ON" },
		channelConfig,
		eventData,
		"offline"
	);

	assert.strictEqual(result, true, "deve reportar sucesso usando o título do banco");
	assert.strictEqual(setSubjectCalls.length, 1, "deve chamar setSubject exatamente uma vez");
	assert.strictEqual(setSubjectCalls[0], "Sofá do baLonesBR - LIVE OFF");
	assert.strictEqual(warnings.length, 0, "não deveria avisar quando há fallback disponível");

	// 1b. mesmo cenário, agora no evento online
	setSubjectCalls = [];
	chat = { isGroup: true, name: undefined, setSubject: async (t) => setSubjectCalls.push(t) };
	result = await system.changeGroupTitleForStream(
		buildBot(chat),
		{ ...group, titulo: "Sofá do baLonesBR - LIVE OFF" },
		channelConfig,
		eventData,
		"online"
	);
	assert.strictEqual(result, true);
	assert.strictEqual(setSubjectCalls[0], "Sofá do baLonesBR - LIVE ON");

	// 2. sem chat.name e sem group.titulo: retorna false, loga WARN e NÃO lança erro
	setSubjectCalls = [];
	chat = { isGroup: true, name: undefined, setSubject: async (t) => setSubjectCalls.push(t) };
	const warningsBefore = warnings.length;

	result = await system.changeGroupTitleForStream(
		buildBot(chat),
		{ ...group, titulo: null },
		channelConfig,
		eventData,
		"offline"
	);

	assert.strictEqual(result, false, "sem título base deve retornar false sem lançar erro");
	assert.strictEqual(setSubjectCalls.length, 0, "não deve alterar o título");
	assert.strictEqual(
		warnings.length,
		warningsBefore + 1,
		"deve registrar um WARN explicando o motivo"
	);
	assert.ok(warnings[warnings.length - 1].includes("Sem título base"));

	// 3. regressão: chat.name presente continua funcionando normalmente
	setSubjectCalls = [];
	chat = {
		isGroup: true,
		name: "Bris4dos  🍁  OFF ❤️",
		setSubject: async (t) => setSubjectCalls.push(t)
	};
	result = await system.changeGroupTitleForStream(
		buildBot(chat),
		{ ...group, titulo: null },
		channelConfig,
		eventData,
		"online"
	);
	assert.strictEqual(result, true);
	assert.strictEqual(setSubjectCalls[0], "Bris4dos  🍁  ON 💚");

	// 4. regressão: título fixo configurado (onlineTitle) não depende do título atual
	setSubjectCalls = [];
	chat = { isGroup: true, name: undefined, setSubject: async (t) => setSubjectCalls.push(t) };
	result = await system.changeGroupTitleForStream(
		buildBot(chat),
		{ ...group, titulo: null },
		{ changeTitleOnEvent: true, onlineTitle: "🟢 ON 🟢 Live do Falcon" },
		eventData,
		"online"
	);
	assert.strictEqual(result, true);
	assert.strictEqual(setSubjectCalls[0], "🟢 ON 🟢 Live do Falcon");

	console.log(
		"✅ changeGroupTitleForStream: fallback de title (group.titulo), WARN sem exceção e regressões ok"
	);
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
