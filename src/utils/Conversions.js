const Logger = require("../utils/Logger");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs").promises;
const crypto = require("crypto");
const axios = require("axios");
const path = require("path");

const logger = new Logger("utils-conversions");
const tempDir = path.join(__dirname, "../../temp");

/**
 * Converte um arquivo de áudio para o formato Ogg/Opus usando fluent-ffmpeg.
 *
 * @param {string} inputFile O arquivo de entrada, que pode ser um caminho local, uma URL ou uma string base64.
 * @param {{b64?: boolean, url?: boolean, returnAsURL?: boolean}} opts Opções para especificar o tipo de arquivo de entrada.
 * @returns {Promise<string>} O caminho do arquivo de saída, URL ou string base64, dependendo do tipo de entrada.
 */
async function toOpus(inputFile, opts = { b64: false, url: false, returnAsURL: false }) {
	const outputDir = path.join(__dirname, "..", "..", "public", "audios");
	try {
		await fs.mkdir(outputDir, { recursive: true });
	} catch (error) {
		logger.error("[toOpus] Erro ao criar o diretório de saída:", error);
		throw new Error("Não foi possível criar o diretório de saída.");
	}

	const outputFileName = `${crypto.randomUUID()}.ogg`;
	const outputPath = path.join(outputDir, outputFileName);

	let tempFilePath = null;
	let fileToConvert = inputFile;

	try {
		if (opts.b64) {
			logger.info("[toOpus] Convertendo de Base64 para Opus...");
			const buffer = Buffer.from(inputFile, "base64");
			tempFilePath = path.join(tempDir, `temp_input_${crypto.randomUUID()}.tmp`);
			await fs.writeFile(tempFilePath, buffer);
			fileToConvert = tempFilePath;
		} else if (opts.url) {
			logger.info("[toOpus] Convertendo de URL para Opus...");
			fileToConvert = inputFile;
		} else {
			logger.info("[toOpus] Convertendo de caminho local para Opus...");
		}

		//console.log(fileToConvert);
		await new Promise((resolve, reject) => {
			ffmpeg(fileToConvert)
				.audioCodec("libopus")
				.format("ogg")
				.audioBitrate("48k")
				.audioChannels(1)
				.on("end", () => {
					logger.info("[toOpus] Conversão para Opus concluída.");
					resolve();
				})
				.on("error", (err) => {
					logger.error("[toOpus] Ocorreu um erro durante a conversão:", err.message);
					reject(err);
				})
				.save(outputPath);
		});

		console.log(outputPath);

		if (opts.url || opts.returnAsURL) {
			return `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/audios/${outputFileName}`;
		} else if (opts.b64) {
			const outputBuffer = await fs.readFile(outputPath);
			return outputBuffer.toString("base64");
		} else {
			return outputPath;
		}
	} catch (error) {
		logger.error("[toOpus] Falha na conversão:", error);
		throw error;
	} finally {
		if (tempFilePath) {
			try {
				//await fs.unlink(tempFilePath);
				logger.info("[toOpus] Arquivo temporário excluído.");
			} catch (err) {
				logger.warn("[toOpus] Não foi possível excluir o arquivo temporário:", err);
			}
		}
		if (opts.b64) {
			try {
				//await fs.unlink(outputPath);
				logger.info("[toOpus] Arquivo de saída temporário excluído.");
			} catch (err) {
				logger.warn("[toOpus] Não foi possível excluir o arquivo de saída temporário:", err);
			}
		}
	}
}

/**
 * Converte um objeto MessageMedia do wwebjs para o formato Ogg/Opus.
 * @param {object} messageMedia O objeto MessageMedia a ser convertido.
 * @returns {Promise<object>} Um novo objeto MessageMedia no formato Ogg/Opus.
 */
async function messageMediaToOpus(messageMedia) {
	const filename = messageMedia.filename || `audio_${crypto.randomUUID()}`;
	const filenameWithoutExt = path.parse(filename).name;

	try {
		const opusBase64 = await toOpus(messageMedia.data, { b64: true });
		const newMedia = {
			mimetype: "audio/ogg; codecs=opus",
			data: opusBase64,
			filename: path.basename(`${filenameWithoutExt}.ogg`),
			isMessageMedia: true
		};

		logger.info(`[messageMediaToOpus] Conversão concluída. Arquivo: ${newMedia.filename}`);
		return newMedia;
	} catch (error) {
		logger.error("[messageMediaToOpus] Erro durante a conversão:", error);
		throw error;
	}
}

/**
 * Converte um arquivo de áudio para o formato MP3 usando fluent-ffmpeg.
 *
 * @param {string} inputFile O arquivo de entrada, que pode ser um caminho local, uma URL ou uma string base64.
 * @param {{b64?: boolean, url?: boolean, returnAsURL?: boolean}} opts Opções para especificar o tipo de arquivo de entrada.
 * @returns {Promise<string>} O caminho do arquivo de saída, URL ou string base64, dependendo do tipo de entrada.
 */
