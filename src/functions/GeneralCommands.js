const path = require("path");
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");
const Status = require("../utils/Status");
const MemoryCache = require("../utils/MemoryCache");
const LLMService = require("../services/LLMService");
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
	logger.debug("Message origin:", message.origin);
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
	const zapComunidade = bot.linkComunidade || process.env.LINK_COMUNIDADE;
	const telegramLink = process.env.TELEGRAM_COMMUNITY;
	const discordLink = process.env.DISCORD_COMMUNITY;

	let content = `🌟 *Comunidades da Ravena* 🌟\n\n`;

	if (zapComunidade) {
		content += `🟢 *WhatsApp (Comunidade Oficial)*\n${zapComunidade}\n\n`;
	}

	if (zapLink) {
		content += `🟢 *WhatsApp (Grupão)*\n${zapLink}\n_Este é o nosso grupo principal de interação!_\n\n`;
	}

	if (telegramLink) {
		content += `🔵 *Telegram*\n${telegramLink}\n\n`;
	}

	if (discordLink) {
		content += `🟣 *Discord*\n${discordLink}\n_Atualmente em fase de testes!_\n\n`;
	}

	content += `_Sinta-se em casa!_ 🐦‍⬛✨\n\n> Ps.: Você pode vincular sua conta do whatsapp da ravena com as outras plataformas enviando !vincular`;

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
		const botName = bot?.nomeExibir || "ravenabot";
		return [
			new ReturnMessage({
				chatId,
				content: `🐦‍⬛ Então você quer a *${botName}* no seu grupo?
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
		content += `🟣 *Comunidade Discord:* ${community}\n_Atualmente em fase de testes!_\n\n`;

	content += `> Ps.: Você pode vincular sua conta do whatsapp da ravena com as outras plataformas enviando !vincular`;

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
	if (community) content += `🔵 *Canal/Comunidade:* ${community}\n\n`;

	content += `> Ps.: Você pode vincular sua conta do whatsapp da ravena com as outras plataformas enviando !vincular`;

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

async function saveGlobalNick(userId, nickname) {
	try {
		return await database.saveGlobalNick(userId, nickname);
	} catch (e) {
		logger.error("Erro ao salvar apelido global:", e.message);
		return false;
	}
}

async function getGlobalNick(userId) {
	try {
		return await database.getGlobalNick(userId);
	} catch (e) {
		logger.error("Erro ao obter apelido global:", e.message);
		return null;
	}
}

/**
 * Resolve o apelido do usuário seguindo a hierarquia estrita:
 * 1. Apelido definido no grupo atual (se em grupo)
 * 2. Apelido global definido no PV da Ravena
 * 3. Último apelido definido pelo usuário em qualquer outro grupo
 * 4. Fallback: nome do WhatsApp (pushName / authorName / "Jogador")
 *
 * @param {Object} [group] - Objeto do grupo atual (opcional)
 * @param {string} userId - ID do usuário (ex: 5511...@c.us ou número puro)
 * @param {string} [fallbackName] - Nome fallback (pushName ou authorName)
 * @returns {Promise<string>}
 */
async function resolveUserNickname(group, userId, fallbackName = null) {
	if (!userId) return fallbackName || "Jogador";
	const cleanUser = String(userId).trim();
	const rawPhone = cleanUser.replace(/\D/g, "");

	// 1. Apelido definido no grupo atual
	if (group && group.nicks && Array.isArray(group.nicks)) {
		const match = group.nicks.find(
			(n) =>
				n.numero === cleanUser || (rawPhone && String(n.numero).replace(/\D/g, "") === rawPhone)
		);
		if (match && match.apelido) {
			return match.apelido;
		}
	}

	// 2. Apelido global (definido no PV)
	const globalNick =
		(await getGlobalNick(cleanUser)) || (rawPhone ? await getGlobalNick(rawPhone) : null);
	if (globalNick) {
		return globalNick;
	}

	// 3. Fallback: último apelido definido em qualquer grupo
	try {
		const groups = await database.getGroups();
		if (Array.isArray(groups)) {
			// Itera do fim para o começo para pegar o mais recente/último
			for (let i = groups.length - 1; i >= 0; i--) {
				const g = groups[i];
				if (g && Array.isArray(g.nicks)) {
					const m = g.nicks.find(
						(n) =>
							n.numero === cleanUser ||
							(rawPhone && String(n.numero).replace(/\D/g, "") === rawPhone)
					);
					if (m && m.apelido) {
						return m.apelido;
					}
				}
			}
		}
	} catch (e) {
		logger.debug("Erro ao buscar apelido em outros grupos:", e.message);
	}

	// 4. Nome no WhatsApp ou ID
	return fallbackName || (rawPhone ? rawPhone : "Jogador");
}

/**
 * Define um apelido para o usuário em um grupo ou globalmente (no PV)
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Mensagem formatada
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} Mensagem de retorno
 */
async function apelidoCommand(bot, message, args, group) {
	try {
		const isPV = !message.group;
		const chatId = isPV ? message.author : group.id;
		const replyOptions = {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		};

		// Fluxo no PV: Gerencia apelido GLOBAL
		if (isPV) {
			if (args.length === 0) {
				const currentGlobal = await getGlobalNick(message.author);
				if (currentGlobal) {
					return new ReturnMessage({
						chatId,
						content: `Seu apelido global atual é: *${currentGlobal}*\n> Este apelido é usado em todos os grupos onde você não definiu um apelido específico.\n> Para alterar: !apelido [novo]\n> Para remover: !apelido remover`,
						options: replyOptions
					});
				} else {
					// Mostra se existe algum apelido em grupo servindo de fallback
					const resolvedFallback = await resolveUserNickname(null, message.author, null);
					const hasGroupFallback =
						resolvedFallback &&
						resolvedFallback !== message.author.replace(/\D/g, "") &&
						resolvedFallback !== "Jogador";
					let msg =
						"Você ainda não definiu um apelido global.\nUse *!apelido [apelido]* para definir um apelido global usado em todos os grupos!";
					if (hasGroupFallback) {
						msg += `\n\n> Atualmente você está herdando o apelido: *${resolvedFallback}* (definido em um de seus grupos).`;
					}
					return new ReturnMessage({
						chatId,
						content: msg,
						options: replyOptions
					});
				}
			}

			let nickname = args.join(" ").trim();
			if (nickname.toLowerCase() === "remover" || nickname.toLowerCase() === "deletar") {
				await saveGlobalNick(message.author, null);
				return new ReturnMessage({
					chatId,
					content: "✅ Apelido global removido com sucesso!",
					options: replyOptions
				});
			}

			if (nickname.length < 2) {
				return new ReturnMessage({
					chatId,
					content: "❌ O apelido deve ter pelo menos 2 caracteres.",
					options: replyOptions
				});
			}

			if (nickname.length > 20) {
				nickname = nickname.substring(0, 20);
			}

			await saveGlobalNick(message.author, nickname);

			return new ReturnMessage({
				chatId,
				content: `👑 Apelido global definido: *${nickname}*\n\n> Ele será usado em todos os grupos onde você não definiu um apelido específico e no seu harém!\n> Para grupos específicos, use !apelido dentro do próprio grupo.`,
				options: replyOptions
			});
		}

		// Fluxo em Grupo: Gerencia apelido LOCAL do grupo
		const psNote = "\n\n> Ps.: Um apelido global pode ser definido no meu pv!";

		if (args.length === 0) {
			const userNick = getUserNickname(group, message.author);
			if (userNick) {
				return new ReturnMessage({
					chatId,
					content: `Seu apelido neste grupo é: *${userNick}*${psNote}`,
					options: replyOptions
				});
			} else {
				const fallbackNick = await resolveUserNickname(null, message.author, null);
				const hasFallback =
					fallbackNick &&
					fallbackNick !== message.author.replace(/\D/g, "") &&
					fallbackNick !== "Jogador";
				let content =
					"Você não tem um apelido específico definido neste grupo.\nUse *!apelido [apelido]* para definir um.";
				if (hasFallback) {
					content += `\n> Apelido ativo herdado: *${fallbackNick}*`;
				}
				content += psNote;
				return new ReturnMessage({
					chatId,
					content,
					options: replyOptions
				});
			}
		}

		let nickname = args.join(" ").trim();
		if (nickname.toLowerCase() === "remover" || nickname.toLowerCase() === "deletar") {
			if (group.nicks) {
				group.nicks = group.nicks.filter((nick) => nick.numero !== message.author);
				await database.saveGroup(group);
			}
			return new ReturnMessage({
				chatId,
				content: `✅ Apelido deste grupo removido! Agora você usará seu apelido global ou nome do WhatsApp.${psNote}`,
				options: replyOptions
			});
		}

		if (nickname.length < 2) {
			return new ReturnMessage({
				chatId,
				content: "O apelido deve ter pelo menos 2 caracteres.",
				options: replyOptions
			});
		}

		if (nickname.length > 20) {
			nickname = nickname.substring(0, 20);
		}

		if (!group.nicks) {
			group.nicks = [];
		}

		const existingIndex = group.nicks.findIndex((nick) => nick.numero === message.author);
		if (existingIndex !== -1) {
			group.nicks[existingIndex].apelido = nickname;
		} else {
			group.nicks.push({
				numero: message.author,
				apelido: nickname
			});
		}

		await database.saveGroup(group);

		return new ReturnMessage({
			chatId,
			content: `Apelido definido: *${nickname}*${psNote}`,
			options: replyOptions
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
				const s = typeof status === "object" && status !== null ? status.status : status;
				if (s === "up") return "🟢";
				if (s === "backup") return "🟠";
				if (s === "down") return "🔴";
				return "⚫";
			};

			servicesHeader = `📡 *Serviços Externos*\n`;
			servicesHeader += `\t${getEmoji(servicesData.whatsgoapi)} WhatsGo _(serviço principal)_\n`;
			servicesHeader += `\t${getEmoji(servicesData.imagine)} Imagine _(geração de imagens)_\n`;
			servicesHeader += `\t${getEmoji(servicesData.llm)} LLM _(inteligência artificial)_\n`;
			servicesHeader += `\t${getEmoji(servicesData.whisper)} Whisper _(voz para texto)_\n`;
			servicesHeader += `\t${getEmoji(servicesData.kokorotts || servicesData.f5tts)} Kokoro-TTS _(texto para voz)_\n`;
			servicesHeader += `\n\n`;
		} catch (e) {
			// Ignora erro se não conseguir ler arquivo de status
		}

		const response = await axios.get(url);

		let statusMessage =
			"🕸 *Status das Ravenas* 🔄\n> ravena.moothz.com/status\n> https://ravena.moothz.com\n\n" +
			servicesHeader;

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

// ============================================================
// !updates — Resumo semanal dos commits dos repositórios
// ============================================================

/**
 * Repositórios exibidos no !updates (edite aqui para incluir/remover projetos).
 * `about` é usado apenas como contexto para o resumo gerado pela IA.
 */
const UPDATES_REPOS = [
	{
		owner: "moothz",
		repo: "ravena-ai",
		emoji: "🐦‍⬛",
		about:
			"o bot ravena (WhatsApp, Telegram e Discord): comandos, jogos, IA, figurinhas, banco e painel web"
	},
	{
		owner: "moothz",
		repo: "waifuletes",
		emoji: "🌸",
		about: "o jogo de gacha e harém de personagens da ravena (comandos !mu-...) e seu site"
	},
	{
		owner: "moothz",
		repo: "jardim-das-sombras",
		emoji: "🦇",
		about: "o minigame de fazenda gótica da ravena (comandos !fazenda e !faz-...) e seu painel web"
	}
];

const UPDATES_DAYS = 7;
const UPDATES_DAY_MS = 24 * 60 * 60 * 1000;
const UPDATES_TIMEZONE = "America/Sao_Paulo";
const UPDATES_CACHE_TTL_MS = 30 * 60 * 1000; // Resultado completo (GitHub + resumos da IA)
const UPDATES_PARTIAL_CACHE_TTL_MS = 5 * 60 * 1000; // Quando algum repositório ou resumo falhou
const UPDATES_HTTP_TIMEOUT_MS = 15 * 1000;
const UPDATES_MAX_PAGES = 3; // Até 300 commits por repositório (100 por página)
const UPDATES_LLM_TIMEOUT_MS = 45 * 1000;
const UPDATES_LLM_INPUT_MAX_CHARS = 6000;
const UPDATES_SUMMARY_MAX_CHARS = 400;
const UPDATES_TITLE_MAX_CHARS = 100;
const UPDATES_BODY_LINE_MAX_CHARS = 90;
const UPDATES_MAX_MESSAGE_CHARS = 5000;
// Níveis de detalhe da listagem: usa o primeiro que couber em UPDATES_MAX_MESSAGE_CHARS
const UPDATES_RENDER_LEVELS = [
	{ maxCommits: 10, maxBodyLines: 2 },
	{ maxCommits: 8, maxBodyLines: 1 },
	{ maxCommits: 6, maxBodyLines: 0 },
	{ maxCommits: 4, maxBodyLines: 0 }
];

const COMMIT_TYPE_EMOJIS = {
	feat: "✨",
	fix: "🐛",
	perf: "⚡",
	refactor: "♻️",
	style: "🎨",
	docs: "📝",
	test: "🧪",
	build: "📦",
	ci: "⚙️",
	chore: "🔧",
	revert: "⏪"
};
// Trailers de commit que não interessam a quem lê (coautoria, assinatura, links de sessão, etc.)
const COMMIT_TRAILER_REGEX =
	/^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|change-id|[\w-]+-session)\s*:/i;
const COMMIT_GENERATED_LINE_REGEX = /^(?:🤖\s*)?generated with\b/iu;
const MERGE_TITLE_REGEX = /^Merge (pull request|branch|remote-tracking branch)\b/i;

const UPDATES_SYSTEM_CONTEXT =
	"Você escreve notas de atualização curtas e amigáveis, em português do Brasil, para usuários de um bot de WhatsApp. Seja direto e factual, sem inventar nada além do que está nos commits.";

const updatesCache = new MemoryCache(UPDATES_CACHE_TTL_MS, 5);
let updatesInFlight = null;

function pluralizeUpdates(count, singular, pluralForm) {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function truncateUpdatesText(text, maxChars) {
	const clean = String(text ?? "").trim();
	if (clean.length <= maxChars) return clean;
	const cut = clean.slice(0, maxChars - 1);
	const lastSpace = cut.lastIndexOf(" ");
	let base = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).replace(
		/[\s,;:.-]+$/,
		""
	);
	// Não deixa um `código` aberto pela metade (quebraria a formatação do WhatsApp)
	if ((base.match(/`/g) ?? []).length % 2 === 1) {
		const lastTick = base.lastIndexOf("`");
		base = base.slice(0, lastTick) + base.slice(lastTick + 1);
	}
	return `${base}…`;
}

