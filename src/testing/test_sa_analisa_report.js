process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const ReportAnalyzerService = require("../services/ReportAnalyzerService");
const SuperAdmin = require("../commands/SuperAdmin");

async function runTests() {
	console.log("=== Iniciando Suíte de Testes: !sa-analisaReport ===");

	const bot = new FakeBot({ id: "teste-bot" });
	const eventHandler = new EventHandler();
	const reportService = ReportAnalyzerService.getInstance();
	const superAdmin = new SuperAdmin();

	const adminPhone = "5511999998888@s.whatsapp.net";
	const nonAdminPhone = "5511111111111@s.whatsapp.net";

	// Mock de verificação SuperAdmin
	eventHandler.adminUtils.isSuperAdmin = (author) => String(author).includes("999998888");
	eventHandler.commandHandler.superAdmin.isSuperAdmin = (author) =>
		String(author).includes("999998888");
	superAdmin.isSuperAdmin = (author) => String(author).includes("999998888");

	// Limpa qualquer sessão prévia
	reportService.cancelSession(bot.id, adminPhone);
	bot.resetCapture();

	// --------------------------------------------------------------------------
	// 1. Teste de Permissão: Não-Admin não pode executar
	// --------------------------------------------------------------------------
	console.log("\n[1] Testando controle de acesso (Não-Admin)...");
	const msgNonAdmin = createMessage({
		content: "!sa-analisaReport",
		author: nonAdminPhone,
		group: null
	});

	await eventHandler.processMessage(bot, msgNonAdmin);
	const deniedMsg = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(deniedMsg, "Deve retornar mensagem de resposta");
	assert.ok(
		deniedMsg.content.toLowerCase().includes("super administradores"),
		"Deve negar acesso a usuário comum"
	);

	// Valida também checagem direta do método
	const directDenied = await superAdmin.analisaReport(bot, msgNonAdmin, [], null);
	assert.ok(
		directDenied.content.includes("exclusivo para SuperAdministradores"),
		"Método direto deve validar permissão"
	);
	console.log("✓ Acesso negado para não-admin validado com sucesso (CommandHandler + SuperAdmin).");

	// --------------------------------------------------------------------------
	// 2. Teste de Contexto: SuperAdmin tentando rodar em grupo
	// --------------------------------------------------------------------------
	console.log("\n[2] Testando bloqueio em grupos (deve ser restrito a PV)...");
	bot.resetCapture();
	const msgGrupo = createMessage({
		content: "!sa-analisaReport",
		author: adminPhone,
		group: "120363000000000000@g.us"
	});

	await eventHandler.processMessage(bot, msgGrupo);
	const groupDeniedMsg = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(groupDeniedMsg, "Deve retornar mensagem no grupo");
	assert.ok(
		groupDeniedMsg.content.includes("deve ser executado no privado"),
		"Deve instruir a usar em PV"
	);
	console.log("✓ Bloqueio de execução em grupo validado com sucesso.");

	// --------------------------------------------------------------------------
	// 3. Início de Sessão em PV com número de usuário alvo
	// --------------------------------------------------------------------------
	console.log("\n[3] Testando início de sessão no PV com usuário alvo...");
	bot.resetCapture();
	const targetUser = "553183954435";
	const msgStart = createMessage({
		content: `!sa-analisaReport ${targetUser}`,
		author: adminPhone,
		group: null
	});

	await eventHandler.processMessage(bot, msgStart);
	assert.strictEqual(
		reportService.hasActiveSession(bot.id, adminPhone),
		true,
		"Sessão deve estar ativa"
	);

	const startMsg = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(
		startMsg.content.includes("Modo de Análise de Report Iniciado"),
		"Deve retornar mensagem de boas-vindas"
	);
	assert.ok(
		startMsg.content.includes(targetUser),
		"Deve confirmar número do usuário alvo na resposta"
	);
	console.log("✓ Sessão aberta no PV com sucesso.");

	// --------------------------------------------------------------------------
	// 4. Interceptação de Mensagens no PV (Texto, Imagem, Áudio, Vídeo)
	// --------------------------------------------------------------------------
	console.log("\n[4] Testando interceptação e gravação de mensagens na sessão...");
	bot.resetCapture();

	const reactionsReceived = [];
	const makeMsgWithReaction = (overrides) => {
		const m = createMessage(overrides);
		m.origin.react = async (emoji) => {
			reactionsReceived.push(emoji);
		};
		return m;
	};

	// 4.1 Mensagem de Texto
	const msgText = makeMsgWithReaction({
		content: "o bot da erro em blah blah",
		type: "text",
		author: adminPhone,
		group: null,
		timestamp: 1793541600 // 01/11/2026 11:00 BRT
	});
	await eventHandler.processMessage(bot, msgText);

	// 4.2 Mensagem de Áudio
	const msgAudio = makeMsgWithReaction({
		type: "audio",
		content: {
			data: Buffer.from("fake audio data").toString("base64"),
			mimetype: "audio/ogg"
		},
		author: adminPhone,
		group: null,
		timestamp: 1793541660 // 01/11/2026 11:01 BRT
	});
	await eventHandler.processMessage(bot, msgAudio);

	// 4.3 Mensagem de Imagem com Legenda
	const msgImage = makeMsgWithReaction({
		type: "image",
		content: {
			data: Buffer.from("fake image data").toString("base64"),
			mimetype: "image/jpeg"
		},
		caption: "print do erro",
		author: adminPhone,
		group: null,
		timestamp: 1793541660 // 01/11/2026 11:01 BRT
	});
	await eventHandler.processMessage(bot, msgImage);

	// 4.4 Mensagem de Vídeo
	const msgVideo = makeMsgWithReaction({
		type: "video",
		content: {
			data: Buffer.from("fake video data").toString("base64"),
			mimetype: "video/mp4"
		},
		caption: "gravacao da tela",
		author: adminPhone,
		group: null,
		timestamp: 1793541720 // 01/11/2026 11:02 BRT
	});
	await eventHandler.processMessage(bot, msgVideo);

	const key = reportService.getSessionKey(bot.id, adminPhone);
	const activeSession = reportService.sessions.get(key);
	assert.ok(activeSession, "Sessão deve existir no serviço");
	assert.strictEqual(activeSession.messages.length, 4, "Deve ter coletado exatamente 4 mensagens");
	assert.strictEqual(
		reactionsReceived.filter((r) => r === "📥").length,
		4,
		"Deve ter reagido com 📥 em todas as 4 mensagens"
	);
	console.log("✓ 4 mensagens coletadas e interceptadas sem virar stickers ou comandos.");

	// --------------------------------------------------------------------------
	// 5. Teste de Cancelamento de Sessão
	// --------------------------------------------------------------------------
	console.log("\n[5] Testando cancelamento de sessão...");
	bot.resetCapture();
	const msgCancel = createMessage({
		content: "!sa-analisaReport cancelar",
		author: adminPhone,
		group: null
	});

	await eventHandler.processMessage(bot, msgCancel);
	assert.strictEqual(
		reportService.hasActiveSession(bot.id, adminPhone),
		false,
		"Sessão deve ter sido descartada após cancelar"
	);
	const cancelMsg = bot.capturedMessages[bot.capturedMessages.length - 1];
	assert.ok(cancelMsg.content.includes("cancelada"), "Deve confirmar cancelamento");
	console.log("✓ Cancelamento de sessão validado com sucesso.");

	// --------------------------------------------------------------------------
	// 6. Teste de Fluxo Completo: Coleta + Finalização + Retorno de 2 Mensagens
	// --------------------------------------------------------------------------
	console.log("\n[6] Testando fluxo completo de finalização e geração de prompt...");
	bot.resetCapture();

	// Inicia nova sessão
	await eventHandler.processMessage(
		bot,
		createMessage({
			content: `!sa-analisaReport ${targetUser}`,
			author: adminPhone,
			group: null
		})
	);

	// Mock dos métodos de extração do ReportAnalyzerService para teste rápido e determinístico
	reportService.extractOcr = async () => "Erro de comunicação ao salvar nome";
	reportService.transcribeAudio = async () => "olhei aqui e vi que tem esse problema assim";
	reportService.extractAudioFromVideo = async () => "áudio de teste do vídeo";

	// Mock de LLMService para simular resposta da IA local
	const llmService = require("../services/LLMService").getInstance();
	const originalGetCompletion = llmService.getCompletion;
	llmService.getCompletion = async (options) => {
		if (options.systemContext && options.systemContext.includes("triagem de bugs")) {
			return "Diagnóstico Técnico: O erro ocorre durante o processo de persistência de dados no SQLite ao tentar salvar nome de usuário.";
		}
		return originalGetCompletion.call(llmService, options);
	};

	// Mock de SummaryCommands.analyzeVideo
	const SummaryCommands = require("../functions/SummaryCommands");
	const originalAnalyzeVideo = SummaryCommands.analyzeVideo;
	SummaryCommands.analyzeVideo = async () =>
		"Video[vida-real|sfw|Usuário exibindo tela de configuração do bot]";

	// Encaminha mensagens cronológicas
	await eventHandler.processMessage(
		bot,
		createMessage({
			content: "o bot da erro em blah bah",
			type: "text",
			author: adminPhone,
			group: null,
			timestamp: 1793541600 // 11:00
		})
	);

	await eventHandler.processMessage(
		bot,
		createMessage({
			type: "audio",
			content: { data: "base64audio", mimetype: "audio/ogg" },
			author: adminPhone,
			group: null,
			timestamp: 1793541660 // 11:01
		})
	);

	await eventHandler.processMessage(
		bot,
		createMessage({
			type: "image",
			content: { data: "base64image", mimetype: "image/jpeg" },
			author: adminPhone,
			group: null,
			timestamp: 1793541660 // 11:01
		})
	);

	bot.resetCapture();

	// Envia comando para finalizar
	const msgFinish = createMessage({
		content: "!sa-analisaReport",
		author: adminPhone,
		group: null
	});

	await eventHandler.processMessage(bot, msgFinish);

	// Aguarda o processamento assíncrono de handleCommand concluir
	let attempts = 0;
	while (reportService.hasActiveSession(bot.id, adminPhone) && attempts < 50) {
		await new Promise((r) => setTimeout(r, 100));
		attempts++;
	}

	assert.strictEqual(
		reportService.hasActiveSession(bot.id, adminPhone),
		false,
		"Sessão deve ser finalizada e removida da memória"
	);

	// Deve ter enviado aviso preliminar + 2 mensagens finais
	console.log(`Mensagens capturadas no retorno: ${bot.capturedMessages.length}`);
	assert.ok(bot.capturedMessages.length >= 2, "Deve retornar pelo menos 2 mensagens");

	const promptMsg = bot.capturedMessages[bot.capturedMessages.length - 2];
	const aiMsg = bot.capturedMessages[bot.capturedMessages.length - 1];

	console.log("\n--- Conteúdo da Mensagem 1 (Prompt Montado) ---");
	console.log(promptMsg.content);

	console.log("\n--- Conteúdo da Mensagem 2 (IA Local) ---");
	console.log(aiMsg.content);

	// Validações da Mensagem 1 (Prompt)
	assert.ok(
		promptMsg.content.includes(`Usuario ${targetUser} reporta um problema`),
		"Deve conter cabeçalho com usuário informado"
	);
	assert.ok(
		promptMsg.content.includes("o bot da erro em blah bah"),
		"Deve conter texto transcrito"
	);
	assert.ok(
		promptMsg.content.includes("[audio] olhei aqui e vi que tem esse problema assim"),
		"Deve conter áudio transcrito"
	);
	assert.ok(
		promptMsg.content.includes('[imagem] Imagem mostra frase "Erro de comunicação ao salvar nome"'),
		"Deve conter frase de OCR da imagem"
	);
	assert.ok(
		!promptMsg.content.includes("[CONTEXTO DO BOT RAVENA]"),
		"Mensagem 1 deve conter apenas o que foi extraído do report, sem o contexto do bot"
	);

	// Validações da Mensagem 2 (IA Local)
	assert.ok(
		aiMsg.content.includes("Interpretação da IA Local"),
		"Mensagem 2 deve ser identificada como Interpretação da IA Local"
	);
	assert.ok(
		aiMsg.content.includes("Diagnóstico Técnico"),
		"Mensagem 2 deve conter a análise retornada pela IA"
	);

	// Restaura mocks
	llmService.getCompletion = originalGetCompletion;
	SummaryCommands.analyzeVideo = originalAnalyzeVideo;

	console.log("\n✅ TODOS OS TESTES PASSARAM COM SUCESSO!");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("\n❌ ERRO NOS TESTES:", err);
		process.exit(1);
	});
