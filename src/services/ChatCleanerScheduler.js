const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const Logger = require("../utils/Logger");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ChatCleanerScheduler
 * Serviço responsável por automatizar a limpeza periódica de mensagens (ClearChat)
 * em todas as instâncias WhatsApp vinculadas à whatsgoapi.
 *
 * Executa de madrugada (padrão: 03:30 BRT) respeitando o deleteMessagesInterval
 * configurado em cada bot (em dias).
 */
class ChatCleanerScheduler {
	constructor(options = {}) {
		this.logger = new Logger("chat-cleaner-scheduler");
		this.bots = options.bots || [];
		this.cronExpression = options.cronExpression || "30 3 * * *"; // 03:30 AM
		this.timeZone = options.timeZone || "America/Sao_Paulo";
		this.delayBetweenGroupsMs = options.delayBetweenGroupsMs ?? 3000; // 3 segundos entre grupos (anti-ban/anti-logout)
		this.stateFilePath =
			options.stateFilePath ||
			path.resolve(__dirname, "..", "..", "data", "chat-cleaner-state.json");

		this.cronJob = null;
		this.isRunning = false;
		this.isCleaning = false;
		this.state = this.loadState();
	}

	static getInstance(options = {}) {
		if (!ChatCleanerScheduler.instance) {
			ChatCleanerScheduler.instance = new ChatCleanerScheduler(options);
		} else if (options.bots && options.bots.length > 0) {
			ChatCleanerScheduler.instance.bots = options.bots;
		}
		return ChatCleanerScheduler.instance;
	}

	/**
	 * Carrega o estado de execuções anteriores do disco
	 * @returns {{ lastExecution: Object.<string, number> }}
	 */
	loadState() {
		try {
			if (fs.existsSync(this.stateFilePath)) {
				const content = fs.readFileSync(this.stateFilePath, "utf8");
				const parsed = JSON.parse(content);
				if (parsed && typeof parsed.lastExecution === "object") {
					return parsed;
				}
			}
		} catch (error) {
			this.logger.warn(
				"Falha ao ler chat-cleaner-state.json, inicializando novo estado:",
				error.message
			);
		}

		return { lastExecution: {} };
	}

