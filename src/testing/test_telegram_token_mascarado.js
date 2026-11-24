process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.DEBUG = "false";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:43974";
process.env.OTEL_LOG_LEVEL = "none";
require("../telemetry/otel");

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const axios = require("axios");

const Logger = require("../utils/Logger");
const telemetry = require("../telemetry");
const TelegramBot = require("../TelegramBot");
const { fetchUserProfilePictureMedia } = require("../utils/ProfilePictureHelper");

const SECRET = "AAFicticio_Para-TesteAbCdEfGhIjKlMn";
const TOKEN = `123456789:${SECRET}`;
const MASKED = "123456789:***";
const WEBHOOK_PORT = 43975;
const CLOSED_PORT_URL = "http://127.0.0.1:1";
const LOG_DIR = path.join(__dirname, "../../logs");
const LOGGER_NAME = `teste-mascara-${process.pid}`;

const consoleMethods = ["log", "warn", "error"];
const realConsole = Object.fromEntries(consoleMethods.map((m) => [m, console[m]]));
const lines = [];

const readLogFiles = () =>
	fs
		.readdirSync(LOG_DIR)
		.filter((file) => file.includes(`-${process.pid}.log`))
		.map((file) => path.join(LOG_DIR, file));

async function logged(action) {
	lines.length = 0;
	const files = () => readLogFiles().map((file) => fs.readFileSync(file, "utf8"));
	const sizeBefore = files().join("").length;
	for (const m of consoleMethods) console[m] = (...args) => lines.push(args.join(" "));
	try {
		await action();
		await new Promise((resolve) => setTimeout(resolve, 400));
	} finally {
		Object.assign(console, realConsole);
	}
	const fileText = files().join("");
	assert.ok(fileText.length > sizeBefore, "o arquivo de log deve receber a linha");
	return { consoleText: lines.join("\n"), fileText };
}

async function assertMasked(action) {
	const { consoleText, fileText } = await logged(action);
	assert.ok(!consoleText.includes(SECRET), "console com o segredo");
	assert.ok(!fileText.includes(SECRET), "arquivo com o segredo");
	assert.ok(consoleText.includes(MASKED), "o restante do log deve continuar");
}

const failure = async (promise) => {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("a chamada deveria falhar");
};

async function listen(server, port = 0) {
	await new Promise((resolve, reject) =>
		server.once("error", reject).listen(port, "127.0.0.1", resolve)
	);
	return `http://127.0.0.1:${server.address().port}`;
}

function buildBot(apiUrl, options = {}) {
	const bot = new TelegramBot({
		id: String(process.pid),
		telegramBotToken: TOKEN,
		eventHandler: { onConnected() {}, onDisconnected() {} },
		...options
	});
	bot.apiClient.bot.options.baseApiUrl = apiUrl;
	bot.registerCommands = async () => {};
	bot._startPollingLoop = () => {};
	bot._startWebhookMonitor = () => {};
	return bot;
}

const COMMON_LOGS = [
	"5511999990001:12@s.whatsapp.net",
	"5511999990001:3@s.whatsapp.net enviou para 120363000000000099@g.us",
	"lid 100000000000001:27@lid",
	"grupo -1001234567890: mensagem recebida",
	"chat -1001234567890:AAAAAAAA",
	"2026-11-24T12:34:56.789Z e 12:34:56",
	"http://192.168.100.200:9005/webhook e ws://ravena-ai:5000/x",
	"/app/src/index.js:123456:20",
	"1732470000:d41d8cd98f00b204e9800998ecf8427e",
	"1732470000:DA39A3EE5E6B4B0D3255BFEF95601890AFD80709",
	"1732470000:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	"5511999990001:123e4567-e89b-12d3-a456-426614174000",
	"5511999990001:3EB0123456789ABCDEF0123456789ABCDEF01234",
	"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	"fazenda:5511999990001:colheita_diaria",
	"Bot ID: 123456789, Username: @ravena"
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const collected = [];
const collector = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		collected.push({ url: req.url, body: Buffer.concat(chunks).toString("latin1") });
		res.end();
	});
});

const telegram = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		const method = req.url.split("/").pop();
		if (method === "sendMessage") {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request" }));
		} else if (method === "getChat") {
			res.writeHead(502, { "Content-Type": "text/html" });
			res.end(`<html>${req.url}</html>`);
		} else {
			const results = { getMe: { id: 1, username: "ficticio" }, getFile: { file_path: "a.jpg" } };
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, result: results[method] ?? true }));
		}
	});
});

