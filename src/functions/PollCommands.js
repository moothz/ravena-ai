const chrono = require("chrono-node");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const CustomVariableProcessor = require("../utils/CustomVariableProcessor");

const variableProcessor = new CustomVariableProcessor();

/**
 * Interpreta string ou token de data/hora para o encerramento da enquete
 * @param {string} text - Token ou texto de data/hora (ex: "hoje", "amanha", "12:50", "13:30 06/11/2026")
 * @returns {number} - Timestamp UNIX em segundos ou 0 se não reconhecido
 */
function parseEndTime(text) {
	if (!text || typeof text !== "string") return 0;

	const clean = text.trim();
	const lower = clean.toLowerCase();
	const now = new Date();

	// 1. $hoje -> final de hoje (23:59:59)
	if (lower === "hoje") {
		const target = new Date();
		target.setHours(23, 59, 59, 0);
		return Math.floor(target.getTime() / 1000);
	}

	// 2. $amanha / $amanhã -> final de amanhã (23:59:59)
	if (lower === "amanha" || lower === "amanhã") {
		const target = new Date();
		target.setDate(target.getDate() + 1);
		target.setHours(23, 59, 59, 0);
		return Math.floor(target.getTime() / 1000);
	}

	// 3. Duração simples: 30m, 1h, 2d
	const durMatch = clean.match(/^(\d+)(m|h|d)$/i);
	if (durMatch) {
		const num = parseInt(durMatch[1], 10);
		const unit = durMatch[2].toLowerCase();
		let addMs = 0;
		if (unit === "m") addMs = num * 60 * 1000;
		else if (unit === "h") addMs = num * 3600 * 1000;
		else if (unit === "d") addMs = num * 86400 * 1000;
		return Math.floor((Date.now() + addMs) / 1000);
	}

	// 4. Apenas horário: HH:mm ou HHhmm (ex: 12:50, 12h50, 12h)
	const timeMatch = clean.match(/^(\d{1,2})(?::|h)(\d{2})?$/i);
	if (timeMatch) {
		const hour = parseInt(timeMatch[1], 10);
		const min = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
		if (hour >= 0 && hour < 24 && min >= 0 && min < 60) {
			const target = new Date();
			target.setHours(hour, min, 0, 0);
			if (target.getTime() <= now.getTime()) {
				// Já passou hoje, joga para amanhã
				target.setDate(target.getDate() + 1);
			}
			return Math.floor(target.getTime() / 1000);
		}
	}

	// 5. Horário + Data: ex: "13:30 06/11/2026" ou "06/11/2026 13:30" ou "13:30 06/11"
	const dtMatch1 = clean.match(/^(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
	const dtMatch2 = clean.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2})$/);
	if (dtMatch1 || dtMatch2) {
		const m = dtMatch1 || dtMatch2;
		let hour;
		let min;
		let day;
		let month;
		let year;
		if (dtMatch1) {
			hour = parseInt(m[1], 10);
			min = parseInt(m[2], 10);
			day = parseInt(m[3], 10);
			month = parseInt(m[4], 10) - 1;
			year = m[5] ? parseInt(m[5], 10) : now.getFullYear();
		} else {
			day = parseInt(m[1], 10);
			month = parseInt(m[2], 10) - 1;
			year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
			hour = parseInt(m[4], 10);
			min = parseInt(m[5], 10);
		}
		const target = new Date(year, month, day, hour, min, 0, 0);
		if (!isNaN(target.getTime()) && target.getTime() > now.getTime()) {
			return Math.floor(target.getTime() / 1000);
		}
	}

	// 6. Chrono fallback (para expressões em português, ex: "amanhã às 10:00")
	try {
		const results = chrono.pt.casual.parse(clean, { forwardDate: true });
		if (results && results.length > 0) {
			const date = results[0].start.date();
			if (date.getTime() > now.getTime()) {
				return Math.floor(date.getTime() / 1000);
			}
		}
	} catch {}

	return 0;
}

/**
 * Extrai tokens individuais de configuração a partir de array ou string
 * @param {Array<string>|string} input
 * @returns {Array<string>}
 */
function extractTokens(input) {
	if (!input) return [];
	let rawList = [];
	if (Array.isArray(input)) {
		rawList = input;
	} else if (typeof input === "string") {
		if (input.includes("$")) {
			rawList = input
				.split("$")
				.map((s) => s.trim())
				.filter(Boolean);
		} else {
			rawList = [input.trim()];
		}
	}

	const result = [];
	for (const item of rawList) {
		const cleanItem = item.replace(/^[$]+/, "").trim();
		if (!cleanItem) continue;
		if (parseEndTime(cleanItem) > 0) {
			result.push(cleanItem);
		} else {
			const sub = cleanItem
				.split(/[,;\s]+/)
				.map((s) => s.trim())
				.filter(Boolean);
			result.push(...sub);
		}
	}
	return result;
}

/**
 * Detecta e interpreta as opções de configuração ($anonimo, $multiplas, data/hora)
 * @param {Array<string>|string} configTokensOrStr
 * @returns {{ hideVoters: boolean, allowMultipleAnswers: boolean, endTime: number }}
 */
