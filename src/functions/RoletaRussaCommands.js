const path = require("path");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("roleta-russa-commands");
const database = Database.getInstance();
const dbName = "roleta";

// Initialize database with schema
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS roleta_groups (
      group_id TEXT PRIMARY KEY,
      timeout_time INTEGER DEFAULT 300,
      last_player_id TEXT,
      last_updated INTEGER,
      total_tries INTEGER DEFAULT 0,
      total_deaths INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS roleta_players (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      current_tries INTEGER DEFAULT 0,
      max_tries INTEGER DEFAULT 0,
      deaths INTEGER DEFAULT 0,
      timeout_until INTEGER DEFAULT 0,
      total_tries INTEGER DEFAULT 0,
      last_played_at INTEGER,
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS roleta_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT,
      user_id TEXT,
      user_name TEXT,
      action TEXT,
      tries_at_action INTEGER,
      timestamp INTEGER
    );
`
);

/**
 * Emojis para ranking
 */
const EMOJIS_RANKING = ["", "🥇", "🥈", "🥉", "🐅", "🐆", "🦌", "🐐", "🐏", "🐓", "🐇"];

/**
 * Frases famosas para momentos de "morte"
 */
const FRASES_MORTE = [
	"Todos esses momentos se perderão no tempo, como lágrimas na chuva. Hora de morrer.",
	"O que fazemos na vida ecoa na eternidade.",
	"Valar Morghulis.",
	"Diga ao Sol que ele pode se pôr, pois eu encontrei o verdadeiro brilho.",
	"Até logo, Cowboy do Espaço.",
	"O mundo é apenas um palco, e a maioria de nós está desesperadamente sem ensaio.",
	"Não chore porque acabou, sorria porque aconteceu.",
	"A morte é apenas a próxima grande aventura.",
	"Você não está morrendo, está apenas sendo promovido a fantasma.",
	"Que a Força esteja com você em sua jornada final.",
	"Um homem só morre quando é esquecido.",
	"O meu tesouro? Se quiserem, podem pegá-lo. Procurem-no! Ele contém tudo o que este mundo tem a oferecer!",
	"Eu sou o Homem de Ferro.",
	"Você morreu.",
	"Sayonara, baby.",
	"A vida é uma jornada, mas a morte é o destino final.",
	"Vivi uma vida sem arrependimentos.",
	"Não tema a morte, tema a vida não vivida.",
	"O inverno chegou para você.",
	"Isso é tudo, pessoal!",
	"A morte é o fim de uma canção, mas a melodia continua.",
	"O medo da morte é pior que a própria morte.",
	"O amanhã não é garantido para ninguém.",
	"Sua jornada termina aqui, mas sua lenda apenas começou.",
	"O brilho que queima duas vezes mais forte, queima pela metade do tempo."
];

/**
 * Obtém ou cria dados do grupo
 */
async function getGroupData(groupId) {
	let group = await database.dbGet(dbName, "SELECT * FROM roleta_groups WHERE group_id = ?", [
		groupId
	]);

	if (!group) {
		const now = Date.now();
		await database.dbRun(
			dbName,
			`
      INSERT INTO roleta_groups (group_id, timeout_time, last_updated, total_tries, total_deaths)
      VALUES (?, ?, ?, 0, 0)
    `,
			[groupId, 300, now]
		);
		group = {
			group_id: groupId,
			timeout_time: 300,
			last_player_id: null,
			last_updated: now,
			total_tries: 0,
			total_deaths: 0
		};
	}

	return group;
}

/**
 * Obtém ou cria dados do jogador
 */
async function getPlayerData(groupId, userId, userName = null) {
	let player = await database.dbGet(
		dbName,
		"SELECT * FROM roleta_players WHERE group_id = ? AND user_id = ?",
		[groupId, userId]
	);

	if (!player) {
		await database.dbRun(
			dbName,
			`
      INSERT INTO roleta_players (group_id, user_id, user_name, current_tries, max_tries, deaths, timeout_until, total_tries, last_played_at)
      VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0)
    `,
			[groupId, userId, userName]
		);

		player = {
			group_id: groupId,
			user_id: userId,
			user_name: userName,
			current_tries: 0,
			max_tries: 0,
			deaths: 0,
			timeout_until: 0,
			total_tries: 0,
			last_played_at: 0
		};
	} else if (userName && player.user_name !== userName) {
		// Update name if changed
		await database.dbRun(
			dbName,
			"UPDATE roleta_players SET user_name = ? WHERE group_id = ? AND user_id = ?",
			[userName, groupId, userId]
		);
		player.user_name = userName;
	}

	return player;
}

/**
 * Joga roleta russa
 */
async function jogarRoletaRussa(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "A roleta russa só pode ser jogada em grupos."
			});
		}

		const groupId = message.group;
		const userId = message.author;

		let userName = message.authorName ?? "";
		if (userName.length == 0) {
			try {
				const contact = await message.origin.getContact();
				userName = contact.pushname || contact.name || "Jogador";
			} catch (error) {
				logger.error("Erro ao obter contato:", error);
			}
		}

		const groupData = await getGroupData(groupId);
		const playerData = await getPlayerData(groupId, userId, userName);

		// Check timeout (Using MS for consistency)
		const now = Date.now();

		if (playerData.timeout_until > now) {
			const remainingMs = playerData.timeout_until - now;
			const totalSeconds = Math.ceil(remainingMs / 1000);
			const minutes = Math.floor(totalSeconds / 60);
			const seconds = totalSeconds % 60;

			try {
				await message.origin.react("💀");
			} catch (reactError) {}

			return new ReturnMessage({
				chatId: groupId,
				content: `💀 ${userName} já está morto na roleta russa. Ressuscita em ${minutes}m${seconds}s.`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Check consecutive plays
		if (groupData.last_player_id === userId) {
			return new ReturnMessage({
				chatId: groupId,
				content: `🔄 ${userName}, espere outra pessoa jogar antes de tentar novamente.`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Update last player for group and increment group total tries
		await database.dbRun(
			dbName,
			`
      UPDATE roleta_groups 
      SET last_player_id = ?, 
          last_updated = ?, 
          total_tries = total_tries + 1 
      WHERE group_id = ?
    `,
			[userId, now, groupId]
		);

		// Increment tries
		const currentTries = (playerData.current_tries || 0) + 1;
		const totalTries = (playerData.total_tries || 0) + 1;

		// Roll the dice (1 in 6)
		const died = Math.floor(Math.random() * 6) === 0;

		if (died) {
			// Died
			const deaths = (playerData.deaths || 0) + 1;
			let maxTries = playerData.max_tries || 0;
			const oldMax = maxTries;
			const newRecord = currentTries > maxTries;

			if (newRecord) {
				maxTries = currentTries;
			}

			const timeoutMs = (groupData.timeout_time || 300) * 1000;
			const timeoutUntil = now + timeoutMs;
			const triesBeforeDeath = currentTries;

			// Update Player DB
			await database.dbRun(
				dbName,
				`
        UPDATE roleta_players 
        SET current_tries = 0, 
            max_tries = ?, 
            deaths = ?, 
            timeout_until = ?, 
            total_tries = ?, 
            last_played_at = ?
        WHERE group_id = ? AND user_id = ?
      `,
				[maxTries, deaths, timeoutUntil, totalTries, now, groupId, userId]
			);

			// Update Group DB
			await database.dbRun(
				dbName,
				`
        UPDATE roleta_groups 
        SET total_deaths = total_deaths + 1 
        WHERE group_id = ?
      `,
				[groupId]
			);

			// Add to history
			await database.dbRun(
				dbName,
				`
        INSERT INTO roleta_history (group_id, user_id, user_name, action, tries_at_action, timestamp)
        VALUES (?, ?, ?, 'death', ?, ?)
      `,
				[groupId, userId, userName, triesBeforeDeath, now]
			);

			let info;
			if (newRecord) {
				// More descriptive record message
				info = `Morreu em ${triesBeforeDeath}, um novo record! Seu máximo antes disso era ${oldMax}.\nNeste grupo, você já morreu ${deaths} vezes.`;
			} else {
				info = `Morreu em ${triesBeforeDeath}.\nNeste grupo, você já morreu ${deaths} vezes.`;
			}

			try {
				await message.origin.react("💀");
			} catch (reactError) {}

			const fraseAleatoria = FRASES_MORTE[Math.floor(Math.random() * FRASES_MORTE.length)];

			return new ReturnMessage({
				chatId: groupId,
				content: `💥🔫 *BANG* - *F no chat* ${info}\n\n> _${fraseAleatoria}_`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		} else {
			// Survived
			// Update DB
			await database.dbRun(
				dbName,
				`
        UPDATE roleta_players 
        SET current_tries = ?, 
            total_tries = ?, 
            last_played_at = ?
        WHERE group_id = ? AND user_id = ?
      `,
				[currentTries, totalTries, now, groupId, userId]
			);

			await database.dbRun(
				dbName,
				`
        INSERT INTO roleta_history (group_id, user_id, user_name, action, tries_at_action, timestamp)
        VALUES (?, ?, ?, 'safe', ?, ?)
      `,
				[groupId, userId, userName, currentTries, now]
			);

			return new ReturnMessage({
				chatId: groupId,
				content: `💨🔫 *click* - Tá *safe*! \`\`\`${currentTries}\`\`\``,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}
	} catch (error) {
		logger.error("Erro ao jogar roleta russa:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao jogar roleta russa. Por favor, tente novamente."
		});
	}
}

