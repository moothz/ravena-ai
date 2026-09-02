const axios = require("axios");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("translation-commands");

//logger.info('Módulo TranslationCommands carregado');

// Mapeamento de códigos de idioma para nomes completos
const LANGUAGE_NAMES = {
	af: "Afrikaans",
	sq: "Albanian",
	am: "Amharic",
	ar: "Arabic",
	hy: "Armenian",
	az: "Azerbaijani",
	eu: "Basque",
	be: "Belarusian",
	bn: "Bengali",
	bs: "Bosnian",
	bg: "Bulgarian",
	ca: "Catalan",
	ceb: "Cebuano",
	ny: "Chichewa",
	"zh-cn": "Chinese (Simplified)",
	"zh-tw": "Chinese (Traditional)",
	co: "Corsican",
	hr: "Croatian",
	cs: "Czech",
	da: "Danish",
	nl: "Dutch",
	en: "English",
	eo: "Esperanto",
	et: "Estonian",
	tl: "Filipino",
	fi: "Finnish",
	fr: "French",
	fy: "Frisian",
	gl: "Galician",
	ka: "Georgian",
	de: "German",
	el: "Greek",
	gu: "Gujarati",
	ht: "Haitian Creole",
	ha: "Hausa",
	haw: "Hawaiian",
	iw: "Hebrew",
	hi: "Hindi",
	hmn: "Hmong",
	hu: "Hungarian",
	is: "Icelandic",
	ig: "Igbo",
	id: "Indonesian",
	ga: "Irish",
	it: "Italian",
	ja: "Japanese",
	jw: "Javanese",
	kn: "Kannada",
	kk: "Kazakh",
	km: "Khmer",
	ko: "Korean",
	ku: "Kurdish (Kurmanji)",
	ky: "Kyrgyz",
	lo: "Lao",
	la: "Latin",
	lv: "Latvian",
	lt: "Lithuanian",
	lb: "Luxembourgish",
	mk: "Macedonian",
	mg: "Malagasy",
	ms: "Malay",
	ml: "Malayalam",
	mt: "Maltese",
	mi: "Maori",
	mr: "Marathi",
	mn: "Mongolian",
	my: "Myanmar (Burmese)",
	ne: "Nepali",
	no: "Norwegian",
	ps: "Pashto",
	fa: "Persian",
	pl: "Polish",
	pt: "Portuguese",
	pa: "Punjabi",
	ro: "Romanian",
	ru: "Russian",
	sm: "Samoan",
	gd: "Scots Gaelic",
	sr: "Serbian",
	st: "Sesotho",
	sn: "Shona",
	sd: "Sindhi",
	si: "Sinhala",
	sk: "Slovak",
	sl: "Slovenian",
	so: "Somali",
	es: "Spanish",
	su: "Sundanese",
	sw: "Swahili",
	sv: "Swedish",
	tg: "Tajik",
	ta: "Tamil",
	te: "Telugu",
	th: "Thai",
	tr: "Turkish",
	uk: "Ukrainian",
	ur: "Urdu",
	uz: "Uzbek",
	vi: "Vietnamese",
	cy: "Welsh",
	xh: "Xhosa",
	yi: "Yiddish",
	yo: "Yoruba",
	zu: "Zulu",
	// Common shortcuts
	"pt-br": "Portuguese (Brazil)",
	zh: "Chinese (Simplified)"
};

