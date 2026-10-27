// src/functions/ListCommands.js

const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const GroupContextHelper = require("../utils/GroupContextHelper");
const AdminUtils = require("../utils/AdminUtils");

const logger = new Logger("list-commands");
const database = Database.getInstance();
const DB_NAME = "lists_v2";

// Inicialização do Schema Relacional do lists_v2
database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT,
    type TEXT NOT NULL CHECK(type IN ('members', 'items')),
    admin_only INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_message_id TEXT,
    last_chat_id TEXT,
    UNIQUE(group_id, name)
  );

  CREATE TABLE IF NOT EXISTS list_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    item_text TEXT NOT NULL,
    checked INTEGER NOT NULL DEFAULT 0,
    added_by TEXT NOT NULL,
    added_by_name TEXT,
    added_at INTEGER NOT NULL,
    checked_by TEXT,
    checked_by_name TEXT,
    checked_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS list_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    user_name TEXT,
    joined_at INTEGER NOT NULL,
    UNIQUE(list_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS list_messages (
    message_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('overview', 'single')),
    list_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_lists_group ON lists(group_id);
  CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id);
  CREATE INDEX IF NOT EXISTS idx_list_members_list ON list_members(list_id);
  CREATE INDEX IF NOT EXISTS idx_list_messages_group ON list_messages(group_id);
`
);

// Emojis numéricos para reações
const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const NUMBER_EMOJIS2 = ["1⃣", "2⃣", "3⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const NUMBER_EMOJIS3 = ["1️", "2️", "3️", "4️", "5️", "6️", "7️", "8️", "9️", "🔟"];

// ─── ROTINA DE MIGRAÇÃO AUTOMÁTICA DE LEGADO ──────────────────────────────
let migrationPromise = null;

async function ensureMigrated() {
	if (!migrationPromise) {
		migrationPromise = (async () => {
			try {
				const countRow = await database
					.dbGet(DB_NAME, "SELECT COUNT(*) as count FROM lists")
					.catch(() => null);
				if (countRow && countRow.count > 0) {
					return; // lists_v2 já possui dados
				}

				// Verifica se há registros na tabela antiga do lists.db
				const oldRows = await database
					.dbAll("lists", "SELECT group_id, json_data FROM lists")
					.catch(() => []);

				if (!oldRows || oldRows.length === 0) {
					return;
				}

				logger.info(
					`[migration] Migrando ${oldRows.length} grupos do lists.db legado para lists_v2...`
				);

				for (const row of oldRows) {
					if (!row.group_id || !row.json_data) continue;
					try {
						const lists = JSON.parse(row.json_data);
						if (!Array.isArray(lists)) continue;

						for (const oldList of lists) {
							if (!oldList.name) continue;
							const listName = String(oldList.name).toLowerCase().trim();
							const listTitle = oldList.title || oldList.name;
							const createdBy = oldList.createdBy || "sistema";
							const createdAt = oldList.createdAt || Date.now();

							await database.dbRun(
								DB_NAME,
								`INSERT OR IGNORE INTO lists (group_id, name, title, type, admin_only, created_by, created_at)
								 VALUES (?, ?, ?, 'members', 0, ?, ?)`,
								[row.group_id, listName, listTitle, createdBy, createdAt]
							);

							const listRow = await database.dbGet(
								DB_NAME,
								"SELECT id FROM lists WHERE group_id = ? AND name = ?",
								[row.group_id, listName]
							);

							if (listRow && Array.isArray(oldList.members)) {
								for (const member of oldList.members) {
									if (!member || !member.id) continue;
									const memberName =
										typeof member.name === "string"
											? member.name
											: member.name?.pushName || member.name?.name || `Usuário_${member.id}`;

									await database.dbRun(
										DB_NAME,
										`INSERT OR IGNORE INTO list_members (list_id, user_id, user_name, joined_at)
										 VALUES (?, ?, ?, ?)`,
										[
											listRow.id,
											String(member.id),
											String(memberName),
											typeof member.joinedAt === "number" ? member.joinedAt : Date.now()
										]
									);
								}
							}
						}
					} catch (parseErr) {
						logger.debug(`[migration] Falha ao parsear grupo ${row.group_id}: ${parseErr.message}`);
					}
				}
				logger.info(`[migration] Migração para lists_v2 concluída com sucesso!`);
			} catch (err) {
				logger.error(`[migration] Falha geral na migração para lists_v2: ${err.message}`, err);
			}
		})();
	}
	return migrationPromise;
}

// ─── HELPERS DE BANCO DE DADOS ─────────────────────────────────────────────

async function getListByName(groupId, name) {
	await ensureMigrated();
	if (!groupId || !name) return null;
	return await database.dbGet(DB_NAME, "SELECT * FROM lists WHERE group_id = ? AND name = ?", [
		groupId,
		String(name).toLowerCase().trim()
	]);
}

async function getListById(listId) {
	await ensureMigrated();
	if (!listId) return null;
	return await database.dbGet(DB_NAME, "SELECT * FROM lists WHERE id = ?", [listId]);
}

async function getGroupLists(groupId) {
	await ensureMigrated();
	if (!groupId) return [];
	return await database.dbAll(DB_NAME, "SELECT * FROM lists WHERE group_id = ? ORDER BY id ASC", [
		groupId
	]);
}

async function getListItems(listId) {
	if (!listId) return [];
	return await database.dbAll(
		DB_NAME,
		"SELECT * FROM list_items WHERE list_id = ? ORDER BY checked ASC, id ASC",
		[listId]
	);
}

async function getListMembers(listId) {
	if (!listId) return [];
	return await database.dbAll(
		DB_NAME,
		"SELECT * FROM list_members WHERE list_id = ? ORDER BY id ASC",
		[listId]
	);
}

async function trackListMessage(messageId, groupId, type, listId = null) {
	if (!messageId || !groupId) return;
	try {
		await database.dbRun(
			DB_NAME,
			`INSERT OR REPLACE INTO list_messages (message_id, group_id, type, list_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[messageId, groupId, type, listId, Date.now(), Date.now()]
		);
	} catch (e) {
		logger.debug(`[trackListMessage] Erro ao registrar mensagem ${messageId}: ${e.message}`);
	}
}

async function getTrackedMessage(messageId) {
	if (!messageId) return null;
	return await database.dbGet(DB_NAME, "SELECT * FROM list_messages WHERE message_id = ?", [
		messageId
	]);
}

// ─── HELPERS DE FORMATAÇÃO E PARSER ────────────────────────────────────────

/**
 * Divide o texto por vírgulas, ponto e vírgulas ou quebras de linha e sanitiza os itens.
 * Remove marcadores de lista existentes ("-", "*", "1.", etc.)
 */
function parseItemsFromText(rawText) {
	if (!rawText || typeof rawText !== "string") return [];

	const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const tokens = normalized.split(/(?:[\n;]|,\s*)+/);

	const items = [];
	const seen = new Set();

	for (let token of tokens) {
		token = token
			.replace(/^[\s\d]+[.)]\s*/, "") // remove "1. " ou "1) "
			.replace(/^[\s*\-•▪▫—–]+\s*/, "") // remove marcadores de tópicos
			.replace(/^\[[ xX]\]\s*/, "") // remove "[ ] " ou "[x] "
			.replace(/^[▫✅❌⚽]+\s*/, "") // remove emojis marcadores
			.trim();

		if (!token) continue;
		// Ignora cabeçalhos que terminam com dois pontos (ex: "comprar:", "itens:")
		if (token.endsWith(":") && token.length <= 30) continue;

		if (token.length > 100) {
			token = token.substring(0, 100).trim();
		}

		const lower = token.toLowerCase();
		if (!seen.has(lower)) {
			seen.add(lower);
			items.push(token);
		}

		if (items.length >= 50) break;
	}

	return items;
}

/**
 * Obtém o nome de exibição de um usuário (apelido ou nome no WhatsApp)
 */
async function getUserDisplayName(bot, group, message, userId) {
	try {
		if (group?.nicks && Array.isArray(group.nicks)) {
			const nickData = group.nicks.find((nick) => nick.numero === userId);
			if (nickData && nickData.apelido) {
				return nickData.apelido;
			}
		}

		if (message && (message.author === userId || message.sender === userId)) {
			const userName =
				message?.name ?? message?.pushName ?? message?.pushname ?? message?.authorName ?? false;
			if (userName) return userName;
		}

		try {
			if (bot?.client?.getContactById) {
				const contact = await bot.client.getContactById(userId);
				if (contact?.pushname || contact?.name) {
					return contact.pushname || contact.name;
				}
			}
		} catch (e) {}

		const cleanPhone = String(userId).split("@")[0];
		return `@${cleanPhone}`;
	} catch (error) {
		return `Usuário_${userId}`;
	}
}

