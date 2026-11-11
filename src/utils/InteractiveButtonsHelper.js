/**
 * InteractiveButtonsHelper
 *
 * Funções puras compartilhadas entre os wrappers de plataformas com botões interativos
 * (TelegramBot e DiscordBot). Convertem fluxos que no WhatsApp dependem de reações
 * (ex: 💍 no !mu-roll) em botões clicáveis, e ajudam os handlers de menus interativos
 * a funcionarem nas duas plataformas.
 */

/**
 * Gera botões automáticos para mensagens conhecidas (como rolls de waifus).
 * As ações usam o prefixo "/" do Telegram; no Discord o prefixo é reescrito no clique.
 * @param {Object} options - Opções do ReturnMessage.
 * @returns {Array<Array<Object>>|null}
 */
function generateAutomaticButtons(options) {
	if (!options) return null;

	// 1. Multi-roll de Waifus (options.waifuRolls)
	if (Array.isArray(options.waifuRolls) && options.waifuRolls.length > 0) {
		const availableSlots = options.waifuRolls.filter((s) => {
			if (!s) return false;
			const hasOwner = Boolean(
				s.owner && (typeof s.owner === "string" || s.owner.name || s.owner.id)
			);
			const isMarried = Boolean(s.isMarried || s.character?.isMarried || hasOwner);
			const isAvailable = s.available !== false && Boolean(s.available);
			const isClaimed = Boolean(s.claimed);
			const isInstantMarriage = Boolean(s.instantMarriage);
			const isOwner = Boolean(s.isOwner);

			return isAvailable && !isMarried && !hasOwner && !isOwner && !isClaimed && !isInstantMarriage;
		});
		if (availableSlots.length > 0) {
			const buttons = availableSlots.map((s) => ({
				text: `💍 ${s.slot}`,
				action: { type: "command", value: `/mu-casar ${s.characterId}` }
			}));

			const len = buttons.length;
			if (len <= 4) {
				return [buttons];
			}
			if (len === 5) {
				return [buttons.slice(0, 3), buttons.slice(3, 5)];
			}
			if (len === 6) {
				return [buttons.slice(0, 3), buttons.slice(3, 6)];
			}
			if (len === 7) {
				return [buttons.slice(0, 4), buttons.slice(4, 7)];
			}
			if (len === 8) {
				return [buttons.slice(0, 4), buttons.slice(4, 8)];
			}
			if (len === 9) {
				return [buttons.slice(0, 3), buttons.slice(3, 6), buttons.slice(6, 9)];
			}

			const rows = [];
			for (let i = 0; i < len; i += 3) {
				rows.push(buttons.slice(i, i + 3));
			}
			return rows;
		}
	}

	// 2. Single roll de Waifu (options.waifuCharacterId e opções de disponibilidade)
	if (options.waifuCharacterId) {
		const hasOwner = Boolean(
			options.waifuOwner &&
			(typeof options.waifuOwner === "string" || options.waifuOwner.name || options.waifuOwner.id)
		);
		const isMarried = Boolean(options.waifuIsMarried || hasOwner);
		const isAvailable = options.waifuAvailable !== false && Boolean(options.waifuAvailable);
		const isClaimed = Boolean(options.waifuClaimed);
		const isInstantMarriage = Boolean(options.waifuInstantMarriage);
		const isOwner = Boolean(options.waifuIsOwner);

		if (isAvailable && !isMarried && !hasOwner && !isOwner && !isClaimed && !isInstantMarriage) {
			return [
				[
					{
						text: "💍 Casar",
						action: { type: "command", value: `/mu-casar ${options.waifuCharacterId}` }
					}
				]
			];
		}
	}

	return null;
}

/**
 * Normaliza uma lista de botões 1D ou 2D em uma matriz de linhas, descartando entradas inválidas.
 * @param {Array} buttons
 * @returns {Array<Array<Object>>}
 */
