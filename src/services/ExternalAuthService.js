const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Logger = require("../utils/Logger");

/**
 * Service to manage external API users, authentication and rate limits.
 */
class ExternalAuthService {
	/**
	 * Get Singleton Instance
	 * @returns {ExternalAuthService}
	 */
	static getInstance() {
		if (!ExternalAuthService.instance) {
			ExternalAuthService.instance = new ExternalAuthService();
		}
		return ExternalAuthService.instance;
	}

	constructor() {
		this.logger = new Logger("external-auth-service");
		this.usersPath = path.join(process.cwd(), "data", "external-API-users.json");
		this.users = [];
		this.usersMap = new Map(); // apiKey -> userObj
		this.rateLimitBuckets = new Map(); // key (userOrIp:service) -> { count, resetAt }
		this.lastLoadedTime = 0;

		this.defaultRateLimits = {
			imagine: 5, // 5 requests per minute
			llm: 10, // 10 requests per minute
			stt: 10, // 10 requests per minute
			tts: 20 // 20 requests per minute
		};

		this.loadUsers();
		this.setupWatcher();
		this.setupCleanupInterval();
	}

	/**
	 * Clean old rate limit buckets periodically
	 */
	setupCleanupInterval() {
		this.cleanupInterval = setInterval(() => {
			const now = Date.now();
			for (const [key, bucket] of this.rateLimitBuckets.entries()) {
				if (bucket.resetAt <= now) {
					this.rateLimitBuckets.delete(key);
				}
			}
		}, 60000);
	}

	/**
	 * Loads users from data/external-API-users.json
	 */
	loadUsers() {
		try {
			if (!fs.existsSync(this.usersPath)) {
				this.users = [];
				this.usersMap.clear();
				this.logger.debug(
					`Arquivo ${this.usersPath} não encontrado. Modo restrito ao próprio domínio ativo.`
				);
				return;
			}

			const data = fs.readFileSync(this.usersPath, "utf8");
			if (!data || data.trim() === "") {
				this.users = [];
				this.usersMap.clear();
				return;
			}

			const parsed = JSON.parse(data);
			if (!Array.isArray(parsed)) {
				throw new Error("external-API-users.json deve conter um array de usuários.");
			}

			this.users = parsed;
			this.usersMap.clear();

			for (const user of this.users) {
				if (user.apiKey && user.enabled !== false) {
					this.usersMap.set(user.apiKey, user);
				}
			}

			this.lastLoadedTime = Date.now();
			this.logger.info(`Carregados ${this.usersMap.size} usuário(s) de API externa.`);
		} catch (error) {
			this.logger.error(`Erro ao carregar external-API-users.json: ${error.message}`);
		}
	}

	/**
	 * Sets up file watcher for live changes
	 */
	setupWatcher() {
		const dir = path.dirname(this.usersPath);
		if (!fs.existsSync(dir)) {
			try {
				fs.mkdirSync(dir, { recursive: true });
			} catch (e) {}
		}

		let debounceTimeout;
		if (fs.existsSync(this.usersPath)) {
			fs.watch(this.usersPath, (event) => {
				if (debounceTimeout) clearTimeout(debounceTimeout);
				debounceTimeout = setTimeout(() => {
					this.logger.info("Alteração detectada em external-API-users.json, recarregando...");
					this.loadUsers();
				}, 100);
			});
		} else if (fs.existsSync(dir)) {
			fs.watch(dir, (event, filename) => {
				if (filename === path.basename(this.usersPath)) {
					if (debounceTimeout) clearTimeout(debounceTimeout);
					debounceTimeout = setTimeout(() => {
						this.logger.info("external-API-users.json criado/modificado, recarregando...");
						this.loadUsers();
					}, 100);
				}
			});
		}
	}

	/**
	 * Generates a standard API key
	 * @returns {string} e.g. "rav_live_..."
	 */
	static generateApiKey() {
		return "rav_live_" + crypto.randomBytes(20).toString("hex");
	}

	/**
	 * Validates an API key
	 * @param {string} apiKey
	 * @returns {Object|null}
	 */
	getUserByApiKey(apiKey) {
		if (!apiKey) return null;
		const cleanKey = apiKey.startsWith("Bearer ") ? apiKey.slice(7).trim() : apiKey.trim();
		return this.usersMap.get(cleanKey) || null;
	}

