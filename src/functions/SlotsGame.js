// src/functions/SlotsGame.js
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const FishingGame = require("./FishingGame");
const GameEventService = require("../services/GameEventService");

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

		if (isWin) {
			totalWins++;
		}

		rollResults.push({
			emoji1: SLOT_EMOJIS[roll1],
			emoji2: SLOT_EMOJIS[roll2],
			emoji3: SLOT_EMOJIS[roll3],
			isWin
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
		const mark = roll.isWin ? "✅" : "❌";
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

	if (totalWins > 0) {
		userData.total_wins += totalWins;

		const winMsg = WIN_MESSAGES[Math.floor(Math.random() * WIN_MESSAGES.length)];
		resultMessage += `${actionPrefix}🎊 *${winMsg}* 🎊\n\n`;

		const prizesWon = [];
		for (let w = 0; w < totalWins; w++) {
			// Determina o prêmio (30% lixo, 70% bom)
			const prizeRand = Math.random();
			if (prizeRand < 0.3) {
				// Prêmio Normal (Lixo)
				const prize = JUNK_PRIZES[Math.floor(Math.random() * JUNK_PRIZES.length)];
				await savePrize(userId, prize, "normal");
				prizesWon.push({
					type: "junk",
					title: prize,
					detail: "Incrível como você tem sorte pra ganhar porcaria. 🙄"
				});
			} else {
				// Prêmio Bom (Pesca ou Moedas)
				const goodRand = Math.random();
				if (goodRand < 0.4) {
					// Moedinhas (1-5)
					let coinsWon = Math.floor(Math.random() * 5) + 1;
					const coinMult = GameEventService.getMultiplier("slots", "moedas");
					if (coinMult > 1) {
						coinsWon = Math.max(1, Math.round(coinsWon * coinMult));
					}
					userData.coins = Math.min((userData.coins || 0) + coinsWon, MAX_STORED_COINS);
					await savePrize(userId, `${coinsWon} Moedinhas`, "bom");
					prizesWon.push({
						type: "coins",
						title: `${coinsWon} Moedinhas`,
						detail: "Mais chances de girar a sorte!"
					});
				} else if (goodRand < 0.8) {
					// Iscas (1-10)
					let baits = Math.floor(Math.random() * 10) + 1;
					const baitMult = GameEventService.getMultiplier("slots", "iscas");
					if (baitMult > 1) {
						baits = Math.max(1, Math.round(baits * baitMult));
					}
					await FishingGame.addBaits(userId, baits);
					await savePrize(userId, `${baits} Iscas`, "bom");
					prizesWon.push({
						type: "baits",
						title: `${baits} Iscas de Pesca`,
						detail: "Vão direto pro seu balde de pesca."
					});
				} else {
					// Upgrade de Pesca (ignora Ficha de Cassino pois já é prêmio de moedas)
					const fishingUpgrades = FishingGame.UPGRADES.filter((u) => u.effect !== "slots_coins");
					const upgrade = fishingUpgrades[Math.floor(Math.random() * fishingUpgrades.length)];

					const buff = {
						type: upgrade.effect,
						value: upgrade.value || 0,
						minValue: upgrade.minValue || 0,
						maxValue: upgrade.maxValue || 0,
						remainingUses: upgrade.duration || 1,
						originalName: upgrade.name
					};

					if (upgrade.effect === "extra_baits" || upgrade.effect === "next_fish_bonus") {
						buff.value =
							Math.floor(Math.random() * (upgrade.maxValue - upgrade.minValue + 1)) +
							upgrade.minValue;
					}

					await FishingGame.addBuff(userId, buff, false);
					await savePrize(userId, upgrade.name, "bom");
					prizesWon.push({
						type: "upgrade",
						title: `${upgrade.emoji} ${upgrade.name}`,
						detail: "Um item de elite para sua pescaria!"
					});
				}
			}
		}

		if (totalWins === 1) {
			const singlePrize = prizesWon[0];
			if (singlePrize.type === "junk") {
				resultMessage += `🎁 Você ganhou: *${singlePrize.title}*!\n`;
				resultMessage += `_${singlePrize.detail}_`;
			} else if (singlePrize.type === "coins") {
				resultMessage += `🎁 VOCÊ GANHOU: *${singlePrize.title}*! 🪙\n`;
				resultMessage += `_${singlePrize.detail}_`;
			} else if (singlePrize.type === "baits") {
				resultMessage += `🎁 VOCÊ GANHOU: *${singlePrize.title}*! 🎣\n`;
				resultMessage += `_${singlePrize.detail}_`;
			} else {
				resultMessage += `🎁 VOCÊ GANHOU: *${singlePrize.title}*! 🛠️\n`;
				resultMessage += `_${singlePrize.detail}_`;
			}
		} else {
			resultMessage += `🎁 *Prêmios Conquistados (${totalWins} vitórias):*\n`;
			for (const p of prizesWon) {
				const icon =
					p.type === "junk" ? "🗑️" : p.type === "coins" ? "🪙" : p.type === "baits" ? "🎣" : "🛠️";
				resultMessage += `• ${icon} *${p.title}*\n`;
			}
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
		description: "Lista seus prêmios do caça-coisas",
		category: "jogos",
		cooldown: 10,
		reactions: { after: "🏆", error: "❌" },
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
			desc: "Exibe a sua coleção de prêmios conquistados no caça-níqueis",
			usage: ["!slots-premios"],
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
