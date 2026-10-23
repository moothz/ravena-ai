const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const FishingGame = require("../functions/FishingGame");
const SlotsGame = require("../functions/SlotsGame");
const ShadowGardenBonusService = require("./ShadowGardenBonusService");
const ShadowGardenClient = require("./ShadowGardenClient");

const logger = new Logger("donor-bonus-service");
const database = Database.getInstance();
const jardimClient = new ShadowGardenClient();

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
	const netEfficiencyBonus = totalAmount > 20 ? 1 + Math.floor((totalAmount - 21) / 5) : 0;

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
		// Base de 4.0x (+300%) + 8% por real acima de 50 -> aos R$100: 8.0x (+700%) -> teto de 20.0x
		wishlistMultiplier = Math.min(20.0, Number((4.0 + (totalAmount - 50) * 0.08).toFixed(3)));
	}

	const zinthos = Math.round(totalAmount * 150);

	// Pinto Game (+1% de tamanho por R$1)
	const pintoBonusPercent = Math.round(totalAmount * 1);
	const pintoMultiplier = Number((1 + totalAmount * 0.01).toFixed(3));

	const farm = ShadowGardenBonusService.calculateFarmDonationBonuses(totalAmount, 0).current;

	return {
		totalAmount,
		pesca: {
			baits,
			simpleItemsCount,
			mediumItemsCount,
			highItems30to50Count,
			highItemsAbove50Count,
			totalHighItems,
			netEfficiencyBonus
		},
		slots: {
			coins
		},
		waifu: {
			donorBadge: "VIP Doador 💎",
			rarityMultipliers,
			wishlistMultiplier,
			extraMaxRolls: Math.floor(totalAmount / 10),
			zinthos
		},
		pinto: {
			bonusPercent: pintoBonusPercent,
			multiplier: pintoMultiplier
		},
		fazenda: farm
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
	const deltaZinthos = Math.max(0, (current.waifu?.zinthos || 0) - (previous.waifu?.zinthos || 0));
	const deltaSimpleItems = Math.max(
		0,
		current.pesca.simpleItemsCount - previous.pesca.simpleItemsCount
	);
	const deltaMediumItems = Math.max(
		0,
		current.pesca.mediumItemsCount - previous.pesca.mediumItemsCount
	);
	const deltaHighItems = Math.max(0, current.pesca.totalHighItems - previous.pesca.totalHighItems);

	const farmDelta = ShadowGardenBonusService.calculateFarmDonationBonuses(
		totalAmount,
		previousAmount
	).delta;

	return {
		deltaAmount,
		deltaBaits,
		deltaCoins,
		deltaZinthos,
		deltaSimpleItems,
		deltaMediumItems,
		deltaHighItems,
		deltaFazenda: farmDelta,
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
		rarityMultipliers: bonuses.waifu.rarityMultipliers,
		extraMaxRolls: bonuses.waifu.extraMaxRolls
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

		const previousZinthosAmount =
			donor.zinthosProcessedAmount !== undefined && donor.zinthosProcessedAmount !== null
				? Number(donor.zinthosProcessedAmount) || 0
				: 0;

		const delta = calculateIncrementalBonuses(totalAmount, previousAmount);
		const deltaZinthos = Math.max(
			0,
			Math.round(totalAmount * 150) - Math.round(previousZinthosAmount * 150)
		);
		delta.deltaZinthos = deltaZinthos;

		if (delta.deltaAmount <= 0 && deltaZinthos <= 0) {
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

			// 4. Concede Itens e Decorações da Fazenda (Jardim das Sombras)
			if (delta.deltaFazenda) {
				try {
					if (delta.deltaFazenda.dailyLuck > 0) {
						await jardimClient.adminGive(cleanNumber, {
							itemId: "liquid_ashes",
							amount: delta.deltaFazenda.dailyLuck,
							reason: "donor_reward"
						});
					}
					if (delta.deltaFazenda.coinsBonus > 0) {
						await jardimClient.adminGive(cleanNumber, {
							itemId: "midas_tear",
							amount: delta.deltaFazenda.coinsBonus,
							reason: "donor_reward"
						});
					}
					if (delta.deltaFazenda.growthSpeed > 0) {
						await jardimClient.adminGive(cleanNumber, {
							itemId: "spectral_sigh",
							amount: delta.deltaFazenda.growthSpeed,
							reason: "donor_reward"
						});
					}
					if (delta.deltaFazenda.decors && delta.deltaFazenda.decors.length > 0) {
						for (const decorId of delta.deltaFazenda.decors) {
							await jardimClient.adminGive(cleanNumber, {
								itemId: decorId,
								amount: 1,
								reason: "donor_reward"
							});
						}
					}
				} catch (farmErr) {
					logger.warn(
						`[DonorBonusService] Falha ao despachar itens da fazenda para ${cleanNumber}: ${farmErr.message}`
					);
				}
			}

			// 5. Concede Zinthos na API do Waifuletes
			if (deltaZinthos > 0) {
				try {
					const WaifuCommands = require("../functions/WaifuCommands");
					await WaifuCommands.grantZinthos(cleanNumber, deltaZinthos, {
						donorName: donor.nome,
						totalAmount
					});
					await database.updateDonorZinthosProcessed(donor.nome, totalAmount);
				} catch (wErr) {
					logger.warn(
						`[DonorBonusService] Falha ao creditar Zinthos para ${cleanNumber}: ${wErr.message}`
					);
				}
			}

			// 6. Atualiza o valor processado no banco de doações (pesca e slots)
			if (delta.deltaAmount > 0) {
				await database.updateDonorBonusProcessed(donor.nome, totalAmount);
			}

			let logDetails = `+${delta.deltaBaits} iscas, +${delta.deltaCoins} moedas, +${chosenItems.length} itens`;
			if (deltaZinthos > 0) {
				logDetails += `, +${deltaZinthos} Zinthos`;
			}
			if (delta.deltaFazenda) {
				const fLog = [];
				if (delta.deltaFazenda.dailyLuck > 0) fLog.push(`+${delta.deltaFazenda.dailyLuck} cinzas`);
				if (delta.deltaFazenda.coinsBonus > 0) fLog.push(`+${delta.deltaFazenda.coinsBonus} midas`);
				if (delta.deltaFazenda.growthSpeed > 0)
					fLog.push(`+${delta.deltaFazenda.growthSpeed} suspiro`);
				if (delta.deltaFazenda.decors?.length > 0)
					fLog.push(`+${delta.deltaFazenda.decors.length} decors`);
				if (fLog.length > 0) logDetails += `, fazenda: [${fLog.join(", ")}]`;
			}

			logger.info(
				`[DonorBonusService] Bônus concedidos com sucesso para ${donor.nome} (${cleanNumber}): ${logDetails}.`
			);
		} else {
			logger.info(
				`[DonorBonusService] [DRY-RUN] Simulação de bônus para ${donor.nome} (${cleanNumber}): +${delta.deltaBaits} iscas, +${delta.deltaCoins} moedas, +${deltaZinthos} Zinthos, +${chosenItems.length} itens.`
			);
		}

		const bonusMsg = formatBonusMessage({ success: true, delta, chosenItems });

		return {
			success: true,
			dryRun,
			cleanNumber,
			donorName: donor.nome,
			totalAmount,
			previousAmount,
			delta,
			chosenItems,
			bonusMsg
		};
	} catch (error) {
		logger.error("Erro ao conceder bônus de doador:", error);
		return { success: false, error: error.message };
	}
}

