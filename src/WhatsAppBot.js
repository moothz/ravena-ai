const { Client, Contact, LocalAuth, MessageMedia, Location, version } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const qrimg = require("qr-image");
const Database = require("./utils/Database");
const Logger = require("./utils/Logger");
const path = require("path");
const fs = require("fs");
const LoadReport = require("./LoadReport");
const ReactionsHandler = require("./ReactionsHandler");
const MentionHandler = require("./MentionHandler");
const InviteSystem = require("./InviteSystem");
const StreamSystem = require("./StreamSystem");
const LLMService = require("./services/LLMService");
const AdminUtils = require("./utils/AdminUtils");
const { messageMediaToOpus } = require("./utils/Conversions");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class WhatsAppBot {
	/**
	 * Cria uma nova instância de bot WhatsApp
	 * @param {Object} options - Opções de configuração
	 * @param {string} options.id - Identificador único para esta instância de bot
	 * @param {string} options.phoneNumber - Número de telefone para solicitar código de pareamento
	 * @param {Object} options.eventHandler - Instância do manipulador de eventos
	 * @param {string} options.prefix - Prefixo de comando (padrão: '!')
	 * @param {Object} options.puppeteerOptions - Opções para o puppeteer
	 * @param {Array} options.otherBots - Instâncias de outros bots a serem ignorados
	 */
	constructor(options) {
		this.id = options.id;
		this.vip = options.vip;
		this.comunitario = options.comunitario;
		this.numeroResponsavel = options.numeroResponsavel;
		this.supportMsg = options.supportMsg;
		this.phoneNumber = options.phoneNumber;
		this.eventHandler = options.eventHandler;
		this.prefix = options.prefix || process.env.DEFAULT_PREFIX || "!";
		this.logger = new Logger(`bot-${this.id}`);
		this.client = null;
		this.database = Database.getInstance(); // Instância de banco de dados compartilhada
		this.isConnected = false;
		this.version = version ?? "wwebjs";
		this.wwebversion = "0";
		this.safeMode =
			options.safeMode !== undefined ? options.safeMode : process.env.SAFE_MODE === "true";
		this.puppeteerOptions = options.puppeteerOptions || {};
		this.otherBots = options.otherBots || [];
		this.notificarDonate = options.notificarDonate;
		this.pvAI = options.pvAI;
		this.banido = options.banido;

		// Acesso pelo painel por terceiros
		this.privado = options.privado ?? false;
		this.managementUser = options.managementUser ?? process.env.BOTAPI_USER ?? "admin";
		this.managementPW = options.managementPW ?? process.env.BOTAPI_PASSWORD ?? "batata123";

		this.ignorePV = options.ignorePV || false;
		this.whitelist = options.whitelistPV || [];
		this.ignoreInvites = options.ignoreInvites || false;
		this.grupoLogs = options.grupoLogs || process.env.GRUPO_LOGS;
		this.grupoInvites = options.grupoInvites || process.env.GRUPO_INVITES;
		this.grupoAvisos = options.grupoAvisos || process.env.GRUPO_AVISOS;
		this.grupoAnuncios = options.grupoAnuncios || process.env.GRUPO_ANUNCIOS;
		this.grupoInteracao = options.grupoInteracao || process.env.GRUPO_INTERACAO;
		this.grupoEstabilidade = options.grupoEstabilidade || process.env.GRUPO_ESTABILIDADE;
		this.linkGrupao = options.linkGrupao || process.env.LINK_GRUPO_INTERACAO;
		this.linkAvisos = options.linkAvisos || process.env.LINK_GRUPO_AVISOS;
		this.userAgent =
			options.userAgent ||
			process.env.USER_AGENT ||
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0";

		this.lastMessageReceived = Date.now();

		// Nova propriedade para controlar mensagens após inicialização
		this.startupTime = Date.now();

		// Inicializa rastreador de relatórios de carga
		this.loadReport = new LoadReport(this);

		// Inicializa sistema de convites
		this.inviteSystem = new InviteSystem(this);

		// Inicializa manipulador de menções
		this.mentionHandler = new MentionHandler();

		// Inicializa manipulador de reações
		this.reactionHandler = new ReactionsHandler();

		// Inicializa StreamSystem (será definido em initialize())
		this.streamSystem = null;
		this.streamMonitor = null;

		// Pro painel
		this.status = "INITIALIZING";

		this.skipGroupInfo = [];

		// Monitora estabilidade dos bots entre eles
		this.stabilityMonitor = options.stabilityMonitor ?? false;

		this.llmService = LLMService.getInstance();
		this.adminUtils = AdminUtils.getInstance();

		this.sessionDir = path.join(__dirname, "..", ".wwebjs_auth", this.id);
	}

	async _loadSkipGroupInfo() {
		try {
			const SkipGroups = require("./utils/SkipGroups");
			this.skipGroupInfo = await SkipGroups.getInstance().getSkippedGroups(this.id);
			this.logger.info(
				`[SkipGroups] Carregados ${this.skipGroupInfo.length} grupos ignorados para o bot ${this.id}.`
			);
		} catch (error) {
			this.logger.error(`[SkipGroups] Erro ao carregar grupos ignorados:`, error);
			this.skipGroupInfo = [];
		}
	}

	async addSkipGroup(groupId) {
		if (!this.skipGroupInfo.includes(groupId)) {
			this.skipGroupInfo.push(groupId);
			const SkipGroups = require("./utils/SkipGroups");
			await SkipGroups.getInstance().addSkippedGroup(this.id, groupId);
			this.logger.info(`[SkipGroups] Grupo ${groupId} adicionado à lista de ignorados.`);
		}
	}

	async removeSkipGroup(groupId) {
		const initialLength = this.skipGroupInfo.length;
		this.skipGroupInfo = this.skipGroupInfo.filter((id) => id !== groupId);
		if (this.skipGroupInfo.length < initialLength) {
			const SkipGroups = require("./utils/SkipGroups");
			await SkipGroups.getInstance().removeSkippedGroup(this.id, groupId);
			this.logger.info(`[SkipGroups] Grupo ${groupId} removido da lista de ignorados.`);
		}
	}

	/**
	 * Inicializa o cliente WhatsApp
	 */
	async initialize() {
		this.logger.info(`Inicializando instância de bot ${this.id}, prefixo ${this.prefix}. `, {
			grupoLogs: this.grupoLogs,
			grupoInvites: this.grupoInvites,
			grupoAvisos: this.grupoAvisos,
			grupoAnuncios: this.grupoAnuncios,
			grupoInteracao: this.grupoInteracao,
			grupoEstabilidade: this.grupoEstabilidade
		});

		await this._loadSkipGroupInfo();

		this.database.registerBotInstance(this);

		// Atualiza o tempo de inicialização
		this.startupTime = Date.now();

		// Cria cliente com dados de sessão
		this.client = new Client({
			authStrategy: new LocalAuth({ clientId: this.id }),
			puppeteer: this.puppeteerOptions,
			userAgent: this.userAgent
		});

		this.logger.info(
			`[whitelist][${this.id}] ${this.whitelist.length} números na whitelist do PV.`
		);

		// Registra manipuladores de eventos
		this.registerEventHandlers();

		// Inicializa cliente
		await this.client.initialize();

		return this;
	}

	notInWhitelist(author) {
		const cleanAuthor = author.replace(/\D/g, "");
		return !this.whitelist.includes(cleanAuthor);
	}

	rndString() {
		return (Math.random() + 1).toString(36).substring(7);
	}

	/**
	 * Prepara a lista de IDs de outros bots para serem ignorados
	 */
	prepareOtherBotsBlockList() {
		if (!this.otherBots || !this.otherBots.length) return;

		// Garante que blockedContacts seja um array
		if (!this.blockedContacts || !Array.isArray(this.blockedContacts)) {
			this.blockedContacts = [];
		}

		// Adiciona IDs dos outros bots à lista de bloqueados
		for (const bot of this.otherBots) {
			const botId = bot.endsWith("@c.us") ? botId : `${bot}@c.us`;
			this.blockedContacts.push({
				id: {
					_serialized: botId
				},
				name: `Bot: ${bot.id || "desconhecido"}`
			});

			this.logger.info(`Adicionado bot '${bot.id}' (${botId}) à lista de ignorados`);
		}

		// Atualiza o banco de dados com os novos contatos bloqueados (bots)
		this.database.addBlockedContacts(
			"wwebjs",
			this.blockedContacts.map((c) => c.id._serialized)
		);

		this.logger.info(
			`Lista de ignorados atualizada: ${this.blockedContacts.length} contatos/bots`,
			this.blockedContacts
		);
	}

	/**
	 * Verifica se uma mensagem está dentro do período inicial de descarte
	 * @returns {boolean} - True se a mensagem deve ser descartada
	 */
	shouldDiscardMessage() {
		const timeSinceStartup = Date.now() - this.startupTime;
		return timeSinceStartup < 5000; // 5 segundos
	}

	// Pra uso na interface web, adaptar
	async _checkInstanceStatusAndConnect(isRetry = false) {
		this.logger.info(`Checking instance status for ${this.id}...`);
		try {
			const extra = { ok: false, connectData: {} };

			// No WWEBjs:
			// INITIALIZING
			// PAIRING (qrcode ou código)
			// CONNECTED
			// DISCONNECTED
			const instanceDetails = {
				instance: {
					instanceName: this.id,
					state: this.status
				}
			};

			instanceDetails.version = this.version;
			instanceDetails.tipo = "wwebjs";
			if (this.status === "CONNECTED") {
				// open não era pra ser
				extra.ok = true;
			} else if (this.status === "INITIALIZING") {
				extra.ok = false;
				extra.connectData.pairingCode = "AGUARDE";
				extra.connectData.code = "";
			} else if (this.status === "DISCONNECTED") {
				extra.ok = false;
				extra.connectData.pairingCode = "DESCONECTADO";
				extra.connectData.code = "";
			} else if (this.status === "PAIRING") {
				extra.ok = false;
				extra.connectData.pairingCode = this.lastPairingCode;
				extra.connectData.code = this.lastQR; // código cru da leitura do qrcode
			}

			return { instanceDetails, extra };
		} catch (error) {
			this.logger.error(`Error checking/connecting instance ${this.id}:`, error);
			// Schedule a retry or notify admin?
			return { instanceDetails: {}, error };
		}
	}

	/**
	 * Registra manipuladores de eventos para o cliente WhatsApp
	 */
	registerEventHandlers() {
		// Evento de QR Code
		this.client.on("qr", (qr) => {
			this.status = "PAIRING";
			this.lastQR = qr;
			this.lastPairingCode = "";
			const qrCodeLocal = path.join(this.database.databasePath, "qrcodes", `qrcode_${this.id}.png`);
			const qr_png = qrimg.image(qr, { type: "png" });
			qr_png.pipe(fs.createWriteStream(qrCodeLocal));

			this.logger.info(
				`QR Code recebido, escaneie para autenticar a '${this.id}'\n\t-> ${qrCodeLocal}`
			);
			this.logger.info(qr);
			qrcode.generate(qr, { small: true });
			this.logger.info(`------------ qrcode '${this.id}' -----------`);
		});

		// Evento de pronto
		this.client.on("ready", async () => {
			this.isConnected = true;
			this.logger.info(`[${this.id}] Conectado no whats.`);
			this.eventHandler.onConnected(this);
			this.status = "CONNECTED";

			// Envia notificação de inicialização para o grupo de logs
			if (this.grupoLogs && this.isConnected) {
				try {
					const startMessage = `🤖 Bot ${this.id} inicializado com sucesso em ${new Date().toLocaleString("pt-BR")}`;
					await this.sendMessage(this.grupoLogs, startMessage);
				} catch (error) {
					this.logger.error("Erro ao enviar notificação de inicialização:", error);
				}
			}

			if (this.grupoAvisos && this.isConnected) {
				try {
					const startMessage = `🟢 [${this.phoneNumber.slice(2, 4)}] *${this.id}* tá _on_! (${new Date().toLocaleString("pt-BR")})`;
					this.logger.debug(
						`Enviando startMessage no grupoAvisos: `,
						startMessage,
						this.grupoAvisos
					);
					//await this.sendMessage(this.grupoAvisos, startMessage);
				} catch (error) {
					this.logger.error("Erro ao enviar notificação de inicialização:", error);
				}
			}

			try {
				this.blockedContacts = await this.client.getBlockedContacts();
				this.logger.info(`Carregados ${this.blockedContacts.length} contatos bloqueados`);

				// Adiciona ao banco de dados compartilhado
				this.database.addBlockedContacts(
					"wwebjs",
					this.blockedContacts.map((c) => c.id._serialized)
				);

				if (this.isConnected && this.otherBots.length > 0) {
					this.prepareOtherBotsBlockList();
				}
			} catch (error) {
				this.logger.error("Erro ao carregar contatos bloqueados:", error);
				this.blockedContacts = [];
			}

			// Inicializa o sistema de streaming agora que estamos conectados
			this.streamSystem = StreamSystem.getInstance();
			this.streamSystem.registerBot(this);
			await this.streamSystem.initialize();
			this.streamMonitor = this.streamSystem.streamMonitor;
		});

		// Evento de autenticado
		this.client.on("authenticated", () => {
			this.logger.info("Cliente autenticado");
		});

		// Evento de falha de autenticação
		this.client.on("auth_failure", (msg) => {
			this.isConnected = false;
			this.logger.error("Falha de autenticação:", msg);
		});

		// Evento de desconectado
		this.client.on("disconnected", (reason) => {
			this.isConnected = false;
			this.status = "DISCONNECTED";
			this.logger.info("Cliente desconectado:", reason);
			this.eventHandler.onDisconnected(this, reason);
		});

		// Evento de mensagem
		this.client.on("message", async (message) => {
			// Mais importante de tudo: registrar que o bot tá 'on'
			if (this.stabilityMonitor) {
				this.stabilityMonitor.registerBotMessage(message);
			}

			// Descarta mensagens nos primeiros 5 segundos após inicialização
			if (this.shouldDiscardMessage()) {
				this.logger.debug(`Descartando mensagem recebida durante período inicial de ${this.id}`);
				return;
			}

			this.lastMessageReceived = Date.now();

			// Calcula tempo de resposta
			const currentTimestamp = this.getCurrentTimestamp();
			const messageTimestamp = message.timestamp;
			const responseTime = Math.max(0, currentTimestamp - messageTimestamp); // Não permite valores negativos

			// Verifica se o tempo de resposta é muito alto e se precisamos reiniciar o bot
			// DESABILITADO Temporariamente
			/*
      if (responseTime > 60 && false) { // Desativado reiniciar por delay
        // Verifica se o bot não foi reiniciado recentemente pelo mesmo motivo
        const currentTime = Math.floor(Date.now() / 1000);
        const timeSinceLastRestart = currentTime - this.lastRestartForDelay;
        
        if (timeSinceLastRestart > 1800) { // 30 minutos
          this.lastRestartForDelay = currentTime;
          this.logger.warn(`Delay de resposta elevado (${responseTime}s), iniciando reinicialização automática`);
          
          // Inicia reinicialização em segundo plano
          setTimeout(() => {
            this.restartBot(`O delay está elevado (${responseTime}s), por isso o bot será reiniciado.`)
              .catch(err => this.logger.error('Erro ao reiniciar bot por delay elevado:', err));
          }, 100);
          
          return; // Não processa esta mensagem
        } else {
          this.logger.warn(`Delay de resposta elevado (${responseTime}s), mas o bot já foi reiniciado recentemente. Aguardando.`);
        }
      }
      */

			try {
				// Verifica se a mensagem é de um grupo a ser ignorado
				if (
					message.from === this.grupoLogs ||
					message.from === this.grupoAnuncios ||
					message.from === this.grupoInvites ||
					message.from === this.grupoEstabilidade
				) {
					//this.logger.debug(`Ignorando mensagem do grupo de logs/invites/estabilidade: ${message.from}`);
					return; // Ignora o processamento adicional
				}

				// Verifica se o autor está na lista de bloqueados
				if (this.database.isBlocked("wwebjs", message.author)) {
					this.logger.debug(`Ignorando mensagem de contato bloqueado: ${message.author}`);
					return; // Ignora processamento adicional
				}

				// Formata mensagem para o manipulador de eventos
				const formattedMessage = await this.formatMessage(message, responseTime);
				this.eventHandler.onMessage(this, formattedMessage);
			} catch (error) {
				this.logger.error("Erro ao processar mensagem:", error);
			}
		});

		// Evento de reação
		this.client.on("message_reaction", async (reaction) => {
			// Descarta reações nos primeiros 5 segundos após inicialização
			if (this.shouldDiscardMessage()) {
				this.logger.debug(`Descartando reação recebida durante período inicial de ${this.id}`);
				return;
			}

			try {
				// Processa apenas reações de outros usuários, não do próprio bot
				if (reaction.senderId !== this.client.info.wid._serialized) {
					// Verifica se o autor está na lista de bloqueados
					if (this.database.isBlocked("wwebjs", reaction.senderId)) {
						this.logger.debug(`Ignorando reaction de contato bloqueado: ${reaction.senderId}`);
						return; // Ignora processamento adicional
					}

					await this.reactionHandler.processReaction(this, reaction);

					if (this.eventHandler && typeof this.eventHandler.onReaction === "function") {
						this.eventHandler.onReaction(this, {
							reaction: reaction.reaction,
							senderId: reaction.senderId,
							userName: null, // wwebjs reaction object doesn't have pushname directly here
							chatId: reaction.msgId.remote,
							msgId: reaction.msgId
						});
					}
				}
			} catch (error) {
				this.logger.error("Erro ao tratar reação de mensagem:", error);
			}
		});

		// Evento de entrada no grupo
		this.client.on("group_join", async (notification) => {
			try {
				let group;
				let users;

				let responsavel;

				try {
					group = await notification.getChat();
				} catch (e) {
					this.logger.error("[group_join] Erro buscando chat", e);
					group = { id: "123456@g.us", name: "Desconhecido" };
				}

				try {
					users = await notification.getRecipients();
				} catch (e) {
					this.logger.error("[group_join] Erro buscando users", e);
					users = [{ id: "123456@c.us", name: "Desconhecido" }];
				}

				try {
					responsavel = await notification.getContact();
				} catch (e) {
					this.logger.error("[group_join] Erro buscando contact do responsável", e);
					responsavel = { id: "123456@c.us", name: "Desconhecido" };
				}

				if (users) {
					for (const user of users) {
						this.eventHandler.onGroupJoin(this, {
							group: {
								id: group.id._serialized,
								name: group.name
							},
							user: {
								id: user.id._serialized,
								name: user.pushname || "Desconhecido"
							},
							responsavel: {
								id: responsavel.id._serialized,
								name: responsavel.pushname || "Desconhecido"
							},
							origin: notification
						});
					}
				}
			} catch (error) {
				this.logger.error("Erro ao processar entrada no grupo:", error);
			}
		});

		// Evento de saída do grupo
		this.client.on("group_leave", async (notification) => {
			try {
				const group = await notification.getChat();
				const users = await notification.getRecipients();
				const responsavel = await notification.getContact();

				if (users) {
					for (const user of users) {
						this.eventHandler.onGroupLeave(this, {
							group: {
								id: group.id._serialized,
								name: group.name
							},
							user: {
								id: user.id._serialized,
								name: user.pushname || "Desconhecido"
							},
							responsavel: {
								id: responsavel.id._serialized,
								name: responsavel.pushname || "Desconhecido"
							},
							origin: notification
						});
					}
				}
			} catch (error) {
				this.logger.error("Erro ao processar saída do grupo:", error);
			}
		});

		// Ligação
		this.client.on("incoming_call", async (call) => {
			this.logger.info(`[Call] Rejeitando chamada: ${JSON.stringify(call)}`);
			call.reject();
		});

		// Evento de notificação geral
		this.client.on("notification", (notification) => {
			this.eventHandler.onNotification(this, notification);
		});
	}

	/**
	 * Formata uma mensagem do WhatsApp para nosso formato padrão
	 * @param {Object} message - A mensagem bruta do whatsapp-web.js
	 * @param {number} responseTime - Tempo de resposta em segundos
	 * @returns {Promise<Object>} - Objeto de mensagem formatado
	 */
	async formatMessage(message, responseTime) {
		try {
			const chat = await message.getChat();
			const sender = await message.getContact();
			const isGroup = chat.isGroup;

			// Rastreia mensagem recebida com tempo de resposta
			this.loadReport.trackReceivedMessage(isGroup, responseTime, message.from);

			let type = "text";
			let content = message.body;
			let caption = null;

			// Determina tipo de mensagem e conteúdo
			if (message.hasMedia) {
				const media = await message.downloadMedia();
				type = media.mimetype.split("/")[0]; // imagem, vídeo, áudio, etc.
				content = media;
				caption = message.body;
			} else if (message.type === "sticker") {
				type = "sticker";
				content = await message.downloadMedia();
			} else if (message.type === "location") {
				type = "location";
				content = message.location;
			}

			return {
				group: isGroup ? chat.id._serialized : null,
				author: sender.id._serialized,
				authorName: sender.pushname || sender.name || "Desconhecido",
				type,
				content,
				caption,
				origin: message,
				responseTime
			};
		} catch (error) {
			this.logger.error("Erro ao formatar mensagem:", error);
			throw error;
		}
	}

	/**
	 * Envia uma mensagem para um chat
	 * @param {string} chatId - O ID do chat para enviar a mensagem
	 * @param {string|Object} content - O conteúdo a enviar (texto ou mídia)
	 * @param {Object} options - Opções adicionais
	 * @returns {Promise<Object>} - A mensagem enviada
	 */
	async sendMessage(chatId, content, options = {}) {
		try {
			// Rastreia mensagem enviada
			const isGroup = chatId.endsWith("@g.us");
			this.loadReport.trackSentMessage(isGroup);

			// Opções padrão
			if (!options.linkPreview) {
				options.linkPreview = false;
			}

			// Verifica se está em modo seguro
			if (this.safeMode) {
				this.logger.info(
					`[MODO SEGURO] Enviaria para ${chatId}: ${typeof content === "string" ? content : "[Mídia]"}`
				);
				return { id: { _serialized: "safe-mode-msg-id" } };
			}

			if (typeof content === "string") {
				return await this.client.sendMessage(chatId, content, options);
			} else if (content instanceof Location) {
				try {
					return await this.client.sendMessage(chatId, content, options);
				} catch (err) {
					this.logger.error(
						`Erro ao enviar mensagem Location pra ${chatId}:`,
						err,
						content,
						options
					);
				}
			} else if (content instanceof MessageMedia) {
				const fullOpts = {
					caption: options.caption,
					sendMediaAsSticker: options.asSticker || false,
					...options
				};

				if (options.sendAudioAsVoice) {
					// Converter para ogg/opus antes
					content = await messageMediaToOpus(content);
				}

				try {
					return await this.client.sendMessage(chatId, content, fullOpts);
				} catch (err) {
					this.logger.error(
						`Erro ao enviar mensagem MessageMedia pra ${chatId}:`,
						err,
						content,
						fullOpts
					);
				}
			} else {
				this.logger.info(`[sendMessage] Mensagem de tipo indefinido?`, content);
				console.log(content);
				try {
					return await this.client.sendMessage(chatId, content, options);
				} catch (err) {
					this.logger.error(`Erro ao enviar mensagem pra ${chatId}:`, err, content, options);
				}
			}
		} catch (error) {
			this.logger.error(`Erro ao enviar mensagem para ${chatId}:`, error);
			throw error;
		}
	}

	/**
	 * Sends one or more ReturnMessage objects
	 * @param {ReturnMessage|Array<ReturnMessage>} returnMessages - ReturnMessage or array of ReturnMessages to send
	 * @returns {Promise<Array>} - Array of results from sending each message
	 */
	async sendReturnMessages(returnMessages) {
		try {
			// Ensure returnMessages is an array
			if (!Array.isArray(returnMessages)) {
				returnMessages = [returnMessages];
			}

			// Filter out invalid messages
			const validMessages = returnMessages.filter((msg) => msg && msg.isValid && msg.isValid());

			if (validMessages.length === 0) {
				this.logger.warn("No valid ReturnMessages to send");
				return [];
			}

			const results = [];

			// Process each message
			for (const message of validMessages) {
				// Apply any delay if specified
				if (message.delay > 0) {
					await new Promise((resolve) => setTimeout(resolve, message.delay));
				}

				// Send the message
				const result = await this.sendMessage(message.chatId, message.content, message.options);

				// Apply reactions if specified
				if (message.reactions && result) {
					try {
						// Store message ID for potential future reactions
						if (message.metadata) {
							message.metadata.messageId = result.id._serialized;
						}
					} catch (reactError) {
						this.logger.error("Error applying reaction to message:", reactError);
					}
				}

				results.push(result);
			}

			return results;
		} catch (error) {
			this.logger.error("Error sending ReturnMessages:", error);
			throw error;
		}
	}

	/**
	 * Cria um objeto de mídia a partir de um caminho de arquivo
	 * @param {string} filePath - Caminho para o arquivo de mídia
	 * @returns {Promise<MessageMedia>} - O objeto de mídia
	 */
	async createMedia(filePath) {
		try {
			return MessageMedia.fromFilePath(filePath);
		} catch (error) {
			this.logger.error(`Erro ao criar mídia de ${filePath}:`, error);
			throw error;
		}
	}

	/**
	 * Cria um objeto de mídia a partir de uma URL
	 * @param {string} URL - Caminho para o arquivo de mídia
	 * @returns {Promise<MessageMedia>} - O objeto de mídia
	 */
	async createMediaFromURL(URL) {
		try {
			return MessageMedia.fromUrl(URL, { unsafeMime: true });
		} catch (error) {
			this.logger.error(`Erro ao criar mídia de ${URL}:`, error);
			throw error;
		}
	}

	/**
	 * Verifica se um usuário é administrador em um grupo
	 * @param {string} userId - ID do usuário a verificar
	 * @param {string} groupId - ID do grupo
	 * @returns {Promise<boolean>} - True se o usuário for admin
	 */
	async isUserAdminInGroup(userId, groupId) {
		try {
			// Obtém o objeto de grupo do banco de dados
			const group = await this.database.getGroup(groupId);
			if (!group) return false;

			// Obtém o objeto de chat
			let chat = null;
			try {
				chat = await this.client.getChatById(groupId);
			} catch (chatError) {
				this.logger.error(`Erro ao obter chat para verificação de admin: ${chatError.message}`);
			}

			// Utiliza o AdminUtils para verificar
			return await this.adminUtils.isAdmin(userId, group, chat, this);
		} catch (error) {
			this.logger.error(
				`Erro ao verificar se usuário ${userId} é admin no grupo ${groupId}:`,
				error
			);
			return false;
		}
	}

	/**
	 * Destrói o cliente WhatsApp
	 */
	async destroy() {
		this.logger.info(`Destruindo instância de bot ${this.id}`);

		if (this.client) {
			await this.client.destroy();
			this.client = null;
			this.isConnected = false;
		}

		// Limpa loadReport
		if (this.loadReport) {
			this.loadReport.destroy();
		}

		// // Limpa sistema de convites
		// if (this.inviteSystem) {
		//   this.inviteSystem.destroy();
		// }

		// // Limpa StreamSystem
		// if (this.streamSystem) {
		//   this.streamSystem.destroy();
		//   this.streamSystem = null;
		//   this.streamMonitor = null;
		// }

		// // Envia notificação de desligamento para o grupo de logs
		// if (this.grupoLogs && this.isConnected) {
		//   try {
		//     const shutdownMessage = `🔌 Bot ${this.id} desligando em ${new Date().toLocaleString("pt-BR")}`;
		//     await this.sendMessage(this.grupoLogs, shutdownMessage);
		//   } catch (error) {
		//     this.logger.error('Erro ao enviar notificação de desligamento:', error);
		//   }
		// }
	}

	/**
	 * Reinicia o cliente WhatsApp
	 * @param {string} reason - Motivo da reinicialização (opcional)
	 * @returns {Promise<void>}
	 */
	async restartBot(reason = "Reinicialização solicitada") {
		try {
			this.logger.info(`Reiniciando instância de bot ${this.id}. Motivo: ${reason}`);

			// Notifica o grupo de avisos sobre a reinicialização
			if (this.grupoAvisos && this.isConnected) {
				try {
					const restartMessage = `🔄 Bot ${this.id} reiniciando em ${new Date().toLocaleString("pt-BR")}\nMotivo: ${reason}`;
					await this.sendMessage(this.grupoAvisos, restartMessage);
					// Aguarda 5 segundos para a mensagem ser entregue
					await new Promise((resolve) => setTimeout(resolve, 5000));
				} catch (error) {
					this.logger.error("Erro ao enviar notificação de reinicialização:", error);
				}
			}

			// Limpa recursos atuais
			if (this.loadReport) {
				this.loadReport.destroy();
			}

			if (this.inviteSystem) {
				this.inviteSystem.destroy();
			}

			if (this.streamSystem) {
				this.streamSystem.destroy();
				this.streamSystem = null;
				this.streamMonitor = null;
			}

			// Destrói cliente atual
			if (this.client) {
				await this.client.destroy();
				this.client = null;
				this.isConnected = false;
			}

			this.logger.info(`Bot ${this.id} desconectado, iniciando reinicialização...`);

			// Aguarda um curto período antes de reiniciar
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Recria o cliente
			this.client = new Client({
				authStrategy: new LocalAuth({ clientId: this.id }),
				puppeteer: this.puppeteerOptions
			});

			// Registra manipuladores de eventos novamente
			this.registerEventHandlers();

			// Inicializa cliente
			await this.client.initialize();
			this.logger.info(`Bot ${this.id} reinicializado com sucesso`);

			// Aguarda a conexão ser estabelecida
			let waitTime = 0;
			const maxWaitTime = 60000; // 60 segundos de timeout
			const checkInterval = 2000; // Verifica a cada 2 segundos

			while (!this.isConnected && waitTime < maxWaitTime) {
				await new Promise((resolve) => setTimeout(resolve, checkInterval));
				waitTime += checkInterval;
			}

			if (this.isConnected) {
				this.logger.info(`Bot ${this.id} reconectado após ${waitTime}ms`);

				// Recarrega contatos bloqueados
				try {
					this.blockedContacts = await this.client.getBlockedContacts();
					this.logger.info(`Recarregados ${this.blockedContacts.length} contatos bloqueados`);

					if (this.otherBots.length > 0) {
						this.prepareOtherBotsBlockList();
					}
				} catch (error) {
					this.logger.error("Erro ao recarregar contatos bloqueados:", error);
					this.blockedContacts = [];
				}

				// Inicializa o sistema de streaming
				this.streamSystem = new StreamSystem(this);
				await this.streamSystem.initialize();
				this.streamMonitor = this.streamSystem.streamMonitor;

				// Envia notificação de reinicialização bem-sucedida
				if (this.grupoAvisos) {
					try {
						const successMessage = `✅ Bot ${this.id} reiniciado com sucesso!\nMotivo prévio: ${reason}`;
						await this.sendMessage(this.grupoAvisos, successMessage);
					} catch (error) {
						this.logger.error("Erro ao enviar notificação de sucesso:", error);
					}
				}
			} else {
				this.logger.error(`Falha ao reconectar bot ${this.id} após ${waitTime}ms`);

				// Notifica sobre falha na reinicialização
				if (this.grupoLogs) {
					try {
						const errorMessage = `❌ Falha ao reiniciar bot ${this.id}\nMotivo da reinicialização: ${reason}`;
						// Tenta enviar a mensagem de erro, mas pode falhar se o bot não estiver conectado
						await this.sendMessage(this.grupoLogs, errorMessage).catch(() => {});
					} catch (error) {
						this.logger.error("Erro ao enviar notificação de falha:", error);
					}
				}
			}
		} catch (error) {
			this.logger.error(`Erro durante a reinicialização do bot ${this.id}:`, error);
			throw error;
		}
	}

	async logout() {
		this.logger.info(`Logging out instance ${this.id}...`);
		if (this.client) {
			await this.client.logout();
			this.logger.info(`Instance ${this.id} logged out.`);
			this.isConnected = false;
		} else {
			this.logger.warn(`Logout called for instance ${this.id}, but client is not initialized.`);
		}
	}

	getCurrentTimestamp() {
		return Math.round(+new Date() / 1000);
	}

	/**
	 * Creates or retrieves a Contact object
	 * @param {string} phoneNumber - Phone number of the contact
	 * @param {string} name - Name of the contact
	 * @param {string} surname - Surname of the contact
	 * @returns {Promise<Contact>} - Contact object with all required properties and methods
	 */
	async createContact(phoneNumber, name, surname) {
		try {
			// Format the phone number to ensure it has the correct format for WhatsApp
			const formattedNumber = phoneNumber.endsWith("@c.us")
				? phoneNumber
				: `${phoneNumber.replace(/\D/g, "")}@c.us`;

			// Try to get the contact from WhatsApp
			try {
				const contact = await this.client.getContactById(formattedNumber);
				if (contact) {
					this.logger.debug(`Retrieved existing contact: ${formattedNumber}`);
					return contact;
				}
			} catch (error) {
				this.logger.debug(`Contact not found, creating mock: ${formattedNumber}`);
			}

			// Create a full name from the provided name and surname
			const fullName = `${name} ${surname}`.trim();

			// Create a contact data object that matches the expected structure
			const contactData = {
				id: {
					server: "c.us",
					user: phoneNumber.replace(/\D/g, ""),
					_serialized: formattedNumber
				},
				name: fullName,
				shortName: name,
				pushname: name,
				number: phoneNumber.replace(/\D/g, "")
			};

			// Create a new Contact instance
			const mockContact = new Contact(this.client, contactData);

			// Override methods that would normally interact with WhatsApp
			mockContact.getAbout = async () => {
				this.logger.debug(`Mock getAbout called for ${formattedNumber}`);
				return `About for ${fullName}`;
			};

			mockContact.getChat = async () => {
				this.logger.debug(`Mock getChat called for ${formattedNumber}`);
				try {
					return await this.client.getChatById(formattedNumber);
				} catch (error) {
					// If we can't get a real chat, we'll need to create a mock Chat
					// This is more complex and might require importing the Chat class
					// For now, we'll return a basic object
					return {
						id: { _serialized: formattedNumber },
						name: fullName,
						isGroup: false,
						timestamp: Date.now()
					};
				}
			};

			mockContact.getCommonGroups = async () => {
				this.logger.debug(`Mock getCommonGroups called for ${formattedNumber}`);
				return [];
			};

			// Set additional properties
			mockContact.isUser = true;
			mockContact.isWAContact = true;
			mockContact.isMyContact = false;
			mockContact.isGroup = false;
			mockContact.isBusiness = false;
			mockContact.isEnterprise = false;
			mockContact.isMe = false;
			mockContact.isBlocked = false;

			return mockContact;
		} catch (error) {
			this.logger.error(`Error creating contact for ${phoneNumber}:`, error);
			throw error;
		}
	}
}

module.exports = WhatsAppBot;
