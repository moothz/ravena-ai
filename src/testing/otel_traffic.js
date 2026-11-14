/**
 * otel_traffic.js
 *
 * Gera tráfego de negócio realista (com usuários e grupos FALSOS) para validar a telemetria
 * OpenTelemetry sem usar o Telegram/WhatsApp de verdade. Passa pelo pipeline completo
 * (EventHandler.onMessage → CommandHandler → serviços → waifuletes / Jardim das Sombras / LLM).
 *
 * Uso (dentro do container, com OTEL_EXPORTER_OTLP_ENDPOINT definido no .env):
 *   docker compose exec ravena-ai node --require ./src/telemetry/otel.js src/testing/otel_traffic.js [rodadas] [--com-ia]
 *
 * Por padrão NÃO dispara nada que chame serviços de IA/geração de imagem (LLM, bonsai): !ai e
 * !mu-casar (que gera a foto do casal) só entram com --com-ia, e nesse caso uma única vez por
 * execução (são serviços remotos de terceiros; não use para volume).
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
const withAI = process.argv.includes("--com-ia");

const COMMANDS = [
	"!ping",
	"!mu-roll",
	"!mu-roll",
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
// Comandos que chamam IA remota: no máximo uma vez por execução, e só com --com-ia
const AI_COMMANDS = withAI ? ["!mu-casar", "!ai responda apenas com a palavra ok"] : [];

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
				await sleep(1500);
			}
		}
		if (r === 0) {
			for (const content of AI_COMMANDS) {
				eventHandler.commandHandler.userDebounceMap?.clear();
				const msg = createMessage({ content, author: "5511900000010@s.whatsapp.net", group: "120363000000999@g.us" });
				msg.platform = "telegram";
				msg.timestamp = Math.round(Date.now() / 1000);
				eventHandler.onMessage(bot, msg);
				await sleep(10000);
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
