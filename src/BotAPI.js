const express = require("express");
const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const Logger = require("./utils/Logger");
const Database = require("./utils/Database");
const path = require("path");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const upload = multer({
	dest: "uploads/",
	limits: { fileSize: 50 * 1024 * 1024 }
});
const fs = require("fs").promises;
const qrcode = require("qr-base64");
const { exec, spawn } = require("child_process");
const axios = require("axios");
const WebManagement = require("./utils/WebManagement");
const { v4: uuidv4 } = require("uuid");
const { CATEGORY_EMOJIS, COMMAND_ORDER } = require("./functions/MenuOrder");
const ServiceProviderService = require("./services/ServiceProviderService");
const SpeechCommands = require("./functions/SpeechCommands");

const WEBHOOK_RATE_LIMIT = 120000;

/**
 * Servidor API para o bot WhatsApp
 */
class BotAPI {
	/**
	 * Cria um novo servidor API
	 * @param {Object} options - Opções de configuração
	 * @param {number} options.port - Porta para escutar
	 * @param {Array} options.bots - Array de instâncias de WhatsAppBot
	 */
	constructor(options = {}) {
		this.port = options.port ?? process.env.API_PORT ?? 5000;
		this.bots = options.bots ?? [];
		this.eventHandler = options.eventHandler ?? false;
		this.logger = new Logger("bot-api");
		this.database = Database.getInstance();
		this.app = express();
		this.app.set("trust proxy", true);

		// Inject botApi reference into bots
		this.bots.forEach((bot) => {
			bot.botApi = this;
		});

		// Webhook Server Init
		if (process.env.GROUP_WEBHOOKS) {
			this.webhookApp = express();
			this.webhookApp.set("trust proxy", true);
			this.webhookLogger = new Logger("group-webhooks");
			this.webhooksCache = new Map(); // groupId -> [webhooks]
			this.webhookRateLimits = new Map(); // botId:groupId -> { lastSent, buffer, timeout }
			this.webhookServer = null;
		}

		// Credenciais de autenticação para endpoints protegidos
		this.apiUser = process.env.BOTAPI_USER ?? "admin";
		this.apiPassword = process.env.BOTAPI_PASSWORD ?? "senha12345";
		this.upsApiSecret = process.env.UPS_API_SECRET ?? false;

		// Configura Rate Limiters
		this.generalLimiter = rateLimit({
			windowMs: 1 * 60 * 1000, // 1 minuto
			max: 100, // 100 requisições por IP
			message: { status: "error", message: "Muitas requisições, tente novamente em 1 minuto." },
			standardHeaders: true,
			legacyHeaders: false
		});

		this.strictLimiter = rateLimit({
			windowMs: 1 * 60 * 1000, // 1 minuto
			max: 10, // 10 requisições por IP (para endpoints pesados)
			message: { status: "error", message: "Limite excedido. Tente novamente em breve." },
			standardHeaders: true,
			legacyHeaders: false
		});

		// Estado da UPS
		this.lastUpsStatus = null;
		this.lastServicesStatus = null;
		this.upsTimeout = null;
		this.powerOutageNotified = false;
		this.powerOutageMinTime = (parseInt(process.env.POWER_OUTAGE_MIN_TIME) || 5) * 1000;

		// Cache para os dados analíticos processados
		this.analyticsCache = {
			lastUpdate: 0, // Timestamp da última atualização
			cacheTime: 10 * 60000, // Tempo de cache (10 minutos)
			daily: {}, // Dados diários por bot
			weekly: {}, // Dados semanais por bot
			monthly: {}, // Dados mensais por bot
			yearly: {} // Dados anuais por bot
		};

		// Cache para estatísticas gerais dos bots (tabela)
		this.botStatsCache = {
			lastUpdate: 0,
			cacheTime: 30 * 60000, // 30 minutos
			data: []
		};

		this.isUpdatingAnalytics = false;
		this.sseClients = [];

		if (this.eventHandler) {
			this.eventHandler.on("activity", (data) => {
				this.broadcastSSE("activity", data);
			});
		}

		// Configura middlewares
		this.app.use(bodyParser.json({ limit: "50mb" }));
		this.app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

		// Configura rotas
		this.setupRoutes();

		this.app.use(express.static(path.join(__dirname, "../public")));

		// Carrega dados analíticos em cache ao iniciar
		this.updateAnalyticsCache();

		this.serviceProviderService = ServiceProviderService.getInstance();
		this.sttJobs = new Map();

		// Configura atualização periódica do cache (a cada 10 minutos)
		this.cacheUpdateInterval = setInterval(
			() => this.updateAnalyticsCache(),
			this.analyticsCache.cacheTime
		);

		// Configura verificação periódica de serviços (a cada 30 segundos)
		this.checkServicesInterval = setInterval(() => this.checkServices(), 30000);

		// Limpeza periódica de jobs de STT (a cada hora)
		this.sttCleanupInterval = setInterval(() => {
			const now = Date.now();
			for (const [id, job] of this.sttJobs.entries()) {
				if (now - job.startTime > 3600000) {
					this.sttJobs.delete(id);
				}
			}
		}, 3600000);
	}

	/**
	 * Broadcast SSE event to all connected clients
	 * @param {string} type - Event type
	 * @param {Object} data - Event data
	 */
	broadcastSSE(type, data) {
		this.sseClients.forEach((res) => {
			res.write(`event: ${type}\n`);
			res.write(`data: ${JSON.stringify(data)}\n\n`);
		});
	}

	/**
	 * Verifica o status dos serviços externos e emite via SSE
	 */
	async checkServices() {
		const services = {
			whatsgoapi: "unknown",
			imagine: "down",
			llm: "down",
			whisper: "down",
			f5tts: "down",
			sdwebui: "down"
		};

		const checkUrl = async (url) => {
			if (!url) return false;
			try {
				await axios.get(url, {
					timeout: 2000,
					validateStatus: (status) => status >= 200 && status < 500
				});
				return true;
			} catch (e) {
				console.error(`[BotAPI] Error checking URL ${url}:`, e.message);
				return false;
			}
		};

		// 1. Check WhatsgoAPI Health
		try {
			const whatsgoUrl = process.env.WHATS_GO_API_URL || "http://whatsgoapi:8080";
			const whatsgoUp = await checkUrl(`${whatsgoUrl}/server/ok`);
			services.whatsgoapi = whatsgoUp ? "up" : "down";

			if (whatsgoUp && this.bots && Array.isArray(this.bots)) {
				for (const bot of this.bots) {
					if (typeof bot._checkInstanceStatusAndConnect === "function") {
						try {
							await bot._checkInstanceStatusAndConnect(true, false);
						} catch (err) {
							// Ignora erro no check silencioso
						}
					}
				}
			}
		} catch (e) {
			services.whatsgoapi = "down";
		}

		const checkCategoryStatus = async (category) => {
			const providers = this.serviceProviderService.getProviders(category);
			if (providers.length === 0) return "down";

			// First is main
			const mainUp = await checkUrl(providers[0].url);
			if (mainUp) return "up";

			// Others are backup
			for (let i = 1; i < providers.length; i++) {
				if (await checkUrl(providers[i].url)) return "backup";
			}

			return "down";
		};

		services.imagine = await checkCategoryStatus("bonsai");
		const LLMService = require("./services/LLMService");
		services.llm = LLMService.getInstance().getDetailedStatus();
		services.whisper = await checkCategoryStatus("whisper");
		services.f5tts = await checkCategoryStatus("f5tts");
		services.sdwebui = await checkCategoryStatus("sdwebui");

		this.lastServicesStatus = services;

		this.broadcastSSE("service-status", services);

		try {
			await fs.writeFile(
				path.join(this.database.databasePath, "services-status.json"),
				JSON.stringify(services, null, 2)
			);
		} catch (error) {
			this.logger.error("Erro ao salvar status dos serviços:", error);
		}
	}

	// Helper function to read tokens
	async readWebManagementToken(token) {
		try {
			return await WebManagement.getInstance().getToken(token);
		} catch (error) {
			this.logger.error("Error reading web management token:", error);
			return null;
		}
	}

