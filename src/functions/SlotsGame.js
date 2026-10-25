// src/functions/SlotsGame.js
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const FishingGame = require("./FishingGame");
const GameEventService = require("../services/GameEventService");
const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");

const logger = new Logger("slots-game");
const database = Database.getInstance();
const dbName = "slots";

// Initialize database
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS slots_users (
        user_id TEXT PRIMARY KEY,
        user_name TEXT,
        total_plays INTEGER DEFAULT 0,
        total_wins INTEGER DEFAULT 0,
        coins INTEGER DEFAULT 5,
        last_coin_regen INTEGER
    );

    CREATE TABLE IF NOT EXISTS slots_prizes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        prize_name TEXT,
        prize_type TEXT,
        timestamp INTEGER
    );

    CREATE TABLE IF NOT EXISTS slots_group_stats (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT,
        total_plays INTEGER DEFAULT 0,
        total_wins INTEGER DEFAULT 0,
        PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS slots_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT,
        user_id TEXT,
        user_name TEXT,
        is_win INTEGER,
        coins_spent INTEGER DEFAULT 1,
        timestamp INTEGER
    );
`
);

const MAX_COINS = 5;
const MAX_STORED_COINS = 1000;
const COIN_REGEN_TIME = 2 * 60; // 2 minutes in seconds
const SLOT_EMOJIS = ["🍎", "🍋", "🍒", "🍇", "🍉", "🍓", "🍑", "🍍", "🥭", "💎"];

const JUNK_PRIZES = [
	"Meia furada",
	"Papel de bala mascado",
	"Garrafa pet vazia",
	"Guarda-chuva quebrado",
	"Pilha estourada",
	"Chinelo de cor diferente",
	"Fio dental usado",
	"CD arranhado da Xuxa",
	"Controle remoto sem tampa",
	"Carregador com mau contato",
	"Pente faltando dente",
	"Tupperware sem tampa",
	"Pregador de roupa quebrado",
	"Caneta sem carga",
	"Bateria de 9V lambida"
];

const JARDIM_COMMON_SEEDS = [
	{ id: "01_nightshade", name: "Erva-Moura" },
	{ id: "02_mandrake", name: "Mandrágora" },
	{ id: "03_shadow_fern", name: "Samambaia Sombria" },
	{ id: "04_spectral_spores", name: "Esporos Espectrais" }
];

const JARDIM_BONUS_SEEDS = [
	{ id: "05_blood_lily", name: "Lírio de Sangue", tier: "uncommon" },
	{ id: "06_ghost_pepper", name: "Pimenta Fantasma", tier: "uncommon" },
	{ id: "07_abyssal_moss", name: "Musgo Abissal", tier: "uncommon" },
	{ id: "08_devouring_root_v2", name: "Raiz Devoradora", tier: "uncommon" },
	{ id: "09_grave_rose", name: "Rosa da Tumba", tier: "rare" },
	{ id: "10_golden_clover", name: "Trevo Dourado", tier: "rare" },
	{ id: "11_purple_heart", name: "Coração Púrpuro", tier: "rare" },
	{ id: "12_blood_rose", name: "Rosa de Sangue", tier: "rare" },
	{ id: "13_whispering_willow", name: "Salgueiro Sussurrante", tier: "epic" },
	{ id: "14_obsidian_cactus", name: "Cacto de Obsidiana", tier: "epic" },
	{ id: "15_lich_crown", name: "Coroa do Lich", tier: "epic" },
	{ id: "16_crystal_lotus", name: "Lótus de Cristal", tier: "epic" }
];

function pickFishingBuffs(count) {
	const fishingUpgrades = FishingGame.UPGRADES.filter((u) => u.effect !== "slots_coins");
	const chosen = [];
	for (let b = 0; b < count; b++) {
		const upgrade = fishingUpgrades[Math.floor(Math.random() * fishingUpgrades.length)];
		const buff = {
			type: upgrade.effect,
			value: upgrade.value || 0,
			minValue: upgrade.minValue || 0,
			maxValue: upgrade.maxValue || 0,
			remainingUses: upgrade.duration || 1,
			originalName: upgrade.name,
			emoji: upgrade.emoji || "🛠️",
			description: upgrade.description || ""
		};
		if (upgrade.effect === "extra_baits" || upgrade.effect === "next_fish_bonus") {
			buff.value =
				Math.floor(Math.random() * (upgrade.maxValue - upgrade.minValue + 1)) + upgrade.minValue;
		}
		chosen.push(buff);
	}
	return chosen;
}

function openSacolasDoCoveiro(numBags) {
	const droppedSeeds = {};
	for (let i = 0; i < numBags; i++) {
		const common = JARDIM_COMMON_SEEDS[Math.floor(Math.random() * JARDIM_COMMON_SEEDS.length)];
		if (!droppedSeeds[common.id]) droppedSeeds[common.id] = { name: common.name, count: 0 };
		droppedSeeds[common.id].count += 3;

		if (Math.random() < 0.33) {
			const bonus = JARDIM_BONUS_SEEDS[Math.floor(Math.random() * JARDIM_BONUS_SEEDS.length)];
			if (!droppedSeeds[bonus.id]) droppedSeeds[bonus.id] = { name: bonus.name, count: 0 };
			droppedSeeds[bonus.id].count += 1;
		}
	}
	return droppedSeeds;
}

function rollSingleReward(isPartial = false, isDiamond = false) {
	const mult = isDiamond ? 5 : 1;
	const cashbackPercent = isPartial ? Math.floor(Math.random() * (10 - 5 + 1)) + 5 : 0; // 5% a 10% (inteiros)
	const cashbackRate = cashbackPercent / 100;
	const r = Math.random() * 110;

	if (r < 10) {
		// 10%: Lixo
		const prize = JUNK_PRIZES[Math.floor(Math.random() * JUNK_PRIZES.length)];
		return {
			category: "junk",
			junkItem: prize,
			coins: 0,
			baits: 0,
			buffs: [],
			jardimCoins: 0,
			jardimBags: 0,
			zinthos: 0,
			waifuTickets: 0,
			cashbackPercent
		};
	} else if (r < 30) {
		// 20%: 10 a 80 moedas
		let coins = Math.floor(Math.random() * (80 - 10 + 1)) + 10;
		coins *= mult;
		if (isPartial) {
			coins = Math.max(1, Math.floor(coins * cashbackRate));
		}
		return {
			category: "coins",
			coins,
			junkItem: null,
			baits: 0,
			buffs: [],
			jardimCoins: 0,
			jardimBags: 0,
			zinthos: 0,
			waifuTickets: 0,
			cashbackPercent
		};
	} else if (r < 50) {
		// 20%: 5 a 25 iscas + 1 buff aleatório de pesca
		let baits = Math.floor(Math.random() * (25 - 5 + 1)) + 5;
		baits *= mult;
		let buffs = [];
		if (isPartial) {
			baits = Math.max(1, Math.floor(baits * cashbackRate));
		} else {
			const countBuffs = 1 * mult;
			buffs = pickFishingBuffs(countBuffs);
		}
		return {
			category: "baits_single_buff",
			baits,
			buffs,
			junkItem: null,
			coins: 0,
			jardimCoins: 0,
			jardimBags: 0,
			zinthos: 0,
			waifuTickets: 0,
			cashbackPercent
		};
	} else if (r < 65) {
		// 15%: 15 a 50 iscas, 2 a 5 buffs aleatórios de pesca
		let baits = Math.floor(Math.random() * (50 - 15 + 1)) + 15;
		baits *= mult;
		let buffs = [];
		if (isPartial) {
			baits = Math.max(1, Math.floor(baits * cashbackRate));
		} else {
			const countBuffs = (Math.floor(Math.random() * (5 - 2 + 1)) + 2) * mult;
			buffs = pickFishingBuffs(countBuffs);
		}
		return {
			category: "baits_multi_buffs",
			baits,
			buffs,
			junkItem: null,
			coins: 0,
			jardimCoins: 0,
			jardimBags: 0,
			zinthos: 0,
			waifuTickets: 0,
			cashbackPercent
		};
	} else if (r < 85) {
		// 20%: 300 a 2500 moedas do jardim e 1 a 5 sacolas do coveiro
		let jardimCoins = Math.floor(Math.random() * (2500 - 300 + 1)) + 300;
		jardimCoins *= mult;
		let jardimBags = 0;
		if (isPartial) {
			jardimCoins = Math.max(1, Math.floor(jardimCoins * cashbackRate));
		} else {
			jardimBags = (Math.floor(Math.random() * (5 - 1 + 1)) + 1) * mult;
		}
		return {
			category: "jardim",
			jardimCoins,
			jardimBags,
			junkItem: null,
			coins: 0,
			baits: 0,
			buffs: [],
			zinthos: 0,
			waifuTickets: 0,
			cashbackPercent
		};
	} else if (r < 100) {
		// 15%: 2100 a 7000 zinthos (-30%), 3 tickets de waifus
		let zinthos = Math.floor(Math.random() * (7000 - 2100 + 1)) + 2100;
		zinthos *= mult;
		let waifuTickets = 0;
		if (isPartial) {
			zinthos = Math.max(1, Math.floor(zinthos * cashbackRate));
		} else {
			waifuTickets = 3 * mult;
		}
		return {
			category: "zinthos_tier1",
			zinthos,
			waifuTickets,
			junkItem: null,
			coins: 0,
			baits: 0,
			buffs: [],
			jardimCoins: 0,
			jardimBags: 0,
			cashbackPercent
		};
	} else {
		// 10%: 5600 a 10500 zinthos (-30%), 5 tickets de waifus
		let zinthos = Math.floor(Math.random() * (10500 - 5600 + 1)) + 5600;
		zinthos *= mult;
		let waifuTickets = 0;
		if (isPartial) {
			zinthos = Math.max(1, Math.floor(zinthos * cashbackRate));
		} else {
			waifuTickets = 5 * mult;
		}
		return {
			category: "zinthos_tier2",
			zinthos,
			waifuTickets,
			junkItem: null,
			coins: 0,
			baits: 0,
			buffs: [],
			jardimCoins: 0,
			jardimBags: 0,
			cashbackPercent
		};
	}
}

const WIN_MESSAGES = [
	"INACREDITÁVEL! Você limpou a banca! 🎰💰",
	"Hoje é seu dia de sorte! O jackpot é seu! ✨",
	"A sorte sorriu para você! Parabéns! 🎉",
	"Você nasceu virado pra lua! Ganhou! 🌕",
	"Os deuses do azar tiraram folga hoje! 🏆",
	"QUE MOMENTO HISTÓRICO! A sorte finalmente bateu na sua porta! 🌟",
	"CRAVOU! A máquina tremeu e soltou o prêmio! 💥💰",
	"Contra todas as probabilidades, você venceu! Pode comemorar! 🥳",
	"A banca chora e você sorri! Vitória espetacular! 🤑✨",
	"Sensacional! As estrelas se alinharam perfeitamente pra você! ⭐",
	"O impossível aconteceu! Você dobrou o destino e levou a melhor! 🍀"
];

const LOSE_MESSAGES = [
	"Não foi dessa vez... A casa sempre vence! 💸",
	"Quase! Só que não. Tente de novo daqui a pouco! 🤡",
	"O azar é seu sobrenome? Que triste... 🙊",
	"Mais sorte na próxima (ou não). 📉",
	"Seu dinheiro foi pro ralo! Literalmente. 🚽",
	"Talvez você devesse tentar algo menos arriscado, tipo... atravessar a rua de olhos fechados? 🚶‍♂️",
	"A banca agradece a sua doação generosa! 🤑",
	"Sinto cheiro de derrota... e é você. 👃",
	"Seu saldo de sorte está negativo. Favor recarregar. 🔋"
];

const MULTI_LOSE_MESSAGES = [
	"Girou tudo isso e NÃO GANHOU NADA?! Isso já não é azar, é uma maldição ancestral! 💀",
	"Rodou a máquina inteira e só colheu decepção. Parabéns pelo recorde mundial de zica! 📉",
	"Gastou todas as fichas pra passar essa vergonha coletiva? Nem se esforçando dava pra ser tão azarado! 🤡",
	"Se azar desse dinheiro, você comprava o cassino inteiro! Perdeu absolutamente tudo! 💸",
	"Impressionante! Errou todas as tentativas. Você foi abençoado pelo próprio deus do azar! 🪦",
	"Tantas chances e zero vitórias... Se você jogar uma moeda pra cima, ela cai em pé e te morde! 🪙🤦‍♂️",
	"A banca nem comemorou dessa vez, ficou foi com pena de você. Que fase tenebrosa! 📉",
	"Nem a física quântica explica esse nível de urucubaca. Você limpou o próprio bolso! 🧹",
	"Você não apenas perdeu, você redefiniu o conceito de azar no universo! 🌌💀",
	"Girou tudo isso e saiu de mãos abanando. Recomendo um banho de sal grosso urgente! 🧂",
	"A máquina engoliu tudo e nem cuspiu um farelo de volta. Simplesmente intocável pelo sucesso! 🎰🚫",
	"Zero acertos! O seu nível de azar devia ser estudado pela NASA! 🚀",
	"Gastou tudo e o único prêmio foi a humilhação pública. Meus pêsames! 🪦🤡",
	"Parabéns! Você conseguiu errar 100% das vezes. Uma verdadeira aula de infortúnio! 📉🤦‍♂️"
];

/**
 * Extrai o 1º mention do comando (via message.mentions, args ou quoted)
 * @param {Object} message - Objeto da mensagem
 * @param {Array} args - Argumentos do comando
 * @returns {{ targetJid: string|null, targetText: string }}
 */
function extractFirstMention(message, args) {
	let targetJid = null;
	let targetText = "";

	const rawMentions =
		Array.isArray(message.mentions) && message.mentions.length > 0
			? message.mentions
			: Array.isArray(message.origin?.mentionedIds) && message.origin.mentionedIds.length > 0
				? message.origin.mentionedIds
				: [];

	if (rawMentions.length > 0) {
		targetJid = rawMentions[0];
	}

	const mentionArg = Array.isArray(args)
		? args.find((a) => typeof a === "string" && a.startsWith("@"))
		: null;

	if (mentionArg) {
		const cleanDigits = mentionArg.replace(/^@/, "").replace(/\D/g, "");
		if (!targetJid && cleanDigits.length >= 7) {
			targetJid = `${cleanDigits}@s.whatsapp.net`;
		}
		if (cleanDigits.length >= 7) {
			targetText = `@${cleanDigits}`;
		} else if (!targetJid) {
			targetText = mentionArg;
		}
	}

	if (!targetJid && !targetText) {
		const quotedParticipant =
			message.quotedParticipant ??
			message.origin?.quotedParticipant ??
			message.quotedMsg?.author ??
			message.origin?.quotedMsg?.author ??
			message.quotedMsg?.participant ??
			message.origin?.quotedMsg?.participant;
		if (quotedParticipant) {
			targetJid = quotedParticipant;
		}
	}

	if (targetJid && !targetText) {
		const cleanNum = targetJid.split("@")[0].replace(/\D/g, "");
		targetText = cleanNum ? `@${cleanNum}` : `@${targetJid.split("@")[0]}`;
	}

	return { targetJid, targetText };
}

/**
 * Obtém dados do usuário
 */
async function getUserData(userId, userName = null) {
	userId = `${userId}`.replace(/\D/g, "");
	let user = await database.dbGet(dbName, "SELECT * FROM slots_users WHERE user_id = ?", [userId]);
	if (!user) {
		const now = Date.now();
		await database.dbRun(
			dbName,
			"INSERT INTO slots_users (user_id, user_name, total_plays, total_wins, coins, last_coin_regen) VALUES (?, ?, 0, 0, ?, ?)",
			[userId, userName, MAX_COINS, now]
		);
		user = {
			user_id: userId,
			user_name: userName,
			total_plays: 0,
			total_wins: 0,
			coins: MAX_COINS,
			last_coin_regen: now
		};
	} else if (userName && user.user_name !== userName) {
		user.user_name = userName;
		await database.dbRun(dbName, "UPDATE slots_users SET user_name = ? WHERE user_id = ?", [
			userName,
			userId
		]);
	}
	return user;
}

/**
 * Salva dados do usuário
 */
async function saveUserData(userData) {
	await database.dbRun(
		dbName,
		`UPDATE slots_users 
         SET total_plays = ?, 
             total_wins = ?,
             coins = ?,
             last_coin_regen = ?,
             user_name = ?
         WHERE user_id = ?`,
		[
			userData.total_plays,
			userData.total_wins,
			userData.coins,
			userData.last_coin_regen,
			userData.user_name,
			userData.user_id
		]
	);
}

/**
 * Regenera moedinhas do usuário
 */
function regenerateCoins(userData) {
	if (userData.coins >= MAX_COINS) {
		userData.last_coin_regen = Date.now();
		return userData;
	}

	const now = Date.now();
	const lastRegen = userData.last_coin_regen || now;
	const elapsedSeconds = Math.floor((now - lastRegen) / 1000);
	const regensCount = Math.floor(elapsedSeconds / COIN_REGEN_TIME);

	if (regensCount > 0) {
		userData.coins = Math.min(userData.coins + regensCount, MAX_COINS);
		userData.last_coin_regen = now - (elapsedSeconds % COIN_REGEN_TIME) * 1000;
	}

	return userData;
}

function getNextCoinRegenTime(userData) {
	const now = Date.now();
	const lastRegen = userData.last_coin_regen || now;
	const elapsedSeconds = Math.floor((now - lastRegen) / 1000);
	const secondsUntilNextCoin = COIN_REGEN_TIME - (elapsedSeconds % COIN_REGEN_TIME);

	return {
		secondsUntilNextCoin,
		nextCoinTime: new Date(now + secondsUntilNextCoin * 1000)
	};
}

function formatTimeString(seconds) {
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Salva um prêmio ganho
 */
async function savePrize(userId, prizeName, prizeType) {
	await database.dbRun(
		dbName,
		"INSERT INTO slots_prizes (user_id, prize_name, prize_type, timestamp) VALUES (?, ?, ?, ?)",
		[userId, prizeName, prizeType, Date.now()]
	);
}

/**
 * Registra estatísticas do grupo
 */
async function recordGroupStats(groupId, userId, userName, wins = 0, plays = 1) {
	const winsCount = typeof wins === "boolean" ? (wins ? 1 : 0) : Number(wins) || 0;
	const playsCount = Number(plays) || 1;

	await database.dbRun(
		dbName,
		`INSERT INTO slots_group_stats (group_id, user_id, user_name, total_plays, total_wins)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(group_id, user_id) DO UPDATE SET 
            total_plays = total_plays + ?, 
            total_wins = total_wins + ?, 
            user_name = excluded.user_name`,
		[groupId, userId, userName, playsCount, winsCount, playsCount, winsCount]
	);
}

/**
 * Comando principal do slots
 */
async function slotsCommand(bot, message, args, group) {
	const userId = message.author;
	const chatId = message.group ?? message.author;

	let userName = message.authorName ?? "";
	if (userName.length === 0) {
		try {
			const contact = await message.origin.getContact();
			userName = contact.pushname || contact.name || "Jogador";
		} catch (error) {
			logger.error("Erro ao obter contato:", error);
			userName = "Jogador";
		}
	}

	try {
		const ShadowGardenBonusService = require("../services/ShadowGardenBonusService");
		await ShadowGardenBonusService.syncUserBonuses(userId);
	} catch (syncErr) {
		logger.debug(`[slotsCommand] Falha ao sincronizar bônus da fazenda: ${syncErr.message}`);
	}

	let userData = await getUserData(userId, userName);

	// Regenera moedas
	userData = regenerateCoins(userData);

	let rollsCount = 1;
	const numArg = Array.isArray(args)
		? args.find((a) => typeof a === "string" && /^-?\d+$/.test(a))
		: null;
	const maxArg = Array.isArray(args)
		? args.find((a) => typeof a === "string" && /^(tudo|all|max)$/i.test(a))
		: null;

	if (numArg) {
		const parsed = parseInt(numArg, 10);
		if (isNaN(parsed) || parsed <= 0) {
			return new ReturnMessage({
				chatId,
				content: "❌ Quantidade inválida de rodadas. Informe um número entre 1 e 30.",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}
		rollsCount = Math.min(parsed, 30);
	} else if (maxArg) {
		rollsCount = Math.min(Math.max(1, userData.coins), 30);
	}

	if (userData.coins <= 0) {
		const nextRegen = getNextCoinRegenTime(userData);
		const waitTime = formatTimeString(nextRegen.secondsUntilNextCoin);
		return new ReturnMessage({
			chatId,
			content: `❌ Você não tem moedinhas suficientes para jogar! \n\n🪙 Próxima moedinha em: *${waitTime}*`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	if (rollsCount > userData.coins) {
		return new ReturnMessage({
			chatId,
			content: `❌ Você não tem moedinhas suficientes para girar *${rollsCount}x*!\n\n🪙 Suas moedinhas: *${userData.coins}/${MAX_COINS}*`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	// Consome as moedas
	userData.coins -= rollsCount;
	userData.total_plays += rollsCount;

	const rollResults = [];
	let totalWins = 0;
	let totalPartialWins = 0;
	let hasDiamondJackpot = false;
	const winMult = GameEventService.getMultiplier("slots", "vitoria");

	for (let i = 0; i < rollsCount; i++) {
		const roll1 = Math.floor(Math.random() * SLOT_EMOJIS.length);
		let roll2 = Math.floor(Math.random() * SLOT_EMOJIS.length);
		let roll3 = Math.floor(Math.random() * SLOT_EMOJIS.length);

		let isWin = roll1 === roll2 && roll2 === roll3;

		// Bônus de evento: vitória extra no caça-coisas
		if (!isWin && winMult > 1) {
			const extraChance = 0.01 * (winMult - 1);
			if (Math.random() < extraChance) {
				isWin = true;
				roll2 = roll1;
				roll3 = roll1;
			}
		}

		const isDiamond = isWin && roll1 === 9; // 9 = "💎"
		if (isDiamond) hasDiamondJackpot = true;

		const isPartial = !isWin && (roll1 === roll2 || roll2 === roll3 || roll1 === roll3);

		if (isWin) {
			totalWins++;
		} else if (isPartial) {
			totalPartialWins++;
		}

		rollResults.push({
			emoji1: SLOT_EMOJIS[roll1],
			emoji2: SLOT_EMOJIS[roll2],
			emoji3: SLOT_EMOJIS[roll3],
			isWin,
			isPartial,
			isDiamond
		});
	}

	if (message.group) {
		await recordGroupStats(message.group, userId, userName, totalWins, rollsCount);
	}

	try {
		for (const roll of rollResults) {
			await database.dbRun(
				dbName,
				`INSERT INTO slots_history (group_id, user_id, user_name, is_win, coins_spent, timestamp)
				 VALUES (?, ?, ?, ?, 1, ?)`,
				[message.group || null, userId, userName, roll.isWin ? 1 : 0, Date.now()]
			);
		}
	} catch (errHist) {
		logger.error("Erro ao gravar histórico do slots:", errHist);
	}

	let resultMessage = `🎰 *CAÇA-COISAS* 🎰\n`;
	resultMessage += `\`\`\`---------------\n`;
	for (const roll of rollResults) {
		const mark = roll.isDiamond ? "💎" : roll.isWin ? "✅" : roll.isPartial ? "🟡" : "❌";
		resultMessage += `|  [ ${roll.emoji1} ] [ ${roll.emoji2} ] [ ${roll.emoji3} ]  | ${mark}\n`;
	}
	resultMessage += `---------------\`\`\`\n\n`;

	const authorNum = userId.split("@")[0].replace(/\D/g, "");
	const authorMention = authorNum ? `@${authorNum}` : `@${userId}`;

	const { targetJid, targetText } = extractFirstMention(message, args);

	const spinText = rollsCount > 1 ? "girou, girou, girou " : "girou";
	const actionPrefix = targetText
		? `${authorMention} pegou na alavanca de ${targetText}, ${spinText} e... `
		: `${authorMention} ${spinText} e... `;

	if (totalWins > 0 || totalPartialWins > 0) {
		userData.total_wins += totalWins;

		let totalCoinsWon = 0;
		let totalBaitsWon = 0;
		const totalBuffsWon = [];
		let totalJardimCoinsWon = 0;
		let totalJardimBagsWon = 0;
		let totalZinthosWon = 0;
		let totalTicketsWon = 0;
		const junkItemsWon = [];
		const partialCashbackPercents = [];

		for (const roll of rollResults) {
			if (roll.isWin) {
				const reward = rollSingleReward(false, roll.isDiamond);
				totalCoinsWon += reward.coins;
				totalBaitsWon += reward.baits;
				if (reward.buffs.length > 0) totalBuffsWon.push(...reward.buffs);
				totalJardimCoinsWon += reward.jardimCoins;
				totalJardimBagsWon += reward.jardimBags;
				totalZinthosWon += reward.zinthos;
				totalTicketsWon += reward.waifuTickets;
				if (reward.junkItem) junkItemsWon.push(reward.junkItem);
			} else if (roll.isPartial) {
				const reward = rollSingleReward(true, false);
				totalCoinsWon += reward.coins;
				totalBaitsWon += reward.baits;
				totalJardimCoinsWon += reward.jardimCoins;
				totalZinthosWon += reward.zinthos;
				if (reward.junkItem) junkItemsWon.push(reward.junkItem);
				if (reward.cashbackPercent) partialCashbackPercents.push(reward.cashbackPercent);
			}
		}

		// Credita moedas de slots
		if (totalCoinsWon > 0) {
			const coinMult = GameEventService.getMultiplier("slots", "moedas");
			if (coinMult > 1) {
				totalCoinsWon = Math.max(1, Math.round(totalCoinsWon * coinMult));
			}
			userData.coins = Math.min((userData.coins || 0) + totalCoinsWon, MAX_STORED_COINS);
			await savePrize(userId, `${totalCoinsWon} Moedinhas`, "bom");
		}

		// Credita iscas de pesca
		if (totalBaitsWon > 0) {
			const baitMult = GameEventService.getMultiplier("slots", "iscas");
			if (baitMult > 1) {
				totalBaitsWon = Math.max(1, Math.round(totalBaitsWon * baitMult));
			}
			await FishingGame.addBaits(userId, totalBaitsWon);
			await savePrize(userId, `${totalBaitsWon} Iscas`, "bom");
		}

		// Credita buffs de pesca
		for (const buff of totalBuffsWon) {
			await FishingGame.addBuff(userId, buff, false);
			await savePrize(userId, buff.originalName || "Buff de Pesca", "bom");
		}

		// Credita moedas do jardim e sacolas do coveiro
		let allOpenedSeeds = null;
		if (totalJardimCoinsWon > 0 || totalJardimBagsWon > 0) {
			try {
				const ShadowGardenClient = require("../services/ShadowGardenClient");
				const jardimClient = new ShadowGardenClient();
				if (totalJardimCoinsWon > 0) {
					await jardimClient.adminGive(userId, {
						coins: totalJardimCoinsWon,
						reason: "slots_prize"
					});
				}
				if (totalJardimBagsWon > 0) {
					allOpenedSeeds = openSacolasDoCoveiro(totalJardimBagsWon);
					for (const seedId of Object.keys(allOpenedSeeds)) {
						await jardimClient.adminGive(userId, {
							itemId: seedId,
							amount: allOpenedSeeds[seedId].count,
							reason: "slots_sacola"
						});
					}
				}
				await savePrize(
					userId,
					`${totalJardimCoinsWon} Moedas do Jardim + ${totalJardimBagsWon} Sacolas`,
					"bom"
				);
			} catch (jardimErr) {
				logger.warn(`[slots] Falha ao entregar prêmio do Jardim: ${jardimErr.message}`);
			}
		}

		// Credita Zinthos
		if (totalZinthosWon > 0) {
			try {
				const WaifuCommands = require("./WaifuCommands");
				if (typeof WaifuCommands.grantZinthos === "function") {
					await WaifuCommands.grantZinthos(userId, totalZinthosWon, { source: "SLOTS_PRIZE" });
				}
				await savePrize(userId, `${totalZinthosWon} Zinthos`, "bom");
			} catch (zErr) {
				logger.warn(`[slots] Falha ao entregar Zinthos: ${zErr.message}`);
			}
		}

		// Credita Tickets de Waifus
		if (totalTicketsWon > 0) {
			try {
				await ShadowGardenBonusService.addWaifuBonus(userId, { rolls: totalTicketsWon });
				await savePrize(userId, `${totalTicketsWon} Tickets de Waifu`, "bom");
			} catch (tErr) {
				logger.warn(`[slots] Falha ao entregar Tickets de Waifu: ${tErr.message}`);
			}
		}

		// Salva itens de lixo
		for (const junk of junkItemsWon) {
			await savePrize(userId, junk, "normal");
		}

		// Formata cabeçalho do resultado
		if (hasDiamondJackpot) {
			resultMessage += `${actionPrefix}💎 *JACKPOT LENDÁRIO DE DIAMANTES! (Prêmios QUINTUPLICADOS!)* 💎\n\n`;
		} else if (totalWins > 0) {
			const winMsg = WIN_MESSAGES[Math.floor(Math.random() * WIN_MESSAGES.length)];
			resultMessage += `${actionPrefix}🎊 *${winMsg}* 🎊\n\n`;
		} else {
			resultMessage += `${actionPrefix}✨ *Vitória Parcial! Você acertou 2 símbolos e garantiu cashback!* ✨\n\n`;
		}

		resultMessage += `🎁 *Resumo dos Prêmios Conquistados:*\n`;
		if (totalCoinsWon > 0) resultMessage += `• 🪙 *+${totalCoinsWon} Moedinhas do Slots*\n`;
		if (totalBaitsWon > 0) resultMessage += `• 🎣 *+${totalBaitsWon} Iscas de Pesca*\n`;
		if (totalBuffsWon.length > 0) {
			resultMessage += `• 🛠️ *Buffs de Pesca (${totalBuffsWon.length}):*\n`;
			for (const b of totalBuffsWon) {
				resultMessage += `  - ${b.emoji} *${b.originalName}:* _${b.description || "Aprimoramento de Pesca"}_\n`;
			}
		}
		if (totalJardimCoinsWon > 0 || totalJardimBagsWon > 0) {
			let jDesc = `• 🌾 *+${totalJardimCoinsWon.toLocaleString("pt-BR")} Moedas do Jardim*`;
			if (totalJardimBagsWon > 0) {
				jDesc += ` e *${totalJardimBagsWon} Sacola${totalJardimBagsWon > 1 ? "s" : ""} do Coveiro*`;
				if (allOpenedSeeds && Object.keys(allOpenedSeeds).length > 0) {
					const seedParts = Object.values(allOpenedSeeds).map((s) => `${s.count}x ${s.name}`);
					jDesc += `\n  _Drops das sacolas: ${seedParts.join(", ")}_`;
				}
			}
			resultMessage += `${jDesc}\n`;
		}
		if (totalZinthosWon > 0) {
			resultMessage += `• 💜 *+${totalZinthosWon.toLocaleString("pt-BR")} Zinthos*\n`;
		}
		if (totalTicketsWon > 0) {
			resultMessage += `• 🎫 *+${totalTicketsWon} Ticket${totalTicketsWon > 1 ? "s" : ""} de Waifus*\n`;
		}
		if (junkItemsWon.length > 0) {
			resultMessage += `• 🗑️ *Lixo de Colecionador:* ${junkItemsWon.join(", ")}\n`;
		}
	} else {
		const loseMsg =
			rollsCount > 1
				? MULTI_LOSE_MESSAGES[Math.floor(Math.random() * MULTI_LOSE_MESSAGES.length)]
				: LOSE_MESSAGES[Math.floor(Math.random() * LOSE_MESSAGES.length)];
		resultMessage += `${actionPrefix}❌ ${loseMsg}`;
	}

	resultMessage += `\n\n> 🪙 Moedinhas: ${userData.coins}/${MAX_COINS}`;

	const eventBanner = GameEventService.getEventBanner("slots");
	if (eventBanner) {
		resultMessage += eventBanner;
	}

	await saveUserData(userData);

	const mentionsList = [userId];
	if (targetJid && !mentionsList.includes(targetJid)) {
		mentionsList.push(targetJid);
	}

	return new ReturnMessage({
		chatId,
		content: resultMessage,
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin,
			mentions: mentionsList
		}
	});
}

