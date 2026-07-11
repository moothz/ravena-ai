const axios = require("axios");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const Database = require("../utils/Database");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("roblox-commands");
const database = Database.getInstance();
const DB_NAME = "roblox";

// Initialize Database Table
database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS roblox_cache (
    username TEXT PRIMARY KEY,
    json_data TEXT,
    timestamp INTEGER
  );
`
);

/**
 * Formata os dados de perfil do Roblox em uma mensagem
 * @param {Object} data - Dados do usuário Roblox
 * @returns {string} - Mensagem formatada
 */
function formatRobloxProfileMessage(data) {
	let messageText = `🧱 *Perfil do Roblox - ${data.displayNick}*\n`;
	messageText += `👤 Nome de usuário: @${data.officialName}\n`;
	messageText += `🆔 ID: ${data.userId}\n`;
	if (data.createdDateStr) {
		messageText += `📅 Criado em: ${data.createdDateStr}\n`;
	}
	messageText += `🟢 Status: ${data.statusStr}\n`;
	if (data.lastLocation && data.lastLocation !== "Website") {
		messageText += `📍 Localização: ${data.lastLocation}\n`;
	}
	if (data.isBanned) {
		messageText += `⚠️ *Conta Banida*\n`;
	}
	if (data.description) {
		const shortDesc =
			data.description.length > 150 ? data.description.substring(0, 147) + "..." : data.description;
		messageText += `\n📝 *Sobre:*\n_"${shortDesc.trim()}"_\n`;
	}
	if (data.gamesStr) {
		messageText += `\n🎮 *Jogos Criados:*\n${data.gamesStr}\n`;
	}
	return messageText;
}

/**
 * Fetch Roblox player data (utilizando cache do SQLite com fallback)
 * @param {string} username - Roblox username
 * @returns {Promise<Object>} - User profile data object
 */
async function getRobloxPlayerData(username) {
	const lowerUsername = username.toLowerCase().trim();
	const now = Date.now();

	// 1. Verificar cache no banco de dados
	let cachedRow = null;
	try {
		cachedRow = await database.dbGet(
			DB_NAME,
			"SELECT json_data, timestamp FROM roblox_cache WHERE username = ?",
			[lowerUsername]
		);
	} catch (err) {
		logger.warn(`Erro ao consultar o cache do banco de dados para ${username}: ${err.message}`);
	}

	if (cachedRow) {
		const age = now - cachedRow.timestamp;
		if (age < 5 * 60 * 1000) {
			// Cache de 5 minutos
			logger.debug(`Cache hit para ${username} (idade: ${Math.round(age / 1000)}s)`);
			try {
				return JSON.parse(cachedRow.json_data);
			} catch (parseErr) {
				logger.error(`Erro ao parsear dados do cache para ${username}:`, parseErr);
			}
		}
	}

	// 2. Buscar dados frescos da API do Roblox
	try {
		logger.debug(`Buscando ID do usuário Roblox para o nome: ${username}`);
		const userSearchResponse = await axios.post(
			"https://users.roblox.com/v1/usernames/users",
			{
				usernames: [username],
				excludeBannedUsers: false
			},
			{ timeout: 5000 }
		);

		const searchData = userSearchResponse.data?.data;
		if (!searchData || searchData.length === 0) {
			throw new Error(`Usuário "${username}" não encontrado no Roblox.`);
		}

		const user = searchData[0];
		const userId = user.id;
		const displayNick = user.displayName;
		const officialName = user.name;

		// Buscar informações do perfil do usuário
		let description = "";
		let createdDateStr = "";
		let isBanned = false;

		try {
			const profileResponse = await axios.get(`https://users.roblox.com/v1/users/${userId}`, {
				timeout: 5000
			});
			description = profileResponse.data.description || "";
			isBanned = !!profileResponse.data.isBanned;
			if (profileResponse.data.created) {
				createdDateStr = new Date(profileResponse.data.created).toLocaleDateString("pt-BR");
			}
		} catch (err) {
			logger.warn(`Erro ao buscar detalhes de perfil para o ID ${userId}: ${err.message}`);
		}

		// Buscar presença (status online)
		let statusStr = "Desconhecido";
		let lastLocation = "";
		try {
			const presenceResponse = await axios.post(
				"https://presence.roblox.com/v1/presence/users",
				{ userIds: [userId] },
				{ timeout: 5000 }
			);
			const presence = presenceResponse.data?.userPresences?.[0];
			if (presence) {
				const types = {
					0: "Offline 🔴",
					1: "Online 🟢",
					2: "Em jogo 🎮",
					3: "No Roblox Studio 🛠️"
				};
				statusStr = types[presence.userPresenceType] || "Desconhecido";
				if (presence.lastLocation) {
					lastLocation = presence.lastLocation;
				}
			}
		} catch (err) {
			logger.warn(`Erro ao buscar presença para o ID ${userId}: ${err.message}`);
		}

		// Buscar jogos criados
		let gamesStr = "";
		try {
			const gamesResponse = await axios.get(
				`https://games.roblox.com/v2/users/${userId}/games?sortOrder=Desc&limit=10`,
				{ timeout: 5000 }
			);
			const games = gamesResponse.data?.data || [];
			if (games.length > 0) {
				gamesStr = games
					.slice(0, 3)
					.map(
						(g) =>
							`- *${g.name}* (${g.placeVisits ? g.placeVisits.toLocaleString("pt-BR") : 0} visitas)`
					)
					.join("\n");
			} else {
				gamesStr = "Nenhum jogo público criado.";
			}
		} catch (err) {
			logger.warn(`Erro ao buscar jogos para o ID ${userId}: ${err.message}`);
			gamesStr = "Não foi possível carregar os jogos.";
		}

		// Buscar link da imagem do Avatar
		let avatarImageUrl = "";
		try {
			const avatarUrl = `https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=720x720&format=Png&isCircular=false`;
			const thumbnailResponse = await axios.get(avatarUrl, { timeout: 5000 });
			avatarImageUrl = thumbnailResponse.data?.data?.[0]?.imageUrl || "";
		} catch (err) {
			logger.warn(`Erro ao buscar avatar de skin para o ID ${userId}: ${err.message}`);
		}

		const freshData = {
			userId,
			displayNick,
			officialName,
			createdDateStr,
			statusStr,
			lastLocation,
			isBanned,
			description,
			gamesStr,
			avatarImageUrl
		};

		// Gravar no cache (SQLite)
		try {
			await database.dbRun(
				DB_NAME,
				"REPLACE INTO roblox_cache (username, json_data, timestamp) VALUES (?, ?, ?)",
				[lowerUsername, JSON.stringify(freshData), now]
			);
		} catch (dbErr) {
			logger.error(`Erro ao salvar cache de Roblox para ${username}:`, dbErr.message);
		}

		return freshData;
	} catch (apiError) {
		logger.warn(`Falha ao acessar as APIs da Roblox para ${username}: ${apiError.message}`);

		// Fallback: tentar retornar o cache antigo/expirado
		if (cachedRow) {
			logger.info(`Usando cache expirado de fallback para o usuário: ${username}`);
			try {
				return JSON.parse(cachedRow.json_data);
			} catch (parseErr) {
				logger.error(`Erro ao parsear dados expirados de fallback para ${username}:`, parseErr);
			}
		}

		// Tratamento de erros amigáveis de rede/timeout
		let friendlyMessage = apiError.message;
		if (apiError.message.includes("EPIPE") || apiError.message.includes("ECONNRESET")) {
			friendlyMessage = "Conexão instável com a Roblox. Tente novamente em breve.";
		} else if (apiError.message.includes("timeout")) {
			friendlyMessage = "Servidor Roblox demorou muito para responder (Tempo limite excedido).";
		}
		throw new Error(friendlyMessage);
	}
}

