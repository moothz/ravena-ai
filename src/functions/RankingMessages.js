const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");
const database = Database.getInstance();

const logger = new Logger("ranking-messages");
const dbName = "msgranking";

// Initialize database
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS ranking (
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      message_count INTEGER DEFAULT 0,
      reaction_count INTEGER DEFAULT 0,
      last_message_at INTEGER,
      PRIMARY KEY (chat_id, user_id)
    )`
);

// Migrações: Adiciona colunas se não existirem
database
	.dbRun(dbName, "ALTER TABLE ranking ADD COLUMN reaction_count INTEGER DEFAULT 0")
	.catch(() => {
		// Ignora erro se a coluna já existir
	});

database.dbRun(dbName, "ALTER TABLE ranking ADD COLUMN last_message_at INTEGER").catch(() => {
	// Ignora erro se a coluna já existir
});

/**
 * Atualiza o ranking de mensagens para um usuário
 * @param {string} chatId - ID do chat (grupo ou PV)
 * @param {string} userId - ID do usuário
 * @param {string} userName - Nome do usuário
 * @param {number} [timestamp] - Timestamp do evento
 */
async function updateMessageCount(chatId, userId, userName, timestamp) {
	try {
		const now = timestamp || Date.now();
		await database.dbRun(
			dbName,
			`
      INSERT INTO ranking (chat_id, user_id, user_name, message_count, reaction_count, last_message_at)
      VALUES (?, ?, ?, 1, 0, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        message_count = message_count + 1,
        user_name = excluded.user_name,
        last_message_at = excluded.last_message_at
    `,
			[chatId, userId, userName, now]
		);
	} catch (error) {
		logger.error("Erro ao atualizar contagem de mensagens (SQLite):", error);
	}
}

/**
 * Atualiza o ranking de reações para um usuário
 * @param {string} chatId - ID do chat
 * @param {string} userId - ID do usuário
 * @param {string} userName - Nome do usuário
 * @param {number} [timestamp] - Timestamp do evento
 */
async function updateReactionCount(chatId, userId, userName, timestamp) {
	try {
		const now = timestamp || Date.now();
		await database.dbRun(
			dbName,
			`
      INSERT INTO ranking (chat_id, user_id, user_name, message_count, reaction_count, last_message_at)
      VALUES (?, ?, ?, 0, 1, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        reaction_count = reaction_count + 1,
        user_name = excluded.user_name,
        last_message_at = excluded.last_message_at
    `,
			[chatId, userId, userName, now]
		);
	} catch (error) {
		logger.error("Erro ao atualizar contagem de reações (SQLite):", error);
	}
}

/**
 * Obtém o ranking de mensagens para um chat
 * @param {string} chatId - ID do chat
 * @returns {Array} - Array de objetos de ranking ordenados por quantidade de mensagens
 */
async function getMessageRanking(chatId) {
	try {
		const rows = await database.dbAll(
			dbName,
			`
      SELECT user_name as nome, user_id as numero, (message_count + reaction_count) as qtdMsgs, last_message_at
      FROM ranking
      WHERE chat_id = ?
      ORDER BY (message_count + reaction_count) DESC
    `,
			[chatId]
		);

		return rows;
	} catch (error) {
		logger.error("Erro ao obter ranking de mensagens (SQLite):", error);
		return [];
	}
}

function getRankingDisplayName(item, nameCounts) {
	const name = String(item.nome || "Pessoa").trim() || "Pessoa";
	const key = name.toLocaleLowerCase("pt-BR");
	return nameCounts.get(key) > 1 ? `${name} (${normalizeId(item.numero)})` : name;
}

/**
 * Remove usuário do ranking
 * @param {string} chatId - ID do chat
 * @param {string} userId - ID do usuário
 */
async function removeUserFromRanking(chatId, userId) {
	try {
		await database.dbRun(dbName, `DELETE FROM ranking WHERE chat_id = ? AND user_id = ?`, [
			chatId,
			userId
		]);
	} catch (error) {
		logger.error("Erro ao remover usuário do ranking:", error);
	}
}

/**
 * Processa uma mensagem recebida para atualizar o ranking
 * @param {Object} message - Mensagem formatada
 */
async function processMessage(message) {
	try {
		if (!message) return;

		// Define userId trying author first, then authorAlt
		const userId = message.author || message.authorAlt;

		// If no user ID found, we can't track
		if (!userId) return;

		// Obtém ID do chat (grupo ou PV)
		// Se message.group existir, é um grupo. Se não, é PV (usa userId como chat)
		const chatId = message.group ?? userId;

		// Obtém nome do usuário
		let userName = userId;
		try {
			userName =
				message.name ?? message.pushName ?? message.pushname ?? message.authorName ?? "Fulano";
		} catch (error) {
			logger.error("Erro ao obter nome da pessoa que enviou msg:", {
				error,
				message
			});
		}

		// Timestamp da mensagem
		const timestamp =
			typeof message.timestamp === "number" && message.timestamp > 0
				? message.timestamp < 1e11
					? message.timestamp * 1000
					: message.timestamp
				: Date.now();

		// Atualiza contagem de mensagens
		await updateMessageCount(chatId, userId, userName, timestamp);
	} catch (error) {
		logger.error("Erro ao processar mensagem para ranking:", error);
	}
}

/**
 * Processa uma reação recebida para atualizar o ranking
 * @param {Object} reactionData - Dados da reação
 */
async function processReaction(reactionData) {
	try {
		if (!reactionData) return;

		const userId = reactionData.senderId;
		const chatId = reactionData.chatId ?? userId;

		if (!userId) return;

		// Obtém nome do usuário
		const userName = reactionData.userName ?? "Fulano";

		const timestamp =
			typeof reactionData.timestamp === "number" && reactionData.timestamp > 0
				? reactionData.timestamp < 1e11
					? reactionData.timestamp * 1000
					: reactionData.timestamp
				: Date.now();

		// Atualiza contagem de reações
		await updateReactionCount(chatId, userId, userName, timestamp);
	} catch (error) {
		logger.error("Erro ao processar reação para ranking:", error);
	}
}

/**
 * Helper to strip domain from JID
 */
function normalizeId(id) {
	if (!id) return "";
	return id.replace(/@.*/, "");
}

/**
 * Obtém a lista de participantes do grupo de forma robusta e normalizada.
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Mensagem
 * @param {string} chatId - ID do chat
 * @returns {Promise<Array>} - Array de objetos de participante normalizados
 */
async function getGroupParticipants(bot, message, chatId) {
	let rawParticipants =
		message.origin?.groupData?.Participants ?? message.goMessageData?.groupData?.Participants;

	if (!rawParticipants || rawParticipants.length === 0) {
		try {
			const chat = await bot.client.getChatById(chatId);
			if (chat && chat.participants) {
				rawParticipants = chat.participants;
			}
		} catch (e) {
			logger.error(`Erro ao obter participantes do chat ${chatId} via API:`, e);
		}
	}

	if (!rawParticipants || rawParticipants.length === 0) {
		return [];
	}

	return rawParticipants.map((p) => {
		const jid = p.JID ?? p.id?._serialized ?? p.id;
		const phoneNumber = p.PhoneNumber ?? p.phoneNumber ?? (jid ? jid.split("@")[0] : null);
		const lid = p.LID ?? p.lid;
		const displayName = p.DisplayName ?? p.name ?? "Pessoa";

		return {
			jid,
			phoneNumber,
			lid,
			displayName
		};
	});
}

/**
 * Exibe o ranking de faladores do grupo
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Mensagem formatada
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - Mensagem de retorno
 */
async function faladoresCommand(bot, message, args, group) {
	try {
		const userId = message.author || message.authorAlt;
		const chatId = message.group ?? userId;

		// Verifica se está em um grupo
		if (!message.group) {
			return new ReturnMessage({
				chatId,
				content: "Este comando só funciona em grupos."
			});
		}

		const isCompleto = args[0]?.toLowerCase() === "completo";

		// Obtém ranking
		const ranking = await getMessageRanking(chatId);

		// Get participants
		const participants = await getGroupParticipants(bot, message, chatId);

		// Identify missing
		const missingParticipants = [];

		if (participants.length > 0) {
			const rankedIds = new Set(ranking.map((r) => normalizeId(r.numero)));

			for (const p of participants) {
				// Try to find the ID
				const pIds = [p.phoneNumber, p.lid, p.jid].map((id) => normalizeId(id)).filter((id) => id); // normalize and filter empty

				// Check if any of these IDs are in the rankedIds
				const isRanked = pIds.some((id) => rankedIds.has(id));

				if (!isRanked) {
					missingParticipants.push({
						name: p.displayName || "Pessoa", // Try to get a name if available, otherwise 'Pessoa'
						id: p.phoneNumber || p.jid // Use phoneNumber or jid as reference ID
					});
				}
			}
		}

		if (ranking.length === 0 && missingParticipants.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Ainda não há estatísticas de mensagens para este grupo."
			});
		}

		// Formata a resposta
		let response = "*🏆 Ranking de faladores do grupo 🗣*\n\n";

		// Emojis para os 3 primeiros lugares
		const medals = ["🥇", "🥈", "🥉"];
		const nameCounts = new Map();
		ranking.forEach((item) => {
			const key = String(item.nome || "Pessoa")
				.trim()
				.toLocaleLowerCase("pt-BR");
			nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
		});

		// Determine list to show
		const limit = isCompleto ? ranking.length : 10;
		const displayList = ranking.slice(0, limit);

		displayList.forEach((item, index) => {
			const position = index < 3 ? medals[index] : `${index + 1}º`;
			const displayName = getRankingDisplayName(item, nameCounts);
			let line = `${position} *${displayName}*: ${item.qtdMsgs} mensagens`;
			if (isCompleto) {
				line += ` (${normalizeId(item.numero)})`;
			}
			response += `${line}\n`;
		});

		if (!isCompleto && ranking.length > 10) {
			response += `... e mais ${ranking.length - 10} membros (use '${bot.prefix}faladores completo' para ver todos)\n`;
		}

		// Add "Nunca vi" section
		if (missingParticipants.length > 0) {
			response += `\n🙊 *Nunca vi*:\n> Nenhuma mensagem registrada destes membros\n`;

			const resolvedMissing = await Promise.all(
				missingParticipants.map(async (p) => {
					let displayName = p.name;
					const pId = p.id;

					if (!displayName || displayName === "Pessoa") {
						try {
							const contact = await bot.client.getContactById(pId);
							displayName =
								contact.name?.pushName ??
								contact.name ??
								contact.pushName ??
								contact.pushname ??
								contact.number ??
								`Alguém (${normalizeId(pId)})`;
						} catch (e) {
							displayName = `Alguém (${normalizeId(pId)})`;
						}
					}
					return { name: displayName, id: pId };
				})
			);

			resolvedMissing.forEach((p) => {
				const pName = p.name;

				let line = `- ${pName}`;
				if (isCompleto) {
					line += ` (${normalizeId(p.id)})`;
				}
				response += `${line}\n`;
			});
		}
		// Adiciona estatísticas gerais
		const totalMessages = ranking.reduce((sum, item) => sum + item.qtdMsgs, 0);
		const totalUsers = ranking.length;

		response += `\n📊 *Estatísticas:*
`;
		response += `Total de ${totalMessages} mensagens enviadas por ${totalUsers} participantes`;

		return new ReturnMessage({
			chatId,
			content: response
		});
	} catch (error) {
		logger.error("Erro ao executar comando de ranking de faladores:", error);

		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Ocorreu um erro ao obter o ranking de faladores."
		});
	}
}

/**
 * Limpa do ranking membros que não estão mais no grupo
 */
async function faladoresLimpezaCommand(bot, message, args, group) {
	try {
		const userId = message.author || message.authorAlt;
		const chatId = message.group ?? userId;

		if (!message.group) {
			return new ReturnMessage({
				chatId,
				content: "Comando apenas para grupos."
			});
		}

		// Verifica se o usuário é admin
		const isAdmin = await bot.isUserAdminInGroup(userId, chatId);
		if (!isAdmin) {
			return new ReturnMessage({
				chatId,
				content: "⛔ Apenas administradores podem realizar a limpeza do ranking.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		const participants = await getGroupParticipants(bot, message, chatId);

		if (!participants || participants.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Não foi possível obter a lista de participantes do grupo para verificar a limpeza."
			});
		}

		const ranking = await getMessageRanking(chatId);
		let removedCount = 0;

		// Build set of current participant IDs (normalized)
		const currentMemberIds = new Set();
		participants.forEach((p) => {
			if (p.phoneNumber) currentMemberIds.add(normalizeId(p.phoneNumber));
			if (p.lid) currentMemberIds.add(normalizeId(p.lid));
			if (p.jid) currentMemberIds.add(normalizeId(p.jid));
		});

		for (const item of ranking) {
			const dbId = normalizeId(item.numero);
			if (!currentMemberIds.has(dbId)) {
				// User in ranking but not in current participants
				await removeUserFromRanking(chatId, item.numero);
				removedCount++;
			}
		}

		return new ReturnMessage({
			chatId,
			content: `Limpeza concluída! 🧹\n${removedCount} membros antigos foram removidos do ranking.`
		});
	} catch (error) {
		logger.error("Erro em faladores-limpeza:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao realizar limpeza do ranking."
		});
	}
}

/**
 * Remove todos os registros de ranking de um grupo
 * @param {string} chatId - ID do chat
 */
async function resetRanking(chatId) {
	try {
		await database.dbRun(dbName, `DELETE FROM ranking WHERE chat_id = ?`, [chatId]);
	} catch (error) {
		logger.error("Erro ao resetar ranking:", error);
	}
}

/**
 * Reseta o ranking do grupo, mostrando o resultado final antes
 */
async function faladoresResetCommand(bot, message, args, group) {
	try {
		const userId = message.author || message.authorAlt;
		const chatId = message.group ?? userId;

		if (!message.group) {
			return new ReturnMessage({
				chatId,
				content: "Comando apenas para grupos."
			});
		}

		// Verifica se o usuário é admin
		const isAdmin = await bot.isUserAdminInGroup(userId, chatId);
		if (!isAdmin) {
			return new ReturnMessage({
				chatId,
				content: "⛔ Apenas administradores podem resetar o ranking.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// 1. Get current full ranking
		const rankingMsg = await faladoresCommand(bot, message, ["completo"], group);
		const rankingContent = rankingMsg.content;

		// 2. Reset database
		await resetRanking(chatId);

		// 3. Format Date
		const now = new Date();
		const formattedDate = now
			.toLocaleString("pt-BR", {
				hour: "2-digit",
				minute: "2-digit",
				day: "2-digit",
				month: "2-digit",
				year: "numeric"
			})
			.replace(",", "");

		// 4. Construct response
		const response = `${rankingContent}\n\n📅 Fechamento: ${formattedDate}\n\n♻️ *Ranking reiniciado com sucesso!*`;

		return new ReturnMessage({
			chatId,
			content: response
		});
	} catch (error) {
		logger.error("Erro em faladores-reset:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao resetar o ranking."
		});
	}
}

const ACTIVITY_BUCKETS = [
	{
		key: "menos_12h",
		label: "menos de 12 horas",
		emoji: "🟢",
		minMs: 0,
		maxMs: 12 * 60 * 60 * 1000
	},
	{
		key: "menos_1d",
		label: "menos de 1 dia",
		emoji: "🟡",
		minMs: 12 * 60 * 60 * 1000,
		maxMs: 24 * 60 * 60 * 1000
	},
	{
		key: "1_3d",
		label: "1 a 3 dias",
		emoji: "🟠",
		minMs: 24 * 60 * 60 * 1000,
		maxMs: 3 * 24 * 60 * 60 * 1000
	},
	{
		key: "3_5d",
		label: "3 a 5 dias",
		emoji: "🟡",
		minMs: 3 * 24 * 60 * 60 * 1000,
		maxMs: 5 * 24 * 60 * 60 * 1000
	},
	{
		key: "5_7d",
		label: "5 a 7 dias",
		emoji: "🔵",
		minMs: 5 * 24 * 60 * 60 * 1000,
		maxMs: 7 * 24 * 60 * 60 * 1000
	},
	{
		key: "7_15d",
		label: "7 a 15 dias",
		emoji: "🟣",
		minMs: 7 * 24 * 60 * 60 * 1000,
		maxMs: 15 * 24 * 60 * 60 * 1000
	},
	{
		key: "15_30d",
		label: "15 a 30 dias",
		emoji: "🟤",
		minMs: 15 * 24 * 60 * 60 * 1000,
		maxMs: 30 * 24 * 60 * 60 * 1000
	},
	{
		key: "mais_30d",
		label: "mais de 30 dias",
		emoji: "⚫",
		minMs: 30 * 24 * 60 * 60 * 1000,
		maxMs: Infinity
	}
];

function formatTimeAgo(ms) {
	if (ms < 0) ms = 0;
	const minutes = Math.floor(ms / (1000 * 60));
	const hours = Math.floor(ms / (1000 * 60 * 60));
	const days = Math.floor(ms / (1000 * 60 * 60 * 24));

	if (minutes < 1) return "agora há pouco";
	if (minutes < 60) return `há ${minutes}min`;
	if (hours < 24) return `há ${hours}h`;
	if (days === 1) return `há 1 dia`;
	return `há ${days} dias`;
}

/**
 * Exibe a atividade dos membros do grupo categorizada por tempo desde a última mensagem vista
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Mensagem formatada
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - Mensagem de retorno
 */
async function faladoresAtividadeCommand(bot, message, args, group) {
	try {
		const userId = message.author || message.authorAlt;
		const chatId = message.group ?? userId;

		if (!message.group) {
			return new ReturnMessage({
				chatId,
				content: "Este comando só funciona em grupos."
			});
		}

		const ranking = await getMessageRanking(chatId);
		const participants = await getGroupParticipants(bot, message, chatId);

		if (ranking.length === 0 && participants.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Ainda não há estatísticas de atividade ou membros para este grupo."
			});
		}

		const rankingMap = new Map();
		for (const r of ranking) {
			const norm = normalizeId(r.numero);
			if (norm) {
				rankingMap.set(norm, r);
			}
		}

		// Prepara lista de membros a classificar
		const membersToClassify = [];
		if (participants.length > 0) {
			for (const p of participants) {
				const pIds = [p.phoneNumber, p.lid, p.jid].map((id) => normalizeId(id)).filter(Boolean);

				let rankedItem = null;
				for (const id of pIds) {
					if (rankingMap.has(id)) {
						rankedItem = rankingMap.get(id);
						break;
					}
				}

				membersToClassify.push({
					id: p.phoneNumber || p.jid || p.lid || "unknown",
					name: rankedItem?.nome || p.displayName || "Pessoa",
					rankedItem
				});
			}
		} else {
			// Fallback quando não foi possível obter lista de participantes via API
			for (const r of ranking) {
				membersToClassify.push({
					id: r.numero,
					name: r.nome || "Pessoa",
					rankedItem: r
				});
			}
		}

		const now = Date.now();
		const buckets = ACTIVITY_BUCKETS.map((b) => ({
			...b,
			members: []
		}));
		const semDataBucket = {
			key: "sem_data",
			label: "sem registro recente (histórico)",
			emoji: "⚪",
			members: []
		};
		const nuncaBucket = {
			key: "nunca",
			label: "nunca",
			emoji: "🚫",
			members: []
		};

		for (const m of membersToClassify) {
			const item = m.rankedItem;
			if (item && item.qtdMsgs > 0) {
				if (item.last_message_at) {
					const diff = Math.max(0, now - item.last_message_at);
					const targetBucket =
						buckets.find((b) => diff >= b.minMs && diff < b.maxMs) || buckets[buckets.length - 1];
					targetBucket.members.push({
						id: m.id,
						name: m.name,
						diff,
						timeAgoStr: formatTimeAgo(diff),
						qtdMsgs: item.qtdMsgs
					});
				} else {
					semDataBucket.members.push({
						id: m.id,
						name: m.name,
						qtdMsgs: item.qtdMsgs
					});
				}
			} else {
				nuncaBucket.members.push({
					id: m.id,
					name: m.name,
					qtdMsgs: 0
				});
			}
		}

		// Ordenações internas
		for (const b of buckets) {
			b.members.sort((a, b) => a.diff - b.diff);
		}
		semDataBucket.members.sort((a, b) => b.qtdMsgs - a.qtdMsgs);
		nuncaBucket.members.sort((a, b) => String(a.name).localeCompare(String(b.name), "pt-BR"));

		// Contagem de nomes repetidos para desambiguação
		const nameCounts = new Map();
		for (const m of membersToClassify) {
			const key = String(m.name || "Pessoa")
				.trim()
				.toLocaleLowerCase("pt-BR");
			nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
		}

		const formatMember = (m, showTime = true) => {
			const key = String(m.name || "Pessoa")
				.trim()
				.toLocaleLowerCase("pt-BR");
			const display = nameCounts.get(key) > 1 ? `${m.name} (${normalizeId(m.id)})` : m.name;
			if (showTime && m.timeAgoStr) {
				return `• ${display} (${m.timeAgoStr})`;
			}
			if (showTime && m.qtdMsgs) {
				return `• ${display} (${m.qtdMsgs} msgs pré-rastreamento)`;
			}
			return `• ${display}`;
		};

		const totalCount = membersToClassify.length;
		const arg = (args[0] || "").toLowerCase().trim();

		const allBuckets = [...buckets];
		if (semDataBucket.members.length > 0) {
			allBuckets.push(semDataBucket);
		}
		allBuckets.push(nuncaBucket);

		// Filtro específico: 'nunca'
		if (arg === "nunca") {
			let resp = `🚫 *Membros que nunca falaram no grupo* (${nuncaBucket.members.length}/${totalCount})\n\n`;
			if (nuncaBucket.members.length === 0) {
				resp += "Todos os membros atuais já enviaram pelo menos uma mensagem! 🎉";
			} else {
				resp += nuncaBucket.members.map((m) => formatMember(m, false)).join("\n");
			}
			return new ReturnMessage({ chatId, content: resp });
		}

		// Filtro específico: 'inativos' (7+ dias sem mensagens)
		if (arg === "inativos") {
			const inactBuckets = allBuckets.filter(
				(b) =>
					["7_15d", "15_30d", "mais_30d", "sem_data", "nunca"].includes(b.key) &&
					b.members.length > 0
			);
			let resp = `💤 *Membros Inativos no Grupo (7+ dias sem mensagens)*\n\n`;
			if (inactBuckets.length === 0) {
				resp += "Nenhum membro inativo há mais de 7 dias! O grupo está bem ativo! 🔥";
			} else {
				for (const b of inactBuckets) {
					resp += `${b.emoji} *${b.label}* (${b.members.length}):\n`;
					resp += b.members.map((m) => formatMember(m, true)).join("\n");
					resp += "\n\n";
				}
			}
			return new ReturnMessage({ chatId, content: resp.trim() });
		}

		// Filtro por faixa específica
		const bucketKeyMap = {
			"12h": "menos_12h",
			"menos-12h": "menos_12h",
			"1d": "menos_1d",
			"24h": "menos_1d",
			"3d": "1_3d",
			"5d": "3_5d",
			"7d": "5_7d",
			"15d": "7_15d",
			"30d": "15_30d",
			"+30d": "mais_30d",
			"30d+": "mais_30d",
			"mais-30d": "mais_30d"
		};

		if (bucketKeyMap[arg]) {
			const targetKey = bucketKeyMap[arg];
			const b = allBuckets.find((item) => item.key === targetKey);
			if (b) {
				let resp = `${b.emoji} *Membros na faixa: ${b.label}* (${b.members.length}/${totalCount})\n\n`;
				if (b.members.length === 0) {
					resp += "Nenhum membro nesta faixa de atividade.";
				} else {
					resp += b.members.map((m) => formatMember(m, true)).join("\n");
				}
				return new ReturnMessage({ chatId, content: resp });
			}
		}

		// Visão Geral (Default ou 'completo')
		const isCompleto = arg === "completo";
		let response = `📊 *Rank de Atividade dos Membros* 🕒\n`;
		response += `👥 *Total de membros analisados:* ${totalCount}\n\n`;

		// Resumo quantitativo por faixa
		response += `📋 *Resumo por tempo da última mensagem vista:*\n`;
		for (const b of allBuckets) {
			const count = b.members.length;
			const pct = totalCount > 0 ? Math.round((count / totalCount) * 100) : 0;
			response += `${b.emoji} *${b.label}:* ${count} (${pct}%)\n`;
		}
		response += "\n";

		// Detalhamento dos membros
		if (isCompleto || totalCount <= 35) {
			response += `👥 *Listagem de membros:*\n\n`;
			for (const b of allBuckets) {
				if (b.members.length === 0) continue;
				response += `${b.emoji} *${b.label}* (${b.members.length}):\n`;
				response += b.members.map((m) => formatMember(m, true)).join("\n");
				response += "\n\n";
			}
			response = response.trim();
		} else {
			// Grupo grande (> 35 membros) sem 'completo': destaque para inativos
			const criticos = [];
			const bMais30 = allBuckets.find((b) => b.key === "mais_30d");
			const bNunca = allBuckets.find((b) => b.key === "nunca");

			if (bMais30 && bMais30.members.length > 0) {
				criticos.push(bMais30);
			}
			if (bNunca && bNunca.members.length > 0) {
				criticos.push(bNunca);
			}

			if (criticos.length > 0) {
				response += `🔍 *Destaque de Inatividade:*\n\n`;
				for (const b of criticos) {
					response += `${b.emoji} *${b.label}* (${b.members.length}):\n`;
					const maxShow = 15;
					const slice = b.members.slice(0, maxShow);
					response += slice.map((m) => formatMember(m, true)).join("\n");
					if (b.members.length > maxShow) {
						response += `\n... e mais ${b.members.length - maxShow} membros`;
					}
					response += "\n\n";
				}
			}

			response += `💡 *Dica:* Use '${bot.prefix}faladores-atividade completo' para ver a lista de todos os membros, ou '${bot.prefix}faladores-atividade inativos' para ver quem está sem falar há 7+ dias.`;
		}

		return new ReturnMessage({
			chatId,
			content: response
		});
	} catch (error) {
		logger.error("Erro ao executar comando de atividade de faladores:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Ocorreu um erro ao obter a atividade dos membros."
		});
	}
}

// Comandos para ranking de faladores
const commands = [
	new Command({
		name: "faladores",
		description: "Mostra o ranking de quem mais fala no grupo",
		category: "grupo",
		method: faladoresCommand,
		reactions: { after: "🗣", error: "❌" }
	}),
	new Command({
		name: "faladores-limpeza",
		description: "Remove do ranking membros que saíram do grupo",
		category: "grupo",
		adminOnly: true,
		method: faladoresLimpezaCommand,
		reactions: { after: "🧹", error: "❌" }
	}),
	new Command({
		name: "faladores-reset",
		description: "Mostra o ranking final e reinicia a contagem",
		category: "grupo",
		adminOnly: true,
		method: faladoresResetCommand,
		reactions: { after: "♻️", error: "❌" }
	}),
	new Command({
		name: "faladores-atividade",
		aliases: ["atividade", "faladores-atv"],
		description: "Mostra o rank de membros por tempo de atividade recente no grupo",
		category: "grupo",
		method: faladoresAtividadeCommand,
		reactions: { after: "🕒", error: "❌" }
	})
];

const helper = {
	about: "Monitoramento de atividade de mensagens e ranking de membros mais faladores do grupo",
	implementation:
		"Registra contagem de mensagens e timestamps de atividade em SQLite, gerando relatórios de participação recente",
	tags: "faladores,ranking,mensagens,atividade,membros,estatisticas",
	cmds: [
		{
			cmd: "!faladores",
			desc: "Exibe o ranking com os membros mais ativos do grupo",
			usage: ["!faladores"],
			category: "grupo"
		},
		{
			cmd: "!faladores-limpeza",
			desc: "Lista membros inativos que não enviaram mensagens recentes",
			usage: ["!faladores-limpeza"],
			category: "grupo"
		},
		{
			cmd: "!faladores-reset",
			desc: "Reseta a contagem de mensagens do grupo (Apenas Administradores)",
			usage: ["!faladores-reset"],
			category: "grupo"
		},
		{
			cmd: "!faladores-atividade",
			desc: "Mostra o rank de atividade recente dos membros (última mensagem vista)",
			usage: [
				"!faladores-atividade",
				"!faladores-atividade completo",
				"!faladores-atividade nunca",
				"!faladores-atividade inativos",
				"!faladores-atividade 7d"
			],
			category: "grupo"
		}
	]
};

/**
 * Consulta o resumo do ranking de mensagens/atividade de um grupo
 * @param {string} [chatId] - ID do grupo
 * @returns {Promise<string>}
 */
async function fetchGroupRankingSummary(chatId) {
	if (!chatId) {
		return "Esta ferramenta só pode ser usada dentro do contexto de um grupo de WhatsApp.";
	}

	try {
		const ranking = await getMessageRanking(chatId);

		if (!ranking || ranking.length === 0) {
			return "Ainda não há estatísticas de mensagens ou atividade registradas para este grupo.";
		}

		const medals = ["🥇", "🥈", "🥉"];
		let resultado = `🏆 **Top Membros Mais Ativos do Grupo:**\n\n`;

		ranking.slice(0, 10).forEach((item, index) => {
			const pos = index < 3 ? medals[index] : `${index + 1}º`;
			resultado += `${pos} **${item.nome || "Membro"}**: ${item.qtdMsgs} mensagens enviadas\n`;
		});

		if (ranking.length > 10) {
			resultado += `\n... e mais ${ranking.length - 10} membros ativos no total.`;
		}

		return resultado.trim();
	} catch (err) {
		logger.error(`Erro ao obter ranking para chat ${chatId}:`, err.message);
		return `Erro ao consultar estatísticas de atividade do grupo: ${err.message}`;
	}
}

module.exports = {
	helper,
	commands,
	processMessage,
	processReaction,
	getMessageRanking,
	faladoresAtividadeCommand,
	fetchGroupRankingSummary,
	getRankingDisplayName
};
