/*
 * Instâncias › lista (#/instancias?filtro=&plataforma=&q=): resumo, filtros, busca e uma linha
 * por instância (lâmpada, estado por escrito, plataforma, grupos, mensagens), com Reiniciar,
 * Desativar/Reativar e Logs. A linha inteira abre a ficha.
 */

import {
	h,
	icon,
	lamp,
	pill,
	card,
	tiles,
	empty,
	note,
	errorNotice,
	searchBox,
	confirmInline,
	toast,
	poll,
	preserveFocus,
	isEditing,
	refreshLater,
	fmt,
	fmt2,
	plural,
	relTime,
	buildHash
} from "../../core.js";
import {
	FILTERS,
	PLATFORM_FILTERS,
	PLATFORM_NAMES,
	botState,
	platformOf,
	filterBots,
	summarize,
	isEnabled
} from "./modelo.js";
import {
	loadBots,
	botHref,
	listHref,
	botAction,
	saveAll,
	pendingDrafts,
	peekDraft
} from "./comum.js";

const paramsOf = (ctx) => ({
	filtro: ctx.params.get("filtro") || "todas",
	plataforma: ctx.params.get("plataforma") || "",
	q: ctx.params.get("q") || ""
});

/** Hash da lista mantendo os outros filtros. */
function hrefWith(cur, change) {
	const p = { ...cur, ...change };
	const out = {};
	if (p.filtro && p.filtro !== "todas") out.filtro = p.filtro;
	if (p.plataforma) out.plataforma = p.plataforma;
	if (p.q) out.q = p.q;
	return listHref(Object.keys(out).length ? out : null);
}

/** Linha de detalhe: plataforma · grupos · mensagens · atraso · última mensagem. */
function detailLine(b) {
	const parts = [
		PLATFORM_NAMES[platformOf(b)],
		plural(Number(b.groupsCount) || 0, "grupo", "grupos"),
		`${fmt(Math.round(Number(b.msgsHr) || 0))} msgs/h`
	];
	const avg = b.responseTime && Number(b.responseTime.avg);
	if (avg > 0) parts.push(`resposta em ${fmt2(avg)} s`);
	const st = botState(b);
	if (st.key === "parada") parts.push("o processo do bot não está carregado");
	else if (st.key === "desconectada") parts.push("processo de pé, sem conexão");
	if (st.key !== "online" && st.key !== "desativada" && b.lastMessageReceived)
		parts.push(`última mensagem ${relTime(b.lastMessageReceived)}`);
	return parts.join(" · ");
}

function badges(b) {
	return [
		b.privado ? pill("privada") : null,
		b.vip ? pill("VIP") : null,
		b.comunitario ? pill("comunitária") : null,
		b.banido && !isEnabled(b) ? pill("banida", "bad") : null,
		peekDraft(b.nome)?.dirty ? pill("não salva", "att") : null
	];
}

/** Último resultado de ação por instância (sobrevive ao redesenho da lista). */
const rowMsgs = new Map();

