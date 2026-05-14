const LastFmNode = require("lastfm").LastFmNode;
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

// Cria novo logger
const logger = new Logger("lastfm-commands");

// Inicializa cliente Last.fm
const lastfm = new LastFmNode({
	api_key: process.env.LASTFM_APIKEY,
	secret: process.env.LASTFM_SECRET,
	useragent: "ravenabot/v1.0"
});

/**
 * Formata timestamp Unix para formato legível
 * @param {number} ts - Timestamp Unix
 * @returns {string} - Data formatada
 */
function formatarTS(ts) {
	if (ts) {
		const d = new Date(ts * 1000);

		const dia = d.getDate() < 10 ? `0${d.getDate()}` : d.getDate();
		const mes = d.getMonth() < 9 ? `0${d.getMonth() + 1}` : d.getMonth() + 1;
		const ano = d.getFullYear();
		const hora = d.getHours() < 10 ? `0${d.getHours()}` : d.getHours();
		const minuto = d.getMinutes() < 10 ? `0${d.getMinutes()}` : d.getMinutes();

		const data = `${dia}/${mes}/${ano}`;
		const horario = `${hora}:${minuto}`;

		return `${data} às ${horario}`;
	} else {
		return "??/??/???? às ??:??";
	}
}

/**
 * Obtém informações de um usuário Last.fm
 * @param {string} usuario - Nome de usuário Last.fm
 * @returns {Promise<Object|boolean>} - Dados do usuário ou false
 */
function getUserInfo(usuario) {
	return new Promise((resolve) => {
		logger.info(`[last.fm][getUserInfo] -> ${usuario}`);
		lastfm.request("user.getInfo", {
			user: usuario,
			handlers: {
				success: (data) => resolve(data.user),
				error: () => resolve(false)
			}
		});
	});
}

/**
 * Obtém músicas recentes de um usuário Last.fm
 * @param {string} usuario - Nome de usuário Last.fm
 * @returns {Promise<Object|boolean>} - Dados da música recente ou false
 */
function getUserRecentTracks(usuario) {
	return new Promise((resolve) => {
		logger.info(`[last.fm][getUserRecentTracks] -> ${usuario}`);
		lastfm.request("user.getRecentTracks", {
			user: usuario,
			limit: 1,
			handlers: {
				success: (data) => resolve(data.recenttracks.track[0]),
				error: () => resolve(false)
			}
		});
	});
}

/**
 * Obtém as principais músicas de um usuário Last.fm
 * @param {string} usuario - Nome de usuário Last.fm
 * @param {string} periodo - Período de tempo
 * @returns {Promise<Array|boolean>} - Lista de músicas ou false
 */
function getUserTracks(usuario, periodo) {
	return new Promise((resolve) => {
		logger.info(`[last.fm][getUserTracks] -> ${usuario} (${periodo})`);
		lastfm.request("user.getTopTracks", {
			user: usuario,
			period: periodo,
			limit: 3,
			handlers: {
				success: (data) => resolve(data.toptracks.track),
				error: () => resolve(false)
			}
		});
	});
}

/**
 * Obtém os principais artistas de um usuário Last.fm
 * @param {string} usuario - Nome de usuário Last.fm
 * @param {string} periodo - Período de tempo
 * @returns {Promise<Array|boolean>} - Lista de artistas ou false
 */
function getUserArtists(usuario, periodo) {
	return new Promise((resolve) => {
		logger.info(`[last.fm][getUserArtists] -> ${usuario} (${periodo})`);
		lastfm.request("user.getTopArtists", {
			user: usuario,
			period: periodo,
			limit: 3,
			handlers: {
				success: (data) => resolve(data.topartists.artist),
				error: () => resolve(false)
			}
		});
	});
}

/**
 * Processa solicitação de dados do Last.fm
 * @param {string} usuario - Nome de usuário Last.fm
 * @returns {Promise<ReturnMessage>} - Mensagem de retorno
 */
