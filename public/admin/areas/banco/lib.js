/*
 * Funções puras da área Banco (sem DOM, sem fetch): rótulos de operação e jogo, sinal das
 * Runas, regra do desfazer, leitura do valor de ajuste e paginação. Testadas no Node em
 * src/testing/test_admin_banco.js.
 */

import { fmt, fmt2 } from "../../lib.js";

/** Tamanho da página nas listas (o mesmo da tela antiga). */
export const PAGE_SIZE = 20;

/** Taxa usada no valor sugerido do desfazer (a mesma do BankService.undoTransaction). */
export const UNDO_FEE_RATE = 0.05;

/** Tipos que o servidor aceita desfazer. */
export const UNDOABLE_TYPES = ["DEPOSIT", "WITHDRAW", "STORE_BUY"];

/** Filtros da aba Transações: mesmos valores da tela antiga (vão direto para a rota). */
export const TX_TYPES = [
	{ value: "ALL", label: "Todas as operações" },
	{ value: "DEPOSIT", label: "Vendas (DEPOSIT)" },
	{ value: "WITHDRAW", label: "Compras (WITHDRAW)" },
	{ value: "STORE_BUY", label: "Loja (STORE_BUY)" },
	{ value: "BONUS", label: "Bônus diário" },
	{ value: "ADMIN_ADJUST", label: "Ajustes do admin" },
	{ value: "UNDO_TRADE", label: "Estornos" }
];
export const TX_GAMES = [
	{ value: "ALL", label: "Todos os jogos" },
	{ value: "waifu", label: "Waifus (Zinthos)" },
	{ value: "jardim", label: "Jardim (Petalitas)" },
	{ value: "pesca", label: "Pesca (peixes)" },
	{ value: "slots", label: "Slots (moedas)" }
];
export const TX_STATUS = [
	{ value: "ALL", label: "Todos os status" },
	{ value: "COMPLETED", label: "Ativas (concluídas)" },
	{ value: "UNDONE", label: "Desfeitas (estornadas)" }
];

const OP_LABELS = {
	DEPOSIT: "Venda",
	WITHDRAW: "Compra",
	STORE_BUY: "Loja",
	BONUS: "Bônus",
	ADMIN_ADJUST: "Ajuste",
	UNDO_TRADE: "Estorno"
};

/** Rótulo da operação (tipo desconhecido aparece como veio). */
export const opLabel = (type) => OP_LABELS[type] || String(type || "—");

/** Telefone legível: 5511912345678 → "+55 (11) 91234-5678"; o resto volta como veio. */
export function formatPhone(id) {
	if (!id) return "Desconhecido";
	const d = String(id).replace(/\D/g, "");
	if (d.length === 13 && d.startsWith("55"))
		return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
	if (d.length === 12 && d.startsWith("55"))
		return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
	return String(id);
}