function instRow(b, ctx) {
	const st = botState(b);
	const name = b.nomeExibir || b.nome;
	const busyBtn = (text, cls = "") => h("button", { type: "button", class: `btn ${cls}`, text });
	const msgEl = h("p", { class: "inst-row-msg", role: "status", "aria-live": "polite" });
	const say = (kind, text) => {
		if (text) rowMsgs.set(b.nome, { kind, text });
		else rowMsgs.delete(b.nome);
		msgEl.dataset.kind = kind;
		msgEl.textContent = text || "";
	};
	const last = rowMsgs.get(b.nome);
	if (last) say(last.kind, last.text);

	// A falha fica escrita na própria linha; a confirmação fecha (sem toast repetido).
	const run = (fn) => async () => {
		say("busy", "");
		try {
			await fn();
		} catch (err) {
			say("error", err.message);
		}
	};

	const acts = h("div", { class: "inst-acts" });
	if (!isEnabled(b)) {
		const on = busyBtn("Reativar", "btn-primary");
		on.dataset.key = `on-${b.nome}`;
		acts.append(
			confirmInline(on, {
				question: `Reativar ${name}? Grava enabled=true no bots.json.`,
				confirmLabel: "Reativar",
				danger: false,
				onConfirm: run(async () => {
					await saveAll({ patch: { [b.nome]: { enabled: true } } });
					say(
						"ok",
						b.isLive
							? "Reativada no bots.json."
							: "Reativada no bots.json. O processo do bot não está carregado: reinicie a Ravena para ela subir."
					);
					toast(`${name} reativada`, { kind: "ok" });
					ctx.refresh();
				})
			})
		);
	} else {
		const restart = busyBtn(
			"Reiniciar",
			st.lamp === "down" || st.lamp === "attention" ? "btn-primary" : ""
		);
		restart.dataset.key = `restart-${b.nome}`;
		acts.append(
			confirmInline(restart, {
				question: `Reiniciar ${name}?`,
				confirmLabel: "Reiniciar",
				onConfirm: run(async () => {
					const msg = await botAction(
						b,
						`/restart/${encodeURIComponent(b.nome)}`,
						`reiniciar ${name}`
					);
					say("ok", `Reinício pedido: ${msg || "aceito"}.`);
					toast(`Reiniciando ${name}`, { kind: "ok" });
					refreshLater(ctx, acts.closest(".view-root") || document.body);
				})
			})
		);
		const off = busyBtn("Desativar", "btn-quiet");
		off.dataset.key = `off-${b.nome}`;
		acts.append(
			confirmInline(off, {
				question: `Desativar ${name}? Ela para de ler e responder (enabled=false no bots.json).`,
				confirmLabel: "Desativar",
				onConfirm: run(async () => {
					await saveAll({ patch: { [b.nome]: { enabled: false } } });
					say("ok", "Desativada no bots.json.");
					toast(`${name} desativada`, { kind: "ok" });
					ctx.refresh();
				})
			})
		);
	}
	acts.append(
		h("a", {
			class: "btn btn-quiet",
			href: buildHash("logs", [b.nome]),
			"data-key": `logs-${b.nome}`,
			text: "Logs"
		})
	);

	return h(
		"div",
		{ class: "inst-row", "data-state": st.lamp },
		lamp(st.lamp),
		h(
			"div",
			{ class: "inst-main" },
			h(
				"div",
				{ class: "inst-title" },
				h(
					"a",
					{ class: "inst-link", href: botHref(b.nome), "data-key": `inst-${b.nome}` },
					h("b", { text: name })
				),
				b.nomeExibir && b.nomeExibir !== b.nome
					? h("span", { class: "mono faint inst-id", text: b.nome })
					: null,
				lamp(st.lamp, st.word),
				badges(b)
			),
			h("div", { class: "inst-sub", text: detailLine(b) }),
			msgEl
		),
		acts
	);
}

