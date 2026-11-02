/**
 * Helper para conversão de markup do WhatsApp em markup HTML do Telegram.
 *
 * Suporta:
 * - *negrito* -> <b>negrito</b>
 * - _italico_ -> <i>italico</i>
 * - ~tachado~ -> <s>tachado</s>
 * - `monospace` -> <code>monospace</code> (clicável para copiar no Telegram)
 * - ```bloco monospace``` -> <pre>bloco monospace</pre>
 * - > quoted -> <blockquote>quoted</blockquote> (cor mais suave com barra lateral)
 * - Comandos com hífen (!mu-roll -> /mu_roll) para ficarem clicáveis no Telegram
 * - Comandos simples (!cmd -> /cmd)
 * - URLs no final da mensagem -> <a href="...">Link Direto</a>
 * - Proteção de tags e fallback limpo
 */

/**
 * Escapa caracteres especiais HTML (&, <, >)
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
	if (typeof str !== "string") return "";
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Remove tags HTML e reverte entidades escapadas para texto puro
 * @param {string} str
 * @returns {string}
 */
function stripHtml(str) {
	if (typeof str !== "string") return "";
	return str
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

/**
 * Fecha tags HTML que tenham sido abertas mas não fechadas, evitando erros de parse no Telegram.
 * @param {string} html
 * @returns {string}
 */
function balanceHtmlTags(html) {
	const supportedTags = [
		"b",
		"strong",
		"i",
		"em",
		"u",
		"s",
		"strike",
		"del",
		"code",
		"pre",
		"blockquote",
		"a"
	];
	const tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*?)?>/g;
	const openStack = [];

	let match;
	while ((match = tagRegex.exec(html)) !== null) {
		const fullTag = match[0];
		const tagName = match[1].toLowerCase();
		if (!supportedTags.includes(tagName)) continue;

		const isClosing = fullTag.startsWith("</");
		if (isClosing) {
			const idx = openStack.lastIndexOf(tagName);
			if (idx !== -1) {
				openStack.splice(idx, 1);
			}
		} else {
			openStack.push(tagName);
		}
	}

	let balanced = html;
	while (openStack.length > 0) {
		const tagToClose = openStack.pop();
		balanced += `</${tagToClose}>`;
	}

	return balanced;
}

/**
 * Converte blocos de linhas de citação (> texto) do WhatsApp em <blockquote>...</blockquote>
 * Agrupa linhas consecutivas em um único bloco.
 *
 * @param {string} text
 * @returns {string}
 */
function processQuotes(text) {
	const lines = text.split("\n");
	const output = [];
	let quoteBuffer = [];

	const flushQuotes = () => {
		if (quoteBuffer.length > 0) {
			output.push(`<blockquote>${quoteBuffer.join("\n")}</blockquote>`);
			quoteBuffer = [];
		}
	};

	for (const line of lines) {
		// Detecta linhas iniciadas por '>' (com espaço opcional)
		const quoteMatch = line.match(/^>\s?(.*)$/);
		if (quoteMatch) {
			quoteBuffer.push(quoteMatch[1]);
		} else {
			flushQuotes();
			output.push(line);
		}
	}
	flushQuotes();

	return output.join("\n");
}

/**
 * Formata texto do WhatsApp para HTML do Telegram
 *
 * @param {string} text - Texto original
 * @param {Object|Array} [mentionMap={}] - Mapeamento de menções (@ID -> Nome ou {id, name})
 * @returns {string} - Texto formatado em HTML para Telegram
 */