/**
 * Mostra ranking da roleta russa
 */
async function mostrarRanking(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "O ranking da roleta russa só pode ser visualizado em grupos."
			});
		}

		const groupId = message.group;

		// Get top players by luck (max of max_tries or current_tries)
		const rankingSorte = await database.dbAll(
			dbName,
			`
      SELECT user_name, max_tries, current_tries,
             CASE WHEN max_tries > current_tries THEN max_tries ELSE current_tries END as luck
      FROM roleta_players 
      WHERE group_id = ? AND (max_tries > 0 OR current_tries > 0)
      ORDER BY luck DESC
      LIMIT 10
    `,
			[groupId]
		);

		// Get top players by deaths
		const rankingMortes = await database.dbAll(
			dbName,
			`
      SELECT user_name, deaths 
      FROM roleta_players 
      WHERE group_id = ? AND deaths > 0
      ORDER BY deaths DESC
      LIMIT 10
    `,
			[groupId]
		);

		if (rankingSorte.length === 0 && rankingMortes.length === 0) {
			return new ReturnMessage({
				chatId: groupId,
				content: "🏆 Ainda não há jogadores na roleta russa deste grupo."
			});
		}

		let mensagem = "🏆 *Rankings Roleta Russa* 🔫\n\n";

		mensagem += "🍀 *Sorte - Máx. Tentativas sem morrer*\n";
		if (rankingSorte.length > 0) {
			rankingSorte.forEach((jogador, index) => {
				const emoji = index < EMOJIS_RANKING.length ? EMOJIS_RANKING[index + 1] : "";
				const jogandoAtualmente =
					(jogador.current_tries || 0) > 0 ? ` *(${jogador.current_tries} atual)*` : "";
				mensagem += `\t${emoji} ${index + 1}°: ${jogador.luck}${jogandoAtualmente} - ${jogador.user_name || "Desconhecido"}\n`;
			});
		} else {
			mensagem += "\tAinda não há jogadores neste ranking\n";
		}

		mensagem += "\n🪦 *Número de Mortes*\n";
		if (rankingMortes.length > 0) {
			rankingMortes.forEach((jogador, index) => {
				const emoji = index < EMOJIS_RANKING.length ? EMOJIS_RANKING[index + 1] : "";
				mensagem += `\t${emoji} ${index + 1}°: ${jogador.deaths} - ${jogador.user_name || "Desconhecido"}\n`;
			});
		} else {
			mensagem += "\tAinda não há jogadores neste ranking\n";
		}

		return new ReturnMessage({
			chatId: groupId,
			content: mensagem
		});
	} catch (error) {
		logger.error("Erro ao mostrar ranking:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao mostrar ranking da roleta russa. Por favor, tente novamente."
		});
	}
}