/**
 * Exibe a tabela de probabilidades, prêmios e regras do caça-coisas
 */
async function slotsHelpCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const sub = Array.isArray(args) && args.length > 0 ? args[0].toLowerCase() : "";
	if (sub === "historico" || sub === "history" || sub === "meus") {
		return await slotsPrizesCommand(bot, message, args, group);
	}

	const helpMessage = `🎰 *TABELA DE PROBABILIDADES E PRÊMIOS — CAÇA-COISAS* 🎰

🎯 *Probabilidades por Giro:*
• 🏆 *Jackpot (3 símbolos iguais):* 1% (1 em 100 giros)
• 💎 *Jackpot Lendário (3x 💎):* 0,1% (1 em 1.000 giros) — *QUINTUPLICA O PRÊMIO!*
• 🥈 *Vitória Parcial (2 símbolos iguais):* 27% — *Ganha de 5% a 10% de cashback do prêmio numérico sorteado*
• ❌ *Derrota (3 diferentes):* 72%

🎁 *Tabela de Prêmios por Vitória:*
• 🗑️ *10%* — Lixo (1 item inútil de colecionador)
• 🪙 *20%* — 10 a 80 Moedinhas do Slots
• 🎣 *20%* — 5 a 25 Iscas de Pesca + 1 Buff Aleatório
• 🎣 *15%* — 15 a 50 Iscas de Pesca + 2 a 5 Buffs Aleatórios (com descrição de efeitos)
• 🌾 *20%* — 300 a 2.500 Moedas do Jardim + 1 a 5 Sacolas do Coveiro
• 💜 *15%* — 2.100 a 7.000 Zinthos + 3 Tickets de Waifus
• 💜 *10%* — 5.600 a 10.500 Zinthos + 5 Tickets de Waifus

⚙️ *Regras e Funcionamento:*
• 🪙 *Custo:* 1 moedinha por giro.
• ⏳ *Recarga passiva:* 1 moedinha a cada 2 minutos (acumula até 5 passivas).
• 🥈 *Vitória Parcial (2 símbolos):* Concede de 5% a 10% (aleatório) de moedas, iscas, moedas do jardim ou zinthos (arredondado para baixo, mín. 1). Se cair lixo, entrega 1. Itens, buffs e tickets não entram na vitória parcial.
• 📜 Para consultar seu histórico de prêmios pessoais: \`!slots-historico\` ou \`!slots-premios historico\``;

	return new ReturnMessage({
		chatId,
		content: helpMessage
	});
}

