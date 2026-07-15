const StreamMonitor = require("./services/StreamMonitor");
const Logger = require("./utils/Logger");
const LLMService = require("./services/LLMService");
const ReturnMessage = require("./models/ReturnMessage");
const path = require("path");
const fs = require("fs").promises;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const Database = require("./utils/Database");

/**
 * Sistema para gerenciamento de monitoramento de streams (Singleton)
 */
class StreamSystem {
	static instance = null;

	/**
	 * Obtém a instância do StreamSystem
	 * @returns {StreamSystem}
	 */
	static getInstance() {
		if (!StreamSystem.instance) {
			StreamSystem.instance = new StreamSystem();
		}
		return StreamSystem.instance;
	}

	constructor() {
		if (StreamSystem.instance) return StreamSystem.instance;

		this.bots = [];
		this.logger = new Logger("stream-system");
		this.llmService = LLMService.getInstance();
		this.streamMonitor = null;
		this.database = Database.getInstance();
		// Assume que o path do banco é o mesmo pra todos (global)
		this.dataPath = this.database.databasePath;
		this.mediaPath = path.join(this.dataPath, "media");
		this.initialized = false;
		this.initializing = false;
		this.initTimeout = null;
		this.debugNotificacoes = false;

		StreamSystem.instance = this;
	}

	/**
	 * Registra um bot no sistema
	 * @param {Object} bot
	 */
	registerBot(bot) {
		if (!this.bots.some((b) => b.id === bot.id)) {
			this.bots.push(bot);
			// Disponibiliza o streamMonitor para o bot (se já existir)
			if (this.streamMonitor) {
				bot.streamMonitor = this.streamMonitor;
			}
			//this.logger.info(`Bot registrado no sistema de streams: ${bot.id}`);
		}
	}

	/**
	 * Inicializa o sistema de monitoramento
	 */
	async initialize(force = false) {
		if (this.initialized) return true;

		if (this.initializing && !force) return;

		if (!force) {
			if (this.initTimeout) return; // already scheduled

			this.initializing = true;
			this.logger.info(
				"Agendando inicialização do sistema de monitoramento de streams para 3 minutos após o bot iniciar totalmente..."
			);
			this.initTimeout = setTimeout(() => {
				this.initTimeout = null;
				this.initialize(true);
			}, 180000); // 3 minutes
			return;
		}

		if (this.initTimeout) {
			clearTimeout(this.initTimeout);
			this.initTimeout = null;
		}

		try {
			this.initializing = true;
			// Obtém a instância compartilhada do StreamMonitor
			// Usa o número de bots registrados ou padrão 50 para max listeners
			this.streamMonitor = StreamMonitor.getInstance(
				[],
				this.bots.length > 0 ? this.bots.length * 10 : 50
			);

			// Registra manipuladores de eventos
			this.registerEventHandlers();

			// Carrega canais para monitorar
			await this.loadChannelsToMonitor(false);

			// Inicia o monitoramento
			if (!this.streamMonitor.isMonitoring) {
				this.streamMonitor.startMonitoring();
			}

			// Atualiza referência do monitor nos bots
			this.bots.forEach((bot) => {
				bot.streamMonitor = this.streamMonitor;
			});

			this.initialized = true;
			this.initializing = false;
			this.logger.info("Sistema de monitoramento de streams inicializado (Singleton)");
			return true;
		} catch (error) {
			this.initializing = false;
			this.logger.error("Erro ao inicializar sistema de monitoramento de streams:", error);
			return false;
		}
	}

