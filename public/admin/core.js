/**
 * Kit do painel de admin da Ravena (/admin). Módulo ES sem dependências.
 *
 * Quem escreve uma área (public/admin/areas/<id>.js) só precisa deste arquivo. Regras:
 * - DOM sempre por h()/textContent: nada de innerHTML com dado vindo da API;
 * - leituras por api() (cache de 45 s por URL), escritas por send() (JSON, mensagens em pt-BR);
 * - confirmação no próprio lugar do botão (confirmInline), aviso por toast(); nunca
 *   window.confirm/alert;
 * - estado nunca só por cor: lamp() e pill() levam palavra.
 *
 * Resumo da API (detalhes no JSDoc de cada função):
 *
 *   DOM          h(tag, props, ...filhos) · svg(tag, attrs) · icon(nome) · srOnly(texto)
 *   Estado       lamp(estado, palavra) · pill(texto, tipo) · coinEmblem(moeda, px)
 *   Texto        fmt · fmt2 · plural · relTime · dateFmt   (de lib.js, sem DOM)
 *   Dados        api(path, {fresh}) · send(método, path, corpo) · settle({...}) · invalidate(prefixo)
 *                HttpError (status, message, serverMessage, body) · onSessionExpired(fn)
 *   Avisos       errorNotice(erro, "o quê") · loading(texto) · empty(texto, dica) · toast(msg, {kind})
 *   Layout       card({title, actions, body, pill}) · rows(itens) · rowItem({...}) · secLabel(t)
 *                kv(pares) · tiles(itens) · crumbs(itens) · note(texto) · loadAreaCss(área, href)
 *   Navegação    subnav(itens, ativo, {label}) · externalLink(href, rótulo, {missing})
 *                focusAfterRender(chave)
 *   Formulários  field({...}) · form({...}) · searchBox({...}) · confirmInline(botão, {...})
 *                busy(botão, rótulo, fn) · copyText(texto, {...})
 *   Tabelas      dataTable(colunas, linhas, {...})  (vira cartões em largura estreita)
 *   Tempo        poll(fn, ms) (só com a aba visível) · debounce(fn, ms)
 *   Links        getLinks() · grafanaLink(painel, params) · panelLinks()
 *   Tema         themeSwitch() · applyTheme(escolha)
 *
 * Exemplo mínimo de área:
 *
 *   import { h, api, card, dataTable, fmt, errorNotice } from "../core.js";
 *   export default {
 *     id: "exemplo", group: "Operação", title: "Exemplo", desc: "Uma linha sobre a área.",
 *     async render(root, ctx) {
 *       try {
 *         const d = await api("/api/algo");
 *         root.append(card({ title: "Itens", body: dataTable(
 *           [{ label: "Nome", value: (r) => r.nome }, { label: "Qtd.", num: true, value: (r) => fmt(r.qtd) }],
 *           d.itens) }));
 *       } catch (err) { root.append(errorNotice(err, "os itens")); }
 *     }
 *   };
 */

import { fmt, httpReason, withParams } from "./lib.js";

export * from "./lib.js";

/* ── DOM ──────────────────────────────────────────────────────── */

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Cria um elemento HTML.
 * props: atributos (class, href, id, data-*, aria-*, role...), "text" (textContent),
 * "on<evento>" (listener), "dataset" (objeto). true vira atributo vazio; null/false/undefined
 * são ignorados. Filhos: Node, texto, número, arrays (achatados) e null/false (ignorados).
 * @param {string} tag
 * @param {Object|null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
	const el = document.createElement(tag);
	setProps(el, props);
	appendChildren(el, children);
	return el;
}

function setProps(el, props) {
	for (const [key, value] of Object.entries(props || {})) {
		if (value === undefined || value === null || value === false) continue;
		if (key === "text") el.textContent = String(value);
		else if (key === "dataset") Object.assign(el.dataset, value);
		else if (key.startsWith("on") && typeof value === "function") {
			el.addEventListener(key.slice(2).toLowerCase(), value);
		} else el.setAttribute(key, value === true ? "" : String(value));
	}
}

function appendChildren(el, children) {
	for (const child of children.flat(Infinity)) {
		if (child === undefined || child === null || child === false) continue;
		el.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
}

/** Cria um elemento SVG com atributos. */
export function svg(tag, attrs = {}, ...children) {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
	}
	appendChildren(el, children);
	return el;
}

/** Texto só para leitores de tela. */
export const srOnly = (text) => h("span", { class: "sr-only", text });

/* ── Ícones (traço 1,4 px, 16×16, herdam a cor do texto) ──────────── */

