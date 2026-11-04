// Atualiza o arquivo Menu.js na pasta src/functions

const path = require("path");
const Logger = require("../utils/Logger");
const fs = require("fs").promises;
const Database = require("../utils/Database");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const {
	COMMAND_ORDER,
	CATEGORY_EMOJIS,
	CATEGORY_DESCRIPTIONS,
	CATEGORY_NAMES,
	MENU_INITIAL_COMMANDS,
	MENU_EXCLUDE_FROM_GETTOKNOW
} = require("./MenuOrder");
const logger = new Logger("menu-commands");
const database = Database.getInstance();

const DB_NAME = "cmd_menu";
try {
	database.getSQLiteDb(
		DB_NAME,
		`
		CREATE TABLE IF NOT EXISTS menu_messages (
			message_id       TEXT PRIMARY KEY,
			chat_id          TEXT NOT NULL,
			current_category TEXT DEFAULT 'initial',
			created_at       INTEGER,
			updated_at       INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_menu_messages_chat ON menu_messages(chat_id);
		`,
		true
	);
} catch (dbErr) {
	logger.warn("Erro ao inicializar tabela menu_messages no SQLite:", dbErr);
}

const trackedMenuMessages = new Map();

/**
 * Registra o ID de uma mensagem de menu enviada para controle de edição in-place
 * @param {string|Object} messageId
 * @param {string} chatId
 * @param {string} category
 */
