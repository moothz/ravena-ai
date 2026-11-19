"use strict";

const crypto = require("crypto");
const axios = require("axios");
const Logger = require("../utils/Logger");

/**
 * MessageThrottler — Fila com throttling progressivo por instância de bot.
 *
 * Funciona como uma fila FIFO em memória por instância de bot WhatsApp.
 * Aplica delays progressivos conforme a carga aumenta em relação ao rateLimit configurado.
 * Também aplica delays orgânicos aleatórios e anti-duplicação por hashing (janela 24h).
 *
 * Pesos:
 *   - Mensagem normal (texto, mídia, sticker, etc.): peso 1.0
 *   - Reação (react): peso 1/3 (0.333...)
 *
 * Curva de throttling (% da cota usada nos últimos 60s):
 *   - 0%  a 20%: delay 0ms (envio imediato)
 *   - 20% a 50%: delay 100ms a 300ms (linear)
 *   - 50% a 75%: delay 400ms a 1200ms (linear)
 *   - 75% a 95%: delay 1500ms a 2500ms (linear)
 *   - 95% a 100%: delay = 60000ms / rateLimit (mínimo para honrar o limite)
 *
 * Delay Orgânico:
 *   - delayMin e delayMax (em segundos). Padrão 0 a 2 para bots com rateLimit ativo.
 *   - Gera atraso aleatório entre delayMin e delayMax ms antes de enviar mensagem.
 *
 * Anti-Spam / Hashing (Janela de 24 horas):
 *   - Textos e legendas idênticas nas últimas 24h recebem sufixo "\n> <salt>"
 *   - Imagens/vídeos sem legenda repetidos recebem caption discreto "> <salt>"
 *   - Áudios e stickers repetidos recebem 1 byte de padding seguro no final do Buffer.
 *
 * Descarte:
 *   - Mensagens aguardando na fila por mais de 60 segundos são descartadas.
 *   - Ao descartar, envia alerta via Telegram para o dono.
 */
class MessageThrottler {
	/**
	 * @param {string} botId - ID do bot (ex: "ravenavip")
	 * @param {number} [rateLimit=0] - Máximo de mensagens por minuto (0 = desabilitado)
	 * @param {number} [delayMin=0] - Delay orgânico mínimo em segundos
	 * @param {number} [delayMax=0] - Delay orgânico máximo em segundos
	 */
	constructor(botId, rateLimit = 0, delayMin = 0, delayMax = 0) {
		this.botId = botId;
		this.rateLimit = rateLimit;
		this.delayMin = Number(delayMin) || 0;
		this.delayMax = Number(delayMax) || 0;
		this.logger = new Logger(`throttler-${botId}`);

		// Janela deslizante de custo: array de { timestamp (ms), weight }
		this._window = [];

		// Fila FIFO: array de { fn, resolve, reject, weight, enqueuedAt }
		this._queue = [];

		// Controle do loop da fila
		this._processing = false;

		// Controle de alerta de descarte: timestamp do último alerta enviado
		this._lastDiscardAlertAt = 0;
		this._discardAlertCooldownMs = 5 * 60 * 1000; // 5 minutos

		// Janela de 24 horas para anti-duplicação: Map de hash -> timestamp (ms)
		this._sentHashes = new Map();
		this._hashesTtlMs = 24 * 60 * 60 * 1000; // 24 horas

		// Métricas expostas externamente
		this.queueSize = 0;
		this.currentLoadPercent = 0;
		this.currentDelayMs = 0;
	}

	/**
	 * Remove entradas com mais de 60s da janela deslizante e retorna o custo atual.
	 * @returns {number} - Soma de pesos dos últimos 60 segundos
	 */
	_getWindowCost() {
		const cutoff = Date.now() - 60000;
		this._window = this._window.filter((e) => e.timestamp > cutoff);
		return this._window.reduce((sum, e) => sum + e.weight, 0);
	}

