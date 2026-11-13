/**
 * Contatos públicos oficiais da Ravena (suporte e números ativos dos bots).
 *
 * Fonte única para o contexto da IA de ajuda (CommandsHelper.getBaseHelpContext e
 * instruções do !ajuda / chat web), evitando números duplicados e desatualizados no código.
 *
 * Os números ativos são derivados das instâncias carregadas do bots.json
 * (Database.botInstances), filtrando bots privados, banidos, VIP, comunitários,
 * que ignoram convites/PV e os de Telegram/Discord. Se nenhuma instância estiver
 * carregada (ex: scripts isolados), usa a lista de fallback abaixo.
 */

/** Número público de suporte oficial (moothz) */
const SUPPORT_PHONE = "555596424307";

/**
 * Fallback quando não há instâncias de bot carregadas no processo.
 * Mantenha em sincronia com os bots públicos do bots.json.
 */
const FALLBACK_PUBLIC_BOTS = [
	{ id: "ravena2", phone: "559887715450" },
	{ id: "ravena5", phone: "555591537296" },
	{ id: "ravena10", phone: "555581024412" }
];

/**
 * Mantém apenas os dígitos de um número/JID (remove sufixo @..., device :NN e símbolos)
 * @param {string|number} value
 * @returns {string}
 */
function cleanPhone(value) {
	if (value === undefined || value === null) return "";
	return String(value).split("@")[0].split(":")[0].replace(/\D/g, "");
}

/**
 * Formata um número brasileiro para exibição: 555596424307 -> "(55) 99642-4307".
 * Celulares com 8 dígitos locais recebem o nono dígito apenas na exibição.
 * @param {string|number} value
 * @returns {string}
 */
function formatBrPhone(value) {
	const digits = cleanPhone(value);
	if (!digits.startsWith("55") || (digits.length !== 12 && digits.length !== 13)) {
		return digits ? `+${digits}` : "";
	}
	const ddd = digits.slice(2, 4);
	let local = digits.slice(4);
	if (local.length === 8 && /^[6-9]/.test(local)) {
		local = `9${local}`;
	}
	const splitAt = local.length - 4;
	return `(${ddd}) ${local.slice(0, splitAt)}-${local.slice(splitAt)}`;
}

/**
 * Link wa.me para um número
 * @param {string|number} value
 * @returns {string}
 */
function waLink(value) {
	return `https://wa.me/${cleanPhone(value)}`;
}

/**
 * Indica se uma instância de bot pode ser divulgada publicamente como "Ravena ativa"
 * @param {Object} bot
 * @returns {boolean}
 */
function isPublicBot(bot) {
	if (!bot || typeof bot !== "object") return false;
	if (bot.useTelegram || bot.useDiscord) return false;
	if (bot.privado || bot.banido || bot.vip || bot.comunitario) return false;
	if (bot.ignoreInvites || bot.ignorePV) return false;
	return cleanPhone(bot.phoneNumber).length >= 10;
}

/**
 * Lista os bots públicos ativos (id + número), derivados das instâncias carregadas.
 * @param {Array<Object>} [botInstances] - Instâncias a considerar (padrão: Database.botInstances)
 * @returns {Array<{ id: string, phone: string, display: string, link: string }>}
 */
function getPublicBotContacts(botInstances) {
	let instances = botInstances;
	if (!Array.isArray(instances)) {
		try {
			instances = require("./Database").getInstance().botInstances;
		} catch (_) {
			instances = [];
		}
	}

	const seen = new Set();
	const derived = [];
	for (const bot of Array.isArray(instances) ? instances : []) {
		if (!isPublicBot(bot)) continue;
		const phone = cleanPhone(bot.phoneNumber);
		if (seen.has(phone)) continue;
		seen.add(phone);
		derived.push({ id: String(bot.id || phone), phone });
	}

	const source = derived.length > 0 ? derived : FALLBACK_PUBLIC_BOTS;
	return source.map((b) => ({
		id: b.id,
		phone: b.phone,
		display: `+55 ${formatBrPhone(b.phone)}`,
		link: waLink(b.phone)
	}));
}

/**
 * Contato de suporte oficial já formatado
 * @returns {{ phone: string, display: string, link: string }}
 */
function getSupportContact() {
	return {
		phone: SUPPORT_PHONE,
		display: formatBrPhone(SUPPORT_PHONE),
		link: waLink(SUPPORT_PHONE)
	};
}

module.exports = {
	SUPPORT_PHONE,
	FALLBACK_PUBLIC_BOTS,
	cleanPhone,
	formatBrPhone,
	waLink,
	isPublicBot,
	getPublicBotContacts,
	getSupportContact
};
