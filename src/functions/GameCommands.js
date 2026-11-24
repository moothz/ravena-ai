const axios = require("axios");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const { translateText } = require("./TranslationCommands");

const logger = new Logger("game-commands");

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? "";
const IGDB_OAUTH_URL = "https://id.twitch.tv/oauth2/token";
const IGDB_API_URL = "https://api.igdb.com/v4/games";

let igdbTokenCache = null; // { token: string, expiresAt: number }

/**
 * Obtém ou renova token de acesso OAuth para a API do IGDB via Twitch
 * @returns {Promise<string|null>}
 */
async function getIgdbAccessToken() {
	if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
		return null;
	}

	const now = Date.now();
	if (igdbTokenCache && igdbTokenCache.expiresAt > now + 60000) {
		return igdbTokenCache.token;
	}

	try {
		const res = await axios.post(IGDB_OAUTH_URL, null, {
			params: {
				client_id: TWITCH_CLIENT_ID,
				client_secret: TWITCH_CLIENT_SECRET,
				grant_type: "client_credentials"
			},
			timeout: 10000
		});

		if (res.data && res.data.access_token) {
			const expiresIn = Number(res.data.expires_in) || 3600;
			igdbTokenCache = {
				token: res.data.access_token,
				expiresAt: now + expiresIn * 1000
			};
			return igdbTokenCache.token;
		}
	} catch (err) {
		logger.error("Falha ao obter token OAuth do IGDB:", err.message);
	}

	return null;
}

/**
 * Consulta a API do IGDB por jogos eletrônicos
 * @param {string} query - Nome do jogo
 * @param {number} [limit=3] - Quantidade máxima de resultados
 * @returns {Promise<Array<object>>}
 */
