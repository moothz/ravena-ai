const fs = require("fs").promises;
const path = require("path");
const chrono = require("chrono-node");

const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("lembretes-commands");
const database = Database.getInstance();
const dbName = "lembretes";

// Rastreia os temporizadores agendados em memória por (botId + ":" + lembreteId)
const scheduledTimers = new Set();

// Initialize database
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS lembretes (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      data INTEGER NOT NULL,
      mensagem TEXT,
      criado_em INTEGER NOT NULL,
      ativo INTEGER DEFAULT 1,
      has_media INTEGER DEFAULT 0,
      media_path TEXT,
      media_type TEXT,
      media_caption TEXT,
      bot_id TEXT
    );
`
);

// Garantir coluna bot_id em bancos de dados já existentes
database.dbRun(dbName, "ALTER TABLE lembretes ADD COLUMN bot_id TEXT;").catch(() => {});

// Diretório para armazenar mídias dos lembretes
const LEMBRETES_MEDIA_DIR = path.join(database.databasePath, "lembretes-media");

/**
 * Garante que os diretórios necessários existam
 */
async function garantirDiretorios() {
	try {
		await fs.mkdir(LEMBRETES_MEDIA_DIR, { recursive: true });
	} catch (error) {
		logger.error("Erro ao criar diretórios necessários:", error);
	}
}

/**
 * Extrai texto de mensagem citada de forma segura (evita salvar [object Object])
 */
function getQuotedText(quotedMsg) {
	if (!quotedMsg) return "";
	if (typeof quotedMsg.caption === "string" && quotedMsg.caption) return quotedMsg.caption;
	if (typeof quotedMsg.body === "string" && quotedMsg.body) return quotedMsg.body;
	if (typeof quotedMsg.content === "string" && quotedMsg.content) return quotedMsg.content;
	if (quotedMsg._data && typeof quotedMsg._data.body === "string" && quotedMsg._data.body) {
		return quotedMsg._data.body;
	}
	return "";
}

/**
 * Converte linha do banco para objeto Lembrete
 */
function dbToLembrete(row) {
	return {
		id: row.id,
		chatId: row.chat_id,
		userId: row.user_id,
		botId: row.bot_id,
		data: row.data,
		dataFormatada: formatarData(new Date(row.data)),
		mensagem: row.mensagem,
		criadoEm: row.criado_em,
		ativo: !!row.ativo,
		hasMedia: !!row.has_media,
		mediaPath: row.media_path,
		mediaType: row.media_type,
		mediaCaption: row.media_caption
	};
}

/**
 * Gera um ID único para lembretes
 * @returns {string} - ID único
 */
function gerarId() {
	return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

/**
 * Interpreta a data/hora de um lembrete
 * @param {string} texto - Texto que contém a data
 * @returns {Date|null} - Data interpretada ou null se não for possível interpretar
 */
function interpretarData(texto) {
	try {
		const customChrono = chrono.pt.casual;
		const results = customChrono.parse(texto, { forwardDate: true });

		if (results.length > 0) {
			const data = results[0].start.date();
			const agora = new Date();

			if (
				results[0].start.impliedValues &&
				results[0].start.impliedValues.day &&
				data.getHours() < agora.getHours()
			) {
				data.setDate(data.getDate() + 1);
			}

			if (data < new Date()) {
				return null;
			}

			return data;
		}

		return null;
	} catch (error) {
		logger.error("Erro ao interpretar data:", error);
		return null;
	}
}

/**
 * Formata uma data para exibição amigável
 * @param {Date} data - A data a ser formatada
 * @returns {string} - String formatada da data
 */
function formatarData(data) {
	try {
		const options = {
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit"
		};

		return data.toLocaleDateString("pt-BR", options);
	} catch (error) {
		logger.error("Erro ao formatar data:", error);
		return data.toString();
	}
}

/**
 * Cria um novo lembrete
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com resposta
 */
async function criarLembrete(bot, message, args, group) {
	try {
		const botId = bot.id || bot.name || "default";
		const chatId = message.group || (group && group.id) || message.from;

		// Verifica se há argumentos
		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça uma data/hora para o lembrete. Exemplo: !lembrar amanhã às 10:00"
			});
		}

		// Tenta obter a mensagem citada
		const quotedMsg = await message.origin.getQuotedMessage().catch(() => null);

		// Obtém o texto do argumento para interpretar a data
		const textoData = args.join(" ");
		let dataLembrete = interpretarData(textoData);

		// Se não conseguir interpretar a data, ou for no passado
		if (!dataLembrete) {
			// Se apenas a hora for fornecida, tenta definir para hoje
			if (textoData.match(/^\d{1,2}(:|h)\d{2}$/)) {
				const [hora, minuto] = textoData
					.replace("h", ":")
					.split(":")
					.map((n) => parseInt(n));
				if (hora >= 0 && hora < 24 && minuto >= 0 && minuto < 60) {
					dataLembrete = new Date();
					dataLembrete.setHours(hora, minuto, 0, 0);

					if (dataLembrete < new Date()) {
						dataLembrete.setDate(dataLembrete.getDate() + 1);
					}
				}
			}

			if (!dataLembrete && textoData.toLowerCase().includes("amanhã")) {
				dataLembrete = new Date();
				dataLembrete.setDate(dataLembrete.getDate() + 1);
				dataLembrete.setHours(7, 0, 0, 0);
			}

			if (!dataLembrete) {
				return new ReturnMessage({
					chatId,
					content:
						'Não foi possível interpretar a data/hora. Use formatos como "amanhã às 10:00" ou "17/04/2025 07:30".'
				});
			}
		}

		// Extrai mensagem do quotedMsg ou dos argumentos
		let mensagemTexto = getQuotedText(quotedMsg);
		if (!mensagemTexto) {
			const chronoMatch = chrono.pt.casual.parse(textoData, { forwardDate: true });
			if (chronoMatch && chronoMatch.length > 0) {
				const matchedText = chronoMatch[0].text;
				const resto = textoData.replace(matchedText, "").trim();
				if (resto) {
					mensagemTexto = resto;
				}
			}
		}

		// Gera ID único para o lembrete
		const lembreteId = gerarId();

		const lembrete = {
			id: lembreteId,
			chatId,
			userId: message.author,
			botId,
			data: dataLembrete.getTime(),
			dataFormatada: formatarData(dataLembrete),
			mensagem: mensagemTexto,
			criadoEm: Date.now(),
			ativo: true,
			hasMedia: false,
			mediaPath: null,
			mediaType: null,
			mediaCaption: null
		};

		// Se a mensagem citada tiver mídia, salva a mídia
		if (quotedMsg && quotedMsg.hasMedia) {
			try {
				await garantirDiretorios();
				const media = await quotedMsg.downloadMedia();

				if (media) {
					let mediaType = media.mimetype ? media.mimetype.split("/")[0] : "media";
					if (quotedMsg.type === "sticker") mediaType = "sticker";
					if (quotedMsg.type === "voice") mediaType = "voice";

					let fileExt = media.mimetype ? media.mimetype.split("/")[1] : "bin";
					if (fileExt && fileExt.includes(";")) {
						fileExt = fileExt.split(";")[0];
					}

					const fileName = `${lembreteId}.${fileExt || "bin"}`;
					const mediaPath = path.join(LEMBRETES_MEDIA_DIR, fileName);

					await fs.writeFile(mediaPath, Buffer.from(media.data, "base64"));

					lembrete.hasMedia = true;
					lembrete.mediaPath = fileName;
					lembrete.mediaType = media.mimetype;
					lembrete.mediaCaption = quotedMsg.caption || "";

					logger.info(`Mídia salva para lembrete: ${mediaPath}`);
				}
			} catch (mediaError) {
				logger.error("Erro ao salvar mídia para lembrete:", mediaError);
			}
		}

		// Salva no banco de dados incluindo bot_id
		await database.dbRun(
			dbName,
			`
      INSERT INTO lembretes (
        id, chat_id, user_id, bot_id, data, mensagem, criado_em, ativo, 
        has_media, media_path, media_type, media_caption
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
			[
				lembrete.id,
				lembrete.chatId,
				lembrete.userId,
				lembrete.botId,
				lembrete.data,
				lembrete.mensagem,
				lembrete.criadoEm,
				lembrete.ativo ? 1 : 0,
				lembrete.hasMedia ? 1 : 0,
				lembrete.mediaPath,
				lembrete.mediaType,
				lembrete.mediaCaption
			]
		);

		// Inicia temporizador para esta instância
		iniciarTemporizador(bot, lembrete);

		return new ReturnMessage({
			chatId,
			content: `✅ Lembrete configurado para ${lembrete.dataFormatada} (ID: ${lembrete.id})`
		});
	} catch (error) {
		logger.error("Erro ao criar lembrete:", error);
		const chatId = message.group || (group && group.id) || message.from;
		return new ReturnMessage({
			chatId,
			content: "Erro ao criar lembrete. Por favor, tente novamente."
		});
	}
}

