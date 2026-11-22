/*
 * Banco › ficha do jogador (#/banco/jogador/<id>): saldo de Runas, ajuste de saldo, acesso ao
 * banco como o jogador, histórico no Grafana, dossiê e últimas transações.
 *
 * Não há rota de "um jogador": a conta vem da busca da lista (/admin/users?q=<id>, filtrada
 * pelo ID exato) e as transações da busca de transações (/admin/transactions?q=<id>).
 */

import {
	h,
	api,
	send,
	settle,
	card,
	crumbs,
	kv,
	dataTable,
	field,
	note,
	pill,
	toast,
	externalLink,
	grafanaLink,
	grafanaMissing,
	relTime,
	dateFmt,
	errorNotice,
	buildHash
} from "../../core.js";
import {
	formatPhone,
	money,
	parseAdjust,
	grafanaPerson,
	opLabel,
	gameInfo,
	runasSigned
} from "./lib.js";
import { coinTile, copyButton } from "./parts.js";

const RECENT = 8;

const sameId = (a, b) => {
	const da = String(a ?? "").replace(/\D/g, "");
	const db = String(b ?? "").replace(/\D/g, "");
	return String(a) === String(b) || (da !== "" && da === db);
};

/** Abre o /ravenabank logado como o jogador (sessão nova gerada pela rota de impersonar). */
function impersonateButton(userId, name) {
	const btn = h(
		"button",
		{ type: "button", class: "btn", "data-key": "ver-como" },
		"Ver como o jogador",
		h("span", { class: "ext", "aria-hidden": "true", text: " ↗" })
	);
	btn.addEventListener("click", async () => {
		// A aba abre já no clique (depois do await o navegador bloquearia como pop-up).
		const win = window.open("about:blank", "_blank");
		btn.disabled = true;
		try {
			const r = await send("POST", "/api/games/bank/admin/impersonate", { userId });
			if (!r || !r.ok || !r.redirectUrl)
				throw new Error((r && r.error) || "não foi possível gerar a sessão de acesso");
			if (win) {
				win.opener = null;
				win.location.href = r.redirectUrl;
			} else {
				window.open(r.redirectUrl, "_blank", "noopener");
			}
			toast(`Banco aberto como ${name} em outra aba`, { kind: "ok" });
		} catch (err) {
			if (win) win.close();
			toast(`Falha ao acessar como o jogador: ${err.message}`, { kind: "error" });
		} finally {
			btn.disabled = false;
		}
	});
	return btn;
}

/**
 * Formulário de ajuste: saldo novo ou diferença com sinal; a rota grava o saldo final.
 * Antes de gravar o saldo é relido (sem cache): se mudou desde que a ficha abriu, a prévia
 * passa a usar o saldo novo e o admin confirma de novo (um "+500" nunca vai sobre saldo velho).
 * @param {() => Promise<number|null>} readBalance - saldo atual sem cache (null: conta sumiu)
 */
