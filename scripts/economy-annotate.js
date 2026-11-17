#!/usr/bin/env node
/**
 * Registra uma anotação no painel da economia (mudança de regra, correção de extrato) e republica
 * o retrato lido pelo Grafana. Sem sqlite3 no host/imagem, rode dentro do contêiner:
 *   docker exec ravena-ai node scripts/economy-annotate.js "Taxa de hospedagem reajustada" zinthos
 *   docker exec ravena-ai node scripts/economy-annotate.js "Correção do extrato" todas 2026-11-20T15:00:00-03:00
 * Moeda: zinthos | petalitas | runas | todas (padrão). Data: ISO 8601 (padrão: agora).
 */
"use strict";

require("dotenv").config({ quiet: true });
const { EconomyAnalyticsStore } = require("../src/services/EconomyAnalyticsStore");

const [label, moedaArg = "todas", when] = process.argv.slice(2);
const MOEDAS = ["zinthos", "petalitas", "runas", "todas"];
if (!label || !MOEDAS.includes(moedaArg)) {
	console.error(
		'Uso: node scripts/economy-annotate.js "<texto>" [zinthos|petalitas|runas|todas] [data ISO]'
	);
	process.exit(1);
}
const ts = when ? Date.parse(when) : Date.now();
if (!Number.isFinite(ts)) {
	console.error(`Data inválida: ${when}`);
	process.exit(1);
}

const store = new EconomyAnalyticsStore();
try {
	store.addAnnotation(ts, moedaArg === "todas" ? null : moedaArg, label);
	const published = store.publish();
	console.log(
		`Anotação gravada em ${new Date(ts).toISOString()} (${moedaArg}) e publicada em ${published}.`
	);
} finally {
	store.close();
}
