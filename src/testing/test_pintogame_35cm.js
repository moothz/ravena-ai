const assert = require("assert");
const Database = require("../utils/Database");
const DonorBonusService = require("../services/DonorBonusService");
const {
	commands,
	calculateScore,
	getComment,
	generateErect,
	MIN_ERECT,
	BASE_MAX_ERECT,
	MAX_ERECT,
	TOP_TIER_CHANCE,
	MAX_SCORE
} = require("../functions/PintoGame");

async function runTests() {
	console.log("=== INICIANDO TESTES DO PINTOGAME (35CM & SCORES) ===");

	// 1. Constantes
	console.log("\n--- 1. Validando constantes ---");
	assert.strictEqual(MIN_ERECT, 5.0, "MIN_ERECT deve ser 5.0");
	assert.strictEqual(BASE_MAX_ERECT, 25.0, "BASE_MAX_ERECT deve ser 25.0");
	assert.strictEqual(MAX_ERECT, 35.0, "MAX_ERECT deve ser 35.0");
	assert.strictEqual(TOP_TIER_CHANCE, 0.05, "TOP_TIER_CHANCE deve ser 0.05 (5%)");
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

	// 4. Neutralidade de buffs, chance de 5% e média nos últimos 10cm + faixa base
	console.log("\n--- 4. Validando sorteio 5% raro, curva e neutralidade de buffs ---");
	const iterations = 30000;
	let nonDonorTopTierSum = 0;
	let nonDonorTopTierCount = 0;
	let nonDonorOver30Count = 0;
	let donorTopTierSum = 0;
	let donorTopTierCount = 0;

	for (let i = 0; i < iterations; i++) {
		const erect = generateErect(8.0, 1.0);
		assert.ok(erect >= MIN_ERECT, `Ereto (${erect}) não pode ser menor que ${MIN_ERECT}`);
		assert.ok(erect <= MAX_ERECT, `Ereto (${erect}) não pode ser maior que ${MAX_ERECT}`);
		if (erect > BASE_MAX_ERECT) {
			nonDonorTopTierCount++;
			nonDonorTopTierSum += erect;
			if (erect >= 30.0) nonDonorOver30Count++;
			assert.ok(
				erect >= 25.1 && erect <= 35.0,
				`Valor acima de 25cm deve estar entre 25.1 e 35.0, obtido: ${erect}`
			);
		}
	}

	for (let i = 0; i < iterations; i++) {
		const erect = generateErect(8.0, 5.0);
		assert.ok(erect >= MIN_ERECT, `Ereto (${erect}) não pode ser menor que ${MIN_ERECT}`);
		assert.ok(erect <= MAX_ERECT, `Ereto (${erect}) não pode ser maior que ${MAX_ERECT}`);
		if (erect > BASE_MAX_ERECT) {
			donorTopTierCount++;
			donorTopTierSum += erect;
			assert.ok(
				erect >= 25.1 && erect <= 35.0,
				`Valor de doador acima de 25cm deve estar entre 25.1 e 35.0, obtido: ${erect}`
			);
		} else {
			assert.strictEqual(
				erect,
				25.0,
				"Com super doador na faixa base, ereto deve ser travado estritamente em 25.0"
			);
		}
	}

	const nonDonorRatio = nonDonorTopTierCount / iterations;
	const donorRatio = donorTopTierCount / iterations;
	const nonDonorTopMean = nonDonorTopTierSum / nonDonorTopTierCount;
	const donorTopMean = donorTopTierSum / donorTopTierCount;

	console.log(
		`Frequência >25cm sem donate: ${(nonDonorRatio * 100).toFixed(2)}% (média ${nonDonorTopMean.toFixed(2)}cm)`
	);
	console.log(
		`Frequência >25cm com super donate: ${(donorRatio * 100).toFixed(2)}% (média ${donorTopMean.toFixed(2)}cm)`
	);

	assert.ok(
		Math.abs(nonDonorRatio - TOP_TIER_CHANCE) < 0.01,
		`Taxa >25cm sem donate deve ser ~5%, obtido ${(nonDonorRatio * 100).toFixed(2)}%`
	);
	assert.ok(
		Math.abs(donorRatio - TOP_TIER_CHANCE) < 0.01,
		`Taxa >25cm com donate deve ser ~5%, obtido ${(donorRatio * 100).toFixed(2)}%`
	);
	assert.ok(
		Math.abs(nonDonorTopMean - donorTopMean) < 0.4,
		`Média acima de 25cm não pode receber bônus (sem donate=${nonDonorTopMean.toFixed(2)}, super donate=${donorTopMean.toFixed(2)})`
	);
	assert.ok(
		nonDonorTopMean < 29.2 && nonDonorOver30Count < nonDonorTopTierCount * 0.4,
		`Curva quadrática deve concentrar mais resultados entre 25.1 e 29.9 que >=30cm (média=${nonDonorTopMean.toFixed(2)})`
	);

	// Simulação realista do multiplicador de R$ 100 (2.0x) recebendo o flácido base (não já multiplicado)
	let donorBaseSum = 0;
	let donorBaseCount = 0;
	for (let i = 0; i < 20000; i++) {
		const baseFlaccid = Math.round((3.0 + Math.random() * 9.0) * 10) / 10;
		const erect = generateErect(baseFlaccid, 2.0);
		if (erect <= BASE_MAX_ERECT) {
			donorBaseSum += erect;
			donorBaseCount++;
		}
	}
	const donorBaseMean = donorBaseSum / donorBaseCount;
	console.log(`Média na faixa base com R$100 (flácido pré-bônus): ${donorBaseMean.toFixed(2)}cm`);
	assert.ok(
		donorBaseMean >= 23.0 && donorBaseMean <= 24.0,
		`Média da faixa base para R$100 deve ficar ~23.5cm sem contar bônus 2x, obtido ${donorBaseMean.toFixed(2)}cm`
	);
	console.log("✓ Sorteio 5%, curva quadrática e bônus único comprovados");

	// 5. Exercitar comando !pinto real (flácido pré-bônus passado ao generateErect)
	console.log("\n--- 5. Validando fluxo completo do comando !pinto ---");
	const pintoCmd = commands.find((c) => c.name === "pinto");
	assert.ok(pintoCmd, "Comando pinto deve existir");

	const db = Database.getInstance();
	const origDbGet = db.dbGet.bind(db);
	const origDbRun = db.dbRun.bind(db);
	const origGetDonorTotal = DonorBonusService.getDonorTotal;
	const origRandom = Math.random;

	let savedFlaccid = null;
	let savedErect = null;
	try {
		db.dbGet = async () => null; // sem cooldown
		db.dbRun = async (_dbName, sql, params) => {
			if (sql.includes("INSERT INTO pinto_scores")) {
				savedFlaccid = params[3];
				savedErect = params[4];
			}
			return { changes: 1 };
		};
		DonorBonusService.getDonorTotal = async () => 100; // +100% (2.0x)

		// Sequência determinística de Math.random():
		// 1) baseFlaccid = 3.0 + 0.5 * 9.0 = 7.5 (com 2x -> flaccid final = 12.0!)
		// 2) girth = 8.0 + 0.5 * 10.0 = 13.0 (com 2x -> 18.0)
		// 3) curvature = -30 + 0.5 * 60 = 0
		// 4) entersTopTier check = 0.5 (>= 0.05 -> faixa base!)
		// 5) generateRandomValue(Math.max(baseFlaccid=7.5, 5.0), 25.0) com r=0.0 -> deve retornar 7.5 (se usasse flaccid pós-bônus retornaria 12.0 -> 24.0!)
		const randomSeq = [0.5, 0.5, 0.5, 0.5, 0.0, 0.5, 0.5, 0.5];
		let idx = 0;
		Math.random = () => randomSeq[idx++] ?? 0.5;

		const msg = {
			group: "120363000000000001@g.us",
			author: "user1@c.us",
			name: "Tester",
			origin: { id: { _serialized: "msg-1" } }
		};

		await pintoCmd.method({}, msg, [], { id: msg.group });
		assert.strictEqual(savedFlaccid, 12.0, "Flácido salvo deve aplicar bônus até o teto de 12.0cm");
		assert.strictEqual(
			savedErect,
			15.0,
			`Ereto deve usar baseFlaccid=7.5 (x2 = 15.0cm), e não flácid=12.0 pós-bônus (obtido ${savedErect})`
		);
		console.log(
			`✓ !pinto passou flácido pré-bônus corretamente (flácido=${savedFlaccid}, ereto=${savedErect})`
		);
	} finally {
		db.dbGet = origDbGet;
		db.dbRun = origDbRun;
		DonorBonusService.getDonorTotal = origGetDonorTotal;
		Math.random = origRandom;
	}

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
