// Carrega variáveis de ambiente do arquivo .env
require("dotenv").config();

const TelegramBot = require("./src/TelegramBot");
const WhatsAppBot = require("./src/WhatsAppBot");
const WhatsAppBotEvo = require("./src/WhatsAppBotEvo");
const WhatsAppBotEvoGo = require("./src/WhatsAppBotEvoGo");
const DiscordBot = require("./src/DiscordBot");

const EventHandler = require("./src/EventHandler");
const Logger = require("./src/utils/Logger");
const logCleaner = require("./src/utils/LogsCleaner");
const BotAPI = require("./src/BotAPI");
const Database = require("./src/utils/Database");
const StabilityMonitor = require("./src/services/StabilityMonitor");
const fs = require("fs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CurrencyConverter = require("./src/utils/CurrencyConverter");

/**
 * Exemplo de criação de múltiplas instâncias de bot
 */
async function main() {
	logCleaner.start();

	// Atualiza cotação do dólar na inicialização
	await CurrencyConverter.updateRate();

	const logger = new Logger("main");
	const botInstances = [];
	let botAPI;

	try {
		// Cria manipulador de eventos compartilhado com SingleTon do StabilityMonitor
		const eventHandler = EventHandler.getInstance();

		// Monitor de estabilidade também é compartilhado
		//const stabilityMonitor = new StabilityMonitor({instances: botInstances})

		// Configurações do puppeteer
		const chromePath = process.env.CHROME_PATH || "";
		const headlessMode = process.env.HEADLESS_MODE !== "false"; // Padrão: true

		const rBots = JSON.parse(fs.readFileSync("bots.json", "utf8")) || [];

		if (rBots.length == 0) {
			logger.info(`Nenhum bot definido no bots.json.`);
			return;
		} else {
			logger.info(`Inicializando ${rBots.length} bots...`);
		}

		// Carrega whitelist (Doadores + SuperAdmins)
		const database = Database.getInstance();
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
			if (rBot.useDiscord) {
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
					redisDB: redisDbAtual
				});

				redisDbAtual++;
				newRBot.initialize();
				await sleep(500);
			} else if (rBot.useTelegram) {
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
					webhookPort: rBot.webhookPort ?? 9001,

					// IDs dos canais para notificações - do .env
					grupoLogs: process.env.TELEGRAM_GRUPO_LOGS,
					grupoAvisos: process.env.TELEGRAM_GRUPO_AVISOS,
					notificarDonate: rBot.notificarDonate ?? false,

					// Configs de cache
					redisURL: process.env.CACHE_REDIS_URI,
					redisTTL: process.env.CACHE_REDIS_TTL,
					redisDB: redisDbAtual
				});

				redisDbAtual++;
				newRBot.initialize();
				await sleep(500);
			} else if (rBot.useEvoGo) {
				logger.info(`Inicializando '${rBot.nome}' como EvolutionAPI GO`);
				newRBot = new WhatsAppBotEvoGo({
					id: rBot.nome,
					evolutionInstanceApiKey: rBot.evolutionInstanceApiKey,
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

					// EvolutionAPI
					evoInstanceName: rBot.evoID ?? rBot.nome,
					evolutionWS: process.env.EVOLUTION_GO_WS,
					evolutionApiUrl: process.env.EVOLUTION_GO_API_URL,
					evolutionApiKey: process.env.EVOLUTION_GO_API_KEY,
					redisURL: process.env.CACHE_REDIS_URI,
					redisTTL: process.env.CACHE_REDIS_TTL,
					redisDB: redisDbAtual,
					useWebsocket: rBot.useWebsocket ?? process.env.EVOGO_USE_WEBSOCKET,
					webhookHost: process.env.EVOGO_WEBHOOK_HOST,
					webhookPort: rBot.webhookPort ?? process.env.EVOGO_WEBHOOK_PORT
				});

				redisDbAtual++;

				newRBot.initialize();
				await sleep(500);
			} else if (rBot.useEvo) {
				logger.info(`Inicializando '${rBot.nome}' como evolutionAPI`);
				newRBot = new WhatsAppBotEvo({
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

					// EvolutionAPI
					evoInstanceName: rBot.evoID ?? rBot.nome,
					evolutionWS: process.env.EVOLUTION_WS,
					evolutionApiUrl: process.env.EVOLUTION_API_URL,
					evolutionApiKey: process.env.EVOLUTION_API_KEY,
					redisURL: process.env.CACHE_REDIS_URI,
					redisTTL: process.env.CACHE_REDIS_TTL,
					redisDB: redisDbAtual,
					useWebsocket: rBot.useWebsocket ?? process.env.EVO_USE_WEBSOCKET,
					webhookHost: process.env.EVO_WEBHOOK_HOST,
					webhookPort: rBot.webhookPort ?? process.env.EVO_WEBHOOK_PORT
				});

				redisDbAtual++;

				newRBot.initialize();
				await sleep(500);
			} else {
				logger.info(
					`Inicializando '${rBot.nome}' como whatsapp-web.js | Path=${chromePath || "padrão"}, Headless=${headlessMode}`
				);
				newRBot = new WhatsAppBot({
					id: rBot.nome,
					banido: rBot.banido ?? false,
					phoneNumber: rBot.numero, // Número de telefone para solicitar código de pareamento
					supportMsg: rBot.msgSuporte ?? false,
					vip: rBot.vip ?? false,
					comunitario: rBot.comunitario ?? false,
					numeroResponsavel: rBot.numeroResponsavel ?? false,
					eventHandler,
					//stabilityMonitor: stabilityMonitor,
					prefix: rBot.customPrefix || process.env.DEFAULT_PREFIX || "!",
					otherBots: rBots.map((rB) => rB.numero),
					// Configurações de puppeteer
					puppeteerOptions: {
						executablePath: chromePath || undefined,
						args: [
							"--no-sandbox",
							"--disable-setuid-sandbox",
							"--disable-extensions",
							"--disable-gpu",
							"--disable-accelerated-2d-canvas",
							"--no-first-run",
							"--no-zygote",
							"--disable-dev-shm-usage",
							"--disable-session-crashed-bubble",
							"--start-maximized",
							"--disable-prompt-on-repost",
							"--disable-beforeunload",
							"--disable-features=InfiniteSessionRestore",
							`--window-name=${rBot.nome}`
						],
						headless: headlessMode
					},
					userAgent:
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
					ignorePV: rBot.ignorePV ?? false,
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
					linkAvisos: rBot.linkAvisos ?? process.env.LINK_GRUPO_AVISOS
				});
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

	// Manipula encerramento do programa - modificar para esta versão:
	process.on("SIGINT", async () => {
		logger.info("Desligando bots e servidor API (SIGINT)...");

		// Força a persistência de dados do banco de dados
		await Database.getInstance().forcePersist();

		// Para o servidor API primeiro
		await botAPI.stop();

		// Destrói todas as instâncias de bot com timeout
		const promises = [];
		for (const bot of botInstances) {
			promises.push(
				// Adiciona um timeout para garantir que o processo não fique preso indefinidamente
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
		logger.info("Todos os bots destruídos com sucesso. Encerrando...");

		process.exit(0);
	});

	process.on("SIGTERM", async () => {
		logger.info("Desligando bots e servidor API (SIGTERM)...");

		// Força a persistência de dados do banco de dados
		await Database.getInstance().forcePersist();

		// Para o servidor API primeiro
		await botAPI.stop();

		// Destrói todas as instâncias de bot com timeout
		const promises = [];
		for (const bot of botInstances) {
			promises.push(
				// Adiciona um timeout para garantir que o processo não fique preso indefinidamente
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
		logger.info("Todos os bots destruídos com sucesso. Encerrando...");

		process.exit(0);
	});

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
