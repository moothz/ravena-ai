/* PROVISÓRIA: tela antiga /banco/admin embutida, até a área nativa ficar pronta. */
import { legacyArea } from "./_legacy.js";

export default legacyArea({
	id: "banco",
	group: "Jogos",
	title: "Banco",
	desc: "RavenaBank: jogadores, transações, cotações e configuração.",
	tabs: [{ id: "painel", label: "Painel do banco", src: "/banco/admin" }]
});
