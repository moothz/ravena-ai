/*
 * Painel de admin unificado da Ravena (experimental).
 *
 * Reúne as telas de admin que hoje vivem em rotas separadas. Cada área tem:
 *   - um "Resumo" montado aqui, só com leituras das rotas /api já existentes;
 *   - a tela antiga embutida (iframe, mesma origem e mesma sessão de admin),
 *     até que a área seja reescrita aqui de forma progressiva.
 * Nenhuma regra de negócio mora neste arquivo: ele só lê e mostra.
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
		recarregar: "M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5"
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
			h("span", { class: "state-word", "data-state": state, text: word })
		);
	}

	const nf = new Intl.NumberFormat("pt-BR");
	const nf2 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
	const fmt = (n) => (typeof n === "number" && Number.isFinite(n) ? nf.format(n) : "–");
	const fmt2 = (n) => (typeof n === "number" && Number.isFinite(n) ? nf2.format(n) : "–");

	function relTime(ts) {
		if (!ts) return "–";
		const diff = Date.now() - Number(ts);
		if (!Number.isFinite(diff)) return "–";
		const s = Math.round(diff / 1000);
		if (s < 60) return "agora";
		const m = Math.round(s / 60);
		if (m < 60) return `${m} min`;
		const hr = Math.round(m / 60);
		if (hr < 48) return `${hr} h`;
		return `${Math.round(hr / 24)} d`;
	}

	/** Mostra só o fim de um número de telefone (nunca o ID inteiro na tela). */
	function maskNumber(num) {
		const digits = String(num || "").replace(/\D/g, "");
		if (!digits) return "–";
		return `…${digits.slice(-4)}`;
	}

	/* ── Acesso à API ───────────────────────────────────────────── */

	class HttpError extends Error {
		constructor(status, message) {
			super(message);
			this.status = status;
		}
	}

	async function api(path) {
		const res = await fetch(path, {
			credentials: "same-origin",
			headers: { Accept: "application/json" }
		});
		if (!res.ok) {
			throw new HttpError(
				res.status,
				res.status === 401 ? "Sessão de admin expirada." : `HTTP ${res.status}`
			);
		}
		return res.json();
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

	function errorNotice(err, what) {
		const msg = err && err.message ? err.message : "erro desconhecido";
		const notice = h(
			"div",
			{ class: "notice error", role: "alert" },
			`Não foi possível carregar ${what}: ${msg}`
		);
		if (err && err.status === 401) {
			notice.append(" ", h("a", { href: "/admin", text: "Entrar de novo" }));
		}
		return notice;
	}

	/* ── Peças de layout ─────────────────────────────────────────── */

	function cell({ label, value, sub, href, attention }) {
		const tag = href ? "a" : "div";
		return h(
			tag,
			{ class: `cell${attention ? " wants-you" : ""}`, href },
			h("p", { class: "label", text: label }),
			value instanceof Node ? value : h("span", { class: "value", text: value }),
			sub ? (sub instanceof Node ? sub : h("span", { class: "sub", text: sub })) : null
		);
	}

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

	function table(columns, rows, caption) {
		if (!rows.length) return h("div", { class: "empty", text: "Nada para mostrar ainda." });
		return h(
			"div",
			{ class: "table-wrap" },
			h(
				"table",
				null,
				caption
					? h("caption", {
							class: "label",
							style: "text-align:left;padding:8px 12px",
							text: caption
						})
					: null,
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
									v instanceof Node ? v : String(v ?? "–")
								);
							})
						)
					)
				)
			)
		);
	}

	/** Tela antiga embutida, carregada só quando a aba é aberta. */
	function embed(src, title) {
		const frame = h("iframe", { src, title, loading: "lazy" });
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
							frame.src = src;
						}
					},
					icon("recarregar"),
					"Recarregar"
				),
				h(
					"a",
					{ class: "btn", href: src, target: "_blank", rel: "noopener" },
					icon("externo"),
					"Abrir em nova aba"
				)
			),
			frame
		);
	}

	/* ── Áreas ──────────────────────────────────────────────────── */

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

	function serviceState(value) {
		const status = typeof value === "object" && value ? value.status : value;
		if (status === "up" || status === "online" || status === "ok") return ["ok", "no ar"];
		if (status === "down" || status === "offline") return ["down", "fora"];
		return ["off", String(status || "sem dado")];
	}

	function botState(bot) {
		if (bot.enabled === false) return ["off", "desativada"];
		if (bot.connected) return ["ok", "conectada"];
		if (bot.isLive) return ["attention", "desconectada"];
		return ["down", "parada"];
	}

	const TIMEFRAMES = [
		{ id: "1h", label: "1 h", ms: 60 * 60 * 1000 },
		{ id: "24h", label: "24 h", ms: 24 * 60 * 60 * 1000 },
		{ id: "7d", label: "7 d", ms: 7 * 24 * 60 * 60 * 1000 },
		{ id: "30d", label: "30 d", ms: 30 * 24 * 60 * 60 * 1000 }
	];

	const AREAS = [
		{
			id: "geral",
			group: "Operação",
			title: "Visão geral",
			desc: "O estado da Ravena num olhar. Cada bloco leva à sua área.",
			tabs: [{ id: "resumo", label: "Resumo", render: renderGeral }]
		},
		{
			id: "instancias",
			group: "Operação",
			title: "Instâncias",
			desc: "Os bots configurados e o estado de cada conexão.",
			tabs: [
				{ id: "resumo", label: "Resumo", render: renderInstancias },
				{ id: "gestao", label: "Gestão completa", embed: "/instances" }
			]
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
			tabs: [
				{ id: "resumo", label: "Resumo", render: renderBanco },
				{ id: "painel", label: "Painel do banco", embed: "/banco/admin" }
			]
		},
		{
			id: "eventos",
			group: "Jogos e economia",
			title: "Eventos",
			desc: "Eventos programados com bônus para os jogos.",
			tabs: [
				{ id: "resumo", label: "Resumo", render: renderEventos },
				{ id: "gestao", label: "Gestão de eventos", embed: "/eventos/admin" }
			]
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
			desc: "Serviços externos, provedores cadastrados e fila do LLM.",
			tabs: [
				{ id: "resumo", label: "Resumo", render: renderProvedores },
				{ id: "gestao", label: "Gestão de provedores", embed: "/service-providers" }
			]
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

	/* Visão geral */
	async function renderGeral(root) {
		const d = await settle({
			bots: api("/api/bots"),
			services: api("/api/services/status"),
			bank: api("/api/games/bank/admin/config"),
			llm: api(`/api/llm/stats?timeframe=${TIMEFRAMES[1].ms}`),
			events: api("/api/events/admin")
		});

		const bots = Array.isArray(d.bots) ? d.bots : [];
		const connected = bots.filter((b) => b.connected).length;
		const enabled = bots.filter((b) => b.enabled !== false).length;
		const services = d.services || {};
		const svcEntries = Object.entries(services);
		const svcUp = svcEntries.filter(([, v]) => serviceState(v)[0] === "ok").length;
		const bank = d.bank && d.bank.data;
		const llm = d.llm || {};
		const events = (d.events && d.events.events) || [];
		const activeEvents = events.filter(
			(e) => e.status === "active" || e.status === "running"
		).length;

		root.append(
			h(
				"div",
				{ class: "grid" },
				cell({
					label: "Instâncias",
					value: d.bots ? `${connected}/${enabled}` : "–",
					sub: d.bots ? "conectadas / ativas" : "sem acesso",
					href: "#/instancias",
					attention: d.bots && connected < enabled
				}),
				cell({
					label: "Serviços",
					value: d.services ? `${svcUp}/${svcEntries.length}` : "–",
					sub: "no ar",
					href: "#/provedores",
					attention: d.services && svcUp < svcEntries.length
				}),
				cell({
					label: "Runas em circulação",
					value: bank ? fmt2(bank.totalRunas) : "–",
					sub: bank ? `${fmt(bank.totalAccounts)} contas` : "sem acesso",
					href: "#/banco"
				}),
				cell({
					label: "LLM · 24 h",
					value: fmt(llm.total_requests),
					sub: `${fmt(llm.total_failures)} falhas`,
					href: "#/analytics",
					attention: llm.total_failures > 0
				}),
				cell({
					label: "Eventos",
					value: d.events ? fmt(activeEvents) : "–",
					sub: d.events ? `ativos de ${fmt(events.length)}` : "sem acesso",
					href: "#/eventos"
				})
			)
		);

		if (d.servicesError) root.append(errorNotice(d.servicesError, "o estado dos serviços"));
		root.append(
			section(
				"Serviços",
				table(
					[
						{ label: "Serviço", value: ([k]) => SERVICE_NAMES[k] || k },
						{ label: "Estado", value: ([, v]) => lamp(...serviceState(v)) },
						{
							label: "Detalhe",
							value: ([, v]) => (typeof v === "object" && v && v.model ? `modelo: ${v.model}` : "")
						}
					],
					svcEntries
				)
			)
		);
	}

	/* Instâncias */
	async function renderInstancias(root) {
		const d = await settle({ bots: api("/api/bots"), stats: api("/api/bot-stats") });
		if (d.botsError) {
			root.append(errorNotice(d.botsError, "as instâncias"));
			return;
		}
		const statsById = new Map((d.stats || []).map((s) => [s.id, s]));
		const bots = d.bots || [];
		const total = statsById.get("TOTAL");

		root.append(
			h(
				"div",
				{ class: "grid" },
				cell({ label: "Configuradas", value: fmt(bots.length) }),
				cell({ label: "Conectadas", value: fmt(bots.filter((b) => b.connected).length) }),
				cell({ label: "Grupos", value: fmt(total ? total.groupsCount : undefined) }),
				cell({ label: "Msgs hoje", value: fmt(total ? total.day : undefined) })
			),
			section(
				"Bots",
				table(
					[
						{ label: "Instância", value: (b) => b.nomeExibir || b.nome },
						{ label: "Estado", value: (b) => lamp(...botState(b)) },
						{
							label: "Número",
							value: (b) => h("span", { class: "mono", text: maskNumber(b.numero) })
						},
						{ label: "Msgs/h", num: true, value: (b) => fmt(b.msgsHr) },
						{
							label: "Resp. média",
							num: true,
							value: (b) =>
								b.responseTime && b.responseTime.avg ? `${fmt2(b.responseTime.avg)} s` : "–"
						},
						{ label: "Grupos", num: true, value: (b) => fmt(b.groupsCount) },
						{ label: "Msgs hoje", num: true, value: (b) => fmt((statsById.get(b.nome) || {}).day) },
						{ label: "Última msg", num: true, value: (b) => relTime(b.lastMessageReceived) }
					],
					bots
				)
			),
			h(
				"p",
				{ class: "muted" },
				"Reiniciar, desconectar, parear e editar o bots.json continuam na aba ",
				h("a", { href: "#/instancias/gestao", text: "Gestão completa" }),
				"."
			)
		);
	}

	/* Logs (SSE) */
	function renderLogs(root) {
		const MAX_LINES = 2000;
		const out = h("pre", { class: "log", "aria-live": "off", "aria-label": "Saída de log" });
		const state = h("span", { class: "status" });
		const filter = h("input", {
			type: "search",
			placeholder: "filtrar",
			"aria-label": "Filtrar linhas"
		});
		let paused = false;
		let source = null;
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
			if (paused) {
				pending.push(text);
				return;
			}
			const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 24;
			text
				.split("\n")
				.filter((l) => l.length)
				.forEach(appendLine);
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
				if (!paused) pending.splice(0).forEach(onData);
			}
		});

		filter.addEventListener("input", () => {
			const q = filter.value.trim().toLowerCase();
			for (const line of out.children)
				line.hidden = q ? !line.textContent.toLowerCase().includes(q) : false;
		});

		root.append(
			h(
				"div",
				{ class: "toolbar" },
				state,
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

	/* Banco */
	async function renderBanco(root) {
		const d = await settle({
			config: api("/api/games/bank/admin/config"),
			users: api("/api/games/bank/admin/users?page=1&limit=10")
		});
		if (d.configError) {
			root.append(errorNotice(d.configError, "a configuração do banco"));
			return;
		}
		const c = (d.config && d.config.data) || {};
		const r = c.rates || {};
		root.append(
			h(
				"div",
				{ class: "grid" },
				cell({ label: "Runas em circulação", value: fmt2(c.totalRunas) }),
				cell({ label: "Contas", value: fmt(c.totalAccounts) }),
				cell({
					label: "Inflação Waifuletes",
					value: c.waifu ? `${fmt2(c.waifu.inflationPercent)} %` : "–",
					sub: c.waifu ? `${fmt(c.waifu.circulatingZinthos)} Zinthos` : null,
					attention: c.waifu && c.waifu.inflationPercent > 5
				}),
				cell({
					label: "Inflação Jardim",
					value: c.jardim ? `${fmt2(c.jardim.inflationPercent)} %` : "–",
					sub: c.jardim ? `${fmt(c.jardim.totalCoins)} moedas` : null,
					attention: c.jardim && c.jardim.inflationPercent > 5
				}),
				cell({
					label: "Peixes",
					value: c.fish ? `${fmt(c.fish.totalWeight)} kg` : "–",
					sub: c.fish ? `${fmt(c.fish.totalCount)} capturas` : null
				})
			),
			section(
				`Cotações do dia${r.date ? ` · ${r.date}` : ""}`,
				table(
					[
						{ label: "Conversão", value: (x) => x[0] },
						{ label: "Runas", num: true, value: (x) => fmt2(x[1]) },
						{
							label: "Multiplicador",
							num: true,
							value: (x) => (x[2] === undefined ? "–" : fmt2(x[2]))
						}
					],
					[
						["1 kg de peixe", r.runasPerKgFish, r.fishMultiplier],
						["1 Zinthos", r.runasPerZinthos, r.waifuMultiplier],
						["1 moeda do Jardim", r.runasPerJardimCoin, r.jardimMultiplier]
					]
				)
			)
		);
		const users = (d.users && d.users.data && d.users.data.users) || [];
		root.append(
			section(
				"Maiores saldos",
				d.usersError
					? errorNotice(d.usersError, "os usuários")
					: table(
							[
								{ label: "Nome", value: (u) => u.name || "Sem apelido" },
								{ label: "Runas", num: true, value: (u) => fmt2(u.runas) },
								{ label: "Depositado", num: true, value: (u) => fmt2(u.totalDeposited) },
								{ label: "Sacado", num: true, value: (u) => fmt2(u.totalWithdrawn) },
								{ label: "Atualizado", num: true, value: (u) => relTime(u.updatedAt) }
							],
							users.slice(0, 10)
						)
			),
			h(
				"p",
				{ class: "muted" },
				"Transações, desfazer, impersonação e regras ficam no ",
				h("a", { href: "#/banco/painel", text: "Painel do banco" }),
				"."
			)
		);
	}

	/* Eventos */
	async function renderEventos(root) {
		let data;
		try {
			data = await api("/api/events/admin");
		} catch (err) {
			root.append(errorNotice(err, "os eventos"));
			return;
		}
		const events = data.events || [];
		const eventState = (e) => {
			if (e.status === "active" || e.status === "running") return ["ok", e.statusLabel || "ativo"];
			if (e.status === "scheduled" || e.status === "pending")
				return ["busy", e.statusLabel || "agendado"];
			return ["off", e.statusLabel || e.status || "encerrado"];
		};
		root.append(
			section(
				"Eventos",
				table(
					[
						{ label: "#", num: true, value: (e) => e.id },
						{ label: "Nome", value: (e) => e.name },
						{ label: "Estado", value: (e) => lamp(...eventState(e)) },
						{ label: "Início", value: (e) => e.startFormatted || "–" },
						{ label: "Fim", value: (e) => e.endFormatted || "–" },
						{ label: "Duração", value: (e) => e.durationLabel || "–" }
					],
					events
				)
			),
			section(
				"Bônus disponíveis",
				table(
					[
						{ label: "Jogo", value: (g) => g.gameLabel || g.game },
						{ label: "Bônus", value: (g) => g.label },
						{ label: "Unidade", value: (g) => g.unit },
						{ label: "Padrão", num: true, value: (g) => fmt(g.defaultValue) }
					],
					(data.catalog && data.catalog.startGrants) || []
				)
			)
		);
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
						style: "margin:0 0 6px",
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

	/* Provedores de IA */
	async function renderProvedores(root) {
		const d = await settle({
			services: api("/api/services/status"),
			providers: api("/api/service-providers"),
			queue: api("/api/llm/queue")
		});
		const services = Object.entries(d.services || {});
		const providers = Object.entries(d.providers || {});
		const queues = Object.entries((d.queue && d.queue.queues) || {});

		if (d.servicesError) root.append(errorNotice(d.servicesError, "o estado dos serviços"));
		root.append(
			section(
				"Estado dos serviços",
				table(
					[
						{ label: "Serviço", value: ([k]) => SERVICE_NAMES[k] || k },
						{ label: "Estado", value: ([, v]) => lamp(...serviceState(v)) },
						{
							label: "Detalhe",
							value: ([, v]) => (typeof v === "object" && v && v.model ? `modelo: ${v.model}` : "")
						}
					],
					services
				)
			),
			section(
				"Provedores cadastrados",
				d.providersError
					? errorNotice(d.providersError, "os provedores")
					: table(
							[
								{ label: "Tipo", value: ([k]) => k },
								{
									label: "Cadastrados",
									num: true,
									value: ([, v]) => fmt(Array.isArray(v) ? v.length : 0)
								},
								{
									label: "Ativos",
									num: true,
									value: ([, v]) =>
										fmt(Array.isArray(v) ? v.filter((p) => p && p.enabled !== false).length : 0)
								}
							],
							providers
						)
			),
			section(
				"Fila do LLM",
				queues.length
					? table(
							[
								{ label: "Fila", value: ([k]) => k },
								{
									label: "Itens",
									num: true,
									value: ([, v]) =>
										fmt(Array.isArray(v) ? v.length : (v && (v.length ?? v.size)) || 0)
								}
							],
							queues
						)
					: h("div", { class: "empty", text: "Fila vazia." })
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
						router.rerender();
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
					sub: `${fmt2(failRate)} %`,
					attention: failRate > 5
				}),
				cell({ label: "Tokens entrada", value: fmt(s.total_input_tokens) }),
				cell({ label: "Tokens saída", value: fmt(s.total_output_tokens) }),
				cell({ label: "Externas", value: fmt(s.external_requests) }),
				cell({
					label: "Msgs/hora hoje (soma)",
					value: msgsHoje === null ? "–" : fmt(Math.round(msgsHoje))
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
									a.tabs.some((t) => t.embed) && !a.tabs.some((t) => t.render)
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
				next.focus();
				next.click();
			}
		});
		return list;
	}

	/* ── Roteador por hash ───────────────────────────────────────── */

	const router = {
		cleanup: null,
		token: 0,
		parse() {
			const [areaId, tabId] = location.hash.replace(/^#\/?/, "").split("/");
			const area = AREAS.find((a) => a.id === areaId) || AREAS[0];
			const tab = area.tabs.find((t) => t.id === tabId) || area.tabs[0];
			return { area, tab };
		},
		async render({ focus } = {}) {
			const { area, tab } = this.parse();
			const token = ++this.token;
			if (typeof this.cleanup === "function") this.cleanup();
			this.cleanup = null;

			document.querySelectorAll(".nav-item").forEach((a) => {
				if (a.dataset.area === area.id) a.setAttribute("aria-current", "page");
				else a.removeAttribute("aria-current");
			});
			document.title = `${area.title} · Ravena Admin`;

			const main = document.getElementById("main");
			const body = h("div", {
				id: "view-body",
				role: area.tabs.length > 1 ? "tabpanel" : null,
				"aria-labelledby": area.tabs.length > 1 ? `tab-${tab.id}` : null,
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
			if (focus) main.focus({ preventScroll: true });

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
			} catch (err) {
				if (token !== this.token) return;
				body.replaceChildren(errorNotice(err, area.title.toLowerCase()));
			}
			body.removeAttribute("aria-busy");
		},
		rerender() {
			return this.render();
		}
	};

	/* ── Resumo da barra do topo ─────────────────────────────────── */

	async function refreshSummary() {
		const el = document.getElementById("topbar-summary");
		const d = await settle({ bots: api("/api/bots"), services: api("/api/services/status") });
		const parts = [];
		if (d.bots) {
			const bots = d.bots.filter((b) => b.enabled !== false);
			const off = bots.filter((b) => !b.connected).length;
			parts.push(
				h(
					"span",
					{ class: "lamp-text" },
					lamp(
						off ? "attention" : "ok",
						off ? `${off} instância(s) fora` : `${bots.length} instância(s) ok`
					)
				)
			);
		}
		if (d.services) {
			const entries = Object.values(d.services);
			const down = entries.filter((v) => serviceState(v)[0] !== "ok").length;
			parts.push(
				h(
					"span",
					{ class: "lamp-text" },
					lamp(down ? "attention" : "ok", down ? `${down} serviço(s) fora` : "serviços ok")
				)
			);
		}
		el.replaceChildren(...parts);
	}

	/* ── Tema (auto | claro | escuro) ────────────────────────────── */

	const THEME_KEY = "ravena-admin-theme";

	function applyTheme(choice) {
		if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
		else delete document.documentElement.dataset.theme;
		document.querySelectorAll("[data-theme-choice]").forEach((b) => {
			b.setAttribute("aria-pressed", String(b.dataset.themeChoice === (choice || "auto")));
		});
		try {
			if (choice === "light" || choice === "dark") localStorage.setItem(THEME_KEY, choice);
			else localStorage.removeItem(THEME_KEY);
		} catch {
			/* sem armazenamento: vale só nesta visita */
		}
	}

	function initTheme() {
		const params = new URLSearchParams(location.search);
		let choice = params.get("theme");
		if (!choice) {
			try {
				choice = localStorage.getItem(THEME_KEY);
			} catch {
				choice = null;
			}
		}
		applyTheme(choice || "auto");
		document.getElementById("theme-switch").addEventListener("click", (ev) => {
			const btn = ev.target.closest("[data-theme-choice]");
			if (btn) applyTheme(btn.dataset.themeChoice);
		});
	}

	/* ── Início ─────────────────────────────────────────────────── */

	initTheme();
	buildSidebar();
	window.addEventListener("hashchange", () => router.render({ focus: true }));
	router.render();
	refreshSummary().catch(() => {});
	setInterval(() => refreshSummary().catch(() => {}), 60000);
})();
