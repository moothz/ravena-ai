// src/functions/FishingGame.js
const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const Database = require("../utils/Database");
const AdminUtils = require("../utils/AdminUtils");
const sdModule = require("./ComfyUICommands");
const ReturnMessage = require("../models/ReturnMessage");


const logger = new Logger("fishing-game");

const database = Database.getInstance();
const adminUtils = AdminUtils.getInstance();
const dbName = "fishing";

// Initialize Database
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS fishing_users (
        user_id TEXT PRIMARY KEY,
        name TEXT,
        baits INTEGER DEFAULT 7,
        last_bait_regen INTEGER,
        total_weight REAL DEFAULT 0,
        inventory_weight REAL DEFAULT 0,
        total_catches INTEGER DEFAULT 0,
        total_baits_used INTEGER DEFAULT 0,
        total_trash_caught INTEGER DEFAULT 0,
        biggest_fish_json TEXT
    );
    CREATE TABLE IF NOT EXISTS fishing_inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        name TEXT,
        weight REAL,
        is_rare INTEGER,
        timestamp INTEGER,
        emoji TEXT,
        data_json TEXT
    );
    CREATE TABLE IF NOT EXISTS fishing_group_stats (
        group_id TEXT,
        user_id TEXT,
        name TEXT,
        total_weight REAL DEFAULT 0,
        total_catches INTEGER DEFAULT 0,
        biggest_fish_json TEXT,
        PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS fishing_legendary_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fish_name TEXT,
        weight REAL,
        user_id TEXT,
        user_name TEXT,
        group_id TEXT,
        group_name TEXT,
        timestamp INTEGER,
        image_name TEXT
    );
    CREATE TABLE IF NOT EXISTS fishing_buffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        effect_type TEXT,
        is_debuff INTEGER DEFAULT 0,
        value REAL,
        min_value REAL,
        max_value REAL,
        remaining_uses INTEGER,
        original_name TEXT
    );
    -- Tabelas de Histórico para Reset Anual
    CREATE TABLE IF NOT EXISTS fishing_users_history (
        user_id TEXT,
        name TEXT,
        total_weight REAL,
        total_catches INTEGER,
        total_baits_used INTEGER,
        total_trash_caught INTEGER,
        year INTEGER,
        PRIMARY KEY (user_id, year)
    );
    CREATE TABLE IF NOT EXISTS fishing_group_stats_history (
        group_id TEXT,
        user_id TEXT,
        name TEXT,
        total_weight REAL,
        total_catches INTEGER,
        biggest_fish_json TEXT,
        year INTEGER,
        PRIMARY KEY (group_id, user_id, year)
    );
