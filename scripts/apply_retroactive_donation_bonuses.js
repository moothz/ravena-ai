/**
 * Script de aplicação retroativa de bônus para doadores
 * Uso:
 *   Simulação (não altera nada): node scripts/apply_retroactive_donation_bonuses.js --dry-run
 *   Execução real:             node scripts/apply_retroactive_donation_bonuses.js
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const Database = require("../src/utils/Database");
const DonorBonusService = require("../src/services/DonorBonusService");
const Logger = require("../src/utils/Logger");

const logger = new Logger("apply-retroactive-bonuses");
const database = Database.getInstance();

async function main() {
	const isDryRun = process.argv.includes("--dry-run");

	console.log("==================================================================");
	console.log(
		`🚀 SCRIPT DE BÔNUS RETROATIVOS PARA DOADORES [${isDryRun ? "DRY-RUN / SIMULAÇÃO" : "MODO REAL"}]`
	);
	console.log("==================================================================\n");

	const donations = await database.getDonations();
	if (!donations || donations.length === 0) {
		console.log("Nenhum doador encontrado na base de dados.");
		return;
	}

	const eligibleDonors = donations.filter(
		(d) => d.numero && String(d.numero).trim().length > 5 && (Number(d.valor) || 0) > 0
	);
	const donorsWithoutNumber = donations.filter(
		(d) => (!d.numero || String(d.numero).trim().length <= 5) && (Number(d.valor) || 0) > 0
	);

	console.log(`📋 Total de doadores cadastrados: ${donations.length}`);
	console.log(`✅ Doadores com número vinculado (elegíveis): ${eligibleDonors.length}`);
	console.log(`⚠️  Doadores sem número vinculado: ${donorsWithoutNumber.length}\n`);

	if (donorsWithoutNumber.length > 0) {
		console.log("--- Doadores que receberão bônus assim que vincularem o número: ---");
		donorsWithoutNumber.forEach((d) => {
			console.log(`  • ${d.nome}: R$ ${Number(d.valor).toFixed(2)}`);
		});
		console.log("------------------------------------------------------------------\n");
	}

	console.log("--- Processamento dos Doadores Elegíveis: ---\n");

	let totalBaitsAwarded = 0;
	let totalCoinsAwarded = 0;
	let totalItemsAwarded = 0;
	let donorsProcessed = 0;

	for (const donor of eligibleDonors) {
		const totalAmount = Number(donor.valor) || 0;
		const previousAmount = Number(donor.bonusesProcessedAmount) || 0;

		const res = await DonorBonusService.awardDonorBonuses(donor, totalAmount, previousAmount, {
			dryRun: isDryRun
		});

		if (res.success && res.delta && res.delta.deltaAmount > 0) {
			donorsProcessed++;
			totalBaitsAwarded += res.delta.deltaBaits;
			totalCoinsAwarded += res.delta.deltaCoins;
			totalItemsAwarded += res.chosenItems?.length || 0;

			console.log(`👤 Doador: ${donor.nome}`);
			console.log(`   📱 Número: ${res.cleanNumber}`);
			console.log(
				`   💰 Total doado: R$ ${totalAmount.toFixed(2)} (Processado antes: R$ ${previousAmount.toFixed(2)} | Delta: R$ ${res.delta.deltaAmount.toFixed(2)})`
			);
			console.log(`   🎁 Bônus a conceder:`);
			console.log(`      🐛 Iscas: +${res.delta.deltaBaits}`);
			console.log(`      🪙 Moedas: +${res.delta.deltaCoins}`);
			console.log(
				`      🎒 Itens (${res.chosenItems?.length || 0}): ${res.chosenItems?.map((i) => i.name).join(", ") || "Nenhum"}`
			);
			console.log(
				`   💎 Bônus ativos em Waifus: Raros: +${Math.round(totalAmount * 2.0)}% | Épicos: +${Math.round(totalAmount * 3.5)}% | Lendários: +${Math.round(totalAmount * 4.5)}%`
			);
			console.log(`   🩺 Bônus no !pinto: +${Math.round(totalAmount * 1)}% tamanho`);
			console.log("");
		} else {
			console.log(
				`👤 Doador: ${donor.nome} (${donor.numero}): Sem bônus pendentes (Já processado: R$ ${previousAmount.toFixed(2)} / Total: R$ ${totalAmount.toFixed(2)})`
			);
		}
	}

	console.log("\n==================================================================");
	console.log("📊 RESUMO GERAL:");
	console.log(`   • Doadores com novos bônus: ${donorsProcessed}`);
	console.log(`   • Total de iscas concedidas: ${totalBaitsAwarded}`);
	console.log(`   • Total de moedas concedidas: ${totalCoinsAwarded}`);
	console.log(`   • Total de itens físicos sorteados: ${totalItemsAwarded}`);
	if (isDryRun) {
		console.log("\n⚠️  ESTA FOI UMA SIMULAÇÃO (--dry-run). Nenhuma alteração foi gravada.");
		console.log("   Para aplicar de verdade no banco, execute sem a flag --dry-run.");
	} else {
		console.log("\n✅ BÔNUS APLICADOS COM SUCESSO NO BANCO DE DADOS!");
	}
	console.log("==================================================================");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro fatal no script:", err);
		process.exit(1);
	});
