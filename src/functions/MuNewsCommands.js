const path = require("path");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const chrono = require("chrono-node");
const Database = require("../utils/Database");

const database = Database.getInstance();
const logger = new Logger("munews-commands");
const DB_NAME = "munews";

// Initialize Database
database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS munews (
    data TEXT PRIMARY KEY,
    news TEXT
  );
`,
	true
);

/**
 * Extrai a data de uma string no formato "dd de mês de yyyy"
 * @param {string} text - Texto para extrair data
 * @returns {string|boolean} - Data no formato YYYY-MM-DD ou false se não encontrada
 */
function extractDate(text) {
	const regex = /(\d{1,2})\s+de\s+([\wÇç]+)\s+de\s+(\d{4})/i;
	const match = text?.match(regex);

	if (match) {
		const [, day, month, year] = match;
		const monthMap = {
			janeiro: "01",
			fevereiro: "02",
			março: "03",
			marco: "03",
			abril: "04",
			maio: "05",
			junho: "06",
			julho: "07",
			agosto: "08",
			setembro: "09",
			outubro: "10",
			novembro: "11",
			dezembro: "12"
		};

		const formattedMonth = monthMap[month.toLowerCase()];
		const formattedDay = day.padStart(2, "0");

		return `${year}-${formattedMonth}-${formattedDay}`;
	}

	return false;
}

/**
 * Detecta e salva MuNews
 * @param {string} msgBody - Corpo da mensagem
 * @param {string} groupId - ID do grupo
 * @returns {Promise<boolean>} - Se a mensagem foi detectada e salva como MuNews
 */
async function detectNews(msgBody, groupId) {
	try {
		if (typeof msgBody !== "string") {
			logger.info("Newsletter não é um munews");
			return false;
		}
		const mensagem = msgBody.toLowerCase();

		// Verifica se a mensagem atende aos critérios para ser uma MuNews
		if (mensagem.length > 5000) {
			const header = mensagem.substring(0, 200).toLowerCase();

			if (header.includes("vinimunews")) {
				const data = extractDate(header);

				if (data) {
					// Verifica se já existe uma entrada para essa data
					const existing = await database.dbGet(DB_NAME, "SELECT 1 FROM munews WHERE data = ?", [
						data
					]);

					if (existing) {
						logger.info(`MuNews para data ${data} já existe, ignorando`);
						return false;
					}

					// Salva o conteúdo da mensagem no banco
					await database.dbRun(DB_NAME, "INSERT INTO munews (data, news) VALUES (?, ?)", [
						data,
						msgBody
					]);
					logger.info(
						`MuNews salva com sucesso para data ${data}, detectado em grupo '${groupId}'`
					);

					// Se a MuNews for detectada de um grupo específico definido em .env, informa o grupo
					if (
						process.env.GRUPO_MUNEWS &&
						process.env.GRUPO_MUNEWS.length > 0 &&
						process.env.GRUPO_MUNEWS === groupId
					) {
						logger.info(`MuNews detectada do grupo oficial`);
					}

					return true;
				}
			}
		}

		return false;
	} catch (error) {
		logger.info("Newsletter não é um munews");
		return false;
	}
}

/**
 * Obtém todas as datas de MuNews disponíveis do banco de dados
 * @returns {Promise<Array<string>>} - Array de datas no formato YYYY-MM-DD, ordenadas cronologicamente
 */
async function getAllNewsDates() {
	try {
		const rows = await database.dbAll(DB_NAME, "SELECT data FROM munews ORDER BY data ASC");
		return rows.map((row) => row.data);
	} catch (error) {
		logger.error("Erro ao obter datas de MuNews:", error);
		return [];
	}
}

async function getStringMunewsDisponiveis() {
	// Obtém todas as datas de MuNews disponíveis
	const allDates = await getAllNewsDates();

	// Formata primeira e última data para a mensagem de erro
	let primeiraNews = "";
	let ultimaNews = "";

	if (allDates.length > 0) {
		// Formata a primeira data (YYYY-MM-DD para DD/MM/YYYY)
		const [firstYear, firstMonth, firstDay] = allDates[0].split("-");
		primeiraNews = `${firstDay}/${firstMonth}/${firstYear}`;

		// Formata a última data (YYYY-MM-DD para DD/MM/YYYY)
		const [lastYear, lastMonth, lastDay] = allDates[allDates.length - 1].split("-");
		ultimaNews = `${lastDay}/${lastMonth}/${lastYear}`;
	}

	return `A MuNews mais antiga que tenho é ${primeiraNews} e a mais recente ${ultimaNews}. Nem todas as datas tiveram MuNews.`;
}

/**
 * Obtém MuNews para uma data específica
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Mensagem recebida
 * @param {Array} args - Argumentos do comando (pode conter a data)
 * @param {Object} group - Objeto do grupo
 * @returns {Promise<ReturnMessage>} - Mensagem de retorno
 */
async function newsCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		// Define a data (padrão: hoje)
		let date;

		if (args.length > 0) {
			// Junta os argumentos para formar a expressão de data
			const dateExpression = args.join(" ");

			// Usa o chrono para interpretar a data em linguagem natural
			const parsedDate = chrono.pt.parse(dateExpression, new Date(), { forwardDate: false });

			if (parsedDate && parsedDate.length > 0) {
				// Se chrono conseguiu interpretar a data
				const resultDate = parsedDate[0].start.date();
				const year = resultDate.getFullYear();
				const month = String(resultDate.getMonth() + 1).padStart(2, "0");
				const day = String(resultDate.getDate()).padStart(2, "0");
				date = `${year}-${month}-${day}`;
			} else {
				// Tenta os formatos anteriores como fallback

				// Verifica se é uma data no formato YYYY-MM-DD
				const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
				if (dateRegex.test(dateExpression)) {
					date = dateExpression;
				} else {
					// Tenta extrair data no formato "dd de mês de yyyy"
					const extractedDate = extractDate(dateExpression);
					if (extractedDate) {
						date = extractedDate;
					} else {
						const stringDatasDisponiveis = await getStringMunewsDisponiveis();
						// Formato de data inválido
						return new ReturnMessage({
							chatId,
							content: `❌ Formato de data não reconhecido. Tente usar formatos como "hoje", "ontem", "segunda-feira passada", "19/04/2025" ou "YYYY-MM-DD".\n\n${stringDatasDisponiveis}`,
							options: {
								quotedMessageId: message.origin.id._serialized,
								goReply: message.origin
							}
						});
					}
				}
			}
		} else {
			// Usa a data atual se nenhum argumento for fornecido
			const today = new Date();
			const year = today.getFullYear();
			const month = String(today.getMonth() + 1).padStart(2, "0");
			const day = String(today.getDate()).padStart(2, "0");
			date = `${year}-${month}-${day}`;
		}

		// Busca no banco de dados
		const row = await database.dbGet(DB_NAME, "SELECT news FROM munews WHERE data = ?", [date]);

		if (row) {
			return new ReturnMessage({
				chatId,
				content: row.news,
				reaction: "📰",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		} else {
			// News não encontrada
			const formattedDate = date.split("-").reverse().join("/");
			const stringDatasDisponiveis = await getStringMunewsDisponiveis();

			return new ReturnMessage({
				chatId,
				content: `ℹ️ *MuNews não encontrada para ${formattedDate}*\n\nAs MuNews geralmente chegam entre 06:00 e 7:30 da manhã. Tente novamente mais tarde ou verifique a data informada.\n\n${stringDatasDisponiveis}`,
				reaction: "😴",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}
	} catch (error) {
		logger.error("Erro ao executar comando news:", error);

		return new ReturnMessage({
			chatId,
			content: "❌ Ocorreu um erro ao buscar as MuNews. Por favor, tente novamente mais tarde.",
			reaction: "❌"
		});
	}
}

// Criação dos comandos
const commands = [
	new Command({
		name: "news",
		description: "Exibe as MuNews para uma data específica (padrão: hoje)",
		usage: "!news [YYYY-MM-DD]",
		category: "utilidades",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📰",
			error: "❌"
		},
		method: newsCommand
	})
];

// Exporta o módulo
module.exports = {
	commands,
	detectNews
};
