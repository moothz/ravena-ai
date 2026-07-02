const Database = require("./Database");
const Logger = require("./Logger");

/**
 * Classe utilitária para verificação de permissões administrativas
 */
class AdminUtils {
	constructor() {
		this.logger = new Logger("admin-utils");
		this.database = Database.getInstance();
		this.superAdmins = process.env.SUPER_ADMINS ? process.env.SUPER_ADMINS.split(",") : [];
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

			// 2. Verifica 'additionalAdmins' no objeto de grupo
			if (group && Array.isArray(group.additionalAdmins)) {
				const isAdditionalAdmin = group.additionalAdmins
					.map(this._normalizeId) // Normaliza cada ID da lista de admins
					.includes(normalizedUserId);

				if (isAdditionalAdmin) {
					this.logger.debug(`Usuário ${normalizedUserId} é admin adicional no grupo ${group.id}.`);
					return true;
				}
			}

			// 3. Verifica se é admin no WhatsApp
			let chatInstance = chat;
			const client = botOrClient?.client || botOrClient;

			// Se o chat não foi fornecido ou é um pv, tenta buscá-lo usando o cliente
			if (
				(!chatInstance &&
					client &&
					typeof client.getChatById === "function" &&
					group &&
					group.id) ||
				!chat?.isGroup
			) {
				try {
					chatInstance = await client.getChatById(group.id);
					//this.logger.debug(`[isAdmin] Sem chat ou PV, buscando: `, {chatInstance});
				} catch (chatError) {
					this.logger.error(
						`Erro ao buscar chat ${group.id} para verificação de admin:`,
						chatError
					);
					// A função continua, mas provavelmente retornará false se esta era a única forma de ser admin.
				}
			}

			// 2. Verifica se é o responsável (ComuAdmin) - Apenas se o bot estiver no grupo
			if (this.isComuAdmin(normalizedUserId, botOrClient)) {
				let botInGroup = true;
				const botInstance =
					botOrClient?.bot || (botOrClient?.numeroResponsavel ? botOrClient : null);

				if (botInstance) {
					const botNumber = botInstance.phoneNumber;
					if (botNumber && chatInstance && chatInstance.participants) {
						const normalizedBotNumber = this._normalizeId(botNumber);
						botInGroup = chatInstance.participants.some((p) =>
							[p.id?._serialized, p.id, p.phoneNumber, p.lid, p.number].some(
								(field) => field && this._normalizeId(field) === normalizedBotNumber
							)
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

			let participantes = [];

			if (chatInstance && chatInstance.isGroup) {
				if (Array.isArray(chatInstance.participants)) {
					participantes = participantes.concat(chatInstance.participants);
				}
				if (chatInstance._rawGroup && Array.isArray(chatInstance._rawGroup.participants)) {
					participantes = participantes.concat(chatInstance._rawGroup.participants);
				}

				const participant = participantes.find(
					(p) =>
						p &&
						[p.id?._serialized, p.id, p.phoneNumber, p.lid, p.number].some(
							(numero) => numero && this._normalizeId(numero) === normalizedUserId
						)
				);

				if (debug)
					this.logger.debug(`[isAdmin][group] `, {
						normalizedUserId,
						botPart: participant,
						participantes
					});

				if (participant && (participant.isAdmin || participant.admin === "admin")) {
					this.logger.debug(
						`Usuário ${normalizedUserId} é admin no WhatsApp para o grupo ${group.id}.`
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
	 * Verifica se um usuário é super admin
	 * @param {string} userId - ID do usuário a verificar
	 * @returns {boolean} - True se o usuário for super admin
	 */
	isSuperAdmin(userId) {
		const normalizedUserId = this._normalizeId(userId);
		//this.logger.info(`[isSuperAdmin] ${normalizedUserId}`, this.superAdmins);
		return (
			normalizedUserId.length > 10 && this.superAdmins.some((sA) => sA.startsWith(normalizedUserId))
		);
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

		return normalizedUserId === normalizedResponsavel;
	}

	/**
	 * Verifica se um usuário é dono do grupo
	 * @param {string} userId - ID do usuário a verificar
	 * @param {Object} group - Objeto do grupo do banco de dados
	 * @returns {boolean} - True se o usuário for dono do grupo
	 */
	isGroupOwner(userId, group) {
		if (!group || !group.addedBy) return false;
		return group.addedBy === userId;
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
