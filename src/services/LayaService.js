const axios = require("axios");
const FormData = require("form-data");
const Logger = require("../utils/Logger");
const ServiceProviderService = require("./ServiceProviderService");

/**
 * Serviço Laya (System One) para decisões ultrarrápidas (<10ms) e classificação de intenções.
 * Funciona de forma similar ao LLMService, com suporte a múltiplos provedores, failover e monitoramento.
 */
class LayaService {
	/**
	 * Retorna a instância singleton do LayaService
	 * @param {Object} [config]
	 * @returns {LayaService}
	 */
	static getInstance(config = {}) {
		if (!LayaService.instance) {
			LayaService.instance = new LayaService(config);
		}
		return LayaService.instance;
	}

	constructor(config = {}) {
		this.logger = new Logger("laya-service");
		this.serviceProviderService = ServiceProviderService.getInstance();
		this.defaultTimeoutMs = config.timeoutMs || 3000;
		this.providers = [];
		this.circuitBreakerDurationMs = 30000; // 30s de pausa após falhas consecutivas

		this.buildProviders();
	}

	/**
	 * Carrega e normaliza os provedores configurados em service-providers.json
	 */
	buildProviders() {
		try {
			const rawProviders = this.serviceProviderService.getProviders("laya");
			this.providers = (rawProviders || []).map((p) => ({
				name: p.name || "default",
				url: (p.url || "").replace(/\/+$/, ""),
				model: p.model || "ravena-bgem3",
				enabled: p.enabled !== false,
				timeoutMs: p.timeoutMs || p.timeout || this.defaultTimeoutMs,
				failedAttempts: 0,
				lastFailedAt: 0
			}));

			const activeCount = this.providers.filter((p) => p.enabled).length;
			this.logger.info(`LayaService inicializado com ${activeCount} provedor(es) ativo(s).`);
		} catch (err) {
			this.logger.error("Erro ao construir provedores Laya:", err);
			this.providers = [];
		}
	}

	/**
	 * Verifica se há pelo menos um provedor Laya habilitado e configurado
	 * @returns {boolean}
	 */
	isEnabled() {
		return this.providers.some((p) => p.enabled && p.url);
	}

	/**
	 * Retorna o provedor ativo com balanceamento simples e circuit breaker
	 * @returns {Object|null}
	 */
	getActiveProvider() {
		const now = Date.now();
		// Procura primeiro por provedor habilitado que não esteja em cooldown de falha
		const available = this.providers.filter((p) => {
			if (!p.enabled || !p.url) return false;
			if (p.failedAttempts >= 3 && now - p.lastFailedAt < this.circuitBreakerDurationMs) {
				return false;
			}
			return true;
		});

		if (available.length > 0) {
			return available[0];
		}

		// Se todos estiverem em circuit breaker, reseta o primeiro habilitado como tentativa
		const fallback = this.providers.find((p) => p.enabled && p.url);
		if (fallback) {
			fallback.failedAttempts = 0;
			return fallback;
		}

		return null;
	}

	/**
	 * Marca sucesso no provedor
	 * @param {Object} provider
	 */
	_markSuccess(provider) {
		provider.failedAttempts = 0;
	}

	/**
	 * Marca falha no provedor
	 * @param {Object} provider
	 * @param {Error} error
	 */
	_markFailure(provider, error) {
		provider.failedAttempts = (provider.failedAttempts || 0) + 1;
		provider.lastFailedAt = Date.now();
		this.logger.warn(
			`Falha no provedor Laya '${provider.name}' (${provider.failedAttempts}x): ${error.message}`
		);
	}

	/**
	 * Executa predição de texto discreta via POST /predict
	 * @param {string|Object} state - Mensagem do usuário ou contexto
	 * @param {Object} questions - Dicionário de perguntas estruturadas
	 * @param {Object} [options]
	 * @returns {Promise<Object>}
	 */
	async predict(state, questions, options = {}) {
		const provider = this.getActiveProvider();
		if (!provider) {
			throw new Error("Nenhum provedor Laya disponível ou habilitado.");
		}

		const url = `${provider.url}/predict`;
		const payload = {
			state,
			questions,
			model: options.model || provider.model || "ravena-bgem3"
		};

		const timeout = options.timeoutMs || provider.timeoutMs || this.defaultTimeoutMs;

		try {
			const res = await axios.post(url, payload, { timeout });
			this._markSuccess(provider);
			return res.data;
		} catch (err) {
			this._markFailure(provider, err);
			throw err;
		}
	}

