const {
	S3Client,
	ListObjectsV2Command,
	GetObjectCommand,
	HeadObjectCommand
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

// Prevenção de timers mantidos por outros módulos
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const SOURCE_ENDPOINT = process.env.SYNC_SOURCE_ENDPOINT || "http://172.18.0.3:9000";
const DEST_ENDPOINT = process.env.SYNC_DEST_ENDPOINT || "http://172.18.0.8:9000";
const BUCKET = process.env.SYNC_BUCKET || "zap-media";
const CONCURRENCY = parseInt(process.env.SYNC_CONCURRENCY || "20", 10);

const accessKey = process.env.MINIO_ACCESS_KEY || process.env.S3_ACCESS_KEY || "minioadmin";
const secretKey = process.env.MINIO_SECRET_KEY || process.env.S3_SECRET_KEY || "";

const sourceClient = new S3Client({
	endpoint: SOURCE_ENDPOINT,
	region: "us-east-1",
	credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
	forcePathStyle: true
});

const destClient = new S3Client({
	endpoint: DEST_ENDPOINT,
	region: "us-east-1",
	credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
	forcePathStyle: true
});

async function checkDestExists(key, sourceSize) {
	try {
		const head = await destClient.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
		return head.ContentLength === sourceSize;
	} catch {
		return false;
	}
}

async function copyObject(key, size, contentType) {
	const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
	const response = await sourceClient.send(getCmd);

	const upload = new Upload({
		client: destClient,
		params: {
			Bucket: BUCKET,
			Key: key,
			Body: response.Body,
			ContentType: contentType || response.ContentType || "application/octet-stream",
			Metadata: response.Metadata || {}
		}
	});

	await upload.done();
}

async function main() {
	console.log("==========================================================");
	console.log("INICIANDO SINCRONIZAÇÃO S3: MINIO (Origem) -> RUSTFS (Destino)");
	console.log(`Origem:      ${SOURCE_ENDPOINT}`);
	console.log(`Destino:     ${DEST_ENDPOINT}`);
	console.log(`Bucket:      ${BUCKET}`);
	console.log(`Concorrência: ${CONCURRENCY} streams paralelos`);
	console.log("==========================================================\n");

	const startTime = Date.now();
	let continuationToken = null;
	let totalObjects = 0;
	let totalBytes = 0;
	const allItems = [];

	process.stdout.write("Listando objetos na origem (MinIO)... ");
	do {
		const listRes = await sourceClient.send(
			new ListObjectsV2Command({
				Bucket: BUCKET,
				ContinuationToken: continuationToken
			})
		);

		if (listRes.Contents) {
			for (const item of listRes.Contents) {
				if (!item.Key) continue;
				allItems.push(item);
				totalObjects++;
				totalBytes += item.Size || 0;
			}
		}

		continuationToken = listRes.NextContinuationToken;
	} while (continuationToken);

	const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
	console.log(`Concluído!\nTotal encontrado: ${totalObjects} objetos (${totalMB} MB)\n`);

	if (totalObjects === 0) {
		console.log("Nenhum objeto encontrado para transferir.");
		process.exit(0);
	}

	let processedCount = 0;
	let copiedCount = 0;
	let skippedCount = 0;
	let errorCount = 0;
	let bytesTransferred = 0;

	// Fila concorrente com worker pool
	let index = 0;
	async function worker() {
		while (index < allItems.length) {
			const itemIndex = index++;
			const item = allItems[itemIndex];
			const key = item.Key;
			const size = item.Size || 0;

			try {
				const alreadyThere = await checkDestExists(key, size);
				if (alreadyThere) {
					skippedCount++;
				} else {
					await copyObject(key, size);
					copiedCount++;
					bytesTransferred += size;
				}
			} catch (err) {
				errorCount++;
				console.error(`\nErro ao transferir ${key}:`, err.message);
			}

			processedCount++;
			if (processedCount % 50 === 0 || processedCount === totalObjects) {
				const elapsedSec = (Date.now() - startTime) / 1000;
				const speedMB = (bytesTransferred / (1024 * 1024) / (elapsedSec || 1)).toFixed(1);
				const percent = ((processedCount / totalObjects) * 100).toFixed(1);
				process.stdout.write(
					`\rProgresso: [${processedCount}/${totalObjects}] (${percent}%) | Copiados: ${copiedCount} | Pulados: ${skippedCount} | Vel: ${speedMB} MB/s `
				);
			}
		}
	}

	const workers = [];
	for (let i = 0; i < CONCURRENCY; i++) {
		workers.push(worker());
	}

	await Promise.all(workers);

	const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	console.log("\n\n==========================================================");
	console.log("SINCRONIZAÇÃO MINIO -> RUSTFS CONCLUÍDA!");
	console.log(`Tempo total:     ${totalElapsed} segundos`);
	console.log(`Total objetos:   ${totalObjects}`);
	console.log(`Copiados agora:  ${copiedCount}`);
	console.log(`Já existentes:   ${skippedCount}`);
	console.log(`Erros:           ${errorCount}`);
	console.log("==========================================================");

	process.exit(errorCount > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("Falha crítica no script de sincronização:", err);
	process.exit(1);
});
