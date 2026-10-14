process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const InviteSystem = require("../InviteSystem");
const FakeBot = require("./FakeBot");
const SuperAdmin = require("../commands/SuperAdmin");

async function runTests() {
	console.log("=== INICIANDO TESTES DO INVITESYSTEM (FILA, VIP, RECENTLY_BANNED) ===");

	const bot = new FakeBot({ id: "teste-bot", grupoLogs: "123@g.us", grupoInvites: "456@g.us" });
	const inviteSystem = new InviteSystem(bot);

	// 1. Teste da Fila e ETA
	console.log("\n[1] Testando Fila de Invites e ETA...");
	InviteSystem.clearQueue();
	InviteSystem.recentlyAccepted = [];

	const pos1 = InviteSystem.enqueueInvite({
		inviteCode: "codigo1",
		authorId: "5511999999991@s.whatsapp.net",
		authorName: "Usuario 1",
		groupName: "Grupo 1",
		inviteSystem
	});
	assert.strictEqual(pos1, 1, "Primeiro item deve ter posição 1");

	const pos2 = InviteSystem.enqueueInvite({
		inviteCode: "codigo2",
		authorId: "5511999999992@s.whatsapp.net",
		authorName: "Usuario 2",
		groupName: "Grupo 2",
		inviteSystem
	});
	assert.strictEqual(pos2, 2, "Segundo item deve ter posição 2");

	// Tentar enfileirar duplicado não deve aumentar a fila
	const pos1Dup = InviteSystem.enqueueInvite({
		inviteCode: "codigo1",
		authorId: "5511999999991@s.whatsapp.net",
		authorName: "Usuario 1",
		groupName: "Grupo 1",
		inviteSystem
	});
	assert.strictEqual(pos1Dup, 1, "Item duplicado deve retornar posição existente");
	assert.strictEqual(InviteSystem.inviteQueue.length, 2, "Tamanho da fila deve ser 2");

	// ETA
	const eta1 = InviteSystem.getETA(1);
	assert.strictEqual(eta1.totalMinutes, 15, "ETA pos 1 deve ser 15 min");
	assert.ok(eta1.horaPrevista, "Deve ter hora prevista");

	const eta2 = InviteSystem.getETA(2);
	assert.strictEqual(eta2.totalMinutes, 30, "ETA pos 2 deve ser 30 min");

	// Remoção da fila
	const removed = InviteSystem.removeFromQueue("codigo1");
	assert.strictEqual(removed, true, "Deve remover codigo1 da fila");
	assert.strictEqual(InviteSystem.inviteQueue.length, 1, "Fila deve ter tamanho 1 após remoção");

	// 2. Teste do processQueueTick
	console.log("\n[2] Testando processQueueTick...");
	let acceptInviteCalled = false;
	const mockBotCandidate = {
		id: "bot-candidato",
		client: {
			acceptInvite: async (code) => {
				acceptInviteCalled = true;
				return { accepted: true };
			}
		}
	};
	// Stub selectBestBotForAutoJoin
	inviteSystem.selectBestBotForAutoJoin = async () => mockBotCandidate;

	await InviteSystem.processQueueTick();
	assert.strictEqual(acceptInviteCalled, true, "Deve ter chamado acceptInvite");
	assert.strictEqual(InviteSystem.inviteQueue.length, 0, "Fila deve esvaziar após aceitar");
	assert.strictEqual(InviteSystem.recentlyAccepted.length, 1, "recentlyAccepted deve ter 1 item");
	assert.strictEqual(InviteSystem.recentlyAccepted[0].inviteCode, "codigo2");

	// 3. Teste do selectVipBot
	console.log("\n[3] Testando selectVipBot...");
	inviteSystem.database.botInstances = [
		{ id: "normal1", enabled: true, vip: false, banido: false, client: { acceptInvite: () => {} } },
		{ id: "vip1", enabled: true, vip: true, banido: false, client: { acceptInvite: () => {} } },
		{ id: "vip-banido", enabled: true, vip: true, banido: true, client: { acceptInvite: () => {} } }
	];
	const vipBot = inviteSystem.selectVipBot();
	assert.ok(vipBot, "Deve encontrar bot VIP");
	assert.strictEqual(vipBot.id, "vip1", "Bot VIP deve ser vip1");

	// 4. Teste de getBannedBots e getBannedDisabledBotIds
	console.log("\n[4] Testando identificação de bots banidos...");
	const bannedBots = inviteSystem.getBannedBots();
	console.log(
		`Bots banidos habilitados encontrados: ${bannedBots.map((b) => b.nome || b.id).join(", ")}`
	);
	const bannedDisabledIds = inviteSystem.getBannedDisabledBotIds();
	console.log(`Bots banidos desativados encontrados: ${Array.from(bannedDisabledIds).join(", ")}`);

	// 5. Teste do modo RECENTLY_BANNED
	console.log("\n[5] Testando evaluateAutoAcceptRecentlyBanned...");
	process.env.DISABLE_INVITE_AUTO_ACCEPT = "false";

	// Caso 5.1: Doador deve ser aceito
	const resDoador = await inviteSystem.evaluateAutoAcceptRecentlyBanned({
		isDonator: true,
		donateValue: 50
	});
	assert.strictEqual(resDoador.shouldAutoAccept, true, "Doador deve ser aceito");

	// Caso 5.2: Bot ativo já no grupo deve ser rejeitado
	const resBotAtivo = await inviteSystem.evaluateAutoAcceptRecentlyBanned({
		hasBotInGroup: true
	});
	assert.strictEqual(resBotAtivo.shouldAutoAccept, false, "Bot ativo presente deve rejeitar");

	// Caso 5.3: Grupo novo (nunca teve ravena) deve ser rejeitado com new_group
	const resNovo = await inviteSystem.evaluateAutoAcceptRecentlyBanned({
		wasInGroupBefore: false,
		hasBannedBotInGroup: false
	});
	assert.strictEqual(resNovo.shouldAutoAccept, false, "Grupo novo deve ser rejeitado");
	assert.strictEqual(resNovo.bannedModeReject, "new_group", "Deve ser marcado como new_group");

	// Caso 5.4: Grupo com ravena banida nos membros e >= 15 membros deve ser aceito
	const resGrande = await inviteSystem.evaluateAutoAcceptRecentlyBanned({
		hasBannedBotInGroup: true,
		participantCount: 20
	});
	assert.strictEqual(
		resGrande.shouldAutoAccept,
		true,
		"Grupo grande com ravena banida deve ser aceito"
	);

	// Caso 5.5: Grupo com ravena banida nos membros e < 15 membros e sem canal deve ser rejeitado com small_group
	inviteSystem.groupHasStreamChannel = async () => false;
	const resPequeno = await inviteSystem.evaluateAutoAcceptRecentlyBanned({
		hasBannedBotInGroup: true,
		participantCount: 10
	});
	assert.strictEqual(
		resPequeno.shouldAutoAccept,
		false,
		"Grupo pequeno sem canal deve ser rejeitado"
	);
	assert.strictEqual(
		resPequeno.bannedModeReject,
		"small_group",
		"Deve ser marcado como small_group"
	);
	assert.strictEqual(resPequeno.reason, "Grupo pequeno pendente");

	// Caso 5.6: Grupo com ravena banida nos membros e canal stream configurado deve ser aceito mesmo pequeno
	inviteSystem.groupHasStreamChannel = async () => true;
	const resCanal = await inviteSystem.evaluateAutoAcceptRecentlyBanned({
		hasBannedBotInGroup: true,
		participantCount: 5
	});
	assert.strictEqual(resCanal.shouldAutoAccept, true, "Grupo com canal stream deve ser aceito");

	// 6. Teste de SuperAdmin !sa-filaInvites
	console.log("\n[6] Testando SuperAdmin.filaInvites...");
	const superAdmin = new SuperAdmin();
	superAdmin.isSuperAdmin = () => true;

	InviteSystem.clearQueue();
	InviteSystem.recentlyAccepted = [
		{
			inviteCode: "acc123",
			authorId: "5511999999991@s.whatsapp.net",
			authorName: "Doador A",
			botId: "ravena2",
			groupName: "Grupo Alpha",
			acceptedAt: Date.now() - 60000
		}
	];
	InviteSystem.enqueueInvite({
		inviteCode: "pend456",
		authorId: "5511999999992@s.whatsapp.net",
		authorName: "Solicitante B",
		groupName: "Grupo Beta",
		enqueuedAt: Date.now(),
		inviteSystem
	});

	const fakeMsg = {
		author: "5511999999999@s.whatsapp.net",
		group: null
	};
	const reply = await superAdmin.filaInvites(bot, fakeMsg, []);
	console.log("Resposta do comando !sa-filaInvites:\n" + reply.content);
	assert.ok(reply.content.includes("acc123"), "Deve conter código aceito");
	assert.ok(reply.content.includes("pend456"), "Deve conter código pendente");
	assert.ok(reply.content.includes("ETA"), "Deve conter ETA");

	InviteSystem.clearQueue();
	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