`
);

// Ensure Schema Changes and Initializations
(async () => {
	try {
		// Migration: Add year column to legendary history
		await database.dbRun(dbName, "ALTER TABLE fishing_legendary_history ADD COLUMN year INTEGER");
	} catch (e) {
		// Ignore if column already exists
	}
})();

// --- CONSTANTES DO JOGO ---
const DIFFICULTY_THRESHOLD = 80;
const FISHING_COOLDOWN = 5;
const MIN_FISH_WEIGHT = 1;
const MAX_FISH_WEIGHT = 30;
const MAX_FISH_PER_USER = 10;
const MAX_BAITS = 5;
const BAIT_REGEN_TIME = 60 * 60 * 1;

// Armazena os cooldowns de pesca (Cache em memória é aceitável para cooldowns de curto prazo)
const fishingCooldowns = {};
// Ajustado escala de mensagens para o novo peso máximo
const weightScaleMsgs = [180, 150, 120, 100, 80, 60];

// --- CONFIGURAÇÕES DE PEIXES E ITENS ---

// Peixes raríssimos e seus pesos adicionais
const RARE_FISH = [
	{
		name: "Cthulhu",
		chance: 0.000002,
		monthlyLimit: 1,
		weightBonus: 26665,
		emoji: "🐙",
		description: "cosmic horror, tentacles on face, giant wings, green scaly humanoid dragon"
	},
	{
		name: "Jörmungandr",
		chance: 0.000003,
		monthlyLimit: 1,
		weightBonus: 17200,
		emoji: "🌏",
		description: "world serpent, colossal sea snake, glowing blue scales, ancient runes"
	},
	{
		name: "Ryūjin",
		chance: 0.000007,
		monthlyLimit: 1,
		weightBonus: 12050,
		emoji: "⛩️",
		description: "Japanese sea dragon, long serpentine body, holding a tide jewel, regal and divine"
	},
	{
		name: "Dai Gum Loong",
		chance: 0.000008,
		monthlyLimit: 1,
		weightBonus: 9100,
		emoji: "🐲",
		description: "giant golden Chinese dragon, five-clawed, whiskers, flowing mane, majestic"
	},
	{
		name: "Godzilla",
		chance: 0.000009,
		monthlyLimit: 1,
		weightBonus: 8190,
		emoji: "🦖",
		description: "king of monsters, giant prehistoric lizard, jagged dorsal fins, blue atomic glow"
	},
	{
		name: "Leviathan",
		chance: 0.00001,
		monthlyLimit: 1,
		weightBonus: 7280,
		emoji: "🐉",
		description:
			"biblical sea monster, armored plates, multi-headed, fire and steam emerging from scales"
	},
	{
		name: "Bakunawa",
		chance: 0.000011,
		monthlyLimit: 1,
		weightBonus: 7020,
		emoji: "🌑",
		description:
			"moon-swallowing sea serpent, giant gills, dragon-like features, Filipino mythology"
	},
	{
		name: "Hydra",
		chance: 0.000012,
		monthlyLimit: 1,
		weightBonus: 5005,
		emoji: "🐍",
		description:
			"multi-headed serpentine beast, green and purple scales, toxic breath, swampy atmosphere"
	},
	{
		name: "Charybdis",
		chance: 0.000013,
		monthlyLimit: 1,
		weightBonus: 5980,
		emoji: "🌀",
		description:
			"sentient massive whirlpool, rows of sharp teeth inside a vortex, sucking everything in"
	},
	{
		name: "Megalodon",
		chance: 0.000015,
		monthlyLimit: 1,
		weightBonus: 5460,
		emoji: "🦈",
		description: "prehistoric apex predator shark, massive jaws, battle scars, dark gray skin"
	},
	{
		name: "Aspidochelone",
		chance: 0.000018,
		monthlyLimit: 1,
		weightBonus: 4290,
		emoji: "🏝️",
		description:
			"island-sized turtle, trees and greenery on its back, coral-covered shell, ancient eyes"
	},
	{
		name: "Kraken",
		chance: 0.00002,
		monthlyLimit: 1,
		weightBonus: 6825,
		emoji: "🦑",
		description: "colossal cephalopod, massive powerful tentacles, beak, dark ink clouds around it"
	},
	{
		name: "Makara",
		chance: 0.000021,
		monthlyLimit: 1,
		weightBonus: 3705,
		emoji: "🐊",
		description:
			"hybrid creature, crocodile body, elephant trunk, fish tail, ornate Hindu ornaments"
	},
	{
		name: "Umibōzu",
		chance: 0.000024,
		monthlyLimit: 1,
		weightBonus: 3250,
		emoji: "🌫️",
		description:
			"giant shadowy sea spirit, smooth bald head, glowing white eyes, emerging from dark water"
	},
	{
		name: "Nessie",
		chance: 0.000025,
		monthlyLimit: 1,
		weightBonus: 4095,
		emoji: "🦕",
		description:
			"long-necked lake monster, plesiosaur body, dark green skin, elusive and mysterious"
	},
	{
		name: "Taniwha",
		chance: 0.000028,
		monthlyLimit: 1,
		weightBonus: 4550,
		emoji: "🗿",
		description: "Maori guardian spirit, lizard-whale hybrid, tribal tattoo-like patterns on skin"
	},
	{
		name: "Moby Dick",
		chance: 0.00003,
		monthlyLimit: 1,
		weightBonus: 2795,
		emoji: "🐳",
		description:
			"monstrous white sperm whale, scarred head, broken harpoons and ropes stuck in back"
	},
	{
		name: "Kelpie",
		chance: 0.000035,
		monthlyLimit: 1,
		weightBonus: 2210,
		emoji: "🐎",
		description: "shapeshifting water horse, seaweed mane, webbed hooves, predatory look"
	},
	{
		name: "Sedna",
		chance: 0.000045,
		monthlyLimit: 2,
		weightBonus: 1690,
		emoji: "🧜‍♀️",
		description:
			"Inuit sea goddess, mermaid-like, long black hair flowing in water, seals and walruses around her"
	},
	{
		name: "Baleia",
		chance: 0.00005,
		monthlyLimit: 3,
		weightBonus: 1200,
		emoji: "🐋",
		description: "majestic giant blue whale, immense scale, barnacles on skin, graceful movement"
	}
];

// Itens de lixo que podem ser pescados
const TRASH_ITEMS = [
	{ name: "Bota velha", emoji: "👢" },
	{ name: "Sacola plástica", emoji: "🛍️" },
	{ name: "Latinha", emoji: "🥫" },
	{ name: "Mochila rasgada", emoji: "🎒" },
	{ name: "Saco de lixo", emoji: "🧹" },
	{ name: "Pneu furado", emoji: "🛞" },
	{ name: "Garrafa vazia", emoji: "🍾" },
	{ name: "Chapéu de pirata", emoji: "👒" },
	{ name: "Celular quebrado", emoji: "📱" },
	{ name: "Relógio parado", emoji: "⌚" },
	{ name: "Bebê Reborn", emoji: "👶" },
	{ name: "Faca Velha", emoji: "🔪" },
	{ name: "Tesoura Enferrujada", emoji: "✂" },
	{ name: "Cadeado Sem Chave", emoji: "🔒" },
	{ name: "Botão de salvar?", emoji: "💾" },
	{ name: "Hétero", emoji: "🔝" },
	{ name: "Microscópio Sujo", emoji: "🔬" },
	{ name: "Extintor Velho", emoji: "🧯" },
	{ name: "Camisinha Furada", emoji: "🎈" },
	{ name: "Conta de Energia", emoji: "📜" },
	{ name: "Conta de Água", emoji: "📜" },
	{ name: "Boleto do Condomínio", emoji: "📜" },
	{ name: "Siso Cariado", emoji: "🦷" },
	{ name: "Maiô Rasgado", emoji: "🩱" },
	{ name: "Biquíni", emoji: "👙" },
	{ name: "Anel de Plástico", emoji: "💍" },
	{ name: "Fita Mimosa", emoji: "🎗" },
	{ name: "Boia Seca", emoji: "🛟" },
	{ name: "Relógio Enferrujado", emoji: "⏲" },
	{ name: "Imã", emoji: "🧲" },
	{ name: "Tijolo 6 Furo", emoji: "🧱" },
	{ name: "Chapa de Raio X", emoji: "🩻" },
	{ name: "Fita Fofinha", emoji: "🎀" },
	{ name: "CD do Araketu", emoji: "💿" },
	{ name: "Vinil da Xuxa", emoji: "💽" },
	{ name: "Tamagotchi sem bateria", emoji: "🤖" },
	{ name: "Cartucho de Polystation", emoji: "🕹️" },
	{ name: "Nota de 3 reais", emoji: "💸" },
	{ name: "Meia furada", emoji: "🧦" },
	{ name: "Cigarro de paieiro apagado", emoji: "🚬" },
	{ name: "Panela de pressão sem pino", emoji: "🥘" },
	{ name: "Controle remoto universal que não funciona", emoji: "📺" },
	{ name: "Convite de casamento de 2005", emoji: "💌" },
	{ name: "Resto de marmita", emoji: "🥡" },
	{ name: "Espelho quebrado", emoji: "🪞" },
	{ name: "Baralho faltando carta", emoji: "🃏" },
	{ name: "Pente sem dente", emoji: "🪮" },
	{ name: "Óculos sem lente", emoji: "👓" },
	{ name: "Pacote da Shopee", emoji: "📦" },
	{ name: "Pacote da OLX", emoji: "📦" },
	{ name: "Pacote do Mercado Livre", emoji: "📦" },
	{ name: "Pacote do AliExpress", emoji: "📦" },
	{ name: "Pacote da Amazon", emoji: "📦" },
	{ name: "Chinelo Havaiana (só o pé esquerdo)", emoji: "🩴" },
	{ name: "Chinelo Havaiana (só o pé direito)", emoji: "🩴" },
	{ name: "Bola 8 de Bilhar", emoji: "🎱" },
	{ name: "Ursinho de Pelúcia Encharcado", emoji: "🧸" },
	{ name: "Semáforo (Como isso veio parar aqui?)", emoji: "🚦" },
	{ name: "Caixão de Vampiro (miniatura)", emoji: "🧛" },
	{ name: "DVD Pirata do Shrek", emoji: "📀" },
	{ name: "Estátua da Liberdade de Plástico", emoji: "🗽" },
	{ name: "Cérebro em Formol (Credo!)", emoji: "🧠" },
	{ name: "Remo Quebrado", emoji: "🛶" },
	{ name: "Skate sem Rodas", emoji: "🛹" },
	{ name: "Assento Sanitário", emoji: "🚽" },
	{ name: "Escudo Medieval de Isopor", emoji: "🛡️" },
	{ name: "Cabeça da Ilha de Páscoa (Peso de papel)", emoji: "🗿" },
	{ name: "Teste de DNA (Negativo)", emoji: "🧬" },
	{ name: "Peruca de Sereia", emoji: "🧜‍♀️" },
	{ name: "Múmia de Gato", emoji: "🐈‍⬛" },
	{ name: "Cabo USB que não conecta", emoji: "🔌" },
	{ name: "Pizza de Ontem (Molhada)", emoji: "🍕" }
];

// Upgrades para pesca
const UPGRADES = [
	{
		name: "Sonar Portátil",
		chance: 0.02,
		emoji: "📡",
		effect: "guaranteed_weight",
		minValue: 40,
		maxValue: 90,
		description: "Garante que o próximo peixe tenha entre 40kg e 90kg."
	},
	{
		name: "Minhocão",
		chance: 0.05,
		emoji: "🐛",
		effect: "next_fish_bonus",
		minValue: 10,
		maxValue: 30,
		description: "Adiciona um bônus de 10 a 30kg ao próximo peixe."
	},
	{
		name: "Chapéu de Pescador",
		chance: 0.05,
		emoji: "👒",
		effect: "weight_boost",
		value: 0.2,
		duration: 3,
		description: "Aumenta o peso dos próximos 3 peixes em 20%."
	},
	{
		name: "Carretel",
		chance: 0.02,
		emoji: "🧵",
		effect: "weight_boost",
		value: 0.75,
		duration: 3,
		description: "Aumenta o peso dos próximos 3 peixes em 75%."
	},
	{
		name: "Pacote de Iscas",
		chance: 0.1,
		emoji: "🎁",
		effect: "extra_baits",
		minValue: 1,
		maxValue: 3,
		description: "Ganha de 1 a 3 iscas extras."
	},
	//{ name: "Amuleto do Pescador", chance: 0.01, emoji: "🧿", effect: "rare_chance_boost", value: 0.0003, duration: 5, description: "Aumenta a chance de encontrar peixes raros nas próximas 5 pescarias." },
	//{ name: "Isca de Diamante", chance: 0.005, emoji: "💎", effect: "rare_chance_boost", value: 0.001, duration: 3, description: "Aumenta drasticamente a chance de raros por 3 pescarias." },
	//{ name: "Licença de Pesca Premium", chance: 0.03, emoji: "📜", effect: "cooldown_reduction", value: 0.5, duration: 5, description: "Reduz o tempo de espera para pescar em 50% nas próximas 5 pescarias." },
	{
		name: "Ficha de Cassino",
		chance: 0.04,
		emoji: "🎰",
		effect: "slots_coins",
		minValue: 1,
		maxValue: 5,
		description: "Ganha de 1 a 5 moedinhas para usar no !slots!"
	},
	{
		name: "Balança Adulterada",
		chance: 0.01,
		emoji: "⚖️",
		effect: "weight_boost",
		value: 1.5,
		duration: 1,
		description: "Aumenta o peso do próximo peixe em 150%!"
	},
	//{ name: "Energético de Pescador", chance: 0.02, emoji: "⚡", effect: "cooldown_reduction", value: 0.9, duration: 2, description: "Reduz o tempo de espera em 90% nas próximas 2 pescarias." },
	{
		name: "Anzol de Titânio",
		chance: 0.025,
		emoji: "🔩",
		effect: "bait_on_trash",
		duration: 10,
		description: "Evita a perda de isca ao pescar lixo pelas próximas 10 vezes."
	},

	{
		name: "Bolso de Pesca",
		chance: 0.008,
		emoji: "👖",
		effect: "inventory_slot",
		value: 1,
		description: "Aumenta seu inventário em 1."
	},
	{
		name: "Calça de Pesca",
		chance: 0.004,
		emoji: "👖",
		effect: "inventory_slot",
		value: 2,
		description: "Aumenta seu inventário em 2."
	},
	{
		name: "Mochilão",
		chance: 0.0001,
		emoji: "🎒",
		effect: "inventory_slot",
		value: 4,
		description: "Aumenta seu inventário em 4."
	},

	{
		name: "Pochete de Iscas",
		chance: 0.0056,
		emoji: "👜",
		effect: "max_baits",
		value: 1,
		description: "Aumenta seu limite de iscas em 1."
	},
	{
		name: "Caixa de Iscas",
		chance: 0.0028,
		emoji: "🧰",
		effect: "max_baits",
		value: 2,
		description: "Aumenta seu limite de iscas em 2."
	},
	{
		name: "Viveiro Portátil",
		chance: 0.0005,
		emoji: "⛲",
		effect: "max_baits",
		value: 4,
		description: "Aumenta seu limite de iscas em 4."
	}
];

// Downgrades para pesca
const DOWNGRADES = [
	{
		name: "Mina Aquática",
		chance: 0.0003,
		emoji: "💣",
		effect: "clear_inventory",
		description: "Esvazia seu inventário de peixes."
	},
	{
		name: "Vela Acesa do 𝒸𝒶𝓅𝒾𝓇𝑜𝓉𝑜",
		chance: 0.006,
		emoji: "🕯",
		effect: "weight_loss",
		value: -0.4,
		duration: 3,
		description: "sǝxᴉǝd Ɛ soɯᴉxóɹd sop osǝd o znpǝɹ"
	},
	{
		name: "Tartaruga Gulosa",
		chance: 0.015,
		emoji: "🐢",
		effect: "remove_baits",
		minValue: 1,
		maxValue: 3,
		description: "Remove de 1 a 3 iscas."
	},
	{
		name: "Anzol Enferrujado",
		chance: 0.02,
		emoji: "🪝",
		effect: "bait_on_trash",
		duration: 3,
		description: "Você não perde a isca ao pescar lixo nas próximas 3 vezes que isso acontecer."
	},
	{
		name: "Fiscalização Ambiental",
		chance: 0.005,
		emoji: "👮",
		effect: "longer_cooldown",
		value: 3,
		duration: 3,
		description: "Aumenta o tempo de espera para pescar em 3x nas próximas 3 pescarias."
	},
	{
		name: "Enchente Súbita",
		chance: 0.01,
		emoji: "🌊",
		effect: "lose_smallest_fish",
		description: "A correnteza levou seu peixe mais leve embora."
	},
	{
		name: "Gato Ladrão",
		chance: 0.01,
		emoji: "🐈",
		effect: "lose_recent_fish",
		description: "Um gato pulou e roubou o peixe que você acabou de pegar!"
	},
	{
		name: "Balde Furado",
		chance: 0.02,
		emoji: "🗑️",
		effect: "remove_baits",
		minValue: 2,
		maxValue: 4,
		description: "Seu balde furou! Você perdeu entre 2 e 4 iscas."
	},
	{
		name: "Olho Gordo",
		chance: 0.03,
		emoji: "🧿",
		effect: "weight_loss",
		value: -0.8,
		duration: 2,
		description: "O olho gordo dos invejosos reduziu 80% do peso dos seus próximos 2 peixes."
	}
];

//
RARE_FISH.sort((a, b) => a.chance - b.chance);
UPGRADES.sort((a, b) => a.chance - b.chance);
DOWNGRADES.sort((a, b) => a.chance - b.chance);

const DEFAULT_GLOBAL_FACTORS = {
	trashChance: 1.0,
	buffChance: 1.0,
	debuffChance: 0.8,
	rareFishChance: 1.5,
	weightFactor: 1.0
};

// --- HELPER FUNCTIONS FOR DB ---

async function getUserData(userId) {
	//logger.debug(`[fishing][getUserData] ${userId}`);
	const row = await database.dbGet(dbName, "SELECT * FROM fishing_users WHERE user_id = ?", [
		userId
	]);
	if (!row) return null;

	// Load inventory
	const fishes = await database.dbAll(dbName, "SELECT * FROM fishing_inventory WHERE user_id = ?", [
		userId
	]);
	const parsedFishes = fishes.map((f) => {
		const data = JSON.parse(f.data_json || "{}");
		return {
			...data,
			name: f.name,
			weight: f.weight,
			isRare: !!f.is_rare,
			emoji: f.emoji,
			timestamp: f.timestamp,
			dbId: f.id
		};
	});

	// Load buffs
	const buffs = await database.dbAll(
		dbName,
		"SELECT * FROM fishing_buffs WHERE user_id = ? AND is_debuff = 0",
		[userId]
	);
	const parsedBuffs = buffs.map((b) => ({
		type: b.effect_type,
		value: b.value,
		minValue: b.min_value,
		maxValue: b.max_value,
		remainingUses: b.remaining_uses,
		originalName: b.original_name,
		dbId: b.id
	}));

	// Load debuffs
	const debuffs = await database.dbAll(
		dbName,
		"SELECT * FROM fishing_buffs WHERE user_id = ? AND is_debuff = 1",
		[userId]
	);
	const parsedDebuffs = debuffs.map((b) => ({
		type: b.effect_type,
		value: b.value,
		minValue: b.min_value,
		maxValue: b.max_value,
		remainingUses: b.remaining_uses,
		originalName: b.original_name,
		dbId: b.id
	}));

	return {
		userId: row.user_id,
		name: row.name,
		baits: row.baits,
		lastBaitRegen: row.last_bait_regen,
		totalWeight: row.total_weight,
		inventoryWeight: row.inventory_weight,
		totalCatches: row.total_catches,
		totalBaitsUsed: row.total_baits_used,
		totalTrashCaught: row.total_trash_caught,
		biggestFish: JSON.parse(row.biggest_fish_json || "null"),
		fishes: parsedFishes,
		buffs: parsedBuffs,
		debuffs: parsedDebuffs
	};
}

async function saveUserData(userData) {
	// Note: Inventory and Buffs should be handled by specific insert/delete queries during gameplay for performance.
	// This function updates the main user stats.
	await database.dbRun(
		dbName,
		`INSERT OR REPLACE INTO fishing_users 
        (user_id, name, baits, last_bait_regen, total_weight, inventory_weight, total_catches, total_baits_used, total_trash_caught, biggest_fish_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			userData.userId,
			userData.name,
			userData.baits,
			userData.lastBaitRegen,
			userData.totalWeight,
			userData.inventoryWeight,
			userData.totalCatches,
			userData.totalBaitsUsed,
			userData.totalTrashCaught,
			JSON.stringify(userData.biggestFish)
		]
	);
}

async function updateGroupStats(groupId, userId, userName, weightToAdd, isCatch, biggestFish) {
	const row = await database.dbGet(
		dbName,
		"SELECT * FROM fishing_group_stats WHERE group_id = ? AND user_id = ?",
		[groupId, userId]
	);
	let totalWeight = row ? row.total_weight : 0;
	let totalCatches = row ? row.total_catches : 0;
	let currentBiggest = row ? JSON.parse(row.biggest_fish_json || "null") : null;

	if (isCatch) {
		totalWeight += weightToAdd;
		totalCatches += 1;
		if (!currentBiggest || (biggestFish && biggestFish.weight > currentBiggest.weight)) {
			currentBiggest = biggestFish;
		}
	} else {
		// Removed fish or trash
		totalWeight -= weightToAdd;
		totalCatches -= 1;
	}

	await database.dbRun(
		dbName,
		`INSERT OR REPLACE INTO fishing_group_stats 
        (group_id, user_id, name, total_weight, total_catches, biggest_fish_json)
        VALUES (?, ?, ?, ?, ?, ?)`,
		[groupId, userId, userName, totalWeight, totalCatches, JSON.stringify(currentBiggest)]
	);
}

