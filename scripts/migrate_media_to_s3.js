#!/usr/bin/env node
/**
 * Script de Migração de Mídias Dinâmicas para o RustFS (S3)
 *
 * Mapeia mídias de comandos personalizados, livestream, boas-vindas, despedidas
 * e lembretes para a estrutura particionada {groupId}/{categoria}/{fileName} no S3.
 * Arquivos não associados a nenhum grupo ativo são direcionados para legacy/{fileName}.
 *
 * Uso:
 *   node scripts/migrate_media_to_s3.js [--concurrency=10] [--dry-run] [--source-dir=/app/data/media]
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const Database = require("better-sqlite3");
const storageService = require("../src/services/StorageService");

// Argumentos CLI
const args = process.argv.slice(2);
function getArg(name, defaultValue) {
	const prefix = `--${name}=`;
	const found = args.find((a) => a.startsWith(prefix));
	if (found) return found.substring(prefix.length);
	return defaultValue;
}

const isDryRun = args.includes("--dry-run");
const concurrencyLimit = Math.max(1, parseInt(getArg("concurrency", "10"), 10));
const defaultSourceDir = fs.existsSync("/app/data/media")
	? "/app/data/media"
	: path.join(__dirname, "../data/media");
const sourceDir = getArg("source-dir", defaultSourceDir);
const sqliteDir = fs.existsSync("/app/data/sqlites")
	? "/app/data/sqlites"
	: path.join(__dirname, "../data/sqlites");

console.log("==========================================================");
console.log("   MIGRAÇÃO DE MÍDIAS DINÂMICAS PARA O RUSTFS (S3)        ");
console.log("==========================================================");
console.log(`• Origem:         ${sourceDir}`);
console.log(`• SQLite Dir:     ${sqliteDir}`);
console.log(`• Concorrência:   ${concurrencyLimit} workers`);
console.log(`• Dry Run:        ${isDryRun ? "SIM (somente simulação)" : "NÃO (upload real)"}`);
console.log(`• Bucket Alvo:    ${storageService.bucket}`);
console.log(`• Endpoint S3:    ${storageService.endpoint}`);
console.log("==========================================================\n");

/**
 * Constrói índice em memória a partir dos bancos SQLite
 */
function buildMetadataIndex() {
	const mediaMap = new Map();

	console.log("Passo 1/4: Indexando metadados dos bancos SQLite...");

	// 1. Custom Commands
	const customCommandsDbPath = path.join(sqliteDir, "custom_commands.db");
	if (fs.existsSync(customCommandsDbPath)) {
		try {
			const db = new Database(customCommandsDbPath, { readonly: true });
			const rows = db
				.prepare("SELECT group_id, responses FROM custom_commands WHERE active = 1")
				.all();
			let mappedCmds = 0;

			for (const row of rows) {
				if (!row.responses) continue;
				// Padrão de mídia nas respostas: {mediaType-fileName}
				const matches = row.responses.matchAll(
					/\{(?:image|video|audio|voice|gif|document|sticker|stickerGif)-([^}]+)\}/g
				);
				for (const match of matches) {
					const fileName = path.basename(match[1]);
					mediaMap.set(fileName, {
						groupId: row.group_id,
						category: "custom-commands"
					});
					mappedCmds++;
				}
			}
			db.close();
			console.log(`✓ custom_commands.db: ${mappedCmds} mídias vinculadas a grupos.`);
		} catch (err) {
			console.warn("⚠️ Aviso ao ler custom_commands.db:", err.message);
		}
	}

	// 2. Core DB (groups: greetings, farewells, livestream, group-photos)
	const coreDbPath = path.join(sqliteDir, "core.db");
	if (fs.existsSync(coreDbPath)) {
		try {
			const db = new Database(coreDbPath, { readonly: true });
			const rows = db.prepare("SELECT id, json_data FROM groups WHERE json_data IS NOT NULL").all();
			let mappedCore = 0;

			for (const row of rows) {
				try {
					const data = JSON.parse(row.json_data);
					const groupId = row.id;

					// Boas-vindas
					if (data.greetings) {
						for (const type of Object.keys(data.greetings)) {
							const g = data.greetings[type];
							if (g && g.file) {
								mediaMap.set(path.basename(g.file), { groupId, category: "greetings" });
								mappedCore++;
							}
						}
					}

					// Despedidas
					if (data.farewells) {
						for (const type of Object.keys(data.farewells)) {
							const f = data.farewells[type];
							if (f && f.file) {
								mediaMap.set(path.basename(f.file), { groupId, category: "farewells" });
								mappedCore++;
							}
						}
					}

					// Canais / Livestream
					for (const platform of ["twitch", "kick", "youtube"]) {
						const channels = data[platform];
						if (Array.isArray(channels)) {
							for (const ch of channels) {
								if (ch.groupPhotoOnline) {
									mediaMap.set(path.basename(ch.groupPhotoOnline), {
										groupId,
										category: "group-photos"
									});
									mappedCore++;
								}
								if (ch.groupPhotoOffline) {
									mediaMap.set(path.basename(ch.groupPhotoOffline), {
										groupId,
										category: "group-photos"
									});
									mappedCore++;
								}
								for (const cfgKey of ["onConfig", "offConfig", "videoConfig"]) {
									if (ch[cfgKey]?.media && Array.isArray(ch[cfgKey].media)) {
										for (const m of ch[cfgKey].media) {
											if (m.content && !m.content.startsWith("http")) {
												mediaMap.set(path.basename(m.content), { groupId, category: "livestream" });
												mappedCore++;
											}
										}
									}
								}
							}
						}
					}
				} catch {}
			}
			db.close();
			console.log(
				`✓ core.db (grupos/streams/boas-vindas): ${mappedCore} mídias vinculadas a grupos.`
			);
		} catch (err) {
			console.warn("⚠️ Aviso ao ler core.db:", err.message);
		}
	}

	// 3. Lembretes DB
	const lembretesDbPath = path.join(sqliteDir, "lembretes.db");
	if (fs.existsSync(lembretesDbPath)) {
		try {
			const db = new Database(lembretesDbPath, { readonly: true });
			const rows = db
				.prepare("SELECT chat_id, mediaPath FROM lembretes WHERE mediaPath IS NOT NULL")
				.all();
			let mappedLembretes = 0;
			for (const row of rows) {
				if (row.mediaPath) {
					mediaMap.set(path.basename(row.mediaPath), {
						groupId: row.chat_id,
						category: "lembretes"
					});
					mappedLembretes++;
				}
			}
			db.close();
			console.log(`✓ lembretes.db: ${mappedLembretes} mídias vinculadas.`);
		} catch (err) {
			// Não é crítico se lembretes não tiver mídias
		}
	}

	console.log(`✓ Total de mapeamentos únicos em memória: ${mediaMap.size}\n`);
	return mediaMap;
}

