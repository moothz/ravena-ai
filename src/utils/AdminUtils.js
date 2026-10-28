const Database = require("./Database");
const Logger = require("./Logger");
const PhoneUtils = require("./PhoneUtils");
const MemoryCache = require("./MemoryCache");

/**
 * Classe utilitária para verificação de permissões administrativas
 */
class AdminUtils {
	constructor() {
		this.logger = new Logger("admin-utils");
		this.database = Database.getInstance();
		this.superAdmins = process.env.SUPER_ADMINS
			? process.env.SUPER_ADMINS.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: [];
		// Cache de fallback de 12 horas para status de admin (usado APENAS em caso de fallback)
		this.adminFallbackCache = new MemoryCache(12 * 60 * 60 * 1000, 5000);
	}

	_normalizeId(id, logger) {
		if (typeof id !== "string" || (!id && id !== 0)) {
			return "";
		}

		// Pega a parte antes do '@', e depois a parte antes do ':'
		const cleanId = id.split("@")[0].split(":")[0];

		// Valida se o ID limpo contém apenas dígitos.
		if (cleanId && !/^\d+$/.test(cleanId)) {
			if (logger && typeof logger.error === "function") {
				logger.error(
					`[isAdmin] ID inválido detectado: "${id}" resultou em "${cleanId}", que contém caracteres não numéricos.`
				);
			}
		}

		return cleanId;
	}

	/**
	 * Verifica se um usuário é administrador no grupo
	 * @param {string} userId - ID do usuário a verificar
	 * @param {Object} group - Objeto do grupo do banco de dados
	 * @param {Object} chat - Objeto de chat do WhatsApp (opcional)
	 * @param {Object} client - Instância do cliente WhatsApp (opcional)
	 * @returns {Promise<boolean>} - True se o usuário for admin
	 */
	async isAdmin(userId, group, chat = null, botOrClient = null, debug = false) {
		try {
			const normalizedUserId = this._normalizeId(userId);

			if (debug) this.logger.debug(`[isAdmin] `, { userId, normalizedUserId, group, chat });

			// Se o ID normalizado for vazio, o usuário é inválido.
			if (!normalizedUserId) {
				this.logger.debug(`ID de usuário inválido fornecido: ${userId}`);
				return false;
			}

			// 1. Verifica se é um super admin (usando o ID normalizado)
			if (this.isSuperAdmin(normalizedUserId)) {
				this.logger.debug(`Usuário ${normalizedUserId} é super admin.`);
				return true;
			}

			// 2. Verifica se é dono/criador do grupo (addedBy)
			if (this.isGroupOwner(userId, group)) {
				this.logger.debug(`Usuário ${normalizedUserId} é dono (addedBy) do grupo ${group?.id}.`);
				return true;
			}

			// 3. Verifica 'additionalAdmins' no objeto de grupo
			if (group && Array.isArray(group.additionalAdmins)) {
				const isAdditionalAdmin = group.additionalAdmins.some((adm) => {
					if (!adm) return false;
					const cleanAdm = this._normalizeId(adm);
					return (
						cleanAdm === normalizedUserId || PhoneUtils.isSamePhone(cleanAdm, normalizedUserId)
					);
				});

				if (isAdditionalAdmin) {
					this.logger.debug(`Usuário ${normalizedUserId} é admin adicional no grupo ${group.id}.`);
					return true;
				}
			}

			// 4. Verifica se é admin no WhatsApp com o bot atual
			let chatInstance = chat;
			const client = botOrClient?.client || botOrClient;

			let hasParticipants =
				chatInstance &&
				((Array.isArray(chatInstance.participants) && chatInstance.participants.length > 0) ||
					(Array.isArray(chatInstance._rawGroup?.participants) &&
						chatInstance._rawGroup.participants.length > 0));

			// Se o chat não foi fornecido, está sem participantes ou é um pv, tenta buscá-lo usando o cliente
			if (
				client &&
				typeof client.getChatById === "function" &&
				group &&
				group.id &&
				(!chatInstance || (chatInstance.isGroup && !hasParticipants) || !chat?.isGroup)
			) {
				try {
					chatInstance = await client.getChatById(group.id);
					hasParticipants =
						chatInstance &&
						((Array.isArray(chatInstance.participants) && chatInstance.participants.length > 0) ||
							(Array.isArray(chatInstance._rawGroup?.participants) &&
								chatInstance._rawGroup.participants.length > 0));
				} catch (chatError) {
					this.logger.error(
						`Erro ao buscar chat ${group.id} para verificação de admin:`,
						chatError
					);
				}
			}

			// 5. Verifica se é o responsável (ComuAdmin) - Apenas se o bot estiver no grupo
			if (this.isComuAdmin(normalizedUserId, botOrClient)) {
				let botInGroup = true;
				const botInstance =
					botOrClient?.bot || (botOrClient?.numeroResponsavel ? botOrClient : null);

				if (botInstance) {
					const botNumber = botInstance.phoneNumber;
					if (botNumber && chatInstance && chatInstance.participants) {
						const normalizedBotNumber = this._normalizeId(botNumber);
						botInGroup = chatInstance.participants.some((p) =>
							[p.id?._serialized, p.id, p.phoneNumber, p.lid, p.number].some((field) => {
								if (!field) return false;
								const cleanField = this._normalizeId(field);
								return (
									cleanField === normalizedBotNumber ||
									PhoneUtils.isSamePhone(cleanField, normalizedBotNumber)
								);
							})
						);

						if (!botInGroup) {
							this.logger.debug(
								`Usuário ${normalizedUserId} é ComuAdmin, mas o bot ${normalizedBotNumber} não está no grupo ${group?.id} (${group.name}).`,
								{ participants: chatInstance.participants }
							);
						}
					} else if (botNumber && (!chatInstance || !chatInstance.participants)) {
						this.logger.warn(
							`Não foi possível verificar presença do bot no grupo ${group?.id} (participantes ausentes), assumindo presenca=true para ComuAdmin.`
						);
					}
				}

				if (botInGroup) {
					this.logger.debug(`Usuário ${normalizedUserId} é ComuAdmin.`);
					return true;
				}
			}

			// 6. Verifica se é admin no chatInstance obtido pelo bot atual
			if (this._isUserAdminInChat(normalizedUserId, chatInstance, debug, group?.id)) {
				this.logger.debug(
					`Usuário ${normalizedUserId} é admin no WhatsApp para o grupo ${group.id}.`
				);
				return true;
			}

			// 7. Fallback Cross-Bot: Se o bot atual não está no grupo ou não conseguiu os participantes,
			// consulta os outros bots ativos no sistema para ver se algum deles está no grupo e valida o admin
			if (group && group.id) {
				const isCrossAdmin = await this._verifyAdminAcrossBots(
					normalizedUserId,
					group,
					botOrClient,
					debug
				);
				if (isCrossAdmin) {
					return true;
				}
			}

			// 8. Fallback Cache (12 horas): Usado APENAS em caso de falha na verificação em tempo real
			// (ex: erro de rede, timeout ao buscar chat, participantes indisponíveis ou desconectado).
			// Se o chat tinha participantes válidos e o usuário simplesmente não era admin, o fallback NÃO é usado.
			if (group && group.id && !hasParticipants) {
				const isCachedAdmin = this.adminFallbackCache?.get(`${group.id}:${normalizedUserId}`);
				if (isCachedAdmin === true) {
					this.logger.info(
						`[AdminUtils] [Fallback Cache 12h] Usuário/Bot ${normalizedUserId} considerado admin no grupo ${group.id} via cache de fallback.`
					);
					return true;
				}
			}

			// Se nenhuma das verificações acima passou, o usuário não é admin.
			return false;
		} catch (error) {
			this.logger.error(`Erro ao verificar se o usuário ${userId} é admin:`, error);
			return false; // Retorna false em caso de erro inesperado.
		}
	}

