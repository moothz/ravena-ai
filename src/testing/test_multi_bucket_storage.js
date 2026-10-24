const storageService = require("../services/StorageService");
const assert = require("assert");

async function main() {
	console.log("=== INICIANDO TESTES DO STORAGE MULTI-BUCKET E PRESIGNED URLS ===");

	// 1. Inicializar buckets
	console.log("\n1. Testando ensureAllBuckets()...");
	await storageService.ensureAllBuckets();
	console.log("✓ ensureAllBuckets executado com sucesso.");

	// 2. Upload para o bucket downloads (HD secundário)
	console.log("\n2. Testando upload no bucket 'downloads' (categoria yt)...");
	const videoPayload = Buffer.from("conteudo-de-teste-video-youtube-12345");
	const uploadResult = await storageService.upload(videoPayload, "teste_video.mp4", {
		bucket: storageService.bucketDownloads,
		category: "yt",
		mimetype: "video/mp4"
	});

	console.log("Resultado upload downloads:", uploadResult);
	assert.strictEqual(uploadResult.bucket, "downloads", "Deveria ter salvo no bucket downloads");
	assert.strictEqual(
		uploadResult.key,
		"yt/teste_video.mp4",
		"Chave deveria ser yt/teste_video.mp4"
	);
	console.log("✓ Upload no bucket downloads validado com sucesso.");

	// 3. Testando geração de Presigned URL
	console.log("\n3. Testando getPresignedUrl()...");
	const presignedUrl = await storageService.getPresignedUrl("yt/teste_video.mp4", {
		bucket: storageService.bucketDownloads,
		expiresIn: 3600
	});

	console.log("Presigned URL gerada:", presignedUrl);
	assert.ok(
		presignedUrl.includes("s3-ravena.moothz.win"),
		"URL deveria conter s3-ravena.moothz.win"
	);
	assert.ok(
		presignedUrl.includes("downloads/yt/teste_video.mp4"),
		"URL deveria conter downloads/yt/teste_video.mp4"
	);
	assert.ok(
		presignedUrl.includes("X-Amz-Signature") || presignedUrl.includes("X-Amz-Algorithm"),
		"URL deveria conter assinatura S3"
	);
	console.log("✓ Presigned URL validada com sucesso.");

	// 4. Testando upload no bucket zap-media com categoria sem grupo (marriages)
	console.log("\n4. Testando upload no bucket 'zap-media' (categoria marriages)...");
	const waifuPayload = Buffer.from("conteudo-waifu-imagem-fake");
	const waifuUpload = await storageService.upload(waifuPayload, "waifu_999.jpg", {
		bucket: storageService.bucketMedia,
		category: "marriages",
		mimetype: "image/jpeg"
	});

	console.log("Resultado upload marriages:", waifuUpload);
	assert.strictEqual(
		waifuUpload.key,
		"marriages/waifu_999.jpg",
		"Chave deveria ser marriages/waifu_999.jpg"
	);

	const waifuFetch = await storageService.get("waifu_999.jpg", {
		category: "marriages",
		bucket: storageService.bucketMedia
	});
	assert.strictEqual(
		waifuFetch.buffer.toString(),
		"conteudo-waifu-imagem-fake",
		"Buffer recuperado deveria ser idêntico"
	);
	console.log("✓ Upload e recuperação em marriages/ validados.");

	// 5. Testando limpeza de downloads expirados
	console.log("\n5. Testando cleanupExpiredDownloads()...");
	const cleaned = await storageService.cleanupExpiredDownloads(0); // 0 horas para testar limpeza do arquivo de teste
	console.log(`✓ cleanupExpiredDownloads executado. Arquivos removidos: ${cleaned}`);

	// 6. Limpeza do arquivo de waifu
	await storageService.delete("marriages/waifu_999.jpg", { bucket: storageService.bucketMedia });
	console.log("✓ Limpeza de teste finalizada.");

	console.log("\n========================================================");
	console.log("TODOS OS TESTES DE MULTI-BUCKET E PRESIGNED PASSARAM!");
	console.log("========================================================");
	process.exit(0);
}

main().catch((err) => {
	console.error("FALHA NOS TESTES:", err);
	process.exit(1);
});
