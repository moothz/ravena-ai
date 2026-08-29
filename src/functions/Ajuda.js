const fs = require("fs").promises;
const path = require("path");
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const LLMService = require("../services/LLMService");
const CommandsHelper = require("../utils/CommandsHelper");

const logger = new Logger("ajuda-commands");
const llmService = LLMService.getInstance();
const commandsHelper = CommandsHelper.getInstance();

// Cache em memória do contexto base consolidado
let baseContextCache = null;
let lastCacheRead = 0;

/**
 * Lê o arquivo ravena-llm-helper.md consolidado como contexto de base da IA
 * @returns {Promise<string>}
 */
async function loadBaseContext() {
	const now = Date.now();
	if (baseContextCache && now - lastCacheRead < 5 * 60 * 1000) {
		return baseContextCache;
	}

	try {
		const docPath = path.join(process.cwd(), "ravena-llm-helper.md");
		const content = await fs.readFile(docPath, "utf8");
		baseContextCache = content;
		lastCacheRead = now;
		return content;
	} catch (e) {
		logger.warn(
			`Não foi possível carregar ravena-llm-helper.md (${e.message}), usando contexto simplificado.`
		);
		return "Você é a assistente oficial da Ravena (bot de WhatsApp). Ajude os usuários com dúvidas sobre comandos, configurações de grupo, criação de comandos personalizados e utilidades.";
	}
}

/**
 * Processa perguntas de ajuda e dúvidas sobre o bot usando o LLMService com tool calling (commands_helper)
 * @param {string} question - Pergunta do usuário
 * @param {string} [sessionId] - ID de sessão opcional (para chat web ou contexto por chat)
 * @returns {Promise<string>} - Resposta gerada pela IA
 */
async function askHelp(question, sessionId = null) {
	if (!question || typeof question !== "string" || question.trim().length < 2) {
		return "O que você gostaria de saber? Exemplo: !ajuda como criar comandos personalizados ou !ajuda como funciona a pescaria";
	}

	const baseContext = await loadBaseContext();

	const systemContext = `${baseContext}

---
## INSTRUÇÕES ADICIONAIS PARA RESPOSTA:
1. Responda de forma clara, educada, prestativa e amigável em Português do Brasil.
2. Formate sua resposta em Markdown limpo compatível com WhatsApp (use *negrito*, _itálico_ e blocos de código com crases \`!comando\`).
3. Quando o usuário perguntar sobre comandos ou recursos específicos, use a ferramenta 'commands_helper' para buscar a sintaxe exata, exemplos de uso e tags.
4. Ao sugerir criação de comandos personalizados com !g-addCmd, sempre sugira o uso de variáveis dinâmicas (ex: {pessoa}, {tituloGrupo}, {membroRandom}, etc.).
5. Se for uma dúvida de gerenciamento de grupo, lembre que comandos iniciados em !g- são apenas para administradores e mencione o painel web (!g-painel).`;

	try {
		logger.info(`[Ajuda] Processando dúvida (Session: ${sessionId || "direct"}): "${question}"`);

		const response = await llmService.getCompletion({
			prompt: question.trim(),
			systemContext,
			toolCalling: true,
			temperature: 0.4,
			priority: 5
		});

		if (!response || typeof response !== "string" || response.trim().length === 0) {
			// Fallback local direto se a IA não responder
			const localSearch = commandsHelper.search(question);
			return `Não foi possível consultar a IA no momento, mas encontrei os seguintes comandos relacionados:\n\n${localSearch}`;
		}

		return response.trim();
	} catch (error) {
		logger.error("Erro ao gerar resposta de ajuda com LLM:", error);

		// Fallback resiliente usando CommandsHelper diretamente
		const localSearch = commandsHelper.search(question);
		return `⚠️ Ocorreu uma instabilidade no serviço de IA, mas consultei nossa base de comandos diretamente:\n\n${localSearch}`;
	}
}

/**
 * Comando WhatsApp !ajuda
 * @param {Object} bot - Instância do bot
 * @param {Object} message - Objeto da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>}
 */
async function handleAjuda(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const question = args.length > 0 ? args.join(" ") : (message.caption ?? message.content);

	if (!question || question.trim().length < 2) {
		return new ReturnMessage({
			chatId,
			content:
				"🤖 *Ajuda da Ravena*\n\nComo posso ajudar? Envie sua dúvida!\n\n_Exemplo:_ `!ajuda como adicionar comandos` ou `!ajuda como funciona a pescaria`",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	try {
		const answer = await askHelp(question, chatId);

		return new ReturnMessage({
			chatId,
			content: `🤖 *Ajuda (Ravena)*\n\n${answer}`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		return new ReturnMessage({
			chatId,
			content: `❌ ${error.message}`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}
}

const commands = [
	new Command({
		name: "ajuda",
		description: "Consulta a assistente inteligente para tirar dúvidas sobre comandos e uso do bot",
		category: "geral",
		usage: "!ajuda [sua pergunta]",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🤖",
			error: "❌"
		},
		method: handleAjuda
	})
];

const helper = {
	about: "Sistema de suporte e ajuda inteligente com LLM e busca automática na base de comandos",
	implementation:
		"Utiliza LLMService com tool calling para buscar contexto no CommandsHelper e documentação consolidada",
	tags: "ajuda,suporte,faq,duvidas,como usar,comandos,ia,help",
	cmds: [
		{
			cmd: "!ajuda",
			desc: "Consulta a assistente inteligente para tirar dúvidas sobre comandos e uso do bot",
			usage: ["!ajuda como criar comandos personalizados", "!ajuda como funciona a pescaria"],
			category: "geral"
		}
	]
};

module.exports = {
	helper,
	commands,
	handleAjuda,
	askHelp
};
