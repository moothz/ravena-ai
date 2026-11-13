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

/**
 * Cria os limitadores dedicados das rotas internas de mercado (/api/market/*).
 * - authFailureLimiter: conta apenas respostas 401 (segredo inválido) para conter força bruta.
 * - limiter: teto geral por IP, folgado o bastante para o tráfego servidor-a-servidor do Waifuletes.
 * @returns {{ limiter: import("express").RequestHandler, authFailureLimiter: import("express").RequestHandler }}
 */
function createMarketRateLimiters() {
	const authFailureLimiter = rateLimit({
		windowMs: 15 * 60 * 1000, // 15 minutos
		max: 20, // 20 tentativas com segredo inválido por IP
		skipSuccessfulRequests: true,
		requestWasSuccessful: (req, res) => res.statusCode !== 401,
		message: {
			success: false,
			reason: "Muitas tentativas não autorizadas. Tente novamente mais tarde."
		},
		standardHeaders: true,
		legacyHeaders: false,
		validate: { trustProxy: false }
	});

	const limiter = rateLimit({
		windowMs: 1 * 60 * 1000, // 1 minuto
		max: 300, // chamadas autenticadas do Waifuletes (inventário + transferências)
		message: { success: false, reason: "Limite de requisições do mercado excedido." },
		standardHeaders: true,
		legacyHeaders: false,
		validate: { trustProxy: false }
	});

	return { limiter, authFailureLimiter };
}

module.exports = { createRateLimiters, createMarketRateLimiters };
