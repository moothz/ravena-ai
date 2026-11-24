const assert = require("assert");
const {
	calculateScore,
	getComment,
	generateErect,
	MIN_ERECT,
	BASE_MAX_ERECT,
	MAX_ERECT,
	MAX_SCORE
} = require("../functions/PintoGame");

async function runTests() {
	console.log("=== INICIANDO TESTES DO PINTOGAME (35CM & SCORES) ===");

	// 1. Constantes
	console.log("\n--- 1. Validando constantes ---");
	assert.strictEqual(MIN_ERECT, 5.0, "MIN_ERECT deve ser 5.0");
	assert.strictEqual(BASE_MAX_ERECT, 25.0, "BASE_MAX_ERECT deve ser 25.0");
	assert.strictEqual(MAX_ERECT, 35.0, "MAX_ERECT deve ser 35.0");
	assert.strictEqual(MAX_SCORE, 1000, "MAX_SCORE base deve ser 1000");
	console.log("✓ Constantes OK");

	// 2. Cálculo de Score
	console.log("\n--- 2. Validando cálculo de score escalado ---");
	const score25 = calculateScore(12.0, 25.0, 18.0, 0);
	assert.strictEqual(score25, 1000, "25cm ereto perfeito deve render exatamente 1000 pontos");

	const score35 = calculateScore(12.0, 35.0, 18.0, 0);
	assert.strictEqual(
		score35,
		1250,
		"35cm ereto perfeito deve render 1250 pontos (maior que o score atual)"
	);
	assert.ok(score35 > score25, "Score de 35cm deve ser superior a 25cm");

	const score30 = calculateScore(12.0, 30.0, 18.0, 0);
	assert.strictEqual(score30, 1125, "30cm ereto perfeito deve render 1125 pontos");
	assert.ok(
		score30 > score25 && score30 < score35,
		"Score de 30cm deve estar proporcionalmente entre 25cm e 35cm"
	);
	console.log("✓ Cálculo de Score OK (25cm = 1000, 30cm = 1125, 35cm = 1250)");

	// 3. Comentários para scores > 1000
	console.log("\n--- 3. Validando comentários de score ---");
	const comment1250 = getComment(1250);
	assert.ok(
		comment1250.includes("ANOMALIA GRAVITACIONAL"),
		"Score >= 1200 deve receber comentário cósmico de anomalia"
	);

	const comment1125 = getComment(1125);
	assert.ok(
		comment1125.includes("COLOSSO CÓSMICO"),
		"Score >= 1100 deve receber comentário de colosso cósmico"
	);

	const comment1000 = getComment(1000);
	assert.ok(
		comment1000.includes("DEUS DO OLIMPO"),
		"Score 1000 deve manter comentário de Deus do Olimpo"
	);
	console.log("✓ Comentários OK");

	// 4. Neutralidade de buffs e sorteio dos últimos 10cm
	console.log("\n--- 4. Validando sorteio e neutralidade de buffs de donate ---");
	const iterations = 5000;
	let nonDonorTopTierCount = 0;
	let donorTopTierCount = 0;

	// Simulação sem doador (multiplier = 1)
	for (let i = 0; i < iterations; i++) {
		const erect = generateErect(8.0, 1.0);
		assert.ok(erect >= MIN_ERECT, `Ereto (${erect}) não pode ser menor que ${MIN_ERECT}`);
		assert.ok(erect <= MAX_ERECT, `Ereto (${erect}) não pode ser maior que ${MAX_ERECT}`);
		if (erect > BASE_MAX_ERECT) {
			nonDonorTopTierCount++;
			assert.ok(
				erect >= 25.1 && erect <= 35.0,
				`Valor acima de 25cm deve estar entre 25.1 e 35.0, obtido: ${erect}`
			);
		}
	}

	// Simulação com super doador (multiplier = 5x)
	for (let i = 0; i < iterations; i++) {
		const erect = generateErect(8.0, 5.0);
		assert.ok(erect >= MIN_ERECT, `Ereto (${erect}) não pode ser menor que ${MIN_ERECT}`);
		assert.ok(erect <= MAX_ERECT, `Ereto (${erect}) não pode ser maior que ${MAX_ERECT}`);
		if (erect > BASE_MAX_ERECT) {
			donorTopTierCount++;
			assert.ok(
				erect >= 25.1 && erect <= 35.0,
				`Valor de doador acima de 25cm deve estar entre 25.1 e 35.0, obtido: ${erect}`
			);
		} else {
			// Na faixa base com multiplier 5x, ereto deve ter atingido exatamente o teto de 25.0
			assert.strictEqual(
				erect,
				25.0,
				"Com super doador na faixa base, ereto deve ser travado estritamente em 25.0"
			);
		}
	}

	const nonDonorRatio = nonDonorTopTierCount / iterations;
	const donorRatio = donorTopTierCount / iterations;
	console.log(`Frequência >25cm sem donate: ${(nonDonorRatio * 100).toFixed(1)}%`);
	console.log(`Frequência >25cm com super donate: ${(donorRatio * 100).toFixed(1)}%`);

	// Ambas as taxas devem estar próximas de ~33.3% (10/30) com tolerância estatística de 4%
	assert.ok(
		Math.abs(nonDonorRatio - donorRatio) < 0.04,
		`Taxa de entrada nos últimos 10cm deve ser igual entre doadores e não doadores (dif: ${Math.abs(nonDonorRatio - donorRatio)})`
	);
	assert.ok(
		Math.abs(nonDonorRatio - 0.333) < 0.04,
		`Taxa deve estar próxima da proporção de 1/3 (obtido: ${nonDonorRatio})`
	);
	console.log("✓ Neutralidade dos últimos 10cm comprovada estatisticamente");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
