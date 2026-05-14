const axios = require("axios");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const CmdUsage = require("../utils/CmdUsage");

// Cria novo logger
const logger = new Logger("weather-meteo-commands");
const cmdUsage = CmdUsage.getInstance();

// APIs do Open-Meteo (não precisam de chave para uso gratuito)
const GEO_API_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_API_URL = "https://api.open-meteo.com/v1/forecast";

// Mapeamento de estados brasileiros
const BRAZILIAN_STATES = {
	AC: "Acre",
	AL: "Alagoas",
	AP: "Amapá",
	AM: "Amazonas",
	BA: "Bahia",
	CE: "Ceará",
	DF: "Distrito Federal",
	ES: "Espírito Santo",
	GO: "Goiás",
	MA: "Maranhão",
	MT: "Mato Grosso",
	MS: "Mato Grosso do Sul",
	MG: "Minas Gerais",
	PA: "Pará",
	PB: "Paraíba",
	PR: "Paraná",
	PE: "Pernambuco",
	PI: "Piauí",
	RJ: "Rio de Janeiro",
	RN: "Rio Grande do Norte",
	RS: "Rio Grande do Sul",
	RO: "Rondônia",
	RR: "Roraima",
	SC: "Santa Catarina",
	SP: "São Paulo",
	SE: "Sergipe",
	TO: "Tocantins"
};

const BRAZILIAN_STATES_FULL = {
	ACRE: "Acre",
	ALAGOAS: "Alagoas",
	AMAPA: "Amapá",
	AMAZONAS: "Amazonas",
	BAHIA: "Bahia",
	CEARA: "Ceará",
	"DISTRITO FEDERAL": "Distrito Federal",
	"ESPIRITO SANTO": "Espírito Santo",
	GOIAS: "Goiás",
	MARANHAO: "Maranhão",
	"MATO GROSSO": "Mato Grosso",
	"MATO GROSSO DO SUL": "Mato Grosso do Sul",
	"MINAS GERAIS": "Minas Gerais",
	PARA: "Pará",
	PARAIBA: "Paraíba",
	PARANA: "Paraná",
	PERNAMBUCO: "Pernambuco",
	PIAUI: "Piauí",
	"RIO DE JANEIRO": "Rio de Janeiro",
	"RIO GRANDE DO NORTE": "Rio Grande do Norte",
	"RIO GRANDE DO SUL": "Rio Grande do Sul",
	RONDONIA: "Rondônia",
	RORAIMA: "Roraima",
	"SANTA CATARINA": "Santa Catarina",
	"SAO PAULO": "São Paulo",
	SERGIPE: "Sergipe",
	TOCANTINS: "Tocantins"
};

// Mapeamento de códigos WMO para PT-BR e Emojis
const WMO_MAPPING = {
	0: { desc: "Céu limpo", emoji: "☀️" },
	1: { desc: "Predominantemente limpo", emoji: "🌤️" },
	2: { desc: "Parcialmente nublado", emoji: "⛅" },
	3: { desc: "Nublado", emoji: "☁️" },
	45: { desc: "Nevoeiro", emoji: "🌫️" },
	48: { desc: "Nevoeiro com rima", emoji: "🌫️" },
	51: { desc: "Garoa leve", emoji: "🌦️" },
	53: { desc: "Garoa moderada", emoji: "🌦️" },
	55: { desc: "Garoa densa", emoji: "🌦️" },
	56: { desc: "Garoa congelante leve", emoji: "❄️🌦️" },
	57: { desc: "Garoa congelante densa", emoji: "❄️🌦️" },
	61: { desc: "Chuva fraca", emoji: "🌧️" },
	63: { desc: "Chuva moderada", emoji: "🌧️" },
	65: { desc: "Chuva forte", emoji: "🌧️" },
	66: { desc: "Chuva congelante leve", emoji: "❄️🌧️" },
	67: { desc: "Chuva congelante forte", emoji: "❄️🌧️" },
	71: { desc: "Neve fraca", emoji: "❄️" },
	73: { desc: "Neve moderada", emoji: "❄️" },
	75: { desc: "Neve forte", emoji: "❄️" },
	77: { desc: "Grãos de neve", emoji: "❄️" },
	80: { desc: "Pancadas de chuva leve", emoji: "🌦️" },
	81: { desc: "Pancadas de chuva moderada", emoji: "🌦️" },
	82: { desc: "Pancadas de chuva violenta", emoji: "🌦️" },
	85: { desc: "Pancadas de neve leve", emoji: "❄️" },
	86: { desc: "Pancadas de neve forte", emoji: "❄️" },
	95: { desc: "Trovoada", emoji: "⛈️" },
	96: { desc: "Trovoada com granizo leve", emoji: "⛈️🌨️" },
	99: { desc: "Trovoada com granizo forte", emoji: "⛈️🌨️" }
};

