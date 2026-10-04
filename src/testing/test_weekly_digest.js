const assert = require("assert");
const Database = require("../utils/Database");
const WeeklyGameDigestService = require("../services/WeeklyGameDigestService");

async function runTests() {
	console.log("--- Starting Weekly Game Digest Tests ---");
	const database = Database.getInstance({ testMode: true });

	const now = Date.now();
	const weekAgo = now - 2 * 24 * 3600 * 1000; // 2 dias atrás (dentro da semana)

	// 1. Seed Slots history
	await database.dbRun(
		"slots",
		`INSERT INTO slots_history (group_id, user_id, user_name, is_win, coins_spent, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
		["123@g.us", "user_slots1", "JogadorSlots1", 1, 5, weekAgo]
	);
	await database.dbRun(
		"slots",
		`INSERT INTO slots_history (group_id, user_id, user_name, is_win, coins_spent, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
		["123@g.us", "user_slots1", "JogadorSlots1", 1, 5, weekAgo]
	);

	// 2. Seed Fishing inventory
	await database.dbRun(
		"fishing",
		`INSERT INTO fishing_inventory (user_id, name, weight, is_rare, timestamp, emoji) VALUES (?, ?, ?, 0, ?, '🐟')`,
		["user_fish1", "Robalo", 10.5, weekAgo]
	);
	await database.dbRun(
		"fishing",
		`INSERT INTO fishing_users (user_id, name) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name`,
		["user_fish1", "PescadorSenior"]
	);

	// 3. Seed Roleta history
	await database.dbRun(
		"roleta",
		`INSERT INTO roleta_history (group_id, user_id, user_name, action, tries_at_action, timestamp) VALUES (?, ?, ?, 'safe', 1, ?)`,
		["123@g.us", "user_roleta_alive", "ImortalTest", weekAgo]
	);
	for (let i = 0; i < 200; i++) {
		await database.dbRun(
			"roleta",
			`INSERT INTO roleta_history (group_id, user_id, user_name, action, tries_at_action, timestamp) VALUES (?, ?, ?, 'safe', 2, ?)`,
			["123@g.us", "user_roleta_alive", "ImortalTest", weekAgo]
		);
	}
	await database.dbRun(
		"roleta",
		`INSERT INTO roleta_history (group_id, user_id, user_name, action, tries_at_action, timestamp) VALUES (?, ?, ?, 'safe', 1, ?)`,
		["123@g.us", "user_roleta_dead", "AzaradoTest", weekAgo]
	);
	for (let i = 0; i < 150; i++) {
		await database.dbRun(
			"roleta",
			`INSERT INTO roleta_history (group_id, user_id, user_name, action, tries_at_action, timestamp) VALUES (?, ?, ?, 'safe', 2, ?)`,
			["123@g.us", "user_roleta_dead", "AzaradoTest", weekAgo]
		);
	}
	await database.dbRun(
		"roleta",
		`INSERT INTO roleta_history (group_id, user_id, user_name, action, tries_at_action, timestamp) VALUES (?, ?, ?, 'death', 1, ?)`,
		["123@g.us", "user_roleta_dead", "AzaradoTest", weekAgo]
	);

	// 4. Seed Anagram history
	await database.dbRun(
		"anagrama",
		`INSERT INTO anagram_history (group_id, user_id, user_name, points, timestamp) VALUES (?, ?, ?, 50, ?)`,
		["123@g.us", "user_ana1", "MestrePalavras", weekAgo]
	);

	// 5. Seed Stop history
	await database.dbRun(
		"stop_game",
		`INSERT INTO stop_history (group_id, user_id, user_name, points, is_win, timestamp) VALUES (?, ?, ?, 100, 1, ?)`,
		["123@g.us", "user_stop1", "ReiDoStop", weekAgo]
	);

	// 6. Seed Pinto history
	await database.dbRun(
		"pinto",
		`INSERT INTO pinto_history (group_id, user_id, user_name, flaccid, erect, girth, curvature, score, timestamp) VALUES (?, ?, ?, 10, 25, 14, 0, 250, ?)`,
		["123@g.us", "user_pinto1", "Gigante", weekAgo]
	);

	const digestService = WeeklyGameDigestService.getInstance();
	const sinceMs = now - 7 * 24 * 3600 * 1000;
	const digestText = await digestService.generateWeeklyDigest(sinceMs);

	console.log("--- Digest Gerado ---");
	console.log(digestText);

	assert.ok(digestText, "Digest text must not be null");
	assert.ok(digestText.includes("SLOTS"), "Must include SLOTS section");
	assert.ok(digestText.includes("FISHING GAME"), "Must include FISHING GAME section");
	assert.ok(digestText.includes("ROLETA RUSSA"), "Must include ROLETA RUSSA section");
	assert.ok(digestText.includes("ANAGRAMA"), "Must include ANAGRAMA section");
	assert.ok(digestText.includes("ADEDONHA"), "Must include ADEDONHA section");
	assert.ok(digestText.includes("PINTO GAME"), "Must include PINTO GAME section");

	// Verify Roleta status icons
	assert.ok(digestText.includes("🛡️ *ImortalTest*"), "ImortalTest must have 🛡️ icon");
	assert.ok(digestText.includes("💀 *AzaradoTest*"), "AzaradoTest must have 💀 icon");

	console.log("✓ All 6 games included in weekly digest");

	// Modular test: delete slots and stop history and check omission
	await database.dbRun("slots", "DELETE FROM slots_history");
	await database.dbRun("stop_game", "DELETE FROM stop_history");

	const modularDigest = await digestService.generateWeeklyDigest(sinceMs);
	console.log("--- Modular Digest Gerado (Slots e Adedonha removidos) ---");
	console.log(modularDigest);

	assert.ok(!modularDigest.includes("SLOTS"), "Slots section must be omitted when empty");
	assert.ok(!modularDigest.includes("ADEDONHA"), "Adedonha section must be omitted when empty");
	assert.ok(modularDigest.includes("FISHING GAME"), "Fishing section must remain");

	console.log("✓ Modular omission test passed");
	console.log("--- ALL TESTS PASSED SUCCESSFULLY! ---");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
