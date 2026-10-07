const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const axios = require("axios");
const logger = new Logger("psncommand");

function configuration(variable) {
	const raw = process.env[variable]?.trim();
	const key = process.env.API_KEY_STEAMCOMMAND?.trim();
	if (!raw || !key) throw new Error("PLATFORM_NOT_CONFIGURED");
	let base;
	try { base = new URL(raw); } catch { throw new Error("PLATFORM_NOT_CONFIGURED"); }
	if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
		throw new Error("PLATFORM_NOT_CONFIGURED");
	}
	return {
		base: raw.replace(/\/+$/, ""),
		options: { headers: { Authorization: `Bearer ${key}` }, timeout: 25000, maxRedirects: 0 }
	};
}

async function fetchPsnLookup(onlineId) {
	const { base, options } = configuration("PSNCOMMAND_API_URL");
	const response = await axios.get(
		`${base}/internal/psn/profiles/${encodeURIComponent(onlineId)}/platinums`,
		{ ...options, timeout: 90000 }
	);
	if (!response.data?.profile?.onlineId || !Array.isArray(response.data.platinums)) {
		throw new Error("INVALID_PLATFORM_RESPONSE");
	}
	return response.data;
}

function lookupErrorMessage(error, platform) {
	const code = error.lookupCode || error.response?.data?.code;
	const status = error.response?.status;
	if (error.message === "PLATFORM_NOT_CONFIGURED") return "❌ A consulta de platinas precisa ser configurada pelo administrador do bot.";
	if (error.message === "PLATFORM_LOOKUP_PENDING") return "⏳ A consulta Steam ainda está em andamento. Tente o comando novamente em alguns minutos para recuperar o resultado.";
	if (code === "LOOKUP_EXPIRED") return "⏳ A consulta expirou. Execute o comando novamente para iniciar outra.";
	if (status === 401 || status === 403) return "❌ A credencial da API precisa ser verificada pelo administrador do bot.";
	if (["PSN_PRIVATE", "STEAM_PRIVATE", "STEAM_STATS_UNAVAILABLE"].includes(code)) return `🔒 Deixe o perfil, os jogos e as conquistas públicos na ${platform} para consultar.`;
	if (status === 404 || ["PSN_NOT_FOUND", "STEAM_NOT_FOUND"].includes(code)) return `❌ Perfil não encontrado na ${platform}. Confira o identificador informado.`;
	if (status === 400) return platform === "Steam" ? "❌ Informe um SteamID64, nome da URL personalizada ou link do perfil Steam." : "❌ Informe um Online ID PSN válido, com 3 a 16 caracteres.";
	if (code === "PSN_AUTH_EXPIRED") return "❌ A autenticação PSN precisa ser renovada pelo administrador.";
	if (status === 429 || ["STEAM_RATE_LIMIT", "PSN_RATE_LIMIT", "LOOKUP_BUSY"].includes(code)) return "⏳ Há muitas consultas em andamento. Tente novamente em alguns minutos.";
	return `❌ Não foi possível consultar a ${platform} agora. Tente novamente mais tarde.`;
}

function safeName(value) {
	return String(value || "Sem nome").replace(/[\r\n*_`]/g, " ").slice(0, 200);
}

function formatPsnReport(data, limit = 50) {
	let text = `🏆 *Platinas da PlayStation*\n\n👤 *${safeName(data.profile.onlineId)}*\n🎮 Conjuntos de troféus: *${data.totalGames}*\n💎 Platinas: *${data.totalPlatinums}*\n\n`;
	for (const [index, game] of data.platinums.slice(0, limit).entries()) {
		const trophies = game.earnedTrophies;
		text += `*${index + 1}. ${safeName(game.trophyTitleName)}* (${safeName(game.trophyTitlePlatform)})\n   🥉 ${trophies.bronze} 🥈 ${trophies.silver} 🥇 ${trophies.gold} 💎 ${trophies.platinum}\n`;
		const date = new Date(game.lastUpdatedDateTime);
		if (Number.isFinite(date.getTime())) text += `   📅 Última atividade: ${date.toLocaleDateString("pt-BR")}\n`;
		text += "\n";
	}
	if (!data.platinums.length) text += "😔 Nenhuma platina encontrada.\n";
	if (data.platinums.length > limit) text += `📋 Exibindo ${limit} de ${data.platinums.length} conjuntos platinados.\n`;
	text += "\nℹ️ Versões com conjuntos de troféus distintos contam separadamente na PSN.\n";
	text += data.fromCache ? "📦 Dados em cache." : "✨ Consulta atualizada.";
	return text;
}

function splitPlatformMessage(text, maxLength = 3500) {
	const parts = [];
	let part = "";
	for (const line of text.split("\n")) {
		if (part && part.length + line.length + 1 > maxLength) { parts.push(part.trim()); part = ""; }
		part += line + "\n";
	}
	if (part.trim()) parts.push(part.trim());
	return parts;
}

function reply(message, content) {
    const messages = splitPlatformMessage(content).map((part) => new ReturnMessage({
        chatId: message.group || message.author, content: part,
        options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
    }));
    return messages.length === 1 ? messages[0] : messages;
}
async function psnPlatinaCommand(bot, message, args, group) {
    if (!args.length) return reply(message, "❌ Informe seu Online ID PSN.\n*Exemplo:* !psn-platinas SuperSugoii");
    try {
        const data = await fetchPsnLookup(args.join(" ").trim());
        return reply(message, formatPsnReport(data));
    } catch (error) {
        logger.error("Erro na consulta PSN", { code: error.lookupCode || error.response?.data?.code, status: error.response?.status });
        return reply(message, lookupErrorMessage(error, "PSN"));
    }
}
const commands = [new Command({
    name: "psn-platinas", aliases: ["psn", "playstation"],
    description: "Consulta as platinas PSN sem cadastro no Platifly",
    usage: "!psn-platinas <online-id>", category: "jogos", needsArgs: true, minArgs: 1,
    reactions: { after: "🏆" }, method: psnPlatinaCommand
})];
const helper = {
    about: "Consulta de platinas públicas na PlayStation Network",
    implementation: "Consulta protegida à API PSN Platifly pelo Online ID, sem vincular contas",
    tags: "psn,playstation,sony,trofeus,ps4,ps5,games,jogos",
    cmds: [{ cmd: "!psn", desc: "Consulta platinas de uma conta PSN", usage: ["!psn SeuPSNID"], category: "jogos" }]
};
module.exports = { helper, commands, psnPlatinaCommand };