async function addBuff(userId, buff, isDebuff) {
	await database.dbRun(
		dbName,
		`INSERT INTO fishing_buffs 
        (user_id, effect_type, is_debuff, value, min_value, max_value, remaining_uses, original_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			userId,
			buff.type,
			isDebuff ? 1 : 0,
			buff.value,
			buff.minValue,
			buff.maxValue,
			buff.remainingUses,
			buff.originalName
		]
	);
}

async function updateBuffUses(buffId, remainingUses) {
	if (remainingUses <= 0) {
		await database.dbRun(dbName, "DELETE FROM fishing_buffs WHERE id = ?", [buffId]);
	} else {
		await database.dbRun(dbName, "UPDATE fishing_buffs SET remaining_uses = ? WHERE id = ?", [
			remainingUses,
			buffId
		]);
	}
}

async function addFishToInventory(userId, fish) {
	const result = await database.dbRun(
		dbName,
		`INSERT INTO fishing_inventory 
        (user_id, name, weight, is_rare, timestamp, emoji, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			userId,
			fish.name,
			fish.weight,
			fish.isRare ? 1 : 0,
			fish.timestamp,
			fish.emoji,
			JSON.stringify(fish)
		]
	);
	return result.lastID;
}

async function removeFishFromInventory(userId, fishDbId) {
	if (fishDbId) {
		await database.dbRun(dbName, "DELETE FROM fishing_inventory WHERE id = ?", [fishDbId]);
	} else {
		// Fallback if we don't have ID (should not happen in new logic, but for safety)
		// This is risky, so we better ensure we always have DB IDs.
		// For now, if no ID, we might delete the wrong fish if duplicates exist.
		// We will assume logic always reloads data so IDs are present.
	}
}

async function clearInventory(userId) {
	await database.dbRun(dbName, "DELETE FROM fishing_inventory WHERE user_id = ?", [userId]);
}

// --- LÓGICA DO JOGO ---

async function getMonthlyCatchCount(fishName) {
	const now = new Date();
	const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
	const row = await database.dbGet(
		dbName,
		"SELECT COUNT(*) as c FROM fishing_legendary_history WHERE fish_name = ? AND timestamp >= ?",
		[fishName, startOfMonth]
	);
	return row ? row.c : 0;
}

/**
 * Obtém peixe aleatório do array de peixes com escala de dificuldade
 */
async function getRandomFish(fishArray, isMultiCatch = false, userData = null) {
	// Verifica se o array tem peixes
	if (!fishArray || !Array.isArray(fishArray) || fishArray.length === 0) {
		const customVariables = await database.getCustomVariables();

		fishArray = customVariables.peixes;
	}

	const weightFactor = DEFAULT_GLOBAL_FACTORS.weightFactor || 1.0;

	// Se for pescaria múltipla, não permite peixes raros
	if (!isMultiCatch) {
		let rareBuffValue = 0;

		if (userData && userData.buffs) {
			const rareChanceBuff = userData.buffs.find(
				(b) => b.type === "rare_chance_boost" && b.remainingUses > 0
			);
			if (rareChanceBuff) {
				// We don't consume it here, handled in handleBuffDecrement
				rareBuffValue = rareChanceBuff.value;
			}
		}

		for (const rareFish of RARE_FISH) {
			let currentChance = rareFish.chance;

			if (rareBuffValue > 0) {
				currentChance += rareBuffValue;
			}

			// Aplica fator global
			currentChance *= DEFAULT_GLOBAL_FACTORS.rareFishChance;

			const rng = Math.random();
			if (rng < currentChance) {
				// Potential Catch - Check Limits
				const caughtCount = await getMonthlyCatchCount(rareFish.name);
				if (caughtCount >= rareFish.monthlyLimit) {
					logger.debug(
						`[getRandomFish] Limit reached for ${rareFish.name} (${caughtCount}/${rareFish.monthlyLimit}). Skipped.`
					);
					continue;
				}

				logger.debug(
					`[getRandomFish] RARO CAPTURADO: ${rareFish.name} | Chance base ${rareFish.chance} | Buff ${rareBuffValue} | RNG ${rng} < ${currentChance}`
				);

				const baseWeight = parseFloat(
					(Math.random() * (MAX_FISH_WEIGHT - MIN_FISH_WEIGHT) + MIN_FISH_WEIGHT).toFixed(2)
				);
				const totalWeight = baseWeight + rareFish.weightBonus;

				return {
					name: rareFish.name,
					weight: totalWeight,
					timestamp: Date.now(),
					chance: currentChance,
					isRare: true,
					emoji: rareFish.emoji,
					description: rareFish.description,
					baseWeight,
					bonusWeight: rareFish.weightBonus
				};
			}
		}
	}

	// Peixe normal
	const fishIndex = Math.floor(Math.random() * fishArray.length);
	const fishName = fishArray[fishIndex];
	let weight;

	if (userData && userData.buffs) {
		const guaranteedWeightBuff = userData.buffs.find(
			(b) => b.type === "guaranteed_weight" && b.remainingUses > 0
		);
		if (guaranteedWeightBuff) {
			weight = parseFloat(
				(
					Math.random() * (guaranteedWeightBuff.maxValue - guaranteedWeightBuff.minValue) +
					guaranteedWeightBuff.minValue
				).toFixed(2)
			);
			// Decrement handled in handleBuffDecrement
			return { name: fishName, weight, timestamp: Date.now() };
		}
	}

	if (Math.random() < 0.8) {
		// 80% de chance de pegar um peixe normal
		weight = parseFloat(
			(Math.random() * (DIFFICULTY_THRESHOLD - MIN_FISH_WEIGHT) + MIN_FISH_WEIGHT).toFixed(2)
		);
	} else {
		// 20% de chance de dificuldade progressiva
		const difficultyRange = MAX_FISH_WEIGHT - DIFFICULTY_THRESHOLD;
		const randomValue = Math.random();
		const exponent = 3;
		const difficultyFactor = 1 - Math.pow(randomValue, exponent);
		weight = parseFloat((DIFFICULTY_THRESHOLD + difficultyFactor * difficultyRange).toFixed(2));
	}

	// Apply Global Weight Factor
	if (weightFactor !== 1.0) {
		weight = parseFloat((weight * weightFactor).toFixed(2));
	}

	return {
		name: fishName,
		weight,
		timestamp: Date.now()
	};
}

/**
 * Verifica e regenera iscas para um jogador
 */
function regenerateBaits(userData) {
	const maxBaits = getMaxBaits(userData);

	if (userData.baits === undefined) {
		userData.baits = maxBaits;
		userData.lastBaitRegen = Date.now();
		return userData;
	}

	if (userData.baits >= maxBaits) {
		userData.lastBaitRegen = Date.now();
		return userData;
	}

	const now = Date.now();
	const lastRegen = userData.lastBaitRegen ?? now;
	const elapsedSeconds = Math.floor((now - lastRegen) / 1000);
	const regensCount = Math.floor(elapsedSeconds / BAIT_REGEN_TIME);

	if (regensCount > 0) {
		userData.baits = Math.min(userData.baits + regensCount, maxBaits);
		userData.lastBaitRegen = now - (elapsedSeconds % BAIT_REGEN_TIME) * 1000;
	}

	return userData;
}

/**
 * Comando restrito que permite adicionar iscas
 */
async function addBaits(userId, baitsNum) {
	userId = `${userId}`.replace(/\D/g, "");
	//userId = userId.split("@")[0] + "@c.us";

	let userData = await getUserData(userId);
	const maxBaits = getMaxBaits(userData || {});

	if (!userData) {
		// Create basic user if not exists
		userData = {
			userId,
			name: "User",
			baits: maxBaits,
			lastBaitRegen: Date.now(),
			totalWeight: 0,
			inventoryWeight: 0,
			totalCatches: 0,
			totalBaitsUsed: 0,
			totalTrashCaught: 0,
			biggestFish: null
		};
	}

	userData.baits += baitsNum;
	userData.lastBaitRegen = Date.now(); // Reset regeneration timer when modified manually? Or keep it? Keeping it simple.

	await saveUserData(userData);

	return { userId, userData };
}

async function addBaitsCmd(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	try {
		if (!adminUtils.isSuperAdmin(message.author)) {
			return;
		}

		if (!args[0] || !args[1])
			return new ReturnMessage({ chatId, content: "❌ Uso: !psc-addBaits <@user|global> <qtd>" });

		const target = args[0];
		const baitsNum = parseInt(args[1]);

		if (isNaN(baitsNum)) return new ReturnMessage({ chatId, content: "❌ Quantidade inválida." });

		if (target.toLowerCase() === "global") {
			await database.dbRun(
				dbName,
				"UPDATE fishing_users SET baits = baits + ?, last_bait_regen = ?",
				[baitsNum, Date.now()]
			);
			return new ReturnMessage({
				chatId,
				content: `🎣 ${baitsNum} iscas adicionadas para TODOS os jogadores!`,
				reaction: "🎣"
			});
		}

		const dados = await addBaits(target, baitsNum);

		if (!dados.userData) {
			return new ReturnMessage({
				chatId,
				content: `🐡 Erro: usuário não encontrado.`,
				reaction: "🐡"
			});
		} else {
			return new ReturnMessage({
				chatId,
				content: `🎣 Iscas de '${target}' ajustadas para ${dados.userData.baits}`,
				reaction: "🎣"
			});
		}
	} catch (e) {
		logger.error("Erro no addBaitsCmd", e);
		return new ReturnMessage({ chatId, content: "Erro interno." });
	}
}

function getNextBaitRegenTime(userData) {
	const maxBaits = getMaxBaits(userData);
	const now = Date.now();
	const lastRegen = userData.lastBaitRegen ?? now;
	const elapsedSeconds = Math.floor((now - lastRegen) / 1000);
	const secondsUntilNextBait = BAIT_REGEN_TIME - (elapsedSeconds % BAIT_REGEN_TIME);
	const missingBaits = maxBaits - userData.baits;
	const secondsUntilAllBaits = secondsUntilNextBait + (missingBaits - 1) * BAIT_REGEN_TIME;

	return {
		secondsUntilNextBait,
		secondsUntilAllBaits,
		nextBaitTime: new Date(now + secondsUntilNextBait * 1000),
		allBaitsTime: new Date(now + secondsUntilAllBaits * 1000)
	};
}

function formatTimeString(seconds) {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainingSeconds = seconds % 60;
	let timeString = "";
	if (hours > 0) timeString += `${hours}h `;
	if (minutes > 0 || hours > 0) timeString += `${minutes}m `;
	timeString += `${remainingSeconds}s`;
	return timeString;
}

function checkRandomItem() {
	const factors = DEFAULT_GLOBAL_FACTORS;

	if (Math.random() < 0.15 * factors.trashChance) {
		const trashIndex = Math.floor(Math.random() * TRASH_ITEMS.length);
		return { type: "trash", ...TRASH_ITEMS[trashIndex] };
	}

	for (const upgrade of UPGRADES) {
		if (Math.random() < upgrade.chance * factors.buffChance) {
			const itemData = { ...upgrade, type: "upgrade" };
			if (
				upgrade.effect === "extra_baits" ||
				upgrade.effect === "next_fish_bonus" ||
				upgrade.effect === "slots_coins"
			) {
				itemData.value =
					Math.floor(Math.random() * (upgrade.maxValue - upgrade.minValue + 1)) + upgrade.minValue;
			}
			return itemData;
		}
	}

	for (const downgrade of DOWNGRADES) {
		if (Math.random() < downgrade.chance * factors.debuffChance) {
			const itemData = { ...downgrade, type: "downgrade" };
			if (downgrade.effect === "remove_baits") {
				itemData.value =
					Math.floor(Math.random() * (downgrade.maxValue - downgrade.minValue + 1)) +
					downgrade.minValue;
			}
			return itemData;
		}
	}
	return null;
}

