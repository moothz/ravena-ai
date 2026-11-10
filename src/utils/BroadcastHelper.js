const Database = require("./Database");
const Logger = require("./Logger");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("broadcast-helper");

/**
 * Obtém a instância prioritária de bot do WhatsApp para broadcasts nos grupos de avisos/anúncios.
 * Segue a regra do ravenavip / notificarDonate (igual ao sistema de donates e weekly digest).
 *
 * @param {Array<Object>} [botList=null] - Lista opcional de bots para injeção/testes
 * @returns {Object|null}
 */
function getWhatsAppBroadcastBot(botList = null) {
	const allBots = botList || Database.getInstance().botInstances || [];
	if (!Array.isArray(allBots) || allBots.length === 0) return null;

	const isWhatsApp = (b) => Boolean(b && !b.useTelegram && !b.useDiscord);
	const isOnline = (b) => Boolean(b && (b.isConnected || b.testMode));

	return (
		allBots.find((b) => isWhatsApp(b) && b.notificarDonate && isOnline(b)) ||
		allBots.find((b) => isWhatsApp(b) && b.id === "ravenavip" && isOnline(b)) ||
		allBots.find((b) => isWhatsApp(b) && b.vip && isOnline(b)) ||
		allBots.find((b) => isWhatsApp(b) && isOnline(b)) ||
		allBots.find((b) => isWhatsApp(b) && b.notificarDonate) ||
		allBots.find((b) => isWhatsApp(b) && b.id === "ravenavip") ||
		allBots.find((b) => isWhatsApp(b)) ||
		null
	);
}

/**
 * Envia uma notificação para os canais de avisos/anúncios do WhatsApp
 * quando o evento originou-se no Telegram ou Discord.
 *
 * @param {Object} params
 * @param {Object|string} params.content - Mídia ou texto a enviar
 * @param {Object} [params.options={}] - Opções de envio (caption, etc.)
 * @param {number} [params.pinDuration=260000] - Tempo de fixação (ms) se suportado
 * @param {Array<Object>} [params.botList=null] - Lista opcional de bots para injeção/testes
 * @returns {Promise<boolean>} Retorna true se enviou para ao menos um canal
 */
async function broadcastToWhatsAppNoticeChannels({
	content,
	options = {},
	pinDuration = 260000,
	botList = null
}) {
	try {
		const waBot = getWhatsAppBroadcastBot(botList);
		if (!waBot) {
			logger.warn(
				"[broadcastToWhatsAppNoticeChannels] Nenhum bot WhatsApp disponível para broadcast."
			);
			return false;
		}

		const targetChats = [];
		if (waBot.grupoAnuncios) targetChats.push(waBot.grupoAnuncios);
		if (waBot.grupoAvisos && !String(waBot.grupoAvisos).includes("newsletter")) {
			targetChats.push(waBot.grupoAvisos);
		}
		if (targetChats.length === 0) {
			if (process.env.GRUPO_ANUNCIOS && process.env.GRUPO_ANUNCIOS.trim()) {
				targetChats.push(process.env.GRUPO_ANUNCIOS.trim());
			}
			if (
				process.env.GRUPO_AVISOS &&
				process.env.GRUPO_AVISOS.trim() &&
				!process.env.GRUPO_AVISOS.includes("newsletter")
			) {
				targetChats.push(process.env.GRUPO_AVISOS.trim());
			}
		}

		// Canais de newsletter (@newsletter) são reservados exclusivamente para resumos semanais e doações
		const uniqueChats = [...new Set(targetChats.filter(Boolean))].filter(
			(chatId) => !String(chatId).endsWith("@newsletter") && !String(chatId).includes("newsletter")
		);
		if (uniqueChats.length === 0) {
			logger.warn(
				"[broadcastToWhatsAppNoticeChannels] Nenhum grupo de avisos/anúncios configurado no WhatsApp."
			);
			return false;
		}

		let sentCount = 0;
		for (const chatId of uniqueChats) {
			try {
				const retMsg = new ReturnMessage({
					chatId,
					content,
					options: { ...options }
				});

				let sentMsgs = [];
				if (typeof waBot.sendReturnMessages === "function") {
					sentMsgs = await waBot.sendReturnMessages(retMsg);
				} else if (typeof waBot.sendMessage === "function") {
					const sMsg = await waBot.sendMessage(chatId, content, options);
					sentMsgs = sMsg ? [sMsg] : [];
				}

				if (Array.isArray(sentMsgs) && sentMsgs.length > 0) {
					sentCount++;
					if (pinDuration && sentMsgs[0] && typeof sentMsgs[0].pin === "function") {
						sentMsgs[0].pin(pinDuration).catch(() => {});
					}
				}
			} catch (errChat) {
				logger.error(
					`[broadcastToWhatsAppNoticeChannels] Erro ao enviar para ${chatId}:`,
					errChat.message || errChat
				);
			}
		}

		return sentCount > 0;
	} catch (err) {
		logger.error("[broadcastToWhatsAppNoticeChannels] Erro geral:", err);
		return false;
	}
}

module.exports = {
	getWhatsAppBroadcastBot,
	broadcastToWhatsAppNoticeChannels
};
