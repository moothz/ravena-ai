const crypto = require("crypto");

/**
 * Funções e middlewares de autenticação para a BotAPI
 */

/**
 * Obtém ou deriva o segredo da sessão de admin
 * @param {Object} api - Instância da BotAPI
 * @returns {string}
 */
function getAdminSessionSecret(api) {
	if (!api._adminSessionSecret) {
		api._adminSessionSecret = crypto
			.createHash("sha256")
			.update(`${api.apiUser}:${api.apiPassword}:ravena_admin_salt`)
			.digest("hex");
	}
	return api._adminSessionSecret;
}

/**
 * Cria um token assinado para a sessão de admin
 * @param {Object} api - Instância da BotAPI
 * @returns {string}
 */
function createAdminSessionToken(api) {
	const timestamp = Date.now().toString();
	const secret = getAdminSessionSecret(api);
	const signature = crypto.createHmac("sha256", secret).update(timestamp).digest("hex");
	return `${timestamp}.${signature}`;
}

/**
 * Valida um token de sessão de admin
 * @param {Object} api - Instância da BotAPI
 * @param {string} token
 * @returns {boolean}
 */
function isValidAdminSession(api, token) {
	if (!token || typeof token !== "string") return false;
	const parts = token.split(".");
	if (parts.length !== 2) return false;

	const [timestampStr, signature] = parts;
	const timestamp = parseInt(timestampStr, 10);
	if (isNaN(timestamp)) return false;

	// Sessão expira em 30 dias
	const MAX_SESSION_AGE = 30 * 24 * 60 * 60 * 1000;
	if (Date.now() - timestamp > MAX_SESSION_AGE) {
		return false;
	}

	const secret = getAdminSessionSecret(api);
	const expectedSignature = crypto.createHmac("sha256", secret).update(timestampStr).digest("hex");

	try {
		return crypto.timingSafeEqual(
			Buffer.from(signature, "hex"),
			Buffer.from(expectedSignature, "hex")
		);
	} catch {
		return false;
	}
}

/**
 * Obtém um cookie da requisição
 * @param {import("express").Request} req
 * @param {string} name
 * @returns {string|null}
 */
function getCookie(req, name) {
	if (!req || !req.headers || !req.headers.cookie) return null;
	const cookies = req.headers.cookie.split(";");
	for (const cookie of cookies) {
		const [k, ...v] = cookie.trim().split("=");
		if (k === name) {
			return decodeURIComponent(v.join("="));
		}
	}
	return null;
}

/**
 * Define o cookie de sessão de admin na resposta
 * @param {Object} api - Instância da BotAPI
 * @param {import("express").Response} res
 */
function setAdminSessionCookie(api, res) {
	if (!res || res.headersSent) return;
	const token = createAdminSessionToken(api);
	const maxAge = 30 * 24 * 60 * 60; // 30 dias em segundos
	res.setHeader(
		"Set-Cookie",
		`ravena_admin_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
	);
}

/**
 * Remove o cookie de sessão de admin na resposta
 * @param {import("express").Response} res
 */
function clearAdminSessionCookie(res) {
	if (!res || res.headersSent) return;
	res.setHeader("Set-Cookie", "ravena_admin_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
}

/**
 * Verifica se a requisição possui credenciais válidas de administrador
 * @param {Object} api - Instância da BotAPI
 * @param {import("express").Request} req
 * @returns {boolean}
 */
function isAdmin(api, req) {
	if (!req) return false;

	// 1. Verifica cookie de sessão
	const sessionCookie = getCookie(req, "ravena_admin_session");
	if (sessionCookie && isValidAdminSession(api, sessionCookie)) {
		return true;
	}

	// 2. Verifica cabeçalho Authorization Basic ou query param auth
	let authHeader = req.headers ? req.headers.authorization : null;
	if (!authHeader && req.query && req.query.auth) {
		authHeader = req.query.auth.startsWith("Basic ") ? req.query.auth : "Basic " + req.query.auth;
	}

	if (authHeader && authHeader.startsWith("Basic ")) {
		try {
			const base64Credentials = authHeader.split(" ")[1];
			const credentials = Buffer.from(base64Credentials, "base64").toString("utf8");
			const [username, ...passParts] = credentials.split(":");
			const password = passParts.join(":");

			if (username === api.apiUser && password === api.apiPassword) {
				return true;
			}
		} catch (error) {
			api.logger.error("Erro ao verificar autenticação de admin:", error);
		}
	}

	return false;
}

/**
 * Cria o middleware de autenticação básica
 * @param {Object} api - Instância da BotAPI
 * @returns {import("express").RequestHandler}
 */
function createAuthenticateBasic(api) {
	return (req, res, next) => {
		const { botId } = req.params;
		let user = api.apiUser;
		let pass = api.apiPassword;

		if (botId) {
			const bot = api.bots.find((b) => b.id === botId);
			if (bot && bot.managementUser && bot.managementPW) {
				user = bot.managementUser;
				pass = bot.managementPW;
				api.logger.debug(`[authenticateBasic] Using credentials for bot '${botId}'`);
			}
		} else if (isAdmin(api, req)) {
			return next();
		}

		// Verifica se os cabeçalhos ou parâmetro de consulta existem
		let authHeader = req.headers.authorization;
		if (!authHeader && req.query && req.query.auth) {
			authHeader = req.query.auth.startsWith("Basic ") ? req.query.auth : "Basic " + req.query.auth;
		}

		if (!authHeader) {
			res.set("WWW-Authenticate", 'Basic realm="RavenaBot API"');
			return res.status(401).json({
				status: "error",
				message: "Autenticação requerida"
			});
		}

		// Decodifica e verifica credenciais
		try {
			const base64Credentials = authHeader.split(" ")[1];
			const credentials = Buffer.from(base64Credentials, "base64").toString("utf8");
			const [username, ...passParts] = credentials.split(":");
			const password = passParts.join(":");

			if (username === user && password === pass) {
				if (username === api.apiUser && password === api.apiPassword) {
					setAdminSessionCookie(api, res);
				}
				return next();
			}
		} catch (error) {
			api.logger.error("Erro ao processar autenticação básica:", error);
		}

		// Credenciais inválidas
		res.set("WWW-Authenticate", 'Basic realm="RavenaBot API"');
		return res.status(401).json({
			status: "error",
			message: "Credenciais inválidas"
		});
	};
}

/**
 * Cria o middleware para autenticar UPS via header secreto
 * @param {Object} api - Instância da BotAPI
 * @returns {import("express").RequestHandler}
 */
function createAuthenticateUPS(api) {
	return (req, res, next) => {
		if (!api.upsApiSecret) {
			api.logger.warn("UPS_API_SECRET não configurado. Endpoint UPS desprotegido!");
			return next();
		}

		const secret = req.headers["x-ups-secret"];
		if (secret && secret === api.upsApiSecret) {
			return next();
		}

		api.logger.warn(`Tentativa de acesso UPS não autorizado do IP: ${req.ip}`);
		return res.status(403).json({
			status: "error",
			message: "Não autorizado"
		});
	};
}

module.exports = {
	getAdminSessionSecret,
	createAdminSessionToken,
	isValidAdminSession,
	getCookie,
	setAdminSessionCookie,
	clearAdminSessionCookie,
	isAdmin,
	createAuthenticateBasic,
	createAuthenticateUPS
};