// Mapeamento de bandeiras para códigos de idioma
const FLAG_TO_LANGUAGE = {
	"🇦🇷": "es", // Argentina - Spanish
	"🇦🇹": "de", // Austria - German
	"🇦🇺": "en", // Australia - English
	"🇧🇪": "fr", // Belgium - French
	"🇧🇷": "pt", // Brazil - Portuguese
	"🇨🇦": "en", // Canada - English
	"🇨🇭": "de", // Switzerland - German
	"🇨🇱": "es", // Chile - Spanish
	"🇨🇳": "zh-cn", // China - Chinese
	"🇨🇴": "es", // Colombia - Spanish
	"🇨🇿": "cs", // Czech Republic - Czech
	"🇩🇪": "de", // Germany - German
	"🇩🇰": "da", // Denmark - Danish
	"🇪🇦": "es", // Spain (Ceuta & Melilla) - Spanish
	"🇪🇬": "ar", // Egypt - Arabic
	"🇪🇸": "es", // Spain - Spanish
	"🇫🇮": "fi", // Finland - Finnish
	"🇫🇷": "fr", // France - French
	"🇬🇧": "en", // UK - English
	"🇬🇷": "el", // Greece - Greek
	"🇭🇰": "zh-tw", // Hong Kong - Traditional Chinese
	"🇭🇺": "hu", // Hungary - Hungarian
	"🇮🇩": "id", // Indonesia - Indonesian
	"🇮🇪": "en", // Ireland - English
	"🇮🇱": "iw", // Israel - Hebrew
	"🇮🇳": "hi", // India - Hindi
	"🇮🇷": "fa", // Iran - Persian
	"🇮🇸": "is", // Iceland - Icelandic
	"🇮🇹": "it", // Italy - Italian
	"🇯🇵": "ja", // Japan - Japanese
	"🇰🇷": "ko", // South Korea - Korean
	"🇲🇽": "es", // Mexico - Spanish
	"🇲🇾": "ms", // Malaysia - Malay
	"🇳🇱": "nl", // Netherlands - Dutch
	"🇳🇴": "no", // Norway - Norwegian
	"🇳🇿": "en", // New Zealand - English
	"🇵🇪": "es", // Peru - Spanish
	"🇵🇭": "tl", // Philippines - Filipino
	"🇵🇱": "pl", // Poland - Polish
	"🇵🇹": "pt", // Portugal - Portuguese
	"🇷🇴": "ro", // Romania - Romanian
	"🇷🇺": "ru", // Russia - Russian
	"🇸🇦": "ar", // Saudi Arabia - Arabic
	"🇸🇪": "sv", // Sweden - Swedish
	"🇸🇬": "en", // Singapore - English
	"🇹🇭": "th", // Thailand - Thai
	"🇹🇷": "tr", // Turkey - Turkish
	"🇹🇼": "zh-tw", // Taiwan - Traditional Chinese
	"🇺🇦": "uk", // Ukraine - Ukrainian
	"🇺🇸": "en", // USA - English
	"🇻🇳": "vi", // Vietnam - Vietnamese
	"🇿🇦": "en" // South Africa - English
};

// Mapeamento de variações comuns de nomes de idiomas para códigos de idioma
const LANGUAGE_ALIASES = {
	inglês: "en",
	ingles: "en",
	english: "en",
	português: "pt",
	portugues: "pt",
	portuguese: "pt",
	brasileiro: "pt",
	brazil: "pt-br",
	brasil: "pt-br",
	"pt-br": "pt",
	espanhol: "es",
	spanish: "es",
	francês: "fr",
	frances: "fr",
	french: "fr",
	alemão: "de",
	alemao: "de",
	german: "de",
	italiano: "it",
	italian: "it",
	japonês: "ja",
	japones: "ja",
	japanese: "ja",
	chinês: "zh-cn",
	chines: "zh-cn",
	chinese: "zh-cn",
	russo: "ru",
	russian: "ru",
	árabe: "ar",
	arabe: "ar",
	arabic: "ar",
	coreano: "ko",
	korean: "ko"
};

/**
 * Obtém o código do idioma a partir do nome ou alias do idioma
 * @param {string} languageName - Nome ou alias do idioma
 * @returns {string|null} - Código do idioma ou null se não encontrado
 */
function getLanguageCode(languageName) {
	const lowercaseLanguage = languageName.toLowerCase().trim();

	// Verifica se é um código de idioma direto
	if (LANGUAGE_NAMES[lowercaseLanguage]) {
		return lowercaseLanguage;
	}

	// Verifica se é um alias
	if (LANGUAGE_ALIASES[lowercaseLanguage]) {
		return LANGUAGE_ALIASES[lowercaseLanguage];
	}

	// Busca nos nomes de idiomas
	for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
		if (name.toLowerCase() === lowercaseLanguage) {
			return code;
		}
	}

	return null;
}

