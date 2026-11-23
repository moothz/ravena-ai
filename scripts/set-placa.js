#!/usr/bin/env node
/**
 * Script para gerenciar manualmente o cache de placas de veículos (placas.db).
 *
 * Uso:
 *   docker exec ravena-ai node scripts/set-placa.js <placa> "<texto_da_resposta>" [--react=🚘]
 *   docker exec ravena-ai node scripts/set-placa.js --get <placa>
 *   docker exec ravena-ai node scripts/set-placa.js --del <placa>
 *   docker exec ravena-ai node scripts/set-placa.js --help
 */
"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

require("dotenv").config({ quiet: true });

const Database = require("../src/utils/Database");
const { validarPlaca } = require("../src/functions/PlacasCommands");

function showHelp() {
	console.log(`
🚘 Gerenciador de Placas (placas.db)

Uso:
  node scripts/set-placa.js <placa> "<mensagem_completa>" [--react=🚘]
  node scripts/set-placa.js --get <placa>
  node scripts/set-placa.js --del <placa>

Exemplos:
  # Definir/editar resposta de uma placa:
  node scripts/set-placa.js ABC1234 "🔎 Resultado para *ABC1234*:\n\n   🚘 *Modelo:* Ford Ka 1.0\n   📅 *Ano:* 2015"

  # Definir com emoji de reação customizado:
  node scripts/set-placa.js ABC1234 "🔎 Resultado para *ABC1234*..." --react=🏎️

  # Consultar o que está gravado localmente:
  node scripts/set-placa.js --get ABC1234

  # Remover a placa do cache (forçando nova busca via API na próxima consulta):
  node scripts/set-placa.js --del ABC1234
`);
}

async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		showHelp();
		return;
	}

	const db = Database.getInstance({ disableBackup: true });

	// Garante que a tabela exista
	db.getSQLiteDb(
		"placas",
		`
		CREATE TABLE IF NOT EXISTS placas (
			placa TEXT PRIMARY KEY,
			json_data TEXT
		);
		`
	);

	// Ação: Consultar placa (--get ou --ver)
	if (args[0] === "--get" || args[0] === "--ver") {
		const placaInput = args[1];
		if (!placaInput) {
			console.error("❌ Informe a placa a ser consultada: node scripts/set-placa.js --get <placa>");
			process.exit(1);
		}

		const { valid, placa } = validarPlaca(placaInput);
		if (!valid) {
			console.error(`❌ Placa inválida: "${placaInput}". Formato esperado: ABC1234 ou ABC1D23.`);
			process.exit(1);
		}

		const row = await db.dbGet(
			"placas",
			"SELECT json_data FROM placas WHERE placa = ? OR placa = ?",
			[`${placa}_false`, `${placa}_true`]
		);

		if (!row || !row.json_data) {
			console.log(`ℹ️ Placa "${placa.toUpperCase()}" não encontrada no cache local.`);
			return;
		}

		try {
			const parsed = JSON.parse(row.json_data);
			const dataGravada = parsed.timestamp
				? new Date(parsed.timestamp).toLocaleString("pt-BR")
				: "Desconhecida";

			console.log(`\n============================================================`);
			console.log(`🚗 Placa: ${placa.toUpperCase()}`);
			console.log(`📅 Data do cache: ${dataGravada}`);
			console.log(`⚡ Reação (emoji): ${parsed.data?.react || "🚘"}`);
			console.log(`🔄 FIPE atualizada: ${parsed.fipe_updated ? "Sim" : "Não"}`);
			console.log(`------------------------------------------------------------`);
			console.log(`💬 Mensagem que o bot responde:`);
			console.log(parsed.data?.msg || "(vazio)");
			console.log(`============================================================\n`);
		} catch (e) {
			console.error("❌ Erro ao decodificar JSON dos dados da placa:", e.message);
			process.exit(1);
		}
		return;
	}

	// Ação: Deletar placa (--del ou --remover)
	if (args[0] === "--del" || args[0] === "--remover") {
		const placaInput = args[1];
		if (!placaInput) {
			console.error("❌ Informe a placa a ser removida: node scripts/set-placa.js --del <placa>");
			process.exit(1);
		}

		const { valid, placa } = validarPlaca(placaInput);
		if (!valid) {
			console.error(`❌ Placa inválida: "${placaInput}". Formato esperado: ABC1234 ou ABC1D23.`);
			process.exit(1);
		}

		await db.dbRun("placas", "DELETE FROM placas WHERE placa IN (?, ?)", [
			`${placa}_false`,
			`${placa}_true`
		]);

		console.log(
			`✅ Placa "${placa.toUpperCase()}" removida do cache local. A próxima consulta via !placa buscará na API novamente.`
		);
		return;
	}

	// Ação: Inserir ou atualizar placa
	const placaInput = args[0];
	const { valid, placa } = validarPlaca(placaInput);
	if (!valid) {
		console.error(`❌ Placa inválida: "${placaInput}". Formato esperado: ABC1234 ou ABC1D23.`);
		process.exit(1);
	}

	let reactEmoji = "🚘";
	const textParts = [];

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--react=")) {
			reactEmoji = arg.replace("--react=", "").trim() || "🚘";
		} else {
			textParts.push(arg);
		}
	}

	const texto = textParts.join(" ").trim();
	if (!texto) {
		console.error("❌ Nenhuma mensagem informada para a placa.");
		console.error('Uso: node scripts/set-placa.js <placa> "<texto_da_resposta>" [--react=🚘]');
		process.exit(1);
	}

	const now = Date.now();
	const cacheEntry = {
		timestamp: now,
		data: {
			msg: texto,
			react: reactEmoji
		},
		fipe_updated: true,
		fipe_updated_ts: now
	};

	const jsonStr = JSON.stringify(cacheEntry);

	await db.dbRun("placas", "INSERT OR REPLACE INTO placas (placa, json_data) VALUES (?, ?)", [
		`${placa}_false`,
		jsonStr
	]);

	await db.dbRun("placas", "INSERT OR REPLACE INTO placas (placa, json_data) VALUES (?, ?)", [
		`${placa}_true`,
		jsonStr
	]);

	console.log(`✅ Placa "${placa.toUpperCase()}" salva com sucesso no cache local!`);
	console.log(`⚡ Reação associada: ${reactEmoji}`);
	console.log(`\n💬 Prévia da resposta salva:\n${texto}\n`);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro ao executar script:", err);
		process.exit(1);
	});
