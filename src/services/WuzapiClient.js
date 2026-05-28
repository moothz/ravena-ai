/**
 * WuzapiClient.js
 * Cliente HTTP para a API do wuzapi (asternic/wuzapi).
 *
 * Diferenças em relação ao WhatsgoApiClient:
 * - Autenticação via header X-Auth-Token (admin) ou per instância
 * - Endpoints seguem padrão /instances/{name}/... para ações por instância
 * - Webhooks configurados por instância ou globalmente
 */

const axios = require("axios");
const crypto = require("crypto");

class WuzapiClient {
	/**
	 * @param {string} baseUrl - Base URL do wuzapi (ex: http://wuzapi:8080)
	 * @param {string} adminToken - Token de administração (X-Auth-Token)
	 * @param {string} instanceName - Nome da instância (opcional, para métodos por instância)
	 * @param {object} logger - Instância de logger
	 */
	constructor(baseUrl, adminToken, instanceName, logger) {
		if (!baseUrl || !adminToken) {
			throw new Error("WuzapiClient: baseUrl e adminToken são obrigatórios.");
		}
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.adminToken = adminToken;
		this.instanceName = instanceName;
		this.logger = logger || console;

		// Use the instanceName as the user token
		this.userToken = this.instanceName || "";

		// Admin client uses Authorization header with the adminToken
		this.adminClient = axios.create({
			baseURL: this.baseUrl,
			headers: {
				"Authorization": this.adminToken,
				"Content-Type": "application/json"
			}
		});

		// User/Bot client uses Token header with the userToken
		this.userClient = axios.create({
			baseURL: this.baseUrl,
			headers: {
				"Token": this.userToken,
				"Content-Type": "application/json"
			}
		});

		this.logger.info(
			`WuzapiClient inicializado${this.instanceName ? ` para instância: ${this.instanceName}` : ""}, baseUrl: ${this.baseUrl}`
		);
	}

	// ──────────────────────────────────────────────────────────
	// Métodos HTTP genéricos (User API)
	// ──────────────────────────────────────────────────────────

	async get(endpoint, params = {}) {
		try {
			const response = await this.userClient.get(endpoint, { params });
			return response.data;
		} catch (error) {
			this.logger.error(
				`Wuzapi GET Error ${endpoint}:`,
				error.response?.status,
				error.response?.data || error.message
			);
			throw error.response?.data || error;
		}
	}

	async post(endpoint, data = {}, params = {}) {
		try {
			const response = await this.userClient.post(endpoint, data, { params });
			return response.data;
		} catch (error) {
			this.logger.error(
				`Wuzapi POST Error ${endpoint}:`,
				error.response?.status,
				error.response?.data || error.message
			);
			throw error.response?.data || error;
		}
	}

	async put(endpoint, data = {}, params = {}) {
		try {
			const response = await this.userClient.put(endpoint, data, { params });
			return response.data;
		} catch (error) {
			this.logger.error(
				`Wuzapi PUT Error ${endpoint}:`,
				error.response?.status,
				error.response?.data || error.message
			);
			throw error.response?.data || error;
		}
	}

	async delete(endpoint, data = {}, params = {}) {
		try {
			const response = await this.userClient.delete(endpoint, { data, params });
			return response.data;
		} catch (error) {
			this.logger.error(
				`Wuzapi DELETE Error ${endpoint}:`,
				error.response?.status,
				error.response?.data || error.message
			);
			throw error.response?.data || error;
		}
	}

	// ──────────────────────────────────────────────────────────
	// Métodos HTTP genéricos (Admin API)
	// ──────────────────────────────────────────────────────────

	async adminGet(endpoint, params = {}) {
		try {
			const response = await this.adminClient.get(endpoint, { params });
			return response.data;
		} catch (error) {
			this.logger.error(
				`Wuzapi Admin GET Error ${endpoint}:`,
				error.response?.status,
				error.response?.data || error.message
			);
			throw error.response?.data || error;
		}
	}

	async adminPost(endpoint, data = {}, params = {}) {
		try {
			const response = await this.adminClient.post(endpoint, data, { params });
			return response.data;
		} catch (error) {
			this.logger.error(
				`Wuzapi Admin POST Error ${endpoint}:`,
				error.response?.status,
				error.response?.data || error.message
			);
			throw error.response?.data || error;
		}
	}