const P = (d) => ["path", { d }];
const ICONS = {
	geral: [P("M2 8.5 8 3l6 5.5V14H10v-4H6v4H2z")],
	instancias: [
		["rect", { x: 2, y: 2.5, width: 12, height: 4.5, rx: 1 }],
		["rect", { x: 2, y: 9, width: 12, height: 4.5, rx: 1 }],
		P("M4.5 4.75h.01M4.5 11.25h.01")
	],
	provedores: [
		["rect", { x: 4, y: 4, width: 8, height: 8, rx: 1 }],
		P("M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5")
	],
	logs: [["rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1 }], P("m4 6 2.5 2L4 10M8 10.5h4")],
	banco: [P("M2 6 8 2.5 14 6v1H2zM3.5 8.5v3.5M6.5 8.5v3.5M9.5 8.5v3.5M12.5 8.5v3.5M2 13.5h12")],
	eventos: [
		["rect", { x: 2, y: 3, width: 12, height: 11, rx: 1 }],
		P("M2 6.5h12M5 1.5v3M11 1.5v3")
	],
	carga: [
		["ellipse", { cx: 8, cy: 3.5, rx: 5.5, ry: 2 }],
		P("M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2")
	],
	pessoas: [
		["circle", { cx: 6, cy: 5.5, r: 2.5 }],
		P(
			"M1.5 14c0-3 2-4.5 4.5-4.5S10.5 11 10.5 14M11 3.5a2.3 2.3 0 0 1 0 4.5M12.5 10c1.3.6 2 1.9 2 4"
		)
	],
	mais: [
		["circle", { cx: 3.5, cy: 8, r: 1.2 }],
		["circle", { cx: 8, cy: 8, r: 1.2 }],
		["circle", { cx: 12.5, cy: 8, r: 1.2 }]
	],
	externo: [P("M6.5 3H3v10h10V9.5M9 3h4v4M13 3 7.5 8.5")],
	recarregar: [P("M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5")],
	grafico: [P("M2.5 13V9M6 13V6M9.5 13V8M13 13V3")],
	tema: [["circle", { cx: 8, cy: 8, r: 5.5 }], P("M8 2.5v11a5.5 5.5 0 0 0 0-11z")],
	sair: [P("M9.5 3H13v10H9.5M6.5 5 3.5 8l3 3M3.5 8h7")],
	busca: [["circle", { cx: 7, cy: 7, r: 4.5 }], P("m10.5 10.5 3 3")],
	novo: [P("M8 3v10M3 8h10")],
	fechar: [P("m4 4 8 8M12 4l-8 8")],
	ok: [P("m3 8.5 3 3 7-7")],
	alerta: [P("M8 2 14.5 13.5h-13zM8 6.5v3.5M8 12h.01")],
	seta: [P("m6 3.5 4.5 4.5L6 12.5")],
	voltar: [P("M10 3.5 5.5 8l4.5 4.5")],
	moeda: [
		["circle", { cx: 8, cy: 8, r: 5.5 }],
		P("M8 5v6M6.5 6.5h2.25a1.25 1.25 0 0 1 0 2.5h-1.5a1.25 1.25 0 0 0 0 2.5H9.5")
	]
};

/**
 * Ícone de traço. Nomes: geral, instancias, provedores, logs, banco, eventos, carga, pessoas,
 * mais, externo, recarregar, grafico, tema, sair, busca, novo, fechar, ok, alerta, seta,
 * voltar, moeda. Desconhecido → geral.
 * @param {string} name
 * @returns {SVGSVGElement}
 */
export function icon(name) {
	const el = svg("svg", {
		viewBox: "0 0 16 16",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "1.4",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		"aria-hidden": "true",
		focusable: "false",
		class: "icon"
	});
	for (const [tag, attrs] of ICONS[name] || ICONS.geral) el.append(svg(tag, attrs));
	return el;
}

/** Nomes de ícone disponíveis (para o contrato e para testes). */
export const ICON_NAMES = Object.keys(ICONS);

/* ── Estado: lâmpada, pílula, moeda ─────────────────────────────── */

/**
 * Lâmpada de estado: glifo + palavra. Estados: ok | attention | down | off | busy.
 * Sem palavra, use só onde o texto ao lado já diz o estado.
 * @param {"ok"|"attention"|"down"|"off"|"busy"} state
 * @param {string} [word]
 */
export function lamp(state, word) {
	return h(
		"span",
		{ class: "status", "data-state": state },
		h("span", { class: "lamp", "data-state": state, "aria-hidden": "true" }),
		word ? h("span", { class: "state-word", "data-state": state, text: word }) : null
	);
}

/**
 * Pílula de texto. kind: "" (neutra) | "ok" | "att" (âmbar, pede atenção) | "bad" (falha).
 * @param {string|number} text
 * @param {""|"ok"|"att"|"bad"} [kind]
 */
export const pill = (text, kind = "") =>
	h("span", { class: `pill${kind ? ` ${kind}` : ""}`, text: String(text) });

const COIN = {
	Zinthos: {
		fill: "#7D9DE3",
		shape:
			"M12 21.2C12 21.2 2.6 15.3 2.6 8.9 2.6 5.6 5 3.4 7.8 3.4c1.8 0 3.3 1 4.2 2.4.9-1.4 2.4-2.4 4.2-2.4 2.8 0 5.2 2.2 5.2 5.5 0 6.4-9.4 12.3-9.4 12.3z",
		glyph: [
			["path", { d: "M8.6 8.6h6.8l-6.8 7.2h6.8", "stroke-width": 2.3, "stroke-linejoin": "round" }]
		]
	},
	Runas: {
		fill: "#82DFEA",
		shape: "M12 1.8 22.2 12 12 22.2 1.8 12z",
		glyph: [
			[
				"path",
				{
					d: "M10 7.2v9.6M10 7.4h2.8a2.2 2.2 0 0 1 0 4.4H10M12.1 11.8l2.8 5",
					"stroke-width": 2.1,
					"stroke-linejoin": "round"
				}
			]
		]
	},
	Petalitas: {
		fill: "#E08A9A",
		shape: "M12 1.8c5.6 4.4 8.6 9.6 3.6 17.4-1.7 2.6-5.5 2.6-7.2 0C3.4 11.4 6.4 6.2 12 1.8z",
		glyph: [
			[
				"path",
				{
					d: "M12 18.2v-6.4M12 12.4c0-2.8 1.8-4.4 4.2-4.4 0 2.8-1.8 4.4-4.2 4.4zM12 13.6c0-2.3-1.5-3.6-3.5-3.6 0 2.3 1.5 3.6 3.5 3.6z",
					"stroke-width": 1.9,
					"stroke-linejoin": "round"
				}
			]
		]
	}
};

/**
 * Emblema original de uma moeda (SVG inline, decorativo: ponha o nome da moeda ao lado).
 * Zinthos: coração com Z; Runas: losango com ᚱ; Petalitas: pétala com broto. Contorno #121214
 * e sombra deslocada, iguais nos dois temas.
 * @param {"Zinthos"|"Runas"|"Petalitas"|string} coin - aceita também minúsculas
 * @param {number} [size] - px (padrão 18)
 */
export function coinEmblem(coin, size = 18) {
	const key = String(coin || "").replace(/^./, (c) => c.toUpperCase());
	const c = COIN[key];
	const ink = "#121214";
	const el = svg("svg", {
		class: "coin",
		viewBox: "0 0 25 25",
		width: size,
		height: size,
		"aria-hidden": "true",
		focusable: "false",
		"data-coin": key
	});
	if (!c) return el;
	el.append(
		svg("path", { d: c.shape, transform: "translate(1.4 1.6)", fill: ink }),
		svg("path", {
			d: c.shape,
			fill: c.fill,
			stroke: ink,
			"stroke-width": 1.5,
			"stroke-linejoin": "round"
		}),
		...c.glyph.map(([tag, attrs]) =>
			svg(tag, { fill: "none", stroke: ink, "stroke-linecap": "round", ...attrs })
		)
	);
	return el;
}

/* ── Dados: leitura com cache, escrita com mensagens claras ─────── */

/**
 * Falha HTTP com status e motivo em pt-BR (message). serverMessage guarda a mensagem que o
 * servidor mandou (body.message ou body.error) em qualquer status, inclusive 5xx, onde ela não
 * entra no message (costuma ser técnica); body é o JSON da resposta, quando houver.
 */
export class HttpError extends Error {
	constructor(status, message, body = null) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.body = body;
		const m = body && (typeof body.message === "string" ? body.message : body.error);
		this.serverMessage = typeof m === "string" && m ? m : null;
	}
}

const API_TTL_MS = 45 * 1000;
const apiCache = new Map(); // url -> { at, promise }
const sessionListeners = new Set();

/** Chamado quando alguma leitura ou escrita volta 401 (o app mostra a faixa "entre de novo"). */
export function onSessionExpired(fn) {
	sessionListeners.add(fn);
	return () => sessionListeners.delete(fn);
}

/** Avisa a casca que a sessão expirou (para leituras feitas fora de api()/send()). */
export function notifySessionExpired() {
	sessionListeners.forEach((fn) => fn());
}

async function failure(res) {
	let body = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	if (res.status === 401) sessionListeners.forEach((fn) => fn());
	// A mensagem do servidor (já em pt-BR nas rotas novas) vem junto do motivo padrão; em 5xx
	// ela fica só em err.serverMessage.
	const err = new HttpError(res.status, httpReason(res.status), body);
	if (err.serverMessage && res.status !== 401 && res.status < 500)
		err.message = `${err.message}: ${err.serverMessage}`;
	return err;
}

/**
 * GET JSON com cache de 45 s por URL: trocar de área e voltar não refaz as leituras.
 * Pedidos iguais em voo são compartilhados. Falha não fica no cache.
 * @param {string} path
 * @param {{ fresh?: boolean }} [opts] - fresh: ignora o cache (botão Atualizar)
 * @returns {Promise<any>}
 * @throws {HttpError}
 */
export function api(path, opts = {}) {
	const hit = apiCache.get(path);
	if (!opts.fresh && hit && Date.now() - hit.at < API_TTL_MS) return hit.promise;
	const promise = fetch(path, {
		credentials: "same-origin",
		headers: { Accept: "application/json" }
	})
		.catch(() => {
			throw new HttpError(0, httpReason(0));
		})
		.then(async (res) => {
			if (!res.ok) throw await failure(res);
			return res.json();
		});
	apiCache.set(path, { at: Date.now(), promise });
	promise.catch(() => {
		if (apiCache.get(path)?.promise === promise) apiCache.delete(path);
	});
	return promise;
}

/**
 * Esquece leituras em cache. Sem prefixo, esquece todas.
 * @param {string} [prefix] - ex. "/api/events" esquece /api/events/admin e afins
 */
export function invalidate(prefix) {
	for (const key of [...apiCache.keys()]) {
		if (!prefix || key.startsWith(prefix)) apiCache.delete(key);
	}
}

/**
 * Escrita JSON (POST/PUT/PATCH/DELETE) na mesma origem, com cookie de sessão e
 * Content-Type application/json (as rotas de admin recusam outro tipo com 415).
 * Depois de qualquer escrita bem-sucedida o cache de leituras é esvaziado.
 * Erros viram HttpError com motivo em pt-BR: 401 sessão, 403 permissão/origem, 409 estado,
 * 415 formato, 429 limite (e a mensagem do servidor junto, quando houver).
 * @param {"POST"|"PUT"|"PATCH"|"DELETE"} method
 * @param {string} path
 * @param {any} [body]
 * @returns {Promise<any>} JSON da resposta (ou null sem corpo)
 * @throws {HttpError}
 */
export async function send(method, path, body) {
	let res;
	try {
		res = await fetch(path, {
			method,
			credentials: "same-origin",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	} catch {
		throw new HttpError(0, httpReason(0));
	}
	if (!res.ok) throw await failure(res);
	invalidate();
	if (res.status === 204) return null;
	const text = await res.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Várias leituras sem que a falha de uma derrube a tela inteira.
 * settle({ bots: api("/api/bots"), x: api("/x") }) → { bots, x, xError? }
 * (valor null + chave <nome>Error com o HttpError quando falha)
 */
export async function settle(map) {
	const keys = Object.keys(map);
	const results = await Promise.allSettled(keys.map((k) => map[k]));
	const out = {};
	keys.forEach((k, i) => {
		out[k] = results[i].status === "fulfilled" ? results[i].value : null;
		if (results[i].status === "rejected") out[`${k}Error`] = results[i].reason;
	});
	return out;
}

/* ── Avisos e estados vazios ───────────────────────────────────── */

/** Caixa de erro por escrito: "Não foi possível carregar <what>: <motivo>." */
export function errorNotice(err, what = "os dados") {
	const msg = err && err.message ? err.message : "erro desconhecido";
	return h(
		"div",
		{ class: "notice error", role: "alert" },
		lamp("down"),
		h("span", { text: `Não foi possível carregar ${what}: ${msg}.` })
	);
}

/** Linha de "Carregando…" (com aria-busy no contêiner pai, se quiser). */
export const loading = (text = "Carregando…") =>
	h(
		"p",
		{ class: "loading", "data-loading": "", role: "status" },
		h("span", { class: "spinner", "aria-hidden": "true" }),
		text
	);

/** Estado vazio com uma dica opcional embaixo. */
export const empty = (text = "Nada para mostrar ainda.", hint) =>
	h(
		"div",
		{ class: "empty" },
		h("p", { text }),
		hint ? h("p", { class: "faint", text: hint }) : null
	);

/** Nota tracejada (explicação curta dentro de uma área). */
export const note = (...children) => h("p", { class: "note-in" }, ...children);

let toastRegion = null;

/**
 * Aviso passageiro no rodapé (aria-live). kind: "ok" | "error" | "" (neutro).
 * Erros ficam 8 s; o resto 4 s. Clique fecha.
 * @param {string} message
 * @param {{ kind?: "ok"|"error"|"" }} [opts]
 */
export function toast(message, { kind = "" } = {}) {
	if (!toastRegion) {
		toastRegion = document.getElementById("toasts");
		if (!toastRegion) {
			toastRegion = h("div", {
				id: "toasts",
				class: "toasts",
				role: "status",
				"aria-live": "polite"
			});
			document.body.append(toastRegion);
		}
	}
	const el = h(
		"div",
		{ class: `toast${kind ? ` ${kind}` : ""}`, onclick: () => el.remove() },
		kind === "error" ? icon("alerta") : kind === "ok" ? icon("ok") : null,
		h("span", { text: message })
	);
	toastRegion.append(el);
	setTimeout(() => el.remove(), kind === "error" ? 8000 : 4000);
	return el;
}

/* ── Peças de layout ───────────────────────────────────────────── */

/**
 * Cartão: cabeçalho opcional (título + pílula + ações) e corpo.
 * body: Node | Node[]; se "padded" (padrão true para body que não é lista/tabela), recebe .bd.
 * @param {{ title?: string, pill?: Node, actions?: Node|Node[], body?: Node|Node[], padded?: boolean,
 *   tag?: string, class?: string, label?: string }} opts
 */
export function card({
	title,
	pill: badge,
	actions,
	body,
	padded,
	tag = "section",
	class: cls,
	label
} = {}) {
	const head =
		title || actions
			? h(
					"div",
					{ class: "hd" },
					title ? h("h2", { class: "card-title", text: title }) : null,
					badge || null,
					actions ? h("div", { class: "card-actions" }, actions) : null
				)
			: null;
	const bodyNodes = [body].flat().filter(Boolean);
	const autoPad =
		padded ??
		!bodyNodes.every((n) => n instanceof Element && n.matches(".rows, .dt-wrap, .list, .needs"));
	return h(
		tag,
		{ class: `card${cls ? ` ${cls}` : ""}`, "aria-label": !title && label ? label : null },
		head,
		bodyNodes.length ? (autoPad ? h("div", { class: "bd" }, bodyNodes) : bodyNodes) : null
	);
}

/** Rótulo de seção em mono, caixa alta (acima de um grupo de cartões). */
export const secLabel = (text) => h("h2", { class: "sec-label", text });

/**
 * Linha inteira tocável (como no mock): ícone, título, uma linha de estado, contador, seta.
 * - href: rota interna ("#/carga") → seta "›";
 * - external: URL de outro painel → abre em outra aba, seta "↗";
 * - disabled + hint: item sem destino (ex. "defina X no .env"), mostrado sem link.
 * @param {{ icon?: string|Node, title: string, status?: string|Node, attention?: boolean,
 *   count?: number, href?: string, external?: string|null, disabled?: boolean, hint?: string,
 *   state?: string, key?: string }} o
 */
export function rowItem(o) {
	const ic = o.icon instanceof Node ? o.icon : o.icon ? icon(o.icon) : null;
	const statusNode =
		o.status instanceof Node
			? o.status
			: o.status
				? h("span", { class: `rw-sub${o.attention ? " att" : ""}`, text: o.status })
				: null;
	const hint = o.disabled && o.hint ? h("span", { class: "rw-sub rw-hint", text: o.hint }) : null;
	const isExternal = !o.disabled && !!o.external;
	const children = [
		ic ? h("span", { class: "ic" }, ic) : null,
		h("span", { class: "tx" }, h("b", { text: o.title }), statusNode, hint),
		o.count
			? h(
					"span",
					{ class: "n", text: fmt(o.count) },
					srOnly(` ${o.count === 1 ? "pede" : "pedem"} atenção`)
				)
			: null,
		o.disabled
			? h("span", { class: "chev", "aria-hidden": "true", text: "–" })
			: h("span", { class: "chev", "aria-hidden": "true", text: isExternal ? "↗" : "›" }),
		isExternal ? srOnly(" (abre em outra aba)") : null
	];
	if (o.disabled) {
		return h("div", { class: "rw", "aria-disabled": "true", "data-key": o.key || null }, children);
	}
	return h(
		"a",
		{
			class: "rw",
			href: isExternal ? o.external : o.href || "#/geral",
			target: isExternal ? "_blank" : null,
			rel: isExternal ? "noopener" : null,
			"data-state": o.state || null,
			"data-key": o.key || null
		},
		children
	);
}

/** Lista de rowItem num cartão (div.card.rows). */
export const rows = (items, { label } = {}) =>
	h(
		"div",
		{ class: "card rows", role: label ? "group" : null, "aria-label": label || null },
		items
	);

/**
 * Lista de definição em duas colunas. pairs: [["Rótulo", valor], ...]; valor Node ou texto;
 * pares com valor undefined são pulados.
 */
export function kv(pairs) {
	return h(
		"dl",
		{ class: "kv" },
		pairs
			.filter(([, v]) => v !== undefined)
			.flatMap(([k, v]) => [
				h("dt", { text: k }),
				h("dd", null, v instanceof Node ? v : String(v ?? "—"))
			])
	);
}

/**
 * Faixa de números (blocos colados). Cada item: { label, value, detail?, attention?, href?, error? }.
 * Com error, o motivo aparece por escrito no lugar do número (nunca um "—" que pareça zero).
 */
export function tiles(items) {
	return h(
		"div",
		{ class: "tiles" },
		items.filter(Boolean).map((t) => {
			const tag = t.href ? "a" : "div";
			const value = t.error
				? h("span", { class: "v v-error" }, lamp("off", t.error.message || "sem dado"))
				: t.value instanceof Node
					? t.value
					: h("span", { class: "v", text: String(t.value ?? "—") });
			return h(
				tag,
				{
					class: `tile${t.attention && !t.error ? " att" : ""}`,
					href: t.href || null,
					"data-tile": t.label
				},
				h("span", { class: "label", text: t.label }),
				value,
				t.detail && !t.error
					? h("span", { class: `d${t.attention ? " att" : ""}`, text: t.detail })
					: null
			);
		})
	);
}

/**
 * Trilha: crumbs([{ label: "Jogadores", href: "#/banco/jogadores" }, { label: "Fulano" }])
 * O último item (sem href) é a página atual.
 */
export function crumbs(items) {
	const list = h("ol", { class: "crumbs" });
	items.forEach((it, i) => {
		const last = i === items.length - 1;
		list.append(
			h(
				"li",
				null,
				it.href && !last
					? h("a", { href: it.href, text: it.label })
					: h("span", { "aria-current": last ? "page" : null, text: it.label })
			)
		);
	});
	return h("nav", { class: "crumbs-nav", "aria-label": "Trilha" }, list);
}

/**
 * Carrega uma vez a folha de estilo própria de uma área (o /admin só traz o admin.css).
 * Devolve uma promessa que resolve quando a folha carrega (ou falha, ou passa 1,5 s): quem
 * quiser evitar o "pisca sem estilo" na primeira visita faz await antes de desenhar.
 *   loadAreaCss("banco", "/admin/areas/banco.css?v=1");
 * @param {string} area - id da área (vai em data-area-css)
 * @param {string} href
 * @returns {Promise<void>}
 */
export function loadAreaCss(area, href) {
	const prev = document.querySelector(`link[data-area-css="${CSS.escape(area)}"]`);
	if (prev) return prev.ready || Promise.resolve();
	const link = h("link", { rel: "stylesheet", href, "data-area-css": area });
	link.ready = new Promise((ok) => {
		const done = () => ok();
		link.addEventListener("load", done, { once: true });
		link.addEventListener("error", done, { once: true });
		setTimeout(done, 1500);
	});
	document.head.append(link);
	return link.ready;
}

/* ── Navegação ─────────────────────────────────────────────────── */

let pendingFocusKey = null;

/**
 * Pede ao app que, depois do próximo redesenho da área, o foco vá para o elemento com
 * data-key igual a `key` (usado pelo subnav ao trocar de aba pelas setas).
 */
export function focusAfterRender(key) {
	pendingFocusKey = key;
}

/**
 * Identidade de um elemento para reencontrá-lo depois de redesenhar: data-key, id, ou
 * tag + href + texto. null se não dá para reencontrar.
 */
export function focusKey(el) {
	if (!(el instanceof Element)) return null;
	if (el.dataset.key) return `[data-key="${CSS.escape(el.dataset.key)}"]`;
	if (el.id) return `#${CSS.escape(el.id)}`;
	const href = el.getAttribute("href");
	if (href) return `${el.tagName.toLowerCase()}[href="${CSS.escape(href)}"]`;
	return null;
}

/**
 * Redesenha algo sem perder o foco: guarda quem tinha o foco dentro de `root`, roda `fn`
 * (pode ser async) e devolve o foco ao elemento equivalente, se ele ainda existir.
 * @param {Element} root
 * @param {() => any} fn
 */
export async function preserveFocus(root, fn) {
	const active = document.activeElement;
	const key = active && root.contains(active) ? focusKey(active) : null;
	await fn();
	if (!key) return;
	const again = root.querySelector(key);
	if (again && document.activeElement !== again) again.focus({ preventScroll: true });
}

/** (uso do app) Lê e limpa o pedido de foco. */
export function takePendingFocus() {
	const k = pendingFocusKey;
	pendingFocusKey = null;
	return k;
}

/**
 * Abas internas de uma área (tablist compacto, arredondado). Cada aba é um link para uma
 * sub-rota; setas ←/→, Home e End trocam de aba (ativação automática).
 * @param {Array<{ id: string, label: string, href: string, icon?: string }>} items
 * @param {string} active - id da aba atual
 * @param {{ label?: string }} [opts] - nome acessível do grupo de abas
 */
export function subnav(items, active, { label = "Seções" } = {}) {
	const list = h("div", { class: "subnav", role: "tablist", "aria-label": label });
	for (const it of items) {
		const selected = it.id === active;
		list.append(
			h(
				"a",
				{
					class: "subnav-tab",
					role: "tab",
					href: it.href,
					"aria-selected": String(selected),
					tabindex: selected ? "0" : "-1",
					"data-key": `subnav-${it.id}`,
					"data-tab": it.id
				},
				it.icon ? icon(it.icon) : null,
				it.label
			)
		);
	}
	list.addEventListener("keydown", (ev) => {
		const tabs = [...list.querySelectorAll('[role="tab"]')];
		const i = tabs.indexOf(document.activeElement);
		if (i < 0) return;
		let next = null;
		if (ev.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
		else if (ev.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
		else if (ev.key === "Home") next = tabs[0];
		else if (ev.key === "End") next = tabs[tabs.length - 1];
		else if (ev.key === " ") next = tabs[i];
		if (!next) return;
		ev.preventDefault();
		focusAfterRender(next.dataset.key);
		next.focus();
		if (location.hash !== next.getAttribute("href")) location.hash = next.getAttribute("href");
	});
	return list;
}

/**
 * Link para outro painel, em outra aba, com "↗". Sem href, vira texto desabilitado com a dica
 * de configuração por escrito (ex. "defina ADMIN_GRAFANA_URL no .env").
 * @param {string|null} href
 * @param {string} label
 * @param {{ missing?: string|null, button?: boolean, quiet?: boolean }} [opts]
 */
export function externalLink(href, label, { missing, button = false, quiet = false } = {}) {
	const cls = button ? `btn${quiet ? " btn-quiet" : ""}` : "ext-link";
	if (!href) {
		const hint = missing ? configHint(missing) : "sem endereço configurado";
		return h(
			"span",
			{ class: `${cls} is-disabled`, "aria-disabled": "true", title: hint },
			label,
			h("span", { class: "ext-hint", text: ` (${hint})` })
		);
	}
	return h(
		"a",
		{ class: cls, href, target: "_blank", rel: "noopener" },
		label,
		h("span", { class: "ext", "aria-hidden": "true", text: " ↗" }),
		srOnly(" (abre em outra aba)")
	);
}

/* ── Formulários ───────────────────────────────────────────────── */

let fieldSeq = 0;

/**
 * Campo com rótulo visível (o rótulo envolve o controle: label.control é o input).
 * type: text | number | search | url | datetime-local | date | textarea | select | checkbox...
 * Em toque os campos têm 16 px (o iOS não dá zoom). wide: ocupa a linha inteira no form().
 * @param {{ label: string, name?: string, type?: string, value?: any, placeholder?: string,
 *   hint?: string, required?: boolean, options?: Array<string|{value: string, label: string}>,
 *   rows?: number, wide?: boolean, attrs?: Object }} o
 * @returns {HTMLLabelElement}
 */
export function field(o) {
	const id = `f-${++fieldSeq}`;
	const type = o.type || "text";
	let control;
	const common = { id, name: o.name || null, required: o.required || null, ...(o.attrs || {}) };
	if (type === "textarea") {
		control = h("textarea", { ...common, rows: o.rows || 3, placeholder: o.placeholder || null });
		control.value = o.value ?? "";
	} else if (type === "select") {
		control = h(
			"select",
			common,
			(o.options || []).map((opt) => {
				const value = typeof opt === "object" ? opt.value : opt;
				const text = typeof opt === "object" ? opt.label : opt;
				return h("option", {
					value: String(value),
					text,
					selected: String(value) === String(o.value ?? "")
				});
			})
		);
	} else {
		control = h("input", { ...common, type, placeholder: o.placeholder || null });
		if (type === "checkbox") control.checked = !!o.value;
		else if (o.value !== undefined && o.value !== null) control.value = String(o.value);
	}
	const hintEl = o.hint ? h("span", { class: "fld-hint", id: `${id}-hint`, text: o.hint }) : null;
	if (hintEl) control.setAttribute("aria-describedby", hintEl.id);
	return h(
		"label",
		{ class: `fld${o.wide ? " wide" : ""}${type === "checkbox" ? " fld-check" : ""}`, for: id },
		type === "checkbox"
			? [control, h("span", { text: o.label })]
			: [h("span", { class: "fld-label", text: o.label }), control],
		hintEl
	);
}

/**
 * Formulário em grade com botão de enviar. onSubmit recebe os valores (objeto por name;
 * checkbox → boolean) e pode ser async: o botão fica desabilitado e com "Salvando…" enquanto
 * isso; um erro vira toast e o formulário continua preenchido.
 * @param {{ fields: HTMLElement[], submitLabel?: string, onSubmit: (values: Object, form: HTMLFormElement) => any,
 *   onCancel?: () => void, cancelLabel?: string, busyLabel?: string }} o
 */
export function form(o) {
	const submit = h("button", {
		class: "btn btn-primary",
		type: "submit",
		text: o.submitLabel || "Salvar"
	});
	const el = h(
		"form",
		{ class: "form", novalidate: null },
		o.fields,
		h(
			"div",
			{ class: "form-actions" },
			submit,
			o.onCancel
				? h("button", {
						type: "button",
						class: "btn btn-quiet",
						text: o.cancelLabel || "Cancelar",
						onclick: o.onCancel
					})
				: null
		)
	);
	el.addEventListener("submit", async (ev) => {
		ev.preventDefault();
		if (!el.reportValidity()) return;
		const values = {};
		for (const c of el.elements) {
			if (!c.name) continue;
			values[c.name] = c.type === "checkbox" ? c.checked : c.value;
		}
		const label = submit.textContent;
		submit.disabled = true;
		submit.textContent = o.busyLabel || "Salvando…";
		try {
			await o.onSubmit(values, el);
		} catch (err) {
			toast(err && err.message ? err.message : "Não deu certo", { kind: "error" });
		} finally {
			if (submit.isConnected) {
				submit.disabled = false;
				submit.textContent = label;
			}
		}
	});
	return el;
}

/** Atraso: debounce(fn, 250) chama fn só depois de 250 ms sem novas chamadas. */
export function debounce(fn, ms = 250) {
	let t = null;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

/**
 * Busca com rótulo (visível ou só para leitor de tela) e debounce.
 * @param {{ label: string, placeholder?: string, value?: string, onSearch: (q: string) => void,
 *   delay?: number, visibleLabel?: boolean, key?: string }} o
 */
export function searchBox(o) {
	const id = `q-${++fieldSeq}`;
	const input = h("input", {
		id,
		type: "search",
		placeholder: o.placeholder || "",
		autocomplete: "off",
		spellcheck: "false",
		"data-key": o.key || "busca"
	});
	input.value = o.value || "";
	const run = debounce(() => o.onSearch(input.value.trim()), o.delay ?? 250);
	input.addEventListener("input", run);
	input.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") {
			ev.preventDefault();
			o.onSearch(input.value.trim());
		}
	});
	return h(
		"div",
		{ class: "search" },
		h("label", { for: id, class: o.visibleLabel ? "fld-label" : "sr-only", text: o.label }),
		h("span", { class: "search-box" }, icon("busca"), input)
	);
}

/**
 * Roda fn com o botão ocupado: aria-busy (sem `disabled`, que tira o foco e ele não volta),
 * cliques repetidos ignorados e, com `label`, girando com o rótulo de espera. O
 * conteúdo original volta no fim. Erro vira toast.
 *   btn.onclick = () => busy(btn, "Rodando…", () => send("POST", "/api/x/run"));
 * @param {HTMLElement} btn
 * @param {string|null} label - rótulo de espera (null mantém o conteúdo do botão)
 * @param {() => any} fn
 * @returns {Promise<boolean>} se deu certo (false também quando o botão já estava ocupado)
 */
export async function busy(btn, label, fn) {
	if (btn.getAttribute("aria-busy") === "true" || btn.getAttribute("aria-disabled") === "true")
		return false;
	const kids = label ? [...btn.childNodes] : null;
	btn.setAttribute("aria-busy", "true");
	if (label) btn.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), label);
	try {
		await fn();
		return true;
	} catch (err) {
		toast(err && err.message ? err.message : "Não deu certo", { kind: "error" });
		return false;
	} finally {
		btn.removeAttribute("aria-busy");
		if (kids) btn.replaceChildren(...kids);
	}
}

/**
 * Copia um texto para a área de transferência, com aviso. Se o navegador bloquear e houver um
 * campo (`select`), o texto fica selecionado nele para Ctrl+C.
 * @param {string} text
 * @param {{ ok?: string, select?: HTMLInputElement|HTMLTextAreaElement }} [opts] - ok: aviso
 * @returns {Promise<boolean>}
 */
export async function copyText(text, { ok = "Copiado", select } = {}) {
	try {
		await navigator.clipboard.writeText(text);
		toast(ok, { kind: "ok" });
		return true;
	} catch {
		if (select) {
			select.focus();
			select.select();
			const done = document.execCommand && document.execCommand("copy");
			toast(done ? ok : "Texto selecionado: copie com Ctrl+C", { kind: done ? "ok" : "" });
			return !!done;
		}
		toast("Não deu para copiar (o navegador bloqueou a área de transferência)", {
			kind: "error"
		});
		return false;
	}
}

/**
 * Confirmação no próprio lugar do botão: o botão some e aparece "pergunta · Não · <ação>".
 * "Não" e Esc cancelam (o foco volta ao botão); a ação perigosa chama onConfirm (pode ser
 * async: fica "…" até terminar). Nunca window.confirm.
 * - question: texto ou função (lida a cada clique, ex. "e mais 2 instâncias");
 * - content: função que monta algo a mais entre a pergunta e os botões (ex. um field() com o
 *   valor a confirmar). Com content, a caixa vira bloco, o 1º campo ganha o foco e Enter num
 *   campo de uma linha confirma. onConfirm recebe a caixa (para ler o campo) e pode devolver
 *   false para continuar aberta (valor inválido: avise e devolva false);
 * - label: nome acessível do grupo (padrão: a pergunta).
 * Para a confirmação ocupar a barra inteira de ações, ponha a classe .confirm-bar no pai.
 * @param {HTMLButtonElement} trigger
 * @param {{ question: string|(() => string), confirmLabel: string, cancelLabel?: string,
 *   danger?: boolean, content?: () => Node, label?: string, class?: string,
 *   onConfirm: (box: HTMLElement) => any }} o
 * @returns {HTMLButtonElement} o próprio trigger (para encadear no h())
 */
export function confirmInline(trigger, o) {
	trigger.addEventListener("click", () => {
		const question = typeof o.question === "function" ? o.question() : o.question;
		const extra = typeof o.content === "function" ? o.content() : null;
		const cancel = h("button", {
			type: "button",
			class: "btn btn-quiet",
			text: o.cancelLabel || "Não"
		});
		const go = h("button", {
			type: "button",
			class: `btn${o.danger === false ? " btn-primary" : " btn-danger"}`,
			text: o.confirmLabel
		});
		const cls = `confirm${extra ? " confirm-block" : ""}${o.class ? ` ${o.class}` : ""}`;
		const box = extra
			? h(
					"div",
					{ class: cls, role: "group", "aria-label": o.label || question },
					h("span", { class: "q", text: question }),
					extra,
					h("span", { class: "confirm-btns" }, cancel, go)
				)
			: h(
					"span",
					{ class: cls, role: "group", "aria-label": o.label || question },
					h("span", { class: "q", text: question }),
					cancel,
					go
				);
		const restore = () => {
			box.replaceWith(trigger);
			trigger.focus();
		};
		cancel.addEventListener("click", restore);
		box.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") {
				ev.preventDefault();
				restore();
			} else if (
				ev.key === "Enter" &&
				extra &&
				ev.target instanceof HTMLInputElement &&
				extra.contains(ev.target)
			) {
				ev.preventDefault();
				go.click();
			}
		});
		go.addEventListener("click", async () => {
			if (go.disabled) return;
			go.disabled = true;
			cancel.disabled = true;
			const label = go.textContent;
			go.textContent = "…";
			const reopen = () => {
				go.disabled = false;
				cancel.disabled = false;
				go.textContent = label;
			};
			try {
				const r = await o.onConfirm(box);
				if (r === false) {
					if (box.isConnected) reopen();
				} else if (box.isConnected) box.replaceWith(trigger);
			} catch (err) {
				toast(err && err.message ? err.message : "Não deu certo", { kind: "error" });
				if (box.isConnected) reopen();
			}
		});
		trigger.replaceWith(box);
		const firstField = extra && extra.querySelector("input, textarea, select");
		if (firstField) {
			firstField.focus();
			if (typeof firstField.select === "function") firstField.select();
		} else cancel.focus();
	});
	return trigger;
}

