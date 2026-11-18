/**
 * EconomyAnalyticsService.js
 *
 * Carga horária do painel da economia (Grafana). Ver OBSERVABILITY.md ("Painel da economia").
 *
 * Fontes (uma por moeda):
 *   - zinthos:   GET {WAIFULETES_API_URL}/internal/economy/summary   (Authorization: Bearer WAIFULETES_API_KEY)
 *   - petalitas: GET {JARDIM_API_URL}/internal/economy/summary       (x-api-key: JARDIM_API_KEY)
 *   - runas:     bank.db local, aberto só-leitura
 *
 * Toda hora no minuto 5 (só com ECONOMY_ANALYTICS_ENABLED=true): para cada fonte pede
 * [to da última carga ok, início da hora atual) e grava fluxos por hora e motivo e o resultado em
 * load_runs. A primeira carga pede from=0, em pedaços: [0, ECONOMY_ANALYTICS_BACKFILL_START) e depois
 * janelas de 30 dias, cada uma registrada como carga ok (um timeout não faz voltar ao zero).
 * O retrato de saldos só é gravado na janela que chega à hora atual. Falha de uma fonte não para as
 * outras. Uma vez por dia econômico (04:00 BRT) grava quem recebe (últimos 7 dias, por quinto), só
 * para moeda com extrato.
 *
 * Por jogador (página Jogadores, ECONOMY_ANALYTICS_PLAYER_DAYS dias, padrão 90; 0 desliga): a cada
 * rodada pede GET /internal/economy/players por dia econômico, do dia da última carga até a hora atual
 * (o dia corrente é refeito a cada hora), e lê as Runas do bank.db. Atividade: comandos do cmd_usage.db
 * (só leitura). Identidade: LID → telefone pela memory_identities do memory.db (só leitura).
 * Ao fim de cada rodada grava a disponibilidade dos painéis (features) e publica um retrato do banco
 * para o Grafana.
 */
"use strict";

const cron = require("node-cron");
const BetterSQLite = require("better-sqlite3");
const Logger = require("../utils/Logger");
const telemetry = require("../telemetry");
const { EconomyAnalyticsStore, resolvePath } = require("./EconomyAnalyticsStore");
const { kindFor, MAPPING_VERSION, reasonLabelRows } = require("./EconomyAnalyticsMapping");
const {
	HOUR_MS,
	DAY_MS,
	economicDayStart,
	hourStart,
	buildRunasSummary,
	dailySnapshots
} = require("./EconomyAnalyticsRunas");
const {
	rawId,
	IdentityResolver,
	readIdentities,
	dayWindows,
	runasPlayerDays,
	readActivity
} = require("./EconomyAnalyticsPlayers");

const logger = new Logger("economy-analytics");
const SCHEMA_VERSION = 1;
const RECEIVED_WINDOW_MS = 7 * DAY_MS;
const CHUNK_MS = 30 * DAY_MS;
const RELOAD_MAX_MS = 90 * DAY_MS;
const DEFAULT_BACKFILL_START = "2025-01-01";
const DEFAULT_PLAYER_DAYS = 90;
/** Janela máxima aceita pelas rotas /internal/economy/players. */
const PLAYERS_MAX_WINDOW_MS = 8 * DAY_MS;
// Encerramento do bot: no máximo isso esperando a rodada em andamento (o index.js força saída em 25 s)
const STOP_WAIT_MS = 3000;

/**
 * GET da rota de resumo de um serviço. Erros não carregam corpo de resposta (evita vazar dados).
 * opts.received pede receivedByQuintile (received=1); opts.balances=false pula o cálculo de saldos no
 * serviço (balances=0, resposta com balances: null), usado nos pedaços históricos e na recarga.
 */
