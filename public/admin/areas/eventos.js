/* PROVISÓRIA: tela antiga /eventos/admin embutida, até a área nativa ficar pronta. */
import { legacyArea } from "./_legacy.js";
import { fmt, isEventActive } from "../core.js";

export default legacyArea({
	id: "eventos",
	group: "Jogos",
	title: "Eventos",
	desc: "Eventos programados com bônus para os jogos.",
	tabs: [{ id: "gestao", label: "Gestão de eventos", src: "/eventos/admin" }],
	summary(p) {
		if (!Array.isArray(p.events)) return null;
		const active = p.events.filter((e) => isEventActive(e)).length;
		return { text: active ? `${fmt(active)} em andamento` : "nenhum em andamento" };
	}
});
