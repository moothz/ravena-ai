const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const AdminUtils = require("../utils/AdminUtils");
const PhoneUtils = require("../utils/PhoneUtils");

const logger = new Logger("view-once-commands");
let sharedAdminUtils = null;

function getSharedAdminUtils() {
	if (!sharedAdminUtils) {
		sharedAdminUtils =
			typeof AdminUtils.getInstance === "function" ? AdminUtils.getInstance() : new AdminUtils();
	}
	return sharedAdminUtils;
}

/**
 * Resolve o JID de chat privado do usuário que solicitou ou reagiu ao comando.
 * Prioriza PN (@s.whatsapp.net) e faz fallback para @lid quando não mapeado.
 * @param {Object} bot
 * @param {Object} message
 * @returns {Promise<string|null>}
 */
async function resolveRequesterPvJid(bot, message) {
	const isReaction = Boolean(message.originReaction);
	const rawCandidates = isReaction
		? [message.originReaction?.senderId, message.author, message.authorAlt]
		: [
				message.author,
				message.authorAlt,
				message.goMessageData?.Info?.Sender,
				message.goMessageData?.Info?.SenderAlt
			];

	const candidates = rawCandidates.filter((c) => typeof c === "string" && c.trim().length > 0);
	let lidFallback = null;

	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		if (trimmed.includes("@g.us")) continue;

		if (trimmed.includes("@lid")) {
			const cleanLid = PhoneUtils.cleanPhone(trimmed) || trimmed.split("@")[0].split(":")[0];
			const cachedPn =
				bot?.lidToPnCache?.get(cleanLid) ||
				bot?.lidToPnCache?.get(`${cleanLid}@lid`) ||
				bot?.lidToPnCache?.get(trimmed);
			if (cachedPn) {
				const cleanPn = PhoneUtils.cleanPhone(cachedPn) || String(cachedPn).replace(/\D/g, "");
				if (cleanPn) return `${cleanPn}@s.whatsapp.net`;
			}
			if (!lidFallback && cleanLid) {
				lidFallback = `${cleanLid}@lid`;
			}
			continue;
		}

		const digits = PhoneUtils.cleanPhone(trimmed) || trimmed.split("@")[0].split(":")[0];
		if (digits && /^\d+$/.test(digits)) {
			return `${digits}@s.whatsapp.net`;
		}
	}

	if (lidFallback && typeof bot?.getPnFromLid === "function") {
		try {
			const resolvedPn = await bot.getPnFromLid(lidFallback);
			if (resolvedPn) {
				const cleanPn = PhoneUtils.cleanPhone(resolvedPn) || String(resolvedPn).replace(/\D/g, "");
				if (cleanPn) return `${cleanPn}@s.whatsapp.net`;
			}
		} catch (e) {
			logger.debug(`Falha ao resolver LID ${lidFallback} para PN: ${e.message}`);
		}
	}

	return lidFallback;
}

/**
 * Verifica silenciosamente se quem pediu/reagiu é administrador do grupo.
 * @param {Object} bot
 * @param {Object} message
 * @param {Object} group
 * @returns {Promise<boolean>}
 */
async function isRequesterGroupAdmin(bot, message, group) {
	if (!message.group) return false;

	const isReaction = Boolean(message.originReaction);
	const rawIds = isReaction
		? [message.originReaction?.senderId, message.author, message.authorAlt]
		: [message.authorAlt, message.author, message.goMessageData?.Info?.Sender];

	const candidates = Array.from(
		new Set(rawIds.filter((id) => typeof id === "string" && id.trim().length > 0))
	);
	if (candidates.length === 0) return false;

	const adminUtils = bot?.adminUtils || getSharedAdminUtils();
	const targetGroup = group || { id: message.group };

	for (const candidate of candidates) {
		try {
			const isAdmin = await adminUtils.isAdmin(candidate, targetGroup, null, bot);
			if (isAdmin) return true;
		} catch (err) {
			logger.debug(`Erro verificando admin para ${candidate}: ${err.message}`);
		}
	}

	return false;
}

/**
 * Verifica se uma mensagem (ou wrapper interno) é visualização única.
 * @param {Object|null} msg
 * @returns {boolean}
 */
