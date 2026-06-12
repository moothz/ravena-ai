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
      media_caption TEXT
    );
`
);

// Diretório para armazenar mídias dos lembretes
const LEMBRETES_MEDIA_DIR = path.join(database.databasePath, "lembretes-media");

/**
 * Garante que os diretórios necessários existam
 */
async function garantirDiretorios() {
	try {
		// Cria diretório de mídia para lembretes se não existir
		await fs.mkdir(LEMBRETES_MEDIA_DIR, { recursive: true });
	} catch (error) {
		logger.error("Erro ao criar diretórios necessários:", error);
	}
}

/**
 * Converte linha do banco para objeto Lembrete
 */
function dbToLembrete(row) {
	return {
		id: row.id,
		chatId: row.chat_id,
		userId: row.user_id,
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
		// Configure o chrono para português brasileiro
		const customChrono = chrono.pt.casual;

		// Tenta interpretar a data do texto
		const results = customChrono.parse(texto, { forwardDate: true });

		if (results.length > 0) {
			const data = results[0].start.date();

			// Se apenas a hora for especificada (sem data), e for antes da hora atual, assume o dia seguinte
			const agora = new Date();
			if (
				results[0].start.impliedValues &&
				results[0].start.impliedValues.day &&
				data.getHours() < agora.getHours()
			) {
				data.setDate(data.getDate() + 1);
			}

			// Se a data for no passado, retorna null
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
		const chatId = message.group ?? message.from;

		// Verifica se há argumentos
		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça uma data/hora para o lembrete. Exemplo: !lembrar amanhã às 10:00"
			});
		}

		// Obtém a mensagem citada
		const quotedMsg = await message.origin.getQuotedMessage();

		if (!quotedMsg) {
			return new ReturnMessage({
				chatId,
				content: "Este comando deve ser usado como resposta a uma mensagem."
			});
		}

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

					// Se a hora já passou hoje, define para amanhã
					if (dataLembrete < new Date()) {
						dataLembrete.setDate(dataLembrete.getDate() + 1);
					}
				}
			}

			// Se ainda não conseguir, tenta usar 7:00 de amanhã como padrão
			if (!dataLembrete && textoData.toLowerCase().includes("amanhã")) {
				dataLembrete = new Date();
				dataLembrete.setDate(dataLembrete.getDate() + 1);
				dataLembrete.setHours(7, 0, 0, 0);
			}

			// Se ainda assim não conseguir, informa o erro
			if (!dataLembrete) {
				return new ReturnMessage({
					chatId,
					content:
						'Não foi possível interpretar a data/hora. Use formatos como "amanhã às 10:00" ou "17/04/2025 07:30".'
				});
			}
		}

		// Gera um ID único para o lembrete
		const lembreteId = gerarId();

		// Cria o objeto do lembrete (estrutura para uso interno)
		const lembrete = {
			id: lembreteId,
			chatId,
			userId: message.author,
			data: dataLembrete.getTime(),
			dataFormatada: formatarData(dataLembrete),
			mensagem:
				quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body ?? quotedMsg._data.body ?? "",
			criadoEm: Date.now(),
			ativo: true,
			hasMedia: false,
			mediaPath: null,
			mediaType: null,
			mediaCaption: null
		};

		// Se a mensagem citada tiver mídia, salva a mídia
		if (quotedMsg.hasMedia) {
			try {
				await garantirDiretorios();
				// Baixa a mídia
				const media = await quotedMsg.downloadMedia();

				// Define o tipo de mídia
				let mediaType = media.mimetype.split("/")[0]; // 'image', 'audio', 'video', etc.
				if (quotedMsg.type === "sticker") mediaType = "sticker";
				if (quotedMsg.type === "voice") mediaType = "voice";

				// Gera nome de arquivo com extensão apropriada
				let fileExt = media.mimetype.split("/")[1];
				if (fileExt && fileExt.includes(";")) {
					fileExt = fileExt.split(";")[0];
				}

				// Cria nome de arquivo único para a mídia
				const fileName = `${lembreteId}.${fileExt || "bin"}`;
				const mediaPath = path.join(LEMBRETES_MEDIA_DIR, fileName);

				// Salva a mídia
				await fs.writeFile(mediaPath, Buffer.from(media.data, "base64"));

				// Atualiza informações do lembrete
				lembrete.hasMedia = true;
				lembrete.mediaPath = fileName;
				lembrete.mediaType = media.mimetype;
				lembrete.mediaCaption = quotedMsg.caption || "";

				logger.info(`Mídia salva para lembrete: ${mediaPath}`);
			} catch (mediaError) {
				logger.error("Erro ao salvar mídia para lembrete:", mediaError);
				// Continua criando o lembrete mesmo sem mídia, mas envia aviso
				return new ReturnMessage({
					chatId,
					content:
						"Não foi possível salvar a mídia para o lembrete. O lembrete será criado apenas com o texto."
				});
			}
		}

		// Salva no banco de dados
		await database.dbRun(
			dbName,
			`
      INSERT INTO lembretes (
        id, chat_id, user_id, data, mensagem, criado_em, ativo, 
        has_media, media_path, media_type, media_caption
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
			[
				lembrete.id,
				lembrete.chatId,
				lembrete.userId,
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

		// Inicia o temporizador para este lembrete
		iniciarTemporizador(bot, lembrete);

		// Retorna mensagem de confirmação
		return new ReturnMessage({
			chatId,
			content: `✅ Lembrete configurado para ${lembrete.dataFormatada} (ID: ${lembrete.id})`
		});
	} catch (error) {
		logger.error("Erro ao criar lembrete:", error);
		const chatId = message.group ?? message.from;
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
		const chatId = message.group ?? message.from;
		const userId = message.author;

		let rows;
		if (!message.group) {
			// Privado: apenas do usuário
			rows = await database.dbAll(
				dbName,
				`
        SELECT * FROM lembretes WHERE user_id = ? AND ativo = 1 ORDER BY data ASC
      `,
				[userId]
			);
		} else {
			// Grupo: do grupo (podemos filtrar por usuário também se quisermos, mas a logica original mostrava todos do grupo)
			// Original: return l.chatId === chatId && l.ativo;
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

		// Converte rows para objetos lembrete
		const lembretesFiltrados = rows.map(dbToLembrete);

		// Constrói a mensagem
		let mensagem = `📅 *Lembretes Ativos:*

`;

		for (const lembrete of lembretesFiltrados) {
			// Calcula tempo restante
			const agora = Date.now();
			const tempoRestante = lembrete.data - agora;
			const dias = Math.floor(tempoRestante / (1000 * 60 * 60 * 24));
			const horas = Math.floor((tempoRestante % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
			const minutos = Math.floor((tempoRestante % (1000 * 60 * 60)) / (1000 * 60));

			let tempoFormatado = "";
			if (dias > 0) tempoFormatado += `${dias}d `;
			if (horas > 0) tempoFormatado += `${horas}h `;
			tempoFormatado += `${minutos}m`;

			// Formata a mensagem do lembrete (limitada a 50 caracteres)
			const mensagemCurta =
				lembrete.mensagem && lembrete.mensagem.length > 50
					? lembrete.mensagem.substring(0, 47) + "..."
					: lembrete.mensagem || "(sem texto)";

			// Adiciona informação se tem mídia
			const temMidia = lembrete.hasMedia ? " 📎" : "";

			mensagem += `*ID:* ${lembrete.id}
`;
			mensagem += `*Data:* ${lembrete.dataFormatada}
`;
			mensagem += `*Tempo restante:* ${tempoFormatado}
`;
			mensagem += `*Mensagem:* ${mensagemCurta}${temMidia}

`;
		}

		mensagem += `Para cancelar um lembrete, use: !l-cancelar <id>`;

		return new ReturnMessage({
			chatId,
			content: mensagem
		});
	} catch (error) {
		logger.error("Erro ao listar lembretes:", error);
		const chatId = message.group ?? message.from;
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
		const chatId = message.group ?? message.from;
		const userId = message.author;

		// Verifica se foi fornecido um ID
		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça o ID do lembrete a ser cancelado. Use !lembretes para ver os IDs."
			});
		}

		const lembreteId = args[0];

		// Busca o lembrete no banco
		const row = await database.dbGet(dbName, `SELECT * FROM lembretes WHERE id = ?`, [lembreteId]);

		if (!row) {
			return new ReturnMessage({
				chatId,
				content: `Lembrete com ID ${lembreteId} não encontrado.`
			});
		}

		const lembrete = dbToLembrete(row);

		// Verifica se o usuário tem permissão para cancelar o lembrete
		if (lembrete.userId !== userId && (!message.group || lembrete.chatId !== chatId)) {
			return new ReturnMessage({
				chatId,
				content: "Você não tem permissão para cancelar este lembrete."
			});
		}

		// Marca como inativo no banco
		await database.dbRun(dbName, `UPDATE lembretes SET ativo = 0 WHERE id = ?`, [lembreteId]);

		// Se tiver mídia, exclui o arquivo
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
		const chatId = message.group ?? message.from;
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
		// Calcula o tempo até o lembrete
		const agora = Date.now();
		const tempoPraDisparar = lembrete.data - agora;

		// Se já passou da hora, não agenda (ou poderia disparar imediatamente?)
		// A lógica original dizia: se já passou, logger warn.
		if (tempoPraDisparar <= 0) {
			logger.warn(
				`Lembrete ${lembrete.id} já expirou (ao iniciar temporizador), será processado na próxima verificação`
			);
			return;
		}

		// Limita o tempo máximo do timer para 24h (JavaScript tem limitações)
		const MAX_TIMER = 24 * 60 * 60 * 1000; // 24 horas em ms

		if (tempoPraDisparar > MAX_TIMER) {
			// Agenda um timer para verificar novamente após 24h
			logger.info(`Lembrete ${lembrete.id} agendado para reavaliação em 24h`);
			setTimeout(() => {
				// Recarrega o lembrete para garantir que ainda está ativo
				verificarLembrete(bot, lembrete.id);
			}, MAX_TIMER);
		} else {
			// Agenda para o tempo exato
			logger.info(
				`Lembrete ${lembrete.id} agendado para disparar em ${formatarTempoRestante(tempoPraDisparar)}`
			);
			setTimeout(() => {
				// Dispara o lembrete
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
		const row = await database.dbGet(dbName, `SELECT * FROM lembretes WHERE id = ? AND ativo = 1`, [
			lembreteId
		]);

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
		const row = await database.dbGet(dbName, `SELECT * FROM lembretes WHERE id = ? AND ativo = 1`, [
			lembreteId
		]);

		if (!row) {
			logger.warn(`Lembrete ${lembreteId} não encontrado ou não está ativo`);
			return;
		}

		const lembrete = dbToLembrete(row);

		// Se o chat for um grupo, verifica se está pausado
		let group = null;
		if (lembrete.chatId.endsWith("@g.us")) {
			// Obtém o grupo do banco de dados (assumindo que existe esse método no Database)
			group = await database.getGroup(lembrete.chatId);

			// Se o grupo estiver pausado, não envia o lembrete
			if (group && group.paused) {
				logger.info(`Ignorando lembrete ${lembreteId} para grupo pausado: ${lembrete.chatId}`);
				return;
			}
		}

		// Formata a mensagem do lembrete
		const textoLembrete = `😴 *LEMBRETE!*

${lembrete.mensagem || ""}`;

		// Usa ReturnMessage para enviar
		let returnMessage;

		// Verifica se tem mídia
		if (lembrete.hasMedia && lembrete.mediaPath) {
			try {
				await garantirDiretorios();
				// Carrega a mídia
				const mediaPath = path.join(LEMBRETES_MEDIA_DIR, lembrete.mediaPath);
				const mediaData = await fs.readFile(mediaPath);

				// Cria objeto de mídia
				const media = {
					mimetype: lembrete.mediaType || "application/octet-stream",
					data: mediaData.toString("base64"),
					filename: lembrete.mediaPath,
					isMessageMedia: true
				};

				// Cria ReturnMessage com mídia
				returnMessage = new ReturnMessage({
					chatId: lembrete.chatId,
					content: media,
					options: {
						caption: textoLembrete
					}
				});

				// Envia a mensagem
				await bot.sendReturnMessages(returnMessage, group);

				// Exclui o arquivo de mídia após enviar
				try {
					await fs.unlink(mediaPath);
				} catch (unlinkError) {
					logger.error("Erro ao excluir mídia do lembrete após envio:", unlinkError);
				}
			} catch (mediaError) {
				logger.error("Erro ao enviar mídia do lembrete:", mediaError);
				// Se falhar, envia apenas o texto
				returnMessage = new ReturnMessage({
					chatId: lembrete.chatId,
					content: `${textoLembrete}\n\n_(Não foi possível enviar a mídia)_`
				});

				await bot.sendReturnMessages(returnMessage, group);
			}
		} else {
			// Envia apenas o texto
			returnMessage = new ReturnMessage({
				chatId: lembrete.chatId,
				content: textoLembrete
			});

			await bot.sendReturnMessages(returnMessage, group);
		}

		logger.info(`Lembrete ${lembreteId} disparado com sucesso`);
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
		needsQuotedMsg: true,
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

// Ao carregar o módulo, inicia temporizadores para lembretes ativos
// NOTA: Movido para inicializarLembretes para garantir que o bot esteja pronto e não cause problemas no require
// Mas se precisarmos de inicialização no require, podemos manter a logica de limpeza

(async () => {
	// Apenas garante diretórios
	await garantirDiretorios();
})();

module.exports = {
	commands,
	// Exporta funções úteis para uso externo
	inicializarLembretes: async (bot) => {
		try {
			await garantirDiretorios();

			// Carrega lembretes ativos
			const rows = await database.dbAll(dbName, `SELECT * FROM lembretes WHERE ativo = 1`);

			logger.info(`Inicializando ${rows.length} lembretes para o bot`);

			for (const row of rows) {
				const lembrete = dbToLembrete(row);

				// Verifica se já passou da hora
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
