"use strict";

const Logger = require("./Logger");

const logger = new Logger("humanizer-helper");

/**
 * Diretrizes de escrita humana compiladas e adaptadas a partir do repositório
 * https://github.com/blader/humanizer e do WikiProject AI Cleanup (Wikipedia).
 * Otimizado para mensagens naturais, fluidas e diretas de WhatsApp em pt-BR.
 */
const HUMANIZER_DIRECTIVE = `### DIRETRIZES DE ESTILO DE ESCRITA HUMANA (OBRIGATÓRIO):
Adote tom natural, direto e humano, como uma pessoa real conversando no WhatsApp:
1. NUNCA use travessões (— ou –) para conectar orações. Use vírgulas, pontos ou reformule a frase.
2. NUNCA use encenação ou contrastes vazios tipo "não apenas X, mas Y", "não é sobre X, é sobre Y" ou "mais do que um X, um Y". Afirme o ponto diretamente.
3. NUNCA termine com frases de efeito dramáticas ou clichês de autoajuda ("Isso faz toda a diferença", "O recado é claro", "No fim das contas...", "Um verdadeiro divisor de águas"). Termine no último fato concreto.
4. NUNCA use aberturas de chatbot ou bajulações ("Com certeza!", "Claro!", "Ótima pergunta!", "Vamos mergulhar em...", "Aqui está o que você precisa saber"). Comece respondendo direto.
5. NUNCA use jargões corporativos inflados de IA ("robusto", "crucial", "fundamental", "tapeçaria", "verdadeiro testamento", "destacando", "enfatizando", "ao longo da jornada"). Use palavras simples: é, tem, faz.
6. Evite tríades forçadas (agrupar sempre três adjetivos ou exemplos em sequência só para dar ritmo artificial).
7. Não decore cada linha com negrito ou títulos em caixa alta desnecessários. Se uma resposta couber em prosa fluida, prefira prosa a listas verticais numeradas ou com marcadores.
8. Vá direto ao ponto sem reexplicar o que o usuário já sabe nem dar disclaimers óbvios sobre limitações de conhecimento.`;

/**
 * Padrões de abertura comuns em saídas de chatbot que devem ser removidos.
 */
const OPENING_PATTERNS = [
	/^(?:Com certeza[!.,]?|Certamente[!.,]?|Claro[!.,]?|Claro que sim[!.,]?|Ótima pergunta[!.,]?|Excelente pergunta[!.,]?|Sem dúvidas[!.,]?|Sem problemas[!.,]?)\s*/i,
	/^(?:Aqui está|Aqui vai|Aqui estão|Segue|Abaixo está|Veja a seguir)[!.,:]?\s*(?:o que você pediu|as informações|a resposta|o conteúdo|o resultado|o resumo)?[!.,:]?\s*/i,
	/^(?:Espero que ajude|Espero ajudar|Olá[!.,]? como posso ajudar\?)\s*/i
];

/**
 * Padrões de encerramento vazios ou bajuladores típicos de IA.
 */
const CLOSING_PATTERNS = [
	/\s*(?:Espero (?:ter ajudado|que isso ajude|ter sido útil)|Qualquer dúvida,? (?:é só chamar|estou à disposição|me avise)|Se precisar de mais alguma coisa,? (?:é só falar|avise)|Fico à disposição)[!.]*\s*$/i
];

/**
 * Sanitizador determinístico rápido (zero-cost) para remover resíduos mecânicos de IA.
 * Remove travessões universais (— ou –), aberturas/fechamentos de chatbot e pontuação duplicada,
 * preservando blocos de código e dados estruturados em JSON.
 *
 * @param {string} text - Texto bruto retornado pelo modelo
 * @returns {string} - Texto sanitizado e mais humano
 */
function sanitizeHumanizerResidue(text) {
	if (typeof text !== "string" || text.length === 0) {
		return text;
	}

	const trimmed = text.trim();

	// Se for JSON estruturado válido, não modifica
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		try {
			JSON.parse(trimmed);
			return text;
		} catch (e) {
			// Não é JSON válido, prossegue com a sanitização
		}
	}

	// Preserva blocos de código markdown (inline e multilinha)
	const codeBlocks = [];
	let processed = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
		codeBlocks.push(match);
		return `__HUMANIZER_CODE_${codeBlocks.length - 1}__`;
	});

	// 1. Converte en-dash entre números para hífen padrão (ex: 1990–2000 -> 1990-2000)
	processed = processed.replace(/(\d+)\s*[–—]\s*(\d+)/g, "$1-$2");

	// 2. Remove travessões precedidos de pontuação (ex: ", — " -> ", ")
	processed = processed.replace(/([,.;!?])\s*[—–]\s*/g, "$1 ");

	// 3. Converte traço duplo e travessões em vírgula
	processed = processed.replace(/\s+--\s+/g, ", ");
	processed = processed.replace(/\s*[—–]\s*/g, ", ");

	// 4. Limpa pontuação duplicada gerada pelas substituições
	processed = processed.replace(/,\s*,/g, ", ");
	processed = processed.replace(/,\s*\./g, ".");
	processed = processed.replace(/\.\s*,/g, ".");
	processed = processed.replace(/([?!])\s*,/g, "$1 ");

	// 5. Remove aberturas bajuladoras de chatbot
	for (const pattern of OPENING_PATTERNS) {
		processed = processed.replace(pattern, "");
	}

	// 6. Remove fechamentos genéricos de chatbot
	for (const pattern of CLOSING_PATTERNS) {
		processed = processed.replace(pattern, "");
	}

	// 7. Normaliza espaços múltiplos mantendo quebras de linha
	processed = processed.replace(/[^\S\r\n]{2,}/g, " ");

	// 8. Restaura blocos de código
	if (codeBlocks.length > 0) {
		processed = processed.replace(/__HUMANIZER_CODE_(\d+)__/g, (_, idx) => codeBlocks[Number(idx)]);
	}

	return processed.trim();
}

/**
 * Reescrita Two-Pass dedicada usando Humanizer (sob demanda para textos mais longos).
 *
 * @param {Object} llmService - Instância do LLMService
 * @param {string} text - Texto rascunho a ser reescrito
 * @param {Object} [options={}] - Opções extras (priority, bypassQueue, etc.)
 * @returns {Promise<string>} - Texto reescrito
 */
async function humanizeText(llmService, text, options = {}) {
	if (!text || typeof text !== "string" || text.trim().length === 0) {
		return text;
	}

	try {
		const prompt = `Reescreva o texto a seguir eliminando vícios de IA, frases de efeito artificiais, travessões excessivos e introduções/conclusões bajuladoras. Mantenha todas as informações, dados, nomes e o significado original intactos, soando natural como uma pessoa real conversando em português:\n\n${text.trim()}`;

		const response = await llmService.getCompletion({
			prompt,
			systemContext: HUMANIZER_DIRECTIVE,
			humanize: false, // Evita recursão infinita
			bypassQueue: options.bypassQueue ?? false,
			priority: options.priority ?? 4
		});

		return sanitizeHumanizerResidue(response);
	} catch (err) {
		logger.warn(
			"Falha no segundo passe do Humanizer, retornando texto original sanitizado:",
			err.message
		);
		return sanitizeHumanizerResidue(text);
	}
}

module.exports = {
	HUMANIZER_DIRECTIVE,
	sanitizeHumanizerResidue,
	humanizeText
};
