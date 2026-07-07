const axios = require("axios");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("roblox-commands");

/**
 * Fetch Roblox player data and return formatted message and avatar media
 * @param {string} username - Roblox username
 * @returns {Promise<{ messageText: string, media: Object|null }>}
 */
async function getRobloxPlayerData(username) {
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

		// Fetch detailed profile info
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

		// Fetch presence (online status)
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

		// Fetch games created
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

		// Build the caption/message
		let messageText = `🧱 *Perfil do Roblox - ${displayNick}*\n`;
		messageText += `👤 Nome de usuário: @${officialName}\n`;
		messageText += `🆔 ID: ${userId}\n`;
		if (createdDateStr) {
			messageText += `📅 Criado em: ${createdDateStr}\n`;
		}
		messageText += `🟢 Status: ${statusStr}\n`;
		if (lastLocation && lastLocation !== "Website") {
			messageText += `📍 Localização: ${lastLocation}\n`;
		}
		if (isBanned) {
			messageText += `⚠️ *Conta Banida*\n`;
		}
		if (description) {
			const shortDesc =
				description.length > 150 ? description.substring(0, 147) + "..." : description;
			messageText += `\n📝 *Sobre:*\n_"${shortDesc.trim()}"_\n`;
		}
		if (gamesStr) {
			messageText += `\n🎮 *Jogos Criados:*\n${gamesStr}\n`;
		}

		// Fetch Avatar/Skin Image
		let media = null;
		try {
			const avatarUrl = `https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=720x720&format=Png&isCircular=false`;
			const thumbnailResponse = await axios.get(avatarUrl, { timeout: 5000 });
			const imageUrl = thumbnailResponse.data?.data?.[0]?.imageUrl;
			if (imageUrl) {
				logger.debug(`Baixando skin de avatar do Roblox: ${imageUrl}`);
				const imageBuffer = await axios.get(imageUrl, {
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
			}
		} catch (err) {
			logger.warn(`Erro ao buscar avatar de skin para o ID ${userId}: ${err.message}`);
		}

		return { messageText, media };
	} catch (error) {
		logger.error(`Erro ao buscar dados do Roblox para ${username}:`, error.message);
		throw new Error(error.message || "Erro desconhecido ao acessar a API do Roblox.");
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
		const { messageText, media } = await getRobloxPlayerData(username);

		if (media) {
			return [
				new ReturnMessage({
					chatId,
					content: media,
					options: {
						sendMediaAsSticker: true,
						stickerName: `Avatar de ${username}`,
						stickerAuthor: "Ravena Bot"
					}
				}),
				new ReturnMessage({
					chatId,
					content: messageText
				})
			];
		} else {
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