	/**
	 * Registra manipuladores de eventos
	 */
	registerEventHandlers() {
		// Evento de stream online
		this.streamMonitor.on("streamOnline", async (data) => {
			try {
				this.logger.info(`Evento de stream online: ${data.platform}/${data.channelName}`);
				await this.handleStreamOnline(data);
			} catch (error) {
				this.logger.error(`Erro ao processar evento de stream online:`, error);
			}
		});

		// Evento de stream offline
		this.streamMonitor.on("streamOffline", async (data) => {
			try {
				this.logger.info(`Evento de stream offline: ${data.platform}/${data.channelName}`);
				await this.handleStreamOffline(data);
			} catch (error) {
				this.logger.error(`Erro ao processar evento de stream offline:`, error);
			}
		});

		// Evento de novo vídeo
		this.streamMonitor.on("newVideo", async (data) => {
			try {
				this.logger.info(`Evento de novo vídeo: ${data.platform}/${data.channelName}`);
				await this.handleNewVideo(data);
			} catch (error) {
				this.logger.error(`Erro ao processar evento de novo vídeo:`, error);
			}
		});

		// Evento de canal não encontrado
		this.streamMonitor.on("channelNotFound", async (data) => {
			try {
				this.logger.info(
					`Evento de canal não encontrado: ${data.platform}/${data.channelName} (status: ${data.channelStatus ?? "unknown"})`
				);

				// Envia mensagem para o grupo (usando o primeiro bot capaz)
				if (data.groupId) {
					const bot = await this.findBotForGroup(data.groupId);
					if (bot) {
						const platformName =
							data.platform === "youtube"
								? "YouTube"
								: data.platform === "twitch"
									? "Twitch"
									: "Kick";

						// Monta o link público do canal
						let channelLink = "";
						if (data.platform === "twitch") {
							channelLink = `https://www.twitch.tv/${data.channelName}`;
						} else if (data.platform === "kick") {
							channelLink = `https://kick.com/${data.channelName}`;
						} else if (data.platform === "youtube") {
							channelLink = `https://www.youtube.com/@${data.channelName}`;
						}

						// Personaliza a mensagem com base no status detectado
						let motivoTexto;
						if (data.channelStatus === "banned") {
							motivoTexto = `⛔ O canal parece estar *suspenso/banido* pela plataforma por violação dos Termos de Serviço ou Diretrizes da Comunidade.`;
						} else if (data.channelStatus === "deleted") {
							motivoTexto = `❌ O canal parece ter sido *deletado ou trocou de nome*.`;
						} else {
							motivoTexto = `⚠️ O canal apresentou erros consecutivos de "não encontrado". *Verifique se o nome está correto.*`;
						}

						const linkTexto = channelLink ? `\n🔗 ${channelLink}` : "";

						const msgAviso = `⚠️ *Canal Temporariamente Pausado*\n\nO canal *${data.channelName}* (${platformName}) foi pausado por 12 horas.${linkTexto}\n\n${motivoTexto}\n\n> O monitoramento será reativado automaticamente após esse período.\n\n\`${data.groupName || data.groupId}\``;

						bot.sendMessage(data.groupId, msgAviso);
						bot.sendMessage(bot.grupoLogs, msgAviso);
					}
				}
			} catch (error) {
				this.logger.error(`Erro ao processar evento de canal não encontrado:`, error);
			}
		});
	}

	/**
	 * Encontra o primeiro bot adequado para enviar mensagem em um grupo
	 * @param {string} groupId
	 * @returns {Promise<Object|null>}
	 */
	async findBotForGroup(groupId) {
		const bots = await this.findBotsForGroup(groupId);
		return bots.length > 0 ? bots[0] : null;
	}

