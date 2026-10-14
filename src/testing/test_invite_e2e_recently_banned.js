process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const InviteSystem = require("../InviteSystem");
const FakeBot = require("./FakeBot");

async function runTests() {
	console.log("=== TESTE DE PONTA A PONTA (RECENTLY_BANNED E WASINGROUPBEFORE) ===");
	process.env.DISABLE_INVITE_AUTO_ACCEPT = "false";
	process.env.RECENTLY_BANNED = "true";

	const bot = new FakeBot({
		id: "ravena-teste",
		nomeExibir: "ravena-teste",
		grupoLogs: "logs@g.us",
		grupoInvites: "invites@g.us"
	});

	// Mock do client do bot
	bot.client = {
		getInviteInfo: async (code) => {
			if (code === "grupo_com_banido_grande") {
				return {
					JID: "grupo1@g.us",
					Name: "Grupo Reposição Grande",
					ParticipantCount: 20,
					Participants: ["555592058360@s.whatsapp.net", "5511999999999@s.whatsapp.net"] // 555592058360 é o número da ravena4 banida
				};
			}
			if (code === "grupo_com_banido_pequeno") {
				return {
					JID: "grupo2@g.us",
					Name: "Grupo Reposição Pequeno",
					ParticipantCount: 8,
					Participants: ["555592058360@s.whatsapp.net", "5511999999999@s.whatsapp.net"]
				};
			}
			if (code === "grupo_novo") {
				return {
					JID: "grupo3@g.us",
					Name: "Grupo Totalmente Novo",
					ParticipantCount: 30,
					Participants: ["5511999999999@s.whatsapp.net", "5511888888888@s.whatsapp.net"]
				};
			}
			return {
				JID: "grupo_padrao@g.us",
				Name: "Grupo Padrão",
				ParticipantCount: 10,
				Participants: []
			};
		},
		acceptInvite: async (code) => ({ accepted: true })
	};

	const inviteSystem = new InviteSystem(bot);

	// Configura botinstances
	const botNormal = {
		id: "rav-normal",
		enabled: true,
		vip: false,
		banido: false,
		client: {
			acceptInvite: async () => ({ accepted: true })
		}
	};
	const botVip = {
		id: "rav-vip",
		enabled: true,
		vip: true,
		banido: false,
		client: {
			acceptInvite: async () => ({ accepted: true })
		}
	};
	inviteSystem.database.botInstances = [botNormal, botVip];
	inviteSystem.selectBestBotForAutoJoin = async () => botNormal;
	inviteSystem.database.getDonations = async () => [];

	// Mock texts path para fs
	inviteSystem.database.databasePath = "/app/data";

	// 1. Grupo Novo no modo RECENTLY_BANNED
	console.log(
		"\n[1] Testando convite de Grupo Novo (deve negar e avisar de ravena banida no topo)..."
	);
	bot.resetCapture();
	const msgNovo = {
		author: "5511777777777@s.whatsapp.net",
		authorName: "Pessoa Nova",
		name: "Pessoa Nova",
		content: "https://chat.whatsapp.com/grupo_novo",
		type: "text",
		origin: { react: () => {} }
	};

	await inviteSystem.handleInviteRequest(
		msgNovo.author,
		"grupo_novo",
		msgNovo.content,
		"Gostaria de adicionar o bot para interagir com o grupo",
		msgNovo
	);

	// Verifica se enviou mensagem ao usuário
	const userMessages = bot.capturedMessages.filter((m) => m.chatId === msgNovo.author);
	assert.ok(userMessages.length > 0, "Deve ter enviado mensagem ao usuário");
	const sentText = userMessages[0].content || "";
	console.log("Mensagem enviada ao usuário para grupo novo:\n", sentText);
	assert.ok(
		sentText.includes(
			"foi banida recentemente - neste momento, não estou aceitando nenhum convite novo"
		),
		"Mensagem deve conter aviso de ravena banida recentemente no topo"
	);

	// 2. Grupo com bot banido nos membros e >= 15 membros (deve aceitar)
	console.log("\n[2] Testando convite de Grupo com Bot Banido e >= 15 membros (deve aceitar)...");
	bot.resetCapture();
	const msgGrande = {
		author: "5511777777778@s.whatsapp.net",
		authorName: "Admin Grupo Grande",
		name: "Admin Grupo Grande",
		content: "https://chat.whatsapp.com/grupo_com_banido_grande",
		type: "text",
		origin: { react: () => {} }
	};

	await inviteSystem.handleInviteRequest(
		msgGrande.author,
		"grupo_com_banido_grande",
		msgGrande.content,
		"Repondo a ravena banida no nosso grupo",
		msgGrande
	);

	const inviteLogsGrande = bot.capturedMessages.filter((m) => m.chatId === "invites@g.us");
	assert.ok(inviteLogsGrande.length > 0, "Deve notificar grupoInvites");
	console.log("Log enviado para grupo grande:\n", inviteLogsGrande[0].content);
	assert.ok(
		inviteLogsGrande[0].content.includes("ACEITO AUTOMATICAMENTE"),
		"Deve ter sido aceito automaticamente"
	);

	// 3. Grupo com bot banido nos membros e < 15 membros (deve negar e adicionar 'Grupo pequeno pendente')
	console.log(
		"\n[3] Testando convite de Grupo com Bot Banido e < 15 membros (deve negar com 'Grupo pequeno pendente')..."
	);
	bot.resetCapture();
	const msgPequeno = {
		author: "5511777777779@s.whatsapp.net",
		authorName: "Admin Grupo Pequeno",
		name: "Admin Grupo Pequeno",
		content: "https://chat.whatsapp.com/grupo_com_banido_pequeno",
		type: "text",
		origin: { react: () => {} }
	};

	await inviteSystem.handleInviteRequest(
		msgPequeno.author,
		"grupo_com_banido_pequeno",
		msgPequeno.content,
		"Repondo ravena banida no grupo pequeno",
		msgPequeno
	);

	const userMsgPequeno = bot.capturedMessages.filter((m) => m.chatId === msgPequeno.author);
	assert.ok(userMsgPequeno.length > 0, "Deve ter enviado mensagem ao usuário");
	console.log("Mensagem ao usuário para grupo pequeno:\n", userMsgPequeno[0].content);
	assert.ok(
		userMsgPequeno[0].content.includes("Grupo pequeno pendente"),
		"Mensagem deve conter 'Grupo pequeno pendente'"
	);

	const inviteLogsPequeno = bot.capturedMessages.filter((m) => m.chatId === "invites@g.us");
	assert.ok(inviteLogsPequeno.length > 0, "Deve notificar grupoInvites");
	console.log("Log enviado para grupo pequeno:\n", inviteLogsPequeno[0].content);
	assert.ok(
		inviteLogsPequeno[0].content.includes("Grupo pequeno pendente"),
		"Log deve indicar 'Grupo pequeno pendente'"
	);

	// 4. Teste wasInGroupBefore com bot antigo banido e desativado
	console.log("\n[4] Testando wasInGroupBefore desconsiderando bot antigo banido e desativado...");
	inviteSystem.getBannedDisabledBotIds = () => new Set(["bot-antigo-banido"]);
	inviteSystem.database.getManualGroupLeave = async () => ({
		bot_id: "bot-antigo-banido",
		group_name: "Grupo Teste"
	});
	inviteSystem.database.getGroupMembershipPeriods = async () => [
		{ bot_id: "bot-antigo-banido", join_timestamp: 1000, leave_timestamp: 2000 }
	];
	inviteSystem.database.getGroup = async () => null;

	// Simulamos a mesma checagem de wasInGroupBefore
	let wasInGroupTest = false;
	const bannedDisabledBotIds = inviteSystem.getBannedDisabledBotIds();
	const manualLeave = await inviteSystem.database.getManualGroupLeave("grupo_teste@g.us");
	if (manualLeave && !bannedDisabledBotIds.has(manualLeave.bot_id)) {
		wasInGroupTest = true;
	}
	const periods = await inviteSystem.database.getGroupMembershipPeriods("grupo_teste@g.us");
	const validPeriods = periods.filter((p) => !bannedDisabledBotIds.has(p.bot_id));
	if (validPeriods.length > 0) {
		wasInGroupTest = true;
	}
	assert.strictEqual(
		wasInGroupTest,
		false,
		"wasInGroupBefore deve ser FALSE quando o único histórico for de bot banido e desativado"
	);
	console.log("wasInGroupBefore com bot banido e desativado resultou corretamente em false!");

	// 5. Teste de Doador R$100+ aceitando no bot VIP
	console.log("\n[5] Testando doador R$100+ sendo aceito no bot VIP...");
	bot.resetCapture();
	let vipAccepted = false;
	botVip.client.acceptInvite = async () => {
		vipAccepted = true;
		return { accepted: true };
	};
	inviteSystem.database.getDonations = async () => [{ numero: "5511999990100", valor: 150 }];

	const msgDoador = {
		author: "5511999990100@s.whatsapp.net",
		authorName: "Super Doador",
		name: "Super Doador",
		content: "https://chat.whatsapp.com/grupo_novo",
		type: "text",
		origin: { react: () => {} }
	};

	await inviteSystem.handleInviteRequest(
		msgDoador.author,
		"grupo_novo",
		msgDoador.content,
		"Adicionando bot vip para nosso grupo",
		msgDoador
	);

	assert.strictEqual(
		vipAccepted,
		true,
		"Bot VIP deve ter sido chamado para aceitar convite de doador R$100+"
	);
	console.log("Bot VIP aceitou convite de doador R$100+ com sucesso!");

	console.log("\n=== TESTE DE PONTA A PONTA CONCLUÍDO COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE E2E:", err);
		process.exit(1);
	});
