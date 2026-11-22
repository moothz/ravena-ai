/*
 * "Pulso" do painel: as leituras rápidas que alimentam o topo ("N precisam de você"), os
 * contadores do menu, a página Mais e a Visão geral. Uma leitura só, compartilhada pelo cache
 * de 45 s do api(). Rotas que não existem neste servidor (404) ou desligadas viram "sem dado",
 * sem quebrar a tela.
 */

import { api, settle, grafanaLink, deriveNeeds, countActionable, TIMEFRAMES } from "./core.js";

/**
 * @typedef {Object} Pulse
 * @property {Array|null} bots          GET /api/bots
 * @property {Object|null} services     GET /api/services/status
 * @property {Object|null} llm          GET /api/llm/stats (24 h)
 * @property {Array|null} events        GET /api/events/admin → events
 * @property {Object|null} econ         GET /api/economy/admin/status
 * @property {Array|null} possible      GET /api/economy/admin/annotations?possiveis=1 → annotations
 * @property {Array} needs              itens de "Precisa de você" (lib.deriveNeeds)
 * @property {number} actionable        quantos pedem ação (down/attention)
 * @property {number} at                quando foi lido
 * (e <nome>Error para cada leitura que falhou)
 */

/**
 * Lê o pulso. fresh: ignora o cache (botão Atualizar, polling do topo).
 * @param {{ fresh?: boolean }} [opts]
 * @returns {Promise<Pulse>}
 */
export async function loadPulse({ fresh = false } = {}) {
	const o = { fresh };
	const d = await settle({
		bots: api("/api/bots", o),
		services: api("/api/services/status", o),
		llm: api(`/api/llm/stats?timeframe=${TIMEFRAMES[1].ms}`, o),
		events: api("/api/events/admin", o).then((r) => (r && Array.isArray(r.events) ? r.events : [])),
		econ: api("/api/economy/admin/status", o),
		possible: api("/api/economy/admin/annotations?possiveis=1", o).then((r) =>
			r && Array.isArray(r.annotations) ? r.annotations : []
		)
	});
	const needs = deriveNeeds({
		bots: d.bots,
		services: d.services,
		llm: d.llm,
		econ: d.econ,
		possible: d.possible,
		grafana: (name, params) => grafanaLink(name, params)
	});
	return { ...d, needs, actionable: countActionable(needs), at: Date.now() };
}
