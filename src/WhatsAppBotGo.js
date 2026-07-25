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

const WhatsgoClient = require("./services/WhatsgoClient");
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

class WhatsAppBotGo {
	constructor(options) {
		this.id = options.id;
		this.nomeExibir = options.nomeExibir;
		this.sendJoinInfo = options.sendJoinInfo;
		this.vip = options.vip;
		this.comunitario = options.comunitario;
		this.numeroResponsavel = options.numeroResponsavel;
		this.supportMsg = options.supportMsg;
		this.phoneNumber = options.phoneNumber;
		this.eventHandler = options.eventHandler;
		this.prefix = options.prefix ?? process.env.DEFAULT_PREFIX ?? "!";
		this.logger = new Logger(`bot-whatsgo-${this.id}`);
		this.whatsgoApiUrl = options.whatsgoApiUrl;
		this.whatsgoApiKey = options.whatsgoApiKey; // Global Key
		this.instanceName = options.goInstanceName ?? options.id;
		let wh = options.webhookHost;
		if (wh && !wh.startsWith("http://") && !wh.startsWith("https://")) {
			wh = "http://" + wh;
		}
		this.webhookHost = wh;
		this.webhookPort = options.webhookPort ?? process.env.WEBHOOK_PORT_WHATSGO ?? 3000;
		this.notificarDonate = options.notificarDonate;
		this.pvAI = options.pvAI;
		this.version = "WhatsgoGO";
		this.wwebversion = "0";
		this.banido = options.banido;
		this.comandosAudioPV = false; // Futuro talvez? Considerar áudios no PV um comando

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
		this.cacheManager = CacheManager.getInstance(
			this.redisURL,
			this.redisDB,
			this.redisTTL,
			this.maxCacheSize
		);

		if (!this.whatsgoApiUrl || !this.whatsgoApiKey || !this.instanceName || !this.webhookHost) {
			const errMsg =
				"WhatsAppBotGo: whatsgoApiUrl, whatsgoApiKey, instanceName, and webhookHost are required!";
			this.logger.error(errMsg, {
				whatsgoApiUrl: !!this.whatsgoApiUrl,
				whatsgoApiKey: !!this.whatsgoApiKey,
				instanceName: !!this.instanceName,
				webhookHost: !!this.webhookHost
			});
			throw new Error(errMsg);
		}

		this.apiClient = new WhatsgoClient(
			this.whatsgoApiUrl,
			this.whatsgoApiKey,
			this.instanceName,
			this.logger
		);

		this.database = Database.getInstance();
		this.isConnected = false;
		this.safeMode =
			options.safeMode !== undefined ? options.safeMode : process.env.SAFE_MODE === "true";
		this.otherBots = options.otherBots ?? [];

		this.ignorePV = options.ignorePV ?? false;
		this.updateStatus = options.updateStatus ?? true;
		this.aiPersonality = options.aiPersonality ?? "";
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

		// Controle de desconexão
		this.disconnectedAt = null;
		this._disconnectTimer = null;

		// SSE clients para streaming de QR code/pairing code na página /qrcode/:botId
		this.qrSseClients = [];

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

		// Client Fake
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

	scheduleGroupInfoUpdate() {
		if (process.env.DISABLE_ACTIVITY === "true") return;
		const agora = new Date();
		const proximaExecucao = new Date(agora);
		proximaExecucao.setHours(3, 0, 0, 0); // 3 AM

		// Se já passou das 3 AM hoje, agenda para amanhã
		if (agora > proximaExecucao) {
			proximaExecucao.setDate(proximaExecucao.getDate() + 1);
		}

		let tempoAteExecucao = proximaExecucao.getTime() - agora.getTime();

		// Adiciona delay aleatório entre 0 e 30 minutos (0 a 1800000 ms)
		const delayAleatorio = Math.floor(Math.random() * 1800000);
		tempoAteExecucao += delayAleatorio;

		this.logger.info(
			`[scheduleGroupInfoUpdate] Atualização de info de grupos agendada para daqui a ${Math.floor(tempoAteExecucao / 60000)} minutos (com delay aleatório de ${Math.floor(delayAleatorio / 60000)} mins)`
		);

		setTimeout(async () => {
			try {
				await this.updateGroupsInfo();
			} catch (error) {
				this.logger.error("[scheduleGroupInfoUpdate] Erro ao executar updateGroupsInfo:", error);
			} finally {
				// Reagenda para o próximo dia
				this.scheduleGroupInfoUpdate();
			}
		}, tempoAteExecucao);
	}

	async updateGroupsInfo() {
		this.logger.info(
			"[updateGroupsInfo] Iniciando atualização programada das informações dos grupos..."
		);
		try {
			const groupsData = await this.listGroups();
			if (!groupsData || !Array.isArray(groupsData)) {
				this.logger.warn(
					"[updateGroupsInfo] Não foi possível obter a lista de grupos para atualizar."
				);
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
			this.logger.info(
				`[updateGroupsInfo] Finalizado. ${updatedCount} grupos atualizados (titulo/descricao).`
			);
		} catch (e) {
			this.logger.error("[updateGroupsInfo] Erro na rotina de atualização de grupos:", e);
		}
	}

	async getGoInstance(name) {
		const allInstances = await this.apiClient.get(`/instance/all`, {}, true);
		return allInstances.data?.find((aI) => aI.name === name);
	}

	async logout() {
		this.logger.info(`[logout] Logging out instance ${this.instanceName}`);
		this._onInstanceDisconnected("Logout");
		return await this.apiClient.delete("/instance/logout", {}, false);
	}

	async deleteInstance() {
		this._onInstanceDisconnected("DeleteInstance");
		// Precisa pegar O ID da instancia, que só vem no /all
		const instanceToDelete = await this.getGoInstance(this.instanceName);
		this.logger.info(`[deleteInstance] Deleting instance ${this.instanceName}`, {
			instanceToDelete
		});

		if (instanceToDelete) {
			return await this.apiClient.delete(`/instance/delete/${instanceToDelete.id}`, {}, true);
		} else {
			return {
				erro: "não encontrei a instancia",
				name: this.instanceName
			};
		}
	}

	async createInstance() {
		this.logger.info(`[createInstance] Creating instance ${this.instanceName}`);
		const payload = {
			name: this.instanceName,
			webhookUrl: `${this.webhookHost}:${this.webhookPort}/webhook/${this.instanceName}`,
			webhookEvents: [
				"MESSAGE",
				"PRESENCE",
				"CALL",
				"CONNECTION",
				"QRCODE",
				"CONNECTION",
				"CONTACT",
				"GROUP",
				"NEWSLETTER"
			] // Ajustar conforme necessidade da V3
		};

		this.logger.info(`[createInstance] Creating instance ${this.instanceName}`, payload);
		return await this.apiClient.post("/instance/create", payload, true);
	}

	_normalizeId(id, logger) {
		if (typeof id !== "string" || !id) {
			return "";
		}
		const cleanId = id.split("@")[0].split(":")[0];
		if (cleanId && !/^\d+$/.test(cleanId)) {
			if (logger && typeof logger.error === "function") {
				logger.error(
					`[isAdmin] ID inválido detectado: "${id}" resultou em "${cleanId}", que contém caracteres não numéricos.`
				);
			}
		}
		return cleanId;
	}

	async isUserAdminInGroup(userId, groupId) {
		return this.adminUtils.isAdmin(userId, { id: groupId }, null, this);
	}

	async recreateInstance() {
		const results = [];
		this.logger.info(`[recreateInstance] Starting recreation for ${this.instanceName}`);
		try {
			const deleteResult = await this.deleteInstance();
			results.push({ action: "delete", status: "success", result: deleteResult });
			this.logger.info(`[recreateInstance] Instance deleted. Waiting 5 seconds before creation...`);
		} catch (error) {
			this.logger.error(`[recreateInstance] Failed to delete instance:`, error);
			results.push({ action: "delete", status: "error", error: error.message });
		}

		await sleep(5000);

		for (let i = 0; i < 3; i++) {
			try {
				this.logger.info(`[recreateInstance] Attempting to create instance (try ${i + 1}/3)...`);
				const createResult = await this.createInstance();
				results.push({ action: "create", status: "success", result: createResult });
				this.logger.info(`[recreateInstance] Instance creation successful, defining settings`);

				try {
					const settingsResult = await this.instanceAdvSettings(); // Default ok
					results.push({ action: "advSettings", status: "success", result: settingsResult });
					this.logger.info(`[recreateInstance] Instance advanced settings successful.`);
				} catch (error) {
					this.logger.error(
						`[recreateInstance] Failed to define instance advanced settings:`,
						error
					);
					results.push({
						action: "advSettings",
						status: "error",
						attempt: i + 1,
						error: error.message
					});
				}

				return results;
			} catch (error) {
				this.logger.error(`[recreateInstance] Attempt ${i + 1} failed:`, error);
				results.push({ action: "create", status: "error", attempt: i + 1, error: error.message });
				if (i < 2) {
					this.logger.info(`[recreateInstance] Waiting 5 seconds before retry...`);
					await sleep(5000);
				}
			}
		}

		this.logger.error(`[recreateInstance] Failed to create instance after 3 attempts.`);
		return results;
	}

	async instanceAdvSettings(
		alwaysOnline = true,
		rejectCall = true,
		readMessages = false,
		ignoreGroups = false,
		ignoreStatus = true
	) {
		// Precisa pegar O ID da instancia, que só vem no /all
		const instanceToEdit = await this.getGoInstance(this.instanceName);
		this.logger.info(`[instanceAdvSettings] Instance Settings ${this.instanceName}`, {
			instanceToEdit,
			alwaysOnline,
			rejectCall,
			readMessages,
			ignoreGroups,
			ignoreStatus
		});

		if (instanceToEdit) {
			return await this.apiClient.put(`/instance/${instanceToEdit.id}/advanced-settings`, {
				alwaysOnline,
				rejectCall,
				readMessages,
				ignoreGroups,
				ignoreStatus
			});
		} else {
			throw new Error(
				JSON.stringify({
					erro: "não encontrei a instancia",
					name: this.instanceName
				})
			);
		}
	}

	async updateVersions() {
		// TODO: Implementar busca de versão na V3 se disponível
		this.version = "WhatsgoGO";
	}

	async convertToSquareWebPImage(base64ImageContent) {
		// Copiado do V2
		let inputPath = "";
		let isTempInputFile = false;
		const tempId = randomBytes(16).toString("hex");
		const tempDirectory = os.tmpdir();
		const tempInputPath = path.join(tempDirectory, `${tempId}_input.tmp`);
		const tempOutputPath = path.join(tempDirectory, `${tempId}_output.webp`);

		try {
			if (!base64ImageContent || typeof base64ImageContent !== "string") {
				throw new Error("Invalid base64ImageContent: Must be a non-empty string.");
			}
			const base64Data = base64ImageContent.includes(",")
				? base64ImageContent.split(",")[1]
				: base64ImageContent;
			if (!base64Data)
				throw new Error("Invalid base64ImageContent: Empty data after stripping prefix.");

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
					.on("end", () => resolve())
					.on("error", (err) => reject(err))
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
		const tempId = randomBytes(16).toString("hex");

		try {
			if (!base64ImageContent || typeof base64ImageContent !== "string") {
				throw new Error("Invalid base64ImageContent: Must be a non-empty string.");
			}

			const base64Data = base64ImageContent.includes(",")
				? base64ImageContent.split(",")[1]
				: base64ImageContent;

			if (!base64Data) {
				throw new Error("Invalid base64ImageContent: Empty data after stripping prefix.");
			}

			const imageBuffer = Buffer.from(base64Data, "base64");
			const targetSize = 800; // Target dimension for the square output

			const resizedImageBuffer = await sharp(imageBuffer)
				.resize({
					width: targetSize,
					height: targetSize,
					fit: sharp.fit.inside,
					withoutEnlargement: false, // Allow upscaling
					kernel: sharp.kernel.lanczos3
				})
				.toBuffer(); // Get the resized image as a buffer

			const finalImageBuffer = await sharp({
				create: {
					width: targetSize,
					height: targetSize,
					channels: 4, // 4 channels for RGBA (to support transparency)
					background: { r: 0, g: 0, b: 0, alpha: 0 } // Transparent background
				}
			})
				.composite([
					{
						input: resizedImageBuffer, // The buffer of the resized image
						gravity: sharp.gravity.center // Center the image on the new canvas
					}
				])
				.png({
					// PNG specific options for compression:
					compressionLevel: 6, // zlib compression level (0-9), default is 6. Higher is smaller but slower.
					adaptiveFiltering: true // Use adaptive row filtering for potentially smaller file size.
				})
				.toBuffer();

			const base64Png = finalImageBuffer.toString("base64");

			return base64Png;
		} catch (error) {
			this.logger.error(
				`[convertToSquarePNGImage] [${tempId}] Error during Sharp processing: ${error.message}`,
				error.stack
			);
			throw error;
		}
	}

	async convertAnimatedWebpToGif(base64Webp, keepFile = false) {
		const tempId = randomBytes(8).toString("hex");
		const tempDir = os.tmpdir();
		const inputPath = path.join(tempDir, `${tempId}.webp`);
		const outputFileName = `${tempId}.gif`;

		// Output location: public/gifs
		const outputDir = path.join(__dirname, "..", "public", "gifs");
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
		}
		const outputPath = path.join(outputDir, outputFileName);

		// Decode and save base64 WebP to temp file
		const buffer = Buffer.from(base64Webp.split(",").pop(), "base64");
		await writeFileAsync(inputPath, buffer);

		try {
			// imagemagick.convert takes an array of args (like CLI)
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

			// Clean up input
			await unlinkAsync(inputPath).catch(() => {});

			// Return public file URL
			const fileUrl = `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/gifs/${outputFileName}`;

			// Optionally delete GIF after 60s
			if (!keepFile) {
				setTimeout(() => {
					fs.unlink(outputPath, () => {});
				}, 60000);
			}

			return fileUrl;
		} catch (err) {
			await unlinkAsync(inputPath).catch(() => {});
			console.error(`[convertAnimatedWebpToGif] ImageMagick error: ${err.message}`);
			throw err;
		}
	}

	async convertToSquareAnimatedGif(inputContent, keepFile = false) {
		this.logger.info("[convertToSquareAnimatedGif] ", inputContent.substring(0, 30));
		let inputPath = inputContent;
		let isTempInputFile = false;
		const tempId = randomBytes(16).toString("hex");

		const tempInputDirectory = os.tmpdir();
		const tempInputPath = path.join(tempInputDirectory, `${tempId}_input.tmp`);

		// Define the output directory and ensure it exists
		const outputDir = path.join(__dirname, "..", "public", "gifs");
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
		}
		const outputFileName = `${tempId}.gif`;
		const outputPath = path.join(outputDir, outputFileName);

		try {
			if (
				inputContent &&
				!inputContent.startsWith("http://") &&
				!inputContent.startsWith("https://")
			) {
				this.logger.info(
					"[toSquareAnimatedGif] Input is base64. Decoding and saving to temporary file..."
				);
				const base64Data = inputContent.includes(",") ? inputContent.split(",")[1] : inputContent;
				const buffer = Buffer.from(base64Data, "base64");
				await writeFileAsync(tempInputPath, buffer);
				inputPath = tempInputPath;
				isTempInputFile = true;
				this.logger.info(
					"[toSquareAnimatedGif] Base64 input saved to temporary file:",
					tempInputPath
				);
			} else if (
				inputContent &&
				(inputContent.startsWith("http://") || inputContent.startsWith("https://"))
			) {
				this.logger.info("[toSquareAnimatedGif] Input is a URL:", inputPath);
				// ffmpeg can handle URLs directly
			} else {
				throw new Error("Invalid inputContent provided. Must be a URL or base64 string.");
			}

			this.logger.info(
				"[toSquareAnimatedGif] Starting square animated GIF conversion for:",
				inputPath
			);

			const targetSize = 512;
			const fps = 15; // WhatsApp tends to prefer 10-20 FPS for GIFs. 15 is a good compromise.

			const videoFilter =
				`fps=${fps},` +
				`scale=${targetSize}:${targetSize}:force_original_aspect_ratio=decrease:flags=lanczos,` +
				`pad=${targetSize}:${targetSize}:(ow-iw)/2:(oh-ih)/2:color=black@0.0,` +
				`split[s0][s1];[s0]palettegen=stats_mode=diff:max_colors=250:reserve_transparent=on[p];[s1][p]paletteuse=dither=bayer:alpha_threshold=128`;

			await new Promise((resolve, reject) => {
				ffmpeg(inputPath)
					.outputOptions(["-vf", videoFilter, "-loop", "0"])
					.toFormat("gif")
					.on("end", () => {
						this.logger.info("[toSquareAnimatedGif] Square animated GIF conversion finished.");
						resolve();
					})
					.on("error", (err) => {
						let ffmpegCommandDetails = "";
						if (err.ffmpegCommand) {
							ffmpegCommandDetails = `FFmpeg command: ${err.ffmpegCommand}`;
						} else if (err.spawnargs) {
							ffmpegCommandDetails = `FFmpeg arguments: ${err.spawnargs.join(" ")}`;
						}
						this.logger.error(
							`[toSquareAnimatedGif] Error during GIF conversion: ${err.message}. ${ffmpegCommandDetails}`,
							err.stack
						);
						reject(err);
					})
					.save(outputPath); // Save to the new permanent path
			});

			this.logger.info("[toSquareAnimatedGif] Square animated GIF saved to:", outputPath);

			// Schedule file deletion
			if (!keepFile) {
				setTimeout(() => {
					fs.unlink(outputPath, (err) => {
						if (err) {
							this.logger.error(`[toSquareAnimatedGif] Error deleting file ${outputPath}:`, err);
						} else {
							this.logger.info(`[toSquareAnimatedGif] Deleted file: ${outputPath}`);
						}
					});
				}, 60000);
			}

			// Check file size - WhatsApp has limits for GIFs (often around 1MB, but can vary)
			const stats = fs.statSync(outputPath);
			const fileSizeInMB = stats.size / (1024 * 1024);
			this.logger.info(`[toSquareAnimatedGif] Output GIF file size: ${fileSizeInMB.toFixed(2)} MB`);
			if (fileSizeInMB > 1.5) {
				// Example threshold, adjust as needed
				this.logger.warn(
					`[toSquareAnimatedGif] WARNING: Output GIF size is ${fileSizeInMB.toFixed(2)} MB, which might be too large for WhatsApp.`
				);
			}

			const fileUrl = `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/gifs/${outputFileName}`;
			this.logger.info("[toSquareAnimatedGif] Returning URL:", fileUrl);
			return fileUrl;
		} catch (error) {
			this.logger.error(
				"[toSquareAnimatedGif] Error in convertToSquareAnimatedGif function:",
				error.message,
				error.stack
			);
			throw error;
		} finally {
			if (isTempInputFile && fs.existsSync(tempInputPath)) {
				try {
					await unlinkAsync(tempInputPath);
					this.logger.info("[toSquareAnimatedGif] Temporary input file deleted:", tempInputPath);
				} catch (e) {
					this.logger.error(
						"[toSquareAnimatedGif] Error deleting temporary input file:",
						tempInputPath,
						e.message
					);
				}
			}
		}
	}

	async convertToAnimatedWebP(inputContent) {
		let inputPath = inputContent;
		let isTempInputFile = false;
		const tempId = randomBytes(16).toString("hex");

		const tempDirectory = os.tmpdir();
		const tempInputPath = path.join(tempDirectory, `${tempId}_input.tmp`);
		const tempOutputPath = path.join(tempDirectory, `${tempId}_output.webp`);

		try {
			if (
				inputContent &&
				!inputContent.startsWith("http://") &&
				!inputContent.startsWith("https://")
			) {
				this.logger.info(
					"[toAnimatedWebP] Input is base64. Decoding and saving to temporary file..."
				);
				const base64Data = inputContent.includes(",") ? inputContent.split(",")[1] : inputContent;
				const buffer = Buffer.from(base64Data, "base64");
				await writeFileAsync(tempInputPath, buffer);
				inputPath = tempInputPath;
				isTempInputFile = true;
				this.logger.info("[toAnimatedWebP] Base64 input saved to temporary file:", tempInputPath);
			} else if (
				inputContent &&
				(inputContent.startsWith("http://") || inputContent.startsWith("https://"))
			) {
				this.logger.info("[toAnimatedWebP] Input is a URL:", inputPath);
			} else {
				throw new Error("Invalid inputContent provided. Must be a URL or base64 string.");
			}

			this.logger.info("[toAnimatedWebP] Starting square animated WebP conversion for:", inputPath);

			// Define the target square dimensions
			const targetSize = 512;

			// Construct the complex video filter string
			// 1. Set FPS
			// 2. Scale to fit within targetSize x targetSize, preserving aspect ratio (lanczos for quality)
			// 3. Pad to targetSize x targetSize, center content, fill with transparent background
			// 4. Generate and use a palette for better WebP quality and transparency handling
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
						"75", // Quality for lossy WebP (0-100)
						"-compression_level",
						"6", // Compression level (0-6)
						"-preset",
						"default",
						"-an", // Remove audio
						"-vsync",
						"cfr" // Constant frame rate
					])
					.toFormat("webp")
					.on("end", () => {
						this.logger.info("[toAnimatedWebP] Square animated WebP conversion finished.");
						resolve();
					})
					.on("error", (err) => {
						let ffmpegCommand = "";
						if (err.ffmpegCommand) {
							ffmpegCommand = `FFmpeg command: ${err.ffmpegCommand}`;
						}
						this.logger.error(
							`[toAnimatedWebP] Error during square WebP conversion: ${err.message}. ${ffmpegCommand}`,
							err.stack
						);
						reject(err);
					})
					.save(tempOutputPath);
			});

			this.logger.info(
				"[toAnimatedWebP] Square animated WebP saved to temporary file:",
				tempOutputPath
			);

			const webpBuffer = await readFileAsync(tempOutputPath);
			const base64WebP = webpBuffer.toString("base64");
			this.logger.info("[toAnimatedWebP] Square animated WebP converted to base64.");

			return base64WebP;
		} catch (error) {
			this.logger.error(
				"[toAnimatedWebP] Error in convertToAnimatedWebP function:",
				error.message,
				error.stack
			);
			throw error;
		} finally {
			if (isTempInputFile && fs.existsSync(tempInputPath)) {
				try {
					await unlinkAsync(tempInputPath);
					this.logger.info("[toAnimatedWebP] Temporary input file deleted:", tempInputPath);
				} catch (e) {
					this.logger.error(
						"[toAnimatedWebP] Error deleting temporary input file:",
						tempInputPath,
						e.message
					);
				}
			}
			if (fs.existsSync(tempOutputPath)) {
				try {
					await unlinkAsync(tempOutputPath);
					this.logger.info("[toAnimatedWebP] Temporary output file deleted:", tempOutputPath);
				} catch (e) {
					this.logger.error(
						"[toAnimatedWebP] Error deleting temporary output file:",
						tempOutputPath,
						e.message
					);
				}
			}
		}
	}

	async toGif(inputContent) {
		let inputPath = inputContent;
		let isTempFile = false;
		const tempDirectory = os.tmpdir();
		const tempId = randomBytes(16).toString("hex"); // Generate a unique ID for temp files
		const tempInputPath = path.join(tempDirectory, `${tempId}_input.mp4`);
		const tempOutputPath = path.join(tempDirectory, `${tempId}_output.gif`);

		try {
			// Check if inputContent is base64 or URL
			if (!inputContent.startsWith("http://") && !inputContent.startsWith("https://")) {
				// Assume it's base64, decode and write to a temporary file
				const base64Data = inputContent.includes(",") ? inputContent.split(",")[1] : inputContent;
				const buffer = Buffer.from(base64Data, "base64");
				await writeFileAsync(tempInputPath, buffer);
				inputPath = tempInputPath;
				isTempFile = true;
				this.logger.info("[toGif] Input is base64, saved to temporary file:", tempInputPath);
			} else {
				this.logger.info("[toGif] Input is a URL:", inputPath);
			}

			this.logger.info("[toGif] Starting GIF conversion for:", inputPath);

			await new Promise((resolve, reject) => {
				ffmpeg(inputPath)
					.outputOptions([
						"-vf",
						"fps=20,scale=512:-1:flags=lanczos", // Example: 10 fps, 320px width, maintain aspect ratio
						"-loop",
						"0" // 0 for infinite loop, -1 for no loop, N for N loops
					])
					.toFormat("gif")
					.on("end", () => {
						this.logger.info("[toGif] GIF conversion finished.");
						resolve();
					})
					.on("error", (err) => {
						this.logger.error("[toGif] Error during GIF conversion:", err.message);
						reject(err);
					})
					.save(tempOutputPath);
			});

			this.logger.info("[toGif] GIF saved to temporary file:", tempOutputPath);

			// Read the generated GIF and convert to base64
			const gifBuffer = await readFileAsync(tempOutputPath);
			const base64Gif = gifBuffer.toString("base64");
			this.logger.info("[toGif] GIF converted to base64.");

			return base64Gif; // 'data:image/gif;base64,' não inclui
		} catch (error) {
			this.logger.error("[toGif] Error in toGif function:", error);
			throw error; // Re-throw the error to be caught by the caller
		} finally {
			// Clean up temporary files
			if (isTempFile && fs.existsSync(tempInputPath)) {
				try {
					await unlinkAsync(tempInputPath);
					this.logger.info("[toGif] Temporary input file deleted:", tempInputPath);
				} catch (e) {
					this.logger.error(
						"[toGif] Error deleting temporary input file:",
						tempInputPath,
						e.message
					);
				}
			}
			if (fs.existsSync(tempOutputPath)) {
				try {
					await unlinkAsync(tempOutputPath);
					this.logger.info("[toGif] Temporary output file deleted:", tempOutputPath);
				} catch (e) {
					this.logger.error(
						"[toGif] Error deleting temporary output file:",
						tempOutputPath,
						e.message
					);
				}
			}
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

	async _downloadMediaFromWhatsgo(messageContent) {
		try {
			//this.logger.debug(`[_downloadMediaFromWhatsgo] POST /message/downloadmedia`, { message: messageContent });
			const response = await this.apiClient.post("/message/downloadmedia", {
				message: messageContent
			});
			if (response?.data?.base64) {
				const base64Data = response.data.base64.replace(/^data:.*?;base64,/, "");

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

				if (extension === "bin") {
					this.logger.debug(`[_downloadMediaFromWhatsgo] Arquivo bin? Mimetype ${mimetype}`);
				}
				await writeFileAsync(filePath, base64Data, "base64");

				setTimeout(
					(fp) => {
						if (fs.existsSync(fp)) fs.unlinkSync(fp);
					},
					10 * 60 * 1000,
					filePath
				);

				const fileUrl = `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/attachments/${fileName}`;

				const media = { url: fileUrl, mimetype, filename: fileName, filePath, base64: base64Data };
				//this.logger.debug(`[_downloadMediaFromWhatsgo] Res: ${fileUrl}`, media);
				return media;
			}
		} catch (error) {
			this.logger.error(`[${this.id}] Error downloading media from Whatsgo:`, error);
		}
		return null;
	}

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

	async createMediaFromBase64(base64Data, mimetype, filename) {
		try {
			const extension = mime.extension(mimetype) ?? "bin";
			const buffer = Buffer.from(base64Data, "base64");
			const size = buffer.length;
			const url = this._storeMediaFile(buffer, `.${extension}`);

			// Fixes
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
			//this.logger.info(`[createMediaFromBase64] `, media );
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
			} else {
				this.logger.info(
					`[createMedia] File size (${size} bytes) exceeds limit, not reading to base64.`
				);
			}

			const filename = path.basename(filePath);
			let mimetype = customMime
				? customMime
				: (mime.lookup(filePath) ?? "application/octet-stream");

			// Fixes
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
			//this.logger.info(`[createMedia] `, media );
			return media;
		} catch (error) {
			console.error(`Error creating media from ${filePath}:`, error);
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
					this.logger.info("mimetype do header? ", headResponse);
					mimetype = options.customMime
						? options.customMime
						: (headResponse.headers["content-type"]?.split(";")[0] ?? "application/octet-stream");
				} catch (e) {
					/* ignore */
				}
			}

			// Fixes
			if (mimetype === "application/mp4") {
				mimetype = "video/mp4";
			}

			const media = { url, mimetype, filename, source: "url", isMessageMedia: true, size };

			//this.logger.info(`[createMediaFromURL] `, media);
			return media;
		} catch (error) {
			this.logger.error(`[${this.id}] Whatsgo: Error creating media from URL ${url}:`, error);
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

		// Auto-translate logic
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
			const options = { ...(message.options ?? {}) }; // Clone options

			try {
				const result = await this.sendMessage(message.chatId, contentToSend, options);
				results.push(result);

				if (result && result.id?._serialized) {
					// O bot está reagindo à PRÓPRIA mensagem enviada, isto não é interessante. Deve ser commented out no código.
					/*
					if (message.reaction) {
						// CORRETO: ReturnMessage só tem um reaction
						try {
							await this.sendReaction(message.chatId, result.id._serialized, message.reaction); // Assuming result.id has the ID
						} catch (reactError) {
							this.logger.error(
								`[${this.id}] Erro enviando reaction "${message.reaction}" pra ${result.id._serialized}:`,
								reactError
							);
						}
					}
					*/
					if (message.reactions) {
						// ERRADO: Apenas Command deveria ter mais de 1 reação, então isso deve ser arrumado
						// Esse código precisa ser excluído depois de arrumar todas as ReturnMessage erradas
						this.logger.debug(
							`[sendReturnMessages] ReturnMessage com reactions ao invés de reaction!`,
							{ message }
						);
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
					getInfo: () =>
						// Usado no StreamSystem pra saber se foi enviada
						({ delivery: [], played: [], read: [] })
				});
			}
		}
		return results;
	}

	async recoverMsgFromCache(messageId) {
		try {
			if (!messageId) {
				return null;
			} else {
				const actualId = this.getActualMsgId(messageId);

				const msg = await this.cacheManager.getGoMessageFromCache(actualId);

				//this.logger.debug(`[recoverMsgFromCache] `, { actualId, msg });
				if (!msg || !msg.goMessageData) {
					return msg ?? null;
				}

				const recovered = await this.formatMessageFromGo(msg.goMessageData);
				//this.logger.debug(`[recoverMsgFromCache] `, { actualId, recovered });
				if (!recovered) {
					return msg;
				} else {
					return recovered;
				}
			}
		} catch (e) {
			this.logger.error(`[recoverMsgFromCache] Erro recuperando msg '${messageId}'`, e);
			throw e;
		}
	}

	async recoverContactFromCache(number) {
		try {
			if (!number) {
				return null;
			} else {
				const contact = await this.cacheManager.getContactFromCache(number);
				if (contact) {
					contact.block = async () => await this.setCttBlockStatus(number, "block");
					contact.unblock = async () => await this.setCttBlockStatus(number, "unblock");
					return contact;
				} else {
					return null;
				}
			}
		} catch (e) {
			this.logger.error(`[recoverContactFromCache] Erro recuperando contato '${number}'`, e);
			throw e;
		}
	}

	async initialize() {
		await this._loadSkipGroupInfo();
		this.database.registerBotInstance(this);
		this.startupTime = Date.now();
		this.lastMessageReceived = Date.now();

		const webhookPath = `/webhook/${this.instanceName}`;
		const instanceDesc = `Webhook on ${this.webhookHost}:${this.webhookPort}${webhookPath}`;
		this.logger.info(
			`[${this.startupTime}][${this.id}] Init GoAPI bot instance ${this.instanceName}: ${instanceDesc})`
		); // , { instanceInfo }

		try {
			// Webhook Setup
			this.webhookApp = express();
			this.webhookApp.set("trust proxy", true);
			this.webhookApp.use(express.json({ limit: "500mb" }));
			this.webhookApp.use(express.urlencoded({ extended: true, limit: "500mb" }));

			this.webhookApp.post(webhookPath, this._handleWebhook.bind(this));
			this.webhookApp.get(webhookPath, this._handleWebhook.bind(this));

			await new Promise((resolve, reject) => {
				this.webhookServer = this.webhookApp
					.listen(this.webhookPort, () => {
						resolve();
					})
					.on("error", (err) => {
						this.logger.error(
							`Failed to start webhook listener for bot ${this.instanceName}:`,
							err
						);
						reject(err);
					});
			});
		} catch (error) {
			this.logger.error(`Error during webhook setup for instance ${this.instanceName}:`, error);
		}

		this.logger.info(
			`[${this.id}] [whitelist] ${this.whitelist.length} números na whitelist do PV.`
		);
		this._checkInstanceStatusAndConnect();

		return this;
	}

	async _checkInstanceStatusAndConnect(isRetry = false, forceConnect = false) {
		try {
			let response;
			try {
				response = await this.apiClient.get(`/instance/status`);
			} catch (e) {
				if (e && e.status === 401) {
					this.isConnected = false;
					if (forceConnect) {
						this.logger.info(
							`[${this.id}] Instância não existe na WhatsGoAPI (401). Criando instância automaticamente...`
						);
						try {
							await this.createInstance();
							await this.instanceAdvSettings();
							response = await this.apiClient.get(`/instance/status`);
						} catch (createErr) {
							this.logger.error(`[${this.id}] Erro ao criar instância automaticamente:`, createErr);
							return {
								instanceDetails: { version: this.version, tipo: "whatsgoapi" },
								extra: { connectData: this.connectDataCache?.data || {}, error: createErr.message }
							};
						}
					} else {
						return {
							instanceDetails: { version: this.version, tipo: "whatsgoapi" },
							extra: { connectData: this.connectDataCache?.data || {} }
						};
					}
				} else {
					this.logger.error(
						`[_checkInstanceStatusAndConnect] Erro buscando status de ${this.instanceName}`,
						e
					);
					response = { data: { Connected: false, LoggedIn: false } };
				}
			}

			const statusData = response?.data;
			// Connected = websocket WA estabelecido; LoggedIn = sessão autenticada
			const wsConnected = !!statusData?.Connected;
			this.isConnected = wsConnected && !!statusData?.LoggedIn;

			const instanceDetails = { version: this.version, tipo: "whatsgoapi" };
			const extra = {};

			if (statusData?.lastPasskeyRequest) {
				extra.lastPasskeyRequest = statusData.lastPasskeyRequest;
			}

			// Totalmente conectado e logado
			if (this.isConnected) {
				this._onInstanceConnected();
				extra.ok = true;
				this.connectDataCache = null;
				this._connectingPromise = null;
				return { instanceDetails, extra };
			}

			// Se forceConnect for false, apenas retorna o status sem solicitar QR / pairing code
			if (!forceConnect) {
				extra.connectData = this.connectDataCache?.data || {};
				return { instanceDetails, extra };
			}

			// Não logado — busca QR/pairing code se cache expirou e forceConnect for true
			{
				const now = Date.now();
				const cacheValid = this.connectDataCache && now - this.connectDataCache.timestamp < 55000;

				if (!cacheValid) {
					if (this._connectingPromise) {
						// Já tem uma operação em andamento, espera ela terminar
						await this._connectingPromise;
					} else {
						// Bloqueia requests paralelos imediatamente
						this.connectDataCache = { timestamp: now, data: {} };

						this._connectingPromise = (async () => {
							try {
								const connectData = {};

								if (!wsConnected) {
									// WS não estabelecido: precisa conectar primeiro
									this.logger.info(`[${this.id}] WS desconectado. Chamando /instance/connect...`);
									let connectResponse = await this.apiClient.post(
										`/instance/connect`,
										{
											webhookUrl: `${this.webhookHost}:${this.webhookPort}/webhook/${this.instanceName}`,
											subscribe: [
												"MESSAGE",
												"SEND_MESSAGE",
												"READ_RECEIPT",
												"PRESENCE",
												"CHAT_PRESENCE",
												"CALL",
												"CONNECTION",
												"LABEL",
												"CONTACT",
												"GROUP",
												"NEWSLETTER",
												"QRCODE"
											]
										},
										false
									);

									if (connectResponse.message !== "success") {
										this.logger.warn(
											`[${this.id}] Connect retornou: ${connectResponse.message}. Tentando criar instância...`
										);
										try {
											await this.createInstance();
											await this.instanceAdvSettings();
											connectResponse = await this.apiClient.post(
												`/instance/connect`,
												{
													webhookUrl: `${this.webhookHost}:${this.webhookPort}/webhook/${this.instanceName}`,
													subscribe: [
														"MESSAGE",
														"SEND_MESSAGE",
														"READ_RECEIPT",
														"PRESENCE",
														"CHAT_PRESENCE",
														"CALL",
														"CONNECTION",
														"LABEL",
														"CONTACT",
														"GROUP",
														"NEWSLETTER",
														"QRCODE"
													]
												},
												false
											);
										} catch (errCreate) {
											this.logger.error(
												`[${this.id}] Erro criando instância no connect retry:`,
												errCreate
											);
											this.connectDataCache = null;
											return;
										}
									}

									// Aguarda o WS do WA inicializar antes de pedir pair
									this.logger.info(
										`[${this.id}] Connect ok. Aguardando 8s para o WA inicializar...`
									);
									await new Promise((resolve) => setTimeout(resolve, 8000));
								} else {
									// WS já está up (Connected=true, LoggedIn=false)
									// Só precisa buscar pair/qr, sem reconectar
									this.logger.info(`[${this.id}] WS já conectado. Buscando pair/qr diretamente...`);
								}

								const pairingCodeResponse = await this.apiClient.post(
									`/instance/pair`,
									{ phone: this.phoneNumber },
									false
								);
								const qrCodeResponse = await this.apiClient.get(`/instance/qr`, {}, false);

								connectData.pairingCode = pairingCodeResponse?.data?.PairingCode || "";
								connectData.qrCode = qrCodeResponse?.data?.Qrcode || "";
								connectData.code = qrCodeResponse?.data?.Code || "";

								this.logger.info(
									`[${this.id}] PairingCode: ${connectData.pairingCode || "(vazio)"}, QR: ${connectData.qrCode ? "ok" : "(vazio)"}`
								);

								this.connectDataCache = {
									timestamp: connectData.qrCode ? now : now - 52000,
									data: connectData
								};

								if (connectData.qrCode) {
									const qrCodeLocal = path.join(
										this.database.databasePath,
										"qrcodes",
										`qrcode_${this.id}.png`
									);
									const base64Data = connectData.qrCode.replace(/^data:image\/png;base64,/, "");
									fs.writeFileSync(qrCodeLocal, base64Data, "base64");
								}

								if (connectData.pairingCode) {
									this.logger.info(`[${this.id}] PAIRING CODE: ${connectData.pairingCode}`);
								}
							} catch (connectErr) {
								this.logger.error(`[${this.id}] Erro no connect/pair:`, connectErr);
								this.connectDataCache = null;
							} finally {
								this._connectingPromise = null;
							}
						})();

						await this._connectingPromise;
					}
				}
			}

			extra.connectData = this.connectDataCache?.data || {};
			return { instanceDetails, extra };
		} catch (error) {
			this.logger.error(`Error checking/connecting instance ${this.instanceName}:`, error);
			return { instanceDetails: { version: this.version, tipo: "whatsgoapi" }, extra: {}, error };
		}
	}
	async _onInstanceConnected() {
		if (this._disconnectTimer) {
			clearTimeout(this._disconnectTimer);
			this._disconnectTimer = null;
		}
		this.disconnectedAt = null;

		if (this.streamSystem) {
			this.streamSystem.initialize();
			this.streamMonitor = this.streamSystem.streamMonitor;
		}

		this._sendStartupNotifications();
		this.fetchAndPrepareBlockedContacts();

		if (this.isConnected) return;
		this.isConnected = true;
		this.logger.info(`[${this.id}] Successfully connected to WhatsApp via WhatsgoGO API.`);
		this.broadcastQRUpdate({ type: "connected", botId: this.id });

		if (this.eventHandler && typeof this.eventHandler.onConnected === "function") {
			this.eventHandler.onConnected(this);
		}
	}

	_onInstanceDisconnected(reason = "Unknown") {
		if (!this.isConnected && reason !== "INITIALIZING") return;
		this.isConnected = false;
		this.disconnectedAt = Date.now();
		this.logger.info(`[${this.id}] Disconnected from WhatsApp. Reason: ${reason}`);
		if (this.eventHandler && typeof this.eventHandler.onDisconnected === "function") {
			this.eventHandler.onDisconnected(this, reason);
		}

		// Limpar timer anterior se existir
		if (this._disconnectTimer) {
			clearTimeout(this._disconnectTimer);
			this._disconnectTimer = null;
		}

		// Após 15 minutos desconectado, apagar a instância (sem recriar)
		// O fluxo de conexão só é iniciado quando a página /qrcode/:botId é aberta
		const DISCONNECT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos
		this._disconnectTimer = setTimeout(async () => {
			try {
				this.logger.info(`[${this.id}] 15 minutos desconectado. Apagando instância...`);
				await this.deleteInstance();
				this.connectDataCache = null;
				this._disconnectTimer = null;
				this.logger.info(`[${this.id}] Instância apagada após timeout de desconexão.`);
				// Notificar clientes SSE
				this.broadcastQRUpdate({ type: "instance_deleted", botId: this.id });
			} catch (err) {
				this.logger.error(`[${this.id}] Erro ao apagar instância após timeout:`, err);
			}
		}, DISCONNECT_TIMEOUT_MS);
	}

	/**
	 * Transmite atualização de QR code / pairing code para clientes SSE da página de conexão
	 */
	broadcastQRUpdate(data) {
		const payload = `data: ${JSON.stringify(data)}\n\n`;
		this.qrSseClients.forEach((res) => {
			try {
				res.write(payload);
			} catch (e) {
				/* ignore */
			}
		});
	}

	/**
	 * Adiciona cliente SSE para receber atualizações de QR code
	 */
	addQRSseClient(res) {
		this.qrSseClients.push(res);
	}

	/**
	 * Remove cliente SSE da lista
	 */
	removeQRSseClient(res) {
		this.qrSseClients = this.qrSseClients.filter((c) => c !== res);
	}

	async _handleWebhook(req, res) {
		const payload = req.body;
		// V3 Payload structure: { event: "Message", instance: "...", data: { ... } }

		if (!payload?.event) {
			return res.status(200).send(`hello-${this.instanceName}-${this.id}`);
		}

		if (this.shouldDiscardMessage() && payload.event === "Message") {
			return res.sendStatus(200);
		}

		try {
			switch (payload.event) {
				case "Connection": // Verificar nome correto do evento na V3
				case "connection.update": // Compatibilidade?
					// Lógica de conexão
					break;

				case "Message": // Mensagens e reactions
				case "SendMessage": {
					this.isConnected = true;
					this.lastMessageReceived = Date.now();
					const msgData = payload.data;

					if (msgData) {
						const info = msgData.Info;
						const msg = msgData.Message;
						const reactionData = msg?.reactionMessage;

						if (info.PushName && info.PushName.length > 0) {
							if (info.Sender) {
								this.cacheManager.putPushnameInCache({ id: info.Sender, pushName: info.PushName });
							}
							if (info.SenderAlt) {
								this.cacheManager.putPushnameInCache({
									id: info.SenderAlt,
									pushName: info.PushName
								});
							}
						}

						const chatToFilter = info.Chat;
						if (
							chatToFilter === this.grupoLogs ||
							chatToFilter === this.grupoAnuncios ||
							chatToFilter === this.grupoInvites ||
							chatToFilter === this.grupoEstabilidade
						) {
							break;
						}

						if (reactionData) {
							// ravena só processa se VIER uma reaction (campo 'text')
							if (reactionData.text !== "" && !reactionData.key.fromMe) {
								//this.logger.debug(`[${this.id}] Received reaction:`, { msgData, reactionData });
								// reactionData.text -> emoji
								// reactionData.key.participant -> @lid da pessoa que RECEBEU a reaction
								// reactionData.key.remoteJID -> chat que veio a reaction
								this.reactionHandler.processReaction(this, {
									reaction: reactionData.text,
									senderId: info.Sender ?? info.SenderAlt,
									userName: info.PushName,
									msgId: { _serialized: reactionData.key.ID }
								});

								if (this.eventHandler && typeof this.eventHandler.onReaction === "function") {
									this.eventHandler.onReaction(this, {
										reaction: reactionData.text,
										senderId: info.Sender ?? info.SenderAlt,
										userName: info.PushName,
										chatId: info.Chat,
										msgId: { _serialized: reactionData.key.ID }
									});
								}
							}
						} else {
							// Se não for reaction, é qualquer outro tipo de mensagem
							// Adicionar campos para formatMessageFromGo
							const whatsgoMsg = {
								...msgData,
								event: payload.event
							};

							this.formatMessageFromGo(whatsgoMsg)
								.then((formattedMessage) => {
									if (
										formattedMessage &&
										this.eventHandler &&
										typeof this.eventHandler.onMessage === "function"
									) {
										if (!formattedMessage.fromMe) {
											this.eventHandler.onMessage(this, formattedMessage);
										}
									}
								})
								.catch((e) => {
									this.logger.error(`[Message] Erro formatando mensagem`, e);
								});
						}
					}
					break;
				}

				case "GroupInfo": {
					// Payload: { event: "GroupInfo", data: { ... } }
					// data has: JID, Join, Leave, Promote, Demote
					// Aqui vem várias coisas, quando muda titulo, configs, etc.
					const groupInfoData = payload.data;
					if (groupInfoData) {
						// Eventos de mudança de membro
						if (
							groupInfoData.Join ||
							groupInfoData.Leave ||
							groupInfoData.Promote ||
							groupInfoData.Demote
						) {
							this._handleGroupParticipantsUpdate(groupInfoData);
						}

						// Evento de mudança de configuração de mensagens (abrir/fechar grupo)
						if (groupInfoData.Announce) {
							if (this.eventHandler?.onGroupSettingsUpdate) {
								this.eventHandler.onGroupSettingsUpdate(this, {
									groupId: groupInfoData.JID,
									announce: groupInfoData.Announce.IsAnnounce,
									sender: groupInfoData.SenderPN || groupInfoData.Sender
								});
							}
						}
					}
					break;
				}

				case "JoinedGroup": {
					// Bot joined a group
					// Payload: { event: "JoinedGroup", data: { JID: "...", Participants: [...] } }
					this.logger.info(`[JoinedGroup] `, { payload });
					const joinedData = payload.data;

					// Neste objeto chat dá pra detectar se é comunidade de 2 maneiras:
					// IsParent === true ou LinkedParentJID === ''
					if (joinedData) {
						this._handleGroupParticipantsUpdate({
							JID: joinedData.JID,
							Join: [this.phoneNumber],
							Sender: joinedData.Sender ?? joinedData.OwnerJID, // Quando é adicionado sem ser por link, não vem o Sender/SenderPN
							SenderPN: joinedData.SenderPN ?? joinedData.OwnerPN,
							isBotJoining: true,
							isCommunity: joinedData.IsParent,
							isAnnounce: joinedData.IsAnnounce,
							_raw: joinedData
						});
					}
					break;
				}

				case "PushName": {
					const newPushName = payload.data.Message?.NewPushName ?? payload.data?.Message?.PushName;

					if (newPushName && payload.data?.JID) {
						this.cacheManager.putPushnameInCache({ id: payload.data.JID, pushName: newPushName });
					}
					if (newPushName && payload.data?.JIDAlt) {
						this.cacheManager.putPushnameInCache({
							id: payload.data.JIDAlt,
							pushName: newPushName
						});
					}
					break;
				}
				case "Contact": {
					// Não precisa, mas já que veio, vamo aproveitar
					if (payload.data?.JID && payload.data?.Action) {
						const nomeCtt = payload.data.Action.fullName ?? payload.data.Action.firstName;
						const pushName = payload.data.Action.pushName || nomeCtt;

						this.cacheManager.putPushnameInCache({ id: payload.data.JID, pushName });

						if (payload.data.Action.lidJID) {
							this.cacheManager.putPushnameInCache({
								id: payload.data.Action.lidJID,
								pushName
							});
						}
					}
					break;
				}
				case "QRCode": {
					// Atualiza o cache local com o QRCode mais recente recebido via webhook
					this.isConnected = false;
					const qrData = payload.data;
					if (qrData) {
						const qrCodeBase64 = qrData.qrcode || ""; // data:image/png;base64,...
						const qrCode = qrData.code || "";

						this.connectDataCache = {
							timestamp: Date.now(),
							data: {
								...(this.connectDataCache?.data || {}),
								qrCode: qrCodeBase64,
								code: qrCode
							}
						};

						this.logger.info(
							`[${this.id}] QRCode recebido via webhook (count=${qrData.count}/${qrData.maxCount}). Cache atualizado.`
						);

						// Salva PNG no disco (mesma lógica da rota /instance/qr)
						if (qrCodeBase64) {
							try {
								const qrCodeLocal = path.join(
									this.database.databasePath,
									"qrcodes",
									`qrcode_${this.id}.png`
								);
								const base64Data = qrCodeBase64.replace(/^data:image\/png;base64,/, "");
								fs.mkdirSync(path.dirname(qrCodeLocal), { recursive: true });
								fs.writeFileSync(qrCodeLocal, base64Data, "base64");
							} catch (qrSaveErr) {
								this.logger.warn(`[${this.id}] Falha ao salvar QRCode PNG:`, qrSaveErr);
							}
						}

						// Transmitir atualização via SSE para clientes da página /qrcode/:botId
						this.broadcastQRUpdate({
							type: "qr_update",
							qrCode: qrCodeBase64,
							code: qrCode,
							count: qrData.count,
							maxCount: qrData.maxCount
						});
					}
					break;
				}

				case "QRTimeout": {
					this.connectDataCache = null;
					this.logger.info(`[${this.id}] QR Code expirado (QRTimeout). Cache limpo.`);
					break;
				}

				case "Connected": {
					this.logger.info(
						`[${this.id}] Evento de conexão bem sucedida recebido via webhook (Connected).`
					);
					this._onInstanceConnected();
					break;
				}

				case "Disconnected":
				case "ConnectFailure": {
					const reason = payload.data?.Reason || payload.data?.message || "Desconexão via Webhook";
					this.logger.warn(
						`[${this.id}] Evento de desconexão recebido via webhook (${payload.event}). Razão: ${reason}`
					);
					this._onInstanceDisconnected(reason);
					break;
				}

				case "LoggedOut": {
					this.logger.warn(`[${this.id}] Evento LoggedOut recebido via webhook.`);
					this._onInstanceDisconnected("LoggedOut");
					break;
				}

				case "CallOffer":
				case "CallOfferNotice": {
					const caller = payload.data?.CallCreator || payload.data?.sender || "desconhecido";
					this.logger.info(
						`[${this.id}] Recebida notificação de chamada (${payload.event}) de: ${caller}`
					);
					break;
				}

				case "ChatPresence":
					break;
				case "Receipt":
					break;

				default:
					this.logger.debug(`[_handleWebhook] Unhandled event: '${payload.event}'`, { payload });
					break;
			}
		} catch (error) {
			this.logger.error(`[${this.id}] Error processing webhook for event ${payload.event}:`, {
				error,
				payload
			});
		}
		res.sendStatus(200);
	}

	async fetchAndPrepareBlockedContacts() {
		const blockList = await this.apiClient.get(`/user/blocklist`);
		//blockList: {data: {      DHash: '1761266184514262',JIDs: [...  ]},message: 'success'}

		//this.logger.info(`[${this.id}][fetchAndPrepareBlockedContacts] `, { blockList });
		this.blockedContacts = blockList.data?.JIDs?.map((jid) => ({
			id: { _serialized: jid },
			name: `Blocked_${jid}`
		}));

		this.prepareOtherBotsBlockList(); // From original bot
	}

	prepareOtherBotsBlockList() {
		if (!this.otherBots || !this.otherBots.length) return;
		if (!this.blockedContacts || !Array.isArray(this.blockedContacts)) {
			this.blockedContacts = [];
		}
		for (const bot of this.otherBots) {
			if (!bot || typeof bot !== "string") continue; // skip null/undefined entries
			// Assuming otherBots is an array of JID-like strings or bot IDs
			const botId = bot.endsWith("@c.us") || bot.endsWith("@s.whatsapp.net") ? bot : `${bot}@c.us`; // Basic normalization
			if (!this.blockedContacts.some((c) => c.id._serialized === botId)) {
				this.blockedContacts.push({
					id: { _serialized: botId },
					name: `Other Bot: ${bot}` // Or some identifier
				});
				//this.logger.info(`[${this.id}] Added other bot '${botId}' to internal ignore list.`);
			}
		}

		// Update shared database
		this.database.addBlockedContacts(
			"whatsgo_go",
			this.blockedContacts.map((c) => c.id._serialized)
		);

		// this.logger.info(
		// 	`[${this.id}] Ignored contacts/bots list size: ${this.blockedContacts.length}`
		// );
	}

	async formatMessage(data) {
		// Fallback
		return data;
	}

	async formatMessageFromGo(goMessageData, skipCache = false) {
		try {
			if (!goMessageData) {
				return null;
			}

			//this.logger.debug(`[formatMessageFromGo] `, {goMessageData});
			const info = goMessageData.Info;
			const messageContent = goMessageData.Message;

			if (!info || !messageContent) {
				return null;
			}

			const chatId = info.Chat;
			const isGroup = info.IsGroup || chatId.includes("@g.us") || chatId.includes("broadcast");
			const fromMe = info.IsFromMe;
			const id = info.ID;
			const timestamp = new Date(info.Timestamp).getTime() / 1000;
			let pushName = info.PushName;
			const sender = info.Sender; // geralmente phoneNumber (JID)
			const senderAlt = info.SenderAlt; // geralmente LID

			if (!pushName || pushName?.length < 1) {
				const cacheObj = await this.fetchPushNameFromCache(senderAlt || sender);
				pushName = cacheObj?.pushName ?? cacheObj ?? "Usuario";
			}

			// Context Info (Reply/Mentions)
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

			//this.logger.debug(`[formatMessageFromGo] `, {goMessageData, contextInfo, quotedMessageId});

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
				// Removido download automático para economizar RAM (15+ bots ativos)
				// A mídia será baixada sob demanda via message.downloadMedia()
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
					displayName: messageContent.contactMessage.displayName,
					vcard: messageContent.contactMessage.vcard
				};
			}

			const formattedMessage = {
				goMessageData,
				id,
				fromMe,
				group: isGroup ? chatId : null,
				from: isGroup ? chatId : sender,
				author: this._normalizeId(sender),
				authorAlt: senderAlt,
				name: pushName,
				pushname: pushName,
				authorName: pushName,
				type,
				content,
				body: content,
				caption,
				timestamp,
				responseTime,
				hasMedia: !!mediaInfo,
				mentions,
				quotedParticipant,
				hasQuotedMsg: !!quotedMessageId,
				isQuoted: goMessageData.isQuoted,
				isNewsletter: chatId.includes("newsletter"),

				getContact: async () => await this.getContactDetails(sender, pushName),
				getChat: async () => await this.getChatDetails(chatId),
				delete: async () =>
					this.deleteMessageByKey({
						remoteJid: chatId,
						id,
						fromMe,
						participant: senderAlt
					}),
				downloadMedia: async () => {
					if (mediaInfo) {
						try {
							const downloaded = await this._downloadMediaFromWhatsgo(messageContent);
							if (downloaded) {
								return {
									mimetype: downloaded.mimetype,
									url: downloaded.url,
									data: downloaded.base64,
									filename: downloaded.filename,
									isMessageMedia: true
								};
							}
						} catch (e) {
							this.logger.error(`[downloadMedia] Failed`, e);
						}
					}
					return null;
				}
			};

			formattedMessage.origin = {
				mentionedIds: formattedMessage.mentions,
				id: {
					_serialized: `${chatId}_${fromMe}_${id}`,
					fromMe,
					remote: chatId,
					id,
					_serialized_v3: id
				},
				key: { remoteJid: chatId, fromMe, id },
				author: this._normalizeId(formattedMessage.author),
				from: formattedMessage.from,
				react: (emoji) => this.sendReaction(chatId, id, emoji),
				getContact: formattedMessage.getContact,
				getChat: formattedMessage.getChat,
				getQuotedMessage: async () => {
					this.logger.debug(`[getQuotedMessage] ${quotedMessageId}`);
					if (quotedMessageId) {
						return await this.recoverMsgFromCache(quotedMessageId);
					}
					return null;
				},
				delete: async () =>
					this.deleteMessageByKey({
						remoteJid: chatId,
						id,
						fromMe,
						participant: senderAlt
					}),
				body: content,
				...goMessageData
			};

			if (!skipCache) {
				// Para evitar modificar o objeto original in-place, clonamos goMessageData e origin.
				const cachedMessage = {
					...formattedMessage,
					goMessageData: formattedMessage.goMessageData
						? {
								...formattedMessage.goMessageData,
								groupData: formattedMessage.goMessageData.groupData
									? { ...formattedMessage.goMessageData.groupData }
									: undefined
							}
						: undefined,
					origin: formattedMessage.origin
						? {
								...formattedMessage.origin,
								groupData: formattedMessage.origin.groupData
									? { ...formattedMessage.origin.groupData }
									: undefined
							}
						: undefined
				};

				// Limpa dados pesados antes de salvar no cache para economizar espaço e I/O
				if (cachedMessage.goMessageData?.groupData) {
					delete cachedMessage.goMessageData.groupData.Participants;
					delete cachedMessage.goMessageData.groupData.Topic;
				}
				if (cachedMessage.origin?.groupData) {
					delete cachedMessage.origin.groupData.Participants;
					delete cachedMessage.origin.groupData.Topic;
				}

				this.cacheManager.putGoMessageInCache(cachedMessage);
			}

			return formattedMessage;
		} catch (error) {
			this.logger.error(`[${this.id}] Error formatting message from WhatsgoGO API:`, error);
			return null;
		}
	}

	getActualMsgId(messageId) {
		let actualId = messageId;
		if (
			typeof messageId === "string" &&
			(messageId.includes("_true_") || messageId.includes("_false_"))
		) {
			if (messageId.includes("_true_")) {
				actualId = messageId.split("_true_")[1];
			} else if (messageId.includes("_false_")) {
				actualId = messageId.split("_false_")[1];
			}
		}

		return actualId;
	}

	async sendMessage(chatId, content, options = {}) {
		try {
			if (!this.isConnected) throw new Error("Not connected");
			let isGroup = false;

			const payload = {
				number: chatId,
				delay: options.delay ?? 0
			};

			//this.logger.debug(`[sendMessage] `, { chatId, content, tipo: typeof content, options });
			if (options.quotedMessageId) {
				const msgIdToQuote = this.getActualMsgId(options.quotedMessageId);

				// V3 quoted structure: { messageId, participant }
				// We need to find the participant if it's a group
				let participant = null;

				if (chatId.includes("@g.us")) {
					isGroup = true;
					// Try to find message in cache to get participant
					const quotedMsg = await this.recoverMsgFromCache(msgIdToQuote);
					if (quotedMsg) participant = quotedMsg.author || quotedMsg.from;
				}

				const target = participant ?? chatId; // Fallback
				const participantFmt = target.endsWith("@s.whatsapp.net")
					? target
					: `${target}@s.whatsapp.net`;

				payload.quoted = {
					messageId: msgIdToQuote,
					participant: participantFmt
				};
			}

			let endpoint = "";
			if (typeof content === "object" && content?.data && content?.mimetype) {
				content.isMessageMedia = true;
			}

			if (typeof content === "string") {
				if (this.validURL(content)) {
					// Facilidade pra enviar mídia
					endpoint = "/send/media";
					payload.url = content;
					payload.type = content.endsWith(".gif")
						? "video"
						: (mime.lookup(content.split("?")[0]).split("/")[0] ?? "document");

					// Se sendVideoAsGif estiver ativo e o tipo for vídeo, use "gif" para que a API Go
					// envie com GifPlayback=true (reprodução automática sem controles de vídeo)
					if (options.sendVideoAsGif && payload.type === "video") {
						payload.type = "gif";
					}

					this.logger.debug(`[sendMessage] Content is URL! `, { endpoint, payload });
				} else {
					endpoint = "/send/text";
					payload.text = content;
				}
			} else if (content.isMessageMedia || options.sendMediaAsSticker) {
				if (options.sendMediaAsSticker) {
					endpoint = "/send/sticker";
					if (!content.url && content.data) {
						const media = await this.createMediaFromBase64(
							content.data,
							content.mimetype,
							content.filename
						);
						payload.sticker = media.url;
					} else {
						payload.sticker = content.url ?? content.data;
					}
				} else {
					endpoint = "/send/media";
					payload.url = content.url;
					if (!payload.url && content.data) {
						const media = await this.createMediaFromBase64(
							content.data,
							content.mimetype,
							content.filename
						);
						payload.url = media.url;
						if (options.sendMediaAsSticker) payload.sticker = media.url;
					}

					payload.caption = options.caption;

					let mediaType = content.mimetype ? content.mimetype.split("/")[0] : "image";
					const cttSize = content.size ?? (await this.getFileSizeByURL(content.url)) ?? 0;
					const urlPublica = process.env.BOT_DOMAIN_LOCAL
						? payload.url.replace(process.env.BOT_DOMAIN_LOCAL, process.env.BOT_DOMAIN)
						: payload.url;
					if (options.sendMediaAsDocument || cttSize > 60 * 1024 * 1024) {
						mediaType = "document";
						// Se enviar como doc, manda a nossa URL publica junto também
						payload.caption += `\n\n> Link temporário: ${urlPublica}`;
					}

					// Se sendVideoAsGif estiver ativo e o tipo for vídeo, use "gif" para que a API Go
					// envie com GifPlayback=true (reprodução automática sem controles de vídeo)
					if (options.sendVideoAsGif && mediaType === "video") {
						mediaType = "gif";
					}

					payload.type = mediaType.split("/")[0];
					payload.filename = content.filename;
				}
			} else if (content.isLocation) {
				endpoint = "/send/location";
				payload.latitude = content.latitude;
				payload.longitude = content.longitude;
				payload.name = content.name;
				payload.address = content.address;
			} else if (content.isContact) {
				endpoint = "/send/contact";
				payload.vcard = {
					fullName: content.name,
					phone: content.number
				};
			} else if (content.isPoll) {
				endpoint = "/send/poll";
				payload.question = content.name;
				payload.options = content.pollOptions;
				payload.maxAnswer = content.options.allowMultipleAnswers ? content.pollOptions.length : 1;
			}

			if (options.mentionAll) {
				payload.mentionAll = true;
			} else if (options.mentions) {
				payload.mentionedJid = Array.isArray(options.mentions)
					? options.mentions.join(",")
					: options.mentions;
			}

			//this.logger.debug(`[sendMessage] '${endpoint}'`, { contentType: typeof content, content, payload });

			if (payload.number.includes("newsletter")) {
				this.logger.debug(`[sendMessage][NEWSLETTER] '${endpoint}'`, {
					contentType: typeof content,
					content,
					payload
				});
			}

			const response = await this.apiClient.post(endpoint, payload);
			this.loadReport.trackSentMessage(isGroup);

			return {
				id: { _serialized: response.data?.Info?.ID ?? "unknown" },
				ack: 1,
				timestamp: Math.floor(Date.now() / 1000),
				_data: response,
				getInfo: () =>
					// Usado no StreamSystem pra saber se foi enviada
					({ delivery: [1], played: [1], read: [1] }),
				pin: (tempo) => {
					this.logger.info(
						`[${response?.data?.Info?.ID}] message.pin por ${tempo}ms: Não implementado`
					);
					return true;
				}
			};
		} catch (error) {
			this.logger.error(`[${this.id}] Error sending message:`, error);
			throw error;
		}
	}

	async _handleGroupParticipantsUpdate(groupData) {
		// groupData: { JID, Join: [], Leave: [], Promote: [], Demote: [] }
		//this.logger.debug(`[_handleGroupParticipantsUpdate] `, groupData);
		const groupId = groupData.JID;

		// Helper to process actions
		const processAction = async (groupData, participants, action) => {
			if (!participants || !participants.length) return;

			const groupDetails = await this.getChatDetails(groupId);
			const groupName = groupDetails?.name ?? groupId;

			for (const participant of participants) {
				// participant is JID string
				const contact = await this.getContactDetails(participant);
				const contactResp =
					(await this.getContactDetails(groupData.Sender)) ??
					(await this.getContactDetails(groupData.SenderPN));

				const eventData = {
					group: {
						id: groupId,
						name: groupName,
						notInGroup: groupDetails.notInGroup,
						isBotJoining: groupData.isBotJoining ?? groupDetails.isBotJoining,
						isCommunity: groupData.isCommunity ?? groupData.IsParent ?? groupDetails.isCommunity,
						isAnnounce: groupData.isAnnounce ?? groupData.IsAnnounce ?? groupDetails.isAnnounce
					},
					isCommunity: groupData.isCommunity ?? groupData.IsParent ?? groupDetails.isCommunity,
					isAnnounce: groupData.isAnnounce ?? groupData.IsAnnounce ?? groupDetails.isAnnounce,
					isBotJoining: groupData.isBotJoining ?? groupDetails.isBotJoining,
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

	async listGroups() {
		try {
			const grupos = await this.apiClient.get(`/group/list`);
			//this.logger.debug(`[listGroups][${this.instanceName}]`, { grupos: JSON.stringify(grupos, null, "\t").substring(0,300) });

			return grupos.data;
		} catch (e) {
			this.logger.warn(`[listGroups] Erro listando grupos`, e);
		}
	}

	leaveGroup(groupJid) {
		try {
			this.logger.debug(`[leaveGroup][${this.instanceName}] '${groupJid}'`);
			this.apiClient.post(`/group/leave`, { groupJid });
		} catch (e) {
			this.logger.warn(`[leaveGroup] Erro saindo do grupo '${groupJid}'`, e);
		}
	}

	async removeFromGroup(groupJid, participants) {
		try {
			this.logger.info(
				`[removeFromGroup][${this.instanceName}] Removendo ${participants.length} do grupo ${groupJid}`
			);
			return await this.apiClient.post(`/group/participant`, {
				groupJid,
				action: "remove",
				participants: Array.isArray(participants) ? participants : [participants]
			});
		} catch (e) {
			this.logger.error(
				`[removeFromGroup][${this.instanceName}] Erro ao remover participantes:`,
				e
			);
		}
	}

	async addToGroup(groupJid, participants) {
		try {
			this.logger.info(
				`[addToGroup][${this.instanceName}] Adicionando ${participants.length} ao grupo ${groupJid}`
			);
			return await this.apiClient.post(`/group/participant`, {
				groupJid,
				action: "add",
				participants: Array.isArray(participants) ? participants : [participants]
			});
		} catch (e) {
			this.logger.error(`[addToGroup][${this.instanceName}] Erro ao adicionar participantes:`, e);
		}
	}

	async removeFromCommunity(communityJid, participants) {
		try {
			this.logger.info(
				`[removeFromCommunity][${this.instanceName}] Removendo ${participants.length} da comunidade ${communityJid}`
			);
			// Na Whatsgo, para remover uma PESSOA da comunidade, removemos ela do grupo de anúncios (que tem o JID da comunidade)
			return await this.removeFromGroup(communityJid, participants);
		} catch (e) {
			this.logger.error(
				`[removeFromCommunity][${this.instanceName}] Erro ao remover da comunidade:`,
				e
			);
		}
	}

	logMsgToGrupo(msg, extra = false) {
		if (this.grupoLogs && msg) {
			this.logger.info(`[logMsgToGrupo] ${msg}`, extra);
			this.sendMessage(this.grupoLogs, msg);
		}
	}

	async acceptInviteCode(inviteCode) {
		try {
			this.logger.debug(`[acceptInviteCode][${this.instanceName}] '${inviteCode}'`);
			const resp = await this.apiClient.post(`/group/join`, { code: inviteCode });

			return { accepted: true };
		} catch (e) {
			this.logger.warn(
				`[acceptInviteCode][${this.instanceName}] Erro aceitando invite para '${inviteCode}'`,
				{ e }
			);
			return { accepted: false, error: e.data?.error ?? "Erro aceitando invite" };
		}
	}

	async inviteInfo(inviteCode) {
		try {
			this.logger.debug(`[inviteInfo][${this.instanceName}] '${inviteCode}'`);

			let inviteLink = inviteCode;
			if (!inviteCode.includes("chat.whatsapp.com")) {
				inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
			}

			const response = await this.apiClient.post(`/group/invite-info`, { code: inviteLink });

			// The API returns { data: { ... }, message: "success" }
			// We return the inner data which contains the group info
			return response?.data;
		} catch (e) {
			this.logger.warn(`[inviteInfo] Erro pegando invite info para '${inviteCode}'`, e);
			throw e;
		}
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
				const groupInfoResponse = await this.apiClient.post("/group/info", { groupJid: chatId });
				const groupInfo = groupInfoResponse.data;

				if (groupInfo) {
					// Cache LIDs
					if (groupInfo.Participants) {
						groupInfo.Participants.forEach((p) => {
							if (p.LID)
								this.cacheManager.putContactInCache({ id: { _serialized: p.JID }, lid: p.LID });
							// Check if it's me to store my LID
							if (p.JID.includes(this.phoneNumber)) {
								this.myLid = p.LID;
							}
						});
					}

					return {
						id: { _serialized: groupInfo.JID },
						name: groupInfo.Name ?? chatId,
						isGroup: true,
						isCommunity: groupInfo.IsParent,
						isAnnounce: groupInfo.IsAnnounce,
						linkedParentJid: groupInfo.LinkedParentJID,
						notInGroup: false,
						groupMetadata: { desc: groupInfo.Topic },
						participants: groupInfo.Participants.map((p) => ({
							id: { _serialized: p.JID },
							isAdmin: p.IsAdmin,
							isSuperAdmin: p.IsSuperAdmin,
							phoneNumber: p.PhoneNumber,
							lid: p.LID
						})),
						_raw: groupInfo,

						// Métodos do wwebjs
						setSubject: async (title) =>
							await this.apiClient.post(`/group/name`, { groupJid: chatId, name: title }),
						addParticipants: async (participants) => await this.addToGroup(chatId, participants),
						removeParticipants: async (participants) =>
							await this.removeFromGroup(chatId, participants),
						fetchMessages: async (limit = 30) => false,
						setMessagesAdminsOnly: async (adminOnly) => {
							try {
								const response = await this.apiClient.post(`/group/announce`, {
									groupJid: chatId,
									announce: adminOnly
								});
								return response.data;
							} catch (err) {
								this.logger.error(`[chat] setMessagesAdminsOnly failed:`, err);
								throw err;
							}
						},
						setPicture: async (picture) => {
							this.logger.debug(`[chat] setPicture`, { type: "url", url: picture.url });

							try {
								// Try with URL first
								return await this.apiClient.post(`/group/photo`, {
									groupJid: chatId,
									image: picture.url
								});
							} catch (error) {
								// Fallback to base64 if URL fails
								if (picture.data && picture.mimetype) {
									this.logger.warn(`[chat] setPicture via URL failed, retrying with base64...`);
									const imageData = `data:${picture.mimetype};base64,${picture.data}`;
									return await this.apiClient.post(`/group/photo`, {
										groupJid: chatId,
										image: imageData
									});
								}
								throw error;
							}
						}
					};
				}
			} else {
				const contact = await this.getContactDetails(chatId);
				return {
					id: { _serialized: chatId },
					name: contact?.name ?? chatId,
					isGroup: false
				};
			}
		} catch (e) {
			if (e.status === 500 && e.data?.error === "that group does not exist") {
				this.logger.warn(
					`[getChatDetails] Group ${chatId} does not exist (status 500). Adding to skip list.`
				);
				await this.addSkipGroup(chatId);
				return {
					id: { _serialized: chatId },
					name: chatId,
					isGroup: true,
					notInGroup: true,
					participants: []
				};
			} else {
				const errorDetails = [
					e.message,
					e.data?.error,
					e.response?.data?.error,
					typeof e === "string" ? e : null
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
					this.logger.info(`[getChatDetails] Error fetching ${chatId}, bot não está no grupo`);
					return {
						id: { _serialized: chatId },
						name: chatId,
						isGroup: true,
						notInGroup: true,
						participants: []
					};
				}

				this.logger.error(`[getChatDetails] Error fetching ${chatId}`, e);
			}
		}
		return { id: { _serialized: chatId }, isGroup: chatId.includes("@g.us") };
	}

	async _loadSkipGroupInfo() {
		try {
			this.skipGroupInfo = await SkipGroups.getInstance().getSkippedGroups(this.id);
			//this.logger.info(`[SkipGroups] Loaded ${this.skipGroupInfo.length} skipped groups for bot ${this.id}.`);
		} catch (error) {
			this.logger.error(`[SkipGroups] Error loading skip groups:`, error);
			this.skipGroupInfo = [];
		}
	}

	async _saveSkipGroupInfo() {
		// Deprecated
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
	async fetchPushNameFromCache(id) {
		return await this.cacheManager.getPushnameFromCache(id);
	}

	async getContactDetails(id, prefetchedName, cacheDurationHours = 12) {
		if (!id) return null;

		if (id === this.phoneNumber) {
			return {
				id: { _serialized: id },
				name: this.instanceName,
				number: this.phoneNumber,
				lid: this.phoneNumber,
				picture: ""
			};
		}

		const now = Date.now();
		const expirationMs = cacheDurationHours * 60 * 60 * 1000;

		const jidCom = `${id.split("@")[0]}@s.whatsapp.net`;

		const returnData = {
			id: { _serialized: id },
			number: id.split("@")[0],
			lid: id,
			name: prefetchedName ?? id.split("@")[0],
			block: async () => await this.setCttBlockStatus(id, "block"),
			unblock: async () => await this.setCttBlockStatus(id, "unblock"),
			getCommonGroups: async () => {
				try {
					const response = await this.apiClient.post(`/chat/commonGroups`, { jid: jidCom });
					return response.data || [];
				} catch (e) {
					this.logger.error(`[getCommonGroups] Error fetching common groups for ${jidCom}`, e);
					return [];
				}
			}
		};

		let cacheName;
		try {
			const cacheObj = await this.fetchPushNameFromCache(id);
			cacheName = cacheObj?.pushName ?? cacheObj;
			returnData.name = cacheName ?? returnData.name;
		} catch (e) {
			// Ignore
		}

		try {
			if (!cacheName) {
				// Não tem cache
				let numberToFetch = id;
				if (numberToFetch.includes("@")) {
					numberToFetch = numberToFetch.split("@")[0] + "@s.whatsapp.net";
				}
				const infoResponse = await this.apiClient.post("/user/info", { number: [numberToFetch] });
				const info = infoResponse.data?.Users?.[numberToFetch];
				this.logger.debug(`[getContactDetails]`, { numberToFetch, userInfo: info.data ?? "" });

				if (info) {
					returnData.name = info.VerifiedName ?? returnData.name;
					returnData.lid = info.LID;
					returnData.picture = info.PictureID;

					this.cacheManager.putPushnameInCache({ id, pushName: returnData.name });
					this.cacheManager.putPushnameInCache({ id: numberToFetch, pushName: returnData.name });
				}
			}
		} catch (e) {
			// Ignore
		}

		//this.logger.debug(`[getChatDetails] ${id}, ${prefetchedName}`, { returnData });

		return returnData;
	}

	async sendReaction(chatId, messageId, reaction) {
		try {
			await this.apiClient.post("/message/react", {
				number: chatId,
				reaction,
				id: messageId,
				fromMe: false // Assuming we are reacting to others
			});
			return true;
		} catch (e) {
			this.logger.error(`[sendReaction] Error`, e);
			return false;
		}
	}

	async deleteMessageByKey(key) {
		this.logger.debug(
			`[deleteMessageByKey] ${key.participant} in ${key.remoteJid}, id ${key.id}  `
		);
		return await this.apiClient.post("/message/delete", {
			chat: key.remoteJid,
			messageId: key.id,
			fromMe: key.fromMe ?? true,
			participant: key.participant
		});
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
		// 1. Normalize the list: Get participants regardless of case
		const participants = chat?.Participants || chat?.participants || [];

		// 2. Find the user: Check all potential ID fields for a match
		const found = participants.find(
			(p) =>
				// We check LID, JID (and their lowercase variants), or the serialized ID
				// Using ?. prevents errors if a field doesn't exist
				p.LID?.startsWith(lid) ||
				p.lid?.startsWith(lid) ||
				p.JID?.startsWith(lid) ||
				p.jid?.startsWith(lid) ||
				p.id?._serialized?.startsWith(lid)
		);

		// 3. Return: The normalized PhoneNumber, or fallback to the input lid
		return found ? found.PhoneNumber || found.phoneNumber : lid;
	}

	notInWhitelist(author) {
		// author is expected to be a JID string
		const cleanAuthor = author.replace(/\D/g, ""); // Cleans non-digits from JID user part
		return !this.whitelist.includes(cleanAuthor);
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
		); // fragment locator
		return !!pattern.test(str);
	}

	_sendStartupNotifications() {}
	shouldDiscardMessage() {
		return false;
	}
	getCurrentTimestamp() {
		return Math.round(Date.now() / 1000);
	}
	rndString() {
		return (Math.random() + 1).toString(36).substring(7);
	}

	async updateProfileStatus(status) {
		if (process.env.DISABLE_ACTIVITY === "true") return;
		try {
			this.logger.debug(`[updateProfileStatus][${this.instanceName}] '${status}'`);
			await this.apiClient.post(`/user/profileStatus`, { status });
		} catch (e) {
			this.logger.warn(
				`[updateProfileStatus][${this.instanceName}] Erro definindo status '${status}'`,
				{ erro: e, token: this.whatsgoInstanceApiKey }
			);
		}
	}

	async updateProfilePicture(picture) {
		this.logger.debug(`[updateProfilePicture][${this.instanceName}]`, {
			type: "url",
			url: picture.url
		});
		try {
			// Try with URL first
			return await this.apiClient.post(`/user/photo`, {
				image: picture.url
			});
		} catch (error) {
			// Fallback to base64 if URL fails
			if (picture.data && picture.mimetype) {
				this.logger.warn(`[updateProfilePicture] via URL failed, retrying with base64...`);
				const imageData = `data:${picture.mimetype};base64,${picture.data}`;
				return await this.apiClient.post(`/user/photo`, {
					image: imageData
				});
			}
			throw error;
		}
	}

	async getProfilePictureUrl(number, preview = false) {
		try {
			let jid = number;
			if (!jid.includes("@")) {
				jid = `${jid}@s.whatsapp.net`;
			}
			const response = await this.apiClient.post("/user/avatar", {
				number: jid,
				preview
			});
			if (response?.data?.data?.url) {
				return response.data.data.url;
			}
		} catch (error) {
			this.logger.error(
				`[getProfilePictureUrl] Erro ao buscar foto de perfil para ${number}:`,
				error.message
			);
		}
		return null;
	}

	async getCurrentGroups() {
		const grupos = await this.apiClient.get(`/group/myall`);
		this.logger.debug(`[getCurrentGroups] `, grupos);
		return grupos;
	}

	async setCttBlockStatus(ctt, blockStatus) {
		try {
			this.logger.debug(`[setCttBlockStatus][${this.instanceName}] '${ctt}' => '${blockStatus}'`);

			if (ctt.includes("@")) {
				const suffix = ctt.endsWith("@lid") ? "@lid" : "@s.whatsapp.net";
				ctt = ctt.split("@")[0] + suffix;
			}

			const resp = await this.apiClient.post(`/user/${blockStatus}`, { number: ctt });

			return resp && resp.message === "success";
		} catch (e) {
			this.logger.warn(`[setCttBlockStatus] Erro setando blockStatus ${blockStatus} para '${ctt}'`);
			throw e;
		}
	}

	async createContact(phoneNumber, name, surname) {
		this.logger.warn(
			`[${this.id}] WhatsAppBotGo.createContact is a mock. Fetching real contact instead.`
		);
		const formattedNumber = phoneNumber.endsWith("@s.whatsapp.net")
			? phoneNumber
			: `${phoneNumber.replace(/\D/g, "")}@s.whatsapp.net`;
		return await this.getContactDetails(formattedNumber, `${name} ${surname}`);
	}

	async destroy() {
		if (this.webhookServer) this.webhookServer.close();
		if (this.loadReport) this.loadReport.destroy();
	}
}

module.exports = WhatsAppBotGo;
