// src/functions/DiscordCommands.js
const { PermissionsBitField } = require("discord.js");
const axios = require("axios");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Logger = require("../utils/Logger");

const logger = new Logger("discord-commands");

/**
 * Verifica se o autor da mensagem possui permissão administrativa no servidor Discord
 * @param {Object} message - Objeto formatado da mensagem
 * @returns {boolean}
 */
function isDiscordAdmin(message) {
	if (!message.discordMessage || !message.discordMessage.member) return false;
	const member = message.discordMessage.member;

	// Dono do servidor sempre tem permissão
	if (message.discordMessage.guild && member.id === message.discordMessage.guild.ownerId) {
		return true;
	}

	// Permissões administrativas padrão no Discord
	return (
		member.permissions.has(PermissionsBitField.Flags.Administrator) ||
		member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
		member.permissions.has(PermissionsBitField.Flags.ManageNicknames)
	);
}

/**
 * Extrai o buffer de imagem da mensagem, citação ou argumento
 * @param {Object} message - Mensagem formatada
 * @param {Array} args - Argumentos do comando
 * @returns {Promise<Buffer|null>}
 */
async function extractImageBuffer(message, args) {
	// 1. Imagem anexada na mensagem atual (Discord.js direto)
	if (message.discordMessage && message.discordMessage.attachments?.size > 0) {
		const att = message.discordMessage.attachments.find(
			(a) => a.contentType && a.contentType.startsWith("image/")
		);
		if (att && att.url) {
			const res = await axios.get(att.url, { responseType: "arraybuffer", timeout: 15000 });
			return Buffer.from(res.data);
		}
	}

	// 2. Download via método da mensagem
	if (message.hasMedia && typeof message.downloadMedia === "function") {
		try {
			const media = await message.downloadMedia();
			if (media && media.data) {
				return Buffer.from(media.data, "base64");
			}
		} catch (e) {
			logger.warn("Erro ao baixar mídia da mensagem:", e);
		}
	}

	// 3. Imagem de mensagem citada (reply)
	if (typeof message.getQuotedMessage === "function") {
		try {
			const quoted = await message.getQuotedMessage();
			if (quoted) {
				if (quoted.discordMessage && quoted.discordMessage.attachments?.size > 0) {
					const qAtt = quoted.discordMessage.attachments.find(
						(a) => a.contentType && a.contentType.startsWith("image/")
					);
					if (qAtt && qAtt.url) {
						const res = await axios.get(qAtt.url, { responseType: "arraybuffer", timeout: 15000 });
						return Buffer.from(res.data);
					}
				}
				if (quoted.hasMedia && typeof quoted.downloadMedia === "function") {
					const media = await quoted.downloadMedia();
					if (media && media.data) {
						return Buffer.from(media.data, "base64");
					}
				}
			}
		} catch (e) {
			logger.warn("Erro ao buscar mídia de mensagem citada:", e);
		}
	}

	// 4. URL nos argumentos
	if (Array.isArray(args) && args.length > 0) {
		const candidateUrl = args[0].trim();
		if (/^https?:\/\//i.test(candidateUrl)) {
			try {
				const res = await axios.get(candidateUrl, { responseType: "arraybuffer", timeout: 15000 });
				const contentType = res.headers["content-type"] || "";
				if (contentType.startsWith("image/") || candidateUrl.match(/\.(png|jpe?g|webp|gif)$/i)) {
					return Buffer.from(res.data);
				}
			} catch (e) {
				logger.warn("Erro ao baixar imagem via URL:", e);
			}
		}
	}

	return null;
}

/**
 * Define ou reseta o apelido do bot na guilda atual
 */
async function setBotNameCommand(bot, message, args) {
	if (!bot.useDiscord) {
		return new ReturnMessage({
			chatId: message.from,
			content: "❌ Este comando é exclusivo para servidores do Discord."
		});
	}

	if (!message.guildId) {
		return new ReturnMessage({
			chatId: message.from,
			content: "❌ Este comando só pode ser utilizado dentro de um servidor do Discord."
		});
	}

	if (!isDiscordAdmin(message)) {
		return new ReturnMessage({
			chatId: message.from,
			content:
				"❌ Apenas administradores ou membros com a permissão 'Gerenciar Servidor' podem alterar o apelido do bot."
		});
	}

	const newName = Array.isArray(args) ? args.join(" ").trim() : "";

	try {
		if (!newName || newName.toLowerCase() === "reset") {
			await bot.setGuildNickname(message.guildId, null);
			return new ReturnMessage({
				chatId: message.from,
				content: "✅ Apelido do bot neste servidor foi resetado para o padrão!"
			});
		}

		await bot.setGuildNickname(message.guildId, newName);
		return new ReturnMessage({
			chatId: message.from,
			content: `✅ Apelido do bot neste servidor atualizado para: **${newName}**`
		});
	} catch (err) {
		if (err.code === 50013) {
			return new ReturnMessage({
				chatId: message.from,
				content: "❌ O bot não possui permissão de 'Alterar Apelido' neste servidor do Discord."
			});
		}
		return new ReturnMessage({
			chatId: message.from,
			content: `❌ Falha ao atualizar apelido: ${err.message}`
		});
	}
}