async function applyItemEffect(userData, item) {
	let effectMessage = "";
	// Note: Buffs/Debuffs are added to DB here

	switch (item.type) {
		case "trash":
			const baitOnTrashDebuff = userData.debuffs.find(
				(d) => d.type === "bait_on_trash" && d.remainingUses > 0
			);
			const baitOnTrashBuff = userData.buffs.find(
				(b) => b.type === "bait_on_trash" && b.remainingUses > 0
			);
			const trashProtector = baitOnTrashDebuff ?? baitOnTrashBuff;

			if (trashProtector) {
				// Decrement handled in handleBuffDecrement
				effectMessage = `\n\n${item.emoji} Você pescou um(a) ${item.name}, mas seu ${trashProtector.originalName ?? "Anzol"} te salvou de perder a isca!`;
			} else {
				effectMessage = `\n\n${item.emoji} Você pescou um(a) ${item.name}. Que pena!`;
			}
			break;

		case "upgrade":
			switch (item.effect) {
				case "weight_boost":
				case "next_fish_bonus":
				case "double_catch":
				case "rare_chance_boost":
				case "cooldown_reduction":
				case "guaranteed_weight":
				case "bait_on_trash":
					const buff = {
						type: item.effect,
						value: item.value,
						minValue: item.minValue,
						maxValue: item.maxValue,
						remainingUses: item.duration || 1,
						originalName: item.name
					};
					await addBuff(userData.userId, buff, false);
					effectMessage = `\n\n${item.emoji} Você encontrou um ${item.name}! ${item.description}`;
					break;
				case "extra_baits":
					userData.baits = userData.baits + item.value;
					effectMessage = `\n\n${item.emoji} Você encontrou um ${item.name}! +${item.value} iscas adicionadas (${userData.baits}/${MAX_BAITS}).`;
					break;
				case "slots_coins":
					await require("./SlotsGame").addCoins(userData.userId, item.value);
					effectMessage = `\n\n${item.emoji} Você encontrou um ${item.name}! +${item.value} moedinhas adicionadas ao seu saldo do !slots.`;
					break;
			}
			break;

		case "downgrade":
			switch (item.effect) {
				case "weight_loss":
					await addBuff(
						userData.userId,
						{
							type: item.effect,
							value: item.value,
							remainingUses: item.duration,
							originalName: item.name
						},
						true
					);
					effectMessage = `\n\n${item.emoji} 𝕍𝕠𝕔ê 𝕡𝕖𝕤𝕔𝕠𝕦 𝕦𝕞𝕒... 🕯️𝕍𝔼𝕃𝔸 𝔸ℂ𝔼𝕊𝔸?! 😱 𝒪𝒷𝓇𝒶 𝒹𝑜 𝒸𝒶𝓅𝒾𝓇𝑜𝓉𝑜! 🔥👹🩸`;
					break;
				case "clear_inventory":
					await clearInventory(userData.userId);
					userData.fishes = [];
					userData.totalWeight -= userData.inventoryWeight ?? 0;
					userData.inventoryWeight = 0;
					effectMessage = `\n\n${item.emoji} OH NÃO! Você encontrou uma ${item.name}! Seu inventário de peixes foi destruído!`;
					break;
				case "remove_baits":
					const baitsLost = Math.min(userData.baits, item.value);
					userData.baits -= baitsLost;
					effectMessage = `\n\n${item.emoji} Uma ${item.name} apareceu e comeu ${baitsLost} de suas iscas! (${userData.baits}/${MAX_BAITS} iscas restantes).`;
					break;
				case "bait_on_trash":
				case "longer_cooldown":
					await addBuff(
						userData.userId,
						{
							type: item.effect,
							value: item.value,
							remainingUses: item.duration,
							originalName: item.name
						},
						true
					);
					const msg =
						item.effect === "longer_cooldown"
							? "Aumenta o tempo de espera."
							: "Proteção contra lixo (estranhamente).";
					effectMessage = `\n\n${item.emoji} Você pescou um ${item.name}! ${msg}`;
					break;
				case "lose_smallest_fish":
					if (userData.fishes.length > 0) {
						const candidates = userData.fishes.map((f, i) => ({ index: i, fish: f }));
						candidates.sort((a, b) => a.fish.weight - b.fish.weight);

						const poolSize = Math.min(3, candidates.length);
						const randomIndex = Math.floor(Math.random() * poolSize);
						const chosenCandidate = candidates[randomIndex];

						const removedFish = chosenCandidate.fish;
						await removeFishFromInventory(userData.userId, removedFish.dbId);
						userData.fishes.splice(chosenCandidate.index, 1);
						if (removedFish.weight <= 35000) userData.inventoryWeight -= removedFish.weight;
						effectMessage = `\n\n${item.emoji} Uma ${item.name} levou seu ${removedFish.name} embora!`;
					} else {
						effectMessage = `\n\n${item.emoji} Uma ${item.name} revirou suas coisas, mas não havia peixes para levar.`;
					}
					break;
				case "lose_recent_fish":
					// Handled in main loop
					effectMessage = `\n\n${item.emoji} Maldito ${item.name}! Ele roubou o peixe que você acabou de pegar!`;
					break;
			}
			break;
	}

	return { userData, effectMessage };
}

function toDemonic(text) {
	return text
		.split("")
		.map((c) => c)
		.join("");
}

async function applyBuffs(userData, fish) {
	if (
		(!userData.buffs || userData.buffs.length === 0) &&
		(!userData.debuffs || userData.debuffs.length === 0)
	) {
		return { fish, buffs: [], debuffs: [] };
	}

	const modifiedFish = { ...fish };
	const buffMessages = [];

	// Apply and decrement buffs
	if (userData.buffs) {
		for (const buff of userData.buffs) {
			if (buff.remainingUses <= 0) continue;
			switch (buff.type) {
				case "weight_boost":
					const originalWeight = modifiedFish.weight;
					modifiedFish.weight *= 1 + buff.value;
					modifiedFish.weight = parseFloat(modifiedFish.weight.toFixed(2));
					buffMessages.push(
						`🎯 Buff do ${buff.originalName || "item"}: +${buff.value * 100}% de peso (${originalWeight}kg → ${modifiedFish.weight}kg)`
					);
					break;
				case "next_fish_bonus":
					const beforeBonus = modifiedFish.weight;
					modifiedFish.weight += buff.value;
					modifiedFish.weight = parseFloat(modifiedFish.weight.toFixed(2));
					buffMessages.push(
						`🎯 Buff do ${buff.originalName || "Minhocão"}: +${buff.value}kg (${beforeBonus}kg → ${modifiedFish.weight}kg)`
					);
					break;
			}
		}
	}

	// Apply and decrement debuffs
	if (userData.debuffs) {
		for (const debuff of userData.debuffs) {
			if (debuff.remainingUses <= 0) continue;
			switch (debuff.type) {
				case "weight_loss":
					const originalWeightDebuff = modifiedFish.weight;
					modifiedFish.weight *= 1 + debuff.value;
					modifiedFish.weight = parseFloat(modifiedFish.weight.toFixed(2));
					modifiedFish.name = toDemonic(modifiedFish.name);
					buffMessages.push(
						`⬇️ Peixe magro... (${originalWeightDebuff}kg → ${modifiedFish.weight}kg)`
					);
					break;
			}
		}
	}

	return { fish: modifiedFish, buffMessages };
}

function getCurrentDateTime() {
	const now = new Date();

	// options define the format requirements
	const options = {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false // Ensures 24-hour format
	};

	return new Intl.DateTimeFormat("en-GB", options).format(now).replace(",", "");
}

async function generateRareFishImage(
	bot,
	userName,
	fishName,
	fishWeight = 10000,
	fishDescription = ""
) {
	try {
		const dateString = getCurrentDateTime();

		const prompt = `Amateur photo with cybershot style framing, a bit blurry, dirty lens:
Person named '${userName}' fishing an epically rare monstrous creature (fantasy) fish known as "${fishName}", ${fishDescription}

Sweat and tears, joy
Epic scenario, huge boats, creature captured mythical, fantastic, water splashing
Dynamic, action-ready close-up composition, medium depth-of-field, hyper-detailed photorealistic-anime hybrid style, epic survival and exploration atmosphere.

((Write text in bottom of image centered, bold font, fantasy: ${fishName}, ${fishWeight.toFixed(2)}kg @ ${dateString}))`;

		const mockMessage = {
			author: "SYSTEM",
			authorName: "Sistema",
			content: prompt,
			origin: {
				getQuotedMessage: () => Promise.resolve(null),
				react: async () => {}
			}
		};

		if (!sdModule || !sdModule.generateImage) return null;

		const result = await sdModule.generateImage(
			bot,
			mockMessage,
			prompt,
			{ filters: { nsfw: false } },
			true,
			{ skipNSFW: true, isProgrammatic: true }
		);
		return result && result.content && result.content.mimetype ? result.content : null;
	} catch (error) {
		logger.error("Erro ao gerar imagem para peixe raro:", error);
		return null;
	}
}

function hasDoubleCatchBuff(userData) {
	return (
		userData.buffs &&
		userData.buffs.some((buff) => buff.type === "double_catch" && buff.remainingUses > 0)
	);
}

async function consumeDoubleCatchBuff(userData) {
	if (userData.buffs) {
		const buff = userData.buffs.find((b) => b.type === "double_catch" && b.remainingUses > 0);
		if (buff) {
			buff.remainingUses--;
			await updateBuffUses(buff.dbId, buff.remainingUses);
		}
	}
	return userData;
}

function getMaxInventory(userData) {
	let limit = MAX_FISH_PER_USER;
	if (userData.buffs) {
		userData.buffs.forEach((b) => {
			if (b.type === "inventory_slot" && b.remainingUses > 0) {
				limit += b.value;
			}
		});
	}
	return limit;
}

function getMaxBaits(userData) {
	let limit = MAX_BAITS;
	if (userData.buffs) {
		userData.buffs.forEach((b) => {
			if (b.type === "max_baits" && b.remainingUses > 0) {
				limit += b.value;
			}
		});
	}
	return limit;
}

async function handleBuffDecrement(userData, context) {
	const { caughtFish, caughtTrash, isRare, isFirstCatchOfCommand } = context;
	const buffsToUpdate = [];

	const processList = (list) => {
		if (!list) return;
		for (const buff of list) {
			if (buff.remainingUses <= 0) continue;
			let shouldDecrement = false;

			switch (buff.type) {
				// Per Attempt (applies whether fish, trash, or nothing)
				case "rare_chance_boost":
					shouldDecrement = true;
					break;
				case "cooldown_reduction":
				case "longer_cooldown":
					if (isFirstCatchOfCommand) shouldDecrement = true;
					break;

				// Per Fish Caught
				case "weight_boost":
				case "weight_loss":
				case "next_fish_bonus":
					if (caughtFish) shouldDecrement = true;
					break;

				// Per Normal Fish
				case "guaranteed_weight":
					if (caughtFish && !isRare) shouldDecrement = true;
					break;

				// On Trash
				case "bait_on_trash":
					if (caughtTrash) shouldDecrement = true;
					break;
			}

			if (shouldDecrement) {
				buff.remainingUses--;
				buffsToUpdate.push(buff);
			}
		}
	};

	processList(userData.buffs);
	processList(userData.debuffs);

	for (const buff of buffsToUpdate) {
		if (buff.dbId) await updateBuffUses(buff.dbId, buff.remainingUses);
	}
}

/**
 * Pescar um peixe
 */
