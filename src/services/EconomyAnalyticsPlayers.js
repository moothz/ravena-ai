/**
 * EconomyAnalyticsPlayers.js
 *
 * Detalhe por jogador do painel da economia (dashboard "Ravena — Jogadores"):
 *   - identidade: une o mesmo jogador entre moedas (waifuletes, Jardim e bank.db usam o número antes do
 *     @ ou do :), resolve LID do WhatsApp para telefone pela tabela memory_identities (memory.db, só
 *     leitura) e junta as variantes de 12 e 13 dígitos dos celulares do Brasil (como o PhoneUtils);
 *   - Runas por jogador e por dia a partir do bank.db (só leitura), no formato de
 *     `GET /internal/economy/players` dos serviços;
 *   - atividade (comandos usados) a partir do cmd_usage.db (só leitura).
 *
 * Decisão de produto: moeda de jogo, sem valor financeiro; o painel mostra nome e telefone. O Grafana
 * só é acessado por túnel ou com senha.
 */
"use strict";

const {
	HOUR_MS,
	DAY_MS,
	DAY_OFFSET_MS,
	economicDayStart,
	classifyRunasTx,
	firstIdFrom
} = require("./EconomyAnalyticsRunas");

/** Parte do ID antes do @ ou do : (sufixo de JID, dispositivo). */
function rawId(id) {
	return String(id ?? "")
		.split(/[@:]/)[0]
		.trim();
}

/** Forma única de um telefone: celular do Brasil com 12 dígitos ganha o 9 (55 DD 9 XXXXXXXX). */
function canonicalPhone(digits) {
	const d = String(digits || "").replace(/\D/g, "");
	if (d.startsWith("55") && d.length === 12) return `55${d.slice(2, 4)}9${d.slice(4)}`;
	return d;
}

/** Maior telefone válido (E.164 tem até 15 dígitos, mas os LIDs do WhatsApp têm 14 ou mais). */
const MAX_PHONE_DIGITS = 13;

class IdentityResolver {
	/**
	 * @param {object[]} rows linhas de memory_identities (canonical_user_id, platform, platform_id,
	 *   id_type, display_name); vazio quando o memory.db não existe
	 */
	constructor(rows = []) {
		this.lidToPhone = new Map();
		this.telegram = new Set();
		this.names = new Map(); // pessoa → nome
		for (const r of rows) {
			const canonical = String(r.canonical_user_id || "");
			const platform = String(r.platform || "").toLowerCase();
			const pid = rawId(r.platform_id);
			const digits = pid.replace(/\D/g, "");
			let person = null;
			if (canonical.startsWith("wa_")) {
				const phone = canonicalPhone(canonical.slice(3));
				if (phone) person = phone;
				const isLid =
					String(r.id_type || "") === "lid" || String(r.platform_id || "").includes("@lid");
				if (isLid && digits && phone) this.lidToPhone.set(digits, phone);
			} else if (platform === "telegram" && digits) {
				this.telegram.add(digits);
				person = `tg:${digits}`;
			}
			const name = r.display_name ? String(r.display_name).trim() : "";
			if (person && name && !/^\d+$/.test(name)) this.names.set(person, name);
		}
	}

	/** Marca IDs que um serviço sabe serem do Telegram (waifuletes: users.platform). */
	addTelegram(ids) {
		for (const id of ids) {
			const d = rawId(id).replace(/\D/g, "");
			if (d) this.telegram.add(d);
		}
	}

	/**
	 * @returns {{person:string, phone:string|null, idKind:string, name:string|null}}
	 *   idKind: telefone | lid (resolvido para telefone) | lid sem telefone | telegram | outro
	 */
	resolve(id) {
		const raw = rawId(id);
		const d = /^\d+$/.test(raw) ? raw : "";
		let out;
		if (!d) out = { person: raw || String(id), phone: null, idKind: "outro" };
		else if (this.telegram.has(d)) out = { person: `tg:${d}`, phone: null, idKind: "telegram" };
		else if (this.lidToPhone.has(d)) {
			const phone = this.lidToPhone.get(d);
			out = { person: phone, phone, idKind: "lid" };
		} else if (d.length <= MAX_PHONE_DIGITS) {
			const phone = canonicalPhone(d);
			out = { person: phone, phone, idKind: "telefone" };
		} else out = { person: `lid:${d}`, phone: null, idKind: "lid sem telefone" };
		out.name = this.names.get(out.person) || null;
		return out;
	}
}

/** Lê memory_identities (só leitura). Sem a tabela, devolve []. */
function readIdentities(query) {
	try {
		return query(
			"SELECT canonical_user_id, platform, platform_id, id_type, display_name FROM memory_identities",
			[]
		);
	} catch (_) {
		return [];
	}
}

/**
 * Janelas diárias (dia econômico, 04:00 BRT) de `from` até `hourNow`: [início, min(fim do dia, hourNow)).
 * @returns {{day:number, from:number, to:number, complete:boolean}[]}
 */
function dayWindows(from, hourNow) {
	const out = [];
	for (let day = economicDayStart(from); day < hourNow; day += DAY_MS) {
		const to = Math.min(day + DAY_MS, hourNow);
		out.push({ day, from: Math.max(day, from), to, complete: to === day + DAY_MS });
	}
	return out;
}

