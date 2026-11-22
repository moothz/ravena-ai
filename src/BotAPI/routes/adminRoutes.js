/**
 * adminRoutes.js
 *
 * Rotas de apoio do painel de admin unificado (/admin).
 * Arquivo: src/BotAPI/routes/adminRoutes.js
 *
 * Rotas registradas (todas com authenticateBasic):
 * - GET /api/admin/links - endereços dos "Outros painéis" (Grafana, admin do Waifuletes,
 *                          super-admin do Jardim), lidos do .env. Sem valor, o item volta com
 *                          url null e a variável que falta, e o painel mostra o item desabilitado.
 *
 * Variáveis (.env, seção 2.5):
 * - ADMIN_GRAFANA_URL     base do Grafana (ex. https://grafana.exemplo); os painéis são montados
 *                         a partir dos uids fixos de GRAFANA_DASHBOARDS
 * - WAIFULETES_ADMIN_URL  admin do Waifuletes (padrão: WAIFULETES_WEB_URL + "/admin")
 * - JARDIM_SUPERADMIN_URL super-admin do Jardim das Sombras (ex. https://jardim.exemplo/super-admin)
 *
 * @param {Object} api - Instância da BotAPI
 */
"use strict";

/**
 * Painéis do Grafana conhecidos pelo admin, pelo uid do dashboard.
 * - economia e jogador: observability/grafana/dashboards/{economia,jogador}.json (metadata.name);
 * - red: observability/grafana/dashboards/ravena-red.json (uid);
 * - llm: "Uso de LLM", ainda a criar (o uid fica reservado).
 */
const GRAFANA_DASHBOARDS = {
	economia: { uid: "ravena-economia", title: "Economia" },
	jogador: { uid: "ravena-jogador", title: "Ficha do jogador" },
	red: { uid: "ravena-red", title: "Operação (RED)" },
	llm: { uid: "ravena-llm", title: "Uso de LLM" }
};

/**
 * Normaliza um endereço do .env: só http(s), sem barra no fim. Inválido → null.
 * @param {string|undefined} value
 * @returns {string|null}
 */
function cleanUrl(value) {
	const raw = String(value || "").trim();
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password) return null; // nunca repassa credencial embutida
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

/**
 * Monta a resposta de /api/admin/links a partir de um objeto de ambiente.
 * @param {Object<string, string|undefined>} env
 */
function buildAdminLinks(env = process.env) {
	const grafanaBase = cleanUrl(env.ADMIN_GRAFANA_URL);
	const dashboards = {};
	for (const [id, d] of Object.entries(GRAFANA_DASHBOARDS)) {
		dashboards[id] = {
			uid: d.uid,
			title: d.title,
			url: grafanaBase ? `${grafanaBase}/d/${d.uid}` : null
		};
	}

	const waifuWeb = cleanUrl(env.WAIFULETES_WEB_URL);
	const waifuAdmin = cleanUrl(env.WAIFULETES_ADMIN_URL) || (waifuWeb ? `${waifuWeb}/admin` : null);
	const jardim = cleanUrl(env.JARDIM_SUPERADMIN_URL);

	const grafanaItem = (id, sub) => ({
		id,
		title: GRAFANA_DASHBOARDS[id].title,
		sub,
		kind: "grafana",
		url: dashboards[id].url,
		missing: grafanaBase ? null : "ADMIN_GRAFANA_URL"
	});

	return {
		status: "ok",
		grafana: { base: grafanaBase, dashboards, missing: grafanaBase ? null : "ADMIN_GRAFANA_URL" },
		panels: [
			grafanaItem("economia", "Grafana · moedas, inflação e jogadores"),
			grafanaItem("red", "Grafana · taxa, erros e tempo de resposta"),
			grafanaItem("llm", "Grafana · requisições e custo de IA"),
			{
				id: "waifuletes",
				title: "Waifuletes",
				sub: "admin próprio",
				kind: "waifuletes",
				url: waifuAdmin,
				missing: waifuAdmin ? null : "WAIFULETES_ADMIN_URL"
			},
			{
				id: "jardim",
				title: "Jardim",
				sub: "super-admin · plantas e decorações",
				kind: "jardim",
				url: jardim,
				missing: jardim ? null : "JARDIM_SUPERADMIN_URL"
			}
		]
	};
}

function registerAdminRoutes(api) {
	api.app.get("/api/admin/links", api.authenticateBasic, (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.json(buildAdminLinks(process.env));
	});
}

module.exports = { registerAdminRoutes, buildAdminLinks, GRAFANA_DASHBOARDS };
