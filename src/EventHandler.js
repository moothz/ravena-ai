const CommandHandler = require("./CommandHandler");
const Database = require("./utils/Database");
const Group = require("./models/Group");
const Logger = require("./utils/Logger");
const AdminUtils = require("./utils/AdminUtils");
const CustomVariableProcessor = require("./utils/CustomVariableProcessor");
const LLMService = require("./services/LLMService");
const SpeechCommands = require("./functions/SpeechCommands");
const { aiCommand } = require("./functions/AICommands");
const SummaryCommands = require("./functions/SummaryCommands");
const { PermissionsBitField } = require("discord.js");
const NSFWPredict = require("./utils/NSFWPredict");
const MuNewsCommands = require("./functions/MuNewsCommands");
const HoroscopoCommands = require("./functions/HoroscopoCommands");
const Copa2026 = require("./functions/Copa2026");
const RankingMessages = require("./functions/RankingMessages");
const fs = require("fs").promises;
const path = require("path");
const Stickers = require("./functions/Stickers");
const LembretesCommands = require("./functions/LembretesCommands");
const CorreiosCommands = require("./functions/CorreiosCommands");
const ReturnMessage = require("./models/ReturnMessage");
const SillyInteractionHandler = require("./SillyInteractionHandler");
const EventEmitter = require("events");
const {
	downloadHandler,
	detectPlatform,
	extractURLFromString
} = require("./functions/SocialMediaDownloader");

class EventHandler extends EventEmitter {
	static instance = null;

	constructor() {
		super();
		if (EventHandler.instance) {
			return EventHandler.instance;
		}
		EventHandler.instance = this;
		this.logger = new Logger("event-handler");
		this.database = Database.getInstance();
		this.commandHandler = new CommandHandler();
		this.llmService = LLMService.getInstance();
		this.variableProcessor = new CustomVariableProcessor();
		this.nsfwPredict = NSFWPredict.getInstance();
		this.adminUtils = AdminUtils.getInstance();
		this.rankingMessages = RankingMessages;
		this.userGreetingManager = require("./utils/UserGreetingManager").getInstance();
		this.groups = {};
		this.comandosWhitelist = process.env.CMD_WHITELIST
			? process.env.CMD_WHITELIST.split(",")
			: ["sa-", "anoni"];

		this.PV_AI_DEBOUNCE_MS = 8000;
		this.pvDebounce = {};
		this.activeSpammers = new Set();
		this.spammerActiveWindowUntil = 0;

		this.logger.info(`[EventHandler] CmdWhitelist:`, this.comandosWhitelist);
		this.loadGroups();
	}

	/**
	 * Carrega todos os grupos do banco de dados
	 */
	async loadGroups() {
		try {
			const groups = await this.database.getGroups();
			if (groups && Array.isArray(groups)) {
				for (const groupData of groups) {
					this.groups[groupData.id] = new Group(groupData);
				}
			}
			this.logger.info(`Carregados ${Object.keys(this.groups).length} grupos`);
		} catch (error) {
			this.logger.error("Erro ao carregar grupos:", error);
		}
	}

	/**
	 * Verifica se um chat/grupo é o grupo de dossiês do bot
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {string} groupId - ID do grupo
	 * @returns {boolean}
	 */
	isDossieGroup(bot, groupId) {
		if (!bot || !groupId) return false;
		if (typeof bot.isDossieGroup === "function") {
			return bot.isDossieGroup(groupId);
		}
		if (!bot.dossieGroups) return false;
		const clean = (id) => String(id).split("@")[0].trim();
		const targetClean = clean(groupId);
		const groups = Array.isArray(bot.dossieGroups)
			? bot.dossieGroups
			: typeof bot.dossieGroups === "string" && bot.dossieGroups.includes(",")
				? bot.dossieGroups.split(",").map((g) => g.trim())
				: [bot.dossieGroups];
		return groups.some((g) => clean(g) === targetClean || String(g).trim() === String(groupId).trim());
	}

	/**
	 * Obtém grupo por ID, cria se não existir
	 * @param {string} groupId - O ID do grupo
	 * @param {string} name - O nome do grupo (opcional)
	 * @param {string} prefix - O prefixo padrão (opcional)
	 * @param {string} addedBy - Quem adicionou o bot (opcional)
	 * @param {Object} bot - Instância do bot (opcional)
	 * @param {Object} message - Mensagem que disparou a criação (opcional)
	 * @returns {Promise<Group>} - O objeto do grupo
	 */
	async getOrCreateGroup(
		groupId,
		name = null,
		prefix = "?",
		addedBy = null,
		bot = null,
		message = null
	) {
		try {
			let newGroup = false;
			if (!this.groups[groupId]) {
				this.logger.info(`Criando novo grupo: ${groupId} com nome: ${name ?? "desconhecido"}`);
				newGroup = true;

				// Obtém grupos do banco de dados para garantir que temos o mais recente
				const groups = await this.database.getGroups();
				const existingGroup = Array.isArray(groups) ? groups.find((g) => g.id === groupId) : null;

				if (existingGroup) {
					this.logger.info(`Grupo existente encontrado no banco de dados: ${groupId}`);
					this.groups[groupId] = new Group(existingGroup);
				} else {
					// Cria novo grupo
					let displayName = name
						? name.trim()
						: groupId
								.split("@")[0]
								.toLowerCase()
								.replace(/[^a-zA-Z0-9_\-.]/g, "")
								.substring(0, 30);

					// Verifica se é Discord para formatar o nome como solicitado: nome-guild-nome-do-canal
					if (bot && bot.useDiscord && message && message.guildId) {
						try {
							const guild = await bot.discordClient.guilds.fetch(message.guildId);
							const channel = await bot.discordClient.channels.fetch(message.group);
							if (guild && channel) {
								const cleanGuild = guild.name.replace(/[^a-zA-Z0-9]/g, "").substring(0, 14);
								const cleanChannel = channel.name.replace(/[^a-zA-Z0-9]/g, "").substring(0, 14);
								displayName = `${cleanGuild}-${cleanChannel}`.toLowerCase();
							}
						} catch (discordErr) {
							this.logger.error("Erro ao buscar nomes no Discord para displayName:", discordErr);
						}
					}

					// Verifica se já tem grupo com esse nome antes
					let grupoExistente = await this.database.getGroupByName(displayName);
					while (grupoExistente) {
						const rndG = Math.floor(Math.random() * 100);
						this.logger.info(
							`[getOrCreateGroup] Tentei criar grupo '${displayName}', tentando agora '${displayName}${rndG}', mas já existe um!`,
							grupoExistente
						);
						displayName = `${displayName}${rndG}`;
						grupoExistente = await this.database.getGroupByName(displayName);
					}

					const group = new Group({
						id: groupId,
						name: displayName,
						prefix,
						addedBy: addedBy ?? "desconhecido"
					});

					this.groups[groupId] = group;

					// Salva no banco de dados
					const saveResult = await this.database.saveGroup(group);
					this.logger.debug(
						`Resultado de salvamento do grupo: ${saveResult ? "sucesso" : "falha"}`
					);
				}
			}
			return { newGroup, group: this.groups[groupId] };
		} catch (error) {
			this.logger.error("Erro em getOrCreateGroup:", error);
			// Cria um objeto de grupo básico se tudo falhar
			return {
				newGroup: false,
				group: new Group({ id: groupId, name: name ?? "grupo-desconhecido" })
			};
		}
	}

	/**
	 * Manipula evento de conexão
	 * @param {WhatsAppBot} bot - A instância do bot
	 */
	onConnected(bot) {
		this.logger.info(`Bot ${bot.id} conectado`);

		// Inicializa temporizadores de lembretes
		LembretesCommands.inicializarLembretes(bot).catch((error) => {
			this.logger.error("Erro ao inicializar lembretes:", error);
		});

		// Inicializa sistema de rastreio de encomendas
		CorreiosCommands.inicializarRastreio(bot).catch((error) => {
			this.logger.error("Erro ao inicializar rastreio correios:", error);
		});
	}

	/**
	 * Manipula evento de desconexão
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {string} reason - Motivo da desconexão
	 */
	onDisconnected(bot, reason) {
		this.logger.info(`Bot ${bot.id} desconectado: ${reason}`);
	}

	/**
	 * Manipula evento de mensagem
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 */
	onMessage(bot, message) {
		this.emit("activity", { type: "message", botId: bot.id });
		// Processa mensagem sem aguardar para evitar bloquear a thread de eventos
		this.processMessage(bot, message).catch((error) => {
			this.logger.error("Erro em processMessage:", error);
		});
	}

	/**
	 * Manipula evento de reação
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} reaction - A reação formatada
	 */
	onReaction(bot, reaction) {
		this.emit("activity", { type: "reaction", botId: bot.id });
		// Processa reação sem aguardar
		this.rankingMessages.processReaction(reaction).catch((error) => {
			this.logger.error("Erro em processReaction (ranking):", error);
		});
	}

