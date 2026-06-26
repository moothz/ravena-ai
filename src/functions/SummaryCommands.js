const path = require("path");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Status = require("../utils/Status");
const LLMService = require("../services/LLMService");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const fs = require("fs").promises;
const { extractFrames } = require("../utils/Conversions");

const logger = new Logger("summary-commands");
const database = Database.getInstance();
const llmService = LLMService.getInstance();
const DB_NAME = "summaries";
const activeAnalyses = new Set();
const otherAI = [];

// Initialize Database
database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS chat_conversations (
    group_id TEXT,
    author TEXT,
    text TEXT,
    timestamp INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_chat_conv_group ON chat_conversations(group_id);

  CREATE TABLE IF NOT EXISTS group_dossier_status (
    group_id TEXT PRIMARY KEY,
    total_length_recorded INTEGER DEFAULT 0,
    pending_text TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS group_dossiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT,
    dossier_json TEXT,
    conversation_history TEXT,
    analyzed_at_length INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_group_dossiers_gid ON group_dossiers(group_id);

  CREATE TABLE IF NOT EXISTS conversations (
    group_id TEXT PRIMARY KEY,
    json_data TEXT
  );
`,
	true
);

const mediaAnalysisSchema = {
	type: "json_schema",
	json_schema: {
		name: "media_analysis",
		schema: {
			type: "object",
			properties: {
				description: {
					type: "string"
				},
				type: {
					type: "string",
					enum: ["vida-real", "anime", "desenho", "jogo", "ia-generated", "documento", "outros"]
				},
				nsfw: {
					type: "boolean"
				}
			},
			required: ["description", "type", "nsfw"]
		}
	}
};

/**
 * Analisa um vídeo e retorna uma descrição
 * @param {Object} message - A mensagem contendo o vídeo
 * @returns {Promise<string|boolean>} - Descrição do vídeo ou false
 */
async function analyzeVideo(message) {
	const tempDirBase = path.join(__dirname, "../../temp");
	const tempDir = path.join(tempDirBase, `video_analysis_${Date.now()}`);
	const videoPath = path.join(tempDirBase, `video_${Date.now()}.mp4`);

	try {
		// Garante diretórios
		await fs.mkdir(tempDirBase, { recursive: true });

		// Baixa a mídia
		if (!message.downloadMedia) {
			return false;
		}

		const media = await message.downloadMedia();
		if (!media || !media.data) {
			return false;
		}

		await fs.writeFile(videoPath, Buffer.from(media.data, "base64"));

		// Extrai frames usando a função utilitária
		const framePaths = await extractFrames(videoPath, tempDir, 30);

		// Lê os frames
		const frames = [];
		for (const filePath of framePaths) {
			const data = await fs.readFile(filePath, "base64");
			frames.push(data);
		}

		if (frames.length === 0) return false;

		// Chama LLM
		const completionOptions = {
			prompt:
				"Analyze the video frames provided and return a brief description ((in pt-BR, portuguese brazil)). Describe the main actions and events in the video. Also classify the type (real life, anime, game, etc) and if it contains NSFW content.",
			systemContext: `You are an expert bot in video processing and analysis`,
			images: frames,
			response_format: mediaAnalysisSchema,
			maxTokens: 150,
			debugPrompt: false,
			timeout: 60000,
			priority: 0
		};

		const response = await llmService.getCompletion(completionOptions);
		try {
			const parsed = JSON.parse(response);
			const nsfwTag = parsed.nsfw ? "nsfw" : "sfw";
			return `Video[${parsed.type}|${nsfwTag}|${parsed.description}]`;
		} catch (e) {
			logger.warn("Falha ao analisar JSON do vídeo, retornando cru:", response);
			return `Video[outros|sfw|${response}]`;
		}
	} catch (error) {
		logger.error("Erro ao analisar vídeo:", error);
		return false;
	} finally {
		// Limpeza
		try {
			await fs.unlink(videoPath).catch(() => {});
			await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
		} catch (e) {
			logger.error("Erro na limpeza de análise de vídeo:", e);
		}
	}
}

/**
 * Resume conversa de grupo
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage com o resumo
 */
async function summarizeConversation(bot, message, args, group) {
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		logger.info(`[${group.id}] Resumindo conversa para o grupo ${message.group}`);

		let recentMessages;
		try {
			// Recorre a mensagens armazenadas
			recentMessages = await getRecentMessages(message.group);
		} catch (fetchError) {
			logger.error("Erro ao buscar mensagens do chat:", fetchError);
			recentMessages = [];
		}

		if (!recentMessages || recentMessages.length === 0) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Nenhuma mensagem recente para resumir."
			});
		}

		// Formata mensagens para prompt
		const formattedMessages = formatMessagesForPrompt(recentMessages);

		const customPersonalidade =
			group.customAIPrompt && group.customAIPrompt.length > 0
				? `\n\n((Sua personalidade: '${group.customAIPrompt}'))\n\n`
				: "";

		// Cria prompt para LLM
		const prompt = `Abaixo está uma conversa recente de um grupo de WhatsApp. ${customPersonalidade}. Por favor, resuma os principais pontos discutidos de forma concisa:
${formattedMessages}

Resumo:`;

		// Obtém resumo do LLM
		const summary = await llmService.getCompletion({ prompt, priority: 4 });

		if (!summary) {
			return new ReturnMessage({
				chatId: message.group,
				content: "Falha ao gerar resumo. Por favor, tente novamente."
			});
		}

		// Já que deu certo, limpa o historico
		await clearRecentMessages(message.group);

		logger.info(`[${group.id}]Resumo de conversa enviado com sucesso para ${message.group}`);

		// Envia o resumo
		return new ReturnMessage({
			chatId: message.group,
			content: `📋 *Resumo da conversa:*

${summary}`
		});
	} catch (error) {
		logger.error("Erro ao resumir conversa:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao gerar resumo. Por favor, tente novamente."
		});
	}
}

/**
 * Gera mensagem interativa baseada na conversa
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} - ReturnMessage com a interação gerada
 */
async function interactWithConversation(bot, message, args, group) {
	const retornarErro = args[0] ?? true;
	try {
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		logger.info(
			`[${group.id}][interactWithConversation] Gerando interação para o grupo ${message.group}`
		);

		let recentMessages;

		try {
			// Recorre a mensagens armazenadas
			recentMessages = await getRecentMessages(message.group);
		} catch (fetchError) {
			logger.error(
				`[${group.id}][interactWithConversation] Erro ao buscar mensagens do chat:`,
				fetchError
			);
			// Recorre a mensagens armazenadas
			recentMessages = [];
		}

		logger.info(
			`[${group.id}][interactWithConversation] Mensagens recentes: ${recentMessages.length}`
		);

		if (!recentMessages || recentMessages.length === 0) {
			if (retornarErro) {
				return new ReturnMessage({
					chatId: message.group,
					content: "Nenhuma mensagem recente para interagir."
				});
			} else {
				return [];
			}
		}

		// Formata mensagens para prompt
		const formattedMessages = formatMessagesForPrompt(recentMessages);

		const otherAIsPrompt = "";

		const customPersonalidade =
			group.customAIPrompt && group.customAIPrompt.length > 0
				? `\n\n((Sua personalidade: '${group.customAIPrompt}'))\n\n`
				: "";
		// Cria prompt para LLM
		const prompt = `Responda apenas em português do brasil. A seguir anexei uma conversa recente de um grupo de WhatsApp. Crie uma única mensagem curta para interagir com o grupo de forma natural, como se você entendesse o assunto e quisesse participar da conversa com algo relevante. Tente usar o mesmo tom e estilo informal que as pessoas estão usando. A mensagem deve ser curta e natural. ${customPersonalidade}${otherAIsPrompt}

${formattedMessages}`;

		logger.info(
			`[${group.id}][interactWithConversation] Enviando prompt: ${prompt.substring(0, 500)}`
		);

		// Obtém interação do LLM
		const interaction = await llmService.getCompletion({ prompt, priority: 5 });

		if (!interaction) {
			if (retornarErro) {
				return new ReturnMessage({
					chatId: message.group,
					content: "Falha ao gerar mensagem. Por favor, tente novamente."
				});
			} else {
				return [];
			}
		}

		// Verifica se teve mentions
		const llmMentions = interaction.match(/@(\d{8,})/g)?.map((m) => m.slice(1)) || [];

		// Envia a mensagem de interação
		if (interaction.includes("Não foi poss") && !retornarErro) {
			logger.info(
				`[${group.id}] Mensagem de interação ignorada pois ocorreu um erro na hora de gerar (${message.group}/'${interaction}')`
			);
			return [];
		} else {
			const resultado = new ReturnMessage({
				chatId: message.group,
				content: interaction,
				mentions: llmMentions
			});
			logger.info(`[${group.id}] Mensagem de interação gerada com sucesso para '${message.group}'`);

			// Já que deu certo, limpa o historico
			await clearRecentMessages(message.group);

			//logger.info(`[${group.id}] Limpas mensagens recentes de  '${message.group}'`);
			return resultado;
		}
	} catch (error) {
		logger.error(`[${group.id}] Erro ao gerar interação:`, error);
		if (retornarErro) {
			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "Erro ao gerar mensagem. Por favor, tente novamente."
			});
		} else {
			return [];
		}
	}
}

/**
 * Executa uma análise de dossiê do grupo usando IA
 * @param {string} chatId - Id do grupo
 * @param {string} pendingText - Texto pendente para análise
 * @param {object} bot - Instância do bot para enviar logs
 */
async function runGroupAnalysis(chatId, pendingText, bot) {
	if (activeAnalyses.has(chatId)) {
		logger.debug(`[${chatId}] Análise de dossiê já em andamento, pulando.`);
		return;
	}
	activeAnalyses.add(chatId);

	try {
		logger.info(`[${chatId}] Iniciando análise de dossiê (baixa prioridade)...`);

		// Busca dossiês anteriores para dar contexto (panorama geral)
		const previousDossiers = []; // desabilitado por enquanto
		// await database.dbAll(
		// 	DB_NAME,
		// 	"SELECT dossier_json FROM group_dossiers WHERE group_id = ? ORDER BY created_at DESC LIMIT 5",
		// 	[chatId]
		// );

		let historicalContext = "";
		if (previousDossiers && previousDossiers.length > 0) {
			historicalContext = "\n\nContexto Histórico (Resumos de análises anteriores):\n";
			previousDossiers.forEach((d, i) => {
				try {
					const p = JSON.parse(d.dossier_json);
					historicalContext += `- Análise ${i + 1}: [${p.type}] ${p.summary} (Nota: ${p.problematic_score}/10)\n`;
				} catch (e) {
					// Ignora
				}
			});
			historicalContext +=
				"\nConsidere este histórico para fornecer uma visão evolutiva ou consolidada do grupo no novo dossiê.";
		}

		const systemPrompt = `Você é um analista de grupos de segurança e moderação. 
Seu objetivo é categorizar grupos de WhatsApp de forma ultra-concisa, com o objetivo principal de detectar grupos que praticam coisas ilegais (racismo, pedofilia, aliciamento de menores, xenofobia, vendas ilegais, extremismo, gore, etc.)
Você DEVE responder APENAS com um objeto JSON válido seguindo estritamente o esquema solicitado. 
Não inclua explicações, introduções ou qualquer texto fora do JSON.`;

		const dossierSchema = {
			type: "json_schema",
			json_schema: {
				name: "group_dossier",
				schema: {
					type: "object",
					properties: {
						type: {
							type: "string",
							description:
								"Tipo de conteúdo do grupo (apenas 1 palavra, ex: 'jogos', 'onibus', 'romance', 'politica')"
						},
						summary: {
							type: "string",
							description: "Frase de até 250 caracteres que resume o que é discutido no grupo"
						},
						problematic_score: {
							type: "number",
							description:
								"Nota de 0 a 10 (10: ilegal, racismo, gore, extremismo; 6: pornografia, hentai em excesso; 4: encontros, rolês, fotos sensuais, aparência, flertes grupos de troca de nudes/conteúdo, baladas, sexualidade; 3: insultos, discussões, disputas, xingamentos; 3: anúncios, troca de seguidores,divulgações; troca de seguidores; 0: bots, uso de comandos (!), advertências, chat geral, jogos, tecnologia, amigos ou hobbies)"
						}
					},
					required: ["type", "summary", "problematic_score"],
					additionalProperties: false
				}
			}
		};

		const prompt = `Analise a conversa abaixo e preencha o dossiê:
- use apenas 1 palavra para 'type'.
- seja extremamente suscinto no 'summary' (máximo 200 caracteres).
- 'problematic_score' de 0 a 10.
- Uso de bots é permitido e jamais deve ser flagrado como algo ruim
- Anúncios, ofertas de troca de seguidores, divulgações de canais e conteúdo de NÃO são consinderados problemáticos
${historicalContext}

Conversa:
${pendingText}`;

		const response = await llmService.getCompletion({
			prompt,
			systemContext: systemPrompt,
			response_format: dossierSchema,
			priority: 10, // Baixa prioridade
			debugPrompt: false
		});

		if (response) {
			let parsed;
			try {
				// Tenta limpar possíveis backticks de Markdown que a IA as vezes coloca mesmo mandando não colocar
				const cleanResponse = response.replace(/```json|```/g, "").trim();
				parsed = JSON.parse(cleanResponse);
			} catch (e) {
				logger.warn(`[${chatId}] Resposta da IA não é um JSON válido:`, response);
				return;
			}

			// Só limpa se o JSON tiver os campos obrigatórios
			if (parsed.type && parsed.summary && typeof parsed.problematic_score === "number") {
				// Para evitar deletar mensagens que chegaram ENQUANTO a IA analisava,
				// vamos apenas remover o trecho que foi enviado para a análise.

				// Buscamos o estado atual
				const currentStatus = await database.dbGet(
					DB_NAME,
					"SELECT pending_text FROM group_dossier_status WHERE group_id = ?",
					[chatId]
				);

				let newPendingText = "";
				if (currentStatus && currentStatus.pending_text) {
					// Removemos do início do texto atual o que enviamos para a IA
					newPendingText = currentStatus.pending_text.replace(pendingText, "");
				}

				// 1. INSere o novo dossiê no histórico (guarda histórico da conversa se a nota for > 7)
				await database.dbRun(
					DB_NAME,
					`INSERT INTO group_dossiers (group_id, dossier_json, conversation_history, analyzed_at_length) VALUES (?, ?, ?, ?)`,
					[chatId, JSON.stringify(parsed), parsed.problematic_score > 7 ? pendingText : null, 0]
				);

				// 2. Limpa o texto analisado da tabela de status
				await database.dbRun(
					DB_NAME,
					"UPDATE group_dossier_status SET pending_text = ? WHERE group_id = ?",
					[newPendingText, chatId]
				);

				// 3. Mantém apenas os últimos 15 dossiês deste grupo
				await database.dbRun(
					DB_NAME,
					`DELETE FROM group_dossiers WHERE id IN (
						SELECT id FROM group_dossiers 
						WHERE group_id = ? 
						ORDER BY created_at DESC 
						LIMIT -1 OFFSET 15
					)`,
					[chatId]
				);

				logger.info(
					`[${chatId}] Novo dossiê inserido. Histórico limitado a 15. ${newPendingText.length} chars remanescentes.`
				);

				// Alerta SuperAdmin se a nota for alta (> 7) e tiver bot disponível
				if (bot && parsed.problematic_score > 7 && (bot.grupoLogs || process.env.GRUPO_LOGS)) {
					const targetGroup = bot.grupoLogs || process.env.GRUPO_LOGS;
					const groupData = await bot.database.getGroup(chatId);
					const msgAlert = `⚠️ *ALERTA DE GRUPO POSSIVELMENTE PROBLEMÁTICO* ⚠️
					
📌 *Grupo:* ${groupData ? groupData.name : "N/A"}
🆔 *ID:* ${chatId}
🤖 *Bot:* ${bot.id}

📊 *Análise:*
- *Tipo:* ${parsed.type}
- *Nota:* ${parsed.problematic_score}/10
- *Resumo:* ${parsed.summary}`;

					bot
						.sendMessage(targetGroup, msgAlert)
						.catch((e) => logger.error("Erro ao enviar alerta de dossiê:", e));

					if (parsed.problematic_score > 7) {
						bot
							.sendMessage(
								targetGroup,
								`📝 *Histórico da Conversa que gerou o dossiê:*\n\n${pendingText}`
							)
							.catch((e) => logger.error("Erro ao enviar histórico de msgs do dossiê:", e));
					}
				}
			} else {
				logger.warn(`[${chatId}] JSON da IA incompleto:`, parsed);
			}
		}
	} catch (error) {
		logger.error(`[${chatId}] Erro ao processar análise de dossiê:`, error);
	} finally {
		activeAnalyses.delete(chatId);
	}
}

/**
 * Armazena uma mensagem no histórico de conversas do grupo
 * @param {Object} message - Os dados da mensagem
 * @param {string} chatId - Id do grupo
 * @param {object} bot - Opcional, para disparar análise se necessário
 */
async function storeMessage(message, chatId, bot) {
	try {
		// Adiciona nova mensagem
		let textContent = message.type === "text" ? message.content : message.caption;

		// Mensagens de áudio são interpretadas também, usando transcrição do whisper, mas ficam no EventHandler - pra poder usar msg de voz no pv também!

		let llmUp = false;
		try {
			const servicesData = await Status.getServicesStatus();
			if (servicesData.llm === "up") {
				llmUp = true;
			}
		} catch (e) {
			// Ignore error, assume down
		}

		if (message.type === "image" && llmUp) {
			// Tenta interpretar a imagem usando Vision AI, menos se for pedido de sticker pra aliviar  a GPU
			if (
				message.content &&
				!message.caption?.startsWith("!s") &&
				!message.caption?.startsWith("!ia")
			) {
				let imageData = message.content.data;

				// Se não tiver dados (lazy loading), tenta baixar
				if (!imageData && typeof message.downloadMedia === "function") {
					try {
						const media = await message.downloadMedia();
						imageData = media?.data;
					} catch (dlErr) {
						logger.error("Erro ao baixar imagem para Vision AI:", dlErr);
					}
				}

				if (imageData) {
					const completionOptions = {
						prompt:
							"Analyze the picture and return a brief description ((in pt-BR, portuguese brazil)) ((try to stay below 200 characters)). Also classify the type (real life, anime, game, etc) and if it contains NSFW content.",
						systemContext: `You are an expert bot in image processing and analysis`,
						image: imageData,
						response_format: mediaAnalysisSchema,
						maxTokens: 150,
						debugPrompt: false,
						priority: 1
					};

					//logger.info(`[storeMessage] Prompt: `, completionOptions);
					const response = await llmService.getCompletion(completionOptions);

					if (
						response &&
						!response.includes("Não foi poss") &&
						!response.includes("Ocorreu um erro")
					) {
						try {
							const parsed = JSON.parse(response);
							const nsfwTag = parsed.nsfw ? "nsfw" : "sfw";
							const finalString = `Imagem[${parsed.type}|${nsfwTag}|${parsed.description}]`;
							textContent = message.caption
								? `${finalString}\nLegenda: ${message.caption}`
								: finalString;
							logger.info(`[${chatId}][storeMessage] Imagem interpretada: ${textContent}`);
						} catch (e) {
							logger.warn("Falha ao analisar JSON da imagem, retornando cru:", response);
							// Fallback if not JSON
							textContent = message.caption ? `${response}\nLegenda: ${message.caption}` : response;
						}
					}
				}
			}
		} else if (message.type === "video" && llmUp) {
			// Tenta interpretar o video usando Vision AI
			if (message.content && !message.caption?.startsWith("!s")) {
				const response = await analyzeVideo(message);

				if (
					response &&
					!response.includes("Não foi poss") &&
					!response.includes("Ocorreu um erro")
				) {
					textContent = message.caption ? `${response}\nLegenda: ${message.caption}` : response;
					logger.info(`[${chatId}][storeMessage] Vídeo interpretado: ${textContent}`);
				}
			}
		}

		if (textContent) {
			// Zap/libs mudam tanto que pode vir de qualquer lugar, é foda, haja fallbacks
			const fromMe =
				message.goMessageData?.key?.fromMe ??
				message.key?.fromMe ??
				message.fromMe ??
				message.origin?.fromMe ??
				false;
			const authorName = fromMe
				? "Você (bot)"
				: (message.goMessageData?.pushName ??
					message.origin?.pushName ??
					message.name ??
					message.authorName ??
					message.pushname ??
					"Desconhecido");

			// 1. Salva na nova tabela chat_conversations
			const timestamp = Date.now();
			await database.dbRun(
				DB_NAME,
				"INSERT INTO chat_conversations (group_id, author, text, timestamp) VALUES (?, ?, ?, ?)",
				[chatId, authorName, textContent, timestamp]
			);

			// 2. Limita a 200 mensagens para evitar bloat
			await database.dbRun(
				DB_NAME,
				`DELETE FROM chat_conversations WHERE rowid IN (
                    SELECT rowid FROM chat_conversations 
                    WHERE group_id = ? 
                    ORDER BY timestamp DESC 
                    LIMIT -1 OFFSET 200
                )`,
				[chatId]
			);

			// 3. Atualiza Dossiê (Contagem de caracteres e texto pendente na tabela STATUS)
			const msgString = `${authorName}: ${textContent}\n`;

			// Upsert dossier status
			await database.dbRun(
				DB_NAME,
				`INSERT INTO group_dossier_status (group_id, total_length_recorded, pending_text) 
                 VALUES (?, ?, ?)
                 ON CONFLICT(group_id) DO UPDATE SET 
                    total_length_recorded = total_length_recorded + LENGTH(?),
                    pending_text = pending_text || ?`,
				[chatId, msgString.length, msgString, msgString, msgString]
			);

			// Busca o status para decidir se dispara análise
			const dossierStatus = await database.dbGet(
				DB_NAME,
				"SELECT pending_text FROM group_dossier_status WHERE group_id = ?",
				[chatId]
			);

			if (dossierStatus && dossierStatus.pending_text.length >= 10000) {
				// Dispara análise sem dar await para não travar a resposta
				runGroupAnalysis(chatId, dossierStatus.pending_text, bot);
			}

			// Legado: Salva na tabela antiga como redundância por enquanto ou se necessário
			// Mas o ideal é remover assim que tudo estiver estável.
			// Por enquanto vamos manter para não quebrar nada se alguém depender de 'json_data'
			// Mas vamos usar o getRecentMessages atualizado para as funções deste arquivo.
		}
	} catch (error) {
		logger.error("Erro ao armazenar mensagem:", error);
	}
}

/**
 * Obtém mensagens recentes para um grupo
 * @param {string} chatId - O ID do grupo
 * @returns {Promise<Array>} - Array de objetos de mensagem
 */
async function getRecentMessages(chatId) {
	try {
		const rows = await database.dbAll(
			DB_NAME,
			"SELECT author, text, timestamp FROM chat_conversations WHERE group_id = ? ORDER BY timestamp ASC",
			[chatId]
		);
		return rows.map((r) => ({
			author: r.author,
			text: r.text,
			timestamp: r.timestamp
		}));
	} catch (error) {
		logger.error("Erro ao obter mensagens recentes:", error);
		return [];
	}
}

/**
 * Limpar as mensagens recentes para um grupo
 * @param {string} chatId - O ID do grupo
 * @returns {Promise<Bool>} - Se deu certo ou não
 */
async function clearRecentMessages(chatId) {
	try {
		await database.dbRun(DB_NAME, "DELETE FROM chat_conversations WHERE group_id = ?", [chatId]);
		return true;
	} catch (error) {
		logger.error("Erro ao limpar mensagens recentes:", error);
		return false;
	}
}

/**
 * Formata mensagens para prompt do LLM
 * @param {Array} messages - Array de objetos de mensagem
 * @returns {string} - String de mensagens formatada
 */
function formatMessagesForPrompt(messages) {
	return messages.map((msg) => `${msg.author}: ${msg.text}`).join("\n");
}

// Lista de comandos usando a classe Command
const commands = [
	new Command({
		name: "resumo",
		description: "Resume conversas recentes do grupo",
		category: "ia",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📋"
		},
		cooldown: 300,
		method: summarizeConversation
	}),

	new Command({
		name: "interagir",
		description: "Gera uma mensagem interativa baseada na conversa",
		category: "ia",
		reactions: {
			trigger: "🦜",
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "💬"
		},
		cooldown: 150,
		method: interactWithConversation
	})
];

// Exporta as funções de histórico de conversa para serem usadas no EventHandler e outros
module.exports.storeMessage = storeMessage;
module.exports.getRecentMessages = getRecentMessages;
module.exports.clearRecentMessages = clearRecentMessages;
module.exports.runGroupAnalysis = runGroupAnalysis;
module.exports.formatMessagesForPrompt = formatMessagesForPrompt;

// Exporta comandos
module.exports.commands = commands;