/**
 * Implementação de rate limiting simples para evitar bloqueios por excesso de requisições
 * @param {function} func - Função a ser limitada
 * @param {number} delay - Tempo de espera entre requisições em ms
 * @param {number} maxRetries - Número máximo de tentativas
 * @returns {function} - Função com rate limiting
 */
const wrapWithRateLimit = (func, delay = 500, maxRetries = 3) => {
	let lastCallTime = 0;

	return async function (...args) {
		// Garantir intervalo mínimo entre requisições
		const now = Date.now();
		const timeElapsed = now - lastCallTime;

		if (timeElapsed < delay) {
			await new Promise((resolve) => setTimeout(resolve, delay - timeElapsed));
		}

		lastCallTime = Date.now();

		// Fazer tentativas com backoff exponencial
		let retries = 0;

		while (retries <= maxRetries) {
			try {
				return await func(...args);
			} catch (error) {
				if (
					error.message &&
					(error.message.includes("rate limit") ||
						error.message.includes("too many requests") ||
						error.message.includes("429"))
				) {
					retries++;
					if (retries > maxRetries) {
						throw new Error(`Limite de taxa excedido após ${maxRetries} tentativas`);
					}
					// Esperar com backoff exponencial
					await new Promise((resolve) => setTimeout(resolve, delay * Math.pow(2, retries)));
				} else {
					// Outro tipo de erro, propagar imediatamente
					throw error;
				}
			}
		}
	};
};

/**
 * Extrai texto de um objeto de mensagem em qualquer formato suportado
 * @param {Object|string} msg - Objeto de mensagem ou string
 * @returns {string} - Texto extraído ou string vazia
 */
function extractTextFromMessage(msg) {
	if (!msg) return "";
	if (typeof msg === "string") return msg.trim();
	if (typeof msg.content === "string" && msg.content.trim()) return msg.content.trim();
	if (typeof msg.caption === "string" && msg.caption.trim()) return msg.caption.trim();
	if (typeof msg.body === "string" && msg.body.trim()) return msg.body.trim();
	if (typeof msg.text === "string" && msg.text.trim()) return msg.text.trim();
	if (msg.content && typeof msg.content === "object") {
		if (typeof msg.content.text === "string" && msg.content.text.trim())
			return msg.content.text.trim();
		if (typeof msg.content.caption === "string" && msg.content.caption.trim())
			return msg.content.caption.trim();
		if (typeof msg.content.conversation === "string" && msg.content.conversation.trim())
			return msg.content.conversation.trim();
	}
	if (msg.goMessageData?.Message) {
		const m = msg.goMessageData.Message;
		if (typeof m.conversation === "string" && m.conversation.trim()) return m.conversation.trim();
		if (typeof m.extendedTextMessage?.text === "string" && m.extendedTextMessage.text.trim())
			return m.extendedTextMessage.text.trim();
		if (typeof m.imageMessage?.caption === "string" && m.imageMessage.caption.trim())
			return m.imageMessage.caption.trim();
		if (typeof m.videoMessage?.caption === "string" && m.videoMessage.caption.trim())
			return m.videoMessage.caption.trim();
		if (typeof m.documentMessage?.caption === "string" && m.documentMessage.caption.trim())
			return m.documentMessage.caption.trim();
	}
	if (msg.origin) {
		if (typeof msg.origin.body === "string" && msg.origin.body.trim())
			return msg.origin.body.trim();
		if (typeof msg.origin.caption === "string" && msg.origin.caption.trim())
			return msg.origin.caption.trim();
	}
	return "";
}

/**
 * 1. Tradução via DeepL API
 */
