const Database = require("./Database");
const AdminUtils = require("./AdminUtils");
const ReturnMessage = require("../models/ReturnMessage");

class GroupContextHelper {
	/**
	 * Resolve o grupo de contexto para o comando:
	 * - Se a mensagem veio em um grupo, retorna o grupo da mensagem.
	 * - Se a mensagem veio no PV, verifica se há grupo ativo em privateManagement.
	 *
	 * @param {Object} bot Instância do bot
	 * @param {Object} message Mensagem recebida
	 * @param {Object} [group] Grupo passado pelo CommandHandler (pode ser null/undefined no PV)
	 * @param {Object} [options] Opções adicionais
	 * @param {string} [options.featureName] Nome legível do recurso para mensagens amigáveis
	 * @returns {Promise<{
	 *   targetGroup: Object|null,
	 *   isPrivate: boolean,
	 *   responseChatId: string,
	 *   errorResponse: ReturnMessage|null
	 * }>}
	 */
	static async resolveGroup(bot, message, group = null, options = {}) {
		const isPrivate = !message.group;
		const responseChatId = message.group ?? message.author;
		let targetGroup = group;

		if (isPrivate) {
			const managedGroupId = bot.eventHandler?.commandHandler?.privateManagement?.[message.author];
			if (managedGroupId) {
				targetGroup = await Database.getInstance().getGroup(managedGroupId);
			}
		}

		if (!targetGroup) {
			const featureText = options.featureName ? ` para ${options.featureName}` : "";
			const content = isPrivate
				? `⚠️ *Atenção:* Para usar este comando no chat privado${featureText}, selecione primeiro um grupo com \`!g-manage [nomeDoGrupo]\`.`
				: `❌ Este comando só pode ser utilizado dentro de grupos.`;

			return {
				targetGroup: null,
				isPrivate,
				responseChatId,
				errorResponse: new ReturnMessage({
					chatId: responseChatId,
					content,
					options: {
						quotedMessageId: message.origin?.id?._serialized,
						goReply: message.origin
					}
				})
			};
		}

		return {
			targetGroup,
			isPrivate,
			responseChatId,
			errorResponse: null
		};
	}

	/**
	 * Resolve o grupo e valida se o autor da mensagem tem privilégios de administrador no grupo alvo.
	 *
	 * @param {Object} bot Instância do bot
	 * @param {Object} message Mensagem recebida
	 * @param {Object} [group] Grupo passado pelo CommandHandler
	 * @param {Object} [options] Opções adicionais
	 * @param {string} [options.featureName] Nome legível da funcionalidade
	 * @returns {Promise<{
	 *   targetGroup: Object|null,
	 *   isPrivate: boolean,
	 *   responseChatId: string,
	 *   errorResponse: ReturnMessage|null
	 * }>}
	 */
	static async resolveGroupAndAdmin(bot, message, group = null, options = {}) {
		const result = await this.resolveGroup(bot, message, group, options);
		if (result.errorResponse) {
			return result;
		}

		const isUserAdmin = await AdminUtils.getInstance().isAdmin(
			message.author,
			result.targetGroup,
			null,
			bot
		);

		if (!isUserAdmin) {
			const featureText = options.featureName ? ` ${options.featureName}` : "";
			return {
				targetGroup: null,
				isPrivate: result.isPrivate,
				responseChatId: result.responseChatId,
				errorResponse: new ReturnMessage({
					chatId: result.responseChatId,
					content: `⛔ *Acesso negado:* Apenas administradores do grupo *'${result.targetGroup.name || result.targetGroup.id}'* podem alterar${featureText}.`,
					options: {
						quotedMessageId: message.origin?.id?._serialized,
						goReply: message.origin
					}
				})
			};
		}

		return result;
	}
}

module.exports = GroupContextHelper;
