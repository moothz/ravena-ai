/**
 * EconomyAnalyticsRunas.js
 *
 * Resumo da economia de Runas a partir do bank.db local (só leitura), no mesmo formato da rota
 * `GET /internal/economy/summary` dos serviços (contrato do painel, seção 1). Os IDs de usuário só
 * existem em memória durante o cálculo; nada por jogador é devolvido.
 *
 * Também traz as funções de estatística (quintos, percentis) usadas no cálculo.
 */
"use strict";

const { kindFor } = require("./EconomyAnalyticsMapping");

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// O dia econômico vira às 04:00 BRT = 07:00 UTC (BankService.getTodayDateString)
const DAY_OFFSET_MS = 7 * HOUR_MS;
const MIN_GROUP = 10; // quintos com n < 10 saem nulos
const RECEIVED_MAX_WINDOW_MS = 8 * DAY_MS;

/** Início (epoch ms) do dia econômico que contém `ts`. */
function economicDayStart(ts) {
	return Math.floor((ts - DAY_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_OFFSET_MS;
}

function hourStart(ts) {
	return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

function median(sorted) {
	const n = sorted.length;
	if (n === 0) return null;
	return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Percentil por posição (nearest-rank) num vetor já ordenado. */
function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[idx];
}

/** Índices [início, fim) de cada um dos 5 quintos num vetor de tamanho n. */
function quintileRanges(n) {
	const out = [];
	for (let q = 1; q <= 5; q++) {
		out.push({ q, start: Math.floor(((q - 1) * n) / 5), end: Math.floor((q * n) / 5) });
	}
	return out;
}

const round = (v) => (v === null || v === undefined ? null : Math.round(v));

/**
 * Estatísticas de saldo no formato `balances` do contrato.
 * @param {number[]} values saldo de cada conta existente
 */
function balanceStats(values) {
	const holders = values.filter((v) => v > 0).sort((a, b) => a - b);
	const n = holders.length;
	const total = holders.reduce((s, v) => s + v, 0);
	let top10Share = null;
	if (n > 0 && total > 0) {
		const k = Math.ceil(n * 0.1);
		const top = holders.slice(n - k).reduce((s, v) => s + v, 0);
		top10Share = Number((top / total).toFixed(4));
	}
	const quintiles = quintileRanges(n).map(({ q, start, end }) => {
		const slice = holders.slice(start, end);
		const size = slice.length;
		if (size < MIN_GROUP) return { q, n: size, min: null, max: null, sum: null };
		return {
			q,
			n: size,
			min: round(slice[0]),
			max: round(slice[size - 1]),
			sum: round(slice.reduce((s, v) => s + v, 0))
		};
	});
	return {
		total: round(total),
		holders: n,
		accounts: values.length,
		p50: round(percentile(holders, 0.5)),
		p90: round(percentile(holders, 0.9)),
		top10Share,
		quintiles
	};
}

/**
 * Entradas de criação na janela por faixa de saldo atual (entre holders).
 * @param {Map<string,number>} balanceByUser saldo atual por conta
 * @param {Map<string,number>} receivedByUser entradas de criação na janela por conta
 */
function receivedByQuintile(balanceByUser, receivedByUser) {
	const holders = [...balanceByUser.entries()].filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1]);
	return quintileRanges(holders.length).map(({ q, start, end }) => {
		const slice = holders.slice(start, end);
		const size = slice.length;
		if (size < MIN_GROUP) return { q, n: size, receivedSum: null, receivedMedian: null };
		const got = slice.map(([u]) => receivedByUser.get(u) || 0).sort((a, b) => a - b);
		return {
			q,
			n: size,
			receivedSum: round(got.reduce((s, v) => s + v, 0)),
			receivedMedian: round(median(got))
		};
	});
}

function parseJson(s) {
	try {
		return s ? JSON.parse(s) : {};
	} catch (_) {
		return {};
	}
}

/**
 * Motivo e sentido de uma linha de bank_transactions. runas_amount é sempre positivo, exceto em
 * ADMIN_ADJUST (diferença com sinal); o sentido vem do type.
 * @returns {{reason:string, amountIn:number, amountOut:number}}
 */
function classifyRunasTx(row) {
	const type = String(row.type || "");
	const game = String(row.game || "");
	const amount = Number(row.runas_amount) || 0;
	const abs = Math.abs(amount);
	let reason = `${type}:${game}`;
	let dir; // +1 entrada, -1 saída
	switch (type) {
		case "DEPOSIT":
		case "BONUS":
		case "TRANSFER_IN":
			dir = 1;
			break;
		case "WITHDRAW":
		case "STORE_BUY":
		case "TRANSFER_OUT":
			dir = -1;
			break;
		case "UNDO_TRADE": {
			// Desfazer venda (DEPOSIT) tira Runas; desfazer compra (WITHDRAW/STORE_BUY) devolve.
			const orig = String(parseJson(row.details_json).originalType || "");
			if (orig) reason = `UNDO_${orig}:${game}`;
			dir = orig === "DEPOSIT" ? -1 : 1;
			break;
		}
		default:
			// ADMIN_ADJUST e tipos novos: o sinal do valor manda
			dir = amount >= 0 ? 1 : -1;
	}
	return dir > 0
		? { reason, amountIn: abs, amountOut: 0 }
		: { reason, amountIn: 0, amountOut: abs };
}

const TX_SQL = `SELECT user_id, type, game, runas_amount, details_json, timestamp
	FROM bank_transactions
	WHERE timestamp >= ? AND timestamp < ?
	  AND (status IS NULL OR status IN ('COMPLETED', 'UNDONE'))`;

/**
 * Fluxos por hora e motivo. Transações desfeitas (status UNDONE) contam no instante original (o
 * dinheiro se moveu) e o UNDO_TRADE correspondente conta como estorno no instante em que foi desfeita.
 */
function runasFlows(query, from, to) {
	const groups = new Map();
	for (const row of query(TX_SQL, [from, to])) {
		const { reason, amountIn, amountOut } = classifyRunasTx(row);
		const hour = hourStart(Number(row.timestamp));
		const key = `${hour}|${reason}`;
		let g = groups.get(key);
		if (!g) {
			g = { hour, reason, amountIn: 0, amountOut: 0, count: 0, users: new Set() };
			groups.set(key, g);
		}
		g.amountIn += amountIn;
		g.amountOut += amountOut;
		g.count += 1;
		g.users.add(String(row.user_id));
	}
	return [...groups.values()].map((g) => ({
		hour: g.hour,
		reason: g.reason,
		// Runas têm centavos; o contrato pede inteiros. Arredonda a soma da hora (erro <= 0,5 ᚱ por linha).
		amountIn: Math.round(g.amountIn),
		amountOut: Math.round(g.amountOut),
		count: g.count,
		users: g.users.size
	}));
}

function currentBalances(query) {
	const map = new Map();
	for (const r of query("SELECT user_id, runas FROM bank_accounts", [])) {
		map.set(String(r.user_id), Number(r.runas) || 0);
	}
	return map;
}

function receivedInWindow(query, from, to) {
	const map = new Map();
	for (const row of query(TX_SQL, [from, to])) {
		const { reason, amountIn } = classifyRunasTx(row);
		if (amountIn <= 0 || kindFor("runas", reason) !== "creation") continue;
		const u = String(row.user_id);
		map.set(u, (map.get(u) || 0) + amountIn);
	}
	return map;
}

/**
 * Retratos diários de saldo a partir de bank_daily_quotas.initial_runas (gravado na virada das 04:00
 * BRT para todas as contas). Linha com initial_runas NULL = conta que não existia na virada (0).
 * Só devolve dias cujo início (07:00 UTC) cai em [from, to).
 * @returns {{ts:number, balances:object}[]}
 */
function dailySnapshots(query, from, to) {
	const rows = query(
		`SELECT date, initial_runas FROM bank_daily_quotas
		 WHERE date IN (SELECT date FROM bank_daily_quotas WHERE initial_runas IS NOT NULL GROUP BY date)`,
		[]
	);
	const byDate = new Map();
	for (const r of rows) {
		const ts = Date.parse(`${r.date}T07:00:00.000Z`);
		if (!Number.isFinite(ts) || ts < from || ts >= to) continue;
		if (!byDate.has(ts)) byDate.set(ts, []);
		byDate.get(ts).push(Number(r.initial_runas) || 0);
	}
	return [...byDate.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([ts, values]) => ({ ts, balances: balanceStats(values) }));
}

/**
 * Resumo no formato da rota dos serviços.
 * @param {(sql:string, params:any[]) => object[]} query leitura síncrona do bank.db
 */
function buildRunasSummary(query, from, to, now = Date.now()) {
	const balanceByUser = currentBalances(query);
	const summary = {
		currency: "runas",
		schemaVersion: 1,
		generatedAt: now,
		window: { from, to },
		ledger: { available: true, flows: runasFlows(query, from, to) },
		balances: balanceStats([...balanceByUser.values()]),
		receivedByQuintile: []
	};
	if (to - from <= RECEIVED_MAX_WINDOW_MS) {
		summary.receivedByQuintile = receivedByQuintile(
			balanceByUser,
			receivedInWindow(query, from, to)
		);
	}
	return summary;
}

module.exports = {
	HOUR_MS,
	DAY_MS,
	DAY_OFFSET_MS,
	MIN_GROUP,
	economicDayStart,
	hourStart,
	percentile,
	median,
	balanceStats,
	receivedByQuintile,
	classifyRunasTx,
	runasFlows,
	dailySnapshots,
	buildRunasSummary
};
