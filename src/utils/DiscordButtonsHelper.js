/**
 * DiscordButtonsHelper
 *
 * Funções puras que convertem a matriz de botões genérica usada pelo bot
 * ({ text, action | command | value | url, emoji?, style?, disabled? }) em especificações
 * compatíveis com os Message Components oficiais do Discord (Action Rows + Buttons),
 * respeitando os limites da API:
 *  - até 5 botões por Action Row e até 5 Action Rows por mensagem;
 *  - custom_id com até 100 caracteres e único dentro da mensagem;
 *  - label com até 80 caracteres; URL com até 512 caracteres.
 *
 * O custom_id reaproveita o formato compacto do TelegramCallbackManager (c:, m:, w:, f:, r:),
 * de modo que os mesmos handlers de callback funcionam nas duas plataformas.
 */
const TelegramCallbackManager = require("../services/TelegramCallbackManager");
const { normalizeButtonRows, getButtonAction } = require("./InteractiveButtonsHelper");

const DISCORD_LIMITS = Object.freeze({
	maxButtonsPerRow: 5,
	maxRows: 5,
	maxCustomIdLength: 100,
	maxLabelLength: 80,
	maxUrlLength: 512,
	maxContentLength: 2000
});

const STYLE_ALIASES = Object.freeze({
	primary: "Primary",
	blurple: "Primary",
	secondary: "Secondary",
	grey: "Secondary",
	gray: "Secondary",
	success: "Success",
	green: "Success",
	danger: "Danger",
	red: "Danger"
});

const STYLE_BY_NUMBER = Object.freeze({ 1: "Primary", 2: "Secondary", 3: "Success", 4: "Danger" });

/**
 * Codifica uma ação no custom_id de um botão do Discord (máx. 100 caracteres).
 * @param {string|Object} action
 * @returns {string}
 */
function encodeCustomId(action) {
	return TelegramCallbackManager.encode(action, DISCORD_LIMITS.maxCustomIdLength);
}

/**
 * Decodifica o custom_id recebido em uma interação de botão.
 * @param {string} customId
 * @returns {Object|null}
 */
function decodeCustomId(customId) {
	return TelegramCallbackManager.decode(customId);
}

/**
 * Trunca o texto do botão para o limite do Discord sem quebrar emojis (pares substitutos).
 * @param {string} text
 * @param {number} [maxLength]
 * @returns {string}
 */
function truncateLabel(text, maxLength = DISCORD_LIMITS.maxLabelLength) {
	const label = String(text ?? "").trim();
	if (label.length <= maxLength) return label;
	const chars = Array.from(label);
	while (chars.join("").length > maxLength - 1) chars.pop();
	return `${chars.join("").trimEnd()}…`;
}

/**
 * Valida URLs aceitas por botões de link do Discord.
 * @param {string} url
 * @returns {boolean}
 */
function isValidButtonUrl(url) {
	if (typeof url !== "string" || url.length === 0 || url.length > DISCORD_LIMITS.maxUrlLength) {
		return false;
	}
	try {
		const parsed = new URL(url);
		return ["http:", "https:", "discord:"].includes(parsed.protocol);
	} catch {
		return false;
	}
}

/**
 * Resolve o estilo do botão (nome da chave em ButtonStyle).
 * Explícito via btn.style; padrão: Primary para comandos e Secondary para navegação de menus.
 * @param {Object} btn
 * @param {string|Object} action
 * @returns {"Primary"|"Secondary"|"Success"|"Danger"}
 */
function resolveButtonStyle(btn, action) {
	if (typeof btn?.style === "string" && STYLE_ALIASES[btn.style.toLowerCase()]) {
		return STYLE_ALIASES[btn.style.toLowerCase()];
	}
	if (typeof btn?.style === "number" && STYLE_BY_NUMBER[btn.style]) {
		return STYLE_BY_NUMBER[btn.style];
	}
	const isCommand = typeof action === "string" || action?.type === "command";
	return isCommand ? "Primary" : "Secondary";
}

