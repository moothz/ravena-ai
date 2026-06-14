const path = require("path");
const Logger = require("../utils/Logger");
const fs = require("fs").promises;
const Database = require("../utils/Database");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");

const CmdUsage = require("../utils/CmdUsage");
const LLMService = require("../services/LLMService");

const logger = new Logger("sticker-commands");
const database = Database.getInstance();
const cmdUsage = CmdUsage.getInstance();
const TEMP_DIR = path.join(__dirname, "../../temp", "whatsapp-bot-stickers");
//logger.info('Módulo  Commands carregado');

// Parte dos quadrados
// Garantir que o diretório temporário exista
async function ensureTempDir() {
	try {
		await fs.mkdir(TEMP_DIR, { recursive: true });
	} catch (error) {
		logger.error("Erro ao criar diretório temporário:", error);
	}
}

// Limpar arquivos temporários mais antigos que 1 hora
async function cleanupTempFiles() {
	try {
		const files = await fs.readdir(TEMP_DIR);
		const now = Date.now();
		const oneHourAgo = now - 60 * 60 * 1000;

		for (const file of files) {
			const filePath = path.join(TEMP_DIR, file);
			const stats = await fs.stat(filePath);

			if (stats.mtimeMs < oneHourAgo) {
				await fs.unlink(filePath);
			}
		}
	} catch (error) {
		logger.error("Erro ao limpar arquivos temporários:", error);
	}
}

// Função para determinar se o arquivo é um vídeo ou uma imagem
function isVideo(mimeType) {
	return mimeType.startsWith("video/") || mimeType === "image/gif";
}

// Função para salvar o buffer de mídia temporariamente
async function saveTempMedia(mediaBuffer, mimeType) {
	await ensureTempDir();

	const extension = mimeType.split("/")[1].replace("jpeg", "jpg");
	const tempFileName = `temp-${Date.now()}.${extension}`;
	const tempFilePath = path.join(TEMP_DIR, tempFileName);

	await fs.writeFile(tempFilePath, mediaBuffer);
	return tempFilePath;
}

/**
 * Faz uma query LLM para saber qual a melhor coordenada de corte (em porcentagem)
 * @param {Buffer|string} mediaBuffer - Buffer ou base64 da mídia
 * @param {string} mimeType - Tipo MIME da mídia
 * @returns {Promise<number>} - Porcentagem sugerida (0-100)
 */
async function getLLMCropPercentage(mediaBuffer, mimeType) {
	try {
		logger.info("[getLLMCropPercentage] Solicitando sugestão de corte ao LLM");

		// Converter base64 para Buffer se necessário
		let imageBuffer = mediaBuffer;
		if (typeof mediaBuffer === "string") {
			imageBuffer = Buffer.from(mediaBuffer, "base64");
		} else if (mediaBuffer.data && typeof mediaBuffer.data === "string") {
			imageBuffer = Buffer.from(mediaBuffer.data, "base64");
		}

		// Se for vídeo, extrair o primeiro frame para análise do LLM usando sharp
		// Sharp consegue ler o primeiro frame de um buffer de imagem/gif/webp
		const image = sharp(imageBuffer);
		const metadata = await image.metadata();

		const isLandscape = metadata.width > metadata.height;
		const orientation = isLandscape
			? "paisagem (mais larga que alta)"
			: "retrato (mais alta que larga)";
		const dimension = isLandscape ? "horizontal (eixo X)" : "vertical (eixo Y)";
		const startTerm = isLandscape ? "esquerda" : "topo";
		const endTerm = isLandscape ? "direita" : "base";

		const prompt = `Analise esta imagem e identifique a 'área de interesse' (a parte mais relevante, como um rosto ou objeto principal).
A imagem está no formato ${orientation}.
Retorne o centro ${dimension} desta área como uma porcentagem (0 a 100).
0 representa o/a ${startTerm} e 100 representa o/a ${endTerm}.
Responda APENAS com um objeto JSON seguindo este schema: { "percentage": número }`;

		const cropSchema = {
			type: "json_schema",
			json_schema: {
				name: "crop_analysis",
				schema: {
					type: "object",
					properties: {
						percentage: {
							type: "number",
							description: "A coordenada central ideal (0-100) para um corte quadrado"
						},
						reason: {
							type: "string",
							description: "Breve motivo da escolha"
						}
					},
					required: ["percentage"]
				}
			}
		};

		const response = await LLMService.getInstance().getCompletion({
			prompt,
			image: imageBuffer.toString("base64"),
			response_format: cropSchema,
			temperature: 0.2,
			priority: 5,
			systemContext: "Você é um especialista em processamento e análise de imagens."
		});

		try {
			const parsed = JSON.parse(response);
			if (typeof parsed.percentage === "number") {
				logger.info(
					`[getLLMCropPercentage] LLM sugeriu: ${parsed.percentage}% (${parsed.reason || "sem motivo"})`
				);
				return Math.max(0, Math.min(100, parsed.percentage));
			}
		} catch (e) {
			logger.warn(`[getLLMCropPercentage] Erro ao parsear resposta do LLM: ${response}`);
		}

		return 50; // Fallback para o centro
	} catch (error) {
		logger.error("[getLLMCropPercentage] Erro ao obter sugestão do LLM:", error);
		return 50;
	}
}

