/**
 * Script de verificação e relatório de bônus de rolls retroativos para doadores
 * Uso: node scripts/apply_retroactive_roll_bonuses.js
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const Database = require("../src/utils/Database");
const DonorBonusService = require("../src/services/DonorBonusService");

const database = Database.getInstance();

async function main() {
	console.log("==================================================================");
	console.log("🎟️ RELATÓRIO DE ROLLS MÁXIMOS RETROATIVOS PARA DOADORES (WAIFULETES)");
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
	console.log(
		`✅ Doadores com número vinculado (com rolls extras ativos): ${eligibleDonors.length}`
	);
	console.log(`⚠️  Doadores sem número vinculado: ${donorsWithoutNumber.length}\n`);

	console.log("--- Status dos Doadores Elegíveis: ---\n");

	let totalExtraRollsAwarded = 0;
	let donorsWithRollBonus = 0;

	for (const donor of eligibleDonors) {
		const totalAmount = Number(donor.valor) || 0;
		const bonuses = DonorBonusService.calculateBonuses(totalAmount);
		const extraRolls = bonuses.waifu.extraMaxRolls || 0;
		const totalMaxRolls = 10 + extraRolls;

		const cleanNumber = String(donor.numero).replace(/\D/g, "");

		if (extraRolls > 0) {
			donorsWithRollBonus++;
			totalExtraRollsAwarded += extraRolls;
			console.log(`👤 Doador: ${donor.nome}`);
			console.log(`   📱 Número: ${cleanNumber}`);
			console.log(`   💰 Total doado: R$ ${totalAmount.toFixed(2)}`);
			console.log(
				`   🎟️ Rolls Máximos: ${totalMaxRolls} (10 base + ${extraRolls} extras por doação)`
			);
			console.log("");
		} else {
			console.log(
				`👤 Doador: ${donor.nome} (${cleanNumber}) — Doação R$ ${totalAmount.toFixed(2)} (< R$ 10.00: 0 rolls extras)`
			);
		}
	}

	console.log("\n==================================================================");
	console.log("📊 RESUMO DOS ROLLS RETROATIVOS:");
	console.log(`   • Doadores com rolls extras ativas: ${donorsWithRollBonus}`);
	console.log(`   • Total de rolls extras distribuídos: +${totalExtraRollsAwarded}`);
	console.log("   • Todos os bônus funcionam dinamicamente em tempo real via API!");
	console.log("==================================================================");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro fatal no script:", err);
		process.exit(1);
	});
