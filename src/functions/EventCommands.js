const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const GameEventService = require("../services/GameEventService");

/**
 * Exibe os eventos temporários ativos para os jogadores
 */
async function eventosCommand(bot, message) {
	const chatId = message.group ?? message.author;
	const events = GameEventService.getActiveEvents();

	if (!events || events.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"🎉 *EVENTOS ESPECIAIS NA RAVENA* 🎉\n\n" +
				"No momento não há nenhum evento temporário ativo.\n" +
				"Fique atento aos avisos do grupo para os próximos eventos com bônus de Pesca, Waifus e Slots!"
		});
	}

	const eventsByGame = {
		pesca: events.filter((e) => e.game === "pesca"),
		waifu: events.filter((e) => e.game === "waifu"),
		slots: events.filter((e) => e.game === "slots")
	};

	let text = "🎉 *EVENTOS ESPECIAIS ATIVOS NA RAVENA* 🎉\n\n";

	// Pesca
	text += "🎣 *Pesca:*\n";
	if (eventsByGame.pesca.length > 0) {
		for (const ev of eventsByGame.pesca) {
			if (ev.type === "peso") {
				text += `• *+${ev.value}%* no peso de todos os peixes pescados _(restam ${ev.remainingText})_\n`;
			} else if (ev.type === "lendario") {
				text += `• *+${ev.value}%* na chance de capturar peixes lendários _(restam ${ev.remainingText})_\n`;
			}
		}
	} else {
		text += "• Nenhum evento ativo no momento.\n";
	}
	text += "\n";

	// Waifus
	text += "🌸 *Waifus (Mudae):*\n";
	if (eventsByGame.waifu.length > 0) {
		for (const ev of eventsByGame.waifu) {
			if (ev.type === "raros") {
				text += `• *+${ev.value}%* de chance para personagens raros, épicos e lendários _(restam ${ev.remainingText})_\n`;
			} else if (ev.type === "wish") {
				text += `• *+${ev.value}%* de chance extra para personagens da sua wishlist _(restam ${ev.remainingText})_\n`;
			}
		}
	} else {
		text += "• Nenhum evento ativo no momento.\n";
	}
	text += "\n";

	// Slots
	text += "🎰 *Caça-Coisas (Slots):*\n";
	if (eventsByGame.slots.length > 0) {
		for (const ev of eventsByGame.slots) {
			if (ev.type === "vitoria") {
				text += `• *+${ev.value}%* de chance de vitória nos giros _(restam ${ev.remainingText})_\n`;
			} else if (ev.type === "moedas") {
				text += `• *+${ev.value}%* de moedas ganhas nos prêmios _(restam ${ev.remainingText})_\n`;
			} else if (ev.type === "iscas") {
				text += `• *+${ev.value}%* de iscas de pesca ganhas nos prêmios _(restam ${ev.remainingText})_\n`;
			}
		}
	} else {
		text += "• Nenhum evento ativo no momento.\n";
	}

	return new ReturnMessage({
		chatId,
		content: text.trim()
	});
}

const commands = [
	new Command({
		name: "eventos",
		aliases: ["evento", "eventos-ativos", "eventos-jogos"],
		description: "Mostra os eventos especiais temporários ativos na Ravena",
		category: "jogos",
		usage: "!eventos",
		method: eventosCommand
	})
];

module.exports = { commands };
