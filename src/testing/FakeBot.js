/**
 * FakeBot.js
 *
 * Stub de bot para uso nos testes. Implementa a interface mínima que o pipeline
 * (EventHandler → CommandHandler → functions) espera de um bot real.
 *
 * Não inicializa conexões WebSocket/Telegram/Discord. Intercepta sendReturnMessages
 * e acumula as mensagens que seriam enviadas em this.capturedMessages[].
 */

const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const Database = require("../utils/Database");
const Logger = require("../utils/Logger");

class FakeBot {
	constructor(options = {}) {
		this.id = options.id ?? "bot-teste";
		this.enabled = options.enabled !== undefined ? Boolean(options.enabled) : true;
		this.prefix = options.prefix ?? "!";
		this.phoneNumber = options.phoneNumber ?? "5511999990000";

		// Flags lidas pelo EventHandler / CommandHandler
		this.ignorePV = false;
		this.updateStatus = options.updateStatus ?? true;
		this.aiPersonality = options.aiPersonality ?? "";
		this.pvAI = false;
		this.ignoreInvites = true;
		this.whitelistPV = [];
		this.banido = options.banido ?? false;
		this.vip = options.vip ?? false;
		this.comunitario = options.comunitario ?? false;
		this.privado = options.privado ?? false;
		this.extras = options.extras || {};
		this.userAgent = "FakeBot/1.0";
		this.lidToPnMap = new Map();

		// IDs de grupos de notificação — null = desabilitado
		this.grupoLogs = options.grupoLogs ?? null;
		this.dossieGroups = options.dossieGroups ?? options.grupoLogs ?? null;
		this.grupoAvisos = null;
		this.grupoEstabilidade = null;
		this.grupoInvites = null;
		this.grupoAnuncios = null;
		this.grupoInteracao = null;
		this.linkGrupao = null;
		this.linkAvisos = null;

		// DB compartilhado com o sistema real (leitura), testMode bloqueia escritas
		this.database = Database.getInstance({
			disableBackup: true,
			testMode: true
		});

		// Sistema de invite desabilitado
		this.inviteSystem = null;

		// MentionHandler — stub que nunca processa menções
		this.mentionHandler = {
			processMention: async () => false
		};

		// Mensagens capturadas durante o teste
		this.capturedMessages = [];
		this.skipGroupInfo = options.skipGroupInfo ?? [];

		this.isConnected = options.isConnected ?? true;
		this.currentStatus = null;
		this.updatedStatuses = [];
		this.updateProfileStatus =
			options.updateProfileStatus ||
			(async (status) => {
				this.currentStatus = status;
				this.updatedStatuses.push(status);
			});
		this.client = {
			setStatus: async (status) => await this.updateProfileStatus(status),
			getChatById: async (chatId) => await this.getChatDetails(chatId)
		};

		this.logger = new Logger("fake-bot");
	}

	// ---------------------------------------------------------------------------
	// Interface de envio — intercepta e captura ao invés de enviar
	// ---------------------------------------------------------------------------

	/**
	 * Limita o conteúdo de texto para evitar mensagens gigantescas ou loops de repetição.
	 * Respeita o limite máximo de caracteres (padrão 15000), de linhas (padrão 200) e repetições consecutivas (máx 15).
	 *
	 * @param {string} text - Texto a ser validado e possivelmente truncado.
	 * @param {number} [maxChars=15000] - Limite máximo de caracteres.
	 * @param {number} [maxLines=200] - Limite máximo de linhas.
	 * @param {number} [maxCharRepeats=15] - Limite máximo de repetições consecutivas do mesmo caractere.
	 * @returns {string} - Texto original ou truncado com indicador.
	 */
	truncateText(text, maxChars = 15000, maxLines = 200, maxCharRepeats = 15) {
		if (typeof text !== "string" || !text) {
			return text;
		}

		let result = text;
		let modified = false;

		// Limita repetições consecutivas do mesmo caractere para no máximo 15 (ex: "KKK...KKK" -> 15 K's)
		if (maxCharRepeats > 0) {
			const repeatRegex =
				maxCharRepeats === 15 ? /(.)\1{15,}/gu : new RegExp(`(.)\\1{${maxCharRepeats},}`, "gu");
			if (repeatRegex.test(result)) {
				result = result.replace(repeatRegex, (match, char) => char.repeat(maxCharRepeats));
				modified = true;
			}
		}

		const lines = result.split(/\r?\n/);
		const exceedsLines = maxLines > 0 && lines.length > maxLines;
		const exceedsChars = maxChars > 0 && result.length > maxChars;

		if (exceedsLines || exceedsChars) {
			modified = true;
			const suffix = "\n... [truncado]";

			if (exceedsLines) {
				const targetLines = Math.max(1, maxLines - 1);
				result = lines.slice(0, targetLines).join("\n") + suffix;
			}

			if (maxChars > 0 && result.length > maxChars) {
				const targetChars = Math.max(0, maxChars - suffix.length);
				result = result.slice(0, targetChars) + suffix;
			}
		}

		if (modified) {
			this.logger.warn(
				`[FakeBot] Mensagem de texto ajustada por filtros de tamanho/repetição (${maxChars} chars / ${maxLines} linhas / máx ${maxCharRepeats} repetições).`
			);
		}

		return result;
	}

