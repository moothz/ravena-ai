/**
 * ShadowGardenBonusService.js
 *
 * Gerencia o despacho de bônus do Jardim das Sombras:
 * - Drops de colheita para Pesca, Slots e Waifus.
 * - Inventário SQLite local de rolls/tickets da Fazenda (farm_bonus_inventory).
 * - Cálculos e distribuição de bônus para doadores no Jardim das Sombras.
 */

const Database = require("../utils/Database");
const Logger = require("../utils/Logger");
const FishingGame = require("../functions/FishingGame");
const SlotsGame = require("../functions/SlotsGame");

const logger = new Logger("shadow-garden-bonus");
const database = Database.getInstance();
const dbName = "core";

// Inicializa tabelas locais para persistência de bônus e controle de colheitas
try {
	database.getSQLiteDb(
		dbName,
		`CREATE TABLE IF NOT EXISTS farm_bonus_inventory (
			user_id TEXT PRIMARY KEY,
			rolls INTEGER DEFAULT 0,
			tickets INTEGER DEFAULT 0,
			updated_at INTEGER
		);
		CREATE TABLE IF NOT EXISTS farm_credited_crops (
			user_id TEXT,
			crop_item_id TEXT,
			credited_quantity INTEGER DEFAULT 0,
			updated_at INTEGER,
			PRIMARY KEY (user_id, crop_item_id)
		);`
	);
} catch (err) {
	logger.warn(`Erro ao inicializar tabelas da fazenda no core.db: ${err.message}`);
}

// ─── MAPEAMENTO DE COLHEITAS PARA BÔNUS EXTERNOS ───────────────────────────
const PLANT_BONUS_MAP = {
	crop_05_mist_crawler_v2: { bonusType: "fishing_buff", name: "Rastejante de Névoa" },
	crop_06_styx_kelp_v2: { bonusType: "fishing_weight_buff", name: "Alga do Estige" },
	crop_07_spectral_gourd_v2: { bonusType: "fishing_inventory_boost", name: "Cabaça Espectral" },
	crop_08_devouring_root_v2: { bonusType: "fishing_baits_5", name: "Raiz Devoradora" },
	crop_09_obsidian_clover: { bonusType: "casino_standard_chips", name: "Trevo de Obsidiana" },
	crop_10_golden_clover: { bonusType: "casino_gold_chips", name: "Trevo Dourado" },
	crop_11_purple_heart: { bonusType: "waifu_rolls", name: "Coração Púrpuro" },
	crop_12_blood_rose: { bonusType: "waifu_premium_ticket", name: "Rosa de Sangue" }
};

// ─── ITENS CANÔNICOS DE PESCA PARA COLHEITA ─────────────────────────────────
const FISHING_BUFF_POOL = [
	"Minhocão",
	"Chapéu de Pescador",
	"Carretel",
	"Balança Adulterada",
	"Rede de Pesca"
];

const FISHING_INVENTORY_BOOST_POOL = [
	"Bolso de Pesca",
	"Calça de Pesca",
	"Mochilão",
	"Pochete de Iscas",
	"Caixa de Iscas",
	"Viveiro Portátil"
];

// ─── ITENS DECORATIVOS VIP PARA DOADORES ───────────────────────────────────
const VIP_BASIC_DECORS = [
	"decor_19_fallen_king_crown",
	"decor_20_blood_diamond_cluster",
	"decor_21_molten_gold_chalice"
];

const VIP_MEDIUM_DECORS = [
	"decor_22_marble_gold_tombstone",
	"decor_23_sapphire_fire_lantern",
	"decor_24_solid_gold_gargoyle"
];

const VIP_HIGH_DECORS = [
	"decor_25_imprisoned_crystal_moon",
	"decor_26_platinum_imperial_fountain",
	"decor_27_dark_sun_niflheim"
];

