// src/testing/test_admin_kit.js
// Funções puras do kit do painel /admin (public/admin/lib.js, módulo ES sem DOM): números,
// tempo relativo, rotas por hash, links do Grafana, situação da carga e "Precisa de você".

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function runTests() {
	console.log("=== Teste do kit do /admin (lib.js) ===");
	const lib = await import(pathToFileURL(path.join(__dirname, "../../public/admin/lib.js")).href);

	// Números e plurais
	assert.strictEqual(lib.fmt(18240), "18.240");
	assert.strictEqual(lib.fmt(undefined), "—");
	assert.strictEqual(lib.fmt(NaN), "—");
	assert.strictEqual(lib.fmt2(1234.567), "1.234,57");
	assert.strictEqual(lib.plural(1, "instância", "instâncias"), "1 instância");
	assert.strictEqual(lib.plural(0, "instância", "instâncias"), "0 instâncias");
	assert.strictEqual(lib.plural(2000, "falha", "falhas"), "2.000 falhas");
	console.log("✓ fmt, fmt2 e plural em pt-BR.");

	// Tempo relativo
	const now = Date.UTC(2026, 10, 21, 15, 0, 0);
	assert.strictEqual(lib.relTime(now - 10 * 1000, now), "agora");
	assert.strictEqual(lib.relTime(now - 3 * 60 * 1000, now), "há 3 min");
	assert.strictEqual(lib.relTime(now - 46 * 3600 * 1000, now), "há 46 h");
	assert.strictEqual(lib.relTime(now - 3 * 86400 * 1000, now), "há 3 d");
	assert.strictEqual(lib.relTime(now + 5 * 60 * 1000, now), "em 5 min");
	assert.strictEqual(lib.relTime(now + 72 * 3600 * 1000, now), "em 3 d");
	assert.strictEqual(lib.relTime(null, now), "—");
	assert.strictEqual(lib.relTime("2026-11-21T14:00:00Z", now), "há 1 h");
	assert.strictEqual(lib.dateFmt(Date.UTC(2026, 10, 21, 15, 5)), "21/11/2026, 12:05");
	assert.strictEqual(lib.dateFmt(null), "—");
	console.log("✓ relTime e dateFmt (horário de Brasília).");

	// Rotas por hash
	let r = lib.parseHash("#/banco/jogador/55%2011?aba=extrato&x=1");
	assert.strictEqual(r.areaId, "banco");
	assert.deepStrictEqual(r.segs, ["jogador", "55 11"]);
	assert.strictEqual(r.params.get("aba"), "extrato");
	r = lib.parseHash("");
	assert.strictEqual(r.areaId, "");
	assert.deepStrictEqual(r.segs, []);
	r = lib.parseHash("#/logs/");
	assert.deepStrictEqual([r.areaId, r.segs], ["logs", []]);
	assert.strictEqual(
		lib.buildHash("banco", ["jogador", "55 11"], { aba: "x" }),
		"#/banco/jogador/55%2011?aba=x"
	);
	assert.strictEqual(lib.buildHash("geral"), "#/geral");
	console.log("✓ parseHash e buildHash.");

	// Links com parâmetros (grafanaLink usa isto)
	assert.strictEqual(
		lib.withParams("https://g.exemplo/d/ravena-economia", {
			dtab: "moeda",
			"var-moeda": ["runas", "zinthos"],
			nada: null
		}),
		"https://g.exemplo/d/ravena-economia?dtab=moeda&var-moeda=runas&var-moeda=zinthos"
	);
	assert.strictEqual(lib.withParams(null, { a: 1 }), null);
	console.log("✓ withParams.");

	// HTTP em português
	for (const st of [0, 401, 403, 409, 415, 429, 500]) {
		assert.ok(
			/[a-zà-ú]/.test(lib.httpReason(st)) && !/^HTTP/.test(lib.httpReason(st)),
			`motivo para ${st}`
		);
	}
	console.log("✓ httpReason cobre 401/403/409/415/429/5xx.");

	// Eventos: o serviço marca "ativo"/"proximo"/"normal"/"passado"
	assert.ok(lib.isEventActive({ status: "ativo" }));
	assert.ok(!lib.isEventActive({ status: "passado", startTime: now - 10, endTime: now - 5 }, now));
	assert.ok(lib.isEventActive({ status: "x", startTime: now - 10, endTime: now + 10 }, now));
	assert.ok(lib.isEventUpcoming({ status: "proximo", startTime: now + 1000 }, now));
	console.log("✓ isEventActive / isEventUpcoming com os status reais.");

	// Carga da economia
	const H = 3600 * 1000;
	assert.strictEqual(lib.econHealth(null).state, "off");
	assert.strictEqual(lib.econHealth({ enabled: false }).word, "desligada");
	assert.ok(/ECONOMY_ANALYTICS_ENABLED/.test(lib.econHealth({ enabled: false }).detail));
	assert.strictEqual(lib.econHealth({ enabled: true, worker: false }).word, "parada");
	const base = {
		enabled: true,
		worker: true,
		now,
		sources: ["zinthos", "runas"],
		schedule: { everyHours: 1 }
	};
	let e = lib.econHealth({
		...base,
		loads: [
			{ source: "zinthos", lastOk: true, okTo: now - H },
			{ source: "runas", lastOk: true, okTo: now - H / 2 },
			{ source: "runas.players", lastOk: false, lastError: "não é principal" }
		]
	});
	assert.strictEqual(e.state, "ok");
	assert.strictEqual(e.word, "em dia");
	e = lib.econHealth({
		...base,
		loads: [
			{ source: "zinthos", lastOk: true, okTo: now - 5 * H },
			{ source: "runas", lastOk: false, lastError: "Jardim 503" }
		]
	});
	assert.strictEqual(e.state, "down");
	assert.deepStrictEqual(e.failing, [{ name: "Runas", source: "runas", error: "Jardim 503" }]);
	assert.deepStrictEqual(e.late, [{ name: "Zinthos", source: "zinthos", hours: 5 }]);
	e = lib.econHealth({ ...base, schedule: { everyHours: 6, paused: true }, loads: [] });
	assert.strictEqual(e.word, "pausada");
	e = lib.econHealth({
		...base,
		schedule: { everyHours: 1, paused: true },
		loads: [{ source: "runas", lastOk: false, lastError: "503" }]
	});
	assert.strictEqual(e.word, "com erro", "pausa não esconde a falha");
	assert.strictEqual(lib.econHealth({ ...base, loads: [] }).word, "sem carga ainda");
	console.log("✓ econHealth (em dia, com erro, atrasada, pausada, desligada).");

	// Precisa de você
	const needs = lib.deriveNeeds({
		now,
		bots: [
			{ nome: "a", connected: true },
			{
				nome: "b",
				nomeExibir: "Ravena B",
				connected: false,
				isLive: false,
				lastMessageReceived: now - 3 * 60000
			},
			{ nome: "c", connected: false, enabled: false }
		],
		services: { llm: { status: "down" }, whisper: "online", imagine: null },
		llm: { total_requests: 100, total_failures: 30 },
		econ: {
			...base,
			loads: [
				{ source: "zinthos", lastOk: false, lastError: "503" },
				{ source: "runas", lastOk: true, okTo: now }
			]
		},
		possible: [{ id: 1 }, { id: 2 }],
		grafana: (name, params) => lib.withParams(`https://g/${name}`, params)
	});
	const titles = needs.map((n) => n.title);
	assert.ok(titles.includes("Ravena B parada"), "instância parada");
	assert.ok(!titles.some((t) => t.startsWith("c ")), "instância desligada não conta");
	assert.ok(titles.includes("LLM fora do ar"));
	assert.ok(titles.includes("IA com muitas falhas"));
	assert.ok(titles.includes("Carga da economia: Zinthos falhou"));
	assert.ok(titles.includes("2 possíveis mudanças da economia para decidir"));
	assert.ok(titles.includes("Imagine: sem dado"));
	const llm = needs.find((n) => n.title === "IA com muitas falhas");
	assert.strictEqual(llm.href, "#/provedores/uso", "falhas de IA levam ao Uso de IA");
	assert.strictEqual(llm.external.href, "https://g/llm");
	assert.strictEqual(needs.find((n) => n.title === "Ravena B parada").href, "#/instancias/b");
	assert.strictEqual(needs.find((n) => n.title === "LLM fora do ar").href, "#/provedores");
	const carga = needs.find((n) => n.title.startsWith("Carga"));
	assert.strictEqual(carga.href, "#/carga");
	assert.strictEqual(carga.external.href, "https://g/economia?dtab=diagnstico&var-moedas=zinthos");
	assert.strictEqual(
		needs.find((n) => n.title.includes("possíveis mudanças")).external.href,
		"https://g/economia?dtab=mudanas"
	);
	assert.deepStrictEqual(lib.econGrafana("runas.players", "x"), {
		dtab: "x",
		"var-moedas": "runas"
	});
	assert.strictEqual(lib.countActionable(needs), 5, "sem dado não conta como 'precisa de você'");
	assert.strictEqual(needs[needs.length - 1].state, "off", "sem dado fica no fim");
	assert.deepStrictEqual(lib.deriveNeeds({}), [], "sem leitura nenhuma, lista vazia");
	assert.strictEqual(lib.serviceKind({ status: "backup" }), "backup");
	assert.strictEqual(lib.serviceKind("online"), "ok");
	assert.strictEqual(lib.serviceKind(undefined), "unknown");
	const reserva = lib.deriveNeeds({ services: { llm: { status: "backup" } } });
	assert.deepStrictEqual(
		reserva.map((n) => [n.state, n.title, n.href]),
		[["attention", "LLM na reserva", "#/provedores"]],
		"serviço na reserva pede atenção (não é 'sem dado')"
	);
	const many = lib.deriveNeeds({ services: { a: "down", b: "down", c: "down", d: "down" } });
	assert.strictEqual(many.length, 1, "mais de 3 serviços fora viram uma linha");
	console.log("✓ deriveNeeds e countActionable.");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste do kit do /admin:", err);
		process.exit(1);
	});