	/**
	 * Configura rotas da API
	 */
	setupRoutes() {
		// Endpoint SSE para streaming de eventos
		this.app.get("/api/stream", (req, res) => {
			// 1. Set Headers
			res.setHeader("Content-Type", "text/event-stream");
			res.setHeader("Cache-Control", "no-cache");
			res.setHeader("Connection", "keep-alive");
			res.flushHeaders();

			// 2. Send initial data (current service status)
			if (this.lastServicesStatus) {
				res.write(`event: service-status\n`);
				res.write(`data: ${JSON.stringify(this.lastServicesStatus)}\n\n`);
			}

			// 3. Add to clients list
			this.sseClients.push(res);

			// 4. Handle disconnect
			req.on("close", () => {
				this.sseClients = this.sseClients.filter((client) => client !== res);
			});
		});

		// Endpoint de verificação de saúde
		this.app.get("/health", async (req, res) => {
			try {
				// Obtém timestamp de 30 minutos atrás
				const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;

				// Obtém relatórios de carga mais recentes
				const recentReports = await this.database.getLoadReports(thirtyMinutesAgo);

				// Mapeia resultados por bot
				const botReports = {};
				if (recentReports && Array.isArray(recentReports)) {
					recentReports.forEach((report) => {
						// Se não existir um relatório para este bot ou se for mais recente
						if (
							!botReports[report.botId] ||
							report.timestamp > botReports[report.botId].timestamp
						) {
							botReports[report.botId] = report;
						}
					});
				}

				// Prepara resposta com dados adicionais
				res.json({
					status: "ok",
					timestamp: Date.now(),
					bots: this.bots
						.filter((bot) => !bot.privado && !bot.useTelegram && !bot.useDiscord)
						.map((bot) => {
							// Busca relatório mais recente para este bot
							const report = botReports[bot.id] ?? null;
							const messagesPerHour =
								report && report.messages ? (report.messages.messagesPerHour ?? 0) : 0;

							// Adiciona informações de tempo de resposta
							const avgResponseTime =
								report && report.responseTime ? (parseFloat(report.responseTime.average) ?? 0) : 0;
							const maxResponseTime =
								report && report.responseTime ? (report.responseTime.max ?? 0) : 0;

							return {
								id: bot.id,
								phoneNumber: bot.phoneNumber,
								supportNumber: bot.supportNumber,
								connected: bot.isConnected,
								lastMessageReceived: bot.lastMessageReceived ?? null,
								msgsHr: messagesPerHour,
								responseTime: {
									avg: avgResponseTime,
									max: maxResponseTime
								},
								semPV: bot.ignorePV ?? false,
								semConvites: bot.ignoreInvites ?? false,
								banido: bot.banido ?? false,
								comunitario: bot.comunitario ?? false,
								numeroResponsavel: bot.numeroResponsavel ?? false,
								supportMsg: bot.supportMsg ?? false,
								vip: bot.vip ?? false
							};
						})
				});
			} catch (error) {
				this.logger.error("Erro ao processar dados de health:", error);
				res.json({
					status: "error",
					timestamp: Date.now(),
					message: "Erro ao processar dados",
					bots: this.bots.map((bot) => ({
						id: bot.id,
						phoneNumber: bot.phoneNumber,
						connected: bot.isConnected,
						lastMessageReceived: bot.lastMessageReceived ?? null,
						msgsHr: 0,
						responseTime: {
							avg: 0,
							max: 0
						},
						semPV: bot.ignorePV ?? false,
						semConvites: bot.ignoreInvites ?? false,
						banido: bot.banido ?? false,
						comunitario: bot.comunitario ?? false,
						numeroResponsavel: bot.numeroResponsavel ?? false,
						supportMsg: bot.supportMsg ?? false,
						vip: bot.vip ?? false
					}))
				});
			}
		});

		// Middleware de autenticação básica
		const authenticateBasic = (req, res, next) => {
			const { botId } = req.params;
			let user = this.apiUser;
			let pass = this.apiPassword;

			if (botId) {
				const bot = this.bots.find((b) => b.id === botId);
				if (bot && bot.managementUser && bot.managementPW) {
					user = bot.managementUser;
					pass = bot.managementPW;
					this.logger.debug(`[authenticateBasic] Using credentials for bot '${botId}'`);
				}
			}

			// Verifica se os cabeçalhos ou parâmetro de consulta existem
			let authHeader = req.headers.authorization;
			if (!authHeader && req.query.auth) {
				authHeader = req.query.auth.startsWith("Basic ")
					? req.query.auth
					: "Basic " + req.query.auth;
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
				// O formato é 'Basic <base64 encoded username:password>'
				const base64Credentials = authHeader.split(" ")[1];
				const credentials = Buffer.from(base64Credentials, "base64").toString("utf8");
				const [username, password] = credentials.split(":");

				if (username === user && password === pass) {
					return next();
				}
			} catch (error) {
				this.logger.error("Erro ao processar autenticação básica:", error);
			}

			// Credenciais inválidas
			res.set("WWW-Authenticate", 'Basic realm="RavenaBot API"');
			return res.status(401).json({
				status: "error",
				message: "Credenciais inválidas"
			});
		};

		// Middleware para autenticar UPS via header secreto
		const authenticateUPS = (req, res, next) => {
			if (!this.upsApiSecret) {
				this.logger.warn("UPS_API_SECRET não configurado. Endpoint UPS desprotegido!");
				return next();
			}

			const secret = req.headers["x-ups-secret"];
			if (secret && secret === this.upsApiSecret) {
				return next();
			}

			this.logger.warn(`Tentativa de acesso UPS não autorizado do IP: ${req.ip}`);
			return res.status(403).json({
				status: "error",
				message: "Não autorizado"
			});
		};

		// Aplica limiter geral em todas as rotas da API
		this.app.use("/api/", this.generalLimiter);

		// Novo endpoint para reiniciar um bot específico (requer autenticação)
		this.app.get("/restart/:botId", authenticateBasic, this.strictLimiter, async (req, res) => {
			try {
				// Obter parâmetros
				const { botId } = req.params;
				const { reason } = req.body ?? {};

				// Validar parâmetros
				if (!botId) {
					return res.status(400).json({
						status: "error",
						message: "ID do bot não especificado"
					});
				}

				// Encontrar o bot solicitado
				const bot = this.bots.find((b) => b.id === botId);
				if (!bot) {
					return res.status(404).json({
						status: "error",
						message: `Bot com ID '${botId}' não encontrado`
					});
				}

				// Verificar se o método de reinicialização está disponível
				if (typeof bot.restartBot !== "function") {
					return res.status(400).json({
						status: "error",
						message: `Bot '${botId}' não suporta reinicialização`
					});
				}

				// Iniciar reinicialização em modo assíncrono
				const restartReason =
					reason ?? `Reinicialização via API em ${new Date().toLocaleString("pt-BR")}`;

				try {
					this.logger.info(`Reiniciando bot ${botId} via endpoint API`);
					const resp = await bot.restartBot(restartReason);
					res.json({
						status: "ok",
						message: resp,
						timestamp: Date.now()
					});
					this.logger.info(`Bot ${botId} reiniciado com sucesso via API`);
				} catch (error) {
					this.logger.error(`Erro ao reiniciar bot ${botId} via API:`, error);
					res.json({
						status: "error",
						message: error,
						timestamp: Date.now()
					});
				}
			} catch (error) {
				this.logger.error("Erro no endpoint de reinicialização:", error);
				res.status(500).json({
					status: "error",
					message: "Erro interno do servidor"
				});
			}
		});

		// Endpoint para testar o layout da página 502
		this.app.get("/502", async (req, res) => {
			try {
				const fallbackPath = path.join(__dirname, "../fallback-proxy/fallback.html");
				let html = await fs.readFile(fallbackPath, "utf8");

				const reasonHtml = `<div class="reason-box">
					<span class="reason-title"><i class="fas fa-info-circle"></i> Modo de Teste:</span>
					<p class="reason-text">Esta é uma demonstração do layout da página de indisponibilidade (Erro 502) acionada para testes pelo administrador.</p>
				</div>`;

				html = html.replace("{{MOTIVO}}", reasonHtml);
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.status(200).send(html);
			} catch (error) {
				this.logger.error("Erro ao carregar página de teste 502:", error);
				res.status(500).send("Erro interno ao carregar a página de teste 502.");
			}
		});

		this.app.get("/logout/:botId", authenticateBasic, this.strictLimiter, async (req, res) => {
			const { botId } = req.params;
			const bot = this.bots.find((b) => b.id === botId);
			if (!bot) {
				return res
					.status(404)
					.json({ status: "error", message: `Bot com ID '${botId}' não encontrado` });
			}
			try {
				this.logger.info(`[API] Executing logout for bot '${botId}'`);
				const result = await bot.logout();
				res.json({ status: "ok", message: "Logout successful", details: result });
			} catch (e) {
				this.logger.error(`[API] Error during logout for bot '${botId}':`, e);
				res.status(500).json({ status: "error", message: e.message, details: e.stack });
			}
		});

		this.app.get("/recreate/:botId", authenticateBasic, this.strictLimiter, async (req, res) => {
			const { botId } = req.params;
			const bot = this.bots.find((b) => b.id === botId);
			if (!bot) {
				return res
					.status(404)
					.json({ status: "error", message: `Bot com ID '${botId}' não encontrado` });
			}
			try {
				this.logger.info(`[API] Executing recreate for bot '${botId}'`);
				const result = await bot.recreateInstance();
				res.json({ status: "ok", message: "Recreation process finished.", details: result });
			} catch (e) {
				this.logger.error(`[API] Error during recreate for bot '${botId}':`, e);
				res.status(500).json({ status: "error", message: e.message, details: e.stack });
			}
		});

		this.app.post(
			"/passkey/respond/:botId",
			authenticateBasic,
			this.strictLimiter,
			async (req, res) => {
				const { botId } = req.params;
				const bot = this.bots.find((b) => b.id === botId);
				if (!bot) {
					return res
						.status(404)
						.json({ status: "error", message: `Bot com ID '${botId}' não encontrado` });
				}
				try {
					const response = await bot.apiClient.post("/instance/passkey/respond", req.body);
					res.json(response.data || response);
				} catch (e) {
					this.logger.error(`[API] Error during passkey respond for bot '${botId}':`, e);
					res.status(500).json({ status: "error", message: e.message, details: e.stack });
				}
			}
		);

		this.app.post(
			"/passkey/confirm/:botId",
			authenticateBasic,
			this.strictLimiter,
			async (req, res) => {
				const { botId } = req.params;
				const bot = this.bots.find((b) => b.id === botId);
				if (!bot) {
					return res
						.status(404)
						.json({ status: "error", message: `Bot com ID '${botId}' não encontrado` });
				}
				try {
					const response = await bot.apiClient.post("/instance/passkey/confirm", {});
					res.json(response.data || response);
				} catch (e) {
					this.logger.error(`[API] Error during passkey confirm for bot '${botId}':`, e);
					res.status(500).json({ status: "error", message: e.message, details: e.stack });
				}
			}
		);

		// Webhook de doação do Tipa.ai
		this.app.post("/donate_tipa", this.strictLimiter, async (req, res) => {
			try {
				this.logger.info("Recebido webhook de doação do Tipa.ai");

				// Registra a requisição completa para depuração
				const donateData = {
					headers: req.headers,
					body: req.body
				};

				this.logger.debug("Dados da doação:", donateData);

				// Verifica o segredo do webhook
				const headerTipa = req.headers["x-tipa-webhook-secret-token"] ?? false;
				const expectedToken = process.env.TIPA_TOKEN;

				if (!headerTipa || headerTipa !== expectedToken) {
					this.logger.warn("Token webhook inválido:", headerTipa);
					return res.status(403).send("-");
				}

				// Extrai detalhes da doação
				let nome = req.body.payload.tip.name ?? "Alguém";
				const valor = parseFloat(req.body.payload.tip.amount) ?? 0;
				const msg = req.body.payload.tip.message ?? "";

				nome = nome.trim();

				if (valor <= 0) {
					this.logger.warn(`Valor de doação inválido: ${valor}`);
					return res.send("ok");
				}

				// Adiciona doação ao banco de dados
				const donationTotal = await this.database.addDonation(nome, valor);

				// Notifica grupos sobre a doação
				await this.notifyGroupsAboutDonation(nome, valor, msg, donationTotal);

				res.send("ok");
			} catch (error) {
				this.logger.error("Erro ao processar webhook de doação:", error);
				res.status(500).send("error");
			}
		});

		// UPS Power Change Endpoint
		this.app.post("/UPS/powerChange", authenticateUPS, this.strictLimiter, async (req, res) => {
			try {
				const { status, data } = req.body;
				this.logger.info(`UPS power change: ${status}`);

				if (this.lastUpsStatus === status) {
					return res.send("ok - status unchanged");
				}

				if (status === "OB") {
					// Outage detected - start debounce timer
					if (this.upsTimeout) clearTimeout(this.upsTimeout);

					this.upsTimeout = setTimeout(async () => {
						const message =
							"🚨⚡️ *URGENTE*: _queda de energia_ ⚡️🚨\nO servidor está atualmente sendo suportado pelo Nobreak. Se a energia não retornar em alguns segundos, todos os serviços serão desligados por segurança";
						this.lastUpsStatus = "OB";
						this.powerOutageNotified = true;
						this.upsTimeout = null;
						await this.notifyPowerStatus(message);
					}, this.powerOutageMinTime);

					return res.send(`ok - debounce started (${this.powerOutageMinTime / 1000}s)`);
				} else if (status === "OL") {
					// Power restored
					// If we were waiting to notify about OB, cancel it
					if (this.upsTimeout) {
						clearTimeout(this.upsTimeout);
						this.upsTimeout = null;
						this.lastUpsStatus = "OL";
						return res.send("ok - outage cancelled (debounced)");
					}

					// Only notify OL if OB was actually notified
					if (this.powerOutageNotified) {
						const message = "⚡️✅ *Energia restabelecida*: _podemos relaxar (por enquanto)_";
						this.lastUpsStatus = "OL";
						this.powerOutageNotified = false;
						await this.notifyPowerStatus(message);
						return res.send("ok - restoration notified");
					}

					this.lastUpsStatus = "OL";
					return res.send("ok - status updated to OL");
				}

				res.send("ok - ignored status");
			} catch (error) {
				this.logger.error("Error processing UPS powerChange:", error);
				res.status(500).send("error");
			}
		});

		// UPS Power Critical Endpoint
		this.app.post("/UPS/powerCritical", authenticateUPS, this.strictLimiter, async (req, res) => {
			try {
				const { status, level, data } = req.body;
				this.logger.info(`UPS power CRITICAL: ${level}%`);

				if (this.lastUpsStatus === "CRITICAL") {
					return res.send("ok - status unchanged");
				}

				// Cancel any pending OB notification
				if (this.upsTimeout) {
					clearTimeout(this.upsTimeout);
					this.upsTimeout = null;
				}

				const message =
					"🚨⚡️🚨 *URGENTE*: _desligamento_ 🚨⚡️🚨\nA energia não retornou, então o servidor será desligado agora - voltando apenas de forma manual.";

				this.lastUpsStatus = "CRITICAL";
				this.powerOutageNotified = true;
				await this.notifyPowerStatus(message);
				res.send("ok");
			} catch (error) {
				this.logger.error("Error processing UPS powerCritical:", error);
				res.status(500).send("error");
			}
		});

		// Endpoint para estatísticas de LLM
		this.app.get("/llm-stats", authenticateBasic, this.strictLimiter, async (req, res) => {
			try {
				const StatsService = require("./services/StatsService");
				const statsService = new StatsService();

				if (req.query.queue !== undefined) {
					const queueStatus = statsService.getQueueStatus();
					return res.json({
						status: "ok",
						timestamp: Date.now(),
						queue: queueStatus
					});
				}

				const stats = await statsService.getStatsByRange();
				res.json({
					status: "ok",
					timestamp: Date.now(),
					data: stats
				});
			} catch (error) {
				this.logger.error("Erro ao obter estatísticas de LLM:", error);
				res.status(500).json({
					status: "error",
					message: "Erro interno ao buscar estatísticas"
				});
			}
		});

		// Endpoint para obter relatórios de carga
		this.app.post("/getLoad", this.strictLimiter, async (req, res) => {
			try {
				const { timestamp } = req.body;

				if (!timestamp || isNaN(parseInt(timestamp))) {
					return res.status(400).json({
						status: "error",
						message: "Timestamp inválido ou ausente"
					});
				}

				// Obtém relatórios de carga após o timestamp especificado
				const reports = await this.database.getLoadReports(parseInt(timestamp));

				res.json({
					status: "ok",
					timestamp: Date.now(),
					reports
				});
			} catch (error) {
				this.logger.error("Erro ao obter relatórios de carga:", error);
				res.status(500).json({
					status: "error",
					message: "Erro interno do servidor"
				});
			}
		});

		// Novo endpoint para obter dados analíticos
		this.app.get("/analytics", this.strictLimiter, (req, res) => {
			try {
				// Obtém parâmetros da requisição
				const period = req.query.period ?? "today";
				let selectedBots = req.query["bots[]"];

				// Converte para array se não for
				if (!Array.isArray(selectedBots)) {
					selectedBots = selectedBots ? [selectedBots] : [];
				}

				// Se não há bots selecionados, usa todos
				if (selectedBots.length === 0) {
					selectedBots = Object.keys(this.analyticsCache.daily);
				}

				// Verifica se o cache está atualizado
				const now = Date.now();
				if (now - this.analyticsCache.lastUpdate > this.analyticsCache.cacheTime) {
					// Se o cache está desatualizado, atualiza-o
					this.updateAnalyticsCache()
						.then(() => {
							// Após atualizar, envia os dados filtrados
							res.json(this.filterAnalyticsData(period, selectedBots));
						})
						.catch((error) => {
							this.logger.error("Erro ao atualizar cache para análise:", error);
							res.status(500).json({
								status: "error",
								message: "Erro ao processar dados analíticos"
							});
						});
				} else {
					// Se o cache está atualizado, envia os dados filtrados diretamente
					res.json(this.filterAnalyticsData(period, selectedBots));
				}
			} catch (error) {
				this.logger.error("Erro no endpoint de análise:", error);
				res.status(500).json({
					status: "error",
					message: "Erro interno do servidor"
				});
			}
		});

		// Endpoint para estatísticas detalhadas dos bots (tabela)
		this.app.get("/api/bot-stats", this.strictLimiter, async (req, res) => {
			try {
				const now = Date.now();
				// Verifica se o cache é válido
				if (
					this.botStatsCache.data.length > 0 &&
					now - this.botStatsCache.lastUpdate < this.botStatsCache.cacheTime
				) {
					return res.json(this.botStatsCache.data);
				}

				await this.updateBotStatsCache();
				res.json(this.botStatsCache.data);
			} catch (error) {
				this.logger.error("Erro ao buscar estatísticas dos bots:", error);
				res.status(500).json({ error: "Erro ao buscar estatísticas" });
			}
		});

		this.app.get("/manage/:token", (req, res) => {
			const { token } = req.params;
			const filePath = path.join(__dirname, "../public/management.html");
			this.logger.info(`[management] => '${token}'`);
			res.sendFile(filePath);
		});

		// Redireciona para o convite do Discord
		this.app.get("/discord", (req, res) => {
			if (process.env.DISCORD_INVITE_LINK) {
				return res.redirect(process.env.DISCORD_INVITE_LINK);
			}
			res.redirect("/");
		});

		// Redireciona para o convite do Telegram
		this.app.get("/telegram", (req, res) => {
			if (process.env.TELEGRAM_INVITE_LINK) {
				return res.redirect(process.env.TELEGRAM_INVITE_LINK);
			}
			res.redirect("/");
		});

		// Serve public commands page
		this.app.get("/cmd", (req, res) => {
			const filePath = path.join(__dirname, "../public/cmd.html");
			res.sendFile(filePath);
		});

		// Serve help chat page
		this.app.get("/ajuda", (req, res) => {
			const filePath = path.join(__dirname, "../public/ajuda.html");
			res.sendFile(filePath);
		});

		// Serve STT page
		const serveSTT = (req, res) => {
			const providers = this.serviceProviderService.getProviders("whisper");
			if (providers.length === 0) {
				return res
					.status(503)
					.send("Serviço de transcrição não disponível (nenhum provider configurado).");
			}
			const filePath = path.join(__dirname, "../public/stt.html");
			res.sendFile(filePath);
		};
		this.app.get("/stt", serveSTT);
		this.app.get("/transcrever", serveSTT);

		// Serve Imagine page
		const serveImagine = (req, res) => {
			const providers = this.serviceProviderService.getProviders("bonsai");
			if (providers.length === 0) {
				return res
					.status(503)
					.send("Serviço de geração de imagens não disponível (nenhum provider configurado).");
			}
			const filePath = path.join(__dirname, "../public/imagine.html");
			res.sendFile(filePath);
		};
		this.app.get("/imagine", serveImagine);

		// Serve TTS page
		const serveTTS = (req, res) => {
			const providers = this.serviceProviderService.getProviders("f5tts");
			if (providers.length === 0) {
				return res.status(503).send("Serviço de TTS não disponível (nenhum provider configurado).");
			}
			const filePath = path.join(__dirname, "../public/tts.html");
			res.sendFile(filePath);
		};
		this.app.get("/tts", serveTTS);
		this.app.get("/falar", serveTTS);

		// Serve Pesca page
		const servePesca = (req, res) => {
			const filePath = path.join(__dirname, "../public/pesca.html");
			res.sendFile(filePath);
		};
		this.app.get("/pesca", servePesca);
		this.app.get("/fishing", servePesca);

		// STT API
		this.app.post(
			"/api/stt/transcrever",
			this.strictLimiter,
			upload.single("audio"),
			async (req, res) => {
				if (!req.file) {
					return res.status(400).json({ error: "Nenhum arquivo enviado." });
				}

				const providers = this.serviceProviderService.getProviders("whisper");
				if (
					providers.length === 0 ||
					(this.lastServicesStatus && this.lastServicesStatus.whisper === "down")
				) {
					return res.status(503).json({ error: "Serviço de transcrição não disponível." });
				}

				const jobId = uuidv4();
				const job = {
					id: jobId,
					status: "starting",
					estimatedTime: 0,
					result: null,
					error: null,
					startTime: Date.now()
				};
				this.sttJobs.set(jobId, job);

				// Process in background
				(async () => {
					let finalPath = req.file.path;
					const filesToCleanup = [req.file.path];

					try {
						// Se for vídeo, converte para áudio MP3 (compactado)
						if (req.file.mimetype.startsWith("video/")) {
							job.status = "processing";
							const audioPath = req.file.path + ".mp3";
							await new Promise((resolve, reject) => {
								ffmpeg(req.file.path)
									.toFormat("mp3")
									.audioBitrate("64k") // Compactado como pedido
									.on("error", reject)
									.on("end", resolve)
									.save(audioPath);
							});
							finalPath = audioPath;
							filesToCleanup.push(audioPath);
						}

						await SpeechCommands.transcribeViaAPI(
							finalPath,
							(duration, estimatedTime) => {
								job.status = "transcribing";
								job.estimatedTime = estimatedTime;
							},
							(status, executionId, url) => {
								job.status = status;
								job.executionId = executionId;
							}
						)
							.then((result) => {
								job.status = "complete";
								job.result = result.text;
							})
							.catch((err) => {
								job.status = "error";
								job.error = err.message;
							});
					} catch (err) {
						this.logger.error("Erro no processamento de STT:", err);
						job.status = "error";
						job.error = "Erro ao processar arquivo: " + err.message;
					} finally {
						// Limpeza de todos os arquivos temporários
						for (const f of filesToCleanup) {
							await fs.unlink(f).catch(() => {});
						}
					}
				})();

				res.json({ jobId });
			}
		);

		// Imagine API (Proxy)
		this.app.post("/api/imagine/generate", this.strictLimiter, async (req, res) => {
			const { prompt } = req.body;

			if (!prompt || prompt.trim().length < 4) {
				return res.status(400).json({ error: "Prompt muito curto ou ausente." });
			}

			if (prompt.length > 1000) {
				return res.status(400).json({ error: "Prompt muito longo (máximo 1000 caracteres)." });
			}

			const providers = this.serviceProviderService.getProviders("bonsai");
			if (
				providers.length === 0 ||
				(this.lastServicesStatus && this.lastServicesStatus.imagine === "down")
			) {
				return res.status(503).json({ error: "Serviço de geração de imagens não disponível." });
			}

			try {
				const bonsaiUrl = providers[0].url;
				const aesthetic = "\n\n(Aesthetic: Gothic, lightly purple-ish tinted atmosphere, cartoony)";

				this.logger.info(`Web request: Gerando imagem com Bonsai, prompt: '${prompt}'`);

				const response = await axios.post(
					`${bonsaiUrl}/generate`,
					{
						prompt: prompt + aesthetic,
						width: 1024,
						height: 1024,
						seed: Math.floor(Math.random() * 9999999),
						num_inference_steps: 20,
						guidance_scale: 7.5
					},
					{
						responseType: "arraybuffer",
						timeout: 60000
					}
				);

				res.set("Content-Type", "image/jpeg");
				res.send(response.data);
			} catch (error) {
				this.logger.error("Erro na API de geração de imagem:", error);
				res.status(500).json({ error: "Erro ao gerar imagem: " + error.message });
			}
		});

		// TTS API (Proxy)
		this.app.post("/api/tts/generate", this.strictLimiter, async (req, res) => {
			const { text, voice } = req.body;

			if (!text || text.trim().length < 1) {
				return res.status(400).json({ error: "Texto ausente." });
			}

			if (text.length > 1000) {
				return res.status(400).json({ error: "Texto muito longo (máximo 1000 caracteres)." });
			}

			const providers = this.serviceProviderService.getProviders("f5tts");
			if (
				providers.length === 0 ||
				(this.lastServicesStatus && this.lastServicesStatus.f5tts === "down")
			) {
				return res.status(503).json({ error: "Serviço de TTS não disponível." });
			}

			try {
				const f5ttsUrl = providers[0].url || "http://localhost:5050";
				const f5ttsApiKey = providers[0].apiKey || "";
				const apiUrl = `${f5ttsUrl}/v1/audio/speech`;

				this.logger.info(
					`Web request: Gerando TTS com voz ${voice}, texto: '${text.substring(0, 30)}...'`
				);

				const audioResponse = await axios({
					method: "post",
					url: apiUrl,
					data: {
						model: "f5-tts",
						input: text,
						voice: voice || "ravena",
						response_format: "mp3"
					},
					headers: {
						"Content-Type": "application/json",
						...(f5ttsApiKey ? { Authorization: `Bearer ${f5ttsApiKey}` } : {})
					},
					responseType: "arraybuffer"
				});

				res.set("Content-Type", "audio/mpeg");
				res.send(audioResponse.data);
			} catch (error) {
				this.logger.error("Erro na API de TTS:", error);
				res.status(500).json({ error: "Erro ao gerar áudio: " + error.message });
			}
		});

		this.app.get("/api/stt/status/:jobId", (req, res) => {
			const job = this.sttJobs.get(req.params.jobId);
			if (!job) {
				return res.status(404).json({ error: "Job não encontrado." });
			}
			res.json(job);
		});

		// Endpoint para status dos serviços
		this.app.get("/api/services/status", (req, res) => {
			res.json(
				this.lastServicesStatus || {
					whisper: "unknown",
					imagine: "unknown",
					f5tts: "unknown",
					llm: "unknown"
				}
			);
		});

		// Fishing API
		this.app.get("/api/fishing/legendary", async (req, res) => {
			try {
				const rows = await this.database.dbAll(
					"fishing",
					"SELECT * FROM fishing_legendary_history ORDER BY weight DESC;"
				);
				res.json(rows);
			} catch (error) {
				this.logger.error("Erro ao buscar histórico de pesca:", error);
				res.status(500).json({ error: "Erro ao buscar histórico de pesca" });
			}
		});

		this.app.get("/api/fishing/image/:fileName", async (req, res) => {
			const { fileName } = req.params;
			if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
				return res.status(400).send("Nome de arquivo inválido");
			}
			const filePath = path.join(this.database.databasePath, "media", fileName);
			try {
				await fs.access(filePath);
				res.sendFile(filePath);
			} catch (error) {
				res.status(404).send("Imagem não encontrada");
			}
		});

