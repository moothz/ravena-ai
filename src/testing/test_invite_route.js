// src/testing/test_invite_route.js
// Testa a rota POST /api/invite para envio ativo de convites do site

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
delete process.env.GRUPO_INVITES_TELEGRAM;

const assert = require("assert");
const express = require("express");
const { registerIndexRoutes } = require("../BotAPI/routes/indexRoutes");

async function runTests() {
	console.log("=== Teste da rota POST /api/invite ===");
	const pass = (req, res, next) => next();
	const app = express();
	app.use(express.json());

	const sentMessages = [];
	const mockBot = {
		id: "ravena-teste",
		nomeExibir: "Ravena Teste",
		isConnected: true,
		grupoInvites: "120363000000000099@g.us",
		sendMessage: async (target, content) => {
			sentMessages.push({ target, content });
			return true;
		}
	};

	const api = {
		app,
		bots: [mockBot],
		authenticateBasic: pass,
		strictLimiter: pass,
		isAdmin: () => false,
		setAdminSessionCookie: () => {},
		clearAdminSessionCookie: () => {},
		readWebManagementToken: () => null,
		logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
		database: {
			getActiveStatusAnnouncements: async () => []
		},
		serviceProviderService: {}
	};
	registerIndexRoutes(api);

	const server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const baseUrl = `http://127.0.0.1:${server.address().port}`;

	try {
		// 1. Falha por campos faltando
		const resMissing = await fetch(`${baseUrl}/api/invite`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ link: "https://chat.whatsapp.com/ABC1234567890123456789" })
		});
		assert.strictEqual(resMissing.status, 400, "Deve retornar 400 se faltar contato ou motivo");

		// 2. Falha por link inválido
		const resInvalid = await fetch(`${baseUrl}/api/invite`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				link: "https://example.com/not-whatsapp",
				contato: "5511999990001",
				motivo: "Grupo de amigos para jogos e conversas diárias"
			})
		});
		assert.strictEqual(resInvalid.status, 400, "Deve retornar 400 para link inválido");

		// 3. Sucesso com link WhatsApp válido
		const validCode = "ABCdefGHIjklMNOpqrSTUv";
		const resSuccess = await fetch(`${baseUrl}/api/invite`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				link: `https://chat.whatsapp.com/${validCode}`,
				contato: "5511999990001",
				motivo: "Grupo de amigos para jogar pesca e conversar"
			})
		});
		assert.strictEqual(resSuccess.status, 200, "Deve retornar 200 para convite válido");
		const data = await resSuccess.json();
		assert.strictEqual(data.status, "ok", "Resposta deve ter status ok");

		// Valida mensagens encaminhadas ao grupoInvites
		assert.ok(
			sentMessages.length >= 2,
			"Deve ter enviado pelo menos notificação e comando sa-joinGrupo"
		);
		const notif = sentMessages[0];
		assert.strictEqual(notif.target, "120363000000000099@g.us", "Deve enviar para o grupoInvites");
		assert.ok(
			notif.content.includes("[Recebido pelo Site - Quero Uma!]"),
			"Deve ter cabeçalho do site"
		);
		assert.ok(notif.content.includes(validCode), "Deve conter o código de convite");
		assert.ok(notif.content.includes("5511999990001"), "Deve conter o contato do solicitante");

		console.log("✓ Rota POST /api/invite testada com sucesso!");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste de convite:", err);
		process.exit(1);
	});