/* ── Tabela que vira cartões ───────────────────────────────────── */

/**
 * Tabela de dados. Em largura estreita (container < 34rem) cada linha vira um cartão com o
 * rótulo da coluna antes de cada valor.
 * @param {Array<{ label: string, value: (row: any) => any, num?: boolean, primary?: boolean,
 *   class?: string }>} columns - primary: vira o título do cartão no modo estreito (padrão: a 1ª)
 * @param {Array<any>} rowsData
 * @param {{ empty?: string, caption?: string, rowHref?: (row: any) => string|null,
 *   rowClass?: (row: any) => string|null }} [opts]
 */
export function dataTable(columns, rowsData, opts = {}) {
	if (!rowsData || !rowsData.length) return empty(opts.empty || "Nada para mostrar ainda.");
	const primary = Math.max(
		0,
		columns.findIndex((c) => c.primary)
	);
	const table = h(
		"table",
		{ class: "dt" },
		opts.caption ? h("caption", { class: "sr-only", text: opts.caption }) : null,
		h(
			"thead",
			null,
			h(
				"tr",
				null,
				columns.map((c) => h("th", { scope: "col", class: c.num ? "num" : null, text: c.label }))
			)
		),
		h(
			"tbody",
			null,
			rowsData.map((row) => {
				const href = opts.rowHref ? opts.rowHref(row) : null;
				return h(
					"tr",
					{
						class:
							[href ? "click" : null, opts.rowClass ? opts.rowClass(row) : null]
								.filter(Boolean)
								.join(" ") || null
					},
					columns.map((c, i) => {
						let v = c.value(row);
						if (href && i === primary && !(v instanceof Node))
							v = h("a", { href, text: String(v ?? "—") });
						return h(
							"td",
							{
								class:
									[c.num ? "num" : null, i === primary ? "primary" : null, c.class || null]
										.filter(Boolean)
										.join(" ") || null,
								"data-label": c.label
							},
							v instanceof Node ? v : String(v ?? "—")
						);
					})
				);
			})
		)
	);
	if (opts.rowHref) {
		// A linha inteira é clicável; o link da 1ª coluna continua sendo o alvo de teclado.
		table.addEventListener("click", (ev) => {
			const tr = ev.target instanceof Element ? ev.target.closest("tr.click") : null;
			if (
				!tr ||
				(ev.target instanceof Element && ev.target.closest("a, button, input, select, textarea"))
			)
				return;
			const a = tr.querySelector("td.primary a");
			if (a) a.click();
		});
	}
	return h("div", { class: "dt-wrap" }, table);
}