/**
 * Constrói a mensagem visual de uma lista específica (Itens ou Pessoas)
 */
function buildSingleListMessage(list, itemsOrMembers) {
	const listTitle = list.title || list.name;
	const isItems = list.type === "items";

	if (isItems) {
		const items = itemsOrMembers || [];
		const pending = items.filter((it) => !it.checked);
		const completed = items.filter((it) => it.checked);
		const total = items.length;
		const percent = total > 0 ? Math.round((completed.length / total) * 100) : 0;
		const filled = Math.round(percent / 10);
		const bar = "▓".repeat(filled) + "░".repeat(10 - filled);

		let text = `🛒 *Lista de Compras/Itens — ${listTitle}*\n`;
		text += `━━━━━━━━━━━━━━━━━━━━━━\n`;

		if (items.length === 0) {
			text += `_A lista está vazia! Responda a esta mensagem com !add <itens> para adicionar._\n`;
		} else {
			if (pending.length > 0) {
				pending.forEach((item, idx) => {
					const num = idx + 1;
					text += `▫️ ${num}. ${item.item_text}\n`;
				});
			} else {
				text += `🎉 _Todos os itens pendentes foram concluídos!_\n`;
			}

			if (completed.length > 0) {
				text += `\n✅ *Concluídos (${completed.length}):*\n`;
				completed.forEach((item) => {
					const authorTag = item.checked_by_name ? ` _(por ${item.checked_by_name})_` : "";
					text += `• ~${item.item_text}~${authorTag}\n`;
				});
			}
		}

		text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
		text += `📊 *Progresso:* ${completed.length}/${total} concluídos (${percent}%)\n`;
		text += `[${bar}]\n`;
		text += list.admin_only
			? `🔒 *Acesso:* Restrito a Administradores\n`
			: `🔓 *Acesso:* Aberto a todos os membros\n`;

		text += `💡 *Dicas:*\n`;
		text += `• Responda com \`!add <item>\` para adicionar mais itens\n`;
		if (pending.length > 0) {
			const maxReact = Math.min(pending.length, 10);
			text += `• Reaja com ${NUMBER_EMOJIS[0]}-${NUMBER_EMOJIS[maxReact - 1]} para marcar como concluído\n`;
		}
		text += `• Reaja com 🗑️ para esvaziar a lista`;

		return text;
	} else {
		// Lista de Pessoas / Membros
		const members = itemsOrMembers || [];
		let text = `👥 *Lista de Participantes — ${listTitle}*\n`;
		text += `━━━━━━━━━━━━━━━━━━━━━━\n`;

		if (members.length === 0) {
			text += `_Nenhum participante confirmado ainda._\n`;
		} else {
			members.forEach((member, idx) => {
				const num = idx + 1;
				text += `${num}. ⚽ ${member.user_name || member.user_id}\n`;
			});
		}

		text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
		text += `👥 *Total:* ${members.length} confirmado${members.length !== 1 ? "s" : ""}\n`;
		text += list.admin_only
			? `🔒 *Acesso:* Restrito a Administradores\n`
			: `🔓 *Acesso:* Aberto a todos os membros\n`;

		text += `💡 *Dicas:*\n`;
		text += `• Reaja com 1️⃣ ou ⚽ para entrar/sair da lista\n`;
		text += `• Comandos: \`!le ${list.name}\` (entrar) / \`!ls ${list.name}\` (sair)`;

		return text;
	}
}

/**
 * Constrói a mensagem geral com todas as listas ativas no grupo
 */
async function buildOverviewMessage(targetGroup, allLists) {
	if (!allLists || allLists.length === 0) {
		return `Não há listas criadas no grupo ${targetGroup.name || targetGroup.id}. Use !lc <nome> para criar uma lista de pessoas ou !lci <nome> para uma lista de compras/tarefas.`;
	}

	let text = `*Listas disponíveis (${targetGroup.name || targetGroup.id})*\n\n`;

	const itemLists = allLists.filter((l) => l.type === "items");
	const memberLists = allLists.filter((l) => l.type === "members");

	let globalIndex = 0;

	if (itemLists.length > 0) {
		text += `📦 *Listas de Itens / Compras:*\n`;
		for (let i = 0; i < itemLists.length; i++) {
			const list = itemLists[i];
			const emoji =
				globalIndex < NUMBER_EMOJIS.length ? NUMBER_EMOJIS[globalIndex] : `${globalIndex + 1}.`;
			const items = await getListItems(list.id);
			const pending = items.filter((it) => !it.checked).length;
			const done = items.filter((it) => it.checked).length;

			const statusText =
				items.length === 0
					? `vazia`
					: `${pending} pendente${pending !== 1 ? "s" : ""}${done > 0 ? ` / ${done} feito${done !== 1 ? "s" : ""}` : ""}`;

			text += `${emoji} *${list.name}* — ${list.title || list.name} (${statusText})\n`;
			if (items.length > 0) {
				for (let j = 0; j < items.length; j++) {
					const item = items[j];
					const connector = j === items.length - 1 ? "└─" : "├─";
					const itemIcon = item.checked ? "✅" : "▫️";
					const itemText = item.checked ? `~${item.item_text}~` : item.item_text;
					text += `   ${connector} ${itemIcon} ${itemText}\n`;
				}
			}
			if (i < itemLists.length - 1) {
				text += `\n`;
			}
			globalIndex++;
		}
		text += `\n`;
	}

	if (memberLists.length > 0) {
		text += `👥 *Listas de Pessoas / Eventos:*\n`;
		for (let i = 0; i < memberLists.length; i++) {
			const list = memberLists[i];
			const emoji =
				globalIndex < NUMBER_EMOJIS.length ? NUMBER_EMOJIS[globalIndex] : `${globalIndex + 1}.`;
			const members = await getListMembers(list.id);
			const count = members.length;

			text += `${emoji} *${list.name}* — ${list.title || list.name} (${count} membro${count !== 1 ? "s" : ""})\n`;
			if (count > 0) {
				for (let j = 0; j < members.length; j++) {
					const member = members[j];
					const connector = j === members.length - 1 ? "└─" : "├─";
					const name = member.user_name || member.user_id;
					text += `   ${connector} ${name}\n`;
				}
			}
			if (i < memberLists.length - 1) {
				text += `\n`;
			}
			globalIndex++;
		}
		text += `\n`;
	}

	text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
	text += `💡 *Dicas:*\n`;
	text += `• Reaja com o número para interagir ou visualizar uma lista\n`;
	text += `• Digite \`!lista <nome>\` para abrir os detalhes completos\n`;
	text += `• Crie atalhos personalizados com:\n`;
	text += `  \`!g-addCmd compras {cmd-lista compras}\``;

	return text;
}

/**
 * Atualiza via editMessage ou envia nova mensagem com fallback
 */
async function updateOrSendListMessage(bot, chatId, list, text, options = {}) {
	let edited = false;
	const targetMsgId = options.targetMsgId || list?.last_message_id;

	if (targetMsgId && typeof bot.editMessage === "function") {
		try {
			const res = await bot.editMessage(chatId, targetMsgId, text);
			if (res && res.success !== false) {
				edited = true;
				await database
					.dbRun(DB_NAME, "UPDATE list_messages SET updated_at = ? WHERE message_id = ?", [
						Date.now(),
						targetMsgId
					])
					.catch(() => {});
			}
		} catch (err) {
			logger.debug(
				`[updateOrSendListMessage] Falha ao editar mensagem ${targetMsgId}: ${err.message}. Enviando nova.`
			);
		}
	}

	if (!edited) {
		const sentMsgs = await bot.sendReturnMessages(
			new ReturnMessage({
				chatId,
				content: text
			}),
			options.group
		);

		const newMsgId = sentMsgs?.[0]?.id?._serialized || sentMsgs?.[0]?.id?.id || sentMsgs?.[0]?.id;

		if (newMsgId && list?.id) {
			await database
				.dbRun(DB_NAME, "UPDATE lists SET last_message_id = ?, last_chat_id = ? WHERE id = ?", [
					newMsgId,
					chatId,
					list.id
				])
				.catch(() => {});

			await trackListMessage(newMsgId, list.group_id, "single", list.id);
		}

		return { edited: false, messageId: newMsgId, sentMessages: sentMsgs };
	}

	return { edited: true, messageId: targetMsgId };
}

/**
 * Helper para validar se o usuário tem permissão de modificar a lista
 */
async function canModifyList(bot, message, targetGroup, list) {
	if (!list.admin_only) return true;
	if (list.created_by && list.created_by === message.author) return true;
	return await AdminUtils.getInstance().isAdmin(message.author, targetGroup, null, bot);
}

