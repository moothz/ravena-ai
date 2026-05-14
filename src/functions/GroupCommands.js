// src/functions/GroupCommands.js

const path = require("path");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const AdminUtils = require("../utils/AdminUtils");

const logger = new Logger("group-commands");
const database = Database.getInstance();
const adminUtils = AdminUtils.getInstance();

//logger.info('Módulo GroupCommands carregado');

/**
 * Menciona todos os membros em um grupo
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com o resultado
 */
async function mentionAllMembers(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Obtém o chat para acessar participantes
		const chat = await message.origin.getChat();
		if (!chat.isGroup) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Obtém usuários ignorados para este grupo
		const ignoredUsers = group.ignoredUsers || [];

		// Filtra usuários ignorados (mds, é mto fallback)
		const participants =
			chat?.participants?.filter((participant) => {
				// Cria um array temporário com os IDs desse participante
				const userIdentifiers = [
					participant.id?._serialized,
					participant.lid,
					participant.phoneNumber
				];

				// Verifica se ALGUM (some) dos identificadores está na lista de ignorados
				const isIgnored = userIdentifiers.some(
					(id) => id && ignoredUsers.some((iU) => id.startsWith(iU))
				);

				// Retorna true apenas se NÃO for ignorado
				return !isIgnored;
			}) ?? [];

		//logger.debug(`[mentionAllMembers] `, { todos: chat.participants, ignorados: group.ignoredUsers, filtrados: participants});

		if (participants.length === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Nenhum membro para mencionar."
			});
		}

		// Cria array de menções para todos os participantes
		const mentions = [];
		for (const participant of participants) {
			mentions.push(participant.id._serialized);
		}

		// Cria texto da mensagem (de args ou padrão)
		const quotedMsg = await message.origin.getQuotedMessage();
		if (quotedMsg) {
			if (quotedMsg.hasMedia) {
				logger.info(
					`[galera-midia] Mencionados ${mentions.length} membros no grupo ${message.group}`
				);

				const quotedText = quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body;
				const messageText = "🚨 Atenção pessoal! 🚨\n\n" + quotedText;
				const attachmentData = await quotedMsg.downloadMedia();

				return new ReturnMessage({
					chatId: message.group,
					content: attachmentData,
					options: {
						caption: messageText,
						mentions
						//mentionAll: true
					}
				});
			} else {
				logger.info(
					`[galera-texto] Mencionados ${mentions.length} membros no grupo ${message.group}`
				);
				const quotedText = quotedMsg.content ?? quotedMsg.body;
				const messageText = "🚨 Atenção pessoal! 🚨\n\n" + quotedText;

				return new ReturnMessage({
					chatId: message.group,
					content: messageText,
					options: {
						mentions
						//mentionAll: true
					}
				});
			}
		} else {
			const messageText =
				"🚨 Atenção pessoal! 🚨" + (args.length > 0 ? "\n\n" + args.join(" ") : "");

			return new ReturnMessage({
				chatId: message.group,
				content: messageText,
				options: {
					mentions
					//mentionAll: true
				}
			});
		}
	} catch (error) {
		logger.error("Erro ao mencionar membros do grupo:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao mencionar membros do grupo. Por favor, tente novamente."
		});
	}
}

/**
 * Alterna ser ignorado por menções de grupo
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com o resultado
 */
