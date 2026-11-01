const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const Logger = require("../utils/Logger");
const LLMService = require("./LLMService");
const SummaryCommands = require("../functions/SummaryCommands");
const SpeechCommands = require("../functions/SpeechCommands");
const PhoneUtils = require("../utils/PhoneUtils");

/**
 * Serviço responsável por gerenciar o ciclo de vida da análise de reports de erros (SuperAdmin).
 * Coleta mensagens encaminhadas no PV (texto, áudio, imagem e vídeo), executa OCR, Whisper e
 * análise de vídeo com áudio, montando o prompt estruturado e solicitando a interpretação da IA local.
 */
class ReportAnalyzerService {
	static getInstance() {
		if (!ReportAnalyzerService.instance) {
			ReportAnalyzerService.instance = new ReportAnalyzerService();
		}
		return ReportAnalyzerService.instance;
	}

	constructor() {
		this.logger = new Logger("report-analyzer-service");
		this.sessions = new Map(); // key: `${botId}:${normalizedAuthor}`, value: session
		this.tempDir = path.join(__dirname, "../../temp");
		this.SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos de inatividade
	}

	/**
	 * Normaliza identificador de autor para telefone puro
	 * @param {string} author
	 * @returns {string}
	 */
	normalizeAuthor(author) {
		if (!author) return "";
		return String(author).split("@")[0].split(":")[0].replace(/\D/g, "");
	}

	/**
	 * Extrai o número do usuário reportante dos argumentos do comando (apenas dígitos).
	 * Aceita formatos como "555596810000", "+55 55 9681-0000" ou "@555596810000".
	 * @param {Array<string>|string|null} args
	 * @returns {string|null} Número só com dígitos (mín. 8) ou null se não informado/inválido
	 */
	parseTargetUser(args) {
		if (!args) return null;
		const list = Array.isArray(args) ? args : [args];
		const digits = list
			.filter((a) => a && !/^(cancelar|cancel)$/i.test(String(a).trim()))
			.map((a) => String(a).replace(/\D/g, ""))
			.join("");
		return digits.length >= 8 ? digits : null;
	}

	/**
	 * Constrói a chave única da sessão
	 * @param {string} botId
	 * @param {string} author
	 * @returns {string}
	 */
	getSessionKey(botId, author) {
		const normAuthor = this.normalizeAuthor(author);
		const normBot = String(botId || "default");
		return `${normBot}:${normAuthor}`;
	}

	/**
	 * Obtém a sessão ativa correspondente (suporta checagem por author, authorAlt, from e PhoneUtils)
	 * @param {string} botId
	 * @param {Object|string} messageOrAuthor
	 * @returns {Object|null}
	 */
	getSession(botId, messageOrAuthor) {
		const normBot = String(botId || "default");
		if (!messageOrAuthor) return null;

		const candidates = [];
		if (typeof messageOrAuthor === "object") {
			if (messageOrAuthor.author) candidates.push(messageOrAuthor.author);
			if (messageOrAuthor.authorAlt) candidates.push(messageOrAuthor.authorAlt);
			if (messageOrAuthor.from) candidates.push(messageOrAuthor.from);
			if (messageOrAuthor.origin?.author) candidates.push(messageOrAuthor.origin.author);
			if (messageOrAuthor.origin?.from) candidates.push(messageOrAuthor.origin.from);
		} else {
			candidates.push(messageOrAuthor);
		}

		for (const session of this.sessions.values()) {
			if (String(session.botId || "default") !== normBot) continue;

			// Verifica expiração por timeout
			if (Date.now() - session.lastActivityAt > this.SESSION_TIMEOUT_MS) {
				this.sessions.delete(session.key);
				continue;
			}

			for (const cand of candidates) {
				const candClean = this.normalizeAuthor(cand);
				const sessionClean = this.normalizeAuthor(session.author);
				if (!candClean) continue;

				if (
					candClean === sessionClean ||
					(sessionClean && PhoneUtils.isSamePhone(candClean, sessionClean)) ||
					(session.authorAlt && candClean === this.normalizeAuthor(session.authorAlt)) ||
					(session.from && candClean === this.normalizeAuthor(session.from))
				) {
					return session;
				}
			}
		}

		return null;
	}

