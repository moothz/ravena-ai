/* PROVISÓRIA: tela antiga /instances embutida, até a área nativa ficar pronta. */
import { legacyArea } from "./_legacy.js";
import { fmt } from "../core.js";

export default legacyArea({
	id: "instancias",
	group: "Operação",
	title: "Instâncias",
	desc: "Bots, pareamento, avisos de status e bots.json.",
	tabs: [{ id: "gestao", label: "Gestão", src: "/instances" }],
	summary(p) {
		if (!Array.isArray(p.bots)) return null;
		const bots = p.bots.filter((b) => b.enabled !== false);
		const off = bots.filter((b) => !b.connected).length;
		return off
			? { text: `${fmt(off)} de ${fmt(bots.length)} fora do ar`, attention: true, count: off }
			: { text: `${fmt(bots.length)} conectadas` };
	}
});
