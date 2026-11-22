// src/testing/test_admin_carga.js
// Regras da área "Carga da economia" do /admin (public/admin/areas/carga/model.js, módulo ES sem
// DOM): situação geral, estado por fonte, agendamento, intervalo, corpo das escritas e hora em
// horário de Brasília. Mesmas regras do cartão "Painel da economia" do /banco/admin.

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const H = 3600000;

async function runTests() {
	console.log("=== Teste da área Carga da economia do /admin (model.js) ===");
	const M = await import(
		pathToFileURL(path.join(__dirname, "../../public/admin/areas/carga/model.js")).href
	);
	const now = Date.UTC(2026, 10, 21, 15, 0, 0);
	const base = {
		enabled: true,
		worker: true,
		presets: [1, 2, 3, 6, 12, 24],
		running: false,
		schedule: {
			everyHours: 1,
			defaultEveryHours: 1,
			paused: false,
			from: "padrão",
			cron: "5 * * * *"
		},
		sources: ["zinthos", "petalitas", "runas"],
		loads: [
			{ source: "zinthos", okTo: now - H, lastTs: now - H, lastOk: true },
			{ source: "petalitas", okTo: now - H, lastTs: now - H, lastOk: true },
			{ source: "runas", okTo: now - H, lastTs: now - H, lastOk: true },
			{ source: "runas.players", okTo: now - 50 * H, lastTs: now - H, lastOk: true },
			{ source: "zinthos.reload", okTo: now, lastTs: now, lastOk: true }
		],
		now
	};
	const withLoads = (patch) => ({
		...base,
		loads: base.loads.map((l) => (patch[l.source] ? { ...l, ...patch[l.source] } : l))
	});

	// Situação geral: desligada, parada, e a ordem com erro > atrasada > pausada > sem carga > rodando/em dia
	// (a mesma do econHealth do kit, que o menu e a Visão geral usam)
	assert.strictEqual(M.overall(null).word, "sem dado");
	let o = M.overall({ enabled: false, worker: false });
	assert.deepStrictEqual([o.word, o.available], ["desligada", false]);
	assert.match(o.reason, /ECONOMY_ANALYTICS_ENABLED/);
	o = M.overall({ enabled: true, worker: false });
	assert.deepStrictEqual([o.word, o.available], ["carga parada", false]);
	assert.match(o.reason, /DISABLE_ACTIVITY/);
	assert.deepStrictEqual(M.overall(base), { lamp: "ok", word: "em dia", available: true });
	assert.strictEqual(M.overall({ ...base, running: true }).word, "rodando agora");
	assert.strictEqual(M.overall({ ...base, loads: [] }).word, "sem carga ainda");
	assert.strictEqual(M.overall({ ...base, loads: [], running: true }).lamp, "busy");
	const failing = withLoads({ petalitas: { lastOk: false, lastError: "Jardim 503" } });
	assert.deepStrictEqual(M.overall(failing), { lamp: "down", word: "com erro", available: true });
	// atraso: intervalo (1 h) + 2 h de tolerância; 3 h ainda está em dia, 3 h e 1 min não
	assert.strictEqual(M.overall(withLoads({ runas: { okTo: now - 3 * H } })).word, "em dia");
	const late = withLoads({ runas: { okTo: now - 3 * H - 60000 } });
	assert.deepStrictEqual(M.overall(late), { lamp: "attention", word: "atrasada", available: true });
	assert.strictEqual(
		M.overall({ ...late, schedule: { ...base.schedule, everyHours: 6 } }).word,
		"em dia",
		"intervalo maior aumenta a tolerância"
	);
	const pausedFailing = { ...failing, schedule: { ...base.schedule, paused: true } };
	assert.strictEqual(M.overall(pausedFailing).word, "com erro", "a pausa não esconde a falha");
	const pausedLate = { ...late, schedule: { ...late.schedule, paused: true } };
	assert.strictEqual(M.overall(pausedLate).word, "atrasada", "a pausa não esconde o atraso");
	const pausedOk = { ...base, schedule: { ...base.schedule, paused: true } };
	assert.strictEqual(M.overall(pausedOk).word, "pausada");
	assert.strictEqual(M.overall({ ...pausedOk, loads: [] }).word, "pausada");
	// Mesma palavra que o econHealth (menu e Visão geral) em todos os casos
	const kit = await import(pathToFileURL(path.join(__dirname, "../../public/admin/lib.js")).href);
	for (const st of [
		base,
		failing,
		late,
		pausedFailing,
		pausedLate,
		pausedOk,
		{ ...base, loads: [] }
	]) {
		assert.strictEqual(kit.econHealth(st).word, M.overall(st).word, "mesma ordem nos dois lugares");
	}
	// atraso só das fontes principais: "por jogador" com 50 h não acende
	assert.strictEqual(M.overall(base).word, "em dia");
	console.log("✓ overall: desligada, parada, pausada, com erro, atrasada, rodando, em dia.");

	// Linhas por fonte
	assert.deepStrictEqual(M.sourceRows({ enabled: false }), []);
	let rows = M.sourceRows(failing);
	assert.deepStrictEqual(
		rows.map((r) => r.source),
		["zinthos", "petalitas", "runas", "runas.players"],
		"sem as fontes *.reload"
	);
	const pet = rows.find((r) => r.source === "petalitas");
	assert.deepStrictEqual(
		[pet.state, pet.lastError, pet.name],
		["error", "Jardim 503", "Petalitas"]
	);
	const players = rows.find((r) => r.source === "runas.players");
	assert.deepStrictEqual(
		[players.isMain, players.lag, players.state, players.name],
		[false, null, "ok", "Runas por jogador"],
		"derivada não tem atraso nem fica atrasada"
	);
	assert.strictEqual(rows[0].lag, H);
	rows = M.sourceRows(withLoads({ runas: { okTo: null } }));
	assert.strictEqual(
		rows.find((r) => r.source === "runas").state,
		"late",
		"sem dado ainda = atrasada"
	);
	assert.strictEqual(
		M.sourceRows(withLoads({ zinthos: { lastOk: false } }))[0].lastError,
		"erro",
		"erro sem mensagem"
	);
	assert.strictEqual(M.sourceName("atividade"), "Atividade (comandos)");
	assert.strictEqual(M.sourceName("x.novo"), "x.novo");
	console.log("✓ sourceRows: nomes, *.reload fora, atraso só nas principais, erro.");

	// Textos
	assert.strictEqual(M.fmtLag(null), "—");
	assert.strictEqual(M.fmtLag(1.5 * H), "1,5 h");
	assert.strictEqual(M.fmtLag(47 * H), "47 h");
	assert.strictEqual(M.fmtLag(60 * H), "2,5 dias");
	assert.strictEqual(M.dayFmt(Date.UTC(2026, 10, 21, 2, 0)), "20/11/2026", "dia em Brasília");
	assert.strictEqual(M.dayFmt(null), "—");
	assert.strictEqual(M.currencyName("runas"), "Runas");
	assert.strictEqual(M.currencyName(null), "Todas");
	assert.strictEqual(M.scheduleBadge(base.schedule), "a cada 1 h");
	assert.strictEqual(M.scheduleBadge({ ...base.schedule, paused: true }), "pausada");
	const fakeDate = () => "21/11/2026, 12:00";
	assert.strictEqual(
		M.scheduleDetail(base.schedule, fakeDate),
		"cron 5 * * * * (minuto 5) · definido por padrão."
	);
	assert.strictEqual(
		M.scheduleDetail(
			{ ...base.schedule, from: "admin", cron: "5 */6 * * *", updatedAt: now },
			fakeDate
		),
		"cron 5 */6 * * * (minuto 5) · definido por este painel em 21/11/2026, 12:00."
	);
	assert.match(
		M.scheduleDetail({ ...base.schedule, from: "env" }, fakeDate),
		/ECONOMY_ANALYTICS_EVERY_HOURS/
	);
	console.log("✓ fmtLag, dayFmt, scheduleBadge e scheduleDetail.");

	// Intervalo: 1ª opção "padrão do .env (N h)"; selecionado só quando veio deste painel
	let opts = M.intervalOptions({
		...base,
		schedule: { ...base.schedule, defaultEveryHours: 3, everyHours: 3, from: "env" }
	});
	assert.deepStrictEqual(opts.options[0], { value: "", label: "padrão do .env (3 h)" });
	assert.deepStrictEqual(
		opts.options.slice(1).map((x) => x.value),
		["1", "2", "3", "6", "12", "24"]
	);
	assert.strictEqual(opts.selected, "");
	opts = M.intervalOptions({
		...base,
		presets: undefined,
		schedule: { ...base.schedule, everyHours: 6, from: "admin" }
	});
	assert.strictEqual(opts.selected, "6");
	assert.strictEqual(opts.options.length, 7, "sem presets no status, usa 1/2/3/6/12/24");
	assert.deepStrictEqual(M.scheduleBody(""), { useDefault: true });
	assert.deepStrictEqual(M.scheduleBody("12"), { everyHours: 12 });
	console.log("✓ intervalOptions e scheduleBody.");

	// Registrar mudança: hora em horário de Brasília (UTC−3), vazio = agora (null)
	assert.strictEqual(M.brasiliaToIso(""), null);
	assert.strictEqual(M.brasiliaToIso(null), null);
	assert.strictEqual(M.brasiliaToIso("2026-11-20T14:30"), "2026-11-20T17:30:00.000Z");
	assert.strictEqual(M.brasiliaToIso("2026-11-20T23:30:15"), "2026-11-21T02:30:15.000Z");
	assert.strictEqual(M.brasiliaToIso("20/11/2026 14:30"), undefined);
	assert.deepStrictEqual(
		M.annotationBody({ texto: "  prêmio dobrado ", moeda: "runas", hora: "" }),
		{
			texto: "prêmio dobrado",
			moeda: "runas",
			hora: null
		}
	);
	assert.strictEqual(M.annotationBody({ texto: "x" }).moeda, "todas");
	assert.throws(() => M.annotationBody({ texto: "x", hora: "amanhã" }), /Hora inválida/);
	assert.deepStrictEqual(
		M.CURRENCY_OPTIONS.map((c) => c.value),
		["todas", "zinthos", "petalitas", "runas"],
		"as moedas que a rota aceita"
	);
	console.log("✓ annotationBody e brasiliaToIso.");

	// Aviso do fim da rodada
	assert.deepStrictEqual(M.runOutcome(base), { ok: true, text: "Carga concluída." });
	assert.deepStrictEqual(M.runOutcome(failing), {
		ok: false,
		text: "Carga concluída; Petalitas falhou (Jardim 503)."
	});
	console.log("✓ runOutcome.");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste da área Carga da economia:", err);
		process.exit(1);
	});