/**
 * Converte um botão genérico em especificação de botão do Discord.
 * @param {Object} btn
 * @param {Set<string>} usedIds - custom_ids já usados na mensagem (devem ser únicos)
 * @returns {Object|null}
 */
function toButtonSpec(btn, usedIds) {
	const label = truncateLabel(btn.text);
	const emoji = btn.emoji || null;
	if (!label && !emoji) return null;

	const base = { label, emoji, disabled: Boolean(btn.disabled) };

	if (btn.url) {
		if (!isValidButtonUrl(btn.url)) return null;
		return { ...base, style: "Link", url: btn.url };
	}

	const action = getButtonAction(btn);
	let customId = encodeCustomId(action);
	if (!customId) return null;

	// O Discord rejeita a mensagem inteira se houver custom_ids repetidos: usa referência única em cache
	if (usedIds.has(customId)) {
		customId = TelegramCallbackManager.storeAction(decodeCustomId(customId) || action);
	}
	usedIds.add(customId);

	return { ...base, style: resolveButtonStyle(btn, action), customId };
}

/**
 * Ajusta a matriz aos limites do Discord: quebra linhas com mais de 5 botões e, se passar de
 * 5 linhas, reorganiza em linhas cheias; o excedente acima de 25 botões é descartado.
 * @param {Array<Array<Object>>} rows
 * @param {Object} [limits]
 * @returns {{ rows: Array<Array<Object>>, dropped: number }}
 */
function fitButtonRows(rows, limits = {}) {
	const maxPerRow = limits.maxButtonsPerRow ?? DISCORD_LIMITS.maxButtonsPerRow;
	const maxRows = limits.maxRows ?? DISCORD_LIMITS.maxRows;

	let fitted = [];
	for (const row of rows) {
		for (let i = 0; i < row.length; i += maxPerRow) {
			fitted.push(row.slice(i, i + maxPerRow));
		}
	}

	let dropped = 0;
	if (fitted.length > maxRows) {
		const flat = fitted.flat();
		fitted = [];
		for (let i = 0; i < flat.length; i += maxPerRow) {
			fitted.push(flat.slice(i, i + maxPerRow));
		}
		if (fitted.length > maxRows) {
			dropped = flat.length - maxRows * maxPerRow;
			fitted = fitted.slice(0, maxRows);
		}
	}

	return { rows: fitted, dropped };
}

/**
 * Divide um texto em páginas de até `maxLength` caracteres, preenchendo cada página com
 * linhas inteiras (linhas maiores que o limite são cortadas). Usado para paginar menus.
 * @param {string} text
 * @param {number} maxLength
 * @returns {string[]}
 */
function paginateText(text, maxLength) {
	const pages = [];
	let current = "";
	const pushCurrent = () => {
		if (current.trim().length > 0) pages.push(current.replace(/\s+$/, ""));
		current = "";
	};

	for (const rawLine of String(text ?? "").split("\n")) {
		let line = rawLine;
		while (line.length > maxLength) {
			pushCurrent();
			pages.push(line.substring(0, maxLength));
			line = line.substring(maxLength);
		}
		const candidate = current ? `${current}\n${line}` : line;
		if (candidate.length > maxLength) {
			pushCurrent();
			current = line;
		} else {
			current = candidate;
		}
	}
	pushCurrent();
	return pages;
}

/**
 * Constrói as especificações de Action Rows/Buttons a partir de botões 1D ou 2D.
 * @param {Array} buttons
 * @returns {{ rows: Array<Array<Object>>, dropped: number }}
 */
function buildDiscordButtonSpecs(buttons) {
	const usedIds = new Set();
	const specRows = normalizeButtonRows(buttons)
		.map((row) => row.map((btn) => toButtonSpec(btn, usedIds)).filter(Boolean))
		.filter((row) => row.length > 0);
	return fitButtonRows(specRows);
}

module.exports = {
	DISCORD_LIMITS,
	encodeCustomId,
	decodeCustomId,
	truncateLabel,
	isValidButtonUrl,
	resolveButtonStyle,
	fitButtonRows,
	paginateText,
	buildDiscordButtonSpecs
};