	async adminDelete(endpoint, data = {}, params = {}) {
		try {
			const response = await this.adminClient.delete(endpoint, { data, params });
			return response.data;
		} catch (error) {
			this.logger.error(
				`Wuzapi Admin DELETE Error ${endpoint}:`,
				error.response?.status,
				error.response?.data || error.message
			);
			throw error.response?.data || error;
		}
	}

	// ──────────────────────────────────────────────────────────
	// Instâncias
	// ──────────────────────────────────────────────────────────

	/**
	 * Lista todas as instâncias
	 */
	async listInstances() {
		return this.adminGet("/admin/users");
	}

	/**
	 * Cria uma nova instância
	 * @param {string} name - Nome da instância
	 * @param {object} options - Opções opcionais (webhook, etc)
	 */
	async createInstance(name, options = {}) {
		const payload = {
			name: name,
			token: name, // We use the name itself as the user token
			webhook: options.webhookUrl || "",
			events: "Message,ReadReceipt,HistorySync,ChatPresence"
		};
		return this.adminPost("/admin/users", payload);
	}

	/**
	 * Deleta uma instância
	 * @param {string} name - Nome da instância
	 */
	async deleteInstance(name) {
		try {
			const users = await this.listInstances();
			let userList = users;
			if (users && !Array.isArray(users) && Array.isArray(users.data)) {
				userList = users.data;
			}
			if (userList && Array.isArray(userList)) {
				const user = userList.find(u => u.name === name || u.Name === name);
				if (user) {
					const id = user.id || user.ID;
					return this.adminDelete(`/admin/users/${id}/full`);
				}
			}
			this.logger.warn(`deleteInstance: Instance ${name} not found in user list`);
			return { success: false, error: "instance not found" };
		} catch (error) {
			this.logger.error(`Error deleting instance ${name}:`, error);
			throw error;
		}
	}

	/**
	 * Obtém status de uma instância
	 * @param {string} name - Nome da instância
	 */
	async getInstanceStatus(name) {
		return this.get("/session/status");
	}

	/**
	 * Obtém status de conexão (connectado/desconectado)
	 * @param {string} name - Nome da instância
	 */
	async getConnectionStatus(name) {
		return this.get("/session/status");
	}

	/**
	 * Conecta uma instância
	 * @param {string} name - Nome da instância
	 */
	async connectInstance(name) {
		return this.post("/session/connect");
	}

	/**
	 * Desconecta uma instância
	 * @param {string} name - Nome da instância
	 */
	async disconnectInstance(name) {
		return this.post("/session/disconnect");
	}

	/**
	 * Faz logout de uma instância
	 * @param {string} name - Nome da instância
	 */
	async logoutInstance(name) {
		return this.post("/session/logout");
	}

	// ──────────────────────────────────────────────────────────
	// QR Code
	// ──────────────────────────────────────────────────────────

	/**
	 * Obtém QR code para escaneamento
	 * @param {string} name - Nome da instância
	 */
	async getQrCode(name) {
		const res = await this.get("/session/qr");
		// Normalize: ensure both qr and qrcode are present so that the caller can use either
		if (res) {
			if (!res.data) res.data = {};
			res.data.qr = res.data.QRCode || res.data.qrcode || res.data.qr || res.qr || res.qrcode || res.QRCode;
			res.data.qrcode = res.data.qr;
		}
		return res;
	}

	/**
	 * Obtém código de pareamento por telefone
	 * @param {string} phone - Número de telefone para pareamento
	 */
	async pairPhone(phone) {
		const payload = {
			phone: phone
		};
		return this.post("/session/pairphone", payload);
	}

	// ──────────────────────────────────────────────────────────
	// Webhooks por instância
	// ──────────────────────────────────────────────────────────

	/**
	 * Configura webhook para uma instância
	 * @param {string} name - Nome da instância
	 * @param {string} url - URL do webhook
	 * @param {string} secret - Secret para validação (opcional)
	 */
	async setWebhook(name, url, secret = "") {
		return this.post("/webhook", {
			webhookURL: url,
			events: ["Message", "ReadReceipt", "HistorySync", "ChatPresence"]
		});
	}

	/**
	 * Obtém configuração de webhook de uma instância
	 * @param {string} name - Nome da instância
	 */
	async getWebhook(name) {
		return this.get("/webhook");
	}

