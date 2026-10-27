/**
 * compensate_slots_jardim.js
 *
 * Script utilitário para compensar os jogadores que ganharam Sacolas do Coveiro no Slots
 * durante o período em que nomes fictícios ou itens desencontrados foram sorteados.
 *
 * Uso:
 *   docker exec ravena-ai node /app/scripts/compensate_slots_jardim.js --dry-run
 *   docker exec ravena-ai node /app/scripts/compensate_slots_jardim.js --execute
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const Database = require("../src/utils/Database");
const ShadowGardenClient = require("../src/services/ShadowGardenClient");

const REWARD_CANDIDATE_SEEDS = [
	{ id: "04_black_lotus", name: "Lótus Negra" },
	{ id: "05_mist_crawler_v2", name: "Rastejante de Névoa" },
	{ id: "07_spectral_gourd_v2", name: "Cabaça Espectral" },
	{ id: "08_devouring_root_v2", name: "Raiz Devoradora" },
	{ id: "09_obsidian_clover", name: "Trevo de Obsidiana" },
	{ id: "10_golden_clover", name: "Trevo Dourado" },
	{ id: "11_purple_heart", name: "Coração Púrpuro" },
	{ id: "12_blood_rose", name: "Rosa de Sangue" }
];

function pickRandomSeeds(count = 3) {
	const chosen = {};
	for (let i = 0; i < count; i++) {
		const seed = REWARD_CANDIDATE_SEEDS[Math.floor(Math.random() * REWARD_CANDIDATE_SEEDS.length)];
		if (!chosen[seed.id]) {
			chosen[seed.id] = { name: seed.name, amount: 0 };
		}
		chosen[seed.id].amount += 1;
	}
	return chosen;
}

async function main() {
	const args = process.argv.slice(2);
	const isExecute = args.includes("--execute");

	console.log("=== Compensação de Jogadores do Slots (Sacolas do Coveiro) ===");
	console.log(`Modo: ${isExecute ? "🚨 EXECUÇÃO REAL" : "🔍 SIMULAÇÃO (--dry-run)"}\n`);

	const db = Database.getInstance();
	const jardimClient = new ShadowGardenClient();

	const query = `
		SELECT 
			user_id, 
			COUNT(*) as wins, 
			SUM(CAST(SUBSTR(prize_name, INSTR(prize_name, '+ ') + 2, INSTR(prize_name, ' Sacolas') - INSTR(prize_name, '+ ') - 2) AS INTEGER)) as total_bags
		FROM slots_prizes 
		WHERE prize_name LIKE '%Sacolas' 
		  AND prize_name NOT LIKE '%+ 0 Sacolas'
		GROUP BY user_id
		ORDER BY total_bags DESC;
	`;

	const users = await db.dbAll("slots", query);

	if (!users || users.length === 0) {
		console.log("Nenhum jogador encontrado com prêmios de sacolas registrados.");
		return;
	}

	console.log(`Encontrados ${users.length} jogadores para compensação.\n`);

	let totalCoinsGranted = 0;
	let totalItemsGranted = 0;
	let successCount = 0;
	let errorCount = 0;

	for (const u of users) {
		const userId = String(u.user_id).replace(/\D/g, "");
		if (!userId || userId.length < 8) continue; // Pula IDs de teste / inválidos

		// Pacote de compensação:
		// - 1.500 Moedas do Jardim + bônus proporcional às sacolas que ganhou (100 moedas por sacola)
		const bonusCoins = 1500 + Math.max(1, u.total_bags || 1) * 100;
		// - 3 a 5 sementes raras aleatórias
		const numSeeds = Math.min(6, 2 + Math.ceil((u.total_bags || 1) / 5));
		const pickedSeeds = pickRandomSeeds(numSeeds);

		const seedDesc = Object.entries(pickedSeeds)
			.map(([_, s]) => `${s.amount}x ${s.name}`)
			.join(", ");

		console.log(
			`[User ${userId}] Sacolas ganhas: ${u.total_bags} | Bônus: ${bonusCoins} Moedas | Sementes: ${seedDesc}`
		);

		totalCoinsGranted += bonusCoins;
		for (const s of Object.values(pickedSeeds)) {
			totalItemsGranted += s.amount;
		}

		if (isExecute) {
			try {
				// Concede moedas
				await jardimClient.adminGive(userId, {
					coins: bonusCoins,
					reason: "compensacao_slots_sacolas"
				});

				// Concede sementes
				for (const [seedId, s] of Object.entries(pickedSeeds)) {
					await jardimClient.adminGive(userId, {
						itemId: seedId,
						amount: s.amount,
						reason: "compensacao_slots_sacolas"
					});
				}
				successCount++;
			} catch (err) {
				console.error(`  ❌ Erro ao compensar ${userId}: ${err.message}`);
				errorCount++;
			}
		}
	}

	console.log("\n--------------------------------------------------");
	console.log(`Jogadores avaliados: ${users.length}`);
	console.log(
		`Total de Moedas ${isExecute ? "concedidas" : "estimadas"}: ${totalCoinsGranted.toLocaleString("pt-BR")}`
	);
	console.log(
		`Total de Sementes ${isExecute ? "concedidas" : "estimadas"}: ${totalItemsGranted.toLocaleString("pt-BR")}`
	);

	if (isExecute) {
		console.log(`Sucessos: ${successCount} | Falhas: ${errorCount}`);
		console.log("✅ Compensação concluída!");
	} else {
		console.log("ℹ️ Para aplicar as compensações de fato, execute com a flag --execute:");
		console.log("   docker exec ravena-ai node /app/scripts/compensate_slots_jardim.js --execute");
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro fatal:", err);
		process.exit(1);
	});
