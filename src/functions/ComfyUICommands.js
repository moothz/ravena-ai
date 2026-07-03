const path = require("path");
const axios = require("axios");
const fs = require("fs").promises;
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const sharp = require("sharp");
const Logger = require("../utils/Logger");
const NSFWPredict = require("../utils/NSFWPredict");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const { translateText } = require("./TranslationCommands");
const Database = require("../utils/Database");
const database = Database.getInstance();

const logger = new Logger("comfyui-commands");
const nsfwPredict = NSFWPredict.getInstance();
const LLMService = require("../services/LLMService");
const ServiceProviderService = require("../services/ServiceProviderService");
const serviceProviderService = ServiceProviderService.getInstance();

// Initialize Media Stats Database
database.getSQLiteDb(
	"media_stats",
	`
    CREATE TABLE IF NOT EXISTS comfy_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        resolution TEXT,
        count INTEGER DEFAULT 1,
        model TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_comfy_ts ON comfy_stats(timestamp);
`
);

/**
 * Tracks ComfyUI usage stats
 * @param {string} resolution - Image resolution (e.g., "1024x1024")
 * @param {number} count - Number of images generated
 * @param {string} model - Model used
 */
async function trackComfyStats(resolution, count = 1, model = "unknown") {
	try {
		await database.dbRun(
			"media_stats",
			`INSERT INTO comfy_stats (timestamp, resolution, count, model) VALUES (?, ?, ?, ?)`,
			[Date.now(), resolution, count, model]
		);
	} catch (e) {
		logger.error("Error tracking comfy stats:", e);
	}
}

const samplers = ["dpmpp_sde", "euler_ancestral", "res_multistep"];
const schedulers = ["simple", "beta"]; // ddim_uniform

function getComfyUIUrl() {
	const providers = serviceProviderService.getProviders("comfyui");
	let url = providers[0]?.url || "http://127.0.0.1:8188";
	if (!url.match(/^https?:\/\//)) {
		url = "http://" + url;
	}
	return url;
}

const aesthetic = "\n\n(Aesthetic: Gothic, lightly purple-ish tinted atmosphere, cartoony)";

function getWsUrl() {
	const url = getComfyUIUrl();
	const urlObj = new URL(url);
	const httpProtocol = urlObj.protocol; // 'http:' or 'https:'
	const wsProtocol = httpProtocol === "https:" ? "wss:" : "ws:";
	const host = urlObj.host;

	const httpBaseUrl = `${httpProtocol}//${host}`;
	const wsUrl = `${wsProtocol}//${host}/ws`;
	return { httpBaseUrl, wsUrl };
}

const clientId = uuidv4();
let ws = null;
const pendingRequests = new Map();

function connectWebSocket() {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

	const { wsUrl } = getWsUrl();
	logger.info(`Connecting to ComfyUI WebSocket at ${wsUrl}...`);
	try {
		ws = new WebSocket(`${wsUrl}?clientId=${clientId}`);
	} catch (e) {
		logger.error("Failed to create WebSocket:", e);
		return;
	}

	ws.on("open", () => {
		logger.info("ComfyUI WebSocket connected");
	});

	ws.on("message", (data) => {
		try {
			const messageStr = data.toString();
			// Handle multiple JSON objects potentially separated by newlines
			const messages = messageStr
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch (e) {
						return null;
					}
				})
				.filter(Boolean);

			for (const message of messages) {
				if (message.type === "executed") {
					const promptId = message.data.prompt_id;
					if (pendingRequests.has(promptId)) {
						handleExecutionSuccess(promptId);
					}
				} else if (message.type === "execution_error") {
					const promptId = message.data.prompt_id;
					if (pendingRequests.has(promptId)) {
						const { reject } = pendingRequests.get(promptId);
						pendingRequests.delete(promptId);
						reject(new Error(`ComfyUI Execution Error: ${JSON.stringify(message.data)}`));
					}
				}
			}
		} catch (err) {
			logger.error("Error parsing WebSocket message", err);
		}
	});

	ws.on("close", () => {
		logger.warn("ComfyUI WebSocket closed. Reconnecting in 60s...");
		ws = null;
		setTimeout(connectWebSocket, 60000);
	});

	ws.on("error", (err) => {
		logger.error("ComfyUI WebSocket error:", err);
	});
}

// Initialize connection
// connectWebSocket();

