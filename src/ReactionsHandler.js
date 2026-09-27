const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const Logger = require("./utils/Logger");

/**
 * Trata reações a mensagens e executa comandos correspondentes
 */
class ReactionsHandler {
	constructor() {
		this.logger = new Logger("reaction-handler");
		this.reactionCommands = {};
		this.functionsPath = path.join(__dirname, "functions");

		this.loadCommands();
	}

	/**
	 * Carrega todos os comandos que possuem triggers de reação
	 */
	async loadCommands() {
		try {
			// Verifica se o diretório functions existe
			try {
				await fs.access(this.functionsPath);
			} catch (error) {
				this.logger.info("Diretório functions não existe, criando-o");
				await fs.mkdir(this.functionsPath, { recursive: true });
			}

			// Obtém todos os arquivos no diretório functions
			const files = await fs.readdir(this.functionsPath);
			const jsFiles = files.filter((file) => file.endsWith(".js"));

			//this.logger.info(`Encontrados ${jsFiles.length} arquivos de função para verificar reações`);

			const modulosComErro = [];
			// Carrega cada módulo de função
			for (const file of jsFiles) {
				try {
					const commandModule = require(path.join(this.functionsPath, file));

					// Verifica se o módulo exporta comandos
					if (commandModule.commands && Array.isArray(commandModule.commands)) {
						// Processa cada comando para encontrar os que têm triggers de reação
						commandModule.commands.forEach((cmd) => {
							if (cmd.reactions && cmd.reactions.trigger) {
								this.processCommandTriggers(cmd);
							}
						});
					}
				} catch (error) {
					this.logger.error(`Erro ao carregar módulo para reações ${file}:`, error);
					modulosComErro.push(file);
				}
			}

			const numReactionCommands = Object.keys(this.reactionCommands).length;
			//this.logger.info(`Carregados ${numReactionCommands} comandos de reação`);

			if (modulosComErro.length > 0) {
				this.logger.warn(
					`ATENÇÃO: ${modulosComErro.length} módulos com erro:\n ${modulosComErro.join("\n- ")}`
				);
			}
		} catch (error) {
			this.logger.error("Erro ao carregar comandos de reação:", error);
		}
	}

	/**
	 * Processa os triggers de um comando e os adiciona ao mapa de reactionCommands
	 * @param {Command} cmd - O objeto de comando
	 */
	processCommandTriggers(cmd) {
		try {
			const triggers = Array.isArray(cmd.reactions.trigger)
				? cmd.reactions.trigger
				: [cmd.reactions.trigger];

			// Adiciona cada trigger ao mapa
			triggers.forEach((emoji) => {
				if (emoji && typeof emoji === "string") {
					this.reactionCommands[emoji] = cmd.name;
					//this.logger.debug(`Mapeado emoji '${emoji}' para comando ${cmd.name}`);
				}
			});
		} catch (error) {
			this.logger.error(`Erro ao processar triggers do comando ${cmd.name}:`, error);
		}
	}

	/**
	 * Processa uma reação a uma mensagem
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} reaction - Os dados da reação
	 * @returns {Promise<boolean>} - Se a reação foi tratada
	 */
	async processReaction(bot, reaction) {
		try {
			//this.logger.info(`Processando reação: ${reaction.reaction} de ${reaction.senderId} na mensagem ${reaction.msgId._serialized}`);

			// Verifica se este emoji mapeia para um comando
			const commandName = this.reactionCommands[reaction.reaction];
			if (!commandName) {
				//this.logger.debug(`Nenhum comando mapeado para o emoji: ${reaction.reaction}`);
				//console.log(this.reactionCommands);
				return false;
			}

			const msgId = reaction.msgId?._serialized || reaction.msgId;
			let message = null;
			if (bot?.client?.getMessageById) {
				message = await bot.client.getMessageById(msgId);
			}

			if (!message) {
				this.logger.warn(
					`[${bot?.id || "bot"}] Mensagem com ID ${msgId} não encontrada no cache. Construindo fallback sintético para reação '${reaction.reaction}'...`
				);
				message = this.buildFallbackMessage(bot, reaction);
				if (!message) {
					this.logger.warn(
						`Não foi possível encontrar nem construir fallback para mensagem com ID: ${msgId}`
					);
					return false;
				}
			}

			// Cria um objeto de mensagem formatado
			const formattedMessage = message._isFallback ? message : await bot.formatMessage(message);
			formattedMessage.originReaction = reaction; // Para comandos com reactions dinâmicas

			// Encontra e executa o comando
			const command = bot.eventHandler.commandHandler.fixedCommands.getCommand(commandName);
			if (command) {
				// Extrai argumentos do conteúdo da mensagem, se disponível
				const msgText =
					formattedMessage.type === "text" ? formattedMessage.content : formattedMessage.caption;
				const args = msgText ? msgText.trim().split(/\s+/) : [];

				// Obtém dados do grupo
				let group = null;
				if (formattedMessage.group) {
					const groupData = await bot.eventHandler.getOrCreateGroup(formattedMessage.group);
					group = groupData.group;

					// Verifica se o comando específico está mutado
					if (group.mutedCommands && Array.isArray(group.mutedCommands)) {
						if (group.mutedCommands.includes(commandName)) {
							this.logger.debug(
								`Ignorando reação do comando '${commandName}' (${reaction.reaction}), comando silenciado no grupo '${group.name}'`
							);
							return false;
						}
					}

					if (group.paused) {
						// Se o grupo estiver pausado, ignora a reação
						this.logger.info(`Ignorando reação em grupo pausado: ${formattedMessage.group}`);
						return false;
					}
				}

				this.logger.info(`Executando comando ${commandName} via reação ${reaction.reaction}`);

				// Executa o comando
				await bot.eventHandler.commandHandler.executeFixedCommand(
					bot,
					formattedMessage,
					command,
					args,
					group
				);
				return true;
			} else {
				this.logger.warn(
					`Comando ${commandName} mapeado do emoji ${reaction.reaction} não encontrado`
				);
			}

			return false;
		} catch (error) {
			this.logger.error("Erro ao processar reação:", error);
			return false;
		}
	}

