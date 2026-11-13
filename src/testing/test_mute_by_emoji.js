"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const EventHandler = require("../EventHandler");
const ReactionsHandler = require("../ReactionsHandler");
const ReturnMessage = require("../models/ReturnMessage");

/**
 * !g-mute por emoji deve silenciar TODOS os comandos acionados pelo emoji, e reações a comandos
 * silenciados (por nome, sem diferenciar maiúsculas, ou por categoria) devem ser ignoradas pelo
 * executeFixedCommand sem reagir na mensagem de outra pessoa.
 */
async function runTests() {
	console.log("=== INICIANDO TESTES: !g-mute POR EMOJI COM VÁRIOS COMANDOS ===");

	const groupId = "120363000777888@g.us";
	const bot = new FakeBot({ id: "teste-mute-emoji", phoneNumber: "5511999990000" });
	const eventHandler = new EventHandler();
	const reactionHandler = new ReactionsHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();
	await reactionHandler.loadCommands();
	bot.eventHandler = eventHandler;
	bot.reactionHandler = reactionHandler;

	const commandHandler = eventHandler.commandHandler;
	const fixedCommands = commandHandler.fixedCommands;
	const management = commandHandler.management;

	const groupObj = {
		id: groupId,
		name: "grupo-mute",
		prefix: "!",
		paused: false,
		filters: {},
		mutedCommands: [],
		mutedCategories: [],
		additionalAdmins: []
	};
	eventHandler.getOrCreateGroup = async () => ({ group: groupObj });

	// Pré-condição: o emoji 🔍 aciona mais de um comando (ocr e buscar)
	const mappedSearch = reactionHandler.reactionCommands["🔍"];
	assert.ok(Array.isArray(mappedSearch) && mappedSearch.length >= 2, "🔍 deve mapear 2+ comandos");
	assert.ok(mappedSearch.includes("ocr") && mappedSearch.includes("buscar"));

	const adminMsg = (content) =>
		createMessage({ content, group: groupId, author: "5511988887777@s.whatsapp.net" });

	// 1. !g-mute 🔍 silencia todos os comandos do emoji (e seus aliases)
	console.log("\n[1] !g-mute 🔍 silencia ocr e buscar...");
	const muteRet = await management.muteCommand(bot, adminMsg("!g-mute 🔍"), ["🔍"], groupObj);
	assert.ok(muteRet instanceof ReturnMessage);
	assert.ok(muteRet.content.startsWith("🔇"), muteRet.content);
	for (const name of mappedSearch) {
		assert.ok(
			groupObj.mutedCommands.includes(name),
			`'${name}' deveria estar silenciado (mutados: ${groupObj.mutedCommands.join(", ")})`
		);
	}
	console.log(`✓ ${muteRet.content}`);

	// Espiona a execução real dos comandos (depois de mutar, para não afetar os aliases por método)
	const executed = [];
	const originalMethods = new Map();
	for (const name of mappedSearch) {
		const cmd = fixedCommands.getCommand(name);
		originalMethods.set(cmd, cmd.method);
		cmd.method = async () => {
			executed.push(name);
			return new ReturnMessage({ chatId: groupId, content: `executou ${name}` });
		};
	}

	const reactedReactions = [];
	const reactedMsg = createMessage({
		id: "MSG_ALVO_MUTE",
		content: "texto qualquer",
		group: groupId,
		author: "5511977776666@s.whatsapp.net"
	});
	reactedMsg.origin.react = async (emoji) => reactedReactions.push(emoji);
	bot.client = { getMessageById: async () => reactedMsg, getChatById: async () => null };
	const react = () =>
		reactionHandler.processReaction(bot, {
			reaction: "🔍",
			senderId: "5511966665555@s.whatsapp.net",
			userName: "Reagente",
			msgId: { _serialized: "MSG_ALVO_MUTE" },
			chatId: groupId
		});

	// 2. Reação 🔍 com todos silenciados: nada executa e não reage ⛔️ na mensagem alheia
	console.log("\n[2] Reação 🔍 com ocr e buscar silenciados...");
	assert.strictEqual(await react(), false);
	assert.deepStrictEqual(executed, [], "Nenhum comando do emoji pode executar");
	assert.ok(!reactedReactions.includes("⛔️"), "Reação silenciada não reage na mensagem alheia");
	console.log("✓ Reação ignorada sem efeitos colaterais");

	// 3. Toggle: !g-mute 🔍 de novo reativa todos
	console.log("\n[3] !g-mute 🔍 novamente reativa...");
	const unmuteRet = await management.muteCommand(bot, adminMsg("!g-mute 🔍"), ["🔍"], groupObj);
	assert.ok(unmuteRet.content.startsWith("✅"), unmuteRet.content);
	for (const name of mappedSearch) {
		assert.ok(!groupObj.mutedCommands.includes(name), `'${name}' deveria ter sido reativado`);
	}
	assert.strictEqual(await react(), true);
	assert.deepStrictEqual(executed, [mappedSearch[0]], "Primeiro comando do emoji volta a executar");
	console.log("✓ Reativado");

	// 4. Silenciado com maiúsculas (dados antigos): ignora só aquele e segue para o próximo do emoji
	console.log("\n[4] mutedCommands sem diferenciar maiúsculas...");
	executed.length = 0;
	groupObj.mutedCommands = [mappedSearch[0].toUpperCase()];
	assert.strictEqual(
		commandHandler.getCommandMuteReason(fixedCommands.getCommand(mappedSearch[0]), groupObj),
		"command"
	);
	assert.strictEqual(await react(), true);
	assert.deepStrictEqual(executed, [mappedSearch[1]], "Segue para o próximo comando do emoji");

	// 5. Categoria silenciada (também sem diferenciar maiúsculas)
	console.log("\n[5] mutedCategories via reação...");
	executed.length = 0;
	groupObj.mutedCommands = [];
	const categories = Array.from(
		new Set(mappedSearch.map((name) => fixedCommands.getCommand(name).category))
	);
	groupObj.mutedCategories = categories.map((c) => String(c).toUpperCase());
	assert.strictEqual(await react(), false);
	assert.deepStrictEqual(executed, [], "Categoria silenciada bloqueia a reação");
	groupObj.mutedCategories = [];
	console.log("✓ Categoria silenciada respeitada");

	for (const [cmd, method] of originalMethods) cmd.method = method;

	// 6. Helpers ocultos compartilhados (reactionMenuHelper) não são silenciados junto
	console.log("\n[6] !g-mute 🤖 não silencia helpers ocultos compartilhados...");
	const robotMapped = reactionHandler.reactionCommands["🤖"] || [];
	assert.ok(
		robotMapped.includes("reactionMenuHelper"),
		"Pré-condição: 🤖 inclui reactionMenuHelper"
	);
	groupObj.mutedCommands = [];
	const robotRet = await management.muteCommand(bot, adminMsg("!g-mute 🤖"), ["🤖"], groupObj);
	assert.ok(robotRet.content.startsWith("🔇"), robotRet.content);
	for (const name of robotMapped.filter((n) => !fixedCommands.getCommand(n)?.hidden)) {
		assert.ok(groupObj.mutedCommands.includes(name), `'${name}' deveria estar silenciado`);
	}
	assert.ok(
		!groupObj.mutedCommands.includes("reactionMenuHelper"),
		"Helper oculto usado por outros emojis não pode ser silenciado"
	);
	console.log("✓ Helpers ocultos preservados");

	// 7. Por nome continua igual
	groupObj.mutedCommands = [];
	const byName = await management.muteCommand(bot, adminMsg("!g-mute !ocr"), ["!ocr"], groupObj);
	assert.ok(byName.content.startsWith("🔇"));
	assert.ok(groupObj.mutedCommands.includes("ocr"));
	assert.ok(!groupObj.mutedCommands.includes("buscar"), "Por nome silencia só o comando citado");

	console.log("\n=== TODOS OS TESTES DE !g-mute POR EMOJI PASSARAM! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes:", err);
		process.exit(1);
	});
