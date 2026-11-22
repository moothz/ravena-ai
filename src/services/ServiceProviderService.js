const fs = require("fs");
const path = require("path");
const Logger = require("../utils/Logger");

/**
 * Service to manage service providers configuration from a JSON file.
 * Handles loading, automatic reloading, and fallback.
 */
class ServiceProviderService {
	/**
	 * Get Singleton Instance
	 * @returns {ServiceProviderService}
	 */
	static getInstance() {
		if (!ServiceProviderService.instance) {
			ServiceProviderService.instance = new ServiceProviderService();
		}
		return ServiceProviderService.instance;
	}

	constructor() {
		this.logger = new Logger("service-provider-service");
		this.configPath = path.join(process.cwd(), "service-providers.json");
		this.config = null;
		this.lastLoadedTime = 0;
		// Motivo da última leitura que falhou (arquivo com erro de sintaxe, etc.); null quando a
		// config em memória é a do arquivo. Com erro, saveConfig recusa: gravar sobrescreveria o
		// arquivo (e as chaves de API) com a config vazia/antiga em memória.
		this.loadError = null;
		this.watcher = null;
		this.loadConfig();
		this.setupWatcher();
	}

	/**
	 * Loads the configuration from the JSON file.
	 * Keeps the last valid configuration in case of error.
	 */
	loadConfig() {
		try {
			if (!fs.existsSync(this.configPath)) {
				this.logger.warn(
					`Configuration file not found at ${this.configPath}. Using empty default.`
				);
				this.config = this.getDefaultConfig();
				this.loadError = null;
				return;
			}

			const data = fs.readFileSync(this.configPath, "utf8");
			const newConfig = JSON.parse(data);

			// Basic validation: must be an object
			if (typeof newConfig !== "object" || newConfig === null) {
				throw new Error("Invalid JSON structure: top-level must be an object");
			}

			this.config = newConfig;
			this.lastLoadedTime = Date.now();
			this.loadError = null;
			this.logger.info("Service providers configuration loaded successfully");
		} catch (error) {
			this.loadError = error.message;
			this.logger.error(`Error loading service providers configuration: ${error.message}`);
			// Fallback to existing config if available, otherwise use default
			if (!this.config) {
				this.config = this.getDefaultConfig();
			}
		}
	}

	/**
	 * Automatically watches for file changes and reloads the configuration.
	 */
	setupWatcher() {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (!fs.existsSync(this.configPath)) return;

		let debounceTimeout;
		this.watcher = fs.watch(this.configPath, (event) => {
			if (event === "change" || event === "rename") {
				if (debounceTimeout) clearTimeout(debounceTimeout);
				debounceTimeout = setTimeout(() => {
					this.logger.info("File change detected, reloading configuration...");
					this.loadConfig();
					// Trocado por rename (o saveConfig grava assim; editores também): o watch seguia
					// o arquivo antigo, então volta a observar o caminho.
					if (event === "rename") this.setupWatcher();
				}, 100);
			}
		});
		this.watcher.on("error", () => {});
	}

	/**
	 * Writes the current configuration to the JSON file.
	 * @param {Object} newConfig - The new configuration to save.
	 */
	async saveConfig(newConfig) {
		if (this.loadError) {
			const err = new Error(
				`service-providers.json está com erro e não foi carregado (${this.loadError}). Corrija o arquivo antes de salvar pelo painel; gravar agora apagaria o que está nele.`
			);
			err.statusCode = 409;
			throw err;
		}
		if (!newConfig || typeof newConfig !== "object" || Array.isArray(newConfig)) {
			const err = new Error("A configuração deve ser um objeto JSON.");
			err.statusCode = 400;
			throw err;
		}
		// Arquivo temporário + rename: uma queda no meio não deixa o JSON pela metade.
		const tmp = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
		try {
			const data = JSON.stringify(newConfig, null, 2);
			await fs.promises.writeFile(tmp, data, "utf8");
			await fs.promises.rename(tmp, this.configPath);
			if (!this.watcher) this.setupWatcher();
			this.config = newConfig;
			this.lastLoadedTime = Date.now();
			this.logger.info("Service providers configuration saved successfully");
			return true;
		} catch (error) {
			this.logger.error(`Error saving service providers configuration: ${error.message}`);
			await fs.promises.unlink(tmp).catch(() => {});
			throw error;
		}
	}

	/**
	 * Returns the current configuration.
	 */
	getConfig() {
		return this.config;
	}

	/**
	 * Returns enabled providers for a specific category.
	 * @param {string} category - Category name (llm, whisper, comfyui, etc.)
	 * @returns {Array} - Array of enabled providers.
	 */
	getProviders(category) {
		if (!this.config) {
			return [];
		}
		let list = this.config[category];
		if (!Array.isArray(list)) {
			if (category === "kokorotts" || category === "kokoro-tts" || category === "f5tts") {
				list = this.config.kokorotts || this.config["kokoro-tts"] || this.config.f5tts;
			}
		}
		if (!Array.isArray(list)) {
			return [];
		}
		return list.filter((p) => p.enabled !== false);
	}

	/**
	 * Returns default empty configuration.
	 */
	getDefaultConfig() {
		return {
			llm: [],
			laya: [],
			whisper: [],
			comfyui: [],
			bonsai: [],
			sdwebui: [],
			kokorotts: [],
			nudenet: [],
			rembg: []
		};
	}
}

module.exports = ServiceProviderService;
