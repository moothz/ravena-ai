const path = require("path");
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");
const Status = require("../utils/Status");
const fs = require("fs").promises;
const axios = require("axios");

const logger = new Logger("general-commands");

const database = Database.getInstance();

// Define os métodos de comando separadamente
async function pingCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	const delayMsg =
		message.responseTime ??
		bot.getCurrentTimestamp() -
			(message.origin.timestamp ?? message.origin.messageTimestamp ?? bot.getCurrentTimestamp());
	console.log(message.origin);
	logger.debug(`Executando comando ping para ${chatId}`);

	return new ReturnMessage({
		chatId,
		content: `Pong! 🏓 _(${delayMsg}s)_`,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin
		}
	});
}

async function grupaoCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	const zapLink = bot.linkGrupao;
	const telegramLink = process.env.TELEGRAM_COMMUNITY;
	const discordLink = process.env.DISCORD_COMMUNITY;

	let content = `🌟 *Comunidades da Ravena* 🌟\n\n`;

	if (zapLink) {
		content += `🟢 *WhatsApp (Grupão)*\n${zapLink}\n_Este é o nosso grupo principal de interação!_\n\n`;
	}

	if (telegramLink) {
		content += `🔵 *Telegram*\n${telegramLink}\n\n`;
	}

	if (discordLink) {
		content += `🟣 *Discord*\n${discordLink}\n_Atualmente em fase de testes!_\n\n`;
	}

	content += `_Sinta-se em casa!_ 🐦‍⬛✨`;

	return new ReturnMessage({
		chatId,
		content: content.trim()
	});
}

async function avisosCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const avisos = await bot.client.getChatById(bot.grupoAvisos);

	try {
		await avisos.addParticipants([message.author]);
	} catch (e) {
		logger.error(
			`[avisosCommand] Não consegui add '${message.author}' no grupo de avisos (${bot.grupoAvisos})`
		);
	}

	return new ReturnMessage({
		chatId,
		content: `Ok! Tentei de adicionar no grupo de avisos da ravena. Se não tiver sido adicionado, entre pelo link: ${bot.linkAvisos}`
	});
}

async function retrospectivaCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const retroPath = path.join(database.databasePath, "textos", "end-year.txt");
		const retroContent = await fs.readFile(retroPath, "utf8");

		return new ReturnMessage({
			chatId,
			content: retroContent.trim()
		});
	} catch (error) {
		logger.warn("Erro ao ler end-year.txt:", error);
		return new ReturnMessage({
			chatId,
			content: `Retrospectiva indisponível ainda!`
		});
	}
}

async function ravPrivadaCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const privPath = path.join(database.databasePath, "textos", "private.txt");
		const privContent = await fs.readFile(privPath, "utf8");

		return new ReturnMessage({
			chatId,
			content: privContent.trim()
		});
	} catch (error) {
		logger.warn("Erro ao ler private.txt:", error);
		return new ReturnMessage({
			chatId,
			content: `🔗 *Github:* https://github.com/moothz/ravena-ai`
		});
	}
}

async function ravComunitariaCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const comuPath = path.join(database.databasePath, "textos", "comunitaria.txt");
		const comuContent = await fs.readFile(comuPath, "utf8");

		return new ReturnMessage({
			chatId,
			content: comuContent.trim()
		});
	} catch (error) {
		logger.warn("Erro ao ler comunitaria.txt:", error);
		return new ReturnMessage({
			chatId,
			content: `🔗 *Github:* https://github.com/moothz/ravena-ai`
		});
	}
}

async function codigoCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const codigoPath = path.join(database.databasePath, "textos", "codigo.txt");
		const codigoContent = await fs.readFile(codigoPath, "utf8");

		return new ReturnMessage({
			chatId,
			content: codigoContent.trim()
		});
	} catch (error) {
		logger.warn("Erro ao ler codigo.txt:", error);
		return new ReturnMessage({
			chatId,
			content: `🔗 *Github:* https://github.com/moothz/ravena-ai`
		});
	}
}

async function conviteCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const invitesHeaderPath = path.join(database.databasePath, "textos", "invites_header.txt");
		const headerConvite = await fs.readFile(invitesHeaderPath, "utf8");
		const invitesFooterPath = path.join(database.databasePath, "textos", "invites_footer.txt");
		const footerConvite = await fs.readFile(invitesFooterPath, "utf8");

		const todas = [
			new ReturnMessage({
				chatId,
				content: `${headerConvite}${footerConvite}\n\n${bot.rndString()}`
			})
		];

		return todas;
	} catch (error) {
		logger.warn("Erro ao ler invites_xxx.txt:", error);
		return [
			new ReturnMessage({
				chatId,
				content: `🐦‍⬛ Então você quer a *ravenabot* no seu grupo?
Pra começar, me envie o *LINK*, apenas o _LINK_ do seu grupo.
Se você enviar um convite tradicional, não vai adiantar de nada, pois não consigo aceitar por aqui.
Após o link, siga as instruções do bot, enviando uma mensagem explicando o motivo de querer o bot no seu grupo.`
			})
		];
	}
}

