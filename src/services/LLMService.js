const axios = require("axios");
const Logger = require("../utils/Logger");
const fs = require("fs");
const path = require("path");
const Database = require("../utils/Database");
const Queue = require("./Queue");
const ServiceProviderService = require("./ServiceProviderService");

/**
 * Serviço para interagir com APIs de LLM
 */
class LLMService {
	/**
	 * Get Singleton Instance
	 * @param {Object} config - Configuration options (only used on first creation)
	 * @returns {LLMService}
	 */
	static getInstance(config = {}) {
		if (!LLMService.instance) {
			LLMService.instance = new LLMService(config);
		}
		return LLMService.instance;
	}

	/**
	 * Cria um novo serviço LLM (Private - use getInstance)
	 * @param {Object} config - Opções de configuração
	 */
	constructor(config = {}) {
		this.logger = new Logger("llm-service");
		this.openAIKey = config.openAIKey ?? process.env.OPENAI_API_KEY;
		this.geminiKey = config.geminiKey ?? process.env.GEMINI_API_KEY;
		this.deepseekKey = config.deepseekKey ?? process.env.DEEPSEEK_API_KEY;
		this.localEndpoint =
			config.localEndpoint ?? process.env.LOCAL_LLM_ENDPOINT ?? "http://localhost:1234";
		this.apiTimeout = config.apiTimeout ?? parseInt(process.env.API_TIMEOUT) ?? 60000;
		this.localModel = process.env.LOCAL_LLM_MODEL ?? "google/gemma-3-12b";
		this.LMStudioToken = process.env.LMSTUDIO_TOKEN ?? "";
		this.ollamaEndpoint =
			config.ollamaEndpoint ?? process.env.OLLAMA_ENDPOINT ?? "http://localhost:11434";
		this.ollamaModel = config.ollamaModel ?? process.env.OLLAMA_MODEL ?? "gemma3:12b";
		this.ollamaTemperature =
			config.ollamaTemperature ?? parseFloat(process.env.OLLAMA_TEMPERATURE) ?? 0.7;
		this.ollamaTopK = config.ollamaTopK ?? parseInt(process.env.OLLAMA_TOP_K);
		this.ollamaTopP = config.ollamaTopP ?? parseFloat(process.env.OLLAMA_TOP_P);

		// Initialize Database for stats
		this.database = Database.getInstance();
		this.DB_NAME = "llm_stats";

		// Queue System
		this.queue = new Queue({ concurrency: 1 });

		this.database.getSQLiteDb(
			this.DB_NAME,
			`
			CREATE TABLE IF NOT EXISTS usage_stats (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				timestamp INTEGER,
				provider TEXT,
				model TEXT,
				request_type TEXT,
				input_tokens INTEGER,
				output_tokens INTEGER,
				is_success INTEGER DEFAULT 1
			);
			CREATE INDEX IF NOT EXISTS idx_timestamp ON usage_stats(timestamp);
			`,
			true
		);

		// Migration: Add is_success column if it doesn't exist
		try {
			this.database
				.dbRun(this.DB_NAME, `ALTER TABLE usage_stats ADD COLUMN is_success INTEGER DEFAULT 1`)
				.catch(() => {}); // Ignore error if column already exists
		} catch (e) {
			// Silent fail on migration error
		}

		this.serviceProviderService = ServiceProviderService.getInstance();
		this.buildProviders();

		this.lastQueueChangeTimestamp = 0;
		this.resetQueueTimeout = 60 * 1000; // 60 segundos
	}

	/**
	 * Constrói a lista de provedores a partir da configuração
	 */
	buildProviders() {
		const llmConfigs = this.serviceProviderService.getProviders("llm");
		this.providerDefinitions = [];

		for (const config of llmConfigs) {
			const providerDef = {
				name: config.name,
				method: async (options) => {
					// Apply config values
					if (config.model) options.model = config.model;
					if (config.temperature !== undefined) options.temperature = config.temperature;
					if (config.top_k !== undefined) options.top_k = config.top_k;
					if (config.top_p !== undefined) options.top_p = config.top_p;
					if (config.timeout_multiplier) {
						options.timeout = options.timeout
							? options.timeout * config.timeout_multiplier
							: 30000 * config.timeout_multiplier;
					}
					if (config.ignoreVideo !== undefined) options.ignoreVideo = config.ignoreVideo;

					const completionOptions = {
						customEndpoint: config.url,
						...options
					};

					let response;
					switch (config.type) {
						case "ollama":
							response = await this.ollamaCompletion(completionOptions);
							if (response && response.message && response.message.content) {
								return response.message.content;
							}
							if (
								response &&
								response.choices &&
								response.choices[0] &&
								response.choices[0].message
							) {
								return response.choices[0].message.content;
							}
							throw new Error(`Resposta inválida ou vazia do Ollama (${config.name})`);
						case "gemini":
							response = await this.geminiCompletion(completionOptions);
							return response.candidates[0].content.parts[0].text;
						case "openai":
						case "deepseek":
						case "lmstudio":
							// Mapping for other types if needed, similar to getCompletionFromSpecificProvider
							const providerMethod = `${config.type}Completion`;
							if (typeof this[providerMethod] === "function") {
								response = await this[providerMethod]({
									...completionOptions,
									useLocal: config.type === "lmstudio"
								});
								// Handle standard OpenAI format
								if (
									response &&
									response.choices &&
									response.choices[0] &&
									response.choices[0].message
								) {
									return response.choices[0].message.content;
								}
								return response;
							}
							throw new Error(`Tipo de provedor não suportado: ${config.type}`);
						default:
							throw new Error(`Tipo de provedor desconhecido: ${config.type}`);
					}
				}
			};
			this.providerDefinitions.push(providerDef);
		}

		// Se não houver provedores habilitados, adiciona o Gemini como fallback se a chave existir
		if (this.providerDefinitions.length === 0 && this.geminiKey) {
			this.providerDefinitions.push({
				name: "gemini-fallback",
				method: async (options) => {
					const response = await this.geminiCompletion(options);
					return response.candidates[0].content.parts[0].text;
				}
			});
		}
		this.providerQueue = [...this.providerDefinitions];
	}