/**
 * Lista prêmios ganhos
 */
async function slotsPrizesCommand(bot, message, args, group) {
	const userId = message.author;
	const chatId = message.group ?? message.author;

	const prizes = await database.dbAll(
		dbName,
		"SELECT * FROM slots_prizes WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20",
		[userId]
	);

	if (!prizes || prizes.length === 0) {
		return new ReturnMessage({
			chatId,
			content: "🎰 Você ainda não ganhou nenhum prêmio no caça-coisas. Tente a sorte com !slots!"
		});
	}

	let msg = `🏆 *SEUS PRÊMIOS* 🏆\n\n`;
	prizes.forEach((p) => {
		const date = new Date(p.timestamp).toLocaleString("pt-BR");
		const emoji = p.prize_type === "bom" ? "🌟" : "🗑️";
		msg += `${emoji} *${p.prize_name}* - _${date}_\n`;
	});

	return new ReturnMessage({
		chatId,
		content: msg
	});
}

/**
 * Adiciona moedinhas a um usuário (usado por outros módulos)
 * @param {string} userId - ID ou telefone do usuário
 * @param {number} amount - Quantidade de moedas
 * @param {boolean} [isBonus=false] - Mantido para compatibilidade
 */
async function addCoins(userId, amount, isBonus = false) {
	userId = `${userId}`.replace(/\D/g, "");
	let userData = await getUserData(userId);
	userData = regenerateCoins(userData);
	userData.coins = Math.min((userData.coins || 0) + amount, MAX_STORED_COINS);
	await saveUserData(userData);
	return userData;
}

