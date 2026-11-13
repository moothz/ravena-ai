// src/testing/test_market_api.js
// Testes das rotas internas de mercado (/api/market/*) chamadas pela API do Waifuletes:
// autenticação servidor-a-servidor (X-Market-Secret), falha fechada e rate limit dedicado.

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const express = require("express");

const bankService = require("../services/BankService");
const FishingGame = require("../functions/FishingGame");
const ShadowGardenClient = require("../services/ShadowGardenClient");
const { registerFeaturesRoutes } = require("../BotAPI/routes/featuresRoutes");

const VALID_SECRET = "segredo-de-teste-mercado-0123456789";

const silentLogger = {
	info: () => {},
	debug: () => {},
	warn: () => {},
	error: () => {}
};

/**
 * Sobe um app express mínimo com as rotas de features registradas
 * @returns {Promise<{ baseUrl: string, close: Function, warnings: string[] }>}
 */
async function startServer() {
	const warnings = [];
	const app = express();
	app.set("trust proxy", true);
	app.use(express.json());

	const passThrough = (req, res, next) => next();
	const api = {
		app,
		generalLimiter: passThrough,
		strictLimiter: passThrough,
		logger: { ...silentLogger, warn: (msg) => warnings.push(String(msg)) },
		database: {
			databasePath: "/nonexistent",
			dbAll: async () => [],
			dbGet: async () => null
		}
	};
	registerFeaturesRoutes(api);

	const server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const { port } = server.address();
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		warnings,
		close: () => new Promise((resolve) => server.close(resolve))
	};
}

