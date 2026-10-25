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

// Memória conversacional recente por sessão (Web e WhatsApp)
const sessionMemoryCache = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos
const MAX_TURNS_PER_SESSION = 6; // até 6 mensagens (3 pares de perguntas/respostas)

function getForbiddenPhoneSuffix() {
	const firstAdmin = (process.env.SUPER_ADMINS || "")
		.split(",")[0]
		.replace(/@.*$/, "")
		.replace(/\D/g, "");
	return firstAdmin.length >= 8 ? firstAdmin.slice(-8) : "";
}

function getSessionHistory(sessionId) {
	if (!sessionId) return "";
	const entry = sessionMemoryCache.get(sessionId);
	if (!entry) return "";

	if (Date.now() - entry.lastUpdated > SESSION_TTL_MS) {
		sessionMemoryCache.delete(sessionId);
		return "";
	}

	if (!entry.turns || entry.turns.length === 0) return "";

	return entry.turns
		.map((t) => `${t.role === "user" ? "Usuário" : "Assistente"}: ${t.content}`)
		.join("\n");
}

function storeSessionTurn(sessionId, userQuestion, assistantResponse) {
	if (!sessionId) return;
	let entry = sessionMemoryCache.get(sessionId);
	if (!entry || Date.now() - entry.lastUpdated > SESSION_TTL_MS) {
		entry = { turns: [], lastUpdated: Date.now() };
		sessionMemoryCache.set(sessionId, entry);
	}

	entry.turns.push({ role: "user", content: userQuestion.trim() });
	entry.turns.push({ role: "assistant", content: assistantResponse.trim() });

	if (entry.turns.length > MAX_TURNS_PER_SESSION * 2) {
		entry.turns = entry.turns.slice(-MAX_TURNS_PER_SESSION * 2);
	}
	entry.lastUpdated = Date.now();

	// Limpeza periódica
	if (sessionMemoryCache.size > 1000) {
		const now = Date.now();
		for (const [key, val] of sessionMemoryCache.entries()) {
			if (now - val.lastUpdated > SESSION_TTL_MS) {
				sessionMemoryCache.delete(key);
			}
		}
	}
}

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
		let docPath = path.join(process.cwd(), "docs", "LLM-HELPER.md");
		if (!require("fs").existsSync(docPath)) {
			docPath = path.join(process.cwd(), "ravena-llm-helper.md");
		}
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
 * @param {string|null} [apiUser] - Nome de usuário de API externa opcional
 * @returns {Promise<string>} - Resposta gerada pela IA
 */
