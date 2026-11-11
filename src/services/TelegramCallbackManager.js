const crypto = require("crypto");

/**
 * TelegramCallbackManager
 *
 * Gerencia a codificação e decodificação de callback_data para botões inline do Telegram,
 * garantindo conformidade com o limite estrito de 64 bytes da Telegram Bot API.
 *
 * Também é reutilizado pelo DiscordBot para gerar o custom_id dos botões (limite de 100 caracteres),
 * mantendo o mesmo formato compacto (c:, m:, w:, f:, r:) nas duas plataformas.
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
	 * Codifica uma ação em uma string de callback_data de no máximo `maxBytes` bytes.
	 * @param {string|Object} action
	 * @param {number} [maxBytes=64] - Limite da plataforma (Telegram: 64 bytes; Discord custom_id: 100)
	 * @returns {string}
	 */
	static encode(action, maxBytes = 64) {
		if (!action) return "";

		// Se já for string compacta conhecida
		if (typeof action === "string") {
			if (
				(action.startsWith("c:") ||
					action.startsWith("m:") ||
					action.startsWith("w:") ||
					action.startsWith("f:") ||
					action.startsWith("r:")) &&
				Buffer.byteLength(action, "utf8") <= maxBytes
			) {
				return action;
			}
			if (
				(action.startsWith("/") || action.startsWith("!")) &&
				Buffer.byteLength(`c:${action}`, "utf8") <= maxBytes
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
		} else if (action.type === "waifu_menu") {
			const cat = action.category || "root";
			const page = action.page !== undefined ? action.page : 0;
			compact = `w:${cat}:${page}`;
		} else if (action.type === "fazenda_menu") {
			const cat = action.category || "root";
			const page = action.page !== undefined ? action.page : 0;
			compact = `f:${cat}:${page}`;
		}

		if (compact && Buffer.byteLength(compact, "utf8") <= maxBytes) {
			return compact;
		}

		// Se exceder o limite ou for objeto complexo, armazena em cache sob id curto
		return TelegramCallbackManager.storeAction(action);
	}

	/**
	 * Armazena uma ação no cache em memória e retorna uma referência curta e única (r:<12 hex>).
	 * Usado quando a ação não cabe no limite da plataforma ou quando é preciso um id exclusivo
	 * (ex: custom_ids duplicados numa mesma mensagem do Discord).
	 * @param {Object} action
	 * @returns {string}
	 */
	static storeAction(action) {
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

		// Menu interativo geral
		if (callbackData.startsWith("m:")) {
			const parts = callbackData.substring(2).split(":");
			return {
				type: "menu",
				category: parts[0] || "root",
				page: parseInt(parts[1] || "0", 10)
			};
		}

		// Menu interativo de Waifus
		if (callbackData.startsWith("w:")) {
			const parts = callbackData.substring(2).split(":");
			return {
				type: "waifu_menu",
				category: parts[0] || "root",
				page: parseInt(parts[1] || "0", 10)
			};
		}

		// Menu interativo da Fazenda
		if (callbackData.startsWith("f:")) {
			const parts = callbackData.substring(2).split(":");
			return {
				type: "fazenda_menu",
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
