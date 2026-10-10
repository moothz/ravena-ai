const { formatFreeGamesMessage } = require("./formatFreeGamesMessage");
const {
	selectNewGames,
	selectGamesToAnnounce,
	nextWeeklyGames
} = require("./weeklyGamesSelection");

/**
 * @param {Object} group
 * @returns {boolean}
 */
function isActiveGroup(group) {
	return !group.paused;
}

/**
 * Caso de uso: avisa os grupos sobre os jogos grátis novos da semana.
 *
 * Cada loja é buscada uma única vez e o resultado serve para todos os grupos.
 * O DB de jogos anunciados é global e guarda só os jogos da semana atual.
 */
class NotifyFreeGames {
	/**
	 * @param {Object} deps
	 * @param {import("./freeGameStores").FreeGameStore[]} deps.stores
	 * @param {{fetchCurrentGames: (store: Object) => Promise<Object>}} deps.source
	 * @param {{getGameIds: Function, replaceStoreGames: Function}} deps.repository
	 * @param {{getGroups: () => Promise<Array>}} deps.groupRepository
	 * @param {{notify: (groupId: string, content: string) => Promise<boolean>}} deps.notifier
	 * @param {Object} deps.logger
	 */
	constructor({ stores, source, repository, groupRepository, notifier, logger }) {
		this.stores = stores;
		this.source = source;
		this.repository = repository;
		this.groupRepository = groupRepository;
		this.notifier = notifier;
		this.logger = logger;
	}

	/**
	 * @returns {Promise<{sent: number, failed: number}>}
	 */
	async execute() {
		const updates = await this.collectStoreUpdates();
		const summary = await this.notifyGroups(updates);
		await this.persistStoreUpdates(updates);

		this.logger.info(
			`[NotifyFreeGames] Concluído: ${summary.sent} enviados, ${summary.failed} falhas.`
		);
		return summary;
	}

	/**
	 * Busca cada loja e separa o que é novo. Lojas cuja busca falhou ficam de fora.
	 * @returns {Promise<Array<{store: Object, currentGames: Array, registeredIds: Set<string>, announcedGames: Array}>>}
	 */
	async collectStoreUpdates() {
		const updates = [];
		for (const store of this.stores) {
			const update = await this.collectStoreUpdate(store);
			if (update) updates.push(update);
		}
		return updates;
	}

	async collectStoreUpdate(store) {
		const result = await this.source.fetchCurrentGames(store);
		if (!result.ok) {
			this.logger.warn(`[NotifyFreeGames] Falha ao buscar ${store.key}. Loja ignorada.`);
			return null;
		}

		const registeredIds = await this.repository.getGameIds(store.key);
		const newGames = selectNewGames(result.games, registeredIds);
		const announcedGames = selectGamesToAnnounce(newGames, store);
		return { store, currentGames: result.games, registeredIds, announcedGames };
	}

	/**
	 * @returns {Promise<{sent: number, failed: number}>}
	 */
	async notifyGroups(updates) {
		const summary = { sent: 0, failed: 0 };
		const groups = (await this.groupRepository.getGroups()).filter(isActiveGroup);

		for (const group of groups) {
			const message = this.buildMessageFor(group, updates);
			if (!message) continue;

			const delivered = await this.notifyGroup(group.id, message);
			summary[delivered ? "sent" : "failed"]++;
		}
		return summary;
	}

	/**
	 * @returns {string|null}
	 */
	buildMessageFor(group, updates) {
		const sections = updates
			.filter(
				({ store, announcedGames }) => group[store.groupFlag] === true && announcedGames.length > 0
			)
			.map(({ store, announcedGames }) => ({ label: store.label, games: announcedGames }));
		return formatFreeGamesMessage(sections);
	}

	/**
	 * @returns {Promise<boolean>}
	 */
	async notifyGroup(groupId, message) {
		try {
			return await this.notifier.notify(groupId, message);
		} catch (error) {
			this.logger.error(`[NotifyFreeGames] Erro ao notificar ${groupId}:`, error);
			return false;
		}
	}

	async persistStoreUpdates(updates) {
		for (const { store, currentGames, registeredIds, announcedGames } of updates) {
			const nextGames = nextWeeklyGames(registeredIds, currentGames, announcedGames);
			try {
				await this.repository.replaceStoreGames(store.key, nextGames);
			} catch (error) {
				this.logger.error(
					`[NotifyFreeGames] Erro ao salvar jogos da semana (${store.key}):`,
					error
				);
			}
		}
	}
}

module.exports = NotifyFreeGames;