	/**
	 * Verifica se há uma sessão ativa para o admin no bot
	 * @param {string} botId
	 * @param {Object|string} messageOrAuthor
	 * @returns {boolean}
	 */
	hasActiveSession(botId, messageOrAuthor) {
		return !!this.getSession(botId, messageOrAuthor);
	}

	/**
	 * Inicia uma nova sessão de análise de report
	 * @param {string} botId
	 * @param {Object|string} messageOrAuthor
	 * @param {string|null} [targetUser=null]
	 * @returns {Object}
	 */
	startSession(botId, messageOrAuthor, targetUser = null) {
		const author = typeof messageOrAuthor === "object" ? messageOrAuthor.author : messageOrAuthor;
		const authorAlt = typeof messageOrAuthor === "object" ? messageOrAuthor.authorAlt : null;
		const from = typeof messageOrAuthor === "object" ? messageOrAuthor.from : null;

		const key = this.getSessionKey(botId, author);
		const cleanTarget = this.parseTargetUser(targetUser);

		const session = {
			key,
			botId,
			author,
			authorAlt,
			from,
			targetUser: cleanTarget || null,
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			messages: []
		};

		this.sessions.set(key, session);
		this.logger.info(
			`[ReportAnalyzerService] Sessão iniciada para ${key} (Usuário alvo: ${cleanTarget || "não informado"})`
		);
		return session;
	}

	/**
	 * Cancela e descarta a sessão ativa
	 * @param {string} botId
	 * @param {Object|string} messageOrAuthor
	 * @returns {boolean}
	 */
	cancelSession(botId, messageOrAuthor) {
		const session = this.getSession(botId, messageOrAuthor);
		if (session) {
			this.sessions.delete(session.key);
			this.logger.info(`[ReportAnalyzerService] Sessão cancelada para ${session.key}`);
			return true;
		}
		return false;
	}

	/**
	 * Registra uma mensagem recebida na sessão ativa
	 * @param {Object} bot
	 * @param {Object} message
	 * @returns {Promise<boolean>}
	 */
	async recordMessage(bot, message) {
		const session = this.getSession(bot.id, message);
		if (!session) return false;

		session.lastActivityAt = Date.now();

		const timestamp =
			message.timestamp || (message.origin && message.origin.messageTimestamp) || Date.now();
		const text =
			message.type === "text"
				? message.content || ""
				: message.caption || (typeof message.content === "string" ? message.content : "");

		let mediaData = null;
		let mimetype = null;

		const isMedia =
			message.hasMedia ||
			["image", "video", "audio", "voice", "document", "sticker"].includes(message.type);

		if (isMedia) {
			try {
				if (typeof message.downloadMedia === "function") {
					const downloaded = await message.downloadMedia();
					if (downloaded) {
						mediaData = downloaded.data || downloaded.base64;
						mimetype = downloaded.mimetype;
					}
				} else if (message.content && (message.content.data || message.content.base64)) {
					mediaData = message.content.data || message.content.base64;
					mimetype = message.content.mimetype;
				}
			} catch (e) {
				this.logger.warn(`[recordMessage] Falha ao baixar mídia: ${e.message}`);
			}
		}

		session.messages.push({
			id: message.id || message.origin?.id?._serialized,
			type: message.type || "text",
			timestamp,
			text: text ? String(text).trim() : "",
			mediaData,
			mimetype,
			author: message.author
		});

		this.logger.debug(
			`[recordMessage] Mensagem gravada para ${session.key}. Total de mensagens na sessão: ${session.messages.length}`
		);

		// Reage com emoji de confirmação visual
		if (message.origin && typeof message.origin.react === "function") {
			try {
				message.origin.react("📥").catch(() => {});
			} catch (reactErr) {
				// Ignora erro de reação
			}
		}

		return true;
	}

	/**
	 * Identifica se a mensagem de texto corresponde ao comando de análise de report
	 * @param {string} textContent
	 * @param {string} [prefix="!"]
	 * @returns {boolean}
	 */
	isReportCommand(textContent, prefix = "!") {
		if (!textContent || typeof textContent !== "string") return false;
		const clean = textContent.trim().toLowerCase();
		const cleanPrefix = (prefix || "").toLowerCase();

		return (
			clean.startsWith("!sa-analisareport") ||
			clean.startsWith("/sa-analisareport") ||
			clean.startsWith("!sa-analisa-report") ||
			(cleanPrefix && clean.startsWith(`${cleanPrefix}sa-analisareport`)) ||
			clean === "!analisareport" ||
			clean === "analisareport"
		);
	}

