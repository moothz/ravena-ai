const axios = require("axios");
const Logger = require("./Logger");

const logger = new Logger("profile-picture-helper");

/**
 * Obtém a mídia da foto de perfil de um usuário como objeto MessageMedia/base64
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {string|Object} targetJid - JID ou identificador do usuário
 * @returns {Promise<Object|null>} Objeto de mídia formatado ou null
 */
async function fetchUserProfilePictureMedia(bot, targetJid) {
	try {
		if (!targetJid || !bot) return null;

		let jid = targetJid;
		if (typeof jid === "object" && jid !== null) {
			jid = jid._serialized || jid.id?._serialized || jid.id || jid.user || "";
		}
		if (typeof jid !== "string") {
			jid = String(jid || "");
		}
		jid = jid.trim();
		if (!jid) return null;

		const fetchPhoto =
			typeof bot.getProfilePictureUrl === "function"
				? bot.getProfilePictureUrl.bind(bot)
				: typeof bot.client?.getProfilePictureUrl === "function"
					? bot.client.getProfilePictureUrl.bind(bot.client)
					: null;

		if (!fetchPhoto) return null;

		let profileUrl = null;
		try {
			profileUrl = await fetchPhoto(jid);
		} catch (err) {
			logger.debug(`[fetchUserProfilePictureMedia] Erro ao obter URL para ${jid}: ${err.message}`);
			return null;
		}

		if (!profileUrl || typeof profileUrl !== "string") {
			return null;
		}

		let base64Data = null;
		try {
			const response = await axios.get(profileUrl, {
				responseType: "arraybuffer",
				timeout: 10000
			});
			const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
			base64Data = buffer.toString("base64");
		} catch (downloadErr) {
			logger.warn(
				`[fetchUserProfilePictureMedia] Falha ao baixar buffer da imagem (${profileUrl}): ${downloadErr.message}`
			);
			return null;
		}

		return {
			url: profileUrl,
			mimetype: "image/jpeg",
			data: base64Data,
			filename: "profile.jpg",
			isMessageMedia: true
		};
	} catch (error) {
		logger.error(
			`[fetchUserProfilePictureMedia] Erro geral ao buscar foto de perfil para ${targetJid}:`,
			error
		);
		return null;
	}
}

/**
 * Extrai menções de usuários de uma mensagem, filtrando JIDs ignorados (ex: bot)
 * @param {Object} message - Mensagem recebida
 * @param {Array<string>} [excludeJids=[]] - JIDs a serem excluídos (ex: o próprio bot)
 * @returns {Array<string>} Lista de JIDs mencionados
 */
function extractMentions(message, excludeJids = []) {
	if (!message) return [];

	const rawMentions =
		message.origin?.mentionedIds ?? message.mentionedIds ?? message.mentions ?? [];

	const mentions = [];
	const normalizedExclude = (Array.isArray(excludeJids) ? excludeJids : [excludeJids])
		.filter(Boolean)
		.map((j) => {
			const s =
				typeof j === "object" ? j._serialized || j.id?._serialized || j.id || "" : String(j);
			return s.split("@")[0].replace(/\D/g, "");
		})
		.filter(Boolean);

	const addMention = (raw) => {
		if (!raw) return;
		let jid =
			typeof raw === "object"
				? raw._serialized || raw.id?._serialized || raw.id || raw.user || ""
				: String(raw);
		jid = jid.trim();
		if (!jid) return;

		const num = jid.split("@")[0].replace(/\D/g, "");
		if (normalizedExclude.includes(num)) return;

		if (!mentions.some((m) => m.split("@")[0].replace(/\D/g, "") === num)) {
			mentions.push(jid);
		}
	};

	if (Array.isArray(rawMentions)) {
		for (const m of rawMentions) {
			addMention(m);
		}
	}

	// Fallback: verifica se há números com @ no texto
	const text =
		typeof message.body === "string"
			? message.body
			: typeof message.content === "string"
				? message.content
				: "";

	if (text) {
		const matches = text.matchAll(/@(\d{10,25})/g);
		for (const match of matches) {
			addMention(`${match[1]}@s.whatsapp.net`);
		}
	}

	return mentions;
}

/**
 * Tenta buscar a foto de perfil da primeira menção válida
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Array<string>} mentions - Lista de menções
 * @returns {Promise<Object|null>} Objeto de mídia ou null
 */
