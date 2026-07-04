/* VIBE CODED PELO GEMINI */
const express = require("express");
const mime = require("mime-types");
const path = require("path");
const fs = require("fs");

const TelegramClient = require("./services/TelegramClient");
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
const { promisify } = require("util");

// Utils
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);
const unlinkAsync = promisify(fs.unlink);

class WhatsAppBotTelegram {
	constructor(options) {
		this.id = options.id;
		this.telegramBotName = options.telegramBotName || "ravenabot";
		this.eventHandler = options.eventHandler;
		this.prefix = options.prefix || process.env.DEFAULT_PREFIX || "/";
		this.logger = new Logger(`bot-telegram-${this.id}`);

		// Opções específicas do Telegram
		this.useTelegram = true;
		this.telegramBotToken = options.telegramBotToken;
		this.telegramSecretToken = options.telegramSecretToken || "";

		// Opções compartilhadas utilizadas
		this.nomeExibir = options.nomeExibir;
		this.sendJoinInfo = options.sendJoinInfo;
		this.pvAI = options.pvAI ?? true;
		this.ignorePV = options.ignorePV || false;
		this.updateStatus = options.updateStatus ?? true;
		this.aiPersonality = options.aiPersonality ?? "";
		this.grupoLogs = parseInt(options.grupoLogs || process.env.TELEGRAM_GRUPO_LOGS);
		this.grupoAvisos = parseInt(options.grupoAvisos || process.env.TELEGRAM_GRUPO_AVISOS);
		this.notificarDonate = options.notificarDonate;
		this.webhookHost = options.webhookHost; // ex: ravena.moothz.win
		this.webhookPort = options.webhookPort || 9001;
		this.pollingInterval = null; // Para armazenar o ID do intervalo de polling
		this.webhookMonitorInterval = null;
		this.webhookFailures = 0;
		this.isPolling = false;
		this.linkAvisos = options.linkAvisos ?? process.env.LINK_GRUPO_AVISOS;
		this.linkGrupao = options.linkGrupao ?? process.env.LINK_GRUPO_INTERACAO;

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

				this.loadReport.trackReceivedMessage(isGroup, 0, chatId);

				let type = "unknown";
				let content = null;
				let caption = null;
				let mediaInfo = null;

				// remove o @nomedobot pra facilitar
				if (message.text) {
					type = "text";
					content = message.text.replace(`@${this.telegramBotName}`, "");
				} else if (message.photo) {
					type = "image";
					const photo = message.photo[message.photo.length - 1]; // Pega a maior resolução
					mediaInfo = { fileId: photo.file_id, mimetype: "image/jpeg", type: "photo" };
					caption = message.caption?.replace(`@${this.telegramBotName}`, "") ?? false;
					content = mediaInfo;
				} else if (message.video) {
					type = "video";
					mediaInfo = {
						fileId: message.video.file_id,
						mimetype: message.video.mime_type || "video/mp4",
						type: "video"
					};
					caption = message.caption?.replace(`@${this.telegramBotName}`, "") ?? false;
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
					content = mediaInfo;
				} else {
					this.logger.debug("Unhandled Telegram message type:", message);
					return resolve(null);
				}

				const formattedMessage = {
					telegramMessage: message,
					id: message.message_id,
					key: { id: message.message_id }, // Fallback pro redis cache
					fromMe: message.from.id === this.botInfo.id,
					group: isGroup ? chatId : null,
					from: isGroup ? chatId : authorId,
					author: authorId,
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

					react: () => true,
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
						author: authorId,
						from: chatId,
						react: () => true,
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

	async sendMessage(chatId, content, options = {}) {
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
			if (options.quotedMsgId) {
				// O ID da mensagem no Telegram é apenas o número
				const messageId = options.quotedMsgId.split("_").pop();
				if (messageId) tgOptions.reply_to_message_id = messageId;
			}

			// Resolve Mentions
			const mentionMap = {};
			if (options.mentions && Array.isArray(options.mentions)) {
				await Promise.all(
					options.mentions.map(async (mentionedId) => {
						const name = await this.resolveMentionName(mentionedId, chatId);
						if (name) mentionMap[mentionedId] = name;
					})
				);
			}

			// Format Content (Text)
			if (typeof content === "string") {
				content = this._formatMessage(content, mentionMap);
			}

			// Format Caption (Media)
			if (options.caption) {
				options.caption = this._formatMessage(options.caption, mentionMap);
			}

			let response;
			if (typeof content === "string") {
				this.logger.debug(`[sendMessage] Text to '${chatId}'`, { content, options, tgOptions });
				response = await this.apiClient.sendMessage(chatId, content, tgOptions);
			} else if (content.isMessageMedia || (content.data && content.mimetype)) {
				const mediaBuffer = Buffer.from(content.data, "base64");
				tgOptions.caption = options.caption;

				if (options.sendMediaAsSticker || content.mimetype.includes("webp")) {
					response = await this.apiClient.sendSticker(chatId, mediaBuffer, tgOptions);
				} else if (content.mimetype.includes("image")) {
					response = await this.apiClient.sendPhoto(chatId, mediaBuffer, tgOptions);
				} else if (content.mimetype.includes("video")) {
					response = await this.apiClient.sendVideo(chatId, mediaBuffer, tgOptions);
				} else if (content.mimetype.includes("audio")) {
					response = await this.apiClient.sendAudio(chatId, mediaBuffer, tgOptions);
				} else {
					tgOptions.filename = content.filename || "file";
					response = await this.apiClient.sendDocument(chatId, mediaBuffer, tgOptions);
				}
			} else {
				this.logger.error("sendMessage: Unhandled content type for Telegram.", content);
				return;
			}

			return {
				id: { _serialized: `${response.chat.id}_${response.from.id}_${response.message_id}` },
				ack: 1, // Simula o envio
				body: content,
				_data: response
			};
		} catch (error) {
			this.logger.error(`Error sending message to ${chatId} via Telegram:`);
			throw error;
		}
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
		if (typeof text !== "string") return text;

		// 1. Escape HTML special characters to prevent injection/breakage
		let formatted = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

		// 2. Handle Mentions
		// Replaces @123456789 with <a href="tg://user?id=123456789">@Name</a>
		if (Array.isArray(mentionMap)) {
			// Legacy array support (just IDs)
			for (const mentionId of mentionMap) {
				const mentionRegex = new RegExp(`@${mentionId}\\b`, "g");
				formatted = formatted.replace(
					mentionRegex,
					`<a href="tg://user?id=${mentionId}">@${mentionId}</a>`
				);
			}
		} else if (typeof mentionMap === "object") {
			// Map support (ID -> Name)
			for (const [id, name] of Object.entries(mentionMap)) {
				const mentionRegex = new RegExp(`@${id}\\b`, "g");
				const displayName = name || id;
				formatted = formatted.replace(
					mentionRegex,
					`<a href="tg://user?id=${id}">@${displayName}</a>`
				);
			}
		}

		// 3. Convert WhatsApp Markup to Telegram HTML
		formatted = formatted
			// Bold: *text* -> <b>text</b>
			.replace(/\*([^*\n]+?)\*/g, "<b>$1</b>")
			// Italic: _text_ -> <i>text</i>
			.replace(/_([^_]+?)_/g, "<i>$1</i>")
			// Strikethrough: ~text~ -> <s>text</s>
			.replace(/~([^~]+?)~/g, "<s>$1</s>")
			// Monospace: ```text``` -> <pre>text</pre>
			.replace(/```([\s\S]+?)```/g, "<pre>$1</pre>")
			// Inline Code: `text` -> <code>text</code>
			.replace(/`([^`]+?)`/g, "<code>$1</code>");

		// 4. Convert trailing URL to "Link Direto"
		const urlRegex = /(https?:\/\/[^\s<]+)\s*$/i;
		formatted = formatted.replace(urlRegex, '<a href="$1">Link Direto</a>');

		return formatted;
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

				return contentChunks.map((chunk) => ({
					...msg,
					content: chunk
				}));
			} else {
				return msg;
			}
		});

		const results = [];

		for (const message of validMessages) {
			if (message.delay > 0) await sleep(message.delay);

			try {
				const result = await this.sendMessage(message.chatId, message.content, message.options);
				results.push(result);

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
			this.skipGroupInfo = await SkipGroups.getInstance().getSkippedGroups(this.id);
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
