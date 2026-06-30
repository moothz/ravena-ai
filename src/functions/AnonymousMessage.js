const path = require("path");
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");

const logger = new Logger("anonymous-message");
const database = Database.getInstance();
const DB_NAME = "anon_msgs";

// Initialize Database
database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS anon_msgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT,
    target_group_name TEXT,
    timestamp INTEGER,
    message TEXT,
    json_data TEXT
  );
`
);

const LLMService = require("../services/LLMService");
const llmService = LLMService.getInstance();

// Constantes
const COOLDOWN_HOURS = 2;
const COOLDOWN_MS = COOLDOWN_HOURS * 60 * 60 * 1000; // Cooldown em milissegundos

/**
 * Obtém as mensagens anônimas armazenadas (Limitado a 100 para compatibilidade se necessário, mas melhor usar queries específicas)
 * @returns {Promise<Array>} - Lista de mensagens anônimas
 */
async function getAnonMessages() {
	try {
		const rows = await database.dbAll(
			DB_NAME,
			"SELECT json_data FROM anon_msgs ORDER BY timestamp DESC LIMIT 100"
		);
		return rows.map((r) => JSON.parse(r.json_data));
	} catch (error) {
		logger.error("Erro ao carregar mensagens anônimas:", error);
		return [];
	}
}

/**
 * Verifica o cooldown de um usuário
 * @param {string} userId - ID do usuário
 * @param {string} targetGroup - Nome do grupo alvo
 * @returns {Promise<object>} - Objeto com status e tempo restante em horas
 */
async function checkUserCooldown(userId, targetGroup) {
	try {
		const row = await database.dbGet(
			DB_NAME,
			"SELECT timestamp FROM anon_msgs WHERE sender_id = ? AND target_group_name = ? ORDER BY timestamp DESC LIMIT 1",
			[userId, targetGroup]
		);

		if (!row) {
			return { onCooldown: false, timeLeft: 0 };
		}

		const now = Date.now();
		const timeSinceLastMessage = now - row.timestamp;

		if (timeSinceLastMessage < COOLDOWN_MS) {
			const timeLeft = Math.ceil((COOLDOWN_MS - timeSinceLastMessage) / (1000 * 60 * 60));
			return { onCooldown: true, timeLeft };
		}

		return { onCooldown: false, timeLeft: 0 };
	} catch (error) {
		logger.error("Erro ao verificar cooldown:", error);
		return { onCooldown: false, timeLeft: 0 };
	}
}

function cleanId(id) {
	return id.split("@")[0].split(":")[0];
}

/**
 * Envia uma mensagem anônima para um grupo
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} Mensagem de retorno
 */
async function anonymousMessage(bot, message, args, group) {
	try {
		//logger.debug(`[anonymousMessage] `, {message, group, args});
		// Verifica o ID do remetente
		const senderIds = [
			cleanId(message.author),
			cleanId(message?.origin?.key?.remoteJidAlt ?? "-"),
			cleanId(message?.origin?.key?.remoteJid ?? "-"),
			cleanId(message?.origin?.Info?.SenderAlt ?? "-"),
			cleanId(message?.origin?.Info?.Sender ?? "-")
		];

		// Verifica se há argumentos suficientes
		if (args.length < 2) {
			return new ReturnMessage({
				chatId: senderIds[0],
				content: `⚠️ Formato incorreto. Use: !anonimo ${group?.name ?? "nomegrupo"} mensagem\n\nExemplo: !anonimo ${group?.name ?? "nomegrupo"} Olá, esta é uma mensagem anônima!\n\nO 'nomegrupo' é o que aparece na segunda linha do comando *!cmd*, se não souber, envie !cmd dentro do grupo. O administrador pode trocar este nome usando o comando !g-setNome novonome.`
			});
		}

		// Obtém o ID do grupo alvo
		const targetGroupName = args[0].trim().toLowerCase();

		// Verifica cooldown
		const cooldownCheck = await checkUserCooldown(senderIds[0], targetGroupName);
		if (cooldownCheck.onCooldown) {
			return new ReturnMessage({
				chatId: senderIds[0],
				content: `⌛️ Você precisa esperar ${cooldownCheck.timeLeft} hora(s) para enviar outra mensagem anônima.`
			});
		}

		// Obtém a mensagem a ser enviada
		let anonymousText = args.slice(1).join(" ");

		let anonimize = false; // Muito ruim, DESATIVADO
		if (args[1].toLowerCase() === "original") {
			// Se a primeira palavra for 'original', não anonimiza com LLM
			anonimize = false;
			anonymousText = args.slice(2).join(" ");
		}

		// Verifica se a mensagem é muito curta
		if (anonymousText.length < 5) {
			return new ReturnMessage({
				chatId: senderIds[0],
				content: "⚠️ A mensagem é muito curta. Por favor, escreva algo mais substancial."
			});
		}

		// Obtém todos os grupos para verificar o alvo
		const groups = await database.getGroups();

		// Encontra o grupo pelo nome ou ID
		const targetGroup = groups.find(
			(g) =>
				(g.name && g.name.trim().toLowerCase() === targetGroupName) ||
				(g.id && g.id.toLowerCase().includes(targetGroupName))
		);

		if (!targetGroup) {
			return new ReturnMessage({
				chatId: senderIds[0],
				content: `❌ Grupo "${targetGroupName}" não encontrado. Verifique o nome e tente novamente.`
			});
		}

		// Verifica se o comando ou categoria está silenciado no grupo alvo
		if (targetGroup.mutedCategories && Array.isArray(targetGroup.mutedCategories)) {
			if (targetGroup.mutedCategories.includes("jogos")) {
				return new ReturnMessage({
					chatId: senderIds[0],
					content: `❌ A categoria de jogos (que inclui mensagens anônimas) está desativada no grupo "${targetGroup.name}".`
				});
			}
		}

		if (targetGroup.mutedCommands && Array.isArray(targetGroup.mutedCommands)) {
			if (targetGroup.mutedCommands.includes("anonimo")) {
				return new ReturnMessage({
					chatId: senderIds[0],
					content: `❌ O comando de mensagens anônimas está desativado no grupo "${targetGroup.name}".`
				});
			}
		}

		// Verifica se o grupo existe e se o bot está no grupo
		try {
			const chat = await bot.client.getChatById(targetGroup.id);

			// Verifica se o usuário está no grupo (OBRIGATÓRIO)
			const participants = await chat.participants;
			const isUserInGroup = participants.some((p) =>
				senderIds.some((sI) => p.id._serialized.startsWith(sI) || p.phoneNumber?.startsWith(sI))
			);

			//logger.debug(`[anonimo] `,{message, participants, senderIds, isUserInGroup});

			if (!isUserInGroup) {
				return new ReturnMessage({
					chatId: senderIds[0],
					content: `❌ Você não é membro do grupo "${targetGroup.name}". Apenas membros podem enviar mensagens anônimas para este grupo.`
				});
			}
		} catch (error) {
			logger.error("Erro ao verificar grupo ou participantes:", error);
			return new ReturnMessage({
				chatId: senderIds[0],
				content: `❌ Não foi possível acessar o grupo. O bot pode não estar mais nele ou o grupo foi excluído.`
			});
		}

		// Registra a mensagem anônima
		const now = Date.now();

		let anonimizedMessage = null;
		try {
			if (anonimize) {
				anonimizedMessage = await llmService.getCompletion({
					prompt: `Reescreva esta frase em portugues adequado, removendo vícios de linguagens, gírias e idiomas. A mensagem deve ser anonimizada, não sendo possível identificar a pessoa que enviou a mesma. ((Retorne APENAS a frase solicitada. Se não for possível, retorne o texto original, ((nunca)) retorne mensagens de erro e otros detalhes)). Texto para processar:\n"${anonymousText}"`,
					priority: 0
				});
				if (anonimizedMessage.includes("original não pode ser")) {
					anonimizedMessage = anonymousText;
				}
			} else {
				anonimizedMessage = anonymousText;
			}
		} catch (e) {
			logger.error(`[anonymousMessage] Não consegui deixar a mensagem anonima, usando a original.`);
			anonimizedMessage = anonymousText;
		}

		// Objeto da mensagem
		const msgObj = {
			senderId: senderIds[0],
			targetGroupId: targetGroup.id,
			targetGroupName: targetGroup.name,
			message: anonymousText,
			anonimizedMessage,
			timestamp: now
		};

		// Salva no banco de dados
		try {
			await database.dbRun(
				DB_NAME,
				`
        INSERT INTO anon_msgs (sender_id, target_group_name, timestamp, message, json_data)
        VALUES (?, ?, ?, ?, ?)
      `,
				[
					msgObj.senderId,
					msgObj.targetGroupName,
					msgObj.timestamp,
					msgObj.message,
					JSON.stringify(msgObj)
				]
			);
		} catch (dbError) {
			logger.error("Erro ao salvar mensagem anônima no banco:", dbError);
		}

		// Envia a mensagem para o grupo alvo
		try {
			// Formata a mensagem anônima
			const formattedMessage = `👻 *Um membro anônimo enviou:*

