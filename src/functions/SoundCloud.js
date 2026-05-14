/* WIP! Não funciona ainda pra baixar */
const SoundCloud = require("soundcloud.ts");
const ReturnMessage = require("../models/ReturnMessage");
const SoundCacheManager = require("../utils/SoundCacheManager");
const Command = require("../models/Command");
const Database = require("../utils/Database");

const TEMP_FOLDER = process.env.DL_FOLDER ?? "./temp";
const soundcloud = new SoundCloud.default(
	process.env.SOUNDCLOUD_CLIENT_ID,
	process.env.SOUNDCLOUD_OAUTH_TOKEN
);

const database = Database.getInstance();
const cacheManager = new SoundCacheManager(soundcloud, database.databasePath);

async function soundCloudSearchAndDownload(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const query = args.join(" ");
	if (!query) {
		return new ReturnMessage({
			chatId,
			content: "Você precisa me dizer o que buscar! Use: `!sc <nome da música)>`",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	let searchQuery = query.trim();
	let trackIndex = 1; // Default to the first track

	const parts = searchQuery.split(" ");
	const lastPart = parts[parts.length - 1];
	const potentialIndex = parseInt(lastPart, 10);

	if (!isNaN(potentialIndex) && potentialIndex > 0) {
		trackIndex = potentialIndex;
		searchQuery = parts.slice(0, -1).join(" ");
	}

	try {
		const searchResults = await soundcloud.tracks.search({ q: searchQuery });

		if (!searchResults || searchResults.collection.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `Não encontrei nenhum resultado para "${searchQuery}" no SoundCloud.`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		const tracks = searchResults.collection;
		const selectedTrackIndex = trackIndex > 0 && trackIndex <= tracks.length ? trackIndex - 1 : 0;
		const selectedTrack = tracks[selectedTrackIndex];

		console.log("baixad");
		const downloadResult = await cacheManager.downloadTrackWithCache(selectedTrack, {
			path: TEMP_FOLDER
		});

		console.log("downloadResult", downloadResult);

		if (!downloadResult || !downloadResult.lastDownloadLocation) {
			return new ReturnMessage({
				chatId,
				content: "Desculpe, não consegui baixar o áudio.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		const audioPath = downloadResult.lastDownloadLocation;
		const media = await bot.createMedia(audioPath, "video/mp4");

		let responseText = `*SoundCloud* ☁️\n\nResultado da busca para '${searchQuery}':\n`;
		tracks.slice(0, 5).forEach((track, index) => {
			responseText += `${index + 1}. ${track.title}${index === selectedTrackIndex ? " ⏬" : ""}\n`;
		});

		if (selectedTrack.description) {
			responseText += `\n 📝 *Descrição*\n${selectedTrack.description}`;
		}

		responseText += `\n\n *Link*: ${selectedTrack.permalink_url}`;

		const detalhesMsg = new ReturnMessage({
			chatId,
			content: responseText,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});

		const audioMsg = new ReturnMessage({
			chatId,
			content: media,
			options: {
				caption: selectedTrack.title,
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});

		return [detalhesMsg, audioMsg];
	} catch (error) {
		console.error("[soundCloudSearchAndDownload] Error:", error);
		return new ReturnMessage(
			"Ocorreu um erro ao buscar no SoundCloud. Tente novamente mais tarde."
		);
	}
}

const commands = [
	new Command({
		name: "sc",
		caseSensitive: false,
		description: "Busca e baixa músicas do SoundCloud.",
		category: "downloaders",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🔉",
			error: "❌"
		},
		cooldown: 1,
		method: soundCloudSearchAndDownload
	})
];

//module.exports = { commands  };