// Função para converter um buffer de mídia em um buffer de sticker quadrado
async function makeSquareMedia(mediaBuffer, mimeType, cropType = "center") {
	try {
		// Se for imagem (exceto GIF), use sharp
		if (mimeType.startsWith("image/") && mimeType !== "image/gif") {
			logger.info(`[makeSquareMedia] Processando imagem ${mimeType}`);

			// Carregar a imagem - Converter de base64 para Buffer se necessário
			let imageBuffer = mediaBuffer;
			if (typeof mediaBuffer === "string") {
				imageBuffer = Buffer.from(mediaBuffer, "base64");
			} else if (mediaBuffer.data && typeof mediaBuffer.data === "string") {
				imageBuffer = Buffer.from(mediaBuffer.data, "base64");
			}

			const image = sharp(imageBuffer);
			const metadata = await image.metadata();

			logger.debug(`Metadata da imagem: ${JSON.stringify(metadata)}`);

			// Determinar dimensões para corte quadrado
			const size = Math.min(metadata.width, metadata.height);
			let left = 0;
			let top = 0;

			// Verificar se o cropType é uma porcentagem (vinda do LLM ou manual)
			const percentage = parseFloat(cropType);

			if (!isNaN(percentage)) {
				if (metadata.width > metadata.height) {
					// Paisagem: Ajustar horizontal (X)
					const centerX = (metadata.width * percentage) / 100;
					left = Math.max(0, Math.min(metadata.width - size, centerX - size / 2));
					top = 0;
				} else {
					// Retrato: Ajustar vertical (Y)
					const centerY = (metadata.height * percentage) / 100;
					top = Math.max(0, Math.min(metadata.height - size, centerY - size / 2));
					left = 0;
				}
			} else if (cropType === "center") {
				// Centraliza o corte
				left = Math.max(0, (metadata.width - size) / 2);
				top = Math.max(0, (metadata.height - size) / 2);
			} else if (cropType === "top") {
				// Preserva o topo, corta o fundo
				left = Math.max(0, (metadata.width - size) / 2);
				top = 0;
			} else if (cropType === "bottom") {
				// Preserva o fundo, corta o topo
				left = Math.max(0, (metadata.width - size) / 2);
				top = Math.max(0, metadata.height - size);
			} else if (cropType === "stretch") {
				// Para o modo de esticamento, redimensionamos diretamente para 400x400
				return await image.resize(400, 400, { fit: "fill" }).toBuffer();
			} else if (cropType === "transparent") {
				// Redimensiona para caber em 400x400 mantendo o aspecto e adiciona bordas transparentes
				// Converte para webp para garantir suporte à transparência
				return await image
					.resize(400, 400, {
						fit: "contain",
						background: { r: 0, g: 0, b: 0, alpha: 0 }
					})
					.webp()
					.toBuffer();
			}

			// Aplicar o corte e redimensionar para 400x400
			return await image
				.extract({ left: Math.floor(left), top: Math.floor(top), width: size, height: size })
				.resize(400, 400)
				.toBuffer();
		} else if (isVideo(mimeType)) {
			logger.info(`[makeSquareMedia] Processando video ${mimeType}`);

			// Converter de base64 para Buffer se necessário
			let videoBuffer = mediaBuffer;
			if (typeof mediaBuffer === "string") {
				videoBuffer = Buffer.from(mediaBuffer, "base64");
			} else if (mediaBuffer.data && typeof mediaBuffer.data === "string") {
				videoBuffer = Buffer.from(mediaBuffer.data, "base64");
			}

			// Para vídeos e GIFs, use ffmpeg
			const inputPath = await saveTempMedia(videoBuffer, mimeType);
			const outputPath = `${inputPath.split(".")[0]}-square.${inputPath.split(".")[1]}`;

			logger.debug(`Arquivos temporários: input=${inputPath}, output=${outputPath}`);

			// Configurar os filtros baseados no tipo de corte
			let filterCommand = "";
			let outputLabel = "scaled";

			// Estratégia: primeiro determinar a área de corte e depois redimensionar para 400x400
			const percentage = parseFloat(cropType);

			if (!isNaN(percentage)) {
				// Cortar com base na porcentagem e depois redimensionar
				filterCommand = [
					{
						filter: "crop",
						options: {
							w: "min(iw,ih)",
							h: "min(iw,ih)",
							x: `clip((iw * ${percentage}/100) - (min(iw,ih)/2), 0, iw - min(iw,ih))`,
							y: `clip((ih * ${percentage}/100) - (min(iw,ih)/2), 0, ih - min(iw,ih))`
						},
						outputs: "cropped"
					},
					{
						filter: "scale",
						options: {
							w: 400,
							h: 400
						},
						inputs: "cropped",
						outputs: "scaled"
					}
				];
			} else if (cropType === "center") {
				// Cortar para quadrado no centro e depois redimensionar
				filterCommand = [
					{
						filter: "crop",
						options: {
							w: "min(iw,ih)",
							h: "min(iw,ih)",
							x: "(iw-min(iw,ih))/2",
							y: "(ih-min(iw,ih))/2"
						},
						outputs: "cropped"
					},
					{
						filter: "scale",
						options: {
							w: 400,
							h: 400
						},
						inputs: "cropped",
						outputs: "scaled"
					}
				];
			} else if (cropType === "top") {
				// Cortar para quadrado preservando o topo e depois redimensionar
				filterCommand = [
					{
						filter: "crop",
						options: {
							w: "min(iw,ih)",
							h: "min(iw,ih)",
							x: "(iw-min(iw,ih))/2",
							y: "0"
						},
						outputs: "cropped"
					},
					{
						filter: "scale",
						options: {
							w: 400,
							h: 400
						},
						inputs: "cropped",
						outputs: "scaled"
					}
				];
			} else if (cropType === "bottom") {
				// Cortar para quadrado preservando o fundo e depois redimensionar
				filterCommand = [
					{
						filter: "crop",
						options: {
							w: "min(iw,ih)",
							h: "min(iw,ih)",
							x: "(iw-min(iw,ih))/2",
							y: "(ih-min(iw,ih))"
						},
						outputs: "cropped"
					},
					{
						filter: "scale",
						options: {
							w: 400,
							h: 400
						},
						inputs: "cropped",
						outputs: "scaled"
					}
				];
			} else if (cropType === "stretch") {
				// Esticar o vídeo para 400x400 sem cortar
				filterCommand = [
					{
						filter: "scale",
						options: {
							w: 400,
							h: 400,
							force_original_aspect_ratio: 0 // Força o esticamento
						},
						outputs: "scaled"
					}
				];
			} else if (cropType === "transparent") {
				// Ajustar vídeo para caber em 400x400 e preencher com preto (letterbox)
				outputLabel = "padded";
				filterCommand = [
					{
						filter: "scale",
						options: {
							w: 400,
							h: 400,
							force_original_aspect_ratio: "decrease"
						},
						outputs: "scaled"
					},
					{
						filter: "pad",
						options: {
							w: 400,
							h: 400,
							x: "(ow-iw)/2",
							y: "(oh-ih)/2",
							color: "black"
						},
						inputs: "scaled",
						outputs: "padded"
					}
				];
			}

			// Usar arquivo intermediário em vez de pipe para evitar problemas de formato
			return new Promise((resolve, reject) => {
				ffmpeg(inputPath)
					.outputOptions([
						"-y",
						"-an",
						"-c:v libx264",
						"-preset veryfast",
						"-crf 32",
						"-r 15",
						"-t 7",
						"-pix_fmt yuv420p"
					])
					.complexFilter(filterCommand, outputLabel)
					.output(outputPath)
					.on("start", (cmdline) => {
						logger.debug(`Comando ffmpeg: ${cmdline}`);
					})
					.on("end", async () => {
						try {
							// Ler o arquivo de saída
							const processedBuffer = await fs.readFile(outputPath);
							// Limpar arquivos temporários
							// await fs.unlink(inputPath).catch(() => {
							//   logger.warn(`Não foi possível excluir ${inputPath}`);
							// });
							// await fs.unlink(outputPath).catch(() => {
							//   logger.warn(`Não foi possível excluir ${outputPath}`);
							// });
							resolve(processedBuffer);
						} catch (error) {
							logger.error(`Erro ao ler arquivo processado: ${error}`);
							reject(error);
						}
					})
					.on("error", (err) => {
						logger.error(`Erro no ffmpeg: ${err.message}`);
						// Tentar limpar os arquivos mesmo em caso de erro
						//fs.unlink(inputPath).catch(() => {});
						//fs.unlink(outputPath).catch(() => {});
						reject(err);
					})
					.run();
			});
		} else {
			throw new Error(`Tipo de mídia não suportado: ${mimeType}`);
		}
	} catch (error) {
		logger.error(`Erro ao processar mídia em quadrado: ${error.message}`);
		logger.error(error.stack);
		throw error;
	}
}

