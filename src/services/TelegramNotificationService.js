const axios = require("axios");
const Logger = require("../utils/Logger");
const TelegramPollingBackoff = require("./TelegramPollingBackoff");

/**
 * Serviço centralizado para envio e moderação de notificações administrativas via Telegram
 * utilizando NOTIFICATIONS_TELEGRAM_BOT_TOKEN com fallback para HEALTH_CHECK_TELEGRAM_BOT_TOKEN.
 */
class TelegramNotificationService {
	/**
	 * @param {Object} [options]
	 * @param {string} [options.token]
	 * @param {string|number} [options.chatId]
	 * @param {string|number} [options.inviteChatId]
	 * @param {Array} [options.bots]
	 * @param {Object} [options.database]
	 */
	constructor(options = {}) {
		this.token =
			options.token ||
			process.env.NOTIFICATIONS_TELEGRAM_BOT_TOKEN ||
			process.env.HEALTH_CHECK_TELEGRAM_BOT_TOKEN ||
			null;
		this.chatId = options.chatId || process.env.HEALTH_CHECK_TELEGRAM_CHAT_ID || null;
		this.inviteChatId = options.inviteChatId || process.env.GRUPO_INVITES_TELEGRAM || null;
		this.bots = options.bots || [];
		this.database = options.database || null;
		this.logger = new Logger("telegram-notifications");

		this.isPolling = false;
		this.pollTimer = null;
		this.updateOffset = 0;
	}

	/**
	 * Resolve o token do bot Telegram priorizando NOTIFICATIONS_TELEGRAM_BOT_TOKEN > HEALTH_CHECK_TELEGRAM_BOT_TOKEN
	 * @param {Object} [options]
	 * @returns {string|null}
	 */
	getToken(options = {}) {
		return (
			options.telegramToken ||
			this.token ||
			process.env.NOTIFICATIONS_TELEGRAM_BOT_TOKEN ||
			process.env.HEALTH_CHECK_TELEGRAM_BOT_TOKEN ||
			null
		);
	}

	/**
	 * Obtém ou inicializa a instância singleton do serviço
	 * @param {Object} [options]
	 * @returns {TelegramNotificationService}
	 */
	static getInstance(options = {}) {
		if (!TelegramNotificationService.instance) {
			TelegramNotificationService.instance = new TelegramNotificationService(options);
		} else {
			if (options.bots && options.bots.length > 0) {
				TelegramNotificationService.instance.setBots(options.bots);
			}
			if (options.database) {
				TelegramNotificationService.instance.setDatabase(options.database);
			}
			if (options.token) {
				TelegramNotificationService.instance.token = options.token;
			}
			if (options.chatId) {
				TelegramNotificationService.instance.chatId = options.chatId;
			}
			if (options.inviteChatId) {
				TelegramNotificationService.instance.inviteChatId = options.inviteChatId;
			}
		}
		return TelegramNotificationService.instance;
	}

	/**
	 * Atualiza a lista de bots gerenciados
	 * @param {Array} bots
	 */
	setBots(bots) {
		this.bots = Array.isArray(bots) ? bots : [];
	}

	/**
	 * Atualiza a referência do banco de dados
	 * @param {Object} db
	 */
	setDatabase(db) {
		this.database = db;
	}