/**
 * Coleta lista de arquivos físicos na pasta de mídia
 */
async function collectFiles(dir) {
	console.log(`Passo 2/4: Varrendo arquivos em '${dir}'...`);
	const fileList = [];

	async function walk(currentDir, relativePrefix = "") {
		const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

			// Pula subpastas ignoradas (lovecell montada em HD externo secundário)
			if (entry.isDirectory()) {
				if (entry.name === "lovecell") {
					continue;
				}
				await walk(fullPath, relPath);
			} else if (entry.isFile()) {
				const stat = await fsPromises.stat(fullPath);
				fileList.push({
					fullPath,
					fileName: entry.name,
					relPath,
					size: stat.size
				});
			}
		}
	}

	if (!fs.existsSync(dir)) {
		throw new Error(`Diretório de mídia '${dir}' não existe!`);
	}

	await walk(dir);
	const totalBytes = fileList.reduce((acc, f) => acc + f.size, 0);
	const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
	console.log(`✓ Total de arquivos encontrados: ${fileList.length} (${totalGB} GB)\n`);
	return { fileList, totalBytes };
}

/**
 * Determina a chave de destino no S3
 */
function resolveDestinationKey(file, metadataIndex) {
	// Se for newsletter (canais)
	if (file.relPath.startsWith("canais/")) {
		const parts = file.relPath.split("/");
		if (parts.length >= 3) {
			const channelJid = parts[1];
			const fileName = parts.slice(2).join("/");
			return `${channelJid}/canais/${fileName}`;
		}
	}

	// Se for arquivo de usuário (FileManager)
	if (file.relPath.startsWith("user_files/")) {
		const parts = file.relPath.split("/");
		if (parts.length >= 4) {
			const chatId = parts[1];
			const fileName = parts.slice(3).join("/");
			return `${chatId}/user-files/${fileName}`;
		}
	}

	// Consulta o mapa por nome do arquivo
	const match = metadataIndex.get(file.fileName);
	if (match && match.groupId) {
		const category = match.category || "custom-commands";
		return `${match.groupId}/${category}/${file.fileName}`;
	}

	// Se não encontrou associação de grupo, vai para legacy
	return `legacy/${file.fileName}`;
}

/**
 * Executa a migração com pool de concorrência
 */
