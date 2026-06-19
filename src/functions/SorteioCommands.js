// src/functions/SorteioCommands.js

const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("sorteio-commands");
const database = Database.getInstance();
const DB_NAME = "sorteios";

// Initialize Database schema
database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS sorteios (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    TEXT NOT NULL,
    title       TEXT NOT NULL,
    message_id  TEXT,
    status      TEXT DEFAULT 'active',
    created_at  INTEGER,
    winner_id   TEXT,
    winner_name TEXT,
    creator_id  TEXT
  );
  CREATE TABLE IF NOT EXISTS sorteio_participants (
    sorteio_id  INTEGER NOT NULL,
    user_id     TEXT NOT NULL,
    user_name   TEXT NOT NULL,
    joined_at   INTEGER,
    PRIMARY KEY (sorteio_id, user_id),
    FOREIGN KEY (sorteio_id) REFERENCES sorteios(id) ON DELETE CASCADE
  );
`
);

// Try adding creator_id column in case table already exists
database.dbRun(DB_NAME, "ALTER TABLE sorteios ADD COLUMN creator_id TEXT").catch(() => {});

/**
 * Gets clean user name with possible nickname
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} group - Group data
 * @param {string} userId - User ID JID
 * @param {string|null} fallbackName - Fallback name
 * @returns {Promise<string>} User's name or nickname
 */
async function getUserDisplayName(bot, group, userId, fallbackName) {
	try {
		if (group?.nicks && Array.isArray(group.nicks)) {
			const nick = group.nicks.find((n) => n.numero === userId);
			if (nick?.apelido) return nick.apelido;
		}
		if (fallbackName && fallbackName !== "Usuário") return fallbackName;
		const contact = await bot.client.getContactById(userId);
		return contact.pushname || contact.name || `Usuário_${userId.split("@")[0]}`;
	} catch (e) {
		return fallbackName || `Usuário_${userId.split("@")[0]}`;
	}
}

/**
 * Creates or shows the active raffle in a group
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|null>}
 */
async function handleSorteio(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Check if there is an active raffle
		const raffle = await database.dbGet(
			DB_NAME,
			"SELECT * FROM sorteios WHERE group_id = ? AND status = 'active'",
			[message.group]
		);

		if (raffle) {
			// Show current participants and draw instructions
			const participants = await database.dbAll(
				DB_NAME,
				"SELECT * FROM sorteio_participants WHERE sorteio_id = ? ORDER BY joined_at ASC",
				[raffle.id]
			);

			let content = `🎁 *Sorteio Ativo:* ${raffle.title}\n\n`;
			if (participants.length > 0) {
				content += `*Participantes (${participants.length}):*\n`;
				participants.forEach((p, idx) => {
					content += `${idx + 1}. ${p.user_name} (@${p.user_id.split("@")[0]})\n`;
				});
			} else {
				content += "_Nenhum participante inscrito ainda._\n";
			}
			content += `\nPara entrar, digite *!sorteio-entrar* ou reaja com 🎲 na mensagem do sorteio.\n`;
			content += `Para sair, digite *!sorteio-sair*.\n`;
			content += `Para realizar o sorteio, use *!sortear*.`;

			const mentions = participants.map((p) => p.user_id);
			return new ReturnMessage({
				chatId: message.group,
				content,
				options: { mentions }
			});
		} else {
			// Create a new raffle
			const title = args.length > 0 ? args.join(" ") : "Sorteio";

			const initialText =
				`🎁 *NOVO SORTEIO CRIADO!* 🎁\n\n` +
				`Sorteio: *${title}*\n\n` +
				`• Para participar: Digite *!sorteio-entrar* ou reaja a esta mensagem com o emoji 🎲\n` +
				`• Para sair: Digite *!sorteio-sair*\n\n` +
				`Participe e boa sorte! 📦`;

			// Send announcement message and get its ID
			const sentMsgs = await bot.sendReturnMessages(
				new ReturnMessage({
					chatId: message.group,
					content: initialText
				}),
				group
			);

			const messageId = sentMsgs?.[0]?.id?._serialized || null;

			// Save to database
			await database.dbRun(
				DB_NAME,
				"INSERT INTO sorteios (group_id, title, message_id, status, created_at, creator_id) VALUES (?, ?, ?, 'active', ?, ?)",
				[message.group, title, messageId, Date.now(), message.author]
			);

			return null;
		}
	} catch (error) {
		logger.error("Erro no comando !sorteio:", error);
		return new ReturnMessage({
			chatId: message.group || message.author,
			content: "Ocorreu um erro ao processar o sorteio."
		});
	}
}

/**
 * Enters the active raffle
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage>}
 */
async function handleSorteioEntrar(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		const raffle = await database.dbGet(
			DB_NAME,
			"SELECT * FROM sorteios WHERE group_id = ? AND status = 'active'",
			[message.group]
		);

		if (!raffle) {
			return new ReturnMessage({
				chatId: message.group,
				content:
					"Não há nenhum sorteio ativo neste grupo no momento. Crie um com *!sorteio [nome]*."
			});
		}

		const userId = message.author;
		const userPushName = message.name ?? message.pushName ?? message.pushname ?? "Usuário";
		const userName = await getUserDisplayName(bot, group, userId, userPushName);

		const participant = await database.dbGet(
			DB_NAME,
			"SELECT * FROM sorteio_participants WHERE sorteio_id = ? AND user_id = ?",
			[raffle.id, userId]
		);

		if (participant) {
			return new ReturnMessage({
				chatId: message.group,
				content: `${userName}, você já está participando do sorteio "${raffle.title}"!`
			});
		}

		await database.dbRun(
			DB_NAME,
			"INSERT INTO sorteio_participants (sorteio_id, user_id, user_name, joined_at) VALUES (?, ?, ?, ?)",
			[raffle.id, userId, userName, Date.now()]
		);

		return new ReturnMessage({
			chatId: message.group,
			content: `✅ *${userName}* entrou no sorteio "${raffle.title}"!`
		});
	} catch (error) {
		logger.error("Erro no comando !sorteio-entrar:", error);
		return new ReturnMessage({
			chatId: message.group,
			content: "Erro ao tentar entrar no sorteio."
		});
	}
}

/**
 * Leaves the active raffle
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage>}
 */
async function handleSorteioSair(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		const raffle = await database.dbGet(
			DB_NAME,
			"SELECT * FROM sorteios WHERE group_id = ? AND status = 'active'",
			[message.group]
		);

		if (!raffle) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Não há nenhum sorteio ativo neste grupo no momento."
			});
		}

		const userId = message.author;
		const userPushName = message.name ?? message.pushName ?? message.pushname ?? "Usuário";
		const userName = await getUserDisplayName(bot, group, userId, userPushName);

		const participant = await database.dbGet(
			DB_NAME,
			"SELECT * FROM sorteio_participants WHERE sorteio_id = ? AND user_id = ?",
			[raffle.id, userId]
		);

		if (!participant) {
			return new ReturnMessage({
				chatId: message.group,
				content: `${userName}, você não está participando do sorteio "${raffle.title}".`
			});
		}

		await database.dbRun(
			DB_NAME,
			"DELETE FROM sorteio_participants WHERE sorteio_id = ? AND user_id = ?",
			[raffle.id, userId]
		);

		return new ReturnMessage({
			chatId: message.group,
			content: `❌ *${userName}* saiu do sorteio "${raffle.title}".`
		});
	} catch (error) {
		logger.error("Erro no comando !sorteio-sair:", error);
		return new ReturnMessage({
			chatId: message.group,
			content: "Erro ao tentar sair do sorteio."
		});
	}
}

/**
 * Draws a winner from the active raffle or performs an instant raffle of all group members
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage>}
 */
async function handleSortear(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		const raffle = await database.dbGet(
			DB_NAME,
			"SELECT * FROM sorteios WHERE group_id = ? AND status = 'active'",
			[message.group]
		);

		// Check permissions: creator of the active raffle OR admin
		const requesterId = message.author;
		let isAllowed = false;

		if (raffle && raffle.creator_id === requesterId) {
			isAllowed = true;
		}

		if (!isAllowed) {
			const AdminUtils = require("../utils/AdminUtils");
			const adminUtils = AdminUtils.getInstance();
			const chat = await message.origin.getChat();
			const isUserAdmin = await adminUtils.isAdmin(requesterId, group, chat, bot);
			isAllowed = isUserAdmin;
		}

		if (!isAllowed) {
			return new ReturnMessage({
				chatId: message.group,
				content:
					"⚠️ Apenas administradores do grupo ou o criador deste sorteio podem usar o comando *!sortear*."
			});
		}

		if (raffle) {
			// Draw from active raffle participants
			const participants = await database.dbAll(
				DB_NAME,
				"SELECT * FROM sorteio_participants WHERE sorteio_id = ?",
				[raffle.id]
			);

			if (participants.length === 0) {
				return new ReturnMessage({
					chatId: message.group,
					content: `⚠️ Não há nenhum participante no sorteio "${raffle.title}". Ninguém pôde ser sorteado.`
				});
			}

			const randomIndex = Math.floor(Math.random() * participants.length);
			const winner = participants[randomIndex];

			// Mark raffle as finished with winner details
			await database.dbRun(
				DB_NAME,
				"UPDATE sorteios SET status = 'finished', winner_id = ?, winner_name = ? WHERE id = ?",
				[winner.user_id, winner.user_name, raffle.id]
			);

			// Clean up participants table for this raffle
			await database.dbRun(DB_NAME, "DELETE FROM sorteio_participants WHERE sorteio_id = ?", [
				raffle.id
			]);

			const winnerNumber = winner.user_id.split("@")[0];
			const text =
				`🎉 *SORTEIO REALIZADO!* 🎉\n\n` +
				`Sorteio: *${raffle.title}*\n` +
				`Ganhador(a): @${winnerNumber} (*${winner.user_name}*)! 🎁\n\n` +
				`Parabéns! 📦`;

			return new ReturnMessage({
				chatId: message.group,
				content: text,
				options: {
					mentions: [winner.user_id]
				}
			});
		} else {
			// Draw instant winner from active group members
			const title = args.length > 0 ? args.join(" ") : "Sorteio Rápido";

			const chat = await message.origin.getChat();
			if (!chat || !chat.isGroup) {
				return new ReturnMessage({
					chatId: message.group,
					content: "Erro ao acessar os membros do grupo."
				});
			}

			const ignoredUsers = group.ignoredUsers || [];
			const participants =
				chat.participants?.filter((p) => {
					const id = p.id?._serialized;
					return id && !ignoredUsers.some((ignored) => id.startsWith(ignored));
				}) ?? [];

			if (participants.length === 0) {
				return new ReturnMessage({
					chatId: message.group,
					content: "Nenhum membro elegível encontrado no grupo para realizar o sorteio."
				});
			}

			const randomIndex = Math.floor(Math.random() * participants.length);
			const winner = participants[randomIndex];
			const winnerId = winner.id._serialized;
			const winnerNumber = winnerId.split("@")[0];

			const winnerName = await getUserDisplayName(bot, group, winnerId, null);

			// Save the instant drawing to database history
			await database.dbRun(
				DB_NAME,
				"INSERT INTO sorteios (group_id, title, status, created_at, winner_id, winner_name) VALUES (?, ?, 'finished', ?, ?, ?)",
				[message.group, title, Date.now(), winnerId, winnerName]
			);

			const text =
				`⚡ *SORTEIO INSTANTÂNEO REALIZADO!* ⚡\n\n` +
				`Sorteio: *${title}*\n` +
				`Ganhador(a): @${winnerNumber} (*${winnerName}*)! 🎁\n\n` +
				`Parabéns! 📦`;

			return new ReturnMessage({
				chatId: message.group,
				content: text,
				options: {
					mentions: [winnerId]
				}
			});
		}
	} catch (error) {
		logger.error("Erro no comando !sortear:", error);
		return new ReturnMessage({
			chatId: message.group,
			content: "Erro ao realizar o sorteio."
		});
	}
}

/**
 * Lists past raffles in the group and their winners
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage>}
 */
async function handleSorteios(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		const raffles = await database.dbAll(
			DB_NAME,
			"SELECT * FROM sorteios WHERE group_id = ? AND status = 'finished' ORDER BY created_at DESC LIMIT 15",
			[message.group]
		);

		if (!raffles || raffles.length === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Nenhum sorteio anterior registrado neste grupo."
			});
		}

		let content = `📋 *Histórico de Sorteios* 📋\n\n`;
		raffles.forEach((r, idx) => {
			const dateStr = new Date(r.created_at).toLocaleDateString("pt-BR");
			content += `${idx + 1}. *${r.title}* - Vencedor(a): *${r.winner_name}* (@${r.winner_id.split("@")[0]}) em ${dateStr}\n`;
		});

		const mentions = raffles.map((r) => r.winner_id).filter((id) => id);
		return new ReturnMessage({
			chatId: message.group,
			content,
			options: { mentions }
		});
	} catch (error) {
		logger.error("Erro no comando !sorteios:", error);
		return new ReturnMessage({
			chatId: message.group,
			content: "Erro ao obter o histórico de sorteios."
		});
	}
}

/**
 * Handles reactions (🎲) to join or leave the active raffle
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|boolean>}
 */
async function processSorteioReaction(bot, message, args, group) {
	try {
		if (!message.originReaction) return false;

		const reaction = message.originReaction;

		// Only handle 🎲 reaction
		if (reaction.reaction !== "🎲") return false;

		// Fetch target message
		const targetMessage = await bot.client.getMessageById(reaction.msgId._serialized);
		if (!targetMessage) return false;

		const chat = await targetMessage.getChat();
		if (!chat.isGroup) return false;

		const groupId = chat.id._serialized;

		// Check if active raffle exists
		const raffle = await database.dbGet(
			DB_NAME,
			"SELECT * FROM sorteios WHERE group_id = ? AND status = 'active'",
			[groupId]
		);

		if (!raffle || raffle.message_id !== reaction.msgId._serialized) return false;

		const userId = reaction.senderId;
		const userPushName = reaction.userName || "Usuário";

		const groupData = await bot.eventHandler.getOrCreateGroup(groupId);
		const currentGroup = groupData?.group;
		const userName = await getUserDisplayName(bot, currentGroup, userId, userPushName);

		// Toggle user participation
		const participant = await database.dbGet(
			DB_NAME,
			"SELECT * FROM sorteio_participants WHERE sorteio_id = ? AND user_id = ?",
			[raffle.id, userId]
		);

		if (participant) {
			await database.dbRun(
				DB_NAME,
				"DELETE FROM sorteio_participants WHERE sorteio_id = ? AND user_id = ?",
				[raffle.id, userId]
			);

			return new ReturnMessage({
				chatId: groupId,
				content: `${userName} saiu do sorteio "${raffle.title}"!`
			});
		} else {
			await database.dbRun(
				DB_NAME,
				"INSERT INTO sorteio_participants (sorteio_id, user_id, user_name, joined_at) VALUES (?, ?, ?, ?)",
				[raffle.id, userId, userName, Date.now()]
			);

			return new ReturnMessage({
				chatId: groupId,
				content: `${userName} entrou no sorteio "${raffle.title}"!`
			});
		}
	} catch (error) {
		logger.error("Erro ao processar reação do sorteio:", error);
		return false;
	}
}

// Commands registrations
const commands = [
	new Command({
		name: "sorteio",
		description: "Inicia um novo sorteio ou exibe os detalhes do sorteio ativo",
		category: "grupo",
		reactions: {
			before: "⌛️",
			after: "🎁"
		},
		method: handleSorteio
	}),
	new Command({
		name: "sorteio-entrar",
		description: "Participar do sorteio ativo no grupo",
		category: "grupo",
		reactions: {
			before: "⌛️",
			after: "✅"
		},
		method: handleSorteioEntrar
	}),
	new Command({
		name: "sorteio-sair",
		description: "Sair do sorteio ativo no grupo",
		category: "grupo",
		reactions: {
			before: "⌛️",
			after: "❌"
		},
		method: handleSorteioSair
	}),
	new Command({
		name: "sortear",
		description: "Realiza o sorteio ativo ou sorteia alguém aleatório no grupo instantaneamente",
		category: "grupo",
		reactions: {
			before: "⌛️",
			after: "🎉"
		},
		method: handleSortear
	}),
	new Command({
		name: "sorteios",
		description: "Lista o histórico de sorteios realizados no grupo",
		category: "grupo",
		reactions: {
			before: "⌛️",
			after: "📋"
		},
		method: handleSorteios
	}),
	new Command({
		name: "reactionSorteioHelper",
		description: "Invocado apenas pelo ReactionsHandler para gerenciar inscrições via emoji",
		reactions: {
			trigger: ["🎲"]
		},
		usage: "",
		hidden: true,
		method: processSorteioReaction
	})
];

module.exports = {
	commands,
	processSorteioReaction
};