const EMOJIS_RANKING = ["", "🥇", "🥈", "🥉", "🐅", "🐆", "🦌", "🐐", "🐏", "🐓", "🐇"];

/**
 * Mostra ranking do caça-coisas no grupo
 */
async function slotsRankingCommand(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "🎰 O ranking do Caça-coisas só pode ser visualizado em grupos."
			});
		}

		const groupId = message.group;

		// Ranking de Vencedores (mais vitórias)
		const winnersRanking = await database.dbAll(
			dbName,
			`SELECT user_name, total_wins
             FROM slots_group_stats
             WHERE group_id = ? AND total_wins > 0
             ORDER BY total_wins DESC
             LIMIT 10`,
			[groupId]
		);

		// Ranking de Perdedores (mais jogadas sem vitória)
		const losersRanking = await database.dbAll(
			dbName,
			`SELECT user_name, (total_plays - total_wins) as losses
             FROM slots_group_stats
             WHERE group_id = ? AND losses > 0
             ORDER BY losses DESC
             LIMIT 10`,
			[groupId]
		);

		if (winnersRanking.length === 0 && losersRanking.length === 0) {
			return new ReturnMessage({
				chatId: groupId,
				content: "🎰 Ainda não há dados para o ranking neste grupo. Use *!slots* para participar!"
			});
		}

		let mensagem = `🎰 *Rankings Caça-coisas - ${group.name || "Grupo"}* 🏆\n\n`;

		if (winnersRanking.length > 0) {
			mensagem += "🍀 *Top Vencedores (Vitórias)*\n";
			winnersRanking.forEach((jogador, index) => {
				const emoji = index < EMOJIS_RANKING.length ? EMOJIS_RANKING[index + 1] : "";
				mensagem += `  ${emoji} ${index + 1}°: ${jogador.total_wins} - ${jogador.user_name || "Desconhecido"}\n`;
			});
			mensagem += "\n";
		}

		if (losersRanking.length > 0) {
			mensagem += "🤡 *Ranking de Jogadas sem Vitória (Perdedores)*\n";
			losersRanking.forEach((jogador, index) => {
				const medal =
					index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
				mensagem += `  ${medal} ${jogador.losses} perdas - ${jogador.user_name || "Desconhecido"}\n`;
			});
		}

		return new ReturnMessage({
			chatId: groupId,
			content: mensagem
		});
	} catch (error) {
		logger.error("Erro ao mostrar ranking do slots:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "❌ Erro ao buscar ranking do Caça-coisas."
		});
	}
}