	/**
	 * Updates and logs the token usage to SQLite.
	 * @param {string} provider - The name of the provider.
	 * @param {Object} response - The API response object containing usage data.
	 * @param {string} model - The model used.
	 * @param {Object} options - Original request options (to determine request type).
	 * @param {boolean} isSuccess - Whether the request was successful.
	 * @private
	 */
	async _trackUsage(provider, response, model, options, isSuccess = true) {
		let promptTokens = 0;
		let completionTokens = 0;

		// Determine request type
		let requestType = "text";
		if (options.images && options.images.length > 1) {
			requestType = "video";
		} else if (options.image || (options.images && options.images.length > 0)) {
			requestType = "image";
		}

		// OpenAI / Deepseek / LMStudio
		if (response.usage) {
			promptTokens = response.usage.prompt_tokens || 0;
			completionTokens = response.usage.completion_tokens || 0;
		}
		// Gemini
		else if (response.usageMetadata) {
			promptTokens = response.usageMetadata.promptTokenCount || 0;
			completionTokens = response.usageMetadata.candidatesTokenCount || 0;
		}
		// Ollama (standard /api/chat)
		else if (response.prompt_eval_count !== undefined || response.eval_count !== undefined) {
			promptTokens = response.prompt_eval_count || 0;
			completionTokens = response.eval_count || 0;
		}

		if (promptTokens > 0 || completionTokens > 0) {
			this.logger.info(
				`[TokenUsage][${provider}] Type: ${requestType} | Model: ${model} | In: ${promptTokens} | Out: ${completionTokens}`
			);

			try {
				await this.database.dbRun(
					this.DB_NAME,
					`INSERT INTO usage_stats (timestamp, provider, model, request_type, input_tokens, output_tokens, is_success) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[
						Date.now(),
						provider,
						model,
						requestType,
						promptTokens,
						completionTokens,
						isSuccess ? 1 : 0
					]
				);
			} catch (e) {
				this.logger.error("Error saving LLM stats:", e);
			}
		} else if (!isSuccess) {
			// Track failure even with 0 tokens
			try {
				await this.database.dbRun(
					this.DB_NAME,
					`INSERT INTO usage_stats (timestamp, provider, model, request_type, input_tokens, output_tokens, is_success) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[Date.now(), provider, model, requestType, 0, 0, 0]
				);
			} catch (e) {
				this.logger.error("Error saving LLM failure stats:", e);
			}
		}
	}

	/**
	 * Retorna o status atual da fila de requisições.
	 * @returns {Object} - Objeto com a quantidade de requisições por prioridade.
	 */
	getQueueStatus() {
		return this.queue.getStats();
	}

