const axios = require("axios");

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

	_handleError(error, context, reqData = {}) {
		const status = error.response?.status;
		const data = error.response?.data;
		const message = data?.message || error.message || "Erro desconhecido";

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
		try {
			const config = { params };

			// Se precisar da chave global, sobrescreve os headers
			if (useGlobalKey) {
				Object.assign(config, this._adminConfig);
			} else {
				Object.assign(config, this._instanceConfig);
			}

			const response = await this.client.get(endpoint, config);
			return response.data;
		} catch (error) {
			return this._handleError(error, `GET ${endpoint}`, params);
		}
	}

	/**
	 * POST Request
	 * @param {boolean} useGlobalKey - Se true, usa a Global API Key (ex: create instance)
	 */
	async post(endpoint, body = {}, useGlobalKey = false) {
		try {
			const config = useGlobalKey ? this._adminConfig : this._instanceConfig;
			const response = await this.client.post(endpoint, body, config);
			return response.data;
		} catch (error) {
			return this._handleError(error, `POST ${endpoint}`, body);
		}
	}

	/**
	 * PUT Request
	 */
	async put(endpoint, body = {}, useGlobalKey = false) {
		try {
			const config = useGlobalKey ? this._adminConfig : this._instanceConfig;
			const response = await this.client.put(endpoint, body, config);
			return response.data;
		} catch (error) {
			return this._handleError(error, `PUT ${endpoint}`, body);
		}
	}

	/**
	 * DELETE Request
	 * @param {boolean} useGlobalKey - Se true, usa a Global API Key (ex: delete instance)
	 */
	async delete(endpoint, body = {}, useGlobalKey = false) {
		try {
			const config = useGlobalKey ? this._adminConfig : this._instanceConfig;
			config.data = body; // Axios passa body no delete via config.data

			const response = await this.client.delete(endpoint, config);
			return response.data;
		} catch (error) {
			return this._handleError(error, `DELETE ${endpoint}`, body);
		}
	}
}

module.exports = WhatsgoClient;
