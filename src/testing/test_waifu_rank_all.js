// src/testing/test_waifu_rank_all.js
// Testa !mu-rank zinthos all e !mu-rank casamentos all:
// - não faz varredura por jogador em cmd_usage_log nem groups
// - quebra rankings grandes em múltiplos ReturnMessage respeitando limites do WhatsAppBotGo
// - mantém o comportamento normal sem 'all'

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Database = require("../utils/Database");
const WaifuCommands = require("../functions/WaifuCommands");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const { createMessage } = require("./FakeMessage");

function makeSyntheticUsers(count) {
	const rich = [];
	const harem = [];
	for (let i = 1; i <= count; i++) {
		const num = `551199990${String(i).padStart(4, "0")}`;
		const id = `${num}@s.whatsapp.net`;
		rich.push({
			id,
			name: `Jogador ${i}`,
			kakera: (count - i + 1) * 100,
			_count: { harem: i % 15 }
		});
		harem.push({
			id,
			name: `Colecionador ${i}`,
			collectionPoints: (count - i + 1) * 50,
			totalMarriages: (i % 20) + 1,
			totalKeys: i % 10,
			commonCount: 1,
			uncommonCount: 2,
			rareCount: 1,
			epicCount: 0,
			legendaryCount: i % 2
		});
	}
	return { rich, harem };
}

