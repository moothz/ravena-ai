const axios = require("axios");
const cheerio = require("cheerio");
const Logger = require("../utils/Logger");
const fs = require("fs");
const path = require("path");
const Database = require("../utils/Database");
const Queue = require("./Queue");
const ServiceProviderService = require("./ServiceProviderService");
const CommandsHelper = require("../utils/CommandsHelper");

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
		this.apiTimeout = config.apiTimeout ?? 60000;

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
	 * Definição das ferramentas/functions disponíveis para o LLM.
	 * @returns {Array<Object>}
	 */
	getTools() {
		return [
			{
				type: "function",
				function: {
					name: "web_search",
					description:
						"Pesquisa na web por informações atualizadas, notícias, preços, fatos recentes ou respostas para perguntas gerais quando o link exato não for conhecido.",
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description: "Termos ou frase de busca (ex: 'peugeot 207 preco tabela fipe hoje')"
							}
						},
						required: ["query"]
					}
				}
			},
			{
				type: "function",
				function: {
					name: "fetch_web_content",
					description:
						"Busca e extrai o conteúdo textual ou markdown de uma URL da web para obter informações detalhadas ou consultar links completos.",
					parameters: {
						type: "object",
						properties: {
							url: {
								type: "string",
								description: "A URL completa da página web (ex: https://exemplo.com/noticia)"
							}
						},
						required: ["url"]
					}
				}
			},
			{
				type: "function",
				function: {
					name: "commands_helper",
					description:
						"Consulta informações, sintaxe, exemplos de uso, categorias, tags e detalhes técnicos de implementação de comandos e recursos do bot Ravena e de gerenciamento de grupos (!g-).",
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description:
									"Termo de busca, nome do comando ou funcionalidade (ex: 'pesca', 'criar comando personalizado', 'filtros de grupo', 'tts', 'clima')"
							}
						},
						required: ["query"]
					}
				}
			},
			{
				type: "function",
				function: {
					name: "get_current_time",
					description:
						"Retorna a data atual, horário preciso em tempo real, dia da semana, mês, ano e fuso horário oficial (America/Sao_Paulo / UTC-3). Use sempre que precisar saber que dia ou hora é hoje.",
					parameters: {
						type: "object",
						properties: {},
						required: []
					}
				}
			},
			{
				type: "function",
				function: {
					name: "get_weather",
					description:
						"Consulta a previsão do tempo meteorológica detalhada e atualizada em tempo real (temperatura atual, sensação térmica, umidade, vento, chuva e previsão dos próximos dias) para uma cidade ou estado.",
					parameters: {
						type: "object",
						properties: {
							city: {
								type: "string",
								description: "Nome da cidade e opcionalmente estado/país (ex: 'São Paulo', 'Belo Horizonte - MG', 'Lisboa')"
							}
						},
						required: ["city"]
					}
				}
			}
		];
	}

	/**
	 * Decodifica URLs redirecionadas do Bing (formato /ck/a?&u=a1<base64>).
	 * @param {string} rawUrl - URL bruta do Bing
	 * @returns {string} - URL real decodificada
	 * @private
	 */
	_decodeBingUrl(rawUrl) {
		if (!rawUrl) return "";
		if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
			if (rawUrl.includes("bing.com/ck/a?")) {
				const uMatch = rawUrl.match(/[?&]u=a1([^&]+)/);
				if (uMatch) {
					try {
						let base64 = uMatch[1].replace(/[-_]/g, (m) => (m === "-" ? "+" : "/"));
						while (base64.length % 4 !== 0) base64 += "=";
						return Buffer.from(base64, "base64").toString("utf8");
					} catch (e) {}
				}
			}
			return rawUrl;
		}
		return rawUrl;
	}

	/**
	 * Realiza pesquisa na web usando DuckDuckGo com fallbacks para Bing e DDG Instant Answer.
	 * @param {string} query - Termo de busca
	 * @returns {Promise<string>} - Resultados formatados ou mensagem amigável
	 */
	async searchWeb(query) {
		if (!query || typeof query !== "string") {
			return "Nenhum termo de pesquisa fornecido.";
		}

		const cleanQuery = query.trim();
		this.logger.info(`[searchWeb] Iniciando busca web para: "${cleanQuery}"`);

		// Tentativa 1: DuckDuckGo HTML
		try {
			this.logger.info(`[searchWeb] [Tentativa 1 - DuckDuckGo] Buscando "${cleanQuery}"`);
			const res = await axios.get("https://html.duckduckgo.com/html/", {
				params: { q: cleanQuery },
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0",
					Accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
					"Accept-Language": "pt-BR,pt;q=0.8,en-US;q=0.5,en;q=0.3",
					"Sec-Fetch-Dest": "document",
					"Sec-Fetch-Mode": "navigate",
					"Sec-Fetch-Site": "none",
					"Sec-Fetch-User": "?1",
					"Upgrade-Insecure-Requests": "1"
				},
				timeout: 10000
			});

			const $ = cheerio.load(res.data);
			const results = [];
			$(".result").each((i, el) => {
				if (results.length >= 5) return;
				const title = $(el).find(".result__title a").text().trim();
				let rawUrl = $(el).find(".result__title a").attr("href");
				const snippet = $(el).find(".result__snippet").text().trim();
				if (rawUrl && rawUrl.includes("uddg=")) {
					const match = rawUrl.match(/uddg=([^&]+)/);
					if (match) rawUrl = decodeURIComponent(match[1]);
				}
				if (title && rawUrl) {
					results.push({ title, url: rawUrl, snippet });
				}
			});

			if (results.length > 0) {
				this.logger.info(
					`[searchWeb] [Tentativa 1 - DuckDuckGo] Sucesso! ${results.length} resultados encontrados.`
				);
				let formatted = `Resultados da busca web para "${cleanQuery}":\n\n`;
				results.forEach((r, idx) => {
					formatted += `${idx + 1}. **${r.title}**\n   Link: ${r.url}\n`;
					if (r.snippet) formatted += `   Resumo: ${r.snippet}\n`;
					formatted += `\n`;
				});
				return formatted.trim();
			}
		} catch (ddgErr) {
			this.logger.warn(
				`[searchWeb] [Tentativa 1 - DuckDuckGo] Falhou (${ddgErr.message}). Tentando fallback (Bing)...`
			);
		}

		// Tentativa 2: Bing
		try {
			this.logger.info(`[searchWeb] [Tentativa 2 - Bing] Buscando "${cleanQuery}"`);
			const res = await axios.get("https://www.bing.com/search", {
				params: { q: cleanQuery, setlang: "pt-br", setmkt: "pt-BR" },
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					"Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
				},
				timeout: 10000
			});

			const $ = cheerio.load(res.data);
			const results = [];
			$(".b_algo").each((i, el) => {
				if (results.length >= 5) return;
				const title = $(el).find("h2 a").text().trim();
				const rawUrl = $(el).find("h2 a").attr("href");
				const url = this._decodeBingUrl(rawUrl);
				const snippet = $(el).find(".b_caption p, .b_algoSlug, .b_lineclamp2, p").text().trim();
				if (title && url) {
					results.push({ title, url, snippet });
				}
			});

			if (results.length > 0) {
				this.logger.info(
					`[searchWeb] [Tentativa 2 - Bing] Sucesso! ${results.length} resultados encontrados.`
				);
				let formatted = `Resultados da busca web para "${cleanQuery}":\n\n`;
				results.forEach((r, idx) => {
					formatted += `${idx + 1}. **${r.title}**\n   Link: ${r.url}\n`;
					if (r.snippet) formatted += `   Resumo: ${r.snippet}\n`;
					formatted += `\n`;
				});
				return formatted.trim();
			}
		} catch (bingErr) {
			this.logger.warn(`[searchWeb] [Tentativa 2 - Bing] Falhou (${bingErr.message}).`);
		}

		// Tentativa 3: DuckDuckGo Instant Answer API
		try {
			this.logger.info(`[searchWeb] [Tentativa 3 - DDG Instant Answer] Buscando "${cleanQuery}"`);
			const res = await axios.get("https://api.duckduckgo.com/", {
				params: { q: cleanQuery, format: "json", no_html: 1, skip_disambig: 1 },
				headers: {
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
				},
				timeout: 8000
			});

			const results = [];
			if (res.data.AbstractText) {
				results.push({
					title: res.data.Heading || "Resumo",
					url: res.data.AbstractURL || "",
					snippet: res.data.AbstractText
				});
			}
			if (Array.isArray(res.data.RelatedTopics)) {
				for (const topic of res.data.RelatedTopics) {
					if (results.length >= 5) break;
					if (topic.Text) {
						results.push({
							title: topic.Text.slice(0, 50),
							url: topic.FirstURL || "",
							snippet: topic.Text
						});
					}
				}
			}

			if (results.length > 0) {
				this.logger.info(
					`[searchWeb] [Tentativa 3 - DDG Instant Answer] Sucesso! ${results.length} resultados encontrados.`
				);
				let formatted = `Resultados da busca web para "${cleanQuery}":\n\n`;
				results.forEach((r, idx) => {
					formatted += `${idx + 1}. **${r.title}**\n`;
					if (r.url) formatted += `   Link: ${r.url}\n`;
					if (r.snippet) formatted += `   Resumo: ${r.snippet}\n`;
					formatted += `\n`;
				});
				return formatted.trim();
			}
		} catch (ddgApiErr) {
			this.logger.error(`[searchWeb] [Tentativa 3 - DDG API] Falhou: ${ddgApiErr.message}`);
		}

		return `Não foi possível encontrar resultados na pesquisa web para "${cleanQuery}".`;
	}

	/**
	 * Extrai conteúdo de uma URL usando Jina Reader com fallback para Cheerio.
	 * @param {string} url - URL para extração de conteúdo
	 * @returns {Promise<string>} - Conteúdo extraído ou mensagem de erro amigável
	 */
	async fetchWebContent(url) {
		if (!url || typeof url !== "string") {
			return "Não foi possível completar a extração de conteúdo desta URL.";
		}

		let targetUrl = url.trim();
		if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
			targetUrl = `https://${targetUrl}`;
		}

		this.logger.info(`[fetchWebContent] Iniciando busca para URL: ${targetUrl}`);

		// Tentativa 1: Jina Reader (https://r.jina.ai/<URL>)
		try {
			this.logger.info(
				`[fetchWebContent] [Tentativa 1 - Jina Reader] Requisitando https://r.jina.ai/${targetUrl}`
			);
			const headers = {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
			};
			if (process.env.JINA_API_KEY) {
				headers.Authorization = `Bearer ${process.env.JINA_API_KEY.trim()}`;
			}

			const jinaResponse = await axios.get(`https://r.jina.ai/${targetUrl}`, {
				headers,
				timeout: 15000
			});

			if (jinaResponse.status === 200 && jinaResponse.data) {
				const content =
					typeof jinaResponse.data === "string"
						? jinaResponse.data.trim()
						: JSON.stringify(jinaResponse.data);

				if (content.length > 0) {
					this.logger.info(
						`[fetchWebContent] [Tentativa 1 - Jina Reader] Sucesso! Conteúdo extraído (${content.length} caracteres)`
					);
					this.logger.debug(
						`[fetchWebContent] Amostra do conteúdo Jina: ${this.summarizeString(content)}`
					);
					// Limita tamanho para não estourar contexto do modelo
					return content.length > 20000
						? `${content.slice(0, 20000)}\n\n[Conteúdo truncado...]`
						: content;
				}
			}
			throw new Error(`Resposta vazia ou status inválido: ${jinaResponse.status}`);
		} catch (jinaError) {
			this.logger.warn(
				`[fetchWebContent] [Tentativa 1 - Jina Reader] Falhou (${jinaError.message}). Acionando Tentativa 2 (Cheerio)...`
			);

			// Tentativa 2: Cheerio (GET direto na URL e parsing de HTML)
			try {
				this.logger.info(
					`[fetchWebContent] [Tentativa 2 - Cheerio] Requisitando diretamente ${targetUrl}`
				);
				const directResponse = await axios.get(targetUrl, {
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
						Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
					},
					timeout: 15000
				});

				if (directResponse.status === 200 && directResponse.data) {
					const html = typeof directResponse.data === "string" ? directResponse.data : "";
					if (html.length > 0) {
						const $ = cheerio.load(html);

						// Remover tags de lixo
						$("script, style, nav, footer, header, noscript, iframe, svg").remove();

						// Extrair texto útil
						let extractedText = "";
						const article = $("article, main");
						if (article.length > 0) {
							extractedText = article.text();
						} else {
							extractedText = $("body").text();
						}

						// Limpar espaços em branco excessivos
						const cleanedText = extractedText
							.replace(/[ \t]+/g, " ")
							.replace(/\n\s*\n+/g, "\n\n")
							.trim();

						if (cleanedText.length > 0) {
							this.logger.info(
								`[fetchWebContent] [Tentativa 2 - Cheerio] Sucesso! Conteúdo extraído (${cleanedText.length} caracteres)`
							);
							this.logger.debug(
								`[fetchWebContent] Amostra do conteúdo Cheerio: ${this.summarizeString(cleanedText)}`
							);
							return cleanedText.length > 20000
								? `${cleanedText.slice(0, 20000)}\n\n[Conteúdo truncado...]`
								: cleanedText;
						}
					}
				}
				throw new Error(
					`Cheerio não conseguiu extrair texto da página (status ${directResponse.status})`
				);
			} catch (cheerioError) {
				this.logger.error(
					`[fetchWebContent] [Tentativa 2 - Cheerio] Falhou (${cheerioError.message}). Acionando Fallback Seguro...`
				);

				// Tentativa 3: Fallback Seguro
				return "Não foi possível completar a extração de conteúdo desta URL.";
			}
		}
	}

	/**
	 * Consulta a documentação de comandos e funcionalidades da Ravena via CommandsHelper
	 * @param {string} query - Termo de busca
	 * @returns {Promise<string>}
	 */
	async searchCommands(query) {
		try {
			this.logger.info(`[searchCommands] Consultando CommandsHelper para: "${query}"`);
			const helperInstance = CommandsHelper.getInstance();
			const result = helperInstance.search(query);
			return result;
		} catch (error) {
			this.logger.error(`[searchCommands] Erro ao consultar comandos: ${error.message}`);
			return "Erro ao consultar informações dos comandos no momento.";
		}
	}

	/**
	 * Despacha e executa uma chamada de ferramenta com tratamento unificado de erros
	 * @param {string} fnName - Nome da função chamada pelo modelo
	 * @param {Object} args - Argumentos passados
	 * @returns {Promise<string>}
	 */
	async executeToolCall(fnName, args = {}) {
		try {
			if (fnName === "web_search") {
				this.logger.info(`[LLMService] Executando web_search para: "${args.query}"`);
				const res = await this.searchWeb(args.query);
				this.logger.info(`[LLMService] Resultado do web_search (${res.length} caracteres)`);
				return res;
			}

			if (fnName === "fetch_web_content") {
				this.logger.info(`[LLMService] Executando fetch_web_content para URL: ${args.url}`);
				const res = await this.fetchWebContent(args.url);
				this.logger.info(`[LLMService] Resultado do fetch_web_content (${res.length} caracteres)`);
				return res;
			}

			if (fnName === "commands_helper") {
				this.logger.info(`[LLMService] Executando commands_helper para: "${args.query}"`);
				const res = await this.searchCommands(args.query);
				this.logger.info(`[LLMService] Resultado do commands_helper (${res.length} caracteres)`);
				return res;
			}

			if (fnName === "get_current_time") {
				this.logger.info("[LLMService] Executando get_current_time");
				const res = this.getCurrentTime();
				this.logger.info(`[LLMService] Resultado de get_current_time: ${res}`);
				return res;
			}

			if (fnName === "get_weather") {
				this.logger.info(`[LLMService] Executando get_weather para: "${args.city}"`);
				const res = await this.getWeather(args.city);
				this.logger.info(`[LLMService] Resultado de get_weather (${res.length} caracteres)`);
				return res;
			}

			if (typeof this[fnName] === "function") {
				return await this[fnName](args);
			}

			return "Ferramenta não reconhecida.";
		} catch (err) {
			this.logger.error(`[LLMService] Erro ao executar tool ${fnName}:`, err.message);
			return `Erro ao executar ferramenta ${fnName}: ${err.message}`;
		}
	}

	/**
	 * Consulta dados meteorológicos via WeatherMeteo
	 * @param {string} city - Nome da cidade
	 * @returns {Promise<string>}
	 */
	async getWeather(city) {
		try {
			if (!city || typeof city !== "string" || city.trim().length === 0) {
				return "Por favor, especifique o nome de uma cidade para consultar o clima.";
			}
			const { getCityCoordinates, getWeatherData, formatWeatherMessage } = require("../functions/WeatherMeteo");
			const location = await getCityCoordinates(city.trim());
			const weather = await getWeatherData(location.lat, location.lon);
			return formatWeatherMessage(location, weather);
		} catch (error) {
			this.logger.error(`[getWeather] Erro ao consultar clima para ${city}:`, error.message);
			return `Não foi possível obter dados meteorológicos para "${city}": ${error.message}`;
		}
	}

	/**
	 * Retorna data, hora, dia da semana e fuso horário formatados
	 * @returns {string}
	 */
	getCurrentTime() {
		const now = new Date();
		const tz = "America/Sao_Paulo";
		const dateOptions = { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" };
		const timeOptions = {
			timeZone: tz,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false
		};
		const weekdayOptions = { timeZone: tz, weekday: "long" };

		const dateStr = new Intl.DateTimeFormat("pt-BR", dateOptions).format(now);
		const timeStr = new Intl.DateTimeFormat("pt-BR", timeOptions).format(now);
		const weekday = new Intl.DateTimeFormat("pt-BR", weekdayOptions).format(now);

		return JSON.stringify(
			{
				date: dateStr,
				time: timeStr,
				day_of_week: weekday,
				timezone: tz,
				iso: now.toISOString()
			},
			null,
			2
		);
	}

	/**
	 * Constrói a lista de provedores a partir da configuração
	 */
	buildProviders() {
		const llmConfigs = this.serviceProviderService.getProviders("llm");
		this.providerDefinitions = [];

		for (const config of llmConfigs) {
			// Store textOnly flag for use during provider selection
			const textOnly = config.textOnly === true;
			const toolCalling = config.toolCalling === true;

			const providerDef = {
				name: config.name,
				textOnly,
				toolCalling,
				method: async (options) => {
					// Apply config values
					if (config.model) options.model = config.model;
					if (config.temperature !== undefined) options.temperature = config.temperature;
					if (config.top_k !== undefined) options.top_k = config.top_k;
					if (config.top_p !== undefined) options.top_p = config.top_p;
					if (config.apiKey) options.apiKey = config.apiKey;
					if (config.timeout_multiplier) {
						options.timeout = options.timeout
							? options.timeout * config.timeout_multiplier
							: 30000 * config.timeout_multiplier;
					}
					if (config.ignoreVideo !== undefined) options.ignoreVideo = config.ignoreVideo;
					if (config.toolCalling !== undefined && options.toolCalling === undefined) {
						options.toolCalling = config.toolCalling;
					}

					const completionOptions = {
						customEndpoint: config.url,
						providerName: config.name,
						toolCalling: options.toolCalling !== undefined ? options.toolCalling : toolCalling,
						...options
					};

					const validateJsonResponse = (content) => {
						if (completionOptions.response_format && typeof content === "string") {
							try {
								const clean = content.replace(/^```(?:json)?\n?|```$/g, "").trim();
								JSON.parse(clean);
							} catch (jsonErr) {
								const err = new Error(
									`Provedor (${config.name}) retornou resposta fora do formato JSON esperado: ${content.slice(0, 150)}...`
								);
								err.isFormatError = true;
								throw err;
							}
						}
						return content;
					};

					let response;
					switch (config.type) {
						case "ollama":
							response = await this.ollamaCompletion(completionOptions);
							if (response && response.message && response.message.content) {
								return validateJsonResponse(response.message.content);
							}
							if (
								response &&
								response.choices &&
								response.choices[0] &&
								response.choices[0].message
							) {
								return validateJsonResponse(response.choices[0].message.content);
							}
							throw new Error(`Resposta inválida ou vazia do Ollama (${config.name})`);
						case "openai":
						case "openrouter":
							const providerMethod = `${config.type}Completion`;
							if (typeof this[providerMethod] === "function") {
								response = await this[providerMethod](completionOptions);
								// Handle standard OpenAI format
								if (
									response &&
									response.choices &&
									response.choices[0] &&
									response.choices[0].message
								) {
									return validateJsonResponse(response.choices[0].message.content);
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

		// OpenAI / compatible APIs
		if (response.usage) {
			promptTokens = response.usage.prompt_tokens || 0;
			completionTokens = response.usage.completion_tokens || 0;
		}
		// Ollama (standard /api/chat)
		else if (response.prompt_eval_count !== undefined || response.eval_count !== undefined) {
			promptTokens = response.prompt_eval_count || 0;
			completionTokens = response.eval_count || 0;
		}

		if (promptTokens > 0 || completionTokens > 0) {
			const elapsedMs = options._startTime ? Date.now() - options._startTime : null;
			const timeStr = elapsedMs !== null ? ` | Time: ${elapsedMs}ms` : "";
			this.logger.info(
				`[TokenUsage][${provider}] Type: ${requestType} | Model: ${model} | In: ${promptTokens} | Out: ${completionTokens}${timeStr}`
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

			// --- Audio & Image Stats ---
			const speechProvider = "Speech System";
			const mediaParams = timeframeMs ? [Date.now() - timeframeMs] : [];
			const mediaFilter = timeframeMs ? " WHERE timestamp > ?" : "";

			// ALWAYS query absolute earliest timestamps across all relevant tables
			// to provide a correct 'since' date for the dashboard.
			const [llmFirst, sttFirst, ttsFirst, bonsaiFirst, comfyFirst] = await Promise.all([
				this.database
					.dbGet(this.DB_NAME, "SELECT MIN(timestamp) as ts FROM usage_stats")
					.catch(() => null),
				this.database
					.dbGet("media_stats", "SELECT MIN(timestamp) as ts FROM speech_transcription_stats")
					.catch(() => null),
				this.database
					.dbGet("media_stats", "SELECT MIN(timestamp) as ts FROM speech_generation_stats")
					.catch(() => null),
				this.database
					.dbGet("bonsai_stats", "SELECT MIN(timestamp) as ts FROM bonsai_stats")
					.catch(() => null),
				this.database
					.dbGet("media_stats", "SELECT MIN(timestamp) as ts FROM comfy_stats")
					.catch(() => null)
			]);
			const absoluteTimestamps = [
				llmFirst?.ts,
				sttFirst?.ts,
				ttsFirst?.ts,
				bonsaiFirst?.ts,
				comfyFirst?.ts
			].filter((ts) => ts);
			if (absoluteTimestamps.length > 0) {
				const absoluteMin = Math.min(...absoluteTimestamps);
				if (!stats.first_record_timestamp || absoluteMin < stats.first_record_timestamp) {
					stats.first_record_timestamp = absoluteMin;
				}
			}

			// 1. Bonsai Image Generation Stats
			try {
				const bonsaiAgg = await this.database.dbGet(
					"bonsai_stats",
					`SELECT SUM(CASE WHEN is_success IS NULL OR is_success = 1 THEN count ELSE 0 END) as requests,
					        SUM(CASE WHEN is_success = 0 THEN count ELSE 0 END) as failures,
					        MIN(timestamp) as min_ts FROM bonsai_stats${mediaFilter}`,
					mediaParams
				);

				if (bonsaiAgg && ((bonsaiAgg.requests || 0) > 0 || (bonsaiAgg.failures || 0) > 0)) {
					const provider = "Bonsai";
					if (!stats.by_provider[provider]) {
						stats.by_provider[provider] = {
							requests: 0,
							failures: 0,
							input_tokens: 0,
							output_tokens: 0,
							by_type: {}
						};
					}

					const requests = bonsaiAgg.requests || 0;
					const failures = bonsaiAgg.failures || 0;

					stats.total_requests += requests;
					stats.total_failures += failures;
					stats.by_type.image.requests += requests;
					stats.by_type.image.failures += failures;

					stats.by_provider[provider].requests += requests;
					stats.by_provider[provider].failures += failures;
					stats.by_provider[provider].by_type.image = {
						requests,
						failures,
						input_tokens: 0,
						output_tokens: 0
					};

					if (
						bonsaiAgg.min_ts &&
						(!stats.first_record_timestamp || bonsaiAgg.min_ts < stats.first_record_timestamp)
					) {
						stats.first_record_timestamp = bonsaiAgg.min_ts;
					}
				}
			} catch (bonsaiErr) {
				this.logger.error("Error getting Bonsai stats:", bonsaiErr);
			}

			// 2. ComfyUI Image Generation Stats
			try {
				const comfyAgg = await this.database.dbGet(
					"media_stats",
					`SELECT SUM(CASE WHEN is_success IS NULL OR is_success = 1 THEN count ELSE 0 END) as requests,
					        SUM(CASE WHEN is_success = 0 THEN count ELSE 0 END) as failures,
					        MIN(timestamp) as min_ts FROM comfy_stats${mediaFilter}`,
					mediaParams
				);

				if (comfyAgg && ((comfyAgg.requests || 0) > 0 || (comfyAgg.failures || 0) > 0)) {
					const provider = "ComfyUI";
					if (!stats.by_provider[provider]) {
						stats.by_provider[provider] = {
							requests: 0,
							failures: 0,
							input_tokens: 0,
							output_tokens: 0,
							by_type: {}
						};
					}

					const requests = comfyAgg.requests || 0;
					const failures = comfyAgg.failures || 0;

					stats.total_requests += requests;
					stats.total_failures += failures;
					stats.by_type.image.requests += requests;
					stats.by_type.image.failures += failures;

					stats.by_provider[provider].requests += requests;
					stats.by_provider[provider].failures += failures;
					stats.by_provider[provider].by_type.image = {
						requests,
						failures,
						input_tokens: 0,
						output_tokens: 0
					};

					if (
						comfyAgg.min_ts &&
						(!stats.first_record_timestamp || comfyAgg.min_ts < stats.first_record_timestamp)
					) {
						stats.first_record_timestamp = comfyAgg.min_ts;
					}
				}
			} catch (comfyErr) {
				this.logger.error("Error getting ComfyUI stats:", comfyErr);
			}

			try {
				// STT Stats
				const sttAgg = await this.database.dbGet(
					"media_stats",
					`SELECT COUNT(*) as requests, SUM(char_count) as input_tokens, SUM(duration_sec) as duration_sec, MIN(timestamp) as min_ts FROM speech_transcription_stats${mediaFilter}`,
					mediaParams
				);

				if (sttAgg && sttAgg.requests > 0) {
					if (!stats.by_provider[speechProvider]) {
						stats.by_provider[speechProvider] = {
							requests: 0,
							failures: 0,
							input_tokens: 0,
							output_tokens: 0,
							by_type: {}
						};
					}

					const data = {
						requests: sttAgg.requests,
						failures: 0,
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
					`SELECT COUNT(*) as requests, SUM(char_count) as output_tokens, MIN(timestamp) as min_ts FROM speech_generation_stats${mediaFilter}`,
					mediaParams
				);

				if (ttsAgg && ttsAgg.requests > 0) {
					if (!stats.by_provider[speechProvider]) {
						stats.by_provider[speechProvider] = {
							requests: 0,
							failures: 0,
							input_tokens: 0,
							output_tokens: 0,
							by_type: {}
						};
					}

					const data = {
						requests: ttsAgg.requests,
						failures: 0,
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
	 * Envia uma solicitação de completion para API compatível com OpenAI (OpenAI, LM Studio, DeepSeek, etc.)
	 * @param {Object} options - Opções de solicitação
	 * @param {string} options.prompt - O texto do prompt
	 * @param {string} [options.model='gpt-3.5-turbo'] - O modelo a usar
	 * @param {number} [options.maxTokens=5000] - Número máximo de tokens a gerar
	 * @param {number} [options.temperature=0.7] - Temperatura de amostragem
	 * @param {string} [options.customEndpoint] - Endpoint customizado (para APIs compatíveis)
	 * @returns {Promise<Object>} - A resposta da API
	 */
	async openaiCompletion(options) {
		try {
			// Determina endpoint
			let endpoint = "https://api.openai.com/v1/chat/completions";
			if (options.customEndpoint && options.customEndpoint.trim() !== "") {
				if (options.customEndpoint.endsWith("/chat/completions")) {
					endpoint = options.customEndpoint;
				} else {
					endpoint = `${options.customEndpoint.replace(/\/$/, "")}/chat/completions`;
				}
			}

			if (!options.apiKey) {
				this.logger.error("Chave da API não configurada");
				throw new Error("Chave da API não configurada");
			}

			const apiKey = `Bearer ${options.apiKey}`;
			const model = options.model ?? "gpt-3.5-turbo";

			const ctxInclude =
				options.systemContext ??
				"Você é ravena, um bot de whatsapp criado por moothz. Não se apresente, a menos que solicitado pelo usuário.";

			// Monta o conteúdo do user message (texto simples ou array com imagens para vision)
			let userContent;
			const hasImages = !!(options.image || (options.images && options.images.length > 0));
			if (hasImages) {
				const imagesToProcess = options.images ? options.images : [options.image];
				userContent = [{ type: "text", text: options.prompt }];
				for (const img of imagesToProcess) {
					let base64;
					if (img.startsWith("data:image")) {
						// Já é data URL completo
						userContent.push({
							type: "image_url",
							image_url: { url: img }
						});
					} else {
						// Raw base64 — detectar mime type pelo header ou assumir jpeg
						base64 = img;
						let mime = "image/jpeg";
						if (base64.startsWith("/9j/")) mime = "image/jpeg";
						else if (base64.startsWith("iVBOR")) mime = "image/png";
						else if (base64.startsWith("R0lGO")) mime = "image/gif";
						else if (base64.startsWith("UklGR")) mime = "image/webp";
						userContent.push({
							type: "image_url",
							image_url: { url: `data:${mime};base64,${base64}` }
						});
					}
				}
			} else {
				userContent = options.prompt;
			}

			const messages = [
				{ role: "system", content: ctxInclude },
				{ role: "user", content: userContent }
			];

			const payload = {
				model,
				messages,
				max_tokens: options.maxTokens ?? 5000,
				temperature: options.temperature ?? 0.7,
				stream: false
			};

			if (options.response_format) {
				payload.response_format = options.response_format;
			}

			const allowToolCalling =
				options.toolCalling === true && !options.response_format && !hasImages;
			if (allowToolCalling) {
				payload.tools = this.getTools();
			}

			const timeout = options.timeout ?? this.apiTimeout;

			const response = await axios.post(endpoint, payload, {
				headers: {
					Authorization: apiKey,
					"Content-Type": "application/json"
				},
				timeout
			});

			this._trackUsage(options.providerName || "OpenAI", response.data, model, options);

			const message = response.data?.choices?.[0]?.message;

			// Interação com o Loop do Agente (tool_calls)
			if (
				allowToolCalling &&
				message?.tool_calls &&
				Array.isArray(message.tool_calls) &&
				message.tool_calls.length > 0
			) {
				this.logger.info(
					`[LLMService][OpenAI] LLM solicitou ${message.tool_calls.length} tool call(s)`
				);
				messages.push(message);

				for (const toolCall of message.tool_calls) {
					const fnName = toolCall.function?.name;
					let parsedArgs = {};
					try {
						parsedArgs =
							typeof toolCall.function?.arguments === "string"
								? JSON.parse(toolCall.function.arguments)
								: toolCall.function?.arguments || {};
					} catch (e) {
						this.logger.error(
							`[LLMService] Erro ao analisar argumentos de tool_call (${toolCall.function?.arguments}):`,
							e.message
						);
					}

					const toolOutput = await this.executeToolCall(fnName, parsedArgs);

					messages.push({
						role: "tool",
						tool_call_id: toolCall.id,
						name: fnName,
						content: toolOutput
					});
				}

				this.logger.info(
					"[LLMService][OpenAI] Enviando segunda chamada ao LLM com os resultados das tools..."
				);

				const secondPayload = {
					model,
					messages,
					max_tokens: options.maxTokens ?? 5000,
					temperature: options.temperature ?? 0.7,
					stream: false
				};

				const secondResponse = await axios.post(endpoint, secondPayload, {
					headers: {
						Authorization: apiKey,
						"Content-Type": "application/json"
					},
					timeout
				});

				this._trackUsage(options.providerName || "OpenAI", secondResponse.data, model, options);
				return secondResponse.data;
			}

			return response.data;
		} catch (error) {
			this.logger.error("Erro ao chamar API compatível com OpenAI:", error.message);
			throw error;
		}
	}

	/**
	 * Envia uma solicitação de completion para a API OpenRouter (OpenAI-compatível).
	 * @param {Object} options - Opções de solicitação
	 * @param {string} options.prompt - O texto do prompt
	 * @param {string} [options.model] - O modelo a usar (ex: 'anthropic/claude-3-haiku')
	 * @param {number} [options.maxTokens=5000] - Número máximo de tokens a gerar
	 * @param {number} [options.temperature=0.7] - Temperatura de amostragem
	 * @param {string} [options.customEndpoint] - Endpoint customizado (fallback)
	 * @returns {Promise<Object>} - A resposta da API
	 */
	async openrouterCompletion(options) {
		try {
			const apiKey = options.apiKey;
			if (!apiKey) {
				this.logger.error("Chave da API OpenRouter não configurada");
				throw new Error("Chave da API OpenRouter não configurada");
			}

			const endpoint =
				options.customEndpoint && options.customEndpoint.trim() !== ""
					? options.customEndpoint.replace(/\/$/, "") + "/chat/completions"
					: "https://openrouter.ai/api/v1/chat/completions";

			const model = options.model ?? "openai/gpt-3.5-turbo";

			const ctxInclude =
				options.systemContext ??
				"Você é ravena, um bot de whatsapp criado por moothz. Não se apresente, a menos que solicitado pelo usuário.";

			// Monta o conteúdo do user message (texto simples ou array com imagens para vision)
			let userContent;
			const hasImages = !!(options.image || (options.images && options.images.length > 0));
			if (hasImages) {
				const imagesToProcess = options.images ? options.images : [options.image];
				userContent = [{ type: "text", text: options.prompt }];
				for (const img of imagesToProcess) {
					if (img.startsWith("data:image")) {
						userContent.push({
							type: "image_url",
							image_url: { url: img }
						});
					} else {
						let mime = "image/jpeg";
						if (img.startsWith("/9j/")) mime = "image/jpeg";
						else if (img.startsWith("iVBOR")) mime = "image/png";
						else if (img.startsWith("R0lGO")) mime = "image/gif";
						else if (img.startsWith("UklGR")) mime = "image/webp";
						userContent.push({
							type: "image_url",
							image_url: { url: `data:${mime};base64,${img}` }
						});
					}
				}
			} else {
				userContent = options.prompt;
			}

			const messages = [
				{ role: "system", content: ctxInclude },
				{ role: "user", content: userContent }
			];

			const payload = {
				model,
				messages,
				max_tokens: options.maxTokens ?? 5000,
				temperature: options.temperature ?? 0.7,
				stream: false
			};

			if (options.response_format) {
				payload.response_format = options.response_format;
			}

			const allowToolCalling =
				options.toolCalling === true && !options.response_format && !hasImages;
			if (allowToolCalling) {
				payload.tools = this.getTools();
			}

			const timeout = options.timeout ?? this.apiTimeout;

			const response = await axios.post(endpoint, payload, {
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://ravena.local",
					"X-Title": "RavenaBot"
				},
				timeout
			});

			this._trackUsage(options.providerName || "OpenRouter", response.data, model, options);

			const message = response.data?.choices?.[0]?.message;

			// Interação com o Loop do Agente (tool_calls)
			if (
				allowToolCalling &&
				message?.tool_calls &&
				Array.isArray(message.tool_calls) &&
				message.tool_calls.length > 0
			) {
				this.logger.info(
					`[LLMService][OpenRouter] LLM solicitou ${message.tool_calls.length} tool call(s)`
				);
				messages.push(message);

				for (const toolCall of message.tool_calls) {
					const fnName = toolCall.function?.name;
					let parsedArgs = {};
					try {
						parsedArgs =
							typeof toolCall.function?.arguments === "string"
								? JSON.parse(toolCall.function.arguments)
								: toolCall.function?.arguments || {};
					} catch (e) {
						this.logger.error(
							`[LLMService] Erro ao analisar argumentos de tool_call (${toolCall.function?.arguments}):`,
							e.message
						);
					}

					const toolOutput = await this.executeToolCall(fnName, parsedArgs);

					messages.push({
						role: "tool",
						tool_call_id: toolCall.id,
						name: fnName,
						content: toolOutput
					});
				}

				this.logger.info(
					"[LLMService][OpenRouter] Enviando segunda chamada ao LLM com os resultados das tools..."
				);

				const secondPayload = {
					model,
					messages,
					max_tokens: options.maxTokens ?? 5000,
					temperature: options.temperature ?? 0.7,
					stream: false
				};

				const secondResponse = await axios.post(endpoint, secondPayload, {
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						"HTTP-Referer": "https://ravena.local",
						"X-Title": "RavenaBot"
					},
					timeout
				});

				this._trackUsage(options.providerName || "OpenRouter", secondResponse.data, model, options);
				return secondResponse.data;
			}

			return response.data;
		} catch (error) {
			this.logger.error("Erro ao chamar API OpenRouter:", error.message);
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

		let cleaned = response
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
			.trim();

		// Remove blocos de código Markdown (por exemplo, ```json ... ``` ou ``` ... ```) se existirem
		if (cleaned.startsWith("```")) {
			cleaned = cleaned.replace(/^```(?:json)?\n?|```$/g, "").trim();
		}

		return cleaned.replace(/^"|"$/g, "");
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
			const endpoint = (options.customEndpoint ?? "http://localhost:11434") + "/api/chat";

			const messages = [];
			const systemContext =
				options.systemContext ??
				"Você é ravena, um bot de whatsapp criado por moothz. Não se apresente, a menos que solicitado pelo usuário.";
			messages.push({ role: "system", content: systemContext });

			const userMessage = {
				role: "user",
				content: options.prompt
			};

			const hasImages = !!(options.images || options.image);
			if (hasImages) {
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
				model: options.model ?? "gemma3:12b",
				messages,
				format: ollamaFormat,
				stream: false,
				options: {
					temperature: options.temperature ?? 0.7,
					num_predict: options.maxTokens ?? 8096,
					top_k: options.top_k,
					top_p: options.top_p
				}
			};

			const allowToolCalling = options.toolCalling === true && !ollamaFormat && !hasImages;
			if (allowToolCalling) {
				payload.tools = this.getTools();
			}

			const toTime = options.timeout ?? this.apiTimeout ?? 60000;

			const response = await axios.post(endpoint, payload, {
				headers: {
					"Content-Type": "application/json"
				},
				timeout: toTime
			});

			this._trackUsage(options.providerName || "Ollama", response.data, payload.model, options);

			const msg = response.data?.message;
			if (
				allowToolCalling &&
				msg?.tool_calls &&
				Array.isArray(msg.tool_calls) &&
				msg.tool_calls.length > 0
			) {
				this.logger.info(
					`[LLMService][Ollama] LLM solicitou ${msg.tool_calls.length} tool call(s)`
				);
				messages.push(msg);

				for (const toolCall of msg.tool_calls) {
					const fnName = toolCall.function?.name;
					const parsedArgs = toolCall.function?.arguments || {};

					const toolOutput = await this.executeToolCall(fnName, parsedArgs);

					messages.push({
						role: "tool",
						content: toolOutput
					});
				}

				this.logger.info(
					"[LLMService][Ollama] Enviando segunda chamada ao Ollama com os resultados das tools..."
				);

				const secondPayload = {
					model: payload.model,
					messages,
					format: ollamaFormat,
					stream: false,
					options: payload.options
				};

				const secondResponse = await axios.post(endpoint, secondPayload, {
					headers: {
						"Content-Type": "application/json"
					},
					timeout: toTime
				});

				this._trackUsage(
					options.providerName || "Ollama",
					secondResponse.data,
					payload.model,
					options
				);
				return secondResponse.data;
			}

			return response.data;
		} catch (error) {
			this.logger.error("[LLMService] Error calling Ollama API:", error.message);
			if (error.response) {
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
	 * @param {string} [options.provider] - O provedor a usar ('ollama', 'openai', 'openrouter')
	 * @param {string} [options.model] - O modelo a usar (específico do provedor)
	 * @param {number} [options.maxTokens=5000] - Número máximo de tokens a gerar
	 * @param {number} [options.temperature=0.7] - Temperatura de amostragem
	 * @param {number} [options.priority=0] - Prioridade da requisição (0-5)
	 * @returns {Promise<string>} - O texto gerado
	 */
	async getCompletion(options) {
		const EventHandler = require("../EventHandler");
		EventHandler.getInstance().emit("activity", { type: "llm" });
		options._startTime = options._startTime || Date.now();
		const priority = options.priority ?? 0;
		const maxQueueRetries = 10; // Limit times we can send back to queue

		const task = async () => {
			try {
				// Se um provedor específico for solicitado, use-o diretamente
				if (options.provider) {
					const response = await this.getCompletionFromSpecificProvider(options);
					return this._cleanResponse(response);
				}
				// Caso contrário, tente múltiplos provedores em sequência
				else {
					const response = await this.getCompletionFromProviders(options, priority);
					return this._cleanResponse(response);
				}
			} catch (error) {
				this.logger.error("Erro ao obter completion:", error.message);
				throw error;
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

					if (priority >= 4) {
						shouldRetry = true;
						nextPos = this.queue.size;
					} else if (priority === 3) {
						shouldRetry = true;
						nextPos = 3;
					} else if (priority === 2) {
						shouldRetry = true;
						nextPos = 5;
					}

					if (shouldRetry) {
						this.logger.warn(
							`[LLMService] Request failed, re-queueing at pos ${nextPos}. (Queue Attempt ${attempt + 1}/${maxQueueRetries})`
						);
						await new Promise((r) => setTimeout(r, 2000));
						return scheduleRequest(attempt + 1, nextPos);
					}
				}

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
			case "ollama":
				response = await this.ollamaCompletion(options);
				if (response && response.message && response.message.content) {
					return response.message.content;
				}
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

			case "openrouter":
				response = await this.openrouterCompletion(options);
				if (
					!response ||
					!response.choices ||
					!response.choices[0] ||
					!response.choices[0].message
				) {
					this.logger.error("Resposta inválida da API OpenRouter:", response);
					this._trackUsage("OpenRouter", {}, options.model || "Unknown", options, false);
					return "Erro: Não foi possível gerar uma resposta. Por favor, tente novamente mais tarde.";
				}
				return response.choices[0].message.content;

			case "openai":
			default:
				response = await this.openaiCompletion(options);
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
	/**
	 * Rebaixa um provedor movendo-o para o final da fila de provedores.
	 * @param {string} providerName - Nome do provedor a ser rebaixado
	 */
	demoteProvider(providerName) {
		const index = this.providerQueue.findIndex((p) => p.name === providerName);
		if (index !== -1) {
			const [removed] = this.providerQueue.splice(index, 1);
			this.providerQueue.push(removed);
			this.lastQueueChangeTimestamp = Date.now();
			this.logger.warn(`[LLMService] Rebaixando provedor ${providerName} para o final da fila.`);
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

		// Snapshot dos provedores no momento da requisição
		const candidateProviders = [...this.providerQueue];

		// Priority <= 4: Try only the first available provider (unless fallback is triggered on format error or textOnly).
		// Priority 5: Try all providers (fallback loop).
		let maxAttempts = priority <= 4 ? 1 : candidateProviders.length;

		for (let i = 0; i < maxAttempts && i < candidateProviders.length; i++) {
			const provider = candidateProviders[i];

			// Check if provider is textOnly and request has images
			const hasImages = !!(options.image || (options.images && options.images.length > 0));
			if (provider.textOnly && hasImages) {
				this.logger.info(
					`[LLMService] Provedor ${provider.name} é textOnly, pulando para o próximo (requisição contém imagens).`
				);
				// If single attempt, allow trying next candidate
				if (maxAttempts <= i + 1 && i < candidateProviders.length - 1) {
					maxAttempts = i + 2;
				}
				continue;
			}

			try {
				// this.logger.debug(`[LLMService] Tentando provedor: ${provider.name}`);
				const result = await provider.method(options);

				if (!result || typeof result !== "string" || result.trim() === "") {
					throw new Error("Resposta vazia ou inválida do provedor");
				}

				return result;
			} catch (error) {
				if (error.isFormatError) {
					this.logger.warn(
						`[LLMService] Provedor ${provider.name} retornou formato inválido (${error.message}). Repassando para o próximo modelo sem rebaixá-lo na fila global.`
					);
					this._trackUsage(provider.name, {}, "Unknown", options, false);
					// Dá oportunidade ao próximo modelo de atender a requisição atual
					if (maxAttempts <= i + 1 && i < candidateProviders.length - 1) {
						maxAttempts = i + 2;
					}
				} else {
					this.logger.error(`Erro ao usar provedor ${provider.name}:`, error.message);

					// Rebaixa o provedor que falhou por indisponibilidade/erro de execução, movendo-o para o final da fila global.
					this.demoteProvider(provider.name);
					this._trackUsage(provider.name, {}, "Unknown", options, false);
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
