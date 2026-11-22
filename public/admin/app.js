/*
 * Casca do painel de admin unificado (/admin): roteador por hash, menu lateral, barra inferior
 * do celular, tema e o resumo do topo ("N precisam de você"). As telas ficam em areas/<id>.js
 * (registro em areas/index.js); o kit em core.js.
 *
 * Rotas: #/<área>/<seg1>/<seg2>...?param=valor. Trocar de sub-rota dentro da mesma área
 * redesenha só o conteúdo (ou chama area.update(ctx), se a área tratar sozinha), sem levar o
 * foco nem a rolagem para o topo.
 */

import {
	h,
	icon,
	srOnly,
	fmt,
	loading,
	errorNotice,
	parseHash,
	invalidate,
	initTheme,
	themeSwitch,
	getLinks,
	panelLinks,
	configHint,
	linksFailed,
	onSessionExpired,
	poll,
	focusKey,
	takePendingFocus
} from "./core.js";
import { AREAS, GROUPS, PRIMARY, HASH_ALIASES } from "./areas/index.js";
import { loadPulse } from "./pulse.js";

const main = document.getElementById("main");
const byId = new Map(AREAS.map((a) => [a.id, a]));

/* ── Entrada por ?auth=…: o servidor já responde 302 sem ele; isto fica de reserva ── */

(() => {
	const params = new URLSearchParams(location.search);
	if (!params.has("auth")) return;
	params.delete("auth");
	const qs = params.toString();
	history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
})();

/* ── Menu lateral ─────────────────────────────────────────────── */

function navLink(a) {
	return h(
		"a",
		{ class: "nav-item", href: `#/${a.id}`, "data-area": a.id },
		icon(a.icon || a.id),
		h("span", { class: "nav-text", text: a.title }),
		h("span", { class: "nav-badge", hidden: true })
	);
}

function buildSidebar() {
	const nav = document.getElementById("sidebar");
	for (const group of GROUPS) {
		const items = AREAS.filter((a) => a.group === group && a.nav !== false);
		if (!items.length) continue;
		nav.append(
			h(
				"div",
				{ class: "nav-group" },
				h("p", { class: "label", text: group }),
				h(
					"ul",
					{ class: "nav-list" },
					items.map((a) => h("li", null, navLink(a)))
				)
			)
		);
	}
	nav.append(h("div", { class: "nav-group nav-ext", id: "nav-ext" }));
}

/** "Outros painéis": abrem em outra aba; sem endereço no .env, aparecem desabilitados. */
function buildExternalNav() {
	const box = document.getElementById("nav-ext");
	const panels = panelLinks();
	if (!box || !panels.length) return;
	const missing = [...new Set(panels.filter((p) => !p.url && p.missing).map((p) => p.missing))];
	box.replaceChildren(
		h("p", { class: "label", text: "Outros painéis" }),
		h(
			"ul",
			{ class: "nav-list" },
			panels.map((p) => {
				const meta =
					p.kind === "grafana" ? "Grafana" : p.kind === "waifuletes" ? "admin" : "super-admin";
				return h(
					"li",
					null,
					p.url
						? h(
								"a",
								{ class: "nav-item nav-out", href: p.url, target: "_blank", rel: "noopener" },
								h("span", { class: "nav-text", text: p.title }),
								h("span", { class: "nav-meta", "aria-hidden": "true", text: `${meta} ↗` }),
								srOnly(` (${meta}, abre em outra aba)`)
							)
						: h(
								"span",
								{
									class: "nav-item nav-out is-disabled",
									"aria-disabled": "true",
									title: configHint(p.missing)
								},
								h("span", { class: "nav-text", text: p.title }),
								h("span", { class: "nav-meta", text: "sem endereço" })
							)
				);
			})
		),
		// replaceChildren(null) escreveria "null" na tela quando tudo está configurado
		...(missing.length
			? [h("p", { class: "nav-hint", text: `Para ligar, defina no .env: ${missing.join(", ")}.` })]
			: [])
	);
}

/* ── Barra inferior (celular) ─────────────────────────────────── */

function buildBottomNav() {
	const bar = document.getElementById("bottombar");
	const items = PRIMARY.map((id) => byId.get(id)).filter(Boolean);
	bar.append(
		...items.map((a) =>
			h(
				"a",
				{ class: "bottom-item", href: `#/${a.id}`, "data-area": a.id },
				icon(a.icon || a.id),
				h("span", { class: "bottom-text", text: a.short || a.title }),
				h("span", { class: "bottom-badge", hidden: true })
			)
		),
		h(
			"a",
			{ class: "bottom-item", href: "#/mais", "data-area": "mais", id: "more-open" },
			icon("mais"),
			h("span", { class: "bottom-text", text: "Mais" }),
			h("span", { class: "bottom-badge", hidden: true })
		)
	);
}

