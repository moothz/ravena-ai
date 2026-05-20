/**
 * TestRunner.js
 *
 * Executor de testes para o harness do bot.
 *
 * Uso:
 *   const runner = new TestRunner({ groupId: "120363...@g.us", author: "5511...@s.whatsapp.net" });
 *   runner.run("!yt busca", () => msgTexto("!yt receita pudim"));
 *   await runner.runAll();
 */

const Logger = require("../utils/Logger");
const { setDefaults } = require("./helpers");

// Tempo máximo por teste (ms) antes de considerar timeout
const TEST_TIMEOUT_MS = 30000;

// Tempo para aguardar promises assíncronas disparadas pelo pipeline (ms)
// O pipeline usa .catch() sem await em alguns lugares — precisamos de um pequeno delay
const ASYNC_SETTLE_MS = 3000;

class TestRunner {
	/**
	 * @param {Object} opts
	 * @param {string} opts.groupId    - ID do grupo padrão nos testes
	 * @param {string} [opts.author]   - Número do autor padrão
	 * @param {string} [opts.authorName] - Nome do autor padrão
	 * @param {boolean} [opts.verbose] - Exibe JSON completo das ReturnMessages
	 */
	constructor(opts = {}) {
		this.groupId = opts.groupId ?? null;
		this.author = opts.author ?? "5511999999999@s.whatsapp.net";
		this.authorName = opts.authorName ?? "Testador";
		this.verbose = opts.verbose ?? true;
		this.tests = [];
		this.results = [];
		this.logger = new Logger("test-runner");

		// Aplica defaults nos helpers
		setDefaults({
			groupId: this.groupId,
			author: this.author,
			authorName: this.authorName
		});
	}

	/**
	 * Registra um teste.
	 * @param {string} label    - Nome/descrição do teste
	 * @param {Function} msgFn  - Função que retorna um objeto message (pode ser async)
	 * @param {Object} [opts]   - Opções específicas do teste (ex: { expectedMessages: 2, timeout: 60000 })
	 */
	run(label, msgFn, opts = {}) {
		this.tests.push({ label, msgFn, opts });
	}

	/**
	 * Executa todos os testes registrados em sequência.
	 * Ao final, fecha conexões do banco e encerra o processo.
	 */
	async runAll() {
		// Inicializa FakeBot e EventHandler uma única vez para todos os testes
		const FakeBot = require("./FakeBot");
		const EventHandler = require("../EventHandler");

		const bot = new FakeBot({ id: "bot-teste", prefix: "!" });

		this._printHeader();

		// Aguarda EventHandler carregar grupos e comandos do banco
		const eventHandler = EventHandler.getInstance();
		await this._sleep(1500); // Pequena espera para loadGroups() completar

		for (const test of this.tests) {
			const result = await this._executeTest(test, bot, eventHandler);
			this.results.push(result);
		}

		this._printReport();
		await this._cleanup();
	}

	// ---------------------------------------------------------------------------
	// Internos
	// ---------------------------------------------------------------------------

	async _executeTest(test, bot, eventHandler) {
		const { label, msgFn, opts = {} } = test;
		const startTime = Date.now();

		this._printDivider(label);

		let message;
		try {
			message = await Promise.resolve(msgFn());
		} catch (err) {
			this._printError("Erro ao construir mensagem:", err);
			return { label, status: "ERROR", error: err.message, durationMs: Date.now() - startTime };
		}

		// Exibe o input enviado
		this._printInput(message);

		// Reseta mensagens capturadas antes de cada teste
		bot.resetCapture();

		let status = "OK";
		let error = null;

		try {
			// Executa o processMessage (não-bloqueante na maioria das vezes, mas retorna Promise)
			const processPromise = eventHandler.processMessage(bot, message);

			// Configura o timeout e polling de mensagens
			const expectedCount = opts.expectedMessages ?? 1;
			const timeoutMs = opts.timeout ?? (expectedCount > 1 ? 45000 : 3000);
			const checkInterval = 100;
			let elapsed = 0;

			// Espera até que a quantidade esperada de mensagens seja capturada
			// ou que estoure o timeout
			while (bot.capturedMessages.length < expectedCount && elapsed < timeoutMs) {
				await this._sleep(checkInterval);
				elapsed += checkInterval;
			}

			// Se nenhuma mensagem foi capturada após o timeout
			if (bot.capturedMessages.length === 0 && expectedCount > 0) {
				status = "TIMEOUT";
				error = `Nenhuma mensagem capturada em ${timeoutMs / 1000}s`;
			}

			// Aguarda resolução final por garantia com timeout curto
			await Promise.race([processPromise, this._sleep(500)]);
		} catch (err) {
			status = "ERROR";
			error = err.message;
			this._printError("Erro no pipeline:", err);
		}

		const durationMs = Date.now() - startTime;

		// Exibe as ReturnMessages capturadas
		this._printOutput(bot.capturedMessages, durationMs, status);

		return { label, status, error, capturedCount: bot.capturedMessages.length, durationMs };
	}

	_printHeader() {
		const line = "═".repeat(60);
		console.log(`\n${line}`);
		console.log("  🤖 RAVENA BOT — TEST RUNNER");
		console.log(`  Grupo: ${this.groupId ?? "(privado)"}`);
		console.log(`  Autor: ${this.author}`);
		console.log(`  Testes: ${this.tests.length}`);
		console.log(`${line}\n`);
	}

