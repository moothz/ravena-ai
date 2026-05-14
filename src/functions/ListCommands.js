// src/functions/ListCommands.js

const path = require("path");
const fs = require("fs").promises;
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("list-commands");
const database = Database.getInstance();
const DB_NAME = "lists";

// Initialize Database
database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS lists (
    group_id TEXT PRIMARY KEY,
    json_data TEXT
  );
`
);

// Emoji numbers for reactions
const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const NUMBER_EMOJIS2 = ["1⃣", "2⃣", "3⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]; // 0⃣
const NUMBER_EMOJIS3 = ["1️", "2️", "3️", "4️", "5️", "6️", "7️", "8️", "9️", "🔟"];

//logger.info('Módulo ListCommands carregado');

/**
 * Process reactions to join or leave lists
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} reaction - Reaction data
 * @returns {Promise<boolean>} True if reaction was processed
 */
async function processListReaction(bot, message, args, group) {
	//logger.debug(`[processListReaction] `, { message });
	try {
		if (!message.originReaction) {
			logger.error(`[processListReaction] Fui chamado sem uma originReaction.`);
			return false;
		}

		const reaction = message.originReaction;

		// Check if reaction is a number emoji
		let emojiIndex = NUMBER_EMOJIS.indexOf(reaction.reaction);
		if (emojiIndex === -1) emojiIndex = NUMBER_EMOJIS2.indexOf(reaction.reaction);
		if (emojiIndex === -1) emojiIndex = NUMBER_EMOJIS3.indexOf(reaction.reaction);
		if (emojiIndex === -1) return false;

		// Get the original message
		const targetMessage = await bot.client.getMessageById(reaction.msgId._serialized);
		if (!targetMessage) return false;

		// Check if the message is from the bot and contains lists
		if (
			targetMessage.fromMe &&
			["listas disponíveis", "listas disponibles"].some((ldpf) =>
				targetMessage.body?.toLowerCase().includes(ldpf)
			)
		) {
			// Get the chat
			const chat = await targetMessage.getChat();
			if (!chat.isGroup) return false;

			// Get group data
			const groupData = await bot.eventHandler.getOrCreateGroup(chat.id._serialized);
			const group = groupData.group;

			// Get lists for this group
			const lists = await getGroupLists(chat.id._serialized);

			// Check if the list index exists
			if (emojiIndex >= lists.length) return false;

			// Get the list at this index
			const list = lists[emojiIndex];

			// Get user info
			const userName = message.originReaction.userName;
			const userId = message.originReaction.senderId;

			// Check if user is already in the list
			const isInList = list.members.some((member) => member.id === userId);

			if (isInList) {
				// Leave the list
				list.members = list.members.filter((member) => member.id !== userId);
				await saveGroupLists(chat.id._serialized, lists);

				// Return message to notify user
				return new ReturnMessage({
					chatId: chat.id._serialized,
					content: `${userName} saiu da lista "${list.name}"`
				});
			} else {
				// Join the list
				list.members.push({
					id: userId,
					name: userName,
					joinedAt: Date.now()
				});
				await saveGroupLists(chat.id._serialized, lists);

				// Return message to notify user
				return new ReturnMessage({
					chatId: chat.id._serialized,
					content: `${userName} entrou na lista "${list.name}"`
				});
			}
		}

		return false;
	} catch (error) {
		logger.error("Error processing list reaction:", error);
		return false;
	}
}

/**
 * Gets lists for a group
 * @param {string} groupId - Group ID
 * @returns {Promise<Array>} Lists array
 */
async function getGroupLists(groupId) {
	try {
		const row = await database.dbGet(DB_NAME, "SELECT json_data FROM lists WHERE group_id = ?", [
			groupId
		]);
		return row ? JSON.parse(row.json_data) : [];
	} catch (error) {
		logger.error(`Error getting lists for group ${groupId}:`, error);
		return [];
	}
}

/**
 * Saves lists for a group
 * @param {string} groupId - Group ID
 * @param {Array} lists - Lists array
 * @returns {Promise<boolean>} Success status
 */
async function saveGroupLists(groupId, lists) {
	try {
		await database.dbRun(
			DB_NAME,
			"INSERT OR REPLACE INTO lists (group_id, json_data) VALUES (?, ?)",
			[groupId, JSON.stringify(lists, null, 2)]
		);
		return true;
	} catch (error) {
		logger.error(`Error saving lists for group ${groupId}:`, error);
		return false;
	}
}

/**
 * Gets user name with possible nickname
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} group - Group data
 * @param {string} userId - User ID
 * @returns {Promise<string>} User's name or nickname
 */
async function getUserDisplayName(bot, group, message, userId) {
	try {
		// Check if user has a nickname in this group
		if (group.nicks && Array.isArray(group.nicks)) {
			const nickData = group.nicks.find((nick) => nick.numero === userId);
			if (nickData && nickData.apelido) {
				return nickData.apelido;
			}
		}

		const userName =
			message?.name ?? message?.pushName ?? message?.pushname ?? message?.authorName ?? false;

		if (userName) {
			return userName;
		}

		// Get contact info as fallback
		try {
			const contact = await bot.client.getContactById(userId);
			return contact.pushname || contact.name || "Usuário";
		} catch (error) {
			logger.error(`Error getting contact for ${userId}:`, error);
			return `Usuário_${userId}`;
		}
	} catch (error) {
		logger.error(`Error getting display name for ${userId}:`, error);
		return `Usuário_${userId}`;
	}
}

/**
 * Shows all lists in a group
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage>} ReturnMessage with list information
 */
async function showLists(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Get lists for this group
		const lists = await getGroupLists(message.group);

		if (lists.length === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Não há listas criadas neste grupo. Use !lc <nome> para criar uma lista."
			});
		}

		// Format the message with lists
		let listsMessage = "*Listas disponíveis*\n\n";

		for (let i = 0; i < lists.length; i++) {
			const list = lists[i];
			const emoji = i < NUMBER_EMOJIS.length ? NUMBER_EMOJIS[i] : `${i + 1}.`;

			// Format list title or name
			const listTitle = list.title || list.name;

			listsMessage += `${emoji} *${listTitle}*`;

			// Add member count
			const memberCount = list.members ? list.members.length : 0;
			listsMessage += ` (${memberCount} membro${memberCount !== 1 ? "s" : ""})\n`;

			// Add members if any
			if (memberCount > 0) {
				listsMessage += "Membros: ";
				const memberNames = [];

				for (const member of list.members) {
					// Get display name (with possible nickname)
					const displayName = await getUserDisplayName(bot, group, message, member.id);
					memberNames.push(displayName);
				}

				listsMessage += memberNames.join(", ");
				listsMessage += "\n";
			}

			listsMessage += "\n";
		}

		// Add instructions
		listsMessage += "Reaja com o emoji do número para entrar/sair de uma lista.\n";
		listsMessage += "Comandos: !le <lista> (entrar), !ls <lista> (sair)";

		// Return the message with lists
		return new ReturnMessage({
			chatId: message.group,
			content: listsMessage
		});
	} catch (error) {
		logger.error("Error showing lists:", error);

		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao mostrar listas. Por favor, tente novamente."
		});
	}
}

/**
 * Creates a new list
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} ReturnMessage or array with results
 */
async function createList(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Por favor, forneça pelo menos um nome de lista. Exemplo: !lc lista1 lista2"
			});
		}

		// Get lists for this group
		const lists = await getGroupLists(message.group);

		// Create each list
		const createdLists = [];
		const returnMessages = [];

		for (const arg of args) {
			const listName = arg.trim();

			// Skip empty names
			if (!listName) continue;

			// Check if list already exists
			const existingList = lists.find((list) => list.name.toLowerCase() === listName.toLowerCase());

			if (existingList) {
				// Skip existing lists
				returnMessages.push(
					new ReturnMessage({
						chatId: message.group,
						content: `Lista "${listName}" já existe.`
					})
				);
				continue;
			}

			// Create new list
			const newList = {
				name: listName,
				title: null,
				createdAt: Date.now(),
				createdBy: message.author,
				members: []
			};

			lists.push(newList);
			createdLists.push(listName);
		}

		// Save updated lists
		if (createdLists.length > 0) {
			await saveGroupLists(message.group, lists);

			// Notify about created lists
			returnMessages.push(
				new ReturnMessage({
					chatId: message.group,
					content: `Lista${createdLists.length > 1 ? "s" : ""} criada${
						createdLists.length > 1 ? "s" : ""
					}: ${createdLists.join(", ")}`
				})
			);

			// Add updated list display to return messages
			const listsResult = await showLists(bot, message, [], group);
			returnMessages.push(listsResult);
		}

		return returnMessages.length > 0
			? returnMessages
			: new ReturnMessage({
					chatId: message.group,
					content: "Nenhuma lista foi criada."
				});
	} catch (error) {
		logger.error("Error creating list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao criar lista. Por favor, tente novamente."
		});
	}
}

/**
 * Creates a new list with title
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} ReturnMessage or array with results
 */
async function createListWithTitle(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length < 2) {
			return new ReturnMessage({
				chatId: message.group,
				content:
					"Por favor, forneça o nome da lista e o título. Exemplo: !lct lista1 Título da Lista"
			});
		}

		// Get list name and title
		const listName = args[0].trim();
		const listTitle = args.slice(1).join(" ");

		// Get lists for this group
		const lists = await getGroupLists(message.group);

		// Check if list already exists
		const existingList = lists.find((list) => list.name.toLowerCase() === listName.toLowerCase());

		if (existingList) {
			return new ReturnMessage({
				chatId: message.group,
				content: `Lista "${listName}" já existe. Use !lt ${listName} ${listTitle} para atualizar o título.`
			});
		}

		// Create new list with title
		const newList = {
			name: listName,
			title: listTitle,
			createdAt: Date.now(),
			createdBy: message.author,
			members: []
		};

		lists.push(newList);

		// Save updated lists
		await saveGroupLists(message.group, lists);

		// Return both a creation confirmation and updated lists
		return [
			new ReturnMessage({
				chatId: message.group,
				content: `Lista criada: ${listName} (${listTitle})`
			}),
			await showLists(bot, message, [], group)
		];
	} catch (error) {
		logger.error("Error creating list with title:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao criar lista. Por favor, tente novamente."
		});
	}
}

/**
 * Deletes a list
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} ReturnMessage or array with results
 */
async function deleteList(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content:
					"Por favor, forneça pelo menos um nome de lista para excluir. Exemplo: !ld lista1 lista2"
			});
		}

		// Get lists for this group
		const lists = await getGroupLists(message.group);

		// Delete each list
		const deletedLists = [];
		const returnMessages = [];

		for (const arg of args) {
			const listName = arg.trim();

			// Skip empty names
			if (!listName) continue;

			// Find list index
			const listIndex = lists.findIndex(
				(list) => list.name.toLowerCase() === listName.toLowerCase()
			);

			if (listIndex === -1) {
				// Skip non-existent lists
				returnMessages.push(
					new ReturnMessage({
						chatId: message.group,
						content: `Lista "${listName}" não encontrada.`
					})
				);
				continue;
			}

			// Remove list
			lists.splice(listIndex, 1);
			deletedLists.push(listName);
		}

		// Save updated lists
		if (deletedLists.length > 0) {
			await saveGroupLists(message.group, lists);

			// Notify about deleted lists
			returnMessages.push(
				new ReturnMessage({
					chatId: message.group,
					content: `Lista${deletedLists.length > 1 ? "s" : ""} excluída${
						deletedLists.length > 1 ? "s" : ""
					}: ${deletedLists.join(", ")}`
				})
			);

			// Show remaining lists if any
			if (lists.length > 0) {
				returnMessages.push(await showLists(bot, message, [], group));
			}
		}

		return returnMessages.length > 0
			? returnMessages
			: new ReturnMessage({
					chatId: message.group,
					content: "Nenhuma lista foi excluída."
				});
	} catch (error) {
		logger.error("Error deleting list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao excluir lista. Por favor, tente novamente."
		});
	}
}

/**
 * Joins a list
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} ReturnMessage or array with results
 */
async function joinList(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Por favor, forneça o nome da lista para entrar. Exemplo: !le lista1"
			});
		}

		// Get lists for this group
		const lists = await getGroupLists(message.group);
		const returnMessages = [];

		for (const arg of args) {
			const listName = arg.trim();
			console.log({ args, lists, listName });
			// Find the list
			const list = lists.find((list) => list.name.toLowerCase() === listName.toLowerCase());

			if (!list) {
				returnMessages.push(
					new ReturnMessage({
						chatId: message.group,
						content: `Lista "${listName}" não encontrada.`
					})
				);
			}

			// Get user name
			const userName =
				message.name ??
				message.pushName ??
				message.pushname ??
				message.authorName ??
				`Pessoa_${message.author}`;
			// Check if user is already in the list
			if (!list.members) list.members = [];

			const existingMember = list.members.find((member) => member.id === message.author);

			if (existingMember) {
				returnMessages.push(
					new ReturnMessage({
						chatId: message.group,
						content: `Você já está na lista "${list.title || list.name}".`
					})
				);
			}

			// Add user to the list
			list.members.push({
				id: message.author,
				name: userName,
				joinedAt: Date.now()
			});

			returnMessages.push(
				new ReturnMessage({
					chatId: message.group,
					content: `${userName} entrou na lista "${list.title || list.name}".`
				})
			);
		}

		// Save updated lists
		await saveGroupLists(message.group, lists);

		// Return both a joining confirmation and updated lists
		return [...returnMessages, await showLists(bot, message, [], group)];
	} catch (error) {
		logger.error("Error joining list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao entrar na lista. Por favor, tente novamente."
		});
	}
}

/**
 * Leaves a list
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} ReturnMessage or array with results
 */
async function leaveList(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content:
					"Por favor, forneça o nome de pelo menos uma lista para sair. Exemplo: !ls lista1 lista2"
			});
		}

		const lists = await getGroupLists(message.group);

		const userName =
			message.name ??
			message.pushName ??
			message.pushname ??
			message.authorName ??
			`Pessoa_${message.author}`;
		const leftLists = [];
		const errors = [];

		for (const arg of args) {
			const listName = arg.trim();
			const list = lists.find((list) => list.name.toLowerCase() === listName.toLowerCase());

			if (!list) {
				errors.push(`• Lista "${listName}" não encontrada.`);
				continue;
			}

			if (!list.members) list.members = [];

			const memberIndex = list.members.findIndex((member) => member.id === message.author);
			if (memberIndex === -1) {
				errors.push(`• Você não está na lista "${list.title || list.name}".`);
				continue;
			}

			list.members.splice(memberIndex, 1);
			leftLists.push(list.title || list.name);
		}

		await saveGroupLists(message.group, lists);

		const summary =
			leftLists.length > 0
				? `${userName} saiu das listas: ${leftLists.map((name) => `"${name}"`).join(", ")}.`
				: `${userName} não saiu de nenhuma lista.`;

		const errorMsg = errors.length > 0 ? `\n\nErros:\n${errors.join("\n")}` : "";

		return [
			new ReturnMessage({
				chatId: message.group,
				content: summary + errorMsg
			}),
			await showLists(bot, message, [], group)
		];
	} catch (error) {
		logger.error("Error leaving list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao sair da lista. Por favor, tente novamente."
		});
	}
}

/**
 * Sets the title of a list
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} ReturnMessage or array with results
 */
async function setListTitle(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length < 2) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Por favor, forneça o nome da lista e o título. Exemplo: !lt lista1 Novo Título"
			});
		}

		const listName = args[0].trim();
		const listTitle = args.slice(1).join(" ");

		// Get lists for this group
		const lists = await getGroupLists(message.group);

		// Find the list
		const list = lists.find((list) => list.name.toLowerCase() === listName.toLowerCase());

		if (!list) {
			return new ReturnMessage({
				chatId: message.group,
				content: `Lista "${listName}" não encontrada.`
			});
		}

		// Update list title
		list.title = listTitle;

		// Save updated lists
		await saveGroupLists(message.group, lists);

		// Return both a title update confirmation and updated lists
		return [
			new ReturnMessage({
				chatId: message.group,
				content: `Título da lista "${listName}" atualizado para "${listTitle}".`
			}),
			await showLists(bot, message, [], group)
		];
	} catch (error) {
		logger.error("Error setting list title:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao definir título da lista. Por favor, tente novamente."
		});
	}
}

/**
 * Removes a user from a list (admin only)
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} ReturnMessage or array with results
 */
async function removeFromList(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Check if user is admin in the group
		const chat = await message.origin.getChat();
		const participants = chat.participants || [];
		const sender = participants.find((p) => p.id._serialized === message.author);

		if (!sender || !sender.isAdmin) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Este comando só pode ser usado por administradores do grupo."
			});
		}

		if (args.length < 2) {
			return new ReturnMessage({
				chatId: message.group,
				content:
					"Por favor, forneça o nome da lista e o número do participante. Exemplo: !lr lista1 5521987654321"
			});
		}

		const listName = args[0].trim();
		let userIdentifier = args[1].trim();

		// Clean phone number (remove non-digits)
		userIdentifier = userIdentifier.replace(/\D/g, "");

		// Get lists for this group
		const lists = await getGroupLists(message.group);

		// Find the list
		const list = lists.find((list) => list.name.toLowerCase() === listName.toLowerCase());

		if (!list) {
			return new ReturnMessage({
				chatId: message.group,
				content: `Lista "${listName}" não encontrada.`
			});
		}

		// Check if list has members
		if (!list.members || list.members.length === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content: `A lista "${list.title || list.name}" não tem membros.`
			});
		}

		// Find the member by phone number
		const memberIndex = list.members.findIndex(
			(member) =>
				member.id.includes(userIdentifier) || (member.name && member.name.includes(userIdentifier))
		);

		if (memberIndex === -1) {
			return new ReturnMessage({
				chatId: message.group,
				content: `Usuário com número "${userIdentifier}" não encontrado na lista.`
			});
		}

		// Get member name before removal
		const memberName = list.members[memberIndex].name || "Usuário";

		// Remove the member
		list.members.splice(memberIndex, 1);

		// Save updated lists
		await saveGroupLists(message.group, lists);

		// Return both a removal confirmation and updated lists
		return [
			new ReturnMessage({
				chatId: message.group,
				content: `${memberName} foi removido da lista "${
					list.title || list.name
				}" por um administrador.`
			}),
			await showLists(bot, message, [], group)
		];
	} catch (error) {
		logger.error("Error removing user from list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao remover usuário da lista. Por favor, tente novamente."
		});
	}
}

