const axios = require("axios");
const cheerio = require("cheerio");

const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("search-commands");

// Decodificador simples de entidades HTML
function decodeHtmlEntities(text) {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

//logger.info('Módulo SearchCommands carregado');

const LLMService = require("../services/LLMService");

/**
 * Busca na web usando DuckDuckGo com fallbacks (Bing e DDG API)
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com os resultados da busca
 */
async function searchWeb(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;

		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Manda o que você quer pesquisar! Exemplo: *!buscar tutorial javascript*",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		const query = args.join(" ");
		logger.info(`Buscando na web por: ${query}`);

		const llmService = LLMService.getInstance();
		const resultsMessage = await llmService.searchWeb(query);

		logger.info(`Resultados de busca enviados com sucesso para "${query}"`);

		// Retorna os resultados
		return new ReturnMessage({
			chatId,
			content: resultsMessage,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro na busca web:", error);
		const chatId = message.group ?? message.author;

		return new ReturnMessage({
			chatId,
			content: "❌ Deu erro ao fazer a busca na web. Tenta de novo daqui a pouco.",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
}

/**
 * Busca por imagens
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessages
 */
async function searchImages(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		const returnMessages = [];

		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Manda o que você quer buscar em imagens! Exemplo: *!buscar-img gatos fofos*",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		const query = args.join(" ");
		logger.info(`Buscando imagens para: ${query}`);

		// Envia indicador de digitação
		try {
			await bot.client.sendPresenceUpdate("composing", chatId);
		} catch (error) {
			logger.error("Erro ao enviar indicador de digitação:", error);
		}

		// Informa o usuário
		returnMessages.push(
			new ReturnMessage({
				chatId,
				content: `🔍 Buscando imagens para "${query}"...`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			})
		);

		try {
			// Obtém a API key do .env
			const unsplashApiKey = process.env.UNSPLASH_API_KEY;

			// Adiciona logging para debug
			logger.debug(`Usando API key: ${unsplashApiKey.substring(0, 5)}...`);

			// Utiliza Unsplash API para buscar imagens
			const response = await axios.get("https://api.unsplash.com/search/photos", {
				params: {
					query,
					per_page: 3,
					client_id: unsplashApiKey
				},
				timeout: 10000
			});

			const results = response.data.results;

			if (!results || results.length === 0) {
				return new ReturnMessage({
					chatId,
					content: `Não foram encontradas imagens para "${query}". Tente outra consulta.`,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			}

			// Adiciona logging para debug
			logger.debug(`Encontradas ${results.length} imagens para "${query}"`);

			// Retorna até 3 imagens
			const imageMessages = [];
			for (let i = 0; i < Math.min(3, results.length); i++) {
				try {
					const imgUrl = results[i].urls.regular;
					logger.debug(`Processando imagem ${i + 1}: ${imgUrl}`);

					// Obtém dados da imagem
					const imgResponse = await axios.get(imgUrl, {
						responseType: "arraybuffer",
						timeout: 15000
					});

					// Determina o tipo MIME
					const contentType = imgResponse.headers["content-type"] || "image/jpeg";

					// Cria mídia
					const media = {
						mimetype: contentType,
						data: Buffer.from(imgResponse.data).toString("base64"),
						filename: `image-${i + 1}.jpg`,
						isMessageMedia: true
					};

					// Adiciona mensagem com a imagem
					imageMessages.push(
						new ReturnMessage({
							chatId,
							content: media,
							options: {
								caption: `Resultado ${i + 1} para "${query}" | Fonte: Unsplash`,
								quotedMessageId: message.origin.id._serialized,
								goReply: message.origin
							},
							delay: i * 1500 // Adiciona um pequeno atraso entre imagens
						})
					);

					logger.debug(`Imagem ${i + 1} processada com sucesso`);
				} catch (imgError) {
					logger.error(`Erro ao processar imagem ${i + 1}:`, imgError);
				}
			}

			// Retorna as imagens encontradas
			if (imageMessages.length > 0) {
				logger.info(`Enviando ${imageMessages.length} imagens para "${query}"`);
				return imageMessages;
			} else {
				logger.warn(`Nenhuma imagem processada com sucesso para "${query}"`);
				return new ReturnMessage({
					chatId,
					content: `❌ Não consegui processar as imagens para "${query}". Tenta de novo daqui a pouco.`,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			}
		} catch (apiError) {
			logger.error("Erro na API de imagens:", apiError);
			logger.debug(`Detalhes do erro: ${JSON.stringify(apiError.response?.data || "Sem dados")}`);

			// Verifica erro específico de limite da API
			const isRateLimitError =
				apiError.response &&
				(apiError.response.status === 429 ||
					apiError.response.data?.errors?.includes("Rate Limit Exceeded"));

			if (isRateLimitError) {
				return new ReturnMessage({
					chatId,
					content: `Limite de requisições excedido. Tenta de novo daqui a pouco.`,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			}

			// Fallback para imagens de placeholder se a API falhar
			const placeholderMessages = [];

			// URLs para imagens de placeholder
			const placeholderUrls = [
				`https://via.placeholder.com/800x600?text=${encodeURIComponent(query + " 1")}`,
				`https://via.placeholder.com/800x600?text=${encodeURIComponent(query + " 2")}`,
				`https://via.placeholder.com/800x600?text=${encodeURIComponent(query + " 3")}`
			];

			logger.info(`Usando imagens de placeholder como fallback para "${query}"`);

			// Tenta obter imagens de placeholder
			for (let i = 0; i < 3; i++) {
				try {
					// Obtém dados da imagem
					const response = await axios.get(placeholderUrls[i], {
						responseType: "arraybuffer",
						timeout: 10000
					});

					// Cria mídia
					const media = {
						mimetype: "image/jpeg",
						data: Buffer.from(response.data).toString("base64"),
						filename: `placeholder-${i + 1}.jpg`,
						isMessageMedia: true
					};

					// Adiciona mensagem com a imagem
					placeholderMessages.push(
						new ReturnMessage({
							chatId,
							content: media,
							options: {
								quotedMessageId: message.origin.id._serialized,
								goReply: message.origin,
								caption: `Resultado ${i + 1} para "${query}"`
							},
							delay: i * 1000 // Adiciona um pequeno atraso entre imagens
						})
					);
				} catch (imgError) {
					logger.error(`Erro ao enviar imagem de placeholder:`, imgError);
				}
			}

			// Retorna as imagens de placeholder encontradas
			if (placeholderMessages.length > 0) {
				return placeholderMessages;
			} else {
				return new ReturnMessage({
					chatId,
					content: `❌ Não consegui buscar imagens para "${query}". Tenta de novo daqui a pouco.`,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			}
		}
	} catch (error) {
		logger.error("Erro na busca de imagens:", error);
		const chatId = message.group ?? message.author;

		return new ReturnMessage({
			chatId,
			content: "❌ Deu erro ao buscar imagens. Tenta de novo daqui a pouco.",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
}

// Comandos usando a classe Command
const commands = [
	new Command({
		name: "buscar",
		description: "Busca na web",
		category: "busca",
		aliases: ["google", "search"],
		reactions: {
			trigger: "🔍",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔍"
		},
		method: searchWeb
	}),

	new Command({
		name: "buscar-img",
		description: "Busca por imagens",
		category: "busca",
		aliases: ["img", "imagem"],
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📷"
		},
		method: searchImages
	})
];

// Registra os comandos sendo exportados
//logger.debug(`Exportando ${commands.length} comandos:`, commands.map(cmd => cmd.name));

const helper = {
	about: "Mecanismo de busca na web e imagens",
	implementation: "Integra com engines de busca na web (DuckDuckGo/Google)",
	tags: "busca,pesquisa,google,web,imagens",
	cmds: [
		{
			cmd: "!buscar",
			desc: "Realiza uma pesquisa rápida na internet",
			usage: ["!buscar historia do brasil", "!buscar receita de bolo"],
			category: "busca"
		},
		{
			cmd: "!buscar-img",
			desc: "Pesquisa e envia imagens encontradas na web",
			usage: ["!buscar-img paisagem da serra", "!buscar-img wallpaper 4k"],
			category: "busca"
		}
	]
};

module.exports = {
	helper,
	commands
};
