/**
 * EconomyAnalyticsWorkerHost.js
 *
 * Lado da thread principal do bot da carga do painel da economia: sobe um worker_threads
 * (EconomyAnalyticsWorker.js) que instancia o EconomyAnalyticsService e roda o agendamento lá dentro, e
 * guarda só um proxy com pedidos por mensagem (estado, rodar agora, agendamento e anotações, usados
 * pelas rotas do /banco/admin em BotAPI/routes/economyRoutes.js). Toda leitura de SQLite, cálculo e
 * publicação ficam fora da thread que atende o WhatsApp.
 *
 * - start(): sobe o worker (não segura o processo vivo: unref). Se o worker cair sem stop(), sobe de
 *   novo depois de restartDelayMs.
 * - stop(): pede parada ao worker e espera no máximo stopWaitMs (3 s); depois disso, terminate().
 * - call(op, ...args): pedido ao worker, com timeout.
 *
 * Os scripts (economy-status, -reload, -annotate) não usam isto: instanciam o serviço direto.
 */
"use strict";

const path = require("path");
const { Worker } = require("worker_threads");
const Logger = require("../utils/Logger");

const logger = new Logger("economy-analytics");
const WORKER_FILE = path.join(__dirname, "EconomyAnalyticsWorker.js");
const STOP_WAIT_MS = 3000;
// O serviço no worker desiste da rodada antes disso, para fechar o banco antes do terminate()
const WORKER_STOP_WAIT_MS = 2000;
const CALL_TIMEOUT_MS = 15000;
const RESTART_DELAY_MS = 60000;

class EconomyAnalyticsWorkerHost {
	/**
	 * @param {object} [opts]
	 * @param {object} [opts.serviceOpts] opções do EconomyAnalyticsService no worker (só dados clonáveis)
	 * @param {number} [opts.stopWaitMs] espera máxima do stop() antes de terminate()
	 * @param {number} [opts.callTimeoutMs]
	 * @param {number} [opts.restartDelayMs]
	 */
	constructor(opts = {}) {
		this.serviceOpts = { stopWaitMs: WORKER_STOP_WAIT_MS, ...(opts.serviceOpts || {}) };
		this.stopWaitMs = opts.stopWaitMs ?? STOP_WAIT_MS;
		this.callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
		this.restartDelayMs = opts.restartDelayMs ?? RESTART_DELAY_MS;
		this.worker = null;
		this.pending = new Map();
		this.seq = 0;
		this._stopping = false;
		this._restartTimer = null;
		this._ready = null;
	}

	static getInstance() {
		if (!EconomyAnalyticsWorkerHost.instance) {
			EconomyAnalyticsWorkerHost.instance = new EconomyAnalyticsWorkerHost();
		}
		return EconomyAnalyticsWorkerHost.instance;
	}

	get running() {
		return !!this.worker;
	}

	start() {
		if (this.worker || this._stopping) return;
		const w = new Worker(WORKER_FILE, {
			name: "economy-analytics",
			workerData: { opts: this.serviceOpts }
		});
		w.unref();
		this.worker = w;
		this._ready = new Promise((resolve) => {
			this._resolveReady = resolve;
		});
		w.on("message", (m) => this._onMessage(m));
		w.on("error", (err) => logger.error(`[economy] Worker da carga falhou: ${err.message}`));
		w.on("exit", (code) => {
			if (this.worker === w) this.worker = null;
			if (this._resolveReady) this._resolveReady(false);
			for (const [, p] of this.pending) p.reject(new Error("worker da carga terminou"));
			this.pending.clear();
			if (this._stopping) return;
			logger.warn(
				`[economy] Worker da carga saiu (código ${code}); sobe de novo em ${Math.round(this.restartDelayMs / 1000)} s.`
			);
			this._restartTimer = setTimeout(() => {
				this._restartTimer = null;
				this.start();
			}, this.restartDelayMs);
			this._restartTimer.unref();
		});
		logger.info("[economy] Carga do painel em worker separado.");
	}

	/** Espera o worker ficar pronto (testes). @returns {Promise<boolean>} */
	ready() {
		return this._ready || Promise.resolve(false);
	}

	_onMessage(m) {
		if (!m || typeof m !== "object") return;
		if (m.type === "ready") {
			if (this._resolveReady) this._resolveReady(true);
			return;
		}
		const p = this.pending.get(m.id);
		if (!p) return;
		this.pending.delete(m.id);
		if (m.ok) p.resolve(m.result);
		else p.reject(new Error(m.error || "erro no worker da carga"));
	}

	/** Pedido ao worker. Rejeita se ele não está rodando, se responder com erro ou depois do timeout. */
	call(op, ...args) {
		if (!this.worker) return Promise.reject(new Error("carga do painel não está rodando"));
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`worker da carga não respondeu (${op})`));
			}, this.callTimeoutMs);
			timer.unref();
			this.pending.set(id, {
				resolve: (v) => (clearTimeout(timer), resolve(v)),
				reject: (e) => (clearTimeout(timer), reject(e))
			});
			this.worker.postMessage({ id, op, args });
		});
	}

	status() {
		return this.call("status");
	}

	runNow() {
		return this.call("runNow");
	}

	pause() {
		return this.call("pause");
	}

	resume() {
		return this.call("resume");
	}

	reschedule(everyHours) {
		return this.call("reschedule", everyHours);
	}

	listAnnotations(opts) {
		return this.call("listAnnotations", opts);
	}

	addAnnotation(input) {
		return this.call("addAnnotation", input);
	}

	decideAnnotation(id, decision, text) {
		return this.call("decideAnnotation", id, decision, text);
	}

	/**
	 * Pede parada ao worker e espera no máximo stopWaitMs; se não saiu, terminate(). Nunca segura o
	 * encerramento do bot. @returns {Promise<boolean>} true se o worker saiu sozinho a tempo
	 */
	async stop() {
		this._stopping = true;
		if (this._restartTimer) {
			clearTimeout(this._restartTimer);
			this._restartTimer = null;
		}
		const w = this.worker;
		if (!w) return true;
		let timer;
		const exited = new Promise((resolve) => w.once("exit", () => resolve(true)));
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => resolve(false), this.stopWaitMs);
		});
		try {
			w.postMessage({ id: ++this.seq, op: "stop" });
		} catch (_) {}
		const ok = await Promise.race([exited, timeout]);
		clearTimeout(timer);
		if (!ok) {
			logger.warn("[economy] Worker da carga não parou a tempo; encerrado à força.");
			await w.terminate().catch(() => {});
		}
		if (this.worker === w) this.worker = null;
		return ok;
	}
}

module.exports = EconomyAnalyticsWorkerHost;
