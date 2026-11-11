/* VIBE CODED PELO GEMINI */
const express = require("express");
const mime = require("mime-types");
const path = require("path");
const fs = require("fs");

const TelegramClient = require("./services/TelegramClient");
const TelegramCallbackManager = require("./services/TelegramCallbackManager");
const CacheManager = require("./services/CacheManager");
const ReturnMessage = require("./models/ReturnMessage");
const ReactionsHandler = require("./ReactionsHandler");
const MentionHandler = require("./MentionHandler");
const AdminUtils = require("./utils/AdminUtils");
const InviteSystem = require("./InviteSystem");
const StreamSystem = require("./StreamSystem");
const Database = require("./utils/Database");
const LoadReport = require("./LoadReport");
const Logger = require("./utils/Logger");
const SkipGroups = require("./utils/SkipGroups");
const AccountLinkService = require("./services/AccountLinkService");
const TelegramMarkupHelper = require("./utils/TelegramMarkupHelper");
const { generateAutomaticButtons } = require("./utils/InteractiveButtonsHelper");
const { promisify } = require("util");

// Utils
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);
const unlinkAsync = promisify(fs.unlink);

class WhatsAppBotTelegram {
	constructor(options) {
		this.id = options.id;
		this.enabled = options.enabled !== undefined ? Boolean(options.enabled) : true;
		this.telegramBotName = options.telegramBotName || "ravenabot";
		this.eventHandler = options.eventHandler;
		this.prefix = options.prefix || process.env.DEFAULT_PREFIX || "/";
		this.logger = new Logger(`bot-telegram-${this.id}`);
		this.accountLinkService = AccountLinkService.getInstance();

		// Opções específicas do Telegram
		this.useTelegram = true;
		this.telegramBotToken = options.telegramBotToken || options.token;
		this.telegramSecretToken = options.telegramSecretToken || "";

		// Opções compartilhadas utilizadas
		this.nomeExibir = options.nomeExibir;
		this.sendJoinInfo = options.sendJoinInfo !== undefined ? Boolean(options.sendJoinInfo) : true;
		this.pvAI = options.pvAI ?? true;
		this.ignorePV = options.ignorePV || false;
		this.updateStatus = options.updateStatus ?? true;
		this.aiPersonality = options.aiPersonality ?? "";
		this.grupoLogs = parseInt(options.grupoLogs || process.env.TELEGRAM_GRUPO_LOGS);
		this.dossieGroups =
			options.dossieGroups ??
			this.grupoLogs ??
			(process.env.TELEGRAM_GRUPO_DOSSIES ? parseInt(process.env.TELEGRAM_GRUPO_DOSSIES) : null);
		this.grupoAvisos = parseInt(options.grupoAvisos || process.env.TELEGRAM_GRUPO_AVISOS);
		this.notificarDonate = options.notificarDonate;
		this.webhookHost = options.webhookHost; // ex: ravena.moothz.com
		this.webhookPort = options.webhookPort || 9001;
		this.pollingInterval = null; // Para armazenar o ID do intervalo de polling
		this.webhookMonitorInterval = null;
		this.webhookFailures = 0;
		this.isPolling = false;
		this.linkAvisos = options.linkAvisos ?? process.env.LINK_GRUPO_AVISOS;
		this.linkGrupao = options.linkGrupao ?? process.env.LINK_GRUPO_INTERACAO;
		this.linkComunidade = options.linkComunidade ?? process.env.LINK_COMUNIDADE;

		// Opções do Whatsgo ignoradas (mantidas para consistência de inicialização)
		this.vip = options.vip;
		this.comunitario = options.comunitario;
		this.numeroResponsavel = options.numeroResponsavel;
		this.supportMsg = options.supportMsg;
		this.phoneNumber = options.telegramBotId;
		this.whatsgoApiUrl = options.whatsgoApiUrl;
		this.whatsgoApiKey = options.whatsgoApiKey;
		this.goInstanceName = options.goInstanceName;
		this.privado = options.privado ?? false;
		this.extras = options.extras || {};
		this.managementUser = options.managementUser ?? "admin";
		this.managementPW = options.managementPW ?? "batata123";
		this.redisURL = options.redisURL;
		this.redisDB = options.redisDB;
		this.redisTTL = options.redisTTL;
		this.safeMode =
			options.safeMode !== undefined ? options.safeMode : process.env.SAFE_MODE === "true";
		this.otherBots = options.otherBots || [];
		this.whitelistPV = options.whitelistPV || [];
		this.ignoreInvites = options.ignoreInvites || false;
		this.grupoInvites = options.grupoInvites;
		this.userAgent = options.userAgent;
		this.stabilityMonitor = options.stabilityMonitor;

		this.streamIgnoreGroups = [];
		this.skipGroupInfo = [];

		if (!this.telegramBotToken) {
			const errMsg = "WhatsAppBotTelegram: telegramBotToken is required!";
			this.logger.error(errMsg, {
				telegramBotToken: !!this.telegramBotToken
			});
			throw new Error(errMsg);
		}

		this.apiClient = new TelegramClient(this.telegramBotToken, this.logger);
		this.database = Database.getInstance();
		this.isConnected = false; // Será true após o webhook ser configurado
		this.botInfo = null;

		// Sistemas e Handlers
		this.mentionHandler = new MentionHandler();
		this.lastMessageReceived = Date.now();
		this.startupTime = Date.now();
		this.loadReport = new LoadReport(this);
		// this.inviteSystem = new InviteSystem(this); // Ignorado no Telegram
		// this.reactionHandler = new ReactionsHandler(); // Ignorado no Telegram

		if (process.env.DISABLE_ACTIVITY !== "true") {
			this.streamSystem = StreamSystem.getInstance();
			this.streamSystem.registerBot(this);
			this.streamSystem.initialize();
		} else {
			this.streamSystem = null;
		}

		this.adminUtils = AdminUtils.getInstance();

		this.webhookApp = null;
		this.webhookServer = null;

		// Cache (reutilizado do Whatsgo)
		this.cacheManager = CacheManager.getInstance(this.redisURL, this.redisDB, this.redisTTL, 1000);

		// Client Fake para manter compatibilidade
		this.client = {
			getChatById: (arg) => this.getChatDetails(arg),
			getContactById: (arg) => this.getContactDetails(arg),
			getInviteInfo: (arg) => this.inviteInfo(arg),
			getMessageById: async (messageId) => this.recoverMsgFromCache(messageId),
			setStatus: (arg) => this.updateProfileStatus(arg),
			getProfilePictureUrl: (arg) => this.getProfilePictureUrl(arg),
			leaveGroup: (arg) => this.leaveGroup(arg),
			setProfilePicture: (arg) => this.updateProfilePicture(arg),
			setPrivacySettings: (arg) => this.updatePrivacySettings(arg),
			acceptInvite: (arg) => this.acceptInviteCode(arg),
			sendPresenceUpdate: async () => true, // Não aplicável
			info: {
				wid: { _serialized: this.botInfo ? this.botInfo.id : "" }
			}
		};
	}

	async initialize() {
		this.logger.info(`[${this.id}] Initializing Telegram Bot...`);
		this.database.registerBotInstance(this);
		this.startupTime = Date.now();

		await this._loadSkipGroupInfo();

		try {
			this.botInfo = await this.apiClient.getMe();
			this.client.info.wid._serialized = this.botInfo.id;
			this.logger.info(`Bot ID: ${this.botInfo.id}, Username: @${this.botInfo.username}`);

			if (this.webhookHost) {
				try {
					this.webhookApp = express();
					this.webhookApp.set("trust proxy", true);
					this.webhookApp.use(express.json());

					const webhookPath = `/webhook/telegram/${this.telegramBotToken}`;
					this.webhookApp.post(webhookPath, this._handleWebhook.bind(this));

					await new Promise((resolve, reject) => {
						this.webhookServer = this.webhookApp
							.listen(this.webhookPort, () => {
								this.logger.info(
									`[telegram-bot] Webhook listener for bot ${this.id} started on port ${this.webhookPort} at ${webhookPath}`
								);
								this._onInstanceConnected();
								resolve();
							})
							.on("error", (err) => {
								this.logger.error(`Failed to start webhook listener for bot ${this.id}:`, err);
								reject(err);
							});
					});

					const webhookUrl = `https://${this.webhookHost}/webhook/telegram/${this.telegramBotToken}`;
					await this.apiClient.setWebhook(webhookUrl, this.telegramSecretToken);
					this.logger.info(`[${this.id}] Webhook configured successfully: ${webhookUrl}`);

					// Start Webhook monitor/fallback watchdog
					this._startWebhookMonitor();
				} catch (webhookError) {
					this.logger.error(
						`[${this.id}] Failed to set up webhook, falling back to polling:`,
						webhookError
					);
					await this._fallbackToPolling();
				}
			} else {
				this.logger.info(`[${this.id}] Starting Telegram Bot in polling mode.`);
				// Certifica-se de que o webhook está desativado
				await this.apiClient.deleteWebhook();

				this.isPolling = true; // Flag to control the loop
				this._startPollingLoop();
				this._onInstanceConnected(); // Conecta imediatamente no modo polling
			}

			await this.registerCommands();
		} catch (error) {
			this.logger.error(`Error during Telegram bot initialization:`, error.stack);
			this._onInstanceDisconnected("INITIALIZATION_FAILURE");
			this.isPolling = false;
			setTimeout(() => this.initialize(), 30000);
		}

		return this;
	}

