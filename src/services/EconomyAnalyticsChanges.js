/**
 * EconomyAnalyticsChanges.js
 *
 * Registro automático de mudanças do painel da economia (aba Mudanças):
 *   - parâmetros: lê os parâmetros de balanceamento em produção (GET /internal/economy/params no
 *     waifuletes e no Jardim; as Runas vêm das constantes do BankService já carregado pelo bot),
 *     compara com a leitura anterior e devolve o que mudou (vira anotação com origin = 'auto');
 *   - possíveis mudanças: no último dia econômico completo de cada moeda com extrato, procura motivo
 *     novo, motivo que sumiu e valor médio por transação diferente do normal (origin = 'possivel',
 *     a confirmar ou descartar com scripts/economy-annotate.js).
 */
"use strict";

const { DAY_MS, DAY_OFFSET_MS } = require("./EconomyAnalyticsRunas");

/** Achata um objeto de parâmetros em chaves `a.b.0` com valores number | string | boolean. */
function flattenParams(obj, prefix = "", out = {}) {
	if (obj === null || obj === undefined) {
		if (prefix) out[prefix] = "none";
		return out;
	}
	if (typeof obj !== "object") {
		if (prefix && ["number", "string", "boolean"].includes(typeof obj)) out[prefix] = obj;
		return out;
	}
	for (const [k, v] of Object.entries(obj)) flattenParams(v, prefix ? `${prefix}.${k}` : k, out);
	return out;
}

/**
 * @param {Record<string, any>|null} prev leitura anterior (null = primeira leitura: nada mudou)
 * @param {Record<string, any>} curr
 * @returns {{key:string, from:any, to:any}[]} ordenado pela chave; parâmetro novo tem from null,
 *   removido tem to null
 */
function diffParams(prev, curr) {
	if (!prev) return [];
	const keys = [...new Set([...Object.keys(prev), ...Object.keys(curr)])].sort();
	const out = [];
	for (const key of keys) {
		const a = key in prev ? prev[key] : null;
		const b = key in curr ? curr[key] : null;
		if (String(a) !== String(b)) out.push({ key, from: a, to: b });
	}
	return out;
}

function fmt(v) {
	if (v === null || v === undefined) return "—";
	if (typeof v === "number") return String(Number(v.toPrecision(10)));
	return String(v);
}

/** Texto curto da anotação (o detalhe completo vai em annotations.detail). */
function changeLabel(service, changes, maxLen = 220) {
	const one = (c) =>
		c.from === null
			? `${c.key} novo (${fmt(c.to)})`
			: c.to === null
				? `${c.key} removido (era ${fmt(c.from)})`
				: `${c.key} ${fmt(c.from)} → ${fmt(c.to)}`;
	if (changes.length === 1) return `${service}: ${one(changes[0])}`;
	const text = `${service}: ${changes.length} parâmetros (`;
	const parts = [];
	for (const c of changes) {
		const next = [...parts, one(c)].join("; ");
		if (text.length + next.length + 8 > maxLen) break;
		parts.push(one(c));
	}
	const rest = changes.length - parts.length;
	return `${text}${parts.join("; ")}${rest ? `; +${rest}` : ""})`;
}

/** GET /internal/economy/params. 404 = serviço sem a rota (versão anterior). */
async function fetchParams(baseUrl, headers, timeoutMs, abort = null) {
	const url = `${String(baseUrl).replace(/\/+$/, "")}/internal/economy/params`;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = abort ? AbortSignal.any([timeout, abort]) : timeout;
	const res = await fetch(url, { headers, signal });
	if (res.status === 404) return { missing: true };
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = await res.json();
	if (!body || typeof body.params !== "object" || body.params === null) {
		throw new Error("resposta sem params");
	}
	return {
		params: flattenParams(body.params),
		startedAt: Number.isFinite(Number(body.startedAt)) ? Number(body.startedAt) : null,
		version: body.version ? String(body.version) : null
	};
}

/**
 * Parâmetros das Runas: constantes do BankService, só se o bot já o carregou (require.cache). A carga
 * nunca carrega o BankService por conta própria: ele abre o bank.db e agenda cron ao ser carregado.
 */
