const Logger = require("../utils/Logger");
const LayaService = require("./LayaService");

// Variável const para debug detalhado de enquetes recebidas e votos computados
const debugVerbose = true;

class PollVoteService {
	constructor() {
		this.logger = new Logger("poll-vote-service");
		this.votedPollsCache = new Set();
		this.maxCacheSize = 2000;
	}

	/**
	 * Escolhe uma opção da enquete baseada na personalidade do bot usando Laya (System One)
	 * com fallback para escolha aleatória em caso de falha.
	 * @param {Object} bot - Instância do bot
	 * @param {Object} group - Dados do grupo (se houver)
	 * @param {Object} pollData - Dados da enquete { question/name, options: [] }
	 * @returns {Promise<{ option: string, source: "laya"|"fallback", error?: string }>}
	 */
	async chooseOption(bot, group, pollData) {
		const options = pollData?.options || [];
		if (!options || options.length === 0) {
			throw new Error("Enquete não possui opções válidas");
		}
		if (options.length === 1) {
			return { option: options[0], source: "fallback" };
		}

		const question = pollData.question || pollData.name || "Enquete";

		// 1. Obtém personalidade ativa (do grupo ou do bot)
		const personality =
			group?.customAIPrompt && group.customAIPrompt.trim().length > 0
				? group.customAIPrompt.trim()
				: bot?.aiPersonality && bot.aiPersonality.trim().length > 0
					? bot.aiPersonality.trim()
					: "Ravena: witty, sarcastic, fun, playful, bold and direct anime girl assistant";

		// 2. Constrói state e questions para o Laya (otimizado em inglês e formato discreto)
		const state = `Personality:\n${personality}\n\nPoll Question:\n"${question}"`;

		const criteria = {};
		options.forEach((opt, idx) => {
			criteria[`opt_${idx}`] = String(opt);
		});

		const questions = {
			poll_vote: {
				type: "choice",
				instructions:
					"You are participating in a poll. Based on the personality and question above, choose the single option that best reflects this character's authentic preferences and attitude.",
				criteria
			}
		};

		const layaService = LayaService.getInstance();
		if (layaService.isEnabled()) {
			try {
				const result = await layaService.predict(state, questions, { timeoutMs: 3000 });
				const chosenKey = result?.answers?.poll_vote?.choice;
				if (chosenKey && criteria[chosenKey]) {
					return {
						option: criteria[chosenKey],
						source: "laya"
					};
				}
				this.logger.warn(
					`[chooseOption] Laya retornou escolha desconhecida '${chosenKey}'. Usando fallback aleatório.`
				);
			} catch (err) {
				this.logger.warn(
					`[chooseOption] Falha ao consultar LayaService: ${err.message}. Usando fallback aleatório.`
				);
			}
		}

		// Fallback para resposta aleatória
		const randomIndex = Math.floor(Math.random() * options.length);
		return {
			option: options[randomIndex],
			source: "fallback"
		};
	}

	/**
	 * Processa votação automática ao receber uma enquete
	 * @param {Object} bot - Instância do bot
	 * @param {Object} message - Mensagem formatada da enquete
	 * @param {Object} group - Objeto do grupo (ou null se for PV)
	 */
	async handleIncomingPoll(bot, message, group = null) {
		if (!bot || !message) return;

		// Não votar em enquetes enviadas pelo próprio bot
		if (message.fromMe) return;

		const pollData = message.poll || message.pollData;
		if (!pollData || !Array.isArray(pollData.options) || pollData.options.length < 2) {
			return;
		}

		// Verifica se o voto em enquetes está habilitado (padrão true)
		const isVoteEnabled = group ? group.interact?.voteInPolls !== false : true;
		if (!isVoteEnabled) {
			return;
		}

		const chatId = message.group || message.author || message.from;
		const pollId = message.id;
		const pollKey = `${chatId}_${pollId}`;

		// Prevenção de votos duplicados
		if (this.votedPollsCache.has(pollKey)) {
			return;
		}
		this.votedPollsCache.add(pollKey);
		if (this.votedPollsCache.size > this.maxCacheSize) {
			const firstItem = this.votedPollsCache.values().next().value;
			this.votedPollsCache.delete(firstItem);
		}

		try {
			const { option: selectedOption, source } = await this.chooseOption(bot, group, pollData);

			if (debugVerbose) {
				const question = pollData.question || pollData.name || "";
				this.logger.info(
					`[PollVote][DEBUG] Enquete recebida em ${chatId} de ${message.author || message.from} | Pergunta: "${question}" | Opções: [${pollData.options.join(", ")}] | Voto: "${selectedOption}" (${source === "laya" ? "Laya System One" : "Fallback Aleatório"})`
				);
			}

			// Delay pequeno e natural antes de votar (1.2s)
			await new Promise((resolve) => setTimeout(resolve, 1200));

			const pollSender = message.author || message.from;
			if (typeof bot.votePoll === "function") {
				await bot.votePoll(chatId, pollId, pollSender, [selectedOption], false);
			} else if (message.origin && typeof message.origin.vote === "function") {
				await message.origin.vote([selectedOption]);
			}
		} catch (err) {
			this.logger.error(`[handleIncomingPoll] Erro ao votar na enquete ${pollId}:`, err);
		}
	}
}

module.exports = new PollVoteService();
