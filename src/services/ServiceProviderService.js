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
			this.logger.info("Service providers configuration loaded successfully");
		} catch (error) {
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
		if (!fs.existsSync(this.configPath)) return;

		let debounceTimeout;
		fs.watch(this.configPath, (event) => {
			if (event === "change") {
				if (debounceTimeout) clearTimeout(debounceTimeout);
				debounceTimeout = setTimeout(() => {
					this.logger.info("File change detected, reloading configuration...");
					this.loadConfig();
				}, 100);
			}
		});
	}

	/**
	 * Writes the current configuration to the JSON file.
	 * @param {Object} newConfig - The new configuration to save.
	 */
	async saveConfig(newConfig) {
		try {
			const data = JSON.stringify(newConfig, null, 2);
			await fs.promises.writeFile(this.configPath, data, "utf8");
			this.config = newConfig;
			this.lastLoadedTime = Date.now();
			this.logger.info("Service providers configuration saved successfully");
			return true;
		} catch (error) {
			this.logger.error(`Error saving service providers configuration: ${error.message}`);
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
		if (!this.config || !Array.isArray(this.config[category])) {
			return [];
		}
		return this.config[category].filter((p) => p.enabled !== false);
	}

	/**
	 * Returns default empty configuration.
	 */
	getDefaultConfig() {
		return {
			llm: [],
			whisper: [],
			comfyui: [],
			bonsai: [],
			sdwebui: [],
			f5tts: []
		};
	}
}

module.exports = ServiceProviderService;