async function translateWithDeepL(text, sourceLanguage, targetLanguage) {
	const apiKey = process.env.DEEPL_API_KEY;
	if (!apiKey || apiKey.trim() === "") return null;

	try {
		const endpoint = apiKey.endsWith(":fx")
			? "https://api-free.deepl.com/v2/translate"
			: "https://api.deepl.com/v2/translate";

		let target = (targetLanguage || "en").toUpperCase();
		if (target === "EN" || target === "EN-US") target = "EN-US";
		else if (target === "EN-GB") target = "EN-GB";
		else if (target === "PT" || target === "PT-BR") target = "PT-BR";
		else if (target === "PT-PT") target = "PT-PT";

		let source =
			sourceLanguage && sourceLanguage !== "auto" ? sourceLanguage.toUpperCase() : undefined;
		if (source === "PT-BR" || source === "PT-PT") source = "PT";
		if (source === "EN-US" || source === "EN-GB") source = "EN";

		const response = await axios.post(
			endpoint,
			{
				text: [text],
				target_lang: target,
				...(source ? { source_lang: source } : {})
			},
			{
				headers: {
					Authorization: `DeepL-Auth-Key ${apiKey}`,
					"Content-Type": "application/json"
				},
				timeout: 10000
			}
		);

		const translated = response.data?.translations?.[0]?.text;
		if (translated && typeof translated === "string" && translated.trim().length > 0) {
			logger.debug(`[translateWithDeepL] Tradução concluída com sucesso.`);
			return translated.trim();
		}
	} catch (error) {
		logger.warn(`[translateWithDeepL] Falha ao traduzir via DeepL: ${error.message}`);
	}
	return null;
}

/**
 * 2. Tradução via LLM (LLMService)
 */
async function translateWithLLM(text, sourceLanguage, targetLanguage) {
	try {
		const LLMService = require("../services/LLMService");
		const llmService = LLMService.getInstance();
		const sourceLangName =
			sourceLanguage && sourceLanguage !== "auto"
				? LANGUAGE_NAMES[sourceLanguage] || sourceLanguage
				: null;
		const targetLangName = LANGUAGE_NAMES[targetLanguage] || targetLanguage || "English";

		const fromText = sourceLangName ? `from ${sourceLangName} ` : "";
		const completion = await llmService.getCompletion({
			prompt: text,
			systemContext: `You are a professional translator engine.
Translate the provided text ${fromText}into ${targetLangName}.
RULES:
1. Translate the TEXT CONTENT accurately and naturally.
2. DO NOT add explanations, conversational filler (e.g. "Here is the translation:"), notes, markdown code fences, or quotes.
3. Keep emojis, punctuation, and formatting marks (*bold*, _italic_) intact.
4. Output ONLY the translated text.`,
			priority: 4
		});

		if (
			completion &&
			typeof completion === "string" &&
			!completion.toLowerCase().startsWith("erro:") &&
			!completion.toLowerCase().startsWith("não foi possível")
		) {
			const trimmed = completion.trim();
			if (trimmed.length > 0) {
				logger.debug(`[translateWithLLM] Tradução concluída com sucesso.`);
				return trimmed;
			}
		}
	} catch (error) {
		logger.warn(`[translateWithLLM] Falha ao traduzir via LLM: ${error.message}`);
	}
	return null;
}

/**
 * 3. Tradução via MyMemory API
 */
async function translateWithMyMemory(text, sourceLanguage, targetLanguage) {
	try {
		const src = (
			sourceLanguage && sourceLanguage !== "auto" ? sourceLanguage : "auto"
		).toLowerCase();
		const tgt = (targetLanguage || "en").toLowerCase();

		const response = await axios.get("https://api.mymemory.translated.net/get", {
			params: {
				q: text,
				langpair: `${src}|${tgt}`
			},
			timeout: 10000
		});

		if (response.data && response.data.responseStatus === 200) {
			const translated = response.data.responseData?.translatedText;
			if (
				translated &&
				typeof translated === "string" &&
				!translated.includes("MYMEMORY WARNING:") &&
				translated.trim().length > 0
			) {
				logger.debug(`[translateWithMyMemory] Tradução concluída com sucesso.`);
				return translated.trim();
			}
		}
	} catch (error) {
		logger.warn(`[translateWithMyMemory] Falha ao traduzir via MyMemory: ${error.message}`);
	}
	return null;
}

/**
 * 4. Tradução via Google Translate (translate package)
 */
async function translateWithGoogle(text, sourceLanguage, targetLanguage) {
	try {
		const translateModule = await import("translate");
		const translate = translateModule.default;
		translate.engine = "google";

		const translateWithRateLimit = wrapWithRateLimit(
			async (txt, options) => await translate(txt, options)
		);

		const translatedText = await translateWithRateLimit(text, {
			from: sourceLanguage && sourceLanguage !== "auto" ? sourceLanguage : "auto",
			to: targetLanguage
		});

		if (translatedText && typeof translatedText === "string" && !translatedText.startsWith("<")) {
			logger.debug(`[translateWithGoogle] Tradução concluída com sucesso.`);
			return translatedText.trim();
		}
	} catch (error) {
		logger.warn(`[translateWithGoogle] Falha ao traduzir via Google: ${error.message}`);
	}
	return null;
}