/** Valor com 2 casas fixas em pt-BR (1234.5 → "1.234,50"), como a tela antiga. */
export function money(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return "—";
	return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Jogo e quantidade do ativo de uma transação, como a tela antiga mostrava.
 * @returns {{ label: string, amount: string }}
 */
export function gameInfo(game, amount) {
	const g = String(game || "").toLowerCase();
	const n = Number(amount) || 0;
	if (g === "pesca") return { label: "Pesca", amount: `${fmt2(n)} kg` };
	if (g === "waifu" || g === "zinthos")
		return { label: "Waifus (Z)", amount: `${fmt(Math.round(n))} Z` };
	if (g === "jardim" || g === "fazenda")
		return { label: "Petalitas (Ptl)", amount: `${fmt(Math.round(n))} Ptl` };
	if (g === "moedas" || g === "slots")
		return { label: "Slots (moedas)", amount: `${fmt(Math.round(n))} un.` };
	if (g === "slots_prize") return { label: "Slots (prêmio)", amount: money(n) };
	if (g === "iscas" || g === "fishing")
		return { label: "Pesca (iscas)", amount: `${fmt(Math.round(n))} un.` };
	return { label: String(game || "—"), amount: money(n) };
}

function detailsOf(tx) {
	if (!tx || !tx.details_json) return {};
	if (typeof tx.details_json === "object") return tx.details_json;
	try {
		return JSON.parse(tx.details_json) || {};
	} catch {
		return {};
	}
}

/**
 * Sentido das Runas para o jogador: +1 entra, −1 sai.
 * Venda e bônus entram; ajuste segue o sinal gravado; estorno é o contrário da original.
 */
export function runasDirection(tx) {
	const t = tx && tx.type;
	if (t === "DEPOSIT" || t === "BONUS") return 1;
	if (t === "ADMIN_ADJUST") return Number(tx.runas_amount) < 0 ? -1 : 1;
	if (t === "UNDO_TRADE") return detailsOf(tx).originalType === "DEPOSIT" ? -1 : 1;
	return -1;
}

/** Runas com sinal: "+216,02" / "−73,09" (a coluna já diz "Runas"). */
export function runasSigned(tx) {
	const v = Math.abs(Number(tx && tx.runas_amount) || 0);
	return `${runasDirection(tx) < 0 ? "−" : "+"}${money(v)}`;
}

/** Pode desfazer? (tipo aceito e ainda não desfeita; mesma regra da tela antiga) */
export const canUndo = (tx) => !!tx && tx.status !== "UNDONE" && UNDOABLE_TYPES.includes(tx.type);

/**
 * Valor final sugerido no desfazer (o admin pode trocar antes de confirmar).
 * Venda: debita o que recebeu + 5%. Compra/loja: reembolsa o que pagou − 5% (mínimo 0).
 * @returns {{ fee: number, final: number, debit: boolean }}
 */
export function undoDefault(tx) {
	const amount = Number(tx && tx.runas_amount) || 0;
	const fee = Number((amount * UNDO_FEE_RATE).toFixed(2));
	const debit = tx && tx.type === "DEPOSIT";
	const final = debit
		? Number((amount + fee).toFixed(2))
		: Number(Math.max(0, amount - fee).toFixed(2));
	return { fee, final, debit };
}

/**
 * Lê um número digitado em pt-BR ou com ponto: "1.234,5", "1234.5", "1234". NaN se inválido.
 */
export function parseNumber(text) {
	let s = String(text ?? "")
		.trim()
		.replace(/\s/g, "")
		.replace(/^−/, "-");
	if (!s) return NaN;
	if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
	if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return NaN;
	return Number(s);
}

/**
 * Valor do ajuste de saldo. A rota grava o saldo final (absoluto); aqui o admin pode digitar
 * o saldo novo ("1500") ou uma diferença com sinal ("+500", "-200", "−200").
 * @param {string} text
 * @param {number} current - saldo atual
 * @returns {{ ok: true, target: number, diff: number, relative: boolean } | { ok: false, error: string }}
 */
export function parseAdjust(text, current) {
	const raw = String(text ?? "").trim();
	const relative = /^[+\-−]/.test(raw);
	const n = parseNumber(raw);
	if (!Number.isFinite(n))
		return { ok: false, error: "Digite um número (ex.: 1500, +500 ou −200)." };
	const base = Number(current) || 0;
	const target = Math.round((relative ? base + n : n) * 100) / 100;
	if (target < 0) return { ok: false, error: "O saldo não pode ficar negativo." };
	return { ok: true, target, diff: Math.round((target - base) * 100) / 100, relative };
}

/**
 * Valor da variável var-jogador do painel "jogador" do Grafana: a "pessoa" do analytics
 * (telefone canônico, com o 9 nos celulares do Brasil; ID longo de WhatsApp vira lid:<dígitos>).
 * Mesma regra do IdentityResolver (src/services/EconomyAnalyticsPlayers.js) sem a tabela de LIDs.
 */
export function grafanaPerson(userId) {
	const d = String(userId ?? "")
		.split(/[@:]/)[0]
		.replace(/\D/g, "");
	if (!d) return String(userId ?? "");
	if (d.length > 13) return `lid:${d}`;
	if (d.startsWith("55") && d.length === 12) return `55${d.slice(2, 4)}9${d.slice(4)}`;
	return d;
}

/**
 * Páginas visíveis ao redor da atual (até `max`).
 * pageWindow(7, 20) → [5, 6, 7, 8, 9]
 */
export function pageWindow(current, total, max = 5) {
	const t = Math.max(1, Number(total) || 1);
	const c = Math.min(t, Math.max(1, Number(current) || 1));
	let start = Math.max(1, c - Math.floor(max / 2));
	const end = Math.min(t, start + max - 1);
	start = Math.max(1, end - max + 1);
	const out = [];
	for (let p = start; p <= end; p++) out.push(p);
	return out;
}

/** Página do endereço (?p=), mínimo 1. */
export const pageOf = (params) => Math.max(1, parseInt(params && params.get("p"), 10) || 1);

/**
 * Consulta da rota de transações a partir do endereço (#/banco/transacoes?q=&tipo=&jogo=&status=&p=).
 * Valor fora da lista vira ALL (a rota ignora ALL).
 */
export function txQuery(params, limit = PAGE_SIZE) {
	const pick = (key, list) => {
		const v = params ? params.get(key) : null;
		return list.some((o) => o.value === v) ? v : "ALL";
	};
	return new URLSearchParams({
		page: String(pageOf(params)),
		limit: String(limit),
		q: (params && params.get("q")) || "",
		type: pick("tipo", TX_TYPES),
		game: pick("jogo", TX_GAMES),
		status: pick("status", TX_STATUS)
	});
}
