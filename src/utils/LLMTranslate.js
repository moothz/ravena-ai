const crypto = require("crypto");
const Logger = require("./Logger");
const Database = require("./Database");
const telemetry = require("../telemetry");
const { translateText } = require("../functions/TranslationCommands");

const logger = new Logger("llm-translate");
const database = Database.getInstance();
const dbName = "translation-cache";

// Initialize database
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS cached_translations (
      hash TEXT PRIMARY KEY,
      original_text TEXT,
      translated_text TEXT,
      target_language TEXT,
      created_at INTEGER
    );
`
);

/**
 * Computes MD5 hash of text and target language
 * @param {string} text
 * @param {string} targetLanguage
 * @returns {string}
 */
function getHash(text, targetLanguage) {
	return crypto.createHash("md5").update(`${text}_${targetLanguage}`).digest("hex");
}

/**
 * Translates text using LLM with caching
 * @param {string} text - Text to translate
 * @param {string} targetLanguage - Target language (e.g., "Spanish (ES)")
 * @param {Object} llmService - Instance of LLMService
 * @returns {Promise<string>} - Translated text
 */
async function llmTranslate(text, targetLanguage, llmService) {
	if (!text || typeof text !== "string" || text.trim().length === 0) return text;

	// 1. Check Cache
	const hash = getHash(text, targetLanguage);
	try {
		const cached = await database.dbGet(
			dbName,
			"SELECT translated_text FROM cached_translations WHERE hash = ?",
			[hash]
		);
		if (cached) {
			//logger.debug(`[llmTranslate] Cache hit for '${text.substring(0, 20)}...'`);
			return cached.translated_text;
		}
	} catch (error) {
		logger.error("Error checking translation cache:", error);
	}

	// 2. LLM Translation
	let translatedText = null;
	try {
		const completionOptions = {
			prompt: text,
			systemContext: `You are a professional translator engine.
Source Language: Brazilian Portuguese (PT-BR)
Target Language: ${targetLanguage}

RULES:
1. Translate the TEXT CONTENT only.
2. DO NOT translate words preceding ! directly, like '!comandos' or '!ajuda'. These are bot commands.
2. DO NOT translate, remove, or change any EMOJIS. Keep them exactly where they are.
3. DO NOT change any formatting marks (like *bold*, _italics_, ~strikethrough~, or \`code\`).
4. DO NOT add conversational filler (like "Here is the translation"). Output ONLY the translated string.
5. If the text is only emojis/symbols, return it unchanged.
6. DO NOT translate commands (strings starting with '!', '.', '/', or '#'). Return them exactly as is.`,
			priority: 4
		};

		const response = await llmService.getCompletion(completionOptions);
		if (response?.toLowerCase().startsWith("erro:")) {
			throw new Error("Falha no LLM");
		}
		if (response && response.trim().length > 0) {
			translatedText = response.trim();
		}
	} catch (e) {
		logger.warn(`[llmTranslate] LLM translation failed, trying fallback: ${e.message}`);
	}

	// 3. Fallback Translation
	if (!translatedText) {
		try {
			// extract 'es' from 'Spanish (ES)'
			const match = targetLanguage.match(/\(([^)]+)\)/);
			const langCode = match
				? match[1].toLowerCase()
				: targetLanguage.length === 2
					? targetLanguage
					: "en";
			translatedText = await translateText(text, "pt", langCode);
		} catch (e) {
			logger.error(`[llmTranslate] Fallback translation failed: ${e.message}`);
			return text;
		}
	}

	// 4. Save to Cache
	if (translatedText) {
		try {
			await database.dbRun(
				dbName,
				`
        INSERT OR REPLACE INTO cached_translations (hash, original_text, translated_text, target_language, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
				[hash, text, translatedText, targetLanguage, Date.now()]
			);
		} catch (error) {
			logger.error("Error saving translation to cache:", error);
		}
	}

	return translatedText;
}

const BATCH_MAX_CHARS = 12000;

function packBatches(texts) {
	const batches = [];
	let current = [];
	let currentChars = 0;
	texts.forEach((text, idx) => {
		if (typeof text !== "string" || text.trim().length === 0) return;
		if (current.length > 0 && currentChars + text.length > BATCH_MAX_CHARS) {
			batches.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(idx);
		currentChars += text.length;
	});
	if (current.length > 0) batches.push(current);
	return batches;
}

function joinBatch(parts) {
	return parts.map((text, pos) => `<<${pos + 1}>>\n${text}`).join("\n\n");
}

function splitBatch(translated, count) {
	if (typeof translated !== "string") return null;
	const pieces = translated.split(/<<(\d+)>>/);
	if (pieces.length !== count * 2 + 1 || pieces[0].trim().length > 0) return null;
	const parts = [];
	for (let pos = 0; pos < count; pos++) {
		const segment = pieces[pos * 2 + 2].trim();
		if (pieces[pos * 2 + 1] !== String(pos + 1) || segment.length === 0) return null;
		parts.push(segment);
	}
	return parts;
}

async function llmTranslateMany(texts, targetLanguage, llmService) {
	const batches = packBatches(texts);
	if (batches.length === 0) return [...texts];
	return telemetry.withSpan(
		"translate batch",
		{ attributes: { "ravena.translate.parts": batches.flat().length } },
		async (span) => {
			const results = [...texts];
			let fallbacks = 0;
			const translateOne = async (idx) => {
				try {
					results[idx] = await llmTranslate(texts[idx], targetLanguage, llmService);
				} catch (e) {
					logger.error(`[llmTranslateMany] Translation error: ${e.message}`);
				}
			};
			for (const batch of batches) {
				if (batch.length === 1) {
					await translateOne(batch[0]);
					continue;
				}
				let parts = null;
				try {
					const translated = await llmTranslate(
						joinBatch(batch.map((idx) => texts[idx])),
						targetLanguage,
						llmService
					);
					parts = splitBatch(translated, batch.length);
				} catch (e) {
					logger.warn(`[llmTranslateMany] Batch translation failed: ${e.message}`);
				}
				if (parts) {
					batch.forEach((idx, pos) => {
						results[idx] = parts[pos];
					});
					continue;
				}
				fallbacks++;
				logger.warn(
					`[llmTranslateMany] Could not split batch of ${batch.length} parts, translating one by one`
				);
				for (const idx of batch) await translateOne(idx);
			}
			telemetry.setAttrs(
				{ "ravena.translate.batches": batches.length, "ravena.translate.fallbacks": fallbacks },
				span
			);
			return results;
		}
	);
}

module.exports = {
	llmTranslate,
	llmTranslateMany
};
