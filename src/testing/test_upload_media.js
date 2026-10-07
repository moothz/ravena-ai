"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const { registerManagementRoutes } = require("../BotAPI/routes/managementRoutes");
const Database = require("../utils/Database");
const WebManagement = require("../utils/WebManagement");

async function main() {
	const wm = WebManagement.getInstance();
	const db = Database.getInstance();
	const expiredToken = "test_expired_" + Date.now();
	const validToken = "test_valid_" + Date.now();
	const groupId = "120363406560749096@g.us";

	await wm.saveToken({
		token: expiredToken,
		requestNumber: "5511999999999",
		authorName: "Tester Expired",
		groupName: "Test Group",
		groupId,
		botId: "rav-arkanis",
		createdAt: new Date(Date.now() - 3600000).toISOString(),
		expiresAt: new Date(Date.now() - 1800000).toISOString()
	});

	await wm.saveToken({
		token: validToken,
		requestNumber: "5511999999999",
		authorName: "Tester Valid",
		groupName: "Test Group",
		groupId,
		botId: "rav-arkanis",
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 1800000).toISOString()
	});

	// Mock BotAPI para testar as rotas isoladamente
	const app = express();
	app.use(express.json());
	app.use(express.urlencoded({ extended: true }));

	const mockApi = {
		app,
		bots: [],
		authenticateBasic: (req, res, next) => next(),
		strictLimiter: (req, res, next) => next(),
		generalLimiter: (req, res, next) => next(),
		logger: {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {}
		},
		database: db,
		readWebManagementToken: (token) => wm.getToken(token)
	};

	registerManagementRoutes(mockApi);

	const server = app.listen(0);
	const port = server.address().port;
	const baseUrl = `http://localhost:${port}`;

	const testFilePath = path.join(__dirname, "test_dummy.txt");
	fs.writeFileSync(testFilePath, "dummy content for test");

	try {
		// Teste 1: Sem parâmetros obrigatórios
		try {
			await axios.post(`${baseUrl}/api/upload-media`, {});
			assert.fail("Deveria falhar com 400");
		} catch (err) {
			assert.strictEqual(err.response?.status, 400);
			assert.strictEqual(err.response?.data?.success, false);
			assert.match(err.response?.data?.message, /Parâmetros obrigatórios/);
			console.log(
				"✅ Teste 1 passou: Retorna 400 com mensagem clara sobre parâmetros obrigatórios."
			);
		}

		// Teste 2: Token expirado
		const formExpired = new FormData();
		formExpired.append("token", expiredToken);
		formExpired.append("groupId", groupId);
		formExpired.append("type", "command");
		formExpired.append("name", Date.now().toString());
		formExpired.append("caption", "teste");
		formExpired.append("file", fs.createReadStream(testFilePath));

		try {
			await axios.post(`${baseUrl}/api/upload-media`, formExpired, {
				headers: formExpired.getHeaders()
			});
			assert.fail("Deveria falhar com 401");
		} catch (err) {
			assert.strictEqual(err.response?.status, 401);
			assert.strictEqual(err.response?.data?.success, false);
			assert.match(err.response?.data?.message, /Token expirado/);
			console.log("✅ Teste 2 passou: Token expirado retorna 401 com mensagem detalhada.");
		}

		// Teste 3: Token válido
		const formValid = new FormData();
		formValid.append("token", validToken);
		formValid.append("groupId", groupId);
		formValid.append("type", "command");
		formValid.append("name", Date.now().toString());
		formValid.append("caption", "teste sucesso");
		formValid.append("file", fs.createReadStream(testFilePath));

		const res = await axios.post(`${baseUrl}/api/upload-media`, formValid, {
			headers: formValid.getHeaders()
		});

		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.data?.success, true);
		assert.ok(res.data?.fileName);
		console.log("✅ Teste 3 passou: Upload com token válido retorna 200 e fileName.");
	} finally {
		server.close();
		if (fs.existsSync(testFilePath)) {
			fs.unlinkSync(testFilePath);
		}
	}

	process.exit(0);
}

main().catch((err) => {
	console.error("Erro no teste:", err);
	process.exit(1);
});