	/**
	 * Encontra bots adequados para enviar mensagem em um grupo
	 * @param {string} groupId
	 * @returns {Promise<Array<Object>>}
	 */
	async findBotsForGroup(groupId) {
		const candidates = [];
		const gidStr = groupId.toString();

		const isWhatsAppGroup = gidStr.includes("@");
		const isTelegramGroup = gidStr.startsWith("-");
		// IDs do Discord são numéricos e longos (geralmente 18+ caracteres)
		const isDiscordGroup = !isWhatsAppGroup && !isTelegramGroup && gidStr.length >= 17;

		// Itera sobre os bots registrados para encontrar os que podem participar do grupo
		for (const bot of this.bots) {
			try {
				// Verifica compatibilidade de plataforma
				if (bot.useTelegram) {
					// Bot Telegram não pode enviar para grupo WhatsApp ou Discord
					if (isWhatsAppGroup || isDiscordGroup) continue;
				} else if (bot.useDiscord) {
					// Bot Discord não pode enviar para WhatsApp ou Telegram
					if (isWhatsAppGroup || isTelegramGroup) continue;
				} else {
					// Bot WhatsApp não pode enviar para Telegram ou Discord (que não tem @)
					if (!isWhatsAppGroup) continue;
				}

				// Verifica flag se o bot já foi marcado como não estando no grupo
				if (bot.skipGroupInfo?.includes(groupId)) continue;

				// Adiciona como candidato. A verificação real de "está no grupo"
				// será feita ao tentar enviar a mensagem, pois checkar antes é custoso/impreciso
				candidates.push(bot);
			} catch (e) {
				// Ignora erro
			}
		}
		return candidates;
	}

	/**
	 * Carrega canais para monitorar a partir dos grupos cadastrados
	 * @param {boolean} cleanup - Se deve verificar e remover canais inexistentes (default: false)
	 */
	async loadChannelsToMonitor(cleanup = false) {
		try {
			// Obtém todos os grupos do banco global
			const groups = await this.database.getGroups();

			const subscribedChannels = {
				twitch: [],
				kick: [],
				youtube: []
			};

			const now = new Date();

			// Processa cada grupo
			for (const group of groups) {
				let groupModified = false;
				const platforms = ["twitch", "kick", "youtube"];

				for (const platform of platforms) {
					if (group[platform] && Array.isArray(group[platform])) {
						const channelsToRemove = [];

						for (const channelConfig of group[platform]) {
							// Verifica se o canal está pausado
							if (channelConfig.pausedUntil) {
								if (new Date(channelConfig.pausedUntil) > now) {
									// Pausado, pula o monitoramento
									continue;
								} else {
									// Pausa expirada, reativa
									this.logger.info(
										`Reativando canal ${platform}/${channelConfig.channel} no grupo ${group.id} (pausa expirada no carregamento)`
									);
									delete channelConfig.pausedUntil;
									delete channelConfig.pausedReason;
									groupModified = true;
								}
							}

							// Caso específico de limpeza da Twitch
							if (platform === "twitch") {
								if (
									(!channelConfig.channel.startsWith("xxx_") &&
										!channelConfig.channel.includes("twitchtv")) ||
									!channelConfig.channel.includes("twitch.tv")
								) {
									if (cleanup && this.streamMonitor) {
										const channelExists = await this.streamMonitor.twitchChannelExists(
											channelConfig.channel
										);
										if (!channelExists) {
											channelsToRemove.push(channelConfig.channel.toLowerCase());
											continue;
										}
										await sleep(500);
									}

									if (!subscribedChannels.twitch.includes(channelConfig.channel)) {
										this.streamMonitor.subscribe(channelConfig.channel, "twitch");
										subscribedChannels.twitch.push(channelConfig.channel);
									}
								}
							} else {
								// Kick e YouTube
								if (!subscribedChannels[platform].includes(channelConfig.channel)) {
									this.streamMonitor.subscribe(channelConfig.channel, platform);
									subscribedChannels[platform].push(channelConfig.channel);
								}
							}
						}

						if (cleanup && platform === "twitch" && channelsToRemove.length > 0) {
							group.twitch = group.twitch.filter(
								(c) => !channelsToRemove.includes(c.channel.toLowerCase())
							);
							groupModified = true;
						}
					}
				}

				if (groupModified) {
					await this.database.saveGroup(group);
				}
			}

			this.logger.info(
				`Carregados para monitoramento: ${subscribedChannels.twitch.length} canais Twitch, ${subscribedChannels.kick.length} canais Kick e ${subscribedChannels.youtube.length} canais YouTube`
			);
		} catch (error) {
			this.logger.error("Erro ao carregar canais para monitorar:", error);
		}
	}

