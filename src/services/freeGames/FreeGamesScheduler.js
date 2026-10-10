const { FREE_GAMES_SCHEDULE } = require("./freeGamesSchedule");

/**
 * Agenda a execução semanal do caso de uso.
 * Só faz o wiring do cron; a regra de negócio fica no caso de uso.
 */
class FreeGamesScheduler {
	/**
	 * @param {Object} deps
	 * @param {{schedule: Function}} deps.cron - normalmente o node-cron
	 * @param {Object} deps.logger
	 */
	constructor({ cron, logger }) {
		this.cron = cron;
		this.logger = logger;
		this.task = null;
	}

	/**
	 * @param {{execute: () => Promise<Object>}} useCase
	 */
	start(useCase) {
		if (this.task) return;
		this.task = this.cron.schedule(
			FREE_GAMES_SCHEDULE.cron,
			() =>
				useCase.execute().catch((error) => {
					this.logger.error("Falha na notificação semanal de jogos grátis:", error);
				}),
			{ timezone: FREE_GAMES_SCHEDULE.timeZone }
		);
		this.logger.info(
			`Agendado: ${FREE_GAMES_SCHEDULE.description} (${FREE_GAMES_SCHEDULE.timeZone}).`
		);
	}

	stop() {
		this.task?.stop();
		this.task = null;
	}
}

module.exports = FreeGamesScheduler;
