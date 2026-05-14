const axios = require("axios");

const chrono = require("chrono-node");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("nasa-commands");

const NASA_API_KEY = process.env.NASA_API || "DEMO_KEY";
const APOD_API_URL = "https://api.nasa.gov/planetary/apod";
const EPIC_API_BASE_URL = "https://epic.gsfc.nasa.gov/api";
const EPIC_ARCHIVE_BASE_URL = "https://epic.gsfc.nasa.gov/archive";

/**
 * Formata data e hora para o padrão dd/mm/yyyy HH:MM
 * @param {string} dateStr - Data no formato YYYY-MM-DD ou YYYY-MM-DD HH:MM:SS
 * @returns {string} - Data formatada
 */
function formatDateTime(dateStr) {
	if (!dateStr) return "";

	const parts = dateStr.trim().split(/\s+/);
	const dateParts = parts[0].split("-");
	if (dateParts.length !== 3) return dateStr;

	const ddmmyyyy = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
	let hhmm = "00:00";

	if (parts.length > 1) {
		const timeParts = parts[1].split(":");
		if (timeParts.length >= 2) {
			hhmm = `${timeParts[0]}:${timeParts[1]}`;
		}
	}

	return `${ddmmyyyy} ${hhmm}`;
}

/**
 * Loga erro do Axios de forma simplificada
 * @param {string} context - Contexto do erro
 * @param {Error} error - Objeto de erro
 */
function logAxiosError(context, error) {
	if (error.response) {
		logger.error(
			`${context}: ${error.response.status} - ${JSON.stringify(error.response.data || "Sem dados")}`
		);
	} else if (error.request) {
		logger.error(`${context}: Sem resposta do servidor - ${error.message}`);
	} else {
		logger.error(`${context}: ${error.message}`);
	}
}

// Extrai a data do texto (fallback se chrono falhar)
function extractDate(text) {
	const regex = /(\d{1,2})\s+de\s+([\wÇç]+)\s+de\s+(\d{4})/i;
	const match = text?.match(regex);

	if (match) {
		const [, day, month, year] = match;
		const monthMap = {
			janeiro: "01",
			fevereiro: "02",
			março: "03",
			marco: "03",
			abril: "04",
			maio: "05",
			junho: "06",
			julho: "07",
			agosto: "08",
			setembro: "09",
			outubro: "10",
			novembro: "11",
			dezembro: "12"
		};
		const formattedMonth = monthMap[month.toLowerCase()];
		if (!formattedMonth) return false;
		const formattedDay = day.padStart(2, "0");
		return `${year}-${formattedMonth}-${formattedDay}`;
	}
	return false;
}

