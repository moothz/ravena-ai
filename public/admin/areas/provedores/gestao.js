/*
 * Provedores de IA, aba "Provedores": estado dos serviços, fila do LLM e o cadastro por tipo
 * (ligar/desligar, reordenar, criar, editar e apagar). Substitui a tela antiga /service-providers.
 *
 * Rotas: #/provedores · #/provedores/editar/<categoria>/<posição> · #/provedores/novo/<categoria>
 *        · #/provedores?grupo=<categoria> (rola até o grupo)
 *
 * Cada ação grava na hora: lê a config de novo (sem cache), aplica a mudança e manda a config
 * inteira no POST /api/service-providers (o contrato da rota, o mesmo da tela antiga). Se o
 * provedor naquela posição mudou de nome nesse meio-tempo, não grava e recarrega a tela.
 */

import {
	h,
	api,
	send,
	settle,
	card,
	pill,
	lamp,
	note,
	field,
	form,
	toast,
	confirmInline,
	busy,
	errorNotice,
	dataTable,
	poll,
	preserveFocus,
	buildHash,
	fmt,
	SERVICE_NAMES
} from "../../core.js";
import {
	categoriesOf,
	providerStates,
	categorySummary,
	describeProvider,
	serviceRows,
	toggleProvider,
	moveProvider,
	removeProvider,
	upsertProvider,
	isLastEnabled,
	formValues,
	buildProvider,
	validateProvider,
	queueRows,
	LLM_TYPES
} from "./logic.js";

const CONFIG = "/api/service-providers";
const HOME = "#/provedores";

/** Lê a config, o estado dos serviços e a fila. */
async function load(fresh = false) {
	const o = { fresh };
	return settle({
		config: api(CONFIG, o),
		services: api("/api/services/status", o),
		queue: api("/api/llm/queue", o).then((r) => (r && r.queues) || {}),
		at: Promise.resolve(Date.now())
	});
}

/** Modo pela rota: lista, editar (cat + índice) ou novo (cat). */
function modeOf(ctx) {
	const [what, cat, idx] = ctx.segs;
	if (what === "editar" && cat && idx !== undefined && /^\d+$/.test(idx)) {
		return { kind: "editar", cat, index: Number(idx) };
	}
	if (what === "novo" && cat) return { kind: "novo", cat };
	return { kind: "lista" };
}

/**
 * Grava uma mudança: relê a config, confere o provedor (posição + nome) e manda tudo.
 * @param {Object} ctx
 * @param {{ cat: string, index: number, name?: string }} target - index -1 = provedor novo
 * @param {(config: Object) => Object} change
 * @param {string} okMsg
 * @param {string} [goTo] - rota depois de gravar (padrão: recarrega no lugar)
 */
async function commit(ctx, target, change, okMsg, goTo) {
	const fresh = await api(CONFIG, { fresh: true });
	if (target.index >= 0) {
		const cur = fresh && fresh[target.cat] && fresh[target.cat][target.index];
		if (!cur || cur.name !== target.name) {
			ctx.refresh();
			throw new Error(
				"A lista mudou em outro lugar. A tela foi recarregada; confira e tente de novo"
			);
		}
	}
	const res = await send("POST", CONFIG, change(fresh));
	if (res && res.status && res.status !== "ok") {
		throw new Error(res.message || "o servidor não gravou");
	}
	toast(okMsg, { kind: "ok" });
	if (goTo && location.hash !== goTo) ctx.navigate(goTo);
	else ctx.refresh();
}

/** Botão comum com erro em toast (para ações sem confirmação); busy() mantém o foco. */
function actionButton(label, props, run) {
	const b = h("button", { type: "button", class: "btn", ...props }, label);
	b.addEventListener("click", () => busy(b, null, run));
	return b;
}

/* ── Serviços ────────────────────────────────────────────────────── */

const SVC_STATE = {
	up: { state: "ok", word: "no ar" },
	backup: { state: "attention", word: "na reserva" },
	down: { state: "down", word: "fora do ar" },
	unknown: { state: "off", word: "sem dado" }
};

