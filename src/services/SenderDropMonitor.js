const axios = require("axios");
const Logger = require("../utils/Logger");

/**
 * Escapa caracteres HTML para mensagens do Telegram com parse_mode: 'HTML'
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
	if (!str) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Monitora mensagens indecifráveis do WhatsApp com UnavailableType 'sender_drop'.
 * Quando um grupo sofre dessincronização de SenderKeys, o WhatsApp para de entregar
 * mensagens cifradas para este bot. Este serviço contabiliza os drops em uma janela deslizante
 * e envia um alerta no Telegram com o comando formatado para recuperação rápida.
 */
class SenderDropMonitor {
	static instance = null;

	static getInstance() {
		if (!SenderDropMonitor.instance) {
			SenderDropMonitor.instance = new SenderDropMonitor();
		}
		return SenderDropMonitor.instance;
	}

	constructor() {
		this.logger = new Logger("sender-drop-monitor");
		this.hits = new Map(); // key -> Array<number (timestamps)>
		this.lastAlert = new Map(); // key -> number (timestamp)

		this.threshold = parseInt(process.env.SENDER_DROP_ALERT_THRESHOLD, 10) || 15;
		this.windowMs = (parseInt(process.env.SENDER_DROP_ALERT_WINDOW_SEC, 10) || 300) * 1000;
		this.cooldownMs = (parseInt(process.env.SENDER_DROP_ALERT_COOLDOWN_SEC, 10) || 3600) * 1000;
	}

	/**
	 * Registra um evento de sender_drop e verifica se deve disparar alerta
	 * @param {Object} bot - Instância do bot que recebeu o evento
	 * @param {Object} data - Objeto do evento UndecryptableMessage
	 */
	recordDrop(bot, data) {
		try {
			const chatId = data?.Info?.Chat;
			if (!chatId || !chatId.endsWith("@g.us")) {
				return;
			}

			const botId = bot?.id || bot?.instanceName || "unknown-bot";
			const key = `${botId}|${chatId}`;
			const now = Date.now();

			// Atualiza janela deslizante
			const timestamps = (this.hits.get(key) || []).filter((ts) => now - ts <= this.windowMs);
			timestamps.push(now);
			this.hits.set(key, timestamps);

			const count = timestamps.length;
			const lastAlertTime = this.lastAlert.get(key) || 0;
			const shouldAlert = count >= this.threshold && now - lastAlertTime >= this.cooldownMs;

			if (shouldAlert) {
				this.lastAlert.set(key, now);
				this.dispatchAlert(bot, chatId, count).catch((err) => {
					this.logger.error(`[recordDrop] Erro ao despachar alerta para ${key}:`, err);
				});
			}
		} catch (err) {
			this.logger.error("[recordDrop] Erro inesperado ao processar drop:", err);
		}
	}

	/**
	 * Monta o texto do alerta e envia para o Telegram
	 * @param {Object} bot
	 * @param {string} chatId
	 * @param {number} dropCount
	 */
	async dispatchAlert(bot, chatId, dropCount) {
		const botId = bot?.id || bot?.instanceName || "ravena";
		const botExibir = bot?.nomeExibir || "";

		// Tenta obter o nome/título do grupo a partir do cache do EventHandler ou do bot
		let groupName = "";
		if (bot?.eventHandler?.groups?.[chatId]) {
			const grp = bot.eventHandler.groups[chatId];
			groupName = grp.titulo || grp.name || "";
		}

		const windowSec = Math.round(this.windowMs / 1000);
		const recoveryCmd = `cd whatsgoapi && node query-whatsgo.js ${botId} sendText ${chatId} "teste"`;

		const text =
			`⚠️ <b>sender_drop em massa detectado</b>\n` +
			`🤖 <b>Bot:</b> <code>${escapeHtml(botId)}</code>${botExibir ? ` (${escapeHtml(botExibir)})` : ""}\n` +
			`👥 <b>Grupo:</b> ${groupName ? `<b>${escapeHtml(groupName)}</b> ` : ""}<code>${escapeHtml(chatId)}</code>\n` +
			`📉 <b>Quedas:</b> ${dropCount} mensagens descartadas em ${windowSec}s\n` +
			`ℹ️ <i>O bot parou de decifrar mensagens deste grupo (sender-keys desatualizadas).</i>\n\n` +
			`💡 <b>Para restaurar, execute no host:</b>\n` +
			`<code>${escapeHtml(recoveryCmd)}</code>`;

		this.logger.warn(
			`[dispatchAlert] Disparando alerta de sender_drop em massa: ${botId} em ${chatId} (${dropCount} drops)`
		);

		return await this.sendTelegram(text);
	}

	/**
	 * Envia mensagem HTML para o Telegram configurado nas variáveis de ambiente
	 * @param {string} htmlMessage
	 * @returns {Promise<boolean>}
	 */
	async sendTelegram(htmlMessage) {
		const token = process.env.HEALTH_CHECK_TELEGRAM_BOT_TOKEN;
		const chatId = process.env.HEALTH_CHECK_TELEGRAM_CHAT_ID;

		if (!token || !chatId) {
			this.logger.warn(
				"[sendTelegram] HEALTH_CHECK_TELEGRAM_BOT_TOKEN ou HEALTH_CHECK_TELEGRAM_CHAT_ID não configurados. Alerta cancelado."
			);
			return false;
		}

		try {
			const url = `https://api.telegram.org/bot${token}/sendMessage`;
			const response = await axios.post(
				url,
				{
					chat_id: chatId,
					text: htmlMessage,
					parse_mode: "HTML",
					disable_web_page_preview: true
				},
				{ timeout: 15000 }
			);

			if (response.data && response.data.ok) {
				this.logger.info(
					`[sendTelegram] Alerta de sender_drop enviado com sucesso para o Telegram (${chatId})`
				);
				return true;
			}
			this.logger.error("[sendTelegram] Resposta inesperada do Telegram:", response.data);
			return false;
		} catch (error) {
			this.logger.error(`[sendTelegram] Falha ao enviar para o Telegram: ${error.message}`);
			return false;
		}
	}

	/**
	 * Reseta estado em memória (útil para testes unitários)
	 */
	reset() {
		this.hits.clear();
		this.lastAlert.clear();
	}
}

module.exports = SenderDropMonitor;