	async _fallbackToPolling() {
		if (this.isPolling) return;
		this.logger.warn(`[${this.id}] Webhook failed or had issues. Falling back to POLLING mode.`);

		// Clean up webhook server if running
		if (this.webhookServer) {
			try {
				this.webhookServer.close();
				this.logger.info(`[${this.id}] Closed webhook server listener.`);
			} catch (e) {
				this.logger.error(`[${this.id}] Error closing webhook server:`, e);
			}
		}

		try {
			await this.apiClient.deleteWebhook();
		} catch (e) {
			this.logger.error(`[${this.id}] Error deleting webhook on Telegram API:`, e);
		}

		this.isPolling = true;
		this._startPollingLoop();

		// Set connection status
		if (!this.isConnected) {
			this._onInstanceConnected();
		}
	}

	_startPollingLoop() {
		const poll = async () => {
			let offset = 0;
			this.logger.info(`[${this.id}] Polling loop started.`);
			while (this.isPolling) {
				try {
					const updates = await this.apiClient.getUpdates(offset + 1, 100, 30);
					if (updates.length > 0) {
						this.logger.debug(`Received ${updates.length} updates via polling.`);
						for (const update of updates) {
							this._processUpdate(update);
							offset = Math.max(offset, update.update_id);
						}
						this.lastMessageReceived = Date.now();
					}
					if (!this.isConnected) {
						this._onInstanceConnected();
					}
				} catch (error) {
					this.logger.error(`Error during polling for bot ${this.id}: ${error.message}`);
					if (this.isConnected) {
						this._onInstanceDisconnected("POLLING_ERROR");
					}
					// Avoid busy-looping on critical errors by waiting before retrying
					await sleep(5000);
				}
			}
			this.logger.info(`[${this.id}] Polling loop stopped.`);
		};

		poll(); // Start the polling loop
	}

	_startWebhookMonitor() {
		if (this.webhookMonitorInterval) {
			clearInterval(this.webhookMonitorInterval);
		}

		this.webhookFailures = 0;
		this.webhookMonitorInterval = setInterval(async () => {
			if (this.isPolling) {
				clearInterval(this.webhookMonitorInterval);
				return;
			}

			try {
				const webhookInfo = await this.apiClient.bot.getWebHookInfo();
				if (webhookInfo) {
					const hasRecentError =
						webhookInfo.last_error_date && Date.now() / 1000 - webhookInfo.last_error_date < 300;

					if (hasRecentError) {
						this.webhookFailures++;
						this.logger.warn(
							`[${this.id}] Webhook delivery issue detected (${this.webhookFailures}/3): "${webhookInfo.last_error_message}". Pending updates: ${webhookInfo.pending_update_count}`
						);

						if (this.webhookFailures >= 3) {
							this.logger.error(
								`[${this.id}] Webhook down for 3 consecutive checks. Switching to Polling mode fallback.`
							);
							await this._fallbackToPolling();
							clearInterval(this.webhookMonitorInterval);
						}
					} else {
						// Reset failure count on success
						this.webhookFailures = 0;
					}
				}
			} catch (err) {
				this.logger.error(`[${this.id}] Error checking webhook status:`, err);
			}
		}, 120000); // Check every 2 minutes
	}

	_onInstanceConnected() {
		if (this.isConnected) return;
		this.isConnected = true;
		this.logger.info(`[${this.id}] Successfully connected to Telegram.`);
		if (this.eventHandler && typeof this.eventHandler.onConnected === "function") {
			this.eventHandler.onConnected(this);
		}
	}

	_onInstanceDisconnected(reason = "Unknown") {
		if (!this.isConnected && reason !== "INITIALIZING") return;
		this.isConnected = false;
		this.logger.info(`[${this.id}] Disconnected from Telegram. Reason: ${reason}`);
		if (this.eventHandler && typeof this.eventHandler.onDisconnected === "function") {
			this.eventHandler.onDisconnected(this, reason);
		}
	}

	_handleWebhook(req, res) {
		// Validar o secret token se estiver configurado
		if (
			this.telegramSecretToken &&
			req.headers["x-telegram-bot-api-secret-token"] !== this.telegramSecretToken
		) {
			this.logger.warn("Received a request with an invalid secret token.");
			return res.sendStatus(403);
		}

		const update = req.body;
		this._processUpdate(update);
		res.sendStatus(200);
	}

	async _processUpdate(update) {
		//this.logger.info('Received update:', update);

		if (update.my_chat_member) {
			// Handles the bot's own status changes in a group (joined, left, promoted, etc.)
			return this._handleGroupMembershipUpdate(update.my_chat_member);
		}

		if (update.chat_member) {
			// Handles other users' status changes (less common, my_chat_member is preferred)
			return this._handleGroupParticipantsUpdate(update.chat_member);
		}

		if (update.callback_query) {
			return this._handleCallbackQuery(update.callback_query);
		}

		if (update.message) {
			const message = update.message;

			// Handle service messages for users joining or leaving, which are sent as `message` objects
			if (message.new_chat_members || message.left_chat_member) {
				return this._handleParticipantChange(message);
			}

			// If it's a regular message, process it
			this.lastMessageReceived = Date.now();
			this.formatMessageFromTelegram(message)
				.then((formattedMessage) => {
					//this.logger.debug(`[message] `, { upt: update, fm: formattedMessage });
					if (formattedMessage) {
						// IMPORTANT: Check if formatting was successful
						this.eventHandler.onMessage(this, formattedMessage);
					}
				})
				.catch((e) => {
					this.logger.error("[messages.upsert] Error formatting message", e);
				});
		}
	}

	_handleParticipantChange(message) {
		const chatId = message.chat.id;
		const chatName = message.chat.title;
		const responsibleUser = message.from; // The user who performed the action

		let action;
		let participants;

		if (message.new_chat_members) {
			action = "add";
			participants = message.new_chat_members;
		} else if (message.left_chat_member) {
			action = "remove";
			participants = [message.left_chat_member];
		} else {
			return; // Should not happen
		}

		const eventName = action === "add" ? "onGroupJoin" : "onGroupLeave";

		for (const user of participants) {
			// The EventHandler expects a data structure similar to wweb.js events
			const eventData = {
				group: {
					id: `${chatId}`,
					name: chatName
				},
				user: {
					id: `${user.id}`,
					name: user.first_name || user.username
				},
				responsavel: {
					id: `${responsibleUser.id}`,
					name: responsibleUser.first_name || responsibleUser.username
				},
				// Provides a way for the handler to get more info if needed
				origin: {
					getChat: () => this.getChatDetails(chatId)
				}
			};

			if (this.eventHandler && typeof this.eventHandler[eventName] === "function") {
				this.logger.info(
					`Forwarding group participant change to EventHandler: ${eventName} for user ${user.id} in chat ${chatId}`
				);
				this.eventHandler[eventName](this, eventData);
			}
		}
	}

