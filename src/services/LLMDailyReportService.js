const axios = require("axios");
const Logger = require("../utils/Logger");
const StatsService = require("./StatsService");
const LLMService = require("./LLMService");

class LLMDailyReportService {
	constructor(options = {}) {
		this.logger = new Logger("llm-daily-report");
		this.statsService = new StatsService();
		this.llmService = LLMService.getInstance();

		this.telegramToken =
			options.telegramToken || process.env.HEALTH_CHECK_TELEGRAM_BOT_TOKEN || null;
		this.telegramChatId =
			options.telegramChatId || process.env.HEALTH_CHECK_TELEGRAM_CHAT_ID || null;

		this.targetHour = options.targetHour ?? 22; // 22:00
		this.targetMinute = options.targetMinute ?? 0;
		this.timeZone = options.timeZone || "America/Sao_Paulo";

		this.timer = null;
		this.isRunning = false;
		this.lastSentDate = null;
	}

	static getInstance(options = {}) {
		if (!LLMDailyReportService.instance) {
			LLMDailyReportService.instance = new LLMDailyReportService(options);
		}
		return LLMDailyReportService.instance;
	}

	/**
	 * Formata contagem de tokens de forma legível (ex: 1.2M, 350.5k)
	 * @param {number} num
	 * @returns {string}
	 */
	formatNumber(num) {
		const val = Number(num) || 0;
		if (val >= 1_000_000) {
			return `${(val / 1_000_000).toFixed(1)}M`;
		}
		if (val >= 1_000) {
			return `${(val / 1_000).toFixed(1)}k`;
		}
		return val.toLocaleString("pt-BR");
	}

	/**
	 * Coleta os dados de estatísticas e status da fila das últimas 24h
	 * @returns {Promise<Object>}
	 */
	async collectReportData() {
		const timeframe = 24 * 60 * 60 * 1000; // 24 horas
		const stats = await this.llmService.getStats(timeframe);
		const queueStatus = this.llmService.getQueueStatus();

		const totalRequests = Number(stats.total_requests) || 0;
		const totalFailures = Number(stats.total_failures) || 0;
		const successfulRequests = Math.max(0, totalRequests - totalFailures);
		const failureRate =
			totalRequests > 0 ? ((totalFailures / totalRequests) * 100).toFixed(2) : "0.00";

		let queuePending = 0;
		let queueProcessing = 0;
		let queueFulfilled = 0;
		let queueFailed = 0;

		if (queueStatus && typeof queueStatus === "object") {
			for (const p of Object.keys(queueStatus)) {
				const q = queueStatus[p];
				if (q) {
					queuePending += Number(q.pending) || 0;
					queueProcessing += Number(q.processing) || 0;
					queueFulfilled += Number(q.fulfilled) || 0;
					queueFailed += Number(q.failed) || 0;
				}
			}
		}

		return {
			stats,
			queueStatus,
			summary: {
				totalRequests,
				successfulRequests,
				totalFailures,
				failureRate,
				totalInputTokens: stats.total_input_tokens || 0,
				totalOutputTokens: stats.total_output_tokens || 0,
				queuePending,
				queueProcessing,
				queueFulfilled,
				queueFailed
			}
		};
	}