	/**
	 * Classifica a intenção do usuário entre Conversa Geral e Comandos do Bot
	 * @param {string} text - Mensagem enviada pelo usuário
	 * @param {Object} commandsCriteria - Mapeamento { [cmdName]: [description] }
	 * @param {Object} [options]
	 * @returns {Promise<{ classification: string, command?: string, args?: string, confidence: number, probabilities: Object }>}
	 */
	async classifyIntent(text, commandsCriteria = {}, options = {}) {
		const criteria = {
			conversa:
				"Conversa casual, perguntas normais, bate-papo, dúvidas gerais ou reflexões sem intenção de executar comando do bot",
			...commandsCriteria
		};

		const instructions =
			options.instructions ||
			"Determine se a mensagem é para executar um comando do bot ou apenas conversa geral.";

		const questions = {
			intent: {
				type: "choice",
				instructions,
				criteria
			}
		};

		const result = await this.predict(text, questions, options);
		const intentAnswer = result?.answers?.intent;
		if (!intentAnswer) {
			throw new Error("Resposta inválida recebida do Laya (campo 'answers.intent' ausente).");
		}

		const choice = intentAnswer.choice || "conversa";
		const confidence = intentAnswer.confidence ?? intentAnswer.answer_confidence ?? 0;
		const probabilities = intentAnswer.probabilities || {};

		const minConfidence = options.minConfidence ?? 0.4;

		// Se a predição for 'conversa' ou tiver confiança muito baixa, classifica como general
		if (choice === "conversa" || confidence < minConfidence) {
			return {
				classification: "general",
				command: null,
				args: "",
				confidence,
				probabilities
			};
		}

		// Extrai possíveis argumentos do texto removendo o nome/gatilho do comando se houver
		let args = "";
		const cleanText = text.trim();
		const regex = new RegExp(`^!?(${choice})\\s*`, "i");
		if (regex.test(cleanText)) {
			args = cleanText.replace(regex, "").trim();
		}

		return {
			classification: "command",
			command: choice,
			args,
			confidence,
			probabilities
		};
	}

	/**
	 * Classifica um buffer de imagem via POST /predict/image/upload (SigLIP 2)
	 * @param {Buffer} buffer - Buffer de imagem/figurinha
	 * @param {Object} questions - Perguntas do SigLIP (ex: safety, tags)
	 * @param {Object} [options]
	 * @returns {Promise<Object>}
	 */
	async classifyImage(buffer, questions, options = {}) {
		const provider = this.getActiveProvider();
		if (!provider) {
			throw new Error("Nenhum provedor Laya disponível para classificação de imagem.");
		}

		const url = `${provider.url}/predict/image/upload`;
		const timeout = options.timeoutMs || 10000;

		const form = new FormData();
		form.append("file", buffer, {
			filename: options.filename || "sticker.webp",
			contentType: options.contentType || "image/webp"
		});
		form.append("questions", JSON.stringify(questions));

		try {
			const res = await axios.post(url, form, {
				headers: form.getHeaders(),
				timeout
			});
			this._markSuccess(provider);
			return res.data;
		} catch (err) {
			this._markFailure(provider, err);
			throw err;
		}
	}

	/**
	 * Consulta o status de saúde do provedor Laya (/health)
	 * @returns {Promise<Object>}
	 */
	async getHealth() {
		const provider = this.getActiveProvider();
		if (!provider) {
			return { status: "offline", error: "Nenhum provedor configurado" };
		}

		try {
			const res = await axios.get(`${provider.url}/health`, { timeout: 3000 });
			return res.data;
		} catch (err) {
			return { status: "error", error: err.message, provider: provider.name };
		}
	}
}

module.exports = LayaService;
