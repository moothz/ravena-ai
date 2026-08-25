/**
 * Utilitarios para manipulacao segura de JSON
 */

/**
 * Faz parse seguro de JSON, retornando fallback em caso de erro.
 * @param {string} str - String JSON a ser convertida
 * @param {any} [fallback=null] - Valor padrao se o parsing falhar ou a entrada for invalida
 * @returns {any}
 */
function safeJsonParse(str, fallback = null) {
	if (!str || typeof str !== "string") return fallback;
	try {
		return JSON.parse(str);
	} catch {
		return fallback;
	}
}

module.exports = { safeJsonParse };
