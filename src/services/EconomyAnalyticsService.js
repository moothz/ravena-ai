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
 * No bot, roda num worker_threads próprio (EconomyAnalyticsWorkerHost → EconomyAnalyticsWorker), fora da
 * thread que atende o WhatsApp; os scripts (economy-status, -reload, -annotate) usam a classe direto.
 *
 * Uma rodada cerca de 1 minuto depois da subida e depois toda hora no minuto 5 (só com
 * ECONOMY_ANALYTICS_ENABLED=true): para cada fonte pede
 * [to da última carga ok, início da hora atual) e grava fluxos por hora e motivo e o resultado em
 * load_runs. A primeira carga pede from=0, em pedaços: [0, ECONOMY_ANALYTICS_BACKFILL_START) e depois
 * janelas de 30 dias, cada uma registrada como carga ok (um timeout não faz voltar ao zero).
 * O retrato de saldos só é gravado na janela que chega à hora atual. Falha de uma fonte não para as
 * outras. Uma vez por dia econômico (04:00 BRT) grava quem recebe (últimos 7 dias, por quinto), só
 * para moeda com extrato.
 *
 * Por jogador (aba Jogadores e ficha do jogador, ECONOMY_ANALYTICS_PLAYER_DAYS dias, padrão 90; 0 desliga): a cada
 * rodada pede GET /internal/economy/players por dia econômico, do dia da última carga até a hora atual
 * (o dia corrente é refeito a cada hora), e lê as Runas do bank.db, um dia por vez, cedendo o laço de
 * eventos entre os dias. Aumentar PLAYER_DAYS não busca os dias antigos que faltam: a carga continua do
 * último dia carregado e os dias a mais se enchem com o tempo (ver OBSERVABILITY.md). Atividade: comandos do cmd_usage.db
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
const {
	kindFor,
	MAPPING_VERSION,
	reasonLabelRows,
	nonMonetaryReasons
} = require("./EconomyAnalyticsMapping");
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
	runasPlayerStart,
	runasPlayerDay,
	readActivity
} = require("./EconomyAnalyticsPlayers");
const Changes = require("./EconomyAnalyticsChanges");

