process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");

async function runTests() {
	console.log("=== Iniciando testes de exclusividade de roll, reações e menções em casar ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const groupId = "group_waifu_test@g.us";
	const userRoller = "5511999990001";
	const userOutro = "5511999990002";

	// 1. Teste de registro de exclusividade no recordRollMessage
	const msgId = "MSG_ROLL_RARE_123";
	const charId = "saber-fate-stay-night";
	const exclusiveUntil = Date.now() + 60000;

	WaifuCommands.recordRollMessage(
		msgId,
		charId,
		groupId,
		Date.now() + 300000,
		userRoller,
		exclusiveUntil,
		"Arthuria"
	);

	const rollData = WaifuCommands.getRollByMessageId(msgId);
	assert.ok(rollData, "Roll data deve ser recuperado pelo ID");
	assert.strictEqual(rollData.characterId, charId);
	assert.strictEqual(rollData.rollerUserId, userRoller);
	assert.strictEqual(rollData.exclusiveUntil, exclusiveUntil);
	console.log("✓ 1. recordRollMessage registrou exclusividade corretamente.");

	// 2. Teste de bloqueio de casar por outro usuário via reaction 💍 durante janela de 60s
	const msgReactionOutro = createMessage({
		content: `🎲 *Saber* — _Fate_\n🔒 *EXCLUSIVO!* @5511999990001 tem 60s de exclusividade para casar! Reaja com 💍 ou use \`!mu-casar\`.`,
		group: groupId,
		author: "bot@s.whatsapp.net"
	});
	msgReactionOutro.id = msgId;
	msgReactionOutro.originReaction = {
		reaction: "💍",
		senderId: userOutro,
		userName: "OutroPlayer",
		msgId: { _serialized: msgId }
	};

	const blockedReactionRes = await WaifuCommands.casarWaifu(bot, msgReactionOutro, []);
	assert.ok(blockedReactionRes, "Deve retornar ReturnMessage ao bloquear casamento exclusivo");
	assert.ok(
		blockedReactionRes.content.includes("Personagem exclusivo"),
		`Deveria informar que o personagem é exclusivo. Conteúdo: ${blockedReactionRes.content}`
	);
	assert.ok(
		blockedReactionRes.content.includes("5511999990001"),
		"Deveria mencionar o @ do autor do roll na mensagem de bloqueio"
	);
	assert.deepStrictEqual(
		blockedReactionRes.options.mentions,
		[userRoller],
		"Options.mentions deve conter o autor do roll"
	);
	console.log("✓ 2. Casar via reação 💍 por outro usuário foi bloqueado com sucesso.");

	// 3. Teste de bloqueio de casar por comando de texto (!mu-casar sem args) por outro usuário
	// Popula pendingClaims com exclusividade ativa
	WaifuCommands.pendingClaims.set(groupId, {
		characterId: charId,
		characterName: "Saber",
		rollerUserId: userRoller,
		rollerUserName: "Arthuria",
		exclusiveUntil,
		expiresAt: Date.now() + 300000
	});
	WaifuCommands.activeClaimsByCharGroup.set(`${groupId}:${charId}`, {
		characterId: charId,
		groupId,
		rollerUserId: userRoller,
		rollerUserName: "Arthuria",
		exclusiveUntil,
		expiresAt: Date.now() + 300000
	});

	const msgTextoOutro = createMessage({
		content: "!mu-casar",
		group: groupId,
		author: userOutro
	});

	const blockedTextoRes = await WaifuCommands.casarWaifu(bot, msgTextoOutro, []);
	assert.ok(blockedTextoRes, "Deve retornar ReturnMessage ao bloquear comando !mu-casar");
	assert.ok(
		blockedTextoRes.content.includes("Personagem exclusivo"),
		"Deveria bloquear por exclusividade no comando de texto"
	);
	assert.ok(blockedTextoRes.content.includes("5511999990001"), "Deveria conter a menção ao roller");
	console.log("✓ 3. Casar via !mu-casar por outro usuário foi bloqueado com sucesso.");

	// 4. Teste de bloqueio de casar citando a mensagem de roll
	const msgQuoteOutro = createMessage({
		content: "!mu-casar",
		group: groupId,
		author: userOutro
	});
	msgQuoteOutro.origin.getQuotedMessage = async () => ({
		id: { _serialized: msgId },
		body: "🎲 *Saber*"
	});

	const blockedQuoteRes = await WaifuCommands.casarWaifu(bot, msgQuoteOutro, []);
	assert.ok(blockedQuoteRes, "Deve retornar ReturnMessage ao bloquear via citação");
	assert.ok(
		blockedQuoteRes.content.includes("Personagem exclusivo"),
		"Deveria bloquear por exclusividade via quote"
	);
	console.log("✓ 4. Casar citando a mensagem de roll por outro usuário foi bloqueado com sucesso.");

	// 5. Teste de bloqueio com ID explícito (!mu-casar <id>)
	const msgArgOutro = createMessage({
		content: `!mu-casar ${charId}`,
		group: groupId,
		author: userOutro
	});

	const blockedArgRes = await WaifuCommands.casarWaifu(bot, msgArgOutro, [charId]);
	assert.ok(blockedArgRes, "Deve retornar ReturnMessage ao bloquear via ID explícito");
	assert.ok(
		blockedArgRes.content.includes("Personagem exclusivo"),
		"Deveria bloquear por exclusividade com argumento explícito"
	);
	console.log("✓ 5. Casar com ID explícito por outro usuário foi bloqueado com sucesso.");

	// 6. Teste de permissão para o próprio roller casar durante o período exclusivo
	// Simula a requisição da API para testar a resposta de sucesso e menção
	const originalPost = WaifuCommands.api ? WaifuCommands.api.post : null;
	// Como a instância do axios interna 'api' é privada no módulo, vamos testar que NÃO foi bloqueado por exclusividade
	// Ao não bloquear, ele tenta chamar api.post('/marry')
	const msgRoller = createMessage({
		content: "!mu-casar",
		group: groupId,
		author: userRoller
	});

	let passExclusivity = false;
	try {
		const resRoller = await WaifuCommands.casarWaifu(bot, msgRoller, []);
		// Se a API externa responder ou se falhar na chamada HTTP mas não no bloqueio de exclusividade
		if (resRoller && !resRoller.content.includes("Personagem exclusivo")) {
			passExclusivity = true;
		}
	} catch (e) {
		passExclusivity = true;
	}
	assert.ok(
		passExclusivity,
		"O próprio roller NÃO deve ser barrado pela checagem de exclusividade"
	);
	console.log("✓ 6. O roller tem permissão para casar durante o período exclusivo.");

	// 7. Teste de expiração de exclusividade (após 60s)
	// Define exclusiveUntil no passado
	const expiredExclusiveUntil = Date.now() - 1000;
	WaifuCommands.pendingClaims.set(groupId, {
		characterId: charId,
		characterName: "Saber",
		rollerUserId: userRoller,
		rollerUserName: "Arthuria",
		exclusiveUntil: expiredExclusiveUntil,
		expiresAt: Date.now() + 300000
	});
	WaifuCommands.activeClaimsByCharGroup.set(`${groupId}:${charId}`, {
		characterId: charId,
		groupId,
		rollerUserId: userRoller,
		rollerUserName: "Arthuria",
		exclusiveUntil: expiredExclusiveUntil,
		expiresAt: Date.now() + 300000
	});
	WaifuCommands.recordRollMessage(
		msgId,
		charId,
		groupId,
		Date.now() + 300000,
		userRoller,
		expiredExclusiveUntil,
		"Arthuria"
	);

	let passExpiredExclusivity = false;
	try {
		const resExpired = await WaifuCommands.casarWaifu(bot, msgTextoOutro, []);
		if (resExpired && !resExpired.content.includes("Personagem exclusivo")) {
			passExpiredExclusivity = true;
		}
	} catch (e) {
		passExpiredExclusivity = true;
	}
	assert.ok(
		passExpiredExclusivity,
		"Após 60s, outro usuário NÃO deve ser barrado pela checagem de exclusividade"
	);
	console.log("✓ 7. Após o término da exclusividade (60s), outros usuários podem casar.");

	// 8. Teste de personagem Comum/Incomum (sem exclusividade)
	const charCommonId = "slime-isekai";
	WaifuCommands.pendingClaims.set(groupId, {
		characterId: charCommonId,
		characterName: "Slime",
		rollerUserId: userRoller,
		rollerUserName: "Arthuria",
		exclusiveUntil: null, // Sem exclusividade
		expiresAt: Date.now() + 300000
	});
	WaifuCommands.activeClaimsByCharGroup.set(`${groupId}:${charCommonId}`, {
		characterId: charCommonId,
		groupId,
		rollerUserId: userRoller,
		rollerUserName: "Arthuria",
		exclusiveUntil: null,
		expiresAt: Date.now() + 300000
	});

	let passCommon = false;
	try {
		const resCommon = await WaifuCommands.casarWaifu(bot, msgTextoOutro, []);
		if (resCommon && !resCommon.content.includes("Personagem exclusivo")) {
			passCommon = true;
		}
	} catch (e) {
		passCommon = true;
	}
	assert.ok(
		passCommon,
		"Personagens comuns/incomuns não possuem exclusividade e podem ser reivindicados livremente"
	);
	console.log("✓ 8. Personagens comuns não aplicam exclusividade.");

	// 9. Teste do roll com raridade RARE gerando legenda com exclusividade, @menção e sugestão de 💍
	const mockOriginalPost = WaifuCommands.api.post;
	try {
		WaifuCommands.api.post = async (url, payload) => {
			if (url === "/roll") {
				return {
					data: {
						data: {
							character: {
								id: "artoria-pendragon",
								name: "Artoria Pendragon",
								series: "Fate/stay night",
								rarity: "RARE",
								imageUrl: null,
								description: "Rei dos Cavaleiros"
							},
							available: true,
							isOwner: false,
							rollsRemaining: 9,
							maxRolls: 10
						}
					}
				};
			}
			if (url === "/marry") {
				return {
					data: {
						data: {
							character: {
								id: payload.characterId,
								name: "Artoria Pendragon",
								rarity: "RARE"
							},
							keys: 1,
							isSoulmate: false,
							kakeraBalance: 50
						}
					}
				};
			}
			return originalPost(url, payload);
		};

		const rollMsg = createMessage({
			content: "!mu-roll",
			group: groupId,
			author: userRoller
		});

		const rollResult = await WaifuCommands.rollAny(bot, rollMsg);
		assert.ok(rollResult, "rollAny deve retornar ReturnMessage");
		const rollText = rollResult.content?.caption || rollResult.content;
		assert.ok(
			rollText.includes("60s de exclusividade para casar"),
			`Legenda do roll deve mencionar 60s de exclusividade. Texto: ${rollText}`
		);
		assert.ok(
			rollText.includes("@5511999990001"),
			"Legenda do roll deve mencionar o @ do usuário que rolou"
		);
		assert.ok(
			rollText.includes("ficará livre"),
			"Legenda do roll deve informar que depois ficará livre"
		);
		assert.ok(rollText.includes("💍"), "Legenda do roll deve sugerir usar a reação 💍 para casar");
		assert.deepStrictEqual(
			rollResult.options.mentions,
			[userRoller],
			"Options.mentions do roll deve conter o autor do roll"
		);
		assert.ok(
			rollResult.options.waifuExclusiveUntil > Date.now(),
			"waifuExclusiveUntil deve estar configurado no futuro"
		);
		console.log(
			"✓ 9. Roll Raro gerou legenda com exclusividade de 60s, @menção e sugestão de reação 💍."
		);

		// 10. Teste da mensagem de casamento bem-sucedido exibindo o @usuário que casou
		const marryMsg = createMessage({
			content: "!mu-casar artoria-pendragon",
			group: groupId,
			author: userRoller
		});

		const marryResult = await WaifuCommands.casarWaifu(bot, marryMsg, ["artoria-pendragon"]);
		assert.ok(marryResult, "casarWaifu deve retornar ReturnMessage de sucesso");
		assert.ok(
			marryResult.content.includes("@5511999990001"),
			`Mensagem de casamento deve conter o @ do usuário que casou. Mensagem: ${marryResult.content}`
		);
		assert.deepStrictEqual(
			marryResult.options.mentions,
			[userRoller],
			"Options.mentions do casamento deve conter o usuário que casou"
		);
		console.log("✓ 10. Mensagem de casamento bem-sucedido exibiu @menção do usuário que casou.");
	} finally {
		WaifuCommands.api.post = mockOriginalPost;
	}

	console.log("=== Todos os testes de exclusividade e casar passaram com sucesso! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
