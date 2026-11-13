// src/testing/test_waifu_display_name.js
// Nome de exibição de jogadores nas mensagens de waifu (resolveDisplayName):
// - usa só o apelido do grupo atual + apelido global (sem varrer a tabela de grupos)
// - nunca mostra apelido definido em OUTRO grupo
// - nunca mostra o telefone em texto puro (fallback mascarado)

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const WaifuCommands = require("../functions/WaifuCommands");
const GeneralCommands = require("../functions/GeneralCommands");

const USER_LOCAL = "5511900088001";
const USER_GLOBAL = "5511900088002";
const USER_OTHER_GROUP = "5511900088003";
const OTHER_GROUP_ID = "120363000088999@g.us";

async function runTests() {
	console.log("=== Testes do nome de exibição no Waifuletes ===");
	const db = Database.getInstance();
	db.testMode = false;

	const groupsQueries = [];
	const originalGetGroups = db.getGroups;
	const originalDbAll = db.dbAll;
	db.getGroups = async (...args) => {
		groupsQueries.push("getGroups");
		return originalGetGroups.apply(db, args);
	};
	db.dbAll = async (dbName, sql, params) => {
		if (/FROM groups/i.test(sql)) groupsQueries.push(sql);
		return originalDbAll.call(db, dbName, sql, params);
	};

	const currentGroup = {
		id: "120363000088001@g.us",
		nicks: [{ numero: `${USER_LOCAL}@c.us`, apelido: "Nick do Grupo Atual" }]
	};

	try {
		await db.saveGlobalNick(USER_GLOBAL, "Nick Global PV");
		db.mappers.run("core", "DELETE FROM groups WHERE id = ?", [OTHER_GROUP_ID]);
		db.mappers.run("core", "INSERT INTO groups (id, name, nicks) VALUES (?, ?, ?)", [
			OTHER_GROUP_ID,
			"Outro Grupo",
			JSON.stringify([{ numero: `${USER_OTHER_GROUP}@c.us`, apelido: "Nick de Outro Grupo" }])
		]);

		console.log("\n[1] Fallback nunca expõe o telefone...");
		assert.strictEqual(
			WaifuCommands.maskedPlayerName(`${USER_OTHER_GROUP}@s.whatsapp.net`),
			"Jogador ••••8003"
		);
		assert.strictEqual(WaifuCommands.maskedPlayerName("12"), "Jogador");
		assert.strictEqual(WaifuCommands.maskedPlayerName(null), "Jogador");
		console.log("✓ Fallback mascarado (só os 4 últimos dígitos).");

		console.log("\n[2] Hierarquia: grupo atual > global > fallback (sem outros grupos)...");
		groupsQueries.length = 0;
		const local = await WaifuCommands.resolveDisplayName(currentGroup, USER_LOCAL, "Push Local");
		assert.strictEqual(local, "Nick do Grupo Atual");

		const global = await WaifuCommands.resolveDisplayName(currentGroup, USER_GLOBAL, "Push Global");
		assert.strictEqual(global, "Nick Global PV");

		const withFallback = await WaifuCommands.resolveDisplayName(
			currentGroup,
			`${USER_OTHER_GROUP}@c.us`,
			"Push Outro"
		);
		assert.strictEqual(withFallback, "Push Outro", "Apelido de outro grupo não pode vazar");

		const noFallback = await WaifuCommands.resolveDisplayName(
			currentGroup,
			`${USER_OTHER_GROUP}@c.us`,
			null
		);
		assert.strictEqual(noFallback, "Jogador ••••8003", "Sem nome: mascarado, nunca o telefone");
		assert.ok(!noFallback.includes(USER_OTHER_GROUP), "Telefone não pode aparecer");

		// Mensagem em PV (sem grupo) ainda considera o apelido global
		const pv = await WaifuCommands.resolveDisplayName({ group: null }, USER_GLOBAL, null);
		assert.strictEqual(pv, "Nick Global PV");

		assert.deepStrictEqual(
			groupsQueries,
			[],
			"resolveDisplayName não pode consultar outros grupos"
		);
		console.log("✓ Apenas grupo atual + global, sem varrer a tabela de grupos.");

		console.log("\n[3] resolveUserNickname: varredura só sem fallback e sem SELECT * ...");
		groupsQueries.length = 0;
		const pvApelido = await GeneralCommands.resolveUserNickname(null, `${USER_OTHER_GROUP}@c.us`);
		assert.strictEqual(pvApelido, "Nick de Outro Grupo", "!apelido no PV ainda herda de grupos");
		assert.ok(!groupsQueries.includes("getGroups"), "Não pode carregar todos os grupos");
		assert.ok(
			groupsQueries.length === 1 && /WHERE nicks LIKE/i.test(groupsQueries[0]),
			`Consulta deve filtrar por nicks: ${groupsQueries}`
		);

		groupsQueries.length = 0;
		const push = await GeneralCommands.resolveUserNickname(
			{ id: "x@g.us", nicks: [] },
			USER_OTHER_GROUP,
			"NomePush"
		);
		assert.strictEqual(push, "NomePush", "Com fallback não busca apelido em outros grupos");
		assert.deepStrictEqual(groupsQueries, [], "Com fallback não consulta a tabela de grupos");
		console.log("✓ Varredura sob demanda e filtrada por SQL.");
	} finally {
		db.getGroups = originalGetGroups;
		db.dbAll = originalDbAll;
		await db.saveGlobalNick(USER_GLOBAL, null);
		db.mappers.run("core", "DELETE FROM groups WHERE id = ?", [OTHER_GROUP_ID]);
	}

	console.log("\n=== Testes do nome de exibição passaram! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes de nome de exibição:", err);
		process.exit(1);
	});
