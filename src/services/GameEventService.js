/**
 * Serviço de Gerenciamento de Eventos Temporários de Jogos
 * Suporta multiplicadores e aumentos percentuais configurados por SuperAdmin
 */

const Database = require("../utils/Database");
const Logger = require("../utils/Logger");

const logger = new Logger("game-event-service");
const database = Database.getInstance();

// Cache em memória para acesso síncrono e ultra-rápido durante comandos de jogos
const activeEventsCache = new Map();
let isInitialized = false;

const SUPPORTED_GAMES = {
	pesca: ["peso", "lendario"],
	waifu: ["raros", "wish"],
	slots: ["vitoria", "moedas", "iscas"]
};

/**
 * Normaliza o nome do jogo
 * @param {string} game
 * @returns {string|null}
 */
function normalizeGame(game) {
	if (!game) return null;
	const g = String(game).toLowerCase().trim();
	if (g === "pesca" || g === "fishing") return "pesca";
	if (g === "waifu" || g === "waifus" || g === "mudae" || g === "munae") return "waifu";
	if (g === "slots" || g === "slot") return "slots";
	return null;
}

/**
 * Normaliza o tipo de evento para o jogo
 * @param {string} game
 * @param {string} type
 * @returns {string|null}
 */
function normalizeType(game, type) {
	const normGame = normalizeGame(game);
	if (!normGame || !type) return null;
	const t = String(type).toLowerCase().trim();

	if (normGame === "pesca") {
		if (t === "peso") return "peso";
		if (t === "lendario" || t === "lendarios" || t === "legendary") return "lendario";
	} else if (normGame === "waifu") {
		if (t === "raro" || t === "raros" || t === "rare") return "raros";
		if (t === "wish" || t === "wishlist" || t === "desejo" || t === "desejos") return "wish";
	} else if (normGame === "slots") {
		if (t === "vitoria" || t === "vitorias" || t === "win") return "vitoria";
		if (t === "moeda" || t === "moedas" || t === "coins") return "moedas";
		if (t === "isca" || t === "iscas" || t === "baits") return "iscas";
	}

	return null;
}

/**
 * Inicializa o cache a partir do banco SQLite
 */
async function init() {
	if (isInitialized) return;
	try {
		const events = await database.getActiveGameEvents();
		const now = Date.now();
		activeEventsCache.clear();
		for (const ev of events) {
			if (ev.end_time > now) {
				const key = `${ev.game}:${ev.type}`;
				activeEventsCache.set(key, {
					id: ev.id,
					game: ev.game,
					type: ev.type,
					value: Number(ev.value),
					startTime: Number(ev.start_time),
					endTime: Number(ev.end_time),
					createdBy: ev.created_by
				});
			}
		}
		isInitialized = true;
		logger.info(
			`[GameEventService] Inicializado com ${activeEventsCache.size} evento(s) ativo(s).`
		);
	} catch (error) {
		logger.error("[GameEventService] Erro ao carregar eventos do SQLite:", error);
	}
}

// Auto-inicialização assíncrona
init();

/**
 * Formata o tempo restante de forma amigável (ex: 4hrs restantes, 1hr restante, 35min restantes)
 * @param {number} endTime
 * @returns {string}
 */
function formatRemainingTime(endTime) {
	const diffMs = endTime - Date.now();
	if (diffMs <= 0) return "expirado";

	const totalMinutes = Math.ceil(diffMs / (60 * 1000));
	const totalHours = Math.ceil(diffMs / (3600 * 1000));

	if (totalHours > 1) {
		return `${totalHours}hrs restantes`;
	}
	if (totalHours === 1 && totalMinutes >= 60) {
		return "1hr restante";
	}
	return `${totalMinutes}min restantes`;
}

/**
 * Retorna o evento ativo para um jogo e tipo (ou null se não existir ou tiver expirado)
 * @param {string} game
 * @param {string} type
 * @returns {Object|null}
 */
function getEvent(game, type) {
	const normGame = normalizeGame(game);
	const normType = normalizeType(normGame, type);
	if (!normGame || !normType) return null;

	const key = `${normGame}:${normType}`;
	const ev = activeEventsCache.get(key);
	if (!ev) return null;

	if (ev.endTime <= Date.now()) {
		activeEventsCache.delete(key);
		database.deleteGameEvent(normGame, normType).catch(() => {});
		return null;
	}

	return ev;
}

/**
 * Retorna o multiplicador decimal a partir da porcentagem do evento (ex: 50 -> 1.5x)
 * Se o evento não estiver ativo, retorna 1.0
 * @param {string} game
 * @param {string} type
 * @returns {number}
 */
function getMultiplier(game, type) {
	const ev = getEvent(game, type);
	if (!ev || ev.value <= 0) return 1.0;
	return Number((1 + ev.value / 100).toFixed(4));
}

/**
 * Retorna todos os eventos ativos, opcionalmente filtrados por jogo
 * @param {string} [gameFilter=null]
 * @returns {Array<Object>}
 */
