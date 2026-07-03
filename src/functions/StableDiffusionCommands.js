const path = require("path");
const axios = require("axios");
const fs = require("fs").promises;
const sharp = require("sharp");
const Logger = require("../utils/Logger");
const NSFWPredict = require("../utils/NSFWPredict");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const { translateText } = require("./TranslationCommands");

const logger = new Logger("stable-diffusion-commands");
const nsfwPredict = NSFWPredict.getInstance();

const LLMService = require("../services/LLMService");
const llmService = LLMService.getInstance();
const ServiceProviderService = require("../services/ServiceProviderService");
const serviceProviderService = ServiceProviderService.getInstance();
const sdWebUIToken = `Basic ${process.env.SDWEBUI_TOKEN ?? ""}`;

//logger.info('Módulo StableDiffusionCommands carregado');

// Configuração da API SD WebUI
function getApiUrl() {
	const providers = serviceProviderService.getProviders("sdwebui");
	return providers[0]?.url || "http://localhost:7860";
}
/* Parametros bons pra lightning
const DEFAULT_PARAMS = {
  width: 832,
  height: 1216,
  steps: 10,
  cfg_scale: ,
  sampler_name: 'k_euler_a',
  batch_size: 1,
  n_iter: 1,
  negative_prompt: "ass bum poop woman dick nsfw porn boobs tits vagina child kid gore infant"
};
*/
const DEFAULT_PARAMS = {
	width: process.env.SD_width ?? 1200,
	height: process.env.SD_height ?? 1200,
	steps: process.env.SD_steps ?? 40,
	cfg_scale: process.env.SD_cfg_scale ?? 2,
	sampler_name: process.env.SD_sampler_name ?? "k_dpmpp_2m_sde",
	batch_size: 1,
	n_iter: 1,
	negative_prompt:
		"low quality pixelated blurry bad missing fingers ass bum poop woman dick nsfw porn boobs tits vagina child kid gore infant"
};

/**
 * Gera uma imagem usando a API do Stable Diffusion
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessages
 */

/**
 * Tenta obter um prompt refinado a partir de uma imagem + modificações do usuário.
 * Faz duas chamadas LLM:
 *   1. Descreve a imagem detalhadamente
 *   2. Reescreve a descrição aplicando as modificações solicitadas pelo usuário
 * Retorna null silenciosamente em caso de falha.
 * @param {Object} message - Dados da mensagem
 * @param {string} userPrompt - Modificações desejadas pelo usuário
 * @returns {Promise<string|null>}
 */
