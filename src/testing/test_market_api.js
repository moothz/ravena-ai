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
			// Simula que o ofertante possui qualquer buff consultado
			dbGet: async (dbName, sql, params = []) =>
				dbName === "fishing" && /FROM fishing_buffs/.test(sql)
					? { id: params[0], effect_type: "inventory_slot" }
					: null
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

async function testInventoryListing(baseUrl) {
	console.log("\n[5] Inventário lista sementes por type/category e ignora quantidade 0...");
	const r = await request(baseUrl, "GET", "/api/market/user-inventory/5511900000001", {
		secret: VALID_SECRET
	});
	assert.strictEqual(r.status, 200);
	const items = r.data?.farm?.items || [];
	const byId = Object.fromEntries(items.map((it) => [it.itemId, it]));
	assert.ok(byId.seed_ok, "Semente com category 'seed' deve aparecer");
	assert.strictEqual(byId.seed_ok.type, "seed");
	assert.strictEqual(byId.seed_ok.quantity, 2);
	assert.ok(!byId.seed_zero, "Item com quantidade 0 não pode virar 1 nem aparecer");
	assert.ok(!byId.crop_x, "Colheitas não entram no inventário do mercado");
	assert.strictEqual(byId.elixir_a?.quantity, 3);
	assert.strictEqual(byId.decor_x?.quantity, 1);
	console.log("✓ Sementes (category) listadas e itens zerados ignorados.");
}

async function testTransferValidation(baseUrl, mocks) {
	const base = { fromUserId: "5511900000001", toUserId: "5511900000002" };
	const post = (body) =>
		request(baseUrl, "POST", "/api/market/transfer", { secret: VALID_SECRET, body });

	console.log("\n[6] Quantidades inválidas são rejeitadas com 400 sem nenhuma transferência...");
	const invalidBodies = [
		{ ...base, runas: -50 },
		{ ...base, runas: 1.5 },
		{ ...base, runas: "abc" },
		{ ...base, runas: true },
		{ ...base, petalitas: -10 },
		{ ...base, petalitas: 2.25 },
		{ ...base, farmItems: [{ itemId: "elixir_a", amount: -1 }] },
		{ ...base, farmItems: [{ itemId: "elixir_a", amount: 0 }] },
		{ ...base, farmItems: [{ itemId: "elixir_a", amount: 1.5 }] },
		{ ...base, farmItems: [{ itemId: "", amount: 1 }] },
		{ ...base, farmItems: "elixir_a" },
		{ ...base, fishingBuffIds: [-3] },
		{ ...base, fishingBuffIds: [1.5] },
		{ ...base, fishingBuffIds: ["abc"] },
		{ ...base, buffs: [{ id: 0 }] },
		{ ...base, fishingBuffIds: "7" },
		{ ...base, toUserId: base.fromUserId, runas: 10 },
		{ ...base, fromUserId: { $ne: null }, runas: 10 }
	];
	for (const body of invalidBodies) {
		const r = await post(body);
		assert.strictEqual(r.status, 400, `Deveria rejeitar com 400: ${JSON.stringify(body)}`);
		assert.strictEqual(r.data?.success, false);
	}
	assert.strictEqual(mocks.calls.transferRunas.length, 0, "Nenhuma Runa pode ser movida");
	assert.strictEqual(mocks.calls.transferBuff.length, 0, "Nenhum buff pode ser movido");
	assert.strictEqual(mocks.calls.transferItems.length, 0, "Nada da fazenda pode ser movido");
	console.log(`✓ ${invalidBodies.length} payloads inválidos rejeitados com 400.`);

	console.log("\n[7] Itens repetidos da fazenda são agregados antes de validar estoque...");
	// elixir_a tem 3 unidades: 2 + 2 = 4 deve falhar mesmo que cada entrada isolada caiba
	let r = await post({
		...base,
		farmItems: [
			{ itemId: "elixir_a", name: "Elixir A", amount: 2 },
			{ itemId: "elixir_a", name: "Elixir A", amount: 2 }
		]
	});
	assert.strictEqual(r.status, 400, "Soma 4 > estoque 3 deve falhar");
	assert.ok(r.data?.reason?.includes("requer 4"), `Motivo deve citar o total: ${r.data?.reason}`);
	assert.strictEqual(mocks.calls.transferItems.length, 0);

	r = await post({
		...base,
		farmItems: [
			{ itemId: "elixir_a", amount: 1 },
			{ itemId: "elixir_a", quantity: "2" },
			{ itemId: "seed_ok" }
		]
	});
	assert.strictEqual(r.status, 200, `Soma 3 <= estoque 3 deve passar (${JSON.stringify(r.data)})`);
	assert.strictEqual(mocks.calls.transferItems.length, 1);
	const [, , sentItems, sentCoins] = mocks.calls.transferItems[0];
	assert.deepStrictEqual(
		sentItems,
		[
			{ itemId: "elixir_a", amount: 3 },
			{ itemId: "seed_ok", amount: 1 }
		],
		"Itens enviados ao Jardim devem estar agregados por itemId"
	);
	assert.strictEqual(sentCoins, 0, "Sem petalitas, coins = 0");
	console.log("✓ farmItems agregados por itemId (validação e envio).");

	console.log("\n[8] IDs de buff duplicados são deduplicados e strings numéricas aceitas...");
	mocks.reset();
	r = await post({ ...base, runas: "0", petalitas: 0, fishingBuffIds: [7, "7", { id: 8 }, 8] });
	assert.strictEqual(r.status, 200, `Buffs válidos devem passar (${JSON.stringify(r.data)})`);
	assert.strictEqual(r.data?.buffsCount, 2, "Buffs repetidos devem ser contados uma vez");
	assert.deepStrictEqual(
		mocks.calls.transferBuff.map((c) => c[2]),
		[7, 8],
		"Cada buff deve ser transferido uma única vez"
	);
	assert.strictEqual(mocks.calls.transferRunas.length, 0, "runas: '0' não transfere Runas");
	console.log("✓ fishingBuffIds deduplicados.");

	console.log("\n[9] Payload legítimo do Waifuletes continua funcionando...");
	mocks.reset();
	r = await post({
		...base,
		runas: 25,
		petalitas: 100,
		fishes: [],
		buffs: [{ id: 11, type: "inventory_slot" }],
		fishingBuffIds: [11],
		farmItems: [{ itemId: "decor_x", name: "Decoração X", type: "decoration", quantity: 1 }]
	});
	assert.strictEqual(
		r.status,
		200,
		`Transferência completa deve passar (${JSON.stringify(r.data)})`
	);
	assert.strictEqual(mocks.calls.transferRunas[0][2], 25);
	assert.deepStrictEqual(mocks.calls.transferItems[0][2], [{ itemId: "decor_x", amount: 1 }]);
	assert.strictEqual(mocks.calls.transferItems[0][3], 100);
	console.log("✓ Runas, buffs, itens e petalitas transferidos.");
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
		mocks.reset();
		await testInventoryListing(server.baseUrl);
		await testTransferValidation(server.baseUrl, mocks);
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
