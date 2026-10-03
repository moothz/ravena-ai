const express = require("express");
const compression = require("compression");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs").promises;
const axios = require("axios");

const Logger = require("./utils/Logger");
const Database = require("./utils/Database");
const ExternalAuthService = require("./services/ExternalAuthService");
const ServiceProviderService = require("./services/ServiceProviderService");
const WebManagement = require("./utils/WebManagement");

// Middlewares
const {
	getAdminSessionSecret,
	createAdminSessionToken,
	isValidAdminSession,
	getCookie,
	setAdminSessionCookie,
	clearAdminSessionCookie,
	isAdmin,
	createAuthenticateBasic,
	createAuthenticateUPS
} = require("./BotAPI/middleware/auth");
const { createRateLimiters } = require("./BotAPI/middleware/rateLimiters");
const {
	upload,
	uploadNsfw,
	uploadsDir,
	MAX_NSFW_FILE_SIZE
} = require("./BotAPI/middleware/upload");

// Serviços auxiliares
const {
	updateBotStatsCache,
	updatePublicCommandsCache,
	updateAnalyticsCache,
	filterAnalyticsData
} = require("./BotAPI/services/analyticsHelper");
const {
	startWebhookServer,
	handleWebhookMessage,
	sendWebhookMessage,
	flushWebhookBuffer
} = require("./BotAPI/services/webhookManager");

// Rotas modulares
const { registerIndexRoutes } = require("./BotAPI/routes/indexRoutes");
const { registerInstancesRoutes } = require("./BotAPI/routes/instancesRoutes");
const { registerManagementRoutes } = require("./BotAPI/routes/managementRoutes");
const { registerServicesRoutes } = require("./BotAPI/routes/servicesRoutes");
const { registerWebhooksRoutes } = require("./BotAPI/routes/webhooksRoutes");
const { registerFeaturesRoutes } = require("./BotAPI/routes/featuresRoutes");

/**
 * Servidor API para o ecossistema do bot WhatsApp Ravena
 *
 * Arquitetura Modular:
 * - src/BotAPI/middleware/auth.js: Autenticação de admin, sessão via cookie, Basic Auth e UPS Secret
 * - src/BotAPI/middleware/rateLimiters.js: Limitadores de taxa geral e restrito
 * - src/BotAPI/middleware/upload.js: Configuração de upload via Multer (geral e fotos NSFW)
 * - src/BotAPI/services/analyticsHelper.js: Agregação analítica, estatísticas e cache de comandos
 * - src/BotAPI/services/webhookManager.js: Servidor de webhooks de grupos e fila de bufferização
 * - src/BotAPI/routes/indexRoutes.js: Páginas HTML, Desktop OS, dashboards e rotas de utilidade
 * - src/BotAPI/routes/instancesRoutes.js: Gestão de bots, status runtime, QR code e PM2 logs
 * - src/BotAPI/routes/managementRoutes.js: Configuração de grupos, comandos customizados e agendamentos
 * - src/BotAPI/routes/servicesRoutes.js: Serviços de IA (STT, Imagine, TTS, Detecção NSFW, LLM)
 * - src/BotAPI/routes/webhooksRoutes.js: Webhooks de doação (Tipa.ai), telemetria UPS e Copa
 * - src/BotAPI/routes/featuresRoutes.js: Jogos e coleções (Pesca, Waifuletes e API de Analytics)
 */