/**
 * Reseta os dados da roleta russa para um grupo
 */
async function resetarRoletaRussa(bot, message, args, group) {
	try {
		if (!message.group) {
			return [
				new ReturnMessage({
					chatId: message.author,
					content: "O reset da roleta russa só pode ser executado em grupos."
				})
			];
		}

		const groupId = message.group;
		const userId = message.author;

		const isAdmin = await bot.isUserAdminInGroup(userId, groupId);
		if (!isAdmin) {
			return [
				new ReturnMessage({
					chatId: groupId,
					content: "⛔ Apenas administradores podem resetar os dados da roleta russa.",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				})
			];
		}

		// Count players to show in message
		const countResult = await database.dbGet(
			dbName,
			"SELECT COUNT(*) as c FROM roleta_players WHERE group_id = ?",
			[groupId]
		);
		const numJogadores = countResult ? countResult.c : 0;

		if (numJogadores === 0) {
			return [
				new ReturnMessage({
					chatId: groupId,
					content: "⚠️ Não há dados da roleta russa para este grupo.",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				})
			];
		}

		// Get ranking before reset
		const rankingMessage = await mostrarRanking(bot, message, args, group);

		// Reset players (Delete them)
		await database.dbRun(dbName, "DELETE FROM roleta_players WHERE group_id = ?", [groupId]);

		// Reset group stats but keep timeout config
		await database.dbRun(
			dbName,
			`
      UPDATE roleta_groups 
      SET last_player_id = NULL, 
          total_tries = 0, 
          total_deaths = 0 
      WHERE group_id = ?
    `,
			[groupId]
		);

		return [
			rankingMessage,
			new ReturnMessage({
				chatId: groupId,
				content: `🔄 *Dados da Roleta Russa Resetados*\n\nForam removidos dados de ${numJogadores} jogadores deste grupo.\n\nO ranking acima mostra como estava antes do reset.`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			})
		];
	} catch (error) {
		logger.error("Erro ao resetar dados da roleta russa:", error);
		return [
			new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "Erro ao resetar dados da roleta russa. Por favor, tente novamente."
			})
		];
	}
}