> ${anonimizedMessage ?? anonymousText}`;

			// Envia para o grupo alvo
			await bot.sendMessage(targetGroup.id, formattedMessage);

			// Confirma o envio para o remetente
			return new ReturnMessage({
				chatId: senderIds[0],
				content: `✅ Sua mensagem anônima foi enviada com sucesso para o grupo "${targetGroup.name}".\n\nVocê poderá enviar outra mensagem anônima em ${COOLDOWN_HOURS} horas.`
			});
		} catch (error) {
			logger.error("Erro ao enviar mensagem anônima:", error);

			return new ReturnMessage({
				chatId: senderIds[0],
				content: `❌ Erro ao enviar mensagem anônima: ${error.message}`
			});
		}
	} catch (error) {
		logger.error("Erro no comando de mensagem anônima:", error);

		return new ReturnMessage({
			chatId: message.author,
			content: "❌ Ocorreu um erro ao processar sua solicitação. Por favor, tente novamente."
		});
	}
}

/**
 * Adiciona comandos administrativos para gerenciar mensagens anônimas
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @returns {Promise<ReturnMessage>} Mensagem de retorno
 */
async function adminAnonMessages(bot, message, args) {
	try {
		// Verifica se é um administrador do bot
		const isAdmin = await bot.isAdmin(message.author);
		if (!isAdmin) {
			return new ReturnMessage({
				chatId: message.author,
				content: `⛔ Apenas administradores podem usar este comando.`
			});
		}

		if (args.length === 0 || args[0] === "list") {
			// Lista as últimas 10 mensagens anônimas
			const anonMessages = await getAnonMessages(); // Already limits to 100, we slice 10.

			if (anonMessages.length === 0) {
				return new ReturnMessage({
					chatId: message.author,
					content: `📝 Não há mensagens anônimas registradas.`
				});
			}

			const lastMessages = anonMessages
				.slice(0, 10) // First 10 (since ordered DESC)
				.map((msg, index) => {
					const date = new Date(msg.timestamp).toLocaleString("pt-BR");
					return `*${index + 1}.* De: ${msg.senderId}\nPara: ${msg.targetGroupName}\nData: ${date}\nMensagem: "${msg.message}"`;
				})
				.join("\n\n");

			return new ReturnMessage({
				chatId: message.author,
				content: `📝 *Últimas mensagens anônimas:*

