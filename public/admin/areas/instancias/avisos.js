/*
 * Instâncias › Avisos de status (#/instancias/avisos e #/instancias/avisos/<id> para editar):
 * o antigo modal "Publicar Status". Texto com markup do WhatsApp e prévia, expiração com atalhos,
 * publicar/editar/reutilizar/remover. O texto em andamento fica guardado ao trocar de tela.
 */

import {
	h,
	api,
	send,
	card,
	pill,
	empty,
	note,
	errorNotice,
	confirmInline,
	toast,
	dateFmt,
	buildHash,
	plural
} from "../../core.js";
import {
	toDatetimeLocal,
	EXPIRY_PRESETS,
	QUICK_EMOJIS,
	validateAnnouncement,
	insertAround
} from "./modelo.js";
import { explain, waMarkup } from "./comum.js";

const BASE = buildHash("instancias", ["avisos"]);
const editHref = (id) => buildHash("instancias", ["avisos", String(id)]);
const H = 3600 * 1000;

/** Formulário em andamento (sobrevive ao redesenho). editing: id do aviso em edição. */
const draft = { message: "", expires: "", editing: null };

const later = (hours) => toDatetimeLocal(Date.now() + hours * H);

const FORMAT = [
	{ tag: "bold", label: "Negrito", show: "*B*", before: "*", after: "*", hint: "*texto*" },
	{ tag: "italic", label: "Itálico", show: "_I_", before: "_", after: "_", hint: "_texto_" },
	{ tag: "strike", label: "Tachado", show: "~S~", before: "~", after: "~", hint: "~texto~" },
	{
		tag: "mono",
		label: "Monoespaçado",
		show: "```",
		before: "```",
		after: "```",
		hint: "```texto```"
	},
	{ tag: "quote", label: "Citação", show: ">", before: "> ", after: "", hint: "> texto" }
];

