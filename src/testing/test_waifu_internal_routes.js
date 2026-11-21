// src/testing/test_waifu_internal_routes.js
// Testes das rotas internas de rolls/fazenda (/api/waifu/*) em featuresRoutes.js:
// autenticação X-Market-Secret, leitura de contexto, reserva atômica concorrente e estorno.

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const DonorBonusService = require("../services/DonorBonusService");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
const GameEventService = require("../services/GameEventService");
const WaifuMarriagePhotoHelper = require("../utils/WaifuMarriagePhotoHelper");

const tempMarriagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-marriages-"));
const origGetMarriagesDir = WaifuMarriagePhotoHelper.getMarriagesDir;
const origGenMarriage = WaifuMarriagePhotoHelper.generateAndSaveMarriageImage;
const origRevertMarriage = WaifuMarriagePhotoHelper.revertMarriagePhoto;

WaifuMarriagePhotoHelper.getMarriagesDir = () => tempMarriagesDir;
WaifuMarriagePhotoHelper.generateAndSaveMarriageImage = async (_bot, _msg, character) => {
	const cur = path.join(tempMarriagesDir, `${character.id}.jpg`);
	const prev = path.join(tempMarriagesDir, `${character.id}_prev.jpg`);
	if (fs.existsSync(cur)) fs.copyFileSync(cur, prev);
	fs.writeFileSync(cur, "new-jpg");
	return { success: true, photoPath: cur };
};
WaifuMarriagePhotoHelper.revertMarriagePhoto = async (characterId) => {
	const prev = path.join(tempMarriagesDir, `${characterId}_prev.jpg`);
	if (!fs.existsSync(prev)) {
		return { success: false, message: "Nenhuma foto anterior." };
	}
	return { success: true, message: "Revertida com sucesso!" };
};

const { registerFeaturesRoutes } = require("../BotAPI/routes/featuresRoutes");

const VALID_SECRET = "segredo-de-teste-waifu-internal-0123456789";

async function startServer() {
	const app = express();
	app.set("trust proxy", true);
	app.use(express.json());
	const pass = (req, res, next) => next();

	registerFeaturesRoutes({
		app,
		generalLimiter: pass,
		strictLimiter: pass,
		logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
		database: { databasePath: "/nonexistent", dbAll: async () => [], dbGet: async () => null }
	});

	const server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const { port } = server.address();
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: () => new Promise((resolve) => server.close(resolve))
	};
}