async function discordCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const invite = process.env.DISCORD_INVITE_LINK;
	const community = process.env.DISCORD_COMMUNITY;

	if (!invite && !community) {
		return new ReturnMessage({
			chatId,
			content: "A integração com o Discord ainda não está configurada."
		});
	}

	let content = `🎮 *Ravena no Discord* 🤖\n\nAgora você pode ter a Ravena no seu servidor do Discord! Aproveite os comandos de IA, gerenciamento e diversão em uma nova plataforma.\n\n`;

	if (invite) content += `🔗 *Adicionar Bot:* ${invite}\n\n`;
	if (community)
		content += `🟣 *Comunidade Discord:* ${community}\n_Atualmente em fase de testes!_`;

	return new ReturnMessage({
		chatId,
		content: content.trim()
	});
}

async function telegramCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const invite = process.env.TELEGRAM_INVITE_LINK;
	const community = process.env.TELEGRAM_COMMUNITY;

	if (!invite && !community) {
		return new ReturnMessage({
			chatId,
			content: "A integração com o Telegram ainda não está configurada."
		});
	}

	let content = `✈️ *Ravena no Telegram* 🤖\n\nA Ravena também está presente no Telegram! Uma experiência rápida e integrada para seus grupos e conversas privadas.\n\n`;

	if (invite) content += `🔗 *Conversar com o Bot:* ${invite}\n\n`;
	if (community) content += `🔵 *Canal/Comunidade:* ${community}`;

	return new ReturnMessage({
		chatId,
		content: content.trim()
	});
}

async function diferencasCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	return new ReturnMessage({
		chatId,
		content: `Bem vindo à nova *ravena*!
Se tiver dúvidas, entre no *!grupao*

Aqui vai as principais diferenças pra antiga:

*No dia a dia:*
- Os comandos genéricos não existem mais (vocês mesmos podem criar no grupo)
- Os comandos de gerencia foram trocados por !g-xxx, envie !cmd-g para conhecê-los!
- Todos os comandos precisam de prefixo agora, então quando criar um comando, não coloque o "!" na frente do nome do comando
- O prefixo dos comandos pode ser alterado usando !g-setPrefixo
- O !stt, que transformar áudio em texto, agora roda local e não precisa mais de chave azure nenhuma
- Agora dá pra adicionar quantos canais de twitch, kick e youtube quiser em um grupo
- 

*Novos comandos legais*
- Pastas: É o _drive da ravena_! Guarde seus arquivos aqui e use comandos pra baixar todos de uma vez. Útil para grupos que precisam toda hora enviar documentos e outras coisas para membros novos.
- TTS com voz personalizada: Agora sintetizo as vozes local usando o AllSpeak, sendo o default a voz da ravena, mas podendo aprender a voz de outras pessoas também
- 

*De código:*
- O código está liberado e qualquer um pode contribuir pra novas funçoes: https://github.com/moothz/ravena-ai
- Foi 90% escrito por inteligência artificial _(Claude Sonnet 3.7)_
- A base de dados é compartilhada entre todas as ravenas agora
- Todas as ravenas rodam no mesmo processo
`
	});
}

/**
 * Define um apelido para o usuário em um grupo
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Mensagem formatada
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} Mensagem de retorno
 */
