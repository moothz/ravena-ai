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

	async createInstance() {
		this.logger.info(`[createInstance] Creating instance ${this.instanceName}`);
		const payload = {
			webhookUrl: `${this.webhookHost}:${this.webhookPort}/wuzapi/webhook/${this.instanceName}`,
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

	_normalizeId(id, logger) {
		if (typeof id !== "string" || !id) return "";
		const cleanId = id.split("@")[0].split(":")[0];
		if (cleanId && !/^\d+$/.test(cleanId)) {
			if (logger && typeof logger.error === "function") {
				logger.error(`[isAdmin] ID inválido: "${id}" resultou em "${cleanId}"`);
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
		const result = await this.apiClient.sendText(
			this.instanceName,
			chatId,
			text,
			options
		);
		return result;
	}

	async sendImage(chatId, media, options = {}) {
		const result = await this.apiClient.sendImage(
			this.instanceName,
			chatId,
			media,
			options
		);
		return result;
	}

	async sendVideo(chatId, media, options = {}) {
		return this.apiClient.sendVideo(this.instanceName, chatId, media, options);
	}

	async sendAudio(chatId, media, options = {}) {
		return this.apiClient.sendAudio(this.instanceName, chatId, media, options);
	}

	async sendDocument(chatId, media, options = {}) {
		return this.apiClient.sendDocument(this.instanceName, chatId, media, options);
	}

	async sendSticker(chatId, media, options = {}) {
		return this.apiClient.sendSticker(this.instanceName, chatId, media, options);
	}

	async sendLocation(chatId, location, options = {}) {
		return this.apiClient.sendLocation(this.instanceName, chatId, location, options);
	}

	async sendReaction(chatId, messageId, emoji) {
		return this.apiClient.sendReaction(this.instanceName, chatId, messageId, emoji);
	}

	async deleteMessage(chatId, messageId, options = {}) {
		return this.apiClient.deleteMessage(this.instanceName, chatId, messageId, options);
	}

	async editMessage(chatId, messageId, newText) {
		return this.apiClient.editMessage(this.instanceName, chatId, messageId, newText);
	}

	async replyMessage(chatId, messageId, text) {
		return this.apiClient.replyMessage(this.instanceName, chatId, messageId, text);
	}

	async forwardMessage(chatId, messageId, originalChatId) {
		return this.apiClient.forwardMessage(this.instanceName, chatId, messageId, originalChatId);
	}

	async markMessageRead(chatId, messageId) {
		return this.apiClient.markMessageRead(this.instanceName, chatId, messageId);
	}

	// ──────────────────────────────────────────────────────────
	// Download de mídia
	// ──────────────────────────────────────────────────────────

	async _downloadMediaFromWuzapi(messageContent) {
		try {
			const response = await this.apiClient.downloadMedia(
				this.instanceName,
				messageContent
			);

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
		return this.apiClient.listGroups(this.instanceName);
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
		// Tenta como grupo primeiro, depois como contato
		try {
			return await this.apiClient.getGroupInfo(this.instanceName, chatId);
		} catch {
			return await this.apiClient.getContactInfo(this.instanceName, chatId);
		}
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
						"-vf", videoFilter,
						"-c:v", "libwebp",
						"-lossless", "0",
						"-q:v", "80",
						"-compression_level", "6"
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
				.composite([{
					input: resizedImageBuffer,
					gravity: sharp.gravity.center
				}])
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
				inputPath, "-coalesce", "-background", "none",
				"-alpha", "on", "-dispose", "previous", outputPath
			]);
			await unlinkAsync(inputPath).catch(() => {});

			const fileUrl = `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/gifs/${outputFileName}`;

			if (!keepFile) {
				setTimeout(() => { fs.unlink(outputPath, () => {}); }, 60000);
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
			if (inputContent && !inputContent.startsWith("http://") && !inputContent.startsWith("https://")) {
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
				setTimeout(() => { fs.unlink(outputPath, () => {}); }, 60000);
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
			if (inputContent && !inputContent.startsWith("http://") && !inputContent.startsWith("https://")) {
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
						"-vf", videoFilter,
						"-loop", "0",
						"-c:v", "libwebp",
						"-lossless", "0",
						"-q:v", "75",
						"-compression_level", "6",
						"-preset", "default",
						"-an",
						"-vsync", "cfr"
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
			if (fs.existsSync(tempOutputPath))
				await unlinkAsync(tempOutputPath).catch(() => {});
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
			if (fs.existsSync(tempOutputPath))
				await unlinkAsync(tempOutputPath).catch(() => {});
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

		// Tenta no Redis
		try {
			const result = await this.cacheManager.get(messageId);
			if (result) return result;
		} catch (e) {
			this.logger.debug("[recoverMsgFromCache] Redis error:", e.message);
		}

		return null;
	}

	async cacheMessage(messageId, messageData, ttl = 300) {
		if (!messageId || !messageData) return;

		// Cache local (limitado)
		if (this.messageCache.length < this.maxCacheSize) {
			this.messageCache.push({ key: messageId, value: messageData });
		}

		// Redis
		try {
			await this.cacheManager.set(messageId, messageData, ttl);
		} catch (e) {
			this.logger.debug("[cacheMessage] Redis error:", e.message);
		}
	}

	// ──────────────────────────────────────────────────────────
	// Placeholders — métodos a implementar conforme necessário
	// ──────────────────────────────────────────────────────────

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