function getActiveEvents(gameFilter = null) {
	const normGame = gameFilter ? normalizeGame(gameFilter) : null;
	const now = Date.now();
	const result = [];

	for (const [key, ev] of activeEventsCache.entries()) {
		if (ev.endTime <= now) {
			activeEventsCache.delete(key);
			database.deleteGameEvent(ev.game, ev.type).catch(() => {});
			continue;
		}

		if (!normGame || ev.game === normGame) {
			result.push({
				...ev,
				remainingText: formatRemainingTime(ev.endTime),
				multiplier: Number((1 + ev.value / 100).toFixed(4))
			});
		}
	}

	return result;
}

/**
 * Cria ou atualiza um evento temporário
 * @param {string} game
 * @param {string} type
 * @param {number} value - Porcentagem de aumento (ex: 50 para +50%)
 * @param {number} durationHours - Duração em horas
 * @param {string} [createdBy=null]
 * @returns {Promise<Object>}
 */
async function setEvent(game, type, value, durationHours, createdBy = null) {
	const normGame = normalizeGame(game);
	if (!normGame) {
		return {
			success: false,
			message: `Jogo inválido. Jogos disponíveis: ${Object.keys(SUPPORTED_GAMES).join(", ")}`
		};
	}

	const normType = normalizeType(normGame, type);
	if (!normType) {
		return {
			success: false,
			message: `Tipo de evento inválido para '${normGame}'. Tipos disponíveis: ${SUPPORTED_GAMES[normGame].join(", ")}`
		};
	}

	const numValue = Number(value);
	if (isNaN(numValue) || numValue <= 0) {
		// Valor 0 ou negativo cancela o evento
		return removeEvent(normGame, normType);
	}

	const numDuration = Number(durationHours);
	if (isNaN(numDuration) || numDuration <= 0) {
		return {
			success: false,
			message: "Duração inválida. Informe a duração em horas (ex: 4, 12, 24)."
		};
	}

	const startTime = Date.now();
	const endTime = startTime + Math.round(numDuration * 3600 * 1000);

	const eventData = {
		game: normGame,
		type: normType,
		value: numValue,
		startTime,
		endTime,
		createdBy
	};

	await database.saveGameEvent(eventData);

	const key = `${normGame}:${normType}`;
	activeEventsCache.set(key, eventData);

	logger.info(
		`[GameEventService] Evento criado: ${normGame}:${normType} com +${numValue}% por ${numDuration}h (expira em ${new Date(endTime).toISOString()})`
	);

	return {
		success: true,
		event: eventData,
		remainingText: formatRemainingTime(endTime),
		message: `✅ Evento ativado com sucesso!\n🎮 Jogo: *${normGame}*\n🏷️ Tipo: *${normType}*\n📈 Bônus: *+${numValue}%*\n⏳ Duração: *${numDuration}h* (${formatRemainingTime(endTime)})`
	};
}

/**
 * Remove/cancela um evento ativo
 * @param {string} game
 * @param {string} type
 * @returns {Promise<Object>}
 */
async function removeEvent(game, type) {
	const normGame = normalizeGame(game);
	const normType = normalizeType(normGame, type);
	if (!normGame || !normType) {
		return { success: false, message: "Jogo ou tipo inválido." };
	}

	const key = `${normGame}:${normType}`;
	activeEventsCache.delete(key);
	await database.deleteGameEvent(normGame, normType);

	logger.info(`[GameEventService] Evento removido: ${normGame}:${normType}`);
	return {
		success: true,
		removed: true,
		message: `🛑 Evento de *${normType}* em *${normGame}* foi encerrado.`
	};
}

/**
 * Retorna o banner de eventos ativos formatado para anexar ao final da mensagem de um jogo
 * @param {string} game
 * @returns {string}
 */
function getEventBanner(game) {
	const events = getActiveEvents(game);
	if (!events || events.length === 0) return "";

	const lines = [];
	for (const ev of events) {
		const remaining = formatRemainingTime(ev.endTime);
		let label = "";

		if (ev.game === "pesca") {
			if (ev.type === "peso") {
				label = `+${ev.value}% peso nos peixes`;
			} else if (ev.type === "lendario") {
				label = `+${ev.value}% chance de lendários`;
			}
		} else if (ev.game === "waifu") {
			if (ev.type === "raros") {
				label = `+${ev.value}% personagens raros`;
			} else if (ev.type === "wish") {
				label = `+${ev.value}% waifus da wishlist`;
			}
		} else if (ev.game === "slots") {
			if (ev.type === "vitoria") {
				label = `+${ev.value}% chance de vitória no caça-coisas`;
			} else if (ev.type === "moedas") {
				label = `+${ev.value}% moedas em prêmios`;
			} else if (ev.type === "iscas") {
				label = `+${ev.value}% iscas em prêmios`;
			}
		}

		if (label) {
			lines.push(`> 🆙 Evento ativo! ${label} (${remaining})`);
		}
	}

	return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

module.exports = {
	init,
	setEvent,
	removeEvent,
	getEvent,
	getMultiplier,
	getActiveEvents,
	getEventBanner,
	formatRemainingTime,
	normalizeGame,
	normalizeType,
	SUPPORTED_GAMES
};
