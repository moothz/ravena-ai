process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.DEBUG = "false";

const http = require("http");
const assert = require("assert");
const axios = require("axios");
const { context, trace } = require("@opentelemetry/api");
const { AsyncLocalStorageContextManager } = require("@opentelemetry/context-async-hooks");
const {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} = require("@opentelemetry/sdk-trace-base");

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const spanExporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
	new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] })
);

const TelegramNotificationService = require("../services/TelegramNotificationService");
const TelegramBot = require("../TelegramBot");

const TOKEN = "123456789:TOKEN-FICTICIO-PARA-TESTE";
const HORIZON_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 60;
const MAX_TIMER_MS = 2 ** 31 - 1;

const realSetTimeout = global.setTimeout;
const realSleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

const clock = {
	now: 0,
	frozen: true,
	onHorizon: () => {},
	reset() {
		this.now = 0;
		this.frozen = false;
		this.horizon = new Promise((resolve) => (this.onHorizon = resolve));
	}
};

const realDateNow = Date.now;
Date.now = () => realDateNow() + clock.now;

global.setTimeout = (fn, requestedMs, ...args) => {
	const caller = new Error().stack.split("\n")[2] || "";
	if (caller.includes("node_modules")) return realSetTimeout(fn, requestedMs, ...args);
	const ms = requestedMs >= 1 && requestedMs <= MAX_TIMER_MS ? requestedMs : 1;
	if (clock.frozen || clock.now + ms > HORIZON_MS) {
		clock.frozen = true;
		clock.onHorizon();
		return realSetTimeout(() => {}, 0);
	}
	clock.now += ms;
	return realSetTimeout(fn, 0, ...args);
};

const refused = (code, description, parameters) => ({
	status: code,
	body: { ok: false, error_code: code, description, parameters }
});
const rateLimited = (retryAfter) => refused(429, "Too Many Requests", { retry_after: retryAfter });
const NOT_FOUND = refused(404, "Not Found");
const UNAUTHORIZED = refused(401, "Unauthorized");
const CONFLICT = refused(
	409,
	"Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"
);
const WEBHOOK_ACTIVE = refused(
	409,
	"Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"
);
const BAD_GATEWAY = { status: 502, html: (url) => `<html>502 Bad Gateway ${url}</html>` };
const PROXY_404 = { status: 404, html: (url) => `<html>${url} not found</html>` };
const RESET = { reset: true };
const HANG = { hang: true };
const NO_ANSWER = { silent: true };
const OK = (result) => ({ status: 200, body: { ok: true, result } });
const UPDATE = OK([{ update_id: 7, callback_query: { id: "1", data: "noop" } }]);

async function startFakeTelegram(reply) {
	const state = {
		polls: [],
		getMeTimes: [],
		calls: { deleteWebhook: 0, getMe: 0 },
		webhookActive: false
	};
	state.hanging = new Promise((resolve) => (state.onHang = resolve));
	const server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const method = req.url.split("/").pop();
			let answer;
			if (method === "getUpdates") {
				answer = reply(state.polls.length, clock.now, state);
				state.polls.push(clock.now);
			} else {
				state.calls[method] = (state.calls[method] || 0) + 1;
				if (method === "deleteWebhook") state.webhookActive = false;
				if (method === "getMe") state.getMeTimes.push(clock.now);
				answer = reply(-1, clock.now, state, method) || OK(true);
			}
			if (answer.hang || state.polls.length + state.calls.getMe > MAX_REQUESTS) {
				return state.onHang();
			}
			if (answer.silent) return;
			if (answer.reset) return req.socket.destroy();
			res.writeHead(answer.status, {
				"Content-Type": answer.html ? "text/html" : "application/json"
			});
			res.end(answer.html ? answer.html(req.url) : JSON.stringify(answer.body));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, state, url: `http://127.0.0.1:${server.address().port}` };
}