class BotAPI {
	/**
	 * Cria um novo servidor API
	 * @param {Object} options - Opções de configuração
	 * @param {number} [options.port] - Porta para escutar
	 * @param {Array} [options.bots] - Array de instâncias de WhatsAppBot
	 * @param {Object} [options.eventHandler] - Instância do EventHandler
	 */
	constructor(options = {}) {
		this.port = options.port ?? process.env.API_PORT ?? 5000;
		this.bots = options.bots ?? [];
		this.eventHandler = options.eventHandler ?? false;
		this.logger = new Logger("bot-api");
		this.database = Database.getInstance();
		this.externalAuth = ExternalAuthService.getInstance();
		this.app = express();
		this.app.set("trust proxy", true);

		// Middleware de compressão (Gzip/Deflate) - pula SSE
		this.app.use(
			compression({
				filter: (req, res) => {
					if (req.headers.accept && req.headers.accept.includes("text/event-stream")) {
						return false;
					}
					return compression.filter(req, res);
				}
			})
		);

		// Injeta referência do botApi nos bots
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

		// Credenciais de autenticação
		this.apiUser = process.env.BOTAPI_USER ?? "admin";
		this.apiPassword = process.env.BOTAPI_PASSWORD ?? "senha12345";
		this.upsApiSecret = process.env.UPS_API_SECRET ?? false;

		// Middlewares de rate limiting e upload
		const { generalLimiter, strictLimiter } = createRateLimiters();
		this.generalLimiter = generalLimiter;
		this.strictLimiter = strictLimiter;

		this.upload = upload;
		this.uploadNsfw = uploadNsfw;
		this.uploadsDir = uploadsDir;
		this.MAX_NSFW_FILE_SIZE = MAX_NSFW_FILE_SIZE;

		// Estado da UPS
		this.lastUpsStatus = null;
		this.lastServicesStatus = null;
		this.upsTimeout = null;
		this.powerOutageNotified = false;
		this.powerOutageMinTime = (parseInt(process.env.POWER_OUTAGE_MIN_TIME) || 5) * 1000;

		// Cache analítico
		this.analyticsCache = {
			lastUpdate: 0,
			cacheTime: 10 * 60000,
			daily: {},
			weekly: {},
			monthly: {},
			yearly: {}
		};

		// Cache de estatísticas gerais dos bots
		this.botStatsCache = {
			lastUpdate: 0,
			cacheTime: 30 * 60000,
			data: []
		};

		// Cache para comandos públicos
		this.publicCommandsCache = null;
		this.publicCommandsLastUpdate = 0;

		this.isUpdatingAnalytics = false;
		this.isUpdatingBotStats = false;
		this.sseClients = [];

		if (this.eventHandler) {
			this.eventHandler.on("activity", (data) => {
				this.broadcastSSE("activity", data);
			});
		}

		// Middlewares de parsing de body
		this.app.use(bodyParser.json({ limit: "50mb" }));
		this.app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

		// Middlewares de autenticação vinculados à instância
		this.authenticateBasic = createAuthenticateBasic(this);
		this.authenticateUPS = createAuthenticateUPS(this);

		// Configura rotas divididas em módulos
		this.setupRoutes();

		this.serviceProviderService = ServiceProviderService.getInstance();
		this.sttJobs = new Map();

		// Carrega caches em segundo plano ao iniciar
		this.updateAnalyticsCache().catch((err) => {
			this.logger.error("Erro ao carregar analytics cache inicial:", err);
		});
		this.updateBotStatsCache().catch((err) => {
			this.logger.error("Erro ao carregar bot stats cache inicial:", err);
		});
		this.updatePublicCommandsCache();

		// Intervalos periódicos de atualização e limpeza
		this.cacheUpdateInterval = setInterval(() => {
			this.updateAnalyticsCache().catch((err) => {
				this.logger.error("Erro na atualização periódica de analytics cache:", err);
			});
			this.updatePublicCommandsCache();
		}, this.analyticsCache.cacheTime);

		this.botStatsUpdateInterval = setInterval(() => {
			this.updateBotStatsCache().catch((err) => {
				this.logger.error("Erro na atualização periódica de bot stats cache:", err);
			});
		}, this.botStatsCache.cacheTime);

		this.checkServicesInterval = setInterval(() => this.checkServices(), 30000);

		this.sttCleanupInterval = setInterval(() => {
			const now = Date.now();
			for (const [id, job] of this.sttJobs.entries()) {
				if (now - job.startTime > 3600000) {
					this.sttJobs.delete(id);
				}
			}
		}, 3600000);
	}

	/* ========================================================================== */
	/* CATÁLOGO E REGISTRO DE ROTAS DA BOTAPI                                     */
	/* ========================================================================== */