function servicesCard(services, err) {
	if (err) return card({ title: "Serviços", body: errorNotice(err, "o estado dos serviços") });
	const list = serviceRows(services, SERVICE_NAMES);
	const down = list.filter((s) => s.status === "down").length;
	const backup = list.filter((s) => s.status === "backup").length;
	const badge = down
		? pill(`${fmt(down)} fora do ar`, "bad")
		: backup
			? pill(`${fmt(backup)} na reserva`, "att")
			: list.length
				? pill("todos no ar", "ok")
				: null;
	const items = list.map((s) => {
		const st = SVC_STATE[s.status];
		const detail = [];
		if (s.model && s.model !== "Nenhum") detail.push(`atendendo: ${s.model}`);
		if (s.resetSeconds) detail.push(`volta ao principal em ${fmt(s.resetSeconds)} s`);
		if (s.status === "backup" && !s.model)
			detail.push("o principal não respondeu; um reserva atende");
		if (s.status === "down") {
			detail.push(
				s.category
					? "nenhum provedor respondeu na última verificação"
					: "não respondeu na última verificação"
			);
		}
		const href =
			s.key === "whatsgoapi" ? "#/instancias" : s.category ? `${HOME}?grupo=${s.category}` : null;
		const sub = h(
			"span",
			{ class: `rw-sub${s.status === "down" ? " bad" : s.status === "backup" ? " att" : ""}` },
			h("span", { class: "state-word", "data-state": st.state, text: st.word }),
			detail.length ? ` · ${detail.join(" · ")}` : null
		);
		const ic = h(
			"span",
			{ class: "ic" },
			h("span", { class: "lamp", "data-state": st.state, "aria-hidden": "true" })
		);
		const tx = h("span", { class: "tx" }, h("b", { text: s.name }), sub);
		if (!href) {
			return h("div", { class: "prov-svc-static", "data-state": st.state }, ic, tx);
		}
		return h(
			"a",
			{ class: "rw", href, "data-state": st.state, "data-key": `svc-${s.key}` },
			ic,
			tx,
			h("span", { class: "chev", "aria-hidden": "true", text: "›" })
		);
	});
	return card({
		title: "Serviços",
		pill: badge,
		body: items.length
			? h(
					"div",
					{ class: "rows prov-svc", role: "list", "aria-label": "Estado dos serviços" },
					items
				)
			: h("p", { class: "prov-empty", text: "Ainda sem verificação dos serviços." }),
		padded: false
	});
}

/* ── Fila do LLM ─────────────────────────────────────────────────── */

function queueCard(queue, err, at) {
	const rowsQ = queueRows(queue);
	const busy = rowsQ.reduce((a, r) => a + r.pending + r.processing, 0);
	return card({
		title: "Fila do LLM",
		pill: err ? null : busy ? pill(`${fmt(busy)} na fila`, "") : pill("vazia", "ok"),
		actions: h("span", {
			class: "prov-updated",
			text: `atualizado ${new Date(at || Date.now()).toLocaleTimeString("pt-BR")}`
		}),
		body: err
			? errorNotice(err, "a fila do LLM")
			: dataTable(
					[
						{ label: "Prioridade", value: (r) => `prioridade ${r.priority}`, primary: true },
						{ label: "Pendentes", num: true, value: (r) => fmt(r.pending) },
						{ label: "Processando", num: true, value: (r) => fmt(r.processing) },
						{ label: "Atendidos (sessão)", num: true, value: (r) => fmt(r.fulfilled) },
						{ label: "Não atendidos", num: true, value: (r) => fmt(r.failed) }
					],
					rowsQ,
					{
						empty: "Nenhuma requisição na fila.",
						caption: "Fila do LLM por prioridade",
						rowClass: (r) => (r.failed > 0 ? "prov-q-failed" : null)
					}
				)
	});
}

/* ── Formulário ──────────────────────────────────────────────────── */

