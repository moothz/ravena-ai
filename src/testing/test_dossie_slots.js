process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dossie-slots-"));
const Database = require("../utils/Database");
const database = Database.getInstance({ disableBackup: true, testMode: false });
function openNextDatabasesIn(dir) {
	database.mappers.databasePath = dir;
}
openNextDatabasesIn(tmpDir);

const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const SlotsGame = require("../functions/SlotsGame");
const GameEventService = require("../services/GameEventService");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
const MemoryService = require("../services/MemoryService");
const SuperAdmin = require("../commands/SuperAdmin");

const ADMIN = "5511999990009@s.whatsapp.net";
const GROUP = "120363000000000099@g.us";

const bot = new FakeBot({ id: "teste", testMode: false });
const memoryService = MemoryService.getInstance();
const superAdmin = new SuperAdmin();
superAdmin.isSuperAdmin = (id) => id === ADMIN;

ShadowGardenBonusService.syncUserBonuses = async () => {};
GameEventService.getMultiplier = () => 1.0;
GameEventService.getEventBanner = () => "";

async function girar(author, quantidade, indices) {
	const slots = SlotsGame.commands.find((c) => c.name === "slots");
	const original = Math.random;
	let i = 0;
	Math.random = () => indices[i++ % indices.length] / 10 + 0.05;
	try {
		const msg = createMessage({
			content: `!slots ${quantidade}`,
			group: GROUP,
			author,
			authorName: "Testador"
		});
		return await slots.method(bot, msg, [String(quantidade)], { id: GROUP });
	} finally {
		Math.random = original;
	}
}

async function textoDossie(alvo) {
	const msg = createMessage({ content: `!sa-userdossie ${alvo}`, author: ADMIN });
	return (await superAdmin.getUserDossier(bot, msg, [alvo])).content;
}

async function identidade(platformId, idType) {
	return memoryService.resolveCanonicalUserId("whatsapp", platformId, idType, "Testador");
}

async function runTests() {
	const derrota = [0, 1, 2];

	const jid = "5511999990001@s.whatsapp.net";
	const canonical = await identidade(jid, "jid");
	await SlotsGame.addCoins(jid, 7);
	await girar(jid, 3, derrota);

	const texto = await textoDossie(canonical);
	assert.ok(
		texto.includes("🎰 *Slots:* 9 fichas (3 apostas)"),
		`o dossiê deve mostrar o bloco de slots. Recebido:\n${texto}`
	);
	assert.deepStrictEqual((await memoryService.getUser360(canonical)).games.slots, {
		coins: 9,
		total_bets: 3,
		total_wins: 0
	});
	console.log("✓ Jogador com giros: bloco de slots com saldo e apostas.");

	await girar(jid, 2, derrota);
	assert.ok((await textoDossie(jid)).includes("🎰 *Slots:* 7 fichas (5 apostas)"));
	console.log("✓ Apostas = giros acumulados.");

	const lid = "120363000000001@lid";
	const canonicalLid = await identidade(lid, "lid");
	await girar(lid, 1, derrota);
	assert.ok((await textoDossie(canonicalLid)).includes("🎰 *Slots:* 4 fichas (1 apostas)"));
	console.log("✓ Jogador por LID também aparece.");

	const semJogo = await identidade("5511999990002@s.whatsapp.net", "jid");
	const textoSemJogo = await textoDossie(semJogo);
	assert.ok(textoSemJogo.includes("DOSSIÊ 360º"), "o dossiê existe");
	assert.ok(!textoSemJogo.includes("Slots"), "sem registro não há bloco de slots");
	console.log("✓ Sem registro, sem bloco.");

	const avisos = [];
	memoryService.logger.warn = (...args) => avisos.push(args.map(String).join(" "));
	database.mappers.exec("slots", "ALTER TABLE slots_users RENAME TO slots_users_fora");
	const textoComFalha = await textoDossie(canonical);
	assert.ok(textoComFalha.includes("DOSSIÊ 360º"), "o resto do dossiê continua");
	assert.ok(!textoComFalha.includes("Slots"));
	assert.strictEqual(avisos.length, 1, "a falha da consulta de slots deve ir para o log");
	assert.ok(avisos[0].includes("slots"), avisos[0]);
	assert.ok(!avisos[0].includes("5511999990001"), "o log não leva o telefone");
	console.log("✓ Falha na consulta de slots vai para o log.");
}

runTests()
	.then(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		console.log("✅ Dossiê de slots OK.");
		process.exit(0);
	})
	.catch((err) => {
		console.error("❌ Falha no teste do dossiê de slots:", err);
		fs.rmSync(tmpDir, { recursive: true, force: true });
		process.exit(1);
	});
