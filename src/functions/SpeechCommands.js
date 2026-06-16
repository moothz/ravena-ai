const path = require("path");
const fs = require("fs").promises;
const { exec } = require("child_process");
const util = require("util");
const { v4: uuidv4 } = require("uuid");
const os = require("os");
const axios = require("axios");
const FormData = require("form-data");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const crypto = require("crypto");
const LLMService = require("../services/LLMService");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const CmdUsage = require("../utils/CmdUsage");
const ServiceProviderService = require("../services/ServiceProviderService");

const execPromise = util.promisify(exec);
const logger = new Logger("speech-commands");
const database = Database.getInstance();
const cmdUsage = CmdUsage.getInstance();
const serviceProviderService = ServiceProviderService.getInstance();

// Initialize Media Stats Database
database.getSQLiteDb(
	"media_stats",
	`
    CREATE TABLE IF NOT EXISTS speech_transcription_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        duration_sec REAL,
        char_count INTEGER,
        word_count INTEGER,
        processing_time_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_transcr_ts ON speech_transcription_stats(timestamp);

    CREATE TABLE IF NOT EXISTS speech_generation_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        char_count INTEGER,
        word_count INTEGER,
        duration_sec REAL,
        processing_time_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_gen_ts ON speech_generation_stats(timestamp);
`
);

const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";

// Definição dos personagens para TTS
const ttsCharacters = [
	{ name: "ravena", emoji: ["🗣", "🦇"], voice: "ravena_sample.wav" },
	{ name: "rubao", emoji: "🤠", voice: "rubao.wav" },
	{ name: "mulher", emoji: "👩", voice: "female_01.wav" },
	{ name: "carioca", voice: "female_02.wav" },
	{ name: "carioco", voice: "male_02.wav" },
	{ name: "sensual", emoji: "💋", voice: "female_03.wav" },
	{ name: "sensuel", voice: "male_04.wav" },
	{ name: "homem", emoji: "👨", voice: "male_01.wav" },
	{ name: "clint", voice: "Clint_Eastwood CC3 (enhanced).wav" },
	{ name: "morgan", voice: "Morgan_Freeman CC3.wav" },
	{ name: "narrador", emoji: "🎙", voice: "James_Earl_Jones CC3.wav" }
];

// Cria diretório temporário para arquivos de áudio
const tempDir = path.join(__dirname, "../../temp", "whatsapp-bot-speech");
fs.mkdir(tempDir, { recursive: true })
	.then(() => {
		logger.info(`Diretório temporário criado: ${tempDir}`);
	})
	.catch((error) => {
		logger.error("Erro ao criar diretório temporário:", error);
	});

logger.info(`Módulo SpeechCommands carregado`);

/**
 * Helper to get audio duration using ffmpeg
 * @param {string} filePath - Path to audio file
 * @returns {Promise<number>} - Duration in seconds
 */
async function getAudioDuration(filePath) {
	try {
		// Uses stderr because ffmpeg outputs file info to stderr
		const { stdout, stderr } = await execPromise(
			`"${ffmpegPath}" -i "${filePath}" 2>&1 | grep "Duration"`
		);
		const output = stdout || stderr;
		const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
		if (durationMatch) {
			const hours = parseFloat(durationMatch[1]);
			const minutes = parseFloat(durationMatch[2]);
			const seconds = parseFloat(durationMatch[3]);
			return hours * 3600 + minutes * 60 + seconds;
		}
	} catch (e) {
		// ffmpeg exits with code 1 if no output file, but still prints info to stderr
		if (e.stderr) {
			const durationMatch = e.stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
			if (durationMatch) {
				const hours = parseFloat(durationMatch[1]);
				const minutes = parseFloat(durationMatch[2]);
				const seconds = parseFloat(durationMatch[3]);
				return hours * 3600 + minutes * 60 + seconds;
			}
		}
		logger.warn(`Could not determine duration for ${filePath}:`, e.message);
	}
	return 0;
}