	_printDivider(label) {
		console.log(`\n${"─".repeat(60)}`);
		console.log(`  📋 TESTE: ${label}`);
		console.log("─".repeat(60));
	}

	_printInput(message) {
		console.log("\n📨 INPUT:");
		const summary = {
			type: message.type,
			group: message.group ?? "(privado)",
			author: message.author,
			content:
				message.type === "text"
					? message.content
					: `[${message.type}] legenda: ${message.caption ?? ""}`,
			hasQuotedMsg: message.hasQuotedMsg ?? false
		};
		console.log(JSON.stringify(summary, null, 2));
	}

	_printOutput(captured, durationMs, status) {
		const icon = status === "OK" ? "✅" : status === "TIMEOUT" ? "⏱️" : "❌";
		console.log(`\n📤 OUTPUT (${captured.length} ReturnMessage(s)) ${icon} [${durationMs}ms]:`);

		if (captured.length === 0) {
			console.log("  (nenhuma mensagem capturada)");
			return;
		}

		captured.forEach((msg, i) => {
			console.log(`\n  [${i + 1}] chatId: ${msg.chatId}`);

			let mediaInfo = null;
			if (msg.content && typeof msg.content === "object" && msg.content.isMessageMedia) {
				mediaInfo = msg.content;
			} else if (msg.options && msg.options.media) {
				mediaInfo = msg.options.media;
			}

			if (typeof msg.content === "string") {
				// Texto — exibe direto
				const preview =
					msg.content.length > 300 ? msg.content.substring(0, 300) + "...[truncado]" : msg.content;
				console.log(`       content: ${preview}`);
			}

			if (mediaInfo) {
				const sizeFmt = mediaInfo.size
					? `${Math.round(mediaInfo.size / 1024)} KB`
					: mediaInfo.data
						? `${Math.round((mediaInfo.data.length * 0.75) / 1024)} KB`
						: "desconhecido";
				console.log(`       media:`);
				console.log(`         - arquivo:  ${mediaInfo.filename ?? "desconhecido"}`);
				console.log(`         - mimetype: ${mediaInfo.mimetype ?? "desconhecido"}`);
				console.log(`         - tamanho:  ${sizeFmt}`);
				console.log(`         - url:      ${mediaInfo.url ?? "nenhuma"}`);
			}

			if (msg.reaction) console.log(`       reaction: ${msg.reaction}`);
			if (msg.delay) console.log(`       delay: ${msg.delay}ms`);
			if (msg.options?.caption) console.log(`       caption: ${msg.options.caption}`);
			if (msg.options?.sendMediaAsSticker) console.log(`       sticker: true`);
			if (msg.options?.sendAudioAsVoice) console.log(`       voice: true`);

			if (this.verbose) {
				// Exibe JSON completo (sem o data base64 para não poluir)
				const verboseMsg = JSON.parse(
					JSON.stringify(msg, (key, val) =>
						key === "data" && typeof val === "string" && val.length > 100
							? `[base64 ${Math.round((val.length * 0.75) / 1024)}KB]`
							: val
					)
				);
				console.log(
					"       JSON completo:",
					JSON.stringify(verboseMsg, null, 6)
						.split("\n")
						.map((l) => "  " + l)
						.join("\n")
				);
			}
		});
	}

	_printError(msg, err) {
		console.error(`\n❌ ${msg}`);
		console.error(err.stack ?? err.message ?? err);
	}

	_printReport() {
		const line = "═".repeat(60);
		const ok = this.results.filter((r) => r.status === "OK").length;
		const errors = this.results.filter((r) => r.status === "ERROR").length;
		const timeouts = this.results.filter((r) => r.status === "TIMEOUT").length;

		console.log(`\n${line}`);
		console.log("  📊 RELATÓRIO FINAL");
		console.log(line);
		console.log(`  Total:    ${this.results.length}`);
		console.log(`  ✅ OK:      ${ok}`);
		if (errors > 0) console.log(`  ❌ Erro:    ${errors}`);
		if (timeouts > 0) console.log(`  ⏱️  Timeout: ${timeouts}`);
		console.log();

		this.results.forEach((r) => {
			const icon = r.status === "OK" ? "✅" : r.status === "TIMEOUT" ? "⏱️ " : "❌";
			const msgs = r.capturedCount !== undefined ? ` (${r.capturedCount} msg)` : "";
			const time = r.durationMs ? ` [${r.durationMs}ms]` : "";
			console.log(`  ${icon} ${r.label}${msgs}${time}`);
			if (r.error) console.log(`      └─ ${r.error}`);
		});

		console.log(`\n${line}\n`);
	}

	async _cleanup() {
		// Fecha todas as conexões com o banco de dados
		try {
			const Database = require("../utils/Database");
			Database.getInstance().closeAll();
		} catch (e) {
			// ignora
		}

		// Safety: força saída após 2s caso algo ainda segure o event loop
		// (setInterval do backup, timers internos, etc.)
		const timer = setTimeout(() => {
			process.exit(0);
		}, 2000);
		timer.unref(); // Não impede saída limpa se o loop já estiver vazio

		process.exit(0);
	}

	_timeout(ms) {
		return new Promise((_, reject) => setTimeout(() => reject(new Error("TEST_TIMEOUT")), ms));
	}

	_sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

module.exports = TestRunner;