	/**
	 * Configura e monta todas as rotas da BotAPI divididas por responsabilidade funcional.
	 *
	 * MAPA DE ROTAS E ARQUIVOS CORRESPONDENTES:
	 *
	 * 1. PÁGINAS, OS E DASHBOARDS: src/BotAPI/routes/indexRoutes.js
	 *    - GET  /                                  -> Homepage Desktop OS (redireciona/serve UI)
	 *    - GET  /os, /os/*                         -> Interface Desktop OS
	 *    - GET  /classic, /legado                  -> Dashboard clássico/legado
	 *    - GET  /dashboard, /dashboard.html        -> Redirecionamento para /instances
	 *    - GET  /logout                            -> Limpeza de cookie de sessão de admin
	 *    - GET  /health                            -> Verificação de saúde em tempo real (RAM)
	 *    - GET  /502                               -> Tela de manutenção/status offline
	 *    - GET  /manage/:token                     -> Painel web de gerenciamento de grupo
	 *    - GET  /discord, /telegram                -> Redirecionamentos para convites sociais
	 *    - GET  /cmd                               -> Visualizador de comandos públicos
	 *    - GET  /docs, /api/docs                   -> Swagger/docs interativa de APIs
	 *    - GET  /ajuda                             -> Interface de chat de suporte Ravena
	 *    - GET  /stt, /transcrever                 -> Interface de transcrição de voz
	 *    - GET  /imagine                           -> Interface de geração de imagens
	 *    - GET  /tts, /falar                       -> Interface de síntese de voz TTS
	 *    - GET  /pesca, /fishing                   -> Interface do minigame de pesca
	 *    - GET  /waifuletes, /waifus               -> Atalho para aplicativo Waifuletes
	 *    - GET  /groups-dossier                    -> Visualizador de dossiês de grupos
	 *    - GET  /service-providers                 -> Painel de provedores de IA
	 *    - GET  /ciclo-ravena                      -> Guia de ciclo de vida da Ravena
	 *    - GET  /getData/:groupId/:variable        -> Leitura de variáveis públicas de grupo
	 *    - GET  /media-direct/:fileName            -> Servir mídias diretas autorizadas
	 *
	 * 2. INSTÂNCIAS E STATUS DE BOTS: src/BotAPI/routes/instancesRoutes.js
	 *    - GET  /api/stream                        -> SSE: Stream de eventos e status de serviços
	 *    - GET  /restart/:botId                    -> Reinicialização do bot (Basic Auth)
	 *    - GET  /logout/:botId                     -> Desconectar sessão do WhatsApp (Basic Auth)
	 *    - GET  /recreate/:botId                   -> Recriar instância na WhatsGoAPI (Basic Auth)
	 *    - POST /passkey/respond/:botId            -> Responder desafio de passkey
	 *    - POST /passkey/confirm/:botId            -> Confirmar pareamento de passkey
	 *    - GET  /api/bot-stats                     -> Estatísticas e métricas de todos os bots
	 *    - GET  /qrimg/:botId                      -> Imagem PNG do QR code do bot
	 *    - GET  /qrcode-status/:botId              -> Status de conexão do bot
	 *    - GET  /qrcode-initconnect/:botId         -> Iniciar conexão/pareamento
	 *    - GET  /qrcode-stream/:botId              -> SSE: Stream de QR code ao vivo
	 *    - GET  /qrcode/:botId                     -> Interface visual HTML de pareamento
	 *    - GET  /api/bots                          -> Lista instâncias do bots.json + runtime
	 *    - POST /api/bots                          -> Salvar e recarregar bots.json (Admin)
	 *    - GET  /api/logs                          -> SSE: Logs em tempo real do PM2 (Admin)
	 *
	 * 3. GERENCIAMENTO DE GRUPOS: src/BotAPI/routes/managementRoutes.js
	 *    - GET  /api/validate-token                -> Validação de token de gestão de grupo
	 *    - GET  /api/group                         -> Obter configurações do grupo por token
	 *    - POST /api/update-group                  -> Atualizar parâmetros do grupo
	 *    - POST /api/upload-media                  -> Upload de mídia para comandos customizados
	 *    - GET  /api/custom-commands/:groupId      -> Listar comandos customizados do grupo
	 *    - POST /api/custom-commands/:groupId      -> Criar/atualizar comando customizado
	 *    - DELETE /api/custom-commands/:groupId/:name -> Excluir comando customizado
	 *    - GET  /api/custom-commands/:groupId/export-zip -> Exportar comandos customizados (ZIP)
	 *    - POST /api/custom-commands/:groupId/import-zip -> Importar comandos customizados (ZIP)
	 *    - GET  /api/group/check-import-name       -> Checar unicidade de nome para importação
	 *    - GET  /api/group-schedules/:groupId      -> Listar agendamentos automáticos do grupo
	 *    - POST /api/group-schedules/:groupId      -> Criar agendamento automático
	 *    - PUT  /api/group-schedules/:groupId/:id  -> Atualizar agendamento existente
	 *    - DELETE /api/group-schedules/:groupId/:id -> Excluir agendamento
	 *    - GET  /api/groups-dossier                -> Listagem de dossiês de grupos
	 *    - GET  /api/group-dossier-history         -> Histórico de moderação do dossiê
	 *
	 * 4. SERVIÇOS DE IA E PROCESSAMENTO: src/BotAPI/routes/servicesRoutes.js
	 *    - POST /api/stt/transcrever               -> Iniciar transcrição de áudio (STT)
	 *    - GET  /api/stt/status/:jobId             -> Consultar progresso da transcrição
	 *    - POST /api/imagine/generate              -> Geração de imagem via IA
	 *    - POST /api/tts/generate                  -> Síntese de voz com F5-TTS
	 *    - GET  /api/services/status               -> Status operacional dos serviços externos
	 *    - POST /api/nsfw-detect                   -> Detecção de nudez/NSFW em imagens
	 *    - GET  /api/service-providers             -> Listar provedores de IA cadastrados
	 *    - POST /api/service-providers             -> Atualizar/cadastrar provedores de IA
	 *    - GET  /api/llm/queue                     -> Fila atual de prompts do LLM
	 *    - POST /api/llm/queue                     -> Adicionar requisição à fila de LLM
	 *    - GET  /api/llm/stats                     -> Métricas de uso de LLM
	 *    - GET  /llm-stats                         -> Relatório público de status do LLM
	 *    - POST /api/llm/report/send               -> Disparar envio de relatório de LLM
	 *    - GET  /api/public-commands               -> Lista estruturada de comandos públicos
	 *    - POST /api/ajuda/chat                    -> Resposta do assistente IA para suporte
	 *
	 * 5. WEBHOOKS E INTEGRAÇÕES EXTERNAS: src/BotAPI/routes/webhooksRoutes.js
	 *    - POST /donate_tipa                       -> Webhook de doação recebida do tipa.ai
	 *    - GET  /top-donates                       -> Top doadores históricos
	 *    - GET  /recent-top-donates                -> Top doadores recentes
	 *    - GET  /api/donates/detail/:name          -> Detalhes de doações de um usuário
	 *    - POST /UPS/powerChange                   -> Notificação de oscilação/queda de energia
	 *    - POST /UPS/powerCritical                 -> Notificação de bateria crítica
	 *    - GET  /getLoad                           -> Carga e telemetria atual do nobreak/UPS
	 *    - GET  /copa                              -> Tabela e dados da Copa do Mundo 2026
	 *
	 * 6. RECURSOS, JOGOS E ANALYTICS: src/BotAPI/routes/featuresRoutes.js
	 *    - GET  /api/fishing/legendary             -> Peixes lendários capturados no jogo de pesca
	 *    - GET  /api/fishing/image/:fileName       -> Servir imagem de peixe/pesca
	 *    - GET  /api/waifuletes/characters         -> Personagens do gacha Waifuletes
	 *    - GET  /api/waifuletes/group              -> Informações de harém do grupo no Waifuletes
	 *    - GET  /api/waifuletes/characters/:id     -> Detalhes de uma waifu/personagem
	 *    - GET  /api/waifuletes/media/*            -> Proxy reverso seguro de imagens do Waifuletes
	 *    - GET  /analytics                         -> Dashboard analítico com dados de uso do bot
	 */
	setupRoutes() {
		registerIndexRoutes(this);
		registerInstancesRoutes(this);
		registerManagementRoutes(this);
		registerServicesRoutes(this);
		registerWebhooksRoutes(this);
		registerFeaturesRoutes(this);
	}