async function processLastFM(usuario) {
	try {
		logger.info(`[processLastFM] Usuario: ${usuario}`);

		// Busca todos os dados necessários
		const user = await getUserInfo(usuario);
		const tracks = await getUserTracks(usuario, "overall");
		const artists = await getUserArtists(usuario, "overall");
		const recent = await getUserRecentTracks(usuario);

		// Verifica se todas as requisições foram bem-sucedidas
		if (user && tracks && artists && recent) {
			// Verifica se o usuário está ouvindo algo neste momento
			const nowPlaying = recent["@attr"]?.nowplaying === "true";

			const quando = nowPlaying ? "Ouvindo _agora_" : "Ouvido por último";
			const dataQuando = nowPlaying ? "" : ` _(em ${formatarTS(parseInt(recent.date.uts))})_`;

			// Informações adicionais
			const idade = parseInt(user.age) > 0 ? `, ${user.age}` : "";
			const subscriber = parseInt(user.subscriber) ? "👑 " : "";
			const dataRegistro = formatarTS(parseInt(user.registered.unixtime));

			// Formata a mensagem de retorno
			const retorno = `📻 _last.fm_ ${subscriber}*${user.name}* _(${user.country}${idade})_
🍼 Usuário desde *${dataRegistro}*
🎶 *${user.playcount}* scrobbles
🎙 *${user.track_count}* músicas e *${user.album_count}* albuns de *${user.artist_count}* artistas diferentes

🎧 *${quando}*: ${recent.artist["#text"]} - _${recent.name}_${dataQuando}

📊 *Top Artistas*
  🥇 ${artists[0]?.name ?? "-"}
  🥈 ${artists[1]?.name ?? "-"}
  🥉 ${artists[2]?.name ?? "-"}

📊 *Top Músicas*
  🥇 ${tracks[0]?.artist?.name ?? "-"} - _${tracks[0]?.name ?? "-"}_
  🥈 ${tracks[1]?.artist?.name ?? "-"} - _${tracks[1]?.name ?? "-"}_
  🥉 ${tracks[2]?.artist?.name ?? "-"} - _${tracks[2]?.name ?? "-"}_

🔗 ${user.url}`;

			return new ReturnMessage({
				chatId: null, // Será definido pelo CommandHandler
				content: retorno,
				reactions: {
					after: "📻"
				},
				options: {
					quotedMessageId: null // Será definido pelo CommandHandler se necessário
				}
			});
		} else {
			// Alguma requisição falhou
			return new ReturnMessage({
				chatId: null, // Será definido pelo CommandHandler
				content: `*lastm.fm*: Ocorreu um erro buscando os dados do perfil '${usuario}'. Verifique o nome e tente novamente.`,
				reactions: {
					after: "❌"
				},
				options: {
					quotedMessageId: null // Será definido pelo CommandHandler se necessário
				}
			});
		}
	} catch (error) {
		logger.error(`Erro ao processar dados do Last.fm para ${usuario}:`, error);

		return new ReturnMessage({
			chatId: null, // Será definido pelo CommandHandler
			content: `*lastm.fm*: Ocorreu um erro inesperado ao buscar os dados do perfil '${usuario}'.`,
			reactions: {
				after: "❌"
			},
			options: {
				quotedMessageId: null // Será definido pelo CommandHandler se necessário
			}
		});
	}
}

/**
 * Implementação do comando lastfm
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} ReturnMessage
 */
async function lastfmCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		// Verifica se foi fornecido um nome de usuário
		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "❌ Por favor, forneça um nome de usuário do Last.fm. Exemplo: `!lastfm username`",
				reactions: {
					after: "❓"
				}
			});
		}

		const username = args[0];

		// Envia mensagem de processamento
		const processingMsg = new ReturnMessage({
			chatId,
			content: `🔍 Buscando dados do perfil '${username}' no Last.fm...`,
			reactions: {
				before: process.env.LOADING_EMOJI ?? "⌛️"
			}
		});

		// Obtém resultados do Last.fm
		const result = await processLastFM(username);

		// Define o chatId e opções de citação
		result.chatId = chatId;
		result.options.quotedMessageId = message.origin.id._serialized;

		return result;
	} catch (error) {
		logger.error("Erro ao executar comando lastfm:", error);

		return new ReturnMessage({
			chatId,
			content: "❌ Ocorreu um erro ao executar o comando. Por favor, tente novamente mais tarde.",
			reactions: {
				after: "❌"
			}
		});
	}
}

// Criação dos comandos
const commands = [
	new Command({
		name: "lastfm",
		description: "Exibe informações de um perfil do Last.fm",
		usage: "!lastfm username",
		category: "busca",
		group: "lastfm",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📻",
			error: "❌"
		},
		method: lastfmCommand
	}),

	// Alias 'lfm' para facilitar o uso
	new Command({
		name: "lfm",
		description: "Alias para o comando lastfm",
		usage: "!lfm username",
		category: "busca",
		group: "lastfm",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📻",
			error: "❌"
		},
		method: lastfmCommand
	})
];

// Exporta o módulo
module.exports = { commands };
