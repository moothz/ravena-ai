/**
 * helpers.js
 *
 * Funções de conveniência para criar mensagens de teste em run-testes.js.
 *
 * Uso:
 *   const { msgTexto, msgMedia, msgComQuote, msgCustom } = require("./src/testing/helpers");
 *
 *   msgTexto("!yt receita pudim")
 *   msgMedia("!s", "./data/test-image.png", { type: "image" })
 *   msgComQuote("!resumo", msgTexto("texto a resumir"))
 *   msgCustom({ content: "!ping", group: "120363...@g.us" })
 */

const { createMessage, loadMediaFile } = require("./FakeMessage");

// Configurações padrão — sobrescritas por TestRunner antes dos testes
let _defaultGroupId = null;
let _defaultAuthor = "5511999999999@s.whatsapp.net";
let _defaultAuthorName = "Testador";

/**
 * Define os defaults usados pelos helpers.
 * Chamado pelo TestRunner antes de executar os testes.
 * @param {{ groupId, author, authorName }} opts
 */
function setDefaults(opts = {}) {
	if (opts.groupId !== undefined) _defaultGroupId = opts.groupId;
	if (opts.author !== undefined) _defaultAuthor = opts.author;
	if (opts.authorName !== undefined) _defaultAuthorName = opts.authorName;
}

// ---------------------------------------------------------------------------
// Helpers públicos
// ---------------------------------------------------------------------------

/**
 * Cria mensagem de texto simples.
 *
 * @param {string} texto - Texto completo da mensagem (incluindo prefixo e comando)
 * @param {Object} [opts]
 * @param {string} [opts.author]     - Número do autor (ex: "5511999@s.whatsapp.net")
 * @param {string} [opts.authorName] - Nome de exibição do autor
 * @param {string} [opts.group]      - ID do grupo (null = mensagem privada)
 * @returns {Object} Objeto message compatível com o pipeline
 */
function msgTexto(texto, opts = {}) {
	return createMessage({
		type: "text",
		content: texto,
		author: opts.author ?? _defaultAuthor,
		authorName: opts.authorName ?? _defaultAuthorName,
		group: opts.group !== undefined ? opts.group : _defaultGroupId
	});
}

/**
 * Cria mensagem com mídia (imagem, áudio, vídeo, documento).
 * Carrega o arquivo do disco e converte para base64.
 *
 * @param {string} legenda  - Texto na legenda da mídia (ex: "!s")
 * @param {string} filePath - Caminho para o arquivo (relativo ao cwd ou absoluto)
 * @param {Object} [opts]
 * @param {string} [opts.type]       - Tipo da mensagem: "image"|"audio"|"video"|"document"|"sticker"
 *                                     Se não informado, detecta pela extensão do arquivo
 * @param {string} [opts.author]
 * @param {string} [opts.authorName]
 * @param {string} [opts.group]
 * @returns {Object} Objeto message compatível com o pipeline
 */
function msgMedia(legenda, filePath, opts = {}) {
	const media = loadMediaFile(filePath);

	// Detecta tipo pelo mimetype se não especificado
	let type = opts.type;
	if (!type) {
		if (media.mimetype.startsWith("image/")) type = "image";
		else if (media.mimetype.startsWith("audio/")) type = "audio";
		else if (media.mimetype.startsWith("video/")) type = "video";
		else type = "document";
	}

	return createMessage({
		type,
		content: media, // objeto { data, mimetype, filename }
		caption: legenda,
		author: opts.author ?? _defaultAuthor,
		authorName: opts.authorName ?? _defaultAuthorName,
		group: opts.group !== undefined ? opts.group : _defaultGroupId
	});
}

/**
 * Cria mensagem que cita (responde) outra mensagem.
 *
 * @param {string} texto     - Texto da mensagem de resposta
 * @param {Object} quotedMsg - Objeto message retornado por msgTexto/msgMedia/msgCustom
 * @param {Object} [opts]
 * @param {string} [opts.author]
 * @param {string} [opts.authorName]
 * @param {string} [opts.group]
 * @returns {Object} Objeto message compatível com o pipeline
 */
function msgComQuote(texto, quotedMsg, opts = {}) {
	// Monta o objeto quotedMsg no formato que as functions esperam
	const quoted = {
		type: quotedMsg.type ?? "text",
		content: quotedMsg.content ?? "",
		caption: quotedMsg.caption ?? "",
		author: quotedMsg.author ?? _defaultAuthor,
		authorName: quotedMsg.authorName ?? _defaultAuthorName,
		id: quotedMsg.origin?.id ?? { id: "quoted-fake-id" },
		// Campos adicionais acessados via message.quotedMsg nas functions
		body: quotedMsg.type === "text" ? (quotedMsg.content ?? "") : (quotedMsg.caption ?? ""),
		hasMedia: quotedMsg.type !== "text",
		mimetype: quotedMsg.content?.mimetype ?? null
	};

	const msg = createMessage({
		type: "text",
		content: texto,
		hasQuotedMsg: true,
		quotedMsg: quoted,
		author: opts.author ?? _defaultAuthor,
		authorName: opts.authorName ?? _defaultAuthorName,
		group: opts.group !== undefined ? opts.group : _defaultGroupId
	});

	// Alguns comandos acessam o quoted via message.origin._data.quotedMsg
	msg.origin._data.quotedMsg = quoted;
	msg.origin.hasQuotedMsg = true;

	// Alguns comandos chamam message.origin.getQuotedMessage()
	msg.origin.getQuotedMessage = async () => ({
		...quoted,
		downloadMedia: async () => quotedMsg.content ?? null,
		react: async () => {},
		delete: async () => {}
	});

	return msg;
}

/**
 * Cria mensagem totalmente customizada, fazendo merge com os defaults.
 * Use quando os helpers acima não cobrem o caso de teste.
 *
 * @param {Object} overrides - Qualquer campo do objeto message
 * @returns {Object} Objeto message compatível com o pipeline
 */
function msgCustom(overrides = {}) {
	return createMessage({
		author: _defaultAuthor,
		authorName: _defaultAuthorName,
		group: _defaultGroupId,
		type: "text",
		content: "",
		...overrides
	});
}

module.exports = {
	msgTexto,
	msgMedia,
	msgComQuote,
	msgCustom,
	setDefaults
};