	/* ========================================================================== */
	/* MÉTODOS DE SESSÃO E AUTENTICAÇÃO                                           */
	/* ========================================================================== */

	getAdminSessionSecret() {
		return getAdminSessionSecret(this);
	}

	createAdminSessionToken() {
		return createAdminSessionToken(this);
	}

	isValidAdminSession(token) {
		return isValidAdminSession(this, token);
	}

	getCookie(req, name) {
		return getCookie(req, name);
	}

	setAdminSessionCookie(res) {
		return setAdminSessionCookie(this, res);
	}

	clearAdminSessionCookie(res) {
		return clearAdminSessionCookie(res);
	}

	isAdmin(req) {
		return isAdmin(this, req);
	}

	async readWebManagementToken(token) {
		try {
			return await WebManagement.getInstance().getToken(token);
		} catch (error) {
			this.logger.error("Error reading web management token:", error);
			return null;
		}
	}

	/* ========================================================================== */
	/* TELEMETRIA, STATUS E SSE                                                   */
	/* ========================================================================== */

	/**
	 * Emite evento SSE para todos os clientes conectados
	 * @param {string} type - Tipo do evento
	 * @param {Object} data - Dados do evento
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

			const mainUp = await checkUrl(providers[0].url);
			if (mainUp) return "up";

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
		services.nudenet = await checkCategoryStatus("nudenet");

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

	/**
	 * Coleta status de telemetria e runtime dos bots ativos em memória
	 * @returns {Promise<Map<string, Object>>} Mapa de botId para status de runtime
	 */
	async getBotsRuntimeStatusMap() {
		const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
		let recentReports = [];
		try {
			recentReports = await this.database.getLoadReports(thirtyMinutesAgo);
		} catch (e) {
			this.logger.warn("Erro ao buscar load reports para runtime status:", e);
		}

		const botReports = {};
		if (recentReports && Array.isArray(recentReports)) {
			recentReports.forEach((report) => {
				if (!botReports[report.botId] || report.timestamp > botReports[report.botId].timestamp) {
					botReports[report.botId] = report;
				}
			});
		}

		let allGroups = [];
		try {
			allGroups = await this.database.getGroups();
		} catch (e) {
			this.logger.warn("Erro ao buscar grupos para runtime status:", e);
		}

		const groupsCountMap = {};
		if (Array.isArray(allGroups)) {
			allGroups.forEach((g) => {
				if (g && g.botId) {
					groupsCountMap[g.botId] = (groupsCountMap[g.botId] || 0) + 1;
				}
			});
		}

		const botGroupPromises = this.bots.map(async (bot) => {
			if (bot.isConnected && typeof bot.listGroups === "function") {
				try {
					const groups = await Promise.race([
						bot.listGroups(),
						new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1200))
					]);
					if (Array.isArray(groups)) {
						return { botId: bot.id, count: groups.length };
					}
				} catch (e) {
					// Fallback para o banco
				}
			}
			return { botId: bot.id, count: groupsCountMap[bot.id] || 0 };
		});

		const resolvedGroupCounts = await Promise.all(botGroupPromises);
		const finalGroupsCountMap = {};
		resolvedGroupCounts.forEach((item) => {
			finalGroupsCountMap[item.botId] = item.count;
		});

		const statusMap = new Map();
		this.bots.forEach((bot) => {
			const report = botReports[bot.id] ?? null;
			const msgsHr = report && report.messages ? (report.messages.messagesPerHour ?? 0) : 0;
			const avgResponseTime =
				report && report.responseTime ? (parseFloat(report.responseTime.average) ?? 0) : 0;
			const maxResponseTime = report && report.responseTime ? (report.responseTime.max ?? 0) : 0;

			statusMap.set(bot.id, {
				isLive: true,
				connected: Boolean(bot.isConnected),
				lastMessageReceived: bot.lastMessageReceived ?? null,
				msgsHr,
				responseTime: {
					avg: avgResponseTime,
					max: maxResponseTime
				},
				groupsCount:
					finalGroupsCountMap[bot.id] !== undefined
						? finalGroupsCountMap[bot.id]
						: groupsCountMap[bot.id] || 0
			});
		});

		return statusMap;
	}

	/* ========================================================================== */
	/* ANALYTICS E CACHE                                                          */
	/* ========================================================================== */

	async updateBotStatsCache() {
		return updateBotStatsCache(this);
	}

	async updateAnalyticsCache() {
		return updateAnalyticsCache(this);
	}

	updatePublicCommandsCache() {
		return updatePublicCommandsCache(this);
	}

	async filterAnalyticsData(options) {
		return filterAnalyticsData(this, options);
	}

	/* ========================================================================== */
	/* NOTIFICAÇÕES E WEBHOOKS                                                    */
	/* ========================================================================== */

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
	 * Notifica grupos sobre uma doação recebida
	 * @param {string} name - Nome do doador
	 * @param {number} amount - Valor da doação
	 * @param {string} message - Mensagem da doação
	 * @param {number} [donationTotal=0] - Total acumulado de doações
	 * @param {Object} [existingDonor=null] - Registro do doador
	 */
	async notifyGroupsAboutDonation(name, amount, message, donationTotal = 0, existingDonor = null) {
		try {
			const ignorar = message.includes("#ravprivate") ?? false;

			const totalMsg =
				donationTotal > 0
					? `> _${name}_ já doou um total de R$${donationTotal.toFixed(2)}\n\n`
					: "";

			let donationMsg =
				`💸 Recebemos um DONATE no tipa.ai! 🥳\n\n` +
				`*MUITO obrigado* pelos R$${amount.toFixed(2)}, ${name}! 🥰\n` +
				`Compartilho aqui com todos sua mensagem:\n` +
				`💬 ${message}\n\n${totalMsg}` +
				`\`\`\`!doar ou !donate pra conhecer os outros apoiadores e doar também\`\`\``;

			const donor = existingDonor || (await this.database.getDonorByName(name));
			const cleanNum = donor && donor.numero ? String(donor.numero).replace(/\D/g, "") : "";
			const hasNumber = cleanNum.length >= 8;

			if (!hasNumber) {
				donationMsg += `\n\n- ❗️ Ainda não tenho seu número salvo, me chama no grupão!`;
			}

			const extraPinTime = Math.floor(amount * 300);
			const pinDuration = 600 + extraPinTime;

			const bot =
				this.bots.find((b) => b.notificarDonate) ??
				this.bots[Math.floor(Math.random() * this.bots.length)];

			if (!bot) {
				this.logger.warn("Nenhum bot disponível para notificar doação.");
				return;
			}

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

			if (bot.grupoAnuncios && !ignorar) {
				try {
					await bot.sendMessage(bot.grupoAnuncios, donationMsg, { marcarTodos: true });
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

				if (bot.grupoInteracao && !ignorar) {
					try {
						const sentMsg = await bot.sendMessage(bot.grupoInteracao, donationMsg, {
							marcarTodos: true
						});

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

	startWebhookServer() {
		return startWebhookServer(this);
	}

	handleWebhookMessage(bot, groupId, message) {
		return handleWebhookMessage(this, bot, groupId, message);
	}

	async sendWebhookMessage(bot, groupId, message) {
		return sendWebhookMessage(this, bot, groupId, message);
	}

	flushWebhookBuffer(bot, groupId, key) {
		return flushWebhookBuffer(this, bot, groupId, key);
	}

	/* ========================================================================== */
	/* CICLO DE VIDA DO SERVIDOR                                                  */
	/* ========================================================================== */

	destroy() {
		if (this.cacheUpdateInterval) {
			clearInterval(this.cacheUpdateInterval);
			this.cacheUpdateInterval = null;
		}
		if (this.botStatsUpdateInterval) {
			clearInterval(this.botStatsUpdateInterval);
			this.botStatsUpdateInterval = null;
		}
		if (this.checkServicesInterval) {
			clearInterval(this.checkServicesInterval);
			this.checkServicesInterval = null;
		}
		if (this.sttCleanupInterval) {
			clearInterval(this.sttCleanupInterval);
			this.sttCleanupInterval = null;
		}
	}

	async start() {
		await this.reloadWebhooks();
		this.startWebhookServer();

		return new Promise((resolve, reject) => {
			try {
				this.server = this.app.listen(this.port, () => {
					this.logger.info(`Servidor API escutando na porta ${this.port}`);

					if (this.server) {
						this.server.keepAliveTimeout = 65000;
						this.server.headersTimeout = 66000;
					}

					this.checkServices();

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

	addBot(bot) {
		if (!this.bots.includes(bot)) {
			this.bots.push(bot);
		}
	}

	removeBot(bot) {
		const index = this.bots.indexOf(bot);
		if (index !== -1) {
			this.bots.splice(index, 1);
		}
	}
}

module.exports = BotAPI;