// Mapeamento de direções do vento
const WIND_DIRECTIONS = [
	{ name: "N", emoji: "⬆️", min: 348.75, max: 11.25 },
	{ name: "NNE", emoji: "↗️", min: 11.25, max: 33.75 },
	{ name: "NE", emoji: "↗️", min: 33.75, max: 56.25 },
	{ name: "ENE", emoji: "↗️", min: 56.25, max: 78.75 },
	{ name: "E", emoji: "👉", min: 78.75, max: 101.25 },
	{ name: "ESE", emoji: "↘️", min: 101.25, max: 123.75 },
	{ name: "SE", emoji: "↘️", min: 123.75, max: 146.25 },
	{ name: "SSE", emoji: "↘️", min: 146.25, max: 168.75 },
	{ name: "S", emoji: "⬇️", min: 168.75, max: 191.25 },
	{ name: "SSW", emoji: "↙️", min: 191.25, max: 213.75 },
	{ name: "SW", emoji: "↙️", min: 213.75, max: 236.25 },
	{ name: "WSW", emoji: "↙️", min: 236.25, max: 258.75 },
	{ name: "W", emoji: "👈", min: 258.75, max: 281.25 },
	{ name: "WNW", emoji: "↖️", min: 281.25, max: 303.75 },
	{ name: "NW", emoji: "↖️", min: 303.75, max: 326.25 },
	{ name: "NNW", emoji: "↖️", min: 326.25, max: 348.75 }
];

/**
 * Obtém informações do código WMO
 */
function getWmoInfo(code) {
	return WMO_MAPPING[code] || { desc: "Desconhecido", emoji: "🌡️" };
}

/**
 * Obtém direção do vento
 */
function getWindDirection(degrees) {
	const normalizedDegrees = ((degrees % 360) + 360) % 360;
	return (
		WIND_DIRECTIONS.find(
			(dir) =>
				(normalizedDegrees >= dir.min && normalizedDegrees < dir.max) ||
				(dir.min > dir.max && (normalizedDegrees >= dir.min || normalizedDegrees < dir.max))
		) || WIND_DIRECTIONS[0]
	);
}

/**
 * Obtém coordenadas de uma cidade com suporte a filtragem por estado brasileiro
 */
async function getCityCoordinates(query) {
	try {
		let cityName = query.trim();
		let filterState = null;

		// Detecta "Cidade, RS" ou "Cidade - RS" ou "Cidade RS"
		const stateMatch = cityName.match(/^(.*?)\s*[,-\s]+\s*([a-zA-Z]{2})$/);
		if (stateMatch) {
			cityName = stateMatch[1].trim().replace(/[,-\s]+$/, "");
			const stateCode = stateMatch[2].toUpperCase();
			if (BRAZILIAN_STATES[stateCode]) {
				filterState = BRAZILIAN_STATES[stateCode];
			}
		} else {
			// Tenta detectar nome do estado por extenso no final
			for (const fullState in BRAZILIAN_STATES_FULL) {
				const regex = new RegExp(`^(.*?)\\s*[,-\\s]*\\s*${fullState}$`, "i");
				const fullMatch = cityName.match(regex);
				if (fullMatch) {
					cityName = fullMatch[1].trim().replace(/[,-\s]+$/, "");
					filterState = BRAZILIAN_STATES_FULL[fullState];
					break;
				}
			}
		}

		// Se o nome da cidade ficou vazio (ex: usuário digitou só o estado), volta ao original
		if (!cityName) cityName = query.trim();

		const response = await axios.get(GEO_API_URL, {
			params: {
				name: cityName,
				count: 10,
				language: "pt",
				format: "json"
			}
		});

		if (response.data && response.data.results && response.data.results.length > 0) {
			const results = response.data.results;
			let selected = results[0]; // Padrão é o primeiro resultado

			// Se temos um estado para filtrar, procuramos nos resultados
			if (filterState) {
				const match = results.find(
					(r) => r.country_code === "BR" && (r.admin1 === filterState || r.admin2 === filterState)
				);
				if (match) selected = match;
			} else {
				// Se não tem estado, mas o primeiro resultado não é Brasil e existe um Brasil na lista, priorizamos Brasil
				if (selected.country_code !== "BR") {
					const brazilMatch = results.find((r) => r.country_code === "BR");
					if (brazilMatch) selected = brazilMatch;
				}
			}

			return {
				lat: selected.latitude,
				lon: selected.longitude,
				name: selected.name,
				admin1: selected.admin1,
				country: selected.country
			};
		}

		throw new Error(`Cidade não encontrada: ${query}`);
	} catch (error) {
		logger.error(`Erro ao obter coordenadas para "${query}":`, error);
		throw error;
	}
}

