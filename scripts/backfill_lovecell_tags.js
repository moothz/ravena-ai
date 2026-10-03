/**
 * Script de Backfill de Tags para o Estoque do Lovecell
 * Executa a classificação via API Laya para todas as figurinhas em cache que ainda não possuem tags no SQLite.
 * Se for detectada como NSFW, adiciona à blacklist e move o arquivo para /home/moothz/nsfw/.
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const fs = require("fs");
const path = require("path");
const StickerScraper = require("../src/functions/StickerScraper");
const Database = require("../src/utils/Database");
const Logger = require("../src/utils/Logger");

const logger = new Logger("backfill-tags");
const database = Database.getInstance();

const CONCURRENCY = 48;

async function main() {
	logger.info("Iniciando Backfill de Tags do estoque Lovecell via API Laya...");

	const lovecellDir = StickerScraper.LOVECELL_DIR;
	if (!fs.existsSync(lovecellDir)) {
		logger.error(`Diretório ${lovecellDir} não existe.`);
		process.exit(1);
	}

	const files = fs
		.readdirSync(lovecellDir)
		.filter((f) => f.startsWith("figs_lovecell_") && f.endsWith(".webp"));
	logger.info(`Total de figurinhas encontradas no estoque offline: ${files.length}`);

	// Consulta figurinhas que já têm tags no SQLite
	const existingRows = database.mappers.all(
		"lovecell",
		"SELECT id FROM lovecell_stats WHERE tags IS NOT NULL"
	);
	const processedIds = new Set(Array.isArray(existingRows) ? existingRows.map((r) => r.id) : []);
	logger.info(`Figurinhas já classificadas anteriormente com tags: ${processedIds.size}`);

	const pendingFiles = files.filter((f) => {
		const match = f.match(/^figs_lovecell_(\d+)\.webp$/);
		if (!match) return false;
		const id = parseInt(match[1], 10);
		return !processedIds.has(id) && !StickerScraper.isBlacklisted(id);
	});

	logger.info(`Pendentes para classificação: ${pendingFiles.length}`);

	if (pendingFiles.length === 0) {
		logger.info("Nenhuma figurinha pendente de classificação. Processamento finalizado.");
		process.exit(0);
	}

	let processedCount = 0;
	let nsfwCount = 0;
	let taggedCount = 0;
	const startTime = Date.now();

	for (let i = 0; i < pendingFiles.length; i += CONCURRENCY) {
		const chunk = pendingFiles.slice(i, i + CONCURRENCY);
		const promises = chunk.map(async (filename) => {
			const match = filename.match(/^figs_lovecell_(\d+)\.webp$/);
			if (!match) return;
			const id = parseInt(match[1], 10);

			const filePath = path.join(lovecellDir, filename);
			try {
				if (!fs.existsSync(filePath)) return;
				const buffer = await fs.promises.readFile(filePath);
				if (buffer.length < StickerScraper.MIN_STICKER_BYTES) return;

				// 1. Classifica com a API Laya
				const layaRes = await StickerScraper.classifyWithLaya(buffer);

				if (layaRes.isNsfw) {
					nsfwCount++;
					logger.warn(`Backfill: Figurinha #${id} classificada como NSFW. Moverá para quarentena.`);
					await StickerScraper.addToBlacklist(
						id,
						layaRes.reason || "NSFW detectado no backfill Laya"
					);
					return;
				}

				// 2. Registra no SQLite
				const tags = layaRes.tags || [];
				const tagsJson = JSON.stringify(tags);
				const now = new Date().toISOString();

				database.mappers.run(
					"lovecell",
					`INSERT INTO lovecell_stats (id, sent_count, last_sent_at, created_at, tags)
					 VALUES (?, 0, NULL, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET tags = excluded.tags`,
					[id, now, tagsJson]
				);

				taggedCount++;
			} catch (err) {
				logger.error(`Erro ao processar figurinha #${id} no backfill: ${err.message}`);
			}
		});

		await Promise.all(promises);
		processedCount += chunk.length;

		if (processedCount % 50 === 0 || processedCount === pendingFiles.length) {
			const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
			logger.info(
				`Progresso Backfill: ${processedCount}/${pendingFiles.length} (${((processedCount / pendingFiles.length) * 100).toFixed(1)}%) - NSFWs: ${nsfwCount} - Classificadas: ${taggedCount} - Tempo: ${elapsedSec}s`
			);
		}
	}

	logger.info(
		`Backfill concluído! Total processadas: ${processedCount}, NSFWs movidos: ${nsfwCount}, Tags atualizadas: ${taggedCount}`
	);
	process.exit(0);
}

main().catch((err) => {
	logger.error(`Erro fatal no script de backfill: ${err.message}`);
	process.exit(1);
});