function providerForm(ctx, cat, index, existing) {
	const v = formValues(cat, existing);
	const fields = [
		field({
			label: "Nome do provedor",
			name: "name",
			value: v.name,
			required: true,
			placeholder: "Ex.: Ollama principal"
		}),
		field({
			label: "URL (endpoint)",
			name: "url",
			value: v.url,
			required: true,
			placeholder: "http://192.168.1.100:11434",
			attrs: { autocomplete: "off", spellcheck: "false" }
		}),
		field({
			label: "Chave de API (opcional)",
			name: "apiKey",
			type: "password",
			value: v.apiKey,
			placeholder: "sk-…",
			attrs: { autocomplete: "new-password", spellcheck: "false" }
		})
	];
	if (cat === "llm") {
		fields.push(
			field({
				label: "Tipo de LLM",
				name: "type",
				type: "select",
				value: v.type,
				options: LLM_TYPES
			}),
			field({ label: "Modelo", name: "model", value: v.model, placeholder: "Ex.: gemma3:12b" }),
			field({
				label: "Multiplicador de timeout (opcional)",
				name: "timeout_multiplier",
				type: "number",
				value: v.timeout_multiplier,
				placeholder: "1",
				attrs: { step: "any", min: "0" }
			}),
			field({
				label: "Tamanho do contexto (tokens)",
				name: "contextLength",
				type: "number",
				value: v.contextLength,
				placeholder: "Ex.: 32768",
				hint: "Janela de contexto máxima do modelo (ex.: 16384, 32768, 65536).",
				attrs: { step: "1", min: "1" }
			}),
			field({
				label: "Máximo de tokens de saída",
				name: "maxTokens",
				type: "number",
				value: v.maxTokens,
				placeholder: "Ex.: 4096",
				hint: "Limite padrão das respostas (padrão 4096).",
				attrs: { step: "1", min: "1" }
			}),
			field({
				label: "Apenas texto (não usar para imagens e vídeos)",
				name: "textOnly",
				type: "checkbox",
				value: v.textOnly,
				wide: true
			}),
			field({
				label: "Ignorar vídeo (multimodal)",
				name: "ignoreVideo",
				type: "checkbox",
				value: v.ignoreVideo,
				wide: true
			}),
			field({
				label: "Suporta tool calling (busca na web, funções)",
				name: "toolCalling",
				type: "checkbox",
				value: v.toolCalling,
				wide: true
			})
		);
	} else if (cat === "laya") {
		fields.push(
			field({
				label: "Modelo do Laya",
				name: "model",
				value: v.model,
				placeholder: "ravena-bgem3",
				hint: "Identificador do modelo na API (padrão ravena-bgem3)."
			}),
			field({
				label: "Timeout da requisição (ms)",
				name: "timeoutMs",
				type: "number",
				value: v.timeoutMs,
				placeholder: "3000",
				hint: "Tempo máximo antes de cair para o LLM (padrão 3000 ms).",
				attrs: { step: "1", min: "1" }
			})
		);
	} else if (cat === "nudenet") {
		fields.push(
			field({
				label: "Limiar padrão (0 a 1)",
				name: "threshold",
				type: "number",
				value: v.threshold,
				placeholder: "0.8",
				hint: "Sensibilidade quando o grupo não define a sua (ex.: 0,75 ou 0,8).",
				attrs: { step: "any", min: "0", max: "1" }
			}),
			field({
				label: "Pausa do circuit breaker (segundos)",
				name: "circuitBreakerSeconds",
				type: "number",
				value: v.circuitBreakerSeconds,
				placeholder: "15",
				hint: "Quanto esperar para tentar de novo se a API cair (padrão 15 s).",
				attrs: { step: "1", min: "1" }
			}),
			field({
				label: "Modo debug (salva mídias e logs em data/nudenet_debug)",
				name: "debug",
				type: "checkbox",
				value: v.debug,
				wide: true
			}),
			field({
				label: "Detectar em todas as mídias (mesmo sem filtro NSFW no grupo)",
				name: "detectAll",
				type: "checkbox",
				value: v.detectAll,
				wide: true
			})
		);
	}
	fields.push(
		field({ label: "Ligado", name: "enabled", type: "checkbox", value: v.enabled, wide: true })
	);

	const isNew = index < 0;
	const el = form({
		fields,
		submitLabel: isNew ? "Adicionar provedor" : "Salvar",
		onCancel: () => ctx.navigate(HOME),
		async onSubmit(values) {
			const draft = buildProvider(cat, values, existing);
			const problem = validateProvider(cat, draft);
			if (problem) throw new Error(problem);
			await commit(
				ctx,
				{ cat, index, name: existing && existing.name },
				(fresh) =>
					upsertProvider(
						fresh,
						cat,
						index,
						buildProvider(cat, values, isNew ? null : fresh[cat][index])
					),
				isNew ? `${draft.name} adicionado` : `${draft.name} salvo`,
				`${HOME}?grupo=${encodeURIComponent(cat)}`
			);
		}
	});
	el.setAttribute("aria-label", isNew ? "Novo provedor" : `Editar ${existing.name}`);
	if (!isNew) {
		const del = h("button", { type: "button", class: "btn btn-danger", text: "Apagar…" });
		confirmInline(del, {
			question: `Apagar ${existing.name}? Sai da lista de ${cat} na hora.`,
			confirmLabel: "Apagar",
			onConfirm: () =>
				commit(
					ctx,
					{ cat, index, name: existing.name },
					(fresh) => removeProvider(fresh, cat, index),
					`${existing.name} apagado`,
					`${HOME}?grupo=${encodeURIComponent(cat)}`
				)
		});
		el.querySelector(".form-actions").append(h("span", { class: "spacer" }), del);
	}
	return el;
}

