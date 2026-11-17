/**
 * scripts/distribute-retroactive-rolls.js
 *
 * Concede retroativamente bônus de rolls no Waifuletes para doações dos últimos 14 dias:
 * - A cada R$ 10 doados nos últimos 14 dias: +75 rolls.
 * - Teto máximo de 150 rolls por doador (para evitar super spam).
 * - Inicializa rollsProcessedAmount e runasProcessedAmount para todos os doadores.
 *
 * Uso:
 *   node scripts/distribute-retroactive-rolls.js            # Simulação (dry-run)
 *   node scripts/distribute-retroactive-rolls.js --apply    # Aplica alterações no banco e credita via API
 */

const Database = require("../src/utils/Database");
const DonorBonusService = require("../src/services/DonorBonusService");
const Logger = require("../src/utils/Logger");

const logger = new Logger("distribute-retroactive-rolls");
const db = Database.getInstance();

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_RETROACTIVE_ROLLS = 150;

async function run() {
	const isApply = process.argv.includes("--apply");
	const now = Date.now();
	const cutoff = now - FOURTEEN_DAYS_MS;

	console.log("==================================================================");
	console.log(`  DISTRIBUIÇÃO RETROATIVA DE ROLLS WAIFULETES (ÚLTIMOS 14 DIAS)  `);
	console.log(`  Modo: ${isApply ? "APLICAR (--apply)" : "SIMULAÇÃO (DRY-RUN)"}`);
	console.log(`  Data de corte (14 dias): ${new Date(cutoff).toLocaleString("pt-BR")}`);
	console.log("==================================================================\n");

	const donors = await db.getDonations();
	console.log(`Total de doadores cadastrados: ${donors.length}\n`);

	const toAward = [];
	let totalRollsAwarded = 0;
	let totalEligibleDonors = 0;

	for (const donor of donors) {
		const totalValor = Number(donor.valor) || 0;
		const historico = Array.isArray(donor.historico) ? donor.historico : [];

		// Filtra doações dentro da janela dos últimos 14 dias
		const recentEntries = historico.filter((h) => Number(h.ts || 0) >= cutoff);
		const recentSum = recentEntries.reduce((sum, h) => sum + (Number(h.valor) || 0), 0);

		const rawRolls = Math.floor(recentSum / 10) * 75;
		const rollsToCredit = Math.min(MAX_RETROACTIVE_ROLLS, rawRolls);

		if (rollsToCredit > 0) {
			totalEligibleDonors++;
			totalRollsAwarded += rollsToCredit;
			toAward.push({
				donor,
				recentSum,
				rawRolls,
				rollsToCredit,
				recentCount: recentEntries.length
			});
		}
	}

	console.log(`--- DOADORES ELEGÍVEIS (${toAward.length}) ---`);
	console.table(
		toAward.map((item) => ({
			Nome: item.donor.nome,
			Número: item.donor.numero || "(sem número)",
			"Total Histórico (R$)": `R$ ${item.donor.valor.toFixed(2)}`,
			"Últimos 14d (R$)": `R$ ${item.recentSum.toFixed(2)}`,
			"Rolls Calculados": item.rawRolls,
			"Rolls a Creditar (Cap 150)": item.rollsToCredit,
			Status: !item.donor.numero ? "⚠️ Sem número" : isApply ? "Pronto" : "Simulado"
		}))
	);

	console.log(`\nResumo:`);
	console.log(`- Doadores elegíveis: ${totalEligibleDonors}`);
	console.log(`- Total de rolls a distribuir: ${totalRollsAwarded}`);

	if (!isApply) {
		console.log("\n💡 Para aplicar de verdade, execute com a flag --apply:");
		console.log("   node scripts/distribute-retroactive-rolls.js --apply\n");
		process.exit(0);
	}

	console.log("\n--- EXECUTANDO ATRIBUIÇÃO E ATUALIZAÇÕES NO BANCO ---");
	let successCount = 0;
	let errorCount = 0;
	let skippedNoNumber = 0;

	for (const item of toAward) {
		const { donor, rollsToCredit, recentSum } = item;
		const cleanNumber = donor.numero ? String(donor.numero).replace(/\D/g, "") : null;

		if (!cleanNumber) {
			console.log(`[PULADO] ${donor.nome}: sem número cadastrado.`);
			skippedNoNumber++;
			// Mesmo sem número, inicializa o valor processado para quando ele cadastrar o número
			await db.updateDonorRollsProcessed(donor.nome, donor.valor);
			await db.updateDonorRunasProcessed(donor.nome, donor.valor);
			continue;
		}

		try {
			console.log(
				`[CREDITANDO] ${donor.nome} (${cleanNumber}): +${rollsToCredit} rolls (Doações 14d: R$ ${recentSum.toFixed(2)})...`
			);
			await DonorBonusService.creditWaifuRolls(
				cleanNumber,
				rollsToCredit,
				donor.valor,
				"DONATE_RETROACTIVE_14D"
			);
			await db.updateDonorRollsProcessed(donor.nome, donor.valor);
			await db.updateDonorRunasProcessed(donor.nome, donor.valor);
			successCount++;
			console.log(`  ✓ Sucesso para ${donor.nome}!`);
		} catch (err) {
			errorCount++;
			console.error(`  ❌ Erro ao creditar para ${donor.nome} (${cleanNumber}): ${err.message}`);
			// Atualiza processado mesmo assim se for para manter consistência
			await db.updateDonorRollsProcessed(donor.nome, donor.valor);
			await db.updateDonorRunasProcessed(donor.nome, donor.valor);
		}
	}

	// Atualiza os doadores NÃO elegíveis (doações antigas ou < R$10 nos últimos 14d)
	// para que seus rollsProcessedAmount e runasProcessedAmount fiquem alinhados com o total atual,
	// prevenindo bugs em doações futuras
	console.log("\n--- SINCRONIZANDO MARCAS DE PROCESSAMENTO DOS DEMAIS DOADORES ---");
	let syncedOthers = 0;
	const eligibleNames = new Set(toAward.map((a) => a.donor.nome.toLowerCase()));

	for (const donor of donors) {
		if (!eligibleNames.has(donor.nome.toLowerCase())) {
			await db.updateDonorRollsProcessed(donor.nome, donor.valor);
			await db.updateDonorRunasProcessed(donor.nome, donor.valor);
			syncedOthers++;
		}
	}

	console.log(`✓ Sincronizados ${syncedOthers} outros doadores.`);
	console.log(`\n==================================================================`);
	console.log(`CONCLUÍDO!`);
	console.log(`Sucessos: ${successCount}`);
	console.log(`Erros: ${errorCount}`);
	console.log(`Sem número: ${skippedNoNumber}`);
	console.log(`Outros doadores sincronizados: ${syncedOthers}`);
	console.log(`==================================================================`);
	process.exit(0);
}

run().catch((err) => {
	console.error("Erro fatal na execução do script:", err);
	process.exit(1);
});
