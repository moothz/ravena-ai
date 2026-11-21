/*
 * Banco › Jogadores: lista paginada das contas do RavenaBank (maior saldo primeiro) com busca
 * por apelido ou número. A linha leva à ficha do jogador (#/banco/jogador/<id>).
 * Endereço: #/banco?q=<busca>&p=<página>
 */

import {
	h,
	api,
	card,
	dataTable,
	searchBox,
	pill,
	icon,
	relTime,
	dateFmt,
	plural,
	errorNotice,
	buildHash
} from "../../core.js";
import { PAGE_SIZE, formatPhone, money, pageOf } from "./lib.js";
import { pager } from "./parts.js";

const hrefFor = (q, p) => {
	const params = {};
	if (q) params.q = q;
	if (p > 1) params.p = String(p);
	return buildHash("banco", [], Object.keys(params).length ? params : null);
};

export const playerHref = (userId) => buildHash("banco", ["jogador", String(userId)]);

/** Nome + número numa célula (o nome é o link da linha). */
export function playerCell(name, userId, href) {
	return h(
		"span",
		{ class: "bk-who" },
		href
			? h("a", { href, text: name || formatPhone(userId) })
			: h("b", { text: name || formatPhone(userId) }),
		name
			? h("span", { class: "bk-sub mono", text: formatPhone(userId), title: `ID: ${userId}` })
			: h("span", { class: "bk-sub", text: "sem apelido" })
	);
}

export async function renderJogadores(root, ctx) {
	const q = (ctx.params.get("q") || "").trim();
	const page = pageOf(ctx.params);
	const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), q });

	const toolbar = h(
		"div",
		{ class: "toolbar bk-toolbar" },
		searchBox({
			label: "Buscar jogador",
			placeholder: "Apelido ou número",
			value: q,
			delay: 320,
			onSearch: (next) => {
				if (next !== q) ctx.navigate(hrefFor(next, 1), { replace: true });
			}
		}),
		q
			? h("a", {
					class: "btn btn-quiet",
					href: hrefFor("", 1),
					"data-key": "limpar-busca",
					text: "Limpar busca"
				})
			: null
	);
	root.append(toolbar);

	let d;
	try {
		const res = await api(`/api/games/bank/admin/users?${qs}`);
		if (!res || !res.ok || !res.data) throw new Error((res && res.error) || "resposta sem dados");
		d = res.data;
	} catch (err) {
		root.append(errorNotice(err, "os jogadores"));
		return;
	}
	const users = d.users || [];

	toolbar.append(
		h("span", { class: "spacer" }),
		pill(plural(d.total || 0, "jogador", "jogadores")),
		h(
			"button",
			{ type: "button", class: "btn", "data-key": "atualizar", onclick: () => ctx.refresh() },
			icon("recarregar"),
			h("span", { class: "btn-label", text: "Atualizar" })
		)
	);

	root.append(
		card({
			body: dataTable(
				[
					{
						label: "Jogador",
						primary: true,
						value: (u) =>
							playerCell(u.name === "Sem apelido" ? null : u.name, u.userId, playerHref(u.userId))
					},
					{
						label: "Runas",
						num: true,
						value: (u) => money(u.runas)
					},
					{
						label: "Movimentou",
						value: (u) =>
							u.updatedAt
								? h("span", { title: dateFmt(u.updatedAt), text: relTime(u.updatedAt) })
								: h("span", { class: "faint", text: "sem movimentação" })
					}
				],
				users,
				{
					caption: "Jogadores do RavenaBank",
					empty: q ? `Ninguém com “${q}”.` : "Nenhuma conta no banco ainda.",
					rowHref: (u) => playerHref(u.userId)
				}
			),
			label: "Jogadores"
		}),
		pager({
			page,
			totalPages: d.totalPages,
			total: d.total,
			size: PAGE_SIZE,
			one: "jogador",
			many: "jogadores",
			edges: true,
			label: "Páginas de jogadores",
			hrefFor: (p) => hrefFor(q, p)
		})
	);
}