	// ──────────────────────────────────────────────────────────
	// Envio de mensagens
	// ──────────────────────────────────────────────────────────

	async _getMediaDataURI(media, defaultMime = "application/octet-stream") {
		if (media.base64) {
			if (media.base64.startsWith("data:")) return media.base64;
			return `data:${media.mimetype || defaultMime};base64,${media.base64}`;
		}
		if (media.url) {
			if (media.url.startsWith("http://") || media.url.startsWith("https://")) {
				const response = await axios.get(media.url, { responseType: "arraybuffer" });
				const base64 = Buffer.from(response.data, "binary").toString("base64");
				const mimeType = response.headers["content-type"] || media.mimetype || defaultMime;
				return `data:${mimeType};base64,${base64}`;
			} else {
				const fs = require("fs");
				if (fs.existsSync(media.url)) {
					const base64 = fs.readFileSync(media.url, { encoding: "base64" });
					const mimeType = media.mimetype || defaultMime;
					return `data:${mimeType};base64,${base64}`;
				}
			}
		}
		return "";
	}

	/**
	 * Envia mensagem de texto
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {string} text - Texto da mensagem
	 * @param {object} options - Opções (replyTo, mention, etc)
	 */
	async sendText(name, chatId, text, options = {}) {
		const payload = {
			Phone: chatId,
			Body: text,
			Id: options.id || options.messageId || undefined
		};
		if (options.replyTo) {
			payload.ContextInfo = {
				StanzaId: options.replyTo,
				Participant: options.participant || ""
			};
		}
		return this.post("/chat/send/text", payload);
	}

	/**
	 * Envia imagem
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} media - { url, base64, caption }
	 */
	async sendImage(name, chatId, media) {
		const dataUri = await this._getMediaDataURI(media, "image/jpeg");
		return this.post("/chat/send/image", {
			Phone: chatId,
			Image: dataUri,
			Caption: media.caption || ""
		});
	}

	/**
	 * Envia vídeo
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} media - { url, base64, caption }
	 */
	async sendVideo(name, chatId, media) {
		const dataUri = await this._getMediaDataURI(media, "video/mp4");
		return this.post("/chat/send/video", {
			Phone: chatId,
			Video: dataUri,
			Caption: media.caption || ""
		});
	}

	/**
	 * Envia áudio
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} media - { url, base64, ptts (boolean) }
	 */
	async sendAudio(name, chatId, media) {
		const dataUri = await this._getMediaDataURI(media, "audio/ogg");
		return this.post("/chat/send/audio", {
			Phone: chatId,
			Audio: dataUri
		});
	}

	/**
	 * Envia documento
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} media - { url, base64, fileName, caption }
	 */
	async sendDocument(name, chatId, media) {
		const dataUri = await this._getMediaDataURI(media, "application/pdf");
		return this.post("/chat/send/document", {
			Phone: chatId,
			Document: dataUri,
			FileName: media.fileName || media.filename || "file"
		});
	}

	/**
	 * Envia sticker
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} media - { url, base64 }
	 */
	async sendSticker(name, chatId, media) {
		const dataUri = await this._getMediaDataURI(media, "image/webp");
		return this.post("/chat/send/sticker", {
			Phone: chatId,
			Sticker: dataUri
		});
	}

	/**
	 * Envia localização
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} location - { latitude, longitude, name, address }
	 */
	async sendLocation(name, chatId, location) {
		return this.post("/chat/send/location", {
			Phone: chatId,
			Latitude: location.latitude,
			Longitude: location.longitude,
			Name: location.name || ""
		});
	}

	/**
	 * Envia mensagem genérica (qualquer tipo)
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} message - Objeto completo da mensagem
	 */
	async sendMessage(name, chatId, message) {
		if (message.text) {
			return this.sendText(name, chatId, message.text, message);
		}
		return this.sendText(name, chatId, JSON.stringify(message), message);
	}

	// ──────────────────────────────────────────────────────────
	// Reações
	// ──────────────────────────────────────────────────────────

	/**
	 * Reage a uma mensagem
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {string} messageId - ID da mensagem
	 * @param {string} emoji - Emoji da reação
	 */
	async sendReaction(name, chatId, messageId, emoji) {
		return this.post("/chat/react", {
			Phone: chatId,
			Body: emoji,
			Id: messageId
		});
	}

	// ──────────────────────────────────────────────────────────
	// Ações em mensagens
	// ──────────────────────────────────────────────────────────