	/**
	 * Manipula evento de stream online
	 * @param {Object} data - Dados do evento
	 */
	async handleStreamOnline(data) {
		try {
			const groups = await this.database.getGroups();

			for (const groupData of groups) {
				if (!groupData[data.platform]) continue;

				const channelConfig = groupData[data.platform].find(
					(c) => c.channel.toLowerCase() === data.channelName.toLowerCase()
				);

				if (!channelConfig) continue;

				await this.processStreamEvent(groupData, channelConfig, data, "online");
			}
		} catch (error) {
			this.logger.error("Erro ao manipular evento de stream online:", error);
		}
	}

	/**
	 * Manipula evento de stream offline
	 * @param {Object} data - Dados do evento
	 */
	async handleStreamOffline(data) {
		try {
			const groups = await this.database.getGroups();

			for (const groupData of groups) {
				if (!groupData[data.platform]) continue;

				const channelConfig = groupData[data.platform].find(
					(c) => c.channel.toLowerCase() === data.channelName.toLowerCase()
				);

				if (!channelConfig) continue;

				await this.processStreamEvent(groupData, channelConfig, data, "offline");
			}
		} catch (error) {
			this.logger.error("Erro ao manipular evento de stream offline:", error);
		}
	}

	/**
	 * Manipula evento de novo vídeo
	 * @param {Object} data - Dados do evento
	 */
	async handleNewVideo(data) {
		try {
			const groups = await this.database.getGroups();

			for (const groupData of groups) {
				if (!groupData.youtube) continue;

				const channelConfig = groupData.youtube.find(
					(c) => c.channel.toLowerCase() === data.channelName.toLowerCase()
				);

				if (!channelConfig) continue;

				await this.processStreamEvent(groupData, channelConfig, data, "online");
			}
		} catch (error) {
			this.logger.error("Erro ao manipular evento de novo vídeo:", error);
		}
	}