async function handleExecutionSuccess(promptId) {
	const request = pendingRequests.get(promptId);
	if (!request) return;

	const { resolve, reject } = request;
	pendingRequests.delete(promptId);

	try {
		const { httpBaseUrl } = getWsUrl();
		const historyResponse = await axios.get(`${httpBaseUrl}/history/${promptId}`);
		const history = historyResponse.data[promptId];

		// Output node ID from the template
		const outputNodeId = "9";

		if (!history.outputs || !history.outputs[outputNodeId]) {
			throw new Error("No output found in history for node " + outputNodeId);
		}

		const images = history.outputs[outputNodeId].images;
		if (!images || images.length === 0) {
			throw new Error("No images generated.");
		}

		// Fetch the first image
		const image = images[0];
		const imageResponse = await axios.get(`${httpBaseUrl}/view`, {
			params: {
				filename: image.filename,
				subfolder: image.subfolder,
				type: image.type
			},
			responseType: "arraybuffer"
		});

		resolve(Buffer.from(imageResponse.data));
	} catch (error) {
		reject(error);
	}
}

async function queuePrompt(promptText, sampler = "dpmpp_sde", scheduler = "beta") {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		// Attempt immediate reconnect/wait if not open
		if (!ws || ws.readyState === WebSocket.CLOSED) connectWebSocket();

		// Wait up to 5 seconds for connection
		let attempts = 0;
		while ((!ws || ws.readyState !== WebSocket.OPEN) && attempts < 50) {
			await new Promise((r) => setTimeout(r, 100));
			attempts++;
		}

		if (!ws || ws.readyState !== WebSocket.OPEN) {
			throw new Error("Could not connect to ComfyUI WebSocket.");
		}
	}

	const apiPrompt = {
		3: {
			class_type: "KSampler",
			inputs: {
				model: ["11", 0],
				positive: ["27", 0],
				negative: ["33", 0],
				latent_image: ["13", 0],
				seed: Math.floor(Math.random() * 999999999999999),
				steps: 8,
				cfg: 1,
				sampler_name: sampler,
				scheduler,
				denoise: 1
			}
		},
		8: {
			class_type: "VAEDecode",
			inputs: {
				samples: ["3", 0],
				vae: ["29", 0]
			}
		},
		9: {
			class_type: "PreviewImage",
			inputs: {
				images: ["8", 0]
			}
		},
		11: {
			class_type: "ModelSamplingAuraFlow",
			inputs: {
				model: ["28", 0],
				shift: 3
			}
		},
		13: {
			class_type: "EmptySD3LatentImage",
			inputs: {
				width: 1024,
				height: 1024,
				batch_size: 1
			}
		},
		27: {
			class_type: "CLIPTextEncode",
			inputs: {
				text: promptText,
				clip: ["30", 0]
			}
		},
		28: {
			class_type: "UNETLoader",
			inputs: {
				unet_name: "z_image_turbo_bf16.safetensors",
				weight_dtype: "default"
			}
		},
		29: {
			class_type: "VAELoader",
			inputs: {
				vae_name: "ae.safetensors"
			}
		},
		30: {
			class_type: "CLIPLoader",
			inputs: {
				clip_name: "qwen_3_4b.safetensors",
				stop_at_clip_layer: -1,
				clip_skip: 0,
				type: "lumina2",
				backend: "default"
			}
		},
		33: {
			class_type: "ConditioningZeroOut",
			inputs: {
				conditioning: ["27", 0]
			}
		}
	};

	const { httpBaseUrl } = getWsUrl();
	const response = await axios.post(`${httpBaseUrl}/prompt`, {
		prompt: apiPrompt,
		client_id: clientId
	});

	const promptId = response.data.prompt_id;

	return new Promise((resolve, reject) => {
		pendingRequests.set(promptId, { resolve, reject });

		// Timeout after 3 minutes
		setTimeout(() => {
			if (pendingRequests.has(promptId)) {
				pendingRequests.delete(promptId);
				reject(new Error("Generation timed out"));
			}
		}, 180000);
	});
}

/**
 * Tenta obter um prompt refinado a partir de uma imagem + modificações do usuário.
 * Faz duas chamadas LLM:
 *   1. Descreve a imagem detalhadamente
 *   2. Reescreve a descrição aplicando as modificações solicitadas pelo usuário
 * Retorna null silenciosamente em caso de falha.
 * @param {Object} message - Dados da mensagem
 * @param {Object} llmSvc - Instância do LLMService
 * @param {string} userPrompt - Modificações desejadas pelo usuário
 * @returns {Promise<string|null>}
 */