	async _handleCallbackQuery(callbackQuery) {
		try {
			const queryId = callbackQuery.id;
			const from = callbackQuery.from;
			const message = callbackQuery.message;
			const chatId = message?.chat?.id;
			const data = callbackQuery.data;

			this.lastMessageReceived = Date.now();

			if (!data) {
				await this.apiClient.answerCallbackQuery(queryId);
				return;
			}

			const decoded = TelegramCallbackManager.decode(data);
			if (!decoded) {
				await this.apiClient.answerCallbackQuery(queryId, {
					text: "Ação não reconhecida ou expirada.",
					show_alert: true
				});
				return;
			}

			// 1. Ação de Menu Interativo (ex: !cmd)
			if (decoded.type === "menu") {
				await this.apiClient.answerCallbackQuery(queryId);
				const Menu = require("./functions/Menu");
				if (typeof Menu.handleMenuCallback === "function") {
					await Menu.handleMenuCallback(this, callbackQuery, decoded.category, decoded.page);
				}
				return;
			}

			// 1.1 Ação de Menu Interativo de Waifus (ex: !waifus)
			if (decoded.type === "waifu_menu") {
				await this.apiClient.answerCallbackQuery(queryId);
				const WaifuCommands = require("./functions/WaifuCommands");
				if (typeof WaifuCommands.handleWaifuMenuCallback === "function") {
					await WaifuCommands.handleWaifuMenuCallback(
						this,
						callbackQuery,
						decoded.category,
						decoded.page
					);
				}
				return;
			}

			// 1.2 Ação de Menu Interativo da Fazenda (ex: !faz-ajuda / !jardim)
			if (decoded.type === "fazenda_menu") {
				await this.apiClient.answerCallbackQuery(queryId);
				const FazendaCommands = require("./functions/FazendaCommands");
				if (typeof FazendaCommands.handleFazendaMenuCallback === "function") {
					await FazendaCommands.handleFazendaMenuCallback(
						this,
						callbackQuery,
						decoded.category,
						decoded.page
					);
				}
				return;
			}

			// 2. Ação de Comando Executável (ex: /mu_casar 1)
			if (decoded.type === "command") {
				await this.apiClient.answerCallbackQuery(queryId);

				const commandText = this.normalizeInboundCommand(decoded.value);
				const authorId = `${from.id}`;
				const authorName = from.first_name || from.username || "Unknown User";
				const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";

				if (
					decoded.value &&
					/^\/faz-(plantar|usar|vender|decorar)/i.test(decoded.value) &&
					message?.message_id
				) {
					try {
						const FazendaCommands = require("./functions/FazendaCommands");
						if (typeof FazendaCommands.recordInvMessage === "function") {
							FazendaCommands.recordInvMessage(chatId, authorId, message.message_id);
						}
					} catch (trackInvErr) {
						this.logger.debug(
							`[_handleCallbackQuery] Erro ao registrar inv message via callback: ${trackInvErr.message}`
						);
					}
				}

				const syntheticMessage = {
					telegramMessage: message,
					id: message.message_id,
					key: { id: message.message_id },
					fromMe: from.id === this.botInfo?.id,
					group: isGroup ? `${chatId}` : null,
					from: isGroup ? `${chatId}` : authorId,
					author: authorId,
					name: authorName,
					authorName,
					pushname: authorName,
					type: "text",
					content: commandText,
					body: commandText,
					mentions: [],
					caption: null,
					timestamp: Math.round(Date.now() / 1000),
					hasMedia: false,
					quotedMsgId: `${chatId}_${from.id}_${message.message_id}`,
					isCallbackQuery: true,
					callbackQueryId: queryId,
					react: async () => true,
					getContact: async () => this.getContactDetails(authorId, authorName),
					getChat: async () => this.getChatDetails(chatId),
					delete: async () => this.apiClient.deleteMessage(chatId, message.message_id),
					downloadMedia: async () => null,
					origin: {
						id: { _serialized: `${chatId}_${from.id}_${message.message_id}` },
						author: authorId,
						from: `${chatId}`,
						react: async () => true,
						getChat: async () => this.getChatDetails(chatId),
						getQuotedMessage: async () => this.formatMessageFromTelegram(message),
						delete: async () => this.apiClient.deleteMessage(chatId, message.message_id),
						body: commandText
					}
				};

				if (this.eventHandler && typeof this.eventHandler.onMessage === "function") {
					this.eventHandler.onMessage(this, syntheticMessage);
				}
				return;
			}

			await this.apiClient.answerCallbackQuery(queryId);
		} catch (error) {
			this.logger.error(`[callback_query] Erro ao tratar callback_query: ${error.message}`, error);
		}
	}

	/**
	 * Normaliza comandos recebidos do Telegram: converte underscores no comando em hífens.
	 * Ex: "/mu_casar 1" -> "/mu-casar 1", "/g_addcmd teste" -> "/g-addcmd teste".
	 * Argumentos e parâmetros subsequentes permanecem intocados.
	 */
	normalizeInboundCommand(text) {
		if (typeof text !== "string") return text;
		const match = text.match(/^(\s*)([/!])([a-zA-Z0-9_]+)(\s*[\s\S]*)$/);
		if (match) {
			const [_, leadingWs, prefix, cmdName, rest] = match;
			if (cmdName.includes("_")) {
				const normalizedCmd = cmdName.replace(/_/g, "-");
				return `${leadingWs}${prefix}${normalizedCmd}${rest}`;
			}
		}
		return text;
	}

	async formatMessageFromTelegram(message, skipCache = false) {
		return new Promise(async (resolve, reject) => {
			try {
				if (!message) {
					return resolve(null);
				}

				const chatId = `${message.chat.id}`;
				const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
				const authorId = `${message.from.id}`;
				const authorName = message.from.first_name || message.from.username || "Unknown User";

				const responseTime = message.date
					? Math.max(0, this.getCurrentTimestamp() - message.date)
					: 0;
				this.loadReport.trackReceivedMessage(isGroup, responseTime, chatId);

				let type = "unknown";
				let content = null;
				let caption = null;
				let mediaInfo = null;

				// remove o @nomedobot pra facilitar e normaliza comando inbound (underscore -> hífen)
				if (message.text) {
					type = "text";
					content = message.text.replace(`@${this.telegramBotName}`, "");
					content = this.normalizeInboundCommand(content);
				} else if (message.photo) {
					type = "image";
					const photo = message.photo[message.photo.length - 1]; // Pega a maior resolução
					mediaInfo = { fileId: photo.file_id, mimetype: "image/jpeg", type: "photo" };
					caption = message.caption?.replace(`@${this.telegramBotName}`, "") ?? false;
					if (caption) caption = this.normalizeInboundCommand(caption);
					content = mediaInfo;
				} else if (message.video) {
					type = "video";
					mediaInfo = {
						fileId: message.video.file_id,
						mimetype: message.video.mime_type || "video/mp4",
						type: "video"
					};
					caption = message.caption?.replace(`@${this.telegramBotName}`, "") ?? false;
					if (caption) caption = this.normalizeInboundCommand(caption);
					content = mediaInfo;
				} else if (message.sticker) {
					type = "sticker";
					mediaInfo = {
						fileId: message.sticker.file_id,
						mimetype: "image/webp",
						isAnimated: message.sticker.is_animated,
						type: "sticker"
					};
					content = mediaInfo;
				} else if (message.voice) {
					type = "ptt";
					mediaInfo = {
						fileId: message.voice.file_id,
						mimetype: message.voice.mime_type || "audio/ogg",
						type: "voice"
					};
					content = mediaInfo;
				} else if (message.video_note) {
					// "Video redondo" (video note) do Telegram: Behaves like a voice message,
					// so it is treated as audio for transcription (auto-STT / !stt) and not as a normal video.
					type = "video_note";
					mediaInfo = {
						fileId: message.video_note.file_id,
						mimetype: "video/mp4",
						type: "video_note",
						duration: message.video_note.duration ?? null,
						fileSize: message.video_note.file_size ?? null
					};
					caption = message.caption?.replace(`@${this.telegramBotName}`, "") ?? false;
					if (caption) caption = this.normalizeInboundCommand(caption);
					content = mediaInfo;
				} else if (message.audio) {
					type = "audio";
					mediaInfo = {
						fileId: message.audio.file_id,
						mimetype: message.audio.mime_type || "audio/mpeg",
						type: "audio"
					};
					content = mediaInfo;
				} else if (message.document) {
					type = "document";
					mediaInfo = {
						fileId: message.document.file_id,
						mimetype: message.document.mime_type,
						filename: message.document.file_name,
						type: "document"
					};
					caption = message.caption?.replace(`@${this.telegramBotName}`, "") ?? false;
					if (caption) caption = this.normalizeInboundCommand(caption);
					content = mediaInfo;
				} else {
					this.logger.debug("Unhandled Telegram message type:", message);
					return resolve(null);
				}

				const linkedWaId = this.accountLinkService.getLinkedWhatsApp("telegram", authorId);
				const finalAuthor = linkedWaId || authorId;

				const formattedMessage = {
					telegramMessage: message,
					id: message.message_id,
					key: { id: message.message_id }, // Fallback pro redis cache
					fromMe: message.from.id === this.botInfo?.id,
					group: isGroup ? chatId : null,
					from: isGroup ? chatId : authorId,
					author: finalAuthor,
					platformAuthor: authorId,
					platform: "telegram",
					isLinkedAccount: Boolean(linkedWaId),
					name: authorName,
					authorName,
					pushname: authorName,
					type,
					content,
					body: content,
					mentions: (message.entities || [])
						.filter((e) => e.type === "mention")
						.map((e) => message.text.substring(e.offset, e.offset + e.length)),
					caption,
					timestamp: message.date,
					hasMedia: !!mediaInfo,
					hasQuotedMsg: !!message.reply_to_message,

					react: async () => true,
					getContact: async () => this.getContactDetails(authorId, authorName),
					getChat: async () => this.getChatDetails(chatId),
					delete: async () => this.apiClient.deleteMessage(chatId, message.message_id),
					downloadMedia: async () => {
						if (mediaInfo) {
							const base64Data = await this.apiClient.downloadFile(mediaInfo.fileId);
							return {
								mimetype: mediaInfo.mimetype,
								data: base64Data,
								filename: mediaInfo.filename,
								isMessageMedia: true
							};
						}
						return null;
					},
					origin: {
						id: { _serialized: `${chatId}_${message.from.id}_${message.message_id}` },
						author: finalAuthor,
						platformAuthor: authorId,
						from: chatId,
						react: async () => true,
						getChat: async () => this.getChatDetails(chatId),
						getQuotedMessage: async () => {
							if (message.reply_to_message) {
								return await this.formatMessageFromTelegram(message.reply_to_message);
							}
							return null;
						},
						delete: async () => this.apiClient.deleteMessage(chatId, message.message_id),
						body: content
					}
				};

				// If the message is a reply, add information about the quoted message
				if (message.reply_to_message) {
					const quotedMsg = message.reply_to_message;
					// Create a serialized ID for the quoted message, similar to how wweb.js does it.
					// This ID can be used to retrieve the message from cache.
					formattedMessage.quotedMsgId = `${quotedMsg.chat.id}_${quotedMsg.from.id}_${quotedMsg.message_id}`;
				}

				if (!skipCache) {
					this.cacheManager.putMessageInCache(formattedMessage);
				}
				resolve(formattedMessage);
			} catch (error) {
				this.logger.error(`Error formatting message from Telegram:`, message);
				resolve(null);
			}
		});
	}

