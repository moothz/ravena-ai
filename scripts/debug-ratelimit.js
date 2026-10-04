#!/usr/bin/env node
/**
 * scripts/debug-ratelimit.js
 *
 * Visualizador de métricas e relatório contínuo de erros 429 e rate-overlimit.
 * Uso:
 *   node scripts/debug-ratelimit.js [opções]
 *   make debug-ratelimit [ARGS="--recent 20"]
 *
 * Opções:
 *   --recent <N>      Mostra os últimos N eventos com stack trace completo (padrão: 10)
 *   --endpoint <ep>   Filtra ocorrências por endpoint (ex: --endpoint group/info)
 *   --bot <nome>      Filtra ocorrências por bot (ex: --bot ravena10)
 *   --caller <nome>   Filtra ocorrências por arquivo ou função chamadora
 *   --clear           Limpa todo o histórico de eventos e métricas
 *   --json            Exibe os dados em formato JSON puro
 *   --help            Exibe esta ajuda
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const RateLimitTracker = require("../src/services/RateLimitTracker");

// Cores ANSI para o terminal
const c = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
	bgRed: "\x1b[41m",
	bgYellow: "\x1b[43m"
};

function parseArgs() {
	const args = process.argv.slice(2);
	const options = {
		recent: 10,
		endpoint: null,
		bot: null,
		caller: null,
		clear: false,
		json: false,
		help: false
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--clear") {
			options.clear = true;
		} else if (arg === "--recent" && i + 1 < args.length) {
			options.recent = parseInt(args[++i], 10) || 10;
		} else if (arg === "--endpoint" && i + 1 < args.length) {
			options.endpoint = args[++i];
		} else if (arg === "--bot" && i + 1 < args.length) {
			options.bot = args[++i];
		} else if (arg === "--caller" && i + 1 < args.length) {
			options.caller = args[++i];
		}
	}

	return options;
}

function showHelp() {
	console.log(`
${c.bold}${c.cyan}Relatório de Rate Limit (429 / Rate-Overlimit) — Ravena AI${c.reset}

${c.bold}Uso:${c.reset}
  node scripts/debug-ratelimit.js [opções]
  make debug-ratelimit [ARGS="--recent 20"]

${c.bold}Opções:${c.reset}
  ${c.green}--recent <N>${c.reset}     Exibe os últimos N eventos em detalhes (padrão: 10)
  ${c.green}--endpoint <ep>${c.reset}  Filtra eventos por endpoint (ex: --endpoint /group/info)
  ${c.green}--bot <nome>${c.reset}     Filtra eventos por bot (ex: --bot ravena10)
  ${c.green}--caller <txt>${c.reset}   Filtra por arquivo ou função que chamou a API
  ${c.green}--clear${c.reset}          Apaga todos os registros de rate limit do SQLite
  ${c.green}--json${c.reset}           Saída em formato JSON (ideal para automações)
  ${c.green}--help${c.reset}           Exibe esta mensagem de ajuda
`);
}

function formatRelativeTime(isoDateStr) {
	const diffMs = Date.now() - new Date(isoDateStr).getTime();
	const diffSec = Math.floor(diffMs / 1000);
	if (diffSec < 60) return `${diffSec}s atrás`;
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m atrás`;
	const diffHours = Math.floor(diffMin / 60);
	if (diffHours < 24) return `${diffHours}h atrás`;
	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d atrás`;
}

function run() {
	const options = parseArgs();

	if (options.help) {
		showHelp();
		process.exit(0);
	}

	const tracker = RateLimitTracker.getInstance();

	// Limpeza do banco
	if (options.clear) {
		const ok = tracker.clearData();
		if (options.json) {
			console.log(
				JSON.stringify({ success: ok, message: "Dados de rate limit apagados com sucesso." })
			);
		} else {
			console.log(`${c.green}✅ Histórico de rate limits apagado com sucesso!${c.reset}`);
		}
		process.exit(0);
	}

	const summary = tracker.getSummary({ limit: options.recent });

	// Filtros específicos para eventos recentes se solicitados
	let events = summary.recentEvents;
	if (options.endpoint || options.bot || options.caller) {
		events = tracker.getRecentEvents(options.recent, {
			endpoint: options.endpoint,
			bot: options.bot,
			caller: options.caller
		});
	}

	// Saída JSON
	if (options.json) {
		console.log(
			JSON.stringify(
				{
					enabled: process.env.DEBUG_RATE_LIMIT === "true",
					summary: {
						totalEvents: summary.totalEvents,
						last1h: summary.last1h,
						last24h: summary.last24h,
						last7d: summary.last7d
					},
					byEndpoint: summary.byEndpoint,
					byCaller: summary.byCaller,
					byBot: summary.byBot,
					byErrorType: summary.byErrorType,
					events
				},
				null,
				2
			)
		);
		process.exit(0);
	}

	// Saída Visual Formatada no Terminal
	const isEnabled = process.env.DEBUG_RATE_LIMIT === "true";
	const statusBadge = isEnabled
		? `${c.green}[ATIVO - DEBUG_RATE_LIMIT=true]${c.reset}`
		: `${c.yellow}[INATIVO - ative com DEBUG_RATE_LIMIT=true no .env]${c.reset}`;

	console.log(
		`\n${c.bold}══════════════════════════════════════════════════════════════════════════════════${c.reset}`
	);
	console.log(
		`  ${c.bold}${c.cyan}📊 PAINEL DE RATE LIMIT & 429 — RAVENA AI${c.reset}  ${statusBadge}`
	);
	console.log(
		`${c.bold}══════════════════════════════════════════════════════════════════════════════════${c.reset}\n`
	);

	// Bloco 1: Estatísticas Rápidas
	console.log(`${c.bold}⏱  Volume de Ocorrências:${c.reset}`);
	console.log(
		`   Última 1 hora:   ${summary.last1h > 0 ? c.red + c.bold : c.green}${summary.last1h}${c.reset} ocorrências`
	);
	console.log(
		`   Últimas 24h:     ${summary.last24h > 0 ? c.yellow + c.bold : c.green}${summary.last24h}${c.reset} ocorrências`
	);
	console.log(`   Últimos 7 dias:  ${c.cyan}${summary.last7d}${c.reset} ocorrências`);
	console.log(`   Total Histórico: ${c.white}${summary.totalEvents}${c.reset} ocorrências\n`);

	// Bloco 2: Volume Total de Requisições por Endpoint (Última 1 hora)
	if (summary.trafficLast1h && summary.trafficLast1h.length > 0) {
		console.log(`${c.bold}📈 Volume de Chamadas à API do WhatsApp (Última 1 hora):${c.reset}`);
		console.log(
			`   ${c.gray}${"MÉTODO".padEnd(8)} ${"ENDPOINT".padEnd(28)} ${"TOTAL CHAMADAS".padEnd(16)} RATE LIMITS${c.reset}`
		);
		console.log(`   ${c.gray}${"─".repeat(66)}${c.reset}`);

		for (const tr of summary.trafficLast1h) {
			const methodColor = tr.method === "POST" ? c.blue : tr.method === "GET" ? c.green : c.yellow;
			const hitsBadge =
				tr.rate_limit_hits > 0
					? `${c.red}${c.bold}${tr.rate_limit_hits} (429)${c.reset}`
					: `${c.green}0${c.reset}`;
			console.log(
				`   ${methodColor}${tr.method.padEnd(8)}${c.reset} ${tr.endpoint.padEnd(28)} ${c.white}${String(tr.total_requests).padEnd(16)}${c.reset} ${hitsBadge}`
			);
		}
		console.log("");
	}

	if (summary.totalEvents === 0) {
		console.log(
			`${c.green}✨ Nenhuma ocorrência de 429 ou rate-overlimit registrada até o momento!${c.reset}\n`
		);
		process.exit(0);
	}

	// Bloco 3: Top Endpoints com Rate Limit
	if (summary.byEndpoint && summary.byEndpoint.length > 0) {
		console.log(`${c.bold}🎯 Top Endpoints com Rate Limit:${c.reset}`);
		console.log(
			`   ${c.gray}${"MÉTODO".padEnd(8)} ${"ENDPOINT".padEnd(28)} ${"429 HITS".padEnd(12)} TAXA ESTIMADA${c.reset}`
		);
		console.log(`   ${c.gray}${"─".repeat(60)}${c.reset}`);

		for (const ep of summary.byEndpoint) {
			const rate =
				ep.total_requests > 0 ? `${((ep.hits / ep.total_requests) * 100).toFixed(1)}%` : "N/A";
			const methodColor = ep.method === "POST" ? c.blue : ep.method === "GET" ? c.green : c.yellow;
			console.log(
				`   ${methodColor}${ep.method.padEnd(8)}${c.reset} ${ep.endpoint.padEnd(28)} ${c.red}${String(ep.hits).padEnd(12)}${c.reset} ${c.yellow}${rate}${c.reset}`
			);
		}
		console.log("");
	}

	// Bloco 3: Top Código Chamador
	if (summary.byCaller && summary.byCaller.length > 0) {
		console.log(`${c.bold}📍 Onde o Código Disparou as Chamadas (Top Callers):${c.reset}`);
		console.log(
			`   ${c.gray}${"LOCAL NO CÓDIGO".padEnd(40)} ${"FUNÇÃO".padEnd(25)} OCORRÊNCIAS${c.reset}`
		);
		console.log(`   ${c.gray}${"─".repeat(78)}${c.reset}`);

		for (const caller of summary.byCaller) {
			console.log(
				`   ${c.cyan}${caller.caller_file.padEnd(40)}${c.reset} ${c.white}${caller.caller_function.padEnd(25)}${c.reset} ${c.red}${caller.hits}${c.reset}`
			);
			if (caller.call_chain && caller.call_chain !== "unknown") {
				console.log(`     ${c.gray}↳ Cadeia: ${caller.call_chain}${c.reset}`);
			}
		}
		console.log("");
	}

	// Bloco 4: Distribuição por Bot
	if (summary.byBot && summary.byBot.length > 0) {
		console.log(`${c.bold}🤖 Distribuição por Instância / Bot:${c.reset}`);
		const botList = summary.byBot
			.map((b) => `${c.cyan}${b.bot_name}${c.reset}: ${c.red}${b.hits}${c.reset}`)
			.join("  |  ");
		console.log(`   ${botList}\n`);
	}

	// Bloco 5: Últimos Eventos Detalhados
	console.log(`${c.bold}📋 Últimas ${events.length} Ocorrências Detalhadas:${c.reset}`);
	console.log(`${c.gray}${"─".repeat(82)}${c.reset}`);

	for (const evt of events) {
		const relTime = formatRelativeTime(evt.timestamp);
		const errorTypeBadge =
			evt.error_type === "RATE_OVERLIMIT"
				? `${c.bgRed}${c.white} RATE-OVERLIMIT ${c.reset}`
				: evt.error_type === "HTTP_429"
					? `${c.bgYellow}${c.white} HTTP 429 ${c.reset}`
					: `${c.bgRed}${c.white} ${evt.error_type} ${c.reset}`;

		console.log(
			`• [${c.gray}${evt.timestamp.replace("T", " ").substring(0, 19)}${c.reset} - ${c.yellow}${relTime}${c.reset}] ${errorTypeBadge}`
		);
		console.log(
			`  ${c.bold}Bot:${c.reset} ${c.cyan}${evt.bot_name}${c.reset} | ${c.bold}Chamada:${c.reset} ${evt.method} ${evt.endpoint} (HTTP ${evt.status_code || "N/A"})`
		);
		console.log(
			`  ${c.bold}Arquivo:${c.reset} ${c.green}${evt.caller_file}${c.reset} ➔ ${c.bold}Função:${c.reset} ${evt.caller_function}`
		);

		if (evt.call_chain && evt.call_chain !== "unknown") {
			console.log(`  ${c.bold}Cadeia:${c.reset} ${c.gray}${evt.call_chain}${c.reset}`);
		}

		console.log(`  ${c.bold}Erro:${c.reset} ${c.red}${evt.error_message}${c.reset}`);

		if (evt.request_data && evt.request_data !== "{}" && evt.request_data !== '""') {
			let truncated = evt.request_data;
			if (truncated.length > 120) truncated = `${truncated.substring(0, 120)}...`;
			console.log(`  ${c.bold}Dados:${c.reset} ${c.gray}${truncated}${c.reset}`);
		}

		console.log(`${c.gray}${"─".repeat(82)}${c.reset}`);
	}

	console.log(
		`\n${c.dim}💡 Dica: Use 'make debug-ratelimit ARGS="--recent 30"' para ver mais eventos ou '--clear' para resetar.${c.reset}\n`
	);

	process.exit(0);
}

try {
	run();
} catch (err) {
	console.error(`${c.red}Erro ao executar debug-ratelimit:${c.reset}`, err);
	process.exit(1);
}
