const Logger = require("../utils/Logger");

/**
 * Serviço para escalonar (stagger) a atualização de status do perfil dos bots em intervalos de 5 minutos,
 * evitando que múltiplos bots atualizem simultaneamente e causem erros na API do WhatsApp.
 */
class ProfileStatusScheduler {
	constructor(options = {}) {
		this.logger = new Logger("profile-status-scheduler");
		this.bots = options.bots || [];
		// Intervalo de escalonamento padrão: 5 minutos (300.000 ms)
		this.intervalMs =
			options.intervalMs ||
			(process.env.PROFILE_STATUS_STAGGER_INTERVAL
				? parseInt(process.env.PROFILE_STATUS_STAGGER_INTERVAL, 10)
				: 5 * 60 * 1000);
		this.timer = null;
		this.currentIndex = 0;
		this.isRunning = false;
	}

	/**
	 * Retorna a instância singleton do scheduler
	 * @param {Object} options
	 * @returns {ProfileStatusScheduler}
	 */
	static getInstance(options = {}) {
		if (!ProfileStatusScheduler.instance) {
			ProfileStatusScheduler.instance = new ProfileStatusScheduler(options);
		} else if (options.bots && Array.isArray(options.bots)) {
			options.bots.forEach((b) => ProfileStatusScheduler.instance.registerBot(b));
		}
		return ProfileStatusScheduler.instance;
	}

	/**
	 * Registra uma instância de bot no scheduler
	 * @param {Object} bot
	 */
	registerBot(bot) {
		if (!bot || !bot.id) return;
		const existingIndex = this.bots.findIndex((b) => b.id === bot.id);
		if (existingIndex >= 0) {
			this.bots[existingIndex] = bot;
		} else {
			this.bots.push(bot);
			this.logger.debug(
				`[ProfileStatusScheduler] Bot '${bot.id}' registrado para escalonamento de status.`
			);
		}
	}

	/**
	 * Remove um bot do scheduler
	 * @param {Object} bot
	 */
	unregisterBot(bot) {
		if (!bot || !bot.id) return;
		this.bots = this.bots.filter((b) => b.id !== bot.id);
		this.logger.debug(
			`[ProfileStatusScheduler] Bot '${bot.id}' removido do escalonamento de status.`
		);
	}

	/**
	 * Retorna apenas os bots elegíveis para atualização de status (updateStatus !== false e compatíveis com profileStatus)
	 * @returns {Array<Object>}
	 */
	getEligibleBots() {
		return this.bots.filter((bot) => bot && bot.updateStatus !== false && !bot.useTelegram);
	}

	/**
	 * Constrói a mensagem de status para o perfil
	 * @param {Object} bot
	 * @returns {string}
	 */
	formatStatus(bot) {
		if (bot.loadReport && typeof bot.loadReport.formatStatus === "function") {
			return bot.loadReport.formatStatus();
		}
		const now = new Date();
		const dateString = `${now.getDate().toString().padStart(2, "0")}/${(now.getMonth() + 1).toString().padStart(2, "0")}`;
		const timeString = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

		const msgPv = bot.ignorePV ? "PV desabilitado" : "Envie !cmd";
		return `${msgPv} | https://ravena.moothz.win | ${dateString} ${timeString}`;
	}

	/**
	 * Atualiza o status do perfil de um bot específico
	 * @param {Object} bot
	 * @returns {Promise<boolean>}
	 */
	async updateBotStatus(bot) {
		if (!bot || bot.updateStatus === false || bot.useTelegram) return false;
		if (!bot.isConnected) {
			this.logger.debug(
				`[ProfileStatusScheduler] Bot '${bot.id}' não está conectado, pulando atualização.`
			);
			return false;
		}

		const status = this.formatStatus(bot);
		try {
			if (typeof bot.updateProfileStatus === "function") {
				await bot.updateProfileStatus(status);
			} else if (bot.client && typeof bot.client.setStatus === "function") {
				await bot.client.setStatus(status);
			}
			this.logger.info(
				`[ProfileStatusScheduler] Status do bot '${bot.id}' atualizado com sucesso: ${status}`
			);
			return true;
		} catch (error) {
			this.logger.error(
				`[ProfileStatusScheduler] Erro ao atualizar status do bot '${bot.id}':`,
				error
			);
			return false;
		}
	}

	/**
	 * Executa um ciclo de escalonamento: seleciona o próximo bot conectado elegível e atualiza seu status
	 * @returns {Promise<boolean>} Retorna true se um bot foi atualizado
	 */
	async tick() {
		const eligibleBots = this.getEligibleBots();
		if (eligibleBots.length === 0) {
			this.logger.debug("[ProfileStatusScheduler] Nenhum bot elegível para atualização de status.");
			return false;
		}

		const total = eligibleBots.length;
		let updated = false;

		for (let i = 0; i < total; i++) {
			const candidateIndex = (this.currentIndex + i) % total;
			const bot = eligibleBots[candidateIndex];

			if (bot && bot.isConnected) {
				this.currentIndex = (candidateIndex + 1) % total;
				await this.updateBotStatus(bot);
				updated = true;
				break;
			} else {
				this.logger.debug(
					`[ProfileStatusScheduler] Bot '${bot?.id}' não conectado, verificando próximo elegível.`
				);
			}
		}

		if (!updated) {
			this.logger.debug("[ProfileStatusScheduler] Nenhum bot elegível está conectado no momento.");
			this.currentIndex = (this.currentIndex + 1) % total;
		}

		return updated;
	}

	/**
	 * Inicia o agendamento periódico
	 */
	start() {
		if (this.isRunning) return;
		if (process.env.DISABLE_ACTIVITY === "true") {
			this.logger.info("[ProfileStatusScheduler] DISABLE_ACTIVITY=true. Scheduler não iniciado.");
			return;
		}

		this.isRunning = true;
		this.logger.info(
			`[ProfileStatusScheduler] Iniciado. Intervalo entre atualizações: ${this.intervalMs / 1000}s. Bots elegíveis: ${this.getEligibleBots().length}`
		);

		this.timer = setInterval(() => {
			this.tick().catch((err) => {
				this.logger.error("[ProfileStatusScheduler] Erro durante o tick do scheduler:", err);
			});
		}, this.intervalMs);
	}

	/**
	 * Para o agendamento periódico
	 */
	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.isRunning = false;
		this.logger.info("[ProfileStatusScheduler] Parado.");
	}
}

module.exports = ProfileStatusScheduler;