const VIP_DECOR_NAMES = {
	decor_19_fallen_king_crown: "Coroa do Rei Caído",
	decor_20_blood_diamond_cluster: "Diamante de Sangue",
	decor_21_molten_gold_chalice: "Cálice de Ouro",
	decor_22_marble_gold_tombstone: "Lápide de Ouro",
	decor_23_sapphire_fire_lantern: "Lanterna de Safira",
	decor_24_solid_gold_gargoyle: "Gárgula Dourada",
	decor_25_imprisoned_crystal_moon: "Lua de Cristal",
	decor_26_platinum_imperial_fountain: "Fonte Imperial",
	decor_27_dark_sun_niflheim: "Sol Negro"
};

function pickRandom(arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}

function cleanUserId(id) {
	if (!id) return "";
	return String(id).replace(/\D/g, "");
}

/**
 * Adiciona rolls ou tickets de Waifus ganhos pela colheita
 * @param {string} userId
 * @param {Object} param1 - { rolls, tickets }
 */
async function addWaifuBonus(userId, { rolls = 0, tickets = 0 } = {}) {
	const cId = cleanUserId(userId);
	if (!cId) return;

	try {
		database.mappers.run(
			dbName,
			`INSERT INTO farm_bonus_inventory (user_id, rolls, tickets, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   rolls = rolls + excluded.rolls,
			   tickets = tickets + excluded.tickets,
			   updated_at = excluded.updated_at`,
			[cId, Math.max(0, rolls), Math.max(0, tickets), Date.now()]
		);
	} catch (err) {
		logger.error(`[addWaifuBonus] Erro ao creditar bônus de waifu para ${cId}: ${err.message}`);
	}
}

/**
 * Consulta saldo de rolls e tickets de Waifus ganhos pela fazenda
 * @param {string} userId
 * @returns {Promise<{ rolls: number, tickets: number }>}
 */
async function getWaifuBonus(userId) {
	const cId = cleanUserId(userId);
	if (!cId) return { rolls: 0, tickets: 0 };

	try {
		const row = database.mappers.get(
			dbName,
			"SELECT rolls, tickets FROM farm_bonus_inventory WHERE user_id = ?",
			[cId]
		);
		return {
			rolls: Math.max(0, Number(row?.rolls) || 0),
			tickets: Math.max(0, Number(row?.tickets) || 0)
		};
	} catch (err) {
		logger.error(`[getWaifuBonus] Erro ao buscar bônus para ${cId}: ${err.message}`);
		return { rolls: 0, tickets: 0 };
	}
}

/**
 * Consome 1 roll ou ticket de Waifu da fazenda
 * Prioridade: Consome ticket primeiro (maior raridade), depois roll comum.
 * @param {string} userId
 * @returns {Promise<{ consumed: boolean, type?: 'ticket' | 'roll', remainingRolls: number, remainingTickets: number }>}
 */
async function consumeWaifuBonus(userId) {
	const cId = cleanUserId(userId);
	if (!cId) return { consumed: false, remainingRolls: 0, remainingTickets: 0 };

	const current = await getWaifuBonus(cId);
	if (current.tickets > 0) {
		try {
			database.mappers.run(
				dbName,
				"UPDATE farm_bonus_inventory SET tickets = tickets - 1, updated_at = ? WHERE user_id = ?",
				[Date.now(), cId]
			);
			return {
				consumed: true,
				type: "ticket",
				remainingRolls: current.rolls,
				remainingTickets: current.tickets - 1
			};
		} catch (err) {
			logger.error(`[consumeWaifuBonus] Erro ao consumir ticket de ${cId}: ${err.message}`);
		}
	} else if (current.rolls > 0) {
		try {
			database.mappers.run(
				dbName,
				"UPDATE farm_bonus_inventory SET rolls = rolls - 1, updated_at = ? WHERE user_id = ?",
				[Date.now(), cId]
			);
			return {
				consumed: true,
				type: "roll",
				remainingRolls: current.rolls - 1,
				remainingTickets: 0
			};
		} catch (err) {
			logger.error(`[consumeWaifuBonus] Erro ao consumir roll de ${cId}: ${err.message}`);
		}
	}

	return { consumed: false, remainingRolls: 0, remainingTickets: 0 };
}

/**
 * Cria buff de pesca a partir de um upgrade existente em FishingGame.UPGRADES
 * @param {string} itemName
 * @returns {Object}
 */
