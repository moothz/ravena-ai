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
		this.userAgent = "FakeBot/1.0";

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
			getChatById: async (chatId) => ({
				id: { _serialized: chatId },
				name: "FakeGroup",
				participants: []
			})
		};

		this.logger = new Logger("fake-bot");
	}

	// ---------------------------------------------------------------------------
	// Interface de envio — intercepta e captura ao invés de enviar
	// ---------------------------------------------------------------------------

	/**
	 * Captura ReturnMessage(s) que seriam enviadas pelo bot real.
	 * @param {ReturnMessage|ReturnMessage[]} messages
	 * @param {Group|null} group
	 */
	async sendReturnMessages(messages, group = null) {
		if (!messages) return;
		const arr = Array.isArray(messages) ? messages.flat() : [messages];
		for (const msg of arr) {
			if (!msg) continue;
			this.capturedMessages.push(msg);
			this.logger.debug(`[FakeBot] Capturado ReturnMessage → chatId=${msg.chatId}`);
			if (msg.options?.sendMediaAsSticker && msg.options?.quotedMessageId) {
				const stickerId = `fake_sticker_${Date.now()}`;
				this.eventHandler?.registerSentSticker?.(msg.options.quotedMessageId, {
					chatId: msg.chatId,
					id: stickerId
				});
			}
		}
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
	 */
	async sendMessage(chatId, content) {
		this.logger.debug(`[FakeBot] sendMessage() → chatId=${chatId}`);
		const ReturnMessage = require("../models/ReturnMessage");
		this.capturedMessages.push(new ReturnMessage({ chatId, content, metadata: { direct: true } }));
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
	getPnFromLid(lid) {
		return null;
	}

	async getChatDetails(chatId) {
		return {
			id: { _serialized: chatId },
			name: "FakeGroup",
			participants: []
		};
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
