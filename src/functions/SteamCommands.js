const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const axios = require("axios");
const logger = new Logger("steamcommand");

function configuration(variable) {
	const raw = process.env[variable]?.trim();
	const key = process.env.API_KEY_STEAMCOMMAND?.trim();
	if (!raw || !key) throw new Error("PLATFORM_NOT_CONFIGURED");
	let base;
	try {
		base = new URL(raw);
	} catch {
		throw new Error("PLATFORM_NOT_CONFIGURED");
	}
	if (
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	) {
		throw new Error("PLATFORM_NOT_CONFIGURED");
	}
	return {
		base: raw.replace(/\/+$/, ""),
		options: { headers: { Authorization: `Bearer ${key}` }, timeout: 25000, maxRedirects: 0 }
	};
}

async function startSteamLookup(user) {
	const { base, options } = configuration("STEAMCOMMAND_API_URL");
	const response = await axios.post(`${base}/internal/steam/platinums`, { user }, options);
	return response.data;
}

async function waitSteamLookup(job, maxWait = 21 * 60 * 1000) {
	const { base, options } = configuration("STEAMCOMMAND_API_URL");
	const deadline = Date.now() + maxWait;
	while (job.status === "queued" || job.status === "running") {
		if (!/^[a-f0-9]{32}$/.test(job.jobId || "")) throw new Error("INVALID_PLATFORM_RESPONSE");
		if (Date.now() + 5000 >= deadline) throw new Error("PLATFORM_LOOKUP_PENDING");
		await new Promise((resolve) => setTimeout(resolve, 5000));
		const response = await axios.get(`${base}/internal/steam/jobs/${job.jobId}`, options);
		job = response.data;
	}
	if (job.status === "failed") {
		const error = new Error("PLATFORM_LOOKUP_FAILED");
		error.lookupCode = job.failure?.code;
		throw error;
	}
	if (job.status !== "completed" || !Array.isArray(job.result?.platinums)) {
		throw new Error("INVALID_PLATFORM_RESPONSE");
	}
	return job.result;
}

function lookupErrorMessage(error, platform) {
	const code = error.lookupCode || error.response?.data?.code;
	const status = error.response?.status;
	if (error.message === "PLATFORM_NOT_CONFIGURED")
		return "❌ A consulta de platinas precisa ser configurada pelo administrador do bot.";
	if (error.message === "PLATFORM_LOOKUP_PENDING")
		return "⏳ A consulta Steam ainda está em andamento. Tente o comando novamente em alguns minutos para recuperar o resultado.";
	if (code === "LOOKUP_EXPIRED")
		return "⏳ A consulta expirou. Execute o comando novamente para iniciar outra.";
	if (status === 401 || status === 403)
		return "❌ A credencial da API precisa ser verificada pelo administrador do bot.";
	if (["PSN_PRIVATE", "STEAM_PRIVATE", "STEAM_STATS_UNAVAILABLE"].includes(code))
		return `🔒 Deixe o perfil, os jogos e as conquistas públicos na ${platform} para consultar.`;
	if (status === 404 || ["PSN_NOT_FOUND", "STEAM_NOT_FOUND"].includes(code))
		return `❌ Perfil não encontrado na ${platform}. Confira o identificador informado.`;
	if (status === 400)
		return platform === "Steam"
			? "❌ Informe um SteamID64, nome da URL personalizada ou link do perfil Steam."
			: "❌ Informe um Online ID PSN válido, com 3 a 16 caracteres.";
	if (code === "PSN_AUTH_EXPIRED")
		return "❌ A autenticação PSN precisa ser renovada pelo administrador.";
	if (status === 429 || ["STEAM_RATE_LIMIT", "PSN_RATE_LIMIT", "LOOKUP_BUSY"].includes(code))
		return "⏳ Há muitas consultas em andamento. Tente novamente em alguns minutos.";
	return `❌ Não foi possível consultar a ${platform} agora. Tente novamente mais tarde.`;
}

