const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const NSFWPredict = require("../src/utils/NSFWPredict").getInstance();
const StickerScraper = require("../src/functions/StickerScraper");

const MEDIA_DIR = "/app/data/media/lovecell";
const DEBUG_DIR = "/app/data/nudenet_debug";
const PROGRESS_FILE = "/app/temp/lovecell_scan_progress.json";
const BLACKLIST_FILE = path.join(MEDIA_DIR, "blacklist.json");
const DB_PATH = "/app/data/sqlites/lovecell.db";
const MIN_STICKER_BYTES = 3072; // 3KB

async function main() {
	console.log("=== Iniciando varredura em batch das figurinhas do Lovecell ===");

	const db = new Database(DB_PATH);
	const insertBlacklistStmt = db.prepare(
		"INSERT OR REPLACE INTO lovecell_blacklist (id, reason, created_at) VALUES (?, ?, ?)"
	);

	// Carrega lista negra atual
	let blacklist = [];
	if (fs.existsSync(BLACKLIST_FILE)) {
		try {
			blacklist = JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf-8"));
		} catch (e) {
			blacklist = [];
		}
	}
	const blacklistSet = new Set(blacklist.map(Number));

	// Carrega progresso anterior (para continuar de onde parou se reiniciado)
	let processedSet = new Set();
	if (fs.existsSync(PROGRESS_FILE)) {
		try {
			const savedProgress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
			processedSet = new Set(savedProgress.map(Number));
			console.log(`Progresso anterior carregado: ${processedSet.size} figurinhas já verificadas.`);
		} catch (e) {
			processedSet = new Set();
		}
	}

	// Lista todos os arquivos no cache
	const allFiles = fs
		.readdirSync(MEDIA_DIR)
		.filter((f) => f.startsWith("figs_lovecell_") && f.endsWith(".webp"))
		.sort();

	console.log(`Total de figurinhas encontradas no disco: ${allFiles.length}`);

	let checkedCount = 0;
	let nsfwCount = 0;
	let invalidCount = 0;
	let alreadyProcessedCount = 0;

	for (let i = 0; i < allFiles.length; i++) {
		const filename = allFiles[i];
		const match = filename.match(/figs_lovecell_(\d+)\.webp/);
		if (!match) continue;

		const id = parseInt(match[1], 10);
		const filePath = path.join(MEDIA_DIR, filename);

		// Se já foi processado nesta sessão ou anterior
		if (processedSet.has(id)) {
			alreadyProcessedCount++;
			continue;
		}

		if (!fs.existsSync(filePath)) {
			continue;
		}

		const buf = fs.readFileSync(filePath);

		// 1. Filtro de tamanho mínimo (< 3KB)
		if (buf.length < MIN_STICKER_BYTES) {
			console.log(`[Inválida] #${id} (${buf.length} bytes < 3KB). Removendo.`);
			try {
				fs.unlinkSync(filePath);
			} catch (e) {}
			invalidCount++;
			processedSet.add(id);
			continue;
		}

		// 2. Análise NSFW via LLM
		try {
			const frames = await StickerScraper.extractFramesForAnalysis(buf, 6);
			const t0 = Date.now();
			const res = await NSFWPredict.detectNSFW(frames, {
				isSticker: true,
				type: "sticker",
				stickerId: id,
				forceLLM: true,
				skipNudeNet: true
			});
			const elapsed = Date.now() - t0;

			if (res?.isNSFW) {
				nsfwCount++;
				console.log(
					`\n🚨 [NSFW DETECTADO] #${id} (${elapsed}ms): ${res.reason || "Conteúdo explícito"}`
				);

				// Copia para debug
				if (!fs.existsSync(DEBUG_DIR)) {
					fs.mkdirSync(DEBUG_DIR, { recursive: true });
				}
				const debugPath = path.join(DEBUG_DIR, filename);
				fs.copyFileSync(filePath, debugPath);

				// Remove do cache de mídia
				fs.unlinkSync(filePath);

				// Registra no banco SQLite
				insertBlacklistStmt.run(
					id,
					res.reason || "NSFW detectado via LLM",
					new Date().toISOString()
				);

				// Adiciona na blacklist permanente
				blacklistSet.add(id);
				fs.writeFileSync(
					BLACKLIST_FILE,
					JSON.stringify(
						Array.from(blacklistSet).sort((a, b) => a - b),
						null,
						2
					),
					"utf-8"
				);
			} else {
				// Segura
				checkedCount++;
				if (checkedCount % 20 === 0 || i === allFiles.length - 1) {
					const totalDone = alreadyProcessedCount + checkedCount + nsfwCount + invalidCount;
					const pct = ((totalDone / allFiles.length) * 100).toFixed(1);
					console.log(
						`[Progresso: ${totalDone}/${allFiles.length} (${pct}%)] - Checadas: ${checkedCount}, NSFW: ${nsfwCount}, Inválidas: ${invalidCount}`
					);
				}
			}

			processedSet.add(id);

			// Salva checkpoint de progresso periodicamente
			if (checkedCount % 10 === 0) {
				fs.writeFileSync(PROGRESS_FILE, JSON.stringify(Array.from(processedSet)), "utf-8");
			}
		} catch (err) {
			console.error(`Erro ao analisar figurinha #${id}: ${err.message}`);
		}
	}

	// Finaliza progresso
	fs.writeFileSync(PROGRESS_FILE, JSON.stringify(Array.from(processedSet)), "utf-8");

	console.log("\n==========================================");
	console.log("=== Varredura em batch finalizada! ===");
	console.log(`Total analisadas agora: ${checkedCount}`);
	console.log(`NSFW detectadas e movidas: ${nsfwCount}`);
	console.log(`Inválidas (<3KB) removidas: ${invalidCount}`);
	console.log(`Total na blacklist: ${blacklistSet.size}`);
	console.log("==========================================");

	process.exit(0);
}

main().catch((err) => {
	console.error("Erro fatal na varredura:", err);
	process.exit(1);
});