function formatUpdatesDay(date) {
	return new Intl.DateTimeFormat("pt-BR", {
		day: "2-digit",
		month: "2-digit",
		timeZone: UPDATES_TIMEZONE
	}).format(date);
}

function formatUpdatesTime(date) {
	return new Intl.DateTimeFormat("pt-BR", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZone: UPDATES_TIMEZONE
	}).format(date);
}

function formatUpdatesDateKey(date) {
	// en-CA gera AAAA-MM-DD
	return new Intl.DateTimeFormat("en-CA", { timeZone: UPDATES_TIMEZONE }).format(date);
}

/**
 * Extrai a URL rel="next" do header Link de paginação do GitHub
 * @param {string} linkHeader
 * @returns {string|null}
 */
function parseNextLink(linkHeader) {
	if (!linkHeader || typeof linkHeader !== "string") return null;
	const match = linkHeader.match(/<([^>]+)>\s*;\s*rel="next"/);
	return match ? match[1] : null;
}

/**
 * Converte as linhas do corpo do commit em itens legíveis: cada tópico (- / * / 1.) ou parágrafo
 * vira um item, juntando as linhas quebradas em 72 colunas e descartando trailers.
 * @param {string[]} lines
 * @returns {string[]}
 */
function extractCommitBodyItems(lines) {
	const items = [];
	let current = null;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (
			!line ||
			/^[-=_*~.]{3,}$/.test(line) ||
			COMMIT_TRAILER_REGEX.test(line) ||
			COMMIT_GENERATED_LINE_REGEX.test(line)
		) {
			current = null;
			continue;
		}

		const bullet = line.match(/^(?:[-*•+]|\d+[.)])\s+(.+)$/);
		if (bullet) {
			current = [bullet[1]];
			items.push(current);
		} else if (current) {
			current.push(line);
		} else {
			current = [line];
			items.push(current);
		}
	}

	return items
		.map((parts) =>
			parts
				.join(" ")
				.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [texto](link) -> texto
				.replace(/\s+/g, " ")
				.trim()
		)
		.filter(Boolean);
}

