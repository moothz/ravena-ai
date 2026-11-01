const assert = require("assert");
const axios = require("axios");
const SenderDropMonitor = require("../services/SenderDropMonitor");

async function runTests() {
	console.log("=== Iniciando testes de SenderDropMonitor ===");

	const monitor = SenderDropMonitor.getInstance();
	monitor.reset();

	// Configurações controladas para teste rápido
	monitor.threshold = 3;
	monitor.windowMs = 5000;
	monitor.cooldownMs = 10000;

	// Mock do axios.post para interceptar chamadas ao Telegram
	const sentMessages = [];
	const originalPost = axios.post;
	axios.post = async (url, data, config) => {
		sentMessages.push({ url, data, config });
		return { data: { ok: true } };
	};

	try {
		// Mock de bot
		const fakeBot = {
			id: "rav-teste",
			nomeExibir: "Ravena Teste",
			eventHandler: {
				groups: {
					"120363000000000001@g.us": {
						name: "grupo_teste",
						titulo: "Grupo de Teste VIP"
					}
				}
			}
		};

		const makeEvent = (chatId, sender) => ({
			Info: {
				Chat: chatId,
				Sender: sender,
				ID: "MSG_" + Math.random().toString(36).substring(7)
			},
			IsUnavailable: true,
			UnavailableType: "sender_drop"
		});

		// 1. Drops abaixo do threshold não disparam alerta
		console.log("Teste 1: Drops abaixo do threshold...");
		monitor.recordDrop(
			fakeBot,
			makeEvent("120363000000000001@g.us", "5511999999999@s.whatsapp.net")
		);
		monitor.recordDrop(
			fakeBot,
			makeEvent("120363000000000001@g.us", "5511888888888@s.whatsapp.net")
		);
		assert.strictEqual(
			sentMessages.length,
			0,
			"Nenhum alerta deveria ter sido enviado com 2 drops (threshold=3)"
		);
		console.log("  ✓ OK");

		// 2. Drop atingindo o threshold dispara o alerta
		console.log("Teste 2: Atingindo threshold...");
		monitor.recordDrop(
			fakeBot,
			makeEvent("120363000000000001@g.us", "5511777777777@s.whatsapp.net")
		);
		// Pequeno delay para garantir que a Promise assíncrona resolveu
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.strictEqual(
			sentMessages.length,
			1,
			"Exatamente 1 alerta deveria ter sido enviado ao bater o threshold"
		);
		const alertPayload = sentMessages[0];
		assert.ok(
			alertPayload.data.text.includes("sender_drop em massa detectado"),
			"Texto deve conter título do alerta"
		);
		assert.ok(
			alertPayload.data.text.includes("Grupo de Teste VIP"),
			"Texto deve conter título do grupo"
		);
		assert.ok(
			alertPayload.data.text.includes("120363000000000001@g.us"),
			"Texto deve conter ID do grupo"
		);
		assert.ok(
			alertPayload.data.text.includes(
				"query-whatsgo.js rav-teste sendText 120363000000000001@g.us"
			),
			"Texto deve conter comando de recuperação"
		);
		console.log("  ✓ OK");

		// 3. Drops subsequentes dentro do cooldown NÃO disparam novo alerta
		console.log("Teste 3: Drops dentro do cooldown...");
		monitor.recordDrop(
			fakeBot,
			makeEvent("120363000000000001@g.us", "5511666666666@s.whatsapp.net")
		);
		monitor.recordDrop(
			fakeBot,
			makeEvent("120363000000000001@g.us", "5511555555555@s.whatsapp.net")
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.strictEqual(
			sentMessages.length,
			1,
			"Alertas subsequentes durante cooldown devem ser suprimidos"
		);
		console.log("  ✓ OK");

		// 4. Outro grupo recebe alerta independente
		console.log("Teste 4: Outro grupo deve ter contagem independente...");
		monitor.recordDrop(
			fakeBot,
			makeEvent("120363999999999999@g.us", "5511111111111@s.whatsapp.net")
		);
		monitor.recordDrop(
			fakeBot,
			makeEvent("120363999999999999@g.us", "5511222222222@s.whatsapp.net")
		);
		monitor.recordDrop(
			fakeBot,
			makeEvent("120363999999999999@g.us", "5511333333333@s.whatsapp.net")
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.strictEqual(
			sentMessages.length,
			2,
			"Segundo grupo deve disparar seu próprio alerta ao atingir threshold"
		);
		console.log("  ✓ OK");

		// 5. Ignora mensagens privadas (chatId que não termina em @g.us)
		console.log("Teste 5: Ignora chats privados...");
		monitor.recordDrop(
			fakeBot,
			makeEvent("5511999999999@s.whatsapp.net", "5511999999999@s.whatsapp.net")
		);
		assert.strictEqual(
			sentMessages.length,
			2,
			"Chats que não são grupos (@g.us) devem ser ignorados"
		);
		console.log("  ✓ OK");

		console.log("\n✅ Todos os testes de SenderDropMonitor passaram com sucesso!");
	} finally {
		// Restaura axios.post
		axios.post = originalPost;
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes:", err);
		process.exit(1);
	});