export async function renderAvisos(root, ctx) {
	const editId = ctx.segs[1] ? Number(ctx.segs[1]) : null;
	let list = [];
	let loadErr = null;
	try {
		const d = await api("/api/status-announcements", { fresh: true });
		list = Array.isArray(d && d.announcements) ? d.announcements : [];
	} catch (err) {
		loadErr = err;
	}

	// Entrar em edição pelo endereço.
	if (editId !== null && draft.editing !== editId) {
		const item = list.find((a) => Number(a.id) === editId);
		if (item) {
			draft.editing = editId;
			draft.message = item.message || "";
			const exp = Number(item.expires_at);
			draft.expires = exp <= Date.now() + 600000 ? later(24) : toDatetimeLocal(exp);
			toast(`Aviso #${editId} carregado para edição`);
		} else if (!loadErr) {
			root.append(
				h(
					"div",
					{ class: "notice error", role: "alert" },
					h("span", {
						text: `O aviso #${editId} não está entre os ativos (pode ter expirado ou sido removido).`
					})
				)
			);
		}
	}
	if (editId === null && draft.editing !== null) {
		draft.editing = null;
		draft.message = "";
		draft.expires = "";
	}
	if (!draft.expires) draft.expires = later(24);
	const editing =
		draft.editing !== null && list.some((a) => Number(a.id) === draft.editing)
			? draft.editing
			: null;

	/* Formulário */
	const msgId = "aviso-texto";
	const expId = "aviso-expira";
	const ta = h("textarea", {
		id: msgId,
		rows: 5,
		"data-key": "aviso-texto",
		placeholder:
			"ex.: *Manutenção programada*: o bot fica instável das 14h às 16h. _Obrigado pela paciência!_",
		"aria-describedby": "aviso-texto-hint"
	});
	ta.value = draft.message;
	const preview = h("div", { class: "inst-preview", "aria-live": "polite" });
	const drawPreview = () =>
		preview.replaceChildren(
			ta.value.trim()
				? waMarkup(ta.value)
				: h("span", {
						class: "faint",
						text: "A prévia da formatação aparece aqui enquanto você digita."
					})
		);
	ta.addEventListener("input", () => {
		draft.message = ta.value;
		drawPreview();
	});
	const insert = (before, after = "") => {
		const r = insertAround(ta.value, ta.selectionStart, ta.selectionEnd, before, after);
		ta.value = r.value;
		draft.message = r.value;
		ta.focus();
		ta.setSelectionRange(r.cursor, r.cursor);
		drawPreview();
	};
	const tools = h(
		"div",
		{ class: "inst-markup", role: "toolbar", "aria-label": "Formatação do WhatsApp" },
		h("span", { class: "label", text: "Formatar" }),
		FORMAT.map((f) =>
			h("button", {
				type: "button",
				class: "btn btn-quiet inst-mk",
				"data-tag": f.tag,
				title: `${f.label} (${f.hint})`,
				"aria-label": `${f.label} (${f.hint})`,
				text: f.show,
				onclick: () => insert(f.before, f.after)
			})
		),
		h("span", { class: "label", text: "Emojis" }),
		QUICK_EMOJIS.map((e) =>
			h("button", {
				type: "button",
				class: "btn btn-quiet inst-emoji",
				"aria-label": `Inserir ${e}`,
				text: e,
				onclick: () => insert(e)
			})
		)
	);

	const exp = h("input", {
		id: expId,
		type: "datetime-local",
		required: true,
		"data-key": "aviso-expira"
	});
	exp.value = draft.expires;
	exp.addEventListener("input", () => {
		draft.expires = exp.value;
	});
	const presets = h(
		"div",
		{ class: "inst-presets", role: "group", "aria-label": "Atalhos de expiração" },
		EXPIRY_PRESETS.map((p) =>
			h("button", {
				type: "button",
				class: "btn btn-quiet",
				text: p.label,
				onclick: () => {
					exp.value = later(p.hours);
					draft.expires = exp.value;
				}
			})
		)
	);

	const err = h("p", { class: "inst-inline-err", role: "alert" });
	const submit = h("button", {
		type: "submit",
		class: "btn btn-primary",
		"data-key": "aviso-enviar",
		text: editing ? "Salvar alterações" : "Publicar aviso"
	});
	const cancelEdit = editing
		? h("a", {
				class: "btn btn-quiet",
				href: BASE,
				"data-key": "aviso-cancelar",
				text: "Cancelar edição"
			})
		: null;

	const formEl = h(
		"form",
		{ class: "stack inst-aviso-form", novalidate: true },
		editing
			? h(
					"div",
					{ class: "notice", role: "status" },
					h(
						"span",
						null,
						"Editando o aviso ",
						h("b", { text: `#${editing}` }),
						": altere o texto ou o prazo e salve."
					)
				)
			: null,
		tools,
		h(
			"label",
			{ class: "fld", for: msgId },
			h("span", { class: "fld-label", text: "Texto do aviso" }),
			ta,
			h("span", {
				class: "fld-hint",
				id: "aviso-texto-hint",
				text: "Use *negrito*, _itálico_, ~tachado~, ```código``` ou > citação. Enter quebra a linha."
			})
		),
		h(
			"div",
			{ class: "fld" },
			h("span", { class: "fld-label", text: "Prévia no /status" }),
			preview
		),
		h(
			"div",
			{ class: "fld" },
			h("label", { class: "fld-label", for: expId, text: "Expira em" }),
			h("div", { class: "inst-expiry" }, exp, presets),
			h("span", {
				class: "fld-hint",
				text: "Depois disso o aviso some do /status e do !status sozinho."
			})
		),
		err,
		h("div", { class: "form-actions" }, submit, cancelEdit)
	);
	formEl.addEventListener("submit", async (ev) => {
		ev.preventDefault();
		err.textContent = "";
		const v = validateAnnouncement(ta.value, exp.value);
		if (v.error) {
			err.textContent = v.error;
			(v.field === "message" ? ta : exp).focus();
			return;
		}
		const label = submit.textContent;
		submit.disabled = true;
		submit.textContent = editing ? "Salvando…" : "Publicando…";
		try {
			const body = { message: ta.value.trim(), expiresAt: v.expiresAt };
			const res = editing
				? await send("PUT", `/api/status-announcements/${editing}`, body)
				: await send("POST", "/api/status-announcements", body);
			if (res && res.status && res.status !== "ok")
				throw new Error(res.message || "o servidor recusou");
			toast(editing ? "Aviso atualizado" : "Aviso publicado", { kind: "ok" });
			draft.message = "";
			draft.expires = "";
			draft.editing = null;
			if (editing) ctx.navigate(BASE, { replace: true });
			else ctx.refresh();
		} catch (e) {
			err.textContent =
				e.status !== undefined
					? explain(e, editing ? "salvar o aviso" : "publicar o aviso")
					: e.message;
			submit.disabled = false;
			submit.textContent = label;
		}
	});
	drawPreview();

	/* Ativos */
	let activeBody;
	if (loadErr) activeBody = errorNotice(loadErr, "os avisos ativos");
	else if (!list.length) activeBody = empty("Nenhum aviso ativo agora.");
	else
		activeBody = h(
			"div",
			{ class: "inst-avisos" },
			list.map((a) => {
				const expired = Date.now() > Number(a.expires_at);
				const isEd = editing === Number(a.id);
				const reuse = h("button", {
					type: "button",
					class: "btn btn-quiet",
					text: "Reutilizar",
					onclick: () => {
						draft.editing = null;
						draft.message = a.message || "";
						draft.expires = later(24);
						toast("Texto copiado para o formulário: ajuste e publique");
						if (ctx.segs[1]) ctx.navigate(BASE, { replace: true });
						else ctx.refresh();
					}
				});
				const del = h("button", {
					type: "button",
					class: "btn btn-quiet btn-danger",
					text: "Remover"
				});
				confirmInline(del, {
					question: `Remover o aviso #${a.id} do /status agora?`,
					confirmLabel: "Remover",
					onConfirm: async () => {
						try {
							await send("DELETE", `/api/status-announcements/${a.id}`);
						} catch (e) {
							throw new Error(explain(e, `remover o aviso #${a.id}`));
						}
						const refill = !draft.message.trim() || draft.editing === Number(a.id);
						if (draft.editing === Number(a.id)) draft.editing = null;
						if (refill) {
							draft.message = a.message || "";
							draft.expires = later(24);
							toast("Aviso removido. O texto voltou ao formulário, se quiser recadastrar.", {
								kind: "ok"
							});
						} else toast("Aviso removido", { kind: "ok" });
						if (ctx.segs[1]) ctx.navigate(BASE, { replace: true });
						else ctx.refresh();
					}
				});
				return h(
					"article",
					{ class: `inst-aviso${isEd ? " is-editing" : ""}`, "aria-label": `Aviso #${a.id}` },
					h(
						"div",
						{ class: "inst-aviso-meta" },
						h("b", { class: "mono", text: `#${a.id}` }),
						pill(
							`${expired ? "expirado" : "expira"} ${dateFmt(Number(a.expires_at))}`,
							expired ? "bad" : ""
						),
						h("span", {
							class: "faint",
							text: `criado em ${dateFmt(Number(a.created_at)).split(",")[0]}`
						}),
						isEd ? pill("em edição", "att") : null
					),
					waMarkup(a.message),
					h(
						"div",
						{ class: "inst-actions" },
						h("a", { class: "btn btn-quiet", href: editHref(a.id), text: "Editar" }),
						reuse,
						h("span", { class: "spacer" }),
						del
					)
				);
			})
		);

	root.append(
		card({ title: editing ? `Editando aviso #${editing}` : "Novo aviso", body: formEl }),
		card({
			title: "Avisos ativos",
			pill: pill(loadErr ? "—" : plural(list.length, "ativo", "ativos")),
			body: activeBody
		}),
		note("Os avisos aparecem na página /status e no comando !status até expirar.")
	);
}
