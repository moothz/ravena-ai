/*
 * Provedores de IA (nativa; substitui a tela antiga /service-providers).
 * - Aba "Provedores" (#/provedores): estado dos serviços, cadastro por tipo e fila do LLM
 *   (provedores/gestao.js).
 * - Aba "Uso de IA" (#/provedores/uso, período em ?periodo=1h|24h|7d|15d|30d|tudo): o antigo
 *   "Analytics e LLM" mais o desempenho por provedor e tipo, as APIs externas por usuário e o
 *   simulador de custos da tela antiga. renderUsoIA() fica exportada para reaproveitar.
 */

import {
	h,
	api,
	settle,
	subnav,
	tiles,
	card,
	dataTable,
	note,
	field,
	externalLink,
	grafanaLink,
	grafanaMissing,
	errorNotice,
	poll,
	preserveFocus,
	dateFmt,
	fmt,
	fmt2,
	plural,
	llmFailing,
	SERVICE_NAMES,
	buildHash,
	loadAreaCss
} from "../core.js";
import { renderGestao } from "./provedores/gestao.js";
import {
	USO_PERIODS,
	failPercent,
	providerTypeRows,
	costModels,
	rowCost,
	statusOf
} from "./provedores/logic.js";

const COST_TYPES = [
	{ id: "text", label: "Modelo de texto" },
	{ id: "image", label: "Modelo de imagem" },
	{ id: "stt", label: "Transcrição de áudio (STT)" },
	{ id: "tts", label: "Geração de áudio (TTS)" }
];
const TYPE_LABEL = { text: "texto", image: "imagem", video: "vídeo", stt: "STT", tts: "TTS" };
/** Modelo escolhido no simulador, por tipo (índice na lista ordenada; vale durante a visita). */
const costPick = { text: 0, image: 0, stt: 0, tts: 0 };
const usd = (v, digits) =>
	`US$ ${(Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

/**
 * Seção "Uso de IA": requisições, falhas e tokens de LLM por tipo e por provedor, desempenho por
 * provedor e tipo com custo estimado, APIs externas por usuário, simulador de custos e o volume
 * de mensagens de hoje. Período pelo parâmetro ?periodo= do endereço; relê a cada 30 s.
 * @param {HTMLElement} root
 * @param {{ params: URLSearchParams, head?: HTMLElement }} ctx
 * @param {{ base?: string }} [opts] - rota da aba (padrão "#/provedores/uso")
 * @returns {Promise<() => void>} limpeza
 */
export async function renderUsoIA(root, ctx, { base = buildHash("provedores", ["uso"]) } = {}) {
	const tf = USO_PERIODS.find((t) => t.id === ctx.params.get("periodo")) || USO_PERIODS[1];
	const seg = h(
		"div",
		{ class: "seg", role: "group", "aria-label": "Período" },
		USO_PERIODS.map((t) =>
			h("a", {
				class: "seg-link",
				href: t.id === "24h" ? base : `${base}?periodo=${t.id}`,
				"aria-current": t.id === tf.id ? "true" : null,
				"data-key": `periodo-${t.id}`,
				text: t.label
			})
		)
	);
	root.append(h("div", { class: "toolbar" }, h("span", { class: "label", text: "Período" }), seg));

	const read = (fresh) =>
		settle({
			llm: api(`/api/llm/stats?timeframe=${tf.ms}`, { fresh }),
			analytics: api("/analytics?period=today", { fresh }),
			cost: api("/llm-cost-estimate.json")
		});
	const body = h("div", { class: "stack" });
	root.append(body);
	const paint = (d) => body.replaceChildren(...usoBlocks(d, tf, () => paint(d)));
	paint(await read(false));
	return poll(async () => {
		if (!body.isConnected) return;
		const d = await read(true);
		if (body.isConnected) await preserveFocus(body, () => paint(d));
	}, 30000);
}

function usoBlocks(d, tf, repaint) {
	if (d.llmError) return [errorNotice(d.llmError, "as métricas de IA")];
	const s = d.llm || {};
	const daily =
		d.analytics && d.analytics.daily && d.analytics.daily.series && d.analytics.daily.series[0];
	const msgsHoje =
		daily && Array.isArray(daily.data)
			? daily.data.reduce((a, b) => a + (Number(b) || 0), 0)
			: null;
	const periodLabel =
		tf.ms === 0
			? s.first_record_timestamp
				? `desde ${dateFmt(s.first_record_timestamp).split(",")[0]}`
				: "todo o período"
			: tf.label;
	const cols = (first) => [
		{ label: first, value: ([k]) => k, primary: true },
		{ label: "Req.", num: true, value: ([, v]) => fmt(v.requests) },
		{ label: "Falhas", num: true, value: ([, v]) => fmt(v.failures) },
		{ label: "Entrada", num: true, value: ([, v]) => fmt(v.input_tokens) },
		{ label: "Saída", num: true, value: ([, v]) => fmt(v.output_tokens) }
	];

	// Simulador de custos (fórmulas da tela antiga): um modelo pago por tipo.
	const models = Object.fromEntries(COST_TYPES.map((t) => [t.id, costModels(d.cost, t.id)]));
	const chosen = (type) => models[type] && models[type][costPick[type]];
	const ptRows = providerTypeRows(s).map((r) => ({
		...r,
		cost: rowCost(r.type, r, chosen(r.type))
	}));
	const totalCost = ptRows.reduce((a, r) => a + r.cost, 0);
	const pickers = COST_TYPES.map((t) => {
		const opts = models[t.id].map((m, i) => ({ value: String(i), label: m.name }));
		const f = field({
			label: t.label,
			name: `custo-${t.id}`,
			type: "select",
			value: String(costPick[t.id]),
			options: opts.length ? opts : [{ value: "0", label: "sem tabela de preços" }],
			attrs: { "data-key": `custo-${t.id}`, disabled: opts.length ? null : true }
		});
		f.querySelector("select").addEventListener("change", (ev) => {
			costPick[t.id] = Number(ev.target.value) || 0;
			repaint();
		});
		return f;
	});

	const apiUsers = Object.entries(s.by_api_user || {});
	return [
		tiles([
			{ label: `Requisições · ${periodLabel}`, value: fmt(s.total_requests) },
			{
				label: "Falhas (não atendidas)",
				value: fmt(s.total_failures),
				detail:
					s.total_requests || s.total_failures ? `${fmt2(failPercent(s))} % das tentativas` : null,
				attention: llmFailing(s)
			},
			{ label: "Tokens de entrada", value: fmt(s.total_input_tokens) },
			{ label: "Tokens de saída", value: fmt(s.total_output_tokens) },
			{
				label: "Custo estimado",
				value: d.costError ? null : usd(totalCost, 2),
				detail: "com os modelos do simulador",
				error: d.costError
			},
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
				caption: "Uso de IA por provedor",
				empty: "Nenhuma requisição no período."
			})
		}),
		card({
			title: "Por provedor e tipo, com custo",
			body: dataTable(
				[
					{ label: "Provedor", value: (r) => r.provider, primary: true },
					{ label: "Tipo", value: (r) => TYPE_LABEL[r.type] || r.type },
					{ label: "Atendidas", num: true, value: (r) => fmt(r.requests) },
					{ label: "Falhas", num: true, value: (r) => fmt(r.failures) },
					{ label: "Entrada", num: true, value: (r) => fmt(r.input_tokens) },
					{ label: "Saída", num: true, value: (r) => fmt(r.output_tokens) },
					{ label: "Custo estimado", num: true, value: (r) => usd(r.cost, 4) }
				],
				ptRows,
				{ caption: "Desempenho por provedor e tipo", empty: "Nenhuma requisição no período." }
			)
		}),
		card({
			title: "Simulador de custos (modelos pagos)",
			body: [
				h("div", { class: "prov-pickers" }, pickers),
				note(
					"Quanto custaria o uso do período se cada tipo rodasse no modelo escolhido. Vídeo conta como texto; transcrição sem duração conta 10 s por pedido."
				)
			]
		}),
		card({
			title: "APIs externas por usuário",
			body: dataTable(
				[
					{ label: "Usuário", value: ([u]) => u, primary: true },
					{ label: "Total", num: true, value: ([, v]) => fmt(v.total) },
					{ label: "LLM (chat)", num: true, value: ([, v]) => fmt(v.llm) },
					{ label: "Imagens", num: true, value: ([, v]) => fmt(v.image) },
					{ label: "STT", num: true, value: ([, v]) => fmt(v.stt) },
					{ label: "TTS", num: true, value: ([, v]) => fmt(v.tts) }
				],
				apiUsers,
				{
					caption: "Requisições de APIs externas por usuário",
					empty: "Nenhuma requisição de API externa no período."
				}
			)
		}),
		note(
			"Relatório completo (JSON): ",
			h("a", { href: "/llm-stats", target: "_blank", rel: "noopener", text: "/llm-stats ↗" }),
			"."
		)
	];
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
	desc: "Estado dos serviços, cadastro e prioridade dos provedores, fila do LLM e uso de IA.",
	summary(p) {
		const services = Object.entries(p.services || {});
		const down = services.filter(([, v]) => statusOf(v) === "down");
		const backup = services.filter(([, v]) => statusOf(v) === "backup");
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
		const ok = services.filter(([, v]) => statusOf(v) === "up").length;
		const unknown = services.length - ok - backup.length;
		return {
			text: [
				`${fmt(ok)} de ${plural(services.length, "serviço", "serviços")} no ar`,
				backup.length ? `${fmt(backup.length)} na reserva` : null,
				unknown ? `${fmt(unknown)} sem dado` : null
			]
				.filter(Boolean)
				.join(" · ")
		};
	},
	async render(root, ctx) {
		loadAreaCss("provedores", "/admin/areas/provedores.css?v=1");
		const tab = tabOf(ctx);
		ctx.head.append(
			h(
				"div",
				{ class: "prov-head-actions" },
				subnav(TABS, tab, { label: "Seções de Provedores de IA" }),
				externalLink(grafanaLink("llm"), "Uso por período no Grafana", {
					button: true,
					quiet: true,
					missing: grafanaMissing()
				})
			)
		);
		if (tab === "uso") return renderUsoIA(root, ctx);
		return renderGestao(root, ctx);
	}
};