async function fetchFirstValidProfilePicture(bot, mentions) {
	if (!Array.isArray(mentions) || mentions.length === 0 || !bot) {
		return null;
	}

	for (const targetJid of mentions) {
		try {
			const media = await fetchUserProfilePictureMedia(bot, targetJid);
			if (media && media.data) {
				return media;
			}
		} catch (e) {
			logger.debug(`[fetchFirstValidProfilePicture] Falha para ${targetJid}: ${e.message}`);
		}
	}

	return null;
}

/**
 * Resolve o nome ou apelido de um usuário mencionado
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {string|Object} jid - JID ou identificador do usuário
 * @param {Object} [group] - Objeto do grupo (com group.nicks)
 * @returns {Promise<string|null>} Nome/Apelido encontrado ou null
 */
async function resolveMentionName(bot, jid, group) {
	if (!jid) return null;

	let normalizedJid =
		typeof jid === "object"
			? jid._serialized || jid.id?._serialized || jid.id || jid.user || ""
			: String(jid);
	normalizedJid = normalizedJid.trim();
	const num = normalizedJid.split("@")[0];
	const numDigits = num.replace(/\D/g, "");

	// 1. Verifica se há apelido configurado no grupo (group.nicks)
	if (group?.nicks && Array.isArray(group.nicks)) {
		const nickData = group.nicks.find((n) => {
			if (!n?.numero) return false;
			const nStr = String(n.numero);
			const nDigits = nStr.split("@")[0].replace(/\D/g, "");
			return nStr === normalizedJid || nStr === num || (numDigits && nDigits === numDigits);
		});
		if (nickData?.apelido && nickData.apelido.trim()) {
			return nickData.apelido.trim();
		}
	}

	// 2. Tenta obter o nome através do getContactDetails do bot
	try {
		if (typeof bot?.getContactDetails === "function") {
			const contact = await bot.getContactDetails(normalizedJid);
			const contactName = contact?.name || contact?.pushName || contact?.pushname;
			if (contactName && contactName.trim() && contactName !== num && contactName !== numDigits) {
				return contactName.trim();
			}
		}
	} catch (e) {
		// Ignora erro
	}

	// 3. Tenta buscar nos participantes do grupo caso haja detalhes do chat
	try {
		const groupId = group?.id || (typeof group === "string" ? group : null);
		if (groupId && typeof bot?.getChatDetails === "function") {
			const chat = await bot.getChatDetails(groupId);
			if (chat?.participants && Array.isArray(chat.participants)) {
				const participant = chat.participants.find((p) => {
					const pJid = p.id?._serialized || p.id || "";
					const pLid = p.lid || "";
					const pJidDigits = pJid.split("@")[0].replace(/\D/g, "");
					const pLidDigits = pLid.split("@")[0].replace(/\D/g, "");
					return (
						pJid === normalizedJid ||
						pLid === normalizedJid ||
						(numDigits && (pJidDigits === numDigits || pLidDigits === numDigits))
					);
				});
				const pName = participant?.name || participant?.pushName || participant?.notify;
				if (pName && pName.trim() && pName !== num && pName !== numDigits) {
					return pName.trim();
				}
			}
		}
	} catch (e) {
		// Ignora erro
	}

	return null;
}

/**
 * Substitui IDs numéricos/LIDs de menção no texto pelo nome real ou apelido da pessoa
 * @param {string} text - Texto original com menções (@123123...)
 * @param {Object} message - Mensagem recebida
 * @param {Object} group - Dados do grupo
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Array<string>} [excludeJids=[]] - JIDs a desconsiderar (ex: o próprio bot)
 * @returns {Promise<string>} Texto com os nomes substituídos
 */
async function replaceMentionIdsWithNames(text, message, group, bot, excludeJids = []) {
	if (!text || typeof text !== "string") return text;

	const mentions = extractMentions(message, excludeJids);
	if (!mentions || mentions.length === 0) return text;

	let result = text;
	for (const jid of mentions) {
		try {
			const name = await resolveMentionName(bot, jid, group);
			if (name) {
				const num = jid.split("@")[0];
				// Substitui @numero ou @lid no texto por @Nome
				const regexNum = new RegExp(`@${num}\\b`, "g");
				result = result.replace(regexNum, `@${name}`);

				const cleanJid = jid.trim();
				if (cleanJid !== num) {
					const regexJid = new RegExp(`@${cleanJid}\\b`, "g");
					result = result.replace(regexJid, `@${name}`);
				}
			}
		} catch (e) {
			logger.debug(`[replaceMentionIdsWithNames] Erro ao substituir menção ${jid}: ${e.message}`);
		}
	}

	return result;
}

module.exports = {
	fetchUserProfilePictureMedia,
	extractMentions,
	fetchFirstValidProfilePicture,
	resolveMentionName,
	replaceMentionIdsWithNames
};
