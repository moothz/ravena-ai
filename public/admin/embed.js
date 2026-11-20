/*
 * Modo embutido das telas antigas de admin (?embed=1), usado pelo painel /admin.
 *
 * Sem ?embed=1 este script não faz nada: a tela continua exatamente como antes.
 * Com ?embed=1 ele marca o <html> com a classe "ravena-embed" (embed.css esconde o
 * cabeçalho próprio da tela, que o painel já mostra) e faz os links que saem da tela
 * (Sair, Instâncias...) abrirem na janela de cima, e não dentro do iframe.
 */
(() => {
	"use strict";
	let embedded = false;
	try {
		embedded = new URLSearchParams(location.search).get("embed") === "1";
	} catch {
		embedded = false;
	}
	if (!embedded) return;

	document.documentElement.classList.add("ravena-embed");

	const css = document.createElement("link");
	css.rel = "stylesheet";
	css.href = "/admin/embed.css";
	document.head.append(css);

	// Delegação em captura: vale também para links criados depois pelo JS da tela.
	document.addEventListener(
		"click",
		(ev) => {
			const link = ev.target instanceof Element ? ev.target.closest("a[href]") : null;
			if (!link || link.target) return;
			const href = link.getAttribute("href") || "";
			if (href.startsWith("#") || href.startsWith("javascript:")) return;
			link.target = "_top";
		},
		true
	);
})();