async function fishCommand(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		const userId = message.author;
		const userName =
			message.name ?? message.pushName ?? message.pushname ?? message.authorName ?? "Pescador";
		const groupId = message.group;
		const mentionPessoa = message.mentions ?? message.origin?.mentionedIds ?? [];

		let userData = await getUserData(userId);

		if (!userData) {
			userData = {
				userId,
				name: userName,
				fishes: [],
				totalWeight: 0,
				inventoryWeight: 0,
				biggestFish: null,
				totalCatches: 0,
				totalBaitsUsed: 0,
				totalTrashCaught: 0,
				baits: MAX_BAITS,
				lastBaitRegen: Date.now(),
				buffs: [],
				debuffs: []
			};
			await saveUserData(userData);
		} else {
			userData.name = userName;
		}

		userData = regenerateBaits(userData);

		// Cooldown logic
		const now = Math.floor(Date.now() / 1000);
		let currentCooldown = FISHING_COOLDOWN;

		if (userData.buffs) {
			const cooldownBuff = userData.buffs.find(
				(b) => b.type === "cooldown_reduction" && b.remainingUses > 0
			);
			if (cooldownBuff) {
				currentCooldown *= 1 - cooldownBuff.value;
			}
		}
		if (userData.debuffs) {
			const cooldownDebuff = userData.debuffs.find(
				(d) => d.type === "longer_cooldown" && d.remainingUses > 0
			);
			if (cooldownDebuff) {
				currentCooldown *= cooldownDebuff.value;
			}
		}

		if (fishingCooldowns[userId] && now < fishingCooldowns[userId]) {
			try {
				setTimeout(
					(mo) => {
						mo.react("😴");
					},
					2000,
					message.origin
				);
			} catch (e) {}
			return null;
		}

		if (userData.baits <= 0) {
			try {
				setTimeout(
					(mo) => {
						mo.react("🍥");
					},
					3000,
					message.origin
				);
			} catch (e) {}
			return null;
		}

		// Obter peixes
		let fishArray = ["Lambari", "Tilápia"];
		try {
			const customVariables = await database.getCustomVariables();
			fishArray = customVariables.peixes;
		} catch (error) {}

		const catchCount = hasDoubleCatchBuff(userData) ? 2 : 1;
		if (catchCount === 2) await consumeDoubleCatchBuff(userData);

		const caughtFishes = [];
		let effectMessage = "";
		let randomItem = null;
		let trashProtected = false;

		for (let i = 0; i < catchCount; i++) {
			// Step 1: Check for Rare Fish immediately (rare fish overrides items)
			// We peek at the potential fish type first.
			const rareCheckFish = await getRandomFish(fishArray, false, userData);

			let modifiedFish = null;
			let isTrash = false;

			if (rareCheckFish.isRare) {
				// It's a rare fish! No items, just catch it.
				modifiedFish = rareCheckFish;
			} else {
				// Not rare. Check for random items first.
				// Only check for items on the first catch of a multi-catch (or always? Original logic was i===0)
				if (i === 0) {
					randomItem = checkRandomItem();

					if (randomItem) {
						const itemResult = await applyItemEffect(userData, randomItem);
						userData = itemResult.userData;
						effectMessage += itemResult.effectMessage;

						if (randomItem.type === "trash") {
							userData.totalTrashCaught = (userData.totalTrashCaught ?? 0) + 1;
							isTrash = true;
							// Don't catch any fish this iteration
						} else if (randomItem.effect === "lose_recent_fish") {
							// This effect steals the "recent" fish.
							// If we haven't caught one yet (i===0), it might steal from inventory or do nothing?
							// Original logic implied it stole the *current* catch.
							// If we are about to catch one, we can just say we caught it and lost it, or catch nothing.
							// Let's simulate: Catch fish -> Lost it.
							// So we proceed to catch, but mark it to be removed?
							// Actually, simpler: Just treat as "No fish caught" but show message.
							// "Maldito Gato! Ele roubou o peixe que você acabou de pegar!"
							// implies we DID catch something.
							// So we should generate the fish, but not add it to inventory (or add and remove).
							// Let's proceed to generate fish, but flag it.
						} else if (randomItem.effect === "inventory_slot") {
							// New upgrade logic handling
							const buff = {
								type: randomItem.effect,
								value: randomItem.value,
								remainingUses: 999999,
								originalName: randomItem.name,
								minValue: 0,
								maxValue: 0
							};
							await addBuff(userData.userId, buff, false);
							effectMessage += `\n\n${randomItem.emoji} Você equipou ${randomItem.name}! Espaço extra: +${randomItem.value}`;
						} else if (randomItem.effect === "max_baits") {
							const buff = {
								type: randomItem.effect,
								value: randomItem.value,
								remainingUses: 999999,
								originalName: randomItem.name,
								minValue: 0,
								maxValue: 0
							};
							await addBuff(userData.userId, buff, false);
							effectMessage += `\n\n${randomItem.emoji} Você equipou ${randomItem.name}! Limite de iscas aumentado: +${randomItem.value}`;
						}
					}
				}

				if (!isTrash) {
					// Generate the normal fish if it wasn't trash
					// (If we already generated a rare fish, we wouldn't be in this else block)
					modifiedFish = rareCheckFish; // It was a normal fish
				}
			}

			// If we have a fish to process (and it wasn't trash)
			if (modifiedFish && !isTrash) {
				const buffResult = await applyBuffs(userData, modifiedFish);
				modifiedFish = buffResult.fish;

				if (buffResult.buffMessages?.length > 0)
					effectMessage += `\n${buffResult.buffMessages.join("\n")}`;

				// Add to inventory
				const fishDbId = await addFishToInventory(userId, modifiedFish);
				modifiedFish.dbId = fishDbId;
				userData.fishes.push(modifiedFish);

				// Only add to stats if NOT a meme fish
				if (modifiedFish.weight <= 35000) {
					userData.totalWeight = (userData.totalWeight || 0) + modifiedFish.weight;
					userData.inventoryWeight = (userData.inventoryWeight || 0) + modifiedFish.weight;
					userData.totalCatches = (userData.totalCatches ?? 0) + 1;
				}

				caughtFishes.push(modifiedFish);

				if (!userData.biggestFish || modifiedFish.weight > userData.biggestFish.weight)
					userData.biggestFish = modifiedFish;

				if (groupId && modifiedFish.weight <= 35000) {
					await updateGroupStats(
						groupId,
						userId,
						userName,
						modifiedFish.weight,
						true,
						modifiedFish
					);
				}

				// Handle "lose_recent_fish" AFTER adding (so we have something to lose)
				if (randomItem?.effect === "lose_recent_fish" && i === 0) {
					if (modifiedFish.dbId) await removeFishFromInventory(userId, modifiedFish.dbId);

					// Remove from local data
					userData.fishes.pop();
					caughtFishes.pop();

					if (modifiedFish.weight <= 35000) {
						userData.totalCatches--;
						userData.totalWeight -= modifiedFish.weight;
						userData.inventoryWeight -= modifiedFish.weight;
						if (groupId) {
							await updateGroupStats(groupId, userId, userName, modifiedFish.weight, false, null);
						}
					}
				}
			}

			if (isTrash) {
				trashProtected =
					userData.debuffs?.some((d) => d.type === "bait_on_trash" && d.remainingUses > 0) ||
					userData.buffs?.some((b) => b.type === "bait_on_trash" && b.remainingUses > 0);
			}

			await handleBuffDecrement(userData, {
				caughtFish: !!(modifiedFish && !isTrash),
				caughtTrash: isTrash,
				isRare: !!(modifiedFish && modifiedFish.isRare),
				isFirstCatchOfCommand: i === 0
			});
		}

		if (randomItem?.type !== "trash" || !trashProtected) {
			userData.baits--;
		}
		userData.totalBaitsUsed = (userData.totalBaitsUsed ?? 0) + 1;

		// Check inventory limit
		const currentMaxInventory = getMaxInventory(userData);

		while (userData.fishes.length > currentMaxInventory) {
			// Find candidates: prioritize old fish
			const candidates = [];
			for (let i = 0; i < userData.fishes.length; i++) {
				if (!caughtFishes.includes(userData.fishes[i])) {
					candidates.push({ index: i, fish: userData.fishes[i] });
				}
			}

			// If no old fish (only new ones), consider all fish
			if (candidates.length === 0) {
				for (let i = 0; i < userData.fishes.length; i++) {
					candidates.push({ index: i, fish: userData.fishes[i] });
				}
			}

			// Sort candidates by weight
			candidates.sort((a, b) => a.fish.weight - b.fish.weight);

			// Pick one of the top 3 lightest candidates
			const poolSize = Math.min(3, candidates.length);
			const randomIndex = Math.floor(Math.random() * poolSize);
			const chosenCandidate = candidates[randomIndex];

			const removed = chosenCandidate.fish;
			const smallestIndex = chosenCandidate.index;

			if (removed.dbId) {
				await removeFishFromInventory(userId, removed.dbId);
				userData.fishes.splice(smallestIndex, 1);
				if (removed.weight <= 35000) userData.inventoryWeight -= removed.weight;
				effectMessage += `\n\n⚠️ Inventário cheio! O peixe *${removed.name}* (${removed.weight.toFixed(2)}kg) foi solto.`;
			} else {
				// Safety fallback if DB sync failed, just remove from memory array to avoid infinite loop
				userData.fishes.splice(smallestIndex, 1);
				if (removed.weight <= 35000) userData.inventoryWeight -= removed.weight;
			}
		}

		await saveUserData(userData);
		fishingCooldowns[userId] = now + currentCooldown;

		// Montar mensagem
		let extraMsg = "";
		if (args[0]?.match(/^@\d\d/g)) {
			mentionPessoa.push(args[0]);
			extraMsg = `, segurando firme na vara de ${args[0]}, `;
		}

		if (caughtFishes.length === 0) {
			return new ReturnMessage({
				chatId,

				content: `🎣 ${userName} jogou a linha ${extraMsg}e... ${effectMessage}\n\n> 🐛 Iscas restantes: ${userData.baits}/${getMaxBaits(userData)}`,

				reaction: "🎣",

				options: {
					quotedMessageId: message.origin.id._serialized,
					mentions: mentionPessoa,
					evoReply: message.origin
				}
			});
		}

		let fishMessage;

		if (caughtFishes.length > 1) {
			const fishDetails = caughtFishes
				.map((fish) => `*${fish.name}* (_${fish.weight.toFixed(2)} kg_)`)
				.join(" e ");

			fishMessage = `🎣 ${userName} pescou ${fishDetails}!`;
		} else {
			const fish = caughtFishes[0];

			if (fish.isRare) {
				const chanceFinal = (fish.chance * 100 * DEFAULT_GLOBAL_FACTORS.rareFishChance).toFixed(5);
				fishMessage = `🏆 INCRÍVEL! _${userName}_ capturou um(a) _raríssimo_ *${fish.name}* de _${fish.weight.toFixed(2)} kg_! (${fish.emoji} ${chanceFinal}% de chance)`;
			} else {
				fishMessage = `🎣 ${userName} ${extraMsg}pescou um *${fish.name}* de _${fish.weight.toFixed(2)} kg_!`;
			}
		}

		if (caughtFishes.length === 1) {
			const weight = caughtFishes[0].weight;

			if (weight > weightScaleMsgs[0]) effectMessage = "\n\n👏 *UM MONSTRO!*" + effectMessage;
			else if (weight > weightScaleMsgs[2]) effectMessage = "\n\n👏 *ENORME!*" + effectMessage;
		}

		fishMessage += `\n\n> 🐳 Seu maior peixe: ${userData.biggestFish.name} (${userData.biggestFish.weight.toFixed(2)} kg)`;

		fishMessage += `\n> 🐛 Iscas restantes: ${userData.baits}/${getMaxBaits(userData)}`;

		fishMessage += effectMessage;
		// Se for peixe raro, tentar gerar imagem e salvar no histórico
		if (caughtFishes.length === 1 && caughtFishes[0].isRare) {
			let rareFishImage = await generateRareFishImage(
				bot,
				userName,
				caughtFishes[0].name,
				caughtFishes[0].weight,
				caughtFishes[0].description
			);

			if (!rareFishImage) {
				// Placeholder
				const pchPescaRara = path.join(database.databasePath, "rare-fish.jpg");
				rareFishImage = await bot.createMedia(pchPescaRara, "image/jpeg");
			}

			const savedImageName = await saveRareFishImage(rareFishImage, userId, caughtFishes[0].name);

			// Save Legendary to DB
			const currentYear = new Date().getFullYear();
			await database.dbRun(
				dbName,
				`INSERT INTO fishing_legendary_history 
        (fish_name, weight, user_id, user_name, group_id, group_name, timestamp, image_name, year)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					caughtFishes[0].name,
					caughtFishes[0].weight,
					userId,
					userName,
					groupId || null,
					group ? group.name : "chat privado",
					Date.now(),
					savedImageName,
					currentYear
				]
			);

			const groupName = group ? group.name : "chat privado";
			const chanceFinal = (
				caughtFishes[0].chance *
				100 *
				DEFAULT_GLOBAL_FACTORS.rareFishChance
			).toFixed(5);
			const notificacaoPeixeRaro = new ReturnMessage({
				content: rareFishImage,
				options: {
					caption: `🏆 *${userName}* capturou um(a) _*${caughtFishes[0].name}* LENDÁRIO(A)_ pesando *${caughtFishes[0].weight.toFixed(2)} kg* no grupo "${groupName}"! (${caughtFishes[0].emoji} ${chanceFinal}% de chance)\n\n> ${bot.id}`
				}
			});

			if (bot.grupoLogs) {
				notificacaoPeixeRaro.chatId = bot.grupoLogs;
				const msgsEnviadas = await bot.sendReturnMessages(notificacaoPeixeRaro);
				if (msgsEnviadas[0] && msgsEnviadas[0].pin) msgsEnviadas[0].pin(260000);
			}

			if (bot.grupoAvisos) {
				notificacaoPeixeRaro.chatId = bot.grupoAvisos;
				const msgsEnviadas = await bot.sendReturnMessages(notificacaoPeixeRaro);
				if (msgsEnviadas[0] && msgsEnviadas[0].pin) msgsEnviadas[0].pin(260000);
			}

			if (bot.grupoAnuncios) {
				notificacaoPeixeRaro.chatId = bot.grupoAnuncios;
				const msgsEnviadas = await bot.sendReturnMessages(notificacaoPeixeRaro);
				if (msgsEnviadas[0] && msgsEnviadas[0].pin) msgsEnviadas[0].pin(260000);
			}

			return new ReturnMessage({
				chatId,
				content: rareFishImage,
				options: {
					caption: fishMessage,
					quotedMessageId: message.origin.id._serialized,
					mentions: mentionPessoa,
					evoReply: message.origin
				},
				reaction: "🎣"
			});
		}

		return new ReturnMessage({
			chatId,
			content: fishMessage,
			reaction: "🎣",
			options: {
				quotedMessageId: message.origin.id._serialized,
				mentions: mentionPessoa,
				evoReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro no comando de pesca:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "❌ Erro ao pescar."
		});
	}
}

async function fishingDataCommand(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		const userId = message.author;
		const userName =
			message.name ?? message.pushName ?? message.pushname ?? message.authorName ?? "Pescador";

		let userData = await getUserData(userId);

		if (!userData) {
			return new ReturnMessage({ chatId, content: `🎣 ${userName}, use !pescar para começar.` });
		}

		userData = regenerateBaits(userData);
		await saveUserData(userData);

		const maxBaits = getMaxBaits(userData);
		const maxInventory = getMaxInventory(userData);
		const fishes = userData.fishes;

		let msg = `🎣 *Ficha do Pescador: ${userName}*\n\n`;

		// Stats
		msg += `🐛 *Iscas:* ${userData.baits}/${maxBaits}\n`;
		if (userData.baits < maxBaits) {
			const nextRegen = getNextBaitRegenTime(userData);
			const nextMin = Math.ceil(nextRegen.secondsUntilNextBait / 60);
			const allMin = Math.ceil(nextRegen.secondsUntilAllBaits / 60);
			msg += `> Próxima em ${nextMin} min, todas em ${allMin} min\n`;
		}
		msg += `🎒 *Inventário:* ${fishes.length}/${maxInventory}\n`;
		msg += `🎣 *Arremessos:* ${userData.totalBaitsUsed ?? 0}\n`;
		msg += `🗑️ *Lixos:* ${userData.totalTrashCaught ?? 0}\n`;
		msg += `🐟 *Capturas:* ${userData.totalCatches ?? 0}\n\n`;

		// Buffs & Debuffs
		const allBuffs = [];
		if (userData.buffs) allBuffs.push(...userData.buffs.map((b) => ({ ...b, isDebuff: false })));
		if (userData.debuffs) allBuffs.push(...userData.debuffs.map((b) => ({ ...b, isDebuff: true })));

		if (allBuffs.length > 0) {
			const combinedItems = [...UPGRADES, ...DOWNGRADES];
			const activeEffects = {};
			const equipmentItems = {};

			for (const buff of allBuffs) {
				const refItem = combinedItems.find((i) => i.name === buff.originalName);
				const icon = refItem ? refItem.emoji : buff.isDebuff ? "🕯️" : "✨";
				const key = buff.originalName;

				if (buff.remainingUses > 100) {
					if (!equipmentItems[key]) {
						equipmentItems[key] = { ...buff, icon, value: 0, count: 0 };
					}
					equipmentItems[key].value += buff.value;
					equipmentItems[key].count += 1;
				} else {
					if (!activeEffects[key]) {
						activeEffects[key] = { ...buff, icon, remainingUses: 0 };
					}
					activeEffects[key].remainingUses += buff.remainingUses;
				}
			}

			const activeList = Object.values(activeEffects).sort(
				(a, b) => a.remainingUses - b.remainingUses
			);
			const equipList = Object.values(equipmentItems).sort((a, b) =>
				a.originalName.localeCompare(b.originalName)
			);

			if (activeList.length > 0) {
				msg += `✨ *Efeitos Ativos:*\n`;
				for (const buff of activeList) {
					msg += `${buff.icon} ${buff.originalName} (${buff.remainingUses}x)\n`;
				}
				msg += `\n`;
			}

			if (equipList.length > 0) {
				msg += `🧳 *Equipamentos:*\n`;
				for (const buff of equipList) {
					let bonusText = "";
					if (buff.type === "inventory_slot") bonusText = `(+${buff.value} inv.)`;
					else if (buff.type === "max_baits") bonusText = `(+${buff.value} iscas)`;
					else bonusText = `(Perm.)`;
					const countPrefix = buff.count > 1 ? `${buff.count}x ` : "";
					msg += `${buff.icon} ${countPrefix}${buff.originalName} ${bonusText}\n`;
				}
				msg += `\n`;
			}
		}

		// Inventory
		msg += `📦 *Meus Pescados:*\n`;
		if (fishes.length === 0) {
			msg += `_Nenhum peixe no momento._\n`;
		} else {
			const sortedFishes = [...fishes].sort((a, b) => b.weight - a.weight);
			let totalWeight = 0;
			sortedFishes.forEach((fish, index) => {
				totalWeight += fish.weight;
				const rareMark = fish.isRare ? ` ${fish.emoji} RARO!` : "";
				msg += `${index + 1}. ${fish.name}: ${fish.weight.toFixed(2)} kg${rareMark}\n`;
			});
			msg += `\n⚖️ *Peso Total:* ${totalWeight.toFixed(2)} kg\n`;
		}

		msg += `\n> Saiba mais sobre o jogo enviando:\n> !pesca-info`;

		return new ReturnMessage({
			chatId,
			content: msg,
			options: { quotedMessageId: message.origin.id._serialized, evoReply: message.origin }
		});
	} catch (error) {
		logger.error("Erro fishingData:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "❌ Erro ao ver ficha."
		});
	}
}

/**
 * Mostra os peixes lendários que foram pescados
 */
async function legendaryFishCommand(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		let yearFilter = 2026;
		if (args && args[0] && args[0].match(/^\d{4}$/)) {
			yearFilter = parseInt(args[0]);
		}

		let query = "SELECT * FROM fishing_legendary_history";
		const params = [];
		if (yearFilter) {
			query += " WHERE year = ?";
			params.push(yearFilter);
		}
		query += " ORDER BY timestamp DESC";

		const legendaryFishes = await database.dbAll(dbName, query, params);

		if (legendaryFishes.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `🐉 Ainda não foram pescados peixes lendários${yearFilter ? ` em ${yearFilter}` : ""}.`
			});
		}

		const rareFishListItems = await Promise.all(
			RARE_FISH.map(async (f) => {
				let countQuery = "SELECT COUNT(*) as c FROM fishing_legendary_history WHERE fish_name = ?";
				const countParams = [f.name];
				if (yearFilter) {
					countQuery += " AND year = ?";
					countParams.push(yearFilter);
				}

				const countRow = await database.dbGet(dbName, countQuery, countParams);

				return `\t${f.emoji} ${f.name} _(~${f.weightBonus}kg, ${(f.chance * 100 * DEFAULT_GLOBAL_FACTORS.rareFishChance).toFixed(5)}%\` de chance, ${countRow?.c || 0} pescados${yearFilter ? ` em ${yearFilter}` : ""})_`;
			})
		);
		const rareFishList = rareFishListItems.join("\n");

		let textMessage = `🌊 *Lista de Peixes Lendários* 🎣\n${rareFishList}\n\n🏆 *REGISTRO DE PEIXES LENDÁRIOS _${yearFilter}_* 🎖️\n\n`;

		for (let i = 0; i < legendaryFishes.length; i++) {
			const legendary = legendaryFishes[i];
			const date = new Date(legendary.timestamp).toLocaleDateString("pt-BR");
			const medal = i === 0 ? "🥇 " : i === 1 ? "🥈 " : i === 2 ? "🥉 " : `${i + 1}. `;

			textMessage += `${medal}*${legendary.fish_name}* (${legendary.weight.toFixed(2)} kg)\n`;
			textMessage += `   Pescador: ${legendary.user_name}\n`;
			textMessage += `   Local: ${legendary.group_name ?? "misterioso"}\n`;
			textMessage += `   Data: ${date}\n\n`;
		}

		const messages = [];
		messages.push(new ReturnMessage({ chatId, content: textMessage }));

		/*
    if (legendaryFishes.length > 0) {
      textMessage += `📷 *Mostrando imagens das ${Math.min(5, legendaryFishes.length)} lendas mais recentes...*`;
    }
    const legendaryToShow = legendaryFishes.slice(0, 5);
    
    for (const legendary of legendaryToShow) {
      try {
        if (legendary.image_name) {
          const imagePath = path.join(database.databasePath, 'media', legendary.image_name);
          try {
            await fs.access(imagePath);
            const media = await bot.createMedia(imagePath);
            const date = new Date(legendary.timestamp).toLocaleDateString('pt-BR');
            messages.push(new ReturnMessage({
              chatId,
              content: media,
              options: { caption: `🏆 *Peixe Lendário${yearFilter ? ` (${yearFilter})` : ''}*\n\n*${legendary.fish_name}* de ${legendary.weight.toFixed(2)} kg\nPescado por: ${legendary.user_name}\nLocal: ${legendary.group_name ?? 'misterioso'}\nData: ${date}` },
              delay: messages.length * 1000 
            }));
          } catch (imageError) { continue; }
        }
      } catch (e) {}
    }
    */

		if (messages.length === 1) return messages[0];
		return messages;
	} catch (error) {
		logger.error("Erro no comando de peixes lendários:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "❌ Erro ao mostrar lendas."
		});
	}
}

