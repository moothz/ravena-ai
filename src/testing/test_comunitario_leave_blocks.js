process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const EventHandler = require("../EventHandler");
const FakeBot = require("./FakeBot");
const ReturnMessage = require("../models/ReturnMessage");

async function main() {
	console.log("=== INICIANDO TESTES DO INVITESYSTEM (COMUNITÁRIO) E COMANDOS MULTILINHA ===");

	const fakeBot = new FakeBot({
		id: "ravena-comu",
		comunitario: true,
		grupoLogs: "logs@g.us",
		prefix: "!"
	});
	fakeBot.phoneNumber = "5511988887777";
	fakeBot.isParticipating = () => true;
	fakeBot.getChatDetails = async () => ({ notInGroup: true });

	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	// Mock do database para controlar retorno de consultas
	let mockInviteHistory = [];
	const mockDonations = [];
	let mockMembershipPeriods = [];
	const groupsMap = {};

	eventHandler.database.getGroup = async (groupId) => groupsMap[groupId] || null;
	eventHandler.database.getInviteHistoryByGroup = async (groupId) => mockInviteHistory;
	eventHandler.database.getDonations = async () => mockDonations;
	eventHandler.database.getGroupMembershipPeriods = async (groupId) => mockMembershipPeriods;
	eventHandler.database.saveGroup = async (group) => {
		groupsMap[group.id] = group;
		return group;
	};
	eventHandler.database.recordGroupLeave = async () => {};

	// Mock do superAdmin para checagem
	const superAdminPhone = "5511000000000";
	const superAdminJid = `${superAdminPhone}@c.us`;
	eventHandler.adminUtils.isSuperAdmin = (id) => {
		if (!id) return false;
		const clean = String(id).replace(/\D/g, "");
		return clean === superAdminPhone;
	};
	eventHandler.commandHandler.superAdmin.isSuperAdmin = (id) => {
		if (!id) return false;
		const clean = String(id).replace(/\D/g, "");
		return clean === superAdminPhone;
	};

	// -------------------------------------------------------------------------
	// Caso 1: Bot comunitário removido em < 7 dias - apenas 1 número alvo (quem removeu é o autor do convite)
	// -------------------------------------------------------------------------
	console.log("\n[1] Bot comunitário removido em < 7 dias (mesmo removedor e inviter)...");
	fakeBot.capturedMessages = [];

	const remover1 = "5511999999999";
	mockInviteHistory = [{ invite_code: "INVITE123", author_id: `${remover1}@c.us` }];
	mockMembershipPeriods = [
		{
			join_timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000,
			leave_timestamp: Date.now(),
			duration: 2 * 24 * 60 * 60 * 1000
		}
	];

	const group1 = {
		id: "group1@g.us",
		name: "Grupo Teste 1",
		date: Date.now() - 2 * 24 * 60 * 60 * 1000,
		inviteCode: "INVITE123",
		addedBy: `${remover1}@c.us`
	};
	groupsMap[group1.id] = group1;
	eventHandler.groups[group1.id] = group1;

	const leaveData1 = {
		isBotLeaving: true,
		user: { id: "5511988887777@c.us", name: "Ravena" },
		group: { id: group1.id, name: group1.name },
		responsavel: { id: `${remover1}@c.us`, name: "Remover 1" }
	};

	await eventHandler.processGroupLeave(fakeBot, leaveData1);
	await new Promise((r) => setTimeout(r, 100));

	assert.strictEqual(
		fakeBot.capturedMessages.length,
		2,
		"Deveria ter enviado 2 mensagens para o grupo de logs"
	);
	assert.strictEqual(fakeBot.capturedMessages[0].chatId, "logs@g.us");
	assert.ok(
		fakeBot.capturedMessages[0].content.includes("saiu do grupo"),
		"1ª mensagem deve ser a notificação de saída"
	);

	const cmds1 = fakeBot.capturedMessages[1].content;
	console.log("Comandos gerados (Caso 1):\n" + cmds1);
	assert.ok(
		cmds1.includes("!sa-block 5511999999999"),
		"Deve sugerir !sa-block com o número do removedor"
	);
	assert.ok(
		cmds1.includes("!sa-blockInvites 5511999999999 INVITE123"),
		"Deve sugerir !sa-blockInvites com o número e o código de convite"
	);
	console.log("✅ Caso 1 passou com sucesso!");

	// -------------------------------------------------------------------------
	// Caso 2: Bot comunitário removido em < 7 dias - 2 números alvos diferentes
	// -------------------------------------------------------------------------
	console.log("\n[2] Bot comunitário removido em < 7 dias (remover e inviter diferentes)...");
	fakeBot.capturedMessages = [];

	const remover2 = "5511777777777";
	const inviter2 = "5511888888888";
	mockInviteHistory = [{ invite_code: "CODE456", author_id: `${inviter2}@c.us` }];
	mockMembershipPeriods = [
		{
			join_timestamp: Date.now() - 1 * 24 * 60 * 60 * 1000,
			leave_timestamp: Date.now(),
			duration: 1 * 24 * 60 * 60 * 1000
		}
	];

	const group2 = {
		id: "group2@g.us",
		name: "Grupo Teste 2",
		date: Date.now() - 1 * 24 * 60 * 60 * 1000,
		inviteCode: "CODE456",
		addedBy: `${inviter2}@c.us`
	};
	groupsMap[group2.id] = group2;
	eventHandler.groups[group2.id] = group2;

	const leaveData2 = {
		isBotLeaving: true,
		user: { id: "5511988887777@c.us", name: "Ravena" },
		group: { id: group2.id, name: group2.name },
		responsavel: { id: `${remover2}@c.us`, name: "Remover 2" }
	};

	await eventHandler.processGroupLeave(fakeBot, leaveData2);
	await new Promise((r) => setTimeout(r, 100));

	assert.strictEqual(fakeBot.capturedMessages.length, 2, "Deveria ter enviado 2 mensagens");
	const cmds2 = fakeBot.capturedMessages[1].content;
	console.log("Comandos gerados (Caso 2):\n" + cmds2);
	assert.ok(
		cmds2.includes("!sa-blockList 5511777777777, 5511888888888"),
		"Deve sugerir !sa-blockList com ambos os números"
	);
	assert.ok(
		cmds2.includes("!sa-blockInvites 5511777777777"),
		"Deve sugerir !sa-blockInvites para quem removeu"
	);
	assert.ok(
		cmds2.includes("!sa-blockInvites 5511888888888 CODE456"),
		"Deve sugerir !sa-blockInvites para o autor do convite com o código"
	);
	console.log("✅ Caso 2 passou com sucesso!");

	// -------------------------------------------------------------------------
	// Caso 3: Não deve enviar comandos se a estadia for > 7 dias
	// -------------------------------------------------------------------------
	console.log("\n[3] Bot comunitário saindo após > 7 dias (sem comandos subsequentes)...");
	fakeBot.capturedMessages = [];

	mockMembershipPeriods = [
		{
			join_timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000,
			leave_timestamp: Date.now(),
			duration: 10 * 24 * 60 * 60 * 1000
		}
	];

	const group3 = {
		id: "group3@g.us",
		name: "Grupo Teste 3",
		date: Date.now() - 10 * 24 * 60 * 60 * 1000
	};
	groupsMap[group3.id] = group3;
	eventHandler.groups[group3.id] = group3;

	const leaveData3 = {
		isBotLeaving: true,
		user: { id: "5511988887777@c.us", name: "Ravena" },
		group: { id: group3.id, name: group3.name },
		responsavel: { id: "5511999999999@c.us", name: "Remover 3" }
	};

	await eventHandler.processGroupLeave(fakeBot, leaveData3);
	await new Promise((r) => setTimeout(r, 100));

	assert.strictEqual(
		fakeBot.capturedMessages.length,
		1,
		"Deveria ter enviado apenas a notificação de saída (sem comandos)"
	);
	console.log("✅ Caso 3 passou com sucesso!");

	// -------------------------------------------------------------------------
	// Caso 4: Não deve enviar comandos se quem removeu for SuperAdmin
	// -------------------------------------------------------------------------
	console.log("\n[4] Bot comunitário removido por SuperAdmin (sem comandos subsequentes)...");
	fakeBot.capturedMessages = [];

	mockMembershipPeriods = [
		{
			join_timestamp: Date.now() - 1 * 24 * 60 * 60 * 1000,
			leave_timestamp: Date.now(),
			duration: 1 * 24 * 60 * 60 * 1000
		}
	];

	const group4 = {
		id: "group4@g.us",
		name: "Grupo Teste 4",
		date: Date.now() - 1 * 24 * 60 * 60 * 1000
	};
	groupsMap[group4.id] = group4;
	eventHandler.groups[group4.id] = group4;

	const leaveData4 = {
		isBotLeaving: true,
		user: { id: "5511988887777@c.us", name: "Ravena" },
		group: { id: group4.id, name: group4.name },
		responsavel: { id: superAdminJid, name: "Admin Boss" }
	};

	await eventHandler.processGroupLeave(fakeBot, leaveData4);
	await new Promise((r) => setTimeout(r, 100));

	assert.strictEqual(
		fakeBot.capturedMessages.length,
		1,
		"Deveria ter enviado apenas a notificação de saída"
	);
	console.log("✅ Caso 4 passou com sucesso!");

	// -------------------------------------------------------------------------
	// Caso 5: Teste de execução de comandos multilinha encaminhados
	// -------------------------------------------------------------------------
	console.log("\n[5] Testando execução de comandos multilinha !sa- encaminhados...");
	fakeBot.capturedMessages = [];

	const executedCommands = [];
	// Mock dos métodos correspondentes no superAdmin
	eventHandler.commandHandler.superAdmin.blockList = async (bot, msg, args) => {
		executedCommands.push({ cmd: "blockList", args });
		return new ReturnMessage({
			chatId: msg.group ?? msg.author,
			content: "BlockList executado com sucesso"
		});
	};
	eventHandler.commandHandler.superAdmin.blockInvites = async (bot, msg, args) => {
		executedCommands.push({ cmd: "blockInvites", args });
		return new ReturnMessage({
			chatId: msg.group ?? msg.author,
			content: "BlockInvites executado com sucesso"
		});
	};

	// Mensagem simulando o admin encaminhando o texto copiado / forwarded
	const forwardedMessageText = `!sa-blockList 5511777777777, 5511888888888
!sa-blockInvites 5511777777777
!sa-blockInvites 5511888888888 CODE456`;

	const mockMsg = {
		id: "msg-123",
		author: superAdminJid,
		from: superAdminJid,
		content: forwardedMessageText,
		type: "text",
		timestamp: Date.now()
	};

	await eventHandler.commandHandler.handleCommand(
		fakeBot,
		mockMsg,
		forwardedMessageText.substring(1), // Simula o EventHandler removendo o prefixo inicial da 1ª linha
		null
	);

	console.log("Comandos executados:", executedCommands);
	assert.strictEqual(executedCommands.length, 3, "Os 3 comandos devem ter sido executados");
	assert.strictEqual(executedCommands[0].cmd, "blockList");
	assert.strictEqual(executedCommands[1].cmd, "blockInvites");
	assert.strictEqual(executedCommands[2].cmd, "blockInvites");

	console.log("✅ Caso 5 passou com sucesso!");

	console.log("\n=======================================================");
	console.log("TODOS OS TESTES DO INVITESYSTEM PASSARAM COM SUCESSO! 🎉");
	console.log("=======================================================");

	process.exit(0);
}

main().catch((err) => {
	console.error("ERRO NO TESTE:", err);
	process.exit(1);
});