function isMessageViewOnce(msg) {
	if (!msg || typeof msg !== "object") return false;
	return Boolean(
		msg.isViewOnce ||
		msg.origin?.isViewOnce ||
		msg.goMessageData?.isViewOnce ||
		msg.goMessageData?.IsViewOnce ||
		msg.goMessageData?.isViewOnceV2 ||
		msg.goMessageData?.isViewOnceV2Extension ||
		msg.isViewOnceUnavailable ||
		msg.origin?.isViewOnceUnavailable ||
		msg.goMessageData?.isViewOnceUnavailable
	);
}

/**
 * Resolve a mensagem alvo (reação, mídia direta na legenda ou mensagem citada).
 * @param {Object} message
 * @returns {Promise<{targetMsg: Object|null, isReaction: boolean, isViewOnce: boolean, isUnavailable: boolean}>}
 */
async function resolveViewOnceTarget(message) {
	const isReaction = Boolean(message.originReaction);
	if (isReaction) {
		const isViewOnce = !message._isFallback && isMessageViewOnce(message);
		const isUnavailable = Boolean(
			message.isViewOnceUnavailable ||
			message.origin?.isViewOnceUnavailable ||
			message.goMessageData?.isViewOnceUnavailable
		);
		return { targetMsg: message, isReaction: true, isViewOnce, isUnavailable };
	}

	if ((message.type !== "text" && message.hasMedia) || isMessageViewOnce(message)) {
		const isUnavailable = Boolean(
			message.isViewOnceUnavailable ||
			message.origin?.isViewOnceUnavailable ||
			message.goMessageData?.isViewOnceUnavailable
		);
		return {
			targetMsg: message,
			isReaction: false,
			isViewOnce: isMessageViewOnce(message),
			isUnavailable
		};
	}

	const quotedMsg = await message.origin?.getQuotedMessage?.();
	if (!quotedMsg) {
		return { targetMsg: null, isReaction: false, isViewOnce: false, isUnavailable: false };
	}

	const isUnavailable = Boolean(
		quotedMsg.isViewOnceUnavailable ||
		quotedMsg.origin?.isViewOnceUnavailable ||
		quotedMsg.goMessageData?.isViewOnceUnavailable
	);
	return {
		targetMsg: quotedMsg,
		isReaction: false,
		isViewOnce: isMessageViewOnce(quotedMsg),
		isUnavailable
	};
}

/**
 * Baixa mídia view-once e encaminha no chat privado do solicitante.
 * @param {Object} bot
 * @param {Object} message
 * @param {Object} group
 * @param {Object} opts
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>|false>}
 */