// ─── COMANDOS DE VISUALIZAÇÃO E CONSULTA ───────────────────────────────────

/**
 * Mostra todas as listas disponíveis no grupo (Itens e Pessoas)
 */
async function showLists(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "visualizar listas"
		});
		if (errorResponse) return errorResponse;

		// Se o usuário passou um nome de lista específico (!listas compras ou !lista compras)
		if (args && args.length > 0) {
			return await showSingleList(bot, message, args, group);
		}

		const allLists = await getGroupLists(targetGroup.id);
		const overviewText = await buildOverviewMessage(targetGroup, allLists);

		return new ReturnMessage({
			chatId,
			content: overviewText
		});
	} catch (error) {
		logger.error("Error showing lists:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao mostrar listas. Por favor, tente novamente."
		});
	}
}

/**
 * Mostra uma lista específica em detalhes
 */
async function showSingleList(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "visualizar lista"
		});
		if (errorResponse) return errorResponse;

		if (!args || args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, informe o nome da lista. Exemplo: !lista compras"
			});
		}

		const listName = args[0].trim().toLowerCase();
		const list = await getListByName(targetGroup.id, listName);

		if (!list) {
			return new ReturnMessage({
				chatId,
				content: `Lista "${listName}" não encontrada no grupo.`
			});
		}

		const itemsOrMembers =
			list.type === "items" ? await getListItems(list.id) : await getListMembers(list.id);

		const text = buildSingleListMessage(list, itemsOrMembers);

		const res = await updateOrSendListMessage(bot, chatId, list, text, { group: targetGroup });
		if (!res.edited && res.sentMessages) {
			return [];
		}

		return [];
	} catch (error) {
		logger.error("Error showing single list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao exibir a lista. Por favor, tente novamente."
		});
	}
}

// ─── COMANDOS DE LISTAS DE ITENS (COMPRAS / TAREFAS) ────────────────────────

/**
 * Cria uma nova lista de itens/compras (!lci <nome> [título])
 */
async function createItemList(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "criar lista de itens"
		});
		if (errorResponse) return errorResponse;

		if (!args || args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, informe o nome da lista. Exemplo: !lci compras Mercado da Semana"
			});
		}

		const listName = args[0].trim().toLowerCase();
		const listTitle = args.slice(1).join(" ").trim() || listName;

		const existing = await getListByName(targetGroup.id, listName);
		if (existing) {
			return new ReturnMessage({
				chatId,
				content: `A lista "${args[0].trim()}" já existe neste grupo.`
			});
		}

		await database.dbRun(
			DB_NAME,
			`INSERT INTO lists (group_id, name, title, type, admin_only, created_by, created_at)
			 VALUES (?, ?, ?, 'items', 0, ?, ?)`,
			[targetGroup.id, listName, listTitle, message.author, Date.now()]
		);

		const newList = await getListByName(targetGroup.id, listName);
		const text = buildSingleListMessage(newList, []);

		await updateOrSendListMessage(bot, chatId, newList, text, { group: targetGroup });

		if (message.origin && typeof message.origin.react === "function") {
			await message.origin.react("🛒").catch(() => {});
		}

		return [];
	} catch (error) {
		logger.error("Error creating item list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao criar lista de itens. Por favor, tente novamente."
		});
	}
}

/**
 * Adiciona itens a uma lista (!add [nome] <itens...>)
 * Suporta citação direta da lista ou citação de mensagem com texto
 */
async function addItemsToList(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "adicionar itens à lista"
		});
		if (errorResponse) return errorResponse;

		let targetList = null;
		let rawItemsText = "";
		let quotedMsg = null;

		if (typeof message.origin?.getQuotedMessage === "function") {
			quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		}

		const quotedMsgId = quotedMsg?.id?._serialized || quotedMsg?.id?.id || quotedMsg?.id;

		// 1. Verifica se a mensagem citada é uma lista mapeada no banco
		if (quotedMsgId) {
			const tracked = await getTrackedMessage(quotedMsgId);
			if (tracked && tracked.list_id) {
				targetList = await getListById(tracked.list_id);
			}
		}

		// 2. Se a mensagem citada for uma lista, o corpo dos args contém os itens
		if (targetList && targetList.type === "items") {
			rawItemsText = args.join(" ");
		} else if (quotedMsg && (quotedMsg.body || quotedMsg.caption || quotedMsg.content)) {
			// 3. Usuário citou uma mensagem de texto qualquer e passou o nome da lista no comando
			const quotedText = quotedMsg.body || quotedMsg.caption || quotedMsg.content || "";
			if (args.length > 0) {
				const candidateName = args[0].trim().toLowerCase();
				targetList = await getListByName(targetGroup.id, candidateName);
				if (targetList) {
					rawItemsText = quotedText + "\n" + args.slice(1).join(" ");
				}
			}
			if (!targetList) {
				// Se o grupo tiver apenas 1 lista de itens ativa, assume ela
				const groupItemLists = (await getGroupLists(targetGroup.id)).filter(
					(l) => l.type === "items"
				);
				if (groupItemLists.length === 1) {
					targetList = groupItemLists[0];
					rawItemsText = quotedText + "\n" + args.join(" ");
				}
			}
		} else if (args.length > 0) {
			// 4. Comando direto sem quote: !add compras arroz, feijao
			const candidateName = args[0].trim().toLowerCase();
			targetList = await getListByName(targetGroup.id, candidateName);
			if (targetList) {
				rawItemsText = args.slice(1).join(" ");
			} else {
				// Fallback: se houver apenas 1 lista de itens ativa no grupo
				const groupItemLists = (await getGroupLists(targetGroup.id)).filter(
					(l) => l.type === "items"
				);
				if (groupItemLists.length === 1) {
					targetList = groupItemLists[0];
					rawItemsText = args.join(" ");
				}
			}
		}

		if (!targetList) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, indique a lista ou responda à mensagem de uma lista de compras. Exemplo: `!add compras Arroz, Feijão, Macarrão`"
			});
		}

		if (targetList.type !== "items") {
			return new ReturnMessage({
				chatId,
				content: `A lista "${targetList.name}" é uma lista de pessoas, não de itens. Para entrar nela use !le ${targetList.name}.`
			});
		}

		// Validação de permissão
		const allowed = await canModifyList(bot, message, targetGroup, targetList);
		if (!allowed) {
			if (message.origin && typeof message.origin.react === "function") {
				await message.origin.react("⛔").catch(() => {});
			}
			return new ReturnMessage({
				chatId,
				content: `⛔ A lista "${targetList.title || targetList.name}" está restrita a administradores.`
			});
		}

		const parsedItems = parseItemsFromText(rawItemsText);
		if (parsedItems.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Nenhum item válido identificado. Separe itens por vírgula, ponto e vírgula ou Enter."
			});
		}

		const authorName = await getUserDisplayName(bot, targetGroup, message, message.author);

		for (const itemText of parsedItems) {
			await database.dbRun(
				DB_NAME,
				`INSERT INTO list_items (list_id, item_text, checked, added_by, added_by_name, added_at)
				 VALUES (?, ?, 0, ?, ?, ?)`,
				[targetList.id, itemText, message.author, authorName, Date.now()]
			);
		}

		// Atualiza mensagem in-place
		const updatedItems = await getListItems(targetList.id);
		const newContent = buildSingleListMessage(targetList, updatedItems);

		await updateOrSendListMessage(bot, chatId, targetList, newContent, {
			group: targetGroup,
			targetMsgId: quotedMsgId && trackedListIsSelf(targetList, quotedMsgId) ? quotedMsgId : null
		});

		if (message.origin && typeof message.origin.react === "function") {
			await message.origin.react("✅").catch(() => {});
		}

		return [];
	} catch (error) {
		logger.error("Error adding items to list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao adicionar itens à lista. Por favor, tente novamente."
		});
	}
}

function trackedListIsSelf(targetList, msgId) {
	return targetList.last_message_id === msgId;
}

/**
 * Marca um item pendente como concluído e o move para o fim da lista (!check [nome] <número>)
 */