function markCurrent(area) {
	document.querySelectorAll(".nav-item[data-area], .bottom-item[data-area]").forEach((a) => {
		const current =
			a.dataset.area === area.id || (a.dataset.area === "mais" && !PRIMARY.includes(area.id));
		if (current) a.setAttribute("aria-current", "page");
		else a.removeAttribute("aria-current");
	});
	// Item atual visível no menu, sem scrollIntoView (que no Chrome também move o ponto de
	// partida do Tab para o menu e o "Pular para o conteúdo" deixaria de ser o 1º Tab).
	const navItem = document.querySelector(`.nav-item[data-area="${area.id}"]`);
	const nav = document.getElementById("sidebar");
	if (navItem && nav && nav.scrollHeight > nav.clientHeight) {
		const top =
			navItem.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop;
		if (top < nav.scrollTop || top + navItem.offsetHeight > nav.scrollTop + nav.clientHeight) {
			nav.scrollTop = Math.max(0, top - nav.clientHeight / 3);
		}
	}
}

/* ── Roteador ─────────────────────────────────────────────────── */

const router = {
	area: null,
	token: 0,
	cleanup: null,
	abort: null,
	headSlot: null,
	root: null,
	ctx: null
};

function layoutOf(area, ctx) {
	const l = typeof area.layout === "function" ? area.layout(ctx) : area.layout;
	return l === "fill" ? l : "page";
}

function navigate(hash, { replace = false } = {}) {
	if (replace) {
		history.replaceState(null, "", hash);
		route();
	} else if (location.hash !== hash) location.hash = hash;
	else route();
}

function makeCtx(parsed, extra = {}) {
	return {
		segs: parsed.segs,
		params: parsed.params,
		areas: AREAS,
		primary: PRIMARY,
		navigate,
		refresh: () => refresh(),
		...extra
	};
}

function runCleanup() {
	if (router.abort) router.abort.abort();
	router.abort = null;
	if (typeof router.cleanup === "function") {
		try {
			router.cleanup();
		} catch {
			/* limpeza nunca derruba a navegação */
		}
	}
	router.cleanup = null;
}

function viewHead(area, headSlot) {
	return h(
		"div",
		{ class: "view-head" },
		h(
			"div",
			{ class: "view-titles" },
			h("h1", { class: "view-title", id: "view-title", text: area.title }),
			area.desc ? h("p", { class: "view-desc", text: area.desc }) : null
		),
		headSlot
	);
}

/**
 * Desenha a área. sameArea: troca só a cabeça de ações e o corpo quando o novo conteúdo
 * estiver pronto, guardando o foco e a rolagem.
 */
async function renderArea(area, parsed, { sameArea = false } = {}) {
	const token = ++router.token;
	const active = document.activeElement;
	const pending = takePendingFocus();
	const focusSel = sameArea
		? pending
			? `[data-key="${CSS.escape(pending)}"]`
			: active && main.contains(active)
				? focusKey(active)
				: null
		: null;

	runCleanup();
	router.area = area;
	const abort = new AbortController();
	router.abort = abort;

	const headSlot = h("div", { class: "view-actions" });
	const root = h("div", { class: "view-root", "data-view": area.id });
	const ctx = makeCtx(parsed, { head: headSlot, root, signal: abort.signal });
	router.ctx = ctx;

	markCurrent(area);
	document.title = `${area.title} · Ravena Admin`;
	document.body.dataset.view = area.id;

	let placeholder = null;
	let body;
	if (!sameArea || !router.root || !router.root.isConnected) {
		document.body.dataset.layout = layoutOf(area, ctx);
		placeholder = loading();
		body = h(
			"div",
			{ id: "view-body", "aria-busy": "true", "aria-labelledby": "view-title" },
			placeholder,
			root
		);
		main.replaceChildren(viewHead(area, headSlot), body);
		window.scrollTo(0, 0);
		if (router.started) main.focus({ preventScroll: true });
	} else {
		body = document.getElementById("view-body");
		body.setAttribute("aria-busy", "true");
	}

	let cleanup;
	try {
		cleanup = await area.render(root, ctx);
	} catch (err) {
		if (token === router.token) root.replaceChildren(errorNotice(err, area.title.toLowerCase()));
	}
	if (token !== router.token) {
		if (typeof cleanup === "function") cleanup();
		return;
	}
	router.cleanup = cleanup;
	if (placeholder) placeholder.remove();
	if (sameArea && router.root && router.root !== root && router.root.isConnected) {
		document.body.dataset.layout = layoutOf(area, ctx);
		router.headSlot.replaceWith(headSlot);
		router.root.replaceWith(root);
	}
	router.headSlot = headSlot;
	router.root = root;
	body.removeAttribute("aria-busy");

	if (focusSel) {
		const again = main.querySelector(focusSel);
		if (again) again.focus({ preventScroll: true });
		else if (!main.contains(document.activeElement)) main.focus({ preventScroll: true });
	}
}

