const crypto = require("crypto");

/**
 * TelegramCallbackManager
 *
 * Gerencia a codificação e decodificação de callback_data para botões inline do Telegram,
 * garantindo conformidade com o limite estrito de 64 bytes da Telegram Bot API.
 */
class TelegramCallbackManager {
	static cache = new Map();
	static DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutos

	static {
		// Limpeza periódica de entradas expiradas a cada 5 minutos
		if (typeof setInterval === "function") {
			const timer = setInterval(
				() => {
					const now = Date.now();
					for (const [key, item] of TelegramCallbackManager.cache.entries()) {
						if (item.expiresAt <= now) {
							TelegramCallbackManager.cache.delete(key);
						}
					}
				},
				5 * 60 * 1000
			);

			if (timer.unref) {
				timer.unref(); // Não impede o encerramento do processo
			}
		}
	}

	/**
	 * Codifica uma ação em uma string de callback_data de no máximo 64 bytes.
	 * @param {string|Object} action
	 * @returns {string}
	 */
	static encode(action) {
		if (!action) return "";

		// Se já for string compacta conhecida
		if (typeof action === "string") {
			if (
				(action.startsWith("c:") || action.startsWith("m:") || action.startsWith("r:")) &&
				Buffer.byteLength(action, "utf8") <= 64
			) {
				return action;
			}
			if (
				(action.startsWith("/") || action.startsWith("!")) &&
				Buffer.byteLength(`c:${action}`, "utf8") <= 64
			) {
				return `c:${action}`;
			}
			action = { type: "command", value: action };
		}

		let compact = null;
		if (action.type === "command" && typeof action.value === "string") {
			compact = `c:${action.value}`;
		} else if (action.type === "menu") {
			const cat = action.category || "root";
			const page = action.page !== undefined ? action.page : 0;
			compact = `m:${cat}:${page}`;
		}

		if (compact && Buffer.byteLength(compact, "utf8") <= 64) {
			return compact;
		}

		// Se exceder 64 bytes ou for objeto complexo, armazena em cache sob id curto
		const id = crypto.randomBytes(6).toString("hex"); // 12 chars hex
		const key = `r:${id}`;

		TelegramCallbackManager.cache.set(key, {
			data: action,
			expiresAt: Date.now() + TelegramCallbackManager.DEFAULT_TTL_MS
		});

		return key;
	}

	/**
	 * Decodifica o callback_data recebido de um update do Telegram.
	 * @param {string} callbackData
	 * @returns {Object|null}
	 */
	static decode(callbackData) {
		if (!callbackData || typeof callbackData !== "string") {
			return null;
		}

		// Comando direto
		if (callbackData.startsWith("c:")) {
			return {
				type: "command",
				value: callbackData.substring(2)
			};
		}

		// Menu interativo
		if (callbackData.startsWith("m:")) {
			const parts = callbackData.substring(2).split(":");
			return {
				type: "menu",
				category: parts[0] || "root",
				page: parseInt(parts[1] || "0", 10)
			};
		}

		// Referência em cache
		if (callbackData.startsWith("r:")) {
			const cached = TelegramCallbackManager.cache.get(callbackData);
			if (cached && cached.expiresAt > Date.now()) {
				return cached.data;
			}
			return null;
		}

		// Formato legado ou desconhecido
		return {
			type: "raw",
			value: callbackData
		};
	}

	/**
	 * Limpa todo o cache (usado em testes).
	 */
	static clearCache() {
		TelegramCallbackManager.cache.clear();
	}
}

module.exports = TelegramCallbackManager;