	/**
	 * Delete uma mensagem
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {string} messageId - ID da mensagem
	 * @param {object} options - { deleteAllParticipants (para grupos) }
	 */
	async deleteMessage(name, chatId, messageId, options = {}) {
		return this.post("/chat/delete", {
			Phone: chatId,
			MessageId: messageId,
			FromMe: options.fromMe !== undefined ? options.fromMe : true
		});
	}

	/**
	 * Editar uma mensagem
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {string} messageId - ID da mensagem
	 * @param {string} newText - Novo texto
	 */
	async editMessage(name, chatId, messageId, newText) {
		this.logger.warn(`editMessage is not natively supported by Wuzapi REST API.`);
		return { success: false, error: "Not supported" };
	}

	/**
	 * Responder a uma mensagem (reply)
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {string} messageId - ID da mensagem a responder
	 * @param {string} text - Texto da resposta
	 */
	async replyMessage(name, chatId, messageId, text) {
		return this.sendText(name, chatId, text, { replyTo: messageId });
	}

	/**
	 * Encaminhar mensagem
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID de destino
	 * @param {string} messageId - ID da mensagem a encaminhar
	 * @param {string} originalChatId - JID de origem
	 */
	async forwardMessage(name, chatId, messageId, originalChatId) {
		this.logger.warn(`forwardMessage is not natively supported by Wuzapi REST API.`);
		return { success: false, error: "Not supported" };
	}

	/**
	 * Marca mensagem como lida
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {string} messageId - ID da mensagem
	 */
	async markMessageRead(name, chatId, messageId) {
		return this.post("/chat/markread", {
			Id: [messageId],
			ChatPhone: chatId,
			SenderPhone: chatId
		});
	}

	// ──────────────────────────────────────────────────────────
	// Download de mídia
	// ──────────────────────────────────────────────────────────

	/**
	 * Baixa mídia de uma mensagem
	 * @param {string} name - Nome da instância
	 * @param {object} messageContent - Conteúdo da mensagem (imageMessage, videoMessage, etc)
	 */
	async downloadMedia(name, messageContent) {
		let type = "image";
		let mediaData = null;

		if (messageContent.imageMessage) {
			type = "image";
			mediaData = messageContent.imageMessage;
		} else if (messageContent.videoMessage) {
			type = "video";
			mediaData = messageContent.videoMessage;
		} else if (messageContent.audioMessage) {
			type = "audio";
			mediaData = messageContent.audioMessage;
		} else if (messageContent.documentMessage) {
			type = "document";
			mediaData = messageContent.documentMessage;
		} else if (messageContent.stickerMessage) {
			type = "sticker";
			mediaData = messageContent.stickerMessage;
		} else {
			mediaData = messageContent;
		}

		const payload = {
			Url: mediaData.url || mediaData.Url,
			MediaKey: mediaData.mediaKey ? (typeof mediaData.mediaKey === "string" ? mediaData.mediaKey : Buffer.from(mediaData.mediaKey).toString("base64")) : mediaData.MediaKey,
			Mimetype: mediaData.mimetype || mediaData.Mimetype,
			FileSha256: mediaData.fileSha256 ? (typeof mediaData.fileSha256 === "string" ? mediaData.fileSha256 : Buffer.from(mediaData.fileSha256).toString("base64")) : mediaData.FileSha256,
			FileLength: mediaData.fileLength !== undefined ? Number(mediaData.fileLength) : (mediaData.FileLength !== undefined ? Number(mediaData.FileLength) : 0)
		};

		return this.post(`/chat/download${type}`, payload);
	}

	// ──────────────────────────────────────────────────────────
	// Perfil da instância
	// ──────────────────────────────────────────────────────────

	/**
	 * Obtém informações do perfil da instância
	 * @param {string} name - Nome da instância
	 */
	async getProfileInfo(name) {
		const status = await this.get("/session/status");
		const phone = status?.phone;
		if (phone) {
			const info = await this.post("/user/info", { Phone: [`${phone}@s.whatsapp.net`] });
			const userDetails = info?.Users?.[`${phone}@s.whatsapp.net`] || {};
			return {
				name: name,
				phoneNumber: phone,
				pushName: userDetails.VerifiedName || "",
				status: userDetails.Status || ""
			};
		}
		return { name: name, state: status?.state || "disconnected" };
	}