async function toggleCheckItem(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "marcar item de lista"
		});
		if (errorResponse) return errorResponse;

		let targetList = null;
		let itemNum = null;
		let quotedMsg = null;

		if (typeof message.origin?.getQuotedMessage === "function") {
			quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		}

		const quotedMsgId = quotedMsg?.id?._serialized || quotedMsg?.id?.id || quotedMsg?.id;

		if (quotedMsgId) {
			const tracked = await getTrackedMessage(quotedMsgId);
			if (tracked && tracked.list_id) {
				targetList = await getListById(tracked.list_id);
			}
		}

		if (targetList && args.length > 0) {
			itemNum = parseInt(args[0], 10);
		} else if (args.length >= 2) {
			targetList = await getListByName(targetGroup.id, args[0]);
			itemNum = parseInt(args[1], 10);
		} else if (args.length === 1) {
			const groupItemLists = (await getGroupLists(targetGroup.id)).filter(
				(l) => l.type === "items"
			);
			if (groupItemLists.length === 1) {
				targetList = groupItemLists[0];
				itemNum = parseInt(args[0], 10);
			}
		}

		if (!targetList || isNaN(itemNum)) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, indique a lista e o número do item. Exemplo: `!check compras 1` ou responda à lista com `!check 1`."
			});
		}

		const allowed = await canModifyList(bot, message, targetGroup, targetList);
		if (!allowed) {
			if (message.origin && typeof message.origin.react === "function") {
				await message.origin.react("⛔").catch(() => {});
			}
			return new ReturnMessage({
				chatId,
				content: `⛔ A lista "${targetList.title || targetList.name}" está restrita a administradores.`
			});
		}

		const pendingItems = await database.dbAll(
			DB_NAME,
			"SELECT * FROM list_items WHERE list_id = ? AND checked = 0 ORDER BY id ASC",
			[targetList.id]
		);

		if (itemNum < 1 || itemNum > pendingItems.length) {
			return new ReturnMessage({
				chatId,
				content: `Item número ${itemNum} não encontrado entre os itens pendentes.`
			});
		}

		const targetItem = pendingItems[itemNum - 1];
		const userName = await getUserDisplayName(bot, targetGroup, message, message.author);

		// Marca como concluído
		await database.dbRun(
			DB_NAME,
			"UPDATE list_items SET checked = 1, checked_by = ?, checked_by_name = ?, checked_at = ? WHERE id = ?",
			[message.author, userName, Date.now(), targetItem.id]
		);

		const updatedItems = await getListItems(targetList.id);
		const newContent = buildSingleListMessage(targetList, updatedItems);

		await updateOrSendListMessage(bot, chatId, targetList, newContent, { group: targetGroup });

		if (message.origin && typeof message.origin.react === "function") {
			await message.origin.react("✅").catch(() => {});
		}

		return [];
	} catch (error) {
		logger.error("Error toggling check item:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao marcar item da lista. Por favor, tente novamente."
		});
	}
}

/**
 * Desmarca um item concluído e o devolve aos pendentes (!uncheck [nome] <termo>)
 */
async function uncheckItem(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "desmarcar item de lista"
		});
		if (errorResponse) return errorResponse;

		let targetList = null;
		let query = "";
		let quotedMsg = null;

		if (typeof message.origin?.getQuotedMessage === "function") {
			quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		}

		const quotedMsgId = quotedMsg?.id?._serialized || quotedMsg?.id?.id || quotedMsg?.id;

		if (quotedMsgId) {
			const tracked = await getTrackedMessage(quotedMsgId);
			if (tracked && tracked.list_id) {
				targetList = await getListById(tracked.list_id);
			}
		}

		if (targetList && args.length > 0) {
			query = args.join(" ").trim();
		} else if (args.length >= 2) {
			targetList = await getListByName(targetGroup.id, args[0]);
			query = args.slice(1).join(" ").trim();
		} else if (args.length === 1) {
			const groupItemLists = (await getGroupLists(targetGroup.id)).filter(
				(l) => l.type === "items"
			);
			if (groupItemLists.length === 1) {
				targetList = groupItemLists[0];
				query = args[0].trim();
			}
		}

		if (!targetList || !query) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, indique a lista e o nome do item concluído. Exemplo: `!uncheck compras café` ou responda à lista com `!uncheck café`."
			});
		}

		const allowed = await canModifyList(bot, message, targetGroup, targetList);
		if (!allowed) {
			if (message.origin && typeof message.origin.react === "function") {
				await message.origin.react("⛔").catch(() => {});
			}
			return new ReturnMessage({
				chatId,
				content: `⛔ A lista "${targetList.title || targetList.name}" está restrita a administradores.`
			});
		}

		const completedItems = await database.dbAll(
			DB_NAME,
			"SELECT * FROM list_items WHERE list_id = ? AND checked = 1 ORDER BY checked_at DESC",
			[targetList.id]
		);

		const foundItem = completedItems.find((it) =>
			it.item_text.toLowerCase().includes(query.toLowerCase())
		);

		if (!foundItem) {
			return new ReturnMessage({
				chatId,
				content: `Nenhum item concluído correspondente a "${query}" foi encontrado.`
			});
		}

		await database.dbRun(
			DB_NAME,
			"UPDATE list_items SET checked = 0, checked_by = NULL, checked_by_name = NULL, checked_at = NULL WHERE id = ?",
			[foundItem.id]
		);

		const updatedItems = await getListItems(targetList.id);
		const newContent = buildSingleListMessage(targetList, updatedItems);

		await updateOrSendListMessage(bot, chatId, targetList, newContent, { group: targetGroup });

		if (message.origin && typeof message.origin.react === "function") {
			await message.origin.react("↩️").catch(() => {});
		}

		return [];
	} catch (error) {
		logger.error("Error unchecking item:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao desmarcar item da lista. Por favor, tente novamente."
		});
	}
}

/**
 * Remove um item específico da lista (!rem [nome] <número>)
 */
async function removeItemFromList(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "remover item da lista"
		});
		if (errorResponse) return errorResponse;

		let targetList = null;
		let itemNum = null;
		let quotedMsg = null;

		if (typeof message.origin?.getQuotedMessage === "function") {
			quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		}

		const quotedMsgId = quotedMsg?.id?._serialized || quotedMsg?.id?.id || quotedMsg?.id;

		if (quotedMsgId) {
			const tracked = await getTrackedMessage(quotedMsgId);
			if (tracked && tracked.list_id) {
				targetList = await getListById(tracked.list_id);
			}
		}

		if (targetList && args.length > 0) {
			itemNum = parseInt(args[0], 10);
		} else if (args.length >= 2) {
			targetList = await getListByName(targetGroup.id, args[0]);
			itemNum = parseInt(args[1], 10);
		} else if (args.length === 1) {
			const groupItemLists = (await getGroupLists(targetGroup.id)).filter(
				(l) => l.type === "items"
			);
			if (groupItemLists.length === 1) {
				targetList = groupItemLists[0];
				itemNum = parseInt(args[0], 10);
			}
		}

		if (!targetList || isNaN(itemNum)) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, indique a lista e o número do item a remover. Exemplo: `!rem compras 1` ou responda à lista com `!rem 1`."
			});
		}

		const allowed = await canModifyList(bot, message, targetGroup, targetList);
		if (!allowed) {
			if (message.origin && typeof message.origin.react === "function") {
				await message.origin.react("⛔").catch(() => {});
			}
			return new ReturnMessage({
				chatId,
				content: `⛔ A lista "${targetList.title || targetList.name}" está restrita a administradores.`
			});
		}

		const pendingItems = await database.dbAll(
			DB_NAME,
			"SELECT * FROM list_items WHERE list_id = ? AND checked = 0 ORDER BY id ASC",
			[targetList.id]
		);

		if (itemNum < 1 || itemNum > pendingItems.length) {
			return new ReturnMessage({
				chatId,
				content: `Item número ${itemNum} não encontrado entre os itens pendentes.`
			});
		}

		const targetItem = pendingItems[itemNum - 1];
		await database.dbRun(DB_NAME, "DELETE FROM list_items WHERE id = ?", [targetItem.id]);

		const updatedItems = await getListItems(targetList.id);
		const newContent = buildSingleListMessage(targetList, updatedItems);

		await updateOrSendListMessage(bot, chatId, targetList, newContent, { group: targetGroup });

		if (message.origin && typeof message.origin.react === "function") {
			await message.origin.react("🗑️").catch(() => {});
		}

		return [];
	} catch (error) {
		logger.error("Error removing item from list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao remover item da lista. Por favor, tente novamente."
		});
	}
}

/**
 * Limpa todos os itens de uma lista (!limpar [nome])
 */