/* ── Tempo ─────────────────────────────────────────────────────── */

/**
 * Repete fn a cada ms só com a aba visível; ao voltar para a aba, roda na hora se já passou
 * do tempo. Não roda na chamada (a área já carregou). Devolve a função de parar — devolva-a
 * (ou chame-a) na limpeza da área.
 * @param {() => any} fn
 * @param {number} ms
 * @returns {() => void}
 */
export function poll(fn, ms) {
	let last = Date.now();
	let stopped = false;
	const tick = () => {
		if (stopped || document.hidden) return;
		last = Date.now();
		Promise.resolve()
			.then(fn)
			.catch(() => {});
	};
	const timer = setInterval(tick, ms);
	const onVis = () => {
		if (!document.hidden && Date.now() - last >= ms) tick();
	};
	document.addEventListener("visibilitychange", onVis);
	return () => {
		stopped = true;
		clearInterval(timer);
		document.removeEventListener("visibilitychange", onVis);
	};
}

/* ── Links dos outros painéis (GET /api/admin/links) ────────────── */

let linksPromise = null;
let linksData = null;

/**
 * Marca de "não deu para ler /api/admin/links" (falha ou ainda sem resposta), no lugar do nome
 * da variável do .env: o motivo é outro e configHint() diz isso por escrito.
 */
