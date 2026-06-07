/**
 * FakeMessage.js
 *
 * Constrói objetos `message` compatíveis com o formato que WhatsAppBotGo/TelegramBot
 * produz e que EventHandler.processMessage() espera receber.
 *
 * Campos mapeados a partir da análise do pipeline em:
 *   EventHandler.processMessage()
 *   CommandHandler.handleCommand() / processCommand()
 *   src/functions/* (uso de message.author, message.content, message.type, etc.)
 */

const fs = require("fs");
const path = require("path");

/**
 * Cria um objeto message base com todos os campos que o pipeline usa.
 *
 * @param {Object} overrides - Campos para sobrescrever nos defaults
 * @returns {Object} Objeto message compatível com o pipeline
 */
function createMessage(overrides = {}) {
	const author = overrides.author ?? "5511999999999@s.whatsapp.net";
	const authorName = overrides.authorName ?? overrides.name ?? "Testador";
	const group = overrides.group ?? null; // null = mensagem privada

	// Conteúdo: texto ou mídia
	const type = overrides.type ?? "text";
	const content = overrides.content ?? "";
	const caption = overrides.caption ?? (type !== "text" ? (overrides.caption ?? "") : undefined);

	const msgId = `fake-msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

	// Monta objeto origin com stubs dos métodos chamados no pipeline
	const origin = {
		id: { id: msgId, _serialized: msgId },
		body: type === "text" ? content : (caption ?? ""),
		type,
		from: group ?? author,
		author,
		pushname: authorName,
		pushName: authorName,
		authorName,
		name: authorName,

		// Métodos chamados no pipeline — stubs seguros
		react: async (emoji) => {
			// no-op — reações não são enviadas em testes
		},
		delete: async (forEveryone) => {
			// no-op
		},
		getChat: async () => ({
			isGroup: !!group,
			id: { _serialized: group ?? author },
			participants: [],
			name: group ? "Grupo de Teste" : null
		}),

		// Compatibilidade com mensagens quoted
		hasQuotedMsg: overrides.hasQuotedMsg ?? false,
		_data: {
			quotedMsg: overrides.quotedMsg ?? null,
			quotedStanzaID: overrides.quotedStanzaID ?? null
		},

		// downloadMedia stub — retorna o content se for mídia
		downloadMedia: async () => {
			if (type !== "text" && content && content.data) {
				return content;
			}
			return null;
		},

		// getQuotedMessage stub
		getQuotedMessage: async () => {
			throw new Error("getQuotedMessage is not available on this message");
		}
	};

	const message = {
		// Identidade
		authorName,
		authorAlt: overrides.authorAlt ?? null,
		name: authorName,
		pushname: authorName,
		pushName: authorName,

		// Roteamento
		guildId: overrides.guildId ?? group,

		// Conteúdo
		content: type === "text" ? content : (overrides.content ?? null),
		caption: type !== "text" ? (caption ?? "") : undefined,

		// Flags
		fromMe: false,
		isNewsletter: false,
		hasQuotedMsg: overrides.hasQuotedMsg ?? false,
		quotedMsg: overrides.quotedMsg ?? null,

		// Chat do grupo (usado em processManagementCommand via message.groupChat)
		groupChat: group
			? {
					isGroup: true,
					id: { _serialized: group },
					participants: []
				}
			: null,

		// Permite que os testes adicionem campos extras
		...overrides
	};

	// Garante que author/group/type/content/origin não sejam sobrescritos acidentalmente
	// (os overrides já foram aplicados acima nos valores base)
	message.author = author;
	message.group = group;
	message.type = type;
	message.origin = origin;
	message.from = group ?? author;

	return message;
}

/**
 * Carrega um arquivo de mídia do disco e retorna objeto MessageMedia compatível.
 *
 * @param {string} filePath - Caminho absoluto ou relativo ao arquivo
 * @returns {{ data: string, mimetype: string, filename: string }}
 */
function loadMediaFile(filePath) {
	const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

	if (!fs.existsSync(absPath)) {
		throw new Error(`[FakeMessage] Arquivo de mídia não encontrado: ${absPath}`);
	}

	const data = fs.readFileSync(absPath).toString("base64");
	const ext = path.extname(absPath).toLowerCase().slice(1);

	const mimetypeMap = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		mp3: "audio/mpeg",
		ogg: "audio/ogg",
		mp4: "video/mp4",
		webm: "video/webm",
		pdf: "application/pdf"
	};

	const mimetype = mimetypeMap[ext] ?? "application/octet-stream";

	return {
		data,
		mimetype,
		filename: path.basename(absPath)
	};
}

module.exports = { createMessage, loadMediaFile };
