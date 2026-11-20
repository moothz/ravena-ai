#!/usr/bin/env node
/**
 * Anotações do painel da economia (mudança de regra, correção de extrato). Rode da raiz do projeto
 * (/app no contêiner): o script lê o .env e resolve os caminhos padrão a partir dela.
 *   docker exec ravena-ai node scripts/economy-annotate.js "Taxa de hospedagem reajustada" zinthos 2026-11-20T15:00:00-03:00
 *   docker exec ravena-ai node scripts/economy-annotate.js --listar [--possiveis]
 *   docker exec ravena-ai node scripts/economy-annotate.js --confirmar 42 ["texto novo"]
 *   docker exec ravena-ai node scripts/economy-annotate.js --descartar 42
 *   docker exec ravena-ai node scripts/economy-annotate.js --export > anotacoes.json
 *   docker exec -i ravena-ai node scripts/economy-annotate.js --import < anotacoes.json
 * Moeda: zinthos | petalitas | runas | todas (padrão). Data: ISO 8601 (padrão: agora). A anotação só
 * aparece no gráfico quando a data cai no intervalo mostrado.
 * As mudanças automáticas (parâmetro de balanceamento mudou) e as possíveis (detectadas nos dados) são
 * gravadas pela carga. --confirmar e --descartar decidem uma possível pelo id do --listar (ainda aceitam a
 * forma antiga: <ts em ms ou ISO> "<texto>"); manual e automática não se decidem. Descartada sai da aba
 * Mudanças e das marcas nos gráficos, mas continua no banco. --import só acrescenta: anotação que já
 * existe (mesma hora e texto) fica como está, com a origem e o detalhe dela.
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

const USO =
	'Uso: node scripts/economy-annotate.js "<texto>" [zinthos|petalitas|runas|todas] [data ISO]\n' +
	"     node scripts/economy-annotate.js --listar [--possiveis]\n" +
	'     node scripts/economy-annotate.js --confirmar <id> ["texto novo"] | --descartar <id>\n' +
	"     node scripts/economy-annotate.js --export | --import (stdin)";

/** <id> do --listar, ou a forma antiga <ts> "<texto>". */
function parseRef(rest) {
	const [first, second] = rest;
	if (/^\d{1,9}$/.test(String(first))) return { ref: { id: Number(first) }, text: second || null };
	const ts = /^\d+$/.test(String(first)) ? Number(first) : Date.parse(first);
	if (!Number.isFinite(ts) || !second) fail(USO);
	return { ref: { ts, label: second }, text: null };
}

async function main(store) {
	if (args[0] === "--listar") {
		const possiveis = args.includes("--possiveis");
		const list = store.listAnnotations({ withId: true, origin: possiveis ? "possivel" : null });
		for (const a of possiveis ? list : list.slice(-30)) {
			console.log(
				`${String(a.id).padStart(5)}  ${new Date(a.ts).toISOString()}  ${(a.origin || "manual").padEnd(10)}  ${(a.currency || "todas").padEnd(9)}  ${a.label}`
			);
		}
		if (!list.length)
			console.log(possiveis ? "Nenhuma possível mudança a decidir." : "Nenhuma anotação.");
	} else if (args[0] === "--confirmar" || args[0] === "--descartar") {
		const { ref, text } = parseRef(args.slice(1));
		const decision = args[0] === "--confirmar" ? "confirmada" : "descartada";
		const r = store.decideAnnotation(ref, decision, decision === "confirmada" ? text : null);
		if (!r.ok) fail(`Recusado: ${r.error} (ver --listar).`);
		console.log(
			`Anotação ${r.annotation.id} ${decision}: ${r.annotation.label}; ${await publish(store)}.`
		);
	} else if (args[0] === "--export") {
		process.stdout.write(`${JSON.stringify(store.listAnnotations(), null, 1)}\n`);
	} else if (args[0] === "--import") {
		const list = JSON.parse(fs.readFileSync(0, "utf8"));
		if (!Array.isArray(list)) fail("Esperava uma lista JSON (saída do --export).");
		let added = 0;
		for (const a of list) {
			if (!Number.isFinite(Number(a.ts)) || !a.label)
				fail(`Anotação inválida: ${JSON.stringify(a)}`);
			added += store.insertAnnotationIfMissing(
				Number(a.ts),
				a.currency || null,
				String(a.label),
				a.origin || null,
				a.detail ?? null
			);
		}
		console.log(
			`${added} de ${list.length} anotações importadas (as que já existiam ficaram como estão); ${await publish(store)}.`
		);
	} else {
		const [label, moeda = "todas", when] = args;
		if (!label || label.startsWith("--") || !MOEDAS.includes(moeda)) fail(USO);
		const ts = when ? Date.parse(when) : Date.now();
		if (!Number.isFinite(ts)) fail(`Data inválida: ${when}`);
		if (!store.insertAnnotationIfMissing(ts, moeda === "todas" ? null : moeda, label, "manual")) {
			fail("Já existe uma anotação com esse texto nessa hora (ver --listar).");
		}
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