export const LINKS_UNAVAILABLE = "LINKS_UNAVAILABLE";

/**
 * Dica por escrito de um link desabilitado: "defina X no .env", ou, se os endereços não
 * puderam ser lidos, "não deu para carregar os endereços".
 * @param {string} missing - nome da variável ou LINKS_UNAVAILABLE
 */
export const configHint = (missing) =>
	missing === LINKS_UNAVAILABLE
		? "não deu para carregar os endereços"
		: `defina ${missing} no .env`;

/** A última leitura dos endereços falhou (e nenhuma anterior deu certo). */
export const linksFailed = () => !!(linksData && linksData.failed);

/**
 * Lê (uma vez por visita) os endereços do Grafana, do admin do Waifuletes e do super-admin
 * do Jardim. Falha → objeto vazio marcado `failed` (os itens aparecem desabilitados com
 * "não deu para carregar os endereços"), e a falha não fica guardada: a próxima chamada (o app
 * chama a cada navegação enquanto falhar) tenta de novo.
 * @returns {Promise<{ grafana: { base: string|null, dashboards: Object, missing: string|null },
 *   panels: Array<{ id: string, title: string, sub: string, kind: string, url: string|null, missing: string|null }> }>}
 */
export function getLinks() {
	if (!linksPromise) {
		const p = api("/api/admin/links", { fresh: true })
			.then((d) => {
				linksData = d;
				return d;
			})
			.catch(() => {
				if (linksPromise === p) linksPromise = null;
				// Uma leitura boa anterior continua valendo; senão, marca a falha.
				if (!linksData || linksData.failed)
					linksData = {
						failed: true,
						grafana: { base: null, dashboards: {}, missing: LINKS_UNAVAILABLE },
						panels: []
					};
				return linksData;
			});
		linksPromise = p;
	}
	return linksPromise;
}

