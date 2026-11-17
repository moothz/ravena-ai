const assert = require("assert");
const NSFWPredict = require("../utils/NSFWPredict");

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

async function main() {
	console.log("=== Testando classificação de rótulos NudeNet em NSFWPredict ===");
	const nsfwPredict = NSFWPredict.getInstance();

	// 1. Rótulos seguros / cobertos NUNCA devem ser NSFW
	const safeCoveredLabels = [
		"FEMALE_GENITALIA_COVERED",
		"MALE_GENITALIA_COVERED",
		"ANUS_COVERED",
		"BUTTOCKS_COVERED",
		"FEMALE_BREAST_COVERED",
		"MALE_BREAST_COVERED",
		"BELLY_COVERED",
		"FEET_COVERED",
		"ARMPITS_COVERED"
	];

	for (const label of safeCoveredLabels) {
		const isNsfw = nsfwPredict._isNsfwLabel(label);
		assert.strictEqual(
			isNsfw,
			false,
			`Rótulo ${label} deve ser considerado SEGURO (false), mas retornou ${isNsfw}`
		);
	}
	console.log(
		"✓ Todos os rótulos cobertos (COVERED) foram corretamente classificados como seguros."
	);

	// 2. Rótulos seguros expostos (não genitais/sexuais)
	const safeExposedLabels = [
		"FEET_EXPOSED",
		"ARMPITS_EXPOSED",
		"BELLY_EXPOSED",
		"MALE_BREAST_EXPOSED",
		"FACE_FEMALE",
		"FACE_MALE"
	];

	for (const label of safeExposedLabels) {
		const isNsfw = nsfwPredict._isNsfwLabel(label);
		assert.strictEqual(
			isNsfw,
			false,
			`Rótulo ${label} deve ser considerado SEGURO (false), mas retornou ${isNsfw}`
		);
	}
	console.log("✓ Rótulos não genitais expostos foram classificados como seguros.");

	// 3. Rótulos estritamente explícitos / NSFW
	const explicitNsfwLabels = [
		"FEMALE_BREAST_EXPOSED",
		"FEMALE_GENITALIA_EXPOSED",
		"MALE_GENITALIA_EXPOSED",
		"ANUS_EXPOSED",
		"BUTTOCKS_EXPOSED"
	];

	for (const label of explicitNsfwLabels) {
		const isNsfw = nsfwPredict._isNsfwLabel(label);
		assert.strictEqual(
			isNsfw,
			true,
			`Rótulo ${label} deve ser considerado NSFW (true), mas retornou ${isNsfw}`
		);
	}
	console.log("✓ Todos os rótulos explícitos foram corretamente classificados como NSFW.");

	console.log("\nTodos os testes de rótulos NudeNet passaram com sucesso!");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Falha no teste:", err);
		process.exit(1);
	});
