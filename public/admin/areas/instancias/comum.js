/*
 * Instâncias: peças com DOM compartilhadas pelas telas da área (rascunhos, ações no servidor,
 * mensagens de falha por escrito, prévia do markup do WhatsApp, CSS da área).
 */

import {
	h,
	api,
	send,
	toast,
	buildHash,
	HttpError,
	httpReason,
	invalidate,
	notifySessionExpired
} from "../../core.js";
import {
	formValues,
	applyConfig,
	extrasToRows,
	rowsToExtras,
	buildSaveList,
	validateBots,
	actionOutcome,
	parseWaMarkup
} from "./modelo.js";

/* ── Rotas da área ─────────────────────────────────────────────── */

// "nova" e "avisos" são reservados: uma instância com esses nomes não teria ficha própria.
export const listHref = (params) => buildHash("instancias", [], params);
export const botHref = (nome, tab) => buildHash("instancias", tab ? [nome, tab] : [nome]);

/* ── Leitura ───────────────────────────────────────────────────── */

export const loadBots = (fresh = false) =>
	api("/api/bots", { fresh }).then((d) => {
		if (!Array.isArray(d)) throw new Error("resposta inesperada do servidor (esperava uma lista)");
		return d;
	});

/* ── Falhas por escrito ────────────────────────────────────────── */

/**
 * Mensagem completa de uma falha: o motivo do kit (401/403/409/429…) e, nos erros 5xx, também
 * a mensagem do servidor (err.serverMessage). what: "reiniciar a ravena-1".
 */
export function explain(err, what) {
	const base =
		err && err.status === 401 && err.sessionExpired
			? "a sessão do painel expirou (HTTP 401)"
			: err && err.message
				? err.message
				: "erro desconhecido";
	// O kit guarda a mensagem do servidor em serverMessage (nos 5xx ela não entra no message).
	const server = err && err.serverMessage;
	const extra = server && err.status >= 500 && !base.includes(server) ? `: ${server}` : "";
	let hint = "";
	if (err && err.status === 401 && err.sessionExpired) hint = ": entre de novo no painel";
	else if (err && err.status === 404 && what)
		hint = " (a instância está no bots.json, mas não foi carregada por este processo)";
	if (err && err.status === 0) hint = " (sem resposta: a conexão caiu ou o servidor está fora)";
	return `Não foi possível ${what || "concluir"}: ${base}${extra}${hint}.`;
}

/** Caixa de aviso no lugar (fica na tela até a próxima ação, diferente do toast). */
export function outcomeBox() {
	const box = h("div", { class: "inst-outcome", role: "status", "aria-live": "polite" });
	box.hidden = true;
	return {
		el: box,
		set(kind, text) {
			box.hidden = !text;
			box.className = `notice inst-outcome${kind === "error" ? " error" : ""}`;
			box.replaceChildren(h("span", { text }));
		},
		clear() {
			box.hidden = true;
			box.replaceChildren();
		}
	};
}

/**
 * GET JSON numa rota de instância (/restart, /logout, /qrcode-*, /reconnect, /recreate). Desde
 * que as rotas :botId aceitam a sessão do admin (authenticateBasic com isAdmin), o cookie do
 * painel basta: a credencial da instância (managementUser/managementPW) não vai mais em
 * cabeçalho nem em ?auth=. Lança HttpError; um 401 é sessão expirada (mostra a faixa).
 * @param {Object} bot - a instância (mantido na assinatura; a credencial dela não é usada)
 */
export async function botFetch(bot, path) {
	const headers = { Accept: "application/json" };
	let res;
	try {
		res = await fetch(path, { credentials: "same-origin", headers, cache: "no-store" });
	} catch {
		throw new HttpError(0, httpReason(0));
	}
	let body = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	if (!res.ok) {
		const serverMsg = body && typeof body.message === "string" ? body.message : null;
		const reason = httpReason(res.status);
		const err = new HttpError(
			res.status,
			serverMsg && res.status !== 401 && res.status < 500 ? `${reason}: ${serverMsg}` : reason,
			body
		);
		if (res.status === 401) {
			err.sessionExpired = true;
			notifySessionExpired();
		}
		throw err;
	}
	return body;
}

/**
 * Ação GET de instância (/restart, /logout, /reconnect, /recreate). Considera o status "error"
 * do corpo (o /restart responde 200 nesse caso) e lança Error com a explicação por escrito.
 * @returns {Promise<string>} mensagem do servidor
 */
export async function botAction(bot, path, what) {
	let json;
	try {
		json = await botFetch(bot, path);
	} catch (err) {
		throw Object.assign(new Error(explain(err, what)), { body: err.body });
	}
	invalidate("/api/bots");
	const r = actionOutcome(json);
	if (!r.ok)
		throw new Error(
			`Não foi possível ${what}: o servidor respondeu "${r.message || "erro sem detalhe"}".`
		);
	return r.message;
}

/* ── Rascunhos (sobrevivem à troca de aba; perdem-se ao recarregar a página) ── */

/** nome → { base, values, extras, dirty, isNew } */
const drafts = new Map();

