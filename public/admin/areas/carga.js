/*
 * Carga da economia (nativa). Substitui o cartão "Painel da economia" da aba
 * "Configurações & Economia" do /banco/admin, com as mesmas funções:
 * - estado geral e por fonte (dados até, atraso, última tentativa, situação e erro);
 * - agendamento: rodar agora, pausar/retomar, intervalo (1/2/3/6/12/24 h ou "padrão do .env");
 * - possíveis mudanças detectadas nos dados: Confirmar (podendo trocar o texto) e Descartar;
 * - registrar mudança à mão (texto, moeda, hora opcional).
 * Rotas: src/BotAPI/routes/economyRoutes.js (GET status/annotations; POST schedule, pause,
 * resume, run, annotations, annotations/decide). Regras sem DOM em ./carga/model.js.
 */

import {
	h,
	api,
	send,
	settle,
	card,
	dataTable,
	pill,
	lamp,
	confirmInline,
	busy,
	loadAreaCss,
	toast,
	errorNotice,
	empty,
	loading,
	note,
	field,
	form,
	icon,
	externalLink,
	grafanaLink,
	grafanaMissing,
	poll,
	isEditing,
	preserveFocus,
	relTime,
	dateFmt,
	fmt,
	econHealth
} from "../core.js";
import * as M from "./carga/model.js";

const BASE = "/api/economy/admin";
/** Com rodada em andamento, o estado é relido a cada POLL_MS; sem rodada, a cada IDLE_MS. */
const POLL_MS = 3000;
const IDLE_MS = 60000;

/** Data absoluta (Brasília) com o tempo relativo embaixo. */
function when(ts, now) {
	if (!ts) return "—";
	return h(
		"span",
		{ class: "cg-when" },
		h("span", { text: dateFmt(ts) }),
		h("span", { class: "faint", text: relTime(ts, now) })
	);
}

const SITUATION = {
	ok: ["ok", "ok"],
	late: ["atrasada", "att"],
	error: ["falhou", "bad"]
};