/**
 * Obtém dados do clima
 */
async function getWeatherData(lat, lon) {
	try {
		const response = await axios.get(WEATHER_API_URL, {
			params: {
				latitude: lat,
				longitude: lon,
				current:
					"temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
				hourly: "temperature_2m,weather_code",
				daily:
					"weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max",
				timezone: "auto",
				forecast_days: 7
			}
		});

		return response.data;
	} catch (error) {
		logger.error(`Erro ao obter dados do clima para lat=${lat}, lon=${lon}:`, error);
		throw error;
	}
}

/**
 * Formata a mensagem final
 */
function formatWeatherMessage(location, weather) {
	try {
		const current = weather.current;
		const daily = weather.daily;
		const wmo = getWmoInfo(current.weather_code);
		const windDir = getWindDirection(current.wind_direction_10m);

		// 1. Linha principal: Agora
		let msg = `*🌍 ${location.name}${location.admin1 ? ", " + location.admin1 : ""} - ${location.country}*\n`;
		msg += `${wmo.emoji} *${current.temperature_2m}°C* (${wmo.desc})\n`;
		msg += `🔥 Sensação: ${current.apparent_temperature}°C | 💧 Umidade: ${current.relative_humidity_2m}%\n\n`;

		// 2. Previsão para 3 dias
		msg += `*📆 Previsão Próximos Dias:*\n`;
		for (let i = 1; i <= 3; i++) {
			const date = new Date(daily.time[i] + "T00:00:00");
			const dayWmo = getWmoInfo(daily.weather_code[i]);
			const dayName = date.toLocaleDateString("pt-BR", { weekday: "long" });
			const dayFormat = dayName.charAt(0).toUpperCase() + dayName.slice(1);

			msg += `${dayWmo.emoji} *${dayFormat}:* ${Math.round(daily.temperature_2m_min[i])}°C a ${Math.round(daily.temperature_2m_max[i])}°C - ${daily.precipitation_probability_max[i]}% ☔\n`;
		}

		// 3. Extra Data (Nerd section)
		msg += `\n*📊 Detalhes Adicionais:*\n`;
		msg += `${windDir.emoji} Vento: ${current.wind_speed_10m} km/h (${windDir.name}) | Rajadas: ${current.wind_gusts_10m} km/h\n`;
		msg += `📈 Pressão: ${current.pressure_msl} hPa | ☀️ UV Máx: ${daily.uv_index_max[0]}\n`;
		msg += `🌅 Nascer: ${daily.sunrise[0].split("T")[1]} | 🌇 Pôr do sol: ${daily.sunset[0].split("T")[1]}\n`;

		return msg;
	} catch (error) {
		logger.error("Erro ao formatar mensagem:", error);
		return "❌ Erro ao formatar os dados do clima.";
	}
}

/**
 * Handler do comando
 */
async function handleWeatherCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		let location;

		// Localização por mensagem citada
		if (args.length === 0) {
			const quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
			if (quotedMsg && quotedMsg.type === "location") {
				location = {
					lat: quotedMsg.location.latitude,
					lon: quotedMsg.location.longitude,
					name: quotedMsg.location.description || "Localização compartilhada",
					country: "Brasil"
				};
			} else {
				return new ReturnMessage({
					chatId,
					content:
						"❌ Por favor, digite uma cidade ou responda a uma localização.\nEx: `!clima Santa Maria, RS`",
					options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
				});
			}
		} else {
			// Busca por nome
			const cityName = args.join(" ");
			location = await getCityCoordinates(cityName);
		}

		// Obtém clima
		const weatherData = await getWeatherData(location.lat, location.lon);
		const weatherMessage = formatWeatherMessage(location, weatherData);

		// Log usage
		cmdUsage.logFixedCommandUsage({
			timestamp: Date.now(),
			command: "clima",
			user: message.author,
			groupId: chatId,
			args: args.join(" "),
			info: { location: location.name, lat: location.lat, lon: location.lon }
		});

		return new ReturnMessage({
			chatId,
			content: weatherMessage,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	} catch (error) {
		logger.error("Erro no comando clima:", error);
		return new ReturnMessage({
			chatId,
			content: `❌ Não foi possível obter o clima: ${error.message}`,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

const commands = [
	new Command({
		name: "clima",
		description: "Clima e previsão do tempo (Open-Meteo)",
		category: "utilidades",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🌤️",
			error: "❌"
		},
		method: handleWeatherCommand
	})
];

module.exports = { commands };
