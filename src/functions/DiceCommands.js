const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");

const logger = new Logger("dice-commands");

//logger.info('Módulo DiceCommands carregado');

// Regex para reconhecer padrões de dados
// Exemplos: d20, 2d6, d20+5, 3d8-2, etc.
const DICE_REGEX = /^(\d*)d(\d+)([+-]\d+)?$/i;

// Emojis para resultados especiais
const EMOJI_CRITICAL_SUCCESS = "✨";
const EMOJI_CRITICAL_FAIL = "💀";
const EMOJI_NORMAL_RESULT = "🎲";

// Limite de dados para prevenir abuso
const MAX_DICE = 20;
const MAX_SIDES = 1000;

// Lista de comandos
const commands = [];

/**
 * Gera um número aleatório entre min e max (inclusivo)
 * @param {number} min - Valor mínimo
 * @param {number} max - Valor máximo
 * @returns {number} - Número aleatório gerado
 */
function getRandomInt(min, max) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Rola um dado com o padrão especificado
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @param {number} defaultSides - Número padrão de lados (opcional)
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessage
 */
async function rollDice(bot, message, args, group, defaultSides = null) {
	try {
		const chatId = message.group ?? message.author;
		let dicePattern, numDice, numSides, modifier, modifierValue, modifierSign;

		// Verifica se foi invocado por um comando predefinido (d20, d6, etc.)
		if (defaultSides) {
			// Determina número de dados e modificador dos argumentos
			numDice = args.length > 0 && !isNaN(parseInt(args[0])) ? parseInt(args[0]) : 1;
			numSides = defaultSides;

			// Procura por modificador adicional (+5, -2, etc.)
			modifier = args.find((arg) => /^[+++-]+d+$/i.test(arg));

			if (modifier) {
				modifierSign = modifier[0];
				modifierValue = parseInt(modifier.substring(1));
			}
		} else {
			// Foi invocado com um padrão completo (2d6+3)
			dicePattern = args.length > 0 ? args[0] : "d20";

			// Verifica se o padrão é válido
			const match = DICE_REGEX.exec(dicePattern);

			if (!match) {
				return new ReturnMessage({
					chatId,
					content: "Formato inválido. Use algo como: d20, 2d6, d8+3, 3d10-2",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			}

			// Extrai componentes do padrão
			numDice = match[1] ? parseInt(match[1]) : 1;
			numSides = parseInt(match[2]);

			// Processa modificador se existir
			if (match[3]) {
				modifierSign = match[3][0];
				modifierValue = parseInt(match[3].substring(1));
			}
		}

		// Array para armazenar mensagens de retorno
		const returnMessages = [];

		// Verifica limites para evitar spam/abuso
		if (numDice > MAX_DICE) {
			returnMessages.push(
				new ReturnMessage({
					chatId,
					content: `⚠️ Número máximo de dados é ${MAX_DICE}.`,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				})
			);
			numDice = MAX_DICE;
		}

		if (numSides > MAX_SIDES) {
			returnMessages.push(
				new ReturnMessage({
					chatId,
					content: `⚠️ Número máximo de faces é ${MAX_SIDES}.`,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				})
			);
			numSides = MAX_SIDES;
		}

		if (numDice < 1) numDice = 1;
		if (numSides < 2) numSides = 2;

		// Rola os dados
		const rolls = [];
		let total = 0;

		for (let i = 0; i < numDice; i++) {
			const roll = getRandomInt(1, numSides);
			rolls.push(roll);
			total += roll;
		}

		// Aplica modificador se existir
		if (modifierSign && modifierValue) {
			if (modifierSign === "+") {
				total += modifierValue;
			} else if (modifierSign === "-") {
				total -= modifierValue;
			}
		}

		// Determina sucesso/falha crítica para d20
		let resultEmoji = EMOJI_NORMAL_RESULT;
		let criticalText = "";

		if (numSides === 20 && numDice === 1) {
			if (rolls[0] === 20) {
				resultEmoji = EMOJI_CRITICAL_SUCCESS;
				criticalText = " (Sucesso Crítico!)";
			} else if (rolls[0] === 1) {
				resultEmoji = EMOJI_CRITICAL_FAIL;
				criticalText = " (Falha Crítica!)";
			}
		}

		// Prepara mensagem
		let resultMessage = "";

		// Casos especiais para mensagens mais limpas
		if (numDice === 1 && !modifierSign) {
			// Caso simples: um único dado sem modificador
			resultMessage = `${resultEmoji} *${rolls[0]}*${criticalText} (d${numSides})`;
		} else if (numDice === 1 && modifierSign) {
			// Um único dado com modificador
			resultMessage = `${resultEmoji} *${total}*${criticalText} [${rolls[0]} ${modifierSign}${modifierValue}] (d${numSides}${modifierSign}${modifierValue})`;
		} else {
			// Múltiplos dados
			let formula = `${numDice}d${numSides}`;
			if (modifierSign && modifierValue) {
				formula += `${modifierSign}${modifierValue}`;
			}

			// Adiciona detalhes dos rolls
			resultMessage = `${resultEmoji} *${total}*${criticalText} [${rolls.join(" + ")}`;
			if (modifierSign && modifierValue) {
				resultMessage += ` ${modifierSign} ${modifierValue}`;
			}
			resultMessage += `] (${formula})`;
		}

		// Verifica se o usuário tem apelido/nome customizado
		let userName = "Jogador";
		try {
			userName =
				message.name ?? message.pushName ?? message.pushname ?? message.authorName ?? "Jogador";

			// Verifica se existe nome personalizado no grupo
			if (group && group.nicks) {
				const userNick = group.nicks.find((n) => n.numero === message.author);
				if (userNick && userNick.apelido) {
					userName = userNick.apelido;
				}
			}
		} catch (error) {
			logger.error("Erro ao obter nome do usuário:", error);
		}

		// Adiciona o nome da pessoa na mensagem
		resultMessage = `${userName} rolou:+n${resultMessage}`;

		// Adiciona mensagem principal ao array de retorno
		returnMessages.push(
			new ReturnMessage({
				chatId,
				content: resultMessage,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			})
		);

		// Se tiver mensagens adicionais (avisos de limite), retorna array de mensagens
		// Caso contrário, retorna apenas a mensagem principal
		return returnMessages.length > 1 ? returnMessages : returnMessages[0];
	} catch (error) {
		logger.error("Erro ao rolar dados:", error);

		const chatId = message.group ?? message.author;
		return new ReturnMessage({
			chatId,
			content: "❌ Erro ao rolar dados. Por favor, tente novamente.",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
}

// Registra dinamicamente os comandos d4, d6, d8, d10, d12, d20, d100
const COMMON_DICE = [4, 6, 8, 10, 12, 20, 100];

for (const sides of COMMON_DICE) {
	commands.push(
		new Command({
			name: `d${sides}`,
			category: "jogos",
			group: "dices",
			description: `Rola um dado de X faces`,
			reactions: {
				before: process.env.LOADING_EMOJI ?? "⌛️",
				after: "🎲"
			},
			method: async (bot, message, args, group) => await rollDice(bot, message, args, group, sides)
		})
	);
}

// Comando especial para manipular qualquer padrão
commands.push(
	new Command({
		name: "roll",
		description: "Rola dados com padrão customizado (ex: 2d6+3)",
		category: "jogos",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🎲"
		},
		method: async (bot, message, args, group) => await rollDice(bot, message, args, group)
	})
);

// Registra os comandos sendo exportados
//logger.debug(`Exportando ${commands.length} comandos:`, commands.map(cmd => cmd.name));

module.exports = { commands };