let fakeUrl = null;
let requestTimeoutMs = null;
axios.interceptors.request.use((config) => {
	config.url = config.url.replace("https://api.telegram.org", fakeUrl);
	config.timeout = requestTimeoutMs ?? config.timeout;
	return config;
});

const LOOPS = {
	notifications(url, updates) {
		fakeUrl = url;
		const service = new TelegramNotificationService({ token: TOKEN, chatId: "-100", bots: [] });
		service.handleCallbackQuery = async (query) => updates.push(query.id);
		return {
			start() {
				delete process.env.DISABLE_ACTIVITY;
				service.startPolling();
				process.env.DISABLE_ACTIVITY = "true";
			},
			stop: () => service.stopPolling(),
			active: () => service.isPolling,
			events: []
		};
	},
	bot(url, updates) {
		const { bot, events } = buildBot(url, updates);
		return {
			start() {
				bot.isPolling = true;
				bot._onInstanceConnected();
				bot._startPollingLoop();
			},
			stop: () => (bot.isPolling = false),
			active: () => bot.isPolling,
			events
		};
	},
	inicialização(url, updates) {
		const { bot, events } = buildBot(url, updates);
		return {
			start: () => bot.initialize(),
			stop: () => (bot.isPolling = false),
			active: () => true,
			events
		};
	}
};

function buildBot(url, updates) {
	const events = [];
	const bot = new TelegramBot({
		id: "tg-teste",
		telegramBotToken: TOKEN,
		webhookHost: null,
		eventHandler: {
			onConnected: () => events.push("connected"),
			onDisconnected: (_bot, reason) => events.push(reason),
			commandHandler: null
		}
	});
	bot.apiClient.bot.options.baseApiUrl = url;
	bot._processUpdate = (update) => updates.push(update.callback_query.id);
	return { bot, events };
}

const consoleMethods = ["log", "info", "warn", "error"];
const realConsole = Object.fromEntries(consoleMethods.map((m) => [m, console[m]]));
function captureConsole(lines) {
	for (const m of consoleMethods) console[m] = (...args) => lines.push(args.join(" "));
}
function restoreConsole() {
	Object.assign(console, realConsole);
}

async function run(loopName, reply, { restartWith, timeoutMs = null } = {}) {
	const fake = await startFakeTelegram((n, now, state, method) =>
		(state.restarted ? restartWith : reply)(n, now, state, method)
	);
	const updates = [];
	const lines = [];
	spanExporter.reset();
	clock.reset();
	requestTimeoutMs = timeoutMs;
	captureConsole(lines);
	const loop = LOOPS[loopName](fake.url, updates);

	const settled = async () => {
		let quiet = 0;
		let seen = -1;
		while (quiet < 10) {
			await realSleep(20);
			const total = fake.state.polls.length + fake.state.calls.getMe + lines.length;
			quiet = total === seen ? quiet + 1 : 0;
			seen = total;
		}
	};
	const finished = async () => {
		await Promise.race([clock.horizon, fake.state.hanging, settled()]);
		await settled();
	};

	const caller = trace.getTracer("teste").startSpan("chamador");
	context.with(trace.setSpan(context.active(), caller), () => loop.start());
	await finished();
	const result = {
		polls: [...fake.state.polls],
		getMeTimes: [...fake.state.getMeTimes],
		calls: { ...fake.state.calls },
		stopped: !loop.active(),
		lines: [...lines]
	};
	if (restartWith) {
		fake.state.restarted = true;
		clock.reset();
		loop.start();
		await Promise.race([fake.state.hanging, realSleep(3000)]);
		await settled();
	}
	result.allLines = [...lines];
	result.events = [...loop.events];
	const spans = spanExporter.getFinishedSpans();
	result.spans = spans
		.filter((s) => s.name === "telegram polling.state")
		.map((s) => ({
			state: s.attributes["ravena.telegram.polling.state"],
			failure: s.attributes["ravena.telegram.polling.failure"],
			attempts: s.attributes["ravena.telegram.polling.attempts"],
			parent: s.parentSpanContext || s.parentSpanId
		}));
	result.rawSpans = JSON.stringify(
		spans.map((s) => [s.name, s.attributes, s.events, s.status, s.resource?.attributes])
	);
	loop.stop();
	clock.frozen = true;
	fake.server.closeAllConnections();
	await new Promise((resolve) => fake.server.close(resolve));
	await realSleep(50);
	restoreConsole();

	result.updates = updates;
	result.gaps = result.polls.slice(1).map((t, i) => t - result.polls[i]);
	return result;
}