/**
 * Define tempo de timeout da roleta russa
 */
async function definirTempoRoleta(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		const groupId = message.group;

		const isAdmin = await bot.isUserAdminInGroup(message.author, groupId);
		if (!isAdmin) {
			return new ReturnMessage({
				chatId: groupId,
				content: "⛔ Apenas administradores podem definir o tempo da roleta russa.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		if (args.length === 0 || isNaN(parseInt(args[0]))) {
			return new ReturnMessage({
				chatId: groupId,
				content:
					"Por favor, forneça um tempo em segundos (mínimo 10, máximo 259200, 72 horas). Exemplo: !roleta-tempo 300"
			});
		}

		let segundos = parseInt(args[0]);
		if (segundos > 259200 * 3) {
			segundos = 259200;
		} else if (segundos < 10) {
			segundos = 10;
		}

		await getGroupData(groupId); // Ensure group exists
		await database.dbRun(dbName, "UPDATE roleta_groups SET timeout_time = ? WHERE group_id = ?", [
			segundos,
			groupId
		]);

		const minutos = Math.floor(segundos / 60);
		const segundosRestantes = segundos % 60;
		let tempoFormatado = "";

		if (minutos > 0) {
			tempoFormatado += `${minutos} minuto(s)`;
			if (segundosRestantes > 0) {
				tempoFormatado += ` e ${segundosRestantes} segundo(s)`;
			}
		} else {
			tempoFormatado = `${segundos} segundo(s)`;
		}

		return new ReturnMessage({
			chatId: groupId,
			content: `🕐 Tempo de "morte" na roleta russa definido para ${tempoFormatado}.`
		});
	} catch (error) {
		logger.error("Erro ao definir tempo de roleta:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao definir tempo da roleta russa. Por favor, tente novamente."
		});
	}
}

// Commands list
const commands = [
	new Command({
		name: "roletarussa",
		description: "Joga roleta russa, risco de ser silenciado",
		category: "jogos",
		cooldown: 0,
		reactions: {
			after: "🔫",
			error: "❌"
		},
		method: jogarRoletaRussa
	}),

	new Command({
		name: "roleta-ranking",
		description: "Mostra ranking da roleta russa",
		category: "jogos",
		cooldown: 10,
		reactions: {
			after: "🏆",
			error: "❌"
		},
		method: mostrarRanking
	}),
	new Command({
		name: "roletaranking",
		description: "Mostra ranking da roleta russa",
		category: "jogos",
		hidden: true,
		cooldown: 10,
		reactions: {
			after: "🏆",
			error: "❌"
		},
		method: mostrarRanking
	}),

	new Command({
		name: "roleta-reset",
		description: "Reseta os dados da roleta russa para este grupo",
		category: "jogos",
		adminOnly: true,
		cooldown: 60,
		reactions: {
			after: "🔄",
			error: "❌"
		},
		method: resetarRoletaRussa
	}),
	new Command({
		name: "roleta-tempo",
		description: "Define o tempo de timeout da roleta russa",
		category: "jogos",
		adminOnly: true,
		cooldown: 10,
		reactions: {
			after: "🕐",
			error: "❌"
		},
		method: definirTempoRoleta
	})
];

module.exports = { commands };