	/**
	 * Processa notificação de evento de stream para um grupo
	 * @param {Object} group - Dados do grupo
	 * @param {Object} channelConfig - Configuração do canal
	 * @param {Object} eventData - Dados do evento
	 * @param {string} eventType - Tipo de evento ('online' ou 'offline')
	 */
	async processStreamEvent(group, channelConfig, eventData, eventType) {
		try {
			if (group.paused) return;

			// Encontra bots candidatos
			const bots = await this.findBotsForGroup(group.id);

			if (bots.length === 0) {
				// Nenhum bot disponível para este grupo (todos ignoraram ou nenhum registrado)
				return;
			}

			// Obtém a configuração apropriada
			const config = eventType === "online" ? channelConfig.onConfig : channelConfig.offConfig;

			// Tenta enviar com cada bot candidato até conseguir
			let sentSuccess = false;
			let titleChanged = false;
			const notInGroupErrors = [];

			for (const bot of bots) {
				try {
					const returnMessages = [];

					// Processa alteração de título (se habilitada)
					if (channelConfig.changeTitleOnEvent && !titleChanged) {
						this.logger.debug(`[processStreamEvent] ${group.name} -> changeTitleOnEvent 'true'`);
						titleChanged = await this.changeGroupTitleForStream(
							bot,
							group,
							channelConfig,
							eventData,
							eventType
						);
					}

					// Obter menções
					let mentions = [];
					if (channelConfig.mentionAllMembers && eventType === "online") {
						mentions = await this.getAllMembersMentions(bot, group.id);
					}

					// Gera mensagens de mídia
					if (config && config.media) {
						for (const mediaItem of config.media) {
							const returnMessage = await this.createEventNotification(
								bot,
								group,
								mediaItem,
								eventData,
								channelConfig,
								mentions
							);
							if (returnMessage) {
								returnMessages.push(returnMessage);
							}
						}
					}

					// Gera mensagem de IA
					if (channelConfig.useAI && eventType === "online") {
						const aiMessage = await this.createAINotification(bot, group, eventData, channelConfig);
						if (aiMessage) {
							returnMessages.push(aiMessage);
						}
					}

					// Tenta enviar
					if (returnMessages.length > 0) {
						const resultados = await bot.sendReturnMessages(returnMessages);

						// Verifica se houve erro de envio específico de "não está no grupo"
						let botNotInGroupError = false;

						for (const res of resultados) {
							if (res && res.error) {
								const err = res.error;
								// Coleta todas as possíveis strings de erro (mensagem, data.error, response.data.error)
								const errorDetails = [
									err.message,
									err.data?.error,
									err.response?.data?.error,
									typeof err === "string" ? err : null
								]
									.filter((s) => typeof s === "string")
									.join(" ")
									.toLowerCase();

								if (
									errorDetails.includes("not participating") ||
									errorDetails.includes("not_participating") ||
									errorDetails.includes("no longer a participant") ||
									errorDetails.includes("not in group")
								) {
									botNotInGroupError = true;
									break;
								}
							}
						}

						if (botNotInGroupError) {
							this.logger.warn(`Bot ${bot.id} não está no grupo ${group.id}, marcando para pular.`);
							if (bot.addSkipGroup) {
								await bot.addSkipGroup(group.id);
							}
							notInGroupErrors.push(bot.id);
							continue; // Tenta próximo bot
						}

						// Sucesso no envio das mensagens!
						sentSuccess = true;
						this.logger.info(
							`Notificação de ${eventData.platform}/${eventData.channelName} enviada para ${group.name} (${group.id}) via ${bot.id}`
						);

						if (this.debugNotificacoes && bot.grupoLogs) {
							await bot.sendMessage(
								bot.grupoLogs,
								`✅ [DEBUG][StreamSystem] Notificação enviada para ${group.name} via ${bot.id}`
							);
						}
						break; // Sai do loop de bots
					} else {
						// Nenhuma mensagem gerada.
						// Se era pra mudar o título e conseguimos (ou não era pra mudar), consideramos sucesso.
						if (!channelConfig.changeTitleOnEvent || titleChanged) {
							sentSuccess = true;
							break;
						}
						// Se falhou em mudar o título e não tinha mensagens, continua tentando com o próximo bot
					}
				} catch (err) {
					this.logger.error(`Erro ao tentar enviar com bot ${bot.id} para grupo ${group.id}:`, err);
					const errorDetails = [
						err.message,
						err.data?.error,
						err.response?.data?.error,
						typeof err === "string" ? err : null
					]
						.filter((s) => typeof s === "string")
						.join(" ")
						.toLowerCase();

					if (
						errorDetails.includes("not participating") ||
						errorDetails.includes("not_participating") ||
						errorDetails.includes("no longer a participant") ||
						errorDetails.includes("not in group")
					) {
						if (bot.addSkipGroup) await bot.addSkipGroup(group.id);
						notInGroupErrors.push(bot.id);
					}
					// Continua para o próximo bot
				}
			}

			// Se todos os bots falharam por não estarem no grupo
			if (!sentSuccess && notInGroupErrors.length === bots.length) {
				this.logger.warn(
					`Nenhum bot conseguiu enviar mensagem para o grupo ${group.id} (todos removidos/sem permissão).`
				);
				// Opcional: Pausar o grupo ou marcar algo no DB global
			}
		} catch (error) {
			this.logger.error(`Erro ao processar evento de stream para ${group.id}:`, error);
		}
	}

