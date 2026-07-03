const path = require("path");
const axios = require("axios");
const fs = require("fs").promises;
const sharp = require("sharp");
const Logger = require("../utils/Logger");
const NSFWPredict = require("../utils/NSFWPredict");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const { translateText } = require("./TranslationCommands");
const Database = require("../utils/Database");
const database = Database.getInstance();

const logger = new Logger("bonsai-commands");
const nsfwPredict = NSFWPredict.getInstance();
const LLMService = require("../services/LLMService");
const ServiceProviderService = require("../services/ServiceProviderService");
const serviceProviderService = ServiceProviderService.getInstance();

// Initialize Media Stats Database
database.getSQLiteDb(
	"bonsai_stats",
	`
    CREATE TABLE IF NOT EXISTS bonsai_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        resolution TEXT,
        count INTEGER DEFAULT 1,
        model TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bonsai_ts ON bonsai_stats(timestamp);
`
);

/**
 * Tracks Bonsai usage stats
 * @param {string} resolution - Image resolution (e.g., "1024x1024")
 * @param {number} count - Number of images generated
 * @param {string} model - Model used
 */
async function trackBonsaiStats(resolution, count = 1, model = "unknown") {
	try {
		await database.dbRun(
			"bonsai_stats",
			`INSERT INTO bonsai_stats (timestamp, resolution, count, model) VALUES (?, ?, ?, ?)`,
			[Date.now(), resolution, count, model]
		);
	} catch (e) {
		logger.error("Error tracking bonsai stats:", e);
	}
}

function getBonsaiUrl() {
	const providers = serviceProviderService.getProviders("bonsai");
	let url = providers[0]?.url || "http://192.168.195.212:13434";
	if (!url.match(/^https?:\/\//)) {
		url = "http://" + url;
	}
	return url;
}

const aesthetic = "\n\n(Aesthetic: Gothic, lightly purple-ish tinted atmosphere, cartoony)";

/**
 * Tenta obter um prompt refinado a partir de uma imagem + modificações do usuário.
 * Faz duas chamadas LLM:
 *   1. Descreve a imagem detalhadamente
 *   2. Reescreve a descrição aplicando as modificações solicitadas pelo usuário
 * Retorna null silenciosamente em caso de falha.
 * @param {Object} message - Dados da mensagem
 * @param {Object} llmService - Instância do LLMService
 * @param {string} userPrompt - Modificações desejadas pelo usuário
 * @returns {Promise<string|null>}
 */
async function getImageDescriptionForPrompt(message, llmService, userPrompt) {
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
		const description = await llmService.getCompletion({
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
		const refinedPrompt = await llmService.getCompletion({
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
 * Gera uma imagem usando Bonsai
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
			logger.info("[BonsaiCommands] Usando prompt refinado por imagem");
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

	const bonsaiUrl = getBonsaiUrl();

	prompt = await translateText(prompt, "pt", "en");

	logger.info(`Gerando imagem com Bonsai, prompt: '${prompt}'`);

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
			const response = await axios.post(
				`${bonsaiUrl}/generate`,
				{
					prompt: prompt + aesthetic,
					width: 1024,
					height: 1024,
					seed: Math.floor(Math.random() * 9999999),
					num_inference_steps: 20,
					guidance_scale: 7.5
				},
				{
					responseType: "arraybuffer",
					timeout: 60000
				}
			);

			const generationTime = ((Date.now() - startTime) / 1000).toFixed(1);
			return {
				imageBuffer: Buffer.from(response.data),
				generationTime
			};
		})();

		// Aguarda ambos em paralelo
		const [safetyMsg, genResult] = await Promise.all([safetyPromise, generationPromise]);
		let { imageBuffer } = genResult;
		const { generationTime } = genResult;

		// Track stats
		trackBonsaiStats("1024x1024", 1, "bonsai-ternary");

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

		const tempImagePath = path.join(tempDir, `bonsai-${Date.now()}.jpg`);
		await fs.writeFile(tempImagePath, imageBuffer);

		logger.info(`Imagem salva em: ${tempImagePath}`);

		// Verificar NSFW
		let isNSFW = false;
		if (!options.skipNSFW) {
			try {
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

		const caption = `🎨 *Prompt:* ${prompt}\n📊 *Modelo:* _bonsai-ternary_\n🕐 *Tempo:* ${generationTime}s${safetyMsg}`;

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
				"Não foi possível conectar ao servidor Bonsai. Verifique se ele está rodando e acessível.";
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

module.exports = { commands, generateImage };