/**
 * Formata em texto legível a mensagem de bônus concedidos para doadores
 * @param {Object} bonusRes - Objeto de resultado retornado por awardDonorBonuses
 * @returns {string} Mensagem formatada iniciando com quebra de linha (se houver bônus)
 */
function formatBonusMessage(bonusRes) {
	if (
		!bonusRes ||
		!bonusRes.success ||
		!bonusRes.delta ||
		(bonusRes.delta.deltaAmount <= 0 && (bonusRes.delta.deltaZinthos || 0) <= 0)
	) {
		return "";
	}

	const { delta, chosenItems } = bonusRes;
	const parts = [];

	if (delta.deltaBaits > 0) {
		parts.push(`+${delta.deltaBaits} iscas`);
	}
	if (delta.deltaCoins > 0) {
		parts.push(`+${delta.deltaCoins} moedas`);
	}
	if (delta.deltaZinthos > 0) {
		parts.push(`+${delta.deltaZinthos.toLocaleString("pt-BR")} Zinthos (💜)`);
	}
	const itemsCount = chosenItems?.length || 0;
	if (itemsCount > 0) {
		parts.push(`+${itemsCount} ${itemsCount === 1 ? "item de pesca" : "itens de pesca"}`);
	}

	let msg = "";
	if (parts.length > 0) {
		msg += `\n🎁 *Bônus concedidos:* ${parts.join(", ")}!`;
	}

	// Bônus da Fazenda (Jardim Lutoso)
	if (delta.deltaFazenda) {
		const farmParts = [];
		if (delta.deltaFazenda.dailyLuck > 0) {
			const count = delta.deltaFazenda.dailyLuck;
			farmParts.push(`+${count} Cinzas Líquidas`);
		}
		if (delta.deltaFazenda.coinsBonus > 0) {
			const count = delta.deltaFazenda.coinsBonus;
			farmParts.push(`+${count} ${count === 1 ? "Lágrima de Midas" : "Lágrimas de Midas"}`);
		}
		if (delta.deltaFazenda.growthSpeed > 0) {
			const count = delta.deltaFazenda.growthSpeed;
			farmParts.push(`+${count} ${count === 1 ? "Suspiro Espectral" : "Suspiros Espectrais"}`);
		}
		if (delta.deltaFazenda.decors && delta.deltaFazenda.decors.length > 0) {
			const count = delta.deltaFazenda.decors.length;
			const decorNames = delta.deltaFazenda.decors
				.map((d) => ShadowGardenBonusService.VIP_DECOR_NAMES?.[d] || d)
				.join(", ");
			if (count <= 2) {
				farmParts.push(
					`+${count} ${count === 1 ? "decoração VIP" : "decorações VIP"} (${decorNames})`
				);
			} else {
				farmParts.push(`+${count} decorações VIP`);
			}
		}

		if (farmParts.length > 0) {
			msg += `\n🦇 *Fazenda:* ${farmParts.join(", ")}!`;
		}
	}

	return msg;
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
	awardDonorBonuses,
	formatBonusMessage
};
