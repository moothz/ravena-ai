/**
 * src/utils/MemoryCache.js
 *
 * Cache em memória ultra-leve com suporte a TTL (tempo de vida) individual ou padrão
 * e limite máximo de entradas (política LRU/FIFO simples baseada em Map).
 *
 * Utilizado para metadados de grupos, contatos e outros objetos de acesso frequente,
 * eliminando chamadas repetitivas de rede com overhead mínimo de memória RAM.
 */

class MemoryCache {
	/**
	 * @param {number} defaultTtlMs - Tempo de vida padrão em milissegundos (padrão: 60.000 ms = 60s)
	 * @param {number} maxEntries - Capacidade máxima de itens armazenados (padrão: 1000)
	 */
	constructor(defaultTtlMs = 60000, maxEntries = 1000) {
		this.defaultTtlMs = defaultTtlMs > 0 ? defaultTtlMs : 60000;
		this.maxEntries = maxEntries > 0 ? maxEntries : 1000;
		this.cache = new Map();
	}

	/**
	 * Obtém um item do cache se ainda for válido
	 * @param {string} key
	 * @returns {*|null} Valor armazenado ou null se expirado/inexistente
	 */
	get(key) {
		if (!key) return null;
		const entry = this.cache.get(key);
		if (!entry) return null;

		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return null;
		}

		// Reinsere para manter a chave como recentemente acessada (LRU)
		this.cache.delete(key);
		this.cache.set(key, entry);

		return entry.value;
	}

	/**
	 * Armazena ou atualiza um item no cache
	 * @param {string} key
	 * @param {*} value
	 * @param {number} [customTtlMs] - TTL específico para esta entrada em milissegundos
	 */
	set(key, value, customTtlMs) {
		if (!key) return;

		const ttl = customTtlMs && customTtlMs > 0 ? customTtlMs : this.defaultTtlMs;
		const expiresAt = Date.now() + ttl;

		// Se a chave já existe, remove para reposicionar no final do Map
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.maxEntries) {
			// Evacua a chave mais antiga (primeira chave do Map)
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey !== undefined) {
				this.cache.delete(oldestKey);
			}
		}

		this.cache.set(key, { value, expiresAt });
	}

	/**
	 * Remove um item do cache
	 * @param {string} key
	 * @returns {boolean}
	 */
	delete(key) {
		if (!key) return false;
		return this.cache.delete(key);
	}

	/**
	 * Verifica se a chave existe e não está expirada
	 * @param {string} key
	 * @returns {boolean}
	 */
	has(key) {
		return this.get(key) !== null;
	}

	/**
	 * Limpa todas as entradas do cache
	 */
	clear() {
		this.cache.clear();
	}

	/**
	 * Retorna a quantidade de itens atualmente no cache (incluindo possíveis expirados ainda não limpos)
	 * @returns {number}
	 */
	size() {
		return this.cache.size;
	}
}

module.exports = MemoryCache;
