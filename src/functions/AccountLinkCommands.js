"use strict";

const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");
const Logger = require("../utils/Logger");
const AccountLinkService = require("../services/AccountLinkService");
const PvSafetyService = require("../services/PvSafetyService");

const logger = new Logger("account-link-commands");
const database = Database.getInstance();
const accountLinkService = AccountLinkService.getInstance();

/**
 * Comando para gerar código no WhatsApp PV ou vincular conta no Telegram/Discord
 * @param {Object} bot
 * @param {Object} message
 * @param {Array<string>} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function vincularCommand(bot, message, args, group) {
	const isTelegram = Boolean(bot.useTelegram);
	const isDiscord = Boolean(bot.useDiscord);
	const isWhatsApp = !isTelegram && !isDiscord;

	// --- FLUXO WHATSAPP ---
	if (isWhatsApp) {
		// Comando restrito exclusivamente ao PV no WhatsApp por segurança
		if (message.group) {
			return new ReturnMessage({
				chatId: message.group,
				content:
					"⚠️ *Atenção:* Por motivos de segurança, o comando `!vincular` só pode ser usado no **chat privado (PV)** com a Ravena.\n\nPor favor, me chame no privado para obter o seu código de vinculação!"
			});
		}

		try {
			const whatsappId = String(message.author).split("@")[0].replace(/\D/g, "");
			const code = await accountLinkService.createLinkCode(whatsappId);
			const links = accountLinkService.getAllLinksForWhatsApp(whatsappId);

			let response = `🔗 *Vinculação de Contas da Ravena*\n\n`;
			response += `Use o comando abaixo no **Telegram** ou no **Discord** agora para vincular sua conta:\n\n`;
			response += `\`/vincular ${code}\`\n\n`;
			response += `⏱️ *Atenção:* Este código expira em 15 minutos e só pode ser utilizado uma vez.\n`;

			if (links.telegram || links.discord) {
				response += `\n📋 *Contas atualmente vinculadas:*`;
				if (links.telegram) response += `\n• Telegram: \`${links.telegram}\``;
				if (links.discord) response += `\n• Discord: \`${links.discord}\``;
				response += `\n\nPara desvincular, envie: \`!desvincular\``;
			}

			return new ReturnMessage({
				chatId: message.author,
				content: response
			});
		} catch (error) {
			logger.error("Erro ao gerar código de vinculação no WhatsApp:", error);
			return new ReturnMessage({
				chatId: message.author,
				content: "❌ Ocorreu um erro ao gerar seu código de vinculação. Tente novamente mais tarde."
			});
		}
	}

	// --- FLUXO TELEGRAM / DISCORD ---
	const platformName = isTelegram ? "Telegram" : "Discord";
	const platformCode = isTelegram ? "telegram" : "discord";
	const platformAuthorId = String(message.platformAuthor || message.author).split("@")[0];
	const responseChatId = message.group ?? message.author;

	// Se não forneceu o código
	if (!args || args.length === 0) {
		const currentLinkedWa = accountLinkService.getLinkedWhatsApp(platformCode, platformAuthorId);

		if (currentLinkedWa) {
			return new ReturnMessage({
				chatId: responseChatId,
				content: `ℹ️ Sua conta do **${platformName}** já está vinculada ao WhatsApp (*${currentLinkedWa}*).\n\nSe quiser vincular a outro número, gere um novo código no PV da Ravena no WhatsApp com \`!vincular\` e envie:\n\`/vincular [código]\`\n\nPara desvincular: \`/desvincular\``
			});
		}

		return new ReturnMessage({
			chatId: responseChatId,
			content: `ℹ️ *Como vincular sua conta:*\n\n1. Envie \`!vincular\` no chat privado (PV) com a Ravena no **WhatsApp**.\n2. Você receberá um código temporário de verificação.\n3. Volte aqui no ${platformName} e digite:\n\`/vincular [código]\``
		});
	}

	const code = args[0].trim().toLowerCase();

	try {
		const result = await accountLinkService.linkAccount(code, platformCode, platformAuthorId);

		if (!result.success) {
			if (result.error === "expired_code") {
				return new ReturnMessage({
					chatId: responseChatId,
					content:
						"❌ *Código expirado!*\n\nO tempo de validade de 15 minutos deste código encerrou. Gere um novo código no PV do WhatsApp enviando `!vincular`."
				});
			}

			return new ReturnMessage({
				chatId: responseChatId,
				content:
					"❌ *Código inválido!*\n\nVerifique se copiou o código corretamente ou gere um novo código no PV do WhatsApp com `!vincular`."
			});
		}

		// Notifica WhatsApp em background (se houver bot de WhatsApp conectado)
		try {
			const waBots = (database.botInstances || []).filter(
				(b) => !b.useTelegram && !b.useDiscord && b.isConnected
			);
			if (waBots.length > 0) {
				const pvSafetyService = PvSafetyService.getInstance();
				const waTarget = `${result.whatsappId}@s.whatsapp.net`;
				let allowedBot = null;
				for (const candidateBot of waBots) {
					if (await pvSafetyService.hasPvInteraction(candidateBot, waTarget)) {
						allowedBot = candidateBot;
						break;
					}
				}
				if (allowedBot) {
					allowedBot
						.sendMessage(
							waTarget,
							`🔗 *Conta Vinculada com Sucesso!*\n\nSua conta do **${platformName}** (\`${platformAuthorId}\`) foi vinculada ao seu WhatsApp.\nAgora seus comandos, inventário e bônus de doador são compartilhados!`
						)
						.catch(() => {});
				} else {
					logger.info(
						`[vincular] Pulando notificação em PV para ${waTarget}: sem interação prévia em PV.`
					);
				}
			}
		} catch (_) {}

		return new ReturnMessage({
			chatId: responseChatId,
			content: `✅ *Conta vinculada com sucesso!*\n\nSua conta do **${platformName}** foi vinculada ao WhatsApp (*${result.whatsappId}*).\n\nA partir de agora, seus jogos, moedas, inventário e bônus de doador são unificados e sincronizados automaticamente! 🎉`
		});
	} catch (error) {
		logger.error("Erro ao vincular conta no Telegram/Discord:", error);
		return new ReturnMessage({
			chatId: responseChatId,
			content: "❌ Ocorreu um erro ao processar a vinculação. Tente novamente."
		});
	}
}

/**
 * Comando para desvincular conta
 * @param {Object} bot
 * @param {Object} message
 * @param {Array<string>} args
 * @param {Object} group
 * @returns {Promise<ReturnMessage>}
 */
