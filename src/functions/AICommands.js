const path = require("path");
const fs = require("fs").promises;
const Logger = require("../utils/Logger");
const { getRecentMessages, formatMessagesForPrompt, storeMessage } = require("./SummaryCommands");
const LLMService = require("../services/LLMService");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");
const { extractFrames } = require("../utils/Conversions");

const logger = new Logger("ai-commands");

const llmService = LLMService.getInstance();
const database = Database.getInstance();

const classifyQuestionSchema = {
	type: "json_schema",
	json_schema: {
		name: "classify_schema",
		schema: {
			type: "object",
			properties: {
				classification: {
					type: "string",
					enum: ["general", "group", "bot", "command"]
				},
				command: {
					type: "string"
				},
				args: {
					type: "string"
				}
			},
			required: ["classification"]
		}
	}
};

/**
 * Helper to get command lists formatted for the prompt
 */
function getCommandLists(bot, group = null) {
	const fixedCommands = bot.eventHandler.commandHandler.fixedCommands.getAllCommands();
	const managementCommands = bot.eventHandler.commandHandler.management.getManagementCommands();

	let cmdSimpleList = "";
	let cmdGerenciaSimplesList = "";

	const prefix = group && group.prefix !== undefined ? group.prefix : bot.prefix;
	const mutedCategories =
		group && Array.isArray(group.mutedCategories) ? group.mutedCategories : [];
	const mutedCommands = group && Array.isArray(group.mutedCommands) ? group.mutedCommands : [];

	for (const cmd of fixedCommands) {
		// Filter by category
		if (cmd.category && mutedCategories.includes(cmd.category.toLowerCase())) {
			continue;
		}

		// Filter by muted commands
		if (mutedCommands.includes(cmd.name)) {
			continue;
		}

		if (
			cmd.description &&
			cmd.description.length > 0 &&
			!cmd.description.toLowerCase().includes("alias") &&
			!cmd.hidden
		) {
			const usage = cmd.usage ? ` | Uso: ${cmd.usage}` : "";
			cmdSimpleList += `- ${prefix}${cmd.name}: ${cmd.description}${usage}\n`;
		}
	}
	for (const cmd in managementCommands) {
		const desc = managementCommands[cmd].description;
		cmdGerenciaSimplesList += `- ${prefix}g-${cmd}: ${desc}\n`;
	}

	return { cmdSimpleList, cmdGerenciaSimplesList };
}

/**
 * Classifies the user's request using LLM
 */
async function classifyRequest(question, commandList, ctxContent, hasMedia) {
	let mediaContext = "";
	if (hasMedia) {
		mediaContext =
			"\n\n[IMPORTANT]: The user HAS ATTACHED an image or video to this message.\nIf the user is asking to modify, stickerize, or perform an action ON the image, classify as 'command' and identify the appropriate command (e.g., sticker).\nIf the user is asking a question ABOUT the image content (e.g., 'what is in this image?'), classify as 'bot' or 'general' so it can be analyzed.";
	}

	const prompt = `Classify the user's intent to determine how the bot should respond.

User Request: "${question}"
${mediaContext}

### Classification Rules:
1. **"general" (DEFAULT/CATCH-ALL)**: 
   - User wants to KNOW something or ANALYZE something.
   - Any question about real-world facts, finance (stocks, funds, banks), news, weather, calculations, or general knowledge.
   - Any request to "analyze", "describe", "explain", "read", or "summarize" an image/video/text.
   - Even if the request contains keywords found in commands (e.g., "gold", "money", "fish"), if the intent is a QUESTION, it is "general".
   - Example: "how much is gold?", "analyze this image", "who is the president?", "o fundo MM Ouro oscilou quanto?".

2. **"command" (FUNCTIONAL TOOLS)**:
   - User wants to DO something using a specific bot feature/utility.
   - The intent must explicitly or very closely match the *action* described in "Available Commands".
   - MUST be a functional request (e.g., "make a sticker", "remove the background", "play the game", "stickerize this").
   - If the request is a complex sentence or a question, it is almost never a command.
   - Be ((EXTREMELY STRICT)). If it doesn't clearly map to a tool's primary purpose, it's "general".

3. **"bot"**: 
   - Questions about the bot's identity, status, or how to use it (e.g., "who made you?", "what can you do?", "how to create this command", "how to configure feature", "help").

4. **"group"**: 
   - Questions specifically about the current chat members or group dynamics (e.g., "who talks the most?", "is @user here?").

### Available Commands:
${commandList}

### Context:
${ctxContent.substring(0, 500)}...

Return JSON: {"classification": "...", "command": "...", "args": "..."}
`;

	try {
		const response = await llmService.getCompletion({
			prompt,
			response_format: classifyQuestionSchema,
			temperature: 0.1,
			systemContext: "You are an intent classifier for a WhatsApp bot.",
			priority: 5
		});

		try {
			if (response.classification == "command") {
				this.logger.debug(
					`[classifyRequest][command] "${question.substring(0, 100)}" -> "!${response.command} ${response.args}"`
				);
			}
			return JSON.parse(response);
		} catch (e) {
			logger.warn("[classifyRequest] Failed to parse JSON, defaulting to general", response);
			return { classification: "general" };
		}
	} catch (e) {
		logger.error("[classifyRequest] Error classifying", e);
		return { classification: "general" };
	}
}