/**
 * Obtém mídia da mensagem.
 * Retorna { media, hadQuoted, quotedHadMedia } para distinguir erros.
 * @param {Object} message - O objeto da mensagem
 * @returns {Promise<{media: MessageMedia|null, hadQuoted: boolean, quotedHadMedia: boolean|null}>}
 */
async function getMediaFromMessage(message) {
	// Se a mensagem tem mídia direta
	if (message.type !== "text") {
		// Lazy loading: só usa content direto se já tiver .data (base64)
		if (message.content && message.content.data) {
			return { media: message.content, hadQuoted: false, quotedHadMedia: false };
		}
		if (typeof message.downloadMedia === "function") {
			try {
				const media = await message.downloadMedia();
				return { media, hadQuoted: false, quotedHadMedia: false };
			} catch (e) {
				logger.error("[getMediaFromMessage] Erro ao baixar mídia:", e);
				return { media: null, hadQuoted: false, quotedHadMedia: false };
			}
		}
		return { media: message.content ?? null, hadQuoted: false, quotedHadMedia: false };
	}

	const hadQuoted = !!message.hasQuotedMsg;

	// Tenta obter mídia da mensagem citada
	try {
		const quotedMsg = await message.origin.getQuotedMessage();
		if (quotedMsg && quotedMsg.hasMedia) {
			const media = await quotedMsg.downloadMedia();
			return { media, hadQuoted, quotedHadMedia: true };
		}
		return { media: null, hadQuoted, quotedHadMedia: quotedMsg ? false : null };
	} catch (error) {
		logger.error("Erro ao obter mídia da mensagem citada:", error);
	}

	return { media: null, hadQuoted, quotedHadMedia: null };
}

/**
 * Salva mídia em arquivo temporário
 * @param {MessageMedia} media - O objeto de mídia
 * @param {string} extension - Extensão do arquivo
 * @returns {Promise<string>} - Caminho para o arquivo salvo
 */
async function saveMediaToTemp(media, extension = "ogg") {
	const filename = `${uuidv4()}.${extension}`;
	const filepath = path.join(tempDir, filename);

	await fs.writeFile(filepath, Buffer.from(media.data, "base64"));
	logger.debug(`Mídia salva em arquivo temporário: ${filepath}`);

	return filepath;
}

/**
 * Remove marcações do WhatsApp do texto
 * @param {string} text - Texto a ser limpo
 * @returns {string} - Texto limpo
 */
