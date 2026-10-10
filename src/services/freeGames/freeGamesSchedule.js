/**
 * Quando o aviso semanal de jogos grátis roda. Fonte única do horário: o cron,
 * as respostas dos comandos e os logs usam este objeto.
 */
const FREE_GAMES_SCHEDULE = Object.freeze({
	cron: "0 10 * * 6",
	timeZone: "America/Sao_Paulo",
	description: "sábado às 10h"
});

module.exports = { FREE_GAMES_SCHEDULE };
