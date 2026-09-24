const Database = require("../utils/Database");
const Logger = require("../utils/Logger");

const logger = new Logger("raffle-monitor");
const database = Database.getInstance();
const DB_NAME = "raffles";
const CACHE_DB_NAME = "raffle_cache";

// Intervalo padrão de 10 minutos (pode ser sobrescrito por variável de ambiente)
const RAFFLE_POLL_INTERVAL_MS = process.env.RAFFLE_POLL_INTERVAL_MS
	? parseInt(process.env.RAFFLE_POLL_INTERVAL_MS, 10)
	: 10 * 60 * 1000;

// Metas percentuais de vendas para notificação
const MILESTONES = [10, 15, 25, 50, 75, 90, 99, 100];

// Banco com 10 frases criativas para cada porcentagem
const MILESTONE_PHRASES = {
	10: [
		"A rifa já bateu 10% das vendas! Vamo pra frente galera 🚀",
		"Primeira meta batida! 10% das cotas já foram vendidas! 🎯",
		"O pontapé inicial foi dado: 10% das cotas garantidas! Bora acelerar! 🔥",
		"10% VENDIDO! A ação tá começando com força total! ⚡",
		"Primeiros 10% concluídos! Quem vai garantir a cota premiada? 🍀",
		"Já chegamos em 10% das vendas! O trem já partiu da estação! 🚂",
		"10% das cotas já têm dono! Não vai ficar de fora, hein! 👀",
		"A rifa tá esquentando! Batemos 10% das vendas! Bora pra próxima meta! 💪",
		"10% das cotas vendidas! O sorteio começa a ganhar forma! 🎟️",
		"Meta de 10% alcançada com sucesso! Vamos que vamos rumo ao topo! 📈"
	],
	15: [
		"Atenção: 15% das vendas concluídas! A galera tá garantindo as cotas! 💥",
		"15% das cotas já foram embora! O ritmo tá esquentando! 🔥",
		"Passamos dos 15%! Cada vez mais perto do grande dia! ⏰",
		"15% VENDIDO! Quem pegou, pegou; quem não pegou, ainda dá tempo! 🏃💨",
		"Mais um degrau superado: 15% das cotas vendidas! 🚀",
		"15% da ação já foi arrematada! A sorte tá rondando por aqui! 🍀",
		"Subindo rápido: já batemos 15% das vendas! Bora pro próximo nível! 🎯",
		"15% das cotas reservadas e pagas! O movimento tá a mil! ⚡",
		"A rifa tá andando forte! 15% das cotas já voaram! 🦅",
		"Batemos a marca de 15%! Parabéns a quem já garantiu seus números! 👏"
	],
	25: [
		"1/4 DA RIFA CONCLUÍDO! Já batemos 25% das cotas vendidas! 🎊",
		"25% DAS COTAS VENDIDAS! Um quarto da ação já foi garantido! 🚀",
		"Primeiro quarto já era: 25% vendido! A rifa tá voando! ✈️",
		"Batemos 25%! O sorteio tá cada vez mais perto da realidade! 🎲",
		"25% da rifa já tem dono! Já conferiu se comprou sua cota da sorte? 🤞",
		"Marca histórica de 25% batida! Vamos com tudo pro segundo quarto! 💥",
		"25% VENDIDO! O ritmo de vendas não para de crescer! 📈",
		"Um quarto das cotas já foi! A contagem regressiva começou a tomar corpo! ⏳",
		"25% concluído! A cada número vendido, um sortudo fica mais perto do prêmio! 🎁",
		"25% das cotas garantidas! Rumo à metade da ação! Vamo pra cima! 👊"
	],
	50: [
		"METADE DA RIFA VENDIDA! 50% das cotas já foram arrematadas! 🏁",
		"MEIO CAMINHO ANDADO! Batemos 50% das vendas! A sorte tá no ar! 🍀",
		"50% VENDIDO! Agora falta menos do que já foi! Quem vai levar esse prêmio? 🏆",
		"Batemos a marca dos 50%! Metade dos bilhetes já têm donos! Bora pra reta final! 🔥",
		"50% das cotas concluídas! O sorteio tá ficando cada vez mais perto! ⏱️",
		"Metadinha garantida: 50% vendido! Se você ainda não garantiu seu número, corre! 🏃",
		"50% DA AÇÃO VENDIDA! A disputa pelos bilhetes premiados tá acirrada! ⚡",
		"Chegamos nos 50%! O copo já tá meio cheio rumo ao sorteio! 🍹",
		"50% de vendas alcançado! Agradecimento a todos que estão participando! 🙏",
		"METADE CONCLUÍDA! 50% das cotas foram vendidas! Agora é ladeira abaixo pro sorteio! 🎢"
	],
	75: [
		"RETA FINAL! 75% da rifa já foi vendida! Falta muito pouco! 🚨",
		"3/4 DA AÇÃO CONCLUÍDA! 75% das cotas já têm dono! Não durma no ponto! ⚠️",
		"Batemos 75% das vendas! A contagem regressiva começou pra valer! ⏳",
		"75% VENDIDO! Restam apenas 25% das cotas disponíveis! Corre pra garantir! 🏃‍♂️💨",
		"Último quarto da rifa começando: 75% batido! O prêmio tá quase saindo! 🎁",
		"75% das cotas já eram! Quem garantiu tá no páreo, quem não garantiu tá ficando pra trás! 🏇",
		"MARCA DE 75% ATINGIDA! A ansiedade pelo sorteio só aumenta! 🤩",
		"75% vendido com sucesso! As chances tão se afunilando, não fique de fora! 🎯",
		"75% da ação arrematada! A qualquer momento o sorteio pode ser marcado! 📅",
		"Apenas um quarto restante: 75% vendido! Garanta seus números antes que esgote! 💸"
	],
	90: [
		"ÚLTIMA CHAMADA! 90% das cotas foram vendidas! Tá acabando! 📢",
		"90% VENDIDO! Restam apenas 10% das cotas! É agora ou nunca! 🚨",
		"Batemos 90%! A rifa está prestes a fechar! Não perca sua chance! ⌛",
		"90% DAS COTAS GARANTIDAS! O sorteio tá virando a esquina! 🏁",
		"Reta finalíssima: 90% vendido! Os últimos números da sorte estão na mesa! 🍀",
		"90% da ação concluída! Quem não pegou cota, corre que vai zerar! 🏃‍♂️",
		"Quase tudo esgotado: 90% vendido! Preparem seus bilhetes! 🎟️",
		"Batemos a impressionante marca de 90%! Parabéns a todos, falta um sopro! 🌬️",
		"90% de cotas vendidas! O grande ganhador pode ser um dos últimos a comprar! 🥇",
		"90% VENDIDO! Últimos bilhetes disponíveis! Não fique chupando o dedo! 🤞"
	],
	99: [
		"PENÚLTIMA COTA! 99% VENDIDO! Vai fechar a qualquer instante! 💥",
		"99% DAS COTAS VENDIDAS! ÚLTIMOS NÚMEROS! Quem pegou pegou! 🏃💨",
		"ALERTA MÁXIMO: 99% VENDIDO! A rifa está praticamente esgotada! 🚨",
		"Falta só 1%! 99% das cotas já foram vendidas! O sorteio é logo ali! ⏰",
		"99% CONCLUÍDO! Últimas cotas restantes no sistema! Garanta a saideira! 🍺",
		"Batemos 99%! A rifa vai fechar a qualquer segundo! Emoção pura! 💓",
		"99% VENDIDO! Tá no apagar das luzes! Quem será que leva essa bolada? 💰",
		"Atenção: 99% das cotas adquiridas! O sorteio está iminente! 🎯",
		"99% DAS COTAS VENDIDAS! É a raspadinha final! Corre pro site! 🌐",
		"99% VENDIDO! Se piscar, acaba! Boa sorte a todos os participantes! 🍀"
	],
	100: [
		"100% ESGOTADO! TODAS AS COTAS FORAM VENDIDAS! Boa sorte a todos! 🎉",
		"RIFA FINALIZADA! 100% das cotas vendidas com sucesso! Que venha o sorteio! 🏆",
		"ACABOU! 100% VENDIDO! Ação completamente esgotada! Parabéns a todos! 🎊",
		"META MÁXIMA ATINGIDA: 100% VENDIDO! Agora é cruzar os dedos e aguardar o sorteio! 🤞",
		"SOLD OUT! 100% das cotas foram garantidas! O ganhador já está entre nós! 🥇",
		"100% CONCLUÍDO! Rifa encerrada com sucesso total! Boa sorte a quem participou! 🍀",
		"TUDO VENDIDO! 100% das cotas esgotadas! Que rufem os tambores para o sorteio! 🥁",
		"100% DAS COTAS VENDIDAS! Obrigado a todos pela confiança e participação! 🙏",
		"A rifa bateu 100%! Bilheteria fechada! Aguardem a extração dos números premiados! 🎫",
		"100% ESGOTADO! Todos os bilhetes foram comprados! O grande momento tá chegando! ✨"
	]
};

