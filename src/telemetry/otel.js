/**
 * Bootstrap do OpenTelemetry da ravena-ai.
 *
 * Carregado ANTES de qualquer outro módulo:  node --require ./src/telemetry/otel.js index.js
 *
 * Fica totalmente desligado (nenhum pacote do SDK é carregado; a API devolve tracer no-op)
 * a menos que OTEL_EXPORTER_OTLP_ENDPOINT (ou OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) esteja
 * definido e OTEL_SDK_DISABLED != "true". Qualquer falha aqui só gera um aviso: o bot sobe
 * normalmente sem telemetria. Ver OBSERVABILITY.md.
 */
"use strict";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const disabled = String(process.env.OTEL_SDK_DISABLED || "").toLowerCase() === "true";

if (endpoint && !disabled) {
	try {
		start();
	} catch (err) {
		console.warn(`[otel] falha ao iniciar a telemetria; seguindo sem ela: ${err && err.message}`);
	}
}

function compactDiagLogger(base) {
	const last = new Map();
	const wrap = (level) => (msg, ...args) => {
		let text = String(msg ?? "");
		if (text.startsWith("{")) {
			try {
				const parsed = JSON.parse(text);
				text = parsed.message || parsed.code || text;
			} catch {}
		}
		const first = String(text).split("\n")[0].slice(0, 200);
		const detail = args.map((a) => (a && a.message ? a.message : typeof a === "string" ? a : "")).find(Boolean) || "";
		const line = `[otel] ${first}${detail ? ` — ${String(detail).split("\n")[0].slice(0, 200)}` : ""}`;
		const now = Date.now();
		if (now - (last.get(line) || 0) < 60000) return;
		last.set(line, now);
		if (last.size > 200) last.clear();
		base[level](line);
	};
	return { error: wrap("error"), warn: wrap("warn"), info: wrap("info"), debug: wrap("debug"), verbose: wrap("verbose") };
}

