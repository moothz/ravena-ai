/*
 * Registro das áreas do painel, na ordem do menu. Para criar uma área: escreva
 * areas/<id>.js (export default { id, group, title, desc, render }) e acrescente-a aqui.
 * group: "Operação" | "Jogos" | "Pessoas" (null + nav: false = fora do menu, como "mais").
 */

import geral from "./geral.js";
import instancias from "./instancias.js";
import provedores from "./provedores.js";
import logs from "./logs.js";
import banco from "./banco.js";
import eventos from "./eventos.js";
import carga from "./carga.js";
import bicho from "./bicho.js";
import pessoas from "./pessoas.js";
import mais from "./mais.js";

export const AREAS = [
	geral,
	instancias,
	provedores,
	logs,
	banco,
	eventos,
	carga,
	bicho,
	pessoas,
	mais
];

/** Grupos do menu lateral, na ordem. */
export const GROUPS = ["Operação", "Jogos", "Pessoas"];

/** Barra inferior do celular (o resto fica na página Mais). */
export const PRIMARY = ["geral", "instancias", "banco", "eventos"];

/**
 * Endereços antigos do painel → novos (links salvos de antes da reorganização).
 * Chave: "#/<área>" ou "#/<área>/<aba>" antigos; valor: hash novo.
 */
export const HASH_ALIASES = {
	"#/analytics": "#/provedores/uso",
	"#/analytics/resumo": "#/provedores/uso",
	"#/economia": "#/carga",
	"#/economia/resumo": "#/carga",
	"#/legado": "#/mais",
	"#/legado/lista": "#/mais",
	"#/dossies": "#/pessoas",
	"#/dossies/painel": "#/pessoas",
	"#/dossies/grupos": "#/pessoas/grupos",
	"#/geral/resumo": "#/geral",
	"#/logs/ao-vivo": "#/logs"
};
