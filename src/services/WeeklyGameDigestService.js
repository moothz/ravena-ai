const Logger = require("../utils/Logger");
const SlotsGame = require("../functions/SlotsGame");
const FishingGame = require("../functions/FishingGame");
const RoletaRussaCommands = require("../functions/RoletaRussaCommands");
const AnagramGame = require("../functions/AnagramGame");
const StopGame = require("../functions/StopGame");
const PintoGame = require("../functions/PintoGame");
const ReturnMessage = require("../models/ReturnMessage");

class WeeklyGameDigestService {
	constructor(options = {}) {
		this.logger = new Logger("weekly-game-digest");
		this.targetDay = options.targetDay ?? 0; // 0 = Domingo
		this.targetHour = options.targetHour ?? 22; // 22:00
		this.targetMinute = options.targetMinute ?? 0;
		this.timeZone = options.timeZone || "America/Sao_Paulo";

		this.timer = null;
		this.isRunning = false;
		this.lastSentDateKey = null;
		this.registeredBots = new Set();
	}

	static getInstance(options = {}) {
		if (!WeeklyGameDigestService.instance) {
			WeeklyGameDigestService.instance = new WeeklyGameDigestService(options);
		}
		return WeeklyGameDigestService.instance;
	}

	registerBot(bot) {
		if (bot && bot.id) {
			this.registeredBots.add(bot);
		}
	}

	unregisterBot(bot) {
		if (bot) {
			this.registeredBots.delete(bot);
		}
	}