	/**
	 * Atualiza o cache de fallback de 12 horas com todos os admins presentes nos participantes
	 */
	_updateFallbackCacheFromParticipants(groupId, participantes) {
		if (!groupId || !Array.isArray(participantes) || participantes.length === 0) return;
		for (const p of participantes) {
			if (!p) continue;
			const isAdmin = !!(p.isAdmin || p.admin === "admin" || p.isSuperAdmin);
			if (isAdmin) {
				const numbers = [p.id?._serialized, p.id, p.phoneNumber, p.lid, p.number];
				for (const num of numbers) {
					if (!num) continue;
					const clean = this._normalizeId(num);
					if (clean) {
						this.adminFallbackCache.set(`${groupId}:${clean}`, true);
					}
				}
			}
		}
	}

	/**
	 * Verifica se o usuário é admin em um objeto de chat com participantes
	 */
	_isUserAdminInChat(normalizedUserId, chatInstance, debug = false, groupId = null) {
		if (!chatInstance || !chatInstance.isGroup) return false;

		let participantes = [];
		if (Array.isArray(chatInstance.participants)) {
			participantes = participantes.concat(chatInstance.participants);
		}
		if (chatInstance._rawGroup && Array.isArray(chatInstance._rawGroup.participants)) {
			participantes = participantes.concat(chatInstance._rawGroup.participants);
		}

		if (participantes.length === 0) return false;

		const targetGroupId = groupId || chatInstance.id?._serialized || chatInstance.id;
		if (targetGroupId && this.adminFallbackCache) {
			this._updateFallbackCacheFromParticipants(targetGroupId, participantes);
		}

		const participant = participantes.find((p) => {
			if (!p) return false;
			return [p.id?._serialized, p.id, p.phoneNumber, p.lid, p.number].some((numero) => {
				if (!numero) return false;
				const cleanNum = this._normalizeId(numero);
				return cleanNum === normalizedUserId || PhoneUtils.isSamePhone(cleanNum, normalizedUserId);
			});
		});

		if (debug) {
			this.logger.debug(`[_isUserAdminInChat] `, {
				normalizedUserId,
				botPart: participant,
				participantesCount: participantes.length
			});
		}

		return !!(
			participant &&
			(participant.isAdmin || participant.admin === "admin" || participant.isSuperAdmin)
		);
	}