async function runTests() {
	console.log("=== Testes de !mu-rank all (zinthos e casamentos) ===");
	const db = Database.getInstance();
	db.testMode = false;

	const forbiddenQueries = [];
	const originalDbGet = db.dbGet;
	const originalDbAll = db.dbAll;
	const originalGetGroups = db.getGroups;
	const originalApiGet = WaifuCommands.api.get;

	db.dbGet = async (dbName, sql, params) => {
		if (/cmd_usage_log|FROM groups/i.test(sql)) {
			forbiddenQueries.push({ dbName, sql });
		}
		return originalDbGet.call(db, dbName, sql, params);
	};
	db.dbAll = async (dbName, sql, params) => {
		if (/cmd_usage_log|FROM groups/i.test(sql)) {
			forbiddenQueries.push({ dbName, sql });
		}
		return originalDbAll.call(db, dbName, sql, params);
	};
	db.getGroups = async (...args) => {
		forbiddenQueries.push({ dbName: "core", sql: "getGroups" });
		return originalGetGroups.apply(db, args);
	};

	const { rich, harem } = makeSyntheticUsers(260);
	WaifuCommands.api.get = async (url, config) => {
		const limit = config?.params?.limit || 10;
		if (url === "/leaderboard/users") {
			return { data: { data: { topRich: rich.slice(0, limit) } } };
		}
		if (url === "/leaderboard/harem") {
			return { data: { data: { topHarem: harem.slice(0, limit) } } };
		}
		throw new Error(`Unexpected API GET: ${url}`);
	};

	const group = {
		id: "120363000000000099@g.us",
		nicks: [{ numero: "5511999900001@c.us", apelido: "PrimeiroLugar" }]
	};
	const msg = createMessage({
		content: "!mu-rank zinthos all",
		group: group.id,
		author: "5511999900001@s.whatsapp.net"
	});

	try {
		// 1. !mu-rank zinthos all
		forbiddenQueries.length = 0;
		const zinthosRes = await WaifuCommands.verRanking({}, msg, ["zinthos", "all"], group);
		assert.strictEqual(
			forbiddenQueries.length,
			0,
			`Não deve consultar cmd_usage_log/groups por jogador, mas fez ${forbiddenQueries.length} queries`
		);
		const zinthosMsgs = Array.isArray(zinthosRes) ? zinthosRes : [zinthosRes];
		assert(
			zinthosMsgs.length >= 2,
			"260 jogadores em zinthos all devem ser divididos em múltiplos ReturnMessage"
		);
		for (const m of zinthosMsgs) {
			const lineCount = m.content.split("\n").length;
			assert(lineCount <= 160, `Mensagem excedeu 160 linhas (${lineCount})`);
			assert(m.content.length <= 12500, `Mensagem excedeu 12500 chars (${m.content.length})`);
		}
		const zinthosJoined = zinthosMsgs.map((m) => m.content).join("\n");
		assert(zinthosJoined.includes("PrimeiroLugar"), "Deve respeitar apelido do grupo atual");
		assert(zinthosJoined.includes("Jogador 260"), "Deve incluir o 260º jogador sem truncar");
		console.log(
			`✓ !mu-rank zinthos all retornou ${zinthosMsgs.length} mensagens sem queries pesadas.`
		);

		// 2. !mu-rank casamentos all
		forbiddenQueries.length = 0;
		const casamentosRes = await WaifuCommands.verRanking({}, msg, ["casamentos", "all"], group);
		assert.strictEqual(
			forbiddenQueries.length,
			0,
			`Não deve consultar cmd_usage_log/groups por jogador, mas fez ${forbiddenQueries.length} queries`
		);
		const casamentosMsgs = Array.isArray(casamentosRes) ? casamentosRes : [casamentosRes];
		assert(
			casamentosMsgs.length >= 4,
			"260 jogadores (2 linhas cada) em casamentos all devem ser divididos em múltiplos ReturnMessage"
		);
		for (const m of casamentosMsgs) {
			const lineCount = m.content.split("\n").length;
			assert(lineCount <= 160, `Mensagem excedeu 160 linhas (${lineCount})`);
			assert(m.content.length <= 12500, `Mensagem excedeu 12500 chars (${m.content.length})`);
		}
		const casamentosJoined = casamentosMsgs.map((m) => m.content).join("\n");
		assert(casamentosJoined.includes("PrimeiroLugar"), "Deve respeitar apelido do grupo atual");
		assert(
			casamentosJoined.includes("Colecionador 260"),
			"Deve incluir o 260º colecionador sem truncar"
		);
		console.log(
			`✓ !mu-rank casamentos all retornou ${casamentosMsgs.length} mensagens sem queries pesadas.`
		);

		// 3. !mu-rank zinthos (sem all -> 1 mensagem)
		const top10Res = await WaifuCommands.verRanking({}, msg, ["zinthos"], group);
		assert(!Array.isArray(top10Res), "Top 10 deve retornar um único ReturnMessage");
		assert(
			top10Res.content.includes("!mu-rank zinthos all"),
			"Top 10 deve manter dica do comando all"
		);
		console.log("✓ !mu-rank zinthos (top 10) manteve formato único.");

		const longRich = Array.from({ length: 100 }, (_, i) => ({
			id: `551199991${String(i + 1).padStart(4, "0")}@s.whatsapp.net`,
			name: `Jogador Longo ${i + 1} ${"Nome Muito Comprido ".repeat(8)}`.trim(),
			kakera: (100 - i) * 10,
			_count: { harem: 1 }
		}));
		const shortApiGet = WaifuCommands.api.get;
		WaifuCommands.api.get = async (url) => {
			if (url === "/leaderboard/users") return { data: { data: { topRich: longRich } } };
			throw new Error(`Unexpected API GET: ${url}`);
		};
		let longRes;
		try {
			longRes = await WaifuCommands.verRanking({}, msg, ["zinthos", "all"], group);
		} finally {
			WaifuCommands.api.get = shortApiGet;
		}
		const longMsgs = Array.isArray(longRes) ? longRes : [longRes];
		assert(
			longMsgs.length >= 2,
			"100 jogadores com nomes longos (~20 mil chars) devem ser divididos por caracteres"
		);
		for (const m of longMsgs) {
			const lineCount = m.content.split("\n").length;
			assert(
				lineCount < 150,
				`A divisão deveria ser por caracteres, não por linhas (${lineCount})`
			);
			assert(m.content.length <= 12000, `Mensagem excedeu 12000 chars (${m.content.length})`);
		}
		const longJoined = longMsgs.map((m) => m.content).join("\n");
		const positions = longRich.map((u) => longJoined.indexOf(`*${u.name}*`));
		assert(
			positions.every((pos) => pos >= 0),
			"Todos os 100 jogadores devem aparecer"
		);
		assert(
			positions.every((pos, i) => i === 0 || pos > positions[i - 1]),
			"Os jogadores devem manter a ordem do ranking"
		);
		console.log(
			`✓ !mu-rank zinthos all com nomes longos dividiu por caracteres em ${longMsgs.length} mensagens.`
		);

		const consolidadoRes = await WaifuCommands.verRanking({}, msg, [], group);
		const warnings = [];
		const sentText = WhatsAppBotGo.prototype.truncateText.call(
			{ id: "teste-rank", logger: { warn: (m) => warnings.push(m) } },
			consolidadoRes.content
		);
		assert.strictEqual(
			sentText,
			consolidadoRes.content,
			"Painel consolidado não pode ser alterado no envio"
		);
		assert.strictEqual(
			warnings.length,
			0,
			"Painel consolidado não pode gerar aviso de mensagem ajustada"
		);
		console.log("✓ !mu-rank consolidado passa pelo truncateText sem ajuste nem aviso.");
	} finally {
		db.dbGet = originalDbGet;
		db.dbAll = originalDbAll;
		db.getGroups = originalGetGroups;
		WaifuCommands.api.get = originalApiGet;
	}

	console.log("\n=== Todos os testes de !mu-rank all passaram! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes de !mu-rank all:", err);
		process.exit(1);
	});