		// Chat API for AnythingLLM help
		this.app.post("/api/ajuda/chat", this.strictLimiter, async (req, res) => {
			const { message, sessionId } = req.body;

			if (!message || message.trim().length < 2) {
				return res.status(400).json({ error: "Mensagem muito curta ou ausente." });
			}

			try {
				const { askAnythingLLM } = require("./functions/AnythingLLMHelper");
				const answer = await askAnythingLLM(message, sessionId);
				res.json({ answer });
			} catch (error) {
				this.logger.error("Erro na API de ajuda chat:", error);
				res.status(500).json({ error: error.message });
			}
		});

		// Endpoint para Top Donates
		this.app.get("/top-donates", async (req, res) => {
			try {
				const donations = await this.database.getDonations();

				// Mapeia para remover o campo 'numero' por privacidade
				const publicDonations = donations.map(({ nome, valor }) => ({ nome, valor }));

				res.json(publicDonations);
			} catch (error) {
				// O bloco catch lida com qualquer erro, seja o arquivo não encontrado ou um erro de processamento.
				if (error.code === "ENOENT") {
					// Se o erro for 'ENOENT', o arquivo não foi encontrado.
					res.status(404).json({ error: "Arquivo de doações não encontrado" });
				} else {
					// Para outros erros, como falha ao ler ou processar o JSON.
					this.logger.error("Erro ao ler ou processar o arquivo de doações:", error);
					res.status(500).json({ error: "Erro interno ao buscar doações" });
				}
			}
		});

		// Endpoint para Dossier dos Grupos (HTML)
		this.app.get("/groups-dossier", authenticateBasic, (req, res) => {
			const filePath = path.join(__dirname, "../public/groups-dossier.html");
			res.sendFile(filePath);
		});

		// Endpoint para Dossier dos Grupos (API)
		this.app.get("/api/groups-dossier", authenticateBasic, this.strictLimiter, async (req, res) => {
			try {
				// 1. Busca os status (contadores) de todos os grupos
				const statusList = await this.database.dbAll(
					"summaries",
					"SELECT group_id, total_length_recorded, pending_text FROM group_dossier_status"
				);

				// 2. Busca o histórico de dossiês (ordenados por criação)
				const historyList = await this.database.dbAll(
					"summaries",
					"SELECT group_id, dossier_json, created_at FROM group_dossiers ORDER BY created_at DESC"
				);

				const allGroupsData = await this.database.getGroups();
				const groupNames = {};
				const groupBots = {};
				allGroupsData.forEach((g) => {
					groupNames[g.id] = g.name;
					groupBots[g.id] = g.botId || "-";
				});

				// Agrupa o histórico por group_id
				const historyMap = {};
				historyList.forEach((h) => {
					if (!historyMap[h.group_id]) historyMap[h.group_id] = [];
					let parsedDossier = null;
					try {
						parsedDossier = JSON.parse(h.dossier_json);
					} catch (e) {
						// Ignorar erro
					}
					if (parsedDossier) {
						historyMap[h.group_id].push({
							...parsedDossier,
							created_at: h.created_at
						});
					}
				});

				const result = statusList.map((s) => {
					const history = historyMap[s.group_id] || [];
					const latestDossier = history[0] || {
						type: "-",
						summary: "Nenhuma análise feita ainda.",
						problematic_score: 0
					};

					// Calcular média de problematic_score
					const scores = history.map((h) => h.problematic_score);
					const avgScore =
						scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

					return {
						id: s.group_id,
						name: groupNames[s.group_id] || "Grupo Desconhecido",
						bot_id: groupBots[s.group_id] || "-",
						type: latestDossier.type,
						summary: latestDossier.summary,
						problematic_score: latestDossier.problematic_score,
						avg_score: avgScore,
						total_chars: s.total_length_recorded,
						pending_chars: s.pending_text ? s.pending_text.length : 0,
						hasDossier: history.length > 0,
						history
					};
				});

				// Filtrar apenas grupos que já possuem dossiê
				const filteredResult = result.filter((r) => r.hasDossier);

				// Ordenar por média (avg_score) decrescente
				filteredResult.sort((a, b) => b.avg_score - a.avg_score);

				res.json(filteredResult);
			} catch (error) {
				this.logger.error("Erro ao buscar dossiês dos grupos:", error);
				res.status(500).json({ status: "error", message: "Erro interno ao buscar dossiês" });
			}
		});

		// Endpoint para Top Donates dos últimos 3 meses
		this.app.get("/recent-top-donates", async (req, res) => {
			try {
				const donations = await this.database.getDonations();

				const threeMonthsAgo = new Date();
				threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
				const threeMonthsAgoTs = threeMonthsAgo.getTime();

				let totalRecentAmount = 0;
				const recentDonorsSummary = {};

				donations.forEach((donor) => {
					// 1. Calcula valor do histórico recente
					const recentAmount = (donor.historico ?? [])
						.filter((h) => h.ts > threeMonthsAgoTs)
						.reduce((sum, h) => sum + h.valor, 0);

					// 2. Fallback para dados sem histórico
					if (
						recentAmount === 0 &&
						(!donor.historico || donor.historico.length === 0) &&
						donor.timestamp &&
						donor.timestamp > threeMonthsAgoTs
					) {
						const fallbackAmount = donor.valor;
						if (fallbackAmount > 0) {
							totalRecentAmount += fallbackAmount;
							recentDonorsSummary[donor.nome] = { nome: donor.nome, valor: fallbackAmount };
						}
					} else if (recentAmount > 0) {
						totalRecentAmount += recentAmount;
						recentDonorsSummary[donor.nome] = { nome: donor.nome, valor: recentAmount };
					}
				});

				// Ordena e pega os top 15
				const topRecentDonors = Object.values(recentDonorsSummary)
					.sort((a, b) => b.valor - a.valor)
					.slice(0, 15);

				res.json({
					totalRecentAmount,
					topRecentDonors
				});
			} catch (error) {
				this.logger.error("Erro ao processar doações recentes:", error);
				res.status(500).json({ error: "Erro ao processar doações recentes" });
			}
		});

		// Serve service providers management page
		this.app.get("/service-providers", authenticateBasic, (req, res) => {
			const filePath = path.join(__dirname, "../public/service-providers.html");
			res.sendFile(filePath);
		});

		// API endpoints for Service Providers CRUD
		this.app.get("/api/service-providers", authenticateBasic, this.strictLimiter, (req, res) => {
			res.json(this.serviceProviderService.getConfig());
		});

		this.app.post(
			"/api/service-providers",
			authenticateBasic,
			this.strictLimiter,
			async (req, res) => {
				try {
					const newConfig = req.body;
					await this.serviceProviderService.saveConfig(newConfig);

					// Reload providers in services if needed
					const LLMService = require("./services/LLMService");
					LLMService.getInstance().buildProviders();

					res.json({ status: "ok", message: "Configuration saved successfully" });
				} catch (error) {
					this.logger.error("Error saving service providers via API:", error);
					res.status(500).json({ status: "error", message: error.message });
				}
			}
		);

		// API endpoint for LLM Queue status
		this.app.get("/api/llm/queue", authenticateBasic, this.strictLimiter, (req, res) => {
			const LLMService = require("./services/LLMService");
			res.json({
				status: "ok",
				queues: LLMService.getInstance().getQueueStatus()
			});
		});

		// API endpoint for LLM Stats (last hour by default)
		this.app.get("/api/llm/stats", authenticateBasic, this.strictLimiter, async (req, res) => {
			try {
				const LLMService = require("./services/LLMService");
				const timeframe =
					req.query.timeframe !== undefined ? parseInt(req.query.timeframe) : 60 * 60 * 1000;
				const stats = await LLMService.getInstance().getStats(timeframe);
				res.json(stats);
			} catch (error) {
				this.logger.error("Error fetching LLM stats via API:", error);
				res.status(500).json({ status: "error", message: error.message });
			}
		});

		// Get Public Commands
		this.app.get("/api/public-commands", async (req, res) => {
			try {
				if (this.bots.length === 0) {
					return res.status(503).json({ error: "No bots available" });
				}

				const bot = this.bots[0];

				// 1. Get Fixed Commands
				const fixedCommands = bot.eventHandler.commandHandler.fixedCommands.getAllCommands();

				// Helper to group commands (duplicated logic from Menu.js to be self-contained)
				const groupCommandsByCategory = (commands) => {
					const categories = {};
					Object.keys(CATEGORY_EMOJIS).forEach((category) => {
						categories[category] = [];
					});

					for (const cmd of commands) {
						if (cmd.hidden) continue;
						let category = cmd.category?.toLowerCase() ?? "resto";
						if (category.length < 1) category = "resto";
						if (!categories[category]) categories[category] = [];
						categories[category].push(cmd);
					}
					return categories;
				};

				const groupRelatedCommands = (commands) => {
					const groupedCommands = [];
					const groups = {};
					for (const cmd of commands) {
						if (cmd.group) {
							if (!groups[cmd.group]) groups[cmd.group] = [];
							groups[cmd.group].push(cmd);
						} else {
							groupedCommands.push([cmd]);
						}
					}
					for (const groupName in groups) {
						if (groups[groupName].length > 0) {
							groups[groupName].sort((a, b) => a.name.localeCompare(b.name));
							groupedCommands.push(groups[groupName]);
						}
					}
					return groupedCommands;
				};

				const sortCommands = (commands) =>
					commands.sort((a, b) => {
						const cmdA = Array.isArray(a) ? a[0] : a;
						const cmdB = Array.isArray(b) ? b[0] : b;
						const indexA = COMMAND_ORDER.indexOf(cmdA.name);
						const indexB = COMMAND_ORDER.indexOf(cmdB.name);
						if (indexA !== -1 && indexB !== -1) return indexA - indexB;
						if (indexA !== -1) return -1;
						if (indexB !== -1) return 1;
						return cmdA.name.localeCompare(cmdB.name);
					});

				const categorizedCommands = groupCommandsByCategory(fixedCommands);
				const finalCategories = [];

				for (const category in CATEGORY_EMOJIS) {
					const commands = categorizedCommands[category] || [];
					if (commands.length === 0) continue;

					const grouped = groupRelatedCommands(commands);
					const sorted = sortCommands(grouped);

					const categoryData = {
						name: category.charAt(0).toUpperCase() + category.slice(1),
						emoji: CATEGORY_EMOJIS[category],
						commands: []
					};

					if (categoryData.name.length < 4) categoryData.name = categoryData.name.toUpperCase();

					for (const item of sorted) {
						const cmd = Array.isArray(item) ? item[0] : item;
						// For groups, we might want to list all aliases or just the main ones
						// Simplified: take the first one, add aliases from all if grouped?
						// Menu.js logic: formatCommandGroup joins all names.

						let aliases = [];
						if (Array.isArray(item)) {
							// It is a group
							item.forEach((c) => {
								if (c.name !== cmd.name) aliases.push(c.name);
								if (c.aliases) aliases.push(...c.aliases);
							});
						} else {
							if (cmd.aliases) aliases = cmd.aliases;
						}

						// Remove duplicates
						aliases = [...new Set(aliases)];

						categoryData.commands.push({
							name: cmd.name,
							description: cmd.description,
							aliases,
							reaction: cmd.reactions?.trigger
						});
					}
					finalCategories.push(categoryData);
				}

				// 2. Get Management Commands
				const managementCommands =
					bot.eventHandler.commandHandler.management.getManagementCommands();
				// Sort management commands logic
				const sortedMgmtKeys = Object.keys(managementCommands).sort((a, b) => {
					const indexA = COMMAND_ORDER.indexOf(a);
					const indexB = COMMAND_ORDER.indexOf(b);
					if (indexA !== -1 && indexB !== -1) return indexA - indexB;
					if (indexA !== -1) return -1;
					if (indexB !== -1) return 1;
					return a.localeCompare(b);
				});

				const sortedMgmt = {};
				sortedMgmtKeys.forEach((key) => (sortedMgmt[key] = managementCommands[key]));

				res.json({
					categories: finalCategories,
					management: sortedMgmt
				});
			} catch (error) {
				this.logger.error("Error serving public commands:", error);
				res.status(500).json({ error: "Internal server error" });
			}
		});

		// Validate token endpoint
		this.app.get("/api/validate-token", async (req, res) => {
			const token = req.query.token;

			if (!token) {
				return res.status(400).json({ valid: false, message: "Token not provided" });
			}

			try {
				const webManagementData = await this.readWebManagementToken(token);

				if (!webManagementData) {
					return res.status(401).json({ valid: false, message: "Invalid token" });
				}

				// Check expiration
				const expiresAt = new Date(webManagementData.expiresAt);
				const now = new Date();

				if (now > expiresAt) {
					return res.status(401).json({ valid: false, message: "Token expired" });
				}

				return res.json({
					valid: true,
					requestNumber: webManagementData.requestNumber,
					authorName: webManagementData.authorName,
					groupId: webManagementData.groupId,
					groupName: webManagementData.groupName,
					expiresAt: webManagementData.expiresAt
				});
			} catch (error) {
				this.logger.error("Error validating token:", error);
				return res.status(500).json({ valid: false, message: "Server error" });
			}
		});

		// Endpoint para histórico de dossiês de um grupo específico (para o dashboard)
		this.app.get("/api/group-dossier-history", async (req, res) => {
			const { groupId, token } = req.query;

			if (!groupId || !token) {
				return res.status(400).json({ message: "Missing required parameters" });
			}

			try {
				const webManagementData = await this.readWebManagementToken(token);

				if (!webManagementData || webManagementData.groupId !== groupId) {
					return res.status(401).json({ message: "Unauthorized" });
				}

				if (new Date() > new Date(webManagementData.expiresAt)) {
					return res.status(401).json({ message: "Token expired" });
				}

				const historyList = await this.database.dbAll(
					"summaries",
					"SELECT dossier_json, created_at FROM group_dossiers WHERE group_id = ? ORDER BY created_at DESC LIMIT 15",
					[groupId]
				);

				const parsedHistory = historyList.map((h) => {
					let dossier = {};
					try {
						dossier = JSON.parse(h.dossier_json);
					} catch (e) {
						// Ignora
					}
					return {
						...dossier,
						created_at: h.created_at
					};
				});

				res.json(parsedHistory);
			} catch (error) {
				this.logger.error("Error fetching group dossier history:", error);
				res.status(500).json({ message: "Internal server error" });
			}
		});

		// Get group data endpoint
		this.app.get("/api/group", async (req, res) => {
			const { id, token } = req.query;

			if (!id || !token) {
				return res.status(400).json({ message: "Missing required parameters" });
			}

			try {
				const webManagementData = await this.readWebManagementToken(token);

				if (!webManagementData || webManagementData.groupId !== id) {
					return res.status(401).json({ message: "Unauthorized" });
				}

				if (new Date() > new Date(webManagementData.expiresAt)) {
					return res.status(401).json({ message: "Token expired" });
				}

				// Get database instance
				const groupData = await this.database.getGroup(id);

				if (!groupData) {
					return res.status(404).json({ message: "Group not found" });
				}

				// Fetch participants if possible
				let participants = [];
				try {
					// Find the specific bot that issued the command
					let bot = this.bots.find((b) => b.id === webManagementData.botId && b.isConnected);

					// Fallback to any connected bot if specific bot not found/connected
					if (!bot) {
						bot = this.bots.find((b) => b.isConnected);
					}

					if (bot) {
						const chat = await bot.client.getChatById(id);
						if (chat && chat.participants) {
							participants = chat.participants.map((p) => {
								const pn =
									p.phoneNumber || (p.id?._serialized ? p.id._serialized.split("@")[0] : "0000");
								const lid = p.lid || (p.id?._serialized ? p.id._serialized : "");
								const name = `Membro ${pn.slice(-4)}`;

								return {
									lid,
									pn,
									name,
									admin: p.isAdmin || p.isSuperAdmin
								};
							});
						}
					}
				} catch (e) {
					this.logger.error("Error fetching participants:", e);
				}
				groupData.participants = participants;

				this.logger.info(`[management][${token}][${id}] Group ${groupData.name}`);
				return res.json(groupData);
			} catch (error) {
				this.logger.error("Error getting group data:", error);
				return res.status(500).json({ message: "Server error" });
			}
		});

