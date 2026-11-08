// src/functions/SorteioCommands.js

const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const PhoneUtils = require("../utils/PhoneUtils");

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
 * Formata lista de vencedores com numeração de 1 a N
 * (1º 🥇, 2º 🥈, 3º 🥉, 4º em diante numérico normal)
 * @param {Array<{user_id: string, user_name: string}>} winners
 * @returns {string} Lista formatada
 */
function formatWinnerList(winners) {
	return winners
		.map((winner, index) => {
			const winnerNumber = (winner.user_id || winner.id?._serialized || "").split("@")[0];
			const winnerName = winner.user_name || winner.name || `Usuário_${winnerNumber}`;
			let prefix = "";
			if (index === 0) {
				prefix = "🥇 1.";
			} else if (index === 1) {
				prefix = "🥈 2.";
			} else if (index === 2) {
				prefix = "🥉 3.";
			} else {
				prefix = `${index + 1}.`;
			}
			return `${prefix} @${winnerNumber} (*${winnerName}*)`;
		})
		.join("\n");
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
			content += `Para realizar o sorteio, use *!sortear [quantidade]*.\n`;
			content += `Para remover quem já saiu do grupo, use *!sorteio-limpar*.`;

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
 * Draws winners from the active raffle or performs an instant raffle of all group members
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

		let count = 1;
		if (args && args.length > 0) {
			const parsed = parseInt(args[0], 10);
			if (!isNaN(parsed) && parsed > 0) {
				count = parsed;
			}
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

			const numWinners = Math.min(count, participants.length);
			const pool = [...participants];
			const winners = [];

			for (let i = 0; i < numWinners; i++) {
				const randomIndex = Math.floor(Math.random() * pool.length);
				winners.push(pool[randomIndex]);
				pool.splice(randomIndex, 1);
			}

			for (const winner of winners) {
				winner.user_name = await getUserDisplayName(bot, group, winner.user_id, winner.user_name);
			}

			const winnerIds = winners.map((w) => w.user_id).join(",");
			const winnerNames = winners.map((w) => w.user_name).join(", ");

			// Mark raffle as finished with winner details
			await database.dbRun(
				DB_NAME,
				"UPDATE sorteios SET status = 'finished', winner_id = ?, winner_name = ? WHERE id = ?",
				[winnerIds, winnerNames, raffle.id]
			);

			// Clean up participants table for this raffle
			await database.dbRun(DB_NAME, "DELETE FROM sorteio_participants WHERE sorteio_id = ?", [
				raffle.id
			]);

			const winnerHeading =
				winners.length === 1 ? "*Ganhador(a):*" : `*Ganhadores (${winners.length}):*`;
			const text =
				`🎉 *SORTEIO REALIZADO!* 🎉\n\n` +
				`Sorteio: *${raffle.title}*\n` +
				`${winnerHeading}\n` +
				`${formatWinnerList(winners)}\n\n` +
				`Parabéns! 📦`;

			return new ReturnMessage({
				chatId: message.group,
				content: text,
				options: {
					mentions: winners.map((w) => w.user_id)
				}
			});
		} else {
			// Draw instant winner from active group members
			let instantTitle = "Sorteio Rápido";
			if (args && args.length > 0) {
				const parsed = parseInt(args[0], 10);
				if (!isNaN(parsed) && parsed > 0) {
					instantTitle = args.slice(1).join(" ") || "Sorteio Rápido";
				} else {
					instantTitle = args.join(" ");
				}
			}

			const chat = await message.origin.getChat();
			if (!chat || !chat.isGroup) {
				return new ReturnMessage({
					chatId: message.group,
					content: "Erro ao acessar os membros do grupo."
				});
			}

			const ignoredUsers = group?.ignoredUsers || [];
			const botJid = bot?.client?.info?.wid?._serialized;
			const botPhone = bot?.phoneNumber ? PhoneUtils.cleanPhone(bot.phoneNumber) : null;

			const participants =
				chat.participants?.filter((p) => {
					const id = p.id?._serialized || p.phoneNumber || p.lid;
					if (!id) return false;
					if (botJid && id === botJid) return false;
					if (botPhone && PhoneUtils.cleanPhone(id) === botPhone) return false;
					if (ignoredUsers.some((ignored) => id.startsWith(ignored))) return false;
					if (bot?.database?.isGlobalIgnored?.(id)) return false;
					return true;
				}) ?? [];

			if (participants.length === 0) {
				return new ReturnMessage({
					chatId: message.group,
					content: "Nenhum membro elegível encontrado no grupo para realizar o sorteio."
				});
			}

			const numWinners = Math.min(count, participants.length);
			const pool = [...participants];
			const winners = [];

			for (let i = 0; i < numWinners; i++) {
				const randomIndex = Math.floor(Math.random() * pool.length);
				winners.push(pool[randomIndex]);
				pool.splice(randomIndex, 1);
			}

			const resolvedWinners = [];
			for (const winner of winners) {
				const winnerId = winner.id?._serialized || winner.phoneNumber || winner.lid;
				const winnerName = await getUserDisplayName(bot, group, winnerId, null);
				resolvedWinners.push({
					user_id: winnerId,
					user_name: winnerName
				});
			}

			const winnerIds = resolvedWinners.map((w) => w.user_id).join(",");
			const winnerNames = resolvedWinners.map((w) => w.user_name).join(", ");

			// Save the instant drawing to database history
			await database.dbRun(
				DB_NAME,
				"INSERT INTO sorteios (group_id, title, status, created_at, winner_id, winner_name) VALUES (?, ?, 'finished', ?, ?, ?)",
				[message.group, instantTitle, Date.now(), winnerIds, winnerNames]
			);

			const winnerHeading =
				resolvedWinners.length === 1
					? "*Ganhador(a):*"
					: `*Ganhadores (${resolvedWinners.length}):*`;
			const text =
				`⚡ *SORTEIO INSTANTÂNEO REALIZADO!* ⚡\n\n` +
				`Sorteio: *${instantTitle}*\n` +
				`${winnerHeading}\n` +
				`${formatWinnerList(resolvedWinners)}\n\n` +
				`Parabéns! 📦`;

			return new ReturnMessage({
				chatId: message.group,
				content: text,
				options: {
					mentions: resolvedWinners.map((w) => w.user_id)
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
 * Removes participants from active raffles who have left the group
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage>}
 */
async function handleSorteioLimpar(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Check if active raffles exist
		const activeRaffles = await database.dbAll(
			DB_NAME,
			"SELECT * FROM sorteios WHERE group_id = ? AND status = 'active'",
			[message.group]
		);

		if (!activeRaffles || activeRaffles.length === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Não há nenhum sorteio ativo neste grupo no momento."
			});
		}

		// Permission check: group admin OR creator of any active raffle
		const requesterId = message.author;
		let isAllowed = activeRaffles.some((r) => r.creator_id === requesterId);

		let chat = null;
		try {
			chat = await message.origin.getChat();
		} catch (e) {
			logger.warn("Erro ao obter chat via message.origin:", e);
		}

		if (!isAllowed) {
			const AdminUtils = require("../utils/AdminUtils");
			const adminUtils = AdminUtils.getInstance();
			const isUserAdmin = await adminUtils.isAdmin(requesterId, group, chat, bot);
			isAllowed = isUserAdmin;
		}

		if (!isAllowed) {
			return new ReturnMessage({
				chatId: message.group,
				content:
					"⚠️ Apenas administradores do grupo ou o criador deste sorteio podem usar o comando *!sorteio-limpar*."
			});
		}

		if (!chat?.participants && bot?.client?.getChatById) {
			try {
				chat = await bot.client.getChatById(message.group);
			} catch (e) {
				logger.warn("Erro ao obter chat via getChatById:", e);
			}
		}

		const groupParticipants = chat?.participants || chat?.Participants || [];
		if (groupParticipants.length === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Erro ao acessar os membros do grupo para verificar os participantes."
			});
		}

		const memberIdentifiers = new Set();
		for (const p of groupParticipants) {
			const pJid = p.id?._serialized || p.JID;
			const pLid = p.lid || p.LID;
			const pPhone = p.phoneNumber || p.PhoneNumber;
			const pUser = p.id?.user;

			if (pJid) memberIdentifiers.add(pJid);
			if (pLid) memberIdentifiers.add(pLid);
			if (pPhone) memberIdentifiers.add(String(pPhone));
			if (pUser) {
				memberIdentifiers.add(`${pUser}@s.whatsapp.net`);
				memberIdentifiers.add(pUser);
			}

			const clean = PhoneUtils.cleanPhone(pJid || pPhone || pLid);
			if (clean) {
				const variants = PhoneUtils.getPhoneVariants(clean);
				for (const v of variants) {
					memberIdentifiers.add(v);
				}
			}
		}

		function isMemberInGroup(userId) {
			if (!userId) return false;
			if (memberIdentifiers.has(userId)) return true;
			const cleanId = PhoneUtils.cleanPhone(userId);
			if (cleanId) {
				const variants = PhoneUtils.getPhoneVariants(cleanId);
				for (const v of variants) {
					if (memberIdentifiers.has(v)) return true;
				}
			}
			return false;
		}

		let totalRemoved = 0;
		const removedParticipants = [];

		for (const raffle of activeRaffles) {
			const participants = await database.dbAll(
				DB_NAME,
				"SELECT * FROM sorteio_participants WHERE sorteio_id = ?",
				[raffle.id]
			);

			const left = participants.filter((p) => !isMemberInGroup(p.user_id));

			for (const p of left) {
				await database.dbRun(
					DB_NAME,
					"DELETE FROM sorteio_participants WHERE sorteio_id = ? AND user_id = ?",
					[raffle.id, p.user_id]
				);
				totalRemoved++;
				if (!removedParticipants.some((rp) => rp.user_id === p.user_id)) {
					removedParticipants.push(p);
				}
			}
		}

		if (totalRemoved === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content:
					"🧹 *Limpeza de Sorteio:*\n\nNenhum participante inativo encontrado. Todos os inscritos continuam no grupo!"
			});
		}

		let content = `🧹 *Limpeza de Sorteio Concluída!*\n\n`;
		content += `Foram removidos *${totalRemoved}* participante(s) que já saíram do grupo:\n`;
		removedParticipants.forEach((p, idx) => {
			content += `${idx + 1}. ${p.user_name} (@${p.user_id.split("@")[0]})\n`;
		});

		if (activeRaffles.length === 1) {
			const remaining = await database.dbAll(
				DB_NAME,
				"SELECT * FROM sorteio_participants WHERE sorteio_id = ?",
				[activeRaffles[0].id]
			);
			content += `\nO sorteio "*${activeRaffles[0].title}*" agora conta com *${remaining.length}* participante(s).`;
		}

		return new ReturnMessage({
			chatId: message.group,
			content,
			options: {
				mentions: removedParticipants.map((p) => p.user_id)
			}
		});
	} catch (error) {
		logger.error("Erro no comando !sorteio-limpar:", error);
		return new ReturnMessage({
			chatId: message.group,
			content: "Erro ao tentar limpar participantes inativos do sorteio."
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
		const mentions = [];
		raffles.forEach((r, idx) => {
			const dateStr = new Date(r.created_at).toLocaleDateString("pt-BR");
			const ids = (r.winner_id || "")
				.split(",")
				.map((id) => id.trim())
				.filter(Boolean);
			mentions.push(...ids);

			if (ids.length > 1) {
				const tags = ids.map((id) => `@${id.split("@")[0]}`).join(", ");
				content += `${idx + 1}. *${r.title}* - Vencedores: *${r.winner_name}* (${tags}) em ${dateStr}\n`;
			} else if (ids.length === 1) {
				content += `${idx + 1}. *${r.title}* - Vencedor(a): *${r.winner_name}* (@${ids[0].split("@")[0]}) em ${dateStr}\n`;
			} else {
				content += `${idx + 1}. *${r.title}* - Vencedor(a): *${r.winner_name || "Desconhecido"}* em ${dateStr}\n`;
			}
		});

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
		name: "sorteio-limpar",
		description: "Remove do sorteio ativo os participantes que já saíram do grupo",
		category: "grupo",
		reactions: {
			before: "⌛️",
			after: "🧹"
		},
		method: handleSorteioLimpar
	}),
	new Command({
		name: "sortear",
		description:
			"Realiza o sorteio ativo ou sorteia membros aleatórios no grupo (permite definir quantidade)",
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

const helper = {
	about: "Sistema completo de sorteios no grupo com inscrição por reações ou sorteio instantâneo",
	implementation:
		"Gerencia sorteios com tempo limite, lista de participantes por reação/comando e escolha aleatória com histórico",
	tags: "sorteio,sortear,rifa,concurso,premios,ganhador",
	cmds: [
		{
			cmd: "!sorteio",
			desc: "Inicia um novo sorteio com descrição e tempo ou exibe o sorteio em andamento",
			usage: ["!sorteio 10m Caixa de chocolate", "!sorteio"],
			category: "grupo"
		},
		{
			cmd: "!sorteio-entrar",
			desc: "Entra no sorteio ativo do grupo",
			usage: ["!sorteio-entrar"],
			category: "grupo"
		},
		{
			cmd: "!sorteio-sair",
			desc: "Sai da lista de participantes do sorteio ativo",
			usage: ["!sorteio-sair"],
			category: "grupo"
		},
		{
			cmd: "!sorteio-limpar",
			desc: "Remove do sorteio ativo os participantes que já saíram do grupo",
			usage: ["!sorteio-limpar"],
			category: "grupo"
		},
		{
			cmd: "!sortear",
			desc: "Finaliza o sorteio ativo ou sorteia membros aleatórios do grupo imediatamente",
			usage: ["!sortear", "!sortear 3", "!sortear 2 Prêmio"],
			category: "grupo"
		},
		{
			cmd: "!sorteios",
			desc: "Exibe o histórico de sorteios já realizados no grupo",
			usage: ["!sorteios"],
			category: "grupo"
		}
	]
};

module.exports = {
	helper,
	commands,
	processSorteioReaction
};
