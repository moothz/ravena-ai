const { Contact, LocalAuth, MessageMedia, Location, Poll } = require("whatsapp-web.js");
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
const { io } = require("socket.io-client");

const EvolutionApiClient = require("./services/EvolutionApiClient");
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

class WhatsAppBotEvo {
	constructor(options) {
		this.id = options.id;
		this.vip = options.vip;
		this.comunitario = options.comunitario;
		this.numeroResponsavel = options.numeroResponsavel;
		this.supportMsg = options.supportMsg;
		this.phoneNumber = options.phoneNumber;
		this.eventHandler = options.eventHandler;
		this.prefix = options.prefix || process.env.DEFAULT_PREFIX || "!";
		this.logger = new Logger(`bot-evo-${this.id}`);
		this.websocket = options.useWebsocket ?? false;
		this.evolutionWS = options.evolutionWS;
		this.evolutionApiUrl = options.evolutionApiUrl;
		this.evolutionApiKey = options.evolutionApiKey;
		this.instanceName = options.evoInstanceName ?? options.id;
		this.webhookHost = options.webhookHost; // e.g., from cloudflared tunnel
		this.webhookPort = options.webhookPort || process.env.WEBHOOK_PORT_EVO || 3000;
		this.notificarDonate = options.notificarDonate;
		this.pvAI = options.pvAI;
		this.version = "Evolution";
		this.wwebversion = "0";
		this.banido = options.banido;

		// Acesso pelo painel por terceiros
		this.privado = options.privado ?? false;
		this.managementUser = options.managementUser ?? process.env.BOTAPI_USER ?? "admin";
		this.managementPW = options.managementPW ?? process.env.BOTAPI_PASSWORD ?? "batata123";

		// Invite Queue
		this.joinQueue = [];
		this.lastJoinTime = 0;
		this.joinQueueTimer = null;

		this.redisURL = options.redisURL;
		this.redisDB = options.redisDB || 0;
		this.redisTTL = options.redisTTL || 604800;
		this.maxCacheSize = 3000;

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

		if (!this.evolutionApiUrl || !this.evolutionApiKey || !this.instanceName || !this.webhookHost) {
			const errMsg =
				"WhatsAppBotEvo: evolutionApiUrl, evolutionApiKey, instanceName, and webhookHost are required!";
			this.logger.error(errMsg, {
				evolutionApiUrl: !!this.evolutionApiUrl,
				evolutionApiKey: !!this.evolutionApiKey,
				instanceName: !!this.instanceName,
				webhookHost: !!this.webhookHost
			});
			throw new Error(errMsg);
		}

		this.apiClient = new EvolutionApiClient(
			this.evolutionApiUrl,
			this.evolutionApiKey,
			this.instanceName,
			this.logger
		);

		this.database = Database.getInstance();
		this.isConnected = false;
		this.safeMode =
			options.safeMode !== undefined ? options.safeMode : process.env.SAFE_MODE === "true";
		this.otherBots = options.otherBots || [];

		this.ignorePV = options.ignorePV || false;
		this.whitelist = options.whitelistPV || [];
		this.ignoreInvites = options.ignoreInvites || false;
		this.grupoLogs = options.grupoLogs || process.env.GRUPO_LOGS;
		this.grupoInvites = options.grupoInvites || process.env.GRUPO_INVITES;
		this.grupoAvisos = options.grupoAvisos || process.env.GRUPO_AVISOS;
		this.grupoAnuncios = options.grupoAnuncios || process.env.GRUPO_ANUNCIOS;
		this.linkAvisos = options.linkAvisos ?? process.env.LINK_GRUPO_AVISOS;
		this.linkGrupao = options.linkGrupao ?? process.env.LINK_GRUPO_INTERACAO;

		this.userAgent = options.userAgent || process.env.USER_AGENT;

		this.mentionHandler = new MentionHandler();

		this.lastMessageReceived = Date.now();
		this.startupTime = Date.now();

		this.loadReport = new LoadReport(this);
		this.inviteSystem = new InviteSystem(this);
		this.reactionHandler = new ReactionsHandler();

		this.streamSystem = null;
		this.streamMonitor = null;
		this.stabilityMonitor = options.stabilityMonitor ?? false;

		this.llmService = LLMService.getInstance();
		this.adminUtils = AdminUtils.getInstance();

		this.webhookApp = null; // Express app instance
		this.webhookServer = null; // HTTP server instance

		this.blockedContacts = [];

		if (!this.streamSystem) {
			this.streamSystem = StreamSystem.getInstance();
			this.streamSystem.registerBot(this);
			this.streamMonitor = this.streamSystem.streamMonitor;
		}

		// Client Fake
		this.client = {
			getChatById: (arg) => this.getChatDetails(arg),
			getContactById: (arg) => {
				this.logger.debug(`[clientFake][getContactDetails] getContactById`, arg);
				return this.getContactDetails(arg);
			},
			getInviteInfo: (arg) => this.inviteInfo(arg),
			getMessageById: async (messageId) => await this.recoverMsgFromCache(messageId),
			setStatus: (arg) => {
				this.updateProfileStatus(arg);
			},
			leaveGroup: (arg) => {
				this.leaveGroup(arg);
			},
			setProfilePicture: (arg) => {
				this.updateProfilePicture(arg);
			},
			setPrivacySettings: (arg) => {
				this.updatePrivacySettings(arg);
			},
			acceptInvite: (arg) => this.acceptInviteCode(arg),
			sendPresenceUpdate: async (xxx) =>
				// Sem necessidade dessa função
				true,
			info: {
				wid: {
					_serialized: `${options.phoneNumber}`
				}
			}
		};

		this.updateVersions();
		setInterval(this.updateVersions, 3600000);
	}

	async logout() {
		this.logger.info(`[logout] Logging out instance ${this.instanceName}`);
		return await this.apiClient.delete("/instance/logout");
	}

	async deleteInstance() {
		this.logger.info(`[deleteInstance] Deleting instance ${this.instanceName}`);
		return await this.apiClient.delete("/instance/delete");
	}

	async createInstance() {
		this.logger.info(`[createInstance] Creating instance ${this.instanceName}`);
		const payload = {
			instanceName: this.instanceName,
			qrcode: false,
			number: this.phoneNumber,
			integration: "WHATSAPP-BAILEYS",
			rejectCall: true,
			groupsIgnore: false,
			alwaysOnline: false,
			readMessages: false,
			readStatus: false,
			syncFullHistory: false,
			webhook: {
				url: `${process.env.EVO_WEBHOOK_HOST}:${this.webhookPort}/webhook/evo/${this.instanceName}`,
				byEvents: false,
				base64: true,
				events: [
					"MESSAGES_UPSERT",
					"GROUP_PARTICIPANTS_UPDATE",
					"GROUPS_UPSERT",
					"CONNECTION_UPDATE",
					"CONTACTS_UPDATE",
					"SEND_MESSAGE"
				]
			},
			rabbitmq: {
				enabled: false,
				events: []
			},
			sqs: {
				enabled: false,
				events: []
			}
		};

		this.logger.info(`[createInstance] Creating instance ${this.instanceName}`, payload);
		return await this.apiClient.post("/instance/create", payload, {}, true);
	}

