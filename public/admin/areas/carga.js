/* PROVISÓRIA: o cartão "Painel da economia" do /banco/admin embutido, até a área nativa ficar pronta. */
import { legacyArea } from "./_legacy.js";
import { econHealth } from "../core.js";

export default legacyArea({
	id: "carga",
	group: "Jogos",
	title: "Carga da economia",
	desc: "Rodar, pausar e mudar o intervalo da carga que alimenta o Grafana.",
	tabs: [
		{
			id: "painel",
			label: "Painel da economia",
			src: "/banco/admin",
			hint: "aba Configurações & Economia"
		}
	],
	summary(p) {
		const e = econHealth(p.econ);
		const count = e.failing.length + e.late.length;
		if (!e.available) return { text: e.detail ? `${e.word}: ${e.detail}` : e.word };
		const every = e.paused ? "pausada" : `a cada ${e.everyHours || 1} h`;
		if (e.failing.length) {
			return {
				text: `${e.failing.map((f) => f.name).join(", ")} falhou · ${every}`,
				attention: true,
				count
			};
		}
		if (e.late.length) {
			return {
				text: `${e.late.map((l) => l.name).join(", ")} atrasada · ${every}`,
				attention: true,
				count
			};
		}
		return { text: `${e.word} · ${every}` };
	}
});
