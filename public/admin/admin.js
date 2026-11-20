/*
 * Painel de admin unificado da Ravena (experimental).
 *
 * Reúne as telas de admin que hoje vivem em rotas separadas:
 *   - nativas aqui: Visão geral, Analytics e LLM, Logs (só leituras das rotas /api);
 *   - as demais áreas mostram a tela antiga embutida (iframe com ?embed=1, mesma origem e
 *     mesma sessão), até que cada uma seja migrada. Nada de regra de negócio neste arquivo.
 *
 * Rotas internas por hash: #/<area> ou #/<area>/<aba>.
 */
(() => {
	"use strict";

	/* ── Utilitários de DOM (sempre textContent: nada de HTML vindo da API) ── */

	const SVG_NS = "http://www.w3.org/2000/svg";

	/**
	 * Cria um elemento. props: atributos (class, href, data-*, aria-*...), "text" e "on<evento>".
	 * @param {string} tag
	 * @param {Object} [props]
	 * @param {...(Node|string|null|undefined|false)} children
	 * @returns {HTMLElement}
	 */
	function h(tag, props, ...children) {
		const el = document.createElement(tag);
		for (const [key, value] of Object.entries(props || {})) {
			if (value === undefined || value === null || value === false) continue;
			if (key === "text") el.textContent = String(value);
			else if (key.startsWith("on") && typeof value === "function") {
				el.addEventListener(key.slice(2), value);
			} else el.setAttribute(key, value === true ? "" : String(value));
		}
		for (const child of children.flat()) {
			if (child === undefined || child === null || child === false) continue;
			el.append(child instanceof Node ? child : document.createTextNode(String(child)));
		}
		return el;
	}

	/** Ícones de traço, 14px, herdando a cor do texto. */
	const ICONS = {
		geral: "M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5",
		instancias: "M3 3h10v4H3zM3 9h10v4H3zM5 5h.01M5 11h.01",
		logs: "M2.5 4h11M2.5 8h7M2.5 12h9",
		banco: "M2 6.5 8 3l6 3.5M3.5 7v5M6.5 7v5M9.5 7v5M12.5 7v5M2 13h12",
		eventos: "M3 4h10v9H3zM3 7h10M6 2.5v3M10 2.5v3",
		economia: "M2.5 13V9M6 13V6M9.5 13V8M13 13V3",
		provedores: "M5 5h6v6H5zM7 2.5V5M9 2.5V5M7 11v2.5M9 11v2.5M2.5 7H5M2.5 9H5M11 7h2.5M11 9h2.5",
		analytics: "M2.5 12.5h11M3.5 10l3-3 2 2 4-4.5",
		dossies: "M4 2.5h6l2.5 2.5v8.5H4zM10 2.5V5h2.5M6 8h4.5M6 10.5h4.5",
		legado: "M6.5 3H3v10h10V9.5M9 3h4v4M13 3 7.5 8.5",
		externo: "M6.5 3H3v10h10V9.5M9 3h4v4M13 3 7.5 8.5",
		recarregar: "M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5",
		mais: "M3.5 8h.01M8 8h.01M12.5 8h.01"
	};

	function icon(name) {
		const svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("viewBox", "0 0 16 16");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "1.4");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		svg.setAttribute("aria-hidden", "true");
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttribute("d", ICONS[name] || ICONS.geral);
		svg.append(path);
		return svg;
	}

	/**
	 * Lâmpada de estado: glifo quadrado + palavra. O estado está no data-state
	 * (ok | attention | down | off | busy) e sempre também por escrito.
	 */
	function lamp(state, word) {
		return h(
			"span",
			{ class: "status", "data-state": state },
			h("span", { class: "lamp", "data-state": state, "aria-hidden": "true" }),
			word ? h("span", { class: "state-word", "data-state": state, text: word }) : null
		);
	}

	/* ── Números, plurais e tempo em pt-BR ─────────────────────────── */

	const nf = new Intl.NumberFormat("pt-BR");
	const nf2 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
	const fmt = (n) => (typeof n === "number" && Number.isFinite(n) ? nf.format(n) : "—");
	const fmt2 = (n) => (typeof n === "number" && Number.isFinite(n) ? nf2.format(n) : "—");

	/** plural(2, "instância", "instâncias") → "2 instâncias" */
	const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

	const dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

	/** "há 3 min", "há 46 h", "há 2 d"; "—" sem data */
	function relTime(ts) {
		const n = Number(ts);
		if (!ts || !Number.isFinite(n)) return "—";
		const s = Math.round((Date.now() - n) / 1000);
		if (s < 0) return dateFmt.format(new Date(n));
		if (s < 60) return "agora";
		const m = Math.round(s / 60);
		if (m < 60) return `há ${m} min`;
		const hr = Math.round(m / 60);
		if (hr < 48) return `há ${hr} h`;
		return `há ${Math.round(hr / 24)} d`;
	}

	/* ── Acesso à API: cache curto, sem pedidos repetidos em voo ────── */

	class HttpError extends Error {
		constructor(status, message) {
			super(message);
			this.status = status;
		}
	}

	const API_TTL_MS = 45 * 1000;
	const apiCache = new Map(); // url -> { at, promise }

	/**
	 * GET JSON com cache de 45 s por URL: trocar de área e voltar não refaz as leituras
	 * (o strictLimiter do servidor é de 10/min por IP para quem não é admin).
	 * @param {string} path
	 * @param {{ fresh?: boolean }} [opts] - fresh: ignora o cache (botão Atualizar)
	 */
	function api(path, opts = {}) {
		const hit = apiCache.get(path);
		if (!opts.fresh && hit && Date.now() - hit.at < API_TTL_MS) return hit.promise;
		const promise = fetch(path, {
			credentials: "same-origin",
			headers: { Accept: "application/json" }
		}).then(async (res) => {
			if (!res.ok) {
				if (res.status === 401) showSessionExpired();
				throw new HttpError(res.status, httpReason(res.status));
			}
			return res.json();
		});
		apiCache.set(path, { at: Date.now(), promise });
		// Falhas não ficam no cache: a próxima leitura tenta de novo.
		promise.catch(() => {
			if (apiCache.get(path)?.promise === promise) apiCache.delete(path);
		});
		return promise;
	}

	function httpReason(status) {
		if (status === 401) return "sessão expirada";
		if (status === 403) return "sem permissão";
		if (status === 429) return "limite de requisições, tente em 1 min";
		if (status >= 500) return `erro no servidor (${status})`;
		return `HTTP ${status}`;
	}

	/** Executa várias leituras sem que a falha de uma derrube a tela inteira. */
	async function settle(map) {
		const keys = Object.keys(map);
		const results = await Promise.allSettled(keys.map((k) => map[k]));
		const out = {};
		keys.forEach((k, i) => {
			out[k] = results[i].status === "fulfilled" ? results[i].value : null;
			if (results[i].status === "rejected") out[`${k}Error`] = results[i].reason;
		});
		return out;
	}

	function showSessionExpired() {
		const banner = document.getElementById("session-banner");
		if (banner) banner.hidden = false;
	}

	function errorNotice(err, what) {
		const msg = err && err.message ? err.message : "erro desconhecido";
		return h(
			"div",
			{ class: "notice error", role: "alert" },
			`Não foi possível carregar ${what}: ${msg}.`
		);
	}

	/* ── Peças de layout ─────────────────────────────────────────── */

	/**
	 * Bloco da grade. Com `error`, mostra o motivo por escrito no lugar do número
	 * (nunca um "—" que pareça zero).
	 */
	function cell({ label, value, sub, href, attention, error }) {
		const tag = href ? "a" : "div";
		let valueEl;
		if (error) {
			valueEl = h(
				"span",
				{ class: "value", "data-state": "error" },
				lamp("off", httpReasonOf(error))
			);
		} else {
			valueEl = value instanceof Node ? value : h("span", { class: "value", text: value });
		}
		return h(
			tag,
			{ class: `cell${attention && !error ? " wants-you" : ""}`, href, "data-cell": label },
			h("p", { class: "label", text: label }),
			valueEl,
			sub && !error ? (sub instanceof Node ? sub : h("span", { class: "sub", text: sub })) : null
		);
	}

	const httpReasonOf = (err) => (err && err.message ? err.message : "sem dado");

	function section(title, ...children) {
		return h(
			"section",
			{ class: "section" },
			h(
				"div",
				{ class: "section-head" },
				h("h2", { class: "label", text: title }),
				h("span", { class: "rule", "aria-hidden": "true" })
			),
			...children
		);
	}

	function table(columns, rows) {
		if (!rows.length) return h("div", { class: "empty", text: "Nada para mostrar ainda." });
		return h(
			"div",
			{ class: "table-wrap" },
			h(
				"table",
				null,
				h(
					"thead",
					null,
					h(
						"tr",
						null,
						columns.map((c) =>
							h("th", { scope: "col", class: c.num ? "num" : null, text: c.label })
						)
					)
				),
				h(
					"tbody",
					null,
					rows.map((row) =>
						h(
							"tr",
							null,
							columns.map((c) => {
								const v = c.value(row);
								return h(
									"td",
									{ class: c.num ? "num" : null },
									v instanceof Node ? v : String(v ?? "—")
								);
							})
						)
					)
				)
			)
		);
	}

	/** Tela antiga embutida (?embed=1 esconde o cabeçalho dela), carregada só quando aberta. */
	function embed(src, title) {
		const embedSrc = `${src}${src.includes("?") ? "&" : "?"}embed=1`;
		const frame = h("iframe", { src: embedSrc, title, loading: "lazy" });
		return h(
			"div",
			{ class: "embed", "data-embed": src },
			h(
				"div",
				{ class: "embed-bar" },
				h("span", { class: "tag", text: "tela antiga" }),
				h("code", { text: src }),
				h("span", { class: "spacer" }),
				h(
					"button",
					{
						type: "button",
						class: "btn btn-quiet",
						onclick: () => {
							frame.src = embedSrc;
						}
					},
					icon("recarregar"),
					h("span", { class: "btn-label", text: "Recarregar" })
				),
				h(
					"a",
					{ class: "btn", href: src, target: "_blank", rel: "noopener" },
					icon("externo"),
					h("span", { class: "btn-label", text: "Abrir em nova aba" })
				)
			),
			frame
		);
	}

	/* ── Estados derivados ──────────────────────────────────────── */

	const SERVICE_NAMES = {
		whatsgoapi: "WhatsGo API",
		imagine: "Imagine",
		llm: "LLM",
		whisper: "Whisper (STT)",
		kokorotts: "Kokoro TTS",
		f5tts: "F5 TTS",
		sdwebui: "SD WebUI",
		nudenet: "NudeNet"
	};

	/** "ok" | "down" | "unknown" — "sem dado" é diferente de "fora". */
	function serviceKind(value) {
		const status = typeof value === "object" && value ? value.status : value;
		if (status === "up" || status === "online" || status === "ok") return "ok";
		if (status === "down" || status === "offline") return "down";
		return "unknown";
	}

	const isEventActive = (e) => e.status === "active" || e.status === "running";

	/**
	 * Falhas de LLM só pedem atenção com amostra mínima e taxa alta: um 1 em 3 de madrugada
	 * não acende o âmbar.
	 */
	const LLM_FAIL_MIN_REQUESTS = 20;
	const LLM_FAIL_RATE = 0.1;
	function llmFailing(s) {
		if (!s || !s.total_requests || s.total_requests < LLM_FAIL_MIN_REQUESTS) return false;
		return s.total_failures / s.total_requests > LLM_FAIL_RATE;
	}

	const TIMEFRAMES = [
		{ id: "1h", label: "1 h", ms: 60 * 60 * 1000 },
		{ id: "24h", label: "24 h", ms: 24 * 60 * 60 * 1000 },
		{ id: "7d", label: "7 d", ms: 7 * 24 * 60 * 60 * 1000 },
		{ id: "30d", label: "30 d", ms: 30 * 24 * 60 * 60 * 1000 }
	];

	/* ── Áreas ──────────────────────────────────────────────────── */

	const AREAS = [
		{
			id: "geral",
			group: "Operação",
			title: "Visão geral",
			desc: "O que precisa de você agora e o estado da Ravena num olhar.",
			tabs: [{ id: "resumo", label: "Resumo", render: renderGeral }]
		},
		{
			id: "instancias",
			group: "Operação",
			title: "Instâncias",
			desc: "Bots, pareamento, avisos de status e bots.json.",
			tabs: [{ id: "gestao", label: "Gestão", embed: "/instances" }]
		},
		{
			id: "logs",
			group: "Operação",
			title: "Logs",
			desc: "Saída ao vivo do processo (PM2), pela rota /api/logs.",
			tabs: [{ id: "ao-vivo", label: "Ao vivo", render: renderLogs }]
		},
		{
			id: "banco",
			group: "Jogos e economia",
			title: "Banco",
			desc: "RavenaBank: usuários, transações, configuração e economia.",
			tabs: [{ id: "painel", label: "Painel do banco", embed: "/banco/admin" }]
		},
		{
			id: "eventos",
			group: "Jogos e economia",
			title: "Eventos",
			desc: "Eventos programados com bônus para os jogos.",
			tabs: [{ id: "gestao", label: "Gestão de eventos", embed: "/eventos/admin" }]
		},
		{
			id: "economia",
			group: "Jogos e economia",
			title: "Economia",
			desc: "Painéis do Grafana e, no futuro, os comandos da carga.",
			tabs: [{ id: "resumo", label: "Resumo", render: renderEconomia }]
		},
		{
			id: "provedores",
			group: "IA",
			title: "Provedores de IA",
			desc: "Cadastro de provedores, fila do LLM e custos.",
			tabs: [{ id: "gestao", label: "Gestão de provedores", embed: "/service-providers" }]
		},
		{
			id: "analytics",
			group: "IA",
			title: "Analytics e LLM",
			desc: "Uso de LLM por tipo e provedor, e volume de mensagens.",
			tabs: [{ id: "resumo", label: "Resumo", render: renderAnalytics }]
		},
		{
			id: "dossies",
			group: "Moderação",
			title: "Dossiês",
			desc: "Dossiês de grupos e usuários (RME) e histórico de moderação.",
			tabs: [
				{ id: "painel", label: "Grupos e usuários", embed: "/dossies" },
				{ id: "grupos", label: "Dossiê de grupos", embed: "/groups-dossier" }
			]
		},
		{
			id: "legado",
			group: "Outras telas",
			title: "Telas antigas",
			desc: "Atalhos para as telas que continuam no ar como sempre.",
			tabs: [{ id: "lista", label: "Lista", render: renderLegado }]
		}
	];

	/** "#/provedores" → "Provedores de IA" */
	const areaTitle = (href) => (AREAS.find((a) => `#/${a.id}` === href) || {}).title || "";

	/* Visão geral */
	async function renderGeral(root) {
		const d = await settle({
			bots: api("/api/bots"),
			services: api("/api/services/status"),
			bank: api("/api/games/bank/admin/config"),
			llm: api(`/api/llm/stats?timeframe=${TIMEFRAMES[1].ms}`),
			events: api("/api/events/admin")
		});

		const bots = Array.isArray(d.bots) ? d.bots.filter((b) => b.enabled !== false) : [];
		const offline = bots.filter((b) => !b.connected);
		const services = Object.entries(d.services || {});
		const svcDown = services.filter(([, v]) => serviceKind(v) === "down");
		const svcUnknown = services.filter(([, v]) => serviceKind(v) === "unknown");
		const bank = d.bank && d.bank.data;
		const llm = d.llm || {};
		const events = (d.events && d.events.events) || [];
		const active = events.filter(isEventActive);

		/* Precisa de você: só o que pede ação, cada item leva à área. */
		const needs = [];
		for (const b of offline) {
			needs.push({
				state: b.isLive ? "attention" : "down",
				what: `Instância ${b.nomeExibir || b.nome} ${b.isLive ? "desconectada" : "parada"}`,
				detail: `Última msg: ${relTime(b.lastMessageReceived)}`,
				href: "#/instancias"
			});
		}
		// Mais de 3 serviços fora viram uma linha só (no celular, 8 linhas iguais empurram o resto).
		const svcName = ([k]) => SERVICE_NAMES[k] || k;
		if (svcDown.length > 3) {
			needs.push({
				state: "down",
				what: `${svcDown.length} de ${services.length} serviços fora do ar`,
				detail: svcDown.map(svcName).join(", "),
				href: "#/provedores"
			});
		} else {
			for (const entry of svcDown) {
				needs.push({ state: "down", what: `${svcName(entry)} fora do ar`, href: "#/provedores" });
			}
		}
		if (llmFailing(llm)) {
			needs.push({
				state: "attention",
				what: "LLM com muitas falhas",
				detail: `${plural(llm.total_failures, "falha", "falhas")} em ${plural(llm.total_requests, "requisição", "requisições")} nas últimas 24 h`,
				href: "#/analytics"
			});
		}
		for (const e of active) {
			needs.push({
				state: "busy",
				what: `Evento ativo: ${e.name}`,
				detail: e.endFormatted ? `termina ${e.endFormatted}` : null,
				href: "#/eventos"
			});
		}
		if (svcUnknown.length > 3) {
			needs.push({
				state: "off",
				what: `${svcUnknown.length} serviços sem dado`,
				detail: svcUnknown.map(svcName).join(", "),
				href: "#/provedores"
			});
		} else {
			for (const entry of svcUnknown) {
				needs.push({ state: "off", what: `${svcName(entry)}: sem dado`, href: "#/provedores" });
			}
		}

		const errors = [d.botsError, d.servicesError, d.eventsError].filter(Boolean);
		root.append(
			section(
				"Precisa de você",
				errors.length ? errorNotice(errors[0], "parte do estado") : null,
				needs.length
					? h(
							"ul",
							{ class: "needs", "data-needs": String(needs.length) },
							needs.map((n) =>
								h(
									"li",
									{ "data-state": n.state },
									h(
										"a",
										{ href: n.href },
										h("span", {
											class: "lamp",
											"data-state": n.state,
											"aria-hidden": "true"
										}),
										h("span", { class: "what", text: n.what }),
										h("span", { class: "where", text: areaTitle(n.href) }),
										n.detail ? h("span", { class: "detail", text: n.detail }) : null
									)
								)
							)
						)
					: errors.length
						? null
						: h(
								"div",
								{ class: "needs-empty", "data-needs": "0" },
								lamp("ok"),
								"Nada pede sua atenção agora."
							)
			),
			section(
				"Estado",
				h(
					"div",
					{ class: "grid" },
					cell({
						label: "Instâncias",
						value: `${bots.length - offline.length}/${bots.length}`,
						sub: "conectadas / ativas",
						href: "#/instancias",
						attention: offline.length > 0,
						error: d.botsError
					}),
					cell({
						label: "Serviços",
						value: `${services.length - svcDown.length - svcUnknown.length}/${services.length}`,
						sub: svcUnknown.length
							? `no ar · ${plural(svcUnknown.length, "sem dado", "sem dado")}`
							: "no ar",
						href: "#/provedores",
						attention: svcDown.length > 0,
						error: d.servicesError
					}),
					cell({
						label: "Runas em circulação",
						value: bank ? fmt2(bank.totalRunas) : "—",
						sub: bank ? plural(bank.totalAccounts, "conta", "contas") : null,
						href: "#/banco",
						error: d.bankError
					}),
					cell({
						label: "LLM · 24 h",
						value: fmt(llm.total_requests),
						sub: plural(llm.total_failures || 0, "falha", "falhas"),
						href: "#/analytics",
						attention: llmFailing(llm),
						error: d.llmError
					}),
					cell({
						label: "Eventos ativos",
						value: fmt(active.length),
						sub: `de ${plural(events.length, "evento", "eventos")}`,
						href: "#/eventos",
						error: d.eventsError
					})
				)
			)
		);
	}

	/* Logs (SSE) */
	function renderLogs(root) {
		const MAX_LINES = 2000; // na tela
		const MAX_PENDING = 2000; // guardadas durante a pausa
		const out = h("pre", { class: "log", "aria-live": "off", "aria-label": "Saída de log" });
		const state = h("span", { class: "status" });
		const dropped = h("span", { class: "faint", "aria-live": "polite" });
		const filter = h("input", {
			type: "search",
			placeholder: "filtrar",
			"aria-label": "Filtrar linhas"
		});
		let paused = false;
		let source = null;
		let droppedCount = 0;
		const pending = [];

		const setState = (s, word) => state.replaceChildren(lamp(s, word));

		function appendLine(text) {
			const isErr = text.startsWith("[ERROR]");
			const line = h("span", { class: isErr ? "err" : null, text: `${text}\n` });
			const q = filter.value.trim().toLowerCase();
			if (q && !text.toLowerCase().includes(q)) line.hidden = true;
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

		function connect() {
			if (source) source.close();
			setState("busy", "conectando");
			source = new EventSource("/api/logs");
			source.onopen = () => setState("ok", "ao vivo");
			source.onmessage = (ev) => onData(ev.data);
			source.onerror = () => {
				if (source && source.readyState !== EventSource.CLOSED) {
					setState("down", "sem conexão (tenta de novo sozinho)");
				}
			};
			// O servidor avisa quando não há pm2 no ambiente: para de reconectar.
			source.addEventListener("unavailable", () => {
				source.close();
				setState("off", "indisponível neste ambiente");
			});
		}

		const pauseBtn = h("button", {
			type: "button",
			class: "btn",
			"aria-pressed": "false",
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
			const q = filter.value.trim().toLowerCase();
			for (const line of out.children) {
				line.hidden = q ? !line.textContent.toLowerCase().includes(q) : false;
			}
		});

		root.append(
			h(
				"div",
				{ class: "toolbar" },
				state,
				dropped,
				h("span", { class: "spacer" }),
				h("label", { class: "field" }, filter),
				pauseBtn,
				h("button", {
					type: "button",
					class: "btn",
					text: "Limpar",
					onclick: () => out.replaceChildren()
				}),
				h("button", { type: "button", class: "btn", text: "Reconectar", onclick: connect })
			),
			out
		);
		connect();
		return () => source && source.close();
	}

	/* Economia */
	const GRAFANA_KEY = "ravena-admin-grafana-url";

	function renderEconomia(root) {
		let saved = "";
		try {
			saved = localStorage.getItem(GRAFANA_KEY) || "";
		} catch {
			saved = "";
		}
		const input = h("input", {
			id: "grafana-url",
			type: "url",
			placeholder: "https://grafana.exemplo/d/economia",
			value: saved,
			spellcheck: "false"
		});
		const open = h(
			"a",
			{ class: "btn", target: "_blank", rel: "noopener" },
			icon("externo"),
			"Abrir no Grafana"
		);

		const sync = () => {
			const url = input.value.trim();
			const valid = /^https?:\/\//i.test(url);
			if (valid) {
				open.setAttribute("href", url);
				open.removeAttribute("aria-disabled");
			} else {
				open.removeAttribute("href");
				open.setAttribute("aria-disabled", "true");
			}
			try {
				if (valid) localStorage.setItem(GRAFANA_KEY, url);
			} catch {
				/* sem armazenamento: só não lembra */
			}
		};
		input.addEventListener("input", sync);
		sync();

		root.append(
			section(
				"Grafana",
				h(
					"div",
					{ class: "form-row" },
					h("label", { for: "grafana-url", text: "Endereço do painel" }),
					h("span", { class: "field" }, input),
					open
				),
				h(
					"p",
					{ class: "muted" },
					"O painel de economia fica no Grafana. O endereço é guardado só neste navegador; quando houver um endereço fixo de produção, ele pode vir do servidor."
				)
			),
			section(
				"Comandos da carga",
				h(
					"div",
					{ class: "empty", "data-placeholder": "carga" },
					h("p", {
						style: "margin:0 0 0.375rem",
						text: "Ainda não há rotas na API para os comandos da carga."
					}),
					h(
						"p",
						{ class: "faint", style: "margin:0" },
						"Quando existirem, aparecem aqui com o estado da última execução e um botão por comando, sempre com confirmação."
					)
				)
			)
		);
	}

	/* Analytics e LLM */
	let currentTimeframe = "24h";

	async function renderAnalytics(root) {
		const tf = TIMEFRAMES.find((t) => t.id === currentTimeframe) || TIMEFRAMES[1];
		const seg = h(
			"div",
			{ class: "seg", role: "group", "aria-label": "Período" },
			TIMEFRAMES.map((t) =>
				h("button", {
					type: "button",
					"aria-pressed": String(t.id === tf.id),
					"data-timeframe": t.id,
					text: t.label,
					onclick: () => {
						currentTimeframe = t.id;
						router.render({ focusSelector: `[data-timeframe="${t.id}"]` });
					}
				})
			)
		);
		root.append(
			h("div", { class: "toolbar" }, h("span", { class: "label", text: "Período" }), seg)
		);

		const d = await settle({
			llm: api(`/api/llm/stats?timeframe=${tf.ms}`),
			analytics: api("/analytics?period=today")
		});
		if (d.llmError) {
			root.append(errorNotice(d.llmError, "as métricas de LLM"));
			return;
		}
		const s = d.llm || {};
		const daily =
			d.analytics && d.analytics.daily && d.analytics.daily.series && d.analytics.daily.series[0];
		const msgsHoje =
			daily && Array.isArray(daily.data)
				? daily.data.reduce((a, b) => a + (Number(b) || 0), 0)
				: null;
		const failRate = s.total_requests ? (s.total_failures / s.total_requests) * 100 : 0;

		root.append(
			h(
				"div",
				{ class: "grid" },
				cell({ label: "Requisições", value: fmt(s.total_requests) }),
				cell({
					label: "Falhas",
					value: fmt(s.total_failures),
					sub: s.total_requests ? `${fmt2(failRate)} % das requisições` : null,
					attention: llmFailing(s)
				}),
				cell({ label: "Tokens de entrada", value: fmt(s.total_input_tokens) }),
				cell({ label: "Tokens de saída", value: fmt(s.total_output_tokens) }),
				cell({ label: "Externas", value: fmt(s.external_requests) }),
				cell({
					label: "Msgs hoje",
					value: msgsHoje === null ? "—" : fmt(Math.round(msgsHoje)),
					sub: "soma das médias por hora",
					error: d.analyticsError
				})
			),
			section(
				"Por tipo",
				table(
					[
						{ label: "Tipo", value: ([k]) => k },
						{ label: "Req.", num: true, value: ([, v]) => fmt(v.requests) },
						{ label: "Falhas", num: true, value: ([, v]) => fmt(v.failures) },
						{ label: "Entrada", num: true, value: ([, v]) => fmt(v.input_tokens) },
						{ label: "Saída", num: true, value: ([, v]) => fmt(v.output_tokens) },
						{ label: "Externas", num: true, value: ([, v]) => fmt(v.external) }
					],
					Object.entries(s.by_type || {})
				)
			),
			section(
				"Por provedor",
				table(
					[
						{ label: "Provedor", value: ([k]) => k },
						{ label: "Req.", num: true, value: ([, v]) => fmt(v.requests) },
						{ label: "Falhas", num: true, value: ([, v]) => fmt(v.failures) },
						{ label: "Entrada", num: true, value: ([, v]) => fmt(v.input_tokens) },
						{ label: "Saída", num: true, value: ([, v]) => fmt(v.output_tokens) }
					],
					Object.entries(s.by_provider || {})
				)
			),
			h(
				"p",
				{ class: "muted" },
				"Relatório completo (JSON): ",
				h("a", { href: "/llm-stats", target: "_blank", rel: "noopener", text: "/llm-stats" }),
				" · gráficos de uso: app Analytics no ",
				h("a", { href: "/?admin", target: "_blank", rel: "noopener", text: "Desktop OS" }),
				"."
			)
		);
	}

	/* Telas antigas */
	function renderLegado(root) {
		const links = [
			["/?admin", "Desktop OS (modo admin)", "A interface de janelas, com todos os apps."],
			["/instances", "Gestão de instâncias", "Bots, pareamento, avisos de status e bots.json."],
			["/banco/admin", "Painel do RavenaBank", "Usuários, transações, configuração e economia."],
			["/eventos/admin", "Eventos programados", "Criar, editar e excluir eventos."],
			["/service-providers", "Provedores de IA", "Cadastro de provedores, fila e custos."],
			["/dossies", "Dossiês (RME)", "Grupos e usuários."],
			["/groups-dossier", "Dossiê de grupos", "Visão antiga dos grupos."],
			["/classic", "Dashboard clássico", "A primeira versão do painel."],
			["/status", "Status público", "A página que os usuários veem."],
			["/docs", "Documentação da API", "Rotas e exemplos."]
		];
		root.append(
			h(
				"ul",
				{ class: "cmd-list" },
				links.map(([href, title, desc]) =>
					h(
						"li",
						null,
						h("a", { href, target: "_blank", rel: "noopener" }, title),
						h("code", { class: "faint", text: href }),
						h("span", { class: "desc", text: desc })
					)
				)
			)
		);
	}

	/* ── Navegação lateral ───────────────────────────────────────── */

	function buildSidebar() {
		const nav = document.getElementById("sidebar");
		const groups = new Map();
		for (const area of AREAS) {
			if (!groups.has(area.group)) groups.set(area.group, []);
			groups.get(area.group).push(area);
		}
		for (const [group, areas] of groups) {
			nav.append(
				h(
					"div",
					{ class: "nav-group" },
					h("p", { class: "label", text: group }),
					h(
						"ul",
						{ class: "nav-list" },
						areas.map((a) =>
							h(
								"li",
								null,
								h(
									"a",
									{ class: "nav-item", href: `#/${a.id}`, "data-area": a.id },
									icon(a.id),
									h("span", { class: "nav-text", text: a.title }),
									a.tabs.every((t) => t.embed)
										? h("span", { class: "nav-meta", text: "antiga" })
										: null
								)
							)
						)
					)
				)
			);
		}
	}

	/* ── Barra inferior (celular) ─────────────────────────────────── */

	/** As áreas do uso no celular (caiu? reinicia, olha o log, banco); o resto fica em "Mais". */
	const PRIMARY_AREAS = ["geral", "instancias", "logs", "banco"];
	const SHORT_TITLE = { geral: "Geral" };

	function buildBottomNav() {
		const sheet = document.getElementById("more-sheet");
		const bar = h(
			"nav",
			{ class: "bottombar", id: "bottombar", "aria-label": "Áreas principais" },
			PRIMARY_AREAS.map((id) => {
				const a = AREAS.find((x) => x.id === id);
				return h(
					"a",
					{ class: "bottom-item", href: `#/${a.id}`, "data-area": a.id },
					icon(a.id),
					h("span", { class: "bottom-text", text: SHORT_TITLE[a.id] || a.title }),
					h("span", { class: "bottom-badge", hidden: true })
				);
			}),
			h(
				"button",
				{
					type: "button",
					class: "bottom-item",
					id: "more-open",
					"aria-haspopup": "dialog",
					"aria-controls": "more-sheet",
					onclick: () => sheet.showModal()
				},
				icon("mais"),
				h("span", { class: "bottom-text", text: "Mais" })
			)
		);
		document.body.append(bar);

		const others = AREAS.filter((a) => !PRIMARY_AREAS.includes(a.id));
		sheet
			.querySelector(".sheet-areas")
			.append(
				...others.map((a) =>
					h(
						"li",
						null,
						h(
							"a",
							{ class: "sheet-item", href: `#/${a.id}`, "data-area": a.id },
							icon(a.id),
							h("span", { text: a.title }),
							a.tabs.every((t) => t.embed) ? h("span", { class: "nav-meta", text: "antiga" }) : null
						)
					)
				)
			);
		// Escolheu uma área ou tocou fora da folha: fecha.
		sheet.addEventListener("click", (ev) => {
			if (
				ev.target === sheet ||
				(ev.target instanceof Element && ev.target.closest("a[href^='#/']"))
			) {
				sheet.close();
			}
		});
	}

	/* ── Abas compactas (padrão de tablist com setas) ─────────────── */

	function buildTabs(area, activeTab) {
		if (area.tabs.length < 2) return null;
		const list = h("div", {
			class: "tabs",
			role: "tablist",
			"aria-label": `Seções de ${area.title}`
		});
		area.tabs.forEach((t) => {
			const selected = t.id === activeTab.id;
			list.append(
				h(
					"button",
					{
						type: "button",
						class: "tab",
						role: "tab",
						id: `tab-${t.id}`,
						"data-tab": t.id,
						"aria-selected": String(selected),
						"aria-controls": "view-body",
						tabindex: selected ? "0" : "-1",
						onclick: () => {
							location.hash = `#/${area.id}/${t.id}`;
						}
					},
					t.embed ? icon("legado") : null,
					t.label
				)
			);
		});
		list.addEventListener("keydown", (ev) => {
			const tabs = [...list.querySelectorAll('[role="tab"]')];
			const i = tabs.indexOf(document.activeElement);
			if (i < 0) return;
			let next = null;
			if (ev.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
			else if (ev.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
			else if (ev.key === "Home") next = tabs[0];
			else if (ev.key === "End") next = tabs[tabs.length - 1];
			if (next) {
				ev.preventDefault();
				next.click();
			}
		});
		return list;
	}

	/* ── Roteador por hash ───────────────────────────────────────── */

	const router = {
		cleanup: null,
		token: 0,
		areaId: null,
		parse() {
			const [areaId, tabId] = location.hash.replace(/^#\/?/, "").split("/");
			const area = AREAS.find((a) => a.id === areaId) || AREAS[0];
			const tab = area.tabs.find((t) => t.id === tabId) || area.tabs[0];
			return { area, tab };
		},
		/**
		 * @param {{ focusMain?: boolean, focusSelector?: string }} [opts]
		 *   focusMain: a área mudou, o foco vai para o conteúdo;
		 *   focusSelector: o foco volta para este controle depois de redesenhar (aba, período).
		 */
		async render(opts = {}) {
			const { area, tab } = this.parse();
			const token = ++this.token;
			if (typeof this.cleanup === "function") this.cleanup();
			this.cleanup = null;
			this.areaId = area.id;

			document.body.dataset.view = tab.embed ? "embed" : area.id;
			document.querySelectorAll(".nav-item, .bottom-item[data-area], .sheet-item").forEach((a) => {
				if (a.dataset.area === area.id) {
					a.setAttribute("aria-current", "page");
					if (a.classList.contains("nav-item"))
						a.scrollIntoView({ block: "nearest", inline: "nearest" });
				} else a.removeAttribute("aria-current");
			});
			document.title = `${area.title} · Ravena Admin`;
			const more = document.getElementById("more-open");
			if (more) {
				if (PRIMARY_AREAS.includes(area.id)) more.removeAttribute("aria-current");
				else more.setAttribute("aria-current", "page");
			}

			const main = document.getElementById("main");
			const multi = area.tabs.length > 1;
			const body = h("div", {
				id: "view-body",
				role: multi ? "tabpanel" : null,
				"aria-labelledby": multi ? `tab-${tab.id}` : null,
				"data-view": `${area.id}/${tab.id}`,
				"aria-busy": "true"
			});
			main.replaceChildren(
				h(
					"div",
					{ class: "view-head" },
					h(
						"div",
						null,
						h("h1", { class: "view-title", text: area.title }),
						h("p", { class: "view-desc", text: area.desc })
					),
					h("span", { class: "spacer" }),
					buildTabs(area, tab)
				),
				body
			);
			if (opts.focusMain) main.focus({ preventScroll: true });
			const refocus = () => {
				if (!opts.focusSelector) return;
				const el = main.querySelector(opts.focusSelector);
				if (el) el.focus();
			};
			refocus();

			if (tab.embed) {
				body.append(embed(tab.embed, `${area.title}: ${tab.label}`));
				body.removeAttribute("aria-busy");
				return;
			}
			body.append(h("p", { class: "muted", "data-loading": "", text: "Carregando…" }));
			try {
				const holder = h("div");
				const cleanup = await tab.render(holder);
				if (token !== this.token) {
					if (typeof cleanup === "function") cleanup();
					return;
				}
				this.cleanup = cleanup;
				body.replaceChildren(...holder.childNodes);
				refocus();
			} catch (err) {
				if (token !== this.token) return;
				body.replaceChildren(errorNotice(err, area.title.toLowerCase()));
			}
			body.removeAttribute("aria-busy");
		}
	};

	window.addEventListener("hashchange", () => {
		const { area, tab } = router.parse();
		if (area.id !== router.areaId) router.render({ focusMain: true });
		else router.render({ focusSelector: `[data-tab="${tab.id}"]` });
	});

	/* ── Resumo da barra do topo ─────────────────────────────────── */

	function summaryItem(state, count, word, href) {
		return h(
			"a",
			{ class: "summary-item", href, "data-summary": state },
			h("span", { class: "lamp", "data-state": state, "aria-hidden": "true" }),
			h("span", { class: "count", text: fmt(count) }),
			h("span", { class: "word", text: word })
		);
	}

	async function refreshSummary() {
		const el = document.getElementById("topbar-summary");
		const d = await settle({ bots: api("/api/bots"), services: api("/api/services/status") });
		const parts = [];
		if (d.bots) {
			const bots = d.bots.filter((b) => b.enabled !== false);
			const off = bots.filter((b) => !b.connected).length;
			const badge = document.querySelector('.bottom-item[data-area="instancias"] .bottom-badge');
			if (badge) {
				badge.hidden = !off;
				badge.textContent = off ? fmt(off) : "";
				badge.setAttribute("aria-label", off ? `${off} fora` : "");
			}
			parts.push(
				off
					? summaryItem(
							"attention",
							off,
							off === 1 ? "instância fora" : "instâncias fora",
							"#/instancias"
						)
					: summaryItem(
							"ok",
							bots.length,
							bots.length === 1 ? "instância ok" : "instâncias ok",
							"#/instancias"
						)
			);
		}
		if (d.services) {
			const entries = Object.values(d.services);
			const down = entries.filter((v) => serviceKind(v) === "down").length;
			const unknown = entries.filter((v) => serviceKind(v) === "unknown").length;
			if (down) {
				parts.push(
					summaryItem("down", down, down === 1 ? "serviço fora" : "serviços fora", "#/provedores")
				);
			}
			if (unknown) parts.push(summaryItem("off", unknown, "sem dado", "#/provedores"));
			if (!down && !unknown) {
				parts.push(summaryItem("ok", entries.length, "serviços ok", "#/provedores"));
			}
		}
		el.replaceChildren(...parts);
	}

	/** Atualiza o resumo a cada minuto, só com a aba visível. */
	function startSummary() {
		const tick = () => {
			if (!document.hidden) refreshSummary().catch(() => {});
		};
		tick();
		setInterval(tick, 60000);
		document.addEventListener("visibilitychange", tick);
	}

	/* ── Tema (auto | claro | escuro) ────────────────────────────── */

	const THEME_KEY = "ravena-admin-theme";
	const THEMES = ["auto", "light", "dark"];
	const THEME_LABEL = { auto: "Auto", light: "Claro", dark: "Escuro" };
	const validTheme = (t) => (THEMES.includes(t) ? t : null);
	let theme = "auto";

	function applyTheme(choice, { save = true } = {}) {
		theme = validTheme(choice) || "auto";
		if (theme === "auto") delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = theme;
		document.querySelectorAll("[data-theme-choice]").forEach((b) => {
			b.setAttribute("aria-pressed", String(b.dataset.themeChoice === theme));
		});
		for (const id of ["theme-cycle", "theme-cycle-sheet"]) {
			const cycle = document.getElementById(id);
			if (cycle) cycle.textContent = `Tema: ${THEME_LABEL[theme]}`;
		}
		if (!save) return;
		try {
			if (theme === "auto") localStorage.removeItem(THEME_KEY);
			else localStorage.setItem(THEME_KEY, theme);
		} catch {
			/* sem armazenamento: vale só nesta visita */
		}
	}

	function initTheme() {
		// ?theme= vale só nesta visita (não sobrescreve a escolha salva)
		const fromUrl = validTheme(new URLSearchParams(location.search).get("theme"));
		let saved = null;
		try {
			saved = validTheme(localStorage.getItem(THEME_KEY));
		} catch {
			saved = null;
		}
		applyTheme(fromUrl || saved || "auto", { save: false });
		document.getElementById("theme-switch").addEventListener("click", (ev) => {
			const btn = ev.target.closest("[data-theme-choice]");
			if (btn) applyTheme(btn.dataset.themeChoice);
		});
		for (const id of ["theme-cycle", "theme-cycle-sheet"]) {
			const btn = document.getElementById(id);
			if (btn) {
				btn.addEventListener("click", () => {
					applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]);
				});
			}
		}
	}

	/* ── Início ─────────────────────────────────────────────────── */

	// Entrou por ?auth=…: o cookie de sessão já foi criado, então tira a credencial da barra
	// de endereço (não fica no histórico, em favoritos nem em capturas de tela).
	(() => {
		const params = new URLSearchParams(location.search);
		if (!params.has("auth")) return;
		params.delete("auth");
		const qs = params.toString();
		history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
	})();

	initTheme();
	buildSidebar();
	buildBottomNav();
	router.render();
	startSummary();
})();
