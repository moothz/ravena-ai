const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const FishingGame = require("../functions/FishingGame");
const SlotsGame = require("../functions/SlotsGame");

const logger = new Logger("donor-bonus-service");
const database = Database.getInstance();

const SIMPLE_ITEMS = ["Anzol de Titânio", "Bolso de Pesca", "Pochete de Iscas"];
const MEDIUM_ITEMS = ["Calça de Pesca", "Caixa de Iscas"];
const HIGH_ITEMS = ["Mochilão", "Viveiro Portátil"];

/**
 * Cria buff de pesca correspondente a um upgrade
 * @param {string} itemName
 * @returns {Object}
 */
function createBuffForItem(itemName) {
	const upgrade = FishingGame.UPGRADES.find((u) => u.name === itemName);
	if (!upgrade) {
		throw new Error(`Item de pesca não encontrado: ${itemName}`);
	}
	const isPermanent = upgrade.effect === "inventory_slot" || upgrade.effect === "max_baits";
	return {
		type: upgrade.effect,
		value: upgrade.value || 0,
		minValue: upgrade.minValue || 0,
		maxValue: upgrade.maxValue || 0,
		remainingUses: isPermanent ? 999999 : upgrade.duration || 1,
		originalName: upgrade.name
	};
}

/**
 * Sorteia um elemento de um array
 * @param {Array} arr
 * @returns {*}
 */
