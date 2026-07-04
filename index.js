// Carrega variáveis de ambiente do arquivo .env
require("dotenv").config();

const TelegramBot = require("./src/TelegramBot");
const WhatsAppBotGo = require("./src/WhatsAppBotGo");
const DiscordBot = require("./src/DiscordBot");

const EventHandler = require("./src/EventHandler");
const Logger = require("./src/utils/Logger");
const logCleaner = require("./src/utils/LogsCleaner");
const ytdlUpdater = require("./src/utils/YtdlUpdater");

const BotAPI = require("./src/BotAPI");
const Database = require("./src/utils/Database");
const minioSetup = require("./src/utils/MinioSetup");
const StabilityMonitor = require("./src/services/StabilityMonitor");
const fs = require("fs");
const crypto = require("crypto");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CurrencyConverter = require("./src/utils/CurrencyConverter");

/**
 * Exemplo de criação de múltiplas instâncias de bot
 */
async function main() {
	logCleaner.start();
	ytdlUpdater.start();

	// Configura políticas de retenção do MinIO (Background)
	minioSetup.init().catch((err) => console.error("[MinioSetup Error]", err));

	// Atualiza cotação do dólar na inicialização
	await CurrencyConverter.updateRate();

	const logger = new Logger("main");
	const botInstances = [];
	let botAPI;

	try {
		const disableActivity = process.env.DISABLE_ACTIVITY === "true";
		if (disableActivity) {
			logger.warn(
				"!!! ATENÇÃO: DISABLE_ACTIVITY=true. Atividade do bot suspensa. Apenas API ativa."
			);
		}

		// Cria manipulador de eventos compartilhado com SingleTon do StabilityMonitor
		const eventHandler = disableActivity ? null : EventHandler.getInstance();

		// Monitor de estabilidade também é compartilhado
		//const stabilityMonitor = new StabilityMonitor({instances: botInstances})

		const rBots = JSON.parse(fs.readFileSync("bots.json", "utf8")) || [];

		if (rBots.length == 0) {
			logger.info(`Nenhum bot definido no bots.json.`);
			return;
		} else {
			logger.info(`Inicializando ${rBots.length} bots...`);
		}

		// Carrega whitelist (Doadores + SuperAdmins)
		const database = Database.getInstance({ disableBackup: disableActivity });
		const donations = await database.getDonations();
		const superAdmins = (process.env.SUPER_ADMINS || "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

		const whitelistSet = new Set();

		// Add super admins
		superAdmins.forEach((admin) => whitelistSet.add(admin.replace(/\D/g, "")));

		// Add donors
		donations.forEach((donor) => {
			if (donor.numero) {
				whitelistSet.add(donor.numero.replace(/\D/g, ""));
			}
		});

		const whitelistArray = Array.from(whitelistSet);
		logger.info(`Whitelist global carregada com ${whitelistArray.length} números.`);

		let redisDbAtual = 0;
		for (const rBot of rBots) {
			if (!rBot.enabled) continue;

			let newRBot;
			if (rBot.useTelegram) {
				logger.info(`Inicializando '${rBot.nome}' como Telegram Bot`);
				newRBot = new TelegramBot({
					id: rBot.nome,
					telegramBotName: rBot.telegramBotName,
					telegramBotToken: rBot.telegramBotToken,
					telegramBotId: rBot.telegramBotId,
					eventHandler,
					prefix: rBot.customPrefix || process.env.DEFAULT_PREFIX || "/",
					ignorePV: rBot.ignorePV ?? false,
					pvAI: rBot.pvAI ?? false,
					managementUser: rBot.managementUser ?? process.env.BOTAPI_USER,
					managementPW: rBot.managementPW ?? process.env.BOTAPI_PASSWORD,

					webhookHost: rBot.webhookHost ?? false,
					webhookPort: process.env.TELEGRAM_WEBHOOK_PORT ?? 9005,

					// IDs dos canais para notificações - do .env
					grupoLogs: process.env.TELEGRAM_GRUPO_LOGS,
					grupoAvisos: process.env.TELEGRAM_GRUPO_AVISOS,
					notificarDonate: rBot.notificarDonate ?? false,

					// Configs de cache
					redisURL: process.env.CACHE_REDIS_URI,
					redisTTL: process.env.CACHE_REDIS_TTL,
					redisDB: redisDbAtual,

					// Novas propriedades
					updateStatus: rBot.updateStatus ?? true,
					aiPersonality: rBot.aiPersonality ?? "",
					nomeExibir: rBot.nomeExibir,
					sendJoinInfo: rBot.sendJoinInfo
				});

				redisDbAtual++;
				newRBot.initialize();
				await sleep(500);
			} else if (rBot.useDiscord) {
				logger.info(`Inicializando '${rBot.nome}' como Discord Bot`);
				newRBot = new DiscordBot({
					id: rBot.nome,
					useDiscord: true,
					discordToken: rBot.discordToken,
					eventHandler,
					prefix: rBot.customPrefix || process.env.DEFAULT_PREFIX || "!",
					ignorePV: rBot.ignorePV ?? false,
					pvAI: rBot.pvAI ?? false,
					managementUser: rBot.managementUser ?? process.env.BOTAPI_USER,
					managementPW: rBot.managementPW ?? process.env.BOTAPI_PASSWORD,

					// IDs dos canais para notificações - do .env
					grupoLogs: process.env.GRUPO_LOGS_DISCORD,
					grupoAvisos: process.env.GRUPO_AVISOS_DISCORD,
					notificarDonate: rBot.notificarDonate ?? false,

					// Configs de cache
					redisURL: process.env.CACHE_REDIS_URI,
					redisTTL: process.env.CACHE_REDIS_TTL,
					redisDB: redisDbAtual,

					// Novas propriedades
					updateStatus: rBot.updateStatus ?? true,
					aiPersonality: rBot.aiPersonality ?? "",
					nomeExibir: rBot.nomeExibir,
					sendJoinInfo: rBot.sendJoinInfo
				});

				redisDbAtual++;
				newRBot.initialize();
				await sleep(500);
			} else {
				if (!rBot.nome) {
					logger.debug(`Problema em bot GO`, { rBot });
					continue;
				}
				logger.info(`Inicializando '${rBot.nome}' como GO`);
				newRBot = new WhatsAppBotGo({
					id: rBot.nome,
					banido: rBot.banido ?? false,
					vip: rBot.vip ?? false,
					comunitario: rBot.comunitario ?? false,
					numeroResponsavel: rBot.numeroResponsavel ?? false,
					phoneNumber: rBot.numero, // Número de telefone para solicitar código de pareamento
					supportMsg: rBot.msgSuporte ?? false,
					privado: rBot.privado, // Número de telefone para solicitar código de pareamento
					eventHandler,
					//stabilityMonitor: stabilityMonitor,
					prefix: rBot.customPrefix || process.env.DEFAULT_PREFIX || "!",
					otherBots: rBots.map((rB) => rB.numero),
					userAgent:
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
					ignorePV: rBot.ignorePV ?? false,
					autoDownloadPV: rBot.autoDownloadPV ?? false,
					whitelistPV: whitelistArray,
					pvAI: rBot.pvAI ?? false,
					ignoreInvites: rBot.ignoreInvites ?? false,
					managementUser: rBot.managementUser ?? process.env.BOTAPI_USER,
					managementPW: rBot.managementPW ?? process.env.BOTAPI_PASSWORD,

					// IDs dos grupos para notificações da comunidade
					grupoEstabilidade: rBot.grupoEstabilidade ?? process.env.GRUPO_ESTABILIDADE,
					grupoLogs: rBot.grupoLogs ?? process.env.GRUPO_LOGS,
					grupoInvites: rBot.grupoInvites ?? process.env.GRUPO_INVITES,
					grupoAvisos: rBot.grupoAvisos ?? process.env.GRUPO_AVISOS,
					grupoAnuncios: rBot.grupoAnuncios ?? process.env.GRUPO_ANUNCIOS,
					grupoInteracao: rBot.grupoInteracao ?? process.env.GRUPO_INTERACAO,
					linkGrupao: rBot.linkGrupao ?? process.env.LINK_GRUPO_INTERACAO,
					linkAvisos: rBot.linkAvisos ?? process.env.LINK_GRUPO_AVISOS,
					notificarDonate: rBot.notificarDonate ?? false, // Apenas um dos bots deve notificar donate

					// WhatsgoAPI
					goInstanceName: rBot.goID ?? rBot.nome,
					whatsgoApiUrl: process.env.WHATS_GO_API_URL,
					whatsgoApiKey: process.env.WHATS_GO_API_KEY,
					redisURL: process.env.CACHE_REDIS_URI,
					redisTTL: process.env.CACHE_REDIS_TTL,
					redisDB: redisDbAtual,
					webhookHost: process.env.WHATSGO_WEBHOOK_HOST,
					webhookPort: rBot.webhookPort ?? process.env.WHATSGO_WEBHOOK_PORT,

					// Novas propriedades
					updateStatus: rBot.updateStatus ?? true,
					aiPersonality: rBot.aiPersonality ?? "",
					nomeExibir: rBot.nomeExibir,
					sendJoinInfo: rBot.sendJoinInfo
				});

				redisDbAtual++;

				newRBot.initialize();
				await sleep(500);
			}

			botInstances.push(newRBot);
		}

		logger.info("Todos os bots inicializados e rodando");

		// Inicializa servidor da API
		botAPI = new BotAPI({
			port: process.env.API_PORT || 5000,
			bots: botInstances,
			eventHandler
		});

		// Inicia servidor da API
		await botAPI.start();
		logger.info("Servidor API iniciado");
	} catch (error) {
		logger.error("Erro no processo principal:", error);
		process.exit(1);
	}

	// Manipula encerramento do programa sequencialmente para evitar corrupção de arquivos
	const shutdown = async (signal) => {
		logger.info(`Desligando bots e servidor API (${signal})...`);

		// 1. Para o servidor API primeiro para não aceitar novas conexões
		if (botAPI) {
			try {
				await botAPI.stop();
			} catch (e) {
				logger.error("Erro ao parar servidor API:", e);
			}
		}

		// 2. Destrói todas as instâncias de bot com timeout
		const promises = [];
		for (const bot of botInstances) {
			promises.push(
				Promise.race([
					bot.destroy(),
					new Promise((resolve) =>
						setTimeout(() => {
							logger.warn(`Timeout ao destruir bot ${bot.id}`);
							resolve();
						}, 5000)
					)
				])
			);
		}

		await Promise.all(promises);
		logger.info("Todos os bots destruídos com sucesso.");

		// 3. Força a persistência e fecha todas as conexões SQLite de forma síncrona
		logger.info("Fechando conexões de banco de dados e gravando alterações pendentes...");
		try {
			await Database.getInstance().flushAllToDisk();
		} catch (e) {
			logger.error("Erro ao salvar bancos de dados:", e);
		}

		try {
			Database.getInstance().closeAll();
		} catch (e) {
			logger.error("Erro ao fechar conexões de bancos de dados:", e);
		}

		logger.info("Encerramento limpo concluído. Encerrando processo.");
		process.exit(0);
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	process.on("unhandledRejection", (reason, p) => {
		logger.warn("---- Rejection não tratada ");
		logger.warn(p);
		logger.warn(reason.stack);
		logger.warn("---- Fim ");
	});

	process.on("uncaughtException", (err) => {
		logger.error("---- Erro Não tratado ");
		logger.error(err.stack);
		logger.error("---- Fim ");
	});
}

// Executa a função principal
main().catch(console.error);