	async resolveMentionName(userId, contextChatId) {
		// 1. Try Cache
		let name = await this.cacheManager.getTelegramNameFromCache(userId);
		if (name) return name;

		// 2. Try API
		try {
			// Prioritize fetching from the group if context is a group
			if (contextChatId && String(contextChatId).startsWith("-")) {
				try {
					const member = await this.apiClient.getChatMember(contextChatId, userId);
					if (member && member.user) {
						name = member.user.first_name || member.user.username || userId; // First name is usually better for mentions
						await this.cacheManager.putTelegramNameInCache(userId, name);
						return name;
					}
				} catch (groupErr) {
					// Ignore, user might not be in this group, try global getChat
				}
			}

			// Fallback/Global fetch (works if bot has interacted with user)
			const userChat = await this.apiClient.getChat(userId);
			if (userChat) {
				name = userChat.first_name || userChat.username || userId;
				await this.cacheManager.putTelegramNameInCache(userId, name);
				return name;
			}
		} catch (e) {
			// this.logger.debug(`Failed to resolve name for ${userId}: ${e.message}`);
		}

		return userId; // Fallback to ID
	}

	/**
	 * Limita o conteúdo de texto para evitar mensagens gigantescas ou loops de repetição.
	 * Respeita o limite máximo de caracteres (padrão 15000), de linhas (padrão 200) e repetições consecutivas (máx 15).
	 *
	 * @param {string} text - Texto a ser validado e possivelmente truncado.
	 * @param {number} [maxChars=15000] - Limite máximo de caracteres.
	 * @param {number} [maxLines=200] - Limite máximo de linhas.
	 * @param {number} [maxCharRepeats=15] - Limite máximo de repetições consecutivas do mesmo caractere.
	 * @returns {string} - Texto original ou truncado com indicador.
	 */
	truncateText(text, maxChars = 15000, maxLines = 200, maxCharRepeats = 15) {
		if (typeof text !== "string" || !text) {
			return text;
		}

		let result = text;
		let modified = false;

		// Limita repetições consecutivas do mesmo caractere para no máximo 15 (ex: "KKK...KKK" -> 15 K's)
		if (maxCharRepeats > 0) {
			const repeatRegex =
				maxCharRepeats === 15 ? /(.)\1{15,}/gu : new RegExp(`(.)\\1{${maxCharRepeats},}`, "gu");
			if (repeatRegex.test(result)) {
				result = result.replace(repeatRegex, (match, char) => char.repeat(maxCharRepeats));
				modified = true;
			}
		}

		const lines = result.split(/\r?\n/);
		const exceedsLines = maxLines > 0 && lines.length > maxLines;
		const exceedsChars = maxChars > 0 && result.length > maxChars;

		if (exceedsLines || exceedsChars) {
			modified = true;
			const suffix = "\n... [truncado]";

			if (exceedsLines) {
				const targetLines = Math.max(1, maxLines - 1);
				result = lines.slice(0, targetLines).join("\n") + suffix;
			}

			if (maxChars > 0 && result.length > maxChars) {
				const targetChars = Math.max(0, maxChars - suffix.length);
				let sliced = result.slice(0, targetChars);
				if (typeof sliced.isWellFormed === "function" && !sliced.isWellFormed()) {
					sliced = sliced.replace(
						/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
						""
					);
				}
				result = sliced + suffix;
			}
		}

		if (modified) {
			this.logger.warn(
				`[${this.id}] Mensagem de texto ajustada por filtros de tamanho/repetição (${maxChars} chars / ${maxLines} linhas / máx ${maxCharRepeats} repetições).`
			);
		}

		return typeof result.toWellFormed === "function" ? result.toWellFormed() : result;
	}

	/**
	 * Extrai o ID numérico da mensagem no Telegram a partir de formatos variados de ID
	 * (`chatId_userId_messageId`, `MessageId` do wwebjs, objeto `goReply`, message_id puro).
	 * @param {string|number|Object} raw - Referência à mensagem original.
	 * @returns {number|null} - ID numérico da mensagem ou null.
	 */
	_extractTelegramMessageId(raw) {
		if (raw === null || raw === undefined) return null;

		let value = raw;
		if (typeof value === "object") {
			value =
				value.id?._serialized ??
				value.key?.id ??
				value.message_id ??
				(typeof value.id === "string" || typeof value.id === "number" ? value.id : null);
		}

		if (value === null || value === undefined) return null;

		const str = String(value).trim();
		if (!str) return null;

		// IDs serializados no Telegram seguem o padrão `${chatId}_${userId}_${messageId}`
		const lastPart = str.includes("_") ? str.split("_").pop() : str;
		const digits = String(lastPart).replace(/\D/g, "");
		if (!digits) return null;

		const messageId = parseInt(digits, 10);
		return Number.isFinite(messageId) && messageId > 0 ? messageId : null;
	}

	/**
	 * Resolve a mensagem que deve ser respondida ("reply") em uma mensagem enviada pelo bot.
	 * Aceita as opções usadas pelos comandos em qualquer plataforma:
	 * `quotedMsgId`, `quotedMessageId`, `goReply` e `telegram.replyToMessageId`.
	 * @param {Object} options - Opções do ReturnMessage / sendMessage.
	 * @returns {number|null} - ID numérico da mensagem a responder.
	 */
	_resolveReplyMessageId(options = {}) {
		const candidates = [
			options.quotedMsgId,
			options.quotedMessageId,
			options.replyToMessageId,
			options.telegram?.replyToMessageId,
			options.goReply
		];

		for (const candidate of candidates) {
			try {
				const messageId = this._extractTelegramMessageId(candidate);
				if (messageId) return messageId;
			} catch (e) {
				// Objetos de outras plataformas podem ter getters instáveis; apenas ignora a candidata
			}
		}

		return null;
	}

	/**
	 * Indica se o erro da API do Telegram foi causado pela mensagem que estava sendo respondida.
	 * @param {string} errorMessage - Mensagem do erro.
	 * @returns {boolean}
	 */
	_isReplyTargetError(errorMessage = "") {
		const msg = String(errorMessage).toLowerCase();
		return (
			msg.includes("reply message not found") ||
			msg.includes("message to reply not found") ||
			msg.includes("chat not found for the message to reply")
		);
	}

