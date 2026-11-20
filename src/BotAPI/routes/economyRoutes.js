/**
 * economyRoutes.js
 *
 * Admin da carga do painel da economia (Grafana), usado pelo cartão "Painel da economia" da aba
 * "Configurações & Economia" do /banco/admin. Tudo passa pelo proxy do worker da carga
 * (EconomyAnalyticsWorkerHost); nada aqui lê ou grava SQLite na thread do bot.
 * Arquivo: src/BotAPI/routes/economyRoutes.js
 *
 * Rotas registradas (todas com authenticateBasic e generalLimiter):
 * - GET  /api/economy/admin/status               - estado por fonte, agendamento, rodada em andamento
 * - POST /api/economy/admin/schedule             - { everyHours: 1|2|3|6|12|24 } → cron "5 *\/N * * *";
 *                                                  { useDefault: true } volta ao padrão do .env
 *                                                  (ECONOMY_ANALYTICS_EVERY_HOURS, ou 1 h)
 * - POST /api/economy/admin/pause                - pausa o agendamento
 * - POST /api/economy/admin/resume               - retoma o agendamento
 * - POST /api/economy/admin/run                  - rodar agora (202 na hora; não duplica rodada)
 * - GET  /api/economy/admin/annotations          - anotações (?possiveis=1 só as possíveis)
 * - POST /api/economy/admin/annotations          - { texto, moeda, hora? } registra mudança à mão
 * - POST /api/economy/admin/annotations/decide   - { id, decision: confirmada|descartada, texto? }
 *
 * Proteção contra CSRF nos POST (a sessão do admin é cookie): exige Content-Type application/json
 * (formulário de outro site não manda JSON sem preflight) → 415; recusa Sec-Fetch-Site cross-site e
 * Origin de outro host → 403. Escritas com ECONOMY_ANALYTICS_ENABLED diferente de "true" (ou com a
 * carga parada, ex. DISABLE_ACTIVITY=true) → 409.
 *
 * @param {Object} api - Instância da BotAPI
 * @param {Object} [host] - proxy do worker (testes injetam)
 */
"use strict";

const EconomyAnalyticsWorkerHost = require("../../services/EconomyAnalyticsWorkerHost");

const PRESETS = [1, 2, 3, 6, 12, 24];
const MOEDAS = ["zinthos", "petalitas", "runas", "todas"];

/** Guarda contra CSRF para os POST (ver cabeçalho). */
function csrfGuard(req, res, next) {
	if (String(req.get("sec-fetch-site") || "").toLowerCase() === "cross-site") {
		return res.status(403).json({ status: "error", message: "Requisição de outro site recusada" });
	}
	const origin = req.get("origin");
	if (origin) {
		let host = null;
		try {
			host = new URL(origin).host;
		} catch (_) {}
		const allowed = [req.get("host"), req.get("x-forwarded-host")].filter(Boolean);
		if (!host || !allowed.includes(host)) {
			return res.status(403).json({ status: "error", message: "Origem recusada" });
		}
	}
	if (!/^application\/json\b/i.test(String(req.get("content-type") || ""))) {
		return res
			.status(415)
			.json({ status: "error", message: "Envie Content-Type: application/json" });
	}
	return next();
}

