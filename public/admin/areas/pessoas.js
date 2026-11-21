/* PROVISÓRIA: telas antigas /dossies e /groups-dossier embutidas, até a área nativa ficar pronta. */
import { legacyArea } from "./_legacy.js";

export default legacyArea({
	id: "pessoas",
	group: "Pessoas",
	title: "Pessoas e grupos",
	desc: "Dossiês de pessoas e grupos (o resumo que a IA mantém) e histórico de moderação.",
	tabs: [
		{ id: "pessoas", label: "Pessoas", src: "/dossies" },
		{ id: "grupos", label: "Grupos", src: "/groups-dossier" }
	],
	summary: () => ({ text: "dossiês de pessoas e grupos" })
});
