"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");

async function main() {
	console.log("=== Iniciando testes de Normalização de User ID e Consistência de Cooldowns ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const { normalizeUserId, getUserId } = WaifuCommands;

	// 1. Testes unitários de normalizeUserId
	console.log("[Teste 1] Validando normalizeUserId com múltiplos formatos de entrada...");
	assert.strictEqual(normalizeUserId("5511999999999"), "5511999999999");
	assert.strictEqual(normalizeUserId("5511999999999@s.whatsapp.net"), "5511999999999");
	assert.strictEqual(normalizeUserId("5511999999999:12@s.whatsapp.net"), "5511999999999");
	assert.strictEqual(normalizeUserId("123456789012345@lid"), "123456789012345");
	assert.strictEqual(normalizeUserId("123456789012345:0@lid"), "123456789012345");
	assert.strictEqual(normalizeUserId(""), "");
	assert.strictEqual(normalizeUserId(null), "");
	assert.strictEqual(normalizeUserId(undefined), "");
	console.log("✓ normalizeUserId comportou-se perfeitamente para todos os formatos.");

	// 2. Testes de getUserId com mensagens e reações
	console.log("[Teste 2] Validando getUserId entre mensagens de texto e reações...");
	const msgTextoPura = createMessage({
		content: "!mu-cd",
		author: "5511999999999"
	});
	assert.strictEqual(getUserId(msgTextoPura), "5511999999999");

	const msgTextoComJid = createMessage({
		content: "!mu-cd",
		author: "5511999999999@s.whatsapp.net"
	});
	assert.strictEqual(getUserId(msgTextoComJid), "5511999999999");

	const msgReactComJid = createMessage({
		content: "msg de roll",
		author: "bot@s.whatsapp.net"
	});
	msgReactComJid.originReaction = {
		reaction: "💍",
		senderId: "5511999999999@s.whatsapp.net",
		msgId: { _serialized: "MSG_1" }
	};
	assert.strictEqual(
		getUserId(msgReactComJid),
		"5511999999999",
		"getUserId em reação DEVE retornar o ID normalizado sem @s.whatsapp.net"
	);

	const msgReactComDevice = createMessage({
		content: "msg de roll",
		author: "bot@s.whatsapp.net"
	});
	msgReactComDevice.originReaction = {
		reaction: "💍",
		senderId: "5511999999999:5@s.whatsapp.net",
		msgId: { _serialized: "MSG_2" }
	};
	assert.strictEqual(
		getUserId(msgReactComDevice),
		"5511999999999",
		"getUserId em reação com device DEVE retornar o ID normalizado"
	);
	console.log("✓ getUserId garante equivalência exata entre mensagens de texto e reações.");

	// 3. Teste de Exclusividade: Roller próprio casando via react vs outro jogador
	console.log(
		"[Teste 3] Validando que o autor do roll NÃO é bloqueado pela própria exclusividade via reação..."
	);
	const rollMsgId = "ROLL_MSG_EXCL_TEST";
	const charId = "asuna-sao";
	const groupId = "group_test@g.us";
	const rollerId = "5511999999999";
	const outroJogadorId = "5511888888888";
	const exclusiveUntil = Date.now() + 60000;

	WaifuCommands.recordRollMessage(
		rollMsgId,
		charId,
		groupId,
		Date.now() + 300000,
		rollerId,
		exclusiveUntil,
		"Kirito"
	);

	// Simula reação de outro jogador (deve ser bloqueado por exclusividade)
	const msgReactOutro = createMessage({
		content: "🎲 Roll da Asuna",
		group: groupId,
		author: "bot@s.whatsapp.net"
	});
	msgReactOutro.id = rollMsgId;
	msgReactOutro.originReaction = {
		reaction: "💍",
		senderId: `${outroJogadorId}@s.whatsapp.net`,
		msgId: { _serialized: rollMsgId }
	};

	const resOutro = await WaifuCommands.casarWaifu(bot, msgReactOutro, []);
	assert.ok(resOutro, "Outro jogador deve receber resposta");
	assert.ok(
		resOutro.content.includes("Personagem exclusivo"),
		`Outro jogador deve ser barrado por exclusividade! Conteúdo: ${resOutro.content}`
	);

	// Simula reação do próprio autor do roll com senderId vindo com @s.whatsapp.net
	const msgReactRoller = createMessage({
		content: "🎲 Roll da Asuna",
		group: groupId,
		author: "bot@s.whatsapp.net"
	});
	msgReactRoller.id = rollMsgId;
	msgReactRoller.originReaction = {
		reaction: "💍",
		senderId: `${rollerId}@s.whatsapp.net`,
		msgId: { _serialized: rollMsgId }
	};

	// Ao tentar casar, o roller NÃO deve ser barrado por exclusividade (vai tentar chamar a API)
	const resRoller = await WaifuCommands.casarWaifu(bot, msgReactRoller, []);
	assert.ok(
		!resRoller.content.includes("Personagem exclusivo"),
		"O próprio autor do roll NÃO pode ser barrado por exclusividade ao reagir!"
	);
	console.log("✓ Autor do roll consegue casar via reação sem conflito com exclusividade.");

	// 4. Teste de consistência de ID na requisição da API (casar vs !mu-cd)
	console.log(
		"[Teste 4] Validando que casarWaifu (react) e verCooldowns (!mu-cd) utilizam o mesmo ID..."
	);
	const idFromReaction = getUserId(msgReactRoller);
	const idFromCdCommand = getUserId(msgTextoPura);
	assert.strictEqual(
		idFromReaction,
		idFromCdCommand,
		"O ID enviado em casarWaifu e consultado em verCooldowns DEVE ser idêntico!"
	);
	console.log(`✓ Ambos utilizam o ID normalizado '${idFromReaction}'.`);

	console.log("=== Todos os testes de normalização passaram com SUCESSO! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Falha no teste:", err);
		process.exit(1);
	});