/* ── Linhas de provedor ──────────────────────────────────────────── */

const STATE_PILL = { down: "bad", off: "", ok: "", attention: "att" };

function providerRow(ctx, cat, list, i, st, mode, queueBusy) {
	const p = list[i];
	const editing = mode.kind === "editar" && mode.cat === cat && mode.index === i;
	const name = p.name || `(sem nome ${i + 1})`;
	const target = { cat, index: i, name: p.name };
	const details = describeProvider(p, fmt);
	const sub = [];
	if (st.state === "down")
		sub.push(h("span", { class: "bad", text: "sem resposta na última verificação" }));
	if (st.active && cat === "llm" && queueBusy > 0) sub.push(`${fmt(queueBusy)} na fila`);
	if (details) sub.push(details);

	const title = h(
		"div",
		{ class: "prov-title" },
		h("b", { text: name }),
		h("span", { class: "state-word", "data-state": st.state, text: st.word }),
		st.rank ? pill(`prioridade ${st.rank}`) : null,
		st.role === "principal"
			? pill("principal", STATE_PILL[st.state] === "bad" ? "bad" : "ok")
			: null
	);
	const on = p.enabled !== false;
	const toggleLabel = on ? "Desligar" : "Ligar";
	const toggleKey = `tog-${cat}-${name}`;
	let toggle;
	const doToggle = () =>
		commit(
			ctx,
			target,
			(fresh) => toggleProvider(fresh, cat, i),
			`${name} ${on ? "desligado" : "ligado"}`
		);
	if (on && isLastEnabled(list, i)) {
		toggle = h("button", {
			type: "button",
			class: "btn",
			text: toggleLabel,
			"data-key": toggleKey,
			"aria-label": `${toggleLabel} ${name}`
		});
		confirmInline(toggle, {
			question: `É o único ligado de ${cat}: desligar para o serviço.`,
			confirmLabel: "Desligar",
			onConfirm: doToggle
		});
	} else {
		toggle = actionButton(
			toggleLabel,
			{ "data-key": toggleKey, "aria-label": `${toggleLabel} ${name}` },
			doToggle
		);
	}
	const move = (delta, label, glyph) =>
		actionButton(
			glyph,
			{
				class: "btn btn-quiet",
				"data-key": `mv${delta}-${cat}-${name}`,
				"aria-label": `${label} ${name}`,
				title: label,
				// aria-disabled (não disabled): o foco continua no botão depois de chegar à ponta
				"aria-disabled":
					(delta < 0 && i === 0) || (delta > 0 && i === list.length - 1) ? "true" : null
			},
			() =>
				commit(
					ctx,
					target,
					(fresh) => moveProvider(fresh, cat, i, delta),
					`${name}: ${label.toLowerCase()}`
				)
		);
	const acts = h(
		"div",
		{ class: "prov-acts" },
		toggle,
		move(-1, "Subir prioridade", "↑"),
		move(1, "Descer prioridade", "↓"),
		editing
			? h(
					"a",
					{
						class: "btn btn-quiet",
						href: HOME,
						"data-key": `ed-${cat}-${name}`,
						"aria-current": "true"
					},
					"Fechar"
				)
			: h(
					"a",
					{
						class: "btn btn-quiet",
						href: buildHash("provedores", ["editar", cat, String(i)]),
						"data-key": `ed-${cat}-${name}`,
						"aria-label": `Editar ${name}`
					},
					"Editar"
				)
	);
	const row = h(
		"div",
		{ class: `prov-it${editing ? " is-editing" : ""}`, "data-state": st.state, role: "listitem" },
		h("span", { class: "lamp", "data-state": st.state, "aria-hidden": "true" }),
		h(
			"div",
			{ class: "prov-main" },
			title,
			sub.length ? h("div", { class: "prov-sub" }, joinDots(sub)) : null
		),
		acts
	);
	if (editing) row.append(h("div", { class: "prov-edit" }, providerForm(ctx, cat, i, p)));
	return row;
}