	async sendMessage(chatId, content, options = {}) {
		if (chatId) {
			const cleanChatId = String(chatId).split("@")[0].replace(/\D/g, "");
			const linkedTgId = this.accountLinkService.getLinkedPlatformUser("telegram", cleanChatId);
			if (linkedTgId) {
				chatId = linkedTgId;
			}
		}

		const ignored = chatId?.toString().includes?.("@") ?? false;

		chatId = parseInt(chatId);
		this.logger.debug(`[sendMessage] to ${chatId}`, { ignored });
		if (ignored) return;
		try {
			const isGroup = String(chatId).startsWith("-");
			this.loadReport.trackSentMessage(isGroup);

			if (this.safeMode) {
				this.logger.info(
					`[SAFE MODE] Would send to ${chatId}: ${typeof content === "string" ? content.substring(0, 70) + "..." : "[Media/Object]"}`
				);
				return { id: { _serialized: `safe-mode-msg-${Date.now()}` }, ack: 0, body: content };
			}

			if (!this.isConnected) {
				throw new Error("Not connected to Telegram");
			}

			const tgOptions = { parse_mode: "HTML" };

			// Responde a mensagem original sempre que ela for referenciada
			// (quotedMsgId / quotedMessageId / goReply), para o texto não ficar solto no chat.
			const replyToMessageId = this._resolveReplyMessageId(options);
			if (replyToMessageId) {
				tgOptions.reply_to_message_id = replyToMessageId;
				// Evita falha do envio quando a mensagem respondida foi apagada / é de outro chat
				tgOptions.allow_sending_without_reply = true;
			}

			// Resolve Mentions
			const mentionMap = {};
			if (options.mentions && Array.isArray(options.mentions)) {
				await Promise.all(
					options.mentions.map(async (mentionedId) => {
						const cleanId = String(mentionedId).split("@")[0].replace(/\D/g, "");
						const tgId =
							this.accountLinkService.getLinkedPlatformUser("telegram", cleanId) || cleanId;
						const name = await this.resolveMentionName(tgId, chatId);
						if (name) {
							mentionMap[cleanId] = { id: tgId, name };
							mentionMap[tgId] = { id: tgId, name };
						}
					})
				);
			}

			const maxChars = options.maxChars !== undefined ? options.maxChars : 0;
			const maxLines = options.maxLines !== undefined ? options.maxLines : 0;
			const maxCharRepeats = options.maxCharRepeats !== undefined ? options.maxCharRepeats : 15;

			// Format Content (Text)
			if (typeof content === "string") {
				content = this._formatMessage(content, mentionMap);
				content = this.truncateText(content, maxChars, maxLines, maxCharRepeats);
			}

			// Format Caption (Media)
			if (options.caption) {
				options.caption = this._formatMessage(options.caption, mentionMap);
				options.caption = this.truncateText(options.caption, maxChars, maxLines, maxCharRepeats);
				if (options.caption.length > 1024) {
					options.caption = options.caption.substring(0, 1020) + "...";
				}
			}

			// Resolva botões (explícitos ou automáticos como waifu rolls)
			const buttons =
				options.telegram?.buttons || options.buttons || this._generateAutomaticButtons(options);

			if (buttons && Array.isArray(buttons) && buttons.length > 0) {
				tgOptions.reply_markup = {
					inline_keyboard: this._buildInlineKeyboard(buttons)
				};
			} else if (options.telegram?.reply_markup) {
				tgOptions.reply_markup = options.telegram.reply_markup;
			}

			let editMessageId = options.telegram?.editMessageId || options.editMessageId;
			if (editMessageId) {
				try {
					let editResp;
					if (typeof content === "string") {
						editResp = await this.apiClient.editMessageText(
							chatId,
							editMessageId,
							content,
							tgOptions
						);
					} else if (content.isMessageMedia || (content.data && content.mimetype)) {
						const mediaBuffer = Buffer.from(content.data, "base64");
						tgOptions.caption = options.caption;
						editResp = await this.apiClient.editMessageMedia(
							chatId,
							editMessageId,
							mediaBuffer,
							tgOptions
						);
					} else if (options.caption) {
						editResp = await this.apiClient.editMessageCaption(
							chatId,
							editMessageId,
							options.caption,
							tgOptions
						);
					} else if (tgOptions.reply_markup) {
						editResp = await this.apiClient.editMessageReplyMarkup(
							chatId,
							editMessageId,
							tgOptions.reply_markup
						);
					}
					return {
						id: { _serialized: `${chatId}_${this.botInfo?.id || ""}_${editMessageId}` },
						messageId: editMessageId,
						ack: 1,
						body: content,
						_data: editResp,
						isEdited: true,
						react: async () => true
					};
				} catch (editError) {
					this.logger.warn(
						`[sendMessage] Falha ao editar mensagem ${editMessageId} em ${chatId}: ${editError.message}. Enviando como nova mensagem.`
					);
					editMessageId = null;
					// Fallback para envio como nova mensagem abaixo
				}
			}

			let response;
			if (typeof content === "string") {
				this.logger.debug(`[sendMessage] Text to '${chatId}'`, { content, options, tgOptions });
				try {
					response = await this.apiClient.sendMessage(chatId, content, tgOptions);
				} catch (sendErr) {
					const errorMsg = sendErr?.message || "";
					const isParseError =
						errorMsg.includes("can't parse entities") || errorMsg.includes("parse_mode");
					const isReplyError =
						Boolean(tgOptions.reply_to_message_id) && this._isReplyTargetError(errorMsg);

					if (!isParseError && !isReplyError) {
						throw sendErr;
					}

					const fallbackOpts = { ...tgOptions };

					if (isReplyError) {
						this.logger.warn(
							`[sendMessage] Mensagem respondida indisponível em ${chatId}. Reenviando sem reply: ${errorMsg}`
						);
						delete fallbackOpts.reply_to_message_id;
						delete fallbackOpts.allow_sending_without_reply;
					}

					if (isParseError) {
						this.logger.warn(
							`[sendMessage] Erro de parse HTML no Telegram. Enviando fallback em texto puro: ${errorMsg}`
						);
						delete fallbackOpts.parse_mode;
						content = TelegramMarkupHelper.stripHtml(content);
					}

					response = await this.apiClient.sendMessage(chatId, content, fallbackOpts);
				}
			} else if (content.isMessageMedia || (content.data && content.mimetype)) {
				const mediaBuffer = Buffer.from(content.data, "base64");
				tgOptions.caption = options.caption;

				const sendMediaWithFallback = async (sendFn) => {
					try {
						return await sendFn(tgOptions);
					} catch (sendErr) {
						const errorMsg = sendErr?.message || "";
						const isParseError =
							errorMsg.includes("can't parse entities") || errorMsg.includes("parse_mode");
						const isReplyError =
							Boolean(tgOptions.reply_to_message_id) && this._isReplyTargetError(errorMsg);

						if (!isParseError && !isReplyError) {
							throw sendErr;
						}

						const fallbackOpts = { ...tgOptions };

						if (isReplyError) {
							this.logger.warn(
								`[sendMessage] Mensagem respondida indisponível em ${chatId}. Reenviando mídia sem reply: ${errorMsg}`
							);
							delete fallbackOpts.reply_to_message_id;
							delete fallbackOpts.allow_sending_without_reply;
						}

						if (isParseError) {
							this.logger.warn(
								`[sendMessage] Erro de parse HTML na legenda da mídia. Enviando legenda em texto puro: ${errorMsg}`
							);
							delete fallbackOpts.parse_mode;
							if (fallbackOpts.caption) {
								fallbackOpts.caption = TelegramMarkupHelper.stripHtml(fallbackOpts.caption);
							}
						}

						return await sendFn(fallbackOpts);
					}
				};

				if (options.sendMediaAsSticker || content.mimetype.includes("webp")) {
					response = await sendMediaWithFallback((opts) =>
						this.apiClient.sendSticker(chatId, mediaBuffer, opts)
					);
				} else if (content.mimetype.includes("image")) {
					response = await sendMediaWithFallback((opts) =>
						this.apiClient.sendPhoto(chatId, mediaBuffer, opts)
					);
				} else if (content.mimetype.includes("video")) {
					response = await sendMediaWithFallback((opts) =>
						this.apiClient.sendVideo(chatId, mediaBuffer, opts)
					);
				} else if (content.mimetype.includes("audio")) {
					response = await sendMediaWithFallback((opts) =>
						this.apiClient.sendAudio(chatId, mediaBuffer, opts)
					);
				} else {
					tgOptions.filename = content.filename || "file";
					response = await sendMediaWithFallback((opts) =>
						this.apiClient.sendDocument(chatId, mediaBuffer, opts)
					);
				}
			} else {
				this.logger.error("sendMessage: Unhandled content type for Telegram.", content);
				return;
			}

			return {
				id: { _serialized: `${response.chat.id}_${response.from.id}_${response.message_id}` },
				messageId: response.message_id,
				ack: 1, // Simula o envio
				body: content,
				_data: response,
				react: async () => true
			};
		} catch (error) {
			this.logger.error(`Error sending message to ${chatId} via Telegram:`);
			throw error;
		}
	}