function safeName(value) {
	return String(value || "Sem nome")
		.replace(/[\r\n*_`]/g, " ")
		.slice(0, 200);
}

function formatSteamReport(data, limit = 50) {
	let text = `🏆 *Platinas da Steam*\n\n👤 *${safeName(data.profile.name)}*\n🔗 ${data.profile.profile_url}\n\n`;
	text += `🎮 Total de jogos: *${data.total_games}*\n🕹️ Jogos jogados: *${data.played_games}*\n💎 Platinas (100% conquistas): *${data.platinums_count}*\n\n`;
	for (const [index, game] of data.platinums.slice(0, limit).entries()) {
		const minutes = Math.max(0, Math.floor(game.playtime_forever || 0));
		text += `*${index + 1}. ${safeName(game.game_name)}*\n   🏅 ${game.total_achievements} conquistas • ⏱️ ${Math.floor(minutes / 60)}h ${minutes % 60}m\n\n`;
	}
	if (!data.platinums.length) text += "😔 Nenhuma platina encontrada.\n";
	if (data.platinums.length > limit)
		text += `📋 Exibindo ${limit} de ${data.platinums.length} jogos platinados.\n`;
	if (data.partial)
		text += `⚠️ Resultado parcial: ${data.unavailable_games} jogo(s) com conquistas indisponíveis.\n`;
	text += data.from_cache ? "\n📦 Dados em cache." : "\n✨ Consulta atualizada.";
	return text;
}

function splitPlatformMessage(text, maxLength = 3500) {
	const parts = [];
	let part = "";
	for (const line of text.split("\n")) {
		if (part && part.length + line.length + 1 > maxLength) {
			parts.push(part.trim());
			part = "";
		}
		part += line + "\n";
	}
	if (part.trim()) parts.push(part.trim());
	return parts;
}

function reply(message, content) {
	const messages = splitPlatformMessage(content).map(
		(part) =>
			new ReturnMessage({
				chatId: message.group || message.author,
				content: part,
				options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
			})
	);
	return messages.length === 1 ? messages[0] : messages;
}

async function platinaCommand(bot, message, args, group) {
	if (!args.length)
		return reply(
			message,
			"❌ Informe um SteamID64, nome da URL personalizada ou link do perfil.\n*Exemplo:* !steam-platinas meu_usuario"
		);
	try {
		const job = await startSteamLookup(args.join(" ").trim());
		if (
			(job.status === "queued" || job.status === "running") &&
			typeof bot.sendReturnMessages === "function"
		) {
			// Poll separately so other WhatsApp commands can continue while Valve is queried.
			waitSteamLookup(job)
				.then(async (data) => {
					await bot.sendReturnMessages(reply(message, formatSteamReport(data)), group);
				})
				.catch(async (error) => {
					logger.error("Consulta Steam não concluída", {
						code: error.lookupCode || error.response?.data?.code,
						status: error.response?.status
					});
					try {
						await bot.sendReturnMessages(reply(message, lookupErrorMessage(error, "Steam")), group);
					} catch {
						logger.error("Não foi possível enviar o resultado Steam");
					}
				});
			return reply(
				message,
				"⏳ Consulta Steam iniciada. Vou enviar as platinas aqui quando terminar; bibliotecas grandes podem levar alguns minutos."
			);
		}
		return reply(message, formatSteamReport(await waitSteamLookup(job)));
	} catch (error) {
		logger.error("Erro na consulta Steam", {
			code: error.lookupCode || error.response?.data?.code,
			status: error.response?.status
		});
		return reply(message, lookupErrorMessage(error, "Steam"));
	}
}

const commands = [
	new Command({
		name: "steam-platinas",
		aliases: ["platina", "platinas"],
		description: "Consulta jogos com 100% das conquistas na Steam, sem cadastro no Platifly",
		usage: "!steam-platinas <usuario/steamid/url>",
		category: "jogos",
		needsArgs: true,
		minArgs: 1,
		reactions: { after: "🏆" },
		method: platinaCommand
	})
];
const helper = {
	about: "Consulta de perfis, jogos e conquistas platinadas na Steam",
	implementation:
		"Consulta protegida ao backend Platifly; SteamID64, URL personalizada ou link público",
	tags: "steam,platinas,conquistas,jogos,pc,games,perfil",
	cmds: [
		{
			cmd: "!steam-platinas",
			desc: "Lista jogos com 100% das conquistas",
			usage: ["!steam-platinas VanityURLOuSteamID"],
			category: "jogos"
		}
	]
};

/**
 * Consulta informações e preços de um jogo na Steam Store
 * @param {string} query - Nome do jogo
 * @returns {Promise<string>}
 */
async function fetchSteamGameInfo(query) {
	if (!query || typeof query !== "string" || query.trim().length === 0) {
		return "Por favor, informe o nome do jogo para pesquisar na Steam.";
	}

	const termo = query.trim();

	try {
		// 1. Busca jogo na Steam Store API (Store Search)
		const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(termo)}&l=brazilian&cc=BR`;
		const searchRes = await axios.get(searchUrl, { timeout: 10000 });
		const items = searchRes.data?.items;

		if (!items || items.length === 0) {
			return `Não foi possível encontrar o jogo "${termo}" na Steam.`;
		}

		const bestItem = items[0];
		const appId = bestItem.id;

		// 2. Detalhes completos do App
		const detailUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=br&l=brazilian`;
		const detailRes = await axios.get(detailUrl, { timeout: 10000 });
		const appData = detailRes.data?.[appId]?.data;

		if (!appData) {
			return `🎮 **${bestItem.name}**\n🔗 Link: https://store.steampowered.com/app/${appId}/`;
		}

		let resultado = `🎮 **${appData.name}** (AppID: ${appId})\n`;
		if (appData.is_free) {
			resultado += `💰 Preço: **Gratuito para Jogar (Free to Play)**\n`;
		} else if (appData.price_overview) {
			const po = appData.price_overview;
			if (po.discount_percent > 0) {
				resultado += `💰 Preço: **${po.final_formatted}** (🔥 -${po.discount_percent}% OFF | De ${po.initial_formatted})\n`;
			} else {
				resultado += `💰 Preço: **${po.final_formatted}**\n`;
			}
		} else {
			resultado += `💰 Preço: Não disponível / Grátis\n`;
		}

		if (appData.developers && appData.developers.length > 0) {
			resultado += `🏢 Desenvolvedor: ${appData.developers.join(", ")}\n`;
		}
		if (appData.release_date?.date) {
			resultado += `📅 Lançamento: ${appData.release_date.date}\n`;
		}
		if (appData.genres && appData.genres.length > 0) {
			resultado += `🏷️ Gêneros: ${appData.genres.map((g) => g.description).join(", ")}\n`;
		}
		if (appData.short_description) {
			resultado += `\n📝 Descrição: ${appData.short_description.trim()}\n`;
		}
		resultado += `\n🔗 Loja Steam: https://store.steampowered.com/app/${appId}/`;

		return resultado.trim();
	} catch (err) {
		logger.error(`Erro ao consultar jogo na Steam para ${query}:`, err.message);
		return `Erro ao consultar a Steam para "${query}": ${err.message}`;
	}
}

async function fetchSteamPlatinums(user) {
	if (!user || typeof user !== "string" || !user.trim())
		return "Informe um SteamID64 ou a URL do perfil Steam.";
	try {
		const job = await startSteamLookup(user.trim());
		// LLM tools have a short execution budget; the explicit WhatsApp command waits separately.
		return formatSteamReport(await waitSteamLookup(job, 15000), 10);
	} catch (error) {
		logger.error("Erro na consulta Steam para ferramenta", {
			code: error.lookupCode || error.response?.data?.code,
			status: error.response?.status
		});
		if (error.message === "PLATFORM_LOOKUP_PENDING")
			return "Consulta Steam iniciada e ainda em processamento. Use !steam-platinas com o mesmo SteamID ou URL para receber o resultado completo.";
		return lookupErrorMessage(error, "Steam");
	}
}

module.exports = { helper, commands, platinaCommand, fetchSteamGameInfo, fetchSteamPlatinums };