	/**
	 * Processa uma mensagem recebida
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 */
	async processMessage(bot, message) {
		try {
			// Ignorar: Mensagens do bot e mensagens de broadcast ('status@broadcast')
			if (
				message.fromMe ||
				message.from?.includes("broadcast") ||
				message.group?.includes("broadcast")
			)
				return;

			// --- Prevenção de Spam Ativo ---
			if (await this.checkSpammerMessage(bot, message)) {
				return;
			}
			// -------------------------------

			// --- Filtro de Bloqueio Local ---
			let isLocalBlocked = false;

			// Verifica autor (geralmente PN)
			if (message.author) {
				const pn = message.author.split("@")[0];
				if (await bot.database.isLocalBlocked(pn)) {
					isLocalBlocked = true;
				}
			}

			// Verifica authorAlt (geralmente LID)
			if (!isLocalBlocked && message.authorAlt) {
				const lid = message.authorAlt.split("@")[0];
				if (await bot.database.isLocalBlocked(lid)) {
					isLocalBlocked = true;
				}
			}

			if (isLocalBlocked) {
				// this.logger.debug(`[EventHandler] Ignorando mensagem de usuário bloqueado: ${message.author} (${message.authorAlt})`);
				return;
			}
			// --------------------------------

			// Newsletter/Canais: Apenas pra detectar jrmunews, horóscopos, etc.
			if (message.isNewsletter) {
				// this.logger.debug(`[processMessage] Recebido newsletter`, { message });
				try {
					const isNewsDetected = await MuNewsCommands.detectNews(message.content, message.from);
					if (isNewsDetected) {
						// Opcionalmente, envia uma confirmação de que a MuNews foi detectada e salva
						bot
							.sendMessage(process.env.GRUPO_LOGS, "📰 *MuNews detectada e salva!*")
							.catch((error) => {
								this.logger.error("Erro ao enviar confirmação de MuNews:", error);
							});
					}

					const isHoroscopoDetected = await HoroscopoCommands.detectHoroscopo(
						message.content,
						message.from
					);
					if (isHoroscopoDetected) {
						// Opcionalmente, envia uma confirmação de que um Horoscopo foi detectado e salvo
						// bot.sendMessage(process.env.GRUPO_LOGS, "🔮 *Horoscopo detectado e salvo!*").catch(error => {
						//   this.logger.error('Erro ao enviar confirmação de Horoscopo:', error);
						// });
					}

					await Copa2026.detectCopaGif(message, bot);
				} catch (error) {
					this.logger.error("Erro ao verificar Newsletter:", error);
				}

				return;
			}

			const ignorePV = bot.ignorePV && bot.notInWhitelist(message.author) && message.group === null;

			// Verifica links de convite em chats privados
			if (!message.group && !ignorePV) {
				// Verifica se é uma mensagem de link de convite
				if (!bot.ignoreInvites && bot.inviteSystem) {
					const isInviteHandled = await bot.inviteSystem.processMessage(message);
					if (isInviteHandled) return;

					// Verifica se é uma mensagem de acompanhamento para um convite
					const isFollowUpHandled = await bot.inviteSystem.processFollowUpMessage(message);
					if (isFollowUpHandled) return;
				}
			}

			// Processa saudação para novos usuários no PV
			//this.userGreetingManager.processGreeting(bot, message);

			// Obtém conteúdo de texto da mensagem (corpo ou legenda)
			let textContent = message.type === "text" ? message.content : message.caption;

			// Limpa espaços e markup de monospace do WhatsApp (backticks)
			if (textContent && typeof textContent === "string") {
				textContent = textContent.trim();
				// Remove backticks se estiverem no início e fim (ex: `!ping`)
				if (textContent.startsWith("`") && textContent.endsWith("`")) {
					textContent = textContent.slice(1, -1).trim();
				}
			}

			// Se mensagem de grupo, obtém ou cria o grupo
			let group = null;

			if (message.group) {
				// Armazena mensagem para histórico de conversação
				SummaryCommands.storeMessage(message, message.group, bot);

				const groupData = await this.getOrCreateGroup(
					message.group ?? message.guildId,
					null,
					bot.prefix,
					message.author,
					bot,
					message
				);
				group = groupData.group;

				if (!group.botNotInGroup) {
					group.botNotInGroup = [];
				} else {
					// Verifica se o bot está marcada como fora do grupo - se ele recebeu msg aqui, é pq tá dentro!
					if (group.botNotInGroup.includes(bot.id)) {
						this.logger.info(
							`[processMessage] O bot '${bot.id}' estava como fora do grupo '${group.name}', mas recebeu mensagem - atualizando`
						);
						group.botNotInGroup = group.botNotInGroup.filter((b) => b !== bot.id);
						await this.database.saveGroup(group);
					}
				}

				// Como o bot recebeu mensagem do grupo, ele está nele. Remove do skip list.
				if (bot.removeSkipGroup) {
					await bot.removeSkipGroup(message.group);
				}

				// Verifica apelido do usuário e atualiza o nome se necessário
				if (group.nicks && Array.isArray(group.nicks)) {
					const nickData = group.nicks.find((nick) => nick.numero === message.author);
					if (nickData && nickData.apelido) {
						try {
							// Atualiza também o nome no objeto message para uso em comandos
							// ATENÇÃO: TRIPA DE CÓDIGO ADIANTE
							message.name =
								message.pushname =
								message.pushName =
								message.authorName =
								message.origin.name =
								message.origin.pushname =
								message.origin.pushName =
								message.origin.authorName =
									nickData.apelido;
						} catch (error) {
							this.logger.error("Erro ao aplicar apelido:", error);
						}
					}
				}

				// Ajuda com recuperação de grupo
				const botNameRecovery = (bot.nomeExibir || "ravena").toLowerCase();
				if (
					!this.isDossieGroup(bot, message.group) &&
					textContent &&
					typeof textContent === "string" &&
					textContent.trim().toLowerCase() === `ravena, ajude a recuperar meu grupo!`
				) {
					try {
						const chat = await message.origin.getChat();
						const isAdmin = await this.adminUtils.isAdmin(message.author, group, chat, bot);

						if (isAdmin) {
							const wasPaused = group.paused;
							const oldPrefix = group.prefix;

							group.paused = false;
							group.prefix = "!";
							await this.database.saveGroup(group);

							let responseText = "🛡️ *Recuperação de Grupo Ativada!*\n\n";

							if (wasPaused) {
								responseText += "⏸️ O grupo estava pausado e foi *despausado* com sucesso.\n";
							} else {
								responseText += "▶️ O status do grupo já estava ativo (não estava pausado).\n";
							}

							if (oldPrefix !== "!") {
								responseText += `🔄 O prefixo do grupo foi trocado de "${oldPrefix}" para "!"\n`;
							} else {
								responseText += '🔑 O prefixo do grupo já era "!"\n';
							}

							responseText += `\n🏷️ *Nome de cadastro do grupo:* ${group.name}\n`;
							responseText += `\n💡 *Dica:* Para gerenciar o grupo ou ver suas configurações de forma fácil na interface web, você pode utilizar:\n`;
							responseText += `• \`!g-manage ${group.name}\` (em seu chat privado com o bot)\n`;
							responseText += `• \`!g-painel\` (para acessar o painel web)`;

							const returnMsg = new ReturnMessage({
								chatId: message.group ?? message.author,
								content: responseText
							});

							await bot.sendReturnMessages(returnMsg, group);

							const grupoLogs = bot.grupoLogs || process.env.GRUPO_LOGS;
							if (grupoLogs) {
								const logMsg = `🛡️ *Recuperação de Grupo Solicitada*\n- 👤 *Usuário:* ${message.name || "Desconhecido"} (${message.author})\n- 👥 *Grupo:* ${group.titulo || group.name} (${group.id})\n- 🤖 *Bot:* ${bot.id}`;
								bot
									.sendMessage(grupoLogs, logMsg)
									.catch((err) =>
										this.logger.error("Erro ao notificar grupo de logs sobre recuperação:", err)
									);
							}

							return;
						}
					} catch (error) {
						this.logger.error("Erro na ajuda de recuperação de grupo:", error);
					}
				}

				// Verifica se o grupo está pausado
				if (group.paused) {
					// Verifica se é o comando g-pausar antes de ignorar completamente
					const prefix = group && group.prefix !== undefined ? group.prefix : bot.prefix;
					const isPauseCommand =
						textContent &&
						textContent.startsWith(prefix) &&
						textContent.substring(prefix.length).startsWith("g-pausar");

					// Só continua o processamento se for o comando g-pausar
					if (!isPauseCommand) {
						return;
					}
				}

				// Processa mensagem para ranking
				try {
					await this.rankingMessages.processMessage(message);
				} catch (error) {
					this.logger.error("Erro ao processar mensagem para ranking:", error);
				}

				// Verifica se o usuário está ignorado
				if (group && group.ignoredNumbers && Array.isArray(group.ignoredNumbers)) {
					// Check if any part of the author's number matches an ignored number
					const isIgnored = group.ignoredNumbers.some(
						(number) => message.author.includes(number) && number.length >= 8
					);

					if (isIgnored) {
						this.logger.debug(`Ignorando mensagem de ${message.author} (ignorado no grupo)`);
						return; // Skip processing this message
					}
				}

				// Aplica filtros
				if (await this.applyFilters(bot, message, group)) {
					return; // Mensagem foi filtrada
				}

				// Se NUDENET_DETECT_ALL estiver ativo e a mídia não foi verificada pelo filtro do grupo (ex: grupo sem filtro nsfw ativo)
				if (this.isNudenetDetectAll() && !group?.filters?.nsfw) {
					await this.checkNSFW(bot, message, group, true);
				}
			} else {
				// Armazena mensagem para histórico de conversação no pv
				SummaryCommands.storeMessage(message, message.group, bot);

				// Se NUDENET_DETECT_ALL estiver ativo, verifica mídias no PV também
				if (this.isNudenetDetectAll()) {
					await this.checkNSFW(bot, message, null, true);
				}
			}

			// Ignora todos os comandos se a mensagem for do grupo de dossiês
			if (message.group && this.isDossieGroup(bot, message.group)) {
				this.logger.debug(
					`[${bot.id}] Mensagem recebida no grupo de dossiês (${message.group}). Comandos ignorados.`
				);
				return;
			}

			// Se não houver conteúdo de texto, não pode ser um comando ou menção
			if (!textContent) {
				return this.processNonCommandMessage(bot, message, group, textContent);
			}

			// Verifica menções ao bot
			const isMentionHandled = await bot.mentionHandler.processMention(
				bot,
				message,
				group,
				textContent
			);
			if (isMentionHandled) return;

			// Obtém prefixo do grupo ou prefixo padrão do bot
			const prefix = group && group.prefix !== undefined ? group.prefix : bot.prefix;

			// CORREÇÃO: Verificação adequada para prefixo vazio
			const isCommand = prefix === "" || textContent.startsWith(prefix);

			if (isCommand) {
				// Se o prefixo for vazio, usa o texto completo como comando
				// Se não, remove o prefixo do início
				let commandText = prefix === "" ? textContent : textContent.substring(prefix.length);

				// Remove espaços extras após o prefixo (ex: "! ping" -> "ping")
				commandText = commandText.trimStart();

				// IMPORTANTE: Verificação especial para comandos de gerenciamento mesmo com prefixo vazio
				if (commandText.startsWith("g-")) {
					this.logger.debug(`Comando de gerenciamento detectado: ${commandText}`);

					// Processa comando sem aguardar para evitar bloqueio
					this.commandHandler.handleCommand(bot, message, commandText, group).catch((error) => {
						this.logger.error("Erro em handleCommand:", error);
					});

					return; // Evita processamento adicional
				}

				// Processa comando normal
				if (
					!ignorePV ||
					message.group ||
					this.comandosWhitelist.some((cW) => textContent.includes(cW))
				) {
					this.commandHandler.handleCommand(bot, message, commandText, group).catch((error) => {
						this.logger.error("Erro em handleCommand:", error);
					});
				}
			} else {
				// Processa mensagem não-comando
				// Aqui também vai cair quando o grupo tiver a opção customIgnoresPrefix, que os comandos personalizados não precisam de prefixo
				this.processNonCommandMessage(bot, message, group, textContent).catch((error) => {
					this.logger.error("Erro em processNonCommandMessage:", error);
				});
			}
		} catch (error) {
			this.logger.error("Erro ao processar mensagem:", error);
		}
	}

