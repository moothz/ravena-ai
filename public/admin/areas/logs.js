/*
 * Logs ao vivo do processo (PM2), pela rota SSE /api/logs.
 * #/logs/<texto> já abre filtrado (a área Instâncias usa #/logs/<id da instância>); trocar o
 * filtro pela barra de endereço não reconecta o stream (update()).
 */

import { h, api, lamp, plural, buildHash } from "../core.js";

const MAX_LINES = 2000; // na tela
const MAX_PENDING = 2000; // guardadas durante a pausa
const RETRY_MIN_MS = 2000; // reconexão depois que o EventSource desiste (CLOSED)
const RETRY_MAX_MS = 60000;

let live = null; // estado da tela aberta (para o update)

export default {
	id: "logs",
	group: "Operação",
	title: "Logs",
	desc: "Saída ao vivo do processo (PM2), de todas as instâncias.",
	layout: "fill",
	summary: () => ({ text: "ao vivo, de todas as instâncias" }),

	render(root, ctx) {
		const out = h("pre", {
			class: "log",
			role: "log",
			"aria-live": "off",
			"aria-label": "Saída de log",
			tabindex: "0"
		});
		const state = h("span", { class: "log-state" });
		const dropped = h("span", { class: "faint", "aria-live": "polite" });
		const filter = h("input", {
			id: "log-filter",
			type: "search",
			placeholder: "ex.: ravena-principal ou ERROR",
			"data-key": "log-filter",
			autocomplete: "off",
			spellcheck: "false"
		});
		filter.value = ctx.segs[0] || "";
		let paused = false;
		let source = null;
		let retryTimer = null;
		let retryMs = RETRY_MIN_MS;
		let stopped = false;
		let droppedCount = 0;
		const pending = [];

		const setState = (s, word) => state.replaceChildren(lamp(s, word));
		const matches = (text) => {
			const q = filter.value.trim().toLowerCase();
			return !q || text.toLowerCase().includes(q);
		};

		function appendLine(text) {
			const kind = /\[ERROR\]|\bERROR\b/.test(text)
				? "err"
				: /\[WARN\]|\bWARN\b/.test(text)
					? "warn"
					: null;
			const line = h("span", { class: kind, text: `${text}\n` });
			if (!matches(text)) line.hidden = true;
			out.append(line);
			while (out.childNodes.length > MAX_LINES) out.firstChild.remove();
		}

		function onData(text) {
			const lines = text.split("\n").filter((l) => l.length);
			if (paused) {
				pending.push(...lines);
				if (pending.length > MAX_PENDING) {
					droppedCount += pending.length - MAX_PENDING;
					pending.splice(0, pending.length - MAX_PENDING);
					dropped.textContent = `${plural(droppedCount, "linha descartada", "linhas descartadas")} durante a pausa`;
				}
				return;
			}
			const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 24;
			lines.forEach(appendLine);
			if (stick) out.scrollTop = out.scrollHeight;
		}

		/**
		 * O EventSource foi a CLOSED (resposta não-200, ex. 502 do proxy no reinício ou 401) e não
		 * tenta mais sozinho. Confere a sessão (um 401 mostra a faixa "entre de novo" e para) e,
		 * fora isso, reconecta com espera crescente (2 s, 4 s… até 1 min).
		 */
		async function onClosed(es) {
			if (stopped || es !== source) return;
			source = null;
			let expired = false;
			try {
				await api("/api/admin/links", { fresh: true });
			} catch (err) {
				expired = !!err && err.status === 401;
			}
			if (stopped) return;
			if (expired) {
				setState("down", "sessão expirada: entre de novo");
				return;
			}
			const secs = Math.round(retryMs / 1000);
			setState("down", `desconectado (tenta de novo em ${secs} s)`);
			clearTimeout(retryTimer);
			retryTimer = setTimeout(connect, retryMs);
			retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
		}

		function connect() {
			if (stopped) return;
			clearTimeout(retryTimer);
			retryTimer = null;
			if (source) source.close();
			setState("busy", "conectando");
			const es = new EventSource("/api/logs");
			source = es;
			es.onopen = () => {
				retryMs = RETRY_MIN_MS;
				setState("ok", "ao vivo");
			};
			es.onmessage = (ev) => onData(ev.data);
			es.onerror = () => {
				if (es !== source) return;
				if (es.readyState === EventSource.CLOSED) onClosed(es);
				else setState("down", "sem conexão (tenta de novo sozinho)");
			};
			// O servidor avisa quando não há pm2 no ambiente: para de reconectar.
			es.addEventListener("unavailable", () => {
				es.close();
				if (es === source) source = null;
				setState("off", "indisponível neste ambiente");
			});
		}

		const applyFilter = () => {
			for (const line of out.children) line.hidden = !matches(line.textContent);
		};

		const pauseBtn = h("button", {
			type: "button",
			class: "btn",
			"aria-pressed": "false",
			"data-key": "log-pause",
			text: "Pausar",
			onclick: () => {
				paused = !paused;
				pauseBtn.setAttribute("aria-pressed", String(paused));
				pauseBtn.textContent = paused ? "Continuar" : "Pausar";
				if (!paused) {
					const lines = pending.splice(0);
					droppedCount = 0;
					dropped.textContent = "";
					lines.forEach(appendLine);
					out.scrollTop = out.scrollHeight;
				}
			}
		});

		filter.addEventListener("input", () => {
			applyFilter();
			// O filtro fica no endereço (dá para voltar e compartilhar), sem redesenhar a tela.
			const q = filter.value.trim();
			const hash = q ? buildHash("logs", [q]) : "#/logs";
			if (location.hash !== hash) history.replaceState(null, "", hash);
		});

		ctx.head.append(state, dropped);
		root.append(
			h(
				"div",
				{ class: "toolbar" },
				h(
					"label",
					{ class: "fld-inline", for: "log-filter" },
					h("span", { text: "Filtrar" }),
					h("span", { class: "field" }, filter)
				),
				h("span", { class: "spacer" }),
				pauseBtn,
				h("button", {
					type: "button",
					class: "btn",
					text: "Limpar",
					onclick: () => out.replaceChildren()
				}),
				h("button", {
					type: "button",
					class: "btn",
					text: "Reconectar",
					onclick: () => {
						retryMs = RETRY_MIN_MS;
						connect();
					}
				})
			),
			out
		);
		connect();
		live = { filter, applyFilter };
		return () => {
			stopped = true;
			clearTimeout(retryTimer);
			if (source) source.close();
			source = null;
			live = null;
		};
	},

	/** Mudou só o filtro no endereço: aplica sem reconectar. */
	update(ctx) {
		if (!live) return false;
		const q = ctx.segs[0] || "";
		if (live.filter.value.trim() !== q) {
			live.filter.value = q;
			live.applyFilter();
		}
		return true;
	}
};