function runasParamsFromBot() {
	let id;
	try {
		id = require.resolve("./BankService");
	} catch (_) {
		return null;
	}
	const mod = require.cache[id];
	const exp = mod && mod.exports;
	if (!exp || typeof exp.getEconomyParams !== "function") return null;
	return {
		params: flattenParams(exp.getEconomyParams()),
		startedAt: Math.round(Date.now() - process.uptime() * 1000),
		version: null
	};
}

/** Dia econômico (início, 04:00 BRT) de uma hora. */
function dayOf(hour) {
	return Math.floor((hour - DAY_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_OFFSET_MS;
}

const DETECT = {
	lookbackDays: 28, // motivo "novo" = sem nenhuma linha nesses dias
	steadyDays: 7, // motivo "sumiu" = presente em todos esses dias e ausente no dia
	minDailyTx: 3, // ... com pelo menos isso de transações por dia
	minTxDay: 20, // valor por transação: transações no dia
	minTxBefore: 5, // ... e em cada dia anterior
	maxCv: 0.1, // ... valor por transação estável antes (coeficiente de variação)
	minShift: 0.3 // ... e mudança de pelo menos 30%
};

/**
 * Possíveis mudanças no dia econômico `day` a partir das linhas por dia e motivo.
 * @param {{day:number, reason:string, n:number, vol:number}[]} rows dias [day − lookback, day]
 * @param {(reason:string) => string} labelOf nome legível
 * @returns {{label:string, detail:object}[]}
 */
function detectPossible(rows, day, labelOf, opts = DETECT) {
	const byReason = new Map();
	for (const r of rows) {
		if (!byReason.has(r.reason)) byReason.set(r.reason, new Map());
		byReason.get(r.reason).set(Number(r.day), { n: Number(r.n) || 0, vol: Number(r.vol) || 0 });
	}
	const out = [];
	for (const [reason, days] of [...byReason.entries()].sort()) {
		const today = days.get(day) || { n: 0, vol: 0 };
		const before = [];
		for (let i = 1; i <= opts.steadyDays; i++)
			before.push(days.get(day - i * DAY_MS) || { n: 0, vol: 0 });
		const anyBefore = [...days.entries()].some(
			([d, v]) => d < day && d >= day - opts.lookbackDays * DAY_MS && v.n > 0
		);
		const name = labelOf(reason);
		if (today.n > 0 && !anyBefore) {
			out.push({
				label: `motivo novo: ${name}`,
				detail: { kind: "new_reason", reason, tx: today.n, volume: today.vol }
			});
			continue;
		}
		if (today.n === 0 && before.every((b) => b.n >= opts.minDailyTx)) {
			out.push({
				label: `motivo sumiu: ${name}`,
				detail: { kind: "vanished_reason", reason, txPerDayBefore: before.map((b) => b.n) }
			});
			continue;
		}
		if (today.n >= opts.minTxDay && before.every((b) => b.n >= opts.minTxBefore)) {
			const avgs = before.map((b) => b.vol / b.n);
			const mean = avgs.reduce((a, b) => a + b, 0) / avgs.length;
			if (mean <= 0) continue;
			const sd = Math.sqrt(avgs.reduce((a, b) => a + (b - mean) ** 2, 0) / avgs.length);
			const now = today.vol / today.n;
			const shift = (now - mean) / mean;
			if (sd / mean <= opts.maxCv && Math.abs(shift) >= opts.minShift) {
				out.push({
					label: `valor por transação de ${name}: ${Math.round(mean)} → ${Math.round(now)} (${shift > 0 ? "+" : "−"}${Math.round(Math.abs(shift) * 100)}%)`,
					detail: { kind: "per_tx_shift", reason, before: mean, after: now, tx: today.n }
				});
			}
		}
	}
	return out;
}

module.exports = {
	flattenParams,
	diffParams,
	changeLabel,
	fetchParams,
	runasParamsFromBot,
	detectPossible,
	dayOf,
	DETECT
};
