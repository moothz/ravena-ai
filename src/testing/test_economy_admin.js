"use strict";

/**
 * Testes do admin da carga do painel da economia: rotas /api/economy/admin/* (auth, CSRF, 409,
 * presets), agendamento persistido em meta (intervalo, pausa, precedência meta > env > 1) e
 * anotações pelo worker de verdade. Sem bot, sem rede externa, sem tocar em data/.
 *   node src/testing/test_economy_admin.js
 */

process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const BetterSQLite = require("better-sqlite3");

const { createAuthenticateBasic } = require("../BotAPI/middleware/auth");
const { registerEconomyRoutes } = require("../BotAPI/routes/economyRoutes");
const EconomyAnalyticsWorkerHost = require("../services/EconomyAnalyticsWorkerHost");

const tmpRoot = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "econ-admin-"));
const USER = "admin-teste";
const PASS = "senha-teste";
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`✓ ${name}`);
	} catch (err) {
		console.error(`✗ ${name}`);
		throw err;
	}
}

function mkHost(dir, extra = {}) {
	return new EconomyAnalyticsWorkerHost({
		serviceOpts: {
			dbPath: path.join(tmpRoot, dir, "analytics.db"),
			publishDir: path.join(tmpRoot, `${dir}-pub`),
			sources: [],
			playerDays: 0,
			runOnStart: false,
			...extra
		}
	});
}