	/**
	 * Obtém as menções para todos os membros do grupo
	 */
	async getAllMembersMentions(bot, groupId) {
		try {
			const group = await this.database.getGroup(groupId);
			if (!group) return [];

			const chat = await bot.client.getChatById(groupId);
			if (!chat || !chat.isGroup) return [];

			const ignoredUsers = group.ignoredUsers ?? [];

			const participants = chat.participants.filter((participant) => {
				const userIdentifiers = [
					participant.id?._serialized,
					participant.lid,
					participant.phoneNumber
				];
				const isIgnored = userIdentifiers.some(
					(id) => id && ignoredUsers.some((iU) => id.startsWith(iU))
				);
				return !isIgnored;
			});

			return participants.map((p) => p.id._serialized);
		} catch (error) {
			return [];
		}
	}

	substituirEmojis(str, mode) {
		const mapToGreen = {
			"🔴": "🟢",
			"❤️": "💚",
			"🌹": "🍏",
			"🟥": "🟩",
			"🟢": "🟢",
			"💚": "💚",
			"🍏": "🍏",
			"🟩": "🟩"
		};

		const mapToRed = {
			"🟢": "🔴",
			"💚": "❤️",
			"🍏": "🌹",
			"🟩": "🟥",
			"🔴": "🔴",
			"❤️": "❤️",
			"🌹": "🌹",
			"🟥": "🟥"
		};

		const targetMap = mode === "online" ? mapToGreen : mapToRed;

		let resultado = "";
		const caracteres = Array.from(str);

		for (let i = 0; i < caracteres.length; i++) {
			let emoji = caracteres[i];
			if (i + 1 < caracteres.length && caracteres[i + 1] === "️") {
				emoji = emoji + caracteres[i + 1];
				i++;
			}
			if (targetMap[emoji]) {
				resultado += targetMap[emoji];
			} else {
				resultado += emoji;
			}
		}
		return resultado;
	}

	/**
	 * Altera o título e a foto do grupo
	 */
	async changeGroupTitleForStream(bot, group, channelConfig, eventData, eventType) {
		try {
			const chat = await bot.client.getChatById(group.id);
			if (!chat || !chat.isGroup) {
				//this.logger.debug(`Bot ${bot.id} não conseguiu obter chat para ${group.id}`);
				return false;
			}

			if (chat.notInGroup) {
				this.logger.debug(
					`Bot ${bot.id} não está no grupo ${group.id}, ignorando mudança de título.`
				);
				return false;
			}

			let success = true;

			if (channelConfig.changeTitleOnEvent) {
				let newTitle;
				if (eventType === "online" && channelConfig.onlineTitle) {
					newTitle = channelConfig.onlineTitle;
				} else if (eventType === "offline" && channelConfig.offlineTitle) {
					newTitle = channelConfig.offlineTitle;
				} else {
					newTitle = chat.name;

					const matchCase = (text, pattern) => {
						if (pattern === pattern.toUpperCase()) return text.toUpperCase();
						if (pattern === pattern.toLowerCase()) return text.toLowerCase();
						if (pattern[0] === pattern[0].toUpperCase())
							return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
						return text;
					};

					if (eventType === "online") {
						newTitle = newTitle.replace(/\b(offline|off)\b/gi, (match) => {
							const replacement = match.toLowerCase() === "offline" ? "online" : "on";
							return matchCase(replacement, match);
						});
					} else {
						newTitle = newTitle.replace(/\b(online|on)\b/gi, (match) => {
							const replacement = match.toLowerCase() === "online" ? "offline" : "off";
							return matchCase(replacement, match);
						});
					}
					newTitle = this.substituirEmojis(newTitle, eventType);
				}

				try {
					if (chat.name === newTitle) {
						this.logger.debug(`[changeGroupTitleForStream] Título já está correto: ${newTitle}`);
					} else if (typeof chat.setSubject === "function") {
						this.logger.debug(`[changeGroupTitleForStream] Result ${group.name} -> '${newTitle}'`);
						await chat.setSubject(newTitle);
					} else {
						this.logger.warn(`Bot ${bot.id} não possui método setSubject para o grupo ${group.id}`);
						success = false;
					}
				} catch (titleError) {
					this.logger.error(`Erro ao alterar título do grupo ${group.id}:`, titleError);
					success = false;
				}
			}

			// Mudança de foto (simplificado, mantendo lógica original)
			if (eventType === "online" && channelConfig.groupPhotoOnline) {
				await this.changeGroupPhoto(bot, chat, channelConfig.groupPhotoOnline);
			} else if (eventType === "offline" && channelConfig.groupPhotoOffline) {
				await this.changeGroupPhoto(bot, chat, channelConfig.groupPhotoOffline);
			}

			return success;
		} catch (error) {
			this.logger.error(
				`Erro ao alterar título/foto do grupo ${group.id} via bot ${bot.id}:`,
				error
			);
			return false;
		}
	}

