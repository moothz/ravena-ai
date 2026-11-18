"use strict";

const axios = require("axios");
const Logger = require("../utils/Logger");

/**
 * MessageThrottler — Fila com throttling progressivo por instância de bot.
 *
 * Funciona como uma fila FIFO em memória por instância de bot WhatsApp.
 * Aplica delays progressivos conforme a carga aumenta em relação ao rateLimit configurado.
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
 * Descarte:
 *   - Mensagens aguardando na fila por mais de 60 segundos são descartadas.
 *   - Ao descartar, envia alerta via Telegram para o dono
 *     (HEALTH_CHECK_TELEGRAM_BOT_TOKEN / HEALTH_CHECK_TELEGRAM_CHAT_ID).
 *   - O alerta é throttled: no máximo 1 alerta por instância a cada 5 minutos.
 */
class MessageThrottler {
	/**
	 * @param {string} botId - ID do bot (ex: "ravenavip")
	 * @param {number} rateLimit - Máximo de mensagens por minuto (0 = desabilitado)
	 */
	constructor(botId, rateLimit = 0) {
		this.botId = botId;
		this.rateLimit = rateLimit;
		this.logger = new Logger(`throttler-${botId}`);

		// Janela deslizante: array de { timestamp (ms), weight }
		this._window = [];

		// Fila FIFO: array de { fn, resolve, reject, weight, enqueuedAt }
		this._queue = [];

		// Controle do loop da fila
		this._processing = false;

		// Controle de alerta de descarte: timestamp do último alerta enviado
		this._lastDiscardAlertAt = 0;
		this._discardAlertCooldownMs = 5 * 60 * 1000; // 5 minutos

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
	 * Calcula o delay em ms baseado na carga atual (0–100%).
	 * @param {number} loadPercent - Carga atual em % (0 a 100)
	 * @returns {number} - Delay em ms
	 */
	_computeDelay(loadPercent) {
		if (loadPercent <= 20) return 0;
		if (loadPercent <= 50) {
			// 100ms a 300ms linear entre 20% e 50%
			return Math.round(100 + ((loadPercent - 20) / 30) * 200);
		}
		if (loadPercent <= 75) {
			// 400ms a 1200ms linear entre 50% e 75%
			return Math.round(400 + ((loadPercent - 50) / 25) * 800);
		}
		if (loadPercent <= 95) {
			// 1500ms a 2500ms linear entre 75% e 95%
			return Math.round(1500 + ((loadPercent - 75) / 20) * 1000);
		}
		// >= 95%: intervalo mínimo para honrar o limite
		return Math.round(60000 / this.rateLimit);
	}

	/**
	 * Enfileira a execução de uma função com throttling progressivo.
	 * Se rateLimit = 0, executa imediatamente sem fila.
	 *
	 * @param {Function} fn - Função async a executar
	 * @param {number} [weight=1.0] - Peso da ação (1.0 = mensagem, 0.333 = reação)
	 * @returns {Promise<any>}
	 */
	enqueue(fn, weight = 1.0) {
		if (!this.rateLimit || this.rateLimit <= 0) {
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

			// Verificar descarte por timeout (60 segundos na fila)
			const ageMs = Date.now() - item.enqueuedAt;
			if (ageMs > 60000) {
				this._queue.shift();
				this.queueSize = this._queue.length;
				this.logger.warn(
					`[throttler] Descartando mensagem (${ageMs.toFixed(0)}ms na fila, peso=${item.weight})`
				);
				item.reject(
					new Error(`THROTTLE_TIMEOUT: mensagem descartada após ${ageMs.toFixed(0)}ms na fila`)
				);
				await this._sendDiscardAlert(ageMs);
				continue;
			}

			// Calcular carga e delay
			const cost = this._getWindowCost();
			const loadPercent = Math.min(100, (cost / this.rateLimit) * 100);
			const delayMs = this._computeDelay(loadPercent);

			this.currentLoadPercent = Math.round(loadPercent);
			this.currentDelayMs = delayMs;

			if (delayMs > 0) {
				await new Promise((r) => setTimeout(r, delayMs));
			}

			// Verificar novamente após o delay
			const ageAfterDelay = Date.now() - item.enqueuedAt;
			if (ageAfterDelay > 60000) {
				this._queue.shift();
				this.queueSize = this._queue.length;
				this.logger.warn(
					`[throttler] Descartando mensagem após delay (${ageAfterDelay.toFixed(0)}ms na fila)`
				);
				item.reject(
					new Error(
						`THROTTLE_TIMEOUT: descartada após delay, ${ageAfterDelay.toFixed(0)}ms na fila`
					)
				);
				await this._sendDiscardAlert(ageAfterDelay);
				continue;
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
		this.currentLoadPercent = Math.round(
			(this._getWindowCost() / (this.rateLimit || 1)) * 100
		);
		this.currentDelayMs = 0;
	}

	/**
	 * Envia alerta via Telegram ao dono quando mensagens são descartadas.
	 * Rate-limited: no máximo 1 alerta a cada 5 minutos por instância.
	 * @param {number} ageMs - Idade em ms da mensagem descartada
	 */
	async _sendDiscardAlert(ageMs) {
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
		const cost = this._getWindowCost();
		const loadPercent =
			this.rateLimit > 0 ? Math.round((cost / this.rateLimit) * 100) : 0;

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
	 * @returns {{ loadPercent: number, delayMs: number, queueSize: number, rateLimit: number, windowCost: number }}
	 */
	getMetrics() {
		const cost = this._getWindowCost();
		const loadPercent =
			this.rateLimit > 0
				? Math.min(100, Math.round((cost / this.rateLimit) * 100))
				: 0;
		return {
			loadPercent,
			delayMs: this.currentDelayMs,
			queueSize: this.queueSize,
			rateLimit: this.rateLimit,
			windowCost: parseFloat(cost.toFixed(2))
		};
	}
}

module.exports = MessageThrottler;
