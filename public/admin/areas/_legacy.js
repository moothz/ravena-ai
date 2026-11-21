/*
 * Fábrica das áreas PROVISÓRIAS: mostram a tela antiga embutida (?embed=1) com a faixa
 * "tela antiga, migração em andamento", para o painel funcionar enquanto cada área é
 * reescrita de forma nativa. Quem reescrever uma área troca o arquivo inteiro e deixa de
 * importar isto.
 */

import { subnav, legacyEmbed, buildHash } from "../core.js";

/**
 * @param {{ id: string, group: string, title: string, short?: string, desc: string,
 *   tabs: Array<{ id: string, label: string, src: string, hint?: string }>,
 *   summary?: (pulse: Object) => ({ text: string, attention?: boolean, count?: number }|null) }} def
 */
export function legacyArea(def) {
	const pick = (ctx) => def.tabs.find((t) => t.id === ctx.segs[0]) || def.tabs[0];
	return {
		id: def.id,
		group: def.group,
		title: def.title,
		short: def.short,
		desc: def.desc,
		legacy: true,
		layout: "embed",
		summary: def.summary,
		render(root, ctx) {
			const tab = pick(ctx);
			if (def.tabs.length > 1) {
				ctx.head.append(
					subnav(
						def.tabs.map((t, i) => ({
							id: t.id,
							label: t.label,
							href: i === 0 ? `#/${def.id}` : buildHash(def.id, [t.id])
						})),
						tab.id,
						{ label: `Seções de ${def.title}` }
					)
				);
			}
			root.append(legacyEmbed(tab.src, `${def.title}: ${tab.label}`, { hint: tab.hint }));
		}
	};
}