	/**
	 * Captura ReturnMessage(s) que seriam enviadas pelo bot real.
	 * @param {ReturnMessage|ReturnMessage[]} messages
	 * @param {Group|null} group
	 */
	async sendReturnMessages(messages, group = null) {
		if (!messages) return [];
		const arr = Array.isArray(messages) ? messages.flat() : [messages];
		const results = [];
		for (const msg of arr) {
			if (!msg) continue;
			if (msg.chatId && msg.chatId.includes("@g.us") && !this.isParticipating(msg.chatId)) {
				this.logger.warn(
					`[FakeBot] Ignorando envio de ReturnMessage para ${msg.chatId}: bot não participa deste grupo.`
				);
				results.push({
					error: new Error(`Bot ${this.id} não participa do grupo ${msg.chatId}`),
					notInGroup: true,
					skipped: true,
					messageContent: msg.content
				});
				continue;
			}
			const maxChars = msg.options?.maxChars !== undefined ? msg.options.maxChars : 15000;
			const maxLines = msg.options?.maxLines !== undefined ? msg.options.maxLines : 200;
			const maxCharRepeats =
				msg.options?.maxCharRepeats !== undefined ? msg.options.maxCharRepeats : 15;

			if (typeof msg.content === "string") {
				msg.content = this.truncateText(msg.content, maxChars, maxLines, maxCharRepeats);
			}
			if (msg.options?.caption && typeof msg.options.caption === "string") {
				msg.options.caption = this.truncateText(
					msg.options.caption,
					maxChars,
					maxLines,
					maxCharRepeats
				);
			}
			this.capturedMessages.push(msg);
			this.logger.debug(`[FakeBot] Capturado ReturnMessage → chatId=${msg.chatId}`);
			if (msg.options?.sendMediaAsSticker && msg.options?.quotedMessageId) {
				const stickerId = `fake_sticker_${Date.now()}`;
				this.eventHandler?.registerSentSticker?.(msg.options.quotedMessageId, {
					chatId: msg.chatId,
					id: stickerId
				});
			}
			results.push({ id: { _serialized: `fake_msg_${Date.now()}` }, ack: 1 });
		}
		return results;
	}

	/**
	 * Simula exclusão de mensagem no WhatsApp
	 * @param {Object} key - { remoteJid, id, fromMe, participant }
	 */
	async deleteMessageByKey(key) {
		this.deletedMessages = this.deletedMessages || [];
		this.deletedMessages.push(key);
		this.logger.debug(`[FakeBot] deleteMessageByKey() → id=${key.id}`);
		return { success: true };
	}

	/**
	 * Simula envio direto de mensagem de texto.
	 * @param {string} chatId
	 * @param {string} content
	 * @param {Object} [options={}]
	 */
	async sendMessage(chatId, content, options = {}) {
		this.logger.debug(`[FakeBot] sendMessage() → chatId=${chatId}`);
		if (chatId && chatId.includes("@g.us") && !this.isParticipating(chatId)) {
			this.logger.warn(
				`[FakeBot] Ignorando sendMessage para ${chatId}: bot não participa deste grupo.`
			);
			const err = new Error(`Bot ${this.id} não participa do grupo ${chatId}`);
			err.notInGroup = true;
			err.status = 403;
			throw err;
		}
		const maxChars = options.maxChars !== undefined ? options.maxChars : 15000;
		const maxLines = options.maxLines !== undefined ? options.maxLines : 200;
		const maxCharRepeats = options.maxCharRepeats !== undefined ? options.maxCharRepeats : 15;

		const ReturnMessage = require("../models/ReturnMessage");
		const msg = new ReturnMessage({
			chatId,
			content:
				typeof content === "string"
					? this.truncateText(content, maxChars, maxLines, maxCharRepeats)
					: content,
			options,
			metadata: { direct: true }
		});
		this.capturedMessages.push(msg);
		return { id: { _serialized: `fake_direct_${Date.now()}` }, ack: 1 };
	}