	/**
	 * Calcula o delay de throttling em ms baseado na carga atual (0–100%+).
	 * Freio progressivo suave: não segura a fila desnecessariamente enquanto houver cota.
	 * @param {number} loadPercent - Carga atual em % (0 a 100+)
	 * @returns {number} - Delay em ms
	 */
	_computeDelay(loadPercent) {
		if (loadPercent <= 40) return 0;
		if (loadPercent <= 70) {
			// 100ms a 300ms linear entre 40% e 70%
			return Math.round(100 + ((loadPercent - 40) / 30) * 200);
		}
		if (loadPercent <= 90) {
			// 300ms a 800ms linear entre 70% e 90%
			return Math.round(300 + ((loadPercent - 70) / 20) * 500);
		}
		if (loadPercent < 100) {
			// 800ms a 1500ms linear entre 90% e 100%
			return Math.round(800 + ((loadPercent - 90) / 10) * 700);
		}
		// >= 100%: intervalo mínimo para honrar o limite (espaçamento estrito)
		return Math.round(60000 / this.rateLimit);
	}

	/**
	 * Calcula delay orgânico aleatório em ms entre delayMin e delayMax.
	 * @returns {number} - Delay em ms
	 */
	_computeOrganicDelay() {
		if (this.delayMax <= 0 || this.delayMax < this.delayMin) return 0;
		const minMs = Math.round(this.delayMin * 1000);
		const maxMs = Math.round(this.delayMax * 1000);
		return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
	}

	/**
	 * Limpa hashes expirados da janela de 24 horas.
	 */
	_cleanOldHashes() {
		const cutoff = Date.now() - this._hashesTtlMs;
		for (const [hash, ts] of this._sentHashes.entries()) {
			if (ts < cutoff) {
				this._sentHashes.delete(hash);
			}
		}
	}

	/**
	 * Evita que mensagens com conteúdo idêntico sejam enviadas na janela de 24h.
	 * - Textos e legendas: adiciona "\n> <salt>" ao final se o hash já foi visto.
	 * - Imagens e vídeos sem legenda: adiciona "> <salt>" como caption se repetidos.
	 * - Áudios e stickers: adiciona 1 byte de padding seguro no final do Buffer.
	 *
	 * @param {string} endpoint - Endpoint da API (/send/text, /send/media, /send/sticker, etc.)
	 * @param {Object} payload - Payload montado para envio
	 */
	applyAntiDuplicate(endpoint, payload) {
		if (!payload || typeof payload !== "object") return;
		this._cleanOldHashes();

		// 1. Tratamento para texto puro (/send/text, /send/link)
		if (typeof payload.text === "string" && payload.text.trim()) {
			const raw = payload.text.trim();
			const hash = crypto.createHash("sha256").update(raw).digest("hex");
			if (this._sentHashes.has(hash)) {
				const salt = crypto.randomBytes(3).toString("hex").slice(0, 5);
				payload.text += `\n> ${salt}`;
				const newHash = crypto.createHash("sha256").update(payload.text.trim()).digest("hex");
				this._sentHashes.set(newHash, Date.now());
			} else {
				this._sentHashes.set(hash, Date.now());
			}
			return;
		}

		// 2. Tratamento para mídia com legenda (/send/media)
		if (typeof payload.caption === "string" && payload.caption.trim()) {
			const raw = payload.caption.trim();
			const hash = crypto.createHash("sha256").update(raw).digest("hex");
			if (this._sentHashes.has(hash)) {
				const salt = crypto.randomBytes(3).toString("hex").slice(0, 5);
				payload.caption += `\n> ${salt}`;
				const newHash = crypto.createHash("sha256").update(payload.caption.trim()).digest("hex");
				this._sentHashes.set(newHash, Date.now());
			} else {
				this._sentHashes.set(hash, Date.now());
			}
			return;
		}

		// 3. Imagens e vídeos sem legenda (/send/media)
		if (endpoint === "/send/media" && (!payload.caption || !payload.caption.trim())) {
			const type = payload.type || "";
			if (type === "image" || type === "video" || type === "gif") {
				const mediaKey =
					typeof payload.data === "string" ? payload.data.slice(0, 512) : payload.url || "";
				if (mediaKey) {
					const hash = crypto.createHash("sha256").update(`media:${mediaKey}`).digest("hex");
					if (this._sentHashes.has(hash)) {
						const salt = crypto.randomBytes(3).toString("hex").slice(0, 5);
						payload.caption = `> ${salt}`;
						this._sentHashes.set(hash + ":salted", Date.now());
					} else {
						this._sentHashes.set(hash, Date.now());
					}
					return;
				}
			}
		}

		// 4. Áudios e stickers (Byte padding no final do Buffer)
		const isSticker = endpoint === "/send/sticker";
		const isAudio = payload.type === "audio";
		if ((isSticker || isAudio) && typeof payload.data === "string" && payload.data.length > 0) {
			const rawHash = crypto.createHash("sha256").update(payload.data.slice(0, 1024)).digest("hex");
			if (this._sentHashes.has(rawHash)) {
				try {
					const buf = Buffer.from(payload.data, "base64");
					// Padding seguro de 1 byte aleatório no final
					const padded = Buffer.concat([buf, crypto.randomBytes(1)]);
					payload.data = padded.toString("base64");
					const newHash = crypto
						.createHash("sha256")
						.update(payload.data.slice(0, 1024))
						.digest("hex");
					this._sentHashes.set(newHash, Date.now());
				} catch (err) {
					// Fallback silencioso se houver falha de base64
				}
			} else {
				this._sentHashes.set(rawHash, Date.now());
			}
		}
	}