	/**
	 * Gera o resumo semanal agregando os 6 jogos (omitindo os jogos sem pontuação)
	 * @param {number} [sinceMs]
	 * @returns {Promise<string|null>}
	 */
	async generateWeeklyDigest(sinceMs = null) {
		const now = new Date();
		const startOfWeek = sinceMs || now.getTime() - 7 * 24 * 60 * 60 * 1000;

		const [slotsStats, fishingStats, roletaStats, anagramStats, stopStats, pintoStats] =
			await Promise.all([
				SlotsGame.getWeeklySlotsStats(startOfWeek),
				FishingGame.getWeeklyFishingStats(startOfWeek),
				RoletaRussaCommands.getWeeklyRoletaStats(startOfWeek),
				AnagramGame.getWeeklyAnagramStats(startOfWeek),
				StopGame.getWeeklyStopStats(startOfWeek),
				PintoGame.getWeeklyPintoStats(startOfWeek)
			]);

		const medals = ["🥇", "🥈", "🥉"];
		const sections = [];

		// 1. Pescaria (FishingGame)
		if (fishingStats && fishingStats.length > 0) {
			let sec = `🎣 *PESCARIA - TOP 10 PESCADORES*\n_Critério: Score Combinado (Peso + Peixes x5)_\n`;
			fishingStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				sec += `${medal} *${p.user_name}* — 🎖️ ${p.score.toLocaleString("pt-BR")} pts (${p.total_catches} peixes | ${p.total_weight.toFixed(2)} kg)\n`;
			});
			sections.push(sec.trim());
		}

		// 2. Slots
		if (slotsStats && slotsStats.length > 0) {
			let sec = `🎰 *SLOTS - REIS DO CAÇA-COISAS*\n_Ordenado por Vitórias (menos jogadas = melhor taxa)_\n`;
			slotsStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				sec += `${medal} *${p.user_name}* — ${p.wins} vitórias (${p.plays} jogadas, ${p.coins_spent} moedas gastas)\n`;
			});
			sections.push(sec.trim());
		}

		// 3. Roleta
		if (roletaStats && roletaStats.length > 0) {
			let sec = `🎲 *ROLETA RUSSA - MAIORES SOBREVIVENTES*\n_Ordenado por Sobrevivências no Gatilho_\n`;
			roletaStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				const statusIcon = p.isAlive ? "🛡️" : "💀";
				sec += `${medal} ${statusIcon} *${p.user_name}* — ${p.survivals} sobrevivências no gatilho\n`;
			});
			sections.push(sec.trim());
		}

		// 4. Pinto
		if (pintoStats && pintoStats.length > 0) {
			let sec = `🍆 *PINTO GAME - MAIORES DA SEMANA*\n`;
			pintoStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				sec += `${medal} *${p.user_name}* — ${p.erect.toFixed(1)} cm (Score: ${p.score})\n`;
			});
			sections.push(sec.trim());
		}

		// 5. Anagrama
		if (anagramStats && anagramStats.length > 0) {
			let sec = `🔤 *ANAGRAMA - MESTRES DAS PALAVRAS*\n`;
			anagramStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				sec += `${medal} *${p.user_name}* — ${p.points} pontos\n`;
			});
			sections.push(sec.trim());
		}

		// 6. Adedonha (StopGame)
		if (stopStats && stopStats.length > 0) {
			let sec = `✏️ *ADEDONHA - REIS DO STOP*\n`;
			stopStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				const winText = p.wins > 0 ? ` (${p.wins} vitórias)` : "";
				sec += `${medal} *${p.user_name}* — ${p.points} pontos${winText}\n`;
			});
			sections.push(sec.trim());
		}

		if (sections.length === 0) {
			return null;
		}

		const header = `🏆 *RESUMO DA SEMANA DOS JOGOS DA RAVENA* 🏆\n\n`;

		const footer = `\n✨ *Parabéns a todos os campeões da semana! Novo ciclo iniciado!* 🚀`;

		return header + sections.join("\n\n") + "\n" + footer;
	}

	/**
	 * Dispara a notificação semanal para os grupos de avisos/logs
	 */
	async sendDigest() {
		try {
			this.logger.info("[sendDigest] Gerando resumo semanal dos jogos...");
			const digestText = await this.generateWeeklyDigest();
			if (!digestText) {
				this.logger.info(
					"[sendDigest] Nenhum jogo teve dados registrados na semana. Envio omitido."
				);
				return false;
			}

			const bots = Array.from(this.registeredBots);
			if (bots.length === 0) {
				this.logger.warn("[sendDigest] Nenhum bot registrado no WeeklyGameDigestService.");
				return false;
			}

			// Localiza estritamente o bot principal do WhatsApp (notificarDonate: true, ex: ravenavip)
			// NUNCA seleciona bots do Telegram ou Discord
			const targetBot =
				bots.find(
					(b) =>
						!b.useTelegram && !b.useDiscord && b.notificarDonate && (b.isConnected || b.testMode)
				) ||
				bots.find(
					(b) =>
						!b.useTelegram && !b.useDiscord && b.id === "ravenavip" && (b.isConnected || b.testMode)
				) ||
				bots.find((b) => !b.useTelegram && !b.useDiscord && (b.isConnected || b.testMode));

			if (!targetBot) {
				this.logger.warn(
					"[sendDigest] Nenhum bot WhatsApp habilitado (ravenavip / notificarDonate) conectado para envio."
				);
				return false;
			}

			// Destinos: APENAS GRUPO_ANUNCIOS e GRUPO_AVISOS do .env (ou configurados no bot)
			// NUNCA envia para grupoLogs ou outros grupos!
			const targets = [];
			if (process.env.GRUPO_ANUNCIOS && process.env.GRUPO_ANUNCIOS.trim()) {
				targets.push(process.env.GRUPO_ANUNCIOS.trim());
			} else if (targetBot.grupoAnuncios) {
				targets.push(targetBot.grupoAnuncios);
			}

			if (process.env.GRUPO_AVISOS && process.env.GRUPO_AVISOS.trim()) {
				targets.push(process.env.GRUPO_AVISOS.trim());
			} else if (targetBot.grupoAvisos) {
				targets.push(targetBot.grupoAvisos);
			}

			if (targets.length === 0) {
				this.logger.warn(
					"[sendDigest] Nenhum destino configurado (GRUPO_ANUNCIOS / GRUPO_AVISOS). Envio omitido."
				);
				return false;
			}

			let sentCount = 0;
			const processedTargets = new Set();

			for (const targetChat of targets) {
				if (!targetChat || processedTargets.has(targetChat)) continue;
				processedTargets.add(targetChat);
				try {
					if (typeof targetBot.sendReturnMessages === "function") {
						await targetBot.sendReturnMessages(
							new ReturnMessage({
								chatId: targetChat,
								content: digestText
							})
						);
					} else if (typeof targetBot.sendMessage === "function") {
						await targetBot.sendMessage(targetChat, digestText);
					}
					sentCount++;
					this.logger.info(
						`[sendDigest] Resumo semanal enviado para ${targetChat} via bot ${targetBot.id}`
					);
				} catch (errBot) {
					this.logger.error(
						`[sendDigest] Erro ao enviar para ${targetChat} via bot ${targetBot.id}:`,
						errBot
					);
				}
			}

			return sentCount > 0;
		} catch (error) {
			this.logger.error("[sendDigest] Erro ao gerar/enviar resumo semanal:", error);
			return false;
		}
	}

	/**
	 * Checa periodicamente o relógio para o agendamento de Domingo às 22:00 BRT
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
		const dateStr = dateFormatter.format(now);
		const timeStr = timeFormatter.format(now);
		const [hourStr, minStr] = timeStr.split(":");
		const hour = parseInt(hourStr, 10);
		const minute = parseInt(minStr, 10);

		// Converte dia da semana (0 = Domingo em JS getDay)
		// Nota: getDay do Date em UTC pode diferir; usamos o fuso SP
		const dayFormatter = new Intl.DateTimeFormat("en-US", {
			timeZone: this.timeZone,
			weekday: "short"
		});
		const weekdayStr = dayFormatter.format(now); // "Sun", "Mon", ...
		const isSunday = weekdayStr === "Sun";

		if (isSunday && hour === this.targetHour && minute === this.targetMinute) {
			const key = `${dateStr}-${hour}:${minute}`;
			if (this.lastSentDateKey !== key) {
				this.lastSentDateKey = key;
				this.logger.info(
					`[checkSchedule] Horário ${timeStr} de domingo atingido (${dateStr}). Disparando resumo semanal...`
				);
				this.sendDigest().catch((err) => {
					this.logger.error("[checkSchedule] Erro na execução automática do resumo semanal:", err);
				});
			}
		}
	}

	start() {
		if (this.isRunning) return;
		if (process.env.DISABLE_ACTIVITY === "true") {
			this.logger.info("[WeeklyGameDigestService] DISABLE_ACTIVITY=true. Agendador não iniciado.");
			return;
		}

		this.isRunning = true;
		this.logger.info(
			`[WeeklyGameDigestService] Iniciado. Agendado para Domingos às ${String(this.targetHour).padStart(2, "0")}:${String(this.targetMinute).padStart(2, "0")} (${this.timeZone}).`
		);

		this.timer = setInterval(() => {
			try {
				this.checkSchedule();
			} catch (e) {
				this.logger.error("[checkSchedule] Erro na verificação do agendador semanal:", e);
			}
		}, 30 * 1000);
	}

	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.isRunning = false;
		this.logger.info("[WeeklyGameDigestService] Parado.");
	}
}

module.exports = WeeklyGameDigestService;
