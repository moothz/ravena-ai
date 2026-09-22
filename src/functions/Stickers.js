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

// Padrões recomendados do WhatsApp para figurinhas (stickers)
const WHATSAPP_STICKER = {
	MAX_SIZE: 512, // Dimensão padrão do WhatsApp: 512x512 pixels
	MAX_DURATION: 15, // Duração máxima padrão de até 15s
	FPS: 8, // 8 FPS
	MAX_FILE_SIZE: 490 * 1024, // Limite de segurança (< 500 KB) do WhatsApp
	STATIC_QUALITY: 80, // Qualidade WebP para imagens estáticas
	ANIMATED_QUALITY: 28, // Qualidade inicial para 15s a 8 FPS
	COMPRESSION_LEVEL: 6 // Nível de compressão máximo da libwebp (0-6)
};

// Perfis sequenciais de fallback para figurinhas animadas (interrompe assim que tamanho <= 490 KB)
const ANIMATED_FALLBACK_PROFILES = [
	{ duration: 15, fps: 8, qv: 28, desc: "15s @ 8fps (q:28)" },
	{ duration: 15, fps: 8, qv: 18, desc: "15s @ 8fps menor q:v (q:18)" },
	{ duration: 10, fps: 8, qv: 22, desc: "10s @ 8fps (q:22)" },
	{ duration: 5, fps: 8, qv: 25, desc: "5s @ 8fps (q:25)" },
	{ duration: 3.5, fps: 8, qv: 20, desc: "3.5s @ 8fps (q:20)" }
];

// Perfis sequenciais de fallback para figurinhas animadas em alta taxa de quadros (HQ: 22-25 FPS)
const ANIMATED_HQ_PROFILES = [
	{ duration: 7, fps: 25, qv: 24, desc: "7s @ 25fps (q:24)" },
	{ duration: 6, fps: 25, qv: 18, desc: "6s @ 25fps menor q:v (q:18)" },
	{ duration: 5, fps: 22, qv: 18, desc: "5s @ 22fps (q:18)" },
	{ duration: 4.5, fps: 22, qv: 14, desc: "4.5s @ 22fps (q:14)" }
];

// Semáforo de concorrência: limita FFmpegs paralelos para evitar contenção de CPU
// Quando todos os slots estão ocupados, novas requisições aguardam na fila
const FFMPEG_MAX_CONCURRENT = 2;
let ffmpegActiveCount = 0;
const ffmpegQueue = [];

function acquireFFmpegSlot() {
	return new Promise((resolve) => {
		if (ffmpegActiveCount < FFMPEG_MAX_CONCURRENT) {
			ffmpegActiveCount++;
			resolve();
		} else {
			// logger.info(
			// 	`[FFmpegSemaphore] Slot ocupado (${ffmpegActiveCount}/${FFMPEG_MAX_CONCURRENT}), aguardando na fila (${ffmpegQueue.length + 1} na fila)...`
			// );
			ffmpegQueue.push(resolve);
		}
	});
}

function releaseFFmpegSlot() {
	if (ffmpegQueue.length > 0) {
		const next = ffmpegQueue.shift();
		// logger.info(
		// 	`[FFmpegSemaphore] Liberando slot para próximo da fila (${ffmpegQueue.length} restantes)`
		// );
		next();
	} else {
		ffmpegActiveCount--;
	}
}

// Função para determinar se o arquivo é um vídeo ou uma imagem
function isVideo(mimeType) {
	return mimeType.startsWith("video/") || mimeType === "image/gif";
}

// Função para salvar o buffer de mídia temporariamente
async function saveTempMedia(mediaBuffer, mimeType) {
	await ensureTempDir();

	let extension = "mp4";
	if (mimeType.includes("gif")) {
		extension = "gif";
	} else if (mimeType.includes("webp")) {
		extension = "webp";
	}

	const tempFileName = `temp-${Date.now()}.${extension}`;
	const tempFilePath = path.join(TEMP_DIR, tempFileName);

	await fs.writeFile(tempFilePath, mediaBuffer);
	return tempFilePath;
}

/**
 * Executa ffmpeg com múltiplos fallbacks em cascata para figurinhas animadas:
 * 1. 15s e 8 fps
 * 2. 15s e 8 fps menor q:v
 * 3. 10s e 8 fps
 * 4. 5s e 8 fps
 * 5. 3.5s e 8 fps
 *
 * @param {string} inputPath - Caminho do vídeo/gif de entrada
 * @param {string} filterCommand - Filtro de vídeo (crop, scale, yuva420p, pad)
 * @param {Array} [profiles=ANIMATED_FALLBACK_PROFILES] - Perfis sequenciais de fallback
 * @returns {Promise<Buffer>} - Buffer WebP animado
 */
