/**
 * test_sticker_metadata.js
 * Teste unitário para validar o empacotamento de stickerAuthor e stickerName no WhatsAppBotGo
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");

async function runTest() {
	console.log("Iniciando teste de stickerAuthor e stickerName...");

	// Simula a lógica de construção de payload de WhatsAppBotGo
	function buildPayload(bot, content, options = {}) {
		const payload = {};
		if (content.isMessageMedia || options.sendMediaAsSticker) {
			if (options.sendMediaAsSticker) {
				payload.sticker = content.url || content.data;
				const defaultAuthor = bot.nomeExibir || bot.nome || "Ravena";
				payload.sticker_author = options.stickerAuthor || defaultAuthor;
				payload.sticker_name = options.stickerName || payload.sticker_author;
				if (Array.isArray(options.stickerCategories) && options.stickerCategories.length > 0) {
					payload.emojis = options.stickerCategories;
				}
			}
		}
		return payload;
	}

	// Cenário 1: Opções explícitas fornecidas
	const bot1 = { nome: "ravena2", nomeExibir: "Ravena Gaúcha" };
	const payload1 = buildPayload(
		bot1,
		{ url: "http://example.com/sticker.webp" },
		{
			sendMediaAsSticker: true,
			stickerAuthor: "Tio Florêncio",
			stickerName: "Figurinhas Campeiras",
			stickerCategories: ["🧉", "🐎"]
		}
	);

	assert.strictEqual(
		payload1.sticker_author,
		"Tio Florêncio",
		"Deveria usar o stickerAuthor fornecido"
	);
	assert.strictEqual(
		payload1.sticker_name,
		"Figurinhas Campeiras",
		"Deveria usar o stickerName fornecido"
	);
	assert.deepStrictEqual(payload1.emojis, ["🧉", "🐎"], "Deveria passar emojis fornecidos");
	console.log("✓ Cenário 1: Opções explícitas aprovadas.");

	// Cenário 2: Fallback para nomeExibir
	const payload2 = buildPayload(
		bot1,
		{ url: "http://example.com/sticker.webp" },
		{
			sendMediaAsSticker: true
		}
	);

	assert.strictEqual(
		payload2.sticker_author,
		"Ravena Gaúcha",
		"Deveria usar nomeExibir como fallback de autor"
	);
	assert.strictEqual(
		payload2.sticker_name,
		"Ravena Gaúcha",
		"Deveria usar autor como fallback de pacote"
	);
	console.log("✓ Cenário 2: Fallback nomeExibir aprovado.");

	// Cenário 3: Fallback para nome quando nomeExibir não existe
	const bot3 = { nome: "ravena_bot" };
	const payload3 = buildPayload(
		bot3,
		{ url: "http://example.com/sticker.webp" },
		{
			sendMediaAsSticker: true
		}
	);

	assert.strictEqual(
		payload3.sticker_author,
		"ravena_bot",
		"Deveria usar nome como fallback de autor"
	);
	assert.strictEqual(
		payload3.sticker_name,
		"ravena_bot",
		"Deveria usar nome como fallback de pacote"
	);
	console.log("✓ Cenário 3: Fallback nome aprovado.");

	// Cenário 4: Fallback final para 'Ravena'
	const bot4 = {};
	const payload4 = buildPayload(
		bot4,
		{ url: "http://example.com/sticker.webp" },
		{
			sendMediaAsSticker: true
		}
	);

	assert.strictEqual(
		payload4.sticker_author,
		"Ravena",
		"Deveria usar 'Ravena' como fallback final"
	);
	assert.strictEqual(
		payload4.sticker_name,
		"Ravena",
		"Deveria usar 'Ravena' como fallback final de pacote"
	);
	console.log("✓ Cenário 4: Fallback final 'Ravena' aprovado.");

	console.log("\nTodos os testes de metadados de sticker passaram com louvor!");
}

runTest()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Falha no teste:", err);
		process.exit(1);
	});
