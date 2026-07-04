const path = require("path");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const chrono = require("chrono-node");
const Database = require("../utils/Database");

const database = Database.getInstance();
const logger = new Logger("horoscopo-commands");
const DB_NAME = "horoscopo";

// Initialize Database
database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS horoscopo (
    data TEXT,
    signo TEXT,
    texto TEXT,
    PRIMARY KEY (data, signo)
  );
`
);

const signos = {
	áries: { emoji: "♈", nome: "Áries" },
	aries: { emoji: "♈", nome: "Áries" },
	touro: { emoji: "♉", nome: "Touro" },
	gêmeos: { emoji: "♊", nome: "Gêmeos" },
	gemeos: { emoji: "♊", nome: "Gêmeos" },
	câncer: { emoji: "♋", nome: "Câncer" },
	cancer: { emoji: "♋", nome: "Câncer" },
	leão: { emoji: "♌", nome: "Leão" },
	leao: { emoji: "♌", nome: "Leão" },
	virgem: { emoji: "♍", nome: "Virgem" },
	libra: { emoji: "♎", nome: "Libra" },
	escorpião: { emoji: "♏", nome: "Escorpião" },
	escorpiao: { emoji: "♏", nome: "Escorpião" },
	sagitário: { emoji: "♐", nome: "Sagitário" },
	sagitario: { emoji: "♐", nome: "Sagitário" },
	capricórnio: { emoji: "♑", nome: "Capricórnio" },
	capricornio: { emoji: "♑", nome: "Capricórnio" },
	aquário: { emoji: "♒", nome: "Aquário" },
	aquario: { emoji: "♒", nome: "Aquário" },
	peixes: { emoji: "♓", nome: "Peixes" }
};

const orderedSignos = [
	"áries",
	"touro",
	"gêmeos",
	"câncer",
	"leão",
	"virgem",
	"libra",
	"escorpião",
	"sagitário",
	"capricórnio",
	"aquário",
	"peixes"
];

/**
 * Normaliza o nome de um signo para uma chave consistente
 * @param {string} signo - Nome do signo a ser normalizado
 * @returns {string|null} - Nome do signo normalizado em minúsculas ou null
 */
function normalizeSigno(signo) {
	if (!signo) return null;
	const normalized = signo.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
	return signos[normalized] ? signos[normalized].nome.toLowerCase() : null;
}

/**
 * Detecta e salva o horóscopo de uma mensagem
 * @param {string} msgBody - Corpo da mensagem
 * @param {string} groupId - ID do grupo
 * @returns {Promise<boolean>} - Se a mensagem foi detectada e salva
 */
async function detectHoroscopo(msgBody, groupId) {
	try {
		if (typeof msgBody !== "string") {
			logger.info("Newsletter não é horóscopo");
			return false;
		}
		const gruposHoroscopo = (process.env.GRUPOS_HOROSCOPOS ?? "").split(",");
		if (gruposHoroscopo.includes(groupId) && gruposHoroscopo.length > 0) {
			logger.info(`Horoscopo detectado em grupo oficial`);
		}

		const horoscopoRegex =
			/(?:♈|♉|♊|♋|♌|♍|♎|♏|♐|♑|♒|♓)\s+(Áries|Touro|Gêmeos|Câncer|Leão|Virgem|Libra|Escorpião|Sagitário|Capricórnio|Aquário|Peixes)[:*]*\s+([\s\S]*?)(?:\n\n|$)/gi;
		const matches = [...(msgBody?.matchAll(horoscopoRegex) || [])];

		if (matches.length > 0) {
			let savedCount = 0;
			for (const match of matches) {
				const signoNome = match[1];
				const texto = match[2].trim();
				const signoNormalizado = normalizeSigno(signoNome);

				if (signoNormalizado) {
					const today = new Date();
					const year = today.getFullYear();
					const month = String(today.getMonth() + 1).padStart(2, "0");
					const day = String(today.getDate()).padStart(2, "0");
					const date = `${year}-${month}-${day}`;

					await database.dbRun(
						DB_NAME,
						"INSERT OR REPLACE INTO horoscopo (data, signo, texto) VALUES (?, ?, ?)",
						[date, signoNormalizado, texto]
					);
					savedCount++;
				}
			}

			if (savedCount > 0) {
				logger.info(`${savedCount} horóscopos salvos no banco.`);
				return true;
			}
		}

		return false;
	} catch (error) {
		logger.info("Newsletter não é horóscopo");
		return false;
	}
}

/**
 * Obtém o horóscopo para um signo e/ou data
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Mensagem recebida
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Objeto do grupo
 * @returns {Promise<ReturnMessage>} - Mensagem de retorno
 */
async function horoscopoCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		let signoQuery = null;
		let dateExpression = "hoje";

		if (args.length === 1) {
			// Tenta interpretar o único argumento como data. Se falhar, é um signo.
			const parsedDateAsDate = chrono.pt.parse(args[0], new Date(), { forwardDate: false });
			if (parsedDateAsDate && parsedDateAsDate.length > 0) {
				dateExpression = args[0];
			} else {
				signoQuery = args[0];
			}
		} else if (args.length > 1) {
			signoQuery = args[0];
			dateExpression = args.slice(1).join(" ");
		}

		const parsedDate = chrono.pt.parse(dateExpression, new Date(), { forwardDate: false });
		if (!parsedDate || parsedDate.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `❌ Data não reconhecida. Tente usar formatos como "hoje", "ontem", "31/10/2025".`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		const resultDate = parsedDate[0].start.date();
		const year = resultDate.getFullYear();
		const month = String(resultDate.getMonth() + 1).padStart(2, "0");
		const day = String(resultDate.getDate()).padStart(2, "0");
		const date = `${year}-${month}-${day}`;
		const formattedDate = `${day}/${month}/${year}`;

		// Get from DB
		const rows = await database.dbAll(
			DB_NAME,
			"SELECT signo, texto FROM horoscopo WHERE data = ?",
			[date]
		);
		const horoscoposDoDia = {};
		rows.forEach((row) => {
			horoscoposDoDia[row.signo] = row.texto;
		});

		if (rows.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `😴 Nenhum horóscopo encontrado para ${formattedDate}.`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		const signoAlvo = normalizeSigno(signoQuery);
		let responseText = `🔮 *Horóscopo para ${formattedDate}*

