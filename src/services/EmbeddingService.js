const axios = require("axios");
const Logger = require("../utils/Logger");
const ServiceProviderService = require("./ServiceProviderService");

/**
 * Serviço de geração de embeddings vetoriais com Ollama (BGE-M3 1024-dim).
 * Fornece métodos para vetorização de textos e cálculo de similaridade de cosseno em memória.
 */
class EmbeddingService {
	static getInstance(config = {}) {
		if (!EmbeddingService.instance) {
			EmbeddingService.instance = new EmbeddingService(config);
		}
		return EmbeddingService.instance;
	}

	constructor(config = {}) {
		this.logger = new Logger("embedding-service");
		this.serviceProviderService = ServiceProviderService.getInstance();
		this.defaultEndpoint =
			config.endpoint || process.env.OLLAMA_EMBED_URL || "http://192.168.195.212:11434";
		this.defaultModel = config.model || process.env.OLLAMA_EMBED_MODEL || "bge-m3:latest";
		this.timeoutMs = config.timeoutMs || 10000;
		this.vectorDimension = 1024;

		// Cache LRU em memória simples para textos frequentes (capacidade: 1000)
		this.cache = new Map();
		this.maxCacheSize = 1000;
	}

	/**
	 * Gera o vetor embedding de 1024 floats para um texto.
	 * @param {string} text - Texto a ser vetorizado
	 * @returns {Promise<Float32Array|null>} Vetor de 1024 dimensões ou null em caso de falha
	 */
	async getEmbedding(text) {
		if (!text || typeof text !== "string" || text.trim().length === 0) {
			return null;
		}

		const cleanText = text.trim();
		if (this.cache.has(cleanText)) {
			return this.cache.get(cleanText);
		}

		try {
			const url = `${this.defaultEndpoint.replace(/\/+$/, "")}/api/embed`;
			const response = await axios.post(
				url,
				{
					model: this.defaultModel,
					input: cleanText
				},
				{
					timeout: this.timeoutMs,
					headers: { "Content-Type": "application/json" }
				}
			);

			const embeddingArray = response.data?.embeddings?.[0];
			if (!Array.isArray(embeddingArray) || embeddingArray.length === 0) {
				this.logger.warn(`Resposta inválida da API de embedding para: "${cleanText.slice(0, 50)}"`);
				return null;
			}

			const vector = new Float32Array(embeddingArray);
			this._addToCache(cleanText, vector);
			return vector;
		} catch (error) {
			this.logger.error(
				`Erro ao gerar embedding via Ollama (${this.defaultModel}): ${error.message}`
			);
			return null;
		}
	}

	/**
	 * Converte Float32Array para Buffer binário (armazenamento BLOB em SQLite)
	 * @param {Float32Array} floatArray
	 * @returns {Buffer}
	 */
	vectorToBuffer(floatArray) {
		if (!floatArray) return null;
		return Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
	}

	/**
	 * Converte Buffer binário do SQLite de volta para Float32Array
	 * @param {Buffer} buffer
	 * @returns {Float32Array|null}
	 */
	bufferToVector(buffer) {
		if (!buffer || !Buffer.isBuffer(buffer)) return null;
		return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
	}

	/**
	 * Calcula similaridade de cosseno entre dois vetores normalizados
	 * @param {Float32Array} vecA
	 * @param {Float32Array} vecB
	 * @returns {number} Score de similaridade entre -1.0 e 1.0
	 */
	cosineSimilarity(vecA, vecB) {
		if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
		let dot = 0;
		let normA = 0;
		let normB = 0;
		const len = vecA.length;

		for (let i = 0; i < len; i++) {
			const a = vecA[i];
			const b = vecB[i];
			dot += a * b;
			normA += a * a;
			normB += b * b;
		}

		if (normA === 0 || normB === 0) return 0;
		return dot / (Math.sqrt(normA) * Math.sqrt(normB));
	}

	_addToCache(key, value) {
		if (this.cache.size >= this.maxCacheSize) {
			// Remove o item mais antigo
			const firstKey = this.cache.keys().next().value;
			this.cache.delete(firstKey);
		}
		this.cache.set(key, value);
	}
}

module.exports = EmbeddingService;