	/**
	 * Retrieves aggregated usage statistics from the database.
	 * @returns {Promise<Object>} - Aggregated stats.
	 */
	async getStats(timeframeMs = null) {
		try {
			// --- LLM Stats ---
			let query =
				"SELECT provider, request_type, COUNT(*) as total, SUM(CASE WHEN is_success = 1 THEN 1 ELSE 0 END) as requests, SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END) as failures, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens, MIN(timestamp) as min_ts FROM usage_stats";
			const params = [];
			if (timeframeMs) {
				query += " WHERE timestamp > ?";
				params.push(Date.now() - timeframeMs);
			}
			query += " GROUP BY provider, request_type";

			const rows = await this.database.dbAll(this.DB_NAME, query, params);

			const stats = {
				total_requests: 0,
				total_failures: 0,
				total_input_tokens: 0,
				total_output_tokens: 0,
				first_record_timestamp: null,
				by_type: {
					text: { requests: 0, failures: 0, input_tokens: 0, output_tokens: 0 },
					image: { requests: 0, failures: 0, input_tokens: 0, output_tokens: 0 },
					video: { requests: 0, failures: 0, input_tokens: 0, output_tokens: 0 },
					stt: { requests: 0, failures: 0, input_tokens: 0, output_tokens: 0 },
					tts: { requests: 0, failures: 0, input_tokens: 0, output_tokens: 0 }
				},
				by_provider: {}
			};

			for (const row of rows) {
				const type = row.request_type || "text";
				const provider = row.provider || "Unknown";

				stats.total_requests += row.requests;
				stats.total_failures += row.failures;
				stats.total_input_tokens += row.input_tokens;
				stats.total_output_tokens += row.output_tokens;

				if (
					row.min_ts &&
					(!stats.first_record_timestamp || row.min_ts < stats.first_record_timestamp)
				) {
					stats.first_record_timestamp = row.min_ts;
				}

				if (!stats.by_type[type]) {
					stats.by_type[type] = { requests: 0, failures: 0, input_tokens: 0, output_tokens: 0 };
				}
				stats.by_type[type].requests += row.requests;
				stats.by_type[type].failures += row.failures;
				stats.by_type[type].input_tokens += row.input_tokens;
				stats.by_type[type].output_tokens += row.output_tokens;

				if (!stats.by_provider[provider]) {
					stats.by_provider[provider] = {
						requests: 0,
						failures: 0,
						input_tokens: 0,
						output_tokens: 0,
						by_type: {}
					};
				}
				stats.by_provider[provider].requests += row.requests;
				stats.by_provider[provider].failures += row.failures;
				stats.by_provider[provider].input_tokens += row.input_tokens;
				stats.by_provider[provider].output_tokens += row.output_tokens;
				stats.by_provider[provider].by_type[type] = {
					requests: row.requests,
					failures: row.failures,
					input_tokens: row.input_tokens,
					output_tokens: row.output_tokens
				};
			}

			// --- Audio Stats (Transcription & Generation) ---
			const speechProvider = "Speech System";
			const speechParams = timeframeMs ? [Date.now() - timeframeMs] : [];
			const speechFilter = timeframeMs ? " WHERE timestamp > ?" : "";

			// ALWAYS query absolute earliest timestamps across all relevant tables
			// to provide a correct 'since' date for the dashboard.
			const [llmFirst, sttFirst, ttsFirst] = await Promise.all([
				this.database.dbGet(this.DB_NAME, "SELECT MIN(timestamp) as ts FROM usage_stats"),
				this.database.dbGet(
					"media_stats",
					"SELECT MIN(timestamp) as ts FROM speech_transcription_stats"
				),
				this.database.dbGet(
					"media_stats",
					"SELECT MIN(timestamp) as ts FROM speech_generation_stats"
				)
			]);
			const absoluteTimestamps = [llmFirst?.ts, sttFirst?.ts, ttsFirst?.ts].filter((ts) => ts);
			if (absoluteTimestamps.length > 0) {
				const absoluteMin = Math.min(...absoluteTimestamps);
				if (!stats.first_record_timestamp || absoluteMin < stats.first_record_timestamp) {
					stats.first_record_timestamp = absoluteMin;
				}
			}

			try {
				// STT Stats
				const sttAgg = await this.database.dbGet(
					"media_stats",
					`SELECT COUNT(*) as requests, SUM(char_count) as input_tokens, SUM(duration_sec) as duration_sec, MIN(timestamp) as min_ts FROM speech_transcription_stats${speechFilter}`,
					speechParams
				);

				if (sttAgg && sttAgg.requests > 0) {
					if (!stats.by_provider[speechProvider]) {
						stats.by_provider[speechProvider] = {
							requests: 0,
							input_tokens: 0,
							output_tokens: 0,
							by_type: {}
						};
					}

					const data = {
						requests: sttAgg.requests,
						input_tokens: sttAgg.input_tokens || 0,
						output_tokens: 0,
						duration_sec: sttAgg.duration_sec || 0
					};

					stats.total_requests += data.requests;
					stats.total_input_tokens += data.input_tokens;
					stats.by_type.stt.requests += data.requests;
					stats.by_type.stt.input_tokens += data.input_tokens;

					stats.by_provider[speechProvider].requests += data.requests;
					stats.by_provider[speechProvider].input_tokens += data.input_tokens;
					stats.by_provider[speechProvider].by_type.stt = data;

					if (
						sttAgg.min_ts &&
						(!stats.first_record_timestamp || sttAgg.min_ts < stats.first_record_timestamp)
					) {
						stats.first_record_timestamp = sttAgg.min_ts;
					}
				}

				// TTS Stats
				const ttsAgg = await this.database.dbGet(
					"media_stats",
					`SELECT COUNT(*) as requests, SUM(char_count) as output_tokens, MIN(timestamp) as min_ts FROM speech_generation_stats${speechFilter}`,
					speechParams
				);

				if (ttsAgg && ttsAgg.requests > 0) {
					if (!stats.by_provider[speechProvider]) {
						stats.by_provider[speechProvider] = {
							requests: 0,
							input_tokens: 0,
							output_tokens: 0,
							by_type: {}
						};
					}

					const data = {
						requests: ttsAgg.requests,
						input_tokens: 0,
						output_tokens: ttsAgg.output_tokens || 0
					};

					stats.total_requests += data.requests;
					stats.total_output_tokens += data.output_tokens;
					stats.by_type.tts.requests += data.requests;
					stats.by_type.tts.output_tokens += data.output_tokens;

					stats.by_provider[speechProvider].requests += data.requests;
					stats.by_provider[speechProvider].output_tokens += data.output_tokens;
					stats.by_provider[speechProvider].by_type.tts = data;

					if (
						ttsAgg.min_ts &&
						(!stats.first_record_timestamp || ttsAgg.min_ts < stats.first_record_timestamp)
					) {
						stats.first_record_timestamp = ttsAgg.min_ts;
					}
				}
			} catch (speechErr) {
				this.logger.error("Error getting optimized speech stats:", speechErr);
			}

			return stats;
		} catch (err) {
			this.logger.error("Error getting optimized LLM stats:", err);
			return null;
		}
	}

