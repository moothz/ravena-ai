process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const storageService = require("../services/StorageService");
const assert = require("assert");

async function main() {
	console.log("=== INICIANDO TESTE DO STORAGE SERVICE ===");

	console.log("1. Testando ensureBucket()...");
	await storageService.ensureBucket();
	console.log("✓ Bucket verificado/criado com sucesso.");

	const testGroupId = "120363000000000099@g.us";
	const testFileName = `test_media_${Date.now()}.txt`;
	const testContent = Buffer.from("Conteúdo de teste para o RustFS / S3 Storage!");

	console.log("2. Testando upload com particionamento {groupId}/{category}/{fileName}...");
	const uploadResult = await storageService.upload(testContent, testFileName, {
		groupId: testGroupId,
		category: "custom-commands",
		mimetype: "text/plain"
	});

	console.log("✓ Upload concluído:", uploadResult.key);
	assert.strictEqual(
		uploadResult.key,
		`${testGroupId}/custom-commands/${testFileName}`,
		"A chave S3 deve seguir o padrão {groupId}/custom-commands/{fileName}"
	);

	console.log("3. Testando exists()...");
	const exists = await storageService.exists(testFileName, {
		groupId: testGroupId,
		category: "custom-commands"
	});
	assert.strictEqual(exists, true, "O arquivo deve existir no S3");
	console.log("✓ Objeto existe no S3.");

	console.log("4. Testando get() buscando por fileName simples e groupId...");
	const getResult = await storageService.get(testFileName, {
		groupId: testGroupId,
		category: "custom-commands"
	});
	assert.strictEqual(
		getResult.buffer.toString(),
		testContent.toString(),
		"O conteúdo recuperado deve ser idêntico"
	);
	assert.strictEqual(getResult.mimetype, "text/plain", "O mimetype deve ser text/plain");
	console.log("✓ Objeto recuperado com sucesso via S3:", getResult.key);

	console.log("5. Testando getGroupUsage()...");
	const usage = await storageService.getGroupUsage(testGroupId);
	console.log(`✓ Uso do grupo ${testGroupId}: ${usage.count} arquivo(s), ${usage.bytes} bytes`);
	assert.ok(usage.count >= 1, "Deve contar ao menos 1 arquivo para o grupo");

	console.log("6. Testando delete()...");
	await storageService.delete(testFileName, {
		groupId: testGroupId,
		category: "custom-commands"
	});
	const existsAfterDelete = await storageService.exists(testFileName, {
		groupId: testGroupId,
		category: "custom-commands"
	});
	assert.strictEqual(
		existsAfterDelete,
		false,
		"O arquivo não deve mais existir no S3 após deleção"
	);
	console.log("✓ Objeto deletado com sucesso.");

	console.log("=== TODOS OS TESTES DO STORAGE SERVICE PASSARAM COM SUCESSO! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
