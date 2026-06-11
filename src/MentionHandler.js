const Logger = require("./utils/Logger");
const ReturnMessage = require("./models/ReturnMessage");
const { aiCommand } = require("./functions/AICommands");
/**
 * Trata menções ao bot em mensagens
 */
class MentionHandler {
	constructor() {
		this.logger = new Logger("mention-handler");

		// Emoji de reação padrão para menções
		this.reactions = {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🤖",
			error: "❌"
		};
	}

	/**
	 * Processa uma mensagem que menciona o bot
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 * @param {string} text - O texto da mensagem
	 * @returns {Promise<boolean>} - Se a menção foi tratada
	 */
	async processMention(bot, message, group, text) {
		try {
			// Só pra grupos
			if (!message.group) return;
			if (message.mentions && message.mentions.length > 0) {
				// Por enquanto, a única maneira é pegar a info do grupo pra descobrir o LID do bot nele
				const chatInfo = await bot.getChatDetails(message.group);

				// 1° passo: descobrir o lid do bot nesse grupo (identificado via Whatsgo)
				const botNumber = bot.getLidFromPn(bot.phoneNumber || "", chatInfo);

				// Regex para WhatsApp (@numero) e Discord (<@id> ou <@!id>)
				const mentionRegexStart = new RegExp(`^\\s*(@${botNumber}|<@!?${botNumber}>)\\b`, "i");

				// OU a frase começa com o @numeroBot ou ele tá no mentions
				const botMencionado =
					mentionRegexStart.test(text) || message.mentions.some((m) => m === botNumber);

				if (!botMencionado) return;

				this.logger.info(
					`[processMention] Menção ao bot detectada no início da mensagem de ${message.author} em ${message.group || "chat privado"}`
				);

				// Reage com o emoji "antes"
				try {
					await message.origin.react(this.reactions.before);
				} catch (reactError) {
					this.logger.error('Erro ao aplicar reação "antes":', reactError);
				}

				// Remove a menção do prompt
				const prompt = text.replace(mentionRegexStart, "").trim();

				if (!prompt) {
					// Apenas uma menção sem texto, envia uma resposta padrão
					const chatId = message.group ?? message.author;
					const returnMessage = new ReturnMessage({
						chatId,
						content:
							"Olá! Como posso te ajudar? Você pode tirar dúvida de quais comandos eu tenho e também como usar eles, com exemplos, é só pedir! Se quiser saber meus comandos, envie !cmd",
						reaction: this.reactions.after
					});

					await bot.sendReturnMessages(returnMessage);
					return true;
				}

				this.logger.info(`Processando prompt para LLM: "${prompt}"`);
				const args = prompt.split(" ") ?? [];

				const msgsLLM = await aiCommand(bot, message, args, group);
				await bot.sendReturnMessages(msgsLLM);
				return true;
			} else {
				return;
			}
		} catch (error) {
			this.logger.error("Erro ao processar menção:", error);
			return false;
		}
	}
}

module.exports = MentionHandler;
