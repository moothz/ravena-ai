/**
 * Helpers de tracing de negócio da ravena-ai.
 *
 * Usa só @opentelemetry/api: quando a telemetria está desligada, tudo aqui vira no-op barato
 * (tracer no-op, hashId devolve undefined sem calcular HMAC).
 *
 * Política de privacidade (ver OBSERVABILITY.md): NUNCA passar para atributos/eventos telefone,
 * ID cru de usuário/grupo/chat, nome, texto de mensagem, args de comando, prompt/resposta de LLM
 * ou segredos. IDs só via hashId().
 */
"use strict";

const crypto = require("crypto");
const api = require("@opentelemetry/api");

const { trace, context, SpanStatusCode, SpanKind, ROOT_CONTEXT } = api;
const tracer = trace.getTracer("ravena-ai");

const ID_SALT = process.env.OTEL_ID_SALT || crypto.randomBytes(32).toString("hex");

function isEnabled() {
	return globalThis.__RAVENA_OTEL_ENABLED === true;
}

/** Pseudônimo estável (HMAC-SHA256 truncado) para IDs de usuário/grupo. undefined se desligado. */
function hashId(id) {
	if (!isEnabled() || id === undefined || id === null || id === "") return undefined;
	return crypto.createHmac("sha256", ID_SALT).update(String(id)).digest("hex").slice(0, 16);
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
	span.recordException(e);
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
	const spanOpts = { kind: opts.kind ?? SpanKind.INTERNAL, attributes: cleanAttrs(opts.attributes), links: opts.links };
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
		{ kind: opts.kind ?? SpanKind.INTERNAL, attributes: cleanAttrs(opts.attributes), startTime: opts.startTime },
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
		else if (code >= 400) span.setAttributes({ "app.outcome": "rejected", "app.reject.reason": `http_${code}` });
		else span.setAttribute("app.outcome", "ok");
	});
}

/** Pseudônimo de usuário com a mesma normalização que a ravena usa ao chamar waifuletes/Jardim. */
function hashUserId(id) {
	if (id === undefined || id === null || id === "") return undefined;
	const norm = String(id).split("@")[0].split(":")[0];
	return hashId(norm || id);
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
	hashId,
	withSpan,
	startSpan,
	activeSpan,
	setAttrs,
	addEvent,
	recordError,
	hasOutcome,
	markOutcomeOnFinish,
	hashUserId,
	trackPending,
	addPending,
	awaitPending,
	logIds
};