function formatWhatsAppToTelegram(text, mentionMap = {}) {
	if (typeof text !== "string" || text.length === 0) return text;

	// 1. Extrair e isolar blocos de código multilinhas (```...```) para não misturar formatações
	const preBlocks = [];
	let formatted = text.replace(/```(?:([a-zA-Z0-9_-]+)\n)?([\s\S]*?)```/g, (match, lang, code) => {
		const escapedCode = escapeHtml(code);
		const index = preBlocks.length;
		if (lang) {
			preBlocks.push(`<pre><code class="language-${lang}">${escapedCode}</code></pre>`);
		} else {
			preBlocks.push(`<pre>${escapedCode}</pre>`);
		}
		return `\x01PRE_BLOCK_${index}\x01`;
	});

	// 2. Extrair e isolar códigos inline (`...`)
	const inlineCodes = [];
	formatted = formatted.replace(/`([^`\n]+?)`/g, (match, code) => {
		// Converte comandos dentro de crases se aplicável (ex: `!faz-plantar` -> `/faz_plantar`)
		let codeText = code;
		codeText = codeText.replace(
			/(^|[\s>(])([!/])([a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)+)(?=[^\w-]|$)/g,
			(m, p, trig, cmd) => `${p}/${cmd.replace(/-/g, "_")}`
		);
		codeText = codeText.replace(/(^|[\s>(])!([a-zA-Z0-9]+)(?=[^\w-]|$)/g, (m, p, cmd) =>
			/^\d+$/.test(cmd) ? m : `${p}/${cmd}`
		);

		const escapedCode = escapeHtml(codeText);
		const index = inlineCodes.length;
		inlineCodes.push(`<code>${escapedCode}</code>`);
		return `\x01INLINE_CODE_${index}\x01`;
	});

	// 3. Processar citações / quotes (> texto) agrupando linhas consecutivas
	formatted = processQuotes(formatted);

	// 4. Escapar HTML em partes que não são tags que acabamos de criar (<blockquote>)
	// Para não escapar nossas tags <blockquote>, dividimos e escapamos o conteúdo
	const parts = formatted.split(/(<\/?blockquote>)/g);
	formatted = parts
		.map((part) => {
			if (part === "<blockquote>" || part === "</blockquote>") {
				return part;
			}
			return escapeHtml(part);
		})
		.join("");

	// 5. Tratar Menções (@123456789)
	if (Array.isArray(mentionMap)) {
		for (const mentionId of mentionMap) {
			const mentionRegex = new RegExp(`@${mentionId}\\b`, "g");
			formatted = formatted.replace(
				mentionRegex,
				`<a href="tg://user?id=${mentionId}">@${mentionId}</a>`
			);
		}
	} else if (typeof mentionMap === "object" && mentionMap !== null) {
		for (const [id, value] of Object.entries(mentionMap)) {
			const mentionRegex = new RegExp(`@${id}\\b`, "g");
			const displayName = escapeHtml((typeof value === "object" ? value.name : value) || id);
			const tgId = typeof value === "object" ? value.id : id;
			formatted = formatted.replace(
				mentionRegex,
				`<a href="tg://user?id=${tgId}">@${displayName}</a>`
			);
		}
	}

	// 6. Conversão de estilos do WhatsApp:
	// Negrito: *texto* -> <b>texto</b>
	formatted = formatted.replace(/\*([^*\n\r]+?)\*/g, (match, inner) => {
		if (/^\s*$/.test(inner)) return match;
		return `<b>${inner}</b>`;
	});

	// Itálico: _texto_ -> <i>texto</i> (respeitando bordas para não quebrar underscores de identificadores)
	formatted = formatted.replace(
		/(^|[\s>(~*<])_([^_\n\r]+?)_(?=[^\w]|$)/g,
		(match, prefixChar, inner) => {
			if (/^\s*$/.test(inner)) return match;
			// Remove espaços desnecessários nas pontas se houver (ex: _texto _)
			const cleanInner = inner.trim();
			return `${prefixChar}<i>${cleanInner}</i>`;
		}
	);

	// Tachado: ~texto~ -> <s>texto</s>
	formatted = formatted.replace(
		/(^|[\s>(_*<])~([^~\n\r]+?)~(?=[^\w]|$)/g,
		(match, prefixChar, inner) => {
			if (/^\s*$/.test(inner)) return match;
			return `${prefixChar}<s>${inner.trim()}</s>`;
		}
	);

	// 7. Converter URLs no final do texto para "Link Direto"
	const urlRegex = /(https?:\/\/[^\s<]+)\s*$/i;
	formatted = formatted.replace(urlRegex, '<a href="$1">Link Direto</a>');

	// 8. Converter comandos com hífen para comandos válidos do Telegram com underscore (/cmd_name)
	formatted = formatted.replace(
		/(^|[\s>(])([!/])([a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)+)(?=[^\w-]|$)/g,
		(match, prefixChar, trigger, cmdName, offset, fullStr) => {
			const textBefore = fullStr.substring(Math.max(0, offset - 100), offset);
			if (/https?:\/\/[^\s<]*$/i.test(textBefore)) {
				return match; // Dentro de uma URL, não modifica
			}
			return `${prefixChar}/${cmdName.replace(/-/g, "_")}`;
		}
	);

	// 9. Converter comandos simples comuns iniciados com '!' para '/' para ficarem clicáveis
	formatted = formatted.replace(
		/(^|[\s>(])!([a-zA-Z0-9]+)(?=[^\w-]|$)/g,
		(match, prefixChar, cmdName, offset, fullStr) => {
			const textBefore = fullStr.substring(Math.max(0, offset - 100), offset);
			if (/https?:\/\/[^\s<]*$/i.test(textBefore)) {
				return match;
			}
			if (/^\d+$/.test(cmdName)) return match;
			return `${prefixChar}/${cmdName}`;
		}
	);

	// 10. Restaurar blocos de código
	formatted = formatted.replace(
		/\x01PRE_BLOCK_(\d+)\x01/g,
		(match, index) => preBlocks[Number(index)] || ""
	);

	formatted = formatted.replace(
		/\x01INLINE_CODE_(\d+)\x01/g,
		(match, index) => inlineCodes[Number(index)] || ""
	);

	// 11. Balancear tags HTML para segurança contra erros 400 da Telegram API
	return balanceHtmlTags(formatted);
}

module.exports = {
	formatWhatsAppToTelegram,
	escapeHtml,
	stripHtml,
	balanceHtmlTags
};
