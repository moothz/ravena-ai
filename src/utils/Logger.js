const fs = require("fs");
const path = require("path");
const util = require("util");

/**
 * Utilitário de Logger para registrar mensagens no console e arquivo
 */
class Logger {
	/**
	 * Cria um novo logger
	 * @param {string} name - Nome do logger (será incluído no nome do arquivo)
	 */
	constructor(name) {
		this.name = name;
		this.logDir = path.join(__dirname, "../../logs");
		this.currentDate = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
		this.logFile = null;
		this.debugMode = process.env.DEBUG === "true";

		// Cria diretório de log se não existir
		this.ensureLogDirectory();

		// Abre arquivo de log
		this.openLogFile();

		// Configura rotação à meia-noite
		this.setupRotation();
	}

	/**
	 * Garante que o diretório de log exista
	 */
	ensureLogDirectory() {
		if (!fs.existsSync(this.logDir)) {
			fs.mkdirSync(this.logDir, { recursive: true });
		}
	}

	/**
	 * Abre arquivo de log
	 */
	openLogFile() {
		const logFileName = `${this.currentDate}-${this.name}.log`;
		const logFilePath = path.join(this.logDir, logFileName);

		// Fecha arquivo existente se estiver aberto
		if (this.logFile) {
			try {
				fs.closeSync(this.logFile);
			} catch (error) {
				console.error("Erro ao fechar arquivo de log:", error);
			}
		}

		// Abre novo arquivo para anexar
		try {
			this.logFile = fs.openSync(logFilePath, "a");
		} catch (error) {
			console.error("Erro ao abrir arquivo de log:", error);
			this.logFile = null;
		}
	}

	/**
	 * Configura rotação de logs à meia-noite
	 */
	setupRotation() {
		const now = new Date();
		const tomorrow = new Date(now);
		tomorrow.setDate(now.getDate() + 1);
		tomorrow.setHours(0, 0, 0, 0);

		const timeUntilMidnight = tomorrow - now;

		// Define timeout para rotacionar logs à meia-noite
		setTimeout(() => {
			this.currentDate = new Date().toISOString().split("T")[0];
			this.openLogFile();
			this.setupRotation(); // Configura próxima rotação
		}, timeUntilMidnight);
	}

	/**
	 * Escreve uma mensagem de log
	 * @param {string} level - Nível de log
	 * @param {string} message - Mensagem de log
	 * @param {any} [data] - Dados adicionais para registrar
	 */
	log(level, message, data = null) {
		const timestamp = new Date().toISOString();
		let logMessage = `[${timestamp}] [${level.toUpperCase()}] [${this.name}] ${message}`;

		// Adiciona dados se fornecidos
		if (data) {
			if (typeof data === "object") {
				// Se for um erro do Axios, simplifica pra não explodir o log
				if (data.isAxiosError || data.name === "AxiosError") {
					const simplified = {
						message: data.message,
						code: data.code,
						status: data.response?.status,
						method: data.config?.method,
						url: data.config?.url,
						responseData: data.response?.data
					};
					logMessage += "\n" + util.inspect(simplified, { depth: 2, colors: false });
				} else {
					// Usa profundidade limitada para evitar logs gigantescos
					logMessage += "\n" + util.inspect(data, { depth: 3, colors: false });
				}
			} else {
				logMessage += " " + data;
			}
		}

		// Registra no console
		const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "log";
		console[consoleMethod](logMessage);

		// Registra no arquivo
		if (this.logFile) {
			try {
				fs.writeSync(this.logFile, logMessage + "\n");
			} catch (error) {
				console.error("Erro ao escrever no arquivo de log:", error);
				// Tenta reabrir arquivo de log
				this.openLogFile();
			}
		}
	}

	/**
	 * Registra uma mensagem de informação
	 * @param {string} message - Mensagem de log
	 * @param {any} [data] - Dados adicionais para registrar
	 */
	info(message, data = null) {
		this.log("info", message, data);
	}

	/**
	 * Registra uma mensagem de aviso
	 * @param {string} message - Mensagem de log
	 * @param {any} [data] - Dados adicionais para registrar
	 */
	warn(message, data = null) {
		this.log("warn", message, data);
	}

	/**
	 * Registra uma mensagem de erro
	 * @param {string} message - Mensagem de log
	 * @param {any} [data] - Dados adicionais para registrar
	 */
	error(message, data = null) {
		this.log("error", message, data);
	}

	/**
	 * Registra uma mensagem de depuração
	 * @param {string} message - Mensagem de log
	 * @param {any} [data] - Dados adicionais para registrar
	 */
	debug(message, data = null) {
		if (this.debugMode) {
			this.log("debug", message, data);
		}
	}
}

module.exports = Logger;