/**
 * Handles the "command" classification
 */
async function handleCommandInvocation(classification, bot, message, group) {
	const cmdName = classification.command?.replace(/!/g, "").trim();
	const argsStr = classification.args || "";
	const args = argsStr.split(" ").filter((a) => a.length > 0);

	// Try to find the command
	const fixedCmd = bot.eventHandler.commandHandler.fixedCommands.getCommand(cmdName);

	if (fixedCmd) {
		try {
			logger.info(`[AICommand] Auto-invoking command: ${cmdName} with args: ${args}`);

			// Hijack the message object
			const fullCommandString = `!${cmdName} ${argsStr}`;

			// We need to be careful not to mutate the original message permanently if it's used elsewhere,
			// but for this flow it's likely fine.
			// Check if it's a media message to decide where to put the command string
			if (message.type === "image" || message.type === "video" || message.hasMedia) {
				message.caption = fullCommandString;
			} else {
				message.body = fullCommandString;
				message.content = fullCommandString;
			}

			const result = await fixedCmd.execute(bot, message, args, group);
			const introText = `> 🤖 Usando comando !${cmdName} ${argsStr}`;
			const introMessage = new ReturnMessage({
				chatId: message.group ?? message.author,
				content: introText,
				options: { quotedMessageId: message.origin.id._serialized }
			});

			// Case 1: Result is an Array of ReturnMessages

			if (Array.isArray(result)) {
				return [introMessage, ...result];
			}

			// Case 2: Result is a single ReturnMessage
			if (result instanceof ReturnMessage) {
				// Stickers don't show text, so always send separate notification

				if (result.options?.sendMediaAsSticker) {
					return [introMessage, result];
				}

				if (typeof result.options?.caption === "string") {
					const currentCaption = result.options.caption.trim();
					result.options.caption = currentCaption ? `${introText}\n\n${currentCaption}` : introText;
					return result;
				}

				// If it's a text message or we can merge into content
				if (typeof result.content === "string") {
					const currentContent = result.content.trim();
					result.content = currentContent ? `${introText}\n\n${currentContent}` : introText;
					return result;
				}

				// Fallback if content isn't a string or complex object

				return [introMessage, result];
			}

			// Case 3: Result is a string (simple text response)
			if (typeof result === "string") {
				return new ReturnMessage({
					chatId: message.group ?? message.author,
					content: `${introText}\n\n${result}`,
					options: { quotedMessageId: message.origin.id._serialized }
				});
			}

			// Case 4: No result or unknown type
			return introMessage;
		} catch (e) {
			logger.error(`[AICommand] Error auto-invoking command ${cmdName}`, e);
			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: `Tentei executar o comando !${cmdName}, mas ocorreu um erro: ${e.message}`,
				options: { quotedMessageId: message.origin.id._serialized }
			});
		}
	}

	return new ReturnMessage({
		chatId: message.group ?? message.author,
		content: `Entendi que você quer usar o comando "${cmdName}", mas não consegui encontrá-lo ou executá-lo.`,
		options: { quotedMessageId: message.origin.id._serialized }
	});
}