async function runMigration() {
	const startTime = Date.now();
	const metadataIndex = buildMetadataIndex();
	const { fileList, totalBytes } = await collectFiles(sourceDir);

	if (fileList.length === 0) {
		console.log("Nenhum arquivo para migrar.");
		return;
	}

	console.log("Passo 3/4: Inicializando conexão com o S3 / RustFS...");
	if (!isDryRun) {
		await storageService.ensureBucket();
	}
	console.log("✓ Bucket pronto para receber uploads.\n");

	console.log(`Passo 4/4: Iniciando upload de ${fileList.length} arquivos...`);
	let processedCount = 0;
	let processedBytes = 0;
	let skippedCount = 0;
	let uploadedCount = 0;
	let errorCount = 0;
	const errors = [];

	let lastReportTime = Date.now();
	let lastReportBytes = 0;

	// Fila concorrente
	let currentIndex = 0;

	async function worker(workerId) {
		while (currentIndex < fileList.length) {
			const index = currentIndex++;
			const file = fileList[index];
			const destinationKey = resolveDestinationKey(file, metadataIndex);

			try {
				if (isDryRun) {
					// Simulação
					uploadedCount++;
					processedBytes += file.size;
				} else {
					// Checa se já existe no S3 (Idempotência)
					const alreadyExists = await storageService.exists(destinationKey);
					if (alreadyExists) {
						skippedCount++;
						processedBytes += file.size;
					} else {
						// Lê e faz upload via stream
						const readStream = fs.createReadStream(file.fullPath);
						await storageService.upload(readStream, destinationKey, {
							metadata: {
								originalPath: file.relPath,
								migrationDate: new Date().toISOString()
							}
						});
						uploadedCount++;
						processedBytes += file.size;
					}
				}
			} catch (err) {
				errorCount++;
				errors.push({ file: file.fileName, error: err.message });
			} finally {
				processedCount++;

				// Exibe progresso a cada 2 segundos ou a cada 100 arquivos
				const now = Date.now();
				if (now - lastReportTime >= 2000 || processedCount === fileList.length) {
					const elapsedSec = (now - startTime) / 1000;
					const windowSec = (now - lastReportTime) / 1000;
					const windowBytes = processedBytes - lastReportBytes;
					const speedMBs =
						windowSec > 0 ? (windowBytes / (1024 * 1024) / windowSec).toFixed(1) : "0.0";
					const pct = ((processedCount / fileList.length) * 100).toFixed(1);

					const remainingFiles = fileList.length - processedCount;
					const avgFilesPerSec = elapsedSec > 0 ? processedCount / elapsedSec : 1;
					const etaSeconds = Math.round(remainingFiles / avgFilesPerSec);
					const etaMin = Math.floor(etaSeconds / 60);
					const etaSec = etaSeconds % 60;
					const etaStr = `${etaMin}m ${etaSec}s`;

					const currentGB = (processedBytes / (1024 * 1024 * 1024)).toFixed(2);
					const totalGBStr = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);

					process.stdout.write(
						`\r[${processedCount.toString().padStart(6)}/${fileList.length}] ${pct}% | ${currentGB}/${totalGBStr} GB | ${speedMBs} MB/s | ETA: ${etaStr} (Skip: ${skippedCount}, Erros: ${errorCount})   `
					);

					lastReportTime = now;
					lastReportBytes = processedBytes;
				}
			}
		}
	}

	const workers = [];
	for (let i = 0; i < concurrencyLimit; i++) {
		workers.push(worker(i + 1));
	}

	await Promise.all(workers);
	console.log("\n");

	const totalDurationSec = Math.round((Date.now() - startTime) / 1000);
	const totalDurationMin = (totalDurationSec / 60).toFixed(1);

	console.log("==========================================================");
	console.log("   RELATÓRIO FINAL DA MIGRAÇÃO PARA O S3                  ");
	console.log("==========================================================");
	console.log(`• Arquivos Processados:  ${processedCount} de ${fileList.length}`);
	console.log(`• Novos Uploads:         ${uploadedCount}`);
	console.log(`• Já Existentes (Skip):  ${skippedCount}`);
	console.log(`• Falhas / Erros:        ${errorCount}`);
	console.log(`• Volume Total:          ${(processedBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`);
	console.log(
		`• Tempo Total:           ${totalDurationMin} minutos (${totalDurationSec} segundos)`
	);
	console.log("==========================================================");

	if (errors.length > 0) {
		console.warn(`\n⚠️ Lista das primeiras falhas (${Math.min(errors.length, 10)}):`);
		errors.slice(0, 10).forEach((e) => console.warn(` - ${e.file}: ${e.error}`));
	}

	// Grava log detalhado de auditoria
	const logPath = path.join(__dirname, `../logs/migration_s3_${Date.now()}.json`);
	try {
		await fsPromises.mkdir(path.dirname(logPath), { recursive: true });
		await fsPromises.writeFile(
			logPath,
			JSON.stringify(
				{
					date: new Date().toISOString(),
					isDryRun,
					totalFiles: fileList.length,
					uploadedCount,
					skippedCount,
					errorCount,
					totalBytes: processedBytes,
					durationSeconds: totalDurationSec,
					errors
				},
				null,
				2
			)
		);
		console.log(`✓ Relatório de auditoria salvo em: ${logPath}`);
	} catch (logErr) {
		console.warn("Falha ao salvar log de auditoria:", logErr.message);
	}

	console.log("\n🎉 Migração concluída com sucesso!");
}

runMigration()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("\n❌ ERRO FATAL NA MIGRAÇÃO:", err);
		process.exit(1);
	});
