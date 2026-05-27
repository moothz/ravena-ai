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

		this.client = axios.create({
			baseURL: this.baseUrl,
			headers: {
				"X-Auth-Token": this.adminToken,
				"Content-Type": "application/json",
			},
		});

		this.logger.info(
			`WuzapiClient inicializado${this.instanceName ? ` para instância: ${this.instanceName}` : ""}, baseUrl: ${this.baseUrl}`
		);
	}

	// ──────────────────────────────────────────────────────────
	// Métodos HTTP genéricos
	// ──────────────────────────────────────────────────────────

	async get(endpoint, params = {}) {
		try {
			const response = await this.client.get(endpoint, { params });
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
			const response = await this.client.post(endpoint, data, { params });
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
			const response = await this.client.put(endpoint, data, { params });
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
			const response = await this.client.delete(endpoint, { data, params });
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
	// Instâncias
	// ──────────────────────────────────────────────────────────

	/**
	 * Lista todas as instâncias
	 */
	async listInstances() {
		return this.get("/instances");
	}

	/**
	 * Cria uma nova instância
	 * @param {string} name - Nome da instância
	 * @param {object} options - Opções opcionais (webhook, etc)
	 */
	async createInstance(name, options = {}) {
		return this.post("/instances", { name, ...options });
	}

	/**
	 * Deleta uma instância
	 * @param {string} name - Nome da instância
	 */
	async deleteInstance(name) {
		return this.delete(`/instances/${encodeURIComponent(name)}`);
	}

	/**
	 * Obtém status de uma instância
	 * @param {string} name - Nome da instância
	 */
	async getInstanceStatus(name) {
		return this.get(`/instances/${encodeURIComponent(name)}/status`);
	}

	/**
	 * Obtém status de conexão (connectado/desconectado)
	 * @param {string} name - Nome da instância
	 */
	async getConnectionStatus(name) {
		return this.get(`/instances/${encodeURIComponent(name)}/connection`);
	}

	/**
	 * Conecta uma instância
	 * @param {string} name - Nome da instância
	 */
	async connectInstance(name) {
		return this.post(`/instances/${encodeURIComponent(name)}/connect`);
	}

	/**
	 * Desconecta uma instância
	 * @param {string} name - Nome da instância
	 */
	async disconnectInstance(name) {
		return this.post(`/instances/${encodeURIComponent(name)}/disconnect`);
	}

	/**
	 * Faz logout de uma instância
	 * @param {string} name - Nome da instância
	 */
	async logoutInstance(name) {
		return this.post(`/instances/${encodeURIComponent(name)}/logout`);
	}

	// ──────────────────────────────────────────────────────────
	// QR Code
	// ──────────────────────────────────────────────────────────

	/**
	 * Obtém QR code para escaneamento
	 * @param {string} name - Nome da instância
	 */
	async getQrCode(name) {
		return this.get(`/instances/${encodeURIComponent(name)}/qrcode`);
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
		return this.post(`/instances/${encodeURIComponent(name)}/webhook`, {
			url,
			secret,
		});
	}

	/**
	 * Obtém configuração de webhook de uma instância
	 * @param {string} name - Nome da instância
	 */
	async getWebhook(name) {
		return this.get(`/instances/${encodeURIComponent(name)}/webhook`);
	}

	// ──────────────────────────────────────────────────────────
	// Envio de mensagens
	// ──────────────────────────────────────────────────────────

	/**
	 * Envia mensagem de texto
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {string} text - Texto da mensagem
	 * @param {object} options - Opções (replyTo, mention, etc)
	 */
	async sendText(name, chatId, text, options = {}) {
		return this.post(`/instances/${encodeURIComponent(name)}/sendMessage`, {
			chatId,
			type: "text",
			content: { text },
			...options,
		});
	}

	/**
	 * Envia imagem
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} media - { url, base64, caption }
	 */
	async sendImage(name, chatId, media) {
		return this.post(`/instances/${encodeURIComponent(name)}/sendMessage`, {
			chatId,
			type: "image",
			content: media,
		});
	}

	/**
	 * Envia vídeo
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} media - { url, base64, caption }
	 */
	async sendVideo(name, chatId, media) {
		return this.post(`/instances/${encodeURIComponent(name)}/sendMessage`, {
			chatId,
			type: "video",
			content: media,
		});
	}

	/**
	 * Envia áudio
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} media - { url, base64, ptts (boolean) }
	 */
	async sendAudio(name, chatId, media) {
		return this.post(`/instances/${encodeURIComponent(name)}/sendMessage`, {
			chatId,
			type: "audio",
			content: media,
		});
	}

	/**
	 * Envia documento
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} media - { url, base64, fileName, caption }
	 */
	async sendDocument(name, chatId, media) {
		return this.post(`/instances/${encodeURIComponent(name)}/sendMessage`, {
			chatId,
			type: "document",
			content: media,
		});
	}

	/**
	 * Envia sticker
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} media - { url, base64 }
	 */
	async sendSticker(name, chatId, media) {
		return this.post(`/instances/${encodeURIComponent(name)}/sendMessage`, {
			chatId,
			type: "sticker",
			content: media,
		});
	}

	/**
	 * Envia localização
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} location - { latitude, longitude, name, address }
	 */
	async sendLocation(name, chatId, location) {
		return this.post(`/instances/${encodeURIComponent(name)}/sendMessage`, {
			chatId,
			type: "location",
			content: location,
		});
	}

	/**
	 * Envia mensagem genérica (qualquer tipo)
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {object} message - Objeto completo da mensagem
	 */
	async sendMessage(name, chatId, message) {
		return this.post(`/instances/${encodeURIComponent(name)}/sendMessage`, {
			chatId,
			...message,
		});
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
		return this.post(`/instances/${encodeURIComponent(name)}/sendReaction`, {
			chatId,
			messageId,
			emoji,
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
		return this.post(`/instances/${encodeURIComponent(name)}/deleteMessage`, {
			chatId,
			messageId,
			...options,
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
		return this.post(`/instances/${encodeURIComponent(name)}/editMessage`, {
			chatId,
			messageId,
			text: newText,
		});
	}

	/**
	 * Responder a uma mensagem (reply)
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {string} messageId - ID da mensagem a responder
	 * @param {string} text - Texto da resposta
	 */
	async replyMessage(name, chatId, messageId, text) {
		return this.post(`/instances/${encodeURIComponent(name)}/sendMessage`, {
			chatId,
			type: "text",
			content: { text },
			replyTo: messageId,
		});
	}

	/**
	 * Encaminhar mensagem
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID de destino
	 * @param {string} messageId - ID da mensagem a encaminhar
	 * @param {string} originalChatId - JID de origem
	 */
	async forwardMessage(name, chatId, messageId, originalChatId) {
		return this.post(`/instances/${encodeURIComponent(name)}/forwardMessage`, {
			chatId,
			messageId,
			originalChatId,
		});
	}

	/**
	 * Marca mensagem como lida
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato/grupo
	 * @param {string} messageId - ID da mensagem
	 */
	async markMessageRead(name, chatId, messageId) {
		return this.post(`/instances/${encodeURIComponent(name)}/readMessage`, {
			chatId,
			messageId,
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
		return this.post(`/instances/${encodeURIComponent(name)}/download`, {
			message: messageContent,
		});
	}

	// ──────────────────────────────────────────────────────────
	// Perfil da instância
	// ──────────────────────────────────────────────────────────

	/**
	 * Obtém informações do perfil da instância
	 * @param {string} name - Nome da instância
	 */
	async getProfileInfo(name) {
		return this.get(`/instances/${encodeURIComponent(name)}/profile`);
	}

	/**
	 * Atualiza nome do perfil
	 * @param {string} name - Nome da instância
	 * @param {string} displayName - Novo nome de exibição
	 */
	async updateProfileName(name, displayName) {
		return this.post(`/instances/${encodeURIComponent(name)}/profile/name`, {
			displayName,
		});
	}

	/**
	 * Atualiza status do perfil (bio)
	 * @param {string} name - Nome da instância
	 * @param {string} status - Novo status
	 */
	async updateProfileStatus(name, status) {
		return this.post(`/instances/${encodeURIComponent(name)}/profile/status`, {
			status,
		});
	}

	/**
	 * Atualiza foto do perfil
	 * @param {string} name - Nome da instância
	 * @param {object} media - { url, base64 }
	 */
	async updateProfilePicture(name, media) {
		return this.post(`/instances/${encodeURIComponent(name)}/profile/picture`, media);
	}

	/**
	 * Remove foto do perfil
	 * @param {string} name - Nome da instância
	 */
	async removeProfilePicture(name) {
		return this.delete(`/instances/${encodeURIComponent(name)}/profile/picture`);
	}

	// ──────────────────────────────────────────────────────────
	// Contatos
	// ──────────────────────────────────────────────────────────

	/**
	 * Obtém lista de contatos
	 * @param {string} name - Nome da instância
	 */
	async getContacts(name) {
		return this.get(`/instances/${encodeURIComponent(name)}/contacts`);
	}

	/**
	 * Obtém informações de um contato
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato
	 */
	async getContactInfo(name, chatId) {
		return this.get(`/instances/${encodeURIComponent(name)}/contacts/${encodeURIComponent(chatId)}`);
	}

	/**
	 * Obtém informações do perfil de um contato
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato
	 */
	async getContactProfile(name, chatId) {
		return this.get(`/instances/${encodeURIComponent(name)}/contacts/${encodeURIComponent(chatId)}/profile`);
	}

	// ──────────────────────────────────────────────────────────
	// Grupos
	// ──────────────────────────────────────────────────────────

	/**
	 * Lista grupos da instância
	 * @param {string} name - Nome da instância
	 */
	async listGroups(name) {
		return this.get(`/instances/${encodeURIComponent(name)}/groups`);
	}

	/**
	 * Obtém informações de um grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 */
	async getGroupInfo(name, groupId) {
		return this.get(`/instances/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}`);
	}

	/**
	 * Cria um grupo
	 * @param {string} name - Nome da instância
	 * @param {string} subject - Nome do grupo
	 * @param {string[]} participants - Array de JIDs dos participantes
	 * @param {string} description - Descrição do grupo
	 */
	async createGroup(name, subject, participants, description = "") {
		return this.post(`/instances/${encodeURIComponent(name)}/groups/create`, {
			subject,
			participants,
			description,
		});
	}

	/**
	 * Sai de um grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 */
	async leaveGroup(name, groupId) {
		return this.post(`/instances/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/leave`);
	}

	/**
	 * Entra em um grupo via invite code
	 * @param {string} name - Nome da instância
	 * @param {string} inviteCode - Código do invite
	 */
	async joinGroup(name, inviteCode) {
		return this.post(`/instances/${encodeURIComponent(name)}/groups/join`, {
			inviteCode,
		});
	}

	/**
	 * Obtém informações de um invite
	 * @param {string} name - Nome da instância
	 * @param {string} inviteCode - Código do invite
	 */
	async getInviteInfo(name, inviteCode) {
		return this.get(`/instances/${encodeURIComponent(name)}/groups/invite/${encodeURIComponent(inviteCode)}`);
	}

	/**
	 * Adiciona participante ao grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string[]} participants - Array de JIDs
	 */
	async addGroupParticipants(name, groupId, participants) {
		return this.post(`/instances/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/add`, {
			participants,
		});
	}

	/**
	 * Remove participante do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string[]} participants - Array de JIDs
	 */
	async removeGroupParticipants(name, groupId, participants) {
		return this.post(`/instances/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/remove`, {
			participants,
		});
	}

	/**
	 * Promove participante a admin
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string[]} participants - Array de JIDs
	 */
	async promoteParticipants(name, groupId, participants) {
		return this.post(`/instances/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/promote`, {
			participants,
		});
	}

	/**
	 * Rebaixa admin a participante
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string[]} participants - Array de JIDs
	 */
	async demoteParticipants(name, groupId, participants) {
		return this.post(`/instances/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/demote`, {
			participants,
		});
	}

	/**
	 * Atualiza assunto do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string} subject - Novo assunto
	 */
	async updateGroupSubject(name, groupId, subject) {
		return this.post(`/instances/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/subject`, {
			subject,
		});
	}

	/**
	 * Atualiza descrição do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {string} description - Nova descrição
	 */
	async updateGroupDescription(name, groupId, description) {
		return this.post(`/instances/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/description`, {
			description,
		});
	}

	/**
	 * Atualiza foto do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 * @param {object} media - { url, base64 }
	 */
	async updateGroupPicture(name, groupId, media) {
		return this.post(`/instances/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/picture`, media);
	}

	/**
	 * Obtém código de invite do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 */
	async getGroupInviteCode(name, groupId) {
		return this.get(`/instances/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/invite`);
	}

	/**
	 * Revoga código de invite do grupo
	 * @param {string} name - Nome da instância
	 * @param {string} groupId - JID do grupo
	 */
	async revokeGroupInvite(name, groupId) {
		return this.post(`/instances/${encodeURIComponent(name)}/groups/${encodeURIComponent(groupId)}/revoke-invite`);
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
		return this.post(`/instances/${encodeURIComponent(name)}/presence`, {
			chatId,
			presence,
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
		return this.post(`/instances/${encodeURIComponent(name)}/block`, { chatId });
	}

	/**
	 * Desbloqueia um contato
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do contato
	 */
	async unblockContact(name, chatId) {
		return this.post(`/instances/${encodeURIComponent(name)}/unblock`, { chatId });
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
		return this.post(`/instances/${encodeURIComponent(name)}/rejectCall`, { callId });
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
		return this.post(`/instances/${encodeURIComponent(name)}/chat/archive`, {
			chatId,
			archive,
		});
	}

	/**
	 * muta chat
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do chat
	 * @param {string} duration - Duração do mute (ex: '1h', '1d', 'always')
	 */
	async muteChat(name, chatId, duration) {
		return this.post(`/instances/${encodeURIComponent(name)}/chat/mute`, {
			chatId,
			duration,
		});
	}

	/**
	 * Marca chat como não lido
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do chat
	 */
	async markChatUnread(name, chatId) {
		return this.post(`/instances/${encodeURIComponent(name)}/chat/unread`, { chatId });
	}

	/**
	 * Pega mensagem por ID
	 * @param {string} name - Nome da instância
	 * @param {string} chatId - JID do chat
	 * @param {string} messageId - ID da mensagem
	 */
	async getMessage(name, chatId, messageId) {
		return this.get(`/instances/${encodeURIComponent(name)}/messages/${encodeURIComponent(messageId)}`, {
			chatId,
		});
	}
}

module.exports = WuzapiClient;