async function runTests() {
	process.env.MARKET_API_SECRET = VALID_SECRET;

	// Mock controlado em memória dos serviços da Ravena
	let memRolls = 1;
	let memTickets = 1;

	const origDonor = DonorBonusService.getWaifuRollBonuses;
	const origGetBonus = ShadowGardenBonusService.getWaifuBonus;
	const origReserve = ShadowGardenBonusService.reserveWaifuBonus;
	const origRefund = ShadowGardenBonusService.refundWaifuBonus;
	const origEvent = GameEventService.getMultiplier;

	DonorBonusService.getWaifuRollBonuses = async () => ({
		donorBadge: "VIP Doador 💎",
		extraMaxRolls: 4,
		rarityMultipliers: { RARE: 1.5, EPIC: 1.8, LEGENDARY: 1.5 }
	});
	ShadowGardenBonusService.getWaifuBonus = async () => ({
		rolls: memRolls,
		tickets: memTickets
	});
	ShadowGardenBonusService.reserveWaifuBonus = async () => {
		if (memTickets > 0) {
			memTickets -= 1;
			return { reserved: true, type: "ticket" };
		}
		if (memRolls > 0) {
			memRolls -= 1;
			return { reserved: true, type: "roll" };
		}
		return { reserved: false };
	};
	ShadowGardenBonusService.refundWaifuBonus = async (_userId, type) => {
		if (type === "ticket") memTickets += 1;
		else if (type === "roll") memRolls += 1;
		return true;
	};
	GameEventService.getMultiplier = () => 1.0;

	const srv = await startServer();

	try {
		// 1. Sem X-Market-Secret deve recusar com 401
		const unauth = await fetch(`${srv.baseUrl}/api/waifu/user-roll-context/5511999999999`);
		assert.strictEqual(unauth.status, 401);

		// 2. GET user-roll-context retorna bônus consolidados
		const ctxRes = await fetch(`${srv.baseUrl}/api/waifu/user-roll-context/5511999999999`, {
			headers: { "X-Market-Secret": VALID_SECRET }
		});
		assert.strictEqual(ctxRes.status, 200);
		const ctxJson = await ctxRes.json();
		assert.strictEqual(ctxJson.success, true);
		assert.strictEqual(ctxJson.data.extraMaxRolls, 4);
		assert.strictEqual(ctxJson.data.farmRolls, 1);
		assert.strictEqual(ctxJson.data.farmTickets, 1);

		// 3. Concorrência: 4 reservas simultâneas com apenas 1 ticket + 1 roll -> exatamente 2 reservam
		const reserves = await Promise.all(
			[1, 2, 3, 4].map(() =>
				fetch(`${srv.baseUrl}/api/waifu/farm-bonus/reserve`, {
					method: "POST",
					headers: { "X-Market-Secret": VALID_SECRET, "Content-Type": "application/json" },
					body: JSON.stringify({ userId: "5511999999999" })
				}).then((r) => r.json())
			)
		);
		const succeeded = reserves.filter((r) => r.data?.reserved === true);
		const types = succeeded.map((r) => r.data.type).sort();
		assert.strictEqual(succeeded.length, 2);
		assert.deepStrictEqual(types, ["roll", "ticket"]);

		// 4. Refund devolve ticket corretamente
		const refRes = await fetch(`${srv.baseUrl}/api/waifu/farm-bonus/refund`, {
			method: "POST",
			headers: { "X-Market-Secret": VALID_SECRET, "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "5511999999999", type: "ticket" })
		});
		const refJson = await refRes.json();
		assert.strictEqual(refRes.status, 200);
		assert.strictEqual(refJson.refunded, true);
		assert.strictEqual(memTickets, 1);

		// 5. Refund com type inválido retorna 400
		const badRef = await fetch(`${srv.baseUrl}/api/waifu/farm-bonus/refund`, {
			method: "POST",
			headers: { "X-Market-Secret": VALID_SECRET, "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "5511999999999", type: "invalid" })
		});
		assert.strictEqual(badRef.status, 400);

		// 6. Rotas internas de Foto do Casamento: auth, path traversal, generate & revert
		const photoNoAuth = await fetch(`${srv.baseUrl}/api/waifu/marriage-photo/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "5511999999999", character: { id: "rem", name: "Rem" } })
		});
		assert.strictEqual(photoNoAuth.status, 401);

		const badTraversal = await fetch(`${srv.baseUrl}/api/waifu/marriage-photo/generate`, {
			method: "POST",
			headers: { "X-Market-Secret": VALID_SECRET, "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "5511999999999", character: { id: "../etc", name: "Rem" } })
		});
		assert.strictEqual(badTraversal.status, 400);

		// Primeira geração: não havia foto antes (existedBefore = false, hasPrevious = false)
		const gen1 = await fetch(`${srv.baseUrl}/api/waifu/marriage-photo/generate`, {
			method: "POST",
			headers: { "X-Market-Secret": VALID_SECRET, "Content-Type": "application/json" },
			body: JSON.stringify({
				userId: "5511999999999",
				userName: "Tester",
				character: { id: "rem-test", name: "Rem", imageUrl: "/media/characters/rem/1.jpg" }
			})
		}).then((r) => r.json());
		assert.strictEqual(gen1.success, true);
		assert.strictEqual(gen1.data.existedBefore, false);
		assert.strictEqual(gen1.data.hasPrevious, false);

		// Segunda geração: substitui foto existente e cria backup -> hasPrevious = true
		const gen2 = await fetch(`${srv.baseUrl}/api/waifu/marriage-photo/generate`, {
			method: "POST",
			headers: { "X-Market-Secret": VALID_SECRET, "Content-Type": "application/json" },
			body: JSON.stringify({
				userId: "5511999999999",
				userName: "Tester",
				character: { id: "rem-test", name: "Rem", imageUrl: "/media/characters/rem/1.jpg" }
			})
		}).then((r) => r.json());
		assert.strictEqual(gen2.success, true);
		assert.strictEqual(gen2.data.existedBefore, true);
		assert.strictEqual(gen2.data.hasPrevious, true);

		// Reverte para foto anterior
		const rev = await fetch(`${srv.baseUrl}/api/waifu/marriage-photo/revert`, {
			method: "POST",
			headers: { "X-Market-Secret": VALID_SECRET, "Content-Type": "application/json" },
			body: JSON.stringify({ characterId: "rem-test" })
		}).then((r) => r.json());
		assert.strictEqual(rev.success, true);
		assert.strictEqual(rev.data.characterId, "rem-test");

		console.log("✅ test_waifu_internal_routes.js: todos os cenários passaram!");
	} finally {
		DonorBonusService.getWaifuRollBonuses = origDonor;
		ShadowGardenBonusService.getWaifuBonus = origGetBonus;
		ShadowGardenBonusService.reserveWaifuBonus = origReserve;
		ShadowGardenBonusService.refundWaifuBonus = origRefund;
		GameEventService.getMultiplier = origEvent;
		WaifuMarriagePhotoHelper.getMarriagesDir = origGetMarriagesDir;
		WaifuMarriagePhotoHelper.generateAndSaveMarriageImage = origGenMarriage;
		WaifuMarriagePhotoHelper.revertMarriagePhoto = origRevertMarriage;
		fs.rmSync(tempMarriagesDir, { recursive: true, force: true });
		await srv.close();
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha em test_waifu_internal_routes.js:", err);
		process.exit(1);
	});
