/**
 * ShadowGardenBonusService.js
 *
 * Gerencia o despacho de bônus do Jardim das Sombras:
 * - reconcileHarvestBonus(): caminho único de crédito, guiado pelos totais cumulativos de
 *   colheita reportados pela API do Jardim (GET /farm/:id/harvest-totals). É o que permite
 *   creditar iscas/rolls/fichas quando a colheita acontece no painel web do !faz-adm.
 * - dispatchHarvestDrops(): converte uma colheita em drops para Pesca, Slots e Waifus.
 * - syncInventoryCrops(): legado, usado só quando a API não expõe os totais.
 * - Inventário SQLite local de rolls/tickets da Fazenda (farm_credited_crops / farm_bonus_inventory).
 * - Cálculos e distribuição de bônus para doadores no Jardim das Sombras.
 */

const Database = require("../utils/Database");
const Logger = require("../utils/Logger");
const FishingGame = require("../functions/FishingGame");
const ShadowGardenClient = require("./ShadowGardenClient");

function getSlotsGame() {
	return require("../functions/SlotsGame");
}

const logger = new Logger("shadow-garden-bonus");
const database = Database.getInstance();
const jardimClient = new ShadowGardenClient();
const dbName = "core";

// Inicializa tabelas locais para persistência de bônus e controle de colheitas
// baseline_quantity: marcador de que a linha pertence ao regime de totais cumulativos
// (colheita reportada pela API do Jardim) e quanto do total já estava coberto pelo
// ledger antigo. NULL = linha legada (regime por inventário).
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
			baseline_quantity INTEGER,
			updated_at INTEGER,
			PRIMARY KEY (user_id, crop_item_id)
		);`
	);
	database.mappers.run(
		dbName,
		"ALTER TABLE farm_credited_crops ADD COLUMN baseline_quantity INTEGER"
	);
} catch (err) {
	// ALTER falha quando a coluna já existe (duplicate column name) — esperado.
	if (!/duplicate column name/i.test(err.message)) {
		logger.warn(`Erro ao inicializar tabelas da fazenda no core.db: ${err.message}`);
	}
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
			   rolls = COALESCE(rolls, 0) + excluded.rolls,
			   tickets = COALESCE(tickets, 0) + excluded.tickets,
			   updated_at = excluded.updated_at`,
			[cId, Math.max(0, rolls), Math.max(0, tickets), Date.now()]
		);
	} catch (err) {
		logger.error(`[addWaifuBonus] Erro ao creditar bônus de waifu para ${cId}: ${err.message}`);
	}
}

const lastUserSyncTimes = new Map();

/**
 * Consulta saldo de rolls e tickets de Waifus ganhos pela fazenda
 * @param {string} userId
 * @param {boolean} [autoSync=true] - Se true, tenta sincronizar colheitas do inventário automaticamente
 * @returns {Promise<{ rolls: number, tickets: number }>}
 */
