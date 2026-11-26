// src/functions/DiscordCommands.js
const { PermissionsBitField } = require("discord.js");
const axios = require("axios");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Logger = require("../utils/Logger");
const telemetry = require("../telemetry");

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

const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
const NICK_MAX_LENGTH = 32;

function baseType(contentType) {
	return (contentType || "").split(";")[0].trim().toLowerCase();
}

function findAvatarAttachment(discordMessage) {
	if (!discordMessage?.attachments?.size) return null;
	return discordMessage.attachments.find((a) => AVATAR_TYPES.has(baseType(a.contentType))) || null;
}

/**
 * Extrai o buffer de imagem da mensagem ou da citação
 * @param {Object} message - Mensagem formatada
 * @returns {Promise<{buffer?: Buffer, reason?: string}>}
 */
async function extractImageBuffer(message) {
	let att = findAvatarAttachment(message.discordMessage);
	if (!att && typeof message.getQuotedMessage === "function") {
		const quoted = await message.getQuotedMessage().catch(() => null);
		att = findAvatarAttachment(quoted?.discordMessage);
	}
	if (!att) return { reason: "no_image" };
	if (!(att.size > 0) || att.size > AVATAR_MAX_BYTES) return { reason: "image_too_large" };

	try {
		const res = await telemetry.withSpan(
			"discord avatar.download",
			{
				attributes: {
					"ravena.discord.avatar.bytes": att.size,
					"ravena.discord.avatar.type": baseType(att.contentType)
				}
			},
			() =>
				axios.get(att.url, {
					responseType: "arraybuffer",
					timeout: 15000,
					maxContentLength: AVATAR_MAX_BYTES
				})
		);
		return { buffer: Buffer.from(res.data) };
	} catch (e) {
		logger.warn("Erro ao baixar imagem do anexo:", e.message);
		return { reason: "download_failed" };
	}
}

function reject(message, reason, content) {
	telemetry.setAttrs({ "app.outcome": "rejected", "app.reject.reason": reason });
	return new ReturnMessage({ chatId: message.from, content });
}

function checkAccess(bot, message, action) {
	if (!bot.useDiscord) {
		return reject(
			message,
			"not_discord",
			"❌ Este comando é exclusivo para servidores do Discord."
		);
	}
	if (!message.guildId) {
		return reject(
			message,
			"not_guild",
			"❌ Este comando só pode ser utilizado dentro de um servidor do Discord."
		);
	}
	if (!isDiscordAdmin(message)) {
		return reject(
			message,
			"no_permission",
			`❌ Apenas administradores ou membros com a permissão 'Gerenciar Servidor' podem alterar ${action} do bot.`
		);
	}
	return null;
}

function updateProfile(field, fn) {
	return telemetry.withSpan(
		"discord profile.update",
		{ attributes: { "ravena.discord.profile.field": field } },
		fn
	);
}

/**
 * Define ou reseta o apelido do bot na guilda atual
 */
async function setBotNameCommand(bot, message, args) {
	const denied = checkAccess(bot, message, "o apelido");
	if (denied) return denied;

	const newName = Array.isArray(args) ? args.join(" ").trim() : "";

	if (!newName) {
		return reject(
			message,
			"missing_name",
			"📝 Informe o novo apelido: `!d-botname <novo nome>` ou `!d-botname reset` para voltar ao padrão."
		);
	}
	if (newName.length > NICK_MAX_LENGTH) {
		return reject(
			message,
			"name_too_long",
			`❌ O apelido pode ter no máximo ${NICK_MAX_LENGTH} caracteres.`
		);
	}

	try {
		if (newName.toLowerCase() === "reset") {
			await updateProfile("nick", () => bot.setGuildNickname(message.guildId, null));
			return new ReturnMessage({
				chatId: message.from,
				content: "✅ Apelido do bot neste servidor foi resetado para o padrão!"
			});
		}

		await updateProfile("nick", () => bot.setGuildNickname(message.guildId, newName));
		return new ReturnMessage({
			chatId: message.from,
			content: `✅ Apelido do bot neste servidor atualizado para: **${newName}**`
		});
	} catch (err) {
		if (err.code === 50013) {
			return reject(
				message,
				"bot_missing_permission",
				"❌ O bot não possui permissão de 'Alterar Apelido' neste servidor do Discord."
			);
		}
		return new ReturnMessage({
			chatId: message.from,
			content: `❌ Falha ao atualizar apelido: ${err.message}`
		});
	}
}

const AVATAR_REJECTIONS = {
	no_image:
		"🖼️ Envie uma imagem (PNG, JPEG, GIF ou WEBP) com o comando ou responda a uma imagem existente para definir a foto do bot neste servidor.",
	image_too_large: `❌ A imagem pode ter no máximo ${AVATAR_MAX_BYTES / (1024 * 1024)} MB.`,
	download_failed: "❌ Não consegui baixar a imagem. Tente enviar de novo."
};

/**
 * Define a foto de perfil do bot exclusiva para a guilda atual
 */
async function setBotAvatarCommand(bot, message) {
	const denied = checkAccess(bot, message, "a foto de perfil");
	if (denied) return denied;

	const { buffer, reason } = await extractImageBuffer(message);
	if (!buffer) return reject(message, reason, AVATAR_REJECTIONS[reason]);

	try {
		await updateProfile("avatar", () => bot.setGuildAvatar(message.guildId, buffer));
		return new ReturnMessage({
			chatId: message.from,
			content: "✅ Foto de perfil do bot neste servidor atualizada com sucesso!"
		});
	} catch (err) {
		if (err.code === 50013) {
			return reject(
				message,
				"bot_missing_permission",
				"❌ O bot não possui permissão suficiente para alterar seu avatar neste servidor do Discord."
			);
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
	const denied = checkAccess(bot, message, "a foto de perfil");
	if (denied) return denied;

	try {
		await updateProfile("avatar", () => bot.setGuildAvatar(message.guildId, null));
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
			cmd: "!d-botavatar (com imagem anexada ou respondendo a uma imagem)",
			description:
				"Define a foto de perfil do bot exclusiva para este servidor Discord (PNG, JPEG, GIF ou WEBP, até 8 MB)",
			usage: ["!d-botavatar (com imagem anexada)", "!d-botavatar (respondendo a uma imagem)"]
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
