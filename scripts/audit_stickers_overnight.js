#!/usr/bin/env node

/**
 * Script de Auditoria e Limpeza em Segundo Plano para Figurinhas do Lovecell
 * Executa a moderação estrita multimodal via LLM durante a noite.
 *
 * Categorias moderadas:
 *  - 1. Nudez & Conteúdo Sexual Explícito
 *  - 2. Apologia Nazista, Fascismo e Símbolos de Ódio
 *  - 3. Fotos de Crianças / Menores Reais (Segurança Infantil)
 *  - 4. Apologia / Piadas / Memes de Estupro e Abuso Sexual (ex: "hora do abuso")
 *  - 5. Gore, Mutilação e Violência Extrema
 *
 * Funcionalidades:
 *  - Suporta execução resiliente com salvamento contínuo de progresso (reinicia de onde parou).
 *  - Move figurinhas reprovadas para quarentena (/app/temp/lovecell_moderation_quarantine).
 *  - Adiciona IDs reprovados à blacklist persistente (JSON e SQLite) e remove do cache.
 *  - Relatórios ao vivo e salvamento de relatório detalhado de infrações em JSON.
 *  - Encerramento limpo via SIGINT/SIGTERM com preservação de estado.
 *
 * Modos de uso:
 *  --mode=audit   (Padrão) Audita todas as figurinhas existentes já baixadas na pasta de cache.
 *  --mode=scrape  Varre a internet baixando novas figurinhas com o filtro estrito ativado.
 *  --mode=all     Audita todo o acervo atual e, em seguida, transiciona para scraping contínuo.
 *  --delay=250    Delay em milissegundos entre chamadas à LLM (padrão: 250ms).
 *  --batch=25     Intervalo de itens para exibir o dashboard resumido (padrão: a cada 25).
 *  --max=1000     Limite opcional de itens a processar antes de parar.
 *  --fresh        Descarta o progresso anterior e audita tudo desde o começo.
 */

// Desativa o timer interno autônomo do StickerScraper para termos controle manual estrito neste script
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";

const fs = require("fs");
const path = require("path");

const Database = require("../src/utils/Database");
const NSFWPredict = require("../src/utils/NSFWPredict");
const StickerScraper = require("../src/functions/StickerScraper");
const Logger = require("../src/utils/Logger");

const logger = new Logger("audit-overnight");

// Argumentos de linha de comando
const args = process.argv.slice(2);
function getArg(prefix, defaultValue) {
	const match = args.find((a) => a.startsWith(`${prefix}=`));
	return match ? match.split("=")[1].trim() : defaultValue;
}
const hasFlag = (flag) => args.includes(flag);

const MODE = getArg("--mode", "audit").toLowerCase(); // 'audit', 'scrape', 'all'
const DELAY_MS = Math.max(50, parseInt(getArg("--delay", "250"), 10) || 250);
const BATCH_LOG = Math.max(5, parseInt(getArg("--batch", "25"), 10) || 25);
const MAX_LIMIT = parseInt(getArg("--max", "0"), 10) || 0;
const IS_FRESH = hasFlag("--fresh");

