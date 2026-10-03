const fs = require("fs").promises;
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { upload, uploadNsfw, MAX_NSFW_FILE_SIZE } = require("../middleware/upload");
const SpeechCommands = require("../../functions/SpeechCommands");

function getBase64ByteSize(str) {
	if (typeof str !== "string") return 0;
	if (str.startsWith("http://") || str.startsWith("https://")) {
		return 0;
	}
	const commaIdx = str.indexOf(",");
	const data = commaIdx !== -1 ? str.slice(commaIdx + 1) : str;
	const len = data.length;
	let padding = 0;
	if (data.endsWith("==")) padding = 2;
	else if (data.endsWith("=")) padding = 1;
	return Math.floor((len * 3) / 4) - padding;
}

/**
 * Registra rotas de serviços de Inteligência Artificial, transcrição, imagens, TTS, moderação NSFW e provedores
 * Arquivo: src/BotAPI/routes/servicesRoutes.js
 *
 * Rotas registradas:
 * - POST /api/stt/transcrever       - Transcreve áudio/vídeo enviado via Whisper API
 * - GET  /api/stt/status/:jobId     - Consulta o status de um job de transcrição assíncrona
 * - POST /api/imagine/generate      - Proxy de geração de imagens via Bonsai/SD
 * - POST /api/tts/generate          - Proxy de síntese de voz (TTS) via F5-TTS
 * - GET  /api/services/status       - Retorna o status em cache dos serviços externos (LLM, Whisper, F5TTS, etc.)
 * - POST /api/nsfw-detect           - Detecção de conteúdo adulto/NSFW via NudeNet e LLM Vision
 * - GET  /api/service-providers     - Consulta a lista e configuração dos provedores externos de IA
 * - POST /api/service-providers     - Atualiza os provedores de serviços externos de IA
 * - GET  /api/llm/queue             - Consulta o status da fila de requisições LLM
 * - POST /api/llm/queue/clear       - Limpa a fila de requisições pendentes da LLM
 * - GET  /api/llm/stats             - Estatísticas de uso da LLM por período
 * - GET  /llm-stats                 - Estatísticas e ações rápidas sobre a LLM (?clear, ?sendReport, ?queue)
 * - POST /api/llm/report/send       - Envio manual do relatório diário de uso de IA
 * - GET  /api/public-commands       - Retorna o catálogo categorizado de comandos públicos do bot
 *
 * @param {Object} api - Instância da BotAPI
 */