	/**
	 * Envia uma solicitação de completion para API Gemini
	 * @param {Object} options - Opções de solicitação
	 * @param {string} options.prompt - O texto do prompt
	 * @param {string} [options.model='gemini-2.5-flash-lite'] - O modelo a usar
	 * @param {number} [options.maxTokens=1000] - Número máximo de tokens a gerar
	 * @param {number} [options.temperature=0.7] - Temperatura de amostragem
	 * @returns {Promise<Object>} - A resposta da API
	 */
	async geminiCompletion(options) {
		try {
			if (!this.geminiKey) {
				this.logger.error("Chave da API Gemini não configurada");
				throw new Error("Chave da API Gemini não configurada");
			}

			const model = "gemini-2.5-flash-lite";
			this.logger.debug("[LLMService] Enviando solicitação para API Gemini:", {
				model,
				promptLength: options.prompt.length,
				maxTokens: options.maxTokens ?? 5000
			});

			this.logger.info(
				`[LLMService][geminiCompletion] Prompt: ${this.summarizeString(options.prompt)}`
			);

			// Endpoint da API Gemini
			const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.geminiKey}`;

			// Prepare parts with text prompt
			const parts = [{ text: options.prompt }];

			// Handle images if present
			if (options.images || options.image) {
				let imagesToProcess = options.images ? options.images : [options.image];

				if (options.ignoreVideo) {
					imagesToProcess = [imagesToProcess[0]];
				}

				for (const img of imagesToProcess) {
					let base64Image;
					let mimeType = "image/jpeg"; // Default fallback

					if (img.startsWith("data:image")) {
						// Attempt to extract mime type from data URI
						const matches = img.match(/^data:(.+);base64,(.+)$/);
						if (matches) {
							mimeType = matches[1];
							base64Image = matches[2];
						} else {
							// Simple fallback if regex fails but starts with data:image
							base64Image = img.split(",")[1];
						}
					} else if (fs.existsSync(img)) {
						base64Image = fs.readFileSync(img, "base64");
						const ext = path.extname(img).toLowerCase().replace(".", "");
						if (ext === "png") mimeType = "image/png";
						else if (ext === "webp") mimeType = "image/webp";
						else if (ext === "heic") mimeType = "image/heic";
						else if (ext === "heif") mimeType = "image/heif";
						// default remains jpeg
					} else {
						// Assume raw base64 string
						base64Image = img;
					}

					if (base64Image) {
						parts.push({
							inline_data: {
								mime_type: mimeType,
								data: base64Image
							}
						});
					}
				}
			}

			const response = await axios.post(
				endpoint,
				{
					contents: [{ role: "user", parts }],
					system_instruction: {
						parts: [
							{
								text:
									options.systemContext ??
									"Você é ravena, um bot de whatsapp criado por moothz. Não se apresente, a menos que solicitado pelo usuário."
							}
						]
					},
					generationConfig: {
						maxOutputTokens: options.maxTokens ?? 5000,
						temperature: options.temperature ?? 0.7
					}
				},
				{
					headers: {
						"Content-Type": "application/json"
					},
					timeout: options.timeout ?? this.apiTimeout
				}
			);

			// this.logger.debug('Resposta recebida da API Gemini', {
			//	 status: response.status,
			//	 contentLength: JSON.stringify(response.data).length
			// });

			this._trackUsage("Gemini", response.data, model, options);

			return response.data;
		} catch (error) {
			this.logger.error("[LLMService] Erro ao chamar API Gemini:", error.message);
			if (error.response) {
				this.logger.error(
					"[LLMService] Gemini API Response Error:",
					JSON.stringify(error.response.data)
				);
			}
			throw error;
		}
	}

	/**
	 * Envia uma solicitação de completion para API Deepseek
	 * @param {Object} options - Opções de solicitação
	 * @param {string} options.prompt - O texto do prompt
	 * @param {string} [options.model='deepseek-chat'] - O modelo a usar
	 * @param {number} [options.maxTokens=1000] - Número máximo de tokens a gerar
	 * @param {number} [options.temperature=0.7] - Temperatura de amostragem
	 * @param {string} [options.version='v3'] - Versão da API (v1 para R1, v3 para Chat V3)
	 * @returns {Promise<Object>} - A resposta da API
	 */
	async deepseekCompletion(options) {
		try {
			if (!this.deepseekKey) {
				this.logger.error("Chave da API Deepseek não configurada");
				throw new Error("Chave da API Deepseek não configurada");
			}

			const model = options.version === "v1" ? "deepseek-coder" : "deepseek-chat";
			const baseUrl = `https://api.deepseek.com/${options.version ?? "v3"}`;

			this.logger.debug("Enviando solicitação para API Deepseek:", {
				model,
				version: options.version ?? "v3",
				promptLength: options.prompt.length,
				maxTokens: options.maxTokens ?? 5000
			});

			const response = await axios.post(
				`${baseUrl}/chat/completions`,
				{
					model,
					messages: [{ role: "user", content: options.prompt }],
					max_tokens: options.maxTokens ?? 5000,
					temperature: options.temperature ?? 0.7
				},
				{
					headers: {
						Authorization: `Bearer ${this.deepseekKey}`,
						"Content-Type": "application/json"
					},
					timeout: options.timeout ?? this.apiTimeout
				}
			);

			// this.logger.debug('Resposta recebida da API Deepseek', {
			//	 status: response.status,
			//	 contentLength: JSON.stringify(response.data).length
			// });

			this._trackUsage("Deepseek", response.data, model, options);

			return response.data;
		} catch (error) {
			this.logger.error("Erro ao chamar API Deepseek:", error.message);
			throw error;
		}
	}

	/**
	 * Envia uma solicitação de completion para OpenAI (ou LM Studio local)
	 * @param {Object} options - Opções de solicitação
	 * @param {string} options.prompt - O texto do prompt
	 * @param {string} [options.model='gpt-3.5-turbo'] - O modelo a usar
	 * @param {number} [options.maxTokens=1000] - Número máximo de tokens a gerar
	 * @param {number} [options.temperature=0.7] - Temperatura de amostragem
	 * @param {boolean} [options.useLocal=false] - Se deve usar o endpoint LM Studio local
	 * @returns {Promise<Object>} - A resposta da API
	 */
	async openAICompletion(options) {
		try {
			// Determina endpoint e chave da API com base em local ou remoto
			const endpoint = options.useLocal
				? `${options.customEndpoint ?? this.localEndpoint}/chat/completions`
				: "https://api.openai.com/v1/chat/completions";

			const apiKey = options.useLocal ? `Basic ${this.LMStudioToken}` : `Bearer ${this.openAIKey}`;

			if (!options.useLocal && !this.openAIKey) {
				this.logger.error("Chave da API OpenAI não configurada");
				throw new Error("Chave da API OpenAI não configurada");
			}

			const model = options.model ?? "gpt-3.5-turbo";

			this.logger.debug(
				`Enviando solicitação para API ${options.useLocal ? "LM Studio Local" : "OpenAI"}:`,
				{
					endpoint,
					model,
					promptLength: options.prompt.length,
					maxTokens: options.maxTokens ?? 5000
				}
			);

			const ctxInclude =
				options.systemContext ??
				"Você é ravena, um bot de whatsapp criado por moothz. Não se apresente, a menos que solicitado pelo usuário.";

			const response = await axios.post(
				endpoint,
				{
					model,
					messages: [
						{ role: "system", content: ctxInclude },
						{ role: "user", content: options.prompt }
					],
					max_tokens: options.maxTokens ?? 5000,
					temperature: options.temperature ?? 0.7
				},
				{
					headers: {
						Authorization: apiKey,
						"Content-Type": "application/json"
					},
					timeout: options.timeout ?? this.apiTimeout
				}
			);

			// this.logger.debug(`Resposta recebida da API ${options.useLocal ? 'LM Studio Local' : 'OpenAI'}`, {
			//	 status: response.status,
			//	 contentLength: JSON.stringify(response.data).length
			// });

			this._trackUsage(options.useLocal ? "Local" : "OpenAI", response.data, model, options);

			return response.data;
		} catch (error) {
			this.logger.error(
				`Erro ao chamar API ${options.useLocal ? "LM Studio Local" : "OpenAI"}:`,
				error.message
			);
			throw error;
		}
	}

	/**
	 * Envia uma solicitação de completion para o LM Studio usando a API /api/v0.
	 * Para entradas de imagem, é mais eficiente fornecer a imagem já em formato base64.
	 * @param {Object} options - Opções de solicitação
	 * @param {string} options.prompt - O texto do prompt
	 * @param {string} [options.model] - O modelo a usar (caminho do modelo no LM Studio)
	 * @param {number} [options.maxTokens=4096] - Número máximo de tokens a gerar
	 * @param {number} [options.temperature=0.7] - Temperatura de amostragem
	 * @param {string} [options.image] - Imagem para entrada de visão (em base64 ou caminho do arquivo).
	 * @param {string} [options.systemContext] - Contexto do sistema
	 * @returns {Promise<Object>} - A resposta da API
	 */
	async lmstudioCompletion(options) {
		try {
			const endpoint = (options.customEndpoint ?? this.localEndpoint) + "/api/v0/chat/completions";

			const messages = [];
			const systemContext =
				options.systemContext ??
				"Você é ravena, um bot de whatsapp criado por moothz. Não se apresente, a menos que solicitado pelo usuário.";
			messages.push({ role: "system", content: systemContext });

			const userMessage = { role: "user" };

			if (options.image) {
				userMessage.content = [{ type: "text", text: options.prompt }];
				let image_url;

				if (options.image.startsWith("data:image")) {
					image_url = options.image;
				} else if (fs.existsSync(options.image)) {
					const fileContent = fs.readFileSync(options.image, "base64");
					const mimeType = path.extname(options.image).replace(".", "") ?? "jpeg";
					image_url = `data:image/${mimeType};base64,${fileContent}`;
				} else {
					image_url = `data:image/jpeg;base64,${options.image}`;
				}

				userMessage.content.push({
					type: "image_url",
					image_url: { url: image_url }
				});
			} else {
				userMessage.content = options.prompt;
			}

			messages.push(userMessage);

			const model = options.model ?? this.localModel;
			const queryOptions = {
				model,
				messages,
				max_tokens: options.maxTokens ?? 8096,
				temperature: options.temperature ?? 0.7,
				stream: false
			};

			//this.logger.debug('[LLMService][lmstudioCompletion] Enviando solicitação para API LM Studio:', queryOptions);

			if (options.response_format) {
				queryOptions.response_format = options.response_format;
			}

			const response = await axios.post(endpoint, queryOptions, {
				headers: {
					Authorization: `Bearer ${this.LMStudioToken}`,
					"Content-Type": "application/json"
				},
				timeout: options.timeout ?? this.apiTimeout
			});

			this._trackUsage("LMStudio", response.data, model, options);

			return response.data;
		} catch (error) {
			this.logger.error("[LLMService] Erro ao chamar API LM Studio:", error.message);
			throw error;
		}
	}

	summarizeString(text) {
		if (typeof text !== "string") return "";

		if (text.length <= 200) {
			return text;
		}

		const firstPart = text.slice(0, 100);
		const lastPart = text.slice(-100);

		return `${firstPart}[...]${lastPart}`;
	}

	/**
	 * Limpa a resposta da LLM removendo tags de pensamento e outros artefatos.
	 * @param {string} response - A resposta bruta da LLM.
	 * @returns {string} - A resposta limpa.
	 * @private
	 */
	_cleanResponse(response) {
		if (typeof response !== "string") return response;

		return response
			.replace(/<think>.*?<\/think>/gs, "")
			.replace(/<\|think\|>.*?<channel\|>/gs, "")
			.replace(/<\|thought\|>.*?<\|thought_end\|>/gs, "")
			.replace(/<\/start_of_turn>/g, "")
			.replace(/<\/end_of_turn>/g, "")
			.replace(/<\/blockquote>/g, "")
			.replace(/<\|channel\|>/g, "")
			.replace(/<channel\|>/g, "")
			.replace(/<\|turn\|>/g, "")
			.replace(/<turn\|>/g, "")
			.trim()
			.replace(/^"|"$/g, "");
	}

	/**
	 * Sends a completion request to the Ollama API.
	 * This method handles text, system context, and image inputs.
	 * @param {Object} options - Request options.
	 * @param {string} options.prompt - The text prompt.
	 * @param {string} [options.model] - The model to use (e.g., 'gemma3:12b').
	 * @param {number} [options.maxTokens=8096] - Maximum number of tokens to generate. Ollama uses 'num_predict'.
	 * @param {number} [options.temperature=0.7] - Sampling temperature.
	 * @param {string} [options.image] - Image for vision input (can be a file path or a base64 string).
	 * @param {string} [options.systemContext] - The system context/instruction.
	 * @param {number} [options.timeout] - Request timeout in milliseconds.
	 * @returns {Promise<Object>} - The response from the Ollama API.
	 */
	async ollamaCompletion(options) {
		try {
			const debugPrompt = options.debugPrompt ?? true;

			const endpoint = (options.customEndpoint ?? this.ollamaEndpoint) + "/api/chat";

			const messages = [];
			const systemContext =
				options.systemContext ??
				"Você é ravena, um bot de whatsapp criado por moothz. Não se apresente, a menos que solicitado pelo usuário.";
			messages.push({ role: "system", content: systemContext });

			const userMessage = {
				role: "user",
				content: options.prompt
			};

			if (options.images || options.image) {
				let imagesToProcess = options.images ? options.images : [options.image];
				const processedImages = [];

				if (options.ignoreVideo) {
					imagesToProcess = [imagesToProcess[0]];
				}

				for (const img of imagesToProcess) {
					let base64Image;
					if (img.startsWith("data:image")) {
						base64Image = img.split(",")[1];
					} else if (fs.existsSync(img)) {
						base64Image = fs.readFileSync(img, "base64");
					} else {
						base64Image = img;
					}

					if (base64Image) {
						processedImages.push(base64Image);
					}
				}

				if (processedImages.length > 0) {
					userMessage.images = processedImages;
				}
			}

			messages.push(userMessage);

			let ollamaFormat = null;
			if (options.response_format) {
				if (
					options.response_format.type === "json_schema" &&
					options.response_format.json_schema?.schema
				) {
					ollamaFormat = options.response_format.json_schema.schema;
				} else {
					ollamaFormat = options.response_format;
				}
			}

			const payload = {
				model: options.model ?? this.ollamaModel,
				messages,
				format: ollamaFormat,
				stream: false,
				options: {
					temperature: options.temperature ?? this.ollamaTemperature ?? 0.7,
					num_predict: options.maxTokens ?? 8096,
					top_k: options.top_k ?? this.ollamaTopK,
					top_p: options.top_p ?? this.ollamaTopP
				}
			};

			const toTime = options.timeout ?? this.apiTimeout ?? 60000;
			const debugData = {
				endpoint,
				model: payload.model,
				promptLength: options.prompt.length,
				hasImage: !!options.image,
				hasSchema: !!ollamaFormat, // Log if we are using a schema
				timeout: toTime
			};

			if (debugPrompt) {
				this.logger.debug("[LLMService][ollamaCompletion] Sending request to Ollama API", {
					size: options.prompt.length,
					prompt: this.summarizeString(options.prompt)
				}); // , debugData
			} else {
				this.logger.debug("[LLMService][ollamaCompletion] Sending request to Ollama API");
			}

			const response = await axios.post(endpoint, payload, {
				headers: {
					"Content-Type": "application/json"
				},
				timeout: toTime
			});

			this._trackUsage("Ollama", response.data, payload.model, options);

			return response.data;
		} catch (error) {
			// Enhanced error logging
			this.logger.error("[LLMService] Error calling Ollama API:", error.message);
			if (error.response) {
				//this.logger.error('Ollama API Response Error Data:', error.response.data);
				this.logger.error("[LLMService] Ollama API Response Error:", error.response.status);
			} else if (error.request) {
				this.logger.error("[LLMService] Ollama API No Response Received.");
			}
			throw error;
		}
	}

	/**
	 * Obtém completion de texto de qualquer LLM configurado
	 * @param {Object} options - Opções de solicitação
	 * @param {string} options.prompt - O texto do prompt
	 * @param {string} [options.provider='openai'] - O provedor a usar ('openai', 'gemini', 'deepseek', 'lmstudio', ou 'local')
	 * @param {string} [options.model] - O modelo a usar (específico do provedor)
	 * @param {number} [options.maxTokens=1000] - Número máximo de tokens a gerar
	 * @param {number} [options.temperature=0.7] - Temperatura de amostragem
	 * @param {number} [options.priority=0] - Prioridade da requisição (0-5)
	 * @returns {Promise<string>} - O texto gerado
	 */
	async getCompletion(options) {
		const EventHandler = require("../EventHandler");
		EventHandler.getInstance().emit("activity", { type: "llm" });
		const priority = options.priority ?? 0;
		const maxQueueRetries = 10; // Limit times we can send back to queue

		const task = async () => {
			try {
				// Se um provedor específico for solicitado, use-o diretamente
				if (options.provider) {
					this.logger.debug("[LLMService] Obtendo completion com opções:", {
						provider: options.provider,
						promptLength: options.prompt.length,
						temperature: options.temperature ?? 0.7
					});

					const response = await this.getCompletionFromSpecificProvider(options);
					return this._cleanResponse(response);
				}
				// Caso contrário, tente múltiplos provedores em sequência
				else {
					//this.logger.debug('[LLMService] Nenhum provedor específico solicitado, tentando múltiplos provedores em sequência');

					const response = await this.getCompletionFromProviders(options, priority);
					return this._cleanResponse(response);
				}
			} catch (error) {
				this.logger.error("Erro ao obter completion:", error.message);
				throw error; // Re-throw to be caught by the retry logic below or the queue
			}
		};

		const runWithInstantRetries = async () => {
			let maxInstant = 0;
			if (priority === 5) maxInstant = 5;
			else if (priority === 4) maxInstant = 3;

			let lastErr;
			for (let i = 0; i <= maxInstant; i++) {
				try {
					return await task();
				} catch (e) {
					lastErr = e;
					if (i < maxInstant) {
						this.logger.warn(`[LLMService] Instant retry ${i + 1}/${maxInstant} for P${priority}`);
						// Small delay for instant retry stability
						await new Promise((r) => setTimeout(r, 1000));
					}
				}
			}
			throw lastErr;
		};

		const scheduleRequest = async (attempt, position) => {
			try {
				if (position === undefined) {
					return await this.queue.add(runWithInstantRetries, { priority });
				} else {
					return await this.queue.addAt(runWithInstantRetries, position, { priority });
				}
			} catch (err) {
				if (attempt < maxQueueRetries) {
					let nextPos = -1;
					let shouldRetry = false;

					// 5 -> Instant retry (handled above), then send to back of the queue
					// 4 -> Instant retry (handled above), then send to back of the queue
					if (priority >= 4) {
						shouldRetry = true;
						nextPos = this.queue.size; // Back of queue
					}
					// 3 -> Send 3 positions back in the queue
					else if (priority === 3) {
						shouldRetry = true;
						nextPos = 3;
					}
					// 2 -> Send 5 positions back in the queue
					else if (priority === 2) {
						shouldRetry = true;
						nextPos = 5;
					}

					if (shouldRetry) {
						this.logger.warn(
							`[LLMService] Request failed, re-queueing at pos ${nextPos}. (Queue Attempt ${attempt + 1}/${maxQueueRetries})`
						);
						// Small delay before re-queueing to avoid tight loops on empty queue
						await new Promise((r) => setTimeout(r, 2000));
						return scheduleRequest(attempt + 1, nextPos);
					}
				}

				// If no retry or max retries reached
				return "Erro: Não foi possível gerar uma resposta. Por favor, tente novamente mais tarde.";
			}
		};

		return scheduleRequest(0);
	}

	/**
	 * Obtém completion de um provedor específico
	 * @param {Object} options - Opções de solicitação
	 * @returns {Promise<string>} - O texto gerado
	 * @private
	 */
	async getCompletionFromSpecificProvider(options) {
		let response;

		switch (options.provider) {
			case "lmstudio":
				response = await this.lmstudioCompletion(options);
				if (
					!response ||
					!response.choices ||
					!response.choices[0] ||
					!response.choices[0].message
				) {
					this.logger.error("Resposta inválida da API LM Studio:", response);
					this._trackUsage("LMStudio", {}, options.model || "Unknown", options, false);
					return "Erro: Não foi possível gerar uma resposta. Por favor, tente novamente mais tarde.";
				}
				return response.choices[0].message.content;

			case "ollama":
				response = await this.ollamaCompletion(options);
				if (
					!response ||
					!response.choices ||
					!response.choices[0] ||
					!response.choices[0].message
				) {
					this.logger.error("Resposta inválida da API ollama:", response);
					this._trackUsage("Ollama", {}, options.model || "Unknown", options, false);
					return "Erro: Não foi possível gerar uma resposta. Por favor, tente novamente mais tarde.";
				}
				return response.choices[0].message.content;

			case "gemini":
				response = await this.geminiCompletion(options);
				if (
					!response ||
					!response.candidates ||
					!response.candidates[0] ||
					!response.candidates[0].content ||
					!response.candidates[0].content.parts ||
					!response.candidates[0].content.parts[0]
				) {
					this.logger.error("Resposta inválida da API Gemini:", response);
					this._trackUsage("Gemini", {}, options.model || "Unknown", options, false);
					return "Erro: Não foi possível gerar uma resposta. Por favor, tente novamente mais tarde.";
				}
				return response.candidates[0].content.parts[0].text;

			case "deepseek-r1":
				response = await this.deepseekCompletion({ ...options, version: "v1" });
				if (
					!response ||
					!response.choices ||
					!response.choices[0] ||
					!response.choices[0].message
				) {
					this.logger.error("Resposta inválida da API Deepseek R1:", response);
					this._trackUsage("Deepseek-R1", {}, options.model || "Unknown", options, false);
					return "Erro: Não foi possível gerar uma resposta. Por favor, tente novamente mais tarde.";
				}
				return response.choices[0].message.content;

			case "deepseek":
				response = await this.deepseekCompletion({ ...options, version: "v3" });
				if (
					!response ||
					!response.choices ||
					!response.choices[0] ||
					!response.choices[0].message
				) {
					this.logger.error("Resposta inválida da API Deepseek:", response);
					this._trackUsage("Deepseek", {}, options.model || "Unknown", options, false);
					return "Erro: Não foi possível gerar uma resposta. Por favor, tente novamente mais tarde.";
				}
				return response.choices[0].message.content;

			case "local":
				response = await this.openAICompletion({
					...options,
					useLocal: true,
					model: this.localModel
				});
				if (
					!response ||
					!response.choices ||
					!response.choices[0] ||
					!response.choices[0].message
				) {
					this.logger.error("Resposta inválida da API Local:", response);
					this._trackUsage("Local", {}, options.model || "Unknown", options, false);
					return "Erro: Não foi possível gerar uma resposta. Por favor, tente novamente mais tarde.";
				}
				return response.choices[0].message.content;

			case "openai":
			default:
				response = await this.openAICompletion(options);
				if (
					!response ||
					!response.choices ||
					!response.choices[0] ||
					!response.choices[0].message
				) {
					this.logger.error("Resposta inválida da API OpenAI:", response);
					this._trackUsage("OpenAI", {}, options.model || "Unknown", options, false);
					return "Erro: Não foi possível gerar uma resposta. Por favor, tente novamente mais tarde.";
				}
				return response.choices[0].message.content;
		}
	}

	/**
	 * Tenta múltiplos provedores em sequência até que um funcione
	 * @param {Object} options - Opções de solicitação
	 * @param {number} priority - Prioridade da requisição
	 * @returns {Promise<string>} - O texto gerado pelo primeiro provedor disponível
	 */
	async getCompletionFromProviders(options, priority = 0) {
		const now = Date.now();
		if (
			this.lastQueueChangeTimestamp > 0 &&
			now - this.lastQueueChangeTimestamp > this.resetQueueTimeout
		) {
			this.logger.info(
				`[LLMService] Resetando a fila de provedores para a ordem padrão após ${this.resetQueueTimeout / 1000} segundos.`
			);
			this.providerQueue = [...this.providerDefinitions];
			this.lastQueueChangeTimestamp = 0;
		}

		const totalProviders = this.providerQueue.length;
		if (totalProviders === 0) {
			this.logger.error("Nenhum provedor definido.");
			throw new Error("Erro: Nenhum provedor de IA configurado.");
		}

		// Priority <= 4: Try only the first available provider (no retry/fallback loop on this call).
		// Priority 5: Try all providers (fallback loop).
		const attempts = priority <= 4 ? 1 : totalProviders;

		for (let i = 0; i < attempts; i++) {
			const provider = this.providerQueue[0]; // Sempre tenta o provedor no início da fila
			try {
				this.logger.debug(`[LLMService] Tentando provedor: ${provider.name}`);
				const result = await provider.method(options);

				if (!result || typeof result !== "string" || result.trim() === "") {
					throw new Error("Resposta vazia ou inválida do provedor");
				}

				if (!result.includes("Imagem[")) {
					this.logger.debug(
						`[LLMService] Provedor ${provider.name} retornou resposta com sucesso`,
						{ result: this.summarizeString(result) }
					);
				}

				// O provedor bem-sucedido já está no início da fila, bom para a próxima vez.
				return result;
			} catch (error) {
				this.logger.error(`Erro ao usar provedor ${provider.name}:`, error.message);

				let isGeminiRateLimit = false;
				if (provider.name === "gemini") {
					// Check error details for Rate Limit (429 / RESOURCE_EXHAUSTED)
					if (error.response && error.response.data && error.response.data.error) {
						const errData = error.response.data.error;
						if (errData.code === 429 || errData.status === "RESOURCE_EXHAUSTED") {
							isGeminiRateLimit = true;
							let retrySeconds = 60;
							if (errData.details) {
								const retryInfo = errData.details.find(
									(d) => d["@type"] && d["@type"].includes("RetryInfo")
								);
								if (retryInfo && retryInfo.retryDelay) {
									retrySeconds = parseFloat(retryInfo.retryDelay);
								}
							}
							const waitTime = retrySeconds * 1000 * 10; // 10x longer
							this.logger.warn(
								`[LLMService] Gemini Quota Exceeded. Removing from queue for ${waitTime / 1000}s.`
							);

							this.providerQueue.shift(); // Remove from queue

							setTimeout(() => {
								this.logger.info(`[LLMService] Re-adding Gemini to provider queue.`);
								this.providerQueue.push(provider);
							}, waitTime);
						}
					}
				}

				if (!isGeminiRateLimit) {
					// Rebaixa o provedor que falhou, movendo-o para o final da fila.
					this.logger.warn(
						`[LLMService] Rebaixando provedor ${provider.name} para o final da fila.`
					);
					this._trackUsage(provider.name, {}, "Unknown", options, false);
					this.providerQueue.push(this.providerQueue.shift());
					this.lastQueueChangeTimestamp = Date.now();
				}
			}
		}

		// Se o loop terminar, todos os provedores foram tentados e falharam.
		this.logger.error("Todos os provedores falharam");
		throw new Error(
			"Erro: Não foi possível gerar uma resposta de nenhum provedor disponível. Por favor, tente novamente mais tarde."
		);
	}

	/**
	 * Retorna o status detalhado do serviço LLM, incluindo o modelo ativo e o tempo para reset da fila.
	 * @returns {Object} - Objeto com o status, modelo ativo e segundos para reset.
	 */
	getDetailedStatus() {
		const totalProviders = this.providerQueue.length;
		if (totalProviders === 0) {
			return { status: "down", model: "Nenhum", isPrimary: false, resetSeconds: 0 };
		}

		const activeProvider = this.providerQueue[0];
		const primaryProvider = this.providerDefinitions[0];
		const isPrimary = activeProvider.name === primaryProvider.name;

		let resetSeconds = 0;
		if (!isPrimary && this.lastQueueChangeTimestamp > 0) {
			const elapsed = Date.now() - this.lastQueueChangeTimestamp;
			resetSeconds = Math.max(0, Math.floor((this.resetQueueTimeout - elapsed) / 1000));
		}

		return {
			status: isPrimary ? "up" : "backup",
			model: activeProvider.name,
			isPrimary,
			resetSeconds
		};
	}
}

module.exports = LLMService;
