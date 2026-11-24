// src/testing/test_dossie_slots.js
// Bloco de caça-coisas (slots) no dossiê 360º. Usa o schema que o próprio SlotsGame cria e os
// comandos reais (!slots grava, !sa-userdossie lê), em SQLites temporários (só a core de data/
// é aberta pelo construtor do Database, e aqui só é lida).

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dossie-slots-"));
const Database = require("../utils/Database");
const database = Database.getInstance({ disableBackup: true, testMode: false });
// Antes dos módulos que abrem bancos: slots, memory, fishing etc. nascem no diretório temporário.
database.mappers.databasePath = tmpDir;

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

// Sem rede e sem evento global mudando as chances.
ShadowGardenBonusService.syncUserBonuses = async () => {};
GameEventService.getMultiplier = () => 1.0;
GameEventService.getEventBanner = () => "";

/** Roda `!slots <quantidade>` com os símbolos dados por giro (índices em sequência). */
async function girar(author, quantidade, indices) {
	const slots = SlotsGame.commands.find((c) => c.name === "slots");
	const original = Math.random;
	let i = 0;
	// Três símbolos por giro; fora da sequência (sorteio de prêmio) repete o ciclo.
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

	// 1. Quem jogou: o dossiê mostra as moedinhas e os giros gravados pelo !slots.
	const jid = "5511999990001@s.whatsapp.net";
	const canonical = await identidade(jid, "jid");
	await SlotsGame.addCoins(jid, 7); // 5 iniciais + 7 = 12
	await girar(jid, 3, derrota); // 12 - 3 = 9, sem vitória

	const texto = await textoDossie(canonical);
	assert.ok(
		texto.includes("🎰 *Slots:* 9 fichas (3 apostas)"),
		`o dossiê deve mostrar o bloco de slots. Recebido:\n${texto}`
	);
	// Campos que a API /api/dossies/user/:id entrega às páginas (dossies.js e admin/pessoas.js).
	assert.deepStrictEqual((await memoryService.getUser360(canonical)).games.slots, {
		coins: 9,
		total_bets: 3,
		total_wins: 0
	});
	console.log("✓ Jogador com giros: bloco de slots com saldo e apostas.");

	// 2. Os giros acumulam entre comandos (não é a contagem de comandos).
	await girar(jid, 2, derrota);
	assert.ok((await textoDossie(jid)).includes("🎰 *Slots:* 7 fichas (5 apostas)"));
	console.log("✓ Apostas = giros acumulados.");

	// 3. Quem joga por LID fica gravado só com dígitos, igual ao que o dossiê procura.
	const lid = "120363000000001@lid";
	const canonicalLid = await identidade(lid, "lid");
	await girar(lid, 1, derrota);
	assert.ok((await textoDossie(canonicalLid)).includes("🎰 *Slots:* 4 fichas (1 apostas)"));
	console.log("✓ Jogador por LID também aparece.");

	// 4. Quem nunca jogou não ganha bloco de slots.
	const semJogo = await identidade("5511999990002@s.whatsapp.net", "jid");
	const textoSemJogo = await textoDossie(semJogo);
	assert.ok(textoSemJogo.includes("DOSSIÊ 360º"), "o dossiê existe");
	assert.ok(!textoSemJogo.includes("Slots"), "sem registro não há bloco de slots");
	console.log("✓ Sem registro, sem bloco.");

	// 5. Falha do banco de slots não derruba o dossiê, mas fica no log, sem o telefone.
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
