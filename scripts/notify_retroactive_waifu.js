require("dotenv").config();
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const Logger = require("../src/utils/Logger");
const WhatsgoClient = require("../src/services/WhatsgoClient");
const { notifySpecialMarriage, downloadImageAsBase64 } = require("../src/functions/WaifuCommands");

const logger = new Logger("notify-retro-waifu");

async function main() {
	const args = process.argv.slice(2);
	if (args.length < 3) {
		console.log(
			"Uso: node scripts/notify_retroactive_waifu.js <characterId> <userName> <dateStr> [targetJid] [botName]"
		);
		console.log(
			'Exemplo: node scripts/notify_retroactive_waifu.js tsunade-senju "William~~" "19/09/2026"'
		);
		process.exit(1);
	}

	const [characterId, userName, dateStr, customTargetJid, customBotName] = args;

	const waifuUrl = process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030";
	const waifuKey = process.env.WAIFULETES_API_KEY;

	logger.info(`Buscando dados do personagem '${characterId}' na Waifuletes API...`);

	let character = null;
	try {
		const { data } = await axios.get(`${waifuUrl}/characters/${encodeURIComponent(characterId)}`, {
			headers: waifuKey ? { Authorization: `Bearer ${waifuKey}` } : {},
			timeout: 10000
		});
		character = data.data?.character || data.data;
	} catch (errApi) {
		logger.warn(
			`Não foi possível buscar detalhes na API do Waifuletes: ${errApi.message}. Usando fallback.`
		);
	}

	if (!character) {
		character = {
			id: characterId,
			name: characterId,
			rarity: "EPIC",
			baseRarity: "EPIC",
			series: "Anime/Game"
		};
	}

	const rarity = character.rarity || character.baseRarity || "COMMON";
	const dateFormatted = dateStr || "19/09/2026";

	// Formatação diferenciada: Lendário vs Épico
	let caption = "";
	if (rarity === "LEGENDARY") {
		caption += `👑 ✨ 👑 *CASAMENTO LENDÁRIO EXTRAORDINÁRIO!* 👑 ✨ 👑\n\n`;
		caption += `💍 ══════════════════════════ 💍\n`;
		caption += `   💖 *UNIDOS PELO DESTINO PARA SEMPRE!* 💖\n`;
		caption += `💍 ══════════════════════════ 💍\n\n`;
		caption += `🌌 O jogador *${userName}* alcançou o ápice do amor e selou seu matrimônio sagrado com a suprema lenda:\n\n`;
		caption += `⭐ 🌟 *${character.name}* 🌟 ⭐\n`;
		caption += `👑 *Raridade:* LENDÁRIO ✨\n`;
		if (character.series) {
			caption += `📺 *Universo:* ${character.series}\n`;
		}
		caption += `📅 *Data da Cerimônia:* ${dateFormatted}\n\n`;
		caption += `✨ ══════════════════════════ ✨\n`;
		caption += `🎉 *Que este casal lendário reine supremo com felicidades infinitas, companheirismo inabalável e vitórias épicas por toda a eternidade!* 🥂🍾✨`;
	} else {
		caption += `💖 *FELIZES PARA SEMPRE!* 💍\n\n`;
		caption += `✨ O jogador *${userName}* uniu seus laços matrimoniais com a personagem épica:\n\n`;
		caption += `🟣 *${character.name}* 🟣\n`;
		caption += `🏷️ *Raridade:* ÉPICO\n`;
		if (character.series) {
			caption += `📺 *Série:* ${character.series}\n`;
		}
		caption += `📅 *Data do Casamento:* ${dateFormatted}\n\n`;
		caption += `🎉 *Desejamos ao casal uma vida repleta de felicidades, batalhas vencidas e companheirismo eterno!* 🥂✨`;
	}

	// Alvos de envio: Se customTargetJid for especificado usa ele, senão usa as variáveis do .env
	const targets = [];
	if (customTargetJid) {
		targets.push(customTargetJid);
	} else {
		if (process.env.GRUPO_ANUNCIOS && process.env.GRUPO_ANUNCIOS.trim()) {
			targets.push(process.env.GRUPO_ANUNCIOS.trim());
		}
		if (process.env.GRUPO_AVISOS && process.env.GRUPO_AVISOS.trim()) {
			targets.push(process.env.GRUPO_AVISOS.trim());
		}
	}

	if (targets.length === 0) {
		logger.error(
			"Nenhum destino configurado. Defina GRUPO_ANUNCIOS e/ou GRUPO_AVISOS no .env ou informe targetJid como argumento."
		);
		process.exit(1);
	}

	// Nome do bot para o WhatsgoClient
	const botName = customBotName || process.env.DEFAULT_BOT_NAME || "ravenavip";
	const whatsgoApiUrl =
		process.env.WHATS_GO_API_URL || process.env.WHATSGO_API_URL || "http://whatsgoapi:8080";
	const globalApiKey = process.env.GLOBAL_API_KEY || "admin";

	logger.info(`Iniciando envio real via WhatsgoClient (bot: ${botName}, api: ${whatsgoApiUrl})...`);

	const whatsgoClient = new WhatsgoClient(whatsgoApiUrl, globalApiKey, botName, logger);

	let imageBase64 = null;
	if (character.imageUrl) {
		try {
			imageBase64 = await downloadImageAsBase64(character.imageUrl);
		} catch (eImg) {
			logger.warn("Erro ao baixar imagem da waifu:", eImg.message);
		}
	}

	let successCount = 0;
	for (const targetJid of targets) {
		try {
			logger.info(`Enviando notificação para o JID '${targetJid}'...`);
			let res;

			if (character.imageUrl) {
				let mediaUrl = character.imageUrl;
				if (
					mediaUrl.startsWith("/") ||
					mediaUrl.includes("localhost:") ||
					mediaUrl.includes("host.docker.internal")
				) {
					const pathPart = mediaUrl.replace(/^https?:\/\/[^/]+/, "");
					mediaUrl = `http://172.17.0.1:3030${pathPart.startsWith("/") ? "" : "/"}${pathPart}`;
				}

				res = await whatsgoClient.post("/send/media", {
					number: targetJid,
					url: mediaUrl,
					type: "image",
					caption,
					delay: 0
				});
			} else {
				res = await whatsgoClient.post("/send/text", {
					number: targetJid,
					text: caption,
					delay: 0
				});
			}

			logger.info(`✅ Notificação enviada para ${targetJid}:`, res?.message || res?.status || "OK");
			successCount++;
		} catch (errSend) {
			logger.error(`❌ Falha ao enviar para ${targetJid}:`, errSend.message || errSend);
		}
	}

	if (successCount > 0) {
		logger.info(
			`🎉 Sucesso! Notificação enviada para ${successCount}/${targets.length} canais/grupos reais.`
		);
		process.exit(0);
	} else {
		logger.error("❌ Erro ao enviar notificação para todos os destinos.");
		process.exit(1);
	}
}

main().catch((err) => {
	logger.error("Erro fatal na execução do script:", err);
	process.exit(1);
});