function createBuffForItem(itemName) {
	const upgrade = FishingGame.UPGRADES.find((u) => u.name === itemName);
	if (!upgrade) {
		throw new Error(`Upgrade de pesca não encontrado: ${itemName}`);
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
 * Despacha os bônus externos de colheita (Pesca, Slots e Waifus)
 * @param {string} userId
 * @param {Array<Object>} harvestedDrops
 * @returns {Promise<Array<string>>} Lista de mensagens descritivas dos bônus concedidos
 */
async function dispatchHarvestDrops(userId, harvestedDrops = []) {
	const dispatchedMessages = [];
	const cId = cleanUserId(userId);

	for (const drop of harvestedDrops) {
		const count = drop.count || 1;

		let cropKey = drop.plantId
			? drop.plantId.startsWith("crop_")
				? drop.plantId
				: `crop_${drop.plantId}`
			: null;
		if (!cropKey && drop.name) {
			for (const [k, v] of Object.entries(PLANT_BONUS_MAP)) {
				if (v.name === drop.name || v.bonusType === drop.bonusType) {
					cropKey = k;
					break;
				}
			}
		}

		switch (drop.bonusType) {
			case "coins":
			case "none":
				// Moedas já são somadas e persistidas pela própria API da Fazenda, e none não tem bônus externo
				break;

			case "fishing_buff": {
				// ID 5: Rastejante de Névoa — sorteia da lista restrita canônica
				const itemsWon = [];
				for (let i = 0; i < count; i++) {
					const chosenName = pickRandom(FISHING_BUFF_POOL);
					const buff = createBuffForItem(chosenName);
					await FishingGame.addBuff(cId, buff, false);
					itemsWon.push(chosenName);
				}
				dispatchedMessages.push(
					`• *${drop.name}* (x${count}) ➔ Buffs de pesca concedidos: ${itemsWon.join(", ")}`
				);
				break;
			}

			case "fishing_inventory_boost": {
				// ID 7: Cabaça Espectral — sorteia da lista restrita canônica de expansão
				const itemsWon = [];
				for (let i = 0; i < count; i++) {
					const chosenName = pickRandom(FISHING_INVENTORY_BOOST_POOL);
					const buff = createBuffForItem(chosenName);
					await FishingGame.addBuff(cId, buff, false);
					itemsWon.push(chosenName);
				}
				dispatchedMessages.push(
					`• *${drop.name}* (x${count}) ➔ Equipamentos de pesca equipados: ${itemsWon.join(", ")}`
				);
				break;
			}

			case "fishing_weight_buff": {
				// ID 6: Alga do Estige — concede bônus de peso (+15% a +50%) no próximo peixe
				const bonusPercent = Math.min(0.5, Number((0.15 * count).toFixed(2)));
				await FishingGame.addBuff(
					cId,
					{
						type: "weight_boost",
						value: bonusPercent,
						remainingUses: 1,
						originalName: "Alga do Estige"
					},
					false
				);
				dispatchedMessages.push(
					`• *${drop.name}* (x${count}) ➔ +${Math.round(bonusPercent * 100)}% de peso no seu próximo peixe!`
				);
				break;
			}

			case "fishing_baits_5": {
				// ID 8: Raiz Devoradora — concede 5 iscas vivas por planta colhida
				const baitsToAdd = 5 * count;
				await FishingGame.addBaits(cId, baitsToAdd);
				dispatchedMessages.push(
					`• *${drop.name}* (x${count}) ➔ +${baitsToAdd} iscas vivas adicionadas ao seu balde de pesca!`
				);
				break;
			}

			case "casino_standard_chips": {
				// ID 9: Trevo de Obsidiana — concede 5 moedas de slots por planta
				const coinsToAdd = 5 * count;
				await SlotsGame.addCoins(cId, coinsToAdd, true);
				dispatchedMessages.push(
					`• *${drop.name}* (x${count}) ➔ +${coinsToAdd} moedinhas adicionadas para jogar no !slots!`
				);
				break;
			}

			case "casino_gold_chips": {
				// ID 10: Trevo Dourado — concede 25 moedas de ouro de slots por planta
				const coinsToAdd = 25 * count;
				await SlotsGame.addCoins(cId, coinsToAdd, true);
				dispatchedMessages.push(
					`• *${drop.name}* (x${count}) ➔ +${coinsToAdd} moedas de ouro creditadas no !slots!`
				);
				break;
			}

			case "waifu_roll":
			case "waifu_rolls": {
				// ID 11: Coração Púrpuro — concede 2 rolls de Waifuletes por planta
				const rollsToAdd = 2 * count;
				await addWaifuBonus(cId, { rolls: rollsToAdd });
				dispatchedMessages.push(
					`• *${drop.name}* (x${count}) ➔ +${rollsToAdd} rolls especiais de Waifuletes acumulados!`
				);
				break;
			}

			case "waifu_ticket":
			case "waifu_premium_ticket": {
				// ID 12: Rosa de Sangue — concede 1 ticket raro de Waifu por planta
				const ticketsToAdd = 1 * count;
				await addWaifuBonus(cId, { tickets: ticketsToAdd });
				dispatchedMessages.push(
					`• *${drop.name}* (x${count}) ➔ +${ticketsToAdd} Ticket Especial de Waifu Rara!`
				);
				break;
			}

			default:
				logger.warn(`[dispatchHarvestDrops] bonusType desconhecido: ${drop.bonusType}`);
				break;
		}

		if (cropKey && PLANT_BONUS_MAP[cropKey]) {
			try {
				database.mappers.run(
					dbName,
					`INSERT INTO farm_credited_crops (user_id, crop_item_id, credited_quantity, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(user_id, crop_item_id) DO UPDATE SET
					   credited_quantity = credited_quantity + excluded.credited_quantity,
					   updated_at = excluded.updated_at`,
					[cId, cropKey, count, Date.now()]
				);
			} catch (err) {
				logger.warn(`Erro ao atualizar farm_credited_crops para ${cId}: ${err.message}`);
			}
		}
	}

	return dispatchedMessages;
}

/**
 * Sincroniza e credita bônus de colheitas que estão no inventário (ex: colhidas pelo Farm Admin Web)
 * @param {string} userId
 * @param {Array<Object>} inventoryItems
 * @returns {Promise<Array<string>>} Lista de mensagens com bônus creditados
 */
async function syncInventoryCrops(userId, inventoryItems = []) {
	const cId = cleanUserId(userId);
	if (!cId || !Array.isArray(inventoryItems) || inventoryItems.length === 0) return [];

	const dropsToDispatch = [];

	for (const item of inventoryItems) {
		if (!item || !item.itemId || !item.itemId.startsWith("crop_")) continue;
		const plantInfo = PLANT_BONUS_MAP[item.itemId];
		if (!plantInfo) continue;

		const currentQty = Math.max(0, Number(item.quantity) || 0);

		let creditedQty = 0;
		try {
			const row = database.mappers.get(
				dbName,
				"SELECT credited_quantity FROM farm_credited_crops WHERE user_id = ? AND crop_item_id = ?",
				[cId, item.itemId]
			);
			creditedQty = Math.max(0, Number(row?.credited_quantity) || 0);
		} catch (err) {
			logger.warn(`Erro ao consultar farm_credited_crops para ${cId}: ${err.message}`);
		}

		if (currentQty < creditedQty) {
			// Usuário vendeu colheitas, ajusta quantidade creditada para a atual
			try {
				database.mappers.run(
					dbName,
					"UPDATE farm_credited_crops SET credited_quantity = ?, updated_at = ? WHERE user_id = ? AND crop_item_id = ?",
					[currentQty, Date.now(), cId, item.itemId]
				);
			} catch (err) {
				logger.warn(`Erro ao atualizar farm_credited_crops para ${cId}: ${err.message}`);
			}
		} else if (currentQty > creditedQty) {
			const uncredited = currentQty - creditedQty;
			dropsToDispatch.push({
				plantId: item.itemId,
				name: plantInfo.name,
				bonusType: plantInfo.bonusType,
				count: uncredited
			});
		}
	}

	if (dropsToDispatch.length > 0) {
		return await dispatchHarvestDrops(cId, dropsToDispatch);
	}
	return [];
}

/**
 * Calcula a lista de decorações VIP devidas para um valor doado (até 3 de cada item)
 * @param {number} valor
 * @returns {Array<string>} Lista de decor IDs
 */
function getEligibleVipDecorations(valor) {
	const items = [];

	// Básicos (>= 50: 1 + (V - 50)/25, máx 9 total, máx 3 de cada)
	if (valor >= 50) {
		const totalCount = Math.min(9, 1 + Math.floor((valor - 50) / 25));
		for (let i = 0; i < totalCount; i++) {
			items.push(VIP_BASIC_DECORS[i % 3]);
		}
	}

	// Médios (>= 100: 1 + (V - 100)/25, máx 9 total, máx 3 de cada)
	if (valor >= 100) {
		const totalCount = Math.min(9, 1 + Math.floor((valor - 100) / 25));
		for (let i = 0; i < totalCount; i++) {
			items.push(VIP_MEDIUM_DECORS[i % 3]);
		}
	}

	// Altos (>= 300: 1 + (V - 300)/25, máx 9 total, máx 3 de cada)
	if (valor >= 300) {
		const totalCount = Math.min(9, 1 + Math.floor((valor - 300) / 25));
		for (let i = 0; i < totalCount; i++) {
			items.push(VIP_HIGH_DECORS[i % 3]);
		}
	}

	return items;
}

/**
 * Calcula os bônus e itens incrementais de doação para a Fazenda
 * @param {number} totalAmount
 * @param {number} previousAmount
 * @returns {Object}
 */
function calculateFarmDonationBonuses(totalAmount, previousAmount = 0) {
	totalAmount = Math.max(0, Number(totalAmount) || 0);
	previousAmount = Math.max(0, Number(previousAmount) || 0);

	// Buffs permanentes (a cada R$20, R$25 e R$30)
	const curDailyLuck = Math.floor(totalAmount / 20);
	const prevDailyLuck = Math.floor(previousAmount / 20);
	const deltaDailyLuck = Math.max(0, curDailyLuck - prevDailyLuck);

	const curCoins = Math.floor(totalAmount / 25);
	const prevCoins = Math.floor(previousAmount / 25);
	const deltaCoinsBonus = Math.max(0, curCoins - prevCoins);

	const curSpeed = Math.floor(totalAmount / 30);
	const prevSpeed = Math.floor(previousAmount / 30);
	const deltaGrowthSpeed = Math.max(0, curSpeed - prevSpeed);

	// Decorações VIP
	const curDecors = getEligibleVipDecorations(totalAmount);
	const prevDecors = getEligibleVipDecorations(previousAmount);
	const deltaDecors = curDecors.slice(prevDecors.length);

	return {
		totalAmount,
		previousAmount,
		current: {
			dailyLuck: curDailyLuck,
			coinsBonus: curCoins,
			growthSpeed: curSpeed,
			decorsCount: curDecors.length,
			dailyLuckRemainder: Number((totalAmount % 20).toFixed(2)),
			coinsRemainder: Number((totalAmount % 25).toFixed(2)),
			growthSpeedRemainder: Number((totalAmount % 30).toFixed(2))
		},
		delta: {
			dailyLuck: deltaDailyLuck,
			coinsBonus: deltaCoinsBonus,
			growthSpeed: deltaGrowthSpeed,
			decors: deltaDecors
		}
	};
}

module.exports = {
	FISHING_BUFF_POOL,
	FISHING_INVENTORY_BOOST_POOL,
	VIP_BASIC_DECORS,
	VIP_MEDIUM_DECORS,
	VIP_HIGH_DECORS,
	VIP_DECOR_NAMES,
	PLANT_BONUS_MAP,
	addWaifuBonus,
	getWaifuBonus,
	consumeWaifuBonus,
	dispatchHarvestDrops,
	syncInventoryCrops,
	getEligibleVipDecorations,
	calculateFarmDonationBonuses
};
