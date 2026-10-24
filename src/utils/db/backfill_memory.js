/**
 * Script de Bootstrap e Backfill Inteligente para o Ravena Memory Engine (RME)
 * Executado dentro do container Docker ravena-ai
 */
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const Database = require("../Database");
const MemoryService = require("../../services/MemoryService");
const LLMService = require("../../services/LLMService");
const Logger = require("../Logger");

const logger = new Logger("backfill-memory");
const memoryService = MemoryService.getInstance();
const database = Database.getInstance();
const llmService = LLMService.getInstance();

async function runPhase1() {
	logger.info("--- Executando Fase 1: Bootstrap Estruturado Instantâneo ---");
	const res = await memoryService.bootstrapPhase1();
	logger.info("Fase 1 concluída:", res);
	return res;
}

async function runPhase2(maxUsers = 30) {
	logger.info(
		`--- Executando Fase 2: Backfill Semântico Assistido por IA (Top ${maxUsers} membros) ---`
	);

	// Busca os autores com mais mensagens registradas em chat_conversations
	let topAuthors = [];
	try {
		topAuthors = await database.dbAll(
			"summaries",
			`SELECT author, COUNT(*) as msgs_count 
			 FROM chat_conversations 
			 WHERE author IS NOT NULL AND author != 'Você (bot)' AND author != 'Desconhecido'
			 GROUP BY author 
			 ORDER BY msgs_count DESC 
			 LIMIT ?`,
			[maxUsers]
		);
	} catch (err) {
		logger.warn("Erro ao buscar top autores em chat_conversations:", err.message);
	}

	if (!topAuthors || topAuthors.length === 0) {
		logger.info("Nenhum autor histórico encontrado para destilação.");
		return;
	}

	logger.info(`Encontrados ${topAuthors.length} membros prioritários para destilar fatos.`);

	let processed = 0;
	for (const a of topAuthors) {
		try {
			// Busca amostra das mensagens do autor
			const msgs = await database.dbAll(
				"summaries",
				"SELECT text FROM chat_conversations WHERE author = ? ORDER BY timestamp DESC LIMIT 30",
				[a.author]
			);

			if (!msgs || msgs.length < 5) continue;

			const sampleText = msgs
				.map((m) => m.text)
				.filter((t) => t && t.length > 3 && !t.startsWith("!"))
				.slice(0, 20)
				.join("\n");
			if (sampleText.length < 20) continue;

			const canonicalId = `user_${a.author.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
			await memoryService.resolveCanonicalUserId("whatsapp", a.author, "pushname", a.author);

			const prompt = `Analise as mensagens abaixo enviadas por "${a.author}" em grupos de WhatsApp.
Extraia de 2 a 3 fatos objetivos, preferências, profissão, hobbies ou traços de comportamento duráveis sobre essa pessoa.
Responda APENAS com um array JSON de strings em português do Brasil: ["fato 1", "fato 2"]

Mensagens:
${sampleText}`;

			const response = await llmService.getCompletion({
				prompt,
				priority: 0,
				maxTokens: 250,
				debugPrompt: false
			});

			if (response) {
				try {
					const clean = response.replace(/```json|```/g, "").trim();
					const facts = JSON.parse(clean);
					if (Array.isArray(facts)) {
						for (const f of facts) {
							if (typeof f === "string" && f.trim().length > 4) {
								await memoryService.addOrUpdateUserFact(
									canonicalId,
									f.trim(),
									"general",
									"group",
									"bootstrap"
								);
							}
						}
						processed++;
						logger.info(
							`[${processed}/${topAuthors.length}] Memória populada para "${a.author}" (${facts.length} fatos).`
						);
					}
				} catch (jsonErr) {}
			}

			// Pausa curta para controle de carga na GPU
			await new Promise((r) => setTimeout(r, 800));
		} catch (uErr) {
			logger.warn(`Erro ao destilar membro ${a.author}:`, uErr.message);
		}
	}

	logger.info(`Fase 2 concluída com sucesso! Total de membros destilados: ${processed}`);
}

async function main() {
	const args = process.argv.slice(2);
	const doPhase1 = args.includes("--phase1") || args.includes("--all") || args.length === 0;
	const doPhase2 = args.includes("--phase2") || args.includes("--all");

	try {
		if (doPhase1) {
			await runPhase1();
		}
		if (doPhase2) {
			const limitArg = args.find((a) => a.startsWith("--limit="));
			const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 30;
			await runPhase2(limit);
		}
		logger.info("Processo de Backfill finalizado com sucesso!");
		process.exit(0);
	} catch (err) {
		logger.error("Erro fatal no Backfill:", err);
		process.exit(1);
	}
}

main();