`;
		let showAll = false;

		if (signoAlvo) {
			const texto = horoscoposDoDia[signoAlvo];
			if (texto) {
				const signoInfo = signos[signoAlvo];
				responseText += `${signoInfo.emoji} *${signoInfo.nome}:* ${texto}`;
			} else {
				responseText += `Não encontrei o horóscopo para *${signoQuery}* nesta data. Mostrando todos os disponíveis:\n\n`;
				showAll = true;
			}
		} else {
			showAll = true;
		}

		if (showAll) {
			let foundAny = false;
			for (const nome of orderedSignos) {
				const texto = horoscoposDoDia[nome];
				if (texto) {
					foundAny = true;
					const signoInfo = signos[nome];
					responseText += `${signoInfo.emoji} *${signoInfo.nome}:* ${texto}\n\n`;
				}
			}
			if (!foundAny) {
				return new ReturnMessage({
					chatId,
					content: `😴 Nenhum horóscopo encontrado para ${formattedDate}.`,
					options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
				});
			}
		}

		return new ReturnMessage({
			chatId,
			content: responseText.trim(),
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	} catch (error) {
		logger.error("Erro ao executar comando horoscopo:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Ocorreu um erro ao buscar o horóscopo.",
			reaction: "❌"
		});
	}
}

const commands = [
	new Command({
		name: "horoscopo",
		description: "Exibe o horóscopo para um signo e/ou data específica.",
		usage: "!horoscopo [signo] [data]",
		category: "utilidades",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "✨",
			error: "❌"
		},
		method: horoscopoCommand
	}),
	new Command({
		name: "horóscopo",
		hidden: true,
		description: "Exibe o horóscopo para um signo e/ou data específica.",
		usage: "!horoscopo [signo] [data]",
		category: "utilidades",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "✨",
			error: "❌"
		},
		method: horoscopoCommand
	}),
	new Command({
		name: "signo",
		hidden: true,
		description: "Exibe o horóscopo para um signo e/ou data específica.",
		usage: "!horoscopo [signo] [data]",
		category: "utilidades",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "✨",
			error: "❌"
		},
		method: horoscopoCommand
	})
];

module.exports = {
	commands,
	detectHoroscopo
};