/**
 * Handles the Roblox command
 * @param {WhatsAppBot} bot - Bot instance
 * @param {Object} message - Message data
 * @param {Array} args - Command arguments
 * @param {Object} group - Group data
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage or array of ReturnMessages
 */
async function handleRobloxCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça o nome de usuário do Roblox. Exemplo: !roblox builderman"
			});
		}

		const username = args.join(" ").trim();
		const data = await getRobloxPlayerData(username);
		const messageText = formatRobloxProfileMessage(data);

		// Download fresh avatar image (stickers não são cacheados em banco, baixados sob demanda)
		let media = null;
		if (data.avatarImageUrl) {
			try {
				logger.debug(`Baixando skin de avatar do Roblox: ${data.avatarImageUrl}`);
				const imageBuffer = await axios.get(data.avatarImageUrl, {
					responseType: "arraybuffer",
					timeout: 8000
				});
				const contentType = imageBuffer.headers["content-type"] ?? "image/png";
				media = {
					mimetype: contentType,
					data: Buffer.from(imageBuffer.data).toString("base64"),
					filename: "avatar.png",
					isMessageMedia: true
				};
			} catch (imageErr) {
				logger.warn(`Erro ao baixar imagem de avatar para ${username}: ${imageErr.message}`);
			}
		}

		if (media) {
			// Envia o sticker primeiro e o texto em seguida
			return [
				new ReturnMessage({
					chatId,
					content: media,
					options: {
						sendMediaAsSticker: true,
						stickerName: `Avatar de ${data.officialName}`,
						stickerAuthor: "Ravena Bot"
					}
				}),
				new ReturnMessage({
					chatId,
					content: messageText
				})
			];
		} else {
			// Se o download do avatar falhar, envia apenas o texto com as informações
			return new ReturnMessage({
				chatId,
				content: messageText
			});
		}
	} catch (error) {
		return new ReturnMessage({
			chatId,
			content: `❌ Erro: ${error.message}`
		});
	}
}

const commands = [
	new Command({
		name: "roblox",
		description: "Busca perfil de jogador do Roblox",
		category: "jogos",
		group: "roblox",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🧱",
			error: "❌"
		},
		method: handleRobloxCommand
	}),

	new Command({
		name: "rbx",
		description: "Busca perfil de jogador do Roblox (Alias)",
		category: "jogos",
		group: "roblox",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🧱",
			error: "❌"
		},
		method: handleRobloxCommand
	})
];

module.exports = { commands };