		// Update the group data endpoint to use the correct methods
		this.app.post("/api/update-group", this.strictLimiter, async (req, res) => {
			const { token, groupId, changes } = req.body;

			if (!token || !groupId || !changes) {
				return res.status(400).json({ success: false, message: "Missing required parameters" });
			}

			try {
				const webManagementData = await this.readWebManagementToken(token);

				if (!webManagementData || webManagementData.groupId !== groupId) {
					return res.status(401).json({ success: false, message: "Unauthorized" });
				}

				if (new Date() > new Date(webManagementData.expiresAt)) {
					return res.status(401).json({ success: false, message: "Token expired" });
				}

				// Get database instance - assuming it's exported from a central location
				const groupData = await this.database.getGroup(groupId);

				if (!groupData) {
					return res.status(404).json({ success: false, message: "Group not found" });
				}

				// Validate group name: alphanumeric + _ - ., no whitespace, 1-30 chars
				if (changes.name) {
					changes.name = changes.name.trim().toLowerCase();
					if (!/^[a-zA-Z0-9_\-.]{1,30}$/.test(changes.name)) {
						return res.status(400).json({
							success: false,
							message: `O nome do grupo deve conter apenas letras, números, _, - e ., sem espaços, com no máximo 30 caracteres.`
						});
					}
				}

				// Validate prefix: max 1 char
				if (changes.prefix && changes.prefix.length > 1) {
					return res.status(400).json({
						success: false,
						message: "O prefixo deve ter no máximo 1 caractere."
					});
				}

				// Check limits before applying changes
				await checkGroupLimits(groupId, "streams", { groupData: changes });

				// Validate autoTranslateTo
				if (changes.autoTranslateTo) {
					const SUPPORTED_LANGUAGES = [
						"English (EN)",
						"Spanish (ES)",
						"Russian (RU)",
						"French (FR)",
						"German (DE)",
						"Italian (IT)",
						"Japanese (JA)",
						"Chinese (ZH)",
						"Korean (KO)",
						"Arabic (AR)",
						"Hindi (HI)",
						"Turkish (TR)",
						"Dutch (NL)",
						"Polish (PL)",
						"Indonesian (ID)",
						"Vietnamese (VI)",
						"Thai (TH)"
					];
					if (!SUPPORTED_LANGUAGES.includes(changes.autoTranslateTo)) {
						return res
							.status(400)
							.json({ success: false, message: "Idioma para tradução não suportado." });
					}
				}

				this.logger.info(
					`[management][${token}][${groupId}] UPDATED Group data:\n${JSON.stringify(changes, null, 2)}`
				);

				// Apply changes
				Object.entries(changes).forEach(([key, value]) => {
					groupData[key] = value;
				});

				// Add update timestamp
				groupData.lastUpdated = new Date().toISOString();

				// Save the updated group
				await this.database.saveGroup(groupData);

				this.eventHandler.loadGroups(); // Recarrega os grupos em memória

				return res.json({ success: true });
			} catch (error) {
				this.logger.error("Error updating group:", error);
				return res.status(500).json({ success: false, message: "Server error" });
			}
		});

		// Upload media endpoint
		this.app.post(
			"/api/upload-media",
			this.strictLimiter,
			upload.single("file"),
			async (req, res) => {
				const { token, groupId, type, name, caption } = req.body;
				const file = req.file;

				if (!token || !groupId || !type || !name || !file) {
					return res.status(400).json({ success: false, message: "Missing required parameters" });
				}

				try {
					const webManagementData = await this.readWebManagementToken(token);

					if (!webManagementData || webManagementData.groupId !== groupId) {
						return res.status(401).json({ success: false, message: "Unauthorized" });
					}

					if (new Date() > new Date(webManagementData.expiresAt)) {
						return res.status(401).json({ success: false, message: "Token expired" });
					}

					// Get database instance
					const groupData = await this.database.getGroup(groupId);

					if (!groupData) {
						return res.status(404).json({ success: false, message: "Group not found" });
					}

					// Check storage limit
					await checkGroupLimits(groupId, "storage", { fileSize: file.size });

					// Save file
					const fileName = `${Date.now()}-${file.originalname}`;
					const mediaPath = path.join(this.database.databasePath, "media");

					await fs.mkdir(mediaPath, { recursive: true }).catch(() => {});

					const filePath = path.join(mediaPath, fileName);
					await fs.copyFile(file.path, filePath);

					// Update group data
					if (!groupData[type]) {
						groupData[type] = {};
					}

					groupData[type][name] = {
						file: fileName,
						caption: caption ? caption.trim() : undefined,
						uploadedAt: new Date().toISOString(),
						uploadedBy: webManagementData.requestNumber
					};

					// Add update timestamp
					groupData.lastUpdated = new Date().toISOString();

					// Save the updated group
					await this.database.saveGroup(groupData);

					this.logger.info(
						`[management][${token}][${groupId}] Media '${type}' uplodaded: ${fileName}`
					);

					return res.json({ success: true, fileName });
				} catch (error) {
					this.logger.error("Error uploading media:", error);
					return res.status(500).json({ success: false, message: "Server error" });
				} finally {
					// Remove temp file
					if (req.file) {
						fs.unlink(req.file.path).catch((error) => {
							this.logger.error("Error removing temp file:", error);
						});
					}
				}
			}
		);

		// Custom Commands CRUD

		// Helper to reload commands for a group
		const reloadGroupCommands = async (groupId) => {
			// Find which bot manages this group
			// Since we don't have a direct map, we can try all bots or check their chats
			// Optimization: In a real scenario we might map groupId -> botId

			for (const bot of this.bots) {
				if (bot.eventHandler && bot.eventHandler.commandHandler) {
					// We can just trigger the reload, it's cheap if checks internal cache
					await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(groupId).catch(() => {});
				}
			}
		};

		// Helper to check group limits
		const checkGroupLimits = async (groupId, checkType, data = null) => {
			const MAX_STORAGE = (parseInt(process.env.LIMIT_STORAGE_MB) || 1024) * 1024 * 1024; // MB to Bytes. Default 1GB
			const MAX_COMMANDS = parseInt(process.env.LIMIT_COMMANDS) || 100;
			const MAX_STREAMS = parseInt(process.env.LIMIT_STREAMS) || 20;

			if (checkType === "storage") {
				let totalSize = 0;
				const groupData = await this.database.getGroup(groupId);
				const commands = await this.database.getCustomCommands(groupId);
				const mediaPath = path.join(this.database.databasePath, "media");

				// Helper to add file size
				const addFileSize = async (filename) => {
					if (!filename) return;
					try {
						const stats = await fs.stat(path.join(mediaPath, filename));
						totalSize += stats.size;
					} catch (e) {
						/* ignore missing files */
					}
				};

				// Scan Group Data (Greetings, Farewells, Streams)
				const scanMediaObj = async (obj) => {
					if (!obj) return;
					for (const val of Object.values(obj)) {
						if (val && val.file) await addFileSize(val.file);
					}
				};

				// Greetings/Farewells
				if (groupData) {
					await scanMediaObj(groupData.greetings);
					await scanMediaObj(groupData.farewells);

					// Streams
					["twitch", "kick", "youtube"].forEach((platform) => {
						if (groupData[platform]) {
							groupData[platform].forEach((stream) => {
								if (stream.onConfig?.media)
									stream.onConfig.media.forEach((m) => {
										if (m.type !== "text") addFileSize(m.content);
									});
								if (stream.offConfig?.media)
									stream.offConfig.media.forEach((m) => {
										if (m.type !== "text") addFileSize(m.content);
									});
							});
						}
					});
				}

				// Commands
				if (commands) {
					for (const cmd of commands) {
						if (cmd.responses) {
							for (const resp of cmd.responses) {
								if (resp.startsWith("{") && resp.includes("-")) {
									const end = resp.indexOf("}");
									if (end > 1) {
										// Format: {type-filename}
										const firstDash = resp.indexOf("-");
										const filename = resp.substring(firstDash + 1, end);
										await addFileSize(filename);
									}
								}
							}
						}
					}
				}

				// Add new file size if provided
				if (data && data.fileSize) {
					totalSize += data.fileSize;
				}

				if (totalSize > MAX_STORAGE) {
					throw new Error(
						`Limite de armazenamento excedido (1GB). Uso atual: ${(totalSize / 1024 / 1024).toFixed(2)} MB`
					);
				}
			}

			if (checkType === "commands") {
				const commands = await this.database.getCustomCommands(groupId);
				if (commands && commands.length >= MAX_COMMANDS) {
					// If creating new command (not updating existing)
					if (data && data.isNew) {
						throw new Error(`Limite de comandos excedido (${MAX_COMMANDS}).`);
					}
				}
			}

			if (checkType === "streams") {
				// Check streams count in the NEW data (which replaces old)
				if (data && data.groupData) {
					const g = data.groupData;
					let totalStreams = 0;
					totalStreams += (g.twitch || []).length;
					totalStreams += (g.kick || []).length;
					totalStreams += (g.youtube || []).length;

					if (totalStreams > MAX_STREAMS) {
						throw new Error(`Limite de streams excedido (${MAX_STREAMS}).`);
					}
				}
			}
		};

		// GET Custom Commands
		this.app.get("/api/custom-commands/:groupId", async (req, res) => {
			const { groupId } = req.params;
			const { token } = req.query;

			try {
				const webManagementData = await this.readWebManagementToken(token);
				if (!webManagementData || webManagementData.groupId !== groupId)
					return res.status(401).json({ message: "Unauthorized" });
				if (new Date() > new Date(webManagementData.expiresAt))
					return res.status(401).json({ message: "Token expired" });

				const commands = await this.database.getCustomCommands(groupId);
				res.json(commands || []);
			} catch (e) {
				this.logger.error("Error fetching commands:", e);
				res.status(500).json({ message: "Server error" });
			}
		});

		// POST New Custom Command
		this.app.post("/api/custom-commands/:groupId", async (req, res) => {
			const { groupId } = req.params;
			const { token, command } = req.body;

			try {
				const webManagementData = await this.readWebManagementToken(token);
				if (!webManagementData || webManagementData.groupId !== groupId)
					return res.status(401).json({ message: "Unauthorized" });

				const groupData = await this.database.getGroup(groupId);
				const prefix = (groupData && groupData.prefix ? groupData.prefix : "!").trim();

				if (command && typeof command.startsWith === "string") {
					let triggerClean = command.startsWith.trim().toLowerCase();
					if (triggerClean.startsWith(prefix)) {
						triggerClean = triggerClean.substring(prefix.length).trim();
					} else if (prefix !== "!" && triggerClean.startsWith("!")) {
						triggerClean = triggerClean.substring(1).trim();
					}
					command.startsWith = triggerClean;
				}

				if (!command.startsWith) {
					return res.status(400).json({ message: "Gatilho de comando inválido" });
				}

				await checkGroupLimits(groupId, "commands", { isNew: true });

				await this.database.saveCustomCommand(groupId, command);

				this.database.clearCache(`commands:${groupId}`);
				await reloadGroupCommands(groupId);

				res.json({ success: true });
			} catch (e) {
				this.logger.error("Error creating command:", e);
				res.status(500).json({ message: e.message });
			}
		});
		// PUT Update Custom Command
		this.app.put("/api/custom-commands/:groupId/:trigger", async (req, res) => {
			const { groupId, trigger } = req.params;
			const { token, command } = req.body;

			try {
				const webManagementData = await this.readWebManagementToken(token);
				if (!webManagementData || webManagementData.groupId !== groupId)
					return res.status(401).json({ message: "Unauthorized" });

				const groupData = await this.database.getGroup(groupId);
				const prefix = (groupData && groupData.prefix ? groupData.prefix : "!").trim();

				if (command && typeof command.startsWith === "string") {
					let triggerClean = command.startsWith.trim().toLowerCase();
					if (triggerClean.startsWith(prefix)) {
						triggerClean = triggerClean.substring(prefix.length).trim();
					} else if (prefix !== "!" && triggerClean.startsWith("!")) {
						triggerClean = triggerClean.substring(1).trim();
					}
					command.startsWith = triggerClean;
				}

				if (!command.startsWith) {
					return res.status(400).json({ message: "Gatilho de comando inválido" });
				}

				const oldTrigger = decodeURIComponent(trigger);
				const newTrigger = command.startsWith;

				if (oldTrigger !== newTrigger) {
					// Rename logic: Delete old, Create new
					// Find old one first to be safe?
					// Database.js probably array based.
					const cmds = await this.database.getCustomCommands(groupId);
					const oldCmd = cmds.find((c) => c.startsWith === oldTrigger);
					if (oldCmd) {
						oldCmd.deleted = true; // Soft delete
						await this.database.updateCustomCommand(groupId, oldCmd);
					}
					// Save new as new
					await this.database.saveCustomCommand(groupId, command);
				} else {
					// Just update
					await this.database.updateCustomCommand(groupId, command);
				}

				this.database.clearCache(`commands:${groupId}`);
				await reloadGroupCommands(groupId);

				res.json({ success: true });
			} catch (e) {
				this.logger.error("Error updating command:", e);
				res.status(500).json({ message: "Server error" });
			}
		});

		// DELETE Custom Command
		this.app.delete("/api/custom-commands/:groupId/:trigger", async (req, res) => {
			const { groupId, trigger } = req.params;
			const { token } = req.query;

			try {
				const webManagementData = await this.readWebManagementToken(token);
				if (!webManagementData || webManagementData.groupId !== groupId)
					return res.status(401).json({ message: "Unauthorized" });

				const targetTrigger = decodeURIComponent(trigger);

				// Get commands to find it
				const cmds = await this.database.getCustomCommands(groupId);
				const cmd = cmds.find((c) => c.startsWith === targetTrigger && !c.deleted);

				if (cmd) {
					cmd.deleted = true;
					cmd.active = false;
					await this.database.updateCustomCommand(groupId, cmd);
				}

				this.database.clearCache(`commands:${groupId}`);
				await reloadGroupCommands(groupId);

				res.json({ success: true });
			} catch (e) {
				this.logger.error("Error deleting command:", e);
				res.status(500).json({ message: "Server error" });
			}
		});

		// Serve media files
		this.app.get("/qrimg/:botId", authenticateBasic, async (req, res) => {
			const { botId } = req.params;
			const filePath = path.join(this.database.databasePath, "qrcodes", `qrcode_${botId}.png`);

			await fs
				.access(filePath)
				.catch(() => res.status(404).send(`QRCode para '${botId}' não disponível.`));

			res.setHeader("Content-Type", "image/png");
			res.sendFile(filePath);
		});

		this.app.get("/qrcode-status/:botId", authenticateBasic, async (req, res) => {
			res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
			res.setHeader("Pragma", "no-cache");
			res.setHeader("Expires", "0");
			const { botId } = req.params;
			const bot = this.bots.find((b) => b.id === botId);
			if (!bot) {
				return res
					.status(404)
					.json({ status: "error", message: `Bot com ID '${botId}' não encontrado` });
			}
			try {
				// Checa apenas o status atual sem forçar reconexão
				const instanceStatus = await bot._checkInstanceStatusAndConnect(true, false);
				// Verifica se instância existe na whatsgoapi
				let instanceExists = false;
				try {
					const goInstance = await bot.getGoInstance(bot.instanceName);
					instanceExists = !!goInstance;
				} catch (e) {
					instanceExists = false;
				}
				res.json({ ...instanceStatus, instanceExists });
			} catch (e) {
				this.logger.error("Error checking qrcode status:", e);
				res.status(500).json({ status: "error", message: e.message });
			}
		});

		// Inicia o fluxo de conexão (chamado pela página /qrcode/:botId)
		this.app.get("/qrcode-initconnect/:botId", authenticateBasic, async (req, res) => {
			res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
			const { botId } = req.params;
			const bot = this.bots.find((b) => b.id === botId);
			if (!bot) {
				return res.status(404).json({ status: "error", message: `Bot '${botId}' não encontrado` });
			}
			try {
				// Cancela timer de apagar instância (usuário quer conectar)
				if (bot._disconnectTimer) {
					clearTimeout(bot._disconnectTimer);
					bot._disconnectTimer = null;
				}
				// Força o fluxo de conexão (connect + pair)
				const instanceStatus = await bot._checkInstanceStatusAndConnect(true, true);
				let instanceExists = false;
				try {
					const goInstance = await bot.getGoInstance(bot.instanceName);
					instanceExists = !!goInstance;
				} catch (e) {
					instanceExists = false;
				}
				res.json({ ...instanceStatus, instanceExists });
			} catch (e) {
				this.logger.error("Error initiating connect for bot:", e);
				res.status(500).json({ status: "error", message: e.message });
			}
		});

		// SSE stream de QR code / pairing code para a página /qrcode/:botId
		this.app.get("/qrcode-stream/:botId", authenticateBasic, (req, res) => {
			const { botId } = req.params;
			const bot = this.bots.find((b) => b.id === botId);
			if (!bot) {
				return res.status(404).json({ status: "error", message: `Bot '${botId}' não encontrado` });
			}

			res.setHeader("Content-Type", "text/event-stream");
			res.setHeader("Cache-Control", "no-cache");
			res.setHeader("Connection", "keep-alive");
			res.setHeader("X-Accel-Buffering", "no");
			res.flushHeaders();

			// Cancela timer de apagar instância enquanto alguém está olhando a página
			if (bot._disconnectTimer) {
				clearTimeout(bot._disconnectTimer);
				bot._disconnectTimer = null;
				this.logger.info(
					`[QR SSE] Timer de apagar instância cancelado para ${botId} (usuário abrindo página)`
				);
			}

			// Envia dados atuais se já disponíveis
			if (bot.connectDataCache?.data) {
				const d = bot.connectDataCache.data;
				res.write(
					`data: ${JSON.stringify({ type: "qr_update", qrCode: d.qrCode || "", code: d.code || "", pairingCode: d.pairingCode || "" })}\n\n`
				);
			}

			// Heartbeat a cada 20s
			const heartbeat = setInterval(() => {
				try {
					res.write(`: heartbeat\n\n`);
				} catch (e) {
					/* ignore */
				}
			}, 20000);

			bot.addQRSseClient(res);

			req.on("close", () => {
				clearInterval(heartbeat);
				bot.removeQRSseClient(res);
				this.logger.info(`[QR SSE] Cliente desconectou de ${botId}`);

				// Se ainda desconectado e sem clientes SSE, reagendar timer de apagar instância
				if (!bot.isConnected && bot.qrSseClients.length === 0 && bot.disconnectedAt) {
					const elapsed = Date.now() - bot.disconnectedAt;
					const remaining = 15 * 60 * 1000 - elapsed;
					if (remaining > 0) {
						bot._disconnectTimer = setTimeout(async () => {
							try {
								this.logger.info(
									`[${botId}] Timer reagendado: apagando instância após 15 min desconectado.`
								);
								await bot.deleteInstance();
								bot.connectDataCache = null;
								bot._disconnectTimer = null;
								bot.broadcastQRUpdate({ type: "instance_deleted", botId: bot.id });
							} catch (err) {
								this.logger.error(`[${botId}] Erro ao apagar instância (reagendado):`, err);
							}
						}, remaining);
						this.logger.info(
							`[QR SSE] Timer reagendado para ${botId}: ${Math.round(remaining / 1000)}s restantes`
						);
					} else {
						// Já passou dos 15 minutos, apagar imediatamente
						bot
							.deleteInstance()
							.catch((err) =>
								this.logger.error(`[${botId}] Erro ao apagar instância (imediato):`, err)
							);
					}
				}
			});
		});