/**
 * Normaliza um commit da API REST do GitHub
 * @param {Object} raw - Item de GET /repos/{owner}/{repo}/commits
 * @returns {{sha: string, url: string|null, date: Date|null, title: string, body: string[], isMerge: boolean, isBot: boolean}}
 */
function parseGitHubCommit(raw) {
	const message = String(raw?.commit?.message ?? "").replace(/\r\n?/g, "\n");
	const [firstLine = "", ...bodyLines] = message.split("\n");
	const title = firstLine.trim();
	const authorName = raw?.commit?.author?.name ?? "";
	const isBot = /\[bot\]$/i.test(authorName) || /\[bot\]$/i.test(raw?.author?.login ?? "");
	const dateStr = raw?.commit?.author?.date ?? raw?.commit?.committer?.date;
	const date = dateStr ? new Date(dateStr) : null;

	return {
		sha: raw?.sha ?? "",
		url: raw?.html_url ?? null,
		date: date && !isNaN(date.getTime()) ? date : null,
		title,
		// Commits de bots (dependabot etc.) têm corpo gigante e pouco útil: mostra só o título
		body: isBot ? [] : extractCommitBodyItems(bodyLines),
		isMerge:
			(Array.isArray(raw?.parents) && raw.parents.length > 1) || MERGE_TITLE_REGEX.test(title),
		isBot
	};
}