class RaffleMonitor {
	static instance = null;

	constructor() {
		if (RaffleMonitor.instance) {
			return RaffleMonitor.instance;
		}

		this.logger = logger;
		this.database = database;
		this.pollIntervalMs = RAFFLE_POLL_INTERVAL_MS;
		this.activeTimers = new Map(); // url -> intervalId
		this.defaultBot = null;
		this.initialized = false;

		RaffleMonitor.instance = this;
	}

	static getInstance() {
		if (!RaffleMonitor.instance) {
			RaffleMonitor.instance = new RaffleMonitor();
		}
		return RaffleMonitor.instance;
	}

	/**
	 * Inicializa o esquema de tabelas SQLite e retoma o monitoramento de rifas ativas.
	 * @param {Object} [bot=null] - Instância de bot opcional para envio
	 */
	async init(bot = null) {
		if (bot) {
			this.defaultBot = bot;
		}

		try {
			// Criação das tabelas no raffles.db
			await this.database.getSQLiteDb(
				DB_NAME,
				`
				CREATE TABLE IF NOT EXISTS raffle_follows (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					group_id TEXT NOT NULL,
					url TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					created_by TEXT NOT NULL,
					bot_id TEXT,
					active INTEGER DEFAULT 1,
					UNIQUE(group_id, url)
				);
				CREATE INDEX IF NOT EXISTS idx_raffle_follows_url ON raffle_follows(url, active);
				CREATE INDEX IF NOT EXISTS idx_raffle_follows_group ON raffle_follows(group_id, active);

				CREATE TABLE IF NOT EXISTS raffle_notifications (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					group_id TEXT NOT NULL,
					url TEXT NOT NULL,
					milestone INTEGER NOT NULL,
					notified_at INTEGER NOT NULL,
					UNIQUE(group_id, url, milestone)
				);
				CREATE INDEX IF NOT EXISTS idx_raffle_notif_lookup ON raffle_notifications(group_id, url, milestone);
				`
			);

			// Carrega todas as URLs ativas e inicia os timers necessários
			const activeUrls = await this.database.dbAll(
				DB_NAME,
				`SELECT DISTINCT url FROM raffle_follows WHERE active = 1`
			);

			if (activeUrls && activeUrls.length > 0) {
				this.logger.info(
					`[RaffleMonitor] Retomando monitoramento de ${activeUrls.length} rifas ativas.`
				);
				for (const row of activeUrls) {
					this.startMonitoringUrl(row.url);
				}
			}

			this.initialized = true;
			this.logger.info("[RaffleMonitor] Serviço de monitoramento de rifas pronto.");
		} catch (error) {
			this.logger.error("[RaffleMonitor] Erro ao inicializar:", error.message ?? error);
		}
	}