	/**
	 * Checks if a request comes from the bot's own domain or same-origin
	 * @param {import('express').Request} req
	 * @returns {boolean}
	 */
	isOwnDomain(req) {
		// Allowed domains from .env
		const botDomain = process.env.BOT_DOMAIN || "";
		const botDomainLocal = process.env.BOT_DOMAIN_LOCAL || "";
		const groupWebhooksDomain = process.env.GROUP_WEBHOOKS_DOMAIN || "";

		const allowedHosts = new Set(["localhost", "127.0.0.1"]);

		const extractHostname = (urlStr) => {
			if (!urlStr) return null;
			try {
				const parsed = new URL(urlStr.startsWith("http") ? urlStr : `http://${urlStr}`);
				return parsed.hostname.toLowerCase();
			} catch (e) {
				return null;
			}
		};

		[botDomain, botDomainLocal, groupWebhooksDomain].forEach((u) => {
			const host = extractHostname(u);
			if (host) allowedHosts.add(host);
		});

		// Current Request Host
		const currentHost = (req.hostname || req.headers.host || "").split(":")[0].toLowerCase();
		if (currentHost) {
			allowedHosts.add(currentHost);
		}

		const origin = req.headers.origin;
		const referer = req.headers.referer;
		const secFetchSite = req.headers["sec-fetch-site"];

		// Browser same-origin requests
		if (secFetchSite === "same-origin") {
			return true;
		}

		if (origin) {
			const originHost = extractHostname(origin);
			if (originHost && allowedHosts.has(originHost)) {
				return true;
			}
		}

		if (referer) {
			const refererHost = extractHostname(referer);
			if (refererHost && allowedHosts.has(refererHost)) {
				return true;
			}
		}

		// If no Origin and no Referer and it has local/internal host with accept text/html
		// (e.g. browser direct navigation)
		if (!origin && !referer && req.accepts("html") && !req.xhr) {
			return true;
		}

		return false;
	}

	/**
	 * Rate limiter check for a specific service
	 * @param {string} identifier - User name or IP
	 * @param {string} service - 'imagine' | 'llm' | 'stt' | 'tts'
	 * @param {number} maxPerMinute - Maximum allowed requests in 1 minute
	 * @returns {{ allowed: boolean, remaining: number, resetInSeconds: number }}
	 */
	checkRateLimit(identifier, service, maxPerMinute) {
		const key = `${identifier}:${service}`;
		const now = Date.now();
		let bucket = this.rateLimitBuckets.get(key);

		if (!bucket || bucket.resetAt <= now) {
			bucket = {
				count: 1,
				resetAt: now + 60000
			};
			this.rateLimitBuckets.set(key, bucket);
			return {
				allowed: true,
				remaining: maxPerMinute - 1,
				resetInSeconds: 60
			};
		}

		if (bucket.count >= maxPerMinute) {
			const resetInSeconds = Math.ceil((bucket.resetAt - now) / 1000);
			return {
				allowed: false,
				remaining: 0,
				resetInSeconds
			};
		}

		bucket.count += 1;
		const resetInSeconds = Math.ceil((bucket.resetAt - now) / 1000);
		return {
			allowed: true,
			remaining: maxPerMinute - bucket.count,
			resetInSeconds
		};
	}

	/**
	 * Express middleware to protect service endpoints
	 * @param {string} service - 'imagine' | 'llm' | 'stt' | 'tts'
	 */
	requireAccess(service) {
		return (req, res, next) => {
			const apiKeyHeader =
				req.headers["x-api-key"] ||
				req.headers["x-apikey"] ||
				req.headers["authorization"] ||
				req.query.api_key;

			let user = null;
			if (apiKeyHeader) {
				user = this.getUserByApiKey(apiKeyHeader);
			}

			// Case 1: Authenticated via valid External API Key
			if (user) {
				const maxRequests =
					(user.rateLimits && user.rateLimits[service]) || this.defaultRateLimits[service] || 10;

				const rateCheck = this.checkRateLimit(`user:${user.name}`, service, maxRequests);

				res.setHeader("X-RateLimit-Limit", maxRequests);
				res.setHeader("X-RateLimit-Remaining", Math.max(0, rateCheck.remaining));
				res.setHeader("X-RateLimit-Reset", rateCheck.resetInSeconds);

				if (!rateCheck.allowed) {
					return res.status(429).json({
						error: "Rate limit exceeded",
						service,
						message: `Limite de requisições excedido para '${service}'. Tente novamente em ${rateCheck.resetInSeconds}s.`
					});
				}

				req.apiUser = user.name;
				req.isExternal = true;
				return next();
			}

			// Case 2: Originating from own domain
			if (this.isOwnDomain(req)) {
				// Apply default rate limit by IP for own domain web users
				const maxRequests = this.defaultRateLimits[service] || 10;
				const clientIp = req.ip || req.connection.remoteAddress || "local";
				const rateCheck = this.checkRateLimit(`ip:${clientIp}`, service, maxRequests);

				res.setHeader("X-RateLimit-Limit", maxRequests);
				res.setHeader("X-RateLimit-Remaining", Math.max(0, rateCheck.remaining));
				res.setHeader("X-RateLimit-Reset", rateCheck.resetInSeconds);

				if (!rateCheck.allowed) {
					return res.status(429).json({
						error: "Rate limit exceeded",
						service,
						message: `Muitas requisições para '${service}'. Tente novamente em ${rateCheck.resetInSeconds}s.`
					});
				}

				req.apiUser = null;
				req.isExternal = false;
				return next();
			}

			// Case 3: Unauthorized
			if (apiKeyHeader) {
				return res.status(401).json({
					error: "Unauthorized",
					message: "Chave de API inválida ou desabilitada."
				});
			}

			return res.status(401).json({
				error: "Unauthorized",
				message:
					"Acesso negado. Requisições externas requerem autenticação via header 'X-API-Key' ou 'Authorization: Bearer <chave>'."
			});
		};
	}
}

module.exports = ExternalAuthService;