function start() {
	const { NodeSDK } = require("@opentelemetry/sdk-node");
	const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api");
	const { resourceFromAttributes } = require("@opentelemetry/resources");
	const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");
	const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-proto");
	const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
	const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
	const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
	const { UndiciInstrumentation } = require("@opentelemetry/instrumentation-undici");
	const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
	const { IORedisInstrumentation } = require("@opentelemetry/instrumentation-ioredis");
	const { RuntimeNodeInstrumentation } = require("@opentelemetry/instrumentation-runtime-node");

	// Erros de export (collector fora do ar) nunca derrubam o processo. O logger de diagnóstico
	// imprime só a 1ª linha (sem stack) e no máximo 1 vez por minuto por mensagem.
	diag.setLogger(compactDiagLogger(new DiagConsoleLogger()), DiagLogLevel[(process.env.OTEL_LOG_LEVEL || "error").toUpperCase()] ?? DiagLogLevel.ERROR);

	let version = "unknown";
	try {
		version = require("../../package.json").version;
	} catch {}

	const resource = resourceFromAttributes({
		"service.name": process.env.OTEL_SERVICE_NAME || "ravena-ai",
		"service.namespace": "ravena",
		"service.version": version,
		"deployment.environment.name": process.env.OTEL_DEPLOYMENT_ENVIRONMENT || process.env.NODE_ENV || "production"
	});

	// Remove query string (pode ter key=/token=) e o token de bot do Telegram (/bot<token>/metodo).
	const sanitizePath = (p) =>
		String(p || "")
			.split("?")[0]
			.replace(/\/bot[^/]+/, "/bot***")
			.replace(/[0-9]{6,}/g, "{n}")
			.replace(/[^/]*(@|%40)(c\.us|g\.us|lid|s\.whatsapp\.net)/gi, "{id}");

	// Liga cada span de cliente HTTP ao span "command <nome>" ativo, para o resultado do comando
	// refletir a resposta do waifuletes/Jardim (ver telemetry/index.js → noteDownstream).
	const pendingCalls = new WeakMap();
	let telemetryHelpers = null;
	const helpers = () => (telemetryHelpers ||= require("./index"));
	const rememberCommand = (span, host) => {
		try {
			const cmd = helpers().currentCommandSpan();
			if (cmd) pendingCalls.set(span, { cmd, host });
		} catch {}
	};
	const noteResponse = (span, status) => {
		const entry = pendingCalls.get(span);
		if (!entry) return;
		pendingCalls.delete(span);
		try {
			helpers().noteDownstream(entry.cmd, entry.host, status);
		} catch {}
	};

	// Ruído que não ajuda a achar gargalo: health checks, long-poll do Telegram, polling de status.
	const IGNORED_INCOMING = [/^\/health/, /^\/favicon/, /^\/public\//, /^\/static\//];
	const IGNORED_OUTGOING = [/\/getUpdates/, /\/v1\/(traces|metrics|logs)$/];

	const sdk = new NodeSDK({
		resource,
		// Fila limitada: se o collector cair, spans excedentes são descartados (nunca bloqueia).
		spanProcessors: [
			new BatchSpanProcessor(new OTLPTraceExporter({ timeoutMillis: 10000 }), {
				maxQueueSize: 4096,
				maxExportBatchSize: 512,
				scheduledDelayMillis: 2000
			})
		],
		metricReader: new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({ timeoutMillis: 10000 }),
			exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 30000)
		}),
		instrumentations: [
			new HttpInstrumentation({
				// Chamadas de saída sem span pai (health checks periódicos, timers) não viram traces soltos.
				requireParentforOutgoingSpans: true,
				ignoreIncomingRequestHook: (req) => IGNORED_INCOMING.some((re) => re.test(req.url || "")),
				ignoreOutgoingRequestHook: (opts) => IGNORED_OUTGOING.some((re) => re.test(opts.path || "")),
				// URL de saída sem query string e sem token de bot do Telegram (o collector repete a máscara).
				requestHook: (span, req) => {
					if (typeof req.getHeader !== "function") {
						// IncomingMessage (servidor): caminho sem query e com IDs longos mascarados
						if (typeof req.url === "string") {
							span.setAttribute("url.path", sanitizePath(req.url));
							span.setAttribute("http.target", sanitizePath(req.url));
							// query de entrada: só os nomes dos parâmetros (valores podem ter texto livre/IDs)
							const q = req.url.split("?")[1];
							if (q) span.setAttribute("url.query", q.split("&").map((kv) => `${kv.split("=")[0].slice(0, 40)}=REDACTED`).join("&"));
						}
						return;
					}
					if (typeof req.path !== "string") return;
					const host = req.getHeader("host") || req.host || "";
					const path = sanitizePath(req.path);
					span.setAttribute("url.full", `${req.protocol || "http:"}//${host}${path}`);
					rememberCommand(span, host);
				},
				responseHook: (span, res) => {
					// resposta de cliente (IncomingMessage com statusCode e sem método)
					if (res && typeof res.statusCode === "number" && !res.method) noteResponse(span, res.statusCode);
				},
				// Não grava headers.
				headersToSpanAttributes: { client: { requestHeaders: [], responseHeaders: [] }, server: { requestHeaders: [], responseHeaders: [] } }
			}),
			new UndiciInstrumentation({
				requireParentforSpans: true,
				ignoreRequestHook: (req) => IGNORED_OUTGOING.some((re) => re.test(req.path || "")),
				requestHook: (span, req) => {
					try {
						rememberCommand(span, new URL(req.origin).host);
					} catch {}
				},
				responseHook: (span, { response }) => noteResponse(span, response?.statusCode),
				startSpanHook: (req) => ({
					"url.full": `${req.origin}${sanitizePath(req.path)}`,
					"url.path": sanitizePath(req.path),
					"url.query": undefined
				})
			}),
			new ExpressInstrumentation({ ignoreLayersType: ["middleware", "request_handler"] }),
			new IORedisInstrumentation({ requireParentSpan: true }),
			new RuntimeNodeInstrumentation()
		]
	});

	// O construtor do NodeSDK troca o logger de diagnóstico quando OTEL_LOG_LEVEL está definido;
	// reaplica o logger compacto (sem stack, com limite de frequência).
	diag.setLogger(compactDiagLogger(new DiagConsoleLogger()), DiagLogLevel[(process.env.OTEL_LOG_LEVEL || "error").toUpperCase()] ?? DiagLogLevel.ERROR);
	sdk.start();
	globalThis.__RAVENA_OTEL_ENABLED = true;

	// O index.js já trata SIGINT/SIGTERM e chama process.exit; aqui só tentamos esvaziar a fila
	// (com teto de 3 s) sem registrar handlers de sinal que mudariam o comportamento de saída.
	globalThis.__RAVENA_OTEL_SHUTDOWN = () =>
		Promise.race([sdk.shutdown().catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref())]);

	console.log(`[otel] telemetria ligada → ${endpoint} (service.name=${process.env.OTEL_SERVICE_NAME || "ravena-ai"})`);
}