	/**
	 * Verifica se uma URL de rifa é seguida por algum grupo ativo.
	 * @param {string} url - URL da rifa
	 * @returns {Promise<boolean>}
	 */
	async isFollowed(url) {
		try {
			const row = await this.database.dbGet(
				DB_NAME,
				`SELECT COUNT(*) as count FROM raffle_follows WHERE url = ? AND active = 1`,
				[url]
			);
			return Boolean(row && row.count > 0);
		} catch (error) {
			this.logger.error(`[RaffleMonitor] Erro em isFollowed(${url}):`, error.message ?? error);
			return false;
		}
	}

	/**
	 * Registra um grupo como seguidor de uma rifa.
	 * Inicializa o baseline de metas já alcançadas para não gerar spam de notificações antigas.
	 *
	 * @param {string} url - URL da rifa
	 * @param {string} groupId - JID do grupo
	 * @param {string} userId - JID do autor que solicitou
	 * @param {string} botId - ID do bot responsável
	 * @param {number} currentPercent - Porcentagem atual de vendas no momento do follow
	 */
	async followRaffle(url, groupId, userId, botId, currentPercent = 0) {
		const now = Date.now();

		// Insere ou reativa o follow no banco
		await this.database.dbRun(
			DB_NAME,
			`INSERT INTO raffle_follows (group_id, url, created_at, created_by, bot_id, active)
			 VALUES (?, ?, ?, ?, ?, 1)
			 ON CONFLICT(group_id, url) DO UPDATE SET
				active = 1,
				created_at = excluded.created_at,
				created_by = excluded.created_by,
				bot_id = excluded.bot_id`,
			[groupId, url, now, userId, botId]
		);

		// Baseline: Marca no banco todas as metas menores ou iguais à porcentagem atual como já notificadas
		for (const milestone of MILESTONES) {
			if (currentPercent >= milestone) {
				await this.database.dbRun(
					DB_NAME,
					`INSERT OR IGNORE INTO raffle_notifications (group_id, url, milestone, notified_at)
					 VALUES (?, ?, ?, ?)`,
					[groupId, url, milestone, now]
				);
			}
		}

		// Inicia ou reaproveita o timer para a URL
		this.startMonitoringUrl(url);

		this.logger.info(
			`[RaffleMonitor] Grupo ${groupId} começou a seguir ${url} (Meta atual: ${currentPercent}%).`
		);
	}