	/**
	 * Constrói uma mensagem sintética de fallback quando a mensagem original
	 * não está no cache (pós reinício do bot ou expiração do TTL).
	 * @param {WhatsAppBot} bot
	 * @param {Object} reaction
	 * @returns {Object|null}
	 */
	buildFallbackMessage(bot, reaction) {
		try {
			const stanzaId = reaction.msgId?._serialized || reaction.msgId;
			if (!stanzaId) return null;

			const chatId = reaction.chatId || reaction.key?.remoteJID || reaction.key?.remoteJid || null;
			const isGroup = Boolean(chatId && chatId.includes("@g.us"));
			const fromMe = Boolean(reaction.targetFromMe ?? reaction.key?.fromMe);
			const author =
				reaction.targetAuthor ||
				reaction.key?.participant ||
				(fromMe ? (bot?.phoneNumber ? `${bot.phoneNumber}@s.whatsapp.net` : bot?.id) : chatId);

			// Tenta recuperar o ID da figurinha do Lovecell caso tenha sido registrado
			let stickerId = null;
			try {
				const StickerScraper = require("./functions/StickerScraper");
				stickerId = StickerScraper.getStickerIdByMessageId(stanzaId);
			} catch {
				// Módulo pode não estar carregado ainda
			}

			const isStickerReaction =
				Boolean(stickerId) || ["🔞", "\u{1F51E}", "‼️", "\u203C"].includes(reaction.reaction);

			const type = isStickerReaction ? "sticker" : "unknown";
			const mediaInfo = isStickerReaction
				? {
						mimetype: "image/webp",
						filename: stickerId ? `figs_lovecell_${stickerId}.webp` : "sticker.webp"
					}
				: null;

			const fallbackMessage = {
				_isFallback: true,
				id: stanzaId,
				fromMe,
				group: isGroup ? chatId : null,
				from: isGroup ? chatId : author,
				author,
				authorAlt: "",
				name: "Usuario",
				pushname: "Usuario",
				authorName: "Usuario",
				type,
				content: mediaInfo || "",
				body: mediaInfo || "",
				caption: null,
				timestamp: Math.floor(Date.now() / 1000),
				hasMedia: Boolean(mediaInfo),
				mentions: [],
				quotedParticipant: null,
				hasQuotedMsg: false,
				quotedMessageId: null,
				isQuoted: false,
				isNewsletter: Boolean(chatId && chatId.includes("newsletter")),
				downloadMedia: async () => {
					if (stickerId) {
						try {
							const StickerScraper = require("./functions/StickerScraper");
							const filePath = StickerScraper.getStickerFilePath(stickerId);
							if (fsSync.existsSync(filePath)) {
								const buf = await fs.readFile(filePath);
								return {
									mimetype: "image/webp",
									data: buf.toString("base64"),
									filename: `figs_lovecell_${stickerId}.webp`,
									isMessageMedia: true
								};
							}
						} catch (downloadErr) {
							this.logger.debug(
								`[buildFallbackMessage] Erro ao carregar arquivo de figurinha local: ${downloadErr.message}`
							);
						}
					}
					return null;
				},
				delete: async () => {
					if (chatId && typeof bot?.deleteMessageByKey === "function") {
						return await bot.deleteMessageByKey({
							remoteJid: chatId,
							id: stanzaId,
							fromMe,
							participant: reaction.targetAuthor || reaction.key?.participant
						});
					}
					return false;
				},
				origin: {
					mentionedIds: [],
					id: {
						_serialized: `${chatId}_${fromMe}_${stanzaId}`,
						fromMe,
						remote: chatId,
						id: stanzaId,
						_serialized_v3: stanzaId
					},
					key: {
						remoteJid: chatId,
						fromMe,
						id: stanzaId,
						participant: reaction.targetAuthor || reaction.key?.participant
					},
					author,
					from: isGroup ? chatId : author,
					react: (emoji) => {
						if (chatId && typeof bot?.sendReaction === "function") {
							return bot.sendReaction(chatId, stanzaId, emoji);
						}
					},
					delete: async () => {
						if (chatId && typeof bot?.deleteMessageByKey === "function") {
							return await bot.deleteMessageByKey({
								remoteJid: chatId,
								id: stanzaId,
								fromMe,
								participant: reaction.targetAuthor || reaction.key?.participant
							});
						}
						return false;
					},
					body: mediaInfo || ""
				}
			};

			return fallbackMessage;
		} catch (error) {
			this.logger.error("Erro ao construir fallback de mensagem na reação:", error);
			return null;
		}
	}
}

module.exports = ReactionsHandler;
