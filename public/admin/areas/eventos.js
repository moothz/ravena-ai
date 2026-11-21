/*
 * Eventos programados (antiga /eventos/admin): lista em Agora / Programados / Encerrados,
 * formulário em #/eventos/novo (Repetir: #/eventos/novo?de=<id>) e edição em #/eventos/<id>.
 * Rotas: GET/POST /api/events/admin, PUT/DELETE /api/events/admin/:id e
 * POST /api/events/admin/generate-message. Status do serviço: ativo, proximo, normal, passado.
 * Horários sempre no horário de Brasília (UTC-03:00 fixo, como a tela antiga e o servidor).
 */

import {
	h,
	api,
	send,
	card,
	pill,
	kv,
	crumbs,
	secLabel,
	empty,
	note,
	toast,
	errorNotice,
	confirmInline,
	copyText,
	loadAreaCss,
	externalLink,
	grafanaLink,
	grafanaMissing,
	searchBox,
	field,
	form,
	icon,
	srOnly,
	poll,
	preserveFocus,
	debounce,
	dateFmt,
	relTime,
	plural,
	fmt,
	buildHash,
	isEventActive
} from "../core.js";
import {
	STATUS_LABELS,
	STATUS_FILTERS,
	classify,
	groupEvents,
	filterEvents,
	whenText,
	progressPct,
	durationText,
	toBrtLocal,
	fromBrtLocal,
	collectSelection,
	checkForm,
	eventBody,
	defaultTimes,
	bonusText
} from "./eventos/lib.js";

const LIST = "/api/events/admin";
const GEN = "/api/events/admin/generate-message";
const HOME = "#/eventos";

/* Diferença entre o relógio do servidor e o do navegador (serverTime de cada leitura). */
const skews = new WeakMap();
let skew = 0;
const now = () => Date.now() + skew;

async function load({ fresh = false } = {}) {
	const d = await api(LIST, { fresh });
	if (!skews.has(d)) skews.set(d, Number.isFinite(d.serverTime) ? d.serverTime - Date.now() : 0);
	skew = skews.get(d);
	return {
		events: Array.isArray(d.events) ? d.events : [],
		catalog: {
			startGrants: (d.catalog && d.catalog.startGrants) || [],
			ongoingBuffs: (d.catalog && d.catalog.ongoingBuffs) || []
		}
	};
}

const grafanaBtn = () =>
	externalLink(grafanaLink("economia", { dtab: "mudanas" }), "Efeito no Grafana", {
		button: true,
		quiet: true,
		missing: grafanaMissing()
	});

const btn = (text, cls = "btn", extra = {}) =>
	h("button", { type: "button", class: cls, text, ...extra });

/* ── Ações (as mesmas no cartão e na página do evento) ──────────── */

/** Encerrar agora: o fim vira "agora" (PUT); os buffs param na próxima leitura do serviço. */
function endNowButton(ev, after) {
	return confirmInline(btn("Encerrar agora", "btn", { "data-key": `fim-${ev.id}` }), {
		question: "Encerrar agora? Os buffs param na hora.",
		confirmLabel: "Encerrar",
		onConfirm: async () => {
			await send(
				"PUT",
				`${LIST}/${ev.id}`,
				eventBody(ev, { endTime: Math.max(ev.startTime + 1, now()) })
			);
			toast(`“${ev.name}” encerrado`, { kind: "ok" });
			after();
		}
	});
}

/**
 * Começar agora: o início vira "agora" (PUT). Com startedAt nulo e início já passado, o serviço
 * credita os ganhos e manda o aviso na hora (updateEvent → processPendingStarts).
 * Se a mensagem salva é a automática, ela é refeita (a duração muda); se foi escrita à mão, fica.
 */
function startNowButton(ev, after) {
	return confirmInline(btn("Começar agora", "btn", { "data-key": `inicio-${ev.id}` }), {
		question: "Começar agora? Os ganhos são creditados e o aviso vai para os grupos.",
		confirmLabel: "Começar",
		danger: false,
		onConfirm: async () => {
			let message = ev.message || "";
			try {
				const g = await send("POST", GEN, { id: ev.id, save: false });
				if (g && typeof g.message === "string" && g.message.trim() === message.trim()) message = "";
			} catch {
				/* sem prévia: mantém a mensagem salva */
			}
			await send("PUT", `${LIST}/${ev.id}`, eventBody(ev, { startTime: now(), message }));
			toast(`“${ev.name}” começou: ganhos e aviso a caminho`, { kind: "ok" });
			after();
		}
	});
}

