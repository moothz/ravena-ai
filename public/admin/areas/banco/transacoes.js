/*
 * Banco › Transações: histórico paginado com busca por número/ID e filtros de operação, jogo e
 * status; desfazer (estorno administrativo, sem o limite de 5 minutos) com confirmação na linha
 * e valor final editável.
 * Endereço: #/banco/transacoes?q=&tipo=&jogo=&status=&p=
 */

import {
	h,
	api,
	send,
	card,
	dataTable,
	searchBox,
	field,
	confirmInline,
	pill,
	icon,
	note,
	toast,
	plural,
	dateFmt,
	errorNotice,
	buildHash
} from "../../core.js";
import {
	PAGE_SIZE,
	TX_TYPES,
	TX_GAMES,
	TX_STATUS,
	opLabel,
	gameInfo,
	money,
	runasSigned,
	canUndo,
	undoDefault,
	parseNumber,
	pageOf,
	txQuery
} from "./lib.js";
import { pager } from "./parts.js";
import { playerCell, playerHref } from "./jogadores.js";

const KEYS = ["q", "tipo", "jogo", "status"];

/** Endereço da aba com os filtros atuais trocados por `patch` (página volta a 1 se não vier). */
function hrefWith(params, patch) {
	const next = {};
	for (const k of KEYS) {
		const v = k in patch ? patch[k] : params.get(k);
		if (v && v !== "ALL") next[k] = v;
	}
	const p = patch.p || 1;
	if (p > 1) next.p = String(p);
	return buildHash("banco", ["transacoes"], Object.keys(next).length ? next : null);
}

/**
 * Desfazer na própria linha: o botão vira "Desfazer #id? [valor final] Não · Desfazer".
 * O valor vem pré-calculado (5%) e pode ser trocado, como no modal da tela antiga.
 */
function undoControl(tx, ctx) {
	const trigger = h("button", {
		type: "button",
		class: "btn btn-quiet",
		"data-key": `desfazer-${tx.id}`,
		text: "Desfazer…"
	});
	return confirmInline(trigger, {
		question: `Desfazer #${tx.id}? Sem o limite de 5 minutos.`,
		label: `Desfazer a transação #${tx.id}`,
		confirmLabel: "Desfazer",
		class: "bk-undo",
		content: () => {
			const def = undoDefault(tx);
			const verb = def.debit ? "a debitar do jogador" : "a devolver ao jogador";
			return field({
				label: `Valor final em Runas (${verb})`,
				name: "finalRunas",
				value: money(def.final),
				attrs: { inputmode: "decimal", autocomplete: "off" },
				hint: def.debit
					? `Venda: ${money(tx.runas_amount)} recebidas + 5% (${money(def.fee)}). Os ativos voltam ao jogo.`
					: `Compra: ${money(tx.runas_amount)} pagas − 5% (${money(def.fee)}). Os ativos voltam ao banco.`
			});
		},
		onConfirm: async (box) => {
			const input = box.querySelector("input");
			const finalRunas = parseNumber(input.value);
			if (!Number.isFinite(finalRunas) || finalRunas < 0) {
				toast("Informe um valor final válido de Runas (maior ou igual a zero).", { kind: "error" });
				input.focus();
				return false;
			}
			try {
				const r = await send("POST", "/api/games/bank/admin/undo-transaction", {
					transactionId: tx.id,
					finalRunas
				});
				if (!r || !r.ok) throw new Error((r && r.error) || "falha ao desfazer a transação");
			} catch (err) {
				throw new Error(`Erro ao desfazer: ${err.message}`);
			}
			toast(`Transação #${tx.id} desfeita; saldo e ativos atualizados`, { kind: "ok" });
			ctx.refresh();
		}
	});
}

function statusCell(t) {
	if (t.status !== "UNDONE") return pill("ativa", "ok");
	const by = t.undone_by || "admin";
	const when = t.undone_at ? ` em ${dateFmt(t.undone_at)}` : "";
	const el = pill("desfeita", "bad");
	el.title = `Desfeita por ${by}${when}`;
	return h(
		"span",
		{ class: "bk-status" },
		el,
		h("span", { class: "bk-sub", text: `${by}${when}` })
	);
}