/**
 * Traduz texto para o idioma especificado usando a cadeia de provedores:
 * 1. DeepL
 * 2. LLM
 * 3. MyMemory
 * 4. Google Translate
 * 5. Fallback (texto original)
 *
 * @param {string} text - Texto a ser traduzido
 * @param {string} sourceLanguage - Código do idioma de origem
 * @param {string} targetLanguage - Código do idioma de destino
 * @returns {Promise<string>} - Texto traduzido
 */
async function translateText(text, sourceLanguage, targetLanguage) {
	if (!text || typeof text !== "string" || text.trim() === "") {
		return text;
	}

	if (
		sourceLanguage &&
		sourceLanguage !== "auto" &&
		targetLanguage &&
		sourceLanguage.toLowerCase() === targetLanguage.toLowerCase()
	) {
		return text;
	}

	// 1. DeepL
	const deeplResult = await translateWithDeepL(text, sourceLanguage, targetLanguage);
	if (deeplResult && typeof deeplResult === "string") return deeplResult;

	// 2. LLM
	const llmResult = await translateWithLLM(text, sourceLanguage, targetLanguage);
	if (llmResult && typeof llmResult === "string") return llmResult;

	// 3. MyMemory
	const myMemoryResult = await translateWithMyMemory(text, sourceLanguage, targetLanguage);
	if (myMemoryResult && typeof myMemoryResult === "string") return myMemoryResult;

	// 4. Google
	const googleResult = await translateWithGoogle(text, sourceLanguage, targetLanguage);
	if (googleResult && typeof googleResult === "string") return googleResult;

	// 5. Fallback
	logger.warn("Todos os provedores de tradução falharam, mantendo texto original.");
	return text;
}

/**
 * Processa o comando de tradução
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - Mensagem de retorno com a tradução
 */
