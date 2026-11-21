/*
 * Banco (RavenaBank): jogadores, ficha do jogador, transações (com desfazer), cotações do dia
 * e parâmetros da economia. Substitui a tela antiga /banco/admin (fica no ar com ?legado=1),
 * menos o cartão "Painel da economia", que é a área Carga.
 *
 * Rotas:
 *   #/banco                      Jogadores (?q=busca&p=página)
 *   #/banco/jogador/<id>         ficha do jogador
 *   #/banco/transacoes           Transações (?q=&tipo=&jogo=&status=&p=)
 *   #/banco/cotacoes             Cotações do dia e recálculo
 *   #/banco/config               Números do banco e parâmetros
 */

import { subnav, externalLink, buildHash, loadAreaCss } from "../core.js";
import { renderJogadores } from "./banco/jogadores.js";
import { renderJogador } from "./banco/jogador.js";
import { renderTransacoes } from "./banco/transacoes.js";
import { renderCotacoes, renderConfig } from "./banco/cotacoes.js";

const TABS = [
	{ id: "jogadores", label: "Jogadores", href: "#/banco" },
	{ id: "transacoes", label: "Transações", href: buildHash("banco", ["transacoes"]) },
	{ id: "cotacoes", label: "Cotações", href: buildHash("banco", ["cotacoes"]) },
	{ id: "config", label: "Configurações", href: buildHash("banco", ["config"]) }
];

function tabOf(ctx) {
	const s = ctx.segs[0];
	if (!s || s === "jogadores" || s === "jogador") return "jogadores";
	return TABS.some((t) => t.id === s) ? s : "jogadores";
}

export default {
	id: "banco",
	group: "Jogos",
	title: "Banco",
	desc: "RavenaBank: jogadores, transações, cotações e configuração.",
	async render(root, ctx) {
		loadAreaCss("banco", "/admin/areas/banco.css?v=2");
		const tab = tabOf(ctx);
		ctx.head.append(
			subnav(TABS, tab, { label: "Seções do Banco" }),
			externalLink("/ravenabank", "Banco do jogador", { button: true, quiet: true })
		);
		if (ctx.segs[0] === "jogador" && ctx.segs[1]) return renderJogador(root, ctx, ctx.segs[1]);
		if (tab === "transacoes") return renderTransacoes(root, ctx);
		if (tab === "cotacoes") return renderCotacoes(root, ctx);
		if (tab === "config") return renderConfig(root, ctx);
		return renderJogadores(root, ctx);
	}
};