/**
 * Main AI Command function
 */
async function aiCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const database = Database.getInstance();

	// 1. Get Base Context and Lists
	let baseCtxContent;
	if (bot.aiPersonality && bot.aiPersonality.trim().length > 0) {
		baseCtxContent = bot.aiPersonality;
	} else {
		const ctxPath = path.join(database.databasePath, "textos", "llm_context.txt");
		baseCtxContent = (await fs.readFile(ctxPath, "utf8")) || "";
	}
	const botCtxPath = path.join(database.databasePath, "textos", "llm_bot_context.txt");
	const botCtxContent = (await fs.readFile(botCtxPath, "utf8")) || "";

	const { cmdSimpleList, cmdGerenciaSimplesList } = getCommandLists(bot, group);

	// 2. Prepare Question/Prompt
	let question = args.length > 0 ? args.join(" ") : (message.caption ?? message.content);
	const quotedMsg = await message.origin.getQuotedMessage();
	if (quotedMsg && !message.originReaction) {
		const quotedText = quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body;
		if (quotedText && quotedText.length > 10) {
			question += `\n\nContexto da mensagem respondida: ${quotedText}`;
		}
	}

	// 3. Check for Media (direct or from quoted message)
	const { media, hadQuoted, quotedHadMedia } = await getMediaFromMessage(message);

	// Validation: No media and short question
	if (!media && question.length < 5) {
		if (bot.pvAI) {
			const greetingPath = path.join(database.databasePath, "textos", "bot-greeting.txt");
			const greetingContent =
				(await fs.readFile(greetingPath, "utf8")) ?? `Oi, eu sou ${bot.nomeExibir || "ravenabot"}!`;
			return new ReturnMessage({
				chatId,
				content: greetingContent,
				reaction: "👋",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		} else {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça uma pergunta ou uma imagem com uma pergunta. Exemplo: !ai Qual é a capital da França?",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}
	}

	// 4. Classification
	// Now we classify FIRST, telling the LLM if there is media attached.
	const classificationResult = await classifyRequest(question, cmdSimpleList, "", !!media);

	logger.debug(
		`[aiCommand] Classified request: "${question.substring(0, 100)}" (from ${message.author}, has Media: ${!!media}) -> ${classificationResult.classification ?? "Erro"} ${classificationResult.command ?? ""}`
	);

	// 5. Handle Classification Results
	const aiAliases = ["ai", "ia", "gpt", "gemini"];
	if (
		classificationResult.classification === "command" &&
		aiAliases.includes(classificationResult.command?.toLowerCase().replace(/!/g, ""))
	) {
		logger.debug("[aiCommand] Self-invocation detected, reclassifying to general");
		classificationResult.classification = "general";
	}

	// CASE A: Command Invocation (e.g. "make sticker", "weather in paris")
	if (classificationResult.classification === "command" && classificationResult.command) {
		// Even if it has media, if it classified as a command (like !sticker), we hand it off to the command handler.
		return handleCommandInvocation(classificationResult, bot, message, group);
	}

	// CASE B: Analysis/Bot Question WITH Media (e.g. "what is this?", "summarize this video")
	if (media && media.data) {
		// If it's NOT a command, but HAS media, we treat it as an analysis request.
		return handleMediaRequest(
			bot,
			message,
			media,
			question,
			baseCtxContent,
			group,
			chatId,
			database
		);
	}

	// CASE B1: Had a quoted message with media but couldn't recover it (cache expired or download failed)
	// Only trigger when the quoted message was confirmed to have media (quotedHadMedia=true)
	// or when the quoted message couldn't be retrieved from cache at all (quotedHadMedia=null)
	if (hadQuoted && !media && quotedHadMedia !== false) {
		return new ReturnMessage({
			chatId,
			content:
				"⚠️ Não foi possível recuperar a mídia da mensagem marcada. Ela pode ter saído do cache ou o download falhou.",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
	// CASE C: Text-Only Response (General, Group, Bot-chat)
	// Build Context based on Classification
	let systemContext = "";
	const customPersonalidade =
		group?.customAIPrompt && group?.customAIPrompt?.length > 0
			? `\n\n((Sua personalidade: '${group.customAIPrompt}'))\n\n`
			: "";

	if (classificationResult.classification === "general") {
		// Minimal context
		systemContext = `${baseCtxContent}. Responda de forma útil e direta.${customPersonalidade}`;
	} else if (classificationResult.classification === "group") {
		// Group context + History
		const msgsRecentes = (await getRecentMessages(chatId)).slice(0, 15);
		let historicoCtx = "";
		if (msgsRecentes.length > 0) {
			historicoCtx = `\n\nContexto das últimas mensagens deste chat: ---------------${formatMessagesForPrompt(msgsRecentes)}
---------------\n`;
		}
		systemContext = `${baseCtxContent}\n${customPersonalidade}\n${historicoCtx}`;
	} else {
		// Bot related - Full context
		const variaveisReturn = await bot.eventHandler.commandHandler.management.listVariables(
			bot,
			message,
			args,
			group
		);
		const variaveisList = variaveisReturn.content;

		systemContext = `${baseCtxContent}\n${botCtxContent}\n\n## Comandos que você pode processar:\n\n${cmdSimpleList}\n\nPara os comandos personalizados criados com g-addCmd, você pode usar variáveis:\n${variaveisList}\n\nEstes são os comandos usados apenas por administradores: ${cmdGerenciaSimplesList}\n\n${customPersonalidade}`;
	}

	systemContext +=
		"\n((Não se apresente, a não ser que o usuário solicite informações sobre você))";

	// Add user name context
	const promptAutor =
		message?.goMessageData?.key?.pushName ??
		message?.name ??
		message?.authorName ??
		message?.pushname;
	if (promptAutor) {
		systemContext = `Nome de quem enviou o prompt: ${promptAutor}\n\n` + systemContext;
	}

	// Execute LLM Request
	const completionOptions = {
		prompt: question,
		systemContext,
		priority: 5
	};

	try {
		logger.debug("[aiCommand] Requesting LLM completion");
		const response = await llmService.getCompletion(completionOptions);

		// Process variables
		let processedResponse;
		try {
			processedResponse = await bot.eventHandler.commandHandler.variableProcessor.process(
				response,
				{ message, group, command: false, options: {}, bot }
			);
		} catch (e) {
			processedResponse = response;
		}

		return new ReturnMessage({
			chatId,
			content: processedResponse,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("[aiCommand] Error in LLM completion:", error);
		return new ReturnMessage({
			chatId,
			content: "Desculpe, encontrei um erro ao processar sua solicitação.",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
}

/**
 * Separated Logic for Media Processing
 */
async function handleMediaRequest(
	bot,
	message,
	media,
	question,
	baseCtxContent,
	group,
	chatId,
	database
) {
	const completionOptions = {
		prompt: question,
		systemContext: baseCtxContent,
		priority: 5
	};
	const customPersonalidade =
		group?.customAIPrompt && group?.customAIPrompt?.length > 0
			? `\n\n((Sua personalidade: '${group.customAIPrompt}'))\n\n`
			: "";

	let tipoMedia = "";
	const tempPathsToRemove = [];

	if (media.mimetype.includes("image")) {
		tipoMedia = "Imagem";
		if (completionOptions.prompt.length < 4) {
			completionOptions.prompt = "Analise esta imagem e entregue um resumo detalhado";
		}
		completionOptions.image = media.data;

		if (bot.aiPersonality && bot.aiPersonality.trim().length > 0) {
			completionOptions.systemContext =
				bot.aiPersonality +
				"\n\nSuas mensagens são processadas e enviadas pelo WhatsApp.\n\nO seu objetivo agora é analisar o conteúdo de imagem recebida, atendendo o que o usuário pediu no prompt (caso exista).";
		} else {
			const ctxPath = path.join(database.databasePath, "textos", "llm_context_images.txt");
			completionOptions.systemContext =
				(await fs.readFile(ctxPath, "utf8")) ??
				`Você se chama ${bot.nomeExibir || "ravenabot"} e deve interpretar esta imagem enviada no WhatsApp`;
		}
		completionOptions.systemContext += customPersonalidade;
	} else if (media.mimetype.includes("video")) {
		tipoMedia = "Video";
		if (completionOptions.prompt.length < 4) {
			completionOptions.prompt =
				"Analise este vídeo e entregue um resumo detalhado do que acontece nele";
		}

		try {
			const tempDirBase = path.join(__dirname, "../../temp");
			const tempDir = path.join(tempDirBase, `ai_video_${Date.now()}`);
			const videoPath = path.join(tempDirBase, `ai_video_${Date.now()}.mp4`);

			await fs.mkdir(tempDirBase, { recursive: true });
			await fs.writeFile(videoPath, Buffer.from(media.data, "base64"));

			tempPathsToRemove.push(videoPath);
			tempPathsToRemove.push(tempDir);

			const framePaths = await extractFrames(videoPath, tempDir, 75);
			const frames = [];
			for (const filePath of framePaths) {
				const data = await fs.readFile(filePath, "base64");
				frames.push(data);
			}

			completionOptions.images = frames;
			completionOptions.timeout = 60000;

			if (bot.aiPersonality && bot.aiPersonality.trim().length > 0) {
				completionOptions.systemContext =
					bot.aiPersonality +
					"\n\nSuas mensagens são processadas e enviadas pelo WhatsApp.\n\nO seu objetivo agora é analisar o conteúdo do vídeo recebido, atendendo o que o usuário pediu no prompt (caso exista).";
			} else {
				const ctxPath = path.join(database.databasePath, "textos", "llm_context_videos.txt");
				completionOptions.systemContext =
					(await fs.readFile(ctxPath, "utf8")) ??
					`Você se chama ${bot.nomeExibir || "ravenabot"} e deve interpretar este vídeo enviado no WhatsApp`;
			}
			completionOptions.systemContext += customPersonalidade;
		} catch (videoError) {
			logger.error("[aiCommand] Error processing video:", videoError);
			return new ReturnMessage({
				chatId,
				content: `Ocorreu um erro ao processar o vídeo: ${videoError.message}`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}
	} else {
		return new ReturnMessage({
			chatId,
			content: `Ainda não processo este tipo de arquivo (${media.mimetype}) 😟 Consigo apenas analisar imagens e vídeos!`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const promptAutor =
		message?.goMessageData?.key?.pushName ??
		message?.name ??
		message?.authorName ??
		message?.pushname;
	if (promptAutor) {
		completionOptions.systemContext =
			`Nome de quem enviou o prompt: ${promptAutor}\n\n` + completionOptions.systemContext;
	}

	try {
		logger.debug("[aiCommand] Requesting LLM completion for media");
		const response = await llmService.getCompletion(completionOptions);

		// Store in history
		message.content = `${tipoMedia}[${response}]`;
		message.caption = `${tipoMedia}[${response}]`;
		storeMessage(message, message.author);

		let processedResponse;
		try {
			processedResponse = await bot.eventHandler.commandHandler.variableProcessor.process(
				response,
				{ message, group, command: false, options: {}, bot }
			);
		} catch (e) {
			processedResponse = response;
		}

		return new ReturnMessage({
			chatId,
			content: processedResponse,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("[aiCommand] Error in Media LLM completion:", error);
		return new ReturnMessage({
			chatId,
			content: "Desculpe, encontrei um erro ao processar sua solicitação de mídia.",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} finally {
		// Cleanup
		for (const pathToRemove of tempPathsToRemove) {
			try {
				const stats = await fs.stat(pathToRemove);
				if (stats.isDirectory()) {
					await fs.rm(pathToRemove, { recursive: true, force: true });
				} else {
					await fs.unlink(pathToRemove);
				}
			} catch (cleanupError) {
				logger.error(`[aiCommand] Error cleaning temp file ${pathToRemove}:`, cleanupError);
			}
		}
	}
}

// Auxiliar para obter mídia da mensagem.
// Retorna { media, hadQuoted, quotedHadMedia } onde:
//   hadQuoted: havia uma mensagem citada (mesmo que não fosse recuperável)
//   quotedHadMedia: a mensagem citada recuperada tinha mídia (mas o download falhou), ou null se não foi possível recuperar a mensagem citada
async function getMediaFromMessage(message) {
	// Se a mensagem tem mídia direta
	if (message.type !== "text") {
		// Lazy loading: content existe mas sem base64 (otimização de RAM)
		if (message.content && message.content.data) {
			return { media: message.content, hadQuoted: false, quotedHadMedia: false };
		}
		if (typeof message.downloadMedia === "function") {
			try {
				const media = await message.downloadMedia();
				return { media, hadQuoted: false, quotedHadMedia: false };
			} catch (e) {
				logger.error("[getMediaFromMessage] Erro ao baixar mídia:", e);
				return { media: null, hadQuoted: false, quotedHadMedia: false };
			}
		}
		return { media: message.content ?? null, hadQuoted: false, quotedHadMedia: false };
	}

	// Verifica se havia uma mensagem citada (antes de tentar recuperá-la do cache)
	const hadQuoted = !!message.hasQuotedMsg;

	// Tenta obter mídia da mensagem citada
	try {
		const quotedMsg = await message.origin.getQuotedMessage();
		if (quotedMsg && quotedMsg.hasMedia) {
			const media = await quotedMsg.downloadMedia();
			// quotedHadMedia=true: a mensagem citada existe e tem mídia (download pode ter falhado)
			return { media, hadQuoted, quotedHadMedia: true };
		}
		// Quoted msg exists but has no media (or couldn't be recovered from cache)
		return { media: null, hadQuoted, quotedHadMedia: quotedMsg ? false : null };
	} catch (error) {
		logger.error("Erro ao obter mídia da mensagem citada:", error);
	}
	return { media: null, hadQuoted, quotedHadMedia: null };
}

const commands = [
	new Command({
		name: "ai",
		description: "Pergunte algo à IA",
		category: "ia",
		group: "askia",
		reactions: {
			trigger: "🤖",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🤖"
		},
		cooldown: 30,
		method: aiCommand
	}),
	new Command({
		name: "ia",
		description: "Alias para AI",
		category: "ia",
		group: "askia",
		reactions: {
			trigger: "🤖",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🤖"
		},
		cooldown: 30,
		method: aiCommand
	}),
	new Command({
		name: "gpt",
		hidden: true,
		description: "Alias para AI",
		category: "ia",
		group: "askia",
		reactions: {
			trigger: "🤖",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🤖"
		},
		cooldown: 30,
		method: aiCommand
	}),
	new Command({
		name: "gemini",
		hidden: true,
		description: "Alias para AI",
		category: "ia",
		group: "askia",
		reactions: {
			trigger: "🤖",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🤖"
		},
		cooldown: 30,
		method: aiCommand
	})
];

module.exports = { commands, aiCommand };