async function handleTranslation(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		// Preparar para lidar com diferentes formatos:
		// 1. !traduzir en Hello, world!
		// 2. !traduzir en (em resposta a uma mensagem)

		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça o idioma de destino e o texto a ser traduzido.\n" +
					"Exemplo: !traduzir pt en Olá, mundo!\n" +
					"Ou responda a uma mensagem com: !traduzir pt en",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Obter código do idioma de destino
		const languageArgSource = args[0]?.toLowerCase();
		const languageArgDest = args[1]?.toLowerCase();

		const sourceLanguage = getLanguageCode(languageArgSource ?? "en");
		const targetLanguage = getLanguageCode(languageArgDest ?? "pt");

		if (!sourceLanguage) {
			return new ReturnMessage({
				chatId,
				content:
					`Idioma de origem não reconhecido: "${args[0]}".\n` +
					"Exemplo de idiomas suportados: en (inglês), es (espanhol), fr (francês), etc.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		if (!targetLanguage) {
			return new ReturnMessage({
				chatId,
				content:
					`Idioma desejado não reconhecido: "${args[1]}".\n` +
					"Exemplo de idiomas suportados: en (inglês), es (espanhol), fr (francês), etc.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		let textToTranslate;

		// Verificar se é uma resposta a uma mensagem
		if (args.length === 2) {
			try {
				const quotedMsg = await message.origin.getQuotedMessage();
				if (!quotedMsg) {
					return new ReturnMessage({
						chatId,
						content: "Por favor, responda a uma mensagem ou forneça um texto para traduzir.",
						options: {
							quotedMessageId: message.origin.id._serialized,
							goReply: message.origin
						}
					});
				}

				textToTranslate = extractTextFromMessage(quotedMsg);
			} catch (error) {
				logger.error("Erro ao obter mensagem citada:", error);
				return new ReturnMessage({
					chatId,
					content: "Erro ao obter a mensagem citada. Por favor, tente novamente.",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			}
		} else {
			// Texto fornecido no comando
			textToTranslate = args.slice(2).join(" ");
		}

		if (!textToTranslate || textToTranslate.trim() === "") {
			return new ReturnMessage({
				chatId,
				content: "Texto vazio. Por favor, forneça um texto para traduzir.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Traduzir o texto
		const translatedText = await translateText(textToTranslate, sourceLanguage, targetLanguage);

		// Criar a resposta
		const sourceLanguageName = LANGUAGE_NAMES[sourceLanguage];
		const destLanguageName = LANGUAGE_NAMES[targetLanguage];
		const response = `🌐 *Tradução de ${sourceLanguageName} para ${destLanguageName}*\n\n${translatedText}`;

		return new ReturnMessage({
			chatId,
			content: response,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro no comando de tradução:", error);
		return new ReturnMessage({
			chatId,
			content: `Erro ao traduzir o texto. Por favor, tente novamente.\n${error.message}`
		});
	}
}

/**
 * Processa uma reação para potencialmente traduzir uma mensagem
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} reaction - Dados da reação
 * @returns {Promise<ReturnMessage|boolean>} - ReturnMessage com a tradução ou false
 */
async function processTranslationReaction(bot, message, args, group) {
	try {
		if (!message.originReaction) {
			logger.error(`[processTranslationReaction] Fui chamado sem uma originReaction.`);
			return false;
		}
		const reaction = message.originReaction;

		// Verificar se o emoji é uma bandeira
		const emoji = reaction.reaction;
		if (!FLAG_TO_LANGUAGE[emoji]) {
			return false;
		}

		const targetLanguage = FLAG_TO_LANGUAGE[emoji];
		const textToTranslate = extractTextFromMessage(message);

		if (!textToTranslate) {
			logger.debug(`[processTranslationReaction] Nenhum texto encontrado na mensagem da reação.`);
			return false;
		}

		const chatId = message.group ?? message.author;

		// Traduzir o texto (auto-detecta idioma de origem)
		const translatedText = await translateText(textToTranslate, "auto", targetLanguage);

		if (!translatedText || typeof translatedText !== "string") {
			logger.warn(`[processTranslationReaction] Falha na tradução ou retorno inválido.`);
			return false;
		}

		// Criar a resposta
		const languageName = LANGUAGE_NAMES[targetLanguage] || targetLanguage;
		const response = `🌐 *Tradução para ${languageName} (${reaction.reaction})*\n\n${translatedText}`;

		const quotedId =
			message.origin?.id?._serialized ||
			message.id ||
			(typeof message.origin?.id === "string" ? message.origin.id : undefined);

		// Enviar a tradução
		return new ReturnMessage({
			chatId,
			content: response,
			options: {
				quotedMessageId: quotedId,
				goReply: message.origin || message
			}
		});
	} catch (error) {
		logger.error("Erro ao processar reação de tradução:", error);
		return false;
	}
}

// Definição do comando
const commands = [
	new Command({
		name: "traduzir",
		description: "Traduz um texto para o idioma especificado",
		category: "utilidades",
		usage:
			"!traduzir [idiomaOriginal] [idiomaDesjado] [texto] ou !traduzir [idioma] em resposta a uma mensagem",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🌐",
			error: "❌"
		},
		method: handleTranslation
	}),
	new Command({
		name: "translationReactionHelper",
		description: "Invocado apenas pelo ReactionsHandler",
		reactions: {
			trigger: Object.keys(FLAG_TO_LANGUAGE)
		},
		usage: "",
		hidden: true,
		method: processTranslationReaction
	})
];

// Exportar comandos e manipulador de reação
const helper = {
	about: "Tradução de textos para diversos idiomas com detecção automática",
	implementation:
		"Integra com provedores de tradução para traduzir mensagens citadas ou textos informados por argumentos",
	tags: "traduzir,traducao,idiomas,ingles,espanhol,portugues,translate",
	cmds: [
		{
			cmd: "!traduzir",
			desc: "Traduz um texto citado ou informado para o idioma desejado",
			usage: ["!traduzir en Olá mundo", "!traduzir pt (em resposta a uma mensagem)"],
			category: "utilidades"
		}
	]
};

module.exports = {
	helper,
	commands,
	translateText
};
