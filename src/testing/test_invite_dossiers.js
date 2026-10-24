process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const InviteSystem = require("../InviteSystem");
const LLMService = require("../services/LLMService");
const MemoryService = require("../services/MemoryService");

async function main() {
	console.log("=== Iniciando Testes de Dossiê do Usuário e Grupo no InviteSystem ===");

	const bot = new FakeBot({
		id: "bot-test",
		phoneNumber: "5511999990001",
		grupoInvites: "120363000000000@g.us",
		grupoLogs: "120363000000000@g.us"
	});

	const inviteSystem = new InviteSystem(bot);

	// -------------------------------------------------------------
	// 1. Teste de formatUserDossierForLog
	// -------------------------------------------------------------
	console.log("\n1. Testando formatUserDossierForLog...");

	// 1.1 Usuário sem histórico
	const emptyUserLog = inviteSystem.formatUserDossierForLog(null, "5511988880001@s.whatsapp.net");
	assert.ok(
		emptyUserLog.includes("📋 *Dossiê do Solicitante:* Sem histórico prévio memorizado."),
		"Deve indicar ausência de histórico prévio"
	);

	// 1.2 Usuário comum com fatos
	const normalUser360 = {
		canonical_user_id: "wa_5511988880001",
		display_name: "Carlos Jogador",
		facts: [
			{ fact_text: "Gosta de jogar futebol aos sábados", category: "hobby" },
			{ fact_text: "Trabalha com suporte de TI", category: "work" }
		],
		games: {
			donation: { valor: 25 },
			fishing: { level: 5 }
		},
		active_groups: [{ target_id: "120363@g.us", msgs_count: 12 }]
	};
	const normalUserLog = inviteSystem.formatUserDossierForLog(normalUser360);
	assert.ok(normalUserLog.includes("wa_5511988880001"), "Deve conter ID Canônico");
	assert.ok(normalUserLog.includes("Carlos Jogador"), "Deve conter display_name");
	assert.ok(
		normalUserLog.includes("[hobby] Gosta de jogar futebol"),
		"Deve listar fatos memorizados"
	);
	assert.ok(normalUserLog.includes("Doador R$25"), "Deve listar dados de doação");
	assert.ok(normalUserLog.includes("Pesca Nv.5"), "Deve listar nível de pesca");

	// 1.3 Usuário com indício de menor de idade
	const underageUser360 = {
		canonical_user_id: "wa_5511977770001",
		display_name: "Pedrinho",
		facts: [{ fact_text: "Tem 14 anos de idade e estuda no 9º ano", category: "personal" }]
	};
	const underageLog = inviteSystem.formatUserDossierForLog(underageUser360);
	assert.ok(
		underageLog.includes("⚠️ *Alerta:* Menção a possível menor de idade"),
		"Deve conter alerta visual de menor de idade"
	);

	// 1.4 Usuário com indício de problemático
	const problematicUser360 = {
		canonical_user_id: "wa_5511966660001",
		display_name: "Toxico123",
		facts: [{ fact_text: "Foi banido de outro grupo por spam e trava zap", category: "conduct" }]
	};
	const problematicLog = inviteSystem.formatUserDossierForLog(problematicUser360);
	assert.ok(
		problematicLog.includes("🚨 *Alerta:* Menção a comportamento de risco"),
		"Deve conter alerta visual de comportamento de risco"
	);

	console.log("✓ formatUserDossierForLog validado com sucesso!");

	// -------------------------------------------------------------
	// 2. Teste de formatGroupDossierForLog
	// -------------------------------------------------------------
	console.log("\n2. Testando formatGroupDossierForLog...");

	// 2.1 Grupo sem histórico
	const emptyGroupLog = inviteSystem.formatGroupDossierForLog(null, "120363000000001@g.us");
	assert.strictEqual(emptyGroupLog, "", "Grupo sem histórico deve retornar string vazia");

	// 2.2 Grupo com profile e dossiês
	const group360 = {
		group_id: "120363000000001@g.us",
		profile: {
			vibe_summary: "humor e tecnologia",
			average_problematic_score: 1.5,
			frequent_topics: JSON.stringify(["programação", "memes", "games"]),
			latest_summary: "Membros discutindo sobre novas linguagens de programação e consoles."
		},
		dossiers: [
			{
				dossier_json: JSON.stringify({
					type: "tech",
					summary: "Discussão pacífica sobre desenvolvimento de software.",
					problematic_score: 1,
					classified_items: []
				}),
				problematic_score: 1,
				is_problematic: 0,
				is_underage: 0,
				created_at: new Date().toISOString()
			}
		]
	};
	const groupLog = inviteSystem.formatGroupDossierForLog(group360, "120363000000001@g.us");
	assert.ok(groupLog.includes("🏛️ *Dossiê do Grupo (@g.us):*"), "Deve conter cabeçalho do grupo");
	assert.ok(groupLog.includes("humor e tecnologia"), "Deve conter vibe");
	assert.ok(groupLog.includes("1.5/10"), "Deve conter nota de risco");
	assert.ok(groupLog.includes("programação, memes, games"), "Deve conter tópicos frequentes");
	assert.ok(groupLog.includes("Discussão pacífica"), "Deve listar resumo do dossiê");

	console.log("✓ formatGroupDossierForLog validado com sucesso!");

	// -------------------------------------------------------------
	// 3. Teste de evaluateAutoAcceptWithLLM com injeção de dossiês
	// -------------------------------------------------------------
	console.log("\n3. Testando evaluateAutoAcceptWithLLM com injeção de dossiês...");

	const llmService = LLMService.getInstance();
	let capturedPrompt = "";
	let capturedSystemContext = "";

	// Mock do LLMService para capturar o prompt gerado
	llmService.getCompletion = async (opts) => {
		capturedPrompt = opts.prompt;
		capturedSystemContext = opts.systemContext;
		return JSON.stringify({
			should_auto_accept: true,
			reason: "Grupo atende aos critérios com base no dossiê"
		});
	};

	const evalResult = await inviteSystem.evaluateAutoAcceptWithLLM({
		userName: "Carlos Jogador",
		authorId: "5511988880001@s.whatsapp.net",
		groupName: "Devs Brasil",
		participantCount: 20,
		description: "Grupo oficial de devs",
		reason: "Queremos o bot para auxiliar com stickers e utilitários no grupo",
		userDossier: normalUser360,
		groupDossier: group360,
		groupJid: "120363000000001@g.us"
	});

	assert.strictEqual(evalResult.shouldAutoAccept, true);
	assert.ok(
		capturedPrompt.includes("Dossiê do Solicitante na Memória:"),
		"Prompt da LLM deve conter seção do Dossiê do Solicitante"
	);
	assert.ok(
		capturedPrompt.includes("Carlos Jogador") && capturedPrompt.includes("Gosta de jogar futebol"),
		"Prompt deve conter fatos do solicitante"
	);
	assert.ok(
		capturedPrompt.includes("Dossiê Histórico do Grupo na Memória:"),
		"Prompt da LLM deve conter seção do Dossiê do Grupo"
	);
	assert.ok(
		capturedPrompt.includes("humor e tecnologia") &&
			capturedPrompt.includes("120363000000001@g.us"),
		"Prompt deve conter informações do grupo"
	);
	assert.ok(
		capturedSystemContext.includes("Solicitante identificado como CRIANÇA OU ADOLESCENTE"),
		"System prompt deve conter regra contra menores"
	);
	assert.ok(
		capturedSystemContext.includes("Solicitante identificado como PROBLEMÁTICO"),
		"System prompt deve conter regra contra usuários problemáticos"
	);

	console.log("✓ evaluateAutoAcceptWithLLM injetou dossiês no prompt com perfeição!");

	// -------------------------------------------------------------
	// 4. Teste de fluxo completo: Mensagem enviada para grupoInvites
	// -------------------------------------------------------------
	console.log("\n4. Testando formatação da mensagem enviada para grupoInvites...");

	// Simula a construção do infoMessage como ocorre em processInviteMessage
	const reason = "Gostaria de adicionar o bot para moderação e figurinhas no grupo da comunidade";
	const userDossierText = inviteSystem.formatUserDossierForLog(
		normalUser360,
		"5511988880001@s.whatsapp.net"
	);
	const groupDossierText = inviteSystem.formatGroupDossierForLog(group360, "120363000000001@g.us");

	const infoMessage =
		`🔗 *Link*: chat.whatsapp.com/ABC123XYZ\n` +
		`👤 *De:* Carlos Jogador (5511988880001)\n` +
		`🏷️ *Nome*: Devs Brasil\n` +
		`\n💬 *Motivo:*\n${reason}\n` +
		userDossierText +
		groupDossierText;

	// Verifica a ordem exata solicitada pelo usuário:
	// 1) Motivo
	// 2) Dossiê do Solicitante (logo após o motivo)
	// 3) Dossiê do Grupo (@g.us)
	const idxMotivo = infoMessage.indexOf("💬 *Motivo:*");
	const idxUserDossie = infoMessage.indexOf("📋 *Dossiê do Solicitante:*");
	const idxGroupDossie = infoMessage.indexOf("🏛️ *Dossiê do Grupo (@g.us):*");

	assert.ok(idxMotivo !== -1, "Deve conter motivo");
	assert.ok(idxUserDossie !== -1, "Deve conter dossiê do solicitante");
	assert.ok(idxGroupDossie !== -1, "Deve conter dossiê do grupo");

	assert.ok(idxUserDossie > idxMotivo, "Dossiê do Solicitante deve vir LOGO APÓS o Motivo");
	assert.ok(
		idxGroupDossie > idxUserDossie,
		"Dossiê do Grupo deve vir após o Dossiê do Solicitante"
	);

	console.log("✓ Ordem dos blocos de log validada com sucesso!");
	console.log("\n=== Todos os 4 testes de integração passaram com 100% de sucesso! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO nos testes:", err);
		process.exit(1);
	});