async function request(baseUrl, method, path, { secret, body } = {}) {
	const headers = { "Content-Type": "application/json" };
	if (secret !== undefined) headers["X-Market-Secret"] = secret;
	const res = await fetch(`${baseUrl}${path}`, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	let data = null;
	try {
		data = await res.json();
	} catch (_) {}
	return { status: res.status, data };
}

/**
 * Instala mocks de Banco, Pesca e Jardim; retorna o registro de chamadas e a função de restauração
 */
function installMocks() {
	const calls = { transferRunas: [], transferBuff: [], transferItems: [] };
	const originals = {
		getAccount: bankService.getAccount,
		getRates: bankService.getRates,
		transferRunas: bankService.transferRunas,
		getAllFishingUserIds: FishingGame.getAllFishingUserIds,
		checkBuffTransferCapacity: FishingGame.checkBuffTransferCapacity,
		transferBuff: FishingGame.transferBuff,
		getStatus: ShadowGardenClient.prototype.getStatus,
		getInventory: ShadowGardenClient.prototype.getInventory,
		transferItems: ShadowGardenClient.prototype.transferItems
	};

	bankService.getAccount = async () => ({ runas: 500 });
	bankService.getRates = async () => ({ runasPerZinthos: 0.3, runasPerJardimCoin: 0.1 });
	bankService.transferRunas = async (...args) => {
		calls.transferRunas.push(args);
		return { success: true };
	};
	FishingGame.getAllFishingUserIds = (id) => [String(id)];
	FishingGame.checkBuffTransferCapacity = async () => ({ ok: true });
	FishingGame.transferBuff = async (...args) => {
		calls.transferBuff.push(args);
		return { success: true };
	};
	ShadowGardenClient.prototype.getStatus = async () => ({ coins: 1000 });
	ShadowGardenClient.prototype.getInventory = async () => ({
		items: [
			{ itemId: "elixir_a", name: "Elixir A", type: "consumable", quantity: 3 },
			{ itemId: "seed_ok", name: "Semente OK", category: "seed", quantity: 2 },
			{ itemId: "seed_zero", name: "Semente Zerada", type: "seed", quantity: 0 },
			{ itemId: "decor_x", name: "Decoração X", type: "decoration", quantity: 1 },
			{ itemId: "crop_x", name: "Colheita", type: "crop", quantity: 9 }
		]
	});
	ShadowGardenClient.prototype.transferItems = async (...args) => {
		calls.transferItems.push(args);
		return { success: true };
	};

	const restore = () => {
		bankService.getAccount = originals.getAccount;
		bankService.getRates = originals.getRates;
		bankService.transferRunas = originals.transferRunas;
		FishingGame.getAllFishingUserIds = originals.getAllFishingUserIds;
		FishingGame.checkBuffTransferCapacity = originals.checkBuffTransferCapacity;
		FishingGame.transferBuff = originals.transferBuff;
		ShadowGardenClient.prototype.getStatus = originals.getStatus;
		ShadowGardenClient.prototype.getInventory = originals.getInventory;
		ShadowGardenClient.prototype.transferItems = originals.transferItems;
	};

	const reset = () => {
		calls.transferRunas.length = 0;
		calls.transferBuff.length = 0;
		calls.transferItems.length = 0;
	};

	return { calls, restore, reset };
}

async function testAuth(baseUrl, warnings, mocks) {
	const transferBody = { fromUserId: "5511900000001", toUserId: "5511900000002", runas: 10 };

	console.log("\n[1] Falha fechada sem MARKET_API_SECRET...");
	delete process.env.MARKET_API_SECRET;
	let r = await request(baseUrl, "GET", "/api/market/user-inventory/5511900000001", {
		secret: VALID_SECRET
	});
	assert.strictEqual(r.status, 503, "Sem segredo configurado deve responder 503");
	assert.strictEqual(r.data?.success, false);
	assert.strictEqual(r.data?.reason, "MARKET_API_SECRET não configurado");
	r = await request(baseUrl, "POST", "/api/market/transfer", {
		secret: VALID_SECRET,
		body: transferBody
	});
	assert.strictEqual(r.status, 503, "Transferência sem segredo configurado deve responder 503");
	assert.strictEqual(mocks.calls.transferRunas.length, 0, "Nada pode ser transferido com 503");
	const missingWarnings = warnings.filter((w) => w.includes("MARKET_API_SECRET"));
	assert.strictEqual(missingWarnings.length, 1, "O aviso de segredo ausente deve ser logado 1 vez");
	console.log("✓ 503 sem segredo configurado (aviso logado uma única vez).");

	console.log("\n[2] Segredo curto (< 16 caracteres) também falha fechado...");
	process.env.MARKET_API_SECRET = "curto123";
	r = await request(baseUrl, "GET", "/api/market/user-inventory/5511900000001", {
		secret: "curto123"
	});
	assert.strictEqual(r.status, 503, "Segredo com menos de 16 caracteres deve responder 503");
	console.log("✓ 503 com segredo curto.");

	process.env.MARKET_API_SECRET = VALID_SECRET;

	console.log("\n[3] Requisições sem header ou com segredo errado recebem 401...");
	r = await request(baseUrl, "POST", "/api/market/transfer", { body: transferBody });
	assert.strictEqual(r.status, 401, "Sem X-Market-Secret deve responder 401");
	r = await request(baseUrl, "POST", "/api/market/transfer", {
		secret: "segredo-errado-mas-bem-comprido-0000",
		body: transferBody
	});
	assert.strictEqual(r.status, 401, "Segredo errado deve responder 401");
	r = await request(baseUrl, "POST", "/api/market/transfer", {
		secret: VALID_SECRET.slice(0, -1),
		body: transferBody
	});
	assert.strictEqual(r.status, 401, "Segredo com tamanho diferente deve responder 401");
	r = await request(baseUrl, "GET", "/api/market/user-inventory/5511900000001", { secret: "" });
	assert.strictEqual(r.status, 401, "Header vazio deve responder 401");
	assert.strictEqual(
		mocks.calls.transferRunas.length,
		0,
		"Nenhuma transferência pode ocorrer sem autenticação"
	);
	console.log("✓ 401 para header ausente, vazio, errado e de tamanho diferente.");

	console.log("\n[4] Segredo correto libera as rotas (200)...");
	r = await request(baseUrl, "GET", "/api/market/user-inventory/5511900000001", {
		secret: VALID_SECRET
	});
	assert.strictEqual(r.status, 200, `Inventário autenticado deve responder 200 (${r.status})`);
	assert.strictEqual(r.data?.success, true);
	assert.strictEqual(r.data?.runas, 500);
	r = await request(baseUrl, "POST", "/api/market/transfer", {
		secret: VALID_SECRET,
		body: transferBody
	});
	assert.strictEqual(r.status, 200, `Transferência autenticada deve responder 200 (${r.status})`);
	assert.strictEqual(r.data?.success, true);
	assert.strictEqual(mocks.calls.transferRunas.length, 1, "Runas devem ser transferidas");
	console.log("✓ 200 com X-Market-Secret correto.");
}

async function testAuthFailureRateLimit(baseUrl) {
	console.log("\n[R] Rate limit de falhas de autenticação...");
	let limited = false;
	for (let i = 0; i < 30; i++) {
		const r = await request(baseUrl, "GET", "/api/market/user-inventory/5511900000001", {
			secret: "chute-de-forca-bruta-000000000000"
		});
		if (r.status === 429) {
			limited = true;
			break;
		}
		assert.strictEqual(r.status, 401);
	}
	assert.ok(limited, "Tentativas repetidas com segredo inválido devem ser limitadas (429)");
	console.log("✓ Força bruta no segredo é bloqueada com 429.");
}

async function runTests() {
	console.log("=== Testes das rotas internas de mercado (/api/market/*) ===");
	const originalSecret = process.env.MARKET_API_SECRET;
	delete process.env.MARKET_API_SECRET;

	const mocks = installMocks();
	const server = await startServer();
	try {
		await testAuth(server.baseUrl, server.warnings, mocks);
		// Deve ser o último: consome a cota de falhas do IP local
		await testAuthFailureRateLimit(server.baseUrl);
	} finally {
		mocks.restore();
		await server.close();
		if (originalSecret === undefined) delete process.env.MARKET_API_SECRET;
		else process.env.MARKET_API_SECRET = originalSecret;
	}

	console.log("\n=== Todos os testes das rotas de mercado passaram! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes de mercado:", err);
		process.exit(1);
	});