/**
 * Separa tipo/escopo/assunto de títulos no padrão conventional commits (feat(escopo): assunto)
 * @param {string} title
 * @returns {{type: string|null, scope: string|null, subject: string}}
 */
function parseConventionalTitle(title) {
	const match = String(title ?? "").match(/^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/i);
	const type = match?.[1]?.toLowerCase();
	if (!match || !COMMIT_TYPE_EMOJIS[type]) {
		return { type: null, scope: null, subject: title };
	}
	return { type, scope: match[2]?.trim() || null, subject: match[3].trim() };
}

/**
 * Busca os commits de um repositório desde `since` (branch padrão), seguindo a paginação.
 * @param {{owner: string, repo: string}} repoDef
 * @param {Object} [options]
 * @param {Object} [options.http=axios] - Cliente HTTP com método get(url, config) no formato do axios
 * @param {string} [options.since] - Data ISO inicial
 * @param {string} [options.token] - Token do GitHub (opcional, padrão GITHUB_TOKEN)
 * @param {number} [options.maxPages]
 * @param {number} [options.httpTimeoutMs]
 * @returns {Promise<{commits: Object[], truncated: boolean}>}
 */
async function fetchRepoCommits(repoDef, options = {}) {
	const {
		http = axios,
		since = new Date(Date.now() - UPDATES_DAYS * UPDATES_DAY_MS).toISOString(),
		token = process.env.GITHUB_TOKEN,
		maxPages = UPDATES_MAX_PAGES,
		httpTimeoutMs = UPDATES_HTTP_TIMEOUT_MS
	} = options;

	const headers = {
		"User-Agent": "ravena-bot",
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28"
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	let url = `https://api.github.com/repos/${repoDef.owner}/${repoDef.repo}/commits`;
	let params = { since, per_page: 100 };
	const commits = [];
	let pages = 0;

	while (url && pages < maxPages) {
		const response = await http.get(url, { params, headers, timeout: httpTimeoutMs });
		pages++;
		if (!Array.isArray(response?.data)) {
			throw new Error("Resposta inesperada da API do GitHub");
		}
		commits.push(...response.data);
		url = parseNextLink(response.headers?.link);
		params = undefined; // O link "next" já traz since/per_page/page
	}

	return { commits, truncated: Boolean(url) };
}

/**
 * Traduz erros do axios/GitHub para uma frase curta para o usuário
 * @param {Error} error
 * @returns {string}
 */
function describeGitHubError(error) {
	const status = error?.response?.status;
	const remaining = error?.response?.headers?.["x-ratelimit-remaining"];

	if (status === 404) return "repositório não encontrado ou privado";
	if (status === 429 || (status === 403 && String(remaining) === "0")) {
		return "limite de consultas ao GitHub atingido, tente mais tarde";
	}
	if (status === 401) return "token do GitHub inválido";
	if (status) return `o GitHub respondeu com erro HTTP ${status}`;
	if (error?.code === "ECONNABORTED" || /timeout/i.test(error?.message ?? "")) {
		return "o GitHub demorou demais para responder";
	}
	return "falha ao conectar no GitHub";
}

function buildUpdatesSummaryPrompt(repoDef, commits) {
	const entries = [];
	let used = 0;

	for (let i = 0; i < commits.length; i++) {
		const commit = commits[i];
		let entry = `- ${commit.title}`;
		if (commit.body.length > 0) {
			entry += `\n  ${commit.body
				.slice(0, 4)
				.map((item) => truncateUpdatesText(item, 200))
				.join(" | ")}`;
		}
		if (used + entry.length > UPDATES_LLM_INPUT_MAX_CHARS) {
			entries.push(`(+${commits.length - i} commits mais antigos omitidos)`);
			break;
		}
		entries.push(entry);
		used += entry.length + 1;
	}

	return `Repositório ${repoDef.owner}/${repoDef.repo}: ${repoDef.about}.
Commits dos últimos ${UPDATES_DAYS} dias (do mais recente para o mais antigo):
${entries.join("\n")}

Escreva um resumo de 1 a 3 frases curtas (no máximo ${UPDATES_SUMMARY_MAX_CHARS - 50} caracteres) contando o que mudou nesta semana para quem usa o bot ou joga: novidades, correções e melhorias perceptíveis.
- Ignore detalhes puramente técnicos (refatoração, lint, testes, CI, docker, dependências), a não ser que sejam tudo o que foi feito.
- Não use títulos, listas, markdown, hashes de commit, nomes de arquivos nem emojis.
- Responda somente com o resumo, em português do Brasil.`;
}

/**
 * Limpa a resposta da IA para caber em uma linha de citação do WhatsApp.
 * @param {*} response
 * @returns {string|null} - null se a resposta for vazia ou uma mensagem de erro do LLMService
 */
function cleanUpdatesSummary(response) {
	if (typeof response !== "string") return null;

	const text = response
		.split("\n")
		.filter((line) => !/^\s*#{1,6}\s/.test(line)) // Títulos markdown não fazem parte do resumo
		.map((line) => line.replace(/^\s*(?:>\s*|[-*•]\s+)/, "").trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\*\*(.+?)\*\*/g, "*$1*")
		.replace(/^(?:resumo|summary)\s*:\s*/i, "")
		.replace(/^["“](.+)["”]$/, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();

	if (
		text.length < 10 ||
		/^erro\b/i.test(text) ||
		/não foi possível gerar|solicitação cancelada/i.test(text)
	) {
		return null;
	}
	return truncateUpdatesText(text, UPDATES_SUMMARY_MAX_CHARS);
}

/**
 * Gera o resumo de 1-3 frases dos commits com a IA. Nunca lança: retorna null em falha/timeout.
 * @param {Object} repoDef
 * @param {Object[]} commits - Commits normalizados (sem merges)
 * @param {Object} [options]
 * @param {Object} [options.llm] - Instância com getCompletion(options) (padrão LLMService)
 * @param {number} [options.llmTimeoutMs]
 * @returns {Promise<string|null>}
 */
async function summarizeRepoCommits(repoDef, commits, options = {}) {
	if (!commits || commits.length === 0) return null;

	const { llmTimeoutMs = UPDATES_LLM_TIMEOUT_MS } = options;
	let timer = null;

	try {
		const llm = options.llm ?? LLMService.getInstance();
		const response = await Promise.race([
			llm.getCompletion({
				prompt: buildUpdatesSummaryPrompt(repoDef, commits),
				systemContext: UPDATES_SYSTEM_CONTEXT,
				temperature: 0.4,
				priority: 4
			}),
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`tempo limite de ${llmTimeoutMs}ms excedido`)),
					llmTimeoutMs
				);
			})
		]);

		const summary = cleanUpdatesSummary(response);
		if (!summary) {
			logger.warn(`[updates] Resumo inválido da IA para ${repoDef.repo}:`, response);
		}
		return summary;
	} catch (error) {
		logger.warn(`[updates] Falha ao resumir ${repoDef.repo} com IA: ${error.message}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Cabeçalho usado quando a IA não respondeu: contagem de novidades/correções/outros
 * @param {Object[]} commits
 * @returns {string}
 */
function buildUpdatesFallbackSummary(commits) {
	let feats = 0;
	let fixes = 0;
	for (const commit of commits) {
		const { type } = parseConventionalTitle(commit.title);
		if (type === "feat") feats++;
		else if (type === "fix") fixes++;
	}
	const others = commits.length - feats - fixes;

	const parts = [];
	if (feats) parts.push(pluralizeUpdates(feats, "novidade", "novidades"));
	if (fixes) parts.push(pluralizeUpdates(fixes, "correção", "correções"));
	if (others) {
		parts.push(
			feats || fixes
				? pluralizeUpdates(others, "outra mudança", "outras mudanças")
				: pluralizeUpdates(others, "mudança", "mudanças")
		);
	}

	const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}` : parts[0];
	return `${joined} nesta semana.`;
}

/**
 * Busca e resume um repositório. Nunca lança: falhas viram { ok: false, error }.
 * @param {Object} repoDef
 * @param {Object} [options] - Repassado para fetchRepoCommits e summarizeRepoCommits
 * @returns {Promise<Object>}
 */
async function buildRepoUpdates(repoDef, options = {}) {
	let fetched;
	try {
		fetched = await fetchRepoCommits(repoDef, options);
	} catch (error) {
		logger.warn(
			`[updates] Falha ao buscar commits de ${repoDef.owner}/${repoDef.repo}: ${error.message}`
		);
		return { repo: repoDef, ok: false, error: describeGitHubError(error) };
	}

	const parsed = fetched.commits.map(parseGitHubCommit);
	const commits = parsed.filter((commit) => !commit.isMerge);
	const summary = await summarizeRepoCommits(repoDef, commits, options);

	return {
		repo: repoDef,
		ok: true,
		commits,
		mergeCount: parsed.length - commits.length,
		truncated: fetched.truncated,
		summary
	};
}

function formatUpdatesCommitTitle(commit) {
	const date = commit.date ? `\`${formatUpdatesDay(commit.date)}\` ` : "";
	const { type, scope, subject } = parseConventionalTitle(commit.title);
	const emoji = COMMIT_TYPE_EMOJIS[type] ?? "🔹";
	const text = truncateUpdatesText(subject || "(sem mensagem)", UPDATES_TITLE_MAX_CHARS);
	return `${emoji} ${date}${scope ? `*${scope}*: ` : ""}${text}`;
}

/**
 * Formata a seção de um repositório em árvore (├ └ │)
 * @param {Object} result - Retorno de buildRepoUpdates
 * @param {{maxCommits: number, maxBodyLines: number}} level
 * @returns {string}
 */
function formatRepoUpdatesSection(result, level) {
	const { repo } = result;
	const commitsUrl = `https://github.com/${repo.owner}/${repo.repo}/commits`;
	const lines = [];

	if (!result.ok) {
		lines.push(`${repo.emoji} *${repo.repo}*`);
		lines.push(`> ⚠️ Não consegui buscar os commits: ${result.error}.`);
		lines.push(`🔗 ${commitsUrl}`);
		return lines.join("\n");
	}

	const total = result.commits.length;
	const totalLabel = `${total}${result.truncated ? "+" : ""} ${total === 1 ? "commit" : "commits"}`;
	let header = `${repo.emoji} *${repo.repo}* · ${totalLabel}`;
	if (result.mergeCount > 0) {
		header += ` _(+${pluralizeUpdates(result.mergeCount, "merge", "merges")})_`;
	}
	lines.push(header);

	if (total === 0) {
		lines.push(`> Nenhum commit nos últimos ${UPDATES_DAYS} dias.`);
		lines.push(`🔗 ${commitsUrl}`);
		return lines.join("\n");
	}

	lines.push(`> ${result.summary || buildUpdatesFallbackSummary(result.commits)}`);
	lines.push("");

	const shown = result.commits.slice(0, level.maxCommits);
	shown.forEach((commit, index) => {
		const isLastCommit = index === shown.length - 1;
		lines.push(`${isLastCommit ? "└" : "├"} ${formatUpdatesCommitTitle(commit)}`);

		const items = commit.body.slice(0, level.maxBodyLines);
		const hiddenItems = commit.body.length - items.length;
		items.forEach((item, itemIndex) => {
			const isLastItem = itemIndex === items.length - 1;
			const indent = isLastCommit ? "    " : "│   ";
			const suffix = isLastItem && hiddenItems > 0 ? ` _(+${hiddenItems})_` : "";
			lines.push(
				`${indent}${isLastItem ? "└" : "├"} ${truncateUpdatesText(item, UPDATES_BODY_LINE_MAX_CHARS)}${suffix}`
			);
		});
	});

	const remaining = total - shown.length;
	if (remaining > 0) {
		const moreLabel = pluralizeUpdates(remaining, "commit", "commits");
		lines.push(result.truncated ? `_…e mais de ${moreLabel}_` : `_…e mais ${moreLabel}_`);
	}
	lines.push(`🔗 ${commitsUrl}`);

	return lines.join("\n");
}

/**
 * Monta a mensagem final do !updates (pura: sem rede). Reduz o nível de detalhe até caber no limite.
 * @param {Object[]} repoResults - Retornos de buildRepoUpdates
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.maxChars]
 * @returns {string}
 */
function formatUpdatesMessage(repoResults, options = {}) {
	const { now = new Date(), maxChars = UPDATES_MAX_MESSAGE_CHARS } = options;
	const since = new Date(now.getTime() - UPDATES_DAYS * UPDATES_DAY_MS);
	const usedAI = repoResults.some((result) => result.ok && result.summary);

	const header = `📰 *Novidades da semana*\n_Commits de ${formatUpdatesDay(since)} a ${formatUpdatesDay(now)} nos projetos da ravena_`;
	const footer = `> Atualizado em ${formatUpdatesDay(now)} às ${formatUpdatesTime(now)}${usedAI ? " · resumos gerados por IA" : ""}`;

	let content = "";
	for (const level of UPDATES_RENDER_LEVELS) {
		const sections = repoResults.map((result) => formatRepoUpdatesSection(result, level));
		content = [header, ...sections, footer].join("\n\n");
		if (content.length <= maxChars) break;
	}
	return content;
}

/**
 * Busca os repositórios em paralelo, resume com IA e formata. Resultado em cache por ~30 min
 * (5 min se algo falhou) e requisições simultâneas compartilham a mesma busca.
 * @param {Object} [options] - { now, useCache, repos, http, llm, token, ... }
 * @returns {Promise<string>}
 */
async function getUpdatesReport(options = {}) {
	const { now = new Date(), useCache = true, repos = UPDATES_REPOS } = options;
	const cacheKey = `updates:${formatUpdatesDateKey(now)}`;

	if (useCache) {
		const cached = updatesCache.get(cacheKey);
		if (cached) return cached;
		if (updatesInFlight) return updatesInFlight;
	}

	const run = (async () => {
		const since = new Date(now.getTime() - UPDATES_DAYS * UPDATES_DAY_MS).toISOString();
		const results = await Promise.all(
			repos.map((repoDef) => buildRepoUpdates(repoDef, { ...options, since }))
		);
		const content = formatUpdatesMessage(results, { now });

		if (useCache) {
			const complete = results.every(
				(result) => result.ok && (result.commits.length === 0 || result.summary)
			);
			updatesCache.set(
				cacheKey,
				content,
				complete ? UPDATES_CACHE_TTL_MS : UPDATES_PARTIAL_CACHE_TTL_MS
			);
		}
		return content;
	})();

	if (!useCache) return run;

	updatesInFlight = run;
	try {
		return await run;
	} finally {
		updatesInFlight = null;
	}
}

async function updatesCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const content = await getUpdatesReport();
		return new ReturnMessage({ chatId, content });
	} catch (error) {
		logger.error("Erro ao montar o !updates:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Não consegui buscar as atualizações agora. Tente novamente mais tarde."
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
	new Command({
		name: "updates",
		aliases: ["novidades", "atualizacoes", "atualizações"],
		description: "Novidades da semana nos projetos da ravena (resumo + commits)",
		usage: "!updates",
		category: "geral",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📰"
		},
		cooldown: 30,
		method: updatesCommand
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

const helper = {
	about: "Comandos gerais e utilitários essenciais do bot (status, apelido, avisos, etc.)",
	implementation:
		"Obtém métricas do sistema operacional, gerencia apelidos no banco e coordena mensagens de aviso",
	tags: "geral,status,sistema,ping,apelido,avisos,utilidades",
	cmds: [
		{
			cmd: "!status",
			desc: "Exibe o status do bot, tempo online, memória e latência",
			usage: ["!status"],
			category: "geral"
		},
		{
			cmd: "!avisos",
			desc: "Exibe o canal de avisos e novidades da comunidade do bot",
			usage: ["!avisos"],
			category: "geral"
		},
		{
			cmd: "!apelido",
			desc: "Define ou altera o seu apelido de exibição no grupo",
			usage: ["!apelido Moothz", "!apelido Rei do Zap"],
			category: "geral"
		},
		{
			cmd: "!codigo",
			desc: "Exibe o link do repositório de código-fonte do bot",
			usage: ["!codigo"],
			category: "geral"
		},
		{
			cmd: "!updates",
			desc: "Mostra as novidades dos últimos 7 dias nos projetos da ravena (bot, waifuletes e jardim das sombras): resumo feito por IA e lista de commits do GitHub",
			usage: ["!updates", "!novidades"],
			category: "geral"
		},
		{
			cmd: "!atencao",
			desc: "Envia um alerta sonoro/visual para chamar a atenção no chat",
			usage: ["!atencao"],
			category: "geral"
		}
	]
};

module.exports = {
	helper,
	commands,
	getUserNickname,
	resolveUserNickname,
	getGlobalNick,
	saveGlobalNick,
	// !updates (exportados para testes)
	UPDATES_REPOS,
	fetchRepoCommits,
	parseGitHubCommit,
	summarizeRepoCommits,
	buildRepoUpdates,
	formatUpdatesMessage,
	getUpdatesReport
};