function parseDate(args) {
	if (!args || args.length === 0) return null;
	const dateExpression = args.join(" ");

	const parsedDate = chrono.pt.parse(dateExpression, new Date(), { forwardDate: false });
	if (parsedDate && parsedDate.length > 0) {
		const resultDate = parsedDate[0].start.date();
		const year = resultDate.getFullYear();
		const month = String(resultDate.getMonth() + 1).padStart(2, "0");
		const day = String(resultDate.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	}

	const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
	if (dateRegex.test(dateExpression)) {
		return dateExpression;
	}

	// Tenta DD/MM/YYYY
	const brDateRegex = /^(\d{2})\/(\d{2})\/(\d{4})$/;
	const brMatch = dateExpression.match(brDateRegex);
	if (brMatch) {
		return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;
	}

	return extractDate(dateExpression) || null;
}

async function fetchMedia(url) {
	const response = await axios.get(url, { responseType: "arraybuffer" });
	const buffer = Buffer.from(response.data, "binary");
	const base64 = buffer.toString("base64");
	const mimetype = response.headers["content-type"];
	return { mimetype, data: base64, filename: "nasa_image.jpg", isMessageMedia: true };
}

async function apodCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	try {
		const dateParam = parseDate(args);
		const params = { api_key: NASA_API_KEY, thumbs: true };
		if (dateParam) {
			params.date = dateParam;
		}

		const response = await axios.get(APOD_API_URL, { params });
		const data = response.data;

		let imageUrl = data.url;
		const isVideo = data.media_type === "video";
		if (isVideo && data.thumbnail_url) {
			imageUrl = data.thumbnail_url;
		} else if (data.hdurl) {
			imageUrl = data.hdurl;
		}

		const media = await fetchMedia(imageUrl);

		let caption = `🚀 *Astronomy Picture of the Day*\n`;
		caption += `📅 *Data:* ${formatDateTime(data.date)}\n`;
		caption += `✨ *Título:* ${data.title}\n\n`;

		// Truncate explanation if too long
		let explanation = data.explanation;
		if (explanation && explanation.length > 800) {
			explanation = explanation.substring(0, 797) + "...";
		}
		if (explanation) caption += `${explanation}\n`;

		if (isVideo) {
			caption += `\n🎥 *Vídeo original:* ${data.url}\n`;
			caption += `_💡 Reaja com ⏬ para baixar se for do YouTube_`;
		} else if (data.hdurl) {
			caption += `\n🔗 *Alta Resolução:* ${data.hdurl}\n`;
		} else {
			caption += `\n🔗 *Link:* ${data.url}\n`;
		}

		return new ReturnMessage({
			chatId,
			content: media,
			options: {
				caption,
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logAxiosError("Erro no comando APOD", error);
		let errorMsg = "❌ Não foi possível buscar o APOD. Verifique a data e tente novamente.";
		if (error.response && error.response.data && error.response.data.msg) {
			errorMsg = `❌ Erro da NASA: ${error.response.data.msg}`;
		}
		return new ReturnMessage({
			chatId,
			content: errorMsg,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

async function epicCommandHandler(variant, bot, message, args, group) {
	const chatId = message.group ?? message.author;
	try {
		const dateParam = parseDate(args);

		let apiUrl = `${EPIC_API_BASE_URL}/${variant}`;
		if (dateParam) {
			apiUrl += `/date/${dateParam}`;
		}

		// A API EPIC às vezes funciona sem key, mas adicionar por precaução se a API key estiver setada no .env (para chamadas na api.nasa.gov)
		const params = {};
		if (NASA_API_KEY && NASA_API_KEY !== "DEMO_KEY") {
			params.api_key = NASA_API_KEY;
		}

		const response = await axios.get(apiUrl, { params });
		const data = response.data;

		if (!data || data.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `❌ Nenhuma imagem EPIC encontrada para esta data.`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		// Seleciona uma imagem aleatória do dia
		const randomIndex = Math.floor(Math.random() * data.length);
		const imageObj = data[randomIndex];

		// Data no formato YYYY/MM/DD para a URL do arquivo
		const dateStr = imageObj.date.split(" ")[0]; // "YYYY-MM-DD"
		const [year, month, day] = dateStr.split("-");

		let apiKeyQuery = "";
		if (NASA_API_KEY && NASA_API_KEY !== "DEMO_KEY") {
			apiKeyQuery = `?api_key=${NASA_API_KEY}`;
		}

		// Se usar o endpoint da api.nasa.gov para EPIC archive precisa api_key, mas os docs oficiais do epic.gsfc.nasa.gov não precisam
		// Mas a URL de archive é https://epic.gsfc.nasa.gov/archive/natural/...
		const imageUrl = `${EPIC_ARCHIVE_BASE_URL}/${variant}/${year}/${month}/${day}/jpg/${imageObj.image}.jpg${apiKeyQuery}`;

		const media = await fetchMedia(imageUrl);

		let caption = `🌍 *EPIC Camera (${variant.charAt(0).toUpperCase() + variant.slice(1)})*\n`;
		caption += `📅 *Data:* ${formatDateTime(imageObj.date)}\n`;
		caption += `📷 *Imagem:* ${imageObj.image}\n`;
		if (imageObj.centroid_coordinates) {
			caption += `📍 *Coordenadas:* Lat ${imageObj.centroid_coordinates.lat}, Lon ${imageObj.centroid_coordinates.lon}\n`;
		}
		caption += `✨ *Distância:* ~${Math.round(imageObj.dsCoov?.distance_to_earth || 1500000)} km\n`;

		// URL para a maior resolução possível (PNG)
		const highResUrl = `${EPIC_ARCHIVE_BASE_URL}/${variant}/${year}/${month}/${day}/png/${imageObj.image}.png${apiKeyQuery}`;
		caption += `🔗 *Alta Resolução (PNG):* ${highResUrl}`;

		return new ReturnMessage({
			chatId,
			content: media,
			options: {
				caption,
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logAxiosError(`Erro no comando EPIC (${variant})`, error);
		return new ReturnMessage({
			chatId,
			content: `❌ Não foi possível buscar a imagem EPIC. Tente novamente.`,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

const commands = [
	new Command({
		name: "apod",
		description: "Foto astronômica do dia (NASA)",
		category: "busca",
		reactions: { before: "🌌", after: "✨", error: "❌" },
		method: apodCommand
	}),
	new Command({
		name: "epic",
		description: "Imagem da Terra pela câmera EPIC (Natural)",
		category: "busca",
		reactions: { before: "🌍", after: "✨", error: "❌" },
		method: async (bot, message, args, group) =>
			await epicCommandHandler("natural", bot, message, args, group)
	}),
	new Command({
		name: "epic-enhanced",
		description: "Imagem da Terra pela câmera EPIC (Color Enhanced)",
		category: "busca",
		reactions: { before: "🌍", after: "✨", error: "❌" },
		method: async (bot, message, args, group) =>
			await epicCommandHandler("enhanced", bot, message, args, group)
	}),
	new Command({
		name: "epic-aerosol",
		description: "Imagem da Terra pela câmera EPIC (Aerosol Index)",
		category: "busca",
		reactions: { before: "🌍", after: "✨", error: "❌" },
		method: async (bot, message, args, group) =>
			await epicCommandHandler("aerosol", bot, message, args, group)
	}),
	new Command({
		name: "epic-cloud",
		description: "Imagem da Terra pela câmera EPIC (Cloud Fraction)",
		category: "busca",
		reactions: { before: "🌍", after: "✨", error: "❌" },
		method: async (bot, message, args, group) =>
			await epicCommandHandler("cloud", bot, message, args, group)
	})
];

module.exports = { commands };