async function encodeAnimatedWebPWithFallback(
	inputPath,
	filterCommand,
	profiles = ANIMATED_FALLBACK_PROFILES
) {
	await ensureTempDir();

	const fnStart = Date.now();

	// Aguarda slot disponível no semáforo (limita FFmpegs paralelos)
	await acquireFFmpegSlot();

	const runFfmpeg = (options, filter, output) =>
		new Promise((resolve, reject) => {
			ffmpeg(inputPath)
				.outputOptions(options)
				.videoFilters(filter)
				.toFormat("webp")
				.save(output)
				.on("end", resolve)
				.on("error", reject);
		});

	let bestBuffer = null;
	let bestSize = Infinity;
	const tempFilesToClean = [];

	try {
		for (let i = 0; i < profiles.length; i++) {
			const profile = profiles[i];
			const currentOutput = path.join(
				TEMP_DIR,
				`anim-${Date.now()}-${i}-${Math.random().toString(36).substring(7)}.webp`
			);
			tempFilesToClean.push(currentOutput);

			const currentFilter = filterCommand.includes("fps=")
				? filterCommand.replace(/fps=\d+/, `fps=${profile.fps}`)
				: `fps=${profile.fps},${filterCommand}`;

			const attemptStart = Date.now();
			await runFfmpeg(
				[
					"-y",
					"-t",
					String(profile.duration),
					"-c:v",
					"libwebp",
					"-lossless",
					"0",
					"-compression_level",
					String(WHATSAPP_STICKER.COMPRESSION_LEVEL),
					"-q:v",
					String(profile.qv),
					"-loop",
					"0",
					"-an"
				],
				currentFilter,
				currentOutput
			);
			const attemptMs = Date.now() - attemptStart;

			const stats = await fs.stat(currentOutput);
			const sizeKb = (stats.size / 1024).toFixed(1);
			// logger.info(
			// 	`[encodeAnimatedWebP] Tentativa ${i + 1}/${ANIMATED_FALLBACK_PROFILES.length} [${profile.desc}]: ${sizeKb} KB em ${attemptMs}ms`
			// );

			if (stats.size < bestSize) {
				bestSize = stats.size;
				bestBuffer = await fs.readFile(currentOutput);
			}

			if (stats.size <= WHATSAPP_STICKER.MAX_FILE_SIZE) {
				// logger.info(
				// 	`[encodeAnimatedWebP] ✓ Perfil '${profile.desc}' aprovado (${sizeKb} KB <= 490 KB). Total: ${Date.now() - fnStart}ms`
				// );
				return bestBuffer;
			}

			// logger.warn(
			// 	`[encodeAnimatedWebP] Perfil '${profile.desc}' excedeu limite (${sizeKb} KB > 490 KB). Tentando próximo fallback...`
			// );
		}

		// logger.warn(
		// 	`[encodeAnimatedWebP] Todos os perfis excederam o limite. Usando menor (${(bestSize / 1024).toFixed(1)} KB). Total: ${Date.now() - fnStart}ms`
		// );
		return bestBuffer;
	} finally {
		releaseFFmpegSlot();
		for (const file of tempFilesToClean) {
			fs.unlink(file).catch(() => {});
		}
	}
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

// Função para converter um buffer de mídia em um buffer de sticker quadrado nos padrões do WhatsApp
async function makeSquareMedia(mediaBuffer, mimeType, cropType = "center") {
	const fnStart = Date.now();
	try {
		// Converter de base64 para Buffer se necessário
		let rawBuffer = mediaBuffer;
		if (typeof mediaBuffer === "string") {
			rawBuffer = Buffer.from(mediaBuffer, "base64");
		} else if (mediaBuffer.data && typeof mediaBuffer.data === "string") {
			rawBuffer = Buffer.from(mediaBuffer.data, "base64");
		}

		const TARGET_SIZE = WHATSAPP_STICKER.MAX_SIZE;
		const FPS = WHATSAPP_STICKER.FPS;

		// Verifica se é WebP animado
		let isAnimWebP = false;
		if (mimeType === "image/webp") {
			try {
				const checkAnim = sharp(rawBuffer, { animated: true });
				const meta = await checkAnim.metadata();
				if (meta.pages > 1) {
					isAnimWebP = true;
				}
			} catch {}
		}

		// Se for imagem estática (exceto GIF e WebP animado), use sharp
		if (mimeType.startsWith("image/") && mimeType !== "image/gif" && !isAnimWebP) {
			const sharpStart = Date.now();
			const image = sharp(rawBuffer);
			const metadata = await image.metadata();
			// logger.info(
			// 	`[makeSquareMedia] Processando imagem via Sharp [${mimeType}, crop=${cropType}, ${metadata.width}x${metadata.height}]`
			// );

			// Determinar dimensões para corte quadrado
			const size = Math.min(metadata.width, metadata.height);
			let left = 0;
			let top = 0;

			// Verificar se o cropType é uma porcentagem (vinda do LLM ou manual)
			const percentage = parseFloat(cropType);

			let result;
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
				result = await image
					.extract({ left: Math.floor(left), top: Math.floor(top), width: size, height: size })
					.resize(TARGET_SIZE, TARGET_SIZE)
					.webp({
						quality: WHATSAPP_STICKER.STATIC_QUALITY,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropType === "center") {
				left = Math.max(0, (metadata.width - size) / 2);
				top = Math.max(0, (metadata.height - size) / 2);
				result = await image
					.extract({ left: Math.floor(left), top: Math.floor(top), width: size, height: size })
					.resize(TARGET_SIZE, TARGET_SIZE)
					.webp({
						quality: WHATSAPP_STICKER.STATIC_QUALITY,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropType === "top") {
				left = Math.max(0, (metadata.width - size) / 2);
				top = 0;
				result = await image
					.extract({ left: Math.floor(left), top: Math.floor(top), width: size, height: size })
					.resize(TARGET_SIZE, TARGET_SIZE)
					.webp({
						quality: WHATSAPP_STICKER.STATIC_QUALITY,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropType === "bottom") {
				left = Math.max(0, (metadata.width - size) / 2);
				top = Math.max(0, metadata.height - size);
				result = await image
					.extract({ left: Math.floor(left), top: Math.floor(top), width: size, height: size })
					.resize(TARGET_SIZE, TARGET_SIZE)
					.webp({
						quality: WHATSAPP_STICKER.STATIC_QUALITY,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropType === "stretch") {
				result = await image
					.resize(TARGET_SIZE, TARGET_SIZE, { fit: "fill" })
					.webp({
						quality: WHATSAPP_STICKER.STATIC_QUALITY,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropType === "hq") {
				// Redimensiona para caber em 512x512 mantendo o aspecto original, sem adicionar bordas
				result = await image
					.resize(TARGET_SIZE, TARGET_SIZE, { fit: "inside" })
					.webp({
						quality: 85,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else if (cropType === "transparent") {
				// Redimensiona para caber em 512x512 mantendo o aspecto e adiciona bordas transparentes
				result = await image
					.resize(TARGET_SIZE, TARGET_SIZE, {
						fit: "contain",
						background: { r: 0, g: 0, b: 0, alpha: 0 }
					})
					.webp({
						quality: WHATSAPP_STICKER.STATIC_QUALITY,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			} else {
				result = await image
					.extract({ left: Math.floor(left), top: Math.floor(top), width: size, height: size })
					.resize(TARGET_SIZE, TARGET_SIZE)
					.webp({
						quality: WHATSAPP_STICKER.STATIC_QUALITY,
						effort: WHATSAPP_STICKER.COMPRESSION_LEVEL
					})
					.toBuffer();
			}

			// logger.info(
			// 	`[makeSquareMedia] ✓ Imagem processada via Sharp em ${Date.now() - sharpStart}ms (total: ${Date.now() - fnStart}ms)`
			// );
			return result;
		} else if (isVideo(mimeType) || isAnimWebP) {
			// Para vídeos, GIFs e WebP animado, processa via ffmpeg
			// logger.info(
			// 	`[makeSquareMedia] Iniciando processamento FFmpeg [${mimeType}, crop=${cropType}, isAnimWebP=${isAnimWebP}]...`
			// );
			const ffmpegStart = Date.now();
			const inputPath = await saveTempMedia(rawBuffer, mimeType);

			let filterCommand = "";
			const percentage = parseFloat(cropType);

			if (!isNaN(percentage)) {
				filterCommand = `fps=${FPS},crop=min(iw\\,ih):min(iw\\,ih):clip((iw*${percentage}/100)-(min(iw\\,ih)/2)\\,0\\,iw-min(iw\\,ih)):clip((ih*${percentage}/100)-(min(iw\\,ih)/2)\\,0\\,ih-min(iw\\,ih)),scale=${TARGET_SIZE}:${TARGET_SIZE},format=yuva420p`;
			} else if (cropType === "center") {
				filterCommand = `fps=${FPS},crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2,scale=${TARGET_SIZE}:${TARGET_SIZE},format=yuva420p`;
			} else if (cropType === "top") {
				filterCommand = `fps=${FPS},crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:0,scale=${TARGET_SIZE}:${TARGET_SIZE},format=yuva420p`;
			} else if (cropType === "bottom") {
				filterCommand = `fps=${FPS},crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:ih-min(iw\\,ih),scale=${TARGET_SIZE}:${TARGET_SIZE},format=yuva420p`;
			} else if (cropType === "stretch") {
				filterCommand = `fps=${FPS},scale=${TARGET_SIZE}:${TARGET_SIZE},format=yuva420p`;
			} else if (cropType === "transparent") {
				// Ajustar vídeo para caber em 512x512 e preencher com fundo 100% transparente (sem bordas pretas)
				filterCommand = `fps=${FPS},scale=${TARGET_SIZE}:${TARGET_SIZE}:force_original_aspect_ratio=decrease,format=yuva420p,pad=${TARGET_SIZE}:${TARGET_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`;
			} else if (cropType === "hq") {
				// HQ: apenas dimensões (máx 512) com proporção original, sem crop, pad ou yuva420p
				filterCommand = `fps=25,scale=${TARGET_SIZE}:${TARGET_SIZE}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
			}

			try {
				const profiles = cropType === "hq" ? ANIMATED_HQ_PROFILES : ANIMATED_FALLBACK_PROFILES;
				const processedBuffer = await encodeAnimatedWebPWithFallback(
					inputPath,
					filterCommand,
					profiles
				);
				// logger.info(
				// 	`[makeSquareMedia] ✓ Vídeo/GIF processado via FFmpeg em ${Date.now() - ffmpegStart}ms (total: ${Date.now() - fnStart}ms)`
				// );
				return processedBuffer;
			} finally {
				await fs.unlink(inputPath).catch(() => {});
			}
		} else {
			throw new Error(`Tipo de mídia não suportado: ${mimeType}`);
		}
	} catch (error) {
		logger.error(
			`Erro ao processar mídia em quadrado [${Date.now() - fnStart}ms]: ${error.message}`
		);
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
		// logger.info(`Processando mídia para quadrado: ${mimeType}, tipo de corte: ${cropType}`);
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
	// logger.debug(`Executando comando sticker quadrado (${cropType}) para ${chatId}`);

	try {
		let mediaBuffer, mimeType, quotedMessageId;

		// Extrair mídia e informações necessárias da mensagem direta ou citada
		if (message.type === "image" || message.type === "video" || message.type === "gif") {
			// Mídia na mensagem atual
			// logger.debug(`Processando mídia da mensagem atual: ${message.type}`);

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
					content:
						"Envie uma imagem/vídeo com a legenda do comando, responda a uma mídia ou mencione alguém com @ para usar sua foto de perfil."
				});
			}

			// Verificar se o tipo de mídia é suportado
			const mediaType = quotedMsg.type.toLowerCase();

			// logger.debug(`Processando mídia da mensagem citada, tipo ${mediaType}`);
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
						"Este tipo de mídia não pode ser convertido em sticker. Apenas imagens, vídeos e stickers são suportados (você também pode mencionar alguém com @ para usar sua foto de perfil)."
				});
			}
		}

		// Log unificado do comando sticker + timer global
		const cmdStart = Date.now();
		// logger.info(
		// 	`[squareStickerCommand] INÍCIO (${cropType}) para ${chatId} [tipo=${mimeType}, mediaBuffer=${typeof mediaBuffer}]`
		// );

		// Determinar o tipo de corte final (se for LLM, fazer a query agora)
		let finalCropType = cropType;
		if (cropType === "llm") {
			// const llmStart = Date.now();
			finalCropType = await getLLMCropPercentage(mediaBuffer, mimeType);
			// logger.info(
			// 	`[squareStickerCommand] LLM crop em ${Date.now() - llmStart}ms → ${finalCropType}%`
			// );
		}

		// Processar a mídia para torná-la quadrada no padrão WhatsApp
		// const processStart = Date.now();
		const processedBuffer = await processMediaToSquare(mediaBuffer, mimeType, finalCropType);
		// logger.info(
		// 	`[squareStickerCommand] processMediaToSquare concluído em ${Date.now() - processStart}ms (${(processedBuffer.length / 1024).toFixed(1)} KB)`
		// );

		// Monta objeto de mídia direto do buffer em memória (sem I/O de arquivo temporário)
		const processedMedia = {
			mimetype: "image/webp",
			data: processedBuffer.toString("base64"),
			filename: `sticker-${Date.now()}.webp`,
			isMessageMedia: true
		};

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

		// logger.info(
		// 	`[squareStickerCommand] ✓ CONCLUÍDO (${cropType}) em ${Date.now() - cmdStart}ms — entregando ReturnMessage ao bot`
		// );

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
		if (bot.eventHandler?.commandHandler?.privateManagement?.[message.author]) {
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

		// Processa a mídia para o padrão de figurinha do WhatsApp (512x512, transparente, compactado, max 6s)
		let processedMedia = stickerContent;
		try {
			const processedBuffer = await processMediaToSquare(
				stickerContent,
				stickerContent.mimetype || message.type,
				"transparent"
			);
			processedMedia = {
				mimetype: "image/webp",
				data: processedBuffer.toString("base64"),
				filename: `autosticker-${Date.now()}.webp`,
				isMessageMedia: true
			};
		} catch (procErr) {
			logger.warn(
				"[processAutoSticker] Erro ao pré-processar sticker no padrão, usando mídia original:",
				procErr
			);
		}

		// Usar ReturnMessage para enviar o sticker
		const returnMessage = new ReturnMessage({
			chatId: message.author,
			content: processedMedia,
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		category: "stickers",
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
		name: "shq",
		description: "Cria figurinha em alta taxa de quadros (HQ: 22-25 FPS)",
		category: "stickers",
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
			await squareStickerCommand(bot, message, args, group, "hq")
	}),
	new Command({
		name: "stickerhq",
		description: "Cria figurinha em alta taxa de quadros (HQ: 22-25 FPS)",
		category: "stickers",
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
			await squareStickerCommand(bot, message, args, group, "hq")
	})
];

const helper = {
	about: "Criação, recorte, corte inteligente por IA e conversão de figurinhas (stickers)",
	implementation:
		"Processa imagens e vídeos com Sharp e FFmpeg, suporta enquadramento quadrado central, topo, fundo, stretch, HQ (22-25 FPS) e crop por IA",
	tags: "sticker,figurinha,s,fig,sq,sqi,shq,stickerhq,midia,recorte,whatsapp",
	cmds: [
		{
			cmd: "!sticker",
			desc: "Converte uma imagem, vídeo ou GIF em figurinha do WhatsApp",
			usage: ["!sticker (com imagem ou em resposta)", "!s"],
			category: "stickers"
		},
		{
			cmd: "!shq",
			desc: "Cria figurinha em alta taxa de quadros (22-25 FPS) mantendo as proporções originais",
			usage: ["!shq (com imagem/vídeo ou em resposta)", "!stickerhq"],
			category: "stickers"
		},
		{
			cmd: "!sqi",
			desc: "Cria figurinha quadrada com enquadramento inteligente do objeto principal via IA",
			usage: ["!sqi (com imagem ou em resposta)"],
			category: "stickers"
		},
		{
			cmd: "!sq",
			desc: "Cria figurinha quadrada cortada no centro",
			usage: ["!sq (com imagem ou em resposta)"],
			category: "stickers"
		},
		{
			cmd: "!sqc",
			desc: "Cria figurinha quadrada cortando no topo",
			usage: ["!sqc (com imagem ou em resposta)"],
			category: "stickers"
		},
		{
			cmd: "!sqb",
			desc: "Cria figurinha quadrada cortando na base",
			usage: ["!sqb (com imagem ou em resposta)"],
			category: "stickers"
		},
		{
			cmd: "!sqe",
			desc: "Cria figurinha quadrada esticada sem cortar as bordas",
			usage: ["!sqe (com imagem ou em resposta)"],
			category: "stickers"
		}
	]
};

module.exports = {
	helper,
	commands,
	processAutoSticker
};
