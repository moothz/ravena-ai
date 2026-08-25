const fs = require("fs");
const path = require("path");
const util = require("util");

const logDir = path.join(__dirname, "../../logs");
const fileDescriptors = new Map(); // name -> fd
let rotationTimer = null;
let currentDay = new Date().toISOString().split("T")[0];

function ensureLogDirectory() {
	if (!fs.existsSync(logDir)) {
		fs.mkdirSync(logDir, { recursive: true });
	}
}

function getLogFile(name) {
	if (fileDescriptors.has(name)) {
		return fileDescriptors.get(name);
	}
	ensureLogDirectory();
	const logFileName = `${currentDay}-${name}.log`;
	const logFilePath = path.join(logDir, logFileName);
	try {
		const fd = fs.openSync(logFilePath, "a");
		fileDescriptors.set(name, fd);
		return fd;
	} catch (error) {
		console.error(`Erro ao abrir arquivo de log (${name}):`, error);
		return null;
	}
}

function closeAllLogFiles() {
	for (const [name, fd] of fileDescriptors.entries()) {
		try {
			if (fd) fs.closeSync(fd);
		} catch (error) {
			console.error(`Erro ao fechar arquivo de log (${name}):`, error);
		}
	}
	fileDescriptors.clear();
}

function setupGlobalRotation() {
	if (rotationTimer) return;
	const now = new Date();
	const tomorrow = new Date(now);
	tomorrow.setDate(now.getDate() + 1);
	tomorrow.setHours(0, 0, 0, 0);

	const timeUntilMidnight = tomorrow - now;

	rotationTimer = setTimeout(() => {
		currentDay = new Date().toISOString().split("T")[0];
		closeAllLogFiles();
		rotationTimer = null;
		setupGlobalRotation();
	}, timeUntilMidnight);

	if (rotationTimer.unref) {
		rotationTimer.unref();
	}
}

// Inicializa diretório e agendador global de rotação
ensureLogDirectory();
setupGlobalRotation();

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
		this.debugMode = process.env.DEBUG === "true";
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
		const logFd = getLogFile(this.name);
		if (logFd) {
			try {
				fs.writeSync(logFd, logMessage + "\n");
			} catch (error) {
				console.error("Erro ao escrever no arquivo de log:", error);
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