/**
 * Runas por jogador para várias janelas diárias com uma leitura só do extrato: lê de `windows[0].from`
 * até agora, soma os fluxos de cada janela e reconstrói o saldo no fim de cada uma andando para trás a
 * partir do saldo atual (como balancesAt).
 * @param {(sql:string, params:any[]) => object[]} query leitura síncrona do bank.db
 * @returns {object[]} uma resposta por janela, no formato de /internal/economy/players
 */
function runasPlayerDays(query, windows, now) {
	if (!windows.length) return [];
	const start = windows[0].from;
	const rows = query(
		`SELECT user_id, type, game, runas_amount, details_json, timestamp
		 FROM bank_transactions
		 WHERE id >= ? AND timestamp >= ?
		   AND (status IS NULL OR status IN ('COMPLETED', 'UNDONE'))
		 ORDER BY timestamp DESC, id DESC`,
		[start > 0 ? firstIdFrom(query, start) : 0, start]
	);
	const balance = new Map();
	for (const r of query("SELECT user_id, runas FROM bank_accounts", [])) {
		balance.set(String(r.user_id), Number(r.runas) || 0);
	}
	const current = new Map(balance);
	const out = new Array(windows.length);
	let i = 0; // linhas já "desfeitas" (timestamp >= fim da janela atual)
	for (let w = windows.length - 1; w >= 0; w--) {
		const win = windows[w];
		// Desfaz tudo com timestamp >= win.to: saldo no fim da janela
		while (i < rows.length && Number(rows[i].timestamp) >= win.to) {
			const { amountIn, amountOut } = classifyRunasTx(rows[i]);
			const u = String(rows[i].user_id);
			balance.set(u, (balance.get(u) || 0) - amountIn + amountOut);
			i++;
		}
		const atEnd = new Map(balance);
		const flows = new Map();
		let j = i;
		while (j < rows.length && Number(rows[j].timestamp) >= win.from) {
			const { reason, amountIn, amountOut } = classifyRunasTx(rows[j]);
			const u = String(rows[j].user_id);
			const key = `${u}|${reason}`;
			let f = flows.get(key);
			if (!f) {
				f = { id: u, reason, amountIn: 0, amountOut: 0, count: 0 };
				flows.set(key, f);
			}
			f.amountIn += amountIn;
			f.amountOut += amountOut;
			f.count += 1;
			j++;
		}
		const active = new Set([...flows.values()].map((f) => f.id));
		const players = [];
		for (const [id, bal] of current) {
			if (Math.round(bal) === 0 && !active.has(id)) continue;
			players.push({
				id,
				name: null,
				platform: null,
				balance: Math.round(bal),
				balanceAtWindowEnd: Math.round(atEnd.get(id) || 0),
				lastActiveAt: null
			});
		}
		for (const id of active) {
			if (!current.has(id)) {
				players.push({
					id,
					name: null,
					platform: null,
					balance: 0,
					balanceAtWindowEnd: Math.round(atEnd.get(id) || 0),
					lastActiveAt: null
				});
			}
		}
		out[w] = {
			currency: "runas",
			schemaVersion: 1,
			generatedAt: now,
			window: { from: win.from, to: win.to },
			ledger: { available: true },
			players,
			flows: [...flows.values()].map((f) => ({
				...f,
				amountIn: Math.round(f.amountIn),
				amountOut: Math.round(f.amountOut)
			}))
		};
	}
	return out;
}

// Mesmo filtro do resumo semanal (WeeklyGameDigestService): sem comandos automáticos nem interações
// passivas.
const CMD_FILTER = "type NOT IN ('auto') AND NOT (command = 'interagir' AND args = 'false')";

/**
 * Atividade em [from, to) a partir do cmd_usage_log: por hora (comandos e pessoas distintas), por dia
 * e comando, e por dia e usuário. Agregado no SQLite.
 * @param {(sql:string, params:any[]) => object[]} query leitura síncrona do cmd_usage.db
 */
function readActivity(query, from, to) {
	const firstId = from > 0 ? firstIdFrom(query, from, "cmd_usage_log") : 0;
	const where = `id >= ? AND timestamp >= ? AND timestamp < ? AND ${CMD_FILTER}`;
	const params = [firstId, from, to];
	const hourly = query(
		`SELECT (timestamp / ${HOUR_MS}) * ${HOUR_MS} AS hour, COUNT(*) AS uses, COUNT(DISTINCT user) AS users
		 FROM cmd_usage_log WHERE ${where} GROUP BY 1`,
		params
	);
	const dayExpr = `((timestamp - ${DAY_OFFSET_MS}) / ${DAY_MS}) * ${DAY_MS} + ${DAY_OFFSET_MS}`;
	const byCommand = query(
		`SELECT ${dayExpr} AS day, command, COUNT(*) AS uses, COUNT(DISTINCT user) AS users
		 FROM cmd_usage_log WHERE ${where} GROUP BY 1, 2`,
		params
	);
	const byUser = query(
		`SELECT ${dayExpr} AS day, user, COUNT(*) AS uses
		 FROM cmd_usage_log WHERE ${where} GROUP BY 1, 2`,
		params
	);
	return { hourly, byCommand, byUser };
}

module.exports = {
	rawId,
	canonicalPhone,
	IdentityResolver,
	readIdentities,
	dayWindows,
	runasPlayerDays,
	readActivity
};