	/**
	 * Salva o estado atual no disco de forma segura
	 */
	saveState() {
		try {
			const dir = path.dirname(this.stateFilePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), "utf8");
		} catch (error) {
			this.logger.error("Erro ao salvar chat-cleaner-state.json:", error);
		}
	}

	/**
	 * Registra os bots gerenciados pelo scheduler
	 * @param {Array} bots
	 */
	setBots(bots) {
		this.bots = bots;
	}

	/**
	 * Inicia o cron scheduler
	 */
	start() {
		if (this.isRunning) {
			this.logger.warn("ChatCleanerScheduler já está em execução.");
			return;
		}

		this.logger.info(
			`ChatCleanerScheduler inicializado. Agendado para as 03:30 BRT (${this.cronExpression}) com delay de ${this.delayBetweenGroupsMs}ms entre chats.`
		);

		this.cronJob = cron.schedule(
			this.cronExpression,
			async () => {
				this.logger.info("Cron job disparado: Iniciando verificação de limpeza de mensagens...");
				try {
					await this.runCheck();
				} catch (err) {
					this.logger.error("Erro durante a execução do cron job de limpeza:", err);
				}
			},
			{
				scheduled: true,
				timezone: this.timeZone
			}
		);

		this.isRunning = true;
	}

	/**
	 * Para o cron scheduler
	 */
	stop() {
		if (this.cronJob) {
			this.cronJob.stop();
			this.cronJob = null;
		}
		this.isRunning = false;
		this.logger.info("ChatCleanerScheduler parado.");
	}

	/**
	 * Verifica todas as instâncias e executa a limpeza daquelas cujo intervalo venceu
	 */
	async runCheck() {
		if (this.isCleaning) {
			this.logger.warn("Uma rotina de limpeza já está em andamento. Ignorando este ciclo.");
			return;
		}

		this.isCleaning = true;
		const now = Date.now();

		try {
			for (const bot of this.bots) {
				// Ignora bots desativados ou de outras plataformas
				if (!bot || bot.useTelegram || bot.useDiscord) continue;

				const intervalDays = Number(bot.deleteMessagesInterval);
				if (!intervalDays || isNaN(intervalDays) || intervalDays <= 0) {
					// false, 0, nulo ou inválido = nunca apaga
					continue;
				}

				const lastExec = Number(this.state.lastExecution[bot.id]) || 0;
				const daysPassed = (now - lastExec) / (1000 * 60 * 60 * 24);

				this.logger.info(
					`[${bot.id}] Intervalo configurado: ${intervalDays} dias. Dias decorridos: ${daysPassed.toFixed(2)}.`
				);

				if (daysPassed >= intervalDays) {
					this.logger.info(
						`[${bot.id}] Intervalo atingido (${daysPassed.toFixed(2)} >= ${intervalDays} dias). Iniciando limpeza de grupos...`
					);
					await this.cleanBotGroups(bot);
					this.state.lastExecution[bot.id] = Date.now();
					this.saveState();
				}
			}
		} finally {
			this.isCleaning = false;
		}
	}

	/**
	 * Executa o loop de ClearChat em todos os grupos de um bot específico
	 * @param {Object} bot - Instância de WhatsAppBotGo
	 * @param {Object} [options]
	 * @param {string} [options.targetGroup] - Se informado, limpa apenas este grupo específico (para testes/debug)
	 */
	async cleanBotGroups(bot, options = {}) {
		if (!bot || typeof bot.listGroups !== "function" || typeof bot.clearChat !== "function") {
			this.logger.warn(`Bot '${bot?.id}' não implementa listGroups ou clearChat. Ignorando.`);
			return { success: false, reason: "unsupported_bot" };
		}

		let groupsToClean = [];

		if (options.targetGroup) {
			groupsToClean = [{ JID: options.targetGroup }];
		} else {
			try {
				const groups = await bot.listGroups();
				if (!Array.isArray(groups)) {
					this.logger.warn(`[${bot.id}] Falha ao obter lista de grupos para limpeza.`);
					return { success: false, reason: "empty_group_list" };
				}
				groupsToClean = groups;
			} catch (err) {
				this.logger.error(`[${bot.id}] Erro ao buscar lista de grupos:`, err);
				return { success: false, error: err.message };
			}
		}

		this.logger.info(
			`[${bot.id}] Iniciando ClearChat em ${groupsToClean.length} grupos com delay de ${this.delayBetweenGroupsMs}ms entre cada...`
		);

		let successCount = 0;
		let failCount = 0;

		for (let i = 0; i < groupsToClean.length; i++) {
			const entry = groupsToClean[i];
			const jid = entry.JID || entry.id || (typeof entry === "string" ? entry : null);

			if (!jid || !jid.endsWith("@g.us")) {
				continue;
			}

			try {
				this.logger.info(
					`[${bot.id}] [${i + 1}/${groupsToClean.length}] Limpando mensagens do grupo ${jid}...`
				);
				await bot.clearChat(jid, false);
				successCount++;
			} catch (clearErr) {
				this.logger.error(
					`[${bot.id}] Falha ao limpar mensagens do grupo ${jid}:`,
					clearErr.message || clearErr
				);
				failCount++;
			}

			// Delay seguro entre chats para não sobrecarregar o AppState do WhatsApp
			if (i < groupsToClean.length - 1 && this.delayBetweenGroupsMs > 0) {
				await sleep(this.delayBetweenGroupsMs);
			}
		}

		const summaryMsg = `[ChatCleaner] Concluída limpeza de grupos para ${bot.id}: ${successCount} limpos com sucesso, ${failCount} falhas.`;
		this.logger.info(summaryMsg);

		// Notifica o grupo de logs/estabilidade do bot se configurado
		if (bot.grupoLogs && typeof bot.sendReturnMessages === "function") {
			try {
				await bot.sendReturnMessages([{ message: summaryMsg }], { id: bot.grupoLogs });
			} catch (logErr) {
				this.logger.warn(
					`[${bot.id}] Não foi possível enviar resumo de limpeza para grupoLogs:`,
					logErr.message
				);
			}
		}

		return {
			success: true,
			total: groupsToClean.length,
			cleaned: successCount,
			failed: failCount
		};
	}
}

module.exports = ChatCleanerScheduler;
