const { formatEpicFreeGamesMessage } = require("./formatEpicFreeGamesMessage");

/**
 * @param {Object} group
 * @returns {boolean}
 */
function wantsEpicNotification(group) {
	return group.notificarEpic === true && !group.paused;
}

/**
 * Caso de uso: avisa os grupos com `notificarEpic` ativo sobre os jogos grátis da Epic.
 * Busca os jogos uma única vez e reaproveita a mesma mensagem para todos os grupos.
 */
class NotifyEpicFreeGames {
	/**
	 * @param {Object} deps
	 * @param {{fetchCurrentGames: () => Promise<Array>}} deps.source
	 * @param {{getGroups: () => Promise<Array>}} deps.groupRepository
	 * @param {{notify: (groupId: string, content: string) => Promise<boolean>}} deps.notifier
	 * @param {Object} deps.logger
	 */
	constructor({ source, groupRepository, notifier, logger }) {
		this.source = source;
		this.groupRepository = groupRepository;
		this.notifier = notifier;
		this.logger = logger;
	}

	/**
	 * @returns {Promise<{sent: number, failed: number}>}
	 */
	async execute() {
		const summary = { sent: 0, failed: 0 };

		const games = await this.source.fetchCurrentGames();
		const message = formatEpicFreeGamesMessage(games);
		if (!message) {
			this.logger.warn("[NotifyEpicFreeGames] Nenhum jogo encontrado. Nada enviado.");
			return summary;
		}

		const groups = (await this.groupRepository.getGroups()).filter(wantsEpicNotification);
		for (const group of groups) {
			const delivered = await this.notifyGroup(group.id, message);
			summary[delivered ? "sent" : "failed"]++;
		}

		this.logger.info(
			`[NotifyEpicFreeGames] Concluído: ${summary.sent} enviados, ${summary.failed} falhas.`
		);
		return summary;
	}

	/**
	 * @param {string} groupId
	 * @param {string} message
	 * @returns {Promise<boolean>}
	 */
	async notifyGroup(groupId, message) {
		try {
			return await this.notifier.notify(groupId, message);
		} catch (error) {
			this.logger.error(`[NotifyEpicFreeGames] Erro ao notificar ${groupId}:`, error);
			return false;
		}
	}
}

module.exports = NotifyEpicFreeGames;