/** Apagar (DELETE). Em evento programado é o "Cancelar" do mock; a pergunta diz o efeito. */
function deleteButton(ev, after, { label = "Apagar…", quiet = true } = {}) {
	const question =
		ev.status === "ativo"
			? `Apagar “${ev.name}” (#${ev.id})? Os buffs param na hora e não dá para desfazer.`
			: ev.status === "passado"
				? `Apagar “${ev.name}” (#${ev.id}) do histórico? Não dá para desfazer.`
				: "Cancelar? O evento some e nada é enviado aos grupos.";
	return confirmInline(
		btn(label, `btn btn-danger${quiet ? " btn-quiet" : ""}`, { "data-key": `apagar-${ev.id}` }),
		{
			question,
			confirmLabel:
				ev.status === "proximo" || ev.status === "normal" ? "Cancelar evento" : "Apagar",
			cancelLabel: "Não",
			onConfirm: async () => {
				await send("DELETE", `${LIST}/${ev.id}`);
				toast(
					ev.status === "proximo" || ev.status === "normal" ? "Evento cancelado" : "Evento apagado",
					{
						kind: "ok"
					}
				);
				after();
			}
		}
	);
}

/* ── Cartão do evento ──────────────────────────────────────────── */

function bonusList(list) {
	return h(
		"ul",
		{ class: "ev-list" },
		list.map((it) => h("li", { text: bonusText(it) }))
	);
}

function startedText(ev) {
	if (ev.startedAt) return `enviados ${relTime(ev.startedAt, now())} (${dateFmt(ev.startedAt)})`;
	if (ev.status === "ativo") return "na fila: o agendador confere a cada 30 s";
	if (ev.status === "passado") return "não foram enviados";
	return "saem quando o evento começar";
}

function eventCard(ev, ctx) {
	const t = now();
	const st = ev.status;
	const pct = st === "ativo" ? progressPct(ev, t) : null;
	const grants = ev.grantsList || [];
	const buffs = ev.buffsList || [];
	const after = () => ctx.refresh();

	let left;
	let right;
	if (st === "ativo") {
		left = grafanaBtn();
		right = endNowButton(ev, after);
	} else if (st === "passado") {
		left = grafanaBtn();
		right = h("a", {
			class: "btn",
			href: buildHash("eventos", ["novo"], { de: ev.id }),
			text: "Repetir…",
			"data-key": `repetir-${ev.id}`
		});
	} else {
		left = deleteButton(ev, after, { label: "Cancelar" });
		right = startNowButton(ev, after);
	}

	return h(
		"article",
		{ class: "card ev", "data-st": st, "aria-labelledby": `ev-t-${ev.id}` },
		h(
			"a",
			{ class: "ev-h", href: `${HOME}/${ev.id}`, "data-key": `ev-${ev.id}` },
			h("b", { id: `ev-t-${ev.id}`, text: ev.name }),
			pill(STATUS_LABELS[st] || st, st === "ativo" ? "ok" : ""),
			h("span", { class: "ev-id", text: `#${ev.id}` }),
			h("span", { class: "chev", "aria-hidden": "true", text: "›" }),
			srOnly(" — editar")
		),
		h(
			"div",
			{ class: "ev-when" },
			h("span", { class: "ev-dates", text: `${dateFmt(ev.startTime)} → ${dateFmt(ev.endTime)}` }),
			h("span", { class: "ev-rel", text: whenText(ev, t) }),
			h("span", { class: "ev-dur", text: durationText(ev.endTime - ev.startTime) })
		),
		pct !== null
			? h(
					"div",
					{
						class: "ev-bar",
						role: "progressbar",
						"aria-valuenow": String(pct),
						"aria-valuemin": "0",
						"aria-valuemax": "100",
						"aria-label": `Andamento do evento: ${pct}%`
					},
					h("i", { style: `width:${pct}%` })
				)
			: null,
		h(
			"dl",
			{ class: "ev-fx" },
			h("dt", { text: "Ao começar" }),
			h("dd", null, grants.length ? bonusList(grants) : "—"),
			buffs.length ? [h("dt", { text: "Durante" }), h("dd", null, bonusList(buffs))] : null,
			h("dt", { text: "Aviso e itens" }),
			h("dd", { class: "ev-sent", text: startedText(ev) })
		),
		h("div", { class: "ev-acts confirm-bar" }, left, h("span", { class: "sp" }), right)
	);
}

