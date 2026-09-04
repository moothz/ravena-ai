const axios = require("axios");
const cheerio = require("cheerio");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

// Cria novo logger
const logger = new Logger("myinstants-audio");

const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

const REQUEST_HEADERS = {
	"User-Agent": DEFAULT_USER_AGENT,
	"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
};

/**
 * Busca áudios no myinstants.com
 * @param {string} pesquisa
 * @returns {Promise<Array<{title: string, mp3: string}>>}
 */
async function buscarAudios(pesquisa) {
	if (!pesquisa || typeof pesquisa !== "string" || !pesquisa.trim()) {
		return [];
	}

	const query = encodeURIComponent(pesquisa.trim());
	const base = "https://www.myinstants.com";
	const url = `${base}/en/search/?name=${query}`;

	try {
		const { data, status } = await axios.get(url, {
			headers: REQUEST_HEADERS,
			timeout: 10000,
			validateStatus: (s) => s < 500
		});

		if (status === 404) {
			return [];
		}

		const $ = cheerio.load(data);
		const botoes = $(".instant");

		const resultados = [];

		botoes.each((i, el) => {
			const a = $(el).find("a.instant-link").first();
			const title = a.text().trim();
			const playBtn = $(el).find("button.small-button, button[onclick*='play']").first();
			const onclick = playBtn.attr("onclick") || $(el).find("button").attr("onclick");
			const match = onclick && onclick.match(/play\(['"]([^'"]+)['"]/i);
			const mp3 = match ? new URL(match[1], base).href : null;

			if (mp3 && title) {
				resultados.push({ title, mp3 });
			}
		});

		return resultados;
	} catch (err) {
		logger.error("Erro ao buscar áudios:", err.message || err);
		return [];
	}
}

/**
 * Baixa o áudio MP3 com headers de navegador e prepara o objeto de mídia
 * @param {Object} bot
 * @param {string} mp3Url
 * @param {string} title
 * @returns {Promise<Object>}
 */
async function baixarAudioComoMedia(bot, mp3Url, title) {
	const response = await axios.get(mp3Url, {
		headers: {
			"User-Agent": DEFAULT_USER_AGENT,
			"Accept": "*/*",
			"Referer": "https://www.myinstants.com/"
		},
		responseType: "arraybuffer",
		timeout: 15000
	});

	const base64Data = Buffer.from(response.data).toString("base64");
	const mimetype = "audio/mpeg";
	const safeName = (title || "audio").replace(/[/\\?%*:|"<>]/g, "").slice(0, 50).trim() || "audio";
	const filename = `${safeName}.mp3`;

	if (bot && typeof bot.createMediaFromBase64 === "function") {
		return await bot.createMediaFromBase64(base64Data, mimetype, filename);
	}

	return {
		mimetype,
		data: base64Data,
		filename,
		source: "base64",
		isMessageMedia: true,
		size: response.data.length
	};
}

/**
 * Comando para buscar e enviar áudio do myinstants.com
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>}
 */
async function audioCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		if (!args || args.length < 1) {
			return new ReturnMessage({
				chatId,
				content: "🔇 Digite o nome do áudio para buscar no site MyInstants\n!audio nome do áudio",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const ultimoArg = args[args.length - 1];
		const index = parseInt(ultimoArg, 10);
		const numeroInformado = args.length > 1 && !isNaN(index);

		const query = (numeroInformado ? args.slice(0, -1).join(" ") : args.join(" ")).trim();

		if (!query) {
			return new ReturnMessage({
				chatId,
				content: "🔇 Digite o nome do áudio para buscar no site MyInstants\n!audio nome do áudio",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const resultados = await buscarAudios(query);

		if (!resultados.length) {
			return new ReturnMessage({
				chatId,
				content: `🔇 Nenhum áudio encontrado para "${query}".`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		if (!numeroInformado) {
			const preview = resultados.map((r, i) => `- ${i + 1}. ${r.title}`).join("\n");
			return new ReturnMessage({
				chatId,
				content: `🔊 Resultados para "${query}":\n${preview}\n\nUse: !audio ${query} número_do_áudio para enviar o áudio desejado.\n\nExemplo: !audio ${query} 1`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const indexValido = index - 1;
		const resultado = resultados[indexValido];

		if (!resultado) {
			return new ReturnMessage({
				chatId,
				content: `❌ Número inválido, para '${query}' digite um número entre 1 e ${resultados.length}.\n!audio ${query} n`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		logger.info(`Baixando e enviando áudio: ${resultado.title}`);
		let audio;
		try {
			audio = await baixarAudioComoMedia(bot, resultado.mp3, resultado.title);
		} catch (downErr) {
			logger.error(`Erro ao baixar áudio "${resultado.title}":`, downErr.message || downErr);
			return new ReturnMessage({
				chatId,
				content: `❌ Não foi possível baixar o áudio "${resultado.title}". Tente escolher outro número.`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		return [
			new ReturnMessage({
				chatId,
				content: `▶️ _${resultado.title}_`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			}),
			new ReturnMessage({
				chatId,
				content: audio,
				options: {
					sendAudioAsVoice: true
				},
				delay: 500
			})
		];
	} catch (error) {
		logger.error("Erro ao executar comando audio:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Ocorreu um erro ao buscar o áudio. Por favor, tente novamente mais tarde."
		});
	}
}

// Criação dos comandos
const commands = [
	new Command({
		name: "audio",
		aliases: ["áudio", "som"],
		description: "Busca um áudio no site MyInstants (não é música)",
		usage: "!audio <nome_do_áudio> <número>",
		category: "busca",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊",
			error: "❌"
		},
		method: audioCommand
	}),
	new Command({
		name: "áudio",
		hidden: true,
		description: "Busca um áudio no site MyInstants",
		usage: "!audio <nome_do_áudio> <número>",
		category: "busca",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊",
			error: "❌"
		},
		method: audioCommand
	}),
	new Command({
		name: "som",
		hidden: true,
		description: "Busca um áudio no site MyInstants",
		usage: "!som <nome_do_áudio> <número>",
		category: "busca",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔊",
			error: "❌"
		},
		method: audioCommand
	})
];

// Exporta o módulo
const helper = {
	about: "Pesquisa e envio instantâneo de áudios e memes do MyInstants",
	implementation:
		"Faz web scraping e buscas no site MyInstants, baixa o arquivo de áudio MP3 e envia como mensagem de voz / áudio",
	tags: "myinstants,audios,memes,sons,efeitos sonoros,audio,som",
	cmds: [
		{
			cmd: "!audio",
			desc: "Pesquisa e envia um áudio do site MyInstants",
			usage: ["!audio vinheta globo", "!audio vinheta globo 1", "!audio acertou mizeravi 1"],
			category: "áudio"
		},
		{
			cmd: "!som",
			desc: "Pesquisa e envia um áudio do site MyInstants (alias para !audio)",
			usage: ["!som vinheta globo", "!som acertou mizeravi 1"],
			category: "áudio"
		}
	]
};

module.exports = {
	helper,
	commands,
	buscarAudios,
	baixarAudioComoMedia
};