async function recordSentMenuMessage(messageId, chatId, category = "initial") {
	if (!messageId || !chatId) return;
	const cleanId =
		typeof messageId === "object" ? messageId._serialized || messageId.id : String(messageId);
	trackedMenuMessages.set(cleanId, {
		chatId,
		currentCategory: category,
		timestamp: Date.now()
	});

	if (trackedMenuMessages.size > 500) {
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		for (const [key, val] of trackedMenuMessages.entries()) {
			if (val.timestamp < cutoff) trackedMenuMessages.delete(key);
		}
	}

	try {
		await database.dbRun(
			DB_NAME,
			`INSERT OR REPLACE INTO menu_messages (message_id, chat_id, current_category, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
			[cleanId, chatId, category, Date.now(), Date.now()]
		);
	} catch (err) {
		logger.debug(`[recordSentMenuMessage] Erro ao registrar mensagem ${cleanId}: ${err.message}`);
	}
}

/**
 * Verifica se uma mensagem referenciada é uma mensagem do menu !cmd
 * @param {Object} message
 * @param {string} messageId
 * @returns {Promise<boolean>}
 */
async function isMenuMessage(message, messageId) {
	const cleanId = messageId
		? typeof messageId === "object"
			? messageId._serialized || messageId.id
			: String(messageId)
		: null;

	if (cleanId && trackedMenuMessages.has(cleanId)) {
		return true;
	}

	if (cleanId) {
		try {
			const row = await database.dbGet(
				DB_NAME,
				"SELECT * FROM menu_messages WHERE message_id = ?",
				[cleanId]
			);
			if (row) {
				trackedMenuMessages.set(cleanId, {
					chatId: row.chat_id,
					currentCategory: row.current_category,
					timestamp: row.updated_at
				});
				return true;
			}
		} catch (err) {
			logger.debug(`[isMenuMessage] Erro ao consultar SQLite: ${err.message}`);
		}
	}

	const content =
		typeof message?.body === "string"
			? message.body
			: typeof message?.content === "string"
				? message.content
				: typeof message?.caption === "string"
					? message.caption
					: "";

	if (
		content.includes("Comandos") &&
		(content.includes("Reagir à esta mensagem com o emoji da categoria") ||
			content.includes("Comandos em Destaque") ||
			content.includes("Conheça também"))
	) {
		if (cleanId && message?.chatId) {
			await recordSentMenuMessage(cleanId, message.chatId, "initial");
		}
		return true;
	}

	return false;
}

/**
 * Retorna amostra aleatória de comandos de uma categoria
 * @param {Array} commands
 * @param {string} prefix
 * @param {number} count
 * @returns {string}
 */
function getSampleCommands(commands, prefix, count = 5) {
	if (!Array.isArray(commands) || commands.length === 0) return "";
	const visibleCmds = commands.filter((c) => !c.hidden && c.name);
	const seen = new Set();
	const uniqueNames = [];
	for (const c of visibleCmds) {
		const name = c.name?.toLowerCase();
		if (name && !seen.has(name)) {
			seen.add(name);
			uniqueNames.push(c.name);
		}
	}
	const shuffled = [...uniqueNames].sort(() => 0.5 - Math.random());
	const selected = shuffled.slice(0, count);
	return selected.map((name) => `${prefix}${name}`).join(", ");
}

/**
 * Formata os comandos em destaque para o topo do menu inicial
 * @param {Object} bot
 * @param {string} prefix
 * @returns {string}
 */
function getInitialHighlightsText(bot, prefix) {
	let text = `📌 *Comandos em Destaque:*\n`;
	const fixedCommands = bot?.eventHandler?.commandHandler?.fixedCommands?.getAllCommands?.() || [];
	const managementCommands =
		bot?.eventHandler?.commandHandler?.management?.getManagementCommands?.() || {};

	for (const cmdItem of MENU_INITIAL_COMMANDS) {
		const name = cmdItem;
		let desc = "";
		let isMgmt = false;

		if (name.startsWith("g-")) {
			const mgmtKey = name.substring(2);
			if (managementCommands[mgmtKey]) {
				desc = managementCommands[mgmtKey].description || "";
				isMgmt = true;
			}
		} else if (managementCommands[name]) {
			desc = managementCommands[name].description || "";
			isMgmt = true;
		}

		if (!desc) {
			const found = fixedCommands.find(
				(c) =>
					c.name?.toLowerCase() === name.toLowerCase() ||
					(Array.isArray(c.aliases) && c.aliases.includes(name.toLowerCase()))
			);
			if (found) {
				desc = found.description || "";
			}
		}

		const displayTrigger = isMgmt
			? name.startsWith("g-")
				? `${prefix}${name}`
				: `${prefix}g-${name}`
			: `${prefix}${name}`;
		text += `• *${displayTrigger}*${desc ? `: ${desc}` : ""}\n`;
	}
	return text;
}

/**
 * Formata 3 comandos aleatórios para a seção "Conheça também"
 * @param {Object} bot
 * @param {string} prefix
 * @param {number} count
 * @returns {string}
 */
function getGetToKnowText(bot, prefix, count = 3) {
	const fixedCommands = bot?.eventHandler?.commandHandler?.fixedCommands?.getAllCommands?.() || [];
	const excludeSet = new Set([
		...MENU_INITIAL_COMMANDS.map((c) => c.toLowerCase()),
		...MENU_EXCLUDE_FROM_GETTOKNOW.map((c) => c.toLowerCase()),
		"gerenciamento",
		"g"
	]);

	const seen = new Set();
	const eligible = [];

	for (const cmd of fixedCommands) {
		if (cmd.hidden) continue;
		if (!cmd.name) continue;
		const nameLow = cmd.name.toLowerCase();
		if (seen.has(nameLow)) continue;
		seen.add(nameLow);

		if (
			cmd.category &&
			(cmd.category.toLowerCase() === "gerenciamento" || cmd.category.toLowerCase() === "admin")
		) {
			continue;
		}
		if (excludeSet.has(nameLow)) continue;
		if (nameLow.startsWith("cmd-") || nameLow.startsWith("g-")) continue;

		eligible.push(cmd);
	}

	if (eligible.length === 0) return "";

	const shuffled = [...eligible].sort(() => 0.5 - Math.random());
	const selected = shuffled.slice(0, count);

	let text = `\n✨ *Conheça também:*\n`;
	for (const cmd of selected) {
		text += `${formatSingleCommand(cmd, prefix)}\n`;
	}
	return text;
}

/**
 * Lê o arquivo de cabeçalho do menu
 * @returns {Promise<string>} - Conteúdo do cabeçalho
 */
async function readMenuHeader() {
	try {
		const headerPath = path.join(process.cwd(), "data", "textos", "cmd_header.txt");
		const headerContent = await fs.readFile(headerPath, "utf8");
		return headerContent.trim();
	} catch (error) {
		logger.warn("Erro ao ler cabeçalho do menu:", error);
		return "";
	}
}

/**
 * Agrupa comandos por categoria para melhor organização
 * @param {Array} commands - Lista de comandos
 * @returns {Object} - Comandos agrupados por categoria
 */
function groupCommandsByCategory(commands) {
	const categories = {};

	// Inicializa categorias com base no objeto CATEGORY_EMOJIS
	Object.keys(CATEGORY_EMOJIS).forEach((category) => {
		categories[category] = [];
	});

	// Agrupa comandos por categoria
	for (const cmd of commands) {
		// Ignora comandos ocultos
		if (cmd.hidden) continue;

		let category = cmd.category?.toLowerCase() ?? "resto";
		if (category.length < 1) {
			category = "resto";
		}

		// Cria a categoria se não existir
		if (!categories[category]) {
			categories[category] = [];
		}

		categories[category].push(cmd);
	}

	//console.log(Object.keys(categories));
	return categories;
}

async function showCommandsByCategory(bot, message, args, group, explicitCategory = null) {
	try {
		const fullCommand = message.content ? message.content.trim() : "";
		const prefix = group && group.prefix ? group.prefix : bot.prefix;

		let category = explicitCategory ? explicitCategory.toLowerCase() : null;

		if (
			!category &&
			fullCommand.startsWith(`${prefix}cmd-`) &&
			fullCommand.length > prefix.length + 4
		) {
			category = fullCommand.substring(prefix.length + 4).toLowerCase();
		} else if (
			!category &&
			(fullCommand.startsWith(`${prefix}cmd `) || fullCommand === `${prefix}cmd`) &&
			args &&
			args.length > 0
		) {
			category = args[0].toLowerCase().replace(/^cmd-/, "");
		}

		if (!category) {
			return null;
		}

		if (category === "banco") {
			category = "ravenabank";
		}

		// Skip if it's the management commands (already handled by cmd-g)
		if (category === "g" || category === "gerenciamento") {
			return await sendManagementCommandList(bot, message, args, group);
		}

		// Se o usuário pedir cmd-grupo (comandos customizados do grupo)
		if (category === "grupo" && fullCommand === `${prefix}cmd-grupo` && !explicitCategory) {
			return await sendGroupCommandList(bot, message, args, group);
		}

		// ─── VERIFICAÇÃO DE REPLY AO !cmd (EDIÇÃO IN-PLACE) ───
		let quotedMsg = null;
		if (typeof message.origin?.getQuotedMessage === "function") {
			quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		} else if (typeof message.getQuotedMessage === "function") {
			quotedMsg = await message.getQuotedMessage().catch(() => null);
		}

		const directQuotedId = message.quotedMessageId || message.origin?.quotedMessageId;
		const quotedId =
			directQuotedId ||
			(quotedMsg?.id?._serialized
				? quotedMsg.id._serialized
				: quotedMsg?.id?.id
					? quotedMsg.id.id
					: quotedMsg?.id);

		if (quotedMsg || quotedId) {
			const isMenu = await isMenuMessage(quotedMsg, quotedId);
			if (isMenu && typeof bot.editMessage === "function") {
				try {
					const chatId = message.group ?? message.author;
					const newMenuText = await buildMenuText(bot, group, category);
					await bot.editMessage(chatId, quotedId, newMenuText);
					await recordSentMenuMessage(quotedId, chatId, category);
					return null; // Editou in-place com sucesso, sem nova mensagem
				} catch (editError) {
					logger.warn(
						`[showCommandsByCategory] Erro ao editar mensagem citada ${quotedId}: ${editError.message}. Enviando como nova mensagem.`
					);
					// Fallback: continua para envio "solto"
				}
			}
		}

		// ─── ENVIO "SOLTO" DA CATEGORIA ───
		const fixedCommands = bot.eventHandler.commandHandler.fixedCommands.getAllCommands();

		// Filter commands by category with deduplication
		const seenCommands = new Set();
		const commandsInCategory = fixedCommands.filter((cmd) => {
			if (!cmd.category || cmd.category.toLowerCase() !== category || cmd.hidden) {
				return false;
			}
			const cmdKey = cmd.name?.toLowerCase();
			if (cmdKey) {
				if (seenCommands.has(cmdKey)) return false;
				seenCommands.add(cmdKey);
			}
			return true;
		});

		// Get custom commands for this group
		const customCommands = group
			? (await database.getCustomCommands(group.id)).filter(
					(cmd) =>
						cmd.active && !cmd.deleted && cmd.category && cmd.category.toLowerCase() === category
				)
			: [];

		// If no commands found in this category
		if (commandsInCategory.length === 0 && customCommands.length === 0) {
			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: `Nenhum comando encontrado na categoria '${category}'.`
			});
		}

		// Build message
		const emoji = CATEGORY_EMOJIS[category] || "📦";
		const desc = CATEGORY_DESCRIPTIONS[category] || "";
		const displayCategory =
			CATEGORY_NAMES[category] || category.charAt(0).toUpperCase() + category.slice(1);

		let menuText = `${emoji} *Comandos na categoria '${displayCategory}'*\n`;
		if (desc) {
			menuText += `> _${desc}_\n`;
		}
		menuText += "\n";

		// Add fixed commands
		if (commandsInCategory.length > 0) {
			// Group related commands
			const groupedCommands = groupRelatedCommands(commandsInCategory);

			// Sort commands
			const sortedGroups = sortCommands(groupedCommands);

			// Format each command group
			for (const cmdGroup of sortedGroups) {
				if (Array.isArray(cmdGroup) && cmdGroup.length > 1) {
					// Group of related commands
					menuText += `${formatCommandGroup(cmdGroup, prefix)}\n`;
				} else {
					// Individual command
					const cmd = Array.isArray(cmdGroup) ? cmdGroup[0] : cmdGroup;
					menuText += `${formatSingleCommand(cmd, prefix)}\n`;
				}
			}
		}

		// Add custom commands
		if (customCommands.length > 0) {
			if (commandsInCategory.length > 0) {
				menuText += "\n";
			}

			menuText += `*Comandos personalizados na categoria '${category}'*:\n`;

			for (const cmd of customCommands) {
				menuText += `• *${prefix}${cmd.startsWith}*`;

				if (cmd.reactions && cmd.reactions.trigger) {
					menuText += ` (${cmd.reactions.trigger})`;
				}

				if (cmd.description) {
					menuText += `: ${cmd.description}`;
				}

				menuText += "\n";
			}
		}

		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: menuText
		});
	} catch (error) {
		logger.error("Erro ao enviar lista de comandos por categoria:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao recuperar lista de comandos por categoria. Por favor, tente novamente."
		});
	}
}

/**
 * Agrupa comandos que compartilham a mesma propriedade 'group'
 * @param {Array} commands - Lista de comandos de uma categoria
 * @returns {Array} - Lista de grupos de comandos
 */
function groupRelatedCommands(commands) {
	const groupedCommands = [];
	const groups = {};

	// Primeiro, separa comandos por grupo
	for (const cmd of commands) {
		if (cmd.group) {
			if (!groups[cmd.group]) {
				groups[cmd.group] = [];
			}
			groups[cmd.group].push(cmd);
		} else {
			// Comandos sem grupo são tratados individualmente
			groupedCommands.push([cmd]);
		}
	}

	// Adiciona os grupos de comandos à lista final
	for (const groupName in groups) {
		if (groups[groupName].length > 0) {
			// Ordena comandos dentro do grupo pelo nome
			groups[groupName].sort((a, b) => a.name.localeCompare(b.name));
			groupedCommands.push(groups[groupName]);
		}
	}

	return groupedCommands;
}

/**
 * Ordena comandos conforme a ordem definida em COMMAND_ORDER
 * @param {Array} commands - Lista de comandos ou grupos de comandos
 * @returns {Array} - Lista ordenada
 */
function sortCommands(commands) {
	return commands.sort((a, b) => {
		// Obtém o primeiro comando de cada grupo (ou o próprio comando se for individual)
		const cmdA = Array.isArray(a) ? a[0] : a;
		const cmdB = Array.isArray(b) ? b[0] : b;

		const indexA = COMMAND_ORDER.indexOf(cmdA.name);
		const indexB = COMMAND_ORDER.indexOf(cmdB.name);

		// Se ambos estão na lista de ordenação, usa a posição na lista
		if (indexA !== -1 && indexB !== -1) {
			return indexA - indexB;
		}
		// Se apenas um está na lista, este vem primeiro
		if (indexA !== -1) return -1;
		if (indexB !== -1) return 1;

		// Caso contrário, usa ordem alfabética
		return cmdA.name.localeCompare(cmdB.name);
	});
}

/**
 * Formata um grupo de comandos para exibição no menu
 * @param {Array} cmdGroup - Grupo de comandos relacionados
 * @param {string} prefix - Prefixo de comando
 * @returns {string} - String formatada do grupo de comandos
 */
function formatCommandGroup(cmdGroup, prefix) {
	// Usando o primeiro comando para a descrição
	const mainCmd = cmdGroup[0];

	// Formata os nomes de comando com prefixo
	const cmdNames = cmdGroup.map((cmd) => {
		let cmdText = `${prefix}${cmd.name}`;

		// Adiciona aliases se disponíveis
		if (cmd.aliases && Array.isArray(cmd.aliases) && cmd.aliases.length > 0) {
			cmdText += `, ${prefix}${cmd.aliases.join(`, ${prefix}`)}`;
		}

		return cmdText;
	});

	// Junta todos os nomes de comando
	let result = `• *${cmdNames.join(", ")}*`;

	// Adiciona reação se disponível no comando principal
	if (mainCmd.reactions && mainCmd.reactions.trigger) {
		result += ` (${mainCmd.reactions.trigger})`;
	}

	// Adiciona descrição do comando principal
	if (mainCmd.description) {
		result += `: ${mainCmd.description}`;
	}

	return result;
}

/**
 * Formata comando individual para exibição no menu
 * @param {Object} cmd - Objeto de comando
 * @param {string} prefix - Prefixo de comando
 * @returns {string} - String de comando formatada
 */
function formatSingleCommand(cmd, prefix) {
	let result = `• *${prefix}${cmd.name}*`;

	// Adiciona aliases se disponíveis
	if (cmd.aliases && Array.isArray(cmd.aliases) && cmd.aliases.length > 0) {
		result += `, *${prefix}${cmd.aliases.join(`*, *${prefix}`)}*`;
	}

	// Adiciona reação se disponível
	if (cmd.reactions && cmd.reactions.trigger) {
		result += ` (${cmd.reactions.trigger})`;
	}

	// Adiciona descrição
	if (cmd.description) {
		result += `: ${cmd.description}`;
	}

	return result;
}

/**
 * Constrói o texto formatado do menu para WhatsApp (topo dinâmico + lista de categorias)
 * @param {Object} bot
 * @param {Object} group
 * @param {string} activeCategory - 'initial', 'geral', 'jogos', 'gerenciamento', etc.
 * @returns {Promise<string>}
 */
async function buildMenuText(bot, group, activeCategory = "initial") {
	const prefix = group?.prefix || bot?.prefix || "!";
	const header = await readMenuHeader();
	const botDisplayName = bot?.nomeExibir || "Ravenabot";

	let menuText = `🤖 *Comandos ${botDisplayName}*🐦‍⬛\n`;
	if (!group) {
		menuText += `> _PV de *${bot?.nomeExibir || bot.id}*_\n`;
	} else {
		menuText += `> _Grupo ${group.name}_\n`;
	}
	if (header) {
		menuText += header + "\n";
	}

	const mutedCategories =
		group && Array.isArray(group.mutedCategories) ? group.mutedCategories : [];
	const mutedCommands = group && Array.isArray(group.mutedCommands) ? group.mutedCommands : [];

	// Obtém comandos fixos deduplicados
	const seenFixedCmds = new Set();
	const rawFixedCommands =
		bot?.eventHandler?.commandHandler?.fixedCommands?.getAllCommands?.() || [];
	const fixedCommands = rawFixedCommands.filter((cmd) => {
		const cmdKey = cmd.name?.toLowerCase();
		if (cmdKey) {
			if (seenFixedCmds.has(cmdKey)) return false;
			seenFixedCmds.add(cmdKey);
		}
		if (cmd.category && mutedCategories.includes(cmd.category.toLowerCase())) return false;
		if (mutedCommands.includes(cmd.name)) return false;
		return true;
	});

	// Comandos customizados do grupo
	const customCommands = group
		? (await database.getCustomCommands(group.id)).filter((cmd) => {
				if (!cmd.active || cmd.deleted) return false;
				if (cmd.category && mutedCategories.includes(cmd.category.toLowerCase())) return false;
				return true;
			})
		: [];

	// ─── 1. SEÇÃO DO TOPO (activeCategory) ───
	if (activeCategory === "initial") {
		menuText += "\n" + getInitialHighlightsText(bot, prefix);
		menuText += getGetToKnowText(bot, prefix, 3);
	} else if (activeCategory === "g" || activeCategory === "gerenciamento") {
		menuText += `\n⚙️ *Gerenciamento:*\n`;
		const desc = CATEGORY_DESCRIPTIONS.gerenciamento;
		if (desc) menuText += `> _${desc}_\n\n`;

		const managementCommands =
			bot?.eventHandler?.commandHandler?.management?.getManagementCommands?.() || {};
		const sortedCmdNames = Object.keys(managementCommands).sort((a, b) => {
			const indexA = COMMAND_ORDER.indexOf(a);
			const indexB = COMMAND_ORDER.indexOf(b);
			if (indexA !== -1 && indexB !== -1) return indexA - indexB;
			if (indexA !== -1) return -1;
			if (indexB !== -1) return 1;
			return a.localeCompare(b);
		});
		for (const cmdName of sortedCmdNames) {
			const cmdInfo = managementCommands[cmdName];
			menuText += `• *${prefix}g-${cmdName}*: ${cmdInfo.description}\n`;
		}
	} else {
		const catKey = activeCategory.toLowerCase();
		const emoji = CATEGORY_EMOJIS[catKey] || "📦";
		const catDisplayName =
			CATEGORY_NAMES[catKey] || catKey.charAt(0).toUpperCase() + catKey.slice(1);
		const desc = CATEGORY_DESCRIPTIONS[catKey];

		menuText += `\n${emoji} *${catDisplayName}:*\n`;
		if (desc) menuText += `> _${desc}_\n\n`;

		const commandsInCategory = fixedCommands.filter(
			(cmd) => cmd.category && cmd.category.toLowerCase() === catKey && !cmd.hidden
		);
		const customInCategory = customCommands.filter(
			(cmd) => cmd.category && cmd.category.toLowerCase() === catKey
		);

		if (commandsInCategory.length > 0) {
			const groupedCommands = groupRelatedCommands(commandsInCategory);
			const sortedGroups = sortCommands(groupedCommands);
			for (const cmdGroup of sortedGroups) {
				if (Array.isArray(cmdGroup) && cmdGroup.length > 1) {
					menuText += `${formatCommandGroup(cmdGroup, prefix)}\n`;
				} else {
					const cmd = Array.isArray(cmdGroup) ? cmdGroup[0] : cmdGroup;
					menuText += `${formatSingleCommand(cmd, prefix)}\n`;
				}
			}
		}

		if (customInCategory.length > 0) {
			if (commandsInCategory.length > 0) menuText += "\n";
			menuText += `*Comandos personalizados:*\n`;
			for (const cmd of customInCategory) {
				menuText += `• *${prefix}${cmd.startsWith}*`;
				if (cmd.reactions && cmd.reactions.trigger) menuText += ` (${cmd.reactions.trigger})`;
				if (cmd.description) menuText += `: ${cmd.description}`;
				menuText += "\n";
			}
		}

		if (commandsInCategory.length === 0 && customInCategory.length === 0) {
			menuText += `_Nenhum comando disponível nesta categoria._\n`;
		}
	}

	// ─── 2. SEÇÃO DE CATEGORIAS (HEADERS INFERIORES) ───
	menuText += `\n> Reagir à esta mensagem com o emoji da categoria pra listar os comandos\n\n`;

	const categorized = groupCommandsByCategory(fixedCommands);
	const allCatKeys = Object.keys(CATEGORY_EMOJIS);

	for (const cat of allCatKeys) {
		if (mutedCategories.includes(cat.toLowerCase())) continue;

		const emoji = CATEGORY_EMOJIS[cat] || "📦";
		const catDisplayName = CATEGORY_NAMES[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
		const desc = CATEGORY_DESCRIPTIONS[cat] || "";
		const catCmds = categorized[cat] || [];

		// Se a categoria não tem comandos visíveis, pula (exceto geral)
		if (catCmds.length === 0 && cat !== "geral") continue;

		const samples = getSampleCommands(catCmds, prefix, 5);

		menuText += `${emoji} *${catDisplayName}*${desc ? ` - ${desc}` : ""}\n`;
		if (samples) {
			menuText += `${samples}\n`;
		}
		menuText += `${prefix}cmd-${cat} para ver todos\n\n`;
	}

	// Gerenciamento no final
	if (!mutedCategories.includes("gerenciamento") && !mutedCategories.includes("g")) {
		const mgmtCommands =
			bot?.eventHandler?.commandHandler?.management?.getManagementCommands?.() || {};
		const mgmtNames = Object.keys(mgmtCommands);
		const shuffledMgmt = [...mgmtNames].sort(() => 0.5 - Math.random()).slice(0, 5);
		const mgmtSamples = shuffledMgmt.map((n) => `${prefix}g-${n}`).join(", ");
		const mgmtDesc =
			CATEGORY_DESCRIPTIONS.gerenciamento || "Administração e configurações do grupo";

		menuText += `⚙️ *Gerenciamento* - ${mgmtDesc}\n`;
		if (mgmtSamples) {
			menuText += `${mgmtSamples}\n`;
		}
		menuText += `${prefix}cmd-g para ver todos\n`;
	}

	// 3. Informações sobre itens ignorados/silenciados
	if (mutedCategories.length > 0 || mutedCommands.length > 0) {
		menuText += "\n🚫 *Ignorados/Silenciados:*\n";
		if (mutedCategories.length > 0) {
			menuText += `• *Categorias:* ${mutedCategories.join(", ")}\n`;
		}
		if (mutedCommands.length > 0) {
			menuText += `• *Comandos:* ${mutedCommands.join(", ")}\n`;
		}
		menuText += `> Use os comandos de gerencia ou o !g-painel para ignorar/designorar comandos e categorias\n`;
	}

	return menuText.trimEnd();
}

/**
 * Envia uma lista de todos os comandos disponíveis
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com a lista de comandos
 */
async function sendCommandList(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		logger.debug(`Enviando lista de comandos para ${chatId}`);

		// Suporte a !cmd <categoria> (ex: !cmd jogos, !cmd ia, !cmd midia, !cmd g)
		if (args && args.length > 0) {
			const targetCat = args[0].toLowerCase().replace(/^cmd-/, "");
			if (
				CATEGORY_EMOJIS[targetCat] ||
				targetCat === "g" ||
				targetCat === "gerenciamento" ||
				targetCat === "grupo" ||
				targetCat === "banco"
			) {
				return await showCommandsByCategory(
					bot,
					message,
					args,
					group,
					targetCat === "banco" ? "ravenabank" : targetCat
				);
			}
		}

		// Para Telegram: menu interativo com botões de categoria e edição in-place
		if (bot && bot.useTelegram) {
			const header = await readMenuHeader();
			const botDisplayName = bot?.nomeExibir || "Ravenabot";
			let menuText = `🤖 *Comandos ${botDisplayName}*🐦‍⬛\n`;
			if (!group) {
				menuText += `> _PV de *${bot?.nomeExibir || bot.id}*_\n`;
			} else {
				menuText += `> _Grupo ${group.name}_\n`;
			}
			menuText += header + "\n";
			menuText += "\n💡 *Navegação Interativa:*\n";
			menuText += "Toque em um botão abaixo para ver os comandos da categoria correspondente:\n";

			const categoryButtons = [];
			const catKeys = Object.keys(CATEGORY_EMOJIS);
			let currentRow = [];

			for (const cat of catKeys) {
				const emoji = CATEGORY_EMOJIS[cat] || "📦";
				const catLabel = CATEGORY_NAMES[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
				currentRow.push({
					text: `${emoji} ${catLabel}`,
					action: { type: "menu", category: cat, page: 0 }
				});

				if (currentRow.length === 3) {
					categoryButtons.push(currentRow);
					currentRow = [];
				}
			}

			if (currentRow.length > 0) {
				currentRow.push({
					text: "⚙️ Gerência",
					action: { type: "menu", category: "gerenciamento", page: 0 }
				});
				categoryButtons.push(currentRow);
			} else {
				categoryButtons.push([
					{
						text: "⚙️ Gerência",
						action: { type: "menu", category: "gerenciamento", page: 0 }
					}
				]);
			}

			return new ReturnMessage({
				chatId,
				content: menuText,
				telegram: {
					buttons: categoryButtons
				}
			});
		}

		// Para WhatsApp / outros:
		// Verifica se foi enviado em resposta (reply) a uma mensagem de menu !cmd: restaura ao estado inicial
		let quotedMsg = null;
		if (typeof message.origin?.getQuotedMessage === "function") {
			quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		} else if (typeof message.getQuotedMessage === "function") {
			quotedMsg = await message.getQuotedMessage().catch(() => null);
		}

		const directQuotedId = message.quotedMessageId || message.origin?.quotedMessageId;
		const quotedId =
			directQuotedId ||
			(quotedMsg?.id?._serialized
				? quotedMsg.id._serialized
				: quotedMsg?.id?.id
					? quotedMsg.id.id
					: quotedMsg?.id);

		if (quotedMsg || quotedId) {
			const isMenu = await isMenuMessage(quotedMsg, quotedId);
			if (isMenu && typeof bot.editMessage === "function") {
				try {
					const newMenuText = await buildMenuText(bot, group, "initial");
					await bot.editMessage(chatId, quotedId, newMenuText);
					await recordSentMenuMessage(quotedId, chatId, "initial");
					return null;
				} catch (editError) {
					logger.warn(
						`[sendCommandList] Erro ao editar mensagem citada ${quotedId}: ${editError.message}. Enviando novo menu.`
					);
				}
			}
		}

		// Constrói o menu interativo com destaques e lista de categorias
		const menuText = await buildMenuText(bot, group, "initial");

		return new ReturnMessage({
			chatId,
			content: menuText,
			options: {
				maxChars: 0,
				maxLines: 0,
				isMenuMessage: true,
				currentCategory: "initial"
			}
		});
	} catch (error) {
		logger.error("Erro ao enviar lista de comandos:", error);
		const chatId = message.group ?? message.author;

		return new ReturnMessage({
			chatId,
			content: "Erro ao recuperar lista de comandos. Por favor, tente novamente."
		});
	}
}

/**
 * Envia uma lista de comandos de gerenciamento disponíveis
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com a lista de comandos de gerenciamento
 */
async function sendManagementCommandList(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		logger.debug(`Enviando lista de comandos de gerenciamento para ${chatId}`);

		// ─── VERIFICAÇÃO DE REPLY AO !cmd (EDIÇÃO IN-PLACE) ───
		let quotedMsg = null;
		if (typeof message.origin?.getQuotedMessage === "function") {
			quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		} else if (typeof message.getQuotedMessage === "function") {
			quotedMsg = await message.getQuotedMessage().catch(() => null);
		}

		const directQuotedId = message.quotedMessageId || message.origin?.quotedMessageId;
		const quotedId =
			directQuotedId ||
			(quotedMsg?.id?._serialized
				? quotedMsg.id._serialized
				: quotedMsg?.id?.id
					? quotedMsg.id.id
					: quotedMsg?.id);

		if (quotedMsg || quotedId) {
			const isMenu = await isMenuMessage(quotedMsg, quotedId);
			if (isMenu && typeof bot.editMessage === "function") {
				try {
					const newMenuText = await buildMenuText(bot, group, "gerenciamento");
					await bot.editMessage(chatId, quotedId, newMenuText);
					await recordSentMenuMessage(quotedId, chatId, "gerenciamento");
					return null;
				} catch (editError) {
					logger.warn(
						`[sendManagementCommandList] Erro ao editar mensagem citada ${quotedId}: ${editError.message}. Enviando como nova mensagem.`
					);
				}
			}
		}

		// Envio solto
		const header = await readMenuHeader();
		const prefix = group && group.prefix ? group.prefix : bot.prefix;

		let menuText = header ? header + "\n\n" : "";
		menuText += "⚙️ *Comandos de Gerenciamento:*\n";
		const desc = CATEGORY_DESCRIPTIONS.gerenciamento;
		if (desc) {
			menuText += `> _${desc}_\n\n`;
		} else {
			menuText += "\n";
		}

		const managementCommands = bot.eventHandler.commandHandler.management.getManagementCommands();

		const sortedCmdNames = Object.keys(managementCommands).sort((a, b) => {
			const indexA = COMMAND_ORDER.indexOf(a);
			const indexB = COMMAND_ORDER.indexOf(b);
			if (indexA !== -1 && indexB !== -1) return indexA - indexB;
			if (indexA !== -1) return -1;
			if (indexB !== -1) return 1;
			return a.localeCompare(b);
		});

		for (const cmdName of sortedCmdNames) {
			const cmdInfo = managementCommands[cmdName];
			menuText += `• *${prefix}g-${cmdName}*: ${cmdInfo.description}\n`;
		}

		return new ReturnMessage({
			chatId,
			content: menuText
		});
	} catch (error) {
		logger.error("Erro ao enviar lista de comandos de gerenciamento:", error);
		const chatId = message.group ?? message.author;

		return new ReturnMessage({
			chatId,
			content: "Erro ao recuperar lista de comandos de gerenciamento. Por favor, tente novamente."
		});
	}
}

/**
 * Trata reações de emoji a mensagens do menu !cmd para navegação interativa
 * @param {Object} bot
 * @param {Object} message
 * @param {Array} args
 * @param {Object} group
 * @returns {Promise<boolean>}
 */
async function processMenuReaction(bot, message, args, group) {
	try {
		if (!message.originReaction) {
			return false;
		}

		const reaction = message.originReaction;
		const rawEmoji = reaction.reaction;
		if (!rawEmoji) return false;

		let selectedCategory = null;
		for (const [cat, emoji] of Object.entries(CATEGORY_EMOJIS)) {
			if (emoji === rawEmoji) {
				selectedCategory = cat;
				break;
			}
		}

		if (!selectedCategory && (rawEmoji === "⚙️" || rawEmoji === "⚙")) {
			selectedCategory = "gerenciamento";
		}

		if (!selectedCategory && (rawEmoji === "🏛️" || rawEmoji === "🏛" || rawEmoji === "🏦")) {
			selectedCategory = "ravenabank";
		}

		if (!selectedCategory) {
			return false;
		}

		const targetMsgId =
			reaction.msgId?._serialized ||
			reaction.msgId?.id ||
			(typeof reaction.msgId === "string" ? reaction.msgId : null) ||
			message.id;

		if (!targetMsgId) return false;

		const isMenu = await isMenuMessage(message, targetMsgId);
		if (!isMenu) {
			return false;
		}

		const tracked = trackedMenuMessages.get(targetMsgId);
		const chatId =
			message.group ||
			reaction.chatId ||
			message.chatId ||
			tracked?.chatId ||
			group?.id ||
			reaction.key?.remoteJID ||
			reaction.key?.remoteJid ||
			message.author;

		if (!chatId) return false;

		if (typeof bot.editMessage === "function") {
			const newMenuText = await buildMenuText(bot, group, selectedCategory);
			await bot.editMessage(chatId, targetMsgId, newMenuText);
			await recordSentMenuMessage(targetMsgId, chatId, selectedCategory);
			return true;
		}

		return false;
	} catch (error) {
		logger.error("Erro ao processar reação no menu:", error);
		return false;
	}
}

/**
 * Envia uma lista de comandos personalizados do grupo
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com a lista de comandos personalizados
 */
async function sendGroupCommandList(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;

		// Verifica se está em um grupo
		if (!group) {
			return new ReturnMessage({
				chatId,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		logger.debug(`Enviando lista de comandos personalizados para o grupo ${group.id}`);

		// Obtém comandos personalizados para este grupo
		const customCommands = (await database.getCustomCommands(group.id)).filter(
			(cmd) => cmd.active && !cmd.deleted
		);

		// Verifica se existem comandos personalizados
		if (customCommands.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"📋 *Comandos Personalizados*\n\nNenhum comando personalizado foi criado para este grupo ainda.\n\nUse `!g-addCmd` respondendo a uma mensagem para criar comandos personalizados."
			});
		}

		// Define o prefixo do comando
		const prefix = group.prefix || bot.prefix;

		// Constrói mensagem
		let menuText = "📋 *Comandos Personalizados do Grupo*\n\n";

		// Ordena comandos por nome
		const sortedCommands = [...customCommands].sort((a, b) =>
			a.startsWith.localeCompare(b.startsWith)
		);

		// Adiciona cada comando personalizado
		for (const cmd of sortedCommands) {
			let cmdText = `• *${prefix}${cmd.startsWith}*`;

			// Adiciona reação se disponível
			if (cmd.react) {
				cmdText += ` (${cmd.react})`;
			} else if (cmd.reactions && cmd.reactions.trigger) {
				cmdText += ` (${cmd.reactions.trigger})`;
			}

			// Adiciona contagem de uso, se disponível
			if (cmd.count) {
				cmdText += ` [Usado ${cmd.count} vezes]`;
			}

			// Adiciona informação sobre respostas
			if (cmd.responses && cmd.responses.length > 0) {
				cmdText += ` - ${cmd.responses.length} resposta(s)`;

				// Verifica se é envio de todas as respostas
				if (cmd.sendAllResponses) {
					cmdText += " (envia todas)";
				}
			}

			menuText += `${cmdText}\n`;
		}

		// Adiciona instruções para gerenciamento
		menuText += "\n*Gerenciamento de Comandos:*\n";
		menuText += `• Use *${prefix}g-addCmd* respondendo a uma mensagem para criar um novo comando\n`;
		menuText += `• Use *${prefix}g-addCmdReply* para adicionar mais respostas a um comando\n`;
		menuText += `• Use *${prefix}g-delCmd* para excluir um comando\n`;

		// Retorna a mensagem com os comandos personalizados
		return new ReturnMessage({
			chatId,
			content: menuText
		});
	} catch (error) {
		logger.error("Erro ao enviar lista de comandos personalizados:", error);
		const chatId = message.group ?? message.author;

		return new ReturnMessage({
			chatId,
			content: "Erro ao recuperar lista de comandos personalizados. Por favor, tente novamente."
		});
	}
}

// Criar array de comandos usando a classe Command
const commands = [
	new Command({
		name: "cmd",
		description: "Mostra todos os comandos disponíveis",
		category: "geral",
		group: "menu",
		method: async (bot, message, args, group) => await sendCommandList(bot, message, args, group)
	}),
	new Command({
		name: "comandos",
		description: "Mostra todos os comandos disponíveis",
		category: "geral",
		group: "menu",
		hidden: true,
		method: async (bot, message, args, group) => await sendCommandList(bot, message, args, group)
	}),

	new Command({
		name: "menu",
		category: "geral",
		group: "menu",
		description: "Mostra todos os comandos disponíveis",
		method: async (bot, message, args, group) => await sendCommandList(bot, message, args, group)
	}),

	new Command({
		name: "info",
		category: "geral",
		group: "menu",
		hidden: true,
		description: "Mostra todos os comandos disponíveis",
		method: async (bot, message, args, group) => await sendCommandList(bot, message, args, group)
	}),
	new Command({
		name: "cmd-gerenciamento",
		description: "Mostra comandos de gerenciamento do grupo",
		category: "geral",
		group: "cmdGer",
		method: async (bot, message, args, group) =>
			await sendManagementCommandList(bot, message, args, group)
	}),

	new Command({
		name: "cmd-g",
		description: "Mostra comandos de gerenciamento do grupo",
		category: "geral",
		group: "cmdGer",
		hidden: true, // Não aparece no menu principal, pois é um alias
		method: async (bot, message, args, group) =>
			await sendManagementCommandList(bot, message, args, group)
	}),

	new Command({
		name: "cmd-grupo",
		description: "Mostra comandos personalizados do grupo",
		category: "geral",
		method: async (bot, message, args, group) =>
			await sendGroupCommandList(bot, message, args, group)
	}),
	new Command({
		name: "cmd-categoria",
		description: "Mostra comandos da categoria informada",
		category: "geral",
		method: async (bot, message, args, group) =>
			new ReturnMessage({
				chatId: message.group ?? message.author,
				content: `🤖 *Categorias disponíveis*:\n\n${Object.keys(CATEGORY_EMOJIS)
					.map((c, v) => `- !cmd-${c}`)
					.join("\n")}`
			})
	})
];

Object.keys(CATEGORY_EMOJIS).forEach((category, v) => {
	commands.push(
		new Command({
			name: `cmd-${category}`,
			description: `Mostra comandos da categoria ${category}`,
			category: "geral",
			hidden: true,
			method: showCommandsByCategory
		})
	);
});

commands.push(
	new Command({
		name: "cmd-banco",
		description: "Mostra comandos do RavenaBank",
		category: "geral",
		hidden: true,
		method: async (bot, message, args, group) =>
			await showCommandsByCategory(bot, message, args, group, "ravenabank")
	})
);

commands.push(
	new Command({
		name: "reactionMenuHelper",
		description: "Invocado apenas pelo ReactionsHandler para navegação do menu por emojis",
		reactions: {
			trigger: [...new Set([...Object.values(CATEGORY_EMOJIS), "⚙️", "⚙", "🏛️", "🏛", "🏦"])]
		},
		usage: "",
		hidden: true,
		method: processMenuReaction
	})
);

const helper = {
	about: "Menu de comandos dinâmico e categorizado com navegação completa",
	implementation:
		"Lê todos os comandos carregados no bot, agrupa por categoria segundo a ordem do MenuOrder.js e formata a resposta",
	tags: "menu,ajuda,comandos,help,lista de comandos,navegacao",
	cmds: [
		{
			cmd: "!cmd",
			desc: "Exibe o menu principal com todas as categorias e comandos do bot",
			usage: ["!cmd", "!cmd jogos", "!cmd ia", "!cmd midia"],
			category: "geral"
		},
		{
			cmd: "!cmd-grupo",
			desc: "Exibe os comandos voltados para o uso no grupo",
			usage: ["!cmd-grupo"],
			category: "geral"
		},
		{
			cmd: "!cmd-gerenciamento",
			desc: "Exibe os comandos de administração e gerenciamento do grupo",
			usage: ["!cmd-gerenciamento"],
			category: "geral"
		}
	]
};

/**
 * Trata callbacks de navegação interativa no menu para o TelegramBot
 * @param {Object} bot - Instância do bot Telegram
 * @param {Object} callbackQuery - Objeto callback_query da API do Telegram
 * @param {string} category - Categoria solicitada ou 'root'
 * @param {number} page - Página atual
 */
async function handleMenuCallback(bot, callbackQuery, category, page = 0) {
	try {
		const message = callbackQuery.message;
		if (!message || !message.chat) return;

		const chatId = message.chat.id;
		const messageId = message.message_id;

		if (category === "root") {
			const header = await readMenuHeader();
			const botDisplayName = bot?.nomeExibir || "Ravenabot";
			let menuText = `🤖 *Comandos ${botDisplayName}*🐦‍⬛\n`;
			if (message.chat.type === "group" || message.chat.type === "supergroup") {
				menuText += `> _Grupo ${message.chat.title || ""}_\n`;
			}
			menuText += header + "\n\n";
			menuText += "💡 *Navegação Interativa:*\n";
			menuText += "Toque em um botão abaixo para ver os comandos da categoria correspondente:\n";

			const categoryButtons = [];
			const catKeys = Object.keys(CATEGORY_EMOJIS);
			let currentRow = [];

			for (const cat of catKeys) {
				const emoji = CATEGORY_EMOJIS[cat] || "📦";
				const customNames = {
					interacao: "Interação",
					integracao: "Interação",
					ia: "IA"
				};
				const catLabel = customNames[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
				currentRow.push({
					text: `${emoji} ${catLabel}`,
					action: { type: "menu", category: cat, page: 0 }
				});

				if (currentRow.length === 3) {
					categoryButtons.push(currentRow);
					currentRow = [];
				}
			}

			if (currentRow.length > 0) {
				currentRow.push({
					text: "⚙️ Gerência",
					action: { type: "menu", category: "gerenciamento", page: 0 }
				});
				categoryButtons.push(currentRow);
			} else {
				categoryButtons.push([
					{
						text: "⚙️ Gerência",
						action: { type: "menu", category: "gerenciamento", page: 0 }
					}
				]);
			}

			const formattedText =
				typeof bot._formatMessage === "function" ? bot._formatMessage(menuText) : menuText;
			const inlineKeyboard =
				typeof bot._buildInlineKeyboard === "function"
					? bot._buildInlineKeyboard(categoryButtons)
					: [];

			await bot.apiClient.editMessageText(chatId, messageId, formattedText, {
				parse_mode: "HTML",
				reply_markup: { inline_keyboard: inlineKeyboard }
			});
			return;
		}

		if (category === "gerenciamento" || category === "g") {
			const managementCommands = bot.eventHandler.commandHandler.management.getManagementCommands();
			const prefix = "/";
			let text = "⚙️ *Comandos de Gerenciamento:*\n\n";
			for (const cmdName of Object.keys(managementCommands).sort()) {
				const cmdInfo = managementCommands[cmdName];
				text += `• *${prefix}g_${cmdName.replace(/-/g, "_")}*: ${cmdInfo.description}\n`;
			}

			const navButtons = [
				[
					{
						text: "⬅️ Voltar ao Menu Principal",
						action: { type: "menu", category: "root", page: 0 }
					}
				]
			];

			const formattedText =
				typeof bot._formatMessage === "function" ? bot._formatMessage(text) : text;
			const inlineKeyboard =
				typeof bot._buildInlineKeyboard === "function" ? bot._buildInlineKeyboard(navButtons) : [];

			await bot.apiClient.editMessageText(chatId, messageId, formattedText, {
				parse_mode: "HTML",
				reply_markup: { inline_keyboard: inlineKeyboard }
			});
			return;
		}

		// Categorias padrão
		const fixedCommands = bot.eventHandler.commandHandler.fixedCommands.getAllCommands();
		const seenCommands = new Set();
		const commandsInCategory = fixedCommands.filter((cmd) => {
			if (!cmd.category || cmd.category.toLowerCase() !== category.toLowerCase() || cmd.hidden) {
				return false;
			}
			const cmdKey = cmd.name?.toLowerCase();
			if (cmdKey) {
				if (seenCommands.has(cmdKey)) return false;
				seenCommands.add(cmdKey);
			}
			return true;
		});

		const emoji = CATEGORY_EMOJIS[category] || "📦";
		const customNames = {
			interacao: "Interação",
			integracao: "Interação",
			ia: "IA"
		};
		const displayCategory =
			customNames[category] || category.charAt(0).toUpperCase() + category.slice(1);
		let categoryText = `${emoji} *Comandos na categoria '${displayCategory}'*\n\n`;

		if (commandsInCategory.length === 0) {
			categoryText += "Nenhum comando encontrado nesta categoria.\n";
		} else {
			const prefix = "/";
			const groupedCommands = groupRelatedCommands(commandsInCategory);
			const sortedGroups = sortCommands(groupedCommands);

			for (const cmdGroup of sortedGroups) {
				if (Array.isArray(cmdGroup) && cmdGroup.length > 1) {
					categoryText += `${formatCommandGroup(cmdGroup, prefix)}\n`;
				} else {
					const cmd = Array.isArray(cmdGroup) ? cmdGroup[0] : cmdGroup;
					categoryText += `${formatSingleCommand(cmd, prefix)}\n`;
				}
			}
		}

		const navButtons = [
			[
				{
					text: "⬅️ Voltar ao Menu Principal",
					action: { type: "menu", category: "root", page: 0 }
				}
			]
		];

		const formattedText =
			typeof bot._formatMessage === "function" ? bot._formatMessage(categoryText) : categoryText;
		const inlineKeyboard =
			typeof bot._buildInlineKeyboard === "function" ? bot._buildInlineKeyboard(navButtons) : [];

		await bot.apiClient.editMessageText(chatId, messageId, formattedText, {
			parse_mode: "HTML",
			reply_markup: { inline_keyboard: inlineKeyboard }
		});
	} catch (err) {
		if (bot.logger && typeof bot.logger.error === "function") {
			bot.logger.error(`[handleMenuCallback] Erro ao editar menu: ${err.message}`, err);
		}
	}
}

module.exports = {
	helper,
	commands,
	handleMenuCallback,
	recordSentMenuMessage,
	buildMenuText,
	isMenuMessage
};