async function main() {
	console.log("=== Testes: admin do painel da economia ===");
	let host = mkHost("a");
	host.start();
	assert.ok(await host.ready());

	const api = {
		app: express(),
		apiUser: USER,
		apiPassword: PASS,
		bots: [],
		logger: { error() {}, debug() {} },
		generalLimiter: (req, res, next) => next()
	};
	api.app.use(express.json());
	api.authenticateBasic = createAuthenticateBasic(api);
	registerEconomyRoutes(api, {
		get running() {
			return host.running;
		},
		...proxy()
	});
	function proxy() {
		const ops = [
			"status",
			"runNow",
			"pause",
			"resume",
			"reschedule",
			"listAnnotations",
			"addAnnotation",
			"decideAnnotation"
		];
		return Object.fromEntries(ops.map((op) => [op, (...a) => host[op](...a)]));
	}
	const server = await new Promise((r) => {
		const s = api.app.listen(0, "127.0.0.1", () => r(s));
	});
	const base = `http://127.0.0.1:${server.address().port}/api/economy/admin`;
	const call = (p, { method = "GET", body, headers = {}, auth = true } = {}) =>
		fetch(`${base}${p}`, {
			method,
			headers: {
				...(auth ? { Authorization: AUTH } : {}),
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				...headers
			},
			body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
		});
	const post = (p, body = {}, headers = {}) => call(p, { method: "POST", body, headers });

	process.env.ECONOMY_ANALYTICS_ENABLED = "true";
	try {
		await test("autenticação: sem credencial 401, senha errada 401", async () => {
			assert.strictEqual((await call("/status", { auth: false })).status, 401);
			const bad = await fetch(`${base}/status`, {
				headers: { Authorization: `Basic ${Buffer.from(`${USER}:x`).toString("base64")}` }
			});
			assert.strictEqual(bad.status, 401);
			assert.strictEqual(
				(await call("/pause", { method: "POST", body: {}, auth: false })).status,
				401
			);
		});

		await test("estado: agendamento padrão de 1 h, sem rodada, presets", async () => {
			const r = await call("/status");
			assert.strictEqual(r.status, 200);
			const st = await r.json();
			assert.strictEqual(st.worker, true);
			assert.strictEqual(st.running, false, "nenhuma rodada em andamento");
			assert.deepStrictEqual(st.presets, [1, 2, 3, 6, 12, 24]);
			assert.strictEqual(st.schedule.everyHours, 1);
			assert.strictEqual(st.schedule.from, "padrão");
			assert.strictEqual(st.schedule.cron, "5 * * * *");
			assert.strictEqual(st.schedule.paused, false);
			assert.strictEqual(st.scheduled, true);
		});

		await test("CSRF: sem JSON 415, outro site e outra origem 403, mesma origem ok", async () => {
			let r = await call("/pause", {
				method: "POST",
				body: "a=1",
				headers: { "Content-Type": "application/x-www-form-urlencoded" }
			});
			assert.strictEqual(r.status, 415);
			r = await call("/pause", { method: "POST", headers: {} });
			assert.strictEqual(r.status, 415, "POST sem corpo nem Content-Type");
			r = await post("/pause", {}, { "Sec-Fetch-Site": "cross-site" });
			assert.strictEqual(r.status, 403);
			r = await post("/pause", {}, { Origin: "https://malicioso.example" });
			assert.strictEqual(r.status, 403);
			r = await post("/pause", {}, { Origin: "null" });
			assert.strictEqual(r.status, 403);
			const same = `http://127.0.0.1:${server.address().port}`;
			r = await post(
				"/schedule",
				{ everyHours: 2 },
				{ Origin: same, "Sec-Fetch-Site": "same-origin" }
			);
			assert.strictEqual(r.status, 200);
			r = await post(
				"/pause",
				{},
				{ Origin: "https://painel.exemplo", "Sec-Fetch-Site": "same-site" }
			);
			assert.strictEqual(r.status, 403, "same-site recusado (mesma regra da guarda geral)");
			// Proxy que troca o Host: o navegador diz same-origin, e isso basta
			r = await post(
				"/schedule",
				{ everyHours: 2 },
				{ Origin: "https://painel.exemplo", "Sec-Fetch-Site": "same-origin" }
			);
			assert.strictEqual(r.status, 200, "Sec-Fetch-Site same-origin com Origin diferente do Host");
			// Sem Sec-Fetch-Site, a Origin listada em BOTAPI_ALLOWED_ORIGINS vale aqui também
			process.env.BOTAPI_ALLOWED_ORIGINS = "https://painel.exemplo";
			try {
				r = await post("/schedule", { everyHours: 2 }, { Origin: "https://painel.exemplo" });
				assert.strictEqual(r.status, 200, "BOTAPI_ALLOWED_ORIGINS nas rotas da economia");
			} finally {
				delete process.env.BOTAPI_ALLOWED_ORIGINS;
			}
			r = await post("/pause", {}, { Origin: "https://painel.exemplo" });
			assert.strictEqual(r.status, 403, "sem a variável, a mesma Origin é recusada");
			const st = await (await call("/status")).json();
			assert.strictEqual(st.schedule.paused, false, "as recusadas não pausaram nada");
		});

		await test("agendamento: só os presets; 6 h vira cron 5 */6; persistido em meta e publicado", async () => {
			for (const v of [0, 5, 48, "x", null]) {
				assert.strictEqual((await post("/schedule", { everyHours: v })).status, 400, String(v));
			}
			const r = await post("/schedule", { everyHours: 6 });
			const j = await r.json();
			assert.strictEqual(j.schedule.everyHours, 6);
			assert.strictEqual(j.schedule.cron, "5 */6 * * *");
			assert.strictEqual(j.schedule.from, "admin");
			const pub = new BetterSQLite(path.join(tmpRoot, "a-pub", "analytics.db"), { readonly: true });
			const meta = Object.fromEntries(
				pub
					.prepare("SELECT key, value FROM meta WHERE key LIKE 'schedule.%'")
					.all()
					.map((m) => [m.key, m.value])
			);
			pub.close();
			assert.strictEqual(meta["schedule.every_hours"], "6");
			assert.strictEqual(meta["schedule.effective_every_hours"], "6");
			assert.ok(Number(meta["schedule.updated_at"]) > 0);
		});

		await test("pausa: sem tarefa agendada; rodar agora funciona pausada (202) e não duplica", async () => {
			let j = await (await post("/pause")).json();
			assert.strictEqual(j.schedule.paused, true);
			let st = await (await call("/status")).json();
			assert.strictEqual(st.scheduled, false);
			// Duas chamadas juntas: uma começa a rodada, a outra só vê que já está rodando
			const [r1, r2] = await Promise.all([post("/run"), post("/run")]);
			assert.deepStrictEqual([r1.status, r2.status], [202, 202]);
			const started = [(await r1.json()).started, (await r2.json()).started];
			assert.deepStrictEqual(started.sort(), [false, true], "não duplica a rodada");
			for (let i = 0; i < 100; i++) {
				st = await (await call("/status")).json();
				if (!st.running) break;
				await new Promise((r) => setTimeout(r, 20));
			}
			j = await (await post("/resume")).json();
			assert.strictEqual(j.schedule.paused, false);
			st = await (await call("/status")).json();
			assert.strictEqual(st.scheduled, true);
		});

		await test("anotações: registrar à mão, listar, decidir só as possíveis", async () => {
			let r = await post("/annotations", {
				texto: "Prêmio do evento dobrado",
				moeda: "zinthos",
				hora: "2026-11-01T15:00:00-03:00"
			});
			assert.strictEqual(r.status, 201);
			const manual = (await r.json()).annotation;
			assert.strictEqual(manual.origin, "manual");
			assert.strictEqual(manual.ts, Date.parse("2026-11-01T18:00:00Z"));
			assert.strictEqual(
				(
					await post("/annotations", {
						texto: "Prêmio do evento dobrado",
						moeda: "zinthos",
						hora: "2026-11-01T15:00:00-03:00"
					})
				).status,
				400,
				"repetida"
			);
			assert.strictEqual((await post("/annotations", { texto: "", moeda: "zinthos" })).status, 400);
			assert.strictEqual((await post("/annotations", { texto: "x", moeda: "ouro" })).status, 400);
			assert.strictEqual((await post("/annotations", { texto: "x", hora: "ontem" })).status, 400);
			// Possível mudança gravada pela carga (aqui, direto no banco de trabalho)
			const db = new BetterSQLite(path.join(tmpRoot, "a", "analytics.db"));
			db.prepare(
				"INSERT INTO annotations (ts, currency, label, origin, detail) VALUES (?, 'runas', 'motivo novo: X (Runas)', 'possivel', '{\"kind\":\"new_reason\"}')"
			).run(Date.parse("2026-11-02T07:00:00Z"));
			db.close();
			const list = (await (await call("/annotations?possiveis=1")).json()).annotations;
			assert.strictEqual(list.length, 1);
			assert.strictEqual(
				(await post("/annotations/decide", { id: list[0].id, decision: "talvez" })).status,
				400
			);
			assert.strictEqual(
				(await post("/annotations/decide", { id: manual.id, decision: "descartada" })).status,
				400,
				"manual não se decide"
			);
			for (const texto of [{ a: 1 }, ["x"], 5, true]) {
				assert.strictEqual(
					(await post("/annotations/decide", { id: list[0].id, decision: "confirmada", texto }))
						.status,
					400,
					`texto ${JSON.stringify(texto)}`
				);
			}
			r = await post("/annotations/decide", {
				id: list[0].id,
				decision: "confirmada",
				texto: "Prêmio novo X"
			});
			assert.strictEqual(r.status, 200);
			const dec = (await r.json()).annotation;
			assert.deepStrictEqual([dec.origin, dec.label], ["confirmada", "Prêmio novo X"]);
			const all = (await (await call("/annotations")).json()).annotations;
			assert.strictEqual(all.length, 2);
			assert.strictEqual(
				(await (await call("/annotations?possiveis=1")).json()).annotations.length,
				0
			);
		});

		await test("ECONOMY_ANALYTICS_ENABLED diferente de true: escritas 409, estado sem worker", async () => {
			process.env.ECONOMY_ANALYTICS_ENABLED = "false";
			for (const p of [
				"/pause",
				"/resume",
				"/run",
				"/schedule",
				"/annotations",
				"/annotations/decide"
			]) {
				assert.strictEqual((await post(p, { everyHours: 1 })).status, 409, p);
			}
			const st = await (await call("/status")).json();
			assert.deepStrictEqual([st.enabled, st.worker], [false, false]);
			process.env.ECONOMY_ANALYTICS_ENABLED = "true";
		});

		await test("subida respeita o que foi gravado: intervalo do admin e pausa (sem rodada da subida)", async () => {
			await post("/pause");
			assert.strictEqual(await host.stop(), true);
			const t0 = Date.now();
			host = mkHost("a", { runOnStart: true, startDelayMs: 10 });
			host.start();
			await host.ready();
			await new Promise((r) => setTimeout(r, 300));
			const st = await (await call("/status")).json();
			assert.strictEqual(st.schedule.everyHours, 6);
			assert.strictEqual(st.schedule.paused, true);
			assert.strictEqual(st.scheduled, false);
			assert.ok(st.published < t0, "pausada não roda (nem publica) na subida");
			await post("/resume");
		});

		await test("precedência: meta > ECONOMY_ANALYTICS_EVERY_HOURS > 1 h", async () => {
			await host.stop();
			process.env.ECONOMY_ANALYTICS_EVERY_HOURS = "12";
			try {
				host = mkHost("b");
				host.start();
				await host.ready();
				let st = await (await call("/status")).json();
				assert.deepStrictEqual([st.schedule.everyHours, st.schedule.from], [12, "env"]);
				// O intervalo do .env chega ao banco na subida (o painel e o alerta leem a chave efetiva)
				const metaOf = (file) => {
					const db = new BetterSQLite(file, { readonly: true });
					const m = Object.fromEntries(
						db
							.prepare("SELECT key, value FROM meta WHERE key LIKE 'schedule.%'")
							.all()
							.map((x) => [x.key, x.value])
					);
					db.close();
					return m;
				};
				const work = path.join(tmpRoot, "b", "analytics.db");
				const pubB = path.join(tmpRoot, "b-pub", "analytics.db");
				assert.strictEqual(metaOf(work)["schedule.effective_every_hours"], "12");
				assert.strictEqual(metaOf(work)["schedule.every_hours"], undefined);
				await post("/schedule", { everyHours: 3 });
				st = await (await call("/status")).json();
				assert.deepStrictEqual([st.schedule.everyHours, st.schedule.from], [3, "admin"]);
				assert.strictEqual(st.schedule.defaultEveryHours, 12);
				// "Usar o padrão do .env": apaga a escolha do admin e volta aos 12 h
				const back = await (await post("/schedule", { useDefault: true })).json();
				assert.deepStrictEqual([back.schedule.everyHours, back.schedule.from], [12, "env"]);
				assert.strictEqual(back.schedule.cron, "5 */12 * * *");
				const pm = metaOf(pubB);
				assert.strictEqual(pm["schedule.every_hours"], undefined);
				assert.strictEqual(pm["schedule.effective_every_hours"], "12");
				await post("/schedule", { everyHours: 3 });
				process.env.ECONOMY_ANALYTICS_EVERY_HOURS = "7"; // fora dos presets: ignorado
				await host.stop();
				host = mkHost("c");
				host.start();
				await host.ready();
				st = await (await call("/status")).json();
				assert.deepStrictEqual([st.schedule.everyHours, st.schedule.from], [1, "padrão"]);
			} finally {
				delete process.env.ECONOMY_ANALYTICS_EVERY_HOURS;
			}
		});
	} finally {
		await host.stop();
		server.close();
	}
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	console.log(`\n${passed} testes passaram.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