async function clearList(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "limpar lista"
		});
		if (errorResponse) return errorResponse;

		let targetList = null;
		let quotedMsg = null;

		if (typeof message.origin?.getQuotedMessage === "function") {
			quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		}

		const quotedMsgId = quotedMsg?.id?._serialized || quotedMsg?.id?.id || quotedMsg?.id;

		if (quotedMsgId) {
			const tracked = await getTrackedMessage(quotedMsgId);
			if (tracked && tracked.list_id) {
				targetList = await getListById(tracked.list_id);
			}
		}

		if (!targetList && args.length > 0) {
			targetList = await getListByName(targetGroup.id, args[0]);
		} else if (!targetList) {
			const groupLists = await getGroupLists(targetGroup.id);
			if (groupLists.length === 1) {
				targetList = groupLists[0];
			}
		}

		if (!targetList) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, indique qual lista deseja limpar. Exemplo: `!limpar compras` ou responda à mensagem da lista."
			});
		}

		const allowed = await canModifyList(bot, message, targetGroup, targetList);
		if (!allowed) {
			if (message.origin && typeof message.origin.react === "function") {
				await message.origin.react("⛔").catch(() => {});
			}
			return new ReturnMessage({
				chatId,
				content: `⛔ A lista "${targetList.title || targetList.name}" está restrita a administradores.`
			});
		}

		if (targetList.type === "items") {
			await database.dbRun(DB_NAME, "DELETE FROM list_items WHERE list_id = ?", [targetList.id]);
		} else {
			await database.dbRun(DB_NAME, "DELETE FROM list_members WHERE list_id = ?", [targetList.id]);
		}

		const updatedItemsOrMembers =
			targetList.type === "items"
				? await getListItems(targetList.id)
				: await getListMembers(targetList.id);

		const newContent = buildSingleListMessage(targetList, updatedItemsOrMembers);
		await updateOrSendListMessage(bot, chatId, targetList, newContent, { group: targetGroup });

		if (message.origin && typeof message.origin.react === "function") {
			await message.origin.react("🧹").catch(() => {});
		}

		return [];
	} catch (error) {
		logger.error("Error clearing list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao limpar lista. Por favor, tente novamente."
		});
	}
}

/**
 * Altera a permissão de uma lista (!lp <nome> <todos|admin>)
 */
async function setListPermission(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "definir permissão da lista"
		});
		if (errorResponse) return errorResponse;

		if (args.length < 2) {
			return new ReturnMessage({
				chatId,
				content: "Uso: `!lp <nome> <todos|admin>`. Exemplo: `!lp compras admin`"
			});
		}

		const listName = args[0].trim().toLowerCase();
		const mode = args[1].trim().toLowerCase();

		const list = await getListByName(targetGroup.id, listName);
		if (!list) {
			return new ReturnMessage({
				chatId,
				content: `Lista "${listName}" não encontrada.`
			});
		}

		const isCreator = list.created_by && list.created_by === message.author;
		const isAdmin = await AdminUtils.getInstance().isAdmin(message.author, targetGroup, null, bot);

		if (!isCreator && !isAdmin) {
			return new ReturnMessage({
				chatId,
				content:
					"Apenas administradores do grupo ou o criador da lista podem alterar suas permissões."
			});
		}

		const adminOnly = ["admin", "admins", "restrito", "fechado"].includes(mode) ? 1 : 0;
		await database.dbRun(DB_NAME, "UPDATE lists SET admin_only = ? WHERE id = ?", [
			adminOnly,
			list.id
		]);

		list.admin_only = adminOnly;

		const itemsOrMembers =
			list.type === "items" ? await getListItems(list.id) : await getListMembers(list.id);

		const newContent = buildSingleListMessage(list, itemsOrMembers);
		await updateOrSendListMessage(bot, chatId, list, newContent, { group: targetGroup });

		if (message.origin && typeof message.origin.react === "function") {
			await message.origin.react(adminOnly ? "🔒" : "🔓").catch(() => {});
		}

		return new ReturnMessage({
			chatId,
			content: `Permissão da lista "${list.title || list.name}" atualizada para: *${adminOnly ? "Restrito a Administradores" : "Aberto a todos os membros"}*.`
		});
	} catch (error) {
		logger.error("Error setting list permission:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao alterar permissão da lista. Por favor, tente novamente."
		});
	}
}

// ─── COMANDOS CLÁSSICOS DE LISTAS DE PESSOAS (100% RETROCOMPATÍVEL) ────────

/**
 * Cria uma nova lista clássica de pessoas (!lc <nome1> [nome2...])
 */
async function createList(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "criar listas"
		});
		if (errorResponse) return errorResponse;

		if (!args || args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça pelo menos um nome de lista. Exemplo: !lc lista1 lista2"
			});
		}

		const createdLists = [];
		const returnMessages = [];

		for (const arg of args) {
			const listName = arg.trim().toLowerCase();
			if (!listName) continue;

			const existing = await getListByName(targetGroup.id, listName);
			if (existing) {
				returnMessages.push(
					new ReturnMessage({
						chatId,
						content: `Lista "${arg.trim()}" já existe.`
					})
				);
				continue;
			}

			await database.dbRun(
				DB_NAME,
				`INSERT INTO lists (group_id, name, title, type, admin_only, created_by, created_at)
				 VALUES (?, ?, ?, 'members', 0, ?, ?)`,
				[targetGroup.id, listName, arg.trim(), message.author, Date.now()]
			);

			createdLists.push(arg.trim());
		}

		if (createdLists.length > 0) {
			returnMessages.push(
				new ReturnMessage({
					chatId,
					content: `Lista${createdLists.length > 1 ? "s" : ""} criada${
						createdLists.length > 1 ? "s" : ""
					}: ${createdLists.join(", ")}`
				})
			);

			// Exibe o painel atualizado
			const allLists = await getGroupLists(targetGroup.id);
			const overviewText = await buildOverviewMessage(targetGroup, allLists);
			returnMessages.push(
				new ReturnMessage({
					chatId,
					content: overviewText
				})
			);
		}

		return returnMessages.length > 0
			? returnMessages
			: new ReturnMessage({
					chatId,
					content: "Nenhuma lista foi criada."
				});
	} catch (error) {
		logger.error("Error creating list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao criar lista. Por favor, tente novamente."
		});
	}
}

/**
 * Cria uma nova lista clássica com título (!lct <nome> <título>)
 */
async function createListWithTitle(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "criar listas com título"
		});
		if (errorResponse) return errorResponse;

		if (args.length < 2) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça o nome da lista e o título. Exemplo: !lct lista1 Título da Lista"
			});
		}

		const listName = args[0].trim().toLowerCase();
		const listTitle = args.slice(1).join(" ").trim();

		const existing = await getListByName(targetGroup.id, listName);
		if (existing) {
			return new ReturnMessage({
				chatId,
				content: `Lista "${args[0].trim()}" já existe. Use !lt ${args[0].trim()} ${listTitle} para atualizar o título.`
			});
		}

		await database.dbRun(
			DB_NAME,
			`INSERT INTO lists (group_id, name, title, type, admin_only, created_by, created_at)
			 VALUES (?, ?, ?, 'members', 0, ?, ?)`,
			[targetGroup.id, listName, listTitle, message.author, Date.now()]
		);

		const allLists = await getGroupLists(targetGroup.id);
		const overviewText = await buildOverviewMessage(targetGroup, allLists);

		return [
			new ReturnMessage({
				chatId,
				content: `Lista criada: ${listName} (${listTitle})`
			}),
			new ReturnMessage({
				chatId,
				content: overviewText
			})
		];
	} catch (error) {
		logger.error("Error creating list with title:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao criar lista. Por favor, tente novamente."
		});
	}
}

/**
 * Exclui uma ou mais listas (!ld <nome1> [nome2...])
 */
async function deleteList(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "excluir listas"
		});
		if (errorResponse) return errorResponse;

		if (!args || args.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça pelo menos um nome de lista para excluir. Exemplo: !ld lista1 lista2"
			});
		}

		const isAdmin = await AdminUtils.getInstance().isAdmin(message.author, targetGroup, null, bot);
		const deletedLists = [];
		const returnMessages = [];

		for (const arg of args) {
			const listName = arg.trim().toLowerCase();
			if (!listName) continue;

			const list = await getListByName(targetGroup.id, listName);
			if (!list) {
				returnMessages.push(
					new ReturnMessage({
						chatId,
						content: `Lista "${arg.trim()}" não encontrada.`
					})
				);
				continue;
			}

			const isCreator = list.created_by && list.created_by === message.author;
			if (!isCreator && !isAdmin) {
				returnMessages.push(
					new ReturnMessage({
						chatId,
						content: `Apenas administradores ou o criador podem excluir a lista "${arg.trim()}".`
					})
				);
				continue;
			}

			await database.dbRun(DB_NAME, "DELETE FROM list_messages WHERE list_id = ?", [list.id]);
			await database.dbRun(DB_NAME, "DELETE FROM lists WHERE id = ?", [list.id]);
			deletedLists.push(arg.trim());
		}

		if (deletedLists.length > 0) {
			returnMessages.push(
				new ReturnMessage({
					chatId,
					content: `Lista${deletedLists.length > 1 ? "s" : ""} excluída${
						deletedLists.length > 1 ? "s" : ""
					}: ${deletedLists.join(", ")}`
				})
			);

			const remaining = await getGroupLists(targetGroup.id);
			if (remaining.length > 0) {
				const overviewText = await buildOverviewMessage(targetGroup, remaining);
				returnMessages.push(
					new ReturnMessage({
						chatId,
						content: overviewText
					})
				);
			}
		}

		return returnMessages.length > 0
			? returnMessages
			: new ReturnMessage({
					chatId,
					content: "Nenhuma lista foi excluída."
				});
	} catch (error) {
		logger.error("Error deleting list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao excluir lista. Por favor, tente novamente."
		});
	}
}