function registerEconomyRoutes(api, host = null) {
	const getHost = () => host || EconomyAnalyticsWorkerHost.getInstance();
	const enabled = () => process.env.ECONOMY_ANALYTICS_ENABLED === "true";
	const base = "/api/economy/admin";
	const read = [api.authenticateBasic, api.generalLimiter];
	const write = [api.authenticateBasic, api.generalLimiter, csrfGuard, requireRunning];

	/** Escrita só com a carga ligada e o worker de pé. */
	function requireRunning(req, res, next) {
		if (!enabled()) {
			return res.status(409).json({
				status: "error",
				message: "Carga do painel desligada (ECONOMY_ANALYTICS_ENABLED diferente de true)"
			});
		}
		if (!getHost().running) {
			return res.status(409).json({
				status: "error",
				message: "Carga do painel não está rodando (ex.: DISABLE_ACTIVITY=true)"
			});
		}
		return next();
	}

	const fail = (res, err, status = 500) =>
		res.status(status).json({ status: "error", message: err.message || String(err) });

	api.app.get(`${base}/status`, ...read, async (req, res) => {
		const h = getHost();
		if (!enabled() || !h.running) {
			return res.json({ status: "ok", enabled: enabled(), worker: false, presets: PRESETS });
		}
		try {
			const st = await h.status();
			// st.running = rodada em andamento; worker = carga de pé
			return res.json({ status: "ok", enabled: true, worker: true, presets: PRESETS, ...st });
		} catch (err) {
			return fail(res, err, 503);
		}
	});

	api.app.post(`${base}/schedule`, ...write, async (req, res) => {
		const useDefault = !!req.body && req.body.useDefault === true;
		const everyHours = useDefault ? null : Number(req.body && req.body.everyHours);
		if (!useDefault && !PRESETS.includes(everyHours)) {
			return res
				.status(400)
				.json({ status: "error", message: `everyHours precisa ser ${PRESETS.join(", ")}` });
		}
		try {
			return res.json({ status: "ok", schedule: await getHost().reschedule(everyHours) });
		} catch (err) {
			return fail(res, err);
		}
	});

	for (const op of ["pause", "resume"]) {
		api.app.post(`${base}/${op}`, ...write, async (req, res) => {
			try {
				return res.json({ status: "ok", schedule: await getHost()[op]() });
			} catch (err) {
				return fail(res, err);
			}
		});
	}

	api.app.post(`${base}/run`, ...write, async (req, res) => {
		try {
			const r = await getHost().runNow();
			return res.status(202).json({ status: "ok", ...r });
		} catch (err) {
			return fail(res, err);
		}
	});

	api.app.get(`${base}/annotations`, ...read, async (req, res) => {
		if (!enabled() || !getHost().running) {
			return res.json({ status: "ok", worker: false, annotations: [] });
		}
		try {
			const annotations = await getHost().listAnnotations({
				onlyPossible: req.query.possiveis === "1",
				limit: Number(req.query.limite) || 200
			});
			return res.json({ status: "ok", worker: true, annotations });
		} catch (err) {
			return fail(res, err, 503);
		}
	});

	api.app.post(`${base}/annotations`, ...write, async (req, res) => {
		const b = req.body || {};
		const moeda = b.moeda || "todas";
		if (typeof b.texto !== "string" || !b.texto.trim() || b.texto.length > 300) {
			return res.status(400).json({ status: "error", message: "texto obrigatório (até 300)" });
		}
		if (!MOEDAS.includes(moeda)) {
			return res.status(400).json({ status: "error", message: "moeda inválida" });
		}
		let ts = null;
		if (b.hora !== undefined && b.hora !== null && b.hora !== "") {
			ts = typeof b.hora === "number" ? b.hora : Date.parse(b.hora);
			if (!Number.isFinite(ts)) {
				return res.status(400).json({ status: "error", message: "hora inválida (ISO 8601)" });
			}
		}
		try {
			const r = await getHost().addAnnotation({ text: b.texto, currency: moeda, ts });
			return res.status(201).json({ status: "ok", ...r });
		} catch (err) {
			return fail(res, err, 400);
		}
	});

	api.app.post(`${base}/annotations/decide`, ...write, async (req, res) => {
		const b = req.body || {};
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) {
			return res.status(400).json({ status: "error", message: "id inválido" });
		}
		if (!["confirmada", "descartada"].includes(b.decision)) {
			return res
				.status(400)
				.json({ status: "error", message: "decision precisa ser confirmada ou descartada" });
		}
		if (
			b.texto !== undefined &&
			b.texto !== null &&
			(typeof b.texto !== "string" || b.texto.length > 300)
		) {
			return res
				.status(400)
				.json({ status: "error", message: "texto precisa ser string (até 300)" });
		}
		try {
			const r = await getHost().decideAnnotation(id, b.decision, b.texto || null);
			return res.json({ status: "ok", ...r });
		} catch (err) {
			return fail(res, err, 400);
		}
	});
}

module.exports = { registerEconomyRoutes, csrfGuard, PRESETS };