async function route() {
	let hash = location.hash || "#/geral";
	// Âncora comum (ex. #main do "Pular para o conteúdo"), não é rota: fica na tela atual.
	if (!hash.startsWith("#/") && router.area) return;
	const alias = HASH_ALIASES[hash.split("?")[0]];
	if (alias) {
		history.replaceState(null, "", alias);
		hash = alias;
	}
	// Endereços dos outros painéis que falharam: tenta de novo a cada navegação, sem segurar a
	// tela (as áreas abertas depois já pegam os links).
	if (linksFailed())
		getLinks().then(() => {
			if (!linksFailed()) buildExternalNav();
		});
	const parsed = parseHash(hash);
	const area = byId.get(parsed.areaId);
	if (!area) {
		history.replaceState(null, "", "#/geral");
		return renderArea(byId.get("geral"), parseHash("#/geral"));
	}
	const sameArea = router.area === area;
	if (sameArea && typeof area.update === "function") {
		const ctx = makeCtx(parsed, {
			head: router.headSlot,
			root: router.root,
			signal: router.abort && router.abort.signal
		});
		let handled = false;
		try {
			handled = area.update(ctx) !== false;
		} catch {
			handled = false;
		}
		if (handled) {
			router.ctx = ctx;
			document.body.dataset.layout = layoutOf(area, ctx);
			return;
		}
	}
	return renderArea(area, parsed, { sameArea });
}

/** Lê tudo de novo (sem cache) e redesenha a área atual no lugar. */
function refresh() {
	invalidate();
	refreshPulse();
	if (router.area)
		return renderArea(router.area, parseHash(location.hash || "#/geral"), { sameArea: true });
}

window.addEventListener("hashchange", () => route());

/* ── Resumo do topo e contadores do menu ─────────────────────── */

async function refreshPulse() {
	let p;
	try {
		p = await loadPulse();
	} catch {
		return;
	}
	const link = document.getElementById("topbar-needs");
	if (link) {
		const n = p.actionable;
		const noData = p.botsError && p.servicesError;
		const state = noData ? "off" : n ? "attention" : "ok";
		const text = noData
			? "sem dado do estado"
			: n
				? `${fmt(n)} ${n === 1 ? "precisa" : "precisam"} de você`
				: "tudo em dia";
		link.dataset.state = state;
		link.replaceChildren(
			h("span", { class: "lamp", "data-state": state, "aria-hidden": "true" }),
			h("span", { class: "topbar-needs-text", text })
		);
	}
	let moreCount = 0;
	for (const a of AREAS) {
		let s = null;
		try {
			s = typeof a.summary === "function" ? a.summary(p) : null;
		} catch {
			s = null;
		}
		const count = (s && s.count) || 0;
		if (!PRIMARY.includes(a.id) && a.id !== "mais") moreCount += count;
		document
			.querySelectorAll(`[data-area="${a.id}"] .nav-badge, [data-area="${a.id}"] .bottom-badge`)
			.forEach((b) => setBadge(b, count));
	}
	const more = document.querySelector('[data-area="mais"] .bottom-badge');
	if (more) setBadge(more, moreCount);
}

function setBadge(el, count) {
	el.hidden = !count;
	el.textContent = count ? fmt(count) : "";
	if (count) el.setAttribute("aria-label", `${count} ${count === 1 ? "pede" : "pedem"} atenção`);
	else el.removeAttribute("aria-label");
}

/* ── Início ──────────────────────────────────────────────────── */

onSessionExpired(() => {
	const banner = document.getElementById("session-banner");
	if (banner) banner.hidden = false;
});

// "Pular para o conteúdo" sem mexer no endereço (o hash é do roteador).
document.querySelector(".skip")?.addEventListener("click", (ev) => {
	ev.preventDefault();
	main.focus();
});

initTheme();
document.getElementById("topbar-theme").append(themeSwitch());
buildSidebar();
buildBottomNav();

// Os links do Grafana entram nas telas: espera por eles (no máximo 2,5 s) antes da 1ª tela.
await Promise.race([getLinks(), new Promise((r) => setTimeout(r, 2500))]);
getLinks().then(buildExternalNav);
await route();
router.started = true;
refreshPulse();
poll(refreshPulse, 60000);