async function defineTests(apiUrl) {
	const logger = new Logger(LOGGER_NAME);
	const { bot: api } = buildBot(apiUrl).apiClient;
	const offline = buildBot(CLOSED_PORT_URL).apiClient.bot;

	const axiosError = await failure(axios.get(`${CLOSED_PORT_URL}/file/bot${TOKEN}/a.jpg`));
	const networkError = await failure(offline.sendMessage(1, "oi"));
	const refusal = await failure(api.sendMessage(1, "oi"));
	const htmlError = await failure(api.getChat(1));
	const fileLink = await api.getFileLink("arquivo");
	assert.ok(fileLink.includes(SECRET));

	const values = {
		"erro do axios": axiosError,
		"config do axios": axiosError.config,
		"request do axios": axiosError.request,
		"erro com cause": new Error("falhou", { cause: axiosError }),
		AggregateError: new AggregateError([axiosError], "falhou"),
		"objeto com erro dentro": { erro: axiosError },
		"erro de rede da biblioteca do Telegram": networkError,
		"recusa do Telegram": refusal,
		"resposta HTML do Telegram": htmlError,
		"stack em texto": htmlError.stack,
		"retorno de getFileLink": fileLink
	};
	for (const [name, value] of Object.entries(values)) {
		test(`dado do log: ${name}`, () => assertMasked(() => logger.error("falhou", value)));
	}

	const sendUrl = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
	const messages = {
		"URL de método": sendUrl,
		"URL de arquivo": `https://api.telegram.org/file/bot${TOKEN}/a.jpg`,
		"URL codificada": encodeURIComponent(sendUrl),
		"URL codificada duas vezes": encodeURIComponent(encodeURIComponent(sendUrl)),
		"URL codificada em minúsculas": encodeURIComponent(sendUrl).toLowerCase(),
		"token solto": `token ${TOKEN}.`,
		"dois tokens": `${TOKEN} ${TOKEN}`
	};
	for (const [name, message] of Object.entries(messages)) {
		test(`mensagem: ${name}`, async () => {
			const { consoleText, fileText } = await logged(() => logger.info(message));
			for (const text of [consoleText, fileText]) {
				assert.ok(!text.toLowerCase().includes(SECRET.toLowerCase()), "log com o segredo");
			}
			assert.ok(consoleText.includes("***"), "o restante do log deve continuar");
		});
	}
	test("mensagem: URL mascarada continua legível", async () => {
		const { consoleText } = await logged(() => logger.info(sendUrl));
		assert.ok(
			consoleText.endsWith(`https://api.telegram.org/bot${MASKED}/sendMessage`),
			consoleText
		);
	});

	test("logs comuns não mudam", async () => {
		for (const text of COMMON_LOGS) {
			const { consoleText } = await logged(() => logger.info(text));
			assert.ok(consoleText.endsWith(` ${text}`), consoleText);
		}
	});

	test("bot: início com webhook", () =>
		assertMasked(async () => {
			const bot = buildBot(apiUrl, { webhookHost: "exemplo.test", webhookPort: WEBHOOK_PORT });
			await bot.initialize();
			bot.webhookServer.close();
		}));
	test("bot: falha de rede ao cair para polling", () =>
		assertMasked(() => buildBot(CLOSED_PORT_URL)._fallbackToPolling()));
	test("bot: falha ao baixar a foto de perfil", async () => {
		const bot = buildBot(apiUrl);
		bot.getProfilePictureUrl = async () => `${CLOSED_PORT_URL}/file/bot${TOKEN}/a.jpg`;
		const { consoleText } = await logged(async () => {
			await fetchUserProfilePictureMedia(bot, "987654321");
			logger.info("fim");
		});
		assert.ok(/Falha ao baixar buffer da imagem/.test(consoleText));
		assert.ok(!consoleText.includes(SECRET), "console com o segredo");
	});

	test("webhook: só o caminho com o token do bot entrega atualizações", async () => {
		const bot = buildBot(apiUrl, { webhookHost: "exemplo.test", webhookPort: WEBHOOK_PORT });
		const updates = [];
		bot._processUpdate = (update) => updates.push(update.update_id);
		await logged(() => bot.initialize());
		const post = async (token, update_id) =>
			(
				await axios.post(
					`http://127.0.0.1:${WEBHOOK_PORT}/webhook/telegram/${token}`,
					{ update_id },
					{ validateStatus: () => true }
				)
			).status;
		assert.strictEqual(await post(TOKEN, 1), 200);
		assert.strictEqual(await post(encodeURIComponent(TOKEN), 2), 200);
		assert.strictEqual(await post("123456789:OUTRO", 3), 404);
		assert.strictEqual(await post("outro", 4), 404);
		assert.deepStrictEqual(updates, [1, 2]);
		bot.webhookServer.close();
	});

	test("telemetria: spans e métricas saem sem o segredo", async () => {
		await telemetry.withSpan("teste saida", {}, async () => {
			await axios.get(`${apiUrl}/bot${TOKEN}/getMe`);
			await axios.get(`${apiUrl}/webhook/telegram/${TOKEN}`);
			await api.getMe();
			await (await fetch(`${apiUrl}/file/bot${TOKEN}/a.jpg`)).text();
			await (await fetch(`${apiUrl}/webhook/telegram/${TOKEN}`)).text();
		});
		await failure(
			telemetry.withSpan("teste excecao", {}, async () => {
				throw htmlError;
			})
		);
		await globalThis.__RAVENA_OTEL_SHUTDOWN();
		const sent = (signal) =>
			collected
				.filter((c) => c.url.endsWith(signal))
				.map((c) => c.body)
				.join("");
		const traces = sent("/v1/traces");
		const metrics = sent("/v1/metrics");
		for (const expected of ["teste saida", "teste excecao", "EPARSE", "Error parsing response"])
			assert.ok(traces.includes(expected), `falta ${expected}`);
		for (const text of [traces, metrics]) {
			assert.ok(text.includes("/webhook/telegram/"));
			const at = text.indexOf(SECRET);
			assert.strictEqual(at, -1, JSON.stringify(text.slice(Math.max(0, at - 60), at + 6)));
		}
	});
}

async function main() {
	await listen(collector, 43974);
	await defineTests(await listen(telegram));
	let failed = 0;
	for (const { name, fn } of tests) {
		try {
			await fn();
			console.log(`ok     ${name}`);
		} catch (error) {
			failed++;
			console.log(`FALHA  ${name}: ${error.message.split("\n")[0]}`);
		}
	}
	for (const file of readLogFiles()) fs.unlinkSync(file);
	console.log(`${tests.length - failed}/${tests.length} testes passaram`);
	return failed;
}

main()
	.then((failed) => process.exit(failed ? 1 : 0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
