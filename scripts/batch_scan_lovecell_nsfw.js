const fs = require("fs");
const path = require("path");

const Database = require("../src/utils/Database");
const NSFWPredict = require("../src/utils/NSFWPredict");
const StickerScraper = require("../src/functions/StickerScraper");
const Logger = require("../src/utils/Logger");

const logger = new Logger("batch-nsfw-scan");

async function main() {
	console.log("===============================================================");
	console.log("  INICIANDO ANÁLISE SEQUENCIAL EM LOTE DE FIGURINHAS LOVECELL ");
	console.log("===============================================================\n");

	const database = Database.getInstance();
	const nsfwPredict = NSFWPredict.getInstance();

	// Garante que a tabela SQLite lovecell_blacklist exista
	database.getSQLiteDb(
		"lovecell",
		`
		CREATE TABLE IF NOT EXISTS lovecell_blacklist (
			id INTEGER PRIMARY KEY,
			reason TEXT,
			created_at TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_lovecell_blacklist_id ON lovecell_blacklist(id);
	`
	);

	// Determina o diretório de destino para figurinhas NSFW
	// Se /home/moothz/nsfw não for acessível (por estar dentro do container sem esse mount),
	// usa /app/data/nudenet_debug (montado em ./data/nudenet_debug no host)
	let destDir = path.join(__dirname, "../data/nudenet_debug");
	let isCustomDest = false;

	if (fs.existsSync("/home/moothz/nsfw")) {
		destDir = "/home/moothz/nsfw";
		isCustomDest = true;
	}

	if (!fs.existsSync(destDir)) {
		fs.mkdirSync(destDir, { recursive: true });
	}

	console.log(`[Config] Diretório do cache Lovecell: ${StickerScraper.LOVECELL_DIR}`);
	console.log(
		`[Config] Diretório de destino NSFW: ${destDir} (${isCustomDest ? "pasta host /home/moothz/nsfw" : "pasta temp/nudenet_debug"})\n`
	);

	if (!fs.existsSync(StickerScraper.LOVECELL_DIR)) {
		console.error(`Diretório ${StickerScraper.LOVECELL_DIR} não encontrado.`);
		process.exit(1);
	}

	const allEntries = fs.readdirSync(StickerScraper.LOVECELL_DIR);
	const stickerFiles = allEntries.filter(
		(f) => f.startsWith("figs_lovecell_") && f.endsWith(".webp")
	);

	console.log(`Encontradas ${stickerFiles.length} figurinha(s) para análise.\n`);

	let processedCount = 0;
	let nsfwCount = 0;
	let sfwCount = 0;
	let skippedAlreadyBlacklisted = 0;
	let errorCount = 0;

	for (let i = 0; i < stickerFiles.length; i++) {
		const filename = stickerFiles[i];
		const filePath = path.join(StickerScraper.LOVECELL_DIR, filename);
		const match = filename.match(/^figs_lovecell_(\d+)\.webp$/);
		if (!match) continue;

		const stickerId = parseInt(match[1], 10);
		processedCount++;

		// Se já está na blacklist do Lovecell, move diretamente
		if (StickerScraper.isBlacklisted(stickerId)) {
			skippedAlreadyBlacklisted++;
			const targetPath = path.join(destDir, filename);
			try {
				if (fs.existsSync(filePath)) {
					fs.renameSync(filePath, targetPath);
					console.log(
						`[${i + 1}/${stickerFiles.length}] #${stickerId} já constava na blacklist. Movido para ${destDir}.`
					);
				}
				// Garante registro no SQLite
				await database.dbRun(
					"lovecell",
					"INSERT OR REPLACE INTO lovecell_blacklist (id, reason, created_at) VALUES (?, ?, ?)",
					[stickerId, "Blacklist prévia", new Date().toISOString()]
				);
			} catch (mvErr) {
				logger.error(`Erro ao mover #${stickerId}: ${mvErr.message}`);
			}
			continue;
		}

		let buffer = null;
		try {
			if (!fs.existsSync(filePath)) continue;
			buffer = fs.readFileSync(filePath);
		} catch (readErr) {
			logger.error(`Erro ao ler arquivo ${filename}: ${readErr.message}`);
			errorCount++;
			continue;
		}

		if (buffer.length < StickerScraper.MIN_STICKER_BYTES) {
			console.log(
				`[${i + 1}/${stickerFiles.length}] #${stickerId} inválido (< 3KB: ${buffer.length} bytes). Excluindo do cache...`
			);
			try {
				fs.unlinkSync(filePath);
			} catch {}
			continue;
		}

		try {
			// Extrai até 6 frames distribuídos (para WebP estático ou animado)
			const frames = await StickerScraper.extractFramesForAnalysis(buffer, 6);

			// Chama LLM Vision para verificação NSFW
			const result = await nsfwPredict.detectNSFW(frames, {
				isSticker: true,
				type: "sticker",
				stickerId,
				forceLLM: true,
				skipNudeNet: true
			});

			if (result?.isNSFW) {
				nsfwCount++;
				const reason = result.reason || "Conteúdo adulto/NSFW detectado";
				console.log(
					`[${i + 1}/${stickerFiles.length}] 🔴 NSFW DETECTADO em #${stickerId}: ${reason}`
				);

				// 1. Move o arquivo para a pasta de destino
				const targetPath = path.join(destDir, filename);
				try {
					fs.renameSync(filePath, targetPath);
					console.log(`       ↳ Movido para: ${targetPath}`);
				} catch (mvErr) {
					// Se rename cross-device falhar, faz cópia e unlink
					try {
						fs.copyFileSync(filePath, targetPath);
						fs.unlinkSync(filePath);
						console.log(`       ↳ Copiado e removido para: ${targetPath}`);
					} catch (cpErr) {
						logger.error(`Erro ao mover arquivo NSFW #${stickerId}: ${cpErr.message}`);
					}
				}

				// 2. Registra na base de dados SQLite
				try {
					await database.dbRun(
						"lovecell",
						"INSERT OR REPLACE INTO lovecell_blacklist (id, reason, created_at) VALUES (?, ?, ?)",
						[stickerId, reason, new Date().toISOString()]
					);
				} catch (dbErr) {
					logger.error(`Erro ao salvar no SQLite lovecell_blacklist: ${dbErr.message}`);
				}

				// 3. Registra na blacklist persistente (blacklist.json)
				await StickerScraper.addToBlacklist(stickerId);
			} else {
				sfwCount++;
				console.log(
					`[${i + 1}/${stickerFiles.length}] 🟢 SAFE: #${stickerId} seguro (${frames.length} frame(s) analisado(s))`
				);
			}
		} catch (scanErr) {
			errorCount++;
			logger.error(`Erro ao analisar figurinha #${stickerId}: ${scanErr.message}`);
		}
	}

	console.log("\n===============================================================");
	console.log("                RELATÓRIO FINAL DA ANÁLISE");
	console.log("===============================================================");
	console.log(`Total de arquivos encontrados: ${stickerFiles.length}`);
	console.log(`Total analisados nesta execução: ${processedCount}`);
	console.log(`Figurinhas Seguras (SFW mantidas): ${sfwCount}`);
	console.log(`Figurinhas NSFW Detectadas e Movidas: ${nsfwCount}`);
	console.log(`Figurinhas que já estavam na Blacklist: ${skippedAlreadyBlacklisted}`);
	console.log(`Erros durante análise: ${errorCount}`);
	console.log(`Pasta de destino dos arquivos NSFW: ${destDir}`);
	console.log("===============================================================\n");

	process.exit(0);
}

main().catch((err) => {
	console.error("Erro fatal na execução da análise em lote:", err);
	process.exit(1);
});