async function toggleIgnore(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Inicializa array de usuários ignorados se não existir
		if (!group.ignoredUsers) {
			group.ignoredUsers = [];
		}

		let numerosPraIgnorar = [];

		// Rainha dos fallback
		if (message.author) {
			numerosPraIgnorar.push(message.author.split("@")[0]);
		}

		if (message.authorAlt) {
			numerosPraIgnorar.push(message.authorAlt.split("@")[0]);
		}

		if (message.sender) {
			numerosPraIgnorar.push(message.sender.split("@")[0]);
		}

		if (message.senderAlt) {
			numerosPraIgnorar.push(message.senderAlt.split("@")[0]);
		}

		if (message.origin) {
			if (message.origin.key.participant) {
				numerosPraIgnorar.push(message.origin.key.participant.split("@")[0]);
			}
			if (message.origin.key.participantAlt) {
				numerosPraIgnorar.push(message.origin.key.participant.split("@")[0]);
			}
		}

		numerosPraIgnorar = [...new Set(numerosPraIgnorar)];
		const jaIgnorado = numerosPraIgnorar.some((numero) => group.ignoredUsers.includes(numero));

		logger.info(
			`Status de ignorar alternado para usuário '${numerosPraIgnorar.join("/")}' no grupo ${message.group}`
		);

		if (jaIgnorado) {
			logger.debug(
				`[toggleIgnore][${group.name}] Removendo dos ignorados: '${numerosPraIgnorar.join(",")}'`
			);
			// Remove todos os "números" do usuário da lista de ignorados
			group.ignoredUsers = group.ignoredUsers.filter(
				(ignoredUser) => !numerosPraIgnorar.includes(ignoredUser)
			);
			await database.saveGroup(group);

			return new ReturnMessage({
				chatId: message.group,
				content: "Você agora será *incluído* nas menções de grupo.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		} else {
			// Adiciona todos os "números" do usuário à lista de ignorados
			logger.debug(
				`[toggleIgnore][${group.name}] Adicionado aos ignorados: '${numerosPraIgnorar.join(",")}'`
			);
			group.ignoredUsers = [...new Set([...group.ignoredUsers, ...numerosPraIgnorar])]; // Set pra evitar duplicados
			await database.saveGroup(group);

			return new ReturnMessage({
				chatId: message.group,
				content: "Você agora será *ignorado* nas menções de grupo.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}
	} catch (error) {
		logger.error("Erro ao alternar status de ignorar:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao atualizar seu status de ignorar. Por favor, tente novamente."
		});
	}
}

/**
 * Apaga a mensagem do bot quando usado em resposta a ela
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|null>} - ReturnMessage ou null
 */
async function apagarMensagem(bot, message, args, group) {
	try {
		// Obtém a mensagem citada
		const quotedMsg = message.originReaction
			? message.origin
			: await message.origin.getQuotedMessage(); // Se veio de uma reaction, considera a própria mensagem
		const quemPediu = message.originReaction ? message.originReaction.senderId : message.author;

		if (!quotedMsg) {
			logger.debug("Comando apagar usado sem mensagem citada");
			return null;
		}

		// Verifica se a mensagem citada é do bot
		const botNumber = bot.client.info.wid._serialized;
		const quotedSender = quotedMsg.author || quotedMsg.from;

		if (quotedSender !== botNumber) {
			logger.info(
				`[apagarMensagem] Mensagem requisitada não é do bot: ${quotedSender} !== ${botNumber}`
			);
			// Se a mensagem não for do bot, verifica se o bot é admin do grupo (e sem quem pediu tb é)
			if (message.group) {
				try {
					// Obtém informações do chat
					const chat = await message.origin.getChat();

					// Verifica se quem pediu é admin
					if (chat.isGroup) {
						const participants = chat.participants || [];
						const quemPediuIsAdmin = await adminUtils.isAdmin(quemPediu, group, chat, bot);

						if (quemPediuIsAdmin) {
							// Bot é admin, pode apagar mensagens de outros
							logger.info(`Tentando apagar mensagem de outro usuário como admin: ${quotedSender}`);
							await quotedMsg.delete(true);

							// Reage com emoji de sucesso
							try {
								await message.origin.react("✅");
							} catch (reactError) {
								logger.error("Erro ao aplicar reação de sucesso:", reactError);
							}

							return null;
						}
					}
				} catch (chatError) {
					logger.error("Erro ao verificar se quem pediu é admin:", chatError);
				}
			}

			// Se chegou aqui, ou não está em grupo ou bot não é admin
			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content:
					"🗑 Só posso apagar minhas próprias mensagens ou mensagens de outros em grupos (e preciso ser admin)"
			});
		}

		// Tenta apagar a mensagem do bot
		try {
			await quotedMsg.delete(true);
			logger.info("Mensagem do bot apagada com sucesso");

			// Reage com emoji de sucesso
			try {
				await message.origin.react("✅");
			} catch (reactError) {
				logger.error("Erro ao aplicar reação de sucesso:", reactError);
			}

			// Apaga também o comando !apagar
			// try {
			//   await message.origin.delete(true);
			// } catch (deleteError) {
			//   logger.error('Erro ao apagar mensagem de comando:', deleteError);
			// }

			return null;
		} catch (error) {
			logger.error("Erro ao apagar mensagem:", error);

			// Reage com emoji de erro
			try {
				await message.origin.react("❌");
			} catch (reactError) {
				logger.error("Erro ao aplicar reação de erro:", reactError);
			}

			// Envia mensagem de erro apenas em grupos (em privado é desnecessário)
			if (message.group) {
				return new ReturnMessage({
					chatId: message.group,
					content: "Não foi possível apagar a mensagem. Verifique se tenho permissões necessárias."
				});
			}
			return null;
		}
	} catch (error) {
		logger.error("Erro geral ao apagar mensagem:", error);
		return null;
	}
}

// Lista de comandos usando a classe Command
const commands = [
	new Command({
		name: "atencao",
		cooldown: 300,
		description: "Menciona todos os membros do grupo",
		category: "grupo",
		group: "attention",
		adminOnly: true,
		reactions: {
			trigger: "📢",
			before: "📢",
			after: "✅"
		},
		method: mentionAllMembers
	}),
	new Command({
		name: "atenção",
		cooldown: 300,
		description: "Menciona todos os membros do grupo",
		category: "grupo",
		group: "attention",
		adminOnly: true,
		hidden: true,
		reactions: {
			trigger: "📢",
			before: "📢",
			after: "✅"
		},
		method: mentionAllMembers
	}),
	new Command({
		name: "atençao",
		cooldown: 300,
		description: "Menciona todos os membros do grupo",
		category: "grupo",
		group: "attention",
		adminOnly: true,
		hidden: true,
		reactions: {
			trigger: "📢",
			before: "📢",
			after: "✅"
		},
		method: mentionAllMembers
	}),
	new Command({
		name: "galera",
		cooldown: 300,
		description: "Menciona todos os membros do grupo",
		category: "grupo",
		group: "attention",
		adminOnly: true,
		reactions: {
			trigger: "📢",
			before: "📢",
			after: "✅"
		},
		method: mentionAllMembers
	}),
	new Command({
		name: "ignorar",
		cooldown: 0,
		description: "Alterna ser ignorado pelas menções de grupo",
		category: "grupo",
		reactions: {
			before: "🔇",
			after: "✅"
		},
		method: toggleIgnore
	}),
	new Command({
		name: "apagar",
		cooldown: 0,
		description: "Apaga a mensagem do bot quando usado em resposta a ela",
		category: "grupo",
		reactions: {
			trigger: "🗑️",
			before: "🗑️",
			after: false
		},
		method: apagarMensagem
	})
];

module.exports = { commands };