/**
 * Lista os lembretes ativos
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com lista de lembretes
 */
async function listarLembretes(bot, message, args, group) {
	try {
		const chatId = message.group || (group && group.id) || message.from;
		const userId = message.author;
		const botId = bot.id || bot.name || "default";

		let rows;
		if (!message.group) {
			// Privado: apenas do usuário
			rows = await database.dbAll(
				dbName,
				`
        SELECT * FROM lembretes WHERE user_id = ? AND ativo = 1 AND (bot_id = ? OR bot_id IS NULL OR bot_id = '') ORDER BY data ASC
      `,
				[userId, botId]
			);
		} else {
			// Grupo: do grupo
			rows = await database.dbAll(
				dbName,
				`
        SELECT * FROM lembretes WHERE chat_id = ? AND ativo = 1 ORDER BY data ASC
      `,
				[chatId]
			);
		}

		if (!rows || rows.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Não há lembretes ativos."
			});
		}

		const lembretesFiltrados = rows.map(dbToLembrete);

		let mensagem = `📅 *Lembretes Ativos:*\n\n`;

		for (const lembrete of lembretesFiltrados) {
			const agora = Date.now();
			const tempoRestante = lembrete.data - agora;
			const dias = Math.floor(tempoRestante / (1000 * 60 * 60 * 24));
			const horas = Math.floor((tempoRestante % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
			const minutos = Math.floor((tempoRestante % (1000 * 60 * 60)) / (1000 * 60));

			let tempoFormatado = "";
			if (dias > 0) tempoFormatado += `${dias}d `;
			if (horas > 0) tempoFormatado += `${horas}h `;
			tempoFormatado += `${minutos}m`;

			const mensagemCurta =
				lembrete.mensagem && lembrete.mensagem.length > 50
					? lembrete.mensagem.substring(0, 47) + "..."
					: lembrete.mensagem || "(sem texto)";

			const temMidia = lembrete.hasMedia ? " 📎" : "";

			mensagem += `*ID:* ${lembrete.id}\n`;
			mensagem += `*Data:* ${lembrete.dataFormatada}\n`;
			mensagem += `*Tempo restante:* ${tempoFormatado}\n`;
			mensagem += `*Mensagem:* ${mensagemCurta}${temMidia}\n\n`;
		}

		mensagem += `Para cancelar um lembrete, use: !l-cancelar <id>`;

		return new ReturnMessage({
			chatId,
			content: mensagem
		});
	} catch (error) {
		logger.error("Erro ao listar lembretes:", error);
		const chatId = message.group || (group && group.id) || message.from;
		return new ReturnMessage({
			chatId,
			content: "Erro ao listar lembretes. Por favor, tente novamente."
		});
	}
}

