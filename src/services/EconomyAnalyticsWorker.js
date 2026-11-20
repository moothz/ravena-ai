/**
 * EconomyAnalyticsWorker.js
 *
 * Corpo do worker_threads da carga do painel da economia. Criado só pelo EconomyAnalyticsWorkerHost (o
 * bot nunca roda a carga na thread principal): instancia o EconomyAnalyticsService, liga o agendamento
 * (cron e rodada da subida) e atende pedidos da thread principal por mensagens:
 *   { id, op, args } → { id, ok, result } | { id, ok: false, error }
 * op "stop" para o serviço (aborta a rodada, espera no máximo stopWaitMs), esvazia a fila de spans (até
 * 500 ms) e encerra a thread. Logs vão pelo Logger (mesmo arquivo do bot, modo append); spans, pelo bootstrap do
 * OpenTelemetry que o worker herda do --require do bot (só traces no worker; ver telemetry/otel.js).
 */
"use strict";

const { parentPort, workerData, isMainThread } = require("worker_threads");

if (isMainThread || !parentPort) {
	throw new Error("EconomyAnalyticsWorker.js só roda como worker (ver EconomyAnalyticsWorkerHost)");
}

const Logger = require("../utils/Logger");
const EconomyAnalyticsService = require("./EconomyAnalyticsService");

const logger = new Logger("economy-analytics");
const svc = new EconomyAnalyticsService({ ...((workerData && workerData.opts) || {}) });

/** Operações que a thread principal pode pedir (lista fechada). */
const OPS = {
	status: () => svc.status(),
	runNow: () => svc.runNow()
};

let stopping = false;

async function stop(id) {
	if (stopping) return;
	stopping = true;
	let finished = false;
	try {
		finished = await svc.stop();
	} catch (err) {
		logger.warn(`[economy] Falha ao parar a carga: ${err.message}`);
	}
	// Esvazia a fila de spans do worker (no máximo 500 ms: com os 2 s do stop do serviço, cabe nos 3 s
	// que a thread principal espera antes do terminate())
	if (typeof globalThis.__RAVENA_OTEL_SHUTDOWN === "function") {
		await Promise.race([
			globalThis.__RAVENA_OTEL_SHUTDOWN(),
			new Promise((r) => setTimeout(r, 500).unref())
		]).catch(() => {});
	}
	parentPort.postMessage({ id, ok: true, result: finished });
	// Sai já (o 'exit' do processo do worker esvazia o buffer do Logger): exportador de spans tentando um
	// coletor fora do ar seguraria a thread viva até o terminate()
	parentPort.close();
	process.exit(0);
}

parentPort.on("message", async (msg) => {
	if (!msg || typeof msg !== "object") return;
	const { id, op, args = [] } = msg;
	if (op === "stop") return stop(id);
	const fn = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
	if (!fn) {
		parentPort.postMessage({ id, ok: false, error: `operação desconhecida: ${op}` });
		return;
	}
	if (stopping) {
		parentPort.postMessage({ id, ok: false, error: "carga encerrando" });
		return;
	}
	try {
		const result = await fn(...(Array.isArray(args) ? args : []));
		parentPort.postMessage({ id, ok: true, result });
	} catch (err) {
		parentPort.postMessage({ id, ok: false, error: err.message });
	}
});

svc.start();
parentPort.postMessage({ type: "ready" });