	/**
	 * Constrói uma matriz de botões inline para a Telegram Bot API.
	 * @param {Array} buttons - Array 1D ou 2D de objetos de botão.
	 * @returns {Array<Array<Object>>}
	 */
	_buildInlineKeyboard(buttons) {
		if (!Array.isArray(buttons) || buttons.length === 0) return [];

		const is2D = Array.isArray(buttons[0]);
		const rows = is2D ? buttons : [buttons];

		return rows
			.map((row) => {
				if (!Array.isArray(row)) row = [row];
				return row
					.map((btn) => {
						if (!btn || !btn.text) return null;
						if (btn.url) {
							return { text: btn.text, url: btn.url };
						}
						const action = btn.action || btn.command || btn.value || "";
						const callbackData = TelegramCallbackManager.encode(action);
						return {
							text: btn.text,
							callback_data: callbackData
						};
					})
					.filter(Boolean);
			})
			.filter((r) => r.length > 0);
	}

	/**
	 * Gera botões automáticos para mensagens conhecidas (como rolls de waifus).
	 * A lógica é compartilhada com o DiscordBot via InteractiveButtonsHelper.
	 * @param {Object} options - Opções do ReturnMessage.
	 * @returns {Array<Array<Object>>|null}
	 */
	_generateAutomaticButtons(options) {
		return generateAutomaticButtons(options);
	}

	splitContent(text = "", maxLength = 4000) {
		const chunks = [];
		if (!(typeof text === "string" || text instanceof String)) return;
		let remainingText = text?.trim() ?? ""; // Start with trimmed text

		while (remainingText.length > 0) {
			// If the remainder fits, add it as the last chunk and stop
			if (remainingText.length <= maxLength) {
				chunks.push(remainingText);
				break;
			}

			let splitIndex = -1;
			let charsToSkip = 0;

			// Get the part of the string we're allowed to search in
			const searchChunk = remainingText.substring(0, maxLength);

			// 1. Try to split by double line break
			let idx = searchChunk.lastIndexOf("\n\n");
			if (idx > -1) {
				splitIndex = idx;
				charsToSkip = 2; // Length of '\n\n'
			}

			// 2. Try to split by single line break (if no double found)
			if (splitIndex === -1) {
				idx = searchChunk.lastIndexOf("\n");
				if (idx > -1) {
					splitIndex = idx;
					charsToSkip = 1; // Length of '\n'
				}
			}

			// 3. Try to split by space (if no newlines found)
			if (splitIndex === -1) {
				idx = searchChunk.lastIndexOf(" ");
				if (idx > -1) {
					splitIndex = idx;
					charsToSkip = 1; // Length of ' '
				}
			}

			// 4. Handle the split
			if (splitIndex !== -1) {
				// Found a preferred delimiter. Split before it.
				const chunk = remainingText.substring(0, splitIndex);
				if (chunk.length > 0) {
					chunks.push(chunk);
				}
				// The new "remaining" text starts AFTER the delimiter
				remainingText = remainingText.substring(splitIndex + charsToSkip).trimStart();
			} else {
				// Priority 4: No delimiters found. Hard cut at maxLength.
				chunks.push(remainingText.substring(0, maxLength));
				remainingText = remainingText.substring(maxLength).trimStart();
			}
		}

		// Final filter to ensure no empty strings (e.g., from consecutive delimiters)
		return chunks.filter((chunk) => chunk.length > 0);
	}

	_formatMessage(text, mentionMap = {}) {
		return TelegramMarkupHelper.formatWhatsAppToTelegram(text, mentionMap);
	}

	async sendReturnMessages(returnMessages) {
		if (!Array.isArray(returnMessages)) {
			returnMessages = [returnMessages];
		}
		const okMessages = returnMessages.filter((msg) => msg && msg.isValid && msg.isValid()); // Chats com @ são whatsapp, ignorar
		if (okMessages.length === 0) return [];

		// Use flatMap to process the array
		const MAX_LENGTH = 4000;

		const validMessages = okMessages.flatMap((msg) => {
			//const mentions = msg.options?.mentions || []; // Moved to sendMessage

			if (typeof msg.content === "string" || msg.content instanceof String) {
				// Removed early formatting to support direct sendMessage calls and avoid double formatting.
				// Logic moved to sendMessage.
				// msg.content = this._formatMessage(msg.content, mentions);

				// Se for texto, divide pra não ficar longo
				const MAX_LENGTH = 3500; // Reduced to allow HTML tags expansion

				if (msg.content.length <= MAX_LENGTH) {
					return [msg];
				}

				const contentChunks = this.splitContent(msg.content, MAX_LENGTH);

				return contentChunks.map((chunk, index) => {
					if (index === 0) {
						return { ...msg, content: chunk };
					}

					// Apenas o primeiro pedaço responde a mensagem original,
					// evitando vários replies para a mesma mensagem.
					const baseOptions = msg.options ? { ...msg.options } : {};
					delete baseOptions.quotedMsgId;
					delete baseOptions.quotedMessageId;
					delete baseOptions.goReply;

					return { ...msg, content: chunk, options: baseOptions };
				});
			} else {
				return msg;
			}
		});

		const results = [];

		for (const message of validMessages) {
			if (message.delay > 0) await sleep(message.delay);

			try {
				const messageOptions = {
					...message.options,
					telegram: message.telegram || message.options?.telegram,
					buttons: message.buttons || message.options?.buttons,
					farmData: message.farmData || message.options?.farmData,
					invData: message.invData || message.options?.invData
				};
				const result = await this.sendMessage(message.chatId, message.content, messageOptions);
				results.push(result);

				if (messageOptions.farmData?.userId) {
					try {
						const FazendaCommands = require("./functions/FazendaCommands");
						if (typeof FazendaCommands.recordFarmMessage === "function") {
							const sentMsgId =
								result?.messageId ||
								result?._data?.message_id ||
								messageOptions.telegram?.editMessageId;
							if (sentMsgId) {
								FazendaCommands.recordFarmMessage(
									message.chatId,
									messageOptions.farmData.userId,
									sentMsgId
								);
							}
						}
					} catch (farmTrackErr) {
						this.logger.debug(
							`[sendReturnMessages] Erro ao registrar mensagem da fazenda: ${farmTrackErr.message}`
						);
					}
				}

				if (messageOptions.invData?.userId) {
					try {
						const FazendaCommands = require("./functions/FazendaCommands");
						if (typeof FazendaCommands.recordInvMessage === "function") {
							const sentMsgId =
								result?.messageId ||
								result?._data?.message_id ||
								messageOptions.telegram?.editMessageId;
							if (sentMsgId) {
								FazendaCommands.recordInvMessage(
									message.chatId,
									messageOptions.invData.userId,
									sentMsgId
								);
							}
						}
					} catch (invTrackErr) {
						this.logger.debug(
							`[sendReturnMessages] Erro ao registrar mensagem do inventário: ${invTrackErr.message}`
						);
					}
				}

				// FIX REACTIONS
				// if (message.reaction && result && result.id?._serialized) {
				//   try {
				//     const channel = await this.discordClient.channels.fetch(message.chatId);
				//     const sentMessage = await channel.messages.fetch(result.id._serialized);
				//     await sentMessage.react(message.reaction);
				//   } catch (reactError) {
				//     this.logger.error(`[sendReturnMessages] Erro enviando reaction "${message.reaction}" para ${result.id._serialized}:`, reactError);
				//   }
				// }
			} catch (sendError) {
				this.logger.error(
					`[sendReturnMessages] Falha enviando ReturnMessages para ${message.chatId}:`,
					sendError
				);
				results.push({ error: sendError, messageContent: message.content });
			}
		}
		return results;
	}

	/**
	 * Reação de fallback (Telegram não possui reações nativas tratadas desta forma).
	 * Retorna Promise resolvida com true para garantir compatibilidade com chamadas assíncronas e .catch().
	 * @returns {Promise<boolean>}
	 */
	async react() {
		return true;
	}

	// --- Funções de Grupo ---

	_handleGroupMembershipUpdate(chatMember) {
		const chatId = chatMember.chat.id;
		const newStatus = chatMember.new_chat_member.status;

		if (newStatus === "member" || newStatus === "administrator") {
			this.logger.info(`Bot was added to group: ${chatMember.chat.title} (${chatId})`);
			// Simula o evento `groups.upsert` do wwebjs
			const groupUpdateData = {
				id: chatId,
				action: "add",
				participants: [this.botInfo.id],
				isBotJoining: true
			};
			this._handleGroupParticipantsUpdate(groupUpdateData);
		}
	}