function removeWhatsAppMarkup(text) {
	if (!text) return "";

	// Remove marcações de negrito
	text = text.replace(/\*/g, "");

	// Remove marcações de itálico
	text = text.replace(/_/g, "");

	// Remove marcações de riscado
	text = text.replace(/~/g, "");

	// Remove marcações de monospace
	text = text.replace(/`/g, "");

	// Remove marcações de citação (>)
	text = text.replace(/^\s*>\s*/gm, "");

	// Remove qualquer outra marcação especial que possa afetar a síntese de voz
	text = text.replace(/[[\]()]/g, " ");

	// Remove caracteres de formatação especiais
	text = text.replace(/[\x00-\x1F\x7F-\x9F\u2000-\u200F\u2028-\u202F]/g, " ");

	// Remove múltiplos espaços em branco
	text = text.replace(/\s+/g, " ");

	// Preserva quebras de linha
	text = text.replace(/\\n/g, "\n");

	return text.trim();
}

/**
 * Converte texto para voz usando F5-TTS API (OpenAI-compatible)
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @param {string} character - Personagem a ser usado (opcional)
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessages
 */
async function textToSpeech(bot, message, args, group, char = "ravena") {
	try {
		const chatId = message.group ?? message.author;

		if (process.env.DISABLE_TTS_COMMAND === "true") {
			return new ReturnMessage({
				chatId,
				content:
					"🚫 *Os comandos de áudio (TTS) estão desabilitados temporariamente devido a problemas no servidor.* 🛠️\n\nAcesse o grupo de avisos/comunidade para saber mais! 📢✨",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		const startProcess = Date.now();

		const quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		let text = args.join(" ");

		if (quotedMsg) {
			const quotedText = quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body;
			text += " " + quotedText;
		}

		if (text.length < 1) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça texto para converter em voz.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Limpa as marcações do WhatsApp antes de processar com F5-TTS
		text = removeWhatsAppMarkup(text);

		const character = ttsCharacters.find((ttsC) => ttsC.name === char);
		if (text.length > 250) {
			await bot.sendReturnMessages(
				new ReturnMessage({
					chatId,
					content: "🔉 Sintetizando áudio, isso pode levar alguns segundos...",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				}),
				group
			);
		}

		logger.debug(`Convertendo texto para voz (${JSON.stringify(character)}): ${text}`);
		const EventHandler = require("../EventHandler");
		EventHandler.getInstance().emit("activity", { type: "f5tts" });

		// Nome do arquivo temporário
		const hash = crypto.randomBytes(2).toString("hex");
		const tempFilename = `tts_audio_${hash}.mp3`;
		const tempFilePath = path.join(tempDir, tempFilename);

		// Monta a URL para a API do F5-TTS
		const f5ttsProviders = serviceProviderService.getProviders("f5tts");
		const f5ttsUrl = f5ttsProviders[0]?.url || "http://localhost:5050";
		const f5ttsApiKey = f5ttsProviders[0]?.apiKey || "";
		const apiUrl = `${f5ttsUrl}/v1/audio/speech`;

		// Faz a requisição para a API F5-TTS (OpenAI-compatible)
		const audioResponse = await axios({
			method: "post",
			url: apiUrl,
			data: {
				model: "f5-tts",
				input: text,
				voice: character.name,
				response_format: "mp3"
			},
			headers: {
				"Content-Type": "application/json",
				...(f5ttsApiKey ? { Authorization: `Bearer ${f5ttsApiKey}` } : {})
			},
			responseType: "arraybuffer"
		});

		// Salvar o arquivo localmente (temporariamente)
		await fs.writeFile(tempFilePath, Buffer.from(audioResponse.data));

		const processingTime = Date.now() - startProcess;

		// Track Stats
		try {
			const duration = await getAudioDuration(tempFilePath);
			const words = text.trim().split(/\s+/).length;
			const chars = text.length;

			await database.dbRun(
				"media_stats",
				`INSERT INTO speech_generation_stats (timestamp, char_count, word_count, duration_sec, processing_time_ms) VALUES (?, ?, ?, ?, ?)`,
				[Date.now(), chars, words, duration, processingTime]
			);
		} catch (statErr) {
			logger.error("Error tracking TTS stats:", statErr);
		}

		logger.info(`Criando mídia de '${tempFilePath}'`);
		const media = await bot.createMedia(tempFilePath);

		// Retorna a ReturnMessage com o áudio
		const returnMessage = new ReturnMessage({
			chatId,
			content: media,
			options: {
				sendAudioAsVoice: true,
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});

		logger.info(`Áudio TTS gerado com sucesso usando personagem ${character.name}`);

		// Log detailed usage
		cmdUsage.logFixedCommandUsage({
			timestamp: Date.now(),
			command: "tts",
			user: message.author,
			groupId: chatId,
			args: args.join(" "),
			info: {
				character: character.name,
				textLength: text.length
			}
		});

		// Limpa arquivos temporários
		try {
			await fs.unlink(tempFilePath);
			logger.debug("Arquivos temporários limpos");
		} catch (cleanupError) {
			logger.error("Erro ao limpar arquivos temporários:", cleanupError);
		}

		return returnMessage;
	} catch (error) {
		logger.error("Erro na conversão de texto para voz:");
		console.log(error);
		const chatId = message.group ?? message.author;

		return new ReturnMessage({
			chatId,
			content: "Erro ao gerar voz. Por favor, tente novamente.",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
}

/**
 * Helper to transcribe audio via Whisper API with failover
 * @param {string} audioPath - Path to audio file
 * @param {function} onEstimation - Callback for estimation (duration, estimatedTime)
 * @param {function} onStatus - Callback for status updates (status, executionId, url)
 * @returns {Promise<{text: string, duration: number}>}
 */
async function transcribeViaAPI(audioPath, onEstimation, onStatus) {
	const whisperProviders = serviceProviderService.getProviders("whisper");
	const urls = whisperProviders.map((p) => p.url);

	if (urls.length === 0) {
		throw new Error("WHISPER_API_URL not configured");
	}

	let lastError = null;

	for (const url of urls) {
		try {
			logger.debug(`[transcribe] Trying URL: ${url}`);
			const audioBuffer = await fs.readFile(audioPath);
			const requestBody = {
				audioData: audioBuffer.toString("base64"),
				language: "pt"
			};

			const postResponse = await axios.post(`${url}/transcribe`, requestBody, {
				timeout: 30000 // 30s timeout for initial request
			});

			const {
				executionId,
				audioDuration: apiDuration,
				estimatedTranscriptionTime
			} = postResponse.data;

			if (!executionId) {
				throw new Error("A API não retornou um executionId.");
			}

			if (onEstimation) {
				onEstimation(apiDuration, estimatedTranscriptionTime);
			}

			if (onStatus) {
				onStatus("queued", executionId, url);
			}

			let finalResult = null;
			let firstCheck = true;
			// Loop waiting for completion
			while (!finalResult) {
				const sleepTime = firstCheck ? estimatedTranscriptionTime * 1000 : 2000;
				await new Promise((resolve) => setTimeout(resolve, sleepTime));
				firstCheck = false;

				const statusResponse = await axios.get(`${url}/status/${executionId}`, {
					timeout: 10000
				});
				const result = statusResponse.data;

				if (onStatus) {
					onStatus(result.status, executionId, url);
				}

				if (result.status === "complete") {
					finalResult = result;
					return { text: result.text, duration: apiDuration };
				} else if (result.status === "error") {
					throw new Error(`API Error: ${result.error || result.message || "Erro desconhecido"}`);
				}
				// If processing or queued, continue loop
			}
		} catch (e) {
			logger.warn(`[transcribe] Failed with URL ${url}: ${e.message}`);
			lastError = e;
			// Continue to next URL
		}
	}

	throw lastError || new Error("All Whisper API URLs failed.");
}

/**
 * Cleans up a string by removing time formatting in square brackets and trimming whitespace
 * @param {string} text - The input text to clean
 * @returns {string} - The cleaned text
 */
function cleanupString(text) {
	// Split the input into lines
	const lines = text.split("\n");

	// Process each line
	const cleanedLines = lines.map((line) => {
		// Remove everything inside square brackets at the start of the line
		const cleanedLine = line.replace(/^\s*\[.*?\]\s*/, "");
		// Trim any remaining whitespace
		return `_${cleanedLine.trim()}_`;
	});

	// Filter out empty lines and join the result
	return cleanedLines.filter((line) => line.length > 2).join("\n");
}

/**
 * Converte voz para texto usando o executável Whisper diretamente ou via API
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @param {boolean} optimizeWithLLM - Se deve otimizar o texto com LLM
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessages
 */
async function speechToText(bot, message, args, group, optimizeWithLLM = true) {
	const startProcess = Date.now();
	const chatId = message.group ?? message.author;
	let audioPath = null;
	const wavPath = null;
	const whisperOutputPath = null;

	try {
		// Obtém mídia da mensagem
		const { media, hadQuoted, quotedHadMedia } = await getMediaFromMessage(message);
		if (!media) {
			if (hadQuoted && quotedHadMedia !== false) {
				return new ReturnMessage({
					chatId,
					content:
						"⚠️ Não foi possível recuperar o áudio da mensagem marcada. Ela pode ter saído do cache ou o download falhou.",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			}
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça um áudio ou mensagem de voz.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Verifica se a mídia é áudio
		const isAudio = media.mimetype.startsWith("audio/") || media.mimetype === "application/ogg";

		if (!isAudio) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça um áudio ou mensagem de voz.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		logger.debug("[speechToText] Convertendo voz para texto");

		// Salva áudio em arquivo temporário
		audioPath = await saveMediaToTemp(media, "ogg");

		// Get Duration
		let audioDuration = await getAudioDuration(audioPath);

		let transcribedText = "";

		const whisperProviders = serviceProviderService.getProviders("whisper");
		if (whisperProviders.length > 0) {
			// Use Whisper API
			logger.debug(`[speechToText] Usando Whisper API (Multi-URL)`);
			const EventHandler = require("../EventHandler");
			EventHandler.getInstance().emit("activity", { type: "whisper" });

			try {
				const result = await transcribeViaAPI(audioPath, (duration, estimatedTime) => {
					// Update duration
					if (duration) audioDuration = duration;
					logger.info(`[stt] ETA ${estimatedTime}s.`);

					// Avisa só se for demorar um pouquinho a mais
					if (estimatedTime > 15) {
						bot.sendReturnMessages(
							new ReturnMessage({
								chatId,
								content: `🔉 Transcrevendo áudio com _${audioDuration}s_, estimativa de _${estimatedTime}s_ até concluir.`,
								options: {
									quotedMessageId: message.origin.id._serialized,
									goReply: message.origin
								}
							}),
							group
						);
					}
				});

				transcribedText = result.text;
				if (result.duration) audioDuration = result.duration;
				logger.info("\n✅ Transcrição Concluída!\n");
			} catch (apiError) {
				logger.error("[speechToText] Erro ao usar Whisper API:", apiError);
				const isNetworkError =
					apiError.code === "ETIMEDOUT" ||
					apiError.code === "EHOSTUNREACH" ||
					apiError.code === "ECONNREFUSED" ||
					apiError.code === "ENOTFOUND" ||
					apiError.message?.toLowerCase().includes("timeout") ||
					apiError.message?.toLowerCase().includes("unreach") ||
					apiError.message?.toLowerCase().includes("connect");

				transcribedText = isNetworkError
					? "Erro no servidor de transcrição"
					: `Erro ao transcrever áudio via API: ${apiError.message || apiError}`;
			}
		} else {
			// Whisper API not configured in service-providers.json
			logger.warn(
				"[speechToText] Nenhum provider de Whisper configurado em service-providers.json"
			);
			transcribedText =
				"Serviço de transcrição não configurado. Adicione um provider de Whisper em service-providers.json.";
		}

		logger.debug(`[speechToText] LIDO arquivo de saida: '${transcribedText}'`);

		if (!transcribedText || transcribedText.startsWith("Erro")) {
			if (transcribedText !== "Erro no servidor de transcrição") {
				transcribedText =
					"Não foi possível transcrever o áudio. O áudio pode estar muito baixo ou pouco claro.";
			}

			const errorMessage = new ReturnMessage({
				chatId,
				content: transcribedText,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});

			return errorMessage;
		}

		const processingTime = Date.now() - startProcess;

		// Track Stats
		try {
			const words = transcribedText.trim().split(/\s+/).length;
			const chars = transcribedText.length;

			await database.dbRun(
				"media_stats",
				`INSERT INTO speech_transcription_stats (timestamp, duration_sec, char_count, word_count, processing_time_ms) VALUES (?, ?, ?, ?, ?)`,
				[Date.now(), audioDuration, chars, words, processingTime]
			);
		} catch (statErr) {
			logger.error("Error tracking STT stats:", statErr);
		}

		const returnMessage = new ReturnMessage({
			chatId,
			content: cleanupString(transcribedText?.trim() ?? ""),
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});

		logger.info(`[speechToText] Resultado STT gerado com sucesso: ${transcribedText}`);

		// Log detailed usage
		cmdUsage.logFixedCommandUsage({
			timestamp: Date.now(),
			command: "stt",
			user: message.author,
			groupId: chatId,
			args: args.join(" "),
			info: {
				textLength: transcribedText ? transcribedText.length : 0
				// Duration might be available if API was used, but variable scope is tricky here without major refactor
				// Just logging text length for now
			}
		});

		return returnMessage;
	} catch (error) {
		logger.error("Erro na conversão de voz para texto:", error);
		const chatId = message.group ?? message.author;

		return new ReturnMessage({
			chatId,
			content: "Erro ao transcrever áudio. Por favor, tente novamente."
		});
	} finally {
		// Clean up temporary files in finally block to ensure they are always removed
		try {
			if (audioPath) await fs.unlink(audioPath);
			if (wavPath) await fs.unlink(wavPath);
			if (
				whisperOutputPath &&
				(await fs
					.access(whisperOutputPath)
					.then(() => true)
					.catch(() => false))
			) {
				await fs.unlink(whisperOutputPath);
			}
		} catch (cleanupError) {
			logger.error("Erro ao limpar arquivos temporários no finally:", cleanupError);
		}
	}
}

/**
 * Processa STT automático para mensagens de voz
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Object} group - Dados do grupo
 * @returns {Promise<boolean>} - Se a mensagem foi processada
 */
async function processAutoSTT(bot, message, group, opts) {
	const startProcess = Date.now();
	const chatId = message.group ?? message.author;
	let audioPath = null;
	const wavPath = null;
	const whisperOutputPath = null;

	try {
		if (!message.group && bot.ignorePV) {
			return false;
		}

		// Pula se não for mensagem de voz/áudio
		if (message.type !== "voice" && message.type !== "audio" && message.type !== "ptt") {
			return false;
		}

		// Verifica se o auto-STT está habilitado para este grupo
		if (group && !group.autoStt) {
			return false;
		}

		/* O bot não deve reagir a interações automáticas
		try {
			await message.origin.react(process.env.LOADING_EMOJI ?? "⌛️");
		} catch (e) {
			logger.error(`[processAutoSTT] Erro enviando notificação inicial`);
		}
		*/

		logger.debug(`[processAutoSTT] Processamento Auto-STT para mensagem no chat ${chatId}`);

		// Salva áudio em arquivo temporário
		const media = await message.downloadMedia();
		audioPath = await saveMediaToTemp(media, "ogg");

		// Get Duration
		let audioDuration = await getAudioDuration(audioPath);

		let transcribedText = "";

		const autoWhisperProviders = serviceProviderService.getProviders("whisper");
		if (autoWhisperProviders.length > 0) {
			// Use Whisper API
			logger.debug(`[processAutoSTT] Usando Whisper API (Multi-URL)`);
			const EventHandler = require("../EventHandler");
			EventHandler.getInstance().emit("activity", { type: "whisper" });

			try {
				const result = await transcribeViaAPI(audioPath, (duration, estimatedTime) => {
					// Log info
					logger.info(`[stt][auto] ETA ${estimatedTime}s.`);
					if (duration) audioDuration = duration;
				});

				transcribedText = result.text;
				if (result.duration) audioDuration = result.duration;
				logger.info("✅ Transcrição Concluída!");
			} catch (apiError) {
				logger.error("[processAutoSTT] Erro ao usar Whisper API:", apiError);
				const isNetworkError =
					apiError.code === "ETIMEDOUT" ||
					apiError.code === "EHOSTUNREACH" ||
					apiError.code === "ECONNREFUSED" ||
					apiError.code === "ENOTFOUND" ||
					apiError.message?.toLowerCase().includes("timeout") ||
					apiError.message?.toLowerCase().includes("unreach") ||
					apiError.message?.toLowerCase().includes("connect");

				transcribedText = isNetworkError
					? "Erro no servidor de transcrição"
					: `Erro ao transcrever áudio via API: ${apiError.message || apiError}`;
			}
		} else {
			// Whisper API not configured in service-providers.json
			logger.warn(
				"[processAutoSTT] Nenhum provider de Whisper configurado em service-providers.json"
			);
			transcribedText = "";
		}

		// Se a transcrição for bem-sucedida, envia-a
		let contentRetorno = "";
		if (transcribedText && !transcribedText.startsWith("Erro")) {
			// Cria ReturnMessage com a transcrição
			contentRetorno = cleanupString(transcribedText?.trim() ?? "");

			const processingTime = Date.now() - startProcess;

			// Track Stats
			try {
				const words = transcribedText.trim().split(/\s+/).length;
				const chars = transcribedText.length;

				await database.dbRun(
					"media_stats",
					`INSERT INTO speech_transcription_stats (timestamp, duration_sec, char_count, word_count, processing_time_ms) VALUES (?, ?, ?, ?, ?)`,
					[Date.now(), audioDuration, chars, words, processingTime]
				);
			} catch (statErr) {
				logger.error("Error tracking Auto-STT stats:", statErr);
			}

			const returnMessage = new ReturnMessage({
				chatId,
				content: contentRetorno,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});

			logger.info(`[processAutoSTT] Resultado STT enviado: ${transcribedText}`);

			await bot.sendReturnMessages(returnMessage, group);

			// Log detailed usage
			cmdUsage.logFixedCommandUsage({
				timestamp: Date.now(),
				command: "auto-stt",
				user: message.author,
				groupId: chatId,
				args: "",
				info: {
					textLength: transcribedText ? transcribedText.length : 0
				}
			});
		} else {
			logger.warn(`[processAutoSTT] Transcrição vazia ou com erro para o chat ${chatId}`);
			// Se for no PV (sem grupo), envia a mensagem de erro correspondente ao !stt
			if (!group) {
				let errorText = transcribedText;
				if (
					!errorText ||
					(errorText.startsWith("Erro") && errorText !== "Erro no servidor de transcrição")
				) {
					errorText =
						"Não foi possível transcrever o áudio. O áudio pode estar muito baixo ou pouco claro.";
				}
				const errorMessage = new ReturnMessage({
					chatId,
					content: errorText,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
				await bot.sendReturnMessages(errorMessage, group);
			}
		}

		if (opts.returnResult) {
			return contentRetorno;
		} else {
			return true;
		}
	} catch (error) {
		logger.error("Erro no auto-STT:", error);
		return false;
	} finally {
		// Clean up temporary files in finally block to ensure they are always removed
		try {
			if (audioPath) await fs.unlink(audioPath);
			if (wavPath) await fs.unlink(wavPath);
			if (
				whisperOutputPath &&
				(await fs
					.access(whisperOutputPath)
					.then(() => true)
					.catch(() => false))
			) {
				await fs.unlink(whisperOutputPath);
			}
			//logger.debug('Arquivos temporários limpos no finally');
		} catch (cleanupError) {
			logger.error("Erro ao limpar arquivos temporários no finally:", cleanupError);
		}
	}
}

// Define os comandos usando a classe Command
const commands = [
	new Command({
		name: "stt",
		description: "Converte voz para texto",
		category: "utilidades",
		group: "transcr",
		needsMedia: true, // Verificará mídia direta ou mídia de mensagem citada
		reactions: {
			trigger: "👂",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "👂"
		},
		method: speechToText
	}),
	new Command({
		name: "transcrever",
		description: "Converte voz para texto",
		category: "utilidades",
		group: "transcr",
		needsMedia: true, // Verificará mídia direta ou mídia de mensagem citada
		reactions: {
			trigger: "👂",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "👂"
		},
		method: speechToText
	}),
	new Command({
		name: "tts",
		cooldown: 30,
		description: `Converte texto para voz usando personagem 'ravena'`,
		category: "tts",
		reactions: {
			trigger: ["🗣️", "🦇"],
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊"
		},
		method: (bot, message, args, group) => textToSpeech(bot, message, args, group, "ravena")
	}),
	new Command({
		name: "tts-mulher",
		cooldown: 30,
		description: `Converte texto para voz usando personagem feminina`,
		group: "ttsMulher",
		category: "tts",
		reactions: {
			trigger: "👩",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊"
		},
		method: (bot, message, args, group) => textToSpeech(bot, message, args, group, "mulher")
	}),
	new Command({
		name: "tts-carioca",
		cooldown: 30,
		description: `Converte texto para voz usando personagem feminina`,
		group: "ttsMulher",
		category: "tts",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊"
		},
		method: (bot, message, args, group) => textToSpeech(bot, message, args, group, "carioca")
	}),

	new Command({
		name: "tts-carioco",
		cooldown: 30,
		description: `Converte texto para voz usando personagem masculino`,
		group: "ttsHomem",
		category: "tts",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊"
		},
		method: (bot, message, args, group) => textToSpeech(bot, message, args, group, "carioco")
	}),

	new Command({
		name: "tts-sensual",
		cooldown: 30,
		description: `Converte texto para voz usando personagem feminina`,
		group: "ttsMulher",
		category: "tts",
		reactions: {
			trigger: "💋",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊"
		},
		method: (bot, message, args, group) => textToSpeech(bot, message, args, group, "sensual")
	}),
	new Command({
		name: "tts-sensuel",
		cooldown: 30,
		description: `Converte texto para voz usando personagem masculino`,
		category: "tts",
		group: "ttsHomem",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊"
		},
		method: (bot, message, args, group) => textToSpeech(bot, message, args, group, "sensuel")
	}),

	new Command({
		name: "tts-homem",
		cooldown: 30,
		description: `Converte texto para voz usando personagem masculino`,
		category: "tts",
		group: "ttsHomem",
		reactions: {
			trigger: "👨",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊"
		},
		method: (bot, message, args, group) => textToSpeech(bot, message, args, group, "homem")
	}),
	new Command({
		name: "tts-clint",
		cooldown: 30,
		description: `Converte texto para voz usando personagem masculino`,
		category: "tts",
		group: "ttsHomem",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊"
		},
		method: (bot, message, args, group) => textToSpeech(bot, message, args, group, "clint")
	}),

	new Command({
		name: "tts-morgan",
		cooldown: 30,
		description: `Converte texto para voz usando personagem masculino`,
		category: "tts",
		group: "ttsHomem",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊"
		},
		method: (bot, message, args, group) => textToSpeech(bot, message, args, group, "morgan")
	}),

	new Command({
		name: "tts-narrador",
		cooldown: 30,
		description: `Converte texto para voz usando personagem masculino`,
		group: "ttsHomem",
		category: "tts",
		reactions: {
			trigger: "🎙️",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊"
		},
		method: (bot, message, args, group) => textToSpeech(bot, message, args, group, "narrador")
	}),

	new Command({
		name: "tts-rubao",
		cooldown: 30,
		description: `Converte texto para voz usando do Rubão do Pontaço`,
		group: "ttsHomem",
		category: "tts",
		reactions: {
			trigger: "🎙️",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊"
		},
		method: (bot, message, args, group) => textToSpeech(bot, message, args, group, "rubao")
	})
];

// Exporta função para ser usada em EventHandler
module.exports.commands = commands;
module.exports.processAutoSTT = processAutoSTT;
module.exports.transcribeViaAPI = transcribeViaAPI;
