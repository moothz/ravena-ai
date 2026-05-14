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
 * Traduz texto para o idioma especificado
 * @param {string} text - Texto a ser traduzido
 * @param {string} targetLanguage - Código do idioma de destino
 * @returns {Promise<string>} - Texto traduzido
 */
async function translateText(text, sourceLanguage, targetLanguage) {
	try {
		// Importar o módulo 'translate' dinamicamente
		const translateModule = await import("translate");
		const translate = translateModule.default;

		// Configurar o mecanismo de tradução (padrão é 'google')
		translate.engine = "google";
		// Se você tiver uma chave API, pode configurá-la assim:
		// translate.key = process.env.TRANSLATE_API_KEY;

		// Aplicar rate limiting à tradução
		const translateWithRateLimit = wrapWithRateLimit(async (text, options) => {
			const resp = await translate(text, options);
			console.log("trate", text, options, resp);
			return resp;
		});

		// Traduzir o texto
		const translatedText = await translateWithRateLimit(text, {
			from: sourceLanguage,
			to: targetLanguage
		});
		return translatedText;
	} catch (error) {
		logger.error("Erro ao traduzir texto:", error);
		throw error;
	}
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
		const quotedText = "";

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

				textToTranslate =
					quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body ?? quotedMsg._data.body ?? "";
				//quotedText = `Original: "${textToTranslate}"\n\n`;
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
 * @returns {Promise<boolean>} - True se a reação foi processada
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

		const textToTranslate = message.content;
		const chatId = message.group ?? message.author;

		// Traduzir o texto
		const translatedText = await translateText(textToTranslate, "pt", targetLanguage);

		// Criar a resposta
		const languageName = LANGUAGE_NAMES[targetLanguage];
		const response = `🌐 *Tradução para ${languageName} (${reaction.reaction})*\n\n${translatedText}`;

		// Enviar a tradução
		return new ReturnMessage({
			chatId,
			content: response,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
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
module.exports = { commands, translateText };
