/**
 * bichoRules.js
 *
 * Regras matemáticas, tabela oficial e lógica de resolução do Jogo do Bicho.
 * Módulo puro (sem banco, cron ou efeitos colaterais).
 */
"use strict";

const crypto = require("crypto");

/**
 * Tabela oficial dos 25 bichos
 * Grupo 1 (01-04) até Grupo 25 (97-00)
 */
const ANIMALS = [
	{
		group: 1,
		name: "Avestruz",
		emoji: "🦤",
		aliases: ["avestruz"],
		tens: ["01", "02", "03", "04"]
	},
	{
		group: 2,
		name: "Águia",
		emoji: "🦅",
		aliases: ["aguia", "águia"],
		tens: ["05", "06", "07", "08"]
	},
	{
		group: 3,
		name: "Burro",
		emoji: "🫏",
		aliases: ["burro", "asno"],
		tens: ["09", "10", "11", "12"]
	},
	{
		group: 4,
		name: "Borboleta",
		emoji: "🦋",
		aliases: ["borboleta"],
		tens: ["13", "14", "15", "16"]
	},
	{
		group: 5,
		name: "Cachorro",
		emoji: "🐶",
		aliases: ["cachorro", "cao", "cão"],
		tens: ["17", "18", "19", "20"]
	},
	{
		group: 6,
		name: "Cabra",
		emoji: "🐐",
		aliases: ["cabra", "bode"],
		tens: ["21", "22", "23", "24"]
	},
	{
		group: 7,
		name: "Carneiro",
		emoji: "🐏",
		aliases: ["carneiro"],
		tens: ["25", "26", "27", "28"]
	},
	{
		group: 8,
		name: "Camelo",
		emoji: "🐫",
		aliases: ["camelo", "dromedario", "dromedário"],
		tens: ["29", "30", "31", "32"]
	},
	{
		group: 9,
		name: "Cobra",
		emoji: "🐍",
		aliases: ["cobra", "serpente"],
		tens: ["33", "34", "35", "36"]
	},
	{ group: 10, name: "Coelho", emoji: "🐰", aliases: ["coelho"], tens: ["37", "38", "39", "40"] },
	{ group: 11, name: "Cavalo", emoji: "🐴", aliases: ["cavalo"], tens: ["41", "42", "43", "44"] },
	{
		group: 12,
		name: "Elefante",
		emoji: "🐘",
		aliases: ["elefante"],
		tens: ["45", "46", "47", "48"]
	},
	{ group: 13, name: "Galo", emoji: "🐓", aliases: ["galo"], tens: ["49", "50", "51", "52"] },
	{ group: 14, name: "Gato", emoji: "🐱", aliases: ["gato"], tens: ["53", "54", "55", "56"] },
	{
		group: 15,
		name: "Jacaré",
		emoji: "🐊",
		aliases: ["jacare", "jacaré"],
		tens: ["57", "58", "59", "60"]
	},
	{
		group: 16,
		name: "Leão",
		emoji: "🦁",
		aliases: ["leao", "leão"],
		tens: ["61", "62", "63", "64"]
	},
	{ group: 17, name: "Macaco", emoji: "🐵", aliases: ["macaco"], tens: ["65", "66", "67", "68"] },
	{ group: 18, name: "Porco", emoji: "🐷", aliases: ["porco"], tens: ["69", "70", "71", "72"] },
	{
		group: 19,
		name: "Pavão",
		emoji: "🦚",
		aliases: ["pavao", "pavão"],
		tens: ["73", "74", "75", "76"]
	},
	{ group: 20, name: "Peru", emoji: "🦃", aliases: ["peru"], tens: ["77", "78", "79", "80"] },
	{
		group: 21,
		name: "Touro",
		emoji: "🐂",
		aliases: ["touro", "boi"],
		tens: ["81", "82", "83", "84"]
	},
	{ group: 22, name: "Tigre", emoji: "🐯", aliases: ["tigre"], tens: ["85", "86", "87", "88"] },
	{ group: 23, name: "Urso", emoji: "🐻", aliases: ["urso"], tens: ["89", "90", "91", "92"] },
	{
		group: 24,
		name: "Veado",
		emoji: "🦌",
		aliases: ["veado", "cervo"],
		tens: ["93", "94", "95", "96"]
	},
	{ group: 25, name: "Vaca", emoji: "🐮", aliases: ["vaca"], tens: ["97", "98", "99", "00"] }
];

// Mapa de dezena (string "00".."99") -> Animal
const TEN_TO_ANIMAL = {};
for (const a of ANIMALS) {
	for (const t of a.tens) {
		TEN_TO_ANIMAL[t] = a;
	}
}

// Mapa de grupo (1..25) -> Animal
const GROUP_TO_ANIMAL = {};
for (const a of ANIMALS) {
	GROUP_TO_ANIMAL[a.group] = a;
}

