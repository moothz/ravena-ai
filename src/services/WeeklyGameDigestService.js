const Logger = require("../utils/Logger");
const SlotsGame = require("../functions/SlotsGame");
const FishingGame = require("../functions/FishingGame");
const RoletaRussaCommands = require("../functions/RoletaRussaCommands");
const AnagramGame = require("../functions/AnagramGame");
const StopGame = require("../functions/StopGame");
const PintoGame = require("../functions/PintoGame");
const FazendaCommands = require("../functions/FazendaCommands");
const WaifuCommands = require("../functions/WaifuCommands");
const Database = require("../utils/Database");
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
	 * Gera o resumo semanal agregando os jogos, fazenda, waifus e atividade
	 * @param {number} [sinceMs]
	 * @param {boolean} [saveSnapshot=false]
	 * @returns {Promise<string|null>}
	 */
	async generateWeeklyDigest(sinceMs = null, saveSnapshot = false) {
		const now = new Date();
		const startOfWeek = sinceMs || now.getTime() - 7 * 24 * 60 * 60 * 1000;
		const database = Database.getInstance();
		const defaultBot = Array.from(this.registeredBots)[0] || null;

		const [
			slotsStats,
			fishingStats,
			roletaStats,
			anagramStats,
			stopStats,
			pintoStats,
			fazendaStats,
			waifuStats,
			activityStats,
			topCommandStats
		] = await Promise.all([
			SlotsGame.getWeeklySlotsStats(startOfWeek).catch(() => []),
			FishingGame.getWeeklyFishingStats(startOfWeek).catch(() => []),
			RoletaRussaCommands.getWeeklyRoletaStats(startOfWeek).catch(() => []),
			AnagramGame.getWeeklyAnagramStats(startOfWeek).catch(() => []),
			StopGame.getWeeklyStopStats(startOfWeek).catch(() => []),
			PintoGame.getWeeklyPintoStats(startOfWeek).catch(() => []),
			FazendaCommands.getWeeklyFazendaStats(startOfWeek, saveSnapshot, defaultBot).catch(
				() => null
			),
			WaifuCommands.getWeeklyWaifuStats(startOfWeek, defaultBot).catch(() => null),
			database
				.dbGet(
					"cmd_usage",
					`SELECT COUNT(*) as total_cmds, COUNT(DISTINCT user) as active_users
					 FROM cmd_usage_log
					 WHERE timestamp >= ?
					   AND type NOT IN ('auto')
					   AND NOT (command = 'interagir' AND args = 'false')`,
					[startOfWeek]
				)
				.catch(() => null),
			database
				.dbGet(
					"cmd_usage",
					`SELECT command, COUNT(*) as uses
					 FROM cmd_usage_log
					 WHERE timestamp >= ?
					   AND type NOT IN ('auto')
					   AND NOT (command = 'interagir' AND args = 'false')
					 GROUP BY command ORDER BY uses DESC LIMIT 1`,
					[startOfWeek]
				)
				.catch(() => null)
		]);

		const medals = ["🥇", "🥈", "🥉"];
		const sections = [];

		// 1. Waifus (Waifuletes)
		if (
			waifuStats &&
			(waifuStats.rolls?.total_rolls > 0 ||
				(waifuStats.marriagesByRarity && waifuStats.marriagesByRarity.length > 0))
		) {
			let sec = `🌸 *WAIFUS & MUDAE*\n`;
			if (waifuStats.rolls?.total_rolls > 0) {
				sec += `🎲 *Rolls Dados:* ${waifuStats.rolls.total_rolls.toLocaleString("pt-BR")} giros (${waifuStats.rolls.distinct_rollers.toLocaleString("pt-BR")} colecionadores)\n`;
			}
			if (waifuStats.marriagesByRarity && waifuStats.marriagesByRarity.length > 0) {
				const totalM = waifuStats.marriagesByRarity.reduce(
					(acc, r) => acc + (Number(r.count) || 0),
					0
				);
				sec += `💍 *Casamentos na Semana:* ${totalM}\n`;
				const rarityLabels = {
					COMMON: "⚪ Comum",
					UNCOMMON: "🟢 Incomum",
					RARE: "🔵 Raro",
					EPIC: "🟣 Épico",
					LEGENDARY: "🟡 Lendário"
				};
				const parts = waifuStats.marriagesByRarity.map(
					(r) => `${rarityLabels[r.rarity] || r.rarity}: ${r.count}`
				);
				sec += `   ${parts.join(" | ")}\n`;
			}
			if (waifuStats.negotiationsCount > 0) {
				sec += `🤝 *Negociações Realizadas:* ${waifuStats.negotiationsCount} trocas no Mercado\n`;
			}
			if (waifuStats.topMarrier && waifuStats.topMarrier.name) {
				sec += `👑 *Top Casamenteiro:* *${waifuStats.topMarrier.name}* (${waifuStats.topMarrier.count} casamentos)\n`;
			}
			if (waifuStats.mostCoveted && waifuStats.mostCoveted.name) {
				const seriesStr = waifuStats.mostCoveted.series
					? ` (${waifuStats.mostCoveted.series})`
					: "";
				sec += `⭐ *Mais Desejada:* *${waifuStats.mostCoveted.name}*${seriesStr} — ${waifuStats.mostCoveted.count} novos desejos\n`;
			}
			if (waifuStats.weeklySoulmatesCount > 0) {
				sec += `💞 *Almas Gêmeas:* ${waifuStats.weeklySoulmatesCount} novos laços eternos selados\n`;
			}
			if (waifuStats.categoryStats && waifuStats.categoryStats.length > 0) {
				const rarityIcons = {
					COMMON: "⚪",
					UNCOMMON: "🟢",
					RARE: "🔵",
					EPIC: "🟣",
					LEGENDARY: "🟡"
				};
				const catParts = waifuStats.categoryStats.map(
					(c) => `${rarityIcons[c.rarity] || ""} ${Number(c.percentage || 0).toFixed(1)}%`
				);
				sec += `\n📊 *Álbum Global (% já casada):*\n${catParts.join(" | ")}\n`;
			}
			sections.push(sec.trim());
		}

		// 2. Fazenda (Jardim das Sombras)
		if (
			fazendaStats &&
			(fazendaStats.topPlanted?.length > 0 ||
				fazendaStats.topHarvested?.length > 0 ||
				fazendaStats.topWithered?.length > 0)
		) {
			let sec = `🦇 *JARDIM LUTOSO (FAZENDA)*\n`;
			if (fazendaStats.topPlanted && fazendaStats.topPlanted.length > 0) {
				sec += `🌱 *Quem Mais Plantou:*\n`;
				fazendaStats.topPlanted.forEach((p, idx) => {
					const medal = medals[idx] || `${idx + 1}º`;
					sec += `${medal} *${p.userName}* — +${p.deltaPlanted} sementes\n`;
				});
				sec += "\n";
			}
			if (fazendaStats.topHarvested && fazendaStats.topHarvested.length > 0) {
				sec += `🌾 *Quem Mais Colheu:*\n`;
				fazendaStats.topHarvested.forEach((p, idx) => {
					const medal = medals[idx] || `${idx + 1}º`;
					sec += `${medal} *${p.userName}* — +${p.deltaHarvested} colheitas\n`;
				});
				sec += "\n";
			}
			if (fazendaStats.topWithered && fazendaStats.topWithered.length > 0) {
				sec += `💀 *Coveiro da Semana (Mais Deixou Apodrecer):*\n`;
				fazendaStats.topWithered.forEach((p, idx) => {
					const medal = medals[idx] || `${idx + 1}º`;
					sec += `${medal} *${p.userName}* — +${p.deltaWithered} plantas mortas\n`;
				});
				sec += "\n";
			}
			if (fazendaStats.richest && fazendaStats.richest.userName) {
				sec += `💰 *Maior Fortuna:* *${fazendaStats.richest.userName}* (${Number(fazendaStats.richest.coins).toLocaleString("pt-BR")} moedas)\n`;
			}
			if (fazendaStats.topCrop && fazendaStats.topCrop.name) {
				sec += `🍄 *Planta Mais Colhida:* ${fazendaStats.topCrop.name} (${Number(fazendaStats.topCrop.count).toLocaleString("pt-BR")} colheitas)\n`;
			}
			if (fazendaStats.topDecorator && fazendaStats.topDecorator.userName) {
				sec += `🎨 *Jardim Mais Decorado:* *${fazendaStats.topDecorator.userName}* (${fazendaStats.topDecorator.count} enfeites)\n`;
			}
			sections.push(sec.trim());
		}

		// 3. Pescaria (FishingGame)
		if (fishingStats && fishingStats.length > 0) {
			let sec = `🎣 *PESCARIA - TOP 10 PESCADORES*\n_Critério: Score Combinado (Peso + Peixes x5)_\n`;
			fishingStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				sec += `${medal} *${p.user_name}* — 🎖️ ${p.score.toLocaleString("pt-BR")} pts (${p.total_catches} peixes | ${p.total_weight.toFixed(2)} kg)\n`;
			});
			if (fishingStats.biggestCatch && fishingStats.biggestCatch.weight > 0) {
				sec += `\n🦈 *Monstro dos Mares:* *${fishingStats.biggestCatch.user_name}* fisgou um *${fishingStats.biggestCatch.fish_name}* de *${fishingStats.biggestCatch.weight.toFixed(2)} kg*!\n`;
			}
			sections.push(sec.trim());
		}

		// 4. Slots
		if (slotsStats && slotsStats.length > 0) {
			let sec = `🎰 *SLOTS - REIS DO CAÇA-COISAS*\n_Ordenado por Vitórias (menos jogadas = melhor taxa)_\n`;
			slotsStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				sec += `${medal} *${p.user_name}* — ${p.wins} vitórias (${p.plays} jogadas, ${p.coins_spent} moedas gastas)\n`;
			});
			if (slotsStats.mostUnlucky && slotsStats.mostUnlucky.coins_spent > 0) {
				sec += `\n💸 *O Mais Azarado:* *${slotsStats.mostUnlucky.user_name}* (${slotsStats.mostUnlucky.coins_spent} moedas gastas sem nenhuma vitória)\n`;
			}
			sections.push(sec.trim());
		}

		// 5. Roleta
		if (roletaStats && roletaStats.length > 0) {
			let sec = `🎲 *ROLETA RUSSA - MAIORES SOBREVIVENTES*\n_Ordenado por Sobrevivências no Gatilho_\n`;
			roletaStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				const statusIcon = p.isAlive ? "🛡️" : "💀";
				sec += `${medal} ${statusIcon} *${p.user_name}* — ${p.survivals} sobrevivências no gatilho\n`;
			});
			if (roletaStats.totalDeaths > 0) {
				sec += `\n💀 *Cemitério da Roleta:* ${roletaStats.totalDeaths} mortes no gatilho nesta semana!\n`;
			}
			sections.push(sec.trim());
		}

		// 6. Pinto
		if (pintoStats && pintoStats.length > 0) {
			let sec = `🍆 *PINTO GAME - MAIORES DA SEMANA*\n`;
			pintoStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				sec += `${medal} *${p.user_name}* — ${p.erect.toFixed(1)} cm (Score: ${p.score})\n`;
			});
			if (pintoStats.smallest && pintoStats.smallest.erect > 0) {
				sec += `\n🔬 *Microscópio da Semana:* *${pintoStats.smallest.user_name}* — ${pintoStats.smallest.erect.toFixed(1)} cm\n`;
			}
			sections.push(sec.trim());
		}

		// 7. Anagrama
		if (anagramStats && anagramStats.length > 0) {
			let sec = `🔤 *ANAGRAMA - MESTRES DAS PALAVRAS*\n`;
			anagramStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				sec += `${medal} *${p.user_name}* — ${p.points} pontos\n`;
			});
			sections.push(sec.trim());
		}

		// 8. Adedonha (StopGame)
		if (stopStats && stopStats.length > 0) {
			let sec = `✏️ *ADEDONHA - REIS DO STOP*\n`;
			stopStats.forEach((p, idx) => {
				const medal = medals[idx] || `${idx + 1}º`;
				const winText = p.wins > 0 ? ` (${p.wins} vitórias)` : "";
				sec += `${medal} *${p.user_name}* — ${p.points} pontos${winText}\n`;
			});
			sections.push(sec.trim());
		}

		// 9. Atividade da Ravena
		if (activityStats && (Number(activityStats.total_cmds) || 0) > 0) {
			let sec = `🤖 *ATIVIDADE DA RAVENA*\n`;
			sec += `⚡ *${Number(activityStats.total_cmds).toLocaleString("pt-BR")} comandos* processados para *${Number(activityStats.active_users || 0).toLocaleString("pt-BR")} usuários* ativos!\n`;
			if (topCommandStats && topCommandStats.command) {
				sec += `🔥 *Comando Campeão:* \`!${topCommandStats.command}\` (${Number(topCommandStats.uses || 0).toLocaleString("pt-BR")} execuções)\n`;
			}
			sections.push(sec.trim());
		}

		if (sections.length === 0) {
			return null;
		}

		const header = `🏆 *RESUMO DA SEMANA DA RAVENA* 🏆\n\n`;
		const footer = `\n✨ *Parabéns a todos os destaques da semana! Novo ciclo iniciado!* 🚀`;

		return header + sections.join("\n\n") + "\n" + footer;
	}

	/**
	 * Dispara a notificação semanal para os grupos de avisos/logs
	 */
	async sendDigest() {
		try {
			this.logger.info("[sendDigest] Gerando resumo semanal dos jogos...");
			const digestText = await this.generateWeeklyDigest(null, true);
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