/**
 * Mostra o ranking de pescaria do grupo atual
 */
async function fishingRankingCommand(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		const groupId = message.group;

		if (!groupId) {
			return new ReturnMessage({ chatId, content: "🎣 Este comando só funciona em grupos." });
		}

		let yearArg = null;
		let rankingType = "biggest";

		// Parse args
		for (const arg of args) {
			if (arg.match(/^\d{4}$/)) yearArg = parseInt(arg);
			else if (arg.toLowerCase() === "quantidade") rankingType = "count";
			else if (arg.toLowerCase() === "pesado") rankingType = "weight";
		}

		let tableName = "fishing_group_stats";
		const params = [groupId];
		let titleSuffix = "";

		if (yearArg && yearArg < 2026) {
			tableName = "fishing_group_stats_history";
			params.push(yearArg);
			titleSuffix = ` (${yearArg})`;
		}

		let query = `SELECT * FROM ${tableName} WHERE group_id = ?`;
		if (yearArg && yearArg < 2026) query += " AND year = ?";

		const groupStats = await database.dbAll(dbName, query, params);

		if (groupStats.length === 0) {
			return new ReturnMessage({
				chatId,
				content: `🎣 Ainda não há dados de pescaria neste grupo${titleSuffix}.`
			});
		}

		const players = groupStats.map((s) => ({
			id: s.user_id,
			name: s.name,
			totalWeight: s.total_weight,
			totalCatches: s.total_catches,
			biggestFish: JSON.parse(s.biggest_fish_json || "null")
		}));

		if (rankingType === "weight") players.sort((a, b) => b.totalWeight - a.totalWeight);
		else if (rankingType === "count") players.sort((a, b) => b.totalCatches - a.totalCatches);
		else
			players.sort((a, b) => {
				if (!a.biggestFish) return 1;
				if (!b.biggestFish) return -1;
				return b.biggestFish.weight - a.biggestFish.weight;
			});

		const rankingTitle =
			rankingType === "weight"
				? "Peso Total"
				: rankingType === "count"
					? "Quantidade Total"
					: "Maior Peixe";
		let rankingMessage = `🏆 *Ranking de Pescaria deste Grupo${titleSuffix}* (${rankingTitle})\n\n`;

		const topPlayers = players.slice(0, 10);
		topPlayers.forEach((player, index) => {
			const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;

			if (rankingType === "weight") {
				rankingMessage += `${medal} ${player.name}: ${player.totalWeight.toFixed(2)} kg (${player.totalCatches} peixes)\n`;
			} else if (rankingType === "count") {
				rankingMessage += `${medal} ${player.name}: ${player.totalCatches} peixes (${player.totalWeight.toFixed(2)} kg)\n`;
			} else {
				if (!player.biggestFish) {
					rankingMessage += `${medal} ${player.name}: Ainda não pescou nenhum peixe\n`;
				} else {
					const rareMark = player.biggestFish.isRare ? ` ${player.biggestFish.emoji}` : "";
					rankingMessage += `${medal} ${player.name}: ${player.biggestFish.name} de ${player.biggestFish.weight.toFixed(2)} kg${rareMark}\n`;
				}
			}
		});

		rankingMessage += `\nOutros rankings disponíveis:`;
		if (rankingType !== "biggest") rankingMessage += `\n- !pesca-ranking (sem argumentos)`;
		if (rankingType !== "weight") rankingMessage += `\n- !pesca-ranking pesado`;
		if (rankingType !== "count") rankingMessage += `\n- !pesca-ranking quantidade`;
		if (!yearArg) rankingMessage += `\n- !pesca-ranking 2025`;

		return new ReturnMessage({ chatId, content: rankingMessage });
	} catch (error) {
		logger.error("Erro ao mostrar ranking de pescaria:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "❌ Erro ao mostrar ranking."
		});
	}
}