/**
 * Remove acentuação e normaliza string
 */
function normalizeStr(str) {
	return String(str || "")
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim();
}

/**
 * Busca animal por grupo (número 1..25) ou por nome/alias
 */
function findAnimal(query) {
	if (!query) return null;
	const num = Number(query);
	if (!isNaN(num) && num >= 1 && num <= 25) {
		return GROUP_TO_ANIMAL[num] || null;
	}
	const norm = normalizeStr(query);
	for (const a of ANIMALS) {
		if (a.aliases.some((alias) => normalizeStr(alias) === norm)) {
			return a;
		}
	}
	return null;
}

/**
 * Dado um número de milhar ("0000" a "9999"), obtém a dezena e o animal correspondente
 */
function getAnimalForNumber(numStr) {
	const str = String(numStr).padStart(4, "0");
	const ten = str.slice(-2);
	return {
		ten,
		animal: TEN_TO_ANIMAL[ten] || null
	};
}

/**
 * Interpreta argumentos de aposta do usuário
 * Exemplos aceitos:
 * - !bicho grupo 15 1000
 * - !bicho jacare 5000 cercado
 * - !bicho dezena 42 2000
 * - !bicho centena 342 1000 cabeca
 * - !bicho milhar 1342 500
 */
function parseBetArgs(args) {
	if (!Array.isArray(args) || args.length === 0) {
		return {
			error: "Informe sua aposta. Ex: `!bicho jacare 1000` ou `!bicho milhar 1234 1000 cercado`"
		};
	}

	const cleanArgs = args.map((a) => String(a).trim()).filter(Boolean);
	if (cleanArgs.length < 2) {
		return {
			error: "Formato incompleto. Uso: `!bicho [modalidade] <palpite> <valor> [cabeca|cercado]`"
		};
	}

	let modality = null;
	let pick = null;
	let amount = null;
	let scope = "cabeca"; // default: cabeca (1º prêmio)

	// Verifica se o último ou penúltimo argumento é o escopo ("cabeca" ou "cercado")
	const lastArgNorm = normalizeStr(cleanArgs[cleanArgs.length - 1]);
	if (["cercado", "cerca", "1-5", "1a5"].includes(lastArgNorm)) {
		scope = "cercado";
		cleanArgs.pop();
	} else if (["cabeca", "cabeça", "1", "1o", "1º"].includes(lastArgNorm)) {
		scope = "cabeca";
		cleanArgs.pop();
	}

	// O valor da aposta deve ser o último argumento restante
	const rawAmount = cleanArgs.pop();
	// Remove separadores de milhar e formata
	const sanitizedAmountStr = String(rawAmount).replace(/\./g, "").replace(/,/g, ".");
	amount = parseFloat(sanitizedAmountStr);
	if (isNaN(amount) || amount <= 0) {
		return {
			error: `Valor de aposta inválido: "${rawAmount}". O valor deve ser numérico em Runas.`
		};
	}

	// Sobraram os argumentos que definem modalidade e palpite
	if (cleanArgs.length === 0) {
		return { error: "Palpite não especificado." };
	}

	const firstNorm = normalizeStr(cleanArgs[0]);

	if (["grupo", "g", "bicho"].includes(firstNorm)) {
		modality = "grupo";
		const groupInput = cleanArgs.slice(1).join(" ");
		const animal = findAnimal(groupInput);
		if (!animal) {
			return {
				error: `Bicho ou grupo inválido: "${groupInput}". Escolha de 1 a 25 ou o nome do bicho.`
			};
		}
		pick = String(animal.group);
	} else if (["dezena", "d"].includes(firstNorm)) {
		modality = "dezena";
		const val = cleanArgs[1];
		if (!val || !/^\d{1,2}$/.test(val)) {
			return { error: `Dezena inválida: "${val}". Deve ser um número de 00 a 99.` };
		}
		pick = val.padStart(2, "0");
	} else if (["centena", "c"].includes(firstNorm)) {
		modality = "centena";
		const val = cleanArgs[1];
		if (!val || !/^\d{1,3}$/.test(val)) {
			return { error: `Centena inválida: "${val}". Deve ser um número de 000 a 999.` };
		}
		pick = val.padStart(3, "0");
	} else if (["milhar", "m"].includes(firstNorm)) {
		modality = "milhar";
		const val = cleanArgs[1];
		if (!val || !/^\d{1,4}$/.test(val)) {
			return { error: `Milhar inválida: "${val}". Deve ser um número de 0000 a 9999.` };
		}
		pick = val.padStart(4, "0");
	} else {
		// Auto-detecção se não passou palavra-chave de modalidade
		// Pode ser nome de bicho direto: ex: !bicho jacare 1000
		const joined = cleanArgs.join(" ");
		const animal = findAnimal(joined);
		if (animal) {
			modality = "grupo";
			pick = String(animal.group);
		} else if (/^\d{1,4}$/.test(joined)) {
			// Se passou apenas números:
			if (joined.length <= 2) {
				// Se tiver 1 ou 2 dígitos e puder ser dezena ou grupo?
				// Na vida real quando alguém joga 2 dígitos, é dezena (ou especifica grupo).
				// Para evitar ambiguidade: 1 ou 2 dígitos sem modalidade é tratado como dezena.
				modality = "dezena";
				pick = joined.padStart(2, "0");
			} else if (joined.length === 3) {
				modality = "centena";
				pick = joined.padStart(3, "0");
			} else if (joined.length === 4) {
				modality = "milhar";
				pick = joined.padStart(4, "0");
			}
		} else {
			return {
				error: `Modalidade ou bicho não reconhecido: "${joined}". Use: grupo, dezena, centena ou milhar.`
			};
		}
	}

	return {
		modality,
		pick,
		amount: Math.round(amount),
		scope
	};
}