function normalizeButtonRows(buttons) {
	if (!Array.isArray(buttons) || buttons.length === 0) return [];

	const is2D = Array.isArray(buttons[0]);
	const rows = is2D ? buttons : [buttons];

	return rows
		.map((row) => (Array.isArray(row) ? row : [row]).filter((btn) => btn && btn.text))
		.filter((row) => row.length > 0);
}

/**
 * Retorna a ação associada a um botão (aceita os aliases action/command/value).
 * @param {Object} btn
 * @returns {string|Object}
 */
function getButtonAction(btn) {
	return btn?.action || btn?.command || btn?.value || "";
}

/**
 * Reescreve o prefixo de um comando vindo de um botão para o prefixo da plataforma/grupo,
 * convertendo underscores do nome do comando em hífens (ex: "/mu_casar 1" -> "!mu-casar 1").
 * Textos que não começam com "/" ou "!" são retornados sem alteração.
 * @param {string} text
 * @param {string} prefix
 * @returns {string}
 */
function rewriteCommandPrefix(text, prefix = "!") {
	if (typeof text !== "string") return text;
	const match = text.match(/^\s*[/!]([a-zA-Z0-9_-]+)([\s\S]*)$/);
	if (!match) return text;
	const [, cmdName, rest] = match;
	return `${prefix ?? ""}${cmdName.replace(/_/g, "-")}${rest}`;
}

/**
 * Prefixo exibido nos menus interativos: "/" no Telegram, prefixo do grupo/bot no Discord.
 * @param {Object} bot
 * @param {Object} [callbackQuery]
 * @returns {string}
 */
function getMenuCommandPrefix(bot, callbackQuery = null) {
	if (bot?.useDiscord) {
		const prefix = callbackQuery?.commandPrefix ?? bot?.prefix;
		return typeof prefix === "string" ? prefix : "!";
	}
	return "/";
}

/**
 * Adapta um comando escrito no estilo Telegram ("/mu_roll") para exibição na plataforma do bot.
 * No Telegram o texto é mantido intacto.
 * @param {Object} bot
 * @param {string} cmd
 * @param {Object} [callbackQuery]
 * @returns {string}
 */
function formatMenuCommand(bot, cmd, callbackQuery = null) {
	if (!bot?.useDiscord) return cmd;
	return rewriteCommandPrefix(cmd, getMenuCommandPrefix(bot, callbackQuery));
}

/**
 * Edita in-place a mensagem de um menu interativo a partir de um callback de botão.
 * Telegram: formata em HTML e envia inline_keyboard via apiClient.editMessageText (comportamento original).
 * Discord: delega para bot.editInteractiveMessage, que monta os componentes (ActionRow/Button).
 * @param {Object} bot
 * @param {Object} callbackQuery - callback_query do Telegram ou adaptador equivalente do Discord
 * @param {string} text - Texto no formato WhatsApp
 * @param {Array} buttons - Botões 1D/2D ({ text, action })
 * @returns {Promise<any>}
 */
async function editInteractiveMenuMessage(bot, callbackQuery, text, buttons) {
	const message = callbackQuery?.message;
	const chatId = message?.chat?.id;
	const messageId = message?.message_id;

	if (bot?.useDiscord && typeof bot.editInteractiveMessage === "function") {
		return bot.editInteractiveMessage(chatId, messageId, text, buttons, {
			interaction: callbackQuery?.discordInteraction || null,
			menu: callbackQuery?.discordMenu || null
		});
	}

	const formattedText = typeof bot._formatMessage === "function" ? bot._formatMessage(text) : text;
	const inlineKeyboard =
		typeof bot._buildInlineKeyboard === "function" ? bot._buildInlineKeyboard(buttons) : [];

	return bot.apiClient.editMessageText(chatId, messageId, formattedText, {
		parse_mode: "HTML",
		reply_markup: { inline_keyboard: inlineKeyboard }
	});
}

module.exports = {
	generateAutomaticButtons,
	normalizeButtonRows,
	getButtonAction,
	rewriteCommandPrefix,
	getMenuCommandPrefix,
	formatMenuCommand,
	editInteractiveMenuMessage
};
