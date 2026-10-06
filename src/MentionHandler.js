"use strict";

const Logger = require("./utils/Logger");
const ReturnMessage = require("./models/ReturnMessage");
const { aiCommand } = require("./functions/AICommands");
const PhoneUtils = require("./utils/PhoneUtils");

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
	 * Escapa caracteres especiais para uso seguro em expressões regulares
	 * @param {string} str
	 * @returns {string}
	 */
	_escapeRegex(str) {
		return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	/**
	 * Processa uma mensagem que menciona o bot
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 * @param {Object} group - Dados do grupo
	 * @param {string} text - O texto da mensagem
	 * @returns {Promise<boolean>} - Se a menção foi tratada
	 */
	async processMention(bot, message, group, text) {
		try {
			// Só pra grupos
			if (!message.group) return false;

			const textContent =
				typeof text === "string"
					? text
					: typeof message.content === "string"
						? message.content
						: typeof message.caption === "string"
							? message.caption
							: "";

			const hasMentions = Array.isArray(message.mentions) && message.mentions.length > 0;
			const hasAtSymbol = textContent.includes("@");

			// Se não tem mentions no metadado nem @ no texto, não é menção ao bot
			if (!hasMentions && !hasAtSymbol) return false;

			// 1. Descobrir detalhes do chat/grupo para identificar o LID do bot
			let chatInfo = null;
			if (typeof bot.getChatDetails === "function") {
				chatInfo = await bot.getChatDetails(message.group).catch(() => null);
			}

			// 2. Coletar todos os identificadores que representam o bot
			const botPhone = bot.phoneNumber || "";
			const phoneVariants = PhoneUtils.getPhoneVariants(botPhone);

			let rawBotLid = null;
			if (typeof bot.getLidFromPn === "function" && chatInfo) {
				rawBotLid = bot.getLidFromPn(botPhone, chatInfo);
			}
			if (!rawBotLid && bot.myLid) {
				rawBotLid = bot.myLid;
			}

			const cleanBotLid = PhoneUtils.cleanPhone(rawBotLid);

			// Identificadores que podem aparecer no texto após '@' ou '<@'
			const textIdentifierSet = new Set();
			if (cleanBotLid) textIdentifierSet.add(cleanBotLid);
			phoneVariants.forEach((v) => textIdentifierSet.add(v));
			if (bot.id) {
				textIdentifierSet.add(bot.id);
				textIdentifierSet.add(bot.id.replace(/-/g, "_"));
				textIdentifierSet.add(bot.id.replace(/_/g, "-"));
			}
			if (bot.nomeExibir && !/\s/.test(bot.nomeExibir)) {
				textIdentifierSet.add(bot.nomeExibir);
			}
			if (bot.telegramBotName) textIdentifierSet.add(bot.telegramBotName);
			if (bot.client?.user?.id) textIdentifierSet.add(bot.client.user.id);

			const textIdentifiers = Array.from(textIdentifierSet).filter(Boolean);

			// 3. Verificar se o bot foi mencionado
			// 3.1. No array message.mentions
			const botInMentionsArray =
				hasMentions &&
				message.mentions.some((m) => {
					if (!m) return false;
					const cleanM = PhoneUtils.cleanPhone(m);
					if (cleanBotLid && cleanM === cleanBotLid) return true;
					if (cleanBotLid && String(m).includes(cleanBotLid)) return true;
					if (botPhone && PhoneUtils.isSamePhone(m, botPhone)) return true;
					if (m === rawBotLid || String(m) === String(bot.id)) return true;
					if (bot.client?.user?.id && String(m) === String(bot.client.user.id)) return true;
					return false;
				});

			// 3.2. No texto da mensagem
			let botMentionAtStart = false;
			let mentionRegexStart = null;
			let globalMentionRegex = null;

			if (textIdentifiers.length > 0) {
				const pattern = textIdentifiers.map(this._escapeRegex).join("|");
				// Regex para início da mensagem: ^\s*(@id|<@!?id>)(?:[,:\s]+|$)
				mentionRegexStart = new RegExp(
					`^\\s*(@(?:${pattern})|<@!?(?:${pattern})>)(?:[,:\\s]+|$)`,
					"i"
				);
				// Regex global para limpar menções do bot no prompt
				globalMentionRegex = new RegExp(`(@(?:${pattern})|<@!?(?:${pattern})>)`, "gi");

				botMentionAtStart = mentionRegexStart.test(textContent);
			}

			const botMencionado = botMentionAtStart || botInMentionsArray;
			if (!botMencionado) return false;

			this.logger.info(
				`[processMention] Menção ao bot detectada na mensagem de ${message.author} em ${message.group || "chat privado"}`
			);

			// Reage com o emoji "antes"
			try {
				await message.origin.react(this.reactions.before);
			} catch (reactError) {
				this.logger.error('Erro ao aplicar reação "antes":', reactError);
			}

			// Remove a menção do bot do prompt
			let prompt = textContent;
			if (mentionRegexStart && mentionRegexStart.test(prompt)) {
				prompt = prompt.replace(mentionRegexStart, "");
			}
			if (globalMentionRegex) {
				prompt = prompt.replace(globalMentionRegex, "");
			}
			// Limpa pontuações/espaços residuais do início (ex: ", boa noite" ou ": boa noite")
			prompt = prompt.replace(/^[,:\s]+/, "").trim();

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
		} catch (error) {
			this.logger.error("Erro ao processar menção:", error);
			return false;
		}
	}
}

module.exports = MentionHandler;
