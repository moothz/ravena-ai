#!/usr/bin/env node
/**
 * Estado da carga do painel da economia (sem sqlite3 no host/imagem). Rode da raiz do projeto (/app no
 * contêiner): lê o .env e resolve os caminhos padrão a partir dela.
 *   docker exec ravena-ai node scripts/economy-status.js
 * Mostra, por fonte, até quando os dados estão carregados, a última tentativa e o último erro, e se o
 * retrato publicado para o Grafana existe. Só lê o banco de trabalho (só-leitura) e não imprime dado de
 * jogador (o banco tem nome e telefone na página Jogadores; este script mostra só contagens).
 */
"use strict";

require("dotenv").config({ quiet: true });
const fs = require("fs");
const BetterSQLite = require("better-sqlite3");
const {
	resolvePath,
	DEFAULT_DB_PATH,
	DEFAULT_PUBLISH_DIR
} = require("../src/services/EconomyAnalyticsStore");

const dbPath = resolvePath(process.env.ECONOMY_ANALYTICS_DB, DEFAULT_DB_PATH);
const publishDir = resolvePath(process.env.ECONOMY_ANALYTICS_PUBLISH_DIR, DEFAULT_PUBLISH_DIR);
const fmt = (ms) =>
	ms === null || ms === undefined ? "-" : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

console.log(`ECONOMY_ANALYTICS_ENABLED=${process.env.ECONOMY_ANALYTICS_ENABLED || "(vazio)"}`);
if (!fs.existsSync(dbPath)) {
	console.log(
		`Banco de trabalho ainda não existe: ${dbPath} (a primeira carga roda cerca de 1 minuto depois da subida).`
	);
	process.exit(0);
}
const db = new BetterSQLite(dbPath, { readonly: true });
const sources = db
	.prepare("SELECT DISTINCT source FROM load_runs ORDER BY source")
	.all()
	.map((r) => r.source);
console.log("\nfonte               dados até             última tentativa      ok  erro");
for (const s of sources) {
	const okTo = db
		.prepare("SELECT MAX(window_to) t FROM load_runs WHERE source = ? AND ok = 1")
		.get(s).t;
	const last = db
		.prepare("SELECT ts, ok, error FROM load_runs WHERE source = ? ORDER BY ts DESC LIMIT 1")
		.get(s);
	console.log(
		`${s.padEnd(20)}${fmt(okTo).padEnd(22)}${fmt(last.ts).padEnd(22)}${String(last.ok).padEnd(4)}${last.error || ""}`
	);
}
const ledger = db.prepare("SELECT currency, available FROM ledger_status ORDER BY currency").all();
console.log(
	`\nextrato: ${ledger.map((l) => `${l.currency}=${l.available ? "sim" : "não"}`).join(", ") || "-"}`
);
for (const t of ["flows_hourly", "balances", "received_by_quintile", "annotations"]) {
	console.log(`${t}: ${db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n} linhas`);
}
const unknown = db
	.prepare(
		"SELECT currency, reason FROM flows_hourly WHERE kind = 'unknown' GROUP BY currency, reason"
	)
	.all();
if (unknown.length)
	console.log(
		`motivos sem mapeamento: ${unknown.map((u) => `${u.currency}/${u.reason}`).join(", ")}`
	);
db.close();
const pub = `${publishDir}/analytics.db`;
console.log(
	fs.existsSync(pub)
		? `\nretrato do Grafana: ${pub} (atualizado ${fmt(fs.statSync(pub).mtimeMs)})`
		: `\nretrato do Grafana ainda não publicado: ${pub}`
);