	_handleGroupParticipantsUpdate(chatMemberOrSimulated) {
		// Este método pode receber um `chatMember` do Telegram ou um objeto simulado
		let eventData;
		if (chatMemberOrSimulated.isBotJoining !== undefined) {
			// Objeto simulado
			eventData = chatMemberOrSimulated;
		} else {
			// Objeto real do Telegram
			const chatMember = chatMemberOrSimulated;
			const action = chatMember.new_chat_member.status === "member" ? "add" : "remove";
			if (chatMember.new_chat_member.user.id === this.botInfo.id) return; // Ignora o próprio bot entrando/saindo

			eventData = {
				id: chatMember.chat.id,
				action,
				participants: [chatMember.new_chat_member.user.id],
				isBotJoining: false
			};
		}

		if (this.eventHandler && typeof this.eventHandler.onGroupParticipantsUpdate === "function") {
			this.eventHandler.onGroupParticipantsUpdate(this, eventData);
		}
	}

	async setGroupName(groupId, title) {
		if (!groupId || !title) return false;
		try {
			return await this.apiClient.setChatTitle(groupId, title);
		} catch (err) {
			this.logger.error(`[setGroupName] Erro ao alterar título de ${groupId}:`, err);
			throw err;
		}
	}

	async setGroupSubject(groupId, title) {
		return await this.setGroupName(groupId, title);
	}

	async getChatDetails(chatId) {
		try {
			if (chatId.includes("@")) {
				// Coisa do zap
				return;
			}

			const chat = await this.apiClient.getChat(chatId);
			const isGroup = chat.type === "group" || chat.type === "supergroup";

			const formattedChat = {
				id: { _serialized: chat.id },
				name: chat.title,
				isGroup,
				participants: [], // Preenchido abaixo para admins
				setSubject: async (title) => this.apiClient.setChatTitle(chatId, title)
			};

			if (isGroup) {
				const admins = await this.apiClient.getChatAdministrators(chatId);
				formattedChat.participants = admins.map((admin) => ({
					id: { _serialized: String(admin.user.id) },
					isAdmin: true, // Lógica do Whatsgo usa `p.admin?.includes("admin")`
					admin: "admin"
				}));
			}

			this.cacheManager.putChatInCache(formattedChat);
			return formattedChat;
		} catch (error) {
			this.logger.error(`Failed to get chat details for ${chatId}`);
			return null;
		}
	}

	async _loadSkipGroupInfo() {
		try {
			const skipped = await SkipGroups.getInstance().getSkippedGroups(this.id);
			const cleaned = [];
			for (const gid of skipped) {
				if (this.isSystemGroup(gid)) {
					this.logger.warn(
						`[SkipGroups] Removendo grupo de sistema (${gid}) da skip list do bot ${this.id}.`
					);
					await SkipGroups.getInstance().removeSkippedGroup(this.id, gid);
				} else {
					cleaned.push(gid);
				}
			}
			this.skipGroupInfo = cleaned;
			this.logger.info(
				`[SkipGroups] Loaded ${this.skipGroupInfo.length} skipped groups for bot ${this.id}.`
			);
		} catch (error) {
			this.logger.error(`[SkipGroups] Error loading skip groups:`, error);
			this.skipGroupInfo = [];
		}
	}

	async _saveSkipGroupInfo() {
		// Deprecated: No longer needed as we save incrementally to DB
	}

	async addSkipGroup(groupId) {
		if (!this.skipGroupInfo.includes(groupId)) {
			this.skipGroupInfo.push(groupId);
			await SkipGroups.getInstance().addSkippedGroup(this.id, groupId);
			this.logger.info(`[SkipGroups] Added ${groupId} to skip list.`);
		}
	}

	async removeSkipGroup(groupId) {
		const initialLength = this.skipGroupInfo.length;
		this.skipGroupInfo = this.skipGroupInfo.filter((id) => id !== groupId);
		if (this.skipGroupInfo.length < initialLength) {
			await SkipGroups.getInstance().removeSkippedGroup(this.id, groupId);
			this.logger.info(`[SkipGroups] Removed ${groupId} from skip list.`);
		}
	}

	isParticipating(groupId) {
		if (!groupId) return false;
		if (this.isSystemGroup(groupId)) {
			return true;
		}
		if (this.skipGroupInfo && this.skipGroupInfo.includes(groupId)) {
			return false;
		}
		return true;
	}

	isInGroup(groupId) {
		return this.isParticipating(groupId);
	}

	async markNotInGroup(groupId) {
		if (!groupId) return;
		if (this.isSystemGroup(groupId)) {
			this.logger.warn(`[${this.id}] Ignorando markNotInGroup para grupo de sistema: ${groupId}`);
			return;
		}
		await this.addSkipGroup(groupId);
		try {
			if (this.eventHandler?.groups?.[groupId]) {
				const grp = this.eventHandler.groups[groupId];
				if (!grp.botNotInGroup) grp.botNotInGroup = [];
				if (!grp.botNotInGroup.includes(this.id)) {
					grp.botNotInGroup.push(this.id);
				}
			}
			if (this.database?.getGroup && this.database?.saveGroup) {
				const group = await this.database.getGroup(groupId);
				if (group) {
					if (!group.botNotInGroup) group.botNotInGroup = [];
					if (!group.botNotInGroup.includes(this.id)) {
						group.botNotInGroup.push(this.id);
						await this.database.saveGroup(group);
					}
				}
			}
		} catch (error) {
			this.logger.error(`[TelegramBot] Erro ao marcar botNotInGroup:`, error);
		}
	}

	async markInGroup(groupId) {
		if (!groupId) return;
		await this.removeSkipGroup(groupId);
		try {
			if (this.eventHandler?.groups?.[groupId]) {
				const grp = this.eventHandler.groups[groupId];
				if (grp.botNotInGroup && grp.botNotInGroup.includes(this.id)) {
					grp.botNotInGroup = grp.botNotInGroup.filter((b) => b !== this.id);
				}
			}
			if (this.database?.getGroup && this.database?.saveGroup) {
				const group = await this.database.getGroup(groupId);
				if (group && group.botNotInGroup && group.botNotInGroup.includes(this.id)) {
					group.botNotInGroup = group.botNotInGroup.filter((b) => b !== this.id);
					await this.database.saveGroup(group);
				}
			}
		} catch (error) {
			this.logger.error(`[TelegramBot] Erro ao remover botNotInGroup:`, error);
		}
	}

	async getContactDetails(contactId, prefetchedName = "") {
		// No Telegram, o "contato" é apenas o usuário. Não há um objeto separado como no WhatsApp.
		const contact = {
			id: { _serialized: contactId },
			name: prefetchedName,
			pushname: prefetchedName,
			number: contactId,
			isUser: true,
			isContact: true
		};
		this.cacheManager.putContactInCache(contact);
		return Promise.resolve(contact);
	}

	// --- Funções de Registro de Comandos ---
	async registerCommands() {
		this.logger.info("Registering Telegram commands...");
		try {
			if (!this.eventHandler) {
				this.logger.warn("eventHandler is not defined. Skipping command registration.");
				return;
			}
			// Acessa os comandos da mesma forma que a função sendCommandList
			const fixedCommands = this.eventHandler.commandHandler.fixedCommands.getAllCommands();
			const managementCommands =
				this.eventHandler.commandHandler.management.getManagementCommands();

			// Filtra para incluir apenas os comandos da categoria 'geral', conforme solicitado
			this.logger.info("Filtering to register only 'geral' and 'grupo' commands.");
			const generalCommands = fixedCommands.filter((cmd) => cmd.category === "geral");

			// 'managementCommands' são considerados os comandos de 'grupo'
			const allCommands = [...generalCommands];

			// Formata os comandos de gerenciamento
			// for (const key in managementCommands) {
			//   const cmd = managementCommands[key];
			//   // Telegram não aceita '-' no nome do comando, substituímos por '_'
			//   const commandName = `g_${key.replace(/-/g, '_')}`.toLowerCase();
			//   allCommands.push({
			//     name: commandName,
			//     description: cmd.description,
			//     hidden: cmd.hidden
			//   });
			// }

			// Filtra e formata para o padrão do Telegram
			const telegramCommands = allCommands
				.filter((cmd) => !cmd.hidden) // Ignora comandos ocultos
				.map((cmd) => ({
					command: cmd.name.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
					description: cmd.description || "Sem descrição."
				}));

			// Remove duplicates
			const uniqueCommands = [
				...new Map(telegramCommands.map((item) => [item.command, item])).values()
			];

			await this.apiClient.setMyCommands(uniqueCommands);
			this.logger.info(`Successfully registered ${telegramCommands.length} commands for Telegram.`);
		} catch (e) {
			this.logger.warn("Could not register Telegram commands:", e.message);
		}
	}

