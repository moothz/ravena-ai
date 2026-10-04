const axios = require("axios");
const RateLimitTracker = require("./RateLimitTracker");

class WhatsgoClient {
	/**
	 * @param {string} baseUrl - A URL raiz da API (ex: http://localhost:4000)
	 * @param {string} globalApiKey - A API Key GLOBAL (admin)
	 * @param {string} instanceName - O Nome da Instância
	 * @param {object} [logger] - Instância de logger opcional
	 */
	constructor(baseUrl, globalApiKey, instanceName, logger) {
		if (!baseUrl || !globalApiKey || !instanceName) {
			throw new Error("WhatsgoClient: baseUrl, globalApiKey e instanceName são obrigatórios.");
		}

		this.logger = logger || console;
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.globalApiKey = globalApiKey;
		this.instanceName = instanceName;
		this.rateLimitTracker = RateLimitTracker.getInstance();

		this.client = axios.create({
			baseURL: this.baseUrl,
			headers: {
				apikey: this.globalApiKey,
				instance: this.instanceName,
				"Content-Type": "application/json"
			}
		});

		//this.logger.info(`WhatsgoClient inicializado em: ${this.baseUrl}`);
	}

	/**
	 * Retorna os headers necessários para operações administrativas (Global Key)
	 */
	get _adminConfig() {
		return {
			headers: {
				apikey: this.globalApiKey,
				instance: this.instanceName,
				"Content-Type": "application/json"
			}
		};
	}

	get _instanceConfig() {
		return {
			headers: {
				apikey: this.globalApiKey,
				instance: this.instanceName,
				"Content-Type": "application/json"
			}
		};
	}

	_handleError(error, context, reqData = {}, reqCtx = null) {
		const status = error.response?.status;
		const data = error.response?.data;
		const message = data?.message || error.message || "Erro desconhecido";

		// Registra no rastreador de rate limit se aplicável
		this.rateLimitTracker.recordRateLimit(reqCtx, error, reqData);

		// Logs detalhados para debug
		this.logger.error(`[GO] Erro em ${context}: ${status} - ${message}`, { reqData });
		if (data) {
			this.logger.error(`\tDetalhes:`, JSON.stringify(data).substring(0, 200));
		}

		throw { status, message, data }; // originalError: error
	}

	/**
	 * GET Request (Usa Instance Token por padrão)
	 */
	async get(endpoint, params = {}, useGlobalKey = false) {
		const reqCtx = this.rateLimitTracker.startRequest(this.instanceName, "GET", endpoint, params);
		try {
			const config = { params };

			// Se precisar da chave global, sobrescreve os headers
			if (useGlobalKey) {
				Object.assign(config, this._adminConfig);
			} else {
				Object.assign(config, this._instanceConfig);
			}

			const response = await this.client.get(endpoint, config);
			this.rateLimitTracker.recordSuccess(reqCtx);
			return response.data;
		} catch (error) {
			return this._handleError(error, `GET ${endpoint}`, params, reqCtx);
		}
	}

	/**
	 * POST Request
	 * @param {boolean} useGlobalKey - Se true, usa a Global API Key (ex: create instance)
	 */
	async post(endpoint, body = {}, useGlobalKey = false) {
		const reqCtx = this.rateLimitTracker.startRequest(this.instanceName, "POST", endpoint, body);
		try {
			const config = useGlobalKey ? this._adminConfig : this._instanceConfig;
			const response = await this.client.post(endpoint, body, config);
			this.rateLimitTracker.recordSuccess(reqCtx);
			return response.data;
		} catch (error) {
			return this._handleError(error, `POST ${endpoint}`, body, reqCtx);
		}
	}

	/**
	 * PUT Request
	 */
	async put(endpoint, body = {}, useGlobalKey = false) {
		const reqCtx = this.rateLimitTracker.startRequest(this.instanceName, "PUT", endpoint, body);
		try {
			const config = useGlobalKey ? this._adminConfig : this._instanceConfig;
			const response = await this.client.put(endpoint, body, config);
			this.rateLimitTracker.recordSuccess(reqCtx);
			return response.data;
		} catch (error) {
			return this._handleError(error, `PUT ${endpoint}`, body, reqCtx);
		}
	}

	/**
	 * DELETE Request
	 * @param {boolean} useGlobalKey - Se true, usa a Global API Key (ex: delete instance)
	 */
	async delete(endpoint, body = {}, useGlobalKey = false) {
		const reqCtx = this.rateLimitTracker.startRequest(this.instanceName, "DELETE", endpoint, body);
		try {
			const config = useGlobalKey ? this._adminConfig : this._instanceConfig;
			config.data = body; // Axios passa body no delete via config.data

			const response = await this.client.delete(endpoint, config);
			this.rateLimitTracker.recordSuccess(reqCtx);
			return response.data;
		} catch (error) {
			return this._handleError(error, `DELETE ${endpoint}`, body, reqCtx);
		}
	}
}

module.exports = WhatsgoClient;