async function getImageDescriptionForPrompt(message, llmSvc, userPrompt) {
	try {
		let imageData = null;

		// Caso 1: mensagem atual é uma imagem com caption contendo o comando
		if (message.type === "image") {
			if (message.content?.data) {
				imageData = message.content.data;
			} else if (typeof message.downloadMedia === "function") {
				const media = await message.downloadMedia().catch(() => null);
				imageData = media?.data ?? null;
			}
		}

		// Caso 2: mensagem de texto com imagem quoted
		if (!imageData && message.hasQuotedMsg) {
			const quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
			if (quotedMsg && quotedMsg.type === "image") {
				const media = await quotedMsg.downloadMedia().catch(() => null);
				imageData = media?.data ?? null;
			}
		}

		if (!imageData) return null;

		// 1ª chamada: descreve a imagem detalhadamente
		logger.info("[getImageDescriptionForPrompt] 1ª chamada LLM: descrevendo imagem");
		const description = await llmSvc.getCompletion({
			prompt:
				"Analyze this image and provide a detailed description for use as an image generation prompt. Include: art style (realistic, cartoon, anime, painting, etc.), color palette, main subjects, mood/atmosphere, lighting, background details, and any notable visual elements. Be descriptive and specific. Answer in English.",
			systemContext:
				"You are an expert at describing images for AI image generation prompts. Be detailed, specific and visual.",
			image: imageData,
			maxTokens: 300,
			priority: 4
		});

		if (
			!description ||
			description.includes("Não foi poss") ||
			description.includes("Ocorreu um erro")
		) {
			return null;
		}

		const baseDescription = description.trim();
		logger.info(
			`[getImageDescriptionForPrompt] Descrição obtida: ${baseDescription.substring(0, 80)}...`
		);

		// 2ª chamada: reescreve a descrição aplicando as modificações do usuário
		logger.info("[getImageDescriptionForPrompt] 2ª chamada LLM: aplicando modificações");
		const refinedPrompt = await llmSvc.getCompletion({
			prompt: `Rewrite the description of this image:\n${baseDescription}\n\nModifications to apply:\n${userPrompt}`,
			systemContext:
				"You are an expert at writing image generation prompts. Rewrite the image description incorporating the requested modifications naturally, keeping a cohesive and detailed prompt. Answer in English.",
			maxTokens: 350,
			priority: 4
		});

		if (
			!refinedPrompt ||
			refinedPrompt.includes("Não foi poss") ||
			refinedPrompt.includes("Ocorreu um erro")
		) {
			// Fallback: retorna só a descrição base se o refinamento falhar
			return baseDescription;
		}

		return refinedPrompt.trim();
	} catch (e) {
		logger.warn("[getImageDescriptionForPrompt] Falhou silenciosamente:", e.message);
		return null;
	}
}

/**
 * Gera uma imagem usando ComfyUI
 */