export async function renderLista(root, ctx) {
	const cur = paramsOf(ctx);
	ctx.head.append(
		h(
			"a",
			{ class: "btn btn-primary", href: buildHash("instancias", ["nova"]), "data-key": "nova" },
			icon("novo"),
			h("span", { class: "btn-label", text: "Nova instância" })
		),
		h(
			"button",
			{
				type: "button",
				class: "btn",
				"data-key": "atualizar",
				"aria-label": "Atualizar",
				onclick: () => ctx.refresh()
			},
			icon("recarregar"),
			h("span", { class: "btn-label", text: "Atualizar" })
		)
	);

	let bots;
	try {
		bots = await loadBots();
	} catch (err) {
		root.append(
			errorNotice(err, "as instâncias"),
			h(
				"p",
				null,
				h("button", {
					type: "button",
					class: "btn",
					text: "Tentar novamente",
					onclick: () => ctx.refresh()
				})
			)
		);
		return;
	}

	const pendBox = h("div");
	const sumBox = h("div");
	const listBox = h("div");

	const segFilters = h(
		"div",
		{ class: "seg inst-filters", role: "group", "aria-label": "Filtrar por estado" },
		FILTERS.map((f) =>
			h("a", {
				class: "seg-link",
				href: hrefWith(cur, { filtro: f.id }),
				"aria-current": f.id === cur.filtro ? "true" : null,
				"data-key": `filtro-${f.id}`,
				text: f.label
			})
		)
	);
	const platSel = h(
		"select",
		{ id: "inst-plat", class: "inst-select", "data-key": "plataforma", "aria-label": "Plataforma" },
		PLATFORM_FILTERS.map((p) =>
			h("option", { value: p.id, text: p.label, selected: p.id === cur.plataforma })
		)
	);
	platSel.addEventListener("change", () =>
		ctx.navigate(hrefWith(cur, { plataforma: platSel.value }), { replace: true })
	);
	const search = searchBox({
		label: "Buscar instância",
		placeholder: "nome, ID ou número",
		value: cur.q,
		key: "busca",
		onSearch: (q) => ctx.navigate(hrefWith(cur, { q }), { replace: true })
	});

	function drawPending() {
		const pend = pendingDrafts();
		pendBox.replaceChildren(
			pend.length
				? h(
						"div",
						{ class: "notice inst-pending", role: "status" },
						lamp("attention"),
						h(
							"span",
							null,
							`${plural(pend.length, "instância", "instâncias")} com alterações não salvas: `,
							pend.flatMap(([n], i) => [
								i ? ", " : "",
								h("a", { href: botHref(n, "config"), text: n })
							]),
							". Elas ficam guardadas até você salvar ou recarregar a página."
						)
					)
				: ""
		);
	}

	function draw(list) {
		const s = summarize(list);
		const down = s.enabled - s.online;
		sumBox.replaceChildren(
			tiles([
				{
					label: "Instâncias",
					value: fmt(s.total),
					detail: `${plural(s.enabled, "ativa", "ativas")} · ${plural(s.disabled, "desativada", "desativadas")}`
				},
				{
					label: "Online",
					value: `${fmt(s.online)} de ${fmt(s.enabled)}`,
					detail: `${fmt(s.offline)} offline${down ? ` · ${plural(down, "ativa fora do ar", "ativas fora do ar")}` : ""}`,
					attention: down > 0
				},
				{ label: "Privadas", value: fmt(s.privado) },
				{ label: "Grupos", value: fmt(s.groups) },
				{ label: "Msgs/h", value: fmt(s.msgsHr), detail: "soma das instâncias" }
			])
		);
		const shown = filterBots(list, cur);
		listBox.replaceChildren(
			shown.length
				? card({
						class: "inst-list",
						label: "Instâncias",
						padded: false,
						body: h(
							"div",
							{ class: "inst-rows" },
							shown.map((b) => instRow(b, ctx))
						)
					})
				: card({
						body: empty(
							list.length ? "Nenhuma instância neste filtro." : "Nenhuma instância no bots.json.",
							list.length
								? "Ajuste o filtro ou a busca acima."
								: "Use “Nova instância” para criar a primeira."
						)
					})
		);
		drawPending();
	}

	root.append(
		pendBox,
		sumBox,
		h("div", { class: "toolbar inst-toolbar" }, segFilters, platSel, search),
		listBox,
		note(
			"Desativar e Reativar gravam o campo enabled no bots.json, valendo na hora. ",
			"Não há desativação por tempo: o servidor não tem esse recurso. Catálogo de comandos: ",
			h("a", { href: "/cmd", target: "_blank", rel: "noopener", text: "/cmd ↗" }),
			"."
		)
	);
	draw(bots);

	const onDirty = () => drawPending();
	window.addEventListener("instancias:dirty", onDirty);
	// Atualização a cada 30 s (como a tela antiga), sem mexer em confirmação aberta.
	const stop = poll(async () => {
		if (isEditing(root)) return;
		try {
			const fresh = await loadBots(true);
			// A confirmação pode ter aberto enquanto a leitura estava em voo.
			if (ctx.signal.aborted || isEditing(root)) return;
			await preserveFocus(root, () => draw(fresh));
		} catch {
			/* a próxima volta tenta de novo; o erro aparece no Atualizar */
		}
	}, 30000);
	return () => {
		stop();
		window.removeEventListener("instancias:dirty", onDirty);
	};
}
