process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const {
	formatWhatsAppToTelegram,
	stripHtml,
	balanceHtmlTags
} = require("../utils/TelegramMarkupHelper");
const FakeBot = require("./FakeBot");

async function runTests() {
	console.log("=== INICIANDO SUÍTE DE TESTES: TELEGRAM MARKUP HELPER ===");

	// ─── 1. TESTE BÁSICO: NEGRITO, ITÁLICO E TACHADO ───────────────────────────────
	console.log("\n[1] Testando formatações básicas (*negrito*, _itálico_, ~tachado~)...");
	{
		const input = "Texto com *negrito*, _itálico_ e ~tachado~.";
		const expected = "Texto com <b>negrito</b>, <i>itálico</i> e <s>tachado</s>.";
		const result = formatWhatsAppToTelegram(input);
		assert.strictEqual(result, expected, "Deve converter negrito, itálico e tachado corretamente");
		console.log("✓ Negrito, itálico e tachado convertidos.");
	}

	// ─── 2. TESTE: MONOSPACE INLINE E BLOCO PREFORMATADO ──────────────────────────
	console.log("\n[2] Testando monospace inline (`code`) e blocos (```pre```)...");
	{
		const input =
			"Copie o comando `!faz-plantar 1` ou veja o código:\n```js\nconst x = 10 * 2;\n```";
		const result = formatWhatsAppToTelegram(input);

		assert.ok(
			result.includes("<code>/faz_plantar 1</code>"),
			"Inline code deve virar <code> e converter comando para /faz_plantar"
		);
		assert.ok(
			result.includes('<pre><code class="language-js">const x = 10 * 2;\n</code></pre>') ||
				result.includes("<pre>const x = 10 * 2;\n</pre>"),
			"Bloco de código deve virar <pre> sem sofrer conversão de asteriscos em negrito"
		);
		assert.ok(
			!result.includes("<b>"),
			"Asteriscos dentro do bloco de código NÃO devem virar negrito"
		);
		console.log("✓ Monospace e blocos de código protegidos e convertidos com sucesso.");
	}

	// ─── 3. TESTE: CITAÇÃO / QUOTES (> texto) ────────────────────────────────────
	console.log("\n[3] Testando citação / quotes (> texto) em <blockquote>...");
	{
		const singleQuote = "Mensagem normal\n> Frase final importante";
		const resSingle = formatWhatsAppToTelegram(singleQuote);
		assert.ok(
			resSingle.includes("<blockquote>Frase final importante</blockquote>"),
			"Linha com > deve virar <blockquote>"
		);

		const multiQuote = "Mensagem:\n> Linha 1 de aviso\n> Linha 2 de aviso\nContinuação fora";
		const resMulti = formatWhatsAppToTelegram(multiQuote);
		assert.ok(
			resMulti.includes("<blockquote>Linha 1 de aviso\nLinha 2 de aviso</blockquote>"),
			"Linhas consecutivas com > devem ser agrupadas em um único <blockquote>"
		);
		console.log("✓ Citações/quotes agrupadas e convertidas para <blockquote>.");
	}

	// ─── 4. TESTE: ROLETA RUSSA COM QUOTE E ITÁLICO ──────────────────────────────
	console.log("\n[4] Testando mensagem de morte da Roleta Russa...");
	{
		const roletaMsg =
			"💥🔫 *BANG* - *F no chat* Morreu em 3.\n\n> _Malandro é o pato, que já nasce com os dedos colados pra não usar aliança._";
		const result = formatWhatsAppToTelegram(roletaMsg);

		assert.ok(result.includes("<b>BANG</b>"), "Deve ter BANG em negrito");
		assert.ok(result.includes("<b>F no chat</b>"), "Deve ter F no chat em negrito");
		assert.ok(
			result.includes(
				"<blockquote><i>Malandro é o pato, que já nasce com os dedos colados pra não usar aliança.</i></blockquote>"
			),
			"Quote com itálico deve ser <blockquote><i>...</i></blockquote>"
		);
		console.log("✓ Mensagem da roleta russa convertida perfeitamente.");
	}

	// ─── 5. TESTE: MOCHILA DA FAZENDA (FAZ-INV) ──────────────────────────────────
	console.log("\n[5] Testando mensagem da Mochila da Fazenda (!faz-inv)...");
	{
		const mochilaMsg =
			"🎒 *MOCHILA DO JARDIM* 🎒\n\n" +
			"🌱 *Sementes:*\n" +
			"• [1] Trigo: *2x*\n" +
			"• [2] Tomate: *5x*\n\n" +
			"💡 *Ações:* `!faz-plantar`, `!faz-usar`, `!faz-vender`, `!faz-decorar`";

		const result = formatWhatsAppToTelegram(mochilaMsg);

		assert.ok(result.includes("🎒 <b>MOCHILA DO JARDIM</b> 🎒"), "Título em negrito");
		assert.ok(result.includes("🌱 <b>Sementes:</b>"), "Sementes em negrito");
		assert.ok(result.includes("• [1] Trigo: <b>2x</b>"), "Quantidade em negrito");
		assert.ok(
			result.includes("<code>/faz_plantar</code>"),
			"Comandos nas ações devem virar <code>/faz_plantar</code> clicável/copiável"
		);
		assert.ok(
			result.includes("<code>/faz_usar</code>"),
			"Comandos nas ações devem virar <code>/faz_usar</code> clicável/copiável"
		);
		console.log("✓ Mensagem da mochila da fazenda formatada sem asteriscos ou crases crus.");
	}

	// ─── 6. TESTE: INÍCIO DO /CMD (QUOTE NO TOPO E LINK DIRETO) ───────────────────
	console.log("\n[6] Testando início de !cmd (quote de grupo e links)...");
	{
		const cmdMsg =
			"🤖 *Comandos Ravenabot*🐦‍⬛\n" +
			"> _Grupo grupaoRavenabot_\n" +
			"_Veja melhor a lista em:_\n" +
			"🔗 https://ravena.moothz.com/cmd";

		const result = formatWhatsAppToTelegram(cmdMsg);

		assert.ok(result.includes("🤖 <b>Comandos Ravenabot</b>🐦‍⬛"), "Título em negrito");
		assert.ok(
			result.includes("<blockquote><i>Grupo grupaoRavenabot</i></blockquote>"),
			"Cabeçalho com > _Grupo X_ deve virar <blockquote><i>Grupo grupaoRavenabot</i></blockquote>"
		);
		assert.ok(result.includes("<i>Veja melhor a lista em:</i>"), "Itálico antes da URL");
		assert.ok(
			result.includes('<a href="https://ravena.moothz.com/cmd">Link Direto</a>'),
			"URL no final deve virar Link Direto"
		);
		console.log("✓ Início do /cmd formatado com quote suave e link clicável.");
	}

	// ─── 7. TESTE: PROTEÇÃO DE UNDERSCORES EM COMANDOS E IDENTIFICADORES ─────────
	console.log("\n[7] Testando que underscores em comandos não viram itálico indevido...");
	{
		const input = "Use /faz_plantar e depois /faz_colher para jogar.";
		const result = formatWhatsAppToTelegram(input);

		assert.ok(
			!result.includes("<i>"),
			"Underscores em comandos como /faz_plantar e /faz_colher NÃO devem virar itálico"
		);
		assert.ok(result.includes("/faz_plantar"), "Deve manter /faz_plantar");
		assert.ok(result.includes("/faz_colher"), "Deve manter /faz_colher");
		console.log("✓ Proteção de identificadores com underscore validada.");
	}

	// ─── 8. TESTE: BALANCEAMENTO DE TAGS HTML ÓRFÃS ──────────────────────────────
	console.log("\n[8] Testando balanceHtmlTags para evitar erro 400 no Telegram...");
	{
		const unbalanced = "<b>Texto em negrito sem fechar";
		const balanced = balanceHtmlTags(unbalanced);
		assert.strictEqual(
			balanced,
			"<b>Texto em negrito sem fechar</b>",
			"Deve fechar automaticamente a tag <b> órfã"
		);

		const unb2 = "<blockquote><i>Citação sem fechar";
		const bal2 = balanceHtmlTags(unb2);
		assert.strictEqual(
			bal2,
			"<blockquote><i>Citação sem fechar</i></blockquote>",
			"Deve fechar tags aninhadas na ordem correta"
		);
		console.log("✓ Balanceador automático de tags HTML validado.");
	}

	// ─── 9. TESTE: FALLBACK NO TELEGRAMBOT CASO OCORRA ERRO DE ENTIDADE ───────────
	console.log("\n[9] Testando fallback de segurança no TelegramBot para erro de entidade...");
	{
		const TelegramBot = require("../TelegramBot");
		const tgBot = new TelegramBot({
			id: "tg_test",
			token: "dummy"
		});
		tgBot.isConnected = true;

		let sentWithParseMode = null;
		let fallbackTriggered = false;

		tgBot.apiClient = {
			sendMessage: async (chatId, text, options) => {
				sentWithParseMode = options.parse_mode;
				if (options.parse_mode === "HTML" && text.includes("FORCAR_ERRO")) {
					throw new Error("ETELEGRAM: 400 Bad Request: can't parse entities in message text");
				}
				if (!options.parse_mode) {
					fallbackTriggered = true;
				}
				return {
					chat: { id: chatId },
					from: { id: "bot" },
					message_id: 1234
				};
			}
		};

		// Envio com simulação de erro de entidade
		const sentMsg = await tgBot.sendMessage("-100123", "*Texto* FORCAR_ERRO <tag_invalida>");
		assert.ok(sentMsg, "A mensagem deve ser entregue mesmo com erro de entidade");
		assert.strictEqual(fallbackTriggered, true, "Fallback sem parse_mode deve ser disparado");
		console.log("✓ Fallback de segurança para texto puro funcionando perfeitamente.");
	}

	console.log("\n========================================================");
	console.log("✓ TODOS OS 9 TESTES DE MARKUP PASSARAM COM SUCESSO (100% OK)!");
	console.log("========================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHA NOS TESTES DE MARKUP:", err);
		process.exit(1);
	});
