/**
 * test_bicho_rules.js
 * Teste unitário para bichoRules.js (tabela, parser, sorteio e cálculo de prêmios com teto).
 */
"use strict";

const assert = require("assert");
const {
	ANIMALS,
	TEN_TO_ANIMAL,
	GROUP_TO_ANIMAL,
	findAnimal,
	getAnimalForNumber,
	parseBetArgs,
	generateDrawNumbers,
	evaluateBet
} = require("../services/bichoRules");

async function runTests() {
	console.log("Iniciando testes de bichoRules.js...");

	// 1. Tabela dos 25 bichos
	assert.strictEqual(ANIMALS.length, 25, "Devem existir exatamente 25 bichos");
	assert.strictEqual(ANIMALS[0].name, "Avestruz");
	assert.strictEqual(ANIMALS[0].group, 1);
	assert.deepStrictEqual(ANIMALS[0].tens, ["01", "02", "03", "04"]);

	// Grupo 25: Vaca (97, 98, 99, 00)
	assert.strictEqual(ANIMALS[24].name, "Vaca");
	assert.strictEqual(ANIMALS[24].group, 25);
	assert.deepStrictEqual(ANIMALS[24].tens, ["97", "98", "99", "00"]);

	// Checa se todas as 100 dezenas ("00" a "99") estão mapeadas sem duplicatas
	const allTens = Object.keys(TEN_TO_ANIMAL);
	assert.strictEqual(allTens.length, 100, "Todas as 100 dezenas devem estar mapeadas");
	for (let i = 0; i <= 99; i++) {
		const str = String(i).padStart(2, "0");
		assert.ok(TEN_TO_ANIMAL[str], `Dezena ${str} deve ter um animal associado`);
	}

	// 2. Busca de animal por nome / alias / grupo
	const cavalo = findAnimal("cavalo");
	assert.ok(cavalo && cavalo.group === 11);
	const jacare = findAnimal("jacaré");
	assert.ok(jacare && jacare.group === 15);
	const vaca = findAnimal(25);
	assert.ok(vaca && vaca.name === "Vaca");

	// 3. getAnimalForNumber
	const r1 = getAnimalForNumber("1234");
	assert.strictEqual(r1.ten, "34");
	assert.strictEqual(r1.animal.name, "Cobra"); // dezenas 33, 34, 35, 36

	const r2 = getAnimalForNumber("9900");
	assert.strictEqual(r2.ten, "00");
	assert.strictEqual(r2.animal.name, "Vaca");

	// 4. Parser de apostas
	// 4.1 Bicho por nome
	const p1 = parseBetArgs(["jacare", "1000"]);
	assert.strictEqual(p1.modality, "grupo");
	assert.strictEqual(p1.pick, "15");
	assert.strictEqual(p1.amount, 1000);
	assert.strictEqual(p1.scope, "cabeca");

	// 4.2 Bicho com cercado
	const p2 = parseBetArgs(["grupo", "1", "5000", "cercado"]);
	assert.strictEqual(p2.modality, "grupo");
	assert.strictEqual(p2.pick, "1");
	assert.strictEqual(p2.amount, 5000);
	assert.strictEqual(p2.scope, "cercado");

	// 4.3 Dezena
	const p3 = parseBetArgs(["dezena", "42", "2000"]);
	assert.strictEqual(p3.modality, "dezena");
	assert.strictEqual(p3.pick, "42");
	assert.strictEqual(p3.amount, 2000);

	// 4.4 Centena
	const p4 = parseBetArgs(["centena", "7", "500", "cercado"]);
	assert.strictEqual(p4.modality, "centena");
	assert.strictEqual(p4.pick, "007");
	assert.strictEqual(p4.amount, 500);
	assert.strictEqual(p4.scope, "cercado");

	// 4.5 Milhar
	const p5 = parseBetArgs(["milhar", "1234", "100", "cabeca"]);
	assert.strictEqual(p5.modality, "milhar");
	assert.strictEqual(p5.pick, "1234");
	assert.strictEqual(p5.amount, 100);
	assert.strictEqual(p5.scope, "cabeca");

	// 5. Sorteio de 5 números
	const draw = generateDrawNumbers();
	assert.strictEqual(draw.length, 5);
	draw.forEach((p, idx) => {
		assert.strictEqual(p.prize, idx + 1);
		assert.match(p.number, /^\d{4}$/);
		assert.ok(p.group >= 1 && p.group <= 25);
	});

	// 6. Avaliação de prêmios e cotações
	const mockDraw = [
		{ prize: 1, number: "1234", ten: "34", group: 9, animalName: "Cobra", animalEmoji: "🐍" },
		{ prize: 2, number: "5678", ten: "78", group: 20, animalName: "Peru", animalEmoji: "🦃" },
		{ prize: 3, number: "9034", ten: "34", group: 9, animalName: "Cobra", animalEmoji: "🐍" },
		{ prize: 4, number: "4321", ten: "21", group: 6, animalName: "Cabra", animalEmoji: "🐐" },
		{ prize: 5, number: "1111", ten: "11", group: 3, animalName: "Burro", animalEmoji: "🫏" }
	];

	// Grupo na Cabeça (Cobra = 9) -> Acertou 1º prêmio (18x)
	const ev1 = evaluateBet(
		{ modality: "grupo", pick: "9", amount: 1000, scope: "cabeca" },
		mockDraw
	);
	assert.strictEqual(ev1.won, true);
	assert.strictEqual(ev1.hits, 1);
	assert.strictEqual(ev1.payout, 18000); // 1000 * 18

	// Grupo que não deu na cabeça
	const ev2 = evaluateBet(
		{ modality: "grupo", pick: "20", amount: 1000, scope: "cabeca" },
		mockDraw
	);
	assert.strictEqual(ev2.won, false);
	assert.strictEqual(ev2.payout, 0);

	// Grupo no Cercado (Cobra = 9): saiu no 1º e no 3º prêmio -> 2 acertos!
	// Cotação: 18 / 5 = 3.6x por acerto. 2 acertos = 7.2x. Aposta 1000 -> 7200
	const ev3 = evaluateBet(
		{ modality: "grupo", pick: "9", amount: 1000, scope: "cercado" },
		mockDraw
	);
	assert.strictEqual(ev3.won, true);
	assert.strictEqual(ev3.hits, 2);
	assert.strictEqual(ev3.payout, 7200);

	// Milhar na cabeça: 1234 (4000x) -> Aposta 1000 -> 4.000.000
	const ev4 = evaluateBet(
		{ modality: "milhar", pick: "1234", amount: 1000, scope: "cabeca" },
		mockDraw
	);
	assert.strictEqual(ev4.won, true);
	assert.strictEqual(ev4.payout, 4000000);
	assert.strictEqual(ev4.capped, false);

	// Teste do teto de prêmio (maxPayout):
	// Aposta 500.000 na Milhar (4000x) daria 2 bilhões, com teto de 5.000.000
	const ev5 = evaluateBet(
		{ modality: "milhar", pick: "1234", amount: 500000, scope: "cabeca" },
		mockDraw,
		{ maxPayout: 5000000 }
	);
	assert.strictEqual(ev5.won, true);
	assert.strictEqual(ev5.payout, 5000000);
	assert.strictEqual(ev5.capped, true);

	console.log("Todos os testes de bichoRules.js passaram com sucesso!");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Falha nos testes:", err);
		process.exit(1);
	});