const matching = (lines, regex) => lines.filter((line) => regex.test(line));
const STOP_NOTICE = /recusou o token/;
const FAILURE_LINE = /Falha na busca de atualizações/;
const RECOVERY_LINE = /voltou a responder/;

const problemLines = (lines) =>
	matching(lines, /\[(WARN|ERROR)\] \[(telegram-notifications|bot-telegram-tg-teste)\]/);

function assertRejected(r) {
	assert.ok(r.stopped, "o polling deve parar");
	assert.deepStrictEqual(r.polls, [0, 2000, 6000, 14000, 30000, 62000]);
	assert.strictEqual(matching(r.lines, STOP_NOTICE).length, 1, "um aviso de token recusado");
	assert.strictEqual(problemLines(r.lines).length, 1, "o aviso é a única linha de problema");
	assert.deepStrictEqual(
		r.spans.map((s) => [s.state, s.failure]),
		[["stopped", "token_rejected"]]
	);
}

function assertBackoff(r, failure) {
	assert.ok(!r.stopped, "o polling deve continuar");
	assert.ok(r.polls.length >= 5, `deve continuar tentando, fez ${r.polls.length}`);
	assert.ok(r.polls.length <= 20, `pedidos demais em 10 min: ${r.polls.length}`);
	assert.ok(r.gaps[3] >= 4 * r.gaps[0], `o intervalo deve crescer: ${r.gaps}`);
	assert.ok(Math.max(...r.gaps) <= 60000, `o intervalo deve ser limitado: ${r.gaps}`);
	assert.strictEqual(
		matching(r.lines, FAILURE_LINE).length,
		1,
		"uma linha por sequência de falhas"
	);
	assert.deepStrictEqual(
		r.spans.map((s) => [s.state, s.failure]),
		[["failing", failure]]
	);
}

function assertRecovered(r, failure) {
	assert.deepStrictEqual(r.updates, ["1"], "a atualização deve chegar depois da volta");
	assert.strictEqual(matching(r.lines, FAILURE_LINE).length, 1);
	assert.strictEqual(matching(r.lines, RECOVERY_LINE).length, 1, "uma linha de volta");
	assert.deepStrictEqual(
		r.spans.map((s) => [s.state, s.failure]),
		[
			["failing", failure],
			["recovered", failure]
		]
	);
}

const failThenRecover = (failure, times) => (n) =>
	n < 0 ? undefined : n < times ? failure : n === times ? UPDATE : HANG;
const failRecoverTwice = (failure, times) => (n) =>
	n < 0 ? undefined : n > 2 * times + 1 ? HANG : n % (times + 1) === times ? UPDATE : failure;
const always = (failure) => (n) => (n < 0 ? undefined : failure);
const rejectEverything = (failure) => () => failure;

