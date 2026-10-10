const ReturnMessage = require("../../models/ReturnMessage");
const { isBotCompatibleWithGroup } = require("../../utils/GroupBotCompatibility");

const NOT_IN_GROUP_MARKERS = [
	"not participating",
	"not_participating",
	"no longer a participant",
	"not in group"
];

/**
 * @param {Object} sendResult - item retornado por bot.sendReturnMessages
 * @returns {string} texto de erro em minúsculas ("" se não houve erro)
 */
function extractErrorText(sendResult) {
	const error = sendResult?.error;
	if (!error) return "";
	return [error.message, error.data?.error, error.response?.data?.error, error]
		.filter((part) => typeof part === "string")
		.join(" ")
		.toLowerCase();
}

/**
 * @param {Array} sendResults
 * @returns {boolean}
 */
function botIsNotInGroup(sendResults) {
	return sendResults.some((result) => {
		const text = extractErrorText(result);
		return NOT_IN_GROUP_MARKERS.some((marker) => text.includes(marker));
	});
}

/**
 * @param {Array} sendResults
 * @returns {boolean}
 */
function hasSendError(sendResults) {
	return sendResults.some((result) => result?.error);
}

/**
 * Envia texto para um grupo usando o primeiro bot compatível que consiga entregar.
 */
class BotGroupNotifier {
	/**
	 * @param {Object} deps
	 * @param {() => Array<Object>} deps.getBots
	 * @param {Object} deps.logger
	 */
	constructor({ getBots, logger }) {
		this.getBots = getBots;
		this.logger = logger;
	}

	/**
	 * @param {string} groupId
	 * @param {string} content
	 * @returns {Promise<boolean>} true se algum bot entregou
	 */
	async notify(groupId, content) {
		const candidates = this.getBots().filter((bot) => isBotCompatibleWithGroup(bot, groupId));
		for (const bot of candidates) {
			if (await this.trySend(bot, groupId, content)) return true;
		}
		return false;
	}

	/**
	 * Uma falha deste bot (resposta de erro ou exceção) devolve false para o
	 * próximo candidato tentar.
	 * @returns {Promise<boolean>}
	 */
	async trySend(bot, groupId, content) {
		try {
			const results = await bot.sendReturnMessages(new ReturnMessage({ chatId: groupId, content }));
			const sendResults = [].concat(results ?? []);

			if (botIsNotInGroup(sendResults)) {
				await bot.markNotInGroup?.(groupId);
				return false;
			}
			return !hasSendError(sendResults);
		} catch (error) {
			this.logger.error(`[BotGroupNotifier] Bot falhou ao enviar para ${groupId}:`, error);
			return false;
		}
	}
}

module.exports = BotGroupNotifier;
