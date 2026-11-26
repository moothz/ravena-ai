/**
 * Helpers de tracing de negócio da ravena-ai.
 *
 * Usa só @opentelemetry/api: quando a telemetria está desligada, tudo aqui vira no-op barato
 * (tracer no-op, userIdAttr/chatIdAttr devolvem undefined).
 *
 * Política de privacidade (ver OBSERVABILITY.md): usuário e chat entram como ID (telefone/ID da
 * plataforma) SÓ via userIdAttr()/chatIdAttr(), nos atributos *.user.id / *.chat.id. NUNCA passar
 * nome, texto de mensagem, args de comando, prompt/resposta de LLM ou segredos. Por isso a stack
 * de observabilidade não pode ficar exposta fora do host (ver OBSERVABILITY.md, "Segurança").
 */
"use strict";

const api = require("@opentelemetry/api");
const maskTelegramToken = require("../utils/maskTelegramToken");

const { trace, context, SpanStatusCode, SpanKind, ROOT_CONTEXT } = api;
const tracer = trace.getTracer("ravena-ai");

function isEnabled() {
	return globalThis.__RAVENA_OTEL_ENABLED === true;
}

/** ID de grupo/chat como está (ex.: 1203…@g.us). undefined se desligado ou vazio. */
function chatIdAttr(id) {
	if (!isEnabled() || id === undefined || id === null || id === "") return undefined;
	return String(id);
}

function cleanAttrs(attrs) {
	if (!attrs) return undefined;
	const out = {};
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null) continue;
		if (typeof v === "number" && !Number.isFinite(v)) continue;
		out[k] = typeof v === "object" && !Array.isArray(v) ? String(v) : v;
	}
	return out;
}

/** Marca o span como erro (exceção registrada + error.type) sem vazar dados além da mensagem. */
function recordError(span, err, errorType) {
	if (!span || !span.isRecording()) return;
	const e = err instanceof Error ? err : new Error(String(err));
	span.recordException({
		name: e.name,
		code: e.code,
		message: maskTelegramToken(String(e.message)),
		stack: maskTelegramToken(String(e.stack ?? ""))
	});
	span.setAttribute("error.type", errorType || e.code || e.name || "Error");
	span.setStatus({ code: SpanStatusCode.ERROR, message: e.name });
}

/**
 * Executa fn dentro de um span ativo. Erros lançados marcam o span e são relançados.
 * opts: { attributes, kind, root (bool: começa trace novo), links }
 */
function withSpan(name, opts, fn) {
	if (typeof opts === "function") {
		fn = opts;
		opts = {};
	}
	const spanOpts = {
		kind: opts.kind ?? SpanKind.INTERNAL,
		attributes: cleanAttrs(opts.attributes),
		links: opts.links
	};
	const parentCtx = opts.root ? ROOT_CONTEXT : context.active();
	return tracer.startActiveSpan(name, spanOpts, parentCtx, (span) => {
		let result;
		try {
			result = fn(span);
		} catch (err) {
			recordError(span, err);
			span.end();
			throw err;
		}
		if (result && typeof result.then === "function") {
			return result.then(
				(v) => {
					span.end();
					return v;
				},
				(err) => {
					recordError(span, err);
					span.end();
					throw err;
				}
			);
		}
		span.end();
		return result;
	});
}

/** Inicia um span manual (o chamador encerra). */
function startSpan(name, opts = {}, parentCtx) {
	return tracer.startSpan(
		name,
		{
			kind: opts.kind ?? SpanKind.INTERNAL,
			attributes: cleanAttrs(opts.attributes),
			startTime: opts.startTime
		},
		parentCtx || context.active()
	);
}

function activeSpan() {
	return trace.getActiveSpan();
}

/** Define atributos no span ativo (ignora undefined). */
function setAttrs(attrs, span) {
	const s = span || trace.getActiveSpan();
	if (s && s.isRecording()) s.setAttributes(cleanAttrs(attrs));
}

/** Span event (marco pontual) no span ativo. */
function addEvent(name, attrs, span) {
	const s = span || trace.getActiveSpan();
	if (s && s.isRecording()) s.addEvent(name, cleanAttrs(attrs));
}

/** true se o span já recebeu app.outcome (lê o objeto do SDK; false quando no-op). */
function hasOutcome(span) {
	return Boolean(span && span.attributes && span.attributes["app.outcome"] !== undefined);
}

// Promises disparadas sem await durante o processamento de uma mensagem (só com OTel ligado).
// Guardadas num Symbol para não aparecerem em JSON/logs do objeto da mensagem.
const PENDING = Symbol("otelPending");
function trackPending(message) {
	if (message && typeof message === "object") message[PENDING] = [];
}
function addPending(message, promise) {
	const list = message && message[PENDING];
	if (Array.isArray(list) && promise && typeof promise.then === "function") list.push(promise);
	return promise;
}
async function awaitPending(message, capMs = 120000) {
	const list = message && message[PENDING];
	if (!Array.isArray(list) || list.length === 0) return;
	let timer;
	await Promise.race([
		Promise.allSettled(list),
		new Promise((r) => {
			timer = setTimeout(r, capMs);
			timer.unref?.();
		})
	]);
	clearTimeout(timer);
	delete message[PENDING];
}

/**
 * Para rotas Express: ao terminar a resposta, grava app.outcome no span ativo da requisição
 * (4xx = rejected com o status como motivo; 5xx = error), se ninguém tiver gravado antes.
 */
function markOutcomeOnFinish(res) {
	const span = trace.getActiveSpan();
	if (!span || !span.isRecording() || !res || typeof res.once !== "function") return;
	res.once("finish", () => {
		if (hasOutcome(span)) return;
		const code = res.statusCode;
		if (code >= 500) span.setAttribute("app.outcome", "error");
		else if (code >= 400)
			span.setAttributes({ "app.outcome": "rejected", "app.reject.reason": `http_${code}` });
		else span.setAttribute("app.outcome", "ok");
	});
}

