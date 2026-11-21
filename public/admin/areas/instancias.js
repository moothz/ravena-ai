/*
 * Instâncias: bots do bots.json, estado ao vivo, pareamento, avisos de status.
 * Substitui a tela antiga /instances (continua em /instances?legado=1) e a página /qrcode/<id>.
 *
 * Rotas:
 *   #/instancias[?filtro=online|paradas|desativadas|ativas|offline&plataforma=…&q=…]  lista
 *   #/instancias/nova                       cria um rascunho e vai para a configuração dele
 *   #/instancias/<nome>                     ficha: resumo e ações
 *   #/instancias/<nome>/config|extras|pareamento
 *   #/instancias/avisos[/<id>]              avisos de status (publicar / editar)
 * Telas em areas/instancias/*.js; regras puras em areas/instancias/modelo.js.
 */

import { subnav, buildHash, fmt } from "../core.js";
import { ensureCss } from "./instancias/comum.js";
import { renderLista } from "./instancias/lista.js";
import { renderFicha, renderNova } from "./instancias/ficha.js";
import { renderAvisos } from "./instancias/avisos.js";

const AREA_TABS = [
	{ id: "lista", label: "Instâncias", href: "#/instancias" },
	{ id: "avisos", label: "Avisos de status", href: buildHash("instancias", ["avisos"]) }
];

export default {
	id: "instancias",
	group: "Operação",
	title: "Instâncias",
	desc: "Bots do bots.json, pareamento, avisos de status.",
	summary(p) {
		if (!Array.isArray(p.bots)) return null;
		const bots = p.bots.filter((b) => b.enabled !== false);
		const off = bots.filter((b) => !b.connected).length;
		return off
			? { text: `${fmt(off)} de ${fmt(bots.length)} fora do ar`, attention: true, count: off }
			: { text: `${fmt(bots.length)} conectadas` };
	},
	async render(root, ctx) {
		ensureCss();
		const first = ctx.segs[0];
		ctx.head.append(
			subnav(AREA_TABS, first === "avisos" ? "avisos" : "lista", { label: "Seções de Instâncias" })
		);
		if (!first) return renderLista(root, ctx);
		if (first === "avisos") return renderAvisos(root, ctx);
		if (first === "nova") return renderNova(root, ctx);
		return renderFicha(root, ctx);
	}
};
