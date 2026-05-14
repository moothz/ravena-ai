// src/functions/SlotsGame.js
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const FishingGame = require("./FishingGame");

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
`
);

const MAX_COINS = 5;
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
	"Os deuses do azar tiraram folga hoje! 🏆"
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

/**
 * Obtém dados do usuário
 */
async function getUserData(userId, userName = null) {
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
async function recordGroupStats(groupId, userId, userName, isWin) {
	await database.dbRun(
		dbName,
		`INSERT INTO slots_group_stats (group_id, user_id, user_name, total_plays, total_wins)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(group_id, user_id) DO UPDATE SET 
            total_plays = total_plays + 1, 
            total_wins = total_wins + ?, 
            user_name = excluded.user_name`,
		[groupId, userId, userName, isWin ? 1 : 0, isWin ? 1 : 0]
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

	let userData = await getUserData(userId, userName);

	// Regenera moedas
	userData = regenerateCoins(userData);

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

	// Consome uma moeda
	userData.coins -= 1;
	userData.total_plays += 1;

	// Rola os números
	const roll1 = Math.floor(Math.random() * SLOT_EMOJIS.length);
	const roll2 = Math.floor(Math.random() * SLOT_EMOJIS.length);
	const roll3 = Math.floor(Math.random() * SLOT_EMOJIS.length);

	const emoji1 = SLOT_EMOJIS[roll1];
	const emoji2 = SLOT_EMOJIS[roll2];
	const emoji3 = SLOT_EMOJIS[roll3];

	const isWin = roll1 === roll2 && roll2 === roll3;

	if (message.group) {
		await recordGroupStats(message.group, userId, userName, isWin);
	}

	let resultMessage = `🎰 *CAÇA-COISAS* 🎰\n`;
	resultMessage += `\`\`\`----------------------\n`;
	resultMessage += `|  [ ${emoji1} ] [ ${emoji2} ] [ ${emoji3} ]  |\n`;
	resultMessage += `----------------------\`\`\`\n\n`;

	if (isWin) {
		userData.total_wins += 1;

		const winMsg = WIN_MESSAGES[Math.floor(Math.random() * WIN_MESSAGES.length)];
		resultMessage += `🎊 *${winMsg}* 🎊\n\n`;

		// Determina o prêmio (30% lixo, 70% bom)
		const prizeRand = Math.random();
		if (prizeRand < 0.3) {
			// Prêmio Normal (Lixo)
			const prize = JUNK_PRIZES[Math.floor(Math.random() * JUNK_PRIZES.length)];
			resultMessage += `🎁 Você ganhou: *${prize}*!\n`;
			resultMessage += `_Incrível como você tem sorte pra ganhar porcaria._ 🙄`;
			await savePrize(userId, prize, "normal");
		} else {
			// Prêmio Bom (Pesca ou Moedas)
			const goodRand = Math.random();
			if (goodRand < 0.4) {
				// Moedinhas (1-5) - NOVO
				const coinsWon = Math.floor(Math.random() * 5) + 1;
				userData.coins = Math.min(userData.coins + coinsWon, MAX_COINS);
				resultMessage += `🎁 VOCÊ GANHOU: *${coinsWon} Moedinhas*! 🪙\n`;
				resultMessage += `_Mais chances de girar a sorte!_`;
				await savePrize(userId, `${coinsWon} Moedinhas`, "bom");
			} else if (goodRand < 0.8) {
				// Iscas (1-10)
				const baits = Math.floor(Math.random() * 10) + 1;
				resultMessage += `🎁 VOCÊ GANHOU: *${baits} Iscas de Pesca*! 🎣\n`;
				resultMessage += `_Vão direto pro seu balde de pesca._`;
				await FishingGame.addBaits(userId, baits);
				await savePrize(userId, `${baits} Iscas`, "bom");
			} else {
				// Upgrade
				const upgrade =
					FishingGame.UPGRADES[Math.floor(Math.random() * FishingGame.UPGRADES.length)];
				resultMessage += `🎁 VOCÊ GANHOU: *${upgrade.emoji} ${upgrade.name}*! 🛠️\n`;
				resultMessage += `_Um item de elite para sua pescaria!_`;

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
			}
		}
	} else {
		const loseMsg = LOSE_MESSAGES[Math.floor(Math.random() * LOSE_MESSAGES.length)];
		resultMessage += `❌ ${loseMsg}`;
	}

	resultMessage += `\n\n> 🪙 Moedinhas: ${userData.coins}/${MAX_COINS}`;

	await saveUserData(userData);

	return new ReturnMessage({
		chatId,
		content: resultMessage,
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
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
 */
async function addCoins(userId, amount) {
	let userData = await getUserData(userId);
	userData = regenerateCoins(userData);
	userData.coins = Math.min(userData.coins + amount, MAX_COINS);
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

module.exports = { commands, addCoins };