	/**
	 * Envia mensagem genérica via Telegram
	 * @param {string|number} chatId
	 * @param {string} text
	 * @param {Object} [options]
	 * @returns {Promise<{success: boolean, messageId?: number, error?: string}>}
	 */
	async sendNotification(chatId, text, options = {}) {
		const token = this.getToken(options);
		const targetChatId = chatId || this.chatId || process.env.HEALTH_CHECK_TELEGRAM_CHAT_ID;

		if (!token || !targetChatId) {
			this.logger.warn(
				"[sendNotification] Telegram token ou chatId não configurados. Envio cancelado."
			);
			return { success: false, error: "Token ou ChatId não configurados" };
		}

		try {
			const payload = {
				chat_id: targetChatId,
				text,
				parse_mode: options.parse_mode || "HTML"
			};

			if (options.reply_markup) {
				payload.reply_markup = options.reply_markup;
			}

			const url = `https://api.telegram.org/bot${token}/sendMessage`;
			const response = await axios.post(url, payload, { timeout: 15000 });

			if (response.data && response.data.ok) {
				return {
					success: true,
					messageId: response.data.result?.message_id
				};
			}

			this.logger.error("[sendNotification] Resposta inesperada do Telegram:", response.data);
			return { success: false, error: "Resposta inesperada da API do Telegram" };
		} catch (error) {
			const errMsg = error.response?.data?.description || error.message;
			this.logger.error(`[sendNotification] Falha ao enviar para Telegram: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	/**
	 * Envia alerta administrativo para o chat padrão de health check
	 * @param {string} text
	 * @param {Object} [options]
	 * @returns {Promise<{success: boolean, messageId?: number, error?: string}>}
	 */
	async sendAlert(text, options = {}) {
		return this.sendNotification(this.chatId, text, options);
	}

	/**
	 * Edita o texto ou botões de uma mensagem já enviada
	 * @param {string|number} chatId
	 * @param {number} messageId
	 * @param {string} text
	 * @param {Object} [options]
	 * @returns {Promise<boolean>}
	 */
	async editMessageText(chatId, messageId, text, options = {}) {
		const token = this.getToken(options);
		if (!token || !chatId || !messageId) return false;

		try {
			const payload = {
				chat_id: chatId,
				message_id: messageId,
				text,
				parse_mode: options.parse_mode || "HTML"
			};

			if (options.reply_markup !== undefined) {
				payload.reply_markup = options.reply_markup;
			}

			const url = `https://api.telegram.org/bot${token}/editMessageText`;
			const response = await axios.post(url, payload, { timeout: 10000 });
			return !!(response.data && response.data.ok);
		} catch (error) {
			const errMsg = error.response?.data?.description || error.message;
			this.logger.error(`[editMessageText] Falha ao editar mensagem: ${errMsg}`);
			return false;
		}
	}

	/**
	 * Responde a uma callback query para remover o loading do botão no cliente Telegram
	 * @param {string} callbackQueryId
	 * @param {Object} [options]
	 * @returns {Promise<boolean>}
	 */
	async answerCallbackQuery(callbackQueryId, options = {}) {
		const token = this.getToken(options);
		if (!token || !callbackQueryId) return false;

		try {
			const payload = {
				callback_query_id: callbackQueryId,
				text: options.text || "",
				show_alert: options.show_alert || false
			};

			const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
			const response = await axios.post(url, payload, { timeout: 10000 });
			return !!(response.data && response.data.ok);
		} catch (error) {
			const errMsg = error.response?.data?.description || error.message;
			this.logger.error(`[answerCallbackQuery] Falha ao responder callback: ${errMsg}`);
			return false;
		}
	}

	/**
	 * Remove qualquer webhook ativo para permitir o modo long-polling getUpdates
	 * @param {Object} [options]
	 * @returns {Promise<boolean>}
	 */
	async deleteWebhook(options = {}) {
		const token = this.getToken(options);
		if (!token) return false;

		try {
			const url = `https://api.telegram.org/bot${token}/deleteWebhook`;
			const response = await axios.post(url, { drop_pending_updates: false }, { timeout: 10000 });
			return !!(response.data && response.data.ok);
		} catch (error) {
			if (!TelegramPollingBackoff.isTokenRejected(error)) {
				this.logger.error(`[deleteWebhook] Falha ao deletar webhook: ${error.message}`);
			}
			return false;
		}
	}

	/**
	 * Envia foto com caption e botões interativos via Telegram
	 * @param {string|number} chatId
	 * @param {string} photoUrl
	 * @param {string} [caption]
	 * @param {Object} [options]
	 * @returns {Promise<{success: boolean, messageId?: number, error?: string}>}
	 */
	async sendPhoto(chatId, photoUrl, caption = "", options = {}) {
		const token = this.getToken(options);
		const targetChatId = chatId || this.chatId || process.env.HEALTH_CHECK_TELEGRAM_CHAT_ID;

		if (!token || !targetChatId || !photoUrl) {
			return { success: false, error: "Token, ChatId ou Foto não configurados" };
		}

		try {
			const payload = {
				chat_id: targetChatId,
				photo: photoUrl,
				caption,
				parse_mode: options.parse_mode || "HTML"
			};

			if (options.reply_markup) {
				payload.reply_markup = options.reply_markup;
			}

			const url = `https://api.telegram.org/bot${token}/sendPhoto`;
			const response = await axios.post(url, payload, { timeout: 15000 });

			if (response.data && response.data.ok) {
				return {
					success: true,
					messageId: response.data.result?.message_id
				};
			}

			this.logger.error("[sendPhoto] Resposta inesperada do Telegram:", response.data);
			return { success: false, error: "Resposta inesperada da API do Telegram" };
		} catch (error) {
			const errMsg = error.response?.data?.description || error.message;
			this.logger.error(`[sendPhoto] Falha ao enviar foto para Telegram: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	/**
	 * Edita o caption de uma mensagem com foto enviada anteriormente
	 * @param {string|number} chatId
	 * @param {number} messageId
	 * @param {string} caption
	 * @param {Object} [options]
	 * @returns {Promise<boolean>}
	 */
	async editMessageCaption(chatId, messageId, caption, options = {}) {
		const token = this.getToken(options);
		if (!token || !chatId || !messageId) return false;

		try {
			const payload = {
				chat_id: chatId,
				message_id: messageId,
				caption,
				parse_mode: options.parse_mode || "HTML"
			};

			if (options.reply_markup !== undefined) {
				payload.reply_markup = options.reply_markup;
			}

			const url = `https://api.telegram.org/bot${token}/editMessageCaption`;
			const response = await axios.post(url, payload, { timeout: 10000 });
			return !!(response.data && response.data.ok);
		} catch (error) {
			const errMsg = error.response?.data?.description || error.message;
			this.logger.error(`[editMessageCaption] Falha ao editar caption: ${errMsg}`);
			return false;
		}
	}

	/**
	 * Edita o texto ou caption de uma mensagem de forma transparente
	 * @param {string|number} chatId
	 * @param {number} messageId
	 * @param {Object} message - Objeto da mensagem recebida no callback
	 * @param {string} newText
	 * @param {Object} [options]
	 * @returns {Promise<boolean>}
	 */
	async editMessageTextOrCaption(chatId, messageId, message, newText, options = {}) {
		if (message && (message.caption !== undefined || message.photo)) {
			return this.editMessageCaption(chatId, messageId, newText, options);
		}
		return this.editMessageText(chatId, messageId, newText, options);
	}

	/**
	 * Envia notificação de novo convite recebido pelo site com botões inline interativos
	 * @param {Object} params
	 * @param {string} params.inviteCode
	 * @param {string} [params.cleanPhone]
	 * @param {string} params.formattedContact
	 * @param {string} params.cleanReason
	 * @param {string|number} [params.chatId]
	 * @param {Object|null} [params.inviteInfoData]
	 * @param {boolean} [params.isDonator]
	 * @param {number} [params.donateValue]
	 * @param {boolean} [params.wasInGroupBefore]
	 * @param {string} [params.membershipHistoryText]
	 * @param {number} [params.authorInvitesCount]
	 * @param {number} [params.groupInvitesCount]
	 * @param {string} [params.otherInvitersText]
	 * @param {Array<string>} [params.otherBotsInGroup]
	 * @param {string|null} [params.photoUrl]
	 * @returns {Promise<{success: boolean, messageId?: number, error?: string}>}
	 */
	async sendInviteNotification({
		inviteCode,
		cleanPhone,
		formattedContact,
		cleanReason,
		chatId,
		inviteInfoData = null,
		isDonator = false,
		donateValue = 0,
		wasInGroupBefore = false,
		membershipHistoryText = "",
		authorInvitesCount = 0,
		groupInvitesCount = 0,
		otherInvitersText = "",
		otherBotsInGroup = [],
		photoUrl = null
	}) {
		const targetChatId =
			chatId || this.inviteChatId || process.env.GRUPO_INVITES_TELEGRAM || this.chatId;

		const { escapeHtml } = require("../utils/TelegramMarkupHelper");

		let text = `🌐 <b>[Novo Convite Recebido pelo Site — Quero Uma!]</b>\n\n`;

		if (isDonator) {
			text += `💸💸 <b>Doador: R$${donateValue}</b> 💸💸\n`;
		}

		text += `🔗 <b>Link:</b> https://chat.whatsapp.com/${inviteCode}\n`;
		text += `👤 <b>Solicitante / Contato:</b> ${formattedContact}${isDonator ? " 💰" : ""}\n`;

		if (inviteInfoData?.Name) {
			text += `🏷️ <b>Nome:</b> ${escapeHtml(inviteInfoData.Name)}\n`;
		}
		if (inviteInfoData?.JID) {
			text += `🫆 <b>ID:</b> <code>${inviteInfoData.JID}</code>\n`;
		}
		if (inviteInfoData?.ParticipantCount) {
			text += `👥 <b>Membros:</b> ${inviteInfoData.ParticipantCount}\n`;
		}
		if (wasInGroupBefore) {
			text += `⚠️ <b>Já esteve neste grupo anteriormente!</b>\n`;
		}
		if (otherBotsInGroup && otherBotsInGroup.length > 0) {
			text += `⚠️ <b>Bot ${otherBotsInGroup.join(", ")} já está neste grupo!</b>\n`;
		}
		if (authorInvitesCount > 0) {
			text += `- 📈 <b>Convites deste usuário:</b> ${authorInvitesCount}\n`;
		}
		if (groupInvitesCount > 0) {
			text += `- 📊 <b>Vezes que este grupo foi indicado:</b> ${groupInvitesCount}\n`;
		}
		if (otherInvitersText) {
			text += `${otherInvitersText}`;
		}
		if (membershipHistoryText) {
			text += `${membershipHistoryText}`;
		}

		text += `\n💬 <b>Motivo:</b>\n<i>${escapeHtml(cleanReason)}</i>\n\n`;
		text += `💡 <i>Escolha uma ação abaixo:</i>`;

		const inline_keyboard = [];
		const availableWaBots = (this.bots || []).filter(
			(b) => !b.useTelegram && !b.useDiscord && !b.banido
		);

		const activeBots = availableWaBots.filter((b) => b.isConnected);
		const botsToDisplay = activeBots.length > 0 ? activeBots : availableWaBots;

		if (botsToDisplay.length > 0) {
			let currentRow = [];
			for (const b of botsToDisplay.slice(0, 6)) {
				const isVip = Boolean(b.vip || b.id === "ravenavip");
				const prefix = b.isConnected ? (isVip ? "💎" : "🟢") : "🔴";
				currentRow.push({
					text: `${prefix} ${b.nomeExibir || b.nome || b.id}`,
					callback_data: `join:${b.id || b.nome}:${inviteCode}`
				});
				if (currentRow.length === 2) {
					inline_keyboard.push(currentRow);
					currentRow = [];
				}
			}
			if (currentRow.length > 0) {
				inline_keyboard.push(currentRow);
			}
		} else {
			inline_keyboard.push(
				[
					{ text: "🟢 ravena13", callback_data: `join:ravena13:${inviteCode}` },
					{ text: "💎 ravenavip", callback_data: `join:ravenavip:${inviteCode}` }
				],
				[
					{ text: "🔴 NoxGley", callback_data: `join:noxgley:${inviteCode}` },
					{ text: "🔴 Arkanis", callback_data: `join:rav-arkanis:${inviteCode}` },
					{ text: "🔴 Kingo", callback_data: `join:rav-kingo:${inviteCode}` }
				]
			);
		}

		const moderationRow = [];
		if (cleanPhone) {
			moderationRow.push({
				text: "⛔ Bloquear Número",
				callback_data: `blk_num:${cleanPhone}`
			});
		}
		moderationRow.push({
			text: "🚫 Bloquear Grupo",
			callback_data: `blk_grp:${inviteCode}`
		});
		inline_keyboard.push(moderationRow);

		// Se há foto do grupo, tenta envio como foto com caption
		if (photoUrl) {
			try {
				const photoRes = await this.sendPhoto(targetChatId, photoUrl, text, {
					parse_mode: "HTML",
					reply_markup: { inline_keyboard }
				});
				if (photoRes && photoRes.success) {
					return photoRes;
				}
				this.logger.debug(
					`[sendInviteNotification] Envio de foto falhou (${photoRes?.error}), recorrendo a texto simples.`
				);
			} catch (photoErr) {
				this.logger.debug(
					`[sendInviteNotification] Erro ao enviar foto: ${photoErr.message}, recorrendo a texto.`
				);
			}
		}

		return this.sendNotification(targetChatId, text, {
			parse_mode: "HTML",
			reply_markup: { inline_keyboard }
		});
	}

	/**
	 * Localiza a instância de bot correspondente a um ID ou nome
	 * @param {string} botId
	 * @returns {Object|null}
	 */
	findBotInstance(botId) {
		if (!botId || !Array.isArray(this.bots)) return null;
		const search = botId.toLowerCase().trim();

		return (
			this.bots.find((b) => {
				const id = (b.id || "").toLowerCase().trim();
				const name = (b.nome || "").toLowerCase().trim();
				if (id === search || name === search) return true;
				// Tratamento de aliases comuns
				if (
					(search === "rav-arkanis" || search === "arkanis") &&
					(id === "rav-arkanis" || id === "arkanis" || name === "rav-arkanis" || name === "arkanis")
				) {
					return true;
				}
				if (
					(search === "rav-kingo" || search === "kingo") &&
					(id === "rav-kingo" || id === "kingo" || name === "rav-kingo" || name === "kingo")
				) {
					return true;
				}
				return false;
			}) || null
		);
	}

	/**
	 * Processa um clique de botão inline (callback_query) recebido do Telegram
	 * @param {Object} query
	 * @returns {Promise<boolean>}
	 */
	async handleCallbackQuery(query) {
		if (!query || !query.data) return false;

		const { id: queryId, data, message, from } = query;
		const modUser = from?.username ? `@${from.username}` : from?.first_name || "Admin";
		const timeStr = new Intl.DateTimeFormat("pt-BR", {
			timeZone: "America/Sao_Paulo",
			dateStyle: "short",
			timeStyle: "medium"
		}).format(new Date());

		// 1. Ação de entrada em grupo: join:<botId>:<inviteCode>
		if (data.startsWith("join:")) {
			const [, botId, inviteCode] = data.split(":");
			const targetBot = this.findBotInstance(botId);

			if (!targetBot) {
				await this.answerCallbackQuery(queryId, {
					text: `❌ Instância '${botId}' não encontrada no sistema!`,
					show_alert: true
				});
				return false;
			}

			if (!targetBot.isConnected) {
				await this.answerCallbackQuery(queryId, {
					text: `❌ O bot ${targetBot.nomeExibir || botId} está offline no momento!`,
					show_alert: true
				});
				return false;
			}

			await this.answerCallbackQuery(queryId, {
				text: `⏳ Entrando no grupo com ${targetBot.nomeExibir || botId}...`
			});

			try {
				let inviteInfoData = null;
				if (targetBot.client && typeof targetBot.client.getInviteInfo === "function") {
					try {
						inviteInfoData = await targetBot.client.getInviteInfo(inviteCode);
					} catch (e) {
						this.logger.debug(`[join] Não foi possível obter metadados prévios: ${e.message}`);
					}
				}

				const joinResult = await targetBot.client.acceptInvite(inviteCode);

				if (joinResult && (joinResult.accepted || !joinResult.error)) {
					try {
						const InviteSystem = require("../InviteSystem");
						InviteSystem.removeFromQueue(inviteCode);
					} catch (e) {}

					const finalGroupJid = inviteInfoData?.JID || null;

					if (this.database) {
						await this.database
							.addInviteHistory({
								code: inviteCode,
								groupJid: finalGroupJid,
								authorId: "site",
								authorName: "Site Telegram",
								timestamp: Date.now(),
								reason: `Telegram inline join por ${targetBot.nomeExibir || targetBot.id}`
							})
							.catch((err) => this.logger.error("Erro salvando addInviteHistory:", err));

						await this.database
							.savePendingJoin(inviteCode, {
								authorId: "site",
								authorName: "Site Telegram",
								groupJid: finalGroupJid
							})
							.catch((err) => this.logger.error("Erro salvando savePendingJoin:", err));
					}

					if (message) {
						const baseText = message.caption || message.text || "";
						const updatedText =
							`${baseText}\n\n` +
							`✅ <b>Convite aceito com sucesso por ${targetBot.nomeExibir || targetBot.id}!</b>\n` +
							`👤 <b>Mod:</b> ${modUser} em ${timeStr}`;

						await this.editMessageTextOrCaption(
							message.chat.id,
							message.message_id,
							message,
							updatedText,
							{
								reply_markup: { inline_keyboard: [] }
							}
						);
					}

					return true;
				} else {
					const errMsg = joinResult?.error || "Falha ao aceitar o convite";
					await this.answerCallbackQuery(queryId, {
						text: `❌ Erro ao entrar: ${errMsg}`,
						show_alert: true
					});
					return false;
				}
			} catch (error) {
				this.logger.error(`[join] Erro ao aceitar convite:`, error);
				await this.answerCallbackQuery(queryId, {
					text: `❌ Erro inesperado: ${error.message}`,
					show_alert: true
				});
				return false;
			}
		}

		// 2. Ação de bloqueio de número: blk_num:<cleanPhone>
		if (data.startsWith("blk_num:")) {
			const cleanPhone = data.split(":")[1];

			if (!cleanPhone) {
				await this.answerCallbackQuery(queryId, {
					text: "❌ Número inválido para bloqueio.",
					show_alert: true
				});
				return false;
			}

			try {
				if (this.database && typeof this.database.toggleUserInvites === "function") {
					await this.database.toggleUserInvites(cleanPhone, true);
				}

				await this.answerCallbackQuery(queryId, {
					text: `⛔ Número ${cleanPhone} bloqueado para convites!`
				});

				if (message) {
					const baseText = message.caption || message.text || "";
					const updatedText =
						`${baseText}\n\n` +
						`⛔ <b>Número ${cleanPhone} bloqueado para convites!</b>\n` +
						`👤 <b>Mod:</b> ${modUser} em ${timeStr}`;

					await this.editMessageTextOrCaption(
						message.chat.id,
						message.message_id,
						message,
						updatedText,
						{
							reply_markup: { inline_keyboard: [] }
						}
					);
				}

				return true;
			} catch (error) {
				this.logger.error(`[blk_num] Erro bloqueando número:`, error);
				await this.answerCallbackQuery(queryId, {
					text: `❌ Erro ao bloquear número: ${error.message}`,
					show_alert: true
				});
				return false;
			}
		}

		// 3. Ação de bloqueio de grupo: blk_grp:<inviteCode>
		if (data.startsWith("blk_grp:")) {
			const inviteCode = data.split(":")[1];

			if (!inviteCode) {
				await this.answerCallbackQuery(queryId, {
					text: "❌ Código de convite inválido.",
					show_alert: true
				});
				return false;
			}

			try {
				let groupJid = null;
				const onlineWaBot =
					(this.bots || []).find(
						(b) =>
							!b.useTelegram &&
							!b.useDiscord &&
							b.isConnected &&
							b.client &&
							typeof b.client.getInviteInfo === "function"
					) || (this.bots || []).find((b) => !b.useTelegram && !b.useDiscord && b.isConnected);

				if (
					onlineWaBot &&
					onlineWaBot.client &&
					typeof onlineWaBot.client.getInviteInfo === "function"
				) {
					try {
						const info = await onlineWaBot.client.getInviteInfo(inviteCode);
						groupJid = info?.JID || null;
					} catch (e) {
						this.logger.debug(`[blk_grp] Não foi possível consultar JID do convite: ${e.message}`);
					}
				}

				if (this.database && typeof this.database.saveBlockedInvite === "function") {
					await this.database.saveBlockedInvite(inviteCode, groupJid);
				}

				await this.answerCallbackQuery(queryId, {
					text: `🚫 Grupo (código: ${inviteCode}) bloqueado com sucesso!`
				});

				if (message) {
					const baseText = message.caption || message.text || "";
					const jidInfo = groupJid ? ` (JID: ${groupJid})` : "";
					const updatedText =
						`${baseText}\n\n` +
						`🚫 <b>Grupo bloqueado para convites${jidInfo}!</b>\n` +
						`👤 <b>Mod:</b> ${modUser} em ${timeStr}`;

					await this.editMessageTextOrCaption(
						message.chat.id,
						message.message_id,
						message,
						updatedText,
						{
							reply_markup: { inline_keyboard: [] }
						}
					);
				}

				return true;
			} catch (error) {
				this.logger.error(`[blk_grp] Erro bloqueando grupo:`, error);
				await this.answerCallbackQuery(queryId, {
					text: `❌ Erro ao bloquear grupo: ${error.message}`,
					show_alert: true
				});
				return false;
			}
		}

		return false;
	}

	/**
	 * Inicia o loop de long polling para escutar cliques de botões inline
	 */
	startPolling() {
		if (process.env.DISABLE_ACTIVITY === "true") {
			this.logger.info("[startPolling] DISABLE_ACTIVITY ativo. Polling cancelado.");
			return;
		}

		const token = this.getToken();
		if (!token) {
			this.logger.warn(
				"[startPolling] NOTIFICATIONS_TELEGRAM_BOT_TOKEN / HEALTH_CHECK_TELEGRAM_BOT_TOKEN não configurado. Polling inativo."
			);
			return;
		}

		if (this.isPolling) return;
		this.isPolling = true;
		this.pollBackoff = new TelegramPollingBackoff({
			loop: "notifications",
			logger: this.logger,
			token,
			tokenSource: "NOTIFICATIONS_TELEGRAM_BOT_TOKEN / HEALTH_CHECK_TELEGRAM_BOT_TOKEN no .env"
		});
		this.logger.info("[startPolling] Iniciando long-polling para moderação via Telegram...");

		// Remove qualquer webhook residual para liberar o long-polling
		this.deleteWebhook()
			.catch(() => {})
			.finally(() => {
				if (this.isPolling) {
					this._poll();
				}
			});
	}

	/**
	 * Para o loop de long polling
	 */
	stopPolling() {
		this.isPolling = false;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		this.logger.info("[stopPolling] Polling de moderação via Telegram encerrado.");
	}

	/**
	 * Loop interno de busca de atualizações (long-polling)
	 * @private
	 */
	async _poll() {
		if (!this.isPolling) return;
		if (this.isFetchingUpdates) return;

		const token = this.getToken();
		if (!token) {
			this.isPolling = false;
			return;
		}

		this.isFetchingUpdates = true;
		let nextPollMs = 1500;
		try {
			const url = `https://api.telegram.org/bot${token}/getUpdates`;
			const response = await axios.post(
				url,
				{
					offset: this.updateOffset,
					timeout: 20,
					allowed_updates: ["callback_query"]
				},
				{ timeout: 30000 }
			);
			this.pollBackoff.succeed();

			if (response.data && response.data.ok && Array.isArray(response.data.result)) {
				for (const update of response.data.result) {
					this.updateOffset = update.update_id + 1;
					if (update.callback_query) {
						await this.handleCallbackQuery(update.callback_query).catch((err) => {
							this.logger.error("[_poll] Erro ao tratar callback_query:", err);
						});
					}
				}
			}
		} catch (error) {
			nextPollMs = this.pollBackoff.fail(error);
			if (String(error.response?.data?.description).includes("webhook is active")) {
				await this.deleteWebhook();
			}
		} finally {
			this.isFetchingUpdates = false;
		}

		if (nextPollMs === null) {
			this.isPolling = false;
		}
		if (this.isPolling) {
			this.pollTimer = setTimeout(() => this._poll(), nextPollMs);
		}
	}
}

module.exports = TelegramNotificationService;
