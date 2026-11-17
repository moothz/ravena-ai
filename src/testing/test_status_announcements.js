// src/testing/test_status_announcements.js
// Testes completos para o sistema de avisos de status (/status, /instances e !status)

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const express = require("express");
const Database = require("../utils/Database");
const GeneralCommands = require("../functions/GeneralCommands");
const { registerInstancesRoutes } = require("../BotAPI/routes/instancesRoutes");
const { registerIndexRoutes } = require("../BotAPI/routes/indexRoutes");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== Iniciando testes de avisos de status ===");

	const database = Database.getInstance();
	const createdIds = [];
	let server = null;

	try {
		// 1. Testes de banco de dados (CoreRepository / Database)
		console.log("1. Testando operações de banco (status_announcements)...");

		const now = Date.now();
		const announcement1 = await database.createStatusAnnouncement({
			message: "*Manutenção Programada*: O bot ficará instável das 14h às 16h.",
			expiresAt: now + 3600 * 1000, // +1h
			createdBy: "admin"
		});
		if (announcement1?.id) createdIds.push(announcement1.id);

		assert.ok(announcement1, "Aviso 1 deve ter sido criado com sucesso");
		assert.ok(announcement1.id, "Aviso 1 deve ter ID");
		assert.strictEqual(
			announcement1.message,
			"*Manutenção Programada*: O bot ficará instável das 14h às 16h."
		);

		// Cria segundo aviso (pode ter mais de 1 aviso publicado)
		const announcement2 = await database.createStatusAnnouncement({
			message: "_Aviso urgente_: Servidor de imagens _Kokoro_ atualizado! 🚀",
			expiresAt: now + 7200 * 1000, // +2h
			createdBy: "admin"
		});
		if (announcement2?.id) createdIds.push(announcement2.id);

		assert.ok(announcement2, "Aviso 2 deve ter sido criado com sucesso");

		// Cria aviso já expirado (no passado)
		const expiredAnnouncement = await database.createStatusAnnouncement({
			message: "Aviso antigo já expirado",
			expiresAt: now - 1000,
			createdBy: "admin"
		});
		if (expiredAnnouncement?.id) createdIds.push(expiredAnnouncement.id);

		// getActiveStatusAnnouncements deve trazer apenas announcement1 e announcement2, NÃO o expirado
		const activeList = await database.getActiveStatusAnnouncements(now);
		const activeIds = activeList.map((a) => a.id);
		assert.ok(activeIds.includes(announcement1.id), "Aviso 1 deve estar na lista de ativos");
		assert.ok(activeIds.includes(announcement2.id), "Aviso 2 deve estar na lista de ativos");
		assert.ok(
			!activeIds.includes(expiredAnnouncement.id),
			"Aviso expirado NÃO deve estar na lista de ativos"
		);

		// Testa atualização de aviso via database
		const updatedDb = await database.updateStatusAnnouncement(announcement1.id, {
			message: "*Manutenção Atualizada*: Término previsto para as 17h.",
			expiresAt: now + 5000 * 1000
		});
		assert.ok(updatedDb, "updateStatusAnnouncement deve retornar o registro atualizado");
		assert.strictEqual(updatedDb.message, "*Manutenção Atualizada*: Término previsto para as 17h.");
		assert.strictEqual(updatedDb.expires_at, now + 5000 * 1000);
		// Restaura para os testes seguintes
		await database.updateStatusAnnouncement(announcement1.id, {
			message: "*Manutenção Programada*: O bot ficará instável das 14h às 16h.",
			expiresAt: now + 3600 * 1000
		});

		console.log("✓ Operações de banco, atualização e filtro de expiração validados com sucesso.");

		// 2. Testando exibição no comando !status
		console.log("2. Testando exibição no comando !status...");
		const statusCmd = GeneralCommands.commands.find((c) => c.name === "status");
		assert.ok(statusCmd, "Comando !status deve existir");

		const msg = createMessage({ content: "!status", group: "120363000000777@g.us" });
		const result = await statusCmd.method(null, msg, [], null);
		const text = String(result?.content || "");

		assert.ok(text.includes("*Status das Ravenas*"), "Deve conter o header padrão de status");
		assert.ok(
			text.includes("📢 *Manutenção Programada*: O bot ficará instável das 14h às 16h."),
			"Deve incluir o primeiro aviso ativo no header"
		);
		assert.ok(
			text.includes("📢 _Aviso urgente_: Servidor de imagens _Kokoro_ atualizado! 🚀"),
			"Deve incluir o segundo aviso ativo no header"
		);
		assert.ok(
			!text.includes("Aviso antigo já expirado"),
			"NÃO deve incluir aviso expirado no comando !status"
		);
		console.log("✓ Comando !status exibe avisos ativos formatados no header corretamente.");

		// 3. Testando endpoints da BotAPI
		console.log("3. Testando endpoints da BotAPI...");
		const app = express();
		app.use(express.json());

		const pass = (req, res, next) => next();
		const sseMessages = [];
		const apiMock = {
			app,
			bots: [],
			authenticateBasic: pass,
			strictLimiter: pass,
			generalLimiter: pass,
			botStatsCache: { data: [] },
			isAdmin: () => true,
			setAdminSessionCookie: () => {},
			clearAdminSessionCookie: () => {},
			readWebManagementToken: () => null,
			logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
			database,
			serviceProviderService: {},
			lastServicesStatus: { test: "up" },
			sseClients: [],
			broadcastSSE: (event, data) => {
				sseMessages.push({ event, data });
			}
		};

		registerIndexRoutes(apiMock);
		registerInstancesRoutes(apiMock);

		server = await new Promise((resolve) => {
			const s = app.listen(0, "127.0.0.1", () => resolve(s));
		});
		const baseUrl = `http://127.0.0.1:${server.address().port}`;

		// GET /health deve trazer lista de avisos ativos
		const healthRes = await fetch(`${baseUrl}/health`);
		assert.strictEqual(healthRes.status, 200);
		const healthJson = await healthRes.json();
		assert.ok(Array.isArray(healthJson.announcements), "/health deve retornar array announcements");
		const healthActiveIds = healthJson.announcements.map((a) => a.id);
		assert.ok(healthActiveIds.includes(announcement1.id), "Aviso 1 deve estar no /health");

		// GET /api/status-announcements
		const listRes = await fetch(`${baseUrl}/api/status-announcements`);
		assert.strictEqual(listRes.status, 200);
		const listJson = await listRes.json();
		assert.strictEqual(listJson.status, "ok");
		assert.ok(Array.isArray(listJson.announcements));

		// POST /api/status-announcements com erro de validação (mensagem vazia)
		const invalidPost = await fetch(`${baseUrl}/api/status-announcements`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "   ", expiresAt: Date.now() + 60000 })
		});
		assert.strictEqual(invalidPost.status, 400, "Mensagem vazia deve retornar 400");

		// POST /api/status-announcements com data de expiração no passado
		const invalidExpiryPost = await fetch(`${baseUrl}/api/status-announcements`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "Teste", expiresAt: Date.now() - 60000 })
		});
		assert.strictEqual(invalidExpiryPost.status, 400, "Data no passado deve retornar 400");

		// POST /api/status-announcements criando com sucesso
		const validPost = await fetch(`${baseUrl}/api/status-announcements`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: "*Novo aviso via API*",
				expiresAt: Date.now() + 86400 * 1000
			})
		});
		assert.strictEqual(validPost.status, 201, "Criação válida deve retornar 201");
		const createdJson = await validPost.json();
		assert.strictEqual(createdJson.status, "ok");
		assert.ok(createdJson.announcement.id);
		const apiCreatedId = createdJson.announcement.id;
		createdIds.push(apiCreatedId);

		// Confirma que emitiu evento SSE
		const sseEvent = sseMessages.find((m) => m.event === "status-announcements");
		assert.ok(sseEvent, "Deve ter transmitido evento SSE 'status-announcements'");

		// PUT /api/status-announcements/:id atualizando com sucesso
		const putRes = await fetch(`${baseUrl}/api/status-announcements/${apiCreatedId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: "*Aviso Editado via API*",
				expiresAt: Date.now() + 172800 * 1000
			})
		});
		assert.strictEqual(putRes.status, 200, "Atualização válida deve retornar 200");
		const putJson = await putRes.json();
		assert.strictEqual(putJson.status, "ok");
		assert.strictEqual(putJson.announcement.message, "*Aviso Editado via API*");

		// PUT /api/status-announcements/:id com ID inexistente retorna 404
		const notFoundPut = await fetch(`${baseUrl}/api/status-announcements/99999999`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: "Não existe",
				expiresAt: Date.now() + 60000
			})
		});
		assert.strictEqual(notFoundPut.status, 404, "ID inexistente deve retornar 404");

		// DELETE /api/status-announcements/:id
		const delRes = await fetch(`${baseUrl}/api/status-announcements/${apiCreatedId}`, {
			method: "DELETE"
		});
		assert.strictEqual(delRes.status, 200, "Deleção deve retornar 200");
		const delJson = await delRes.json();
		assert.strictEqual(delJson.status, "ok");

		// Limpa os avisos criados no teste
		await database.deleteStatusAnnouncement(announcement1.id);
		await database.deleteStatusAnnouncement(announcement2.id);
		await database.deleteStatusAnnouncement(expiredAnnouncement.id);

		console.log("✓ Endpoints da BotAPI validados com sucesso.");
	} finally {
		if (server) {
			await new Promise((resolve) => server.close(resolve));
		}
		for (const id of createdIds) {
			try {
				await database.deleteStatusAnnouncement(id);
			} catch (_) {}
		}
	}

	console.log("🎉 Todos os testes de avisos de status passaram com sucesso!");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes de avisos de status:", err);
		process.exit(1);
	});