export default {
	id: "carga",
	group: "Jogos",
	title: "Carga da economia",
	desc: "A carga lê as três moedas e monta a base que o Grafana mostra. Aqui se roda, pausa e muda o intervalo; a leitura dos dados fica no Grafana.",
	summary(p) {
		const e = econHealth(p.econ);
		const count = e.failing.length + e.late.length;
		if (!e.available) return { text: e.detail ? `${e.word}: ${e.detail}` : e.word };
		const every = e.paused ? "pausada" : `a cada ${e.everyHours || 1} h`;
		if (e.failing.length) {
			return {
				text: `${e.failing.map((f) => f.name).join(", ")} falhou · ${every}`,
				attention: true,
				count
			};
		}
		if (e.late.length) {
			return {
				text: `${e.late.map((l) => l.name).join(", ")} atrasada · ${every}`,
				attention: true,
				count
			};
		}
		return { text: `${e.word} · ${every}` };
	},
	async render(root, ctx) {
		loadAreaCss("carga", "/admin/areas/carga.css?v=2");
		const S = {
			st: null,
			stError: null,
			possible: [],
			possibleError: null,
			every: null, // escolha do seletor ainda não salva (sobrevive ao redesenho)
			watchRun: false, // rodada pedida aqui: avisar quando terminar
			lastFetch: 0,
			loading: null,
			seq: 0 // número da leitura mais nova: uma resposta mais velha não redesenha por cima
		};

		/* ── Cabeçalho ── */
		const refreshBtn = h(
			"button",
			{
				type: "button",
				class: "btn btn-quiet",
				"data-key": "atualizar",
				onclick: () => busy(refreshBtn, "Atualizando…", () => reload())
			},
			icon("recarregar"),
			h("span", { class: "btn-label", text: "Atualizar" })
		);
		ctx.head.append(
			refreshBtn,
			externalLink(grafanaLink("economia", { dtab: "diagnstico" }), "Diagnóstico no Grafana", {
				button: true,
				quiet: true,
				missing: grafanaMissing()
			})
		);

		/* ── Corpo: três partes que redesenham e o formulário, que fica ── */
		const slots = { sched: h("div"), src: h("div"), poss: h("div") };
		const reg = registerCard();
		const body = h("div", { class: "stack cg" }, slots.sched, slots.src, slots.poss, reg.el);
		slots.sched.append(loading("Lendo o estado da carga…"));
		root.append(body);

		/**
		 * Relê o estado (e as possíveis mudanças); force: mesmo com uma confirmação aberta na lista.
		 * fromPoll: a volta automática não redesenha o cartão de agendamento com o admin mexendo
		 * nele (intervalo aberto, confirmação). Só a leitura mais nova desenha.
		 */
		async function reload({ possible = true, force = false, fromPoll = false } = {}) {
			const seq = ++S.seq;
			const stale = () => ctx.signal.aborted || seq !== S.seq;
			const prevRunning = !!(S.st && S.st.running);
			const r = await settle({ st: api(`${BASE}/status`, { fresh: true }) });
			if (stale()) return;
			S.lastFetch = Date.now();
			S.stError = r.stError || null;
			S.st = r.st || (r.stError ? null : S.st);
			const running = !!(S.st && S.st.running);
			const finished = prevRunning && !running && !S.stError;
			if (finished && S.watchRun) {
				const out = M.runOutcome(S.st);
				toast(out.text, { kind: out.ok ? "ok" : "error" });
			}
			if (!running) S.watchRun = false;
			// Uma rodada que termina pode ter detectado possíveis mudanças novas
			const editing = !force && slots.poss.querySelector(".confirm");
			const loadPossible = (possible || finished) && !editing;
			if (loadPossible) {
				if (M.isAvailable(S.st)) {
					const p = await settle({ list: api(`${BASE}/annotations?possiveis=1`, { fresh: true }) });
					if (stale()) return;
					S.possible = (p.list && p.list.annotations) || [];
					S.possibleError = p.listError || null;
				} else {
					S.possible = [];
					S.possibleError = null;
				}
			}
			const keepSched = fromPoll && isEditing(slots.sched);
			await preserveFocus(body, () => {
				if (!keepSched) slots.sched.replaceChildren(scheduleCard());
				slots.src.replaceChildren(sourcesCard());
				if (loadPossible) slots.poss.replaceChildren(possibleCard());
			});
			reg.setEnabled(M.isAvailable(S.st));
		}

		/** Ação de escrita: botão ocupado, toast de sucesso, e relê o estado no fim (como o cartão antigo). */
		async function act(btn, label, fn, okMsg) {
			await busy(btn, label, async () => {
				const msg = await fn();
				if (msg !== false) toast(typeof msg === "string" ? msg : okMsg, { kind: "ok" });
			});
			if (!ctx.signal.aborted) await reload();
		}

		/* ── Agendamento ── */
		function scheduleCard() {
			if (S.stError) {
				return card({
					title: "Agendamento",
					pill: pill("erro", "bad"),
					body: errorNotice(S.stError, "o estado da carga")
				});
			}
			const st = S.st;
			const o = M.overall(st);
			const sch = (st && st.schedule) || {};
			const avail = o.available;
			const summary = avail
				? `${st.running ? `Rodada em andamento desde ${dateFmt(st.runningSince)}. ` : ""}${
						st.published
							? `Retrato do Grafana publicado em ${dateFmt(st.published)}.`
							: "Retrato do Grafana ainda não publicado."
					}`
				: o.reason || "";

			const run = h(
				"button",
				{
					type: "button",
					class: "btn btn-primary",
					"data-key": "rodar",
					disabled: !avail || !!st.running
				},
				icon("carga"),
				avail && st.running ? "Rodando…" : "Rodar agora"
			);
			run.addEventListener("click", () =>
				act(run, "Pedindo…", async () => {
					const r = await send("POST", `${BASE}/run`, {});
					S.watchRun = true;
					if (r && r.started === false) {
						toast("Já há uma rodada em andamento.");
						return false;
					}
					return "Rodada iniciada; o estado atualiza ao terminar.";
				})
			);

			const paused = !!sch.paused;
			const pause = h(
				"button",
				{ type: "button", class: "btn", "data-key": "pausar", disabled: !avail },
				paused ? "Retomar" : "Pausar"
			);
			pause.addEventListener("click", () =>
				act(
					pause,
					paused ? "Retomando…" : "Pausando…",
					() => send("POST", `${BASE}/${paused ? "resume" : "pause"}`, {}),
					paused ? "Carga retomada." : "Carga pausada."
				)
			);

			const opts = M.intervalOptions(st);
			const every = field({
				label: "Intervalo",
				name: "every",
				type: "select",
				options: opts.options,
				value: S.every ?? opts.selected,
				attrs: { "data-key": "intervalo", disabled: !avail }
			});
			every.classList.add("cg-every");
			const select = every.querySelector("select");
			select.addEventListener("change", () => {
				S.every = select.value === opts.selected ? null : select.value;
				save.toggleAttribute("data-dirty", S.every !== null);
			});
			const save = h(
				"button",
				{
					type: "button",
					class: "btn",
					"data-key": "salvar-intervalo",
					"data-dirty": S.every !== null ? "" : null,
					disabled: !avail
				},
				"Salvar intervalo"
			);
			save.addEventListener("click", () =>
				act(save, "Salvando…", async () => {
					const value = select.value;
					await send("POST", `${BASE}/schedule`, M.scheduleBody(value));
					S.every = null;
					return value === "" ? "Intervalo de volta ao padrão do .env." : "Intervalo salvo.";
				})
			);

			return card({
				title: "Agendamento",
				pill: avail ? pill(M.scheduleBadge(sch), paused ? "att" : "ok") : pill(o.word),
				body: [
					h(
						"p",
						{ class: "cg-status" },
						lamp(o.lamp, o.word),
						summary ? h("span", { class: "muted", text: summary }) : null
					),
					h(
						"div",
						{ class: "cg-controls" },
						run,
						pause,
						h("span", { class: "cg-every-group" }, every, save)
					),
					avail
						? h(
								"p",
								{ class: "cg-detail faint" },
								M.scheduleDetail(sch, dateFmt),
								paused ? ' Pausada: nada roda sozinho; "Rodar agora" continua valendo.' : null
							)
						: null
				]
			});
		}

		/* ── Estado por fonte ── */
		function sourcesCard() {
			const st = S.st;
			let content;
			if (!M.isAvailable(st)) {
				content = empty(
					S.stError ? "Sem dados: o estado não foi lido." : "Sem dados: a carga não está de pé."
				);
			} else {
				const now = st.now || Date.now();
				content = dataTable(
					[
						{ label: "Fonte", value: (r) => r.name, primary: true },
						{ label: "Dados até", value: (r) => when(r.okTo, now) },
						{ label: "Atraso", num: true, value: (r) => (r.isMain ? M.fmtLag(r.lag) : "—") },
						{ label: "Última tentativa", value: (r) => when(r.lastTs, now) },
						{
							label: "Situação",
							value: (r) =>
								h(
									"span",
									{ class: "cg-sit" },
									pill(...SITUATION[r.state]),
									r.lastError ? h("span", { class: "cg-err", text: r.lastError }) : null
								)
						}
					],
					M.sourceRows(st),
					{ empty: "Nenhuma carga ainda.", caption: "Estado da carga por fonte" }
				);
			}
			return card({ title: "Estado por fonte", body: content });
		}

		/* ── Possíveis mudanças ── */
		function possibleCard() {
			const list = S.possible || [];
			let content;
			if (S.possibleError) content = errorNotice(S.possibleError, "as possíveis mudanças");
			else if (!M.isAvailable(S.st)) content = empty("Sem dados: a carga não está de pé.");
			else if (!list.length) content = empty("Nada a decidir.");
			else content = h("ul", { class: "cg-list" }, list.map(possibleItem));
			return card({
				title: "Possíveis mudanças",
				pill: pill(fmt(list.length), list.length ? "att" : ""),
				body: [
					M.isAvailable(S.st) && list.length
						? note(
								"Detectadas nos dados, sem anotação. Confirme (pode trocar o texto) ou descarte: descartada some do painel, mas fica registrada."
							)
						: null,
					content
				]
			});
		}

		function possibleItem(a) {
			const actions = h("div", { class: "cg-item-actions confirm-bar" });
			const item = h(
				"li",
				{ class: "cg-item" },
				h(
					"div",
					{ class: "cg-item-tx" },
					h("b", { text: a.label }),
					h("span", {
						class: "rw-sub",
						text: `${M.dayFmt(a.ts)} · ${M.currencyName(a.currency)}`
					})
				),
				actions
			);
			const ok = h(
				"button",
				{ type: "button", class: "btn", "data-key": `pm-ok-${a.id}` },
				icon("ok"),
				"Confirmar"
			);
			const no = h(
				"button",
				{ type: "button", class: "btn btn-quiet", "data-key": `pm-no-${a.id}` },
				icon("fechar"),
				"Descartar"
			);
			confirmInline(no, {
				question: "Descartar esta possível mudança?",
				confirmLabel: "Descartar",
				onConfirm: async () => {
					await send("POST", `${BASE}/annotations/decide`, {
						id: Number(a.id),
						decision: "descartada",
						texto: null
					});
					toast("Possível mudança descartada.", { kind: "ok" });
					await reload({ force: true });
				}
			});
			// Confirmar no lugar: campo com o texto (pode trocar), "Não" e "Confirmar mudança".
			confirmInline(ok, {
				question: "Confirmar esta possível mudança?",
				confirmLabel: "Confirmar mudança",
				danger: false,
				content: () =>
					field({
						label: "Texto da mudança (deixe como está ou explique o porquê)",
						name: "texto",
						value: a.label,
						attrs: { maxlength: "300", autocomplete: "off", "data-key": `pm-texto-${a.id}` }
					}),
				onConfirm: async (box) => {
					await send("POST", `${BASE}/annotations/decide`, {
						id: Number(a.id),
						decision: "confirmada",
						texto: box.querySelector("input").value
					});
					toast("Mudança confirmada.", { kind: "ok" });
					await reload({ force: true });
				}
			});
			actions.append(ok, no);
			return item;
		}

		/* ── Registrar mudança (não redesenha: o texto digitado fica) ── */
		function registerCard() {
			const f = form({
				fields: [
					field({
						label: "O que mudou e por quê",
						name: "texto",
						type: "textarea",
						rows: 2,
						required: true,
						wide: true,
						placeholder: "ex.: prêmio do evento dobrado",
						attrs: { maxlength: "300", "data-key": "reg-texto" }
					}),
					field({
						label: "Moeda",
						name: "moeda",
						type: "select",
						options: M.CURRENCY_OPTIONS,
						value: "todas",
						attrs: { "data-key": "reg-moeda" }
					}),
					field({
						label: "Hora em que passou a valer (Brasília)",
						name: "hora",
						type: "datetime-local",
						hint: "Vazio = agora.",
						attrs: { "data-key": "reg-hora" }
					})
				],
				submitLabel: "Registrar mudança",
				busyLabel: "Registrando…",
				onSubmit: async (values, el) => {
					await send("POST", `${BASE}/annotations`, M.annotationBody(values));
					el.reset();
					toast("Mudança registrada.", { kind: "ok" });
					await reload({ possible: false });
				}
			});
			const el = card({
				title: "Registrar mudança",
				body: [
					f,
					note(
						"Use a hora do deploy ou da execução do script. Constantes expostas pelos serviços já entram sozinhas."
					)
				]
			});
			return {
				el,
				setEnabled(on) {
					for (const c of f.elements) c.disabled = !on;
				}
			};
		}

		await reload();
		const stop = poll(() => {
			if (S.loading) return;
			const due = (S.st && S.st.running) || S.watchRun || Date.now() - S.lastFetch >= IDLE_MS;
			if (!due) return;
			S.loading = reload({ possible: false, fromPoll: true }).finally(() => {
				S.loading = null;
			});
			return S.loading;
		}, POLL_MS);
		return stop;
	}
};