function pickRandom(arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Calcula todos os bônus com base no valor acumulado de doações
 * @param {number} totalAmount - Valor total doado em R$
 * @returns {Object}
 */
function calculateBonuses(totalAmount) {
	totalAmount = Math.max(0, Number(totalAmount) || 0);

	const baits = Math.round(totalAmount * 2);
	const coins = Math.round(totalAmount * 3);
	const simpleItemsCount = Math.floor(totalAmount / 5);
	const mediumItemsCount = totalAmount >= 20 ? 1 : 0;
	const highItems30to50Count = totalAmount >= 30 ? 1 : 0;
	// Faixa acima de 50: 1 base em R$50 + 1 a cada R$10 acima de 50
	const highItemsAbove50Count = totalAmount >= 50 ? 1 + Math.floor((totalAmount - 50) / 10) : 0;
	const totalHighItems = highItems30to50Count + highItemsAbove50Count;

	// Waifus:
	// RARE: +2.0% por R$1 -> 1 + total * 0.02 (aos R$100: 3.0x ou +200%)
	// EPIC: +3.5% por R$1 -> 1 + total * 0.035 (aos R$100: 4.5x ou +350%)
	// LEGENDARY: +4.5% por R$1 -> 1 + total * 0.045 (aos R$100: 5.5x ou +450%)
	// Resultado ponderado: chance de lendário sobe de 2.38% para ~8.0% aos R$100
	const rarityMultipliers = {
		RARE: Number((1 + totalAmount * 0.02).toFixed(3)),
		EPIC: Number((1 + totalAmount * 0.035).toFixed(3)),
		LEGENDARY: Number((1 + totalAmount * 0.045).toFixed(3))
	};

	let wishlistMultiplier = null;
	if (totalAmount >= 50) {
		// Base de 4.0x (+300%) + 8% por real acima de 50 -> aos R$100: 8.0x (+700%)
		wishlistMultiplier = Number((4.0 + (totalAmount - 50) * 0.08).toFixed(3));
	}

	// Pinto Game (+1% de tamanho por R$1)
	const pintoBonusPercent = Math.round(totalAmount * 1);
	const pintoMultiplier = Number((1 + totalAmount * 0.01).toFixed(3));

	return {
		totalAmount,
		pesca: {
			baits,
			simpleItemsCount,
			mediumItemsCount,
			highItems30to50Count,
			highItemsAbove50Count,
			totalHighItems
		},
		slots: {
			coins
		},
		waifu: {
			donorBadge: "VIP Doador 💎",
			rarityMultipliers,
			wishlistMultiplier
		},
		pinto: {
			bonusPercent: pintoBonusPercent,
			multiplier: pintoMultiplier
		}
	};
}

/**
 * Calcula o delta incremental entre o total atual e o já processado
 * @param {number} totalAmount
 * @param {number} previousAmount
 * @returns {Object}
 */
function calculateIncrementalBonuses(totalAmount, previousAmount = 0) {
	totalAmount = Math.max(0, Number(totalAmount) || 0);
	previousAmount = Math.max(0, Number(previousAmount) || 0);

	const current = calculateBonuses(totalAmount);
	const previous = calculateBonuses(previousAmount);

	const deltaAmount = Math.max(0, totalAmount - previousAmount);
	const deltaBaits = Math.max(0, current.pesca.baits - previous.pesca.baits);
	const deltaCoins = Math.max(0, current.slots.coins - previous.slots.coins);
	const deltaSimpleItems = Math.max(
		0,
		current.pesca.simpleItemsCount - previous.pesca.simpleItemsCount
	);
	const deltaMediumItems = Math.max(
		0,
		current.pesca.mediumItemsCount - previous.pesca.mediumItemsCount
	);
	const deltaHighItems = Math.max(0, current.pesca.totalHighItems - previous.pesca.totalHighItems);

	return {
		deltaAmount,
		deltaBaits,
		deltaCoins,
		deltaSimpleItems,
		deltaMediumItems,
		deltaHighItems,
		current,
		previous
	};
}

/**
 * Busca doador pelo número de telefone
 * @param {string} number
 * @returns {Promise<Object|null>}
 */
async function getDonorByNumber(number) {
	if (!number) return null;
	const clean = String(number).replace(/\D/g, "");
	if (!clean) return null;
	return database.getDonorByNumber(clean);
}

/**
 * Busca doador pelo userId do WhatsApp
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getDonorByUserId(userId) {
	return getDonorByNumber(userId);
}

/**
 * Retorna o valor total doado pelo userId
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getDonorTotal(userId) {
	const donor = await getDonorByUserId(userId);
	return donor ? Number(donor.valor) || 0 : 0;
}

/**
 * Retorna os bônus para a API de Waifus (POST /roll)
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getWaifuRollBonuses(userId) {
	const donor = await getDonorByUserId(userId);
	if (!donor || !donor.valor || donor.valor <= 0) {
		return null;
	}
	const bonuses = calculateBonuses(donor.valor);
	const result = {
		donorBadge: bonuses.waifu.donorBadge,
		rarityMultipliers: bonuses.waifu.rarityMultipliers
	};
	if (bonuses.waifu.wishlistMultiplier) {
		result.wishlistMultiplier = bonuses.waifu.wishlistMultiplier;
	}
	return result;
}

/**
 * Concede bônus de doação (iscas, moedas e itens sorteados)
 * @param {string|Object} donorIdentifier - Nome, número ou objeto doador
 * @param {number} totalAmount - Valor acumulado total
 * @param {number} [previousAmount=0] - Valor já processado anteriormente
 * @param {Object} [options={}] - { dryRun: boolean }
 * @returns {Promise<Object>}
 */
async function awardDonorBonuses(
	donorIdentifier,
	totalAmount,
	previousAmount = undefined,
	options = {}
) {
	try {
		let donor;
		if (donorIdentifier && typeof donorIdentifier === "object") {
			donor = donorIdentifier;
		} else if (typeof donorIdentifier === "string") {
			donor =
				(await database.getDonorByName(donorIdentifier)) ||
				(await database.getDonorByNumber(donorIdentifier));
		}

		if (!donor) {
			return { success: false, reason: "Doador não encontrado" };
		}

		if (!donor.numero) {
			return { success: false, reason: "Doador sem número de WhatsApp cadastrado" };
		}

		const cleanNumber = String(donor.numero).replace(/\D/g, "");
		if (!cleanNumber) {
			return { success: false, reason: "Número de telefone inválido" };
		}

		if (previousAmount === undefined || previousAmount === null) {
			previousAmount = Number(donor.bonusesProcessedAmount) || 0;
		}

		const delta = calculateIncrementalBonuses(totalAmount, previousAmount);

		if (delta.deltaAmount <= 0) {
			return {
				success: true,
				dryRun: !!options.dryRun,
				cleanNumber,
				donorName: donor.nome,
				noChanges: true,
				delta,
				message: "Nenhum bônus pendente para conceder"
			};
		}

		// Sorteia os itens físicos de pesca
		const chosenItems = [];
		for (let i = 0; i < delta.deltaSimpleItems; i++) {
			chosenItems.push({ tier: "simples", name: pickRandom(SIMPLE_ITEMS) });
		}
		for (let i = 0; i < delta.deltaMediumItems; i++) {
			chosenItems.push({ tier: "medio", name: pickRandom(MEDIUM_ITEMS) });
		}
		for (let i = 0; i < delta.deltaHighItems; i++) {
			chosenItems.push({ tier: "alto", name: pickRandom(HIGH_ITEMS) });
		}

		const dryRun = Boolean(options.dryRun);

		if (!dryRun) {
			// 1. Concede Iscas
			if (delta.deltaBaits > 0) {
				await FishingGame.addBaits(cleanNumber, delta.deltaBaits);
			}

			// 2. Concede Moedas nos Slots (bypassa MAX_COINS)
			if (delta.deltaCoins > 0) {
				await SlotsGame.addCoins(cleanNumber, delta.deltaCoins, true);
			}

			// 3. Concede Itens de Pesca
			for (const item of chosenItems) {
				const buff = createBuffForItem(item.name);
				await FishingGame.addBuff(cleanNumber, buff, false);
			}

			// 4. Atualiza o valor processado no banco de doações
			await database.updateDonorBonusProcessed(donor.nome, totalAmount);

			logger.info(
				`[DonorBonusService] Bônus concedidos com sucesso para ${donor.nome} (${cleanNumber}): +${delta.deltaBaits} iscas, +${delta.deltaCoins} moedas, +${chosenItems.length} itens.`
			);
		} else {
			logger.info(
				`[DonorBonusService] [DRY-RUN] Simulação de bônus para ${donor.nome} (${cleanNumber}): +${delta.deltaBaits} iscas, +${delta.deltaCoins} moedas, +${chosenItems.length} itens.`
			);
		}

		return {
			success: true,
			dryRun,
			cleanNumber,
			donorName: donor.nome,
			totalAmount,
			previousAmount,
			delta,
			chosenItems
		};
	} catch (error) {
		logger.error("Erro ao conceder bônus de doador:", error);
		return { success: false, error: error.message };
	}
}

module.exports = {
	SIMPLE_ITEMS,
	MEDIUM_ITEMS,
	HIGH_ITEMS,
	calculateBonuses,
	calculateIncrementalBonuses,
	getDonorByNumber,
	getDonorByUserId,
	getDonorTotal,
	getWaifuRollBonuses,
	awardDonorBonuses
};
