/**
 * Utilitários para validação e compilação de expressões regulares de filtros
 */

/**
 * Constrói uma instância de RegExp a partir de uma string.
 * Suporta notação /padrão/flags (ex: /palavr[aã]o/gi) ou padrão simples (usando flag 'i' por padrão).
 * @param {string} input - Expressão regular informada pelo usuário
 * @returns {RegExp|null}
 */
function buildRegex(input) {
	if (!input || typeof input !== "string") return null;
	const match = input.match(/^\/(.+)\/([gimsuyvd]*)$/);
	if (match) {
		return new RegExp(match[1], match[2]);
	}
	return new RegExp(input, "i");
}

/**
 * Valida se um padrão regex é seguro e não excessivamente abrangente
 * para evitar que apague todas ou a maioria das mensagens do grupo.
 * @param {string} patternStr - Padrão informado pelo usuário
 * @returns {{ valid: boolean, error?: string, regex?: RegExp }}
 */
function validateRegexFilter(patternStr) {
	if (!patternStr || typeof patternStr !== "string") {
		return { valid: false, error: "O padrão regex não pode estar vazio." };
	}

	const trimmed = patternStr.trim();
	if (trimmed.length < 2) {
		return {
			valid: false,
			error: "O regex é muito curto. Informe uma expressão com pelo menos 2 caracteres."
		};
	}

	let regex;
	try {
		regex = buildRegex(trimmed);
	} catch (err) {
		return { valid: false, error: `Sintaxe de regex inválida: ${err.message}` };
	}

	if (!regex) {
		return { valid: false, error: "Expressão regular inválida." };
	}

	// 1. Não pode casar com texto vazio (ex: .*, ^, $, \s*, a*)
	try {
		if (regex.test("")) {
			return {
				valid: false,
				error: "Regex muito abrangente: casa com texto vazio e apagaria todas as mensagens."
			};
		}
	} catch (err) {
		return { valid: false, error: `Erro ao testar regex: ${err.message}` };
	}

	// 2. Não pode casar com um único espaço avulso (apagaria praticamente qualquer mensagem com espaços)
	try {
		if (regex.test(" ")) {
			return {
				valid: false,
				error:
					"Regex muito abrangente: casa com espaços avulsos e apagaria qualquer mensagem com espaços."
			};
		}
	} catch (err) {
		return { valid: false, error: `Erro ao testar regex: ${err.message}` };
	}

	// 3. Teste com frases neutras comuns do dia a dia
	const neutralSamples = [
		"olá",
		"tudo bem?",
		"bom dia",
		"boa tarde",
		"ok, obrigado",
		"sim, entendi",
		"não posso agora",
		"reunião amanhã"
	];

	let neutralMatchCount = 0;
	try {
		for (const sample of neutralSamples) {
			if (regex.test(sample)) {
				neutralMatchCount++;
			}
		}
	} catch (err) {
		return { valid: false, error: `Erro ao testar regex: ${err.message}` };
	}

	if (neutralMatchCount >= 4) {
		return {
			valid: false,
			error:
				"Regex muito abrangente: coincide com mensagens comuns e apagaria mensagens normais do grupo."
		};
	}

	// 4. Teste rápido de ReDoS (catastrophic backtracking)
	try {
		const start = Date.now();
		regex.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaa!");
		const elapsed = Date.now() - start;
		if (elapsed > 50) {
			return {
				valid: false,
				error: "Regex potencialmente vulnerável a travamento por retrocesso excessivo (ReDoS)."
			};
		}
	} catch (err) {
		return { valid: false, error: `Erro ao testar regex: ${err.message}` };
	}

	return { valid: true, regex };
}

module.exports = {
	buildRegex,
	validateRegexFilter
};
