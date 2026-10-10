const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const {
	InvalidServerAddressError,
	parseServerAddress,
	formatServerAddress,
	fetchServerStatus,
	formatStatusMessage
} = require("../services/MinecraftServerService");

const logger = new Logger("minecraft-commands");

const REMOVE_KEYWORDS = ["remover", "off", "desativar", "limpar"];
const USAGE_HINT =
	"Use: `!minecraft-servidor ip[:porta]` (ex.: `!minecraft-servidor play.exemplo.com:25300`). Sem porta, usa 25565.\nPara remover: `!minecraft-servidor remover`.\nTambém é possível configurar pelo `!g-painel`.";

function reply(message, content) {
	return new ReturnMessage({
		chatId: message.group || message.author,
		content,
		options: { quotedMessageId: message.origin?.id?._serialized, goReply: message.origin }
	});
}

function describeCurrentServer(group) {
	return group.minecraftServer
		? `Servidor atual: *${formatServerAddress(group.minecraftServer)}*`
		: "Nenhum servidor configurado.";
}

async function saveMinecraftServer(group, server) {
	group.minecraftServer = server;
	await Database.getInstance().saveGroup(group);
}

async function configureServerCommand(bot, message, args, group) {
	if (!group) return reply(message, "Este comando só pode ser usado em grupos.");

	const input = args.join(" ").trim();
	if (!input) return reply(message, `${describeCurrentServer(group)}\n\n${USAGE_HINT}`);

	if (REMOVE_KEYWORDS.includes(input.toLowerCase())) {
		await saveMinecraftServer(group, null);
		return reply(message, "🗑️ Servidor de Minecraft removido deste grupo.");
	}

	try {
		const server = parseServerAddress(input);
		await saveMinecraftServer(group, server);
		return reply(
			message,
			`✅ Servidor de Minecraft configurado: *${formatServerAddress(server)}*\nUse \`!minecraft\` para ver o status.`
		);
	} catch (error) {
		if (!(error instanceof InvalidServerAddressError)) throw error;
		return reply(message, `❌ Endereço inválido: \`${input}\`\n\n${USAGE_HINT}`);
	}
}

async function serverStatusCommand(bot, message, args, group) {
	if (!group) return reply(message, "Este comando só pode ser usado em grupos.");

	const server = group.minecraftServer;
	if (!server?.host) {
		return reply(
			message,
			"🧱 Nenhum servidor de Minecraft configurado neste grupo.\nUm admin pode configurar com `!minecraft-servidor ip[:porta]` ou pelo `!g-painel`."
		);
	}

	try {
		const statusData = await fetchServerStatus(server);
		return reply(message, formatStatusMessage(server, statusData));
	} catch (error) {
		logger.error(`Erro ao consultar servidor ${formatServerAddress(server)}:`, error.message);
		return reply(
			message,
			`⚠️ Não consegui consultar o servidor *${formatServerAddress(server)}* agora. Tente novamente em instantes.`
		);
	}
}

const commands = [
	new Command({
		name: "minecraft-servidor",
		description: "Configura o servidor de Minecraft do grupo (ip[:porta])",
		usage: "!minecraft-servidor ip[:porta]",
		category: "jogos",
		group: "minecraft-servidor",
		adminOnly: true,
		reactions: { after: "🧱" },
		method: configureServerCommand
	}),
	new Command({
		name: "mine-servidor",
		description: "Alias para o comando minecraft-servidor",
		usage: "!mine-servidor ip[:porta]",
		category: "jogos",
		group: "minecraft-servidor",
		adminOnly: true,
		reactions: { after: "🧱" },
		method: configureServerCommand
	}),
	new Command({
		name: "minecraft",
		aliases: [],
		description: "Mostra se o servidor de Minecraft do grupo está online e quem está jogando",
		usage: "!minecraft",
		category: "jogos",
		cooldown: 10,
		reactions: { before: "⏳", after: "🧱" },
		method: serverStatusCommand
	})
];

const helper = {
	about: "Status do servidor de Minecraft configurado no grupo",
	implementation: "Consulta dados e status do servidor de Minecraft configurado no grupo",
	tags: "minecraft,servidor,server,mc,jogadores,online,jogos",
	cmds: [
		{
			cmd: "!minecraft-servidor",
			desc: "Define o servidor de Minecraft do grupo (apenas admins). Alias: !mine-servidor",
			usage: ["!minecraft-servidor play.exemplo.com", "!minecraft-servidor play.exemplo.com:25300"],
			category: "jogos"
		},
		{
			cmd: "!minecraft",
			desc: "Mostra se o servidor está online, quantos jogadores e seus nicks",
			usage: ["!minecraft"],
			category: "jogos"
		}
	]
};

module.exports = { helper, commands, configureServerCommand, serverStatusCommand };