	/**
	 * Constrói a mensagem HTML a partir dos dados coletados
	 * @param {Object} reportData
	 * @param {string} [customTitle]
	 * @returns {string}
	 */
	buildReportMessage(reportData, customTitle = null) {
		const { stats, summary } = reportData;

		const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
			timeZone: this.timeZone,
			day: "2-digit",
			month: "2-digit",
			year: "numeric"
		});
		const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
			timeZone: this.timeZone,
			hour: "2-digit",
			minute: "2-digit",
			hour12: false
		});

		const now = new Date();
		const dateStr = dateFormatter.format(now);
		const timeStr = timeFormatter.format(now);

		const title = customTitle || "📊 <b>Relatório Diário de IA — Ravena Bot</b>";

		let msg = `${title}\n`;
		msg += `📅 <i>${dateStr} (${timeStr} - Últimas 24h)</i>\n\n`;

		msg += `📥 <b>Total de Requisições:</b> ${summary.totalRequests.toLocaleString("pt-BR")}\n`;
		msg += `✅ <b>Atendidas com Sucesso:</b> ${summary.successfulRequests.toLocaleString("pt-BR")}\n`;
		msg += `❌ <b>Falhas:</b> ${summary.totalFailures.toLocaleString("pt-BR")}\n`;
		msg += `📉 <b>Taxa de Falha:</b> <b>${summary.failureRate}%</b>\n\n`;

		const totalTokens = (summary.totalInputTokens || 0) + (summary.totalOutputTokens || 0);
		msg += `🪙 <b>Tokens Consumidos:</b>\n`;
		msg += `• Entrada: ${this.formatNumber(summary.totalInputTokens)} tokens\n`;
		msg += `• Saída: ${this.formatNumber(summary.totalOutputTokens)} tokens\n`;
		msg += `• Total: ${this.formatNumber(totalTokens)} tokens\n\n`;

		if (stats.by_type && typeof stats.by_type === "object") {
			msg += `📁 <b>Distribuição por Tipo:</b>\n`;
			const typeIcons = {
				text: "💬 Texto",
				image: "🖼️ Imagem",
				video: "🎥 Vídeo",
				stt: "🎙️ Áudio/STT",
				tts: "🔊 Síntese/TTS"
			};

			for (const [typeKey, label] of Object.entries(typeIcons)) {
				const item = stats.by_type[typeKey];
				if (item && (item.requests > 0 || item.failures > 0)) {
					const reqs = Number(item.requests) || 0;
					const fails = Number(item.failures) || 0;
					const totalType = reqs + fails;
					const failPct = totalType > 0 ? ((fails / totalType) * 100).toFixed(1) : "0.0";
					msg += `• ${label}: ${totalType.toLocaleString("pt-BR")} reqs (${failPct}% falhas)\n`;
				}
			}
			msg += `\n`;
		}

		if (stats.by_provider && typeof stats.by_provider === "object") {
			const providerEntries = Object.entries(stats.by_provider).filter(
				([, p]) => (p.requests || 0) > 0 || (p.failures || 0) > 0
			);

			if (providerEntries.length > 0) {
				msg += `🤖 <b>Por Provedor Ativo:</b>\n`;
				for (const [pName, pData] of providerEntries) {
					const reqs = Number(pData.requests) || 0;
					const fails = Number(pData.failures) || 0;
					const totalProv = reqs + fails;
					const failPct = totalProv > 0 ? ((fails / totalProv) * 100).toFixed(1) : "0.0";
					msg += `• <code>${pName}</code>: ${totalProv.toLocaleString("pt-BR")} reqs | ${fails} falha(s) (${failPct}%)\n`;
				}
				msg += `\n`;
			}
		}

		msg += `🚦 <b>Status Atual da Fila (Queue):</b>\n`;
		msg += `• Pendentes agora: ${summary.queuePending}\n`;
		msg += `• Em processamento: ${summary.queueProcessing}\n`;
		msg += `• Atendidos na sessão: ${summary.queueFulfilled.toLocaleString("pt-BR")} | Falhas na sessão: ${summary.queueFailed.toLocaleString("pt-BR")}`;

		return msg;
	}

	/**
	 * Envia mensagem para o Telegram
	 * @param {string} htmlMessage
	 * @returns {Promise<boolean>}
	 */
	async sendTelegram(htmlMessage) {
		const token = this.telegramToken || process.env.HEALTH_CHECK_TELEGRAM_BOT_TOKEN;
		const chatId = this.telegramChatId || process.env.HEALTH_CHECK_TELEGRAM_CHAT_ID;

		if (!token || !chatId) {
			this.logger.warn(
				"[sendTelegram] TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não configurados. Envio cancelado."
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
					parse_mode: "HTML"
				},
				{ timeout: 15000 }
			);

			if (response.data && response.data.ok) {
				this.logger.info(`[sendTelegram] Relatório enviado com sucesso para o chat ${chatId}`);
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
	 * Gera e envia o relatório imediatamente (sob demanda ou agendado)
	 * @param {string} [customTitle]
	 * @returns {Promise<Object>}
	 */
	async sendReportNow(customTitle = null) {
		try {
			this.logger.info("[sendReportNow] Coletando estatísticas do LLM...");
			const data = await this.collectReportData();
			const message = this.buildReportMessage(data, customTitle);
			const sent = await this.sendTelegram(message);

			return {
				success: sent,
				data: data.summary,
				message
			};
		} catch (error) {
			this.logger.error("[sendReportNow] Erro ao gerar/enviar relatório:", error);
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * Verifica periodicamente se atingiu o horário agendado (22:00 BRT)
	 */
	checkSchedule() {
		const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
			timeZone: this.timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit"
		});
		const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
			timeZone: this.timeZone,
			hour: "2-digit",
			minute: "2-digit",
			hour12: false
		});

		const now = new Date();
		const currentDate = dateFormatter.format(now);
		const currentTime = timeFormatter.format(now);
		const [hourStr, minStr] = currentTime.split(":");
		const hour = parseInt(hourStr, 10);
		const minute = parseInt(minStr, 10);

		if (hour === this.targetHour && minute === this.targetMinute) {
			if (this.lastSentDate !== currentDate) {
				this.lastSentDate = currentDate;
				this.logger.info(
					`[checkSchedule] Horário ${currentTime} atingido (${currentDate}). Disparando relatório diário...`
				);
				this.sendReportNow().catch((err) => {
					this.logger.error("[checkSchedule] Erro no envio automático das 22h:", err);
				});
			}
		}
	}

	/**
	 * Inicia o serviço de verificação periódica (a cada 30 segundos)
	 */
	start() {
		if (this.isRunning) return;
		this.isRunning = true;
		this.logger.info(
			`[LLMDailyReportService] Iniciado. Envio diário configurado para as ${String(this.targetHour).padStart(2, "0")}:${String(this.targetMinute).padStart(2, "0")} (${this.timeZone}).`
		);

		this.timer = setInterval(() => {
			try {
				this.checkSchedule();
			} catch (e) {
				this.logger.error("[checkSchedule] Erro na verificação do agendador:", e);
			}
		}, 30 * 1000);
	}

	/**
	 * Para o serviço
	 */
	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.isRunning = false;
		this.logger.info("[LLMDailyReportService] Parado.");
	}
}

module.exports = LLMDailyReportService;