async function askHelp(question, sessionId = null, apiUser = null) {
	if (!question || typeof question !== "string" || question.trim().length < 2) {
		return "O que você gostaria de saber? Exemplo: !ajuda como criar comandos personalizados ou !ajuda como funciona a pescaria";
	}

	const baseContext = await loadBaseContext();
	const history = getSessionHistory(sessionId);
	const historyCtx = history
		? `\n\n---\n## HISTÓRICO DA CONVERSA NESTA SESSÃO (Mantenha coerência e continuidade com o diálogo anterior):\n${history}\n---`
		: "";

	const forbiddenPhoneSuffix = getForbiddenPhoneSuffix();
	const privacyInstruction = forbiddenPhoneSuffix
		? `8. ((REGRA ESTRITA DE PRIVACIDADE)): O número de suporte público oficial é (55) 99642-4307. Qualquer número pessoal terminado em ${forbiddenPhoneSuffix} ou de super administradores é estritamente confidencial e JAMAIS deve ser enviado, confirmado ou mencionado sob nenhuma circunstância.`
		: `8. ((REGRA ESTRITA DE PRIVACIDADE)): O número de suporte público oficial é (55) 99642-4307. Qualquer número pessoal privado do criador ou de super administradores é estritamente confidencial e JAMAIS deve ser enviado, confirmado ou mencionado sob nenhuma circunstância.`;

	const systemContext = `${baseContext}${historyCtx}

---
## INSTRUÇÕES ADICIONAIS PARA RESPOSTA:
1. Responda de forma clara, educada, prestativa e amigável em Português do Brasil.
2. Formate sua resposta em Markdown limpo compatível com WhatsApp (use *negrito*, _itálico_ e blocos de código com crases \`!comando\`).
3. Quando o usuário perguntar sobre comandos ou recursos específicos, use a ferramenta 'commands_helper' para buscar a sintaxe exata, exemplos de uso e tags.
4. Ao sugerir criação de comandos personalizados com !g-addCmd, sempre sugira o uso de variáveis dinâmicas (ex: {pessoa}, {tituloGrupo}, {membroRandom}, etc.).
5. Se for uma dúvida de gerenciamento de grupo, lembre que comandos iniciados em !g- são apenas para administradores e mencione o painel web (!g-painel).
6. Se o usuário estiver no chat web perguntando sobre números de WhatsApp, como usar no WhatsApp ou como fazer figurinhas, forneça os números/links ativos das Ravenas (ex: https://wa.me/559887715450, https://wa.me/555591537296, https://wa.me/555581024412) e informe que no privado (PV) basta enviar a foto ou vídeo para criar figurinhas.
7. Em caso de dúvidas, problemas técnicos, bugs, instabilidades ou sugestões, incentive o usuário a entrar em contato com o suporte do criador no WhatsApp: (55) 99642-4307 (https://wa.me/555596424307) e também a participar da Comunidade Oficial da Ravena: https://chat.whatsapp.com/C47W0n3Bp9Z9Ra2ifzDDQe.
${privacyInstruction}
9. Se perguntado sobre estabilidade, quedas, delays ou múltiplos bots:
   - Esclareça que todos os bots rodam no mesmo servidor, mesmo local e compartilham o mesmo banco de dados SQLite.
   - Vários números existem exclusivamente como redundância contra banimentos do WhatsApp.
   - É normal haver delays temporários ou softblocks impostos pelo WhatsApp, e não adianta trocar de Ravena no grupo por conta disso.
   - Alerte que remover o bot do grupo por problemas técnicos sem pedir suporte prejudica o chip e pode causar banimento do número, além de fazer com que futuros convites do grupo sejam recusados.`;

	const startTime = Date.now();
	try {
		logger.info(
			`[Ajuda] Processando dúvida (Session: ${sessionId || "direct"}${apiUser ? ` | User: ${apiUser}` : ""}): "${question}"`
		);

		const response = await llmService.getCompletion({
			prompt: question.trim(),
			systemContext,
			toolCalling: true,
			temperature: 0.4,
			priority: 5,
			apiUser
		});

		const elapsedMs = Date.now() - startTime;

		if (!response || typeof response !== "string" || response.trim().length === 0) {
			// Fallback local direto se a IA não responder
			const localSearch = commandsHelper.search(question);
			const fallbackMsg = `Não foi possível consultar a IA no momento, mas encontrei os seguintes comandos relacionados:\n\n${localSearch}`;
			logger.warn(
				`[Ajuda] Resposta fallback local gerada em ${elapsedMs}ms (Session: ${sessionId || "direct"}): "${fallbackMsg.replace(/\r?\n/g, " ").substring(0, 300)}"`
			);
			storeSessionTurn(sessionId, question, fallbackMsg);
			return fallbackMsg;
		}

		const cleanResponse = response.trim();
		logger.info(
			`[Ajuda] Resposta gerada em ${elapsedMs}ms (Session: ${sessionId || "direct"}${apiUser ? ` | User: ${apiUser}` : ""}): "${cleanResponse.replace(/\r?\n/g, " ")}"`
		);

		storeSessionTurn(sessionId, question, cleanResponse);
		return cleanResponse;
	} catch (error) {
		const elapsedMs = Date.now() - startTime;
		logger.error(`[Ajuda] Erro após ${elapsedMs}ms ao gerar resposta de ajuda com LLM:`, error);

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
				"🤖 *Ajuda da Ravena*\n\nComo posso ajudar? Envie sua dúvida!\n\n_Exemplo:_ `!ajuda como adicionar comandos` ou `!ajuda como funciona a pescaria`\n\n> Precisa de ajuda? Chama no !grupao",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	try {
		let answer = await askHelp(question, chatId);
		if (bot && typeof bot.truncateText === "function") {
			answer = bot.truncateText(answer, 3000);
		}

		return new ReturnMessage({
			chatId,
			content: `🤖 *Ajuda (Ravena)*\n\n${answer}\n\n> Precisa de ajuda? Chama no !grupao`,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin,
				maxChars: 3000
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