	/**
	 * Verifica se o usuário é admin do grupo consultando outras instâncias ativas de Ravena (Cross-Bot)
	 */
	async _verifyAdminAcrossBots(normalizedUserId, group, currentBotOrClient = null, debug = false) {
		try {
			const allBots = this.database.botInstances || [];
			if (!Array.isArray(allBots) || allBots.length === 0) {
				return false;
			}

			const currentBotId = currentBotOrClient?.id || currentBotOrClient?.bot?.id;
			const isWhatsAppGroup = group.id.includes("@g.us");
			const excludedBots = new Set(Array.isArray(group.botNotInGroup) ? group.botNotInGroup : []);

			// Prioridade 1: Buscar o bot que a base de dados registra como ativo no grupo
			let preferredBotId = null;
			if (typeof this.database.getActiveBotIdForGroup === "function") {
				preferredBotId = await this.database.getActiveBotIdForGroup(group.id);
			}

			// Ordena candidatos: primeiro o bot ativo registrado no banco, depois os demais
			const candidateBots = [];
			if (preferredBotId) {
				const preferredBot = allBots.find(
					(b) =>
						(b.id === preferredBotId || b.name === preferredBotId) &&
						b.id !== currentBotId &&
						b.isConnected !== false
				);
				if (preferredBot) {
					candidateBots.push(preferredBot);
				}
			}

			for (const b of allBots) {
				if (!b || b.id === currentBotId || b.id === preferredBotId) continue;
				if (b.isConnected === false) continue;
				if (isWhatsAppGroup && (b.useTelegram || b.useDiscord)) continue;
				if (excludedBots.has(b.id)) continue;
				if (typeof b.isParticipating === "function" && !b.isParticipating(group.id)) continue;

				candidateBots.push(b);
			}

			for (const candidate of candidateBots) {
				try {
					const client = candidate.client || candidate;
					if (client && typeof client.getChatById === "function") {
						const chat = await client.getChatById(group.id);
						if (chat && chat.isGroup && !chat.notInGroup) {
							const isAdminInCandidate = this._isUserAdminInChat(normalizedUserId, chat, debug);
							if (isAdminInCandidate) {
								this.logger.info(
									`[Cross-Bot] Usuário ${normalizedUserId} confirmado como admin do grupo ${group.id} via bot '${candidate.id || candidate.name}'.`
								);
								return true;
							}
						}
					}
				} catch (err) {
					this.logger.debug(
						`[Cross-Bot] Falha ao consultar chat via bot '${candidate.id || candidate.name}': ${err.message}`
					);
				}
			}

			return false;
		} catch (error) {
			this.logger.error(`[Cross-Bot] Erro ao verificar admin across bots:`, error);
			return false;
		}
	}

	/**
	 * Verifica se um usuário é super admin
	 * @param {string} userId - ID do usuário a verificar
	 * @returns {boolean} - True se o usuário for super admin
	 */
	isSuperAdmin(userId) {
		if (!userId) return false;
		const normalizedUserId = this._normalizeId(userId);
		if (!normalizedUserId || normalizedUserId.length < 8) return false;
		return this.superAdmins.some((sA) => {
			const cleanSA = this._normalizeId(sA);
			return (
				cleanSA === normalizedUserId ||
				sA.startsWith(normalizedUserId) ||
				normalizedUserId.startsWith(cleanSA)
			);
		});
	}

	/**
	 * Verifica se o usuário é o responsável (ComuAdmin) pelo bot
	 * @param {string} userId - ID do usuário
	 * @param {Object} botOrClient - Instância do bot ou do cliente
	 * @returns {boolean} - True se for o responsável
	 */
	isComuAdmin(userId, botOrClient) {
		if (!botOrClient) return false;

		const numeroResponsavel = botOrClient.numeroResponsavel || botOrClient.bot?.numeroResponsavel;
		if (!numeroResponsavel) return false;

		const normalizedUserId = this._normalizeId(userId);
		const normalizedResponsavel = this._normalizeId(numeroResponsavel);

		return (
			normalizedUserId === normalizedResponsavel ||
			PhoneUtils.isSamePhone(normalizedUserId, normalizedResponsavel)
		);
	}

	/**
	 * Verifica se um usuário é dono do grupo
	 * @param {string} userId - ID do usuário a verificar
	 * @param {Object} group - Objeto do grupo do banco de dados
	 * @returns {boolean} - True se o usuário for dono do grupo
	 */
	isGroupOwner(userId, group) {
		if (!group || !group.addedBy) return false;
		const normalizedUserId = this._normalizeId(userId);
		const cleanAddedBy = this._normalizeId(group.addedBy);
		return (
			cleanAddedBy === normalizedUserId || PhoneUtils.isSamePhone(cleanAddedBy, normalizedUserId)
		);
	}
}

// Singleton para reutilização
let instance = null;

module.exports = {
	getInstance: () => {
		if (!instance) {
			instance = new AdminUtils();
		}
		return instance;
	}
};
