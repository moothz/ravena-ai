process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const EventHandler = require("../EventHandler");
const FakeBot = require("./FakeBot");
const GroupMapper = require("../utils/db/mappers/GroupMapper");

async function main() {
	console.log("=== INICIANDO TESTES DO SNAPSHOT DE MEMBROS E PUNIÇÃO <24H ===");

	// -------------------------------------------------------------------------
	// TESTE 1: GroupMapper toRow / fromRow com members e admins
	// -------------------------------------------------------------------------
	console.log("\n[TESTE 1] GroupMapper toRow e fromRow...");
	const sampleGroup = {
		id: "123@g.us",
		name: "Grupo Teste",
		members: ["5511999990001@s.whatsapp.net", "5511999990002@s.whatsapp.net"],
		admins: ["5511999990001@s.whatsapp.net"]
	};
	const row = GroupMapper.toRow(sampleGroup);
	assert.strictEqual(typeof row.members, "string", "row.members deve ser string JSON");
	assert.strictEqual(typeof row.admins, "string", "row.admins deve ser string JSON");

	const mappedBack = GroupMapper.fromRow(row);
	assert.deepStrictEqual(mappedBack.members, sampleGroup.members, "members devem ser idênticos");
	assert.deepStrictEqual(mappedBack.admins, sampleGroup.admins, "admins devem ser idênticos");
	console.log("✅ Teste 1 passou com sucesso!");

	// -------------------------------------------------------------------------
	// TESTE 2: Snapshot ao entrar no grupo (processGroupJoin)
	// -------------------------------------------------------------------------
	console.log("\n[TESTE 2] processGroupJoin gerando snapshot de membros e admins...");
	const bot = new FakeBot({
		id: "ravena-teste",
		grupoLogs: "logs@g.us",
		prefix: "!"
	});
	bot.phoneNumber = "5511999998888";

	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	const groupsMap = {};
	eventHandler.database.getGroup = async (groupId) => groupsMap[groupId] || null;
	eventHandler.database.saveGroup = async (group) => {
		groupsMap[group.id] = group;
		return group;
	};
	eventHandler.database.getPendingJoins = async () => [];
	eventHandler.database.getInviteHistoryByGroup = async () => [];

	const participantsMock = [
		{
			id: { _serialized: "5511999990001@s.whatsapp.net" },
			phoneNumber: "5511999990001",
			isAdmin: true,
			isSuperAdmin: false
		},
		{
			id: { _serialized: "5511999990002@s.whatsapp.net" },
			phoneNumber: "5511999990002",
			isAdmin: false,
			isSuperAdmin: false
		},
		{
			id: { _serialized: "5511999998888@s.whatsapp.net" }, // o próprio bot
			phoneNumber: "5511999998888",
			isAdmin: true,
			isSuperAdmin: false
		}
	];

	const joinEventData = {
		isBotJoining: true,
		user: { id: "5511999998888@s.whatsapp.net", name: "Ravena" },
		group: { id: "grupo-snap@g.us", name: "Grupo Snapshot" },
		origin: {
			getChat: async () => ({
				id: { _serialized: "grupo-snap@g.us" },
				name: "Grupo Snapshot",
				participants: participantsMock
			})
		}
	};

	await eventHandler.processGroupJoin(bot, joinEventData);

	const savedGroup = groupsMap["grupo-snap@g.us"];
	assert.ok(savedGroup, "Grupo deve ter sido salvo");
	assert.ok(Array.isArray(savedGroup.members), "members deve ser array");
	assert.ok(Array.isArray(savedGroup.admins), "admins deve ser array");
	assert.strictEqual(savedGroup.members.length, 3, "Deve conter 3 membros no snapshot");
	assert.strictEqual(savedGroup.admins.length, 2, "Deve conter 2 admins no snapshot");
	assert.ok(
		savedGroup.admins.includes("5511999990001@s.whatsapp.net"),
		"Admin 1 deve estar na lista"
	);
	console.log("✅ Teste 2 passou com sucesso!");

	// -------------------------------------------------------------------------
	// TESTE 3: Punição < 24h em Bot Normal (Block Geral em Inviter, Remover e Admins)
	// -------------------------------------------------------------------------
	console.log("\n[TESTE 3] Punição < 24 horas em Bot Normal (Block Geral)...");
	const normalBot = new FakeBot({
		id: "ravena-normal",
		grupoLogs: "logs@g.us",
		prefix: "!"
	});
	normalBot.phoneNumber = "5511999998888";

	let mockMembershipPeriods = [
		{
			join_timestamp: Date.now() - 3 * 3600 * 1000, // 3 horas atrás (< 24h)
			leave_timestamp: Date.now(),
			duration: 3 * 3600 * 1000
		}
	];
	let mockDonations = [];
	eventHandler.database.getGroupMembershipPeriods = async () => mockMembershipPeriods;
	eventHandler.database.getDonations = async () => mockDonations;
	eventHandler.database.getInviteHistoryByGroup = async () => [
		{ invite_code: "INVITE_CONVITE", author_id: "5511999997777@s.whatsapp.net" }
	];

	// Configura super admin protegido
	const superAdminPhone = "5511000000000";
	eventHandler.adminUtils.isSuperAdmin = (id) => {
		if (!id) return false;
		return String(id).replace(/\D/g, "") === superAdminPhone;
	};
	eventHandler.commandHandler.superAdmin.isSuperAdmin = (id) => {
		if (!id) return false;
		return String(id).replace(/\D/g, "") === superAdminPhone;
	};

	// Mock do blockList e blockInvites no superAdmin para registrar chamadas
	let capturedBlockListArgs = null;
	let capturedBlockInvitesCalls = [];
	eventHandler.commandHandler.superAdmin.blockList = async (b, msg, args) => {
		capturedBlockListArgs = args;
		return { content: `Bloqueados com sucesso: ${args.join(", ")}` };
	};
	eventHandler.commandHandler.superAdmin.blockInvites = async (b, msg, args) => {
		capturedBlockInvitesCalls.push(args);
		return { content: `Invites bloqueados: ${args.join(" ")}` };
	};

	const groupPunish24h = {
		id: "grupo-24h@g.us",
		name: "Grupo < 24h",
		date: Date.now() - 3 * 3600 * 1000,
		inviteCode: "INVITE_CONVITE",
		addedBy: "5511999997777@s.whatsapp.net",
		admins: [
			"5511999991111@s.whatsapp.net", // Admin normal 1
			"5511999992222@s.whatsapp.net", // Admin normal 2
			"5511000000000@s.whatsapp.net", // SuperAdmin (deve ser protegido!)
			"5511999998888@s.whatsapp.net" // O próprio bot (deve ser protegido!)
		],
		members: ["5511999991111@s.whatsapp.net", "5511999992222@s.whatsapp.net"]
	};
	groupsMap[groupPunish24h.id] = groupPunish24h;
	eventHandler.groups[groupPunish24h.id] = groupPunish24h;

	const removerPhone = "5511999993333";
	const leaveData = {
		isBotLeaving: true,
		user: { id: "5511999998888@s.whatsapp.net", name: "Ravena" },
		group: { id: groupPunish24h.id, name: groupPunish24h.name },
		responsavel: { id: `${removerPhone}@s.whatsapp.net`, name: "Remover" }
	};

	normalBot.capturedMessages = [];
	await eventHandler.processGroupLeave(normalBot, leaveData);
	await new Promise((r) => setTimeout(r, 50));

	assert.ok(capturedBlockListArgs, "blockList deveria ter sido chamado para <24h");
	const blockedListString = capturedBlockListArgs.join(", ");
	console.log("Alvos bloqueados:", blockedListString);

	// Deve conter remover, inviter e os admins normais
	assert.ok(blockedListString.includes(removerPhone), "Remover deve ser bloqueado");
	assert.ok(blockedListString.includes("5511999997777"), "Inviter deve ser bloqueado");
	assert.ok(blockedListString.includes("5511999991111"), "Admin 1 deve ser bloqueado");
	assert.ok(blockedListString.includes("5511999992222"), "Admin 2 deve ser bloqueado");

	// NÃO deve conter SuperAdmin nem o próprio bot
	assert.ok(!blockedListString.includes(superAdminPhone), "SuperAdmin NÃO pode ser bloqueado");
	assert.ok(!blockedListString.includes("5511999998888"), "O próprio bot NÃO pode ser bloqueado");

	// O log de saída no grupo de logs deve conter o aviso de Bloqueio GERAL
	assert.strictEqual(normalBot.capturedMessages.length, 1, "Deve enviar log para grupoLogs");
	assert.ok(
		normalBot.capturedMessages[0].content.includes("Bloqueio GERAL (< 24h & não doador"),
		"Log deve indicar bloqueio geral de < 24h"
	);
	console.log("✅ Teste 3 passou com sucesso!");

	// -------------------------------------------------------------------------
	// TESTE 4: Punição entre 24h e 7 dias em Bot Normal (Apenas Block Invites)
	// -------------------------------------------------------------------------
	console.log("\n[TESTE 4] Punição 24h a 7d em Bot Normal (Apenas Block Invites)...");
	mockMembershipPeriods = [
		{
			join_timestamp: Date.now() - 48 * 3600 * 1000, // 2 dias atrás (>24h e <7d)
			leave_timestamp: Date.now(),
			duration: 48 * 3600 * 1000
		}
	];
	capturedBlockListArgs = null;
	capturedBlockInvitesCalls = [];

	const groupPunish48h = {
		id: "grupo-48h@g.us",
		name: "Grupo 48h",
		date: Date.now() - 48 * 3600 * 1000,
		inviteCode: "INVITE_48H",
		addedBy: "5511999997777@s.whatsapp.net",
		admins: ["5511999991111@s.whatsapp.net"],
		members: ["5511999991111@s.whatsapp.net"]
	};
	groupsMap[groupPunish48h.id] = groupPunish48h;
	eventHandler.groups[groupPunish48h.id] = groupPunish48h;

	normalBot.capturedMessages = [];
	await eventHandler.processGroupLeave(normalBot, {
		isBotLeaving: true,
		user: { id: "5511999998888@s.whatsapp.net", name: "Ravena" },
		group: { id: groupPunish48h.id, name: groupPunish48h.name },
		responsavel: { id: `${removerPhone}@s.whatsapp.net`, name: "Remover" }
	});
	await new Promise((r) => setTimeout(r, 50));

	assert.strictEqual(capturedBlockListArgs, null, "blockList NÃO deve ser chamado para >24h");
	assert.ok(capturedBlockInvitesCalls.length > 0, "blockInvites deve ter sido chamado");
	assert.ok(
		normalBot.capturedMessages[0].content.includes("Bloqueio de convites (< 7 dias & não doador)"),
		"Log deve indicar bloqueio de convites padrão"
	);
	console.log("✅ Teste 4 passou com sucesso!");

	// -------------------------------------------------------------------------
	// TESTE 5: Imunidade de Doador em < 24h
	// -------------------------------------------------------------------------
	console.log("\n[TESTE 5] Imunidade quando quem removeu é doador em < 24h...");
	mockMembershipPeriods = [
		{
			join_timestamp: Date.now() - 1 * 3600 * 1000,
			leave_timestamp: Date.now(),
			duration: 1 * 3600 * 1000
		}
	];
	mockDonations = [{ numero: removerPhone, valor: 50 }]; // Removedor é doador
	capturedBlockListArgs = null;
	capturedBlockInvitesCalls = [];

	normalBot.capturedMessages = [];
	await eventHandler.processGroupLeave(normalBot, {
		isBotLeaving: true,
		user: { id: "5511999998888@s.whatsapp.net", name: "Ravena" },
		group: { id: groupPunish24h.id, name: groupPunish24h.name },
		responsavel: { id: `${removerPhone}@s.whatsapp.net`, name: "Remover Doador" }
	});
	await new Promise((r) => setTimeout(r, 50));

	assert.strictEqual(capturedBlockListArgs, null, "NÃO deve bloquear quando quem removeu é doador");
	assert.strictEqual(capturedBlockInvitesCalls.length, 0, "NÃO deve bloquear convites de doador");
	console.log("✅ Teste 5 passou com sucesso!");

	// -------------------------------------------------------------------------
	// TESTE 6: Bot Comunitário gerando comandos sugeridos com Admins em < 24h
	// -------------------------------------------------------------------------
	console.log("\n[TESTE 6] Bot Comunitário gerando comandos com Admins para < 24h...");
	const comuBot = new FakeBot({
		id: "ravena-comu",
		comunitario: true,
		grupoLogs: "logs@g.us",
		prefix: "!"
	});
	comuBot.phoneNumber = "5511999998888";
	mockDonations = []; // Sem doador

	comuBot.capturedMessages = [];
	await eventHandler.processGroupLeave(comuBot, {
		isBotLeaving: true,
		user: { id: "5511999998888@s.whatsapp.net", name: "Ravena" },
		group: { id: groupPunish24h.id, name: groupPunish24h.name },
		responsavel: { id: `${removerPhone}@s.whatsapp.net`, name: "Remover" }
	});
	await new Promise((r) => setTimeout(r, 50));

	assert.strictEqual(comuBot.capturedMessages.length, 2, "Comunitário deve enviar 2 mensagens");
	const sugestao = comuBot.capturedMessages[1].content;
	console.log("Sugestão Comunitário:\n" + sugestao);
	assert.ok(sugestao.includes("!sa-blockList"), "Deve conter !sa-blockList");
	assert.ok(sugestao.includes("5511999991111"), "Deve listar admin 1 na sugestão");
	assert.ok(sugestao.includes("5511999992222"), "Deve listar admin 2 na sugestão");
	console.log("✅ Teste 6 passou com sucesso!");

	console.log("\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO!");
	process.exit(0);
}

main().catch((err) => {
	console.error("❌ Erro no teste:", err);
	process.exit(1);
});
