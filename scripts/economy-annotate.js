#!/usr/bin/env node
/**
 * Anotações do painel da economia (mudança de regra, correção de extrato). Rode da raiz do projeto
 * (/app no contêiner): o script lê o .env e resolve os caminhos padrão a partir dela.
 *   docker exec ravena-ai node scripts/economy-annotate.js "Taxa de hospedagem reajustada" zinthos 2026-11-20T15:00:00-03:00
 *   docker exec ravena-ai node scripts/economy-annotate.js --export > anotacoes.json
 *   docker exec -i ravena-ai node scripts/economy-annotate.js --import < anotacoes.json
 * Moeda: zinthos | petalitas | runas | todas (padrão). Data: ISO 8601 (padrão: agora). A anotação só
 * aparece no gráfico quando a data cai no intervalo mostrado.
 * Depois de gravar, republica o retrato do Grafana (se a carga estiver publicando, aparece na próxima).
 */
"use strict";

require("dotenv").config({ quiet: true });
const fs = require("fs");
const { EconomyAnalyticsStore } = require("../src/services/EconomyAnalyticsStore");

const MOEDAS = ["zinthos", "petalitas", "runas", "todas"];
const args = process.argv.slice(2);

function fail(msg) {
	console.error(msg);
	process.exit(1);
}

async function publish(store) {
	try {
		return `publicada em ${await store.publish()}`;
	} catch (err) {
		return `gravada; aparece no Grafana na próxima carga (${err.message})`;
	}
}

async function main(store) {
	if (args[0] === "--export") {
		process.stdout.write(`${JSON.stringify(store.listAnnotations(), null, 1)}\n`);
	} else if (args[0] === "--import") {
		const list = JSON.parse(fs.readFileSync(0, "utf8"));
		if (!Array.isArray(list)) fail("Esperava uma lista JSON (saída do --export).");
		for (const a of list) {
			if (!Number.isFinite(Number(a.ts)) || !a.label)
				fail(`Anotação inválida: ${JSON.stringify(a)}`);
			store.addAnnotation(
				Number(a.ts),
				a.currency || null,
				String(a.label),
				a.origin || null,
				a.detail ?? null
			);
		}
		console.log(`${list.length} anotações importadas; ${await publish(store)}.`);
	} else {
		const [label, moeda = "todas", when] = args;
		if (!label || !MOEDAS.includes(moeda)) {
			fail(
				'Uso: node scripts/economy-annotate.js "<texto>" [zinthos|petalitas|runas|todas] [data ISO]\n' +
					"     node scripts/economy-annotate.js --export | --import (stdin)"
			);
		}
		const ts = when ? Date.parse(when) : Date.now();
		if (!Number.isFinite(ts)) fail(`Data inválida: ${when}`);
		store.addAnnotation(ts, moeda === "todas" ? null : moeda, label);
		console.log(`Anotação em ${new Date(ts).toISOString()} (${moeda}) ${await publish(store)}.`);
	}
}

const store = new EconomyAnalyticsStore();
main(store)
	.catch((err) => {
		console.error(err.message);
		process.exitCode = 1;
	})
	.finally(() => store.close());