/* ── Lista ─────────────────────────────────────────────────────── */

async function renderList(root, ctx) {
	ctx.head.append(
		h(
			"button",
			{
				type: "button",
				class: "btn btn-quiet",
				"data-key": "atualizar",
				onclick: () => ctx.refresh()
			},
			icon("recarregar"),
			h("span", { class: "btn-label", text: "Atualizar" })
		),
		externalLink("/eventos", "Página pública", { button: true, quiet: true }),
		h(
			"a",
			{ class: "btn btn-primary", href: `${HOME}/novo`, "data-key": "novo" },
			icon("novo"),
			"Novo evento"
		)
	);

	let data;
	try {
		data = await load();
	} catch (err) {
		root.append(errorNotice(err, "os eventos"));
		return;
	}

	const state = {
		q: ctx.params.get("q") || "",
		status: STATUS_FILTERS.some((f) => f.id === ctx.params.get("status"))
			? ctx.params.get("status")
			: "todos"
	};
	const syncUrl = () => {
		const p = {};
		if (state.q) p.q = state.q;
		if (state.status !== "todos") p.status = state.status;
		history.replaceState(null, "", buildHash("eventos", [], Object.keys(p).length ? p : null));
	};

	const count = h("span", { class: "ev-count", role: "status", "aria-live": "polite" });
	const list = h("div", { class: "stack ev-groups" });

	const seg = h(
		"div",
		{ class: "seg", role: "group", "aria-label": "Filtrar por situação" },
		STATUS_FILTERS.map((f) =>
			h("button", {
				type: "button",
				"aria-pressed": String(f.id === state.status),
				"data-key": `status-${f.id}`,
				text: f.label,
				onclick: (e) => {
					state.status = f.id;
					seg
						.querySelectorAll("button")
						.forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget)));
					syncUrl();
					draw();
				}
			})
		)
	);

	function draw() {
		const all = classify(data.events, now());
		const shown = filterEvents(all, state);
		count.textContent = plural(shown.length, "evento", "eventos");
		const g = groupEvents(shown);
		const nodes = [];
		if (!all.length) {
			nodes.push(
				card({
					body: empty(
						"Nenhum evento programado ainda.",
						"Use “Novo evento” para programar o próximo."
					)
				})
			);
		} else if (!shown.length) {
			nodes.push(
				card({ body: empty("Nenhum evento com esse filtro.", "Mude a busca ou a situação.") })
			);
		}
		for (const [label, items] of [
			["Agora", g.agora],
			["Programados", g.programados],
			["Encerrados", g.encerrados]
		]) {
			if (!items.length) continue;
			nodes.push(
				h(
					"section",
					{ class: "ev-group", "aria-label": label },
					secLabel(`${label} · ${fmt(items.length)}`),
					items.map((ev) => eventCard(ev, ctx))
				)
			);
		}
		preserveFocus(list, () => list.replaceChildren(...nodes));
	}

	root.append(
		h(
			"div",
			{ class: "toolbar ev-toolbar" },
			searchBox({
				label: "Buscar evento",
				placeholder: "Buscar evento por nome",
				value: state.q,
				key: "busca-eventos",
				onSearch: (q) => {
					state.q = q;
					syncUrl();
					draw();
				}
			}),
			seg,
			h("span", { class: "spacer" }),
			count
		),
		list
	);
	draw();

	// O tempo anda (programado vira "agora", a barra cresce): relê a cada minuto, sem
	// atropelar uma confirmação aberta.
	return poll(async () => {
		if (list.querySelector(".confirm")) return;
		data = await load({ fresh: true });
		if (!list.querySelector(".confirm")) draw();
	}, 60000);
}

/* ── Formulário (novo, repetir, editar) ────────────────────────── */

