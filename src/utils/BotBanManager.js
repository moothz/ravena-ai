const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const Logger = require("./Logger");
const PhoneUtils = require("./PhoneUtils");

class BotBanManager {
	static logger = new Logger("bot-ban-manager");
	static _writeQueue = Promise.resolve();

	/**
	 * Retorna o caminho absoluto para o bots.json
	 * Suporta sobrescrita via variável de ambiente BOTS_JSON_PATH para testes.
	 */
	static getBotsJsonPath() {
		return process.env.BOTS_JSON_PATH || path.resolve(__dirname, "../../bots.json");
	}

	/**
	 * Desmarca uma instância como banida em memória e persiste a alteração no bots.json.
	 *
	 * @param {Object|string} botOrId - Instância do bot ou identificador (nome/ID)
	 * @param {Object} [options]
	 * @param {string} [options.reason] - Motivo do desbanimento (padrão: "recebeu evento de mensagem")
	 * @returns {Promise<boolean>} Retorna true se o bot estava banido e foi desmarcado no bots.json
	 */
	static async unmarkBotBanned(botOrId, options = {}) {
		const reason = options.reason || "recebeu evento de mensagem";

		// Identificar propriedades do bot
		let botId = null;
		let botName = null;
		let botPhone = null;

		if (typeof botOrId === "string") {
			botId = botOrId;
		} else if (botOrId && typeof botOrId === "object") {
			botId = botOrId.id || null;
			botName = botOrId.instanceName || botOrId.nome || null;
			botPhone = botOrId.phoneNumber || botOrId.numero || null;

			// Atualiza em memória imediatamente no objeto fornecido
			if (botOrId.banido) {
				botOrId.banido = false;
			}
		}

		if (!botId && !botName && !botPhone) {
			this.logger.warn(
				"[unmarkBotBanned] Nenhum identificador válido fornecido para desmarcar banido."
			);
			return false;
		}

		// Sincroniza em memória com todas as instâncias registradas no Database
		try {
			const Database = require("./Database");
			const allBots = Database.getInstance().botInstances || [];
			for (const b of allBots) {
				if (!b) continue;
				const matches =
					(botId && b.id === botId) ||
					(botName && (b.id === botName || b.instanceName === botName)) ||
					(botPhone &&
						b.phoneNumber &&
						PhoneUtils.cleanPhone(b.phoneNumber) === PhoneUtils.cleanPhone(botPhone));

				if (matches && b.banido) {
					b.banido = false;
				}
			}
		} catch (dbErr) {
			this.logger.debug(
				"[unmarkBotBanned] Não foi possível consultar botInstances do Database:",
				dbErr.message
			);
		}

		// Sincroniza em memória com instâncias ativas do BotAPI, se houver
		try {
			const BotAPI = require("../BotAPI");
			const apiInstance = BotAPI.getInstance?.();
			if (apiInstance && Array.isArray(apiInstance.bots)) {
				for (const b of apiInstance.bots) {
					if (!b) continue;
					const matches =
						(botId && b.id === botId) ||
						(botName && (b.id === botName || b.instanceName === botName)) ||
						(botPhone &&
							b.phoneNumber &&
							PhoneUtils.cleanPhone(b.phoneNumber) === PhoneUtils.cleanPhone(botPhone));

					if (matches && b.banido) {
						b.banido = false;
					}
				}
				apiInstance.invalidateCemiterioCache?.();
			}
		} catch {
			// BotAPI pode não estar instanciado
		}

		// Enfileira a escrita no bots.json de forma sequencial para evitar condições de corrida
		return new Promise((resolve) => {
			this._writeQueue = this._writeQueue
				.then(async () => {
					const result = await this._persistUnban(botId, botName, botPhone, reason);
					resolve(result);
				})
				.catch((err) => {
					this.logger.error(
						`[unmarkBotBanned] Erro ao persistir desbanimento de '${botId || botName}':`,
						err
					);
					resolve(false);
				});
		});
	}

	/**
	 * Persiste no bots.json a alteração banido = false
	 * @private
	 */
	static async _persistUnban(botId, botName, botPhone, reason) {
		const botsJsonPath = this.getBotsJsonPath();

		if (!fsSync.existsSync(botsJsonPath)) {
			this.logger.warn(
				`[unmarkBotBanned] Arquivo bots.json não encontrado em ${botsJsonPath}. Alteração persistida apenas em memória.`
			);
			return false;
		}

		try {
			const raw = await fs.readFile(botsJsonPath, "utf8");
			const bots = JSON.parse(raw);

			if (!Array.isArray(bots)) {
				this.logger.warn("[unmarkBotBanned] Conteúdo de bots.json não é um array válido.");
				return false;
			}

			let modified = false;
			let targetBotName = null;

			for (const b of bots) {
				if (!b) continue;

				const matchesId =
					botId &&
					(b.nome === botId || String(b.nome).toLowerCase() === String(botId).toLowerCase());
				const matchesName =
					botName &&
					(b.nome === botName || String(b.nome).toLowerCase() === String(botName).toLowerCase());
				const matchesPhone =
					botPhone &&
					b.numero &&
					PhoneUtils.cleanPhone(b.numero) === PhoneUtils.cleanPhone(botPhone);

				if (matchesId || matchesName || matchesPhone) {
					targetBotName = b.nome || botId;
					if (b.banido !== false) {
						b.banido = false;
						modified = true;
					}
					break;
				}
			}

			if (modified) {
				await fs.writeFile(botsJsonPath, JSON.stringify(bots, null, 2), "utf8");
				this.logger.info(
					`[auto-unban] Instância '${targetBotName}' desmarcada como banida no bots.json (${reason}).`
				);
				return true;
			}

			return false;
		} catch (error) {
			this.logger.error(
				`[unmarkBotBanned] Falha ao ler/escrever em bots.json (${botsJsonPath}):`,
				error
			);
			return false;
		}
	}
}

module.exports = BotBanManager;