	/**
	 * Processa mensagens que não são comandos
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 * @param {Group} group - O objeto do grupo (se em grupo)
	 * @param {string} textContent - O texto da mensagem (opcional, já limpo)
	 */
	async processNonCommandMessage(bot, message, group, textContent = null) {
		// Verifica se é uma mensagem de voz para processamento automático de STT
		const processed = await SpeechCommands.processAutoSTT(bot, message, group, {
			returnResult: true
		});
		if (processed) {
			message.content = `Audio[${processed}]`;
			message.caption = `Audio[${processed}]`;

			// Armazena também áudios no histórico!
			SummaryCommands.storeMessage(message, message.author, bot);

			if (bot.comandosAudioPV && bot.pvAI && processed.length > 0) {
				// Desabilitado por enquanto
				this.logger.debug(
					`[processNonCommandMessage] Recebido áudio no PV e transcrito, chamando LLM com '${processed}'`
				);
				// Usa texto extraído do áudio como entrada pro LLM
				const msgsLLM = await aiCommand(bot, message, [], group);
				bot.sendReturnMessages(msgsLLM);
			}
			return;
		}

		const ignorePV = bot.ignorePV && bot.notInWhitelist(message.author) && message.group === null;

		// Auto-download de links de mídias sociais no PV
		if (!group && !ignorePV && message.type === "text" && bot.autoDownloadPV) {
			const url = extractURLFromString(message.content);
			if (url) {
				const platform = detectPlatform(url);
				const supportedPlatforms = ["YouTube", "Instagram", "Facebook", "TikTok", "Twitter"];
				if (supportedPlatforms.includes(platform)) {
					this.logger.info(
						`[processNonCommandMessage] Auto-download PV detectado: ${platform} - ${url}`
					);
					downloadHandler(bot, message, [url], group);
					return;
				}
			}
		}

		if (!group && !ignorePV) {
			const stickerProcessed = await Stickers.processAutoSticker(bot, message, group);
			if (stickerProcessed) return;
		}

		// Trigger para jogos
		// if (group && message.type === "location") {
		// 	const respGeo = await GeoGuesser.processLocationMessage(bot, message);
		// 	if (respGeo) {
		// 		bot.sendReturnMessages(respGeo, group);
		// 	}
		// }

		if (!group && message.type === "text" && bot.pvAI) {
			const userId = `${bot.id}_${message.author || message.from}`;
			if (!this.pvDebounce[userId]) {
				this.pvDebounce[userId] = {
					messages: [],
					timer: null,
					lastMessage: null
				};
			}

			const debounce = this.pvDebounce[userId];
			if (debounce.timer) {
				clearTimeout(debounce.timer);
				debounce.timer = null;
			}

			debounce.messages.push(message.content);
			debounce.lastMessage = message;

			this.logger.debug(
				`[processNonCommandMessage] PV sem comando, acumulando mensagem (${debounce.messages.length}) de ${userId}. Aguardando ${this.PV_AI_DEBOUNCE_MS / 1000}s...`
			);

			debounce.timer = setTimeout(async () => {
				try {
					const combinedContent = debounce.messages.join("\n");
					const msgToProcess = debounce.lastMessage;

					// Atualiza o conteúdo da última mensagem para processar no LLM
					msgToProcess.content = combinedContent;
					msgToProcess.caption = combinedContent;

					this.logger.debug(
						`[processNonCommandMessage] Debounce finalizado para ${userId}, chamando LLM com ${debounce.messages.length} mensagens combinadas.`
					);

					// Limpa o cache antes de chamar para evitar processar duplicado se novas msgs chegarem durante o processamento (opcional, mas seguro)
					delete this.pvDebounce[userId];

					const msgsLLM = await aiCommand(bot, msgToProcess, [], group);
					bot.sendReturnMessages(msgsLLM, group);
				} catch (error) {
					this.logger.error(`Erro ao processar debounce do LLM para ${userId}:`, error);
					delete this.pvDebounce[userId];
				}
			}, this.PV_AI_DEBOUNCE_MS);
		}

		if (group) {
			// SillyInteractionHandler entry point
			const sillyHandled = await SillyInteractionHandler.handle(bot, message, group);
			if (sillyHandled) return;

			try {
				// Se o grupo escolheu a opção 'customIgnoresPrefix', pode ser que um comando personalizado esteja sendo executado
				// Gera um comando e manda pro handleCommand, mas com a flag de ser apenas custom
				if (!textContent) {
					textContent = message.type === "text" ? message.content : message.caption;
				}

				if (group.customIgnoresPrefix) {
					this.commandHandler.processCustomIgnoresPrefix(textContent, bot, message, group);
				}

				if (textContent) {
					// Manipula comandos personalizados acionados automaticamente (aqueles que não requerem prefixo)
					this.commandHandler.checkAutoTriggeredCommands(bot, message, textContent, group);
				}
			} catch (error) {
				this.logger.error("Erro ao verificar comandos acionados automaticamente:", error);
			}
		}
	}