/**
 * URL de um painel do Grafana com parâmetros, ou null se ADMIN_GRAFANA_URL não está definido.
 * Painéis: economia, jogador, red, llm. Só funciona depois de getLinks() (o app já espera).
 *   grafanaLink("economia", { dtab: "moeda" })
 *   grafanaLink("jogador", { "var-jogador": pessoaId })
 * @param {"economia"|"jogador"|"red"|"llm"} name
 * @param {Object} [params]
 * @returns {string|null}
 */
export function grafanaLink(name, params) {
	const d =
		linksData &&
		linksData.grafana &&
		linksData.grafana.dashboards &&
		linksData.grafana.dashboards[name];
	return d && d.url ? withParams(d.url, params) : null;
}

/**
 * Variável que falta para os links do Grafana ("ADMIN_GRAFANA_URL"), LINKS_UNAVAILABLE quando
 * os endereços não puderam ser lidos, ou null. Mostre com configHint().
 */
export const grafanaMissing = () =>
	linksData && linksData.grafana ? linksData.grafana.missing : LINKS_UNAVAILABLE;

/** Itens de "Outros painéis" (depois de getLinks()). */
export const panelLinks = () => (linksData && linksData.panels) || [];

/* ── Tema (auto | claro | escuro) ─────────────────────────────── */

