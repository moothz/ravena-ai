#!/usr/bin/env node
/**
 * Recarrega os FLUXOS de uma janela no painel da economia (motivo novo mapeado, extrato corrigido no
 * serviço), sem mexer nos saldos. Rode da raiz do projeto (/app no contêiner):
 *   docker exec ravena-ai node scripts/economy-reload.js --moeda zinthos --de 2026-11-01 --ate 2026-11-15
 *   docker exec ravena-ai node scripts/economy-reload.js --moeda runas --de 2026-10-01 --ate 2026-11-01 --saldos-runas
 *
 * Datas: YYYY-MM-DD = início do dia econômico (04:00 BRT, 07:00 UTC) ou ISO 8601 em hora cheia.
 * Janela [de, ate), no máximo 90 dias e só dentro do que já foi carregado.
 * Regrava só flows_hourly da janela (idempotente) e republica o retrato do Grafana (mesma trava e
 * mesma guarda de caminhos da carga). Saldos ficam como estão; com --saldos-runas (só Runas) os
 * retratos diários que faltam na janela são preenchidos a partir do bank.db (aberto só-leitura).
 */
"use strict";

require("dotenv").config({ quiet: true });
const EconomyAnalyticsService = require("../src/services/EconomyAnalyticsService");

function parseArgs(argv) {
	const out = { saldosRunas: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--saldos-runas") out.saldosRunas = true;
		else if (a === "--moeda") out.moeda = argv[++i];
		else if (a === "--de") out.de = argv[++i];
		else if (a === "--ate") out.ate = argv[++i];
		else throw new Error(`argumento desconhecido: ${a}`);
	}
	return out;
}

function parseDate(v, name) {
	if (!v) throw new Error(`falta --${name}`);
	const ts = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T07:00:00Z`) : Date.parse(v);
	if (!Number.isFinite(ts)) throw new Error(`data inválida em --${name}: ${v}`);
	return ts;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!["zinthos", "petalitas", "runas"].includes(args.moeda)) {
		throw new Error("--moeda precisa ser zinthos, petalitas ou runas");
	}
	const from = parseDate(args.de, "de");
	const to = parseDate(args.ate, "ate");
	const svc = new EconomyAnalyticsService({ sources: [args.moeda] });
	try {
		const r = await svc.reloadFlows(args.moeda, from, to, { runasBalances: args.saldosRunas });
		console.log(
			`${args.moeda}: [${new Date(from).toISOString()}, ${new Date(to).toISOString()}) recarregado — ` +
				`${r.flows} linhas de fluxo${args.saldosRunas ? `, ${r.snapshots} retratos diários preenchidos` : ""}; saldos intactos.`
		);
	} finally {
		await svc.stop();
	}
}

main().catch((err) => {
	console.error(`Recusado: ${err.message}`);
	console.error(
		"Uso: node scripts/economy-reload.js --moeda <zinthos|petalitas|runas> --de <data> --ate <data> [--saldos-runas]"
	);
	process.exit(1);
});