/**
 * Cancela um lembrete por ID
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com resposta
 */
async function cancelarLembrete(bot, message, args, group) {
	try {
		const chatId = message.group || (group && group.id) || message.from;
		const userId = message.author;

		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça o ID do lembrete a ser cancelado. Use !lembretes para ver os IDs."
			});
		}

		const lembreteId = args[0];
		const row = await database.dbGet(dbName, `SELECT * FROM lembretes WHERE id = ?`, [lembreteId]);

		if (!row) {
			return new ReturnMessage({
				chatId,
				content: `Lembrete com ID ${lembreteId} não encontrado.`
			});
		}

		const lembrete = dbToLembrete(row);

		if (lembrete.userId !== userId && (!message.group || lembrete.chatId !== chatId)) {
			return new ReturnMessage({
				chatId,
				content: "Você não tem permissão para cancelar este lembrete."
			});
		}

		await database.dbRun(dbName, `UPDATE lembretes SET ativo = 0 WHERE id = ?`, [lembreteId]);

		if (lembrete.hasMedia && lembrete.mediaPath) {
			try {
				await fs.unlink(path.join(LEMBRETES_MEDIA_DIR, lembrete.mediaPath));
			} catch (unlinkError) {
				logger.error("Erro ao excluir mídia do lembrete:", unlinkError);
			}
		}

		return new ReturnMessage({
			chatId,
			content: `✅ Lembrete com ID ${lembreteId} foi cancelado.`
		});
	} catch (error) {
		logger.error("Erro ao cancelar lembrete:", error);
		const chatId = message.group || (group && group.id) || message.from;
		return new ReturnMessage({
			chatId,
			content: "Erro ao cancelar lembrete. Por favor, tente novamente."
		});
	}
}

