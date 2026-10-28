/**
 * Teste de Validação do Storage S3, Desativação do Cache e Backup no S3
 */
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.BACKUP_TO_FS = "false";
process.env.BACKUP_TO_S3 = "true";
process.env.S3_LOCAL_CACHE = "false";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const storageService = require("../services/StorageService");
const Database = require("../utils/Database");

async function run() {
	console.log("=== 1. Testando StorageService e Configurações S3 ===");
	console.log(`S3 Enabled: ${storageService.enabled}`);
	console.log(`S3 Endpoint: ${storageService.endpoint}`);
	console.log(`Bucket Media: ${storageService.bucketMedia}`);
	console.log(`Bucket Downloads: ${storageService.bucketDownloads}`);
	console.log(`Bucket Backups: ${storageService.bucketBackups}`);
	console.log(`Local Cache Enabled: ${storageService.localCacheEnabled}`);

	assert.strictEqual(storageService.enabled, true, "S3 deve estar habilitado");
	assert.strictEqual(
		storageService.bucketBackups,
		"backups",
		"Bucket de backups deve ser 'backups'"
	);
	assert.strictEqual(
		storageService.localCacheEnabled,
		false,
		"Local cache deve estar desabilitado"
	);

	await storageService.ensureAllBuckets();
	console.log("✓ Buckets verificados/garantidos com sucesso no RustFS.");

	console.log("\n=== 2. Testando Comportamento do Cache Local (S3_LOCAL_CACHE=false) ===");
	const testBuffer = Buffer.from("conteudo de teste de cache e s3");
	const testKey = "test-cache-verification.txt";

	// Limpa cache prévio se houvesse
	const expectedCachePath = path.join(
		storageService.cacheDir,
		storageService._cacheKey(testKey, storageService.bucketMedia)
	);
	if (fs.existsSync(expectedCachePath)) {
		fs.unlinkSync(expectedCachePath);
	}

	await storageService.upload(testBuffer, testKey, { bucket: storageService.bucketMedia });
	assert.strictEqual(
		fs.existsSync(expectedCachePath),
		false,
		"Arquivo NÃO deve ter sido escrito em temp/s3-cache quando localCacheEnabled=false"
	);
	console.log("✓ Upload concluído sem escrita em temp/s3-cache (zero poluição em disco).");

	// Limpa objeto de teste
	await storageService.delete(testKey, { bucket: storageService.bucketMedia });

	console.log("\n=== 3. Testando Backup de Bancos SQLite para o S3 ===");
	const db = Database.getInstance({ testMode: true });
	const backupSystem = db.backupSystem;

	console.log(`Backup to FS: ${backupSystem.backupToFs}`);
	console.log(`Backup to S3: ${backupSystem.backupToS3}`);
	assert.strictEqual(backupSystem.backupToFs, false, "Backup to FS deve ser false");
	assert.strictEqual(backupSystem.backupToS3, true, "Backup to S3 deve ser true");

	console.log("Disparando createScheduledBackup()...");
	const success = await backupSystem.createScheduledBackup();
	assert.strictEqual(success, true, "createScheduledBackup deve retornar true");
	console.log("✓ Scheduled Backup executado com sucesso.");

	// Verifica se os arquivos foram salvos no S3 bucket 'backups' sob prefixo 'sqlite/'
	const s3Backups = await storageService.listObjects("sqlite/", storageService.bucketBackups);
	console.log(
		`Total de objetos encontrados em s3://${storageService.bucketBackups}/sqlite/: ${s3Backups.length}`
	);
	assert.ok(s3Backups.length > 0, "Deveria haver objetos de backup salvos no S3");

	const coreBackup = s3Backups.find(
		(o) => o.key.includes("core.db.gz") || o.key.includes("core.db")
	);
	assert.ok(coreBackup, "Snapshot do core.db deve existir no S3");
	console.log(`✓ Snapshot do core encontrado no S3: ${coreBackup.key} (${coreBackup.size} bytes)`);

	console.log("\n=== 4. Testando Restauração a partir do S3 (restoreFromS3) ===");
	const restoreResult = await backupSystem.restoreFromS3("core");
	assert.strictEqual(
		restoreResult,
		true,
		"restoreFromS3 deve restaurar com sucesso a partir do S3"
	);
	console.log("✓ restoreFromS3('core') validado com sucesso.");

	console.log("\n=== 5. Testando Limpeza de Retenção de Backups no S3 (cleanupOldS3Backups) ===");
	const pruned = await backupSystem.cleanupOldS3Backups(30);
	console.log(`Snapshots expirados removidos na retenção de 30 dias: ${pruned}`);
	console.log("✓ cleanupOldS3Backups executado com sucesso.");

	console.log("\n==========================================");
	console.log("TODOS OS TESTES PASSARAM COM SUCESSO! 🎉");
	console.log("==========================================");
}

run()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