	_normalizeId(id, logger) {
		if (typeof id !== "string" || !id) {
			return "";
		}

		// Pega a parte antes do '@', e depois a parte antes do ':'
		const cleanId = id.split("@")[0].split(":")[0];

		// Valida se o ID limpo contém apenas dígitos.
		if (cleanId && !/^\d+$/.test(cleanId)) {
			if (logger && typeof logger.error === "function") {
				logger.error(
					`[isAdmin] ID inválido detectado: "${id}" resultou em "${cleanId}", que contém caracteres não numéricos.`
				);
			}
		}

		return cleanId;
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
			// 1 initial try + 2 retries
			try {
				this.logger.info(`[recreateInstance] Attempting to create instance (try ${i + 1}/3)...`);
				const createResult = await this.createInstance();
				results.push({ action: "create", status: "success", result: createResult });
				this.logger.info(`[recreateInstance] Instance creation successful.`);
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

	async updateVersions() {
		try {
			const response = await this.apiClient.get("", {}, true); // Request pra / sem nome da instancia retorna infos da Evo
			this.version = response.version;
			this.wwebversion = response.whatsappWebVersion;

			this.logger.debug(`[updateVersions] EvoAPI ${this.version}, wweb ${this.wwebversion}`);
		} catch (e) {
			this.logger.error(`[updateVersions] Erro buscando infos da Evo`, e);
		}
	}

	async convertToSquareWebPImage(base64ImageContent) {
		let inputPath = ""; // Will be set to the path of the temporary input file
		let isTempInputFile = false;
		const tempId = randomBytes(16).toString("hex");

		// Use system's temporary directory for better portability
		const tempDirectory = os.tmpdir();
		// Using a generic extension like .tmp as ffmpeg will auto-detect the input format (JPG/PNG)
		const tempInputPath = path.join(tempDirectory, `${tempId}_input.tmp`);
		const tempOutputPath = path.join(tempDirectory, `${tempId}_output.webp`);

		try {
			// Validate and decode base64 input
			if (!base64ImageContent || typeof base64ImageContent !== "string") {
				throw new Error("Invalid base64ImageContent: Must be a non-empty string.");
			}

			//this.logger.info('[toSquareWebPImage] Input is base64. Decoding and saving to temporary file...');
			// Remove potential data URI prefix (e.g., "data:image/png;base64,")
			const base64Data = base64ImageContent.includes(",")
				? base64ImageContent.split(",")[1]
				: base64ImageContent;

			if (!base64Data) {
				throw new Error("Invalid base64ImageContent: Empty data after stripping prefix.");
			}

			const buffer = Buffer.from(base64Data, "base64");
			await writeFileAsync(tempInputPath, buffer);
			inputPath = tempInputPath;
			isTempInputFile = true;
			this.logger.info("[toSquareWebPImage] Base64 input saved to temporary file:", tempInputPath);

			//this.logger.info('[toSquareWebPImage] Starting square WebP image conversion for:', inputPath);

			const targetSize = 512; // Target dimension for the square output

			// ffmpeg filter to:
			// 1. Scale the image to fit within targetSize x targetSize, preserving aspect ratio.
			// 2. Pad the scaled image to targetSize x targetSize, centering it.
			//    The padding color is set to transparent (black@0.0).
			const videoFilter = `scale=${targetSize}:${targetSize}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${targetSize}:${targetSize}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`;

			await new Promise((resolve, reject) => {
				ffmpeg(inputPath)
					.outputOptions([
						"-vf",
						videoFilter, // Apply the scaling and padding filter
						"-c:v",
						"libwebp", // Set the codec to libwebp
						"-lossless",
						"0", // Use lossy compression (0 for lossy, 1 for lossless). Lossy is often preferred for stickers for smaller file size.
						"-q:v",
						"80", // Quality for lossy WebP (0-100). Adjust for balance. Higher is better quality/larger file.
						"-compression_level",
						"6" // Compression effort (0-6). Higher means more compression (smaller size) but slower.
						// No animation-specific options like -loop, fps, etc.
					])
					.toFormat("webp") // Output format
					.on("end", () => {
						this.logger.info("[toSquareWebPImage] Square WebP image conversion finished.");
						resolve();
					})
					.on("error", (err) => {
						let ffmpegCommand = "";
						// fluent-ffmpeg might expose the command it tried to run in err.ffmpegCommand or similar
						if (typeof err.spawnargs !== "undefined") {
							// Check common property for spawn arguments
							ffmpegCommand = `FFmpeg arguments: ${err.spawnargs.join(" ")}`;
						}
						this.logger.error(
							`[toSquareWebPImage] Error during WebP image conversion: ${err.message}. ${ffmpegCommand}`,
							err.stack
						);
						reject(err);
					})
					.save(tempOutputPath);
			});

			this.logger.info(
				"[toSquareWebPImage] Square WebP image saved to temporary file:",
				tempOutputPath
			);

			// Read the generated WebP and convert to base64
			const webpBuffer = await readFileAsync(tempOutputPath);
			const base64WebP = webpBuffer.toString("base64");
			this.logger.info("[toSquareWebPImage] Square WebP image converted to base64.");

			return base64WebP; // Return raw base64 string
		} catch (error) {
			this.logger.error(
				"[toSquareWebPImage] Error in convertToSquareWebPImage function:",
				error.message,
				error.stack
			);
			throw error; // Re-throw the error to be caught by the caller
		} finally {
			// Clean up temporary files
			if (isTempInputFile && fs.existsSync(tempInputPath)) {
				try {
					await unlinkAsync(tempInputPath);
					this.logger.info("[toSquareWebPImage] Temporary input file deleted:", tempInputPath);
				} catch (e) {
					this.logger.error(
						"[toSquareWebPImage] Error deleting temporary input file:",
						tempInputPath,
						e.message
					);
				}
			}
			if (fs.existsSync(tempOutputPath)) {
				// Check existence before unlinking
				try {
					await unlinkAsync(tempOutputPath);
					this.logger.info("[toSquareWebPImage] Temporary output file deleted:", tempOutputPath);
				} catch (e) {
					this.logger.error(
						"[toSquareWebPImage] Error deleting temporary output file:",
						tempOutputPath,
						e.message
					);
				}
			}
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
		fs.mkdirSync(outputDir, { recursive: true });
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

	async recoverMsgFromCache(messageId) {
		try {
			if (!messageId) {
				return null;
			} else {
				const msg = await this.cacheManager.getMessageFromCache(messageId);
				const recovered = await this.formatMessageFromEvo(msg?.evoMessageData); // Pra recriar os métodos
				if (!recovered) {
					this.logger.warn(
						`[recoverMsgFromCache] A msg '${messageId}' do cache não tinha evoMessageData?`,
						msg
					);
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
					contact.block = async () => await this.setCttBlockStatus(contact.number, "block");
					contact.unblock = async () => await this.setCttBlockStatus(contact.number, "unblock");

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
		const wsUrl = `${this.evolutionWS}/${this.instanceName}`;

		const instanceDesc = this.websocket
			? `Websocket to ${wsUrl}`
			: `Webhook on ${this.instanceName}:${this.webhookPort}`;
		this.logger.info(
			`[${this.id}] Initializing Evolution API bot instance ${this.instanceName} (Evo Instance: ${instanceDesc})`,
			{
				grupoLogs: this.grupoLogs,
				grupoInvites: this.grupoInvites,
				grupoAvisos: this.grupoAvisos,
				grupoAnuncios: this.grupoAnuncios,
				grupoInteracao: this.grupoInteracao,
				grupoEstabilidade: this.grupoEstabilidade
			}
		);
		this.database.registerBotInstance(this);
		this.startupTime = Date.now();

		try {
			// 1. Setup Webhook Server OR Websocket connection
			if (this.websocket) {
				this.logger.info(`Usar websocket`);
				const socket = io(wsUrl, {
					transports: ["websocket"]
				});

				socket.on("connect", () => {
					this.logger.info(
						`>>> ${this.id} conectado ao WebSocket '${this.instanceName}' da Evolution API <<<`
					);
				});

				// Escutando eventos
				socket.on("messages.upsert", (data) => this.handleWebsocket(data));

				socket.on("group-participants.update", (data) => {
					this.handleWebsocket(data);
				});

				socket.on("groups.upsert", (data) => {
					this.logger.info("groups.upsert", data);
					this.handleWebsocket(data);
				});

				socket.on("connection.update", (data) => {
					this.logger.info("connection.update", data);

					this.handleWebsocket(data);
				});

				socket.on("send.message", (data) => {
					this.handleWebsocket(data);
				});

				// Lidando com desconexão
				socket.on("disconnect", () => {
					this.logger.info("Desconectado do WebSocket da Evolution API");
				});
			} else {
				this.webhookApp = express();
				this.webhookApp.use(express.json({ limit: "500mb" }));
				this.webhookApp.use(express.urlencoded({ extended: true, limit: "500mb" }));

				const webhookPath = `/webhook/evo/${this.instanceName}`; // Unique path for this bot instance
				this.webhookApp.post(webhookPath, this._handleWebhook.bind(this));
				this.webhookApp.get(webhookPath, this._handleWebhook.bind(this));

				await new Promise((resolve, reject) => {
					this.webhookServer = this.webhookApp
						.listen(this.webhookPort, () => {
							this.logger.info(
								`Webhook listener for bot ${this.instanceName} started on ${this.webhookHost}:${this.webhookPort}${webhookPath}`
							);
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
			}
		} catch (error) {
			this.logger.error(`Error during webhook setup for instance ${this.instanceName}:`, error);
		}

		this.logger.info(
			`[${this.id}] [whitelist] ${this.whitelist.length} números na whitelist do PV.`
		);

		// 4. Check instance status and connect if necessary
		this._checkInstanceStatusAndConnect();

		return this;
	}

	async _checkInstanceStatusAndConnect(isRetry = false, forceConnect = false) {
		this.logger.info(`Checking instance status for ${this.instanceName}...`);
		try {
			/*
      {
        "instance": {
          "instanceName": "teste-docs",
          "state": "open"
        }
      }
      */
			const instanceDetails = await this.apiClient.get(`/instance/connectionState`);
			this.logger.info(
				`Instance ${this.instanceName} state: ${instanceDetails?.instance?.state}`,
				instanceDetails?.instance
			);

			instanceDetails.version = this.version;
			instanceDetails.tipo = "evo";
			const state = (instanceDetails?.instance?.state ?? "error").toUpperCase();
			const extra = {};

			if (state === "CONNECTED" || state === "OPEN") {
				// open não era pra ser
				this._onInstanceConnected();
				extra.ok = true;
				this.isConnected = true;
			} else if (state === "CLOSE" || state === "CONNECTING" || state === "PAIRING" || !state) {
				this.isConnected = false;
				if (forceConnect) {
					this.logger.info(
						`Instance ${this.instanceName} is not connected (state: ${state}). Attempting to connect with num ber ${this.phoneNumber}...`
					);
					const connectData = await this.apiClient.get(`/instance/connect`, {
						number: this.phoneNumber
					});

					this.logger.info(`[${this.id}] Connect Data: ${JSON.stringify(connectData)} `);

					extra.connectData = connectData;
					if (connectData.pairingCode) {
						this.logger.info(
							`[${this.id}] Instance ${this.instanceName} PAIRING CODE: ${connectData.pairingCode}. Enter this on your phone in Linked Devices -> Link with phone number.`
						);
					} else if (connectData.code) {
						this.logger.info(`[${this.id}] QR Code for ${this.instanceName} (Scan with WhatsApp):`);
						qrcode.generate(connectData.code, { small: true });

						const qrCodeLocal = path.join(
							this.database.databasePath,
							"qrcodes",
							`qrcode_${this.id}.png`
						);
						const qr_png = qrimg.image(connectData.code, { type: "png" });
						qr_png.pipe(fs.createWriteStream(qrCodeLocal));
					} else {
						this.logger.warn(
							`[${this.id}] Received connection response for ${this.instanceName}, but no QR/Pairing code found. State: ${connectData?.state}. Waiting for webhook confirmation.`,
							connectData
						);
					}
				} else {
					this.logger.info(`Instance ${this.instanceName} is not connected (state: ${state}).`);
				}
			} else if (state === "TIMEOUT" && !isRetry) {
				this.logger.warn(`Instance ${this.instanceName} timed out. Retrying connection once...`);
				await sleep(5000);
				this._checkInstanceStatusAndConnect(true);
			} else {
				this.logger.error(
					`Instance ${this.instanceName} is in an unhandled state: ${state}. Manual intervention may be required.`
				);
			}

			return { instanceDetails, extra };
		} catch (error) {
			this.logger.error(`Error checking/connecting instance ${this.instanceName}:`, error);
			// Schedule a retry or notify admin?
			return { instanceDetails: {}, error };
		}
	}

	async _onInstanceConnected() {
		this.streamSystem.initialize();
		this.streamMonitor = this.streamSystem.streamMonitor;
		this._sendStartupNotifications();
		this.fetchAndPrepareBlockedContacts();

		if (this.isConnected) return;
		this.isConnected = true;
		this.logger.info(
			`[${this.id}] Successfully connected to WhatsApp via Evolution API for instance ${this.instanceName}.`
		);

		if (this.eventHandler && typeof this.eventHandler.onConnected === "function") {
			this.eventHandler.onConnected(this);
		}
	}

	_onInstanceDisconnected(reason = "Unknown") {
		if (!this.isConnected && reason !== "INITIALIZING") return; // Prevent multiple calls if already disconnected
		const wasConnected = this.isConnected;
		this.isConnected = false;
		this.logger.info(
			`[${this.id}] Disconnected from WhatsApp (Instance: ${this.instanceName}). Reason: ${reason}`
		);

		if (
			this.eventHandler &&
			typeof this.eventHandler.onDisconnected === "function" &&
			wasConnected
		) {
			this.eventHandler.onDisconnected(this, reason);
		}

		setTimeout(() => this._checkInstanceStatusAndConnect(), 30000); // Reconnect after 30s
	}

	async handleWebsocket(data) {
		// Aproveita o método do webhook
		return this._handleWebhook({ websocket: true, body: data }, { sendStatus: () => 0 }, true);
	}

	async _handleWebhook(req, res, socket = false) {
		const payload = req.body;

		if (!payload?.event) {
			return res.status(200).send(`hello-${this.instanceName}-${this.id}`);
		}

		if (this.shouldDiscardMessage() && payload.event === "messages.upsert") {
			// Only discard messages, not connection events
			this.logger.debug(
				`[${this.id}] Discarding webhook message during initial ${this.instanceName} startup period.`
			);
			return res.sendStatus(200);
		}

		try {
			switch (payload.event) {
				// Connect, disconnect...
				case "connection.update": {
					const connectionState = payload.data?.state.toUpperCase();
					this.logger.info(`[${this.id}] Connection update: ${connectionState}`);
					if (connectionState === "CONNECTED") {
						this._onInstanceConnected();
					} else if (
						["CLOSE", "DISCONNECTED", "LOGGED_OUT", "TIMEOUT", "CONFLICT"].includes(connectionState)
					) {
						this._onInstanceDisconnected(connectionState);
					}
					break;
				}

				// Pra saber quando uma mensagem foi enviada com sucesso
				case "send.message": {
					const incomingSentMessageData = Array.isArray(payload.data)
						? payload.data[0]
						: payload.data;
					if (
						incomingSentMessageData &&
						incomingSentMessageData.key &&
						incomingSentMessageData.key.fromMe
					) {
						const incomingSentMessageData = Array.isArray(payload.data)
							? payload.data[0]
							: payload.data;
						incomingSentMessageData.event = "send.message";
						incomingSentMessageData.sender = payload.sender;
						this.formatMessageFromEvo(incomingSentMessageData);
					}

					// Marca msg como enviada, não faço ideia qual os status, não tem no doc
					// talvez venha em outro evento...
					if (incomingSentMessageData.status != "PENDING") {
						this.logger.info(
							`======STATUS====== ${incomingSentMessageData.status} ======STATUS=====`
						);
					}

					if (incomingSentMessageData.status === "DELIVERY_ACK") {
						this.cacheManager.putSentMessageInCache(incomingSentMessageData.key); // Vai ser usado pra ver se a mensagem foi enviada
					}
					break;
				}

				// Principal evento - receber mensagens
				case "messages.upsert": {
					this.lastMessageReceived = Date.now();
					const incomingMessageData = Array.isArray(payload.data) ? payload.data[0] : payload.data;
					if (incomingMessageData && incomingMessageData.key) {
						// Basic filtering (from original bot)
						const chatToFilter = incomingMessageData.key.remoteJid;
						if (
							chatToFilter === this.grupoLogs ||
							chatToFilter === this.grupoAnuncios ||
							chatToFilter === this.grupoInvites ||
							chatToFilter === this.grupoEstabilidade
						) {
							this.logger.debug(`[${this.id}] Ignoring message from system group: ${chatToFilter}`);
							break;
						}

						incomingMessageData.event = "messages.upsert";
						incomingMessageData.sender = payload.sender;
						//this.logger.info(incomingMessageData);
						this.formatMessageFromEvo(incomingMessageData)
							.then((formattedMessage) => {
								if (
									formattedMessage &&
									this.eventHandler &&
									typeof this.eventHandler.onMessage === "function"
								) {
									if (!incomingMessageData.key.fromMe) {
										// Só rodo o onMessage s enão for msg do bot. preciso chamar o formatMessage pra elas serem formatadas e irem pro cache
										this.eventHandler.onMessage(this, formattedMessage);
									}
								}
							})
							.catch((e) => {
								this.logger(
									`[messages.upsert] Erro formatando mensagem`,
									incomingMessageData,
									e,
									"-----"
								);
							});
					}
					break;
				}

				// Bot entrou num grupo (ou criou)
				case "groups.upsert": {
					const groupUpsertData = payload.data[0];
					groupUpsertData.action = "add";
					groupUpsertData.sender = payload.sender;
					groupUpsertData.isBotJoining = true; // Pra saber se não foi o bot add no grupo
					if (
						groupUpsertData &&
						groupUpsertData.id &&
						groupUpsertData.action &&
						groupUpsertData.participants
					) {
						// No wwebjs era tudo no mesmo evento, então eu simulo
						this._handleGroupParticipantsUpdate(groupUpsertData);
					}
					break;
				}

				// Mudou os membros do grupo (entrou/saiu gente)
				case "group-participants.update": {
					const groupUpdateData = payload.data;
					groupUpdateData.isBotJoining = false;
					if (
						groupUpdateData &&
						groupUpdateData.id &&
						groupUpdateData.action &&
						groupUpdateData.participants
					) {
						this._handleGroupParticipantsUpdate(groupUpdateData);
					}
					break;
				}

				case "contacts.update":
					if (Array.isArray(payload.data)) {
						for (const cttData of payload.data) {
							if (cttData.pushname || cttData.pushName) {
								// Atualiza só se veio o nome, se não não tem sentido
								this.updateContact(cttData);
							}
						}
					}
					break;

				//default:
				//this.logger.debug(`[${this.id}] Unhandled webhook event: ${payload.event}`);
			}
		} catch (error) {
			this.logger.error(`[${this.id}] Error processing webhook for event ${payload.event}:`, error);
		}
		res.sendStatus(200);
	}

	async formatMessage(data) {
		// Fallback
		return data;
	}

	numeroMaisProvavel(numeros) {
		const validSenders = Array.isArray(numeros) ? numeros.filter(Boolean) : [];
		const priorityOrder = ["@s.whatsapp.net", "@c.us", "@lid"];

		for (const suffix of priorityOrder) {
			const foundSender = validSenders.find(
				(sender) => typeof sender === "string" && sender.endsWith(suffix)
			);

			if (foundSender) {
				return foundSender;
			}
		}

		return null;
	}

	formatMessageFromEvo(evoMessageData, skipCache = false) {
		return new Promise(async (resolve, reject) => {
			try {
				const key = evoMessageData?.key;
				const waMessage = evoMessageData?.message; // The actual message content part
				if (!key || !waMessage) {
					this.logger.warn(
						`[${this.id}] Incomplete Evolution message data for formatting:`,
						evoMessageData
					);
					resolve(null);
					return;
				} else {
					const chatId = key.remoteJid;
					const isGroup = chatId.endsWith("@g.us");
					let isSentMessage = false;

					let author = this.numeroMaisProvavel([
						evoMessageData.author,
						key.remoteJidAlt,
						key.remoteJid,
						key.participantAlt
					]);
					if (author) {
						author = author.replace("@s.whatsapp.net", "@c.us");
					}

					const authorAlt = key.remoteJidAlt ?? key.remoteJid ?? key.participantAlt;

					const messageTimestamp =
						typeof evoMessageData.messageTimestamp === "number"
							? evoMessageData.messageTimestamp
							: typeof evoMessageData.messageTimestamp === "string"
								? parseInt(evoMessageData.messageTimestamp, 10)
								: Math.floor(Date.now() / 1000);
					const responseTime = Math.max(0, this.getCurrentTimestamp() - messageTimestamp);

					if (evoMessageData.event === "send.message") {
						isSentMessage = true;
					} else {
						// send.message é evento de enviadas, então se não for, recebeu uma
						this.loadReport.trackReceivedMessage(isGroup, responseTime, chatId);
					}

					let type = "unknown";
					let content = null;
					let caption = null;
					let mediaInfo = null; // To store { url, mimetype, filename, data (base64 if downloaded) }

					// Determine message type and content
					if (waMessage.conversation) {
						type = "text";
						content = waMessage.conversation;
					} else if (waMessage.extendedTextMessage) {
						type = "text";
						content = waMessage.extendedTextMessage.text;
					} else if (waMessage.imageMessage) {
						type = "image";
						caption = waMessage.imageMessage.caption;
						mediaInfo = {
							isMessageMedia: true,
							mimetype: waMessage.imageMessage.mimetype || "image/jpeg",
							url: waMessage.imageMessage.url,
							filename:
								waMessage.imageMessage.fileName ||
								`image-${key.id}.${mime.extension(waMessage.imageMessage.mimetype || "image/jpeg") || "jpg"}`,
							_evoMediaDetails: waMessage.imageMessage
						};
						content = mediaInfo;
					} else if (waMessage.videoMessage) {
						type = "video";
						caption = waMessage.videoMessage.caption;
						mediaInfo = {
							isMessageMedia: true,
							mimetype: waMessage.videoMessage.mimetype || "video/mp4",
							url: waMessage.videoMessage.url,
							filename:
								waMessage.videoMessage.fileName ||
								`video-${key.id}.${mime.extension(waMessage.videoMessage.mimetype || "video/mp4") || "mp4"}`,
							seconds: waMessage.videoMessage.seconds,
							_evoMediaDetails: waMessage.videoMessage
						};
						content = mediaInfo;
					} else if (waMessage.audioMessage) {
						type = waMessage.audioMessage.ptt ? "ptt" : "audio";
						mediaInfo = {
							isMessageMedia: true,
							mimetype:
								waMessage.audioMessage.mimetype ||
								(waMessage.audioMessage.ptt ? "audio/ogg" : "audio/mpeg"),
							url: waMessage.audioMessage.url,
							filename: `audio-${key.id}.${mime.extension(waMessage.audioMessage.mimetype || (waMessage.audioMessage.ptt ? "audio/ogg" : "audio/mpeg")) || (waMessage.audioMessage.ptt ? "ogg" : "mp3")}`,
							seconds: waMessage.audioMessage.seconds,
							ptt: waMessage.audioMessage.ptt,
							_evoMediaDetails: waMessage.audioMessage
						};
						content = mediaInfo;
					} else if (waMessage.documentMessage) {
						type = "document";
						caption = waMessage.documentMessage.title || waMessage.documentMessage.fileName;
						mediaInfo = {
							isMessageMedia: true,
							mimetype: waMessage.documentMessage.mimetype || "application/octet-stream",
							url: waMessage.documentMessage.url,
							filename:
								waMessage.documentMessage.fileName ||
								`document-${key.id}${waMessage.documentMessage.mimetype ? "." + (mime.extension(waMessage.documentMessage.mimetype) || "") : ""}`.replace(
									/\.$/,
									""
								),
							title: waMessage.documentMessage.title,
							_evoMediaDetails: waMessage.documentMessage
						};
						content = mediaInfo;
					} else if (waMessage.stickerMessage) {
						type = "sticker";
						mediaInfo = {
							isMessageMedia: true,
							isAnimated: waMessage.stickerMessage.isAnimated ?? false,
							mimetype: waMessage.stickerMessage.mimetype || "image/webp",
							url: waMessage.stickerMessage.url,
							filename: `sticker-${key.id}.webp`,
							_evoMediaDetails: waMessage.stickerMessage
						};
						content = mediaInfo;
					} else if (waMessage.locationMessage) {
						type = "location";
						content = {
							isLocation: true,
							latitude: waMessage.locationMessage.degreesLatitude,
							longitude: waMessage.locationMessage.degreesLongitude,
							name: waMessage.locationMessage.name,
							address: waMessage.locationMessage.address,
							description: waMessage.locationMessage.name || waMessage.locationMessage.address,
							jpegThumbnail: waMessage.locationMessage.jpegThumbnail
						};
					} else if (waMessage.contactMessage) {
						type = "contact";
						content = {
							isContact: true,
							displayName: waMessage.contactMessage.displayName,
							vcard: waMessage.contactMessage.vcard,
							_evoContactDetails: waMessage.contactMessage
						};
					} else if (waMessage.contactsArrayMessage) {
						type = "contacts_array";
						content = {
							displayName: waMessage.contactsArrayMessage.displayName,
							contacts: waMessage.contactsArrayMessage.contacts.map((contact) => ({
								isContact: true,
								displayName: contact.displayName,
								vcard: contact.vcard
							})),
							_evoContactsArrayDetails: waMessage.contactsArrayMessage
						};
					} else if (waMessage.reactionMessage && evoMessageData.event === "messages.upsert") {
						// Pra evitar pegar coisa do send.message
						const reactionData = waMessage.reactionMessage;
						if (reactionData && reactionData.key && !reactionData.key.fromMe) {
							if (reactionData.text !== "") {
								//this.logger.debug(`[${this.id}] Received reaction:`, reactionData);
								this.reactionHandler.processReaction(this, {
									// await is used here
									reaction: reactionData.text,
									senderId: reactionData.key?.participant
										? reactionData.key.participant.split("@")[0] + "@c.us"
										: waMessage.sender, // waMessage.sender vem no send.message event
									msgId: { _serialized: reactionData.key.id }
								});
							}
						}
						resolve(null);
						return;
					} else {
						/*
            if(!isSentMessage){
              this.logger.warn(`[${this.id}] Unhandled Evolution message type:`, Object.keys(waMessage).join(', '));
              this.logger.warn(`[${this.id}][ev-${evoMessageData.event}] Unhandled Evolution message type:`, waMessage);
            }*/
						resolve(null);
						return;
					}

					const mentions = evoMessageData.contextInfo?.mentionedJid ?? [];

					let authorName = evoMessageData.pushname ?? evoMessageData.pushName; // Me explica pq pode vir dos 2 jeito?
					if (!authorName) {
						const authorContact = await this.getContactDetails(author);
						this.logger.info(`[formatMessageFromEvo] Nao veio autor na msg, buscando contato`, {
							authorContact
						});
						authorName = authorContact.pushname ?? "Pessoa";
					}

					const formattedMessage = {
						evoMessageData, // pra ser recuperada no cache
						id: key.id,
						fromMe: evoMessageData.key.fromMe,
						group: isGroup ? chatId : null,
						from: isGroup ? chatId : author,
						author: this._normalizeId(author),
						authorAlt,
						name: authorName,
						authorName,
						pushname: authorName,
						type,
						content,
						body: content,
						mentions,
						caption,
						origin: {},
						responseTime,
						timestamp: messageTimestamp,
						key,
						secret: evoMessageData.message?.messageContextInfo?.messageSecret,
						hasMedia: mediaInfo && (mediaInfo.url || mediaInfo._evoMediaDetails),
						isNewsletter: chatId.includes("newsletter"),

						getContact: async () => {
							const contactIdToFetch = isGroup ? key.participant || author : author;
							return await this.getContactDetails(author, authorName);
						},

						getChat: async () => await this.getChatDetails(chatId),
						delete: async (forEveryone = true) => this.deleteMessageByKey(evoMessageData.key),
						downloadMedia: async (opts = {}) => {
							if (mediaInfo && (mediaInfo.url || mediaInfo._evoMediaDetails)) {
								const downloadedMedia = await this._downloadMediaAsBase64(
									mediaInfo,
									key,
									evoMessageData
								);
								let stickerGif = false;
								if (mediaInfo.isAnimated) {
									stickerGif = await this.convertAnimatedWebpToGif(
										downloadedMedia,
										opts.keep ?? false
									);
									this.logger.debug(`[downloadMedia] isAnimated, gif salvo: '${stickerGif}'`);
								}
								return {
									mimetype: mediaInfo.mimetype,
									data: downloadedMedia,
									stickerGif,
									filename: mediaInfo.filename,
									source: "file",
									isMessageMedia: true
								};
							}
							this.logger.warn(
								`[${this.id}] downloadMedia called for non-media or unfulfillable message:`,
								type,
								mediaInfo
							);
							return null;
						}
					};

					if (["image", "video", "sticker"].includes(type)) {
						try {
							const media = await formattedMessage.downloadMedia(); // await is used here
							if (media) {
								formattedMessage.content = media;
							}
						} catch (dlError) {
							this.logger.error(
								`[${this.id}] Failed to pre-download media for NSFW check:`,
								dlError
							);
						}
					}

					formattedMessage.origin = {
						mentionedIds: formattedMessage.mentions,
						id: {
							_serialized: `${evoMessageData.key.remoteJid}_${evoMessageData.key.fromMe}_${evoMessageData.key.id}`
						},
						author: this._normalizeId(formattedMessage.author),
						from: formattedMessage.from,
						react: (emoji) =>
							this.sendReaction(evoMessageData.key.remoteJid, evoMessageData.key.id, emoji),
						getContact: formattedMessage.getContact,
						getChat: formattedMessage.getChat,
						getQuotedMessage: async () => {
							const quotedMsgId = evoMessageData.contextInfo?.quotedMessage
								? evoMessageData.contextInfo?.stanzaId
								: null;
							return await this.recoverMsgFromCache(quotedMsgId);
						},
						delete: async () => this.deleteMessageByKey(evoMessageData.key),
						body: content,
						...evoMessageData
					};

					if (!skipCache) {
						this.cacheManager.putMessageInCache(formattedMessage);
					}
					resolve(formattedMessage); // Resolve with the formatted message
				}
			} catch (error) {
				this.logger.error(
					`[${this.id}] Error formatting message from Evolution API:`,
					error,
					evoMessageData
				);
				resolve(null);
			}
		});
	}

	shortJson(json, max = 30) {
		return JSON.stringify(json, null, "\t").substring(0, max);
	}

	async _downloadMediaAsBase64(mediaInfo, messageKey, evoMessageData) {
		if (!messageKey || !messageKey.id || !messageKey.remoteJid) {
			this.logger.error(
				`[${this.id}] Crucial messageKey information (id, remoteJid) is missing. Cannot use /chat/getBase64FromMediaMessage.`
			);
		}

		if (
			messageKey &&
			messageKey.id &&
			messageKey.remoteJid &&
			this.evolutionApiUrl &&
			this.evolutionApiKey &&
			this.instanceName
		) {
			try {
				const endpoint = `${this.evolutionApiUrl}/chat/getBase64FromMediaMessage/${this.instanceName}`;
				const payload = { message: evoMessageData };
				if (evoMessageData.videoMessage) {
					payload.convertToMp4 = true;
				}

				if (messageKey.participant) {
					payload.participant = messageKey.participant;
				}

				const response = await axios.post(endpoint, payload, {
					headers: {
						apikey: this.evolutionApiKey,
						"Content-Type": "application/json" // Explicitly set Content-Type for POST
					}
				});

				// Process the response (same logic as before):
				if (response.data) {
					if (typeof response.data === "string" && response.data.length > 100) {
						this.logger.info(`[${this.id}] Media: ${mediaInfo.filename}`);
						return response.data;
					} else if (response.data.base64 && typeof response.data.base64 === "string") {
						this.logger.info(`[${this.id}] Media: ${mediaInfo.filename}`);
						writeFileAsync("teste.webp", Buffer.from(response.data.base64, "base64"));
						return response.data.base64;
					} else {
						this.logger.warn(
							`[${this.id}] Evolution API /chat/getBase64FromMediaMessage did not return expected base64 data for ${mediaInfo.filename}. Response data:`,
							response.data
						);
					}
				} else {
					this.logger.warn(
						`[${this.id}] No data received from Evolution API /chat/getBase64FromMediaMessage for ${mediaInfo.filename}`
					);
				}
			} catch (apiError) {
				let errorMessage = apiError.message;
				if (apiError.response) {
					errorMessage = `Status: ${apiError.response.status}, Data: ${JSON.stringify(apiError.response.data)}`;
				}
				this.logger.error(
					`[${this.id}] Error downloading media via Evolution API POST /chat/getBase64FromMediaMessage for ${mediaInfo.filename}: ${errorMessage}`
				);
			}
		} else {
			this.logger.info(
				`[${this.id}] Skipping Evolution API POST /chat/getBase64FromMediaMessage download for ${mediaInfo.filename} due to missing messageKey or API configuration.`
			);
		}

		this.logger.warn(
			`[${this.id}] Failed to download media for ${mediaInfo.filename} using all available methods.`
		);
		return null;
	}

	async sendMessage(chatId, content, options = {}) {
		this.logger.debug(
			`[${this.id}] sendMessage to ${chatId} (Type: ${typeof content} / ${JSON.stringify(options).substring(0, 300)})`
		); // , {content: typeof content === 'string' ? content.substring(0,30) : content, options}
		try {
			if (this.safeMode) {
				this.logger.info(
					`[${this.id}] [SAFE MODE] Would send to ${chatId}: ${typeof content === "string" ? content.substring(0, 70) + "..." : "[Media/Object]"}`
				);
				return { id: { _serialized: `safe-mode-msg-${this.rndString()}` }, ack: 0, body: content }; // Mimic wwebjs
			}

			if (!this.isConnected) {
				this.logger.warn(
					`[${this.id}] Attempted to send message while disconnected from ${this.instanceName}.`
				);
				throw new Error("Not connected to WhatsApp via Evolution API");
			}

			// Variáveis padrões do payload
			const evoPayload = {
				number: chatId,
				delay: options.delay || 0, //Math.floor(Math.random() * (1500 - 300 + 1)) + 300
				linkPreview: options.linkPreview ?? false
			};

			if (options.evoReply) {
				evoPayload.quoted = options.evoReply;
			}

			// Ou marca todos com a API do EVO ou menciona manual alguns
			if (options.marcarTodos) {
				evoPayload.mentionEveryOne = true;
			} else {
				if (options.mentions && options.mentions.length > 0) {
					evoPayload.mentioned = options.mentions; //.map(s => s.split('@')[0]);
				}
			}

			if (options.quotedMsgId) {
				// quotedMessageId: message.origin.id._serialized
				// Esse id serialized é xxx_xxx_key.id
				const mentionedKey = options.quotedMsgId.split("_")[2];
				if (mentionedKey) {
					evoPayload.quoted = { key: { id: mentionedKey } };
				} else {
					this.logger.info(`[sendMessage] quotedMsgId: ${options.quotedMsgId}, não tem key?`);
				}
			}

			// Se tiver URL, usa ela, se não, default pra conteudo em base64
			// Para base64 na EvoAPI: Não usar o formato completo, apenas os dados `data:${content.mimetype};base64,${content.data}`
			let formattedContent =
				content.url && content.url?.length > 10 ? content.url : (content.data ?? content);

			// Cada tipo de mensagem tem um endpoint diferente
			let endpoint = null;
			if (typeof content === "string" && !options.sendMediaAsSticker) {
				// sticker pode vir URL, que é string
				endpoint = "/message/sendText";
				evoPayload.text = content;
				evoPayload.presence = "composing";
			} else if (
				content instanceof MessageMedia ||
				content.isMessageMedia ||
				options.sendMediaAsSticker
			) {
				endpoint = "/message/sendMedia";
				this.logger.debug(
					`[sendMessage] ${endpoint} (${content.mimetype ?? "?mimetype?"} / ${JSON.stringify(options).substring(0, 150)})`
				);

				let mediaType = "image";

				if (content.mimetype) {
					if (content.mimetype.includes("image")) mediaType = "image";
					else if (content.mimetype.includes("mp4")) mediaType = "video";
					else if (content.mimetype.includes("audio") || content.mimetype.includes("ogg"))
						mediaType = "audio";
				}

				const cttSize = content.size ?? (await this.getFileSizeByURL(content.url)) ?? 0;
				if (options.sendMediaAsDocument || cttSize > 60 * 1024 * 1024) {
					mediaType = "document";
					evoPayload.fileName =
						content.filename || `media.${mime.extension(content.mimetype) || "bin"}`;
				}

				if (options.sendMediaAsSticker) {
					this.logger.debug(
						`[sendMessage] sendMediaAsSticker: ${formattedContent.substring(0, 150)}`
					);
					if (!formattedContent.startsWith("http")) {
						if (mediaType == "video" || mediaType == "gif") {
							// Converter pra aceitar sticker animado
							formattedContent = await this.convertToSquareAnimatedGif(formattedContent);
						} else {
							// Essa lib estica as imagens de stickers, mas quero preservar como era antes
							formattedContent = await this.convertToSquarePNGImage(formattedContent);
						}
					}

					endpoint = "/message/sendSticker";
					evoPayload.sticker = formattedContent;
					this.logger.debug(
						`[sendMessage] ${endpoint}: ${JSON.stringify(evoPayload).substring(0, 150)}}`
					);
				}

				if (options.sendAudioAsVoice || mediaType === "audio") {
					endpoint = "/message/sendWhatsAppAudio";
					evoPayload.presence = "recording";

					if (options.sendAudioAsVoice) {
						// Converter para ogg/opus antes
						evoPayload.audio = await toOpus(formattedContent, { returnAsURL: true });
					} else {
						if (evoPayload?.media?.startsWith("http")) {
							evoPayload.audio = evoPayload.media;
						} else {
							evoPayload.audio = await toMp3(formattedContent, { returnAsURL: true });
						}
					}
				}

				if (options.sendVideoAsGif && mediaType === "video") {
					formattedContent = await this.convertToSquareAnimatedGif(formattedContent);
					mediaType = "image"; // GIF precisa ser enviado como imagem
				}

				if (options.isViewOnce) evoPayload.viewOnce = true;

				if (options.caption && options.caption.length > 0) {
					evoPayload.caption = options.caption;
				}

				evoPayload.mediatype = mediaType;

				if (!evoPayload.sticker && !evoPayload.audio) {
					// sticker e audio no endpoint não usam o 'media'
					evoPayload.media = formattedContent;
				}
			} else if (content instanceof Location || content.isLocation) {
				endpoint = "/message/sendLocation";
				this.logger.debug(`[sendMessage] ${endpoint}`);

				evoPayload.latitude = content.latitude;
				evoPayload.longitude = content.longitude;
				evoPayload.name = content.description || content.name || "Localização";
			} else if (content instanceof Contact || content.isContact) {
				endpoint = "/message/sendContact";
				this.logger.debug(`[sendMessage] ${endpoint}`);

				evoPayload.contact = [
					{
						fullName: content.name ?? content.pushname,
						wuid: content.number,
						phoneNumber: content.number
					}
				];
			} else if (content instanceof Poll || content.isPoll) {
				endpoint = "/message/sendPoll";
				this.logger.debug(`[sendMessage] ${endpoint}`);

				evoPayload.name = content.name;
				evoPayload.selectableCount = content.options.allowMultipleAnswers
					? content.pollOptions.length
					: 1;
				evoPayload.values = content.pollOptions;
			} else {
				this.logger.error(
					`[${this.id}] sendMessage: Unhandled content type for Evolution API. Content:`,
					content
				);
				return;
			}

			const response = await this.apiClient.post(endpoint, evoPayload);

			const isGroup = chatId.endsWith("@g.us");
			this.loadReport.trackSentMessage(isGroup);

			// Simular o Message do whatsapp-web.js
			return {
				id: {
					_serialized: response.key?.id || `evo-msg-${this.rndString()}`,
					remote: response.key?.remoteJid || chatId,
					fromMe: true, // Sent by us
					participant: response.key?.participant // if sent to group, bot is participant
				},
				ack: this._mapEvoStatusToAck(response.status),
				body:
					typeof content === "string"
						? content
						: `[${evoPayload.mediaMessage?.mediaType || "media"}]`,
				type:
					typeof content === "string" ? "text" : evoPayload.mediaMessage?.mediaType || "unknown",
				timestamp: Math.floor(Date.now() / 1000),
				from: this.phoneNumber ? `${this.phoneNumber.replace(/\D/g, "")}@c.us` : this.instanceName,
				to: chatId,
				url: content && content.url ? content.url : undefined,
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
			this.logger.error(
				`[${this.id}] Error sending message to ${chatId} via Evolution API:`,
				error
			);
			throw error;
		}
	}

	_mapEvoStatusToAck(status) {
		if (!status) return 0; // Undefined or pending
		status = status.toUpperCase();
		if (status === "SENT" || status === "DELIVERED_TO_SERVER") return 1; // Message sent to server
		if (status === "DELIVERED_TO_USER" || status === "DELIVERED") return 2; // Delivered to recipient
		if (status === "READ" || status === "SEEN") return 3; // Read by recipient
		if (status === "ERROR" || status === "FAILED") return -1;
		return 0;
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

	async sendReturnMessages(returnMessages) {
		if (!Array.isArray(returnMessages)) {
			returnMessages = [returnMessages];
		}
		const validMessages = returnMessages.filter((msg) => msg && msg.isValid && msg.isValid());
		if (validMessages.length === 0) {
			this.logger.warn(`[${this.id}] Sem ReturnMessages válidas pra enviar.`);
			return [];
		}
		const results = [];
		for (const message of validMessages) {
			if (message.delay > 0) {
				await sleep(message.delay);
			}

			const contentToSend = message.content;
			const options = { ...(message.options || {}) }; // Clone options

			try {
				const result = await this.sendMessage(message.chatId, contentToSend, options);
				results.push(result);

				if (message.reaction && result && result.id?._serialized) {
					try {
						await this.sendReaction(message.chatId, result.id._serialized, message.reaction); // Assuming result.id has the ID
					} catch (reactError) {
						this.logger.error(
							`[${this.id}] Erro enviando reaction "${message.reaction}" pra ${result.id._serialized}:`,
							reactError
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

	async updateContact(contactData) {
		//this.logger.debug(`[updateContact] `, {contactData});
		const contato = {
			isContact: false,
			id: { _serialized: contactData.remoteJid },
			name: contactData.pushName,
			pushname: contactData.pushName,
			number: contactData.remoteJid,
			picture: contactData.profilePicUrl,
			isUser: true,
			status: contactData.status, // Não vem no webhook
			isBusiness: contactData.isBusiness, // Não vem no webhook
			block: async () => await this.setCttBlockStatus(contactData.phoneNumber, "block"),
			unblock: async () => await this.setCttBlockStatus(contactData.phoneNumber, "unblock")
		};

		this.cacheManager.putContactInCache(contato);
	}

	async createMedia(filePath, customMime = false) {
		try {
			if (!fs.existsSync(filePath)) {
				throw new Error(`File not found: ${filePath}`);
			}
			const stats = fs.statSync(filePath);
			const size = stats.size;

			const outputDir = path.join(__dirname, "..", "public", "attachments");
			await fs.mkdirSync(outputDir, { recursive: true });

			const extension = path.extname(filePath); // e.g., '.mp4'
			const tempId = randomBytes(8).toString("hex");
			const outputFileName = `${tempId}${extension}`;
			const outputFilePath = path.join(outputDir, outputFileName);

			await fs.copyFileSync(filePath, outputFilePath);

			setTimeout(
				(ofp, ofn) => {
					fs.unlinkSync(ofp);
				},
				10 * 60 * 1000,
				outputFilePath,
				outputFileName
			); // 10 minutes in milliseconds

			const data = fs.readFileSync(filePath, { encoding: "base64" });
			const filename = path.basename(filePath);
			const mimetype = customMime
				? customMime
				: mime.lookup(filePath) || "application/octet-stream";
			const fileUrl = `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/attachments/${outputFileName}`;

			this.logger.info(`[createMedia] ${fileUrl}`);
			return { mimetype, data, filename, source: "file", url: fileUrl, isMessageMedia: true, size };
		} catch (error) {
			console.error(`Error creating media from ${filePath}:`, error);
			throw error;
		}
	}

	async createMediaFromBase64(base64, mimetype, filename) {
		try {
			const data = base64.includes(",") ? base64.split(",")[1] : base64;
			const buffer = Buffer.from(data, "base64");
			const size = buffer.length;

			const outputDir = path.join(__dirname, "..", "public", "attachments");
			await fs.mkdirSync(outputDir, { recursive: true });
			const extension = mime.extension(mimetype) || "bin";
			const tempId = randomBytes(8).toString("hex");
			const outputFileName = filename
				? `${path.basename(filename, path.extname(filename))}-${tempId}.${extension}`
				: `${tempId}.${extension}`;
			const outputFilePath = path.join(outputDir, outputFileName);

			await writeFileAsync(outputFilePath, buffer);

			setTimeout(
				() => {
					fs.unlink(outputFilePath, () => {});
				},
				10 * 60 * 1000
			); // 10 minutes

			const fileUrl = `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/attachments/${outputFileName}`;

			this.logger.info(`[createMediaFromBase64] ${fileUrl}`);
			return {
				mimetype,
				data,
				filename: outputFileName,
				source: "base64",
				url: fileUrl,
				isMessageMedia: true,
				size
			};
		} catch (error) {
			console.error(`Error creating media from base64:`, error);
			throw error;
		}
	}

	async createMediaFromURL(url, options = { unsafeMime: true, customMime: false }) {
		try {
			const filename = path.basename(new URL(url).pathname) || "media_from_url";
			let mimetype =
				mime.lookup(url.split("?")[0]) || (options.unsafeMime ? "application/octet-stream" : null);
			const size = await this.getFileSizeByURL(url);

			if (!mimetype && options.unsafeMime) {
				try {
					const headResponse = await axios.head(url);
					this.logger.info("mimetype do header? ", headResponse);
					mimetype = options.customMime
						? options.customMime
						: headResponse.headers["content-type"]?.split(";")[0] || "application/octet-stream";
				} catch (e) {
					/* ignore */
				}
			}
			return { url, mimetype, filename, source: "url", isMessageMedia: true, size }; // MessageMedia compatible for URL sending
		} catch (error) {
			this.logger.error(`[${this.id}] Evo: Error creating media from URL ${url}:`, error);
			throw error;
		}
	}

	async getContactDetails(cid, prefetchedName = false, forceCacheRefresh = false) {
		if (!cid) return null;

		try {
			let contato;
			const contactId = (typeof cid === "object" ? cid.id : cid) ?? null;

			const number = contactId; //.split("@")[0];
			contato = forceCacheRefresh ? false : await this.recoverContactFromCache(number);

			if (!contato) {
				const profileData = await this.apiClient.post(`/chat/fetchProfile`, { number });
				if (profileData) {
					contato = {
						isContact: false,
						id: { _serialized: contactId },
						name: profileData.name ?? prefetchedName,
						pushname: profileData.name ?? prefetchedName,
						number,
						isUser: true,
						status: profileData.status,
						isBusiness: profileData.isBusiness,
						picture: profileData.picture,
						block: async () => await this.setCttBlockStatus(number, "block"),
						unblock: async () => await this.setCttBlockStatus(number, "unblock")
					};

					this.cacheManager.putContactInCache(contato);
					return contato;
				} else {
					this.logger.debug(
						`[getContactDetails][${this.id}] Não consegui pegar os dados para '${contactId}'`
					);
					contato = {
						isContact: false,
						id: { _serialized: contactId },
						name: `Pessoa Misteriosa`,
						pushname: `Pessoa Misteriosa`,
						number: contactId.split("@")[0],
						isUser: true,
						status: "",
						isBusiness: false,
						picture: ""
					};
				}
			}
			return contato;
		} catch (error) {
			this.logger.error(`[${this.id}] Failed to get contact ${cid ?? "semCid"} details.`); //, error
			return {
				id: { _serialized: cid },
				name: cid,
				pushname: cid,
				number: cid,
				isUser: true,
				_isPartial: true
			}; // Basic fallback
		}
	}

	async setCttBlockStatus(ctt, blockStatus) {
		try {
			this.logger.debug(`[setCttBlockStatus][${this.instanceName}] '${ctt}' => '${blockStatus}'`);
			const resp = await this.apiClient.post(`/chat/updateBlockStatus`, {
				number: ctt,
				status: blockStatus
			});

			return resp.accepted;
		} catch (e) {
			this.logger.warn(`[setCttBlockStatus] Erro setando blockStatus ${blockStatus} para '${ctt}'`);
			throw e;
		}
	}

	acceptInviteCode(inviteCode) {
		return new Promise((resolve, reject) => {
			try {
				this.logger.debug(
					`[acceptInviteCode][${this.instanceName}] Adicionando à fila: '${inviteCode}'`
				);

				// Add to queue
				this.joinQueue.push({ code: inviteCode, resolve, reject, timestamp: Date.now() });

				// Process queue
				this._processJoinQueue();
			} catch (e) {
				this.logger.warn(
					`[acceptInviteCode][${this.instanceName}] Erro ao adicionar invite para '${inviteCode}'`,
					{ e }
				);
				resolve({ accepted: false, error: "Erro interno ao processar invite" });
			}
		});
	}

	async _processJoinQueue() {
		if (this.joinQueue.length === 0) return;
		if (this.joinQueueTimer) return; // Already scheduled

		const now = Date.now();
		const fifteenMinutes = 15 * 60 * 1000;
		const timeSinceLastJoin = now - this.lastJoinTime;

		if (timeSinceLastJoin >= fifteenMinutes) {
			// Can join now
			const item = this.joinQueue.shift();
			try {
				this.logger.info(
					`[acceptInviteCode][${this.instanceName}] Processando invite: '${item.code}'`
				);
				const resp = await this.apiClient.get(`/group/acceptInviteCode`, { inviteCode: item.code });

				this.lastJoinTime = Date.now(); // Update last join time
				item.resolve({ accepted: resp.accepted });
			} catch (e) {
				this.logger.warn(
					`[acceptInviteCode][${this.instanceName}] Erro na API para '${item.code}'`,
					{ e }
				);
				// Even on error, we might want to respect rate limits or retry?
				// For now, treat as 'attempted join' to avoid ban, or maybe shorter cooldown?
				// Let's stick to strict 15min to be safe
				this.lastJoinTime = Date.now();
				item.resolve({ accepted: false, error: "Não foi possível aceitar (Erro API)" });
			}

			// Schedule next check if queue not empty
			if (this.joinQueue.length > 0) {
				this._scheduleNextJoin();
			}
		} else {
			// Must wait
			this._scheduleNextJoin(fifteenMinutes - timeSinceLastJoin);
		}
	}

	_scheduleNextJoin(minDelay = 0) {
		if (this.joinQueueTimer) clearTimeout(this.joinQueueTimer);

		// Random delay between 10 and 20 minutes (plus minimum required wait)
		const randomDelay = Math.floor(Math.random() * (20 - 10 + 1) + 10) * 60 * 1000;
		// We need to wait at least minDelay, but we add the random factor to it/or instead of it?
		// "O tempo até o próximo join deve ser randomizado de 10 a 20 minutos"
		// So after a join, we wait 10-20 mins.

		// If we just joined, minDelay is 0 (relative to 15min check), but we want 10-20 from NOW.
		// If we are waiting for the 15min cooldown, minDelay is the remaining time.
		// The requirement says "impedindo que o bot aceite mais de 1 convite em menos 15 minutos" AND "O tempo até o próximo join deve ser randomizado de 10 a 20 minutos".
		// This effectively means interval = max(15min, random(10,20)min)? Or just random(10,20) min where 10 < 15 is issue?
		// Let's assume minimum is 15 minutes for safety, so randomized 15-25 mins?
		// Or maybe the randomization is the *interval* check.

		// Let's interpret: "Randomized 10 to 20 minutes" implies 10 is acceptable? But "impedindo... em menos de 15 minutos".
		// So if random is 10, we violate the 15min rule.
		// I will use 15 mins as hard floor, and add random(0, 10) mins to it. Total 15-25 mins.

		// Calculate wait time
		const waitTime = Math.max(minDelay, 15 * 60 * 1000); // Wait at least 15 mins from last join

		// Add randomization (e.g. 0 to 10 mins extra) to make it look natural?
		// "randomizado de 10 a 20 minutos" -> I'll stick to 15-25 to satisfy the "15 min constraint" safely.
		// Or if the requirement "10 to 20" overrides "15 min", then 10 is fine?
		// "impedindo que o bot aceite mais de 1 convite em menos 15 minutos" is a constraint.
		// So 10 is invalid.
		// Maybe "verificar se existem joins pendentes a cada x minutos" refers to polling?

		// Implementation: Always wait at least 15 mins. Add random jitter.
		const jitter = Math.floor(Math.random() * 5 * 60 * 1000); // 0-5 mins
		const totalDelay = waitTime + jitter;

		const eta = new Date(Date.now() + totalDelay);
		this.logger.info(`[InviteQueue] Próximo processamento agendado para: ${eta.toLocaleString()}`);

		// If there are pending items, notify the next one about the delay?
		// The command handling in InviteSystem expects a response.
		// We can't really notify asynchronously easily here without changing InviteSystem architecture.
		// But we can resolve the current promise with a "Queued" status if it's going to take long.

		// Currently `acceptInviteCode` awaits this promise. If we delay resolution for 15 mins, the HTTP request (if applicable) or user interaction might timeout.
		// Strategy: If queue has items, resolve them immediately with "Queued" status, but keep them in queue for processing.

		this.joinQueue.forEach((item) => {
			if (!item.notified) {
				item.resolve({ accepted: true, queued: true, eta: eta.getTime() });
				item.notified = true;
			}
		});

		this.joinQueueTimer = setTimeout(() => {
			this.joinQueueTimer = null;
			this._processJoinQueue();
		}, totalDelay);
	}

	async inviteInfo(inviteCode) {
		try {
			this.logger.debug(`[inviteInfo][${this.instanceName}] '${inviteCode}'`);
			const inviteInfo = await this.apiClient.get(`/group/inviteInfo`, { inviteCode });
			this.logger.info(`[inviteInfo] '${inviteCode}': ${JSON.stringify(inviteInfo)}`);

			return inviteInfo;
		} catch (e) {
			this.logger.warn(`[inviteInfo] Erro pegando invite info para '${inviteCode}'`);
			throw e;
		}
	}

	leaveGroup(groupJid) {
		try {
			this.logger.debug(`[leaveGroup][${this.instanceName}] '${groupJid}'`);
			this.apiClient.delete(`/group/leaveGroup`, { groupJid });
		} catch (e) {
			this.logger.warn(`[leaveGroup] Erro saindo do grupo '${groupJid}'`, e);
		}
	}

	updatePrivacySettings(privacy) {
		try {
			// Tudo é obrigatório, se não a Evo reclama
			privacy = {
				readreceipts: privacy?.readreceipts ?? "all", // all, none
				profile: privacy?.profile ?? "all", // all, contacts, contact_blacklist, none
				status: privacy?.status ?? "all", // all, contacts, contact_blacklist, none
				online: privacy?.online ?? "all", // all, match_last_seen
				last: privacy?.last ?? "all", // all, contacts, contact_blacklist, none
				groupadd: privacy?.groupadd ?? "contact_blacklist" // all, contacts, contact_blacklist
			};

			this.logger.debug(`[updatePrivacySettings][${this.instanceName}] `, { privacy });
			this.apiClient.post(`/chat/updatePrivacySettings`, { ...privacy });
		} catch (e) {
			this.logger.warn(`[updatePrivacySettings] Erro alterando configs de privacidade`, e);
		}
	}

	updateProfilePicture(url) {
		try {
			this.logger.debug(`[updateProfilePicture][${this.instanceName}] '${url}'`);
			this.apiClient.post(`/chat/updateProfilePicture`, { picture: url });
		} catch (e) {
			this.logger.warn(`[updateProfilePicture] Erro trocando imagem '${url}'`, e);
		}
	}

	updateProfileStatus(status) {
		try {
			this.logger.debug(`[updateProfileStatus][${this.instanceName}] '${status}'`);
			this.apiClient.post(`/chat/updateProfileStatus`, { status });
		} catch (e) {
			this.logger.warn(`[updateProfileStatus] Erro definindo status '${status}'`, status);
		}
	}

	// evo 2.3.5 agora tem o phoneNumber
	getLidFromPn(pn, chat) {
		return chat?.participants?.find((p) => p.phoneNumber?.startsWith(pn))?.id?._serialized ?? pn;
	}
	getPnFromLid(lid, chat) {
		return chat?.participants?.find((p) => p.id?._serialized.startsWith(lid))?.phoneNumber ?? lid;
	}

	async getChatDetails(chatId) {
		if (!chatId) return null;
		let chat;

		if (this.skipGroupInfo && this.skipGroupInfo.includes(chatId)) {
			this.logger.info(
				`[getChatDetails] Skipping fetch for ${chatId} as it is in skipGroupInfo list.`
			);
			return {
				id: { _serialized: chatId },
				name: chatId,
				isGroup: true,
				notInGroup: true,
				participants: [],
				_isPartial: true
			};
		}

		try {
			this.logger.debug(`[${this.id}] Fetching chat details for: ${chatId}`);
			if (chatId.endsWith("@g.us")) {
				const groupData = await this.apiClient.get(`/group/findGroupInfos`, { groupJid: chatId });

				chat = {
					setSubject: async (title) =>
						await this.apiClient.post(`/group/updateGroupSubject`, {
							groupJid: chatId,
							subject: title
						}),
					fetchMessages: async (limit = 30) =>
						// Não rola
						//https://doc.evolution-api.com/v2/api-reference/chat-controller/find-messages
						false,
					setMessagesAdminsOnly: async (adminOnly) => {
						if (adminOnly) {
							return await this.apiClient.post(`/group/updateSetting`, {
								groupJid: chatId,
								action: "announcement"
							});
						} else {
							return await this.apiClient.post(`/group/updateSetting`, {
								groupJid: chatId,
								action: "not_announcement"
							});
						}
					},
					setPicture: (picture) => {
						this.logger.debug(`[chat] setPicture, não implementado`, { picture });
					},
					id: { _serialized: groupData.id || chatId },
					name: groupData.subject,
					isGroup: true,
					participants: groupData.participants.map((p) => ({
						id: { _serialized: p.id },
						phoneNumber: p.phoneNumber ?? null,
						isAdmin: p.admin?.includes("admin") ?? false
					})),
					_rawEvoGroup: groupData
				};
			} else {
				// User chat
				this.logger.debug(`[getChatDetails][getContactDetails] getContact`, chatId);
				const contact = await this.getContactDetails(chatId);
				chat = {
					isContact: true,
					id: { _serialized: chatId },
					name: contact.name || contact.pushname,
					isGroup: false,
					_rawEvoContactForChat: contact
				};
			}

			//this.logger.debug(`[getChatDetails] Grupo '${chatId}' buscando, colocando no cache`, {chat});
			this.cacheManager.putChatInCache(chat);
			return chat;
		} catch (error) {
			if (
				error.status === 404 &&
				(error.response?.message?.includes("item-not-found") ||
					error.response?.message?.includes("Error: forbidden"))
			) {
				this.logger.warn(
					`[getChatDetails] Group ${chatId} does not exist (status 404). Adding to skip list.`
				);
				await this.addSkipGroup(chatId);
				return {
					id: { _serialized: chatId },
					name: chatId,
					isGroup: true,
					notInGroup: true,
					participants: [],
					_isPartial: true
				};
			} else {
				this.logger.error(`[getChatDetails] Failed to get chat details for ${chatId}:`, error);
				return {
					id: { _serialized: chatId },
					name: chatId,
					isGroup: chatId.endsWith("@g.us"),
					_isPartial: true
				};
			}
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

	async deleteMessageByKey(key) {
		if (!key) {
			this.logger.error(`[${this.id}] Invalid messageKey for deletion. ${key}`);
			return false;
		}

		this.logger.info(
			`[${this.id}][deleteMessage] Requesting deletion of message ${JSON.stringify(key)}`
		);
		try {
			return this.apiClient.delete("/chat/deleteMessageForEveryone", { ...key });
		} catch (error) {
			this.logger.error(
				`[${this.id}][deleteMessage] Failed to delete message ${JSON.stringify(key)}:`,
				error
			);
			return false;
		}
	}

	async sendReaction(chatId, messageId, reaction) {
		// reaction can be an emoji string e.g. "👍" or "" to remove

		// Sanitizar a string pra quela tenha só um emoji e apenas isso mais nada e nada mais
		reaction = (reaction.match(/(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/gu) || [])[0] || "";
		if (!this.isConnected) {
			this.logger.warn(`[${this.id}] Cannot send reaction, not connected.`);
			return;
		}
		this.logger.debug(`[${this.id}] Sending reaction '${reaction}' in chat ${chatId}`);
		try {
			const payload = {
				key: { remoteJid: chatId, id: messageId, fromMe: false },
				reaction
			};
			await this.apiClient.post(`/message/sendReaction`, payload);
			return true;
		} catch (error) {
			this.logger.error(`[${this.id}] Failed to send reaction '${reaction}':`, error);
			return false;
		}
	}

	async _handleGroupParticipantsUpdate(groupUpdateData) {
		//this.logger.info("[_handleGroupParticipantsUpdate] ", {groupUpdateData});

		const groupId = groupUpdateData.id;
		const action = groupUpdateData.action;
		const participants = groupUpdateData.isBotJoining
			? [{ id: `${this.phoneNumber}@s.whatsapp.net`, admin: null }]
			: groupUpdateData.participants; // Array of JIDs

		try {
			let groupName;
			let groupDetails;
			if (groupUpdateData.subject) {
				groupName = groupUpdateData.subject;
			} else {
				groupDetails = await this.getChatDetails(groupId);
				groupName = groupDetails?.name || groupId;
			}

			let gUpdAuthor;
			if (groupUpdateData.author) {
				gUpdAuthor =
					typeof groupUpdateData.author === "object"
						? groupUpdateData.author?.id
						: groupUpdateData.author;
			} else {
				gUpdAuthor = groupUpdateData.owner ?? "123456789@c.us";
			}

			//this.logger.debug(`[_handleGroupParticipantsUpdate][getContactDetails] responsibleContact`, {gUpdAuthor, groupUpdateData});
			const responsibleContact = (await this.getContactDetails(gUpdAuthor)) ?? {
				id: gUpdAuthor.split("@")[0] + "@c.us",
				name: "Admin do Grupo"
			};

			for (const uid of participants) {
				// Dispara 1x para cada participant add
				const userId = typeof uid === "object" ? uid.id : uid;
				//this.logger.debug(`[_handleGroupParticipantsUpdate][getContactDetails] userContact`, userId);
				const userContact = await this.getContactDetails(userId);

				let responsavelNumero = responsibleContact.id?._serialized;

				if (groupDetails) {
					responsavelNumero = this.getPnFromLid(responsavelNumero, groupDetails);
				}

				const eventData = {
					group: { id: groupId, name: groupName },
					//user: { id: userId.split('@')[0]+"@c.us", name: userContact?.name || userId.split('@')[0] },
					user: { id: userId, name: userContact?.name || userId.split("@")[0] },
					responsavel: { id: responsavelNumero, name: responsibleContact.name || "Sistema" },
					origin: {
						...groupUpdateData, // Raw data from webhook related to this specific update
						getChat: async () => await this.getChatDetails(groupId)
					}
				};

				if (action === "add") {
					if (this.eventHandler && typeof this.eventHandler.onGroupJoin === "function") {
						this.eventHandler.onGroupJoin(this, eventData);
					}
				} else if (action === "remove" || action === "leave") {
					// 'leave' might be self-leave
					if (this.eventHandler && typeof this.eventHandler.onGroupLeave === "function") {
						this.eventHandler.onGroupLeave(this, eventData);
					}
				}
			}
		} catch (error) {
			this.logger.error(
				`[${this.id}] Error processing group participant update:`,
				error,
				groupUpdateData
			);
		}
	}

	async isUserAdminInGroup(userId, groupId) {
		return this.adminUtils.isAdmin(userId, { id: groupId }, null, this);
	}

	async fetchAndPrepareBlockedContacts() {
		// Evolution API does not list a direct "get all blocked contacts" endpoint in the provided link.
		// It has /contacts/blockUnblock. This functionality might be limited or require different handling.
		this.blockedContacts = []; // Reset
		this.logger.info(
			`[${this.id}] Blocked contacts list management needs verification with Evolution API capabilities.`
		);

		this.prepareOtherBotsBlockList(); // From original bot
	}

	async _sendStartupNotifications() {
		if (!this.isConnected) return;
		if (this.grupoLogs) {
			try {
				await this.sendMessage(
					this.grupoLogs,
					`🤖 Bot ${this.id} (Evo) inicializado com sucesso em ${new Date().toLocaleString("pt-BR")}`
				);
			} catch (error) {
				this.logger.error(`[${this.id}] Error sending startup notification to grupoLogs:`, error);
			}
		}
		if (this.grupoAvisos) {
			try {
				// await this.sendMessage(this.grupoAvisos, `🟢 [${this.phoneNumber.slice(2,4)}] *${this.id}* (Evo) tá _on_! (${new Date().toLocaleString("pt-BR")})`);
			} catch (error) {
				this.logger.error(`[${this.id}] Error sending startup notification to grupoAvisos:`, error);
			}
		}
	}

	// --- Utility methods from original bot that should largely remain compatible ---
	notInWhitelist(author) {
		// author is expected to be a JID string
		const cleanAuthor = author.replace(/\D/g, ""); // Cleans non-digits from JID user part
		return !this.whitelist.includes(cleanAuthor);
	}

	rndString() {
		return (Math.random() + 1).toString(36).substring(7);
	}

	prepareOtherBotsBlockList() {
		if (!this.otherBots || !this.otherBots.length) return;
		if (!this.blockedContacts || !Array.isArray(this.blockedContacts)) {
			this.blockedContacts = [];
		}
		for (const bot of this.otherBots) {
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
			"evo",
			this.blockedContacts.map((c) => c.id._serialized)
		);

		this.logger.info(
			`[${this.id}] Ignored contacts/bots list size: ${this.blockedContacts.length}`
		);
	}

	shouldDiscardMessage() {
		const timeSinceStartup = Date.now() - this.startupTime;
		return timeSinceStartup < (parseInt(process.env.DISCARD_MSG_STARTUP_SECONDS) || 5) * 1000; // 5 seconds default
	}

	getCurrentTimestamp() {
		return Math.round(Date.now() / 1000);
	}

	async destroy() {
		this.logger.info(
			`[${this.id}] Destroying Evolution API bot instance ${this.id} (Evo Instance: ${this.instanceName})`
		);
		if (this.webhookServer) {
			this.webhookServer.close(() => this.logger.info(`[${this.id}] Webhook server closed.`));
		}

		this._onInstanceDisconnected("DESTROYED"); // Mark as disconnected internally
		try {
			//await this.apiClient.post(`/instance/logout`); // Logout the instance
			//this.logger.info(`[${this.id}] Instance ${this.instanceName} logout requested.`);
		} catch (error) {
			this.logger.error(`[${this.id}] Error logging out instance ${this.instanceName}:`, error);
		}
		if (this.loadReport) this.loadReport.destroy();
	}

	async restartBot(reason = "Restart requested") {
		this.logger.info(`[restartBot] EvoAPI restart instance ${this.instanceName}`);
		return await this.apiClient.post("/instance/restart");
	}

	async createContact(phoneNumber, name, surname) {
		this.logger.warn(
			`[${this.id}] WhatsAppBotEvo.createContact is a mock. Fetching real contact instead.`
		);
		const formattedNumber = phoneNumber.endsWith("@c.us")
			? phoneNumber
			: `${phoneNumber.replace(/\D/g, "")}@c.us`;
		return await this.getContactDetails(formattedNumber, `${name} ${surname}`);
	}
}

module.exports = WhatsAppBotEvo;