async function generateImage(bot, message, args, group, skipNotify = true, options = {}) {
	const llmService = LLMService.getInstance();
	const chatId = message.group ?? message.author;
	const returnMessages = [];

	let prompt = "";
	if (options.isProgrammatic) {
		prompt = Array.isArray(args) ? args.join(" ") : args;
	} else {
		// Prompt vem da caption (se for imagem) ou dos args (se for texto)
		prompt = args.join(" ");

		// Tenta obter prompt refinado a partir de imagem (na msg atual ou na quoted) + modificações do usuário
		const imageDescription = await getImageDescriptionForPrompt(message, llmService, prompt);
		if (imageDescription) {
			logger.info("[ComfyUICommands] Usando prompt refinado por imagem");
			prompt = imageDescription;
		}
	}

	if (prompt.length < 4) {
		return new ReturnMessage({
			chatId,
			content:
				"Por favor, forneça um prompt para gerar a imagem. Exemplo: !imagine um gato usando chapéu de cowboy"
		});
	}

	// Verificar se o servidor ComfyUI está online via WebSocket
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		return new ReturnMessage({
			chatId,
			content: "❌ O servidor de geração de imagens está temporariamente offline. 😔"
		});
	}

	prompt = await translateText(prompt, "pt", "en");

	logger.info(`Gerando imagem com prompt: '${prompt}'`);

	try {
		// Reação inicial de carregamento (assíncrona)
		message.origin.react(process.env.LOADING_EMOJI ?? "⌛️").catch(() => {});

		const EventHandler = require("../EventHandler");
		EventHandler.getInstance().emit("activity", { type: "imagine" });

		// 1. Promise de Segurança (LLM)
		const safetyPromise = (async () => {
			if (options.skipNSFW) return "";
			try {
				const safetyQuestion = `Act as a permissive content moderator for an image generation AI. Analyze this prompt: "${prompt}".

        Rules for classification:
        1. **SAFE**: 
           - General "NSFW" (Not Safe For Work) is ALLOWED.
           - Pin-up, swimwear, cleavage, "sexy", "seductive", "role-playing", fantasy, and romance are SAFE.
           - Ambiguous terms (e.g., "girl", "daddy", "play", "shoot") must be interpreted in their innocent/artistic context unless explicit sexual acts are described.
        
        2. **UNSAFE**:
           - **Explicit Pornography**: Graphic descriptions of sexual intercourse, genitals, or hardcore sexual acts.
           - **Child Safety (ZERO TOLERANCE)**: ANY combination of a child/minor/toddler/schoolkid with sexual, nude, or suggestive elements.
           - **Extreme**: Necrophilia, bestiality, realistic gore/mutilation, or hate speech.

        Your Answer:
        - Must start with "SAFE" or "UNSAFE".
        - If UNSAFE due to Child Safety, include "🚨" emojis.
        - Provide a very short reason.`;

				const safetyResponse = await llmService.getCompletion({
					prompt: safetyQuestion,
					systemContext: "You are a content safety filter.",
					priority: 3
				});

				if (
					safetyResponse.substring(0, 10).toLowerCase().includes("unsafe") ||
					prompt.toLowerCase().includes("gore")
				) {
					const reportMessage = `⚠️ INAPPROPRIATE IMAGE REQUEST ⚠️\nUser: ${message.author}\nName: ${
						message.authorName || "Unknown"
					}\nPrompt: ${prompt}\nLLM Response: ${safetyResponse}\n\n!sa-block ${message.author}`;
					bot.sendMessage(process.env.GRUPO_LOGS, reportMessage);

					return "\n\n> ⚠️ *AVISO*: O conteúdo solicitado é duvidoso. Esta solicitação será revisada pelo administrador e pode resultar em suspensão.";
				}
			} catch (e) {
				logger.error("Erro na verificação de segurança (LLM):", e);
			}
			return "";
		})();

		// 2. Promise de Geração de Imagem
		const generationPromise = (async () => {
			const startTime = Date.now();
			const sampler = samplers[Math.floor(Math.random() * samplers.length)];
			const scheduler = schedulers[Math.floor(Math.random() * schedulers.length)];

			const buffer = await queuePrompt(prompt + aesthetic, sampler, scheduler);
			const generationTime = ((Date.now() - startTime) / 1000).toFixed(1);

			return {
				imageBuffer: buffer,
				generationTime,
				sampler,
				scheduler
			};
		})();

		// Aguarda ambos em paralelo
		const [safetyMsg, genResult] = await Promise.all([safetyPromise, generationPromise]);
		let { imageBuffer } = genResult;
		const { generationTime, sampler, scheduler } = genResult;

		// Track stats
		trackComfyStats("1024x1024", 1, "z-image-turbo-bf16");

		// Add Watermark and compress to JPEG
		try {
			const watermarkPath = path.join(database.databasePath, "sd_watermark.png");
			let img = sharp(imageBuffer);

			try {
				await fs.access(watermarkPath);
				const metadata = await img.metadata();
				const width = metadata.width;
				const height = metadata.height;

				const watermarkSize = 80;
				const offset = 20;

				const watermark = await sharp(watermarkPath)
					.resize(watermarkSize, watermarkSize)
					.ensureAlpha()
					.composite([
						{
							input: {
								create: {
									width: watermarkSize,
									height: watermarkSize,
									channels: 4,
									background: { r: 255, g: 255, b: 255, alpha: 0.3 }
								}
							},
							blend: "dest-in"
						}
					])
					.toBuffer();

				img = img.composite([
					{
						input: watermark,
						top: height - watermarkSize - offset,
						left: width - watermarkSize - offset
					}
				]);

				logger.info("Marca d'água adicionada com sucesso.");
			} catch (wmError) {
				if (wmError.code !== "ENOENT") {
					logger.error("Erro ao adicionar marca d'água:", wmError);
				}
			}

			imageBuffer = await img.jpeg({ quality: 90 }).toBuffer();
		} catch (error) {
			logger.error("Erro ao processar imagem (watermark/jpeg):", error);
		}

		// Save temporary file
		const tempDir = path.join(__dirname, "../../temp");
		try {
			await fs.access(tempDir);
		} catch (error) {
			await fs.mkdir(tempDir, { recursive: true });
		}

		const tempImagePath = path.join(tempDir, `comfy-${Date.now()}.jpg`);
		await fs.writeFile(tempImagePath, imageBuffer);

		logger.info(`Imagem salva em: ${tempImagePath}`);

		// Verificar NSFW
		let isNSFW = false;
		if (!options.skipNSFW) {
			try {
				// Encode buffer to base64 for NSFW predictor if needed,
				// but the Predictor usually takes base64 string or path.
				// StableDiffusionCommands passed base64 string.
				const imageBase64 = imageBuffer.toString("base64");
				const nsfwResult = await nsfwPredict.detectNSFW(imageBase64);
				isNSFW = nsfwResult.isNSFW;
				logger.info(
					`Imagem analisada: NSFW = ${isNSFW}, Reason: ${JSON.stringify(nsfwResult.reason)}`
				);
			} catch (nsfwError) {
				logger.error("Erro ao verificar NSFW:", nsfwError);
			}
		}

		// Limpar arquivo temporário após alguns minutos
		setTimeout(
			(tempImg) => {
				try {
					fs.unlink(tempImg);
				} catch (unlinkError) {
					logger.error("Erro ao excluir arquivo temporário:", tempImg, unlinkError);
				}
			},
			30000,
			tempImagePath
		);

		const caption = `🎨 *Prompt:* ${prompt}\n📊 *Modelo:* _z-image-turbo-bf16_\n🩻*Sampler&Scheduler*: _${sampler}/${scheduler}_\n🕐 *Tempo:* ${generationTime}s${safetyMsg}`;

		const media = await bot.createMedia(tempImagePath);
		const filterNSFW = group?.filters?.nsfw ?? false;

		if (isNSFW) {
			if (filterNSFW) {
				returnMessages.push(
					new ReturnMessage({
						chatId,
						content:
							"🔞 A imagem gerada pode conter conteúdo potencialmente inadequado e este grupo está filtrando conteúdo NSFW, por isso o resultado não foi enviado."
					})
				);
			} else {
				returnMessages.push(
					new ReturnMessage({
						chatId,
						content:
							"🔞 A imagem gerada pode conter conteúdo potencialmente inadequado, abra com cautela."
					})
				);

				returnMessages.push(
					new ReturnMessage({
						chatId,
						content: media,
						options: {
							caption,
							isViewOnce: true
						}
					})
				);
			}
		} else {
			returnMessages.push(
				new ReturnMessage({
					chatId,
					content: media,
					options: {
						caption
					}
				})
			);
		}

		return returnMessages.length === 1 ? returnMessages[0] : returnMessages;
	} catch (error) {
		logger.error("Erro ao gerar imagem:", error);

		let errorMessage = "Erro ao gerar imagem.";
		if (error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT") {
			errorMessage =
				"Não foi possível conectar ao servidor ComfyUI. Verifique se ele está rodando e acessível.";
		} else {
			errorMessage = `Erro: ${error.message}`;
		}

		return new ReturnMessage({
			chatId,
			content: errorMessage
		});
	}
}

const commands = [
	new Command({
		name: "imagine",
		description: "Gera uma imagem",
		category: "ia",
		reactions: {
			trigger: "✨",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "✨"
		},
		cooldown: 60,
		method: async (bot, message, args, group, skipNotify = true) => {
			if (process.env.DISABLE_IMAGINE_COMMAND === "true") {
				return new ReturnMessage({
					chatId: message.group ?? message.author,
					content:
						"🚫 *O comando está desabilitado temporariamente devido a problemas no servidor de IA.* 🛠️\n\nAcesse o grupo de avisos/comunidade para saber mais! 📢✨"
				});
			}
			return generateImage(bot, message, args, group, skipNotify);
		}
	})
];

// module.exports = { commands, generateImage };