/**
 * Entra em uma lista de pessoas (!le <nome1> [nome2...])
 */
async function joinList(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "entrar em listas"
		});
		if (errorResponse) return errorResponse;

		if (!args || args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça o nome da lista para entrar. Exemplo: !le lista1"
			});
		}

		const userName = await getUserDisplayName(bot, targetGroup, message, message.author);
		const returnMessages = [];
		let lastUpdatedList = null;

		for (const arg of args) {
			const listName = arg.trim().toLowerCase();
			const list = await getListByName(targetGroup.id, listName);

			if (!list) {
				returnMessages.push(
					new ReturnMessage({
						chatId,
						content: `Lista "${arg.trim()}" não encontrada.`
					})
				);
				continue;
			}

			if (list.type !== "members") {
				returnMessages.push(
					new ReturnMessage({
						chatId,
						content: `A lista "${list.name}" é uma lista de itens. Para adicionar itens use !add ${list.name} <itens>.`
					})
				);
				continue;
			}

			const existingMember = await database.dbGet(
				DB_NAME,
				"SELECT * FROM list_members WHERE list_id = ? AND user_id = ?",
				[list.id, message.author]
			);

			if (existingMember) {
				returnMessages.push(
					new ReturnMessage({
						chatId,
						content: `Você já está na lista "${list.title || list.name}".`
					})
				);
				continue;
			}

			await database.dbRun(
				DB_NAME,
				`INSERT INTO list_members (list_id, user_id, user_name, joined_at)
				 VALUES (?, ?, ?, ?)`,
				[list.id, message.author, userName, Date.now()]
			);

			lastUpdatedList = list;
			returnMessages.push(
				new ReturnMessage({
					chatId,
					content: `${userName} entrou na lista "${list.title || list.name}".`
				})
			);
		}

		if (lastUpdatedList && lastUpdatedList.last_message_id) {
			const members = await getListMembers(lastUpdatedList.id);
			const updatedText = buildSingleListMessage(lastUpdatedList, members);
			await updateOrSendListMessage(bot, chatId, lastUpdatedList, updatedText, {
				group: targetGroup
			});
		}

		// Reexibe painel de listas
		const allLists = await getGroupLists(targetGroup.id);
		const overviewText = await buildOverviewMessage(targetGroup, allLists);
		return [...returnMessages, new ReturnMessage({ chatId, content: overviewText })];
	} catch (error) {
		logger.error("Error joining list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao entrar na lista. Por favor, tente novamente."
		});
	}
}

/**
 * Sai de uma lista de pessoas (!ls <nome1> [nome2...])
 */
async function leaveList(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "sair de listas"
		});
		if (errorResponse) return errorResponse;

		if (!args || args.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça o nome de pelo menos uma lista para sair. Exemplo: !ls lista1 lista2"
			});
		}

		const userName = await getUserDisplayName(bot, targetGroup, message, message.author);
		const leftLists = [];
		const errors = [];
		let lastUpdatedList = null;

		for (const arg of args) {
			const listName = arg.trim().toLowerCase();
			const list = await getListByName(targetGroup.id, listName);

			if (!list) {
				errors.push(`• Lista "${arg.trim()}" não encontrada.`);
				continue;
			}

			if (list.type !== "members") {
				errors.push(`• A lista "${list.name}" é uma lista de itens.`);
				continue;
			}

			const existingMember = await database.dbGet(
				DB_NAME,
				"SELECT * FROM list_members WHERE list_id = ? AND user_id = ?",
				[list.id, message.author]
			);

			if (!existingMember) {
				errors.push(`• Você não está na lista "${list.title || list.name}".`);
				continue;
			}

			await database.dbRun(DB_NAME, "DELETE FROM list_members WHERE list_id = ? AND user_id = ?", [
				list.id,
				message.author
			]);

			lastUpdatedList = list;
			leftLists.push(list.title || list.name);
		}

		if (lastUpdatedList && lastUpdatedList.last_message_id) {
			const members = await getListMembers(lastUpdatedList.id);
			const updatedText = buildSingleListMessage(lastUpdatedList, members);
			await updateOrSendListMessage(bot, chatId, lastUpdatedList, updatedText, {
				group: targetGroup
			});
		}

		const summary =
			leftLists.length > 0
				? `${userName} saiu das listas: ${leftLists.map((name) => `"${name}"`).join(", ")}.`
				: `${userName} não saiu de nenhuma lista.`;

		const errorMsg = errors.length > 0 ? `\n\nErros:\n${errors.join("\n")}` : "";

		const allLists = await getGroupLists(targetGroup.id);
		const overviewText = await buildOverviewMessage(targetGroup, allLists);

		return [
			new ReturnMessage({
				chatId,
				content: summary + errorMsg
			}),
			new ReturnMessage({
				chatId,
				content: overviewText
			})
		];
	} catch (error) {
		logger.error("Error leaving list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao sair da lista. Por favor, tente novamente."
		});
	}
}

/**
 * Altera o título de uma lista (!lt <nome> <novo título>)
 */
async function setListTitle(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "definir título da lista"
		});
		if (errorResponse) return errorResponse;

		if (args.length < 2) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça o nome da lista e o título. Exemplo: !lt lista1 Novo Título"
			});
		}

		const listName = args[0].trim().toLowerCase();
		const listTitle = args.slice(1).join(" ").trim();

		const list = await getListByName(targetGroup.id, listName);
		if (!list) {
			return new ReturnMessage({
				chatId,
				content: `Lista "${listName}" não encontrada.`
			});
		}

		await database.dbRun(DB_NAME, "UPDATE lists SET title = ? WHERE id = ?", [listTitle, list.id]);
		list.title = listTitle;

		const itemsOrMembers =
			list.type === "items" ? await getListItems(list.id) : await getListMembers(list.id);

		const updatedText = buildSingleListMessage(list, itemsOrMembers);
		await updateOrSendListMessage(bot, chatId, list, updatedText, { group: targetGroup });

		const allLists = await getGroupLists(targetGroup.id);
		const overviewText = await buildOverviewMessage(targetGroup, allLists);

		return [
			new ReturnMessage({
				chatId,
				content: `Título da lista "${listName}" atualizado para "${listTitle}".`
			}),
			new ReturnMessage({
				chatId,
				content: overviewText
			})
		];
	} catch (error) {
		logger.error("Error setting list title:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao definir título da lista. Por favor, tente novamente."
		});
	}
}

/**
 * Remove um usuário de uma lista (apenas admin ou criador) (!lr <nome> <identificador>)
 */
async function removeFromList(bot, message, args, group) {
	try {
		await ensureMigrated();
		const {
			targetGroup,
			responseChatId: chatId,
			errorResponse
		} = await GroupContextHelper.resolveGroup(bot, message, group, {
			featureName: "remover usuário de lista"
		});
		if (errorResponse) return errorResponse;

		const isAdmin = await AdminUtils.getInstance().isAdmin(message.author, targetGroup, null, bot);
		if (!isAdmin) {
			return new ReturnMessage({
				chatId,
				content: "Este comando só pode ser usado por administradores do grupo."
			});
		}

		if (args.length < 2) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça o nome da lista e o identificador do participante. Exemplo: !lr lista1 5521987654321"
			});
		}

		const listName = args[0].trim().toLowerCase();
		const userIdentifier = args[1].trim().replace(/\D/g, "");

		const list = await getListByName(targetGroup.id, listName);
		if (!list) {
			return new ReturnMessage({
				chatId,
				content: `Lista "${listName}" não encontrada.`
			});
		}

		const members = await getListMembers(list.id);
		if (members.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `A lista "${list.title || list.name}" não tem membros.`
			});
		}

		const targetMember = members.find(
			(m) =>
				(m.user_id && m.user_id.includes(userIdentifier)) ||
				(m.user_name && m.user_name.includes(userIdentifier))
		);

		if (!targetMember) {
			return new ReturnMessage({
				chatId,
				content: `Usuário com identificador "${userIdentifier}" não encontrado na lista.`
			});
		}

		await database.dbRun(DB_NAME, "DELETE FROM list_members WHERE id = ?", [targetMember.id]);

		const remainingMembers = await getListMembers(list.id);
		const updatedText = buildSingleListMessage(list, remainingMembers);
		await updateOrSendListMessage(bot, chatId, list, updatedText, { group: targetGroup });

		const allLists = await getGroupLists(targetGroup.id);
		const overviewText = await buildOverviewMessage(targetGroup, allLists);

		return [
			new ReturnMessage({
				chatId,
				content: `${targetMember.user_name || "Usuário"} foi removido da lista "${
					list.title || list.name
				}" por um administrador.`
			}),
			new ReturnMessage({
				chatId,
				content: overviewText
			})
		];
	} catch (error) {
		logger.error("Error removing user from list:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao remover usuário da lista. Por favor, tente novamente."
		});
	}
}

