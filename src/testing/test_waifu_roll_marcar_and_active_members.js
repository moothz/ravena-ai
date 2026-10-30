process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");
const Group = require("../models/Group");

async function runTests() {
	console.log(
		"=== Iniciando testes de filtragem de membros ausentes e comando !mu-roll-marcar ==="
	);

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });
	const groupId = "12036302@g.us";
	const userActive = "5511999990001";
	const userLeft = "5511988880002";
	const userAdmin = "5511977770003";
	const userNormal = "5511966660004";

	const groupObj = new Group({
		id: groupId,
		name: "Grupo de Teste",
		additionalAdmins: [userAdmin],
		filters: {
			waifuRollMarcar: true
		}
	});

	// Salva grupo no mock de database
	bot.database = {
		groups: new Map([[groupId, groupObj]]),
		async getGroup(id) {
			return this.groups.get(id);
		},
		async saveGroup(group) {
			this.groups.set(group.id, group);
			return true;
		}
	};

	// Participantes simulados do WhatsApp (apenas userActive e userAdmin no grupo, userLeft já saiu)
	const participants = [
		{ id: { _serialized: `${userActive}@s.whatsapp.net` }, phoneNumber: userActive },
		{ id: { _serialized: `${userAdmin}@s.whatsapp.net` }, phoneNumber: userAdmin }
	];

	// 1. Teste unitário de isUserActiveInGroup
	console.log("1. Testando isUserActiveInGroup...");
	assert.strictEqual(
		WaifuCommands.isUserActiveInGroup(userActive, participants),
		true,
		"Usuário ativo deve ser reconhecido"
	);
	assert.strictEqual(
		WaifuCommands.isUserActiveInGroup(`${userActive}@s.whatsapp.net`, participants),
		true,
		"Usuário ativo com JID deve ser reconhecido"
	);
	assert.strictEqual(
		WaifuCommands.isUserActiveInGroup(userLeft, participants),
		false,
		"Usuário que saiu do grupo não deve ser considerado ativo"
	);
	assert.strictEqual(
		WaifuCommands.isUserActiveInGroup(`${userLeft}@s.whatsapp.net`, participants),
		false,
		"Usuário que saiu do grupo (com JID) não deve ser considerado ativo"
	);
	assert.strictEqual(
		WaifuCommands.isUserActiveInGroup(userActive, null),
		true,
		"Quando participantes for null, deve retornar true por fallback"
	);
	assert.strictEqual(
		WaifuCommands.isUserActiveInGroup(userActive, []),
		true,
		"Quando participantes for array vazio, deve retornar true por fallback"
	);
	console.log("✓ 1. isUserActiveInGroup validou membros presentes e ausentes corretamente.");

	// 2. Teste de permissão do comando !mu-roll-marcar
	console.log("2. Testando permissões de !mu-roll-marcar...");
	const msgPv = createMessage({
		content: "!mu-roll-marcar",
		author: userAdmin,
		group: null
	});
	const resPv = await WaifuCommands.toggleRollMarcar(bot, msgPv, [], null);
	assert.ok(
		resPv.content.includes("só pode ser usado em grupos"),
		`Deveria barrar em PV. Resposta: ${resPv.content}`
	);

	const msgNonAdmin = createMessage({
		content: "!mu-roll-marcar",
		author: userNormal,
		group: groupId
	});
	const resNonAdmin = await WaifuCommands.toggleRollMarcar(bot, msgNonAdmin, [], groupObj);
	assert.ok(
		resNonAdmin.content.includes("Apenas administradores"),
		`Deveria barrar não-administrador. Resposta: ${resNonAdmin.content}`
	);
	console.log("✓ 2. Bloqueio em PV e para não-admins funcionando.");

	// 3. Teste do toggle de !mu-roll-marcar por admin
	console.log("3. Testando alternância de estado por admin...");
	const msgAdmin = createMessage({
		content: "!mu-roll-marcar",
		author: userAdmin,
		group: groupId
	});

	// Inicialmente waifuRollMarcar é true. Toggle sem argumentos deve mudar para false.
	const resToggleOff = await WaifuCommands.toggleRollMarcar(bot, msgAdmin, [], groupObj);
	assert.strictEqual(groupObj.filters.waifuRollMarcar, false, "Estado deve mudar para false");
	assert.ok(
		resToggleOff.content.includes("DESATIVADAS"),
		`Mensagem deve confirmar desativação. Conteúdo: ${resToggleOff.content}`
	);

	// Toggle novamente sem argumentos deve voltar para true.
	const resToggleOn = await WaifuCommands.toggleRollMarcar(bot, msgAdmin, [], groupObj);
	assert.strictEqual(groupObj.filters.waifuRollMarcar, true, "Estado deve mudar para true");
	assert.ok(
		resToggleOn.content.includes("ATIVADAS"),
		`Mensagem deve confirmar ativação. Conteúdo: ${resToggleOn.content}`
	);

	// Teste com argumento explícito "off"
	await WaifuCommands.toggleRollMarcar(bot, msgAdmin, ["off"], groupObj);
	assert.strictEqual(groupObj.filters.waifuRollMarcar, false, "Argumento 'off' deve desativar");

	// Teste com argumento explícito "on"
	await WaifuCommands.toggleRollMarcar(bot, msgAdmin, ["on"], groupObj);
	assert.strictEqual(groupObj.filters.waifuRollMarcar, true, "Argumento 'on' deve ativar");
	console.log("✓ 3. Toggle de !mu-roll-marcar e argumentos on/off funcionando com persistência.");

	// 4. Teste de Roll filtrando membros que saíram e respeitando waifuRollMarcar
	console.log("4. Testando roll com wishlist e filtro de membros ativos...");
	const originalPost = WaifuCommands.api.post;

	try {
		// Mock do endpoint /roll do Waifuletes
		WaifuCommands.api.post = async (url, payload) => {
			if (url === "/roll") {
				return {
					data: {
						success: true,
						data: {
							character: {
								id: "artoria-pendragon",
								name: "Artoria Pendragon",
								series: "Fate/stay night",
								rarity: "COMMON",
								imageUrl: null
							},
							available: true,
							isOwner: false,
							isWishlist: false,
							// Dois usuários têm na wishlist: um ativo no grupo e um que saiu
							wishlistUsers: [
								{ userId: `${userActive}@s.whatsapp.net` },
								{ userId: `${userLeft}@s.whatsapp.net` }
							],
							rollsRemaining: 5,
							maxRolls: 9
						}
					}
				};
			}
			if (url === "/kakera/daily" || url === "/user/ensure") {
				return { data: { success: true } };
			}
			return originalPost(url, payload);
		};

		// Configura waifuRollMarcar = true
		groupObj.filters.waifuRollMarcar = true;

		const msgRoll = createMessage({
			content: "!mu-roll",
			author: userAdmin,
			group: groupId
		});
		// Injeta participantes do grupo na mensagem para o helper getGroupParticipants
		msgRoll.groupParticipants = participants;

		const rollResultOn = await WaifuCommands.rollAny(bot, msgRoll, [], groupObj);
		const rollTextOn = rollResultOn.options?.caption || rollResultOn.content;

		// Deve conter @ do userActive, mas NÃO do userLeft
		assert.ok(
			rollTextOn.includes(`@${userActive}`),
			`Deveria mencionar o membro ativo @${userActive}. Texto: ${rollTextOn}`
		);
		assert.ok(
			!rollTextOn.includes(`@${userLeft}`),
			`NÃO deveria mencionar o membro que saiu @${userLeft}. Texto: ${rollTextOn}`
		);
		assert.ok(
			rollResultOn.options.mentions.includes(`${userActive}@s.whatsapp.net`),
			"Mentions deve incluir o membro ativo"
		);
		assert.ok(
			!rollResultOn.options.mentions.includes(`${userLeft}@s.whatsapp.net`),
			"Mentions NÃO deve incluir o membro que saiu"
		);
		console.log(
			"✓ 4.1. Roll com marcar=true: apenas membros ativos foram mencionados e tagueados."
		);

		// Configura waifuRollMarcar = false
		groupObj.filters.waifuRollMarcar = false;

		const rollResultOff = await WaifuCommands.rollAny(bot, msgRoll, [], groupObj);
		const rollTextOff = rollResultOff.options?.caption || rollResultOff.content;

		// Não deve conter a seção "Usuários que tem personagem na wishlist:"
		assert.ok(
			!rollTextOff.includes("Usuários que tem personagem na wishlist"),
			`Com waifuRollMarcar=false, não deve conter texto de wishlist. Texto: ${rollTextOff}`
		);
		assert.ok(
			!rollResultOff.options.mentions.includes(`${userActive}@s.whatsapp.net`),
			"Mentions NÃO deve incluir wishlist users quando marcar=false"
		);
		console.log("✓ 4.2. Roll com marcar=false: nenhum membro foi mencionado ou tagueado.");

		// 5. Teste de Multi-Roll com marcar=true vs marcar=false
		console.log("5. Testando multi-roll com wishlist e filtro de membros...");
		groupObj.filters.waifuRollMarcar = true;

		const msgMultiRoll = createMessage({
			content: "!mu-roll 2",
			author: userAdmin,
			group: groupId
		});
		msgMultiRoll.groupParticipants = participants;

		// WaifuCommands.buildRollGridImage mock para não precisar de buffers reais
		const origGrid = WaifuCommands.buildRollGridImage;
		WaifuCommands.buildRollGridImage = async () => Buffer.from("fake-grid");

		try {
			const multiResOn = await WaifuCommands.rollAny(bot, msgMultiRoll, ["2"], groupObj);
			const multiTextOn = multiResOn.options?.caption || multiResOn.content;

			assert.ok(
				multiTextOn.includes(`@${userActive}`),
				`Multi-roll com marcar=true deve mencionar @${userActive}. Texto: ${multiTextOn}`
			);
			assert.ok(
				!multiTextOn.includes(`@${userLeft}`),
				`Multi-roll NÃO deve mencionar membro ausente @${userLeft}. Texto: ${multiTextOn}`
			);
			assert.ok(
				multiResOn.options.mentions.includes(`${userActive}@s.whatsapp.net`),
				"Mentions do multi-roll deve incluir membro ativo"
			);
			assert.ok(
				!multiResOn.options.mentions.includes(`${userLeft}@s.whatsapp.net`),
				"Mentions do multi-roll NÃO deve incluir membro ausente"
			);
			console.log(
				"✓ 5.1. Multi-roll com marcar=true: apenas membros ativos foram mencionados e tagueados."
			);

			groupObj.filters.waifuRollMarcar = false;
			const multiResOff = await WaifuCommands.rollAny(bot, msgMultiRoll, ["2"], groupObj);
			const multiTextOff = multiResOff.options?.caption || multiResOff.content;

			assert.ok(
				!multiTextOff.includes("Usuários que tem personagem na wishlist"),
				`Multi-roll com marcar=false não deve conter texto de wishlist. Texto: ${multiTextOff}`
			);
			assert.ok(
				!multiResOff.options.mentions.includes(`${userActive}@s.whatsapp.net`),
				"Mentions do multi-roll NÃO deve incluir wishlist users quando marcar=false"
			);
			console.log("✓ 5.2. Multi-roll com marcar=false: nenhum membro foi mencionado ou tagueado.");
		} finally {
			WaifuCommands.buildRollGridImage = origGrid;
		}
	} finally {
		WaifuCommands.api.post = originalPost;
	}

	console.log("=== Todos os testes passaram com sucesso! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro no teste:", err);
		process.exit(1);
	});