function registerServicesRoutes(api) {
	const app = api.app;

	// STT API
	app.post(
		"/api/stt/transcrever",
		api.externalAuth.requireAccess("stt"),
		api.strictLimiter,
		upload.single("audio"),
		async (req, res) => {
			if (!req.file) {
				return res.status(400).json({ error: "Nenhum arquivo enviado." });
			}

			const providers = api.serviceProviderService.getProviders("whisper");
			if (
				providers.length === 0 ||
				(api.lastServicesStatus && api.lastServicesStatus.whisper === "down")
			) {
				return res.status(503).json({ error: "Serviço de transcrição não disponível." });
			}

			const jobId = uuidv4();
			const apiUser = req.apiUser || null;
			const job = {
				id: jobId,
				status: "starting",
				estimatedTime: 0,
				result: null,
				error: null,
				startTime: Date.now(),
				apiUser
			};
			api.sttJobs.set(jobId, job);

			(async () => {
				let finalPath = req.file.path;
				const filesToCleanup = [req.file.path];

				try {
					if (req.file.mimetype.startsWith("video/")) {
						job.status = "processing";
						const audioPath = req.file.path + ".mp3";
						await new Promise((resolve, reject) => {
							ffmpeg(req.file.path)
								.toFormat("mp3")
								.audioBitrate("64k")
								.on("error", reject)
								.on("end", resolve)
								.save(audioPath);
						});
						finalPath = audioPath;
						filesToCleanup.push(audioPath);
					}

					await SpeechCommands.transcribeViaAPI(
						finalPath,
						(duration, estimatedTime) => {
							job.status = "transcribing";
							job.estimatedTime = estimatedTime;
						},
						(status, executionId) => {
							job.status = status;
							job.executionId = executionId;
						}
					)
						.then(async (result) => {
							job.status = "complete";
							job.result = result.text;

							try {
								const duration =
									result.duration || (await SpeechCommands.getAudioDuration(finalPath));
								const text = result.text || "";
								const chars = text.length;
								const words = text.trim() ? text.trim().split(/\s+/).length : 0;
								const processingTime = Date.now() - job.startTime;

								await api.database.dbRun(
									"media_stats",
									`INSERT INTO speech_transcription_stats (timestamp, duration_sec, char_count, word_count, processing_time_ms, api_user) VALUES (?, ?, ?, ?, ?, ?)`,
									[Date.now(), duration, chars, words, processingTime, job.apiUser || null]
								);
							} catch (trackErr) {
								api.logger.error("Erro ao registrar estatísticas de STT Web:", trackErr);
							}
						})
						.catch((err) => {
							job.status = "error";
							job.error = err.message;
						});
				} catch (err) {
					api.logger.error("Erro no processamento de STT:", err);
					job.status = "error";
					job.error = "Erro ao processar arquivo: " + err.message;
				} finally {
					for (const f of filesToCleanup) {
						await fs.unlink(f).catch(() => {});
					}
				}
			})();

			res.json({ jobId });
		}
	);

	// Imagine API (Proxy)
	app.post(
		"/api/imagine/generate",
		api.externalAuth.requireAccess("imagine"),
		api.strictLimiter,
		async (req, res) => {
			const { prompt } = req.body;

			if (!prompt || prompt.trim().length < 4) {
				return res.status(400).json({ error: "Prompt muito curto ou ausente." });
			}

			if (prompt.length > 1000) {
				return res.status(400).json({ error: "Prompt muito longo (máximo 1000 caracteres)." });
			}

			const providers = api.serviceProviderService.getProviders("bonsai");
			if (
				providers.length === 0 ||
				(api.lastServicesStatus && api.lastServicesStatus.imagine === "down")
			) {
				return res.status(503).json({ error: "Serviço de geração de imagens não disponível." });
			}

			try {
				const bonsaiUrl = providers[0].url;
				const aesthetic = "\n\n(Aesthetic: Gothic, lightly purple-ish tinted atmosphere, cartoony)";

				api.logger.info(
					`Web request: Gerando imagem com Bonsai, prompt: '${prompt}'${req.apiUser ? ` | User: ${req.apiUser}` : ""}`
				);

				const response = await axios.post(
					`${bonsaiUrl}/generate`,
					{
						prompt: prompt + aesthetic,
						width: 1024,
						height: 1024,
						seed: Math.floor(Math.random() * 9999999),
						steps: 6,
						guidance: 3.5
					},
					{
						responseType: "arraybuffer",
						timeout: 60000
					}
				);

				const { trackBonsaiStats } = require("../../functions/BonsaiCommands");
				if (trackBonsaiStats) {
					trackBonsaiStats("1024x1024", 1, "bonsai-ternary", true, req.apiUser || null);
				}

				res.set("Content-Type", "image/jpeg");
				res.send(response.data);
			} catch (error) {
				api.logger.error("Erro na API de geração de imagem:", error);
				const { trackBonsaiStats } = require("../../functions/BonsaiCommands");
				if (trackBonsaiStats) {
					trackBonsaiStats("1024x1024", 1, "bonsai-ternary", false, req.apiUser || null);
				}
				res.status(500).json({ error: "Erro ao gerar imagem: " + error.message });
			}
		}
	);

	// TTS API (Proxy)
	app.post(
		"/api/tts/generate",
		api.externalAuth.requireAccess("tts"),
		api.strictLimiter,
		async (req, res) => {
			const { text, voice } = req.body;

			if (!text || text.trim().length < 1) {
				return res.status(400).json({ error: "Texto ausente." });
			}

			if (text.length > 1000) {
				return res.status(400).json({ error: "Texto muito longo (máximo 1000 caracteres)." });
			}

			const providers = api.serviceProviderService.getProviders("f5tts");
			if (
				providers.length === 0 ||
				(api.lastServicesStatus && api.lastServicesStatus.f5tts === "down")
			) {
				return res.status(503).json({ error: "Serviço de TTS não disponível." });
			}

			const startTime = Date.now();

			try {
				const f5ttsUrl = providers[0].url || "http://localhost:5050";
				const f5ttsApiKey = providers[0].apiKey || "";
				const apiUrl = `${f5ttsUrl}/v1/audio/speech`;

				api.logger.info(
					`Web request: Gerando TTS com voz ${voice}, texto: '${text.substring(0, 30)}...'${req.apiUser ? ` | User: ${req.apiUser}` : ""}`
				);

				const audioResponse = await axios({
					method: "post",
					url: apiUrl,
					data: {
						model: "f5-tts",
						input: text,
						voice: voice || "ravena",
						response_format: "mp3"
					},
					headers: {
						"Content-Type": "application/json",
						...(f5ttsApiKey ? { Authorization: `Bearer ${f5ttsApiKey}` } : {})
					},
					responseType: "arraybuffer"
				});

				try {
					const processingTime = Date.now() - startTime;
					const chars = text.length;
					const words = text.trim().split(/\s+/).length;
					const durationSec = Math.max(1, words / 2.5);

					await api.database.dbRun(
						"media_stats",
						`INSERT INTO speech_generation_stats (timestamp, char_count, word_count, duration_sec, processing_time_ms, api_user) VALUES (?, ?, ?, ?, ?, ?)`,
						[Date.now(), chars, words, durationSec, processingTime, req.apiUser || null]
					);
				} catch (statErr) {
					api.logger.error("Erro ao salvar estatísticas de TTS Web:", statErr);
				}

				res.set("Content-Type", "audio/mpeg");
				res.send(audioResponse.data);
			} catch (error) {
				api.logger.error("Erro na API de TTS:", error);
				res.status(500).json({ error: "Erro ao gerar áudio: " + error.message });
			}
		}
	);

	// Status de job STT
	app.get("/api/stt/status/:jobId", (req, res) => {
		const job = api.sttJobs.get(req.params.jobId);
		if (!job) {
			return res.status(404).json({ error: "Job não encontrado." });
		}
		res.json(job);
	});

	// Status dos serviços externos
	app.get("/api/services/status", (req, res) => {
		res.json(
			api.lastServicesStatus || {
				whisper: "unknown",
				imagine: "unknown",
				f5tts: "unknown",
				llm: "unknown",
				nudenet: "unknown"
			}
		);
	});

	// Middleware para processar multipart/form-data na detecção NSFW
	const handleNsfwUpload = (req, res, next) => {
		if (!req.is("multipart/form-data")) {
			return next();
		}

		uploadNsfw.any()(req, res, async (err) => {
			if (err) {
				if (Array.isArray(req.files)) {
					for (const f of req.files) {
						if (f.path) {
							try {
								await fs.unlink(f.path);
							} catch {
								/* ignore */
							}
						}
					}
				}
				if (err instanceof multer.MulterError) {
					if (err.code === "LIMIT_FILE_SIZE") {
						return res.status(413).json({
							error: "Tamanho do arquivo excede o limite máximo permitido de 3MB."
						});
					}
					if (err.code === "LIMIT_FILE_COUNT") {
						return res.status(400).json({
							error: "Limite de arquivos excedido. Máximo de 16 imagens por requisição."
						});
					}
					return res.status(400).json({ error: `Erro no upload: ${err.message}` });
				}
				return res.status(400).json({ error: err.message || "Erro no upload do arquivo." });
			}
			next();
		});
	};

	// Detecção de conteúdo NSFW
	app.post("/api/nsfw-detect", handleNsfwUpload, async (req, res) => {
		const filesToCleanup = [];
		const targetImages = [];

		try {
			if (Array.isArray(req.files) && req.files.length > 0) {
				for (const file of req.files) {
					filesToCleanup.push(file.path);
					const fileBuffer = await fs.readFile(file.path);
					const mime = file.mimetype || "image/jpeg";
					targetImages.push(`data:${mime};base64,${fileBuffer.toString("base64")}`);
				}
			}

			const { image, images, threshold, isSticker } = req.body || {};
			if (images) {
				if (Array.isArray(images)) {
					targetImages.push(...images);
				} else if (typeof images === "string") {
					targetImages.push(images);
				}
			}
			if (image) {
				if (Array.isArray(image)) {
					targetImages.push(...image);
				} else if (typeof image === "string") {
					targetImages.push(image);
				}
			}

			if (targetImages.length === 0) {
				return res.status(400).json({
					error:
						"Campo 'image' (string base64/URL), 'images' (array) ou arquivo via upload (multipart/form-data) é obrigatório."
				});
			}

			if (targetImages.length > 16) {
				return res.status(400).json({
					error: "Limite excedido. Máximo de 16 imagens por requisição."
				});
			}

			for (const item of targetImages) {
				if (typeof item === "string") {
					if (item.startsWith("http://") || item.startsWith("https://")) {
						try {
							const headRes = await axios.head(item, { timeout: 3000 });
							const contentLength = parseInt(headRes.headers["content-length"], 10);
							if (!isNaN(contentLength) && contentLength > MAX_NSFW_FILE_SIZE) {
								return res.status(413).json({
									error: "Tamanho do arquivo na URL excede o limite máximo permitido de 3MB."
								});
							}
						} catch {
							/* ignore */
						}
					} else {
						const byteSize = getBase64ByteSize(item);
						if (byteSize > MAX_NSFW_FILE_SIZE) {
							return res.status(413).json({
								error: "Tamanho do arquivo excede o limite máximo permitido de 3MB."
							});
						}
					}
				}
			}

			const NSFWPredict = require("../../utils/NSFWPredict");
			const nsfwPredict = NSFWPredict.getInstance();

			if (!nsfwPredict.isAvailable()) {
				return res.status(503).json({
					error: "Serviço de detecção NSFW indisponível no momento.",
					skipped: true
				});
			}

			const context = {};
			if (threshold !== undefined && !isNaN(threshold)) {
				context.threshold = parseFloat(threshold);
			}
			if (isSticker !== undefined) {
				context.isSticker = isSticker === true || isSticker === "true" || isSticker === "1";
			}

			const result = await nsfwPredict.detectNSFW(targetImages, context);
			api.broadcastSSE("activity", { service: "nudenet" });
			return res.json({
				success: true,
				isNSFW: Boolean(result.isNSFW),
				reason: result.reason || "",
				detections: result.detections || [],
				skipped: Boolean(result.skipped)
			});
		} catch (err) {
			api.logger.error("Erro na API pública /api/nsfw-detect:", err);
			return res.status(500).json({ error: "Erro ao processar verificação NSFW." });
		} finally {
			for (const filePath of filesToCleanup) {
				try {
					await fs.unlink(filePath);
				} catch {
					/* ignore */
				}
			}
		}
	});

	// Service Providers CRUD
	app.get("/api/service-providers", api.authenticateBasic, api.strictLimiter, (req, res) => {
		res.json(api.serviceProviderService.getConfig());
	});

	app.post("/api/service-providers", api.authenticateBasic, api.strictLimiter, async (req, res) => {
		try {
			const newConfig = req.body;
			await api.serviceProviderService.saveConfig(newConfig);

			const LLMService = require("../../services/LLMService");
			LLMService.getInstance().buildProviders();

			res.json({ status: "ok", message: "Configuration saved successfully" });
		} catch (error) {
			api.logger.error("Error saving service providers via API:", error);
			res.status(500).json({ status: "error", message: error.message });
		}
	});

	// Status da fila da LLM
	app.get("/api/llm/queue", api.authenticateBasic, api.strictLimiter, (req, res) => {
		const LLMService = require("../../services/LLMService");
		res.json({
			status: "ok",
			queues: LLMService.getInstance().getQueueStatus()
		});
	});

	// Limpar fila da LLM
	app.post("/api/llm/queue/clear", api.authenticateBasic, api.strictLimiter, (req, res) => {
		const LLMService = require("../../services/LLMService");
		const reason = req.body?.reason || "Limpo via API /api/llm/queue/clear";
		const cleared = LLMService.getInstance().clearQueue(reason);
		res.json({
			status: "ok",
			cleared,
			queues: LLMService.getInstance().getQueueStatus()
		});
	});

	// Estatísticas da LLM (última hora por padrão)
	app.get("/api/llm/stats", api.authenticateBasic, api.strictLimiter, async (req, res) => {
		try {
			const LLMService = require("../../services/LLMService");
			const timeframe =
				req.query.timeframe !== undefined ? parseInt(req.query.timeframe, 10) : 60 * 60 * 1000;
			const stats = await LLMService.getInstance().getStats(timeframe);
			res.json(stats);
		} catch (error) {
			api.logger.error("Error fetching LLM stats via API:", error);
			res.status(500).json({ status: "error", message: error.message });
		}
	});

	// Endpoint para estatísticas de LLM (com suporte a ações rápidas ?clear, ?sendReport, ?queue)
	app.get("/llm-stats", api.authenticateBasic, api.strictLimiter, async (req, res) => {
		try {
			const StatsService = require("../../services/StatsService");
			const statsService = new StatsService();

			if (req.query.clear !== undefined || req.query.clearQueue !== undefined) {
				const cleared = statsService.clearQueue("Limpo via /llm-stats?clear");
				return res.json({
					status: "ok",
					cleared,
					timestamp: Date.now(),
					queue: statsService.getQueueStatus()
				});
			}

			if (req.query.sendReport !== undefined) {
				const LLMDailyReportService = require("../../services/LLMDailyReportService");
				const reportService = LLMDailyReportService.getInstance();
				const result = await reportService.sendReportNow(
					"📊 <b>Relatório de IA (Disparo Manual) — Ravena Bot</b>"
				);
				return res.json({
					status: result.success ? "ok" : "error",
					timestamp: Date.now(),
					report: result
				});
			}

			if (req.query.queue !== undefined) {
				const queueStatus = statsService.getQueueStatus();
				return res.json({
					status: "ok",
					timestamp: Date.now(),
					queue: queueStatus
				});
			}

			const stats = await statsService.getStatsByRange();
			res.json({
				status: "ok",
				timestamp: Date.now(),
				data: stats
			});
		} catch (error) {
			api.logger.error("Erro ao obter estatísticas de LLM:", error);
			res.status(500).json({
				status: "error",
				message: "Erro interno ao buscar estatísticas"
			});
		}
	});

	// Endpoint para envio manual do relatório diário de LLM
	app.post("/api/llm/report/send", api.authenticateBasic, api.strictLimiter, async (req, res) => {
		try {
			const LLMDailyReportService = require("../../services/LLMDailyReportService");
			const reportService = LLMDailyReportService.getInstance();
			const title = req.body?.title || "📊 <b>Relatório de IA (Disparo Manual) — Ravena Bot</b>";
			const result = await reportService.sendReportNow(title);
			return res.json({
				status: result.success ? "ok" : "error",
				timestamp: Date.now(),
				report: result
			});
		} catch (error) {
			api.logger.error("Erro ao disparar relatório diário de LLM:", error);
			return res.status(500).json({
				status: "error",
				message: error.message
			});
		}
	});

	// Comandos públicos catalogados
	app.get("/api/public-commands", (req, res) => {
		if (api.publicCommandsCache) {
			return res.json(api.publicCommandsCache);
		}

		const data = api.updatePublicCommandsCache();
		if (data) {
			return res.json(data);
		}

		if (api.bots.length === 0) {
			return res.status(503).json({ error: "No bots available" });
		}

		res.status(500).json({ error: "Comandos ainda não carregados" });
	});

	// Chat API de Ajuda (LLM Assistant com CommandsHelper)
	app.post(
		"/api/ajuda/chat",
		api.externalAuth.requireAccess("llm"),
		api.strictLimiter,
		async (req, res) => {
			const { message, sessionId } = req.body;

			if (!message || message.trim().length < 2) {
				return res.status(400).json({ error: "Mensagem muito curta ou ausente." });
			}

			try {
				const { askHelp } = require("../../functions/Ajuda");
				const answer = await askHelp(message, sessionId, req.apiUser || null);
				res.json({ answer });
			} catch (error) {
				api.logger.error("Erro na API de ajuda chat:", error);
				res.status(500).json({ error: error.message });
			}
		}
	);
}

module.exports = { registerServicesRoutes };
