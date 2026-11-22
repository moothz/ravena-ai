/*
 * Visão geral: o que precisa de você agora (linhas tocáveis que levam à área certa) e os
 * números do agora. Histórico e tendência ficam no Grafana.
 */

import {
	h,
	api,
	settle,
	card,
	pill,
	tiles,
	note,
	lamp,
	icon,
	srOnly,
	fmt,
	fmt2,
	plural,
	externalLink,
	grafanaLink,
	grafanaMissing,
	LINKS_UNAVAILABLE,
	errorNotice,
	preserveFocus,
	serviceKind,
	serviceEntries,
	isEventActive,
	isEventUpcoming,
	llmFailing,
	econHealth,
	poll
} from "../core.js";
import { loadPulse } from "../pulse.js";

/** Uma linha de "Precisa de você": a linha toda leva à área; o atalho externo fica ao lado. */
function needRow(n) {
	const main = h(
		"a",
		{ class: "need-main", href: n.href, "data-state": n.state },
		h("span", { class: "lamp", "data-state": n.state, "aria-hidden": "true" }),
		srOnly(n.state === "down" ? "Falha: " : n.state === "attention" ? "Atenção: " : "Sem dado: "),
		h(
			"span",
			{ class: "what" },
			h("b", { text: n.title }),
			n.detail ? h("span", { text: n.detail }) : null
		),
		h(
			"span",
			{ class: "go" },
			h("span", { class: "go-where", text: n.where }),
			h("span", { "aria-hidden": "true", text: " →" })
		)
	);
	const ext =
		n.external && n.external.href
			? h(
					"a",
					{ class: "need-ext", href: n.external.href, target: "_blank", rel: "noopener" },
					n.external.label,
					h("span", { "aria-hidden": "true", text: " ↗" }),
					srOnly(" (abre em outra aba)")
				)
			: null;
	return h("li", { class: "need", "data-state": n.state }, main, ext);
}

function needsCard(p) {
	const errors = [p.botsError, p.servicesError].filter(Boolean);
	const list = p.needs;
	let body;
	if (list.length) {
		body = h("ul", { class: "needs", "data-needs": String(p.actionable) }, list.map(needRow));
	} else if (errors.length) {
		body = errorNotice(errors[0], "parte do estado");
	} else {
		body = h(
			"div",
			{ class: "needs-empty", "data-needs": "0" },
			lamp("ok"),
			"Nada pede sua atenção agora."
		);
	}
	return card({
		title: "Precisa de você",
		pill: p.actionable ? pill(p.actionable, "att") : pill("0", "ok"),
		body: [list.length && errors.length ? errorNotice(errors[0], "parte do estado") : null, body],
		padded: false,
		class: "needs-card"
	});
}