	/**
	 * Aplica filtros de mensagem
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 * @param {Group} group - O objeto do grupo
	 * @returns {Promise<boolean>} - True se a mensagem foi filtrada (deve ser ignorada)
	 */
	async applyFilters(bot, message, group) {
		if (!group || !group.filters) return false;

		const textContent = (message.type === "text" ? message.content : message.caption) ?? "";

		if (textContent?.includes("g-filtro")) {
			return false; // Não filtrar comandos de filtro
		}

		const filters = group.filters;

		// Verifica filtro de palavras
		if (filters.words && Array.isArray(filters.words) && filters.words.length > 0) {
			if (textContent) {
				const lowerText = textContent.toLowerCase();
				for (const word of filters.words) {
					if (lowerText.includes(word.toLowerCase())) {
						this.logger.info(
							`Mensagem filtrada no grupo ${group.id} - contém palavra proibida: ${word}`
						);

						// Deleta a mensagem se possível - não bloqueia
						message.origin.delete(true).catch((error) => {
							this.logger.error("Erro ao deletar mensagem filtrada:", error);
						});

						return true;
					}
				}
			}
		}

		// Verifica filtro de links
		if (filters.links && textContent && textContent.match(/https?:\/\/[^\s]+/g)) {
			this.logger.info(`Mensagem filtrada no grupo ${group.id} - contém link`);

			// Deleta a mensagem se possível - não bloqueia
			message.origin.delete(true).catch((error) => {
				this.logger.error("Erro ao deletar mensagem filtrada:", error);
			});

			return true;
		}

		// Verifica filtro de pessoas
		if (filters.people && Array.isArray(filters.people) && filters.people.length > 0) {
			//this.logger.debug(`[filters][person] Filtrar? ${message.author}|${message.authorAlt} vs ${filters.people.join(", ")}`);

			const numerosTestar = [message.author, message.authorAlt];

			if (typeof bot.getLidFromPn === "function" && typeof bot.getPnFromLid === "function") {
				numerosTestar.push(bot.getLidFromPn(message.author));
				numerosTestar.push(bot.getLidFromPn(message.authorAlt));
				numerosTestar.push(bot.getPnFromLid(message.author));
				numerosTestar.push(bot.getPnFromLid(message.authorAlt));
			}

			const extrairFinalNumerico = (str) => {
				if (!str) return null;
				const apenasNumeros = String(str).split(/[@:]/)[0].replace(/\D/g, "");
				return apenasNumeros.slice(-10);
			};

			// Criamos um conjunto (Set) com os finais dos números para testar (mais rápido para busca)
			const finaisParaTestar = new Set(
				numerosTestar.map(extrairFinalNumerico).filter((n) => n && n.length >= 10) // Garante que tem pelo menos 10 dígitos
			);

			// Verifica se algum elemento do filters.people (também limpo) coincide
			const match = filters.people.some((person) => {
				const finalPerson = extrairFinalNumerico(person);
				return finalPerson && finaisParaTestar.has(finalPerson);
			});

			if (match) {
				this.logger.info(
					`Mensagem filtrada no grupo ${group.id} - de usuário banido: ${message.author}`
				);

				// Deleta a mensagem se possível - não bloqueia
				message.origin.delete(true).catch((error) => {
					this.logger.error("Erro ao deletar mensagem filtrada:", error);
				});

				return true;
			}
		}

		// Verifica filtro NSFW para imagens, vídeos, gifs e stickers
		if (
			filters.nsfw &&
			(message.type === "image" ||
				message.type === "sticker" ||
				message.type === "video" ||
				message.type === "gif" ||
				message.content?.mimetype === "image/gif")
		) {
			const isDetectAll = this.isNudenetDetectAll();
			if (await this.checkNSFW(bot, message, group, isDetectAll)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Verifica se a detecção de NSFW em todas as mídias está ativada via .env
	 * @returns {boolean}
	 */
	isNudenetDetectAll() {
		const envVal = process.env.NUDENET_DETECT_ALL;
		if (!envVal) return false;
		const val = envVal.toString().trim().toLowerCase();
		return val !== "0" && val !== "false" && val !== "undefined";
	}

	/**
	 * Realiza verificação NSFW em imagem, vídeo ou GIF recebido
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Mensagem recebida
	 * @param {Group|null} group - Grupo (se houver)
	 * @param {boolean} [isDetectAll=false] - Se foi disparado via NUDENET_DETECT_ALL
	 * @returns {Promise<boolean>} - True se a mensagem foi filtrada (deletada)
	 */
	async checkNSFW(bot, message, group, isDetectAll = false) {
		const isGroupFilter = Boolean(group?.filters?.nsfw);

		// Stickers só são verificados se o filtro do grupo estiver ativo (NUDENET_DETECT_ALL não verifica stickers)
		if (message.type === "sticker" && !isGroupFilter) {
			return false;
		}

		const isGif =
			message.type === "gif" ||
			message.content?.mimetype === "image/gif" ||
			message.content?._mediaDetails?.gifPlayback === true;
		const isVideo = message.type === "video";
		const isImage = message.type === "image";
		const isSticker = message.type === "sticker";

		if (!isImage && !isVideo && !isGif && !isSticker) {
			return false;
		}

		try {
			const tempDir = path.join(__dirname, "../temp");
			try {
				await fs.access(tempDir);
			} catch (error) {
				await fs.mkdir(tempDir, { recursive: true });
			}

			// Obtém dados da mídia (suporta tanto base64 quanto data)
			let mediaData = message.content?.data || message.content?.base64;

			// Se não tiver dados (comum em vídeos e mensagens WhatsGo), tenta baixar
			if (!mediaData && typeof message.downloadMedia === "function") {
				try {
					const media = await message.downloadMedia();
					mediaData = media?.data || media?.base64;
				} catch (dlErr) {
					this.logger.error("Erro ao baixar mídia para verificação NSFW:", dlErr);
				}
			}

			if (!mediaData) {
				const groupTag = group?.name ? `[${group.name}] ` : "";
				this.logger.warn(
					`${groupTag}Não foi possível obter dados da mídia para verificação NSFW, ignorando.`
				);
				return false;
			}

			// Stickers não devem ser marcados como detectAll
			const isDetectAllForMedia = isDetectAll && !isSticker;

			const nsfwContext = {
				groupName: group?.name || group?.id || (message.group ? message.group : "PV"),
				author: message.author || message.authorAlt || "desconhecido",
				authorName:
					message.name ||
					message.pushName ||
					message.authorName ||
					message.author ||
					"desconhecido",
				threshold: group?.filters?.nsfwThreshold,
				group,
				detectAll: isDetectAllForMedia,
				isDetectAll: isDetectAllForMedia
			};

			let result = { isNSFW: false, reason: "" };

			if (isVideo || isGif) {
				const isGifMime = isGif && message.content?.mimetype === "image/gif";
				const fileExt = isGifMime ? "gif" : "mp4";
				const tempFilePath = path.join(
					tempDir,
					`nsfw-check-${Date.now()}-${Math.floor(Math.random() * 1000)}.${fileExt}`
				);

				const mediaBuffer = Buffer.from(mediaData, "base64");
				await fs.writeFile(tempFilePath, mediaBuffer);

				try {
					result = await this.nsfwPredict.detectNSFWVideo(tempFilePath, nsfwContext);
				} finally {
					fs.unlink(tempFilePath).catch((error) => {
						this.logger.error(`Erro ao excluir arquivo temporário ${tempFilePath}:`, error);
					});
				}
			} else {
				// Imagem ou Sticker
				result = await this.nsfwPredict.detectNSFW(mediaData, nsfwContext);
			}

			if (result.isNSFW) {
				if (isGroupFilter) {
					this.logger.info(
						`[${nsfwContext.groupName}] Mensagem NSFW filtrada - motivo: ${result.reason} [enviado por ${nsfwContext.authorName}/${nsfwContext.author}]`
					);

					// Deleta a mensagem se o filtro do grupo estiver ativo
					message.origin.delete(true).catch((error) => {
						this.logger.error("Erro ao deletar mensagem NSFW:", error);
					});

					return true;
				} else {
					this.logger.info(
						`[${nsfwContext.groupName}] Mensagem NSFW detectada (detectAll) - motivo: ${result.reason} [enviado por ${nsfwContext.authorName}/${nsfwContext.author}]`
					);
					return false;
				}
			}
		} catch (nsfwError) {
			this.logger.error("Erro ao verificar conteúdo NSFW:", nsfwError);
		}

		return false;
	}

	/**
	 * Manipula evento de entrada no grupo
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} data - Dados do evento
	 *
	 */
	onGroupJoin(bot, data) {
		// Processa entrada sem aguardar para evitar bloquear a thread de eventos
		this.processGroupJoin(bot, data).catch((error) => {
			this.logger.error("Erro em processGroupJoin:", error);
		});
	}

	/**
	 * Manipula evento de saída no grupo
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} data - Dados do evento
	 *
	 */
	onGroupLeave(bot, data) {
		// Processa entrada sem aguardar para evitar bloquear a thread de eventos
		this.processGroupLeave(bot, data).catch((error) => {
			this.logger.error("Erro em processGroupLeave:", error);
		});
	}

	/**
	 * Processa entrada no grupo
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} data - Dados do evento
	 */
	async processGroupJoin(bot, data) {
		const groupId = data.group.id;
		const isBotJoining =
			data?.isBotJoining ||
			data?.group?.isBotJoining ||
			data?.user?.id?.startsWith(bot.phoneNumber);
		if (bot.removeSkipGroup) {
			await bot.removeSkipGroup(groupId);
		}

		if (data.isCommunity || data.group?.isCommunity) {
			this.logger.debug(`[processGroupJoin] IGNORANDO evento de join em comunidade (${groupId}).`);
			return;
		}

		// Motivo da alteração: Grupos configurados como "Apenas administradores enviam mensagens" (isAnnounce / modo avisos)
		// anteriormente tinham todos os eventos de entrada ignorados. Agora, se o grupo possuir mensagem de boas-vindas
		// ou despedida definida, o evento NÃO é ignorado e a mensagem é enviada normalmente.
		const initialGroupCheck = this.groups[groupId] ?? (await this.database.getGroup(groupId));
		const initialHasGreetings =
			initialGroupCheck?.greetings &&
			Object.keys(initialGroupCheck.greetings).some((k) => initialGroupCheck.greetings[k]);
		const initialHasFarewells =
			initialGroupCheck?.farewells &&
			Object.keys(initialGroupCheck.farewells).some((k) => initialGroupCheck.farewells[k]);
		if (
			(data.isAnnounce || data.group?.isAnnounce) &&
			!initialHasGreetings &&
			!initialHasFarewells
		) {
			this.logger.debug(
				`[processGroupJoin] IGNORANDO evento de join em Announce Channel (${groupId}) (sem boas-vindas/despedida configuradas).`
			);
			return;
		}

		//this.logger.info(`[processGroupJoin] `, { data });

		// Carrega o grupo para verificar se o usuário que entrou está bloqueado
		try {
			const group = await this.database.getGroup(groupId);
			if (
				group &&
				group.filters &&
				group.filters.people &&
				Array.isArray(group.filters.people) &&
				group.filters.people.length > 0
			) {
				const userId = data.user.id;
				let userPn = userId.split("@")[0];
				let userLid = null;

				try {
					const contact = await bot.client.getContactById(userId);
					if (contact) {
						userPn = contact.id._serialized.split("@")[0];
						if (contact.lid) {
							userLid = contact.lid.split("@")[0];
						}
					}
				} catch (contactErr) {
					this.logger.error(
						`[processGroupJoin] Erro ao obter contato ${userId} para validação de ban:`,
						contactErr.message
					);
				}

				const isBlocked = group.filters.people.some((blocked) => {
					const blockedClean = blocked.split("@")[0];
					return blockedClean === userPn || (userLid && blockedClean === userLid);
				});

				if (isBlocked) {
					this.logger.warn(
						`[processGroupJoin] Usuário bloqueado detectado ao entrar no grupo: ${userId} (LID: ${userLid}) no grupo ${groupId}. Removendo imediatamente.`
					);
					await bot.removeFromGroup(groupId, [userId]);
					return;
				}
			}
		} catch (dbErr) {
			this.logger.error(`[processGroupJoin] Erro ao verificar filtros do grupo ${groupId}:`, dbErr);
		}

		if (!isBotJoining) {
			const fixedGroups = [
				process.env.GRUPO_INTERACAO,
				process.env.GRUPO_PESCA,
				process.env.GRUPO_DOWNLOADS
			].filter(Boolean);

			if (data.user && data.user.id && fixedGroups.includes(groupId)) {
				const userId = data.user.id;
				const userPhone = userId.split("@")[0];
				if (userPhone.startsWith("63") || userPhone.startsWith("62")) {
					this.logger.warn(
						`[processGroupJoin] Spammer detectado via join event: ${userId} no grupo ${groupId}`
					);
					this.activeSpammers.add(userId);
					this.activeSpammers.add(userPhone);
					this.spammerActiveWindowUntil = Date.now() + 5 * 60 * 1000; // Ativa janela de monitoramento por 5 minutos
					setTimeout(
						() => {
							this.activeSpammers.delete(userId);
							this.activeSpammers.delete(userPhone);
						},
						5 * 60 * 1000
					);
				}
			}
		}

		//this.logger.info(`Usuário ${data.user.name} (${data.user.id}) entrou no grupo ${data.group.name} (${data.group.id}). Quem adicionou: ${data.responsavel.name}/${data.responsavel.id}`);

		try {
			// Obtém os dados completos do chat
			const chat = await data.origin.getChat();

			//this.logger.info(`[processGroupJoin] Chat `, { chat });

			// Verifica se há spammers para banir (63/62) nos grupos fixos
			await this.checkAutoBanSpammers(bot, chat);

			if (chat.isCommunity) {
				this.logger.debug(
					`[processGroupJoin][viaChat] IGNORANDO evento de join em comunidade '${chat.name}' (${data.group?.id || chat.id})`,
					{ chat }
				);
				return;
			}

			// Obtém ou cria grupo
			const nomeGrupo = data.group?.name?.replace(/[^a-zA-Z0-9_\-.]/g, "").substring(0, 30) ?? null;
			const groupData = await this.getOrCreateGroup(
				data.group.id,
				nomeGrupo,
				bot.prefix,
				data.responsavel?.id || (typeof data.responsavel === "string" ? data.responsavel : null),
				bot
			);
			const group = groupData.group;

			// Motivo da alteração: Não ignorar mais o evento de join em grupos em modo Announce (apenas admins enviam mensagens)
			// caso o grupo possua mensagem de boas-vindas ou despedida configurada.
			const hasGreetings =
				group?.greetings && Object.keys(group.greetings).some((k) => group.greetings[k]);
			const hasFarewells =
				group?.farewells && Object.keys(group.farewells).some((k) => group.farewells[k]);
			if (chat.isAnnounce && !hasGreetings && !hasFarewells) {
				this.logger.debug(
					`[processGroupJoin][viaChat] IGNORANDO evento de join em Announce Channel '${chat.name}' (${data.group?.id || chat.id}) sem boas-vindas/despedida configuradas`,
					{ chat }
				);
				return;
			}

			// Verifica se o próprio bot é quem está entrando
			this.logger.debug(
				`[processGroupJoin] isBotJoining (${data.isBotJoining} / ${isBotJoining}}) = data.user.id (${data.user.id}) -startsWith- bot.phoneNumber ${bot.phoneNumber}`
			);

			// Popula titulo e descricao
			group.titulo = chat.name || null;
			group.descricao = chat.groupMetadata?.desc || null;

			//this.logger.debug(`Informações do grupo: ${JSON.stringify(group)}`);

			if (isBotJoining) {
				// Adiciona o responsável do bot comunitário como admin adicional
				/* por enquanto desabilitado
				if (bot.comunitario && bot.numeroResponsavel) {
					const respNum = bot.numeroResponsavel.replace(/\D/g, "");
					if (!group.additionalAdmins) {
						group.additionalAdmins = [];
					}

					// Verifica se já existe na lista (independente de formatação)
					const exists = group.additionalAdmins.some(
						(admin) => admin.replace(/\D/g, "") === respNum
					);

					if (!exists) {
						group.additionalAdmins.push(respNum);
						await this.database.saveGroup(group);
						this.logger.info(
							`[EventHandler] Bot comunitário '${bot.id}' adicionado, administrador ${respNum} foi adicionado aos additionalAdmins do grupo ${group.name}`
						);
					}
				}
				*/

				const joinSilenciosoGlobal = bot.joinSilencioso ?? false;
				const joinSilenciosoGrupo =
					bot.silentJoinGroups instanceof Set && bot.silentJoinGroups.has(groupId);
				const joinSilencioso = joinSilenciosoGlobal || joinSilenciosoGrupo;

				// Se foi um join silencioso por grupo, remove do set e loga no terminal
				if (joinSilenciosoGrupo) {
					bot.silentJoinGroups.delete(groupId);
					this.logger.info(
						`[processGroupJoin] 🔇 JOIN SILENCIOSO para grupo ${groupId} (${group.name}) - nenhuma mensagem de boas-vindas será enviada.`
					);
				}

				if (bot.grupoLogs) {
					try {
						const msgJoin = `🚪🟢 *${bot.id}* entrou no grupo:
- 🆔 *ID:* ${group.id}
- 📃 *Nome:* ${group.name} _(${groupData.newGroup ? "novo" : "antigo"})_
- 👷‍♂️ *Responsável:*
\`\`\`${JSON.stringify(data.responsavel, null, "\t")}\`\`\`
- 👨‍💻 *Raw Data*:
\`\`\`${JSON.stringify(data.group)}\`\`\`${joinSilencioso ? "\n\n🔇 _Join Silencioso_" : ""}`;

						this.logger.info(`[processGroupJoin] ${msgJoin}`);
						bot.sendMessage(bot.grupoLogs, msgJoin);
					} catch (error) {
						this.logger.error(
							"Erro ao enviar notificação de entrada no grupo para o grupo de logs:",
							error
						);
					}
				}

				// Caso 1: Bot entrou no grupo
				this.logger.info(
					`Bot entrou no grupo ${data.group.name} (${nomeGrupo}/${data.group.id}, ${groupData.newGroup ? "novo" : "antigo"})`
				);
				group.paused = false; // Sempre que o bot entra no grupo, tira o pause (para grupos em que saiu/foi removido)
				await this.database.recordGroupJoin(
					group.id,
					group.name,
					Date.now(),
					data.responsavel,
					bot?.id || null
				);
				await this.database.saveGroup(group);

				// Busca pendingJoins para ver se esse grupo corresponde a um convite pendente
				const pendingJoins = await this.database.getPendingJoins();
				let foundInviter = null;

				// Obtém todos os membros do grupo para verificação
				const members = (chat.participants || [])
					.filter((p) => p && p.id)
					.map((p) => p.id._serialized);
				const stringifiedData = JSON.stringify(data);

				for (const pendingJoin of pendingJoins) {
					// Verifica se corresponde ao grupo (groupJid) ou se o autor está no grupo
					if (
						(pendingJoin.groupJid && pendingJoin.groupJid === group.id) ||
						members.includes(pendingJoin.authorId) ||
						stringifiedData.includes(pendingJoin.authorId)
					) {
						foundInviter = pendingJoin;
						break;
					}
				}

				if (foundInviter) {
					group.inviteCode = foundInviter.code;
					group.addedBy = foundInviter.authorId;
					await this.database.updateInviteHistoryGroupJid(foundInviter.code, group.id);
					await this.database.removePendingJoin(foundInviter.code);
				} else if (!group.inviteCode) {
					try {
						const history = await this.database.getInviteHistoryByGroup(group.id);
						if (history && history.length > 0 && history[0].invite_code) {
							group.inviteCode = history[0].invite_code;
							if (!group.addedBy && history[0].author_id) {
								group.addedBy = history[0].author_id;
							}
						}
					} catch (e) {}
				}
				await this.database.saveGroup(group);

				// Envia uma mensagem de boas-vindas padrão sobre o bot
				let botInfoMessage = "";

				// Se é grupo novo, a mensagem de boas vindas é enviada

				if (groupData.newGroup) {
					this.logger.debug(`[groupJoin] Novo grupo, enviando toda mensagem de boas vindas`);
					if (!joinSilencioso) {
						const botDisplayName = bot.nomeExibir || "ravenabot";
						botInfoMessage = `🦇 Olá, grupo! Eu sou a *${botDisplayName}*, um bot de WhatsApp. Use "${group.prefix}cmd" para ver os comandos disponíveis.`;
						try {
							const groupJoinPath = path.join(
								this.database.databasePath,
								"textos",
								"groupJoin.txt"
							);

							// Verifica se o arquivo existe
							const fileExists = await fs
								.access(groupJoinPath)
								.then(() => true)
								.catch(() => false);

							if (fileExists) {
								const fileContent = await fs.readFile(groupJoinPath, "utf8");
								if (fileContent && fileContent.trim() !== "") {
									botInfoMessage = fileContent.trim();
									// Substitui variável {prefix} se presente
									botInfoMessage = botInfoMessage.replace(/{prefix}/g, group.prefix ?? "!");
								}
							}
						} catch (readError) {
							this.logger.error("Erro ao ler groupJoin.txt, usando mensagem padrão:", readError);
						}

						let llm_inviterInfo = "";

						// Adiciona informações do convidador se disponíveis
						if (foundInviter && foundInviter.authorName) {
							botInfoMessage += `\n_(Adicionado por: ${foundInviter.authorName})_`;
							llm_inviterInfo = ` '${foundInviter.authorName}'`;
						}

						botInfoMessage += `\n\nO nome do seu grupo foi definido como *${group.name}*.

Para fazer a configuração do grupo sem poluir aqui, envie \`!g-painel\`, ou me envie no PV:
- ${group.prefix}g-manage ${group.name}`;

						// Se encontramos o autor do convite, adiciona-o como admin adicional
						if (foundInviter) {
							// Inicializa additionalAdmins se não existir
							if (!group.additionalAdmins) {
								group.additionalAdmins = [];
							}

							// Adiciona o autor como admin adicional se ainda não estiver na lista
							if (!group.additionalAdmins.includes(foundInviter.authorId)) {
								group.additionalAdmins.push(foundInviter.authorId);
								await this.database.saveGroup(group);
							}
						}

						if (bot.comunitario) {
							if (bot.supportMsg && bot.supportMsg.length > 0) {
								botInfoMessage += `\n---☭---☭---☭---☭---☭---☭---☭---☭---\n${bot.supportMsg}`;
							} else {
								const genericName = bot.nomeExibir || "ravena";
								botInfoMessage += `\n\n⭕ Este é um número da ☭ *${genericName} comunitária* ☭, um chip e celular fornecido por um membro da comunidade da ${genericName}, não o criador oficial. O código, base de dados e servidor é exatamente o mesmo das outras ${genericName}s! ⭕\n_Saiba mais enviando !comunitaria, acessando o site oficial ou no !grupao_`;
							}
						}

						// Gera mensagem de boas-vindas e personalidade do bot usando LLM com json_schema
						try {
							// Extrai informações do grupo para o LLM
							const groupInfo = {
								name: chat.name,
								description: chat.groupMetadata?.desc ?? "",
								memberCount: chat.participants?.length ?? 0
							};

							const groupWelcomeSchema = {
								type: "json_schema",
								json_schema: {
									name: "group_welcome",
									schema: {
										type: "object",
										properties: {
											welcomeMessage: {
												type: "string",
												description:
													"Mensagem de boas-vindas pronta para enviar no grupo, sem placeholders, sucinta, engraçada e interativa"
											},
											botPersonality: {
												type: "string",
												description:
													"Personalidade do bot para este grupo com no máximo 1500 caracteres: deve soar como UM MEMBRO do grupo, usando a mesma linguagem, gírias e tom da galera. Se não conseguir definir, retorne string vazia."
											}
										},
										required: ["welcomeMessage", "botPersonality"],
										additionalProperties: false
									}
								}
							};

							const botDisplayName = bot.nomeExibir || "ravenabot";
							const llmPrompt = `Você é um bot de WhatsApp chamado ${botDisplayName} e foi adicionado em um grupo chamado '${groupInfo.name}'${llm_inviterInfo}. Descrição do grupo: '${groupInfo.description}'. Membros: ${groupInfo.memberCount}.

Retorne um JSON com dois campos:
1. "welcomeMessage": Uma mensagem de boas-vindas PRONTA para ser enviada diretamente no grupo, sem nenhum placeholder como "[foto aqui]" ou "[link]". Deve ser sucinta, engraçada, interativa e direta ao ponto. Use a linguagem e o tom típico desse tipo de grupo.
2. "botPersonality": Uma personalidade curta (máx 1500 caracteres) para o bot neste grupo. O bot deve soar como um MEMBRO do grupo — da mesma tribo, falando a mesma língua, usando as mesmas gírias e referências culturais. Ex para grupo de funk: "Tô no baile, parceiro! Manja de todas as novidades do funk, fala gíria à vontade e tá sempre no clima". Se não conseguir definir, retorne string vazia.`;

							// Obtém conclusão do LLM sem bloquear
							this.llmService
								.getCompletion({
									prompt: llmPrompt,
									response_format: groupWelcomeSchema,
									priority: 5
								})
								.then(async (llmResponse) => {
									if (!llmResponse) return;

									let parsed;
									try {
										const cleanResponse = llmResponse.replace(/```json|```/g, "").trim();
										parsed = JSON.parse(cleanResponse);
									} catch (parseErr) {
										this.logger.warn(
											`[groupJoin] Resposta do LLM não é JSON válido, usando como mensagem direta: ${llmResponse}`
										);
										// Fallback: usa resposta crua como mensagem de boas-vindas
										if (bot.sendJoinInfo !== false) {
											bot.sendMessage(group.id, llmResponse, { delay: 5000 }).catch((error) => {
												this.logger.error(
													"Erro ao enviar mensagem de boas-vindas do grupo:",
													error
												);
											});
										}
										return;
									}

									const { welcomeMessage, botPersonality } = parsed;

									// Envia a mensagem de boas-vindas gerada
									if (welcomeMessage && bot.sendJoinInfo !== false) {
										this.logger.debug(`[groupJoin] LLM Welcome: ${welcomeMessage}`);
										bot.sendMessage(group.id, welcomeMessage, { delay: 5000 }).catch((error) => {
											this.logger.error("Erro ao enviar mensagem de boas-vindas do grupo:", error);
										});
									}

									// Salva personalidade no grupo se for válida
									if (botPersonality && botPersonality.trim().length > 0) {
										group.customAIPrompt = botPersonality.trim().slice(0, 1500);
										await this.database.saveGroup(group);
										this.logger.info(
											`[groupJoin] Personalidade definida para '${group.name}': ${group.customAIPrompt}`
										);
									}

									// Notifica o grupo de logs com os dados gerados
									if (bot.grupoLogs) {
										const logMsg = `🤖✨ *Boas-vindas LLM geradas para novo grupo:*
- 🆔 *ID:* ${group.id}
- 📃 *Nome:* ${group.name}
- 💬 *Mensagem de boas-vindas:*
\`\`\`${welcomeMessage ?? "(nenhuma)"}\`\`\`
- 🧠 *Personalidade definida:*
\`\`\`${botPersonality && botPersonality.trim().length > 0 ? botPersonality.trim() : "(nenhuma)"}\`\`\``;
										bot.sendMessage(bot.grupoLogs, logMsg).catch((error) => {
											this.logger.error("Erro ao enviar log de boas-vindas:", error);
										});
									}
								})
								.catch((error) => {
									this.logger.error("Erro ao gerar mensagem de boas-vindas do grupo:", error);
								});
						} catch (llmError) {
							this.logger.error("Erro ao gerar mensagem de boas-vindas do grupo:", llmError);
						}
					}
				} else {
					if (joinSilencioso) {
						this.logger.info(
							`[groupJoin] 🔇 Join silencioso - Grupo já existente (${group.name} / ${groupId}), boas-vindas suprimidas.`
						);
					} else {
						this.logger.debug(
							`[groupJoin] Grupo já existente! Enviando toda mensagem de boas vindas`
						);
						try {
							const groupJoinExistentePath = path.join(
								this.database.databasePath,
								"textos",
								"groupJoinExistente.txt"
							);

							// Verifica se o arquivo existe
							const fileExists = await fs
								.access(groupJoinExistentePath)
								.then(() => true)
								.catch(() => false);

							if (fileExists) {
								const fileContent = await fs.readFile(groupJoinExistentePath, "utf8");
								if (fileContent && fileContent.trim() !== "") {
									botInfoMessage = fileContent.trim();
									// Substitui variável {prefix} se presente
									botInfoMessage = botInfoMessage.replace(/{prefix}/g, group.prefix ?? "!");
								}

								botInfoMessage += `\n\nO nome do seu grupo está definido como *${group.name}*.

Para fazer a configuração do grupo sem poluir aqui, envie \`!g-painel\`, ou me envie no PV:
- ${group.prefix}g-manage ${group.name}`;
							}
						} catch (readError) {
							this.logger.error(
								"Erro ao ler groupJoinExistente.txt, usando mensagem padrão:",
								readError
							);
							const botDisplayName = bot.nomeExibir || "ravenabot";
							botInfoMessage = `🦇 Olá, grupo! Eu sou a *${botDisplayName}*. Já estive aqui neste grupo antes, mas se tiverem dúvidas, é só mandar um *!cmd*\n\nFique por dentro das novidades:\n- https://ravena.moothz.win`;
						}
					}

					this.logger.debug(`[groupJoin] botInfoMessage: ${botInfoMessage}`);

					let targetId = group.id;
					// Se for Discord, tenta encontrar um canal adequado se o ID do grupo (Guild ID) não for um canal válido
					if (bot.useDiscord && data.origin) {
						try {
							// Append discord.txt if it exists
							try {
								const discordTxtPath = path.join(
									this.database.databasePath,
									"textos",
									"discord.txt"
								);
								const discordTxtContent = await fs.readFile(discordTxtPath, "utf8");
								if (discordTxtContent && discordTxtContent.trim() !== "") {
									botInfoMessage += `\n\n${discordTxtContent.trim()}`;
								}
							} catch (e) {
								// Ignora se arquivo não existir
							}

							const guild = await bot.discordClient.guilds.fetch(data.group.id);
							const systemChannel = guild.systemChannelId;
							if (systemChannel) {
								targetId = systemChannel;
							} else {
								// Busca o primeiro canal de texto onde o bot pode falar
								const channels = await guild.channels.fetch();
								const firstChannel = channels.find(
									(c) =>
										c.isTextBased() &&
										c
											.permissionsFor(bot.discordClient.user)
											.has(PermissionsBitField.Flags.SendMessages)
								);
								if (firstChannel) targetId = firstChannel.id;
							}
						} catch (e) {
							this.logger.error("Erro ao definir canal de boas-vindas no Discord:", e);
						}
					}

					if (!joinSilencioso && botInfoMessage && bot.sendJoinInfo !== false) {
						bot.sendMessage(targetId, botInfoMessage).catch((error) => {
							this.logger.error("Erro ao enviar mensagem de boas-vindas do grupo:", error);
						});
					} else if (joinSilencioso || bot.sendJoinInfo === false) {
						this.logger.info(
							`[groupJoin] 🔇 Join silencioso ou sendJoinInfo desativado - mensagem de boas-vindas suprimida para ${groupId} (${group.name})`
						);
					}
				}
			} else {
				// Caso 2: Outra pessoa entrou no grupo
				// Gera e envia mensagem de boas-vindas para o novo membro
				// this.logger.debug(`[groupJoin] Outra pessoa entrou, greetings?`, {
				// 	greetings: group.greetings
				// });
				if (group.greetings) {
					this.generateGreetingMessage(bot, group, data.user, chat)
						.then((welcomes) => {
							if (welcomes && Array.isArray(welcomes)) {
								for (const welcome of welcomes) {
									const options = welcome.options ?? {};
									if (welcome.mentions) options.mentions = welcome.mentions;

									bot.sendMessage(group.id, welcome.message, options).catch((error) => {
										this.logger.error("Erro ao enviar mensagem de boas-vindas:", error);
									});
								}
							}
						})
						.catch((error) => {
							this.logger.error("Erro ao gerar mensagem de saudação:", error);
						});
				}
			}
		} catch (error) {
			this.logger.error("Erro ao processar entrada no grupo:", error);
		}
	}

	/**
	 * Processa saída do grupo
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} data - Dados do evento
	 */
	async processGroupLeave(bot, data) {
		//this.logger.info(`[processGroupLeave] `, { data });

		this.logger.info(
			`Usuário ${JSON.stringify(data.user.name)} (${data.user.id}) saiu do grupo ${data.group.name} (${data.group.id}). Quem removeu: ${data.responsavel.name}/${data.responsavel.id}`,
			{ quemRemoveu: data.responsavel.name }
		);

		try {
			// Obtém grupo
			const group = this.groups[data.group.id];

			// Por enquanto, a única maneira é pegar a info do grupo pra descobrir o LID do bot nele
			const chatInfo = await bot.getChatDetails(data.group.id);

			// 1° passo: descobrir o lid do bot nesse grupo (identificado via Whatsgo)
			const botNumber = bot.getLidFromPn(bot.phoneNumber, chatInfo);

			// notInGroup é solução nova que coloquei da Go, quando falha ao retornar info do grupo pois o bot não participa
			const isBotLeaving = data.group.notInGroup || data?.user?.id?.startsWith(botNumber);

			//this.logger.debug(`[processGroupLeave] isBotLeaving (${isBotLeaving}}) = data.user.id (${data.user.id}) -startsWith- bot.phoneNumber ${botNumber} | not in group? ${data.group.notInGroup}`, { data, chatInfo });

			// Envia notificação para o grupo de logs
			if (bot.grupoLogs) {
				try {
					if (isBotLeaving) {
						const groupId = data.group.id;
						const groupData = await this.getOrCreateGroup(groupId, null, bot.prefix, null, bot);
						const group = groupData.group;

						if (bot.addSkipGroup) {
							await bot.addSkipGroup(groupId);
						}

						await this.database.recordGroupLeave(
							groupId,
							Date.now(),
							data.responsavel,
							bot?.id || null
						);
						await this.database.saveGroup(group);

						let membershipHistoryText = "";
						let periods = [];
						try {
							periods = await this.database.getGroupMembershipPeriods(groupId);
							if (periods && periods.length > 0) {
								membershipHistoryText = `\n🚪 *Histórico de Estadia no Grupo:*\n`;
								periods.forEach((p, idx) => {
									const joinDate = p.join_timestamp
										? new Date(p.join_timestamp).toLocaleString("pt-BR")
										: "Desconhecido";
									const leaveDate = p.leave_timestamp
										? new Date(p.leave_timestamp).toLocaleString("pt-BR")
										: "Ainda no grupo";

									let durationText = "";
									if (p.duration) {
										const sec = Math.floor(p.duration / 1000);
										const days = Math.floor(sec / 86400);
										const hours = Math.floor((sec % 86400) / 3600);
										const minutes = Math.floor((sec % 3600) / 60);

										const parts = [];
										if (days > 0) parts.push(`${days}d`);
										if (hours > 0) parts.push(`${hours}h`);
										if (minutes > 0) parts.push(`${minutes}m`);
										if (parts.length === 0) parts.push("menos de 1m");
										durationText = ` (${parts.join(" ")})`;
									} else if (p.join_timestamp && p.leave_timestamp) {
										durationText = " (tempo desconhecido)";
									}

									const botTag = p.bot_id ? ` [🤖 ${p.bot_id}]` : "";
									membershipHistoryText += `${idx + 1}.${botTag} 🟢 ${joinDate} até 🔴 ${leaveDate}${durationText}\n`;
								});
							}
						} catch (historyErr) {
							this.logger.error(
								"Erro ao carregar histórico de estadias para log de saída:",
								historyErr
							);
						}

						// Auto-bloqueio se removido em menos de 24 horas e quem removeu não é doador
						// Aplica-se apenas às ravenas normais (não processar para vip, comunitárias e privadas)
						let blockLogsText = "";
						const isNormalBot = !bot.vip && !bot.comunitario && !bot.privado;

						if (isNormalBot) {
							const currentPeriod =
								periods && periods.length > 0 ? periods[periods.length - 1] : null;
							const durationMs =
								currentPeriod?.duration ??
								(currentPeriod?.join_timestamp ? Date.now() - currentPeriod.join_timestamp : null);
							const isLessThan24h =
								durationMs !== null
									? durationMs < 24 * 60 * 60 * 1000
									: group.date
										? Date.now() - group.date < 24 * 60 * 60 * 1000
										: false;

							const removerId = data.responsavel?.id || null;
							const cleanRemoverPhone = removerId
								? removerId.replace(/\D/g, "").split("@")[0]
								: null;
							const botCleanPhone = bot.phoneNumber ? bot.phoneNumber.replace(/\D/g, "") : null;
							const isRemovedBySelf =
								cleanRemoverPhone && botCleanPhone && cleanRemoverPhone === botCleanPhone;
							const isRemoverSuperAdmin = removerId
								? this.adminUtils.isSuperAdmin(removerId)
								: false;

							if (isLessThan24h && cleanRemoverPhone && !isRemovedBySelf && !isRemoverSuperAdmin) {
								let isRemoverDonator = false;
								try {
									const donations = await this.database.getDonations();
									if (donations && donations.length > 0) {
										isRemoverDonator = donations.some((donation) => {
											if (donation.numero) {
												const cleanDonorNumber = donation.numero.replace(/[^0-9]/g, "");
												if (cleanDonorNumber.length > 10) {
													return (
														cleanDonorNumber.includes(cleanRemoverPhone) ||
														cleanRemoverPhone.includes(cleanDonorNumber)
													);
												}
											}
											return false;
										});
									}
								} catch (donErr) {
									this.logger.error("Erro ao verificar doador para quem removeu o bot:", donErr);
								}

								if (!isRemoverDonator) {
									this.logger.info(
										`[processGroupLeave] Bot normal '${bot.id}' removido em <24h (${durationMs}ms) por não-doador (${cleanRemoverPhone}) do grupo ${groupId}. Executando bloqueios...`
									);

									// 1. Busca código de convite e autor do convite
									let inviteCode = group.inviteCode || null;
									let inviterId = group.addedBy || null;

									try {
										const inviteHistory = await this.database.getInviteHistoryByGroup(groupId);
										if (inviteHistory && inviteHistory.length > 0) {
											const latestInvite =
												inviteHistory.find((r) => r.invite_code) || inviteHistory[0];
											if (latestInvite) {
												if (!inviteCode && latestInvite.invite_code) {
													inviteCode = latestInvite.invite_code;
												}
												if (!inviterId && latestInvite.author_id) {
													inviterId = latestInvite.author_id;
												}
											}
										}
									} catch (invErr) {
										this.logger.error(
											"Erro ao buscar histórico de convites para auto-block:",
											invErr
										);
									}

									const cleanInviterPhone = inviterId
										? inviterId.replace(/\D/g, "").split("@")[0]
										: null;

									const blockLogParts = [];

									// 2. Executa block no convite
									if (cleanInviterPhone || inviteCode) {
										const inviteArgs = [];
										if (cleanInviterPhone) inviteArgs.push(cleanInviterPhone);
										if (inviteCode) inviteArgs.push(inviteCode);

										const inviteCmd = `!sa-blockInvites ${inviteArgs.join(" ")}`.trim();
										try {
											const inviteBlockRes = await this.commandHandler.superAdmin.blockInvites(
												bot,
												{ group: groupId, author: cleanInviterPhone, isSystem: true },
												inviteArgs
											);
											if (inviteBlockRes && inviteBlockRes.content) {
												blockLogParts.push(`> *${inviteCmd}*\n${inviteBlockRes.content}`);
											}
										} catch (cmdErr) {
											this.logger.error("Erro ao rodar blockInvites no convite:", cmdErr);
										}
									}

									// 3. Executa block em quem removeu
									if (cleanRemoverPhone && cleanRemoverPhone !== cleanInviterPhone) {
										const removerCmd = `!sa-blockInvites ${cleanRemoverPhone}`;
										try {
											const removerBlockRes = await this.commandHandler.superAdmin.blockInvites(
												bot,
												{ group: groupId, author: cleanRemoverPhone, isSystem: true },
												[cleanRemoverPhone]
											);
											if (removerBlockRes && removerBlockRes.content) {
												blockLogParts.push(`> *${removerCmd}*\n${removerBlockRes.content}`);
											}
										} catch (cmdErr) {
											this.logger.error("Erro ao rodar blockInvites em quem removeu:", cmdErr);
										}
									}

									if (blockLogParts.length > 0) {
										blockLogsText = `\n\n🛡️ *Bloqueio de convites (< 24h & não doador):*\n${blockLogParts.join("\n\n")}`;
									}
								}
							}
						}

						const msgLeave = `🚪🔴 *${bot.id}* saiu do grupo:
- 🆔 *ID:* \`${group.id}\`
- 📃 *Nome:* \`${group.name}\`
- 👷‍♂️ *Responsável:*
\`\`\`${JSON.stringify(data.responsavel, null, "\t")}\`\`\`
- 👨‍💻 *Raw Data*:
\`\`\`${JSON.stringify(data.group)}\`\`\`${membershipHistoryText}${blockLogsText}`;

						// Remove o responsável do bot comunitário dos admins adicionais
						/* por enquanto desabilitado
						if (bot.comunitario && bot.numeroResponsavel) {
							const respNum = bot.numeroResponsavel.replace(/\D/g, "");
							if (group.additionalAdmins && Array.isArray(group.additionalAdmins)) {
								const originalLength = group.additionalAdmins.length;
								group.additionalAdmins = group.additionalAdmins.filter(
									(admin) => admin.replace(/\D/g, "") !== respNum
								);

								if (group.additionalAdmins.length !== originalLength) {
									await this.database.saveGroup(group);
									this.logger.info(
										`[EventHandler] Bot comunitário '${bot.id}' saiu do grupo, administrador ${respNum} foi removido dos additionalAdmins do grupo ${group.name}`
									);
								}
							}
						}
						*/

						bot.sendMessage(bot.grupoLogs, msgLeave).catch((error) => {
							this.logger.error(
								"Erro ao enviar notificação de saída do grupo para o grupo de logs:",
								error
							);
						});
					}
				} catch (error) {
					this.logger.error(
						"Erro ao enviar notificação de saída do grupo para o grupo de logs:",
						error
					);
				}
			}

			// this.logger.debug(`[groupLeave] Outra pessoa saiu, farewell? `, {
			// 	farewells: group?.farewells
			// });
			if (group && group.farewells && !isBotLeaving) {
				const farewells = await this.processFarewellMessage(group, data.user, bot);
				if (farewells && Array.isArray(farewells)) {
					for (const farewell of farewells) {
						const options = farewell.options ?? {};
						if (farewell.mentions) options.mentions = farewell.mentions;

						bot.sendMessage(data.group.id, farewell.message, options).catch((error) => {
							this.logger.error("Erro ao enviar mensagem de despedida:", error);
						});
					}
				}
			}
		} catch (error) {
			this.logger.error("Erro ao processar saída do grupo:", error);
		}
	}
	/**
	 * Gera mensagem de saudação para novos membros do grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Group} group - O objeto do grupo
	 * @param {Object} user - O usuário que entrou
	 * @param {Object} chatData - Dados adicionais do chat (opcional)
	 * @returns {Promise<Array<{message: string|MessageMedia, options: Object, mentions: Array}>>} - Array de mensagens de saudação
	 */
	async generateGreetingMessage(bot, group, user, chatData = null) {
		try {
			if (!group.greetings) return [];

			// Obtém os dados completos do chat, se não fornecidos
			if (!chatData) {
				try {
					// Tenta obter o chat para mais informações
					chatData = await bot.client.getChatById(group.id);
				} catch (error) {
					this.logger.error("Erro ao obter dados do chat para saudação:", error);
				}
			}

			// Se houver múltiplos usuários, prepara os nomes
			const nomesPessoas = "";
			let numeroPessoas = "";
			let quantidadePessoas = 1;
			let isPlural = false;
			let baseMentions = [];

			if (Array.isArray(user)) {
				numeroPessoas = user.map((u) => `@${u.id.split("@")[0]}` ?? "@123456780").join(", ");
				quantidadePessoas = user.length;
				isPlural = quantidadePessoas > 1;
				baseMentions = user.map((u) => u.id);
			} else {
				numeroPessoas = `@${user.id.split("@")[0]}` ?? "@123456780";
				baseMentions = [user.id];
			}

			// Filtra tipos de greeting disponíveis
			const availableTypes = Object.keys(group.greetings).filter((type) => group.greetings[type]);

			if (availableTypes.length === 0) return [];

			const messagesToSend = [];

			// Função auxiliar para processar texto com variáveis
			const processText = async (text, mentionsList) => {
				if (!text) return { text: "", mentions: [] };
				let message = typeof text === "string" ? text : "";

				// Se text for objeto (legado/erro), tenta extrair texto ou ignora
				if (typeof text === "object") {
					this.logger.warn("processText recebeu um objeto, ignorando ou convertendo:", text);
					// Se tiver propriedade 'text' ou 'caption', usa
					message = text.text || text.caption || "";
					if (typeof message !== "string") message = "";
				}

				// Variáveis básicas
				message = message.replace(/{pessoa}/g, numeroPessoas);

				// Variáveis de grupo
				message = message.replace(/{tituloGrupo}/g, chatData?.name ?? "Grupo");
				message = message.replace(/{nomeGrupo}/g, group?.name ?? "Grupo");
				message = message.replace(/{nomePessoas}/g, numeroPessoas);
				message = message.replace(/{numeroPessoas}/g, numeroPessoas);

				// Variáveis de pluralidade
				if (isPlural) {
					message = message.replace(/{plural_S}/g, "s");
					message = message.replace(/{plural_M}/g, "m");
					message = message.replace(/{plural_s}/g, "s");
					message = message.replace(/{plural_m}/g, "m");
					message = message.replace(/{plural_esao}/g, "são");
				} else {
					message = message.replace(/{plural_S}/g, "");
					message = message.replace(/{plural_M}/g, "");
					message = message.replace(/{plural_s}/g, "");
					message = message.replace(/{plural_m}/g, "");
					message = message.replace(/{plural_esao}/g, "é");
				}

				// Processa variáveis
				const options = { mentions: [...mentionsList] };
				message = await this.variableProcessor.process(message, {
					message: false,
					group,
					options,
					bot
				});

				return { text: message, mentions: options.mentions || [] };
			};

			const hasMediaWithCaption = availableTypes.some(
				(t) => t !== "text" && (group.greetings[t]?.caption || group.greetings.text)
			);

			for (const type of availableTypes) {
				const greetingData = group.greetings[type];
				let currentMentions = [...baseMentions];

				// Se saudação de texto
				if (type === "text") {
					if (hasMediaWithCaption) {
						// Pula envio do texto avulso pois a legenda já irá junto da mídia
						continue;
					}
					const processed = await processText(greetingData, baseMentions); // greetingData is the string itself for text type
					currentMentions = [...new Set([...currentMentions, ...processed.mentions])];

					messagesToSend.push({
						message: processed.text,
						options: { mentions: currentMentions },
						mentions: currentMentions
					});
				}
				// Se for mídia (image, video, audio, sticker)
				else if (greetingData && greetingData.file) {
					const mediaPath = path.join(this.database.databasePath, "media", greetingData.file);

					try {
						// Verifica se arquivo existe
						await fs.access(mediaPath);

						const fileBuffer = require("fs").readFileSync(mediaPath);
						const mimeType = require("mime-types").lookup(mediaPath) || "application/octet-stream";
						const media = {
							mimetype: mimeType,
							data: fileBuffer.toString("base64"),
							filename: require("path").basename(mediaPath),
							isMessageMedia: true
						};

						// Processa caption se houver (audio e sticker ignoram caption no envio, mas a gente processa igual)
						let caption = "";
						if (type !== "audio" && type !== "sticker") {
							let rawCaption = typeof greetingData.caption === "string" ? greetingData.caption : "";
							if (!rawCaption && typeof group.greetings.text === "string" && group.greetings.text) {
								rawCaption = group.greetings.text;
							}
							const processedCaption = await processText(rawCaption, baseMentions);
							caption = processedCaption.text;
							currentMentions = [...new Set([...currentMentions, ...processedCaption.mentions])];
						}

						// Retorna objeto pronto para sendMessage
						messagesToSend.push({
							message: media,
							options: {
								caption,
								mentions: currentMentions,
								sendAudioAsVoice: type === "audio",
								sendMediaAsSticker: type === "sticker",
								sendVideoAsGif: type === "gif"
							},
							mentions: currentMentions
						});
					} catch (err) {
						this.logger.error(`Erro ao carregar mídia de greeting (${mediaPath}):`, err);
						// Fallback para texto se falhar ao carregar mídia e houver texto configurado (mas não duplicar se o loop já cobrir 'text')
						// Como o loop passa por todos os types, se 'text' estiver configurado, ele será processado separadamente.
						// Então aqui apenas logamos o erro.
					}
				}
			}

			return messagesToSend;
		} catch (error) {
			this.logger.error("Erro ao gerar mensagem de saudação:", error);
			return [];
		}
	}

	/**
	 * Processa mensagem de despedida para membros que saem do grupo
	 * @param {Group} group - O objeto do grupo
	 * @param {Object} user - O usuário que saiu
	 * @returns {Promise<Array<{message: string|MessageMedia, options: Object, mentions: Array}>>} - Array de mensagens de despedida
	 */
	async processFarewellMessage(group, user, bot, chatData) {
		try {
			if (!group.farewells) return [];

			// Obtém os dados completos do chat, se não fornecidos
			if (!chatData) {
				try {
					// Tenta obter o chat para mais informações
					chatData = await bot.client.getChatById(group.id);
				} catch (error) {
					this.logger.error("Erro ao obter dados do chat para despedidas:", error);
				}
			}

			const availableTypes = Object.keys(group.farewells).filter((type) => group.farewells[type]);
			if (availableTypes.length === 0) return [];

			const messagesToSend = [];
			const baseMentions = [user.id];

			const processText = async (text, mentionsList) => {
				if (!text) return { text: "", mentions: [] };
				let message = typeof text === "string" ? text : "";

				if (typeof text === "object") {
					message = text.text || text.caption || "";
					if (typeof message !== "string") message = "";
				}

				message = message.replace(/{pessoa}/g, `@${user.id.split("@")[0]}`);
				message = message.replace(/{tituloGrupo}/g, chatData?.name ?? "Grupo");

				// Processa variáveis
				const options = { mentions: [...mentionsList] };
				message = await this.variableProcessor.process(message, {
					message: false,
					group,
					options,
					bot
				});

				return { text: message, mentions: options.mentions || [] };
			};

			for (const type of availableTypes) {
				const farewellData = group.farewells[type];
				let currentMentions = [...baseMentions];

				// Se despedida de texto
				if (type === "text") {
					const processed = await processText(farewellData, baseMentions);
					currentMentions = [...new Set([...currentMentions, ...processed.mentions])];

					messagesToSend.push({
						message: processed.text,
						options: { mentions: currentMentions },
						mentions: currentMentions
					});
				}
				// Se for mídia
				else if (farewellData && farewellData.file) {
					const mediaPath = path.join(this.database.databasePath, "media", farewellData.file);

					try {
						await fs.access(mediaPath);
						const fileBuffer = require("fs").readFileSync(mediaPath);
						const mimeType = require("mime-types").lookup(mediaPath) || "application/octet-stream";
						const media = {
							mimetype: mimeType,
							data: fileBuffer.toString("base64"),
							filename: require("path").basename(mediaPath),
							isMessageMedia: true
						};

						let caption = "";
						if (type !== "audio" && type !== "sticker") {
							const rawCaption =
								typeof farewellData.caption === "string" ? farewellData.caption : "";
							const processedCaption = await processText(rawCaption, baseMentions);
							caption = processedCaption.text;
							currentMentions = [...new Set([...currentMentions, ...processedCaption.mentions])];
						}

						messagesToSend.push({
							message: media,
							options: {
								caption,
								mentions: currentMentions,
								sendAudioAsVoice: type === "audio",
								sendMediaAsSticker: type === "sticker",
								sendVideoAsGif: type === "gif"
							},
							mentions: currentMentions
						});
					} catch (err) {
						this.logger.error(`Erro ao carregar mídia de farewell (${mediaPath}):`, err);
					}
				}
			}

			return messagesToSend;
		} catch (error) {
			this.logger.error("Erro ao processar mensagem de despedida:", error);
			return [];
		}
	}

	/**
	 * Manipula notificações gerais
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} notification - A notificação
	 */
	onNotification(bot, notification) {
		// Implementação opcional para tratar outros tipos de notificações
	}

	/**
	 * Exemplo de método que verifica permissões administrativas
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 * @param {string} action - A ação a ser realizada
	 * @param {Group} group - O objeto do grupo
	 * @returns {Promise<boolean>} - True se a ação for permitida
	 */
	async checkPermission(bot, message, action, group) {
		try {
			// Obtém o chat diretamente da mensagem original
			const chat = await message.origin.getChat();

			// Usa o AdminUtils para verificar permissões
			const isAdmin = await this.adminUtils.isAdmin(message.author, group, chat, bot);

			if (!isAdmin) {
				this.logger.warn(
					`Usuário ${message.author} tentou realizar a ação "${action}" sem permissão`
				);

				// Notifica o usuário (opcional)
				const returnMessage = new ReturnMessage({
					chatId: message.group ?? message.author,
					content: `⛔ Você não tem permissão para realizar esta ação: ${action}`
				});
				await bot.sendReturnMessages(returnMessage, group);

				return false;
			}

			return true;
		} catch (error) {
			this.logger.error(`Erro ao verificar permissões para ação "${action}":`, error);
			return false;
		}
	}
	async checkAutoBanSpammers(bot, chat) {
		const fixedGroups = [
			process.env.GRUPO_INTERACAO,
			process.env.GRUPO_PESCA,
			process.env.GRUPO_DOWNLOADS
		].filter(Boolean);

		const chatId = chat.id._serialized || chat.id;
		//this.logger.debug(`[checkAutoBanSpammers][${chatId}]`, { fixedGroups });
		if (fixedGroups.length === 0) return;

		if (!fixedGroups.includes(chatId)) return;

		const participants = chat.Participants || chat.participants || [];

		const spammers = participants.filter((p) => {
			const phone = p.phoneNumber || "";
			return phone.startsWith("63") || phone.startsWith("62");
		});

		//this.logger.debug(`[checkAutoBanSpammers][${chatId}]`, { participants, spammers });

		if (spammers.length > 0) {
			const spammersJids = spammers.map((s) => {
				// Prioritize the phone number JID (@s.whatsapp.net) over LID
				if (s.phoneNumber) {
					const cleanPhone = s.phoneNumber.split("@")[0];
					return `${cleanPhone}@s.whatsapp.net`;
				}
				return s.id._serialized || s.id;
			});
			this.logger.info(
				`[checkAutoBanSpammers] Detectados ${spammers.length} spammers no grupo ${chatId}`,
				{
					spammersJids
				}
			);

			// Ativa a janela de monitoramento intenso por 5 minutos
			this.spammerActiveWindowUntil = Date.now() + 5 * 60 * 1000;

			// Adiciona à lista de spammers ativos para deletar mensagens
			for (const spammer of spammersJids) {
				this.activeSpammers.add(spammer);
				const cleanPhone = spammer.split("@")[0];
				this.activeSpammers.add(cleanPhone);

				// Remove do set após 5 minutos
				setTimeout(
					() => {
						this.activeSpammers.delete(spammer);
						this.activeSpammers.delete(cleanPhone);
					},
					5 * 60 * 1000
				);
			}

			// Remove do grupo
			await bot.removeFromGroup(chatId, spammersJids);

			// Se for comunidade, remove da comunidade também
			const communityJid = chat.linkedParentJid;
			if (communityJid) {
				this.logger.info(`[checkAutoBanSpammers] Removendo spammers da comunidade ${communityJid}`);
				await bot.removeFromCommunity(communityJid, spammersJids);
			}
		}
	}

	/**
	 * Verifica se a mensagem recebida é de um spammer durante a janela ativa de prevenção
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem recebida
	 * @returns {Promise<boolean>} - True se a mensagem for de spammer e foi apagada
	 */
	async checkSpammerMessage(bot, message) {
		const fixedGroups = [
			process.env.GRUPO_INTERACAO,
			process.env.GRUPO_PESCA,
			process.env.GRUPO_DOWNLOADS
		].filter(Boolean);

		if (!message.group || !fixedGroups.includes(message.group)) {
			return false;
		}

		const now = Date.now();
		const isWindowActive = now < this.spammerActiveWindowUntil;

		// Se a janela ativa estiver desativada e não houver spammers específicos na lista, não faz nada
		if (!isWindowActive && this.activeSpammers.size === 0) {
			return false;
		}

		// Verifica se o autor ou authorAlt é spammer
		const isSpammer =
			this.activeSpammers.has(message.author) ||
			(message.authorAlt && this.activeSpammers.has(message.authorAlt)) ||
			(isWindowActive &&
				(message.author?.startsWith("63") ||
					message.author?.startsWith("62") ||
					(message.authorAlt &&
						(message.authorAlt.startsWith("63") || message.authorAlt.startsWith("62")))));

		if (isSpammer) {
			this.logger.warn(
				`[SpamPrevention] Janela ativa: ${isWindowActive ? "SIM" : "NÃO"}. Deletando mensagem de spammer ${message.author} no grupo ${message.group}`
			);
			if (message.key) {
				await bot.deleteMessageByKey(message.key).catch((err) => {
					this.logger.error("Erro ao deletar mensagem de spammer:", err);
				});
			}
			return true;
		}

		return false;
	}

	/**
	 * Manipula evento de alteração de configuração do grupo (como fechar/abrir)
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} data - Dados do evento
	 */
	onGroupSettingsUpdate(bot, data) {
		this.processGroupSettingsUpdate(bot, data).catch((error) => {
			this.logger.error("Erro em processGroupSettingsUpdate:", error);
		});
	}

	async processGroupSettingsUpdate(bot, data) {
		const { groupId, announce, sender } = data;
		const senderPhone = sender ? sender.split("@")[0] : "desconhecido";

		this.logger.info(
			`[processGroupSettingsUpdate] Grupo ${groupId} atualizado. announce=${announce}, alterado por ${senderPhone}`
		);

		// Carrega ou obtém o grupo
		const groupData = await this.getOrCreateGroup(groupId, null, bot.prefix, null, bot);
		const group = groupData.group;

		// Se a alteração foi feita pelo próprio bot (enquanto executa os comandos abir/fechar), não precisamos reenviar notificação
		const isMe = senderPhone === bot.phoneNumber;
		if (isMe) {
			this.logger.debug(
				`[processGroupSettingsUpdate] Alteração feita pelo próprio bot. Ignorando notificação de repetição.`
			);
			return;
		}

		// Verifica se a notificação está ativada para o estado correspondente
		if (announce && !group.notificaGrupoFechado) {
			this.logger.debug(
				`[processGroupSettingsUpdate] Notificação de grupo fechado desativada para o grupo ${groupId}.`
			);
			return;
		}
		if (!announce && !group.notificaGrupoAberto) {
			this.logger.debug(
				`[processGroupSettingsUpdate] Notificação de grupo aberto desativada para o grupo ${groupId}.`
			);
			return;
		}

		// Notifica no grupo sobre a alteração (sem expor quem alterou, usando bold no status)
		const statusMsg = announce
			? "🔒 *Grupo fechado.* Apenas administradores podem enviar mensagens agora."
			: "🔓 *Grupo aberto.* Todos os participantes podem enviar mensagens agora.";

		const returnMsg = new ReturnMessage({
			chatId: groupId,
			content: statusMsg
		});

		await bot.sendReturnMessages(returnMsg, group);
	}

	/**
	 * Obtém a instância única do EventHandler
	 * @returns {EventHandler}
	 */
	static getInstance() {
		if (!EventHandler.instance) {
			EventHandler.instance = new EventHandler();
		}
		return EventHandler.instance;
	}
}

module.exports = EventHandler;