function adjustForm(userId, name, current, { readBalance, onDone, onCancel }) {
	const valueField = field({
		label: "Saldo novo ou diferença (ᚱ)",
		name: "valor",
		value: money(current),
		required: true,
		hint: "Digite o saldo final (1500) ou some/tire com sinal (+500, −200). Fica no extrato como Ajuste.",
		attrs: { inputmode: "decimal", autocomplete: "off", "data-key": "ajuste-valor" }
	});
	const input = valueField.control || valueField.querySelector("input");
	const preview = h("p", { class: "bk-preview", "aria-live": "polite" });
	let readAt = null; // hora da última releitura do saldo (null: o da abertura da ficha)
	const showPreview = () => {
		const r = parseAdjust(input.value, current);
		preview.className = `bk-preview${r.ok ? "" : " bad"}`;
		const base = readAt
			? ` · saldo relido às ${readAt.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" })}`
			: "";
		preview.textContent = r.ok
			? `${money(current)} ᚱ → ${money(r.target)} ᚱ (${r.diff >= 0 ? "+" : "−"}${money(Math.abs(r.diff))})${base}`
			: r.error;
	};
	input.addEventListener("input", showPreview);
	showPreview();

	const submit = h("button", { type: "submit", class: "btn btn-primary", text: "Ajustar saldo" });
	const cancel = h("button", {
		type: "button",
		class: "btn btn-quiet",
		text: "Cancelar",
		onclick: onCancel
	});
	const form = h(
		"form",
		{ class: "form bk-adjust", novalidate: true, "aria-label": `Ajustar saldo de ${name}` },
		valueField,
		preview,
		h("div", { class: "form-actions" }, submit, cancel)
	);
	form.addEventListener("keydown", (ev) => {
		if (ev.key === "Escape") {
			ev.preventDefault();
			onCancel();
		}
	});
	form.addEventListener("submit", async (ev) => {
		ev.preventDefault();
		const r = parseAdjust(input.value, current);
		if (!r.ok) {
			toast(r.error, { kind: "error" });
			input.focus();
			return;
		}
		if (r.diff === 0) {
			toast("O saldo ficaria igual; nada foi alterado.");
			input.focus();
			return;
		}
		submit.disabled = true;
		cancel.disabled = true;
		submit.textContent = "Salvando…";
		try {
			const fresh = await readBalance();
			if (fresh === null)
				throw new Error("conta não encontrada ao reler o saldo; nada foi alterado");
			readAt = new Date();
			if (Math.round(fresh * 100) !== Math.round(current * 100)) {
				const before = current;
				current = fresh;
				showPreview();
				toast(
					`O saldo mudou de ${money(before)} para ${money(fresh)} ᚱ desde que a ficha abriu. Confira a prévia e confirme de novo.`,
					{ kind: "error" }
				);
				submit.disabled = false;
				cancel.disabled = false;
				submit.textContent = "Ajustar saldo";
				input.focus();
				return;
			}
			const res = await send("POST", "/api/games/bank/admin/user-runas", {
				userId,
				runas: r.target
			});
			if (!res || !res.ok) throw new Error((res && res.error) || "falha ao salvar o saldo");
			toast(
				`Saldo de ${name}: ${money(res.data ? res.data.runas : r.target)} ᚱ (sobre ${money(current)} ᚱ relido agora)`,
				{ kind: "ok" }
			);
			onDone();
		} catch (err) {
			toast(`Erro ao salvar: ${err.message}`, { kind: "error" });
			submit.disabled = false;
			cancel.disabled = false;
			submit.textContent = "Ajustar saldo";
		}
	});
	queueMicrotask(() => {
		input.focus();
		input.select();
	});
	return form;
}