/** Middleware Express: registra app.outcome ao fim da resposta (inclusive 401/429 dos guards). */
function outcomeMiddleware(req, res, next) {
	markOutcomeOnFinish(res);
	next();
}

// ── Resultado do comando a partir das chamadas aos microsserviços (waifuletes / Jardim) ─────────
// O span "command <nome>" fica guardado no contexto; os hooks de HTTP (otel.js) anotam o status
// de cada resposta dos parceiros. Ao fim do comando, se ninguém definiu app.outcome, vale a
// última resposta de OPERAÇÃO MUTÁVEL (POST/PUT/PATCH/DELETE) de parceiro — ou a última
// resposta qualquer, se o comando só leu: 5xx/erro de rede → error; 4xx → rejected
// (downstream_<status>). Assim uma pré-checagem 4xx seguida de uma ação 2xx (ex.: kakera/daily
// antes do roll) não marca o comando, e uma ação 4xx seguida de leituras 2xx (ex.: colheita
// recusada e depois harvest-totals) marca.
const COMMAND_SPAN_KEY = api.createContextKey("ravena.command.span");
const partnerHosts = new Set();
for (const [envName, def] of [
	["WAIFULETES_API_URL", "http://host.docker.internal:3030"],
	["JARDIM_API_URL", "http://host.docker.internal:3040"]
]) {
	try {
		partnerHosts.add(new URL(process.env[envName] || def).host);
	} catch {}
}

function partnerOf(host) {
	if (!host) return null;
	if (partnerHosts.has(host))
		return host.endsWith(":3040") || /jardim/i.test(host) ? "jardim" : "waifuletes";
	return null;
}

/** Usado pelos hooks de HTTP: devolve o span do comando ativo (ou null). */
function currentCommandSpan() {
	const s = context.active().getValue(COMMAND_SPAN_KEY);
	return s && s.isRecording && s.isRecording() ? s : null;
}

/** Registra no span do comando o status de uma resposta de microsserviço parceiro. */
function noteDownstream(commandSpan, host, statusCode, method, path) {
	const partner = partnerOf(host);
	if (!partner || !commandSpan || !commandSpan.isRecording()) return;
	const code = Number(statusCode) || 0;
	const attrs = commandSpan.attributes || {};
	const mutating = /^(POST|PUT|PATCH|DELETE)$/i.test(String(method || ""));
	commandSpan.setAttributes({
		"ravena.downstream.calls": (attrs["ravena.downstream.calls"] || 0) + 1,
		"ravena.downstream.last_status": code,
		"ravena.downstream.last_service": partner
	});
	if (mutating) {
		commandSpan.setAttributes({
			"ravena.downstream.last_action_status": code,
			"ravena.downstream.last_action": `${String(method).toUpperCase()} ${path || ""}`
				.trim()
				.slice(0, 80)
		});
	}
	if (code >= 400 || code === 0) {
		commandSpan.setAttribute(
			"ravena.downstream.failures",
			(attrs["ravena.downstream.failures"] || 0) + 1
		);
	}
}

/** Resultado final do comando quando o código não definiu um. */
function finalizeCommandOutcome(span) {
	if (!span || !span.isRecording() || hasOutcome(span)) return;
	const a = span.attributes || {};
	const last = a["ravena.downstream.last_action_status"] ?? a["ravena.downstream.last_status"];
	if (last === 0 || last >= 500) {
		span.setAttributes({
			"app.outcome": "error",
			"app.reject.reason": `downstream_${last || "network"}`
		});
	} else if (last >= 400) {
		span.setAttributes({ "app.outcome": "rejected", "app.reject.reason": `downstream_${last}` });
	} else {
		span.setAttribute("app.outcome", "ok");
	}
}

/** Como withSpan, mas marca o span como "comando" no contexto (para os hooks de HTTP). */
function withCommandSpan(name, opts, fn) {
	return withSpan(name, opts, (span) =>
		context.with(context.active().setValue(COMMAND_SPAN_KEY, span), () =>
			Promise.resolve(fn(span)).then((result) => {
				finalizeCommandOutcome(span);
				return result;
			})
		)
	);
}

/**
 * ID de usuário sem sufixo (telefone no WhatsApp, ID numérico no Telegram/Discord), com a mesma
 * normalização que a ravena usa ao chamar waifuletes/Jardim: corta no primeiro "@" e no primeiro
 * ":" (5511…@c.us, 5511…:3@s.whatsapp.net e 5511… viram 5511…). undefined se desligado ou vazio.
 */
function userIdAttr(id) {
	if (!isEnabled() || id === undefined || id === null || id === "") return undefined;
	const norm = String(id).split("@")[0].split(":")[0];
	return norm || String(id);
}

/** IDs de correlação para logs ("" se não houver span ativo). */
function logIds() {
	const s = trace.getActiveSpan();
	if (!s) return null;
	const sc = s.spanContext();
	if (!sc || !api.isSpanContextValid(sc)) return null;
	return { traceId: sc.traceId, spanId: sc.spanId };
}

module.exports = {
	api,
	tracer,
	SpanKind,
	SpanStatusCode,
	context,
	trace,
	ROOT_CONTEXT,
	isEnabled,
	chatIdAttr,
	withSpan,
	startSpan,
	activeSpan,
	setAttrs,
	addEvent,
	recordError,
	hasOutcome,
	markOutcomeOnFinish,
	withCommandSpan,
	currentCommandSpan,
	noteDownstream,
	outcomeMiddleware,
	userIdAttr,
	trackPending,
	addPending,
	awaitPending,
	logIds
};