export function getDraft(bot) {
	let d = drafts.get(bot.nome);
	if (!d) {
		d = {
			base: bot,
			values: formValues(bot),
			extras: extrasToRows(bot.extras),
			dirty: false,
			isNew: false
		};
		drafts.set(bot.nome, d);
	} else if (!d.dirty && !d.isNew) {
		// Sem edição pendente: acompanha o servidor.
		d.base = bot;
		d.values = formValues(bot);
		d.extras = extrasToRows(bot.extras);
	}
	return d;
}

export function addNewDraft(bot) {
	const d = {
		base: bot,
		values: formValues(bot),
		extras: extrasToRows(bot.extras),
		dirty: true,
		isNew: true
	};
	drafts.set(bot.nome, d);
	return d;
}

export const peekDraft = (nome) => drafts.get(nome) || null;
export const dropDraft = (nome) => drafts.delete(nome);
export const pendingDrafts = () => [...drafts.entries()].filter(([, d]) => d.dirty);

export function markDirty(d) {
	d.dirty = true;
	window.dispatchEvent(new CustomEvent("instancias:dirty"));
}

/** Saída da página com rascunho pendente: o navegador pergunta (como na tela antiga). */
window.addEventListener("beforeunload", (ev) => {
	if (pendingDrafts().length) {
		ev.preventDefault();
		ev.returnValue = "";
	}
});

let saveQueue = Promise.resolve(); // fila de gravação do bots.json (ver saveAll)

/**
 * Grava o bots.json (o POST leva a lista inteira). Sem patch: lista atual do servidor + todos os
 * rascunhos pendentes, que são limpos. Com patch (Desativar/Reativar): só aqueles campos sobre a
 * lista atual; os rascunhos ficam como estão, sem ir junto. Valida antes.
 * As gravações entram numa fila: nunca dois POST da lista inteira em paralelo; a próxima espera
 * a anterior e parte do que ela gravou (lê a lista de novo).
 * @param {{ patch?: Object<string, Object> }} [o] - nome → campos a sobrescrever
 * @returns {Promise<{ saved: string[], message: string, finalName: Object<string, string> }>}
 *   finalName: nome do rascunho novo → nome gravado (o identificador pode ter sido trocado)
 */
export function saveAll(o = {}) {
	const run = saveQueue.then(() => saveAllNow(o));
	saveQueue = run.catch(() => {});
	return run;
}

async function saveAllNow({ patch = {} } = {}) {
	let current;
	try {
		current = await loadBots(true);
	} catch (err) {
		throw new Error(explain(err, "ler a lista atual antes de salvar"));
	}
	const onlyPatch = Object.keys(patch).length > 0;
	const pend = onlyPatch ? [] : pendingDrafts();
	const edited = new Map();
	const added = [];
	const finalName = {};
	for (const [nome, d] of pend) {
		const applied = applyConfig(d.base, d.values, rowsToExtras(d.extras));
		if (d.isNew) {
			if (current.some((b) => b.nome === applied.nome))
				throw new Error(
					`Já existe uma instância chamada '${applied.nome}'. Troque o identificador.`
				);
			added.push(applied);
			finalName[nome] = applied.nome;
		} else edited.set(nome, applied);
	}
	for (const [nome, fields] of Object.entries(patch)) {
		const base = edited.get(nome) || current.find((b) => b.nome === nome);
		if (!base) throw new Error(`A instância '${nome}' não está mais na lista do servidor.`);
		edited.set(nome, { ...base, ...fields });
	}
	const list = buildSaveList(current, edited, added);
	const problem = validateBots(list);
	if (problem) throw new Error(`Não salvei: ${problem}`);
	let res;
	try {
		res = await send("POST", "/api/bots", list);
	} catch (err) {
		throw new Error(explain(err, "salvar o bots.json"));
	}
	// O rascunho pendente da instância alterada acompanha o campo (senão o desfaria ao salvar).
	for (const [nome, fields] of Object.entries(patch)) {
		const d = drafts.get(nome);
		if (d && "enabled" in fields) d.values.enabled = !!fields.enabled;
	}
	const saved = pend.map(([n]) => n);
	for (const n of saved) drafts.delete(n);
	window.dispatchEvent(new CustomEvent("instancias:dirty"));
	return {
		saved,
		message: (res && res.message) || "Configurações salvas.",
		finalName
	};
}

/* ── Prévia do markup do WhatsApp (DOM, sem innerHTML) ─────────── */

function nodeToDom(n) {
	if (typeof n === "string") return document.createTextNode(n);
	switch (n.t) {
		case "br":
			return h("br");
		case "pre":
			return h("pre", null, h("code", { text: n.text }));
		case "code":
			return h("code", { text: n.text });
		case "a":
			return h("a", { href: n.href, target: "_blank", rel: "noopener noreferrer", text: n.text });
		case "quote":
			return h("blockquote", null, n.c.map(nodeToDom));
		case "b":
			return h("strong", null, n.c.map(nodeToDom));
		case "i":
			return h("em", null, n.c.map(nodeToDom));
		case "s":
			return h("del", null, n.c.map(nodeToDom));
		default:
			return document.createTextNode("");
	}
}

export const waMarkup = (text) =>
	h("div", { class: "wa-preview" }, parseWaMarkup(text).map(nodeToDom));

export { toast };
