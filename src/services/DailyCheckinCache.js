/**
 * DailyCheckinCache.js
 *
 * Estado em memória do check-in diário dos minigames (Zinthos e Sacola do Coveiro).
 * O resgate diário é tentado em todo comando do jogo, então saber localmente que o jogador já
 * resgatou no ciclo elimina uma chamada HTTP por comando. Não justifica persistência: perder o
 * estado no restart só custa uma chamada de claim a mais no próximo comando daquele jogador.
 *
 * A entrada também guarda o resultado do resgate do ciclo, usado para reexibir o que o jogador
 * já ganhou quando ele chama o comando explícito de diário de novo.
 */

const MemoryCache = require("../utils/MemoryCache");

const GAMES = { WAIFU: "waifu", FAZENDA: "fazenda" };

// Resets fixos do ciclo, em UTC (BRT = UTC-3): Zinthos 04:00, Sacola do Coveiro 03:00.
const RESET_HOUR_UTC = {
	[GAMES.WAIFU]: 7,
	[GAMES.FAZENDA]: 6
};

const MAX_TTL_MS = 25 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * Próximo marco de reset do ciclo do jogo (hora fixa em UTC)
 * @param {string} game GAMES.WAIFU | GAMES.FAZENDA
 * @param {number} [nowMs]
 * @returns {number} epoch em ms
 */
function nextResetMs(game, nowMs = Date.now()) {
	const hourUtc = Object.prototype.hasOwnProperty.call(RESET_HOUR_UTC, game)
		? RESET_HOUR_UTC[game]
		: RESET_HOUR_UTC[GAMES.WAIFU];
	const day = new Date(nowMs);
	let reset = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc);
	if (nowMs >= reset) reset += 24 * 60 * 60 * 1000;
	return reset;
}

class DailyCheckinCache {
	constructor(maxEntries = MAX_ENTRIES) {
		this.cache = new MemoryCache(MAX_TTL_MS, maxEntries);
	}

	_key(game, userId) {
		return `${game}:${userId}`;
	}

	_ttlMs(game, availableAtMs) {
		const availableAt =
			Number.isFinite(availableAtMs) && availableAtMs > 0 ? availableAtMs : nextResetMs(game);
		return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, availableAt - Date.now()));
	}

	/**
	 * @param {string} game
	 * @param {string} userId
	 * @returns {{ claimed: boolean, result: Object|null, availableAt: number }|null}
	 */
	get(game, userId) {
		if (!userId) return null;
		return this.cache.get(this._key(game, userId)) ?? null;
	}

	/**
	 * Registra o resgate feito neste ciclo (e o que foi ganho, para reexibir depois)
	 * @param {string} game
	 * @param {string} userId
	 * @param {Object} result payload do claim devolvido pelo microsserviço
	 * @param {number} [availableAtMs] quando o próximo resgate libera (padrão: reset do ciclo)
	 * @returns {Object} a entrada registrada
	 */
	markClaimed(game, userId, result, availableAtMs) {
		const entry = {
			claimed: true,
			result: result ?? null,
			availableAt:
				Number.isFinite(availableAtMs) && availableAtMs > 0 ? availableAtMs : nextResetMs(game)
		};
		this.cache.set(this._key(game, userId), entry, this._ttlMs(game, entry.availableAt));
		return entry;
	}

	/**
	 * Registra que o resgate deste ciclo já foi feito (ou está em cooldown) sem termos o resultado
	 * @param {string} game
	 * @param {string} userId
	 * @param {number} [availableAtMs]
	 * @returns {Object} a entrada registrada
	 */
	markUnavailable(game, userId, availableAtMs) {
		const entry = {
			claimed: false,
			result: null,
			availableAt:
				Number.isFinite(availableAtMs) && availableAtMs > 0 ? availableAtMs : nextResetMs(game)
		};
		this.cache.set(this._key(game, userId), entry, this._ttlMs(game, entry.availableAt));
		return entry;
	}

	size() {
		return this.cache.size();
	}
}

const dailyCheckinCache = new DailyCheckinCache();

module.exports = { dailyCheckinCache, GAMES, nextResetMs };