	/**
	 * Formata um timestamp para [DD/MM/YYYY HH:mm] no fuso America/Sao_Paulo
	 * @param {number|string} timestamp
	 * @returns {string}
	 */
	formatTimestamp(timestamp) {
		if (!timestamp) timestamp = Date.now();
		const ms = Number(timestamp) < 1e11 ? Number(timestamp) * 1000 : Number(timestamp);
		const date = new Date(ms);
		const options = {
			timeZone: "America/Sao_Paulo",
			day: "2-digit",
			month: "2-digit",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false
		};
		const parts = new Intl.DateTimeFormat("pt-BR", options).formatToParts(date);
		const day = parts.find((p) => p.type === "day")?.value || "01";
		const month = parts.find((p) => p.type === "month")?.value || "11";
		const year = parts.find((p) => p.type === "year")?.value || "2026";
		const hour = parts.find((p) => p.type === "hour")?.value || "00";
		const minute = parts.find((p) => p.type === "minute")?.value || "00";
		return `[${day}/${month}/${year} ${hour}:${minute}]`;
	}

	/**
	 * Extrai OCR de imagem via LLM Vision
	 * @param {string} base64Data
	 * @returns {Promise<string>}
	 */
	async extractOcr(base64Data) {
		if (!base64Data) return "";
		try {
			const llmService = LLMService.getInstance();
			const response = await llmService.getCompletion({
				prompt:
					"Extraia TODO o texto presente nesta imagem. Retorne apenas o texto extraído, preservando a quebra de linhas, sem qualquer comentário, explicação ou introdução adicional.",
				image: base64Data,
				systemContext:
					"Você é um assistente especializado em OCR (Extração de Texto). Sua única tarefa é ler e transcrever o texto da imagem fornecida com precisão total.",
				priority: 5,
				timeout: 60000
			});

			if (!response || typeof response !== "string" || response.startsWith("Erro:")) {
				return "";
			}
			return response.trim();
		} catch (err) {
			this.logger.warn(`[extractOcr] Erro ao extrair OCR: ${err.message}`);
			return "";
		}
	}

	/**
	 * Transcreve áudio via Whisper API
	 * @param {string} base64Data
	 * @returns {Promise<string>}
	 */
	async transcribeAudio(base64Data) {
		if (!base64Data) return "";
		await fs.mkdir(this.tempDir, { recursive: true });
		const tempAudio = path.join(this.tempDir, `report_aud_${crypto.randomUUID()}.ogg`);

		try {
			await fs.writeFile(tempAudio, Buffer.from(base64Data, "base64"));
			const result = await SpeechCommands.transcribeViaAPI(tempAudio);
			return result?.text?.trim() || "";
		} catch (err) {
			this.logger.warn(`[transcribeAudio] Erro ao transcrever áudio: ${err.message}`);
			return "";
		} finally {
			await fs.unlink(tempAudio).catch(() => {});
		}
	}

	/**
	 * Extrai a faixa de áudio de um vídeo e a transcreve via Whisper
	 * @param {string} base64Data
	 * @returns {Promise<string>}
	 */
	async extractAudioFromVideo(base64Data) {
		if (!base64Data) return "";
		await fs.mkdir(this.tempDir, { recursive: true });
		const tempVideo = path.join(this.tempDir, `report_vid_${crypto.randomUUID()}.mp4`);
		const tempAudio = path.join(this.tempDir, `report_vid_aud_${crypto.randomUUID()}.ogg`);

		try {
			await fs.writeFile(tempVideo, Buffer.from(base64Data, "base64"));

			// Extrai a faixa de áudio via ffmpeg
			await new Promise((resolve, reject) => {
				ffmpeg(tempVideo)
					.noVideo()
					.audioCodec("libopus")
					.format("ogg")
					.on("end", resolve)
					.on("error", reject)
					.save(tempAudio);
			});

			const result = await SpeechCommands.transcribeViaAPI(tempAudio);
			return result?.text?.trim() || "";
		} catch (err) {
			// Vídeo pode não ter faixa de áudio ou Whisper falhou
			this.logger.debug(
				`[extractAudioFromVideo] Vídeo sem áudio legível ou falha na transcrição: ${err.message}`
			);
			return "";
		} finally {
			await fs.unlink(tempVideo).catch(() => {});
			await fs.unlink(tempAudio).catch(() => {});
		}
	}

