const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomBytes } = require("crypto");

class TelegramClient {
	/**
	 * @param {string} token - The Telegram Bot token.
	 * @param {object} logger - A logger instance.
	 */
	constructor(token, logger) {
		if (!token) {
			throw new Error("TelegramClient: Bot token is required.");
		}
		this.token = token;
		this.logger = logger || console;
		this.bot = new TelegramBot(token);
		this.logger.info("TelegramClient initialized.");
	}

	/**
	 * Sets the webhook for the bot.
	 * @param {string} webhookUrl - The URL to receive updates.
	 * @param {string} secretToken - A secret token to verify requests.
	 */
	async setWebhook(webhookUrl, secretToken) {
		try {
			this.logger.info(`Setting Webhook to '${webhookUrl}'`);
			await this.bot.setWebHook(webhookUrl, {
				secret_token: secretToken
			});
		} catch (error) {
			this.logger.error(`Failed to set webhook: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Deletes the webhook.
	 * @returns {Promise<boolean>}
	 */
	async deleteWebhook() {
		try {
			this.logger.info("Deleting webhook");
			const result = await this.bot.deleteWebHook();
			this.logger.info(`Webhook deleted successfully: ${result}`);
			return result;
		} catch (error) {
			this.logger.error(`Failed to delete webhook: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Gets updates from the bot.
	 * @param {number} offset - Identifier of the first update to be returned.
	 * @param {number} limit - Limits the number of updates to be retrieved.
	 * @param {number} timeout - Timeout in seconds for long polling.
	 * @returns {Promise<Array<object>>}
	 */
	async getUpdates(offset, limit, timeout) {
		// The getUpdates method in the library doesn't throw on HTTP errors,
		// but it might on network errors. We'll wrap it just in case.
		try {
			return await this.bot.getUpdates({ offset, limit, timeout });
		} catch (error) {
			this.logger.error(`Failed to get updates: ${error.message}`);
			// Re-throw to be handled by the polling loop in TelegramBot.js
			throw error;
		}
	}

	/**
	 * Processes incoming webhook updates.
	 * @param {object} update - The update object from Telegram.
	 */
	processUpdate(update) {
		this.bot.processUpdate(update);
	}

	/**
	 * Registers bot commands with Telegram.
	 * @param {Array<object>} commands - An array of command objects { command, description }.
	 */
	async setMyCommands(commands) {
		try {
			await this.bot.setMyCommands(commands);
			this.logger.info("Successfully registered bot commands.");
		} catch (error) {
			this.logger.error(`Failed to register commands: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Downloads a file from Telegram.
	 * @param {string} fileId - The file_id of the file to download.
	 * @returns {Promise<string>} - A promise that resolves with the base64 encoded file content.
	 */
	async downloadFile(fileId) {
		try {
			const fileLink = await this.bot.getFileLink(fileId);
			const response = await axios.get(fileLink, { responseType: "arraybuffer" });
			return Buffer.from(response.data, "binary").toString("base64");
		} catch (error) {
			this.logger.error(`Failed to download file ${fileId}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Sends a text message.
	 * @param {string|number} chatId - The chat ID.
	 * @param {string} text - The text to send.
	 * @param {object} options - Telegram API options.
	 */
	async sendMessage(chatId, text, options) {
		return this.bot.sendMessage(chatId, text, options);
	}

	/**
	 * Sends a photo.
	 * @param {string|number} chatId - The chat ID.
	 * @param {string|Buffer} photo - URL or Buffer of the photo.
	 * @param {object} options - Telegram API options.
	 */
	async sendPhoto(chatId, photo, options) {
		return this.bot.sendPhoto(chatId, photo, options);
	}

	/**
	 * Sends a video.
	 * @param {string|number} chatId - The chat ID.
	 * @param {string|Buffer} video - URL or Buffer of the video.
	 * @param {object} options - Telegram API options.
	 */
	async sendVideo(chatId, video, options) {
		return this.bot.sendVideo(chatId, video, options);
	}

	/**
	 * Sends a sticker.
	 * @param {string|number} chatId - The chat ID.
	 * @param {string|Buffer} sticker - URL or Buffer of the sticker.
	 * @param {object} options - Telegram API options.
	 */
	async sendSticker(chatId, sticker, options) {
		return this.bot.sendSticker(chatId, sticker, options);
	}

	/**
	 * Sends an audio file.
	 * @param {string|number} chatId - The chat ID.
	 * @param {string|Buffer} audio - URL or Buffer of the audio.
	 * @param {object} options - Telegram API options.
	 */
	async sendAudio(chatId, audio, options) {
		return this.bot.sendAudio(chatId, audio, options);
	}

	/**
	 * Sends a document.
	 * @param {string|number} chatId - The chat ID.
	 * @param {string|Buffer} document - URL or Buffer of the document.
	 * @param {object} options - Telegram API options.
	 */
	async sendDocument(chatId, document, options) {
		return this.bot.sendDocument(chatId, document, options);
	}

	/**
	 * Deletes a message.
	 * @param {string|number} chatId - The chat ID.
	 * @param {number} messageId - The message ID.
	 */
	async deleteMessage(chatId, messageId) {
		return this.bot.deleteMessage(chatId, messageId);
	}

	/**
	 * Gets information about the bot.
	 */
	async getMe() {
		return this.bot.getMe();
	}

	/**
	 * Gets information about a chat.
	 * @param {string|number} chatId - The chat ID.
	 */
	async getChat(chatId) {
		return this.bot.getChat(chatId);
	}

	/**
	 * Gets a list of administrators in a chat.
	 * @param {string|number} chatId - The chat ID.
	 */
	async getChatAdministrators(chatId) {
		return this.bot.getChatAdministrators(chatId);
	}

	/**
	 * Gets information about a member of a chat.
	 * @param {string|number} chatId - The chat ID.
	 * @param {string|number} userId - The user ID.
	 */
	async getChatMember(chatId, userId) {
		return this.bot.getChatMember(chatId, userId);
	}

	/**
	 * Updates the group title.
	 * @param {string|number} chatId - The chat ID.
	 * @param {string} title - The new group title.
	 */
	async setChatTitle(chatId, title) {
		return this.bot.setChatTitle(chatId, title);
	}

	/**
	 * Makes the bot leave a chat.
	 * @param {string|number} chatId - The chat ID.
	 */
	async leaveChat(chatId) {
		return this.bot.leaveChat(chatId);
	}

	/**
	 * Updates the bot's profile picture for a chat.
	 * @param {string|number} chatId - The chat ID.
	 * @param {Buffer} photo - Buffer of the photo.
	 */
	async setChatPhoto(chatId, photo) {
		return this.bot.setChatPhoto(chatId, photo);
	}

	/**
	 * Edits text of a sent message.
	 * @param {string|number} chatId - The chat ID.
	 * @param {number} messageId - The message ID to edit.
	 * @param {string} text - New text content.
	 * @param {object} options - Telegram API options.
	 */
	async editMessageText(chatId, messageId, text, options = {}) {
		return this.bot.editMessageText(text, {
			chat_id: chatId,
			message_id: messageId,
			parse_mode: options.parse_mode !== undefined ? options.parse_mode : "HTML",
			...options
		});
	}

	/**
	 * Edits caption of a sent media message.
	 * @param {string|number} chatId - The chat ID.
	 * @param {number} messageId - The message ID to edit.
	 * @param {string} caption - New caption content.
	 * @param {object} options - Telegram API options.
	 */
	async editMessageCaption(chatId, messageId, caption, options = {}) {
		return this.bot.editMessageCaption(caption, {
			chat_id: chatId,
			message_id: messageId,
			parse_mode: options.parse_mode !== undefined ? options.parse_mode : "HTML",
			...options
		});
	}

	/**
	 * Edits reply markup of a sent message.
	 * @param {string|number} chatId - The chat ID.
	 * @param {number} messageId - The message ID to edit.
	 * @param {object} replyMarkup - New reply markup object.
	 * @param {object} options - Telegram API options.
	 */
	async editMessageReplyMarkup(chatId, messageId, replyMarkup, options = {}) {
		return this.bot.editMessageReplyMarkup(replyMarkup, {
			chat_id: chatId,
			message_id: messageId,
			...options
		});
	}

	/**
	 * Edits media (photo) of a sent message.
	 * @param {string|number} chatId - The chat ID.
	 * @param {number} messageId - The message ID to edit.
	 * @param {Buffer} mediaBuffer - Buffer containing the new photo data.
	 * @param {object} options - Telegram API options (caption, parse_mode, reply_markup).
	 */
	async editMessageMedia(chatId, messageId, mediaBuffer, options = {}) {
		const tempId = randomBytes(6).toString("hex");
		const tempFile = path.join(os.tmpdir(), `tg_edit_${Date.now()}_${process.pid}_${tempId}.jpg`);
		await fs.promises.writeFile(tempFile, mediaBuffer);
		try {
			const form = {
				chat_id: chatId,
				message_id: messageId
			};
			if (options.reply_markup) {
				form.reply_markup =
					typeof options.reply_markup === "string"
						? options.reply_markup
						: JSON.stringify(options.reply_markup);
			}

			// Telegram Bot API limits caption to 1024 characters for media
			let caption = options.caption || "";
			if (caption.length > 1024) {
				caption = caption.substring(0, 1020) + "...";
			}

			return await this.bot.editMessageMedia(
				{
					type: "photo",
					media: "attach://" + tempFile,
					caption,
					parse_mode: options.parse_mode || "HTML"
				},
				form
			);
		} finally {
			fs.promises.unlink(tempFile).catch(() => {});
		}
	}

	/**
	 * Acknowledges a callback query.
	 * @param {string} callbackQueryId - The callback query ID.
	 * @param {object} options - Callback response options (text, show_alert, url, cache_time).
	 */
	async answerCallbackQuery(callbackQueryId, options = {}) {
		return this.bot.answerCallbackQuery(callbackQueryId, options);
	}

	/**
	 * Gets the profile photo link for a user.
	 * @param {string|number} userId - Telegram user ID
	 * @returns {Promise<string|null>} - Direct URL to the largest profile picture, or null
	 */
	async getUserProfilePhotoUrl(userId) {
		try {
			const cleanId = String(userId)
				.split("@")[0]
				.replace(/[^\d-]/g, "");
			if (!cleanId || isNaN(cleanId)) return null;
			const photos = await this.bot.getUserProfilePhotos(parseInt(cleanId, 10), { limit: 1 });
			if (
				!photos ||
				!Array.isArray(photos.photos) ||
				photos.photos.length === 0 ||
				!Array.isArray(photos.photos[0]) ||
				photos.photos[0].length === 0
			) {
				return null;
			}
			const bestPhoto = photos.photos[0][photos.photos[0].length - 1];
			if (!bestPhoto || !bestPhoto.file_id) return null;
			const link = await this.bot.getFileLink(bestPhoto.file_id);
			return link || null;
		} catch (error) {
			this.logger.debug(
				`[getUserProfilePhotoUrl] Erro ao buscar foto do usuário ${userId}: ${error.message}`
			);
			return null;
		}
	}
}

module.exports = TelegramClient;