	/**
	 * Enfileira a execução de uma função com throttling progressivo e delay orgânico.
	 * Se rateLimit = 0 e delayMax = 0, executa imediatamente sem fila.
	 *
	 * @param {Function} fn - Função async a executar
	 * @param {number} [weight=1.0] - Peso da ação (1.0 = mensagem, 0.333 = reação)
	 * @returns {Promise<any>}
	 */
	enqueue(fn, weight = 1.0) {
		if ((!this.rateLimit || this.rateLimit <= 0) && (!this.delayMax || this.delayMax <= 0)) {
			return fn();
		}

		return new Promise((resolve, reject) => {
			const item = {
				fn,
				resolve,
				reject,
				weight,
				enqueuedAt: Date.now()
			};
			this._queue.push(item);
			this.queueSize = this._queue.length;

			if (!this._processing) {
				this._processQueue();
			}
		});
	}

	/**
	 * Loop de processamento FIFO da fila.
	 */
	async _processQueue() {
		this._processing = true;

		while (this._queue.length > 0) {
			const item = this._queue[0];
			const cost = this._getWindowCost();
			const loadPercent = this.rateLimit > 0 ? (cost / this.rateLimit) * 100 : 0;
			const isOverLimit = this.rateLimit > 0 && cost >= this.rateLimit;
			const ageMs = Date.now() - item.enqueuedAt;

			// Regra de descarte inteligente:
			// NUNCA descarta se a carga estiver abaixo de 100% da cota.
			// Só descarta se a cota estiver totalmente saturada (>= 100%) E a mensagem aguardar há mais de 90s.
			if (isOverLimit && ageMs > 90000) {
				this._queue.shift();
				this.queueSize = this._queue.length;
				this.logger.warn(
					`[throttler] Descartando mensagem por sobrecarga (${ageMs.toFixed(0)}ms na fila, cota=${cost.toFixed(1)}/${this.rateLimit}, peso=${item.weight})`
				);
				item.reject(
					new Error(
						`THROTTLE_TIMEOUT: mensagem descartada por sobrecarga após ${ageMs.toFixed(0)}ms na fila`
					)
				);
				await this._sendDiscardAlert(ageMs, cost);
				continue;
			}

			// Calcular delay de throttling baseado na carga atual
			const throttleDelayMs = this._computeDelay(loadPercent);

			// Calcular delay orgânico (aplicado apenas a mensagens com peso >= 1.0)
			const organicDelayMs = item.weight >= 1.0 ? this._computeOrganicDelay() : 0;
			const totalDelayMs = throttleDelayMs + organicDelayMs;

			this.currentLoadPercent = Math.min(100, Math.round(loadPercent));
			this.currentDelayMs = totalDelayMs;

			if (totalDelayMs > 0) {
				await new Promise((r) => setTimeout(r, totalDelayMs));
			}

			// Executar
			this._queue.shift();
			this.queueSize = this._queue.length;

			try {
				const result = await item.fn();
				// Registrar na janela apenas após envio bem-sucedido
				this._window.push({ timestamp: Date.now(), weight: item.weight });
				item.resolve(result);
			} catch (err) {
				item.reject(err);
			}
		}

		this._processing = false;
		this.queueSize = 0;
		this.currentLoadPercent =
			this.rateLimit > 0
				? Math.min(100, Math.round((this._getWindowCost() / this.rateLimit) * 100))
				: 0;
		this.currentDelayMs = 0;
	}