/**
 * Inicia temporizador para um lembrete
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} lembrete - O objeto do lembrete
 */
function iniciarTemporizador(bot, lembrete) {
	try {
		const botId = bot.id || bot.name || "default";
		const timerKey = `${botId}:${lembrete.id}`;

		if (scheduledTimers.has(timerKey)) {
			logger.debug(`Temporizador para ${timerKey} já agendado nesta instância.`);
			return;
		}

		// Se o lembrete pertence a outro bot especificamente, não agende nesta instância
		if (lembrete.botId && lembrete.botId !== botId) {
			return;
		}

		const agora = Date.now();
		const tempoPraDisparar = lembrete.data - agora;

		if (tempoPraDisparar <= 0) {
			logger.warn(`Lembrete ${lembrete.id} já expirou (ao iniciar temporizador), desativando`);
			database.dbRun(dbName, `UPDATE lembretes SET ativo = 0 WHERE id = ?`, [lembrete.id]);
			return;
		}

		const MAX_TIMER = 24 * 60 * 60 * 1000;
		scheduledTimers.add(timerKey);

		if (tempoPraDisparar > MAX_TIMER) {
			logger.info(`Lembrete ${lembrete.id} agendado para reavaliação em 24h para bot ${botId}`);
			setTimeout(() => {
				scheduledTimers.delete(timerKey);
				verificarLembrete(bot, lembrete.id);
			}, MAX_TIMER);
		} else {
			logger.info(
				`Lembrete ${lembrete.id} agendado para disparar em ${formatarTempoRestante(tempoPraDisparar)} para bot ${botId}`
			);
			setTimeout(() => {
				scheduledTimers.delete(timerKey);
				dispararLembrete(bot, lembrete.id);
			}, tempoPraDisparar);
		}
	} catch (error) {
		logger.error(`Erro ao iniciar temporizador para lembrete ${lembrete.id}:`, error);
	}
}

/**
 * Formata o tempo restante de forma legível
 * @param {number} ms - Tempo em milissegundos
 * @returns {string} - Tempo formatado
 */