function joinDots(parts) {
	return parts.flatMap((p, i) => (i ? [" · ", p] : [p]));
}

function groupCard(ctx, c, config, services, mode, queueBusy) {
	const list = Array.isArray(config[c.id]) ? config[c.id] : [];
	const states = providerStates(c.id, list, services);
	const sum = categorySummary(c.id, list, services);
	const adding = mode.kind === "novo" && mode.cat === c.id;
	const items = list.map((_, i) => providerRow(ctx, c.id, list, i, states[i], mode, queueBusy));
	const add = adding
		? h("a", { class: "btn btn-quiet", href: HOME, "data-key": `add-${c.id}` }, "Fechar")
		: h(
				"a",
				{
					class: "btn",
					href: buildHash("provedores", ["novo", c.id]),
					"data-key": `add-${c.id}`,
					"aria-label": `Adicionar provedor de ${c.name}`
				},
				"Adicionar"
			);
	const body = h(
		"div",
		{ class: "prov-list", role: "list", "aria-label": c.name },
		adding
			? h(
					"div",
					{ class: "prov-new", role: "listitem" },
					h("h3", { text: "Novo provedor" }),
					providerForm(ctx, c.id, -1, null)
				)
			: null,
		items.length
			? items
			: adding
				? null
				: h("p", { class: "prov-empty", text: "Nenhum provedor cadastrado." })
	);
	const el = card({
		title: c.name,
		pill: pill(sum.text, sum.kind),
		actions: add,
		body,
		padded: false
	});
	el.id = `prov-grupo-${c.id}`;
	el.dataset.grupo = c.id;
	return el;
}

/* ── Tela ────────────────────────────────────────────────────────── */

function draw(ctx, d) {
	const mode = modeOf(ctx);
	if (d.configError) {
		return [
			errorNotice(d.configError, "os provedores"),
			h(
				"p",
				null,
				h("button", {
					type: "button",
					class: "btn",
					text: "Tentar de novo",
					onclick: () => ctx.refresh()
				})
			)
		];
	}
	const config = d.config || {};
	const services = d.servicesError ? null : d.services;
	const busy = queueRows(d.queue).reduce((a, r) => a + r.pending + r.processing, 0);
	const cats = categoriesOf(config);
	if ((mode.kind === "novo" || mode.kind === "editar") && !cats.some((c) => c.id === mode.cat)) {
		mode.kind = "lista";
	}
	const missing =
		mode.kind === "editar" && !(Array.isArray(config[mode.cat]) && config[mode.cat][mode.index]);
	return [
		servicesCard(d.services, d.servicesError),
		missing
			? h(
					"div",
					{ class: "notice error", role: "alert" },
					lamp("down"),
					"Esse provedor não existe mais (a lista mudou). Escolha de novo abaixo."
				)
			: null,
		note(
			"A ordem decide quem atende: o primeiro ligado de cada tipo é o principal; os outros são reserva, nessa ordem. Um provedor fora é pulado até voltar. Cada mudança grava na hora."
		),
		...cats.map((c) => groupCard(ctx, c, config, services, mode, busy)),
		queueCard(d.queue, d.queueError, d.at)
	];
}

/**
 * @param {HTMLElement} root
 * @param {Object} ctx
 * @returns {Promise<() => void>} limpeza (para o poll)
 */
export async function renderGestao(root, ctx) {
	const d = await load();
	root.append(...draw(ctx, d).filter(Boolean));

	// Foco/rolagem: no formulário aberto, ou no grupo pedido em ?grupo=.
	const grupo = ctx.params.get("grupo");
	requestAnimationFrame(() => {
		const formEl = root.querySelector(".prov-edit form, .prov-new form");
		if (formEl) {
			formEl.scrollIntoView({ block: "nearest" });
			const first = formEl.querySelector("input, select");
			if (first) first.focus({ preventScroll: true });
		} else if (grupo) {
			const g = root.querySelector(`[data-grupo="${CSS.escape(grupo)}"]`);
			if (g) g.scrollIntoView({ block: "start" });
		}
	});

	// A cada 30 s (como a tela antiga), sem mexer num formulário ou confirmação abertos.
	return poll(async () => {
		if (!root.isConnected || root.querySelector("form, .confirm")) return;
		const next = await load(true);
		if (!root.isConnected || root.querySelector("form, .confirm")) return;
		await preserveFocus(root, () => root.replaceChildren(...draw(ctx, next).filter(Boolean)));
	}, 30000);
}