async function searchIgdbGames(query, limit = 3) {
	if (!query || typeof query !== "string" || query.trim().length === 0) {
		return [];
	}

	const token = await getIgdbAccessToken();
	if (!token) {
		return [];
	}

	const cleanQuery = query.trim().replace(/"/g, '\\"');
	const apicalypseBody = `search "${cleanQuery}"; fields name,summary,storyline,total_rating,total_rating_count,first_release_date,genres.name,platforms.name,cover.image_id,cover.url,url,involved_companies.company.name,involved_companies.developer; limit ${limit};`;

	const res = await axios.post(IGDB_API_URL, apicalypseBody, {
		headers: {
			"Client-ID": TWITCH_CLIENT_ID,
			Authorization: `Bearer ${token}`,
			"Content-Type": "text/plain"
		},
		timeout: 10000
	});

	return Array.isArray(res.data) ? res.data : [];
}

/**
 * Monta o texto de apresentação de um jogo retornado do IGDB
 * @param {object} game
 * @returns {Promise<{ texto: string, coverUrl: string|null }>}
 */
async function formatGameCard(game) {
	const titulo = game.name || "Jogo sem título";
	const ano = game.first_release_date
		? new Date(game.first_release_date * 1000).getFullYear()
		: "N/A";

	const plataformas =
		(game.platforms || [])
			.map((p) => p.name)
			.filter(Boolean)
			.slice(0, 6)
			.join(", ") || "N/A";

	const generos =
		(game.genres || [])
			.map((g) => g.name)
			.filter(Boolean)
			.slice(0, 4)
			.join(", ") || "N/A";

	const devCompany = (game.involved_companies || []).find((c) => c.developer)?.company?.name;

	const nota =
		game.total_rating != null
			? `${Math.round(game.total_rating)}/100 (${(game.total_rating_count || 0).toLocaleString("pt-BR")} avaliações)`
			: "Sem avaliação agregada";

	const rawSummary = game.summary || game.storyline || "";
	let sinopse = "Sinopse não disponível.";
	if (rawSummary) {
		try {
			const traduzida = await translateText(rawSummary, "en", "pt");
			sinopse = traduzida || rawSummary;
		} catch {
			sinopse = rawSummary;
		}
	}

	let texto = `🎮 *${titulo}* (${ano})\n\n`;
	texto += `🕹️ *Plataformas:* ${plataformas}\n`;
	texto += `🎭 *Gêneros:* ${generos}\n`;
	if (devCompany) {
		texto += `🏢 *Desenvolvedora:* ${devCompany}\n`;
	}
	texto += `⭐ *Avaliação IGDB:* ${nota}\n\n`;
	texto += `💬 *Sinopse:* ${sinopse.trim()}\n`;

	if (game.url) {
		texto += `\n🔗 *IGDB:* ${game.url}`;
	}

	let coverUrl = null;
	if (game.cover?.image_id) {
		coverUrl = `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`;
	} else if (game.cover?.url) {
		const raw = game.cover.url.replace("t_thumb", "t_cover_big");
		coverUrl = raw.startsWith("//") ? `https:${raw}` : raw;
	}

	return { texto: texto.trim(), coverUrl };
}

/**
 * Comando !jogos / !game / !igdb
 * @param {WhatsAppBot} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function buscarJogos(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
		return new ReturnMessage({
			chatId,
			content:
				"⚠️ Integração com IGDB não configurada. Defina TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET no .env."
		});
	}

	if (!args || args.length === 0) {
		return new ReturnMessage({
			chatId,
			content: "Me passa o nome de um jogo pra buscar! Exemplo: `!jogos The Witcher 3`",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	const nome = args.join(" ").trim();

	try {
		const games = await module.exports.searchIgdbGames(nome, 3);
		if (!games || games.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `❌ Não encontrei nenhum jogo com o nome "${nome}". Dá uma conferida no nome e tenta de novo.`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const principal = games[0];
		const { texto, coverUrl } = await formatGameCard(principal);

		let textoFinal = texto;
		if (games.length > 1) {
			const outros = games
				.slice(1)
				.map((g) => g.name)
				.filter(Boolean);
			if (outros.length > 0) {
				textoFinal += `\n\n💡 *Outros resultados:* ${outros.join(", ")}`;
			}
		}

		if (coverUrl) {
			try {
				const imgRes = await axios.get(coverUrl, {
					responseType: "arraybuffer",
					timeout: 8000
				});
				const base64Data = Buffer.from(imgRes.data, "binary").toString("base64");
				const contentType = imgRes.headers["content-type"] || "image/jpeg";

				return new ReturnMessage({
					chatId,
					content: {
						mimetype: contentType,
						data: base64Data,
						filename: "game_cover.jpg",
						isMessageMedia: true
					},
					options: {
						caption: textoFinal,
						quotedMessageId: message.origin?.id?._serialized,
						goReply: message.origin
					}
				});
			} catch (imgErr) {
				logger.error("Erro ao baixar capa do jogo no IGDB:", imgErr.message);
			}
		}

		return new ReturnMessage({
			chatId,
			content: textoFinal,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (err) {
		logger.error(`Erro ao pesquisar jogo "${nome}" no IGDB:`, err.message);
		return new ReturnMessage({
			chatId,
			content: "Não consegui buscar informações do jogo agora. Tenta de novo daqui a pouco.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}
}

/**
 * Consulta textual formatada de jogo para uso em Tools do LLMService ou callers internos
 * @param {string} query
 * @returns {Promise<string>}
 */
async function fetchGameInfo(query) {
	if (!query || typeof query !== "string" || query.trim().length === 0) {
		return "Manda o nome do jogo pra pesquisar no IGDB.";
	}

	const nome = query.trim();

	if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
		return "Integração com IGDB não configurada (TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET ausentes no .env).";
	}

	try {
		const games = await module.exports.searchIgdbGames(nome, 2);
		if (!games || games.length === 0) {
			return `Não encontrei nenhum jogo com o nome "${nome}" no IGDB.`;
		}

		const formatadas = [];
		for (const g of games) {
			const ano = g.first_release_date
				? new Date(g.first_release_date * 1000).getFullYear()
				: "N/A";
			const plataformas =
				(g.platforms || [])
					.map((p) => p.name)
					.filter(Boolean)
					.slice(0, 5)
					.join(", ") || "N/A";
			const generos =
				(g.genres || [])
					.map((x) => x.name)
					.filter(Boolean)
					.slice(0, 4)
					.join(", ") || "N/A";
			const dev = (g.involved_companies || []).find((c) => c.developer)?.company?.name;
			const nota =
				g.total_rating != null
					? `${Math.round(g.total_rating)}/100 (${g.total_rating_count || 0} avaliações)`
					: "Sem avaliação agregada";

			const rawSummary = g.summary || g.storyline || "";
			let sinopse = "Sinopse não disponível.";
			if (rawSummary) {
				try {
					const traduzida = await translateText(rawSummary, "en", "pt");
					sinopse = traduzida || rawSummary;
				} catch {
					sinopse = rawSummary;
				}
			}

			let item = `🎮 **${g.name}** (${ano})\n`;
			item += `🕹️ Plataformas: ${plataformas}\n`;
			item += `🎭 Gêneros: ${generos}\n`;
			if (dev) {
				item += `🏢 Desenvolvedora: ${dev}\n`;
			}
			item += `⭐ Avaliação IGDB: ${nota}\n`;
			item += `\n📝 Sinopse: ${sinopse.trim()}`;
			if (g.url) {
				item += `\n🔗 Link: ${g.url}`;
			}
			formatadas.push(item);
		}

		return formatadas.join("\n\n---\n\n");
	} catch (err) {
		logger.error(`Erro ao consultar IGDB para "${query}":`, err.message);
		return `Erro ao consultar IGDB para "${query}": ${err.message}`;
	}
}

const commands = [
	new Command({
		name: "jogos",
		aliases: ["jogo", "game", "games", "igdb"],
		cooldown: 20,
		description: "Busca informações, plataformas, nota e sinopse de jogos no IGDB",
		category: "cultura",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🎮"
		},
		method: buscarJogos
	})
];

const helper = {
	about: "Busca de informações e avaliações de jogos eletrônicos no IGDB",
	implementation:
		"Consulta a API oficial do IGDB (Twitch) para exibir plataformas, desenvolvedores, gêneros, capa e notas",
	tags: "jogos,games,videogame,igdb,steam,playstation,xbox,nintendo,pc",
	cmds: [
		{
			cmd: "!jogos",
			desc: "Busca informações, nota, gêneros e sinopse de um jogo",
			usage: ["!jogos Elden Ring", "!jogos Chrono Trigger", "!jogos Hollow Knight"],
			category: "cultura"
		}
	]
};

module.exports = {
	helper,
	commands,
	buscarJogos,
	fetchGameInfo,
	searchIgdbGames,
	getIgdbAccessToken,
	formatGameCard
};