	/**
	 * Simula remoção de participantes de um grupo
	 * @param {string} groupId
	 * @param {string|string[]} participants
	 */
	async removeFromGroup(groupId, participants) {
		this.removedParticipants = this.removedParticipants || [];
		this.removedParticipants.push({ groupId, participants });
		this.logger.debug(
			`[FakeBot] removeFromGroup() → groupId=${groupId}, participants=${JSON.stringify(participants)}`
		);
		return { success: true };
	}

	/**
	 * Simula remoção de participantes de uma comunidade
	 * @param {string} communityId
	 * @param {string|string[]} participants
	 */
	async removeFromCommunity(communityId, participants) {
		this.removedCommunityParticipants = this.removedCommunityParticipants || [];
		this.removedCommunityParticipants.push({ communityId, participants });
		this.logger.debug(
			`[FakeBot] removeFromCommunity() → communityId=${communityId}, participants=${JSON.stringify(participants)}`
		);
		return { success: true };
	}

	// ---------------------------------------------------------------------------
	// Helpers lidos pelo EventHandler / AdminUtils
	// ---------------------------------------------------------------------------

	/** Retorna false — nenhum autor está na whitelist durante testes */
	notInWhitelist(author) {
		return false;
	}

	/** Retorna o timestamp atual em segundos */
	getCurrentTimestamp() {
		return Math.round(Date.now() / 1000);
	}

	/**
	 * Cria um objeto de mídia simulado
	 * @param {string} filePath
	 * @param {string|boolean} customMime
	 */
	async createMedia(filePath, customMime = false) {
		try {
			if (!fs.existsSync(filePath)) {
				throw new Error(`File not found: ${filePath}`);
			}

			const stats = fs.statSync(filePath);
			const size = stats.size;
			const extension = path.extname(filePath);
			const filename = path.basename(filePath);
			let mimetype = customMime ? customMime : mime.lookup(filePath) || "application/octet-stream";

			if (mimetype === "application/mp4") {
				mimetype = "video/mp4";
			}

			// Simula leitura base64
			const data = fs.readFileSync(filePath, { encoding: "base64" });

			return {
				mimetype,
				data,
				filename,
				source: "file",
				url: `file://${filePath}`,
				isMessageMedia: true,
				size
			};
		} catch (error) {
			this.logger.error(`Error creating media from ${filePath}:`, error);
			throw error;
		}
	}

	/**
	 * Cria mídia a partir de URL simulada
	 */
	async createMediaFromURL(url, options = {}) {
		try {
			const filename = path.basename(new URL(url).pathname) || "media_from_url";
			const mimetype = options.customMime || mime.lookup(filename) || "application/octet-stream";

			return {
				mimetype,
				data: null,
				filename,
				source: "url",
				url,
				isMessageMedia: true,
				size: 0
			};
		} catch (error) {
			this.logger.error(`Error creating media from URL ${url}:`, error);
			throw error;
		}
	}

	/**
	 * Cria mídia a partir de base64 simulada
	 */
	async createMediaFromBase64(base64Data, mimetype, filename) {
		const extension = mime.extension(mimetype) ?? "bin";
		const buffer = Buffer.from(base64Data, "base64");
		return {
			mimetype,
			data: base64Data,
			filename: filename ?? `file.${extension}`,
			source: "base64",
			url: `data:${mimetype};base64,${base64Data.substring(0, 32)}...`,
			isMessageMedia: true,
			size: buffer.length
		};
	}

