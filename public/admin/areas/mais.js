/*
 * Mais (#/mais): no celular, as áreas fora da barra inferior, os outros painéis (abrem em
 * outra aba), o tema e o Sair. Também funciona no computador.
 */

import {
	h,
	rows,
	rowItem,
	secLabel,
	card,
	themeSwitch,
	getLinks,
	panelLinks,
	configHint,
	icon
} from "../core.js";
import { loadPulse } from "../pulse.js";

/** Letra colorida no lugar do ícone para os painéis de fora (G Grafana, W Waifuletes, J Jardim). */
const PANEL_LETTER = { grafana: "G", waifuletes: "W", jardim: "J" };
const panelIcon = (kind) =>
	h("span", {
		class: "lt",
		"data-kind": kind,
		"aria-hidden": "true",
		text: PANEL_LETTER[kind] || "↗"
	});

export default {
	id: "mais",
	group: null,
	nav: false,
	title: "Mais áreas",
	desc: "As outras áreas do admin, os painéis de fora, o tema e a sessão.",
	async render(root, ctx) {
		const [p] = await Promise.all([loadPulse().catch(() => ({})), getLinks()]);
		const areas = ctx.areas.filter(
			(a) => a.nav !== false && a.id !== "mais" && !ctx.primary.includes(a.id)
		);
		const areaRows = areas.map((a) => {
			let s = null;
			try {
				s = typeof a.summary === "function" ? a.summary(p) : null;
			} catch {
				s = null;
			}
			return rowItem({
				icon: a.icon || a.id,
				title: a.title,
				status: (s && s.text) || a.desc,
				attention: !!(s && s.attention),
				count: (s && s.count) || 0,
				href: `#/${a.id}`,
				key: `mais-${a.id}`
			});
		});
		const panels = panelLinks().map((pl) =>
			rowItem({
				icon: panelIcon(pl.kind),
				title: pl.title,
				status: pl.sub,
				external: pl.url,
				disabled: !pl.url,
				hint: pl.missing ? configHint(pl.missing) : null,
				key: `mais-${pl.id}`
			})
		);
		root.append(
			secLabel("Áreas do admin"),
			rows(areaRows, { label: "Áreas do admin" }),
			secLabel("Outros painéis · abrem em outra aba"),
			panels.length
				? rows(panels, { label: "Outros painéis" })
				: card({
						body: h("p", {
							class: "muted",
							text: "Não foi possível ler os endereços dos outros painéis."
						})
					}),
			secLabel("Aparência e sessão"),
			h(
				"div",
				{ class: "card rows" },
				h(
					"div",
					{ class: "rw rw-static" },
					h("span", { class: "ic" }, icon("tema")),
					h(
						"span",
						{ class: "tx" },
						h("b", { id: "mais-tema", text: "Tema" }),
						h("span", { class: "rw-sub", text: "Auto segue o sistema" })
					),
					themeSwitch()
				),
				rowItem({
					icon: "sair",
					title: "Sair",
					status: "Encerra a sessão de admin neste navegador",
					href: "/logout",
					key: "mais-sair"
				})
			)
		);
	}
};
