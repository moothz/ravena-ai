// src/testing/test_admin_eventos.js
// Funções puras da área Eventos do /admin (public/admin/areas/eventos/lib.js, módulo ES sem
// DOM): classificação igual à do ScheduledEventService, grupos, filtros, tempo, horário de
// Brasília e validação dos bônus.

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const H = 3600 * 1000;
const D = 24 * H;

async function runTests() {
	console.log("=== Teste da área Eventos do /admin (areas/eventos/lib.js) ===");
	const lib = await import(
		pathToFileURL(path.join(__dirname, "../../public/admin/areas/eventos/lib.js")).href
	);
	const now = Date.UTC(2026, 10, 21, 15, 0, 0);
	const evs = [
		{ id: 1, name: "Semana da Pesca", startTime: now - 2 * D, endTime: now + 5 * D },
		{ id: 2, name: "Slots", startTime: now + 7 * D, endTime: now + 9 * D },
		{ id: 3, name: "Natal das Waifus", startTime: now + 30 * D, endTime: now + 32 * D },
		{ id: 4, name: "Festival", startTime: now - 20 * D, endTime: now - 18 * D },
		{ id: 5, name: "Curto", startTime: now - 11 * D, endTime: now - 11 * D + 2 * H },
		{ id: 6, name: "Slots bis", startTime: now + 7 * D, endTime: now + 8 * D }
	];

	// Classificação = a do serviço (mesmos status para os mesmos horários)
	const c = lib.classify(evs, now);
	const st = Object.fromEntries(c.map((e) => [e.id, e.status]));
	assert.deepStrictEqual(st, {
		1: "ativo",
		2: "proximo",
		3: "normal",
		4: "passado",
		5: "passado",
		6: "proximo"
	});
	let svcClassify = null;
	try {
		svcClassify = require("../services/ScheduledEventService").classifyEvents;
	} catch (err) {
		console.log(`(sem o serviço neste ambiente: ${err.message})`);
	}
	if (svcClassify) {
		const svc = Object.fromEntries(svcClassify(evs, now).map((e) => [e.id, e.status]));
		assert.deepStrictEqual(st, svc);
		console.log("✓ classify igual ao classifyEvents do serviço.");
	}
	assert.strictEqual(lib.classify([], now).length, 0);
	console.log("✓ classify (ativo, proximo, normal, passado).");

	// Grupos e ordem
	const g = lib.groupEvents(c);
	assert.deepStrictEqual(
		g.agora.map((e) => e.id),
		[1]
	);
	assert.deepStrictEqual(
		g.programados.map((e) => e.id),
		[2, 6, 3]
	);
	assert.deepStrictEqual(
		g.encerrados.map((e) => e.id),
		[5, 4]
	);
	console.log("✓ groupEvents (Agora / Programados / Encerrados).");

	// Filtros
	assert.deepStrictEqual(
		lib
			.filterEvents(c, { q: "slots" })
			.map((e) => e.id)
			.sort(),
		[2, 6]
	);
	assert.strictEqual(lib.filterEvents(c, { q: "SLOTS" }).length, 2);
	assert.strictEqual(lib.filterEvents(c, { q: "pesca", status: "passado" }).length, 0);
	assert.strictEqual(lib.filterEvents(c, { status: "passado" }).length, 2);
	assert.strictEqual(lib.filterEvents(c, { status: "todos" }).length, 6);
	assert.strictEqual(
		lib.filterEvents([{ name: "Festa Junina Ação", status: "normal" }], { q: "acao" }).length,
		1
	);
	console.log("✓ filterEvents (nome sem acento/maiúscula, status).");

	// Tempo relativo, andamento, duração
	assert.strictEqual(
		lib.whenText(
			c.find((e) => e.id === 1),
			now
		),
		"termina em 5 dias"
	);
	assert.strictEqual(
		lib.whenText(
			c.find((e) => e.id === 2),
			now
		),
		"começa em 7 dias"
	);
	assert.strictEqual(
		lib.whenText(
			c.find((e) => e.id === 4),
			now
		),
		"terminou há 18 dias"
	);
	assert.strictEqual(lib.spanText(3 * H), "3 h");
	assert.strictEqual(lib.spanText(20 * 1000), "1 min");
	assert.strictEqual(lib.spanText(D), "1 dia");
	assert.strictEqual(lib.progressPct(evs[0], now), 29);
	assert.strictEqual(lib.progressPct(evs[1], now), null);
	assert.strictEqual(lib.durationText(2 * D + 5 * H), "2 dias e 5 horas");
	assert.strictEqual(lib.durationText(45 * 60 * 1000), "45 minutos");
	assert.strictEqual(lib.durationText(D + 30 * 60 * 1000), "1 dia e 30 minutos");
	assert.strictEqual(lib.durationText(2 * H + 5 * 60 * 1000), "2 horas e 5 minutos");
	let fmtSvc = null;
	try {
		fmtSvc = require("../services/ScheduledEventService").formatDurationPtBr;
	} catch {
		fmtSvc = null;
	}
	if (fmtSvc) {
		for (const ms of [
			60000,
			45 * 60000,
			2 * H,
			2 * H + 5 * 60000,
			D,
			D + 30 * 60000,
			2 * D + 5 * H + 7 * 60000,
			7 * D
		])
			assert.strictEqual(lib.durationText(ms), fmtSvc(ms), `duração ${ms}`);
		console.log("✓ durationText igual ao formatDurationPtBr do serviço.");
	}
	console.log("✓ whenText, spanText, progressPct e durationText.");

	// Horário de Brasília (UTC-03:00 fixo)
	assert.strictEqual(lib.toBrtLocal(Date.UTC(2026, 10, 28, 21, 0)), "2026-11-28T18:00");
	assert.strictEqual(lib.fromBrtLocal("2026-11-28T18:00"), Date.UTC(2026, 10, 28, 21, 0));
	assert.ok(Number.isNaN(lib.fromBrtLocal("28/11/2026 18:00")));
	assert.strictEqual(lib.toBrtLocal(NaN), "");
	const dt = lib.defaultTimes(Date.UTC(2026, 10, 21, 15, 0, 30));
	assert.strictEqual(dt.start, Date.UTC(2026, 10, 21, 16, 1, 0));
	assert.strictEqual(dt.end - dt.start, D);
	console.log("✓ toBrtLocal, fromBrtLocal e defaultTimes.");

	// Bônus e formulário
	const catalog = [
		{ id: "pesca.iscas", label: "Iscas para todos", min: 1, max: 1000, unit: "iscas" },
		{ id: "pesca.peso", label: "Peso dos Peixes", min: 1, max: 1000, unit: "%" }
	];
	assert.deepStrictEqual(
		lib.collectSelection(catalog, [
			{ id: "pesca.iscas", checked: true, value: "10" },
			{ id: "pesca.peso", checked: false, value: "abc" }
		]),
		{ "pesca.iscas": 10 }
	);
	assert.throws(
		() => lib.collectSelection(catalog, [{ id: "pesca.iscas", checked: true, value: "5000" }]),
		/entre 1 e 1000/
	);
	assert.throws(
		() => lib.collectSelection(catalog, [{ id: "pesca.iscas", checked: true, value: "2,5" }]),
		/número inteiro/
	);
	assert.throws(
		() => lib.checkForm({ name: " ", startTime: "2026-11-28T18:00", endTime: "2026-11-29T18:00" }),
		/nome/
	);
	assert.throws(
		() => lib.checkForm({ name: "x", startTime: "2026-11-28T18:00", endTime: "2026-11-28T18:00" }),
		/depois do início/
	);
	assert.throws(
		() =>
			lib.checkForm({
				name: "x".repeat(121),
				startTime: "2026-11-28T18:00",
				endTime: "2026-11-29T18:00"
			}),
		/120/
	);
	lib.checkForm({ name: "ok", startTime: "2026-11-28T18:00", endTime: "2026-11-29T18:00" });
	const body = lib.eventBody(
		{
			id: 9,
			name: "A",
			startTime: 1,
			endTime: 5,
			startGrants: { "pesca.iscas": 2 },
			message: "m",
			status: "ativo"
		},
		{ endTime: 3 }
	);
	assert.deepStrictEqual(body, {
		name: "A",
		startTime: 1,
		endTime: 3,
		startGrants: { "pesca.iscas": 2 },
		ongoingBuffs: {},
		message: "m"
	});
	assert.strictEqual(
		lib.bonusText({
			emoji: "🪱",
			label: "Iscas para todos",
			gameLabel: "Pesca",
			unit: "iscas",
			value: 1500
		}),
		"🪱 Iscas para todos (Pesca): +1.500 iscas"
	);
	assert.strictEqual(
		lib.bonusText({ label: "Peso", gameLabel: "Pesca", unit: "%", value: 25 }),
		"Peso (Pesca): +25%"
	);
	console.log("✓ collectSelection, checkForm, eventBody e bonusText.");

	console.log("=== Todos os testes da área Eventos passaram ===");
}

runTests().then(
	() => process.exit(0),
	(err) => {
		console.error("✗ Falhou:", err);
		process.exit(1);
	}
);