// ─── PROCESSADOR DE REAÇÕES (REACTIONS HANDLER) ────────────────────────────

/**
 * Trata reações a mensagens de listas (1️⃣..🔟, 🗑️, 🧹, 🔄, ⚽)
 */
async function processListReaction(bot, message, args, group) {
	try {
		await ensureMigrated();
		if (!message.originReaction) {
			return false;
		}

		const reaction = message.originReaction;
		const rawEmoji = reaction.reaction;

		let emojiIndex = NUMBER_EMOJIS.indexOf(rawEmoji);
		if (emojiIndex === -1) emojiIndex = NUMBER_EMOJIS2.indexOf(rawEmoji);
		if (emojiIndex === -1) emojiIndex = NUMBER_EMOJIS3.indexOf(rawEmoji);

		const isClearEmoji = ["🗑️", "🧹"].includes(rawEmoji);
		const isRefreshEmoji = ["🔄", "📋"].includes(rawEmoji);
		const isSoccerEmoji = ["⚽", "👉"].includes(rawEmoji);

		if (emojiIndex === -1 && !isClearEmoji && !isRefreshEmoji && !isSoccerEmoji) {
			return false;
		}

		const targetMsgId = reaction.msgId?._serialized || reaction.msgId?.id || reaction.msgId;
		if (!targetMsgId) return false;

		// 1. Tenta identificar se a mensagem está registrada no banco
		let tracked = await getTrackedMessage(targetMsgId);

		// 2. Fallback: se não estiver no banco, consulta o cliente para ver se o texto é de lista
		let targetMessage = null;
		if (!tracked && bot.client?.getMessageById) {
			targetMessage = await bot.client.getMessageById(targetMsgId).catch(() => null);
			if (targetMessage && targetMessage.fromMe) {
				const bodyText =
					typeof targetMessage.body === "string"
						? targetMessage.body
						: typeof targetMessage.caption === "string"
							? targetMessage.caption
							: typeof targetMessage.content === "string"
								? targetMessage.content
								: "";

				if (bodyText.toLowerCase().includes("listas disponíveis")) {
					const chat = await targetMessage.getChat().catch(() => null);
					if (chat?.isGroup) {
						tracked = {
							message_id: targetMsgId,
							group_id: chat.id._serialized,
							type: "overview",
							list_id: null
						};
						await trackListMessage(targetMsgId, chat.id._serialized, "overview", null);
					}
				} else if (
					bodyText.includes("Lista de Compras/Itens") ||
					bodyText.includes("Lista de Participantes")
				) {
					const chat = await targetMessage.getChat().catch(() => null);
					if (chat?.isGroup) {
						const groupLists = await getGroupLists(chat.id._serialized);
						for (const gl of groupLists) {
							if (bodyText.includes(gl.name) || (gl.title && bodyText.includes(gl.title))) {
								tracked = {
									message_id: targetMsgId,
									group_id: chat.id._serialized,
									type: "single",
									list_id: gl.id
								};
								await trackListMessage(targetMsgId, chat.id._serialized, "single", gl.id);
								break;
							}
						}
					}
				}
			}
		}

		if (!tracked) {
			return false;
		}

		const groupId = tracked.group_id;
		const senderId = reaction.senderId || message.author;
		const userName = reaction.userName || message.authorName || `Pessoa_${senderId}`;

		// ─── CENÁRIO A: Reação em Painel Geral (Overview) ─────────────────────
		if (tracked.type === "overview") {
			if (emojiIndex === -1) return false;

			const allLists = await getGroupLists(groupId);
			if (emojiIndex >= allLists.length) return false;

			const selectedList = allLists[emojiIndex];

			if (selectedList.type === "members") {
				// Entra ou sai da lista de pessoas
				const existing = await database.dbGet(
					DB_NAME,
					"SELECT * FROM list_members WHERE list_id = ? AND user_id = ?",
					[selectedList.id, senderId]
				);

				if (existing) {
					await database.dbRun(
						DB_NAME,
						"DELETE FROM list_members WHERE list_id = ? AND user_id = ?",
						[selectedList.id, senderId]
					);
				} else {
					await database.dbRun(
						DB_NAME,
						`INSERT INTO list_members (list_id, user_id, user_name, joined_at)
						 VALUES (?, ?, ?, ?)`,
						[selectedList.id, senderId, userName, Date.now()]
					);
				}

				// Atualiza a mensagem da visão geral in-place!
				const refreshedLists = await getGroupLists(groupId);
				const updatedOverview = await buildOverviewMessage({ id: groupId }, refreshedLists);

				if (typeof bot.editMessage === "function") {
					await bot.editMessage(groupId, targetMsgId, updatedOverview).catch(() => {});
				}
				return true;
			} else {
				// Lista de itens: abre a lista específica in-place na mesma mensagem
				const items = await getListItems(selectedList.id);
				const listText = buildSingleListMessage(selectedList, items);

				if (typeof bot.editMessage === "function") {
					await bot.editMessage(groupId, targetMsgId, listText).catch(() => {});
					await database.dbRun(
						DB_NAME,
						"UPDATE list_messages SET type = 'single', list_id = ?, updated_at = ? WHERE message_id = ?",
						[selectedList.id, Date.now(), targetMsgId]
					);
				}
				return true;
			}
		}

		// ─── CENÁRIO B: Reação em Mensagem de Lista Específica ────────────────
		if (tracked.type === "single" && tracked.list_id) {
			const list = await getListById(tracked.list_id);
			if (!list) return false;

			// Ação 1: Limpar lista (🗑️ ou 🧹)
			if (isClearEmoji) {
				const groupData = await bot.eventHandler?.getOrCreateGroup?.(groupId);
				const allowed = await canModifyList(
					bot,
					{ author: senderId },
					groupData?.group || { id: groupId },
					list
				);

				if (!allowed) {
					if (bot.sendReaction) {
						await bot.sendReaction(groupId, targetMsgId, "⛔").catch(() => {});
					}
					return false;
				}

				if (list.type === "items") {
					await database.dbRun(DB_NAME, "DELETE FROM list_items WHERE list_id = ?", [list.id]);
				} else {
					await database.dbRun(DB_NAME, "DELETE FROM list_members WHERE list_id = ?", [list.id]);
				}

				const emptyItems =
					list.type === "items" ? await getListItems(list.id) : await getListMembers(list.id);
				const newText = buildSingleListMessage(list, emptyItems);

				if (typeof bot.editMessage === "function") {
					await bot.editMessage(groupId, targetMsgId, newText).catch(() => {});
				}
				return true;
			}

			// Ação 2: Atualizar / refresh (🔄 ou 📋)
			if (isRefreshEmoji) {
				const itemsOrMembers =
					list.type === "items" ? await getListItems(list.id) : await getListMembers(list.id);
				const newText = buildSingleListMessage(list, itemsOrMembers);

				if (typeof bot.editMessage === "function") {
					await bot.editMessage(groupId, targetMsgId, newText).catch(() => {});
				}
				return true;
			}

			// Ação 3: Reação em Lista de Itens (1️⃣..🔟 para marcar concluído)
			if (list.type === "items") {
				if (emojiIndex === -1) return false;

				const groupData = await bot.eventHandler?.getOrCreateGroup?.(groupId);
				const allowed = await canModifyList(
					bot,
					{ author: senderId },
					groupData?.group || { id: groupId },
					list
				);
				if (!allowed) {
					if (bot.sendReaction) {
						await bot.sendReaction(groupId, targetMsgId, "⛔").catch(() => {});
					}
					return false;
				}

				const pendingItems = await database.dbAll(
					DB_NAME,
					"SELECT * FROM list_items WHERE list_id = ? AND checked = 0 ORDER BY id ASC",
					[list.id]
				);

				if (emojiIndex >= pendingItems.length) return false;

				const targetItem = pendingItems[emojiIndex];

				// Marca como concluído (move pro fim na exibição)
				await database.dbRun(
					DB_NAME,
					"UPDATE list_items SET checked = 1, checked_by = ?, checked_by_name = ?, checked_at = ? WHERE id = ?",
					[senderId, userName, Date.now(), targetItem.id]
				);

				const updatedItems = await getListItems(list.id);
				const newText = buildSingleListMessage(list, updatedItems);

				if (typeof bot.editMessage === "function") {
					await bot.editMessage(groupId, targetMsgId, newText).catch(() => {});
				}
				return true;
			}

			// Ação 4: Reação em Lista de Pessoas (1️⃣ ou ⚽ para entrar/sair)
			if (list.type === "members") {
				if (emojiIndex !== 0 && !isSoccerEmoji) return false;

				const existingMember = await database.dbGet(
					DB_NAME,
					"SELECT * FROM list_members WHERE list_id = ? AND user_id = ?",
					[list.id, senderId]
				);

				if (existingMember) {
					await database.dbRun(
						DB_NAME,
						"DELETE FROM list_members WHERE list_id = ? AND user_id = ?",
						[list.id, senderId]
					);
				} else {
					await database.dbRun(
						DB_NAME,
						`INSERT INTO list_members (list_id, user_id, user_name, joined_at)
						 VALUES (?, ?, ?, ?)`,
						[list.id, senderId, userName, Date.now()]
					);
				}

				const updatedMembers = await getListMembers(list.id);
				const newText = buildSingleListMessage(list, updatedMembers);

				if (typeof bot.editMessage === "function") {
					await bot.editMessage(groupId, targetMsgId, newText).catch(() => {});
				}
				return true;
			}
		}

		return false;
	} catch (error) {
		logger.error("Error processing list reaction:", error);
		return false;
	}
}

