/**
 * WhatsAppBotWuzapi.js
 * Implementação do bot WhatsApp usando wuzapi (asternic/wuzapi) via REST API.
 *
 * Substitui WhatsAppBotGo.js (whatsgoapi) mantendo a mesma interface
 * para o resto do código (eventHandler, BotAPI, CommandHandler, etc).
 */

const qrcode = require("qrcode-terminal");
const qrimg = require("qr-image");
const { randomBytes } = require("crypto");
const imagemagick = require("imagemagick");
const ffmpeg = require("fluent-ffmpeg");
const { promisify } = require("util");
const express = require("express");
const mime = require("mime-types");
const axios = require("axios");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const os = require("os");

const WuzapiClient = require("./services/WuzapiClient");
const CacheManager = require("./services/CacheManager");
const ReturnMessage = require("./models/ReturnMessage");
const ReactionsHandler = require("./ReactionsHandler");
const LLMService = require("./services/LLMService");
const MentionHandler = require("./MentionHandler");
const AdminUtils = require("./utils/AdminUtils");
const InviteSystem = require("./InviteSystem");
const StreamSystem = require("./StreamSystem");
const Database = require("./utils/Database");
const LoadReport = require("./LoadReport");
const Logger = require("./utils/Logger");
const SkipGroups = require("./utils/SkipGroups");
const { toOpus, toMp3 } = require("./utils/Conversions");
const { llmTranslate } = require("./utils/LLMTranslate");

// Utils
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);
const unlinkAsync = promisify(fs.unlink);
const convertAsync = promisify(imagemagick.convert);

class WhatsAppBotWuzapi {
	constructor(options) {
		this.id = options.id;
		this.vip = options.vip;
		this.comunitario = options.comunitario;
		this.numeroResponsavel = options.numeroResponsavel;
		this.supportMsg = options.supportMsg;
		this.phoneNumber = options.phoneNumber;
		this.eventHandler = options.eventHandler;
		this.prefix = options.prefix ?? process.env.DEFAULT_PREFIX ?? "!";
		this.logger = new Logger(`bot-wuzapi-${this.id}`);
		this.wuzapiUrl = options.wuzapiUrl;
		this.wuzapiAdminToken = options.wuzapiAdminToken;
		this.instanceName = options.wuzapiInstanceName ?? options.id;
		let wh = options.webhookHost;
		if (wh && !wh.startsWith("http://") && !wh.startsWith("https://")) {
			wh = "http://" + wh;
		}
		this.webhookHost = wh;
		this.webhookPort = options.webhookPort ?? process.env.WEBHOOK_PORT_WUZAPI ?? 3000;
		this.notificarDonate = options.notificarDonate;
		this.pvAI = options.pvAI;
		this.version = "Wuzapi";
		this.wwebversion = "0";
		this.banido = options.banido;
		this.comandosAudioPV = false;

		// Acesso pelo painel por terceiros
		this.privado = options.privado ?? false;
		this.managementUser = options.managementUser ?? process.env.BOTAPI_USER ?? "admin";
		this.managementPW = options.managementPW ?? process.env.BOTAPI_PASSWORD ?? "batata123";

		this.redisURL = options.redisURL;
		this.redisDB = options.redisDB ?? 0;
		this.redisTTL = options.redisTTL ?? 604800;
		this.maxCacheSize = 1000;

		this.streamIgnoreGroups = [];
		this.skipGroupInfo = [];
		this.messageCache = [];
		this.contactCache = [];
		this.sentMessagesCache = [];
		this.cacheManager = new CacheManager(
			this.redisURL,
			this.redisDB,
			this.redisTTL,
			this.maxCacheSize
		);

		if (!this.wuzapiUrl || !this.wuzapiAdminToken || !this.instanceName || !this.webhookHost) {
			const errMsg =
				"WhatsAppBotWuzapi: wuzapiUrl, wuzapiAdminToken, instanceName, and webhookHost are required!";
			this.logger.error(errMsg, {
				wuzapiUrl: !!this.wuzapiUrl,
				wuzapiAdminToken: !!this.wuzapiAdminToken,
				instanceName: !!this.instanceName,
				webhookHost: !!this.webhookHost
			});
			throw new Error(errMsg);
		}

		this.apiClient = new WuzapiClient(
			this.wuzapiUrl,
			this.wuzapiAdminToken,
			this.instanceName,
			this.logger
		);

		this.database = Database.getInstance();
		this.isConnected = false;
		this.safeMode =
			options.safeMode !== undefined ? options.safeMode : process.env.SAFE_MODE === "true";
		this.otherBots = options.otherBots ?? [];

		this.ignorePV = options.ignorePV ?? false;
		this.autoDownloadPV = options.autoDownloadPV ?? false;
		this.whitelist = options.whitelistPV ?? [];
		this.ignoreInvites = options.ignoreInvites ?? false;
		this.grupoLogs = options.grupoLogs ?? process.env.GRUPO_LOGS;
		this.grupoInvites = options.grupoInvites ?? process.env.GRUPO_INVITES;
		this.grupoAvisos = options.grupoAvisos ?? process.env.GRUPO_AVISOS;
		this.grupoAnuncios = options.grupoAnuncios || process.env.GRUPO_ANUNCIOS;
		this.linkAvisos = options.linkAvisos ?? process.env.LINK_GRUPO_AVISOS;
		this.linkGrupao = options.linkGrupao ?? process.env.LINK_GRUPO_INTERACAO;

		this.joinSilencioso = false;

		this.userAgent = options.userAgent ?? process.env.USER_AGENT;

		this.mentionHandler = new MentionHandler();

		this.lastMessageReceived = 0;
		this.startupTime = 0;

		this.loadReport = new LoadReport(this);
		this.inviteSystem = new InviteSystem(this);
		this.reactionHandler = new ReactionsHandler();

		this.streamSystem = null;
		this.streamMonitor = null;
		this.stabilityMonitor = options.stabilityMonitor ?? false;

		this.llmService = LLMService.getInstance();
		this.adminUtils = AdminUtils.getInstance();

		this.webhookApp = null;
		this.webhookServer = null;

		this.blockedContacts = [];

		if (process.env.DISABLE_ACTIVITY !== "true" && !this.streamSystem) {
			this.streamSystem = StreamSystem.getInstance();
			this.streamSystem.registerBot(this);
		}

		// Client Fake — interface compatível com whatsmeow
		this.client = {
			getChatById: (arg) => this.getChatDetails(arg),
			getContactById: (arg) => this.getContactDetails(arg),
			getInviteInfo: (arg) => this.inviteInfo(arg),
			getMessageById: async (messageId) => await this.recoverMsgFromCache(messageId),
			setStatus: async (arg) => {
				await this.updateProfileStatus(arg);
			},
			leaveGroup: (arg) => {
				this.leaveGroup(arg);
			},
			setProfilePicture: async (arg) => {
				await this.updateProfilePicture(arg);
			},
			setPrivacySettings: (arg) => {
				this.updatePrivacySettings(arg);
			},
			acceptInvite: async (arg) => await this.acceptInviteCode(arg),
			sendPresenceUpdate: async (xxx) => true,
			info: {
				wid: {
					_serialized: `${options.phoneNumber}`
				}
			}
		};

		this.updateVersions();
		setInterval(this.updateVersions, 3600000);

		this.scheduleGroupInfoUpdate();
	}

	// ──────────────────────────────────────────────────────────
	// Initialize
	// ──────────────────────────────────────────────────────────

	async initialize() {
		await this._loadSkipGroupInfo();
		this.database.registerBotInstance(this);
		this.startupTime = Date.now();
		this.lastMessageReceived = Date.now();

		this.logger.info(
			`[${this.startupTime}][${this.id}] Init Wuzapi bot instance ${this.instanceName}`
		);

		// Stream system registration
		if (this.streamSystem) {
			this.streamSystem.registerBot(this);
			await this.streamSystem.initialize();
			this.streamMonitor = this.streamSystem.streamMonitor;
		}

		await this._checkInstanceStatusAndConnect(false, true);

		// Set webhook
		if (this.webhookHost) {
			const webhookUrl = this._getWebhookUrl();
			this.logger.info(`Setting webhook for ${this.instanceName} to ${webhookUrl}...`);
			try {
				await this.setWebhook(webhookUrl);
			} catch (webhookError) {
				this.logger.error(`Error setting webhook for ${this.instanceName}:`, webhookError);
			}
		}
	}