// Criar array de comandos usando a classe Command
const commands = [
	new Command({
		name: "listas",
		description: "Mostra as listas disponíveis no grupo",
		category: "listas",
		group: "llistas",
		reactions: {
			before: "⌛️",
			after: "📋"
		},
		method: showLists
	}),

	new Command({
		name: "ll",
		description: "Alias para comando listas",
		category: "listas",
		group: "llistas",
		reactions: {
			before: "⌛️",
			after: "📋"
		},
		method: showLists
	}),

	new Command({
		name: "lc",
		description: "Cria uma nova lista",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "➕"
		},
		method: createList
	}),

	new Command({
		name: "lct",
		description: "Cria uma nova lista com título",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "➕"
		},
		method: createListWithTitle
	}),

	new Command({
		name: "ld",
		description: "Deleta uma lista",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "🧹"
		},
		method: deleteList
	}),

	new Command({
		name: "le",
		description: "Entra em uma lista",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "👉"
		},
		method: joinList
	}),

	new Command({
		name: "ls",
		description: "Sai de uma lista",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "👈"
		},
		method: leaveList
	}),

	new Command({
		name: "lt",
		description: "Define título de uma lista",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "✏️"
		},
		method: setListTitle
	}),

	new Command({
		name: "lr",
		description: "Remove um usuário de uma lista (admin only)",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "❌"
		},
		method: removeFromList
	}),
	new Command({
		name: "reactionListHelper",
		description: "Invocado apenas pelo ReactionsHandler",
		reactions: {
			trigger: NUMBER_EMOJIS.concat(NUMBER_EMOJIS2, NUMBER_EMOJIS3)
		},
		usage: "",
		hidden: true,
		method: processListReaction
	})
];

// Export commands and reaction handler
module.exports = {
	commands,
	processListReaction
};