	async changeGroupPhoto(bot, chat, photoData) {
		try {
			if (typeof photoData === "string") {
				// É um nome de arquivo (URL da pasta data)
				const mediaPath = path.join(this.mediaPath, photoData);
				const media = await bot.createMedia(mediaPath);
				await chat.setPicture(media);
			} else if (photoData && photoData.data && photoData.mimetype) {
				// Legacy object, não deveria existir mais, mas aqui amamos fallbacks
				const media = await bot.createMediaFromBase64(
					photoData.data,
					photoData.mimetype,
					`fotoGrupo.jpg`
				);
				await chat.setPicture(media);
			}
		} catch (e) {
			this.logger.error(`Erro ao alterar foto do grupo ${chat.id._serialized}:`, e);
		}
	}

	/**
	 * Cria notificação de evento
	 */
	async createEventNotification(bot, group, mediaItem, eventData, channelConfig, mentions = []) {
		try {
			// Lógica de substituição de variáveis
			const replaceVars = (text) => {
				if (!text) return "";
				let content = text;
				if (eventData.platform === "twitch" || eventData.platform === "kick") {
					content = content
						.replace(/{nomeCanal}/g, eventData.channelName)
						.replace(/{titulo}/g, eventData.title ?? "")
						.replace(/{jogo}/g, eventData.game ?? "Unknown");
				} else if (eventData.platform === "youtube") {
					content = content
						.replace(/{author}/g, eventData.author ?? eventData.channelName)
						.replace(/{title}/g, eventData.title ?? "")
						.replace(/{link}/g, eventData.url ?? "");
				}
				return content;
			};

			if (mediaItem.type === "text") {
				const content = replaceVars(mediaItem.content);

				if (
					channelConfig.useThumbnail &&
					eventData.thumbnail &&
					eventData.thumbnail?.includes("https")
				) {
					const media = await bot.createMediaFromURL(eventData.thumbnail);
					return new ReturnMessage({
						chatId: group.id,
						content: media,
						options: {
							caption: content,
							mentions: mentions.length > 0 ? mentions : undefined
						}
					});
				} else {
					return new ReturnMessage({
						chatId: group.id,
						content,
						options: {
							mentions: mentions.length > 0 ? mentions : undefined
						}
					});
				}
			} else if (["image", "video", "gif", "audio", "sticker"].includes(mediaItem.type)) {
				const mediaPath = path.join(this.mediaPath, mediaItem.content);
				try {
					const media = mediaItem.content.startsWith("http")
						? mediaItem.content
						: await bot.createMedia(mediaPath);

					const caption = replaceVars(mediaItem.caption ?? "");

					return new ReturnMessage({
						chatId: group.id,
						content: media,
						options: {
							caption: caption ?? undefined,
							sendMediaAsSticker: mediaItem.type === "sticker",
							sendVideoAsGif: mediaItem.type === "gif",
							mentions: mentions.length > 0 ? mentions : undefined
						}
					});
				} catch (error) {
					this.logger.error(`Erro ao enviar notificação de mídia (${mediaPath}):`, error);
					return null;
				}
			}
			return null;
		} catch (error) {
			this.logger.error(`Erro ao criar notificação de evento para ${group.id}:`, error);
			return null;
		}
	}

