/**
 * test_slots_sacolas_jardim.js
 *
 * Valida a sincronização das Sacolas do Coveiro no Slots com o catálogo canônico da Fazenda.
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const { openSacolasDoCoveiro } = require("../functions/SlotsGame");
const FazendaCommands = require("../functions/FazendaCommands");

async function main() {
	console.log("=== [Teste] Sincronização das Sacolas do Coveiro no Slots ===");

	// 1. Verifica se openSacolasDoCoveiro está exportada e é uma função
	assert.strictEqual(
		typeof openSacolasDoCoveiro,
		"function",
		"openSacolasDoCoveiro deve ser exportada pelo SlotsGame"
	);
	console.log("✓ openSacolasDoCoveiro está devidamente exportada.");

	// Obter a lista canônica de plantas de FazendaCommands (12 plantas)
	// Como FazendaCommands define PLANT_NAMES internamente, vamos verificar os 12 IDs canônicos esperados:
	const CANONICAL_PLANTS = {
		"01_nightshade": "Erva-Moura",
		"02_tomb_shroom": "Cogumelo Tumular",
		"03_corpse_lily": "Lírio Cadáver",
		"04_black_lotus": "Lótus Negra",
		"05_mist_crawler_v2": "Rastejante de Névoa",
		"06_styx_kelp_v2": "Alga do Estige",
		"07_spectral_gourd_v2": "Cabaça Espectral",
		"08_devouring_root_v2": "Raiz Devoradora",
		"09_obsidian_clover": "Trevo de Obsidiana",
		"10_golden_clover": "Trevo Dourado",
		"11_purple_heart": "Coração Púrpuro",
		"12_blood_rose": "Rosa de Sangue"
	};

	const FORBIDDEN_NAMES = [
		"Mandrágora",
		"Esporos Espectrais",
		"Samambaia Sombria",
		"Lírio de Sangue",
		"Pimenta Fantasma",
		"Musgo Abissal",
		"Rosa da Tumba",
		"Salgueiro Sussurrante",
		"Cacto de Obsidiana",
		"Coroa do Lich",
		"Lótus de Cristal"
	];

	// 2. Simula abertura de 2.000 sacolas do coveiro para testar distribuição e assertividade
	const seenIds = new Set();
	const seenNames = new Set();
	let totalCommonCount = 0;
	let totalBonusCount = 0;

	for (let i = 0; i < 200; i++) {
		const drops = openSacolasDoCoveiro(10);
		for (const [seedId, item] of Object.entries(drops)) {
			seenIds.add(seedId);
			seenNames.add(item.name);

			// Assert que pertence às plantas canônicas
			assert.ok(
				CANONICAL_PLANTS[seedId],
				`ID inesperado gerado: ${seedId} (não existe no catálogo canônico)`
			);
			assert.strictEqual(
				item.name,
				CANONICAL_PLANTS[seedId],
				`Nome do item não bate com o canônico: ${item.name} vs ${CANONICAL_PLANTS[seedId]}`
			);

			// Assert que não contém nomes proibidos/fictícios
			for (const forbidden of FORBIDDEN_NAMES) {
				assert.notStrictEqual(
					item.name,
					forbidden,
					`Item proibido/fictício encontrado: ${item.name}`
				);
			}

			// Assert que não é mobília nem decoração
			assert.ok(!seedId.startsWith("decor_"), `Item de decoração gerado: ${seedId}`);
			const numId = parseInt(seedId.slice(0, 2), 10);
			assert.ok(numId >= 1 && numId <= 12, `ID fora do intervalo de plantas 1..12: ${seedId}`);

			if (["01_nightshade", "02_tomb_shroom", "03_corpse_lily"].includes(seedId)) {
				totalCommonCount += item.count;
			} else {
				totalBonusCount += item.count;
			}
		}
	}

	console.log(`✓ 2.000 sacolas abertas com sucesso.`);
	console.log(`✓ Sementes comuns geradas: ${totalCommonCount}`);
	console.log(`✓ Sementes bônus geradas: ${totalBonusCount}`);
	console.log(`✓ IDs encontrados:`, Array.from(seenIds).sort());
	console.log(`✓ Nomes encontrados:`, Array.from(seenNames).sort());

	// Assegura que todas as 3 comuns e pelo menos uma boa parte das bônus foram sorteadas
	assert.ok(seenIds.has("01_nightshade"), "Erva-moura deve ter sido sorteada");
	assert.ok(seenIds.has("02_tomb_shroom"), "Cogumelo Tumular deve ter sido sorteado");
	assert.ok(seenIds.has("03_corpse_lily"), "Lírio Cadáver deve ter sido sorteado");
	assert.ok(
		seenIds.size >= 8,
		"Pelo menos 8 tipos de sementes diferentes devem ter sido sorteados"
	);

	console.log("=== Todos os testes passaram com sucesso! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste:", err);
		process.exit(1);
	});
