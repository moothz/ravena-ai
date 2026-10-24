const fs = require("fs");
const path = require("path");
const util = require("util");

const LOG_DIR = path.join(__dirname, "../../logs");
const FLUSH_INTERVAL_MS = 250;
const MAX_BUFFER_BYTES = 256 * 1024;

const today = () => new Date().toISOString().split("T")[0]; // YYYY-MM-DD

/**
 * Arquivos de log compartilhados por nome: dezenas de Loggers com o mesmo nome
 * usam um unico descritor, um buffer e uma unica rotacao.
 * @type {Map<string, {fd: number|null, date: string, buffer: string[], size: number}>}
 */
const sinks = new Map();
let flushTimer = null;
let dirReady = false;

function ensureLogDirectory() {
	if (dirReady) return;
	if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
	dirReady = true;
}

function openSink(name, sink) {
	if (sink.fd !== null) {
		try {
			fs.closeSync(sink.fd);
		} catch (error) {
			console.error("Erro ao fechar arquivo de log:", error);
		}
		sink.fd = null;
	}
	try {
		sink.fd = fs.openSync(path.join(LOG_DIR, `${sink.date}-${name}.log`), "a");
	} catch (error) {
		console.error("Erro ao abrir arquivo de log:", error);
	}
}

function flushSink(name, sink) {
	if (sink.buffer.length === 0) return;
	const chunk = sink.buffer.join("");
	sink.buffer = [];
	sink.size = 0;
	if (sink.fd === null) return;
	try {
		fs.writeSync(sink.fd, chunk);
	} catch (error) {
		console.error("Erro ao escrever no arquivo de log:", error);
		openSink(name, sink); // tenta reabrir; o lote perdido nao e reenviado
	}
}

function flushAll() {
	for (const [name, sink] of sinks) flushSink(name, sink);
}

function tick() {
	const date = today();
	for (const [name, sink] of sinks) {
		flushSink(name, sink);
		if (sink.date !== date) {
			sink.date = date;
			openSink(name, sink);
		}
	}
}

function getSink(name) {
	let sink = sinks.get(name);
	if (!sink) {
		ensureLogDirectory();
		sink = { fd: null, date: today(), buffer: [], size: 0 };
		sinks.set(name, sink);
		openSink(name, sink);
		if (!flushTimer) {
			flushTimer = setInterval(tick, FLUSH_INTERVAL_MS);
			flushTimer.unref();
			process.on("exit", flushAll);
		}
	}
	return sink;
}

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
		this.sink = getSink(name);
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
		const sink = this.sink;
		sink.buffer.push(logMessage + "\n");
		sink.size += logMessage.length;
		if (sink.size >= MAX_BUFFER_BYTES) flushSink(this.name, sink);
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