const THEME_KEY = "ravena-admin-theme";
const THEMES = ["auto", "light", "dark"];
const THEME_LABEL = { auto: "Auto", light: "Claro", dark: "Escuro" };
let theme = "auto";

const validTheme = (t) => (THEMES.includes(t) ? t : null);

/**
 * Aplica e (por padrão) salva o tema. "auto" segue o sistema.
 * @param {"auto"|"light"|"dark"} choice
 * @param {{ save?: boolean }} [opts]
 */
export function applyTheme(choice, { save = true } = {}) {
	theme = validTheme(choice) || "auto";
	if (theme === "auto") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = theme;
	document.querySelectorAll("[data-theme-choice]").forEach((b) => {
		b.setAttribute("aria-pressed", String(b.dataset.themeChoice === theme));
	});
	if (!save) return;
	try {
		if (theme === "auto") localStorage.removeItem(THEME_KEY);
		else localStorage.setItem(THEME_KEY, theme);
	} catch {
		/* sem armazenamento: vale só nesta visita */
	}
}

/** (uso do app) Tema inicial: ?theme= desta visita, senão o salvo, senão auto. */
export function initTheme() {
	let fromUrl = null;
	try {
		fromUrl = validTheme(new URLSearchParams(location.search).get("theme"));
	} catch {
		fromUrl = null;
	}
	let saved = null;
	try {
		saved = validTheme(localStorage.getItem(THEME_KEY));
	} catch {
		saved = null;
	}
	applyTheme(fromUrl || saved || "auto", { save: false });
}

/** Segmentado Auto · Claro · Escuro (pode haver mais de um na tela; ficam em sincronia). */
export function themeSwitch() {
	return h(
		"div",
		{ class: "seg seg-theme", role: "group", "aria-label": "Tema" },
		THEMES.map((t) =>
			h("button", {
				type: "button",
				"data-theme-choice": t,
				"aria-pressed": String(t === theme),
				text: THEME_LABEL[t],
				onclick: () => applyTheme(t)
			})
		)
	);
}
