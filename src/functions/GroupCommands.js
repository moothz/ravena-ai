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
		const isBotMsg = adminUtils._normalizeId(quotedSender) === adminUtils._normalizeId(botNumber);

		// 1. Verificar se o usuário tem permissão para apagar
		let temPermissao = false;
		const normalizedQuemPediu = adminUtils._normalizeId(quemPediu);
		const normalizedQuotedSender = adminUtils._normalizeId(quotedSender);

		// A. É admin?
		if (message.group) {
			const chat = await message.origin.getChat();
			if (chat.isGroup) {
				temPermissao = await adminUtils.isAdmin(quemPediu, group, chat, bot);
			}
		} else if (isBotMsg) {
			// No PV, permite apagar se for mensagem do bot
			temPermissao = true;
		}

		// B. É a própria mensagem de quem pediu?
		if (!temPermissao) {
			if (normalizedQuemPediu === normalizedQuotedSender) {
				temPermissao = true;
			}
		}

		// C. Está mencionado ou é o autor citado? (Apenas permitido para mensagens do bot)
		if (!temPermissao && isBotMsg) {
			// Mentions
			const mentions = quotedMsg.mentions || quotedMsg.mentionedIds || [];
			if (mentions.some((m) => adminUtils._normalizeId(m) === normalizedQuemPediu)) {
				temPermissao = true;
			}

			// Quoted Participant (se a msg do bot cita o usuário)
			if (!temPermissao) {
				const quotedParticipant = quotedMsg.quotedParticipant;
				if (
					quotedParticipant &&
					adminUtils._normalizeId(quotedParticipant) === normalizedQuemPediu
				) {
					temPermissao = true;
				}
			}
		}

		if (!temPermissao) {
			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content:
					"🗑 Você não tem permissão para apagar esta mensagem. Você precisa ser admin, ou a mensagem deve ser sua, ou deve ser uma mensagem do bot que menciona você."
			});
		}

		// 2. Tentar apagar
		try {
			await quotedMsg.delete(true);
			logger.info(`Mensagem apagada com sucesso por solicitação de ${quemPediu}`);

			// Reage com emoji de sucesso
			try {
				await message.origin.react("✅");
			} catch (reactError) {
				logger.error("Erro ao aplicar reação de sucesso:", reactError);
			}
			return null;
		} catch (error) {
			logger.error("Erro ao apagar mensagem:", error);

			// Se não conseguiu apagar e não é mensagem do bot, provavelmente falta permissão de admin para o bot
			if (!isBotMsg && message.group) {
				return new ReturnMessage({
					chatId: message.group,
					content:
						"Não foi possível apagar a mensagem. Verifique se o bot é admin do grupo (necessário para apagar mensagens de terceiros)."
				});
			}

			// Reage com emoji de erro
			try {
				await message.origin.react("❌");
			} catch (reactError) {
				logger.error("Erro ao aplicar reação de erro:", reactError);
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