${lastMessages}`
			});
		} else if (args[0] === "clear") {
			// Limpa todas as mensagens anônimas
			await database.dbRun(DB_NAME, "DELETE FROM anon_msgs");

			return new ReturnMessage({
				chatId: message.author,
				content: `🧹 Todas as mensagens anônimas foram removidas.`
			});
		} else if (args[0] === "find" && args.length > 1) {
			// Busca mensagens por ID do usuário
			const userId = args[1];
			const rows = await database.dbAll(
				DB_NAME,
				`SELECT json_data FROM anon_msgs WHERE sender_id LIKE ? ORDER BY timestamp DESC LIMIT 5`,
				[`%${userId}%`]
			);
			const userMessages = rows.map((r) => JSON.parse(r.json_data));

			if (userMessages.length === 0) {
				return new ReturnMessage({
					chatId: message.author,
					content: `🔍 Nenhuma mensagem encontrada para o usuário ${userId}.`
				});
			}

			const formattedMessages = userMessages
				.map((msg, index) => {
					const date = new Date(msg.timestamp).toLocaleString("pt-BR");
					return `*${index + 1}.* Para: ${msg.targetGroupName}\nData: ${date}\nMensagem: "${msg.message}"`;
				})
				.join("\n\n");

			return new ReturnMessage({
				chatId: message.author,
				content: `🔍 *Mensagens do usuário ${userId}:*

${formattedMessages}`
			});
		}

		// Instruções para o comando
		return new ReturnMessage({
			chatId: message.author,
			content:
				`📋 *Comandos disponíveis:*

` +
				`!adminanon list - Lista as últimas mensagens anônimas
` +
				`!adminanon find [id] - Busca mensagens por ID do usuário
` +
				`!adminanon clear - Remove todas as mensagens anônimas`
		});
	} catch (error) {
		logger.error("Erro no comando adminAnon:", error);

		return new ReturnMessage({
			chatId: message.author,
			content: "❌ Ocorreu um erro ao processar sua solicitação."
		});
	}
}

// Criar comandos
const commands = [
	new Command({
		name: "anonimo",
		description: "Envia uma mensagem anônima para um grupo",
		category: "jogos",
		cooldown: 0, // O cooldown é gerenciado internamente
		reactions: {
			before: "👻",
			after: "📨",
			error: "❌"
		},
		method: anonymousMessage
	}),
	new Command({
		name: "anônimo",
		description: "Envia uma mensagem anônima para um grupo",
		category: "jogos",
		hidden: true,
		cooldown: 0, // O cooldown é gerenciado internamente
		reactions: {
			before: "👻",
			after: "📨",
			error: "❌"
		},
		method: anonymousMessage
	}),
	new Command({
		name: "adminanon",
		description: "Gerencia mensagens anônimas (apenas admin)",
		category: "admin",
		hidden: true,
		cooldown: 0,
		reactions: {
			before: "🔍",
			after: "📋",
			error: "❌"
		},
		method: adminAnonMessages
	})
];

module.exports = { commands };