	/**
	 * Remove o monitoramento da rifa para um grupo.
	 * Se nenhum outro grupo seguir a URL, cancela o timer.
	 *
	 * @param {string} url - URL da rifa
	 * @param {string} groupId - JID do grupo
	 * @returns {Promise<boolean>} Retorna true se encontrou e cancelou o follow
	 */
	async unfollowRaffle(url, groupId) {
		const result = await this.database.dbRun(
			DB_NAME,
			`UPDATE raffle_follows SET active = 0 WHERE group_id = ? AND url = ? AND active = 1`,
			[groupId, url]
		);

		const wasActive = result && result.changes > 0;

		// Verifica se ainda há outros grupos ativos seguindo essa mesma URL
		const stillFollowed = await this.isFollowed(url);
		if (!stillFollowed) {
			this.stopMonitoringUrl(url);
			this.logger.info(
				`[RaffleMonitor] Nenhum grupo mais segue ${url}. Interval de busca encerrado.`
			);
		}

		return wasActive;
	}

	/**
	 * Lista todas as rifas ativas sendo seguidas por um grupo.
	 * @param {string} groupId - JID do grupo
	 * @returns {Promise<Array>}
	 */
	async listFollowed(groupId) {
		try {
			const rows = await this.database.dbAll(
				DB_NAME,
				`SELECT id, group_id, url, created_at, created_by, bot_id
				 FROM raffle_follows
				 WHERE group_id = ? AND active = 1
				 ORDER BY created_at DESC`,
				[groupId]
			);
			if (!rows || rows.length === 0) return [];

			for (const row of rows) {
				const cacheRow = await this.database.dbGet(
					CACHE_DB_NAME,
					`SELECT title, price, total_nums, available_nums, updated_at FROM raffle_cache WHERE url = ?`,
					[row.url]
				);
				if (cacheRow) {
					row.title = cacheRow.title;
					row.price = cacheRow.price;
					row.total_nums = cacheRow.total_nums;
					row.available_nums = cacheRow.available_nums;
					row.updated_at = cacheRow.updated_at;
				}
			}

			return rows;
		} catch (error) {
			this.logger.error(
				`[RaffleMonitor] Erro em listFollowed(${groupId}):`,
				error.message ?? error
			);
			return [];
		}
	}