/**
 * Função middleware para processar mídia antes de enviá-la para o comando de sticker
 * @param {Buffer|Object} mediaBuffer - Buffer ou objeto com a mídia
 * @param {string} mimeType - Tipo MIME da mídia
 * @param {string} cropType - Tipo de corte: 'center', 'top', 'bottom' ou 'stretch'
 * @returns {Promise<Buffer>} - Buffer da mídia processada
 */
async function processMediaToSquare(mediaBuffer, mimeType, cropType) {
	try {
		logger.info(`Processando mídia para quadrado: ${mimeType}, tipo de corte: ${cropType}`);
		return await makeSquareMedia(mediaBuffer, mimeType, cropType);
	} catch (error) {
		logger.error(`Erro ao processar mídia em formato quadrado (${cropType}):`, error);
		throw error;
	}
}

/**
 * Cria um sticker quadrado a partir de uma mídia, aplicando diferentes tipos de corte
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @param {string} cropType - Tipo de corte: 'center', 'top', 'bottom' ou 'stretch'
 * @returns {Promise<ReturnMessage>} - ReturnMessage com o sticker
 */
async function squareStickerCommand(bot, message, args, group, cropType) {
	const chatId = message.group ?? message.author;
	logger.debug(`Executando comando sticker quadrado (${cropType}) para ${chatId}`);

	try {
		let mediaBuffer, mimeType, quotedMessageId;

		// Extrair mídia e informações necessárias da mensagem direta ou citada
		if (message.type === "image" || message.type === "video" || message.type === "gif") {
			// Mídia na mensagem atual
			logger.debug(`Processando mídia da mensagem atual: ${message.type}`);

			// Lazy loading: só usa content direto se já tiver .data (base64)
			if (message.content && message.content.data) {
				mediaBuffer = message.content;
				mimeType = message.content.mimetype;
			} else if (typeof message.downloadMedia === "function") {
				// Baixa sob demanda
				const media = await message.downloadMedia();
				if (!media) throw new Error("Falha ao baixar mídia");
				mediaBuffer = media;
				mimeType = media.mimetype;
			} else {
				throw new Error("Formato de mídia não reconhecido");
			}

			quotedMessageId = message.origin.id._serialized;
		} else {
			// Mídia na mensagem citada
			const quotedMsg = await message.origin.getQuotedMessage();

			// Se não há mensagem citada nem mídia direta
			if (!quotedMsg) {
				await message.origin.react("❌");
				if (message.hasQuotedMsg) {
					// Havia uma mensagem citada, mas saiu do cache
					return new ReturnMessage({
						chatId,
						content:
							"⚠️ Não foi possível recuperar a mídia da mensagem marcada. Ela pode ter saído do cache ou o download falhou."
					});
				}
				return new ReturnMessage({
					chatId,
					content: "Envie uma imagem/vídeo com a legenda do comando, ou responda a uma mídia."
				});
			}

			// Verificar se o tipo de mídia é suportado
			const mediaType = quotedMsg.type.toLowerCase();

			logger.debug(`Processando mídia da mensagem citada, tipo ${mediaType}`);
			if (mediaType === "sticker") {
				// Baixa o sticker original para extrair a mídia
				const stickerMedia = await quotedMsg.downloadMedia();

				// Verifica se é WebP para processamento especial
				if (stickerMedia.mimetype.includes("webp")) {
					try {
						const buffer = Buffer.from(stickerMedia.data, "base64");
						const image = sharp(buffer, { animated: true });
						const metadata = await image.metadata();

						if (metadata.pages > 1) {
							// WebP Animado -> GIF (via sharp) -> MP4 (via ffmpeg)
							// Resolve incompatibilidade do ffmpeg com chunks ANIM do WebP
							const gifBuffer = await image.gif({ loop: 0 }).toBuffer();
							const inputPath = await saveTempMedia(gifBuffer, "image/gif");
							const outputPath = inputPath.replace(".gif", ".mp4");

							await new Promise((resolve, reject) => {
								ffmpeg(inputPath)
									.outputOptions([
										"-y",
										"-an",
										"-c:v libx264",
										"-preset veryfast",
										"-crf 32",
										"-pix_fmt yuv420p",
										"-movflags faststart",
										"-vf scale=trunc(iw/2)*2:trunc(ih/2)*2"
									])
									.output(outputPath)
									.on("end", resolve)
									.on("error", (err, stdout, stderr) => {
										logger.error(`FFmpeg error: ${err.message}`);
										logger.error(`FFmpeg stderr: ${stderr}`);
										reject(err);
									})
									.run();
							});

							const mp4Buffer = await fs.readFile(outputPath);
							const mp4Media = {
								mimetype: "video/mp4",
								data: mp4Buffer.toString("base64"),
								filename: "sticker.mp4",
								isMessageMedia: true
							};

							// Limpar arquivos temporários
							await fs.unlink(inputPath).catch(() => {});
							await fs.unlink(outputPath).catch(() => {});

							return new ReturnMessage({
								chatId,
								content: mp4Media,
								options: {
									sendMediaAsSticker: false,
									caption: "Sticker Animation",
									quotedMessageId: message.origin.id._serialized,
									goReply: message.origin
								}
							});
						} else if (metadata.hasAlpha) {
							// WebP Transparente -> PNG (Documento)
							const pngBuffer = await image.png().toBuffer();
							const pngMedia = {
								mimetype: "image/png",
								data: pngBuffer.toString("base64"),
								filename: "sticker.png",
								isMessageMedia: true
							};

							return new ReturnMessage({
								chatId,
								content: pngMedia,
								options: {
									sendMediaAsDocument: true,
									caption: "Sticker Transparente",
									quotedMessageId: message.origin.id._serialized,
									goReply: message.origin
								}
							});
						}
					} catch (error) {
						logger.error("Erro ao processar sticker especial:", error);
						// Continua para o fallback padrão em caso de erro
					}
				}

				// Retorna a mídia original (não como sticker)
				return new ReturnMessage({
					chatId,
					content: stickerMedia,
					options: {
						sendMediaAsSticker: false,
						caption: "Sticker Media",
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			} else if (["image", "video", "gif"].includes(mediaType)) {
				const media = await quotedMsg.downloadMedia();
				mediaBuffer = media;
				mimeType = media.mimetype;
				quotedMessageId = message.origin.id._serialized;
			} else {
				await message.origin.react("❌");
				return new ReturnMessage({
					chatId,
					content:
						"Este tipo de mídia não pode ser convertido em sticker. Apenas imagens, vídeos e stickers são suportados."
				});
			}
		}

		// Log para debug
		logger.debug(`Mídia obtida: tipo=${mimeType}, mediaBuffer=${typeof mediaBuffer}`);

		// Determinar o tipo de corte final (se for LLM, fazer a query agora)
		let finalCropType = cropType;
		if (cropType === "llm") {
			finalCropType = await getLLMCropPercentage(mediaBuffer, mimeType);
		}

		// Processar a mídia para torná-la quadrada
		const processedBuffer = await processMediaToSquare(mediaBuffer, mimeType, finalCropType);

		// Salvar o buffer processado em um arquivo temporário
		await ensureTempDir();

		// Determinar a extensão correta
		let extension = mimeType.split("/")[1].replace("jpeg", "jpg");
		if (mimeType.startsWith("image/") && cropType === "transparent") {
			extension = "webp";
		}

		const tempFileName = `processed-${Date.now()}.${extension}`;
		const tempFilePath = path.join(TEMP_DIR, tempFileName);

		logger.debug(`Salvando mídia processada em: ${tempFilePath}`);
		await fs.writeFile(tempFilePath, processedBuffer);

		// Usar o método do bot para criar a mídia no formato correto
		const processedFileBuffer = await fs.readFile(tempFilePath);
		const processedMedia = {
			mimetype: require("mime-types").lookup(tempFilePath) || "application/octet-stream",
			data: processedFileBuffer.toString("base64"),
			filename: require("path").basename(tempFilePath),
			isMessageMedia: true
		};

		// Tentar limpar o arquivo temporário (de forma assíncrona, não bloqueia)
		// fs.unlink(tempFilePath).catch(err => {
		//   logger.warn(`Não foi possível excluir o arquivo temporário ${tempFilePath}: ${err.message}`);
		// });

		// Extrair nome do sticker dos args ou usa nome do grupo
		const stickerName = args.length > 0 ? args.join(" ") : group ? group.name : "sticker";

		// Log usage
		cmdUsage.logFixedCommandUsage({
			timestamp: Date.now(),
			command: "sticker",
			user: message.author,
			groupId: chatId,
			args: args.join(" "),
			info: {
				cropType,
				mimeType
			}
		});

		// Cria ReturnMessage com opções para sticker
		return [
			new ReturnMessage({
				chatId,
				content: processedMedia,
				options: {
					sendMediaAsSticker: true,
					stickerAuthor: "ravena",
					stickerName,
					quotedMessageId
				}
			})
		];
		/*
    ,
    new ReturnMessage({
      chatId: chatId,
      content: processedMedia
    })
    */
	} catch (error) {
		logger.error(`Erro ao criar sticker quadrado (${cropType}):`, error);

		// Tenta aplicar reação de erro diretamente
		try {
			await message.origin.react("❌");
		} catch (reactError) {
			logger.error("Erro ao aplicar reação de erro:", reactError);
		}

		return new ReturnMessage({
			chatId,
			content: `Erro ao criar sticker quadrado (${cropType}). Por favor, tente novamente com uma imagem ou vídeo válido.`
		});
	}
}

/**
 * Processa automaticamente imagens/vídeos enviados para o PV, convertendo-os em stickers
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Object} group - Dados do grupo (será null para mensagens privadas)
 * @returns {Promise<boolean>} - Se a mensagem foi processada
 */
async function processAutoSticker(bot, message, group) {
	try {
		// Verifica se a mensagem é privada (não é de grupo)
		if (message.group) {
			return false;
		}

		// Verifica se o usuário está gerenciando algum grupo pelo PV
		if (
			bot.eventHandler.commandHandler.privateManagement &&
			bot.eventHandler.commandHandler.privateManagement[message.author]
		) {
			// O usuário está gerenciando um grupo pelo PV, não criar sticker automaticamente
			return false;
		}

		// Pula se não for mídia de imagem, vídeo ou GIF
		if (!["image", "video", "gif"].includes(message.type)) {
			return false;
		}

		logger.debug(
			`[processAutoSticker] Processando mídia automática para sticker no chat ${message.author}`
		);

		// Criar um nome para o sticker (pode ser o nome de quem enviou ou um padrão)
		const stickerName = message.authorName || "sticker";

		// Lazy loading: garante que o base64 esteja disponível antes de enviar
		let stickerContent = message.content;
		if (!stickerContent?.data && typeof message.downloadMedia === "function") {
			try {
				stickerContent = await message.downloadMedia();
			} catch (e) {
				logger.error("[processAutoSticker] Erro ao baixar mídia:", e);
				return false;
			}
		}
		if (!stickerContent?.data) {
			logger.warn("[processAutoSticker] Mídia sem dados, abortando");
			return false;
		}

		// Usar ReturnMessage para enviar o sticker
		const returnMessage = new ReturnMessage({
			chatId: message.author,
			content: stickerContent,
			options: {
				sendMediaAsSticker: true,
				stickerAuthor: "ravena",
				stickerName,
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});

		// Envia o sticker
		await bot.sendReturnMessages(returnMessage, group);

		logger.info(`[processAutoSticker] Sticker automático enviado para ${message.author}`);

		return true;
	} catch (error) {
		logger.error("Erro no processamento automático de sticker:", error);
		return false;
	}
}

// Criar array de comandos usando a classe Command
const commands = [
	new Command({
		name: "sticker",
		description: "Converte mídia em sticker",
		category: "midia",
		group: "ssticker",
		needsMedia: true, // Verificará tanto mídia direta quanto mídia de mensagem citada
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			// Agora usa o modo transparente como padrão
			await squareStickerCommand(bot, message, args, group, "transparent")
	}),
	new Command({
		name: "figurinha",
		description: "Converte mídia em sticker",
		category: "midia",
		group: "ssticker",
		needsMedia: true, // Verificará tanto mídia direta quanto mídia de mensagem citada
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			// Agora usa o modo transparente como padrão
			await squareStickerCommand(bot, message, args, group, "transparent")
	}),

	new Command({
		name: "s",
		description: "Alias curto para comando sticker",
		category: "midia",
		group: "ssticker",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			// Agora usa o modo transparente como padrão
			await squareStickerCommand(bot, message, args, group, "transparent")
	}),
	new Command({
		name: "fig",
		description: "Alias curto para comando sticker",
		category: "midia",
		group: "ssticker",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			trigger: "🖼",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			// Agora usa o modo transparente como padrão
			await squareStickerCommand(bot, message, args, group, "transparent")
	}),
	new Command({
		name: "sqi",
		description: "Sticker quadrado com corte inteligente via IA",
		category: "midia",
		group: "sstickerqua",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "llm")
	}),
	new Command({
		name: "stickerqi",
		description: "Sticker quadrado com corte inteligente via IA",
		category: "midia",
		group: "sstickerqua",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "llm")
	}),
	new Command({
		name: "sq",
		description:
			"Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)",
		category: "midia",
		group: "sstickerqua",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "center")
	}),
	new Command({
		name: "stickerq",
		description:
			"Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)",
		category: "midia",
		group: "sstickerqua",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "center")
	}),
	new Command({
		name: "sqc",
		description:
			"Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)",
		category: "midia",
		group: "sstickerqua",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "top")
	}),
	new Command({
		name: "stickerqc",
		description:
			"Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)",
		category: "midia",
		group: "sstickerqua",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "top")
	}),

	new Command({
		name: "sqb",
		description:
			"Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)",
		category: "midia",
		group: "sstickerqua",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "bottom")
	}),
	new Command({
		name: "stickerqb",
		description:
			"Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)",
		category: "midia",
		group: "sstickerqua",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "bottom")
	}),
	// Comando para sticker esticado (sqe)
	new Command({
		name: "sqe",
		description: "Sticker quadrado esticado, sem cortar a imagem",
		category: "midia",
		group: "sstickerqua",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "stretch")
	}),
	new Command({
		name: "stickerqe",
		description: "Sticker quadrado esticado, sem cortar a imagem",
		category: "midia",
		group: "sstickerqua",
		needsMedia: true,
		caseSensitive: false,
		cooldown: 0,
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🖼",
			error: "❌"
		},
		method: async (bot, message, args, group) =>
			await squareStickerCommand(bot, message, args, group, "stretch")
	})
];

module.exports = { commands, processAutoSticker };