export async function renderJogador(root, ctx, userId) {
	const enc = encodeURIComponent(userId);
	const usersUrl = `/api/games/bank/admin/users?page=1&limit=100&q=${enc}`;
	const findUser = (r) =>
		((r && r.data && r.data.users) || []).find((u) => sameId(u.userId, userId)) || null;
	const d = await settle({
		users: api(usersUrl),
		txs: api(`/api/games/bank/admin/transactions?page=1&limit=50&q=${enc}`)
	});
	if (d.usersError) {
		root.append(
			crumbs([{ label: "Jogadores", href: "#/banco" }, { label: formatPhone(userId) }]),
			errorNotice(d.usersError, "a conta do jogador")
		);
		return;
	}
	// A conta vem de uma busca (LIKE, até 100): se não veio, não dá para saber o saldo real
	// (pode estar além dos 100 resultados). Nada de saldo 0 nem ajuste nesse caso.
	const user = findUser(d.users);
	const name = user && user.name && user.name !== "Sem apelido" ? user.name : formatPhone(userId);
	const runas = user ? Number(user.runas) || 0 : null;
	const readBalance = async () => {
		const u = findUser(await api(usersUrl, { fresh: true }));
		return u ? Number(u.runas) || 0 : null;
	};

	root.append(crumbs([{ label: "Jogadores", href: "#/banco" }, { label: name }]));

	const actions = h("div", { class: "bk-actions" });
	const adjustSlot = h("div");
	const adjustBtn = h("button", {
		type: "button",
		class: "btn btn-primary",
		"data-key": "ajustar",
		text: "Ajustar saldo…"
	});
	const closeAdjust = () => {
		adjustSlot.replaceChildren();
		adjustBtn.hidden = false;
		adjustBtn.focus();
	};
	adjustBtn.addEventListener("click", () => {
		adjustBtn.hidden = true;
		adjustSlot.replaceChildren(
			adjustForm(userId, name, runas, {
				readBalance,
				onDone: () => ctx.refresh(),
				onCancel: closeAdjust
			})
		);
	});
	if (user && ctx.params.get("ajustar") === "1") queueMicrotask(() => adjustBtn.click());

	actions.append(
		user ? adjustBtn : null,
		impersonateButton(userId, name),
		externalLink(
			// var-jogador é o palpite da "pessoa" do analytics (sem a tabela de LIDs e do Telegram);
			// var-busca com o ID faz a tabela "Encontrar jogador" achar a pessoa certa se o palpite errar.
			// var-moeda: o painel do jogador abre em Zinthos; daqui o assunto é Runas.
			grafanaLink("jogador", {
				"var-moeda": "runas",
				"var-jogador": grafanaPerson(userId),
				"var-busca": String(userId)
			}),
			"Histórico no Grafana",
			{
				button: true,
				missing: grafanaMissing()
			}
		),
		h("a", {
			class: "btn btn-quiet",
			href: buildHash("pessoas", ["pessoa", String(userId)]),
			"data-key": "dossie",
			text: "Dossiê"
		}),
		copyButton(String(userId))
	);

	const info = card({
		title: name,
		pill: user ? null : pill("conta não encontrada", "att"),
		actions: h("span", { class: "mono bk-sub", title: `ID: ${userId}`, text: formatPhone(userId) }),
		body: [
			h(
				"div",
				{ class: "tiles bk-coins" },
				user
					? coinTile({ coin: "Runas", value: money(runas), unit: "ᚱ" })
					: coinTile({ coin: "Runas", missing: "conta não encontrada" }),
				coinTile({ coin: "Zinthos", missing: "fica no Waifuletes" }),
				coinTile({ coin: "Petalitas", missing: "fica no Jardim" })
			),
			kv([
				[
					"Movimentou",
					user && user.updatedAt
						? h("span", { title: dateFmt(user.updatedAt), text: relTime(user.updatedAt) })
						: "sem movimentação"
				],
				["Depositado (total)", user ? `${money(user.totalDeposited)} ᚱ` : "—"],
				["Retirado (total)", user ? `${money(user.totalWithdrawn)} ᚱ` : "—"],
				["ID", h("span", { class: "mono", text: String(userId) })]
			]),
			adjustSlot,
			actions,
			note(
				user
					? "Só Runas se ajusta aqui. Zinthos e Petalitas ficam nos serviços de cada jogo: veja em “Ver como o jogador”."
					: "Conta não encontrada: a busca por este ID não trouxe a conta (ela pode não existir ou estar além dos 100 primeiros resultados). Sem o saldo real, o ajuste fica bloqueado; abra o jogador pela lista do Banco."
			)
		]
	});

	let recent;
	if (d.txsError) recent = errorNotice(d.txsError, "as transações do jogador");
	else {
		const txs = ((d.txs && d.txs.data && d.txs.data.transactions) || [])
			.filter((t) => sameId(t.user_id, userId))
			.slice(0, RECENT);
		recent = dataTable(
			[
				{
					label: "Quando",
					value: (t) => h("span", { title: dateFmt(t.timestamp), text: relTime(t.timestamp) })
				},
				{
					label: "Operação",
					primary: true,
					value: (t) => `${opLabel(t.type)} · ${gameInfo(t.game, t.game_amount).label}`
				},
				{ label: "Runas", num: true, value: (t) => runasSigned(t) },
				{
					label: "Status",
					value: (t) =>
						t.status === "UNDONE" ? pill("desfeita") : h("span", { class: "faint", text: "ativa" })
				}
			],
			txs,
			{
				caption: `Últimas transações de ${name}`,
				empty: "Nenhuma transação ainda.",
				rowClass: (t) => (t.status === "UNDONE" ? "undone" : null)
			}
		);
	}

	root.append(
		h(
			"div",
			{ class: "bk-grid2" },
			info,
			card({
				title: "Últimas transações",
				actions: h("a", {
					class: "btn btn-quiet",
					href: buildHash("banco", ["transacoes"], { q: String(userId) }),
					text: "Todas →"
				}),
				body: recent
			})
		)
	);
}