/**
 * Gera 5 milhares aleatórias com crypto.randomInt (1º ao 5º prêmio)
 * Retorna array de 5 objetos { prizeNumber: 1..5, number: "0000", ten: "00", group: 1..25, animal: Animal }
 */
function generateDrawNumbers() {
	const prizes = [];
	for (let i = 1; i <= 5; i++) {
		const rand = crypto.randomInt(0, 10000);
		const numStr = String(rand).padStart(4, "0");
		const { ten, animal } = getAnimalForNumber(numStr);
		prizes.push({
			prize: i,
			number: numStr,
			ten,
			group: animal.group,
			animalName: animal.name,
			animalEmoji: animal.emoji
		});
	}
	return prizes;
}

/**
 * Avalia se uma aposta ganhou em relação a um sorteio (5 prêmios)
 *
 * @param {Object} bet - { modality, pick, amount, scope }
 * @param {Array} drawPrizes - Array com os 5 prêmios gerados por generateDrawNumbers()
 * @param {Object} config - { multipliers: { grupo, dezena, centena, milhar, cercadoDivisor }, maxPayout: number }
 * @returns {Object} { won: boolean, hits: number, payout: number, capped: boolean, details: string }
 */
function evaluateBet(bet, drawPrizes, config = {}) {
	const { modality, pick, amount, scope } = bet;
	const multipliers = config.multipliers || {
		grupo: 18,
		dezena: 60,
		centena: 600,
		milhar: 4000,
		cercadoDivisor: 5
	};
	const maxPayout = typeof config.maxPayout === "number" ? config.maxPayout : Infinity;

	const baseMult = multipliers[modality] || 0;
	if (baseMult <= 0) {
		return { won: false, hits: 0, payout: 0, capped: false, details: "Modalidade sem cotação" };
	}

	let hits = 0;
	const prizesToCheck = scope === "cercado" ? drawPrizes : [drawPrizes[0]];

	for (const p of prizesToCheck) {
		let match = false;
		if (modality === "grupo") {
			match = Number(pick) === Number(p.group);
		} else if (modality === "dezena") {
			match = String(pick).padStart(2, "0") === p.ten;
		} else if (modality === "centena") {
			match = String(pick).padStart(3, "0") === p.number.slice(-3);
		} else if (modality === "milhar") {
			match = String(pick).padStart(4, "0") === p.number;
		}
		if (match) {
			hits++;
		}
	}

	if (hits === 0) {
		return { won: false, hits: 0, payout: 0, capped: false, details: "Não premiado" };
	}

	let rawPayout = 0;
	if (scope === "cabeca") {
		// Na cabeça: ganha se acertar o 1º prêmio (hits será 1)
		rawPayout = amount * baseMult;
	} else {
		// No cercado: cotação base dividida pelo divisor (padrão 5) multiplicada pelo número de acertos (1..5)
		const cercadoDivisor = multipliers.cercadoDivisor || 5;
		const unitMultiplier = baseMult / cercadoDivisor;
		rawPayout = amount * unitMultiplier * hits;
	}

	const capped = rawPayout > maxPayout;
	const payout = capped ? maxPayout : Math.round(rawPayout);

	return {
		won: true,
		hits,
		rawPayout: Math.round(rawPayout),
		payout,
		capped,
		details: `${hits} acerto(s) no ${scope === "cabeca" ? "1º prêmio (Cabeça)" : "Cercado (1º ao 5º)"}`
	};
}

module.exports = {
	ANIMALS,
	TEN_TO_ANIMAL,
	GROUP_TO_ANIMAL,
	normalizeStr,
	findAnimal,
	getAnimalForNumber,
	parseBetArgs,
	generateDrawNumbers,
	evaluateBet
};