function bonusRow(item, value, onChange) {
	const checked = Number(value) > 0;
	const cb = h("input", { type: "checkbox", "data-bonus": item.id });
	cb.checked = checked;
	const num = h("input", {
		type: "text",
		inputmode: "numeric",
		pattern: "[0-9]*",
		autocomplete: "off",
		class: "ev-num",
		"aria-label": `${item.label}: quantidade (${item.unit})`,
		"data-min": String(item.min),
		"data-max": String(item.max)
	});
	num.value = String(checked ? Number(value) : item.defaultValue);
	num.disabled = !checked;
	const row = h(
		"div",
		{ class: "ev-bonus", "data-checked": String(checked) },
		h(
			"label",
			{ class: "ev-bonus-check" },
			cb,
			h(
				"span",
				{ class: "ev-bonus-tx" },
				h("span", {
					class: "ev-bonus-name",
					text: `${item.emoji ? `${item.emoji} ` : ""}${item.label}`
				}),
				h("span", {
					class: "fld-hint",
					text: `${item.gameLabel} · ${fmt(item.min)} a ${fmt(item.max)} ${item.unit}`
				}),
				item.description ? h("span", { class: "fld-hint ev-desc", text: item.description }) : null
			)
		),
		h("span", { class: "ev-bonus-val" }, num, h("span", { class: "ev-unit", text: item.unit }))
	);
	cb.addEventListener("change", () => {
		row.dataset.checked = String(cb.checked);
		num.disabled = !cb.checked;
		if (cb.checked) {
			const n = Number(num.value);
			if (!Number.isInteger(n) || n < item.min || n > item.max)
				num.value = String(item.defaultValue);
			num.focus();
			num.select();
		}
		onChange();
	});
	num.addEventListener("input", () => {
		const clean = num.value.replace(/[^0-9]/g, "");
		if (clean !== num.value) num.value = clean;
		onChange();
	});
	return { row, entry: () => ({ id: item.id, checked: cb.checked, value: num.value }) };
}

function bonusSection(title, hint, catalog, values, onChange) {
	const rows = catalog.map((it) => bonusRow(it, values && values[it.id], onChange));
	const el = h(
		"fieldset",
		{ class: "ev-section" },
		h("legend", { text: title }),
		h("p", { class: "fld-hint", text: hint }),
		h(
			"div",
			{ class: "ev-bonus-grid" },
			rows.map((r) => r.row)
		)
	);
	return {
		el,
		collect: () =>
			collectSelection(
				catalog,
				rows.map((r) => r.entry())
			)
	};
}