	/**
	 * Inicia o interval de busca periódica para uma URL específica (reaproveitando se já existir).
	 * @param {string} url - URL da rifa
	 */
	startMonitoringUrl(url) {
		if (this.activeTimers.has(url)) {
			this.logger.debug(
				`[RaffleMonitor] Interval para ${url} já está ativo. Reaproveitando existente.`
			);
			return;
		}

		this.logger.info(
			`[RaffleMonitor] Iniciando novo interval (${this.pollIntervalMs}ms) para ${url}`
		);

		const timerId = setInterval(async () => {
			try {
				await this.checkRaffleMilestones(url);
			} catch (err) {
				this.logger.error(
					`[RaffleMonitor] Erro durante execução do timer para ${url}:`,
					err.message ?? err
				);
			}
		}, this.pollIntervalMs);

		this.activeTimers.set(url, timerId);
	}

	/**
	 * Para o interval de busca de uma URL.
	 * @param {string} url - URL da rifa
	 */
	stopMonitoringUrl(url) {
		if (this.activeTimers.has(url)) {
			clearInterval(this.activeTimers.get(url));
			this.activeTimers.delete(url);
			this.logger.debug(`[RaffleMonitor] Interval parado para ${url}`);
		}
	}

	/**
	 * Para todos os intervals ativos (para testes e encerramento limpo).
	 */
	stopAll() {
		for (const [url, timerId] of this.activeTimers.entries()) {
			clearInterval(timerId);
			this.logger.debug(`[RaffleMonitor] Parando interval de ${url}`);
		}
		this.activeTimers.clear();
	}

	/**
	 * Seleciona uma frase aleatória dentre as 10 da meta informada.
	 * @param {number} milestone - Meta (10, 15, 25, 50, 75, 90, 99, 100)
	 * @returns {string} Frase aleatória
	 */
	getRandomPhrase(milestone) {
		const phrases = MILESTONE_PHRASES[milestone] || MILESTONE_PHRASES[10];
		return phrases[Math.floor(Math.random() * phrases.length)];
	}

	/**
	 * Localiza a melhor instância de bot disponível para enviar mensagem para o grupo.
	 * @param {string} groupId - JID do grupo
	 * @param {string} [botId=null] - ID do bot preferencial
	 * @returns {Object|null} Instância do bot
	 */
	resolveBotForGroup(groupId, botId = null) {
		const allBots = this.database.botInstances || [];

		// 1. Tenta achar pelo botId exato conectado
		if (botId) {
			const preferred = allBots.find((b) => (b.id === botId || b.name === botId) && b.isConnected);
			if (preferred) return preferred;
		}

		// 2. Busca qualquer bot WhatsApp conectado
		const isWhatsApp = groupId.includes("@g.us");
		if (isWhatsApp) {
			const waBot = allBots.find((b) => !b.useTelegram && !b.useDiscord && b.isConnected);
			if (waBot) return waBot;
		}

		// 3. Fallback para defaultBot ou primeiro conectado
		if (this.defaultBot && this.defaultBot.isConnected) {
			return this.defaultBot;
		}

		return allBots.find((b) => b.isConnected) || this.defaultBot || allBots[0] || null;
	}