function parsePollConfigs(configTokensOrStr) {
	let hideVoters = false;
	let allowMultipleAnswers = false;
	let endTime = 0;

	if (!configTokensOrStr) {
		return { hideVoters, allowMultipleAnswers, endTime };
	}

	const tokens = extractTokens(configTokensOrStr);

	for (const token of tokens) {
		const clean = token.startsWith("$") ? token.substring(1).trim() : token.trim();
		const lower = clean.toLowerCase();

		// Anônimo / Esconder votantes
		if (["anonimo", "anônimo", "anon", "secret", "secreto"].includes(lower)) {
			hideVoters = true;
			continue;
		}

		// Múltiplas respostas
		if (
			["multiplas", "múltiplas", "multipla", "múltipla", "mult", "multiple", "multi"].includes(
				lower
			)
		) {
			allowMultipleAnswers = true;
			continue;
		}

		// Data / hora de encerramento
		const parsedEndTime = parseEndTime(clean);
		if (parsedEndTime > 0) {
			endTime = parsedEndTime;
		}
	}

	return { hideVoters, allowMultipleAnswers, endTime };
}

/**
 * Executa a criação da enquete via comando !enquete / !poll
 */
async function criarEnquete(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const rawContent = (
		typeof message.content === "string" ? message.content : message.body || ""
	).trim();

	// Remove o comando inicial (ex: "!poll", "!enquete", "/poll", etc.)
	const cleanText = rawContent.replace(/^[!/#][\w\d_-]+\s*/i, "").trim();

	if (!cleanText) {
		return new ReturnMessage({
			chatId,
			content:
				"📊 *Como criar uma enquete:*\n\n" +
				"!enquete Pergunta da enquete?\n" +
				"Opção 1\n" +
				"Opção 2\n" +
				"Opção 3\n\n" +
				"$multiplas $anonimo $hoje\n\n" +
				"*Configurações opcionais (ao final):*\n" +
				"• `$anonimo` ou `$anon`: Oculta os nomes dos votantes\n" +
				"• `$multiplas` ou `$mult`: Permite selecionar mais de uma opção\n" +
				"• `$hoje`, `$amanha`, `$12:50`, `$13:30 06/11/2026`: Horário de término da enquete",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	const lines = cleanText
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

	if (lines.length === 0) {
		return new ReturnMessage({
			chatId,
			content: "Por favor, informe a pergunta e as opções da enquete em linhas separadas."
		});
	}

	// Detecta linhas de configuração no final que iniciem com '$'
	const configTokens = [];
	while (lines.length > 1 && lines[lines.length - 1].startsWith("$")) {
		const line = lines.pop();
		const parts = line
			.split("$")
			.map((p) => p.replace(/[,;]+$/, "").trim())
			.filter(Boolean);
		for (const p of parts) {
			configTokens.push(p);
		}
	}

	const configs = parsePollConfigs(configTokens);

	const rawQuestion = lines[0];
	const rawOptions = lines.slice(1);

	if (!rawQuestion) {
		return new ReturnMessage({
			chatId,
			content: "Por favor, informe a pergunta da enquete na primeira linha."
		});
	}

	if (rawOptions.length < 2) {
		return new ReturnMessage({
			chatId,
			content:
				"⚠️ A enquete precisa de no mínimo 2 opções de resposta.\nExemplo:\n!enquete Pergunta?\nOpção 1\nOpção 2",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	if (rawOptions.length > 12) {
		return new ReturnMessage({
			chatId,
			content: "⚠️ O WhatsApp permite no máximo 12 opções por enquete.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	// Processa variáveis de texto na pergunta e nas opções
	const context = {
		message,
		group,
		bot,
		options: {}
	};

	const processedQuestion = await variableProcessor.process(rawQuestion, context);
	const question =
		typeof processedQuestion === "string"
			? processedQuestion.trim()
			: String(processedQuestion || "");

	const processedOptions = [];
	for (const rawOpt of rawOptions) {
		const res = await variableProcessor.process(rawOpt, context);
		const optText = typeof res === "string" ? res.trim() : String(res || "");
		if (optText) {
			processedOptions.push(optText);
		}
	}

	if (processedOptions.length < 2) {
		return new ReturnMessage({
			chatId,
			content:
				"⚠️ A enquete precisa de pelo menos 2 opções de resposta válidas após o processamento.",
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	}

	// Garante que não haja opções duplicadas (o WhatsApp rejeita hashes de opções idênticas)
	const seen = new Map();
	const uniqueOptions = [];
	for (const opt of processedOptions) {
		const count = (seen.get(opt) || 0) + 1;
		seen.set(opt, count);
		if (count === 1) {
			uniqueOptions.push(opt);
		} else {
			uniqueOptions.push(`${opt} (${count})`);
		}
	}

	return new ReturnMessage({
		chatId,
		poll: {
			question,
			options: uniqueOptions,
			allowMultipleAnswers: configs.allowMultipleAnswers,
			hideVoters: configs.hideVoters,
			endTime: configs.endTime
		},
		options: {
			quotedMessageId: message.origin?.id?._serialized,
			goReply: message.origin
		}
	});
}

const commands = [
	new Command({
		name: "enquete",
		aliases: ["poll"],
		description: "Cria uma enquete interativa no WhatsApp",
		category: "utilidades",
		usage: "!enquete Pergunta?\nOpção 1\nOpção 2\n\n$multiplas $anonimo $hoje",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📊"
		},
		method: criarEnquete
	})
];

module.exports = {
	commands,
	criarEnquete,
	parsePollConfigs,
	parseEndTime
};
