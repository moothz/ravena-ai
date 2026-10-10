/**
 * Inverte, no próprio `group`, a flag de aviso de jogos grátis da loja e
 * persiste o grupo (mesmo padrão dos outros toggles do Management).
 * @param {Object} params
 * @param {Object} params.group
 * @param {import("./freeGameStores").FreeGameStore} params.store
 * @param {(group: Object) => Promise<void>} params.saveGroup
 * @returns {Promise<boolean>} novo estado da flag
 */
async function toggleFreeGamesFlag({ group, store, saveGroup }) {
	group[store.groupFlag] = !group[store.groupFlag];
	await saveGroup(group);
	return group[store.groupFlag];
}

module.exports = { toggleFreeGamesFlag };