	/**
	 * Executa a checagem periódica dos dados da rifa e dispara notificações se metas foram atingidas.
	 * @param {string} url - URL da rifa
	 */
	async checkRaffleMilestones(url) {
		// Import sob demanda para evitar dependência circular
		const { getRaffleData, buildRaffleMessage } = require("../functions/Raffles");

		this.logger.debug(`[RaffleMonitor] Checando metas para ${url}...`);

		// Força busca online para atualizar o cache
		const data = await getRaffleData(url, true);
		if (!data) {
			this.logger.warn(`[RaffleMonitor] Falha ao obter dados online de ${url}. Pulando rodada.`);
			return;
		}

		// Calcula a porcentagem atual de vendas
		const total = data.total_nums || 0;
		const available = data.available_nums || 0;
		const sold = Math.max(0, total - available);
		const currentPercent = total > 0 ? (sold / total) * 100 : 0;

		// Busca todos os grupos ativos que seguem esta URL
		const follows = await this.database.dbAll(
			DB_NAME,
			`SELECT group_id, bot_id FROM raffle_follows WHERE url = ? AND active = 1`,
			[url]
		);

		if (!follows || follows.length === 0) {
			this.logger.info(
				`[RaffleMonitor] Nenhum grupo ativo seguindo ${url}. Desativando monitoramento.`
			);
			this.stopMonitoringUrl(url);
			return;
		}

		// Para cada grupo inscrito, verifica as metas atingidas
		for (const follow of follows) {
			try {
				const groupId = follow.group_id;

				// Verifica se o grupo está pausado
				const groupObj = await this.database.getGroup(groupId);
				if (groupObj && groupObj.paused) {
					this.logger.debug(
						`[RaffleMonitor] Grupo ${groupId} está pausado. Ignorando notificação.`
					);
					continue;
				}

				// Busca metas já notificadas para este grupo nesta URL
				const notifiedRows = await this.database.dbAll(
					DB_NAME,
					`SELECT milestone FROM raffle_notifications WHERE group_id = ? AND url = ?`,
					[groupId, url]
				);
				const notifiedSet = new Set((notifiedRows || []).map((r) => r.milestone));

				// Encontra metas alcançadas ainda não notificadas
				const unnotifiedReached = MILESTONES.filter(
					(m) => currentPercent >= m && !notifiedSet.has(m)
				);

				if (unnotifiedReached.length === 0) {
					continue;
				}

				// Como acordado: se houve salto (ex: 20% -> 55%), notifica a maior meta atingida (50%)
				// e registra todas as intermediárias no banco para evitar spam.
				const highestMilestone = Math.max(...unnotifiedReached);
				const now = Date.now();

				for (const m of unnotifiedReached) {
					await this.database.dbRun(
						DB_NAME,
						`INSERT OR IGNORE INTO raffle_notifications (group_id, url, milestone, notified_at)
						 VALUES (?, ?, ?, ?)`,
						[groupId, url, m, now]
					);
				}

				// Obtém frase aleatória para a meta mais alta atingida
				const phrase = this.getRandomPhrase(highestMilestone);

				// Localiza o bot para enviar a mensagem
				const bot = this.resolveBotForGroup(groupId, follow.bot_id);
				if (!bot) {
					this.logger.warn(
						`[RaffleMonitor] Nenhum bot disponível para enviar notificação ao grupo ${groupId}.`
					);
					continue;
				}

				// Constrói e envia a mensagem de retorno para o grupo
				const returnMsg = await buildRaffleMessage(bot, groupId, data, url, phrase);
				if (returnMsg) {
					await bot.sendReturnMessages(returnMsg, groupObj);
					this.logger.info(
						`[RaffleMonitor] Notificação de ${highestMilestone}% enviada com sucesso para o grupo ${groupId}.`
					);
				}
			} catch (groupError) {
				this.logger.error(
					`[RaffleMonitor] Erro ao notificar grupo ${follow.group_id} para ${url}:`,
					groupError.message ?? groupError
				);
			}
		}
	}
}

module.exports = RaffleMonitor;
