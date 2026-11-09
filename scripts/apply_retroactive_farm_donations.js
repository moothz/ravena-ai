/**
 * Script de aplicação retroativa de bônus da Fazenda (Jardim das Sombras) para doadores
 * Uso:
 *   Simulação (não altera nada): docker exec ravena-ai node /app/scripts/apply_retroactive_farm_donations.js --dry-run
 *   Execução real:             docker exec ravena-ai node /app/scripts/apply_retroactive_farm_donations.js
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const Database = require("../src/utils/Database");
const ShadowGardenClient = require("../src/services/ShadowGardenClient");
const ShadowGardenBonusService = require("../src/services/ShadowGardenBonusService");
const Logger = require("../src/utils/Logger");

const logger = new Logger("apply-retroactive-farm-donations");
const database = Database.getInstance();
const jardimClient = new ShadowGardenClient();

async function main() {
	const isDryRun = process.argv.includes("--dry-run");

	console.log("==================================================================");
	console.log(
		`🌱 SCRIPT DE BÔNUS RETROATIVOS DA FAZENDA [${isDryRun ? "DRY-RUN / SIMULAÇÃO" : "MODO REAL"}]`
	);
	console.log("==================================================================\n");

	const donations = await database.getDonations();
	if (!donations || donations.length === 0) {
		console.log("Nenhum doador encontrado na base de dados.");
		return;
	}

	const eligibleDonors = donations
		.filter((d) => d.numero && String(d.numero).trim().length > 5 && (Number(d.valor) || 0) > 0)
		.sort((a, b) => (Number(b.valor) || 0) - (Number(a.valor) || 0));

	console.log(`📋 Total de doadores elegíveis: ${eligibleDonors.length}\n`);

	let processedCount = 0;
	let totalLuckBuffs = 0;
	let totalCoinsBuffs = 0;
	let totalGrowthBuffs = 0;
	let totalDecorsGiven = 0;

	for (const donor of eligibleDonors) {
		const totalAmount = Number(donor.valor) || 0;
		const cleanNumber = String(donor.numero).replace(/\D/g, "");
		if (!cleanNumber) continue;

		const farm = ShadowGardenBonusService.calculateFarmDonationBonuses(totalAmount, 0);
		if (!farm) continue;

		const luckCount = farm.current.dailyLuck;
		const coinsCount = farm.current.coinsBonus;
		const speedCount = farm.current.growthSpeed;
		const decors = ShadowGardenBonusService.getEligibleVipDecorations(totalAmount);

		if (luckCount === 0 && coinsCount === 0 && speedCount === 0 && decors.length === 0) {
			continue;
		}

		processedCount++;
		totalLuckBuffs += luckCount;
		totalCoinsBuffs += coinsCount;
		totalGrowthBuffs += speedCount;
		totalDecorsGiven += decors.length;

		const luckPercent = luckCount * 5;
		const coinsPercent = coinsCount * 10;
		const speedPercent = Math.min(75, speedCount * 5);

		console.log(`👤 Doador: ${donor.nome} (${cleanNumber}) — R$ ${totalAmount.toFixed(2)}`);
		console.log(
			`   🌿 Buffs: +${luckPercent}% Sorte Diária (${luckCount}x), +${coinsPercent}% Moedas (${coinsCount}x), +${speedPercent}% Crescimento (${speedCount}x)`
		);
		console.log(`   🏺 Enfeites VIP (${decors.length}): ${decors.join(", ") || "Nenhum"}`);

		if (!isDryRun) {
			try {
				if (luckPercent > 0) {
					await jardimClient.adminBuff(cleanNumber, {
						type: "daily_bag_bonus",
						value: luckPercent / 100,
						source: "donor_retroactive",
						replaceSource: true
					});
				}
				if (coinsPercent > 0) {
					await jardimClient.adminBuff(cleanNumber, {
						type: "coin_multiplier",
						value: coinsPercent / 100,
						source: "donor_retroactive",
						replaceSource: true
					});
				}
				if (speedPercent > 0) {
					await jardimClient.adminBuff(cleanNumber, {
						type: "growth_reduction",
						value: speedPercent / 100,
						source: "donor_retroactive",
						replaceSource: true
					});
				}

				for (const decorId of decors) {
					await jardimClient.adminGive(cleanNumber, {
						itemId: decorId,
						amount: 1,
						reason: "donor_retroactive"
					});
				}
				console.log(`   ✅ Sincronizado com sucesso na API da Fazenda!`);
			} catch (apiErr) {
				console.error(`   ❌ Falha ao aplicar na API da Fazenda: ${apiErr.message}`);
			}
		}
		console.log("");
	}

	console.log("\n==================================================================");
	console.log("📊 RESUMO GERAL DA FAZENDA:");
	console.log(`   • Doadores com benefícios da fazenda: ${processedCount}`);
	console.log(`   • Total de Buffs de Sorte Diária: ${totalLuckBuffs}`);
	console.log(`   • Total de Buffs de Moedas: ${totalCoinsBuffs}`);
	console.log(`   • Total de Buffs de Velocidade: ${totalGrowthBuffs}`);
	console.log(`   • Total de Decorações VIP concedidas: ${totalDecorsGiven}`);
	if (isDryRun) {
		console.log(
			"\n⚠️  ESTA FOI UMA SIMULAÇÃO (--dry-run). Nenhuma chamada de escrita foi enviada."
		);
	} else {
		console.log("\n✅ BÔNUS RETROATIVOS DA FAZENDA APLICADOS COM SUCESSO!");
	}
	console.log("==================================================================");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro fatal no script:", err);
		process.exit(1);
	});