// ─── DEFINIÇÃO DOS COMANDOS EXPORTADOS ────────────────────────────────────

const commands = [
	new Command({
		name: "listas",
		description: "Mostra as listas disponíveis no grupo",
		category: "listas",
		group: "llistas",
		reactions: {
			before: "⌛️",
			after: "📋"
		},
		method: showLists
	}),

	new Command({
		name: "ll",
		description: "Alias para comando listas",
		category: "listas",
		group: "llistas",
		reactions: {
			before: "⌛️",
			after: "📋"
		},
		method: showLists
	}),

	new Command({
		name: "lista",
		description: "Exibe detalhes de uma lista específica",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "📋"
		},
		method: showSingleList
	}),

	// ── Comandos de Listas de Pessoas ──
	new Command({
		name: "lc",
		description: "Cria uma nova lista de pessoas",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "➕"
		},
		method: createList
	}),

	new Command({
		name: "lct",
		description: "Cria uma nova lista de pessoas com título",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "➕"
		},
		method: createListWithTitle
	}),

	new Command({
		name: "le",
		description: "Entra em uma lista de pessoas",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "👉"
		},
		method: joinList
	}),

	new Command({
		name: "ls",
		description: "Sai de uma lista de pessoas",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "👈"
		},
		method: leaveList
	}),

	new Command({
		name: "lr",
		description: "Remove um usuário de uma lista (admin only)",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "❌"
		},
		method: removeFromList
	}),

	// ── Comandos de Listas de Itens (Compras / Tarefas) ──
	new Command({
		name: "lci",
		description: "Cria uma lista de compras/itens interativa",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "🛒"
		},
		method: createItemList
	}),

	new Command({
		name: "add",
		description: "Adiciona itens a uma lista (suporta citação de mensagens)",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "➕"
		},
		method: addItemsToList
	}),

	new Command({
		name: "check",
		description: "Marca item pendente como concluído e o move pro final",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "✅"
		},
		method: toggleCheckItem
	}),

	new Command({
		name: "uncheck",
		description: "Desmarca um item concluído e o devolve aos pendentes",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "↩️"
		},
		method: uncheckItem
	}),

	new Command({
		name: "rem",
		description: "Remove um item específico da lista",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "🗑️"
		},
		method: removeItemFromList
	}),

	new Command({
		name: "limpar",
		description: "Limpa todos os itens de uma lista",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "🧹"
		},
		method: clearList
	}),

	// ── Comandos Universais ──
	new Command({
		name: "lt",
		description: "Define título de uma lista",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "✏️"
		},
		method: setListTitle
	}),

	new Command({
		name: "lp",
		description: "Define modo de permissão da lista (todos|admin)",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "🔒"
		},
		method: setListPermission
	}),

	new Command({
		name: "ld",
		description: "Deleta uma lista definitivamente",
		category: "listas",
		reactions: {
			before: "⌛️",
			after: "🧹"
		},
		method: deleteList
	}),

	// ── Helper de Reações ──
	new Command({
		name: "reactionListHelper",
		description: "Invocado apenas pelo ReactionsHandler",
		reactions: {
			trigger: NUMBER_EMOJIS.concat(NUMBER_EMOJIS2, NUMBER_EMOJIS3, [
				"🗑️",
				"🧹",
				"🔄",
				"📋",
				"⚽",
				"👉",
				"👈"
			])
		},
		usage: "",
		hidden: true,
		method: processListReaction
	})
];

const helper = {
	about:
		"Criação e gerenciamento de listas interativas de itens/compras e listas de membros no grupo",
	implementation:
		"Gerencia listas com itens marcáveis, adição dinâmica por citação de mensagens, zero spam com edições in-place e suporte a reações por emoji",
	tags: "listas,lista,compras,tarefas,afazeres,mercado,checklist,votacao,organizacao",
	cmds: [
		{
			cmd: "!listas",
			desc: "Mostra todas as listas ativas no grupo (Itens e Pessoas)",
			usage: ["!listas", "!ll"],
			category: "listas"
		},
		{
			cmd: "!lista",
			desc: "Exibe detalhes completos de uma lista específica",
			usage: ["!lista compras", "!lista fut"],
			category: "listas"
		},
		{
			cmd: "!lci",
			desc: "Cria uma nova lista de itens/compras interativa com checklist",
			usage: ["!lci compras Mercado da Semana", "!lci tarefas"],
			category: "listas"
		},
		{
			cmd: "!add",
			desc: "Adiciona itens a uma lista (suporta citação de mensagens e separação por vírgula ou Enter)",
			usage: [
				"!add compras Arroz, Feijão, Macarrão",
				"!add Leite, Café (respondendo à lista)",
				"!add compras (respondendo a qualquer mensagem com itens)"
			],
			category: "listas"
		},
		{
			cmd: "!check",
			desc: "Marca item pendente como concluído e o move para o final da lista",
			usage: ["!check compras 1", "!check 2 (respondendo à lista)"],
			category: "listas"
		},
		{
			cmd: "!uncheck",
			desc: "Desmarca um item concluído e o devolve para os pendentes",
			usage: ["!uncheck compras café", "!uncheck café"],
			category: "listas"
		},
		{
			cmd: "!rem",
			desc: "Remove um item específico da lista",
			usage: ["!rem compras 1", "!rem 2 (respondendo à lista)"],
			category: "listas"
		},
		{
			cmd: "!limpar",
			desc: "Esvazia todos os itens de uma lista aberta",
			usage: ["!limpar compras", "!limpar (respondendo à lista)"],
			category: "listas"
		},
		{
			cmd: "!lp",
			desc: "Define modo de permissão da lista (todos ou admin)",
			usage: ["!lp compras admin", "!lp compras todos"],
			category: "listas"
		},
		{
			cmd: "!lc",
			desc: "Cria uma nova lista clássica de pessoas",
			usage: ["!lc fut", "!lc churrasco festa"],
			category: "listas"
		},
		{
			cmd: "!lct",
			desc: "Cria uma lista de pessoas com título",
			usage: ["!lct fut Pelada de Quinta"],
			category: "listas"
		},
		{
			cmd: "!le",
			desc: "Entra em uma lista de pessoas",
			usage: ["!le fut"],
			category: "listas"
		},
		{
			cmd: "!ls",
			desc: "Sai de uma lista de pessoas",
			usage: ["!ls fut"],
			category: "listas"
		},
		{
			cmd: "!lt",
			desc: "Altera o título de exibição de uma lista",
			usage: ["!lt compras Feira de Sábado"],
			category: "listas"
		},
		{
			cmd: "!lr",
			desc: "Remove um participante de uma lista (somente administradores)",
			usage: ["!lr fut 5511999999999"],
			category: "listas"
		},
		{
			cmd: "!ld",
			desc: "Exclui uma lista definitivamente",
			usage: ["!ld compras", "!ld lista1 lista2"],
			category: "listas"
		}
	]
};

module.exports = {
	helper,
	commands,
	processListReaction
};