async function saveRareFishImage(mediaContent, userId, fishName) {
	try {
		const mediaDir = path.join(database.databasePath, "media");
		try {
			await fs.access(mediaDir);
		} catch (e) {
			await fs.mkdir(mediaDir, { recursive: true });
		}
		const fileName = `peixe_raro_${fishName.replace(/\s+/g, "_")}_${userId.split("@")[0]}_${Date.now()}.jpg`;
		await fs.writeFile(path.join(mediaDir, fileName), Buffer.from(mediaContent.data, "base64"));
		return fileName;
	} catch (e) {
		return null;
	}
}

/**
 * Mostra todas as informações sobre o jogo de pescaria.
 */
async function fishingInfoCommand(bot, message) {
	const chatId = message.group ?? message.author;
	try {
		const stats = await getFishingStats();
		const customVariables = await database.getCustomVariables();
		const fishVariety = customVariables.peixes?.length || 0;

		let infoMessage = "🎣 *Informações & Estatísticas do Jogo da Pesca* 🎣\n\n";

		infoMessage += "📜 *Regras e Informações Gerais*\n";
		infoMessage += `- *Iscas Máximas:* \`${MAX_BAITS}\` (expansível com itens)\n`;
		infoMessage += `- *Recarga de Isca:* 1 a cada ${BAIT_REGEN_TIME / 60} minutos. _(Não é possível alterar este tempo)_\n`;
		infoMessage += `-  *Peso dos Peixes:* de \`${MIN_FISH_WEIGHT}kg\` a \`${MAX_FISH_WEIGHT}kg\`\n`;
		infoMessage += `- *Peixes:* \`${fishVariety}\` tipos (\`!pesca-peixes\` para ver)\n\n`;

		// Legendary counts
		infoMessage += "🐲 *Peixes Lendários*\n_Chance de encontrar um destes seres místicos:_\n";
		for (const fish of RARE_FISH) {
			// Count from DB
			const countRow = await database.dbGet(
				dbName,
				"SELECT COUNT(*) as c FROM fishing_legendary_history WHERE fish_name = ?",
				[fish.name]
			);
			infoMessage += `  ${fish.emoji} *${fish.name}*: \`${(fish.chance * 100 * DEFAULT_GLOBAL_FACTORS.rareFishChance).toFixed(4)}%\` de chance, ${countRow?.c || 0} pescados até hoje\n`;
		}
		infoMessage += "\n";

		infoMessage += "✨ *Buffs*\n_Itens que te ajudam na pescaria:_\n";
		UPGRADES.forEach((item) => {
			infoMessage += `  ${item.emoji} *${item.name}*: ${item.description}\n`;
		});
		infoMessage += "\n";

		infoMessage += "🔥 *Debuffs*\n_Cuidado com o que você fisga!_\n";
		DOWNGRADES.forEach((item) => {
			infoMessage += `  ${item.emoji} *${item.name}*: ${item.description}\n`;
		});
		infoMessage += "\n";

		infoMessage += "🧹 *Lixos Pescáveis*\n_Nem tudo que reluz é peixe..._\n";
		infoMessage += `\`${TRASH_ITEMS.map((item) => item.emoji + " " + item.name).join(", ")}\`\n\n`;

		infoMessage += "📊 *Estatísticas Globais de Pesca*\n";
		infoMessage += `🐟 *Total de Peixes Pescados:* ${stats.totalFishCaught}\n`;
		infoMessage += `🐛 *Total de Iscas Usadas:* ${stats.totalBaitsUsed}\n`;
		infoMessage += `🧹 *Total de Lixo Coletado:* ${stats.totalTrashCaught}\n`;
		infoMessage += `🐲 *Total de Lendas Encontradas:* ${stats.totalLegendaryCaught}\n`;
		if (stats.heaviestFishEver.weight > 0) {
			infoMessage += `🏆 *Maior Peixe da História:* ${stats.heaviestFishEver.name} com \`${stats.heaviestFishEver.weight.toFixed(2)} kg\`, pescado por _${stats.heaviestFishEver.userName}_\n`;
		}
		if (stats.mostFishCaughtByUser.totalCatches > 0) {
			infoMessage += `🥇 *Pescador Mais Dedicado:* _${stats.mostFishCaughtByUser.userName}_ com \`${stats.mostFishCaughtByUser.totalCatches}\` peixes pescados\n`;
		}

		return new ReturnMessage({ chatId, content: infoMessage });
	} catch (error) {
		logger.error("Erro no comando pesca-info:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Ocorreu um erro ao buscar as informações da pescaria."
		});
	}
}

/**
 * Gera e retorna um objeto com as estatísticas globais de pesca.
 */
async function getFishingStats() {
	const totals = await database.dbGet(
		dbName,
		`SELECT 
            SUM(total_catches) as totalFishCaught,
            SUM(total_baits_used) as totalBaitsUsed,
            SUM(total_trash_caught) as totalTrashCaught
        FROM fishing_users`
	);

	const legendaries = await database.dbGet(
		dbName,
		"SELECT COUNT(*) as c FROM fishing_legendary_history"
	);

	// Heaviest fish logic: Iterate users and check their biggest_fish_json
	// Or just store heaviest globally? No, querying JSON is hard in basic SQLite without extension.
	// We will select all users with non-null biggest_fish_json and parse.
	// Optimization: Store weight in a separate column in users table? No, let's keep it simple for now as per migration.
	// Actually, migration didn't extract weight. We'll have to parse.

	// Alternative: We have fishing_inventory which has ALL fishes. We can just query max weight there.
	// BUT fishing_inventory might be cleared. 'biggest_fish_json' in users table persists even if inventory cleared.

	const allUsers = await database.dbAll(
		dbName,
		"SELECT name, biggest_fish_json, total_catches FROM fishing_users"
	);

	let heaviestFishEver = { weight: 0 };
	let mostFishCaughtByUser = { totalCatches: 0 };

	for (const u of allUsers) {
		if (u.biggest_fish_json) {
			const bf = JSON.parse(u.biggest_fish_json);
			if (bf && bf.weight < 40000 && bf.weight > heaviestFishEver.weight) {
				// <10000 pra remover zueiras
				heaviestFishEver = { ...bf, userName: u.name };
			}
		}
		if (u.total_catches > mostFishCaughtByUser.totalCatches) {
			mostFishCaughtByUser = { totalCatches: u.total_catches, userName: u.name };
		}
	}

	return {
		totalFishCaught: totals?.totalFishCaught || 0,
		totalBaitsUsed: totals?.totalBaitsUsed || 0,
		totalTrashCaught: totals?.totalTrashCaught || 0,
		totalLegendaryCaught: legendaries?.c || 0,
		heaviestFishEver,
		mostFishCaughtByUser
	};
}

/**
 * Lista todos os tipos de peixes disponíveis
 */
async function listFishTypesCommand(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;

		let fishArray = [];
		try {
			const customVariables = await database.getCustomVariables();
			if (
				customVariables?.peixes &&
				Array.isArray(customVariables.peixes) &&
				customVariables.peixes.length > 0
			) {
				fishArray = customVariables.peixes;
			} else {
				return new ReturnMessage({ chatId, content: "🎣 Ainda não há tipos de peixes definidos." });
			}
		} catch (error) {
			return new ReturnMessage({ chatId, content: "❌ Erro ao buscar tipos de peixes." });
		}

		const sortedFishes = [...fishArray].sort();
		let fishMessage =
			"🐟 *Lista de Peixes Disponíveis*\n_(número de pescados entre parêntese)_\n\n";

		const columns = 2;
		const rows = Math.ceil(sortedFishes.length / columns);

		// Count fishes
		// We can query fishing_inventory for counts.
		// Note: Inventory gets cleared. So this is "currently in inventories".
		// Original code did: "getFishingData... user.fishes.filter...". So it was also based on current inventory.
		// To match original behavior, we query fishing_inventory.

		for (let i = 0; i < rows; i++) {
			for (let j = 0; j < columns; j++) {
				const index = i + j * rows;
				if (index < sortedFishes.length) {
					const fishName = sortedFishes[index];
					const countRow = await database.dbGet(
						dbName,
						"SELECT COUNT(*) as c FROM fishing_inventory WHERE name = ?",
						[fishName]
					);

					fishMessage += `${fishName} (${countRow?.c || 0})`;
					if (j < columns - 1 && i + (j + 1) * rows < sortedFishes.length) {
						fishMessage += " | ";
					}
				}
			}
			fishMessage += "\n";
		}

		fishMessage += `\n*Peixes Raríssimos*:\n`;
		for (const fish of RARE_FISH) {
			const chancePercent = fish.chance * 100 * DEFAULT_GLOBAL_FACTORS.rareFishChance;
			const countRow = await database.dbGet(
				dbName,
				"SELECT COUNT(*) as c FROM fishing_legendary_history WHERE fish_name = ?",
				[fish.name]
			);
			fishMessage += `${fish.emoji} ${fish.name}: ~${fish.weightBonus}kg (${chancePercent.toFixed(5)}% de chance, ${countRow?.c || 0} pescados até hoje)\n`;
		}

		fishMessage += `\n🐛 Use \`!pesca-info\` para mais informações`;

		return new ReturnMessage({ chatId, content: fishMessage });
	} catch (error) {
		logger.error("Erro ao listar tipos de peixes:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "❌ Erro ao listar peixes."
		});
	}
}

async function globalFactorsCommand(bot, message, args, group) {
	if (!args || args.length === 0) {
		// List factors
		const factors = DEFAULT_GLOBAL_FACTORS;
		let msg = "🌍 *Fatores Globais de Pesca* 🌍\n\n";
		for (const [key, val] of Object.entries(factors)) {
			msg += `• *${key}*: ${val}x\n`;
		}
		//msg += "\nPara alterar: `!pesca-global <chave> <valor>`";
		return new ReturnMessage({ chatId: message.group ?? message.author, content: msg });
	}

	// Edit factor (Admin only)
	if (!(await adminUtils.isSuperAdmin(message.author))) {
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "❌ Apenas Super Admins podem alterar fatores globais."
		});
	}

	const key = args[0];
	const value = parseFloat(args[1]);

	if (isNaN(value)) {
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "❌ Valor inválido."
		});
	}

	const validKeys = Object.keys(DEFAULT_GLOBAL_FACTORS);
	if (!validKeys.includes(key)) {
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: `❌ Chave inválida. Chaves válidas: ${validKeys.join(", ")}`
		});
	}

	DEFAULT_GLOBAL_FACTORS[key] = value;

	return new ReturnMessage({
		chatId: message.group ?? message.author,
		content: `✅ Fator global *${key}* atualizado para *${value}x*.`
	});
}

