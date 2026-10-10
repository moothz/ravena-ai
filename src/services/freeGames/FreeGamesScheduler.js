const cron = require("node-cron");
const Logger = require("../../utils/Logger");

const SATURDAY_AT_10H = "0 10 * * 6";
const TIME_ZONE = "America/Sao_Paulo";

/**
 * Agenda a execução semanal do caso de uso (sábado, 10h de Brasília).
 * Só faz o wiring do cron; a regra de negócio fica no caso de uso.
 */
class FreeGamesScheduler {
	constructor() {
		this.logger = new Logger("free-games-scheduler");
		this.task = null;
	}

	static getInstance() {
		if (!FreeGamesScheduler.instance) {
			FreeGamesScheduler.instance = new FreeGamesScheduler();
		}
		return FreeGamesScheduler.instance;
	}

	/**
	 * @param {{execute: () => Promise<Object>}} useCase
	 */
	start(useCase) {
		if (this.task) return;
		this.task = cron.schedule(
			SATURDAY_AT_10H,
			() => {
				useCase.execute().catch((error) => {
					this.logger.error("Falha na notificação semanal de jogos grátis:", error);
				});
			},
			{ timezone: TIME_ZONE }
		);
		this.logger.info(`Agendado: sábados às 10h (${TIME_ZONE}).`);
	}

	stop() {
		this.task?.stop();
		this.task = null;
	}
}

module.exports = FreeGamesScheduler;
