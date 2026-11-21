/*
 * Provedores de IA.
 * PROVISÓRIA na aba "Provedores" (tela antiga /service-providers embutida). A aba "Uso de IA"
 * já é nativa: renderUsoIA() é o antigo "Analytics e LLM" e fica exportada para a área nativa
 * reaproveitar (#/provedores/uso, período em ?periodo=1h|24h|7d|30d).
 */

import {
	h,
	api,
	settle,
	subnav,
	legacyEmbed,
	tiles,
	card,
	dataTable,
	note,
	externalLink,
	grafanaLink,
	grafanaMissing,
	errorNotice,
	fmt,
	fmt2,
	plural,
	llmFailing,
	serviceKind,
	SERVICE_NAMES,
	TIMEFRAMES,
	buildHash
} from "../core.js";

/**
 * Seção "Uso de IA": requisições, falhas e tokens de LLM por tipo e por provedor, e o volume
 * de mensagens de hoje. Período pelo parâmetro ?periodo= do endereço.
 * @param {HTMLElement} root
 * @param {{ params: URLSearchParams, head?: HTMLElement }} ctx
 * @param {{ base?: string }} [opts] - rota da aba (padrão "#/provedores/uso")
 */
export async function renderUsoIA(root, ctx, { base = buildHash("provedores", ["uso"]) } = {}) {
	const tf = TIMEFRAMES.find((t) => t.id === ctx.params.get("periodo")) || TIMEFRAMES[1];
	const seg = h(
		"div",
		{ class: "seg", role: "group", "aria-label": "Período" },
		TIMEFRAMES.map((t) =>
			h("a", {
				class: "seg-link",
				href: t.id === "24h" ? base : `${base}?periodo=${t.id}`,
				"aria-current": t.id === tf.id ? "true" : null,
				"data-key": `periodo-${t.id}`,
				text: t.label
			})
		)
	);
	root.append(
		h(
			"div",
			{ class: "toolbar" },
			h("span", { class: "label", text: "Período" }),
			seg,
			h("span", { class: "spacer" }),
			externalLink(grafanaLink("llm"), "Uso por período no Grafana", {
				button: true,
				quiet: true,
				missing: grafanaMissing()
			})
		)
	);

	const d = await settle({
		llm: api(`/api/llm/stats?timeframe=${tf.ms}`),
		analytics: api("/analytics?period=today")
	});
	if (d.llmError) {
		root.append(errorNotice(d.llmError, "as métricas de IA"));
		return;
	}
	const s = d.llm || {};
	const daily =
		d.analytics && d.analytics.daily && d.analytics.daily.series && d.analytics.daily.series[0];
	const msgsHoje =
		daily && Array.isArray(daily.data)
			? daily.data.reduce((a, b) => a + (Number(b) || 0), 0)
			: null;
	const failRate = s.total_requests ? (s.total_failures / s.total_requests) * 100 : 0;
	const cols = (first) => [
		{ label: first, value: ([k]) => k, primary: true },
		{ label: "Req.", num: true, value: ([, v]) => fmt(v.requests) },
		{ label: "Falhas", num: true, value: ([, v]) => fmt(v.failures) },
		{ label: "Entrada", num: true, value: ([, v]) => fmt(v.input_tokens) },
		{ label: "Saída", num: true, value: ([, v]) => fmt(v.output_tokens) }
	];

	root.append(
		tiles([
			{ label: `Requisições · ${tf.label}`, value: fmt(s.total_requests) },
			{
				label: "Falhas",
				value: fmt(s.total_failures),
				detail: s.total_requests ? `${fmt2(failRate)} % das requisições` : null,
				attention: llmFailing(s)
			},
			{ label: "Tokens de entrada", value: fmt(s.total_input_tokens) },
			{ label: "Tokens de saída", value: fmt(s.total_output_tokens) },
			{ label: "Externas", value: fmt(s.external_requests) },
			{
				label: "Mensagens hoje",
				value: msgsHoje === null ? "—" : fmt(Math.round(msgsHoje)),
				detail: "soma das médias por hora",
				error: d.analyticsError
			}
		]),
		card({
			title: "Por tipo",
			body: dataTable(
				[...cols("Tipo"), { label: "Externas", num: true, value: ([, v]) => fmt(v.external) }],
				Object.entries(s.by_type || {}),
				{ caption: "Uso de IA por tipo" }
			)
		}),
		card({
			title: "Por provedor",
			body: dataTable(cols("Provedor"), Object.entries(s.by_provider || {}), {
				caption: "Uso de IA por provedor"
			})
		}),
		note(
			"Relatório completo (JSON): ",
			h("a", { href: "/llm-stats", target: "_blank", rel: "noopener", text: "/llm-stats ↗" }),
			"."
		)
	);
}

const TABS = [
	{ id: "gestao", label: "Provedores", href: "#/provedores" },
	{ id: "uso", label: "Uso de IA", href: buildHash("provedores", ["uso"]) }
];

const tabOf = (ctx) => (ctx.segs[0] === "uso" ? "uso" : "gestao");

export default {
	id: "provedores",
	group: "Operação",
	title: "Provedores de IA",
	desc: "Cadastro e prioridade dos provedores, fila do LLM e uso de IA.",
	legacy: true,
	layout: (ctx) => (tabOf(ctx) === "uso" ? "page" : "embed"),
	summary(p) {
		const services = Object.entries(p.services || {});
		const down = services.filter(([, v]) => serviceKind(v) === "down");
		const failing = llmFailing(p.llm);
		if (down.length) {
			return {
				text: `${down.map(([k]) => SERVICE_NAMES[k] || k).join(", ")} fora do ar`,
				attention: true,
				count: down.length + (failing ? 1 : 0)
			};
		}
		if (failing)
			return { text: "IA com muitas falhas nas últimas 24 h", attention: true, count: 1 };
		if (!services.length) return null;
		const ok = services.filter(([, v]) => serviceKind(v) === "ok").length;
		const unknown = services.length - ok;
		return {
			text: `${fmt(ok)} de ${plural(services.length, "serviço", "serviços")} no ar${unknown ? ` · ${fmt(unknown)} sem dado` : ""}`
		};
	},
	async render(root, ctx) {
		const tab = tabOf(ctx);
		ctx.head.append(subnav(TABS, tab, { label: "Seções de Provedores de IA" }));
		if (tab === "uso") return renderUsoIA(root, ctx);
		root.append(legacyEmbed("/service-providers", "Provedores de IA: gestão"));
	}
};