function stateTiles(p, extra) {
	const bots = Array.isArray(p.bots) ? p.bots.filter((b) => b.enabled !== false) : [];
	const on = bots.filter((b) => b.connected).length;
	const services = serviceEntries(p.services).map(([, v]) => v);
	const svcDown = services.filter((v) => serviceKind(v) === "down").length;
	const svcBackup = services.filter((v) => serviceKind(v) === "backup").length;
	const svcUnknown = services.filter((v) => serviceKind(v) === "unknown").length;
	const llm = p.llm || {};
	const events = p.events || [];
	const active = events.filter((e) => isEventActive(e)).length;
	const upcoming = events.filter((e) => isEventUpcoming(e)).length;
	const bank = extra.bank && extra.bank.data;
	const econ = econHealth(p.econ);

	return tiles([
		{
			label: "Instâncias",
			value: `${fmt(on)} de ${fmt(bots.length)}`,
			detail: bots.length - on ? `${fmt(bots.length - on)} fora do ar` : "todas conectadas",
			attention: bots.length - on > 0,
			href: "#/instancias",
			error: p.botsError
		},
		{
			label: "Serviços",
			value: `${fmt(services.length - svcDown - svcUnknown)} de ${fmt(services.length)}`,
			detail: svcDown
				? `${fmt(svcDown)} fora do ar`
				: svcBackup
					? `${fmt(svcBackup)} na reserva`
					: svcUnknown
						? `no ar · ${fmt(svcUnknown)} sem dado`
						: "todos no ar",
			attention: svcDown + svcBackup > 0,
			href: "#/provedores",
			error: p.servicesError
		},
		{
			label: "Mensagens hoje",
			value: extra.msgsHoje === null ? "—" : fmt(Math.round(extra.msgsHoje)),
			detail: "soma das médias por hora",
			error: extra.analyticsError
		},
		{
			label: "IA · 24 h",
			value: fmt(llm.total_requests),
			detail: plural(llm.total_failures || 0, "falha", "falhas"),
			attention: llmFailing(llm),
			href: "#/provedores/uso",
			error: p.llmError
		},
		{
			label: "Runas em circulação",
			value: bank ? fmt2(bank.totalRunas) : "—",
			detail: bank ? plural(bank.totalAccounts, "conta", "contas") : null,
			href: "#/banco",
			error: extra.bankError
		},
		{
			label: "Eventos",
			value: fmt(active),
			detail: `em andamento · ${plural(upcoming, "programado", "programados")}`,
			href: "#/eventos",
			error: p.eventsError
		},
		{
			label: "Carga da economia",
			value: econ.word,
			detail: econ.available
				? econ.paused
					? "agendamento pausado"
					: `a cada ${econ.everyHours || 1} h`
				: econ.detail || null,
			attention: econ.state === "down" || econ.state === "attention",
			href: "#/carga",
			error: p.econError && p.econError.status !== 404 ? p.econError : null
		}
	]);
}

function grafanaNote() {
	const links = [
		["Economia", grafanaLink("economia")],
		["Operação (RED)", grafanaLink("red")],
		["Uso de LLM", grafanaLink("llm")]
	];
	const missing = grafanaMissing();
	if (missing) {
		return note(
			missing === LINKS_UNAVAILABLE
				? "Os números daqui são o agora. Histórico e tendência ficam no Grafana (não deu para carregar os endereços dos atalhos agora; tenta de novo na próxima navegação)."
				: `Os números daqui são o agora. Histórico e tendência ficam no Grafana (defina ${missing} no .env para ligar os atalhos).`
		);
	}
	const parts = [];
	links.forEach(([label, href], i) => {
		if (i) parts.push(" · ");
		parts.push(externalLink(href, label));
	});
	return note(
		"Os números daqui são o agora. Histórico e tendência ficam no Grafana: ",
		...parts,
		"."
	);
}

async function draw(root, { fresh = false } = {}) {
	const [p, extra] = await Promise.all([
		loadPulse({ fresh }),
		settle({
			bank: api("/api/games/bank/admin/config", { fresh }),
			analytics: api("/analytics?period=today", { fresh })
		})
	]);
	const daily =
		extra.analytics &&
		extra.analytics.daily &&
		extra.analytics.daily.series &&
		extra.analytics.daily.series[0];
	extra.msgsHoje =
		daily && Array.isArray(daily.data)
			? daily.data.reduce((a, b) => a + (Number(b) || 0), 0)
			: null;
	await preserveFocus(root, () =>
		root.replaceChildren(needsCard(p), stateTiles(p, extra), grafanaNote())
	);
}

export default {
	id: "geral",
	group: "Operação",
	title: "Visão geral",
	short: "Geral",
	desc: "O que precisa de você agora e o estado da Ravena num olhar.",
	async render(root, ctx) {
		ctx.head.append(
			h(
				"button",
				{
					type: "button",
					class: "btn btn-quiet",
					"data-key": "atualizar",
					onclick: async (ev) => {
						const btn = ev.currentTarget;
						btn.disabled = true;
						try {
							await draw(body, { fresh: true });
						} finally {
							btn.disabled = false;
						}
					}
				},
				icon("recarregar"),
				h("span", { class: "btn-label", text: "Atualizar" })
			),
			externalLink(grafanaLink("economia"), "Economia no Grafana", {
				button: true,
				quiet: true,
				missing: grafanaMissing()
			})
		);
		const body = h("div", { class: "stack" });
		root.append(body);
		await draw(body);
		// Atualiza sozinho a cada minuto, só com a aba visível.
		return poll(() => draw(body, { fresh: true }), 60000);
	}
};