		this.app.get("/qrcode/:botId", authenticateBasic, async (req, res) => {
			res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
			res.setHeader("Pragma", "no-cache");
			res.setHeader("Expires", "0");
			const { botId } = req.params;

			const bot = this.bots.find((b) => b.id === botId);
			if (!bot) {
				return res.status(404).json({
					status: "error",
					message: `Bot com ID '${botId}' não encontrado`
				});
			}

			const formattedDate = new Date().toLocaleString("pt-BR", {
				timeZone: "America/Sao_Paulo",
				hour12: false,
				year: "numeric",
				month: "long",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit"
			});

			// Obter credenciais basic auth para passar aos endpoints cliente JS
			let user = this.apiUser;
			let pass = this.apiPassword;
			if (bot.managementUser && bot.managementPW) {
				user = bot.managementUser;
				pass = bot.managementPW;
			}
			const authRaw = Buffer.from(`${user}:${pass}`).toString("base64");

			// Verifica se já está conectado
			const isConnected = bot.isConnected;

			// Verifica se instância existe na whatsgoapi
			let instanceExists = false;
			try {
				const instanceInfo = await bot.getGoInstance(bot.instanceName);
				instanceExists = !!instanceInfo;
			} catch (e) {
				instanceExists = false;
			}

			const htmlResponse = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${botId} — Conexão WhatsApp</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f1117; --surface: #1a1d27; --surface2: #22263a; --border: #2d3149;
      --text: #e8eaf6; --text-muted: #8892b0; --green: #25d366; --green-dark: #1a9e4b;
      --yellow: #f6c90e; --red: #ff4d4d; --blue: #4f8ef7; --orange: #f59e42;
    }
    body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding: 2rem 1rem; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 1.25rem; padding: 2rem; max-width: 520px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    .bot-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
    .bot-icon { width: 48px; height: 48px; background: var(--green); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; flex-shrink: 0; }
    .bot-title h1 { font-size: 1.2rem; font-weight: 700; }
    .bot-title p { font-size: 0.82rem; color: var(--text-muted); margin-top: 0.2rem; }
    .status-badge { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; margin-bottom: 1.25rem; }
    .status-badge.connected { background: rgba(37,211,102,0.15); color: var(--green); border: 1px solid rgba(37,211,102,0.3); }
    .status-badge.disconnected { background: rgba(255,77,77,0.15); color: var(--red); border: 1px solid rgba(255,77,77,0.3); }
    .status-badge.no-instance { background: rgba(245,158,66,0.15); color: var(--orange); border: 1px solid rgba(245,158,66,0.3); }
    .status-badge.connecting { background: rgba(79,142,247,0.15); color: var(--blue); border: 1px solid rgba(79,142,247,0.3); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; display: inline-block; }
    .dot.pulse { animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .info-row { background: var(--surface2); border: 1px solid var(--border); border-radius: 0.75rem; padding: 0.85rem 1rem; margin-bottom: 1rem; font-size: 0.9rem; color: var(--text-muted); display: flex; align-items: flex-start; gap: 0.6rem; }
    .info-row strong { color: var(--text); }
    .qr-section { text-align: center; margin: 1.5rem 0; }
    .qr-section h2 { font-size: 1rem; font-weight: 600; color: var(--text-muted); margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.05em; }
    #qr-img { max-width: 250px; height: auto; border-radius: 0.75rem; border: 3px solid var(--border); background: white; padding: 8px; transition: opacity 0.3s; }
    #qr-img.refreshing { opacity: 0.4; }
    .pairing-section h2 { font-size: 1rem; font-weight: 600; color: var(--text-muted); text-align: center; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    #pairing-code { font-family: 'Courier New', monospace; font-size: 2.2rem; font-weight: 700; letter-spacing: 0.1em; color: var(--green); text-align: center; padding: 1rem; background: rgba(37,211,102,0.08); border: 1px solid rgba(37,211,102,0.2); border-radius: 0.75rem; min-height: 4rem; display: flex; align-items: center; justify-content: center; }
    #status-msg { text-align: center; font-size: 0.9rem; color: var(--text-muted); margin: 1rem 0; min-height: 1.5rem; }
    .btn-row { display: flex; gap: 0.75rem; flex-wrap: wrap; justify-content: center; margin-top: 1.5rem; }
    button { padding: 0.6rem 1.2rem; border: none; border-radius: 0.5rem; font-size: 0.88rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-primary { background: var(--green); color: #000; }
    .btn-primary:hover { background: var(--green-dark); color: #fff; }
    .btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--border); }
    .btn-danger { background: rgba(255,77,77,0.15); color: var(--red); border: 1px solid rgba(255,77,77,0.3); }
    .btn-danger:hover { background: var(--red); color: #fff; }
    .btn-warn { background: rgba(245,158,66,0.15); color: var(--orange); border: 1px solid rgba(245,158,66,0.3); }
    .btn-warn:hover { background: var(--orange); color: #000; }
    .divider { border: none; border-top: 1px solid var(--border); margin: 1.5rem 0; }
    .raw-section summary { cursor: pointer; font-size: 0.82rem; color: var(--text-muted); padding: 0.4rem 0; }
    pre#status-box { background: var(--surface2); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; font-size: 0.75rem; color: var(--text-muted); white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; margin-top: 0.5rem; text-align: left; }
    .spinner { width: 40px; height: 40px; border: 4px solid var(--border); border-top: 4px solid var(--blue); border-radius: 50%; animation: spin 0.9s linear infinite; margin: 1.5rem auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .passkey-box { border: 2px solid var(--orange); background: rgba(245,158,66,0.07); border-radius: 0.75rem; padding: 1.25rem; margin: 1rem 0; text-align: left; }
    .passkey-box h3 { color: var(--orange); font-size: 1rem; margin-bottom: 0.75rem; text-align: center; }
    .passkey-step { background: #1e2235; border-radius: 0.5rem; padding: 0.75rem 1rem; margin-bottom: 0.65rem; }
    .passkey-step .step-label { color: var(--yellow); font-size: 0.78rem; font-weight: 700; margin-bottom: 0.3rem; }
    .passkey-step .step-body { color: #c9d1e9; font-size: 0.85rem; }
    pre.snippet { background: #11131e; color: #68d391; padding: 0.75rem; border-radius: 0.375rem; font-size: 0.75rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
    textarea.passkey-input { width: 100%; height: 90px; background: #11131e; color: #e2e8f0; border: 1px solid #4a5568; border-radius: 0.375rem; padding: 0.5rem; font-family: monospace; font-size: 0.78rem; resize: vertical; }
    #passkey-msg { margin-top: 0.5rem; font-size: 0.88rem; font-weight: 600; text-align: center; }
    .qr-count { font-size: 0.75rem; color: var(--text-muted); text-align: center; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="bot-header">
      <div class="bot-icon">🤖</div>
      <div class="bot-title">
        <h1>${botId}</h1>
        <p>${bot.phoneNumber || "Número não configurado"} &bull; ${formattedDate}</p>
      </div>
    </div>

    <div id="status-badge-container">
      ${
				isConnected
					? `<div class="status-badge connected"><span class="dot"></span> Conectado ao WhatsApp</div>`
					: !instanceExists
						? `<div class="status-badge no-instance"><span class="dot pulse"></span> Instância não existe na WhatsGoAPI</div>`
						: `<div class="status-badge disconnected"><span class="dot pulse"></span> Desconectado — aguardando conexão</div>`
			}
    </div>

    <div id="main-content">
      ${
				isConnected
					? `
      <div class="info-row"><strong>✅ Bot conectado</strong> ao WhatsApp. Nenhuma ação necessária.</div>
      <div class="btn-row">
        <button class="btn-secondary" onclick="window.location.reload()">🔄 Atualizar</button>
        <button class="btn-danger" onclick="doAction('/logout/${botId}', 'logout')">🚪 Logout</button>
        <button class="btn-warn" onclick="doAction('/recreate/${botId}', 'recriar')">♻️ Recriar</button>
      </div>
      `
					: !instanceExists
						? `
      <div class="info-row">⏳ <div><strong>Instância não encontrada na WhatsGoAPI</strong><br>A instância do bot ainda não foi criada. Clique em "Criar Instância" para gerar a sessão e os códigos de conexão.</div></div>
      <div id="connect-area">
        <div id="status-msg">Pronto para criar a instância</div>
        <div class="qr-section" id="qr-section" style="display:none">
          <h2>📷 QR Code</h2>
          <img id="qr-img" src="" alt="QR Code" />
          <div class="qr-count" id="qr-count"></div>
        </div>
        <div class="pairing-section" id="pairing-section" style="display:none">
          <h2>🔑 Código de Pareamento</h2>
          <div id="pairing-code">—</div>
        </div>
        <div id="passkey-container"></div>
      </div>
      <div class="btn-row">
        <button class="btn-primary" id="btn-start" onclick="startConnect()">➕ Criar Instância</button>
        <button class="btn-secondary" onclick="window.location.reload()">🔄 Atualizar</button>
        <button class="btn-warn" onclick="doAction('/recreate/${botId}', 'recriar')">♻️ Recriar</button>
      </div>
      `
						: `
      <div class="info-row">📱 <div>Escaneie o <strong>QR Code</strong> abaixo com o WhatsApp do celular, ou use o <strong>Código de Pareamento</strong> nas configurações do WhatsApp → Dispositivos Conectados.</div></div>
      <div id="connect-area">
        <div id="status-msg"><div class="spinner"></div>Iniciando conexão com o WhatsApp...</div>
        <div class="qr-section" id="qr-section" style="display:none">
          <h2>📷 QR Code</h2>
          <img id="qr-img" src="" alt="QR Code" />
          <div class="qr-count" id="qr-count"></div>
        </div>
        <div class="pairing-section" id="pairing-section" style="display:none">
          <h2>🔑 Código de Pareamento</h2>
          <div id="pairing-code">—</div>
        </div>
        <div id="passkey-container"></div>
      </div>
      <div class="btn-row">
        <button class="btn-secondary" onclick="window.location.reload()">🔄 Atualizar</button>
        <button class="btn-danger" onclick="doAction('/logout/${botId}', 'logout')">🚪 Logout</button>
        <button class="btn-warn" onclick="doAction('/recreate/${botId}', 'recriar')">♻️ Recriar</button>
      </div>
      `
			}
    </div>

    <hr class="divider">
    <details class="raw-section" open>
      <summary>🔧 Status técnico (raw)</summary>
      <pre id="status-box">Carregando...</pre>
    </details>
  </div>

  <script>
    const botId = ${JSON.stringify(botId)};
    const authRaw = ${JSON.stringify(authRaw)};
    const authQuery = '?auth=' + encodeURIComponent(authRaw);
    const isConnected = ${isConnected};
    const instanceExists = ${instanceExists};
    const statusMsg = document.getElementById('status-msg');
    const qrSection = document.getElementById('qr-section');
    const qrImg = document.getElementById('qr-img');
    const qrCount = document.getElementById('qr-count');
    const pairingSection = document.getElementById('pairing-section');
    const pairingCode = document.getElementById('pairing-code');
    const statusBox = document.getElementById('status-box');
    const passkeyCont = document.getElementById('passkey-container');
    const badgeCont = document.getElementById('status-badge-container');
    let eventSource = null;
    let passkeyPrompted = false;

    function setStatus(msg, color) {
      if (!statusMsg) return;
      statusMsg.innerHTML = msg;
      if (color) statusMsg.style.color = color;
    }
    function setBadge(type, label) {
      if (!badgeCont) return;
      const cls = {connected:'connected',disconnected:'disconnected',noinstance:'no-instance',connecting:'connecting'}[type]||'disconnected';
      const pulse = type !== 'connected' ? ' pulse' : '';
      badgeCont.innerHTML = '<div class="status-badge '+cls+'"><span class="dot'+pulse+'"></span> '+label+'</div>';
    }
    function updateButtonsForExistingInstance() {
      const btnStart = document.getElementById('btn-start');
      if (btnStart) {
        const btnRow = btnStart.parentElement;
        if (btnRow) {
          btnRow.innerHTML = '<button class="btn-secondary" onclick="window.location.reload()">🔄 Atualizar</button>' +
            '<button class="btn-danger" onclick="doAction(&quot;/logout/' + botId + '&quot;, &quot;logout&quot;)">🚪 Logout</button>' +
            '<button class="btn-warn" onclick="doAction(&quot;/recreate/' + botId + '&quot;, &quot;recriar&quot;)">♻️ Recriar</button>';
        }
      }
    }
    function applyConnectData(data) {
      if (data && (data.qrCode || data.pairingCode || data.code)) {
        updateButtonsForExistingInstance();
      }
      if (data.qrCode) {
        if (qrSection) qrSection.style.display = '';
        if (qrImg) { qrImg.classList.add('refreshing'); setTimeout(() => { qrImg.src = data.qrCode; qrImg.classList.remove('refreshing'); }, 100); }
        if (qrCount && data.count != null) qrCount.textContent = 'QR #'+data.count+(data.maxCount?' de '+data.maxCount:'')+' — expira em ~30s';
      }
      if (data.pairingCode) {
        if (pairingSection) pairingSection.style.display = '';
        if (pairingCode) pairingCode.textContent = data.pairingCode;
      }
      if (!data.qrCode && !data.pairingCode && !data.code) {
        setStatus('⏳ Gerando códigos de conexão... aguarde alguns segundos.', '#8892b0');
      } else {
        setStatus('Escaneie o QR Code ou use o código de pareamento acima.', '#8892b0');
      }
    }
    function startSSE() {
      if (eventSource) { eventSource.close(); }
      eventSource = new EventSource('/qrcode-stream/' + botId + authQuery);
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (statusBox) statusBox.textContent = JSON.stringify(data, null, 2);
          if (data.type === 'qr_update') { setBadge('connecting', 'Conectando — aguardando escaneamento'); applyConnectData(data); }
          else if (data.type === 'connected') { setBadge('connected', 'Conectado!'); setStatus('✅ Conectado com sucesso ao WhatsApp! Recarregando...', '#25d366'); setTimeout(() => window.location.reload(), 2000); }
          else if (data.type === 'instance_deleted') { setBadge('noinstance', 'Instância removida'); setStatus('⚠️ Instância apagada após 15 min. Clique em Atualizar.', '#f59e42'); if (eventSource) { eventSource.close(); eventSource = null; } }
          if (data.lastPasskeyRequest && !passkeyPrompted) renderPasskeySection(data.lastPasskeyRequest);
        } catch(err) { console.error('[SSE] parse error', err); }
      };
      eventSource.onerror = () => { setStatus('⚠️ Conexão SSE perdida. Reconectando...', '#f59e42'); };
    }
    async function checkStatus() {
      try {
        const resp = await fetch('/qrcode-status/' + botId + authQuery, { credentials: 'same-origin' });
        if (!resp.ok) return;
        const status = await resp.json();
        if (statusBox && status) statusBox.textContent = JSON.stringify(status, null, 2);

        if (status.extra?.ok || status.isConnected) {
          setBadge('connected', 'Conectado!');
          setStatus('✅ Conectado com sucesso ao WhatsApp! Recarregando página em 2 segundos...', '#25d366');
          setTimeout(() => window.location.reload(), 2000);
          return;
        }

        if (status.extra?.connectData) {
          applyConnectData(status.extra.connectData);
        }
      } catch(e) {}
    }
    async function startConnect() {
      const btn = document.getElementById('btn-start');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Criando instância...'; }
      setStatus('<div class="spinner"></div> Criando instância e iniciando conexão...', '');
      setBadge('connecting', 'Conectando...');
      try {
        const resp = await fetch('/qrcode-initconnect/' + botId + authQuery, { credentials: 'same-origin' });
        const result = await resp.json();
        if (statusBox) statusBox.textContent = JSON.stringify(result, null, 2);
        updateButtonsForExistingInstance();
        if (result && result.extra && result.extra.connectData) { applyConnectData(result.extra.connectData); }
      } catch(e) {
        setStatus('❌ Erro: ' + (e.message||'Erro desconhecido'), '#ff4d4d');
        if (btn) { btn.disabled = false; btn.textContent = '➕ Criar Instância'; }
        return;
      }
      startSSE();
    }
    async function doAction(url, label) {
      if (!confirm('Tem certeza que deseja executar: ' + label + '?')) return;
      if (statusBox) statusBox.textContent = 'Executando ' + label + '...';
      try {
        const finalUrl = url + (url.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(authRaw);
        const resp = await fetch(finalUrl, { credentials: 'same-origin' });
        const result = await resp.json();
        if (statusBox) statusBox.textContent = JSON.stringify(result, null, 2);
        if (label === 'logout' || label === 'recriar') setTimeout(() => window.location.reload(), 2000);
      } catch(e) { if (statusBox) statusBox.textContent = 'Erro: ' + e.message; }
    }
    function buildPasskeySnippet(ch) {
      const cj = JSON.stringify(ch);
      return '(async () => {\\n  const ch = '+cj+';\\n  function b(v){var s=String(v||"").replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer;}\\n  function a(buf){var u=new Uint8Array(buf),s="";for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\\\+/g,"-").replace(/\\\\//g,"_").replace(/=/g,"");}\\n  const cred=await navigator.credentials.get({publicKey:{challenge:b(ch.challenge),timeout:ch.timeout||60000,rpId:ch.rpId||"whatsapp.com",allowCredentials:(ch.allowCredentials||[]).map(c=>({type:c.type||"public-key",id:b(c.id),transports:c.transports})),userVerification:ch.userVerification||"required"}});\\n  const r=cred.response,body={id:cred.id,rawId:a(cred.rawId),type:cred.type,response:{clientDataJSON:a(r.clientDataJSON),authenticatorData:a(r.authenticatorData),signature:a(r.signature)}};\\n  if(r.userHandle&&r.userHandle.byteLength)body.response.userHandle=a(r.userHandle);\\n  const j=JSON.stringify(body);console.log("%c🔑","color:#1fa855;font-weight:bold");console.log(j);\\n  try{await navigator.clipboard.writeText(j);}catch(e){}\\n})();';
    }
    function renderPasskeySection(challenge) {
      if (!passkeyCont) return;
      passkeyPrompted = true;
      const snippet = buildPasskeySnippet(challenge);
      passkeyCont.innerHTML = '<div class="passkey-box"><h3>🔑 Verificação de Passkey Necessária</h3><div class="passkey-step"><div class="step-label">PASSO 1</div><div class="step-body">Acesse <a href="https://web.whatsapp.com" target="_blank" style="color:#63b3ed">web.whatsapp.com</a></div></div><div class="passkey-step"><div class="step-label">PASSO 2 — Console (F12 → Console)</div></div><div class="passkey-step"><div class="step-label">PASSO 3 — Execute este código:</div><pre class="snippet" id="pk-snippet"></pre><button class="btn-secondary" style="font-size:0.7rem;padding:0.2rem 0.5rem;margin-top:0.3rem" onclick="navigator.clipboard.writeText(document.getElementById(&quot;pk-snippet&quot;).textContent)">📋 Copiar</button></div><div class="passkey-step"><div class="step-label">PASSO 4 — Cole o JSON:</div><textarea class="passkey-input" id="pk-input"></textarea></div><button class="btn-primary" style="width:100%;margin-top:0.5rem" onclick="submitPasskey()">✅ Enviar Passkey</button><div id="passkey-msg"></div></div>';
      const el = document.getElementById('pk-snippet');
      if (el) el.textContent = snippet;
    }
    async function submitPasskey() {
      const ta = document.getElementById('pk-input'), msg = document.getElementById('passkey-msg');
      if (!ta||!msg) return;
      let parsed;
      try { parsed = JSON.parse(ta.value.trim()); } catch(e) { msg.textContent='⚠️ JSON inválido.'; msg.style.color='#f59e42'; return; }
      msg.textContent='Enviando...'; msg.style.color='#4f8ef7';
      try {
        const r = await fetch('/passkey/respond/' + botId + authQuery, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed)});
        const rj = await r.json();
        if (r.ok) { msg.textContent='✅ Passkey enviada!'; msg.style.color='#25d366'; setTimeout(()=>window.location.reload(),3000); }
        else { msg.textContent='❌ '+(rj.error||rj.message||'Erro'); msg.style.color='#ff4d4d'; }
      } catch(e) { msg.textContent='❌ Rede: '+e.message; msg.style.color='#ff4d4d'; }
    }
    (function init() {
      if (isConnected) { if (statusBox) statusBox.textContent = 'Bot conectado.'; return; }
      if (!instanceExists) { if (statusBox) statusBox.textContent = 'Instância não existe na WhatsGoAPI. Clique em "Criar Instância" para criar.'; return; }
      startSSE();
      setInterval(checkStatus, 4000);
      fetch('/qrcode-initconnect/' + botId + authQuery, { credentials: 'same-origin' }).then(r=>r.json()).then(d=>{
        if (statusBox) statusBox.textContent = JSON.stringify(d, null, 2);
        if (d && d.extra && d.extra.connectData) { applyConnectData(d.extra.connectData); }
      }).catch(()=>{});
    })();
  </script>
</body>
</html>`;

			res.send(htmlResponse);
		});

		// Ciclo da vida da ravena
		this.app.get("/ciclo-ravena", async (req, res) => {
			res.redirect("https://gemini.google.com/share/a03e1fe297de");
		});

		// Groups !enviar public data
		this.app.get("/getData/:groupId/:variable", (req, res) => {
			const { groupId, variable } = req.params;

			res.setHeader("Content-Type", "application/json");

			this.logger.info(`[getData] => '${variable}'@'${groupId}'`);

			if (groupId.length > 10 && groupId.endsWith("@g.us")) {
				const filePath = path.join(this.database.databasePath, `data-share`, `${groupId}.json`);

				fs.access(filePath)
					.then(async () => {
						fs.readFile(filePath, "utf8").then((data) => {
							const groupDataShare = JSON.parse(data);

							if (groupDataShare[variable]) {
								const dados = groupDataShare[variable][0];

								if (dados) {
									// Remove daqui a 30 segundos
									setTimeout(
										(gds, vari, fP) => {
											gds[vari].shift();
											if (gds[vari].length == 0) {
												delete gds[vari];
											}

											fs.writeFile(fP, JSON.stringify(gds ?? {}, null, "\t"), "utf8");
										},
										30000,
										groupDataShare,
										variable,
										filePath
									);

									return res
										.status(200)
										.send(
											JSON.stringify({ restantes: groupDataShare[variable]?.length ?? 0, dados })
										);
								} else {
									return res.status(200).send(JSON.stringify({ restantes: 0, dados: null }));
								}
							} else {
								return res
									.status(404)
									.send(JSON.stringify({ erro: `'${variable}' indisponivel para '${groupId}'` }));
							}
						});
					})
					.catch(() =>
						res
							.status(404)
							.send(JSON.stringify({ erro: `Nenhum dado disponível para '${groupId}'` }))
					);
			} else {
				return res.status(400).send(JSON.stringify({ erro: `'${groupId}' não é válido` }));
			}
		});

		this.app.get("/media-direct/:fileName", async (req, res) => {
			const { fileName } = req.params;
			const token = req.query.token;

			if (!token) {
				return res.status(400).send("Token not provided");
			}

			try {
				const webManagementData = await this.readWebManagementToken(token);

				if (!webManagementData) {
					return res.status(401).send("Unauthorized");
				}

				if (new Date() > new Date(webManagementData.expiresAt)) {
					return res.status(401).send("Token expired");
				}

				// Get group data
				const groupData = await this.database.getGroup(webManagementData.groupId);

				if (!groupData) {
					return res.status(404).send("Group not found");
				}

				// Security check: verify the file belongs to this group's configuration or custom commands
				const groupStr = JSON.stringify(groupData);
				let found = groupStr.includes(fileName);

				if (!found) {
					// Check custom commands
					const commands = await this.database.getCustomCommands(webManagementData.groupId);
					const commandsStr = JSON.stringify(commands);
					found = commandsStr.includes(fileName);
				}

				if (!found) {
					this.logger.warn(
						`[security] Unauthenticated access attempt to file ${fileName} by group ${groupData.id}`
					);
					return res.status(403).send("Forbidden");
				}

				const filePath = path.join(this.database.databasePath, "media", fileName);

				// Verify file exists
				try {
					await fs.access(filePath);
				} catch {
					return res.status(404).send("File not found");
				}

				// Set content type
				const ext = path.extname(fileName).toLowerCase();
				let contentType = "application/octet-stream";

				switch (ext) {
					case ".jpg":
					case ".jpeg":
						contentType = "image/jpeg";
						break;
					case ".png":
						contentType = "image/png";
						break;
					case ".gif":
						contentType = "image/gif";
						break;
					case ".mp4":
						contentType = "video/mp4";
						break;
					case ".mp3":
						contentType = "audio/mpeg";
						break;
					case ".wav":
						contentType = "audio/wav";
						break;
					case ".webp":
						contentType = "image/webp";
						break;
				}

				res.setHeader("Content-Type", contentType);
				res.sendFile(filePath);
			} catch (error) {
				this.logger.error("Error serving direct media:", error);
				return res.status(500).send("Server error");
			}
		});

		// Dashboard: Get bots configuration
		this.app.get("/api/bots", authenticateBasic, async (req, res) => {
			try {
				const botsJsonPath = path.join(__dirname, "../bots.json");
				const data = await fs.readFile(botsJsonPath, "utf8");
				res.json(JSON.parse(data));
			} catch (error) {
				if (error.code === "ENOENT") {
					this.logger.warn("bots.json not found, returning empty array.");
					return res.json([]);
				}
				this.logger.error("Error reading bots.json:", error);
				res.status(500).json({ status: "error", message: "Failed to read bots configuration." });
			}
		});

		// Dashboard: Save bots configuration
		this.app.post("/api/bots", authenticateBasic, async (req, res) => {
			const botsData = req.body;
			if (!Array.isArray(botsData)) {
				return res
					.status(400)
					.json({ status: "error", message: "Invalid data format. Expected an array." });
			}

			// Validation
			for (const bot of botsData) {
				if (typeof bot.enabled !== "boolean" || !bot.nome || !bot.numero) {
					return res.status(400).json({
						status: "error",
						message: `Invalid entry: 'enabled' must be a boolean, 'nome' and 'numero' are required. Problematic entry: ${JSON.stringify(bot)}`
					});
				}
			}

			try {
				const botsJsonPath = path.join(__dirname, "../bots.json");
				await fs.writeFile(botsJsonPath, JSON.stringify(botsData, null, 2), "utf8");
				res.json({ status: "ok", message: "Configuration saved successfully." });
			} catch (error) {
				this.logger.error("Error writing to bots.json:", error);
				res.status(500).json({ status: "error", message: "Failed to save bots configuration." });
			}
		});

		// Dashboard: Stream logs
		this.app.get("/api/logs", authenticateBasic, (req, res) => {
			this.logger.info("Starting log stream to dashboard.");
			res.setHeader("Content-Type", "text/event-stream");
			res.setHeader("Cache-Control", "no-cache");
			res.setHeader("Connection", "keep-alive");

			const logStream = spawn("pm2", ["logs", "ravena-ai", "--raw"]);

			logStream.stdout.on("data", (data) => {
				res.write(`data: ${data.toString()}\n\n`);
			});

			logStream.stderr.on("data", (data) => {
				res.write(`data: [ERROR] ${data.toString()}\n\n`);
			});

			req.on("close", () => {
				this.logger.info("Closing log stream to dashboard.");
				logStream.kill();
			});
		});

		// Copa 2026 notifications endpoint
		this.app.post("/copa", this.strictLimiter, async (req, res) => {
			this.logger.info("[Copa Webhook] Request received at /copa", {
				headers: req.headers,
				body: req.body
			});

			try {
				const { event, match, goalDetails } = req.body;

				if (!event || !match) {
					this.logger.warn("[Copa Webhook] Invalid payload structure. event or match missing.", {
						body: req.body
					});
					return res
						.status(400)
						.json({ status: "error", message: "Payload inválido. Requer 'event' e 'match'." });
				}

				if (!this.bots || this.bots.length === 0) {
					this.logger.warn("[Copa Webhook] No bots available to process Copa notifications.");
					return res.status(503).json({ status: "error", message: "Nenhum bot disponível." });
				}

				const CopaHelpers = require("./functions/Copa2026");
				let teamsMap = {};
				try {
					teamsMap = await CopaHelpers.fetchTeamsMap();
					this.logger.info(
						`[Copa Webhook] Loaded teams map. Total teams: ${Object.keys(teamsMap).length}`
					);
				} catch (e) {
					this.logger.error("Erro ao buscar mapa de times na notificação da Copa:", e.message);
				}

				const homeTeamId = String(match.home_team_id);
				const awayTeamId = String(match.away_team_id);
				this.logger.info(
					`[Copa Webhook] Event: '${event}', HomeTeamId: ${homeTeamId}, AwayTeamId: ${awayTeamId}`
				);

				const followers = await this.database.dbAll(
					"copa_seguir",
					"SELECT chat_id, team_id, team_name_pt, fifa_code FROM copa_seguindo WHERE team_id = ? OR team_id = ?",
					[homeTeamId, awayTeamId]
				);

				this.logger.info(
					`[Copa Webhook] Database followers count: ${followers ? followers.length : 0}`,
					{ followers }
				);

				if (!followers || followers.length === 0) {
					this.logger.info(
						`[Copa Webhook] No chats are following home_team_id ${homeTeamId} or away_team_id ${awayTeamId}`
					);
					return res.json({ status: "ok", message: "Nenhum chat seguindo estes times." });
				}

				const chatIds = [...new Set(followers.map((f) => f.chat_id))];
				const homeTeam = teamsMap[homeTeamId] || {
					namePt: match.home_team_name_en || "Casa",
					flagEmoji: CopaHelpers.flag(match.home_fifa_code || "")
				};
				const awayTeam = teamsMap[awayTeamId] || {
					namePt: match.away_team_name_en || "Fora",
					flagEmoji: CopaHelpers.flag(match.away_fifa_code || "")
				};
				this.logger.info(
					`[Copa Webhook] Teams resolved. Home: ${homeTeam.namePt} (${homeTeamId}), Away: ${awayTeam.namePt} (${awayTeamId}). Chats to notify: ${chatIds.join(", ")}`
				);

				for (const chatId of chatIds) {
					const chatFollows = followers.filter((f) => f.chat_id === chatId);
					const followedNames = chatFollows.map((f) => f.team_name_pt).join(" e ");

					// Token aleatório de 8 chars para evitar detecção de spam (mesmo padrão do InviteSystem)
					const rndToken = () =>
						Math.random().toString(36).substring(2, 6) + Math.random().toString(36).substring(2, 6);

					let messageText = "";

					if (event === "match_start") {
						messageText =
							`⚽ *A BOLA ROLOU na Copa 2026!* ⚽\n\n` +
							`🏆 O jogo começou!\n` +
							`⚔️ ${homeTeam.flagEmoji} *${homeTeam.namePt}* vs ${awayTeam.flagEmoji} *${awayTeam.namePt}*\n\n` +
							`📌 Grupo/Fase: *${match.group || match.type || "—"}*\n` +
							`🏟️ Estádio ID: ${match.stadium_id || "—"}\n\n` +
							`Acompanhe com a gente! 🔴\n\n` +
							`_${rndToken()}_`;
					} else if (event === "goal") {
						const details = goalDetails || {};
						const scoringTeam = teamsMap[details.scoringTeamId] ||
							Object.values(teamsMap).find((t) => t.name_en === details.scoringTeamNameEn) || {
								namePt: details.scoringTeamNameEn || "Autor do Gol",
								flagEmoji: "⚽"
							};

						// Sanitiza nome do jogador — rejeita null, "null", vazio
						const rawPlayer = details.player;
						const playerClean =
							rawPlayer && String(rawPlayer).toLowerCase() !== "null" ? rawPlayer.trim() : "";
						const playerStr = playerClean ? ` (${playerClean})` : "";

						// Subtrai 3 minutos do tempo exibido para compensar delay de notificação
						const rawMinute = details.minute || match.time_elapsed || "";
						const minuteNumMatch = rawMinute.toString().match(/^(\d+)'?$/);
						const displayMinute = minuteNumMatch
							? `${Math.max(0, Number(minuteNumMatch[1]) - 3)}'`
							: rawMinute;
						const minuteStr = displayMinute ? ` aos ${displayMinute}` : "";

						// Mesmo ajuste de -3min no campo "Tempo de jogo"
						const rawElapsed = match.time_elapsed || "";
						const elapsedNumMatch = rawElapsed.toString().match(/^(\d+)'?$/);
						const displayElapsed = elapsedNumMatch
							? `${Math.max(0, Number(elapsedNumMatch[1]) - 3)}'`
							: rawElapsed;

						messageText =
							`⚽ *GOOOOL DA COPA 2026!* ⚽\n\n` +
							`${scoringTeam.flagEmoji} *Gol do(a) ${scoringTeam.namePt}!*${playerStr}${minuteStr}\n\n` +
							`⚔️ Placar Atual: ${homeTeam.flagEmoji} *${homeTeam.namePt}* ${match.home_score} x ${match.away_score} ${awayTeam.flagEmoji} *${awayTeam.namePt}*\n\n` +
							`⏱️ Tempo de jogo: ${displayElapsed || "—"}\n\n` +
							`_${rndToken()}_`;
					} else if (event === "match_end") {
						let resultMessage = "";
						const chatFollowsHome = chatFollows.some((f) => String(f.team_id) === homeTeamId);
						const chatFollowsAway = chatFollows.some((f) => String(f.team_id) === awayTeamId);

						const homeScore = Number(match.home_score) || 0;
						const awayScore = Number(match.away_score) || 0;

						if (homeScore === awayScore) {
							resultMessage = "🤝 Partida terminada em empate!";
						} else if (chatFollowsHome && !chatFollowsAway) {
							if (homeScore > awayScore) {
								resultMessage = `🥳 *Vitória!* O(A) ${homeTeam.flagEmoji} *${homeTeam.namePt}* venceu a partida! 🏆`;
							} else {
								resultMessage = `😢 *Derrota.* O(A) ${homeTeam.flagEmoji} *${homeTeam.namePt}* perdeu a partida.`;
							}
						} else if (chatFollowsAway && !chatFollowsHome) {
							if (awayScore > homeScore) {
								resultMessage = `🥳 *Vitória!* O(A) ${awayTeam.flagEmoji} *${awayTeam.namePt}* venceu a partida! 🏆`;
							} else {
								resultMessage = `😢 *Derrota.* O(A) ${awayTeam.flagEmoji} *${awayTeam.namePt}* perdeu a partida.`;
							}
						} else {
							const winner = homeScore > awayScore ? homeTeam : awayTeam;
							resultMessage = `🏁 Fim de papo! Vitória do(a) ${winner.flagEmoji} *${winner.namePt}*!`;
						}

						messageText =
							`🏁 *FIM DE PARTIDA na Copa 2026!* 🏁\n\n` +
							`O jogo do(a) *${followedNames}* terminou.\n\n` +
							`⚔️ Placar Final: ${homeTeam.flagEmoji} *${homeTeam.namePt}* ${homeScore} x ${awayScore} ${awayTeam.flagEmoji} *${awayTeam.namePt}*\n\n` +
							`${resultMessage}\n\n` +
							`_${rndToken()}_`;
					}

					if (messageText) {
						try {
							// Determina o bot correto com base no chatId
							const isWhatsAppChat =
								chatId.includes("@") ||
								(/^\d+$/.test(chatId) && chatId.length >= 10 && chatId.length <= 15);

							if (isWhatsAppChat) {
								const waBots = this.bots.filter(
									(b) => b.isConnected && !b.useTelegram && !b.useDiscord
								);
								if (waBots.length === 0) {
									const fallbackWa = this.bots.find((b) => !b.useTelegram && !b.useDiscord);
									if (fallbackWa) waBots.push(fallbackWa);
								}

								if (waBots.length === 0) {
									throw new Error(`Nenhum bot do WhatsApp encontrado para o chat: ${chatId}`);
								}

								let sent = false;
								let lastError = null;
								for (const currentBot of waBots) {
									try {
										this.logger.info(
											`[Copa Webhook] Sending notification to chat ${chatId} using bot ${currentBot.id || currentBot.botId}. Message: "${messageText.replace(/\n/g, "\\n")}"`
										);
										await currentBot.sendMessage(chatId, messageText);
										this.logger.info(
											`[Copa Webhook] Notification sent successfully to chat ${chatId} using bot ${currentBot.id || currentBot.botId}`
										);
										sent = true;
										break;
									} catch (err) {
										lastError = err;
										this.logger.warn(
											`[Copa Webhook] Failed to send using bot ${currentBot.id || currentBot.botId}: ${err.message || err}. Trying next WhatsApp bot if available.`
										);
									}
								}
								if (!sent) {
									throw (
										lastError ||
										new Error("Todos os bots de WhatsApp falharam ao enviar a mensagem.")
									);
								}
							} else {
								let targetBot = null;
								if (/^\d{17,20}$/.test(chatId)) {
									targetBot =
										this.bots.find((b) => b.useDiscord && b.isConnected) ||
										this.bots.find((b) => b.useDiscord);
								} else {
									targetBot =
										this.bots.find((b) => b.useTelegram && b.isConnected) ||
										this.bots.find((b) => b.useTelegram);
								}

								if (!targetBot) {
									throw new Error(`Nenhum bot compatível encontrado para o chat: ${chatId}`);
								}

								this.logger.info(
									`[Copa Webhook] Sending notification to chat ${chatId} using bot ${targetBot.id || targetBot.botId}. Message: "${messageText.replace(/\n/g, "\\n")}"`
								);
								await targetBot.sendMessage(chatId, messageText);
								this.logger.info(`[Copa Webhook] Notification sent successfully to chat ${chatId}`);
							}
						} catch (error) {
							this.logger.error(
								`Erro ao enviar notificação da Copa para o chat ${chatId}:`,
								error.message
							);
						}
					} else {
						this.logger.warn(
							`[Copa Webhook] Empty message text generated for event '${event}' to chat ${chatId}`
						);
					}
				}

				res.json({ status: "ok", message: "Notificações enviadas." });
			} catch (error) {
				this.logger.error("Erro no endpoint /copa:", error);
				res.status(500).json({ status: "error", message: error.message });
			}
		});
	}

	/**
	 * Atualiza o cache de estatísticas detalhadas dos bots
	 */
	async updateBotStatsCache() {
		this.logger.info("Atualizando cache de estatísticas detalhadas dos bots...");
		const now = Date.now();
		const periods = {
			year: now - 365 * 24 * 60 * 60 * 1000,
			month: now - 30 * 24 * 60 * 60 * 1000,
			week: now - 7 * 24 * 60 * 60 * 1000,
			day: now - 24 * 60 * 60 * 1000,
			hour: now - 60 * 60 * 1000
		};

		const statsData = [];
		const botsAtivos = this.bots.filter((b) => !b.privado && !b.useTelegram && !b.useDiscord);

		// Totais gerais
		const totalStats = {
			id: "TOTAL",
			groupsCount: 0,
			year: 0,
			month: 0,
			week: 0,
			day: 0,
			hour: 0
		};

		for (const bot of botsAtivos) {
			try {
				const groups = await bot.listGroups(); // Assume que retorna array de grupos
				const groupsCount = groups ? groups.length : 0;

				// Busca stats para cada período
				const periodPromises = Object.entries(periods).map(async ([key, startDate]) => {
					const stats = await bot.loadReport.getStatistics({
						startDate,
						endDate: now,
						botId: bot.id
					});

					let finalTotal = stats.totalMessages;

					// Extrapolação para dados anuais se tivermos menos de 365 dias de dados
					if (key === "year" && stats.totalMessages > 0 && stats.firstReportTimestamp) {
						const daysAvailable = (now - stats.firstReportTimestamp) / (24 * 60 * 60 * 1000);

						if (daysAvailable > 1 && daysAvailable < 365) {
							const avgPerDay = stats.totalMessages / daysAvailable;
							const missingDays = 365 - daysAvailable;
							const extrapolated = stats.totalMessages + avgPerDay * missingDays * 1.0;
							finalTotal = Math.round(extrapolated);
							// this.logger.info(`[Stats] Extrapolated year for ${bot.id}: ${stats.totalMessages} in ${daysAvailable.toFixed(1)}d -> ${finalTotal}`);
						}
					}

					return { key, total: finalTotal };
				});

				const results = await Promise.all(periodPromises);
				const botStats = {
					id: bot.id,
					groupsCount,
					year: 0,
					month: 0,
					week: 0,
					day: 0,
					hour: 0
				};

				results.forEach(({ key, total }) => {
					botStats[key] = total;
					totalStats[key] += total;
				});

				totalStats.groupsCount += groupsCount;
				statsData.push(botStats);
			} catch (error) {
				this.logger.error(`Erro ao processar stats para bot ${bot.id}:`, error);
				statsData.push({
					id: bot.id,
					groupsCount: 0,
					year: 0,
					month: 0,
					week: 0,
					day: 0,
					hour: 0
				});
			}
		}

		// Adiciona o total ao final
		statsData.push(totalStats);

		this.botStatsCache = {
			lastUpdate: now,
			cacheTime: 30 * 60000,
			data: statsData
		};

		this.logger.info("Cache de estatísticas detalhadas atualizado.");
	}

	/**
	 * Atualiza o cache de dados analíticos
	 * @returns {Promise<void>}
	 */
	async updateAnalyticsCache() {
		if (this.isUpdatingAnalytics) {
			this.logger.warn("Atualização de cache de dados analíticos já em andamento, pulando...");
			return;
		}

		this.isUpdatingAnalytics = true;
		try {
			this.logger.info("Atualizando cache de dados analíticos (otimizado)...");

			// Obtém dados agregados do banco (muito mais rápido que processar 350k linhas no JS)
			const yearStart = new Date();
			yearStart.setDate(yearStart.getDate() - 370);

			const aggregatedData = await this.database.getAggregatedLoadReports(yearStart.getTime());

			if (!aggregatedData || aggregatedData.length === 0) {
				this.logger.warn("Nenhum dado analítico encontrado para processamento");
				this.analyticsCache.lastUpdate = Date.now();
				return;
			}

			// Agrupa dados por bot
			const botDataGroups = {};
			for (const row of aggregatedData) {
				if (!botDataGroups[row.botId]) {
					botDataGroups[row.botId] = [];
				}
				botDataGroups[row.botId].push(row);
			}

			// Processa dados para cada bot
			for (const botId of Object.keys(botDataGroups)) {
				const botRows = botDataGroups[botId];

				// Processa dados diários (por hora)
				this.analyticsCache.daily[botId] = this.processDailyDataAggregated(botRows);

				// Processa dados semanais (por dia da semana)
				this.analyticsCache.weekly[botId] = this.processWeeklyDataAggregated(botRows);

				// Processa dados mensais (por dia do mês)
				this.analyticsCache.monthly[botId] = this.processMonthlyDataAggregated(botRows);

				// Processa dados anuais (por dia)
				this.analyticsCache.yearly[botId] = this.processYearlyDataAggregated(botRows);

				await new Promise((resolve) => setImmediate(resolve));
			}

			// Salva datas comuns para o gráfico anual
			const yearlyDates = new Set();
			for (const data of Object.values(this.analyticsCache.yearly)) {
				if (data && data.dates) {
					for (const date of data.dates) {
						yearlyDates.add(date);
					}
				}
			}

			const sortedDates = Array.from(yearlyDates).sort();

			// Normaliza os dados anuais para usar as mesmas datas (essencial para o frontend)
			for (const botId of Object.keys(this.analyticsCache.yearly)) {
				const botData = this.analyticsCache.yearly[botId];
				if (botData) {
					const newValues = [];
					const dateValueMap = {};

					if (botData.dates && botData.values) {
						for (let i = 0; i < botData.dates.length; i++) {
							dateValueMap[botData.dates[i]] = botData.values[i] ?? 0;
						}
					}

					for (const date of sortedDates) {
						newValues.push(dateValueMap[date] ?? 0);
					}

					this.analyticsCache.yearly[botId] = {
						dates: sortedDates,
						values: newValues
					};
				}
				await new Promise((resolve) => setImmediate(resolve));
			}

			this.analyticsCache.lastUpdate = Date.now();
			this.logger.info("Cache de dados analíticos atualizado com sucesso");
		} catch (error) {
			this.logger.error("Erro ao atualizar cache de dados analíticos:", error);
		} finally {
			this.isUpdatingAnalytics = false;
		}
	}

	/**
	 * Helpers otimizados para dados já agregados por SQL
	 */
	processDailyDataAggregated(rows) {
		const hourSums = Array(24).fill(0);
		const hourCounts = Array(24).fill(0);

		for (const row of rows) {
			const hour = new Date(row.hourKey).getHours();
			hourSums[hour] += row.totalMessages;
			hourCounts[hour]++;
		}

		return {
			values: hourSums.map((sum, i) => (hourCounts[i] > 0 ? Math.round(sum / hourCounts[i]) : 0))
		};
	}

	processWeeklyDataAggregated(rows) {
		// Agrupa por dia primeiro (dateKey)
		const dailyTotals = {};
		for (const row of rows) {
			if (!dailyTotals[row.dateKey]) dailyTotals[row.dateKey] = 0;
			dailyTotals[row.dateKey] += row.totalMessages;
		}

		const daySums = Array(7).fill(0);
		const dayCounts = Array(7).fill(0);

		for (const [dateKey, total] of Object.entries(dailyTotals)) {
			const dayOfWeek = new Date(dateKey + "T00:00:00Z").getUTCDay();
			daySums[dayOfWeek] += total;
			dayCounts[dayOfWeek]++;
		}

		return {
			values: daySums.map((sum, i) => (dayCounts[i] > 0 ? Math.round(sum / dayCounts[i]) : 0))
		};
	}

	processMonthlyDataAggregated(rows) {
		const daySums = Array(31).fill(0);
		const dayCounts = Array(31).fill(0);

		for (const row of rows) {
			const day = parseInt(row.dayOfMonth) - 1;
			if (day >= 0 && day < 31) {
				daySums[day] += row.totalMessages;
				dayCounts[day]++;
			}
		}

		return {
			values: daySums.map((sum, i) => (dayCounts[i] > 0 ? Math.round(sum / dayCounts[i]) : 0))
		};
	}

	processYearlyDataAggregated(rows) {
		const dailyTotals = {};
		for (const row of rows) {
			if (!dailyTotals[row.dateKey]) dailyTotals[row.dateKey] = 0;
			dailyTotals[row.dateKey] += row.totalMessages;
		}

		const dates = Object.keys(dailyTotals).sort();
		const values = dates.map((d) => dailyTotals[d]);

		return { dates, values };
	}

	/**
	 * Processa dados diários (por hora)
	 * @param {Array} reports - Relatórios de carga
	 * @returns {Promise<Object>} - Dados processados
	 */
	async processDailyData(reports) {
		try {
			const hourlyTotalsByDate = {};
			let count = 0;

			for (const report of reports) {
				if (++count % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
				if (report.period && report.period.start && report.messages) {
					const date = new Date(report.period.start);
					date.setMinutes(0, 0, 0);
					const key = date.toISOString();

					const totalMsgs = (report.messages.totalReceived ?? 0) + (report.messages.totalSent ?? 0);

					if (!hourlyTotalsByDate[key]) hourlyTotalsByDate[key] = 0;
					hourlyTotalsByDate[key] += totalMsgs;
				}
			}

			const hourSums = Array(24).fill(0);
			const hourCounts = Array(24).fill(0);

			count = 0;
			for (const [key, total] of Object.entries(hourlyTotalsByDate)) {
				if (++count % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
				const hour = new Date(key).getHours();
				hourSums[hour] += total;
				hourCounts[hour]++;
			}

			const hourlyAverages = hourSums.map((sum, index) => {
				const count = hourCounts[index];
				return count > 0 ? Math.round(sum / count) : 0;
			});

			return {
				values: hourlyAverages
			};
		} catch (error) {
			this.logger.error("Erro ao processar dados diários:", error);
			return { values: Array(24).fill(0) };
		}
	}

	/**
	 * Processa dados semanais (por dia da semana)
	 * @param {Array} reports - Relatórios de carga
	 * @returns {Promise<Object>} - Dados processados
	 */
	async processWeeklyData(reports) {
		try {
			const dailyTotals = {};
			let count = 0;

			for (const report of reports) {
				if (++count % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
				if (report.period && report.period.start && report.messages) {
					const dateString = new Date(report.period.start).toISOString().split("T")[0];
					const totalMsgs = (report.messages.totalReceived ?? 0) + (report.messages.totalSent ?? 0);

					if (!dailyTotals[dateString]) dailyTotals[dateString] = 0;
					dailyTotals[dateString] += totalMsgs;
				}
			}

			const daySums = Array(7).fill(0);
			const dayCounts = Array(7).fill(0);

			count = 0;
			for (const [dateString, total] of Object.entries(dailyTotals)) {
				if (++count % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
				const dayOfWeek = new Date(dateString).getUTCDay();
				daySums[dayOfWeek] += total;
				dayCounts[dayOfWeek]++;
			}

			const dailyAverages = daySums.map((sum, index) => {
				const count = dayCounts[index];
				return count > 0 ? Math.round(sum / count) : 0;
			});

			return {
				values: dailyAverages
			};
		} catch (error) {
			this.logger.error("Erro ao processar dados semanais:", error);
			return { values: Array(7).fill(0) };
		}
	}

	/**
	 * Processa dados mensais (por dia do mês)
	 * @param {Array} reports - Relatórios de carga
	 * @returns {Promise<Object>} - Dados processados
	 */
	async processMonthlyData(reports) {
		try {
			// Mantido apenas para compatibilidade, mas não será usado no filtro 'monthly'
			// Inicializa arrays para os 31 dias do mês
			const dayCounts = Array(31).fill(0);
			const dayTotals = Array(31).fill(0);

			// Processa cada relatório
			let count = 0;
			for (const report of reports) {
				if (++count % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
				if (report.period && report.period.start && report.messages) {
					const date = new Date(report.period.start);
					const day = date.getDate() - 1; // 0-30

					// Soma mensagens totais deste relatório
					const totalMsgs = (report.messages.totalReceived ?? 0) + (report.messages.totalSent ?? 0);

					// Adiciona ao contador de dias e totais
					dayCounts[day]++;
					dayTotals[day] += totalMsgs;
				}
			}

			// Calcula média por dia do mês
			const monthlyAverages = dayTotals.map((total, index) => {
				const count = dayCounts[index];
				return count > 0 ? Math.round(total / count) : 0;
			});

			return {
				values: monthlyAverages
			};
		} catch (error) {
			this.logger.error("Erro ao processar dados mensais:", error);
			return { values: Array(31).fill(0) };
		}
	}

	/**
	 * Processa dados anuais (por dia)
	 * @param {Array} reports - Relatórios de carga
	 * @returns {Promise<Object>} - Dados processados
	 */
	async processYearlyData(reports) {
		try {
			// Mapeia totais diários
			const dailyTotals = {};

			// Processa cada relatório
			let count = 0;
			for (const report of reports) {
				if (++count % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
				if (report.period && report.period.start && report.messages) {
					const date = new Date(report.period.start);
					const dateString = date.toISOString().split("T")[0]; // YYYY-MM-DD

					// Soma mensagens totais deste relatório
					const totalMsgs = (report.messages.totalReceived ?? 0) + (report.messages.totalSent ?? 0);

					// Adiciona ao total diário
					if (!dailyTotals[dateString]) {
						dailyTotals[dateString] = 0;
					}
					dailyTotals[dateString] += totalMsgs;
				}
			}

			// Converte para arrays ordenados por data
			const dates = Object.keys(dailyTotals).sort();
			const values = dates.map((date) => dailyTotals[date] ?? 0);

			return {
				dates,
				values
			};
		} catch (error) {
			this.logger.error("Erro ao processar dados anuais:", error);
			return { dates: [], values: [] };
		}
	}

	/**
	 * Filtra dados analíticos do cache com base no período e bots selecionados
	 * @param {string} period - Período (today, week, month, year)
	 * @param {Array} selectedBots - IDs dos bots selecionados
	 * @returns {Object} - Dados filtrados
	 */
	filterAnalyticsData(period, selectedBots) {
		try {
			// Prepara resultado
			const result = {
				status: "ok",
				timestamp: Date.now(),
				daily: {},
				weekly: {},
				monthly: {},
				yearly: {}
			};

			// Special handling for monthly (now: Weekly Messages per Bot)
			const processMonthly = () => {
				const botStats = this.botStatsCache.data;
				const filteredStats = botStats.filter(
					(b) => selectedBots.includes(b.id) && b.id !== "TOTAL"
				);

				const categories = filteredStats.map((b) => b.id);
				const data = filteredStats.map((b) => b.week || 0);

				return {
					days: categories, // Reusing 'days' field for categories
					series: [
						{
							name: "Msgs na Semana",
							data
						}
					]
				};
			};

			// Função auxiliar para processar dados por período
			const processData = (periodKey) => {
				if (periodKey === "monthly") return processMonthly();

				const periodData = this.analyticsCache[periodKey];

				let combinedValues = null;
				let dates = null;

				// Para cada bot selecionado, soma os dados
				selectedBots.forEach((botId) => {
					if (periodData[botId] && periodData[botId].values) {
						const values = periodData[botId].values;

						// Pega as datas do primeiro bot que tiver (são normalizadas no updateAnalyticsCache)
						if (periodKey === "yearly" && !dates && periodData[botId].dates) {
							dates = periodData[botId].dates;
						}

						if (!combinedValues) {
							combinedValues = [...values];
						} else {
							for (let i = 0; i < combinedValues.length; i++) {
								combinedValues[i] += values[i] || 0;
							}
						}
					}
				});

				// Nomes das séries baseados no periodo
				let seriesName = "Total";
				switch (periodKey) {
					case "daily":
						seriesName = "Média Msgs/Hora";
						break;
					case "weekly":
						seriesName = "Média Msgs/Dia";
						break;
					case "yearly":
						seriesName = "Msgs no ano";
						break;
				}

				// Processamento específico para o gráfico anual (current year + intelligent aggregation)
				if (periodKey === "yearly" && dates && combinedValues) {
					const currentYear = new Date().getFullYear();
					const currentMonth = new Date().getMonth(); // 0 = Jan, 11 = Dec

					// Filter only current year first
					const currentYearData = [];
					for (let i = 0; i < dates.length; i++) {
						if (dates[i].startsWith(currentYear)) {
							currentYearData.push({ date: dates[i], value: combinedValues[i] });
						}
					}

					const finalCategories = [];
					const dailySeriesData = [];
					const monthlySeriesData = [];

					const monthNames = [
						"Janeiro",
						"Fevereiro",
						"Março",
						"Abril",
						"Maio",
						"Junho",
						"Julho",
						"Agosto",
						"Setembro",
						"Outubro",
						"Novembro",
						"Dezembro"
					];

					// Logic:
					// If Jan/Feb/Mar (Q1) -> Show All Days (Spline)
					// If > Mar -> Show Last 2 Months as Days, Older as Month Totals (Bar)

					if (currentMonth <= 2) {
						// Q1 Strategy: All days
						currentYearData.forEach((item) => {
							const parts = item.date.split("-");
							finalCategories.push(`${parts[2]}/${parts[1]}`); // DD/MM
							dailySeriesData.push(item.value);
							monthlySeriesData.push(null); // No bars
						});
					} else {
						// Q2+ Strategy: Mixed
						// Cutoff date: 1st of (CurrentMonth - 1)
						// E.g. If July (6), Cutoff is June (5) 1st.
						const cutoffMonthIndex = currentMonth - 1;
						// Actually logic requested: "April to December: Show all days from last two months"
						// Last two months = Current Month + Previous Month.
						// So Cutoff is indeed the start of Previous Month.

						const monthlyTotals = {}; // monthIndex -> total

						currentYearData.forEach((item) => {
							const d = new Date(item.date + "T12:00:00"); // Avoid TZ issues
							const mIdx = d.getMonth();

							if (mIdx < cutoffMonthIndex) {
								// Accumulate for Monthly Bar
								if (!monthlyTotals[mIdx]) monthlyTotals[mIdx] = 0;
								monthlyTotals[mIdx] += item.value;
							} else {
								// Keep for Daily Line (processed later to ensure order)
							}
						});

						// Push Monthly Bars
						for (let i = 0; i < cutoffMonthIndex; i++) {
							if (monthlyTotals[i] !== undefined) {
								finalCategories.push(monthNames[i]);
								monthlySeriesData.push(monthlyTotals[i]);
								dailySeriesData.push(null);
							}
						}

						// Push Daily Lines
						currentYearData.forEach((item) => {
							const d = new Date(item.date + "T12:00:00");
							const mIdx = d.getMonth();
							if (mIdx >= cutoffMonthIndex) {
								const parts = item.date.split("-");
								finalCategories.push(`${parts[2]}/${parts[1]}`);
								dailySeriesData.push(item.value);
								monthlySeriesData.push(null);
							}
						});
					}

					return {
						dates: finalCategories, // repurposed categories
						series: [
							{
								name: "Total Mensal",
								type: "column",
								data: monthlySeriesData,
								color: "#3e0ea7",
								yAxis: 0
							},
							{
								name: "Total Diário",
								type: "areaspline",
								data: dailySeriesData,
								color: "#04a9f0",
								yAxis: 0
							}
						]
					};
				}

				const seriesData = [
					{
						name: seriesName,
						data: combinedValues || []
					}
				];

				// Retorna os dados formatados para o período
				return {
					hours: periodKey === "daily" ? Array.from({ length: 24 }, (_, i) => i) : null,
					days:
						periodKey === "weekly"
							? ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"]
							: null,
					dates: periodKey === "yearly" ? (dates ?? []) : null,
					values: null,
					series: seriesData
				};
			};

			// Processa dados para cada período
			result.daily = processData("daily");
			result.weekly = processData("weekly");
			result.monthly = processData("monthly");
			result.yearly = processData("yearly");

			return result;
		} catch (error) {
			this.logger.error("Erro ao filtrar dados analíticos:", error);
			return {
				status: "error",
				message: "Erro ao filtrar dados analíticos",
				timestamp: Date.now()
			};
		}
	}

	/**
	 * Notifica grupos sobre status de energia
	 * @param {string} message - Mensagem a ser enviada
	 */
	async notifyPowerStatus(message) {
		const bot =
			this.bots.find((b) => b.notificarDonate) ??
			this.bots.find((b) => b.isConnected && !b.privado) ??
			this.bots[0];

		if (!bot) {
			this.logger.warn("No bot available to send power notification");
			return;
		}

		if (bot.grupoAnuncios) {
			try {
				await bot.sendMessage(bot.grupoAnuncios, message, { marcarTodos: true });
			} catch (e) {
				this.logger.error(
					`Erro ao enviar notificação de energia para grupoAnuncios (${bot.grupoAnuncios})`
				);
			}
		}

		if (bot.grupoAvisos) {
			try {
				await bot.sendMessage(bot.grupoAvisos, message, { marcarTodos: true });
			} catch (error) {
				this.logger.error(
					`Erro ao enviar notificação de energia para grupoAvisos (${bot.grupoAvisos}):`,
					error
				);
			}
		}
	}

	/**
	 * Notifica grupos sobre uma doação
	 * @param {string} name - Nome do doador
	 * @param {number} amount - Valor da doação
	 * @param {string} message - Mensagem da doação
	 */
	async notifyGroupsAboutDonation(name, amount, message, donationTotal = 0) {
		try {
			const ignorar = message.includes("#ravprivate") ?? false;

			// Prepara a mensagem de notificação
			const totalMsg =
				donationTotal > 0
					? `> _${name}_ já doou um total de R$${donationTotal.toFixed(2)}\n\n`
					: "";

			const donationMsg =
				`💸 Recebemos um DONATE no tipa.ai! 🥳\n\n` +
				`*MUITO obrigado* pelos R$${amount.toFixed(2)}, ${name}! 🥰\n` +
				`Compartilho aqui com todos sua mensagem:\n` +
				`💬 ${message}\n\n${totalMsg}` +
				`\`\`\`!doar ou !donate pra conhecer os outros apoiadores e doar também\`\`\``;

			// Calcula tempo extra de fixação com base no valor da doação (300 segundos por 1 unidade de moeda)
			const extraPinTime = Math.floor(amount * 300);
			const pinDuration = 600 + extraPinTime; // Base de 10 minutos + tempo extra

			// Apenas um dos bots devem enviar msg sobre donate
			const bot =
				this.bots.find((b) => b.notificarDonate) ??
				this.bots[Math.floor(Math.random() * this.bots.length)];

			// Primeiro notifica o grupo de logs
			if (bot.grupoLogs) {
				try {
					await bot.sendMessage(bot.grupoLogs, donationMsg, { marcarTodos: true });
				} catch (error) {
					this.logger.error(
						`Erro ao enviar notificação de doação para grupoLogs (${bot.grupoLogs}):`,
						error
					);
				}
			}

			// Notifica o grupo de avisos
			if (bot.grupoAnuncios && !ignorar) {
				try {
					const sentMsg = await bot.sendMessage(bot.grupoAnuncios, donationMsg, {
						marcarTodos: true
					});
				} catch (e) {
					this.logger.error(
						`Erro ao enviar notificação de doação para grupoAnuncios (${bot.grupoAnuncios})`
					);
				}
			}

			if (bot.grupoAvisos && !ignorar) {
				try {
					const sentMsg = await bot.sendMessage(bot.grupoAvisos, donationMsg, {
						marcarTodos: true
					});

					// Tenta fixar a mensagem
					try {
						if (sentMsg && sentMsg.pin) {
							await sentMsg.pin(pinDuration);
						}
					} catch (pinError) {
						this.logger.error("Erro ao fixar mensagem no grupoAvisos:", pinError);
					}
				} catch (error) {
					this.logger.error(
						`Erro ao enviar notificação de doação para grupoAvisos (${bot.grupoAvisos}):`,
						error
					);
				}

				// Notifica o grupo de interação
				if (bot.grupoInteracao && !ignorar) {
					try {
						const sentMsg = await bot.sendMessage(bot.grupoInteracao, donationMsg, {
							marcarTodos: true
						});

						// Tenta fixar a mensagem
						try {
							if (sentMsg && sentMsg.pin) {
								await sentMsg.pin(pinDuration);
							}
						} catch (pinError) {
							this.logger.error("Erro ao fixar mensagem no grupoInteracao:", pinError);
						}
					} catch (error) {
						this.logger.error(
							`Erro ao enviar notificação de doação para grupoInteracao (${bot.grupoInteracao}):`,
							error
						);
					}
				}
			}
		} catch (error) {
			this.logger.error("Erro ao notificar grupos sobre doação:", error);
		}
	}

	/**
	 * Reloads webhooks from database to memory
	 */
	async reloadWebhooks() {
		if (!process.env.GROUP_WEBHOOKS) return;
		try {
			const groups = await this.database.getGroups();
			this.webhooksCache.clear();
			let count = 0;
			for (const group of groups) {
				if (group.webhooks && group.webhooks.length > 0) {
					this.webhooksCache.set(group.id, group.webhooks);
					count += group.webhooks.length;
				}
			}
			this.webhookLogger.info(`Loaded ${count} webhooks for ${this.webhooksCache.size} groups.`);
		} catch (error) {
			this.webhookLogger.error("Error reloading webhooks:", error);
		}
	}

	/**
	 * Starts the webhook server
	 */
	startWebhookServer() {
		if (!process.env.GROUP_WEBHOOKS) return;
		const port = process.env.GROUP_WEBHOOKS;
		if (!port) {
			this.webhookLogger.warn("GROUP_WEBHOOKS port not set. Webhook server disabled.");
			return;
		}

		this.webhookApp.use(bodyParser.json({ limit: "10mb" }));
		this.webhookApp.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

		this.webhookApp.post("/:botId/:groupId", async (req, res) => {
			const { botId, groupId } = req.params;
			const body = req.body;
			const headers = req.headers;

			// Add @g.us if missing (assuming it's a group)
			const fullGroupId = groupId.includes("@") ? groupId : `${groupId}@g.us`;

			// Find bot
			const bot = this.bots.find((b) => b.id === botId);
			if (!bot) {
				return res.status(404).send("Bot not found");
			}

			// Get webhooks for this group
			const webhooks = this.webhooksCache.get(fullGroupId);
			if (!webhooks || webhooks.length === 0) {
				return res.status(404).send("No webhooks configured for this group");
			}

			// Match webhook
			let matchedWebhook = null;
			for (const webhook of webhooks) {
				// Check if bot matches (optional in config, but good practice)
				if (webhook.botId && webhook.botId !== botId) continue;

				const headerName = webhook.header.name.toLowerCase();
				const headerValue = webhook.header.value;
				const receivedValue = headers[headerName];

				if (!receivedValue) continue;

				if (webhook.headerValue === "include") {
					if (receivedValue.includes(headerValue)) {
						matchedWebhook = webhook;
						break;
					}
				} else {
					if (receivedValue === headerValue) {
						matchedWebhook = webhook;
						break;
					}
				}
			}

			if (!matchedWebhook) {
				this.webhookLogger.warn(
					`Webhook received for ${botId}/${fullGroupId} but no header matched.`
				);
				return res.status(401).send("Unauthorized: Header mismatch");
			}

			// Generate Message
			let message = matchedWebhook.template;

			// Simple template replacement with dot notation support
			message = message.replace(/{{([^}]+)}}/g, (match, key) => {
				const keys = key.trim().split(".");
				let value = body;
				for (const k of keys) {
					value = value ? value[k] : undefined;
				}
				return value !== undefined ? value : match;
			});

			this.webhookLogger.info(
				`Webhook matched: ${matchedWebhook.name} for ${fullGroupId}. Msg: ${message}`
			);

			// Rate Limit & Sending
			this.handleWebhookMessage(bot, fullGroupId, message);

			res.send("ok");
		});

		try {
			this.webhookServer = this.webhookApp.listen(port, () => {
				this.webhookLogger.info(`Group Webhook Server listening on port ${port}`);
			});
		} catch (e) {
			this.webhookLogger.error("Failed to start webhook server:", e);
		}
	}

	handleWebhookMessage(bot, groupId, message) {
		const key = `${bot.id}:${groupId}`;
		let rateData = this.webhookRateLimits.get(key);

		if (!rateData) {
			rateData = { lastSent: 0, buffer: [], timeout: null };
			this.webhookRateLimits.set(key, rateData);
		}

		const now = Date.now();
		// If buffer is empty and cooldown passed, send immediately
		if (rateData.buffer.length === 0 && now - rateData.lastSent > WEBHOOK_RATE_LIMIT) {
			this.sendWebhookMessage(bot, groupId, message);
			rateData.lastSent = Date.now();
		} else {
			// Buffer it
			rateData.buffer.push(message);

			// Schedule flush if not already scheduled
			if (!rateData.timeout) {
				// Calculate time until next allowed send
				const timeToWait = Math.max(0, WEBHOOK_RATE_LIMIT - (now - rateData.lastSent));

				rateData.timeout = setTimeout(() => {
					this.flushWebhookBuffer(bot, groupId, key);
				}, timeToWait);

				this.webhookLogger.info(`Buffered webhook for ${groupId}. Flush in ${timeToWait}ms`);
			}
		}
	}

	async sendWebhookMessage(bot, groupId, message) {
		try {
			await bot.sendMessage(groupId, message);
		} catch (e) {
			this.webhookLogger.error(`Error sending webhook message to ${groupId}:`, e);
		}
	}

	flushWebhookBuffer(bot, groupId, key) {
		const rateData = this.webhookRateLimits.get(key);
		if (!rateData) return;

		if (rateData.buffer.length > 0) {
			const combinedMessage = rateData.buffer.join("\n\n");
			this.sendWebhookMessage(bot, groupId, combinedMessage);
			rateData.lastSent = Date.now();
			rateData.buffer = [];
		}

		rateData.timeout = null;
	}

	/**
	 * Limpa recursos antes de fechar
	 */
	destroy() {
		// Para a atualização periódica do cache
		if (this.cacheUpdateInterval) {
			clearInterval(this.cacheUpdateInterval);
			this.cacheUpdateInterval = null;
		}
		if (this.checkServicesInterval) {
			clearInterval(this.checkServicesInterval);
			this.checkServicesInterval = null;
		}
	}

	/**
	 * Inicia o servidor API
	 */
	async start() {
		await this.reloadWebhooks();
		this.startWebhookServer();

		return new Promise((resolve, reject) => {
			try {
				this.server = this.app.listen(this.port, () => {
					this.logger.info(`Servidor API escutando na porta ${this.port}`);

					// Realiza uma verificação inicial logo após iniciar
					this.checkServices();

					// Limpa o arquivo de motivo de indisponibilidade se ele existir
					const statusMotivoPath = path.join(__dirname, "../data/status_motivo.txt");
					fs.unlink(statusMotivoPath).catch(() => {});

					resolve();
				});
			} catch (error) {
				this.logger.error("Erro ao iniciar servidor API:", error);
				reject(error);
			}
		});
	}

	/**
	 * Para o servidor API
	 */
	stop() {
		return new Promise((resolve, reject) => {
			if (this.webhookServer) {
				try {
					this.webhookServer.close(() => {
						this.webhookLogger.info("Webhook Server stopped");
					});
				} catch (e) {}
			}

			if (!this.server) {
				resolve();
				return;
			}

			// Limpa recursos
			this.destroy();

			try {
				this.server.close(() => {
					this.logger.info("Servidor API parado");
					this.server = null;
					resolve();
				});
			} catch (error) {
				this.logger.error("Erro ao parar servidor API:", error);
				reject(error);
			}
		});
	}

	/**
	 * Adiciona uma instância de bot à API
	 * @param {WhatsAppBot} bot - A instância do bot a adicionar
	 */
	addBot(bot) {
		if (!this.bots.includes(bot)) {
			this.bots.push(bot);
		}
	}

	/**
	 * Remove uma instância de bot da API
	 * @param {WhatsAppBot} bot - A instância do bot a remover
	 */
	removeBot(bot) {
		const index = this.bots.indexOf(bot);
		if (index !== -1) {
			this.bots.splice(index, 1);
		}
	}
}

module.exports = BotAPI;