	/**
	 * Atualiza nome do perfil
	 * @param {string} name - Nome da instância
	 * @param {string} displayName - Novo nome de exibição
	 */
	async updateProfileName(name, displayName) {
		this.logger.warn(`updateProfileName is not supported by Wuzapi.`);
		return { success: false };
	}

	/**
	 * Atualiza status do perfil (bio)
	 * @param {string} name - Nome da instância
	 * @param {string} status - Novo status
	 */
	async updateProfileStatus(name, status) {
		return this.post("/status/set/text", { Text: status });
	}

	/**
	 * Atualiza foto do perfil
	 * @param {string} name - Nome da instância
	 * @param {object} media - { url, base64 }
	 */
	async updateProfilePicture(name, media) {
		this.logger.warn(`updateProfilePicture is not supported by Wuzapi.`);
		return { success: false };
	}

	/**
	 * Remove foto do perfil
	 * @param {string} name - Nome da instância
	 */
	async removeProfilePicture(name) {
		this.logger.warn(`removeProfilePicture is not supported by Wuzapi.`);
		return { success: false };
	}

	// ──────────────────────────────────────────────────────────
	// Contatos
	// ──────────────────────────────────────────────────────────

	/**
	 * Obtém lista de contatos
	 * @param {string} name - Nome da instância
	 */
	async getContacts(name) {
		return this.get("/user/contacts");
	}

	/**
	 * Obtém informações de um contato
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato
	 */
	async getContactInfo(name, chatId) {
		const res = await this.post("/user/info", { Phone: [chatId] });
		return res?.Users?.[chatId] || res;
	}

	/**
	 * Obtém informações do perfil de um contato
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato
	 */
	async getContactProfile(name, chatId) {
		return this.post("/user/avatar", { Phone: chatId.split("@")[0], Preview: true });
	}

	// ──────────────────────────────────────────────────────────
	// Grupos
	// ──────────────────────────────────────────────────────────

	/**
	 * Lista grupos da instância
	 * @param {string} name - Nome da instância
	 */
	async listGroups(name) {
		const res = await this.get("/group/list");
		return res?.Groups || res;
	}

	/**
	 * Obtém informações de um grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 */
	async getGroupInfo(name, groupId) {
		const res = await this.userClient.request({
			method: "GET",
			url: "/group/info",
			data: { GroupJID: groupId }
		});
		return res.data;
	}

	/**
	 * Cria um grupo
	 * @param {string} name - Nome da instância
	 * @param {string} subject - Nome do grupo
	 * @param {string[]} participants - Array de JIDs dos participantes
	 * @param {string} description - Descrição do grupo
	 */
	async createGroup(name, subject, participants, description = "") {
		return this.post("/group/create", {
			name: subject,
			participants: participants.map(p => p.split("@")[0])
		});
	}

	/**
	 * Sai de um grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 */
	async leaveGroup(name, groupId) {
		return this.post("/group/leave", { GroupJID: groupId });
	}

	/**
	 * Entra em um grupo via invite code
	 * @param {string} name - Nome da instância
	 * @param {string} inviteCode - Código do invite
	 */
	async joinGroup(name, inviteCode) {
		const code = inviteCode.startsWith("http") ? inviteCode : `https://chat.whatsapp.com/${inviteCode}`;
		return this.post("/group/join", { Code: code });
	}

	/**
	 * Obtém informações de um invite
	 * @param {string} name - Nome da instância
	 * @param {string} inviteCode - Código do invite
	 */
	async getInviteInfo(name, inviteCode) {
		const code = inviteCode.startsWith("http") ? inviteCode : `https://chat.whatsapp.com/${inviteCode}`;
		return this.post("/group/inviteinfo", { Code: code });
	}

	/**
	 * Adiciona participante ao grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string[]} participants - Array de JIDs
	 */
	async addGroupParticipants(name, groupId, participants) {
		return this.post("/group/updateparticipants", {
			GroupJID: groupId,
			Phone: participants,
			Action: "add"
		});
	}

	/**
	 * Remove participante do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string[]} participants - Array de JIDs
	 */
	async removeGroupParticipants(name, groupId, participants) {
		return this.post("/group/updateparticipants", {
			GroupJID: groupId,
			Phone: participants,
			Action: "remove"
		});
	}