	/**
	 * Cria notificação IA
	 */
	async createAINotification(bot, group, eventData, channelConfig) {
		try {
			const customPersonalidade =
				group?.customAIPrompt && group?.customAIPrompt?.length > 0
					? `\n\n((Sua personalidade: '${group.customAIPrompt}'))\n\n`
					: "";

			let prompt = "";
			const streamLink =
				eventData.platform === "twitch"
					? `https://twitch.tv/${eventData.channelName}`
					: `https://kick.com/${eventData.channelName}`;
			if (eventData.platform === "twitch" || eventData.platform === "kick") {
				prompt = `O canal ${eventData.channelName} ficou online e está jogando ${eventData.game ?? "um jogo"} com o título "${eventData.title ?? ""}". Gere uma mensagem animada para convidar a galera do grupo a participar da stream. Você deve incluir o link da stream: ${streamLink}${customPersonalidade}`;
			} else if (eventData.platform === "youtube") {
				prompt = `O canal ${eventData.channelName} lançou vídeo novo: "${eventData.title ?? ""}". Gere convite animado. Você deve incluir o link do canal: https://youtube.com/${eventData.channelName}${customPersonalidade}`;
			}

			const aiResponse = await this.llmService.getCompletion({ prompt, priority: 3 });
			if (aiResponse) {
				return new ReturnMessage({
					chatId: group.id,
					content: aiResponse,
					delay: 500
				});
			}
			return null;
		} catch (error) {
			this.logger.error(`Erro ao criar notificação IA para ${group.id}:`, error);
			return null;
		}
	}

	/**
	 * Adiciona canal (wrappers para o Monitor)
	 */
	subscribe(channel, platform) {
		if (!this.streamMonitor) return false;
		return this.streamMonitor.subscribe(channel, platform);
	}

	unsubscribe(channel, platform) {
		if (!this.streamMonitor) return false;
		return this.streamMonitor.unsubscribe(channel, platform);
	}

	/**
	 * Reseta o status de bots para um grupo específico
	 * @param {Object|string} groupOrId - Objeto de grupo ou ID do grupo
	 */
	async refreshGroup(groupOrId) {
		const groupId = typeof groupOrId === "string" ? groupOrId : groupOrId.id;
		const group = typeof groupOrId === "object" ? groupOrId : await this.database.getGroup(groupId);

		if (!group) return;

		// Limpa blacklist local do grupo
		group.botNotInGroup = [];
		await this.database.saveGroup(group);

		// Remove de todos os bots registrados
		for (const bot of this.bots) {
			if (bot.removeSkipGroup) {
				await bot.removeSkipGroup(groupId);
			}
		}
	}

	/**
	 * Reseta o status de bots para TODOS os grupos cadastrados
	 * Útil para manutenções globais ou migrações de bots
	 */
	async refreshAllGroups() {
		try {
			const groups = await this.database.getGroups();
			this.logger.info(`Iniciando refresh global de streams para ${groups.length} grupos.`);

			for (const group of groups) {
				// Limpa blacklist local do grupo
				group.botNotInGroup = [];
				await this.database.saveGroup(group);

				// Remove o ID deste grupo de todos os bots registrados
				for (const bot of this.bots) {
					if (bot.removeSkipGroup) {
						await bot.removeSkipGroup(group.id);
					}
				}
			}

			this.logger.info("Refresh global de streams concluído com sucesso.");
		} catch (error) {
			this.logger.error("Erro no refresh global de grupos:", error);
			throw error;
		}
	}

	destroy() {
		this.streamMonitor = null;
		this.bots = [];
	}
}

module.exports = StreamSystem;
