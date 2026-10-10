const { FREE_GAMES_SCHEDULE } = require("./freeGamesSchedule");

/**
 * Texto de resposta ao admin depois de ligar/desligar o aviso de uma loja.
 * @param {Object} params
 * @param {import("./freeGameStores").FreeGameStore} params.store
 * @param {boolean} params.enabled
 * @returns {string}
 */
function describeFreeGamesFlag({ store, enabled }) {
	if (enabled) {
		return `🎮 Aviso de *jogos grátis da ${store.label}* agora está *ativado* neste grupo.\nTodo ${FREE_GAMES_SCHEDULE.description} eu aviso quais jogos foram liberados.`;
	}
	return `⚪ Aviso de *jogos grátis da ${store.label}* agora está *desativado* neste grupo.`;
}

module.exports = { describeFreeGamesFlag };