	/** Stubs para resolução LID↔PN usada nos filtros de grupo */
	getLidFromPn(pn) {
		return null;
	}
	getPnFromLid(lid, chat) {
		if (!lid) return null;
		if (this.lidToPnMap) {
			const strLid = String(lid);
			const pure = strLid.split(/[@:]/)[0].replace(/\D/g, "");
			if (this.lidToPnMap.has(strLid)) return this.lidToPnMap.get(strLid);
			if (pure && this.lidToPnMap.has(pure)) return this.lidToPnMap.get(pure);
			if (pure && this.lidToPnMap.has(`${pure}@lid`)) return this.lidToPnMap.get(`${pure}@lid`);
		}
		if (chat?.participants || chat?.Participants) {
			const parts = chat.participants || chat.Participants || [];
			const p = parts.find(
				(part) => part.lid === lid || part.id === lid || part.id?._serialized === lid
			);
			if (p?.phoneNumber || p?.PhoneNumber) return p.phoneNumber || p.PhoneNumber;
		}
		return null;
	}

	async getChatDetails(chatId) {
		const inGroup = this.isParticipating(chatId);
		return {
			id: { _serialized: chatId },
			name: "FakeGroup",
			isGroup: chatId.includes("@g.us"),
			notInGroup: !inGroup,
			isParticipating: inGroup,
			participants: []
		};
	}

	isParticipating(groupId) {
		if (!groupId) return false;
		if (this.skipGroupInfo && this.skipGroupInfo.includes(groupId)) {
			return false;
		}
		return true;
	}

	isInGroup(groupId) {
		return this.isParticipating(groupId);
	}

	async addSkipGroup(groupId) {
		if (!this.skipGroupInfo.includes(groupId)) {
			this.skipGroupInfo.push(groupId);
		}
	}

	async removeSkipGroup(groupId) {
		this.skipGroupInfo = this.skipGroupInfo.filter((id) => id !== groupId);
	}

	async markNotInGroup(groupId) {
		if (!groupId) return;
		await this.addSkipGroup(groupId);
		try {
			if (this.eventHandler?.groups?.[groupId]) {
				const grp = this.eventHandler.groups[groupId];
				if (!grp.botNotInGroup) grp.botNotInGroup = [];
				if (!grp.botNotInGroup.includes(this.id)) {
					grp.botNotInGroup.push(this.id);
				}
			}
			if (this.database?.getGroup && this.database?.saveGroup) {
				const group = await this.database.getGroup(groupId);
				if (group) {
					if (!group.botNotInGroup) group.botNotInGroup = [];
					if (!group.botNotInGroup.includes(this.id)) {
						group.botNotInGroup.push(this.id);
						await this.database.saveGroup(group);
					}
				}
			}
		} catch (error) {
			this.logger.error(`[FakeBot] Erro ao marcar botNotInGroup:`, error);
		}
	}

	async markInGroup(groupId) {
		if (!groupId) return;
		await this.removeSkipGroup(groupId);
		try {
			if (this.eventHandler?.groups?.[groupId]) {
				const grp = this.eventHandler.groups[groupId];
				if (grp.botNotInGroup && grp.botNotInGroup.includes(this.id)) {
					grp.botNotInGroup = grp.botNotInGroup.filter((b) => b !== this.id);
				}
			}
			if (this.database?.getGroup && this.database?.saveGroup) {
				const group = await this.database.getGroup(groupId);
				if (group && group.botNotInGroup && group.botNotInGroup.includes(this.id)) {
					group.botNotInGroup = group.botNotInGroup.filter((b) => b !== this.id);
					await this.database.saveGroup(group);
				}
			}
		} catch (error) {
			this.logger.error(`[FakeBot] Erro ao remover botNotInGroup:`, error);
		}
	}

	/** Compatibilidade com destruição no SIGINT */
	async destroy() {}

	/**
	 * Verifica se um chat/grupo é o grupo de dossiês do bot
	 * @param {string} groupId - ID do grupo a verificar
	 * @returns {boolean}
	 */
	isDossieGroup(groupId) {
		if (!this.dossieGroups || !groupId) return false;
		const clean = (id) => String(id).split("@")[0].trim();
		const targetClean = clean(groupId);
		const groups = Array.isArray(this.dossieGroups)
			? this.dossieGroups
			: typeof this.dossieGroups === "string" && this.dossieGroups.includes(",")
				? this.dossieGroups.split(",").map((g) => g.trim())
				: [this.dossieGroups];
		return groups.some(
			(g) => clean(g) === targetClean || String(g).trim() === String(groupId).trim()
		);
	}

	/**
	 * Reseta mensagens capturadas (útil para rodar múltiplos testes com o mesmo bot)
	 */
	resetCapture() {
		this.capturedMessages = [];
	}
}

module.exports = FakeBot;