async function apelidoCommand(bot, message, args, group) {
	try {
		// Verifica se está em um grupo
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Se não há argumentos, mostrar o apelido atual
		if (args.length === 0) {
			const userNick = getUserNickname(group, message.author);
			if (userNick) {
				return new ReturnMessage({
					chatId: group.id,
					content: `Seu apelido atual é: *${userNick}*`,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			} else {
				return new ReturnMessage({
					chatId: group.id,
					content: "Você não tem um apelido definido.\nUse !apelido [apelido] para definir um.",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			}
		}

		// Obter o apelido dos argumentos
		let nickname = args.join(" ");

		// Verificar o comprimento mínimo
		if (nickname.length < 2) {
			return new ReturnMessage({
				chatId: group.id,
				content: "O apelido deve ter pelo menos 2 caracteres.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Limitar a 20 caracteres
		if (nickname.length > 20) {
			nickname = nickname.substring(0, 20);

			return new ReturnMessage({
				chatId: group.id,
				content: `O apelido foi limitado a 20 caracteres: *${nickname}*`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Inicializar nicks array se não existir
		if (!group.nicks) {
			group.nicks = [];
		}

		// Verificar se o usuário já tem um apelido
		const existingIndex = group.nicks.findIndex((nick) => nick.numero === message.author);

		if (existingIndex !== -1) {
			// Atualizar apelido existente
			group.nicks[existingIndex].apelido = nickname;
		} else {
			// Adicionar novo apelido
			group.nicks.push({
				numero: message.author,
				apelido: nickname
			});
		}

		// Salvar grupo
		await database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: `Apelido definido: *${nickname}*`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro ao definir apelido:", error);

		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao definir apelido. Por favor, tente novamente."
		});
	}
}

/**
 * Obtém o apelido de um usuário de um grupo
 * @param {Object} group - Dados do grupo
 * @param {string} userId - ID do usuário
 * @returns {string|null} - Apelido do usuário ou null se não definido
 */
function getUserNickname(group, userId) {
	if (!group || !group.nicks || !Array.isArray(group.nicks)) {
		return null;
	}

	const nickData = group.nicks.find((nick) => nick.numero === userId);
	return nickData ? nickData.apelido : null;
}

function renderBotStatus(botData) {
	let statusMessage = "";

	const now = new Date();
	const lastMessageTime = new Date(botData.lastMessageReceived);
	const diffMinutes = (now - lastMessageTime) / (1000 * 60);

	let statusEmoji = "⚫️";
	if (diffMinutes <= 15) {
		statusEmoji = "🟢";
	} else if (diffMinutes <= 30) {
		statusEmoji = "🟡";
	} else if (diffMinutes <= 60) {
		statusEmoji = "🔴";
	}

	const tipoEmoji = botData.vip ? "💎" : botData.comunitario ? "🐓" : "";

	statusMessage += `${statusEmoji} *${botData.id}* ${tipoEmoji}\n`;
	statusMessage += `- 📞 Número: _+${botData.phoneNumber.replace(/(\d{2})(\d{2})(\d{5})(\d{4})/, "$1 ($2) $3-$4")}_\n`;

	if (botData.numeroResponsavel) {
		statusMessage += `- 👑 Responsável: _+${botData.numeroResponsavel.replace(/(\d{2})(\d{2})(\d{5})(\d{4})/, "$1 ($2) $3-$4")}_\n`;
	}

	if (diffMinutes <= 1) {
		statusMessage += "- ⏲️ Última msg: Agora mesmo\n";
	} else {
		statusMessage += `- ⏲️ Última msg: ${Math.floor(diffMinutes)} minutos atrás\n`;
	}

	statusMessage += `- 📈 Msgs/hora: ${botData.msgsHr}\n`;
	statusMessage += `- ⏳ Delay Médio: ${botData.responseTime.avg.toFixed(2)}s\n`;

	const extraInfo = [];
	if (botData.semPV) {
		extraInfo.push("PV desabilitado");
	}
	if (botData.semConvites) {
		extraInfo.push("não recebe convites");
	}
	if (extraInfo.length > 0) {
		statusMessage += `- _${extraInfo.join(", ")}_\n`;
	}

	statusMessage += "\n";

	return statusMessage;
}

async function statusCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const url = `http://localhost:${process.env.API_PORT ?? 5000}/health`;

	try {
		// Carrega status dos serviços externos
		let servicesHeader = "";
		try {
			const servicesData = await Status.getServicesStatus();

			const getEmoji = (status) => {
				if (status === "up") return "🟢";
				if (status === "backup") return "🟠";
				if (status === "down") return "🔴";
				return "⚫";
			};

			servicesHeader = `📡 *Serviços Externos*\n`;
			servicesHeader += `\t${getEmoji(servicesData.whatsgoapi)} WhatsGo _(serviço principal)_\n`;
			servicesHeader += `\t${getEmoji(servicesData.imagine)} Imagine _(geração de imagens)_\n`;
			servicesHeader += `\t${getEmoji(servicesData.llm)} LLM _(inteligência artificial)_\n`;
			servicesHeader += `\t${getEmoji(servicesData.whisper)} Whisper _(voz para texto)_\n`;
			servicesHeader += `\t${getEmoji(servicesData.f5tts)} F5-TTS _(texto para voz)_\n`;
			servicesHeader += `\n\n`;
		} catch (e) {
			// Ignora erro se não conseguir ler arquivo de status
		}

		const response = await axios.get(url);

		let statusMessage =
			"🕸 *Status das Ravenas* 🔄\n> https://ravena.moothz.win\n\n" + servicesHeader;

		const botsNormais = response.data.bots.filter((b) => !b.comunitario && !b.vip);
		const botsComunitarios = response.data.bots.filter((b) => b.comunitario);
		const botsVips = response.data.bots.filter((b) => b.vip);

		statusMessage += "🐦‍⬛ ravenas\n> as normais, de sempre!\n\n";
		for (const botData of botsNormais) {
			statusMessage += renderBotStatus(botData);
		}

		statusMessage += `🐓 *ravenas _comunitárias_* ☭\n> gerenciadas por outra pessoa, !comunitaria pra mais info\n\n`;
		for (const botData of botsComunitarios) {
			statusMessage += renderBotStatus(botData);
		}

		statusMessage += "💎 *ravenas _VIP_*\n> presente pros antigos doadores\n\n";
		for (const botData of botsVips) {
			statusMessage += renderBotStatus(botData);
		}

		const now = new Date();
		const dateString = `${now.getDate().toString().padStart(2, "0")}/${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getFullYear().toString().slice(2)}`;
		const timeString = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

		statusMessage += `> ${dateString} ${timeString}\n`;

		return new ReturnMessage({
			chatId,
			content: statusMessage.trim()
		});
	} catch (error) {
		logger.error("Erro ao buscar status dos bots:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Erro ao buscar o status das Ravenas. Tente novamente mais tarde."
		});
	}
}

// Criar array de comandos usando a classe Command
const commands = [
	new Command({
		name: "ping",
		description: "Verifica se o bot está online",
		category: "geral",
		hidden: "true",
		reactions: {
			before: "⌛️",
			after: "🍭"
		},
		method: pingCommand
	}),
	new Command({
		name: "status",
		description: "Verifica o status dos bots",
		category: "geral",
		method: statusCommand
	}),
	new Command({
		name: "apelido",
		description: "Define seu apelido no grupo",
		category: "grupo",
		method: apelidoCommand
	}),

	// new Command({
	//   name: 'diferenças',
	//   description: 'Exibe as diferenças para a ravena antiga',
	//   category: "geral",
	//   method: diferencasCommand
	// }),

	new Command({
		name: "grupao",
		description: "Comunidades da ravena!",
		category: "geral",
		reactions: {
			before: "👨‍👨‍👧‍👦"
		},
		method: grupaoCommand
	}),
	new Command({
		name: "comunidade",
		hidden: true,
		description: "Comunidades da ravena!",
		category: "geral",
		reactions: {
			before: "👨‍👨‍👧‍👦"
		},
		method: grupaoCommand
	}),

	new Command({
		name: "avisos",
		description: "Grupo de avisos ravenabot",
		category: "geral",
		reactions: {
			before: "📣"
		},
		method: avisosCommand
	}),
	new Command({
		name: "codigo",
		description: "Código da ravenabot",
		category: "geral",
		reactions: {
			before: "💾"
		},
		method: codigoCommand
	}),
	new Command({
		name: "código",
		description: "Código da ravenabot",
		category: "geral",
		hidden: true,
		reactions: {
			before: "💾"
		},
		method: codigoCommand
	}),
	new Command({
		name: "private",
		description: "Info Ravena Privada",
		category: "geral",
		hidden: true,
		reactions: {
			before: "🔐"
		},
		method: ravPrivadaCommand
	}),
	new Command({
		name: "retrospectiva",
		description: "Retrospectiva 2025! 🥳",
		category: "geral",
		hidden: true,
		reactions: {
			before: "🍾"
		},
		method: retrospectivaCommand
	}),

	new Command({
		name: "comunitaria",
		description: "Info Ravena Comunitaria",
		category: "geral",
		hidden: true,
		reactions: {
			before: "🐓"
		},
		method: ravComunitariaCommand
	}),

	new Command({
		name: "convite",
		description: "Saiba mas sobre a ravena em grupos",
		category: "geral",
		reactions: {
			before: "📩"
		},
		method: conviteCommand
	}),
	new Command({
		name: "discord",
		description: "Info sobre a Ravena no Discord",
		category: "geral",
		reactions: {
			before: "🎮"
		},
		method: discordCommand
	}),
	new Command({
		name: "telegram",
		description: "Info sobre a Ravena no Telegram",
		category: "geral",
		reactions: {
			before: "✈️"
		},
		method: telegramCommand
	})
];

// Registra os comandos sendo exportados
//logger.debug(`Exportando ${commands.length} comandos:`, commands.map(cmd => cmd.name));

module.exports = { commands, getUserNickname };
