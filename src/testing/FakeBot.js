/**
 * FakeBot.js
 *
 * Stub de bot para uso nos testes. Implementa a interface mínima que o pipeline
 * (EventHandler → CommandHandler → functions) espera de um bot real.
 *
 * Não inicializa conexões WebSocket/Telegram/Discord. Intercepta sendReturnMessages
 * e acumula as mensagens que seriam enviadas em this.capturedMessages[].
 */

const Database = require("../utils/Database");
const Logger = require("../utils/Logger");

class FakeBot {
	constructor(options = {}) {
		this.id = options.id ?? "bot-teste";
		this.prefix = options.prefix ?? "!";

		// Flags lidas pelo EventHandler / CommandHandler
		this.ignorePV = false;
		this.pvAI = false;
		this.ignoreInvites = true;
		this.whitelistPV = [];
		this.banido = false;
		this.vip = false;
		this.comunitario = false;
		this.privado = false;
		this.userAgent = "FakeBot/1.0";

		// IDs de grupos de notificação — null = desabilitado
		this.grupoLogs = null;
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
		}
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

	// ---------------------------------------------------------------------------
	// Helpers lidos pelo EventHandler / AdminUtils
	// ---------------------------------------------------------------------------

	/** Retorna false — nenhum autor está na whitelist durante testes */
	notInWhitelist(author) {
		return false;
	}

	/** Stubs para resolução LID↔PN usada nos filtros de grupo */
	getLidFromPn(pn) { return null; }
	getPnFromLid(lid) { return null; }

	/** Compatibilidade com destruição no SIGINT */
	async destroy() {}

	/**
	 * Reseta mensagens capturadas (útil para rodar múltiplos testes com o mesmo bot)
	 */
	resetCapture() {
		this.capturedMessages = [];
	}
}

module.exports = FakeBot;
