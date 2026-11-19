#!/usr/bin/env node
/**
 * Anotações do painel da economia (mudança de regra, correção de extrato). Rode da raiz do projeto
 * (/app no contêiner): o script lê o .env e resolve os caminhos padrão a partir dela.
 *   docker exec ravena-ai node scripts/economy-annotate.js "Taxa de hospedagem reajustada" zinthos 2026-11-20T15:00:00-03:00
 *   docker exec ravena-ai node scripts/economy-annotate.js --export > anotacoes.json
 *   docker exec -i ravena-ai node scripts/economy-annotate.js --import < anotacoes.json
 *   docker exec ravena-ai node scripts/economy-annotate.js --listar
 *   docker exec ravena-ai node scripts/economy-annotate.js --confirmar 1763700000000 "motivo novo: Prêmio X"
 *   docker exec ravena-ai node scripts/economy-annotate.js --descartar 1763700000000 "motivo novo: Prêmio X"
 * Moeda: zinthos | petalitas | runas | todas (padrão). Data: ISO 8601 (padrão: agora). A anotação só
 * aparece no gráfico quando a data cai no intervalo mostrado.
 * As mudanças automáticas (parâmetro de balanceamento mudou) e as possíveis (detectadas nos dados) são
 * gravadas pela carga; --confirmar e --descartar decidem uma possível (ts em ms ou ISO, como no --listar).
 * Descartada sai da aba Mudanças e das marcas nos gráficos, mas continua no banco.
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
	if (args[0] === "--listar") {
		for (const a of store.listAnnotations().slice(-30)) {
			console.log(
				`${a.ts}  ${new Date(a.ts).toISOString()}  ${(a.origin || "manual").padEnd(10)}  ${(a.currency || "todas").padEnd(9)}  ${a.label}`
			);
		}
	} else if (args[0] === "--confirmar" || args[0] === "--descartar") {
		const [, when, label] = args;
		const ts = /^\d+$/.test(String(when)) ? Number(when) : Date.parse(when);
		if (!Number.isFinite(ts) || !label) {
			fail(
				`Uso: node scripts/economy-annotate.js ${args[0]} <ts em ms ou ISO> "<texto>" (ver --listar)`
			);
		}
		const origin = args[0] === "--confirmar" ? "confirmada" : "descartada";
		if (!store.setAnnotationOrigin(ts, label, origin))
			fail("Anotação não encontrada (ver --listar).");
		console.log(`Anotação ${origin}; ${await publish(store)}.`);
	} else if (args[0] === "--export") {
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
					"     node scripts/economy-annotate.js --export | --import (stdin) | --listar\n" +
					'     node scripts/economy-annotate.js --confirmar|--descartar <ts> "<texto>"'
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