async function forwardViewOnceToPv(bot, message, group, { silentAdmin = false } = {}) {
	if (silentAdmin) {
		const allowed = await isRequesterGroupAdmin(bot, message, group);
		if (!allowed) {
			return false;
		}
	}

	const { targetMsg, isReaction, isViewOnce, isUnavailable } = await resolveViewOnceTarget(message);
	const fallbackChatId = message.group ?? message.author;

	if (!targetMsg || !isViewOnce) {
		if (silentAdmin || isReaction) {
			return false;
		}
		return new ReturnMessage({
			chatId: fallbackChatId,
			content: !targetMsg
				? "Responda a uma mídia de visualização única com !roubar ou reaja com 👀 para recebê-la no privado."
				: "A mensagem informada não é uma mídia de visualização única.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	const pvJid = await resolveRequesterPvJid(bot, message);
	if (!pvJid) {
		if (silentAdmin) return false;
		if (isReaction) await message.origin?.react?.("❌")?.catch(() => {});
		return new ReturnMessage({
			chatId: fallbackChatId,
			content: "❌ Não foi possível identificar seu número privado para enviar a mídia.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	const unavailableText =
		"🔒 Não foi possível baixar esta mídia de visualização única — o WhatsApp não entregou as chaves/dados da mídia para o dispositivo conectado.";

	if (isUnavailable || !targetMsg.hasMedia) {
		if (!silentAdmin) {
			await message.origin?.react?.("❌")?.catch(() => {});
		}
		const notifyChatId = silentAdmin ? pvJid : isReaction ? pvJid : fallbackChatId;
		return new ReturnMessage({
			chatId: notifyChatId,
			content: unavailableText,
			...(notifyChatId === fallbackChatId && !silentAdmin
				? {
						options: {
							quotedMessageId: message.origin?.id?._serialized,
							goReply: message.origin
						}
					}
				: {})
		});
	}

	if (!silentAdmin && isReaction) {
		await message.origin?.react?.(process.env.LOADING_EMOJI ?? "⌛️")?.catch(() => {});
	}

	let media = null;
	try {
		if (targetMsg.content?.data && targetMsg.content?.mimetype) {
			media = targetMsg.content;
		} else {
			media = await targetMsg.downloadMedia?.();
		}
	} catch (err) {
		logger.error("Erro baixando mídia view-once:", err);
	}

	if (!media || !media.data || !media.mimetype) {
		if (!silentAdmin) {
			await message.origin?.react?.("❌")?.catch(() => {});
		}
		const notifyChatId = silentAdmin ? pvJid : isReaction ? pvJid : fallbackChatId;
		return new ReturnMessage({
			chatId: notifyChatId,
			content: unavailableText,
			...(notifyChatId === fallbackChatId && !silentAdmin
				? {
						options: {
							quotedMessageId: message.origin?.id?._serialized,
							goReply: message.origin
						}
					}
				: {})
		});
	}

	const senderName =
		targetMsg.targetAuthorName ||
		targetMsg.authorName ||
		targetMsg.pushname ||
		targetMsg.name ||
		"";
	const headerLines = ["🤫 *Mídia de visualização única*"];
	if (message.group) {
		headerLines.push(`👥 *Grupo:* ${group?.name || message.group}`);
	}
	if (senderName && senderName !== "Usuario") {
		headerLines.push(`👤 *Enviado por:* ${senderName}`);
	}
	if (targetMsg.caption) {
		headerLines.push(`💬 *Legenda:* ${targetMsg.caption}`);
	}
	const pvCaption = headerLines.join("\n");

	const mediaContent = {
		mimetype: media.mimetype,
		data: media.data,
		url: media.url,
		filename: media.filename,
		isMessageMedia: true
	};

	const isAudio = media.mimetype.startsWith("audio/");
	const isVoiceAudio = isAudio && Boolean(targetMsg.goMessageData?.Message?.audioMessage?.ptt);

	if (!silentAdmin) {
		await message.origin?.react?.("✅")?.catch(() => {});
	}

	if (isAudio) {
		return [
			new ReturnMessage({
				chatId: pvJid,
				content: pvCaption
			}),
			new ReturnMessage({
				chatId: pvJid,
				content: mediaContent,
				options: {
					sendAudioAsVoice: isVoiceAudio
				}
			})
		];
	}

	return new ReturnMessage({
		chatId: pvJid,
		content: mediaContent,
		options: {
			caption: pvCaption
		}
	});
}

async function handleRoubarCommand(bot, message, args, group) {
	return forwardViewOnceToPv(bot, message, group, { silentAdmin: false });
}

async function handleAdminRoubarCommand(bot, message, args, group) {
	return forwardViewOnceToPv(bot, message, group, { silentAdmin: true });
}

const commands = [
	new Command({
		name: "roubar",
		description: "Baixa mídia de visualização única e envia no seu privado",
		category: "grupo",
		cooldown: 0,
		reactions: {
			trigger: "👀",
			before: false,
			after: false,
			error: false
		},
		method: handleRoubarCommand
	}),
	new Command({
		name: "admin-roubar",
		description: "Encaminha mídia de visualização única silenciosamente no privado do admin",
		category: "grupo",
		hidden: true,
		reply: false,
		cooldown: 0,
		reactions: {
			trigger: "👽",
			before: false,
			after: false,
			error: false
		},
		method: handleAdminRoubarCommand
	})
];

const helper = {
	about: "Download de mídias de visualização única para o privado do solicitante",
	implementation:
		"Recupera mídias view-once a partir de mensagens citadas, legendas ou reações 👀 e envia no chat privado.",
	tags: "viewonce,visualizacao unica,roubar,privado,midia",
	cmds: [
		{
			cmd: "!roubar",
			desc: "Baixa uma mídia de visualização única citada (ou ao reagir com 👀) e envia no seu privado",
			usage: ["!roubar (respondendo a uma mídia de visualização única)", "Reagir com 👀"],
			category: "grupo"
		}
	]
};

module.exports = {
	helper,
	commands,
	resolveRequesterPvJid,
	isMessageViewOnce
};