function actionCell(t, ctx) {
	if (canUndo(t)) return undoControl(t, ctx);
	if (t.status === "UNDONE") return h("span", { class: "faint", text: "revertida" });
	return h("span", { class: "faint", "aria-label": "sem ação", text: "—" });
}

function select(label, key, options, params, ctx) {
	const f = field({
		label,
		name: key,
		type: "select",
		value: params.get(key) || "ALL",
		options,
		attrs: { "data-key": `filtro-${key}` }
	});
	f.querySelector("select").addEventListener("change", (ev) => {
		ctx.navigate(hrefWith(params, { [key]: ev.target.value }), { replace: true });
	});
	return f;
}

export async function renderTransacoes(root, ctx) {
	const params = ctx.params;
	const q = (params.get("q") || "").trim();
	const page = pageOf(params);

	const filters = h(
		"div",
		{ class: "bk-filters" },
		h(
			"div",
			{ class: "fld bk-search" },
			searchBox({
				label: "Buscar por número ou ID",
				visibleLabel: true,
				placeholder: "Número ou ID do jogador",
				value: q,
				delay: 400,
				onSearch: (next) => {
					if (next !== q) ctx.navigate(hrefWith(params, { q: next }), { replace: true });
				}
			})
		),
		select("Operação", "tipo", TX_TYPES, params, ctx),
		select("Jogo", "jogo", TX_GAMES, params, ctx),
		select("Status", "status", TX_STATUS, params, ctx)
	);
	const bar = h("div", { class: "toolbar bk-toolbar" });
	const filtered = KEYS.some((k) => params.get(k) && params.get(k) !== "ALL");
	if (filtered)
		bar.append(
			h("a", {
				class: "btn btn-quiet",
				href: buildHash("banco", ["transacoes"]),
				"data-key": "limpar-filtros",
				text: "Limpar filtros"
			})
		);
	root.append(filters, bar);

	let d;
	try {
		const res = await api(`/api/games/bank/admin/transactions?${txQuery(params)}`);
		if (!res || !res.ok || !res.data) throw new Error((res && res.error) || "resposta sem dados");
		d = res.data;
	} catch (err) {
		root.append(errorNotice(err, "as transações"));
		return;
	}

	bar.append(
		h("span", { class: "spacer" }),
		pill(plural(d.total || 0, "transação", "transações")),
		h(
			"button",
			{ type: "button", class: "btn", "data-key": "atualizar", onclick: () => ctx.refresh() },
			icon("recarregar"),
			h("span", { class: "btn-label", text: "Atualizar" })
		)
	);

	root.append(
		card({
			label: "Transações",
			class: "bk-tx",
			body: dataTable(
				[
					{ label: "#", class: "mono bk-id", value: (t) => `#${t.id}` },
					{ label: "Quando", value: (t) => dateFmt(t.timestamp) },
					{
						label: "Jogador",
						primary: true,
						value: (t) => playerCell(t.userName, t.user_id, playerHref(t.user_id))
					},
					{ label: "Operação", value: (t) => opLabel(t.type) },
					{ label: "Jogo", value: (t) => gameInfo(t.game, t.game_amount).label },
					{ label: "Qtd.", num: true, value: (t) => gameInfo(t.game, t.game_amount).amount },
					{ label: "Runas", num: true, value: (t) => runasSigned(t) },
					{
						label: "Spread",
						num: true,
						value: (t) =>
							`${money(t.spread_fee_runas ?? 0)} (${(Number(t.spread_rate || 0) * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)`
					},
					{ label: "Status", value: (t) => statusCell(t) },
					{ label: "Ação", class: "bk-act", value: (t) => actionCell(t, ctx) }
				],
				d.transactions || [],
				{
					caption: "Transações do RavenaBank",
					empty: "Nenhuma transação com esses filtros.",
					rowClass: (t) => (t.status === "UNDONE" ? "undone" : null)
				}
			)
		}),
		pager({
			page,
			totalPages: d.totalPages,
			total: d.total,
			size: PAGE_SIZE,
			one: "transação",
			many: "transações",
			label: "Páginas de transações",
			hrefFor: (p) => hrefWith(params, { p })
		}),
		note(
			"Desfazer devolve os ativos e acerta as Runas do jogador; a transação fica marcada como desfeita e um estorno entra no extrato. Nada é apagado."
		)
	);
}
