const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("afk-commands");
const database = Database.getInstance();
const dbName = "afk";

// Cooldown em memória para menções a usuários AFK (key: groupId_userId, val: timestamp)
const mentionCooldowns = new Map();
const MENTION_COOLDOWN_MS = 30000; // 30 segundos de cooldown por usuário mencionado por grupo

// Inicializa a tabela afk_sessions
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS afk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_lid TEXT,
      user_name TEXT,
      reason TEXT,
      entered_at INTEGER NOT NULL,
      exited_at INTEGER,
      is_active INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_afk_group_active ON afk_sessions(group_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_afk_user_active ON afk_sessions(group_id, user_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_afk_lid_active ON afk_sessions(group_id, user_lid, is_active);
  `
);

/**
 * Normaliza um ID (JID ou LID) removendo o sufixo @domain
 * @param {string} id
 * @returns {string}
 */
function cleanId(id) {
	if (!id) return "";
	return String(id).split("@")[0].trim();
}

/**
 * Formata duração em milissegundos para texto legível em português
 * @param {number} ms - Duração em ms
 * @returns {string}
 */
function formatDuration(ms) {
	if (ms < 0) ms = 0;
	const seconds = Math.floor((ms / 1000) % 60);
	const minutes = Math.floor((ms / (1000 * 60)) % 60);
	const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
	const days = Math.floor(ms / (1000 * 60 * 60 * 24));

	const parts = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}min`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

	return parts.join(" ");
}

/**
 * Formata um timestamp em data/hora brasileira
 * @param {number} timestamp
 * @returns {string}
 */
function formatDateTime(timestamp) {
	const d = new Date(timestamp);
	const pad = (n) => String(n).padStart(2, "0");
	const day = pad(d.getDate());
	const month = pad(d.getMonth() + 1);
	const year = d.getFullYear();
	const hours = pad(d.getHours());
	const minutes = pad(d.getMinutes());
	const seconds = pad(d.getSeconds());
	return `${day}/${month}/${year} às ${hours}:${minutes}:${seconds}`;
}

/**
 * Extrai todos os IDs mencionados e citados (replies) de uma mensagem
 * @param {Object} message
 * @returns {Promise<string[]>} Lista de IDs limpos
 */
async function extractMentionedIds(message) {
	const mentionsRaw = [
		...(Array.isArray(message.mentions) ? message.mentions : []),
		...(Array.isArray(message.mentionedIds) ? message.mentionedIds : []),
		...(Array.isArray(message.origin?.mentionedIds) ? message.origin.mentionedIds : [])
	];

	// Campos síncronos de autor de citação/reply
	if (message.quotedParticipant) mentionsRaw.push(message.quotedParticipant);
	if (message.quotedMsg?.author) mentionsRaw.push(message.quotedMsg.author);
	if (message.quotedMsg?.authorAlt) mentionsRaw.push(message.quotedMsg.authorAlt);
	if (message.quotedMsg?.participant) mentionsRaw.push(message.quotedMsg.participant);
	if (message.origin?.quotedParticipant) mentionsRaw.push(message.origin.quotedParticipant);
	if (message.origin?.quotedMsg?.author) mentionsRaw.push(message.origin.quotedMsg.author);
	if (message.origin?.quotedMsg?.authorAlt) mentionsRaw.push(message.origin.quotedMsg.authorAlt);
	if (message.origin?._data?.quotedParticipant)
		mentionsRaw.push(message.origin._data.quotedParticipant);

	// Tenta buscar via getQuotedMessage caso a mensagem tenha citação
	if (
		message.hasQuotedMsg ||
		message.origin?.hasQuotedMsg ||
		typeof message.origin?.getQuotedMessage === "function"
	) {
		try {
			if (typeof message.origin?.getQuotedMessage === "function") {
				const quoted = await message.origin.getQuotedMessage().catch(() => null);
				if (quoted) {
					if (quoted.author) mentionsRaw.push(quoted.author);
					if (quoted.authorAlt) mentionsRaw.push(quoted.authorAlt);
					if (quoted.participant) mentionsRaw.push(quoted.participant);
					if (quoted.from && !quoted.from.includes("@g.us")) mentionsRaw.push(quoted.from);
				}
			}
		} catch (e) {
			// Ignora falhas de resgate da mensagem citada
		}
	}

	const set = new Set();
	for (const m of mentionsRaw) {
		const cleaned = cleanId(m);
		if (cleaned) set.add(cleaned);
	}
	return Array.from(set);
}

/**
 * Define o status AFK de um usuário no grupo
 */
async function setAFK(groupId, userId, userLid, userName, reason) {
	const now = Date.now();
	// Encerra qualquer sessão ativa existente antes de abrir uma nova
	await database.dbRun(
		dbName,
		`UPDATE afk_sessions SET is_active = 0, exited_at = ? WHERE group_id = ? AND is_active = 1 AND (user_id = ? OR (user_lid IS NOT NULL AND user_lid = ?))`,
		[now, groupId, userId, userLid || userId]
	);

	// Insere nova sessão
	await database.dbRun(
		dbName,
		`INSERT INTO afk_sessions (group_id, user_id, user_lid, user_name, reason, entered_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)`,
		[groupId, userId, userLid || null, userName || "Usuário", reason || null, now]
	);
}

/**
 * Obtém todas as sessões AFK ativas em um grupo, ordenadas por entered_at (mais antigo no topo)
 */
async function getActiveAFKSessions(groupId) {
	const rows = await database.dbAll(
		dbName,
		`SELECT * FROM afk_sessions WHERE group_id = ? AND is_active = 1 ORDER BY entered_at ASC`,
		[groupId]
	);
	return rows || [];
}

/**
 * Verifica e processa o retorno do usuário do AFK se ele enviar mensagem no grupo.
 * Reage com 🏁 na mensagem do usuário e desativa o status AFK no banco.
 */
async function checkReturnFromAFK(bot, message, group) {
	try {
		if (!group || !message || !message.author) return;

		const groupId = group.id || message.group;
		const userId = message.author;
		const userLid = message.authorAlt || message.origin?.authorAlt || null;

		const cleanU = cleanId(userId);
		const cleanL = cleanId(userLid);

		const activeSessions = await getActiveAFKSessions(groupId);
		const userSession = activeSessions.find(
			(s) => cleanId(s.user_id) === cleanU || (cleanL && cleanId(s.user_lid) === cleanL)
		);

		if (userSession) {
			const now = Date.now();
			// Atualiza no banco registrando o horário de saída
			await database.dbRun(
				dbName,
				`UPDATE afk_sessions SET is_active = 0, exited_at = ? WHERE id = ?`,
				[now, userSession.id]
			);

			// Reage com 🏁 na mensagem
			if (typeof message.origin?.react === "function") {
				await message.origin.react("🏁").catch((err) => {
					logger.error("Erro ao reagir com 🏁 na remoção do AFK:", err);
				});
			} else if (typeof bot.react === "function") {
				await bot.react(message, "🏁").catch((err) => {
					logger.error("Erro em bot.react na remoção do AFK:", err);
				});
			}
		}
	} catch (error) {
		logger.error("Erro em checkReturnFromAFK:", error);
	}
}

/**
 * Verifica se a mensagem menciona algum usuário atualmente AFK no grupo.
 * Se sim, envia resposta informando o status AFK.
 */
async function detectAFKMentions(bot, message, group) {
	try {
		if (!group || !message) return;

		const groupId = group.id || message.group;
		const mentionedCleanIds = await extractMentionedIds(message);
		if (mentionedCleanIds.length === 0) return;

		const authorClean = cleanId(message.author);
		const authorAltClean = cleanId(message.authorAlt || message.origin?.authorAlt);

		const activeSessions = await getActiveAFKSessions(groupId);
		if (activeSessions.length === 0) return;

		const now = Date.now();

		for (const session of activeSessions) {
			const sUserIdClean = cleanId(session.user_id);
			const sUserLidClean = cleanId(session.user_lid);

			// Não avisa se o próprio autor da mensagem for o AFK (já tratado em checkReturnFromAFK)
			if (sUserIdClean === authorClean || (authorAltClean && sUserIdClean === authorAltClean)) {
				continue;
			}
			if (sUserLidClean && (sUserLidClean === authorClean || sUserLidClean === authorAltClean)) {
				continue;
			}

			// Verifica se o ID do AFK (JID ou LID) está entre os IDs mencionados
			const isMentioned = mentionedCleanIds.some(
				(mId) => mId === sUserIdClean || (sUserLidClean && mId === sUserLidClean)
			);

			if (isMentioned) {
				const cooldownKey = `${groupId}_${session.user_id}`;
				const lastNotified = mentionCooldowns.get(cooldownKey) || 0;

				if (now - lastNotified < MENTION_COOLDOWN_MS) {
					continue; // Respeita cooldown de envio
				}
				mentionCooldowns.set(cooldownKey, now);

				const durationText = formatDuration(now - session.entered_at);
				const startDateText = formatDateTime(session.entered_at);
				const reasonText = session.reason ? session.reason.trim() : "Não informado";
				const name = session.user_name || "Membro";

				const responseText =
					`⚠️ *${name} está AFK!*\n\n` +
					`🕒 *Desde:* ${startDateText} (há ${durationText})\n` +
					`💬 *Motivo:* ${reasonText}`;

				const returnMsg = new ReturnMessage({
					chatId: groupId,
					content: responseText
				});

				await bot.sendReturnMessages(returnMsg, group);
			}
		}
	} catch (error) {
		logger.error("Erro em detectAFKMentions:", error);
	}
}

// Definição dos comandos exportados para autoload em FixedCommands
const commands = [
	new Command({
		name: "afk",
		description: "Define seu status como AFK (Away From Keyboard) no grupo",
		usage: "!afk <motivo (opcional)>",
		category: "grupo",
		group: false,
		method: async (bot, message, args, group) => {
			if (!group && !message.group) {
				return new ReturnMessage({
					chatId: message.author,
					content: "❌ Este comando só pode ser utilizado em grupos!"
				});
			}

			const groupId = group ? group.id : message.group;
			const userId = message.author;
			const userLid = message.authorAlt || message.origin?.authorAlt || null;
			const userName = message.authorName || message.name || message.pushName || "Membro";
			const reason = args ? args.join(" ").trim() : "";

			await setAFK(groupId, userId, userLid, userName, reason);

			let response = `💤 *@${userName} agora está AFK!*`;
			if (reason) {
				response += `\n💬 *Motivo:* ${reason}`;
			}
			response += `\n\n_Qualquer mensagem enviada por você no grupo removerá o AFK (🏁)._`;

			return new ReturnMessage({
				chatId: groupId,
				content: response
			});
		}
	}),
	new Command({
		name: "afk-lista",
		aliases: ["afks", "afklist"],
		description: "Lista os membros do grupo que estão atualmente AFK",
		usage: "!afk-lista",
		category: "grupo",
		group: false,
		method: async (bot, message, args, group) => {
			if (!group && !message.group) {
				return new ReturnMessage({
					chatId: message.author,
					content: "❌ Este comando só pode ser utilizado em grupos!"
				});
			}

			const groupId = group ? group.id : message.group;
			const activeSessions = await getActiveAFKSessions(groupId);

			if (activeSessions.length === 0) {
				return new ReturnMessage({
					chatId: groupId,
					content: "✅ Nenhum membro está AFK neste grupo no momento!"
				});
			}

			const now = Date.now();
			let response = `💤 *Membros AFK neste grupo (${activeSessions.length}):*\n\n`;

			activeSessions.forEach((session, index) => {
				const durationText = formatDuration(now - session.entered_at);
				const startDateText = formatDateTime(session.entered_at);
				const reasonText = session.reason ? session.reason.trim() : "Sem motivo";
				const name = session.user_name || "Membro";

				response += `${index + 1}. *${name}*\n`;
				response += `   🕒 AFK há: *${durationText}* (desde ${startDateText})\n`;
				response += `   💬 Motivo: ${reasonText}\n\n`;
			});

			return new ReturnMessage({
				chatId: groupId,
				content: response.trim()
			});
		}
	})
];

module.exports = {
	commands,
	setAFK,
	getActiveAFKSessions,
	checkReturnFromAFK,
	detectAFKMentions,
	formatDuration,
	formatDateTime
};