const logger = new Logger("economy-analytics");
const SCHEMA_VERSION = 1;
const RECEIVED_WINDOW_MS = 7 * DAY_MS;
const CHUNK_MS = 30 * DAY_MS;
const RELOAD_MAX_MS = 90 * DAY_MS;
const DEFAULT_BACKFILL_START = "2025-01-01";
const DEFAULT_PLAYER_DAYS = 90;
/** Janela máxima aceita pelas rotas /internal/economy/players. */
const PLAYERS_MAX_WINDOW_MS = 8 * DAY_MS;
// Primeira rodada depois da subida (dá tempo do bot assentar); 0 ou ECONOMY_ANALYTICS_RUN_ON_START=false desliga
const DEFAULT_START_DELAY_MS = 60000;
// Mesma regra de balances.totalAtWindowEnd no waifuletes (a waifu confiscada nunca creditou o saldo):
// a massa histórica desconta todo motivo non_monetary do mapeamento (HOSTING_FEE_WAIFU nos Zinthos)
const massExcludedReasons = (currency) => nonMonetaryReasons(currency);
/** Intervalos aceitos para o agendamento (horas): cron "5 *\/N * * *". */
const EVERY_HOURS_PRESETS = [1, 2, 3, 6, 12, 24];
const cronFor = (h) => (h === 1 ? "5 * * * *" : `5 */${h} * * *`);
// Intervalo acima do qual a hora de uma mudança automática sem subida do serviço é "aproximada"
const APPROX_HOUR_MS = 2 * HOUR_MS;
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
		const delay = Number(opts.startDelayMs ?? env.ECONOMY_ANALYTICS_START_DELAY_MS);
		this.startDelayMs =
			(opts.runOnStart ?? env.ECONOMY_ANALYTICS_RUN_ON_START) === false ||
			String(env.ECONOMY_ANALYTICS_RUN_ON_START).toLowerCase() === "false"
				? 0
				: Number.isFinite(delay) && delay >= 0
					? delay
					: DEFAULT_START_DELAY_MS;
		this._startTimer = null;
		// Parâmetros das Runas (testes injetam; senão, economyConstants.js, o mesmo que o BankService usa)
		this.runasParams = opts.runasParams || Changes.runasParams;
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

	/**
	 * Executa fn com leitura síncrona de um SQLite do bot aberto só-leitura (ou a injetada nos testes).
	 * A função de leitura guarda os comandos preparados (a busca binária repete o mesmo SQL) e tem
	 * .iterate(sql, params) para ler em fluxo sem montar a lista.
	 */
	_withDb(file, injected, fn) {
		if (injected) return fn(injected);
		const db = new BetterSQLite(file, { readonly: true, fileMustExist: true });
		try {
			db.pragma("busy_timeout = 5000");
			const stmts = new Map();
			const prep = (sql) => {
				let st = stmts.get(sql);
				if (!st) stmts.set(sql, (st = db.prepare(sql)));
				return st;
			};
			const q = (sql, params = []) => prep(sql).all(...params);
			q.iterate = (sql, params = []) => prep(sql).iterate(...params);
			return fn(q);
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

	/**
	 * Agendamento em vigor: intervalo (horas) e pausa. Precedência: meta do banco (gravado pelo admin,
	 * /banco/admin) > ECONOMY_ANALYTICS_EVERY_HOURS > 1 h. Intervalo fora de EVERY_HOURS_PRESETS vira 1.
	 * @returns {{everyHours:number, paused:boolean, updatedAt:number|null, from:string, cron:string}}
	 */
	scheduleState(store = this._getStore()) {
		const metaHours = Number(store.getMeta("schedule.every_hours"));
		const envHours = Number(process.env.ECONOMY_ANALYTICS_EVERY_HOURS);
		let everyHours = 1;
		let from = "padrão";
		if (EVERY_HOURS_PRESETS.includes(metaHours)) {
			everyHours = metaHours;
			from = "admin";
		} else if (EVERY_HOURS_PRESETS.includes(envHours)) {
			everyHours = envHours;
			from = "env";
		}
		return {
			everyHours,
			paused: store.getMeta("schedule.paused") === "1",
			updatedAt: Number(store.getMeta("schedule.updated_at")) || null,
			from,
			cron: cronFor(everyHours)
		};
	}

	/** (Re)cria a tarefa do cron conforme o agendamento; pausado, fica sem tarefa. */
	_applySchedule(state) {
		if (this.task) {
			this.task.stop();
			this.task = null;
		}
		if (state.paused || this._stopping) return;
		this.task = cron.schedule(state.cron, () => {
			this.runOnce().catch((err) => logger.error(`[economy] Falha na carga: ${err.message}`));
		});
	}

	start() {
		if (this._started) return;
		this._started = true;
		let state;
		try {
			state = this.scheduleState();
		} catch (err) {
			// Banco recusado ou ilegível: agenda pelo env; cada rodada vai registrar o erro
			logger.error(`[economy] Falha ao ler o agendamento: ${err.message}`);
			const env = Number(process.env.ECONOMY_ANALYTICS_EVERY_HOURS);
			const h = EVERY_HOURS_PRESETS.includes(env) ? env : 1;
			state = { everyHours: h, paused: false, cron: cronFor(h) };
		}
		// Minuto 5: dá tempo das transações da hora anterior assentarem nos serviços
		this._applySchedule(state);
		// Uma rodada logo depois da subida: sem ela, a primeira carga (e o retrato que o Grafana lê) só sai
		// no minuto 5 da hora seguinte. A carga é incremental, então reiniciar o bot não recarrega nada.
		// Pausada pelo admin: nem agenda nem roda a da subida.
		if (this.startDelayMs > 0 && !state.paused) {
			this._startTimer = setTimeout(() => {
				this._startTimer = null;
				this.runOnce().catch((err) =>
					logger.error(`[economy] Falha na carga da subida: ${err.message}`)
				);
			}, this.startDelayMs);
			if (this._startTimer.unref) this._startTimer.unref();
		}
		this._publishIfSchemaChanged();
		logger.info(
			`[economy] Carga do painel ${state.paused ? "PAUSADA" : `ligada a cada ${state.everyHours} h`} (fontes: ${this.sources.map((s) => s.name).join(", ")}; mapeamento v${MAPPING_VERSION}).`
		);
	}

	/** Publica o retrato para o Grafana refletir a mudança (estado em meta); falha só vai para o log. */
	async _publishQuiet() {
		try {
			await this._getStore().publish();
			return true;
		} catch (err) {
			logger.warn(`[economy] Falha ao publicar o retrato para o Grafana: ${err.message}`);
			return false;
		}
	}

	_saveSchedule(changes) {
		const store = this._getStore();
		for (const [k, v] of Object.entries(changes)) store.setMeta(k, v);
		store.setMeta("schedule.updated_at", this.now());
		const state = this.scheduleState(store);
		if (this._started) this._applySchedule(state);
		return state;
	}

	/**
	 * Muda o intervalo (admin). Só os presets de EVERY_HOURS_PRESETS (cron "5 *\/N * * *").
	 * @returns {Promise<object>} agendamento em vigor
	 */
	async reschedule(everyHours) {
		const h = Number(everyHours);
		if (!EVERY_HOURS_PRESETS.includes(h)) {
			throw new Error(`intervalo inválido: use ${EVERY_HOURS_PRESETS.join(", ")} horas`);
		}
		const state = this._saveSchedule({ "schedule.every_hours": h });
		logger.info(`[economy] Agendamento: a cada ${h} h (${state.cron}).`);
		await this._publishQuiet();
		return state;
	}

	/** Pausa o agendamento (a rodada em andamento termina normalmente; "rodar agora" continua valendo). */
	async pause() {
		if (this._startTimer) {
			clearTimeout(this._startTimer);
			this._startTimer = null;
		}
		const state = this._saveSchedule({ "schedule.paused": "1" });
		logger.info("[economy] Agendamento pausado.");
		await this._publishQuiet();
		return state;
	}

	/** Retoma o agendamento. A próxima rodada continua de onde parou, em pedaços (como a primeira carga). */
	async resume() {
		const state = this._saveSchedule({ "schedule.paused": "0" });
		logger.info(`[economy] Agendamento retomado (a cada ${state.everyHours} h).`);
		await this._publishQuiet();
		return state;
	}

	/** Anotações para o admin (id curto; só as possíveis com onlyPossible). */
	listAnnotations({ onlyPossible = false, limit = 200 } = {}) {
		const list = this._getStore().listAnnotations({
			withId: true,
			origin: onlyPossible ? "possivel" : null
		});
		return list.slice(-Math.max(1, Math.min(1000, Number(limit) || 200))).reverse();
	}

	/**
	 * Registra uma mudança à mão (admin): texto, moeda (zinthos | petalitas | runas | todas) e hora
	 * opcional (padrão agora). Nunca sobrescreve uma anotação existente.
	 */
	async addManualAnnotation({ text, currency = "todas", ts = null } = {}) {
		const label = String(text || "").trim();
		if (!label || label.length > 300) throw new Error("texto obrigatório (até 300 caracteres)");
		if (!["zinthos", "petalitas", "runas", "todas"].includes(currency)) {
			throw new Error("moeda inválida");
		}
		const when = ts === null || ts === undefined || ts === "" ? this.now() : Number(ts);
		if (
			!Number.isFinite(when) ||
			when < Date.parse("2020-01-01") ||
			when > this.now() + 30 * DAY_MS
		) {
			throw new Error("hora inválida");
		}
		const store = this._getStore();
		if (
			!store.insertAnnotationIfMissing(
				when,
				currency === "todas" ? null : currency,
				label,
				"manual"
			)
		) {
			throw new Error("já existe uma anotação com esse texto nessa hora");
		}
		const annotation = store.findAnnotation({ ts: when, label });
		return { annotation, published: await this._publishQuiet() };
	}

	/** Confirma ou descarta uma possível mudança pelo id (admin). */
	async decideAnnotation(id, decision, text = null) {
		const r = this._getStore().decideAnnotation({ id: Number(id) }, decision, text);
		if (!r.ok) throw new Error(r.error);
		return { annotation: r.annotation, published: await this._publishQuiet() };
	}

	/**
	 * Banco antigo que ganhou tabela ou coluna ao abrir (store.schemaChanged): publica uma vez já, para o
	 * retrato do Grafana ter o schema novo sem esperar a próxima rodada. Falha só vai para o log.
	 */
	_publishIfSchemaChanged() {
		let store;
		try {
			store = this._getStore();
		} catch (err) {
			logger.error(`[economy] Falha ao abrir o banco da carga: ${err.message}`);
			return;
		}
		if (!store.schemaChanged) return;
		store.schemaChanged = false;
		// stop() espera esta publicação como espera a rodada (não fecha o banco no meio do backup)
		this._schemaPublish = store
			.publish()
			.then(() => logger.info("[economy] Schema do banco atualizado; retrato republicado."))
			.catch((err) =>
				logger.warn(`[economy] Falha ao publicar o retrato com o schema novo: ${err.message}`)
			)
			.finally(() => {
				this._schemaPublish = null;
			});
	}

	/**
	 * Para o agendamento e a rodada em andamento: marca parada (checada entre fontes e pedaços), aborta
	 * as chamadas HTTP em curso e espera no máximo stopWaitMs. Só fecha o banco se a rodada terminou;
	 * se não terminou a tempo, deixa como está (o processo vai sair) para não fechar o banco sob ela.
	 */
	async stop() {
		this._started = false;
		if (this.task) {
			this.task.stop();
			this.task = null;
		}
		if (this._startTimer) {
			clearTimeout(this._startTimer);
			this._startTimer = null;
		}
		this._stopping = true;
		if (this._abort) this._abort.abort(new Error("encerrando"));
		let finished = true;
		const pending = [this._running, this._schemaPublish].filter(Boolean);
		if (pending.length) {
			let timer;
			const timeout = new Promise((resolve) => {
				timer = setTimeout(() => resolve("timeout"), this.stopWaitMs);
			});
			const r = await Promise.race([Promise.allSettled(pending).then(() => "ok"), timeout]);
			clearTimeout(timer);
			finished = r === "ok";
		}
		if (finished && this.store) {
			this.store.close();
			this.store = null;
		} else if (this.store) {
			// A rodada pode estar no meio da publicação e o processo vai sair: libera a própria trava, para
			// a próxima subida (no Docker, com o mesmo PID) não esperar ela envelhecer
			this.store.releasePublishLock();
		}
		return finished;
	}

	/**
	 * "Rodar agora" (RPC do worker): começa uma rodada sem esperar por ela. Se já há uma rodando, não
	 * começa outra (runOnce devolve a mesma). @returns {{started:boolean, running:boolean}}
	 */
	runNow() {
		if (this._stopping) return { started: false, running: false, stopped: true };
		if (this._running) return { started: false, running: true };
		this.runOnce().catch((err) => logger.error(`[economy] Falha na carga pedida: ${err.message}`));
		return { started: true, running: true };
	}

	/**
	 * Estado da carga (RPC do worker; base do GET de estado do admin): por fonte, até quando há dados,
	 * a última tentativa e o último erro; se há rodada em andamento; data do retrato publicado.
	 */
	status() {
		const store = this._getStore();
		let published = null;
		try {
			published = Math.round(require("fs").statSync(store.publishedPath).mtimeMs);
		} catch (_) {}
		return {
			running: !!this._running,
			runningSince: this._runningSince || null,
			scheduled: !!this.task,
			schedule: this.scheduleState(store),
			sources: this.sources.map((s) => s.name),
			loads: store.loadStatus(),
			published,
			now: this.now()
		};
	}

	/** Uma carga completa (todas as fontes). Chamadas concorrentes esperam a que está rodando. */
	runOnce() {
		if (this._running) return this._running;
		if (this._stopping) return Promise.resolve({ stopped: true });
		this._abort = new AbortController();
		this._runningSince = this.now();
		this._running = telemetry
			.withSpan("economy.analytics.run", { root: true }, () => this._run())
			.finally(() => {
				this._running = null;
				this._runningSince = null;
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
		if (this._stopping) return { ...results, stopped: true };
		try {
			results.params = await this._loadParams(store, runTs);
		} catch (err) {
			logger.warn(`[economy] Falha ao ler parâmetros de balanceamento: ${err.message}`);
		}
		try {
			results.possiveis = this._detectChanges(store, runTs);
		} catch (err) {
			logger.warn(`[economy] Falha ao procurar possíveis mudanças: ${err.message}`);
		}
		try {
			this._writeFeatures(store, runTs);
		} catch (err) {
			logger.warn(`[economy] Falha ao gravar a disponibilidade dos painéis: ${err.message}`);
		}
		if (this._stopping) return { ...results, stopped: true };
		try {
			await store.publish();
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
						if (aligned && !source.local) {
							rows += this._reconstructMass(store, source.currency, to, Number(atEnd));
						}
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

	/**
	 * Massa histórica (só o total) de uma moeda com extrato, uma vez: anda para trás a partir do primeiro
	 * retrato alinhado (`anchorTs`, `anchorTotal`) descontando o líquido dos fluxos já carregados, e grava um
	 * retrato por virada de dia econômico (04:00 BRT) que ainda não exista. Não sobrescreve retrato real.
	 * Faixas, percentis e concentração do passado ficam vazios (o extrato não dá o saldo de cada um sem
	 * reconstruir jogador a jogador). Mesma ressalva de totalAtWindowEnd: mudança de saldo sem linha no
	 * extrato cai no período anterior a ela.
	 * @returns {number} retratos gravados
	 */
	_reconstructMass(store, currency, anchorTs, anchorTotal) {
		const key = `mass_reconstructed:${currency}`;
		if (store.getMeta(key)) return 0;
		const r = store.reconstructMass(currency, anchorTs, anchorTotal, massExcludedReasons(currency));
		store.setMeta(key, JSON.stringify({ anchorTs, ...r }));
		// Lido pelo painel: a conferência de moeda sem origem ignora os retratos reconstruídos (antes disto)
		store.setMeta(`mass_reconstructed_before:${currency}`, anchorTs);
		if (r.written) {
			logger.info(
				`[economy] ${currency}: massa histórica reconstruída pelo extrato (${r.written} dias desde ${new Date(r.from).toISOString().slice(0, 10)}).`
			);
		}
		return r.written;
	}

	/**
	 * Parâmetros de balanceamento: compara com a leitura anterior de cada serviço e registra o que mudou
	 * como anotação automática (origin 'auto'). A primeira leitura só guarda. Serviço sem a rota (404)
	 * fica de fora sem erro. Chave acrescentada (valor novo sem antigo) vira anotação quando a version do
	 * serviço é a mesma da leitura anterior (dado ou catálogo mudou sem deploy de código) ou quando começa
	 * com "catalog." (item novo de catálogo, relido a quente); com version nova ou sem version, é o deploy
	 * passando a expor constantes, nada mudou no jogo: vai só para a base, o log e o detail. Leitura com
	 * schemaVersion diferente da anterior (formato mudou) só regrava a base.
	 *
	 * Hora: a mudança aconteceu em (leitura anterior, esta leitura]. Se o serviço subiu nesse intervalo
	 * (startedAt), é a hora exata; senão vai para a hora cheia da leitura, nunca antes da leitura anterior,
	 * e o rótulo ganha "(hora aproximada)" quando o intervalo passa de 2 h. O detalhe sempre leva o
	 * intervalo (between) e o startedAt. Mudança de câmbio das Runas é anotada em "todas" (mexe também em
	 * Zinthos e Petalitas).
	 */
	async _loadParams(store, runTs) {
		const readers = [];
		for (const src of this.sources) {
			if (src.name === "zinthos") {
				readers.push({
					service: "waifuletes",
					currency: "zinthos",
					read: () =>
						Changes.fetchParams(
							this.waifuletes.url,
							{ Authorization: `Bearer ${this.waifuletes.key}` },
							this.timeoutMs,
							this._abort && this._abort.signal
						)
				});
			} else if (src.name === "petalitas") {
				readers.push({
					service: "jardim",
					currency: "petalitas",
					read: () =>
						Changes.fetchParams(
							this.jardim.url,
							{ "x-api-key": this.jardim.key },
							this.timeoutMs,
							this._abort && this._abort.signal
						)
				});
			} else if (src.name === "runas") {
				readers.push({
					service: "ravena",
					currency: "runas",
					allCurrencies: Changes.RUNAS_ALL_CURRENCIES_PREFIXES,
					read: async () => this.runasParams()
				});
			}
		}
		const out = {};
		for (const r of readers) {
			if (this._stopping) break;
			try {
				const got = await r.read();
				// Teto do intervalo da mudança: o instante em que a leitura voltou
				const readAt = this.now();
				if (!got || got.missing) {
					store.setMeta(`params_available:${r.service}`, 0);
					out[r.service] = { ok: true, available: false };
					continue;
				}
				const prev = store.getParams(r.service);
				const prevTs = Number(store.getMeta(`params_ts:${r.service}`)) || 0;
				const prevSchema = store.getMeta(`params_schema:${r.service}`);
				const schema =
					got.schemaVersion === null || got.schemaVersion === undefined
						? null
						: String(got.schemaVersion);
				const schemaChanged = prevSchema !== null && schema !== null && prevSchema !== schema;
				const prevVersion = store.getMeta(`params_version:${r.service}`);
				const all = Changes.diffParams(prev, got.params);
				const added = all.filter((c) => c.from === null);
				// Chave nova vira anotação quando é mudança de dado sem deploy de código (mesma version da
				// leitura anterior, conhecida) ou item de catálogo (catalog.*, relido a quente no Jardim);
				// com version nova ou desconhecida é o deploy passando a expor constantes: só log e detail
				const sameVersion = !!got.version && prevVersion === got.version;
				const addedNoted = added.filter((c) => sameVersion || c.key.startsWith("catalog."));
				const addedQuiet = added.filter((c) => !addedNoted.includes(c));
				const changes = schemaChanged
					? []
					: [...all.filter((c) => c.from !== null), ...addedNoted].sort((a, b) =>
							a.key < b.key ? -1 : a.key > b.key ? 1 : 0
						);
				if (schemaChanged) {
					logger.info(
						`[economy] ${r.service}: formato dos parâmetros mudou (schemaVersion ${prevSchema} → ${schema}); base regravada sem anotar.`
					);
				} else if (addedQuiet.length) {
					logger.info(
						`[economy] ${r.service}: ${addedQuiet.length} parâmetro(s) passaram a ser expostos (${addedQuiet
							.map((c) => c.key)
							.join(", ")
							.slice(0, 300)}); só guardados, sem anotação.`
					);
				}
				if (changes.length) {
					const exact = !!got.startedAt && got.startedAt > prevTs && got.startedAt <= readAt;
					const ts = exact
						? got.startedAt
						: Math.min(readAt, Math.max(prevTs + 1, hourStart(readAt)));
					const approx = !exact && readAt - prevTs > APPROX_HOUR_MS;
					const currency =
						r.allCurrencies && changes.some((c) => r.allCurrencies.some((p) => c.key.startsWith(p)))
							? null
							: r.currency;
					store.addAnnotation(
						ts,
						currency,
						`${Changes.changeLabel(r.service, changes)}${approx ? " (hora aproximada)" : ""}`,
						"auto",
						{
							service: r.service,
							version: got.version,
							changes,
							...(addedQuiet.length ? { added: addedQuiet } : {}),
							between: [prevTs || null, readAt],
							startedAt: got.startedAt || null,
							exact
						}
					);
					logger.info(
						`[economy] ${r.service}: ${changes.length} parâmetro(s) de balanceamento mudaram; anotação registrada.`
					);
				}
				if (!prev || all.length) store.replaceParams(r.service, got.params, readAt);
				store.setMeta(`params_ts:${r.service}`, readAt);
				if (schema !== null) store.setMeta(`params_schema:${r.service}`, schema);
				store.setMeta(`params_version:${r.service}`, got.version || "");
				store.setMeta(`params_available:${r.service}`, 1);
				out[r.service] = {
					ok: true,
					available: true,
					changes: changes.length,
					added: added.length
				};
			} catch (err) {
				out[r.service] = { ok: false, error: err.message };
				logger.warn(`[economy] ${r.service}: leitura de parâmetros falhou (${err.message}).`);
			}
		}
		return out;
	}

	/**
	 * Possíveis mudanças, uma vez por dia econômico e moeda com extrato: olha cada dia completo já
	 * carregado desde o último olhado (detect_day; no máximo DETECT.lookbackDays para trás, e só o último
	 * na primeira vez), procurando motivo novo, motivo que sumiu e valor por transação fora do normal, e
	 * registra cada achado como anotação 'possivel' no início do dia. Dia sem dados (total de transações
	 * 0 ou bem abaixo da mediana dos 28 dias antes: serviço fora, extrato incompleto) não emite nada.
	 * Motivo novo só com DETECT.lookbackDays de histórico. Valor por transação no mesmo dia de uma mudança
	 * automática da mesma moeda já entra descartado, com a referência (é efeito dela). Nunca reescreve uma
	 * anotação que já existe (confirmada ou descartada continua como está).
	 */
	_detectChanges(store, runTs) {
		const lastDay = economicDayStart(hourStart(runTs)) - DAY_MS;
		const look = Changes.DETECT.lookbackDays;
		const out = {};
		for (const src of this.sources) {
			if (!store.getLedgerAvailable(src.currency)) continue;
			const key = `detect_day:${src.currency}`;
			const loaded = store.getLastSuccessfulTo(src.name);
			if (loaded === null) continue;
			// Último dia completo com os dados já carregados
			const last = Math.min(lastDay, economicDayStart(loaded) - DAY_MS);
			const seen = Number(store.getMeta(key)) || null;
			let day = seen ? seen + DAY_MS : last;
			day = Math.max(day, last - (look - 1) * DAY_MS);
			const nome = { zinthos: "Zinthos", petalitas: "Petalitas", runas: "Runas" }[src.currency];
			for (; day <= last; day += DAY_MS) {
				const rows = store.dailyReasonStats(src.currency, day - look * DAY_MS, day + DAY_MS);
				const first = rows.reduce((m, x) => Math.min(m, Number(x.day)), Infinity);
				let found = [];
				// Sem histórico mínimo (carga recente) ou dia sem dados: nada a dizer
				if (first <= day - Changes.DETECT.steadyDays * DAY_MS && !Changes.isLowDataDay(rows, day)) {
					found = Changes.detectPossible(
						rows,
						day,
						(reason) => store.reasonLabel(src.currency, reason),
						Changes.DETECT,
						{ allowNew: first <= day - look * DAY_MS }
					);
				}
				const autos = found.length ? store.autoAnnotations(src.currency, day, day + DAY_MS) : [];
				// A moeda vai no rótulo: (ts, rótulo) é a chave, e o mesmo motivo pode existir em duas moedas
				for (const f of found) {
					const label = `${f.label} (${nome})`;
					if (store.hasAnnotation(day, label)) continue;
					const auto = f.detail.kind === "per_tx_shift" && autos[0];
					store.addAnnotation(
						day,
						src.currency,
						label,
						auto ? "descartada" : "possivel",
						auto
							? {
									...f.detail,
									dismissed: "mudança automática no mesmo dia",
									ref: { id: auto.id, ts: auto.ts, label: auto.label }
								}
							: f.detail
					);
				}
				store.setMeta(key, day);
				out[src.currency] = (out[src.currency] || 0) + found.length;
			}
		}
		return out;
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
		// Runas: saldo no início da primeira janela uma vez; depois um dia por vez, andando para a frente
		let runasState = null;
		const idOf = (id) => rawId(id) || null;
		for (let i = 0; i < windows.length; i++) {
			if (this._stopping) return { ...out, stopped: true };
			// Cede o laço de eventos entre os dias (stop, RPC do bot e timers seguem respondendo)
			if (i > 0) await new Promise((r) => setImmediate(r));
			const w = windows[i];
			try {
				if (w.to - w.from > PLAYERS_MAX_WINDOW_MS) throw new Error("janela maior que 8 dias");
				let payload;
				if (source.local) {
					payload = this._withBank((q) => {
						if (!runasState) runasState = runasPlayerStart(q, windows[0].from);
						return runasPlayerDay(q, w, runasState, this.now());
					});
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
		// Sem nome no memory.db: o maior nome que algum serviço mandou para qualquer ID da pessoa (o mesmo
		// que o painel calculava com uma subconsulta correlata), gravado em todas as linhas dela
		const serviceName = store.playerNames();
		const byPerson = new Map();
		for (const r of out) {
			const n = serviceName.get(r.playerId);
			if (n && !(byPerson.get(r.person) >= n)) byPerson.set(r.person, n);
		}
		for (const r of out) if (!r.name) r.name = byPerson.get(r.person) || null;
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
					key: "mudancas_automaticas",
					title: "Mudanças automáticas (parâmetros de balanceamento)",
					available: ["waifuletes", "jardim", "ravena"].some(
						(n) => store.getMeta(`params_available:${n}`) === "1"
					),
					dependsOn:
						"rota /internal/economy/params no waifuletes e no Jardim; economyConstants.js (Runas)",
					detail: ["waifuletes", "jardim", "ravena"]
						.map(
							(n) =>
								`${n}: ${store.getMeta(`params_available:${n}`) === "1" ? "lendo" : "sem leitura"}`
						)
						.join(", ")
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
	 * (balances=0) ou ao bank.db e regrava só flows_hourly daquela janela, de forma idempotente. Não
	 * refaz o detalhe por jogador (player_daily): esse é refeito só para o dia corrente a cada hora.
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
			await store.publish();
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
module.exports.EVERY_HOURS_PRESETS = EVERY_HOURS_PRESETS;