const commands = [
	new Command({
		name: "slots",
		description: "Joga o caça-coisas",
		category: "jogos",
		reactions: { after: "🎰", error: "❌" },
		method: slotsCommand
	}),
	new Command({
		name: "slots-premios",
		description: "Mostra tabela de prêmios e probabilidades do caça-coisas",
		category: "jogos",
		cooldown: 5,
		reactions: { after: "🏆", error: "❌" },
		method: slotsHelpCommand
	}),
	new Command({
		name: "slots-historico",
		description: "Lista seus prêmios conquistados no caça-coisas",
		category: "jogos",
		cooldown: 10,
		reactions: { after: "📜", error: "❌" },
		method: slotsPrizesCommand
	}),
	new Command({
		name: "slots-ranking",
		description: "Mostra o ranking de vitórias do caça-coisas no grupo",
		category: "jogos",
		cooldown: 10,
		reactions: { after: "🏆", error: "❌" },
		method: slotsRankingCommand
	})
];

const helper = {
	about: "Jogo de caça-níqueis (Slots / Caça-Coisas) com moedas e prêmios colecionáveis",
	implementation:
		"Simula rolos de caça-níqueis com combinações premiadas, controle de moedas por usuário e inventário de prêmios",
	tags: "slots,caca niquel,cassino,jogos,premios,moedas,sorte",
	cmds: [
		{
			cmd: "!slots [quantidade]",
			desc: "Gira a máquina de caça-níqueis (opcional: quantidade de 1 a 30, ou 'tudo')",
			usage: ["!slots", "!slots 5", "!slots 30", "!slots tudo"],
			category: "jogos"
		},
		{
			cmd: "!slots-premios",
			desc: "Mostra a tabela de probabilidades, prêmios e regras do caça-coisas",
			usage: ["!slots-premios"],
			category: "jogos"
		},
		{
			cmd: "!slots-historico",
			desc: "Exibe a sua coleção de prêmios conquistados no caça-níqueis",
			usage: ["!slots-historico", "!slots-premios historico"],
			category: "jogos"
		},
		{
			cmd: "!slots-ranking",
			desc: "Exibe o ranking dos maiores vencedores do caça-níqueis",
			usage: ["!slots-ranking"],
			category: "jogos"
		}
	]
};