function formatarTempoRestante(ms) {
	const segundos = Math.floor(ms / 1000);
	const minutos = Math.floor(segundos / 60);
	const horas = Math.floor(minutos / 60);
	const dias = Math.floor(horas / 24);

	if (dias > 0) {
		return `${dias} dias e ${horas % 24} horas`;
	} else if (horas > 0) {
		return `${horas} horas e ${minutos % 60} minutos`;
	} else if (minutos > 0) {
		return `${minutos} minutos e ${segundos % 60} segundos`;
	} else {
		return `${segundos} segundos`;
	}
}

/**
 * Verifica se um lembrete ainda está ativo e reconfigura o temporizador
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {string} lembreteId - ID do lembrete
 */
async function verificarLembrete(bot, lembreteId) {
	try {
		const botId = bot.id || bot.name || "default";
		const row = await database.dbGet(
			dbName,
			`SELECT * FROM lembretes WHERE id = ? AND ativo = 1 AND (bot_id = ? OR bot_id IS NULL OR bot_id = '')`,
			[lembreteId, botId]
		);

		if (row) {
			const lembrete = dbToLembrete(row);
			iniciarTemporizador(bot, lembrete);
		}
	} catch (error) {
		logger.error(`Erro ao verificar lembrete ${lembreteId}:`, error);
	}
}

/**
 * Dispara um lembrete
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {string} lembreteId - ID do lembrete
 */
async function dispararLembrete(bot, lembreteId) {
	try {
		const botId = bot.id || bot.name || "default";

		// Atualização atômica: desativa o lembrete antes do envio para evitar disparo duplicado/spam.
		const result = await database.dbRun(
			dbName,
			`UPDATE lembretes SET ativo = 0 WHERE id = ? AND ativo = 1 AND (bot_id = ? OR bot_id IS NULL OR bot_id = '')`,
			[lembreteId, botId]
		);

		if (!result || result.changes === 0) {
			logger.info(`Lembrete ${lembreteId} já foi disparado, desativado ou pertence a outro bot.`);
			return;
		}

		const row = await database.dbGet(dbName, `SELECT * FROM lembretes WHERE id = ?`, [lembreteId]);
		if (!row) {
			logger.warn(`Lembrete ${lembreteId} não encontrado após reivindicação.`);
			return;
		}

		const lembrete = dbToLembrete(row);

		// Se o chat for um grupo, verifica se está pausado
		let group = null;
		if (lembrete.chatId.endsWith("@g.us")) {
			group = await database.getGroup(lembrete.chatId);
			if (group && group.paused) {
				logger.info(`Ignorando lembrete ${lembreteId} para grupo pausado: ${lembrete.chatId}`);
				return;
			}
		}

		// Se for em grupo, inclui menção ao criador do lembrete
		let mentionUser = "";
		const mentions = [];
		if (lembrete.chatId.endsWith("@g.us") && lembrete.userId) {
			const numOnly = lembrete.userId.split("@")[0];
			mentionUser = `@${numOnly} `;
			mentions.push(lembrete.userId);
		}

		const textoLembrete = `😴 *LEMBRETE!* ${mentionUser}\n\n${lembrete.mensagem || ""}`;

		let returnMessage;

		if (lembrete.hasMedia && lembrete.mediaPath) {
			try {
				await garantirDiretorios();
				const mediaPath = path.join(LEMBRETES_MEDIA_DIR, lembrete.mediaPath);
				const mediaData = await fs.readFile(mediaPath);

				const media = {
					mimetype: lembrete.mediaType || "application/octet-stream",
					data: mediaData.toString("base64"),
					filename: lembrete.mediaPath,
					isMessageMedia: true
				};

				returnMessage = new ReturnMessage({
					chatId: lembrete.chatId,
					content: media,
					options: {
						caption: textoLembrete,
						mentions
					}
				});

				await bot.sendReturnMessages(returnMessage, group);

				try {
					await fs.unlink(mediaPath);
				} catch (unlinkError) {
					logger.error("Erro ao excluir mídia do lembrete após envio:", unlinkError);
				}
			} catch (mediaError) {
				logger.error("Erro ao enviar mídia do lembrete:", mediaError);
				returnMessage = new ReturnMessage({
					chatId: lembrete.chatId,
					content: `${textoLembrete}\n\n_(Não foi possível enviar a mídia)_`,
					options: { mentions }
				});

				await bot.sendReturnMessages(returnMessage, group);
			}
		} else {
			returnMessage = new ReturnMessage({
				chatId: lembrete.chatId,
				content: textoLembrete,
				options: { mentions }
			});

			await bot.sendReturnMessages(returnMessage, group);
		}

		logger.info(`Lembrete ${lembreteId} disparado com sucesso pelo bot ${botId}`);
	} catch (error) {
		logger.error(`Erro ao disparar lembrete ${lembreteId}:`, error);
	}
}