	// --- Funções do Whatsgo que não se aplicam ao Telegram (stubs) ---

	async recoverMsgFromCache(messageId) {
		// O ID da mensagem no Telegram é diferente, a lógica de cache pode precisar de ajuste
		return this.cacheManager.getMessageFromCache(messageId);
	}

	async updateProfilePicture(media) {
		this.logger.warn(
			"[Telegram] updateProfilePicture is not implemented for a specific chat, only for the bot itself."
		);
		return Promise.resolve(true);
	}

	async createMedia(filePath, customMime = false) {
		const data = fs.readFileSync(filePath, { encoding: "base64" });
		const filename = path.basename(filePath);
		const mimetype = customMime || mime.lookup(filePath) || "application/octet-stream";
		return { mimetype, data, filename, isMessageMedia: true };
	}

	async createMediaFromURL(url, options = {}) {
		return {
			url,
			mimetype: mime.lookup(url.split("?")[0]),
			filename: "media_from_url",
			isMessageMedia: true
		};
	}

	async createMediaFromBase64(base64Data, mimetype, filename) {
		const extension = mime.extension(mimetype) ?? "bin";
		return {
			mimetype,
			data: base64Data,
			filename: filename ?? `file.${extension}`,
			source: "base64",
			isMessageMedia: true,
			size: Buffer.byteLength(base64Data, "base64")
		};
	}

	notInWhitelist(author) {
		const cleanAuthor = String(author || "").replace(/\D/g, "");
		const list = this.whitelist || this.whitelistPV || [];
		return !list.includes(cleanAuthor);
	}

	// As funções abaixo são stubs e não têm efeito no bot do Telegram.
	logout() {
		this.logger.warn("logout() is not applicable for Telegram Bot");
		return Promise.resolve();
	}
	deleteInstance() {
		this.logger.warn("deleteInstance() is not applicable for Telegram Bot");
		return Promise.resolve();
	}
	createInstance() {
		this.logger.warn("createInstance() is not applicable for Telegram Bot");
		return Promise.resolve();
	}
	recreateInstance() {
		this.logger.warn("recreateInstance() is not applicable for Telegram Bot");
		return Promise.resolve();
	}
	updateVersions() {
		this.logger.debug("updateVersions() is not applicable for Telegram Bot");
		return Promise.resolve();
	}
	inviteInfo(inviteCode) {
		this.logger.warn(`inviteInfo(${inviteCode}) is not applicable for Telegram Bot`);
		return Promise.resolve(null);
	}
	acceptInviteCode(inviteCode) {
		this.logger.warn(`acceptInviteCode(${inviteCode}) is not applicable for Telegram Bot`);
		return Promise.resolve(null);
	}
	leaveGroup(groupId) {
		this.logger.info(`Leaving group ${groupId}`);
		return this.apiClient.leaveChat(groupId);
	}
	updatePrivacySettings(settings) {
		this.logger.warn("updatePrivacySettings() is not applicable for Telegram Bot");
		return Promise.resolve(true);
	}
	updateProfileStatus(status) {
		if (process.env.DISABLE_ACTIVITY === "true") return Promise.resolve(true);
		this.logger.warn(
			`updateProfileStatus() is not applicable for Telegram Bot, cannot set status: "${status}"`
		);
		return Promise.resolve(true);
	}
	deleteMessageByKey(key) {
		this.logger.warn("deleteMessageByKey() is not fully implemented for Telegram");
		return Promise.resolve(true);
	}

	// Fallbacks da Whatsgo, só pro teles não dar erro
	getCurrentTimestamp() {
		return Math.round(Date.now() / 1000);
	}
	getLidFromPn(pn, chat) {
		return pn;
	}
	getPnFromLid(lid, chat) {
		return lid;
	}

	/**
	 * Verifica se um chat/grupo é um grupo de sistema do bot (logs, invites, avisos, anúncios, dossiês, estabilidade).
	 * Grupos de sistema nunca devem ser adicionados à skip list nem bloqueados em isParticipating.
	 * @param {string|number} groupId - ID do grupo a verificar
	 * @returns {boolean}
	 */
	isSystemGroup(groupId) {
		if (!groupId) return false;
		const clean = (id) => String(id).split("@")[0].trim();
		const targetClean = clean(groupId);
		const targetRaw = String(groupId).trim();

		const matches = (sysConfig) => {
			if (!sysConfig) return false;
			const list = Array.isArray(sysConfig)
				? sysConfig
				: typeof sysConfig === "string" && sysConfig.includes(",")
					? sysConfig.split(",").map((g) => g.trim())
					: [sysConfig];
			return list.some((g) => clean(g) === targetClean || String(g).trim() === targetRaw);
		};

		return (
			matches(this.grupoLogs) ||
			matches(this.grupoInvites) ||
			matches(this.grupoAvisos) ||
			matches(this.grupoEstabilidade) ||
			this.isDossieGroup(groupId)
		);
	}

	/**
	 * Verifica se um chat/grupo é o grupo de dossiês do bot
	 * @param {string|number} groupId - ID do chat a verificar
	 * @returns {boolean}
	 */
	isDossieGroup(groupId) {
		if (!this.dossieGroups || !groupId) return false;
		const clean = (id) => String(id).split("@")[0].trim();
		const targetClean = clean(groupId);
		const groups = Array.isArray(this.dossieGroups)
			? this.dossieGroups
			: typeof this.dossieGroups === "string" && this.dossieGroups.includes(",")
				? this.dossieGroups.split(",").map((g) => g.trim())
				: [this.dossieGroups];
		return groups.some(
			(g) => clean(g) === targetClean || String(g).trim() === String(groupId).trim()
		);
	}

	/**
	 * Obtém a URL da foto de perfil de um usuário no Telegram
	 * @param {string|number} userId
	 * @returns {Promise<string|null>}
	 */
	async getProfilePictureUrl(userId) {
		try {
			if (!userId) return null;
			return await this.apiClient.getUserProfilePhotoUrl(userId);
		} catch (error) {
			this.logger.debug(
				`[getProfilePictureUrl] Erro ao obter foto do usuário ${userId}: ${error.message}`
			);
			return null;
		}
	}

	/**
	 * Edita o texto de uma mensagem no Telegram com formatação e fallback automático
	 * @param {string|number} chatId
	 * @param {string|number} messageId
	 * @param {string} text
	 * @param {Object} [options={}]
	 * @returns {Promise<Object>}
	 */
	async editMessageText(chatId, messageId, text, options = {}) {
		const formattedText = options.skipFormatting ? text : this._formatMessage(text);
		const tgOptions = {
			parse_mode: options.parse_mode || "HTML",
			...options
		};
		delete tgOptions.skipFormatting;

		try {
			return await this.apiClient.editMessageText(chatId, messageId, formattedText, tgOptions);
		} catch (err) {
			if (
				err.message &&
				(err.message.includes("can't parse entities") || err.message.includes("parse_mode"))
			) {
				const fallbackOpts = { ...tgOptions };
				delete fallbackOpts.parse_mode;
				return await this.apiClient.editMessageText(
					chatId,
					messageId,
					TelegramMarkupHelper.stripHtml(formattedText),
					fallbackOpts
				);
			}
			throw err;
		}
	}

	async destroy() {
		this.logger.info(`[${this.id}] Shutting down Telegram Bot.`);
		this.isPolling = false;
		if (this.pollingInterval) {
			clearInterval(this.pollingInterval);
			this.pollingInterval = null;
		}
		if (this.webhookMonitorInterval) {
			clearInterval(this.webhookMonitorInterval);
			this.webhookMonitorInterval = null;
		}
		if (this.webhookServer) {
			await new Promise((resolve) => this.webhookServer.close(resolve));
			this.webhookServer = null;
		}
		// Certifica-se de remover o webhook ao desligar, se estiver configurado
		if (this.webhookHost) {
			try {
				await this.apiClient.deleteWebhook();
			} catch (e) {
				this.logger.error(`Error deleting webhook during destroy:`, e);
			}
		}
		this._onInstanceDisconnected("DESTROYED");
		this.cacheManager.stop();
	}
}

module.exports = WhatsAppBotTelegram;