async function getWaifuBonus(userId, autoSync = true) {
	const cId = cleanUserId(userId);
	if (!cId) return { rolls: 0, tickets: 0 };

	if (autoSync) {
		try {
			await syncUserBonuses(cId);
		} catch (e) {
			logger.debug(
				`[getWaifuBonus] Falha ao auto-sincronizar bônus de waifu para ${cId}: ${e.message}`
			);
		}
	}

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
 * @param {Object} [options]
 * @param {boolean} [options.updateLedger=true] - false quando o ledger já foi lançado
 *   por quem chamou (claim CAS do reconcileHarvestBonus), para não contar em dobro.
 * @returns {Promise<Array<string>>} Lista de mensagens descritivas dos bônus concedidos
 */
async function dispatchHarvestDrops(userId, harvestedDrops = [], options = {}) {
	const { updateLedger = true } = options;
	const dispatchedMessages = [];
	const cId = cleanUserId(userId);

	for (const drop of harvestedDrops) {
		const count = drop.count || 1;

		const cleanName = drop.name ? drop.name.replace(/\s*\(Colhida\)/i, "").trim() : "";
		const pIdStr =
			drop.plantId !== undefined && drop.plantId !== null ? String(drop.plantId).trim() : "";
		let cropKey = pIdStr ? (pIdStr.startsWith("crop_") ? pIdStr : `crop_${pIdStr}`) : null;

		if ((!cropKey || !PLANT_BONUS_MAP[cropKey]) && cleanName) {
			for (const [k, v] of Object.entries(PLANT_BONUS_MAP)) {
				if (v.name === cleanName || cleanName.includes(v.name)) {
					cropKey = k;
					break;
				}
			}
		}

		if ((!cropKey || !PLANT_BONUS_MAP[cropKey]) && drop.plantId) {
			const num = parseInt(String(drop.plantId).replace(/\D/g, ""), 10);
			if (num) {
				const pad = String(num).padStart(2, "0");
				const found = Object.keys(PLANT_BONUS_MAP).find((k) => k.startsWith(`crop_${pad}_`));
				if (found) cropKey = found;
			}
		}

		const mappedInfo = cropKey && PLANT_BONUS_MAP[cropKey] ? PLANT_BONUS_MAP[cropKey] : null;
		const bonusType = drop.bonusType || mappedInfo?.bonusType;
		const plantDisplayName = cleanName || mappedInfo?.name || drop.name || "Planta";

		switch (bonusType) {
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
					`• *${plantDisplayName}* (x${count}) ➔ Buffs de pesca concedidos: ${itemsWon.join(", ")}`
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
					`• *${plantDisplayName}* (x${count}) ➔ Equipamentos de pesca equipados: ${itemsWon.join(", ")}`
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
					`• *${plantDisplayName}* (x${count}) ➔ +${Math.round(bonusPercent * 100)}% de peso no seu próximo peixe!`
				);
				break;
			}

			case "fishing_baits_5": {
				// ID 8: Raiz Devoradora — concede 5 iscas vivas por planta colhida
				const baitsToAdd = 5 * count;
				await FishingGame.addBaits(cId, baitsToAdd);
				dispatchedMessages.push(
					`• *${plantDisplayName}* (x${count}) ➔ +${baitsToAdd} iscas vivas adicionadas ao seu balde de pesca!`
				);
				break;
			}

			case "casino_standard_chips": {
				// ID 9: Trevo de Obsidiana — concede 5 moedas de slots por planta
				const coinsToAdd = 5 * count;
				await getSlotsGame().addCoins(cId, coinsToAdd, true);
				dispatchedMessages.push(
					`• *${plantDisplayName}* (x${count}) ➔ +${coinsToAdd} moedinhas adicionadas para jogar no !slots!`
				);
				break;
			}

			case "casino_gold_chips": {
				// ID 10: Trevo Dourado — concede 25 moedas de ouro de slots por planta
				const coinsToAdd = 25 * count;
				await getSlotsGame().addCoins(cId, coinsToAdd, true);
				dispatchedMessages.push(
					`• *${plantDisplayName}* (x${count}) ➔ +${coinsToAdd} moedas de ouro creditadas no !slots!`
				);
				break;
			}

			case "waifu_roll":
			case "waifu_rolls": {
				// ID 11: Coração Púrpuro — concede 2 rolls de Waifuletes por planta
				const rollsToAdd = 2 * count;
				await addWaifuBonus(cId, { rolls: rollsToAdd });
				dispatchedMessages.push(
					`• *${plantDisplayName}* (x${count}) ➔ +${rollsToAdd} rolls especiais de Waifuletes acumulados!`
				);
				break;
			}

			case "waifu_ticket":
			case "waifu_premium_ticket": {
				// ID 12: Rosa de Sangue — concede 2 tickets raros de Waifu por planta (conforme plants.json)
				const ticketsToAdd = 2 * count;
				await addWaifuBonus(cId, { tickets: ticketsToAdd });
				dispatchedMessages.push(
					`• *${plantDisplayName}* (x${count}) ➔ +${ticketsToAdd} Ticket${ticketsToAdd > 1 ? "s" : ""} Especial de Waifu Rara!`
				);
				break;
			}

			default:
				if (bonusType) {
					logger.warn(`[dispatchHarvestDrops] bonusType desconhecido: ${bonusType}`);
				}
				break;
		}

		if (updateLedger && cropKey && PLANT_BONUS_MAP[cropKey]) {
			try {
				database.mappers.run(
					dbName,
					`INSERT INTO farm_credited_crops (user_id, crop_item_id, credited_quantity, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(user_id, crop_item_id) DO UPDATE SET
					   credited_quantity = COALESCE(credited_quantity, 0) + excluded.credited_quantity,
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

// ─── RECONCILIAÇÃO POR TOTAIS CUMULATIVOS (regime atual) ────────────────────
// A API do Jardim é a fonte de verdade do evento "colheita": GET /farm/:id/harvest-totals
// devolve o acumulado por planta desde a implantação. O bot credita só a diferença
// pendente, então:
//   - vender a colheita no painel antes de qualquer sync não come bônus;
//   - webhook repetido / fora de ordem não credita em dobro;
//   - bot fora do ar recupera tudo no próximo comando do jogador.
//
//   baseline_quantity = fatia do total que o ledger legado já cobria (marcador de migração)
//   credited_quantity = bônus creditados dentro deste regime
//   a creditar        = max(0, totalHarvested - baseline_quantity - credited_quantity)

const SYNC_THROTTLE_MS = 15000;
const reconcileLocks = new Map();

/** Serializa reconciliações do mesmo usuário (webhook e comando nunca correm juntos). */
function withUserLock(cId, task) {
	const prev = reconcileLocks.get(cId) || Promise.resolve();
	const result = prev.then(task, task);
	const chain = result.then(
		() => undefined,
		() => undefined
	);
	reconcileLocks.set(cId, chain);
	chain.then(() => {
		if (reconcileLocks.get(cId) === chain) reconcileLocks.delete(cId);
	});
	return result;
}

/**
 * @returns {{ credited: number, baseline: number|null }|null} baseline null = linha legada
 */
function readCropLedger(cId, cropItemId) {
	const row = database.mappers.get(
		dbName,
		"SELECT credited_quantity, baseline_quantity FROM farm_credited_crops WHERE user_id = ? AND crop_item_id = ?",
		[cId, cropItemId]
	);
	if (!row) return null;
	const rawBaseline = row.baseline_quantity;
	return {
		credited: Math.max(0, Number(row.credited_quantity) || 0),
		baseline:
			rawBaseline === null || rawBaseline === undefined
				? null
				: Math.max(0, Number(rawBaseline) || 0)
	};
}

/**
 * Migra a linha para o regime de totais cumulativos. Como a tabela crop_harvest_totals
 * na API do Jardim foi criada nova e conta apenas as colheitas a partir da implantação,
 * a baseline de contagem do novo regime é 0 (qualquer colheita reportada é nova e deve
 * ser creditada).
 */
function migrateCropLedger(cId, cropItemId) {
	const baseline = 0;
	database.mappers.run(
		dbName,
		`INSERT INTO farm_credited_crops (user_id, crop_item_id, credited_quantity, baseline_quantity, updated_at)
		 VALUES (?, ?, 0, 0, ?)
		 ON CONFLICT(user_id, crop_item_id) DO UPDATE SET
		   credited_quantity = 0,
		   baseline_quantity = 0,
		   updated_at = excluded.updated_at`,
		[cId, cropItemId, Date.now()]
	);
	return baseline;
}

/** Claim atômico (CAS): 0 linhas alteradas = outra reconciliação assumiu o crédito. */
function claimCredit(cId, cropItemId, uncredited, expectedCredited) {
	try {
		const res = database.mappers.run(
			dbName,
			`UPDATE farm_credited_crops SET credited_quantity = credited_quantity + ?, updated_at = ?
			  WHERE user_id = ? AND crop_item_id = ? AND credited_quantity = ?`,
			[uncredited, Date.now(), cId, cropItemId, expectedCredited]
		);
		return !!res && res.changes === 1;
	} catch (err) {
		logger.error(`[reconcile] Falha no claim de ${cId}/${cropItemId}: ${err.message}`);
		return false;
	}
}

/** Devolve o claim quando o despacho falha, para a próxima reconciliação tentar de novo. */
function releaseClaim(cId, cropItemId, uncredited) {
	try {
		database.mappers.run(
			dbName,
			`UPDATE farm_credited_crops SET credited_quantity = MAX(0, credited_quantity - ?), updated_at = ?
			  WHERE user_id = ? AND crop_item_id = ?`,
			[uncredited, Date.now(), cId, cropItemId]
		);
	} catch (err) {
		logger.error(`[reconcile] Falha ao devolver claim de ${cId}/${cropItemId}: ${err.message}`);
	}
}

async function reconcileFromTotals(cId, totals = []) {
	const messages = [];

	for (const entry of totals) {
		const cropItemId = String(entry?.itemId || "");
		const plantInfo = PLANT_BONUS_MAP[cropItemId];
		if (!plantInfo) continue;

		const total = Math.max(0, Number(entry?.totalHarvested) || 0);

		let ledger;
		try {
			ledger = readCropLedger(cId, cropItemId);
			if (!ledger || ledger.baseline === null) {
				const baseline = migrateCropLedger(cId, cropItemId);
				ledger = { credited: 0, baseline };
			} else if (ledger.baseline === 0 && ledger.credited > total) {
				logger.warn(
					`[reconcile] Detectada discrepância no ledger de ${cId}/${cropItemId}: credited (${ledger.credited}) > total (${total}). Auto-ajustando credited para ${total}.`
				);
				database.mappers.run(
					dbName,
					"UPDATE farm_credited_crops SET credited_quantity = ?, updated_at = ? WHERE user_id = ? AND crop_item_id = ?",
					[total, Date.now(), cId, cropItemId]
				);
				ledger.credited = total;
			}
		} catch (err) {
			logger.error(`[reconcile] Ledger indisponível para ${cId}/${cropItemId}: ${err.message}`);
			continue;
		}

		const uncredited = Math.max(0, total - ledger.baseline - ledger.credited);
		if (uncredited <= 0) continue;

		if (!claimCredit(cId, cropItemId, uncredited, ledger.credited)) {
			logger.warn(
				`[reconcile] Claim cancelado para ${cId}/${cropItemId}: outra reconciliação assumiu o crédito.`
			);
			continue;
		}

		try {
			const msgs = await dispatchHarvestDrops(
				cId,
				[
					{
						plantId: cropItemId,
						name: plantInfo.name,
						bonusType: plantInfo.bonusType,
						count: uncredited
					}
				],
				{ updateLedger: false }
			);
			messages.push(...msgs);
		} catch (err) {
			releaseClaim(cId, cropItemId, uncredited);
			logger.error(
				`[reconcile] Falha ao creditar ${uncredited}x ${cropItemId} para ${cId}: ${err.message}. Nova tentativa no próximo sync.`
			);
		}
	}

	return messages;
}

/**
 * Caminho ÚNICO de crédito de bônus de colheita.
 * Busca os totais cumulativos na API do Jardim e credita apenas a diferença pendente.
 * Idempotente por construção: o webhook apenas chama esta função, nunca credita direto.
 * @param {string} userId
 * @returns {Promise<Array<string>>} Mensagens dos bônus creditados
 */
async function reconcileHarvestBonus(userId) {
	const cId = cleanUserId(userId);
	if (!cId) return [];

	return withUserLock(cId, async () => {
		let totals = null;

		try {
			const res = await jardimClient.getHarvestTotals(cId);
			totals = Array.isArray(res?.totals) ? res.totals : [];
		} catch (err) {
			if (err?.status === 404 || err?.status === 405) {
				logger.warn(
					"[reconcile] API do Jardim sem /harvest-totals (versão antiga). Usando sincronização legada por inventário."
				);
			} else {
				logger.debug(`[reconcile] Totais indisponíveis para ${cId}: ${err?.message}`);
			}
		}

		lastUserSyncTimes.set(cId, Date.now());

		if (totals) {
			return reconcileFromTotals(cId, totals);
		}

		// Fallback: API antiga (sem rota de totais) ou indisponível — tenta pelo inventário.
		try {
			const invRes = await jardimClient.getInventory(cId);
			if (Array.isArray(invRes?.items)) {
				return await syncInventoryCrops(cId, invRes.items);
			}
		} catch (err) {
			logger.debug(`[reconcile] Fallback por inventário falhou para ${cId}: ${err?.message}`);
		}

		return [];
	});
}

/**
 * Sincronização LEGADA por inventário. Só é usada quando a API do Jardim não expõe
 * /harvest-totals. Colheitas já migradas para o regime de totais são ignoradas aqui e o
 * ledger nunca é rebaixado quando o estoque diminui — era isso que comia o bônus de quem
 * vendia a colheita no painel antes do sync.
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

		let creditedQty = 0;
		try {
			const ledger = readCropLedger(cId, item.itemId);
			if (ledger && ledger.baseline !== null) continue; // o regime de totais é o dono do crédito
			creditedQty = ledger ? ledger.credited : 0;
		} catch (err) {
			logger.warn(`Erro ao consultar farm_credited_crops para ${cId}: ${err.message}`);
		}

		const currentQty = Math.max(0, Number(item.quantity) || 0);
		if (currentQty > creditedQty) {
			dropsToDispatch.push({
				plantId: item.itemId,
				name: plantInfo.name,
				bonusType: plantInfo.bonusType,
				count: currentQty - creditedQty
			});
		}
	}

	if (dropsToDispatch.length > 0) {
		return await dispatchHarvestDrops(cId, dropsToDispatch);
	}
	return [];
}

/**
 * Sincroniza os bônus do inventário do Jardim das Sombras para o usuário
 * Busca o inventário do jogador na API e processa colheitas pendentes
 * @param {string} userId
 * @param {boolean} [force=false]
 * @returns {Promise<Array<string>>}
 */
/**
 * Sincroniza os bônus do Jardim para o usuário (throttle de 15 s).
 * Delega para reconcileHarvestBonus; o inventário só entra como fallback do cliente
 * quando a API do Jardim ainda não expõe /harvest-totals.
 * @param {string} userId
 * @param {boolean} [force=false]
 * @returns {Promise<Array<string>>}
 */
async function syncUserBonuses(userId, force = false) {
	const cId = cleanUserId(userId);
	if (!cId) return [];

	const now = Date.now();
	const lastSync = lastUserSyncTimes.get(cId) || 0;
	if (!force && now - lastSync < SYNC_THROTTLE_MS) {
		return [];
	}
	lastUserSyncTimes.set(cId, now);

	return reconcileHarvestBonus(cId);
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

/**
 * Formata um resumo curto do bônus concedido por uma planta para exibição inline na colheita.
 * Suporta formatos: "crop_12_blood_rose", "12_blood_rose", "12", ou nome da planta.
 * @param {string} plantIdOrName
 * @param {number} count
 * @returns {string|null} ex: "+6 Tickets de Waifu Rara" ou null se não tiver bônus de jogo
 */
function formatCropBonusInline(plantIdOrName, count = 1) {
	if (!plantIdOrName || count <= 0) return null;
	const pStr = String(plantIdOrName).trim();

	let cropKey = pStr.startsWith("crop_") ? pStr : `crop_${pStr}`;
	if (!PLANT_BONUS_MAP[cropKey]) {
		const num = parseInt(pStr.replace(/\D/g, ""), 10);
		if (num) {
			const pad = String(num).padStart(2, "0");
			const found = Object.keys(PLANT_BONUS_MAP).find((k) => k.startsWith(`crop_${pad}_`));
			if (found) cropKey = found;
		}
	}
	if (!PLANT_BONUS_MAP[cropKey]) {
		for (const [k, v] of Object.entries(PLANT_BONUS_MAP)) {
			if (v.name === pStr || pStr.includes(v.name)) {
				cropKey = k;
				break;
			}
		}
	}

	const info = PLANT_BONUS_MAP[cropKey];
	if (!info || !info.bonusType || info.bonusType === "none" || info.bonusType === "coins") {
		return null;
	}

	switch (info.bonusType) {
		case "fishing_buff":
			return `+${count} Buff${count > 1 ? "s" : ""} de Pesca`;
		case "fishing_weight_buff": {
			const pct = Math.min(50, Math.round(15 * count));
			return `+${pct}% peso na pesca`;
		}
		case "fishing_inventory_boost":
			return `+${count} Equipamento${count > 1 ? "s" : ""} de Pesca`;
		case "fishing_baits_5":
			return `+${5 * count} Iscas Vivas`;
		case "casino_standard_chips":
			return `+${5 * count} Fichas de Slots`;
		case "casino_gold_chips":
			return `+${25 * count} Fichas de Ouro (Slots)`;
		case "waifu_roll":
		case "waifu_rolls":
			return `+${2 * count} Rolls de Waifu`;
		case "waifu_ticket":
		case "waifu_premium_ticket":
			return `+${2 * count} Ticket${count * 2 > 1 ? "s" : ""} de Waifu Rara`;
		default:
			return null;
	}
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
	reconcileHarvestBonus,
	syncInventoryCrops,
	syncUserBonuses,
	getEligibleVipDecorations,
	calculateFarmDonationBonuses,
	formatCropBonusInline
};