	/**
	 * Promove participante a admin
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string[]} participants - Array de JIDs
	 */
	async promoteParticipants(name, groupId, participants) {
		return this.post("/group/updateparticipants", {
			GroupJID: groupId,
			Phone: participants,
			Action: "promote"
		});
	}

	/**
	 * Rebaixa admin a participante
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string[]} participants - Array de JIDs
	 */
	async demoteParticipants(name, groupId, participants) {
		return this.post("/group/updateparticipants", {
			GroupJID: groupId,
			Phone: participants,
			Action: "demote"
		});
	}

	/**
	 * Atualiza assunto do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string} subject - Novo assunto
	 */
	async updateGroupSubject(name, groupId, subject) {
		return this.post("/group/name", { GroupJID: groupId, Name: subject });
	}

	/**
	 * Atualiza descrição do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string} description - Nova descrição
	 */
	async updateGroupDescription(name, groupId, description) {
		return this.post("/group/topic", { GroupJID: groupId, Topic: description });
	}

	/**
	 * Atualiza foto do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {object} media - { url, base64 }
	 */
	async updateGroupPicture(name, groupId, media) {
		const dataUri = await this._getMediaDataURI(media, "image/jpeg");
		return this.post("/group/photo", { GroupJID: groupId, Image: dataUri });
	}

	/**
	 * Obtém código de invite do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 */
	async getGroupInviteCode(name, groupId) {
		const res = await this.post("/group/invitelink", { GroupJID: groupId });
		return res?.InviteLink || res;
	}

	/**
	 * Revoga código de invite do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 */
	async revokeGroupInvite(name, groupId) {
		this.logger.warn(`revokeGroupInvite is not supported by Wuzapi.`);
		return { success: false };
	}

	// ──────────────────────────────────────────────────────────
	// Presença
	// ──────────────────────────────────────────────────────────

	/**
	 * Define presença (online/typing/recording)
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {string} presence - 'available', 'unavailable', 'composing', 'recording', 'paused'
	 */
	async setPresence(name, chatId, presence) {
		let state = "paused";
		let media = "";
		if (presence === "composing" || presence === "typing") {
			state = "composing";
		} else if (presence === "recording") {
			state = "composing";
			media = "audio";
		}
		return this.post("/chat/presence", {
			Phone: chatId,
			State: state,
			Media: media
		});
	}

	// ──────────────────────────────────────────────────────────
	// Bloqueio de contatos
	// ──────────────────────────────────────────────────────────

	/**
	 * Bloqueia um contato
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato
	 */
	async blockContact(name, chatId) {
		this.logger.warn(`blockContact is not supported by Wuzapi.`);
		return { success: false };
	}

	/**
	 * Desbloqueia um contato
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato
	 */
	async unblockContact(name, chatId) {
		this.logger.warn(`unblockContact is not supported by Wuzapi.`);
		return { success: false };
	}

	// ──────────────────────────────────────────────────────────
	// Chamadas
	// ──────────────────────────────────────────────────────────

	/**
	 * Rejeita chamada
	 * @param {string} name - Nome da instância
	 * @param {string} callId - ID da chamada
	 */
	async rejectCall(name, callId) {
		return this.post("/call/reject", { CallID: callId });
	}

	// ──────────────────────────────────────────────────────────
	// Chat
	// ──────────────────────────────────────────────────────────

	/**
	 * Arquivar chat
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do chat
	 * @param {boolean} archive - true = arquivar, false = desarquivar
	 */
	async archiveChat(name, chatId, archive = true) {
		this.logger.warn(`archiveChat is not supported by Wuzapi.`);
		return { success: false };
	}

	/**
	 * muta chat
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do chat
	 * @param {string} duration - Duração do mute (ex: '1h', '1d', 'always')
	 */
	async muteChat(name, chatId, duration) {
		this.logger.warn(`muteChat is not supported by Wuzapi.`);
		return { success: false };
	}

	/**
	 * Marca chat como não lido
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do chat
	 */
	async markChatUnread(name, chatId) {
		this.logger.warn(`markChatUnread is not supported by Wuzapi.`);
		return { success: false };
	}

	/**
	 * Pega mensagem por ID
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do chat
	 * @param {string} messageId - ID da mensagem
	 */
	async getMessage(name, chatId, messageId) {
		this.logger.warn(`getMessage is not supported by Wuzapi.`);
		return null;
	}
}

module.exports = WuzapiClient;
