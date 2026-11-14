/**
 * otel_traffic.js
 *
 * Gera tráfego de negócio realista (com usuários e grupos FALSOS) para validar a telemetria
 * OpenTelemetry sem usar o Telegram/WhatsApp de verdade. Passa pelo pipeline completo
 * (EventHandler.onMessage → CommandHandler → serviços → waifuletes / Jardim das Sombras / LLM).
 *
 * Uso (dentro do container, com OTEL_EXPORTER_OTLP_ENDPOINT definido no .env):
 *   docker compose exec ravena-ai node --require ./src/telemetry/otel.js src/testing/otel_traffic.js [rodadas] [--sem-llm]
 *
 * As respostas ficam só na memória do FakeBot (nada é enviado a terceiros). Os comandos de jogo
 * alteram os bancos LOCAIS do waifuletes/Jardim para os usuários falsos 55119000000xx.
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");

const rounds = Number(process.argv[2] || 1);
const withLLM = !process.argv.includes("--sem-llm");

const COMMANDS = [
	"!ping",
	"!mu-roll",
	"!mu-roll",
	"!mu-casar",
	"!mu-daily",
	"!fazenda",
	"!faz-loja",
	"!faz-inventario",
	"!faz-colher",
	"!faz-plantar trigo",
	"!banco",
	"!banco-extrato",
	"!comando-que-nao-existe"
];
if (withLLM) COMMANDS.push("!ai responda apenas com a palavra ok");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const bot = new FakeBot({ id: "otel-traffic", useTelegram: true });
	const eventHandler = new EventHandler();
	await eventHandler.commandHandler.fixedCommands.loadCommands();

	for (let r = 0; r < rounds; r++) {
		for (let u = 0; u < 3; u++) {
			const author = `55119000000${String(10 + u)}@s.whatsapp.net`;
			const group = u === 2 ? null : "120363000000999@g.us";
			for (const content of COMMANDS) {
				bot.resetCapture?.();
				// debounce anti-spam do CommandHandler é por usuário: limpa para não virar "spam"
				eventHandler.commandHandler.userDebounceMap?.clear();
				const msg = createMessage({ content, author, group, platform: "telegram" });
				msg.platform = "telegram";
				msg.timestamp = Math.round(Date.now() / 1000);
				eventHandler.onMessage(bot, msg);
				await sleep(content.startsWith("!ai") ? 8000 : 1500);
			}
		}
		// Um caso de debounce de propósito (dois comandos colados do mesmo usuário)
		const spam = "5511900000099@s.whatsapp.net";
		eventHandler.onMessage(bot, createMessage({ content: "!ping", author: spam, group: "120363000000999@g.us" }));
		eventHandler.onMessage(bot, createMessage({ content: "!ping", author: spam, group: "120363000000999@g.us" }));
		await sleep(1500);
		console.log(`[otel_traffic] rodada ${r + 1}/${rounds} concluída`);
	}

	if (globalThis.__RAVENA_OTEL_SHUTDOWN) await globalThis.__RAVENA_OTEL_SHUTDOWN();
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
