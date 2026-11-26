process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const WhatsAppBotGo = require("../WhatsAppBotGo");
const ReturnMessage = require("../models/ReturnMessage");

const CHAT_ID = "120363000000000099@g.us";

function makeBot(translator) {
	const bot = new WhatsAppBotGo({
		id: "teste-traducao",
		whatsgoApiUrl: "http://localhost:3000",
		whatsgoApiKey: "test-key",
		instanceName: "test-inst",
		webhookHost: "http://localhost:3000"
	});
	const llmCalls = [];
	const sent = [];
	bot.llmService = {
		getCompletion: async (options) => {
			llmCalls.push(options.prompt);
			return translator(options.prompt);
		}
	};
	bot.isParticipating = () => true;
	bot.sendMessage = async (chatId, content, options) => {
		sent.push({ chatId, content, options });
		return { id: { _serialized: `msg-${sent.length}` } };
	};
	return { bot, llmCalls, sent };
}

function makeParts(tag, count) {
	return Array.from(
		{ length: count },
		(_, i) =>
			new ReturnMessage({
				chatId: CHAT_ID,
				content: `🏆 *Ranking ${tag}* (${i + 1}/${count})\n\n1. *Jogador ${i + 1}* — 💜 *${(i + 1) * 100}* Zinthos\n`
			})
	);
}

const toEnglish = (text) => text.replace(/Jogador/g, "Player").replace(/Ranking/g, "Leaderboard");

async function main() {
	console.log("=== Tradução automática em lote no sendReturnMessages ===");
	const group = { id: CHAT_ID, autoTranslateTo: "English (EN)" };

	{
		const { bot, llmCalls, sent } = makeBot(toEnglish);
		const parts = makeParts("lote-a", 7);
		const originals = parts.map((m) => m.content);
		await bot.sendReturnMessages(parts, group);
		assert.strictEqual(
			llmCalls.length,
			1,
			`7 partes devem gerar 1 chamada ao LLM, geraram ${llmCalls.length}`
		);
		assert.strictEqual(sent.length, 7, "As 7 partes devem continuar sendo enviadas separadas");
		sent.forEach((s, i) => {
			assert.strictEqual(
				s.content,
				toEnglish(originals[i]).trim(),
				`Parte ${i + 1} traduzida fora de ordem`
			);
		});
		console.log("✓ 7 partes traduzidas com 1 chamada ao LLM e enviadas em 7 mensagens, na ordem.");
	}

	{
		const { bot, llmCalls, sent } = makeBot((prompt) =>
			toEnglish(prompt.includes("<<1>>") ? prompt.replace(/<<\d+>>/g, "") : prompt)
		);
		const parts = makeParts("lote-b", 7);
		const originals = parts.map((m) => m.content);
		await bot.sendReturnMessages(parts, group);
		assert.strictEqual(
			llmCalls.length,
			8,
			`Lote sem marcadores deve cair em 1 + 7 chamadas, foram ${llmCalls.length}`
		);
		sent.forEach((s, i) => {
			assert.strictEqual(
				s.content,
				toEnglish(originals[i]).trim(),
				`Parte ${i + 1} errada no fallback`
			);
		});
		console.log("✓ Resposta do lote sem marcadores cai na tradução parte a parte.");
	}

	{
		const { bot, llmCalls, sent } = makeBot(toEnglish);
		const media = new ReturnMessage({
			chatId: CHAT_ID,
			content: { mimetype: "image/png", data: "AAAA", filename: "x.png" }
		});
		media.caption = "Ranking com imagem lote-c";
		const text = new ReturnMessage({ chatId: CHAT_ID, content: "Jogador sozinho lote-c" });
		await bot.sendReturnMessages([media, text], group);
		assert.strictEqual(llmCalls.length, 1, "Legenda e texto devem ir no mesmo lote");
		assert.strictEqual(media.caption, "Leaderboard com imagem lote-c");
		assert.strictEqual(typeof sent[0].content, "object", "Mídia não pode ser traduzida");
		assert.strictEqual(sent[1].content, "Player sozinho lote-c");
		console.log("✓ Legenda entra no lote e conteúdo de mídia fica intacto.");
	}

	{
		const { bot, llmCalls, sent } = makeBot(toEnglish);
		await bot.sendReturnMessages(
			new ReturnMessage({ chatId: CHAT_ID, content: "Jogador único lote-d" }),
			group
		);
		assert.strictEqual(llmCalls.length, 1);
		assert.strictEqual(llmCalls[0], "Jogador único lote-d", "Parte única vai sem marcadores");
		assert.strictEqual(sent[0].content, "Player único lote-d");
		console.log("✓ Mensagem única mantém a chamada de antes, sem marcadores.");
	}

	{
		const { bot, llmCalls, sent } = makeBot(toEnglish);
		const parts = Array.from(
			{ length: 3 },
			(_, i) =>
				new ReturnMessage({
					chatId: CHAT_ID,
					content: `Jogador ${i + 1} lote-f ${"x".repeat(5000)}`
				})
		);
		const originals = parts.map((m) => m.content);
		await bot.sendReturnMessages(parts, group);
		assert.strictEqual(
			llmCalls.length,
			2,
			`3 partes de 5000 chars devem caber em 2 lotes, foram ${llmCalls.length}`
		);
		assert(
			llmCalls.every((p) => p.length <= 12100),
			"Nenhum lote pode passar do orçamento de caracteres"
		);
		sent.forEach((s, i) => assert.strictEqual(s.content, toEnglish(originals[i])));
		console.log("✓ Partes grandes são agrupadas em lotes de até 12000 caracteres.");
	}

	{
		const { bot, llmCalls } = makeBot(toEnglish);
		await bot.sendReturnMessages(makeParts("lote-e", 3), { id: CHAT_ID });
		assert.strictEqual(llmCalls.length, 0, "Grupo sem autoTranslateTo não chama o LLM");
		console.log("✓ Grupo sem autoTranslateTo não chama o LLM.");
	}

	console.log("\n=== Todos os testes de tradução em lote passaram! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes de tradução em lote:", err);
		process.exit(1);
	});
