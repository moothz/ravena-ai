process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const Database = require("../src/utils/Database");
const SlotsGame = require("../src/functions/SlotsGame");

const AFFECTED_USERS = [
	{ userId: "5519989451003", name: "Zed - Vice Líder 憎", coins: 10 },
	{ userId: "5514997025839", name: "Gpg PA do dé", coins: 10 },
	{ userId: "5511957315737", name: "Victor Yuri", coins: 10 },
	{ userId: "5511950712093", name: "vitor", coins: 10 },
	{ userId: "555184944815", name: "victor franceschini", coins: 10 },
	{ userId: "553798230499", name: "Ɨჩαꭚ 𖹭 𝗿̫αƗα", coins: 10 },
	{ userId: "5521967211454", name: "Érick Ávila", coins: 10 },
	{ userId: "556592028605", name: "⋆¡ ¡ J U L Y ¿˚⊹", coins: 10 },
	{ userId: "5511957724436", name: "Kevin Henrique", coins: 10 },
	{ userId: "554197389173", name: "Rhamon Souza", coins: 10 }
];

async function main() {
	console.log("=== Iniciando compensação retroativa de fichas de Slots ===");
	const db = Database.getInstance();

	for (const target of AFFECTED_USERS) {
		const before = await db.dbGet("slots", "SELECT coins FROM slots_users WHERE user_id = ?", [
			target.userId
		]);
		const initialCoins = before ? before.coins : 0;

		const updated = await SlotsGame.addCoins(target.userId, target.coins, true);
		console.log(
			`• [${target.userId}] ${target.name}: ${initialCoins} moedas -> +${target.coins} -> ${updated.coins} moedas`
		);
	}

	// Limpa buffs zumbis de 'slots_coins' no fishing_buffs
	const deletedBuffs = await db.dbRun(
		"fishing",
		"DELETE FROM fishing_buffs WHERE effect_type = 'slots_coins'"
	);
	console.log(`\n• Buffs obsoletos removidos de fishing_buffs: ${deletedBuffs?.changes ?? 0}`);

	console.log("=== Compensação finalizada com sucesso! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro ao aplicar compensação:", err);
		process.exit(1);
	});
