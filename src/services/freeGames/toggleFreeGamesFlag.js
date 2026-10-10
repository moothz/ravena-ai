/**
 * Liga/desliga o aviso semanal de jogos grátis de uma loja num grupo.
 * @param {Object} params
 * @param {Object} params.group
 * @param {import("./freeGameStores").FreeGameStore} params.store
 * @param {(group: Object) => Promise<void>} params.saveGroup
 * @returns {Promise<string>} texto de resposta para o admin
 */
async function toggleFreeGamesFlag({ group, store, saveGroup }) {
	group[store.groupFlag] = !group[store.groupFlag];
	await saveGroup(group);

	if (group[store.groupFlag]) {
		return `🎮 Aviso de *jogos grátis da ${store.label}* agora está *ativado* neste grupo.\nTodo sábado às 10h eu aviso quais jogos foram liberados.`;
	}
	return `⚪ Aviso de *jogos grátis da ${store.label}* agora está *desativado* neste grupo.`;
}

module.exports = { toggleFreeGamesFlag };