async function toMp3(inputFile, opts = { b64: false, url: false, returnAsURL: false }) {
	const outputDir = path.join(__dirname, "..", "..", "public", "audios");
	try {
		await fs.mkdir(outputDir, { recursive: true });
	} catch (error) {
		logger.error("[toMp3] Erro ao criar o diretório de saída:", error);
		throw new Error("Não foi possível criar o diretório de saída.");
	}

	const outputFileName = `${crypto.randomUUID()}.mp3`;
	const outputPath = path.join(outputDir, outputFileName);

	let tempFilePath = null;
	let fileToConvert = inputFile;

	try {
		if (opts.b64) {
			logger.info("[toMp3] Convertendo de Base64 para MP3...");
			const buffer = Buffer.from(inputFile, "base64");
			tempFilePath = path.join(tempDir, `temp_input_${crypto.randomUUID()}.tmp`);
			await fs.writeFile(tempFilePath, buffer);
			fileToConvert = tempFilePath;
		} else if (opts.url) {
			logger.info("[toMp3] Convertendo de URL para MP3...");
			fileToConvert = inputFile;
		} else {
			logger.info("[toMp3] Convertendo de caminho local para MP3...");
		}

		await new Promise((resolve, reject) => {
			ffmpeg(fileToConvert)
				.audioCodec("libmp3lame")
				.format("mp3")
				.audioFrequency(44100)
				.audioChannels(2)
				.audioBitrate("128k")
				.on("end", () => {
					logger.info("[toMp3] Conversão para MP3 concluída.");
					resolve();
				})
				.on("error", (err) => {
					logger.error("[toMp3] Ocorreu um erro durante a conversão:", err.message);
					reject(err);
				})
				.save(outputPath);
		});

		if (opts.url || opts.returnAsURL) {
			return `${process.env.BOT_DOMAIN_LOCAL ?? process.env.BOT_DOMAIN}/audios/${outputFileName}`;
		} else if (opts.b64) {
			const outputBuffer = await fs.readFile(outputPath);
			return outputBuffer.toString("base64");
		} else {
			return outputPath;
		}
	} catch (error) {
		logger.error("[toMp3] Falha na conversão:", error);
		throw error;
	} finally {
		if (tempFilePath) {
			try {
				await fs.unlink(tempFilePath);
				logger.info("[toMp3] Arquivo temporário excluído.");
			} catch (err) {
				logger.warn("[toMp3] Não foi possível excluir o arquivo temporário:", err);
			}
		}
		if (opts.b64) {
			try {
				await fs.unlink(outputPath);
				logger.info("[toMp3] Arquivo de saída temporário excluído.");
			} catch (err) {
				logger.warn("[toMp3] Não foi possível excluir o arquivo de saída temporário:", err);
			}
		}
	}
}

/**
 * Converte um objeto MessageMedia do wwebjs para o formato MP3.
 * @param {object} messageMedia O objeto MessageMedia a ser convertido.
 * @returns {Promise<object>} Um novo objeto MessageMedia no formato MP3.
 */
async function messageMediaToMp3(messageMedia) {
	const filename = messageMedia.filename || `audio_${crypto.randomUUID()}`;
	const filenameWithoutExt = path.parse(filename).name;

	try {
		const mp3Base64 = await toMp3(messageMedia.data, { b64: true });
		const newMedia = {
			mimetype: "audio/mpeg",
			data: mp3Base64,
			filename: path.basename(`${filenameWithoutExt}.mp3`),
			isMessageMedia: true
		};

		logger.info(`[messageMediaToMp3] Conversão concluída. Arquivo: ${newMedia.filename}`);
		return newMedia;
	} catch (error) {
		logger.error("[messageMediaToMp3] Erro durante a conversão:", error);
		throw error;
	}
}

/**
 * Extrai frames de um vídeo usando ffmpeg.
 * @param {string} videoPath - Caminho do arquivo de vídeo.
 * @param {string} [outputDir] - Diretório onde os frames serão salvos. Se omitido, cria um temporário.
 * @param {number} count - Número de frames a extrair.
 * @param {string} size - Resolução dos frames (ex: '896x896', '?x480').
 * @returns {Promise<string[]>} - Lista de caminhos dos arquivos de frames extraídos, ordenados.
 */
async function extractFrames(
	videoPath,
	outputDir = path.join(tempDir, `frames_${crypto.randomUUID()}`),
	count = 30,
	size = "896x896"
) {
	try {
		await fs.mkdir(outputDir, { recursive: true });

		return new Promise((resolve, reject) => {
			ffmpeg(videoPath)
				.on("end", async () => {
					try {
						const files = await fs.readdir(outputDir);
						const frames = files
							.filter((f) => f.endsWith(".jpg"))
							.map((f) => path.join(outputDir, f));

						// Ordena arquivos para garantir sequência correta (frame_1, frame_2...)
						frames.sort((a, b) => {
							const numA = parseInt(a.match(/frame_(\d+)/)?.[1] || 0);
							const numB = parseInt(b.match(/frame_(\d+)/)?.[1] || 0);
							return numA - numB;
						});

						resolve(frames);
					} catch (e) {
						reject(e);
					}
				})
				.on("error", reject)
				.screenshots({
					count,
					folder: outputDir,
					filename: "frame_%i.jpg",
					size
				});
		});
	} catch (error) {
		logger.error("[extractFrames] Erro ao extrair frames:", error);
		throw error;
	}
}

module.exports = { toOpus, messageMediaToOpus, toMp3, messageMediaToMp3, extractFrames };
