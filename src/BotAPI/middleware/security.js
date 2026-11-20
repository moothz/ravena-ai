/**
 * Cabeçalhos e checagens de segurança gerais da BotAPI.
 * Arquivo: src/BotAPI/middleware/security.js
 */

/**
 * Proíbe que outros sites ponham as páginas da Ravena num iframe (clickjacking).
 * A própria Ravena continua podendo: o Desktop OS e o painel /admin embutem telas
 * da mesma origem. X-Frame-Options fica para navegadores que não leem frame-ancestors.
 * @returns {import("express").RequestHandler}
 */
function createFrameAncestorsGuard() {
	return (req, res, next) => {
		res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
		res.setHeader("X-Frame-Options", "SAMEORIGIN");
		next();
	};
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** GETs que mudam estado (legado: a tela /instances os chama com fetch da mesma origem). */
const STATEFUL_GET = /^\/(restart|logout)\/[^/]+\/?$/;

/**
 * Hosts aceitos como origem de uma escrita: o Host da requisição, o X-Forwarded-Host do
 * proxy reverso e os de BOTAPI_ALLOWED_ORIGINS (lista separada por vírgula, ex.:
 * "https://painel.exemplo,https://ravena.exemplo").
 * @param {import("express").Request} req
 * @returns {Set<string>}
 */
function allowedHosts(req) {
	const hosts = new Set();
	const add = (value) => {
		if (!value) return;
		for (const part of String(value).split(",")) {
			const host = part.trim().toLowerCase();
			if (host) hosts.add(host);
		}
	};
	add(req.headers.host);
	add(req.headers["x-forwarded-host"]);
	for (const origin of String(process.env.BOTAPI_ALLOWED_ORIGINS || "").split(",")) {
		try {
			if (origin.trim()) hosts.add(new URL(origin.trim()).host.toLowerCase());
		} catch {
			/* valor inválido: ignora */
		}
	}
	return hosts;
}

/**
 * Recusa (403) escritas com credencial de admin que vêm de outro site (CSRF): métodos
 * de escrita e os GETs /restart/:botId e /logout/:botId.
 *
 * Só olha requisições que carregam credencial (cookie de sessão, Authorization ou ?auth=),
 * porque é aí que o navegador anexa a sessão sozinho. Sem Origin e sem Sec-Fetch-Site
 * (webhooks, curl, servidor a servidor) a requisição passa como antes.
 * @param {{ hasCredentials: (req: import("express").Request) => boolean, logger?: Object }} options
 * @returns {import("express").RequestHandler}
 */
function createSameOriginGuard({ hasCredentials, logger } = {}) {
	return (req, res, next) => {
		const isWrite = WRITE_METHODS.has(req.method);
		const isStatefulGet = req.method === "GET" && STATEFUL_GET.test(req.path);
		if (!isWrite && !isStatefulGet) return next();
		if (typeof hasCredentials === "function" && !hasCredentials(req)) return next();

		const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
		const origin = req.headers.origin;
		let crossSite = site === "cross-site" || site === "same-site";
		if (!crossSite && origin) {
			try {
				crossSite = origin === "null" || !allowedHosts(req).has(new URL(origin).host.toLowerCase());
			} catch {
				crossSite = true;
			}
		}
		if (!crossSite) return next();

		logger?.warn?.(
			`Escrita recusada por origem: ${req.method} ${req.path} (Origin: ${origin || "-"}, Sec-Fetch-Site: ${site || "-"})`
		);
		return res.status(403).json({ status: "error", message: "Origem não permitida." });
	};
}

module.exports = { createFrameAncestorsGuard, createSameOriginGuard };
