/*
 * Peças de tela que só a área Banco usa: paginação por link, bloco de saldo com emblema e o
 * botão de copiar o ID.
 */

import { h, coinEmblem, copyText, fmt, srOnly } from "../../core.js";
import { pageWindow } from "./lib.js";

/**
 * Paginação por links (o endereço guarda a página: voltar funciona).
 * @param {{ page: number, totalPages: number, total: number, size: number, one: string, many: string,
 *   hrefFor: (p: number) => string, edges?: boolean, label?: string }} o
 *   edges: mostra também "primeira" e "última" (a lista de jogadores da tela antiga tinha)
 */
export function pager(o) {
	const total = Number(o.total) || 0;
	const pages = Math.max(1, Number(o.totalPages) || 1);
	const page = Math.min(pages, Math.max(1, o.page));
	const from = total ? (page - 1) * o.size + 1 : 0;
	const to = Math.min(page * o.size, total);
	const info = h("span", {
		class: "bk-pager-info",
		text: total
			? `Mostrando ${fmt(from)} a ${fmt(to)} de ${fmt(total)} ${total === 1 ? o.one : o.many}`
			: `0 ${o.many}`
	});
	if (pages <= 1) return h("div", { class: "bk-pager" }, info);
	const link = (p, content, label, { current = false } = {}) => {
		const off = p < 1 || p > pages || (current && p === page);
		if (off && !current)
			return h(
				"span",
				{ class: "btn btn-quiet is-disabled", "aria-disabled": "true", title: label },
				content,
				srOnly(label)
			);
		return h(
			"a",
			{
				class: `btn${current ? "" : " btn-quiet"}`,
				href: o.hrefFor(p),
				"aria-current": current ? "page" : null,
				"aria-label": label,
				title: label,
				"data-key": `pag-${label}`
			},
			content
		);
	};
	const nums = pageWindow(page, pages).map((p) =>
		link(p, String(p), `Página ${p}`, { current: p === page })
	);
	return h(
		"nav",
		{ class: "bk-pager", "aria-label": o.label || "Páginas" },
		info,
		h(
			"span",
			{ class: "bk-pager-btns" },
			o.edges ? link(1, "«", "Primeira página") : null,
			link(page - 1, "‹", "Página anterior"),
			nums,
			link(page + 1, "›", "Próxima página"),
			o.edges ? link(pages, "»", "Última página") : null
		)
	);
}

/**
 * Bloco de saldo com o emblema da moeda (o tiles() do kit só aceita rótulo em texto).
 * @param {{ coin: string, value?: string, unit?: string, detail?: string, missing?: string }} o
 *   missing: motivo por escrito quando o saldo não está disponível aqui
 */
export function coinTile(o) {
	return h(
		"div",
		{ class: "tile", "data-tile": o.coin },
		h("span", { class: "label bk-coin-label" }, coinEmblem(o.coin, 15), o.coin),
		o.missing
			? h("span", { class: "v bk-missing", text: o.missing })
			: h("span", { class: "v" }, o.value, o.unit ? h("small", { text: ` ${o.unit}` }) : null),
		o.detail ? h("span", { class: "d", text: o.detail }) : null
	);
}

/** Botão de copiar um texto (ex. o ID do jogador), com aviso. */
export function copyButton(text, label = "Copiar ID") {
	return h("button", {
		type: "button",
		class: "btn btn-quiet",
		"data-key": "copiar-id",
		text: label,
		onclick: () => copyText(text, { ok: `ID ${text} copiado` })
	});
}