	async _loadSkipGroupInfo() {
		try {
			const skipGroups = new SkipGroups(this.database);
			this.skipGroupInfo = await skipGroups.getSkipGroupInfo();
		} catch (error) {
			this.logger.error("[_loadSkipGroupInfo] Erro:", error);
		}
	}

	// ──────────────────────────────────────────────────────────
	// Scheduling
	// ──────────────────────────────────────────────────────────

	scheduleGroupInfoUpdate() {
		if (process.env.DISABLE_ACTIVITY === "true") return;
		const agora = new Date();
		const proximaExecucao = new Date(agora);
		proximaExecucao.setHours(3, 0, 0, 0);

		if (agora > proximaExecucao) {
			proximaExecucao.setDate(proximaExecucao.getDate() + 1);
		}

		let tempoAteExecucao = proximaExecucao.getTime() - agora.getTime();
		const delayAleatorio = Math.floor(Math.random() * 1800000);
		tempoAteExecucao += delayAleatorio;

		this.logger.info(
			`[scheduleGroupInfoUpdate] Atualização agendada para daqui a ${Math.floor(tempoAteExecucao / 60000)} minutos`
		);

		setTimeout(async () => {
			try {
				await this.updateGroupsInfo();
			} catch (error) {
				this.logger.error("[scheduleGroupInfoUpdate] Erro:", error);
			} finally {
				this.scheduleGroupInfoUpdate();
			}
		}, tempoAteExecucao);
	}

	async updateGroupsInfo() {
		this.logger.info("[updateGroupsInfo] Iniciando atualização de grupos...");
		try {
			const groupsData = await this.listGroups();
			if (!groupsData || !Array.isArray(groupsData)) {
				this.logger.warn("[updateGroupsInfo] Não foi possível obter lista de grupos.");
				return;
			}

			let updatedCount = 0;
			for (const entry of groupsData) {
				const id = entry.JID || entry.id;
				const name = entry.Name || entry.name || entry.subject || "";
				const topic = entry.Topic || entry.topic || entry.desc || "";

				if (!id) continue;

				const group = await this.database.getGroup(id);
				if (group) {
					let changed = false;
					if (group.titulo !== name) {
						group.titulo = name || null;
						changed = true;
					}
					if (group.descricao !== topic) {
						group.descricao = topic || null;
						changed = true;
					}

					if (changed) {
						await this.database.saveGroup(group);
						updatedCount++;
					}
				}
			}
			this.logger.info(`[updateGroupsInfo] Finalizado. ${updatedCount} grupos atualizados.`);
		} catch (e) {
			this.logger.error("[updateGroupsInfo] Erro:", e);
		}
	}

	// ──────────────────────────────────────────────────────────
	// Instância
	// ──────────────────────────────────────────────────────────

	async logout() {
		this.logger.info(`[logout] Logging out instance ${this.instanceName}`);
		return await this.apiClient.logoutInstance(this.instanceName);
	}

	async deleteInstance() {
		this.logger.info(`[deleteInstance] Deleting instance ${this.instanceName}`);
		return await this.apiClient.deleteInstance(this.instanceName);
	}

	_getWebhookUrl() {
		let host = this.webhookHost || "";
		let parsedUrl;
		try {
			parsedUrl = new URL(host);
		} catch (e) {
			parsedUrl = null;
		}

		if (parsedUrl) {
			if (!parsedUrl.port && this.webhookPort && this.webhookPort !== 80 && this.webhookPort !== 443) {
				parsedUrl.port = this.webhookPort;
			}
			host = parsedUrl.toString().replace(/\/$/, "");
		} else {
			if (host && !/:[0-9]+$/.test(host)) {
				host = `${host}:${this.webhookPort}`;
			}
		}

		return `${host}/wuzapi/webhook`;
	}

	async createInstance() {
		this.logger.info(`[createInstance] Creating instance ${this.instanceName}`);
		const payload = {
			webhookUrl: this._getWebhookUrl()
		};
		return await this.apiClient.createInstance(this.instanceName, payload);
	}

	async recreateInstance() {
		const results = [];
		this.logger.info(`[recreateInstance] Starting recreation for ${this.instanceName}`);

		try {
			const deleteResult = await this.deleteInstance();
			results.push({ action: "delete", status: "success", result: deleteResult });
		} catch (error) {
			this.logger.error("[recreateInstance] Failed to delete:", error);
			results.push({ action: "delete", status: "error", error: error.message });
		}

		await sleep(5000);

		for (let i = 0; i < 3; i++) {
			try {
				this.logger.info(`[recreateInstance] Attempt ${i + 1}/3...`);
				const createResult = await this.createInstance();
				results.push({ action: "create", status: "success", result: createResult });
				return results;
			} catch (error) {
				this.logger.error(`[recreateInstance] Attempt ${i + 1} failed:`, error);
				results.push({ action: "create", status: "error", attempt: i + 1, error: error.message });
				if (i < 2) await sleep(5000);
			}
		}

		this.logger.error("[recreateInstance] Failed after 3 attempts.");
		return results;
	}

	async updateVersions() {
		this.version = "Wuzapi";
	}

	// ──────────────────────────────────────────────────────────
	// Normalização
	// ──────────────────────────────────────────────────────────

	_normalizeRecipientJid(jid) {
		if (typeof jid !== "string" || !jid) return jid;
		if (jid.endsWith("@g.us")) return jid;
		const [userPart, domainPart] = jid.split("@");
		if (!domainPart) return jid;
		const cleanUser = userPart.split(":")[0];
		return `${cleanUser}@${domainPart}`;
	}

	_normalizeId(id, logger) {
		if (typeof id !== "string" || !id) return "";
		const cleanId = id.split("@")[0].split(":")[0];
		if (cleanId && !/^\d+$/.test(cleanId)) {
			if (logger && typeof logger.error === "function") {
				logger.error(`[isAdmin] ID inválido: "${id}" resultou in "${cleanId}"`);
			}
		}
		return cleanId;
	}

	async isUserAdminInGroup(userId, groupId) {
		return this.adminUtils.isAdmin(userId, { id: groupId }, null, this);
	}

	// ──────────────────────────────────────────────────────────
	// Envio de mensagens (interface compatível)
	// ──────────────────────────────────────────────────────────