async function desvincularCommand(bot, message, args, group) {
	const isTelegram = Boolean(bot.useTelegram);
	const isDiscord = Boolean(bot.useDiscord);
	const isWhatsApp = !isTelegram && !isDiscord;

	if (isWhatsApp) {
		if (message.group) {
			return new ReturnMessage({
				chatId: message.group,
				content: "⚠️ Por segurança, execute o comando `!desvincular` no chat privado com a Ravena."
			});
		}

		const whatsappId = String(message.author).split("@")[0].replace(/\D/g, "");
		const platformArg = args && args[0] ? args[0].toLowerCase().trim() : null;
		const links = accountLinkService.getAllLinksForWhatsApp(whatsappId);

		if (!links.telegram && !links.discord) {
			return new ReturnMessage({
				chatId: message.author,
				content:
					"ℹ️ Você não possui nenhuma conta de Telegram ou Discord vinculada ao seu WhatsApp."
			});
		}

		if (platformArg === "telegram" || platformArg === "discord") {
			if (!links[platformArg]) {
				return new ReturnMessage({
					chatId: message.author,
					content: `ℹ️ Você não possui nenhuma conta do **${platformArg.toUpperCase()}** vinculada ao seu WhatsApp.`
				});
			}

			await accountLinkService.unlinkWhatsApp(whatsappId, platformArg);
			return new ReturnMessage({
				chatId: message.author,
				content: `✅ Conta do **${platformArg.toUpperCase()}** desvinculada do seu WhatsApp com sucesso.`
			});
		}

		await accountLinkService.unlinkWhatsApp(whatsappId);
		return new ReturnMessage({
			chatId: message.author,
			content:
				"✅ Todas as contas externas (Telegram e Discord) foram desvinculadas do seu WhatsApp com sucesso."
		});
	}

	const platformName = isTelegram ? "Telegram" : "Discord";
	const platformCode = isTelegram ? "telegram" : "discord";
	const platformAuthorId = String(message.platformAuthor || message.author).split("@")[0];
	const responseChatId = message.group ?? message.author;

	const linkedWa = accountLinkService.getLinkedWhatsApp(platformCode, platformAuthorId);
	if (!linkedWa) {
		return new ReturnMessage({
			chatId: responseChatId,
			content: `ℹ️ Sua conta do **${platformName}** não está vinculada a nenhuma conta de WhatsApp.`
		});
	}

	await accountLinkService.unlink(platformCode, platformAuthorId);
	return new ReturnMessage({
		chatId: responseChatId,
		content: `✅ Sua conta do **${platformName}** foi desvinculada do WhatsApp (*${linkedWa}*) com sucesso.`
	});
}

const commands = [
	new Command({
		name: "vincular",
		aliases: ["link", "vincular-conta"],
		description: "Vincula sua conta da Ravena no WhatsApp com o Telegram ou Discord",
		usage: "!vincular (no WhatsApp PV) ou /vincular <codigo> (no Telegram/Discord)",
		category: "geral",
		hidden: true,
		reactions: {
			before: "🔗",
			after: "✅",
			error: "❌"
		},
		method: vincularCommand
	}),
	new Command({
		name: "desvincular",
		aliases: ["unlink", "desvincular-conta"],
		description: "Desvincula sua conta do Telegram ou Discord da conta do WhatsApp",
		usage: "!desvincular (no WhatsApp PV) ou /desvincular (no Telegram/Discord)",
		category: "geral",
		hidden: true,
		reactions: {
			before: "⛓️",
			after: "✅",
			error: "❌"
		},
		method: desvincularCommand
	})
];

const helper = {
	about: "Sistema de vinculação de contas entre WhatsApp, Telegram e Discord (oculto)",
	implementation:
		"Gera tokens temporários e unifica identidades das plataformas com o WhatsApp no banco SQLite",
	tags: "vincular,link,telegram,discord,whatsapp,conta,perfil,doador",
	cmds: []
};

module.exports = {
	helper,
	commands,
	vincularCommand,
	desvincularCommand
};