async function renderForm(root, ctx) {
	const idSeg = ctx.segs[0];
	const isNew = idSeg === "novo";
	let data;
	try {
		data = await load();
	} catch (err) {
		root.append(errorNotice(err, "o evento"));
		return;
	}
	const all = classify(data.events, now());
	const byId = (id) => all.find((e) => String(e.id) === String(id));
	const ev = isNew ? null : byId(idSeg);
	const source = isNew && ctx.params.get("de") ? byId(ctx.params.get("de")) : null;

	if (!isNew && !ev) {
		root.append(
			crumbs([{ label: "Eventos", href: HOME }, { label: `#${idSeg}` }]),
			card({
				body: [
					empty(`Evento #${idSeg} não encontrado.`, "Ele pode ter sido apagado."),
					h("a", { class: "btn", href: HOME, text: "Voltar para Eventos" })
				]
			})
		);
		return;
	}

	root.append(
		crumbs([
			{ label: "Eventos", href: HOME },
			{ label: ev ? ev.name : source ? `Repetir “${source.name}”` : "Novo evento" }
		])
	);

	// Resumo e ações do evento salvo
	if (ev) {
		const after = () => ctx.navigate(HOME);
		const acts = [];
		if (ev.status === "ativo") acts.push(endNowButton(ev, () => ctx.refresh()));
		else if (ev.status !== "passado") acts.push(startNowButton(ev, () => ctx.refresh()));
		else
			acts.push(
				h("a", {
					class: "btn",
					href: buildHash("eventos", ["novo"], { de: ev.id }),
					text: "Repetir…"
				})
			);
		root.append(
			card({
				title: `Evento #${ev.id}`,
				pill: pill(STATUS_LABELS[ev.status] || ev.status, ev.status === "ativo" ? "ok" : ""),
				body: [
					kv([
						["Quando", `${dateFmt(ev.startTime)} → ${dateFmt(ev.endTime)}`],
						["Situação", whenText(ev, now())],
						["Duração", durationText(ev.endTime - ev.startTime)],
						["Aviso e itens", startedText(ev)],
						["Criado", ev.createdAt ? dateFmt(ev.createdAt) : undefined],
						["Alterado", ev.updatedAt ? dateFmt(ev.updatedAt) : undefined]
					]),
					h(
						"div",
						{ class: "ev-acts ev-acts-page confirm-bar" },
						deleteButton(ev, after, {
							label:
								ev.status === "proximo" || ev.status === "normal" ? "Cancelar evento" : "Apagar…"
						}),
						ev.status !== "proximo" && ev.status !== "normal" ? grafanaBtn() : null,
						h("span", { class: "sp" }),
						acts
					)
				]
			})
		);
	}

	// Valores iniciais
	const base = ev || source;
	let startTs;
	let endTs;
	if (ev) {
		startTs = ev.startTime;
		endTs = ev.endTime;
	} else {
		const d = defaultTimes(now(), source ? source.endTime - source.startTime : undefined);
		startTs = d.start;
		endTs = d.end;
	}

	// Mensagem: prévia automática até ser editada à mão. Na tela antiga, evento salvo com
	// mensagem contava sempre como editado; aqui só conta se a salva difere da automática
	// (senão mudar um bônus deixaria a mensagem salva desatualizada).
	let manual = Boolean(ev && ev.message);
	if (manual) {
		try {
			const g = await send("POST", GEN, { id: ev.id, save: false });
			if (g && typeof g.message === "string" && g.message.trim() === ev.message.trim())
				manual = false;
		} catch {
			/* sem como comparar: trata como escrita à mão */
		}
	}

	const fName = field({
		label: "Nome",
		name: "name",
		required: true,
		wide: true,
		value: base ? base.name : "",
		placeholder: "Ex.: Festival das Sombras",
		attrs: { maxlength: "120", autocomplete: "off", "data-key": "ev-nome" }
	});
	const fStart = field({
		label: "Início (horário de Brasília)",
		name: "startTime",
		type: "datetime-local",
		required: true,
		value: toBrtLocal(startTs)
	});
	const fEnd = field({
		label: "Fim (horário de Brasília)",
		name: "endTime",
		type: "datetime-local",
		required: true,
		value: toBrtLocal(endTs)
	});
	const nameIn = fName.querySelector("input");
	const startIn = fStart.querySelector("input");
	const endIn = fEnd.querySelector("input");
	const durHint = h("p", { class: "fld-hint ev-dur-hint", "aria-live": "polite" });
	const showDuration = () => {
		const s = fromBrtLocal(startIn.value);
		const e = fromBrtLocal(endIn.value);
		durHint.textContent =
			Number.isFinite(s) && Number.isFinite(e)
				? e > s
					? `Duração: ${durationText(e - s)}`
					: "O fim precisa ser depois do início."
				: "";
		durHint.classList.toggle("ev-bad", Number.isFinite(s) && Number.isFinite(e) && e <= s);
	};

	const fMsg = field({
		label: "Mensagem para os grupos de Avisos e Anúncios (enviada ao começar)",
		name: "message",
		type: "textarea",
		rows: 9,
		wide: true,
		value: ev ? ev.message || "" : "",
		placeholder: "Em branco, ela é gerada sozinha a partir do nome, das datas e dos bônus.",
		attrs: { "data-key": "ev-msg" }
	});
	const msgIn = fMsg.querySelector("textarea");
	const msgState = h("span", { class: "fld-hint", "aria-live": "polite" });
	const showMsgState = () => {
		msgState.textContent = manual ? "escrita à mão: não muda sozinha" : "gerada automaticamente";
	};

	const payload = () => ({
		name: nameIn.value.trim(),
		startTime: startIn.value,
		endTime: endIn.value,
		startGrants: grants.collect(),
		ongoingBuffs: buffs.collect(),
		message: msgIn.value
	});

	let genSeq = 0;
	const preview = debounce(async () => {
		if (manual) return;
		let body;
		try {
			checkForm({ name: nameIn.value, startTime: startIn.value, endTime: endIn.value });
			body = payload();
		} catch {
			return;
		}
		const seq = ++genSeq;
		try {
			const r = await send("POST", GEN, { ...body, message: "" });
			if (seq === genSeq && !manual && r && typeof r.message === "string") msgIn.value = r.message;
		} catch {
			/* prévia silenciosa, como na tela antiga */
		}
	}, 250);
	const changed = () => {
		showDuration();
		preview();
	};

	const grants = bonusSection(
		"Ao começar",
		"Creditado automaticamente a todos os jogadores no momento em que o evento começa.",
		data.catalog.startGrants,
		base && base.startGrants,
		changed
	);
	const buffs = bonusSection(
		"Durante o evento",
		"Multiplicadores (+%) ativos nos jogos participantes do início ao fim do evento.",
		data.catalog.ongoingBuffs,
		base && base.ongoingBuffs,
		changed
	);

	nameIn.addEventListener("input", changed);
	startIn.addEventListener("change", changed);
	endIn.addEventListener("change", changed);
	msgIn.addEventListener("input", () => {
		manual = msgIn.value.trim().length > 0;
		showMsgState();
		if (!manual) preview();
	});

	const genBtn = h(
		"button",
		{
			type: "button",
			class: "btn",
			onclick: async () => {
				try {
					checkForm({ name: nameIn.value, startTime: startIn.value, endTime: endIn.value });
					const r = await send("POST", GEN, { ...payload(), message: "" });
					msgIn.value = r && typeof r.message === "string" ? r.message : msgIn.value;
					manual = false;
					showMsgState();
					toast("Mensagem gerada", { kind: "ok" });
				} catch (err) {
					toast(err && err.message ? err.message : "Não foi possível gerar a mensagem", {
						kind: "error"
					});
				}
			}
		},
		"Gerar mensagem"
	);
	const copyBtn = h(
		"button",
		{
			type: "button",
			class: "btn btn-quiet",
			onclick: () => copyText(msgIn.value, { ok: "Mensagem copiada", select: msgIn })
		},
		"Copiar"
	);

	const startedNote =
		ev && ev.startedAt
			? note(
					"Os ganhos e o aviso deste evento já foram enviados. Se o início for mudado para o futuro, eles serão enviados de novo quando o evento começar."
				)
			: null;

	const f = form({
		fields: [
			fName,
			fStart,
			fEnd,
			durHint,
			grants.el,
			buffs.el,
			fMsg,
			h("div", { class: "ev-msg-acts" }, genBtn, copyBtn, msgState),
			startedNote
		],
		submitLabel: ev ? "Salvar alterações" : "Programar evento",
		busyLabel: "Salvando…",
		onCancel: () => ctx.navigate(HOME),
		onSubmit: async () => {
			checkForm({ name: nameIn.value, startTime: startIn.value, endTime: endIn.value });
			const body = payload();
			if (ev) await send("PUT", `${LIST}/${ev.id}`, body);
			else await send("POST", LIST, body);
			toast(ev ? "Evento atualizado" : "Evento programado", { kind: "ok" });
			ctx.navigate(HOME);
		}
	});
	f.classList.add("ev-form");

	root.append(card({ title: ev ? "Editar evento" : "Novo evento", body: f }));
	showDuration();
	showMsgState();
	if (!ev) preview();
	// Depois da casca trocar o conteúdo (na mesma área ele entra só ao fim do render).
	if (isNew && !source)
		setTimeout(() => nameIn.isConnected && nameIn.focus({ preventScroll: true }), 0);
}

export default {
	id: "eventos",
	group: "Jogos",
	title: "Eventos",
	desc: "Eventos programados com bônus para os jogos e aviso automático nos grupos.",
	summary(p) {
		if (!Array.isArray(p.events)) return null;
		const active = p.events.filter((e) => isEventActive(e)).length;
		return { text: active ? `${fmt(active)} em andamento` : "nenhum em andamento" };
	},
	async render(root, ctx) {
		await loadAreaCss("eventos", "/admin/areas/eventos/eventos.css?v=2");
		if (!ctx.segs.length) return renderList(root, ctx);
		return renderForm(root, ctx);
	}
};