	/**
	 * Carrega o contexto do arquivo LLM-HELPER.md
	 * @returns {Promise<{full: string, summary: string}>}
	 */
	async loadBotContext() {
		try {
			const docPath = path.join(process.cwd(), "docs", "LLM-HELPER.md");
			const content = await fs.readFile(docPath, "utf8");

			// Extrai introdução e arquitetura (antes da lista exaustiva de comandos)
			const refIndex = content.indexOf("# 📚 Referência de Comandos e Módulos");
			const introSection =
				refIndex !== -1 ? content.slice(0, refIndex).trim() : content.slice(0, 3000).trim();

			// Extrai módulos principais
			const moduleMatches = [
				...content.matchAll(/### 📁 Módulo: `([^`]+)`\s+\*\*Sobre:\*\* ([^\n]+)/g)
			];
			let modulesSummary = "";
			if (moduleMatches.length > 0) {
				modulesSummary =
					"\n\nPrincipais Módulos do Sistema:\n" +
					moduleMatches.map((m) => `• ${m[1]}: ${m[2]}`).join("\n");
			}

			return {
				full: content,
				summary: `${introSection}${modulesSummary}`
			};
		} catch (e) {
			this.logger.warn(`[loadBotContext] Não foi possível carregar LLM-HELPER.md: ${e.message}`);
			return {
				full: "",
				summary:
					"Ravena: Bot de WhatsApp multi-instância em Node.js com SQLite, Whisper, LLMs e microsserviços."
			};
		}
	}

	/**
	 * Finaliza a sessão, processa todas as mensagens cronologicamente, monta o prompt e consulta a IA local
	 * @param {Object} bot
	 * @param {string} botId
	 * @param {Object|string} messageOrAuthor
	 * @param {string|null} [optionalTargetUser=null]
	 * @returns {Promise<{promptMessage: string, aiMessage: string}>}
	 */
	async finalizeSession(bot, botId, messageOrAuthor, optionalTargetUser = null) {
		const session = this.getSession(botId, messageOrAuthor);

		if (!session) {
			throw new Error("Nenhuma sessão ativa encontrada para este usuário.");
		}

		// O número informado no primeiro comando tem prioridade; só usa o do segundo se não houver
		if (!session.targetUser) {
			session.targetUser = this.parseTargetUser(optionalTargetUser);
		}

		// Ordena mensagens cronologicamente
		const sortedMessages = [...session.messages].sort((a, b) => a.timestamp - b.timestamp);

		const lines = [];

		for (const msg of sortedMessages) {
			const timeStr = this.formatTimestamp(msg.timestamp);
			const isImage = msg.type === "image" || msg.mimetype?.startsWith("image/");
			const isAudio =
				msg.type === "audio" || msg.type === "voice" || msg.mimetype?.startsWith("audio/");
			const isVideo = msg.type === "video" || msg.mimetype?.startsWith("video/");

			if (isImage) {
				const ocrText = await this.extractOcr(msg.mediaData);
				if (ocrText && ocrText.trim().length > 0) {
					const cleanOcr = ocrText.replace(/\n+/g, " ").trim();
					lines.push(
						`${timeStr} [imagem] Imagem mostra frase "${cleanOcr}";${msg.text ? " legenda: " + msg.text : ""}`
					);
				} else {
					lines.push(
						`${timeStr} [imagem] (Sem texto visível na imagem)${msg.text ? "; legenda: " + msg.text : ""}`
					);
				}
			} else if (isAudio) {
				const audioTranscription = await this.transcribeAudio(msg.mediaData);
				if (audioTranscription && audioTranscription.trim().length > 0) {
					lines.push(`${timeStr} [audio] ${audioTranscription.trim()}`);
				} else {
					lines.push(`${timeStr} [audio] (áudio inaudível ou sem fala detectada)`);
				}
			} else if (isVideo) {
				// 1. Análise visual de vídeo existente no SummaryCommands
				let videoDesc = "";
				try {
					const fakeMsg = {
						downloadMedia: async () => ({
							data: msg.mediaData,
							mimetype: msg.mimetype || "video/mp4"
						})
					};
					const videoRaw = await SummaryCommands.analyzeVideo(fakeMsg, bot);
					if (videoRaw && typeof videoRaw === "string") {
						const match = videoRaw.match(/^Video\[[^|]*\|[^|]*\|(.*)\]$/);
						videoDesc = match ? match[1].trim() : videoRaw.trim();
					}
				} catch (vidErr) {
					this.logger.warn(`[finalizeSession] Erro na análise visual de vídeo: ${vidErr.message}`);
				}

				// 2. Extração de áudio do vídeo + Whisper
				const videoAudio = await this.extractAudioFromVideo(msg.mediaData);

				const parts = [];
				if (videoDesc) parts.push(videoDesc);
				if (videoAudio) parts.push(`[áudio]: ${videoAudio}`);
				if (msg.text) parts.push(`legenda: ${msg.text}`);

				const finalVideoContent =
					parts.length > 0 ? parts.join("; ") : "(vídeo sem descrição ou áudio legível)";
				lines.push(`${timeStr} [video] ${finalVideoContent}`);
			} else {
				// Texto ou documento
				const textContent = msg.text || (msg.type ? `[${msg.type}]` : "");
				lines.push(`${timeStr} ${textContent}`);
			}
		}

		// Carrega contexto técnico do bot a partir do LLM-HELPER.md (apenas para o systemContext da IA local)
		const botContext = await this.loadBotContext();

		// Monta o prompt inicial contendo estritamente o cabeçalho e o histórico cronológico de mensagens
		// Sem número informado no comando, o prompt fica sem o número
		const userIdentifier = session.targetUser ? `Usuario ${session.targetUser}` : "Usuario";
		const promptHeader = `${userIdentifier} reporta um problema. Analise o conteúdo enviado e descreva o problema que será enviado ao agent de correção de erros do código, de foma que fique organizada e facil para o agent entender o que acontece, com horários, etc.`;

		const promptMessage = `${promptHeader}\n${lines.join("\n")}`;

		// Prepara o systemContext para a IA local: sem emojis decorativos, Markdown limpo e técnico
		const systemContext = `Você é um assistente técnico especialista em triagem de bugs e arquitetura do bot Ravena.
Sua função é analisar o relato de erro enviado pelo usuário e as mensagens encaminhadas (incluindo OCR de prints, transcrições de áudios e análises de vídeos) e produzir uma descrição técnica limpa, direta e bem estruturada para o desenvolvedor ou agente de correção do código.

DIRETRIZES DE FORMATAÇÃO:
- Use Markdown limpo e técnico.
- NÃO use emojis decorativos ou de enfeite (como 📌, ⏱️, 🔍, 🧩, 💡).
- Use apenas emojis funcionais se forem comandos nativos do bot ou estritamente necessários.
- Seja objetivo e vá direto ao ponto técnico.

Estruture sua análise nas seguintes seções:
## Resumo do Problema
## Linha do Tempo e Passos de Reprodução
## Evidências Coletadas (Textos, OCR, Áudios, Vídeos)
## Módulos e Componentes Envolvidos
## Causa Provável e Sugestões Técnicas

---
CONTEXTO DO SISTEMA (LLM-HELPER):
${botContext.full ? botContext.full.slice(0, 24000) : botContext.summary}`;

		// Chama a IA local via LLMService (usando ServiceProviders)
		let aiMessage = "";
		try {
			const llmService = LLMService.getInstance();
			const response = await llmService.getCompletion({
				prompt: promptMessage,
				systemContext,
				priority: 5,
				timeout: 90000
			});

			if (response && typeof response === "string" && !response.startsWith("Erro:")) {
				aiMessage = `*Interpretação da IA Local:*\n\n${response.trim()}`;
			} else {
				aiMessage = `*Interpretação da IA Local indisponível no momento:*\n${response || "Resposta vazia"}\n\nVocê pode usar o prompt da mensagem anterior diretamente em uma IA mais avançada.`;
			}
		} catch (err) {
			this.logger.error("[finalizeSession] Erro na chamada da IA local:", err);
			aiMessage = `*Interpretação da IA Local indisponível:*\n${err.message}\n\nVocê pode usar o prompt da mensagem anterior diretamente em uma IA mais avançada.`;
		}

		// Remove sessão da memória
		this.sessions.delete(session.key);
		this.logger.info(`[finalizeSession] Sessão ${session.key} finalizada com sucesso.`);

		return {
			promptMessage,
			aiMessage
		};
	}
}

module.exports = ReportAnalyzerService;
