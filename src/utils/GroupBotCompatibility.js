/**
 * Regras de compatibilidade entre um bot e o ID de um grupo.
 * Funções puras, sem dependência de bot real ou banco.
 */

const MIN_DISCORD_ID_LENGTH = 17;

/**
 * @param {string|number} groupId
 * @returns {"whatsapp"|"telegram"|"discord"}
 */
function detectGroupPlatform(groupId) {
	const id = String(groupId);
	if (id.includes("@")) return "whatsapp";
	if (id.startsWith("-")) return "telegram";
	if (id.length >= MIN_DISCORD_ID_LENGTH) return "discord";
	return "telegram";
}

/**
 * @param {Object} bot
 * @returns {"whatsapp"|"telegram"|"discord"}
 */
function detectBotPlatform(bot) {
	if (bot.useTelegram) return "telegram";
	if (bot.useDiscord) return "discord";
	return "whatsapp";
}

/**
 * Indica se o bot pode enviar mensagens para o grupo (plataforma compatível
 * e grupo fora da lista de grupos ignorados pelo bot).
 * @param {Object} bot
 * @param {string|number} groupId
 * @returns {boolean}
 */
function isBotCompatibleWithGroup(bot, groupId) {
	if (detectBotPlatform(bot) !== detectGroupPlatform(groupId)) return false;
	return !bot.skipGroupInfo?.includes(groupId);
}

module.exports = { detectGroupPlatform, detectBotPlatform, isBotCompatibleWithGroup };
