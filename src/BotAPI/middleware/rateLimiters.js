const rateLimit = require("express-rate-limit");

/**
 * Cria os rate limiters padrão da BotAPI
 * @returns {{ generalLimiter: import("express").RequestHandler, strictLimiter: import("express").RequestHandler }}
 */
function createRateLimiters() {
	const generalLimiter = rateLimit({
		windowMs: 1 * 60 * 1000, // 1 minuto
		max: 100, // 100 requisições por IP
		message: { status: "error", message: "Muitas requisições, tente novamente em 1 minuto." },
		standardHeaders: true,
		legacyHeaders: false,
		validate: { trustProxy: false }
	});

	const strictLimiter = rateLimit({
		windowMs: 1 * 60 * 1000, // 1 minuto
		max: 10, // 10 requisições por IP (para endpoints pesados)
		message: { status: "error", message: "Limite excedido. Tente novamente em breve." },
		standardHeaders: true,
		legacyHeaders: false,
		validate: { trustProxy: false }
	});

	return { generalLimiter, strictLimiter };
}

module.exports = { createRateLimiters };