async function fetchSummary(baseUrl, headers, from, to, timeoutMs, opts = {}) {
	const { received = false, balances = true, abort = null } = opts;
	const url =
		`${String(baseUrl).replace(/\/+$/, "")}/internal/economy/summary?from=${from}&to=${to}` +
		(received ? "&received=1" : "") +
		(balances ? "" : "&balances=0");
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = abort ? AbortSignal.any([timeout, abort]) : timeout;
	const res = await fetch(url, { headers, signal });
	if (!res.ok) {
		const err = new Error(`HTTP ${res.status} em /internal/economy/summary`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

/** GET da rota por jogador de um serviço (mesmas regras de erro do resumo). */
async function fetchPlayers(baseUrl, headers, from, to, timeoutMs, abort = null) {
	const url = `${String(baseUrl).replace(/\/+$/, "")}/internal/economy/players?from=${from}&to=${to}`;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = abort ? AbortSignal.any([timeout, abort]) : timeout;
	const res = await fetch(url, { headers, signal });
	if (!res.ok) {
		const err = new Error(`HTTP ${res.status} em /internal/economy/players`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

/** Confere a resposta por jogador contra o contrato. */
function validatePlayers(p, currency, from, to) {
	if (!p || typeof p !== "object") throw new Error("resposta vazia");
	if (p.currency !== currency) throw new Error(`moeda inesperada: ${p.currency}`);
	if (p.schemaVersion !== SCHEMA_VERSION) {
		throw new Error(`schemaVersion ${p.schemaVersion} não suportada (esperada ${SCHEMA_VERSION})`);
	}
	if (!p.window || Number(p.window.from) !== from || Number(p.window.to) !== to) {
		throw new Error("janela da resposta não confere");
	}
	if (!Array.isArray(p.players) || !Array.isArray(p.flows))
		throw new Error("players/flows ausentes");
	for (const x of p.players) if (!x || !x.id) throw new Error("jogador sem id");
	for (const f of p.flows) {
		if (!f || !f.id || !f.reason) throw new Error("fluxo por jogador sem id ou reason");
		if (Number(f.amountIn) < 0 || Number(f.amountOut) < 0)
			throw new Error("valor negativo no fluxo");
	}
	return p;
}

/** soulmateCycle do resumo do waifuletes (null se o serviço ainda não manda). */
function validateSoulmate(s, from, to) {
	if (!Array.isArray(s.soulmateCycle)) return null;
	for (const r of s.soulmateCycle) {
		const h = Number(r.hour);
		if (!Number.isFinite(h) || h % HOUR_MS !== 0 || h < hourStart(from) || h >= to) {
			throw new Error(`soulmateCycle com hora fora da janela: ${r.hour}`);
		}
	}
	return s.soulmateCycle;
}

/** Confere a resposta contra o contrato antes de gravar qualquer coisa. */
function validateSummary(s, currency, from, to, { balances = true } = {}) {
	if (!s || typeof s !== "object") throw new Error("resposta vazia");
	if (s.currency !== currency) throw new Error(`moeda inesperada: ${s.currency}`);
	if (s.schemaVersion !== SCHEMA_VERSION) {
		throw new Error(`schemaVersion ${s.schemaVersion} não suportada (esperada ${SCHEMA_VERSION})`);
	}
	if (!Number.isFinite(Number(s.generatedAt))) throw new Error("generatedAt ausente");
	if (balances && (!s.balances || !Number.isFinite(Number(s.balances.total)))) {
		throw new Error("balances ausente");
	}
	const flows =
		s.ledger && s.ledger.available && Array.isArray(s.ledger.flows) ? s.ledger.flows : [];
	for (const f of flows) {
		const h = Number(f.hour);
		if (!Number.isFinite(h) || h % HOUR_MS !== 0 || h < hourStart(from) || h >= to) {
			throw new Error(`fluxo com hora fora da janela: ${f.hour}`);
		}
		if (!f.reason) throw new Error("fluxo sem reason");
		if (Number(f.amountIn) < 0 || Number(f.amountOut) < 0) {
			throw new Error("valor negativo no fluxo");
		}
	}
	return flows;
}

class EconomyAnalyticsService {
	/**
	 * @param {object} [opts] (testes injetam tudo aqui)
	 * @param {string} [opts.dbPath] banco de trabalho
	 * @param {string} [opts.publishDir] diretório publicado para o Grafana
	 * @param {string} [opts.bankDbPath] bank.db (só leitura)
	 * @param {Function} [opts.bankQuery] (sql, params) => rows; substitui a abertura do bank.db
	 * @param {Function} [opts.now] relógio (epoch ms)
	 * @param {string[]} [opts.sources] subconjunto de zinthos, petalitas, runas
	 * @param {number} [opts.backfillStart] fim (epoch ms) do primeiro pedaço da carga inicial
	 */
	constructor(opts = {}) {
		const env = process.env;
		this.now = opts.now || (() => Date.now());
		this.dbPath = opts.dbPath || env.ECONOMY_ANALYTICS_DB;
		this.publishDir = opts.publishDir || env.ECONOMY_ANALYTICS_PUBLISH_DIR;
		this.bankDbPath = resolvePath(
			opts.bankDbPath || env.ECONOMY_ANALYTICS_BANK_DB,
			"data/sqlites/bank.db"
		);
		this.bankQuery = opts.bankQuery || null;
		this.memoryDbPath = resolvePath(
			opts.memoryDbPath || env.ECONOMY_ANALYTICS_MEMORY_DB,
			"data/sqlites/memory.db"
		);
		this.memoryQuery = opts.memoryQuery || null;
		this.cmdUsageDbPath = resolvePath(
			opts.cmdUsageDbPath || env.ECONOMY_ANALYTICS_CMD_USAGE_DB,
			"data/sqlites/cmd_usage.db"
		);
		this.cmdUsageQuery = opts.cmdUsageQuery || null;
		const days = Number(
			opts.playerDays ?? env.ECONOMY_ANALYTICS_PLAYER_DAYS ?? DEFAULT_PLAYER_DAYS
		);
		this.playerDays = Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_PLAYER_DAYS;
		this.timeoutMs = Number(opts.timeoutMs || env.ECONOMY_ANALYTICS_TIMEOUT_MS) || 60000;
		const start =
			opts.backfillStart ??
			Date.parse(`${env.ECONOMY_ANALYTICS_BACKFILL_START || DEFAULT_BACKFILL_START}T07:00:00Z`);
		this.backfillStart = Number.isFinite(start) ? start : Date.parse("2025-01-01T07:00:00Z");
		this.waifuletes = {
			url: opts.waifuletesUrl || env.WAIFULETES_API_URL || "http://host.docker.internal:3030",
			key: opts.waifuletesKey ?? env.WAIFULETES_API_KEY ?? ""
		};
		this.jardim = {
			url: opts.jardimUrl || env.JARDIM_API_URL || "http://host.docker.internal:3040",
			key: opts.jardimKey ?? env.JARDIM_API_KEY ?? ""
		};
		const enabledSources = (
			opts.sources ||
			env.ECONOMY_ANALYTICS_SOURCES ||
			"zinthos,petalitas,runas"
		)
			.toString()
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		this.sources = this._buildSources().filter((s) => enabledSources.includes(s.name));
		this.store = null;
		this.task = null;
		this._running = null;
		this._stopping = false;
		this._abort = null;
		this.stopWaitMs = opts.stopWaitMs ?? STOP_WAIT_MS;
	}

	static getInstance() {
		if (!EconomyAnalyticsService.instance) {
			EconomyAnalyticsService.instance = new EconomyAnalyticsService();
		}
		return EconomyAnalyticsService.instance;
	}

	static isEnabled() {
		return process.env.ECONOMY_ANALYTICS_ENABLED === "true";
	}

	_buildSources() {
		return [
			{
				name: "zinthos",
				currency: "zinthos",
				fetch: (from, to, opts = {}) =>
					fetchSummary(
						this.waifuletes.url,
						{ Authorization: `Bearer ${this.waifuletes.key}` },
						from,
						to,
						this.timeoutMs,
						{ ...opts, abort: this._abort && this._abort.signal }
					),
				fetchPlayers: (from, to) =>
					fetchPlayers(
						this.waifuletes.url,
						{ Authorization: `Bearer ${this.waifuletes.key}` },
						from,
						to,
						this.timeoutMs,
						this._abort && this._abort.signal
					)
			},
			{
				name: "petalitas",
				currency: "petalitas",
				// Sem extrato: uma chamada só, para o retrato atual (nada a fatiar)
				noChunk: true,
				fetch: (from, to, opts = {}) =>
					fetchSummary(
						this.jardim.url,
						{ "x-api-key": this.jardim.key },
						from,
						to,
						this.timeoutMs,
						{ ...opts, abort: this._abort && this._abort.signal }
					),
				fetchPlayers: (from, to) =>
					fetchPlayers(
						this.jardim.url,
						{ "x-api-key": this.jardim.key },
						from,
						to,
						this.timeoutMs,
						this._abort && this._abort.signal
					)
			},
			{
				name: "runas",
				currency: "runas",
				local: true,
				// Retrato da janela ao vivo reconstruído no instante `to` (alinhado ao corte dos fluxos)
				fetch: async (from, to, opts = {}) =>
					this._withBank((q) =>
						buildRunasSummary(q, from, to, this.now(), {
							received: opts.received,
							balancesAt: opts.live ? to : null,
							noBalances: opts.balances === false
						})
					)
			}
		];
	}

	/** Executa fn com uma função de leitura do bank.db aberto só-leitura (fechado ao final). */
	_withBank(fn) {
		return this._withDb(this.bankDbPath, this.bankQuery, fn);
	}

	/** Executa fn com leitura síncrona de um SQLite do bot aberto só-leitura (ou a injetada nos testes). */
	_withDb(file, injected, fn) {
		if (injected) return fn(injected);
		const db = new BetterSQLite(file, { readonly: true, fileMustExist: true });
		try {
			db.pragma("busy_timeout = 5000");
			return fn((sql, params = []) => db.prepare(sql).all(...params));
		} finally {
			db.close();
		}
	}

	_getStore() {
		if (!this.store) {
			const store = new EconomyAnalyticsStore(this.dbPath, this.publishDir);
			const { remapped, previous } = store.syncMapping(MAPPING_VERSION, kindFor, reasonLabelRows());
			if (remapped) {
				logger.info(
					`[economy] Mapeamento (v${previous ?? "-"} → v${MAPPING_VERSION}): ${remapped} linhas de fluxo com tipo regravado.`
				);
			}
			this.store = store;
		}
		return this.store;
	}

	start() {
		if (this.task) return;
		// Minuto 5: dá tempo das transações da hora anterior assentarem nos serviços
		this.task = cron.schedule("5 * * * *", () => {
			this.runOnce().catch((err) => logger.error(`[economy] Falha na carga: ${err.message}`));
		});
		logger.info(
			`[economy] Carga horária do painel ligada (fontes: ${this.sources.map((s) => s.name).join(", ")}; mapeamento v${MAPPING_VERSION}).`
		);
	}

	/**
	 * Para o agendamento e a rodada em andamento: marca parada (checada entre fontes e pedaços), aborta
	 * as chamadas HTTP em curso e espera no máximo stopWaitMs. Só fecha o banco se a rodada terminou;
	 * se não terminou a tempo, deixa como está (o processo vai sair) para não fechar o banco sob ela.
	 */
	async stop() {
		if (this.task) {
			this.task.stop();
			this.task = null;
		}
		this._stopping = true;
		if (this._abort) this._abort.abort(new Error("encerrando"));
		let finished = true;
		if (this._running) {
			let timer;
			const timeout = new Promise((resolve) => {
				timer = setTimeout(() => resolve("timeout"), this.stopWaitMs);
			});
			const r = await Promise.race([
				this._running.then(
					() => "ok",
					() => "ok"
				),
				timeout
			]);
			clearTimeout(timer);
			finished = r === "ok";
		}
		if (finished && this.store) {
			this.store.close();
			this.store = null;
		}
		return finished;
	}

	/** Uma carga completa (todas as fontes). Chamadas concorrentes esperam a que está rodando. */
	runOnce() {
		if (this._running) return this._running;
		if (this._stopping) return Promise.resolve({ stopped: true });
		this._abort = new AbortController();
		this._running = telemetry
			.withSpan("economy.analytics.run", { root: true }, () => this._run())
			.finally(() => {
				this._running = null;
				this._abort = null;
			});
		return this._running;
	}

	async _run() {
		const store = this._getStore();
		const runTs = this.now();
		const results = {};
		for (const source of this.sources) {
			if (this._stopping) return { ...results, stopped: true };
			results[source.name] = await this._loadSource(store, source, runTs);
		}
		for (const source of this.sources) {
			if (this._stopping) return { ...results, stopped: true };
			results[`${source.name}.received`] = await this._loadReceived(store, source, runTs);
		}
		if (this.playerDays > 0) {
			for (const source of this.sources) {
				if (this._stopping) return { ...results, stopped: true };
				results[`${source.name}.players`] = await this._loadPlayers(store, source, runTs);
			}
			if (this._stopping) return { ...results, stopped: true };
			results.atividade = this._loadActivity(store, runTs);
			try {
				results.identities = this._refreshIdentities(store);
				store.pruneBefore(this._minPlayerDay(runTs));
			} catch (err) {
				logger.warn(`[economy] Falha ao regravar identidades: ${err.message}`);
			}
		}
		try {
			this._writeFeatures(store, runTs);
		} catch (err) {
			logger.warn(`[economy] Falha ao gravar a disponibilidade dos painéis: ${err.message}`);
		}
		if (this._stopping) return { ...results, stopped: true };
		try {
			store.publish();
		} catch (err) {
			logger.warn(`[economy] Falha ao publicar o retrato para o Grafana: ${err.message}`);
		}
		return results;
	}

	/** Carrega [último to, hora atual) da fonte, em pedaços quando a distância é grande. */
	async _loadSource(store, source, runTs) {
		const hourNow = hourStart(runTs);
		const last = store.getLastSuccessfulTo(source.name);
		let from = last === null ? 0 : last;
		if (from >= hourNow) return { ok: true, skipped: true, from, to: hourNow };
		const out = { ok: true, from, to: hourNow, rows: 0, chunks: 0 };
		while (from < hourNow) {
			if (this._stopping) return { ...out, stopped: true };
			let to;
			if (source.noChunk) to = hourNow;
			else if (from < this.backfillStart) to = Math.min(this.backfillStart, hourNow);
			else to = Math.min(from + CHUNK_MS, hourNow);
			const r = await this._loadWindow(store, source, from, to, runTs + out.chunks, to === hourNow);
			out.chunks++;
			if (!r.ok) return { ...out, ok: false, error: r.error, to };
			out.rows += r.rows;
			from = to;
		}
		return out;
	}

	_loadWindow(store, source, from, to, runTs, live) {
		return telemetry.withSpan(
			"economy.analytics.load",
			{
				attributes: {
					"economy.source": source.name,
					"economy.window.from": from,
					"economy.window.to": to,
					"economy.live": live
				}
			},
			async (span) => {
				try {
					// Pedaço histórico: sem saldos (balances=0); o retrato só vale para a janela atual
					const summary = await source.fetch(from, to, { live, balances: live });
					const flows = validateSummary(summary, source.currency, from, to, {
						balances: live
					}).map((f) => ({
						...f,
						hour: Number(f.hour),
						kind: kindFor(source.currency, String(f.reason))
					}));
					const available = !!(summary.ledger && summary.ledger.available);
					let rows = store.writeFlows(source.currency, from, to, flows);
					const soulmate = validateSoulmate(summary, from, to);
					if (soulmate) {
						rows += store.writeSoulmate(from, to, soulmate);
						store.setMeta("soulmate_cycle", "1");
					}
					if (live) {
						// O retrato dos serviços é do instante da resposta: só vale para a janela atual.
						// Com balances.totalAtWindowEnd (waifuletes: total menos o extrato com createdAt >= to)
						// o retrato vai para `to`, alinhado ao corte dos fluxos como nas Runas; faixas,
						// percentis e concentração continuam do retrato ao vivo. Sem ele (Jardim), generatedAt.
						const atEnd = summary.balances.totalAtWindowEnd;
						const aligned = atEnd !== null && atEnd !== undefined && Number.isFinite(Number(atEnd));
						rows += store.writeBalance(
							source.currency,
							aligned ? to : Number(summary.generatedAt),
							aligned ? { ...summary.balances, total: Number(atEnd) } : summary.balances
						);
					}
					if (source.local) {
						// Runas: retratos diários (virada das 04:00 BRT) da janela, sem sobrescrever o horário
						const snaps = this._withBank((q) => dailySnapshots(q, from, to));
						for (const s of snaps) {
							rows += store.writeBalance(source.currency, s.ts, s.balances, true);
						}
					}
					store.setLedgerStatus(source.currency, available, runTs);
					const unknown = flows.filter((f) => f.kind === "unknown").length;
					store.recordRun({ ts: runTs, source: source.name, ok: true, from, to, rows });
					telemetry.setAttrs({ "economy.rows": rows, "economy.unknown_reasons": unknown }, span);
					logger.info(
						`[economy] ${source.name}: ${rows} linhas [${new Date(from).toISOString()}, ${new Date(to).toISOString()})${unknown ? `, ${unknown} com motivo sem mapeamento` : ""}.`
					);
					return { ok: true, rows };
				} catch (err) {
					telemetry.recordError(span, err);
					store.recordRun({
						ts: runTs,
						source: source.name,
						ok: false,
						from,
						to,
						rows: 0,
						error: err.message
					});
					logger.warn(`[economy] ${source.name}: carga falhou (${err.message}).`);
					return { ok: false, error: err.message };
				}
			}
		);
	}

	/** Primeiro dia econômico guardado no detalhe por jogador. */
	_minPlayerDay(runTs) {
		return economicDayStart(hourStart(runTs)) - (this.playerDays - 1) * DAY_MS;
	}

	/**
	 * Início da próxima carga diária (por jogador ou atividade): o dia da última carga (o dia corrente é
	 * refeito a cada hora), nunca antes da retenção. null = nada a fazer.
	 */
	_dailyFrom(store, name, runTs, onlyToday = false) {
		const hourNow = hourStart(runTs);
		const minDay = this._minPlayerDay(runTs);
		const last = store.getLastSuccessfulTo(name);
		let from;
		if (onlyToday) from = economicDayStart(hourNow);
		else if (last === null) from = minDay;
		else if (last >= hourNow) return null;
		else from = Math.max(minDay, economicDayStart(last));
		return from < hourNow ? from : null;
	}

	/**
	 * Detalhe por jogador de uma moeda, um dia econômico por chamada. Moeda sem extrato (Jardim): só o
	 * dia corrente, para o saldo atual (não há histórico a pedir).
	 */
	async _loadPlayers(store, source, runTs) {
		const name = `${source.name}.players`;
		const ledger = store.getLedgerAvailable(source.currency);
		if (ledger === null) return { ok: false, skipped: true, error: "fonte nunca carregada" };
		if (!source.local && !source.fetchPlayers) return { ok: true, skipped: true };
		const hourNow = hourStart(runTs);
		const from = this._dailyFrom(store, name, runTs, ledger === false);
		if (from === null) return { ok: true, skipped: true };
		const windows = dayWindows(from, hourNow);
		const out = { ok: true, days: 0, rows: 0 };
		let localPayloads = null;
		const idOf = (id) => rawId(id) || null;
		for (let i = 0; i < windows.length; i++) {
			if (this._stopping) return { ...out, stopped: true };
			const w = windows[i];
			try {
				if (w.to - w.from > PLAYERS_MAX_WINDOW_MS) throw new Error("janela maior que 8 dias");
				let payload;
				if (source.local) {
					if (!localPayloads) {
						localPayloads = this._withBank((q) => runasPlayerDays(q, windows, this.now()));
					}
					payload = localPayloads[i];
				} else {
					payload = await source.fetchPlayers(w.from, w.to);
				}
				validatePlayers(payload, source.currency, w.from, w.to);
				const rows = store.writePlayerDay(source.currency, w.day, payload, {
					live: w.to === hourNow,
					kindFor,
					idOf,
					ts: runTs
				});
				store.recordRun({ ts: runTs + i, source: name, ok: true, from: w.from, to: w.to, rows });
				out.days++;
				out.rows += rows;
			} catch (err) {
				store.recordRun({
					ts: runTs + i,
					source: name,
					ok: false,
					from: w.from,
					to: w.to,
					rows: 0,
					error: err.message
				});
				logger.warn(`[economy] ${name}: carga falhou (${err.message}).`);
				return { ...out, ok: false, error: err.message };
			}
		}
		if (out.days) logger.info(`[economy] ${name}: ${out.days} dia(s), ${out.rows} linhas.`);
		return out;
	}

	/** Atividade (cmd_usage.db, só leitura) do dia da última carga até a hora atual. */
	_loadActivity(store, runTs) {
		const name = "atividade";
		const hourNow = hourStart(runTs);
		const from = this._dailyFrom(store, name, runTs);
		if (from === null) return { ok: true, skipped: true };
		try {
			const data = this._withDb(this.cmdUsageDbPath, this.cmdUsageQuery, (q) =>
				readActivity(q, from, hourNow)
			);
			const rows = store.writeActivity(from, hourNow, data, (u) => rawId(u) || null);
			store.recordRun({ ts: runTs, source: name, ok: true, from, to: hourNow, rows });
			return { ok: true, rows };
		} catch (err) {
			store.recordRun({
				ts: runTs,
				source: name,
				ok: false,
				from,
				to: hourNow,
				rows: 0,
				error: err.message
			});
			logger.warn(`[economy] ${name}: carga falhou (${err.message}).`);
			return { ok: false, error: err.message };
		}
	}

	/** Regrava identities: ID cru → pessoa (telefone, LID resolvido, Telegram) e nome. */
	_refreshIdentities(store) {
		let rows = [];
		try {
			rows = this._withDb(this.memoryDbPath, this.memoryQuery, readIdentities);
		} catch (err) {
			// memory.db ausente: segue sem LID → telefone (o painel mostra "lid sem telefone")
			logger.debug?.(`[economy] memory.db indisponível: ${err.message}`);
		}
		const resolver = new IdentityResolver(rows);
		resolver.addTelegram(store.listTelegramIds());
		const out = store
			.listPlayerIds()
			.map((playerId) => ({ playerId, ...resolver.resolve(playerId) }));
		return store.writeIdentities(out);
	}

	/** Disponibilidade dos painéis que dependem de dado que pode não existir ainda. */
	_writeFeatures(store, runTs) {
		const ok = (name) => store.getLastSuccessfulTo(name) !== null;
		const players = this.playerDays > 0;
		store.writeFeatures(
			[
				{
					key: "jogadores",
					title: "Página Jogadores",
					available: players && this.sources.some((s) => ok(`${s.name}.players`)),
					dependsOn: "rota /internal/economy/players no waifuletes e no Jardim, bank.db",
					detail: players ? null : "desligada (ECONOMY_ANALYTICS_PLAYER_DAYS=0)"
				},
				{
					key: "ciclo_alma_gemea",
					title: "Ciclo da alma gêmea",
					available: store.getMeta("soulmate_cycle") === "1",
					dependsOn: "waifuletes com soulmateCycle no resumo da economia"
				},
				{
					key: "atividade",
					title: "Atividade (comandos usados)",
					available: players && ok("atividade"),
					dependsOn: "cmd_usage.db legível pela ravena"
				},
				{
					key: "fluxos_petalitas",
					title: "Fluxos de Petalitas",
					available: store.getLedgerAvailable("petalitas") === true,
					dependsOn: "extrato do Jardim (fase 2)"
				},
				{
					key: "causa_sem_origem",
					title: "Causa da moeda sem origem",
					available: false,
					dependsOn:
						"fase 2: extrato completo (give-all, sobra do confisco e exclusão de usuário nos Zinthos; transbordo e Carteira Furada nas Runas)"
				}
			],
			runTs
		);
	}

	/**
	 * Recarga de uma janela de fluxos (scripts/economy-reload.js): pede de novo os fluxos ao serviço
	 * (balances=0) ou ao bank.db e regrava só flows_hourly daquela janela, de forma idempotente.
	 * NUNCA mexe em balances, exceto com runasBalances (só Runas): preenche os retratos diários da janela
	 * que faltam, a partir do bank.db (só leitura), sem sobrescrever os que existem.
	 * A janela precisa estar inteira dentro do que já foi carregado e ter no máximo 90 dias.
	 */
	async reloadFlows(currency, from, to, { runasBalances = false } = {}) {
		const source = this.sources.find((s) => s.currency === currency);
		if (!source) throw new Error(`moeda desconhecida ou desligada: ${currency}`);
		if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
			throw new Error("janela inválida: início precisa ser antes do fim");
		}
		if (from % HOUR_MS !== 0 || to % HOUR_MS !== 0) {
			throw new Error("janela inválida: início e fim precisam cair em hora cheia");
		}
		if (to - from > RELOAD_MAX_MS) throw new Error("janela inválida: no máximo 90 dias");
		if (runasBalances && currency !== "runas") {
			throw new Error("--saldos-runas só vale para Runas");
		}
		const store = this._getStore();
		const last = store.getLastSuccessfulTo(source.name);
		if (last === null || to > last) {
			throw new Error("janela inválida: termina depois da última carga bem-sucedida desta moeda");
		}
		if (store.getLedgerAvailable(currency) === false) {
			throw new Error(`${currency} não tem extrato: nada a recarregar`);
		}
		const runTs = this.now();
		const name = `${source.name}.reload`;
		try {
			const summary = await source.fetch(from, to, { balances: false });
			const flows = validateSummary(summary, currency, from, to, { balances: false }).map((f) => ({
				...f,
				hour: Number(f.hour),
				kind: kindFor(currency, String(f.reason))
			}));
			let rows = store.writeFlows(currency, from, to, flows);
			let snapshots = 0;
			if (runasBalances) {
				for (const snap of this._withBank((q) => dailySnapshots(q, from, to))) {
					snapshots += store.writeBalance(currency, snap.ts, snap.balances, true);
				}
				rows += snapshots;
			}
			store.recordRun({ ts: runTs, source: name, ok: true, from, to, rows });
			store.publish();
			return { ok: true, flows: flows.length, snapshots };
		} catch (err) {
			store.recordRun({
				ts: runTs,
				source: name,
				ok: false,
				from,
				to,
				rows: 0,
				error: err.message
			});
			throw err;
		}
	}

	/**
	 * Uma vez por dia econômico: entradas de criação dos últimos 7 dias por quinto de saldo atual
	 * (pedido com received=1). Moeda sem extrato não é pedida; fica uma linha "sem extrato" por dia.
	 */
	async _loadReceived(store, source, runTs) {
		const day = economicDayStart(runTs);
		const name = `${source.name}.received`;
		if (store.hasSuccessfulRunTo(name, day)) return { ok: true, skipped: true };
		const from = day - RECEIVED_WINDOW_MS;
		const available = store.getLedgerAvailable(source.currency);
		if (available === null) return { ok: false, skipped: true, error: "fonte nunca carregada" };
		if (available === false) {
			store.recordRun({
				ts: runTs,
				source: name,
				ok: true,
				from,
				to: day,
				rows: 0,
				error: "sem extrato"
			});
			return { ok: true, rows: 0, noLedger: true };
		}
		try {
			const summary = await source.fetch(from, day, { received: true });
			validateSummary(summary, source.currency, from, day);
			const rows = Array.isArray(summary.receivedByQuintile) ? summary.receivedByQuintile : [];
			const n = rows.length ? store.writeReceived(source.currency, day, rows) : 0;
			store.recordRun({ ts: runTs, source: name, ok: true, from, to: day, rows: n });
			return { ok: true, rows: n };
		} catch (err) {
			store.recordRun({
				ts: runTs,
				source: name,
				ok: false,
				from,
				to: day,
				rows: 0,
				error: err.message
			});
			logger.warn(`[economy] ${name}: carga falhou (${err.message}).`);
			return { ok: false, error: err.message };
		}
	}
}

module.exports = EconomyAnalyticsService;
module.exports.fetchSummary = fetchSummary;
module.exports.validateSummary = validateSummary;
module.exports.validatePlayers = validatePlayers;