async function getImageDescriptionForPrompt(message, userPrompt) {
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

async function generateImage(bot, message, args, group, skipNotify = false) {
	const chatId = message.group ?? message.author;
	const returnMessages = [];

	// Prompt vem da caption (se for imagem) ou dos args (se for texto)
	let prompt = args.join(" ");

	// Tenta obter prompt refinado a partir de imagem (na msg atual ou na quoted) + modificações do usuário
	const imageDescription = await getImageDescriptionForPrompt(message, prompt);
	if (imageDescription) {
		logger.info("[StableDiffusionCommands] Usando prompt refinado por imagem");
		prompt = imageDescription;
	}

	if (prompt.length < 4) {
		return new ReturnMessage({
			chatId,
			content:
				"Por favor, forneça um prompt para gerar a imagem. Exemplo: !imagine um gato usando chapéu de cowboy"
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
			try {
				const safetyQuestion = `Check if this image generation prompt is generating concering porn or nude content: "${prompt}". 
    Adult themes and sexually suggestive is acceptable ok, filter only very explicit requests, implicit is fine. NSFW is not a problem, as long as it does not include: child, necro, gore, racism.
    Your answer ((must)) include "SAFE" or "UNSAFE" followed by a brief reason. If it's related to child related content, include warning emojis in your reponse.`;

				const safetyResponse = await llmService.getCompletion({
					prompt: safetyQuestion,
					systemContext: "You are a content safety filter.",
					priority: 3
				});

				// Check if the response indicates unsafe content
				if (
					safetyResponse.substring(0, 10).toLowerCase().includes("unsafe") ||
					prompt.toLowerCase().includes("gore")
				) {
					// Log the inappropriate request
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
			const payload = {
				prompt,
				negative_prompt:
					"bad anatomy, bad hands, text, missing fingers, extra digit, fewer digits, cropped, low-res, worst quality, jpeg artifacts, signature, watermark, username, blurry",
				...DEFAULT_PARAMS
			};

			const response = await axios.post(`${getApiUrl()}/sdapi/v1/txt2img`, payload, {
				headers: {
					Authorization: sdWebUIToken,
					"Content-Type": "application/json"
				},
				timeout: 120000 // 2 minutos de timeout
			});

			const generationTime = ((Date.now() - startTime) / 1000).toFixed(1);

			if (!response.data || !response.data.images || response.data.images.length === 0) {
				throw new Error("A API não retornou imagens");
			}

			const imageBase64 = response.data.images[0];
			const info = JSON.parse(response.data.info || "{}");
			const modelName = info.sd_model_name || "Modelo desconhecido";

			return {
				imageBase64,
				generationTime,
				modelName
			};
		})();

		// Aguarda ambos em paralelo
		const [safetyMsg, genResult] = await Promise.all([safetyPromise, generationPromise]);
		const { imageBase64, generationTime, modelName } = genResult;

		// Verificar NSFW antes de enviar
		// Primeiro, salva a imagem temporariamente para análise
		const tempDir = path.join(__dirname, "../../temp");

		// Garante que o diretório exista
		try {
			await fs.access(tempDir);
		} catch (error) {
			await fs.mkdir(tempDir, { recursive: true });
		}

		const tempImagePath = path.join(tempDir, `sd-${Date.now()}.jpg`);
		let imageBuffer = Buffer.from(imageBase64, "base64");

		try {
			imageBuffer = await sharp(imageBuffer).jpeg({ quality: 90 }).toBuffer();
		} catch (sharpError) {
			logger.error("Erro ao comprimir imagem com sharp:", sharpError);
		}

		await fs.writeFile(tempImagePath, imageBuffer);

		logger.info(`Recebida resposta, salvando imagem em: ${tempImagePath}`);

		// Verificar NSFW
		let isNSFW = false;
		try {
			const nsfwResult = await nsfwPredict.detectNSFW(imageBase64);
			isNSFW = nsfwResult.isNSFW;
			logger.info(
				`Imagem analisada: NSFW = ${isNSFW}, Reason: ${JSON.stringify(nsfwResult.reason)}`
			);
		} catch (nsfwError) {
			logger.error("Erro ao verificar NSFW:", nsfwError);
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

		// Prepara a legenda com informações sobre a geração
		const caption = `🎨 *Prompt:* ${prompt}\n📊 *Modelo:* ${modelName}\n🕐 *Tempo:* ${generationTime}s${safetyMsg}`;

		const media = await bot.createMedia(tempImagePath);
		logger.info(media);

		const filterNSFW = group?.filters?.nsfw ?? false;

		// Se a imagem for NSFW, envia um aviso antes
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

				// Envia a imagem como viewOnly
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
			// Envia a imagem normalmente se não for NSFW
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

		// Se só tiver um item no array, retorna ele diretamente
		return returnMessages.length === 1 ? returnMessages[0] : returnMessages;
	} catch (error) {
		//logger.error('Erro ao gerar imagem:', error);

		let errorMessage = "Erro ao gerar imagem.";

		// Detalhes adicionais para erros específicos
		if (error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT") {
			errorMessage =
				"Não foi possível conectar ao servidor Stable Diffusion. Verifique se ele está rodando e acessível.";
		} else if (error.response) {
			// Erro da API
			errorMessage = `Erro da API Stable Diffusion: ${error.response.status} - ${error.response.statusText}`;
		}

		return new ReturnMessage({
			chatId,
			content: errorMessage
		});
	}
}

// Comandos utilizando a classe Command
const commands = [
	new Command({
		name: "imagine",
		description: "Gera uma imagem usando Stable Diffusion",
		category: "ia",
		reactions: {
			trigger: "✨",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "✨"
		},
		cooldown: 10,
		method: generateImage
	})
];

// Registra os comandos sendo exportados
//logger.debug(`Exportando ${commands.length} comandos:`, commands.map(cmd => cmd.name));

//module.exports = { commands };