const pollingScenarios = [
	{ name: "token com 404", reply: rejectEverything(NOT_FOUND), check: assertRejected },
	{ name: "token com 401", reply: rejectEverything(UNAUTHORIZED), check: assertRejected },
	{
		name: "401 isolado não para",
		reply: failThenRecover(UNAUTHORIZED, 1),
		check(r) {
			assert.ok(!r.stopped);
			assert.deepStrictEqual(r.updates, ["1"]);
			assert.strictEqual(problemLines(r.lines).length, 0);
		}
	},
	{
		name: "30 s de 401 e volta, duas vezes, não para",
		reply: failRecoverTwice(UNAUTHORIZED, 5),
		check(r) {
			assert.ok(!r.stopped, "o polling deve continuar");
			assert.deepStrictEqual(r.updates, ["1", "1"]);
			assert.strictEqual(problemLines(r.lines).length, 0);
			assert.deepStrictEqual(r.spans, []);
		}
	},
	{
		name: "401 intercalado com 409 não acumula",
		reply: (n) => (n < 0 ? undefined : n % 2 ? CONFLICT : UNAUTHORIZED),
		check: (r) => assertBackoff(r, "conflict")
	},
	{
		name: "404 de proxy não para",
		reply: always(PROXY_404),
		check: (r) => assertBackoff(r, "http_error")
	},
	{
		name: "409 outra instância",
		reply: always(CONFLICT),
		check(r) {
			assertBackoff(r, "conflict");
			assert.strictEqual(
				r.calls.deleteWebhook,
				this.loop === "notifications" ? 1 : 0,
				"outra instância não é motivo para remover o webhook"
			);
		}
	},
	{
		name: "409 e a outra instância sai",
		reply: failThenRecover(CONFLICT, 4),
		check: (r) => assertRecovered(r, "conflict")
	},
	...[45, 90].map((retryAfter) => ({
		name: `429 retry_after ${retryAfter}`,
		reply: failThenRecover(rateLimited(retryAfter), 2),
		check(r) {
			assert.deepStrictEqual(r.gaps.slice(0, 2), [retryAfter * 1000, retryAfter * 1000]);
			assertRecovered(r, "rate_limited");
		}
	})),
	{
		name: "429 retry_after não numérico",
		reply: failThenRecover(rateLimited("abc"), 3),
		check(r) {
			assert.deepStrictEqual(r.gaps.slice(0, 3), [2000, 4000, 8000]);
			assertRecovered(r, "rate_limited");
		}
	},
	{
		name: "429 retry_after acima do limite do setTimeout",
		reply: failThenRecover(rateLimited(MAX_TIMER_MS), 1),
		check: (r) => assert.strictEqual(r.polls.length, 1, `nova tentativa cedo demais: ${r.gaps}`)
	},
	{
		name: "description não string",
		reply: failThenRecover(refused(500, { texto: "x" }), 3),
		check: (r) => assertRecovered(r, "http_error")
	},
	{
		name: "502, volta, 502 de novo e volta",
		reply: failRecoverTwice(BAD_GATEWAY, 3),
		check(r) {
			assert.deepStrictEqual(r.updates, ["1", "1"]);
			assert.deepStrictEqual(r.gaps.slice(0, 3), [2000, 4000, 8000]);
			assert.deepStrictEqual(r.gaps.slice(4, 7), [2000, 4000, 8000]);
			assert.strictEqual(matching(r.lines, FAILURE_LINE).length, 2);
			assert.strictEqual(matching(r.lines, RECOVERY_LINE).length, 2);
			assert.deepStrictEqual(
				r.spans.map((s) => [s.state, s.attempts]),
				[
					["failing", 1],
					["recovered", 3],
					["failing", 1],
					["recovered", 3]
				]
			);
		}
	},
	{
		name: "502 constante",
		reply: always(BAD_GATEWAY),
		check: (r) => assertBackoff(r, "http_error")
	},
	{
		name: "502 e volta",
		reply: failThenRecover(BAD_GATEWAY, 6),
		check: (r) => assertRecovered(r, "http_error")
	},
	{ name: "rede fora", reply: always(RESET), check: (r) => assertBackoff(r, "network") },
	{
		name: "rede fora e volta",
		reply: failThenRecover(RESET, 6),
		check: (r) => assertRecovered(r, "network")
	}
];