/**
 * Obtém os dados da semana do Slots para o resumo semanal
 * @param {number} sinceMs
 * @returns {Promise<Array<Object>>}
 */
async function getWeeklySlotsStats(sinceMs) {
	try {
		const rows = await database.dbAll(
			dbName,
			`SELECT user_id,
			        MAX(user_name) as user_name,
			        SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
			        COUNT(*) as plays,
			        SUM(coins_spent) as coins_spent
			 FROM slots_history
			 WHERE timestamp >= ?
			   AND user_id NOT LIKE 'user_%'
			   AND user_id NOT IN ('user1', 'user2')
			   AND group_id != '123@g.us'
			   AND group_id NOT LIKE 'test_%'
			 GROUP BY user_id
			 HAVING wins > 0
			 ORDER BY wins DESC, plays ASC
			 LIMIT 10`,
			[sinceMs]
		);
		const mostUnlucky = await database.dbGet(
			dbName,
			`SELECT user_id,
			        MAX(user_name) as user_name,
			        SUM(coins_spent) as coins_spent,
			        COUNT(*) as plays
			 FROM slots_history
			 WHERE timestamp >= ?
			   AND user_id NOT LIKE 'user_%'
			   AND user_id NOT IN ('user1', 'user2')
			   AND group_id != '123@g.us'
			   AND group_id NOT LIKE 'test_%'
			 GROUP BY user_id
			 HAVING SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) = 0
			 ORDER BY coins_spent DESC
			 LIMIT 1`,
			[sinceMs]
		);
		const result = (rows || [])
			.filter((r) => (Number(r.wins) || 0) > 0)
			.map((r) => ({
				user_id: r.user_id,
				user_name: r.user_name || "Jogador",
				wins: Number(r.wins) || 0,
				plays: Number(r.plays) || 0,
				coins_spent: Number(r.coins_spent) || 0
			}));
		if (mostUnlucky && (Number(mostUnlucky.coins_spent) || 0) > 0) {
			result.mostUnlucky = {
				user_name: mostUnlucky.user_name || "Jogador",
				coins_spent: Number(mostUnlucky.coins_spent) || 0,
				plays: Number(mostUnlucky.plays) || 0
			};
		}
		return result;
	} catch (error) {
		logger.error("Erro ao buscar estatísticas semanais de Slots:", error);
		return [];
	}
}

module.exports = {
	helper,
	commands,
	addCoins,
	getWeeklySlotsStats
};