// Diretórios e arquivos de controle
const MEDIA_DIR = StickerScraper.LOVECELL_DIR;
const TEMP_DIR = path.join(__dirname, "../temp");
if (!fs.existsSync(TEMP_DIR)) {
	fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const PROGRESS_FILE = path.join(TEMP_DIR, "lovecell_audit_progress.json");
const VIOLATIONS_FILE = path.join(TEMP_DIR, "lovecell_audit_violations.json");
const QUARANTINE_DIR = getArg("--dest", path.join(TEMP_DIR, "lovecell_moderation_quarantine"));

if (!fs.existsSync(QUARANTINE_DIR)) {
	fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
}

// Estatísticas da sessão
const stats = {
	startTime: Date.now(),
	totalFound: 0,
	processedThisRun: 0,
	alreadyAudited: 0,
	approvedSafe: 0,
	totalRejected: 0,
	rejectedByCategory: {
		nudity_sexual: 0,
		hate_nazi_extremism: 0,
		child_safety: 0,
		sexual_abuse_rape: 0,
		gore_violence: 0,
		forbidden_title: 0,
		already_blacklisted: 0,
		invalid_size: 0,
		unknown: 0
	},
	errors: 0
};

let auditedIds = new Set();
let violationsList = [];
let isTerminating = false;

// Carrega progresso salvo
function loadProgress() {
	if (!IS_FRESH && fs.existsSync(PROGRESS_FILE)) {
		try {
			const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
			if (Array.isArray(data)) {
				auditedIds = new Set(data.map(Number));
			}
			console.log(`[Progresso] ${auditedIds.size} figurinha(s) já verificadas carregadas.`);
		} catch (err) {
			console.warn("[Progresso] Falha ao carregar progresso anterior; iniciando do zero.");
			auditedIds = new Set();
		}
	}

	if (!IS_FRESH && fs.existsSync(VIOLATIONS_FILE)) {
		try {
			violationsList = JSON.parse(fs.readFileSync(VIOLATIONS_FILE, "utf-8")) || [];
		} catch {
			violationsList = [];
		}
	}
}

// Salva progresso no disco de forma atômica
function saveProgress() {
	try {
		const tmpProgress = `${PROGRESS_FILE}.tmp`;
		fs.writeFileSync(tmpProgress, JSON.stringify(Array.from(auditedIds)), "utf-8");
		fs.renameSync(tmpProgress, PROGRESS_FILE);

		const tmpViolations = `${VIOLATIONS_FILE}.tmp`;
		fs.writeFileSync(tmpViolations, JSON.stringify(violationsList, null, 2), "utf-8");
		fs.renameSync(tmpViolations, VIOLATIONS_FILE);
	} catch (err) {
		logger.error(`Erro ao salvar arquivos de progresso: ${err.message}`);
	}
}

// Formata duração em HH:MM:SS
function formatDuration(ms) {
	const totalSec = Math.floor(ms / 1000);
	const hours = Math.floor(totalSec / 3600);
	const mins = Math.floor((totalSec % 3600) / 60);
	const secs = totalSec % 60;
	return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

// Imprime dashboard de progresso
function printDashboard(currentIndex, totalTotal) {
	const elapsedMs = Date.now() - stats.startTime;
	const ratePerSec = stats.processedThisRun > 0 ? stats.processedThisRun / (elapsedMs / 1000) : 0;
	const remainingItems = totalTotal - currentIndex;
	const etaMs = ratePerSec > 0 ? (remainingItems / ratePerSec) * 1000 : 0;
	const pct = totalTotal > 0 ? ((currentIndex / totalTotal) * 100).toFixed(1) : "0.0";

	console.log("\n---------------------------------------------------------------");
	console.log(
		`📊 [${currentIndex}/${totalTotal}] (${pct}%) | Processados nesta sessão: ${stats.processedThisRun}`
	);
	console.log(
		`⏱️  Tempo decorrido: ${formatDuration(elapsedMs)} | Velocidade: ${ratePerSec.toFixed(2)} item/s | ETA: ${formatDuration(etaMs)}`
	);
	console.log(
		`🟢 Aprovados: ${stats.approvedSafe} | 🔴 Total Rejeitados: ${stats.totalRejected} | ⚠️ Erros: ${stats.errors}`
	);
	console.log(
		`🚫 Reprovações por Categoria:\n` +
			`   • Nudez/Sexual: ${stats.rejectedByCategory.nudity_sexual}\n` +
			`   • Apologia Nazista/Ódio: ${stats.rejectedByCategory.hate_nazi_extremism}\n` +
			`   • Fotos Crianças/Menores: ${stats.rejectedByCategory.child_safety}\n` +
			`   • Estupro/Abuso ("hora do abuso"): ${stats.rejectedByCategory.sexual_abuse_rape}\n` +
			`   • Gore/Violência: ${stats.rejectedByCategory.gore_violence}\n` +
			`   • Título Proibido: ${stats.rejectedByCategory.forbidden_title}\n` +
			`   • Inválidos (<3KB): ${stats.rejectedByCategory.invalid_size}`
	);
	console.log("---------------------------------------------------------------\n");
}

// Trata encerramento gracioso
function setupGracefulShutdown() {
	const onExit = () => {
		if (isTerminating) return;
		isTerminating = true;
		console.log("\n\n⚠️  Interrupção recebida (SIGINT/SIGTERM)! Salvando estado e finalizando...");
		saveProgress();
		printFinalSummary();
		process.exit(0);
	};

	process.on("SIGINT", onExit);
	process.on("SIGTERM", onExit);
}

// Relatório final
function printFinalSummary() {
	const elapsedMs = Date.now() - stats.startTime;
	console.log("\n===============================================================");
	console.log("             RELATÓRIO FINAL DA SESSÃO DE MODERAÇÃO           ");
	console.log("===============================================================");
	console.log(`Duração total: ${formatDuration(elapsedMs)}`);
	console.log(`Itens verificados nesta sessão: ${stats.processedThisRun}`);
	console.log(`Itens já verificados anteriormente (pulados): ${stats.alreadyAudited}`);
	console.log(`Figurinhas Seguras (mantidas no cache): ${stats.approvedSafe}`);
	console.log(`Figurinhas Rejeitadas (movidas para quarentena): ${stats.totalRejected}`);
	console.log("Detalhamento das infrações detectadas:");
	for (const [cat, count] of Object.entries(stats.rejectedByCategory)) {
		if (count > 0) {
			console.log(`   - ${cat}: ${count}`);
		}
	}
	console.log(`Erros durante execução: ${stats.errors}`);
	console.log(`Pasta de Quarentena: ${QUARANTINE_DIR}`);
	console.log(`Arquivo de Progresso: ${PROGRESS_FILE}`);
	console.log(`Relatório de Infrações: ${VIOLATIONS_FILE}`);
	console.log("===============================================================\n");
}

/**
 * Move arquivo para quarentena e garante remoção do cache original
 */
function quarantineSticker(filePath, stickerId, category, reason) {
	const ext = path.extname(filePath) || ".webp";
	const destName = `figs_lovecell_${stickerId}_${category}${ext}`;
	const targetPath = path.join(QUARANTINE_DIR, destName);

	try {
		if (fs.existsSync(filePath)) {
			try {
				fs.renameSync(filePath, targetPath);
			} catch {
				fs.copyFileSync(filePath, targetPath);
				fs.unlinkSync(filePath);
			}
		}
	} catch (e) {
		logger.error(`Erro ao mover figurinha #${stickerId} para quarentena: ${e.message}`);
	}

	violationsList.push({
		id: stickerId,
		category,
		reason,
		quarantinePath: targetPath,
		detectedAt: new Date().toISOString()
	});
}

/**
 * Auditoria do acervo existente em disco
 */
async function auditExistingStickers() {
	console.log("===============================================================");
	console.log(" 🔍 MODO AUDITORIA: Analisando acervo local com Moderação Estrita");
	console.log("===============================================================\n");

	if (!fs.existsSync(MEDIA_DIR)) {
		console.error(`Diretório de figurinhas não encontrado: ${MEDIA_DIR}`);
		return;
	}

	const database = Database.getInstance();
	const nsfwPredict = NSFWPredict.getInstance();

	// Garante que a tabela lovecell_blacklist exista no SQLite
	database.getSQLiteDb(
		"lovecell",
		`CREATE TABLE IF NOT EXISTS lovecell_blacklist (
			id INTEGER PRIMARY KEY,
			reason TEXT,
			created_at TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_lovecell_blacklist_id ON lovecell_blacklist(id);`
	);

	const allFiles = fs
		.readdirSync(MEDIA_DIR)
		.filter((f) => f.startsWith("figs_lovecell_") && f.endsWith(".webp"));

	stats.totalFound = allFiles.length;
	console.log(`Total de arquivos de figurinhas encontrados no cache: ${allFiles.length}`);

	// Ordena por ID decrescente (ou numérico)
	const parsedItems = allFiles
		.map((f) => {
			const m = f.match(/^figs_lovecell_(\d+)\.webp$/);
			return m ? { filename: f, id: parseInt(m[1], 10) } : null;
		})
		.filter(Boolean)
		.sort((a, b) => b.id - a.id);

	for (let i = 0; i < parsedItems.length; i++) {
		if (isTerminating) break;
		if (MAX_LIMIT > 0 && stats.processedThisRun >= MAX_LIMIT) {
			console.log(`\nLimite de --max=${MAX_LIMIT} atingido. Concluindo auditoria.`);
			break;
		}

		const item = parsedItems[i];
		const filePath = path.join(MEDIA_DIR, item.filename);

		// 1. Já auditado em execução anterior?
		if (auditedIds.has(item.id)) {
			stats.alreadyAudited++;
			continue;
		}

		stats.processedThisRun++;

		// 2. Já consta na blacklist do Lovecell?
		if (StickerScraper.isBlacklisted(item.id)) {
			stats.totalRejected++;
			stats.rejectedByCategory.already_blacklisted++;
			console.log(
				`[${i + 1}/${parsedItems.length}] 🚫 #${item.id} já estava na blacklist. Quarentenando...`
			);
			quarantineSticker(filePath, item.id, "already_blacklisted", "Blacklist prévia");
			auditedIds.add(item.id);
			continue;
		}

		// 3. Lê o buffer do arquivo
		let buffer = null;
		try {
			if (!fs.existsSync(filePath)) {
				auditedIds.add(item.id);
				continue;
			}
			buffer = fs.readFileSync(filePath);
		} catch (readErr) {
			logger.error(`Erro ao ler arquivo ${item.filename}: ${readErr.message}`);
			stats.errors++;
			continue;
		}

		// 4. Verificação de tamanho mínimo (< 3KB)
		if (buffer.length < StickerScraper.MIN_STICKER_BYTES) {
			stats.totalRejected++;
			stats.rejectedByCategory.invalid_size++;
			console.log(
				`[${i + 1}/${parsedItems.length}] ⚠️ #${item.id} inválido (< 3KB: ${buffer.length}B). Removendo.`
			);
			try {
				fs.unlinkSync(filePath);
			} catch {}
			auditedIds.add(item.id);
			continue;
		}

		// 5. Análise profunda com IA (LLM Multimodal + Regras Estritas)
		try {
			const frames = await StickerScraper.extractFramesForAnalysis(buffer, 6);
			const t0 = Date.now();

			const result = await nsfwPredict.detectNSFW(frames, {
				isSticker: true,
				type: "sticker",
				stickerId: item.id,
				forceLLM: true,
				skipNudeNet: true,
				strictModeration: true
			});

			const elapsed = Date.now() - t0;

			if (result?.isNSFW) {
				stats.totalRejected++;
				const category = result.category || "unknown";
				const reason = result.reason || "Conteúdo impróprio detectado pelo filtro estrito";

				if (stats.rejectedByCategory[category] !== undefined) {
					stats.rejectedByCategory[category]++;
				} else {
					stats.rejectedByCategory.unknown++;
				}

				console.log(
					`[${i + 1}/${parsedItems.length}] 🔴 REJEITADO #${item.id} (${elapsed}ms) [${category.toUpperCase()}]: ${reason}`
				);

				// 1. Move arquivo para quarentena
				quarantineSticker(filePath, item.id, category, reason);

				// 2. Adiciona à blacklist do StickerScraper (JSON + SQLite + remoção)
				await StickerScraper.addToBlacklist(item.id, reason);

				// 3. Remove de lovecell_stats caso existisse
				try {
					database.mappers.run("lovecell", "DELETE FROM lovecell_stats WHERE id = ?", [item.id]);
				} catch {}
			} else {
				stats.approvedSafe++;
				console.log(
					`[${i + 1}/${parsedItems.length}] 🟢 SAFE #${item.id} (${elapsed}ms) - ${frames.length} frame(s)`
				);
			}

			auditedIds.add(item.id);

			// Salva progresso e exibe dashboard a cada BATCH_LOG itens
			if (stats.processedThisRun % BATCH_LOG === 0) {
				saveProgress();
				printDashboard(i + 1, parsedItems.length);
			}

			// Delay para não sobrecarregar a LLM
			if (DELAY_MS > 0 && i < parsedItems.length - 1) {
				await new Promise((res) => setTimeout(res, DELAY_MS));
			}
		} catch (scanErr) {
			stats.errors++;
			logger.error(`Erro ao analisar figurinha #${item.id}: ${scanErr.message}`);
			// Não adiciona em auditedIds para tentar novamente no futuro
		}
	}

	saveProgress();
}

/**
 * Modo Scraper contínuo durante a noite
 */
async function runScrapeLoop() {
	console.log("\n===============================================================");
	console.log(" 🌐 MODO SCRAPER: Coleta contínua de novas figurinhas com filtro estrito");
	console.log("===============================================================\n");

	let downloadedSession = 0;
	let attempts = 0;

	while (!isTerminating) {
		if (MAX_LIMIT > 0 && downloadedSession >= MAX_LIMIT) {
			console.log(`\nLimite de novas figurinhas (--max=${MAX_LIMIT}) atingido.`);
			break;
		}

		attempts++;
		const candidateId = StickerScraper.getRandomUndownloadedId();
		if (!candidateId) {
			console.log("Nenhum ID elegível no momento. Aguardando 10s...");
			await new Promise((res) => setTimeout(res, 10000));
			continue;
		}

		try {
			const result = await StickerScraper.fetchLovecellSticker(candidateId);
			if (result.rateLimit) {
				console.warn(
					`[Scraper] Rate limit (429) no ID #${candidateId}. Pausando 5 minutos para respeitar a API...`
				);
				await new Promise((res) => setTimeout(res, 300000));
				continue;
			}

			if (
				!result.found ||
				!result.buffer ||
				result.buffer.length < StickerScraper.MIN_STICKER_BYTES
			) {
				console.log(`[Scraper] #${candidateId} indisponível ou inválida.`);
				continue;
			}

			// Filtro de títulos proibidos (0ms)
			if (result.title && StickerScraper.isForbiddenText(result.title)) {
				console.log(
					`[Scraper] 🚫 #${candidateId} título proibido ("${result.title}"). Blacklisting.`
				);
				await StickerScraper.addToBlacklist(candidateId, `Título proibido: "${result.title}"`);
				stats.totalRejected++;
				stats.rejectedByCategory.forbidden_title++;
				continue;
			}

			// Recorte do banner Lovecell
			const croppedBuffer = await StickerScraper.cropLovecellBanner(result.buffer);
			if (croppedBuffer.length < StickerScraper.MIN_STICKER_BYTES) {
				continue;
			}

			// Verificação com IA multimodal
			const isNsfw = await StickerScraper.checkStickerNSFW(croppedBuffer, candidateId, {
				title: result.title
			});

			if (isNsfw) {
				console.log(`[Scraper] 🔴 #${candidateId} reprovado pela moderação estrita. Blacklisting.`);
				await StickerScraper.addToBlacklist(candidateId, "Moderação estrita reprovou conteúdo");
				stats.totalRejected++;
				continue;
			}

			// Salva no cache
			await StickerScraper.saveStickerToCache(candidateId, croppedBuffer);
			downloadedSession++;
			stats.approvedSafe++;
			console.log(
				`[Scraper] ✅ #${candidateId} ("${result.title || "Lovecell"}") salvo no cache com sucesso! (Total novos: ${downloadedSession})`
			);

			// Intervalo entre downloads
			const interval = Math.floor(Math.random() * 2000) + 1000;
			await new Promise((res) => setTimeout(res, interval));
		} catch (err) {
			logger.error(`Erro no loop do scraper para #${candidateId}: ${err.message}`);
			await new Promise((res) => setTimeout(res, 2000));
		}
	}
}

// Fluxo principal
async function main() {
	setupGracefulShutdown();
	loadProgress();

	console.log("===============================================================");
	console.log("   SISTEMA DE MODERAÇÃO E AUDITORIA NOTURNA - STICKERS LOVECELL");
	console.log("===============================================================");
	console.log(`Modo: ${MODE}`);
	console.log(`Delay entre análises: ${DELAY_MS}ms`);
	console.log(`Diretório de figurinhas: ${MEDIA_DIR}`);
	console.log(`Pasta de Quarentena: ${QUARANTINE_DIR}`);
	console.log(`Arquivo de Progresso: ${PROGRESS_FILE}`);
	console.log("===============================================================\n");

	if (MODE === "audit" || MODE === "all") {
		await auditExistingStickers();
	}

	if (MODE === "scrape" || (MODE === "all" && !isTerminating)) {
		await runScrapeLoop();
	}

	saveProgress();
	printFinalSummary();
	process.exit(0);
}

main().catch((err) => {
	console.error("Erro fatal na execução do script noturno:", err);
	saveProgress();
	process.exit(1);
});