// Comandos utilizando a classe Command
const commands = [
	new Command({
		name: "lembretes",
		description: "Lista os lembretes ativos",
		category: "utilidades",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📋"
		},
		method: listarLembretes
	}),
	new Command({
		name: "lembrar",
		description: "Configura um lembrete para uma data específica",
		category: "utilidades",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "😴"
		},
		needsQuotedMsg: false,
		method: criarLembrete
	}),

	new Command({
		name: "l-cancelar",
		description: "Cancela um lembrete por ID",
		category: "utilidades",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🗑"
		},
		method: cancelarLembrete
	})
];

(async () => {
	await garantirDiretorios();
})();

const helper = {
	about: "Sistema de agendamento de lembretes e alertas temporizados",
	implementation:
		"Parser de linguagem natural com chrono-node para datas/horas, agendamento de timers e persistência em SQLite",
	tags: "lembrete,lembrar,alarme,agenda,tempo,notificacao",
	cmds: [
		{
			cmd: "!lembrar",
			desc: "Cria um novo lembrete com data, hora ou tempo relativo",
			usage: ["!lembrar em 10 minutos tirar o lixo", "!lembrar amanha as 14h reuniao importante"],
			category: "utilidades"
		},
		{
			cmd: "!lembretes",
			desc: "Lista todos os seus lembretes ativos",
			usage: ["!lembretes"],
			category: "utilidades"
		},
		{
			cmd: "!l-cancelar",
			desc: "Cancela um lembrete ativo pelo ID",
			usage: ["!l-cancelar 42"],
			category: "utilidades"
		}
	]
};

module.exports = {
	helper,
	commands,
	inicializarLembretes: async (bot) => {
		try {
			await garantirDiretorios();

			const botId = bot.id || bot.name || "default";

			// Carrega lembretes ativos para esta instância de bot (ou sem bot_id definido)
			const rows = await database.dbAll(
				dbName,
				`SELECT * FROM lembretes WHERE ativo = 1 AND (bot_id = ? OR bot_id IS NULL OR bot_id = '')`,
				[botId]
			);

			logger.info(`Inicializando ${rows.length} lembretes para o bot ${botId}`);

			for (const row of rows) {
				// Se bot_id estiver nulo no banco, atribui ao primeiro bot que inicializar para evitar duplicidade
				if (!row.bot_id) {
					await database.dbRun(dbName, `UPDATE lembretes SET bot_id = ? WHERE id = ?`, [
						botId,
						row.id
					]);
					row.bot_id = botId;
				}

				const lembrete = dbToLembrete(row);

				if (lembrete.data <= Date.now()) {
					logger.info(`Lembrete ${lembrete.id} já expirou, marcando como inativo`);
					await database.dbRun(dbName, `UPDATE lembretes SET ativo = 0 WHERE id = ?`, [
						lembrete.id
					]);
				} else {
					iniciarTemporizador(bot, lembrete);
				}
			}
		} catch (error) {
			logger.error("Erro ao inicializar lembretes para o bot:", error);
		}
	}
};