async function handleAddEffectCmd(bot, message, args, isDebuff) {
	const chatId = message.group ?? message.author;
	if (!adminUtils.isSuperAdmin(message.author)) return;

	if (args.length < 2)
		return new ReturnMessage({
			chatId,
			content: `❌ Uso: !psc-add${isDebuff ? "Debuff" : "Buff"} <@user|global> <nome>`
		});

	const target = args[0];
	const effectNameInput = args.slice(1).join(" ").toLowerCase();

	const list = isDebuff ? DOWNGRADES : UPGRADES;
	const item = list.find((i) => i.name.toLowerCase() === effectNameInput);

	if (!item) {
		return new ReturnMessage({
			chatId,
			content: `❌ ${isDebuff ? "Debuff" : "Buff"} '${effectNameInput}' não encontrado.`
		});
	}

	let value = item.value;
	if (value === undefined && (item.minValue !== undefined || item.maxValue !== undefined)) {
		value = Math.floor(Math.random() * (item.maxValue - item.minValue + 1)) + item.minValue;
	}

	const buff = {
		type: item.effect,
		value,
		minValue: item.minValue,
		maxValue: item.maxValue,
		remainingUses: item.duration || 1,
		originalName: item.name
	};

	if (item.effect === "inventory_slot") buff.remainingUses = 999999;

	if (target.toLowerCase() === "global") {
		await database.dbRun(
			dbName,
			`INSERT INTO fishing_buffs 
            (user_id, effect_type, is_debuff, value, min_value, max_value, remaining_uses, original_name)
            SELECT user_id, ?, ?, ?, ?, ?, ?, ? FROM fishing_users`,
			[
				buff.type,
				isDebuff ? 1 : 0,
				buff.value,
				buff.minValue,
				buff.maxValue,
				buff.remainingUses,
				buff.originalName
			]
		);

		return new ReturnMessage({
			chatId,
			content: `✅ ${isDebuff ? "Debuff" : "Buff"} '${item.name}' adicionado a todos os usuários.`
		});
	} else {
		const userId = target.replace(/\D/g, "");
		if (!userId) return new ReturnMessage({ chatId, content: "❌ ID de usuário inválido." });

		await addBuff(userId, buff, isDebuff);
		return new ReturnMessage({
			chatId,
			content: `✅ ${isDebuff ? "Debuff" : "Buff"} '${item.name}' adicionado para ${target}.`
		});
	}
}

async function addBuffCmd(bot, message, args, group) {
	return handleAddEffectCmd(bot, message, args, false);
}

async function addDebuffCmd(bot, message, args, group) {
	return handleAddEffectCmd(bot, message, args, true);
}

async function addFishCmd(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	if (!adminUtils.isSuperAdmin(message.author)) return;

	if (args.length < 4)
		return new ReturnMessage({
			chatId,
			content: "❌ Uso: !psc-addFish <@user|global> <group_id> <peso> <nome...>"
		});

	const target = args[0];
	const groupId = args[1];
	const weightStr = args[2];
	const weight = parseFloat(weightStr.replace(",", "."));

	if (isNaN(weight)) return new ReturnMessage({ chatId, content: "❌ Peso inválido." });

	const fishName = args.slice(3).join(" ");

	const fish = {
		name: fishName,
		weight,
		timestamp: Date.now(),
		isRare: false,
		emoji: "🐟",
		data_json: {}
	};

	const rare = RARE_FISH.find((f) => f.name.toLowerCase() === fishName.toLowerCase());
	if (rare) {
		fish.emoji = rare.emoji;
		fish.isRare = true;
	}

	const validGroup = groupId && groupId !== "0" && groupId !== "-" && groupId.includes("@");

	if (target.toLowerCase() === "global") {
		await database.dbRun(
			dbName,
			`INSERT INTO fishing_inventory 
            (user_id, name, weight, is_rare, timestamp, emoji, data_json)
            SELECT user_id, ?, ?, ?, ?, ?, ? FROM fishing_users`,
			[
				fish.name,
				fish.weight,
				fish.isRare ? 1 : 0,
				fish.timestamp,
				fish.emoji,
				JSON.stringify(fish)
			]
		);

		await database.dbRun(
			dbName,
			`UPDATE fishing_users SET 
            total_weight = total_weight + ?,
            inventory_weight = inventory_weight + ?,
            total_catches = total_catches + 1`,
			[fish.weight, fish.weight]
		);

		if (validGroup) {
			// Upsert into fishing_group_stats for all users
			// If entry exists: update weight/catches. If not: insert with this fish as biggest.
			// Note: Does not update biggest_fish for existing entries to avoid complex JSON parsing in SQL.
			await database.dbRun(
				dbName,
				`
                INSERT INTO fishing_group_stats (group_id, user_id, name, total_weight, total_catches, biggest_fish_json)
                SELECT ?, user_id, name, ?, 1, ? FROM fishing_users
                WHERE true
                ON CONFLICT(group_id, user_id) DO UPDATE SET
                total_weight = total_weight + ?,
                total_catches = total_catches + 1`,
				[groupId, fish.weight, JSON.stringify(fish), fish.weight]
			);
		}

		return new ReturnMessage({
			chatId,
			content: `✅ Peixe '${fish.name}' (${fish.weight}kg) adicionado para TODOS os usuários.`
		});
	} else {
		const userId = target.replace(/\D/g, "");
		if (!userId) return new ReturnMessage({ chatId, content: "❌ ID de usuário inválido." });

		let userData = await getUserData(userId);
		if (!userData) {
			userData = {
				userId,
				name: target,
				baits: MAX_BAITS,
				lastBaitRegen: Date.now(),
				totalWeight: 0,
				inventoryWeight: 0,
				totalCatches: 0,
				totalBaitsUsed: 0,
				totalTrashCaught: 0,
				biggestFish: null
			};
		}

		await addFishToInventory(userId, fish);

		userData.fishes = userData.fishes || [];
		userData.fishes.push(fish);
		userData.totalWeight = (userData.totalWeight || 0) + fish.weight;
		userData.inventoryWeight = (userData.inventoryWeight || 0) + fish.weight;
		userData.totalCatches = (userData.totalCatches || 0) + 1;

		if (!userData.biggestFish || fish.weight > userData.biggestFish.weight) {
			userData.biggestFish = fish;
		}

		await saveUserData(userData);

		if (validGroup) {
			await updateGroupStats(groupId, userId, userData.name, fish.weight, true, fish);
		}

		return new ReturnMessage({
			chatId,
			content: `✅ Peixe '${fish.name}' (${fish.weight}kg) adicionado para ${target}.`
		});
	}
}

/**
 * Reseta os dados de pesca para o grupo atual */
async function resetFishingDataCommand(bot, message, args, group) {
	try {
		if (!message.group)
			return new ReturnMessage({
				chatId: message.author,
				content: "❌ Este comando só pode ser usado em grupos."
			});

		const isAdmin = await bot.adminUtils.isAdmin(message.author, group, null, bot.client);
		if (!isAdmin)
			return new ReturnMessage({
				chatId: message.group,
				content: "❌ Apenas admins podem usar isso."
			});

		const groupId = message.group;

		const stats = await database.dbAll(
			dbName,
			"SELECT * FROM fishing_group_stats WHERE group_id = ?",
			[groupId]
		);
		if (stats.length === 0)
			return new ReturnMessage({
				chatId: groupId,
				content: "ℹ️ Não há dados de pesca para este grupo."
			});

		const numPlayers = stats.length;

		await database.dbRun(dbName, "DELETE FROM fishing_group_stats WHERE group_id = ?", [groupId]);

		return new ReturnMessage({
			chatId: message.group,
			content: `✅ Dados de pesca resetados com sucesso!\n\n${numPlayers} jogadores tiveram seus dados de pesca neste grupo apagados.`
		});
	} catch (error) {
		logger.error("Erro ao resetar dados de pesca:", error);
		return new ReturnMessage({ chatId: message.group, content: "❌ Erro ao resetar dados." });
	}
}

const commands = [
	new Command({
		name: "pescar",
		description: "Pesque um peixe",
		category: "jogos",
		cooldown: 0,
		reactions: { before: "🎣", after: "🐟", error: "❌" },
		method: fishCommand
	}),
	new Command({
		name: "pesca",
		hidden: true,
		description: "Pesque um peixe",
		category: "jogos",
		cooldown: 0,
		reactions: { before: "🎣", after: "🐟", error: "❌" },
		method: fishCommand
	}),
	new Command({
		name: "meus-pescados",
		description: "Ficha do Pescador",
		category: "jogos",
		cooldown: 5,
		reactions: { after: "🐠", error: "❌" },
		method: fishingDataCommand
	}),
	new Command({
		name: "pesca-dados",
		hidden: true,
		description: "Ficha do Pescador",
		category: "jogos",
		cooldown: 5,
		reactions: { after: "🐠", error: "❌" },
		method: fishingDataCommand
	}),
	new Command({
		name: "pesca-ficha",
		description: "Ficha do Pescador",
		category: "jogos",
		cooldown: 5,
		reactions: { after: "🐠", error: "❌" },
		method: fishingDataCommand
	}),
	new Command({
		name: "pesca-ranking",
		description: "Mostra o ranking de pescaria do grupo atual",
		category: "jogos",
		group: "pescrank",
		cooldown: 5,
		reactions: { after: "🏆", error: "❌" },
		method: fishingRankingCommand
	}),
	new Command({
		name: "pescados",
		hidden: true,
		description: "Mostra o ranking de pescaria do grupo atual",
		category: "jogos",
		group: "pescrank",
		cooldown: 5,
		reactions: { after: "🐋", error: "❌" },
		method: fishingRankingCommand
	}),
	new Command({
		name: "pesca-info",
		description: "Informações do jogo",
		category: "jogos",
		cooldown: 60,
		reactions: { after: "📕", error: "❌" },
		method: fishingInfoCommand
	}),
	new Command({
		name: "pesca-reset",
		description: "Reseta os dados de pesca para o grupo atual",
		category: "jogos",
		adminOnly: true,
		cooldown: 10,
		reactions: { before: process.env.LOADING_EMOJI ?? "🌀", after: "✅", error: "❌" },
		method: resetFishingDataCommand
	}),
	new Command({
		name: "pesca-lendas",
		description: "Mostra os peixes lendários que foram pescados",
		category: "jogos",
		cooldown: 10,
		reactions: { after: "🐉", error: "❌" },
		method: legendaryFishCommand
	}),
	new Command({
		name: "pesca-peixes",
		description: "Lista todos os tipos de peixes disponíveis",
		category: "jogos",
		cooldown: 5,
		reactions: { after: "📋", error: "❌" },
		method: listFishTypesCommand
	}),
	new Command({
		name: "pesca-iscas",
		description: "Ficha do Pescador",
		category: "jogos",
		cooldown: 5,
		reactions: { after: "🐛", error: "❌" },
		method: fishingDataCommand
	}),
	new Command({
		name: "psc-addBaits",
		description: "Add Iscas",
		category: "jogos",
		adminOnly: true,
		hidden: true,
		cooldown: 0,
		reactions: { after: "➕", error: "❌" },
		method: addBaitsCmd
	}),
	new Command({
		name: "psc-addBuff",
		description: "Add Buff",
		category: "jogos",
		adminOnly: true,
		hidden: true,
		cooldown: 0,
		reactions: { after: "➕", error: "❌" },
		method: addBuffCmd
	}),
	new Command({
		name: "psc-addDebuff",
		description: "Add Debuff",
		category: "jogos",
		adminOnly: true,
		hidden: true,
		cooldown: 0,
		reactions: { after: "➖", error: "❌" },
		method: addDebuffCmd
	}),
	new Command({
		name: "psc-addFish",
		description: "Add Fish",
		category: "jogos",
		adminOnly: true,
		hidden: true,
		cooldown: 0,
		reactions: { after: "🐟", error: "❌" },
		method: addFishCmd
	}),
	new Command({
		name: "pesca-global",
		description: "Fatores globais de pesca",
		category: "jogos",
		hidden: true,
		adminOnly: true,
		cooldown: 5,
		reactions: { after: "🌍", error: "❌" },
		method: globalFactorsCommand
	})
];

// Stub
function saveSync() {}

module.exports = {
	commands,
	forceSaveFishingData: saveSync,
	addBaits,
	addBuff,
	UPGRADES
};