/**
 * Define a foto de perfil do bot exclusiva para a guilda atual
 */
async function setBotAvatarCommand(bot, message, args) {
	if (!bot.useDiscord) {
		return new ReturnMessage({
			chatId: message.from,
			content: "❌ Este comando é exclusivo para servidores do Discord."
		});
	}

	if (!message.guildId) {
		return new ReturnMessage({
			chatId: message.from,
			content: "❌ Este comando só pode ser utilizado dentro de um servidor do Discord."
		});
	}

	if (!isDiscordAdmin(message)) {
		return new ReturnMessage({
			chatId: message.from,
			content:
				"❌ Apenas administradores ou membros com a permissão 'Gerenciar Servidor' podem alterar a foto de perfil do bot."
		});
	}

	const imageBuffer = await extractImageBuffer(message, args);
	if (!imageBuffer) {
		return new ReturnMessage({
			chatId: message.from,
			content:
				"🖼️ Envie uma imagem com o comando, responda a uma imagem existente ou informe a URL de uma imagem válida para definir a foto do bot neste servidor."
		});
	}

	try {
		await bot.setGuildAvatar(message.guildId, imageBuffer);
		return new ReturnMessage({
			chatId: message.from,
			content: "✅ Foto de perfil do bot neste servidor atualizada com sucesso!"
		});
	} catch (err) {
		if (err.code === 50013) {
			return new ReturnMessage({
				chatId: message.from,
				content:
					"❌ O bot não possui permissão suficiente para alterar seu avatar neste servidor do Discord."
			});
		}
		return new ReturnMessage({
			chatId: message.from,
			content: `❌ Falha ao atualizar avatar: ${err.message}`
		});
	}
}

/**
 * Reseta a foto de perfil do bot na guilda para o avatar padrão global
 */
async function resetBotAvatarCommand(bot, message) {
	if (!bot.useDiscord) {
		return new ReturnMessage({
			chatId: message.from,
			content: "❌ Este comando é exclusivo para servidores do Discord."
		});
	}

	if (!message.guildId) {
		return new ReturnMessage({
			chatId: message.from,
			content: "❌ Este comando só pode ser utilizado dentro de um servidor do Discord."
		});
	}

	if (!isDiscordAdmin(message)) {
		return new ReturnMessage({
			chatId: message.from,
			content:
				"❌ Apenas administradores ou membros com a permissão 'Gerenciar Servidor' podem alterar a foto de perfil do bot."
		});
	}

	try {
		await bot.setGuildAvatar(message.guildId, null);
		return new ReturnMessage({
			chatId: message.from,
			content: "✅ Foto de perfil do bot neste servidor foi resetada para o avatar padrão!"
		});
	} catch (err) {
		return new ReturnMessage({
			chatId: message.from,
			content: `❌ Falha ao resetar avatar: ${err.message}`
		});
	}
}

const commands = [
	new Command({
		name: "d-botname",
		aliases: ["d-nome", "discord-nome", "botname"],
		description: "Altera o apelido do bot neste servidor do Discord (use 'reset' para restaurar)",
		category: "grupo",
		cooldown: 20,
		reactions: { before: "📝", after: "✅", error: "❌" },
		method: setBotNameCommand
	}),
	new Command({
		name: "d-botavatar",
		aliases: ["d-avatar", "discord-avatar", "botavatar"],
		description: "Altera a foto de perfil do bot exclusivamente para este servidor do Discord",
		category: "grupo",
		cooldown: 30,
		reactions: { before: "🖼️", after: "✅", error: "❌" },
		method: setBotAvatarCommand
	}),
	new Command({
		name: "d-botavatar-reset",
		aliases: ["d-avatar-reset", "discord-avatar-reset"],
		description: "Restaura o avatar do bot no servidor atual para o padrão global",
		category: "grupo",
		cooldown: 20,
		reactions: { before: "🔄", after: "✅", error: "❌" },
		method: resetBotAvatarCommand
	})
];

const helper = {
	category: "grupo",
	name: "Discord",
	description: "Comandos de personalização da identidade do bot para servidores do Discord",
	commands: [
		{
			cmd: "!d-botname <novo nome>",
			description: "Altera o apelido do bot no servidor atual (use 'reset' para voltar ao padrão)",
			usage: ["!d-botname Ravena Assistente", "!d-botname reset"]
		},
		{
			cmd: "!d-botavatar [url ou anexo]",
			description: "Define a foto de perfil do bot exclusiva para este servidor Discord",
			usage: ["!d-botavatar (com imagem anexada)", "!d-botavatar https://exemplo.com/foto.png"]
		},
		{
			cmd: "!d-botavatar-reset",
			description: "Remove a foto de perfil personalizada do servidor, voltando ao avatar global",
			usage: ["!d-botavatar-reset"]
		}
	]
};

module.exports = {
	commands,
	helper,
	isDiscordAdmin,
	extractImageBuffer,
	setBotNameCommand,
	setBotAvatarCommand,
	resetBotAvatarCommand
};
