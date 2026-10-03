const Database = require("../src/utils/Database");

async function main() {
	console.log("=== Corrigindo personalidades com surrogates isolados em core.db ===");
	const db = Database.getInstance();
	const rows = await db.dbAll(
		"core",
		"SELECT id, name, custom_ai_prompt, json_data FROM groups WHERE custom_ai_prompt IS NOT NULL"
	);

	let fixedCount = 0;
	for (const r of rows) {
		try {
			const parsed = JSON.parse(r.custom_ai_prompt);
			if (typeof parsed === "string" && !parsed.isWellFormed()) {
				const cleaned = parsed
					.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "")
					.toWellFormed();

				let newJsonData = r.json_data;
				try {
					const parsedJson = JSON.parse(r.json_data);
					parsedJson.customAIPrompt = cleaned;
					newJsonData = JSON.stringify(parsedJson);
				} catch (err) {
					console.warn(`Aviso ao ajustar json_data do grupo ${r.id}:`, err.message);
				}

				await db.dbRun(
					"core",
					"UPDATE groups SET custom_ai_prompt = ?, json_data = ?, updated_at = ? WHERE id = ?",
					[JSON.stringify(cleaned), newJsonData, Date.now(), r.id]
				);

				console.log(`✓ Grupo corrigido: [${r.name}] (${r.id})`);
				fixedCount++;
			}
		} catch (err) {
			console.error(`Erro ao processar grupo ${r.id}:`, err.message);
		}
	}

	console.log(`\nConcluído! Total de grupos corrigidos: ${fixedCount}`);
	process.exit(0);
}

main().catch((err) => {
	console.error("Erro fatal:", err);
	process.exit(1);
});