const scenarios = [
	...["notifications", "bot"].flatMap((loop) => pollingScenarios.map((s) => ({ loop, ...s }))),
	{
		loop: "notifications",
		name: "409 webhook ativo",
		reply(n, _now, state, method) {
			if (method === "deleteWebhook") return OK(true);
			if (n === 0) state.webhookActive = true;
			if (state.webhookActive) return WEBHOOK_ACTIVE;
			return n === 1 ? UPDATE : HANG;
		},
		check(r) {
			assert.strictEqual(r.calls.deleteWebhook, 2, "deve remover o webhook ao ver o conflito");
			assertRecovered(r, "conflict");
		}
	},
	{
		loop: "notifications",
		name: "tempo esgotado",
		timeoutMs: 20,
		reply: always(NO_ANSWER),
		check(r) {
			assert.ok(!r.stopped);
			assert.ok(r.polls.length >= 5 && r.polls.length <= 20, `pedidos: ${r.polls.length}`);
			assert.ok(Math.max(...r.gaps) <= 60000);
			assert.strictEqual(problemLines(r.lines).length, 0);
		}
	},
	{
		loop: "notifications",
		name: "reinício com token aceito",
		reply: rejectEverything(NOT_FOUND),
		restartWith: (n, _now, state) =>
			n < 0 ? OK(true) : (state.after = (state.after || 0) + 1) === 1 ? UPDATE : HANG,
		check(r) {
			assertRejected(r);
			assert.deepStrictEqual(r.updates, ["1"]);
		}
	},
	{
		loop: "bot",
		name: "eventos de conexão",
		reply: failThenRecover(RESET, 3),
		check: (r) => assert.deepStrictEqual(r.events, ["connected", "POLLING_ERROR", "connected"])
	},
	{
		loop: "inicialização",
		name: "token com 401",
		reply: rejectEverything(UNAUTHORIZED),
		check(r) {
			assert.deepStrictEqual(r.getMeTimes, [0, 30000, 60000]);
			assert.strictEqual(r.polls.length, 0);
			assert.strictEqual(matching(r.lines, STOP_NOTICE).length, 1);
			assert.strictEqual(problemLines(r.lines).length, 1);
		}
	},
	{
		loop: "inicialização",
		name: "401 passageiro no getMe e depois no polling não para",
		reply(n, _now, state, method) {
			if (method === "getMe") {
				return state.calls.getMe <= 2 ? UNAUTHORIZED : OK({ id: 1, username: "bot_teste" });
			}
			return failThenRecover(UNAUTHORIZED, 2)(n);
		},
		check(r) {
			assert.deepStrictEqual(r.getMeTimes, [0, 30000, 60000]);
			assert.deepStrictEqual(r.updates, ["1"]);
			assert.strictEqual(matching(r.lines, STOP_NOTICE).length, 0);
		}
	},
	{
		loop: "inicialização",
		name: "502 continua a cada 30 s",
		reply: rejectEverything(BAD_GATEWAY),
		check: (r) => assert.strictEqual(r.calls.getMe, 21)
	}
];

async function main() {
	let failures = 0;
	let unhandled = 0;
	process.on("unhandledRejection", () => unhandled++);

	for (const scenario of scenarios) {
		const r = await run(scenario.loop, scenario.reply, scenario);
		const requests = r.polls.length + r.calls.getMe;
		const summary =
			`${scenario.loop} | ${scenario.name} | pedidos=${requests} ` +
			`avisos=${problemLines(r.lines).length} linhas=${r.lines.length} parou=${r.stopped} ` +
			`intervalos=${[...new Set(r.gaps.map((g) => g / 1000))].join(",")}`;
		try {
			scenario.check(r);
			assert.ok(
				r.spans.every((s) => !s.parent),
				"o span deve ser raiz"
			);
			for (const text of [...r.allLines, r.rawSpans]) {
				assert.ok(!text.includes(TOKEN), "token vazou em log ou span");
			}
			console.log(`ok     ${summary}`);
		} catch (error) {
			failures++;
			console.log(`FALHOU ${summary}\n       ${error.message.split("\n")[0]}`);
		}
	}

	assert.strictEqual(unhandled, 0, "rejeição não tratada");
	console.log(`\n${scenarios.length - failures}/${scenarios.length} cenários passaram`);
	if (failures > 0) throw new Error(`${failures} cenário(s) falharam`);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