	/**
	 * Envia alerta via Telegram ao dono quando mensagens são descartadas por sobrecarga.
	 * Rate-limited: no máximo 1 alerta a cada 5 minutos por instância.
	 * @param {number} ageMs - Idade em ms da mensagem descartada
	 * @param {number} [currentCost=null] - Custo atual da janela de 60s
	 */
	async _sendDiscardAlert(ageMs, currentCost = null) {
		const now = Date.now();
		if (now - this._lastDiscardAlertAt < this._discardAlertCooldownMs) {
			return;
		}
		this._lastDiscardAlertAt = now;

		const token = process.env.HEALTH_CHECK_TELEGRAM_BOT_TOKEN;
		const chatId = process.env.HEALTH_CHECK_TELEGRAM_CHAT_ID;

		if (!token || !chatId) {
			this.logger.warn(
				"[throttler] HEALTH_CHECK_TELEGRAM_* não configurados. Alerta de descarte cancelado."
			);
			return;
		}

		const queueLen = this._queue.length;
		const cost = typeof currentCost === "number" ? currentCost : this._getWindowCost();
		const loadPercent = this.rateLimit > 0 ? Math.round((cost / this.rateLimit) * 100) : 0;

		const message =
			`⚠️ <b>[THROTTLE] Bot ${this.botId}</b> descartou mensagem!\n\n` +
			`• Mensagem aguardou: <b>${(ageMs / 1000).toFixed(1)}s</b> na fila\n` +
			`• Carga atual: <b>${loadPercent}%</b> (${cost.toFixed(1)}/${this.rateLimit} msgs/min)\n` +
			`• Fila restante: <b>${queueLen} msgs</b>\n` +
			`• Rate Limit configurado: <b>${this.rateLimit} msgs/min</b>\n\n` +
			`🔧 Considere aumentar o <code>ratelimit</code> desta instância no painel /instances.`;

		try {
			const url = `https://api.telegram.org/bot${token}/sendMessage`;
			await axios.post(
				url,
				{
					chat_id: chatId,
					text: message,
					parse_mode: "HTML",
					disable_web_page_preview: true
				},
				{ timeout: 15000 }
			);
			this.logger.info(
				`[throttler] Alerta de descarte enviado ao Telegram para o bot ${this.botId}`
			);
		} catch (err) {
			this.logger.error(`[throttler] Falha ao enviar alerta de descarte: ${err.message}`);
		}
	}

	/**
	 * Retorna métricas atuais do throttler para exposição no painel e OS desktop.
	 * @returns {{ loadPercent: number, delayMs: number, queueSize: number, rateLimit: number, windowCost: number, delayMin: number, delayMax: number, trackedHashes: number }}
	 */
	getMetrics() {
		const cost = this._getWindowCost();
		const loadPercent =
			this.rateLimit > 0 ? Math.min(100, Math.round((cost / this.rateLimit) * 100)) : 0;
		return {
			loadPercent,
			delayMs: this.currentDelayMs,
			queueSize: this.queueSize,
			rateLimit: this.rateLimit,
			windowCost: parseFloat(cost.toFixed(2)),
			delayMin: this.delayMin,
			delayMax: this.delayMax,
			trackedHashes: this._sentHashes.size
		};
	}
}

module.exports = MessageThrottler;