	async sendText(chatId, text, options = {}) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		const result = await this.apiClient.sendText(this.instanceName, cleanChatId, text, options);
		return result;
	}

	async sendImage(chatId, media, options = {}) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		const result = await this.apiClient.sendImage(this.instanceName, cleanChatId, media, options);
		return result;
	}

	async sendVideo(chatId, media, options = {}) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		return this.apiClient.sendVideo(this.instanceName, cleanChatId, media, options);
	}

	async sendAudio(chatId, media, options = {}) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		return this.apiClient.sendAudio(this.instanceName, cleanChatId, media, options);
	}

	async sendDocument(chatId, media, options = {}) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		return this.apiClient.sendDocument(this.instanceName, cleanChatId, media, options);
	}

	async sendSticker(chatId, media, options = {}) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		return this.apiClient.sendSticker(this.instanceName, cleanChatId, media, options);
	}

	async sendLocation(chatId, location, options = {}) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		return this.apiClient.sendLocation(this.instanceName, cleanChatId, location, options);
	}

	async sendReaction(chatId, messageId, emoji) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		return this.apiClient.sendReaction(this.instanceName, cleanChatId, messageId, emoji);
	}

	async deleteMessage(chatId, messageId, options = {}) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		return this.apiClient.deleteMessage(this.instanceName, cleanChatId, messageId, options);
	}

	async editMessage(chatId, messageId, newText) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		return this.apiClient.editMessage(this.instanceName, cleanChatId, messageId, newText);
	}

	async replyMessage(chatId, messageId, text) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		return this.apiClient.replyMessage(this.instanceName, cleanChatId, messageId, text);
	}

	async forwardMessage(chatId, messageId, originalChatId) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		const cleanOriginalChatId = this._normalizeRecipientJid(originalChatId);
		return this.apiClient.forwardMessage(this.instanceName, cleanChatId, messageId, cleanOriginalChatId);
	}

	async markMessageRead(chatId, messageId) {
		const cleanChatId = this._normalizeRecipientJid(chatId);
		return this.apiClient.markMessageRead(this.instanceName, cleanChatId, messageId);
	}

	// ──────────────────────────────────────────────────────────
	// Download de mídia
	// ──────────────────────────────────────────────────────────

	async _downloadMediaFromWuzapi(messageContent) {
		try {
			const response = await this.apiClient.downloadMedia(this.instanceName, messageContent);

			if (response?.base64) {
				const base64Data = response.base64.replace(/^data:.*?;base64,/, "");

				const mimetype = [
					messageContent,
					messageContent.imageMessage,
					messageContent.videoMessage,
					messageContent.audioMessage,
					messageContent.stickerMessage
				]
					.find((msg) => msg?.mimetype)
					?.mimetype?.split(";")[0];

				const extension = mime.extension(mimetype) ?? "bin";
				const tempId = randomBytes(8).toString("hex");
				const fileName = `${tempId}.${extension}`;
				const outputDir = path.join(__dirname, "..", "public", "attachments");
				if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
				const filePath = path.join(outputDir, fileName);

				await writeFileAsync(filePath, base64Data, "base64");

				setTimeout(
					(fp) => {
						if (fs.existsSync(fp)) fs.unlinkSync(fp);
					},
					10 * 60 * 1000,
					filePath
				);

				const fileUrl = `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/attachments/${fileName}`;
				return { url: fileUrl, mimetype, filePath };
			}

			throw new Error("Nenhuma mídia encontrada na resposta.");
		} catch (error) {
			this.logger.error("[_downloadMediaFromWuzapi] Erro:", error);
			throw error;
		}
	}

	// ──────────────────────────────────────────────────────────
	// Perfil
	// ──────────────────────────────────────────────────────────

	async updateProfileStatus(status) {
		return this.apiClient.updateProfileStatus(this.instanceName, status);
	}

	async updateProfilePicture(media) {
		return this.apiClient.updateProfilePicture(this.instanceName, media);
	}

	async updateProfileName(displayName) {
		return this.apiClient.updateProfileName(this.instanceName, displayName);
	}

	async getProfileInfo() {
		return this.apiClient.getProfileInfo(this.instanceName);
	}

	// ──────────────────────────────────────────────────────────
	// Grupos
	// ──────────────────────────────────────────────────────────

	async listGroups() {
		const res = await this.apiClient.listGroups(this.instanceName);
		return res?.data?.Groups || res?.Groups || [];
	}

	async getGroupInfo(groupId) {
		return this.apiClient.getGroupInfo(this.instanceName, groupId);
	}

	async leaveGroup(groupId) {
		return this.apiClient.leaveGroup(this.instanceName, groupId);
	}

	async acceptInviteCode(inviteCode) {
		return this.apiClient.joinGroup(this.instanceName, inviteCode);
	}

	async inviteInfo(inviteCode) {
		return this.apiClient.getInviteInfo(this.instanceName, inviteCode);
	}

	async addGroupParticipants(groupId, participants) {
		return this.apiClient.addGroupParticipants(this.instanceName, groupId, participants);
	}

	async removeGroupParticipants(groupId, participants) {
		return this.apiClient.removeGroupParticipants(this.instanceName, groupId, participants);
	}

	async promoteParticipants(groupId, participants) {
		return this.apiClient.promoteParticipants(this.instanceName, groupId, participants);
	}

	async demoteParticipants(groupId, participants) {
		return this.apiClient.demoteParticipants(this.instanceName, groupId, participants);
	}

	// ──────────────────────────────────────────────────────────
	// Contatos
	// ──────────────────────────────────────────────────────────

	async getContactDetails(chatId) {
		return this.apiClient.getContactInfo(this.instanceName, chatId);
	}

	async getChatDetails(chatId) {
		if (!chatId) return null;

		if (this.skipGroupInfo && this.skipGroupInfo.includes(chatId)) {
			this.logger.info(
				`[getChatDetails] Skipping fetch for ${chatId} as it is in skipGroupInfo list.`
			);
			return {
				id: { _serialized: chatId },
				name: chatId,
				isGroup: true,
				notInGroup: true,
				participants: []
			};
		}

		try {
			if (chatId.includes("@g.us")) {
				const response = await this.apiClient.getGroupInfo(this.instanceName, chatId);
				const groupInfo = response?.data || response;

				if (groupInfo) {
					const participantsList = groupInfo.participants || groupInfo.Participants || [];
					participantsList.forEach((p) => {
						const jid = p.jid || p.JID;
						const lid = p.lid || p.LID;
						if (lid && jid) {
							this.cacheManager.putContactInCache({ id: { _serialized: jid }, lid });
						}
					});

					return {
						id: { _serialized: groupInfo.id || groupInfo.JID || chatId },
						name: groupInfo.name || groupInfo.subject || groupInfo.Name || chatId,
						isGroup: true,
						isCommunity: !!(groupInfo.isCommunity || groupInfo.IsParent),
						isAnnounce: !!(groupInfo.isAnnounce || groupInfo.IsAnnounce),
						linkedParentJid: groupInfo.linkedParentJid || groupInfo.LinkedParentJID,
						notInGroup: false,
						groupMetadata: { desc: groupInfo.desc || groupInfo.topic || groupInfo.Topic || "" },
						participants: participantsList.map((p) => {
							const jid = p.jid || p.JID || "";
							return {
								id: { _serialized: jid },
								isAdmin: !!(p.admin || p.isAdmin || p.IsAdmin),
								isSuperAdmin: !!(p.superAdmin || p.isSuperAdmin || p.IsSuperAdmin),
								phoneNumber: jid.split("@")[0],
								lid: p.lid || p.LID
							};
						}),
						_raw: groupInfo
					};
				}
			} else {
				const response = await this.apiClient.getContactInfo(this.instanceName, chatId);
				const contactInfo = response?.data || response;

				if (contactInfo) {
					const name =
						contactInfo.FullName ||
						contactInfo.PushName ||
						contactInfo.FirstName ||
						chatId.split("@")[0];
					return {
						id: { _serialized: contactInfo.JID || contactInfo.jid || chatId },
						name,
						isGroup: false,
						notInGroup: false,
						participants: [],
						_raw: contactInfo
					};
				}
			}
		} catch (e) {
			this.logger.error(`[getChatDetails] Error fetching ${chatId}`, e);
		}

		return {
			id: { _serialized: chatId },
			name: chatId.split("@")[0],
			isGroup: chatId.includes("@g.us"),
			notInGroup: true,
			participants: []
		};
	}

	// ──────────────────────────────────────────────────────────
	// Presença
	// ──────────────────────────────────────────────────────────

	async setPresence(chatId, presence) {
		return this.apiClient.setPresence(this.instanceName, chatId, presence);
	}

	// ──────────────────────────────────────────────────────────
	// Conversões de mídia (reutilizadas do WhatsAppBotGo)
	// ──────────────────────────────────────────────────────────

	async convertToSquareWebPImage(base64ImageContent) {
		let inputPath = "";
		let isTempInputFile = false;
		const tempId = randomBytes(16).toString("hex");
		const tempDirectory = os.tmpdir();
		const tempInputPath = path.join(tempDirectory, `${tempId}_input.tmp`);
		const tempOutputPath = path.join(tempDirectory, `${tempId}_output.webp`);

		try {
			if (!base64ImageContent || typeof base64ImageContent !== "string") {
				throw new Error("Invalid base64ImageContent.");
			}
			const base64Data = base64ImageContent.includes(",")
				? base64ImageContent.split(",")[1]
				: base64ImageContent;
			const buffer = Buffer.from(base64Data, "base64");
			await writeFileAsync(tempInputPath, buffer);
			inputPath = tempInputPath;
			isTempInputFile = true;

			const targetSize = 512;
			const videoFilter = `scale=${targetSize}:${targetSize}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${targetSize}:${targetSize}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`;

			await new Promise((resolve, reject) => {
				ffmpeg(inputPath)
					.outputOptions([
						"-vf",
						videoFilter,
						"-c:v",
						"libwebp",
						"-lossless",
						"0",
						"-q:v",
						"80",
						"-compression_level",
						"6"
					])
					.toFormat("webp")
					.on("end", resolve)
					.on("error", reject)
					.save(tempOutputPath);
			});

			const webpBuffer = await readFileAsync(tempOutputPath);
			return webpBuffer.toString("base64");
		} catch (error) {
			this.logger.error("[toSquareWebPImage] Error:", error.message);
			throw error;
		} finally {
			if (isTempInputFile && fs.existsSync(tempInputPath))
				await unlinkAsync(tempInputPath).catch(() => {});
			if (fs.existsSync(tempOutputPath)) await unlinkAsync(tempOutputPath).catch(() => {});
		}
	}

	async convertToSquarePNGImage(base64ImageContent) {
		try {
			if (!base64ImageContent || typeof base64ImageContent !== "string") {
				throw new Error("Invalid base64ImageContent.");
			}
			const base64Data = base64ImageContent.includes(",")
				? base64ImageContent.split(",")[1]
				: base64ImageContent;
			const imageBuffer = Buffer.from(base64Data, "base64");
			const targetSize = 800;

			const resizedImageBuffer = await sharp(imageBuffer)
				.resize({
					width: targetSize,
					height: targetSize,
					fit: sharp.fit.inside,
					withoutEnlargement: false,
					kernel: sharp.kernel.lanczos3
				})
				.toBuffer();

			const finalImageBuffer = await sharp({
				create: {
					width: targetSize,
					height: targetSize,
					channels: 4,
					background: { r: 0, g: 0, b: 0, alpha: 0 }
				}
			})
				.composite([
					{
						input: resizedImageBuffer,
						gravity: sharp.gravity.center
					}
				])
				.png({ compressionLevel: 6, adaptiveFiltering: true })
				.toBuffer();

			return finalImageBuffer.toString("base64");
		} catch (error) {
			this.logger.error("[convertToSquarePNGImage] Error:", error.message);
			throw error;
		}
	}

	async convertAnimatedWebpToGif(base64Webp, keepFile = false) {
		const tempId = randomBytes(8).toString("hex");
		const tempDir = os.tmpdir();
		const inputPath = path.join(tempDir, `${tempId}.webp`);
		const outputFileName = `${tempId}.gif`;
		const outputDir = path.join(__dirname, "..", "public", "gifs");
		if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
		const outputPath = path.join(outputDir, outputFileName);

		const buffer = Buffer.from(base64Webp.split(",").pop(), "base64");
		await writeFileAsync(inputPath, buffer);

		try {
			await convertAsync([
				inputPath,
				"-coalesce",
				"-background",
				"none",
				"-alpha",
				"on",
				"-dispose",
				"previous",
				outputPath
			]);
			await unlinkAsync(inputPath).catch(() => {});

			const fileUrl = `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/gifs/${outputFileName}`;

			if (!keepFile) {
				setTimeout(() => {
					fs.unlink(outputPath, () => {});
				}, 60000);
			}

			return fileUrl;
		} catch (err) {
			await unlinkAsync(inputPath).catch(() => {});
			throw err;
		}
	}

	async convertToSquareAnimatedGif(inputContent, keepFile = false) {
		let inputPath = inputContent;
		let isTempInputFile = false;
		const tempId = randomBytes(16).toString("hex");
		const tempInputPath = path.join(os.tmpdir(), `${tempId}_input.tmp`);
		const outputDir = path.join(__dirname, "..", "public", "gifs");
		if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
		const outputFileName = `${tempId}.gif`;
		const outputPath = path.join(outputDir, outputFileName);

		try {
			if (
				inputContent &&
				!inputContent.startsWith("http://") &&
				!inputContent.startsWith("https://")
			) {
				const base64Data = inputContent.includes(",") ? inputContent.split(",")[1] : inputContent;
				const buffer = Buffer.from(base64Data, "base64");
				await writeFileAsync(tempInputPath, buffer);
				inputPath = tempInputPath;
				isTempInputFile = true;
			}

			const targetSize = 512;
			const fps = 15;
			const videoFilter =
				`fps=${fps},` +
				`scale=${targetSize}:${targetSize}:force_original_aspect_ratio=decrease:flags=lanczos,` +
				`pad=${targetSize}:${targetSize}:(ow-iw)/2:(oh-ih)/2:color=black@0.0,` +
				`split[s0][s1];[s0]palettegen=stats_mode=diff:max_colors=250:reserve_transparent=on[p];[s1][p]paletteuse=dither=bayer:alpha_threshold=128`;

			await new Promise((resolve, reject) => {
				ffmpeg(inputPath)
					.outputOptions(["-vf", videoFilter, "-loop", "0"])
					.toFormat("gif")
					.on("end", resolve)
					.on("error", reject)
					.save(outputPath);
			});

			const fileUrl = `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/gifs/${outputFileName}`;

			if (!keepFile) {
				setTimeout(() => {
					fs.unlink(outputPath, () => {});
				}, 60000);
			}

			return fileUrl;
		} catch (error) {
			this.logger.error("[convertToSquareAnimatedGif] Error:", error.message);
			throw error;
		} finally {
			if (isTempInputFile && fs.existsSync(tempInputPath)) {
				await unlinkAsync(tempInputPath).catch(() => {});
			}
		}
	}

	async convertToAnimatedWebP(inputContent) {
		let inputPath = inputContent;
		let isTempInputFile = false;
		const tempId = randomBytes(16).toString("hex");
		const tempInputPath = path.join(os.tmpdir(), `${tempId}_input.tmp`);
		const tempOutputPath = path.join(os.tmpdir(), `${tempId}_output.webp`);

		try {
			if (
				inputContent &&
				!inputContent.startsWith("http://") &&
				!inputContent.startsWith("https://")
			) {
				const base64Data = inputContent.includes(",") ? inputContent.split(",")[1] : inputContent;
				const buffer = Buffer.from(base64Data, "base64");
				await writeFileAsync(tempInputPath, buffer);
				inputPath = tempInputPath;
				isTempInputFile = true;
			}

			const targetSize = 512;
			const videoFilter = `fps=20,scale=${targetSize}:${targetSize}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${targetSize}:${targetSize}:(ow-iw)/2:(oh-ih)/2:color=black@0.0,split[s0][s1];[s0]palettegen=max_colors=250:reserve_transparent=on[p];[s1][p]paletteuse=dither=bayer:alpha_threshold=128`;

			await new Promise((resolve, reject) => {
				ffmpeg(inputPath)
					.outputOptions([
						"-vf",
						videoFilter,
						"-loop",
						"0",
						"-c:v",
						"libwebp",
						"-lossless",
						"0",
						"-q:v",
						"75",
						"-compression_level",
						"6",
						"-preset",
						"default",
						"-an",
						"-vsync",
						"cfr"
					])
					.toFormat("webp")
					.on("end", resolve)
					.on("error", reject)
					.save(tempOutputPath);
			});

			const webpBuffer = await readFileAsync(tempOutputPath);
			return webpBuffer.toString("base64");
		} catch (error) {
			this.logger.error("[convertToAnimatedWebP] Error:", error.message);
			throw error;
		} finally {
			if (isTempInputFile && fs.existsSync(tempInputPath))
				await unlinkAsync(tempInputPath).catch(() => {});
			if (fs.existsSync(tempOutputPath)) await unlinkAsync(tempOutputPath).catch(() => {});
		}
	}

	async toGif(inputContent) {
		let inputPath = inputContent;
		let isTempFile = false;
		const tempDirectory = os.tmpdir();
		const tempId = randomBytes(16).toString("hex");
		const tempInputPath = path.join(tempDirectory, `${tempId}_input.mp4`);
		const tempOutputPath = path.join(tempDirectory, `${tempId}_output.gif`);

		try {
			if (!inputContent.startsWith("http://") && !inputContent.startsWith("https://")) {
				const base64Data = inputContent.includes(",") ? inputContent.split(",")[1] : inputContent;
				const buffer = Buffer.from(base64Data, "base64");
				await writeFileAsync(tempInputPath, buffer);
				inputPath = tempInputPath;
				isTempFile = true;
			}

			await new Promise((resolve, reject) => {
				ffmpeg(inputPath)
					.outputOptions(["-vf", "fps=20,scale=512:-1:flags=lanczos", "-loop", "0"])
					.toFormat("gif")
					.on("end", resolve)
					.on("error", reject)
					.save(tempOutputPath);
			});

			const gifBuffer = await readFileAsync(tempOutputPath);
			return gifBuffer.toString("base64");
		} catch (error) {
			this.logger.error("[toGif] Error:", error);
			throw error;
		} finally {
			if (isTempFile && fs.existsSync(tempInputPath))
				await unlinkAsync(tempInputPath).catch(() => {});
			if (fs.existsSync(tempOutputPath)) await unlinkAsync(tempOutputPath).catch(() => {});
		}
	}

	async getFileSizeByURL(url) {
		try {
			const headResponse = await axios.head(url);
			const contentLength = headResponse.headers["content-length"];
			return contentLength ? parseInt(contentLength, 10) : 0;
		} catch (error) {
			this.logger.warn(`[getFileSizeByURL] Could not get file size for ${url}: ${error.message}`);
			return 0;
		}
	}

	// ──────────────────────────────────────────────────────────
	// Cache de mensagens
	// ──────────────────────────────────────────────────────────

	async recoverMsgFromCache(messageId) {
		if (!messageId) return null;

		// Tenta no cache local primeiro
		const cached = this.messageCache.find((m) => m.key === messageId);
		if (cached) return cached.value;

		// Tenta no CacheManager (Redis/SQLite)
		try {
			const result = await this.cacheManager.getGoMessageFromCache(messageId);
			if (result) return result;
		} catch (e) {
			this.logger.debug("[recoverMsgFromCache] CacheManager error:", e.message);
		}

		return null;
	}

	async cacheMessage(messageId, messageData, ttl = 300) {
		if (!messageId || !messageData) return;

		// Cache local (limitado)
		if (this.messageCache.length < this.maxCacheSize) {
			this.messageCache.push({ key: messageId, value: messageData });
		}

		// Persiste no CacheManager (Redis/SQLite)
		try {
			const cacheObj = { ...messageData, id: messageId };
			await this.cacheManager.putGoMessageInCache(cacheObj);
		} catch (e) {
			this.logger.debug("[cacheMessage] CacheManager error:", e.message);
		}
	}

	// ──────────────────────────────────────────────────────────
	// Helpers e utilitários de mídia/LID
	// ──────────────────────────────────────────────────────────

	_storeMediaFile(source, extension) {
		const outputDir = path.join(__dirname, "..", "public", "attachments");
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
		}

		const tempId = randomBytes(8).toString("hex");
		const outputFileName = `${tempId}${extension}`;
		const outputFilePath = path.join(outputDir, outputFileName);

		if (Buffer.isBuffer(source)) {
			fs.writeFileSync(outputFilePath, source);
		} else if (typeof source === "string" && fs.existsSync(source)) {
			fs.copyFileSync(source, outputFilePath);
		} else {
			throw new Error("Invalid source for _storeMediaFile");
		}

		setTimeout(
			(ofp) => {
				if (fs.existsSync(ofp)) fs.unlinkSync(ofp);
			},
			10 * 60 * 1000,
			outputFilePath
		);

		return `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/attachments/${outputFileName}`;
	}

	validURL(str) {
		const pattern = new RegExp(
			"^(https?:\\/\\/)?" + // protocol
				"((([a-z\\d]([a-z\\d-]*[a-z\\d])?)\\.)+[a-z]{2,}|" + // domain name
				"((\\d{1,3}\\.){3}\\d{1,3}))" + // OR ip (v4) address
				"(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*" + // port and path
				"(\\?[;&a-z\\d%_.~+=-]*)?" + // query string
				"(\\#[-a-z\\d_]*)?$",
			"i"
		);
		return !!pattern.test(str);
	}

	getLidFromPn(PN, chat) {
		const participants = chat?.Participants || chat?.participants || [];
		const found = participants.find((p) => {
			const number = p.PhoneNumber || p.phoneNumber || p.id?._serialized || "";
			return number.startsWith(PN);
		});
		return found ? found.LID || found.lid || found.phoneNumber : PN;
	}

	getPnFromLid(lid, chat) {
		const participants = chat?.Participants || chat?.participants || [];
		const found = participants.find(
			(p) =>
				p.LID?.startsWith(lid) ||
				p.lid?.startsWith(lid) ||
				p.JID?.startsWith(lid) ||
				p.jid?.startsWith(lid) ||
				p.id?._serialized?.startsWith(lid)
		);
		return found ? found.PhoneNumber || found.phoneNumber : lid;
	}

	async createMediaFromBase64(base64Data, mimetype, filename) {
		try {
			const extension = mime.extension(mimetype) ?? "bin";
			const buffer = Buffer.from(base64Data, "base64");
			const size = buffer.length;
			const url = this._storeMediaFile(buffer, `.${extension}`);

			if (mimetype === "application/mp4") {
				mimetype = "video/mp4";
			}

			const media = {
				mimetype,
				data: base64Data,
				filename: filename ?? `file.${extension}`,
				source: "base64",
				url,
				isMessageMedia: true,
				size
			};
			return media;
		} catch (error) {
			this.logger.error(`Error in createMediaFromBase64:`, error);
			throw error;
		}
	}

	async createMedia(filePath, customMime = false) {
		try {
			if (!fs.existsSync(filePath)) {
				throw new Error(`File not found: ${filePath}`);
			}

			const stats = fs.statSync(filePath);
			const size = stats.size;
			const extension = path.extname(filePath);
			const fileUrl = this._storeMediaFile(filePath, extension);

			let data = null;
			const sizeLimit = 200 * 1024 * 1024; // 200MB
			if (size < sizeLimit) {
				data = fs.readFileSync(filePath, { encoding: "base64" });
			}

			const filename = path.basename(filePath);
			let mimetype = customMime
				? customMime
				: (mime.lookup(filePath) ?? "application/octet-stream");

			if (mimetype === "application/mp4") {
				mimetype = "video/mp4";
			}

			const media = {
				mimetype,
				data,
				filename,
				source: "file",
				url: fileUrl,
				isMessageMedia: true,
				size
			};
			return media;
		} catch (error) {
			this.logger.error(`Error creating media from ${filePath}:`, error);
			throw error;
		}
	}

	async createMediaFromURL(url, options = { unsafeMime: true, customMime: false }) {
		try {
			const filename = path.basename(new URL(url).pathname) ?? "media_from_url";
			let mimetype =
				mime.lookup(url.split("?")[0]) ?? (options.unsafeMime ? "application/octet-stream" : null);
			const size = await this.getFileSizeByURL(url);

			if (!mimetype && options.unsafeMime) {
				try {
					const headResponse = await axios.head(url);
					mimetype = options.customMime
						? options.customMime
						: (headResponse.headers["content-type"]?.split(";")[0] ?? "application/octet-stream");
				} catch (e) {
					/* ignore */
				}
			}

			if (mimetype === "application/mp4") {
				mimetype = "video/mp4";
			}

			const media = { url, mimetype, filename, source: "url", isMessageMedia: true, size };
			return media;
		} catch (error) {
			this.logger.error(`Error creating media from URL ${url}:`, error);
			throw error;
		}
	}

	// ──────────────────────────────────────────────────────────
	// Conexão e ciclo de vida
	// ──────────────────────────────────────────────────────────

	async _checkInstanceStatusAndConnect(isRetry = false, forceConnect = false) {
		try {
			let response;
			try {
				response = await this.getConnectionStatus();
			} catch (e) {
				this.logger.error(
					`[_checkInstanceStatusAndConnect] Erro buscando status de ${this.instanceName}`,
					e
				);
				response = { data: { connected: false } };
			}

			const statusData = response?.data;
			this.isConnected = !!(
				statusData?.loggedIn ||
				statusData?.LoggedIn ||
				(statusData?.connected && statusData?.loggedIn !== false)
			);
			const extra = {};

			const instanceDetails = {
				version: "Wuzapi",
				tipo: "wuzapi"
			};

			if (this.isConnected) {
				await this._onInstanceConnected();
				extra.ok = true;
			} else {
				if (forceConnect) {
					this.logger.info(
						`Instance ${this.instanceName} is not connected. Attempting to connect...`
					);
					try {
						await this.connect();
					} catch (connectError) {
						const errStr = typeof connectError === 'string'
							? connectError
							: (connectError?.error || connectError?.message || JSON.stringify(connectError) || "");
						if (errStr.includes("already connected")) {
							this.logger.info(
								`Instance ${this.instanceName} is already connected (websocket active). Proceeding to fetch QR.`
							);
						} else {
							throw connectError;
						}
					}

					extra.connectData = {};

					let qrData = null;
					for (let attempt = 1; attempt <= 5; attempt++) {
						try {
							const qrResponse = await this.getQrCode();
							qrData = qrResponse?.data;
							if (qrData?.qr) {
								break;
							}
						} catch (qrErr) {
							if (attempt === 5) {
								this.logger.error(
									`[_checkInstanceStatusAndConnect] Error getting QR code for ${this.instanceName}`,
									qrErr
								);
							}
						}
						this.logger.info(`[_checkInstanceStatusAndConnect] QR Code not ready yet, waiting 1s (attempt ${attempt}/5)...`);
						await sleep(1000);
					}

					if (qrData?.qr) {
						extra.connectData.code = qrData.qr;
						extra.connectData.qrcode = qrData.qr;

						const qrBase64 = qrData.qr;
						if (qrBase64 && qrBase64.startsWith("data:image/")) {
							this.logger.info(`[${this.id}] QR Code received.`);
							const qrCodeLocal = path.join(
								this.database.databasePath,
								"qrcodes",
								`qrcode_${this.id}.png`
							);
							const qrDir = path.dirname(qrCodeLocal);
							if (!fs.existsSync(qrDir)) {
								fs.mkdirSync(qrDir, { recursive: true });
							}
							const base64Data = qrBase64.replace(/^data:image\/[a-z]+;base64,/, "");
							fs.writeFileSync(qrCodeLocal, base64Data, "base64");
						}
					}

					this.logger.info(`[_checkInstanceStatusAndConnect] Checking pairing code. phoneNumber: ${this.phoneNumber}`);
					if (this.phoneNumber) {
						try {
							const pairResponse = await this.apiClient.pairPhone(this.phoneNumber);
							const pairData = pairResponse?.data;
							const pairCode = pairData?.LinkingCode || pairData?.linkingCode || pairData?.pairingCode;
							if (pairCode) {
								extra.connectData.pairingCode = pairCode;
								this.logger.info(`[${this.id}] PAIRING CODE: ${pairCode}`);
							} else {
								this.logger.warn(`[_checkInstanceStatusAndConnect] No pairingCode/LinkingCode returned in response:`, pairData);
							}
						} catch (pairErr) {
							this.logger.error(
								`[_checkInstanceStatusAndConnect] Error getting pairing code for ${this.instanceName}`,
								pairErr
							);
						}
					}
				}
			}
			return { instanceDetails, extra };
		} catch (error) {
			this.logger.error(`Error checking/connecting instance ${this.instanceName}:`, error);
			return { instanceDetails: {}, error };
		}
	}

	async _onInstanceConnected() {
		if (this.isConnected) {
			return;
		}
		this.logger.info(`Instance ${this.instanceName} connected!`);
		this.isConnected = true;
	}

	_onInstanceDisconnected(reason = "Unknown") {
		this.logger.warn(`Instance ${this.instanceName} disconnected. Reason: ${reason}`);
		this.isConnected = false;
	}

	// ──────────────────────────────────────────────────────────
	// Webhook e Eventos
	// ──────────────────────────────────────────────────────────

	async handleWuzapiEvent(payload) {
		this.isConnected = true;

		if (!payload?.type) {
			this.logger.warn(`[handleWuzapiEvent] Evento sem type recebido`, { payload });
			return;
		}

		if (this.shouldDiscardMessage() && payload.type === "Message") {
			return;
		}

		try {
			switch (payload.type) {
				case "Connected":
					await this._onInstanceConnected();
					break;

				case "Disconnected":
					this._onInstanceDisconnected(payload.reason || "Disconnected event");
					break;

				case "Message": {
					this.lastMessageReceived = Date.now();
					const msgData = payload.event;

					if (msgData) {
						const info = msgData.Info;
						const msg = msgData.Message;
						const reactionData = msg?.reactionMessage;

						if (info?.PushName && info.PushName.length > 0) {
							if (info.Sender) {
								this.cacheManager.putPushnameInCache({ id: info.Sender, pushName: info.PushName });
							}
						}

						const chatToFilter = info?.Chat;
						if (
							chatToFilter === this.grupoLogs ||
							chatToFilter === this.grupoAnuncios ||
							chatToFilter === this.grupoInvites ||
							chatToFilter === this.grupoEstabilidade
						) {
							break;
						}

						if (reactionData) {
							if (reactionData.text !== "" && !info?.IsFromMe) {
								this.reactionHandler.processReaction(this, {
									reaction: reactionData.text,
									senderId: info.Sender,
									userName: info.PushName,
									msgId: { _serialized: reactionData.key.ID }
								});

								if (this.eventHandler && typeof this.eventHandler.onReaction === "function") {
									this.eventHandler.onReaction(this, {
										reaction: reactionData.text,
										senderId: info.Sender,
										userName: info.PushName,
										chatId: info.Chat,
										msgId: { _serialized: reactionData.key.ID }
									});
								}
							}
						} else {
							const formattedMessage = await this.formatMessage(msgData);
							if (
								formattedMessage &&
								this.eventHandler &&
								typeof this.eventHandler.onMessage === "function"
							) {
								if (!formattedMessage.fromMe) {
									this.eventHandler.onMessage(this, formattedMessage);
								}
							}
						}
					}
					break;
				}

				case "GroupInfo": {
					const groupInfoData = payload.event;
					if (groupInfoData) {
						if (
							groupInfoData.Join ||
							groupInfoData.Leave ||
							groupInfoData.Promote ||
							groupInfoData.Demote
						) {
							await this._handleGroupParticipantsUpdate(groupInfoData);
						}
					}
					break;
				}

				case "JoinedGroup": {
					const joinedData = payload.event;
					if (joinedData) {
						await this._handleGroupParticipantsUpdate({
							JID: joinedData.JID,
							Join: [this.phoneNumber],
							Sender: joinedData.Sender ?? joinedData.OwnerJID,
							SenderPN: joinedData.SenderPN ?? joinedData.OwnerPN,
							isBotJoining: true,
							isCommunity: joinedData.IsParent,
							isAnnounce: joinedData.IsAnnounce
						});
					}
					break;
				}

				default:
					break;
			}
		} catch (error) {
			this.logger.error(`[handleWuzapiEvent] Erro ao processar evento:`, error);
		}
	}

	async _handleGroupParticipantsUpdate(groupData) {
		const groupId = groupData.JID;

		const processAction = async (groupData, participants, action) => {
			if (!participants || !participants.length) return;

			const groupDetails = await this.getChatDetails(groupId);
			const groupName = groupDetails?.name ?? groupId;

			for (const participant of participants) {
				const contact = await this.getContactDetails(participant);
				const contactResp =
					(await this.getContactDetails(groupData.Sender)) ??
					(await this.getContactDetails(groupData.SenderPN));

				const eventData = {
					group: {
						id: groupId,
						name: groupName,
						notInGroup: groupDetails?.notInGroup,
						isBotJoining: groupData.isBotJoining ?? groupDetails?.isBotJoining,
						isCommunity: groupData.isCommunity ?? groupData.IsParent ?? groupDetails?.isCommunity,
						isAnnounce: groupData.isAnnounce ?? groupData.IsAnnounce ?? groupDetails?.isAnnounce
					},
					isCommunity: groupData.isCommunity ?? groupData.IsParent ?? groupDetails?.isCommunity,
					isAnnounce: groupData.isAnnounce ?? groupData.IsAnnounce ?? groupDetails?.isAnnounce,
					isBotJoining: groupData.isBotJoining ?? groupDetails?.isBotJoining,
					user: { id: participant, name: contact?.name ?? participant.split("@")[0] },
					responsavel: {
						id: groupData.SenderPN,
						name: contactResp?.name ?? groupData.SenderPN?.split("@")[0]
					},
					action,
					origin: { getChat: async () => await this.getChatDetails(groupId) }
				};

				if (action === "add" || action === "join") {
					if (this.eventHandler?.onGroupJoin) this.eventHandler.onGroupJoin(this, eventData);
				} else if (action === "remove" || action === "leave") {
					if (this.eventHandler?.onGroupLeave) this.eventHandler.onGroupLeave(this, eventData);
				} else if (action === "promote") {
					if (this.eventHandler?.onGroupPromote) this.eventHandler.onGroupPromote(this, eventData);
				} else if (action === "demote") {
					if (this.eventHandler?.onGroupDemote) this.eventHandler.onGroupDemote(this, eventData);
				}
			}
		};

		await processAction(groupData, groupData.Join, "add");
		await processAction(groupData, groupData.Leave, "remove");
		await processAction(groupData, groupData.Promote, "promote");
		await processAction(groupData, groupData.Demote, "demote");
	}

	async formatMessage(wuzapiMessageData, skipCache = false) {
		try {
			if (!wuzapiMessageData) {
				return null;
			}

			// Se a mensagem já estiver formatada, retorna ela mesma diretamente
			if (wuzapiMessageData.origin && wuzapiMessageData.id) {
				return wuzapiMessageData;
			}

			const info = wuzapiMessageData.Info;
			const messageContent = wuzapiMessageData.Message;

			if (!info || !messageContent) {
				return null;
			}

			const chatId = info.Chat;
			const isGroup = info.IsGroup || chatId.includes("broadcast");
			const fromMe = info.IsFromMe;
			const id = info.ID;
			const timestamp = new Date(info.Timestamp).getTime() / 1000;
			let pushName = info.PushName;
			const sender = info.Sender;
			const senderAlt = info.SenderAlt;

			if (!pushName || pushName?.length < 1) {
				pushName = (await this.fetchPushNameFromCache(id)) ?? "Usuario";
			}

			let contextInfo = null;
			if (messageContent.extendedTextMessage)
				contextInfo = messageContent.extendedTextMessage.contextInfo;
			else if (messageContent.imageMessage) contextInfo = messageContent.imageMessage.contextInfo;
			else if (messageContent.videoMessage) contextInfo = messageContent.videoMessage.contextInfo;
			else if (messageContent.audioMessage) contextInfo = messageContent.audioMessage.contextInfo;
			else if (messageContent.stickerMessage)
				contextInfo = messageContent.stickerMessage.contextInfo;

			const mentions = contextInfo?.mentionedJID ?? [];
			const quotedMessageId = contextInfo?.quotedMessage ? contextInfo.stanzaID : null;
			const quotedParticipant = contextInfo?.participant;

			const responseTime = Math.max(0, this.getCurrentTimestamp() - timestamp);

			if (!fromMe) {
				this.loadReport.trackReceivedMessage(isGroup, responseTime, chatId);
			}

			let type = "unknown";
			let content = null;
			let caption = null;
			let mediaInfo = null;

			if (messageContent.conversation) {
				type = "text";
				content = messageContent.conversation;
			} else if (messageContent.extendedTextMessage) {
				type = "text";
				content = messageContent.extendedTextMessage.text;
			} else if (messageContent.imageMessage) {
				type = "image";
				caption = messageContent.imageMessage.caption;
				mediaInfo = {
					mimetype: messageContent.imageMessage.mimetype,
					url: messageContent.imageMessage.url,
					_mediaDetails: messageContent.imageMessage
				};
				content = mediaInfo;
			} else if (messageContent.videoMessage) {
				type = "video";
				caption = messageContent.videoMessage.caption;
				mediaInfo = {
					mimetype: messageContent.videoMessage.mimetype,
					url: messageContent.videoMessage.url,
					seconds: messageContent.videoMessage.seconds,
					_mediaDetails: messageContent.videoMessage
				};
				content = mediaInfo;
			} else if (messageContent.audioMessage) {
				type = "audio";
				mediaInfo = {
					mimetype: messageContent.audioMessage.mimetype,
					url: messageContent.audioMessage.url,
					seconds: messageContent.audioMessage.seconds,
					_mediaDetails: messageContent.audioMessage
				};
				content = mediaInfo;
			} else if (messageContent.stickerMessage) {
				type = "sticker";
				mediaInfo = {
					mimetype: messageContent.stickerMessage.mimetype,
					url: messageContent.stickerMessage.url,
					_mediaDetails: messageContent.stickerMessage
				};
				content = mediaInfo;
			} else if (messageContent.documentMessage) {
				type = "document";
				caption = messageContent.documentMessage.caption;
				mediaInfo = {
					mimetype: messageContent.documentMessage.mimetype,
					url: messageContent.documentMessage.url,
					filename: messageContent.documentMessage.fileName,
					title: messageContent.documentMessage.title,
					_mediaDetails: messageContent.documentMessage
				};
				content = mediaInfo;
			} else if (messageContent.locationMessage) {
				type = "location";
				content = {
					latitude: messageContent.locationMessage.degreesLatitude,
					longitude: messageContent.locationMessage.degreesLongitude,
					name: messageContent.locationMessage.name,
					address: messageContent.locationMessage.address
				};
			} else if (messageContent.contactMessage) {
				type = "contact";
				content = {
					name: messageContent.contactMessage.displayName,
					number: messageContent.contactMessage.vcard
				};
			}

			const formattedMessage = {
				id: { _serialized: id },
				fromMe,
				chatId,
				sender: sender ?? chatId,
				senderAlt: senderAlt ?? sender ?? chatId,
				pushName,
				timestamp,
				type,
				content,
				caption,
				mentionedJids: mentions,
				quotedMessageId,
				quotedParticipant,
				isGroup,
				group: isGroup ? chatId : null,
				author: sender ?? chatId,
				authorAlt: senderAlt ?? sender ?? chatId,
				isMedia: !!mediaInfo,
				mediaInfo,
				origin: {
					react: async (emoji) => await this.sendReaction(chatId, id, emoji),
					reply: async (text) => await this.replyMessage(chatId, id, text),
					reactOk: async () => await this.sendReaction(chatId, id, "✅"),
					reactWait: async () => await this.sendReaction(chatId, id, "⌛️"),
					reactError: async () => await this.sendReaction(chatId, id, "❌"),
					reactSuccess: async () => await this.sendReaction(chatId, id, "🤖"),
					reactCross: async () => await this.sendReaction(chatId, id, "✖️"),
					reactJoin: async () => await this.sendReaction(chatId, id, "🤝"),
					id: {
						_serialized: `${chatId}_${fromMe}_${id}`,
						fromMe,
						remote: chatId,
						id,
						_serialized_v3: id
					},
					key: { remoteJid: chatId, fromMe, id },
					author: this._normalizeId(sender ?? chatId),
					from: chatId,
					body: content,
					timestamp,
					messageTimestamp: timestamp,
					mentionedIds: mentions,
					getContact: async () => await this.getContactDetails(sender ?? chatId),
					getChat: async () => await this.getChatDetails(chatId),
					getQuotedMessage: async () => {
						this.logger.debug(`[getQuotedMessage] ${quotedMessageId}`);
						if (quotedMessageId) {
							return await this.recoverMsgFromCache(quotedMessageId);
						}
						return null;
					},
					delete: async () => await this.deleteMessage(chatId, id),
					wuzapiMessageData
				},
				downloadMedia: async () => {
					try {
						const downloaded = await this._downloadMediaFromWuzapi(messageContent);
						return downloaded;
					} catch (e) {
						this.logger.error(`[downloadMedia] Failed`, e);
						return null;
					}
				}
			};

			if (!skipCache) {
				await this.cacheMessage(id, formattedMessage);
			}

			return formattedMessage;
		} catch (error) {
			this.logger.error(`[formatMessage] Erro formatando mensagem:`, error);
			return null;
		}
	}

	async fetchPushNameFromCache(msgId) {
		return null;
	}

	getCurrentTimestamp() {
		return Math.floor(Date.now() / 1000);
	}

	shouldDiscardMessage() {
		return false;
	}

	// ──────────────────────────────────────────────────────────
	// Envio de Mensagens
	// ──────────────────────────────────────────────────────────

	async sendMessage(chatId, content, options = {}) {
		try {
			let response;
			const isGroup = chatId.includes("@g.us");

			if (typeof content === "string") {
				if (this.validURL(content)) {
					const mimetype = mime.lookup(content.split("?")[0]) ?? "";
					const mediaType = mimetype.split("/")[0] ?? "document";
					const filename = path.basename(new URL(content).pathname) ?? "media";

					if (mediaType === "image") {
						response = await this.sendImage(chatId, { url: content }, options);
					} else if (mediaType === "video") {
						response = await this.sendVideo(chatId, { url: content }, options);
					} else if (mediaType === "audio") {
						response = await this.sendAudio(chatId, { url: content }, options);
					} else {
						response = await this.sendDocument(chatId, { url: content, filename }, options);
					}
				} else {
					response = await this.sendText(chatId, content, options);
				}
			} else if (content && (content.isMessageMedia || options.sendMediaAsSticker)) {
				const mediaData = {
					url: content.url,
					base64: content.data,
					filename: content.filename,
					caption: options.caption
				};

				if (options.sendMediaAsSticker) {
					response = await this.sendSticker(chatId, mediaData, options);
				} else {
					let mediaType = content.mimetype ? content.mimetype.split("/")[0] : "image";
					if (options.sendMediaAsDocument) {
						mediaType = "document";
					}

					if (mediaType === "image") {
						response = await this.sendImage(chatId, mediaData, options);
					} else if (mediaType === "video") {
						response = await this.sendVideo(chatId, mediaData, options);
					} else if (mediaType === "audio") {
						response = await this.sendAudio(chatId, mediaData, options);
					} else {
						response = await this.sendDocument(chatId, mediaData, options);
					}
				}
			} else if (content && content.isLocation) {
				response = await this.sendLocation(chatId, content, options);
			} else if (content && content.isContact) {
				response = await this.sendText(
					chatId,
					`Contato: ${content.name} (${content.number})`,
					options
				);
			} else if (content && content.isPoll) {
				const optionsStr = content.pollOptions.map((o) => `- ${o}`).join("\n");
				response = await this.sendText(
					chatId,
					`📊 Enquete: ${content.name}\nOpções:\n${optionsStr}`,
					options
				);
			} else {
				throw new Error("Formato de conteúdo de mensagem não suportado.");
			}

			this.loadReport.trackSentMessage(isGroup);

			const msgId = response?.data?.id || response?.id || `wuzapi-msg-${Date.now()}`;
			const sentMessageObject = {
				id: { _serialized: msgId },
				fromMe: true,
				chatId,
				sender: "bot",
				senderAlt: "bot",
				pushName: this.name ?? "Bot",
				timestamp: Math.floor(Date.now() / 1000),
				type: typeof content === "string" ? "text" : "media",
				content: typeof content === "string" ? content : (content?.filename || "media"),
				caption: options.caption || null,
				mentionedJids: options.mentions || [],
				isGroup,
				group: isGroup ? chatId : null,
				author: "bot",
				authorAlt: "bot",
				isMedia: content && typeof content !== "string" && content.isMessageMedia,
				origin: {
					react: async (emoji) => await this.sendReaction(chatId, msgId, emoji),
					reply: async (text) => await this.replyMessage(chatId, msgId, text),
					id: {
						_serialized: `${chatId}_true_${msgId}`,
						fromMe: true,
						remote: chatId,
						id: msgId,
						_serialized_v3: msgId
					},
					key: { remoteJid: chatId, fromMe: true, id: msgId },
					body: typeof content === "string" ? content : (content?.filename || "media"),
					timestamp: Math.floor(Date.now() / 1000)
				}
			};
			await this.cacheMessage(msgId, sentMessageObject);

			return {
				id: { _serialized: msgId },
				ack: 1,
				timestamp: Math.floor(Date.now() / 1000),
				_data: response,
				getInfo: () => ({ delivery: [1], played: [1], read: [1] }),
				pin: (tempo) => true
			};
		} catch (error) {
			this.logger.error(`[${this.id}] Error sending message:`, error);
			throw error;
		}
	}

	async sendReturnMessages(returnMessages, group = null) {
		if (!Array.isArray(returnMessages)) {
			returnMessages = [returnMessages];
		}
		const validMessages = returnMessages.filter((msg) => msg && msg.isValid && msg.isValid());
		if (validMessages.length === 0) {
			this.logger.warn(`[${this.id}] Sem ReturnMessages válidas pra enviar.`);
			return [];
		}

		if (group && group.autoTranslateTo) {
			for (const message of validMessages) {
				try {
					if (message.content && typeof message.content === "string") {
						message.content = await llmTranslate(
							message.content,
							group.autoTranslateTo,
							this.llmService
						);
					}
					if (message.caption && typeof message.caption === "string") {
						message.caption = await llmTranslate(
							message.caption,
							group.autoTranslateTo,
							this.llmService
						);
					}
				} catch (e) {
					this.logger.error(`[sendReturnMessages] Translation error`, e);
				}
			}
		}

		const results = [];
		for (const message of validMessages) {
			if (message.delay > 0) {
				await sleep(message.delay);
			}

			const contentToSend = message.content;
			const options = { ...(message.options ?? {}) };

			try {
				const result = await this.sendMessage(message.chatId, contentToSend, options);
				results.push(result);

				if (result && result.id?._serialized) {
					if (message.reaction) {
						try {
							await this.sendReaction(message.chatId, result.id._serialized, message.reaction);
						} catch (reactError) {
							this.logger.error(
								`[${this.id}] Erro enviando reaction "${message.reaction}" pra ${result.id._serialized}:`,
								reactError
							);
						}
					}
				}
			} catch (sendError) {
				this.logger.error(
					`[${this.id}] Falha enviando ReturnMessages pra ${message.chatId}:`,
					sendError
				);
				results.push({
					error: sendError,
					messageContent: message.content,
					getInfo: () => ({ delivery: [], played: [], read: [] })
				});
			}
		}
		return results;
	}

	async updatePrivacySettings(settings) {
		this.logger.info("[updatePrivacySettings] Not yet implemented for wuzapi.", settings);
	}

	// ──────────────────────────────────────────────────────────
	// Conexão e status
	// ──────────────────────────────────────────────────────────

	async getConnectionStatus() {
		return this.apiClient.getConnectionStatus(this.instanceName);
	}

	async getQrCode() {
		return this.apiClient.getQrCode(this.instanceName);
	}

	async connect() {
		return this.apiClient.connectInstance(this.instanceName);
	}

	async disconnect() {
		return this.apiClient.disconnectInstance(this.instanceName);
	}

	async setWebhook(url, secret = "") {
		return this.apiClient.setWebhook(this.instanceName, url, secret);
	}

	async getWebhook() {
		return this.apiClient.getWebhook(this.instanceName);
	}
}

module.exports = WhatsAppBotWuzapi;
